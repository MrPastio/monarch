import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchMemoryEntryType,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import { memoryManifest } from './manifest';
import {
  defaultMemoryStorePath,
  MonarchMemoryStore,
  type MonarchMemoryMetadata,
  type MonarchMemoryPatch,
  type MonarchMemoryRecord,
  type MonarchMemorySearchFilters,
} from './store';

export interface MemoryModuleOptions {
  store?: MonarchMemoryStore;
  storePath?: string | false;
  workspaceRoot?: string;
}

export class MemoryModule implements MonarchModule {
  readonly manifest = memoryManifest;
  private readonly store: MonarchMemoryStore;

  constructor(options: MemoryModuleOptions = {}) {
    const filePath = resolveMemoryStorePath(options);
    this.store = options.store || new MonarchMemoryStore(filePath ? { filePath } : {});
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await this.store.load();
    await context.emit('memory.activated', this.manifest.id, {
      adapter: this.store.adapter,
      records: this.store.size,
      filePath: this.store.filePath,
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: `Memory module ready with ${this.store.adapter} store and ${this.store.size} records.`,
      output: {
        adapter: this.store.adapter,
        records: this.store.size,
        filePath: this.store.filePath,
      },
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.trim();
    const lower = text.toLowerCase();

    if (/(запомни|remember|сохрани в память)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'memory.remember',
        confidence: 0.9,
        reason: 'User asks Monarch to remember information.',
        permissionMode: 'confirm',
        input: {
          text: extractMemoryText(text),
          source: intent.source,
        },
      };
    }

    if (/(найди в памяти|вспомни|search memory|recall)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'memory.search',
        confidence: 0.82,
        reason: 'User asks Monarch to recall memory.',
        permissionMode: 'allow',
        input: {
          query: extractMemorySearchQuery(text),
          limit: 10,
        },
      };
    }

    if (/(что ты помнишь|покажи память|list memory)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'memory.list',
        confidence: 0.8,
        reason: 'User asks to list memory.',
        permissionMode: 'allow',
        input: { limit: 20 },
      };
    }

