import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalOwnerDevSettingsStore } from '../../src/settings';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalOwnerDevSettingsStore', () => {
  it('commits boolean-only policy with CAS read-back and no chat content fields', async () => {
    const root = await temporaryRoot();
    const store = new LocalOwnerDevSettingsStore(root);
    const receipt = await store.execute({
      schemaVersion: 1,
      clientRequestId: 'owner_dev_test_1',
      command: 'dev.update',
      scope: { type: 'chat' },
      expectedRevision: 0,
      payload: { patch: { zeroRetentionEnabled: true, internetEnabled: false } },
      policyDecisionHash: 'a'.repeat(64),
    });
    const context = await store.read({ schemaVersion: 1, kind: 'dev', scope: { type: 'chat' } });

    expect(context.value).toMatchObject({ zeroRetentionEnabled: true, internetEnabled: false });
    expect(receipt).toMatchObject({ revision: 1, contentHash: context.contentHash, readBackHash: context.contentHash });
    expect(JSON.stringify(context.value)).not.toMatch(/message|content|conversation|historyText/i);
  });

  it('fails closed to zero retention when the persisted policy is corrupt', async () => {
    const root = await temporaryRoot();
    const settingsRoot = path.join(root, 'settings');
    await mkdir(settingsRoot, { recursive: true });
    await writeFile(path.join(settingsRoot, 'owner-dev.v1.json'), '{broken', 'utf8');

    expect(new LocalOwnerDevSettingsStore(root).snapshot()).toMatchObject({
      zeroRetentionEnabled: true,
      diagnostic: expect.stringContaining('fail-closed'),
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-owner-dev-'));
  roots.push(root);
  return root;
}
