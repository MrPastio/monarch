import { mkdtemp, readFile, realpath, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MonarchKernel } from '../../src/core/kernel';
import { WorkspaceModule } from '../../src/modules/workspace';
import { createAstraProductPilotRuntime, ASTRA_PRODUCT_PILOT_MODE } from '../../src/app/astra-product-pilot';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';

describe('Native create respects the current Kernel autonomy profile', () => {
  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('uses %s with real exclusive create and exact readback', async sandboxMode => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-create-autonomy-')));
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
      permissionProfile: { sandboxMode, approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] }));
    kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'state'), kernel, desktopAttestationToken: 'x'.repeat(64), hostToken: 'y'.repeat(64),
      journalEncryptionKey: Buffer.alloc(32, 0x4e) })!;
    try {
      await pilot.facade.start();
      const selected = pilot.issuePickedTarget(pilot.actor, { version: 1, conversationId: 'chat', requestId: 'pick',
        access: 'exclusive-create', selectedPath: path.join(root, 'proof.txt') });
      const request = { version: 1, clientRequestId: 'create', conversationId: 'chat', inputMessageId: 'message',
        text: 'Создай файл proof.txt с текстом Точные байты.', privacyMode: 'persistent' as const,
        selectionId: selected.selectionId, goal: { kind: 'create' as const, target: selected.targets[0]!.targetId,
          content: { kind: 'literal' as const, text: '  Точные байты\r\n' } } };
      let task = pilot.facade.submit(pilot.actor, request, 'create');
      await pilot.facade.drain(); task = pilot.facade.read(pilot.actor, task.id, request, 'create');
      if (sandboxMode === 'read-only') {
        expect(task.approval).toBeDefined(); await expect(access(path.join(root, 'proof.txt'))).rejects.toThrow();
        const card = task.approval!;
        expect(() => pilot.facade.decide(pilot.actor, task.id, request, { approvalId: card.id, approvalDigest: 'sha256:'+'0'.repeat(64),
          messageId: 'approval', decision: 'approve' })).toThrow();
        pilot.facade.decide(pilot.actor, task.id, request, { approvalId: card.id, approvalDigest: card.digest,
          messageId: 'approval', decision: 'approve' });
        await pilot.facade.drain(); task = pilot.facade.read(pilot.actor, task.id, request, 'create');
      } else expect(task.approval).toBeUndefined();
      expect(task.status).toBe('completed');
      expect(await readFile(path.join(root, 'proof.txt'), 'utf8')).toBe('  Точные байты\r\n');
      expect(pilot.facade.submit(pilot.actor, request, 'create').id).toBe(task.id);
    } finally { await pilot.stop(); await kernel.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
