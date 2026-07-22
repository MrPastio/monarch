import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import { permissionModeForRisk } from '../../core';
import { profileManifest } from './manifest';
import {
  defaultProfileStorePath,
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

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.trim();
    if (!/(?:\b(?:monarch|user|my|assistant) profile\b|\bprofile (?:settings|preferences|rules)\b|\b(?:set|update|save|remember|show|read) (?:my )?(?:profile|preference|style rule|boundary)\b)/i.test(text)) {
      return null;
    }

    if (/(update|set|save|remember|add)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'profile.update',
        confidence: 0.74,
        reason: 'User asks to update local profile preferences.',
        permissionMode: permissionModeForRisk('write'),
        input: inferProfilePatch(text),
      };
    }

    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'profile.read',
      confidence: 0.9,
      reason: 'User asks to read local profile.',
      permissionMode: permissionModeForRisk('read'),
      input: {},
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

function inferProfilePatch(text: string): MonarchProfilePatch {
  const preference = text.match(/\bpreference\s+([a-z0-9_.-]+)\s*=\s*(.+)$/i);
  if (preference?.[1] && preference[2]) {
    return {
      preferences: {
        [preference[1].trim()]: preference[2].trim(),
      },
    };
  }

  return {
    adaptiveSummary: text.replace(/^(update|set|save|remember|add)\s+/i, '').trim(),
  };
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

  return defaultProfileStorePath(options.workspaceRoot || process.cwd());
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
