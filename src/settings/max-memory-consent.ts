import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseCloudRole } from '../agent-v3/max-cloud-catalog';
import { renameWithWindowsRetrySync } from '../core/durable-json';

/** Bump when the disclosure changes: earlier answers stop counting. */
export const MAX_MEMORY_CONSENT_VERSION = 'max-memory-v1';

export type MaxMemoryConsentDecision = 'granted' | 'declined' | 'undecided';

interface StoredMaxMemoryConsentV1 {
  schemaVersion: 1;
  providers: Record<string, { decision: 'granted' | 'declined'; version: string; decidedAt: string }>;
}

const PROVIDER_ID = /^[a-z]{2,20}$/u;

/** The cloud service a MAX role sends its request to. Groq roles carry no provider prefix. */
export function maxMemoryProviderOfRole(role: string): string {
  return parseCloudRole(role)?.providerId ?? 'groq';
}

/** Owner's per-service answer to "may MAX see my memory". Memory goes to a
 * cloud service only after an explicit, confirmed grant for that exact service
 * and the current disclosure version; anything else reads as not granted. */
export class LocalMaxMemoryConsentStore {
  private readonly filePath: string;

  constructor(stateRoot: string) {
    this.filePath = path.join(stateRoot, 'settings', 'max-memory-consent.v1.json');
  }

  decision(providerId: string): MaxMemoryConsentDecision {
    if (!PROVIDER_ID.test(providerId)) return 'undecided';
    const record = this.read().providers[providerId];
    return record && record.version === MAX_MEMORY_CONSENT_VERSION ? record.decision : 'undecided';
  }

  granted(providerId: string): boolean {
    return this.decision(providerId) === 'granted';
  }

  decide(input: { providerId?: unknown; decision?: unknown; confirmed?: unknown; version?: unknown }): MaxMemoryConsentDecision {
    const providerId = typeof input.providerId === 'string' ? input.providerId : '';
    if (!PROVIDER_ID.test(providerId)) throw new Error('max-memory-consent-provider');
    if (input.decision !== 'granted' && input.decision !== 'declined') throw new Error('max-memory-consent-decision');
    // A grant needs the owner's separate confirmation of the current disclosure.
    if (input.decision === 'granted' && (input.confirmed !== true || input.version !== MAX_MEMORY_CONSENT_VERSION)) {
      throw new Error('max-memory-consent-confirmation');
    }
    const state = this.read();
    state.providers[providerId] = { decision: input.decision, version: MAX_MEMORY_CONSENT_VERSION, decidedAt: new Date().toISOString() };
    this.write(state);
    return input.decision;
  }

  private read(): StoredMaxMemoryConsentV1 {
    try {
      if (!existsSync(this.filePath)) return { schemaVersion: 1, providers: {} };
      const value = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredMaxMemoryConsentV1;
      if (value?.schemaVersion !== 1 || !value.providers || typeof value.providers !== 'object') return { schemaVersion: 1, providers: {} };
      const providers: StoredMaxMemoryConsentV1['providers'] = {};
      for (const [id, record] of Object.entries(value.providers)) {
        if (PROVIDER_ID.test(id) && (record?.decision === 'granted' || record?.decision === 'declined')
          && typeof record.version === 'string' && typeof record.decidedAt === 'string') providers[id] = record;
      }
      return { schemaVersion: 1, providers };
    } catch {
      // A damaged record never grants anything.
      return { schemaVersion: 1, providers: {} };
    }
  }

  private write(state: StoredMaxMemoryConsentV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
    renameWithWindowsRetrySync(temporary, this.filePath);
  }
}
