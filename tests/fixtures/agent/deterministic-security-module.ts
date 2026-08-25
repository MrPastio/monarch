import type {
  MonarchExecutionResult,
  MonarchModule,
  MonarchModulePackage,
} from '../../../src/core';

/**
 * Deterministic Security boundary for tests whose subject is Agent approval,
 * lease, or recovery behavior. It intentionally never starts the real Python
 * Security CLI or shares its data/config roots with parallel Vitest workers.
 */
export function createDeterministicSecurityModule(): MonarchModule {
  return {
    manifest: {
      id: 'security',
      name: 'Synthetic deterministic Security',
      version: '1.0.0',
      kind: 'runtime',
      description: 'Synthetic informational action review for non-Security tests.',
      owns: ['synthetic deterministic action review'],
      permissions: ['execute'],
      capabilities: [{
        id: 'security.controller.check',
        moduleId: 'security',
        title: 'Review synthetic action',
        risk: 'execute',
      }],
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return {
        ok: true,
        summary: 'Synthetic deterministic Security review completed.',
        output: {
          payload: {
            ok: true,
            status: 'allowed',
            report: 'Synthetic non-Security test boundary allows policy evaluation to continue.',
            evidenceCodes: ['test.synthetic-security.allowed'],
            disposition: 'informational',
          },
        },
      };
    },
  };
}

export const deterministicSecurityModulePackage: MonarchModulePackage = {
  id: 'security',
  moduleId: 'security',
  version: '1.0.0-test',
  description: 'Synthetic deterministic Security package for non-Security tests.',
  core: { minVersion: '0.1.0' },
  factory: createDeterministicSecurityModule,
};

export function withDeterministicSecurityModule(
  packages: readonly MonarchModulePackage[],
): MonarchModulePackage[] {
  let replaced = false;
  const selected = packages.map((modulePackage) => {
    if (modulePackage.moduleId !== 'security' && modulePackage.id !== 'security') {
      return modulePackage;
    }
    replaced = true;
    return deterministicSecurityModulePackage;
  });
  return replaced ? selected : [...selected, deterministicSecurityModulePackage];
}
