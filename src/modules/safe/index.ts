import type { MonarchExecutionRequest, MonarchExecutionResult, MonarchKernelContext, MonarchModule, MonarchModulePackage } from '../../core';
import { safeManifest } from './manifest';

export class SafeModule implements MonarchModule {
  readonly manifest = safeManifest;

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('safe.activated', this.manifest.id, { desktopOnly: true, sharedKernelContentAccess: false });
  }

  async health(): Promise<MonarchExecutionResult> {
    return { ok: true, summary: 'Monarch Safe design contract is registered. The shared kernel does not attest the live state of its separate desktop runtime.' };
  }


  async executeCapability(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
    if (request.capabilityId !== 'safe.status') return { ok: false, summary: 'Unsupported Safe capability.', error: 'unsupported-capability' };
    return {
      ok: true,
      summary: 'Monarch Safe спроектирован как отдельное desktop-окно без выдачи файлов, ключей или метаданных общему API Monarch; это описание контракта, а не live-проверка запущенного процесса.',
      output: { statusKind: 'static-contract', liveRuntimeAttested: false, desktopOnly: true, isolatedUtilityProcess: true, ephemeralRendererSession: true, deviceBoundPin: true, portableRecoveryKeys: true, externalPrograms: false, sharedKernelContentAccess: false },
    };
  }
}

export function createSafeModule(): MonarchModule { return new SafeModule(); }
export const safeModulePackage: MonarchModulePackage = { id: safeManifest.id, moduleId: safeManifest.id, version: safeManifest.version, description: safeManifest.description, core: { minVersion: '0.1.0' }, factory: createSafeModule };
