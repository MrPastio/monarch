import { afterEach, expect, it, vi } from 'vitest';
import { isMaxNativeConfigured, requestMaxNative } from '../../src/agent-v3/max-native-client';
import { completeMaxNative } from '../../src/agent-v3/max-native-completion';
import { startAstraMaxNativeServer } from '../../desktop/electron/astra-max-native-server.mjs';
const request = { role: 'max-gpt-oss-120b', messages: [{ role: 'user' as const, content: 'Synthetic test' }] };
const env = { MONARCH_MAX_NATIVE_ENDPOINT: 'http://127.0.0.1:43199/complete', MONARCH_MAX_NATIVE_TOKEN: 'a'.repeat(64) };
afterEach(() => vi.unstubAllGlobals());
it.each(['{incomplete', 'null', '[]', '42'])('normalizes malformed response %s without exposing body text', async body => {
 const fetcher = vi.fn(async () => new Response(body)); vi.stubGlobal('fetch', fetcher);
 await expect(requestMaxNative(request, undefined, env)).rejects.toThrow('astra-max-native:response-invalid'); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('normalizes a body-stream failure after successful headers', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(Error('synthetic-private-error')); } }))));
 await expect(requestMaxNative(request, undefined, env)).rejects.toThrow('astra-max-native:response-interrupted');
});
it('cancellation after headers cannot return even a complete valid response', async () => {
 const controller = new AbortController();
 vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return Response.json({ text: 'late result', model: 'openai/gpt-oss-120b' }); }));
 await expect(requestMaxNative(request, controller.signal, env)).rejects.toThrow('astra-max-native:cancelled');
});
it('releases a response reader on an oversized reply', async () => {
 const cancel = vi.fn();vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4*1024*1024+1)); }, cancel }))));
 await expect(requestMaxNative(request, undefined, env)).rejects.toThrow('output-budget');expect(cancel).toHaveBeenCalledTimes(1);
});
it('does not dispatch after Stop and rejects completion from an abort-ignoring host', async () => {
 const proposePrepared = vi.fn(); await expect(completeMaxNative({ proposePrepared }, request, AbortSignal.abort())).rejects.toThrow('cancelled'); expect(proposePrepared).not.toHaveBeenCalled();
 const controller = new AbortController(); proposePrepared.mockImplementation(async () => { controller.abort(); return { value: { text: 'late' }, modelId: 'openai/gpt-oss-120b' }; });
 await expect(completeMaxNative({ proposePrepared }, request, controller.signal)).rejects.toThrow('cancelled');
});
it('withholds arbitrary provider error strings even when they resemble valid codes', async () => {
 const server = await startAstraMaxNativeServer({ complete: async () => { throw Error('synthetic-secret-like-value'); } });
 try { await expect(requestMaxNative(request, undefined, { MONARCH_MAX_NATIVE_ENDPOINT: server.endpoint, MONARCH_MAX_NATIVE_TOKEN: server.bearerToken })).rejects.toThrow('astra-max-native:unavailable'); }
 finally { await server.close(); }
});
it.each([
 ['astra-max-provider:primary-context-too-large', 'context-too-large'],
 ['astra-max-provider:safety-input-json-validation-failed', 'json-validation-failed'],
 ['astra-max-provider:primary-provider-request-rejected', 'provider-request-rejected'],
 ['astra-max-provider:primary-synthetic-secret-like-value', 'unavailable'],
])('keeps the public cause of a stage-prefixed provider failure %s', async (thrown, code) => {
 // Live 2026-09-27: a rejected Groq call reached the chat only as "unavailable".
 const server = await startAstraMaxNativeServer({ complete: async () => { throw Error(thrown); } });
 try { await expect(requestMaxNative(request, undefined, { MONARCH_MAX_NATIVE_ENDPOINT: server.endpoint, MONARCH_MAX_NATIVE_TOKEN: server.bearerToken })).rejects.toThrow('astra-max-native:' + code); }
 finally { await server.close(); }
});
it('times out a stalled host promptly while retaining its occupied slot until it settles', async () => {
 const settle: (() => void)[] = [];
 const complete = vi.fn(() => new Promise(resolve => settle.push(() => resolve({ text: 'late', model: 'openai/gpt-oss-120b' }))));
 const server = await startAstraMaxNativeServer({ complete, requestTimeoutMs: 40 });
 const hostEnv = { MONARCH_MAX_NATIVE_ENDPOINT: server.endpoint, MONARCH_MAX_NATIVE_TOKEN: server.bearerToken };
 try {
  await expect(requestMaxNative(request, undefined, hostEnv)).rejects.toThrow('provider-timeout');
  await expect(requestMaxNative(request, undefined, hostEnv)).rejects.toThrow('provider-timeout');
  await expect(requestMaxNative(request, undefined, hostEnv)).rejects.toThrow('busy'); expect(complete).toHaveBeenCalledTimes(2);
 } finally { settle.forEach(done => done()); await server.close(); }
});

it('reports whether the selected MAX provider is ready, and nothing else', async () => {
 let ready = false;
 const server = await startAstraMaxNativeServer({ complete: async () => ({ text: 'x', model: 'openai/gpt-oss-120b' }),
  status: async () => ready });
 const hostEnv = { MONARCH_MAX_NATIVE_ENDPOINT: server.endpoint, MONARCH_MAX_NATIVE_TOKEN: server.bearerToken };
 try {
  await expect(isMaxNativeConfigured(undefined, hostEnv)).resolves.toBe(false);
  ready = true; await expect(isMaxNativeConfigured(undefined, hostEnv)).resolves.toBe(true);
  // A wrong token or a missing capability never reads as ready.
  await expect(isMaxNativeConfigured(undefined, { ...hostEnv, MONARCH_MAX_NATIVE_TOKEN: 'b'.repeat(64) })).resolves.toBe(false);
  await expect(isMaxNativeConfigured(undefined, {})).resolves.toBe(false);
 } finally { await server.close(); }
});
