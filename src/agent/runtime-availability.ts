import type { MonarchAgentRuntimeState } from '../core/contracts';

export type AgentRuntimeHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface AgentRuntimeAvailabilitySnapshot {
  runtimeId: string;
  state: MonarchAgentRuntimeState;
  ready: boolean;
  health: AgentRuntimeHealth;
  canStart?: boolean;
  message?: string;
  checkedAt?: string;
}

export type AgentRuntimeAvailabilityOutcome =
  | 'usable'
  | 'usable-with-warning'
  | 'wait'
  | 'start-required'
  | 'unavailable';

export interface AgentRuntimeAvailabilityDecision {
  runtimeId: string;
  state: MonarchAgentRuntimeState;
  ready: boolean;
  usable: boolean;
  retryable: boolean;
  canAttemptStart: boolean;
  outcome: AgentRuntimeAvailabilityOutcome;
  reason: string;
  warnings: string[];
}

export interface AgentRuntimeSetDecision {
  usable: boolean;
  reason: string;
  decisions: AgentRuntimeAvailabilityDecision[];
  unavailableRuntimeIds: string[];
  warnings: string[];
}

export function evaluateRuntimeAvailability(
  snapshot: AgentRuntimeAvailabilitySnapshot,
): AgentRuntimeAvailabilityDecision {
  const runtimeId = String(snapshot.runtimeId || '').trim() || 'unknown-runtime';
  const state = snapshot.state;
  const warning = conciseMessage(snapshot.message);

  if (snapshot.ready && (state === 'running' || state === 'degraded')) {
    if (snapshot.health === 'unhealthy') {
      return decision(runtimeId, state, snapshot.ready, {
        usable: false,
        retryable: true,
        canAttemptStart: false,
        outcome: 'wait',
        reason: 'Runtime reports readiness but its health is unsafe for new work.',
        warnings: compactWarnings([warning || 'Runtime health is unhealthy.']),
      });
    }

    const degraded = state === 'degraded' || snapshot.health === 'degraded';
    return decision(runtimeId, state, snapshot.ready, {
      usable: true,
      retryable: false,
      canAttemptStart: false,
      outcome: degraded ? 'usable-with-warning' : 'usable',
      reason: degraded
        ? 'Runtime is ready and usable in degraded mode.'
        : 'Runtime is ready.',
      warnings: degraded
        ? compactWarnings([warning || 'Runtime is degraded; results may be slower or reduced.'])
        : compactWarnings([warning]),
    });
  }

  if (state === 'running' || state === 'degraded') {
    return decision(runtimeId, state, snapshot.ready, {
      usable: false,
      retryable: true,
      canAttemptStart: false,
      outcome: 'wait',
      reason: 'Runtime process exists but has not reached readiness.',
      warnings: compactWarnings([
        warning || (state === 'degraded' ? 'Runtime is degraded and not ready.' : ''),
      ]),
    });
  }

  if (state === 'starting' || state === 'stopping') {
    return decision(runtimeId, state, snapshot.ready, {
      usable: false,
      retryable: true,
      canAttemptStart: false,
      outcome: 'wait',
      reason: state === 'starting' ? 'Runtime is starting but not ready.' : 'Runtime is stopping.',
      warnings: compactWarnings([warning]),
    });
  }

  if (state === 'configured' || state === 'reachable' || state === 'stopped') {
    const canAttemptStart = snapshot.canStart === true;
    return decision(runtimeId, state, snapshot.ready, {
      usable: false,
      retryable: canAttemptStart,
      canAttemptStart,
      outcome: canAttemptStart ? 'start-required' : 'unavailable',
      reason: canAttemptStart
        ? 'Runtime is known but must be started and reach readiness.'
        : 'Runtime is not ready and cannot be started by the agent.',
      warnings: compactWarnings([warning]),
    });
  }

  return decision(runtimeId, state, snapshot.ready, {
    usable: false,
    retryable: false,
    canAttemptStart: false,
    outcome: 'unavailable',
    reason: state === 'registered'
      ? 'Runtime is registered but not configured.'
      : 'Runtime is unavailable.',
    warnings: compactWarnings([warning]),
  });
}

export function evaluateRequiredRuntimes(
  snapshots: AgentRuntimeAvailabilitySnapshot[],
): AgentRuntimeSetDecision {
  const decisions = snapshots.map(evaluateRuntimeAvailability);
  const unavailable = decisions.filter((entry) => !entry.usable);
  return {
    usable: unavailable.length === 0,
    reason: unavailable.length === 0
      ? 'All required runtimes are usable.'
      : unavailable.map((entry) => entry.runtimeId + ': ' + entry.reason).join(' '),
    decisions,
    unavailableRuntimeIds: unavailable.map((entry) => entry.runtimeId),
    warnings: [...new Set(decisions.flatMap((entry) => entry.warnings))],
  };
}

function decision(
  runtimeId: string,
  state: MonarchAgentRuntimeState,
  ready: boolean,
  detail: Omit<AgentRuntimeAvailabilityDecision, 'runtimeId' | 'state' | 'ready'>,
): AgentRuntimeAvailabilityDecision {
  return { runtimeId, state, ready, ...detail };
}

function conciseMessage(value: string | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function compactWarnings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
