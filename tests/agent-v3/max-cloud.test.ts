import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { MAX_CLOUD_AGREEMENT, MAX_CLOUD_PROVIDERS, cloudRole, parseCloudRole } from '../../src/agent-v3/max-cloud-catalog';
import { MaxCloudProvider } from '../../src/agent-v3/max-cloud-provider';
import { MaxCloudHost } from '../../src/agent-v3/max-cloud-host';
import { AstraMaxSettingsStore } from '../../src/agent-v3/max-settings-store';
import { AstraMaxHostService } from '../../src/agent-v3/max-host-service';
import { completeMaxNative } from '../../src/agent-v3/max-native-completion';
import { requestMaxNative } from '../../src/agent-v3/max-native-client';
import { normalizeMonarchModelRoleAlias } from '../../src/modules/models/model-catalog';
import { startAstraMaxNativeServer } from '../../desktop/electron/astra-max-native-server.mjs';

const key = 'synthetic-key-never-a-real-secret-123';
const schema = { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] };
function reply(value: unknown, anthropic = false, finish = 'stop') {
  return new Response(JSON.stringify(anthropic ? { stop_reason: finish === 'stop' ? 'end_turn' : 'max_tokens', content: [{ type: 'text', text: JSON.stringify(value) }] }
    : { choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }] }));
}
describe('MAX provider transport and exact ownership', () => {
  it.each(MAX_CLOUD_PROVIDERS.filter(p => p.id !== 'groq'))('$name screens both sides using only its own endpoint and key', async provider => {
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (url: any, init: any) => {
      expect(String(url).startsWith(provider.base + '/')).toBe(true);
      expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(init.headers)).toContain(key);
      const body = JSON.parse(init.body); bodies.push(body);
      expect(body.tools).toBeUndefined(); expect(body.model).toBe(provider.model);
      const safety = JSON.stringify(body).includes('safety classification stage for Monarch MAX');
      return reply(safety ? { decision: 'allow' } : { text: 'Привет' }, provider.format === 'anthropic');
    });
    const result = await new MaxCloudProvider({ providerId: provider.id, model: provider.model, apiKey: key, fetch: fetchFn }).propose([{ role: 'user', content: 'Привет' }], schema, 2048);
    expect(result).toEqual({ text: 'Привет' }); expect(bodies).toHaveLength(3);
    if (provider.id === 'openrouter') expect(bodies[1].provider).toEqual({ require_parameters: true, allow_fallbacks: false });
  });
  it.each([
    ['stealth/space-bunny-alpha', ['response_format', 'max_tokens'], { type: 'json_object' }],
    ['openai/gpt-4.1-mini', ['response_format', 'structured_outputs'], 'json_schema'],
    ['vendor/plain-model', ['max_tokens'], undefined],
  ])('OpenRouter %s gets only the JSON mode its endpoints declare', async (model, parameters, expected) => {
    const bodies: any[] = []; const urls: string[] = [];
    const fetchFn = vi.fn(async (url: any, init: any) => {
      urls.push(String(url));
      if (init.method === 'GET') return new Response(JSON.stringify({ data: { endpoints: [{ supported_parameters: parameters }] } }));
      bodies.push(JSON.parse(init.body)); return reply({ ok: true });
    });
    const provider = new MaxCloudProvider({ providerId: 'openrouter', model, apiKey: key, fetch: fetchFn });
    await provider.verify(); await provider.verify();
    expect(urls[0]).toBe('https://openrouter.ai/api/v1/models/' + model + '/endpoints');
    expect(urls.filter(url => url.endsWith('/endpoints'))).toHaveLength(1);
    const format = bodies[0].response_format;
    if (expected === 'json_schema') expect(format.type).toBe('json_schema'); else expect(format).toEqual(expected);
    expect(bodies[0].provider).toEqual({ require_parameters: true, allow_fallbacks: false });
  });
  it.each([['length', 'truncated'], ['tool_calls', 'unexpected-tool-call'], ['content_filter', 'response-rejected'],
    ['error', 'provider-response'], [null, 'provider-finish']])('rejects unfinished or tool-bearing completion %s as %s', async (finish, code) => {
    const fetchFn = vi.fn(async () => reply({ text: 'partial' }, false, finish as string));
    await expect(new MaxCloudProvider({ providerId: 'openai', model: 'gpt-4.1', apiKey: key, fetch: fetchFn }).verify()).rejects.toThrow('astra-max-cloud:' + code);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('sends no sampling temperature to OpenAI reasoning models, including later GPT generations', async () => {
    // Live: OpenAI gpt-6-luna answered the classifier's temperature 0 with 400
    // on every Coder task ("Сервис MAX не принял этот запрос").
    for (const [providerId, model] of [['openai', 'gpt-6-luna'], ['openai', 'gpt-5-mini'], ['openai', 'o4-mini'], ['openrouter', 'openai/gpt-6-luna']] as const) {
      const bodies: any[] = [];
      const fetchFn = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body); bodies.push(body);
        return reply(JSON.stringify(body).includes('safety classification stage') ? { decision: 'allow' } : { text: 'ок' });
      });
      await new MaxCloudProvider({ providerId, model, apiKey: key, fetch: fetchFn }).propose([{ role: 'user', content: 'привет' }], schema, 2048);
      expect(bodies.map(body => 'temperature' in body)).toEqual([false, false, false]);
    }
    const bodies: any[] = [];
    await new MaxCloudProvider({ providerId: 'openai', model: 'gpt-4.1', apiKey: key, fetch: vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body); bodies.push(body);
      return reply(JSON.stringify(body).includes('safety classification stage') ? { decision: 'allow' } : { text: 'ок' });
    }) }).propose([{ role: 'user', content: 'привет' }], schema, 2048);
    expect(bodies[0].temperature).toBe(0);
  });
  it('waits out a rate limit the service names instead of failing the call', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (url: any, init: any) => {
      if (String(url).endsWith('/endpoints')) return new Response('{}', { status: 404 });
      calls++;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      return reply(JSON.stringify(JSON.parse(init.body)).includes('safety classification stage') ? { decision: 'allow' } : { text: 'ок' });
    });
    const provider = new MaxCloudProvider({ providerId: 'openrouter', model: 'some/model:free', apiKey: key, fetch: fetchFn });
    await expect(provider.propose([{ role: 'user', content: 'привет' }], schema, 2048)).resolves.toEqual({ text: 'ок' });
    expect(calls).toBe(4);
  });
  it('keeps a long named wait (a daily quota) a failure, and a paid-balance 402 is never retried', async () => {
    const quota = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '86400' } }));
    await expect(new MaxCloudProvider({ providerId: 'openai', model: 'gpt-4.1', apiKey: key, fetch: quota }).verify())
      .rejects.toThrow('astra-max-cloud:rate-limit');
    expect(quota).toHaveBeenCalledTimes(1);
    const balance = vi.fn(async () => new Response('{}', { status: 402 }));
    await expect(new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: balance }).verify())
      .rejects.toThrow('astra-max-cloud:rate-limit');
    expect(balance).toHaveBeenCalledTimes(1);
  });
  it('names the service error identifiers of a refused call, never its message', async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
    try {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: {
        message: 'Unsupported value: temperature does not support 0 with this model. Request text: секрет',
        type: 'invalid_request_error', param: 'temperature', code: 'unsupported_value' } }), { status: 400 }));
      await expect(new MaxCloudProvider({ providerId: 'openai', model: 'gpt-4.1', apiKey: key, fetch: fetchFn }).verify())
        .rejects.toThrow('astra-max-cloud:provider-request-rejected');
    } finally { write.mockRestore(); }
    const entry = lines.map(line => line.trim()).filter(line => line.includes('astra-max-cloud-http')).map(line => JSON.parse(line))[0];
    expect(entry).toMatchObject({ provider: 'openai', status: 400, code: 'provider-request-rejected',
      errorCode: 'unsupported_value', errorType: 'invalid_request_error', errorParam: 'temperature' });
    expect(JSON.stringify(entry)).not.toContain('секрет');
    expect(JSON.stringify(entry)).not.toContain('Unsupported');
  });
  it('asks the safety screen once more when the connection drops during it, and only then', async () => {
    // Live chaos run: a tunnel severed during the output screen threw away an
    // answer that was already written and billed.
    let dropped = 0;
    const flaky = vi.fn(async (_url: any, init: any) => {
      const body = JSON.stringify(JSON.parse(init.body));
      if (!body.includes('safety classification stage')) return reply({ text: 'ок' });
      if (body.includes('\\"stage\\":\\"output\\"') && dropped++ < 1) throw new TypeError('fetch failed');
      return reply({ decision: 'allow' });
    });
    await expect(new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: flaky })
      .propose([{ role: 'user', content: 'x' }], schema, 2048)).resolves.toEqual({ text: 'ок' });
    expect(flaky).toHaveBeenCalledTimes(4);

    // Twice in a row is a failure, and a verdict is never asked again.
    const down = vi.fn(async (_url: any, init: any) => {
      const body = JSON.stringify(JSON.parse(init.body));
      if (!body.includes('safety classification stage')) return reply({ text: 'ок' });
      if (body.includes('\\"stage\\":\\"output\\"')) throw new TypeError('fetch failed');
      return reply({ decision: 'allow' });
    });
    await expect(new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: down })
      .propose([{ role: 'user', content: 'x' }], schema, 2048)).rejects.toThrow('astra-max-cloud:unavailable');
    expect(down).toHaveBeenCalledTimes(4);
    const blocking = vi.fn(async () => reply({ decision: 'block' }));
    await expect(new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: blocking })
      .propose([{ role: 'user', content: 'x' }], schema, 2048)).rejects.toThrow('safety-blocked');
    expect(blocking).toHaveBeenCalledTimes(1);
  });
  it('blocks before primary inference and never falls back', async () => {
    const fetchFn = vi.fn(async () => reply({ decision: 'block' }));
    await expect(new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: fetchFn })
      .propose([{ role: 'user', content: 'synthetic blocked fixture' }], schema, 2048)).rejects.toThrow('safety-blocked');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('screens deterministically and frames the payload as a whole conversation', async () => {
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body); bodies.push(body);
      return reply(JSON.stringify(body).includes('safety classification stage for Monarch MAX') ? { decision: 'allow' } : { text: 'ок' });
    });
    await new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: fetchFn })
      .propose([{ role: 'system', content: 'Monarch instructions' }, { role: 'user', content: 'ало' }], schema, 2048);
    expect(bodies).toHaveLength(3);
    // Live 2026-09-18: at the provider default temperature the same chat was
    // allowed on one turn and blocked on the next.
    expect(bodies[0].temperature).toBe(0); expect(bodies[2].temperature).toBe(0);
    expect(bodies[1].temperature).toBeUndefined();
    expect(JSON.parse(bodies[0].messages.at(-1).content).stage).toBe('input');
    expect(JSON.parse(bodies[2].messages.at(-1).content).stage).toBe('output');
    expect(bodies[0].messages[1].content).toContain('Profanity');
  });
  it('asks a JSON-mode provider once more after an empty completion, and names the failing call', async () => {
    const entries: any[] = []; let primary = 0;
    const empty = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }));
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      if (JSON.stringify(JSON.parse(init.body)).includes('safety classification stage')) return reply({ decision: 'allow' });
      return ++primary === 1 ? empty() : reply({ text: 'готово' });
    });
    const provider = new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: fetchFn });
    (provider as any).options.diagnostic = (entry: any) => entries.push(entry);
    await expect(provider.propose([{ role: 'user', content: 'продолжи' }], schema, 2048)).resolves.toEqual({ text: 'готово' });
    expect(primary).toBe(2);
    expect(entries).toEqual([{ diagnostic: 'astra-max-cloud-json', provider: 'deepseek', stage: 'primary', code: 'empty-output',
      attempt: 1, maxAttempts: 2, chars: 0, shape: 'empty', retryable: true }]);
  });
  it('does not resend a reply whose field is over its maxLength; the agent repair names the limit', async () => {
    // Live: OpenRouter put a 15-22K-character file into one argsJson; the
    // identical retry failed the same way and cost another ~2.5 minutes.
    const bounded = { type: 'object', additionalProperties: false, properties: { text: { type: 'string', maxLength: 8 } }, required: ['text'] };
    const entries: any[] = []; let primary = 0;
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      if (JSON.stringify(JSON.parse(init.body)).includes('safety classification stage')) return reply({ decision: 'allow' });
      primary++; return reply({ text: 'слишком длинный ответ' });
    });
    const provider = new MaxCloudProvider({ providerId: 'openai', model: 'gpt-4.1', apiKey: key, fetch: fetchFn });
    (provider as any).options.diagnostic = (entry: any) => entries.push(entry);
    await expect(provider.propose([{ role: 'user', content: 'пиши' }], bounded, 2048)).rejects.toThrow('astra-max-cloud:proposal-schema');
    expect(primary).toBe(1);
    expect(entries.find(entry => entry.diagnostic === 'astra-max-cloud-json')).toMatchObject({ attempt: 1, maxAttempts: 1, retryable: false });
  });
  it('retries malformed structured output once for the same stage and never logs the text', async () => {
    const entries: any[] = [];
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'private words' } }] })));
    const provider = new MaxCloudProvider({ providerId: 'openai', model: 'gpt-4.1', apiKey: key, fetch: fetchFn });
    (provider as any).options.diagnostic = (entry: any) => entries.push(entry);
    await expect(provider.verify()).rejects.toThrow('proposal-json');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(entries).toEqual([
      { diagnostic: 'astra-max-cloud-json', provider: 'openai', stage: 'verify', code: 'proposal-json',
        attempt: 1, maxAttempts: 2, chars: 13, shape: 'prose', retryable: true },
      { diagnostic: 'astra-max-cloud-json', provider: 'openai', stage: 'verify', code: 'proposal-json',
        attempt: 2, maxAttempts: 2, chars: 13, shape: 'prose', retryable: false },
    ]);
    expect(JSON.stringify(entries)).not.toContain('private');
  });
  it('rejects invalid schemas and cancellation before spending a request', async () => {
    const fetchFn = vi.fn(); const provider = new MaxCloudProvider({ providerId: 'openai', model: 'gpt-4.1', apiKey: key, fetch: fetchFn });
    await expect(provider.propose([{ role: 'user', content: 'hi' }], { type: 'unknown' }, 2048)).rejects.toThrow('response-schema');
    await expect(provider.verify(AbortSignal.abort())).rejects.toThrow('cancelled'); expect(fetchFn).not.toHaveBeenCalled();
  });
  it('does not leak provider error bodies or keys', async () => {
    const provider = new MaxCloudProvider({ providerId: 'openai', model: 'gpt-4.1', apiKey: key,
      fetch: vi.fn(async () => new Response(key + ' private prompt', { status: 401 })) });
    await expect(provider.verify()).rejects.toThrow('astra-max-cloud:credential-rejected');
  });
  it('preserves case-sensitive models and refuses arbitrary hosts', () => {
    const role = cloudRole('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(parseCloudRole(role)?.model).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(normalizeMonarchModelRoleAlias(role)).toBe(role);
    expect(parseCloudRole('max-cloud:evil:https://evil.invalid')).toBeNull();
  });
  it('keeps encrypted connections separate and old credentials after failed replacement; binds real native transport', async () => {
    // Exact synthetic E: fixture retained as evidence; no user data or production keys.
    const root = await mkdtemp('E:/MonarchArtifacts/max-providers-test-');
    const stores = new Map<string, AstraMaxSettingsStore>();
    const store = (providerId: any) => {
      if (!stores.has(providerId)) stores.set(providerId, new AstraMaxSettingsStore({ deployment: 'isolated-validation', rootPath: root, providerId,
        restrictAccess: async () => true, protectedStorage: { isEncryptionAvailable: () => true,
          encryptString: s => Buffer.from(s).map(b => b ^ 0xa5), decryptString: b => Buffer.from(b).map(x => x ^ 0xa5).toString('utf8') } }));
      return stores.get(providerId)!;
    };
    let reject = false;
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      if (reject) return new Response('private', { status: 401 });
      const body = JSON.parse(init.body);
      return reply(JSON.stringify(body).includes('safety classification stage for Monarch MAX') ? { decision: 'allow' }
        : JSON.stringify(body).includes('Connection check') ? { ok: true } : { text: 'real transport fixture' });
    });
    const groq = new AstraMaxHostService({ deployment: 'isolated-validation', settings: store('groq') });
    const cloud = new MaxCloudHost({ groq, store, fetch: fetchFn });
    const consent = (providerId: any) => ({ providerId, agreementVersion: MAX_CLOUD_AGREEMENT, acceptedAt: new Date().toISOString(),
      nonLocalProcessingAcknowledged: true as const, selectedContextAcknowledged: true as const, providerTermsAcknowledged: true as const });
    await cloud.configure({ providerId: 'openai', modelId: 'gpt-4.1', apiKey: key, consent: consent('openai') });
    await cloud.configure({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: key + '-second', consent: consent('deepseek') });
    expect(JSON.stringify(await cloud.view())).not.toContain(key);
    expect((await readFile(root + '/openai-max.safe')).toString()).not.toContain(key);
    reject = true;
    await expect(cloud.configure({ providerId: 'openai', modelId: 'gpt-4.1', apiKey: key + '-bad', consent: consent('openai') })).rejects.toThrow('credential');
    expect(await store('openai').resolveApiKey()).toBe(key); expect(await store('deepseek').resolveApiKey()).toBe(key + '-second');
    await expect(cloud.configure({ providerId: 'openai', modelId: 'gpt-4.1', apiKey: key, consent: consent('deepseek') })).rejects.toThrow('consent-required');
    reject = false;
    const host = { proposePrepared: vi.fn(), proposeCloud: cloud.propose.bind(cloud) };
    const server = await startAstraMaxNativeServer({ complete: (value: unknown, signal: AbortSignal) => completeMaxNative(host, value, signal) });
    try {
      const result = await requestMaxNative({ role: cloudRole('openai', 'gpt-4.1'), messages: [{ role: 'user', content: 'hi' }] }, undefined,
        { MONARCH_MAX_NATIVE_ENDPOINT: server.endpoint, MONARCH_MAX_NATIVE_TOKEN: server.bearerToken });
      expect(result).toEqual({ text: 'real transport fixture', model: 'gpt-4.1' }); expect(host.proposePrepared).not.toHaveBeenCalled();
      await expect(requestMaxNative({ role: cloudRole('openai', 'other-model'), messages: [{ role: 'user', content: 'hi' }] }, undefined,
        { MONARCH_MAX_NATIVE_ENDPOINT: server.endpoint, MONARCH_MAX_NATIVE_TOKEN: server.bearerToken })).rejects.toThrow('connection-changed');
    } finally { await server.close(); }
  });
  it('changes a stored model without a renderer key and keeps the previous model after a failed check', async () => {
    const root = await mkdtemp('E:/MonarchArtifacts/max-model-update-');
    const stores = new Map<string, AstraMaxSettingsStore>();
    const store = (providerId: any) => {
      if (!stores.has(providerId)) stores.set(providerId, new AstraMaxSettingsStore({ deployment: 'isolated-validation', rootPath: root, providerId,
        restrictAccess: async () => true, protectedStorage: { isEncryptionAvailable: () => true,
          encryptString: s => Buffer.from(s).map(b => b ^ 0xa5), decryptString: b => Buffer.from(b).map(x => x ^ 0xa5).toString('utf8') } }));
      return stores.get(providerId)!;
    };
    let reject = false;
    const fetchFn = vi.fn(async (url: any, init: any) => {
      if (init?.method === 'GET' || !init?.body) {
        return new Response(JSON.stringify({ data: [
          { id: 'gpt-4.1', display_name: 'GPT 4.1' },
          { id: 'gpt-4.1-mini', display_name: 'GPT 4.1 mini' },
        ] }));
      }
      if (reject) return new Response('private', { status: 401 });
      const body = JSON.parse(init.body);
      return reply(JSON.stringify(body).includes('safety classification stage for Monarch MAX') ? { decision: 'allow' }
        : JSON.stringify(body).includes('Connection check') ? { ok: true } : { text: 'updated model fixture' });
    });
    const groq = new AstraMaxHostService({ deployment: 'isolated-validation', settings: store('groq') });
    const cloud = new MaxCloudHost({ groq, store, fetch: fetchFn });
    const consent = { providerId: 'openai' as const, agreementVersion: MAX_CLOUD_AGREEMENT, acceptedAt: new Date().toISOString(),
      nonLocalProcessingAcknowledged: true as const, selectedContextAcknowledged: true as const, providerTermsAcknowledged: true as const };
    await cloud.configure({ providerId: 'openai', modelId: 'gpt-4.1', apiKey: key, consent });
    const catalog = await cloud.storedModels('openai');
    expect(catalog.map(item => item.id).sort()).toEqual(['gpt-4.1', 'gpt-4.1-mini']);
    expect(JSON.stringify(catalog)).not.toContain(key);
    reject = true;
    await expect(cloud.updateModel({ providerId: 'openai', modelId: 'gpt-4.1-mini' })).rejects.toThrow('credential');
    expect((await cloud.view()).find(item => item.id === 'openai')).toMatchObject({ model: 'gpt-4.1', role: cloudRole('openai', 'gpt-4.1') });
    expect(await store('openai').resolveApiKey()).toBe(key);
    reject = false;
    await cloud.updateModel({ providerId: 'openai', modelId: 'gpt-4.1-mini' });
    expect((await cloud.view()).find(item => item.id === 'openai')).toMatchObject({
      model: 'gpt-4.1-mini', role: cloudRole('openai', 'gpt-4.1-mini'),
    });
    await expect(cloud.propose({ role: cloudRole('openai', 'gpt-4.1'), messages: [{ role: 'user', content: 'hi' }],
      responseSchema: schema, maxTokens: 1024 })).rejects.toThrow('connection-changed');
    await expect(cloud.updateModel({ providerId: 'groq', modelId: 'openai/gpt-oss-20b' })).rejects.toThrow('model-retired');
  });
});

