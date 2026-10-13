import path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { startServiceSecretServer } from './service-secret-server.mjs';
import { renameWithRetry } from './windows-rename.mjs';

const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN = 'https://oauth2.googleapis.com/token';
const CALENDAR_LIST_READ = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const EVENTS_READ = 'https://www.googleapis.com/auth/calendar.events.readonly';
const EVENTS_WRITE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_SCOPES = Object.freeze({ calendarListRead: CALENDAR_LIST_READ,
  eventsRead: EVENTS_READ, eventsWrite: EVENTS_WRITE });
const SUPPORTED_SCOPES = Object.freeze([CALENDAR_LIST_READ, EVENTS_READ, EVENTS_WRITE]);

async function bounded(response, maximum = 2 * 1024 * 1024) {
  if (!response.body) throw Error('calendar:empty-response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw Error('calendar:response-budget');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function json(response, maximum) {
  let value;
  try { value = JSON.parse((await bounded(response, maximum)).toString('utf8')); }
  catch (error) {
    if (error?.message?.startsWith('calendar:')) throw error;
    throw Error('calendar:provider-json');
  }
  if (!response.ok) throw Error(response.status === 401 ? 'calendar:authentication'
    : response.status === 403 ? 'calendar:scope-required'
      : response.status === 404 ? 'calendar:not-found'
        : response.status === 409 || response.status === 412 ? 'calendar:conflict'
          : 'calendar:provider-rejected');
  return value;
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw Error('calendar:input');
  return value;
}

function text(value, maximum, required = false) {
  const result = String(value ?? '').trim();
  if (required && !result || Buffer.byteLength(result) > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    throw Error('calendar:input');
  }
  return result;
}

function calendarId(value) { return text(value, 1024, true); }
function eventId(value) {
  const result = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(result)) throw Error('calendar:input');
  return result;
}
function etag(value) {
  const result = String(value || '');
  if (!/^"[^"\r\n]{1,1024}"$/u.test(result)) throw Error('calendar:input');
  return result;
}
function integer(value, fallback, minimum, maximum) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw Error('calendar:input');
  return result;
}
function dateTime(value) {
  const result = String(value || '');
  if (result.length > 64 || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(result)
    || !Number.isFinite(Date.parse(result))) throw Error('calendar:input');
  return result;
}
function timeZone(value) {
  if (value === undefined) return undefined;
  const result = String(value || '');
  if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+){1,3}$/u.test(result) || result.length > 128) throw Error('calendar:input');
  return result;
}
function emails(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw Error('calendar:input');
  return value.map(item => {
    const email = String(item || '').trim();
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(email) || email.length > 254) throw Error('calendar:input');
    return email;
  });
}
function sendUpdates(value, hasAttendees) {
  if (value === undefined) {
    if (hasAttendees) throw Error('calendar:send-updates-required');
    return 'none';
  }
  if (!['none', 'all', 'externalOnly'].includes(value)) throw Error('calendar:input');
  return value;
}
function scopeSet(value) { return new Set(Array.isArray(value) ? value.filter(scope => SUPPORTED_SCOPES.includes(scope)) : []); }
function requireScope(record, choices) {
  if (!choices.some(scope => scopeSet(record.scopes).has(scope))) throw Error('calendar:scope-required');
}
function requirePermission(record, name) {
  if (record.permissions?.[name] !== true) throw Error('calendar:permission-required');
}
function safeUrl(value) {
  const result = String(value || '');
  try { return new URL(result).protocol === 'https:' ? result.slice(0, 4096) : ''; }
  catch { return ''; }
}
function presentDate(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    ...(typeof value.dateTime === 'string' ? { dateTime: value.dateTime.slice(0, 64) } : {}),
    ...(typeof value.date === 'string' ? { date: value.date.slice(0, 10) } : {}),
    ...(typeof value.timeZone === 'string' ? { timeZone: value.timeZone.slice(0, 128) } : {}),
  };
}
function presentEvent(value) {
  return {
    id: eventId(value?.id),
    etag: typeof value?.etag === 'string' ? value.etag.slice(0, 1024) : '',
    status: String(value?.status || '').slice(0, 32),
    htmlLink: safeUrl(value?.htmlLink),
    summary: String(value?.summary || '').slice(0, 4096),
    description: String(value?.description || '').slice(0, 16_384),
    location: String(value?.location || '').slice(0, 4096),
    start: presentDate(value?.start),
    end: presentDate(value?.end),
    organizer: String(value?.organizer?.email || '').slice(0, 320),
    attendees: Array.isArray(value?.attendees) ? value.attendees.slice(0, 50).map(item => ({
      email: String(item?.email || '').slice(0, 254),
      responseStatus: String(item?.responseStatus || '').slice(0, 32),
    })) : [],
  };
}

