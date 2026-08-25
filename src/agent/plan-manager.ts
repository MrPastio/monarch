import { createMonarchId, nowIso } from '../core/utils';
import type { AgentPlan, AgentPlanStep, AgentVerificationResult } from './types';
import type { AgentRevisePlanDecision } from './decision-schema';

export function createInitialAgentPlan(goalSummary: string, createdAt = nowIso()): AgentPlan {
  return {
    id: createMonarchId('agent_plan'),
    revision: 1,
    goalSummary: bounded(goalSummary, 4_000),
    createdAt,
    steps: [{
      id: createMonarchId('agent_step'),
      title: 'Choose the next evidence-producing action.',
      status: 'ready',
      dependsOn: [],
      expectedEffects: [{ kind: 'other', description: 'Make verified progress toward the task goal.' }],
      verification: [{ kind: 'other', description: 'Record a factual observation with provenance.' }],
      attemptCount: 0,
    }],
  };
}

export function reviseAgentPlan(
  current: AgentPlan,
  decision: AgentRevisePlanDecision,
  revisedAt = nowIso(),
): AgentPlan {
  const preserved = current.steps.map((step) => (
    step.status === 'completed' || step.status === 'skipped'
      ? { ...step, dependsOn: [...step.dependsOn] }
      : { ...step, status: 'skipped' as const, dependsOn: [...step.dependsOn], completedAt: revisedAt }
  ));
  const stepIds = decision.steps.map(() => createMonarchId('agent_step'));
  const newSteps: AgentPlanStep[] = decision.steps.map((step, index) => ({
    id: stepIds[index]!,
    title: bounded(step.title, 500),
    status: index === 0 ? 'ready' : 'proposed',
    // Dependencies are durable runtime identifiers. Human plan titles may
    // contain spaces/punctuation and must never cross the identifier boundary.
    dependsOn: index === 0 ? [] : [stepIds[index - 1]!],
    expectedEffects: [{ kind: 'other', description: bounded(step.expectedEffect, 1_000) }],
    verification: [{ kind: 'other', description: 'Require evidence matching the expected effect.' }],
    attemptCount: 0,
  }));
  return {
    ...current,
    revision: current.revision + 1,
    goalSummary: bounded(decision.summary, 2_000),
    steps: [...preserved, ...newSteps],
    revisedAt,
  };
}

export function startAgentPlanStep(
  plan: AgentPlan,
  stepId: string,
  capabilityId: string,
  startedAt = nowIso(),
): AgentPlan {
  return updateStep(plan, stepId, (step) => ({
    ...step,
    status: 'running',
    selectedCapabilityId: capabilityId,
    attemptCount: (step.attemptCount || 0) + 1,
    startedAt,
  }));
}

export function settleAgentPlanStep(
  plan: AgentPlan,
  stepId: string,
  verificationResult: AgentVerificationResult,
  completedAt = nowIso(),
): AgentPlan {
  const settled = updateStep(plan, stepId, (step) => ({
    ...step,
    status: verificationResult.status === 'verified' ? 'completed' : 'failed',
    verificationResult,
    completedAt,
  }));
  const firstReadyIndex = settled.steps.findIndex((step) => step.status === 'proposed'
    && step.dependsOn.every((dependency) => dependencySatisfied(settled, dependency)));
  if (firstReadyIndex < 0) return settled;
  return {
    ...settled,
    steps: settled.steps.map((step, index) => index === firstReadyIndex ? { ...step, status: 'ready' } : step),
  };
}

/**
 * A model-authored plan is guidance, not a second source of truth. Once the
 * runtime has independently verified every required goal target, unfinished
 * descriptive steps must not force the same effectful action to run again.
 * Preserve the audit trail by skipping those redundant steps explicitly.
 */
export function reconcileAgentPlanAfterVerifiedGoal(
  plan: AgentPlan,
  completedAt = nowIso(),
): AgentPlan {
  const unfinished = plan.steps.filter((step) => !isSettled(step));
  if (unfinished.length === 0) return plan;
  const unfinishedIds = new Set(unfinished.map((step) => step.id));
  return {
    ...plan,
    revision: plan.revision + 1,
    revisedAt: completedAt,
    steps: plan.steps.map((step) => unfinishedIds.has(step.id) ? {
      ...step,
      status: 'skipped' as const,
      completedAt,
      verificationResult: {
        status: 'not-run' as const,
        summary: 'Skipped because Kernel evidence already verified the complete requested goal.',
        verifiedAt: completedAt,
      },
    } : { ...step, dependsOn: [...step.dependsOn] }),
  };
}

export function currentAgentPlanStep(plan: AgentPlan | undefined, preferredId?: string): AgentPlanStep | null {
  if (!plan) return null;
  if (preferredId) {
    const preferred = plan.steps.find((step) => step.id === preferredId);
    if (preferred && !isSettled(preferred)) return preferred;
  }
  return plan.steps.find((step) => step.status === 'ready' || step.status === 'running')
    || plan.steps.find((step) => !isSettled(step))
    || null;
}

function updateStep(plan: AgentPlan, stepId: string, update: (step: AgentPlanStep) => AgentPlanStep): AgentPlan {
  let found = false;
  const steps = plan.steps.map((step) => {
    if (step.id !== stepId) return step;
    found = true;
    return update({ ...step, dependsOn: [...step.dependsOn] });
  });
  if (!found) throw new Error(`Agent plan step not found: ${stepId}`);
  return { ...plan, steps };
}

function dependencySatisfied(plan: AgentPlan, dependency: string): boolean {
  return plan.steps.some((step) => (step.id === dependency || step.title === dependency) && step.status === 'completed');
}

function isSettled(step: AgentPlanStep): boolean {
  return step.status === 'completed' || step.status === 'failed' || step.status === 'skipped';
}

function bounded(value: string, maxChars: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  if (!normalized) throw new Error('Agent plan text is required.');
  return normalized;
}
