import path from 'node:path';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
} from '../../core';
import { resolveMonarchRuntimePaths } from '../../core';
import { profileManifest } from './manifest';
import {
  MonarchProfileStore,
  type MonarchProfilePatch,
} from './store';

export interface ProfileModuleOptions {
  store?: MonarchProfileStore;
  storePath?: string | false;
  workspaceRoot?: string;
}

export class ProfileModule implements MonarchModule {
  readonly manifest = profileManifest;
  private readonly store: MonarchProfileStore;

  constructor(options: ProfileModuleOptions = {}) {
    const filePath = resolveProfileStorePath(options);
    this.store = options.store || new MonarchProfileStore(filePath ? { filePath } : {});
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await this.store.load();
    await context.emit('profile.activated', this.manifest.id, {
      adapter: this.store.adapter,
      filePath: this.store.filePath,
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: `Profile module ready with ${this.store.adapter} store.`,
      output: {
        adapter: this.store.adapter,
        filePath: this.store.filePath,
      },
    };
  }


  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'profile.read':
      return {
        ok: true,
        summary: 'Profile loaded.',
        output: { profile: this.store.read() },
      };
    case 'profile.update':
      return this.updateProfile(request.input, context);
    default:
      return {
        ok: false,
        summary: `Unsupported profile capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private async updateProfile(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const patch = readPatch(input);
    const profile = await this.store.update(patch);
    await context.emit('profile.updated', this.manifest.id, {
      filePath: this.store.filePath,
      fields: Object.keys(patch),
    });

    return {
      ok: true,
      summary: 'Profile updated.',
      output: { profile },
    };
  }
}

function readPatch(input: unknown): MonarchProfilePatch {
  if (!input || typeof input !== 'object') {
    return {};
  }
  const record = input as Record<string, unknown>;
  const patch: MonarchProfilePatch = {};
  const displayName = readString(record.displayName);
  const adaptiveSummary = readString(record.adaptiveSummary);
  const traits = readStringArray(record.traits);
  const styleRules = readStringArray(record.styleRules);
  const boundaries = readStringArray(record.boundaries);
  const preferences = readPreferences(record.preferences);

  if (Object.hasOwn(record, 'displayName')) {
    patch.displayName = displayName;
  }
  if (Object.hasOwn(record, 'adaptiveSummary')) {
    patch.adaptiveSummary = adaptiveSummary;
  }
  if (Object.hasOwn(record, 'traits')) {
    patch.traits = traits;
  }
  if (Object.hasOwn(record, 'styleRules')) {
    patch.styleRules = styleRules;
  }
  if (Object.hasOwn(record, 'boundaries')) {
    patch.boundaries = boundaries;
  }
  if (Object.keys(preferences).length > 0) {
    patch.preferences = preferences;
  }
  return patch;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
}

function readPreferences(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => [key.trim(), readString(entryValue)] as const)
      .filter(([key, entryValue]) => key && entryValue)
  );
}

function resolveProfileStorePath(options: ProfileModuleOptions): string | undefined {
  if (options.storePath === false) {
    return undefined;
  }
  if (typeof options.storePath === 'string') {
    return options.storePath;
  }

  const configuredPath = (
    process.env.MONARCH_PROFILE_STORE_PATH
    || process.env.MONARCH_PROFILE_PATH
    || ''
  ).trim();

  if (/^(off|none|memory)$/i.test(configuredPath)) {
    return undefined;
  }
  if (configuredPath) {
    return configuredPath;
  }

  const workspaceRoot = options.workspaceRoot || process.cwd();
  return path.join(resolveMonarchRuntimePaths(workspaceRoot).dataRoot, 'profile.json');
}

export function createProfileModule(options: ProfileModuleOptions = {}): MonarchModule {
  return new ProfileModule(options);
}

export const profileModulePackage: MonarchModulePackage = {
  id: profileManifest.id,
  moduleId: profileManifest.id,
  version: profileManifest.version,
  description: profileManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createProfileModule,
};
