import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeVault } from '../../desktop/safe/vault.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createVault() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-chat-test-'));
  roots.push(root);
  const vault = new SafeVault(root, {
    testKdf: true,
    autoLockMs: 60_000,
    deviceKey: Buffer.alloc(32, 0x73),
  });
  await vault.initialize();
  await vault.setup({ pin: '1234', pinLength: 4, destructionConfirmed: true });
  await vault.completeSetup({ recoveryAcknowledged: true });
  return { root, vault };
}

function record(content = 'SAFE_CHAT_PRIVATE_MARKER_91AC') {
  return {
    version: 1,
    id: 'conversation-1234',
    kind: 'oscar',
    title: 'Секретный разговор',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T01:00:00.000Z',
    messages: [
      { id: 'm1', role: 'user', content },
      { id: 'm2', role: 'assistant', content: 'Зашифрованный ответ' },
    ],
  };
}

async function allPersistedBytes(root: string): Promise<Buffer> {
  const paths: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) paths.push(absolute);
    }
  }
  await walk(root);
  return Buffer.concat(await Promise.all(paths.map((file) => readFile(file))));
}

describe('Monarch Safe encrypted chat records', () => {
  it('stores chats as hidden authenticated Safe generations without plaintext at rest', async () => {
    const { root, vault } = await createVault();
    const stored = await vault.upsertChat({ record: record() });

    expect(stored).toMatchObject({ verified: true, chat: { id: 'conversation-1234', encrypted: true, storage: 'monarch-safe' } });
    expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(vault.list().files).toEqual([]);
    expect(vault.listChats()).toEqual([
      expect.objectContaining({ id: 'conversation-1234', title: 'Секретный разговор', messageCount: 2 }),
    ]);
    await expect(vault.readChat({ id: 'conversation-1234', kind: 'oscar' })).resolves.toMatchObject({
      record: { messages: [expect.objectContaining({ content: 'SAFE_CHAT_PRIVATE_MARKER_91AC' }), expect.any(Object)] },
    });
    expect((await allPersistedBytes(root)).toString('latin1')).not.toContain('SAFE_CHAT_PRIVATE_MARKER_91AC');
  });

  it('atomically replaces one chat generation, survives relock and supports cryptographic deletion', async () => {
    const { root, vault } = await createVault();
    await vault.upsertChat({ record: record('first generation') });
    await vault.upsertChat({ record: { ...record('second generation'), updatedAt: '2026-07-15T02:00:00.000Z' } });
    expect((await readdir(path.join(root, 'blobs'))).filter((name) => name.endsWith('.blob'))).toHaveLength(1);
    await expect(vault.readChat({ id: 'conversation-1234' })).resolves.toMatchObject({
      record: { messages: [expect.objectContaining({ content: 'second generation' }), expect.any(Object)] },
    });

    vault.lock();
    await expect(vault.readChat({ id: 'conversation-1234' })).rejects.toMatchObject({ code: 'vault-locked' });
    await vault.unlockWithPin('1234');
    await expect(vault.readChat({ id: 'conversation-1234' })).resolves.toMatchObject({ record: { id: 'conversation-1234' } });
    await expect(vault.deleteChat({ id: 'conversation-1234' })).resolves.toMatchObject({ deleted: true });
    expect(vault.listChats()).toEqual([]);
    expect((await readdir(path.join(root, 'blobs'))).filter((name) => name.endsWith('.blob'))).toEqual([]);
  });

  it('fails closed when an encrypted chat blob is modified outside Safe', async () => {
    const { root, vault } = await createVault();
    await vault.upsertChat({ record: record() });
    const blobName = (await readdir(path.join(root, 'blobs'))).find((name) => name.endsWith('.blob'))!;
    const blobPath = path.join(root, 'blobs', blobName);
    const bytes = await readFile(blobPath);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(blobPath, bytes);
    await expect(vault.readChat({ id: 'conversation-1234' })).rejects.toMatchObject({ code: 'file-integrity-failed' });
  });
});
