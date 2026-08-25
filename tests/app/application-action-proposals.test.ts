import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app';
import { AGENT_APPROVAL_SCHEMA_VERSION, InMemoryAgentTaskStore } from '../../src/agent';
import type { MonarchExecutionResult, MonarchModule } from '../../src/core';
import { createDeterministicSecurityModule } from '../fixtures/agent/deterministic-security-module';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MonarchApplication typed action proposals', () => {
  it('rejects text tokens and binds execution to the exact durable approval proposal', async () => {
    const { app, store } = await createApp();
    try {
      const prepared = await app.submitActionProposal({
        proposal: proposal('intent-exact', 'notes/exact.txt', 'exact'),
        originatingUserText: 'Создай точный файл',
        requestedBy: 'ui:oscar:model-proposal',
      });
      expect(prepared.result.error).toBe('confirmation-required');
      expect(prepared.confirmation).toBeUndefined();
      await expect(app.submitActionProposal({
        proposal: prepared.proposal,
        originatingUserText: 'Создай точный файл',
        requestedBy: 'ui:oscar:model-proposal',
        confirmed: true,
        confirmationToken: 'подтверждаю',
      })).rejects.toMatchObject({ code: 'legacy-text-confirmation-disabled' });
      const seeded = await seedApprovedBinding(app, store, prepared.proposal, 'Создай точный файл');
      await expect(app.submitActionProposal({
        proposal: { ...prepared.proposal, args: { path: 'notes/tampered.txt', content: 'tampered', overwrite: false } },
        originatingUserText: 'Создай точный файл',
        requestedBy: 'agent:test',
        confirmed: true,
        source: 'api',
        executionMode: 'agent-runtime',
        agentApprovalBinding: seeded.binding,
      })).rejects.toMatchObject({ code: 'agent-approval-binding-mismatch' });
    } finally {
      await app.stop().catch(() => undefined);
    }
  }, 60_000);

  it('uses one task grant for later reversible steps with the same host task intent', async () => {
    const { app, root, store } = await createApp();
    const userText = 'Создай два файла одной задачей';
    try {
      const firstProposal = proposal('intent-plan', 'notes/a.txt', 'a');
      const prepared = await app.submitActionProposal({
        proposal: firstProposal,
        originatingUserText: userText,
        requestedBy: 'ui:oscar:model-proposal',
      });
      expect(prepared.result.error).toBe('confirmation-required');
      const granted = await executeDurablyApprovedProposal(app, store, prepared.proposal, userText, 'task');
      expect(granted.result.ok).toBe(true);
      expect(granted.lease?.status).toBe('active');

      const second = await app.submitActionProposal({
        proposal: proposal('intent-plan', 'notes/b.txt', 'b'),
        originatingUserText: userText,
        requestedBy: 'agent:test',
        source: 'api',
        executionMode: 'agent-runtime',
        leaseId: granted.lease!.leaseId,
      });
      expect(second.result.ok).toBe(true);
      expect(second.result.metadata?.leaseId).toBe(granted.lease!.leaseId);
      await expect(readFile(path.join(root, 'notes', 'a.txt'), 'utf8')).resolves.toBe('a');
      await expect(readFile(path.join(root, 'notes', 'b.txt'), 'utf8')).resolves.toBe('b');
    } finally {
      await app.stop().catch(() => undefined);
    }
  }, 60_000);

  it('rolls back journaled writes and refuses to overwrite later user changes', async () => {
    const { app, root, store } = await createApp();
    try {
      const first = await executeDurablyApprovedProposal(app, store, proposal('intent-rollback-a', 'notes/rollback-a.txt', 'created'), 'Создай rollback-a', 'once');
      const firstLedgerId = String((first.result.metadata?.ledger as { ledgerId?: string } | undefined)?.ledgerId || '');
      expect(first.result.metadata?.ledger).toMatchObject({ rollback: { status: 'available' } });
      await expect(app.rollbackAction(firstLedgerId)).resolves.toMatchObject({ status: 'rolled-back' });
      await expect(readFile(path.join(root, 'notes', 'rollback-a.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const second = await executeDurablyApprovedProposal(app, store, proposal('intent-rollback-b', 'notes/rollback-b.txt', 'created'), 'Создай rollback-b', 'once');
      const secondLedgerId = String((second.result.metadata?.ledger as { ledgerId?: string } | undefined)?.ledgerId || '');
      await writeFile(path.join(root, 'notes', 'rollback-b.txt'), 'user changed it', 'utf8');
      await expect(app.rollbackAction(secondLedgerId)).resolves.toMatchObject({
        status: 'blocked',
        reason: expect.stringContaining('changed after the action'),
      });
      await expect(readFile(path.join(root, 'notes', 'rollback-b.txt'), 'utf8')).resolves.toBe('user changed it');
    } finally {
      await app.stop().catch(() => undefined);
    }
  }, 60_000);

  it('executes one exact Owner-confirmed advisory and invalidates it when Security evidence changes', async () => {
    const security = createOwnerConfirmableSecurityModule();
    const { app, root, store } = await createApp(ownerAuthority(), security.module);
    const target = path.join(root, 'notes', 'owner-delete.txt');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'synthetic owner fixture', 'utf8');
    const userText = 'покажи содержимое notes/owner-delete.txt';
    try {
      const prepared = await app.submitActionProposal({
        proposal: deleteProposal('intent-owner-delete', 'notes/owner-delete.txt'),
        originatingUserText: userText,
        requestedBy: 'agent:test',
        source: 'desktop',
        executionMode: 'agent-runtime',
      });
      expect(prepared.result).toMatchObject({
        ok: false,
        error: 'confirmation-required',
        metadata: { securityOverride: true, policy: { authorityTier: 'owner' } },
      });
      const policyDecisionHash = String((prepared.result.metadata?.policy as { policyDecisionHash?: string }).policyDecisionHash || '');
      expect(policyDecisionHash).toMatch(/^[a-f0-9]{64}$/u);
      const seeded = await seedApprovedBinding(app, store, prepared.proposal, userText, 'once', {
        source: 'desktop',
        purpose: 'owner-security-override',
        policyDecisionHash,
        authorityTierAtRequest: 'owner',
      });
      const executed = await app.submitActionProposal({
        proposal: prepared.proposal,
        originatingUserText: userText,
        requestedBy: 'agent:test',
        confirmed: true,
        source: 'desktop',
        executionMode: 'agent-runtime',
        agentApprovalBinding: seeded.binding,
        grantScope: 'once',
      });
      expect(executed.result.ok).toBe(true);
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(target, 'changed evidence fixture', 'utf8');
      security.allow();
      const changed = await app.submitActionProposal({
        proposal: prepared.proposal,
        originatingUserText: userText,
        requestedBy: 'agent:test',
        confirmed: true,
        source: 'desktop',
        executionMode: 'agent-runtime',
        agentApprovalBinding: seeded.binding,
        grantScope: 'once',
      });
      expect(changed.result).toMatchObject({
        ok: false,
        error: 'confirmation-required',
        metadata: { policyBindingChanged: true },
      });
      await expect(readFile(target, 'utf8')).resolves.toBe('changed evidence fixture');
    } finally {
      await app.stop().catch(() => undefined);
    }
  }, 60_000);

  it('requires a same-surface arm and exact-once scope for an Owner override card', async () => {
    const security = createOwnerConfirmableSecurityModule();
    const { app, store } = await createApp(ownerAuthority(), security.module);
    const userText = 'покажи notes/owner-arm.txt';
    try {
      const prepared = await app.submitActionProposal({
        proposal: deleteProposal('intent-owner-arm', 'notes/owner-arm.txt'),
        originatingUserText: userText,
        requestedBy: 'agent:test',
        source: 'desktop',
        executionMode: 'agent-runtime',
      });
      const policyDecisionHash = String((prepared.result.metadata?.policy as { policyDecisionHash?: string }).policyDecisionHash || '');
      const pending = await seedPendingOwnerBinding(app, store, prepared.proposal, userText, policyDecisionHash);
      await expect(app.agentRuntime!.resolveApproval(pending.taskId, pending.approvalId, {
        decision: 'approve',
        actorSurface: 'desktop',
        requireArm: false,
      })).rejects.toMatchObject({ statusCode: 409, code: 'approval-arm-required' });
      await app.agentRuntime!.armApproval(pending.taskId, pending.approvalId, {
        canonicalProposalHash: prepared.proposal.canonicalHash,
        capabilityId: prepared.proposal.capabilityId,
        actorSurface: 'desktop',
      });
      await expect(app.agentRuntime!.resolveApproval(pending.taskId, pending.approvalId, {
        decision: 'approve',
        grantScope: 'task',
        actorSurface: 'desktop',
      })).rejects.toMatchObject({ statusCode: 409, code: 'approval-scope-must-be-once' });
      await expect(app.agentRuntime!.resolveApproval(pending.taskId, pending.approvalId, {
        decision: 'approve',
        grantScope: 'once',
        actorSurface: 'desktop',
      })).resolves.toMatchObject({
        task: { status: 'running' },
        approvals: [expect.objectContaining({ status: 'approved', grantScope: 'once' })],
      });
    } finally {
      await app.stop().catch(() => undefined);
    }
  }, 60_000);
});

