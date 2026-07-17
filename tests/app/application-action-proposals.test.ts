import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MonarchApplication typed action proposals', () => {
  it('binds confirmation to the exact canonical proposal', async () => {
    const { app } = await createApp();
    try {
      const prepared = await app.submitActionProposal({
        proposal: proposal('intent-exact', 'notes/exact.txt', 'exact'),
        originatingUserText: 'Создай точный файл',
        requestedBy: 'ui:oscar:model-proposal',
      });
      expect(prepared.result.error).toBe('confirmation-required');
      await expect(app.submitActionProposal({
        proposal: { ...prepared.proposal, args: { path: 'notes/tampered.txt', content: 'tampered', overwrite: false } },
        originatingUserText: 'Создай точный файл',
        requestedBy: 'ui:oscar:model-proposal',
        confirmed: true,
        confirmationToken: prepared.confirmation!.token,
      })).rejects.toMatchObject({ code: 'confirmation-target-mismatch' });
    } finally {
      await app.stop().catch(() => undefined);
    }
  }, 60_000);

  it('uses one task grant for later reversible steps with the same host task intent', async () => {
    const { app, root } = await createApp();
    const userText = 'Создай два файла одной задачей';
    try {
      const firstProposal = proposal('intent-plan', 'notes/a.txt', 'a');
      const prepared = await app.submitActionProposal({
        proposal: firstProposal,
        originatingUserText: userText,
        requestedBy: 'ui:oscar:model-proposal',
      });
      expect(prepared.confirmation?.grantOptions).toEqual(['once', 'task']);

      const granted = await app.submitActionProposal({
        proposal: prepared.proposal,
        originatingUserText: userText,
        requestedBy: 'ui:oscar:model-proposal',
        confirmed: true,
        confirmationToken: prepared.confirmation!.token,
        grantScope: 'task',
      });
      expect(granted.result.ok).toBe(true);
      expect(granted.lease?.status).toBe('active');

      const second = await app.submitActionProposal({
        proposal: proposal('intent-plan', 'notes/b.txt', 'b'),
        originatingUserText: userText,
        requestedBy: 'ui:oscar:model-proposal',
        leaseId: granted.lease!.leaseId,
      });
      expect(second.result.ok).toBe(true);
      expect(second.result.metadata?.leaseId).toBe(granted.lease!.leaseId);
      await expect(readFile(path.join(root, 'notes', 'a.txt'), 'utf8')).resolves.toBe('a');
      await expect(readFile(path.join(root, 'notes', 'b.txt'), 'utf8')).resolves.toBe('b');
    } finally {
      await app.stop().catch(() => undefined);
    }
  }, 60_000);

  it('rolls back journaled writes and refuses to overwrite later user changes', async () => {
    const { app, root } = await createApp();
    try {
      const first = await executeConfirmedProposal(app, proposal('intent-rollback-a', 'notes/rollback-a.txt', 'created'));
      const firstLedgerId = String((first.result.metadata?.ledger as { ledgerId?: string } | undefined)?.ledgerId || '');
      expect(first.result.metadata?.ledger).toMatchObject({ rollback: { status: 'available' } });
      await expect(app.rollbackAction(firstLedgerId)).resolves.toMatchObject({ status: 'rolled-back' });
      await expect(readFile(path.join(root, 'notes', 'rollback-a.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const second = await executeConfirmedProposal(app, proposal('intent-rollback-b', 'notes/rollback-b.txt', 'created'));
      const secondLedgerId = String((second.result.metadata?.ledger as { ledgerId?: string } | undefined)?.ledgerId || '');
      await writeFile(path.join(root, 'notes', 'rollback-b.txt'), 'user changed it', 'utf8');
      await expect(app.rollbackAction(secondLedgerId)).resolves.toMatchObject({
        status: 'blocked',
        reason: expect.stringContaining('changed after the action'),
      });
      await expect(readFile(path.join(root, 'notes', 'rollback-b.txt'), 'utf8')).resolves.toBe('user changed it');
    } finally {
      await app.stop().catch(() => undefined);
    }
  }, 60_000);
});

async function createApp(): Promise<{ app: MonarchApplication; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-proposals-'));
  roots.push(root);
  const app = new MonarchApplication({
    workspaceRoot: root,
    enabledModules: ['workspace', 'security'],
    enableLocalSystemRouter: false,
    permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request', autonomyMode: 'guided' },
  });
  await app.start();
  return { app, root };
}

function proposal(intentId: string, filePath: string, content: string) {
  return {
    version: 1 as const,
    intentId,
    capabilityId: 'workspace.files.write',
    args: { path: filePath, content, overwrite: false },
    reason: 'Create one requested workspace file.',
    expectedEffect: `Create ${filePath}.`,
    preconditions: [{ kind: 'not-exists' as const, target: filePath }],
    verification: [{ kind: 'contains' as const, target: filePath, value: content }],
    provenance: { source: 'runtime-grammar' as const, model: 'unit-model', skillIds: ['unit-skill'] },
  };
}

async function executeConfirmedProposal(app: MonarchApplication, actionProposal: ReturnType<typeof proposal>) {
  const originatingUserText = `Создай файл ${actionProposal.args.path}`;
  const prepared = await app.submitActionProposal({
    proposal: actionProposal,
    originatingUserText,
    requestedBy: 'ui:oscar:model-proposal',
  });
  expect(prepared.result.error).toBe('confirmation-required');
  return app.submitActionProposal({
    proposal: prepared.proposal,
    originatingUserText,
    requestedBy: 'ui:oscar:model-proposal',
    confirmed: true,
    confirmationToken: prepared.confirmation!.token,
    grantScope: 'once',
  });
}
