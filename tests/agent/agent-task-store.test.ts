import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentTaskRunnerClaimError,
  AgentTaskStoreConflictError,
  AgentTaskStoreCorruptionError,
  AgentTaskStoreError,
  AgentTaskStoreLockTimeoutError,
  AgentTaskStoreValidationError,
  InMemoryAgentTaskStore,
  LocalJsonAgentTaskStore,
} from '../../src/agent/agent-task-store';
import {
  AGENT_APPROVAL_SCHEMA_VERSION,
  AGENT_COGNITIVE_PROFILE_SCHEMA_VERSION,
  AGENT_EXECUTION_PROFILE_SCHEMA_VERSION,
  AGENT_OBSERVATION_SCHEMA_VERSION,
  AGENT_TASK_SCHEMA_VERSION,
  AGENT_WORKING_STATE_SCHEMA_VERSION,
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

  it('rejects an impossible completed checkpoint while a durable plan step is unfinished', async () => {
    const store = new InMemoryAgentTaskStore();
    const created = await store.createTask(createTask('task_open_plan_completion'));
    const stepId = 'step_create_requested_file';
    await expect(store.saveTask({
      ...created.task,
      status: 'completed',
      completedAt: created.task.updatedAt,
      terminalReason: { code: 'completed', summary: 'Incorrect terminal claim.' },
      currentStepId: stepId,
      plan: {
        id: 'plan_open_completion',
        revision: 2,
        goalSummary: 'Create the requested file.',
        createdAt: created.task.createdAt,
        steps: [{
          id: stepId,
          title: 'Create File',
          status: 'ready',
          dependsOn: [],
          expectedEffects: [{ kind: 'artifact', description: 'The requested file exists.' }],
          verification: [{ kind: 'exists', description: 'The requested file exists.' }],
        }],
      },
    }, {
      expectedCheckpointVersion: created.task.checkpointVersion,
    })).rejects.toThrow(/cannot be completed while plan step .* is ready/i);
  });

  it('claims, renews, releases, and rejects the wrong runner claim', async () => {
    const clock = mutableClock('2026-07-22T10:00:00.000Z');
    const store = new InMemoryAgentTaskStore({ now: clock.now });
    const created = await store.createTask(createTask('task_claim'));
    const claimed = await store.claimRunner('task_claim', 'runner_primary', 1_000, 1);

    expect(claimed.task.runnerClaim?.runnerId).toBe('runner_primary');
    expect(claimed.task.status).toBe('running');
    expect((await store.getTask('task_claim'))?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.status.changed',
        payload: expect.objectContaining({ from: 'created', to: 'running', reason: 'runner-claimed' }),
      }),
    ]));
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

  it('durably validates an exact user-selected Agent decision model policy', async () => {
    const store = new InMemoryAgentTaskStore();
    const task = createTask('task_explicit_pro');
    task.decisionModelPolicy = {
      requestedRole: 'gemma4-deepthinking',
      selectionSource: 'user-explicit',
      fallback: 'exact',
    };
    const created = await store.createTask(task);

    expect(created.task.decisionModelPolicy).toEqual(task.decisionModelPolicy);
    await expect(store.createTask({
      ...createTask('task_invalid_model_policy'),
      decisionModelPolicy: {
        requestedRole: 'gemma4-31b',
        selectionSource: 'user-explicit',
        fallback: 'silent-downgrade',
      } as AgentTask['decisionModelPolicy'],
    } as AgentTask)).rejects.toBeInstanceOf(AgentTaskStoreValidationError);
  });

  it('persists the runtime-owned Coder execution profile and rejects it on another surface', async () => {
    const store = new InMemoryAgentTaskStore();
    const task = createTask('task_coder_profile');
    task.source = { surface: 'coder', requestId: 'coder_profile_request' };
    task.executionProfile = {
      schemaVersion: AGENT_EXECUTION_PROFILE_SCHEMA_VERSION,
      kind: 'coder-project',
      projectId: 'project-profile-test',
      projectRoot: 'E:\\SyntheticCoder\\project-profile-test',
      permissionProfile: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        autonomyMode: 'workspace-autonomous',
      },
    };

    const created = await store.createTask(task);
    expect(created.task.executionProfile).toEqual(task.executionProfile);
    expect((await store.getTask(task.id))?.task.executionProfile).toEqual(task.executionProfile);

    await expect(store.createTask({
      ...createTask('task_desktop_profile_injection'),
      executionProfile: task.executionProfile,
    })).rejects.toBeInstanceOf(AgentTaskStoreValidationError);
  });

  it('validates persisted cognitive and working state without accepting disabled runtime controls', async () => {
    const store = new InMemoryAgentTaskStore();
    const task = createTask('task_cognitive_state');
    task.cognitiveProfile = {
      schemaVersion: AGENT_COGNITIVE_PROFILE_SCHEMA_VERSION,
      mode: 'small-local',
      activeTier: 'fast',
      maxDecisionSchemas: 3,
      maxObservationFacts: 10,
      agentCapabilityClass: 'basic',
      planningAuthority: 'runtime-only',
      maxPlanSteps: 3,
      runtimeDecomposition: true,
      runtimeRecovery: true,
      updatedAt: task.updatedAt,
    };
    task.workingState = {
      schemaVersion: AGENT_WORKING_STATE_SCHEMA_VERSION,
      revision: 2,
      phase: 'recover',
      goalTargetIds: ['expected-output:output_1'],
      causalObservationIds: ['observation_failure'],
      failedActionFingerprints: ['sha256:failed-action'],
      lastFailure: {
        capabilityId: 'workspace.files.read',
        observationId: 'observation_failure',
        failureClass: 'runtime',
        retryable: true,
      },
      updatedAt: task.updatedAt,
    };

    const created = await store.createTask(task);
    expect(created.task.cognitiveProfile).toEqual(task.cognitiveProfile);
    expect(created.task.workingState).toEqual(task.workingState);

    await expect(store.createTask({
      ...createTask('task_disabled_cognitive_runtime'),
      cognitiveProfile: {
        ...task.cognitiveProfile,
        runtimeRecovery: false,
      } as AgentTask['cognitiveProfile'],
    })).rejects.toBeInstanceOf(AgentTaskStoreValidationError);
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

  it('restores the exact Coder execution profile after a process restart', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const first = new LocalJsonAgentTaskStore(filePath);
    const task = createTask('task_disk_coder_profile');
    task.source = { surface: 'coder' };
    task.executionProfile = {
      schemaVersion: AGENT_EXECUTION_PROFILE_SCHEMA_VERSION,
      kind: 'coder-project',
      projectId: 'project-disk-profile',
      projectRoot: 'E:\\SyntheticCoder\\project-disk-profile',
      permissionProfile: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        autonomyMode: 'full-local',
      },
    };
    await first.createTask(task);

    const restarted = new LocalJsonAgentTaskStore(filePath);
    await expect(restarted.getTask(task.id)).resolves.toMatchObject({
      task: { source: { surface: 'coder' }, executionProfile: task.executionProfile },
    });
  });

  it('imports v2 terminal checkpoints as read-only history and writes later work only to v3', async () => {
    const root = await makeTemporaryRoot();
    const legacyFilePath = path.join(root, 'tasks.v2.json');
    const filePath = path.join(root, 'tasks.v3.json');
    const seed = new LocalJsonAgentTaskStore(legacyFilePath);
    const created = await seed.createTask(createTask('task_v2_terminal'));
    await seed.saveTask({
      ...created.task,
      status: 'completed',
      completedAt: created.task.updatedAt,
      terminalReason: { code: 'completed', summary: 'Legacy verified result.' },
    }, {
      expectedCheckpointVersion: created.task.checkpointVersion,
      events: [{ type: 'task.completed', payload: { summary: 'Legacy verified result.' } }],
    });

    const legacyDocument = JSON.parse(await readFile(legacyFilePath, 'utf8')) as {
      schemaVersion: string;
      tasks: Record<string, {
        schemaVersion: string;
        task: AgentTask & { schemaVersion: string; legacyReadOnly?: boolean };
      }>;
    };
    legacyDocument.schemaVersion = 'monarch.agent-task-store.v2';
    const legacyCheckpoint = legacyDocument.tasks.task_v2_terminal!;
    legacyCheckpoint.schemaVersion = 'monarch.agent-checkpoint.v2';
    legacyCheckpoint.task.schemaVersion = 'monarch.agent-task.v2';
    delete legacyCheckpoint.task.legacyReadOnly;
    const legacyBytes = `${JSON.stringify(legacyDocument)}\n`;
    await writeFile(legacyFilePath, legacyBytes, 'utf8');

    const migrated = new LocalJsonAgentTaskStore(filePath, { legacyFilePath });
    const terminal = await migrated.getTask('task_v2_terminal');
    expect(terminal?.schemaVersion).toBe('monarch.agent-checkpoint.v3');
    expect(terminal?.task).toMatchObject({
      schemaVersion: AGENT_TASK_SCHEMA_VERSION,
      status: 'completed',
      legacyReadOnly: true,
    });
    await expect(migrated.saveTask(terminal!.task, {
      expectedCheckpointVersion: terminal!.task.checkpointVersion,
    })).rejects.toThrow(/read-only/);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(legacyFilePath, 'utf8')).toBe(legacyBytes);

    await migrated.createTask(createTask('task_v3_new'));
    const durableV3 = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: string;
      tasks: Record<string, { task: AgentTask }>;
    };
    expect(durableV3.schemaVersion).toBe('monarch.agent-task-store.v3');
    expect(durableV3.tasks.task_v2_terminal?.task.legacyReadOnly).toBe(true);
    expect(durableV3.tasks.task_v3_new?.task.schemaVersion).toBe(AGENT_TASK_SCHEMA_VERSION);
    expect(await readFile(legacyFilePath, 'utf8')).toBe(legacyBytes);
  });

  it('durably recovers a legacy completed checkpoint whose plan still has open steps', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const clock = mutableClock('2026-08-12T12:00:00.000Z');
    const seed = new LocalJsonAgentTaskStore(filePath, { now: clock.now });
    const created = await seed.createTask(createTask('task_legacy_open_plan'));
    const stepDefinitions = [
      { id: 'step_proposed', title: 'Proposed step' },
      { id: 'step_ready', title: 'Ready step' },
      { id: 'step_running', title: 'Running step' },
      { id: 'step_waiting', title: 'Waiting step' },
    ];
    const completed = await seed.saveTask({
      ...created.task,
      status: 'completed',
      completedAt: created.task.updatedAt,
      terminalReason: { code: 'completed', summary: 'Legacy runtime claimed completion.' },
      currentStepId: stepDefinitions[0]!.id,
      plan: {
        id: 'plan_legacy_open_completion',
        revision: 1,
        goalSummary: 'Exercise the legacy completion migration.',
        createdAt: created.task.createdAt,
        steps: stepDefinitions.map((step, index) => ({
          ...step,
          status: index === 0 ? 'completed' as const : 'skipped' as const,
          dependsOn: [],
          expectedEffects: [],
          verification: [],
        })),
      },
    }, {
      expectedCheckpointVersion: created.task.checkpointVersion,
      events: [{ type: 'task.completed', payload: { summary: 'Legacy runtime claimed completion.' } }],
    });
    const originalEventIds = completed.checkpoint.events.map((event) => event.id);

    const legacyDocument = JSON.parse(await readFile(filePath, 'utf8')) as {
      tasks: Record<string, {
        task: AgentTask & { plan: NonNullable<AgentTask['plan']> };
      }>;
    };
    const legacyTask = legacyDocument.tasks[created.task.id]!.task;
    const legacyStatuses = ['proposed', 'ready', 'running', 'waiting-approval'] as const;
    legacyTask.plan.steps.forEach((step, index) => {
      step.status = legacyStatuses[index]!;
    });
    legacyTask.currentStepId = 'step_running';
    await writeFile(filePath, `${JSON.stringify(legacyDocument)}\n`, 'utf8');

    const restarted = new LocalJsonAgentTaskStore(filePath, { now: clock.now });
    const migrations = await restarted.reconcileLegacyCompletedPlans();
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.task).toMatchObject({
      id: created.task.id,
      status: 'failed',
      currentStepId: 'step_running',
      terminalReason: {
        code: 'verification-failed',
        detail: {
          recoveryReason: 'legacy-completed-plan-invariant',
          previousStatus: 'completed',
          previousTerminalCode: 'completed',
          missingCompletedStep: true,
          unfinishedSteps: [
            { id: 'step_proposed', status: 'proposed' },
            { id: 'step_ready', status: 'ready' },
            { id: 'step_running', status: 'running' },
            { id: 'step_waiting', status: 'waiting-approval' },
          ],
        },
      },
    });
    expect(migrations[0]!.checkpoint.events.slice(0, originalEventIds.length).map((event) => event.id))
      .toEqual(originalEventIds);
    expect(migrations[0]!.appendedEvents.map((event) => event.type)).toEqual([
      'task.status.changed',
      'task.failed',
    ]);
    expect(migrations[0]!.task.checkpointVersion).toBe(completed.task.checkpointVersion + 1);

    const durable = new LocalJsonAgentTaskStore(filePath, { now: clock.now });
    expect((await durable.getTask(created.task.id))?.task.status).toBe('failed');
    await expect(durable.reconcileLegacyCompletedPlans()).resolves.toEqual([]);
    expect((await durable.getTask(created.task.id))?.events).toHaveLength(originalEventIds.length + 2);
    expect((await readdir(root)).filter((entry) => entry.includes('.lock.'))).toEqual([]);
  });

  it('survives 500 mutations across 100 contended lock rounds without losing a task', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const stores = Array.from({ length: 8 }, () => new LocalJsonAgentTaskStore(filePath, {
      retryDelayMs: 1,
      lockTimeoutMs: 60_000,
    }));

    for (let round = 0; round < 100; round += 1) {
      await Promise.all(Array.from({ length: 5 }, async (_entry, lane) => {
        const id = `task_stress_${String(round).padStart(3, '0')}_${lane}`;
        await stores[(round + lane) % stores.length]!.createTask(createTask(id));
      }));
    }

    const restarted = new LocalJsonAgentTaskStore(filePath);
    const tasks = await restarted.listTasks();
    expect(tasks).toHaveLength(500);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(500);
    expect((await readdir(root)).filter((entry) => entry.includes('.lock.'))).toEqual([]);
  }, 120_000);

  it.each([['EPERM', 5], ['EBUSY', 5]] as const)(
    're-enumerates contenders after repeated transient Windows %s lock read failures',
    async (code, failureBudget) => {
      const root = await makeTemporaryRoot();
      const filePath = path.join(root, 'agent-tasks.json');
      const faultPath = `${filePath}.lock.000_transient_${code.toLowerCase()}.json`;
      await writeFile(faultPath, `${JSON.stringify(createLockDocument(
        `transient_${code.toLowerCase()}`,
        424_242,
      ))}\n`, 'utf8');
      let injectedFailures = 0;
      const store = new LocalJsonAgentTaskStore(filePath, {
        isProcessAlive: (pid) => pid !== 424_242,
        retryDelayMs: 1,
        lockTimeoutMs: 1_000,
        __testHooks: {
          beforeReadLockClaim: (candidatePath) => {
            if (candidatePath === faultPath && injectedFailures < failureBudget) {
              injectedFailures += 1;
              throw createFileSystemError(code);
            }
          },
        },
      });

      await expect(store.createTask(createTask(`task_after_${code.toLowerCase()}`))).resolves.toBeDefined();

      expect(injectedFailures).toBe(failureBudget);
      expect((await store.listTasks()).map((task) => task.id)).toEqual([
        `task_after_${code.toLowerCase()}`,
      ]);
      expect((await readdir(root)).filter((entry) => entry.includes('.lock.'))).toEqual([]);
    },
  );

  it('fails closed after persistent EACCES leaves a lock claim unreadable', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const faultPath = `${filePath}.lock.000_unreadable.json`;
    const lockDocument = `${JSON.stringify(createLockDocument('unreadable', 424_242))}\n`;
    await writeFile(faultPath, lockDocument, 'utf8');
    let readAttempts = 0;
    const store = new LocalJsonAgentTaskStore(filePath, {
      isProcessAlive: () => true,
      retryDelayMs: 1,
      lockTimeoutMs: 1_000,
      __testHooks: {
        beforeReadLockClaim: (candidatePath) => {
          if (candidatePath === faultPath) {
            readAttempts += 1;
            throw createFileSystemError('EACCES');
          }
        },
      },
    });

    await expect(store.createTask(createTask('task_blocked_by_unreadable_lock')))
      .rejects.toBeInstanceOf(AgentTaskStoreError);

    expect(readAttempts).toBe(process.platform === 'win32' ? 12 : 4);
    expect(await readFile(faultPath, 'utf8')).toBe(lockDocument);
    expect((await readdir(root)).filter((entry) => entry.includes('.lock.'))).toEqual([
      path.basename(faultPath),
    ]);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on a young malformed lock claim and never removes it', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const malformedPath = `${filePath}.lock.000_malformed.json`;
    const malformedLock = '{"schemaVersion":"monarch.agent-task-lock.v1","ownerId":';
    await writeFile(malformedPath, malformedLock, 'utf8');
    const store = new LocalJsonAgentTaskStore(filePath, {
      lockTtlMs: 30_000,
      retryDelayMs: 1,
      lockTimeoutMs: 25,
    });

    await expect(store.createTask(createTask('task_blocked_by_malformed_lock')))
      .rejects.toBeInstanceOf(AgentTaskStoreLockTimeoutError);

    expect(await readFile(malformedPath, 'utf8')).toBe(malformedLock);
    expect((await readdir(root)).filter((entry) => entry.includes('.lock.'))).toEqual([
      path.basename(malformedPath),
    ]);
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes bounded mutations from real child processes without orphaned claims', async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, 'agent-tasks.json');
    const workerPath = path.join(root, 'agent-task-store-child.mts');
    await writeFile(workerPath, createChildProcessWorkerSource(), 'utf8');
    const lanes = 4;
    const tasksPerLane = 6;

    await Promise.all(Array.from({ length: lanes }, (_entry, lane) => runStoreChildProcess({
      workerPath,
      filePath,
      lane,
      taskCount: tasksPerLane,
      template: createTask('task_child_template'),
      timeoutMs: 30_000,
    })));

    const restarted = new LocalJsonAgentTaskStore(filePath);
    const tasks = await restarted.listTasks();
    expect(tasks).toHaveLength(lanes * tasksPerLane);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(lanes * tasksPerLane);
    expect((await readdir(root)).filter((entry) => (
      entry.includes('.lock.') || entry.endsWith('.tmp')
    ))).toEqual([]);
  }, 45_000);

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
    evidence: [{
      kind: 'file',
      evidenceClass: 'kernel-observation',
      reference: 'E:\\Monarch\\README.md',
    }],
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

