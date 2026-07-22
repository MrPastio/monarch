import { describe, expect, it } from 'vitest';
import { normalizeAgentGoal } from '../../src/agent/goal-normalizer';
import { createInitialAgentPlan, reviseAgentPlan } from '../../src/agent/plan-manager';

describe('agent goal and plan management', () => {
  it('keeps the original request and adds bounded verification defaults', () => {
    const goal = normalizeAgentGoal({ request: '  Build   a report  ' });
    expect(goal.originalRequest).toBe('Build a report');
    expect(goal.expectedOutputs).toHaveLength(1);
    expect(goal.expectedOutputs[0]?.description).toContain('Build a report');
    expect(goal.successCriteria).toHaveLength(1);
  });

  it('preserves settled history when the model revises upcoming steps', () => {
    const plan = createInitialAgentPlan('Build report', '2026-01-01T00:00:00.000Z');
    const revised = reviseAgentPlan(plan, {
      kind: 'revise-plan', summary: 'Inspect then write', reason: 'Need evidence',
      steps: [
        { title: 'Inspect inputs', expectedEffect: 'Inputs understood' },
        { title: 'Write report', expectedEffect: 'Report exists' },
      ],
    }, '2026-01-01T00:01:00.000Z');
    expect(revised.revision).toBe(2);
    expect(revised.steps[0]?.status).toBe('skipped');
    expect(revised.steps.slice(-2).map((step) => step.status)).toEqual(['ready', 'proposed']);
  });
});
