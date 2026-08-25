import { describe, expect, it } from 'vitest';
import {
  createInitialAgentPlan,
  currentAgentPlanStep,
  reconcileAgentPlanAfterVerifiedGoal,
  reviseAgentPlan,
  settleAgentPlanStep,
} from '../../src/agent/plan-manager';

describe('Agent plan dependencies', () => {
  it('binds revised steps by runtime ids instead of model-authored titles', () => {
    const initial = createInitialAgentPlan('Inspect and update.', '2026-08-08T10:00:00.000Z');
    const revised = reviseAgentPlan(initial, {
      kind: 'revise-plan',
      summary: 'Inspect, then update.',
      steps: [
        { title: 'Inspect files on disk D', expectedEffect: 'Inventory is available.' },
        { title: 'Update the exact target', expectedEffect: 'The target is updated.' },
      ],
      reason: 'Two verified steps are required.',
    }, '2026-08-08T10:00:01.000Z');
    const [inspect, update] = revised.steps.slice(-2);

    expect(inspect?.dependsOn).toEqual([]);
    expect(update?.dependsOn).toEqual([inspect?.id]);
    expect(update?.dependsOn).not.toContain(inspect?.title);

    const settled = settleAgentPlanStep(revised, inspect!.id, {
      status: 'verified',
      summary: 'Inventory recorded.',
    }, '2026-08-08T10:00:02.000Z');
    expect(settled.steps.find((step) => step.id === update?.id)?.status).toBe('ready');
  });

  it('preserves completed work and explicitly skips only redundant unfinished steps after goal verification', () => {
    const initial = createInitialAgentPlan('Run one verified action.', '2026-08-13T00:00:00.000Z');
    const revised = reviseAgentPlan(initial, {
      kind: 'revise-plan',
      summary: 'Perform and verify the requested effect.',
      reason: 'Fixture plan.',
      steps: [
        { title: 'Perform effect', expectedEffect: 'The requested state changes.' },
        { title: 'Analyze result', expectedEffect: 'The already returned receipt is understood.' },
        { title: 'Verify result', expectedEffect: 'The runtime-owned postcondition is confirmed.' },
      ],
    }, '2026-08-13T00:00:01.000Z');
    const current = currentAgentPlanStep(revised)!;
    const settled = settleAgentPlanStep(revised, current.id, {
      status: 'verified',
      summary: 'Kernel verified the requested state change.',
    }, '2026-08-13T00:00:02.000Z');

    const reconciled = reconcileAgentPlanAfterVerifiedGoal(settled, '2026-08-13T00:00:03.000Z');

    expect(reconciled.revision).toBe(settled.revision + 1);
    expect(reconciled.steps.slice(-3).map((step) => step.status)).toEqual(['completed', 'skipped', 'skipped']);
    expect(reconciled.steps.slice(-2).every((step) => (
      step.verificationResult?.status === 'not-run'
      && step.verificationResult.summary.includes('Kernel evidence')
    ))).toBe(true);
  });
});
