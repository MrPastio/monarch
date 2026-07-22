import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import {
  InMemoryAgentTaskStore,
  ReplayAgentDecisionProvider,
  type AgentDecisionProvider,
  type AgentModelDecisionRequest,
  type AgentModelDecisionResponse,
  type AgentTaskCheckpoint,
} from '../../src/agent';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Oscar Agent Runtime V2 durable controls', () => {
  it('deduplicates concurrent task creation by clientRequestId', async () => {
    const root = await temporaryRoot('monarch-agent-create-idempotency-');
    const store = new InMemoryAgentTaskStore();
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: store,
    });
    await app.start();
    try {
      const input = {
        request: 'Create exactly one durable task.',
        source: { surface: 'api' as const },
        clientRequestId: 'create-race-1',
        autoStart: false,
      };
      const created = await Promise.all([
        app.createAgentTask(input),
        app.createAgentTask(input),
      ]);
      expect(created[0]?.task.id).toBe(created[1]?.task.id);
      expect(created.every((checkpoint) => checkpoint.task.checkpointVersion === 1)).toBe(true);
      await expect(store.listTasks()).resolves.toHaveLength(1);
    } finally {
      await app.stop();
    }
  });

  it('rejects clientRequestId reuse when auto-start semantics change', async () => {
    const root = await temporaryRoot('monarch-agent-create-autostart-idempotency-');
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
    });
    await app.start();
    try {
      const input = {
        request: 'Keep this idempotent task idle.',
        source: { surface: 'api' as const },
        clientRequestId: 'create-autostart-binding-1',
      };
      const created = await app.createAgentTask({ ...input, autoStart: false });
      expect(created.task.status).toBe('created');
      await expect(app.createAgentTask({ ...input, autoStart: true })).rejects.toMatchObject({
        statusCode: 409,
        code: 'client-request-reused',
      });
      expect((await app.agentRuntime!.getTask(created.task.id))?.task.status).toBe('created');
    } finally {
      await app.stop();
    }
  });

  it('deduplicates identical concurrent messages and rejects message id reuse with different content', async () => {
    const root = await temporaryRoot('monarch-agent-message-idempotency-');
    const store = new InMemoryAgentTaskStore();
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: store,
    });
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: 'Keep this task idle while message idempotency is tested.',
        source: { surface: 'api' },
        autoStart: false,
      });
      const input = { content: '  Preserve   this clarification.  ', messageId: 'message-race-1' };
      const concurrent = await Promise.all([
        app.agentRuntime!.sendMessage(created.task.id, input),
        app.agentRuntime!.sendMessage(created.task.id, input),
      ]);

      expect(concurrent.every((checkpoint) => checkpoint.task.checkpointVersion === 2)).toBe(true);
      const checkpoint = (await store.getTask(created.task.id))!;
      expect(checkpoint.task.messages.filter((message) => message.id === input.messageId)).toEqual([
        expect.objectContaining({ content: 'Preserve this clarification.' }),
      ]);

      const replayed = await app.agentRuntime!.sendMessage(created.task.id, input);
      expect(replayed.task.checkpointVersion).toBe(2);
      expect(replayed.task.messages.filter((message) => message.id === input.messageId)).toHaveLength(1);
      await expect(app.agentRuntime!.sendMessage(created.task.id, {
        messageId: input.messageId,
        content: 'A different clarification.',
      })).rejects.toMatchObject({ statusCode: 409, code: 'message-id-reused' });

      const conflicting = await Promise.allSettled([
        app.agentRuntime!.sendMessage(created.task.id, {
          messageId: 'message-race-conflict',
          content: 'First conflicting payload.',
        }),
        app.agentRuntime!.sendMessage(created.task.id, {
          messageId: 'message-race-conflict',
          content: 'Second conflicting payload.',
        }),
      ]);
      expect(conflicting.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(conflicting.filter((result) => result.status === 'rejected')).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ statusCode: 409, code: 'message-id-reused' }) }),
      ]);
      expect((await store.getTask(created.task.id))?.task.messages.filter(
        (message) => message.id === 'message-race-conflict',
      )).toHaveLength(1);
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('deduplicates concurrent approval resolution by its logical request payload', async () => {
    const { app } = await approvalApp();
    await app.start();
    try {
      const created = await createApprovalTask(app);
      const waiting = await waitForStatus(app, created.task.id, 'waiting-for-approval');
      const approvalId = waiting.approvals[0]!.id;
      const resolution = {
        decision: 'approve' as const,
        grantScope: 'once' as const,
        requestId: 'approval-resolution-race-1',
        reason: 'Approve the exact checkpointed write.',
      };

      await expect(Promise.all([
        app.agentRuntime!.resolveApproval(created.task.id, approvalId, resolution),
        app.agentRuntime!.resolveApproval(created.task.id, approvalId, resolution),
      ])).resolves.toHaveLength(2);

      const completed = await waitForStatus(app, created.task.id, 'completed');
      expect(completed.events.filter((event) => event.type === 'approval.resolved')).toHaveLength(1);
      expect(completed.approvals).toEqual([
        expect.objectContaining({ id: approvalId, status: 'approved', grantScope: 'once' }),
      ]);
      await expect(app.agentRuntime!.resolveApproval(created.task.id, approvalId, {
        ...resolution,
        grantScope: 'task',
      })).rejects.toMatchObject({ statusCode: 409, code: 'approval-request-reused' });
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('preserves the checkpointed action when a message arrives during approval', async () => {
    const { app, root } = await approvalApp();
    await app.start();
    try {
      const created = await createApprovalTask(app);
      const waiting = await waitForStatus(app, created.task.id, 'waiting-for-approval');
      const approval = waiting.approvals[0]!;
      const pendingAction = waiting.task.pendingAction;

      const messaged = await app.agentRuntime!.sendMessage(created.task.id, {
        content: 'Keep the same approved target and include this clarification.',
        messageId: 'approval-clarification-1',
      });

      expect(messaged.task.status).toBe('waiting-for-approval');
      expect(messaged.task.activeApprovalId).toBe(approval.id);
      expect(messaged.task.pendingAction).toEqual(pendingAction);
      expect(messaged.approvals[0]).toMatchObject({ id: approval.id, status: 'pending' });

      await app.agentRuntime!.resolveApproval(created.task.id, approval.id, {
        decision: 'approve',
        requestId: 'approval-after-message-1',
      });
      await waitForStatus(app, created.task.id, 'completed');
      await expect(access(path.join(root, 'runtime', 'approval.txt'))).resolves.toBeUndefined();
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('revokes a pending approval on cancellation and rejects a stale approval resolution', async () => {
    const { app, root } = await approvalApp();
    await app.start();
    try {
      const created = await createApprovalTask(app);
      const waiting = await waitForStatus(app, created.task.id, 'waiting-for-approval');
      const approvalId = waiting.approvals[0]!.id;

      await app.agentRuntime!.cancel(created.task.id);
      const cancelled = await waitForStatus(app, created.task.id, 'cancelled');

      expect(cancelled.task.activeApprovalId).toBeUndefined();
      expect(cancelled.task.pendingAction).toBeUndefined();
      expect(cancelled.approvals[0]).toMatchObject({
        id: approvalId,
        status: 'revoked',
        decision: { outcome: 'revoked', decidedBy: 'system' },
      });
      await expect(app.agentRuntime!.resolveApproval(created.task.id, approvalId, {
        decision: 'approve',
      })).rejects.toMatchObject({ statusCode: 409, code: 'approval-already-resolved' });
      await expect(access(path.join(root, 'runtime', 'approval.txt'))).rejects.toBeDefined();
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('fails closed when a pending approval no longer matches the checkpointed proposal', async () => {
    const { app, store } = await approvalApp();
    await app.start();
    try {
      const created = await createApprovalTask(app);
      await waitForStatus(app, created.task.id, 'waiting-for-approval');
      await app.agentRuntime!.waitForIdle(created.task.id);
      const waiting = (await store.getTask(created.task.id))!;
      const approvalId = waiting.approvals[0]!.id;
      await store.saveTask({
        ...waiting.task,
        pendingAction: waiting.task.pendingAction
          ? { ...waiting.task.pendingAction, canonicalProposalHash: 'mismatched-checkpoint-hash' }
          : undefined,
      }, { expectedCheckpointVersion: waiting.task.checkpointVersion });

      await expect(app.agentRuntime!.resolveApproval(created.task.id, approvalId, {
        decision: 'approve',
      })).rejects.toMatchObject({ statusCode: 409, code: 'approval-binding-mismatch' });
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('returns an explicit conflict for a pending approval on a legacy terminal checkpoint', async () => {
    const { app, store } = await approvalApp();
    await app.start();
    try {
      const created = await createApprovalTask(app);
      await waitForStatus(app, created.task.id, 'waiting-for-approval');
      await app.agentRuntime!.waitForIdle(created.task.id);
      const waiting = (await store.getTask(created.task.id))!;
      const approvalId = waiting.approvals[0]!.id;
      const completedAt = new Date().toISOString();
      await store.saveTask({
        ...waiting.task,
        status: 'cancelled',
        completedAt,
        terminalReason: { code: 'cancelled-by-user', summary: 'Legacy terminal checkpoint.' },
      }, {
        expectedCheckpointVersion: waiting.task.checkpointVersion,
        events: [{ type: 'task.cancelled', payload: { summary: 'Legacy terminal checkpoint.' } }],
      });

      await expect(app.agentRuntime!.resolveApproval(created.task.id, approvalId, {
        decision: 'approve',
      })).rejects.toMatchObject({ statusCode: 409, code: 'task-terminal' });
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('settles cancellation even when a prior pause already fixed the controller abort reason', async () => {
    const root = await temporaryRoot('monarch-agent-pause-cancel-');
    const provider = new ControlledDecisionProvider();
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: provider,
    });
    await app.start();
    try {
      const created = await app.createAgentTask({ request: 'Pause and then cancel this task.', source: { surface: 'api' } });
      await provider.started;
      await app.agentRuntime!.pause(created.task.id);
      await app.agentRuntime!.cancel(created.task.id);
      provider.finish();

      const cancelled = await waitForStatus(app, created.task.id, 'cancelled');
      expect(cancelled.task.cancellationRequested).toBe(true);
      expect(cancelled.task.terminalReason?.code).toBe('cancelled-by-user');
    } finally {
      provider.finish();
      await app.stop();
    }
  }, 30_000);

  it('automatically schedules an interrupted durable task when the runtime restarts', async () => {
    const root = await temporaryRoot('monarch-agent-restart-');
    const store = new InMemoryAgentTaskStore();
    const firstProvider = new AbortAwareBlockingProvider();
    const first = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: store,
      agentDecisionProvider: firstProvider,
    });
    await first.start();
    const created = await first.createAgentTask({ request: 'Resume me after restart.', source: { surface: 'api' } });
    await firstProvider.started;
    await first.stop();
    expect((await store.getTask(created.task.id))?.task.status).toBe('interrupted');

    const second = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: store,
      agentDecisionProvider: new ReplayAgentDecisionProvider([
        JSON.stringify({
          kind: 'ask-user',
          question: 'The restarted task is active again. Continue?',
          reason: 'Prove that startup scheduled the interrupted checkpoint.',
        }),
      ]),
    });
    await second.start();
    try {
      const resumed = await waitForStatus(second, created.task.id, 'waiting-for-user');
      expect(resumed.task.messages.at(-1)?.content).toContain('restarted task is active again');
    } finally {
      await second.stop();
    }
  }, 30_000);

  it('persists and reuses a task-scoped Kernel lease for the next bounded workspace action', async () => {
    const root = await temporaryRoot('monarch-agent-task-lease-');
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace', 'security'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: new TaskLeaseDecisionProvider(),
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request', autonomyMode: 'guided' },
    });
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: 'Create two verified task-lease fixtures.',
        source: { surface: 'api' },
        expectedOutputs: [
          { id: 'first-file', kind: 'artifact', description: 'runtime/lease-first.txt exists.' },
          { id: 'second-file', kind: 'artifact', description: 'runtime/lease-second.txt exists.' },
        ],
        successCriteria: [{ id: 'both-verified', description: 'Both writes have deterministic verification evidence.' }],
      });
      const waiting = await waitForStatus(app, created.task.id, 'waiting-for-approval');
      await app.agentRuntime!.resolveApproval(created.task.id, waiting.approvals[0]!.id, {
        decision: 'approve',
        grantScope: 'task',
      });
      const completed = await waitForStatus(app, created.task.id, 'completed');

      expect(completed.approvals).toHaveLength(1);
      expect(completed.task.activeLeaseId).toMatch(/^lease_/);
      expect(completed.events.filter((event) => event.type === 'approval.required')).toHaveLength(1);
      await expect(access(path.join(root, 'runtime', 'lease-first.txt'))).resolves.toBeUndefined();
      await expect(access(path.join(root, 'runtime', 'lease-second.txt'))).resolves.toBeUndefined();
    } finally {
      await app.stop();
    }
  }, 30_000);
});

class ApprovalWriteDecisionProvider implements AgentDecisionProvider {
  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    const context = request.compiledContext as {
      observations?: Array<{ id: string; status: string }>;
      artifacts?: Array<{ id: string }>;
      goal?: { expectedOutputs?: Array<{ id: string }>; successCriteria?: Array<{ id: string }> };
    };
    const observations = context.observations || [];
    const successfulObservationIds = observations.filter((entry) => entry.status === 'success').map((entry) => entry.id);
    const artifactIds = (context.artifacts || []).map((entry) => entry.id);
    const decision = observations.length === 0
      ? {
        kind: 'act',
        capabilityId: 'workspace.files.write',
        input: { path: 'runtime/approval.txt', content: 'approved durable action\n', overwrite: false },
        reason: 'Create the requested approval test artifact.',
        expectedEffect: 'runtime/approval.txt exists with the approved content.',
        preconditions: [{ kind: 'not-exists', target: 'runtime/approval.txt' }],
        verification: [
          { kind: 'exists', target: 'runtime/approval.txt' },
          { kind: 'contains', target: 'runtime/approval.txt', value: 'approved durable action' },
        ],
      }
      : {
        kind: 'complete',
        summary: 'The approved durable action completed.',
        evidenceObservationIds: successfulObservationIds,
        artifactIds,
        evidenceBindings: [
          ...(context.goal?.expectedOutputs || []).map((target) => ({
            targetType: 'expected-output', targetId: target.id, observationIds: successfulObservationIds, artifactIds,
          })),
          ...(context.goal?.successCriteria || []).map((target) => ({
            targetType: 'success-criterion', targetId: target.id, observationIds: successfulObservationIds, artifactIds,
          })),
        ],
      };
    return Promise.resolve({ ok: true, rawText: JSON.stringify(decision), role: 'fixture', adapter: 'fixture' });
  }
}

class ControlledDecisionProvider implements AgentDecisionProvider {
  private resolveStarted!: () => void;
  private resolveDecision: ((response: AgentModelDecisionResponse) => void) | undefined;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });

  decide(): Promise<AgentModelDecisionResponse> {
    this.resolveStarted();
    return new Promise((resolve) => { this.resolveDecision = resolve; });
  }

  finish(): void {
    this.resolveDecision?.({ ok: false, error: 'controlled-stage-finished' });
  }
}

