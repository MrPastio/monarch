import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DurableJsonFile } from '../../core/durable-json-file';
import type { MonarchReminderRecurrence } from './reminder-time';

export type MonarchReminderStatus = 'scheduled' | 'delivered' | 'done' | 'cancelled';

export interface MonarchReminderV1 {
  id: string;
  text: string;
  dueAt: string;
  recurrence: MonarchReminderRecurrence;
  status: MonarchReminderStatus;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  /** Chat the reminder was asked in, so the notification can open it. */
  conversationId: string | null;
}

interface ReminderDocumentV1 {
  schemaVersion: 1;
  reminders: MonarchReminderV1[];
}

const MAX_REMINDERS = 500;
const KEEP_FINISHED = 100;

/**
 * Reminders the person asked for. Personal data: sealed like memory and chats.
 * Delivery is pulled by the Desktop host (`due()` then `markDelivered()`), so a
 * reminder that came due while Monarch was closed is shown at the next start.
 */
export class MonarchReminderStore {
  private readonly file: DurableJsonFile<ReminderDocumentV1>;
  private readonly now: () => Date;

  constructor(stateRoot: string, options: { now?: () => Date } = {}) {
    this.now = options.now || (() => new Date());
    this.file = new DurableJsonFile<ReminderDocumentV1>(path.join(stateRoot, 'reminders', 'reminders.v1.json'), {
      createEmpty: () => ({ schemaVersion: 1, reminders: [] }),
      validate: validateReminderDocument,
      sensitive: { storeId: 'reminders' },
      onQuarantine: () => undefined,
    });
  }

  async list(): Promise<MonarchReminderV1[]> {
    const document = await this.file.read();
    return [...document.reminders].sort(compareReminders);
  }

  async create(input: {
    text: string;
    dueAt: Date;
    recurrence?: MonarchReminderRecurrence;
    conversationId?: string | null;
  }): Promise<MonarchReminderV1> {
    const text = String(input.text || '').replace(/\s+/gu, ' ').trim().slice(0, 500);
    if (!text) throw new Error('reminder-text-required');
    if (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.getTime())) throw new Error('reminder-time-invalid');
    const now = this.now().toISOString();
    const reminder: MonarchReminderV1 = {
      id: `rem_${randomUUID().replace(/-/gu, '')}`,
      text,
      dueAt: input.dueAt.toISOString(),
      recurrence: input.recurrence || 'none',
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
      conversationId: input.conversationId ? String(input.conversationId).slice(0, 200) : null,
    };
    return this.file.mutate((document) => {
      const active = document.reminders.filter((entry) => entry.status === 'scheduled' || entry.status === 'delivered');
      if (active.length >= MAX_REMINDERS) throw new Error('reminder-limit-reached');
      document.reminders.push(reminder);
      prune(document);
      return { changed: true, value: reminder };
    });
  }

  /** Scheduled reminders whose time has come. */
  async due(): Promise<MonarchReminderV1[]> {
    const now = this.now().getTime();
    const document = await this.file.read();
    return document.reminders
      .filter((entry) => entry.status === 'scheduled' && Date.parse(entry.dueAt) <= now)
      .sort(compareReminders);
  }

  /** A shown reminder; a repeating one moves on to its next time instead. */
  async markDelivered(id: string): Promise<MonarchReminderV1 | null> {
    return this.update(id, (reminder, now) => {
      if (reminder.status !== 'scheduled') return false;
      if (reminder.recurrence !== 'none') {
        reminder.dueAt = nextOccurrence(new Date(reminder.dueAt), reminder.recurrence, now).toISOString();
      } else {
        reminder.status = 'delivered';
      }
      reminder.deliveredAt = now.toISOString();
      return true;
    });
  }

  async complete(id: string): Promise<MonarchReminderV1 | null> {
    return this.update(id, (reminder) => {
      if (reminder.status === 'done') return false;
      reminder.status = 'done';
      return true;
    });
  }

  async cancel(id: string): Promise<MonarchReminderV1 | null> {
    return this.update(id, (reminder) => {
      if (reminder.status === 'cancelled') return false;
      reminder.status = 'cancelled';
      return true;
    });
  }

  async snooze(id: string, minutes: number): Promise<MonarchReminderV1 | null> {
    const delay = Math.max(1, Math.min(Math.round(Number(minutes) || 10), 7 * 24 * 60));
    return this.update(id, (reminder, now) => {
      if (reminder.status === 'cancelled') return false;
      reminder.status = 'scheduled';
      reminder.dueAt = new Date(now.getTime() + delay * 60_000).toISOString();
      return true;
    });
  }

  private update(id: string, change: (reminder: MonarchReminderV1, now: Date) => boolean): Promise<MonarchReminderV1 | null> {
    const now = this.now();
    return this.file.mutate((document) => {
      const reminder = document.reminders.find((entry) => entry.id === id);
      if (!reminder) return { changed: false, value: null };
      const changed = change(reminder, now);
      if (changed) {
        reminder.updatedAt = now.toISOString();
        prune(document);
      }
      return { changed, value: { ...reminder } };
    });
  }
}

export function nextOccurrence(previous: Date, recurrence: MonarchReminderRecurrence, now: Date): Date {
  const step = recurrence === 'weekly' ? 7 : 1;
  const next = new Date(previous);
  do next.setDate(next.getDate() + step);
  while (next.getTime() <= now.getTime());
  return next;
}

function prune(document: ReminderDocumentV1): void {
  const finished = document.reminders
    .filter((entry) => entry.status === 'done' || entry.status === 'cancelled' || entry.status === 'delivered')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const drop = new Set(finished.slice(KEEP_FINISHED).map((entry) => entry.id));
  if (drop.size) document.reminders = document.reminders.filter((entry) => !drop.has(entry.id));
}

function compareReminders(left: MonarchReminderV1, right: MonarchReminderV1): number {
  return left.dueAt.localeCompare(right.dueAt);
}

function validateReminderDocument(value: unknown): asserts value is ReminderDocumentV1 {
  const document = value as ReminderDocumentV1;
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.reminders)) {
    throw new Error('reminder-document-invalid');
  }
  for (const entry of document.reminders) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.text !== 'string'
      || typeof entry.dueAt !== 'string' || Number.isNaN(Date.parse(entry.dueAt))
      || !['scheduled', 'delivered', 'done', 'cancelled'].includes(entry.status)
      || !['none', 'daily', 'weekly'].includes(entry.recurrence)) {
      throw new Error('reminder-entry-invalid');
    }
  }
}
