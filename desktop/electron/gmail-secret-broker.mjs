import path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { startServiceSecretServer } from './service-secret-server.mjs';
import { renameWithRetry } from './windows-rename.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN = 'https://oauth2.googleapis.com/token';
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
export const GMAIL_SCOPES = Object.freeze({ read: READ, compose: COMPOSE });
const SUPPORTED_SCOPES = Object.freeze([READ, COMPOSE]);

async function bounded(response, max = 2 * 1024 * 1024) {
  if (!response.body) throw Error('gmail:empty-response');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > max) { await reader.cancel(); throw Error('gmail:response-budget'); }
    chunks.push(Buffer.from(value)); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
const json = async (response, max) => {
  let value; try { value = JSON.parse((await bounded(response, max)).toString('utf8')); }
  catch (error) { if (error?.message?.startsWith('gmail:')) throw error; throw Error('gmail:provider-json'); }
  if (!response.ok) throw Error(response.status === 401 ? 'gmail:authentication'
    : response.status === 403 ? 'gmail:scope-required' : 'gmail:provider-rejected');
  return value;
};
const id = value => { const text = String(value || ''); if (!/^[A-Za-z0-9_-]{1,128}$/u.test(text)) throw Error('gmail:input'); return text; };
const scopeSet = value => new Set(Array.isArray(value) ? value.filter(scope => SUPPORTED_SCOPES.includes(scope)) : []);
const requireScope = (record, choices) => { if (!choices.some(scope => scopeSet(record.scopes).has(scope))) throw Error('gmail:scope-required'); };
const requirePermission = (record, name) => { if (record.permissions?.[name] !== true) throw Error('gmail:permission-required'); };
const header = (headers, name) => String(headers.find(item => String(item.name).toLowerCase() === name.toLowerCase())?.value || '').slice(0, 4096);
const base64url = value => Buffer.from(value, 'utf8').toString('base64url');
const decodeBody = data => { try { return Buffer.from(String(data || ''), 'base64url').toString('utf8'); } catch { return ''; } };
function bodyText(payload) {
  const queue = [payload], parts = [];
  while (queue.length && parts.join('').length < 100_000) {
    const part = queue.shift(); if (!part || typeof part !== 'object') continue;
    if (String(part.mimeType || '').toLowerCase() === 'text/plain' && part.body?.data) parts.push(decodeBody(part.body.data));
    if (Array.isArray(part.parts)) queue.push(...part.parts);
  }
  return parts.join('\n').slice(0, 100_000);
}
function addresses(value, required = false) {
  if (!Array.isArray(value) || value.length > 20 || required && value.length === 0) throw Error('gmail:input');
  return value.map(item => { const email = String(item || '').trim();
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(email) || email.length > 254) throw Error('gmail:input'); return email; });
}

