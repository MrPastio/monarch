import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'win32')('versioned Windows install layout', () => {
  it('stops only the running Monarch version process tree before an upgrade', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-installer-shutdown-'));
    roots.push(root);
    const install = path.join(root, 'install');
    const versionRoot = path.join(install, 'versions', '0.2.4.2');
    const targetScript = path.join(versionRoot, 'desktop', 'electron', 'worker.js');
    const unrelatedScript = path.join(root, 'unrelated-worker.js');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(targetScript), { recursive: true }));
    await writeFile(targetScript, 'setInterval(() => {}, 1000);\n', 'utf8');
    await writeFile(unrelatedScript, 'setInterval(() => {}, 1000);\n', 'utf8');
    const target = spawn(process.execPath, [targetScript], { stdio: 'ignore' });
    const unrelated = spawn(process.execPath, [unrelatedScript], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const resultPath = path.join(root, 'shutdown-result.json');
      const scriptPath = path.join(root, 'verify-shutdown.ps1');
      const layoutScript = path.join(process.cwd(), 'installer', 'layout.ps1');
      await writeFile(scriptPath, `
$ErrorActionPreference = "Stop"
. ${quotePs(layoutScript)}
$result = Stop-MonarchRunningVersion -InstallRoot ${quotePs(install)} -Version "0.2.4.2" -GracePeriodMilliseconds 0
$result | ConvertTo-Json | Set-Content -LiteralPath ${quotePs(resultPath)} -Encoding UTF8
`, 'utf8');
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ], { stdio: 'pipe' });
      if (target.exitCode === null) {
        await new Promise((resolve) => target.once('exit', resolve));
      }
      const result = JSON.parse((await readFile(resultPath, 'utf8')).replace(/^\uFEFF/, ''));
      expect(result).toMatchObject({ version: '0.2.4.2', requested: 1, stopped: 1, forced: 1 });
      expect(unrelated.exitCode).toBeNull();
    } finally {
      if (target.exitCode === null) target.kill();
      if (unrelated.exitCode === null) unrelated.kill();
    }
  }, 20_000);

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
$wrongGenerated = Join-Path ${quotePs(root)} "wrong-generated"
New-Item -ItemType Directory -Path $wrongGenerated -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $v2 "artifacts") -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $v2 "artifacts\\generated") -Target $wrongGenerated | Out-Null
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
    const installLayout = JSON.parse(await readFile(path.join(root, 'install', 'install-layout.json'), 'utf8'));
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
    for (const relativePath of [
      'artifacts/generated',
      'oscar/data',
      'security/data',
      'security/logs',
    ]) {
      const legacyPath = path.join(root, 'install', 'versions', '0.2.0', relativePath);
      await expect(lstat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(installLayout).toMatchObject({
      generatedRoot: path.join(root, 'payload', 'generated'),
      workspaceRoot: path.join(root, 'payload', 'workspaces', 'default'),
      dataRoot: path.join(root, 'local', 'Monarch', 'data'),
      logsRoot: path.join(root, 'local', 'Monarch', 'logs'),
      securityDataRoot: path.join(root, 'local', 'Monarch', 'data', 'security'),
      securityLogsRoot: path.join(root, 'local', 'Monarch', 'logs', 'security'),
    });
    await expect(lstat(installLayout.securityDataRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(lstat(installLayout.securityLogsRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  }, 15_000);

  it('classifies a partial active version as repairable without deleting its data', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-installer-repair-'));
    roots.push(root);
    const scriptPath = path.join(root, 'verify-repair.ps1');
    const layoutScript = path.join(process.cwd(), 'installer', 'layout.ps1');
    await writeFile(scriptPath, `
$ErrorActionPreference = "Stop"
$env:LOCALAPPDATA = Join-Path ${quotePs(root)} "local"
$env:APPDATA = Join-Path ${quotePs(root)} "roaming"
$install = Join-Path ${quotePs(root)} "install"
$payload = Join-Path ${quotePs(root)} "payload"
$candidate = Join-Path $install "versions\\0.2.4.2"
New-Item -ItemType Directory -Path (Join-Path $install "versions\\0.2.4.1"), $candidate -Force | Out-Null
. ${quotePs(layoutScript)}
$layout = Initialize-MonarchInstallLayout -InstallRoot $install -VersionRoot $candidate -AppVersion "0.2.4.2" -RuntimeVersion "2026.07.7" -BackendEnvironment "backend-0.1.5-offline6" -PayloadRoot $payload
Set-MonarchCurrentVersion -InstallRoot $install -CurrentVersion "0.2.4.1"
[IO.File]::WriteAllText((Join-Path $layout.dataRoot "preserve.txt"), "important")
$healthy = Test-MonarchInstalledVersionHealthy -InstallRoot $install -Layout $layout -Version "0.2.4.1"
Write-MonarchRepairReceipt -InstallRoot $install -PreviousVersion "0.2.4.1" -CandidateVersion "0.2.4.2" -Reason "active-version-incomplete"
Set-MonarchCurrentVersion -InstallRoot $install -CurrentVersion "0.2.4.2"
[ordered]@{ healthy = $healthy; preserved = Test-Path (Join-Path $layout.dataRoot "preserve.txt") } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path ${quotePs(root)} "result.json") -Encoding UTF8
`, 'utf8');

    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], { stdio: 'pipe' });

    const result = JSON.parse((await readFile(path.join(root, 'result.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const current = JSON.parse(await readFile(path.join(root, 'install', 'current.json'), 'utf8'));
    expect(result).toEqual({ healthy: false, preserved: true });
    expect(current).toMatchObject({ currentVersion: '0.2.4.2' });
    const repairFiles = await import('node:fs/promises').then(({ readdir }) => (
      readdir(path.join(root, 'install', 'repair-history'))
    ));
    expect(repairFiles).toHaveLength(1);
    const repair = JSON.parse(await readFile(
      path.join(root, 'install', 'repair-history', repairFiles[0]!),
      'utf8',
    ));
    expect(repair).toMatchObject({
      previousVersion: '0.2.4.1',
      candidateVersion: '0.2.4.2',
      reason: 'active-version-incomplete',
    });
  }, 15_000);

  it('persists a diagnostic receipt when the offline manifest is missing', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-installer-failure-'));
    roots.push(root);
    const staging = path.join(root, 'staging');
    const install = path.join(root, 'install');
    const localAppData = path.join(root, 'local');
    const finalizer = path.join(process.cwd(), 'installer', 'finalize-offline-install.ps1');
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([
      mkdir(staging, { recursive: true }),
      mkdir(install, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
    ]));

    const runBrokenFinalizer = () => execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        finalizer,
        '-StagingRoot',
        staging,
        '-InstallRoot',
        install,
        '-AppVersion',
        '0.2.4.2',
      ], {
        env: { ...process.env, LOCALAPPDATA: localAppData },
        stdio: 'pipe',
      });

    expect(runBrokenFinalizer).toThrow();
    expect(runBrokenFinalizer).toThrow();

    const receiptDirectory = path.join(localAppData, 'Monarch', 'installer-logs');
    const receipt = JSON.parse(await readFile(
      path.join(receiptDirectory, 'latest-failure.json'),
      'utf8',
    ));
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      appVersion: '0.2.4.2',
      stage: 'payload-manifest',
    });
    expect(receipt.message).toContain('Offline payload manifest is missing');
    expect(receipt.receiptPath).toMatch(/failure-\d{8}-\d{9}-[a-f0-9]{32}\.json$/i);

    const receiptFiles = (await readdir(receiptDirectory))
      .filter((name) => /^failure-.*\.json$/i.test(name));
    expect(receiptFiles).toHaveLength(2);
    expect((await readdir(receiptDirectory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  }, 15_000);
});

function quotePs(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
