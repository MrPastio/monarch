import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DurableJsonSyncError,
  readDurableJson,
  renameWithWindowsRetrySync,
  tryReadDurableJson,
  tryWriteDurableJson,
  writeDurableJson,
} from '../../src/core/durable-json';

describe('synchronous durable JSON', () => {
  it('retries transient Windows replace errors with bounded synchronous backoff', () => {
    const failures = ['EPERM', 'EBUSY', 'EACCES'];
    const delays: number[] = [];
    let calls = 0;

    renameWithWindowsRetrySync('source.tmp', 'target.json', {
      attempts: 5,
      baseDelayMs: 4,
      renameFile: () => {
        const code = failures[calls];
        calls += 1;
        if (code) throw Object.assign(new Error(code), { code });
      },
      sleep: (milliseconds) => delays.push(milliseconds),
    });

    expect(calls).toBe(4);
    expect(delays).toEqual([4, 8, 12]);
  });

  it('preserves the previous target and cleans temp after replace exhaustion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-sync-json-failure-'));
    const filePath = path.join(root, 'state.json');
    try {
      writeDurableJson(filePath, { revision: 1 });
      const failure = Object.assign(new Error('scanner owns target'), { code: 'EPERM' });
      const delays: number[] = [];
      let attempts = 0;
      expect(() => writeDurableJson(filePath, { revision: 2 }, {
        attempts: 3,
        renameFile: () => {
          attempts += 1;
          throw failure;
        },
        sleep: (milliseconds) => delays.push(milliseconds),
      })).toThrow(DurableJsonSyncError);

      expect(attempts).toBe(3);
      expect(delays).toEqual([8, 16]);
      expect(readDurableJson(filePath)).toEqual({ revision: 1 });
      expect(await readdir(root)).toEqual(['state.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on corrupt JSON while the explicit best-effort reader returns null', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-sync-json-corrupt-'));
    const filePath = path.join(root, 'state.json');
    try {
      await writeFile(filePath, '{ broken json', 'utf8');
      expect(() => readDurableJson(filePath)).toThrowError(/invalid JSON/);
      expect(tryReadDurableJson(filePath)).toBeNull();
      expect(await readFile(filePath, 'utf8')).toBe('{ broken json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never modifies the target when serialization fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-sync-json-serialize-'));
    const filePath = path.join(root, 'state.json');
    try {
      writeDurableJson(filePath, { stable: true });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => writeDurableJson(filePath, circular)).toThrowError(/serialize/);
      expect(readDurableJson(filePath)).toEqual({ stable: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('makes best-effort write failure explicit and preserves an occupied target directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-sync-json-directory-'));
    const filePath = path.join(root, 'occupied.json');
    try {
      await mkdir(filePath);
      expect(tryWriteDurableJson(filePath, { mustNotReplace: true })).toBe(false);
      await expect(readdir(filePath)).resolves.toEqual([]);
      expect((await readdir(root)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
