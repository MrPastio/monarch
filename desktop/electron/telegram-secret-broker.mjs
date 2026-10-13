import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './windows-rename.mjs';

const METHODS = new Set(('getMe getUpdates getWebhookInfo setWebhook deleteWebhook setMyCommands getFile sendMessage editMessageText editMessageReplyMarkup answerCallbackQuery sendChatAction createForumTopic editForumTopic closeForumTopic reopenForumTopic sendPhoto sendDocument sendVoice sendPoll sendRichMessage sendMessageDraft getBusinessConnection readBusinessMessage').split(' '));
const roleName = role => { if (!['main', 'secretary'].includes(role)) throw Error('telegram:role'); return role; };
async function bounded(response, max = 4 * 1024 * 1024) {
  if (!response.body) throw Error('telegram:empty-response');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > max) { await reader.cancel(); throw Error('telegram:response-budget'); } chunks.push(Buffer.from(value)); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Tokens never cross the main-process boundary. The runtime receives only a
 * private, authenticated transport channel; no renderer callable generic API. */
export function createTelegramSecretBroker({ dataRoot, safeStorage, fetchImpl = fetch, selectedMax = async () => ({ available: false }), cloudSetup, withSelectedMaxConnection,
  cloudKeyPolicy = async () => 'required' }) {
  let cloudSocket = null; let cloudHeartbeat = null;
  const cloudPath = path.join(dataRoot, 'telegram-cloud.encrypted');
  const file = role => path.join(dataRoot, `telegram-${roleName(role)}.encrypted`);
  const requireEncryption = () => { if (!safeStorage.isEncryptionAvailable()) throw Error('telegram:encryption-unavailable'); };
  async function token(role) {
    requireEncryption();
    const bytes = await readFile(file(role));
    if (bytes.length > 4096) throw Error('telegram:credential-record');
    const value = safeStorage.decryptString(bytes);
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,128}$/u.test(value)) throw Error('telegram:credential-record');
    return value;
  }
  async function request(role, method, parameters, signal) {
    if (!METHODS.has(method)) throw Error('telegram:method-denied');
    const secret = await token(role);
    const response = await fetchImpl(`https://api.telegram.org/bot${secret}/${method}`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parameters), signal,
    });
    const payload = JSON.parse((await bounded(response)).toString('utf8'));
    if (!response.ok || !payload.ok) throw Error(`telegram:api-${Number(payload.error_code || response.status)}`);
    return payload.result;
  }
  async function cloudConfig() {
    requireEncryption(); const bytes = await readFile(cloudPath); if (bytes.length > 8192) throw Error('telegram:cloud-record');
    return JSON.parse(safeStorage.decryptString(bytes));
  }
  async function saveCloud(c) {
    await mkdir(dataRoot, { recursive: true }); const temporary = `${cloudPath}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, safeStorage.encryptString(JSON.stringify(c)), { flag: 'wx', mode: 0o600 });
    await renameWithRetry(temporary, cloudPath);
  }
  async function verifyCloud(c) {
    const response = await fetchImpl(`${c.endpoint}/device`, { method: 'POST', redirect: 'error', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceToken}` },
      body: JSON.stringify({ action: 'configuration', deviceId: c.deviceId, pairingEpoch: c.pairingEpoch, webhookSecret: c.webhookSecret }), signal: AbortSignal.timeout(30_000) });
    const remote = JSON.parse((await bounded(response, 32_768)).toString('utf8'));
    const me = await request('main', 'getMe', {}, AbortSignal.timeout(15_000));
    if (!response.ok || remote.botId !== me.id || remote.ownerId !== c.ownerId || remote.pairingEpoch !== c.pairingEpoch || remote.deviceId !== c.deviceId) throw Error('telegram:cloud-binding');
    return remote;
  }
  async function cloudRequest(input, signal) {
    const c = await cloudConfig(); if (!c.enabled && !['cloud-control', 'configuration', 'revoke-dialog'].includes(input.action)) throw Error('telegram:cloud-disabled');
    const response = await fetchImpl(`${c.endpoint}/device`, { method: 'POST', redirect: 'error', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceToken}`,
    }, body: JSON.stringify({ ...input, deviceId: c.deviceId, pairingEpoch: c.pairingEpoch }), signal: signal ?? AbortSignal.timeout(30_000) });
    const payload = JSON.parse((await bounded(response, 2 * 1024 * 1024)).toString('utf8'));
    if (!response.ok) throw Error('telegram:cloud-rejected'); return payload;
  }
  const closeCloud = () => { clearInterval(cloudHeartbeat); cloudHeartbeat = null; cloudSocket?.close(); cloudSocket = null; };
  const optionalCloud = () => cloudConfig().catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  async function synchronize(c) {
    if (!c.accountId || c.consent !== 'monarch.telegram.personal-cloud.2026-09-08.v1') throw Error('telegram:cloud-setup-required');
    // F-09: the cloud gets its own provider key; the main MAX key stays on this
    // computer unless the person allowed it in Monarch Security.
    const policy = await cloudKeyPolicy().catch(() => 'required');
    await withSelectedMaxConnection(async max => {
      const dedicated = c.cloudApiKey && c.cloudKeyProvider === max.providerId ? c.cloudApiKey : null;
      if (dedicated && dedicated === max.apiKey && policy !== 'off') throw Error('telegram:cloud-key-same');
      if (!dedicated && policy !== 'off') throw Error('telegram:cloud-key-required');
      await cloudSetup.configure({ ...c, botToken: await token('main'), max: { ...max, apiKey: dedicated ?? max.apiKey } });
      const remote = await verifyCloud(c);
      if (remote.providerId !== max.providerId || remote.modelId !== max.modelId) throw Error('telegram:cloud-model-readback');
      c.modelRole = max.role;
    });
    const latest = await cloudConfig();
    if (latest.deviceToken !== c.deviceToken || latest.pairingEpoch !== c.pairingEpoch) throw Error('telegram:cloud-binding-changed');
    c = { ...latest, modelRole: c.modelRole };
    // Compare the pause revision remotely too: a concurrent owner Stop wins.
    if (c.syncPending && c.resumeAfterSync) {
      const result = await cloudRequest({ action: 'cloud-control', paused: false, expectedRevision: c.syncPauseRevision });
      if (result.confirmed !== true) throw Error('telegram:cloud-resume-unconfirmed');
    }
    c.configured = true; c.syncPending = false; c.resumeAfterSync = false; await saveCloud(c);
    return { configured: true, endpoint: c.endpoint, modelRole: c.modelRole };
  }
  async function connectCloud() {
    if (cloudSocket && cloudSocket.readyState <= 1 || typeof WebSocket !== 'function') return;
    const c = await cloudConfig(); if (!c.enabled) return;
    closeCloud();
    const socket = new WebSocket(`${c.endpoint.replace('https:', 'wss:')}/device/ws`, ['oscar-device-v2', `auth.${c.deviceToken}`]);
    cloudSocket = socket;
    const disconnected = () => { if (cloudSocket === socket) closeCloud(); };
    socket.addEventListener('error', disconnected);
    socket.addEventListener('close', disconnected);
    cloudHeartbeat = setInterval(() => { if (socket.readyState === 1) socket.send('ping'); }, 25_000); cloudHeartbeat.unref?.();
  }
  return {
    async inspectPersonalCloud() { return { ...await cloudSetup.inspect(), max: await selectedMax() }; },
    async provisionPersonalCloud(input) {
      requireEncryption();
      if (input?.consent !== 'monarch.telegram.personal-cloud.2026-09-08.v1'
        || !/^[a-f0-9]{32}$/.test(input.accountId) || !/^https:\/\/oscar-personal-bot\.[a-z0-9-]+\.workers\.dev$/.test(input.endpoint)
        || !Number.isSafeInteger(input.ownerId) || input.ownerId <= 0
        || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.pairingEpoch)) throw Error('telegram:cloud-configuration');
      const max = await selectedMax(); if (!max.available || max.role !== input.expectedRole) throw Error('telegram:cloud-model-changed');
      const prior = await optionalCloud();
      const cloudApiKey = typeof input.cloudApiKey === 'string' ? input.cloudApiKey.trim() : '';
      if (cloudApiKey && !/^[\x21-\x7e]{20,512}$/u.test(cloudApiKey)) throw Error('telegram:cloud-key-format');
      if (prior && (prior.endpoint !== input.endpoint || prior.ownerId !== input.ownerId || prior.pairingEpoch !== input.pairingEpoch)) throw Error('telegram:cloud-existing-binding');
      const me = await request('main', 'getMe', {}, AbortSignal.timeout(15000));
      const c = { ...prior, endpoint: input.endpoint, accountId: input.accountId, ownerId: input.ownerId, botId: me.id,
        pairingEpoch: input.pairingEpoch, consent: input.consent, enabled: prior?.enabled ?? false,
        deviceId: prior?.deviceId ?? `pc-${randomBytes(8).toString('hex')}`,
        deviceToken: prior?.deviceToken ?? randomBytes(32).toString('base64url'),
        webhookSecret: prior?.webhookSecret ?? randomBytes(32).toString('base64url'),
        ...(cloudApiKey ? { cloudApiKey, cloudKeyProvider: max.providerId } : {}) };
      // Persist generated keys before remote mutation, so retries keep the same binding.
      await saveCloud(c);
      if (prior?.enabled && !c.syncPending) { await this.beforeMaxChange(); return synchronize(await cloudConfig()); }
      return synchronize(c);
    },
    async beforeMaxChange() {
      const c = await optionalCloud(); if (!c || c.syncPending || c.accountId && c.configured !== true) return;
      const remote = await verifyCloud(c);
      if (typeof remote.paused !== 'boolean') throw Error('telegram:cloud-update-required');
      const paused = await cloudRequest({ action: 'cloud-control', paused: true });
      if (paused.confirmed !== true || !Number.isSafeInteger(paused.revision)) throw Error('telegram:cloud-pause-unconfirmed');
      await saveCloud({ ...c, syncPending: true, syncPauseRevision: paused.revision, resumeAfterSync: !remote.paused });
    },
    async afterMaxChange() {
      const c = await optionalCloud(); if (!c?.syncPending) return;
      try { await synchronize(c); }
      catch { return 'MAX выбран на ПК. Облако приостановлено: открой Telegram → Работа без ПК и повтори подключение.'; }
    },
    async configureCloud(input) {
      requireEncryption();
      if (typeof input.endpoint !== 'string' || !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/u.test(input.endpoint)
        || !/^[A-Za-z0-9_-]{32,128}$/u.test(input.deviceToken) || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.deviceId)
        || !/^[A-Za-z0-9_-]{32,128}$/u.test(input.webhookSecret)
        || !Number.isSafeInteger(input.ownerId) || input.ownerId <= 0
        || typeof input.pairingEpoch !== 'string' || input.pairingEpoch.length > 128 || typeof input.enabled !== 'boolean'
        || input.consent !== 'monarch.telegram.personal-cloud.2026-09-08.v1') throw Error('telegram:cloud-configuration');
      const candidate = { endpoint: input.endpoint, deviceToken: input.deviceToken, webhookSecret: input.webhookSecret, ownerId: input.ownerId,
        deviceId: input.deviceId, pairingEpoch: input.pairingEpoch, enabled: false };
      await verifyCloud(candidate); closeCloud(); await saveCloud(candidate);
      return { enabled: false, endpoint: input.endpoint, deviceId: input.deviceId, pairingEpoch: input.pairingEpoch };
    },
    closeCloud,
    async configure({ role = 'main', token: value }) {
      roleName(role); requireEncryption();
      if (typeof value !== 'string' || !/^\d{5,20}:[A-Za-z0-9_-]{20,128}$/u.test(value.trim())) throw Error('telegram:credential-invalid');
      const response = await fetchImpl(`https://api.telegram.org/bot${value.trim()}/getMe`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const result = JSON.parse((await bounded(response, 32_768)).toString('utf8'));
      if (!response.ok || !result.ok || result.result?.is_bot !== true) throw Error('telegram:credential-rejected');
      await mkdir(dataRoot, { recursive: true });
      const destination = file(role); const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(temporary, safeStorage.encryptString(value.trim()), { flag: 'wx', mode: 0o600 });
      await renameWithRetry(temporary, destination);
      return { configured: true, botId: result.result.id, username: result.result.username };
    },
    async status(role = 'main') {
      try { await token(role); return { configured: true }; } catch { return { configured: false }; }
    },
    async dispatch(input, signal) {
      if (input.kind === 'max-selection') return selectedMax();
      if (input.kind === 'cloud-switch') {
        if (!['cloud', 'polling'].includes(input.mode)) throw Error('telegram:transport-mode');
        const c = await cloudConfig(); if (input.mode === 'cloud' && c.syncPending) throw Error('telegram:cloud-sync-pending'); await verifyCloud(c); closeCloud();
        const cloud = input.mode === 'cloud';
        if (!cloud) await cloudRequest({ action: 'cloud-control', paused: true }, signal);
        await request('main', cloud ? 'setWebhook' : 'deleteWebhook', cloud ? {
          url: `${c.endpoint}/telegram`, secret_token: c.webhookSecret, drop_pending_updates: false,
          allowed_updates: ['message', 'callback_query', 'stopped_message_generation'],
        } : { drop_pending_updates: false }, signal);
        const webhook = await request('main', 'getWebhookInfo', {}, signal);
        if (webhook.url !== (cloud ? `${c.endpoint}/telegram` : '')) throw Error('telegram:transport-unconfirmed');
        await saveCloud({ ...c, enabled: cloud });
        if (cloud) await cloudRequest({ action: 'cloud-control', paused: false }, signal);
        return { mode: input.mode, verified: true };
      }
      if (input.kind === 'cloud-status') {
        try { const c = await cloudConfig(); return { enabled: c.enabled, endpoint: c.endpoint, deviceId: c.deviceId, pairingEpoch: c.pairingEpoch }; }
        catch { return { enabled: false }; }
      }
      if (input.kind === 'cloud') {
        if (input.request?.action === 'cloud-control') {
          const c = await cloudConfig();
          if (c.syncPending && input.request.paused === false) throw Error('telegram:cloud-sync-pending');
          if (input.request.paused === true && c.resumeAfterSync) await saveCloud({ ...c, resumeAfterSync: false });
        }
        await connectCloud().catch(() => undefined); return cloudRequest(input.request, signal);
      }
      const role = roleName(input.role ?? 'main');
      if (input.kind === 'status') return this.status(role);
      if (input.kind === 'download') {
        if (typeof input.fileId !== 'string' || input.fileId.length > 1024) throw Error('telegram:file');
        const metadata = await request(role, 'getFile', { file_id: input.fileId }, signal);
        const p = metadata.file_path;
        const max = Number(input.maxBytes);
        if (!Number.isSafeInteger(max) || max < 1 || max > 20 * 1024 * 1024 || typeof p !== 'string'
          || !/^[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/u.test(p) || p.includes('..') || p.startsWith('/')) throw Error('telegram:file');
        if (metadata.file_size > max) throw Error('telegram:file-budget');
        const secret = await token(role);
        const response = await fetchImpl(`https://api.telegram.org/file/bot${secret}/${p}`, { redirect: 'error', signal });
        if (!response.ok) throw Error('telegram:file-download');
        return { dataBase64: (await bounded(response, max)).toString('base64') };
      }
      if (input.kind === 'document') {
        if (typeof input.dataBase64 !== 'string' || input.dataBase64.length > 28 * 1024 * 1024
          || typeof input.name !== 'string' || /[\\/\u0000-\u001f]/u.test(input.name) || input.name.length > 120) throw Error('telegram:file-budget');
        const secret = await token(role); const body = new FormData();
        body.append('chat_id', String(input.chatId));
        if (input.threadId) body.append('message_thread_id', String(input.threadId));
        body.append('document', new Blob([Buffer.from(input.dataBase64, 'base64')], { type: input.mimeType }), input.name);
        const response = await fetchImpl(`https://api.telegram.org/bot${secret}/sendDocument`, { method: 'POST', redirect: 'error', body, signal });
        const result = JSON.parse((await bounded(response)).toString('utf8'));
        if (!response.ok || !result.ok) throw Error('telegram:document-send');
        return result.result;
      }
      return request(role, input.method, input.parameters, signal);
    },
  };
}

export async function startTelegramSecretServer(broker) {
  const bearerToken = randomBytes(32).toString('hex'); const expected = Buffer.from(`Bearer ${bearerToken}`);
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { if (!res.destroyed && !res.writableEnded) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body)); };
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: 'forbidden' });
    if (req.method !== 'POST' || req.url !== '/telegram') return send(404, { error: 'route' });
    if (active.size >= 8) return send(429, { error: 'busy' });
    const controller = new AbortController(); active.add(controller);
    const timer = setTimeout(() => { controller.abort(); send(504, { error: 'telegram:timeout' }); }, 70_000);
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 29 * 1024 * 1024) return send(413, { error: 'budget' }); chunks.push(chunk); }
      const result = await broker.dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')), controller.signal);
      if (!controller.signal.aborted) send(200, { result });
    } catch (error) { send(502, { error: /^telegram:api-\d{3}$/u.test(error?.message ?? '') ? error.message : 'telegram:transport-unavailable' }); }
    finally { clearTimeout(timer); active.delete(controller); }
  });
  server.headersTimeout = 10_000; server.requestTimeout = 75_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/telegram`, bearerToken,
    async close() { for (const c of active) c.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
