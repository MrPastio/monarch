import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAstraMaxModelServer } from '../../desktop/electron/astra-max-model-server.mjs';
import { astraJournalJson, type AstraJson } from '../../src/agent-v3/journal';
import { AstraMaxPreparedModelHost } from '../../src/agent-v3/max-prepared-model-host';
import { ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, astraMaxInputDigest, astraMaxOutputDigest,
  type AstraMaxProposalRequestV1 } from '../../src/agent-v3/max-provider-contract';
import { AstraPreparedModelClient } from '../../src/agent-v3/prepared-model-client';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

function host(options: { wait?: (signal: AbortSignal | undefined) => Promise<void>;
  signal?: (value: AbortSignal | undefined) => void } = {}) {
  const consent = { agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, providerId: 'groq' as const,
    acceptedAt: '2026-09-04T11:59:00.000Z', nonLocalProcessingAcknowledged: true as const,
    selectedContextAcknowledged: true as const, providerTermsAcknowledged: true as const };
  const proposePrepared = vi.fn(async (input: Omit<AstraMaxProposalRequestV1, 'consent'> & { signal?: AbortSignal }) => {
    options.signal?.(input.signal);
    await options.wait?.(input.signal);
    const { signal: _signal, ...prepared } = input;
    const request = { ...prepared, consent } as AstraMaxProposalRequestV1;
    const value = { kind: 'request-completion' } as AstraJson;
    return { authority: 'none' as const, providerId: 'groq' as const, modelId: request.modelId,
      safetyModelId: 'openai/gpt-oss-safeguard-20b' as const, requestId: request.requestId,
      executionId: request.executionId, inputDigest: astraMaxInputDigest(request), outputDigest: astraMaxOutputDigest(value),
      finishReason: 'stop' as const, value };
  });
  return { proposePrepared, value: new AstraMaxPreparedModelHost({ deployment: 'isolated-validation',
    modelId: 'openai/gpt-oss-120b', provider: { proposePrepared }, hostGeneration: 'max_http_fixture', now: () => NOW }) };
}

