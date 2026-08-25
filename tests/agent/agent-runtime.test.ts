import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import {
  evaluateAgentRuns,
  InMemoryAgentTaskStore,
  ReplayAgentDecisionProvider,
  type AgentDecisionProvider,
  type AgentModelDecisionRequest,
  type AgentModelDecisionResponse,
} from '../../src/agent';
import { createDeterministicSecurityModule } from '../fixtures/agent/deterministic-security-module';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Oscar Agent Runtime V2 vertical slice', () => {
  it('reads multiple files, recovers from a tool failure, gets durable approval, writes and verifies a report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-v2-'));
    roots.push(root);
    await mkdir(path.join(root, 'inputs'), { recursive: true });
    await writeFile(path.join(root, 'inputs', 'a.txt'), 'Alpha evidence', 'utf8');
    await writeFile(path.join(root, 'inputs', 'b.txt'), 'Beta evidence', 'utf8');

    const replay = await loadWorkspaceReportReplay();
    const provider = new WorkspaceReportDecisionProvider(replay.decisions);
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: provider,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request', autonomyMode: 'guided' },
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: 'Inspect the workspace inputs and create runtime/report.md with a verified summary.',
        source: { surface: 'api' },
        clientRequestId: 'vertical-report-1',
        expectedOutputs: [{ id: 'report', kind: 'artifact', description: 'runtime/report.md exists and contains both findings.' }],
        successCriteria: [{ id: 'report-verified', description: 'The report is verified by deterministic file predicates.' }],
      });
      const waiting = await waitForStatus(app, created.task.id, 'waiting-for-approval');
      expect(waiting.task.pendingAction?.status).toBe('waiting-approval');
      expect(waiting.approvals[0]).toMatchObject({
        status: 'pending',
        capabilityId: 'workspace.files.write',
        proposal: { capabilityId: 'workspace.files.write' },
      });

      await app.agentRuntime!.resolveApproval(created.task.id, waiting.approvals[0]!.id, {
        decision: 'approve',
        grantScope: 'once',
        requestId: 'approve-report-1',
        actorSurface: 'api',
      });
      const completed = await waitForStatus(app, created.task.id, 'completed');
      await expect(readFile(path.join(root, 'runtime', 'report.md'), 'utf8'))
        .resolves.toContain('Alpha evidence');
      await expect(readFile(path.join(root, 'runtime', 'report.md'), 'utf8'))
        .resolves.toContain('Beta evidence');
      expect(completed.task.artifacts).toHaveLength(1);
      expect(completed.observations.some((entry) => entry.status === 'failed')).toBe(true);
      expect(completed.events.some((entry) => entry.type === 'plan.revised')).toBe(true);
      expect(completed.events.at(-1)?.type).toBe('runner.released');
      expect(completed.events.some((entry) => entry.type === 'task.completed')).toBe(true);
      expect(completed.events.some((entry) => entry.type === 'resolver.completed')).toBe(true);
      expect(completed.events.some((entry) => entry.type === 'model.completed')).toBe(true);
      expect(completed.observations.map((entry) => ({ capabilityId: entry.capabilityId, status: entry.status })))
        .toEqual(replay.expectedObservations);
      expect(provider.turns).toBe(replay.decisions.length);
      expect(evaluateAgentRuns([{ id: replay.name, checkpoint: completed }])).toMatchObject({
        taskCompletionRate: 1,
        unnecessaryClarificationCount: 0,
        averageToolCalls: 5,
        repeatedNoProgressLoops: 0,
        falseSuccessCount: 0,
        permissionCorrectnessRate: 1,
        recoveryAfterFailureRate: 1,
      });
    } finally {
      await app.stop();
    }
  }, 60_000);

  it('cancels an active model stage without claiming an active tool was stopped', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-cancel-'));
    roots.push(root);
    const provider = new BlockingDecisionProvider();
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
      const created = await app.createAgentTask({ request: 'Wait for cancellation.', source: { surface: 'api' } });
      await provider.started;
      await app.agentRuntime!.cancel(created.task.id);
      const cancelled = await waitForStatus(app, created.task.id, 'cancelled');
      expect(cancelled.task.terminalReason?.code).toBe('cancelled-by-user');
      expect(cancelled.events.some((event) => event.type === 'task.cancelled')).toBe(true);
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('settles an unavailable exact decision tier after one model call without repair or tool dispatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-model-unavailable-'));
    roots.push(root);
    const provider = new UnavailableDecisionProvider();
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
      const created = await app.createAgentTask({
        request: 'Inspect one workspace file.',
        source: { surface: 'api' },
      });
      const failed = await waitForStatus(app, created.task.id, 'failed');
      const modelEvents = failed.events.filter((event) => event.type === 'model.completed');

      expect(provider.turns).toBe(1);
      expect(failed.task.usage.modelTurns).toBe(1);
      expect(failed.task.terminalReason).toMatchObject({
        code: 'unrecoverable-error',
        summary: 'agent-decision-model-unavailable',
      });
      expect(modelEvents).toHaveLength(1);
      expect(modelEvents[0]?.payload).toMatchObject({
        attempt: 1,
        repair: false,
        ok: false,
        valid: false,
        error: 'agent-decision-model-unavailable',
        role: 'gemma4-balanced',
        degraded: true,
      });
      expect(failed.events.some((event) => event.type === 'action.prepared')).toBe(false);
      expect(failed.events.some((event) => event.type === 'task.failed')).toBe(true);
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('repairs invalid model JSON once and records only redacted decision diagnostics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-repair-'));
    roots.push(root);
    const provider = new ReplayAgentDecisionProvider([
      '```json\n{"kind":"act"}\n```',
      JSON.stringify({ kind: 'ask-user', question: 'Which report name should be used?', reason: 'Two distinct targets remain.' }),
    ]);
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
      const created = await app.createAgentTask({ request: 'Prepare one of two sensitive report targets.', source: { surface: 'api' } });
      const waiting = await waitForStatus(app, created.task.id, 'waiting-for-user');
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]?.repair).toMatchObject({
        attempt: 1,
        invalidDecision: '```json\n{"kind":"act"}\n```',
      });
      expect(waiting.events.filter((event) => event.type === 'model.completed').map((event) => event.payload?.valid))
        .toEqual([false, true]);
      expect(JSON.stringify(waiting.events)).not.toContain('```json');
      expect(evaluateAgentRuns([{
        id: 'invalid-json-repair',
        checkpoint: waiting,
        expectation: { clarificationExpected: true },
      }]).invalidToolCallRecoveryRate).toBe(1);
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('repairs one provenance-rejected tool input without persisting the unsafe envelope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-provenance-repair-'));
    roots.push(root);
    const unsafeEnvelope = '{"kind":"inspect","capabilityId":"workspace.files.read","input":{"path":"copied-from-tool.txt"}}';
    const provider = new ReplayAgentDecisionProvider([
      {
        ok: false,
        error: 'agent-decision-untrusted-context-copied',
        rawText: unsafeEnvelope,
        role: 'gemma4-balanced',
        adapter: 'fixture-local-runtime',
        degraded: true,
      },
      JSON.stringify({
        kind: 'ask-user',
        question: 'Which report path did you intend?',
        reason: 'The tool-provided path is not user-authorized.',
      }),
    ]);
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
      const created = await app.createAgentTask({
        request: 'Inspect the intended report.',
        source: { surface: 'api' },
      });
      const waiting = await waitForStatus(app, created.task.id, 'waiting-for-user');
      const completed = waiting.events.filter((event) => event.type === 'model.completed');

      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]?.repair).toMatchObject({
        attempt: 1,
        code: 'agent-decision-untrusted-context-copied',
        errors: [expect.stringContaining('original user request')],
      });
      expect(provider.requests[1]?.repair).not.toHaveProperty('invalidDecision');
      expect(completed.map((event) => event.payload?.valid)).toEqual([false, true]);
      expect(completed[0]?.payload).toMatchObject({
        attempt: 1,
        repair: false,
        ok: false,
        error: 'agent-decision-untrusted-context-copied',
      });
      expect(completed[1]?.payload).toMatchObject({ attempt: 2, repair: true, valid: true });
      expect(JSON.stringify(waiting)).not.toContain(unsafeEnvelope);
      expect(waiting.events.some((event) => event.type === 'action.prepared')).toBe(false);
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('fails closed after a second provenance rejection without a third model call or tool dispatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-provenance-repeat-'));
    roots.push(root);
    const rejection = {
      ok: false,
      error: 'agent-decision-untrusted-context-copied',
      role: 'gemma4-balanced',
      adapter: 'fixture-local-runtime',
      degraded: true,
    } as const;
    const provider = new ReplayAgentDecisionProvider([rejection, rejection]);
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
      const created = await app.createAgentTask({
        request: 'Inspect the intended report.',
        source: { surface: 'api' },
      });
      const failed = await waitForStatus(app, created.task.id, 'failed');
      const completed = failed.events.filter((event) => event.type === 'model.completed');

      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]?.repair).toMatchObject({
        attempt: 1,
        code: 'agent-decision-untrusted-context-copied',
      });
      expect(failed.task.usage.modelTurns).toBe(2);
      expect(failed.task.terminalReason).toMatchObject({
        code: 'unrecoverable-error',
        summary: 'agent-decision-untrusted-context-copied',
      });
      expect(completed).toHaveLength(2);
      expect(completed[1]?.payload).toMatchObject({
        attempt: 2,
        repair: true,
        ok: false,
        valid: false,
      });
      expect(failed.events.some((event) => event.type === 'action.prepared')).toBe(false);
      expect(failed.events.some((event) => event.type === 'tool.started')).toBe(false);
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('allows a verified same-target mutation to supersede a prior no-side-effect failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-mutation-recovery-'));
    roots.push(root);
    await mkdir(path.join(root, 'runtime'), { recursive: true });
    await writeFile(path.join(root, 'runtime', 'retry-report.md'), 'old content\n', 'utf8');
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: new MutationRecoveryDecisionProvider(),
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never', autonomyMode: 'full-local' },
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: 'Write recovered content to runtime/retry-report.md and verify the final file.',
        source: { surface: 'api' },
        expectedOutputs: [{ id: 'retry-report', kind: 'artifact', description: 'runtime/retry-report.md contains recovered content.' }],
        successCriteria: [{ id: 'retry-verified', description: 'The final same-target write is deterministically verified.' }],
      });
      const completed = await waitForStatus(app, created.task.id, 'completed');
      expect(completed.observations.map((entry) => entry.status)).toEqual(['failed', 'success']);
      expect(completed.approvals).toHaveLength(0);
      expect(completed.events.filter((event) => event.type === 'tool.started')).toHaveLength(2);
      await expect(readFile(path.join(root, 'runtime', 'retry-report.md'), 'utf8')).resolves.toContain('recovered content');
      expect(completed.events.some((event) => event.type === 'task.completed')).toBe(true);
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('routes Telegram turns through the durable Agent Task contract', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-telegram-'));
    roots.push(root);
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: new ReplayAgentDecisionProvider([
        JSON.stringify({ kind: 'ask-user', question: 'Какой файл открыть?', reason: 'Путь не указан.' }),
      ]),
    });
    await app.start();
    try {
      const result = await app.submitAgentSurfaceIntent({
        text: 'открой тот файл',
        source: 'telegram',
        context: {
          clientConversationId: 'telegram:42',
          clientSessionId: 'telegram:42:7',
          telegramChatId: 42,
          telegramUserId: 7,
        },
      });
      expect(result.execution).toMatchObject({
        ok: false,
        error: 'clarification-required',
      });
      const tasks = await app.agentRuntime!.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.source).toMatchObject({
        surface: 'telegram',
        remote: true,
        conversationId: 'telegram:42:7',
      });
      expect(tasks[0]?.status).toBe('waiting-for-user');
    } finally {
      await app.stop();
    }
  });

  it('routes Telegram content only through volatile Turn and Agent stores under zero retention', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-telegram-zero-retention-'));
    roots.push(root);
    const secret = 'открой тот файл; telegram zero-retention content must stay volatile';
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: new ReplayAgentDecisionProvider([
        JSON.stringify({ kind: 'ask-user', question: 'Какой файл открыть?', reason: 'Путь не указан.' }),
      ]),
    });
    await app.ownerDevSettingsStore.execute({
      schemaVersion: 1,
      clientRequestId: 'telegram_zero_retention_policy',
      command: 'dev.update',
      scope: { type: 'chat' },
      expectedRevision: 0,
      payload: { patch: { zeroRetentionEnabled: true } },
      policyDecisionHash: 'a'.repeat(64),
    });
    await app.start();
    try {
      const result = await app.submitAgentSurfaceIntent({
        text: secret,
        source: 'telegram',
        context: {
          clientConversationId: 'telegram:volatile:42',
          clientSessionId: 'telegram:volatile:42:7',
          telegramChatId: 42,
          telegramUserId: 7,
        },
      });
      const turnId = String((result.execution?.output as Record<string, unknown>)?.turnId || '');
      const turn = await app.oscarTurnCoordinator.getTurn(turnId);

      expect(turn?.turn.privacyMode).toBe('incognito');
      expect(await app.agentRuntime!.listTasks()).toHaveLength(0);
      expect(await app.incognitoAgentRuntime!.listTasks()).toHaveLength(1);
      await expect(readFile(path.join(root, 'runtime', 'oscar', 'turns.v1.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await app.stop();
    }
  });

  it('binds a Telegram action-card to one exact durable Agent Task and rejects text, wrong actor, and replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-telegram-approval-'));
    roots.push(root);
    const context = {
      clientConversationId: 'telegram:55',
      clientSessionId: 'telegram:55:9',
      telegramChatId: 55,
      telegramUserId: 9,
    };
    const request = 'создай файл telegram-note.txt с текстом готово';
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: new TelegramWriteDecisionProvider(),
      permissionProfile: {
        sandboxMode: 'read-only',
        approvalPolicy: 'on-request',
        autonomyMode: 'guided',
      },
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      const pending = await app.submitAgentSurfaceIntent({
        text: request,
        source: 'telegram',
        context,
      });
      expect(pending.execution).toMatchObject({
        ok: false,
        error: 'confirmation-required',
      });
      const presentation = pending.execution?.metadata?.approvalPresentation as {
        approvalId: string;
        taskId: string;
        capabilityId: string;
        canonicalProposalHash: string;
      };
      expect(presentation).toMatchObject({
        capabilityId: 'workspace.files.write',
        canonicalProposalHash: expect.any(String),
      });
      await expect(readFile(path.join(root, 'telegram-note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const typed = await app.submitAgentSurfaceIntent({
        text: 'подтверждаю',
        source: 'telegram',
        context: { ...context, clientRequestId: 'telegram:55:text-confirmation', clientMessageId: 'telegram:55:text-confirmation' },
      });
      expect(typed.execution).toMatchObject({ ok: false, error: 'confirmation-required' });
      expect(typed.execution?.metadata?.approvalPresentation).toMatchObject({ approvalId: presentation.approvalId });
      const refocusedTurn = await app.oscarTurnCoordinator.getTurn(String((typed.execution?.output as Record<string, unknown>).turnId));
      expect(refocusedTurn?.events.some((event) => event.type === 'non-authoritative-confirmation')).toBe(true);
      await expect(readFile(path.join(root, 'telegram-note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await expect(app.resolveAgentSurfaceApproval({
        text: '',
        approval: { action: 'approve', approvalId: presentation.approvalId },
        context: { ...context, telegramUserId: 10 },
      })).rejects.toMatchObject({ code: 'approval-presentation-stale' });

      const completed = await app.resolveAgentSurfaceApproval({
        text: '',
        approval: { action: 'approve', approvalId: presentation.approvalId },
        context,
      });
      expect(completed.execution, JSON.stringify(completed, null, 2)).toMatchObject({ ok: true });
      await expect(readFile(path.join(root, 'telegram-note.txt'), 'utf8')).resolves.toBe('готово');

      await expect(app.resolveAgentSurfaceApproval({
        text: '',
        approval: { action: 'approve', approvalId: presentation.approvalId },
        context,
      })).rejects.toMatchObject({ code: 'approval-presentation-stale' });
    } finally {
      await app.stop();
    }
  }, 30_000);

  it('resolves the same exact Telegram approval after a full application restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-telegram-approval-restart-'));
    roots.push(root);
    const context = {
      clientConversationId: 'telegram:77:11',
      clientSessionId: 'telegram:77:11',
      clientRequestId: 'telegram:77:message:1',
      clientMessageId: 'telegram:77:message:1',
      telegramChatId: 77,
      telegramUserId: 11,
    };
    const options = {
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentDecisionProvider: new TelegramWriteDecisionProvider(),
      permissionProfile: {
        sandboxMode: 'read-only' as const,
        approvalPolicy: 'on-request' as const,
        autonomyMode: 'guided' as const,
      },
    };
    const first = new MonarchApplication(options);
    first.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await first.start();
    const pending = await first.submitAgentSurfaceIntent({
      text: 'создай файл telegram-note.txt с текстом готово',
      source: 'telegram',
      context,
    });
    const presentation = pending.execution?.metadata?.approvalPresentation as { approvalId: string; taskId: string };
    expect(presentation).toMatchObject({ approvalId: expect.any(String), taskId: expect.any(String) });
    await first.stop();

    const second = new MonarchApplication(options);
    second.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await second.start();
    try {
      const completed = await second.resolveAgentSurfaceApproval({
        text: '',
        approval: { action: 'approve', approvalId: presentation.approvalId },
        context,
      });
      expect(completed.execution, JSON.stringify(completed, null, 2)).toMatchObject({ ok: true });
      await expect(readFile(path.join(root, 'telegram-note.txt'), 'utf8')).resolves.toBe('готово');
      const task = await second.agentRuntime!.getTask(presentation.taskId);
      expect(task?.approvals).toEqual([expect.objectContaining({ id: presentation.approvalId, status: 'approved' })]);
    } finally {
      await second.stop();
    }
  }, 30_000);
});

