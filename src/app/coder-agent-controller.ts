import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { MonarchExecutionResult } from '../core';
import type { MonarchApplication } from './application';
import type { AstraTaskHttpTask } from './astra-task-facade';
import { CoderModule } from '../modules/coder';
import { CoderRunStore, coderRunSessionId } from '../modules/coder/context-manager';
import { astraAgentHistoryTail } from '../agent-v3/agent-task-profile';
import { isCoderMaxModelId, isCoderModelId,
  type CoderAstraTaskProjection, type CoderModelId, type CoderProjectSnapshot, type CoderRun } from '../modules/coder/types';
import type { OscarTurnCheckpoint, OscarTurnV1 } from '../oscar-turn';

const PRIMARY_MODEL: CoderModelId = 'gemma4-balanced';
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
  private readonly restoring = new Map<string, Promise<void>>();
  private readonly taskUnsubscribes = new Map<string, () => void>();

  constructor(private readonly app: MonarchApplication) {
    const module = app.runtime.kernel.getModule('coder');
    if (!(module instanceof CoderModule)) throw new Error('Coder module is not registered in the Monarch Kernel.');
    this.coder = module;
    const legacyRunsRoot = path.resolve(this.coder.monarchRoot, 'runtime', 'coder', 'runs');
    this.runs = new CoderRunStore({
      monarchRoot: this.coder.monarchRoot,
      runsRoot: this.coder.runsRoot,
      ...(samePath(legacyRunsRoot, this.coder.runsRoot) ? {} : { legacyRunsRoot }),
    });
    for (const run of this.runs.list(undefined, 120)) {
      if (run.oscarTurnId) void this.restoreBoundTask(run.id, run.oscarTurnId, run.agentTaskId).catch(() => {
        try {
          const latest = this.runs.get(run.id);
          if (latest && (latest.status === 'queued' || latest.status === 'running')) {
            this.runs.setStatus(run.id, 'interrupted',
              'Automatic Astra V3 recovery needs attention; the saved Turn binding was preserved for an explicit retry.');
          }
        } catch { /* Preserve the existing durable journal on projection failure. */ }
      });
    }
  }

  listProjects(): ReturnType<CoderModule['projects']['list']> {
    return this.coder.projects.list();
  }

  modelCatalog() {
    const pilot = this.app.astraProductPilot;
    const ready = Boolean(pilot?.facade.agentTasks);
    const labels: Record<string, string> = { 'gemma4-balanced': 'Gemma · Balanced 12B',
      'qwen3-coder-30b-a3b-instruct': 'Qwen Coder · 30B',
      'deepseek-coder-v2-lite-instruct': 'DeepSeek Coder · Lite' };
    const models = (pilot?.localAgentModels ?? []).filter(isCoderModelId)
      .map(id => ({ id, label: labels[id] ?? id, source: 'local' as const }));
    return { ready, models, defaultModel: models.find(model => model.id === PRIMARY_MODEL)?.id ?? models[0]?.id ?? null,
      maxConfigured: pilot?.maxModelConfigured === true,
      reason: ready ? models.length ? '' : 'Локальная модель для задач не подключена. Выбери подключённый MAX.'
        : 'Исполнитель задач не подключён. Запусти Monarch Desktop с рабочим хостом Astra.' };
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

  async start(prompt: string, projectId: string, model: CoderModelId = PRIMARY_MODEL, clientRequestId?: string,
    sessionId?: string): Promise<CoderRun> {
    const selectedProjectId = String(projectId || '').trim();
    if (!selectedProjectId) throw new Error('Select an explicit Coder project before starting a run.');
    const project = this.coder.projects.require(selectedProjectId);
    const normalizedPrompt = String(prompt || '').trim();
    if (!normalizedPrompt) throw new Error('Coder task cannot be empty.');
    if (normalizedPrompt.length > 20_000 || Buffer.byteLength(normalizedPrompt) > 20_000) {
      throw new Error('Coder task exceeds the 20,000 UTF-8 byte limit.');
    }
    if (clientRequestId !== undefined) {
      if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(clientRequestId)) throw coderQuestionError('coder-request-invalid', 'Некорректный идентификатор отправки.', 400);
      const previous = this.runs.findRequest(clientRequestId);
      if (previous) {
        if (previous.projectId !== project.id || previous.prompt !== normalizedPrompt || previous.model !== model
          || sessionId !== undefined && coderRunSessionId(previous) !== sessionId) {
          throw coderQuestionError('coder-request-conflict', 'Эта отправка уже связана с другой задачей.');
        }
        return previous;
      }
    }
    if (!this.app.astraProductPilot?.facade.agentTasks) {
      throw new Error('Astra V3 Agent Runtime is unavailable; Coder will not fall back to the legacy V2 loop.');
    }
    if (!isCoderModelId(model)) throw new Error('Unknown Coder model. Choose a listed local model or the exact selected MAX provider.');
    const selectedModel = model;
    if (isCoderMaxModelId(selectedModel) && this.app.astraProductPilot?.maxModelConfigured !== true) {
      throw new Error('MAX is not connected for Coder. Connect and select a provider in Settings → MAX; Coder will not fall back to a local model.');
    }
    if (!isCoderMaxModelId(selectedModel) && !this.modelCatalog().models.some(entry => entry.id === selectedModel)) {
      throw coderQuestionError('coder-model-unavailable', 'Выбранная локальная модель не подключена к исполнителю задач. Обнови Coder и выбери доступную модель.');
    }
    const active = this.runs.list(project.id, 120).find(entry => entry.status === 'queued' || entry.status === 'running');
    if (active) throw coderQuestionError('coder-project-busy', 'В этом проекте уже выполняется задача. Дождись результата или останови её.');
    // A follow-up continues its session: the agent receives the earlier
    // requests and outcomes as conversation history, never as authority.
    const session = sessionId === undefined ? [] : this.runs.sessionRuns(sessionId);
    if (sessionId !== undefined && (!session.length || session.some(entry => entry.projectId !== project.id))) {
      throw coderQuestionError('coder-session-unavailable', 'Этот разговор не найден в выбранном проекте. Начни новый.', 404);
    }
    const history = astraAgentHistoryTail(session.flatMap(entry => coderSessionHistory(entry)));
    const run = this.runs.create(project.id, normalizedPrompt, selectedModel, {
      name: project.name,
      root: project.root,
    }, clientRequestId, sessionId);
    try {
      // A project may keep its own answer style; otherwise Coder follows the chat style.
      const personality = await this.app.readPersonalityContext({
        type: 'coder-project',
        projectId: project.id,
      }).then((snapshot) => snapshot.context).catch(() => null)
        ?? await this.app.readPersonalityContext({ type: 'chat' })
          .then((snapshot) => snapshot.context).catch(() => null);
      this.runs.setPersonalitySnapshot(run.id, personality);
      const permissionProfile = this.app.getPermissionProfile();
      const turn = await this.app.oscarTurnCoordinator.submit({
        clientRequestId: `coder_turn_${run.id}`,
        conversationId: coderRunSessionId(run),
        inputMessageId: `coder_message_${run.id}`,
        text: normalizedPrompt,
        privacyMode: 'persistent',
        source: 'coder',
        ...(history.length ? { history } : {}),
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
      // Acceptance returns the durable identity immediately. Link/projection
      // happens independently of the HTTP request, including after a restart.
      void this.restoreBoundTask(run.id, turn.turn.id).catch(async error => {
        const latest = this.runs.get(run.id);
        if (latest && (latest.status === 'queued' || latest.status === 'running')) {
          const checkpoint = await this.app.oscarTurnCoordinator.getTurn(turn.turn.id).catch(() => null);
          const detail = error instanceof Error ? error.message : String(error);
          if (checkpoint?.turn.status === 'cancelled') this.runs.setStatus(run.id, 'cancelled', detail);
          else if (checkpoint && isTerminalTurn(checkpoint.turn.status)) this.runs.fail(run.id, detail);
          else this.runs.setStatus(run.id, 'interrupted', detail);
        }
      });
      return this.runs.require(run.id);
    } catch (error) {
      this.runs.fail(run.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async resume(runId: string): Promise<CoderRun> {
    let run = this.runs.require(runId);
    if (run.status !== 'interrupted') {
      throw new Error(`Only an interrupted Coder run can be resumed; current status is ${run.status}.`);
    }
    if (run.oscarTurnId && (!run.agentTaskId || run.agentRuntimeVersion !== 'v3')) {
      await this.restoreBoundTask(run.id, run.oscarTurnId, run.agentTaskId);
      run = this.runs.require(runId);
      if (run.status !== 'interrupted') return run;
    }
    if (!run.agentTaskId) {
      throw new Error('This legacy Coder checkpoint is read-only. Start a new Agent-First Coder run.');
    }
    const project = this.coder.projects.require(run.projectId);
    if (run.projectRoot && !samePath(run.projectRoot, project.root)) {
      throw new Error('Coder project root changed after this run was created. Start a new run from the intended project.');
    }
    const turn = run.oscarTurnId ? await this.app.oscarTurnCoordinator.getTurn(run.oscarTurnId) : null;
    if (turn?.turn.request.astra) {
      await this.app.oscarTurnCoordinator.commandAstra(turn.turn.id, 'coder', 'resume');
      await this.app.oscarTurnCoordinator.recoverAstra(turn.turn.id, 'coder', `coder_recover_${run.id}`);
      await this.app.oscarTurnCoordinator.flushOutbox();
      const latest = await this.app.oscarTurnCoordinator.getTurn(turn.turn.id);
      if (!latest?.turn.taskId) throw new Error('Linked Astra V3 Agent Task is unavailable.');
      this.runs.projectAstraTask(run.id, this.astraProjection(latest.turn, this.astraTask(latest.turn)));
      await this.attachAstraTask(run.id, latest.turn.id, latest.turn.taskId);
    } else {
      throw new Error('This legacy Coder checkpoint is read-only. Start a new Astra V3 Coder run.');
    }
    return this.runs.require(run.id);
  }

  async waitForTerminal(runId: string): Promise<CoderRun> {
    let run = this.runs.require(runId);
    const restoration = this.restoring.get(runId);
    if (restoration) { await restoration; run = this.runs.require(runId); }
    if (!TERMINAL_TASK_STATUSES.has(run.status) && run.agentTaskId) {
      if (!run.oscarTurnId) {
        throw new Error('This legacy Coder checkpoint is read-only. Start a new Astra V3 Coder run.');
      }
      await this.attachBoundTask(run.id, run.oscarTurnId, run.agentTaskId);
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
    let run = this.runs.require(runId);
    if (TERMINAL_TASK_STATUSES.has(run.status)) return run;
    if (run.oscarTurnId && !run.agentTaskId && run.agentRuntimeVersion === 'v3') {
      const checkpoint = await this.app.oscarTurnCoordinator.getTurn(run.oscarTurnId);
      if (!checkpoint || checkpoint.turn.source !== 'coder') throw new Error('Coder task binding changed before cancellation.');
      this.runs.requestCancel(runId);
      const cancelled = await this.app.oscarTurnCoordinator.cancel(run.oscarTurnId, 'coder');
      if (cancelled.turn.status === 'cancelled') this.runs.setStatus(runId, 'cancelled', 'Задача остановлена до запуска действий.');
      return this.runs.require(runId);
    }
    if (run.oscarTurnId && (!run.agentTaskId || run.agentRuntimeVersion !== 'v3')) {
      await this.restoreBoundTask(run.id, run.oscarTurnId, run.agentTaskId);
      run = this.runs.require(runId);
      if (TERMINAL_TASK_STATUSES.has(run.status)) return run;
    }
    if (!run.oscarTurnId || run.agentRuntimeVersion !== 'v3') {
      throw new Error('This legacy Coder checkpoint is read-only. Start a new Astra V3 Coder run.');
    }
    const turn = await this.app.oscarTurnCoordinator.getTurn(run.oscarTurnId);
    if (!turn?.turn.request.astra || turn.turn.source !== 'coder') {
      throw new Error('Coder refused to cancel a legacy V2 Agent Task. Start a new Astra V3 Coder run.');
    }
    this.runs.requestCancel(runId);
    await this.app.oscarTurnCoordinator.cancel(run.oscarTurnId, 'coder');
    return this.runs.require(run.id);
  }

  async reply(runId: string, input: { questionId: string; questionDigest: string; text: string }): Promise<CoderRun> {
    const run = this.runs.require(runId);
    if (!run.oscarTurnId || !run.agentTaskId || run.agentRuntimeVersion !== 'v3') {
      throw coderQuestionError('coder-question-unavailable', 'This Coder run is not awaiting Astra V3 input.');
    }
    if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 4096) {
      throw coderQuestionError('coder-reply-invalid', 'Coder reply must contain 1 to 4096 UTF-8 bytes.', 400);
    }
    const checkpoint = await this.app.oscarTurnCoordinator.getTurn(run.oscarTurnId);
    if (!checkpoint?.turn.request.astra || checkpoint.turn.taskId !== run.agentTaskId || checkpoint.turn.source !== 'coder') {
      throw coderQuestionError('coder-question-binding', 'The linked Astra V3 Coder task changed.');
    }
    const task = this.astraTask(checkpoint.turn);
    if (!task.question || task.question.id !== input.questionId || task.question.digest !== input.questionDigest) {
      throw coderQuestionError('coder-question-binding', 'The exact current Coder question is required.');
    }
    await this.app.oscarTurnCoordinator.submitAstraInput(checkpoint.turn.id, 'coder', { kind: 'reply', reply: {
      requestId: `coder_reply_${randomUUID()}`,
      questionId: input.questionId,
      questionDigest: input.questionDigest,
      messageId: `coder_reply_message_${randomUUID()}`,
      text: input.text,
    } });
    await this.app.oscarTurnCoordinator.flushOutbox();
    const latest = await this.app.oscarTurnCoordinator.getTurn(checkpoint.turn.id);
    if (!latest?.turn.taskId) throw coderQuestionError('coder-question-binding', 'The linked Astra V3 Coder task disappeared.');
    return this.runs.projectAstraTask(run.id, this.astraProjection(latest.turn, this.astraTask(latest.turn)));
  }

  private async waitForLinkedTurn(turnId: string): Promise<OscarTurnCheckpoint> {
    const store = this.app.oscarTurnCoordinator.persistentStore;
    const current = await store.getTurn(turnId);
    if (current?.turn.taskId) return current;
    if (current && isTerminalTurn(current.turn.status)) {
      throw new Error(current.turn.outcome?.summary || 'Coder Turn ended before Agent Task linkage.');
    }
    return new Promise<OscarTurnCheckpoint>((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const timer = setTimeout(() => {
        finish(undefined, new Error('Timed out waiting for the Coder Turn to link its Agent Task.'));
      }, TASK_LINK_TIMEOUT_MS);
      timer.unref?.();
      const finish = (value?: OscarTurnCheckpoint, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve(value!);
      };
      unsubscribe = store.subscribe(turnId, (commit) => {
        if (commit.turn.taskId) {
          void store.getTurn(turnId).then(checkpoint => checkpoint
            ? finish(checkpoint) : finish(undefined, new Error('Coder Turn disappeared after task linkage.')),
          error => finish(undefined, error instanceof Error ? error : new Error(String(error))));
        } else if (isTerminalTurn(commit.turn.status)) {
          finish(undefined, new Error(commit.turn.outcome?.summary || 'Coder Turn ended before Agent Task linkage.'));
        }
      });
      // Subscribe before rereading: a link may commit between the first read
      // and subscription. No notification is required to repair that window.
      void store.getTurn(turnId).then(checkpoint => {
        if (checkpoint?.turn.taskId) finish(checkpoint);
        else if (checkpoint && isTerminalTurn(checkpoint.turn.status)) {
          finish(undefined, new Error(checkpoint.turn.outcome?.summary || 'Coder Turn ended before Agent Task linkage.'));
        }
      }, error => finish(undefined, error instanceof Error ? error : new Error(String(error))));
    });
  }

  private restoreBoundTask(runId: string, turnId: string, expectedTaskId?: string): Promise<void> {
    const active = this.restoring.get(runId);
    if (active) return active;
    const operation = (async () => {
      let checkpoint = await this.app.oscarTurnCoordinator.getTurn(turnId);
      if (!checkpoint) throw new Error('Linked Astra V3 Turn disappeared before recovery.');
      if (!checkpoint.turn.taskId) checkpoint = await this.waitForLinkedTurn(turnId);
      if (!checkpoint.turn.request.astra || checkpoint.turn.source !== 'coder') {
        throw new Error('Coder refused to recover a legacy V2 Agent Task. Start a new Astra V3 Coder run.');
      }
      const taskId = checkpoint.turn.taskId;
      if (!taskId || expectedTaskId && expectedTaskId !== taskId) {
        throw new Error('Coder Astra task binding changed during recovery.');
      }
      this.runs.projectAstraTask(runId, this.astraProjection(checkpoint.turn, this.astraTask(checkpoint.turn)));
      await this.attachAstraTask(runId, turnId, taskId);
    })();
    const tracked = operation.finally(() => {
      if (this.restoring.get(runId) === tracked) this.restoring.delete(runId);
    });
    this.restoring.set(runId, tracked);
    return tracked;
  }

  private async attachBoundTask(runId: string, turnId: string, taskId: string): Promise<void> {
    await this.restoreBoundTask(runId, turnId, taskId);
  }

  private async attachAstraTask(runId: string, turnId: string, taskId: string): Promise<void> {
    if (this.running.has(runId)) return;
    let settle!: () => void;
    const terminal = new Promise<void>((resolve) => { settle = resolve; });
    let queue = Promise.resolve();
    const execution = terminal.finally(() => {
      this.taskUnsubscribes.get(runId)?.(); this.taskUnsubscribes.delete(runId); this.running.delete(runId);
    });
    this.running.set(runId, execution);
    const project = (turn: OscarTurnV1) => { queue = queue.then(() => {
      if (turn.taskId !== taskId || !turn.request.astra) throw new Error('Coder Astra task binding changed.');
      const projected = this.runs.projectAstraTask(runId, this.astraProjection(turn, this.astraTask(turn)));
      if (TERMINAL_TASK_STATUSES.has(projected.status)) settle();
    }).catch(error => { this.runs.fail(runId, error instanceof Error ? error.message : String(error)); settle(); }); };
    const unsubscribe = this.app.oscarTurnCoordinator.subscribe(turnId, commit => project(commit.turn));
    this.taskUnsubscribes.set(runId, unsubscribe);
    const latest = await this.app.oscarTurnCoordinator.getTurn(turnId);
    if (!latest) {
      unsubscribe(); this.taskUnsubscribes.delete(runId); this.running.delete(runId);
      throw new Error('Linked Astra V3 Turn disappeared before projection.');
    }
    project(latest.turn); await queue;
  }

  private astraTask(turn: OscarTurnV1): AstraTaskHttpTask {
    const task = this.app.astraProductPilot?.bridge.find(turn);
    if (!task || task.id !== turn.taskId) throw new Error('Linked Astra V3 Agent Task is unavailable.');
    return task;
  }

  private astraProjection(turn: OscarTurnV1, task: AstraTaskHttpTask): CoderAstraTaskProjection {
    const status = turn.status === 'succeeded' ? 'completed' as const
      : turn.status === 'cancelled' ? 'cancelled' as const
        : turn.status === 'blocked' || turn.status === 'failed' ? 'failed' as const
          : task.status === 'paused' ? 'interrupted' as const : 'running' as const;
    const approval = task.approval && 'capability' in task.approval ? {
      id: task.approval.id, capabilityId: task.approval.capability.id,
      canonicalProposalHash: task.approval.proposalHash,
      reason: task.approval.reason || 'Требуется подтверждение точного действия.',
      expiresAt: new Date(task.approval.expiresAt).toISOString(), purpose: task.approval.purpose,
      proposal: { capabilityId: task.approval.capability.id, args: structuredClone(task.approval.args) },
    } : undefined;
    const question = task.question ? {
      id: task.question.id,
      digest: task.question.digest,
      text: task.question.text,
      predecessorMessageId: task.question.predecessorMessageId,
      expiresAt: new Date(task.question.expiresAt).toISOString(),
    } : undefined;
    const summary = task.message?.content || turn.outcome?.summary;
    return { taskId: task.id, status, modelTurns: task.modelJobs, capabilityCalls: task.capabilityJobs ?? 0,
      runtimeStatus: task.status, ...(task.completionEvidence ? { completionEvidence: task.completionEvidence } : {}),
      activities: structuredClone(task.activities ?? []), ...(status === 'completed' ? { answer: summary || '' } : {}),
      ...(status === 'failed' ? { error: summary || `Astra V3 task stopped with status ${task.status}.` } : {}),
      ...(approval ? { approval } : {}), ...(question ? { question } : {}) };
  }

  /** Working-tree changes for the review panel, read through the same Kernel git capabilities. */
  async changes(projectId: string): Promise<CoderProjectChanges> {
    const snapshot = await this.coder.projects.snapshot(projectId);
    if (!snapshot.git.repository) return { repository: false, branch: '', files: [], truncated: false };
    const [status, diff] = await Promise.all([
      this.executeCoderCapability('coder.git.status', { projectId: snapshot.project.id }),
      this.executeCoderCapability('coder.git.diff', { projectId: snapshot.project.id }),
    ]);
    if (!status.ok) throw coderQuestionError('coder-git-status-failed', 'Git не ответил на запрос состояния проекта.', 502);
    return parseCoderChanges(readProcessStdout(status), diff.ok ? readProcessStdout(diff) : '', snapshot.git.branch);
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

function coderQuestionError(code: string, message: string, statusCode = 409): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
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

export interface CoderProjectChanges {
  repository: boolean;
  branch: string;
  files: Array<{ path: string; state: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; patch?: string }>;
  truncated: boolean;
}

const MAX_CHANGED_FILES = 200;
const MAX_FILE_PATCH_CHARS = 120_000;
const MAX_TOTAL_PATCH_CHARS = 600_000;

function readProcessStdout(result: MonarchExecutionResult): string {
  const output = result.output && typeof result.output === 'object' ? result.output as { stdout?: unknown } : {};
  return typeof output.stdout === 'string' ? output.stdout : '';
}

export function parseCoderChanges(statusText: string, diffText: string, fallbackBranch = ''): CoderProjectChanges {
  let branch = fallbackBranch;
  const files: CoderProjectChanges['files'] = [];
  for (const line of statusText.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (line.startsWith('## ')) { branch = line.slice(3).split('...')[0]!.replace(/^No commits yet on /u, '').trim() || branch; continue; }
    const code = line.slice(0, 2), rest = line.slice(3).trim();
    const target = (rest.includes(' -> ') ? rest.split(' -> ').at(-1)! : rest).replace(/^"(.*)"$/u, '$1');
    const state = code === '??' ? 'untracked' : code.includes('R') ? 'renamed' : code.includes('D') ? 'deleted'
      : code.includes('A') ? 'added' : 'modified';
    if (target) files.push({ path: target.replace(/\\/gu, '/'), state });
  }
  const patches = new Map<string, string>();
  for (const chunk of diffText.split(/^(?=diff --git )/mu)) {
    const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/mu);
    if (header?.[2]) patches.set(header[2].trim(), chunk);
  }
  let budget = MAX_TOTAL_PATCH_CHARS, truncated = files.length > MAX_CHANGED_FILES;
  const listed = files.slice(0, MAX_CHANGED_FILES).map(file => {
    const patch = patches.get(file.path);
    if (!patch || budget <= 0) { if (patch) truncated = true; return file; }
    const bounded = patch.length > MAX_FILE_PATCH_CHARS ? patch.slice(0, MAX_FILE_PATCH_CHARS) : patch;
    if (bounded.length < patch.length) truncated = true;
    budget -= bounded.length;
    return { ...file, patch: bounded };
  });
  return { repository: true, branch, files: listed, truncated };
}

/** One finished exchange as the agent will read it: what was asked, what came of it. */
function coderSessionHistory(run: CoderRun): Array<{ role: 'user' | 'assistant'; content: string }> {
  const asked = run.prompt.trim().slice(0, 8_000);
  if (!asked || run.status === 'queued' || run.status === 'running') return [];
  const files = run.summary.modifiedFiles.slice(0, 20);
  const outcome = run.status === 'completed' ? run.answer.trim()
    : run.status === 'cancelled' ? 'Задача остановлена по просьбе человека до завершения.'
      : `Задача не завершена: ${(run.error || run.answer || 'причина не сохранена').trim()}`;
  const content = [outcome.slice(0, 8_000), files.length ? `Изменённые файлы: ${files.join(', ')}` : '']
    .filter(Boolean).join('\n\n');
  return content ? [{ role: 'user', content: asked }, { role: 'assistant', content }] : [];
}

function isTerminalTurn(status: string): boolean {
  return status === 'succeeded' || status === 'blocked' || status === 'failed' || status === 'cancelled';
}
