import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();
const setupPath = path.join(workspaceRoot, 'tools', 'setup-vosk-telegram-stt.ps1');
const wrapperPath = path.join(workspaceRoot, 'tools', 'setup-voice-stt.ps1');
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('Telegram/Vosk STT provisioning', () => {
  it('pins the model, decoder and native Vosk component and keeps the combined wrapper explicit', async () => {
    const { readFile } = await import('node:fs/promises');
    const [setup, wrapper, bootstrap, launcher] = await Promise.all([
      readFile(setupPath, 'utf8'),
      readFile(wrapperPath, 'utf8'),
      readFile(path.join(workspaceRoot, 'installer', 'bootstrap.ps1'), 'utf8'),
      readFile(path.join(workspaceRoot, 'tools', 'launcher', 'MonarchLauncher.cs'), 'utf8'),
    ]);
    expect(setup).toContain("$modelSha256 = '961d5ff98a17f4aa6de69864d0aa71fa5bac682301d2b5d17a3f24c5c99a46d4'");
    expect(setup).toContain("$ffmpegSha256 = '6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541'");
    expect(setup).toContain("$voskDllSha256 = '9331c2f6a32cf77141af27c9750e79532718f51bbc2e3cea3c60f14ca4251e4e'");
    expect(setup).toContain("$pipSha256 = '9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd'");
    expect(setup).toContain('$env:PYTHONPATH = $pipWheel');
    expect(setup).toContain('persisted = $false');
    expect(setup).not.toContain('-m ensurepip');
    expect(setup).toContain("$env:PIP_CACHE_DIR = $pipCache");
    expect(wrapper).toContain("setup-sherpa-t-one-stt.ps1");
    expect(wrapper).toContain("setup-vosk-telegram-stt.ps1");
    expect(wrapper).toContain('PipWheelPath');
    expect(bootstrap).toContain('tools\\setup-voice-stt.ps1');
    expect(bootstrap).toContain('Join-Path ([string]$layout.modelsRoot) "voice"');
    expect(launcher).toContain('MONARCH_STT_PYTHONPATH');
    expect(launcher).toContain('MONARCH_FFMPEG_PATH');
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects a changed model archive before extraction and removes staging',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-vosk-setup-test-'));
      cleanupPaths.push(root);
      const badArchive = path.join(root, 'changed.zip');
      await writeFile(badArchive, 'changed archive', 'utf8');
      const python = resolvePython();
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupPath,
        '-PythonExe', python,
        '-ModelsRoot', path.join(root, 'models'),
        '-RuntimeRoot', path.join(root, 'runtime'),
        '-ModelArchivePath', badArchive,
      ], { cwd: workspaceRoot, encoding: 'utf8', timeout: 20_000, windowsHide: true });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/SHA256 mismatch/);
      await expect(access(path.join(root, 'models', 'vosk-model-small-ru-0.22'))).rejects.toThrow();
      const runtimeEntries = await readdir(path.join(root, 'runtime'));
      expect(runtimeEntries.filter((name) => name.startsWith('.vosk-telegram-setup-'))).toEqual([]);
    },
  );
});

function resolvePython(): string {
  const result = spawnSync('where.exe', ['python.exe'], { encoding: 'utf8', windowsHide: true });
  const candidate = String(result.stdout || '').split(/\r?\n/u).find(Boolean);
  if (!candidate) throw new Error('python.exe is required for the Windows provisioning test.');
  return candidate;
}
