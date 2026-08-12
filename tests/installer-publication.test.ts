import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), 'utf8');

interface PublicationFixture {
  fixtureRoot: string;
  repo: string;
  snapshot: string;
}

const runGit = (
  repo: string,
  args: string[],
  input?: string | Buffer,
): string => execFileSync('git.exe', args, {
  cwd: repo,
  encoding: 'utf8',
  input,
});

const runGitBytes = (
  repo: string,
  args: string[],
  input?: Buffer,
): Buffer => execFileSync('git.exe', args, {
  cwd: repo,
  input,
});

const createPublicationFixture = (): PublicationFixture => {
  const temporaryRoot = process.platform === 'win32'
    ? path.join(path.parse(root).root, 'Monarch-Agent-QA')
    : path.join(root, 'tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const fixtureRoot = mkdtempSync(
    path.join(temporaryRoot, 'publication-boundary-'),
  );
  const repo = path.join(fixtureRoot, 'source');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  copyFileSync(
    path.join(root, '.gitattributes'),
    path.join(repo, '.gitattributes'),
  );
  for (const script of [
    'export-public.ps1',
    'public-source-policy.ps1',
    'upload-dry-run.ps1',
  ]) {
    copyFileSync(
      path.join(root, 'scripts', script),
      path.join(repo, 'scripts', script),
    );
  }
  const pathSetDigest = (paths: string[]) => createHash('sha256')
    .update(paths.length > 0
      ? `${[...paths].sort((left, right) => (
        left < right ? -1 : left > right ? 1 : 0
      )).join('\0')}\0`
      : '', 'utf8')
    .digest('hex');
  const emptyDigest = pathSetDigest([]);
  const fixtureZones = Object.fromEntries([
    '__root__',
    '.github',
    '.monarch',
    'assets',
    'desktop',
    'docs',
    'installer',
    'oscar',
    'release',
    'scripts',
    'security',
    'shared',
    'src',
    'tests',
    'tools',
  ].map((zone) => {
    const paths = zone === '__root__'
      ? ['.gitattributes', 'package.json']
      : zone === 'scripts'
        ? [
            'scripts/export-public.ps1',
            'scripts/public-source-policy.ps1',
            'scripts/upload-dry-run.ps1',
          ]
        : zone === 'src'
          ? ['src/main.ts', 'src/данные-測試.ts']
          : [];
    return [zone, {
      baseCount: paths.length,
      basePathDigest: paths.length > 0 ? pathSetDigest(paths) : emptyDigest,
    }];
  }));
  writeFileSync(
    path.join(repo, 'scripts', 'public-source-structure.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      zones: fixtureZones,
      additions: {},
    }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(repo, 'package.json'),
    '{"name":"monarch-publication-fixture","private":true}\n',
    'utf8',
  );
  writeFileSync(
    path.join(repo, 'src', 'main.ts'),
    'export const committedValue = 1;\n',
    'utf8',
  );
  writeFileSync(
    path.join(repo, 'src', 'данные-測試.ts'),
    'export const unicodePath = true;\n',
    'utf8',
  );
  runGit(repo, ['init', '--quiet']);
  runGit(repo, ['config', 'core.autocrlf', 'false']);
  runGit(repo, ['config', 'core.filemode', 'false']);
  runGit(repo, ['config', 'user.name', 'Monarch Publication Test']);
  runGit(repo, ['config', 'user.email', 'publication-test@invalid.local']);
  runGit(repo, ['add', '--all']);
  runGit(repo, ['commit', '--quiet', '-m', 'fixture']);
  return {
    fixtureRoot,
    repo,
    snapshot: path.join(fixtureRoot, 'fresh-public-snapshot'),
  };
};

const runPublicationScript = (
  fixture: PublicationFixture,
  script: 'export-public.ps1' | 'upload-dry-run.ps1',
  args: string[],
) => spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(fixture.repo, 'scripts', script),
    ...args,
  ],
  {
    cwd: fixture.repo,
    encoding: 'utf8',
  },
);

