import type { AgentBudgetLimits, AgentBudgetUsage, AgentComputeClass } from './types';

export interface AgentUsageDelta {
  steps?: number;
  modelTurns?: number;
  toolCalls?: number;
  failures?: number;
  meaningfulProgress?: boolean;
  computeClass?: AgentComputeClass;
}

export type AgentBudgetExhaustion =
  | 'max-steps'
  | 'max-model-turns'
  | 'max-tool-calls'
  | 'max-wall-time'
  | 'max-failures'
  | 'max-consecutive-no-progress'
  | 'max-compute-class';

export type AgentBudgetDecision =
  | { allowed: true; usage: AgentBudgetUsage }
  | {
      allowed: false;
      usage: AgentBudgetUsage;
      exhaustedBy: AgentBudgetExhaustion;
      summary: string;
    };

export const DEFAULT_AGENT_BUDGET: Readonly<AgentBudgetLimits> = Object.freeze({
  maxSteps: 32,
  maxModelTurns: 16,
  maxToolCalls: 48,
  maxWallTimeMs: 15 * 60 * 1_000,
  maxFailures: 6,
  maxConsecutiveNoProgress: 4,
  maxComputeClass: 'medium',
});

const HARD_LIMITS: Readonly<AgentBudgetLimits> = Object.freeze({
  maxSteps: 512,
  maxModelTurns: 256,
  maxToolCalls: 1_024,
  maxWallTimeMs: 24 * 60 * 60 * 1_000,
  maxFailures: 64,
  maxConsecutiveNoProgress: 32,
  maxComputeClass: 'heavy',
});

export function normalizeAgentBudget(input: Partial<AgentBudgetLimits> = {}): AgentBudgetLimits {
  return {
    maxSteps: boundedInteger(input.maxSteps, DEFAULT_AGENT_BUDGET.maxSteps, 1, HARD_LIMITS.maxSteps),
    maxModelTurns: boundedInteger(
      input.maxModelTurns,
      DEFAULT_AGENT_BUDGET.maxModelTurns,
      1,
      HARD_LIMITS.maxModelTurns,
    ),
    maxToolCalls: boundedInteger(
      input.maxToolCalls,
      DEFAULT_AGENT_BUDGET.maxToolCalls,
      1,
      HARD_LIMITS.maxToolCalls,
    ),
    maxWallTimeMs: boundedInteger(
      input.maxWallTimeMs,
      DEFAULT_AGENT_BUDGET.maxWallTimeMs,
      1_000,
      HARD_LIMITS.maxWallTimeMs,
    ),
    maxFailures: boundedInteger(
      input.maxFailures,
      DEFAULT_AGENT_BUDGET.maxFailures,
      1,
      HARD_LIMITS.maxFailures,
    ),
    maxConsecutiveNoProgress: boundedInteger(
      input.maxConsecutiveNoProgress,
      DEFAULT_AGENT_BUDGET.maxConsecutiveNoProgress,
      1,
      HARD_LIMITS.maxConsecutiveNoProgress,
    ),
    maxComputeClass: normalizeComputeClass(input.maxComputeClass),
  };
}

