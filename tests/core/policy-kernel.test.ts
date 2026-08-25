import { describe, expect, it } from 'vitest';
import { MonarchCapabilityLeaseStore } from '../../src/core/capability-leases';
import { MonarchPermissionGate } from '../../src/core/permission-gate';
import { MonarchPolicyKernel } from '../../src/core/policy-kernel';
import { normalizeActionProposal } from '../../src/core/action-protocol';
import type { MonarchCapability, MonarchExecutionRequest } from '../../src/core/contracts';
import { computerManifest } from '../../src/modules/computer/manifest';
import { deviceManifest } from '../../src/modules/device/manifest';

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

  it('uses local Observe scoring for Agent Runtime writes without a second Security cycle', () => {
    const decision = createPolicy('workspace-autonomous').preflight(
      request({ executionMode: 'agent-runtime', requestedBy: 'agent:task_fixture' }),
      capability,
      'write',
      { actionGuardReaction: 'observe' },
    ).decision;

    expect(decision).toMatchObject({
      outcome: 'allow',
      requiresSecurityReview: false,
      dangerResponse: 'observe',
    });
    expect(decision.evidence.map((entry) => entry.code)).toContain('security.fast-path.deterministic');
  });

  it('defaults Full Access Agent Runtime to Observe before Security emits startup state', () => {
    const decision = createOwnerPolicy().preflight(
      request({
        executionMode: 'agent-runtime',
        requestedBy: 'agent:task_fixture',
        input: { path: 'notes/unit.txt', content: 'replace', overwrite: true },
      }),
      capability,
      'write',
    ).decision;

    expect(decision).toMatchObject({
      outcome: 'allow',
      requiresSecurityReview: false,
      dangerResponse: 'observe',
    });
    expect(decision.evidence.map((entry) => entry.code)).not.toContain('risk.irreversible.confirmation-required');
  });

  it('uses adaptive danger modes without a second Security cycle on low-risk Full Access actions', () => {
    const appCapability = deviceManifest.capabilities.find((entry) => entry.id === 'device.app.open')!;
    const appRequest = request({
      moduleId: 'device',
      capabilityId: appCapability.id,
      input: { app: 'Telegram' },
      proposalId: 'proposal_telegram_open',
      proposalHash: '1'.repeat(64),
      proposalSource: 'model-tool-call',
      executionMode: 'agent-runtime',
      requestedBy: 'agent:task_open_telegram',
      source: 'desktop',
      originatingUserText: 'Открой Telegram',
    });

    const observe = createOwnerPolicy().preflight(appRequest, appCapability, 'device-control', {
      agentSecurityMode: 'observe',
    }).decision;
    const guard = createOwnerPolicy().preflight(appRequest, appCapability, 'device-control', {
      agentSecurityMode: 'guard',
    }).decision;
    expect(observe).toMatchObject({ outcome: 'allow', requiresSecurityReview: false, dangerResponse: 'observe' });
    expect(guard).toMatchObject({ outcome: 'allow', requiresSecurityReview: false, dangerResponse: 'allow' });
    expect(observe.dangerAssessment?.dangerProbability).toBeLessThanOrEqual(39);
  });

  it('applies every danger mode across guided, workspace, and Full Access profiles at every band', () => {
    const scenarios: Array<{
      band: 'minimal' | 'low' | 'elevated' | 'high' | 'critical';
      capability: MonarchCapability;
      risk: MonarchCapability['risk'];
      request: MonarchExecutionRequest;
    }> = [
      {
        band: 'minimal',
        capability: { id: 'workspace.files.read', moduleId: 'workspace', title: 'Read file', risk: 'read' },
        risk: 'read',
        request: agentRequest('workspace.files.read', 'workspace', { path: 'notes/unit.txt' }, 'Прочитай notes/unit.txt'),
      },
      {
        band: 'low',
        capability: deviceManifest.capabilities.find((entry) => entry.id === 'device.app.open')!,
        risk: 'device-control',
        request: agentRequest('device.app.open', 'device', { app: 'Telegram' }, 'Открой Telegram'),
      },
      {
        band: 'elevated',
        capability: { id: 'workspace.files.delete', moduleId: 'workspace', title: 'Delete file', risk: 'delete' },
        risk: 'delete',
        request: agentRequest('workspace.files.delete', 'workspace', { path: 'notes/unit.txt' }, 'Удали notes/unit.txt'),
      },
      {
        band: 'high',
        capability: { id: 'security.policy.change', moduleId: 'security', title: 'Change Security policy', risk: 'security-sensitive' },
        risk: 'security-sensitive',
        request: agentRequest('security.policy.change', 'security', {}, 'Run Security policy change'),
      },
      {
        band: 'critical',
        capability: { id: 'security.policy.change', moduleId: 'security', title: 'Change Security policy', risk: 'security-sensitive' },
        risk: 'security-sensitive',
        request: { ...agentRequest('security.policy.change', 'security', {}, 'Run Security policy change'), source: 'telegram' },
      },
    ];
    const modes = ['off', 'observe', 'guard', 'strict'] as const;
    const profiles = ['guided', 'workspace-autonomous', 'full-local'] as const;

    for (const mode of modes) {
      for (const profile of profiles) {
        for (const scenario of scenarios) {
          const decision = createMatrixPolicy(profile).preflight(
            scenario.request,
            scenario.capability,
            scenario.risk,
            { agentSecurityMode: mode },
          ).decision;
          expect(decision.dangerAssessment?.band, `${mode}/${profile}/${scenario.band}`).toBe(scenario.band);
          const response = decision.dangerResponse!;
          if (response === 'block') expect(decision.outcome, `${mode}/${profile}/${scenario.band}`).toBe('deny');
          if (response === 'confirm') expect(decision.outcome, `${mode}/${profile}/${scenario.band}`).toBe('confirm');
          if (response === 'enhanced-readback' && decision.outcome === 'allow') {
            expect(decision.requiresSecurityReview, `${mode}/${profile}/${scenario.band}`).toBe(true);
          }
          if ((scenario.band === 'minimal' || scenario.band === 'low') && (mode === 'off' || mode === 'observe' || mode === 'guard')) {
            expect(decision.requiresSecurityReview, `${mode}/${profile}/${scenario.band}`).toBe(false);
          }
        }
      }
    }
  });

  it('binds task Owner override locally and never grants it to Telegram', () => {
    const shellCapability: MonarchCapability = {
      id: 'system.shell.run', moduleId: 'system-shell', title: 'Run exact shell process', risk: 'execute',
    };
    const shellRequest = request({
      moduleId: 'system-shell', capabilityId: shellCapability.id,
      input: { executable: 'powershell.exe', args: ['-Command', 'Get-Date'], cwd: 'E:\\Agent-QA' },
      proposalId: 'proposal_shell', proposalHash: '2'.repeat(64), proposalSource: 'model-tool-call',
      executionMode: 'agent-runtime', requestedBy: 'agent:task_shell', source: 'desktop',
      originatingUserText: 'Выполни Get-Date в терминале',
    });
    const ownerOverride = {
      enabled: true, lifetime: 'task' as const, taskId: 'task_shell', shellApprovalPolicy: 'never' as const,
    };
    const local = createOwnerPolicy().preflight(shellRequest, shellCapability, 'execute', {
      agentSecurityMode: 'strict', ownerOverride,
    }).decision;
    const remote = createOwnerPolicy().preflight({ ...shellRequest, source: 'telegram' }, shellCapability, 'execute', {
      agentSecurityMode: 'strict', ownerOverride,
    }).decision;
    expect(local.outcome).not.toBe('confirm');
    expect(remote.outcome).toBe('confirm');
    expect(remote.evidence.map((entry) => entry.code)).toContain('shell.exact-action-card.required');

    const riskBased = createOwnerPolicy().preflight(shellRequest, shellCapability, 'execute', {
      agentSecurityMode: 'strict',
      ownerOverride: { ...ownerOverride, shellApprovalPolicy: 'risk-based' },
    }).decision;
    expect(riskBased).toMatchObject({ outcome: 'confirm', dangerResponse: 'confirm' });
  });

  it('lets Full Local Computer Use reach Action Guard without weakening Guided or confirm-all modes', () => {
    const clickCapability = computerManifest.capabilities.find((entry) => entry.id === 'computer.window.click')!;
    const computerRequest = request({
      moduleId: 'computer',
      capabilityId: clickCapability.id,
      input: {
        windowRef: 'hwnd:0000000000000042',
        observationId: 'computer-observation-fixture-1',
        elementId: 'el-button-fixture',
      },
      proposalId: 'proposal_computer_click',
      proposalHash: 'c'.repeat(64),
      executionMode: 'agent-runtime',
      requestedBy: 'agent:task_computer',
      source: 'desktop',
      originatingUserText: 'Нажми кнопку Продолжить в этом окне',
    });

    expect(createOwnerPolicy().preflight(
      computerRequest,
      clickCapability,
      'device-control',
      { actionGuardReaction: 'guard' },
    ).decision).toMatchObject({ outcome: 'allow', requiresSecurityReview: false, dangerResponse: 'allow' });
    expect(createPolicy('guided').preflight(
      computerRequest,
      clickCapability,
      'device-control',
      { actionGuardReaction: 'guard' },
    ).decision.outcome).toBe('confirm');
    expect(createOwnerPolicy().preflight(
      computerRequest,
      clickCapability,
      'device-control',
      { actionGuardReaction: 'confirm-all' },
    ).decision).toMatchObject({ outcome: 'allow', requiresSecurityReview: true, dangerResponse: 'enhanced-readback' });
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
    expect(policy.preflight(proposalRequest, capability, 'write', { actionGuardReaction: 'confirm-all' }).decision.outcome).toBe('confirm');
    expect(policy.preflight({ ...proposalRequest, confirmed: true }, capability, 'write', { actionGuardReaction: 'confirm-all' }).decision.outcome).toBe('allow');
    expect(policy.preflight(proposalRequest, capability, 'write', { modelConfirmationMode: 'always' }).decision.outcome).toBe('confirm');
  });

  it('does not misclassify exact runtime grammar as a model command in autonomous modes', () => {
    const appCapability = deviceManifest.capabilities.find((entry) => entry.id === 'device.app.open')!;
    const directRequest = request({
      moduleId: 'device',
      capabilityId: appCapability.id,
      input: { app: 'figma' },
      proposalId: 'proposal_runtime_figma',
      proposalHash: '7'.repeat(64),
      proposalSource: 'runtime-grammar',
      executionMode: 'agent-runtime',
      requestedBy: 'agent:task_runtime_figma',
      source: 'desktop',
      originatingUserText: 'открой Figma',
    });

    expect(createOwnerPolicy().preflight(
      directRequest,
      appCapability,
      'device-control',
      { modelCommandsEnabled: false, actionGuardReaction: 'confirm-all' },
    ).decision).toMatchObject({ outcome: 'allow', requiresSecurityReview: true });
    expect(createPolicy('workspace-autonomous').preflight(
      directRequest,
      appCapability,
      'device-control',
      { modelCommandsEnabled: false, actionGuardReaction: 'confirm-all' },
    ).decision).toMatchObject({ outcome: 'allow', requiresSecurityReview: true });

    const publicSpoof = { ...directRequest, executionMode: undefined };
    expect(createOwnerPolicy().preflight(
      publicSpoof,
      appCapability,
      'device-control',
      { modelCommandsEnabled: false, actionGuardReaction: 'confirm-all' },
    ).decision).toMatchObject({ outcome: 'deny' });
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

  it('allows Oscar DEV commands only with signed owner authority', () => {
    const input = {
      source: 'desktop' as const,
      command: 'dev.update',
      scope: { type: 'chat' as const },
      payload: { patch: { internetEnabled: false } },
    };
    expect(createPolicy('workspace-autonomous').evaluateLocalSettingsCommand(input)).toMatchObject({
      outcome: 'deny',
      reason: expect.stringContaining('owner'),
    });
    expect(createOwnerPolicy().evaluateLocalSettingsCommand(input)).toMatchObject({ outcome: 'allow' });
  });

  it('applies the same read-to-write intent guard inside Agent Runtime', () => {
    const policy = createPolicy('workspace-autonomous');
    const injected = request({
      proposalId: 'proposal_agent_injected',
      proposalHash: 'e'.repeat(64),
      executionMode: 'agent-runtime',
      requestedBy: 'agent:task_fixture',
      originatingUserText: 'Прочитай status.txt и объясни результат',
    });
    expect(policy.preflight(injected, capability, 'write').decision).toMatchObject({
      outcome: 'confirm',
      evidence: expect.arrayContaining([
        expect.objectContaining({ code: 'proposal.user-intent-unproven' }),
      ]),
    });
  });

  it('exposes owner-confirmable Security facts only to signed local Owner sessions', () => {
    const deleteCapability: MonarchCapability = {
      id: 'workspace.files.delete', moduleId: 'workspace', title: 'Delete file', risk: 'delete',
    };
    const ownerPolicy = createOwnerPolicy();
    const desktopRequest = request({
      moduleId: 'workspace', capabilityId: deleteCapability.id,
      input: { path: 'runtime/fixture.txt' },
      proposalId: 'proposal_owner_delete', proposalHash: 'f'.repeat(64),
      source: 'desktop', confirmed: true,
      originatingUserText: 'удали runtime/fixture.txt',
    });
    const fact = {
      ok: false,
      status: 'blocked',
      report: 'Bounded delete needs an Owner decision.',
      evidenceCodes: ['intent.delete.mismatch'],
      disposition: 'owner-confirmable' as const,
    };
    const ownerPreflight = ownerPolicy.preflight(desktopRequest, deleteCapability, 'delete');
    const ownerDecision = ownerPolicy.finalize(ownerPreflight, desktopRequest, fact);
    expect(ownerDecision).toMatchObject({ outcome: 'confirm', authorityTier: 'owner', securityOverride: true });

    const voiceRequest = { ...desktopRequest, source: 'voice' as const };
    expect(ownerPolicy.finalize(
      ownerPolicy.preflight(voiceRequest, deleteCapability, 'delete'),
      voiceRequest,
      fact,
    )).toMatchObject({ outcome: 'deny', authorityTier: 'public' });

    const publicPolicy = createPolicy('guided');
    expect(publicPolicy.finalize(
      publicPolicy.preflight(desktopRequest, deleteCapability, 'delete'),
      desktopRequest,
      fact,
    )).toMatchObject({ outcome: 'deny', authorityTier: 'public' });
  });

  it('binds an Owner override to one exact policy hash and never overrides a hard-deny', () => {
    const deleteCapability: MonarchCapability = {
      id: 'workspace.files.delete', moduleId: 'workspace', title: 'Delete file', risk: 'delete',
    };
    const policy = createOwnerPolicy();
    const base = request({
      moduleId: 'workspace', capabilityId: deleteCapability.id,
      input: { path: 'runtime/fixture.txt' },
      proposalId: 'proposal_owner_exact', proposalHash: '9'.repeat(64),
      source: 'desktop', confirmed: true,
      originatingUserText: 'удали runtime/fixture.txt',
    });
    const confirmable = {
      ok: false, status: 'blocked', report: 'Review exact delete.',
      evidenceCodes: ['intent.delete.mismatch'], disposition: 'owner-confirmable' as const,
    };
    const requested = policy.finalize(policy.preflight(base, deleteCapability, 'delete'), base, confirmable);
    const approvedRequest: MonarchExecutionRequest = {
      ...base,
      securityOverrideConfirmed: true,
      approvalPurpose: 'owner-security-override',
      approvalPolicyDecisionHash: requested.policyDecisionHash,
      authorityTierAtApproval: 'owner',
    };
    const approved = policy.finalize(
      policy.preflight(approvedRequest, deleteCapability, 'delete'), approvedRequest, confirmable,
    );
    expect(approved).toMatchObject({ outcome: 'allow', securityOverride: true });
    expect(approved.policyDecisionHash).toBe(requested.policyDecisionHash);
    expect(policy.approvalBindingMatches(approvedRequest, approved)).toBe(true);
    expect(policy.approvalBindingMatches({
      ...approvedRequest, approvalPolicyDecisionHash: '0'.repeat(64),
    }, approved)).toBe(false);

    const hardFact = { ...confirmable, disposition: 'hard-deny' as const, evidenceCodes: ['command.catastrophic'] };
    expect(policy.finalize(
      policy.preflight(approvedRequest, deleteCapability, 'delete'), approvedRequest, hardFact,
    )).toMatchObject({ outcome: 'deny' });
  });
});

