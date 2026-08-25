import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { MonarchExecutionResult } from '../core';
import type { AgentTaskCheckpoint, MonarchAgentRuntime } from '../agent';
import type { MonarchApplication } from './application';
import { CoderModule } from '../modules/coder';
import { CoderRunStore } from '../modules/coder/context-manager';
import type { CoderModelId, CoderProjectSnapshot, CoderRun } from '../modules/coder/types';

const PRIMARY_MODEL: CoderModelId = 'qwen3-coder-30b-a3b-instruct';
const FALLBACK_MODEL: CoderModelId = 'deepseek-coder-v2-lite-instruct';
const TASK_LINK_TIMEOUT_MS = 30_000;
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Coder is a local UI/projection facade. It does not own a model loop or
 * completion rules: every new run is one Oscar Turn linked to one common
 * AgentTask, and every effect goes through the same Kernel gateway.
 */
export class CoderAgentController {
  readonly runs: CoderRunStore;
  private readonly coder: CoderModule;
  private readonly running = new Map<string, Promise<void>>();
  private readonly taskUnsubscribes = new Map<string, () => void>();

  constructor(private readonly app: MonarchApplication) {
    const module = app.runtime.kernel.getModule('coder');
    if (!(module instanceof CoderModule)) throw new Error('Coder module is not registered in the Monarch Kernel.');
    this.coder = module;
    this.runs = new CoderRunStore({ monarchRoot: this.coder.monarchRoot });
    for (const run of this.runs.list()) {
      if (run.agentTaskId) void this.attachAgentTask(run.id, run.agentTaskId).catch(() => undefined);
    }
  }

  listProjects(): ReturnType<CoderModule['projects']['list']> {
    return this.coder.projects.list();
  }

  async projectSnapshot(projectId?: string): Promise<CoderProjectSnapshot> {
    return this.coder.projects.snapshot(projectId);
  }

  async createProject(name: string): Promise<CoderProjectSnapshot> {
    const result = await this.executeCoderCapability('coder.projects.create', { name });
    if (!result.ok) throw new Error(result.summary);
    return this.coder.projects.snapshot(readOutputProjectId(result));
  }

  async importProject(projectPath: string, name?: string): Promise<CoderProjectSnapshot> {
    const result = await this.executeCoderCapability('coder.projects.import', {
      path: projectPath,
      ...(name ? { name } : {}),
    });
    if (!result.ok) throw new Error(result.summary);
    return this.coder.projects.snapshot(readOutputProjectId(result));
  }

  async activateProject(projectId: string): Promise<CoderProjectSnapshot> {
    const result = await this.executeCoderCapability('coder.projects.activate', { projectId });
    if (!result.ok) throw new Error(result.summary);
    return this.coder.projects.snapshot(projectId);
  }

