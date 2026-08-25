import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAgentTaskStore } from '../../src/agent/agent-task-store';
import type {
  AgentDecisionProvider,
  AgentModelDecisionRequest,
  AgentModelDecisionResponse,
} from '../../src/agent/model-decision-provider';
import { MonarchApplication } from '../../src/app/application';
import { DeviceModule, deviceModulePackage } from '../../src/modules/device';
import { WorkspaceModule, workspaceModulePackage } from '../../src/modules/workspace';
import { createDeterministicSecurityModule } from '../fixtures/agent/deterministic-security-module';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Desktop Oscar Agent Task actions', () => {
  it('lets the model select and execute a verified app launch without phrase routing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-desktop-agent-'));
    roots.push(root);
    const runner = vi.fn(async (script: string) => JSON.stringify(
      script.includes('$entries = New-Object')
        ? {
            entries: [{
              name: 'Калькулятор',
              launchId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
              source: 'start-apps',
            }],
          }
        : {
            opened: true,
            verified: true,
            displayName: 'Калькулятор',
            processId: 42,
            launcher: 'start-apps',
          },
    ));
    const decisionProvider = new AppLaunchDecisionProvider();
    const app = new MonarchApplication({
      workspaceRoot: root,
      packages: [{
        ...deviceModulePackage,
        factory: () => new DeviceModule(runner),
      }],
      enableLocalSystemRouter: false,
      permissionProfile: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        autonomyMode: 'workspace-autonomous',
      },
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: decisionProvider,
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: 'Мне нужен калькулятор перед глазами.',
        source: { surface: 'desktop' },
        expectedOutputs: [{
          id: 'app_opened',
          description: 'Выполни запрос и верни только проверенный результат: открой калькулятор.',
          kind: 'answer',
          required: true,
        }],
        successCriteria: [{
          id: 'launch_verified',
          description: 'Результат запроса подтверждён реальным observation/receipt, а не обещанием модели.',
        }],
      });
      await app.agentRuntime!.waitForIdle(created.task.id);
      const waiting = await app.agentRuntime!.getTask(created.task.id);
      expect(waiting?.task.status, JSON.stringify({
        terminalReason: waiting?.task.terminalReason,
        observations: waiting?.observations,
        approvals: waiting?.approvals,
        events: waiting?.events.slice(-12).map((event) => ({ type: event.type, payload: event.payload })),
      })).toBe('waiting-for-approval');
      expect(waiting?.approvals).toHaveLength(1);
      await app.agentRuntime!.resolveApproval(created.task.id, waiting!.approvals[0]!.id, {
        decision: 'approve',
        grantScope: 'once',
        requestId: 'approve-verified-app-launch',
        actorSurface: 'desktop',
      });
      await app.agentRuntime!.waitForIdle(created.task.id);
      const checkpoint = await app.agentRuntime!.getTask(created.task.id);

      expect(checkpoint?.task.status, JSON.stringify({
        terminalReason: checkpoint?.task.terminalReason,
        observations: checkpoint?.observations,
        events: checkpoint?.events.slice(-12).map((event) => ({ type: event.type, payload: event.payload })),
      })).toBe('completed');
      expect(checkpoint?.observations).toHaveLength(1);
      expect(checkpoint?.observations[0]).toMatchObject({
        capabilityId: 'device.app.open',
        status: 'success',
      });
      expect(checkpoint?.task.terminalReason?.summary).toContain('Калькулятор');
      expect(runner).toHaveBeenCalledTimes(2);
      expect(decisionProvider.calls).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('opens Telegram in Full Access + Observe with one model decision, one tool call, and no approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-desktop-agent-telegram-'));
    roots.push(root);
    const runner = vi.fn(async (script: string) => JSON.stringify(
      script.includes('$entries = New-Object')
        ? {
            entries: [{
              name: 'Telegram',
              launchId: 'Telegram.TelegramDesktop',
              source: 'start-apps',
            }],
          }
        : {
            opened: true,
            verified: true,
            displayName: 'Telegram',
            processId: 77,
            launcher: 'start-apps',
            matchedWindow: 'Telegram',
          },
    ));
    const decisionProvider = new AppLaunchDecisionProvider('Telegram');
    const app = new MonarchApplication({
      workspaceRoot: root,
      packages: [{
        ...deviceModulePackage,
        factory: () => new DeviceModule(runner),
      }],
      enableLocalSystemRouter: false,
      permissionProfile: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        autonomyMode: 'full-local',
      },
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: decisionProvider,
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    await app.runtime.kernel.emitRuntimeEvent('security.model_policy.changed', 'security', {
      modelCommandsEnabled: true,
      agentSecurityMode: 'observe',
      actionGuardReaction: 'observe',
    });
    try {
      const created = await app.createAgentTask({
        request: 'Открой Telegram',
        source: { surface: 'desktop' },
        expectedOutputs: [{
          id: 'telegram_opened',
          description: 'Telegram открыт и точное видимое окно подтверждено Kernel.',
          kind: 'state-change',
          required: true,
        }],
        successCriteria: [{
          id: 'telegram_window_verified',
          description: 'Kernel receipt подтверждает точное окно Telegram.',
        }],
      });
      await app.agentRuntime!.waitForIdle(created.task.id);
      const checkpoint = await app.agentRuntime!.getTask(created.task.id);
      const dangerEvents = app.runtime.kernel.getEvents().filter((event) => event.type === 'security.danger.assessed');

      expect(checkpoint?.task.status, JSON.stringify(checkpoint?.task.terminalReason)).toBe('completed');
      expect(checkpoint?.approvals).toEqual([]);
      expect(checkpoint?.observations).toHaveLength(1);
      expect(checkpoint?.observations[0]).toMatchObject({
        capabilityId: 'device.app.open',
        status: 'success',
      });
      expect(checkpoint?.events.filter((event) => event.type === 'model.completed')).toHaveLength(1);
      expect(checkpoint?.events.some((event) => event.type === 'plan.revised')).toBe(false);
      expect(decisionProvider.calls).toBe(1);
      expect(runner).toHaveBeenCalledTimes(2);
      expect(dangerEvents).toHaveLength(1);
      expect(dangerEvents[0]?.payload).toMatchObject({
        response: 'observe',
        assessment: {
          schemaVersion: 'monarch.agent-danger-assessment.v1',
          band: expect.stringMatching(/^(minimal|low)$/),
        },
      });
    } finally {
      await app.stop();
    }
  });

  it('lets the model create a verified file at an explicit local path in Full Access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-desktop-agent-file-'));
    roots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const targetPath = path.join(root, 'outside-workspace', 'agent-created.txt');
    const content = 'Создано реальным циклом Oscar Agent Runtime.';
    const decisionProvider = new FileWriteDecisionProvider(targetPath, content);
    const app = new MonarchApplication({
      workspaceRoot,
      packages: [{
        ...workspaceModulePackage,
        factory: () => new WorkspaceModule({ workspaceRoot }),
      }],
      enableLocalSystemRouter: false,
      permissionProfile: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'on-request',
        autonomyMode: 'full-local',
      },
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: decisionProvider,
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: `Создай файл ${targetPath} с точным содержимым: ${content}`,
        source: { surface: 'desktop' },
        expectedOutputs: [{
          id: 'file_created',
          description: `Файл ${targetPath} существует с запрошенным содержимым.`,
          kind: 'state-change',
          required: true,
        }],
        successCriteria: [{
          id: 'write_verified',
          description: `Запись ${targetPath} подтверждена чтением результата.`,
        }],
      });
      await app.agentRuntime!.waitForIdle(created.task.id);
      const checkpoint = await app.agentRuntime!.getTask(created.task.id);

      expect(checkpoint?.task.status).toBe('completed');
      expect(checkpoint?.observations).toHaveLength(1);
      expect(checkpoint?.observations[0]).toMatchObject({
        capabilityId: 'workspace.files.write',
        status: 'success',
      });
      await expect(readFile(targetPath, 'utf8')).resolves.toBe(content);
      expect(decisionProvider.calls).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('creates the exact Desktop artifact through the typed known-folder action and verified Agent contract', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const root = await mkdtemp(path.join(qaBase, 'desktop-agent-known-folder-'));
    roots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const desktop = path.join(root, 'Desktop');
    const targetPath = path.join(desktop, 'ромашка.txt');
    const previousDesktop = process.env.MONARCH_DESKTOP_DIR;
    const previousSmoke = process.env.MONARCH_SMOKE_TEST;
    process.env.MONARCH_DESKTOP_DIR = desktop;
    process.env.MONARCH_SMOKE_TEST = '1';
    await mkdir(desktop, { recursive: true });
    const decisionProvider = new KnownFolderWriteDecisionProvider();
    const app = new MonarchApplication({
      workspaceRoot,
      packages: [{
        ...workspaceModulePackage,
        factory: () => new WorkspaceModule({ workspaceRoot }),
      }],
      enableLocalSystemRouter: false,
      permissionProfile: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        autonomyMode: 'workspace-autonomous',
      },
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: decisionProvider,
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: 'создай на рабочем столе текстовый файл с именем ромашка',
        source: { surface: 'desktop' },
      });
      await app.agentRuntime!.waitForIdle(created.task.id);
      const checkpoint = await app.agentRuntime!.getTask(created.task.id);

      expect(checkpoint?.task.status, JSON.stringify({
        terminalReason: checkpoint?.task.terminalReason,
        plan: checkpoint?.task.plan,
        observations: checkpoint?.observations,
        approvals: checkpoint?.approvals,
        events: checkpoint?.events.slice(-20).map((event) => ({ type: event.type, payload: event.payload })),
      })).toBe('completed');
      expect(checkpoint?.task.goal.expectedOutputs).toContainEqual(
        expect.objectContaining({ kind: 'artifact', required: true }),
      );
      expect(checkpoint?.observations).toHaveLength(1);
      expect(checkpoint?.observations[0]).toMatchObject({
        capabilityId: 'workspace.known-folder.write',
        status: 'success',
        structuredData: {
          mutationTruth: { state: 'occurred' },
          output: {
            knownFolder: 'desktop',
            basename: 'ромашка.txt',
            path: targetPath,
            verified: true,
          },
        },
      });
      expect(checkpoint?.task.artifacts).toContainEqual(expect.objectContaining({ reference: targetPath }));
      await expect(readFile(targetPath, 'utf8')).resolves.toBe('');
      expect(decisionProvider.calls).toBe(1);
    } finally {
      await app.stop();
      if (previousDesktop === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = previousDesktop;
      if (previousSmoke === undefined) delete process.env.MONARCH_SMOKE_TEST;
      else process.env.MONARCH_SMOKE_TEST = previousSmoke;
    }
  });

  it('rejects task-wide approval for the exact known-folder action before capability dispatch', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const root = await mkdtemp(path.join(qaBase, 'desktop-agent-known-folder-lease-'));
    roots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const desktop = path.join(root, 'Desktop');
    const targetPath = path.join(desktop, 'ромашка.txt');
    const previousDesktop = process.env.MONARCH_DESKTOP_DIR;
    const previousSmoke = process.env.MONARCH_SMOKE_TEST;
    process.env.MONARCH_DESKTOP_DIR = desktop;
    delete process.env.MONARCH_SMOKE_TEST;
    await mkdir(desktop, { recursive: true });
    const app = new MonarchApplication({
      workspaceRoot,
      packages: [{
        ...workspaceModulePackage,
        factory: () => new WorkspaceModule({ workspaceRoot }),
      }],
      enableLocalSystemRouter: false,
      permissionProfile: {
        sandboxMode: 'read-only',
        approvalPolicy: 'on-request',
        autonomyMode: 'guided',
      },
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: new KnownFolderWriteDecisionProvider(),
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: 'создай на рабочем столе текстовый файл с именем ромашка',
        source: { surface: 'desktop' },
      });
      await app.agentRuntime!.waitForIdle(created.task.id);
      const waiting = await app.agentRuntime!.getTask(created.task.id);

      expect(waiting?.task.status).toBe('waiting-for-approval');
      expect(waiting?.approvals).toEqual([
        expect.objectContaining({ capabilityId: 'workspace.known-folder.write', status: 'pending' }),
      ]);
      expect(waiting?.observations).toEqual([]);
      await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await expect(app.agentRuntime!.resolveApproval(created.task.id, waiting!.approvals[0]!.id, {
        decision: 'approve',
        grantScope: 'task',
        requestId: 'reject-known-folder-task-lease',
        actorSurface: 'desktop',
      })).rejects.toMatchObject({ statusCode: 409, code: 'approval-scope-must-be-once' });

      const unchanged = await app.agentRuntime!.getTask(created.task.id);
      expect(unchanged?.task.status).toBe('waiting-for-approval');
      expect(unchanged?.approvals[0]).toMatchObject({ status: 'pending' });
      expect(unchanged?.approvals[0]?.grantScope).toBeUndefined();
      expect(unchanged?.task.checkpointVersion).toBe(waiting?.task.checkpointVersion);
      expect(unchanged?.task.eventSequence).toBe(waiting?.task.eventSequence);
      expect(unchanged?.events).toEqual(waiting?.events);
      expect(unchanged?.observations).toEqual([]);
      await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await app.stop();
      if (previousDesktop === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = previousDesktop;
      if (previousSmoke === undefined) delete process.env.MONARCH_SMOKE_TEST;
      else process.env.MONARCH_SMOKE_TEST = previousSmoke;
    }
  });

  it('rejects a verified generic write when the requested artifact belongs on Desktop', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const root = await mkdtemp(path.join(qaBase, 'desktop-agent-wrong-target-'));
    roots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const desktop = path.join(root, 'Desktop');
    const wrongTarget = path.join(workspaceRoot, 'ромашка.txt');
    const expectedTarget = path.join(desktop, 'ромашка.txt');
    const previousDesktop = process.env.MONARCH_DESKTOP_DIR;
    const previousSmoke = process.env.MONARCH_SMOKE_TEST;
    process.env.MONARCH_DESKTOP_DIR = desktop;
    process.env.MONARCH_SMOKE_TEST = '1';
    await mkdir(desktop, { recursive: true });
    const app = new MonarchApplication({
      workspaceRoot,
      packages: [{
        ...workspaceModulePackage,
        factory: () => new WorkspaceModule({ workspaceRoot }),
      }],
      enableLocalSystemRouter: false,
      permissionProfile: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        autonomyMode: 'workspace-autonomous',
      },
      enableAgentRuntimeV2: true,
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: new WrongFolderCompletionProvider(wrongTarget),
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      const created = await app.createAgentTask({
        request: 'создай на рабочем столе текстовый файл с именем ромашка',
        source: { surface: 'desktop' },
      });
      await app.agentRuntime!.waitForIdle(created.task.id);
      const checkpoint = await app.agentRuntime!.getTask(created.task.id);
      expect(checkpoint?.task.status).toBe('failed');
      await expect(readFile(wrongTarget, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(expectedTarget, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(checkpoint?.events.some((event) => event.type === 'task.completed')).toBe(false);
    } finally {
      await app.stop();
      if (previousDesktop === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = previousDesktop;
      if (previousSmoke === undefined) delete process.env.MONARCH_SMOKE_TEST;
      else process.env.MONARCH_SMOKE_TEST = previousSmoke;
    }
  });
});

class AppLaunchDecisionProvider implements AgentDecisionProvider {
  calls = 0;

  constructor(private readonly appName = 'Калькулятор') {}

  async decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.calls += 1;
    const context = request.compiledContext as {
      observations?: Array<{ id: string; status: string; structuredData?: unknown }>;
    };
    const observation = context.observations?.find((entry) => entry.status === 'success');
    const decision = observation
      ? {
          kind: 'complete',
          summary: `${this.appName} открыт и запуск подтверждён Windows.`,
          evidenceObservationIds: [observation.id],
          artifactIds: [],
          evidenceBindings: [
            {
              targetType: 'expected-output',
              targetId: 'app_opened',
              observationIds: [observation.id],
              artifactIds: [],
            },
            {
              targetType: 'success-criterion',
              targetId: 'launch_verified',
              observationIds: [observation.id],
              artifactIds: [],
            },
          ],
        }
      : {
          kind: 'act',
          capabilityId: 'device.app.open',
          input: { app: this.appName },
          reason: 'Open the application requested by the user.',
          expectedEffect: 'One calculator application is launched.',
          // Real local models may echo the manifest descriptor instead of the
          // predicate grammar. The capability contract must still own launch
          // verification and let the action reach the Kernel.
          verification: [{ kind: 'runtime-status', target: 'Steam', value: 0 }],
        };
    return {
      ok: true,
      rawText: JSON.stringify(decision),
      role: 'fixture-agent-model',
      adapter: 'fixture-agent-model',
    };
  }
}

