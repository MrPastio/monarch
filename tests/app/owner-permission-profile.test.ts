import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app/application';

const roots: string[] = [];
const ownerAuthority = {
  tier: 'owner' as const,
  source: 'signed-device-entitlement' as const,
  entitlementId: 'owner_profile_test',
  keyId: 'owner-root-test',
  verifiedAt: new Date(0).toISOString(),
  deviceIdPrefix: '0123456789ab',
  diagnostic: null,
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Owner permission profile migration', () => {
  it('migrates only a verified Owner stored danger-full-access + never profile to on-request', async () => {
    const ownerRoot = await seededRoot();
    const ownerApp = new MonarchApplication({
      workspaceRoot: ownerRoot,
      enabledModules: [],
      enableLocalSystemRouter: false,
      authorityContext: ownerAuthority,
    });
    expect(ownerApp.getPermissionProfile()).toEqual({
      autonomyMode: 'full-local',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'on-request',
    });
    await expect(readFile(path.join(ownerRoot, 'runtime', 'settings', 'permissions.json'), 'utf8'))
      .resolves.toContain('"schemaVersion": 2');

    const publicRoot = await seededRoot();
    const publicApp = new MonarchApplication({
      workspaceRoot: publicRoot,
      enabledModules: [],
      enableLocalSystemRouter: false,
    });
    expect(publicApp.getPermissionProfile()).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
  });
});

async function seededRoot(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), 'runtime', 'owner-profile-test-'));
  roots.push(root);
  const settings = path.join(root, 'runtime', 'settings');
  await mkdir(settings, { recursive: true });
  await writeFile(path.join(settings, 'permissions.json'), JSON.stringify({
    schemaVersion: 1,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
  }));
  return root;
}
