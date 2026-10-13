import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ASTRA_JOURNAL_KEY_RECORD, loadOrCreateAstraJournalKey } from '../../desktop/electron/astra-journal-key.mjs';

let parent: string, root: string;
beforeAll(async () => {
  parent = await realpath('.test-tmp');
  root = await realpath(await mkdtemp(path.join(parent, 'astra-journal-key-')));
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: false }); });

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8').map(byte => byte ^ 0x5a),
  decryptString: (value: Buffer) => Buffer.from(value).map(byte => byte ^ 0x5a).toString('utf8'),
};

describe('Astra V3 journal device key', () => {
  it('creates one protected key, restricts its root and reuses the exact value', async () => {
    const keyRoot = path.join(root, 'ready'), expected = Buffer.alloc(ASTRA_JOURNAL_KEY_RECORD.keyBytes, 0x31);
    const restrictAccess = vi.fn(async () => true);
    const first = await loadOrCreateAstraJournalKey({ rootPath: keyRoot, safeStorage, restrictAccess,
      randomBytesFactory: () => Buffer.from(expected) });
    const second = await loadOrCreateAstraJournalKey({ rootPath: keyRoot, safeStorage, restrictAccess,
      randomBytesFactory: () => { throw new Error('must-not-regenerate'); } });
    expect(first).toEqual(expected); expect(second).toEqual(expected); expect(restrictAccess).toHaveBeenCalledTimes(2);
    const record = path.join(keyRoot, ASTRA_JOURNAL_KEY_RECORD.fileName);
    expect((await lstat(record)).isFile()).toBe(true);
    expect((await readFile(record)).includes(Buffer.from(expected.toString('base64')))).toBe(false);
    first!.fill(0); second!.fill(0); expected.fill(0);
  });

  it('fails closed for unavailable protection, denied ACL and corrupt records without replacing them', async () => {
    expect(await loadOrCreateAstraJournalKey({ rootPath: path.join(root, 'unavailable'),
      safeStorage: { isEncryptionAvailable: () => false } })).toBeNull();
    const deniedRoot = path.join(root, 'denied');
    expect(await loadOrCreateAstraJournalKey({ rootPath: deniedRoot, safeStorage, restrictAccess: async () => false,
      randomBytesFactory: () => Buffer.alloc(32, 0x22) })).toBeNull();
    const corruptRoot = path.join(root, 'corrupt');
    await mkdir(corruptRoot, { recursive: true });
    const record = path.join(corruptRoot, ASTRA_JOURNAL_KEY_RECORD.fileName);
    await writeFile(record, Buffer.from('corrupt'), { flag: 'wx' });
    const before = await readFile(record);
    expect(await loadOrCreateAstraJournalKey({ rootPath: corruptRoot, safeStorage, restrictAccess: async () => true,
      randomBytesFactory: () => Buffer.alloc(32, 0x33) })).toBeNull();
    expect(await readFile(record)).toEqual(before);
  });
});