  async start(prompt: string, projectId: string, model: CoderModelId = PRIMARY_MODEL): Promise<CoderRun> {
    const runtime = this.requireRuntime();
    const selectedProjectId = String(projectId || '').trim();
    if (!selectedProjectId) throw new Error('Select an explicit Coder project before starting a run.');
    const project = this.coder.projects.require(selectedProjectId);
    const normalizedPrompt = String(prompt || '').trim();
    if (!normalizedPrompt) throw new Error('Coder task cannot be empty.');
    if (normalizedPrompt.length > 80_000) throw new Error('Coder task exceeds the 80,000-character limit.');
    const selectedModel = model === FALLBACK_MODEL ? FALLBACK_MODEL : PRIMARY_MODEL;
    const run = this.runs.create(project.id, normalizedPrompt, selectedModel, {
      name: project.name,
      root: project.root,
    });
    try {
      const personality = await this.app.readPersonalityContext({
        type: 'coder-project',
        projectId: project.id,
      }).then((snapshot) => snapshot.context).catch(() => null);
      this.runs.setPersonalitySnapshot(run.id, personality);
      const permissionProfile = this.app.getPermissionProfile();
      const turn = await this.app.oscarTurnCoordinator.submit({
        clientRequestId: `coder_turn_${run.id}`,
        conversationId: `coder_project_${project.id}`,
        inputMessageId: `coder_message_${run.id}`,
        text: normalizedPrompt,
        privacyMode: 'persistent',
        source: 'coder',
        modifiers: {
          requestedModel: selectedModel,
          reasoningEffort: 'high',
          researchMode: 'off',
        },
        executionProfile: {
          schemaVersion: 'monarch.agent-execution-profile.v1',
          kind: 'coder-project',
          projectId: project.id,
          projectRoot: path.resolve(project.root),
          permissionProfile: {
            sandboxMode: permissionProfile.sandboxMode,
            approvalPolicy: permissionProfile.approvalPolicy,
            ...(permissionProfile.autonomyMode ? { autonomyMode: permissionProfile.autonomyMode } : {}),
          },
        },
      });
      this.runs.bindAgentTurn(run.id, turn.turn.id);
      const linked = turn.turn.taskId
        ? await runtime.getTask(turn.turn.taskId)
        : await this.waitForLinkedTask(turn.turn.id);
      if (!linked) throw new Error('Coder Turn did not create a common Agent Task.');
      this.runs.projectAgentCheckpoint(run.id, linked);
      await this.attachAgentTask(run.id, linked.task.id);
      return this.runs.require(run.id);
    } catch (error) {
      this.runs.fail(run.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async resume(runId: string): Promise<CoderRun> {
    const run = this.runs.require(runId);
    if (run.status !== 'interrupted') {
      throw new Error(`Only an interrupted Coder run can be resumed; current status is ${run.status}.`);
    }
    if (!run.agentTaskId) {
      throw new Error('This legacy Coder checkpoint is read-only. Start a new Agent-First Coder run.');
    }
    const project = this.coder.projects.require(run.projectId);
    if (run.projectRoot && !samePath(run.projectRoot, project.root)) {
      throw new Error('Coder project root changed after this run was created. Start a new run from the intended project.');
    }
    const runtime = await this.app.resolveAgentRuntimeForTask(run.agentTaskId);
    if (!runtime) throw new Error('Linked Agent Task is unavailable.');
    const checkpoint = await runtime.resume(run.agentTaskId);
    this.runs.projectAgentCheckpoint(run.id, checkpoint);
    await this.attachAgentTask(run.id, run.agentTaskId);
    return this.runs.require(run.id);
  }

  async waitForTerminal(runId: string): Promise<CoderRun> {
    let run = this.runs.require(runId);
    if (!TERMINAL_TASK_STATUSES.has(run.status) && run.agentTaskId) {
      await this.attachAgentTask(run.id, run.agentTaskId);
    }
    const execution = this.running.get(runId);
    if (execution) await execution;
    run = this.runs.require(runId);
    if (!TERMINAL_TASK_STATUSES.has(run.status)) {
      throw new Error(`Coder run ${runId} is not active and has not reached a terminal state.`);
    }
    return run;
  }

  async cancel(runId: string): Promise<CoderRun> {
    const run = this.runs.require(runId);
    if (TERMINAL_TASK_STATUSES.has(run.status)) return run;
    this.runs.requestCancel(runId);
    if (run.oscarTurnId) {
      await this.app.oscarTurnCoordinator.cancel(run.oscarTurnId, 'coder');
    } else if (run.agentTaskId) {
      const runtime = await this.app.resolveAgentRuntimeForTask(run.agentTaskId);
      if (runtime) this.runs.projectAgentCheckpoint(run.id, await runtime.cancel(run.agentTaskId));
    } else {
      this.runs.setStatus(run.id, 'cancelled', 'Legacy Coder run cancelled before Agent Task linkage.');
    }
    return this.runs.require(run.id);
  }

  private requireRuntime(): MonarchAgentRuntime {
    if (!this.app.agentRuntime) throw new Error('Oscar Agent Runtime is disabled; Coder cannot start a separate legacy loop.');
    return this.app.agentRuntime;
  }

  private async waitForLinkedTask(turnId: string): Promise<AgentTaskCheckpoint | null> {
    const store = this.app.oscarTurnCoordinator.persistentStore;
    const current = await store.getTurn(turnId);
    if (current?.turn.taskId) return this.requireRuntime().getTask(current.turn.taskId);
    if (current && isTerminalTurn(current.turn.status)) {
      throw new Error(current.turn.outcome?.summary || 'Coder Turn ended before Agent Task linkage.');
    }
    return new Promise<AgentTaskCheckpoint | null>((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const timer = setTimeout(() => {
        finish(null, new Error('Timed out waiting for the Coder Turn to link its Agent Task.'));
      }, TASK_LINK_TIMEOUT_MS);
      timer.unref?.();
      const finish = (value: AgentTaskCheckpoint | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve(value);
      };
      unsubscribe = store.subscribe(turnId, (commit) => {
        if (commit.turn.taskId) {
          void this.requireRuntime().getTask(commit.turn.taskId).then(
            (checkpoint) => finish(checkpoint),
            (error) => finish(null, error instanceof Error ? error : new Error(String(error))),
          );
        } else if (isTerminalTurn(commit.turn.status)) {
          finish(null, new Error(commit.turn.outcome?.summary || 'Coder Turn ended before Agent Task linkage.'));
        }
      });
    });
  }

  private async attachAgentTask(runId: string, taskId: string): Promise<void> {
    if (this.running.has(runId)) return;
    const runtime = await this.app.resolveAgentRuntimeForTask(taskId);
    if (!runtime) throw new Error('Linked Agent Task runtime is unavailable.');
    let settle!: () => void;
    const terminal = new Promise<void>((resolve) => { settle = resolve; });
    const execution = terminal.finally(() => {
      this.taskUnsubscribes.get(runId)?.();
      this.taskUnsubscribes.delete(runId);
      this.running.delete(runId);
    });
    this.running.set(runId, execution);
    const project = (checkpoint: AgentTaskCheckpoint) => {
      const projected = this.runs.projectAgentCheckpoint(runId, checkpoint);
      if (TERMINAL_TASK_STATUSES.has(projected.status)) settle();
    };
    const unsubscribe = runtime.subscribe(taskId, (commit) => project(commit.checkpoint));
    this.taskUnsubscribes.set(runId, unsubscribe);
    const latest = await runtime.getTask(taskId);
    if (!latest) {
      unsubscribe();
      this.taskUnsubscribes.delete(runId);
      this.running.delete(runId);
      throw new Error('Linked Agent Task disappeared before projection.');
    }
    project(latest);
  }

  private executeCoderCapability(capabilityId: string, input: Record<string, unknown>): Promise<MonarchExecutionResult> {
    return this.app.runtime.kernel.execute({
      id: `exec_coder_${randomUUID()}`,
      intentId: `intent_coder_${randomUUID()}`,
      moduleId: 'coder',
      capabilityId,
      input,
      createdAt: new Date().toISOString(),
      requestedBy: 'coder-local-surface',
      source: 'coder',
      confirmed: false,
      executionMode: 'coder',
      permissionProfileOverride: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        autonomyMode: 'full-local',
      },
    });
  }
}

function readOutputProjectId(result: MonarchExecutionResult): string {
  const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output)
    ? result.output as Record<string, unknown>
    : {};
  const id = typeof output.id === 'string' ? output.id.trim() : '';
  if (!id) throw new Error('Coder project capability returned no project id.');
  return id;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/u, '').toLocaleLowerCase('en-US')
    === path.resolve(right).replace(/[\\/]+$/u, '').toLocaleLowerCase('en-US');
}

function isTerminalTurn(status: string): boolean {
  return status === 'succeeded' || status === 'blocked' || status === 'failed' || status === 'cancelled';
}