async function createApp(
  authorityContext?: ReturnType<typeof ownerAuthority>,
  securityModule?: MonarchModule,
): Promise<{ app: MonarchApplication; root: string; store: InMemoryAgentTaskStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-proposals-'));
  roots.push(root);
  const store = new InMemoryAgentTaskStore();
  const activeSecurityModule = securityModule || createDeterministicSecurityModule();
  const app = new MonarchApplication({
    workspaceRoot: root,
    enabledModules: ['workspace'],
    enableLocalSystemRouter: false,
    enableAgentRuntimeV2: true,
    agentRuntimeAutoRun: false,
    agentTaskStore: store,
    permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request', autonomyMode: 'guided' },
    ...(authorityContext ? { authorityContext } : {}),
  });
  app.runtime.kernel.registerModule(activeSecurityModule);
  await app.start();
  return { app, root, store };
}

function proposal(intentId: string, filePath: string, content: string) {
  return {
    version: 1 as const,
    intentId,
    capabilityId: 'workspace.files.write',
    args: { path: filePath, content, overwrite: false },
    reason: 'Create one requested workspace file.',
    expectedEffect: `Create ${filePath}.`,
    preconditions: [{ kind: 'not-exists' as const, target: filePath }],
    verification: [{ kind: 'contains' as const, target: filePath, value: content }],
    provenance: { source: 'runtime-grammar' as const, model: 'unit-model', skillIds: ['unit-skill'] },
  };
}

