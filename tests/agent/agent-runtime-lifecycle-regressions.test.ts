import { describe, expect, it } from 'vitest';
import type {
  MonarchActionProposalInput,
  MonarchActionProposalV1,
  MonarchCapability,
} from '../../src/core';
import {
  AgentKernelExecutionAdapter,
  InMemoryAgentTaskStore,
  MonarchAgentRuntime,
  ReplayAgentDecisionProvider,
  agentRunnerHeartbeatCadence,
  type AgentDecisionProvider,
  type AgentModelDecisionRequest,
  type AgentModelDecisionResponse,
  type AgentTaskCheckpoint,
} from '../../src/agent';

const fixtureCapability: MonarchCapability = {
  id: 'fixture.lifecycle.read',
  moduleId: 'fixture',
  title: 'Read lifecycle fixture',
  description: 'Read a deterministic lifecycle fixture.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string' } },
    additionalProperties: false,
  },
  agent: { idempotency: 'idempotent', cancellation: 'supported', computeClass: 'light' },
};

describe('Agent runtime lifecycle regressions', () => {
  it('separates responsive control polling from bounded durable lease renewal', () => {
    expect(agentRunnerHeartbeatCadence(300)).toEqual({ controlPollMs: 100, leaseRenewMs: 100 });
    expect(agentRunnerHeartbeatCadence(6_000)).toEqual({ controlPollMs: 1_000, leaseRenewMs: 2_000 });
    expect(agentRunnerHeartbeatCadence(5 * 60_000)).toEqual({
      controlPollMs: 1_000,
      leaseRenewMs: 30_000,
    });
    expect(agentRunnerHeartbeatCadence(Number.NaN)).toEqual({
      controlPollMs: 1_000,
      leaseRenewMs: 30_000,
    });
  });

  it('creates and persists runtime-owned cognitive and causal working state', async () => {
    const store = new InMemoryAgentTaskStore();
    const runtime = createRuntime({
      store,
      provider: askUserProvider('unused'),
      runnerId: 'agent_runner_cognitive_state',
      autoRun: false,
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Inspect one synthetic fixture and report the verified result.',
        source: { surface: 'api' },
        autoStart: false,
        decisionModelPolicy: {
          requestedRole: 'gemma4-fast',
          selectionSource: 'user-explicit',
          fallback: 'exact',
        },
      });
      const persisted = (await store.getTask(created.task.id))!.task;

      expect(persisted.cognitiveProfile).toMatchObject({
        mode: 'small-local',
        activeTier: 'fast',
        maxDecisionSchemas: 3,
        maxObservationFacts: 10,
        agentCapabilityClass: 'basic',
        planningAuthority: 'runtime-only',
        maxPlanSteps: 3,
        runtimeDecomposition: true,
        runtimeRecovery: true,
      });
      expect(persisted.workingState).toMatchObject({
        revision: 1,
        phase: 'decide',
        activeStepId: persisted.plan?.steps[0]?.id,
        goalTargetIds: expect.arrayContaining([
          'expected-output:verified_outcome',
          'success-criterion:required_outputs_verified',
        ]),
        causalObservationIds: [],
        failedActionFingerprints: [],
      });
    } finally {
      await runtime.stop();
    }
  });

  it('observes a cross-process cancellation without durable renewal churn', async () => {
    const store = new CountingRenewStore();
    const provider = new ControlledModelProvider();
    const runtime = createRuntime({
      store,
      provider,
      runnerId: 'agent_runner_external_cancel',
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Keep polling this active model stage without rewriting its lease every poll.',
        source: { surface: 'api' },
      });
      await provider.started;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(store.renewCalls).toBe(0);

      const current = (await store.getTask(created.task.id))!;
      await store.saveTask({
        ...current.task,
        status: 'cancelling',
        cancellationRequested: true,
      }, { expectedCheckpointVersion: current.task.checkpointVersion });

      const cancelled = await waitForStatus(runtime, created.task.id, 'cancelled', 3_000);
      expect(cancelled.task.terminalReason?.code).toBe('cancelled-by-user');
      expect(store.renewCalls).toBe(0);
    } finally {
      provider.finish();
      await runtime.stop();
    }
  }, 8_000);

  it('bounds an invalid-decision repair and detaches a non-cooperative second model call', async () => {
    const provider = new SlowInvalidRepairProvider();
    const runtime = createRuntime({
      store: new InMemoryAgentTaskStore(),
      provider,
      runnerId: 'agent_runner_decision_cycle_budget',
      decisionCycleBudgetMs: 100,
    });
    await runtime.start();
    try {
      const startedAt = Date.now();
      const created = await runtime.createTask({
        request: 'Bound both malformed decision attempts as one user-visible wait.',
        source: { surface: 'api' },
      });
      const failed = await waitForStatus(runtime, created.task.id, 'failed', 2_000);
      expect(Date.now() - startedAt).toBeLessThan(600);
      expect(provider.calls).toBe(2);
      expect(failed.task.terminalReason).toMatchObject({
        code: 'budget-exhausted',
        summary: 'Agent decision cycle exceeded its bounded time budget.',
        detail: { exhaustedBy: 'decision-cycle' },
      });
      expect(failed.events.filter((event) => event.type === 'model.started')).toHaveLength(2);
      expect(failed.events.filter((event) => event.type === 'model.completed').at(-1)?.payload).toMatchObject({
        attempt: 2,
        repair: true,
        ok: false,
        error: 'agent-decision-time-budget-exhausted',
      });
    } finally {
      await runtime.stop();
    }
  });

  it('takes over a runnable task after a foreign claim expires even when started before the TTL', async () => {
    const store = new InMemoryAgentTaskStore();
    const seed = createRuntime({
      store,
      provider: askUserProvider('seed runtime must stay idle'),
      runnerId: 'agent_runner_seed',
      autoRun: false,
    });
    await seed.start();
    const created = await seed.createTask({
      request: 'Resume this task after the foreign runner claim expires.',
      source: { surface: 'api' },
      autoStart: false,
    });
    const running = await store.saveTask({ ...created.task, status: 'running' }, {
      expectedCheckpointVersion: created.task.checkpointVersion,
    });
    const foreign = await store.claimRunner(
      created.task.id,
      'agent_runner_foreign',
      1_000,
      running.task.checkpointVersion,
    );
    await seed.stop();

    const successor = createRuntime({
      store,
      provider: askUserProvider('Successor resumed after TTL.'),
      runnerId: 'agent_runner_successor',
      runnerClaimTtlMs: 300,
    });
    expect(Date.parse(foreign.task.runnerClaim!.expiresAt)).toBeGreaterThan(Date.now());
    await successor.start();
    try {
      expect((await store.getTask(created.task.id))?.task.runnerClaim?.runnerId).toBe('agent_runner_foreign');
      const waiting = await waitForStatus(successor, created.task.id, 'waiting-for-user', 5_000);
      const claims = waiting.events.filter((event) => event.type === 'runner.claimed');
      expect(claims.at(-1)?.payload?.runnerId).toBe('agent_runner_successor');
      expect(waiting.events.some((event) => event.type === 'task.interrupted')).toBe(true);
      expect(waiting.task.messages.at(-1)?.content).toBe('Successor resumed after TTL.');
    } finally {
      await successor.stop();
    }
  }, 10_000);

  it('settles pause followed by cancel as cancelled instead of paused', async () => {
    const provider = new ControlledModelProvider();
    const runtime = createRuntime({
      store: new InMemoryAgentTaskStore(),
      provider,
      runnerId: 'agent_runner_pause_cancel',
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Pause and then cancel this active model run.',
        source: { surface: 'api' },
      });
      await provider.started;
      const pauseRequested = await runtime.pause(created.task.id);
      expect(pauseRequested.task.pauseRequested).toBe(true);
      const cancelling = await runtime.cancel(created.task.id);
      expect(cancelling.task.cancellationRequested).toBe(true);
      provider.finish();

      const cancelled = await waitForStatus(runtime, created.task.id, 'cancelled', 5_000);
      expect(cancelled.task.status).toBe('cancelled');
      expect(cancelled.task.terminalReason?.code).toBe('cancelled-by-user');
      expect(cancelled.events.some((event) => event.type === 'task.cancelled')).toBe(true);
      const released = await waitForReleased(runtime, created.task.id, 5_000);
      expect(released.task.runnerClaim).toBeUndefined();
      expect(released.events.some((event) => event.type === 'runner.released')).toBe(true);
    } finally {
      provider.finish();
      await runtime.stop();
    }
  }, 10_000);

  it('ends a non-cooperative model stage with budget-exhausted when maxWallTimeMs elapses', async () => {
    const provider = new NonCooperativeBlockingProvider();
    const runtime = createRuntime({
      store: new InMemoryAgentTaskStore(),
      provider,
      runnerId: 'agent_runner_wall_budget',
      runnerClaimTtlMs: 300,
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Exhaust the bounded wall-time during this active model stage.',
        source: { surface: 'api' },
        budgets: { maxWallTimeMs: 1_000 },
      });
      await provider.started;

      const failed = await waitForStatus(runtime, created.task.id, 'failed', 5_000);
      expect(failed.task.terminalReason).toMatchObject({
        code: 'budget-exhausted',
        detail: { exhaustedBy: 'max-wall-time' },
      });
      expect(failed.task.terminalReason?.summary).toContain('wall-time budget expired');
      expect(failed.events.some((event) => event.type === 'task.failed')).toBe(true);
    } finally {
      await runtime.stop();
    }
  }, 10_000);

  it('retries the initial runner claim after a concurrent message CAS change', async () => {
    const store = new ClaimConflictStore();
    const runtime = createRuntime({
      store,
      provider: askUserProvider('The claim retry retained the concurrent message.'),
      runnerId: 'agent_runner_claim_conflict',
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Keep auto-start durable across the initial claim race.',
        source: { surface: 'api' },
      });
      expect(created.task.status).toBe('preparing');
      await store.firstClaimStarted;
      await runtime.sendMessage(created.task.id, {
        messageId: 'claim-conflict-message',
        content: 'Concurrent context committed before runner ownership.',
      });
      store.releaseFirstClaim();

      const waiting = await waitForStatus(runtime, created.task.id, 'waiting-for-user', 5_000);
      expect(store.claimAttempts).toBeGreaterThanOrEqual(2);
      expect(waiting.task.messages.some((message) => message.id === 'claim-conflict-message')).toBe(true);
      expect(waiting.events.filter((event) => event.type === 'runner.claimed')).toHaveLength(1);
      expect(waiting.task.messages.at(-1)?.content).toBe('The claim retry retained the concurrent message.');
    } finally {
      store.releaseFirstClaim();
      await runtime.stop();
    }
  }, 10_000);

  it('retries runner release after a concurrent checkpoint commit', async () => {
    const store = new ReleaseConflictStore();
    const runtime = createRuntime({
      store,
      provider: askUserProvider('Release the runner after this checkpoint.'),
      runnerId: 'agent_runner_release_conflict',
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Preserve the concurrent checkpoint while releasing the runner.',
        source: { surface: 'api' },
      });
      await waitForStatus(runtime, created.task.id, 'waiting-for-user', 5_000);
      const released = await waitForReleased(runtime, created.task.id, 5_000);
      expect(store.injectedConflicts).toBe(1);
      expect(released.task.runnerClaim).toBeUndefined();
      expect(released.task.messages.some((message) => message.id === 'release-conflict-message')).toBe(true);
      expect(released.events.at(-1)?.type).toBe('runner.released');
    } finally {
      await runtime.stop();
    }
  });

  it('retries runner renewal after a benign concurrent checkpoint commit', async () => {
    const store = new RenewConflictStore();
    const runtime = createRuntime({
      store,
      provider: new ReplayAgentDecisionProvider([
        JSON.stringify({
          kind: 'revise-plan',
          summary: 'Revise before the next bounded decision.',
          steps: [{ title: 'Continue after renewal.', expectedEffect: 'A clarification is requested.' }],
          reason: 'Exercise renewal conflict recovery.',
        }),
        JSON.stringify({ kind: 'ask-user', question: 'Renewal recovered. Continue?', reason: 'Regression fixture.' }),
      ]),
      runnerId: 'agent_runner_renew_conflict',
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Preserve concurrent state during runner renewal.',
        source: { surface: 'api' },
      });
      const waiting = await waitForStatus(runtime, created.task.id, 'waiting-for-user', 5_000);
      expect(store.injectedConflicts).toBe(1);
      expect(waiting.task.messages.some((message) => message.id === 'renew-conflict-message')).toBe(true);
      expect(waiting.task.terminalReason).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });
});

