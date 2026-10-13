import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { loadAstraMaxHost } from '../../desktop/electron/astra-max-host-loader.mjs';
import { restrictProtectedIntegrationAcl } from '../../desktop/electron/protected-integration-acl.mjs';
import { ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
  astraMaxPreparedModelDigest } from '../../src/agent-v3/max-provider-contract';
import { LocalModelPreferenceStore } from '../../src/settings/model-preference';
import { cloudRole, maxCloudPreparedModelDigest } from '../../src/agent-v3/max-cloud-catalog';
import { setMaxCloudLimitChoice } from '../../src/agent-v3/max-cloud-limits';

const roots: string[] = [];
const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const protectedStorage = { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8').map(byte => byte ^ 0x33),
  decryptString: (value: Buffer) => Buffer.from(value).map(byte => byte ^ 0x33).toString('utf8') };

beforeAll(async () => { await mkdir(path.join(process.cwd(), 'runtime'), { recursive: true }); });
afterEach(async () => { setMaxCloudLimitChoice({}); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(process.cwd(), 'runtime', 'astra-max-loader-'));
  roots.push(root);
  const versionRoot = path.join(root, 'version');
  const dataRoot = path.join(root, 'data');
  await Promise.all([mkdir(path.join(versionRoot, 'dist'), { recursive: true }), mkdir(dataRoot)]);
  await build({ entryPoints: [path.resolve('src/agent-v3/max-electron-entry.ts')],
    outfile: path.join(versionRoot, 'dist', 'astra-max-electron.mjs'), bundle: true, platform: 'node',
    format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'silent' });
  return { root, versionRoot, dataRoot };
}

