import { describe, it, expect } from 'vitest';
import { MonarchKernel, MonarchModuleLoader, type MonarchModule } from '../../src/core';

function createThrowingRouterModule(): MonarchModule {
  return {
    manifest: {
      id: 'smoke-throwing-router',
      name: 'Smoke Throwing Router',
      version: '0.1.0',
      kind: 'system',
      description: 'Smoke-only module that throws during route handling.',
      owns: ['smoke routing failure'],
      permissions: [],
      capabilities: [],
    },
    async activate(): Promise<void> {},
    async handleIntent(): Promise<null> {
      throw new Error('smoke route failure');
    },
  };
}

describe('MonarchModuleLoader', () => {
  it('should skip disabled package', () => {
    const kernel = new MonarchKernel();
    const loader = new MonarchModuleLoader();
    loader.registerPackage({
      id: 'smoke-disabled-package',
      version: '0.1.0',
      enabled: false,
      factory: () => {
        throw new Error('Disabled module package factory should not run.');
      },
    });

    const modules = loader.loadInto(kernel);
    const record = loader.getLoadRecords()[0];

    expect(modules).toHaveLength(0);
    expect(record?.status).toBe('skipped');
  });

  it('should fail incompatible package', () => {
    const kernel = new MonarchKernel();
    const loader = new MonarchModuleLoader();
    loader.registerPackage({
      id: 'smoke-incompatible-package',
      version: '0.1.0',
      core: {
        minVersion: '99.0.0',
      },
      factory: createThrowingRouterModule,
    });

    expect(() => loader.loadInto(kernel)).toThrow();

    const record = loader.getLoadRecords()[0];
    expect(record?.status).toBe('failed');
  });

  it('should load legacy factory', () => {
    const kernel = new MonarchKernel();
    const loader = new MonarchModuleLoader();
    loader.registerFactory(createThrowingRouterModule);

    const modules = loader.loadInto(kernel);
    const record = loader.getLoadRecords()[0];

    expect(modules[0]?.manifest.id).toBe('smoke-throwing-router');
    expect(record?.status).toBe('loaded');
    expect(record?.moduleId).toBe('smoke-throwing-router');
  });

  it('should validate manifest permissions', () => {
    const kernel = new MonarchKernel();

    expect(() => {
      kernel.registerModule({
        manifest: {
          id: 'smoke-invalid-permissions',
          name: 'Smoke Invalid Permissions',
          version: '0.1.0',
          kind: 'system',
          description: 'Smoke-only invalid manifest.',
          owns: ['invalid manifest'],
          permissions: [],
          capabilities: [
            {
              id: 'smoke-invalid.write',
              moduleId: 'smoke-invalid-permissions',
              title: 'Invalid write',
              risk: 'write',
            },
          ],
        },
        async activate(): Promise<void> {},
      });
    }).toThrow(/must declare permission risk write for capability/i);
  });

  it('should activate suite before its member module', async () => {
    const events: string[] = [];
    const kernel = new MonarchKernel();
    kernel.registerModule({
      manifest: {
        id: 'smoke-suite-member',
        name: 'Smoke Suite Member',
        version: '0.1.0',
        kind: 'domain',
        parentSuiteId: 'smoke-suite',
        description: 'Smoke-only suite member.',
        owns: ['smoke member'],
        permissions: [],
        dependencies: ['smoke-suite'],
        capabilities: [],
      },
      async activate(): Promise<void> {
        events.push('member');
      },
    });
    kernel.registerModule({
      manifest: {
        id: 'smoke-suite',
        name: 'Smoke Suite',
        version: '0.1.0',
        kind: 'suite',
        description: 'Smoke-only promoted suite.',
        owns: ['smoke suite'],
        permissions: [],
        capabilities: [],
      },
      async activate(): Promise<void> {
        events.push('suite');
      },
    });

    await kernel.start();
    expect(events).toEqual(['suite', 'member']);
    await kernel.stop();
  });

  it('should reject a suite member whose parent is not a suite', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule({
      manifest: {
        id: 'smoke-parent',
        name: 'Smoke Parent',
        version: '0.1.0',
        kind: 'system',
        description: 'Smoke-only invalid suite parent.',
        owns: ['smoke parent'],
        permissions: [],
        capabilities: [],
      },
      async activate(): Promise<void> {},
    });
    kernel.registerModule({
      manifest: {
        id: 'smoke-child',
        name: 'Smoke Child',
        version: '0.1.0',
        kind: 'domain',
        parentSuiteId: 'smoke-parent',
        description: 'Smoke-only invalid suite child.',
        owns: ['smoke child'],
        permissions: [],
        dependencies: ['smoke-parent'],
        capabilities: [],
      },
      async activate(): Promise<void> {},
    });

    await expect(kernel.start()).rejects.toThrow(/parent smoke-parent must have kind suite/i);
  });
});