class AbortAwareBlockingProvider implements AgentDecisionProvider {
  private resolveStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });

  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.resolveStarted();
    return new Promise((resolve) => {
      if (request.signal?.aborted) {
        resolve({ ok: false, error: 'model-call-aborted' });
        return;
      }
      request.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'model-call-aborted' }), { once: true });
    });
  }
}

class TaskLeaseDecisionProvider implements AgentDecisionProvider {
  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    const context = request.compiledContext as {
      observations?: Array<{ id: string; status: string }>;
      artifacts?: Array<{ id: string; reference: string }>;
      goal: {
        expectedOutputs: Array<{ id: string; description: string }>;
        successCriteria: Array<{ id: string }>;
      };
    };
    const successful = (context.observations || []).filter((entry) => entry.status === 'success');
    if (successful.length < 2) {
      const second = successful.length === 1;
      const target = second ? 'runtime/lease-second.txt' : 'runtime/lease-first.txt';
      const content = second ? 'second lease action\n' : 'first lease action\n';
      return Promise.resolve({
        ok: true,
        rawText: JSON.stringify({
          kind: 'act',
          capabilityId: 'workspace.files.write',
          input: { path: target, content, overwrite: false },
          reason: `Create ${target}.`,
          expectedEffect: `${target} exists with expected content.`,
          preconditions: [{ kind: 'not-exists', target }],
          verification: [
            { kind: 'exists', target },
            { kind: 'contains', target, value: content.trim() },
          ],
        }),
        role: 'fixture',
      });
    }
    const observationIds = successful.map((entry) => entry.id);
    const artifacts = context.artifacts || [];
    return Promise.resolve({
      ok: true,
      rawText: JSON.stringify({
        kind: 'complete',
        summary: 'Both task-scoped lease actions completed with verification.',
        evidenceObservationIds: observationIds,
        artifactIds: artifacts.map((entry) => entry.id),
        evidenceBindings: [
          ...context.goal.expectedOutputs.map((target) => ({
            targetType: 'expected-output',
            targetId: target.id,
            observationIds,
            artifactIds: artifacts.filter((artifact) => target.description.includes(artifact.reference)).map((artifact) => artifact.id),
          })),
          ...context.goal.successCriteria.map((target) => ({
            targetType: 'success-criterion',
            targetId: target.id,
            observationIds,
            artifactIds: artifacts.map((artifact) => artifact.id),
          })),
        ],
      }),
      role: 'fixture',
    });
  }
}