describe('Astra MAX Electron-main loader', () => {
  it('shares saved runtime limits across separate bundles and refreshes chat and agent without reload', async () => {
    const f = await fixture();
    const stateRoot = path.join(f.root, 'state');
    const preference = new LocalModelPreferenceStore(stateRoot);
    preference.update({ maxOutputTokens: 0, maxContextTokens: 1_000_000 });
    const bodies: any[] = [];
    // Chat answers stream plain text; agent steps stream JSON under a response_format.
    const chat = (body: any) => body.stream && !body.response_format;
    const model = 'vendor/loader-limits-model';
    const role = cloudRole('openrouter', model);
    const host = await loadAstraMaxHost({ deployment: 'native-desktop', versionRoot: f.versionRoot,
      dataRoot: f.dataRoot, runtimeEnvironment: { MONARCH_STATE_ROOT: stateRoot },
      safeStorage: protectedStorage, restrictAccess: async () => true, now: () => NOW,
      fetch: async (_url: unknown, init: RequestInit) => {
        if (init.method === 'GET') return new Response(JSON.stringify({ data: { endpoints: [{ supported_parameters: ['structured_outputs'] }] } }));
        const body = JSON.parse(String(init.body)); bodies.push(body);
        if (chat(body)) return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Ответ MAX.' }, finish_reason: 'stop' }] }) + '\n\n');
        const safety = JSON.stringify(body).includes('safety classification stage for Monarch MAX');
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
          content: JSON.stringify(safety ? { decision: 'allow' } : body.messages.at(-1).content.includes('Connection check') ? { ok: true } : { text: 'Ответ MAX.' }),
        } }] }));
      } });
    await host.configureProvider({ providerId: 'openrouter', modelId: model, apiKey: 'synthetic-loader-key-123456789', consent: {
      agreementVersion: 'monarch.max.providers.2026-09-07.v1', providerId: 'openrouter',
      acceptedAt: new Date(NOW).toISOString(), nonLocalProcessingAcknowledged: true,
      selectedContextAcknowledged: true, providerTermsAcknowledged: true,
    } });
    const input = { role, messages: [{ role: 'user', content: 'Привет' }], maxTokens: 65_536 };
    const chunks = [];
    for await (const chunk of host.streamNative(input)) chunks.push(chunk);
    expect(chunks).toEqual([{ delta: 'Ответ MAX.' }, { done: true, model, stopReason: 'stop' }]);
    expect(bodies.find(chat).max_tokens).toBeUndefined();
    expect(await host.completeNative(input)).toEqual({ text: 'Ответ MAX.', model });
    const prepared = host.preparedModelHost();
    const open = (id: string, tokens: number) => prepared.open({ requestId: id, executionId: id, modelId: role,
      expectedModelDigest: maxCloudPreparedModelDigest(role), responseSchema: { type: 'object' }, maxOutputTokens: tokens, timeoutMs: 60_000 });
    expect(open('large_window', 65_536).binding.contextTokens).toBe(262_144);

    preference.update({ maxOutputTokens: 8192, maxContextTokens: 65_536 });
    const calls = bodies.length;
    await expect(host.completeNative(input)).rejects.toThrow('output-budget');
    await expect((async () => { for await (const _ of host.streamNative(input)) { /* drain */ } })()).rejects.toThrow('output-budget');
    expect(bodies).toHaveLength(calls);
    expect(open('small_window', 8192).binding.contextTokens).toBe(65_536);
    expect(() => open('too_large', 65_536)).toThrow('request-budget');
    const next = [];
    for await (const chunk of host.streamNative({ ...input, maxTokens: 8192 })) next.push(chunk);
    expect(next[0]).toEqual({ delta: 'Ответ MAX.' });
    expect(bodies.filter(chat).at(-1).max_tokens).toBe(8192);
  });
  it('supports native setup, verifies available models, and does not replace a valid key after failed verification', async () => {
    const f = await fixture();
    let accepted = true;
    const host = await loadAstraMaxHost({ deployment: 'native-desktop', versionRoot: f.versionRoot,
      dataRoot: f.dataRoot, safeStorage: protectedStorage, restrictAccess: async () => true, now: () => NOW,
      fetch: async () => accepted ? new Response(JSON.stringify({ data: [
        { id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-safeguard-20b' },
      ] }), { headers: { 'Content-Type': 'application/json' } }) : new Response('{}', { status: 401 }) });
    const consent = { agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, providerId: 'groq',
      acceptedAt: new Date(NOW).toISOString(), nonLocalProcessingAcknowledged: true,
      selectedContextAcknowledged: true, providerTermsAcknowledged: true };
    expect(await host.configure({ apiKey: 'gsk_synthetic_initial_123456789012345', consent })).toMatchObject({
      state: 'ready', connectionVerified: true, availableModels: ['openai/gpt-oss-120b'] });
    accepted = false;
    await expect(host.configure({ apiKey: 'gsk_synthetic_invalid_123456789012345', consent })).rejects.toThrow();
    expect(await host.setupView()).toMatchObject({ state: 'ready', connectionVerified: true });
    expect(host.preparedModelHost().descriptor()).toBeTruthy();
  });
  it('loads only the exact bundle and returns a credential-free facade', async () => {
    const f = await fixture();
    const host = await loadAstraMaxHost({ deployment: 'isolated-validation', versionRoot: f.versionRoot,
      dataRoot: f.dataRoot, safeStorage: protectedStorage, restrictAccess: async () => true, now: () => NOW });
    expect(Object.keys(host)).toEqual(['setupView', 'providersView', 'selectedProviderId', 'selectProvider', 'withSelectedConnection', 'listProviderModels', 'listStoredProviderModels', 'configureProvider', 'updateProviderModel', 'verifyProvider', 'configure', 'verifyConnection', 'completeNative', 'streamNative', 'decideRead', 'preparedModelHost', 'setReasoningEffort']);
    expect(await host.setupView()).toMatchObject({ state: 'not-configured', title: 'Подключи MAX' });
    await expect(host.configure({ apiKey: 'gsk_fixture_only_12345678901234567890', consent: {
      agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, providerId: 'groq',
      acceptedAt: '2026-09-04T11:59:00.000Z', nonLocalProcessingAcknowledged: true,
      selectedContextAcknowledged: true, providerTermsAcknowledged: true,
    } })).resolves.toMatchObject({ state: 'ready', connectionVerified: false, title: 'Ключ MAX сохранён' });
    expect(JSON.stringify(await host.setupView())).not.toMatch(/gsk_|token|sha|runtime|credential/iu);
    expect(host.preparedModelHost().descriptor()).toMatchObject({
      hostGeneration: expect.stringMatching(/^astra_max_[a-f0-9]{32}$/u),
      modelDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      modelDigests: {
        'openai/gpt-oss-120b': expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        'qwen/qwen3.8-27b': expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
  });

  it('rejects a missing bundle and writable/immutable root overlap', async () => {
    const f = await fixture();
    await rm(path.join(f.versionRoot, 'dist', 'astra-max-electron.mjs'));
    await expect(loadAstraMaxHost({ deployment: 'isolated-validation', versionRoot: f.versionRoot,
      dataRoot: f.dataRoot, safeStorage: protectedStorage })).rejects.toThrow('astra-max-loader:bundle-identity');
    await expect(loadAstraMaxHost({ deployment: 'isolated-validation', versionRoot: f.versionRoot,
      dataRoot: path.join(f.versionRoot, 'data'), safeStorage: protectedStorage })).rejects.toThrow('astra-max-loader:root-overlap');
  });

  it('keeps automatic on GPT OSS and rejects retired Qwen', async () => {
    const automaticFixture = await fixture();
    const automatic = await loadAstraMaxHost({ deployment: 'isolated-validation',
      versionRoot: automaticFixture.versionRoot, dataRoot: automaticFixture.dataRoot,
      safeStorage: protectedStorage, restrictAccess: async () => true, now: () => NOW });
    expect(automatic.preparedModelHost().modelDigest).toBe(astraMaxPreparedModelDigest('openai/gpt-oss-120b'));
    expect(automatic.preparedModelHost().open({ requestId: 'gpt_loader_limit', executionId: 'gpt_loader_limit',
      expectedModelDigest: automatic.preparedModelHost().modelDigest, responseSchema: { type: 'object' },
      maxOutputTokens: 65_536, timeoutMs: 600_000 }).state).toBe('ready');

    for (const previewAcknowledged of [false, true]) {
      const deniedFixture = await fixture();
      await expect(loadAstraMaxHost({ deployment: 'isolated-validation', versionRoot: deniedFixture.versionRoot,
        dataRoot: deniedFixture.dataRoot, safeStorage: protectedStorage, restrictAccess: async () => true,
        now: () => NOW, modelPreference: 'qwen-3.8-27b', previewAcknowledged }))
        .rejects.toThrow('astra-max-loader:model-selection-request-invalid');
    }
  });

  it('restricts the integration root and protected record to the current user and SYSTEM', async () => {
    const f = await fixture();
    await writeFile(path.join(f.dataRoot, 'groq-max.safe'), 'protected-fixture');
    const calls: Array<{ file: string; args: string[] }> = [];
    const execute = vi.fn(async (file: string, args: string[]) => { calls.push({ file, args }); });
    await expect(restrictProtectedIntegrationAcl(f.dataRoot, { platform: 'win32', domain: 'DOMAIN',
      username: 'FixtureUser', execute })).resolves.toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ file: 'icacls.exe' });
    expect(calls[0]!.args).toContain('DOMAIN\\FixtureUser:(OI)(CI)F');
    expect(calls[1]!.args).toContain('DOMAIN\\FixtureUser:F');
    await expect(restrictProtectedIntegrationAcl(f.dataRoot, { platform: 'win32', username: 'FixtureUser',
      execute: async () => { throw new Error('denied'); } })).resolves.toBe(false);
  });
});
