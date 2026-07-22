import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUpdateDemoRuntime } from '../../desktop/electron/update-demo.mjs';
import { MonarchUpdateService } from '../../desktop/electron/update-service.mjs';

describe('Monarch Desktop update demo', () => {
  it('uses the real signed update pipeline without launching an installer', async () => {
    const demo = createUpdateDemoRuntime({
      now: Date.parse('2026-07-23T12:00:00.000Z'),
      installerSize: 64 * 1024,
      chunkDelayMs: 0,
      installDelayMs: 0,
    });
    const updateRoot = await mkdtemp(path.join(os.tmpdir(), 'monarch-update-demo-test-'));
    const service = new MonarchUpdateService({
      currentVersion: '0.2.3.2',
      updaterVersion: '0.2.3.2',
      launcherVersion: '1.0.0',
      endpoints: demo.endpoints,
      publicKeys: demo.publicKeys,
      updateRoot,
      fetchImpl: demo.fetchImpl,
      launchInstaller: demo.launchInstaller,
      now: () => Date.parse('2026-07-23T12:00:00.000Z'),
      diskReserveBytes: 0,
    });

    const available = await service.check();
    expect(available.state).toBe('update-available');
    expect(available.release?.version).toBe('0.2.3.3');
    expect(available.sources).toEqual([
      { id: 'github', status: 'valid', sequence: 9001 },
      { id: 'sites', status: 'valid', sequence: 9001 },
    ]);

    const installed = await service.install();
    expect(installed.state).toBe('restart-pending');
    expect(installed.progress?.percent).toBe(100);
  });
});