function sse(events: unknown[], anthropic = false) {
  const lines = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + (anthropic ? '' : 'data: [DONE]\n\n');
  const bytes = new TextEncoder().encode(lines);
  // Split mid-line so the parser has to join chunks.
  return new Response(new ReadableStream({ start(controller) {
    for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
describe('MAX chat answers stream as they are written', () => {
  const streaming = (block: 'none' | 'output' = 'none', events: unknown[] = [
    { choices: [{ delta: { content: 'При' } }] }, { choices: [{ delta: { content: 'вет, ' } }] },
    { choices: [{ delta: { content: 'мир' }, finish_reason: 'stop' }] }]) => vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (JSON.stringify(body).includes('safety classification stage for Monarch MAX')) {
      const output = JSON.parse(body.messages.at(-1).content).stage === 'output';
      return reply({ decision: output && block === 'output' ? 'block' : 'allow' });
    }
    expect(body.stream).toBe(true); expect(body.response_format).toBeUndefined();
    return sse(events);
  });
  const collect = async (provider: MaxCloudProvider) => {
    const pieces: string[] = [];
    const iterator = provider.streamText([{ role: 'user', content: 'Привет' }], 2048);
    while (true) {
      const next = await iterator.next();
      if (next.done) return { pieces, end: next.value };
      pieces.push(next.value);
    }
  };
  it('releases a short answer only after the output screen allowed it', async () => {
    const fetchFn = streaming();
    const { pieces, end } = await collect(new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: fetchFn }));
    expect(pieces).toEqual(['Привет, мир']);
    expect(end).toEqual({ stopReason: 'stop' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('shows nothing of an answer the output screen blocks', async () => {
    const provider = new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: streaming('output') });
    const shown: string[] = [];
    const run = async () => { for await (const piece of provider.streamText([{ role: 'user', content: 'x' }], 2048)) shown.push(piece); };
    await expect(run()).rejects.toThrow('safety-blocked');
    expect(shown).toEqual([]);
  });
  it('releases the screened first part of a long answer early and the rest after the final screen', async () => {
    const first = 'а'.repeat(620) + '.\n';
    const fetchFn = streaming('none', [{ choices: [{ delta: { content: first } }] },
      { choices: [{ delta: { content: 'хвост' }, finish_reason: 'stop' }] }]);
    const { pieces } = await collect(new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: fetchFn }));
    expect(pieces).toEqual([first, 'хвост']);
    // input screen, answer, early output screen, final output screen
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
  it.each([
    ['a stream that stops without a finish reason', [{ choices: [{ delta: { content: 'Обрыв' } }] }], 'provider-finish'],
    ['an in-band provider error', [{ choices: [{ delta: { content: 'Нача' } }] }, { error: { message: 'overloaded' } }], 'provider-response'],
    ['a filtered answer', [{ choices: [{ delta: { content: 'Част' }, finish_reason: 'content_filter' }] }], 'response-rejected'],
    ['a native tool call', [{ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] }], 'unexpected-tool-call'],
    ['an in-band error finish', [{ choices: [{ delta: { content: 'Нача' }, finish_reason: 'error' }] }], 'provider-response'],
    ['an unknown finish', [{ choices: [{ delta: { content: 'Нача' }, finish_reason: 'other' }] }], 'provider-finish'],
  ])('fails %s instead of calling it a finished answer', async (_label, events, code) => {
    const provider = new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: streaming('none', events) });
    const shown: string[] = [];
    const run = async () => { for await (const piece of provider.streamText([{ role: 'user', content: 'x' }], 2048)) shown.push(piece); };
    await expect(run()).rejects.toThrow(code);
    expect(shown).toEqual([]);
  });
  it('writes the answer while the input screen runs but releases nothing before it allows', async () => {
    let allowInput!: () => void;
    const inputScreened = new Promise<void>(resolve => { allowInput = resolve; });
    const order: string[] = [];
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (JSON.stringify(body).includes('safety classification stage for Monarch MAX')) {
        const stage = JSON.parse(body.messages.at(-1).content).stage;
        order.push('screen-' + stage);
        if (stage === 'input') await inputScreened;
        return reply({ decision: 'allow' });
      }
      order.push('answer');
      return sse([{ choices: [{ delta: { content: 'Готово' }, finish_reason: 'stop' }] }]);
    });
    const provider = new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: fetchFn });
    const shown: string[] = [];
    const run = (async () => { for await (const piece of provider.streamText([{ role: 'user', content: 'x' }], 2048)) shown.push(piece); })();
    await vi.waitFor(() => expect(order).toEqual(['screen-input', 'answer']));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(shown).toEqual([]);
    allowInput();
    await run;
    expect(shown).toEqual(['Готово']);
    expect(order).toEqual(['screen-input', 'answer', 'screen-output']);
  });
  it('stops writing and shows nothing when the input screen blocks', async () => {
    let answerAborted = false;
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (JSON.stringify(body).includes('safety classification stage for Monarch MAX')) {
        await new Promise(resolve => setTimeout(resolve, 20));
        return reply({ decision: 'block' });
      }
      const signal: AbortSignal = init.signal;
      // An answer that keeps streaming until something stops it.
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Нача' } }] }) + '\n\n'));
        signal.addEventListener('abort', () => { answerAborted = true; controller.error(signal.reason); });
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const provider = new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: fetchFn });
    const shown: string[] = [];
    await expect((async () => { for await (const piece of provider.streamText([{ role: 'user', content: 'x' }], 2048)) shown.push(piece); })())
      .rejects.toThrow('safety-blocked');
    expect(shown).toEqual([]);
    expect(answerAborted).toBe(true);
  });
  it('keeps an answer cut at the length limit and says it was cut', async () => {
    const fetchFn = streaming('none', [{ choices: [{ delta: { content: 'Длинный ответ' }, finish_reason: 'length' }] }]);
    const { pieces, end } = await collect(new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, fetch: fetchFn }));
    expect(pieces).toEqual(['Длинный ответ']);
    expect(end).toEqual({ stopReason: 'length' });
  });
  it('reads Anthropic text deltas and rejects its in-band errors', async () => {
    const anthropic = (events: unknown[]) => vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (JSON.stringify(body).includes('safety classification stage for Monarch MAX')) return reply({ decision: 'allow' }, true);
      return sse(events, true);
    });
    const model = MAX_CLOUD_PROVIDERS.find(p => p.id === 'anthropic')!.model;
    const pieces: string[] = [];
    for await (const piece of new MaxCloudProvider({ providerId: 'anthropic', model, apiKey: key, fetch: anthropic([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Да' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }]) })
      .streamText([{ role: 'system', content: 's' }, { role: 'user', content: 'x' }], 2048)) pieces.push(piece);
    expect(pieces).toEqual(['Да']);
    const failing = new MaxCloudProvider({ providerId: 'anthropic', model, apiKey: key, fetch: anthropic([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Да' } }, { type: 'error', error: { type: 'overloaded_error' } }]) });
    await expect((async () => { for await (const _ of failing.streamText([{ role: 'user', content: 'x' }], 2048)) { /* none */ } })())
      .rejects.toThrow('provider-response');
  });
});

describe('MAX answer streams are bounded by silence, not by length', () => {
  /** An SSE body whose parts arrive at the given (fake) times. */
  const timedSse = (parts: Array<{ at: number; text: string }>, signal?: AbortSignal) => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      // Like fetch, an aborted request ends its body.
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      let now = 0;
      for (const part of parts) {
        await new Promise(resolve => setTimeout(resolve, part.at - now)); now = part.at;
        controller.enqueue(new TextEncoder().encode(part.text));
      }
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const provider = (body: (signal?: AbortSignal) => Response) => new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key,
    fetch: vi.fn(async (_url: any, init: any) => JSON.stringify(JSON.parse(init.body)).includes('safety classification stage')
      ? reply({ decision: 'allow' }) : body(init.signal)) });
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  afterEach(() => vi.useRealTimers());

  it('finishes a long answer whose gaps stay short, past the old 180 s total', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const parts = [{ at: 1_000, text: data({ choices: [{ delta: { content: 'Нача' } }] }) }];
    for (let at = 100_000; at <= 500_000; at += 100_000) parts.push({ at, text: ': keep-alive\n\n' });
    parts.push({ at: 560_000, text: data({ choices: [{ delta: { content: 'ло.' }, finish_reason: 'stop' }] }) });
    const iterator = provider(() => timedSse(parts)).streamText([{ role: 'user', content: 'Расскажи' }], 2048);
    const result = (async () => { const pieces: string[] = []; for (;;) { const next = await iterator.next(); if (next.done) return pieces.join(''); pieces.push(next.value); } })();
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(result).resolves.toBe('Начало.');
  });

  it('ends a stream that falls silent with timeout, not as a cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const iterator = provider(signal => timedSse([
      { at: 1_000, text: data({ choices: [{ delta: { content: 'Нача' } }] }) },
      { at: 900_000, text: data({ choices: [{ delta: { content: 'ло' }, finish_reason: 'stop' }] }) },
    ], signal)).streamText([{ role: 'user', content: 'Расскажи' }], 2048);
    const result = iterator.next().then(() => 'finished', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(200_000);
    await expect(result).resolves.toBe('astra-max-cloud:timeout');
  });

  it('finishes a slow agent step past the old 180 s total while the service keeps the stream alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let stepBody: any;
    const step = new MaxCloudProvider({ providerId: 'openrouter', model: 'vendor/free-model:free', apiKey: key,
      fetch: vi.fn(async (url: any, init: any) => {
        if (String(url).endsWith('/endpoints')) return new Response('{}', { status: 404 });
        const body = JSON.parse(init.body);
        if (JSON.stringify(body).includes('safety classification stage')) return reply({ decision: 'allow' });
        stepBody = body;
        return timedSse([{ at: 100_000, text: ': OPENROUTER PROCESSING\n\n' }, { at: 200_000, text: ': OPENROUTER PROCESSING\n\n' },
          { at: 250_000, text: data({ choices: [{ delta: { content: '{"text":' } }] }) },
          { at: 260_000, text: data({ choices: [{ delta: { content: '"готово"}' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' }], init.signal);
      }) });
    const result = step.propose([{ role: 'user', content: 'сделай' }], schema, 2048).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(result).resolves.toEqual({ text: 'готово' });
    expect(stepBody.stream).toBe(true);
  });

  it('ends a silent agent step with timeout, not as a cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = provider(signal => timedSse([{ at: 900_000, text: data({ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }) }], signal))
      .propose([{ role: 'user', content: 'сделай' }], schema, 2048).then(() => 'finished', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(400_000);
    await expect(result).resolves.toBe('astra-max-cloud:timeout');
  });

  it.each([
    ['a native tool call', [{ choices: [{ delta: { tool_calls: [{ index: 0 }] }, finish_reason: 'tool_calls' }] }], 'unexpected-tool-call'],
    ['an in-band provider error', [{ choices: [{ delta: { content: '{"te' } }] }, { error: { message: 'overloaded' } }], 'provider-response'],
    ['a stream without a finish reason', [{ choices: [{ delta: { content: '{"text":"x"}' } }] }], 'provider-finish'],
    ['an answer cut at the limit', [{ choices: [{ delta: { content: '{"text":"x' }, finish_reason: 'length' }] }], 'truncated'],
  ])('fails a streamed agent step with %s', async (_label, events, code) => {
    const step = provider(() => sse(events));
    await expect(step.propose([{ role: 'user', content: 'сделай' }], schema, 2048)).rejects.toThrow('astra-max-cloud:' + code);
  });

  it('reports a connection lost mid-step as unavailable, not as an oversized answer', async () => {
    // Live chaos run: a severed tunnel during the reply came back as output-budget.
    const step = provider(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(data({ choices: [{ delta: { content: '{"te' } }] })));
      setTimeout(() => controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } })), 5);
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    await expect(step.propose([{ role: 'user', content: 'сделай' }], schema, 2048)).rejects.toThrow('astra-max-cloud:unavailable');
  });

  it('folds a streamed Anthropic step and ignores its thinking blocks', async () => {
    const model = MAX_CLOUD_PROVIDERS.find(p => p.id === 'anthropic')!.model;
    const step = new MaxCloudProvider({ providerId: 'anthropic', model, apiKey: key, fetch: vi.fn(async (_url: any, init: any) =>
      JSON.stringify(JSON.parse(init.body)).includes('safety classification stage') ? reply({ decision: 'allow' }, true) : sse([
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'план' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"text":"да"}' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }], true)) });
    await expect(step.propose([{ role: 'user', content: 'сделай' }], schema, 2048)).resolves.toEqual({ text: 'да' });
  });
});