class FileWriteDecisionProvider implements AgentDecisionProvider {
  calls = 0;

  constructor(
    private readonly targetPath: string,
    private readonly content: string,
  ) {}

  async decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.calls += 1;
    const context = request.compiledContext as {
      observations?: Array<{ id: string; status: string }>;
      artifacts?: Array<{ id: string }>;
    };
    const observation = context.observations?.find((entry) => entry.status === 'success');
    const artifact = context.artifacts?.[0];
    const decision = observation
      ? {
          kind: 'complete',
          summary: `Файл ${this.targetPath} создан, запись проверена.`,
          evidenceObservationIds: [observation.id],
          artifactIds: artifact ? [artifact.id] : [],
          evidenceBindings: [
            {
              targetType: 'expected-output',
              targetId: 'file_created',
              observationIds: [observation.id],
              artifactIds: artifact ? [artifact.id] : [],
            },
            {
              targetType: 'success-criterion',
              targetId: 'write_verified',
              observationIds: [observation.id],
              artifactIds: [],
            },
          ],
        }
      : {
          kind: 'act',
          capabilityId: 'workspace.files.write',
          input: {
            path: this.targetPath,
            content: this.content,
            overwrite: false,
          },
          reason: 'Create the exact file requested by the user.',
          expectedEffect: 'The requested path exists with the exact content.',
          verification: [{ kind: 'read-after-write', target: this.targetPath }],
        };
    return {
      ok: true,
      rawText: JSON.stringify(decision),
      role: 'fixture-agent-model',
      adapter: 'fixture-agent-model',
    };
  }
}

