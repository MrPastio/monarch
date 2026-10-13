import { describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { OSCAR_TIER_RECYCLE_REQUIRED_CODE, OscarClient } from '../../src/modules/oscar/client';

async function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('bad address')); return; }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function chatRequest() {
  return { messages: [{ role: 'user' as const, content: 'ping' }], web_search: false,
    use_memory: false, reasoning_effort: 'low' as const, max_new_tokens: 32,
    temperature: 0.2, top_p: 0.9, execution_authority: 'none' as const,
    persistence_owner: 'backend' as const };
}

describe('declined model swap', () => {
  it('surfaces the refusal instead of silently answering nothing when the host owns no backend', async () => {
    // A CUDA process holding one tier cannot load another: ggml turns the CUDA
    // error into abort() and the process dies mid-request. The backend declines
    // instead, and only a fresh process can honour the request — so a host that
    // did not start the backend has to say so rather than retry into the same
    // refusal or hand back an empty answer.
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: error\ndata: ${JSON.stringify({ code: OSCAR_TIER_RECYCLE_REQUIRED_CODE,
        message: 'Готовлю другую модель.' })}\n\n`);
      res.write('event: done\ndata: {"ok": false}\n\n');
      res.end();
    });
    const apiBase = await listen(server);
    try {
      const client = new OscarClient({ apiBase, autoStart: false });
      const events: any[] = [];
      for await (const event of client.streamChat(chatRequest() as any)) events.push(event);

      // The backend was asked exactly once: retrying into an unmanaged process
      // would only repeat the refusal.
      expect(requests).toBe(1);
      const error = events.find(event => event.type === 'error');
      expect(error?.data?.code).toBe(OSCAR_TIER_RECYCLE_REQUIRED_CODE);
      expect(events.at(-1)?.type).toBe('done');
      // The refusal must never reach the caller as a finished empty answer.
      expect(events.some(event => event.type === 'token')).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('passes an ordinary stream through untouched', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: token\ndata: {"token": "ok"}\n\n');
      res.write('event: done\ndata: {"ok": true}\n\n');
      res.end();
    });
    const apiBase = await listen(server);
    try {
      const client = new OscarClient({ apiBase, autoStart: false });
      const events: any[] = [];
      for await (const event of client.streamChat(chatRequest() as any)) events.push(event);
      expect(events.map(event => event.type)).toEqual(['token', 'done']);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('declined model swap on the OpenAI-compatible lane', () => {
  it('recognises the refusal from either lane spelling', async () => {
    const { isOscarTierRecycleRefusal, OscarBackendHttpError } =
      await import('../../src/modules/oscar/client');
    // The chat lane spells its codes kebab-case and the OpenAI lane snake_case;
    // routing uses the second one, so missing it would leave the classifier
    // crashing the backend exactly as before.
    expect(isOscarTierRecycleRefusal(
      new OscarBackendHttpError(503, 'model-tier-recycle-required', 'x'))).toBe(true);
    expect(isOscarTierRecycleRefusal(
      new OscarBackendHttpError(503, 'model_tier_recycle_required', 'x'))).toBe(true);
    expect(isOscarTierRecycleRefusal(
      new OscarBackendHttpError(503, 'insufficient_memory', 'x'))).toBe(false);
    expect(isOscarTierRecycleRefusal(new Error('boom'))).toBe(false);
    expect(isOscarTierRecycleRefusal(undefined)).toBe(false);
  });

  it('keeps an unmanaged backend refusal visible instead of looping on it', async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'model_tier_recycle_required',
        message: 'Preparing a different local model.' } }));
    });
    const apiBase = await listen(server);
    try {
      const client = new OscarClient({ apiBase, autoStart: false });
      await expect(client.completeRaw({ model: 'gemma4-balanced',
        messages: [{ role: 'user', content: 'ping' }] } as any))
        .rejects.toMatchObject({ code: 'model_tier_recycle_required' });
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
