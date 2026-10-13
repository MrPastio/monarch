import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import { CoderAgentController } from '../../src/app/coder-agent-controller';
import { builtInModulePackages } from '../../src/modules';
import { CoderModule } from '../../src/modules/coder';
import { CoderRunStore } from '../../src/modules/coder/context-manager';
import {
  InMemoryOscarTurnStore,
  OscarTurnCoordinator,
} from '../../src/oscar-turn';
import { withDeterministicSecurityModule } from '../fixtures/agent/deterministic-security-module';

const TEST_TIMEOUT_MS = 30_000;

function createCoderTestApplication(workspaceRoot: string): MonarchApplication {
  const app = new MonarchApplication({
    workspaceRoot,
    packages: withDeterministicSecurityModule(builtInModulePackages),
    permissionProfile: {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      autonomyMode: 'full-local',
    },
  });
  const coordinator = new OscarTurnCoordinator({
    persistentStore: new InMemoryOscarTurnStore(),
    volatileStore: new InMemoryOscarTurnStore(),
    answerExecutor: async () => (async function* emptyAnswer() {
      yield { type: 'done' as const, ok: true };
    }()),
    persistMessage: async () => ({ disposition: 'created' as const }),
    agentFirst: true,
  });
  (app as unknown as { oscarTurnCoordinator: OscarTurnCoordinator }).oscarTurnCoordinator = coordinator;
  return app;
}

