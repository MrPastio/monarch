import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readDurableJson, renameWithWindowsRetrySync, writeDurableJson } from '../../core/durable-json';
import { storeProtection } from '../../core/store-protection';
import type {
  CoderContextSummary,
  CoderAstraTaskProjection,
  CoderModelId,
  CoderRun,
  CoderRunEvent,
  CoderRunEventKind,
  CoderRunStatus,
} from './types';
import { isCoderModelId } from './types';
import type { MonarchPersonalityContextV2 } from '../../settings';

const DEFAULT_CONTEXT_BUDGET = 16_384;
const DEFAULT_RESERVED_OUTPUT = 4_096;
const MAX_RUNS = 120;
const MAX_RECENT_EVENTS = 20;
const MAX_EVENT_DETAIL_CHARS = 16_000;
const COMPACTION_TOKEN_THRESHOLD = 9_000;
const MAX_PROJECTION_TOKENS = 2_400;
const DEFAULT_MAX_ITERATIONS = 64;

export interface CoderRunStoreOptions {
  monarchRoot: string;
  runsRoot?: string;
  legacyRunsRoot?: string;
  budgetTokens?: number;
  reservedOutputTokens?: number;
  maxIterations?: number;
  writeRun?: (filePath: string, run: CoderRun) => void;
}

export interface CoderPromptProjection {
  summary: CoderContextSummary;
  recentEvents: Array<Pick<CoderRunEvent, 'sequence' | 'kind' | 'title' | 'detail' | 'capabilityId' | 'ok' | 'error'>>;
  metrics: CoderRun['context'];
}

export class CoderRunStore {
  readonly runsRoot: string;
  private readonly legacyRunsRoot: string | null;
  private readonly budgetTokens: number;
  private readonly reservedOutputTokens: number;
  private readonly maxIterations: number;
  private readonly writeRun: (filePath: string, run: CoderRun) => void;
  private readonly runs = new Map<string, CoderRun>();
  private readonly listeners = new Set<(run: CoderRun) => void>();

  constructor(options: CoderRunStoreOptions) {
    this.runsRoot = path.resolve(options.runsRoot || path.resolve(options.monarchRoot, 'runtime', 'coder', 'runs'));
    const legacyRunsRoot = options.legacyRunsRoot ? path.resolve(options.legacyRunsRoot) : null;
    this.legacyRunsRoot = legacyRunsRoot && legacyRunsRoot.toLowerCase() !== this.runsRoot.toLowerCase()
      ? legacyRunsRoot
      : null;
    this.budgetTokens = clamp(options.budgetTokens || DEFAULT_CONTEXT_BUDGET, 8_192, 131_072);
    this.reservedOutputTokens = clamp(options.reservedOutputTokens || DEFAULT_RESERVED_OUTPUT, 1_024, 16_384);
    this.maxIterations = clamp(options.maxIterations || DEFAULT_MAX_ITERATIONS, 8, 128);
    this.writeRun = options.writeRun
      || ((file, run) => writeDurableJson(file, run, { sensitive: { storeId: 'coder-runs' } }));
    this.restore();
    this.sealArchivedRuns();
  }

  /** Owner decision: no plain original stays once sealing is on. Archived runs
   * are never read again, so they are resealed once here, in the background. */
  private sealArchivedRuns(): void {
    if (storeProtection().mode !== 'sealed') return;
    const archive = path.join(this.runsRoot, 'archive');
    setImmediate(() => {
      let names: string[] = [];
      try { names = readdirSync(archive).filter((name) => name.endsWith('.json')); } catch { return; }
      for (const name of names) {
        try { readDurableJson<unknown>(path.join(archive, name), { sensitive: { storeId: 'coder-runs' } }); }
        catch { /* an unreadable archived run stays as it is */ }
      }
    });
  }

