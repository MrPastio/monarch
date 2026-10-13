import { describe, expect, it, vi } from 'vitest';
import { AstraGroqMaxProvider, AstraMaxProviderError } from '../../src/agent-v3/groq-max-provider';
import {
  ASTRA_MAX_FIRST_USE_DISCLOSURE,
  ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
  astraMaxInputDigest,
  type AstraMaxProposalRequestV1,
} from '../../src/agent-v3/max-provider-contract';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const KEY = 'gsk_fixture_only_12345678901234567890';
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['answer', 'clarify'] },
    text: { type: 'string', minLength: 1, maxLength: 4000 },
  },
  required: ['decision', 'text'],
} as const;

function request(overrides: Partial<AstraMaxProposalRequestV1> = {}): AstraMaxProposalRequestV1 {
  return {
    requestId: 'request_1',
    executionId: 'execution_1',
    modelId: 'openai/gpt-oss-120b',
    reasoningEffort: 'high',
    maxCompletionTokens: 2048,
    messages: [{ role: 'user', content: 'Проверь план и верни только proposal.' }],
    responseSchema: RESPONSE_SCHEMA,
    consent: {
      agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
      providerId: 'groq',
      acceptedAt: '2026-09-04T11:59:00.000Z',
      nonLocalProcessingAcknowledged: true,
      selectedContextAcknowledged: true,
      providerTermsAcknowledged: true,
    },
    ...overrides,
  };
}

function completion(content: unknown, status = 200, finishReason: 'stop' | 'length' = 'stop'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finishReason }],
  }), { status, headers: { 'content-type': 'application/json' } });
}

function safety(decision: 'allow' | 'block' = 'allow'): Response {
  return completion({ decision, reasonCode: decision === 'allow' ? 'allowed' : 'policy-block', summary: decision });
}

function provider(fetchFn: typeof fetch, resolveApiKey = vi.fn(async () => KEY)) {
  return { client: new AstraGroqMaxProvider({ deployment: 'isolated-validation', fetch: fetchFn, resolveApiKey, now: () => NOW }), resolveApiKey };
}

