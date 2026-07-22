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
  const newSteps: AgentPlanStep[] = decision.steps.map((step, index) => ({
    id: createMonarchId('agent_step'),
    title: bounded(step.title, 500),
    status: index === 0 ? 'ready' : 'proposed',
    dependsOn: index === 0 ? [] : [decision.steps[index - 1]?.title || 'previous-step'],
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
