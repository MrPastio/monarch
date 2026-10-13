import type { AgentBudgetLimits, AgentComputeClass } from './types';

/** Runtime-neutral limits shared by every Agent surface. */
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

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value as number)));
}

function normalizeComputeClass(value: AgentComputeClass | undefined): AgentComputeClass {
  return value === 'light' || value === 'heavy' || value === 'medium' ? value : 'medium';
}