it('retains stage and a closed JSON failure code but never echoes provider error bodies', async () => {
  const fetchFn = vi.fn().mockResolvedValueOnce(safety()).mockResolvedValueOnce(new Response(JSON.stringify({
    error: { code: 'json_validate_failed', message: 'PRIVATE_ERROR_SENTINEL', failed_generation: 'PRIVATE_GENERATION_SENTINEL' },
  }), { status: 400, headers: { 'content-type': 'application/json' } }));
  const { client } = provider(fetchFn);
  await expect(client.propose(request())).rejects.toMatchObject({ code: 'primary-json-validation-failed', statusCode: 400,
    message: 'astra-max-provider:primary-json-validation-failed' });
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

describe('AstraGroqMaxProvider', () => {
  it('publishes a fixed default-off provider surface and simple first-use disclosure', () => {
    const { client } = provider(vi.fn() as unknown as typeof fetch);
    expect(client.descriptor()).toEqual({
      providerId: 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      primaryModels: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
      safetyModel: 'openai/gpt-oss-safeguard-20b',
      authority: 'none',
      tools: 'disabled',
      productActivation: false,
    });
    expect(ASTRA_MAX_FIRST_USE_DISCLOSURE.title).toBe('MAX использует облако');
    expect(ASTRA_MAX_FIRST_USE_DISCLOSURE.checks).toHaveLength(3);
  });

  it('blocks missing or stale consent before resolving a key or touching the network', async () => {
    const fetchFn = vi.fn();
    const key = vi.fn(async () => KEY);
    const { client } = provider(fetchFn as unknown as typeof fetch, key);
    const invalid = request({ consent: { ...request().consent, agreementVersion: 'old' as never } });
    await expect(client.propose(invalid)).rejects.toMatchObject<AstraMaxProviderError>({ code: 'consent-required' });
    expect(key).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects an over-envelope context before resolving a key or touching the network', async () => {
    const fetchFn = vi.fn();
    const key = vi.fn(async () => KEY);
    const { client } = provider(fetchFn as unknown as typeof fetch, key);
    await expect(client.propose(request({ messages: [{ role: 'user', content: 'x'.repeat(128 * 1024 + 1) }] })))
      .rejects.toMatchObject({ code: 'input-budget' });
    expect(key).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('runs pre-safety, one authority-free primary proposal and post-safety on the fixed endpoint', async () => {
    const bodies: Record<string, any>[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      bodies.push(body);
      expect(JSON.stringify(body)).not.toContain(KEY);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBe('none');
      if (body.model === 'openai/gpt-oss-safeguard-20b') return safety();
      return completion({ decision: 'answer', text: 'План готов.' });
    });
    const key = vi.fn(async () => KEY);
    const { client } = provider(fetchFn as unknown as typeof fetch, key);
    const result = await client.propose(request());

    expect(key).toHaveBeenCalledTimes(1);
    expect(bodies.map(body => body.model)).toEqual([
      'openai/gpt-oss-safeguard-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-safeguard-20b',
    ]);
    expect(bodies[0]?.response_format.json_schema.strict).toBe(false);
    expect(bodies[1]?.response_format.json_schema.strict).toBe(true);
    expect(result).toMatchObject({
      authority: 'none', providerId: 'groq', modelId: 'openai/gpt-oss-120b',
      safetyModelId: 'openai/gpt-oss-safeguard-20b', requestId: 'request_1', executionId: 'execution_1',
      finishReason: 'stop', value: { decision: 'answer', text: 'План готов.' },
    });
    expect(result.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    expect(astraMaxInputDigest(request({ requestId: 'request_2' }))).not.toBe(result.inputDigest);
  });

  it('uses the admitted Qwen identity and reasoning profile without enabling tools', async () => {
    const bodies: Record<string, any>[] = [];
    const { client } = provider(vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      bodies.push(body);
      return body.model === 'openai/gpt-oss-safeguard-20b' ? safety()
        : completion({ decision: 'answer', text: 'Qwen proposal.' });
    }) as unknown as typeof fetch);

    await expect(client.propose(request({ modelId: 'qwen/qwen3.8-27b', reasoningEffort: 'high' })))
      .resolves.toMatchObject({ modelId: 'qwen/qwen3.8-27b', value: { decision: 'answer', text: 'Qwen proposal.' } });
    expect(bodies[1]).toMatchObject({ model: 'qwen/qwen3.8-27b', reasoning_effort: 'high',
      reasoning_format: 'hidden', temperature: 1, top_p: 0.95, tool_choice: 'none', parallel_tool_calls: false,
      response_format: { type: 'json_schema', json_schema: { strict: true } } });
    expect(bodies[1]).not.toHaveProperty('top_k');
    expect(bodies[1]).not.toHaveProperty('min_p');
    expect(bodies[1]?.tools).toBeUndefined();
  });

  it('sends bounded Qwen images as native image parts while safety receives no base64 payload', async () => {
    const imageBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');
    const imageUrl = `data:image/png;base64,${imageBase64}`;
    const bodies: Record<string, any>[] = [];
    const { client } = provider(vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      bodies.push(body);
      return body.model === 'openai/gpt-oss-safeguard-20b' ? safety()
        : completion({ decision: 'answer', text: 'На изображении открыт редактор кода.' });
    }) as unknown as typeof fetch);
    const messages = [{ role: 'user' as const, content: [
      { type: 'text' as const, text: 'Опиши изображение.' },
      { type: 'image_url' as const, image_url: { url: imageUrl } },
    ] }];

    await expect(client.propose(request({ modelId: 'qwen/qwen3.8-27b', messages })))
      .resolves.toMatchObject({ modelId: 'qwen/qwen3.8-27b' });
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[0])).not.toContain(imageBase64);
    expect(bodies[1]?.messages).toEqual(messages);
    expect(bodies[1]?.tool_choice).toBe('none');
    await expect(client.propose(request({ messages }))).rejects.toMatchObject({ code: 'image-model-unavailable' });
    expect(bodies).toHaveLength(3);
  });

  it.each([
    ['openai/gpt-oss-120b', 65_536],
    ['qwen/qwen3.8-27b', 16_384],
  ] as const)('admits %s at its exact output ceiling and rejects one token above it', async (modelId, ceiling) => {
    const bodies: Record<string, any>[] = [];
    const { client } = provider(vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      bodies.push(body);
      return body.model === 'openai/gpt-oss-safeguard-20b' ? safety()
        : completion({ decision: 'answer', text: 'Bounded.' });
    }) as unknown as typeof fetch);
    await expect(client.propose(request({ modelId, maxCompletionTokens: ceiling })))
      .resolves.toMatchObject({ modelId });
    expect(bodies[1]?.max_completion_tokens).toBe(ceiling);
    await expect(client.propose(request({ modelId, maxCompletionTokens: ceiling + 1 })))
      .rejects.toMatchObject({ code: 'output-budget' });
  });

  it('adapts an Astra root oneOf to a closed Groq transport envelope and revalidates the original decision', async () => {
    const union = {
      oneOf: [
        { type: 'object', additionalProperties: false, properties: { kind: { const: 'create' }, content: { type: 'string' } },
          required: ['kind', 'content'] },
        { type: 'object', additionalProperties: false, properties: { kind: { const: 'ask-user' }, question: { type: 'string' } },
          required: ['kind', 'question'] },
      ],
    } as const;
    const bodies: Record<string, any>[] = [];
    const { client } = provider(vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      bodies.push(body);
      return body.model === 'openai/gpt-oss-safeguard-20b' ? safety()
        : completion({ proposal: { kind: 'create', content: 'draft' } });
    }) as unknown as typeof fetch);

    await expect(client.propose(request({ responseSchema: union }))).resolves.toMatchObject({
      value: { kind: 'create', content: 'draft' }, authority: 'none',
    });
    const transport = bodies[1]?.response_format.json_schema.schema;
    expect(transport).toMatchObject({ type: 'object', additionalProperties: false, required: ['proposal'],
      properties: { proposal: { anyOf: [
        { properties: { kind: { enum: ['create'] } } },
        { properties: { kind: { enum: ['ask-user'] } } },
      ] } } });
    expect(JSON.stringify(transport)).not.toContain('oneOf');
    expect(JSON.stringify(transport)).not.toContain('"const"');
  });

  it('rejects a malformed union transport envelope before post-safety', async () => {
    const union = { oneOf: [
      { type: 'object', additionalProperties: false, properties: { kind: { const: 'create' } }, required: ['kind'] },
      { type: 'object', additionalProperties: false, properties: { kind: { const: 'ask-user' } }, required: ['kind'] },
    ] } as const;
    let calls = 0;
    const { client } = provider(vi.fn(async () => {
      calls++;
      return calls === 1 ? safety() : completion({ kind: 'create' });
    }) as unknown as typeof fetch);
    await expect(client.propose(request({ responseSchema: union })))
      .rejects.toMatchObject({ code: 'proposal-transport-schema' });
    expect(calls).toBe(2);
  });

  it('keeps the original oneOf as final authority when the Groq anyOf transport is wider', async () => {
    const overlapping = { oneOf: [
      { type: 'object', additionalProperties: false, properties: { kind: { const: 'same' } }, required: ['kind'] },
      { type: 'object', additionalProperties: false, properties: { kind: { enum: ['same'] } }, required: ['kind'] },
    ] } as const;
    let calls = 0;
    const { client } = provider(vi.fn(async () => {
      calls++;
      return calls === 1 ? safety() : completion({ proposal: { kind: 'same' } });
    }) as unknown as typeof fetch);
    await expect(client.propose(request({ responseSchema: overlapping })))
      .rejects.toMatchObject({ code: 'proposal-schema' });
    expect(calls).toBe(2);
  });

  it('fails closed when the safety stage blocks input or output', async () => {
    const inputBlocked = provider(vi.fn(async () => safety('block')) as unknown as typeof fetch);
    await expect(inputBlocked.client.propose(request())).rejects.toMatchObject({ code: 'safety-blocked-input', statusCode: 403 });

    let calls = 0;
    const outputBlocked = provider(vi.fn(async () => {
      calls++;
      if (calls === 1) return safety();
      if (calls === 2) return completion({ decision: 'answer', text: 'Не выдавать.' });
      return safety('block');
    }) as unknown as typeof fetch);
    await expect(outputBlocked.client.propose(request())).rejects.toMatchObject({ code: 'safety-blocked-output', statusCode: 403 });
    expect(calls).toBe(3);
  });

  it('rejects malformed or schema-invalid provider output without a post-safety call', async () => {
    let calls = 0;
    const { client } = provider(vi.fn(async () => {
      calls++;
      return calls === 1 ? safety() : completion({ decision: 'answer', text: 42 });
    }) as unknown as typeof fetch);
    await expect(client.propose(request())).rejects.toMatchObject({ code: 'proposal-schema' });
    expect(calls).toBe(2);
  });

  it('rejects non-strict schemas, unsupported models and invalid keys before provider work can escape', async () => {
    const fetchFn = vi.fn();
    const { client } = provider(fetchFn as unknown as typeof fetch);
    await expect(client.propose(request({ responseSchema: {
      type: 'object', properties: { text: { type: 'string' } }, required: ['text'],
    } }))).rejects.toMatchObject({ code: 'response-schema-strict-object' });
    await expect(client.propose(request({ responseSchema: { type: 'string' } })))
      .rejects.toMatchObject({ code: 'response-schema-root' });
    await expect(client.propose(request({ modelId: 'openai/gpt-oss-20b' as never })))
      .rejects.toMatchObject({ code: 'model-not-allowed' });
    expect(fetchFn).not.toHaveBeenCalled();

    const badKey = provider(fetchFn as unknown as typeof fetch, vi.fn(async () => 'short'));
    await expect(badKey.client.propose(request())).rejects.toMatchObject({ code: 'credential-invalid' });
    expect(fetchFn).not.toHaveBeenCalled();

    const unavailableKey = provider(fetchFn as unknown as typeof fetch, vi.fn(async () => { throw new Error(`leak:${KEY}`); }));
    let keyError: unknown;
    try { await unavailableKey.client.propose(request()); } catch (caught) { keyError = caught; }
    expect(keyError).toMatchObject({ code: 'credential-unavailable' });
    expect(String(keyError)).not.toContain(KEY);
  });

  it('rejects a token-limit finish even when the returned JSON happens to validate', async () => {
    let calls = 0;
    const { client } = provider(vi.fn(async () => {
      calls++;
      return calls === 1 ? safety() : completion({ decision: 'answer', text: 'Обрыв.' }, 200, 'length');
    }) as unknown as typeof fetch);
    await expect(client.propose(request())).rejects.toMatchObject({ code: 'provider-output-truncated', statusCode: 502 });
    expect(calls).toBe(2);
  });

  it('maps provider failures to bounded errors and never returns provider bodies or the key', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: `leak:${KEY}` } }), {
      status: 429, headers: { 'content-type': 'application/json' },
    }));
    const { client } = provider(fetchFn as unknown as typeof fetch);
    let error: unknown;
    try { await client.propose(request()); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'provider-rate-limited', statusCode: 429 });
    expect(String(error)).not.toContain(KEY);
  });

  it('waits the provider-named retry-after on a per-minute limit and then completes', async () => {
    const limited = () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: `leak:${KEY}` } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' } });
    const fetchFn = vi.fn().mockResolvedValueOnce(safety()).mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(completion({ decision: 'answer', text: 'Готово.' })).mockResolvedValueOnce(safety());
    const sleep = vi.fn(async () => undefined);
    const client = new AstraGroqMaxProvider({ deployment: 'isolated-validation', fetch: fetchFn as unknown as typeof fetch,
      resolveApiKey: async () => KEY, now: () => NOW, sleep });
    await expect(client.propose(request())).resolves.toMatchObject({ value: { decision: 'answer', text: 'Готово.' } });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe(5000);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('does not wait out a long or unnamed limit, and bounds how often it retries', async () => {
    for (const retryAfter of [undefined, '3600', 'soon']) {
      const sleep = vi.fn(async () => undefined);
      const fetchFn = vi.fn(async () => new Response('{}', { status: 429, headers: {
        'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) } }));
      const client = new AstraGroqMaxProvider({ deployment: 'isolated-validation', fetch: fetchFn as unknown as typeof fetch,
        resolveApiKey: async () => KEY, now: () => NOW, sleep });
      await expect(client.propose(request())).rejects.toMatchObject({ code: 'provider-rate-limited', statusCode: 429 });
      expect(sleep).not.toHaveBeenCalled(); expect(fetchFn).toHaveBeenCalledTimes(1);
    }
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => new Response('{}', { status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '1' } }));
    const client = new AstraGroqMaxProvider({ deployment: 'isolated-validation', fetch: fetchFn as unknown as typeof fetch,
      resolveApiKey: async () => KEY, now: () => NOW, sleep });
    await expect(client.propose(request())).rejects.toMatchObject({ code: 'provider-rate-limited', statusCode: 429 });
    expect(sleep).toHaveBeenCalledTimes(8); expect(fetchFn).toHaveBeenCalledTimes(9);
  });

  it('stops a rate-limit wait when the caller cancels', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => new Response('{}', { status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' } }));
    const client = new AstraGroqMaxProvider({ deployment: 'isolated-validation', fetch: fetchFn as unknown as typeof fetch,
      resolveApiKey: async () => KEY, now: () => NOW });
    const pending = client.propose(request(), controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'caller-cancelled' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects tool calls even if a provider also returns valid-looking content', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{
      message: { content: JSON.stringify({ decision: 'allow', reasonCode: 'allowed', summary: 'allow' }), tool_calls: [] },
      finish_reason: 'stop',
    }] }), { headers: { 'content-type': 'application/json' } }));
    const { client } = provider(fetchFn as unknown as typeof fetch);
    await expect(client.propose(request())).rejects.toMatchObject({ code: 'provider-content' });
  });
});
