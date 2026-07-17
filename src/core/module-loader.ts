import {
  MONARCH_CORE_API_VERSION,
  type MonarchCoreCompatibility,
  type MonarchModule,
  type MonarchModuleFactory,
  type MonarchModuleLoadRecord,
  type MonarchModuleFactoryContext,
  type MonarchModulePackage,
} from './contracts';
import type { MonarchKernel } from './kernel';
import { normalizeId } from './utils';

export class MonarchModuleLoader {
  private readonly packages = new Map<string, MonarchModulePackage>();
  private loadRecords: MonarchModuleLoadRecord[] = [];
  private inlinePackageSequence = 0;

  constructor(private readonly factoryContext: MonarchModuleFactoryContext = {}) {}

  registerFactory(
    factory: MonarchModuleFactory,
    options: Partial<Omit<MonarchModulePackage, 'factory'>> = {}
  ): void {
    this.inlinePackageSequence += 1;
    this.registerPackage({
      id: options.id || `inline-module-${this.inlinePackageSequence}`,
      version: options.version || '0.0.0',
      factory,
      ...withoutUndefinedPackageOptions(options),
    });
  }

  registerPackage(modulePackage: MonarchModulePackage): void {
    const normalized = normalizeModulePackage(modulePackage);
    if (this.packages.has(normalized.id)) {
      throw new Error(`Module package already registered: ${normalized.id}`);
    }
    this.packages.set(normalized.id, normalized);
  }

  registerPackages(modulePackages: readonly MonarchModulePackage[]): void {
    for (const modulePackage of modulePackages) {
      this.registerPackage(modulePackage);
    }
  }

  loadInto(kernel: MonarchKernel): MonarchModule[] {
    const modules: MonarchModule[] = [];
    this.loadRecords = [];

    for (const modulePackage of this.packages.values()) {
      if (modulePackage.enabled === false) {
        this.loadRecords.push({
          packageId: modulePackage.id,
          version: modulePackage.version,
          status: 'skipped',
          reason: 'Package is disabled.',
        });
        continue;
      }

      const compatibility = checkCoreCompatibility(modulePackage.core);
      if (!compatibility.ok) {
        this.loadRecords.push({
          packageId: modulePackage.id,
          version: modulePackage.version,
          status: 'failed',
          reason: compatibility.reason,
        });
        throw new Error(`Module package ${modulePackage.id} is incompatible: ${compatibility.reason}`);
      }

      try {
        const module = modulePackage.factory(this.factoryContext);
        const moduleId = normalizeId(module.manifest.id);
        if (modulePackage.moduleId && moduleId !== modulePackage.moduleId) {
          throw new Error(
            `Factory created module ${moduleId}, expected ${modulePackage.moduleId}.`
          );
        }

        kernel.registerModule(module);
        modules.push(module);
        this.loadRecords.push({
          packageId: modulePackage.id,
          version: modulePackage.version,
          status: 'loaded',
          reason: 'Package loaded.',
          moduleId,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.loadRecords.push({
          packageId: modulePackage.id,
          version: modulePackage.version,
          status: 'failed',
          reason,
        });
        throw error;
      }
    }

    return modules;
  }

  getLoadRecords(): MonarchModuleLoadRecord[] {
    return this.loadRecords.map((record) => ({ ...record }));
  }

  listPackages(): MonarchModulePackage[] {
    return Array.from(this.packages.values()).map((modulePackage) => ({ ...modulePackage }));
  }
}

function normalizeModulePackage(modulePackage: MonarchModulePackage): MonarchModulePackage {
  const id = normalizeId(modulePackage.id);
  if (!id) {
    throw new Error('Module package id is required.');
  }
  if (typeof modulePackage.factory !== 'function') {
    throw new Error(`Module package ${id} must provide a factory.`);
  }

  const normalized: MonarchModulePackage = {
    id,
    version: String(modulePackage.version || '0.0.0').trim(),
    factory: modulePackage.factory,
  };

  const moduleId = normalizeId(modulePackage.moduleId || '');
  if (moduleId) {
    normalized.moduleId = moduleId;
  }

  const description = String(modulePackage.description || '').trim();
  if (description) {
    normalized.description = description;
  }

  if (modulePackage.enabled !== undefined) {
    normalized.enabled = Boolean(modulePackage.enabled);
  }

  const core = normalizeCoreCompatibility(modulePackage.core);
  if (core) {
    normalized.core = core;
  }

  return normalized;
}

function withoutUndefinedPackageOptions(
  options: Partial<Omit<MonarchModulePackage, 'factory'>>
): Partial<Omit<MonarchModulePackage, 'factory'>> {
  const result: Partial<Omit<MonarchModulePackage, 'factory'>> = {};

  if (options.moduleId !== undefined) {
    result.moduleId = options.moduleId;
  }
  if (options.description !== undefined) {
    result.description = options.description;
  }
  if (options.enabled !== undefined) {
    result.enabled = options.enabled;
  }
  if (options.core !== undefined) {
    result.core = options.core;
  }

  return result;
}

function normalizeCoreCompatibility(
  compatibility: MonarchCoreCompatibility | undefined
): MonarchCoreCompatibility | undefined {
  if (!compatibility) {
    return undefined;
  }

  const normalized: MonarchCoreCompatibility = {};
  const minVersion = normalizeVersion(compatibility.minVersion || '');
  const maxVersion = normalizeVersion(compatibility.maxVersion || '');

  if (minVersion) {
    normalized.minVersion = minVersion;
  }
  if (maxVersion) {
    normalized.maxVersion = maxVersion;
  }

  return normalized.minVersion || normalized.maxVersion ? normalized : undefined;
}

function checkCoreCompatibility(
  compatibility: MonarchCoreCompatibility | undefined
): { ok: true; reason: string } | { ok: false; reason: string } {
  if (!compatibility) {
    return { ok: true, reason: 'No core version constraints.' };
  }

  if (
    compatibility.minVersion
    && compareVersions(MONARCH_CORE_API_VERSION, compatibility.minVersion) < 0
  ) {
    return {
      ok: false,
      reason: `Requires core >= ${compatibility.minVersion}, current is ${MONARCH_CORE_API_VERSION}.`,
    };
  }

  if (
    compatibility.maxVersion
    && compareVersions(MONARCH_CORE_API_VERSION, compatibility.maxVersion) > 0
  ) {
    return {
      ok: false,
      reason: `Requires core <= ${compatibility.maxVersion}, current is ${MONARCH_CORE_API_VERSION}.`,
    };
  }

  return { ok: true, reason: 'Core version is compatible.' };
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
}

function parseVersion(version: string): number[] {
  return normalizeVersion(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function normalizeVersion(version: string): string {
  return String(version || '')
    .trim()
    .replace(/^[^\d]*/, '')
    .split(/[^0-9.]/)[0] || '';
}
