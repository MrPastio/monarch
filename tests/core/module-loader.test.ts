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
});
