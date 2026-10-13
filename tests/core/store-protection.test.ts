import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableJsonFile, DurableJsonFileError } from '../../src/core/durable-json-file';
import { isSealed } from '../../src/core/sealed-file';
import {
  decodeStoreLine, encodeStoreLine, initializeStoreProtection, oscarStorageEnvironment, setStoreProtectionForTesting, type StoreProtection,
} from '../../src/core/store-protection';
import { OscarAttachmentStore } from '../../src/oscar-turn/attachment-store';

const CANARY = 'CANARY-STORE-5e1c';
const roots: string[] = [];
const tempRoot = async () => { const dir = await mkdtemp(path.join(tmpdir(), 'monarch-store-protection-')); roots.push(dir); return dir; };
afterEach(async () => {
  setStoreProtectionForTesting(undefined);
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

type Doc = { items: string[] };
const open = (file: string) => new DurableJsonFile<Doc>(file, {
  createEmpty: () => ({ items: [] }),
  validate: (value): asserts value is Doc => { if (!value || !Array.isArray((value as Doc).items)) throw new Error('bad'); },
  sensitive: { storeId: 'test-store' },
});
const add = (file: DurableJsonFile<Doc>, item: string) => file.mutate(doc => { doc.items.push(item); return { changed: true, value: undefined }; });
const sealed = (key = randomBytes(32)): StoreProtection => ({ mode: 'sealed', key });
const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('condition not reached');
};

async function filesContaining(dir: string, needle: string) {
  const hits: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && (await readFile(path.join(entry.parentPath, entry.name))).includes(needle)) hits.push(entry.name);
  }
  return hits;
}

describe('store protection mode', () => {
  it('follows Desktop and the policy level, and removes the key from the environment', () => {
    const key = randomBytes(32).toString('base64url');
    const oscarKey = randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = { MONARCH_STORE_PROTECTION: 'desktop', MONARCH_STORE_KEY: key, MONARCH_OSCAR_DB_KEY: oscarKey };
    const sealedMode = initializeStoreProtection(env, 'required');
    expect(sealedMode.mode).toBe('sealed');
    expect(env.MONARCH_STORE_KEY).toBeUndefined();
    expect(env.MONARCH_OSCAR_DB_KEY).toBeUndefined();
    expect(oscarStorageEnvironment(sealedMode)).toEqual({ OSCAR_STORE_PROTECTION: 'sealed', OSCAR_DB_KEY: oscarKey });
    setStoreProtectionForTesting(undefined);
    const session = initializeStoreProtection({ MONARCH_STORE_PROTECTION: 'desktop' }, 'required');
    expect(session).toEqual({ mode: 'session', managed: true });
    expect(oscarStorageEnvironment(session)).toEqual({ OSCAR_STORE_PROTECTION: 'session' });
    setStoreProtectionForTesting(undefined);
    const off = initializeStoreProtection({ MONARCH_STORE_PROTECTION: 'desktop', MONARCH_STORE_KEY: key, MONARCH_OSCAR_DB_KEY: oscarKey }, 'off');
    expect(off.mode).toBe('plain');
    expect(oscarStorageEnvironment(off)).toEqual({ OSCAR_STORE_PROTECTION: 'plain', OSCAR_DB_KEY: oscarKey });
    setStoreProtectionForTesting(undefined);
    expect(initializeStoreProtection({}, 'required')).toEqual({ mode: 'plain' });
    expect(oscarStorageEnvironment({ mode: 'plain' })).toEqual({});
  });

  it('keeps the key on a second initialization in the same process', () => {
    initializeStoreProtection({ MONARCH_STORE_PROTECTION: 'desktop', MONARCH_STORE_KEY: randomBytes(32).toString('base64url'),
      MONARCH_OSCAR_DB_KEY: randomBytes(32).toString('hex') });
    expect(initializeStoreProtection({ MONARCH_STORE_PROTECTION: 'desktop' }).mode).toBe('sealed');
  });
});

