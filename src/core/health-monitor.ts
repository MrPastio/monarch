import type { MonarchExecutionResult, MonarchKernelContext, MonarchModuleRecord } from './contracts';
import { MonarchModuleRegistry } from './module-registry';

export interface MonarchHealthSnapshot {
  ok: boolean;
  modules: Array<{
    moduleId: string;
    status: MonarchModuleRecord['status'];
    health: MonarchExecutionResult | null;
  }>;
}

export class MonarchHealthMonitor {
  constructor(private readonly modules: MonarchModuleRegistry) {}

  async check(context: MonarchKernelContext): Promise<MonarchHealthSnapshot> {
    const moduleHealth = [];

    for (const record of this.modules.listRecords()) {
      const module = this.modules.getModule(record.manifest.id);
      const health = module?.health ? await module.health(context) : null;
      moduleHealth.push({
        moduleId: record.manifest.id,
        status: record.status,
        health,
      });
    }

    return {
      ok: moduleHealth.every((entry) => entry.status === 'active' && (entry.health?.ok ?? true)),
      modules: moduleHealth,
    };
  }
}

