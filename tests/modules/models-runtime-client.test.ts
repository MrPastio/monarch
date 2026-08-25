import { describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { normalizeAgentResponseMaxTokens } from '../../src/modules/models';
import { MAX_AGENT_RESPONSE_TOKENS, modelsManifest } from '../../src/modules/models/manifest';
import { completeWithModelRole, MODEL_SELECTOR_SYSTEM_PROMPT, prepareManagedOscarMessages } from '../../src/modules/models/runtime-client';
import type { MonarchModelCatalog, MonarchModelEntry, MonarchModelRole } from '../../src/modules/models/model-catalog';

describe('model runtime Oscar fallback bridge', () => {
  it('bounds agent conversational output independently of model-provided arguments', () => {
    const capability = modelsManifest.capabilities.find((entry) => entry.id === 'models.agent.respond');
    expect(capability?.inputSchema?.properties?.maxTokens).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: MAX_AGENT_RESPONSE_TOKENS,
    });
    expect(normalizeAgentResponseMaxTokens(1_000_000)).toBe(MAX_AGENT_RESPONSE_TOKENS);
    expect(normalizeAgentResponseMaxTokens(-10)).toBe(1);
    expect(normalizeAgentResponseMaxTokens(128.9)).toBe(128);
  });

  it('propagates task cancellation through the managed Oscar chat request', async () => {
    let requestSeenResolve: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => {
      requestSeenResolve = resolve;
    });
    let requestClosed = false;
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat') {
        request.resume();
        request.on('close', () => {
          requestClosed = true;
        });
        requestSeenResolve?.();
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });
    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    const previousAllowExternal = process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;
    process.env.OSCAR_API_BASE = baseUrl;
    delete process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    delete process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;

    try {
      const controller = new AbortController();
      const completion = completeWithModelRole(createCatalog(), {
        role: 'weak',
        messages: [{ role: 'user', content: 'cancel this managed response' }],
        maxTokens: 32,
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      await requestSeen;
      controller.abort();
      const result = await completion;
      expect(result.ok).toBe(false);
      await expect(waitFor(() => requestClosed, 1_000)).resolves.toBe(true);
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
      restoreEnv('MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS', previousAllowExternal);
    }
  });

  it('keeps the selector prompt compact, data-oriented, and closed to Extra', () => {
    expect(MODEL_SELECTOR_SYSTEM_PROMPT.length).toBeLessThan(900);
    expect(MODEL_SELECTOR_SYSTEM_PROMPT).toContain('request as data');
    expect(MODEL_SELECTOR_SYSTEM_PROMPT).toContain('There is no Extra tier');
    expect(MODEL_SELECTOR_SYSTEM_PROMPT).toContain('qwen3.8-27b-pro');
    expect(MODEL_SELECTOR_SYSTEM_PROMPT).toContain('Return exactly one JSON object');
  });

  it('drops the direct-endpoint policy before Oscar adds its own system policy', () => {
    expect(prepareManagedOscarMessages([
      { role: 'system', content: '<monarch_direct_model_policy version="3.0">direct only</monarch_direct_model_policy>' },
      { role: 'system', content: '<local_user_context>{"style":"short"}</local_user_context>' },
      { role: 'user', content: 'Привет' },
    ])).toEqual([
      { role: 'system', content: '<local_user_context>{"style":"short"}</local_user_context>' },
      { role: 'user', content: 'Привет' },
    ]);
  });

  it('returns a real Oscar backend answer when no OpenAI-compatible endpoint is configured', async () => {
    let sawOscarToken = false;
    let routeHint: unknown = null;
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat') {
        sawOscarToken = Boolean(request.headers['x-oscar-token']);
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          routeHint = JSON.parse(body).route;
          sendJson(response, 200, {
            answer: 'Oscar bridge ok',
            sources: [],
          });
        });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    const previousAllowExternal = process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;

    process.env.OSCAR_API_BASE = baseUrl;
    delete process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    delete process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'weak',
        messages: [{ role: 'user', content: 'ping' }],
        routeHint: { intentKind: 'assistant_identity', modelTier: 'medium', riskHint: 'none', language: 'ru' },
        maxTokens: 32,
        timeoutMs: 5000,
      });

      expect(result.ok).toBe(true);
      expect(result.adapter).toBe('oscar-managed-backend');
      expect(result.rawText).toBe('Oscar bridge ok');
      expect(sawOscarToken).toBe(true);
      expect(routeHint).toEqual({ intentKind: 'assistant_identity', modelTier: 'medium', riskHint: 'none', language: 'ru' });
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
      restoreEnv('MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS', previousAllowExternal);
    }
  });

  it.each([
    {
      name: 'explicit backend rejection',
      response: {
        ok: false,
        answer: 'Недостаточно свободной RAM для выбранной модели.',
        usage: { generation_stop_reason: 'stop', likely_truncated: false },
      },
      error: 'oscar-runtime-rejected',
      finishReason: 'stop',
      truncated: false,
    },
    {
      name: 'token-limit completion despite backend ok',
      response: {
        ok: true,
        answer: 'Оборванный нестриминговый ответ',
        usage: { generation_stop_reason: 'length', likely_truncated: true },
      },
      error: 'model-output-truncated',
      finishReason: 'length',
      truncated: true,
    },
  ])('fails a managed nonstream response on $name', async (scenario) => {
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat') {
        request.resume();
        sendJson(response, 200, scenario.response);
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });
    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    process.env.OSCAR_API_BASE = baseUrl;
    delete process.env.MONARCH_CHAT_MODEL_ENDPOINT;

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'weak',
        fallbackRoles: [],
        messages: [{ role: 'user', content: 'managed nonstream terminal contract' }],
        maxTokens: 32,
      });

      expect(result).toMatchObject({
        ok: false,
        adapter: 'oscar-managed-backend',
        error: scenario.error,
        rawText: scenario.response.answer,
        finishReason: scenario.finishReason,
        degraded: true,
      });
      expect(Boolean(result.truncated)).toBe(scenario.truncated);
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
    }
  });

  it('uses Oscar raw local inference for agent decisions instead of the conversational chat route', async () => {
    let rawRequest: any = null;
    let conversationalRouteCalled = false;
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          rawRequest = JSON.parse(body);
          sendJson(response, 200, {
            model: 'monarch-balanced',
            monarch_runtime: {
              queue_latency_ms: 2,
              load_latency_ms: 3,
              generation_latency_ms: 4,
            },
            choices: [{ message: { content: '{"kind":"act","capabilityId":"device.app.open","input":{"app":"Telegram"},"reason":"open","expectedEffect":"opened","verification":[{"kind":"status","target":"result.output.opened","value":true}]}' } }],
          });
        });
        return;
      }
      if (request.url === '/api/chat') {
        conversationalRouteCalled = true;
      }
      sendJson(response, 404, { error: 'not-found' });
    });
    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    process.env.OSCAR_API_BASE = baseUrl;
    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'gemma4-balanced',
        fallbackRoles: ['gemma4-fast'],
        purpose: 'agent-decision',
        agentSessionId: 'agent_task_fixture_session',
        responseFormat: 'json',
        messages: [
          { role: 'system', content: 'Return JSON.' },
          { role: 'user', content: '{"goal":"open Telegram"}' },
        ],
        maxTokens: 512,
      });

      expect(result.ok).toBe(true);
      expect(result.adapter).toBe('oscar-agent-raw');
      expect(result.model).toBe('monarch-balanced');
      expect(result.rawText).toContain('"device.app.open"');
      expect(result).toMatchObject({
        queueLatencyMs: 2,
        loadLatencyMs: 3,
        generationLatencyMs: 4,
      });
      expect(rawRequest).toMatchObject({
        model: 'monarch-balanced',
        max_tokens: 512,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        agent_session_id: 'agent_task_fixture_session',
      });
      expect(conversationalRouteCalled).toBe(false);
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
    }
  });

  it('uses the same raw Agent lane for a capability response instead of nested conversational routing', async () => {
    let rawRequest: any = null;
    let conversationalRouteCalled = false;
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          rawRequest = JSON.parse(body);
          sendJson(response, 200, {
            model: 'monarch-fast',
            choices: [{ message: { content: 'Привет' }, finish_reason: 'stop' }],
          });
        });
        return;
      }
      if (request.url === '/api/chat') conversationalRouteCalled = true;
      sendJson(response, 404, { error: 'not-found' });
    });
    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    process.env.OSCAR_API_BASE = baseUrl;
    delete process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'gemma4-fast',
        fallbackRoles: [],
        purpose: 'agent-response',
        agentSessionId: 'agent_task_response_fixture',
        messages: [{ role: 'user', content: 'Привет' }],
        maxTokens: 64,
      });

      expect(result).toMatchObject({
        ok: true,
        adapter: 'oscar-agent-raw',
        model: 'monarch-fast',
        rawText: 'Привет',
      });
      expect(rawRequest).toMatchObject({
        model: 'monarch-fast',
        max_tokens: 64,
        inference_lane: 'agent',
        agent_session_id: 'agent_task_response_fixture',
      });
      expect(rawRequest).not.toHaveProperty('response_format');
      expect(conversationalRouteCalled).toBe(false);
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
    }
  });

  it('correctly maps and routes vision role requests to gemma tier via Oscar bridge', async () => {
    let requestedModelParam = '';
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          const parsed = JSON.parse(body);
          requestedModelParam = parsed.requested_model;
          sendJson(response, 200, { answer: 'Gemma vision bridge ok' });
        });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    process.env.OSCAR_API_BASE = baseUrl;

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'vision',
        messages: [{ role: 'user', content: 'Опиши изображение' }],
        maxTokens: 32,
      });

      expect(result.ok).toBe(true);
      expect(result.adapter).toBe('oscar-managed-backend');
      expect(requestedModelParam).toBeUndefined();
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
    }
  });

  it('treats requested Gemma mode as a hard override before normal chat endpoints', async () => {
    let normalEndpointCalled = false;
    let requestedModelParam = '';
    const normalServer = http.createServer((request, response) => {
      normalEndpointCalled = true;
      request.resume();
      sendJson(response, 500, { error: 'normal endpoint should not be used' });
    });
    const oscarServer = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          requestedModelParam = JSON.parse(body).requested_model;
          sendJson(response, 200, { answer: 'Gemma hard override ok' });
        });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const normalBaseUrl = await listen(normalServer);
    const oscarBaseUrl = await listen(oscarServer);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    const previousAllowExternal = process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;

    process.env.OSCAR_API_BASE = oscarBaseUrl;
    process.env.MONARCH_CHAT_MODEL_ENDPOINT = normalBaseUrl;
    process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS = '1';

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'weak',
        requestedModel: 'gemma',
        messages: [{ role: 'user', content: 'Проверь Gemma-only' }],
        maxTokens: 32,
      });

      expect(result.ok).toBe(true);
      expect(result.role).toBe('vision');
      expect(result.attemptedRoles).toEqual(['vision']);
      expect(result.rawText).toBe('Gemma hard override ok');
      expect(requestedModelParam).toBe('gemma4-balanced');
      expect(normalEndpointCalled).toBe(false);
    } finally {
      await close(normalServer);
      await close(oscarServer);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
      restoreEnv('MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS', previousAllowExternal);
    }
  });

  it('does not serialize an automatically selected tier as an explicit model request', async () => {
    let payload: Record<string, unknown> = {};
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        payload = JSON.parse(body);
        sendJson(response, 200, { answer: 'policy ok' });
      });
    });
    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    process.env.OSCAR_API_BASE = baseUrl;

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'powerful',
        selectionSource: 'auto',
        messages: [{ role: 'user', content: 'сложный запрос' }],
      });

      expect(result.ok).toBe(true);
      expect(payload.requested_model).toBeUndefined();
      expect(payload.model_selection_source).toBe('auto');
      expect(payload.deep_thinking_consent).toBeUndefined();
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
    }
  });

  it('requires consent for an explicit DeepThinking model request', async () => {
    const result = await completeWithModelRole(createCatalog(), {
      role: 'gemma4-deepthinking',
      requestedModel: 'gemma4-deepthinking',
      selectionSource: 'user-explicit',
      messages: [{ role: 'user', content: 'думай глубоко' }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('deep-thinking-confirmation-required');
    expect(result.attemptedRoles).toEqual(['gemma4-deepthinking']);
  });

  it('never escalates an automatic Fast fallback into DeepThinking', async () => {
    let payload: Record<string, unknown> = {};
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        payload = JSON.parse(body);
        sendJson(response, 200, { answer: 'fast fallback ok' });
      });
    });
    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    process.env.OSCAR_API_BASE = baseUrl;

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'gemma4-fast',
        selectionSource: 'auto',
        messages: [{ role: 'user', content: 'быстрый запрос' }],
      });

      expect(result.attemptedRoles).toEqual(['gemma4-fast', 'gemma4-balanced']);
      expect(payload.requested_model).toBeUndefined();
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
    }
  });

  it('streams Oscar SSE token payloads and normalizes Gemma image attachments', async () => {
    let requestedModelParam = '';
    let firstAttachment: any = null;
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          const parsed = JSON.parse(body);
          requestedModelParam = parsed.requested_model;
          firstAttachment = parsed.image_attachments?.[0] || null;
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end([
            'event: token',
            'data: {"token":"Gemma "}',
            '',
            'event: token',
            'data: {"token":"stream ok"}',
            '',
            'event: done',
            'data: {"ok":true}',
            '',
            '',
          ].join('\n'));
        });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    process.env.OSCAR_API_BASE = baseUrl;
    const tokens: string[] = [];

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'vision',
        requestedModel: 'gemma',
        messages: [{ role: 'user', content: 'Опиши изображение' }],
        imageAttachments: [{
          media_type: 'image/png',
          data_base64: 'data:image/png;base64,aGVsbG8=',
          name: 'sample.png',
        }],
        maxTokens: 32,
        onToken: (token) => tokens.push(token),
      });

      expect(result.ok).toBe(true);
      expect(result.rawText).toBe('Gemma stream ok');
      expect(tokens).toEqual(['Gemma ', 'stream ok']);
      expect(requestedModelParam).toBe('gemma4-balanced');
      expect(firstAttachment).toMatchObject({
        mime_type: 'image/png',
        data_base64: 'aGVsbG8=',
        name: 'sample.png',
      });
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
    }
  });

  it('marks Oscar fallback streams as degraded failures instead of successful model answers', async () => {
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        request.resume();
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end([
          'event: token',
          'data: {"token":"Local model is unavailable. "}',
          '',
          'event: token',
          'data: {"token":"Safe fallback response."}',
          '',
          'event: done',
          'data: {"ok":false}',
          '',
          '',
        ].join('\n'));
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    process.env.OSCAR_API_BASE = baseUrl;
    const tokens: string[] = [];

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'weak',
        messages: [{ role: 'user', content: 'fallback probe' }],
        maxTokens: 32,
        onToken: (token) => tokens.push(token),
      });

      expect(result.ok).toBe(false);
      expect(result.degraded).toBe(true);
      expect(result.adapter).toBe('oscar-managed-backend');
      expect(result.error).toBe('oscar-fallback-or-recovery');
      expect(result.rawText).toBe('Local model is unavailable. Safe fallback response.');
      expect(result.trace).toMatchObject({
        source: 'oscar-managed-backend',
        status: 'degraded',
        reason: 'oscar-fallback-or-recovery',
      });
      expect(result.firstTokenLatencyMs).toEqual(expect.any(Number));
      expect(result.totalLatencyMs).toEqual(expect.any(Number));
      expect(tokens).toEqual(['Local model is unavailable. ', 'Safe fallback response.']);
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
    }
  });

  it('preserves partial Oscar text and fails closed when the managed stream disconnects before done', async () => {
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        request.resume();
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('event: token\ndata: {"token":"partial managed answer"}\n\n');
        return;
      }
      if (request.method === 'POST' && request.url === '/api/chat/cancel') {
        request.resume();
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    process.env.OSCAR_API_BASE = baseUrl;
    delete process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    const tokens: string[] = [];

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'weak',
        messages: [{ role: 'user', content: 'disconnect after one token' }],
        maxTokens: 32,
        onToken: (token) => tokens.push(token),
      });

      expect(result).toMatchObject({
        ok: false,
        adapter: 'oscar-managed-backend',
        error: 'runtime-disconnected',
        rawText: 'partial managed answer',
        degraded: true,
        streamCompleted: false,
      });
      expect(result.trace).toMatchObject({
        status: 'degraded',
        reason: 'runtime-disconnected',
        streamCompleted: false,
      });
      expect(tokens).toEqual(['partial managed answer']);
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
    }
  });

  it('rejects a managed Oscar done event that reports a token-limit stop', async () => {
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/chat/stream') {
        request.resume();
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end([
          'event: token',
          'data: {"token":"bounded but incomplete"}',
          '',
          'event: done',
          'data: {"ok":true,"usage":{"generation_stop_reason":"length","likely_truncated":true}}',
          '',
          '',
        ].join('\n'));
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    process.env.OSCAR_API_BASE = baseUrl;
    delete process.env.MONARCH_CHAT_MODEL_ENDPOINT;

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'weak',
        messages: [{ role: 'user', content: 'hit the generation boundary' }],
        maxTokens: 32,
        onToken: () => undefined,
      });

      expect(result).toMatchObject({
        ok: false,
        error: 'model-output-truncated',
        rawText: 'bounded but incomplete',
        finishReason: 'length',
        truncated: true,
        streamCompleted: true,
      });
      expect(result.trace).toMatchObject({
        reason: 'model-output-truncated',
        finishReason: 'length',
        truncated: true,
        streamCompleted: true,
      });
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
    }
  });

  it('accepts a direct OpenAI stream only after a terminal marker and preserves stop telemetry', async () => {
    const { result, tokens } = await runDirectStreamingCompletion([
      'data:{"choices":[{"delta":{"content":"direct "},"finish_reason":null}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]',
    ]);

    expect(result).toMatchObject({
      ok: true,
      rawText: 'direct complete',
      finishReason: 'stop',
      streamCompleted: true,
    });
    expect(tokens).toEqual(['direct ', 'complete']);
  });

  it.each([
    {
      name: 'clean EOF before [DONE]',
      chunks: ['data: {"choices":[{"delta":{"content":"partial eof"},"finish_reason":"stop"}]}\n\n'],
      error: 'model-stream-incomplete',
      streamCompleted: false,
      finishReason: 'stop',
      truncated: false,
    },
    {
      name: 'malformed JSON before [DONE]',
      chunks: [
        'data: {"choices":[{"delta":{"content":"partial malformed"}}]}\n\n',
        'data: {not-json}\n\ndata: [DONE]\n\n',
      ],
      error: 'model-stream-invalid-event',
      streamCompleted: true,
      finishReason: undefined,
      truncated: false,
    },
    {
      name: 'provider error payload before [DONE]',
      chunks: [
        'data: {"choices":[{"delta":{"content":"partial provider"}}]}\n\n',
        'data: {"error":{"code":"local_generation_failed","message":"internal detail"}}\n\ndata: [DONE]\n\n',
      ],
      error: 'model-stream-error:local_generation_failed',
      streamCompleted: true,
      finishReason: undefined,
      truncated: false,
    },
    {
      name: 'explicit length finish',
      chunks: [
        'data: {"choices":[{"delta":{"content":"partial length"},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ],
      error: 'model-output-truncated',
      streamCompleted: true,
      finishReason: 'length',
      truncated: true,
    },
    {
      name: 'contradictory stop plus runtime error telemetry',
      chunks: [
        'data: {"choices":[{"delta":{"content":"partial contradiction"},"finish_reason":"stop"}],"monarch_runtime":{"generation_stop_reason":"error"}}\n\n',
        'data: [DONE]\n\n',
      ],
      error: 'model-generation-failed',
      streamCompleted: true,
      finishReason: 'error',
      truncated: false,
    },
  ])('fails a direct stream on $name without mixing in a fallback answer', async (scenario) => {
    const { result, tokens } = await runDirectStreamingCompletion(scenario.chunks);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(scenario.error);
    expect(result.streamCompleted).toBe(scenario.streamCompleted);
    expect(result.finishReason).toBe(scenario.finishReason);
    expect(Boolean(result.truncated)).toBe(scenario.truncated);
    expect(result.rawText).toContain('partial');
    expect(result.trace).toMatchObject({
      source: 'openai-compatible-endpoint',
      status: 'failed',
      reason: scenario.error,
      streamCompleted: scenario.streamCompleted,
    });
    expect(tokens.join('')).toBe(result.rawText);
  });

  it('propagates a raw Agent length finish instead of accepting parseable-looking JSON', async () => {
    let rawCalls = 0;
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        rawCalls += 1;
        request.resume();
        sendJson(response, 200, {
          model: 'monarch-balanced',
          choices: [{
            message: { content: '{"kind":"answer","message":"looks complete"}' },
            finish_reason: 'length',
          }],
        });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    process.env.OSCAR_API_BASE = baseUrl;
    delete process.env.MONARCH_CHAT_MODEL_ENDPOINT;

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'gemma4-balanced',
        fallbackRoles: [],
        purpose: 'agent-decision',
        responseFormat: 'json',
        messages: [{ role: 'user', content: '{"goal":"answer"}' }],
        maxTokens: 64,
      });

      expect(result).toMatchObject({
        ok: false,
        adapter: 'oscar-agent-raw',
        error: 'agent-decision-output-truncated',
        rawText: '{"kind":"answer","message":"looks complete"}',
        finishReason: 'length',
        truncated: true,
      });
      expect(rawCalls).toBe(1);
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
    }
  });

  it('rejects a direct nonstream payload that mixes provider error metadata with plausible text', async () => {
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        request.resume();
        sendJson(response, 200, {
          error: { code: 'local_generation_failed', message: 'sensitive provider detail' },
          choices: [{ message: { content: 'Plausible but invalid answer' }, finish_reason: 'stop' }],
        });
        return;
      }
      sendJson(response, 503, { error: 'managed fallback unavailable' });
    });
    const baseUrl = await listen(server);
    const previousOscarBase = process.env.OSCAR_API_BASE;
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    process.env.OSCAR_API_BASE = baseUrl;
    process.env.MONARCH_CHAT_MODEL_ENDPOINT = baseUrl;

    try {
      const result = await completeWithModelRole(createCatalog(), {
        role: 'weak',
        fallbackRoles: [],
        messages: [{ role: 'user', content: 'adversarial mixed payload' }],
        maxTokens: 32,
      });

      expect(result).toMatchObject({
        ok: false,
        error: 'model-stream-error:local_generation_failed',
        rawText: 'Plausible but invalid answer',
        finishReason: 'stop',
        degraded: true,
      });
      expect(result.adapter).toMatch(/compatible$/u);
      expect(JSON.stringify(result)).not.toContain('sensitive provider detail');
    } finally {
      await close(server);
      restoreEnv('OSCAR_API_BASE', previousOscarBase);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
    }
  });

  it('routes to a local loopback endpoint without MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS when model weights are missing', async () => {
    let calledLocalEndpoint = false;
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        calledLocalEndpoint = true;
        sendJson(response, 200, {
          choices: [
            {
              message: {
                content: 'Local loopback output',
              },
            },
          ],
        });
        return;
      }
      sendJson(response, 404, { error: 'not-found' });
    });

    const baseUrl = await listen(server);
    const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    const previousAllowExternal = process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;

    process.env.MONARCH_CHAT_MODEL_ENDPOINT = baseUrl;
    delete process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;

    // Create a catalog with a weak model that is missing weights
    const catalog: MonarchModelCatalog = {
      root: 'test-models',
      exists: true,
      updatedAt: new Date(0).toISOString(),
      models: [
        {
          role: 'weak',
          directoryName: 'weak',
          label: 'Weak model',
          description: 'Weak model description',
          status: 'missing', // weights are missing
          totalSizeBytes: 0,
          totalSize: '0 B',
          primaryAsset: undefined, // no primary asset
          assets: [],
        },
      ],
    };

    try {
      const result = await completeWithModelRole(catalog, {
        role: 'weak',
        messages: [{ role: 'user', content: 'hello local loopback' }],
        maxTokens: 32,
      });

      expect(result.ok).toBe(true);
      expect(result.adapter).toBe('transformers-compatible');
      expect(result.rawText).toBe('Local loopback output');
      expect(calledLocalEndpoint).toBe(true);
    } finally {
      await close(server);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
      restoreEnv('MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS', previousAllowExternal);
    }
  });
});

