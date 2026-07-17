import type { MonarchEvent } from './contracts';
import { createMonarchId, nowIso } from './utils';

export type MonarchEventListener = (event: MonarchEvent) => void | Promise<void>;

export class MonarchEventBus {
  private readonly listeners = new Map<string, Set<MonarchEventListener>>();
  private readonly history: MonarchEvent[] = [];

  async emit(type: string, source: string, payload?: unknown): Promise<MonarchEvent> {
    const event: MonarchEvent = {
      id: createMonarchId('event'),
      type: type.trim(),
      source: source.trim() || 'unknown',
      createdAt: nowIso(),
      payload,
    };

    this.history.push(event);

    const listeners = [
      ...Array.from(this.listeners.get(type) || []),
      ...Array.from(this.listeners.get('*') || []),
    ];

    for (const listener of listeners) {
      await listener(event);
    }

    return event;
  }

  subscribe(type: string, listener: MonarchEventListener): () => void {
    const key = type.trim() || '*';
    const bucket = this.listeners.get(key) || new Set<MonarchEventListener>();
    bucket.add(listener);
    this.listeners.set(key, bucket);

    return () => {
      bucket.delete(listener);
      if (bucket.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  getHistory(): MonarchEvent[] {
    return [...this.history];
  }
}