class KnownFolderWriteDecisionProvider implements AgentDecisionProvider {
  calls = 0;

  decide(): Promise<AgentModelDecisionResponse> {
    this.calls += 1;
    return Promise.resolve({
      ok: true,
      rawText: JSON.stringify({
        kind: 'act',
        capabilityId: 'workspace.known-folder.write',
        input: {
          knownFolder: 'desktop',
          basename: 'ромашка',
          content: '',
          overwrite: false,
        },
        reason: 'Create the exact file requested by the user.',
        expectedEffect: 'The Kernel-resolved Desktop target exists with exact empty content.',
      }),
      role: 'fixture-agent-model',
      adapter: 'fixture-agent-model',
    });
  }
}

class WrongFolderCompletionProvider implements AgentDecisionProvider {
  private calls = 0;

  constructor(private readonly wrongTarget: string) {}

  decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return Promise.resolve({
        ok: true,
        rawText: JSON.stringify({
          kind: 'act',
          capabilityId: 'workspace.files.write',
          input: { path: this.wrongTarget, content: '', overwrite: false },
          reason: 'Deliberately target the wrong folder for the regression boundary.',
          expectedEffect: 'A same-named workspace file exists.',
        }),
      });
    }
    if (this.calls === 2) {
      const context = request.compiledContext as {
        observations?: Array<{ id: string; status: string }>;
        artifacts?: Array<{ id: string }>;
      };
      const observation = context.observations?.find((entry) => entry.status === 'success');
      const artifact = context.artifacts?.[0];
      return Promise.resolve({
        ok: true,
        rawText: JSON.stringify({
          kind: 'complete',
          summary: 'Incorrectly claim the Desktop file exists.',
          evidenceObservationIds: observation ? [observation.id] : [],
          artifactIds: artifact ? [artifact.id] : [],
          evidenceBindings: [
            {
              targetType: 'expected-output',
              targetId: 'verified_outcome',
              observationIds: observation ? [observation.id] : [],
              artifactIds: artifact ? [artifact.id] : [],
            },
            {
              targetType: 'success-criterion',
              targetId: 'required_outputs_verified',
              observationIds: observation ? [observation.id] : [],
              artifactIds: [],
            },
          ],
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      rawText: JSON.stringify({
        kind: 'fail',
        code: 'wrong-target-rejected',
        reason: 'The verified write did not match the requested Desktop target.',
      }),
    });
  }
}
