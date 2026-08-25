import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryAgentTaskStore,
  type AgentDecisionProvider,
  type AgentModelDecisionRequest,
  type AgentModelDecisionResponse,
} from '../../src/agent';
import { MonarchApplication } from '../../src/app/application';
import { CoderAgentController } from '../../src/app/coder-agent-controller';
import { builtInModulePackages } from '../../src/modules';
import {
  InMemoryOscarTurnStore,
  OscarTurnCoordinator,
} from '../../src/oscar-turn';
import { withDeterministicSecurityModule } from '../fixtures/agent/deterministic-security-module';

const TEST_TIMEOUT_MS = 30_000;

class WriteThenCompleteProvider implements AgentDecisionProvider {
  calls: AgentModelDecisionRequest[] = [];

  async decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.calls.push(request);
    const context = request.compiledContext as {
      goal: {
        expectedOutputs: Array<{ id: string }>;
        successCriteria: Array<{ id: string }>;
      };
      observations: Array<{ id: string; capabilityId: string }>;
    };
    const observation = [...context.observations].reverse().find((entry) => entry.capabilityId === 'coder.files.write');
    if (!observation) {
      return {
        ok: true,
        model: 'qwen3-coder-30b-a3b-instruct',
        rawText: JSON.stringify({
          schemaVersion: 'monarch.agent-decision.v1',
          kind: 'act',
          capabilityId: 'coder.files.write',
          input: {
            projectId: 'model_attempted_project_switch',
            path: 'src/ready.ts',
            content: 'export const ready = true;\n',
            overwrite: true,
          },
          reason: 'Create the requested source file.',
          expectedEffect: 'The selected project contains src/ready.ts.',
          verification: [{ kind: 'exists', target: 'src/ready.ts' }],
        }),
      };
    }
    const evidenceBindings = [
      ...context.goal.expectedOutputs.map((entry) => ({
        targetType: 'expected-output',
        targetId: entry.id,
        observationIds: [observation.id],
        artifactIds: [],
      })),
      ...context.goal.successCriteria.map((entry) => ({
        targetType: 'success-criterion',
        targetId: entry.id,
        observationIds: [observation.id],
        artifactIds: [],
      })),
    ];
    return {
      ok: true,
      model: 'qwen3-coder-30b-a3b-instruct',
      rawText: JSON.stringify({
        schemaVersion: 'monarch.agent-decision.v1',
        kind: 'complete',
        summary: 'Файл создан и проверен через Kernel receipt.',
        evidenceObservationIds: [observation.id],
        artifactIds: [],
        evidenceBindings,
      }),
    };
  }
}

class EscapingWriteProvider implements AgentDecisionProvider {
  async decide(): Promise<AgentModelDecisionResponse> {
    return {
      ok: true,
      model: 'qwen3-coder-30b-a3b-instruct',
      rawText: JSON.stringify({
        schemaVersion: 'monarch.agent-decision.v1',
        kind: 'act',
        capabilityId: 'coder.files.write',
        input: {
          path: '..\\escaped.txt',
          content: 'must not exist',
          overwrite: true,
        },
        reason: 'Attempt to leave project.',
        expectedEffect: 'Write outside the project.',
        verification: [{ kind: 'exists', target: '..\\escaped.txt' }],
      }),
    };
  }
}

class WaitRuntimeProvider implements AgentDecisionProvider {
  async decide(): Promise<AgentModelDecisionResponse> {
    return {
      ok: true,
      model: 'qwen3-coder-30b-a3b-instruct',
      rawText: JSON.stringify({
        schemaVersion: 'monarch.agent-decision.v1',
        kind: 'wait-runtime',
        runtimeId: 'test-runtime',
        reason: 'Wait until cancellation.',
      }),
    };
  }
}

function createCoderTestApplication(
  workspaceRoot: string,
  decisionProvider: AgentDecisionProvider,
): MonarchApplication {
  const app = new MonarchApplication({
    workspaceRoot,
    packages: withDeterministicSecurityModule(builtInModulePackages),
    enableAgentRuntimeV2: true,
    agentTaskStore: new InMemoryAgentTaskStore(),
    agentDecisionProvider: decisionProvider,
    permissionProfile: {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      autonomyMode: 'full-local',
    },
  });
  const coordinator = new OscarTurnCoordinator({
    persistentStore: new InMemoryOscarTurnStore(),
    volatileStore: new InMemoryOscarTurnStore(),
    agentRuntime: app.agentRuntime,
    incognitoAgentRuntime: app.incognitoAgentRuntime,
    answerExecutor: async () => (async function* emptyAnswer() {
      yield { type: 'done' as const, ok: true };
    }()),
    persistMessage: async () => ({ disposition: 'created' as const }),
    agentFirst: true,
  });
  (app as unknown as { oscarTurnCoordinator: OscarTurnCoordinator }).oscarTurnCoordinator = coordinator;
  return app;
}

