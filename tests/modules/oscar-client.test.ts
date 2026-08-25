import { describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import {
  createDefaultOscarChatRequest,
  drainOscarSseBuffer,
  OscarBackendHttpError,
  OscarClient,
  resolveOscarChatTimeoutMs,
  type OscarChatRequest,
} from '../../src/modules/oscar/client';
import { oscarManifest } from '../../src/modules/oscar/manifest';
import { validateAgainstSchema } from '../../src/core/schema-validator';

describe('OscarClient streaming', () => {
  it('preserves an OpenAI-compatible backend error code', async () => {
    const server = http.createServer((request, response) => {
      request.resume();
      sendJson(response, 503, {
        error: {
          type: 'server_error',
          code: 'insufficient_memory',
          message: 'Synthetic bounded memory refusal.',
        },
      });
    });
    const baseUrl = await listen(server);
    const client = new OscarClient({ apiBase: baseUrl, autoStart: false, timeoutMs: 1_000, chatTimeoutMs: 5_000 });

    try {
      await expect(client.completeRaw({
        model: 'monarch-fast',
        messages: [{ role: 'user', content: 'bounded fixture' }],
        inference_lane: 'agent',
        agent_session_id: 'agent_task_fixture',
      })).rejects.toMatchObject<Partial<OscarBackendHttpError>>({
        statusCode: 503,
        code: 'insufficient_memory',
        message: 'Synthetic bounded memory refusal.',
      });
    } finally {
      await close(server);
    }
  });

  it('gives explicit deep research a separate long transport budget', () => {
    expect(resolveOscarChatTimeoutMs({ research_mode: 'auto' }, 300_000, 1_800_000)).toBe(300_000);
    expect(resolveOscarChatTimeoutMs({ research_mode: 'deep' }, 300_000, 1_800_000)).toBe(1_800_000);
    expect(resolveOscarChatTimeoutMs({ research_mode: 'deep' }, 2_000_000, 1_800_000)).toBe(2_000_000);
  });

  it('keeps every Oscar chat capability schema aligned with the UI and backend request contract', () => {
    const chatInput = {
      messages: [{ role: 'user', content: 'private question' }],
      conversation_id: 'conversation-1',
      incognito: true,
      research_mode: 'auto',
      use_memory: true,
      reasoning_effort: 'low',
      model_selection_source: 'auto',
      max_new_tokens: 65_536,
      temperature: 0.3,
      top_p: 0.9,
    };

    for (const capabilityId of ['oscar.chat.local', 'oscar.chat.route', 'oscar.chat.stream', 'oscar.chat.web']) {
      const capability = oscarManifest.capabilities.find(({ id }) => id === capabilityId);

      expect(capability).toBeDefined();
      expect(validateAgainstSchema(chatInput, capability?.inputSchema)).toEqual({ ok: true, errors: [] });
    }
  });

  it('keeps the bounded research preference in the backend request contract', () => {
    const request = createDefaultOscarChatRequest(
      [{ role: 'user', content: 'analyze this scenario' }],
      undefined,
      { research_mode: 'deep' },
    );

    expect(request.research_mode).toBe('deep');
  });

  it('accepts bounded conversation page inputs in the capability contract', () => {
    const capability = oscarManifest.capabilities.find(({ id }) => id === 'oscar.conversations.manage');

    expect(validateAgainstSchema({
      action: 'get',
      id: 'chat-1',
      message_limit: 80,
      before: 145,
    }, capability?.inputSchema)).toEqual({ ok: true, errors: [] });
    expect(validateAgainstSchema({ action: 'clear' }, capability?.inputSchema))
      .toEqual({ ok: true, errors: [] });
  });

  it('keeps generated token limits inside the backend contract', () => {
    const defaultRequest = createDefaultOscarChatRequest(
      [{ role: 'user', content: 'ping' }],
      false,
      {}
    );
    const clampedRequest = createDefaultOscarChatRequest(
      [{ role: 'user', content: 'ping' }],
      false,
      { max_new_tokens: 1_000_000 }
    );

    expect(defaultRequest.max_new_tokens).toBe(65_536);
    expect(clampedRequest.max_new_tokens).toBe(65_536);
  });

  it('does not admit legacy voice routing fields into the standard chat contract', () => {
    const request = createDefaultOscarChatRequest(
      [{ role: 'user', content: 'обычный текстовый запрос' }],
      false,
      {
        model_selection_source: 'voice-router',
        route: {
          interactionMode: 'voice',
          voiceLane: 'fast',
          intentKind: 'voice_chat',
          riskHint: 'read',
          language: 'ru',
        },
      },
    );

    expect(request.model_selection_source).toBeUndefined();
    expect(request.route).toEqual({ intentKind: 'voice_chat', riskHint: 'read', language: 'ru' });
    expect(request.requested_model).toBeUndefined();
  });

  it('uses status as a cheap probe unless auto-start is explicitly requested', async () => {
    const client = new OscarClient({
      apiBase: 'http://127.0.0.1:1',
      autoStart: true,
      timeoutMs: 100,
      chatTimeoutMs: 100,
    });

    const status = await client.status();

    expect(status.connected).toBe(false);
    expect(status.autoStart).toBe(true);
    expect(status.startupAttempted).toBe(false);
  });

  it('sends Oscar auth token on stream requests', async () => {
    let sawOscarToken = false;
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        sawOscarToken = Boolean(request.headers['x-oscar-token']);
        request.resume();
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: token\ndata: {"token":"ok"}\n\n');
        response.write('event: done\ndata: {"ok":true}\n\n');
        response.end();
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not-found' }));
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 5000,
      timeoutMs: 1000,
    });

    const events = [];
    try {
      for await (const event of client.streamChat(createChatRequest())) {
        events.push(event);
      }
    } finally {
      await close(server);
    }

    expect(sawOscarToken).toBe(true);
    expect(events).toContainEqual({ type: 'token', data: { token: 'ok' } });
  });

  it('flushes a final stream event even without trailing blank line', async () => {
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        request.resume();
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: token\ndata: {"token":"ok"}\n\n');
        response.end('event: done\ndata: {"ok":false}');
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not-found' }));
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 5000,
      timeoutMs: 1000,
    });

    const events = [];
    try {
      for await (const event of client.streamChat(createChatRequest())) {
        events.push(event);
      }
    } finally {
      await close(server);
    }

    expect(events).toEqual([
      { type: 'token', data: { token: 'ok' } },
      { type: 'done', data: { ok: false } },
    ]);
  });

  it('turns EOF without a terminal event into a visible runtime error', async () => {
    const server = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        request.resume();
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('event: token\ndata: {"token":"partial"}\n\n');
        return;
      }
      if (request.method === 'POST' && request.url === '/api/generation/cancel') {
        request.resume();
        sendJson(response, 200, { ok: true, cancelled: true });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 5000,
      timeoutMs: 1000,
    });

    const events = [];
    try {
      for await (const event of client.streamChat(createChatRequest())) {
        events.push(event);
      }
    } finally {
      await close(server);
    }

    expect(events[0]).toEqual({ type: 'token', data: { token: 'partial' } });
    expect(events[1]).toMatchObject({
      type: 'error',
      data: { code: 'runtime-disconnected' },
    });
  });

  it('treats a transport reset after the done event as successful completion', async () => {
    const encoder = new TextEncoder();
    let delivered = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(encoder.encode(
            'event: token\ndata: {"token":"готов"}\n\n'
            + 'event: done\ndata: {"ok":true}\n\n',
          ));
          return;
        }
        controller.error(new TypeError('terminated'));
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const client = new OscarClient({
      apiBase: 'https://oscar.test',
      autoStart: false,
      chatTimeoutMs: 5000,
      timeoutMs: 1000,
    });

    const events = [];
    try {
      for await (const event of client.streamChat(createChatRequest())) {
        events.push(event);
      }
    } finally {
      fetchSpy.mockRestore();
    }

    expect(events).toEqual([
      { type: 'token', data: { token: 'готов' } },
      { type: 'done', data: { ok: true } },
    ]);
  });

  it('stops on the first terminal event and ignores poisoned late stream events', async () => {
    const encoder = new TextEncoder();
    let delivered = false;
    let streamCancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered) {
          return;
        }
        delivered = true;
        controller.enqueue(encoder.encode(
          'event: token\ndata: {"token":"partial"}\n\n'
          + 'event: done\ndata: {"ok":false,"usage":{"generation_stop_reason":"length"}}\n\n'
          + 'event: token\ndata: {"token":"poisoned-late-token"}\n\n'
          + 'event: error\ndata: {"code":"poisoned-late-error"}\n\n'
          + 'event: done\ndata: {"ok":true}\n\n',
        ));
      },
      cancel() {
        streamCancelled = true;
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const client = new OscarClient({
      apiBase: 'https://oscar.test',
      autoStart: false,
      chatTimeoutMs: 5000,
      timeoutMs: 1000,
    });

    const events = [];
    try {
      for await (const event of client.streamChat(createChatRequest())) {
        events.push(event);
      }
    } finally {
      fetchSpy.mockRestore();
    }

    expect(events).toEqual([
      { type: 'token', data: { token: 'partial' } },
      { type: 'done', data: { ok: false, usage: { generation_stop_reason: 'length' } } },
    ]);
    expect(streamCancelled).toBe(true);
  });

  it('cancels backend generation when stream consumer stops early', async () => {
    let cancelCount = 0;
    let resolveCancel: () => void = () => {};
    const cancelSeen = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });

    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        request.resume();
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('event: token\ndata: {"token":"first"}\n\n');
        return;
      }
      if (request.method === 'POST' && request.url === '/api/generation/cancel') {
        cancelCount += 1;
        request.resume();
        sendJson(response, 200, { ok: true, cancelled: true });
        resolveCancel();
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      chatTimeoutMs: 5000,
      timeoutMs: 1000,
    });

    try {
      for await (const event of client.streamChat(createChatRequest())) {
        expect(event).toEqual({ type: 'token', data: { token: 'first' } });
        break;
      }
      await cancelSeen;
    } finally {
      await close(server);
    }

    expect(cancelCount).toBe(1);
  });

  it('cancels and unloads a local Coder model when non-streaming chat fails', async () => {
    const cleanupPaths: string[] = [];
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat') {
        request.resume();
        setTimeout(() => sendJson(response, 200, { answer: 'late', action_proposals: [] }), 120);
        return;
      }
      if (request.method === 'POST' && request.url === '/api/generation/cancel') {
        cleanupPaths.push(request.url);
        request.resume();
        sendJson(response, 200, { ok: true, cancelled: true });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/model/unload') {
        cleanupPaths.push(request.url);
        request.resume();
        sendJson(response, 200, { loaded: false });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });
    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      autoStart: false,
      chatTimeoutMs: 30,
      timeoutMs: 1_000,
    });
    const request = createChatRequest();
    request.messages.unshift({
      role: 'system',
      content: '<monarch_coder_mode>{"project":{"id":"project-1"}}</monarch_coder_mode>',
    });

    try {
      await expect(client.chat(request)).rejects.toThrow('timed out after 30ms');
    } finally {
      await close(server);
    }

    expect(cleanupPaths).toEqual(['/api/generation/cancel', '/api/model/unload']);
  });

  it('does not treat a reachable external backend as an owned managed process', async () => {
    const cleanupPaths: string[] = [];
    const server = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/chat') {
        request.resume();
        setTimeout(() => sendJson(response, 200, { answer: 'late', action_proposals: [] }), 120);
        return;
      }
      if (request.method === 'POST' && request.url === '/api/generation/cancel') {
        cleanupPaths.push(request.url);
        request.resume();
        sendJson(response, 200, { ok: true, cancelled: true });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/model/unload') {
        cleanupPaths.push(request.url);
        request.resume();
        sendJson(response, 200, { loaded: false });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });
    const baseUrl = await listen(server);
    const client = new OscarClient({
      apiBase: baseUrl,
      autoStart: true,
      chatTimeoutMs: 30,
      timeoutMs: 1_000,
    });
    const request = createChatRequest();
    request.messages.unshift({
      role: 'system',
      content: '<monarch_coder_mode>{"project":{"id":"project-1"}}</monarch_coder_mode>',
    });

    try {
      await expect(client.chat(request)).rejects.toThrow('timed out after 30ms');
    } finally {
      await close(server);
    }

    expect(cleanupPaths).toEqual(['/api/generation/cancel', '/api/model/unload']);
  });

  it('keeps partial SSE blocks buffered until flush', () => {
    const pending = drainOscarSseBuffer('event: done\ndata: {"ok":false}');
    expect(pending.events).toEqual([]);
    expect(pending.buffer).toBe('event: done\ndata: {"ok":false}');

    const flushed = drainOscarSseBuffer(pending.buffer, true);
    expect(flushed.events).toEqual([{ type: 'done', data: { ok: false } }]);
    expect(flushed.buffer).toBe('');
  });

  it('passes image attachments into default chat requests', () => {
    const request = createDefaultOscarChatRequest(
      [{ role: 'user', content: 'describe' }],
      false,
      {
        requested_model: 'gemma',
        route: { intentKind: 'assistant_identity', modelTier: 'medium', riskHint: 'none', language: 'ru' },
        image_attachments: [{ mime_type: 'image/png', data_base64: 'ZmFrZQ==', name: 'screen.png', size_bytes: 4 }],
      },
    );

    expect(request.requested_model).toBe('gemma');
    expect(request.route).toEqual({ intentKind: 'assistant_identity', modelTier: 'medium', riskHint: 'none', language: 'ru' });
    expect(request.image_attachments).toEqual([
      { mime_type: 'image/png', data_base64: 'ZmFrZQ==', name: 'screen.png', size_bytes: 4 },
    ]);
  });

  it('keeps the incognito flag in the backend request contract', () => {
    const request = createDefaultOscarChatRequest(
      [{ role: 'user', content: 'private question' }],
      false,
      { conversation_id: 'private-chat', incognito: true },
    );

    expect(request.conversation_id).toBe('private-chat');
    expect(request.incognito).toBe(true);
  });

  it('requests bounded conversation pages from the backend', async () => {
    let capturedUrl = '';
    const server = http.createServer((request, response) => {
      capturedUrl = request.url || '';
      sendJson(response, 200, { id: 'chat-1', messages: [], message_page: { has_more: false } });
    });
    const baseUrl = await listen(server);
    const client = new OscarClient({ apiBase: baseUrl, autoStart: false, timeoutMs: 1000 });

    try {
      await client.getConversation('chat-1', { messageLimit: 80, before: 145 });
    } finally {
      await close(server);
    }

    expect(capturedUrl).toBe('/api/conversations/chat-1?message_limit=80&before=145');
  });

  it('uses the collection DELETE endpoint for a durable history clear', async () => {
    let capturedMethod = '';
    let capturedUrl = '';
    const server = http.createServer((request, response) => {
      capturedMethod = request.method || '';
      capturedUrl = request.url || '';
      sendJson(response, 200, { ok: true, deleted: 3, archived: 1, remaining: 1 });
    });
    const baseUrl = await listen(server);
    const client = new OscarClient({ apiBase: baseUrl, autoStart: false, timeoutMs: 1000 });

    try {
      await expect(client.clearConversations()).resolves.toMatchObject({ deleted: 3, archived: 1 });
    } finally {
      await close(server);
    }

    expect(capturedMethod).toBe('DELETE');
    expect(capturedUrl).toBe('/api/conversations');
  });

  it('persists pre-dispatched conversation messages through the backend contract', async () => {
    let capturedBody: unknown;
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/conversations/chat-1/messages') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          sendJson(response, 200, {
            ok: true,
            disposition: 'created',
            message: {
              id: 'message-created',
              conversation_id: 'chat-1',
              role: 'assistant',
              content: 'Точный путь: E:\\Monarch',
            },
            duplicate: false,
          });
        });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });
    const baseUrl = await listen(server);
    const client = new OscarClient({ apiBase: baseUrl, autoStart: false, timeoutMs: 1000 });

    try {
      await expect(client.appendConversationMessage('chat-1', {
        role: 'assistant',
        content: 'Точный путь: E:\\Monarch',
        token_count: 0,
        elapsed_ms: 0,
        model_tier: 'system',
      })).resolves.toMatchObject({ disposition: 'created', duplicate: false });
    } finally {
      await close(server);
    }

    expect(capturedBody).toEqual({
      role: 'assistant',
      content: 'Точный путь: E:\\Monarch',
      token_count: 0,
      elapsed_ms: 0,
      model_tier: 'system',
    });
  });

  it.each([
    ['legacy receipt without a disposition', { ok: true }],
    ['created receipt without a message', { ok: true, disposition: 'created', message: null, duplicate: false }],
    ['duplicate receipt carrying a message', { ok: true, disposition: 'duplicate', message: { id: 'unexpected' }, duplicate: true }],
    ['superseded receipt marked as duplicate', { ok: true, disposition: 'superseded', message: null, duplicate: true }],
    ['superseded receipt for a user append', { ok: true, disposition: 'superseded', message: null, duplicate: false }],
    ['created receipt for another conversation', {
      ok: true,
      disposition: 'created',
      message: {
        conversation_id: 'chat-other',
        role: 'user',
        content: 'Проверь receipt.',
      },
      duplicate: false,
    }],
  ])('fails closed on %s', async (_case, payload) => {
    const server = http.createServer((_request, response) => sendJson(response, 200, payload));
    const baseUrl = await listen(server);
    const client = new OscarClient({ apiBase: baseUrl, autoStart: false, timeoutMs: 1000 });

    try {
      await expect(client.appendConversationMessage('chat-invalid-receipt', {
        role: 'user',
        content: 'Проверь receipt.',
      })).rejects.toThrow(/conversation message.*receipt/);
    } finally {
      await close(server);
    }
  });

  it('preserves a retryable prerequisite conflict instead of converting it to success', async () => {
    const server = http.createServer((_request, response) => sendJson(response, 409, {
      detail: {
        code: 'conversation-message-prerequisite-pending',
        message: 'required previous user message has not been persisted yet',
        retryable: true,
      },
    }));
    const baseUrl = await listen(server);
    const client = new OscarClient({ apiBase: baseUrl, autoStart: false, timeoutMs: 1000 });

    try {
      await expect(client.appendConversationMessage('chat-partial-outage', {
        role: 'assistant',
        content: 'Не завершено.',
        required_previous_message_id: 'message-user-pending',
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'conversation-message-prerequisite-pending',
      });
    } finally {
      await close(server);
    }
  });

  it('rejects a created receipt bound to another Turn even when the HTTP request succeeded', async () => {
    const server = http.createServer((_request, response) => sendJson(response, 200, {
      ok: true,
      disposition: 'created',
      message: {
        conversation_id: 'chat-bound-receipt',
        role: 'assistant',
        content: 'Не завершено.',
        client_message_id: 'message-bound-receipt',
        turn_id: 'turn-other',
        provenance: { turnId: 'turn-other' },
        outcome: 'failed',
      },
      duplicate: false,
    }));
    const baseUrl = await listen(server);
    const client = new OscarClient({ apiBase: baseUrl, autoStart: false, timeoutMs: 1000 });

    try {
      await expect(client.appendConversationMessage('chat-bound-receipt', {
        role: 'assistant',
        content: 'Не завершено.',
        client_message_id: 'message-bound-receipt',
        turn_id: 'turn-expected',
        provenance: { turnId: 'turn-expected' },
        outcome: 'failed',
      })).rejects.toThrow('receipt for a different append request');
    } finally {
      await close(server);
    }
  });
});

function createChatRequest(): OscarChatRequest {
  return {
    messages: [{ role: 'user', content: 'ping' }],
    web_search: false,
    use_memory: false,
    reasoning_effort: 'low',
    max_new_tokens: 32,
    temperature: 0.2,
    top_p: 0.9,
  };
}

function listen(server: Server): Promise<string> {
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

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function close(server: Server): Promise<void> {
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
