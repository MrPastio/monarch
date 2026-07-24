import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchApplication } from '../../src/app/application';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('installed runtime mutable-path contract', () => {
  it('activates every built-in module without writing into the version directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-installed-paths-'));
    temporaryRoots.push(root);
    const installRoot = path.join(root, 'install');
    const versionRoot = path.join(installRoot, 'versions', '9.9.9');
    const payloadRoot = path.join(root, 'payload');
    const configRoot = path.join(root, 'config');
    const dataRoot = path.join(root, 'data');
    const logsRoot = path.join(root, 'logs');
    await mkdir(versionRoot, { recursive: true });

    vi.stubEnv('MONARCH_INSTALL_ROOT', installRoot);
    vi.stubEnv('MONARCH_VERSION_ROOT', versionRoot);
    vi.stubEnv('MONARCH_PAYLOAD_ROOT', payloadRoot);
    vi.stubEnv('MONARCH_CONFIG_ROOT', configRoot);
    vi.stubEnv('MONARCH_DATA_ROOT', dataRoot);
    vi.stubEnv('MONARCH_LOGS_ROOT', logsRoot);
    vi.stubEnv('MONARCH_STT_PREWARM_ON_ACTIVATE', '0');
    vi.stubEnv('MONARCH_TELEGRAM_AUTO_START', '0');

    const app = new MonarchApplication({
      workspaceRoot: versionRoot,
      enableLocalSystemRouter: false,
    });
    await app.start();
    try {
      expect(app.workspaceRoot).toBe(path.join(payloadRoot, 'workspaces', 'default'));
      expect(app.runtime.kernel.getSnapshot().modules.every((module) => module.status === 'active')).toBe(true);
    } finally {
      await app.stop();
    }

    expect(await readdir(versionRoot)).toEqual([]);
    expect(existsSync(path.join(payloadRoot, 'generated'))).toBe(true);
    expect(existsSync(path.join(payloadRoot, 'workspaces', 'coder'))).toBe(true);
    expect(existsSync(path.join(dataRoot, 'profile.json'))).toBe(true);
    expect(existsSync(path.join(dataRoot, 'custom-tools.json'))).toBe(true);
    expect(existsSync(path.join(dataRoot, 'telegram-pairing.json'))).toBe(true);
    expect(existsSync(path.join(dataRoot, 'runtime', 'coder', 'projects.json'))).toBe(true);
    expect(existsSync(path.join(installRoot, 'secrets', 'oscar_token.txt'))).toBe(true);
  });
});
