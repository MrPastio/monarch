import { describe, expect, it } from 'vitest';
import type {
  MonarchActionProposalInput,
  MonarchActionProposalV1,
  MonarchCapability,
  MonarchExecutionResult,
} from '../../src/core';
import {
  AgentKernelExecutionAdapter,
  InMemoryAgentTaskStore,
  MonarchAgentRuntime,
  ReplayAgentDecisionProvider,
  type AgentDecisionProvider,
  type AgentModelDecisionRequest,
  type AgentModelDecisionResponse,
  type AgentTask,
  type AgentTaskCheckpoint,
  type AgentTaskSaveOptions,
} from '../../src/agent';

const readCapability: MonarchCapability = {
  id: 'fixture.read',
  moduleId: 'fixture',
  title: 'Read fixture',
  description: 'Read a deterministic fixture.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string' } },
    additionalProperties: false,
  },
  agent: { idempotency: 'idempotent', cancellation: 'supported', computeClass: 'light' },
};

const writeCapability: MonarchCapability = {
  id: 'fixture.write',
  moduleId: 'fixture',
  title: 'Write fixture',
  description: 'Write a deterministic fixture.',
  risk: 'write',
  inputSchema: {
    type: 'object',
    required: ['path', 'content'],
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    additionalProperties: false,
  },
  agent: { idempotency: 'conditional', cancellation: 'supported', computeClass: 'light' },
};

