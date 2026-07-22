import { describe, expect, it } from 'vitest';
import {
  AgentBudgetManager,
  canConsumeAgentBudget,
  createAgentBudgetUsage,
  normalizeAgentBudget,
  recordAgentBudgetUsage,
} from '../../src/agent/budget-manager';

describe('AgentBudgetManager', () => {
  it('clamps caller budgets to finite hard bounds', () => {
    expect(normalizeAgentBudget({
      maxSteps: 0,
      maxModelTurns: Number.POSITIVE_INFINITY,
      maxToolCalls: 50_000,
      maxWallTimeMs: -1,
      maxFailures: 0,
      maxConsecutiveNoProgress: 999,
      maxComputeClass: 'heavy',
    })).toEqual({
      maxSteps: 1,
      maxModelTurns: 16,
      maxToolCalls: 1_024,
      maxWallTimeMs: 1_000,
      maxFailures: 1,
      maxConsecutiveNoProgress: 32,
      maxComputeClass: 'heavy',
    });
  });

  it('allows the last bounded call and blocks calls beyond the limit', () => {
    const budget = normalizeAgentBudget({ maxToolCalls: 1 });
    const usage = createAgentBudgetUsage('2026-07-22T10:00:00.000Z');
    const first = canConsumeAgentBudget(
      budget,
      usage,
      { toolCalls: 1 },
      '2026-07-22T10:00:01.000Z',
    );
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    expect(canConsumeAgentBudget(
      budget,
      first.usage,
      { toolCalls: 1 },
      '2026-07-22T10:00:02.000Z',
    )).toMatchObject({ allowed: false, exhaustedBy: 'max-tool-calls' });
  });

  it('resets no-progress only after meaningful progress and enforces wall time', () => {
    const manager = new AgentBudgetManager({
      maxConsecutiveNoProgress: 2,
      maxWallTimeMs: 2_000,
    });
    const initial = manager.createUsage('2026-07-22T10:00:00.000Z');
    const stalled = recordAgentBudgetUsage(initial, { meaningfulProgress: false }, '2026-07-22T10:00:00.500Z');
    const progressed = recordAgentBudgetUsage(stalled, { meaningfulProgress: true }, '2026-07-22T10:00:01.000Z');
    expect(progressed.consecutiveNoProgress).toBe(0);
    expect(progressed.lastProgressAt).toBe('2026-07-22T10:00:01.000Z');
    expect(manager.evaluate(progressed, '2026-07-22T10:00:02.000Z')).toMatchObject({
      allowed: false,
      exhaustedBy: 'max-wall-time',
    });
  });
});
