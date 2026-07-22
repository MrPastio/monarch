import type { MonarchCapability, MonarchModuleManifest } from './contracts';
import { validateAgentCapabilityMetadata } from './capability-metadata';
import { normalizeId, normalizeText } from './utils';

export class MonarchCapabilityRegistry {
  private readonly capabilities = new Map<string, MonarchCapability>();
  private readonly moduleIndex = new Map<string, Set<string>>();

  registerModule(manifest: MonarchModuleManifest): void {
    this.validateModuleCapabilities(manifest);
    for (const capability of manifest.capabilities) {
      this.registerCapability(capability);
    }
  }

  get(capabilityId: string): MonarchCapability | undefined {
    const capability = this.capabilities.get(normalizeId(capabilityId));
    return capability ? { ...capability } : undefined;
  }

  list(): MonarchCapability[] {
    return Array.from(this.capabilities.values()).map((capability) => ({ ...capability }));
  }

  listByModule(moduleId: string): MonarchCapability[] {
    const ids = this.moduleIndex.get(normalizeId(moduleId)) || new Set<string>();
    return Array.from(ids)
      .map((id) => this.get(id))
      .filter((capability): capability is MonarchCapability => Boolean(capability));
  }

  search(query: string): MonarchCapability[] {
    const normalized = normalizeText(query).toLowerCase();
    if (!normalized) {
      return this.list();
    }

    const terms = normalized.split(' ').filter(Boolean);
    return this.list()
      .map((capability) => ({
        capability,
        score: scoreCapability(capability, terms),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.capability);
  }

  private registerCapability(capability: MonarchCapability): void {
    const id = normalizeId(capability.id);
    const moduleId = normalizeId(capability.moduleId);

    if (!id) {
      throw new Error('Capability id is required.');
    }
    if (!moduleId) {
      throw new Error(`Capability ${id} must declare moduleId.`);
    }
    if (this.capabilities.has(id)) {
      throw new Error(`Capability already registered: ${id}`);
    }

    validateAgentCapabilityMetadata(capability);

    this.capabilities.set(id, {
      ...capability,
      id,
      moduleId,
    });

    const bucket = this.moduleIndex.get(moduleId) || new Set<string>();
    bucket.add(id);
    this.moduleIndex.set(moduleId, bucket);
  }

  private validateModuleCapabilities(manifest: MonarchModuleManifest): void {
    const seen = new Set<string>();

    for (const capability of manifest.capabilities) {
      const id = normalizeId(capability.id);
      if (!id) {
        throw new Error(`Module ${manifest.id} has a capability without id.`);
      }
      if (seen.has(id)) {
        throw new Error(`Module ${manifest.id} declares duplicate capability: ${id}`);
      }
      if (this.capabilities.has(id)) {
        throw new Error(`Capability already registered: ${id}`);
      }
      seen.add(id);
    }
  }
}

function scoreCapability(capability: MonarchCapability, terms: string[]): number {
  const haystack = [
    capability.id,
    capability.moduleId,
    capability.title,
    capability.description || '',
    capability.risk,
    ...(capability.routing?.aliases || []),
    ...(capability.routing?.keywords || []),
    ...(capability.routing?.examples || []),
    ...(capability.routing?.intentKinds || []),
  ].join(' ').toLowerCase();

  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
