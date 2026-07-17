import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app';

describe('MonarchApplication operational context', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('resolves a scoped directory reference and the following content reply structurally', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-operational-'));
    roots.push(root);
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace', 'security'],
      enableLocalSystemRouter: false,
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
    });
    const context = { clientSessionId: 'session-a', clientConversationId: 'conversation-a' };
    const submit = async (text: string) => {
      const prepared = await app.submitIntent({ text, context });
      return prepared.confirmation
        ? app.submitIntent({
            text,
            context,
            confirmed: true,
            confirmationToken: prepared.confirmation.token,
          })
        : prepared;
    };

    try {
      const mkdirResult = await submit('создай папку flow');
      expect(mkdirResult.execution?.ok).toBe(true);

      const incomplete = await submit('в этой папке сделай текстовый файл');
      expect(incomplete.execution?.error).toBe('clarification-required');

      const completed = await submit('тест валидации');
      expect(completed.route?.capabilityId).toBe('workspace.files.write');
      expect(completed.execution?.ok).toBe(true);
      await expect(readFile(path.join(root, 'flow', 'note.txt'), 'utf8')).resolves.toBe('тест валидации');
    } finally {
      await app.stop().catch(() => undefined);
    }
  }, 60_000);
});