    return null;
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'memory.remember':
      return this.remember(request.input, context);
    case 'memory.search':
      return this.search(request.input, context);
    case 'memory.list':
      return this.list(request.input);
    case 'memory.update':
      return this.update(request.input, context);
    case 'memory.close_temporary':
      return this.closeTemporary(request.input, context);
    case 'memory.forget':
      return this.forget(request.input, context);
    default:
      return {
        ok: false,
        summary: `Unsupported memory capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private async remember(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const text = readStringInput(input, 'text');
    if (!text) {
      return {
        ok: false,
        summary: 'Memory text is empty.',
        error: 'empty-memory',
      };
    }

    const metadata: MonarchMemoryMetadata = {
      pinned: readBooleanInput(input, 'pinned', false),
    };
    const type = readMemoryType(input);
    const title = readOptionalStringInput(input, 'title');
    const tags = readStringArrayInput(input, 'tags');
    const category = readMemoryCategory(input);
    const tier = readMemoryTier(input);
    const importance = readOptionalNumberInput(input, 'importance');
    const priority = readOptionalNumberInput(input, 'priority');
    const expiresAt = readOptionalStringInput(input, 'expiresAt');
    const relatedFiles = readStringArrayInput(input, 'relatedFiles');
    const relatedModules = readStringArrayInput(input, 'relatedModules');
    if (type) {
      metadata.type = type;
    }
    if (title !== undefined) {
      metadata.title = title;
    }
    if (tags.length > 0) {
      metadata.tags = tags;
    }
    if (category) {
      metadata.category = category;
    }
    if (tier) {
      metadata.tier = tier;
    }
    if (importance !== undefined) {
      metadata.importance = importance;
    }
    if (priority !== undefined) {
      metadata.priority = priority;
    }
    if (expiresAt !== undefined) {
      metadata.expiresAt = expiresAt;
    }
    if (relatedFiles.length > 0) {
      metadata.relatedFiles = relatedFiles;
    }
    if (relatedModules.length > 0) {
      metadata.relatedModules = relatedModules;
    }

    const record = await this.store.remember(text, readStringInput(input, 'source') || 'user', metadata);
    await context.emit('memory.record.created', this.manifest.id, {
      recordId: record.id,
      source: record.source,
    });

    return {
      ok: true,
      summary: 'Memory record stored.',
      output: { record },
    };
  }

  private async search(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const query = readStringInput(input, 'query');
    const limit = readNumberInput(input, 'limit', 10);
    const filters = readMemoryFilters(input);
    const localOnly = readBooleanInput(input, 'localOnly', false);

    // 1. Search local JSON store
    const localRecords = await this.store.search(query, limit, filters);

    // 2. Query Oscar's memory FTS backend via context.execute
    let oscarRecords: any[] = [];
    try {
      if (localOnly) {
        throw new Error('local-only');
      }
      const oscarResult = await context.execute({
        id: `exec_mem_oscar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        intentId: '',
        moduleId: 'oscar',
        capabilityId: 'oscar.memory.search',
        input: {
          query,
          limit,
        },
        createdAt: new Date().toISOString(),
        requestedBy: 'memory',
        confirmed: true,
      });

      if (oscarResult.ok && oscarResult.output && Array.isArray((oscarResult.output as any).results)) {
        oscarRecords = (oscarResult.output as any).results;
      }
    } catch (error) {
      // Local-first philosophy: warn/audit and degrade gracefully to local store only
      if (!localOnly && context.audit) {
        await context.audit(
          'execution',
          `Oscar memory bridge search failed: ${error instanceof Error ? error.message : String(error)}`,
          { error: error instanceof Error ? error.stack : String(error) },
          'warn'
        );
      }
    }

    // 3. Filter Oscar records by relevance >= 0.25 and normalize to MonarchMemoryRecord schema
    const normalizedOscar: MonarchMemoryRecord[] = oscarRecords
      .filter((r: any) => {
        const score = typeof r.score === 'number' ? r.score : 0;
        // bm25 scores in sqlite are negative; lower (more negative) is better.
        // Relevance threshold score >= 0.25 applies as |score| >= 0.25 or -score >= 0.25.
        // If score is positive, check score >= 0.25.
        const relevance = score < 0 ? -score : score;
        return relevance >= 0.25;
      })
      .map((r: any) => {
        const score = typeof r.score === 'number' ? r.score : 0;
        const relevance = score < 0 ? -score : score;
        return {
          id: `oscar_${r.id ?? Math.random().toString(36).slice(2, 8)}`,
          text: String(r.excerpt || r.text || '').trim(),
          type: 'planning_note',
          title: String(r.title || 'Oscar memory').trim().slice(0, 120) || 'Oscar memory',
          tags: ['oscar'],
          source: 'oscar',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          category: 'fact',
          tier: 'long',
          importance: relevance,
          priority: relevance,
          accessCount: 0,
          pinned: false,
          decayRate: 0.02,
          relatedFiles: [],
          relatedModules: [],
        };
      });

    // 4. Merge and deduplicate matches (exact/normalized text check)
    const seenTexts = new Set<string>();
    const merged: MonarchMemoryRecord[] = [];

    const normalizeForDupCheck = (txt: string): string => {
      return txt
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]/g, '')
        .trim();
    };

    // Add local records first
    for (const rec of localRecords) {
      const norm = normalizeForDupCheck(rec.text);
      if (norm && !seenTexts.has(norm)) {
        seenTexts.add(norm);
        merged.push(rec);
      }
    }

    // Add normalized Oscar records
    for (const rec of normalizedOscar) {
      const norm = normalizeForDupCheck(rec.text);
      if (norm && !seenTexts.has(norm)) {
        seenTexts.add(norm);
        merged.push(rec);
      }
    }

    const finalRecords = merged.slice(0, limit);

    return {
      ok: true,
      summary: `Found ${finalRecords.length} unified memory records.`,
      output: { records: finalRecords },
    };
  }

  private list(input: unknown): MonarchExecutionResult {
    const limit = readNumberInput(input, 'limit', 20);
    const records = this.store.list(limit, readMemoryFilters(input));

    return {
      ok: true,
      summary: `Listed ${records.length} memory records.`,
      output: { records },
    };
  }

  private async update(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const id = readStringInput(input, 'id');
    const text = readOptionalStringInput(input, 'text');
    if (!id) {
      return { ok: false, summary: 'Memory record id is required.', error: 'memory-id-required' };
    }
    if (text !== undefined && !text) {
      return { ok: false, summary: 'Memory text is empty.', error: 'empty-memory' };
    }

    const patch: MonarchMemoryPatch = {};
    if (text !== undefined) patch.text = text;
    const type = readMemoryType(input);
    const title = readOptionalStringInput(input, 'title');
    const tags = readOptionalStringArrayInput(input, 'tags');
    const category = readMemoryCategory(input);
    const tier = readMemoryTier(input);
    const importance = readOptionalNumberInput(input, 'importance');
    const priority = readOptionalNumberInput(input, 'priority');
    const pinned = readOptionalBooleanInput(input, 'pinned');
    const expiresAt = readOptionalStringInput(input, 'expiresAt');
    const relatedFiles = readOptionalStringArrayInput(input, 'relatedFiles');
    const relatedModules = readOptionalStringArrayInput(input, 'relatedModules');
    if (type) patch.type = type;
    if (title !== undefined) patch.title = title;
    if (tags !== undefined) patch.tags = tags;
    if (category) patch.category = category;
    if (tier) patch.tier = tier;
    if (importance !== undefined) patch.importance = importance;
    if (priority !== undefined) patch.priority = priority;
    if (pinned !== undefined) patch.pinned = pinned;
    if (expiresAt !== undefined) patch.expiresAt = expiresAt;
    if (relatedFiles !== undefined) patch.relatedFiles = relatedFiles;
    if (relatedModules !== undefined) patch.relatedModules = relatedModules;

    const record = await this.store.update(id, patch);
    if (!record) {
      return { ok: false, summary: 'Memory record was not found.', error: 'memory-not-found' };
    }
    await context.emit('memory.record.updated', this.manifest.id, { recordId: record.id });
    return { ok: true, summary: 'Memory record updated.', output: { record } };
  }

  private async closeTemporary(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const id = readStringInput(input, 'id');
    if (!id) {
      return { ok: false, summary: 'Memory record id is required.', error: 'memory-id-required' };
    }
    const record = await this.store.closeTemporary(id);
    if (!record) {
      return { ok: false, summary: 'Memory record was not found.', error: 'memory-not-found' };
    }
    await context.emit('memory.record.updated', this.manifest.id, { recordId: record.id, closed: true });
    return { ok: true, summary: 'Temporary memory record closed.', output: { record } };
  }

  private async forget(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const id = readStringInput(input, 'id');
    if (!id) {
      return { ok: false, summary: 'Memory record id is required.', error: 'memory-id-required' };
    }
    const record = await this.store.forget(id);
    if (!record) {
      return { ok: false, summary: 'Memory record was not found.', error: 'memory-not-found' };
    }
    await context.emit('memory.record.forgotten', this.manifest.id, { recordId: record.id });
    return { ok: true, summary: 'Memory record removed.', output: { record } };
  }
}

