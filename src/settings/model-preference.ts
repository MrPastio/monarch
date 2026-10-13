import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MAX_CLOUD_CONTEXT_CHOICES, MAX_CLOUD_OUTPUT_CHOICES, setMaxCloudLimitChoice } from '../agent-v3/max-cloud-limits';
import { renameWithWindowsRetrySync } from '../core/durable-json';

/** Where Oscar thinks by default, chosen in the first setup and in Settings.
 * `hybrid` means MAX answers and an installed local model stands by. */
export type MonarchWorkPreference = 'local' | 'max' | 'hybrid';

export interface MonarchModelPreferenceV1 {
  schemaVersion: 1;
  work: MonarchWorkPreference | null;
  /** When MAX does not answer a chat message, answer it with the local model.
   * Owner decision 2026-09-26: on by default, can be switched off. The paid
   * cloud request is never repeated; the local answer is labelled as such. */
  maxLocalFallback: boolean;
  /** Answer size and context window for cloud MAX; `null` is automatic. Owner
   * decision 2026-09-28: these are the person's settings, not local-model limits. */
  maxOutputTokens: number | null;
  maxContextTokens: number | null;
  updatedAt: string;
}

const WORK_VALUES = new Set<MonarchWorkPreference>(['local', 'max', 'hybrid']);

export const DEFAULT_MODEL_PREFERENCE: Readonly<MonarchModelPreferenceV1> = Object.freeze({
  schemaVersion: 1,
  work: null,
  maxLocalFallback: true,
  maxOutputTokens: null,
  maxContextTokens: null,
  updatedAt: '',
});

export class LocalModelPreferenceStore {
  private readonly filePath: string;

  constructor(stateRoot: string) {
    this.filePath = path.join(stateRoot, 'settings', 'model-preference.v1.json');
    this.applyLimits(this.snapshot());
  }

  private applyLimits(value: MonarchModelPreferenceV1): void {
    setMaxCloudLimitChoice({ outputTokens: value.maxOutputTokens, contextTokens: value.maxContextTokens });
  }

  /** Another host process may have saved the preference since this store loaded. */
  refreshLimits(): void {
    this.applyLimits(this.snapshot());
  }

  snapshot(): MonarchModelPreferenceV1 {
    try {
      if (!existsSync(this.filePath)) return { ...DEFAULT_MODEL_PREFERENCE };
      const value = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<MonarchModelPreferenceV1>;
      if (value?.schemaVersion !== 1) return { ...DEFAULT_MODEL_PREFERENCE };
      return {
        schemaVersion: 1,
        work: WORK_VALUES.has(value.work as MonarchWorkPreference) ? value.work as MonarchWorkPreference : null,
        maxLocalFallback: typeof value.maxLocalFallback === 'boolean' ? value.maxLocalFallback : true,
        maxOutputTokens: choiceOrNull(value.maxOutputTokens, MAX_CLOUD_OUTPUT_CHOICES),
        maxContextTokens: choiceOrNull(value.maxContextTokens, MAX_CLOUD_CONTEXT_CHOICES),
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt.slice(0, 40) : '',
      };
    } catch {
      return { ...DEFAULT_MODEL_PREFERENCE };
    }
  }

  update(input: { work?: unknown; maxLocalFallback?: unknown; maxOutputTokens?: unknown; maxContextTokens?: unknown }): MonarchModelPreferenceV1 {
    if (!input || typeof input !== 'object') throw new Error('model-preference-invalid');
    const current = this.snapshot();
    const next: MonarchModelPreferenceV1 = { ...current, updatedAt: new Date().toISOString() };
    if ('work' in input && input.work !== undefined) {
      if (!WORK_VALUES.has(input.work as MonarchWorkPreference)) throw new Error('model-preference-work');
      next.work = input.work as MonarchWorkPreference;
    }
    if ('maxLocalFallback' in input && input.maxLocalFallback !== undefined) {
      if (typeof input.maxLocalFallback !== 'boolean') throw new Error('model-preference-fallback');
      next.maxLocalFallback = input.maxLocalFallback;
    }
    if ('maxOutputTokens' in input && input.maxOutputTokens !== undefined) {
      next.maxOutputTokens = strictChoice(input.maxOutputTokens, MAX_CLOUD_OUTPUT_CHOICES, 'model-preference-output');
    }
    if ('maxContextTokens' in input && input.maxContextTokens !== undefined) {
      next.maxContextTokens = strictChoice(input.maxContextTokens, MAX_CLOUD_CONTEXT_CHOICES, 'model-preference-context');
    }
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
    renameWithWindowsRetrySync(temporary, this.filePath);
    this.applyLimits(next);
    return next;
  }
}

function choiceOrNull(value: unknown, allowed: readonly number[]): number | null {
  return typeof value === 'number' && allowed.includes(value) ? value : null;
}

/** `null` returns to automatic; anything else must be one of the offered values. */
function strictChoice(value: unknown, allowed: readonly number[], code: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !allowed.includes(value)) throw new Error(code);
  return value;
}
