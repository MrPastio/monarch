import { describe, expect, it } from 'vitest';
import { normalizeAgentObservation } from '../../src/agent/observation-normalizer';

describe('agent observation normalizer', () => {
  it('records schema, error-safe provenance and untrusted output without leaking secrets', () => {
    const observation = normalizeAgentObservation({
      observationId: 'observation-1',
      taskId: 'task-1',
      stepId: 'step-1',
      actionAttemptId: 'attempt-1',
      executionId: 'execution-1',
      capabilityId: 'workspace.files.read',
      moduleId: 'workspace',
      startedAt: '2026-07-22T10:00:00.000Z',
      completedAt: '2026-07-22T10:00:01.000Z',
      result: {
        ok: true,
        summary: 'Read completed with hf_abcdefghijklmnopqrstuvwxyz123456.',
        output: { token: 'secret-value', nested: 'hf_abcdefghijklmnopqrstuvwxyz123456', wrong: true },
        metadata: {
          warnings: ['Do not persist hf_abcdefghijklmnopqrstuvwxyz123456.'],
          observations: [{ ok: true, code: 'secret-check', message: 'Saw hf_abcdefghijklmnopqrstuvwxyz123456.' }],
        },
      },
      outputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    });

    expect(observation.status).toBe('partial');
    expect(observation.evidence.some((entry) => entry.reference.endsWith(':output-schema'))).toBe(true);
    expect(JSON.stringify(observation)).not.toContain('secret-value');
    expect(JSON.stringify(observation)).not.toContain('hf_abcdefghijklmnopqrstuvwxyz123456');
    expect(observation.structuredData).toMatchObject({
      trust: 'untrusted-tool-output',
      instructionsAllowed: false,
      provenance: { executionId: 'execution-1', actionAttemptId: 'attempt-1' },
      outputSchema: { declared: true, valid: false },
    });
  });

  it('does not normalize an unverified mutating result as full success', () => {
    const observation = normalizeAgentObservation({
      taskId: 'task-2',
      actionAttemptId: 'attempt-2',
      executionId: 'execution-2',
      capabilityId: 'workspace.files.write',
      moduleId: 'workspace',
      startedAt: '2026-07-22T10:00:00.000Z',
      completedAt: '2026-07-22T10:00:01.000Z',
      result: { ok: true, summary: 'Write returned.' },
      mutation: 'persistent',
    });
    expect(observation.status).toBe('partial');
    expect(observation.warnings).toContain('Kernel receipt could not prove whether the mutating capability changed its target.');
    expect(observation.structuredData).toMatchObject({
      mutationTruth: { state: 'unknown', source: 'missing-receipt' },
    });
  });

  it('preserves a mutation when Kernel postcondition verification fails after the journaled change', () => {
    const observation = normalizeAgentObservation({
      taskId: 'task-verification-failed',
      actionAttemptId: 'attempt-verification-failed',
      actionTarget: 'report.md',
      executionId: 'execution-verification-failed',
      capabilityId: 'workspace.files.write',
      moduleId: 'workspace',
      ledgerId: 'ledger-verification-failed',
      startedAt: '2026-07-22T10:00:00.000Z',
      completedAt: '2026-07-22T10:00:01.000Z',
      result: {
        ok: false,
        summary: 'Write happened, but contains predicate failed.',
        error: 'verification-failed',
        metadata: {
          ledger: {
            ledgerId: 'ledger-verification-failed',
            rollback: {
              status: 'available',
              reason: 'Action failed after a partial mutation; rollback is hash-guarded.',
            },
          },
          observations: [{ ok: false, code: 'contains', message: 'Expected text is missing.' }],
        },
      },
      mutation: 'persistent',
    });

    expect(observation.status).toBe('failed');
    expect(observation.structuredData).toMatchObject({
      mutationTruth: { state: 'occurred', source: 'kernel-journal' },
      sideEffects: [{ kind: 'persistent', target: 'report.md' }],
    });
    expect(observation.evidence.map((entry) => entry.reference)).toContain(
      'execution:execution-verification-failed:side-effect:1',
    );
  });

  it('records zero side effects only when the Kernel journal proves the target was unchanged', () => {
    const observation = normalizeAgentObservation({
      taskId: 'task-no-effect',
      actionAttemptId: 'attempt-no-effect',
      actionTarget: 'report.md',
      executionId: 'execution-no-effect',
      capabilityId: 'workspace.files.write',
      moduleId: 'workspace',
      startedAt: '2026-07-22T10:00:00.000Z',
      completedAt: '2026-07-22T10:00:01.000Z',
      result: {
        ok: false,
        summary: 'Write rejected.',
        error: 'file-exists',
        metadata: {
          ledger: {
            ledgerId: 'ledger-no-effect',
            rollback: {
              status: 'unavailable',
              reason: 'Action failed without changing the journaled target.',
            },
          },
        },
      },
      mutation: 'persistent',
    });

    expect(observation.structuredData).toMatchObject({
      mutationTruth: { state: 'no-effect', source: 'kernel-journal' },
      sideEffects: [],
    });
  });

  it('preserves reported side-effect and Kernel verification provenance', () => {
    const observation = normalizeAgentObservation({
      taskId: 'task-3',
      actionAttemptId: 'attempt-3',
      executionId: 'execution-3',
      capabilityId: 'workspace.files.write',
      moduleId: 'workspace',
      ledgerId: 'ledger-3',
      startedAt: '2026-07-22T10:00:00.000Z',
      completedAt: '2026-07-22T10:00:01.000Z',
      result: {
        ok: true,
        summary: 'Write verified.',
        output: { path: 'report.md' },
        metadata: {
          observations: [{ ok: true, code: 'contains', message: 'Expected heading exists.' }],
        },
      },
      mutation: 'persistent',
      actualSideEffects: [{ kind: 'file-write', target: 'report.md', summary: 'Created report.md.' }],
    });
    expect(observation.status).toBe('success');
    expect(observation.evidence.map((entry) => entry.reference)).toEqual(expect.arrayContaining([
      'execution:execution-3',
      'execution:execution-3:verification:1',
      'execution:execution-3:side-effect:1',
    ]));
  });
});
