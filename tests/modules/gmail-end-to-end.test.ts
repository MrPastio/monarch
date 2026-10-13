import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGmailSecretBroker, GMAIL_SCOPES, startGmailSecretServer } from '../../desktop/electron/gmail-secret-broker.mjs';
import { MonarchKernel } from '../../src/core';
import { GmailModule } from '../../src/modules/gmail';
import { GmailHostTransport } from '../../src/modules/gmail/host-transport';
import { createDeterministicSecurityModule } from '../fixtures/agent/deterministic-security-module';

/** The whole chain the agent uses: Kernel -> Gmail module -> loopback service
 * transport -> the real main-process broker server -> Gmail REST API. Only
 * Google itself is replaced; the OAuth grant, bearer binding, scope checks and
 * output bounding are the product's own. */
const fixtureParent = path.resolve('runtime', 'gmail-e2e-tests');
const roots: string[] = [];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (value: Buffer) => Buffer.from(value.toString('utf8').replace(/^protected:/u, ''), 'base64').toString('utf8'),
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => mkdir(fixtureParent, { recursive: true }));
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Gmail end to end through the Kernel', () => {
  it('searches, reads, drafts and sends through the real broker with a bound bearer and no credential egress', async () => {
    const dataRoot = await mkdtemp(path.join(fixtureParent, 'case-')); roots.push(dataRoot);
    const google: Array<{ url: string; method: string; authorization: string; body: string }> = [];
    const fetchImpl = (async (url: string | URL, options: RequestInit = {}) => {
      const target = String(url), headers = (options.headers ?? {}) as Record<string, string>;
      google.push({ url: target, method: options.method ?? 'GET', authorization: headers.authorization ?? '', body: String(options.body ?? '') });
      if (target === 'https://oauth2.googleapis.com/token') return json({ access_token: 'google-access-token-1234567890' });
      if (target.includes('/messages?')) return json({ messages: [{ id: 'msg_1' }], resultSizeEstimate: 1 });
      if (target.includes('/messages/msg_1?format=metadata')) return json({ id: 'msg_1', threadId: 'thr_1', snippet: 'Отчёт готов',
        payload: { headers: [{ name: 'From', value: 'boss@example.com' }, { name: 'Subject', value: 'Отчёт' }] } });
      if (target.includes('/messages/msg_1?format=full')) return json({ id: 'msg_1', threadId: 'thr_1', snippet: 'Отчёт готов',
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'boss@example.com' }, { name: 'Subject', value: 'Отчёт' }],
          body: { data: Buffer.from('Текст письма: отчёт готов к пятнице.', 'utf8').toString('base64url') } } });
      if (target.endsWith('/drafts')) return json({ id: 'draft_1', message: { id: 'msg_2', threadId: 'thr_1' } });
      if (target.endsWith('/drafts/send')) return json({ id: 'msg_2', threadId: 'thr_1', labelIds: ['SENT'] });
      return json({ error: 'unexpected' }, 404);
    }) as unknown as typeof fetch;
    const broker = createGmailSecretBroker({ dataRoot, safeStorage, fetchImpl, restrictAccess: async () => true });
    await broker.saveOAuthGrant({ clientId: '12345678901234567890.apps.googleusercontent.com', clientSecret: 'desktop-client-secret',
      refreshToken: 'owner-refresh-token-1234567890', email: 'owner@example.com',
      scopes: [GMAIL_SCOPES.read, GMAIL_SCOPES.compose], permissions: { search: true, read: true, compose: true },
      connectedAt: '2026-09-23T00:00:00.000Z' });
    const server = await startGmailSecretServer(broker);
    const kernel = new MonarchKernel();
    kernel.registerModule(createDeterministicSecurityModule());
    kernel.registerModule(new GmailModule(new GmailHostTransport({ endpoint: server.endpoint, token: server.bearerToken })));
    await kernel.start();
    const run = (capabilityId: string, input: Record<string, unknown>) => kernel.execute({ id: 'exec_' + capabilityId,
      intentId: 'intent_gmail_e2e', moduleId: 'gmail', capabilityId, input, requestedBy: 'e2e', confirmed: true,
      createdAt: new Date(0).toISOString() });
    try {
      const status = await run('gmail.connection.status', {});
      expect(status, status.summary).toMatchObject({ ok: true, output: { connected: true, email: 'owner@example.com' } });
      const search = await run('gmail.messages.search', { query: 'from:boss@example.com', maxResults: 5 });
      expect(search, search.summary).toMatchObject({ ok: true, output: { messages: [{ id: 'msg_1', subject: 'Отчёт' }] } });
      const read = await run('gmail.message.read', { messageId: 'msg_1' });
      expect(read, read.summary).toMatchObject({ ok: true });
      expect(JSON.stringify(read.output)).toContain('отчёт готов к пятнице');
      const draft = await run('gmail.draft.create', { to: ['boss@example.com'], subject: 'Re: Отчёт', text: 'Спасибо, получил.' });
      expect(draft, draft.summary).toMatchObject({ ok: true, output: { draftId: 'draft_1' } });
      const sent = await run('gmail.draft.send', { draftId: 'draft_1' });
      expect(sent, sent.summary).toMatchObject({ ok: true, output: { draftId: 'draft_1' } });
      // Google saw one token refresh and only bearer-authorised API calls.
      expect(google.filter(call => call.url === 'https://oauth2.googleapis.com/token').length).toBeGreaterThanOrEqual(1);
      for (const call of google.filter(entry => entry.url.startsWith('https://gmail.googleapis.com/'))) {
        expect(call.authorization).toBe('Bearer google-access-token-1234567890');
      }
      // No credential leaves the main-process broker through the runtime chain.
      const product = JSON.stringify([status, search, read, draft, sent]);
      for (const secret of ['google-access-token', 'owner-refresh-token', 'desktop-client-secret', server.bearerToken]) {
        expect(product).not.toContain(secret);
      }
      // A transport with the wrong bearer is refused by the broker server.
      const forged = new GmailModule(new GmailHostTransport({ endpoint: server.endpoint, token: 'f'.repeat(64) }));
      const forgedKernel = new MonarchKernel();
      forgedKernel.registerModule(createDeterministicSecurityModule());
      forgedKernel.registerModule(forged);
      await forgedKernel.start();
      try {
        const denied = await forgedKernel.execute({ id: 'exec_forged', intentId: 'intent_gmail_e2e', moduleId: 'gmail',
          capabilityId: 'gmail.messages.search', input: { query: 'x', maxResults: 1 }, requestedBy: 'e2e', confirmed: true,
          createdAt: new Date(0).toISOString() });
        expect(denied.ok).toBe(false);
      } finally { await forgedKernel.stop(); }
    } finally {
      await kernel.stop();
      await server.close();
    }
  });
});
