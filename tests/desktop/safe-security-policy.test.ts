import { describe, expect, it } from 'vitest';
import {
  SAFE_SECURITY_POLICY_DEFAULTS,
  assessSafeSecurityPolicy,
  normalizeSafeSecurityPolicy,
} from '../../desktop/safe/security-policy.mjs';

describe('Monarch Safe security policy', () => {
  it('defaults to a closed, clipboard-blocked, five-minute session', () => {
    expect(normalizeSafeSecurityPolicy(null)).toEqual(SAFE_SECURITY_POLICY_DEFAULTS);
    expect(assessSafeSecurityPolicy(null)).toMatchObject({ level: 'strong', warnings: [] });
  });

  it('normalizes unsupported values without weakening the policy', () => {
    expect(normalizeSafeSecurityPolicy({
      autoLockMs: 123,
      clipboardMode: 'anything',
      minimizeAction: 'ignore',
      lockOnBlur: 'yes',
      clearClipboardOnLock: null,
    })).toEqual({
      ...SAFE_SECURITY_POLICY_DEFAULTS,
      lockOnBlur: false,
      clearClipboardOnLock: false,
    });
  });

  it('marks explicit egress and persistent unlocked sessions as low security', () => {
    const assessment = assessSafeSecurityPolicy({
      autoLockMs: 0,
      clipboardMode: 'read-write',
      minimizeAction: 'keep-unlocked',
      lockOnBlur: false,
      clearClipboardOnLock: false,
    });
    expect(assessment.level).toBe('low');
    expect(assessment.warnings.length).toBeGreaterThanOrEqual(4);
  });
});