describe('sensitive durable JSON files', () => {
  it('seal what they write and read it back', async () => {
    setStoreProtectionForTesting(sealed());
    const dir = await tempRoot();
    const file = open(path.join(dir, 'store.json'));
    await add(file, CANARY);
    expect(isSealed(await readFile(path.join(dir, 'store.json')))).toBe(true);
    expect(await filesContaining(dir, CANARY)).toEqual([]);
    expect((await open(path.join(dir, 'store.json')).read()).items).toEqual([CANARY]);
  });

  it('replace a plain file from an earlier version with a sealed one', async () => {
    setStoreProtectionForTesting(sealed());
    const dir = await tempRoot();
    await writeFile(path.join(dir, 'store.json'), JSON.stringify({ items: [CANARY] }));
    expect((await open(path.join(dir, 'store.json')).read()).items).toEqual([CANARY]);
    await waitFor(async () => isSealed(await readFile(path.join(dir, 'store.json'))));
    expect(await filesContaining(dir, CANARY)).toEqual([]);
  });

  it('keep data only in memory for a session without OS encryption', async () => {
    setStoreProtectionForTesting({ mode: 'session' });
    const dir = await tempRoot();
    const file = open(path.join(dir, 'store.json'));
    await add(file, CANARY);
    expect((await file.read()).items).toEqual([CANARY]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('stop instead of starting empty when a sealed file cannot be opened', async () => {
    setStoreProtectionForTesting(sealed());
    const dir = await tempRoot();
    await add(open(path.join(dir, 'store.json')), CANARY);
    setStoreProtectionForTesting(sealed());
    await expect(open(path.join(dir, 'store.json')).read()).rejects.toBeInstanceOf(DurableJsonFileError);
    setStoreProtectionForTesting({ mode: 'plain' });
    await expect(open(path.join(dir, 'store.json')).read()).rejects.toThrow(/sealed and cannot be opened/);
    expect(existsSync(path.join(dir, 'store.json'))).toBe(true);
  });

  it('read sealed files and write plain ones when the person turned encryption off', async () => {
    const key = randomBytes(32);
    setStoreProtectionForTesting(sealed(key));
    const dir = await tempRoot();
    await add(open(path.join(dir, 'store.json')), 'first');
    setStoreProtectionForTesting({ mode: 'plain', key });
    const file = open(path.join(dir, 'store.json'));
    expect((await file.read()).items).toEqual(['first']);
    await add(file, 'second');
    expect(JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8')).items).toEqual(['first', 'second']);
  });
});

describe('sealed JSONL lines', () => {
  it('seal each line and mark plain lines for resealing', () => {
    const protection = sealed();
    const line = encodeStoreLine(`{"text":"${CANARY}"}`, 'archive', protection);
    expect(line).not.toContain(CANARY);
    expect(decodeStoreLine(line, 'archive', protection)).toEqual({ text: `{"text":"${CANARY}"}`, legacy: false });
    expect(decodeStoreLine('{"plain":true}', 'archive', protection).legacy).toBe(true);
    expect(() => decodeStoreLine(line, 'other', protection)).toThrow();
    expect(() => decodeStoreLine(line, 'archive', { mode: 'plain' })).toThrow(/sealed-without-key/);
  });
});

describe('attachment bytes', () => {
  it('are sealed on disk and read back intact', async () => {
    setStoreProtectionForTesting(sealed());
    const dir = await tempRoot();
    const store = new OscarAttachmentStore(dir);
    const receipt = await store.put({ conversationId: 'conversation_1', source: 'desktop', privacyMode: 'persistent',
      name: 'note.txt', mimeType: 'text/plain', dataBase64: Buffer.from(`note ${CANARY}`).toString('base64') } as any);
    expect(await filesContaining(dir, CANARY)).toEqual([]);
    const [read] = await store.resolve([receipt.id], 'persistent', 'desktop', 'conversation_1');
    expect(Buffer.from(read!.dataBase64, 'base64').toString()).toBe(`note ${CANARY}`);
  });

  it('stay in memory for a session without OS encryption', async () => {
    setStoreProtectionForTesting({ mode: 'session' });
    const dir = await tempRoot();
    const store = new OscarAttachmentStore(dir);
    const receipt = await store.put({ conversationId: 'conversation_1', source: 'desktop', privacyMode: 'persistent',
      name: 'note.txt', mimeType: 'text/plain', dataBase64: Buffer.from(CANARY).toString('base64') } as any);
    const [read] = await store.resolve([receipt.id], 'persistent', 'desktop', 'conversation_1');
    expect(Buffer.from(read!.dataBase64, 'base64').toString()).toBe(CANARY);
    expect(await filesContaining(dir, CANARY)).toEqual([]);
  });
});

describe('sensitive synchronous JSON files (Coder runs, mutation journal)', () => {
  it('seal, reseal a plain file on read, and stay in memory for a session', async () => {
    const { readDurableJson, writeDurableJson } = await import('../../src/core/durable-json');
    const options = { sensitive: { storeId: 'coder-runs' } };
    setStoreProtectionForTesting(sealed());
    const dir = await tempRoot();
    const file = path.join(dir, 'coder_run_1.json');
    writeDurableJson(file, { text: CANARY }, options);
    expect(isSealed(await readFile(file))).toBe(true);
    expect(readDurableJson<{ text: string }>(file, options)).toEqual({ text: CANARY });

    const legacy = path.join(dir, 'coder_run_2.json');
    await writeFile(legacy, JSON.stringify({ text: CANARY }));
    expect(readDurableJson<{ text: string }>(legacy, options)).toEqual({ text: CANARY });
    expect(isSealed(await readFile(legacy))).toBe(true);
    expect(await filesContaining(dir, CANARY)).toEqual([]);

    setStoreProtectionForTesting({ mode: 'session' });
    const session = path.join(dir, 'coder_run_3.json');
    writeDurableJson(session, { text: CANARY }, options);
    expect(readDurableJson<{ text: string }>(session, options)).toEqual({ text: CANARY });
    expect(existsSync(session)).toBe(false);
  });
});

describe('Telegram control records', () => {
  it('seal each value, seal plain rows on open, and prune expired buttons', async () => {
    const { TelegramV2Store } = await import('../../src/modules/telegram/v2-store');
    const { DatabaseSync } = await import('node:sqlite');
    const dir = await tempRoot();
    // An earlier version left a plain row.
    await mkdir(path.join(dir, 'telegram-v2'), { recursive: true });
    const legacy = new DatabaseSync(path.join(dir, 'telegram-v2', 'control.sqlite'));
    legacy.exec('CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id))');
    legacy.prepare('INSERT INTO records VALUES (?,?,?)').run('request', 'old', JSON.stringify({ text: CANARY }));
    legacy.close();

    setStoreProtectionForTesting(sealed());
    const store = new TelegramV2Store(dir, dir, () => 1_000);
    expect(store.read<{ text: string }>('request', 'old')).toEqual({ text: CANARY });
    store.put('request', 'new', { text: CANARY });
    store.put('ui-button', 'expired', { expiresAt: 10 });
    store.put('ui-button', 'live', { expiresAt: 5_000 });
    store.pruneUi();
    expect(store.read('ui-button', 'expired')).toBeNull();
    expect(store.read('ui-button', 'live')).toEqual({ expiresAt: 5_000 });
    store.close();
    expect(await filesContaining(dir, CANARY)).toEqual([]);
  });
});