  list(projectId?: string, limit = 60): CoderRun[] {
    return Array.from(this.runs.values())
      .filter((run) => !projectId || run.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map(cloneRun);
  }

  get(runId: string): CoderRun | null {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : null;
  }

  findRequest(clientRequestId: string): CoderRun | null {
    const run = Array.from(this.runs.values()).find(entry => entry.clientRequestId === clientRequestId);
    return run ? cloneRun(run) : null;
  }

  /** Runs of one conversation, oldest first. A legacy run is its own session. */
  sessionRuns(sessionId: string): CoderRun[] {
    return Array.from(this.runs.values())
      .filter(run => coderRunSessionId(run) === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(cloneRun);
  }

  /** Every durable change of a run, after it is written. */
  subscribe(listener: (run: CoderRun) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  delete(runId: string): CoderRun {
    const run = this.require(runId);
    if (run.status === 'queued' || run.status === 'running') {
      throw new Error('A running Coder session cannot be moved into Monarch Safe.');
    }
    const journalPath = path.join(this.runsRoot, `${run.id}.json`);
    rmSync(journalPath, { force: true });
    if (existsSync(journalPath)) {
      throw new Error('Coder plaintext run journal could not be removed after Safe migration.');
    }
    this.runs.delete(runId);
    return cloneRun(run);
  }

  require(runId: string): CoderRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Coder run not found: ${runId}`);
    return cloneRun(run);
  }

  create(
    projectId: string,
    prompt: string,
    model: CoderModelId = 'qwen3-coder-30b-a3b-instruct',
    projectIdentity?: { name: string; root: string },
    clientRequestId?: string,
    sessionId?: string,
  ): CoderRun {
    if (sessionId !== undefined && !isCoderSessionId(sessionId)) throw new Error('Invalid Coder session id.');
    const now = new Date().toISOString();
    const run: CoderRun = {
      id: `coder_run_${randomUUID()}`,
      projectId,
      sessionId: sessionId ?? `coder_session_${randomUUID()}`,
      ...(clientRequestId ? { clientRequestId } : {}),
      ...(projectIdentity ? { projectName: projectIdentity.name, projectRoot: path.resolve(projectIdentity.root) } : {}),
      prompt: prompt.trim(),
      model,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      answer: '',
      error: '',
      iteration: 0,
      maxIterations: this.maxIterations,
      cancelled: false,
      events: [],
      summary: emptySummary(prompt.trim()),
      context: {
        budgetTokens: this.budgetTokens,
        estimatedPromptTokens: estimateTokens(prompt),
        reservedOutputTokens: this.reservedOutputTokens,
        retainedRecentEvents: 0,
        totalEvents: 0,
        compactions: 0,
        modelCalls: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        modelTotalTokens: 0,
      },
    };
    this.runs.set(run.id, run);
    try {
      this.appendRunEvent(run, 'status', 'Task queued', prompt.trim());
      this.persist(run);
      this.pruneRuns();
      return cloneRun(run);
    } catch (error) {
      this.runs.delete(run.id);
      throw error;
    }
  }

  setStatus(runId: string, status: CoderRunStatus, detail = ''): CoderRun {
    return this.mutateRun(runId, (run) => {
      this.applyRunStatus(run, status, detail);
      return cloneRun(run);
    });
  }

  setIteration(runId: string, iteration: number): void {
    this.mutateRun(runId, (run) => {
      run.iteration = clamp(iteration, 0, run.maxIterations);
      run.updatedAt = new Date().toISOString();
    });
  }

  setPersonalitySnapshot(runId: string, personality: MonarchPersonalityContextV2 | null): void {
    if (Object.hasOwn(this.requireMutable(runId), 'personality')) return;
    this.mutateRun(runId, (run) => {
      run.personality = personality ? structuredClone(personality) : null;
      run.updatedAt = new Date().toISOString();
    });
  }

  bindAgentTurn(runId: string, turnId: string): void {
    this.mutateRun(runId, (run) => {
      if (run.oscarTurnId && run.oscarTurnId !== turnId) {
        throw new Error('Coder run is already bound to another Oscar Turn.');
      }
      run.oscarTurnId = turnId;
      run.agentRuntimeVersion = 'v3';
      run.updatedAt = new Date().toISOString();
    });
  }

  projectAstraTask(runId: string, projection: CoderAstraTaskProjection): CoderRun {
    return this.mutateRun(runId, (run) => {
      if (run.agentTaskId && run.agentTaskId !== projection.taskId) {
        throw new Error('Coder run is already bound to another Agent Task.');
      }
      const previousStatus = run.status;
      run.agentTaskId = projection.taskId;
      run.agentRuntimeVersion = 'v3';
      if (projection.runtimeStatus) run.runtimeStatus = projection.runtimeStatus;
      else delete run.runtimeStatus;
      if (projection.completionEvidence) run.completionEvidence = projection.completionEvidence;
      else delete run.completionEvidence;
      const activityStates = { ...(run.astraActivityStates ?? {}) };
      // Only the newest 16 rounds keep a state. An older round missing from
      // the window was already journaled; replaying it would duplicate steps.
      const retained = Object.keys(activityStates).map(Number);
      const windowFloor = retained.length >= 16 ? Math.min(...retained) : -1;
      for (const activity of [...projection.activities].sort((a, b) => a.round - b.round)) {
        const key = String(activity.round), previous = activityStates[key];
        if (!previous && activity.round < windowFloor) continue;
        if (!previous && activity.thought) this.appendRunEvent(run, 'assistant', 'План следующего шага', activity.thought);
        if (!previous) this.appendRunEvent(run, 'tool-start', `Run ${activity.capabilityId}`,
          activity.reason || 'Astra V3 dispatched a project-bound Kernel capability.', { capabilityId: activity.capabilityId });
        if (activity.state !== 'proposed' && previous !== activity.state) this.appendRunEvent(run, 'tool-result',
          `${activity.ok ? 'Completed' : 'Failed'} ${activity.capabilityId}`,
          activity.summary || (activity.ok ? 'Kernel receipt recorded.' : 'Capability did not complete.'), {
            capabilityId: activity.capabilityId, ok: activity.ok === true,
            ...(activity.output !== undefined ? { output: structuredClone(activity.output) } : {}),
            ...(activity.state === 'failed' && activity.summary ? { error: activity.summary } : {}),
          });
        activityStates[key] = activity.state;
        run.astraActivityRound = Math.max(run.astraActivityRound ?? -1, activity.round);
      }
      run.astraActivityStates = Object.fromEntries(Object.entries(activityStates)
        .sort(([left], [right]) => Number(left) - Number(right)).slice(-16));
      if (projection.modelTurns > run.context.modelCalls) {
        this.appendRunEvent(run, 'model', 'Astra V3 agent cycle',
          `Model turns: ${projection.modelTurns}. Kernel capability calls: ${projection.capabilityCalls}.`);
      }
      run.iteration = Math.min(run.maxIterations, projection.modelTurns);
      run.context.modelCalls = projection.modelTurns;
      if (projection.approval) run.agentApproval = structuredClone(projection.approval);
      else delete run.agentApproval;
      if (projection.question) run.agentQuestion = structuredClone(projection.question);
      else delete run.agentQuestion;
      const now = new Date().toISOString(); run.updatedAt = now;
      run.cancelled = projection.status === 'cancelled';
      if (projection.status === 'completed') {
        run.status = 'completed'; run.answer = String(projection.answer || '').trim(); run.error = '';
        run.summary.lastAssistantSummary = compactText(run.answer, 2_000);
        if (previousStatus !== 'completed') {
          if (run.answer) this.appendRunEvent(run, 'assistant', 'Coder completed', run.answer, { ok: true });
          this.applyRunStatus(run, 'completed', 'Astra V3 task completed and its receipt-backed result was persisted.');
        } else run.finishedAt ||= now;
      } else if (projection.status === 'failed') {
        run.status = 'failed'; run.error = compactText(projection.error || 'Astra V3 Agent Task failed.', 4_000);
        if (previousStatus !== 'failed') this.applyRunStatus(run, 'failed', run.error);
        else run.finishedAt ||= now;
      } else if (projection.status === 'cancelled') {
        run.status = 'cancelled'; run.error = '';
        if (previousStatus !== 'cancelled') this.applyRunStatus(run, 'cancelled', 'Astra V3 task was cancelled.');
        else run.finishedAt ||= now;
      } else if (projection.status === 'interrupted') {
        run.status = 'interrupted'; run.error = ''; run.finishedAt = null;
        if (previousStatus !== 'interrupted') this.applyRunStatus(run, 'interrupted', 'Astra V3 task is paused and can be resumed explicitly.');
      } else {
        run.status = 'running'; run.startedAt ||= now; run.finishedAt = null; run.error = '';
        if (previousStatus !== 'running') this.applyRunStatus(run, 'running', 'Astra V3 task is running.');
      }
      this.refreshContextMetrics(run); return cloneRun(run);
    });
  }

  recordModelUsage(runId: string, usage: Record<string, unknown>): void {
    const input = readUsageNumber(usage, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens']);
    const output = readUsageNumber(usage, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']);
    const total = readUsageNumber(usage, ['total_tokens', 'totalTokens']) || input + output;
    this.mutateRun(runId, (run) => {
      run.context.modelCalls = (run.context.modelCalls || 0) + 1;
      run.context.modelInputTokens = (run.context.modelInputTokens || 0) + input;
      run.context.modelOutputTokens = (run.context.modelOutputTokens || 0) + output;
      run.context.modelTotalTokens = (run.context.modelTotalTokens || 0) + total;
      run.updatedAt = new Date().toISOString();
    });
  }

  complete(runId: string, answer: string): CoderRun {
    return this.mutateRun(runId, (run) => {
      run.summary.failures = unresolvedCoderFailures(run);
      run.answer = answer.trim();
      run.summary.lastAssistantSummary = compactText(answer, 2_000);
      this.appendRunEvent(run, 'assistant', 'Coder completed', answer.trim(), { ok: true });
      this.applyRunStatus(run, 'completed', 'Task completed and context persisted.');
      return cloneRun(run);
    });
  }

  fail(runId: string, error: string): CoderRun {
    return this.mutateRun(runId, (run) => {
      run.error = compactText(error, 4_000);
      this.applyRunStatus(run, 'failed', run.error);
      return cloneRun(run);
    });
  }

  requestCancel(runId: string): CoderRun {
    const current = this.requireMutable(runId);
    if (current.cancelled || ['completed', 'failed', 'cancelled'].includes(current.status)) return cloneRun(current);
    return this.mutateRun(runId, (run) => {
      run.cancelled = true;
      run.updatedAt = new Date().toISOString();
      this.appendRunEvent(run, 'status', 'Cancellation requested', 'Stopping the active model response before any further Coder action.');
      return cloneRun(run);
    });
  }

  recordDecision(runId: string, decision: string): void {
    this.mutateRun(runId, (run) => {
      pushUnique(run.summary.decisions, compactText(decision, 800), 40);
      run.updatedAt = new Date().toISOString();
      this.refreshContextMetrics(run);
    });
  }

  setPending(runId: string, pending: string[]): void {
    this.mutateRun(runId, (run) => {
      run.summary.pending = pending.map((entry) => compactText(entry, 800)).filter(Boolean).slice(-40);
      run.updatedAt = new Date().toISOString();
      this.refreshContextMetrics(run);
    });
  }

  addEvent(
    runId: string,
    kind: CoderRunEventKind,
    title: string,
    detail: string,
    extra: Partial<Omit<CoderRunEvent, 'id' | 'sequence' | 'kind' | 'title' | 'detail' | 'createdAt'>> = {},
  ): CoderRunEvent {
    return this.mutateRun(runId, (run) => ({ ...this.appendRunEvent(run, kind, title, detail, extra) }));
  }

  projection(runId: string): CoderPromptProjection {
    return this.mutateRun(runId, (run) => {
      this.refreshContextMetrics(run);
      const summary = promptSummary(run.summary);
      const recentEvents = run.events
        .filter((event) => event.sequence > run.summary.compactedThroughSequence)
        .slice(-MAX_RECENT_EVENTS)
        .map((event) => ({
          sequence: event.sequence,
          kind: event.kind,
          title: event.title,
          detail: compactText(event.detail, 1_600),
          ...(event.capabilityId ? { capabilityId: event.capabilityId } : {}),
          ...(typeof event.ok === 'boolean' ? { ok: event.ok } : {}),
          ...(event.error ? { error: event.error } : {}),
        }));
      const projectionTokenLimit = Math.max(1_024, Math.min(
        MAX_PROJECTION_TOKENS,
        this.budgetTokens - this.reservedOutputTokens - 2_048,
      ));
      while (recentEvents.length > 2 && estimateTokens(JSON.stringify({ summary, recentEvents })) > projectionTokenLimit) {
        recentEvents.shift();
      }
      if (estimateTokens(JSON.stringify({ summary, recentEvents })) > projectionTokenLimit) {
        for (const event of recentEvents) event.detail = compactText(event.detail, 480);
      }
      const estimatedPromptTokens = estimateTokens(JSON.stringify({ summary, recentEvents }));
      return {
        summary,
        recentEvents,
        metrics: { ...run.context, estimatedPromptTokens },
      };
    });
  }

  private requireMutable(runId: string): CoderRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Coder run not found: ${runId}`);
    return run;
  }

  private mutateRun<R>(runId: string, mutation: (run: CoderRun) => R): R {
    const run = this.requireMutable(runId);
    const previous = cloneRun(run);
    try {
      const result = mutation(run);
      // A pass that changed nothing but the clock is not an update. Startup
      // re-projects every bound run; stamping each one moved finished
      // conversations to the top of the list and rewrote every file.
      if (JSON.stringify({ ...run, updatedAt: previous.updatedAt }) === JSON.stringify(previous)) {
        run.updatedAt = previous.updatedAt;
        const copy = result as { id?: unknown; updatedAt?: unknown } | null;
        if (copy && typeof copy === 'object' && copy.id === run.id) copy.updatedAt = previous.updatedAt;
        return result;
      }
      this.persist(run);
      return result;
    } catch (error) {
      this.runs.set(runId, previous);
      throw error;
    }
  }

  private appendRunEvent(
    run: CoderRun,
    kind: CoderRunEventKind,
    title: string,
    detail: string,
    extra: Partial<Omit<CoderRunEvent, 'id' | 'sequence' | 'kind' | 'title' | 'detail' | 'createdAt'>> = {},
  ): CoderRunEvent {
    const event: CoderRunEvent = {
      id: `coder_event_${randomUUID()}`,
      sequence: (run.events.at(-1)?.sequence || 0) + 1,
      kind,
      createdAt: new Date().toISOString(),
      title: compactText(title, 300),
      detail: compactText(detail, MAX_EVENT_DETAIL_CHARS),
      ...extra,
    };
    run.events.push(event);
    run.updatedAt = event.createdAt;
    this.foldEventIntoSummary(run, event);
    this.refreshContextMetrics(run);
    return event;
  }

  private applyRunStatus(run: CoderRun, status: CoderRunStatus, detail: string): void {
    const now = new Date().toISOString();
    run.status = status;
    run.updatedAt = now;
    if (status === 'running') {
      if (!run.startedAt) run.startedAt = now;
      run.finishedAt = null;
      run.error = '';
      run.cancelled = false;
    }
    if (status === 'interrupted') run.finishedAt = null;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') run.finishedAt = now;
    if (status === 'failed') run.error = detail || run.error;
    if (status === 'cancelled') run.cancelled = true;
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    this.appendRunEvent(run, status === 'failed' ? 'error' : 'status', `Task ${status}`, detail || status, {
      ...(terminal ? { ok: status === 'completed' } : {}),
    });
  }

  /** Moves an unreadable journal to `quarantine/` unchanged. If even the move
   * fails the file stays where it is and is simply skipped this time. */
  private quarantine(file: string, reason: string): void {
    const target = path.join(this.runsRoot, 'quarantine',
      `${path.basename(file)}.${new Date().toISOString().replace(/[:.]/gu, '-')}.${reason}`);
    let moved = false;
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      renameWithWindowsRetrySync(file, target);
      moved = true;
    } catch { /* skipped below */ }
    console.error(JSON.stringify({ diagnostic: 'coder-run-quarantined', file: path.basename(file), reason, moved }));
  }