describe('AgentLoop regression boundaries', () => {
  it('carries retry attempts across replacement steps and repeats an idempotent read only once', async () => {
    let toolCalls = 0;
    const runtime = createRuntime({
      provider: new ReplayAgentDecisionProvider([
        inspectDecision('fixture.txt'),
        inspectDecision('fixture.txt'),
      ]),
      execute: async (proposal) => {
        toolCalls += 1;
        return { proposal, result: { ok: false, summary: 'Temporary fixture failure.', error: 'temporary-busy' } };
      },
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({ request: 'Read the fixture with bounded recovery.', source: { surface: 'api' } });
      const failed = await waitForStatus(runtime, created.task.id, 'failed');
      expect(toolCalls).toBe(2);
      expect(failed.task.usage.toolCalls).toBe(2);
      expect(failed.events.filter((event) => event.type === 'tool.started')).toHaveLength(2);
    } finally {
      await runtime.stop();
    }
  });

  it('renews the durable runner claim while a model stage is active', async () => {
    const runtime = createRuntime({
      provider: new DelayedAskProvider(900),
      execute: async (proposal) => ({ proposal, result: { ok: true, summary: 'unused' } }),
      runnerClaimTtlMs: 300,
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({ request: 'Wait through a long model stage.', source: { surface: 'api' } });
      const waiting = await waitForStatus(runtime, created.task.id, 'waiting-for-user');
      expect(waiting.events.filter((event) => event.type === 'runner.renewed').length).toBeGreaterThanOrEqual(2);
      expect(waiting.task.status).toBe('waiting-for-user');
    } finally {
      await runtime.stop();
    }
  });

  it('rejects a completion decision that binds a required goal to a failed observation', async () => {
    const provider = new FailedEvidenceProvider();
    const runtime = createRuntime({
      provider,
      execute: async (proposal) => ({
        proposal,
        result: { ok: false, summary: 'The requested fixture is missing.', error: 'not-found' },
      }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({ request: 'Return a verified fixture answer.', source: { surface: 'api' } });
      const failed = await waitForStatus(runtime, created.task.id, 'failed');
      expect(failed.events.some((event) => event.type === 'verification.completed' && event.payload?.status === 'failed')).toBe(true);
      expect(failed.events.some((event) => event.type === 'task.completed')).toBe(false);
      expect(provider.turns).toBe(3);
    } finally {
      await runtime.stop();
    }
  });

  it('rejects an unrelated successful generic observation bound to a non-artifact goal', async () => {
    const provider = new TargetBoundCompletionProvider('unrelated.txt');
    const runtime = createRuntime({
      provider,
      execute: async (proposal) => ({
        proposal,
        result: { ok: true, summary: 'Generic fixture read succeeded.', output: { path: 'unrelated.txt', content: 'unrelated-value' } },
      }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Return the contents of requested.txt.',
        expectedOutputs: [{ id: 'requested-contents', kind: 'answer', description: 'Contents of requested.txt.' }],
        successCriteria: [{ id: 'requested-read', description: 'requested.txt was read successfully.' }],
        source: { surface: 'api' },
      });
      const failed = await waitForStatus(runtime, created.task.id, 'failed');
      expect(failed.events.some((event) => event.type === 'task.completed')).toBe(false);
      expect(failed.events.some((event) => (
        event.type === 'verification.completed'
          && Array.isArray(event.payload?.failed)
          && event.payload.failed.length > 0
      ))).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  it('does not let an absolute nested output override a different relative action target', async () => {
    const runtime = createRuntime({
      provider: new TargetBoundCompletionProvider('nested/requested.txt'),
      execute: async (proposal) => ({
        proposal,
        result: {
          ok: true,
          summary: 'Nested fixture read succeeded.',
          output: { path: 'E:/Monarch/nested/requested.txt', content: 'nested-value' },
        },
      }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Return the contents of requested.txt.',
        expectedOutputs: [{ id: 'requested-contents', kind: 'answer', description: 'Contents of requested.txt.' }],
        successCriteria: [{ id: 'requested-read', description: 'requested.txt was read successfully.' }],
        source: { surface: 'api' },
      });
      const failed = await waitForStatus(runtime, created.task.id, 'failed');
      expect(failed.events.some((event) => event.type === 'task.completed')).toBe(false);
      expect(failed.events.some((event) => (
        event.type === 'verification.completed'
        && Array.isArray(event.payload?.failed)
        && event.payload.failed.includes('expected-output:requested-contents')
      ))).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  it('accepts a successful observation whose action target matches the non-artifact goal', async () => {
    const runtime = createRuntime({
      provider: new TargetBoundCompletionProvider('requested.txt'),
      execute: async (proposal) => ({
        proposal,
        result: {
          ok: true,
          summary: 'Requested fixture read succeeded.',
          output: { path: 'E:/Monarch/requested.txt', content: 'requested-value' },
        },
      }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Return the contents of requested.txt.',
        expectedOutputs: [{ id: 'requested-contents', kind: 'answer', description: 'Contents of requested.txt.' }],
        successCriteria: [{ id: 'requested-read', description: 'requested.txt was read successfully.' }],
        source: { surface: 'api' },
      });
      const completed = await waitForStatus(runtime, created.task.id, 'completed');
      expect(completed.task.terminalReason?.code).toBe('completed');
    } finally {
      await runtime.stop();
    }
  });

  it('keeps a plain request verifiable by carrying its objective into the default output', async () => {
    const runtime = createRuntime({
      provider: new TargetBoundCompletionProvider('requested.txt'),
      execute: async (proposal) => ({
        proposal,
        result: { ok: true, summary: 'Requested fixture read succeeded.', output: { path: 'requested.txt', content: 'requested-value' } },
      }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Read requested.txt and return its verified contents.',
        source: { surface: 'api' },
      });
      const completed = await waitForStatus(runtime, created.task.id, 'completed');
      expect(completed.task.goal.expectedOutputs[0]?.description).toContain('requested.txt');
      expect(completed.task.terminalReason?.code).toBe('completed');
    } finally {
      await runtime.stop();
    }
  });

  it('rejects an answer summary that contradicts the factual bound observation output', async () => {
    const provider = new FixedBoundAnswerProvider('requested.txt contains bananas; verified size is 6 bytes.');
    const runtime = createRuntime({
      provider,
      execute: async (proposal) => ({
        proposal,
        result: {
          ok: true,
          summary: 'Requested fixture read succeeded.',
          output: { path: 'requested.txt', sizeBytes: 6, content: 'apples' },
        },
      }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Return the contents of requested.txt.',
        expectedOutputs: [{ id: 'requested-contents', kind: 'answer', description: 'Contents of requested.txt.' }],
        successCriteria: [{ id: 'requested-read', description: 'requested.txt was read successfully.' }],
        source: { surface: 'api' },
      });
      const failed = await waitForStatus(runtime, created.task.id, 'failed');
      expect(provider.turns).toBe(3);
      expect(failed.events.some((event) => event.type === 'task.completed')).toBe(false);
      expect(failed.events.some((event) => (
        event.type === 'verification.completed'
        && Array.isArray(event.payload?.failed)
        && event.payload.failed.includes('expected-output:requested-contents')
      ))).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  it('rejects a partial long-content excerpt whose remaining factual value is contradicted', async () => {
    const provider = new FixedBoundAnswerProvider('requested.txt contains alpha beta gamma omega.');
    const runtime = createRuntime({
      provider,
      execute: async (proposal) => ({
        proposal,
        result: {
          ok: true,
          summary: 'Requested fixture read succeeded.',
          output: { path: 'requested.txt', sizeBytes: 22, content: 'alpha beta gamma delta' },
        },
      }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Return the contents of requested.txt.',
        expectedOutputs: [{ id: 'requested-contents', kind: 'answer', description: 'Contents of requested.txt.' }],
        successCriteria: [{ id: 'requested-read', description: 'requested.txt was read successfully.' }],
        source: { surface: 'api' },
      });
      const failed = await waitForStatus(runtime, created.task.id, 'failed');
      expect(provider.turns).toBe(3);
      expect(failed.events.some((event) => event.type === 'task.completed')).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  it('uses explicitly requested read metadata even when the output also contains file content', async () => {
    const runtime = createRuntime({
      provider: new FixedBoundAnswerProvider('requested.txt sizeBytes is 6.'),
      execute: async (proposal) => ({
        proposal,
        result: {
          ok: true,
          summary: 'Requested fixture read succeeded.',
          output: { path: 'requested.txt', sizeBytes: 6, content: 'apples' },
        },
      }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Return the sizeBytes of requested.txt.',
        expectedOutputs: [{ id: 'requested-size', kind: 'answer', description: 'SizeBytes of requested.txt.' }],
        successCriteria: [{ id: 'requested-read', description: 'requested.txt was read successfully.' }],
        source: { surface: 'api' },
      });
      const completed = await waitForStatus(runtime, created.task.id, 'completed');
      expect(completed.task.terminalReason?.summary).toBe('6');
      expect(completed.task.messages.at(-1)?.content).toBe('6');
    } finally {
      await runtime.stop();
    }
  });

  it('redacts provider error secrets before persisting terminal state or events', async () => {
    const leakedToken = 'github_pat_1234567890abcdef1234';
    const runtime = createRuntime({
      provider: {
        decide: async () => ({ ok: false, error: `upstream rejected ${leakedToken}` }),
      },
      execute: async (proposal) => ({ proposal, result: { ok: true, summary: 'unused' } }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({ request: 'Fail without persisting provider credentials.', source: { surface: 'api' } });
      const failed = await waitForStatus(runtime, created.task.id, 'failed');
      const serialized = JSON.stringify(failed);
      expect(serialized).not.toContain(leakedToken);
      expect(serialized).toContain('[REDACTED_TOKEN]');
      expect(failed.task.terminalReason?.summary).toContain('[REDACTED_TOKEN]');
    } finally {
      await runtime.stop();
    }
  });

  it('keeps a journal-proven failed mutation in completion truth even when a later read succeeds', async () => {
    let writeCalls = 0;
    const runtime = createRuntime({
      provider: new FailedMutationThenReadProvider(),
      capabilities: [readCapability, writeCapability],
      execute: async (proposal) => {
        if (proposal.capabilityId === writeCapability.id) {
          writeCalls += 1;
          return {
            proposal,
            result: mutationResult(false, 'verification-failed', 'available'),
          };
        }
        return { proposal, result: { ok: true, summary: 'requested.txt was read.', output: { path: 'requested.txt', content: 'requested-value' } } };
      },
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Update changed.txt and return requested.txt.',
        expectedOutputs: [{ id: 'requested', kind: 'answer', description: 'Contents of requested.txt.' }],
        successCriteria: [{ id: 'requested-read', description: 'requested.txt was read successfully.' }],
        source: { surface: 'api' },
      });
      const failed = await waitForStatus(runtime, created.task.id, 'failed');
      const mutation = failed.observations.find((entry) => entry.capabilityId === writeCapability.id);
      expect(writeCalls).toBe(1);
      expect(mutation?.structuredData).toMatchObject({
        mutationTruth: { state: 'occurred', source: 'kernel-journal' },
        sideEffects: [{ target: 'changed.txt' }],
      });
      expect(failed.events.some((event) => event.type === 'task.completed')).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  it('lets a successful verified same-target retry supersede a historical failed mutation', async () => {
    let writeCalls = 0;
    const runtime = createRuntime({
      provider: new SameTargetMutationRetryProvider(),
      capabilities: [writeCapability],
      execute: async (proposal) => {
        writeCalls += 1;
        return {
          proposal,
          result: writeCalls === 1
            ? mutationResult(false, 'verification-failed', 'available')
            : mutationResult(true, undefined, 'available'),
        };
      },
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Write corrected content to state.txt.',
        expectedOutputs: [{ id: 'state', kind: 'state-change', description: 'state.txt contains corrected content.' }],
        successCriteria: [{ id: 'state-verified', description: 'state.txt is verified after the retry.' }],
        source: { surface: 'api' },
      });
      const completed = await waitForStatus(runtime, created.task.id, 'completed');
      expect(writeCalls).toBe(2);
      expect(completed.observations.map((entry) => entry.status)).toEqual(['failed', 'success']);
      expect(completed.task.terminalReason?.code).toBe('completed');
    } finally {
      await runtime.stop();
    }
  });

  it('propagates cancellation to an active tool worker and checkpoints its cancelled observation', async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    let workerSignal: AbortSignal | undefined;
    const runtime = createRuntime({
      provider: new ReplayAgentDecisionProvider([inspectDecision('slow.txt')]),
      execute: (proposal, signal) => new Promise((resolve) => {
        workerSignal = signal;
        releaseStarted();
        if (signal?.aborted) {
          resolve({ proposal, result: { ok: false, summary: 'Tool cancelled.', error: 'cancelled' } });
          return;
        }
        signal?.addEventListener('abort', () => resolve({
          proposal,
          result: { ok: false, summary: 'Tool cancelled.', error: 'cancelled' },
        }), { once: true });
      }),
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({ request: 'Cancel the slow fixture read.', source: { surface: 'api' } });
      await started;
      await runtime.cancel(created.task.id);
      const cancelled = await waitForStatus(runtime, created.task.id, 'cancelled');
      expect(workerSignal?.aborted).toBe(true);
      expect(cancelled.observations).toHaveLength(1);
      expect(cancelled.observations[0]?.status).toBe('cancelled');
      expect(cancelled.events.some((event) => event.type === 'tool.completed')).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  it('settles foreign cancellation even when a read tool ignores AbortSignal', async () => {
    const store = new InMemoryAgentTaskStore();
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const primary = createRuntime({
      store,
      runnerId: 'agent_runner_noncooperative_primary',
      provider: new ReplayAgentDecisionProvider([inspectDecision('slow.txt')]),
      execute: () => {
        releaseStarted();
        return new Promise(() => undefined);
      },
    });
    const controller = createRuntime({
      store,
      runnerId: 'agent_runner_noncooperative_controller',
      provider: new ReplayAgentDecisionProvider([]),
      execute: async (proposal) => ({ proposal, result: { ok: true, summary: 'unused' } }),
    });
    await Promise.all([primary.start(), controller.start()]);
    try {
      const created = await primary.createTask({
        request: 'Cancel a non-cooperative read from another runtime.',
        source: { surface: 'api' },
      });
      await started;
      await controller.cancel(created.task.id);
      const cancelled = await waitForStatus(primary, created.task.id, 'cancelled');
      expect(cancelled.task.pendingAction?.status).toBe('dispatched');
      expect(cancelled.task.terminalReason?.code).toBe('cancelled-by-user');
    } finally {
      await Promise.all([primary.stop(), controller.stop()]);
    }
  });

  it('enforces wall time and bounded shutdown when a read tool never settles', async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const runtime = createRuntime({
      provider: new ReplayAgentDecisionProvider([inspectDecision('slow.txt')]),
      execute: () => {
        releaseStarted();
        return new Promise(() => undefined);
      },
    });
    await runtime.start();
    const created = await runtime.createTask({
      request: 'Bound a non-cooperative read by wall time.',
      source: { surface: 'api' },
      budgets: { maxWallTimeMs: 1_000 },
    });
    await started;
    const failed = await waitForStatus(runtime, created.task.id, 'failed');
    expect(failed.task.terminalReason).toMatchObject({
      code: 'budget-exhausted',
      detail: { exhaustedBy: 'max-wall-time' },
    });
    expect(failed.task.pendingAction?.status).toBe('dispatched');

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      runtime.stop().then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 300);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    expect(stopped).toBe(true);
  });

  it('does not dispatch a tool after a foreign runtime cancellation wins the dispatch CAS race', async () => {
    const store = new DispatchSaveConflictStore();
    let toolCalls = 0;
    const primary = createRuntime({
      store,
      provider: new ReplayAgentDecisionProvider([inspectDecision('requested.txt')]),
      execute: async (proposal) => {
        toolCalls += 1;
        return { proposal, result: { ok: true, summary: 'This execution must not happen.' } };
      },
    });
    const controller = createRuntime({
      store,
      provider: new ReplayAgentDecisionProvider([]),
      execute: async (proposal) => ({ proposal, result: { ok: true, summary: 'unused' } }),
    });
    await primary.start();
    await controller.start();
    try {
      const created = await primary.createTask({
        request: 'Cancel before the prepared read is dispatched.',
        source: { surface: 'api' },
      });
      await store.dispatchSaveStarted;
      await controller.cancel(created.task.id);
      store.releaseDispatchSave();

      const cancelled = await waitForStatus(primary, created.task.id, 'cancelled');
      expect(toolCalls).toBe(0);
      expect(cancelled.task.pendingAction).toBeUndefined();
      expect(cancelled.task.terminalReason?.code).toBe('cancelled-by-user');
    } finally {
      store.releaseDispatchSave();
      await Promise.all([primary.stop(), controller.stop()]);
    }
  });

  it('does not dispatch after a foreign cancellation commits immediately after tool.started', async () => {
    const store = new PostDispatchCancellationStore();
    let toolCalls = 0;
    const runtime = createRuntime({
      store,
      provider: new ReplayAgentDecisionProvider([inspectDecision('requested.txt')]),
      execute: async (proposal) => {
        toolCalls += 1;
        return { proposal, result: { ok: true, summary: 'This execution must not happen.' } };
      },
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Cancel in the post-dispatch checkpoint window.',
        source: { surface: 'api' },
      });
      const cancelled = await waitForStatus(runtime, created.task.id, 'cancelled');
      expect(store.injectedCancellations).toBe(1);
      expect(toolCalls).toBe(0);
      expect(cancelled.task.pendingAction).toBeUndefined();
      expect(cancelled.task.terminalReason?.code).toBe('cancelled-by-user');
    } finally {
      await runtime.stop();
    }
  });

  it('rebases a concurrent message after tool execution without losing or repeating the receipt', async () => {
    const store = new ToolReceiptConflictStore();
    let toolCalls = 0;
    const runtime = createRuntime({
      store,
      provider: new TargetBoundCompletionProvider('requested.txt'),
      execute: async (proposal) => {
        toolCalls += 1;
        return {
          proposal,
          result: { ok: true, summary: 'Requested fixture read succeeded.', output: { path: 'requested.txt', content: 'requested-value' } },
        };
      },
    });
    await runtime.start();
    try {
      const created = await runtime.createTask({
        request: 'Read requested.txt and preserve concurrent user context.',
        source: { surface: 'api' },
      });
      const completed = await waitForStatus(runtime, created.task.id, 'completed');
      expect(store.injectedConflicts).toBe(1);
      expect(toolCalls).toBe(1);
      expect(completed.observations).toHaveLength(1);
      expect(completed.task.messages.some((message) => message.id === 'tool-receipt-conflict-message')).toBe(true);
      expect(completed.events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });
});

class ToolReceiptConflictStore extends InMemoryAgentTaskStore {
  injectedConflicts = 0;

  override async saveTask(taskInput: AgentTask, options: AgentTaskSaveOptions) {
    if (this.injectedConflicts === 0 && options.events?.some((event) => event.type === 'tool.completed')) {
      this.injectedConflicts += 1;
      const current = (await this.getTask(taskInput.id))!;
      await super.saveTask({
        ...current.task,
        messages: [...current.task.messages, {
          id: 'tool-receipt-conflict-message',
          role: 'user',
          kind: 'clarification',
          createdAt: new Date().toISOString(),
          content: 'Concurrent context that must survive receipt persistence.',
        }],
      }, { expectedCheckpointVersion: current.task.checkpointVersion });
    }
    return super.saveTask(taskInput, options);
  }
}

class DispatchSaveConflictStore extends InMemoryAgentTaskStore {
  private resolveDispatchSaveStarted!: () => void;
  private releaseBlockedDispatch!: () => void;
  readonly dispatchSaveStarted = new Promise<void>((resolve) => { this.resolveDispatchSaveStarted = resolve; });
  private readonly blockedDispatch = new Promise<void>((resolve) => { this.releaseBlockedDispatch = resolve; });
  private blocked = false;

  override async saveTask(taskInput: AgentTask, options: AgentTaskSaveOptions) {
    if (!this.blocked && options.events?.some((event) => event.type === 'tool.started')) {
      this.blocked = true;
      this.resolveDispatchSaveStarted();
      await this.blockedDispatch;
    }
    return super.saveTask(taskInput, options);
  }

  releaseDispatchSave(): void {
    this.releaseBlockedDispatch();
  }
}

class PostDispatchCancellationStore extends InMemoryAgentTaskStore {
  injectedCancellations = 0;

  override async saveTask(taskInput: AgentTask, options: AgentTaskSaveOptions) {
    const commit = await super.saveTask(taskInput, options);
    if (
      this.injectedCancellations === 0
      && taskInput.pendingAction?.status === 'dispatched'
      && !taskInput.cancellationRequested
    ) {
      this.injectedCancellations += 1;
      await super.saveTask({
        ...commit.task,
        status: 'cancelling',
        cancellationRequested: true,
      }, {
        expectedCheckpointVersion: commit.task.checkpointVersion,
        events: [{
          type: 'task.status.changed',
          payload: { from: commit.task.status, to: 'cancelling', reason: 'foreign-cancel-test' },
        }],
      });
    }
    return commit;
  }
}

function createRuntime(options: {
  provider: AgentDecisionProvider;
  execute: (proposal: MonarchActionProposalV1, signal?: AbortSignal) => Promise<{
    proposal: MonarchActionProposalV1;
    result: MonarchExecutionResult;
  }>;
  capabilities?: MonarchCapability[];
  runnerClaimTtlMs?: number;
  store?: InMemoryAgentTaskStore;
  runnerId?: string;
}): MonarchAgentRuntime {
  const adapter = new AgentKernelExecutionAdapter(
    async (submission) => options.execute(submission.proposal as MonarchActionProposalV1, submission.signal),
    (submission) => toProposal(submission.proposal),
  );
  return new MonarchAgentRuntime({
    store: options.store || new InMemoryAgentTaskStore(),
    decisionProvider: options.provider,
    executionAdapter: adapter,
    listCapabilities: () => options.capabilities || [readCapability],
    getPermissionProfile: () => ({ sandboxMode: 'read-only', approvalPolicy: 'on-request' }),
    runnerId: options.runnerId || 'agent_runner_regression',
    ...(options.runnerClaimTtlMs ? { runnerClaimTtlMs: options.runnerClaimTtlMs } : {}),
  });
}

class DelayedAskProvider implements AgentDecisionProvider {
  constructor(private readonly delayMs: number) {}

  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({
        ok: true,
        rawText: JSON.stringify({ kind: 'ask-user', question: 'Continue?', reason: 'Long stage completed.' }),
        role: 'fixture',
      }), this.delayMs);
      request.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve({ ok: false, error: 'model-call-aborted' });
      }, { once: true });
    });
  }
}

class FailedEvidenceProvider implements AgentDecisionProvider {
  turns = 0;

  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.turns += 1;
    const context = request.compiledContext as {
      goal: { expectedOutputs: Array<{ id: string }>; successCriteria: Array<{ id: string }> };
      observations: Array<{ id: string }>;
    };
    if (this.turns === 1) return Promise.resolve({ ok: true, rawText: inspectDecision('missing.txt') });
    if (this.turns === 2) {
      const observationIds = context.observations.map((entry) => entry.id);
      return Promise.resolve({
        ok: true,
        rawText: JSON.stringify({
          kind: 'complete',
          summary: 'Incorrectly claim completion from failed evidence.',
          evidenceObservationIds: observationIds,
          artifactIds: [],
          evidenceBindings: [
            ...context.goal.expectedOutputs.map((target) => ({
              targetType: 'expected-output', targetId: target.id, observationIds, artifactIds: [],
            })),
            ...context.goal.successCriteria.map((target) => ({
              targetType: 'success-criterion', targetId: target.id, observationIds, artifactIds: [],
            })),
          ],
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      rawText: JSON.stringify({ kind: 'fail', code: 'evidence-missing', reason: 'No successful factual evidence exists.' }),
    });
  }
}

class TargetBoundCompletionProvider implements AgentDecisionProvider {
  private turns = 0;

  constructor(private readonly path: string) {}

  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.turns += 1;
    const context = request.compiledContext as {
      goal: { expectedOutputs: Array<{ id: string }>; successCriteria: Array<{ id: string }> };
      observations: Array<{ id: string; structuredData?: { output?: { content?: unknown } } }>;
    };
    if (this.turns === 1) return Promise.resolve({ ok: true, rawText: inspectDecision(this.path) });
    if (this.turns > 2) {
      return Promise.resolve({
        ok: true,
        rawText: JSON.stringify({ kind: 'fail', code: 'target-evidence-rejected', reason: 'Bound evidence was rejected.' }),
      });
    }
    const observationIds = context.observations.map((entry) => entry.id);
    const observedContent = context.observations
      .map((entry) => entry.structuredData?.output?.content)
      .find((entry): entry is string => typeof entry === 'string') || 'missing-observed-value';
    return Promise.resolve({
      ok: true,
      rawText: JSON.stringify({
        kind: 'complete',
        summary: `The verified answer is ${observedContent}.`,
        evidenceObservationIds: observationIds,
        artifactIds: [],
        evidenceBindings: [
          ...context.goal.expectedOutputs.map((target) => ({
            targetType: 'expected-output', targetId: target.id, observationIds, artifactIds: [],
          })),
          ...context.goal.successCriteria.map((target) => ({
            targetType: 'success-criterion', targetId: target.id, observationIds, artifactIds: [],
          })),
        ],
      }),
    });
  }
}

class FixedBoundAnswerProvider implements AgentDecisionProvider {
  turns = 0;

  constructor(private readonly summary: string) {}

  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.turns += 1;
    if (this.turns === 1) return Promise.resolve({ ok: true, rawText: inspectDecision('requested.txt') });
    if (this.turns > 2) {
      return Promise.resolve({
        ok: true,
        rawText: JSON.stringify({ kind: 'fail', code: 'answer-mismatch', reason: 'The proposed answer was not grounded.' }),
      });
    }
    return Promise.resolve({
      ok: true,
      rawText: boundCompletion(request, this.summary),
    });
  }
}

class FailedMutationThenReadProvider implements AgentDecisionProvider {
  private turns = 0;

  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.turns += 1;
    if (this.turns === 1) return Promise.resolve({ ok: true, rawText: writeDecision('changed.txt', 'changed') });
    if (this.turns === 2) return Promise.resolve({ ok: true, rawText: inspectDecision('requested.txt') });
    if (this.turns > 3) {
      return Promise.resolve({
        ok: true,
        rawText: JSON.stringify({ kind: 'fail', code: 'mutation-not-verified', reason: 'Historical mutation remains unresolved.' }),
      });
    }
    return Promise.resolve({ ok: true, rawText: boundCompletion(request, 'Return requested.txt after the mutation.') });
  }
}

class SameTargetMutationRetryProvider implements AgentDecisionProvider {
  private turns = 0;

  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.turns += 1;
    if (this.turns <= 2) {
      return Promise.resolve({ ok: true, rawText: writeDecision('state.txt', 'corrected') });
    }
    return Promise.resolve({ ok: true, rawText: boundCompletion(request, 'state.txt was corrected and verified.') });
  }
}

function boundCompletion(request: AgentModelDecisionRequest, summary: string): string {
  const context = request.compiledContext as {
    goal: { expectedOutputs: Array<{ id: string }>; successCriteria: Array<{ id: string }> };
    observations: Array<{ id: string; status: string }>;
  };
  const observationIds = context.observations.filter((entry) => entry.status === 'success').map((entry) => entry.id);
  return JSON.stringify({
    kind: 'complete',
    summary,
    evidenceObservationIds: observationIds,
    artifactIds: [],
    evidenceBindings: [
      ...context.goal.expectedOutputs.map((target) => ({
        targetType: 'expected-output', targetId: target.id, observationIds, artifactIds: [],
      })),
      ...context.goal.successCriteria.map((target) => ({
        targetType: 'success-criterion', targetId: target.id, observationIds, artifactIds: [],
      })),
    ],
  });
}

function writeDecision(path: string, content: string): string {
  return JSON.stringify({
    kind: 'act',
    capabilityId: writeCapability.id,
    input: { path, content },
    reason: 'Write the requested fixture.',
    expectedEffect: `${path} contains the requested content.`,
    verification: [{ kind: 'contains', target: path, value: content }],
  });
}

function mutationResult(
  ok: boolean,
  error: string | undefined,
  rollbackStatus: 'available' | 'unavailable',
): MonarchExecutionResult {
  return {
    ok,
    summary: ok ? 'Mutation verified.' : 'Mutation happened but verification failed.',
    ...(error ? { error } : {}),
    output: { path: 'state.txt' },
    metadata: {
      ledger: {
        ledgerId: `ledger-${ok ? 'success' : 'failed'}`,
        rollback: {
          status: rollbackStatus,
          targetPath: 'state.txt',
          capturedAt: '2026-07-22T10:00:00.000Z',
          updatedAt: '2026-07-22T10:00:01.000Z',
          reason: rollbackStatus === 'available'
            ? 'Action failed after a partial mutation; rollback is hash-guarded.'
            : 'Action failed without changing the journaled target.',
        },
      },
      observations: [{
        phase: 'verification',
        ok,
        code: 'contains',
        message: ok ? 'Expected content exists.' : 'Expected content is missing.',
      }],
    },
  };
}

function inspectDecision(path: string): string {
  return JSON.stringify({
    kind: 'inspect',
    capabilityId: readCapability.id,
    input: { path },
    reason: 'Read the fixture.',
    expectedEffect: 'A factual fixture observation is available.',
  });
}

function toProposal(input: MonarchActionProposalInput | MonarchActionProposalV1): MonarchActionProposalV1 {
  const proposal = input as MonarchActionProposalInput;
  const args = (proposal.args || proposal.input || proposal.parameters || {}) as Record<string, unknown>;
  return {
    version: 1,
    proposalId: proposal.proposalId || 'proposal_fixture',
    intentId: proposal.intentId || 'task_fixture',
    intentHash: 'intent-hash-fixture',
    capabilityId: proposal.capabilityId,
    args,
    reason: proposal.reason || 'Fixture action.',
    expectedEffect: proposal.expectedEffect || 'Fixture observation.',
    reversibility: 'reversible',
    scope: { level: 'single-object' },
    riskVector: {
      effect: 'read', scope: 'single-object', reversibility: 'reversible', externality: 'local',
      privilege: 'user', data: 'workspace', novelty: 'known-capability',
    },
    idempotencyKey: 'action:fixture',
    canonicalHash: 'canonical-fixture',
    ...(proposal.preconditions ? { preconditions: proposal.preconditions } : {}),
    ...(proposal.verification ? { verification: proposal.verification } : {}),
    provenance: { model: 'fixture', skillIds: [], source: 'model-tool-call' },
  };
}

async function waitForStatus(
  runtime: MonarchAgentRuntime,
  taskId: string,
  status: string,
): Promise<AgentTaskCheckpoint> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const checkpoint = await runtime.getTask(taskId);
    if (checkpoint?.task.status === status) return checkpoint;
    if (checkpoint && ['completed', 'failed', 'cancelled'].includes(checkpoint.task.status)) {
      throw new Error(
        `Task reached ${checkpoint.task.status} instead of ${status}: ${checkpoint.task.terminalReason?.summary || 'no detail'}; `
        + `verification=${JSON.stringify(checkpoint.events.filter((event) => event.type === 'verification.completed').slice(-2))}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const checkpoint = await runtime.getTask(taskId);
  throw new Error(`Timed out waiting for ${taskId} to reach ${status}; current=${checkpoint?.task.status || 'missing'}.`);
}
