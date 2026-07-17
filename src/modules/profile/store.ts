import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nowIso, normalizeText, uniqueStrings } from '../../core';

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

  constructor(private readonly options: MonarchProfileStoreOptions = {}) {}

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
    this.loaded = true;

    if (!this.options.filePath) {
      return;
    }

    try {
      const raw = await readFile(this.options.filePath, 'utf8');
      this.profile = readProfile(raw, this.options.filePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        await this.persist();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load profile store ${this.options.filePath}: ${message}`);
    }
  }

  read(): MonarchProfile {
    return cloneProfile(this.profile);
  }

  async update(patch: MonarchProfilePatch): Promise<MonarchProfile> {
    this.profile = normalizeProfile({
      ...this.profile,
      ...normalizePatch(patch),
      preferences: {
        ...this.profile.preferences,
        ...(patch.preferences || {}),
      },
      updatedAt: nowIso(),
    });
    await this.persist();
    return this.read();
  }

  private async persist(): Promise<void> {
    if (!this.options.filePath) {
      return;
    }

    const directory = path.dirname(this.options.filePath);
    const tempPath = `${this.options.filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(this.profile, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.options.filePath);
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

function readProfile(raw: string, filePath: string): MonarchProfile {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`profile ${filePath} must be an object.`);
  }
  return normalizeProfile(parsed as Record<string, unknown>);
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

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
  );
}