class WorkspaceReportDecisionProvider implements AgentDecisionProvider {
  turns = 0;

  constructor(private readonly decisions: unknown[]) {}

  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.turns += 1;
    const context = request.compiledContext as {
      observations?: Array<{ id: string; status: string }>;
      artifacts?: Array<{ id: string }>;
      goal?: { expectedOutputs?: Array<{ id: string }>; successCriteria?: Array<{ id: string }> };
    };
    const successfulObservationIds = (context.observations || []).filter((entry) => entry.status === 'success').map((entry) => entry.id);
    const artifactIds = (context.artifacts || []).map((entry) => entry.id);
    const next = this.decisions[this.turns - 1] || {
      kind: 'complete',
      summary: 'Workspace report created and deterministically verified.',
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
    return Promise.resolve({ ok: true, rawText: JSON.stringify(next), role: 'fixture', adapter: 'fixture' });
  }
}

class TelegramWriteDecisionProvider implements AgentDecisionProvider {
  async decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    const context = request.compiledContext as {
      observations?: Array<{ id: string; status: string }>;
      artifacts?: Array<{ id: string }>;
      executionPhase?: 'planning' | 'execution';
    };
    if (context.executionPhase === 'planning') {
      return {
        ok: true,
        rawText: JSON.stringify({
          kind: 'revise-plan',
          summary: 'Create the exact requested file and verify its persisted bytes.',
          steps: [{
            title: 'Create and verify telegram-note.txt',
            expectedEffect: 'The requested file exists with the exact requested content.',
          }],
          reason: 'Plan the requested effect before selecting a capability.',
        }),
        role: 'fixture-agent-model',
        adapter: 'fixture-agent-model',
      };
    }
    const observation = context.observations?.find((entry) => entry.status === 'success');
    const artifact = context.artifacts?.[0];
    const decision = observation
      ? {
          kind: 'complete',
          summary: 'Файл telegram-note.txt создан, содержимое проверено.',
          evidenceObservationIds: [observation.id],
          artifactIds: artifact ? [artifact.id] : [],
          evidenceBindings: [
            {
              targetType: 'expected-output',
              targetId: 'surface_verified_outcome',
              observationIds: [observation.id],
              artifactIds: artifact ? [artifact.id] : [],
            },
            {
              targetType: 'success-criterion',
              targetId: 'surface_outcome_verified',
              observationIds: [observation.id],
              artifactIds: [],
            },
          ],
        }
      : {
          kind: 'act',
          capabilityId: 'workspace.files.write',
          input: { path: 'telegram-note.txt', content: 'готово', overwrite: false },
          reason: 'Create the exact file requested by the Telegram user.',
          expectedEffect: 'The exact workspace file exists with the requested bytes.',
          verification: [{ kind: 'read-after-write', target: 'telegram-note.txt', value: 'готово' }],
        };
    return Promise.resolve({
      ok: true,
      rawText: JSON.stringify(decision),
      role: 'fixture-agent-model',
      adapter: 'fixture-agent-model',
    });
  }
}