  private restore(): void {
    const primaryExists = existsSync(this.runsRoot);
    const sourceRoot = primaryExists
      ? this.runsRoot
      : this.legacyRunsRoot && existsSync(this.legacyRunsRoot) ? this.legacyRunsRoot : null;
    if (!sourceRoot) return;
    const migratingLegacyState = sourceRoot !== this.runsRoot;
    const files = readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(sourceRoot, entry.name));
    for (const file of files) {
      // One damaged journal used to stop the whole Coder module from loading
      // (every project and conversation gone until someone fixed the file by
      // hand). It is set aside byte for byte instead and the rest loads.
      let run: unknown;
      try { run = readDurableJson<unknown>(file, { sensitive: { storeId: 'coder-runs' } }); }
      catch { this.quarantine(file, 'invalid-json'); continue; }
      if (run === null) continue;
      if (!isValidRun(run)) { this.quarantine(file, 'invalid-schema'); continue; }
      if (path.basename(file) !== `${run.id}.json`) { this.quarantine(file, 'id-mismatch'); continue; }
      if (this.runs.has(run.id)) { this.quarantine(file, 'duplicate-id'); continue; }
      let changed = false;
      if (run.status === 'running' || run.status === 'queued') {
        run.error = '';
        run.finishedAt = null;
        run.cancelled = false;
        if (run.oscarTurnId) {
          // Oscar Turn + Astra V3 journal are the execution authority. A
          // process exit is not a pause command and must not turn autonomous
          // work into a user-resume wall. The controller rebinds this durable
          // Turn, including the narrow gap before agentTaskId was projected.
          this.appendRunEvent(
            run,
            'status',
            'Task recovery pending',
            'The durable Oscar/Astra V3 task will continue automatically after Monarch restores its exact Turn binding.',
          );
        } else {
          run.status = 'interrupted';
          this.appendRunEvent(
            run,
            'status',
            'Task interrupted',
            'The previous Monarch process stopped. Verified receipts and checkpoints were preserved; this legacy run can be resumed only when an authoritative task binding exists.',
          );
        }
        changed = true;
      }
      for (const key of ['modelCalls', 'modelInputTokens', 'modelOutputTokens', 'modelTotalTokens'] as const) {
        if (typeof run.context[key] !== 'number') {
          run.context[key] = 0;
          changed = true;
        }
      }
      if (changed || migratingLegacyState) this.persist(run);
      this.runs.set(run.id, run);
    }
    this.pruneRuns();
  }

  private foldEventIntoSummary(run: CoderRun, event: CoderRunEvent): void {
    const capabilityId = event.capabilityId || '';
    const output = isRecord(event.output) ? event.output : null;
    if (event.kind === 'tool-result' && event.ok === true
      && (capabilityId === 'coder.files.write' || capabilityId === 'coder.files.patch' || capabilityId === 'coder.files.delete')) {
      const changedPath = typeof output?.path === 'string' ? output.path : extractLikelyPath(event.detail);
      if (changedPath) pushUnique(run.summary.modifiedFiles, changedPath, 80);
    }
    if (capabilityId === 'coder.command.run' && event.kind === 'tool-result') {
      const executable = typeof output?.executable === 'string' ? output.executable : event.title.replace(/^Run\s+/i, '');
      const args = Array.isArray(output?.args) ? output.args.map(String).join(' ') : '';
      pushUnique(run.summary.commands, compactText(`${executable}${args ? ` ${args}` : ''}`, 500), 50);
      const command = `${executable} ${args}`.trim();
      if (/\b(test|pytest|vitest|jest|typecheck|lint|build|verify)\b/i.test(command)) {
        pushUnique(run.summary.tests, `${event.ok ? 'PASS' : 'FAIL'}: ${compactText(command, 500)}`, 50);
      }
    }
    if (capabilityId === 'coder.skills.create' && event.ok) {
      const skill = typeof output?.skill === 'string' ? output.skill : event.title;
      pushUnique(run.summary.activeSkills, compactText(skill, 200), 60);
    }
    if (event.ok === false || event.kind === 'error') {
      const failure = event.error && event.detail
        ? `${event.error}: ${event.detail}`
        : event.error || event.detail;
      pushUnique(run.summary.failures, compactText(`${event.title}: ${failure}`, 1_000), 32);
    }
    if (event.kind === 'assistant') run.summary.lastAssistantSummary = compactText(event.detail, 2_000);
  }

  private refreshContextMetrics(run: CoderRun): void {
    const uncompacted = run.events.filter((event) => event.sequence > run.summary.compactedThroughSequence);
    let estimated = estimateTokens(JSON.stringify({ summary: run.summary, events: uncompacted.slice(-MAX_RECENT_EVENTS) }));
    const needsCompaction = uncompacted.length > MAX_RECENT_EVENTS || estimated > COMPACTION_TOKEN_THRESHOLD;
    if (needsCompaction) {
      const retained = uncompacted.slice(-Math.min(8, MAX_RECENT_EVENTS));
      const compacted = uncompacted.slice(0, Math.max(0, uncompacted.length - retained.length));
      const through = compacted.at(-1)?.sequence || run.summary.compactedThroughSequence;
      if (through > run.summary.compactedThroughSequence) {
        run.summary.compactedThroughSequence = through;
        run.context.compactions += 1;
        run.events.push({
          id: `coder_event_${randomUUID()}`,
          sequence: (run.events.at(-1)?.sequence || 0) + 1,
          kind: 'context-compacted',
          createdAt: new Date().toISOString(),
          title: 'Context compacted',
          detail: `Older prompt events through sequence ${through} were folded into the durable structured summary; the full journal remains on disk.`,
          ok: true,
        });
      }
      estimated = estimateTokens(JSON.stringify({ summary: run.summary, events: retained }));
    }
    run.context.estimatedPromptTokens = estimated;
    run.context.retainedRecentEvents = run.events.filter((event) => event.sequence > run.summary.compactedThroughSequence).slice(-MAX_RECENT_EVENTS).length;
    run.context.totalEvents = run.events.length;
  }

  private persist(run: CoderRun): void {
    this.writeRun(path.join(this.runsRoot, `${run.id}.json`), run);
    if (!this.listeners.size) return;
    const snapshot = cloneRun(run);
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* a viewer never breaks the journal */ }
    }
  }

  /** Keeps the newest MAX_RUNS in memory. A finished run beyond that moves to
   * runs/archive/ (kept, never loaded): its file used to stay beside the live
   * ones and be read again on every start, so startup slowed with history. A
   * run that is not finished is never pruned. */
  private pruneRuns(): void {
    const sorted = Array.from(this.runs.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const run of sorted.slice(MAX_RUNS)) {
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) continue;
      this.runs.delete(run.id);
      const file = path.join(this.runsRoot, `${run.id}.json`);
      if (!existsSync(file)) continue;
      try {
        mkdirSync(path.join(this.runsRoot, 'archive'), { recursive: true });
        renameWithWindowsRetrySync(file, path.join(this.runsRoot, 'archive', `${run.id}.json`));
      } catch { /* Stays live and is pruned from memory again next start. */ }
    }
  }
}