function createCatalog(): MonarchModelCatalog {
  return {
    root: 'test-models',
    exists: true,
    updatedAt: new Date(0).toISOString(),
    models: [
      model('router', 'Router model', 'systemrouter'),
      model('weak', 'Weak chat model', 'weak'),
      model('medium', 'Medium chat model', 'medium'),
      model('powerful', 'Powerful chat model', 'powerful'),
      model('vision', 'Gemma vision model', 'GEMMA'),
    ],
  };
}

function model(role: MonarchModelRole, label: string, directoryName: string): MonarchModelEntry {
  return {
    role,
    directoryName,
    label,
    description: label,
    status: 'available',
    totalSizeBytes: 1,
    totalSize: '1 B',
    primaryAsset: {
      name: 'model.gguf',
      relativePath: 'model.gguf',
      kind: 'gguf',
      sizeBytes: 1,
    },
    assets: [],
  };
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
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

async function runDirectStreamingCompletion(chunks: string[]): Promise<{
  result: Awaited<ReturnType<typeof completeWithModelRole>>;
  tokens: string[];
}> {
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        chunks.forEach((chunk) => response.write(chunk));
        response.end();
      });
      return;
    }
    sendJson(response, 404, { error: 'not-found' });
  });
  const baseUrl = await listen(server);
  const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
  const previousAllowExternal = process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;
  process.env.MONARCH_CHAT_MODEL_ENDPOINT = baseUrl;
  delete process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;
  const tokens: string[] = [];

  try {
    const result = await completeWithModelRole(createCatalog(), {
      role: 'weak',
      fallbackRoles: [],
      messages: [{ role: 'user', content: 'direct streaming contract probe' }],
      maxTokens: 32,
      onToken: (token) => tokens.push(token),
    });
    return { result, tokens };
  } finally {
    await close(server);
    restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousChatEndpoint);
    restoreEnv('MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS', previousAllowExternal);
  }
}

function restoreEnv(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previousValue;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}