function createLockDocument(ownerId: string, pid: number): Record<string, unknown> {
  return {
    schemaVersion: 'monarch.agent-task-lock.v1',
    ownerId,
    pid,
    state: 'held',
    ticket: 1,
    createdAt: '2026-07-22T10:00:00.000Z',
    expiresAt: '2099-07-22T10:00:00.000Z',
  };
}

function createFileSystemError(code: string): NodeJS.ErrnoException {
  const error = new Error(`Simulated ${code} lock read failure.`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createChildProcessWorkerSource(): string {
  const storeModuleUrl = pathToFileURL(path.resolve('src/agent/agent-task-store.ts')).href;
  return `
import { LocalJsonAgentTaskStore } from ${JSON.stringify(storeModuleUrl)};

const [filePath, laneText, countText] = process.argv.slice(2);
const templateText = process.env.MONARCH_AGENT_TASK_TEMPLATE;
if (!filePath || !laneText || !countText || !templateText) {
  throw new Error('Missing child-process store arguments.');
}
const lane = Number.parseInt(laneText, 10);
const taskCount = Number.parseInt(countText, 10);
const template = JSON.parse(templateText);
const store = new LocalJsonAgentTaskStore(filePath, {
  retryDelayMs: 1,
  lockTimeoutMs: 20_000,
});
for (let index = 0; index < taskCount; index += 1) {
  const id = \`task_child_\${lane}_\${index}\`;
  const task = structuredClone(template);
  task.id = id;
  task.traceId = \`trace_\${id}\`;
  task.source.requestId = \`source_\${id}\`;
  task.goal.originalRequest = \`Complete \${id}\`;
  task.goal.normalizedObjective = \`Complete durable task \${id}\`;
  task.messages[0].id = \`message_\${id}\`;
  task.messages[0].content = \`Complete \${id}\`;
  await store.createTask(task);
}
`;
}

interface StoreChildProcessOptions {
  workerPath: string;
  filePath: string;
  lane: number;
  taskCount: number;
  template: AgentTask;
  timeoutMs: number;
}

async function runStoreChildProcess(options: StoreChildProcessOptions): Promise<void> {
  const require = createRequire(import.meta.url);
  const tsxCliPath = require.resolve('tsx/cli');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      tsxCliPath,
      options.workerPath,
      options.filePath,
      String(options.lane),
      String(options.taskCount),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MONARCH_AGENT_TASK_TEMPLATE: JSON.stringify(options.template),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`AgentTaskStore child lane ${options.lane} exceeded ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
    timeout.unref?.();
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `AgentTaskStore child lane ${options.lane} failed (${code ?? signal ?? 'unknown'}): ${stderr}`,
      ));
    });
  });
}

async function makeTemporaryRoot(): Promise<string> {
  const workspaceDrive = process.platform === 'win32' ? path.parse(process.cwd()).root : '';
  const basePath = workspaceDrive
    ? path.join(workspaceDrive, 'Monarch-Agent-QA')
    : tmpdir();
  await mkdir(basePath, { recursive: true });
  const root = await mkdtemp(path.join(basePath, 'monarch-agent-task-store-'));
  temporaryRoots.push(root);
  return root;
}
