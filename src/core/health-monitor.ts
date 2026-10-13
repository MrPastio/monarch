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

/** A health check this slow holds every UI state read; it is named in the log. */
const SLOW_HEALTH_MS = 1000;

export class MonarchHealthMonitor {
  constructor(private readonly modules: MonarchModuleRegistry) {}

  async check(context: MonarchKernelContext): Promise<MonarchHealthSnapshot> {
    // Read-only checks, run together: one after another, a single slow check
    // (a helper process) delayed the whole report and every UI state read.
    const moduleHealth = await Promise.all(this.modules.listRecords().map(async (record) => {
      const module = this.modules.getModule(record.manifest.id);
      const startedAt = Date.now();
      const health = module?.health ? await module.health(context) : null;
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= SLOW_HEALTH_MS) {
        console.error(JSON.stringify({ diagnostic: 'module-health-slow', moduleId: record.manifest.id, elapsedMs }));
      }
      return {
        moduleId: record.manifest.id,
        status: record.status,
        health,
      };
    }));

    return {
      ok: moduleHealth.every((entry) => entry.status === 'active' && (entry.health?.ok ?? true)),
      modules: moduleHealth,
    };
  }
}

