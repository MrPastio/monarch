import { describe, expect, it } from 'vitest';
import { MonarchPermissionGate, PERMISSION_MATRIX_RISKS, permissionMatrix } from '../../src/core/permission-gate';
import type { MonarchCapability, MonarchExecutionRequest } from '../../src/core/contracts';

describe('permission matrix', () => {
  it('matches the gate decision for every autonomy mode and shown risk', () => {
    for (const approvalPolicy of ['on-request', 'never'] as const) {
      for (const row of permissionMatrix(approvalPolicy)) {
        const gate = new MonarchPermissionGate({ sandboxMode: row.sandboxMode, approvalPolicy, autonomyMode: row.autonomyMode });
        for (const cell of row.cells) {
          const capability = { id: 'fixture.' + cell.risk, moduleId: 'fixture', risk: cell.risk } as MonarchCapability;
          const request = { moduleId: 'fixture', capabilityId: capability.id, input: {}, source: 'ui', requestedBy: 'user' } as unknown as MonarchExecutionRequest;
          expect(gate.evaluate(request, capability).mode, `${row.autonomyMode}/${cell.risk}/${approvalPolicy}`).toBe(cell.mode);
        }
      }
    }
  });

  it('covers the actions the Access page names and never allows money', () => {
    const rows = permissionMatrix();
    expect(rows.map(row => row.autonomyMode)).toEqual(['guided', 'workspace-autonomous', 'full-local']);
    for (const row of rows) {
      expect(row.cells.map(cell => cell.risk)).toEqual([...PERMISSION_MATRIX_RISKS]);
      expect(row.cells.find(cell => cell.risk === 'money')?.mode).toBe('deny');
    }
  });
});
