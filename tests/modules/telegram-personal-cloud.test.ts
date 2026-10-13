import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTelegramSecretBroker } from '../../desktop/electron/telegram-secret-broker.mjs';
const roots: string[] = []; afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const storage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
async function fixture() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'monarch-cloud-sync-')); roots.push(dataRoot);
  let selected = { available: true, providerId: 'groq', modelId: 'openai/gpt-oss-120b', role: 'max:groq:fixture' };
  let fail = false; let paused = false; let revision = 0; let remote: any = {}; const attempts: any[] = [];
  const broker = createTelegramSecretBroker({ dataRoot, safeStorage: storage, selectedMax: async () => selected,
    withSelectedMaxConnection: async (consume: any) => consume({ ...selected, apiKey: 'synthetic-fixture' }),
    cloudSetup: { configure: async (input: any) => { attempts.push(input); if (fail) throw Error('synthetic network loss'); remote = input; } },
    fetchImpl: async (url: string, options: any) => {
      if (url.includes('api.telegram.org')) return Response.json({ ok: true, result: { id: 123456, is_bot: true } });
      const input = JSON.parse(options.body);
      if (input.action === 'cloud-control') {
        if (input.expectedRevision !== undefined && input.expectedRevision !== revision) return Response.json({ error: 'control-changed' }, { status: 409 });
        paused = input.paused; return Response.json({ confirmed: true, paused, revision: ++revision });
      }
      return Response.json({ botId: 123456, ownerId: 7, pairingEpoch: 'epoch', deviceId: remote.deviceId, paused,
        providerId: remote.max?.providerId, modelId: remote.max?.modelId });
    } });
  await broker.configure({ token: '123456:synthetic-token-not-real-12345' });
  const input = { consent: 'monarch.telegram.personal-cloud.2026-09-08.v1', accountId: 'a'.repeat(32),
    endpoint: 'https://oscar-personal-bot.fixture.workers.dev', ownerId: 7, pairingEpoch: 'epoch', expectedRole: selected.role };
  return { broker, input, attempts, paused: () => paused, fail: (v: boolean) => { fail = v; },
    select: () => { selected = { available: true, providerId: 'openai', modelId: 'fixture-model', role: 'max:openai:fixture' }; } };
}
it('retries failed provisioning with the same durable device keys and no secret in result', async () => {
  const f = await fixture(); f.fail(true); await expect(f.broker.provisionPersonalCloud(f.input)).rejects.toThrow();
  f.fail(false); const result = await f.broker.provisionPersonalCloud(f.input);
  expect(f.attempts[0].deviceToken).toBe(f.attempts[1].deviceToken);
  expect(f.attempts[0].webhookSecret).toBe(f.attempts[1].webhookSecret);
  expect(JSON.stringify(result)).not.toContain(f.attempts[0].deviceToken);
});
it('pauses before selection, leaves failed synchronization paused, and recovers exact selected provider', async () => {
  const f = await fixture(); await f.broker.provisionPersonalCloud(f.input);
  await f.broker.beforeMaxChange(); expect(f.paused()).toBe(true); f.select(); f.fail(true);
  expect(await f.broker.afterMaxChange()).toContain('приостановлено'); expect(f.paused()).toBe(true);
  await expect(f.broker.dispatch({ kind: 'cloud', request: { action: 'cloud-control', paused: false } })).rejects.toThrow('sync-pending');
  f.fail(false); await f.broker.afterMaxChange(); expect(f.paused()).toBe(false);
  expect(f.attempts.at(-1).max.providerId).toBe('openai');
});
it('preserves manual pause, including a pause made while synchronization is pending', async () => {
  const f = await fixture(); await f.broker.provisionPersonalCloud(f.input);
  await f.broker.beforeMaxChange();
  await f.broker.dispatch({ kind: 'cloud', request: { action: 'cloud-control', paused: true } });
  f.select(); await f.broker.afterMaxChange(); expect(f.paused()).toBe(true);
  await f.broker.beforeMaxChange(); await f.broker.afterMaxChange(); expect(f.paused()).toBe(true);
});
