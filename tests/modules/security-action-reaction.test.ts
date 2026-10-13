import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  MonarchKernel,
  type MonarchActionGuardReaction,
  type MonarchExecutionRequest,
  type MonarchExecutionResult,
  type MonarchModule,
} from '../../src/core';
import { SecurityModule } from '../../src/modules/security';

describe('Security Action Guard reactions', () => {
  it('keeps the independent Guard active when the optional Python Security helper is unavailable', async () => {
    const client = new FakeSecurityClient('guard') as FakeSecurityClient & { available: boolean };
    Object.defineProperty(client, 'available', { value: false });
    const kernel = new MonarchKernel({
      agencyStateDirectory: false,
      permissionProfile: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'on-request',
        autonomyMode: 'full-local',
      },
    });
    kernel.registerModule(new SecurityModule(client as any));
    await kernel.start();
    try {
      expect(kernel.getSnapshot().events.find((event) => event.type === 'security.activated')?.payload)
        .toMatchObject({ available: false, agentSecurityMode: 'guard' });
    } finally {
      await kernel.stop();
    }
  });

  it('keeps observation active while the background sensor profile is off', async () => {
    const harness = await createHarness('observe');
    try {
      const result = await harness.kernel.execute(request({
        input: { path: 'runtime/settings/observed.txt', content: 'ok' },
      }));

      expect(result).toMatchObject({ ok: true, summary: 'Synthetic workspace effect executed.' });
      expect(harness.executions()).toBe(1);
      expect(harness.remoteChecks()).toBe(0);
      const assessed = harness.kernel.getSnapshot().events.find((event) => event.type === 'security.danger.assessed');
      expect(assessed?.payload).toMatchObject({
        capabilityId: 'workspace.files.write',
        response: 'observe',
        assessment: { band: expect.stringMatching(/minimal|low/) },
      });
      expect(harness.kernel.getSnapshot().events.some((event) => event.type === 'security.action.reviewed')).toBe(false);
    } finally {
      await harness.kernel.stop();
    }
  });

  it('uses one enhanced deterministic readback for an elevated Guard action without asking the user', async () => {
    const harness = await createHarness('guard', 'workspace-write', 'approval_required');
    try {
      const result = await harness.kernel.execute(request({
        input: { path: 'runtime/settings/guarded.txt', content: 'ok' },
        riskVector: {
          effect: 'write',
          scope: 'workspace',
          reversibility: 'compensatable',
          externality: 'trusted-origin',
          privilege: 'elevated',
          data: 'personal',
          novelty: 'new-args',
        },
      }));

      expect(result).toMatchObject({ ok: true, summary: 'Synthetic workspace effect executed.' });
      expect(harness.executions()).toBe(1);
      expect(harness.remoteChecks()).toBe(1);
      expect(harness.kernel.getSnapshot().events.find((event) => event.type === 'security.danger.assessed')?.payload)
        .toMatchObject({ response: 'enhanced-readback' });
      expect(harness.kernel.getSnapshot().events.find((event) => event.type === 'security.action.reviewed')?.payload)
        .toMatchObject({ status: 'allowed', disposition: 'informational' });
    } finally {
      await harness.kernel.stop();
    }
  });

  it('keeps Direct Access under the local Security locator without restoring the legacy remote approval wall', async () => {
    const harness = await createHarness('guard', 'danger-full-access', 'approval_required', true);
    try {
      const result = await harness.kernel.execute(request({
        input: { path: 'runtime/settings/direct.txt', content: 'ok' },
      }));

      expect(result).toMatchObject({
        ok: true,
        summary: 'Synthetic workspace effect executed.',
        metadata: { policy: { ownerUnrestrictedOverride: true } },
      });
      expect(harness.executions()).toBe(1);
      expect(harness.remoteChecks()).toBe(0);
      expect(harness.kernel.getSnapshot().events.find((event) => event.type === 'security.action.reviewed')?.payload)
        .toMatchObject({ status: 'allowed', disposition: 'informational' });
    } finally {
      await harness.kernel.stop();
    }
  });

  it('does not let the ambient workspace profile shrink persistent Direct Access back to the workspace', async () => {
    const harness = await createHarness('guard', 'workspace-write', 'approval_required', true);
    try {
      const outsideWorkspace = path.join(path.parse(process.cwd()).root, 'MonarchRuntimeTests', 'direct-access-outside.txt');
      const result = await harness.kernel.execute(request({
        input: { path: outsideWorkspace, content: 'synthetic only' },
        originatingUserText: 'создай внешний тестовый файл',
      }));

      expect(result).toMatchObject({
        ok: true,
        summary: 'Synthetic workspace effect executed.',
        metadata: { policy: { ownerUnrestrictedOverride: true } },
      });
      expect(harness.executions()).toBe(1);
      expect(harness.remoteChecks()).toBe(0);
      expect(harness.kernel.getSnapshot().events.find((event) => event.type === 'security.action.reviewed')?.payload)
        .toMatchObject({ status: 'allowed', disposition: 'informational' });
    } finally {
      await harness.kernel.stop();
    }
  });

  it('turns an unavailable live target observer into one exact Direct Access Owner decision', async () => {
    const harness = await createHarness('guard', 'danger-full-access', 'approval_required', true, true);
    try {
      const action = request({
        input: { path: 'runtime/settings/unobserved.txt', content: 'synthetic only' },
        originatingUserText: 'создай этот тестовый файл',
      });
      const held = await harness.kernel.execute(action);

      expect(held).toMatchObject({
        ok: false,
        error: 'confirmation-required',
        metadata: {
          policy: {
            outcome: 'confirm',
            ownerUnrestrictedOverride: true,
            evidence: expect.arrayContaining([expect.objectContaining({ code: 'security.context.unavailable' })]),
          },
          dispatchControl: { dispatched: false, reason: 'policy-confirmation-required' },
        },
      });
      expect(harness.executions()).toBe(0);
      expect(harness.remoteChecks()).toBe(0);

      const policy = (held.metadata as { policy: { policyDecisionHash: string; authorityTier: 'owner' } }).policy;
      const approved = await harness.kernel.execute({
        ...action,
        id: `${action.id}_approved`,
        confirmed: true,
        approvalPurpose: 'policy',
        approvalPolicyDecisionHash: policy.policyDecisionHash,
        authorityTierAtApproval: policy.authorityTier,
      });
      expect(approved).toMatchObject({ ok: true, summary: 'Synthetic workspace effect executed.' });
      expect(harness.executions()).toBe(1);
      expect(harness.remoteChecks()).toBe(0);
    } finally {
      await harness.kernel.stop();
    }
  });

  it('pauses one large Direct deletion for an exact Owner decision and resumes only that bound action', async () => {
    const harness = await createHarness('guard', 'danger-full-access', 'approval_required', true);
    try {
      const dangerous = request({
        capabilityId: 'workspace.files.delete',
        input: { paths: Array.from({ length: 120 }, (_, index) => `E:\\MonarchRuntimeTests\\synthetic-bulk-delete\\${index}.tmp`) },
        originatingUserText: 'удали этот список тестовых файлов',
      });
      const held = await harness.kernel.execute(dangerous);
      expect(held).toMatchObject({
        ok: false,
        error: 'confirmation-required',
        metadata: {
          policy: {
            outcome: 'confirm',
            ownerUnrestrictedOverride: true,
            evidence: expect.arrayContaining([expect.objectContaining({ code: 'delete.large-scope' })]),
          },
          dispatchControl: { dispatched: false, reason: 'policy-confirmation-required' },
        },
      });
      expect(harness.executions()).toBe(0);
      expect(harness.remoteChecks()).toBe(0);
      expect(harness.kernel.getSnapshot().events.find((event) => event.type === 'security.action.reviewed')?.payload)
        .toMatchObject({ status: 'approval_required', disposition: 'owner-confirmable' });

      const policy = (held.metadata as { policy: { policyDecisionHash: string; authorityTier: 'owner' } }).policy;
      const approved = await harness.kernel.execute({
        ...dangerous,
        id: `${dangerous.id}_approved`,
        confirmed: true,
        approvalPurpose: 'policy',
        approvalPolicyDecisionHash: policy.policyDecisionHash,
        authorityTierAtApproval: policy.authorityTier,
      });
      expect(approved).toMatchObject({ ok: true, summary: 'Synthetic workspace effect executed.' });
      expect(harness.executions()).toBe(1);
      expect(harness.remoteChecks()).toBe(0);
    } finally {
      await harness.kernel.stop();
    }
  });

  it('lets Strict execute a 0-19 action immediately instead of restoring confirm-all walls', async () => {
    const harness = await createHarness('confirm-all');
    try {
      const result = await harness.kernel.execute(request({
        input: { path: 'runtime/ordinary.txt', content: 'ok' },
      }));

      expect(result).toMatchObject({ ok: true, summary: 'Synthetic workspace effect executed.' });
      expect(harness.executions()).toBe(1);
      expect(harness.remoteChecks()).toBe(0);
      expect(harness.kernel.getSnapshot().events.find((event) => event.type === 'security.danger.assessed')?.payload)
        .toMatchObject({ response: 'allow', assessment: { band: 'minimal' } });
    } finally {
      await harness.kernel.stop();
    }
  });

  it('lets exact runtime grammar use the local Guard without a legacy blanket confirmation', async () => {
    const harness = await createHarness('confirm-all', 'workspace-write', 'approval_required');
    try {
      const result = await harness.kernel.execute(request({
        proposalSource: 'runtime-grammar',
        input: { path: 'runtime/exact-runtime-action.txt', content: 'ok' },
      }));

      expect(result).toMatchObject({ ok: true, summary: 'Synthetic workspace effect executed.' });
      expect(harness.executions()).toBe(1);
      expect(harness.remoteChecks()).toBe(0);
      expect(harness.kernel.getSnapshot().events.find((event) => event.type === 'security.danger.assessed')?.payload)
        .toMatchObject({ response: 'allow', assessment: { band: 'minimal' } });
    } finally {
      await harness.kernel.stop();
    }
  });

  it('never downgrades a deterministic hard boundary in Observe mode', async () => {
    const harness = await createHarness('observe', 'danger-full-access');
    try {
      const result = await harness.kernel.execute(request({
        input: {
          path: `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\drivers\\etc\\hosts`,
          content: 'blocked',
        },
      }));

      expect(result).toMatchObject({ ok: false, error: 'permission-denied' });
      expect(harness.executions()).toBe(0);
      expect(harness.kernel.getSnapshot().events.find((event) => event.type === 'policy.evaluated')?.payload)
        .toMatchObject({ decision: { outcome: 'deny', evidence: expect.arrayContaining([
          expect.objectContaining({ code: 'filesystem.red-zone-write-blocked' }),
        ]) } });
    } finally {
      await harness.kernel.stop();
    }
  });
});