export function unresolvedCoderFailures(run: CoderRun): string[] {
  const latestToolResult = new Map<string, CoderRun['events'][number]>();
  for (const event of run.events) {
    if (event.kind === 'tool-result' && event.capabilityId) latestToolResult.set(event.capabilityId, event);
  }
  return run.summary.failures.filter((failure) => {
    if (/terminal-receipts-missing|^Task running:/i.test(failure)) return false;
    const failedCapability = /^Failed ([a-z0-9._-]+):/i.exec(failure)?.[1];
    return !failedCapability || latestToolResult.get(failedCapability)?.ok !== true;
  });
}

function emptySummary(goal: string): CoderContextSummary {
  return {
    goal: compactText(goal, 4_000),
    decisions: [],
    modifiedFiles: [],
    commands: [],
    tests: [],
    failures: [],
    pending: [],
    activeSkills: [],
    lastAssistantSummary: '',
    compactedThroughSequence: 0,
  };
}

function promptSummary(summary: CoderContextSummary): CoderContextSummary {
  return {
    goal: compactText(summary.goal, 600),
    decisions: summary.decisions.slice(-4).map((value) => compactText(value, 180)),
    modifiedFiles: summary.modifiedFiles.slice(-10).map((value) => compactText(value, 140)),
    commands: summary.commands.slice(-5).map((value) => compactText(value, 180)),
    tests: summary.tests.slice(-5).map((value) => compactText(value, 140)),
    failures: summary.failures.slice(-4).map((value) => compactText(value, 180)),
    pending: summary.pending.slice(-4).map((value) => compactText(value, 180)),
    activeSkills: summary.activeSkills.slice(-6).map((value) => compactText(value, 80)),
    lastAssistantSummary: compactText(summary.lastAssistantSummary, 400),
    compactedThroughSequence: summary.compactedThroughSequence,
  };
}

