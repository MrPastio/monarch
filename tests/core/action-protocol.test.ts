import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { normalizeActionProposal, MonarchActionProtocolError } from '../../src/core/action-protocol';
import type { MonarchActionPredicate, MonarchCapability } from '../../src/core/contracts';

const workspaceWrite: MonarchCapability = {
  id: 'workspace.files.write',
  moduleId: 'workspace',
  title: 'Write file',
  description: 'Writes a workspace file.',
  risk: 'write',
};

describe('Action Protocol v1', () => {
  it('canonicalizes typed model proposals and binds them to the user intent', () => {
    const proposal = normalizeActionProposal({
      proposalId: 'proposal_unit',
      capabilityId: workspaceWrite.id,
      args: { content: 'hello', path: 'notes/unit.txt' },
      reason: 'Create the requested note.',
      provenance: { model: 'unit-model', source: 'model-tool-call' },
    }, {
      capability: workspaceWrite,
      workspaceRoot: 'E:\\Monarch',
      intentId: 'intent_unit',
      originatingUserText: 'Создай заметку',
    });

    expect(proposal).toMatchObject({
      version: 1,
      proposalId: 'proposal_unit',
      intentId: 'intent_unit',
      capabilityId: 'workspace.files.write',
      reversibility: 'reversible',
      riskVector: { effect: 'write', externality: 'local', privilege: 'user' },
      provenance: { model: 'unit-model', source: 'model-tool-call' },
    });
    expect(proposal.scope.paths).toEqual([path.resolve('E:\\Monarch', 'notes/unit.txt')]);
    expect(proposal.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.idempotencyKey).toMatch(/^action:[a-f0-9]{64}$/);
    expect(proposal.intentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects prototype-bearing and non-JSON arguments before policy evaluation', () => {
    const args = JSON.parse('{"path":"ok.txt","__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(() => normalizeActionProposal({ capabilityId: workspaceWrite.id, args }, {
      capability: workspaceWrite,
      workspaceRoot: 'E:\\Monarch',
    })).toThrowError(MonarchActionProtocolError);
  });

  it('does not trust a caller-supplied risk vector when a normalized proposal is prepared again', () => {
    const proposal = normalizeActionProposal({
      capabilityId: workspaceWrite.id,
      args: { path: 'safe.txt', content: 'safe' },
    }, { capability: workspaceWrite, workspaceRoot: 'E:\\Monarch' });
    const forged = { ...proposal, riskVector: { ...proposal.riskVector, effect: 'read' as const } };
    const normalized = normalizeActionProposal(forged, { capability: workspaceWrite, workspaceRoot: 'E:\\Monarch' });
    expect(normalized.riskVector.effect).toBe('write');
    expect(normalized.canonicalHash).toBe(proposal.canonicalHash);
    expect(normalized.idempotencyKey).toBe(proposal.idempotencyKey);
  });

  it('binds predicates into the proposal hash without letting them bypass the action repeat guard', () => {
    const base = normalizeActionProposal({
      capabilityId: workspaceWrite.id,
      args: { path: 'safe.txt', content: 'safe' },
      preconditions: [{ kind: 'not-exists', target: 'safe.txt' }],
    }, { capability: workspaceWrite, workspaceRoot: 'E:\\Monarch', intentId: 'intent_same' });
    const changed = normalizeActionProposal({
      capabilityId: workspaceWrite.id,
      args: { path: 'safe.txt', content: 'safe' },
      preconditions: [{ kind: 'exists', target: 'safe.txt' }],
    }, { capability: workspaceWrite, workspaceRoot: 'E:\\Monarch', intentId: 'intent_same' });
    expect(changed.canonicalHash).not.toBe(base.canonicalHash);
    expect(changed.idempotencyKey).toBe(base.idempotencyKey);
  });

  it('rejects malformed predicates on the public proposal path', () => {
    const malformed = [
      { kind: 'contains', target: 'safe.txt' },
      { kind: 'contains', target: 'safe.txt', value: '' },
      { kind: 'equals', target: 'safe.txt' },
      { kind: 'status', target: 'safe.txt', value: { state: 'file' } },
      { kind: 'not-exists', target: 'safe.txt', value: undefined },
    ];

    for (const predicate of malformed) {
      expect(() => normalizeActionProposal({
        capabilityId: workspaceWrite.id,
        args: { path: 'safe.txt', content: 'safe' },
        verification: [predicate] as unknown as MonarchActionPredicate[],
      }, { capability: workspaceWrite, workspaceRoot: 'E:\\Monarch' })).toThrowError(/predicate/i);
    }
  });
});
