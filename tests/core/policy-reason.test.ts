import { describe, expect, it } from 'vitest';
import { policyReasonKind } from '../../src/core/policy-reason';

describe('policy reason kind', () => {
  it('names the rule recorded last before the stop', () => {
    expect(policyReasonKind([
      { source: 'runtime', code: 'proposal.typed.canonicalized', severity: 'info' },
      { source: 'permission', code: 'permission.confirm', severity: 'warn' },
    ])).toBe('mode');
    expect(policyReasonKind([
      { source: 'permission', code: 'permission.confirm', severity: 'warn' },
      { source: 'security', code: 'delete.large-scope', severity: 'warn' },
    ])).toBe('security');
  });
  it('distinguishes the always-confirm Security policy, irreversible actions and commands', () => {
    expect(policyReasonKind([{ source: 'security', code: 'model-policy.confirmation-required', severity: 'warn' }])).toBe('security-confirm-all');
    expect(policyReasonKind([{ source: 'runtime', code: 'risk.irreversible.confirmation-required', severity: 'warn' }])).toBe('irreversible');
    expect(policyReasonKind([{ source: 'security', code: 'shell.exact-action-card.required', severity: 'warn' }])).toBe('command');
    expect(policyReasonKind([{ source: 'lease', code: 'lease-intent-missing', severity: 'warn' }])).toBe('intent');
  });
  it('falls back to a generic rule when nothing warned', () => {
    expect(policyReasonKind([{ source: 'runtime', code: 'x', severity: 'info' }])).toBe('policy');
    expect(policyReasonKind(undefined)).toBe('policy');
  });
});
