import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SealedFileError, deriveStoreKey, isSealed, openBytes, readSealedFile, sealBytes, writeSealedFile,
} from '../../src/core/sealed-file';
// @ts-expect-error -- plain ESM module without type declarations
import { createProfileDataKeyStore, deriveProfileStoreKey } from '../../desktop/electron/profile-data-key.mjs';

const roots: string[] = [];
const tempRoot = async () => { const dir = await mkdtemp(path.join(tmpdir(), 'monarch-sealed-')); roots.push(dir); return dir; };
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value: string) => Buffer.from('enc:' + Buffer.from(value).toString('hex')),
  decryptString: (bytes: Buffer) => {
    const text = bytes.toString();
    if (!text.startsWith('enc:')) throw Error('bad');
    return Buffer.from(text.slice(4), 'hex').toString();
  },
});

describe('sealed files', () => {
  const key = deriveStoreKey(randomBytes(32), 'oscar-turns');
  const canary = 'CANARY-SEALED-41d9';

  it('round-trips and never contains the plain text', async () => {
    const file = path.join(await tempRoot(), 'turns.v1.json');
    await writeSealedFile(file, key, 'oscar-turns', Buffer.from(`{"text":"${canary}"}`));
    const raw = await readFile(file);
    expect(isSealed(raw)).toBe(true);
    expect(raw.includes(canary)).toBe(false);
    expect((await readSealedFile(file, key, 'oscar-turns')).toString()).toContain(canary);
  });

  it('refuses another key, another store, a renamed file and any changed byte', () => {
    const sealed = sealBytes(key, 'oscar-turns', 'a.json', Buffer.from(canary));
    const fail = (run: () => unknown) => expect(run).toThrow(SealedFileError);
    fail(() => openBytes(deriveStoreKey(randomBytes(32), 'oscar-turns'), 'oscar-turns', 'a.json', sealed));
    fail(() => openBytes(key, 'coder-runs', 'a.json', sealed));
    fail(() => openBytes(key, 'oscar-turns', 'b.json', sealed));
    for (const at of [4, 20, sealed.length - 1]) {
      const changed = Buffer.from(sealed); changed[at] ^= 1;
      fail(() => openBytes(key, 'oscar-turns', 'a.json', changed));
    }
    fail(() => openBytes(key, 'oscar-turns', 'a.json', Buffer.from('{"plain":true}')));
  });

  it('uses a fresh nonce for every write', () => {
    const one = sealBytes(key, 'oscar-turns', 'a.json', Buffer.from('same'));
    const two = sealBytes(key, 'oscar-turns', 'a.json', Buffer.from('same'));
    expect(one.equals(two)).toBe(false);
  });

  it('derives different keys per store and rejects bad inputs', () => {
    const pdk = randomBytes(32);
    expect(deriveStoreKey(pdk, 'a').equals(deriveStoreKey(pdk, 'b'))).toBe(false);
    expect(() => deriveStoreKey(randomBytes(16), 'a')).toThrow(SealedFileError);
    expect(() => deriveStoreKey(pdk, 'Bad/Store')).toThrow(SealedFileError);
  });

  it('derives the same store key in Desktop and in the runtime', () => {
    const pdk = randomBytes(32);
    expect(deriveProfileStoreKey(pdk, 'oscar-memory').equals(deriveStoreKey(pdk, 'oscar-memory'))).toBe(true);
  });
});

describe('profile data key', () => {
  it('creates one key, keeps it across loads and never writes it in the clear', async () => {
    const dataRoot = path.join(await tempRoot(), 'protection');
    const first = await createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage() }).load();
    expect(first.persistent).toBe(true);
    expect(first.key).toHaveLength(32);
    const again = await createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage() }).load();
    expect(again.key.equals(first.key)).toBe(true);
    const record = await readFile(path.join(dataRoot, 'profile-data-key.encrypted'));
    expect(record.includes(first.key.toString('base64'))).toBe(false);
  });

  it('reports no persistent key without OS encryption and writes nothing', async () => {
    const dataRoot = path.join(await tempRoot(), 'protection');
    expect(await createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage(false) }).load())
      .toEqual({ key: null, persistent: false });
  });

  it('never replaces a damaged record with a new key', async () => {
    const dataRoot = path.join(await tempRoot(), 'protection');
    await createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage() }).load();
    await writeFile(path.join(dataRoot, 'profile-data-key.encrypted'), 'damaged');
    await expect(createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage() }).load())
      .rejects.toThrow('profile-data-key:record');
    expect((await readFile(path.join(dataRoot, 'profile-data-key.encrypted'))).toString()).toBe('damaged');
  });

  it('refuses to create a key when the ACL cannot be restricted', async () => {
    const dataRoot = path.join(await tempRoot(), 'protection');
    await expect(createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage(), restrictAccess: async () => false }).load())
      .rejects.toThrow('profile-data-key:protected-record');
  });
});