async function approvalApp(): Promise<{
  app: MonarchApplication;
  root: string;
  store: InMemoryAgentTaskStore;
}> {
  const root = await temporaryRoot('monarch-agent-approval-control-');
  const store = new InMemoryAgentTaskStore();
  return {
    root,
    store,
    app: new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace', 'security'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: store,
      agentDecisionProvider: new ApprovalWriteDecisionProvider(),
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request', autonomyMode: 'guided' },
    }),
  };
}

function createApprovalTask(app: MonarchApplication): Promise<AgentTaskCheckpoint> {
  return app.createAgentTask({
    request: 'Create runtime/approval.txt only after durable approval.',
    source: { surface: 'api' },
    expectedOutputs: [{ id: 'approval-file', kind: 'artifact', description: 'runtime/approval.txt exists.' }],
    successCriteria: [{ id: 'approved-write', description: 'The write completed with deterministic verification.' }],
  });
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function waitForStatus(
  app: MonarchApplication,
  taskId: string,
  status: string,
): Promise<AgentTaskCheckpoint> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const checkpoint = await app.agentRuntime!.getTask(taskId);
    if (checkpoint?.task.status === status) return checkpoint;
    if (checkpoint && ['failed', 'cancelled', 'completed'].includes(checkpoint.task.status) && checkpoint.task.status !== status) {
      throw new Error(`Task reached ${checkpoint.task.status}: ${checkpoint.task.terminalReason?.summary || 'no detail'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for task ${taskId} status ${status}.`);
}
