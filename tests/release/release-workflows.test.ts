import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) =>
  readFile(path.join(process.cwd(), relativePath), 'utf8');

const sha256 = (content: Buffer | string) => createHash('sha256')
  .update(content)
  .digest('hex');

const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

describe('Monarch distribution workflows', () => {
  it('keeps release and refresh publication serialized', async () => {
    for (const workflowPath of [
      '.github/workflows/release-stable.yml',
      '.github/workflows/refresh-stable-manifest.yml',
    ]) {
      const workflow = await read(workflowPath);
      expect(workflow).toContain('group: monarch-stable-release');
      expect(workflow).toContain('cancel-in-progress: false');
    }
  });

  it('uses a draft, remote verification, and stable-channel-last release flow', async () => {
    const workflow = await read('.github/workflows/release-stable.yml');
    const draft = workflow.indexOf('Create draft release');
    const remoteVerification = workflow.indexOf('Verify downloaded release assets');
    const publish = workflow.indexOf('Publish verified release');
    const stable = workflow.indexOf('Fast-forward stable channel');
    expect(draft).toBeGreaterThan(-1);
    expect(remoteVerification).toBeGreaterThan(draft);
    expect(publish).toBeGreaterThan(remoteVerification);
    expect(stable).toBeGreaterThan(publish);
    expect(workflow).not.toContain('--clobber');
    expect(workflow).toContain('MONARCH_RELEASES_TOKEN');
    expect(workflow).toContain('npm run upload:dry-run');
  });

  it('retires same-repository tag publication from the legacy installer workflow', async () => {
    const workflow = await read('.github/workflows/windows-installer.yml');
    expect(workflow).toMatch(/permissions:\r?\n  contents: read/);
    expect(workflow).not.toContain('softprops/action-gh-release');
    expect(workflow).not.toContain('tags:');
  });

  it('provisions only the exact pinned Windows runtime dependency bundle', () => {
    const qaRoot = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    mkdirSync(qaRoot, { recursive: true });
    const fixture = mkdtempSync(path.join(qaRoot, 'runtime-dependencies-'));
    const trusted = path.join(fixture, 'trusted');
    const stage = path.join(fixture, 'stage');
    const destination = path.join(fixture, 'verified');
    const rejectedDestination = path.join(fixture, 'rejected');
    const archive = path.join(fixture, 'runtime-dependencies.zip');
    mkdirSync(trusted);
    mkdirSync(stage);

    try {
      const wheelName = 'fixture-runtime.whl';
      const nativeName = 'fixture-runtime.dll';
      const wheel = Buffer.from('portable-wheel-fixture', 'utf8');
      const native = Buffer.from('native-runtime-fixture', 'utf8');
      const cpuManifest = `${JSON.stringify({
        schemaVersion: 1,
        artifact: { name: wheelName, size: wheel.length, sha256: sha256(wheel) },
      }, null, 2)}\n`;
      const nativeManifest = `${JSON.stringify({
        schemaVersion: 1,
        files: [{ name: nativeName, size: native.length, sha256: sha256(native) }],
      }, null, 2)}\n`;
      for (const [name, content] of [
        ['llama-cpp-cpu-portable.json', cpuManifest],
        ['manifest.json', nativeManifest],
        [wheelName, wheel],
        [nativeName, native],
      ] as const) {
        writeFileSync(path.join(stage, name), content);
        if (name.endsWith('.json')) writeFileSync(path.join(trusted, name), content);
      }
      const compressed = spawnSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Compress-Archive -Path ${psLiteral(path.join(stage, '*'))} -DestinationPath ${psLiteral(archive)} -CompressionLevel Optimal`,
      ], { encoding: 'utf8' });
      expect(compressed.status, `${compressed.stdout}\n${compressed.stderr}`).toBe(0);
      const archiveBytes = readFileSync(archive);
      writeFileSync(path.join(trusted, 'bundle-source.json'), `${JSON.stringify({
        schemaVersion: 1,
        component: 'fixture-runtime-dependencies',
        version: '1',
        url: 'https://github.com/MrPastio/monarch-releases/releases/download/fixture/runtime-dependencies.zip',
        size: archiveBytes.length,
        sha256: sha256(archiveBytes),
      }, null, 2)}\n`);

      const provision = (archivePath: string, output: string) => spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(process.cwd(), 'installer', 'provision-runtime-dependencies.ps1'),
          '-CandidateRoot',
          trusted,
          '-TrustedManifestDirectory',
          trusted,
          '-Destination',
          output,
          '-ArchivePath',
          archivePath,
        ],
        { encoding: 'utf8' },
      );
      const accepted = provision(archive, destination);
      expect(accepted.status, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);
      expect(readFileSync(path.join(destination, wheelName))).toEqual(wheel);
      expect(readFileSync(path.join(destination, nativeName))).toEqual(native);

      const alteredArchive = path.join(fixture, 'altered.zip');
      writeFileSync(alteredArchive, Buffer.concat([archiveBytes, Buffer.from([0])]));
      const rejected = provision(alteredArchive, rejectedDestination);
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'failed exact size or SHA-256 verification',
      );
      expect(existsSync(rejectedDestination)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);

  it('propagates native Oscar and Security test failures to release callers', async () => {
    for (const scriptPath of [
      'oscar/scripts/test.ps1',
      'security/scripts/test.ps1',
    ]) {
      const script = await read(scriptPath);
      expect(script).toMatch(
        /& \$python -m pytest[\s\S]*if \(\$LASTEXITCODE -ne 0\) \{\r?\n\s+exit \$LASTEXITCODE\r?\n\}/u,
      );
    }
  });

  it('runs deterministic Security and model-free runtime gates before publication', async () => {
    const workflow = await read('.github/workflows/release-stable.yml');
    const security = workflow.indexOf('.\\security\\scripts\\test.ps1');
    const voiceProvenance = workflow.indexOf(
      'oscar\\backend\\tests\\test_sharing_tts_runtime.py',
    );
    const smoke = workflow.indexOf('npm run smoke:raw');
    const desktopSmoke = workflow.indexOf('npm run desktop:smoke');
    const frontendBuild = workflow.indexOf('npm run oscar:frontend:build');
    const boundary = workflow.indexOf('npm run upload:dry-run');

    expect(workflow).toContain('python-version: "3.11.9"');
    expect(workflow).toContain('pytest==9.1.1');
    expect(workflow).toMatch(
      /gates-and-installer:\r?\n\s+needs: \[security-tests, oscar-provenance-tests\]/u,
    );
    expect(security).toBeGreaterThan(-1);
    expect(voiceProvenance).toBeGreaterThan(security);
    expect(workflow).toContain(
      'python -m pytest oscar\\backend\\tests\\test_sharing_tts_runtime.py -q',
    );
    expect(smoke).toBeGreaterThan(security);
    expect(desktopSmoke).toBeGreaterThan(smoke);
    expect(frontendBuild).toBeGreaterThan(desktopSmoke);
    expect(boundary).toBeGreaterThan(frontendBuild);
    expect(workflow).toContain('Provision verified Windows runtime dependencies');
    expect(workflow).toContain('provision-runtime-dependencies.ps1');
    expect(workflow).toContain('-RuntimeDependenciesRoot $env:MONARCH_RUNTIME_DEPENDENCIES_ROOT');
    expect(workflow).toContain(
      'npm run test:raw -- --exclude tests/modules/coder.test.ts --exclude tests/app/coder-agent-controller.test.ts --maxWorkers=1',
    );
    expect(workflow).toContain(
      "$env:MONARCH_CODER_SANDBOX_ROOT = 'C:\\monarch-release-smoke-sandbox'",
    );
  });

  it('serializes the broad Windows source suite in CI and stable release jobs', async () => {
    for (const workflowPath of [
      '.github/workflows/ci.yml',
      '.github/workflows/release-stable.yml',
    ]) {
      const workflow = await read(workflowPath);
      expect(workflow).toContain(
        'npm run test:raw -- --exclude tests/modules/coder.test.ts --exclude tests/app/coder-agent-controller.test.ts --maxWorkers=1',
      );
    }
  });

  it('refreshes at 30 days and raises an urgent issue at 14 days', async () => {
    const workflow = await read('.github/workflows/refresh-stable-manifest.yml');
    expect(workflow).toContain('refreshDue');
    expect(workflow).toContain('urgent');
    expect(workflow).toContain('[P0] Stable manifest signing or refresh failed');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain("cron: '17 5 * * 1'");
  });

  it('does not commit a production private or invented public key', async () => {
    const docs = await read('release/README.md');
    const sample = await read('release/examples/stable-bootstrap.json');
    const packageManifest = JSON.parse(await read('package.json'));
    const releaseSpec = JSON.parse(await read('release/stable-release-spec.json'));
    const version = packageManifest.version;
    expect(docs).toContain('No production private key or invented public key is committed');
    expect(sample).not.toContain('BEGIN PRIVATE KEY');
    expect(sample).not.toContain('BEGIN PUBLIC KEY');
    expect(releaseSpec.available).toBe(true);
    expect(releaseSpec.withdrawnReason).toBeNull();
    expect(releaseSpec.version).toBe(version);
    expect(releaseSpec.releaseNotesUrl).toContain(`/v${version}`);
    expect(releaseSpec.asset.url).toContain(`/v${version}/Monarch-Setup-${version}.exe`);
    expect(releaseSpec.asset.fileName).toBe(`Monarch-Setup-${version}.exe`);
    expect(releaseSpec.compatibility).toMatchObject({
      runtimeVersion: '2026.07.7',
      backendEnvironment: 'backend-0.1.5-offline8',
    });
    expect(JSON.stringify(releaseSpec)).not.toContain('bootstrap-pending');
  });
});
