import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeReminderTime, parseReminderCommand } from '../../src/modules/reminders/reminder-time';
import { MonarchReminderStore, nextOccurrence } from '../../src/modules/reminders/reminder-store';
// @ts-expect-error The Desktop host module is plain ESM without types.
import { createReminderDelivery } from '../../desktop/electron/reminder-delivery.mjs';

// Tuesday 13 October 2026, 12:00 local time.
const NOW = new Date(2026, 9, 13, 12, 0, 0);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function create(text: string) {
  const parsed = parseReminderCommand(text, NOW);
  if (parsed?.kind !== 'create') throw new Error(`not a reminder: ${text} → ${JSON.stringify(parsed)}`);
  return parsed;
}

describe('parseReminderCommand', () => {
  it('reads relative times', () => {
    expect(create('напомни через 20 минут проверить духовку')).toMatchObject({
      text: 'Проверить духовку',
      dueAt: new Date(NOW.getTime() + 20 * 60_000),
    });
    expect(create('Напомни мне через час позвонить маме').dueAt).toEqual(new Date(NOW.getTime() + 3_600_000));
    expect(create('напомни через полчаса выключить чайник').dueAt).toEqual(new Date(NOW.getTime() + 1_800_000));
    expect(create('напомни через 2 дня оплатить интернет').dueAt).toEqual(new Date(NOW.getTime() + 2 * 86_400_000));
    expect(create('remind me in 10 minutes to stretch')).toMatchObject({ text: 'Stretch' });
  });

  it('reads days and clock times in local time', () => {
    expect(create('напомни завтра в 9:30 позвонить в банк').dueAt).toEqual(new Date(2026, 9, 14, 9, 30));
    expect(create('напомни в 18:00 забрать посылку').dueAt).toEqual(new Date(2026, 9, 13, 18, 0));
    // A time that already passed today means tomorrow.
    expect(create('напомни в 8 утра сделать зарядку').dueAt).toEqual(new Date(2026, 9, 14, 8, 0));
    expect(create('напомни в 7 вечера полить цветы').dueAt).toEqual(new Date(2026, 9, 13, 19, 0));
    expect(create('напомни в пятницу купить подарок').dueAt).toEqual(new Date(2026, 9, 16, 9, 0));
    expect(create('напомни 20 октября в 10:00 продлить страховку').dueAt).toEqual(new Date(2026, 9, 20, 10, 0));
    expect(create('напомни завтра вечером позвонить Пете').dueAt).toEqual(new Date(2026, 9, 14, 19, 0));
  });

  it('keeps the subject of the reminder and reads repetition', () => {
    const daily = create('напомни каждый день в 9:00 о том, что нужно выпить витамины');
    expect(daily).toMatchObject({ text: 'Нужно выпить витамины', recurrence: 'daily' });
    expect(create('напомни, чтобы я проверил почту через 5 минут').text).toBe('Я проверил почту');
  });

  it('asks for a time when there is none and ignores ordinary sentences', () => {
    expect(parseReminderCommand('напомни купить молоко', NOW)).toEqual({ kind: 'needs-time', text: 'Купить молоко' });
    expect(parseReminderCommand('какие у меня напоминания?', NOW)).toEqual({ kind: 'list' });
    expect(parseReminderCommand('что такое напоминание в календаре', NOW)).toBeNull();
    expect(parseReminderCommand('ты мне напомнил про отчёт, спасибо', NOW)).toBeNull();
  });

  it('describes the time the way people say it', () => {
    expect(describeReminderTime(new Date(2026, 9, 13, 15, 30), NOW)).toBe('сегодня в 15:30');
    expect(describeReminderTime(new Date(2026, 9, 14, 9, 0), NOW)).toBe('завтра в 09:00');
  });
});

describe('MonarchReminderStore', () => {
  it('stores reminders, reports the due ones and moves repeating ones on', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-reminders-'));
    roots.push(root);
    let now = NOW;
    const store = new MonarchReminderStore(root, { now: () => now });
    const once = await store.create({ text: 'Позвонить маме', dueAt: new Date(NOW.getTime() + 60_000) });
    const daily = await store.create({ text: 'Витамины', dueAt: new Date(NOW.getTime() + 120_000), recurrence: 'daily' });
    expect(await store.due()).toEqual([]);

    now = new Date(NOW.getTime() + 5 * 60_000);
    expect((await store.due()).map((entry) => entry.id)).toEqual([once.id, daily.id]);
    expect((await store.markDelivered(once.id))?.status).toBe('delivered');
    const moved = await store.markDelivered(daily.id);
    expect(moved?.status).toBe('scheduled');
    expect(moved?.dueAt).toBe(new Date(NOW.getTime() + 120_000 + 86_400_000).toISOString());
    expect(await store.due()).toEqual([]);

    expect((await store.snooze(once.id, 10))?.status).toBe('scheduled');
    expect((await store.cancel(daily.id))?.status).toBe('cancelled');
    expect(await store.markDelivered('rem_00000000000000000000000000000000')).toBeNull();
  });

  it('computes the next occurrence after a long pause', () => {
    const next = nextOccurrence(new Date(2026, 9, 1, 9, 0), 'daily', NOW);
    expect(next).toEqual(new Date(2026, 9, 14, 9, 0));
  });
});

describe('Desktop reminder delivery', () => {
  it('marks each due reminder delivered once, then notifies', async () => {
    const id = `rem_${'a'.repeat(32)}`;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL, init?: RequestInit) => {
      calls.push(`${init?.method || 'GET'} ${url.pathname}`);
      if (url.pathname === '/api/reminders/due') {
        return new Response(JSON.stringify({ reminders: calls.length === 1 ? [{ id, text: 'Чайник' }] : [] }));
      }
      return new Response(JSON.stringify({ reminder: { id, text: 'Чайник', status: 'delivered' } }));
    });
    const notify = vi.fn();
    const delivery = createReminderDelivery({
      fetchImpl,
      getRuntimeUrl: () => 'http://127.0.0.1:4317',
      attestationToken: 'token',
      notify,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    delivery.start();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['GET /api/reminders/due', `POST /api/reminders/${id}/delivered`]);
    expect(fetchImpl.mock.calls[0]![1]!.headers).toMatchObject({ 'X-Monarch-Desktop-Attestation': 'token' });
    delivery.stop();
  });
});
