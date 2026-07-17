import { describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import {
  OscarClient,
  createDefaultOscarChatRequest,
} from '../../src/modules/oscar/client';

describe('OscarClient Cancellation and Leak Verification', () => {
  // Helper to start the server
  async function listen(server: Server): Promise<string> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Invalid test server address.'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  // Helper to close the server
  async function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  function createChatRequest() {
    return {
      messages: [{ role: 'user', content: 'ping' as const }],
      web_search: false,
      use_memory: false,
      reasoning_effort: 'low' as const,
      max_new_tokens: 32,
      temperature: 0.2,
      top_p: 0.9,
    };
  }

  it('H1: stream consumer early exit via break triggers cancelGeneration and aborts the stream request', async () => {
    let cancelReceived = false;
    let streamAborted = false;

    const server = http.createServer((req, res) => {
      if (req.url === '/api/chat/stream') {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: token\ndata: {"token":"first"}\n\n');

        req.on('close', () => {
          streamAborted = true;
        });
        return;
      }
      if (req.url === '/api/generation/cancel') {
        cancelReceived = true;
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 2000,
      timeoutMs: 500,
    });

    try {
      for await (const event of client.streamChat(createChatRequest())) {
        expect(event.type).toBe('token');
        break; // consumer exits early!
      }

      // Give async callbacks a brief moment to propagate
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await closeServer(server);
    }

    expect(cancelReceived).toBe(true);
    expect(streamAborted).toBe(true);
  });

  it('H2: stream consumer throwing an error during iteration triggers cancelGeneration and aborts stream request', async () => {
    let cancelReceived = false;
    let streamAborted = false;

    const server = http.createServer((req, res) => {
      if (req.url === '/api/chat/stream') {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: token\ndata: {"token":"first"}\n\n');

        req.on('close', () => {
          streamAborted = true;
        });
        return;
      }
      if (req.url === '/api/generation/cancel') {
        cancelReceived = true;
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 2000,
      timeoutMs: 500,
    });

    try {
      await expect(async () => {
        for await (const event of client.streamChat(createChatRequest())) {
          expect(event.type).toBe('token');
          throw new Error('Consumer failure');
        }
      }).rejects.toThrow('Consumer failure');

      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await closeServer(server);
    }

    expect(cancelReceived).toBe(true);
    expect(streamAborted).toBe(true);
  });

  it('H3: server abruptly terminates connection midway triggers cancelGeneration', async () => {
    let cancelReceived = false;

    const server = http.createServer((req, res) => {
      if (req.url === '/api/chat/stream') {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: token\ndata: {"token":"first"}\n\n');

        // Abruptly destroy socket
        setTimeout(() => {
          res.destroy();
        }, 50);
        return;
      }
      if (req.url === '/api/generation/cancel') {
        cancelReceived = true;
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 2000,
      timeoutMs: 500,
    });

    try {
      const events = [];
      for await (const event of client.streamChat(createChatRequest())) {
        events.push(event);
      }
      expect(events).toContainEqual(expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: 'runtime-disconnected' }),
      }));

      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await closeServer(server);
    }

    expect(cancelReceived).toBe(true);
  });

  it('H4: server completes cleanly but without sending done event triggers cancelGeneration', async () => {
    let cancelReceived = false;

    const server = http.createServer((req, res) => {
      if (req.url === '/api/chat/stream') {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: token\ndata: {"token":"first"}\n\n');
        // Close cleanly without done event
        res.end();
        return;
      }
      if (req.url === '/api/generation/cancel') {
        cancelReceived = true;
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 2000,
      timeoutMs: 500,
    });

    try {
      const events = [];
      for await (const event of client.streamChat(createChatRequest())) {
        events.push(event);
      }
      expect(events.length).toBe(2);
      expect(events[0].type).toBe('token');
      expect(events[1]).toMatchObject({
        type: 'error',
        data: { code: 'runtime-disconnected' },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await closeServer(server);
    }

    // Since 'done' event was never received, we expect cancelGeneration to run
    expect(cancelReceived).toBe(true);
  });

  it('H4 (control): server completes cleanly WITH done event does NOT trigger cancelGeneration', async () => {
    let cancelReceived = false;

    const server = http.createServer((req, res) => {
      if (req.url === '/api/chat/stream') {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: token\ndata: {"token":"first"}\n\n');
        res.write('event: done\ndata: {"ok":true}\n\n');
        res.end();
        return;
      }
      if (req.url === '/api/generation/cancel') {
        cancelReceived = true;
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 2000,
      timeoutMs: 500,
    });

    try {
      const events = [];
      for await (const event of client.streamChat(createChatRequest())) {
        events.push(event);
      }
      expect(events.length).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await closeServer(server);
    }

    // Since 'done' event was received, we expect cancelGeneration is NOT called
    expect(cancelReceived).toBe(false);
  });

  it('H5: stream request failing (e.g. 500 error) triggers cancelGeneration', async () => {
    let cancelReceived = false;

    const server = http.createServer((req, res) => {
      if (req.url === '/api/chat/stream') {
        req.resume();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
        return;
      }
      if (req.url === '/api/generation/cancel') {
        cancelReceived = true;
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 2000,
      timeoutMs: 500,
    });

    try {
      const events = [];
      for await (const event of client.streamChat(createChatRequest())) {
        events.push(event);
      }
      expect(events).toContainEqual(expect.objectContaining({
        type: 'error',
        data: expect.objectContaining({ code: 'runtime-disconnected' }),
      }));

      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await closeServer(server);
    }

    expect(cancelReceived).toBe(true);
  });
});