export function createGmailSecretBroker({ dataRoot, safeStorage, fetchImpl = fetch, restrictAccess = async () => true }) {
  const recordPath = path.join(dataRoot, 'gmail-oauth.encrypted');
  const requireEncryption = () => { if (!safeStorage?.isEncryptionAvailable?.()) throw Error('gmail:encryption-unavailable'); };
  function normalizeGrant(value) {
    const scopes = [...scopeSet(value?.scopes)].sort();
    const permissions = value?.permissions;
    if (!value || typeof value.clientId !== 'string' || !/^[A-Za-z0-9._-]{20,256}\.apps\.googleusercontent\.com$/u.test(value.clientId)
      || value.clientSecret !== undefined && (typeof value.clientSecret !== 'string' || value.clientSecret.length > 512)
      || typeof value.refreshToken !== 'string' || value.refreshToken.length < 16 || value.refreshToken.length > 4096
      || typeof value.email !== 'string' || !/^[^\s@]+@[^\s@]+$/u.test(value.email) || value.email.length > 320
      || scopes.length < 1 || !Array.isArray(value.scopes) || scopes.length !== new Set(value.scopes).size
      || value.scopes.some(scope => !SUPPORTED_SCOPES.includes(scope))
      || !permissions || typeof permissions !== 'object' || Array.isArray(permissions)
      || Object.keys(permissions).sort().join(',') !== 'compose,read,search'
      || Object.values(permissions).some(item => typeof item !== 'boolean')
      || !permissions.search && !permissions.read && !permissions.compose
      || (permissions.search || permissions.read) !== scopes.includes(READ)
      || permissions.compose !== scopes.includes(COMPOSE)) throw Error('gmail:credential-record');
    return { version: 1, clientId: value.clientId, ...(value.clientSecret ? { clientSecret: value.clientSecret } : {}),
      refreshToken: value.refreshToken, email: value.email, scopes, permissions: { ...permissions },
      connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : new Date().toISOString() };
  }
  async function readRecord() {
    requireEncryption(); let bytes; try { bytes = await readFile(recordPath); } catch (error) {
      if (error?.code === 'ENOENT') throw Error('gmail:not-connected'); throw Error('gmail:credential-record'); }
    if (bytes.byteLength > 32 * 1024) throw Error('gmail:credential-record');
    let value; try { value = JSON.parse(safeStorage.decryptString(bytes)); } catch { throw Error('gmail:credential-record'); }
    return normalizeGrant(value);
  }
  async function saveRecord(record) {
    const normalized = normalizeGrant(record);
    requireEncryption(); await mkdir(dataRoot, { recursive: true });
    if (await restrictAccess(dataRoot) !== true) throw Error('gmail:protected-record');
    const temporary = `${recordPath}.${randomBytes(8).toString('hex')}.tmp`;
    const encrypted = Buffer.from(safeStorage.encryptString(JSON.stringify(normalized)));
    if (!encrypted.length || encrypted.length > 32 * 1024) throw Error('gmail:credential-record');
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      await renameWithRetry(temporary, recordPath);
    } catch (error) {
      await unlink(temporary).catch(unlinkError => { if (unlinkError?.code !== 'ENOENT') throw unlinkError; });
      throw error;
    }
  }
  async function accessToken(record, signal) {
    const body = new URLSearchParams({ client_id: record.clientId, refresh_token: record.refreshToken,
      grant_type: 'refresh_token', ...(record.clientSecret ? { client_secret: record.clientSecret } : {}) });
    const response = await fetchImpl(TOKEN, { method: 'POST', redirect: 'error', headers: {
      'content-type': 'application/x-www-form-urlencoded' }, body, signal });
    const payload = await json(response, 32 * 1024);
    if (typeof payload.access_token !== 'string' || payload.access_token.length < 16) throw Error('gmail:authentication');
    return payload.access_token;
  }
  async function api(record, url, options = {}) {
    const signal = options.signal ?? AbortSignal.timeout(60_000);
    const token = options.accessToken ?? await accessToken(record, signal);
    const response = await fetchImpl(url, { method: options.method ?? 'GET', redirect: 'error', signal,
      headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    return json(response, options.maxBytes ?? 2 * 1024 * 1024);
  }
  async function operation(name, input = {}, signal) {
    signal?.throwIfAborted();
    if (name === 'status') return status();
    const record = await readRecord();
    signal?.throwIfAborted();
    const operationSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    if (name === 'messages.search') {
      requirePermission(record, 'search'); requireScope(record, [READ]);
      const query = String(input.query || '').trim(), maxResults = input.maxResults === undefined ? 10 : Number(input.maxResults);
      if (!query || Buffer.byteLength(query) > 2048 || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 50) throw Error('gmail:input');
      const accessTokenValue = await accessToken(record, operationSignal);
      const listed = await api(record, `${API}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
        { signal: operationSignal, accessToken: accessTokenValue });
      const refs = Array.isArray(listed.messages) ? listed.messages.slice(0, maxResults) : [];
      const messages = [];
      for (const ref of refs) { const messageId = id(ref.id); const message = await api(record,
        `${API}/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { signal: operationSignal, accessToken: accessTokenValue, maxBytes: 256 * 1024 });
      const headers = message.payload?.headers ?? []; messages.push({ id: messageId, threadId: id(message.threadId),
        from: header(headers, 'From'), to: header(headers, 'To'), subject: header(headers, 'Subject'),
        date: header(headers, 'Date'), snippet: String(message.snippet || '').slice(0, 4096) }); }
      return { messages, resultSizeEstimate: Number(listed.resultSizeEstimate || messages.length) };
    }
    if (name === 'message.read') {
      requirePermission(record, 'read'); requireScope(record, [READ]); const messageId = id(input.messageId);
      const message = await api(record, `${API}/messages/${messageId}?format=full`,
        { signal: operationSignal }), headers = message.payload?.headers ?? [];
      return { id: messageId, threadId: id(message.threadId), from: header(headers, 'From'), to: header(headers, 'To'),
        cc: header(headers, 'Cc'), subject: header(headers, 'Subject'), date: header(headers, 'Date'),
        snippet: String(message.snippet || '').slice(0, 4096), text: bodyText(message.payload) };
    }
    if (name === 'draft.create') {
      requirePermission(record, 'compose'); requireScope(record, [COMPOSE]); const to = addresses(input.to, true), cc = addresses(input.cc ?? []), bcc = addresses(input.bcc ?? []);
      const subject = String(input.subject ?? '').replace(/[\r\n]/gu, ' ').slice(0, 998);
      const text = String(input.text || ''); if (!text || Buffer.byteLength(text) > 100_000) throw Error('gmail:input');
      const lines = [`To: ${to.join(', ')}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
        ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []), `Subject: ${subject}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text];
      const draft = await api(record, `${API}/drafts`, { method: 'POST', signal: operationSignal,
        body: { message: { raw: base64url(lines.join('\r\n')) } } });
      return { draftId: id(draft.id), messageId: id(draft.message?.id), threadId: id(draft.message?.threadId) };
    }
    if (name === 'draft.send') {
      requirePermission(record, 'compose'); requireScope(record, [COMPOSE]); const draftId = id(input.draftId);
      const sent = await api(record, `${API}/drafts/send`, { method: 'POST', signal: operationSignal,
        body: { id: draftId } });
      return { draftId, messageId: id(sent.id), threadId: id(sent.threadId), labelIds: Array.isArray(sent.labelIds) ? sent.labelIds.slice(0, 32) : [] };
    }
    throw Error('gmail:operation-denied');
  }
  const present = record => ({ connected: true, email: record.email, permissions: { ...record.permissions } });
  const status = () => readRecord().then(present).catch(error => error.message === 'gmail:not-connected'
    ? { connected: false, email: '', permissions: { search: false, read: false, compose: false } } : Promise.reject(error));
  const disconnect = async () => {
    try { await unlink(recordPath); } catch (error) { if (error?.code !== 'ENOENT') throw Error('gmail:credential-record'); }
    return status();
  };
  return { operation, saveOAuthGrant: saveRecord, status, disconnect };
}

export function startGmailSecretServer(broker) {
  return startServiceSecretServer({ serviceId: 'gmail', operation: broker.operation });
}
