import { describe, it, expect } from 'vitest';
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

describe('Bootstrap & Kernel Lifecycle', () => {
  it('should load custom package catalog', () => {
    const runtime = createMonarchRuntime({
      packages: [
        createSmokePackage('smoke-catalog-module'),
      ],
    });

    expect(runtime.modules[0]?.manifest.id).toBe('smoke-catalog-module');
    expect(runtime.packages[0]?.id).toBe('smoke-catalog-module');
    expect(runtime.loadRecords[0]?.status).toBe('loaded');
  });

  it('should select only enabled modules', async () => {
    const memoryOnlyRuntime = createMonarchRuntime({
      enabledModules: ['memory'],
    });
    const moduleIds = memoryOnlyRuntime.modules.map((module) => module.manifest.id);
    const diagnosticsRecord = memoryOnlyRuntime.loadRecords.find((record) => record.packageId === 'diagnostics');

    expect(moduleIds).toEqual(['memory']);
    expect(diagnosticsRecord?.status).toBe('skipped');

    await memoryOnlyRuntime.kernel.start();
    const diagnosticsResult = await memoryOnlyRuntime.kernel.submitIntent('Покажи модули ядра', 'smoke');
    await memoryOnlyRuntime.kernel.stop();

    expect(diagnosticsResult.route).toBeNull();
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
