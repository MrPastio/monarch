import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readDurableJson, writeDurableJson } from '../../core/durable-json';
import type {
  CoderContextSummary,
  CoderModelId,
  CoderRun,
  CoderRunEvent,
  CoderRunEventKind,
  CoderRunStatus,
} from './types';

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
  budgetTokens?: number;
  reservedOutputTokens?: number;
  maxIterations?: number;
}

export interface CoderPromptProjection {
  summary: CoderContextSummary;
  recentEvents: Array<Pick<CoderRunEvent, 'sequence' | 'kind' | 'title' | 'detail' | 'capabilityId' | 'ok' | 'error'>>;
  metrics: CoderRun['context'];
}

export class CoderRunStore {
  readonly runsRoot: string;
  private readonly budgetTokens: number;
  private readonly reservedOutputTokens: number;
  private readonly maxIterations: number;
  private readonly runs = new Map<string, CoderRun>();

  constructor(options: CoderRunStoreOptions) {
    this.runsRoot = path.resolve(options.monarchRoot, 'runtime', 'coder', 'runs');
    this.budgetTokens = clamp(options.budgetTokens || DEFAULT_CONTEXT_BUDGET, 8_192, 131_072);
    this.reservedOutputTokens = clamp(options.reservedOutputTokens || DEFAULT_RESERVED_OUTPUT, 1_024, 16_384);
    this.maxIterations = clamp(options.maxIterations || DEFAULT_MAX_ITERATIONS, 8, 128);
    this.restore();
  }

  list(projectId?: string): CoderRun[] {
    return Array.from(this.runs.values())
      .filter((run) => !projectId || run.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 60)
      .map(cloneRun);
  }

  get(runId: string): CoderRun | null {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : null;
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
    return run;
  }

