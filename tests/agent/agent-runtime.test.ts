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
      enabledModules: ['workspace', 'security'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: provider,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request', autonomyMode: 'guided' },
    });
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
      expect(provider.turns).toBeGreaterThanOrEqual(6);
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
      expect(provider.requests[1]?.repair).toMatchObject({ attempt: 1 });
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

  it('allows a verified same-target mutation to supersede a prior no-side-effect failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-mutation-recovery-'));
    roots.push(root);
    await mkdir(path.join(root, 'runtime'), { recursive: true });
    await writeFile(path.join(root, 'runtime', 'retry-report.md'), 'old content\n', 'utf8');
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace', 'security'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: new MutationRecoveryDecisionProvider(),
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never', autonomyMode: 'full-local' },
    });
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: 'Write recovered content to runtime/retry-report.md and verify the final file.',
        source: { surface: 'api' },
        expectedOutputs: [{ id: 'retry-report', kind: 'artifact', description: 'runtime/retry-report.md contains recovered content.' }],
        successCriteria: [{ id: 'retry-verified', description: 'The final same-target write is deterministically verified.' }],
      });
      const waiting = await waitForStatus(app, created.task.id, 'waiting-for-approval');
      await app.agentRuntime!.resolveApproval(created.task.id, waiting.approvals[0]!.id, {
        decision: 'approve',
        grantScope: 'once',
      });
      const completed = await waitForStatus(app, created.task.id, 'completed');
      expect(completed.observations.map((entry) => entry.status)).toEqual(['failed', 'success']);
      expect(completed.approvals).toHaveLength(1);
      await expect(readFile(path.join(root, 'runtime', 'retry-report.md'), 'utf8')).resolves.toContain('recovered content');
      expect(completed.events.some((event) => event.type === 'task.completed')).toBe(true);
    } finally {
      await app.stop();
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
      throw new Error(`Task reached ${checkpoint.task.status}: ${checkpoint.task.terminalReason?.summary || 'no detail'} :: ${JSON.stringify({ usage: checkpoint.task.usage, observations: checkpoint.observations.map((entry) => ({ id: entry.id, status: entry.status, capabilityId: entry.capabilityId, evidence: entry.evidence })), artifacts: checkpoint.task.artifacts, events: checkpoint.events.slice(-12).map((entry) => ({ type: entry.type, payload: entry.payload })) })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const latest = await app.agentRuntime!.getTask(taskId);
  throw new Error(`Timed out waiting for task ${taskId} status ${status}; current=${latest?.task.status || 'missing'}; events=${latest?.events.slice(-5).map((event) => event.type).join(',') || 'none'}.`);
}