function extractMemoryText(text: string): string {
  return text
    .replace(/^(запомни|remember|сохрани в память)[:,\s-]*/i, '')
    .trim();
}

function extractMemorySearchQuery(text: string): string {
  return text
    .replace(/^(найди в памяти|вспомни|search memory|recall)[:,\s-]*/i, '')
    .trim();
}

function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalStringInput(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, key)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

function readStringArrayInput(input: unknown, key: string): string[] {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function readOptionalStringArrayInput(input: unknown, key: string): string[] | undefined {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, key)) {
    return undefined;
  }
  return readStringArrayInput(input, key);
}

function readNumberInput(input: unknown, key: string, fallback: number): number {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readOptionalNumberInput(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBooleanInput(input: unknown, key: string, fallback: boolean): boolean {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readOptionalBooleanInput(input: unknown, key: string): boolean | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readMemoryCategory(input: unknown) {
  const category = readStringInput(input, 'category');
  return category === 'fact'
    || category === 'preference'
    || category === 'project'
    || category === 'correction'
    || category === 'note'
    ? category
    : undefined;
}

function readMemoryType(input: unknown): MonarchMemoryEntryType | undefined {
  const type = readStringInput(input, 'type');
  return type === 'user_preference'
    || type === 'project_decision'
    || type === 'architecture_note'
    || type === 'active_bug'
    || type === 'fixed_bug'
    || type === 'technical_debt'
    || type === 'temporary_task'
    || type === 'module_state'
    || type === 'handoff_note'
    || type === 'diagnostic_note'
    || type === 'planning_note'
    ? type
    : undefined;
}

function readMemoryTier(input: unknown) {
  const tier = readStringInput(input, 'tier');
  return tier === 'working' || tier === 'long' || tier === 'permanent'
    ? tier
    : undefined;
}

function readMemoryFilters(input: unknown): MonarchMemorySearchFilters {
  const filters: MonarchMemorySearchFilters = {};
  const type = readStringInput(input, 'type');
  const explicitTypes = readStringArrayInput(input, 'types');
  const tags = readStringArrayInput(input, 'tags');
  if (explicitTypes.length > 0) {
    filters.types = explicitTypes;
  } else if (type) {
    filters.types = [type];
  }
  if (tags.length > 0) {
    filters.tags = tags;
  }
  filters.includeClosed = readBooleanInput(input, 'includeClosed', false);
  filters.includeExpired = readBooleanInput(input, 'includeExpired', false);
  return filters;
}

export function createMemoryModule(options: MemoryModuleOptions = {}): MonarchModule {
  return new MemoryModule(options);
}

export const memoryModulePackage: MonarchModulePackage = {
  id: memoryManifest.id,
  moduleId: memoryManifest.id,
  version: memoryManifest.version,
  description: memoryManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createMemoryModule,
};

function resolveMemoryStorePath(options: MemoryModuleOptions): string | undefined {
  if (options.storePath === false) {
    return undefined;
  }
  if (typeof options.storePath === 'string') {
    return options.storePath;
  }

  const configuredPath = (
    process.env.MONARCH_MEMORY_STORE_PATH
    || process.env.MONARCH_MEMORY_PATH
    || ''
  ).trim();

  if (/^(off|none|memory)$/i.test(configuredPath)) {
    return undefined;
  }
  if (configuredPath) {
    return configuredPath;
  }

  return defaultMemoryStorePath(options.workspaceRoot || process.cwd());
}
