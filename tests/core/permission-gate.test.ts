import { describe, expect, it } from 'vitest';
import { MonarchPermissionGate } from '../../src/core/permission-gate';
import type { MonarchCapability, MonarchExecutionRequest, MonarchRisk } from '../../src/core/contracts';

describe('MonarchPermissionGate profiles', () => {
  it('matches Codex-like Auto semantics inside the workspace', () => {
    const gate = new MonarchPermissionGate({ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' });

    expect(evaluate(gate, 'read').mode).toBe('allow');
    expect(evaluate(gate, 'write').mode).toBe('allow');
    expect(evaluate(gate, 'network').mode).toBe('confirm');
    expect(evaluate(gate, 'delete').mode).toBe('confirm');
  });

  it('supports read-only escalation and explicit confirmation', () => {
    const gate = new MonarchPermissionGate({ sandboxMode: 'read-only', approvalPolicy: 'on-request' });

    expect(evaluate(gate, 'write').mode).toBe('confirm');
    expect(evaluate(gate, 'write', true).mode).toBe('allow');
    expect(evaluate(gate, 'read').mode).toBe('allow');
  });

  it('allows ordinary execution and network in Full Access but still guards destructive actions', () => {
    const gate = new MonarchPermissionGate({ sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' });

    expect(evaluate(gate, 'execute').mode).toBe('allow');
    expect(evaluate(gate, 'network').mode).toBe('allow');
    expect(evaluate(gate, 'delete').mode).toBe('confirm');
    expect(evaluate(gate, 'security-sensitive').mode).toBe('deny');
  });

  it('fails closed instead of auto-approving when approval policy is never', () => {
    const gate = new MonarchPermissionGate({ sandboxMode: 'read-only', approvalPolicy: 'never' });

    expect(evaluate(gate, 'write')).toMatchObject({ mode: 'deny', requiresUserConfirmation: false });
    expect(evaluate(gate, 'write', true)).toMatchObject({ mode: 'deny', requiresUserConfirmation: false });
  });
});

function evaluate(gate: MonarchPermissionGate, risk: MonarchRisk, confirmed = false) {
  const request: MonarchExecutionRequest = {
    id: 'exec_test',
    intentId: 'intent_test',
    moduleId: 'test',
    capabilityId: `test.${risk}`,
    input: {},
    createdAt: new Date(0).toISOString(),
    requestedBy: 'unit',
    confirmed,
  };
  const capability: MonarchCapability = {
    id: request.capabilityId,
    moduleId: 'test',
    title: 'Test capability',
    risk,
  };
  return gate.evaluate(request, capability);
}
