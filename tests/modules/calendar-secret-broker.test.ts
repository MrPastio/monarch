import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCalendarOAuthController } from '../../desktop/electron/calendar-oauth-controller.mjs';
import { CALENDAR_SCOPES, createCalendarSecretBroker, startCalendarSecretServer } from '../../desktop/electron/calendar-secret-broker.mjs';

const fixtureParent = path.resolve('runtime', 'calendar-broker-tests');
const roots: string[] = [];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (value: Buffer) => Buffer.from(value.toString('utf8').replace(/^protected:/u, ''), 'base64').toString('utf8'),
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const brokerFor = (dataRoot: string, fetchImpl: typeof fetch = fetch) => createCalendarSecretBroker({
  dataRoot, safeStorage, fetchImpl, restrictAccess: async () => true,
});

beforeAll(() => mkdir(fixtureParent, { recursive: true }));
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() {
  const value = await mkdtemp(path.join(fixtureParent, 'case-'));
  roots.push(value);
  return value;
}
async function save(broker: ReturnType<typeof createCalendarSecretBroker>,
  permissions = { read: true, manage: true }) {
  await broker.saveOAuthGrant({
    clientId: '12345678901234567890.apps.googleusercontent.com',
    clientSecret: 'desktop-client-secret',
    refreshToken: 'owner-refresh-token-1234567890',
    account: 'owner@example.com',
    calendarName: 'Owner calendar',
    scopes: [CALENDAR_SCOPES.calendarListRead,
      ...(permissions.manage ? [CALENDAR_SCOPES.eventsWrite] : [CALENDAR_SCOPES.eventsRead])],
    permissions,
    connectedAt: '2026-09-13T00:00:00.000Z',
  });
}