class BlockingDecisionProvider implements AgentDecisionProvider {
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

class UnavailableDecisionProvider implements AgentDecisionProvider {
  turns = 0;

  async decide(): Promise<AgentModelDecisionResponse> {
    this.turns += 1;
    return {
      ok: false,
      error: 'agent-decision-model-unavailable',
      role: 'gemma4-balanced',
      adapter: 'oscar-agent-raw',
      degraded: true,
      latencyMs: 25,
    };
  }
}

class MutationRecoveryDecisionProvider implements AgentDecisionProvider {
  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    const context = request.compiledContext as {
      observations: Array<{ id: string; status: string }>;
      artifacts: Array<{ id: string }>;
      goal: { expectedOutputs: Array<{ id: string }>; successCriteria: Array<{ id: string }> };
    };
    if (context.observations.length < 2) {
      const retry = context.observations.length === 1;
      return Promise.resolve({
        ok: true,
        rawText: JSON.stringify({
          kind: 'act',
          capabilityId: 'workspace.files.write',
          input: {
            path: 'runtime/retry-report.md',
            content: retry ? '# Recovered\n\nrecovered content\n' : '# First attempt\n',
            overwrite: retry,
          },
          reason: retry ? 'Retry the same target with the explicitly allowed replacement.' : 'Attempt the requested target without replacement.',
          expectedEffect: 'runtime/retry-report.md contains recovered content.',
          verification: [
            { kind: 'exists', target: 'runtime/retry-report.md' },
            { kind: 'contains', target: 'runtime/retry-report.md', value: retry ? 'recovered content' : 'First attempt' },
          ],
        }),
        role: 'fixture',
      });
    }
    const observationIds = context.observations.filter((entry) => entry.status === 'success').map((entry) => entry.id);
    const artifactIds = context.artifacts.map((entry) => entry.id);
    return Promise.resolve({
      ok: true,
      rawText: JSON.stringify({
        kind: 'complete',
        summary: 'The corrected same-target mutation is verified.',
        evidenceObservationIds: observationIds,
        artifactIds,
        evidenceBindings: [
          ...context.goal.expectedOutputs.map((target) => ({
            targetType: 'expected-output', targetId: target.id, observationIds, artifactIds,
          })),
          ...context.goal.successCriteria.map((target) => ({
            targetType: 'success-criterion', targetId: target.id, observationIds, artifactIds,
          })),
        ],
      }),
      role: 'fixture',
    });
  }
}