class ReleaseConflictStore extends InMemoryAgentTaskStore {
  injectedConflicts = 0;

  override async releaseRunner(
    taskId: string,
    claimId: string,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ) {
    if (this.injectedConflicts === 0) {
      this.injectedConflicts += 1;
      const current = (await this.getTask(taskId))!;
      await this.saveTask({
        ...current.task,
        messages: [...current.task.messages, {
          id: 'release-conflict-message',
          role: 'user',
          kind: 'clarification',
          createdAt: new Date().toISOString(),
          content: 'Concurrent durable message.',
        }],
      }, { expectedCheckpointVersion: current.task.checkpointVersion });
    }
    return super.releaseRunner(taskId, claimId, expectedCheckpointVersion, clientRequestId);
  }
}

class CountingRenewStore extends InMemoryAgentTaskStore {
  renewCalls = 0;

  override async renewRunner(
    taskId: string,
    claimId: string,
    ttlMs: number,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ) {
    this.renewCalls += 1;
    return super.renewRunner(taskId, claimId, ttlMs, expectedCheckpointVersion, clientRequestId);
  }
}

class RenewConflictStore extends InMemoryAgentTaskStore {
  injectedConflicts = 0;

  override async renewRunner(
    taskId: string,
    claimId: string,
    ttlMs: number,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ) {
    if (this.injectedConflicts === 0) {
      this.injectedConflicts += 1;
      const current = (await this.getTask(taskId))!;
      await this.saveTask({
        ...current.task,
        messages: [...current.task.messages, {
          id: 'renew-conflict-message',
          role: 'user',
          kind: 'clarification',
          createdAt: new Date().toISOString(),
          content: 'Concurrent durable message during renewal.',
        }],
      }, { expectedCheckpointVersion: current.task.checkpointVersion });
    }
    return super.renewRunner(taskId, claimId, ttlMs, expectedCheckpointVersion, clientRequestId);
  }
}