export function isCoderSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && /^coder_(session|run)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function coderRunSessionId(run: Pick<CoderRun, 'id' | 'sessionId'>): string {
  return run.sessionId ?? run.id;
}

function isValidRun(value: unknown): value is CoderRun {
  if (!isRecord(value) || !isRecord(value.summary) || !isRecord(value.context)) return false;
  const summary = value.summary;
  const context = value.context;
  return typeof value.id === 'string'
    && /^coder_run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    && typeof value.projectId === 'string'
    && value.projectId.length > 0
    && (value.sessionId === undefined || isCoderSessionId(value.sessionId))
    && (value.projectName === undefined || typeof value.projectName === 'string')
    && (value.projectRoot === undefined || typeof value.projectRoot === 'string')
    && (value.oscarTurnId === undefined || typeof value.oscarTurnId === 'string')
    && (value.agentTaskId === undefined || typeof value.agentTaskId === 'string')
    && (value.agentRuntimeVersion === undefined || value.agentRuntimeVersion === 'v2' || value.agentRuntimeVersion === 'v3')
    && (value.agentEventSequence === undefined || isNonNegativeInteger(value.agentEventSequence))
    && (value.astraActivityRound === undefined || typeof value.astraActivityRound === 'number'
      && Number.isSafeInteger(value.astraActivityRound) && value.astraActivityRound >= -1)
    && (value.astraActivityStates === undefined || isRecord(value.astraActivityStates)
      && Object.keys(value.astraActivityStates).length <= 16
      && Object.entries(value.astraActivityStates).every(([key, state]) => /^\d{1,6}$/u.test(key)
        && ['proposed', 'observed', 'failed'].includes(String(state))))
    && typeof value.prompt === 'string'
    && isCoderModelId(value.model)
    && isCoderStatus(value.status)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && (value.startedAt === null || typeof value.startedAt === 'string')
    && (value.finishedAt === null || typeof value.finishedAt === 'string')
    && typeof value.answer === 'string'
    && typeof value.error === 'string'
    && isNonNegativeInteger(value.iteration)
    && isNonNegativeInteger(value.maxIterations)
    && typeof value.cancelled === 'boolean'
    && (value.agentApproval === undefined || isValidAgentApproval(value.agentApproval))
    && (value.agentQuestion === undefined || isValidAgentQuestion(value.agentQuestion))
    && isValidRunEvents(value.events)
    && typeof summary.goal === 'string'
    && isStringArray(summary.decisions)
    && isStringArray(summary.modifiedFiles)
    && isStringArray(summary.commands)
    && isStringArray(summary.tests)
    && isStringArray(summary.failures)
    && isStringArray(summary.pending)
    && isStringArray(summary.activeSkills)
    && typeof summary.lastAssistantSummary === 'string'
    && isNonNegativeInteger(summary.compactedThroughSequence)
    && isNonNegativeNumber(context.budgetTokens)
    && isNonNegativeNumber(context.estimatedPromptTokens)
    && isNonNegativeNumber(context.reservedOutputTokens)
    && isNonNegativeNumber(context.retainedRecentEvents)
    && isNonNegativeNumber(context.totalEvents)
    && isNonNegativeNumber(context.compactions)
    && isOptionalNonNegativeNumber(context.modelCalls)
    && isOptionalNonNegativeNumber(context.modelInputTokens)
    && isOptionalNonNegativeNumber(context.modelOutputTokens)
    && isOptionalNonNegativeNumber(context.modelTotalTokens);
}

