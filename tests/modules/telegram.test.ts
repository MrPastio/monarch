import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { MonarchKernel } from '../../src/core';
import { DiagnosticsModule } from '../../src/modules/diagnostics';
import { readTelegramApiCapabilityInput } from '../../src/modules/telegram/api-guard';
import { TelegramModule } from '../../src/modules/telegram';

describe('Telegram Module', () => {
  it('bounds transient per-user rate-limit state', () => {
    const module = new TelegramModule({ autoStart: false });
    const internals = module as unknown as {
      consumeRateLimit(userId: number): boolean;
      shouldSendRateLimitNotice(userId: number): boolean;
      rateWindows: Map<number, number[]>;
      rateLimitNotices: Map<number, number>;
    };

    for (let userId = 1; userId <= 3_000; userId += 1) {
      expect(internals.consumeRateLimit(userId)).toBe(true);
      expect(internals.shouldSendRateLimitNotice(userId)).toBe(true);
    }

    expect(internals.rateWindows.size).toBeLessThanOrEqual(2_048);
    expect(internals.rateLimitNotices.size).toBeLessThanOrEqual(2_048);
  });

  it('does not steal workspace routes when telegram appears only inside a path', async () => {
    const module = new TelegramModule({ autoStart: false });
    const decision = await module.handleIntent({
      id: 'intent_path',
      source: 'smoke',
      text: 'Содержание папки по этому пути "E:\\Monarch\\src\\modules\\telegram"',
      createdAt: new Date(0).toISOString(),
    });

    expect(decision).toBeNull();
  });

  it('keeps explicit Telegram status above generic diagnostics candidates', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DiagnosticsModule());
    kernel.registerModule(new TelegramModule({ autoStart: false }));
    await kernel.start();

    try {
      const result = await kernel.submitIntent('покажи статус Telegram-бота', 'smoke');
      expect(result.route?.capabilityId).toBe('telegram.status');
      expect(result.execution?.ok).toBe(true);
    } finally {
      await kernel.stop();
    }
  });

  it('registers a safe local bridge, exposes pairing, and persists reminders', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 42,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
    }), 'utf8');

    const module = new TelegramModule({ projectRoot: root, autoStart: false });
    module.setIntentDispatcher(async () => ({
      intent: { id: 'intent_telegram_test', text: 'test', source: 'telegram', createdAt: new Date(0).toISOString() },
      route: null,
      plan: null,
      execution: null,
      summary: 'ok',
    }));
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const routed = await kernel.submitIntent('покажи статус Telegram-бота', 'smoke');
      expect(routed.route?.capabilityId).toBe('telegram.status');
      expect(routed.execution?.ok).toBe(true);
      const status = routed.execution?.output as Record<string, unknown>;
      expect(status.configured).toBe(false);
      expect(status.dispatcherReady).toBe(true);
      expect(String(status.pairingCode)).toMatch(/^\d{6}$/);

      const rotated = await kernel.execute({
        id: 'exec_telegram_pairing_rotate',
        intentId: '',
        moduleId: 'telegram',
        capabilityId: 'telegram.pairing.rotate',
        input: {},
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });
      expect(rotated.ok).toBe(true);
      expect((rotated.output as { pairingCode: string }).pairingCode).toMatch(/^\d{6}$/);
      expect((rotated.output as { pairingCode: string }).pairingCode).not.toBe(status.pairingCode);

      const created = await kernel.execute({
        id: 'exec_telegram_reminder_create',
        intentId: 'intent_telegram_reminder_create',
        moduleId: 'telegram',
        capabilityId: 'telegram.reminder.create',
        input: { chatId: 1001, text: 'Проверить Monarch', dueAt: '2030-01-01T12:00:00Z' },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      expect(created.ok).toBe(true);

      const listed = await kernel.execute({
        id: 'exec_telegram_reminder_list',
        intentId: 'intent_telegram_reminder_list',
        moduleId: 'telegram',
        capabilityId: 'telegram.reminder.list',
        input: { chatId: 1001 },
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });
      expect((listed.output as { reminders: unknown[] }).reminders).toHaveLength(1);
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects oversized Telegram reminder capability text before persisting', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-reminder-capability-bounds-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const module = new TelegramModule({ projectRoot: root, autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_telegram_reminder_text_bounds',
        intentId: 'intent_telegram_reminder_text_bounds',
        moduleId: 'telegram',
        capabilityId: 'telegram.reminder.create',
        input: { chatId: 1001, text: 'x'.repeat(2001), dueAt: '2030-01-01T12:00:00Z' },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });

      expect(result).toMatchObject({ ok: false, error: 'telegram-reminder-input-invalid' });
      expect(String(result.summary)).toContain('maximum 2000');
      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { reminders: unknown[] };
      expect(persisted.reminders).toEqual([]);
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects oversized Telegram reminder commands before persisting', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-reminder-command-bounds-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_reminder_command_bounds_start',
        intentId: 'intent_reminder_command_bounds_start',
        moduleId: 'telegram',
        capabilityId: 'telegram.bot.start',
        input: {},
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      mock.sentMessages.length = 0;
      mock.updates.push({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 1001, type: 'private' },
          from: { id: 2002, username: 'tester' },
          text: `/remind 10m ${'x'.repeat(2001)}`,
        },
      });

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('максимум 2000')), 2_000);
      mock.updates.push({
        update_id: 2,
        message: {
          message_id: 2,
          chat: { id: 1001, type: 'private' },
          from: { id: 2002, username: 'tester' },
          text: `/remind ${'9'.repeat(80)}d impossible date`,
        },
      });

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('Формат: /remind')), 2_000);
      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { reminders: unknown[] };
      expect(persisted.reminders).toEqual([]);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops orphaned and malformed reminders before exposing Telegram state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-reminder-state-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [
        {
          id: 'keep1',
          chatId: 1001,
          text: 'valid paired reminder',
          dueAt: '2030-01-01T12:00:00Z',
          createdAt: new Date(0).toISOString(),
        },
        {
          id: 'orphan1',
          chatId: 9999,
          text: 'must not be delivered to an unpaired chat',
          dueAt: '2030-01-01T12:00:00Z',
          createdAt: new Date(0).toISOString(),
        },
        {
          id: '',
          chatId: 1001,
          text: 'blank id',
          dueAt: '2030-01-01T12:00:00Z',
          createdAt: new Date(0).toISOString(),
        },
        {
          id: 'blank-text',
          chatId: 1001,
          text: '   ',
          dueAt: '2030-01-01T12:00:00Z',
          createdAt: new Date(0).toISOString(),
        },
        {
          id: 'bad-due-at',
          chatId: 1001,
          text: 'bad dueAt',
          dueAt: 'not-a-date',
          createdAt: new Date(0).toISOString(),
        },
      ],
      remotePaused: false,
    }), 'utf8');

    const module = new TelegramModule({ projectRoot: root, autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const status = await kernel.execute({
        id: 'exec_telegram_status_sanitized_reminders',
        intentId: 'intent_telegram_status_sanitized_reminders',
        moduleId: 'telegram',
        capabilityId: 'telegram.status',
        input: {},
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });
      expect(status.ok).toBe(true);
      expect((status.output as { reminders: number }).reminders).toBe(1);

      const listed = await kernel.execute({
        id: 'exec_telegram_list_sanitized_reminders',
        intentId: 'intent_telegram_list_sanitized_reminders',
        moduleId: 'telegram',
        capabilityId: 'telegram.reminder.list',
        input: {},
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });
      expect((listed.output as { reminders: Array<{ id: string; chatId: number }> }).reminders).toEqual([
        expect.objectContaining({ id: 'keep1', chatId: 1001 }),
      ]);
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not cancel multiple Telegram reminders when ids collide', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-reminder-cancel-scope-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [
        { chatId: 1001, userId: 2002, username: 'one', pairedAt: new Date(0).toISOString() },
        { chatId: 1002, userId: 2003, username: 'two', pairedAt: new Date(0).toISOString() },
      ],
      reminders: [
        { id: 'sharedid', chatId: 1001, text: 'first chat', dueAt: '2030-01-01T12:00:00Z', createdAt: new Date(0).toISOString() },
        { id: 'sharedid', chatId: 1002, text: 'second chat', dueAt: '2030-01-02T12:00:00Z', createdAt: new Date(1).toISOString() },
      ],
      remotePaused: false,
    }), 'utf8');

    const module = new TelegramModule({ projectRoot: root, autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const ambiguous = await kernel.execute({
        id: 'exec_telegram_cancel_ambiguous_reminder',
        intentId: 'intent_telegram_cancel_ambiguous_reminder',
        moduleId: 'telegram',
        capabilityId: 'telegram.reminder.cancel',
        input: { id: 'sharedid' },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      expect(ambiguous).toMatchObject({ ok: false, error: 'telegram-reminder-ambiguous' });

      const afterAmbiguous = await kernel.execute({
        id: 'exec_telegram_list_after_ambiguous_cancel',
        intentId: 'intent_telegram_list_after_ambiguous_cancel',
        moduleId: 'telegram',
        capabilityId: 'telegram.reminder.list',
        input: {},
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });
      expect((afterAmbiguous.output as { reminders: unknown[] }).reminders).toHaveLength(2);

      const scoped = await kernel.execute({
        id: 'exec_telegram_cancel_scoped_reminder',
        intentId: 'intent_telegram_cancel_scoped_reminder',
        moduleId: 'telegram',
        capabilityId: 'telegram.reminder.cancel',
        input: { id: 'sharedid', chatId: 1001 },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      expect(scoped).toMatchObject({ ok: true, output: { id: 'sharedid', chatId: 1001 } });

      const listed = await kernel.execute({
        id: 'exec_telegram_list_after_scoped_cancel',
        intentId: 'intent_telegram_list_after_scoped_cancel',
        moduleId: 'telegram',
        capabilityId: 'telegram.reminder.list',
        input: {},
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });
      expect((listed.output as { reminders: Array<{ id: string; chatId: number }> }).reminders).toEqual([
        expect.objectContaining({ id: 'sharedid', chatId: 1002 }),
      ]);
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps future reminders with colliding ids after delivering one due reminder', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-reminder-delivery-scope-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [
        { chatId: 1001, userId: 2002, username: 'one', pairedAt: new Date(0).toISOString() },
        { chatId: 1002, userId: 2003, username: 'two', pairedAt: new Date(0).toISOString() },
      ],
      reminders: [
        { id: 'sharedid', chatId: 1001, text: 'due reminder', dueAt: new Date(Date.now() - 5_000).toISOString(), createdAt: new Date(0).toISOString() },
        { id: 'sharedid', chatId: 1002, text: 'future reminder', dueAt: '2030-01-02T12:00:00Z', createdAt: new Date(1).toISOString() },
      ],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_telegram_delivery_scope_start',
        intentId: 'intent_telegram_delivery_scope_start',
        moduleId: 'telegram',
        capabilityId: 'telegram.bot.start',
        input: {},
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });

      await waitUntil(async () => {
        if (!mock.sentMessages.some((message) => String(message.text).includes('due reminder'))) return false;
        const current = JSON.parse(await readFile(statePath, 'utf8')) as {
          reminders: Array<{ id: string; chatId: number; text: string }>;
        };
        return current.reminders.length === 1 && current.reminders[0]?.chatId === 1002;
      }, 3_000);
      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
        reminders: Array<{ id: string; chatId: number; text: string }>;
      };
      expect(persisted.reminders).toEqual([
        expect.objectContaining({ id: 'sharedid', chatId: 1002, text: 'future reminder' }),
      ]);
      expect(mock.sentMessages.some((message) => String(message.text).includes('future reminder'))).toBe(false);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('reacts to externally persisted reminders without one-second disk polling', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-reminder-watch-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    const baseState = {
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [] as Array<Record<string, unknown>>,
      remotePaused: false,
      pairingAttempts: {},
    };
    await writeFile(statePath, JSON.stringify(baseState), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_telegram_watch_start', intentId: 'intent_telegram_watch_start', moduleId: 'telegram', capabilityId: 'telegram.bot.start',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      baseState.reminders.push({
        id: 'external', chatId: 1001, text: 'external reminder',
        dueAt: new Date(Date.now() - 100).toISOString(), createdAt: new Date().toISOString(),
      });
      await writeFile(statePath, JSON.stringify(baseState), 'utf8');

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('external reminder')), 2_000);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('uses one polling owner and accepts a bare pairing code before /help', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-shared-'));
    const mock = await startTelegramMock();
    const ownerModule = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const standbyModule = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const ownerKernel = new MonarchKernel();
    const standbyKernel = new MonarchKernel();
    ownerKernel.registerModule(ownerModule);
    standbyKernel.registerModule(standbyModule);
    await ownerKernel.start();
    await standbyKernel.start();

    try {
      const owner = await ownerKernel.execute({
        id: 'exec_owner_start', intentId: 'intent_owner_start', moduleId: 'telegram', capabilityId: 'telegram.bot.start',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      const standby = await standbyKernel.execute({
        id: 'exec_standby_start', intentId: 'intent_standby_start', moduleId: 'telegram', capabilityId: 'telegram.bot.start',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      expect((owner.output as { pollingMode: string }).pollingMode).toBe('owner');
      expect((standby.output as { pollingMode: string }).pollingMode).toBe('standby');

      const status = await standbyKernel.execute({
        id: 'exec_pairing_status', intentId: 'intent_pairing_status', moduleId: 'telegram', capabilityId: 'telegram.pairing.rotate',
        input: {}, requestedBy: 'smoke', createdAt: new Date(0).toISOString(),
      });
      const code = String((status.output as { pairingCode: string }).pairingCode);
      mock.updates.push(
        { update_id: 1, message: { message_id: 1, chat: { id: 700, type: 'private' }, from: { id: 900, username: 'tester' }, text: code } },
        { update_id: 2, message: { message_id: 2, chat: { id: 700, type: 'private' }, from: { id: 900, username: 'tester' }, text: '/help' } },
        { update_id: 3, edited_message: { message_id: 2, chat: { id: 700, type: 'private' }, from: { id: 900, username: 'tester' }, text: '/help' } },
        { update_id: 4, message: { message_id: 3, chat: { id: 700, type: 'private' }, from: { id: 1, is_bot: true, username: 'mock_bot' }, text: 'Готово.' } },
      );

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('Здесь можно общаться')), 2_000);
      const texts = mock.sentMessages.map((message) => String(message.text || ''));
      expect(texts.some((text) => text.includes('Готово — связал этот чат'))).toBe(true);
      expect(texts.some((text) => text.includes('Здесь можно общаться'))).toBe(true);
      expect(texts.some((text) => text.includes('Этот чат пока не связан'))).toBe(false);
      expect(texts.filter((text) => text.includes('Здесь можно общаться'))).toHaveLength(1);

      const persisted = JSON.parse(await readFile(path.join(root, 'data', 'local', 'telegram-state.json'), 'utf8')) as { pairings: unknown[] };
      expect(persisted.pairings).toHaveLength(1);
    } finally {
      await ownerKernel.stop();
      await standbyKernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('routes direct Telegram capability questions through dispatcher to a local capability', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-help-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    let dispatches = 0;
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    module.setIntentDispatcher(async (request) => {
      dispatches += 1;
      return kernel.submitIntent(request.text, 'telegram', request.context);
    });
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_help_start', intentId: 'intent_help_start', moduleId: 'telegram', capabilityId: 'telegram.bot.start',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      mock.updates.push({
        update_id: 1,
        message: { message_id: 1, chat: { id: 1001, type: 'private' }, from: { id: 2002, username: 'tester' }, text: 'Что ты умеешь через тг бот?' },
      });

      await waitUntil(() => mock.apiCalls.some((call) => call.method === 'editMessageText' && String(call.text).includes('Через Telegram я могу')), 2_000);
      expect(dispatches).toBe(1);
      expect(mock.apiCalls.some((call) => String(call.text).includes('Codex Security'))).toBe(true);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects oversized Telegram table commands before sending rich messages', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-table-bounds-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_table_bounds_start',
        intentId: 'intent_table_bounds_start',
        moduleId: 'telegram',
        capabilityId: 'telegram.bot.start',
        input: {},
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      mock.apiCalls.length = 0;
      mock.sentMessages.length = 0;
      mock.updates.push({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 1001, type: 'private' },
          from: { id: 2002, username: 'tester' },
          text: '/table Wide | c1,c2,c3,c4,c5,c6,c7,c8,c9 | v1,v2,v3,v4,v5,v6,v7,v8,v9',
        },
      });

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('Таблица слишком широкая')), 2_000);
      expect(mock.apiCalls.some((call) => call.method === 'sendRichMessage')).toBe(false);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects oversized Telegram poll commands before sending polls', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-poll-command-bounds-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_poll_command_bounds_start',
        intentId: 'intent_poll_command_bounds_start',
        moduleId: 'telegram',
        capabilityId: 'telegram.bot.start',
        input: {},
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      mock.apiCalls.length = 0;
      mock.sentMessages.length = 0;
      mock.updates.push({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 1001, type: 'private' },
          from: { id: 2002, username: 'tester' },
          text: `/poll Q | ${Array.from({ length: 13 }, (_, index) => `option ${index + 1}`).join(' | ')}`,
        },
      });

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('максимум 12')), 2_000);
      expect(mock.apiCalls.some((call) => call.method === 'sendPoll')).toBe(false);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects oversized Telegram poll capability input before calling Bot API', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-poll-capability-bounds-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_poll_capability_bounds',
        intentId: 'intent_poll_capability_bounds',
        moduleId: 'telegram',
        capabilityId: 'telegram.poll.send',
        input: {
          chatId: 1001,
          question: 'Q',
          options: Array.from({ length: 13 }, (_, index) => `option ${index + 1}`),
        },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });

      expect(result).toMatchObject({ ok: false, error: 'telegram-poll-input-invalid' });
      expect(String(result.summary)).toContain('maximum 12');
      expect(mock.apiCalls.some((call) => call.method === 'sendPoll')).toBe(false);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('provides a local kill switch, revocation, and paired-chat Bot API boundaries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-control-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, pairedAt: new Date(0).toISOString() }],
      reminders: [{
        id: 'reminder1',
        chatId: 1001,
        text: 'test',
        dueAt: '2030-01-01T12:00:00Z',
        createdAt: new Date(0).toISOString(),
      }],
    }), 'utf8');

    const module = new TelegramModule({ projectRoot: root, autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const paused = await kernel.execute({
        id: 'exec_telegram_pause', intentId: 'intent_telegram_pause', moduleId: 'telegram', capabilityId: 'telegram.remote.pause',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      expect(paused.ok).toBe(true);
      expect((paused.output as { remotePaused: boolean }).remotePaused).toBe(true);
      expect((paused.output as { pairingCode?: string }).pairingCode).toBeUndefined();

      const unpairedApi = await kernel.execute({
        id: 'exec_telegram_api_guard', intentId: 'intent_telegram_api_guard', moduleId: 'telegram', capabilityId: 'telegram.api.call',
        input: { method: 'sendMessage', parameters: { chat_id: 9999, text: 'nope' } },
        requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      expect(unpairedApi).toMatchObject({ ok: false, error: 'telegram-api-unpaired-chat' });

      const reservedApi = await kernel.execute({
        id: 'exec_telegram_api_reserved', intentId: 'intent_telegram_api_reserved', moduleId: 'telegram', capabilityId: 'telegram.api.call',
        input: { method: 'getUpdates' },
        requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      expect(reservedApi).toMatchObject({ ok: false, error: 'telegram-api-method-reserved' });

      const badParameters = readTelegramApiCapabilityInput({ method: 'getMe', parameters: [] });
      expect(badParameters).toMatchObject({ ok: false, error: 'telegram-api-parameters-invalid' });

      const oversizedParameters = readTelegramApiCapabilityInput({
        method: 'sendMessage',
        parameters: { chat_id: 1001, text: 'x'.repeat(12_050) },
      });
      expect(oversizedParameters).toMatchObject({ ok: false, error: 'telegram-api-parameters-too-large' });

      const revoked = await kernel.execute({
        id: 'exec_telegram_revoke', intentId: 'intent_telegram_revoke', moduleId: 'telegram', capabilityId: 'telegram.pairing.revoke',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      expect(revoked.ok).toBe(true);
      expect((revoked.output as { pairedChats: unknown[] }).pairedChats).toEqual([]);
      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { pairings: unknown[]; reminders: unknown[]; remotePaused: boolean };
      expect(persisted).toMatchObject({ pairings: [], reminders: [], remotePaused: true });

      const resumed = await kernel.execute({
        id: 'exec_telegram_resume', intentId: 'intent_telegram_resume', moduleId: 'telegram', capabilityId: 'telegram.remote.resume',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      expect((resumed.output as { remotePaused: boolean }).remotePaused).toBe(false);
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns friendly Telegram /api input errors without invoking the requested method', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-api-input-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_api_input_start', intentId: 'intent_api_input_start', moduleId: 'telegram', capabilityId: 'telegram.bot.start',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      mock.apiCalls.length = 0;
      mock.sentMessages.length = 0;
      mock.updates.push({
        update_id: 1,
        message: { message_id: 1, chat: { id: 1001, type: 'private' }, from: { id: 2002, username: 'tester' }, text: '/api sendMessage {"text":' },
      });

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('Не понял /api')), 2_000);
      const response = String(mock.sentMessages.find((message) => String(message.text).includes('Не понял /api'))?.text || '');
      expect(response).toContain('параметры должны быть валидным JSON-объектом');
      expect(response).toContain('Формат: /api METHOD');
      expect(response).not.toContain('Unexpected');
      expect(mock.apiCalls.some((call) => String(call.text).includes('изменит состояние Telegram'))).toBe(false);

      mock.apiCalls.length = 0;
      mock.sentMessages.length = 0;
      mock.updates.push({
        update_id: 2,
        message: {
          message_id: 2,
          chat: { id: 1001, type: 'private' },
          from: { id: 2002, username: 'tester' },
          text: '/api sendMessage {"text":"nested","reply_parameters":{"chat_id":9999,"message_id":1}}',
        },
      });

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('chat_id')), 2_000);
      expect(mock.sentMessages.some((message) => String(message.text).includes('только для текущего chat_id'))).toBe(true);
      expect(mock.apiCalls.some((call) => String(call.text).includes('изменит состояние Telegram'))).toBe(false);

      mock.apiCalls.length = 0;
      mock.sentMessages.length = 0;
      mock.updates.push({
        update_id: 3,
        message: {
          message_id: 3,
          chat: { id: 1001, type: 'private' },
          from: { id: 2002, username: 'tester' },
          text: `/api sendMessage {"text":"${'x'.repeat(12_050)}"}`,
        },
      });

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('параметры слишком большие')), 2_000);
      expect(mock.apiCalls.some((call) => String(call.text).includes('изменит состояние Telegram'))).toBe(false);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('rejects oversized generic Bot API capability parameters before calling Bot API', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-api-parameter-bounds-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_telegram_api_oversized_parameters',
        intentId: 'intent_telegram_api_oversized_parameters',
        moduleId: 'telegram',
        capabilityId: 'telegram.api.call',
        input: { method: 'sendMessage', parameters: { chat_id: 1001, text: 'x'.repeat(12_050) } },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });

      expect(result).toMatchObject({ ok: false, error: 'telegram-api-parameters-too-large' });
      expect(mock.apiCalls.some((call) => call.method === 'sendMessage')).toBe(false);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('limits active Telegram API confirmations per chat and user', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-api-pending-cap-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const internals = module as unknown as { pendingConfirmations: Map<string, unknown> };
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_api_pending_cap_start',
        intentId: 'intent_api_pending_cap_start',
        moduleId: 'telegram',
        capabilityId: 'telegram.bot.start',
        input: {},
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      mock.sentMessages.length = 0;
      mock.apiCalls.length = 0;
      for (let index = 1; index <= 9; index += 1) {
        mock.updates.push({
          update_id: index,
          message: {
            message_id: index,
            chat: { id: 1001, type: 'private' },
            from: { id: 2002, username: 'tester' },
            text: `/api sendMessage {"text":"pending ${index}"}`,
          },
        });
      }

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('Слишком много ожидающих подтверждений')), 3_000);
      const prompts = mock.sentMessages.filter((message) => String(message.text).includes('Bot API sendMessage изменит состояние Telegram'));
      expect(prompts).toHaveLength(8);
      expect(internals.pendingConfirmations.size).toBe(8);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects nested unpaired Bot API chat references', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-api-nested-chat-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_telegram_api_nested_chat_guard',
        intentId: 'intent_telegram_api_nested_chat_guard',
        moduleId: 'telegram',
        capabilityId: 'telegram.api.call',
        input: {
          method: 'sendMessage',
          parameters: {
            chat_id: 1001,
            text: 'nested reference',
            reply_parameters: { chat_id: 9999, message_id: 1 },
          },
        },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });

      expect(result).toMatchObject({ ok: false, error: 'telegram-api-unpaired-chat' });
      expect(mock.apiCalls.some((call) => call.method === 'sendMessage' && call.text === 'nested reference')).toBe(false);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('defaults generic Bot API capability chat methods to the only paired chat', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-api-default-chat-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_telegram_api_default_chat',
        intentId: 'intent_telegram_api_default_chat',
        moduleId: 'telegram',
        capabilityId: 'telegram.api.call',
        input: { method: 'sendMessage', parameters: { text: 'hello from generic api' } },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });

      expect(result.ok).toBe(true);
      const sendMessage = mock.apiCalls.find((call) => call.method === 'sendMessage');
      expect(sendMessage).toMatchObject({ chat_id: 1001, text: 'hello from generic api' });

      mock.apiCalls.length = 0;
      const readResult = await kernel.execute({
        id: 'exec_telegram_api_default_chat_read',
        intentId: 'intent_telegram_api_default_chat_read',
        moduleId: 'telegram',
        capabilityId: 'telegram.api.call',
        input: { method: 'getChat', parameters: {} },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });

      expect(readResult.ok).toBe(true);
      const getChat = mock.apiCalls.find((call) => call.method === 'getChat');
      expect(getChat).toMatchObject({ chat_id: 1001 });
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the Telegram state file cannot be parsed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-corrupt-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, '{ this is not valid json', 'utf8');

    const module = new TelegramModule({ projectRoot: root, autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const status = await kernel.execute({
        id: 'exec_telegram_corrupt_status',
        intentId: 'intent_telegram_corrupt_status',
        moduleId: 'telegram',
        capabilityId: 'telegram.status',
        input: {},
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });
      const output = status.output as Record<string, unknown>;
      expect(status.ok).toBe(true);
      expect(output.remotePaused).toBe(true);
      expect(output.pairedChats).toEqual([]);
      expect(output.pairingCode).toBe('');
      expect(String(output.lastError)).toContain('remote access paused');
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects remote custom Bot API bases unless explicitly allowed', () => {
    const previous = process.env.MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE;
    try {
      delete process.env.MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE;
      expect(() => new TelegramModule({ apiBase: 'https://example.invalid' })).toThrow(/official Telegram endpoint/);
      expect(() => new TelegramModule({ apiBase: 'http://127.0.0.1:8081' })).not.toThrow();
      expect(() => new TelegramModule({ apiBase: 'http://[::1]:8081' })).not.toThrow();
      process.env.MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE = '1';
      expect(() => new TelegramModule({ apiBase: 'https://example.invalid' })).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE;
      else process.env.MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE = previous;
    }
  });

  it('purges expired Telegram pending confirmations before exposing status', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-pending-expired-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const module = new TelegramModule({ projectRoot: root, autoStart: false });
    const internals = module as unknown as { pendingConfirmations: Map<string, Record<string, unknown>> };
    internals.pendingConfirmations.set('expired', {
      kind: 'api',
      id: 'expired',
      chatId: 1001,
      userId: 2002,
      method: 'sendMessage',
      parameters: {},
      expiresAt: Date.now() - 1,
    });
    internals.pendingConfirmations.set('active', {
      kind: 'api',
      id: 'active',
      chatId: 1001,
      userId: 2002,
      method: 'sendMessage',
      parameters: {},
      expiresAt: Date.now() + 60_000,
    });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const status = await kernel.execute({
        id: 'exec_telegram_pending_status',
        intentId: 'intent_telegram_pending_status',
        moduleId: 'telegram',
        capabilityId: 'telegram.status',
        input: {},
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });

      expect((status.output as { pendingConfirmations: number }).pendingConfirmations).toBe(1);
      expect(internals.pendingConfirmations.has('expired')).toBe(false);
      expect(internals.pendingConfirmations.has('active')).toBe(true);
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not honor pending Telegram confirmations after remote access is paused elsewhere', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-paused-callback-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
      reminders: [],
      remotePaused: false,
    }), 'utf8');
    const mock = await startTelegramMock();
    let confirmedDispatches = 0;
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    module.setIntentDispatcher(async (request) => {
      if (request.confirmed) confirmedDispatches += 1;
      return {
        intent: { id: 'intent_telegram_confirm', text: request.text, source: 'telegram', createdAt: new Date(0).toISOString() },
        route: null,
        plan: null,
        execution: {
          ok: false,
          summary: 'Confirmation required: test action',
          error: 'confirmation-required',
          metadata: { confirmation: { token: 'local-confirm-token' } },
        },
        confirmation: {
          token: 'local-confirm-token',
          mode: 'intent',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          target: {
            intentId: 'intent_telegram_confirm',
            moduleId: 'workspace',
            capabilityId: 'workspace.files.delete',
            risk: 'delete',
          },
        },
        summary: 'needs confirmation',
      };
    });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_paused_callback_start',
        intentId: 'intent_paused_callback_start',
        moduleId: 'telegram',
        capabilityId: 'telegram.bot.start',
        input: {},
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      mock.updates.push({
        update_id: 1,
        message: { message_id: 1, chat: { id: 1001, type: 'private' }, from: { id: 2002, username: 'tester' }, text: 'удали тестовый файл' },
      });
      await waitUntil(() => mock.apiCalls.some((call) => call.method === 'editMessageText' && String(call.text).includes('Разрешить это действие')), 2_000);
      const confirmationCall = mock.apiCalls.find((call) => call.method === 'editMessageText' && String(call.text).includes('Разрешить это действие'));
      const callbackData = (((confirmationCall?.reply_markup as any)?.inline_keyboard?.[0]?.[0]?.callback_data) || '') as string;
      expect(callbackData).toMatch(/^confirm:/);

      await writeFile(statePath, JSON.stringify({
        offset: 1,
        pairings: [{ chatId: 1001, userId: 2002, username: 'tester', pairedAt: new Date(0).toISOString() }],
        reminders: [],
        remotePaused: true,
      }), 'utf8');
      mock.updates.push({
        update_id: 2,
        callback_query: {
          id: 'callback-1',
          from: { id: 2002, username: 'tester' },
          data: callbackData,
          message: { message_id: 10, chat: { id: 1001, type: 'private' }, from: { id: 1, is_bot: true }, text: 'confirm' },
        },
      });

      await waitUntil(() => mock.apiCalls.some((call) => call.method === 'answerCallbackQuery' && String(call.text).includes('Удалённые задачи остановлены')), 2_000);
      expect(confirmedDispatches).toBe(0);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks pairing brute force before a later valid code can be tried', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-pairing-guard-'));
    const mock = await startTelegramMock();
    const module = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
    const kernel = new MonarchKernel();
    kernel.registerModule(module);
    await kernel.start();

    try {
      const started = await kernel.execute({
        id: 'exec_pair_guard_start', intentId: 'intent_pair_guard_start', moduleId: 'telegram', capabilityId: 'telegram.bot.start',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      const validCode = String((started.output as { pairingCode: string }).pairingCode);
      for (let index = 1; index <= 5; index += 1) {
        mock.updates.push({
          update_id: index,
          message: { message_id: index, chat: { id: 701, type: 'private' }, from: { id: 901, username: 'attacker' }, text: '000000' },
        });
      }
      mock.updates.push({
        update_id: 6,
        message: { message_id: 6, chat: { id: 701, type: 'private' }, from: { id: 901, username: 'attacker' }, text: validCode },
      });

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('Слишком много неверных попыток')), 2_000);
      const persisted = JSON.parse(await readFile(path.join(root, 'data', 'local', 'telegram-state.json'), 'utf8')) as { pairings: unknown[] };
      expect(persisted.pairings).toEqual([]);
      expect(mock.sentMessages.some((message) => String(message.text).includes('Готово — связал этот чат'))).toBe(false);
    } finally {
      await kernel.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists pairing brute force cooldown across Telegram module restarts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-telegram-pairing-persist-'));
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    const mock = await startTelegramMock();
    let firstKernel: MonarchKernel | null = null;
    let secondKernel: MonarchKernel | null = null;

    try {
      const firstModule = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
      firstKernel = new MonarchKernel();
      firstKernel.registerModule(firstModule);
      await firstKernel.start();
      const started = await firstKernel.execute({
        id: 'exec_pair_persist_start', intentId: 'intent_pair_persist_start', moduleId: 'telegram', capabilityId: 'telegram.bot.start',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      const validCode = String((started.output as { pairingCode: string }).pairingCode);
      for (let index = 1; index <= 5; index += 1) {
        mock.updates.push({
          update_id: index,
          message: { message_id: index, chat: { id: 702, type: 'private' }, from: { id: 902, username: 'attacker' }, text: '000000' },
        });
      }

      await waitUntil(() => mock.sentMessages.filter((message) => String(message.text).includes('Этот код не подошёл')).length >= 5, 2_000);
      const blockedState = JSON.parse(await readFile(statePath, 'utf8')) as {
        pairingAttempts?: Record<string, { blockedUntil?: number }>;
      };
      const persistedAttempt = Object.values(blockedState.pairingAttempts || {})[0];
      expect(persistedAttempt?.blockedUntil).toBeGreaterThan(Date.now());

      await firstKernel.stop();
      firstKernel = null;
      mock.sentMessages.length = 0;
      mock.apiCalls.length = 0;
      mock.updates.length = 0;

      const secondModule = new TelegramModule({ projectRoot: root, apiBase: mock.apiBase, token: 'test-token', autoStart: false });
      secondKernel = new MonarchKernel();
      secondKernel.registerModule(secondModule);
      await secondKernel.start();
      await secondKernel.execute({
        id: 'exec_pair_persist_restart', intentId: 'intent_pair_persist_restart', moduleId: 'telegram', capabilityId: 'telegram.bot.start',
        input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      mock.updates.push({
        update_id: 100,
        message: { message_id: 100, chat: { id: 702, type: 'private' }, from: { id: 902, username: 'attacker' }, text: validCode },
      });

      await waitUntil(() => mock.sentMessages.some((message) => String(message.text).includes('Слишком много неверных попыток')), 2_000);
      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { pairings: unknown[] };
      expect(persisted.pairings).toEqual([]);
      expect(mock.sentMessages.some((message) => String(message.text).includes('Готово — связал этот чат'))).toBe(false);
    } finally {
      await firstKernel?.stop();
      await secondKernel?.stop();
      await mock.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function startTelegramMock(): Promise<{
  apiBase: string;
  updates: Array<Record<string, unknown>>;
  sentMessages: Array<Record<string, unknown>>;
  apiCalls: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const updates: Array<Record<string, unknown>> = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  const apiCalls: Array<Record<string, unknown>> = [];
  let messageId = 100;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const method = String(request.url || '').split('/').pop() || '';
      const parameters = body ? JSON.parse(body) as Record<string, unknown> : {};
      apiCalls.push({ method, ...parameters });
      let result: unknown = true;
      if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'Mock', username: 'mock_bot' };
      if (method === 'getUpdates') result = updates.splice(0, updates.length);
      if (method === 'sendMessage') {
        sentMessages.push(parameters);
        result = { message_id: messageId++, chat: { id: parameters.chat_id, type: 'private' }, text: parameters.text };
      }
      if (method === 'sendPoll') {
        const options = parameters.options;
        const validPoll = typeof parameters.question === 'string'
          && parameters.question.length >= 1
          && parameters.question.length <= 300
          && Array.isArray(options)
          && options.length >= 1
          && options.length <= 12
          && options.every((option) => option
            && typeof option === 'object'
            && typeof (option as { text?: unknown }).text === 'string'
            && ((option as { text: string }).text.length >= 1)
            && ((option as { text: string }).text.length <= 100));
        if (!validPoll) {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ok: false, error_code: 400, description: 'invalid poll payload' }));
          return;
        }
        result = {
          message_id: messageId++,
          chat: { id: parameters.chat_id, type: 'private' },
          poll: { question: parameters.question, options },
        };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    apiBase: `http://127.0.0.1:${address.port}`,
    updates,
    sentMessages,
    apiCalls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Telegram mock response.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
