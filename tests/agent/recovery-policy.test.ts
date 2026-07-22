import { describe, expect, it } from 'vitest';
import { legacyAgentCapabilityDefaults } from '../../src/core/capability-metadata';
import { decideAgentRecovery } from '../../src/agent/recovery-policy';

describe('agent recovery policy', () => {
  it('replans after mutating tool failure instead of blindly repeating it', () => {
    expect(decideAgentRecovery({
      ok: false, verified: false, error: 'not-found', retryable: true,
      attemptsForAction: 1, totalFailures: 1, maxFailures: 5,
      capability: legacyAgentCapabilityDefaults('write'),
    })).toMatchObject({ action: 'replan', mayRepeatSameAction: false });
  });

  it('allows only one bounded retry for an idempotent read', () => {
    expect(decideAgentRecovery({
      ok: false, verified: false, error: 'transient', retryable: true,
      attemptsForAction: 1, totalFailures: 1, maxFailures: 5,
      capability: legacyAgentCapabilityDefaults('read'),
    })).toMatchObject({ action: 'retry', mayRepeatSameAction: true });
    expect(decideAgentRecovery({
      ok: false, verified: false, error: 'transient', retryable: true,
      attemptsForAction: 2, totalFailures: 2, maxFailures: 5,
      capability: legacyAgentCapabilityDefaults('read'),
    })).toMatchObject({ action: 'replan', mayRepeatSameAction: false });
  });
});
