import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DurableJsonFile,
  ensureParentDirectory,
  renameWithWindowsRetry,
  writeDurableJsonAtomically,
  writeFileAtomically,
} from '../../src/core/durable-json-file';

describe('durable JSON file operations', () => {
  const counter = {
    createEmpty: () => ({ count: 0 }),
    validate(value: unknown): asserts value is { count: number } {
      if (!value || typeof (value as { count?: unknown }).count !== 'number') throw new Error('invalid counter');
    },
  };

  it('fails closed on a damaged file unless the store opted into quarantine', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-durable-strict-'));
    try {
      const filePath = path.join(root, 'state.json');
      await writeFile(filePath, '{"count":', 'utf8');
      await expect(new DurableJsonFile(filePath, counter).read()).rejects.toMatchObject({ code: 'invalid-json' });
      await writeFile(filePath, '{"count":"x"}', 'utf8');
      await expect(new DurableJsonFile(filePath, counter).read()).rejects.toMatchObject({ code: 'invalid-document' });
      await expect(readFile(filePath, 'utf8')).resolves.toBe('{"count":"x"}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('moves a damaged file aside unchanged and continues from empty when asked to', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-durable-quarantine-'));
    try {
      const filePath = path.join(root, 'state.json');
      await writeFile(filePath, '{"count":', 'utf8');
      const moved: Array<{ code: string; quarantinePath: string }> = [];
      const file = new DurableJsonFile(filePath, { ...counter, onQuarantine: (info) => { moved.push(info); } });
      await expect(file.readShared()).resolves.toEqual({ count: 0 });
      expect(moved).toHaveLength(1);
      expect(moved[0]!.code).toBe('invalid-json');
      await expect(readFile(moved[0]!.quarantinePath, 'utf8')).resolves.toBe('{"count":');
      await file.mutate((document) => { document.count += 1; return { changed: true, value: undefined }; });
      await expect(readFile(filePath, 'utf8').then(JSON.parse)).resolves.toEqual({ count: 1 });
      // Damage found while a mutation already holds the lock is handled the same way.
      await writeFile(filePath, '{"count":"x"}', 'utf8');
      await expect(file.mutate((document) => ({ changed: false, value: document.count }))).resolves.toBe(0);
      expect(moved.map((entry) => entry.code)).toEqual(['invalid-json', 'invalid-document']);
      expect((await readdir(root)).filter((name) => name.startsWith('state.json.corrupt-'))).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a file placed directly in a drive root', async () => {
    // Live: Coder could not write D:\site.html — recursive mkdir of a Windows
    // drive root answers EPERM although the root exists.
    const root = path.parse(tmpdir()).root;
    await expect(ensureParentDirectory(path.join(root, 'monarch-root-file.html'))).resolves.toBeUndefined();
  });

  it('retries transient Windows rename failures with bounded backoff', async () => {
    const failures = ['EPERM', 'EBUSY', 'EACCES'];
    const delays: number[] = [];
    let calls = 0;

    await renameWithWindowsRetry('source.tmp', 'target.json', {
      attempts: 5,
      baseDelayMs: 3,
      renameFile: async () => {
        const code = failures[calls];
        calls += 1;
        if (code) throw Object.assign(new Error(code), { code });
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(calls).toBe(4);
    expect(delays).toEqual([3, 6, 9]);
  });

  it('does not retry a non-transient rename failure', async () => {
    const failure = Object.assign(new Error('missing source'), { code: 'ENOENT' });
    const delays: number[] = [];
    let calls = 0;

    await expect(renameWithWindowsRetry('source.tmp', 'target.json', {
      renameFile: async () => {
        calls += 1;
        throw failure;
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    })).rejects.toBe(failure);

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('stops after the configured transient failure budget', async () => {
    const failure = Object.assign(new Error('scanner still owns the file'), { code: 'EPERM' });
    const delays: number[] = [];
    let calls = 0;

    await expect(renameWithWindowsRetry('source.tmp', 'target.json', {
      attempts: 3,
      baseDelayMs: 2,
      renameFile: async () => {
        calls += 1;
        throw failure;
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    })).rejects.toBe(failure);

    expect(calls).toBe(3);
    expect(delays).toEqual([2, 4]);
  });

  it('keeps every concurrent replacement parseable and leaves no temporary files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-durable-json-'));
    const filePath = path.join(root, 'state.json');
    try {
      await Promise.all(Array.from({ length: 32 }, (_, index) => (
        writeDurableJsonAtomically(filePath, { index, payload: `value-${index}` })
      )));

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { index: number; payload: string };
      expect(persisted.index).toBeGreaterThanOrEqual(0);
      expect(persisted.index).toBeLessThan(32);
      expect(persisted.payload).toBe(`value-${persisted.index}`);
      expect((await readdir(root)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves arbitrary binary bytes without JSON or text transformation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-atomic-bytes-'));
    const filePath = path.join(root, 'payload.bin');
    try {
      const payload = Uint8Array.from([0, 10, 13, 127, 128, 255]);
      await writeFileAtomically(filePath, payload);
      expect(await readFile(filePath)).toEqual(Buffer.from(payload));
      expect(await readdir(root)).toEqual(['payload.bin']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('durable JSON file cache', () => {
  it('serves repeated reads from the validated cache and rereads when the file changes', async () => {
    const { DurableJsonFile } = await import('../../src/core/durable-json-file');
    const { writeFile: write, stat: statFile, utimes } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-durable-cache-'));
    try {
      const filePath = path.join(root, 'doc.json');
      let validations = 0;
      const file = new DurableJsonFile<{ value: number }>(filePath, {
        createEmpty: () => ({ value: 0 }),
        validate: (value) => { validations += 1; if (typeof (value as { value?: unknown }).value !== 'number') throw new Error('bad'); },
      });
      await file.mutate((doc) => { doc.value = 1; return { changed: true, value: undefined }; });
      const before = validations;
      const shared = await file.readShared();
      expect(shared.value).toBe(1);
      expect(Object.isFrozen(shared)).toBe(true);
      await file.readShared(); await file.read();
      expect(validations).toBe(before);
      // Another writer changes the file: the cache notices by identity.
      await write(filePath, JSON.stringify({ value: 22 }), 'utf8');
      const info = await statFile(filePath);
      await utimes(filePath, info.atime, new Date(info.mtimeMs + 5000));
      expect((await file.readShared()).value).toBe(22);
      // A mutable read stays a private copy.
      const copy = await file.read(); copy.value = 99;
      expect((await file.readShared()).value).toBe(22);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('durable JSON file lock after a crash', () => {
  const counter = {
    createEmpty: () => ({ count: 0 }),
    validate(value: unknown): asserts value is { count: number } {
      if (!value || typeof (value as { count?: unknown }).count !== 'number') throw new Error('invalid counter');
    },
  };

  it.each([
    ['empty', ''],
    ['cut short', '{"schemaVersion":"monarch.durable-json-lock.v1","ownerId":"durable_json_'],
  ])('takes over a %s lock that only a crashed writer can leave', async (_case, content) => {
    // Live: a process that exited between creating the lock and writing its
    // owner left a lock no one could attribute; every store operation then
    // waited out the timeout until the 30 s TTL passed.
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-durable-lock-'));
    try {
      const filePath = path.join(root, 'state.json');
      await writeFile(`${filePath}.lock`, content, 'utf8');
      const file = new DurableJsonFile(filePath, { ...counter, lockTimeoutMs: 1_000 });
      const startedAt = Date.now();
      await expect(file.mutate((document) => { document.count += 1; return { changed: true, value: document.count }; })).resolves.toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(900);
      expect(await readdir(root)).toEqual(['state.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never leaves a partly written lock: the owner is in place the moment the lock exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-durable-lock-'));
    try {
      const filePath = path.join(root, 'state.json');
      const file = new DurableJsonFile(filePath, counter);
      let seen = '';
      await file.mutate((document) => {
        seen = readFileSync(`${filePath}.lock`, 'utf8');
        document.count += 1; return { changed: true, value: undefined };
      });
      expect(JSON.parse(seen)).toMatchObject({ schemaVersion: 'monarch.durable-json-lock.v1', pid: process.pid });
      expect(await readdir(root)).toEqual(['state.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
