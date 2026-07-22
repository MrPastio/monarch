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

  it('refreshes at 30 days and raises an urgent issue at 14 days', async () => {
    const workflow = await read('.github/workflows/refresh-stable-manifest.yml');
    expect(workflow).toContain('refreshDue');
    expect(workflow).toContain('urgent');
    expect(workflow).toContain('[P0] Stable manifest signing or refresh failed');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain("cron: '17 5 * * 1'");
  });

  it('keeps signing keys external and arms only the accepted immutable components', async () => {
    const docs = await read('release/README.md');
    const sample = await read('release/examples/stable-bootstrap.json');
    const releaseSpec = JSON.parse(await read('release/stable-release-spec.json'));
    expect(docs).toContain('No production private key or invented public key is committed');
    expect(sample).not.toContain('BEGIN PRIVATE KEY');
    expect(sample).not.toContain('BEGIN PUBLIC KEY');
    expect(releaseSpec.available).toBe(true);
    expect(releaseSpec.withdrawnReason).toBeNull();
    expect(releaseSpec.compatibility).toMatchObject({
      runtimeVersion: '2026.07.6',
      backendEnvironment: 'backend-0.1.5-offline4',
    });
    expect(JSON.stringify(releaseSpec)).not.toContain('bootstrap-pending');
  });
});
