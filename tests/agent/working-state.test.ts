import { describe, expect, it } from 'vitest';
import {
  advanceAgentWorkingState,
  createAgentWorkingState,
  selectCausalAgentObservations,
} from '../../src/agent/working-state';
import {
  AGENT_OBSERVATION_SCHEMA_VERSION,
  type AgentGoal,
  type AgentObservation,
  type AgentPlan,
} from '../../src/agent/types';

const timestamp = '2026-07-22T10:00:00.000Z';

describe('agent working state', () => {
  it('persists bounded causal targets and a classified failed-action fingerprint', () => {
    const state = createAgentWorkingState(goal(), plan(), ['observation-root'], timestamp);
    const failure = observation('observation-failure', 'failed', true);
    const recovered = advanceAgentWorkingState(state, {
      phase: 'recover',
      activeStepId: 'step-read',
      observation: failure,
      actionFingerprint: 'sha256:failed-action',
      capabilityId: 'workspace.files.read',
      error: 'model runtime unavailable: connection-refused',
      updatedAt: '2026-07-22T10:00:01.000Z',
    });

    expect(recovered).toMatchObject({
      revision: 2,
      phase: 'recover',
      activeStepId: 'step-read',
      goalTargetIds: ['expected-output:answer', 'success-criterion:grounded'],
      causalObservationIds: ['observation-root', 'observation-failure'],
      failedActionFingerprints: ['sha256:failed-action'],
      lastFailure: {
        capabilityId: 'workspace.files.read',
        observationId: 'observation-failure',
        failureClass: 'runtime',
        retryable: true,
      },
    });

    const verified = advanceAgentWorkingState(recovered, {
      phase: 'verify',
      observation: observation('observation-recovered', 'success', false),
      verified: true,
      updatedAt: '2026-07-22T10:00:02.000Z',
    });
    expect(verified?.lastFailure).toBeUndefined();
    expect(verified?.failedActionFingerprints).toEqual(['sha256:failed-action']);
  });

  it('keeps an explicitly causal old fact while filling the remaining window with fresh facts', () => {
    const observations = Array.from({ length: 30 }, (_, index) => observation(
      `observation-${String(index).padStart(2, '0')}`,
      'success',
      false,
      index,
    ));
    const state = createAgentWorkingState(goal(), plan(), ['observation-01'], timestamp);
    const selected = selectCausalAgentObservations(observations, state, 10);

    expect(selected).toHaveLength(10);
    expect(selected.map((entry) => entry.id)).toContain('observation-01');
    expect(selected.map((entry) => entry.id)).toContain('observation-29');
  });
});

function goal(): AgentGoal {
  return {
    originalRequest: 'Read the synthetic workspace and answer.',
    normalizedObjective: 'Read the synthetic workspace and answer.',
    expectedOutputs: [{ id: 'answer', description: 'Grounded answer', required: true }],
    constraints: [],
    successCriteria: [{ id: 'grounded', description: 'Kernel evidence exists' }],
  };
}

function plan(): AgentPlan {
  return {
    revision: 1,
    rationale: 'fixture',
    steps: [{
      id: 'step-read',
      title: 'Read',
      description: 'Read synthetic data.',
      status: 'pending',
      required: true,
      dependsOn: [],
      expectedEvidence: [],
      allowedCapabilities: [],
      attemptCount: 0,
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function observation(
  id: string,
  status: AgentObservation['status'],
  retryable: boolean,
  second = 0,
): AgentObservation {
  return {
    schemaVersion: AGENT_OBSERVATION_SCHEMA_VERSION,
    id,
    taskId: 'task-working-state',
    capabilityId: 'workspace.files.read',
    status,
    summary: id,
    evidence: [],
    artifacts: [],
    warnings: [],
    retryable,
    occurredAt: `2026-07-22T10:00:${String(second).padStart(2, '0')}.000Z`,
  };
}
