import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentTaskRunnerClaimError,
  AgentTaskStoreConflictError,
  AgentTaskStoreCorruptionError,
  AgentTaskStoreLockTimeoutError,
  AgentTaskStoreValidationError,
  InMemoryAgentTaskStore,
  LocalJsonAgentTaskStore,
} from '../../src/agent/agent-task-store';
import {
  AGENT_APPROVAL_SCHEMA_VERSION,
  AGENT_OBSERVATION_SCHEMA_VERSION,
  AGENT_TASK_SCHEMA_VERSION,
  type AgentApproval,
  type AgentObservation,
  type AgentTask,
  type AgentTaskStatus,
} from '../../src/agent/types';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('InMemoryAgentTaskStore', () => {
  it('creates versioned tasks, sequences events, subscribes, and replays client requests idempotently', async () => {
    const clock = mutableClock('2026-07-22T10:00:00.000Z');
    const store = new InMemoryAgentTaskStore({ now: clock.now });
    const listener = vi.fn();
    const unsubscribe = store.subscribe('task_alpha', listener);
    const input = createTask('task_alpha');

    const createOptions = {
      clientRequestId: 'request_create_alpha',
      events: [{ type: 'plan.created' as const, payload: { revision: 1 } }],
    };
    const created = await store.createTask(input, createOptions);
    const replayed = await store.createTask(input, createOptions);

    expect(created.replayed).toBe(false);
    expect(created.task.checkpointVersion).toBe(1);
    expect(created.task.eventSequence).toBe(2);
    expect(created.checkpoint.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(created.checkpoint.events.map((event) => event.type)).toEqual(['task.created', 'plan.created']);
    expect(created.checkpoint.events.every((event) => event.traceId === input.traceId)).toBe(true);
    expect(replayed.replayed).toBe(true);
    expect(replayed.task.checkpointVersion).toBe(1);
    expect(replayed.task.eventSequence).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await store.saveTask(
      { ...created.task, status: 'preparing' },
      {
        expectedCheckpointVersion: 1,
        events: [{ type: 'task.status.changed', payload: { status: 'preparing' } }],
      },
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('enforces checkpoint CAS and atomically persists full observations and approvals', async () => {
    const store = new InMemoryAgentTaskStore();
    const created = await store.createTask(createTask('task_cas'));
    const observation = createObservation('task_cas');
    const approval = createApproval('task_cas');
    const taskToSave: AgentTask = {
      ...created.task,
      status: 'waiting-for-approval',
      activeApprovalId: approval.id,
      observations: [{
        id: observation.id,
        taskId: observation.taskId,
        status: observation.status,
        summary: observation.summary,
        occurredAt: observation.occurredAt,
      }],
      approvals: [{
        id: approval.id,
        taskId: approval.taskId,
        status: approval.status,
        capabilityId: approval.capabilityId,
        canonicalProposalHash: approval.canonicalProposalHash,
      }],
    };
    const saveOptions = {
      expectedCheckpointVersion: 1,
      clientRequestId: 'request_save_cas',
      observations: [observation],
      approvals: [approval],
      events: [
        { type: 'observation.created' as const, payload: { observationId: observation.id } },
        { type: 'approval.required' as const, payload: { approvalId: approval.id } },
      ],
    };
    const saved = await store.saveTask(taskToSave, saveOptions);

    expect(saved.task.checkpointVersion).toBe(2);
    expect(saved.checkpoint.observations).toEqual([observation]);
    expect(saved.checkpoint.approvals).toEqual([approval]);
    expect(saved.checkpoint.approvals[0]?.proposal).toEqual(approval.proposal);
    const replayed = await store.saveTask(taskToSave, saveOptions);
    expect(replayed.replayed).toBe(true);
    expect(replayed.task.checkpointVersion).toBe(2);
    await expect(store.saveTask({ ...taskToSave, status: 'paused' }, saveOptions)).rejects.toBeInstanceOf(
      AgentTaskStoreValidationError,
    );
    await expect(store.saveTask(created.task, { expectedCheckpointVersion: 1 })).rejects.toBeInstanceOf(
      AgentTaskStoreConflictError,
    );
  });

  it('claims, renews, releases, and rejects the wrong runner claim', async () => {
    const clock = mutableClock('2026-07-22T10:00:00.000Z');
    const store = new InMemoryAgentTaskStore({ now: clock.now });
    const created = await store.createTask(createTask('task_claim'));
    const claimed = await store.claimRunner('task_claim', 'runner_primary', 1_000, 1);

    expect(claimed.task.runnerClaim?.runnerId).toBe('runner_primary');
    await expect(store.saveTask({
      ...claimed.task,
      runnerClaim: claimed.task.runnerClaim
        ? { ...claimed.task.runnerClaim, runnerId: 'runner_bypass' }
        : undefined,
    } as AgentTask, { expectedCheckpointVersion: 2 })).rejects.toBeInstanceOf(AgentTaskStoreValidationError);
    await expect(store.releaseRunner('task_claim', 'agent_claim_wrong', 2)).rejects.toBeInstanceOf(
      AgentTaskRunnerClaimError,
    );

    clock.advance(200);
    const renewed = await store.renewRunner(
      'task_claim',
      claimed.task.runnerClaim?.claimId ?? '',
      2_000,
      2,
    );
    expect(Date.parse(renewed.task.runnerClaim?.expiresAt ?? '')).toBe(clock.value() + 2_000);
    const released = await store.releaseRunner(
      'task_claim',
      renewed.task.runnerClaim?.claimId ?? '',
      3,
    );
    expect(released.task.runnerClaim).toBeUndefined();
  });

  it('fences saveTask against a missing, changed, or expired expected runner claim', async () => {
    const clock = mutableClock('2026-07-22T10:00:00.000Z');
    const store = new InMemoryAgentTaskStore({ now: clock.now });
    const created = await store.createTask(createTask('task_save_fence'));
    const claimed = await store.claimRunner('task_save_fence', 'runner_save_fence', 1_000, created.task.checkpointVersion);
    const claimId = claimed.task.runnerClaim!.claimId;

    const saved = await store.saveTask({ ...claimed.task, status: 'running' }, {
      expectedCheckpointVersion: claimed.task.checkpointVersion,
      expectedRunnerClaimId: claimId,
    });
    expect(saved.task.checkpointVersion).toBe(3);

    await expect(store.saveTask(saved.task, {
      expectedCheckpointVersion: saved.task.checkpointVersion,
      expectedRunnerClaimId: 'agent_claim_successor',
    })).rejects.toBeInstanceOf(AgentTaskRunnerClaimError);

    clock.advance(1_001);
    await expect(store.saveTask(saved.task, {
      expectedCheckpointVersion: saved.task.checkpointVersion,
      expectedRunnerClaimId: claimId,
    })).rejects.toBeInstanceOf(AgentTaskRunnerClaimError);
    expect((await store.getTask('task_save_fence'))?.task.checkpointVersion).toBe(3);
  });

  it('recovers expired active claims as interrupted while preserving waits and terminal states', async () => {
    const clock = mutableClock('2026-07-22T10:00:00.000Z');
    const store = new InMemoryAgentTaskStore({ now: clock.now });
    await prepareClaimedStatus(store, 'task_running', 'running');
    await prepareClaimedStatus(store, 'task_waiting', 'waiting-for-user');
    await prepareClaimedStatus(store, 'task_terminal', 'completed');

    clock.advance(1_001);
    const recovered = await store.recoverExpiredClaims();
    const byId = new Map(recovered.map((commit) => [commit.task.id, commit]));

    expect(byId.get('task_running')?.task.status).toBe('interrupted');
    expect(byId.get('task_running')?.task.recovery).toMatchObject({
      reason: 'runner-claim-expired',
      previousStatus: 'running',
    });
    expect(byId.get('task_running')?.appendedEvents.map((event) => event.type)).toEqual([
      'runner.released',
      'task.interrupted',
    ]);
    expect(byId.get('task_waiting')?.task.status).toBe('waiting-for-user');
    expect(byId.get('task_terminal')?.task.status).toBe('completed');
    expect(recovered.every((commit) => commit.task.runnerClaim === undefined)).toBe(true);
  });

  it('rejects non-JSON fields and hidden reasoning or raw prompts', async () => {
    const store = new InMemoryAgentTaskStore();
    const withPrompt = createTask('task_secret') as AgentTask & { rawPrompt: string };
    withPrompt.rawPrompt = 'do not persist this';
    await expect(store.createTask(withPrompt)).rejects.toBeInstanceOf(AgentTaskStoreValidationError);

    const withDate = createTask('task_non_json') as AgentTask & { extra: Date };
    withDate.extra = new Date();
    await expect(store.createTask(withDate)).rejects.toBeInstanceOf(AgentTaskStoreValidationError);
  });
});

describe('LocalJsonAgentTaskStore', () => {
  it('serializes runner fencing with successor claims under the store lock', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const clock = mutableClock('2026-07-22T10:00:00.000Z');
    const staleRunner = new LocalJsonAgentTaskStore(filePath, { now: clock.now, retryDelayMs: 2 });
    const successor = new LocalJsonAgentTaskStore(filePath, { now: clock.now, retryDelayMs: 2 });
    const created = await staleRunner.createTask(createTask('task_disk_fence'));
    const claimed = await staleRunner.claimRunner(
      created.task.id,
      'runner_disk_stale',
      1_000,
      created.task.checkpointVersion,
    );
    const staleClaimId = claimed.task.runnerClaim!.claimId;
    clock.advance(1_001);

    const [staleSave, successorClaim] = await Promise.allSettled([
      staleRunner.saveTask({ ...claimed.task, status: 'running' }, {
        expectedCheckpointVersion: claimed.task.checkpointVersion,
        expectedRunnerClaimId: staleClaimId,
      }),
      successor.claimRunner(
        created.task.id,
        'runner_disk_successor',
        1_000,
        claimed.task.checkpointVersion,
      ),
    ]);

    expect(staleSave).toEqual(expect.objectContaining({
      status: 'rejected',
      reason: expect.any(AgentTaskRunnerClaimError),
    }));
    expect(successorClaim).toEqual(expect.objectContaining({ status: 'fulfilled' }));
    expect((await staleRunner.getTask(created.task.id))?.task.runnerClaim?.runnerId).toBe('runner_disk_successor');
  });

  it('persists across store instances and serializes writers with a cross-process lock file', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const first = new LocalJsonAgentTaskStore(filePath);
    const second = new LocalJsonAgentTaskStore(filePath);

    await Promise.all([
      first.createTask(createTask('task_disk_a')),
      second.createTask(createTask('task_disk_b')),
    ]);

    const restarted = new LocalJsonAgentTaskStore(filePath);
    expect((await restarted.listTasks()).map((task) => task.id)).toEqual(['task_disk_a', 'task_disk_b']);
    const files = await readdir(root);
    expect(files).toEqual(['agent-tasks.json']);
  });

  it('fences and retries a writer whose lock expires before replace without losing a concurrent commit', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const clock = mutableClock('2026-07-22T10:00:00.000Z');
    const first = new LocalJsonAgentTaskStore(filePath, {
      now: clock.now,
      pid: 11_111,
      isProcessAlive: () => true,
      lockTtlMs: 100,
      retryDelayMs: 2,
      lockTimeoutMs: 1_000,
    });
    const second = new LocalJsonAgentTaskStore(filePath, {
      now: clock.now,
      pid: 22_222,
      isProcessAlive: () => true,
      lockTtlMs: 100,
      retryDelayMs: 2,
      lockTimeoutMs: 1_000,
    });
    type TestableAtomicWriter = {
      writeDocumentAtomically(
        document: unknown,
        lease: { assertOwned(): Promise<void>; release(): Promise<void> },
      ): Promise<void>;
    };
    const firstWriter = first as unknown as TestableAtomicWriter;
    const originalWrite = firstWriter.writeDocumentAtomically.bind(first);
    let resolveWriteStarted!: () => void;
    let resumeFirstWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { resolveWriteStarted = resolve; });
    const firstWriteMayResume = new Promise<void>((resolve) => { resumeFirstWrite = resolve; });
    let delayFirstWrite = true;
    firstWriter.writeDocumentAtomically = async (document, lease) => {
      if (delayFirstWrite) {
        delayFirstWrite = false;
        resolveWriteStarted();
        await firstWriteMayResume;
      }
      await originalWrite(document, lease);
    };

    const firstCommitPromise = first.createTask(createTask('task_fenced_writer_a'));
    await writeStarted;
    clock.advance(101);
    const secondCommit = await second.createTask(createTask('task_fenced_writer_b'));
    resumeFirstWrite();
    const firstCommit = await firstCommitPromise;

    expect(firstCommit.task.id).toBe('task_fenced_writer_a');
    expect(secondCommit.task.id).toBe('task_fenced_writer_b');
    const restarted = new LocalJsonAgentTaskStore(filePath, { now: clock.now });
    expect((await restarted.listTasks()).map((task) => task.id)).toEqual([
      'task_fenced_writer_a',
      'task_fenced_writer_b',
    ]);
  });

  it('surfaces corrupt state and never overwrites it', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const corrupt = '{"schemaVersion":"monarch.agent-task-store.v2","tasks":';
    await writeFile(filePath, corrupt, 'utf8');
    const store = new LocalJsonAgentTaskStore(filePath);

    await expect(store.createTask(createTask('task_no_overwrite'))).rejects.toBeInstanceOf(
      AgentTaskStoreCorruptionError,
    );
    expect(await readFile(filePath, 'utf8')).toBe(corrupt);
  });

  it('removes a stale dead-pid lock but never steals a live-pid lock', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const lockPath = `${filePath}.lock.foreign_lock.json`;
    const lock = {
      schemaVersion: 'monarch.agent-task-lock.v1',
      ownerId: 'foreign_lock',
      pid: 424_242,
      state: 'held',
      ticket: 1,
      createdAt: '2026-07-22T10:00:00.000Z',
      expiresAt: '2099-07-22T10:00:00.000Z',
    };
    await writeFile(lockPath, `${JSON.stringify(lock)}\n`, 'utf8');
    const recoverable = new LocalJsonAgentTaskStore(filePath, {
      isProcessAlive: (pid) => pid !== 424_242,
      retryDelayMs: 2,
      lockTimeoutMs: 1_000,
    });
    const competingRecovery = new LocalJsonAgentTaskStore(filePath, {
      isProcessAlive: (pid) => pid !== 424_242,
      retryDelayMs: 2,
      lockTimeoutMs: 1_000,
    });
    await Promise.all([
      recoverable.createTask(createTask('task_after_stale_lock')),
      competingRecovery.createTask(createTask('task_after_stale_lock_2')),
    ]);

    await writeFile(lockPath, `${JSON.stringify(lock)}\n`, 'utf8');
    const blocked = new LocalJsonAgentTaskStore(filePath, {
      isProcessAlive: () => true,
      retryDelayMs: 2,
      lockTimeoutMs: 20,
    });
    await expect(blocked.saveTask(
      (await blocked.getTask('task_after_stale_lock'))?.task ?? createTask('impossible'),
      { expectedCheckpointVersion: 1 },
    )).rejects.toBeInstanceOf(AgentTaskStoreLockTimeoutError);
    expect(await readFile(lockPath, 'utf8')).toBe(`${JSON.stringify(lock)}\n`);
  });

  it('removes an expired parsed lock even when its reused pid appears alive', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const lockPath = `${filePath}.lock.reused_live_pid.json`;
    const clock = mutableClock('2026-07-22T10:00:00.000Z');
    const expiredLock = {
      schemaVersion: 'monarch.agent-task-lock.v1',
      ownerId: 'reused_live_pid',
      pid: 424_242,
      state: 'held',
      ticket: 1,
      createdAt: '2026-07-22T09:59:00.000Z',
      expiresAt: '2026-07-22T09:59:30.000Z',
    };
    await writeFile(lockPath, `${JSON.stringify(expiredLock)}\n`, 'utf8');
    const store = new LocalJsonAgentTaskStore(filePath, {
      now: clock.now,
      isProcessAlive: () => true,
      retryDelayMs: 2,
      lockTimeoutMs: 1_000,
    });

    await expect(store.createTask(createTask('task_after_expired_live_pid_lock'))).resolves.toBeDefined();
    expect(await readdir(root)).toEqual(['agent-tasks.json']);
  });
});

