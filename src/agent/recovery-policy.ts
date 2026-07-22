import type { MonarchResolvedAgentCapabilityMetadata } from '../core/contracts';

export type AgentRecoveryAction = 'continue' | 'retry' | 'replan' | 'wait-runtime' | 'fail';

export interface AgentRecoveryPolicyInput {
  ok: boolean;
  verified: boolean;
  error?: string;
  retryable?: boolean;
  attemptsForAction: number;
  totalFailures: number;
  maxFailures: number;
  capability: MonarchResolvedAgentCapabilityMetadata;
}

export interface AgentRecoveryPolicyDecision {
  action: AgentRecoveryAction;
  reason: string;
  mayRepeatSameAction: boolean;
}

export function decideAgentRecovery(input: AgentRecoveryPolicyInput): AgentRecoveryPolicyDecision {
  if (input.ok && input.verified) {
    return { action: 'continue', reason: 'Tool result and required effects were verified.', mayRepeatSameAction: false };
  }
  if (input.totalFailures >= input.maxFailures) {
    return { action: 'fail', reason: 'Task failure budget is exhausted.', mayRepeatSameAction: false };
  }
  if (isRuntimeError(input.error)) {
    return { action: 'wait-runtime', reason: 'Required runtime is temporarily unavailable.', mayRepeatSameAction: false };
  }

  const repeatSafe = input.capability.idempotency === 'idempotent'
    && input.capability.effectProfile.mutation === 'none';
  if (input.retryable === true && repeatSafe && input.attemptsForAction < 2) {
    return { action: 'retry', reason: 'A bounded retry is safe for this idempotent observation.', mayRepeatSameAction: true };
  }
  return {
    action: 'replan',
    reason: input.ok
      ? 'The action returned but required effects were not verified; choose a different plan.'
      : 'The tool failed; expose the observation and choose an alternative capability or input.',
    mayRepeatSameAction: false,
  };
}

function isRuntimeError(error: string | undefined): boolean {
  return /(?:runtime|model).*(?:unavailable|starting|stopped|timeout)|connection-refused/i.test(error || '');
}
