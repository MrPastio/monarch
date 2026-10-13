import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installUnhandledRejectionGuard, runInBackground } from '../../src/core/background-work';

afterEach(() => vi.restoreAllMocks());
const logged = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map(call => JSON.parse(String(call[0])));

describe('background work', () => {
  it('reports a rejected background promise by code and never rethrows it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      runInBackground('model-install', Promise.reject(Object.assign(new Error('C:\Users\secret path'), { code: 'EPERM' })));
      runInBackground('sync-throw', () => { throw new TypeError('boom'); });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      expect(logged(errors)).toEqual([
        { diagnostic: 'monarch-background-failure', work: 'sync-throw', code: 'TypeError' },
        { diagnostic: 'monarch-background-failure', work: 'model-install', code: 'EPERM' },
      ]);
      expect(JSON.stringify(errors.mock.calls)).not.toContain('secret');
    } finally { process.off('unhandledRejection', listener); }
  });

  it('logs an unhandled rejection with its source frame instead of ending the process', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const target = new EventEmitter() as unknown as NodeJS.Process;
    installUnhandledRejectionGuard(target);
    const error = new Error('content that must not be logged');
    error.stack = 'Error: content\n    at node:internal/process/task_queues:1:1\n    at drain (file:///E:/Monarch/dist/monarch-server.mjs:36065:11)';
    (target as unknown as EventEmitter).emit('unhandledRejection', error);
    const [entry] = logged(errors);
    expect(entry).toMatchObject({ diagnostic: 'monarch-background-failure', code: 'Error' });
    expect(entry.work).toContain('unhandled-rejection drain (file:///E:/Monarch/dist/monarch-server.mjs:36065:11)');
    expect(JSON.stringify(entry)).not.toContain('must not be logged');
  });
});
