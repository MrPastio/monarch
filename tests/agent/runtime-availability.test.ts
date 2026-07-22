import { describe, expect, it } from 'vitest';
import {
  evaluateRequiredRuntimes,
  evaluateRuntimeAvailability,
} from '../../src/agent/runtime-availability';

describe('agent runtime availability', () => {
  it('keeps a ready degraded runtime usable with an explicit warning', () => {
    expect(evaluateRuntimeAvailability({
      runtimeId: 'oscar',
      state: 'degraded',
      ready: true,
      health: 'degraded',
      message: 'CPU fallback is active.',
    })).toMatchObject({
      usable: true,
      outcome: 'usable-with-warning',
      warnings: ['CPU fallback is active.'],
    });
  });

  it('does not confuse starting or stopped health with readiness', () => {
    expect(evaluateRuntimeAvailability({
      runtimeId: 'model',
      state: 'starting',
      ready: false,
      health: 'healthy',
    })).toMatchObject({ usable: false, retryable: true, outcome: 'wait' });
    expect(evaluateRuntimeAvailability({
      runtimeId: 'model',
      state: 'stopped',
      ready: false,
      health: 'unknown',
      canStart: true,
    })).toMatchObject({ usable: false, canAttemptStart: true, outcome: 'start-required' });
    expect(evaluateRuntimeAvailability({
      runtimeId: 'running-not-ready',
      state: 'running',
      ready: false,
      health: 'degraded',
    })).toMatchObject({ usable: false, retryable: true, outcome: 'wait' });
  });

  it('reports the exact unavailable runtime in a required set', () => {
    const result = evaluateRequiredRuntimes([
      { runtimeId: 'ready', state: 'running', ready: true, health: 'healthy' },
      { runtimeId: 'missing', state: 'unavailable', ready: false, health: 'unknown' },
    ]);
    expect(result.usable).toBe(false);
    expect(result.unavailableRuntimeIds).toEqual(['missing']);
    expect(result.reason).toContain('missing');
  });
});
