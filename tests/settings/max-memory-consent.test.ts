import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalMaxMemoryConsentStore, MAX_MEMORY_CONSENT_VERSION, maxMemoryProviderOfRole } from '../../src/settings/max-memory-consent';
import { maxMemoryAdmitted } from '../../src/app/oscar-turn-runtime';
import { DEFAULT_OWNER_DEV_SETTINGS } from '../../src/settings';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const store = () => { const root = mkdtempSync(path.join(os.tmpdir(), 'max-memory-consent-')); roots.push(root); return { root, consent: new LocalMaxMemoryConsentStore(root) }; };

describe('MAX memory consent', () => {
  it('grants only with confirmation of the current disclosure, per service', () => {
    const { root, consent } = store();
    expect(consent.decision('deepseek')).toBe('undecided');
    expect(() => consent.decide({ providerId: 'deepseek', decision: 'granted' })).toThrow('confirmation');
    expect(() => consent.decide({ providerId: 'deepseek', decision: 'granted', confirmed: true, version: 'old' })).toThrow('confirmation');
    consent.decide({ providerId: 'deepseek', decision: 'granted', confirmed: true, version: MAX_MEMORY_CONSENT_VERSION });
    expect(new LocalMaxMemoryConsentStore(root).granted('deepseek')).toBe(true);
    expect(consent.granted('openai')).toBe(false);
    consent.decide({ providerId: 'deepseek', decision: 'declined' });
    expect(consent.decision('deepseek')).toBe('declined');
  });
  it('treats a damaged or outdated record as not granted', () => {
    const { root, consent } = store();
    mkdirSync(path.join(root, 'settings'), { recursive: true });
    const file = path.join(root, 'settings', 'max-memory-consent.v1.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, providers: { deepseek: { decision: 'granted', version: 'max-memory-v0', decidedAt: 'x' } } }));
    expect(consent.decision('deepseek')).toBe('undecided');
    writeFileSync(file, '{broken');
    expect(consent.granted('deepseek')).toBe(false);
  });
  it('admits memory only for a granted service in a saved chat with memory on', () => {
    const { consent } = store();
    consent.decide({ providerId: 'deepseek', decision: 'granted', confirmed: true, version: MAX_MEMORY_CONSENT_VERSION });
    const turn = (requestedModel: string, privacyMode = 'persistent') => ({ turn: { privacyMode, request: { modifiers: { requestedModel } } } }) as any;
    const dev = { ...DEFAULT_OWNER_DEV_SETTINGS };
    expect(maxMemoryProviderOfRole('max-cloud:deepseek:deepseek-chat')).toBe('deepseek');
    expect(maxMemoryProviderOfRole('max-gpt-oss-120b')).toBe('groq');
    expect(maxMemoryAdmitted(turn('max-cloud:deepseek:deepseek-chat'), dev, consent)).toBe(true);
    expect(maxMemoryAdmitted(turn('max-gpt-oss-120b'), dev, consent)).toBe(false);
    expect(maxMemoryAdmitted(turn('max-cloud:deepseek:deepseek-chat', 'incognito'), dev, consent)).toBe(false);
    expect(maxMemoryAdmitted(turn('max-cloud:deepseek:deepseek-chat'), { ...dev, memoryEnabled: false }, consent)).toBe(false);
    expect(maxMemoryAdmitted(turn('max-cloud:deepseek:deepseek-chat'), { ...dev, zeroRetentionEnabled: true }, consent)).toBe(false);
    expect(maxMemoryAdmitted(turn('max-cloud:deepseek:deepseek-chat'), dev, undefined)).toBe(false);
  });
});
