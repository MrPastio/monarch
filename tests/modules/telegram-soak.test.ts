import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MonarchKernel } from '../../src/core';
import { TelegramModule } from '../../src/modules/telegram';
import { createDeterministicSecurityModule } from '../fixtures/agent/deterministic-security-module';

/** A loopback Bot API with Telegram's offset semantics and injected faults:
 * getUpdates answers 502 or drops the socket periodically, sendMessage answers
 * 429 with retry_after. The real module, poll loop and state file are used. */
async function startFaultyBotApi(options: { failUpdatesEvery: number; dropUpdatesEvery: number; throttleSendEvery: number }) {
  const updates: Array<{ update_id: number; message: Record<string, unknown> }> = [];
  const replies: Array<{ chatId: number; text: string; replyTo?: number }> = [];
  const faults = { updates502: 0, updatesDropped: 0, send429: 0 };
  const counters = { getUpdates: 0, send: 0 };
  let getUpdatesCalls = 0, sendCalls = 0, messageId = 1_000;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const method = String(request.url || '').split('/').pop() || '';
      const input = body ? JSON.parse(body) as Record<string, unknown> : {};
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (method === 'getMe') return reply(200, { ok: true, result: { id: 1, is_bot: true, first_name: 'Soak', username: 'soak_bot' } });
      if (method === 'getUpdates') {
        getUpdatesCalls += 1; counters.getUpdates = getUpdatesCalls;
        if (getUpdatesCalls % options.dropUpdatesEvery === 0) { faults.updatesDropped += 1; request.socket.destroy(); return; }
        if (getUpdatesCalls % options.failUpdatesEvery === 0) {
          faults.updates502 += 1;
          return reply(502, { ok: false, error_code: 502, description: 'Bad Gateway' });
        }
        const offset = Number(input.offset || 0), limit = Number(input.limit || 100);
        const pending = updates.filter(update => update.update_id >= offset).slice(0, limit);
        if (pending.length) return reply(200, { ok: true, result: pending });
        setTimeout(() => reply(200, { ok: true, result: [] }), 60);
        return;
      }
      if (method === 'sendMessage' || method === 'editMessageText') {
        sendCalls += 1; counters.send = sendCalls;
        if (sendCalls % options.throttleSendEvery === 0) {
          faults.send429 += 1;
          return reply(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1',
            parameters: { retry_after: 1 } });
        }
        replies.push({ chatId: Number(input.chat_id), text: String(input.text || ''),
          replyTo: (input.reply_parameters as { message_id?: number } | undefined)?.message_id });
        return reply(200, { ok: true, result: { message_id: messageId++, chat: { id: input.chat_id, type: 'private' },
          date: 0, text: input.text } });
      }
      return reply(200, { ok: true, result: true });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, updates, replies, faults, counters,
    close: async () => { server.closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

describe('Telegram bot stability under load and Bot API faults', () => {
  it('answers every owner message exactly once through 502s, dropped polls and 429s, and stops promptly', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-soak-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ offset: 0, pairings: [{ chatId: 55, userId: 9, pairedAt: new Date(0).toISOString() }],
      reminders: [], pendingTaskDeliveries: [], remotePaused: false, pairingAttempts: {} }), 'utf8');
    const api = await startFaultyBotApi({ failUpdatesEvery: 5, dropUpdatesEvery: 7, throttleSendEvery: 11 });
    // The flood guard is exercised separately; here it is raised to load the transport.
    const module = new TelegramModule({ projectRoot: root, apiBase: api.apiBase, token: 'soak-token', autoStart: false,
      inboundRateLimit: { limit: 10_000, windowMs: 60_000 } });
    const dispatched = new Map<string, number>();
    module.setIntentDispatcher(async request => {
      dispatched.set(request.text, (dispatched.get(request.text) ?? 0) + 1);
      return { intent: { id: 'intent_' + dispatched.size, text: request.text, source: 'telegram', createdAt: new Date(0).toISOString() },
        route: null, plan: null, execution: { ok: true, summary: 'Ответ: ' + request.text }, summary: 'Ответ: ' + request.text };
    });
    const kernel = new MonarchKernel();
    kernel.registerModule(createDeterministicSecurityModule());
    kernel.registerModule(module);
    await kernel.start();
    const total = 200;
    const execute = (capabilityId: string) => kernel.execute({ id: 'exec_' + capabilityId, intentId: 'intent_soak',
      moduleId: 'telegram', capabilityId, input: {}, requestedBy: 'soak', confirmed: true, createdAt: new Date(0).toISOString() });
    try {
      const started = await execute('telegram.bot.start');
      expect(started.ok, JSON.stringify({ summary: started.summary, error: started.error })).toBe(true);
      const heapBefore = process.memoryUsage().heapUsed;
      for (let id = 1; id <= total; id += 1) {
        api.updates.push({ update_id: id, message: { message_id: id, date: 0, chat: { id: 55, type: 'private' },
          from: { id: 9, is_bot: false, first_name: 'Owner' }, text: 'сообщение ' + id } });
        if (id % 10 === 0) await new Promise(resolve => setTimeout(resolve, 40));
      }
      const deadline = Date.now() + 110_000;
      while (Date.now() < deadline) {
        const answered = new Set(api.replies.map(reply => reply.text)).size;
        const state = JSON.parse(await readFile(statePath, 'utf8')) as { offset: number };
        if (answered >= total && state.offset === total + 1) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const state = JSON.parse(await readFile(statePath, 'utf8')) as { offset: number };
      const answeredTexts = api.replies.filter(reply => reply.chatId === 55).map(reply => reply.text);
      const missing = Array.from({ length: total }, (_, index) => 'сообщение ' + (index + 1))
        .filter(text => !answeredTexts.some(answer => answer.includes(text)));
      const duplicatedDispatch = [...dispatched.entries()].filter(([, count]) => count > 1);
      const moduleState = module as unknown as { lastError: string; running: boolean };
      const progress = { counters: api.counters, faults: api.faults, replies: api.replies.length, dispatched: dispatched.size,
        offset: state.offset, lastError: moduleState.lastError, running: moduleState.running,
        notDispatched: Array.from({ length: total }, (_, index) => 'сообщение ' + (index + 1)).filter(text => !dispatched.has(text)),
        repeatedReplies: Object.entries(api.replies.reduce<Record<string, number>>((all, reply) => {
          all[reply.text] = (all[reply.text] ?? 0) + 1; return all; }, {})).filter(([, count]) => count > 1).slice(0, 8) };
      expect(progress.dispatched, JSON.stringify(progress)).toBe(total);
      // Every fault class actually happened during the run.
      expect(api.faults.updates502).toBeGreaterThan(0);
      expect(api.faults.updatesDropped).toBeGreaterThan(0);
      expect(api.faults.send429).toBeGreaterThan(0);
      expect({ missing: missing.slice(0, 10), missingCount: missing.length }).toEqual({ missing: [], missingCount: 0 });
      expect(duplicatedDispatch).toEqual([]);
      expect(state.offset).toBe(total + 1);
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);
      const stoppedAt = Date.now();
      await execute('telegram.bot.stop');
      expect(Date.now() - stoppedAt).toBeLessThan(2_000);
    } finally {
      await kernel.stop();
      await api.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 150_000);

  it('keeps the default owner flood guard: 20 messages a minute, then one notice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-flood-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ offset: 0, pairings: [{ chatId: 55, userId: 9, pairedAt: new Date(0).toISOString() }],
      reminders: [], pendingTaskDeliveries: [], remotePaused: false, pairingAttempts: {} }), 'utf8');
    const api = await startFaultyBotApi({ failUpdatesEvery: 1_000_000, dropUpdatesEvery: 1_000_000, throttleSendEvery: 1_000_000 });
    const module = new TelegramModule({ projectRoot: root, apiBase: api.apiBase, token: 'flood-token', autoStart: false });
    const dispatched: string[] = [];
    module.setIntentDispatcher(async request => {
      dispatched.push(request.text);
      return { intent: { id: 'intent_flood', text: request.text, source: 'telegram', createdAt: new Date(0).toISOString() },
        route: null, plan: null, execution: { ok: true, summary: 'ok' }, summary: 'ok' };
    });
    const kernel = new MonarchKernel();
    kernel.registerModule(createDeterministicSecurityModule());
    kernel.registerModule(module);
    await kernel.start();
    try {
      const started = await kernel.execute({ id: 'exec_flood_start', intentId: 'intent_flood', moduleId: 'telegram',
        capabilityId: 'telegram.bot.start', input: {}, requestedBy: 'flood', confirmed: true, createdAt: new Date(0).toISOString() });
      expect(started.ok).toBe(true);
      for (let id = 1; id <= 25; id += 1) api.updates.push({ update_id: id, message: { message_id: id, date: 0,
        chat: { id: 55, type: 'private' }, from: { id: 9, is_bot: false, first_name: 'Owner' }, text: 'поток ' + id } });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && JSON.parse(await readFile(statePath, 'utf8')).offset !== 26) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(dispatched).toEqual(Array.from({ length: 20 }, (_, index) => 'поток ' + (index + 1)));
      expect(api.replies.filter(reply => reply.text.includes('Слишком много запросов'))).toHaveLength(1);
    } finally {
      await kernel.stop();
      await api.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
