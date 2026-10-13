import { describe, expect, it } from 'vitest';
import { createRuntimeRecoveryPolicy, RUNTIME_RECOVERY_DELAYS_MS, RUNTIME_STABLE_MS } from '../../desktop/electron/runtime-recovery-policy.mjs';

describe('runtime recovery policy', () => {
  it('keeps restarting a crash loop with growing waits instead of giving up', () => {
    let clock = 0;
    const policy = createRuntimeRecoveryPolicy({ now: () => clock });
    const delays = Array.from({ length: 9 }, () => { const delay = policy.nextDelay(); clock += delay + 500; return delay; });
    expect(delays).toEqual([250, 1_000, 3_000, 10_000, 30_000, 60_000, 60_000, 60_000, 60_000]);
    expect(policy.attempts).toBe(9);
  });

  it('starts over once a recovered runtime stayed up', () => {
    let clock = 0;
    const policy = createRuntimeRecoveryPolicy({ now: () => clock });
    policy.nextDelay(); policy.nextDelay(); policy.healthy();
    clock += RUNTIME_STABLE_MS - 1;
    expect(policy.nextDelay()).toBe(RUNTIME_RECOVERY_DELAYS_MS[2]);
    policy.healthy(); clock += RUNTIME_STABLE_MS;
    expect(policy.nextDelay()).toBe(RUNTIME_RECOVERY_DELAYS_MS[0]);
  });
});
