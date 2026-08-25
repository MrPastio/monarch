import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  renameWithWindowsRetry,
  writeDurableJsonAtomically,
  writeFileAtomically,
} from '../../src/core/durable-json-file';

describe('durable JSON file operations', () => {
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