const exportFixture = (fixture: PublicationFixture) => {
  const revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
  const result = runPublicationScript(
    fixture,
    'export-public.ps1',
    ['-Destination', fixture.snapshot, '-SourceRevision', revision],
  );
  if (result.status !== 0) {
    throw new Error(
      `fixture export failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return revision;
};

const evaluatePublicSourcePolicy = () => {
  const policyPath = path
    .join(root, 'scripts', 'public-source-policy.ps1')
    .replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `. '${policyPath}'`,
    "$awsSample = 'AK' + 'IA' + '1234567890ABCDEF'",
    "$projectKeySample = @('sk', 'proj', ('x' * 32)) -join '-'",
    '$awsDetected = [bool]($MonarchPublicForbiddenContentPatterns | Where-Object { $awsSample -match $_ } | Select-Object -First 1)',
    '$projectKeyDetected = [bool]($MonarchPublicForbiddenContentPatterns | Where-Object { $projectKeySample -match $_ } | Select-Object -First 1)',
    '$reviewedBinaryFailures = 0',
    '$reviewedBinaryOverLimit = 0',
    'foreach ($entry in $MonarchPublicReviewedBinarySha256.GetEnumerator()) {',
    '  $item = Get-Item -LiteralPath $entry.Key -Force',
    '  if ($item.Length -gt 5242880) { $reviewedBinaryOverLimit += 1 }',
    '  if (-not (Test-MonarchPublicReviewedBinaryContent $entry.Key $item.FullName)) {',
    '    $reviewedBinaryFailures += 1',
    '  }',
    '}',
    '[pscustomobject]@{',
    "  knownSource = [bool](Test-MonarchPublicCandidatePath 'src/main.ts')",
    "  knownRoot = [bool](Test-MonarchPublicCandidatePath 'package.json')",
    "  unknownDirectory = [bool](Test-MonarchPublicCandidatePath 'future-private-zone/secret.ts')",
    "  unknownRoot = [bool](Test-MonarchPublicCandidatePath 'future-private-file.txt')",
    "  wrongCaseDirectory = [bool](Test-MonarchPublicCandidatePath 'Src/unreviewed.ts')",
    "  wrongCaseRoot = [bool](Test-MonarchPublicCandidatePath 'README.MD')",
    "  unknownBinary = [bool](Test-MonarchPublicCandidatePath 'assets/future-unreviewed.png')",
    "  showcase = [bool](Test-MonarchPublicCandidatePath 'showcase/monarch-video/public/vine-boom.wav')",
    "  orphanScript = [bool](Test-MonarchPublicCandidatePath 'remove-workspace.js')",
    "  reviewedBinary = [bool](Test-MonarchPublicCandidatePath 'assets/icon.png')",
    "  reviewedBinaryHash = [bool](Test-MonarchPublicReviewedBinaryContent 'assets/icon.png' (Resolve-Path 'assets/icon.png').Path)",
    "  alteredReviewedBinaryHash = [bool](Test-MonarchPublicReviewedBinaryContent 'assets/icon.png' (Resolve-Path 'package.json').Path)",
    '  reviewedBinaryCount = $MonarchPublicReviewedBinarySha256.Count',
    '  reviewedBinaryFailures = $reviewedBinaryFailures',
    '  reviewedBinaryOverLimit = $reviewedBinaryOverLimit',
    "  csharpText = [bool](Test-MonarchPublicTextSource 'tools/launcher/MonarchLauncher.cs')",
    "  svgText = [bool](Test-MonarchPublicTextSource 'docs/architecture.svg')",
    "  mermaidText = [bool](Test-MonarchPublicTextSource 'docs/architecture.mmd')",
    "  envExampleText = [bool](Test-MonarchPublicTextSource 'oscar/.env.example')",
    "  npmrcText = [bool](Test-MonarchPublicTextSource '.npmrc')",
    "  gitignoreText = [bool](Test-MonarchPublicTextSource 'showcase/monarch-video/.gitignore')",
    "  ignoreText = [bool](Test-MonarchPublicTextSource 'oscar/.ignore')",
    "  licenseText = [bool](Test-MonarchPublicTextSource 'src/ui/public/assets/icons/phosphor/LICENSE')",
    "  binaryAssetText = [bool](Test-MonarchPublicTextSource 'assets/icon.png')",
    '  awsDetected = $awsDetected',
    '  projectKeyDetected = $projectKeyDetected',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  return JSON.parse(execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { cwd: root, encoding: 'utf8' },
  )) as Record<string, boolean | number>;
};

describe('Windows installer and public snapshot boundary', () => {
  it('assembles a versioned offline runtime on the build machine', () => {
    const builder = read('installer/build-offline-payload.ps1');
    expect(builder).toContain('requirements-runtime.txt');
    expect(builder).toContain('requirements-runtime-lock.txt');
    expect(builder).toContain('"--constraint"');
    expect(builder).toContain('node_modules\\electron\\dist');
    expect(builder).toContain('node_modules\\canvas');
    expect(builder).toContain('build\\Release\\canvas.node');
    expect(builder).toContain('profiles\\cpu');
    expect(builder).toContain('profiles\\cuda');
    expect(builder).toContain('Portable Python runtime validation');
    expect(builder).toContain(
      "'^python-\\d+\\.\\d+\\.\\d+-amd64\\.exe$'",
    );
    expect(builder).toContain("'^python3\\.exe$'");
    expect(builder).toContain('Offline Oscar CPU runtime validation');
    expect(builder).toContain('Offline Oscar CUDA runtime validation');
    expect(builder).toContain('Remove-PythonBytecode');
    expect(builder).toContain('PYTHONDONTWRITEBYTECODE');
    expect(builder).toContain('--retries 10');
    expect(builder).toContain('--timeout 120');
    expect(builder).toContain('using the persistent build cache');
    expect(builder).toContain('Resolve-PinnedPythonWheel');
    expect(builder).toContain('8f238e24ed335ad05acf48648d0855714dfeb0ed341d1ff15d8b8cc06bd51d6a');
    expect(builder).toContain('90bffd9957b68e801db6f7781a786523e22f431738c260c42666d7f9413e3a8e');
    expect(builder).toContain('@("RECORD", "direct_url.json")');
    expect(builder).toContain('Offline Monarch Security runtime validation');
    expect(builder).toContain('payload-manifest.json');
    expect(builder).toContain('payload-version-contract.json');
    expect(builder).toContain(
      'Immutable $componentName payload changed without a version bump',
    );
    expect(builder).not.toContain('C:\\Users\\anton');
    expect(builder).not.toContain('E:\\Monarch');

    const payloadContract = JSON.parse(
      read('installer/payload-version-contract.json'),
    ) as {
      schemaVersion: number;
      runtime: { version: string; sha256: string };
      environment: { version: string; sha256: string };
    };
    expect(payloadContract.schemaVersion).toBe(1);
    expect(payloadContract.runtime.version).toBe('2026.07.7');
    expect(payloadContract.runtime.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payloadContract.environment.version).toBe(
      'backend-0.1.5-offline5',
    );
    expect(payloadContract.environment.sha256).toMatch(/^[a-f0-9]{64}$/);

    const requirements = read('oscar/requirements-runtime.txt');
    expect(requirements).toContain('fastapi==');
    expect(requirements).toContain('uvicorn[standard]==');
    expect(requirements).not.toContain('torch');
    expect(requirements).not.toContain('transformers');
    expect(requirements).not.toContain('triton');
    const runtimeLock = read('oscar/requirements-runtime-lock.txt');
    expect(runtimeLock).toContain('certifi==2026.7.22');
    expect(runtimeLock).toContain('starlette==1.3.1');
    expect(runtimeLock).toContain('websockets==16.1.1');
    expect(runtimeLock).not.toContain('torch');

    const finalizer = read('installer/finalize-offline-install.ps1');
    expect(finalizer).toContain('installationMode = "offline"');
    expect(finalizer).toContain('internetRequired = $false');
    expect(finalizer).toContain('Assert-TreeRecord');
    expect(finalizer).toContain('Publish-ImmutableComponent');
    expect(finalizer).toContain('PYTHONDONTWRITEBYTECODE');
    expect(finalizer).toContain('Installed Monarch full module activation');
    expect(finalizer).toContain('$env:MONARCH_RUNTIME_ROOT = $runtimeRoot');
    expect(finalizer).toContain('$env:OSCAR_WORKSPACE_ROOT = [string]$layout.workspaceRoot');
    expect(finalizer).toContain('$env:OSCAR_PYTHON = $packagedPython');
    expect(finalizer).not.toContain('winget.exe');
    expect(finalizer).not.toContain('npm.cmd');
    expect(finalizer).not.toMatch(/-m\s+pip\s+install/i);
  });

  it('keeps every installer entrypoint on one default version contract', () => {
    const packageVersion = JSON.parse(read('package.json')).version as string;
    const payloadContract = JSON.parse(
      read('installer/payload-version-contract.json'),
    ) as {
      runtime: { version: string };
      environment: { version: string };
    };
    for (const scriptPath of [
      'installer/bootstrap.ps1',
      'installer/build-installer.ps1',
      'installer/build-offline-payload.ps1',
      'installer/finalize-offline-install.ps1',
    ]) {
      const script = read(scriptPath);
      expect(script, scriptPath).toContain(
        `[string]$AppVersion = "${packageVersion}"`,
      );
      expect(script, scriptPath).toContain(
        `[string]$RuntimeVersion = "${payloadContract.runtime.version}"`,
      );
      expect(script, scriptPath).toContain(
        `[string]$BackendEnvironment = "${payloadContract.environment.version}"`,
      );
    }
    const definition = read('installer/Monarch.iss');
    expect(definition).toContain(`#define AppVersion "${packageVersion}"`);
    expect(definition).toContain(
      `#define RuntimeVersion "${payloadContract.runtime.version}"`,
    );
    expect(definition).toContain(
      `#define BackendEnvironment "${payloadContract.environment.version}"`,
    );
  });

  it('installs llama.cpp from a published Windows wheel instead of compiling it locally', () => {
    const oscarInstaller = read('oscar/scripts/install.ps1');
    expect(oscarInstaller).toContain('.requirements-installer.tmp');
    expect(oscarInstaller).toContain(
      'https://abetlen.github.io/llama-cpp-python/whl/cpu',
    );
    expect(oscarInstaller).toContain(
      'https://abetlen.github.io/llama-cpp-python/whl/cu125',
    );
    expect(oscarInstaller).toContain('--only-binary llama-cpp-python');
    expect(oscarInstaller).not.toContain(
      '& $VenvPython -m pip install -r requirements.txt',
    );
    expect(oscarInstaller).toContain('MONARCH_CONFIG_ROOT');

    const oscarConfig = read('oscar/backend/oscar_agent/config.py');
    expect(oscarConfig).toContain('SETTINGS_ENV_FILE');
    expect(oscarConfig).toContain('MONARCH_CONFIG_ROOT');
  });

  it('keeps private collaboration history outside the public snapshot', () => {
    const exporter = read('scripts/export-public.ps1');
    const policy = read('scripts/public-source-policy.ps1');
    expect(exporter).toContain("public-source-policy.ps1");
    for (const privatePath of [
      'AI_HANDOFF|agent_notes|ORIGINAL_REQUEST',
      '^\\.agents($|/)',
      '^\\.codex($|/)',
      '^scratch($|/)',
      '^artifacts/qa($|/)',
      '^artifacts/audits($|/)',
      '^artifacts/studio/qa($|/)',
      '^docs/(?:[^/]+/)*qa($|/)',
      '^docs/(?:[^/]+/)*audit($|/)',
      '^docs/OSCAR_AGENT_RUNTIME_QA_[^/]+\\.md',
    ]) {
      expect(policy).toContain(privatePath);
    }
    expect(policy).toContain('PRIVATE KEY');
    expect(policy).toContain('github_pat_');
    expect(policy).not.toContain('MonarchPublicAllowedFixtureContent');
    expect(policy).not.toContain('Remove-MonarchAllowedFixtureContent');
    expect(exporter).toContain('New-MonarchPublicSnapshotPlan');
    expect(exporter).toContain('Test-MonarchPublicSnapshot');
  });

  it('uses one fail-closed allow boundary and scans every relevant text source', () => {
    const exporter = read('scripts/export-public.ps1');
    const dryRun = read('scripts/upload-dry-run.ps1');
    const policy = read('scripts/public-source-policy.ps1');
    const evaluated = evaluatePublicSourcePolicy();

    expect(evaluated).toMatchObject({
      knownSource: true,
      knownRoot: true,
      unknownDirectory: false,
      unknownRoot: false,
      wrongCaseDirectory: false,
      wrongCaseRoot: false,
      unknownBinary: false,
      showcase: false,
      orphanScript: false,
      reviewedBinary: true,
      reviewedBinaryHash: true,
      alteredReviewedBinaryHash: false,
      reviewedBinaryCount: 39,
      reviewedBinaryFailures: 0,
      reviewedBinaryOverLimit: 0,
      csharpText: true,
      svgText: true,
      mermaidText: true,
      envExampleText: true,
      npmrcText: true,
      gitignoreText: true,
      ignoreText: true,
      licenseText: true,
      binaryAssetText: false,
      awsDetected: true,
      projectKeyDetected: true,
    });
    expect(policy).toContain('Test-MonarchPublicCandidatePath');
    expect(policy).toContain('Test-MonarchPublicTextSource');
    expect(policy).toContain('Test-MonarchPublicReviewedBinaryContent');
    for (const script of [exporter, dryRun]) {
      expect(script).toContain('New-MonarchPublicSnapshotPlan');
      expect(script).toContain('Test-MonarchPublicSnapshot');
    }
    expect(exporter).toContain('Write-MonarchGitBlobToFile');
    expect(exporter).toContain('Write-MonarchExclusiveSnapshotMetadata');
    expect(exporter).not.toContain('[System.IO.File]::WriteAllText');
    for (const excludedPath of [
      '^showcase($|/)',
      '^remove-(?:artifacts|memory|profile|workspace)\\.js$',
      '^remove-workspace-smoke\\.cjs$',
    ]) {
      expect(policy).toContain(excludedPath);
    }
    expect(policy).toContain('$MonarchPublicAllowedTopLevelDirectories');
    expect(policy).toContain('$MonarchPublicAllowedRootFiles');
    expect(policy).toContain('\\bAKIA[0-9A-Z]{16}\\b');
    expect(policy).toContain('\\bglpat-');
    expect(policy).toContain('\\bhf_');
    expect(policy).toContain('\\bnpm_');
    expect(policy).toContain("\\bsk-[A-Za-z0-9_-]{20,}\\b");
    expect(policy).toContain('ls-tree -r -z --full-tree');
    expect(policy).toContain('Git tree contains a path that is not strict UTF-8');
    expect(policy).toContain('NUL bytes are forbidden in public text source');
    expect(policy).toContain('Hardlinked files are forbidden');
    expect(policy).toContain('Alternate data streams are forbidden');
    expect(policy).toContain('GIT_NO_REPLACE_OBJECTS');
    expect(policy).toContain('--no-replace-objects');
    expect(policy).toContain('Stop-MonarchProcessTree');
    expect(policy).toContain('taskkill.exe');
    expect(policy).toContain('Public Git blob exceeds preflight file limit');
    expect(policy).toContain('Git blob exceeded its preflight length while streaming');
    expect(policy).toContain('fresh unrelated history');
    expect(policy).toContain('rev-parse --absolute-git-dir');
    expect(policy).toContain('$MonarchPublicFileFlagOpenReparsePoint');
    expect(policy).toContain('Public boundary file identity changed while held');
    expect(policy).toContain('Assert-MonarchPublicStructureRegistry');
    expect(policy).toContain('Locked public zone changed without registry review');
    expect(policy).toContain('Registered public addition object differs from review');
    expect(read('scripts/public-source-structure.json')).toContain(
      '"basePathDigest"',
    );
    expect(exporter).toContain('Destination already exists');
    expect(exporter).toContain('[System.IO.Directory]::Move');
    expect(exporter).toContain('Automatic recursive cleanup is intentionally disabled');
    expect(exporter).not.toContain('Remove-Item -LiteralPath $stagingPath -Recurse');
    expect(exporter).not.toContain('-Force and the snapshot marker');
    expect(dryRun).not.toContain('$LASTEXITCODE');
  }, 30_000);

  it('exports and validates only exact pinned Git-object bytes in a fresh snapshot', () => {
    const fixture = createPublicationFixture();
    try {
      writeFileSync(
        path.join(fixture.repo, 'src', 'main.ts'),
        'export const dirtyWorkingValue = 999;\n',
        'utf8',
      );
      const revision = exportFixture(fixture);
      expect(readFileSync(
        path.join(fixture.snapshot, 'src', 'main.ts'),
        'utf8',
      )).toBe('export const committedValue = 1;\n');
      expect(readFileSync(
        path.join(fixture.snapshot, 'src', 'данные-測試.ts'),
        'utf8',
      )).toBe('export const unicodePath = true;\n');
      expect(existsSync(path.join(fixture.snapshot, '.git'))).toBe(false);

      const markerPath = path.join(
        fixture.snapshot,
        '.monarch-public-snapshot',
      );
      const markerBefore = readFileSync(markerPath, 'utf8');
      const manifest = JSON.parse(markerBefore) as {
        schemaVersion: number;
        historyBoundary: string;
        sourceRevision: string;
        policyDigest: string;
        totalFiles: number;
        files: Array<{
          path: string;
          mode: string;
          size: number;
          sha256: string;
        }>;
      };
      expect(manifest).toMatchObject({
        schemaVersion: 2,
        historyBoundary: 'fresh-unrelated',
        sourceRevision: revision,
      });
      expect(manifest.policyDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.totalFiles).toBe(manifest.files.length);
      expect(manifest.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'src/main.ts',
            mode: '100644',
            size: 33,
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        ]),
      );

      const dryRun = runPublicationScript(
        fixture,
        'upload-dry-run.ps1',
        [
          '-Snapshot',
          fixture.snapshot,
          '-SourceRevision',
          revision,
          '-Json',
        ],
      );
      expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
      expect(JSON.parse(dryRun.stdout)).toMatchObject({
        sourceRevision: revision,
        files: manifest.totalFiles,
        violations: 0,
      });

      const replacement = runPublicationScript(
        fixture,
        'export-public.ps1',
        ['-Destination', fixture.snapshot, '-SourceRevision', revision],
      );
      expect(replacement.status).not.toBe(0);
      expect(`${replacement.stdout}\n${replacement.stderr}`).toContain(
        'Destination already exists',
      );
      expect(readFileSync(markerPath, 'utf8')).toBe(markerBefore);

      writeFileSync(
        path.join(fixture.snapshot, 'src', 'extra.ts'),
        'export const extra = true;\n',
        'utf8',
      );
      const extraGate = runPublicationScript(
        fixture,
        'upload-dry-run.ps1',
        [
          '-Snapshot',
          fixture.snapshot,
          '-SourceRevision',
          revision,
          '-Json',
        ],
      );
      expect(extraGate.status).toBe(2);
      expect(JSON.parse(extraGate.stdout)).toMatchObject({
        violations: 1,
        reason: expect.stringContaining('unexpected file'),
      });
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it('ignores Git replace refs and repository-shaping GIT environment variables', () => {
    const fixture = createPublicationFixture();
    try {
      const original = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      writeFileSync(
        path.join(fixture.repo, 'src', 'main.ts'),
        'export const replacementValue = 2;\n',
        'utf8',
      );
      runGit(fixture.repo, ['add', 'src/main.ts']);
      runGit(fixture.repo, ['commit', '--quiet', '-m', 'replacement']);
      const replacement = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      runGit(fixture.repo, ['replace', original, replacement]);

      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(fixture.repo, 'scripts', 'export-public.ps1'),
          '-Destination',
          fixture.snapshot,
          '-SourceRevision',
          original,
        ],
        {
          cwd: fixture.repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_REPLACE_REF_BASE: 'refs/replace/',
            GIT_DIR: path.join(fixture.fixtureRoot, 'missing.git'),
            GIT_WORK_TREE: path.join(fixture.fixtureRoot, 'wrong-worktree'),
          },
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(
        path.join(fixture.snapshot, 'src', 'main.ts'),
        'utf8',
      )).toBe('export const committedValue = 1;\n');
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects raw secret fixtures, NUL text, and non-regular Git modes', () => {
    const fixture = createPublicationFixture();
    try {
      const token = ['github', 'pat', '1234567890abcdef1234'].join('_');
      writeFileSync(
        path.join(fixture.repo, 'src', 'main.ts'),
        `export const leaked = '${token}';\n`,
        'utf8',
      );
      runGit(fixture.repo, ['add', 'src/main.ts']);
      runGit(fixture.repo, ['commit', '--quiet', '-m', 'secret fixture']);
      let revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      let rejected = runPublicationScript(
        fixture,
        'export-public.ps1',
        ['-Destination', fixture.snapshot, '-SourceRevision', revision],
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'forbidden content pattern',
      );
      expect(existsSync(fixture.snapshot)).toBe(false);
      expect(readdirSync(fixture.fixtureRoot).some(
        (entry) => entry.startsWith('fresh-public-snapshot.staging-'),
      )).toBe(false);

      const projectKey = ['sk', 'proj', 'x'.repeat(32)].join('-');
      writeFileSync(
        path.join(fixture.repo, 'src', 'main.ts'),
        `export const leakedProjectKey = '${projectKey}';\n`,
        'utf8',
      );
      runGit(fixture.repo, ['add', 'src/main.ts']);
      runGit(fixture.repo, ['commit', '--quiet', '-m', 'project key fixture']);
      revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      rejected = runPublicationScript(
        fixture,
        'export-public.ps1',
        ['-Destination', fixture.snapshot, '-SourceRevision', revision],
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'forbidden content pattern',
      );
      expect(existsSync(fixture.snapshot)).toBe(false);
      expect(readdirSync(fixture.fixtureRoot).some(
        (entry) => entry.startsWith('fresh-public-snapshot.staging-'),
      )).toBe(false);

      writeFileSync(
        path.join(fixture.repo, 'src', 'main.ts'),
        Buffer.from([0x65, 0x78, 0x70, 0x00, 0x6f, 0x72, 0x74]),
      );
      runGit(fixture.repo, ['add', 'src/main.ts']);
      runGit(fixture.repo, ['commit', '--quiet', '-m', 'NUL fixture']);
      revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      rejected = runPublicationScript(
        fixture,
        'export-public.ps1',
        ['-Destination', fixture.snapshot, '-SourceRevision', revision],
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'NUL bytes are forbidden',
      );
      expect(existsSync(fixture.snapshot)).toBe(false);

      runGit(fixture.repo, ['rm', '--quiet', 'src/main.ts']);
      const linkObject = runGit(
        fixture.repo,
        ['hash-object', '-w', '--stdin'],
        'outside-target',
      ).trim();
      runGit(fixture.repo, [
        'update-index',
        '--add',
        '--cacheinfo',
        `120000,${linkObject},src/main.ts`,
      ]);
      runGit(fixture.repo, ['commit', '--quiet', '-m', 'symlink fixture']);
      revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      rejected = runPublicationScript(
        fixture,
        'export-public.ps1',
        ['-Destination', fixture.snapshot, '-SourceRevision', revision],
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'not a regular Git blob',
      );
      expect(existsSync(fixture.snapshot)).toBe(false);
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('blocks unreviewed future files in operational nested zones', () => {
    const fixture = createPublicationFixture();
    try {
      writeFileSync(
        path.join(fixture.repo, 'scripts', 'future-local-operation.ps1'),
        "Write-Output 'local only'\n",
        'utf8',
      );
      runGit(fixture.repo, ['add', 'scripts/future-local-operation.ps1']);
      runGit(fixture.repo, [
        'commit',
        '--quiet',
        '-m',
        'unreviewed operational file',
      ]);
      const revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      const rejected = runPublicationScript(
        fixture,
        'export-public.ps1',
        ['-Destination', fixture.snapshot, '-SourceRevision', revision],
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'Locked public zone changed without registry review: scripts',
      );
      expect(existsSync(fixture.snapshot)).toBe(false);
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('never normalizes a literal Git backslash into a reviewed Windows path', () => {
    const fixture = createPublicationFixture();
    try {
      const head = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      const objectId = (pathSpec: string) => runGit(
        fixture.repo,
        ['rev-parse', `${head}:${pathSpec}`],
      ).trim();
      const makeTree = (
        entries: Array<{
          mode: string;
          type: 'blob' | 'tree';
          objectId: string;
          name: string;
        }>,
      ) => runGitBytes(
        fixture.repo,
        ['mktree', '-z'],
        Buffer.concat(entries.map((entry) => Buffer.from(
          `${entry.mode} ${entry.type} ${entry.objectId}\t${entry.name}\0`,
          'utf8',
        ))),
      ).toString('utf8').trim();

      const unicodeOnlySrcTree = makeTree([{
        mode: '100644',
        type: 'blob',
        objectId: objectId('src/данные-測試.ts'),
        name: 'данные-測試.ts',
      }]);
      const maliciousRootTree = makeTree([
        {
          mode: '100644',
          type: 'blob',
          objectId: objectId('.gitattributes'),
          name: '.gitattributes',
        },
        {
          mode: '100644',
          type: 'blob',
          objectId: objectId('package.json'),
          name: 'package.json',
        },
        {
          mode: '040000',
          type: 'tree',
          objectId: objectId('scripts'),
          name: 'scripts',
        },
        {
          mode: '040000',
          type: 'tree',
          objectId: unicodeOnlySrcTree,
          name: 'src',
        },
        {
          mode: '100644',
          type: 'blob',
          objectId: objectId('src/main.ts'),
          name: 'src\\main.ts',
        },
      ]);
      const maliciousCommit = runGit(
        fixture.repo,
        ['commit-tree', maliciousRootTree, '-p', head, '-m', 'literal backslash'],
      ).trim();
      const rejected = runPublicationScript(
        fixture,
        'export-public.ps1',
        ['-Destination', fixture.snapshot, '-SourceRevision', maliciousCommit],
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'Locked public zone changed without registry review: src',
      );
      expect(existsSync(fixture.snapshot)).toBe(false);
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it('blocks every unreviewed new public path, including src and sensitive-looking names', () => {
    const fixture = createPublicationFixture();
    try {
      writeFileSync(
        path.join(fixture.repo, 'src', 'future-feature.ts'),
        'export const futureFeature = true;\n',
        'utf8',
      );
      runGit(fixture.repo, ['add', 'src/future-feature.ts']);
      runGit(fixture.repo, ['commit', '--quiet', '-m', 'unreviewed src file']);
      let revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      let rejected = runPublicationScript(
        fixture,
        'export-public.ps1',
        ['-Destination', fixture.snapshot, '-SourceRevision', revision],
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'Locked public zone changed without registry review: src',
      );

      writeFileSync(
        path.join(fixture.repo, 'src', 'credential-backup.ts'),
        'export const harmlessLookingValue = true;\n',
        'utf8',
      );
      runGit(fixture.repo, ['add', 'src/credential-backup.ts']);
      runGit(fixture.repo, ['commit', '--quiet', '-m', 'sensitive name']);
      revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      rejected = runPublicationScript(
        fixture,
        'export-public.ps1',
        ['-Destination', fixture.snapshot, '-SourceRevision', revision],
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'sensitive-looking source name',
      );
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it('preflights oversized blobs before creating staging or destination', () => {
    const fixture = createPublicationFixture();
    try {
      const revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      const rejected = runPublicationScript(
        fixture,
        'export-public.ps1',
        [
          '-Destination',
          fixture.snapshot,
          '-SourceRevision',
          revision,
          '-MaxSourceBytes',
          '16',
        ],
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
        'Public Git blob exceeds preflight file limit',
      );
      expect(existsSync(fixture.snapshot)).toBe(false);
      expect(readdirSync(fixture.fixtureRoot).some(
        (entry) => entry.startsWith('fresh-public-snapshot.staging-'),
      )).toBe(false);
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects public destinations inside worktree metadata and bare object databases', () => {
    const fixture = createPublicationFixture();
    try {
      const revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      const siblingRepo = path.join(fixture.fixtureRoot, 'unrelated-worktree');
      runGit(fixture.fixtureRoot, ['init', '--quiet', siblingRepo]);
      const metadataParent = path.join(
        siblingRepo,
        '.git',
        'objects',
        'public-target',
      );
      mkdirSync(metadataParent, { recursive: true });
      const worktreeMetadataResult = runPublicationScript(
        fixture,
        'export-public.ps1',
        [
          '-Destination',
          path.join(metadataParent, 'snapshot'),
          '-SourceRevision',
          revision,
        ],
      );
      expect(worktreeMetadataResult.status).not.toBe(0);
      expect(`${worktreeMetadataResult.stdout}\n${worktreeMetadataResult.stderr}`).toContain(
        'fresh unrelated history',
      );

      const bareRepo = path.join(fixture.fixtureRoot, 'archive.git');
      runGit(fixture.fixtureRoot, ['init', '--quiet', '--bare', bareRepo]);
      const bareParent = path.join(bareRepo, 'objects', 'public-target');
      mkdirSync(bareParent, { recursive: true });
      const bareMetadataResult = runPublicationScript(
        fixture,
        'export-public.ps1',
        [
          '-Destination',
          path.join(bareParent, 'snapshot'),
          '-SourceRevision',
          revision,
        ],
      );
      expect(bareMetadataResult.status).not.toBe(0);
      expect(`${bareMetadataResult.stdout}\n${bareMetadataResult.stderr}`).toContain(
        'fresh unrelated history',
      );
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when destination appears during export and preserves staging', async () => {
    const fixture = createPublicationFixture();
    try {
      const revision = runGit(fixture.repo, ['rev-parse', 'HEAD']).trim();
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(fixture.repo, 'scripts', 'export-public.ps1'),
          '-Destination',
          fixture.snapshot,
          '-SourceRevision',
          revision,
        ],
        { cwd: fixture.repo, encoding: 'utf8' },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 15_000;
      let stagingName: string | undefined;
      while (Date.now() < deadline) {
        stagingName = readdirSync(fixture.fixtureRoot).find(
          (entry) => entry.startsWith('fresh-public-snapshot.staging-'),
        );
        if (stagingName) break;
        Atomics.wait(waitBuffer, 0, 0, 20);
      }
      expect(stagingName).toBeDefined();
      mkdirSync(fixture.snapshot);

      const status = await new Promise<number | null>((resolve) => {
        child.once('close', resolve);
      });
      expect(status).not.toBe(0);
      expect(`${stdout}\n${stderr}`).toContain(
        'Destination appeared during export',
      );
      expect(existsSync(path.join(
        fixture.fixtureRoot,
        stagingName!,
        '.monarch-public-snapshot',
      ))).toBe(true);
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects snapshot ADS, hardlinks, and reparse ancestors', () => {
    const fixture = createPublicationFixture();
    try {
      const revision = exportFixture(fixture);
      const mainPath = path.join(fixture.snapshot, 'src', 'main.ts');
      writeFileSync(`${mainPath}:private`, 'not-public', 'utf8');
      let rejected = runPublicationScript(
        fixture,
        'upload-dry-run.ps1',
        [
          '-Snapshot',
          fixture.snapshot,
          '-SourceRevision',
          revision,
          '-Json',
        ],
      );
      expect(rejected.status).toBe(2);
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        reason: expect.stringContaining('Alternate data streams'),
      });
      rmSync(`${mainPath}:private`, { force: true });

      writeFileSync(`${fixture.snapshot}:private`, 'directory-metadata', 'utf8');
      rejected = runPublicationScript(
        fixture,
        'upload-dry-run.ps1',
        [
          '-Snapshot',
          fixture.snapshot,
          '-SourceRevision',
          revision,
          '-Json',
        ],
      );
      expect(rejected.status).toBe(2);
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        reason: expect.stringContaining('Alternate data streams'),
      });
      rmSync(`${fixture.snapshot}:private`, { force: true });

      const backupPath = path.join(fixture.fixtureRoot, 'main-backup.ts');
      renameSync(mainPath, backupPath);
      linkSync(backupPath, mainPath);
      rejected = runPublicationScript(
        fixture,
        'upload-dry-run.ps1',
        [
          '-Snapshot',
          fixture.snapshot,
          '-SourceRevision',
          revision,
          '-Json',
        ],
      );
      expect(rejected.status).toBe(2);
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        reason: expect.stringContaining('linked/reparse entry'),
      });

      const realParent = path.join(fixture.fixtureRoot, 'real-parent');
      const junctionParent = path.join(fixture.fixtureRoot, 'junction-parent');
      mkdirSync(realParent);
      symlinkSync(realParent, junctionParent, 'junction');
      const reparseExport = runPublicationScript(
        fixture,
        'export-public.ps1',
        [
          '-Destination',
          path.join(junctionParent, 'new-snapshot'),
          '-SourceRevision',
          revision,
        ],
      );
      expect(reparseExport.status).not.toBe(0);
      expect(`${reparseExport.stdout}\n${reparseExport.stderr}`).toContain(
        'Reparse points are forbidden',
      );
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('builds a modern self-contained Windows setup without model downloads', () => {
    const definition = read('installer/Monarch.iss');
    const packageVersion = JSON.parse(read('package.json')).version as string;
    expect(definition).toContain(`#define AppVersion "${packageVersion}"`);
    expect(definition).toContain('#define RuntimeVersion "2026.07.7"');
    expect(definition).toContain('WizardStyle=modern');
    expect(definition).toContain('PrivilegesRequired=lowest');
    expect(definition).toContain('ArchitecturesInstallIn64BitMode=x64compatible');
    expect(definition).toContain('installer\\offline-payload\\app\\*');
    expect(definition).toContain('installer\\offline-payload\\runtime\\*');
    expect(definition).toContain('installer\\offline-payload\\environment\\*');
    expect(definition).toContain('payload-manifest.json');
    expect(definition).toContain('E:\\Programs\\Monarch');
    expect(definition).toContain('D:\\Programs\\Monarch');
    expect(definition).toContain("GetFinalizeParameters('')");
    expect(definition).not.toContain('GetBootstrapParameters');
    expect(definition).not.toContain('WizardIsTaskSelected');
    expect(definition).not.toContain('InstallSmallModel');
    expect(definition).not.toContain('InstallVoiceStt');
    expect(definition).not.toContain('InstallVoiceTts');
    expect(definition.match(/Filename: "\{sys\}\\WindowsPowerShell/g)).toBeNull();
    expect(definition).toContain('function RunCriticalStep');
    expect(definition).toContain('procedure FinalizeOfflinePayload');
    expect(definition).not.toContain('procedure CurStepChanged');
    expect(definition).toContain('function GetCustomSetupExitCode');
    expect(definition).toContain('CriticalExitCode := 20');
    expect(definition).toContain('CriticalExitCode := 21');
    expect(definition.match(/Check: CriticalInstallSucceeded/g)).toHaveLength(3);
    expect(definition.match(/RaiseException\(/g)).toHaveLength(2);
    expect(definition).toContain('AfterInstall: FinalizeOfflinePayload');
    expect(definition).toContain('Monarch.next.exe');
    expect(definition).toContain('GetLauncherSwapParameters');
    expect(definition).toContain('-LauncherVersion "1.0.3"');
    expect(definition).toContain('versions\\{#AppVersion}');
    expect(definition).toContain('CloseApplications=no');
    expect(read('tools/launcher/MonarchLauncher.cs')).toContain(
      'private const string LauncherVersion = "1.0.3"',
    );
    expect(read('installer/layout.ps1')).toContain(
      'candidateLauncherVersion = "1.0.3"',
    );
    expect(read('installer/layout.ps1')).toContain(
      'minimumLauncherVersion = "1.0.3"',
    );
    expect(read('installer/layout.ps1')).toContain(
      'Remove-MonarchLegacyVersionJunction',
    );
    expect(read('installer/layout.ps1')).not.toContain(
      'New-Item -ItemType Junction',
    );
    expect(read('installer/swap-launcher.ps1')).toContain(
      '[string]$LauncherVersion = "1.0.3"',
    );
    expect(read('installer/swap-launcher.ps1')).toContain('-Argument "--verify-install"');
    expect(read('installer/swap-launcher.ps1')).toContain('"install-health.json"');
    expect(read('tools/launcher/MonarchLauncher.cs')).toContain(
      'var verifyInstall = HasArgument(args, "--verify-install")',
    );
  });

  it('refuses to package private development history', () => {
    const builder = read('installer/build-installer.ps1');
    expect(builder).toContain('Test-PrivateSource');
    expect(builder).toContain('Refusing to package an unfiltered source tree');
    expect(builder).toContain('scripts\\export-public.ps1');
    expect(builder).toContain('.monarch-public-snapshot');
    expect(builder).not.toContain('$LASTEXITCODE -ne 0) {\n    throw "Could not create a clean installer source snapshot.');
    expect(builder).not.toMatch(
      /Remove-Item\s+-LiteralPath\s+\$resolved\s+-Recurse/i,
    );
    expect(builder).not.toMatch(
      /Remove-Item\s+-LiteralPath\s+\$frontendDist\s+-Recurse/i,
    );
    expect(builder).toContain(
      'Fresh installer source unexpectedly contains frontend build output',
    );
    expect(builder).toContain(
      'Fresh installer source unexpectedly contains offline payload output',
    );
    expect(builder).not.toMatch(
      /-BackendEnvironment\s+\$BackendEnvironment\s+`\r?\n\s*-Force/,
    );
    expect(builder).toContain(
      'Temporary installer source was preserved for explicit inspection and cleanup',
    );
    expect(builder).toContain('scripts\\build-runtime-bundle.mjs');
    expect(builder).toContain('dist\\monarch-server.mjs');
    expect(builder).toContain('build-offline-payload.ps1');

    const dryRun = read('scripts/upload-dry-run.ps1');
    const policy = read('scripts/public-source-policy.ps1');
    expect(dryRun).toContain('public-source-policy.ps1');
    expect(policy).toContain('^installer/out($|[-/])');
    expect(policy).toContain('^installer/offline-payload($|/)');
    expect(policy).toContain('^scratch($|/)');
    expect(policy).toContain('^artifacts/qa($|/)');
    expect(policy).toContain('^AGENTS\\.md$');
    expect(policy).toContain('MonarchPublicForbiddenContentPatterns');
    expect(policy).not.toContain('MonarchPublicAllowedFixtureContent');
    expect(policy).toContain('PRIVATE KEY');
    expect(dryRun).toContain("[string] $Snapshot = ''");
    expect(dryRun).toContain('Monarch-public-gate-');
    expect(dryRun).toContain('Test-MonarchPublicSnapshot');
    expect(dryRun).not.toContain('git -C $root.Path ls-files');
  });

  it('builds the installer runtime on GitHub before Inno Setup packages it', () => {
    const workflow = read('.github/workflows/windows-installer.yml');
    expect(workflow).toContain('actions/setup-node@v7');
    expect(workflow).toContain('node-version-file: .node-version');
    expect(workflow).toContain('npm ci --no-audit --no-fund');
  });

  it('ships a portable Oscar environment template', () => {
    const envExample = read('oscar/.env.example');
    expect(envExample).not.toContain('E:\\Monarch');
    expect(envExample).not.toContain('C:\\Users\\');
    expect(envExample).toContain('OSCAR_PORT=7861');
  });
});