class ClaimConflictStore extends InMemoryAgentTaskStore {
  private resolveFirstClaimStarted!: () => void;
  private releaseBlockedClaim!: () => void;
  readonly firstClaimStarted = new Promise<void>((resolve) => { this.resolveFirstClaimStarted = resolve; });
  private readonly blockedClaim = new Promise<void>((resolve) => { this.releaseBlockedClaim = resolve; });
  claimAttempts = 0;

  override async claimRunner(
    taskId: string,
    runnerId: string,
    ttlMs: number,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ) {
    this.claimAttempts += 1;
    if (this.claimAttempts === 1) {
      this.resolveFirstClaimStarted();
      await this.blockedClaim;
    }
    return super.claimRunner(taskId, runnerId, ttlMs, expectedCheckpointVersion, clientRequestId);
  }

  releaseFirstClaim(): void {
    this.releaseBlockedClaim();
  }
}

function createRuntime(options: {
  store: InMemoryAgentTaskStore;
  provider: AgentDecisionProvider;
  runnerId: string;
  runnerClaimTtlMs?: number;
  decisionCycleBudgetMs?: number;
  autoRun?: boolean;
}): MonarchAgentRuntime {
  const adapter = new AgentKernelExecutionAdapter(
    async (submission) => ({
      proposal: toProposal(submission.proposal),
      result: { ok: true, summary: 'Lifecycle fixture execution is unused.' },
    }),
    (submission) => toProposal(submission.proposal),
  );
  return new MonarchAgentRuntime({
    store: options.store,
    decisionProvider: options.provider,
    executionAdapter: adapter,
    listCapabilities: () => [fixtureCapability],
    getPermissionProfile: () => ({ sandboxMode: 'read-only', approvalPolicy: 'on-request' }),
    runnerId: options.runnerId,
    ...(options.runnerClaimTtlMs ? { runnerClaimTtlMs: options.runnerClaimTtlMs } : {}),
    ...(options.decisionCycleBudgetMs !== undefined
      ? { decisionCycleBudgetMs: options.decisionCycleBudgetMs }
      : {}),
    ...(options.autoRun !== undefined ? { autoRun: options.autoRun } : {}),
  });
}

