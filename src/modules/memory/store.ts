import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clampConfidence, createMonarchId, nowIso, normalizeText } from '../../core';
import type { MonarchMemoryEntryType } from '../../core';

export type MonarchMemoryTier = 'working' | 'long' | 'permanent';
export type MonarchMemoryCategory = 'fact' | 'preference' | 'project' | 'correction' | 'note';
export type MonarchMemoryRecordStatus = 'active' | 'closed' | 'expired';

export interface MonarchMemoryRecord {
  id: string;
  text: string;
  type: MonarchMemoryEntryType;
  title: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  category: MonarchMemoryCategory;
  tier: MonarchMemoryTier;
  importance: number;
  priority: number;
  accessCount: number;
  pinned: boolean;
  decayRate: number;
  lastAccessedAt?: string;
  expiresAt?: string;
  closedAt?: string;
  relatedFiles: string[];
  relatedModules: string[];
}

export interface MonarchMemoryMetadata {
  type?: MonarchMemoryEntryType;
  title?: string;
  tags?: string[];
  category?: MonarchMemoryCategory;
  tier?: MonarchMemoryTier;
  importance?: number;
  priority?: number;
  pinned?: boolean;
  expiresAt?: string;
  relatedFiles?: string[];
  relatedModules?: string[];
}

export interface MonarchMemoryPatch extends MonarchMemoryMetadata {
  text?: string;
  closedAt?: string | null;
}

export interface MonarchMemorySearchFilters {
  types?: string[];
  tags?: string[];
  includeClosed?: boolean;
  includeExpired?: boolean;
}

export interface MonarchMemoryStoreOptions {
  filePath?: string;
}

interface MonarchMemoryStoreSnapshotV1 {
  version: 1;
  records: Array<{
    id: string;
    text: string;
    source: string;
    createdAt: string;
  }>;
}

interface MonarchMemoryStoreSnapshotV2 {
  version: 2;
  records: MonarchMemoryRecord[];
}

interface MonarchMemoryStoreSnapshotV3 {
  version: 3;
  records: MonarchMemoryRecord[];
}

interface NormalizedMemorySearchFilters {
  types: Set<string>;
  tags: Set<string>;
  includeClosed: boolean;
  includeExpired: boolean;
}

type MonarchMemoryStoreSnapshot = MonarchMemoryStoreSnapshotV1 | MonarchMemoryStoreSnapshotV2 | MonarchMemoryStoreSnapshotV3;

export class MonarchMemoryStore {
  private records: MonarchMemoryRecord[] = [];
  private loaded = false;
  private readonly searchTextCache = new WeakMap<MonarchMemoryRecord, string>();
  private persistWorker: Promise<void> | null = null;
  private persistRevision = 0;
  private persistedRevision = 0;
  private persistSequence = 0;

  constructor(private readonly options: MonarchMemoryStoreOptions = {}) {}

  get adapter(): 'in-memory' | 'local-json' {
    return this.options.filePath ? 'local-json' : 'in-memory';
  }

  get filePath(): string | undefined {
    return this.options.filePath;
  }

