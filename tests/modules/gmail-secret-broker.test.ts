import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGmailOAuthController } from '../../desktop/electron/gmail-oauth-controller.mjs';
import { createGmailSecretBroker, GMAIL_SCOPES, startGmailSecretServer } from '../../desktop/electron/gmail-secret-broker.mjs';

const fixtureParent = path.resolve('runtime', 'gmail-broker-tests');
const roots: string[] = [];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (value: Buffer) => Buffer.from(value.toString('utf8').replace(/^protected:/u, ''), 'base64').toString('utf8'),
};
const grant = (root: string, fetchImpl: typeof fetch = fetch) => createGmailSecretBroker({
  dataRoot: root, safeStorage, fetchImpl, restrictAccess: async () => true,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
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
async function save(broker: ReturnType<typeof createGmailSecretBroker>, scopes = [GMAIL_SCOPES.read],
  permissions = { search: true, read: false, compose: false }) {
  await broker.saveOAuthGrant({ clientId: '12345678901234567890.apps.googleusercontent.com',
    clientSecret: 'desktop-client-secret', refreshToken: 'owner-refresh-token-1234567890',
    email: 'owner@example.com', scopes, permissions, connectedAt: '2026-09-13T00:00:00.000Z' });
}

describe('Gmail main-process secret broker', () => {
  it('stores only an encrypted OAuth grant and exposes a secret-free status', async () => {
    const dataRoot = await root(), broker = grant(dataRoot);
    await expect(broker.status()).resolves.toEqual({ connected: false, email: '',
      permissions: { search: false, read: false, compose: false } });
    await save(broker, [GMAIL_SCOPES.read, GMAIL_SCOPES.compose], { search: true, read: true, compose: true });
    const bytes = await readFile(path.join(dataRoot, 'gmail-oauth.encrypted'));
    expect(bytes.toString('utf8')).toContain('protected:');
    expect(bytes.toString('utf8')).not.toContain('owner-refresh-token');
    await expect(broker.operation('status')).resolves.toEqual({ connected: true, email: 'owner@example.com',
      permissions: { search: true, read: true, compose: true } });
  });

  it('refreshes credentials only inside main and returns bounded message metadata', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      calls.push({ url: String(url), options });
      if (String(url) === 'https://oauth2.googleapis.com/token') return json({ access_token: 'access-token-1234567890' });
      if (String(url).includes('/messages?')) return json({ messages: [{ id: 'message_1' }], resultSizeEstimate: 1 });
      return json({ id: 'message_1', threadId: 'thread_1', snippet: 'Bounded preview', payload: { headers: [
        { name: 'From', value: 'sender@example.com' }, { name: 'Subject', value: 'Status' },
      ] } });
    }) as unknown as typeof fetch;
    const broker = grant(await root(), fetchImpl); await save(broker);
    const result = await broker.operation('messages.search', { query: 'from:sender@example.com', maxResults: 5 });
    expect(result).toMatchObject({ messages: [{ id: 'message_1', threadId: 'thread_1', subject: 'Status' }] });
    expect(calls[0]?.options.body).toBeInstanceOf(URLSearchParams);
    expect(String(calls[0]?.options.body)).toContain('refresh_token=owner-refresh-token-1234567890');
    expect(calls[1]?.options.headers).toMatchObject({ authorization: 'Bearer access-token-1234567890' });
    expect(calls.filter(call => call.url === 'https://oauth2.googleapis.com/token')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('access-token');
  });

  it('propagates runtime cancellation into the active Google request', async () => {
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const fetchMock = vi.fn(async (_url: string | URL, options: RequestInit = {}) => {
      markEntered();
      return new Promise<Response>((_resolve, reject) => options.signal?.addEventListener('abort',
        () => reject(Error('google-request-aborted')), { once: true }));
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const broker = grant(await root(), fetchImpl);
    await save(broker);
    const controller = new AbortController();
    const pending = broker.operation('messages.search', { query: 'from:sender@example.com' }, controller.signal);
    await entered;
    controller.abort('stop');
    await expect(pending).rejects.toThrow('google-request-aborted');
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('creates RFC 822 drafts and sends only an exact draft id under compose scope', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      calls.push({ url: String(url), options });
      if (String(url) === 'https://oauth2.googleapis.com/token') return json({ access_token: 'access-token-1234567890' });
      if (String(url).endsWith('/drafts')) return json({ id: 'draft_1', message: { id: 'message_1', threadId: 'thread_1' } });
      return json({ id: 'message_1', threadId: 'thread_1', labelIds: ['SENT'] });
    }) as unknown as typeof fetch;
    const broker = grant(await root(), fetchImpl); await save(broker, [GMAIL_SCOPES.compose], { search: false, read: false, compose: true });
    await expect(broker.operation('draft.create', { to: ['friend@example.com'], subject: 'Hello\r\nBcc: bad@example.com',
      text: 'Body' })).resolves.toEqual({ draftId: 'draft_1', messageId: 'message_1', threadId: 'thread_1' });
    const raw = JSON.parse(String(calls.find(call => call.url.endsWith('/drafts'))?.options.body)).message.raw;
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('Subject: Hello  Bcc: bad@example.com\r\n');
    expect(decoded.match(/\r\nBcc:/gu)).toBeNull();
    await expect(broker.operation('draft.send', { draftId: 'draft_1' })).resolves.toMatchObject({ draftId: 'draft_1' });
    expect(calls.at(-1)?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send');
    expect(JSON.parse(String(calls.at(-1)?.options.body))).toEqual({ id: 'draft_1' });
  });

  it('denies body reads without readonly scope and protects the loopback host with a bearer', async () => {
    const broker = grant(await root()); await save(broker);
    await expect(broker.operation('message.read', { messageId: 'message_1' })).rejects.toThrow('gmail:permission-required');
    const server = await startGmailSecretServer(broker);
    try {
      await expect(fetch(server.endpoint, { method: 'POST', body: '{}' }).then(response => response.status)).resolves.toBe(401);
      const response = await fetch(server.endpoint, { method: 'POST', headers: {
        authorization: `Bearer ${server.bearerToken}`, 'content-type': 'application/json',
      }, body: JSON.stringify({ operation: 'status', input: {} }) });
      await expect(response.json()).resolves.toMatchObject({ result: { connected: true, email: 'owner@example.com' } });
    } finally { await server.close(); }
  });
});

describe('Gmail OAuth desktop flow', () => {
  it('binds state and PKCE to a loopback callback, verifies scopes and saves the account', async () => {
    const dataRoot = await root(), broker = grant(dataRoot);
    let authorization: URL | undefined;
    const fetchImpl = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        const body = options.body as URLSearchParams;
        expect(body.get('code')).toBe('authorization-code');
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{80,100}$/u);
        return json({ access_token: 'oauth-access-token-123456', refresh_token: 'oauth-refresh-token-123456',
          scope: authorization?.searchParams.get('scope') });
      }
      expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
      expect(options.headers).toMatchObject({ authorization: 'Bearer oauth-access-token-123456' });
      return json({ emailAddress: 'owner@example.com' });
    }) as unknown as typeof fetch;
    const controller = createGmailOAuthController({ broker,
      openExternal: async (value: string) => {
        authorization = new URL(value);
        expect(authorization.origin + authorization.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', authorization.searchParams.get('state')!);
        callback.searchParams.set('code', 'authorization-code');
        expect((await fetch(callback)).status).toBe(200);
      }, fetchImpl, timeoutMs: 5_000 });
    await expect(controller.connect({ clientId: '12345678901234567890.apps.googleusercontent.com',
      clientSecret: 'desktop-client-secret', permissions: { search: true, read: true, compose: true } }))
      .resolves.toMatchObject({ connected: true, email: 'owner@example.com',
        permissions: { search: true, read: true, compose: true } });
    expect(authorization?.searchParams.get('scope')?.split(' ').sort()).toEqual([
      GMAIL_SCOPES.compose, GMAIL_SCOPES.read,
    ].sort());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a forged loopback state before any provider exchange', async () => {
    const broker = grant(await root());
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    let callbackRequest: Promise<void> | undefined;
    const controller = createGmailOAuthController({ broker,
      openExternal: async (value: string) => {
        const authorization = new URL(value);
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', 'forged-state');
        callback.searchParams.set('code', 'authorization-code');
        callbackRequest = new Promise(resolve => setTimeout(resolve, 0)).then(async () => {
          expect((await fetch(callback)).status).toBe(400);
        });
      }, fetchImpl, timeoutMs: 5_000 });
    await expect(controller.connect({ clientId: '12345678901234567890.apps.googleusercontent.com',
      clientSecret: '', permissions: { search: true, read: false, compose: false } }))
      .rejects.toThrow('gmail:oauth-state');
    await callbackRequest;
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reserves the controller before listening and cancels exactly one active flow', async () => {
    const broker = grant(await root());
    let markOpened!: () => void;
    const opened = new Promise<void>(resolve => { markOpened = resolve; });
    const controller = createGmailOAuthController({ broker, openExternal: async () => { markOpened(); }, timeoutMs: 5_000 });
    const input = { clientId: '12345678901234567890.apps.googleusercontent.com', clientSecret: '',
      permissions: { search: true, read: false, compose: false } };
    const first = controller.connect(input);
    const firstRejected = expect(first).rejects.toThrow('gmail:oauth-cancelled');
    await opened;
    await expect(controller.connect(input)).rejects.toThrow('gmail:oauth-in-progress');
    await controller.close();
    await firstRejected;
    await controller.close();
  });
});
