import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) =>
  readFile(path.join(process.cwd(), relativePath), 'utf8');

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
