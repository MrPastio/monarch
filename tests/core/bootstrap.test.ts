import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { createMonarchRuntime } from '../../src/bootstrap';
import { MonarchKernel, type MonarchModule, type MonarchModulePackage } from '../../src/core';

function createLifecycleOrderModule(
  id: string,
  dependencies: string[],
  events: string[]
): MonarchModule {
  return {
    manifest: {
      id,
      name: id,
      version: '0.1.0',
      kind: 'system',
      description: 'Smoke-only module for dependency lifecycle ordering.',
      owns: [id],
      permissions: [],
      dependencies,
      capabilities: [],
    },
    async activate(): Promise<void> {
      events.push(`start:${id}`);
    },
    async deactivate(): Promise<void> {
      events.push(`stop:${id}`);
    },
  };
}

function createSmokePackage(id: string): MonarchModulePackage {
  return {
    id,
    moduleId: id,
    version: '0.1.0',
    core: {
      minVersion: '0.1.0',
    },
    factory: () => createLifecycleOrderModule(id, [], []),
  };
}

// Each runtime gets its own folder: the default is the current directory,
// which in a checkout holds the owner's development state.
const roots: string[] = [];
const workspaceRoot = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'monarch-bootstrap-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Bootstrap & Kernel Lifecycle', () => {
  it('should load custom package catalog', () => {
    const runtime = createMonarchRuntime({
      workspaceRoot: workspaceRoot(),
      packages: [
        createSmokePackage('smoke-catalog-module'),
      ],
    });

    expect(runtime.modules[0]?.manifest.id).toBe('smoke-catalog-module');
    expect(runtime.packages[0]?.id).toBe('smoke-catalog-module');
    expect(runtime.loadRecords[0]?.status).toBe('loaded');
  });

  it('should select only enabled modules', async () => {
    const profileOnlyRuntime = createMonarchRuntime({
      workspaceRoot: workspaceRoot(),
      enabledModules: ['profile'],
    });
    const moduleIds = profileOnlyRuntime.modules.map((module) => module.manifest.id);
    const diagnosticsRecord = profileOnlyRuntime.loadRecords.find((record) => record.packageId === 'diagnostics');

    expect(moduleIds).toEqual(['profile']);
    expect(diagnosticsRecord?.status).toBe('skipped');

    await profileOnlyRuntime.kernel.start();
    const diagnosticsCapability = profileOnlyRuntime.kernel.getCapability('diagnostics.modules.list');
    await profileOnlyRuntime.kernel.stop();

    expect(diagnosticsCapability).toBeUndefined();
  });

  it('should respect dependency lifecycle order', async () => {
    const events: string[] = [];
    const kernel = new MonarchKernel();
    kernel.registerModule(createLifecycleOrderModule('feature-module', ['base-module'], events));
    kernel.registerModule(createLifecycleOrderModule('base-module', [], events));

    await kernel.start();
    await kernel.stop();

    const expected = [
      'start:base-module',
      'start:feature-module',
      'stop:feature-module',
      'stop:base-module',
    ];

    expect(events).toEqual(expected);
  });
});
