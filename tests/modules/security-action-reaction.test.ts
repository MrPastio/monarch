import { describe, expect, it } from 'vitest';
import {
  MonarchKernel,
  type MonarchActionGuardReaction,
  type MonarchExecutionRequest,
  type MonarchExecutionResult,
  type MonarchModule,
} from '../../src/core';
import { SecurityModule } from '../../src/modules/security';

describe('Security Action Guard reactions', () => {
  it('keeps Full Access on Observe when the optional Python Security helper is unavailable', async () => {
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
        .toMatchObject({ available: false, agentSecurityMode: 'observe' });
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
  });
  kernel.registerModule(new SecurityModule(client as any));
  kernel.registerModule(workspaceFixture(() => { executions += 1; }));
  await kernel.start();
  return { kernel, executions: () => executions, remoteChecks: () => client.checks };
}

function workspaceFixture(onExecute: () => void): MonarchModule {
  return {
    manifest: {
      id: 'workspace',
      name: 'Synthetic Workspace',
      version: '0.1.0',
      kind: 'tooling',
      description: 'Test-only exact Action Guard effect.',
      owns: ['workspace'],
      permissions: ['write'],
      capabilities: [{
        id: 'workspace.files.write',
        moduleId: 'workspace',
        title: 'Write synthetic file',
        risk: 'write',
      }],
    },
    async activate(): Promise<void> {},
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
