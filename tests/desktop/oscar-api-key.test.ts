import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without type declarations
import { createOscarApiKeyStore } from '../../desktop/electron/oscar-api-key.mjs';
import { OscarClient } from '../../src/modules/oscar/client';

/** Reversible stand-in for Electron safeStorage: the bytes never contain the plain value. */
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value: string) => Buffer.from('enc:' + Buffer.from(value).toString('base64').split('').reverse().join('')),
  decryptString: (bytes: Buffer) => {
    const text = bytes.toString();
    if (!text.startsWith('enc:')) throw Error('bad');
    return Buffer.from(text.slice(4).split('').reverse().join(''), 'base64').toString();
  },
});

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), 'monarch-oscar-key-'));
  roots.push(dir);
  return { dataRoot: path.join(dir, 'data'), legacyPath: path.join(dir, 'secrets', 'oscar_token.txt'), dir };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if ((await readFile(file)).includes(needle)) hits.push(file);
  }
  return hits;
}

describe('Oscar API key store', () => {
  it('creates an encrypted record and never writes the key as plain text', async () => {
    const { dataRoot, legacyPath, dir } = await root();
    const store = createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage: fakeSafeStorage() });
    const loaded = await store.load();
    expect(loaded).toMatchObject({ persistent: true, migrated: false });
    expect(loaded.key).toMatch(/^[0-9a-f]{64}$/);
    expect(await filesContaining(dir, loaded.key)).toEqual([]);
    const again = createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage: fakeSafeStorage() });
    expect((await again.load()).key).toBe(loaded.key);
  });

  it('moves a plain-text key into the record with the same value and removes the file', async () => {
    const { dataRoot, legacyPath, dir } = await root();
    const legacyKey = 'a'.repeat(64);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, '\uFEFF' + legacyKey + '\n');
    const loaded = await createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage: fakeSafeStorage() }).load();
    expect(loaded).toEqual({ key: legacyKey, persistent: true, migrated: true });
    expect(existsSync(legacyPath)).toBe(false);
    expect(await filesContaining(dir, legacyKey)).toEqual([]);
  });

  it('finishes an interrupted migration but keeps a different plain file', async () => {
    const { dataRoot, legacyPath } = await root();
    const first = await createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage: fakeSafeStorage() }).load();
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, first.key);
    await createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage: fakeSafeStorage() }).load();
    expect(existsSync(legacyPath)).toBe(false);
    await writeFile(legacyPath, 'b'.repeat(64));
    const kept = await createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage: fakeSafeStorage() }).load();
    expect(kept.key).toBe(first.key);
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('lets a diagnostic profile copy a plain-text key without deleting it', async () => {
    const { dataRoot, legacyPath } = await root();
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, 'd'.repeat(64));
    const loaded = await createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage: fakeSafeStorage(), removeLegacyFile: false }).load();
    expect(loaded.key).toBe('d'.repeat(64));
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('uses a session-only key and writes nothing without OS encryption', async () => {
    const { dataRoot, legacyPath, dir } = await root();
    const loaded = await createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage: fakeSafeStorage(false) }).load();
    expect(loaded).toMatchObject({ persistent: false, migrated: false });
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a damaged record and a refused ACL instead of writing anything else', async () => {
    const { dataRoot, legacyPath } = await root();
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, 'oscar-api-key.encrypted'), 'not-encrypted');
    await expect(createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage: fakeSafeStorage() }).load())
      .rejects.toThrow('oscar-api-key:record');
    const other = await root();
    await expect(createOscarApiKeyStore({ ...other, safeStorage: fakeSafeStorage(), restrictAccess: async () => false }).load())
      .rejects.toThrow('oscar-api-key:protected-record');
  });
});

describe('runtime Oscar client', () => {
  it('takes the key Desktop passed in and does not create a secrets file', async () => {
    const { dir } = await root();
    const secretsRoot = path.join(dir, 'secrets');
    const previous = process.env.OSCAR_API_TOKEN;
    process.env.OSCAR_API_TOKEN = 'c'.repeat(64);
    try {
      new OscarClient({ secretsRoot, projectRoot: path.join(dir, 'oscar'), logsRoot: path.join(dir, 'logs'), autoStart: false });
      expect(existsSync(path.join(secretsRoot, 'oscar_token.txt'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OSCAR_API_TOKEN; else process.env.OSCAR_API_TOKEN = previous;
    }
  });
});
