import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalOwnerUnrestrictedOverrideStore } from '../../src/settings';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalOwnerUnrestrictedOverrideStore', () => {
  it.each(['task', 'session', 'persistent'] as const)('persists an exact %s lifetime with shell policy', async (lifetime) => {
    const root = await temporaryRoot();
    const store = new LocalOwnerUnrestrictedOverrideStore(root);
    const receipt = await store.execute({
      schemaVersion: 1,
      clientRequestId: `owner_override_${lifetime}`,
      command: 'owner-override.update',
      scope: { type: 'chat' },
      expectedRevision: 0,
      payload: {
        enabled: true,
        lifetime,
        ...(lifetime === 'task' ? { taskId: 'agent_task_fixture_1234' } : {}),
        shellApprovalPolicy: 'risk-based',
      },
      policyDecisionHash: 'a'.repeat(64),
    });
    const context = await store.read({ schemaVersion: 1, kind: 'owner-override', scope: { type: 'chat' } });
    expect(receipt).toMatchObject({ contentHash: context.contentHash, readBackHash: context.contentHash });
    expect(context.value).toMatchObject({ enabled: true, lifetime, shellApprovalPolicy: 'risk-based' });
  });

  it('clears session state on restart but retains persistent state until manual disable', async () => {
    const root = await temporaryRoot();
    const session = new LocalOwnerUnrestrictedOverrideStore(root);
    await session.execute({
      schemaVersion: 1, clientRequestId: 'session_enable', command: 'owner-override.update',
      scope: { type: 'chat' }, expectedRevision: 0,
      payload: { enabled: true, lifetime: 'session', shellApprovalPolicy: 'never' },
      policyDecisionHash: 'b'.repeat(64),
    });
    expect(new LocalOwnerUnrestrictedOverrideStore(root).snapshot()).toMatchObject({ enabled: false, shellApprovalPolicy: 'always' });

    const persistent = new LocalOwnerUnrestrictedOverrideStore(root);
    await persistent.execute({
      schemaVersion: 1, clientRequestId: 'persistent_enable', command: 'owner-override.update',
      scope: { type: 'chat' }, expectedRevision: 2,
      payload: { enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' },
      policyDecisionHash: 'c'.repeat(64),
    });
    expect(new LocalOwnerUnrestrictedOverrideStore(root).snapshot()).toMatchObject({
      enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never',
    });
  });

  it('requires an exact task id and rejects unknown fields', async () => {
    const root = await temporaryRoot();
    const store = new LocalOwnerUnrestrictedOverrideStore(root);
    await expect(store.execute({
      schemaVersion: 1, clientRequestId: 'missing_task', command: 'owner-override.update',
      scope: { type: 'chat' }, expectedRevision: 0,
      payload: { enabled: true, lifetime: 'task', shellApprovalPolicy: 'always' },
      policyDecisionHash: 'd'.repeat(64),
    })).rejects.toThrow(/task id/i);
    await expect(store.execute({
      schemaVersion: 1, clientRequestId: 'forged_field', command: 'owner-override.update',
      scope: { type: 'chat' }, expectedRevision: 0,
      payload: { enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never', safeAccess: true },
      policyDecisionHash: 'e'.repeat(64),
    })).rejects.toThrow(/unsupported/i);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-owner-override-'));
  roots.push(root);
  return root;
}
