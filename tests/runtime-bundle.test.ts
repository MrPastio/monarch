import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('packaged Monarch runtime bundle', () => {
  it('executes bundled CommonJS dependencies from the ESM release artifact', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'monarch-runtime-bundle-'));
    temporaryRoots.push(temporaryRoot);
    const outputPath = path.join(temporaryRoot, 'monarch-server.mjs');

    execFileSync(process.execPath, ['scripts/build-runtime-bundle.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MONARCH_RUNTIME_BUNDLE_OUTPUT: outputPath,
      },
      stdio: 'pipe',
      timeout: 60_000,
      windowsHide: true,
    });

    const output = execFileSync(process.execPath, [outputPath, 'help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });

    expect(output).toContain('Monarch commands:');
  }, 90_000);

  it('activates the exact bundle with no writable junctions inside the version root', async () => {
    const temporaryRoot = await mkdtemp(path.join(process.cwd(), '.tmp-installed-bundle-'));
    temporaryRoots.push(temporaryRoot);
    const installRoot = path.join(temporaryRoot, 'install');
    const versionRoot = path.join(installRoot, 'versions', '9.9.9');
    const outputPath = path.join(versionRoot, 'dist', 'monarch-server.mjs');
    const payloadRoot = path.join(temporaryRoot, 'payload');
    const dataRoot = path.join(temporaryRoot, 'data');
    const logsRoot = path.join(temporaryRoot, 'logs');
    const configRoot = path.join(temporaryRoot, 'config');

    execFileSync(process.execPath, ['scripts/build-runtime-bundle.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MONARCH_RUNTIME_BUNDLE_OUTPUT: outputPath,
      },
      stdio: 'pipe',
      timeout: 60_000,
      windowsHide: true,
    });

    const output = execFileSync(process.execPath, [outputPath, 'system'], {
      cwd: versionRoot,
      env: {
        ...process.env,
        MONARCH_INSTALL_ROOT: installRoot,
        MONARCH_VERSION_ROOT: versionRoot,
        MONARCH_PAYLOAD_ROOT: payloadRoot,
        MONARCH_CONFIG_ROOT: configRoot,
        MONARCH_DATA_ROOT: dataRoot,
        MONARCH_LOGS_ROOT: logsRoot,
        MONARCH_STT_PREWARM_ON_ACTIVATE: '0',
        MONARCH_TELEGRAM_AUTO_START: '0',
      },
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });

    expect(output).toContain('"workspaceRoot"');
    expect(await readdir(versionRoot)).toEqual(['dist']);
    expect(existsSync(path.join(payloadRoot, 'generated'))).toBe(true);
    expect(existsSync(path.join(dataRoot, 'profile.json'))).toBe(true);
    expect(existsSync(path.join(dataRoot, 'custom-tools.json'))).toBe(true);
    expect(existsSync(path.join(installRoot, 'secrets', 'oscar_token.txt'))).toBe(true);
  }, 90_000);
});
