import type {
  MonarchModuleKind,
  MonarchModule,
  MonarchModuleManifest,
  MonarchModuleRecord,
  MonarchModuleStatus,
  MonarchRisk,
} from './contracts';
import { nowIso, normalizeId, uniqueStrings } from './utils';

const ALLOWED_MODULE_KINDS: readonly MonarchModuleKind[] = [
  'system',
  'interface',
  'domain',
  'runtime',
  'tooling',
];

const ALLOWED_RISKS: readonly MonarchRisk[] = [
  'none',
  'read',
  'write',
  'delete',
  'execute',
  'network',
  'device-control',
  'money',
  'identity',
  'security-sensitive',
];

export class MonarchModuleRegistry {
  private readonly modules = new Map<string, MonarchModule>();
  private readonly records = new Map<string, MonarchModuleRecord>();

  register(module: MonarchModule): MonarchModuleRecord {
    const manifest = normalizeManifest(module.manifest);
    const id = manifest.id;

    if (this.modules.has(id)) {
      throw new Error(`Module already registered: ${id}`);
    }

    const record: MonarchModuleRecord = {
      manifest,
      status: 'registered',
      registeredAt: nowIso(),
    };

    this.modules.set(id, module);
    this.records.set(id, record);
    return record;
  }

  getModule(moduleId: string): MonarchModule | undefined {
    return this.modules.get(normalizeId(moduleId));
  }

  getRecord(moduleId: string): MonarchModuleRecord | undefined {
    const record = this.records.get(normalizeId(moduleId));
    return record ? { ...record, manifest: { ...record.manifest } } : undefined;
  }

  unregister(moduleId: string): void {
    const id = normalizeId(moduleId);
    this.modules.delete(id);
    this.records.delete(id);
  }

  listModules(): MonarchModule[] {
    return Array.from(this.modules.values());
  }

  listModulesInDependencyOrder(): MonarchModule[] {
    return this.getDependencyOrderedIds()
      .map((moduleId) => this.modules.get(moduleId))
      .filter((module): module is MonarchModule => Boolean(module));
  }

  listRecords(): MonarchModuleRecord[] {
    return Array.from(this.records.values()).map((record) => ({
      ...record,
      manifest: { ...record.manifest },
    }));
  }

  setStatus(moduleId: string, status: MonarchModuleStatus, error?: string): void {
    const id = normalizeId(moduleId);
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Module is not registered: ${id}`);
    }

    record.status = status;
    if (status === 'active') {
      record.activatedAt = nowIso();
      delete record.lastError;
    }
    if (status === 'failed') {
      record.failedAt = nowIso();
      record.lastError = error || 'Unknown module failure.';
    }
  }

  validateDependencies(): void {
    this.getDependencyOrderedIds();
  }

  private getDependencyOrderedIds(): string[] {
    const order: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    for (const moduleId of this.records.keys()) {
      visitModule(moduleId, this.records, visiting, visited, order, []);
    }

    return order;
  }
}

function visitModule(
  moduleId: string,
  records: Map<string, MonarchModuleRecord>,
  visiting: Set<string>,
  visited: Set<string>,
  order: string[],
  path: string[]
): void {
  if (visited.has(moduleId)) {
    return;
  }

  if (visiting.has(moduleId)) {
    const cycle = [...path, moduleId].join(' -> ');
    throw new Error(`Module dependency cycle detected: ${cycle}`);
  }

  const record = records.get(moduleId);
  if (!record) {
    throw new Error(`Module dependency is not registered: ${moduleId}`);
  }

  visiting.add(moduleId);
  for (const dependencyId of record.manifest.dependencies || []) {
    const normalizedDependencyId = normalizeId(dependencyId);
    if (!records.has(normalizedDependencyId)) {
      throw new Error(
        `Module ${record.manifest.id} has missing dependency: ${normalizedDependencyId}`
      );
    }
    visitModule(
      normalizedDependencyId,
      records,
      visiting,
      visited,
      order,
      [...path, moduleId]
    );
  }
  visiting.delete(moduleId);
  visited.add(moduleId);
  order.push(moduleId);
}

function normalizeManifest(manifest: MonarchModuleManifest): MonarchModuleManifest {
  const id = normalizeId(manifest?.id || '');
  if (!id) {
    throw new Error('Module manifest id is required.');
  }

  if (!ALLOWED_MODULE_KINDS.includes(manifest.kind)) {
    throw new Error(`Module ${id} has invalid kind: ${String(manifest.kind)}`);
  }

  const permissions = uniqueStrings(manifest.permissions || []) as MonarchRisk[];
  for (const permission of permissions) {
    if (!ALLOWED_RISKS.includes(permission)) {
      throw new Error(`Module ${id} has invalid permission risk: ${String(permission)}`);
    }
  }

  const capabilities = (manifest.capabilities || []).map((capability) => ({
    ...capability,
    id: normalizeId(capability.id),
    moduleId: normalizeId(capability.moduleId || id),
    title: String(capability.title || capability.id || '').trim(),
    description: String(capability.description || '').trim(),
  }));

  for (const capability of capabilities) {
    if (!capability.id) {
      throw new Error(`Module ${id} has a capability without id.`);
    }
    if (capability.moduleId !== id) {
      throw new Error(`Capability ${capability.id} must belong to module ${id}.`);
    }
    if (!capability.title) {
      throw new Error(`Capability ${capability.id} must have a title.`);
    }
    if (!ALLOWED_RISKS.includes(capability.risk)) {
      throw new Error(`Capability ${capability.id} has invalid risk: ${String(capability.risk)}`);
    }
    if (!permissions.includes(capability.risk)) {
      throw new Error(
        `Module ${id} must declare permission risk ${capability.risk} for capability ${capability.id}.`
      );
    }
  }

  return {
    ...manifest,
    id,
    name: String(manifest.name || id).trim(),
    version: String(manifest.version || '0.0.0').trim(),
    description: String(manifest.description || '').trim(),
    owns: uniqueStrings(manifest.owns || []),
    capabilities,
    permissions,
    dependencies: uniqueStrings(manifest.dependencies || []).map(normalizeId),
    events: uniqueStrings(manifest.events || []),
  };
}