function isValidAgentApproval(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.capabilityId === 'string'
    && typeof value.canonicalProposalHash === 'string'
    && typeof value.reason === 'string'
    && (value.expiresAt === undefined || typeof value.expiresAt === 'string')
    && (value.purpose === undefined || value.purpose === 'policy' || value.purpose === 'owner-security-override')
    && isRecord(value.proposal);
}

function isValidAgentQuestion(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => ['id', 'digest', 'text', 'predecessorMessageId', 'expiresAt'].includes(key))
    && typeof value.id === 'string'
    && typeof value.digest === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value.digest)
    && typeof value.text === 'string'
    && value.text.trim().length > 0
    && Buffer.byteLength(value.text) <= 4096
    && typeof value.predecessorMessageId === 'string'
    && typeof value.expiresAt === 'string'
    && Number.isFinite(Date.parse(value.expiresAt));
}

function isValidRunEvents(value: unknown): value is CoderRunEvent[] {
  if (!Array.isArray(value)) return false;
  let previousSequence = 0;
  for (const event of value) {
    if (!isRecord(event)
      || typeof event.id !== 'string'
      || !/^coder_event_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.id)
      || !isNonNegativeInteger(event.sequence)
      || event.sequence !== previousSequence + 1
      || !isCoderEventKind(event.kind)
      || typeof event.createdAt !== 'string'
      || typeof event.title !== 'string'
      || typeof event.detail !== 'string'
      || (event.capabilityId !== undefined && typeof event.capabilityId !== 'string')
      || (event.ok !== undefined && typeof event.ok !== 'boolean')
      || (event.error !== undefined && typeof event.error !== 'string')) return false;
    previousSequence = event.sequence;
  }
  return true;
}

function isCoderStatus(value: unknown): value is CoderRunStatus {
  return value === 'queued'
    || value === 'running'
    || value === 'interrupted'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled';
}

function isCoderEventKind(value: unknown): value is CoderRunEventKind {
  return value === 'status'
    || value === 'model'
    || value === 'assistant'
    || value === 'tool-start'
    || value === 'tool-result'
    || value === 'context-compacted'
    || value === 'error';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value);
}

function cloneRun(run: CoderRun): CoderRun {
  return structuredClone(run);
}

function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 3.6);
}

function compactText(value: string, maxCharacters: number): string {
  const normalized = String(value || '').replace(/\u0000/g, '').trim();
  return normalized.length <= maxCharacters ? normalized : `${normalized.slice(0, maxCharacters)}\n…[truncated]`;
}

function pushUnique(values: string[], value: string, limit: number): void {
  if (!value || values.includes(value)) return;
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function extractLikelyPath(value: string): string {
  return /(?:[A-Za-z]:[\\/]|\/)[^\r\n]+/.exec(value)?.[0]?.trim() || '';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function readUsageNumber(usage: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) return Math.trunc(value);
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
