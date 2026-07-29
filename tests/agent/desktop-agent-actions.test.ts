import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Desktop Oscar Agent Task actions', () => {
  it('lets the model select and execute a verified app launch without phrase routing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-desktop-agent-'));
    roots.push(root);
    const runner = vi.fn(async () => JSON.stringify({
      opened: true,
      performed: true,
      verified: true,
      app: 'calculator',
      displayName: 'Калькулятор',
      processId: 42,
      launcher: 'direct',
    }));
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
      expect(waiting?.task.status).toBe('waiting-for-approval');
      expect(waiting?.approvals).toHaveLength(1);
      await app.agentRuntime!.resolveApproval(created.task.id, waiting!.approvals[0]!.id, {
        decision: 'approve',
        grantScope: 'once',
        requestId: 'approve-verified-app-launch',
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
      expect(runner).toHaveBeenCalledTimes(1);
      expect(decisionProvider.calls).toBe(1);
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
});

class AppLaunchDecisionProvider implements AgentDecisionProvider {
  calls = 0;

  async decide(request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> {
    this.calls += 1;
    const context = request.compiledContext as {
      observations?: Array<{ id: string; status: string; structuredData?: unknown }>;
    };
    const observation = context.observations?.find((entry) => entry.status === 'success');
    const decision = observation
      ? {
          kind: 'complete',
          summary: 'Калькулятор открыт и запуск подтверждён Windows.',
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
          input: { app: 'Калькулятор' },
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
