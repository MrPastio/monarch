import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Electron main-process module without type declarations.
import { renameWithRetry } from '../../desktop/electron/windows-rename.mjs';

describe('main-process rename on Windows', () => {
  it('waits out a transient hold on the fresh file', async () => {
    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    await renameWithRetry('a.tmp', 'a.json', { sleep, renameFile: async () => {
      calls += 1; if (calls < 4) throw Object.assign(new Error('held'), { code: ['EPERM', 'EBUSY', 'EACCES'][calls - 1] });
    } });
    expect(calls).toBe(4);
    expect(sleep.mock.calls.map(call => call[0])).toEqual([25, 50, 75]);
  });
  it('throws other errors at once and a lasting hold after its budget', async () => {
    const missing = vi.fn(async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });
    await expect(renameWithRetry('a', 'b', { renameFile: missing, sleep: async () => undefined })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(missing).toHaveBeenCalledTimes(1);
    const held = vi.fn(async () => { throw Object.assign(new Error('held'), { code: 'EPERM' }); });
    await expect(renameWithRetry('a', 'b', { renameFile: held, sleep: async () => undefined })).rejects.toMatchObject({ code: 'EPERM' });
    expect(held).toHaveBeenCalledTimes(12);
  });
});
