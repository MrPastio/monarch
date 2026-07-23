import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
let suiteRoot = '';
let launcherPath = '';

beforeAll(() => {
  suiteRoot = mkdtempSync(path.join(tmpdir(), 'monarch-launcher-state-'));
  launcherPath = path.join(suiteRoot, 'Monarch.exe');
  const compilerCandidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const compiler = compilerCandidates.find(existsSync);
  if (!compiler) throw new Error('The .NET Framework C# compiler is unavailable.');
  const result = spawnSync(compiler, [
    '/nologo',
    '/target:winexe',
    `/out:${launcherPath}`,
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Windows.Forms.dll',
    path.join(repositoryRoot, 'tools', 'launcher', 'MonarchLauncher.cs'),
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Launcher compilation failed.\n${result.stdout}\n${result.stderr}`);
  }
});

afterAll(() => {
  if (suiteRoot) rmSync(suiteRoot, { recursive: true, force: true });
});

describe('Monarch launcher terminal update phases', () => {
  it('launches the committed current version without retrying or rolling back it', async () => {
    const fixture = createFixture('committed');
    const before = readFileSync(fixture.pendingPath, 'utf8');

    runLauncher(fixture.installRoot);
    const launchedVersion = await waitForLaunchMarker(fixture.markerPath);

    expect(launchedVersion).toBe('0.2.3.5');
    expect(readFileSync(fixture.pendingPath, 'utf8')).toBe(before);
    expect(readJson(fixture.currentPath)).toMatchObject({
      currentVersion: '0.2.3.5',
      previousVersion: '0.2.3.4',
    });
  });

  it('keeps a completed rollback terminal instead of re-entering the trial loop', async () => {
    const fixture = createFixture('rollback-required');
    const before = readFileSync(fixture.pendingPath, 'utf8');

    runLauncher(fixture.installRoot);
    const launchedVersion = await waitForLaunchMarker(fixture.markerPath);

    expect(launchedVersion).toBe('0.2.3.4');
    expect(readFileSync(fixture.pendingPath, 'utf8')).toBe(before);
    expect(readJson(fixture.currentPath)).toMatchObject({
      currentVersion: '0.2.3.4',
      previousVersion: '0.2.3.5',
    });
  });
});

function createFixture(phase: 'committed' | 'rollback-required') {
  const fixtureRoot = path.join(suiteRoot, phase);
  const installRoot = path.join(fixtureRoot, 'install');
  const payloadRoot = path.join(fixtureRoot, 'payload');
  const dataRoot = path.join(fixtureRoot, 'data');
  const markerPath = path.join(dataRoot, 'launched-version.txt');
  const runtimeRoot = path.join(payloadRoot, 'runtimes', 'runtime-qa-runtime');
  const environmentRoot = path.join(payloadRoot, 'environments', 'qa-environment');
  const transactionRoot = path.join(payloadRoot, 'transactions');
  const pendingPath = path.join(transactionRoot, 'pending-update.json');
  const currentPath = path.join(installRoot, 'current.json');
  mkdirSync(path.join(runtimeRoot, 'electron'), { recursive: true });
  mkdirSync(path.join(runtimeRoot, 'node'), { recursive: true });
  mkdirSync(path.join(runtimeRoot, 'python'), { recursive: true });
  mkdirSync(environmentRoot, { recursive: true });
  mkdirSync(transactionRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  copyFileSync(process.execPath, path.join(runtimeRoot, 'electron', 'electron.exe'));
  writeFileSync(path.join(runtimeRoot, 'node', 'node.exe'), '');
  writeFileSync(path.join(runtimeRoot, 'python', 'python.exe'), '');

  for (const version of ['0.2.3.4', '0.2.3.5']) {
    const versionRoot = path.join(installRoot, 'versions', version);
    const mainPath = path.join(versionRoot, 'desktop', 'electron', 'main.mjs');
    mkdirSync(path.dirname(mainPath), { recursive: true });
    writeFileSync(mainPath, [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const dataRoot = process.env.MONARCH_DATA_ROOT;",
      "mkdirSync(dataRoot, { recursive: true });",
      "writeFileSync(path.join(dataRoot, 'launched-version.txt'), path.basename(process.env.MONARCH_VERSION_ROOT));",
      '',
    ].join('\n'));
    writeJson(path.join(versionRoot, 'version.json'), {
      descriptorVersion: 1,
      appVersion: version,
      layoutSchemaVersion: 1,
      minimumLauncherVersion: '1.0.0',
      runtimeVersion: 'qa-runtime',
      backendEnvironment: 'qa-environment',
      dataSchemaVersion: 1,
      minimumReadableDataSchema: 1,
      maximumReadableDataSchema: 1,
    });
  }

  writeJson(path.join(installRoot, 'install-layout.json'), {
    schemaVersion: 1,
    installRoot,
    payloadRoot,
    configRoot: path.join(fixtureRoot, 'config'),
    dataRoot,
    logsRoot: path.join(fixtureRoot, 'logs'),
    transactionsRoot: transactionRoot,
  });
  const committed = phase === 'committed';
  writeJson(currentPath, {
    schemaVersion: 1,
    currentVersion: committed ? '0.2.3.5' : '0.2.3.4',
    previousVersion: committed ? '0.2.3.4' : '0.2.3.5',
    updatedAt: 'sentinel-current',
  });
  writeJson(pendingPath, {
    schemaVersion: 1,
    updateId: '00000000-0000-4000-8000-000000000001',
    previousVersion: '0.2.3.4',
    candidateVersion: '0.2.3.5',
    previousLauncherVersion: '1.0.0',
    candidateLauncherVersion: '1.0.0',
    previousRuntimeVersion: 'qa-runtime',
    expectedRuntimeVersion: 'qa-runtime',
    previousBackendEnvironment: 'qa-environment',
    expectedBackendEnvironment: 'qa-environment',
    previousDataSchema: 1,
    expectedDataSchema: 1,
    snapshotId: null,
    attempts: 2,
    phase,
    rolledBackAt: phase === 'rollback-required' ? 'sentinel-rollback' : undefined,
  });
  copyFileSync(launcherPath, path.join(installRoot, 'Monarch.exe'));
  return { installRoot, markerPath, pendingPath, currentPath };
}

function runLauncher(installRoot: string) {
  const result = spawnSync(path.join(installRoot, 'Monarch.exe'), [], {
    cwd: installRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
}

async function waitForLaunchMarker(markerPath: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(markerPath)) return readFileSync(markerPath, 'utf8');
    await delay(50);
  }
  throw new Error(`Launcher did not create ${markerPath}.`);
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}
