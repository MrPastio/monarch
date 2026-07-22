import { describe, expect, it } from 'vitest';
import type { MonarchCapability } from '../../src/core/contracts';
import { AgentDecisionValidationError, parseAgentDecision } from '../../src/agent/decision-schema';

const read: MonarchCapability = {
  id: 'workspace.files.read', moduleId: 'workspace', title: 'Read', risk: 'read',
  inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string' } } },
};
const write: MonarchCapability = {
  id: 'workspace.files.write', moduleId: 'workspace', title: 'Write', risk: 'write',
  inputSchema: { type: 'object', required: ['path', 'content'], additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } } },
};

describe('AgentDecision strict parser', () => {
  it('accepts only candidate capabilities with schema-valid input', () => {
    const decision = parseAgentDecision(JSON.stringify({
      kind: 'inspect', capabilityId: read.id, input: { path: 'README.md' },
      reason: 'Read source.', expectedEffect: 'Source is available.',
    }), { candidates: [read] });
    expect(decision).toMatchObject({ kind: 'inspect', capabilityId: read.id });
  });

  it('rejects markdown, invented tools and extra fields', () => {
    expect(() => parseAgentDecision('```json\n{}\n```', { candidates: [read] })).toThrowError(AgentDecisionValidationError);
    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'inspect', capabilityId: 'shell.exec', input: {}, reason: 'x', expectedEffect: 'x',
    }), { candidates: [read] })).toThrowError(/not in the current resolver result/);
    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'ask-user', question: 'Continue?', reason: 'Need input.', hiddenReasoning: 'private',
    }), { candidates: [read] })).toThrowError(/unexpected fields/);
  });

  it('requires deterministic verification for mutations and rejects secret fields', () => {
    const base = {
      kind: 'act', capabilityId: write.id, input: { path: 'report.md', content: 'report' },
      reason: 'Write report.', expectedEffect: 'Report exists.',
    };
    expect(() => parseAgentDecision(JSON.stringify(base), { candidates: [write] })).toThrowError(/requires deterministic verification/);
    expect(() => parseAgentDecision(JSON.stringify({ ...base, input: { path: 'report.md', content: 'x', apiKey: 'secret' }, verification: [{ kind: 'exists', target: 'report.md' }] }), { candidates: [write] })).toThrowError(/secret-bearing field/);
    expect(() => parseAgentDecision(JSON.stringify({
      ...base,
      input: { path: 'report.md', content: 'AKIA1234567890ABCDEF' },
      verification: [{ kind: 'exists', target: 'report.md' }],
    }), { candidates: [write] })).toThrowError(/secret-like material/);
  });

  it('enforces required capability verification kind and target binding', () => {
    const contractWrite: MonarchCapability = {
      ...write,
      agent: {
        verification: [{
          kind: 'read-after-write',
          description: 'Confirm the target exists with the expected content.',
          required: true,
        }],
      },
    };
    const base = {
      kind: 'act', capabilityId: write.id, input: { path: 'report.md', content: 'report' },
      reason: 'Write report.', expectedEffect: 'Report exists.',
    };
    expect(() => parseAgentDecision(JSON.stringify({
      ...base,
      verification: [{ kind: 'exists', target: 'report.md' }],
    }), { candidates: [contractWrite] })).toThrowError(/requires read-after-write verification/);
    expect(() => parseAgentDecision(JSON.stringify({
      ...base,
      verification: [
        { kind: 'exists', target: 'other.md' },
        { kind: 'contains', target: 'other.md', value: 'report' },
      ],
    }), { candidates: [contractWrite] })).toThrowError(/bound to its action target/);
    expect(parseAgentDecision(JSON.stringify({
      ...base,
      verification: [
        { kind: 'exists', target: 'report.md' },
        { kind: 'contains', target: 'report.md', value: 'report' },
      ],
    }), { candidates: [contractWrite] })).toMatchObject({ kind: 'act', capabilityId: write.id });
  });

  it('rejects missing, empty, wrongly typed, and inapplicable predicate values', () => {
    const base = {
      kind: 'inspect', capabilityId: read.id, input: { path: 'report.md' },
      reason: 'Inspect report.', expectedEffect: 'Report is inspected.',
    };
    const invalidPredicates = [
      { kind: 'contains', target: 'report.md' },
      { kind: 'contains', target: 'report.md', value: '' },
      { kind: 'equals', target: 'report.md' },
      { kind: 'status', target: 'report.md' },
      { kind: 'status', target: 'report.md', value: { state: 'file' } },
      { kind: 'exists', target: 'report.md', value: true },
      { kind: 'not-exists', target: 'report.md', value: null },
    ];

    for (const predicate of invalidPredicates) {
      expect(() => parseAgentDecision(JSON.stringify({
        ...base,
        verification: [predicate],
      }), { candidates: [read] })).toThrowError(/predicate.*(?:value|include)/i);
    }
  });
});
