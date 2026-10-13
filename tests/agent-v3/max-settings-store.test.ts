import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_CLOUD_AGREEMENT } from '../../src/agent-v3/max-cloud-catalog';
import { ASTRA_MAX_PROVIDER_AGREEMENT_VERSION } from '../../src/agent-v3/max-provider-contract';
import { AstraMaxSettingsError, AstraMaxSettingsStore } from '../../src/agent-v3/max-settings-store';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const KEY = 'gsk_fixture_only_12345678901234567890';
const roots: string[] = [];
const protectedStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8').map(byte => byte ^ 0xa5),
  decryptString: (value: Buffer) => Buffer.from(value).map(byte => byte ^ 0xa5).toString('utf8'),
};
const consent = {
  agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
  providerId: 'groq' as const,
  acceptedAt: '2026-09-04T11:59:00.000Z',
  nonLocalProcessingAcknowledged: true as const,
  selectedContextAcknowledged: true as const,
  providerTermsAcknowledged: true as const,
};

beforeAll(async () => { await mkdir(path.join(process.cwd(), 'runtime'), { recursive: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(process.cwd(), 'runtime', 'astra-max-settings-'));
  roots.push(value);
  return value;
}
function store(rootPath: string, overrides: Record<string, unknown> = {}) {
  return new AstraMaxSettingsStore({ deployment: 'isolated-validation', rootPath, protectedStorage,
    restrictAccess: async () => true, now: () => NOW, randomId: () => 'record_1', ...overrides });
}

describe('Astra MAX protected settings store', () => {
  it('persists one OS-protected record and returns no credential from status', async () => {
    const location = await root();
    const settings = store(location);
    await expect(settings.status()).resolves.toMatchObject({ state: 'not-configured', acceptedAt: null });
    await expect(settings.saveSetup({ apiKey: KEY, consent })).resolves.toEqual({
      state: 'ready', providerId: 'groq', agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
      acceptedAt: consent.acceptedAt,
    });
    const persisted = await readFile(path.join(location, 'groq-max.safe'));
    expect(persisted.toString('utf8')).not.toContain(KEY);
    expect(JSON.stringify(await settings.status())).not.toContain(KEY);
    await expect(settings.resolveApiKey()).resolves.toBe(KEY);
  });

  it('fails before creating or encrypting when consent is stale', async () => {
    const location = await root();
    const encryptString = vi.fn(protectedStorage.encryptString);
    const settings = store(location, { protectedStorage: { ...protectedStorage, encryptString } });
    await expect(settings.saveSetup({ apiKey: KEY, consent: { ...consent, agreementVersion: 'old' as never } }))
      .rejects.toMatchObject<AstraMaxSettingsError>({ code: 'consent-required' });
    expect(encryptString).not.toHaveBeenCalled();
    await expect(settings.status()).resolves.toMatchObject({ state: 'not-configured' });
  });

  it('does not use or silently replace a corrupt protected record', async () => {
    const location = await root();
    const recordPath = path.join(location, 'groq-max.safe');
    await writeFile(recordPath, 'corrupt');
    const settings = store(location);
    await expect(settings.status()).resolves.toMatchObject({ state: 'corrupt', acceptedAt: null });
    await expect(settings.resolveApiKey()).rejects.toMatchObject({ code: 'record-corrupt' });
    await expect(readFile(recordPath, 'utf8')).resolves.toBe('corrupt');
  });

  it('replaces a key only through an explicit complete setup write', async () => {
    const location = await root();
    const first = store(location, { randomId: () => 'record_1' });
    await first.saveSetup({ apiKey: KEY, consent });
    const replacement = 'gsk_fixture_replacement_12345678901234567890';
    const second = store(location, { randomId: () => 'record_2' });
    await expect(second.saveSetup({ apiKey: replacement, consent })).resolves.toMatchObject({ state: 'ready' });
    await expect(second.resolveApiKey()).resolves.toBe(replacement);
    expect((await readFile(path.join(location, 'groq-max.safe'))).toString('utf8')).not.toContain(KEY);
  });

  it('fails closed when OS encryption or access restriction is unavailable', async () => {
    const location = await root();
    const noEncryption = store(location, { protectedStorage: { isEncryptionAvailable: () => false } });
    await expect(noEncryption.status()).resolves.toMatchObject({ state: 'unavailable' });
    await expect(noEncryption.saveSetup({ apiKey: KEY, consent })).rejects.toMatchObject({ code: 'encryption-unavailable' });

    const noAccess = store(location, { restrictAccess: async () => false });
    await expect(noAccess.saveSetup({ apiKey: KEY, consent })).rejects.toMatchObject({ code: 'access-denied' });
    await expect(noAccess.status()).resolves.toMatchObject({ state: 'unavailable' });

    const accessThrows = store(location, { restrictAccess: async () => { throw new Error(`leak:${KEY}`); } });
    let accessError: unknown;
    try { await accessThrows.resolveApiKey(); } catch (caught) { accessError = caught; }
    expect(accessError).toMatchObject({ code: 'root-unavailable' });
    expect(String(accessError)).not.toContain(KEY);
  });

  it('keeps the key and replaces only the stored model id', async () => {
    const location = await root();
    const openaiConsent = { ...consent, providerId: 'openai' as const, agreementVersion: MAX_CLOUD_AGREEMENT };
    const settings = new AstraMaxSettingsStore({
      deployment: 'isolated-validation', rootPath: location, providerId: 'openai', protectedStorage,
      restrictAccess: async () => true, now: () => NOW, randomId: () => 'record_model',
    });
    await settings.saveSetup({ apiKey: KEY, consent: openaiConsent, modelId: 'gpt-4.1' });
    expect(await settings.status()).toMatchObject({ state: 'ready', providerId: 'openai', modelId: 'gpt-4.1' });
    await settings.saveSetup({ apiKey: KEY, consent: openaiConsent, modelId: 'gpt-4.1-mini' });
    expect(await settings.status()).toMatchObject({ modelId: 'gpt-4.1-mini' });
    await expect(settings.resolveApiKey()).resolves.toBe(KEY);
    expect(JSON.stringify(await settings.status())).not.toContain(KEY);
  });

  it('maps decrypt failures to bounded state and errors without leaking their text', async () => {
    const location = await root();
    const settings = store(location);
    await settings.saveSetup({ apiKey: KEY, consent });
    const broken = store(location, { protectedStorage: { ...protectedStorage,
      decryptString: () => { throw new Error(`leak:${KEY}`); } } });
    await expect(broken.status()).resolves.toMatchObject({ state: 'corrupt' });
    let error: unknown;
    try { await broken.resolveApiKey(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'record-corrupt' });
    expect(String(error)).not.toContain(KEY);
  });
});