function askUserProvider(question: string): ReplayAgentDecisionProvider {
  return new ReplayAgentDecisionProvider([
    JSON.stringify({ kind: 'ask-user', question, reason: 'Lifecycle regression fixture.' }),
  ]);
}

class ControlledModelProvider implements AgentDecisionProvider {
  private resolveStarted!: () => void;
  private resolveDecision: ((response: AgentModelDecisionResponse) => void) | undefined;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });

  decide(): Promise<AgentModelDecisionResponse> {
    this.resolveStarted();
    return new Promise((resolve) => { this.resolveDecision = resolve; });
  }

  finish(): void {
    this.resolveDecision?.({ ok: false, error: 'controlled-model-finished' });
  }
}

class NonCooperativeBlockingProvider implements AgentDecisionProvider {
  private resolveStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });

  decide(_request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.resolveStarted();
    return new Promise(() => undefined);
  }
}

class SlowInvalidRepairProvider implements AgentDecisionProvider {
  calls = 0;

  async decide(): Promise<AgentModelDecisionResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        ok: true,
        rawText: '{"kind":"unknown"}',
        role: 'fixture',
        adapter: 'fixture',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      ok: true,
      rawText: '{"kind":"unknown"}',
      role: 'fixture',
      adapter: 'fixture',
    };
  }
}