describe('CoderAgentController · common Agent Runtime', () => {
  it('creates one Coder Turn and one project-bound AgentTask instead of the legacy loop', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-agent-first-'));
    const provider = new WriteThenCompleteProvider();
    const app = createCoderTestApplication(root, provider);
    await app.start();
    try {
      const controller = new CoderAgentController(app);
      const selected = await controller.createProject('Selected Project');
      const other = await controller.createProject('Other Project');
      const legacyOscarCall = vi.spyOn(app, 'executeCapability');

      const started = await controller.start('В выбранном Coder проекте создай src/ready.ts.', selected.project.id);
      const completed = await waitForTerminalWithDiagnostics(controller, app, started.id);
      const completedTask = completed.agentTaskId ? await app.agentRuntime!.getTask(completed.agentTaskId) : null;

      expect(
        completed.status,
        `${completed.error}\n${JSON.stringify({ events: completed.events.slice(-8), completedTask }, null, 2)}`,
      ).toBe('completed');
      expect(completed.oscarTurnId).toMatch(/^oscar_turn_/u);
      expect(completed.agentTaskId).toMatch(/^agent_task_/u);
      expect(completed.answer).toContain('ready.ts');
      expect(provider.calls).toHaveLength(1);
      expect(await readFile(path.join(selected.project.root, 'src', 'ready.ts'), 'utf8')).toContain('ready = true');
      await expect(access(path.join(other.project.root, 'src', 'ready.ts'))).rejects.toThrow();
      expect(legacyOscarCall).not.toHaveBeenCalled();

      const turn = await app.oscarTurnCoordinator.getTurn(completed.oscarTurnId!);
      const task = await app.agentRuntime!.getTask(completed.agentTaskId!);
      expect(turn?.turn).toMatchObject({
        source: 'coder',
        mode: 'agent',
        taskId: completed.agentTaskId,
      });
      expect(task?.task).toMatchObject({
        source: { surface: 'coder' },
        decisionModelPolicy: {
          requestedRole: 'qwen3-coder-30b-a3b-instruct',
          selectionSource: 'user-explicit',
          fallback: 'exact',
        },
        executionProfile: {
          schemaVersion: 'monarch.agent-execution-profile.v1',
          kind: 'coder-project',
          projectId: selected.project.id,
          projectRoot: selected.project.root,
        },
      });
      expect(task?.observations.some((entry) => entry.capabilityId === 'coder.files.write')).toBe(true);
      expect(provider.calls[0]?.capabilities.some((entry) => entry.id === 'coder.files.write')).toBe(true);
      expect(task?.events.some((entry) => entry.type === 'plan.revised')).toBe(false);
      expect(completed.events.some((entry) => entry.detail.includes('[object Object]'))).toBe(false);
      expect(completed.events).toContainEqual(expect.objectContaining({
        kind: 'tool-start',
        capabilityId: 'coder.files.write',
        detail: expect.stringContaining('ready.ts'),
      }));
      expect(completed.summary.modifiedFiles).toContain(path.join(selected.project.root, 'src', 'ready.ts'));
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('rejects a model-authored path that escapes the runtime-bound project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-scope-'));
    const app = createCoderTestApplication(root, new EscapingWriteProvider());
    await app.start();
    try {
      const controller = new CoderAgentController(app);
      const selected = await controller.createProject('Scope Project');
      const started = await controller.start('В выбранном проекте создай файл escaped.txt, но не выходи из проекта.', selected.project.id);
      const completed = await controller.waitForTerminal(started.id);

      expect(completed.status).toBe('failed');
      expect(
        completed.events.some((entry) => /scope|project/iu.test(`${entry.title} ${entry.detail} ${entry.error || ''}`)),
        JSON.stringify(completed.events.slice(-8), null, 2),
      ).toBe(true);
      await expect(access(path.resolve(selected.project.root, '..', 'escaped.txt'))).rejects.toThrow();
      expect(app.runtime.kernel.listActionLedger().some((entry) => entry.capabilityId === 'coder.files.write')).toBe(false);
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('keeps pre-migration Coder checkpoints read-only', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-legacy-'));
    const app = createCoderTestApplication(root, new WaitRuntimeProvider());
    await app.start();
    try {
      const controller = new CoderAgentController(app);
      const selected = await controller.createProject('Legacy Project');
      const legacy = controller.runs.create(selected.project.id, 'legacy task', PRIMARY_MODEL_FOR_TEST, {
        name: selected.project.name,
        root: selected.project.root,
      });
      controller.runs.setStatus(legacy.id, 'interrupted', 'Migrated legacy checkpoint.');

      await expect(controller.resume(legacy.id)).rejects.toThrow(/legacy Coder checkpoint is read-only/iu);
      expect(controller.runs.require(legacy.id).agentTaskId).toBeUndefined();
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('cancels the linked Turn and AgentTask through the common cancellation path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-cancel-'));
    const app = createCoderTestApplication(root, new WaitRuntimeProvider());
    await app.start();
    try {
      const controller = new CoderAgentController(app);
      const selected = await controller.createProject('Cancel Project');
      const started = await controller.start('Жди runtime до моей отмены.', selected.project.id);
      const cancelled = await controller.cancel(started.id);
      const terminal = await controller.waitForTerminal(started.id);

      expect(cancelled.cancelled).toBe(true);
      expect(terminal.status).toBe('cancelled');
      const turn = await app.oscarTurnCoordinator.getTurn(terminal.oscarTurnId!);
      const task = await app.agentRuntime!.getTask(terminal.agentTaskId!);
      expect(turn?.turn.status).toBe('cancelled');
      expect(task?.task.status).toBe('cancelled');
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

const PRIMARY_MODEL_FOR_TEST = 'qwen3-coder-30b-a3b-instruct' as const;

async function waitForTerminalWithDiagnostics(
  controller: CoderAgentController,
  app: MonarchApplication,
  runId: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      controller.waitForTerminal(runId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const run = controller.runs.get(runId);
          void (run?.agentTaskId ? app.agentRuntime?.getTask(run.agentTaskId) : Promise.resolve(null))
            .then((checkpoint) => reject(new Error(JSON.stringify({ run, checkpoint }, null, 2))), reject);
        }, 8_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