describe('Astra MAX authenticated prepared-model loopback', () => {
  it('serves the existing strict client without exposing the provider key or an execution port', async () => {
    const prepared = host();
    const server = await startAstraMaxModelServer({ mode: 'source-preview-v1', host: prepared.value });
    servers.push(server);
    expect(server.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(server.bearerToken).toMatch(/^[\x21-\x7e]{32,4096}$/u);
    const client = new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: server.endpoint,
      bearerToken: server.bearerToken, hostGeneration: server.hostGeneration, timeoutMs: 5_000 });
    const responseSchema = { type: 'object', additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['request-completion'] } }, required: ['kind'] } as AstraJson;
    const request = { requestId: 'http_request', executionId: 'http_execution', expectedModelDigest: server.modelDigest,
      responseSchema, maxOutputTokens: 256, timeoutMs: 5_000, notAfterMs: NOW + 5_000 };
    const turn = await client.open(request);
    const surface = astraJournalJson({ mandatory: [{ kind: 'goal', text: 'Return a bounded proposal.' }] });
    const seal = await client.prepare(turn.turnId, surface);
    const output = await client.generate(seal);
    expect(JSON.parse(output.text)).toEqual({ kind: 'request-completion' });
    expect(await client.inspect(turn.turnId)).toMatchObject({ state: 'generated', authority: 'none', slotReserved: false });
    expect(await client.settleRequest(request)).toMatchObject({ state: 'generated', quiescent: true,
      output: { text: output.text } });
    expect(prepared.proposePrepared).toHaveBeenCalledTimes(1);
    expect(server.modelDigests).toEqual({ 'openai/gpt-oss-120b': server.modelDigest });
    expect(Object.keys(server).sort()).toEqual(['bearerToken', 'close', 'endpoint', 'hostGeneration', 'modelDigest', 'modelDigests']);
  });

  it('rejects unauthenticated callers and scrubs internal errors to bounded codes', async () => {
    const prepared = host();
    const server = await startAstraMaxModelServer({ mode: 'source-preview-v1', host: prepared.value });
    servers.push(server);
    const unauthorized = await fetch(server.endpoint + '/internal/astra/v3/model-turns', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ detail: { code: 'authentication-required' } });
    const invalid = await fetch(server.endpoint + '/internal/astra/v3/model-turns', {
      method: 'POST', headers: { authorization: 'Bearer ' + server.bearerToken, 'content-type': 'application/json' }, body: '{}' });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toEqual({ detail: { code: 'request-binding' } });
  });

  it('retains an accepted provider result when only the runtime transport disappears', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let providerSignal: AbortSignal | undefined;
    const prepared = host({ wait: () => gate, signal: value => { providerSignal = value; } });
    const server = await startAstraMaxModelServer({ mode: 'source-preview-v1', host: prepared.value });
    servers.push(server);
    const client = new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: server.endpoint,
      bearerToken: server.bearerToken, hostGeneration: server.hostGeneration, timeoutMs: 5_000 });
    const responseSchema = { type: 'object', additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['request-completion'] } }, required: ['kind'] } as AstraJson;
    const request = { requestId: 'transport_drop_request', executionId: 'transport_drop_execution',
      expectedModelDigest: server.modelDigest, responseSchema, maxOutputTokens: 256, timeoutMs: 5_000,
      notAfterMs: NOW + 5_000 };
    const turn = await client.open(request);
    const seal = await client.prepare(turn.turnId,
      astraJournalJson({ mandatory: [{ kind: 'goal', text: 'Retain the exact accepted request.' }] }));
    const transport = new AbortController();
    const disconnected = client.generate(seal, transport.signal);
    await vi.waitFor(() => expect(prepared.proposePrepared).toHaveBeenCalledTimes(1));
    transport.abort('runtime-process-lost');
    await expect(disconnected).rejects.toMatchObject({ code: 'caller-cancelled' });
    expect(providerSignal?.aborted).toBe(false);
    release();
    await vi.waitFor(async () => {
      const settled = await client.settleRequest(request);
      expect(settled).toMatchObject({ state: 'generated', quiescent: true,
        output: { authority: 'none', text: astraJournalJson({ kind: 'request-completion' }) } });
    });
    expect(prepared.proposePrepared).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit authenticated cancellation authoritative after transport detaches from generation', async () => {
    let entered!: () => void;
    const active = new Promise<void>(resolve => { entered = resolve; });
    let providerSignal: AbortSignal | undefined;
    const prepared = host({ signal: value => { providerSignal = value; }, wait: signal => new Promise((_resolve, reject) => {
      entered(); signal?.addEventListener('abort', () => reject(Error('fixture-explicit-cancel')), { once: true });
    }) });
    const server = await startAstraMaxModelServer({ mode: 'source-preview-v1', host: prepared.value });
    servers.push(server);
    const client = new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: server.endpoint,
      bearerToken: server.bearerToken, hostGeneration: server.hostGeneration, timeoutMs: 5_000 });
    const responseSchema = { type: 'object', additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['request-completion'] } }, required: ['kind'] } as AstraJson;
    const request = { requestId: 'explicit_cancel_request', executionId: 'explicit_cancel_execution',
      expectedModelDigest: server.modelDigest, responseSchema, maxOutputTokens: 256, timeoutMs: 5_000,
      notAfterMs: NOW + 5_000 };
    const turn = await client.open(request);
    const seal = await client.prepare(turn.turnId,
      astraJournalJson({ mandatory: [{ kind: 'goal', text: 'Cancel only through the explicit route.' }] }));
    const generating = client.generate(seal);
    await active;
    const stopping = await client.cancel(turn.turnId);
    expect(stopping).toMatchObject({ state: 'cancelling', slotReserved: true });
    await expect(generating).rejects.toMatchObject({ code: 'caller-cancelled' });
    expect(providerSignal?.aborted).toBe(true);
    await vi.waitFor(async () => {
      expect(await client.settleRequest(request)).toMatchObject({ state: 'cancelled', quiescent: true,
        reason: 'caller-cancelled', output: null });
    });
    expect(prepared.proposePrepared).toHaveBeenCalledTimes(1);
  });
});
