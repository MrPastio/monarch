import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonarchExecutionRequest, MonarchKernelContext } from '../../src/core';
import { MonarchModulesModule } from '../../src/modules/monarch-modules';
import { monarchModulesManifest } from '../../src/modules/monarch-modules/manifest';
import { validateModuleDraft } from '../../src/modules/monarch-modules/scaffold';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Monarch Modules', () => {
  it('publishes Monarch Modules as an alpha suite', () => {
    expect(monarchModulesManifest.kind).toBe('suite');
    expect(monarchModulesManifest.stage).toBe('alpha');
  });

  it('normalizes a guided suite member draft', () => {
    const validation = validateModuleDraft({
      id: 'weather-tools',
      name: 'Weather Tools',
      description: 'Workspace-aware weather utilities for Monarch.',
      template: 'reader',
    });

    expect(validation.ok).toBe(true);
    expect(validation.draft.dependencies).toContain('monarch-modules');
    expect(validation.draft.permissions).toContain('read');
    expect(validation.draft.capabilities[0]?.id).toBe('weather-tools.read');
  });

  it('rejects unsupported kinds and malformed capabilities', () => {
    const validation = validateModuleDraft({
      id: 'unsafe-tools',
      name: 'Unsafe Tools',
      description: 'An intentionally invalid module draft for validation.',
      kind: 'super-priority',
      permissions: ['root'],
      capabilities: [{ id: 'other.run', title: '', risk: 'root' }],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'unsupported module kind: super-priority',
      'every capability requires a valid id, title, and supported risk',
      'unsupported permission risks: root',
    ]));
  });

  it('creates an isolated scaffold without overwriting it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-modules-'));
    temporaryRoots.push(root);
    const modulesRoot = path.join(root, 'src', 'modules');
    const module = new MonarchModulesModule({ workspaceRoot: root, modulesRoot });

    const request = createRequest('monarch-modules.scaffold.create', {
      id: 'weather-tools',
      name: 'Weather Tools',
      description: 'Workspace-aware weather utilities for Monarch.',
      template: 'reader',
    });
    const created = await module.executeCapability(request, createTestContext());
    const duplicate = await module.executeCapability(request, createTestContext());

    expect(created.ok).toBe(true);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toBe('module-folder-exists');
    const manifest = await readFile(path.join(modulesRoot, 'weather-tools', 'manifest.ts'), 'utf8');
    expect(manifest).toContain("parentSuiteId: 'monarch-modules'");
    expect(manifest).toContain("id: 'weather-tools.read'");
  });
});

function createRequest(capabilityId: string, input: unknown): MonarchExecutionRequest {
  return {
    id: 'test-request',
    intentId: 'test-intent',
    moduleId: 'monarch-modules',
    capabilityId,
    input,
    createdAt: new Date().toISOString(),
    requestedBy: 'test',
    confirmed: true,
  };
}

function createTestContext(): MonarchKernelContext {
  return {
    emit: async (type, source, payload) => ({
      id: 'test-event',
      type,
      source,
      createdAt: new Date().toISOString(),
      payload,
    }),
  } as MonarchKernelContext;
}
