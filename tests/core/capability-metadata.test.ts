import { describe, expect, it } from 'vitest';
import {
  MonarchCapabilityMetadataError,
  MonarchCapabilityRegistry,
  createAgentCapabilityMigrationInventory,
  legacyAgentCapabilityDefaults,
  resolveAgentCapabilityMetadata,
} from '../../src/core';
import type { MonarchCapability, MonarchModuleManifest } from '../../src/core';
import { workspaceManifest } from '../../src/modules/workspace/manifest';

describe('Agent capability metadata', () => {
  it('gives unmigrated capabilities conservative, deterministic legacy defaults', () => {
    const read = resolveAgentCapabilityMetadata(capability({ risk: 'read' }));
    expect(read).toMatchObject({
      source: 'legacy-default',
      idempotency: 'idempotent',
      reversibility: 'automatic',
      estimatedLatency: 'unbounded',
      computeClass: 'heavy',
      cancellation: 'unsupported',
      effectProfile: {
        mutation: 'none',
        targetScope: 'workspace',
        dataSensitivity: 'private',
      },
    });
    expect(read.supportedSources).toEqual(['desktop', 'voice', 'telegram', 'api', 'system', 'smoke', 'coder']);

    const deletion = legacyAgentCapabilityDefaults('delete');
    expect(deletion).toMatchObject({
      source: 'legacy-default',
      idempotency: 'non-idempotent',
      reversibility: 'irreversible',
      effectProfile: { mutation: 'persistent', reversibility: 'irreversible' },
    });
    expect(deletion.verification).toContainEqual(expect.objectContaining({ required: true }));
  });

  it('resolves explicit metadata while retaining mandatory mutation verification', () => {
    const resolved = resolveAgentCapabilityMetadata(capability({
      risk: 'write',
      agent: {
        tags: ['workspace', 'report', 'workspace'],
        effects: [{ kind: 'report-write', description: 'Writes a report.', targetScope: 'workspace' }],
        idempotency: 'conditional',
        reversibility: 'manual',
        effectProfile: {
          mutation: 'persistent',
          targetScope: 'workspace',
          reversibility: 'manual',
          privilege: 'normal',
          dataSensitivity: 'private',
          communication: 'none',
          financialImpact: false,
          identityImpact: false,
          securityImpact: false,
        },
        supportedSources: ['desktop', 'api'],
        estimatedLatency: 'short',
        computeClass: 'light',
        cancellation: 'best-effort',
        verification: [{ kind: 'read-after-write', description: 'Read the report.', required: true }],
      },
    }));

    expect(resolved).toMatchObject({
      source: 'explicit',
      tags: ['workspace', 'report'],
      effects: [{ kind: 'report-write', targetScope: 'workspace' }],
      supportedSources: ['desktop', 'api'],
      estimatedLatency: 'short',
      computeClass: 'light',
      cancellation: 'best-effort',
    });
    expect(resolved.verification).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'predicate', required: true }),
      expect.objectContaining({ kind: 'read-after-write', required: true }),
    ]));
  });

  it.each([
    {
      name: 'write mutation',
      capability: capability({
        risk: 'write',
        agent: { effectProfile: { mutation: 'none' } },
      }),
      match: /mutation cannot weaken/i,
    },
    {
      name: 'delete reversibility',
      capability: capability({
        risk: 'delete',
        agent: { reversibility: 'manual' },
      }),
      match: /reversibility cannot weaken/i,
    },
    {
      name: 'money financial impact',
      capability: capability({
        risk: 'money',
        agent: { effectProfile: { financialImpact: false } },
      }),
      match: /financialImpact cannot weaken/i,
    },
  ])('rejects explicit metadata that weakens the legacy $name floor', ({ capability: item, match }) => {
    expect(() => resolveAgentCapabilityMetadata(item)).toThrowError(match);
  });

  it('rejects malformed and internally inconsistent explicit metadata at registry admission', () => {
    const registry = new MonarchCapabilityRegistry();
    const malformed = capability({
      risk: 'read',
      agent: {
        reversibility: 'automatic',
        effectProfile: { reversibility: 'manual' },
      },
    });

    expect(() => registry.registerModule(moduleManifest(malformed))).toThrowError(MonarchCapabilityMetadataError);
    expect(registry.list()).toHaveLength(0);

    const unknownKey = capability({ risk: 'read' });
    unknownKey.agent = { tags: ['read'], unexpected: true } as never;
    expect(() => registry.registerModule(moduleManifest(unknownKey))).toThrowError(/unexpected is not supported/i);
  });

  it('migrates only the five first-slice workspace capabilities to explicit metadata', () => {
    const explicitIds = workspaceManifest.capabilities
      .filter((entry) => entry.agent !== undefined)
      .map((entry) => entry.id);

    expect(explicitIds).toEqual([
      'workspace.root.get',
      'workspace.files.read',
      'workspace.files.list',
      'workspace.files.search',
      'workspace.files.write',
    ]);

    for (const id of explicitIds) {
      const capabilityEntry = workspaceManifest.capabilities.find((entry) => entry.id === id);
      expect(capabilityEntry).toBeDefined();
      const resolved = resolveAgentCapabilityMetadata(capabilityEntry!);
      expect(resolved.source).toBe('explicit');
      expect(resolved.effectProfile.targetScope).toBe('workspace');
      expect(resolved.effects).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'legacy-observation' }),
      ]));
    }

    const append = workspaceManifest.capabilities.find((entry) => entry.id === 'workspace.files.append');
    expect(append).toBeDefined();
    expect(resolveAgentCapabilityMetadata(append!).source).toBe('legacy-default');
  });

  it('generates a deterministic migration inventory with priority review reasons', () => {
    const inventory = createAgentCapabilityMigrationInventory([
      capability({ id: 'workspace.root.get', risk: 'read', agent: { tags: ['workspace'] } }),
      capability({ id: 'custom-tools.execute', risk: 'execute' }),
    ]);
    expect(inventory).toMatchObject({ total: 2, explicit: 1, legacyDefaults: 1 });
    expect(inventory.entries.find((entry) => entry.capabilityId === 'custom-tools.execute')).toMatchObject({
      reviewPriority: 'high',
      reviewReasons: ['metadata-not-explicit', 'legacy-risk:execute', 'priority-contract-family'],
    });
  });
});

function capability(overrides: Partial<MonarchCapability>): MonarchCapability {
  return {
    id: 'smoke.metadata',
    moduleId: 'smoke-metadata',
    title: 'Metadata smoke',
    risk: 'none',
    ...overrides,
  };
}

function moduleManifest(entry: MonarchCapability): MonarchModuleManifest {
  return {
    id: 'smoke-metadata',
    name: 'Metadata smoke',
    version: '0.1.0',
    kind: 'tooling',
    description: 'Metadata validation fixture.',
    owns: ['metadata fixture'],
    permissions: [entry.risk],
    capabilities: [entry],
  };
}