async function executeDurablyApprovedProposal(
  app: MonarchApplication,
  store: InMemoryAgentTaskStore,
  actionProposal: ReturnType<typeof proposal> | Awaited<ReturnType<MonarchApplication['prepareActionProposal']>>,
  originatingUserText: string,
  grantScope: 'once' | 'task',
) {
  const canonical = 'canonicalHash' in actionProposal
    ? actionProposal
    : await app.prepareActionProposal({ proposal: actionProposal, originatingUserText, requestedBy: 'agent:test' });
  const seeded = await seedApprovedBinding(app, store, canonical, originatingUserText, grantScope);
  return app.submitActionProposal({
    proposal: canonical,
    originatingUserText,
    requestedBy: 'agent:test',
    confirmed: true,
    source: 'api',
    executionMode: 'agent-runtime',
    agentApprovalBinding: seeded.binding,
    grantScope,
  });
}

function deleteProposal(intentId: string, filePath: string) {
  return {
    version: 1 as const,
    intentId,
    capabilityId: 'workspace.files.delete',
    args: { path: filePath },
    reason: 'Permanently delete one exact synthetic fixture.',
    expectedEffect: `Remove ${filePath}.`,
    preconditions: [{ kind: 'exists' as const, target: filePath }],
    verification: [{ kind: 'not-exists' as const, target: filePath }],
    provenance: { source: 'runtime-grammar' as const, model: 'unit-model', skillIds: ['unit-skill'] },
  };
}

function ownerAuthority() {
  return {
    tier: 'owner' as const,
    source: 'signed-device-entitlement' as const,
    entitlementId: 'owner_action_test',
    keyId: 'owner-root-test',
    verifiedAt: new Date(0).toISOString(),
    deviceIdPrefix: '0123456789ab',
    diagnostic: null,
  };
}

function createOwnerConfirmableSecurityModule(): { module: MonarchModule; allow: () => void } {
  let confirmable = true;
  return {
    allow: () => { confirmable = false; },
    module: {
      manifest: {
        id: 'security',
        name: 'Synthetic Owner Security',
        version: '1.0.0',
        kind: 'runtime',
        description: 'Synthetic typed Security facts for Owner approval tests.',
        owns: ['synthetic security controller'],
        permissions: ['execute'],
        capabilities: [{
          id: 'security.controller.check',
          moduleId: 'security',
          title: 'Review synthetic action',
          risk: 'execute',
        }],
      },
      async activate(): Promise<void> {},
      async executeCapability(): Promise<MonarchExecutionResult> {
        return {
          ok: true,
          summary: 'Synthetic Security fact produced.',
          output: {
            payload: confirmable
              ? {
                ok: false,
                status: 'blocked',
                disposition: 'owner-confirmable',
                report: 'Synthetic bounded delete needs exact Owner confirmation.',
                evidenceCodes: ['intent.delete.mismatch'],
              }
              : {
                ok: true,
                status: 'allowed',
                disposition: 'informational',
                report: 'Synthetic exact delete is allowed.',
                evidenceCodes: ['intent.delete.match'],
              },
          },
        };
      },
    },
  };
}