describe('Google Calendar main-process secret broker', () => {
  it('stores an independently encrypted OAuth grant and returns a secret-free status', async () => {
    const dataRoot = await root();
    const broker = brokerFor(dataRoot);
    await expect(broker.status()).resolves.toEqual({ connected: false, account: '', calendarName: '',
      permissions: { read: false, manage: false } });
    await save(broker);
    const encrypted = await readFile(path.join(dataRoot, 'calendar-oauth.encrypted'));
    expect(encrypted.toString('utf8')).toContain('protected:');
    expect(encrypted.toString('utf8')).not.toContain('owner-refresh-token');
    await expect(broker.status()).resolves.toEqual({ connected: true, account: 'owner@example.com',
      calendarName: 'Owner calendar', permissions: { read: true, manage: true } });
  });

  it('lists a bounded time window and exposes only selected event fields', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      calls.push({ url: String(url), options });
      if (String(url) === 'https://oauth2.googleapis.com/token') return json({ access_token: 'calendar-access-token-1234' });
      return json({ timeZone: 'Europe/Berlin', items: [{ id: 'event_1', etag: '"etag-1"', status: 'confirmed',
        htmlLink: 'https://calendar.google.com/event?eid=1', summary: 'Review', description: 'Private notes',
        start: { dateTime: '2026-09-13T10:00:00Z' }, end: { dateTime: '2026-09-13T11:00:00Z' },
        conferenceData: { secret: true }, attendees: [{ email: 'friend@example.com', responseStatus: 'accepted' }] }] });
    }) as unknown as typeof fetch;
    const broker = brokerFor(await root(), fetchImpl);
    await save(broker);
    const result = await broker.operation('events.list', { calendarId: 'primary',
      timeMin: '2026-09-13T00:00:00Z', timeMax: '2026-09-14T00:00:00Z', maxResults: 10 });
    expect(result).toMatchObject({ timeZone: 'Europe/Berlin', events: [{ id: 'event_1', summary: 'Review' }] });
    expect(JSON.stringify(result)).not.toContain('conferenceData');
    expect(calls[1]?.url).toContain('/calendars/primary/events?');
    expect(calls[1]?.url).toContain('singleEvents=true');
    expect(calls[1]?.options.headers).toMatchObject({ authorization: 'Bearer calendar-access-token-1234' });
  });

  it('requires an explicit notification policy for attendees and conditionally updates by ETag', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      calls.push({ url: String(url), options });
      if (String(url) === 'https://oauth2.googleapis.com/token') return json({ access_token: 'calendar-access-token-1234' });
      return json({ id: 'event_1', etag: '"etag-2"', status: 'confirmed', summary: 'Updated',
        start: { dateTime: '2026-09-13T10:00:00Z' }, end: { dateTime: '2026-09-13T11:00:00Z' } });
    }) as unknown as typeof fetch;
    const broker = brokerFor(await root(), fetchImpl);
    await save(broker);
    await expect(broker.operation('event.create', { calendarId: 'primary', summary: 'Review',
      start: '2026-09-13T10:00:00Z', end: '2026-09-13T11:00:00Z', attendees: ['friend@example.com'] }))
      .rejects.toThrow('calendar:send-updates-required');
    const result = await broker.operation('event.update', { calendarId: 'primary', eventId: 'event_1', etag: '"etag-1"',
      summary: 'Updated', attendees: ['friend@example.com'], sendUpdates: 'all' });
    expect(result).toMatchObject({ id: 'event_1', etag: '"etag-2"', summary: 'Updated' });
    const request = calls.at(-1);
    expect(request?.url).toContain('/events/event_1?sendUpdates=all');
    expect(request?.options.method).toBe('PATCH');
    expect(request?.options.headers).toMatchObject({ 'if-match': '"etag-1"' });
  });

  it('protects the exact loopback host with an ephemeral bearer', async () => {
    const broker = brokerFor(await root());
    await save(broker);
    const server = await startCalendarSecretServer(broker);
    try {
      await expect(fetch(server.endpoint, { method: 'POST', body: '{}' }).then(response => response.status)).resolves.toBe(401);
      const response = await fetch(server.endpoint, { method: 'POST', headers: {
        authorization: `Bearer ${server.bearerToken}`, 'content-type': 'application/json',
      }, body: JSON.stringify({ operation: 'status', input: {} }) });
      await expect(response.json()).resolves.toMatchObject({ result: { connected: true, account: 'owner@example.com' } });
    } finally { await server.close(); }
  });
});

describe('Google Calendar OAuth desktop flow', () => {
  it('uses a separate PKCE consent and verifies the primary calendar before saving', async () => {
    const broker = brokerFor(await root());
    let authorization: URL | undefined;
    const fetchImpl = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        const body = options.body as URLSearchParams;
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{80,100}$/u);
        return json({ access_token: 'oauth-access-token-123456', refresh_token: 'oauth-refresh-token-123456',
          scope: authorization?.searchParams.get('scope') });
      }
      expect(String(url)).toContain('/calendar/v3/users/me/calendarList?maxResults=250');
      expect(options.headers).toMatchObject({ authorization: 'Bearer oauth-access-token-123456' });
      return json({ items: [{ id: 'owner@example.com', summary: 'Owner calendar', primary: true }] });
    }) as unknown as typeof fetch;
    const controller = createCalendarOAuthController({ broker,
      openExternal: async (value: string) => {
        authorization = new URL(value);
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', authorization.searchParams.get('state')!);
        callback.searchParams.set('code', 'calendar-authorization-code');
        expect((await fetch(callback)).status).toBe(200);
      }, fetchImpl, timeoutMs: 5_000 });
    await expect(controller.connect({ clientId: '12345678901234567890.apps.googleusercontent.com',
      clientSecret: '', permissions: { read: true, manage: false } })).resolves.toMatchObject({
      connected: true, account: 'owner@example.com', permissions: { read: true, manage: false },
    });
    expect(authorization?.searchParams.get('scope')?.split(' ').sort()).toEqual([
      CALENDAR_SCOPES.calendarListRead, CALENDAR_SCOPES.eventsRead,
    ].sort());
  });
});
