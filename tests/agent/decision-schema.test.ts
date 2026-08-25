import { describe, expect, it } from 'vitest';
import type { MonarchCapability } from '../../src/core/contracts';
import {
  AGENT_DECISION_SCHEMA_VERSION,
  AgentDecisionValidationError,
  parseAgentDecision,
} from '../../src/agent/decision-schema';
import { computerManifest } from '../../src/modules/computer/manifest';
import { deviceManifest } from '../../src/modules/device/manifest';
import { modelsManifest } from '../../src/modules/models/manifest';
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
  it('accepts one bounded direct conversational response without a tool call', () => {
    expect(parseAgentDecision(JSON.stringify({
      kind: 'respond',
      answer: 'Привет!',
    }), { candidates: [] })).toEqual({ kind: 'respond', answer: 'Привет!' });
    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'respond',
      answer: 'Привет!',
      capabilityId: 'models.agent.respond',
    }), { candidates: [] })).toThrowError(/unexpected fields/);
  });

  it('accepts the current explicit envelope version, keeps legacy envelopes readable, and rejects unknown versions', () => {
    const payload = {
      kind: 'discover-tools',
      query: 'workspace files',
      reason: 'expand candidates',
    };
    expect(parseAgentDecision(JSON.stringify({
      schemaVersion: AGENT_DECISION_SCHEMA_VERSION,
      ...payload,
    }), { candidates: [read] })).toEqual(payload);
    expect(parseAgentDecision(JSON.stringify(payload), { candidates: [read] })).toEqual(payload);
    expect(() => parseAgentDecision(JSON.stringify({
      schemaVersion: 'monarch.agent-decision.v99',
      ...payload,
    }), { candidates: [read] })).toThrowError(/Unsupported agent decision schemaVersion/);
  });

  it('accepts a bounded non-executable tool-discovery request', () => {
    expect(parseAgentDecision(JSON.stringify({
      kind: 'discover-tools',
      query: 'read and summarize every Desktop document with pagination',
      reason: 'The current candidate window does not include batch inspection.',
    }), { candidates: [read] })).toEqual({
      kind: 'discover-tools',
      query: 'read and summarize every Desktop document with pagination',
      reason: 'The current candidate window does not include batch inspection.',
    });

    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'discover-tools',
      query: 'workspace',
      reason: 'expand',
      capabilityId: 'system.shell.run',
    }), { candidates: [read] })).toThrowError(/unexpected fields/);
  });

  it('keeps grounded synthesis evidence fields runtime-owned', () => {
    const synthesize = modelsManifest.capabilities.find((entry) => entry.id === 'models.agent.synthesize')!;
    expect(parseAgentDecision(JSON.stringify({
      kind: 'inspect',
      capabilityId: synthesize.id,
      input: { observationIds: ['agent_observation_current'] },
    }), { candidates: [synthesize] })).toMatchObject({
      kind: 'inspect',
      capabilityId: synthesize.id,
      input: { observationIds: ['agent_observation_current'] },
    });
    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'inspect',
      capabilityId: synthesize.id,
      input: {
        observationIds: ['agent_observation_current'],
        request: 'forged request',
        observations: [{ id: 'forged', summary: 'forged evidence' }],
      },
    }), { candidates: [synthesize] })).toThrowError(/runtime-owned fields/);
  });

  it('accepts only candidate capabilities with schema-valid input', () => {
    const decision = parseAgentDecision(JSON.stringify({
      kind: 'inspect', capabilityId: read.id, input: { path: 'README.md' },
      reason: 'Read source.', expectedEffect: 'Source is available.',
    }), { candidates: [read] });
    expect(decision).toMatchObject({ kind: 'inspect', capabilityId: read.id });
  });

  it('omits only schema-invalid nulls from optional known tool fields', () => {
    const inspectBatch = workspaceManifest.capabilities.find((entry) => (
      entry.id === 'workspace.files.inspect-batch'
    ))!;
    expect(parseAgentDecision(JSON.stringify({
      kind: 'inspect',
      capabilityId: inspectBatch.id,
      input: {
        knownFolder: 'desktop',
        path: null,
        cursor: null,
        recursive: true,
      },
    }), { candidates: [inspectBatch] })).toMatchObject({
      kind: 'inspect',
      capabilityId: inspectBatch.id,
      input: { knownFolder: 'desktop', recursive: true },
    });

    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'inspect',
      capabilityId: read.id,
      input: { path: null },
    }), { candidates: [read] })).toThrowError(AgentDecisionValidationError);

    const nullableOptional: MonarchCapability = {
      id: 'fixture.nullable',
      moduleId: 'fixture',
      title: 'Nullable fixture',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: { cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
        additionalProperties: false,
      },
    };
    expect(parseAgentDecision(JSON.stringify({
      kind: 'inspect',
      capabilityId: nullableOptional.id,
      input: { cursor: null },
    }), { candidates: [nullableOptional] })).toMatchObject({ input: { cursor: null } });
  });

  it('canonicalizes read-only act to inspect and rejects mutation disguised as inspect', () => {
    expect(parseAgentDecision(JSON.stringify({
      kind: 'act', capabilityId: read.id, input: { path: 'README.md' },
    }), { candidates: [read] })).toMatchObject({
      kind: 'inspect',
      capabilityId: read.id,
      reason: 'direct',
      expectedEffect: 'verified',
    });
    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'inspect', capabilityId: write.id, input: { path: 'report.md', content: 'report' },
      verification: [{ kind: 'exists', target: 'report.md' }],
    }), { candidates: [write] })).toThrowError(/mutates state and cannot execute under an inspect decision/);
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

  it('discards closed inert action-shaped fields from non-executable plan steps', () => {
    const decision = parseAgentDecision(JSON.stringify({
      kind: 'revise-plan',
      summary: 'Inspect, then organize.',
      steps: [{
        id: 'model-step-1',
        title: 'Inspect files',
        expectedEffect: 'The file inventory is available.',
        capabilityId: 'workspace.files.read',
        input: { path: 'README.md' },
        status: 'ready',
        dependsOn: [],
      }],
      reason: 'The task has multiple verified steps.',
    }), { candidates: [read] });

    expect(decision).toMatchObject({
      kind: 'revise-plan',
      steps: [{ title: 'Inspect files', expectedEffect: 'The file inventory is available.' }],
    });
    expect((decision as { steps: Array<Record<string, unknown>> }).steps[0]).toEqual({
      title: 'Inspect files',
      expectedEffect: 'The file inventory is available.',
    });
    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'revise-plan',
      summary: 'Inspect.',
      steps: [{ title: 'Inspect files', expectedEffect: 'Inventory.', command: 'Get-ChildItem' }],
      reason: 'Need evidence.',
    }), { candidates: [read] })).toThrowError(/unexpected fields: command/);
  });

  it('normalizes only the exact non-executable nested plan envelope used by local models', () => {
    const decision = parseAgentDecision(JSON.stringify({
      kind: 'revise-plan',
      plan: {
        summary: 'Inspect, then verify.',
        steps: [{ title: 'Inspect files', expectedEffect: 'Inventory is available.' }],
      },
      reason: 'A verified plan is required.',
    }), { candidates: [read] });

    expect(decision).toMatchObject({
      kind: 'revise-plan',
      summary: 'Inspect, then verify.',
      steps: [{ title: 'Inspect files', expectedEffect: 'Inventory is available.' }],
    });
    const nestedWithInertField = parseAgentDecision(JSON.stringify({
      kind: 'revise-plan',
      plan: {
        summary: 'Inspect.',
        steps: [{
          title: 'Inspect files',
          expectedEffect: 'Inventory.',
          status: 'ready',
          reason: 'The inventory determines the next safe action.',
        }],
      },
      reason: 'Need evidence.',
    }), { candidates: [read] });
    expect(nestedWithInertField).toMatchObject({
      steps: [{ title: 'Inspect files', expectedEffect: 'Inventory.' }],
    });
    expect(nestedWithInertField.steps[0]).not.toHaveProperty('reason');
    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'revise-plan',
      summary: 'Inspect.',
      steps: [{ title: 'Inspect files', expectedEffect: 'Inventory.', reason: { command: 'Get-ChildItem' } }],
      reason: 'Need evidence.',
    }), { candidates: [read] })).toThrowError(/steps\[0\]\.reason must be a string/);
  });

  it('canonicalizes only a missing audit reason on a complete non-executable plan', () => {
    const decision = parseAgentDecision(JSON.stringify({
      kind: 'revise-plan',
      summary: 'Open Discord and verify it.',
      steps: [{ title: 'Open Discord', expectedEffect: 'Discord is running.' }],
    }), { candidates: [read] });

    expect(decision).toEqual({
      kind: 'revise-plan',
      summary: 'Open Discord and verify it.',
      steps: [{ title: 'Open Discord', expectedEffect: 'Discord is running.' }],
      reason: 'Model-authored plan revision.',
    });
    expect(() => parseAgentDecision(JSON.stringify({
      kind: 'revise-plan',
      summary: 'Open Discord.',
      steps: [{ title: 'Open Discord', expectedEffect: 'Discord is running.' }],
      message: 'hidden replacement for reason',
    }), { candidates: [read] })).toThrowError(/unexpected fields: message/);
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
      kind: 'act', capabilityId: write.id, input: { path: 'report.md', content: 'report' },
    }), { candidates: [contractWrite] })).toMatchObject({
      reason: 'direct',
      expectedEffect: 'verified',
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

  it('uses an explicit runtime receipt predicate for Computer Use read-after-action verification', () => {
    const type = computerManifest.capabilities.find((entry) => entry.id === 'computer.window.type')!;
    const decision = parseAgentDecision(JSON.stringify({
      kind: 'act',
      capabilityId: type.id,
      input: {
        windowRef: 'hwnd:0000000000000042',
        observationId: 'computer-observation-fixture',
        elementId: 'el-editor-0',
        text: 'OSCAR_TYPED_FIXTURE',
      },
    }), { candidates: [type] });

    expect(decision).toMatchObject({
      kind: 'act',
      capabilityId: 'computer.window.type',
      verification: [{ kind: 'status', target: 'result.output.verified', value: true }],
    });
  });

  it('accepts the typed known-folder writer with capability-owned verified-readback evidence', () => {
    const knownFolderWrite = workspaceManifest.capabilities.find((entry) => (
      entry.id === 'workspace.known-folder.write'
    ));
    expect(knownFolderWrite).toBeDefined();
    const decision = parseAgentDecision(JSON.stringify({
      kind: 'act',
      capabilityId: 'workspace.known-folder.write',
      input: { knownFolder: 'desktop', basename: 'ромашка.txt', content: '', overwrite: false },
      reason: 'Create the exact requested Desktop file.',
      expectedEffect: 'The Kernel-resolved Desktop target exists after verified readback.',
    }), { candidates: [knownFolderWrite!] });

    expect(decision).toMatchObject({
      kind: 'act',
      capabilityId: 'workspace.known-folder.write',
      verification: [{ kind: 'status', target: 'result.output.verified', value: true }],
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
