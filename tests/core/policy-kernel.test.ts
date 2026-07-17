import { describe, expect, it } from 'vitest';
import { MonarchCapabilityLeaseStore } from '../../src/core/capability-leases';
import { MonarchPermissionGate } from '../../src/core/permission-gate';
import { MonarchPolicyKernel } from '../../src/core/policy-kernel';
import { normalizeActionProposal } from '../../src/core/action-protocol';
import type { MonarchCapability, MonarchExecutionRequest } from '../../src/core/contracts';

const capability: MonarchCapability = {
  id: 'workspace.files.write',
  moduleId: 'workspace',
  title: 'Write file',
  risk: 'write',
};

describe('single Policy Kernel', () => {
  it('allows reversible workspace mutations in workspace-autonomous mode without a second confirmation', () => {
    const policy = createPolicy('workspace-autonomous');
    const decision = policy.preflight(request(), capability, 'write').decision;
    expect(decision).toMatchObject({ outcome: 'allow', requiresSecurityReview: false });
    expect(decision.evidence.map((entry) => entry.code)).toContain('security.fast-path.deterministic');
  });

  it('keeps the same mutation confirmable in guided mode', () => {
    const decision = createPolicy('guided').preflight(request(), capability, 'write').decision;
    expect(decision.outcome).toBe('confirm');
  });

  it('does not treat an overwrite as reversible merely because it uses the workspace write capability', () => {
    const overwriteRequest = request({ input: { path: 'notes/unit.txt', content: 'replace', overwrite: true } });
    const decision = createPolicy('workspace-autonomous').preflight(overwriteRequest, capability, 'write').decision;
    expect(decision.outcome).toBe('confirm');
    expect(decision.riskVector.reversibility).toBe('irreversible');
  });

  it('never lets a caller-supplied risk vector downgrade derived risk', () => {
    const forged = request({
      input: { path: 'notes/unit.txt', content: 'replace', overwrite: true },
      riskVector: {
        effect: 'read',
        scope: 'single-object',
        reversibility: 'read-only',
        externality: 'local',
        privilege: 'user',
        data: 'public',
        novelty: 'known-capability',
      },
    });
    const decision = createPolicy('workspace-autonomous').preflight(forged, capability, 'write').decision;
    expect(decision.outcome).toBe('confirm');
    expect(decision.riskVector).toMatchObject({ effect: 'write', reversibility: 'irreversible' });
  });

  it('uses a task lease only for the exact intent and workspace root', () => {
    const root = 'E:\\Monarch';
    const leases = new MonarchCapabilityLeaseStore(root);
    const policy = new MonarchPolicyKernel(
      new MonarchPermissionGate({ sandboxMode: 'read-only', approvalPolicy: 'on-request', autonomyMode: 'guided' }),
      leases,
    );
    const proposal = normalizeActionProposal({
      capabilityId: capability.id,
      args: { path: 'notes/a.txt', content: 'a' },
    }, { capability, workspaceRoot: root, intentId: 'intent_task', originatingUserText: 'Создай заметки' });
    const lease = leases.issueForProposal(proposal);
    const leasedRequest = request({
      intentId: proposal.intentId,
      intentHash: proposal.intentHash,
      leaseId: lease.leaseId,
      input: { path: 'notes/b.txt', content: 'b' },
      riskVector: proposal.riskVector,
    });
    expect(policy.preflight(leasedRequest, capability, 'write').decision).toMatchObject({ outcome: 'allow', leaseId: lease.leaseId });
    expect(policy.preflight({ ...leasedRequest, intentHash: 'different' }, capability, 'write').decision.outcome).toBe('confirm');
    expect(policy.preflight({ ...leasedRequest, input: { path: '..\\outside.txt', content: 'x' } }, capability, 'write').decision.outcome).toBe('confirm');
  });

  it('honors the explicit model command disable before autonomy and leases', () => {
    const proposalRequest = request({ proposalId: 'proposal_model', proposalHash: 'a'.repeat(64) });
    const decision = createPolicy('workspace-autonomous').preflight(
      proposalRequest,
      capability,
      'write',
      { modelCommandsEnabled: false },
    ).decision;
    expect(decision.outcome).toBe('deny');
    expect(decision.evidence.map((entry) => entry.code)).toContain('model-policy.commands-disabled');
  });

  it('honors always-confirm for exact model proposals', () => {
    const proposalRequest = request({ proposalId: 'proposal_model', proposalHash: 'b'.repeat(64) });
    const policy = createPolicy('workspace-autonomous');
    expect(policy.preflight(proposalRequest, capability, 'write', { modelConfirmationMode: 'always' }).decision.outcome).toBe('confirm');
    expect(policy.preflight({ ...proposalRequest, confirmed: true }, capability, 'write', { modelConfirmationMode: 'always' }).decision.outcome).toBe('allow');
  });

  it('does not let untrusted context silently turn a read-like user turn into a mutation', () => {
    const policy = createPolicy('workspace-autonomous');
    const proposalRequest = request({
      proposalId: 'proposal_injected',
      proposalHash: 'd'.repeat(64),
      originatingUserText: 'Прочитай README и расскажи, что внутри',
    });
    const blocked = policy.preflight(proposalRequest, capability, 'write').decision;
    expect(blocked.outcome).toBe('confirm');
    expect(blocked.evidence.map((entry) => entry.code)).toContain('proposal.user-intent-unproven');
    expect(policy.preflight({ ...proposalRequest, originatingUserText: 'Создай файл с итогом' }, capability, 'write').decision.outcome).toBe('allow');
  });
});

function createPolicy(autonomyMode: 'guided' | 'workspace-autonomous'): MonarchPolicyKernel {
  const sandboxMode = autonomyMode === 'guided' ? 'read-only' : 'workspace-write';
  return new MonarchPolicyKernel(
    new MonarchPermissionGate({ sandboxMode, approvalPolicy: 'on-request', autonomyMode }),
    new MonarchCapabilityLeaseStore('E:\\Monarch'),
  );
}

function request(overrides: Partial<MonarchExecutionRequest> = {}): MonarchExecutionRequest {
  return {
    id: 'exec_unit',
    intentId: 'intent_unit',
    moduleId: capability.moduleId,
    capabilityId: capability.id,
    input: { path: 'notes/unit.txt', content: 'hello' },
    createdAt: new Date(0).toISOString(),
    requestedBy: 'unit',
    confirmed: false,
    ...overrides,
  };
}
