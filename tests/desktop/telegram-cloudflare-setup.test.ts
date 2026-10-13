import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTelegramCloudflareSetup, PERSONAL_CLOUD_CONSENT } from '../../desktop/electron/telegram-cloudflare-setup.mjs';
import { createMaxSelection } from '../../desktop/electron/max-selection.mjs';
const roots: string[] = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const r = await mkdtemp(path.join(tmpdir(), 'monarch-personal-cloud-')); roots.push(r); return r; }
it('persists one global choice and does not silently default a damaged preference', async () => {
  const r = await root(); const choice = createMaxSelection(r);
  expect(await choice.read()).toBe('groq'); await choice.write('openai');
  expect(await createMaxSelection(r).read()).toBe('openai');
  await writeFile(path.join(r, 'selected-provider.json'), '{broken'); await expect(choice.read()).rejects.toThrow();
});
async function fixture() {
  const workerPath = path.join(await root(), 'worker.mjs'); await writeFile(workerPath, 'export default {};');
  let remoteCode = 'export default {};'; let writes = 0;
  let bindings: any[] = [{ name: 'OSCAR', type: 'durable_object_namespace', class_name: 'OscarPersonalBot', namespace_id: 'fixture' },
    { name: 'DAILY_MODEL_CALLS', type: 'plain_text', text: '12' }];
  const setup = createTelegramCloudflareSetup({ workerPath, authorization: async () => 'fixture-oauth', fetchImpl: async (url: string, options: any) => {
    expect(url.startsWith('https://api.cloudflare.com/client/v4/accounts/')).toBe(true);
    expect(options.redirect).toBe('error');
    if (url.endsWith('/subdomain')) return Response.json({ success: true, result: { subdomain: 'fixture' } });
    if (url.endsWith('/content/v2')) {
      const body = new FormData(); body.set('worker.mjs', new Blob([remoteCode]), 'worker.mjs');
      return new Response(body, { headers: { 'cf-entrypoint': 'worker.mjs' } });
    }
    expect(url.endsWith('/settings')).toBe(true);
    if (options.method === 'PATCH') { writes++; bindings = JSON.parse(options.body.get('settings')).bindings; }
    return Response.json({ success: true, result: { bindings: bindings.map(b => b.type === 'secret_text' ? { name: b.name, type: b.type } : b) } });
  } });
  const input = { consent: PERSONAL_CLOUD_CONSENT, accountId: 'a'.repeat(32), endpoint: 'https://oscar-personal-bot.fixture.workers.dev',
    ownerId: 7, botId: 123456, deviceId: 'pc-fixture', pairingEpoch: 'epoch-fixture', deviceToken: 'd'.repeat(43), webhookSecret: 'w'.repeat(43),
    botToken: '123456:synthetic-never-real-token', max: { providerId: 'groq', modelId: 'openai/gpt-oss-120b', apiKey: 'synthetic-max-key' } };
  return { setup, input, writes: () => writes, bindings: () => bindings, code: (s: string) => { remoteCode = s; } };
}
it('checks the exact deployed code, writes settings together, preserves budget and returns no keys', async () => {
  const f = await fixture(); const result = await f.setup.configure(f.input);
  expect(f.writes()).toBe(1); expect(f.bindings().find(b => b.name === 'DAILY_MODEL_CALLS').text).toBe('12');
  expect(f.bindings().filter(b => b.type === 'secret_text')).toHaveLength(4);
  expect(JSON.stringify(result)).not.toContain('synthetic'); expect(result.configured).toBe(true);
});
it('does not transfer credentials without consent, to another account URL, or to changed code', async () => {
  const f = await fixture();
  await expect(f.setup.configure({ ...f.input, consent: '' })).rejects.toThrow('configuration');
  await expect(f.setup.configure({ ...f.input, endpoint: 'https://oscar-personal-bot.other.workers.dev' })).rejects.toThrow('account-mismatch');
  f.code('different worker'); await expect(f.setup.configure(f.input)).rejects.toThrow('worker-code'); expect(f.writes()).toBe(0);
});
