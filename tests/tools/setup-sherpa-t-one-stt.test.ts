import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();
const scriptPath = path.join(workspaceRoot, 'tools', 'setup-sherpa-t-one-stt.ps1');
const modelId = 'sherpa-onnx-streaming-t-one-russian-2025-09-08';
const expectedSha256 = 'b9c907450e99a6e5049e279bf18368a17db0bdc5e63b7fa978943138debbe3ae';
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => (
    rm(target, { recursive: true, force: true })
  )));
});

describe('Sherpa T-one STT setup', () => {
  it('pins the official asset, immutable SHA256, model files, manifest, and npm entrypoint', async () => {
    const [script, packageJsonText] = await Promise.all([
      readFile(scriptPath, 'utf8'),
      readFile(path.join(workspaceRoot, 'package.json'), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageJsonText) as { scripts: Record<string, string> };

    expect(script).toContain(
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'
      + 'sherpa-onnx-streaming-t-one-russian-2025-09-08.tar.bz2',
    );
    expect(script).toContain(`$expectedSha256 = '${expectedSha256}'`);
    expect(script).toContain("Join-Path $stagedModelDirectory 'model.onnx'");
    expect(script).toContain("Join-Path $stagedModelDirectory 'tokens.txt'");
    expect(script).toContain("$manifestName = 'monarch-model.json'");
    expect(packageJson.scripts['voice:stt:setup']).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -File tools/setup-sherpa-t-one-stt.ps1',
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'fails closed before extraction on a local hash mismatch and removes its work files',
    async () => {
      const testRoot = await mkdtemp(path.join(os.tmpdir(), 'monarch-sherpa-setup-test-'));
      cleanupPaths.push(testRoot);
      const archivePath = path.join(testRoot, `${modelId}.tar.bz2`);
      const modelsRoot = path.join(testRoot, 'models');
      await writeFile(archivePath, 'not-the-pinned-official-archive', 'utf8');

      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-ModelsRoot',
          modelsRoot,
          '-ArchivePath',
          archivePath,
        ],
        {
          cwd: workspaceRoot,
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
        },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/SHA256 mismatch/);
      await expect(access(archivePath)).resolves.toBeUndefined();
      await expect(access(path.join(modelsRoot, modelId))).rejects.toThrow();
      expect((await readdir(modelsRoot)).filter((name) => name.startsWith('.sherpa-t-one-setup-')))
        .toEqual([]);
    },
  );
});