describe('CoderAgentController · Astra V3 Agent Runtime', () => {
  it('accepts once before model linkage and repairs a commit lost between read and subscribe', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-queued-max-'));
    const coder = new CoderModule({ monarchRoot: root });
    const project = await coder.projects.create('Universal MAX');
    const queued = { id: 'queued_turn', source: 'coder', status: 'queued', request: {} } as any;
    const linked = { ...queued, taskId: 'cloud_task', status: 'succeeded',
      request: { astra: { goal: { kind: 'agent' } } }, outcome: { summary: 'Verified cloud result.' } };
    let checkpoint = { turn: queued, events: [] };
    const unsubscribe = vi.fn();
    const coordinator = {
      submit: vi.fn(async () => ({ turn: queued, events: [] })),
      getTurn: vi.fn(async () => checkpoint),
      persistentStore: { getTurn: vi.fn(async () => checkpoint), subscribe: vi.fn(() => {
        checkpoint = { turn: linked, events: [] }; return unsubscribe;
      }) },
      subscribe: vi.fn(() => unsubscribe),
    };
    const app = {
      runtime: { kernel: { getModule: () => coder } }, oscarTurnCoordinator: coordinator,
      getPermissionProfile: () => ({ sandboxMode: 'danger-full-access', approvalPolicy: 'never', autonomyMode: 'full-local' }),
      readPersonalityContext: async () => ({ context: null }),
      astraProductPilot: { localAgentModels: [], maxModelConfigured: true, facade: { agentTasks: {} },
        bridge: { find: () => ({ id: 'cloud_task', status: 'completed', modelJobs: 1, capabilityJobs: 0, activities: [] }) } },
    } as unknown as MonarchApplication;
    try {
      const controller = new CoderAgentController(app);
      const role = 'max-cloud:openrouter:Owner/New-Model:free' as const;
      const accepted = await controller.start('Verify the project.', project.id, role, 'request_once');
      expect(accepted).toMatchObject({ model: role, oscarTurnId: queued.id, clientRequestId: 'request_once' });
      const replay = await controller.start('Verify the project.', project.id, role, 'request_once');
      expect(replay.id).toBe(accepted.id);
      expect(coordinator.submit).toHaveBeenCalledOnce();
      await expect(controller.start('Different task.', project.id, role, 'request_once')).rejects.toMatchObject({ code: 'coder-request-conflict' });
      await expect(controller.start('Use unconfigured local model.', project.id, PRIMARY_MODEL_FOR_TEST)).rejects.toMatchObject({ code: 'coder-model-unavailable' });
      const completed = await controller.waitForTerminal(accepted.id);
      expect(completed).toMatchObject({ status: 'completed', agentTaskId: 'cloud_task', answer: 'Verified cloud result.' });
      expect(coordinator.persistentStore.getTurn).toHaveBeenCalledTimes(2);
      expect(unsubscribe).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('continues a session with its earlier requests and outcomes as agent history, never across projects', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-session-'));
    const coder = new CoderModule({ monarchRoot: root });
    const project = await coder.projects.create('Session project');
    const other = await coder.projects.create('Other project');
    let counter = 0;
    const submitted: any[] = [];
    const coordinator = {
      submit: vi.fn(async (input: any) => {
        submitted.push(input);
        const turn = { id: `turn_${++counter}`, source: 'coder', status: 'succeeded', taskId: `task_${counter}`,
          request: { astra: { goal: { kind: 'agent' } } }, outcome: { summary: `Итог ${counter}.` } };
        return { turn, events: [] };
      }),
      getTurn: vi.fn(async (id: string) => ({ turn: { id, source: 'coder', status: 'succeeded', taskId: id.replace('turn', 'task'),
        request: { astra: { goal: { kind: 'agent' } } }, outcome: { summary: 'Итог.' } }, events: [] })),
      persistentStore: { getTurn: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      subscribe: vi.fn(() => () => undefined),
    };
    const app = {
      runtime: { kernel: { getModule: () => coder } }, oscarTurnCoordinator: coordinator,
      getPermissionProfile: () => ({ sandboxMode: 'danger-full-access', approvalPolicy: 'never', autonomyMode: 'full-local' }),
      readPersonalityContext: async () => ({ context: null }),
      astraProductPilot: { localAgentModels: [], maxModelConfigured: true, facade: { agentTasks: {} },
        bridge: { find: (turn: any) => ({ id: turn.taskId, status: 'completed', modelJobs: 1, capabilityJobs: 0, activities: [] }) } },
    } as unknown as MonarchApplication;
    try {
      const controller = new CoderAgentController(app);
      const role = 'max-cloud:openrouter:Owner/New-Model:free' as const;
      const first = await controller.start('Создай hello.py.', project.id, role);
      await controller.waitForTerminal(first.id);
      expect(submitted[0].history).toBeUndefined();
      expect(submitted[0].conversationId).toBe(first.sessionId);
      const second = await controller.start('Теперь добавь greet().', project.id, role, undefined, first.sessionId);
      expect(second.sessionId).toBe(first.sessionId);
      expect(submitted[1].conversationId).toBe(first.sessionId);
      expect(submitted[1].history).toEqual([
        { role: 'user', content: 'Создай hello.py.' },
        { role: 'assistant', content: expect.stringContaining('Итог') },
      ]);
      await expect(controller.start('Чужой проект.', other.id, role, undefined, first.sessionId))
        .rejects.toMatchObject({ code: 'coder-session-unavailable' });
      expect(controller.runs.sessionRuns(first.sessionId!).map(run => run.id)).toEqual([first.id, second.id]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, TEST_TIMEOUT_MS);

  it('stops an accepted queued MAX task without waiting for model linkage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-early-stop-'));
    const coder = new CoderModule({ monarchRoot: root });
    const project = await coder.projects.create('Queued MAX');
    let checkpoint = { turn: { id: 'queued_max_stop', source: 'coder', status: 'queued', request: {} }, events: [] } as any;
    let notify: ((commit: any) => void) | undefined;
    const coordinator = { submit: vi.fn(async () => checkpoint), getTurn: vi.fn(async () => checkpoint),
      persistentStore: { getTurn: async () => checkpoint, subscribe: (_id: string, listener: typeof notify) => {
        notify = listener; return () => { notify = undefined; };
      } }, cancel: vi.fn(async () => {
        checkpoint = { ...checkpoint, turn: { ...checkpoint.turn, status: 'cancelled' } };
        notify?.(checkpoint); return checkpoint;
      }) };
    const app = { runtime: { kernel: { getModule: () => coder } }, oscarTurnCoordinator: coordinator,
      getPermissionProfile: () => ({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' }),
      readPersonalityContext: async () => ({ context: null }),
      astraProductPilot: { localAgentModels: [], maxModelConfigured: true, facade: { agentTasks: {} } },
    } as unknown as MonarchApplication;
    try {
      const controller = new CoderAgentController(app);
      const accepted = await controller.start('Wait for a model.', project.id, 'max-cloud:openrouter:Any/Model', 'early_stop');
      await expect(controller.start('Second task.', project.id, 'max-cloud:openrouter:Any/Model')).rejects.toMatchObject({ code: 'coder-project-busy' });
      expect(await controller.cancel(accepted.id)).toMatchObject({ status: 'cancelled', cancelled: true });
      expect(coordinator.cancel).toHaveBeenCalledExactlyOnceWith('queued_max_stop', 'coder');
      expect(coordinator.submit).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('never creates a new V2 Coder task when the Astra V3 host is unavailable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-agent-first-'));
    const app = createCoderTestApplication(root);
    await app.start();
    try {
      const controller = new CoderAgentController(app);
      const selected = await controller.createProject('Selected Project');
      const legacyOscarCall = vi.spyOn(app, 'executeCapability');

      await expect(controller.start('В выбранном Coder проекте создай src/ready.ts.', selected.project.id))
        .rejects.toThrow(/Astra V3 Agent Runtime is unavailable/iu);
      expect(controller.runs.list()).toEqual([]);
      expect('agentRuntime' in app).toBe(false);
      expect(await app.oscarTurnCoordinator.persistentStore.listTurns()).toEqual([]);
      await expect(access(path.join(selected.project.root, 'src', 'ready.ts'))).rejects.toThrow();
      expect(legacyOscarCall).not.toHaveBeenCalled();

      let direct = await app.oscarTurnCoordinator.submit({
        clientRequestId: 'coder_direct_no_v2', conversationId: 'coder_direct_conversation',
        inputMessageId: 'coder_direct_message', text: 'Не создавай V2 fallback.', source: 'coder', privacyMode: 'persistent',
        modifiers: { requestedModel: 'qwen3-coder-30b-a3b-instruct' }, executionProfile: {
          schemaVersion: 'monarch.agent-execution-profile.v1', kind: 'coder-project', projectId: selected.project.id,
          projectRoot: selected.project.root, permissionProfile: {
            sandboxMode: 'danger-full-access', approvalPolicy: 'never', autonomyMode: 'full-local',
          },
        },
      });
      const deadline = Date.now() + 2_000;
      while (!['blocked', 'failed', 'cancelled', 'succeeded'].includes(direct.turn.status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
        direct = (await app.oscarTurnCoordinator.getTurn(direct.turn.id))!;
      }
      expect(direct.turn).toMatchObject({ status: 'blocked',
        outcome: { summary: expect.stringContaining('не переключается на устаревший runtime') } });
      expect(direct.turn.taskId).toBeUndefined();
      expect('agentRuntime' in app).toBe(false);
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('enforces the exact UTF-8 prompt budget before allocating a Coder run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-scope-'));
    const app = createCoderTestApplication(root);
    await app.start();
    try {
      const controller = new CoderAgentController(app);
      const selected = await controller.createProject('Scope Project');
      await expect(controller.start('я'.repeat(10_001), selected.project.id)).rejects.toThrow(/20,000 UTF-8 byte limit/iu);
      expect(controller.runs.list()).toEqual([]);
      expect(app.runtime.kernel.listActionLedger().some((entry) => entry.capabilityId === 'coder.files.write')).toBe(false);
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('does not replace an unavailable MAX Coder request with a local model', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-max-unavailable-'));
    const app = createCoderTestApplication(root);
    await app.start();
    const previousPilot = app.astraProductPilot;
    app.astraProductPilot = { facade: { agentTasks: {} }, maxModelConfigured: false } as never;
    try {
      const controller = new CoderAgentController(app);
      const selected = await controller.createProject('MAX Project');
      await expect(controller.start('Проверь проект через MAX.', selected.project.id, 'max-gpt-oss-120b'))
        .rejects.toThrow(/will not fall back to a local model/iu);
      expect(controller.runs.list()).toEqual([]);
    } finally {
      app.astraProductPilot = previousPilot;
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('keeps pre-migration Coder checkpoints read-only', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-legacy-'));
    const app = createCoderTestApplication(root);
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
      await expect(controller.cancel(legacy.id)).rejects.toThrow(/legacy Coder checkpoint is read-only/iu);
      expect(controller.runs.require(legacy.id).agentTaskId).toBeUndefined();
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);

  it('binds a Coder reply to the exact current V3 question with host-owned message identities', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-reply-'));
    let awaitingQuestion = true;
    const question = {
      id: 'agent_question_exact_1',
      digest: `sha256:${'b'.repeat(64)}`,
      text: 'Как назвать итоговый файл?',
      conversationId: 'coder_project_project-1',
      predecessorMessageId: 'coder_message_initial',
      expiresAt: Date.now() + 60_000,
      authority: 'none' as const,
      nativeCompletionCertified: false as const,
    };
    const turn = {
      id: 'coder_turn_exact_1', taskId: 'astra_agent_task_exact_1', source: 'coder', status: 'running',
      request: { astra: { goal: { kind: 'agent' } } },
    } as any;
    const submitAstraInput = vi.fn(async () => { awaitingQuestion = false; return { turn, events: [] }; });
    const coordinator = {
      getTurn: vi.fn(async () => ({ turn, events: [] })),
      submitAstraInput,
      flushOutbox: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    };
    const task = () => ({
      id: turn.taskId, conversationId: question.conversationId, inputMessageId: 'coder_message_initial', source: 'coder',
      privacyMode: 'persistent', status: awaitingQuestion ? 'awaiting-input' : 'awaiting-progression',
      nativeCompletionCertified: false, modelJobs: awaitingQuestion ? 1 : 2, readJobs: 0, capabilityJobs: 0,
      activities: [], ...(awaitingQuestion ? { question } : {}),
    });
    const coder = new CoderModule({ monarchRoot: root });
    const app = {
      runtime: { kernel: { getModule: () => coder } },
      oscarTurnCoordinator: coordinator,
      astraProductPilot: { bridge: { find: task } },
    } as unknown as MonarchApplication;

    try {
      const controller = new CoderAgentController(app);
      const created = controller.runs.create('project-1', 'Создай итоговый файл.');
      controller.runs.bindAgentTurn(created.id, turn.id);
      controller.runs.projectAstraTask(created.id, {
        taskId: turn.taskId, status: 'running', modelTurns: 1, capabilityCalls: 0, activities: [],
        question: { id: question.id, digest: question.digest, text: question.text,
          predecessorMessageId: question.predecessorMessageId, expiresAt: new Date(question.expiresAt).toISOString() },
      });

      const resumed = await controller.reply(created.id, {
        questionId: question.id, questionDigest: question.digest, text: 'result.md',
      });
      expect(resumed).toMatchObject({ agentRuntimeVersion: 'v3', status: 'running' });
      expect(resumed.agentQuestion).toBeUndefined();
      expect(submitAstraInput).toHaveBeenCalledOnce();
      const submitted = submitAstraInput.mock.calls[0]![2] as any;
      expect(submitted).toMatchObject({ kind: 'reply', reply: {
        questionId: question.id, questionDigest: question.digest, text: 'result.md',
      } });
      expect(submitted.reply.requestId).toMatch(/^coder_reply_[a-f0-9-]{36}$/u);
      expect(submitted.reply.messageId).toMatch(/^coder_reply_message_[a-f0-9-]{36}$/u);

      await expect(controller.reply(created.id, {
        questionId: question.id, questionDigest: `sha256:${'c'.repeat(64)}`, text: 'stale.md',
      })).rejects.toMatchObject({ statusCode: 409, code: 'coder-question-binding' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('repairs the restart gap after Oscar Turn binding but before Agent Task projection', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-link-recovery-'));
    const coder = new CoderModule({ monarchRoot: root });
    const beforeRestart = new CoderRunStore({ monarchRoot: root });
    const created = beforeRestart.create('project-1', 'Finish the already admitted durable Coder task.');
    beforeRestart.bindAgentTurn(created.id, 'coder_turn_restart_gap');
    const turn = {
      id: 'coder_turn_restart_gap', taskId: 'astra_agent_task_restart_gap', source: 'coder', status: 'succeeded',
      request: { astra: { goal: { kind: 'agent' } } }, outcome: { summary: 'Recovered task completed.' },
    } as any;
    const task = {
      id: turn.taskId, conversationId: 'coder_project_project-1', inputMessageId: `coder_message_${created.id}`,
      source: 'coder', privacyMode: 'persistent', status: 'completed', nativeCompletionCertified: true,
      modelJobs: 5, readJobs: 0, capabilityJobs: 1, activities: [], message: {
        id: 'agent_message_restart_gap', taskId: turn.taskId, conversationId: 'coder_project_project-1',
        predecessorMessageId: `coder_message_${created.id}`, content: 'Recovered task completed.',
        certificateDigest: `sha256:${'d'.repeat(64)}`, delivery: 'pending',
        verification: 'native-agent-completion-certificate', nativeCompletionCertified: true,
      },
    };
    const coordinator = {
      getTurn: vi.fn(async () => ({ turn, events: [] })),
      subscribe: vi.fn(() => () => undefined),
    };
    const app = {
      runtime: { kernel: { getModule: () => coder } },
      oscarTurnCoordinator: coordinator,
      astraProductPilot: { bridge: { find: vi.fn(() => task) } },
    } as unknown as MonarchApplication;

    try {
      const controller = new CoderAgentController(app);
      const completed = await controller.waitForTerminal(created.id);
      expect(completed).toMatchObject({ status: 'completed', oscarTurnId: turn.id,
        agentTaskId: turn.taskId, agentRuntimeVersion: 'v3', answer: 'Recovered task completed.' });
      expect(completed.events.some((event) => event.title === 'Task recovery pending')).toBe(true);
      expect(completed.events.some((event) => event.title === 'Task interrupted')).toBe(false);
      expect(coordinator.getTurn).toHaveBeenCalledWith(turn.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const PRIMARY_MODEL_FOR_TEST = 'qwen3-coder-30b-a3b-instruct' as const;
