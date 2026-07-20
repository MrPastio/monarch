import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'win32')('versioned Windows install layout', () => {
  it('keeps the previous pointer active and stages an immutable candidate transaction', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-installer-layout-'));
    roots.push(root);
    const scriptPath = path.join(root, 'verify-layout.ps1');
    const layoutScript = path.join(process.cwd(), 'installer', 'layout.ps1');
    await writeFile(scriptPath, `
$ErrorActionPreference = "Stop"
$env:LOCALAPPDATA = Join-Path ${quotePs(root)} "local"
$env:APPDATA = Join-Path ${quotePs(root)} "roaming"
$install = Join-Path ${quotePs(root)} "install"
$payload = Join-Path ${quotePs(root)} "payload"
$v1 = Join-Path $install "versions\\0.1.5"
$v2 = Join-Path $install "versions\\0.2.0"
New-Item -ItemType Directory -Path $v1, $v2 -Force | Out-Null
. ${quotePs(layoutScript)}
$layout1 = Initialize-MonarchInstallLayout -InstallRoot $install -VersionRoot $v1 -AppVersion "0.1.5" -RuntimeVersion "2026.07.1" -BackendEnvironment "backend-0.1.5" -PayloadRoot $payload
Write-MonarchVersionDescriptor -VersionRoot $v1 -AppVersion "0.1.5" -RuntimeVersion "2026.07.1" -BackendEnvironment "backend-0.1.5" | Out-Null
Set-MonarchCurrentVersion -InstallRoot $install -CurrentVersion "0.1.5"
$layout2 = Initialize-MonarchInstallLayout -InstallRoot $install -VersionRoot $v2 -AppVersion "0.2.0" -RuntimeVersion "2026.08.0" -BackendEnvironment "backend-0.2.0" -PayloadRoot $payload
Write-MonarchVersionDescriptor -VersionRoot $v2 -AppVersion "0.2.0" -RuntimeVersion "2026.08.0" -BackendEnvironment "backend-0.2.0" | Out-Null
New-MonarchPendingUpdate -InstallRoot $install -Layout $layout2 -PreviousVersion "0.1.5" -CandidateVersion "0.2.0" -CandidateRuntimeVersion "2026.08.0" -CandidateBackendEnvironment "backend-0.2.0" | Out-Null
`, 'utf8');

    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], { stdio: 'pipe' });

    const current = JSON.parse(await readFile(path.join(root, 'install', 'current.json'), 'utf8'));
    const pending = JSON.parse(await readFile(path.join(root, 'payload', 'transactions', 'pending-update.json'), 'utf8'));
    const descriptor = JSON.parse(await readFile(path.join(root, 'install', 'versions', '0.2.0', 'version.json'), 'utf8'));
    expect(current).toMatchObject({ currentVersion: '0.1.5', previousVersion: null });
    expect(pending).toMatchObject({
      previousVersion: '0.1.5',
      candidateVersion: '0.2.0',
      expectedRuntimeVersion: '2026.08.0',
      phase: 'staged',
      attempts: 0,
    });
    expect(descriptor).toMatchObject({
      appVersion: '0.2.0',
      runtimeVersion: '2026.08.0',
      backendEnvironment: 'backend-0.2.0',
    });
    for (const [relativePath, target] of [
      ['oscar/data', path.join(root, 'local', 'Monarch', 'data', 'oscar')],
      ['security/data', path.join(root, 'local', 'Monarch', 'data', 'security')],
      ['security/logs', path.join(root, 'local', 'Monarch', 'logs', 'security')],
    ]) {
      const linkedPath = path.join(root, 'install', 'versions', '0.2.0', relativePath);
      expect((await lstat(linkedPath)).isSymbolicLink()).toBe(true);
      expect((await realpath(linkedPath)).toLowerCase()).toBe(
        (await realpath(target)).toLowerCase(),
      );
    }
  }, 15_000);
});

function quotePs(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