function request(overrides: Partial<MonarchExecutionRequest> = {}): MonarchExecutionRequest {
  return {
    id: `exec_${Math.random().toString(16).slice(2)}`,
    intentId: 'intent_action_guard_reaction',
    moduleId: 'workspace',
    capabilityId: 'workspace.files.write',
    input: { path: 'runtime/ordinary.txt', content: 'ok' },
    createdAt: new Date(0).toISOString(),
    requestedBy: 'agent:reaction-test',
    source: 'desktop',
    proposalId: 'proposal_action_guard_reaction',
    proposalHash: 'a'.repeat(64),
    originatingUserText: 'создай этот файл',
    executionMode: 'agent-runtime',
    ...overrides,
  };
}

async function createHarness(
  reaction: MonarchActionGuardReaction,
  sandboxMode: 'workspace-write' | 'danger-full-access' = 'workspace-write',
  remoteStatus: 'allowed' | 'approval_required' = 'allowed',
  ownerDirect = false,
  targetContextUnavailable = false,
): Promise<{ kernel: MonarchKernel; executions: () => number; remoteChecks: () => number }> {
  let executions = 0;
  const client = new FakeSecurityClient(reaction, remoteStatus);
  const kernel = new MonarchKernel({
    agencyStateDirectory: false,
    permissionProfile: {
      sandboxMode,
      approvalPolicy: 'on-request',
      autonomyMode: sandboxMode === 'danger-full-access' ? 'full-local' : 'workspace-autonomous',
    },
    ...(ownerDirect ? {
      authorityContext: {
        tier: 'owner' as const,
        source: 'signed-device-entitlement' as const,
        entitlementId: 'owner_security_reaction_test',
        keyId: 'owner-security-test',
        verifiedAt: new Date(0).toISOString(),
        deviceIdPrefix: '0123456789ab',
        diagnostic: null,
      },
    } : {}),
  });
  kernel.registerModule(new SecurityModule(client as any));
  kernel.registerModule(workspaceFixture(() => { executions += 1; }, targetContextUnavailable));
  await kernel.start();
  if (ownerDirect) {
    await kernel.emitRuntimeEvent('security.owner_override.changed', 'security', {
      ownerOverride: { enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' },
    });
  }
  return { kernel, executions: () => executions, remoteChecks: () => client.checks };
}

function workspaceFixture(onExecute: () => void, targetContextUnavailable = false): MonarchModule {
  return {
    manifest: {
      id: 'workspace',
      name: 'Synthetic Workspace',
      version: '0.1.0',
      kind: 'tooling',
      description: 'Test-only exact Action Guard effect.',
      owns: ['workspace'],
      permissions: ['write', 'delete'],
      capabilities: [{
        id: 'workspace.files.write',
        moduleId: 'workspace',
        title: 'Write synthetic file',
        risk: 'write',
      }, {
        id: 'workspace.files.delete',
        moduleId: 'workspace',
        title: 'Delete synthetic files',
        risk: 'delete',
      }],
    },
    async activate(): Promise<void> {},
    ...(targetContextUnavailable ? {
      async resolveSecurityActionContext(): Promise<never> {
        throw new Error('Synthetic live target observer is unavailable.');
      },
    } : {}),
    async executeCapability(): Promise<MonarchExecutionResult> {
      onExecute();
      return { ok: true, summary: 'Synthetic workspace effect executed.' };
    },
  };
}

class FakeSecurityClient {
  readonly available = true;
  checks = 0;
  readonly config = {
    projectRoot: 'E:\\Monarch\\security',
    configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
    pythonPath: 'python',
  };

  constructor(
    private readonly reaction: MonarchActionGuardReaction,
    private readonly remoteStatus: 'allowed' | 'approval_required' = 'allowed',
  ) {}

  async profile() {
    return command({ profile: { level: 'off' } });
  }

  async modelPolicy() {
    return command({
      model_policy: {
        enabled: true,
        action_guard_reaction: this.reaction,
        agent_security_mode: this.reaction === 'confirm-all' ? 'strict' : this.reaction,
      },
    });
  }

  async checkAction() {
    this.checks += 1;
    const approvalRequired = this.remoteStatus === 'approval_required';
    return command({
      ok: !approvalRequired,
      status: this.remoteStatus,
      risk: approvalRequired ? 'elevated' : 'low',
      report: approvalRequired
        ? 'Synthetic legacy controller requested approval.'
        : 'Synthetic Python controller allowed the action.',
      reasons: [],
      evidenceCodes: ['synthetic.remote.allowed'],
      disposition: approvalRequired ? 'owner-confirmable' : 'informational',
      decision: { action: approvalRequired ? 'require_confirmation' : 'allow', binding: 'synthetic' },
    });
  }
}

function command(payload: unknown) {
  return {
    ok: true,
    exitCode: 0,
    args: [],
    stdout: '',
    stderr: '',
    jsonLines: [payload],
  };
}