  create(
    projectId: string,
    prompt: string,
    model: CoderModelId = 'qwen3-coder-30b-a3b-instruct',
    projectIdentity?: { name: string; root: string },
  ): CoderRun {
    const now = new Date().toISOString();
    const run: CoderRun = {
      id: `coder_run_${randomUUID()}`,
      projectId,
      ...(projectIdentity ? { projectName: projectIdentity.name, projectRoot: path.resolve(projectIdentity.root) } : {}),
      prompt: prompt.trim(),
      model,
      fallbackModel: 'deepseek-coder-v2-lite-instruct',
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
    this.addEvent(run.id, 'status', 'Task queued', prompt.trim());
    this.pruneRuns();
    return cloneRun(this.require(run.id));
  }

  setStatus(runId: string, status: CoderRunStatus, detail = ''): CoderRun {
    const run = this.require(runId);
    const now = new Date().toISOString();
    run.status = status;
    run.updatedAt = now;
    if (status === 'running' && !run.startedAt) run.startedAt = now;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') run.finishedAt = now;
    if (status === 'failed') run.error = detail || run.error;
    if (status === 'cancelled') run.cancelled = true;
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    this.addEvent(runId, status === 'failed' ? 'error' : 'status', `Task ${status}`, detail || status, {
      ...(terminal ? { ok: status === 'completed' } : {}),
    });
    return cloneRun(run);
  }

  setIteration(runId: string, iteration: number): void {
    const run = this.require(runId);
    run.iteration = clamp(iteration, 0, run.maxIterations);
    run.updatedAt = new Date().toISOString();
    this.persist(run);
  }

  recordModelUsage(runId: string, usage: Record<string, unknown>): void {
    const run = this.require(runId);
    const input = readUsageNumber(usage, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens']);
    const output = readUsageNumber(usage, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']);
    const total = readUsageNumber(usage, ['total_tokens', 'totalTokens']) || input + output;
    run.context.modelCalls = (run.context.modelCalls || 0) + 1;
    run.context.modelInputTokens = (run.context.modelInputTokens || 0) + input;
    run.context.modelOutputTokens = (run.context.modelOutputTokens || 0) + output;
    run.context.modelTotalTokens = (run.context.modelTotalTokens || 0) + total;
    run.updatedAt = new Date().toISOString();
    this.persist(run);
  }

  complete(runId: string, answer: string): CoderRun {
    const run = this.require(runId);
    run.summary.failures = unresolvedCoderFailures(run);
    run.answer = answer.trim();
    run.summary.lastAssistantSummary = compactText(answer, 2_000);
    this.addEvent(runId, 'assistant', 'Coder completed', answer.trim(), { ok: true });
    return this.setStatus(runId, 'completed', 'Task completed and context persisted.');
  }

  fail(runId: string, error: string): CoderRun {
    const run = this.require(runId);
    run.error = compactText(error, 4_000);
    return this.setStatus(runId, 'failed', run.error);
  }

  requestCancel(runId: string): CoderRun {
    const run = this.require(runId);
    if (run.cancelled || ['completed', 'failed', 'cancelled'].includes(run.status)) return cloneRun(run);
    run.cancelled = true;
    run.updatedAt = new Date().toISOString();
    this.addEvent(runId, 'status', 'Cancellation requested', 'Stopping the active model response before any further Coder action.');
    return cloneRun(run);
  }

  recordDecision(runId: string, decision: string): void {
    const run = this.require(runId);
    pushUnique(run.summary.decisions, compactText(decision, 800), 40);
    run.updatedAt = new Date().toISOString();
    this.refreshContextMetrics(run);
    this.persist(run);
  }

  setPending(runId: string, pending: string[]): void {
    const run = this.require(runId);
    run.summary.pending = pending.map((entry) => compactText(entry, 800)).filter(Boolean).slice(-40);
    run.updatedAt = new Date().toISOString();
    this.refreshContextMetrics(run);
    this.persist(run);
  }

  addEvent(
    runId: string,
    kind: CoderRunEventKind,
    title: string,
    detail: string,
    extra: Partial<Omit<CoderRunEvent, 'id' | 'sequence' | 'kind' | 'title' | 'detail' | 'createdAt'>> = {},
  ): CoderRunEvent {
    const run = this.require(runId);
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
    this.persist(run);
    return { ...event };
  }

  projection(runId: string): CoderPromptProjection {
    const run = this.require(runId);
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
  }

  private restore(): void {
    if (!existsSync(this.runsRoot)) return;
    const files = readdirSync(this.runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(this.runsRoot, entry.name));
    for (const file of files) {
      const run = readDurableJson<CoderRun>(file);
      if (!isValidRun(run)) continue;
      if (run.status === 'running' || run.status === 'queued') {
        const now = new Date().toISOString();
        run.status = 'failed';
        run.error = 'Previous Coder process stopped before completion; the full journal is preserved for a new run.';
        run.finishedAt = now;
        run.updatedAt = now;
      }
      run.context.modelCalls ||= 0;
      run.context.modelInputTokens ||= 0;
      run.context.modelOutputTokens ||= 0;
      run.context.modelTotalTokens ||= 0;
      this.runs.set(run.id, run);
      this.persist(run);
    }
    this.pruneRuns();
  }

  private foldEventIntoSummary(run: CoderRun, event: CoderRunEvent): void {
    const capabilityId = event.capabilityId || '';
    const output = isRecord(event.output) ? event.output : null;
    if (capabilityId === 'coder.files.write' || capabilityId === 'coder.files.patch' || capabilityId === 'coder.files.delete') {
      const changedPath = typeof output?.path === 'string' ? output.path : extractLikelyPath(event.detail);
      if (changedPath) pushUnique(run.summary.modifiedFiles, changedPath, 80);
    }
    if (capabilityId === 'coder.command.run' && event.kind === 'tool-result') {
      const executable = typeof output?.executable === 'string' ? output.executable : event.title.replace(/^Run\s+/i, '');
      const args = Array.isArray(output?.args) ? output.args.map(String).join(' ') : '';
      pushUnique(run.summary.commands, compactText(`${executable}${args ? ` ${args}` : ''}`, 500), 50);
      if (/\b(test|pytest|vitest|jest|typecheck|lint|build|verify)\b/i.test(`${event.title} ${event.detail}`)) {
        pushUnique(run.summary.tests, `${event.ok ? 'PASS' : 'FAIL'}: ${compactText(event.title, 500)}`, 50);
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
    writeDurableJson(path.join(this.runsRoot, `${run.id}.json`), run);
  }

  private pruneRuns(): void {
    const sorted = Array.from(this.runs.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const run of sorted.slice(MAX_RUNS)) this.runs.delete(run.id);
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

function isValidRun(value: CoderRun | null): value is CoderRun {
  return Boolean(value && typeof value.id === 'string' && typeof value.projectId === 'string' && Array.isArray(value.events));
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