function toProposal(input: MonarchActionProposalInput | MonarchActionProposalV1): MonarchActionProposalV1 {
  const proposal = input as MonarchActionProposalInput;
  const args = (proposal.args || proposal.input || proposal.parameters || {}) as Record<string, unknown>;
  return {
    version: 1,
    proposalId: proposal.proposalId || 'proposal_lifecycle_fixture',
    intentId: proposal.intentId || 'task_lifecycle_fixture',
    intentHash: 'intent-hash-lifecycle-fixture',
    capabilityId: proposal.capabilityId,
    args,
    reason: proposal.reason || 'Lifecycle fixture action.',
    expectedEffect: proposal.expectedEffect || 'Lifecycle fixture observation.',
    reversibility: 'reversible',
    scope: { level: 'single-object' },
    riskVector: {
      effect: 'read',
      scope: 'single-object',
      reversibility: 'reversible',
      externality: 'local',
      privilege: 'user',
      data: 'workspace',
      novelty: 'known-capability',
    },
    idempotencyKey: 'action:lifecycle-fixture',
    canonicalHash: 'canonical-lifecycle-fixture',
    ...(proposal.preconditions ? { preconditions: proposal.preconditions } : {}),
    ...(proposal.verification ? { verification: proposal.verification } : {}),
    provenance: { model: 'fixture', skillIds: [], source: 'model-tool-call' },
  };
}

async function waitForStatus(
  runtime: MonarchAgentRuntime,
  taskId: string,
  status: string,
  timeoutMs: number,
): Promise<AgentTaskCheckpoint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const checkpoint = await runtime.getTask(taskId);
    if (checkpoint?.task.status === status) return checkpoint;
    if (checkpoint && ['completed', 'failed', 'cancelled'].includes(checkpoint.task.status)) {
      throw new Error(
        `Task reached ${checkpoint.task.status} instead of ${status}: ${checkpoint.task.terminalReason?.summary || 'no detail'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const checkpoint = await runtime.getTask(taskId);
  throw new Error(
    `Timed out waiting for ${taskId} to reach ${status}; current=${checkpoint?.task.status || 'missing'}.`,
  );
}

async function waitForReleased(
  runtime: MonarchAgentRuntime,
  taskId: string,
  timeoutMs: number,
): Promise<AgentTaskCheckpoint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const checkpoint = await runtime.getTask(taskId);
    if (checkpoint && !checkpoint.task.runnerClaim && checkpoint.events.some((event) => event.type === 'runner.released')) {
      return checkpoint;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const checkpoint = await runtime.getTask(taskId);
  throw new Error(
    `Timed out waiting for ${taskId} runner release; claim=${JSON.stringify(checkpoint?.task.runnerClaim || null)}; `
    + `lastEvent=${checkpoint?.events.at(-1)?.type || 'none'}.`,
  );
}
