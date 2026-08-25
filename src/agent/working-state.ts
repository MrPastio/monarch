import type {
  AgentGoal,
  AgentObservation,
  AgentPlan,
  AgentWorkingStateV1,
} from './types';
import { AGENT_WORKING_STATE_SCHEMA_VERSION } from './types';

export function createAgentWorkingState(
  goal: AgentGoal,
  plan: AgentPlan,
  initialObservationIds: readonly string[],
  updatedAt: string,
): AgentWorkingStateV1 {
  return {
    schemaVersion: AGENT_WORKING_STATE_SCHEMA_VERSION,
    revision: 1,
    phase: 'decide',
    ...(plan.steps[0]?.id ? { activeStepId: plan.steps[0].id } : {}),
    goalTargetIds: [
      ...goal.expectedOutputs.filter((entry) => entry.required !== false).map((entry) => `expected-output:${entry.id}`),
      ...goal.successCriteria.map((entry) => `success-criterion:${entry.id}`),
    ].slice(0, 64),
    causalObservationIds: uniqueBounded(initialObservationIds, 64),
    failedActionFingerprints: [],
    updatedAt,
  };
}

export function advanceAgentWorkingState(
  current: AgentWorkingStateV1 | undefined,
  input: {
    phase: AgentWorkingStateV1['phase'];
    activeStepId?: string;
    observation?: AgentObservation;
    actionFingerprint?: string;
    capabilityId?: string;
    error?: string;
    verified?: boolean;
    updatedAt: string;
  },
): AgentWorkingStateV1 | undefined {
  if (!current) return undefined;
  const failed = input.observation && input.observation.status !== 'success';
  const causalObservationIds = input.observation
    ? uniqueBounded([...current.causalObservationIds, input.observation.id], 64)
    : [...current.causalObservationIds];
  const failedActionFingerprints = failed && input.actionFingerprint
    ? uniqueBounded([...current.failedActionFingerprints, input.actionFingerprint], 64)
    : [...current.failedActionFingerprints];
  const next: AgentWorkingStateV1 = {
    ...current,
    revision: current.revision + 1,
    phase: input.phase,
    ...(input.activeStepId ? { activeStepId: input.activeStepId } : {}),
    causalObservationIds,
    failedActionFingerprints,
    updatedAt: input.updatedAt,
  };
  if (failed && input.observation) {
    next.lastFailure = {
      capabilityId: input.capabilityId || input.observation.capabilityId,
      observationId: input.observation.id,
      failureClass: classifyFailure(input.error, input.observation.status),
      retryable: input.observation.retryable,
    };
  } else if (input.verified) {
    delete next.lastFailure;
  }
  return next;
}

export function selectCausalAgentObservations(
  observations: readonly AgentObservation[],
  workingState: AgentWorkingStateV1 | undefined,
  maximum: number,
): AgentObservation[] {
  const limit = Math.max(1, Math.min(64, Math.trunc(maximum)));
  const byId = new Map(observations.map((entry) => [entry.id, entry]));
  const selected = new Map<string, AgentObservation>();
  for (const id of workingState?.causalObservationIds || []) {
    const observation = byId.get(id);
    if (observation) selected.set(observation.id, observation);
  }
  for (const observation of observations.slice(-limit).reverse()) {
    if (selected.size >= limit) break;
    selected.set(observation.id, observation);
  }
  return [...selected.values()]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .slice(-limit);
}

function classifyFailure(
  error: string | undefined,
  status: AgentObservation['status'],
): NonNullable<AgentWorkingStateV1['lastFailure']>['failureClass'] {
  const value = String(error || '').toLocaleLowerCase('en-US');
  if (status === 'cancelled') return 'cancelled';
  if (/(?:runtime|model).*(?:unavailable|starting|stopped|timeout|busy)|connection-refused/u.test(value)) {
    return 'runtime';
  }
  if (/(?:permission|approval|denied|forbidden|confirmation)/u.test(value)) return 'permission';
  if (/verif/u.test(value)) return 'verification';
  if (value) return 'tool';
  return 'unknown';
}

function uniqueBounded(values: readonly string[], maximum: number): string[] {
  return [...new Set(values.map((entry) => String(entry || '').trim()).filter(Boolean))].slice(-maximum);
}