export function createAgentBudgetUsage(now: Date | string | number = Date.now()): AgentBudgetUsage {
  const timestamp = normalizeIso(now);
  return {
    steps: 0,
    modelTurns: 0,
    toolCalls: 0,
    failures: 0,
    consecutiveNoProgress: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

export function recordAgentBudgetUsage(
  current: AgentBudgetUsage,
  delta: AgentUsageDelta,
  now: Date | string | number = Date.now(),
): AgentBudgetUsage {
  const timestamp = latestIso(current.updatedAt, now);
  const meaningfulProgress = delta.meaningfulProgress === true;
  const computeClass = maxComputeClass(current.computeClass, delta.computeClass);
  return {
    steps: addCounter(current.steps, delta.steps),
    modelTurns: addCounter(current.modelTurns, delta.modelTurns),
    toolCalls: addCounter(current.toolCalls, delta.toolCalls),
    failures: addCounter(current.failures, delta.failures),
    consecutiveNoProgress: meaningfulProgress
      ? 0
      : delta.meaningfulProgress === false
        ? addCounter(current.consecutiveNoProgress, 1)
        : nonNegativeInteger(current.consecutiveNoProgress),
    startedAt: normalizeIso(current.startedAt),
    updatedAt: timestamp,
    ...(meaningfulProgress
      ? { lastProgressAt: timestamp }
      : current.lastProgressAt ? { lastProgressAt: normalizeIso(current.lastProgressAt) } : {}),
    ...(computeClass ? { computeClass } : {}),
  };
}

export function evaluateAgentBudget(
  budgetInput: AgentBudgetLimits | Partial<AgentBudgetLimits>,
  usage: AgentBudgetUsage,
  now: Date | string | number = Date.now(),
): AgentBudgetDecision {
  const budget = normalizeAgentBudget(budgetInput);
  const normalizedUsage = normalizeUsage(usage);
  const elapsedMs = Math.max(0, Date.parse(normalizeIso(now)) - Date.parse(normalizedUsage.startedAt));

  if (elapsedMs >= budget.maxWallTimeMs) {
    return denied(normalizedUsage, 'max-wall-time', 'Agent task wall-time budget is exhausted.');
  }
  if (normalizedUsage.steps >= budget.maxSteps) {
    return denied(normalizedUsage, 'max-steps', 'Agent task step budget is exhausted.');
  }
  if (normalizedUsage.modelTurns >= budget.maxModelTurns) {
    return denied(normalizedUsage, 'max-model-turns', 'Agent task model-turn budget is exhausted.');
  }
  if (normalizedUsage.toolCalls >= budget.maxToolCalls) {
    return denied(normalizedUsage, 'max-tool-calls', 'Agent task tool-call budget is exhausted.');
  }
  if (normalizedUsage.failures >= budget.maxFailures) {
    return denied(normalizedUsage, 'max-failures', 'Agent task failure budget is exhausted.');
  }
  if (normalizedUsage.consecutiveNoProgress >= budget.maxConsecutiveNoProgress) {
    return denied(
      normalizedUsage,
      'max-consecutive-no-progress',
      'Agent task stopped after repeated turns without verified progress.',
    );
  }
  if (
    normalizedUsage.computeClass
    && computeClassRank(normalizedUsage.computeClass) > computeClassRank(budget.maxComputeClass || 'medium')
  ) {
    return denied(normalizedUsage, 'max-compute-class', 'Agent task compute-class budget is exhausted.');
  }
  return { allowed: true, usage: normalizedUsage };
}

export function canConsumeAgentBudget(
  budgetInput: AgentBudgetLimits | Partial<AgentBudgetLimits>,
  usage: AgentBudgetUsage,
  delta: AgentUsageDelta,
  now: Date | string | number = Date.now(),
): AgentBudgetDecision {
  const before = evaluateAgentBudget(budgetInput, usage, now);
  if (!before.allowed) return before;

  const budget = normalizeAgentBudget(budgetInput);
  const next = recordAgentBudgetUsage(before.usage, delta, now);
  const exceeded: Array<[boolean, AgentBudgetExhaustion, string]> = [
    [next.steps > budget.maxSteps, 'max-steps', 'Requested step would exceed the task step budget.'],
    [
      next.modelTurns > budget.maxModelTurns,
      'max-model-turns',
      'Requested model turn would exceed the task model-turn budget.',
    ],
    [
      next.toolCalls > budget.maxToolCalls,
      'max-tool-calls',
      'Requested tool call would exceed the task tool-call budget.',
    ],
    [next.failures > budget.maxFailures, 'max-failures', 'Requested retry would exceed the failure budget.'],
    [
      next.consecutiveNoProgress > budget.maxConsecutiveNoProgress,
      'max-consecutive-no-progress',
      'Requested turn would exceed the no-progress budget.',
    ],
    [
      Boolean(next.computeClass)
        && computeClassRank(next.computeClass || 'light') > computeClassRank(budget.maxComputeClass || 'medium'),
      'max-compute-class',
      'Requested work would exceed the task compute-class budget.',
    ],
  ];
  const limit = exceeded.find(([condition]) => condition);
  return limit ? denied(next, limit[1], limit[2]) : { allowed: true, usage: next };
}

export class AgentBudgetManager {
  readonly budget: AgentBudgetLimits;

  constructor(input: Partial<AgentBudgetLimits> = {}) {
    this.budget = normalizeAgentBudget(input);
  }

  createUsage(now: Date | string | number = Date.now()): AgentBudgetUsage {
    return createAgentBudgetUsage(now);
  }

  evaluate(
    usage: AgentBudgetUsage,
    now: Date | string | number = Date.now(),
  ): AgentBudgetDecision {
    return evaluateAgentBudget(this.budget, usage, now);
  }

  consume(
    usage: AgentBudgetUsage,
    delta: AgentUsageDelta,
    now: Date | string | number = Date.now(),
  ): AgentBudgetDecision {
    return canConsumeAgentBudget(this.budget, usage, delta, now);
  }
}

function normalizeUsage(usage: AgentBudgetUsage): AgentBudgetUsage {
  return {
    steps: nonNegativeInteger(usage.steps),
    modelTurns: nonNegativeInteger(usage.modelTurns),
    toolCalls: nonNegativeInteger(usage.toolCalls),
    failures: nonNegativeInteger(usage.failures),
    consecutiveNoProgress: nonNegativeInteger(usage.consecutiveNoProgress),
    startedAt: normalizeIso(usage.startedAt),
    updatedAt: normalizeIso(usage.updatedAt),
    ...(usage.lastProgressAt ? { lastProgressAt: normalizeIso(usage.lastProgressAt) } : {}),
    ...(usage.computeClass ? { computeClass: usage.computeClass } : {}),
  };
}

function denied(
  usage: AgentBudgetUsage,
  exhaustedBy: AgentBudgetExhaustion,
  summary: string,
): AgentBudgetDecision {
  return { allowed: false, usage, exhaustedBy, summary };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value as number)));
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function addCounter(current: number, increment: number | undefined): number {
  return nonNegativeInteger(current) + nonNegativeInteger(increment || 0);
}

function normalizeIso(value: Date | string | number): string {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Agent budget timestamp is invalid.');
  return new Date(timestamp).toISOString();
}

function latestIso(left: Date | string | number, right: Date | string | number): string {
  const leftIso = normalizeIso(left);
  const rightIso = normalizeIso(right);
  return Date.parse(leftIso) >= Date.parse(rightIso) ? leftIso : rightIso;
}

function normalizeComputeClass(value: AgentComputeClass | undefined): AgentComputeClass {
  return value === 'light' || value === 'heavy' || value === 'medium' ? value : 'medium';
}

function maxComputeClass(
  left: AgentComputeClass | undefined,
  right: AgentComputeClass | undefined,
): AgentComputeClass | undefined {
  if (!left) return right;
  if (!right) return left;
  return computeClassRank(left) >= computeClassRank(right) ? left : right;
}

function computeClassRank(value: AgentComputeClass): number {
  return value === 'heavy' ? 3 : value === 'medium' ? 2 : 1;
}
