import { mkdtemp, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalOwnerDevSettingsStore } from '../../src/settings';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalOwnerDevSettingsStore', () => {
  it('does not publish an enabled policy or replay receipt when the disk write fails', async () => {
    const root = await temporaryRoot(), store = new LocalOwnerDevSettingsStore(root);
    const request = { schemaVersion: 1 as const, clientRequestId: 'disable', command: 'dev.update' as const,
      scope: { type: 'chat' as const }, expectedRevision: 0, payload: { patch: { memoryEnabled: false } }, policyDecisionHash: 'a'.repeat(64) };
    await store.execute(request);
    const before = store.snapshotWithRevision();
    const temp = path.join(root, 'settings', `owner-dev.v1.json.${process.pid}.tmp`);
    await mkdir(temp); // Exact fixture-only obstruction: writeFileSync cannot write a directory.
    const enable = { ...request, clientRequestId: 'enable', expectedRevision: 1, payload: { patch: { memoryEnabled: true } } };
    await expect(store.execute(enable)).rejects.toThrow();
    expect(store.snapshotWithRevision()).toEqual(before);
    expect(new LocalOwnerDevSettingsStore(root).snapshotWithRevision()).toEqual(before);
    await rmdir(temp);
    const committed = await store.execute(enable);
    expect(committed).toMatchObject({ replayed: false, revision: 2 });
    expect(store.snapshot().memoryEnabled).toBe(true);
    expect(new LocalOwnerDevSettingsStore(root).snapshotWithRevision()).toEqual(store.snapshotWithRevision());
  });
  it('does not expose mutable live policy through committed or replayed receipts', async () => {
    const root = await temporaryRoot(), store = new LocalOwnerDevSettingsStore(root);
    const request = { schemaVersion: 1 as const, clientRequestId: 'immutable', command: 'dev.update' as const,
      scope: { type: 'chat' as const }, expectedRevision: 0, payload: { patch: { memoryEnabled: false } }, policyDecisionHash: 'a'.repeat(64) };
    const first = await store.execute(request);
    (first.result as any).value.memoryEnabled = true;
    expect(store.snapshot().memoryEnabled).toBe(false);
    const replay = await store.execute(request);
    expect((replay.result as any).value.memoryEnabled).toBe(false);
    (replay.result as any).value.memoryEnabled = true;
    expect(store.snapshot().memoryEnabled).toBe(false);
    expect((await store.execute(request)).result).toEqual({ value: store.snapshot() });
  });
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
