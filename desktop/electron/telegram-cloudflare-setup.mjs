import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const PERSONAL_CLOUD_CONSENT = 'monarch.telegram.personal-cloud.2026-09-08.v1';
const api = 'https://api.cloudflare.com/client/v4';
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(`telegram-cloud:${code}`); };
async function bounded(response, limit = 2 * 1024 * 1024) {
  const reader = response.body?.getReader(); if (!reader) fail('empty-response');
  const chunks = []; let length = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    length += value.length; if (length > limit) { await reader.cancel(); fail('response-budget'); } chunks.push(Buffer.from(value));
  } } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

// Read only the CLI login explicitly authorized by the owner. Nothing from this
// record is returned to preload, model transport, logs or child processes.
export async function readWranglerAuthorization() {
  const file = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'xdg.config', '.wrangler', 'config', 'default.toml')
    : path.join(os.homedir(), '.config', '.wrangler', 'config', 'default.toml');
  const stat = await lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 16384) fail('login-required');
  const record = await readFile(file, 'utf8');
  const token = record.match(/^oauth_token\s*=\s*"([A-Za-z0-9._~-]+)"\s*$/m)?.[1];
  const expiry = record.match(/^expiration_time\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!token || !expiry || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now() + 60000) fail('login-required');
  return token;
}

export function createTelegramCloudflareSetup({ fetchImpl = fetch, authorization = readWranglerAuthorization, workerPath }) {
  async function request(resource, options = {}, raw = false) {
    const token = await authorization();
    const response = await fetchImpl(api + resource, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    const bytes = await bounded(response);
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'login-required' : 'api-request');
    if (raw) return { bytes, headers: response.headers };
    const body = JSON.parse(bytes.toString('utf8')); if (body.success !== true) fail('api-request'); return body.result;
  }
  async function inspect() {
    const accounts = await request('/accounts?per_page=50');
    const choices = [];
    for (const account of accounts.slice(0, 10)) {
      if (!/^[a-f0-9]{32}$/.test(account.id)) continue;
      try {
        const root = `/accounts/${account.id}/workers`;
        const subdomain = await request(`${root}/subdomain`);
        if (!/^[a-z0-9-]+$/.test(subdomain.subdomain)) continue;
        const scripts = await request(`${root}/scripts`);
        for (const script of scripts) if (script.id === 'oscar-personal-bot') choices.push({ accountId: account.id,
          endpoint: `https://oscar-personal-bot.${subdomain.subdomain}.workers.dev` });
      } catch { /* Accounts without this personal Worker are not setup targets. */ }
    }
    return { choices };
  }
  async function configure(input) {
    if (input.consent !== PERSONAL_CLOUD_CONSENT || !/^[a-f0-9]{32}$/.test(input.accountId)
      || !Number.isSafeInteger(input.ownerId) || input.ownerId <= 0 || !Number.isSafeInteger(input.botId) || input.botId <= 0
      || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.deviceId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.pairingEpoch)
      || !/^[A-Za-z0-9_-]{32,128}$/.test(input.deviceToken) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.webhookSecret)
      || typeof input.botToken !== 'string' || !input.botToken.startsWith(`${input.botId}:`)
      || !/^[a-z]{2,20}$/.test(input.max.providerId) || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@+-]{0,159}$/.test(input.max.modelId)
      || typeof input.max.apiKey !== 'string' || !input.max.apiKey || input.max.providerId === 'groq' && input.max.modelId !== 'openai/gpt-oss-120b') fail('configuration');
    const root = `/accounts/${input.accountId}/workers`;
    const subdomain = await request(`${root}/subdomain`);
    if (input.endpoint !== `https://oscar-personal-bot.${subdomain.subdomain}.workers.dev`) fail('account-mismatch');
    const script = `${root}/scripts/oscar-personal-bot`;
    const content = await request(`${script}/content/v2`, {}, true);
    const local = await readFile(workerPath);
    let remote = content.bytes;
    if (content.headers.get('content-type')?.includes('multipart/')) {
      const form = await new Response(content.bytes, { headers: content.headers }).formData();
      const entry = content.headers.get('cf-entrypoint');
      const files = [...form.entries()].filter(([, value]) => typeof value !== 'string');
      if (files.length !== 1 || entry && files[0][0] !== entry) fail('worker-code');
      remote = Buffer.from(await files[0][1].arrayBuffer());
    }
    if (digest(remote) !== digest(local)) fail('worker-code');
    const settings = await request(`${script}/settings`);
    const bindings = settings.bindings;
    const owned = new Set(['OWNER_ID','BOT_ID','DEVICE_ID','PAIRING_EPOCH','MAX_PROVIDER_ID','MAX_MODEL_ID','MAX_CLOUD_CONSENT','DAILY_MODEL_CALLS','BOT_TOKEN','DEVICE_TOKEN','WEBHOOK_SECRET','MAX_API_KEY']);
    if (!Array.isArray(bindings) || bindings.some(b => !owned.has(b.name) && !(b.name === 'OSCAR' && b.type === 'durable_object_namespace' && b.class_name === 'OscarPersonalBot'))) fail('worker-bindings');
    for (const [name, value] of [['OWNER_ID', String(input.ownerId)], ['BOT_ID', String(input.botId)], ['PAIRING_EPOCH', input.pairingEpoch], ['DEVICE_ID', input.deviceId]]) {
      const prior = bindings.find(b => b.name === name)?.text;
      if (prior && prior !== 'CONFIGURE' && prior !== value) fail('existing-binding');
    }
    const next = bindings.filter(b => b.name === 'OSCAR'); if (next.length !== 1) fail('worker-bindings');
    const priorLimit = bindings.find(b => b.name === 'DAILY_MODEL_CALLS')?.text;
    if (priorLimit !== undefined && !/^(?:[1-9][0-9]{0,3})$/.test(priorLimit)) fail('worker-budget');
    const vars = { OWNER_ID: String(input.ownerId), BOT_ID: String(input.botId), DEVICE_ID: input.deviceId, PAIRING_EPOCH: input.pairingEpoch,
      MAX_PROVIDER_ID: input.max.providerId, MAX_MODEL_ID: input.max.modelId, MAX_CLOUD_CONSENT: PERSONAL_CLOUD_CONSENT, DAILY_MODEL_CALLS: priorLimit ?? '30' };
    for (const [name, text] of Object.entries(vars)) next.push({ name, text, type: 'plain_text' });
    for (const [name, text] of Object.entries({ BOT_TOKEN: input.botToken, DEVICE_TOKEN: input.deviceToken, WEBHOOK_SECRET: input.webhookSecret, MAX_API_KEY: input.max.apiKey })) next.push({ name, text, type: 'secret_text' });
    const form = new FormData(); form.set('settings', JSON.stringify({ bindings: next }));
    await request(`${script}/settings`, { method: 'PATCH', body: form });
    const saved = await request(`${script}/settings`);
    if (Object.entries(vars).some(([name, value]) => saved.bindings?.find(b => b.name === name)?.text !== value)
      || ['BOT_TOKEN','DEVICE_TOKEN','WEBHOOK_SECRET','MAX_API_KEY'].some(name => !saved.bindings?.some(b => b.name === name && b.type === 'secret_text'))) fail('readback');
    return { configured: true, endpoint: input.endpoint, providerId: input.max.providerId, modelId: input.max.modelId };
  }
  return Object.freeze({ inspect, configure });
}
