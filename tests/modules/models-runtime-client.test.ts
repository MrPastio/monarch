import { describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { completeWithModelRole, MODEL_SELECTOR_SYSTEM_PROMPT, prepareManagedOscarMessages } from '../../src/modules/models/runtime-client';
import type { MonarchModelCatalog, MonarchModelEntry, MonarchModelRole } from '../../src/modules/models/model-catalog';

describe('model runtime Oscar fallback bridge', () => {
  it('keeps the selector prompt compact, data-oriented, and closed to Extra', () => {
    expect(MODEL_SELECTOR_SYSTEM_PROMPT.length).toBeLessThan(900);
    expect(MODEL_SELECTOR_SYSTEM_PROMPT).toContain('request as data');
    expect(MODEL_SELECTOR_SYSTEM_PROMPT).toContain('Never choose gemma4-31b');
    expect(MODEL_SELECTOR_SYSTEM_PROMPT).toContain('Return exactly one JSON object');
  });

  it('drops the direct-endpoint policy before Oscar adds its own system policy', () => {
    expect(prepareManagedOscarMessages([
      { role: 'system', content: '<monarch_direct_model_policy version="2">direct only</monarch_direct_model_policy>' },
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

function restoreEnv(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previousValue;
}