  get size(): number {
    return this.records.length;
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    if (!this.options.filePath) {
      return;
    }

    try {
      const raw = await readFile(this.options.filePath, 'utf8');
      this.records = readSnapshot(raw, this.options.filePath).records;
    } catch (error) {
      if (isMissingFileError(error)) {
        this.records = [];
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load memory store ${this.options.filePath}: ${message}`);
    }
  }

  async remember(
    text: string,
    source = 'user',
    metadata: MonarchMemoryMetadata = {}
  ): Promise<MonarchMemoryRecord> {
    const now = nowIso();
    const type = metadata.type || inferMemoryType(text);
    const importance = clampConfidence(metadata.priority ?? metadata.importance ?? defaultPriorityForType(type));
    const tier = metadata.tier || defaultTierFor(importance, Boolean(metadata.pinned));
    const title = normalizeMemoryTitle(metadata.title || inferTitle(text));
    const record: MonarchMemoryRecord = {
      id: createMonarchId('mem'),
      text: normalizeText(text),
      type,
      title,
      tags: normalizeTags(metadata.tags),
      source: source.trim() || 'user',
      createdAt: now,
      updatedAt: now,
      category: metadata.category || categoryForType(type, text),
      tier,
      importance,
      priority: importance,
      accessCount: 0,
      pinned: Boolean(metadata.pinned),
      decayRate: defaultDecayRateFor(tier),
      relatedFiles: normalizeStringList(metadata.relatedFiles, 24),
      relatedModules: normalizeStringList(metadata.relatedModules, 16),
    };
    const expiresAt = normalizeOptionalIso(metadata.expiresAt);
    if (expiresAt) {
      record.expiresAt = expiresAt;
    }

    this.records.push(record);
    await this.persist();
    return record;
  }

  async search(
    query: string,
    limit = 10,
    filters: MonarchMemorySearchFilters = {}
  ): Promise<MonarchMemoryRecord[]> {
    const normalizedQuery = normalizeText(query).toLowerCase();
    if (!normalizedQuery) {
      return this.list(limit, filters);
    }

    const terms = normalizedQuery.split(' ').filter(Boolean);
    const normalizedFilters = normalizeSearchFilters(filters);
    const records = this.records
      .filter((record) => memoryRecordMatchesFilters(record, normalizedFilters))
      .map((record) => ({
        record,
        score: scoreRecord(record, terms, this.searchText(record)),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, normalizeLimit(limit))
      .map((entry) => entry.record);
    if (records.length > 0) {
      const accessedAt = nowIso();
      for (const record of records) {
        record.accessCount += 1;
        record.lastAccessedAt = accessedAt;
      }
      await this.persist();
    }
    return records;
  }

  list(limit = 20, filters: MonarchMemorySearchFilters = {}): MonarchMemoryRecord[] {
    const normalizedFilters = normalizeSearchFilters(filters);
    return this.records
      .filter((record) => memoryRecordMatchesFilters(record, normalizedFilters))
      .slice(-normalizeLimit(limit))
      .reverse();
  }

  async update(id: string, patch: MonarchMemoryPatch): Promise<MonarchMemoryRecord | undefined> {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) {
      return undefined;
    }

    if (patch.text !== undefined) {
      record.text = normalizeText(patch.text);
    }
    if (patch.type !== undefined) {
      record.type = patch.type;
      record.category = patch.category || categoryForType(patch.type, record.text);
    }
    if (patch.title !== undefined) {
      record.title = normalizeMemoryTitle(patch.title || inferTitle(record.text));
    }
    if (patch.tags !== undefined) {
      record.tags = normalizeTags(patch.tags);
    }
    if (patch.category !== undefined) {
      record.category = patch.category;
    }
    if (patch.tier !== undefined) {
      record.tier = patch.tier;
      record.decayRate = defaultDecayRateFor(patch.tier);
    }
    if (patch.importance !== undefined) {
      record.importance = clampConfidence(patch.importance);
      record.priority = record.importance;
    }
    if (patch.priority !== undefined) {
      record.priority = clampConfidence(patch.priority);
      record.importance = record.priority;
    }
    if (patch.pinned !== undefined) {
      record.pinned = patch.pinned;
    }
    if (patch.expiresAt !== undefined) {
      const expiresAt = normalizeOptionalIso(patch.expiresAt);
      if (expiresAt) {
        record.expiresAt = expiresAt;
      } else {
        delete record.expiresAt;
      }
    }
    if (patch.closedAt !== undefined) {
      const closedAt = patch.closedAt === null ? '' : normalizeOptionalIso(patch.closedAt);
      if (closedAt) {
        record.closedAt = closedAt;
      } else {
        delete record.closedAt;
      }
    }
    if (patch.relatedFiles !== undefined) {
      record.relatedFiles = normalizeStringList(patch.relatedFiles, 24);
    }
    if (patch.relatedModules !== undefined) {
      record.relatedModules = normalizeStringList(patch.relatedModules, 16);
    }
    record.updatedAt = nowIso();
    this.searchTextCache.delete(record);
    await this.persist();
    return { ...record };
  }

  async closeTemporary(id: string, closedAt = nowIso()): Promise<MonarchMemoryRecord | undefined> {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) {
      return undefined;
    }
    record.closedAt = closedAt;
    record.updatedAt = closedAt;
    await this.persist();
    return { ...record };
  }

  async forget(id: string): Promise<MonarchMemoryRecord | undefined> {
    const index = this.records.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return undefined;
    }
    const [removed] = this.records.splice(index, 1);
    await this.persist();
    return removed ? { ...removed } : undefined;
  }

  private async persist(): Promise<void> {
    if (!this.options.filePath) {
      return;
    }

    this.persistRevision += 1;
    if (!this.persistWorker) {
      this.persistWorker = this.drainPersistQueue().finally(() => {
        this.persistWorker = null;
      });
    }
    return this.persistWorker;
  }

  private async drainPersistQueue(): Promise<void> {
    while (this.persistedRevision < this.persistRevision) {
      const targetRevision = this.persistRevision;
      await this.writeSnapshot();
      this.persistedRevision = targetRevision;
    }
  }

  private async writeSnapshot(): Promise<void> {
    const snapshot: MonarchMemoryStoreSnapshot = {
      version: 3,
      records: this.records,
    };
    const filePath = this.options.filePath!;
    const directory = path.dirname(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${this.persistSequence++}.tmp`;

    await mkdir(directory, { recursive: true });
    try {
      await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
      await replaceFileWithRetry(tempPath, filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private searchText(record: MonarchMemoryRecord): string {
    const cached = this.searchTextCache.get(record);
    if (cached !== undefined) {
      return cached;
    }
    const value = `${record.title} ${record.text} ${record.type} ${record.category} ${record.tags.join(' ')} ${record.relatedModules.join(' ')} ${record.source}`.toLowerCase();
    this.searchTextCache.set(record, value);
    return value;
  }
}

export function defaultMemoryStorePath(workspaceRoot = process.cwd()): string {
  return path.join(workspaceRoot, 'data', 'local', 'memory.json');
}

function readSnapshot(raw: string, filePath: string): MonarchMemoryStoreSnapshotV3 {
  const parsed = JSON.parse(raw) as { version?: unknown; records?: unknown };
  if (!Array.isArray(parsed.records)) {
    throw new Error('memory store must contain records array.');
  }

  if (parsed.version === 1) {
    return {
      version: 3,
      records: parsed.records.map((record, index) => readLegacyRecord(record, filePath, index)),
    };
  }

  if (parsed.version !== 2 && parsed.version !== 3) {
    throw new Error('memory store must contain version=1, version=2, or version=3.');
  }

  return {
    version: 3,
    records: parsed.records.map((record, index) => readRecord(record, filePath, index)),
  };
}

function readLegacyRecord(record: unknown, filePath: string, index: number): MonarchMemoryRecord {
  if (!record || typeof record !== 'object') {
    throw new Error(`invalid memory record at ${filePath}#${index}.`);
  }

  const data = record as Record<string, unknown>;
  const text = readRequiredString(data, 'text', filePath, index);
  const createdAt = readRequiredString(data, 'createdAt', filePath, index);
  return {
    id: readRequiredString(data, 'id', filePath, index),
    text,
    type: inferMemoryType(text),
    title: inferTitle(text),
    tags: [],
    source: readRequiredString(data, 'source', filePath, index),
    createdAt,
    updatedAt: createdAt,
    category: inferCategory(text),
    tier: 'long',
    importance: 0.55,
    priority: 0.55,
    accessCount: 0,
    pinned: false,
    decayRate: defaultDecayRateFor('long'),
    relatedFiles: [],
    relatedModules: [],
  };
}

function readRecord(rawRecord: unknown, filePath: string, index: number): MonarchMemoryRecord {
  if (!rawRecord || typeof rawRecord !== 'object') {
    throw new Error(`invalid memory record at ${filePath}#${index}.`);
  }

  const data = rawRecord as Record<string, unknown>;
  const id = readRequiredString(data, 'id', filePath, index);
  const text = readRequiredString(data, 'text', filePath, index);
  const source = readRequiredString(data, 'source', filePath, index);
  const createdAt = readRequiredString(data, 'createdAt', filePath, index);
  const updatedAt = readOptionalString(data, 'updatedAt') || createdAt;
  const type = readMemoryType(data.type, text, data.category);
  const category = readCategory(data.category, text, type);
  const importance = clampConfidence(readOptionalNumber(data.priority, readOptionalNumber(data.importance, defaultPriorityForType(type))));
  const tier = readTier(data.tier, importance, Boolean(data.pinned));
  const lastAccessedAt = readOptionalString(data, 'lastAccessedAt');
  const memoryRecord: MonarchMemoryRecord = {
    id,
    text,
    type,
    title: normalizeMemoryTitle(readOptionalString(data, 'title') || inferTitle(text)),
    tags: normalizeTags(readOptionalStringArray(data.tags)),
    source,
    createdAt,
    updatedAt,
    category,
    tier,
    importance,
    priority: importance,
    accessCount: Math.max(0, Math.floor(readOptionalNumber(data.accessCount, 0))),
    pinned: Boolean(data.pinned),
    decayRate: readOptionalNumber(data.decayRate, defaultDecayRateFor(tier)),
    relatedFiles: normalizeStringList(readOptionalStringArray(data.relatedFiles), 24),
    relatedModules: normalizeStringList(readOptionalStringArray(data.relatedModules), 16),
  };

  if (lastAccessedAt) {
    memoryRecord.lastAccessedAt = lastAccessedAt;
  }
  const expiresAt = normalizeOptionalIso(readOptionalString(data, 'expiresAt'));
  if (expiresAt) {
    memoryRecord.expiresAt = expiresAt;
  }
  const closedAt = normalizeOptionalIso(readOptionalString(data, 'closedAt'));
  if (closedAt) {
    memoryRecord.closedAt = closedAt;
  }
  return memoryRecord;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: keyof MonarchMemoryRecord,
  filePath: string,
  index: number
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`memory record ${filePath}#${index} has invalid ${key}.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function readOptionalNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function replaceFileWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!isTransientReplaceError(error) || attempt >= 7) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 8 * (attempt + 1)));
    }
  }
}

function isTransientReplaceError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function scoreRecord(record: MonarchMemoryRecord, terms: string[], haystack: string): number {
  const termScore = terms.reduce((score, term) => score + (haystack.includes(term) ? 2 : 0), 0);
  const exactScore = haystack.includes(terms.join(' ')) ? 3 : 0;
  const tierScore = record.tier === 'permanent' ? 1.4 : record.tier === 'long' ? 0.7 : 0;
  const pinnedScore = record.pinned ? 1.2 : 0;
  const accessScore = Math.min(record.accessCount * 0.05, 0.5);
  const typeScore = record.type === 'project_decision' || record.type === 'architecture_note' ? 0.35 : 0;
  return termScore + exactScore + record.priority + tierScore + pinnedScore + accessScore + typeScore;
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(Math.floor(Number(limit) || 20), 100));
}

function inferCategory(text: string): MonarchMemoryCategory {
  if (/(prefer|preference|like|style|tone|предпоч|люблю|стиль)/i.test(text)) {
    return 'preference';
  }
  if (/(project|monarch|repo|workspace|проект|репозитор)/i.test(text)) {
    return 'project';
  }
  if (/(correction|actually|fix|исправ|на самом деле)/i.test(text)) {
    return 'correction';
  }
  if (/(note|замет|todo|task)/i.test(text)) {
    return 'note';
  }
  return 'fact';
}

function inferMemoryType(text: string): MonarchMemoryEntryType {
  if (/(prefer|preference|like|style|tone|предпоч|люблю|стиль)/i.test(text)) {
    return 'user_preference';
  }
  if (/(decision|decided|adr|решили|решение|договорились)/i.test(text)) {
    return 'project_decision';
  }
  if (/(architecture|architectural|contract|pipeline|архитектур|контракт|пайплайн)/i.test(text)) {
    return 'architecture_note';
  }
  if (/(active bug|bug|regression|ошибка|баг|регресс)/i.test(text)) {
    return 'active_bug';
  }
  if (/(fixed bug|resolved|исправлено|починено|закрыт баг)/i.test(text)) {
    return 'fixed_bug';
  }
  if (/(debt|todo|cleanup|долг|техдолг|почистить)/i.test(text)) {
    return 'technical_debt';
  }
  if (/(temporary|temp|task|временно|задача|следующ)/i.test(text)) {
    return 'temporary_task';
  }
  if (/(module state|state|status|состояни|статус модуля)/i.test(text)) {
    return 'module_state';
  }
  if (/(handoff|agent|session|передач|handoff|агент)/i.test(text)) {
    return 'handoff_note';
  }
  if (/(diagnostic|diagnostics|health|диагност|проверка)/i.test(text)) {
    return 'diagnostic_note';
  }
  return 'planning_note';
}

function readMemoryType(value: unknown, text: string, legacyCategory: unknown): MonarchMemoryEntryType {
  if (isMemoryEntryType(value)) {
    return value;
  }
  if (legacyCategory === 'preference') return 'user_preference';
  if (legacyCategory === 'project') return 'architecture_note';
  if (legacyCategory === 'correction') return 'fixed_bug';
  if (legacyCategory === 'note') return 'planning_note';
  return inferMemoryType(text);
}

function isMemoryEntryType(value: unknown): value is MonarchMemoryEntryType {
  return value === 'user_preference'
    || value === 'project_decision'
    || value === 'architecture_note'
    || value === 'active_bug'
    || value === 'fixed_bug'
    || value === 'technical_debt'
    || value === 'temporary_task'
    || value === 'module_state'
    || value === 'handoff_note'
    || value === 'diagnostic_note'
    || value === 'planning_note';
}

function categoryForType(type: MonarchMemoryEntryType, text: string): MonarchMemoryCategory {
  switch (type) {
  case 'user_preference':
    return 'preference';
  case 'project_decision':
  case 'architecture_note':
  case 'module_state':
  case 'handoff_note':
    return 'project';
  case 'active_bug':
  case 'fixed_bug':
    return 'correction';
  case 'technical_debt':
  case 'temporary_task':
  case 'diagnostic_note':
    return 'note';
  default:
    return inferCategory(text);
  }
}

function readCategory(value: unknown, text: string, type: MonarchMemoryEntryType): MonarchMemoryCategory {
  return value === 'fact'
    || value === 'preference'
    || value === 'project'
    || value === 'correction'
    || value === 'note'
    ? value
    : categoryForType(type, text);
}

function readTier(
  value: unknown,
  importance: number,
  pinned: boolean
): MonarchMemoryTier {
  if (value === 'working' || value === 'long' || value === 'permanent') {
    return value;
  }
  return defaultTierFor(importance, pinned);
}

function defaultTierFor(importance: number, pinned: boolean): MonarchMemoryTier {
  if (pinned || importance >= 0.9) {
    return 'permanent';
  }
  if (importance <= 0.35) {
    return 'working';
  }
  return 'long';
}

function defaultPriorityForType(type: MonarchMemoryEntryType): number {
  switch (type) {
  case 'user_preference':
  case 'project_decision':
  case 'architecture_note':
    return 0.75;
  case 'active_bug':
  case 'technical_debt':
  case 'diagnostic_note':
    return 0.7;
  case 'temporary_task':
    return 0.45;
  default:
    return 0.55;
  }
}

function defaultDecayRateFor(tier: MonarchMemoryTier): number {
  switch (tier) {
  case 'permanent':
    return 0;
  case 'long':
    return 0.02;
  case 'working':
    return 0.08;
  }
}

function inferTitle(text: string): string {
  const cleaned = normalizeText(text).replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return 'Memory entry';
  }
  const firstSentence = cleaned.split(/[.!?\n]/)[0]?.trim() || cleaned;
  return normalizeMemoryTitle(firstSentence);
}

function normalizeMemoryTitle(value: string): string {
  const cleaned = normalizeText(value).replace(/\s+/g, ' ').trim();
  return (cleaned || 'Memory entry').slice(0, 120);
}

function normalizeTags(values: string[] | undefined): string[] {
  return normalizeStringList(values, 20).map((tag) => tag.replace(/^#/, '').toLowerCase());
}

function normalizeStringList(values: string[] | undefined, limit: number): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(new Set(values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .filter(Boolean)))
    .slice(0, limit);
}

function normalizeOptionalIso(value: string | undefined): string {
  if (!value) {
    return '';
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return '';
  }
  const timestamp = Date.parse(cleaned);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : cleaned;
}

function normalizeSearchFilters(filters: MonarchMemorySearchFilters): NormalizedMemorySearchFilters {
  return {
    types: new Set((filters.types || []).map((type) => type.trim()).filter(Boolean)),
    tags: new Set((filters.tags || []).map((tag) => tag.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)),
    includeClosed: filters.includeClosed === true,
    includeExpired: filters.includeExpired === true,
  };
}

function memoryRecordMatchesFilters(record: MonarchMemoryRecord, filters: NormalizedMemorySearchFilters): boolean {
  if (!filters.includeClosed && record.closedAt) {
    return false;
  }
  if (!filters.includeExpired && isExpired(record)) {
    return false;
  }
  if (filters.types.size > 0 && !filters.types.has(record.type) && !filters.types.has(record.category)) {
    return false;
  }
  if (filters.tags.size > 0 && !record.tags.some((tag) => filters.tags.has(tag))) {
    return false;
  }
  return true;
}

function isExpired(record: MonarchMemoryRecord): boolean {
  if (!record.expiresAt) {
    return false;
  }
  const timestamp = Date.parse(record.expiresAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}