interface WorkspaceReportReplay {
  schemaVersion: 'monarch.agent-replay.v1';
  name: string;
  decisions: unknown[];
  expectedObservations: Array<{ capabilityId: string; status: string }>;
}

async function loadWorkspaceReportReplay(): Promise<WorkspaceReportReplay> {
  const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'agent', 'workspace-report-replay.json');
  return JSON.parse(await readFile(fixturePath, 'utf8')) as WorkspaceReportReplay;
}

async function waitForStatus(
  app: MonarchApplication,
  taskId: string,
  status: string,
): Promise<NonNullable<Awaited<ReturnType<NonNullable<MonarchApplication['agentRuntime']>['getTask']>>>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const checkpoint = await app.agentRuntime!.getTask(taskId);
    if (checkpoint?.task.status === status) return checkpoint;
    if (checkpoint && ['failed', 'cancelled', 'completed'].includes(checkpoint.task.status) && checkpoint.task.status !== status) {
      throw new Error(`Task reached ${checkpoint.task.status}: ${checkpoint.task.terminalReason?.summary || 'no detail'} :: ${JSON.stringify({ usage: checkpoint.task.usage, plan: checkpoint.task.plan, observations: checkpoint.observations.map((entry) => ({ id: entry.id, status: entry.status, capabilityId: entry.capabilityId, evidence: entry.evidence })), artifacts: checkpoint.task.artifacts, events: checkpoint.events.slice(-12).map((entry) => ({ type: entry.type, payload: entry.payload })) })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const latest = await app.agentRuntime!.getTask(taskId);
  throw new Error(`Timed out waiting for task ${taskId} status ${status}; current=${latest?.task.status || 'missing'}; events=${latest?.events.slice(-5).map((event) => event.type).join(',') || 'none'}.`);
}
