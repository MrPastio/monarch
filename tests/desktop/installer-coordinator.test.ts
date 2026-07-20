import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTransactionalInstallerCoordinator,
  waitForActiveTasks,
} from '../../desktop/electron/installer-coordinator.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('transactional installer coordinator', () => {
  it('waits for active jobs and reaches idle without accepting renderer paths or arguments', async () => {
    const responses = [
      { jobs: [{ status: 'running' }] },
      { jobs: [{ status: 'completed' }] },
    ];
    let clock = 0;
    await waitForActiveTasks({
      runtimeUrl: 'http://127.0.0.1:7777',
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: async () => responses.shift(),
      })) as never,
      now: () => {
        clock += 10;
        return clock;
      },
      timeoutMs: 1000,
      pollMs: 1,
    });
    expect(responses).toHaveLength(0);
  });

  it('starts only a verified cache file and marks the point of no return before Setup', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-installer-coordinator-'));
    roots.push(root);
    const installRoot = path.join(root, 'install');
    const updateRoot = path.join(root, 'updates');
    const installerPath = path.join(updateRoot, 'Monarch-Setup-0.2.0.exe');
    await mkdir(updateRoot, { recursive: true });
    await writeFile(installerPath, 'MZ');

    const events: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      unref: () => events.push('unref'),
    });
    const spawnImpl = vi.fn((_file, args) => {
      events.push(`spawn:${args.join('|')}`);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const launch = createTransactionalInstallerCoordinator({
      installRoot,
      updateRoot,
      runtimeUrl: '',
      shutdown: async () => { events.push('shutdown'); },
      requestQuit: () => { events.push('quit'); },
      spawnImpl: spawnImpl as never,
    });

    const result = await launch({
      installerPath,
      manifest: { asset: { fileName: path.basename(installerPath) } },
      signal: new AbortController().signal,
      beginInstallation: () => { events.push('point-of-no-return'); },
    });

    expect(result).toEqual({ started: true, pid: 42 });
    expect(events.slice(0, 3)).toEqual([
      'point-of-no-return',
      'shutdown',
      expect.stringContaining('spawn:/VERYSILENT'),
    ]);
    expect(spawnImpl).toHaveBeenCalledWith(
      installerPath,
      expect.arrayContaining([`/DIR=${installRoot}`, '/NORESTART']),
      expect.objectContaining({ shell: false, detached: true }),
    );
  });

  it('rejects an installer outside the trusted update cache', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-installer-coordinator-'));
    roots.push(root);
    const launch = createTransactionalInstallerCoordinator({
      installRoot: path.join(root, 'install'),
      updateRoot: path.join(root, 'updates'),
      runtimeUrl: '',
      shutdown: async () => undefined,
      requestQuit: () => undefined,
    });
    await expect(launch({
      installerPath: path.join(root, 'foreign', 'Monarch-Setup-0.2.0.exe'),
      manifest: { asset: { fileName: 'Monarch-Setup-0.2.0.exe' } },
      signal: new AbortController().signal,
      beginInstallation: () => undefined,
    })).rejects.toMatchObject({ code: 'untrusted-installer-path' });
  });
});
