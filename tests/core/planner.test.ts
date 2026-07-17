import { describe, expect, it } from 'vitest';
import { MonarchPlanner } from '../../src/core/planner';
import type { MonarchCapability, MonarchIntent, MonarchRouteDecision } from '../../src/core';

function intent(text: string, context: Record<string, unknown> = {}): MonarchIntent {
  return {
    id: 'intent_planner_smoke',
    source: 'smoke',
    text,
    createdAt: new Date(0).toISOString(),
    context,
  };
}

function route(capabilityId = 'diagnostics.modules.list'): MonarchRouteDecision {
  return {
    intentId: 'intent_planner_smoke',
    targetModuleId: capabilityId.split('.')[0] || 'diagnostics',
    capabilityId,
    confidence: 0.9,
    reason: 'smoke',
    permissionMode: 'allow',
    input: {},
  };
}

function capability(id: string, risk: MonarchCapability['risk'] = 'read'): MonarchCapability {
  return {
    id,
    moduleId: id.split('.')[0] || 'diagnostics',
    title: id,
    risk,
  };
}

describe('MonarchPlanner', () => {
  it('keeps simple read tasks out of the structured planning flow', () => {
    const planner = new MonarchPlanner();
    const plan = planner.createPlan(
      intent('покажи статус системы'),
      route('diagnostics.modules.list'),
      capability('diagnostics.modules.list', 'read')
    );

    expect(plan.steps).toHaveLength(1);
    expect(plan.requiresPlanning).toBe(false);
    expect(plan.executionSteps).toEqual([]);
    expect(plan.validationPlan).toEqual([]);
  });

  it('builds an impact map for complex architecture tasks', () => {
    const planner = new MonarchPlanner();
    const plan = planner.createPlan(
      intent('Спроектируй архитектуру router/memory/security/UI integration и проверь риски'),
      route('workspace.files.write'),
      capability('workspace.files.write', 'write')
    );

    expect(plan.requiresPlanning).toBe(true);
    expect(plan.riskLevel).toBe('high');
    expect(plan.affectedModules).toEqual(expect.arrayContaining(['workspace', 'router', 'memory', 'security', 'ui']));
    expect(plan.requiredCapabilities).toEqual(['workspace.files.write']);
    expect(plan.possibleSideEffects?.length).toBeGreaterThan(0);
    expect(plan.validationPlan?.some((item) => item.includes('memory'))).toBe(true);
  });

  it('attaches classified memory references without exposing reasoning traces', () => {
    const planner = new MonarchPlanner();
    const plan = planner.createPlan(
      intent('Обнови architecture planner для memory diagnostics', {
        planningMemory: [{
          id: 'mem_arch',
          type: 'architecture_note',
          title: 'Memory taxonomy decision',
          content: 'Keep project decisions separate from temporary tasks.',
          source: 'memory',
          relevance: 0.8,
        }],
      }),
      route('memory.search'),
      capability('memory.search', 'read')
    );

    expect(plan.requiresPlanning).toBe(true);
    expect(plan.relevantMemory).toHaveLength(1);
    expect(plan.relevantMemory?.[0]).toMatchObject({
      id: 'mem_arch',
      type: 'architecture_note',
      title: 'Memory taxonomy decision',
    });
    expect(JSON.stringify(plan)).not.toMatch(/chain-of-thought|reasoning trace/i);
  });
});