async function seedPendingOwnerBinding(
  app: MonarchApplication,
  store: InMemoryAgentTaskStore,
  canonical: Awaited<ReturnType<MonarchApplication['prepareActionProposal']>>,
  userText: string,
  policyDecisionHash: string,
): Promise<{ taskId: string; approvalId: string }> {
  const created = await app.createAgentTask({
    request: userText,
    source: { surface: 'desktop' },
    autoStart: false,
  });
  const approvalId = `approval_${created.task.id}`;
  const now = new Date().toISOString();
  const policyBinding = {
    purpose: 'owner-security-override' as const,
    policyDecisionHash,
    authorityTierAtRequest: 'owner' as const,
  };
  await store.saveTask({
    ...created.task,
    status: 'waiting-for-approval',
    activeApprovalId: approvalId,
    pendingAction: {
      actionAttemptId: `attempt_${created.task.id}`,
      proposal: canonical as any,
      canonicalProposalHash: canonical.canonicalHash,
      status: 'waiting-approval',
      createdAt: now,
    },
    approvals: [{
      id: approvalId,
      taskId: created.task.id,
      status: 'pending',
      capabilityId: canonical.capabilityId,
      canonicalProposalHash: canonical.canonicalHash,
      ...policyBinding,
    }],
  }, {
    expectedCheckpointVersion: created.task.checkpointVersion,
    approvals: [{
      schemaVersion: AGENT_APPROVAL_SCHEMA_VERSION,
      id: approvalId,
      taskId: created.task.id,
      capabilityId: canonical.capabilityId,
      canonicalProposalHash: canonical.canonicalHash,
      ...policyBinding,
      proposal: canonical as any,
      status: 'pending',
      requestedAt: now,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      reason: 'Synthetic exact Owner override.',
    } as any],
    events: [{ type: 'approval.required', payload: { approvalId } }],
  });
  return { taskId: created.task.id, approvalId };
}

async function seedApprovedBinding(
  app: MonarchApplication,
  store: InMemoryAgentTaskStore,
  actionProposal: Awaited<ReturnType<MonarchApplication['prepareActionProposal']>>,
  originatingUserText: string,
  grantScope: 'once' | 'task' = 'once',
  policyBinding: {
    source?: 'api' | 'desktop';
    purpose?: 'policy' | 'owner-security-override';
    policyDecisionHash?: string;
    authorityTierAtRequest?: 'public' | 'owner';
  } = {},
) {
  const canonical = 'canonicalHash' in actionProposal
    ? actionProposal
    : await app.prepareActionProposal({ proposal: actionProposal, originatingUserText, requestedBy: 'agent:test' });
  const created = await app.createAgentTask({
    request: originatingUserText,
    source: { surface: policyBinding.source || 'api' },
    autoStart: false,
  });
  const approvalId = `approval_${created.task.id}`;
  const now = new Date().toISOString();
  const approval = {
    schemaVersion: AGENT_APPROVAL_SCHEMA_VERSION,
    id: approvalId,
    taskId: created.task.id,
    capabilityId: canonical.capabilityId,
    canonicalProposalHash: canonical.canonicalHash,
    ...(policyBinding.purpose ? { purpose: policyBinding.purpose } : {}),
    ...(policyBinding.policyDecisionHash ? { policyDecisionHash: policyBinding.policyDecisionHash } : {}),
    ...(policyBinding.authorityTierAtRequest ? { authorityTierAtRequest: policyBinding.authorityTierAtRequest } : {}),
    proposal: canonical,
    status: 'approved' as const,
    requestedAt: now,
    resolvedAt: now,
    grantScope,
    decision: { outcome: 'approved' as const, decidedAt: now, decidedBy: 'user' as const },
  };
  await store.saveTask({
    ...created.task,
    status: 'running',
    pendingAction: {
      actionAttemptId: `attempt_${created.task.id}`,
      proposal: canonical as any,
      canonicalProposalHash: canonical.canonicalHash,
      status: 'dispatched',
      createdAt: now,
      dispatchedAt: now,
    },
    approvals: [{
      id: approvalId,
      taskId: created.task.id,
      status: 'approved',
      capabilityId: canonical.capabilityId,
      canonicalProposalHash: canonical.canonicalHash,
      ...(policyBinding.purpose ? { purpose: policyBinding.purpose } : {}),
      ...(policyBinding.policyDecisionHash ? { policyDecisionHash: policyBinding.policyDecisionHash } : {}),
      ...(policyBinding.authorityTierAtRequest ? { authorityTierAtRequest: policyBinding.authorityTierAtRequest } : {}),
    }],
  }, {
    expectedCheckpointVersion: created.task.checkpointVersion,
    approvals: [approval as any],
    events: [{ type: 'approval.resolved', payload: { approvalId, decision: 'approved' } }],
  });
  return {
    canonical,
    binding: {
      taskId: created.task.id,
      approvalId,
      capabilityId: canonical.capabilityId,
      canonicalProposalHash: canonical.canonicalHash,
      ...(policyBinding.purpose ? { purpose: policyBinding.purpose } : {}),
      ...(policyBinding.policyDecisionHash ? { policyDecisionHash: policyBinding.policyDecisionHash } : {}),
      ...(policyBinding.authorityTierAtRequest ? { authorityTierAtRequest: policyBinding.authorityTierAtRequest } : {}),
    },
  };
}