export function createCalendarSecretBroker({ dataRoot, safeStorage, fetchImpl = fetch, restrictAccess = async () => true }) {
  const recordPath = path.join(dataRoot, 'calendar-oauth.encrypted');
  const requireEncryption = () => {
    if (!safeStorage?.isEncryptionAvailable?.()) throw Error('calendar:encryption-unavailable');
  };
  function normalizeGrant(value) {
    const scopes = [...scopeSet(value?.scopes)].sort();
    const permissions = value?.permissions;
    const expectedScopes = [CALENDAR_LIST_READ,
      ...(permissions?.manage === true ? [EVENTS_WRITE] : permissions?.read === true ? [EVENTS_READ] : [])].sort();
    if (!value || typeof value.clientId !== 'string'
      || !/^[A-Za-z0-9._-]{20,256}\.apps\.googleusercontent\.com$/u.test(value.clientId)
      || value.clientSecret !== undefined && (typeof value.clientSecret !== 'string' || value.clientSecret.length > 512)
      || typeof value.refreshToken !== 'string' || value.refreshToken.length < 16 || value.refreshToken.length > 4096
      || typeof value.account !== 'string' || !value.account || value.account.length > 320
      || typeof value.calendarName !== 'string' || value.calendarName.length > 512
      || !permissions || typeof permissions !== 'object' || Array.isArray(permissions)
      || Object.keys(permissions).sort().join(',') !== 'manage,read'
      || Object.values(permissions).some(item => typeof item !== 'boolean')
      || !permissions.read && !permissions.manage
      || !Array.isArray(value.scopes) || value.scopes.length !== new Set(value.scopes).size
      || scopes.join('\n') !== expectedScopes.join('\n')) throw Error('calendar:credential-record');
    return {
      version: 1,
      clientId: value.clientId,
      ...(value.clientSecret ? { clientSecret: value.clientSecret } : {}),
      refreshToken: value.refreshToken,
      account: value.account,
      calendarName: value.calendarName,
      scopes,
      permissions: { read: permissions.read, manage: permissions.manage },
      connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : new Date().toISOString(),
    };
  }
  async function readRecord() {
    requireEncryption();
    let bytes;
    try { bytes = await readFile(recordPath); }
    catch (error) {
      if (error?.code === 'ENOENT') throw Error('calendar:not-connected');
      throw Error('calendar:credential-record');
    }
    if (bytes.byteLength > 32 * 1024) throw Error('calendar:credential-record');
    let value;
    try { value = JSON.parse(safeStorage.decryptString(bytes)); }
    catch { throw Error('calendar:credential-record'); }
    return normalizeGrant(value);
  }
  async function saveRecord(record) {
    const normalized = normalizeGrant(record);
    requireEncryption();
    await mkdir(dataRoot, { recursive: true });
    if (await restrictAccess(dataRoot) !== true) throw Error('calendar:protected-record');
    const temporary = `${recordPath}.${randomBytes(8).toString('hex')}.tmp`;
    const encrypted = Buffer.from(safeStorage.encryptString(JSON.stringify(normalized)));
    if (!encrypted.length || encrypted.length > 32 * 1024) throw Error('calendar:credential-record');
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      await renameWithRetry(temporary, recordPath);
    } catch (error) {
      await unlink(temporary).catch(unlinkError => {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      });
      throw error;
    }
  }
  async function accessToken(record, signal) {
    const response = await fetchImpl(TOKEN, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: record.clientId,
        refresh_token: record.refreshToken,
        grant_type: 'refresh_token',
        ...(record.clientSecret ? { client_secret: record.clientSecret } : {}),
      }),
      signal,
    });
    const payload = await json(response, 32 * 1024);
    if (typeof payload.access_token !== 'string' || payload.access_token.length < 16) throw Error('calendar:authentication');
    return payload.access_token;
  }
  async function api(record, url, options = {}) {
    const signal = options.signal ?? AbortSignal.timeout(60_000);
    const accessTokenValue = options.accessToken ?? await accessToken(record, signal);
    const response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${accessTokenValue}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.etag ? { 'if-match': options.etag } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
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
    if (name === 'calendars.list') {
      exact(input, ['maxResults']);
      requirePermission(record, 'read');
      requireScope(record, [EVENTS_READ, EVENTS_WRITE]);
      const maxResults = integer(input.maxResults, 20, 1, 50);
      const payload = await api(record, `${API}/users/me/calendarList?maxResults=${maxResults}`, { signal: operationSignal });
      return { calendars: Array.isArray(payload.items) ? payload.items.slice(0, maxResults).map(item => ({
        id: String(item?.id || '').slice(0, 1024),
        summary: String(item?.summaryOverride || item?.summary || '').slice(0, 512),
        primary: item?.primary === true,
        accessRole: String(item?.accessRole || '').slice(0, 32),
        timeZone: String(item?.timeZone || '').slice(0, 128),
      })) : [] };
    }
    if (name === 'events.list') {
      exact(input, ['calendarId', 'timeMin', 'timeMax', 'query', 'maxResults']);
      requirePermission(record, 'read');
      requireScope(record, [EVENTS_READ, EVENTS_WRITE]);
      const targetCalendar = calendarId(input.calendarId);
      const timeMin = dateTime(input.timeMin);
      const timeMax = dateTime(input.timeMax);
      if (Date.parse(timeMax) <= Date.parse(timeMin) || Date.parse(timeMax) - Date.parse(timeMin) > 366 * 86_400_000) {
        throw Error('calendar:input');
      }
      const maxResults = integer(input.maxResults, 20, 1, 50);
      const query = input.query === undefined ? '' : text(input.query, 2048);
      const search = new URLSearchParams({ timeMin, timeMax, maxResults: String(maxResults), singleEvents: 'true',
        orderBy: 'startTime', showDeleted: 'false', ...(query ? { q: query } : {}) });
      const payload = await api(record, `${API}/calendars/${encodeURIComponent(targetCalendar)}/events?${search}`, { signal: operationSignal });
      return { timeZone: String(payload.timeZone || '').slice(0, 128),
        events: Array.isArray(payload.items) ? payload.items.slice(0, maxResults).map(presentEvent) : [] };
    }
    if (name === 'event.create') {
      exact(input, ['calendarId', 'summary', 'description', 'location', 'start', 'end', 'timeZone', 'attendees', 'sendUpdates']);
      requirePermission(record, 'manage');
      requireScope(record, [EVENTS_WRITE]);
      const start = dateTime(input.start);
      const end = dateTime(input.end);
      if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 366 * 86_400_000) throw Error('calendar:input');
      const zone = timeZone(input.timeZone);
      const attendees = emails(input.attendees);
      const updates = sendUpdates(input.sendUpdates, Boolean(attendees?.length));
      const body = {
        summary: text(input.summary, 4096, true),
        ...(input.description !== undefined ? { description: text(input.description, 16_384) } : {}),
        ...(input.location !== undefined ? { location: text(input.location, 4096) } : {}),
        start: { dateTime: start, ...(zone ? { timeZone: zone } : {}) },
        end: { dateTime: end, ...(zone ? { timeZone: zone } : {}) },
        ...(attendees ? { attendees: attendees.map(email => ({ email })) } : {}),
      };
      const created = await api(record, `${API}/calendars/${encodeURIComponent(calendarId(input.calendarId))}/events?sendUpdates=${updates}`,
        { method: 'POST', signal: operationSignal, body });
      return presentEvent(created);
    }
    if (name === 'event.update') {
      exact(input, ['calendarId', 'eventId', 'etag', 'summary', 'description', 'location', 'start', 'end', 'timeZone', 'attendees', 'sendUpdates']);
      requirePermission(record, 'manage');
      requireScope(record, [EVENTS_WRITE]);
      const mutableKeys = ['summary', 'description', 'location', 'start', 'end', 'attendees'];
      if (!mutableKeys.some(key => Object.hasOwn(input, key)) || Object.hasOwn(input, 'start') !== Object.hasOwn(input, 'end')) {
        throw Error('calendar:input');
      }
      const zone = timeZone(input.timeZone);
      const attendees = emails(input.attendees);
      const body = {
        ...(input.summary !== undefined ? { summary: text(input.summary, 4096, true) } : {}),
        ...(input.description !== undefined ? { description: text(input.description, 16_384) } : {}),
        ...(input.location !== undefined ? { location: text(input.location, 4096) } : {}),
        ...(input.start !== undefined ? {
          start: { dateTime: dateTime(input.start), ...(zone ? { timeZone: zone } : {}) },
          end: { dateTime: dateTime(input.end), ...(zone ? { timeZone: zone } : {}) },
        } : {}),
        ...(attendees ? { attendees: attendees.map(email => ({ email })) } : {}),
      };
      if (body.start && (Date.parse(body.end.dateTime) <= Date.parse(body.start.dateTime)
        || Date.parse(body.end.dateTime) - Date.parse(body.start.dateTime) > 366 * 86_400_000)) throw Error('calendar:input');
      const updates = sendUpdates(input.sendUpdates, Boolean(attendees?.length));
      const updated = await api(record,
        `${API}/calendars/${encodeURIComponent(calendarId(input.calendarId))}/events/${eventId(input.eventId)}?sendUpdates=${updates}`,
        { method: 'PATCH', signal: operationSignal, body, etag: etag(input.etag) });
      return presentEvent(updated);
    }
    throw Error('calendar:operation-denied');
  }
  const present = record => ({ connected: true, account: record.account, calendarName: record.calendarName,
    permissions: { ...record.permissions } });
  const status = () => readRecord().then(present).catch(error => error.message === 'calendar:not-connected'
    ? { connected: false, account: '', calendarName: '', permissions: { read: false, manage: false } }
    : Promise.reject(error));
  const disconnect = async () => {
    try { await unlink(recordPath); }
    catch (error) { if (error?.code !== 'ENOENT') throw Error('calendar:credential-record'); }
    return status();
  };
  return { operation, saveOAuthGrant: saveRecord, status, disconnect };
}

export function startCalendarSecretServer(broker) {
  return startServiceSecretServer({ serviceId: 'calendar', operation: broker.operation });
}