function createPolicy(autonomyMode: 'guided' | 'workspace-autonomous'): MonarchPolicyKernel {
  const sandboxMode = autonomyMode === 'guided' ? 'read-only' : 'workspace-write';
  return new MonarchPolicyKernel(
    new MonarchPermissionGate({ sandboxMode, approvalPolicy: 'on-request', autonomyMode }),
    new MonarchCapabilityLeaseStore('E:\\Monarch'),
  );
}

function createOwnerPolicy(): MonarchPolicyKernel {
  return new MonarchPolicyKernel(
    new MonarchPermissionGate({ sandboxMode: 'danger-full-access', approvalPolicy: 'on-request', autonomyMode: 'full-local' }),
    new MonarchCapabilityLeaseStore('E:\\Monarch'),
    {
      tier: 'owner', source: 'signed-device-entitlement', entitlementId: 'owner_test', keyId: 'owner-root-test',
      verifiedAt: new Date(0).toISOString(), deviceIdPrefix: '0123456789ab', diagnostic: null,
    },
  );
}

function createMatrixPolicy(
  autonomyMode: 'guided' | 'workspace-autonomous' | 'full-local',
): MonarchPolicyKernel {
  if (autonomyMode === 'full-local') return createOwnerPolicy();
  return createPolicy(autonomyMode);
}

function agentRequest(
  capabilityId: string,
  moduleId: string,
  input: Record<string, unknown>,
  originatingUserText: string,
): MonarchExecutionRequest {
  return request({
    moduleId,
    capabilityId,
    input,
    proposalId: `proposal_${capabilityId.replace(/[^a-z0-9]+/gi, '_')}`,
    proposalHash: 'a'.repeat(64),
    proposalSource: 'model-tool-call',
    executionMode: 'agent-runtime',
    requestedBy: 'agent:task_matrix',
    source: 'desktop',
    originatingUserText,
  });
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