async function prepareClaimedStatus(
  store: InMemoryAgentTaskStore,
  taskId: string,
  status: AgentTaskStatus,
): Promise<void> {
  await store.createTask(createTask(taskId));
  const claimed = await store.claimRunner(taskId, `runner_${taskId}`, 1_000, 1);
  await store.saveTask(
    {
      ...claimed.task,
      status,
      ...(status === 'completed'
        ? {
          completedAt: claimed.task.updatedAt,
          terminalReason: { code: 'completed' as const, summary: 'Verified completion.' },
        }
        : {}),
    },
    { expectedCheckpointVersion: 2 },
  );
}

function createTask(id: string): AgentTask {
  const timestamp = '2026-07-22T10:00:00.000Z';
  return {
    schemaVersion: AGENT_TASK_SCHEMA_VERSION,
    id,
    traceId: `trace_${id}`,
    source: { surface: 'desktop', requestId: `source_${id}` },
    goal: {
      originalRequest: `Complete ${id}`,
      normalizedObjective: `Complete durable task ${id}`,
      expectedOutputs: [{ id: 'output_1', description: 'Verified result', required: true }],
      constraints: [{ id: 'constraint_1', description: 'Stay local', kind: 'safety' }],
      successCriteria: [{ id: 'criterion_1', description: 'Result is verified' }],
    },
    status: 'created',
    messages: [{
      id: `message_${id}`,
      role: 'user',
      kind: 'request',
      content: `Complete ${id}`,
      createdAt: timestamp,
    }],
    observations: [],
    artifacts: [],
    approvals: [],
    budgets: {
      maxSteps: 12,
      maxModelTurns: 8,
      maxToolCalls: 24,
      maxWallTimeMs: 60_000,
      maxFailures: 3,
      maxConsecutiveNoProgress: 2,
      maxComputeClass: 'medium',
    },
    usage: {
      steps: 0,
      modelTurns: 0,
      toolCalls: 0,
      failures: 0,
      consecutiveNoProgress: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
    checkpointVersion: 0,
    eventSequence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createObservation(taskId: string): AgentObservation {
  return {
    schemaVersion: AGENT_OBSERVATION_SCHEMA_VERSION,
    id: `observation_${taskId}`,
    taskId,
    capabilityId: 'workspace.read-file',
    status: 'success',
    summary: 'Read succeeded.',
    evidence: [{ kind: 'file', reference: 'E:\\Monarch\\README.md' }],
    artifacts: [],
    warnings: [],
    retryable: false,
    occurredAt: '2026-07-22T10:00:01.000Z',
  };
}

function createApproval(taskId: string): AgentApproval {
  return {
    schemaVersion: AGENT_APPROVAL_SCHEMA_VERSION,
    id: `approval_${taskId}`,
    taskId,
    capabilityId: 'workspace.write-file',
    canonicalProposalHash: 'sha256:proposal',
    proposal: {
      schemaVersion: 'monarch.action-proposal.v1',
      capabilityId: 'workspace.write-file',
      input: { path: 'E:\\Monarch\\report.md', contentSha256: 'sha256:content' },
    },
    status: 'pending',
    requestedAt: '2026-07-22T10:00:01.000Z',
    grantScope: 'once',
  };
}

function mutableClock(initial: string): {
  now: () => Date;
  advance: (milliseconds: number) => void;
  value: () => number;
} {
  let timestamp = Date.parse(initial);
  return {
    now: () => new Date(timestamp),
    advance: (milliseconds) => {
      timestamp += milliseconds;
    },
    value: () => timestamp,
  };
}

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'monarch-agent-task-store-'));
  temporaryRoots.push(root);
  return root;
}
