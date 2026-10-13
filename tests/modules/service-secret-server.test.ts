import { describe, expect, it } from 'vitest';
import { startServiceSecretServer } from '../../desktop/electron/service-secret-server.mjs';

describe('shared Desktop service secret server', () => {
  it('validates the exact envelope and sanitizes broker errors', async () => {
    const server = await startServiceSecretServer({
      serviceId: 'calendar',
      operation: async () => { throw Error('refresh_token=private'); },
    });
    try {
      const headers = { authorization: `Bearer ${server.bearerToken}`, 'content-type': 'application/json' };
      const malformed = await fetch(server.endpoint, { method: 'POST', headers,
        body: JSON.stringify({ operation: 'events.list', input: {}, extra: true }) });
      await expect(malformed.json()).resolves.toEqual({ error: 'calendar:host-request' });
      const untrusted = await fetch(server.endpoint, { method: 'POST', headers,
        body: JSON.stringify({ operation: 'events.list', input: {} }) });
      await expect(untrusted.json()).resolves.toEqual({ error: 'calendar:host-request' });
    } finally {
      await server.close();
    }
  });

  it('aborts the active broker operation when the runtime client disconnects', async () => {
    let markEntered!: () => void;
    let markCancelled!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
    const server = await startServiceSecretServer({
      serviceId: 'calendar',
      operation: async (_operation, _input, signal: AbortSignal) => {
        markEntered();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
          markCancelled();
          reject(Error('calendar:cancelled'));
        }, { once: true }));
        return {};
      },
    });
    try {
      const controller = new AbortController();
      const pending = fetch(server.endpoint, { method: 'POST', signal: controller.signal, headers: {
        authorization: `Bearer ${server.bearerToken}`, 'content-type': 'application/json',
      }, body: JSON.stringify({ operation: 'events.list', input: {} }) }).catch(error => error);
      await entered;
      controller.abort('stop');
      await pending;
      await cancelled;
      expect(controller.signal.aborted).toBe(true);
    } finally {
      await server.close();
    }
  });
});
