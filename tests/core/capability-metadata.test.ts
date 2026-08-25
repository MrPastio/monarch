import { describe, expect, it } from 'vitest';
import {
  MonarchCapabilityMetadataError,
  MonarchCapabilityRegistry,
  createAgentCapabilityMigrationInventory,
  legacyAgentCapabilityDefaults,
  resolveAgentCapabilityMetadata,
} from '../../src/core';
import type { MonarchCapability, MonarchModuleManifest } from '../../src/core';
import { deviceManifest } from '../../src/modules/device/manifest';
import { astraManifest } from '../../src/modules/astra/manifest';
import { modelsManifest } from '../../src/modules/models/manifest';
import { workspaceManifest } from '../../src/modules/workspace/manifest';
import { computerManifest } from '../../src/modules/computer/manifest';

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

  it('accepts a typed capability-owned runtime verification predicate', () => {
    const resolved = resolveAgentCapabilityMetadata(capability({
      risk: 'device-control',
      agent: {
        verification: [{
          kind: 'runtime-status',
          description: 'The launch receipt must report opened=true.',
          required: true,
          predicate: { kind: 'status', target: 'result.output.opened', value: true },
        }],
      },
    }));

    expect(resolved.verification).toContainEqual(expect.objectContaining({
      kind: 'runtime-status',
      required: true,
      predicate: { kind: 'status', target: 'result.output.opened', value: true },
    }));
    expect(() => resolveAgentCapabilityMetadata(capability({
      agent: {
        verification: [{
          kind: 'runtime-status',
          description: 'Malformed predicate.',
          predicate: { kind: 'status', target: 'result.output.opened' } as never,
        }],
      },
    }))).toThrowError(/status predicates require/i);
  });

  it('admits only bounded capability-owned mutation reconciliation contracts', () => {
    const reconciliation = {
      capabilityId: 'workspace.files.read',
      inputBindings: { path: 'path' },
      constantInput: { maxBytes: 1024 },
      targetInputKey: 'path',
      observationTargetPath: 'path',
      assertion: {
        kind: 'equals-source-input' as const,
        observationPath: 'content',
        sourceInputKey: 'content',
      },
    };
    expect(resolveAgentCapabilityMetadata(capability({
      risk: 'write',
      agent: { reconciliation },
    })).reconciliation).toEqual(reconciliation);

    expect(() => resolveAgentCapabilityMetadata(capability({
      risk: 'write',
      agent: {
        reconciliation: { ...reconciliation, targetInputKey: 'unbound' },
      },
    }))).toThrowError(/targetInputKey must name one inputBindings target/i);
    expect(() => resolveAgentCapabilityMetadata(capability({
      risk: 'write',
      agent: {
        reconciliation: { ...reconciliation, unexpected: true } as never,
      },
    }))).toThrowError(/unexpected is not supported/i);
    expect(() => resolveAgentCapabilityMetadata(capability({
      risk: 'write',
      agent: {
        reconciliation: {
          ...reconciliation,
          assertion: { ...reconciliation.assertion, kind: 'equals-baseline-plus-source-input' },
        },
      },
    }))).toThrowError(/requiresPreActionBaseline must be true/i);

    const append = workspaceManifest.capabilities.find((entry) => entry.id === 'workspace.files.append');
    expect(resolveAgentCapabilityMetadata(append!).reconciliation).toMatchObject({
      requiresPreActionBaseline: true,
      assertion: { kind: 'equals-baseline-plus-source-input' },
    });
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

  it.each([
    {
      name: 'read capability hiding a persistent mutation',
      item: capability({ risk: 'read', agent: { effectProfile: { mutation: 'persistent' } } }),
      match: /risk 'read' cannot declare persistent mutation/i,
    },
    {
      name: 'read capability hiding internet access',
      item: capability({ risk: 'read', agent: { effectProfile: { communication: 'internet' } } }),
      match: /risk 'read' cannot declare external communication 'internet'/i,
    },
    {
      name: 'workspace write targeting the device',
      item: capability({ risk: 'write', agent: { effectProfile: { targetScope: 'device' } } }),
      match: /risk 'write' cannot declare target scope 'device'/i,
    },
    {
      name: 'workspace write requiring elevation',
      item: capability({ risk: 'write', agent: { effectProfile: { privilege: 'elevated' } } }),
      match: /risk 'write' cannot declare elevated privilege/i,
    },
    {
      name: 'workspace write claiming irreversible effects',
      item: capability({ risk: 'write', agent: { effectProfile: { reversibility: 'irreversible' } } }),
      match: /risk 'write' cannot declare irreversible effects/i,
    },
    {
      name: 'workspace write hiding a security impact',
      item: capability({ risk: 'write', agent: { effectProfile: { securityImpact: true } } }),
      match: /risk 'write' cannot declare securityImpact/i,
    },
  ])('rejects an auto-allowed risk vector mismatch: $name', ({ item, match }) => {
    expect(() => resolveAgentCapabilityMetadata(item)).toThrowError(match);
  });

  it('allows recoverable delete-class operations without weakening their permission class', () => {
    const resolved = resolveAgentCapabilityMetadata(capability({
      risk: 'delete',
      agent: { reversibility: 'manual' },
    }));

    expect(resolved).toMatchObject({
      reversibility: 'manual',
      effectProfile: {
        mutation: 'persistent',
        reversibility: 'manual',
        dataSensitivity: 'private',
      },
    });
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

  it.each([0, 1, 2])('preflights every capability before mutating the registry when invalid metadata is at index %i', (invalidIndex) => {
    const registry = new MonarchCapabilityRegistry();
    const invalid = capability({
      id: 'smoke.metadata.invalid',
      risk: 'read',
      agent: { effectProfile: { mutation: 'persistent' } },
    });
    const entries = [
      capability({ id: 'smoke.metadata.valid-before', risk: 'read' }),
      capability({ id: 'smoke.metadata.valid-after', risk: 'read' }),
    ];
    entries.splice(invalidIndex, 0, invalid);

    expect(() => registry.registerModule({
      ...moduleManifest(entries[0]!),
      capabilities: entries,
    })).toThrowError(/cannot declare persistent mutation/i);
    expect(registry.list()).toHaveLength(0);
  });

  it('rejects a foreign module capability before registering valid siblings', () => {
    const registry = new MonarchCapabilityRegistry();
    const valid = capability({ id: 'smoke.metadata.valid', risk: 'read' });
    const foreign = capability({
      id: 'smoke.metadata.foreign',
      moduleId: 'other-module',
      risk: 'read',
    });

    expect(() => registry.registerModule({
      ...moduleManifest(valid),
      capabilities: [valid, foreign],
    })).toThrowError(/must belong to module smoke-metadata/i);
    expect(registry.list()).toHaveLength(0);
  });

  it('admits the current explicit production capability manifests under the truthful risk envelope', () => {
    const registry = new MonarchCapabilityRegistry();
    for (const manifest of [workspaceManifest, deviceManifest, astraManifest, modelsManifest, computerManifest]) {
      expect(() => registry.registerModule(manifest)).not.toThrow();
    }
  });

  it('keeps destructive local actions off Voice, Telegram, and API surfaces', () => {
    const destructive = [
      ...workspaceManifest.capabilities.filter((entry) => [
        'workspace.files.move',
        'workspace.files.trash',
        'workspace.files.delete',
      ].includes(entry.id)),
      ...deviceManifest.capabilities.filter((entry) => [
        'device.recycle-bin.empty',
        'device.browser.close-active',
      ].includes(entry.id)),
    ];

    expect(destructive).toHaveLength(5);
    for (const entry of destructive) {
      expect(resolveAgentCapabilityMetadata(entry).supportedSources).toEqual([
        'desktop',
        'system',
        'smoke',
      ]);
    }
    const browserOpen = deviceManifest.capabilities.find((entry) => entry.id === 'device.browser.open');
    expect(browserOpen).toBeDefined();
    expect(resolveAgentCapabilityMetadata(browserOpen!).supportedSources).toContain('voice');
    expect(resolveAgentCapabilityMetadata(browserOpen!).supportedSources).toContain('api');
  });

  it('migrates the complete local workspace capability slice to explicit metadata', () => {
    const explicitIds = workspaceManifest.capabilities
      .filter((entry) => entry.agent !== undefined)
      .map((entry) => entry.id);

    expect(explicitIds).toEqual([
      'workspace.root.get',
      'workspace.storage.audit',
      'workspace.files.read',
      'workspace.files.list',
      'workspace.files.search',
      'workspace.files.write',
      'workspace.files.inspect-batch',
      'workspace.known-folder.resolve',
      'workspace.known-folder.write',
      'workspace.files.append',
      'workspace.files.mkdir',
      'workspace.files.copy',
      'workspace.files.move',
      'workspace.files.replace',
      'workspace.files.trash',
      'workspace.files.delete',
    ]);

    for (const id of explicitIds) {
      const capabilityEntry = workspaceManifest.capabilities.find((entry) => entry.id === id);
      expect(capabilityEntry).toBeDefined();
      const resolved = resolveAgentCapabilityMetadata(capabilityEntry!);
      expect(resolved.source).toBe('explicit');
      expect(resolved.effectProfile.targetScope).toBe(
        id === 'workspace.storage.audit'
          ? 'device'
          : id === 'workspace.known-folder.write'
            ? 'application'
            : 'workspace',
      );
      expect(resolved.effects).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'legacy-observation' }),
      ]));
    }

    const append = workspaceManifest.capabilities.find((entry) => entry.id === 'workspace.files.append');
    expect(append).toBeDefined();
    expect(resolveAgentCapabilityMetadata(append!).source).toBe('explicit');
    const trash = workspaceManifest.capabilities.find((entry) => entry.id === 'workspace.files.trash');
    expect(trash).toBeDefined();
    expect(resolveAgentCapabilityMetadata(trash!).reversibility).toBe('manual');
    const permanentDelete = workspaceManifest.capabilities.find((entry) => entry.id === 'workspace.files.delete');
    expect(permanentDelete).toBeDefined();
    expect(resolveAgentCapabilityMetadata(permanentDelete!).reversibility).toBe('irreversible');
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
