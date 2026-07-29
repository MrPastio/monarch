import { describe, expect, it } from 'vitest';
import type { MonarchCapability } from '../../src/core/contracts';
import { AgentDecisionValidationError, parseAgentDecision } from '../../src/agent/decision-schema';
import { deviceManifest } from '../../src/modules/device/manifest';
import { workspaceManifest } from '../../src/modules/workspace/manifest';

const read: MonarchCapability = {
  id: 'workspace.files.read', moduleId: 'workspace', title: 'Read', risk: 'read',
  inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string' } } },
};
const write: MonarchCapability = {
  id: 'workspace.files.write', moduleId: 'workspace', title: 'Write', risk: 'write',
  inputSchema: { type: 'object', required: ['path', 'content'], additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } } },
};
const awsAccessKeyFixture = ['AK', 'IA', '1234567890ABCDEF'].join('');

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

  it('canonicalizes only a unique hyphen/underscore candidate ID and rejects collisions', () => {
    const closeBrowser: MonarchCapability = {
      id: 'device.browser.close-active',
      moduleId: 'device',
      title: 'Close browser',
      risk: 'delete',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      agent: {
        cancellation: 'best-effort',
        verification: [{
          kind: 'runtime-status',
          description: 'Confirm the exact browser closed.',
          required: true,
          predicate: { kind: 'status', target: 'result.output.closed', value: true },
        }],
      },
    };
    const raw = JSON.stringify({
      kind: 'act',
      capabilityId: 'device.browser.close_active',
      input: {},
      reason: 'Close it.',
      expectedEffect: 'Browser closes.',
    });
    expect(parseAgentDecision(raw, { candidates: [closeBrowser] })).toMatchObject({
      kind: 'act',
      capabilityId: 'device.browser.close-active',
    });

    const ambiguousRaw = JSON.stringify({
      kind: 'act',
      capabilityId: 'device.browser.close-active-now',
      input: {},
      reason: 'Close it.',
      expectedEffect: 'Browser closes.',
    });
    expect(() => parseAgentDecision(ambiguousRaw, {
      candidates: [
        { ...closeBrowser, id: 'device.browser.close_active-now' },
        { ...closeBrowser, id: 'device.browser.close-active_now' },
      ],
    })).toThrowError(/not in the current resolver result/);
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
      input: { path: 'report.md', content: awsAccessKeyFixture },
      verification: [{ kind: 'exists', target: 'report.md' }],
    }), { candidates: [write] })).toThrowError(/secret-like material/);
  });

  it('derives required read-after-write verification from schema-valid action input', () => {
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
    expect(parseAgentDecision(JSON.stringify(base), { candidates: [contractWrite] })).toMatchObject({
      verification: [
        { kind: 'exists', target: 'report.md' },
        { kind: 'equals', target: 'report.md', value: 'report' },
      ],
    });
    expect(parseAgentDecision(JSON.stringify({
      ...base,
      verification: [{ kind: 'exists', target: 'report.md' }],
    }), { candidates: [contractWrite] })).toMatchObject({
      verification: [
        { kind: 'exists', target: 'report.md' },
        { kind: 'equals', target: 'report.md', value: 'report' },
      ],
    });
    expect(parseAgentDecision(JSON.stringify({
      ...base,
      verification: [
        { kind: 'exists', target: 'other.md' },
        { kind: 'contains', target: 'other.md', value: 'report' },
      ],
    }), { candidates: [contractWrite] })).toMatchObject({
      verification: [
        { kind: 'exists', target: 'report.md' },
        { kind: 'equals', target: 'report.md', value: 'report' },
      ],
    });
    expect(parseAgentDecision(JSON.stringify({
      ...base,
      verification: [
        { kind: 'exists', target: 'report.md' },
        { kind: 'contains', target: 'report.md', value: 'report' },
      ],
    }), { candidates: [contractWrite] })).toMatchObject({
      kind: 'act',
      capabilityId: write.id,
      verification: [
        { kind: 'exists', target: 'report.md' },
        { kind: 'equals', target: 'report.md', value: 'report' },
      ],
    });
  });

  it('uses capability-owned runtime verification even when model verification is malformed', () => {
    const openApp: MonarchCapability = {
      id: 'device.app.open',
      moduleId: 'device',
      title: 'Open app',
      risk: 'device-control',
      inputSchema: {
        type: 'object',
        required: ['app'],
        additionalProperties: false,
        properties: { app: { type: 'string' } },
      },
      agent: {
        verification: [{
          kind: 'runtime-status',
          description: 'The launch receipt must report opened=true.',
          required: true,
          predicate: { kind: 'status', target: 'result.output.opened', value: true },
        }],
      },
    };
    const decision = parseAgentDecision(JSON.stringify({
      kind: 'act',
      capabilityId: openApp.id,
      input: { app: 'Steam' },
      reason: 'Open Steam.',
      expectedEffect: 'Steam is opened.',
      verification: [{ kind: 'runtime-status', target: 'Steam', value: 0 }],
    }), { candidates: [openApp] });

    expect(decision).toMatchObject({
      kind: 'act',
      capabilityId: openApp.id,
      verification: [{ kind: 'status', target: 'result.output.opened', value: true }],
    });
  });

  it.each([
    ['workspace.files.append', { path: 'runtime/log.txt', content: 'done' }],
    ['workspace.files.mkdir', { path: 'runtime/output' }],
    ['workspace.files.copy', { path: 'runtime/source', targetPath: 'runtime/copy' }],
    ['workspace.files.move', { path: 'runtime/source.txt', targetPath: 'runtime/moved.txt' }],
    ['workspace.files.replace', { path: 'runtime/config.txt', oldText: 'old', newText: 'new' }],
    ['workspace.files.trash', { path: 'runtime/trash.txt' }],
    ['workspace.files.delete', { path: 'runtime/permanent.txt' }],
  ])('uses the verified capability receipt for %s', (capabilityId, input) => {
    const capability = workspaceManifest.capabilities.find((entry) => entry.id === capabilityId);
    expect(capability).toBeDefined();
    const decision = parseAgentDecision(JSON.stringify({
      kind: 'act',
      capabilityId,
      input,
      reason: 'Perform the exact workspace action.',
      expectedEffect: 'The capability verifies the concrete filesystem result.',
    }), { candidates: [capability as MonarchCapability] });

    expect(decision).toMatchObject({
      kind: 'act',
      capabilityId,
      verification: [{ kind: 'status', target: 'result.output.verified', value: true }],
    });
    if (capabilityId === 'workspace.files.append') {
      expect(decision).not.toMatchObject({
        verification: expect.arrayContaining([
          { kind: 'equals', target: 'runtime/log.txt', value: 'done' },
        ]),
      });
    }
  });

  it.each([
    ['inspect', 'device.volume.get', {}],
    ['act', 'device.volume.set', { action: 'set', value: 20 }],
    ['inspect', 'device.brightness.get', {}],
    ['act', 'device.brightness.set', { operation: 'set', value: 55 }],
    ['act', 'device.browser.open', { url: 'https://example.com' }],
    ['act', 'device.recycle-bin.empty', {}],
    ['act', 'device.browser.close-active', {}],
  ])('binds %s %s to its capability-owned verified receipt', (kind, capabilityId, input) => {
    const capability = deviceManifest.capabilities.find((entry) => entry.id === capabilityId);
    expect(capability).toBeDefined();
    const decision = parseAgentDecision(JSON.stringify({
      kind,
      capabilityId,
      input,
      reason: 'Use the exact verified device capability.',
      expectedEffect: 'Windows confirms the requested result.',
    }), { candidates: [capability as MonarchCapability] });

    expect(decision).toMatchObject({
      kind,
      capabilityId,
      verification: [{ kind: 'status', target: 'result.output.verified', value: true }],
    });
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
