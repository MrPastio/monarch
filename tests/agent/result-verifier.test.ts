import { describe, expect, it } from 'vitest';
import {
  evaluateVerificationAssertion,
  verifyAgentCompletion,
  type AgentVerificationRecord,
} from '../../src/agent/result-verifier';

describe('agent result verifier', () => {
  it('blocks completion without explicit output and mutating-action verification', () => {
    const result = verifyAgentCompletion({
      expectedOutputs: [{ id: 'report', description: 'Markdown report' }],
      actions: [{
        actionAttemptId: 'write-1',
        capabilityId: 'workspace.files.write',
        mutation: 'persistent',
        executionStatus: 'success',
      }],
      verifications: [],
    });
    expect(result).toMatchObject({ complete: false, status: 'incomplete' });
    expect(result.missing).toEqual(expect.arrayContaining([
      'expected-output:report',
      'action:write-1',
    ]));
  });

  it('rejects semantic-only mutation approval and accepts deterministic evidence', () => {
    const base: AgentVerificationRecord[] = [{
      id: 'verify-output',
      targetType: 'expected-output',
      targetId: 'report',
      status: 'verified',
      method: 'follow-up-read',
      summary: 'Report exists.',
      evidenceIds: ['evidence-output'],
    }];
    const action = {
      actionAttemptId: 'write-1',
      capabilityId: 'workspace.files.write',
      mutation: 'persistent' as const,
      executionStatus: 'success' as const,
    };
    expect(verifyAgentCompletion({
      expectedOutputs: [{ id: 'report', description: 'Markdown report' }],
      actions: [action],
      verifications: [...base, {
        id: 'verify-action-semantic',
        targetType: 'action',
        targetId: 'write-1',
        status: 'verified',
        method: 'model-semantic',
        summary: 'Model assumes write worked.',
        evidenceIds: ['model-opinion'],
      }],
    }).complete).toBe(false);

    expect(verifyAgentCompletion({
      expectedOutputs: [{ id: 'report', description: 'Markdown report' }],
      actions: [action],
      verifications: [...base, {
        id: 'verify-action',
        targetType: 'action',
        targetId: 'write-1',
        status: 'verified',
        method: 'deterministic',
        summary: 'Read-after-write hash matched.',
        evidenceIds: ['evidence-action'],
      }],
    })).toMatchObject({ complete: true, status: 'verified' });
  });

  it('treats failed or partial results as non-terminal success', () => {
    expect(verifyAgentCompletion({
      expectedOutputs: [{ id: 'report', description: 'Markdown report' }],
      verifications: [{
        id: 'failed-output',
        targetType: 'expected-output',
        targetId: 'report',
        status: 'failed',
        method: 'deterministic',
        summary: 'File missing.',
        evidenceIds: ['missing-file'],
      }],
    })).toMatchObject({ complete: false, status: 'failed' });

    expect(evaluateVerificationAssertion(
      { kind: 'contains', expected: 'Required heading' },
      '# Report\nRequired heading',
    )).toMatchObject({ verified: true });
  });

  it('allows a later deterministic re-verification to replace an earlier failure', () => {
    expect(verifyAgentCompletion({
      expectedOutputs: [{ id: 'report', description: 'Markdown report' }],
      verifications: [{
        id: 'first-check',
        targetType: 'expected-output',
        targetId: 'report',
        status: 'failed',
        method: 'deterministic',
        summary: 'File was initially missing.',
        evidenceIds: ['first-read'],
      }, {
        id: 'second-check',
        targetType: 'expected-output',
        targetId: 'report',
        status: 'verified',
        method: 'follow-up-read',
        summary: 'File now exists.',
        evidenceIds: ['second-read'],
      }],
    })).toMatchObject({ complete: true, status: 'verified' });
  });
});
