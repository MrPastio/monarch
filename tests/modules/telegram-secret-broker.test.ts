import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTelegramSecretBroker, startTelegramSecretServer } from '../../desktop/electron/telegram-secret-broker.mjs';
const cleanup: (() => Promise<void>)[] = []; afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const key = '123456:synthetic-token-never-a-real-credential';
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(Buffer.from(value).toString('base64')),
  decryptString: (value: Buffer) => Buffer.from(value.toString(), 'base64').toString() };
describe('main-process Telegram credential broker', () => {
  it('verifies cloud identity and switches a single webhook receiver without discarding updates', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-switch-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    let webhook = ''; const methods: { method: string; parameters: any }[] = [];
    const broker = createTelegramSecretBroker({ dataRoot: root, safeStorage, fetchImpl: async (url: string, options: any) => {
      const parameters = options?.body ? JSON.parse(options.body) : {};
      if (url === 'https://fixture.owner.workers.dev/device') return Response.json(parameters.action === 'configuration'
        ? { botId: 123456, ownerId: 7, pairingEpoch: 'one', deviceId: 'pc' } : { confirmed: true });
      expect(url.startsWith('https://api.telegram.org/')).toBe(true);
      const method = url.split('/').at(-1)!; methods.push({ method, parameters });
      if (method === 'setWebhook') { expect(parameters.drop_pending_updates).toBe(false); webhook = parameters.url; }
      if (method === 'deleteWebhook') { expect(parameters.drop_pending_updates).toBe(false); webhook = ''; }
      return Response.json({ ok: true, result: method === 'getWebhookInfo' ? { url: webhook } : { id: 123456, is_bot: true } });
    } });
    await broker.configure({ token: key });
    const configuration = { endpoint: 'https://fixture.owner.workers.dev', deviceToken: 'd'.repeat(40), webhookSecret: 'w'.repeat(40),
      ownerId: 7, deviceId: 'pc', pairingEpoch: 'one', enabled: true, consent: 'monarch.telegram.personal-cloud.2026-09-08.v1' };
    await expect(broker.configureCloud({ ...configuration, ownerId: 9 })).rejects.toThrow('cloud-binding');
    await broker.configureCloud(configuration);
    await broker.dispatch({ kind: 'cloud-switch', mode: 'cloud' }); expect(webhook).toContain('/telegram');
    const status = await broker.dispatch({ kind: 'cloud-status' }); expect(status.enabled).toBe(true); expect(JSON.stringify(status)).not.toContain(configuration.deviceToken);
    await broker.dispatch({ kind: 'cloud-switch', mode: 'polling' }); expect(webhook).toBe('');
    expect(methods.filter(m => m.method === 'setWebhook')).toHaveLength(1);
  });
  it('keeps raw tokens out of status and authenticated local transport responses', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-broker-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const urls: string[] = [];
    const broker = createTelegramSecretBroker({ dataRoot: root, safeStorage, fetchImpl: async (url: string) => {
      urls.push(url); return Response.json({ ok: true, result: { id: 123456, is_bot: true, username: 'fixture_bot' } });
    } });
    const configured = await broker.configure({ role: 'main', token: key });
    expect(JSON.stringify(configured)).not.toContain(key);
    expect((await readFile(path.join(root, 'telegram-main.encrypted'))).toString()).not.toContain(key);
    const server = await startTelegramSecretServer(broker); cleanup.push(() => server.close());
    const denied = await fetch(server.endpoint, { method: 'POST', body: '{}' }); expect(denied.status).toBe(403);
    const headers = { Authorization: `Bearer ${server.bearerToken}`, 'Content-Type': 'application/json' };
    const status = await fetch(server.endpoint, { method: 'POST', headers, body: JSON.stringify({ kind: 'status' }) });
    expect(await status.json()).toEqual({ result: { configured: true } });
    const fromBrowser = await fetch(server.endpoint, { method: 'POST', headers: { ...headers, Origin: 'http://localhost' }, body: '{}' }); expect(fromBrowser.status).toBe(403);
    expect(urls.every(url => url.startsWith('https://api.telegram.org/bot'))).toBe(true);
  });
  it('rejects unavailable OS encryption and non-allowlisted transport methods', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-broker-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const broker = createTelegramSecretBroker({ dataRoot: root, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false }, fetchImpl: async () => { throw Error('must not fetch'); } });
    await expect(broker.configure({ token: key })).rejects.toThrow('encryption');
    await expect(broker.dispatch({ kind: 'api', method: 'deleteMessages', parameters: {} })).rejects.toThrow('method-denied');
  });
});
