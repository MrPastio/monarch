import path from 'node:path';
import { nowIso, normalizeText, uniqueStrings } from '../../core';
import { DurableJsonFile } from '../../core/durable-json-file';

export interface MonarchProfile {
  version: 1;
  displayName: string;
  adaptiveSummary: string;
  traits: string[];
  styleRules: string[];
  boundaries: string[];
  preferences: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface MonarchProfilePatch {
  displayName?: string;
  adaptiveSummary?: string;
  traits?: string[];
  styleRules?: string[];
  boundaries?: string[];
  preferences?: Record<string, string>;
}

export interface MonarchProfileStoreOptions {
  filePath?: string;
}

export class MonarchProfileStore {
  private profile = createDefaultProfile();
  private loaded = false;
  private readonly durableFile?: DurableJsonFile<Record<string, unknown>>;

  constructor(private readonly options: MonarchProfileStoreOptions = {}) {
    if (options.filePath) {
      this.durableFile = new DurableJsonFile(options.filePath, {
        createEmpty: () => ({ ...createDefaultProfile() }),
        validate: assertProfileDocument,
      });
    }
  }

  get adapter(): 'in-memory' | 'local-json' {
    return this.options.filePath ? 'local-json' : 'in-memory';
  }

  get filePath(): string | undefined {
    return this.options.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!this.durableFile) {
      this.loaded = true;
      return;
    }

    try {
      this.profile = await this.durableFile.mutate((document) => {
        const normalized = normalizeProfile(document);
        replaceProfileDocument(document, normalized);
        return { changed: true, value: normalized };
      });
      this.loaded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load profile store ${this.options.filePath}: ${message}`);
    }
  }

  read(): MonarchProfile {
    return cloneProfile(this.profile);
  }

  async update(patch: MonarchProfilePatch): Promise<MonarchProfile> {
    if (!this.durableFile) {
      this.profile = applyProfilePatch(this.profile, patch);
      return this.read();
    }

    const updated = await this.durableFile.mutate((document) => {
      const next = applyProfilePatch(normalizeProfile(document), patch);
      replaceProfileDocument(document, next);
      return { changed: true, value: next };
    });
    this.profile = updated;
    return this.read();
  }
}

export function defaultProfileStorePath(workspaceRoot = process.cwd()): string {
  return path.join(workspaceRoot, 'data', 'local', 'profile.json');
}

function createDefaultProfile(): MonarchProfile {
  const now = nowIso();
  return {
    version: 1,
    displayName: 'Monarch',
    adaptiveSummary: '',
    traits: [],
    styleRules: [],
    boundaries: [],
    preferences: {},
    createdAt: now,
    updatedAt: now,
  };
}

function assertProfileDocument(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('profile must be an object.');
  }
}

function applyProfilePatch(profile: MonarchProfile, patch: MonarchProfilePatch): MonarchProfile {
  const normalizedPatch = normalizePatch(patch);
  return normalizeProfile({
    ...profile,
    ...normalizedPatch,
    preferences: {
      ...profile.preferences,
      ...(normalizedPatch.preferences || {}),
    },
    updatedAt: nowIso(),
  });
}

function replaceProfileDocument(document: Record<string, unknown>, profile: MonarchProfile): void {
  for (const key of Object.keys(document)) delete document[key];
  Object.assign(document, profile);
}

function normalizeProfile(value: Record<string, unknown>): MonarchProfile {
  const fallback = createDefaultProfile();
  return {
    version: 1,
    displayName: readString(value.displayName) || fallback.displayName,
    adaptiveSummary: readString(value.adaptiveSummary),
    traits: readStringArray(value.traits),
    styleRules: readStringArray(value.styleRules),
    boundaries: readStringArray(value.boundaries),
    preferences: readStringRecord(value.preferences),
    createdAt: readString(value.createdAt) || fallback.createdAt,
    updatedAt: readString(value.updatedAt) || fallback.updatedAt,
  };
}

function normalizePatch(patch: MonarchProfilePatch): MonarchProfilePatch {
  const normalized: MonarchProfilePatch = {};
  if (patch.displayName !== undefined) {
    normalized.displayName = normalizeText(patch.displayName);
  }
  if (patch.adaptiveSummary !== undefined) {
    normalized.adaptiveSummary = normalizeText(patch.adaptiveSummary);
  }
  if (patch.traits !== undefined) {
    normalized.traits = uniqueStrings(patch.traits);
  }
  if (patch.styleRules !== undefined) {
    normalized.styleRules = uniqueStrings(patch.styleRules);
  }
  if (patch.boundaries !== undefined) {
    normalized.boundaries = uniqueStrings(patch.boundaries);
  }
  if (patch.preferences !== undefined) {
    normalized.preferences = readStringRecord(patch.preferences);
  }
  return normalized;
}

function cloneProfile(profile: MonarchProfile): MonarchProfile {
  return {
    ...profile,
    traits: [...profile.traits],
    styleRules: [...profile.styleRules],
    boundaries: [...profile.boundaries],
    preferences: { ...profile.preferences },
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.map((entry) => String(entry || '').trim()))
    : [];
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entryValue]) => [key.trim(), readString(entryValue)] as const)
    .filter(([key, entryValue]) => key && entryValue);
  return Object.fromEntries(entries);
}
