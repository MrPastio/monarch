import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
});
