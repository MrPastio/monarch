import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMaxCloudLimitChoice } from '../../src/agent-v3/max-cloud-limits';
import { astraJournalJson, type AstraJson } from '../../src/agent-v3/journal';
import { AstraMaxPreparedModelHost } from '../../src/agent-v3/max-prepared-model-host';
import { ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, astraMaxInputDigest, astraMaxOutputDigest, astraMaxPreparedModelDigest,
  type AstraMaxProposalRequestV1 } from '../../src/agent-v3/max-provider-contract';
import { maxCloudPreparedModelDigest, type MaxCloudRole } from '../../src/agent-v3/max-cloud-catalog';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const schema = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['request-completion'] } }, required: ['kind'] } as AstraJson;
const consent = { agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, providerId: 'groq' as const,
  acceptedAt: '2026-09-04T11:59:00.000Z', nonLocalProcessingAcknowledged: true as const,
  selectedContextAcknowledged: true as const, providerTermsAcknowledged: true as const };

type PreparedInput = Omit<AstraMaxProposalRequestV1, 'consent'> & { signal?: AbortSignal };

function fixture(propose?: (input: PreparedInput) => Promise<unknown>, reasoningEffort?: 'low' | 'medium' | 'high') {
  const call = vi.fn(propose ?? (async input => {
    const { signal: _signal, ...prepared } = input;
    const request = { ...prepared, consent } as AstraMaxProposalRequestV1;
    const value = { kind: 'request-completion' } as AstraJson;
    return { authority: 'none' as const, providerId: 'groq' as const, modelId: input.modelId,
      safetyModelId: 'openai/gpt-oss-safeguard-20b' as const, requestId: input.requestId,
      executionId: input.executionId, inputDigest: astraMaxInputDigest(request),
      outputDigest: astraMaxOutputDigest(value), finishReason: 'stop' as const, value };
  }));
  const host = new AstraMaxPreparedModelHost({ deployment: 'isolated-validation',
    modelId: 'openai/gpt-oss-120b', provider: { proposePrepared: call as never },
    hostGeneration: 'max_host_fixture', now: () => NOW, ...(reasoningEffort ? { reasoningEffort } : {}) });
  const request = { requestId: 'max_request', executionId: 'max_execution', expectedModelDigest: host.modelDigest,
    responseSchema: schema, maxOutputTokens: 512, timeoutMs: 5_000, lane: 'agent' as const,
    notAfterMs: NOW + 5_000 };
  return { host, request, call };
}

describe('Astra MAX prepared-model host', () => {
  // These cases pin the smallest cataloged window; the person's own setting is covered in max-cloud-limits.test.ts.
  beforeEach(() => setMaxCloudLimitChoice({ outputTokens: 8192, contextTokens: 65_536 }));
  afterEach(() => setMaxCloudLimitChoice({}));
  it('runs one sealed process-local model turn without exposing authority', async () => {
    const { host, request, call } = fixture();
    expect(host.descriptor()).toEqual({ hostGeneration: 'max_host_fixture', modelDigest: host.modelDigest,
      modelDigests: { 'openai/gpt-oss-120b': host.modelDigest } });
    const opened = host.open(request);
    expect(opened).toMatchObject({ state: 'ready', slotReserved: true, authority: 'none', persistence: 'process-local',
      binding: { profile: 'monarch.astra-v3-prepared-text.internal.v1', modelDigest: host.modelDigest,
        contextTokens: 131_072, safetyTokens: 1_024 } });
    const prepared = host.prepare(opened.turnId, '{"mandatory":[{"kind":"goal","text":"Answer only after validation."}]}');
    expect(prepared).toMatchObject({ fits: true, reservedOutputTokens: 512, surfaceDigest: expect.stringMatching(/^sha256:/u) });
    expect(prepared.tokenCount).toBe(prepared.promptUtf8Bytes);
    const output = await host.generate(opened.turnId,
      { preparedId: prepared.preparedId, promptDigest: prepared.promptDigest });
    expect(JSON.parse(output.text)).toEqual({ kind: 'request-completion' });
    expect(output).toMatchObject({ authority: 'none', finishReason: 'stop', inputTokens: prepared.tokenCount });
    expect(host.inspect(opened.turnId)).toMatchObject({ state: 'generated', slotReserved: false });
    expect(host.settleRequest(request)).toMatchObject({ state: 'generated', quiescent: true,
      requestId: request.requestId, prepared: { preparedId: prepared.preparedId }, output: { text: output.text } });
    expect(call).toHaveBeenCalledTimes(1);
    const providerInput = call.mock.calls[0]![0] as { messages: Array<{ content: string }>; responseSchema: AstraJson };
    expect(providerInput.messages[1]!.content).toContain('Answer only after validation.');
    expect(providerInput.responseSchema).toEqual(schema);
    expect(JSON.stringify(providerInput)).not.toContain('gsk_');
  });

  it('sends high reasoning by default and a validated measured override otherwise', async () => {
    for (const [effort, expected] of [[undefined, 'high'], ['medium', 'medium']] as const) {
      const { host, request, call } = fixture(undefined, effort);
      const opened = host.open(request), prepared = host.prepare(opened.turnId, '{"mandatory":[]}');
      await host.generate(opened.turnId, { preparedId: prepared.preparedId, promptDigest: prepared.promptDigest });
      expect((call.mock.calls[0]![0] as { reasoningEffort: string }).reasoningEffort).toBe(expected);
    }
    expect(() => new AstraMaxPreparedModelHost({ deployment: 'isolated-validation', modelId: 'openai/gpt-oss-120b',
      provider: { proposePrepared: vi.fn() as never }, reasoningEffort: 'extreme' as never })).toThrow('reasoning-effort');
  });

  it('applies a chosen reasoning depth to the next decision and restores the default', async () => {
    const { host, request, call } = fixture();
    host.setReasoningEffort('low');
    const opened = host.open(request), prepared = host.prepare(opened.turnId, '{"mandatory":[]}');
    await host.generate(opened.turnId, { preparedId: prepared.preparedId, promptDigest: prepared.promptDigest });
    expect((call.mock.calls[0]![0] as { reasoningEffort: string }).reasoningEffort).toBe('low');
    host.setReasoningEffort(undefined);
    const next = host.open({ ...request, requestId: 'max_request_2', executionId: 'max_execution_2' });
    const nextPrepared = host.prepare(next.turnId, '{"mandatory":[]}');
    await host.generate(next.turnId, { preparedId: nextPrepared.preparedId, promptDigest: nextPrepared.promptDigest });
    expect((call.mock.calls[1]![0] as { reasoningEffort: string }).reasoningEffort).toBe('high');
    expect(() => host.setReasoningEffort('extreme' as never)).toThrow('reasoning-effort');
  });

  it('replays only identical open, prepare and generated calls', async () => {
    const { host, request, call } = fixture();
    const first = host.open(request), replay = host.open(structuredClone(request));
    expect(replay).toEqual(first);
    const prepared = host.prepare(first.turnId, 'bounded surface');
    expect(host.prepare(first.turnId, 'bounded surface')).toEqual(prepared);
    const output = await host.generate(first.turnId, { preparedId: prepared.preparedId, promptDigest: prepared.promptDigest });
    await expect(host.generate(first.turnId, { preparedId: prepared.preparedId, promptDigest: prepared.promptDigest }))
      .resolves.toEqual(output);
    expect(call).toHaveBeenCalledTimes(1);
    expect(() => host.open({ ...request, maxOutputTokens: 513 })).toThrow('request-conflict');
  });

  it('fails closed on model mismatch, altered prepare input and retained-request absence', async () => {
    const { host, request } = fixture();
    expect(() => host.open({ ...request, expectedModelDigest: 'sha256:' + '0'.repeat(64) })).toThrow('request-binding');
    const opened = host.open(request), prepared = host.prepare(opened.turnId, 'first surface');
    await expect(host.generate(opened.turnId,
      { preparedId: prepared.preparedId, promptDigest: 'sha256:' + '0'.repeat(64) })).rejects.toThrow('prepared-binding');
    // A compaction candidate replaces the preparation, as on the local host. The
    // superseded seal can never generate; only the current surface can.
    const second = host.prepare(opened.turnId, 'second surface');
    expect(second.surfaceDigest).not.toBe(prepared.surfaceDigest);
    await expect(host.generate(opened.turnId,
      { preparedId: prepared.preparedId, promptDigest: prepared.promptDigest })).rejects.toThrow('prepared-binding');
    expect(host.prepare(opened.turnId, 'second surface')).toEqual(second);
    for (let index = 3; index <= 8; index++) host.prepare(opened.turnId, 'surface ' + index);
    expect(() => host.prepare(opened.turnId, 'ninth surface')).toThrow('prepare-budget');
    const missing = fixture().host.settleRequest({ ...request, requestId: 'missing_request' });
    expect(missing).toMatchObject({ state: 'cancelled', reason: 'request-not-retained',
      quiescent: true, slotReserved: false, prepared: null, output: null });
  });

  it('pins either admitted model digest at open time without allowing substitution during the turn', async () => {
    const prepared = fixture();
    const qwenDigest = astraMaxPreparedModelDigest('qwen/qwen3.8-27b');
    const host = new AstraMaxPreparedModelHost({ deployment: 'isolated-validation',
      modelId: 'openai/gpt-oss-120b', modelIds: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
      provider: { proposePrepared: prepared.call as never }, hostGeneration: 'max_multi_model_fixture', now: () => NOW });
    expect(host.descriptor()).toMatchObject({ modelDigest: astraMaxPreparedModelDigest('openai/gpt-oss-120b'),
      modelDigests: { 'openai/gpt-oss-120b': astraMaxPreparedModelDigest('openai/gpt-oss-120b'),
        'qwen/qwen3.8-27b': qwenDigest } });
    const request = { ...prepared.request, requestId: 'qwen_request', executionId: 'qwen_execution',
      expectedModelDigest: qwenDigest };
    const opened = host.open(request), seal = host.prepare(opened.turnId, 'Pinned Qwen surface.');
    await host.generate(opened.turnId, { preparedId: seal.preparedId, promptDigest: seal.promptDigest });
    expect(prepared.call).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'qwen/qwen3.8-27b' }));
    expect(() => host.open({ ...request, expectedModelDigest: astraMaxPreparedModelDigest('openai/gpt-oss-120b') }))
      .toThrow('request-conflict');
  });

  it('binds a dynamic cloud role to its digest and keeps credentials behind the host port', async () => {
    const native = fixture(), role = 'max-cloud:deepseek:deepseek-chat' as MaxCloudRole;
    const cloud = vi.fn(async () => ({ value: { kind: 'request-completion' } as AstraJson, modelId: 'deepseek-chat' }));
    const host = new AstraMaxPreparedModelHost({ deployment: 'isolated-validation', modelId: 'openai/gpt-oss-120b',
      provider: { proposePrepared: native.call as never }, cloudProvider: { propose: cloud },
      hostGeneration: 'max_cloud_fixture', now: () => NOW });
    expect(host.descriptor()).toMatchObject({ dynamicMaxCloud: true });
    const request = { ...native.request, requestId: 'cloud_request', executionId: 'cloud_execution', modelId: role,
      expectedModelDigest: maxCloudPreparedModelDigest(role), maxOutputTokens: 8192 };
    const opened = host.open(request);
    expect(opened.binding).toMatchObject({ modelDigest: request.expectedModelDigest, contextTokens: 65_536 });
    const seal = host.prepare(opened.turnId, 'Use the exact configured cloud model.');
    const output = await host.generate(opened.turnId, { preparedId: seal.preparedId, promptDigest: seal.promptDigest });
    expect(JSON.parse(output.text)).toEqual({ kind: 'request-completion' });
    expect(cloud).toHaveBeenCalledWith(expect.objectContaining({ role, maxTokens: 8192 }), expect.any(AbortSignal));
    expect(native.call).not.toHaveBeenCalled();
    expect(() => host.open({ ...request, requestId: 'cloud_mismatch', modelId: 'max-cloud:deepseek:deepseek-reasoner' }))
      .toThrow('request-binding');
  });

  it.each([
    ['truncated', 'model-output-limit'], ['safety-blocked', 'safety-blocked-model'],
    ['rate-limit', 'provider-rate-limited'], ['proposal-schema', 'proposal-schema'],
    ['timeout', 'provider-timeout'], ['something-new', 'provider-failed'],
  ])('keeps the cloud failure code instead of collapsing it (%s)', async (cloudCode, reason) => {
    // Live: a DeepSeek agent stopped after eleven minutes with only `provider-failed`.
    const native = fixture(), role = 'max-cloud:deepseek:deepseek-chat' as MaxCloudRole;
    const cloud = vi.fn(async () => { throw Error('astra-max-cloud:' + cloudCode); });
    const host = new AstraMaxPreparedModelHost({ deployment: 'isolated-validation', modelId: 'openai/gpt-oss-120b',
      provider: { proposePrepared: native.call as never }, cloudProvider: { propose: cloud },
      hostGeneration: 'max_cloud_failure', now: () => NOW });
    const opened = host.open({ ...native.request, requestId: 'cloud_failure', executionId: 'cloud_failure_execution',
      modelId: role, expectedModelDigest: maxCloudPreparedModelDigest(role), maxOutputTokens: 8192 });
    const seal = host.prepare(opened.turnId, 'Use the exact configured cloud model.');
    await expect(host.generate(opened.turnId, { preparedId: seal.preparedId, promptDigest: seal.promptDigest }))
      .rejects.toMatchObject({ code: reason });
    expect(host.inspect(opened.turnId).reason).toBe(reason);
  });

  it('enforces the exact output ceiling of the digest pinned at open time', () => {
    const prepared = fixture();
    const qwenDigest = astraMaxPreparedModelDigest('qwen/qwen3.8-27b');
    const host = new AstraMaxPreparedModelHost({ deployment: 'isolated-validation',
      modelId: 'openai/gpt-oss-120b', modelIds: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
      provider: { proposePrepared: prepared.call as never }, hostGeneration: 'max_limits_fixture', now: () => NOW });
    expect(host.open({ ...prepared.request, requestId: 'gpt_limit', maxOutputTokens: 65_536 }).state).toBe('ready');
    expect(() => host.open({ ...prepared.request, requestId: 'gpt_over', maxOutputTokens: 65_537 }))
      .toThrow('request-budget');
    expect(host.open({ ...prepared.request, requestId: 'qwen_limit', expectedModelDigest: qwenDigest,
      maxOutputTokens: 16_384 }).binding.contextTokens).toBe(131_042);
    expect(() => host.open({ ...prepared.request, requestId: 'qwen_over', expectedModelDigest: qwenDigest,
      maxOutputTokens: 16_385 })).toThrow('request-budget');
  });

  it('cancels an in-flight provider request and keeps the reservation until acknowledgement', async () => {
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
  const { host, request } = fixture(async input => {
      started();
      await new Promise((resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { code: 'caller-cancelled' })), { once: true });
      });
      throw Error('unreachable');
    });
    const opened = host.open(request), prepared = host.prepare(opened.turnId, 'cancel surface');
    const generation = host.generate(opened.turnId, { preparedId: prepared.preparedId, promptDigest: prepared.promptDigest });
    await running;
    expect(host.cancel(opened.turnId)).toMatchObject({ state: 'cancelling', slotReserved: true });
    await expect(generation).rejects.toThrow('caller-cancelled');
    expect(host.inspect(opened.turnId)).toMatchObject({ state: 'cancelled', slotReserved: false });
  });

  it('uses UTF-8 bytes as a conservative count and rejects oversized surfaces before provider access', () => {
    const { host, request, call } = fixture();
    const opened = host.open(request);
    expect(host.prepare(opened.turnId, 'я'.repeat(70_000))).toMatchObject({ fits: false });
    expect(() => host.prepare(opened.turnId, 'я'.repeat(270_000))).toThrow('surface-size');
    expect(call).not.toHaveBeenCalled();
  });

  it('counts a cloud surface over the window as not fitting instead of failing the counter', async () => {
    // Live: the throw reached the context engine as `tokenizer-unavailable` and a
    // DeepSeek task stopped instead of compacting its history.
    const native = fixture(), role = 'max-cloud:deepseek:deepseek-chat' as MaxCloudRole;
    const cloud = vi.fn(async () => ({ value: { kind: 'request-completion' } as AstraJson, modelId: 'deepseek-chat' }));
    const host = new AstraMaxPreparedModelHost({ deployment: 'isolated-validation', modelId: 'openai/gpt-oss-120b',
      provider: { proposePrepared: native.call as never }, cloudProvider: { propose: cloud },
      hostGeneration: 'max_cloud_window', now: () => NOW });
    const opened = host.open({ ...native.request, requestId: 'cloud_window', executionId: 'cloud_window_execution',
      modelId: role, expectedModelDigest: maxCloudPreparedModelDigest(role), maxOutputTokens: 8192 });
    const seal = host.prepare(opened.turnId, 'я'.repeat(40_000));
    expect(seal).toMatchObject({ fits: false });
    expect(seal.tokenCount).toBeGreaterThan(65_536);
    await expect(host.generate(opened.turnId, { preparedId: seal.preparedId, promptDigest: seal.promptDigest }))
      .rejects.toThrow('generate-state');
    expect(cloud).not.toHaveBeenCalled();
    expect(astraJournalJson(schema)).not.toContain('undefined');
  });

  it('bounds retained result memory without permitting a late duplicate generation', async () => {
    let now = NOW;
    const prepared = fixture();
    const host = new AstraMaxPreparedModelHost({ deployment: 'isolated-validation', modelId: 'openai/gpt-oss-120b',
      provider: { proposePrepared: prepared.call as never }, hostGeneration: 'max_retention_fixture',
      now: () => now, resultRetentionMs: 1_000 });
    const request = { ...prepared.request, requestId: 'retained_request', executionId: 'retained_execution',
      expectedModelDigest: host.modelDigest, notAfterMs: NOW + 5_000 };
    const turn = host.open(request), seal = host.prepare(turn.turnId, 'retained surface');
    await host.generate(turn.turnId, { preparedId: seal.preparedId, promptDigest: seal.promptDigest });
    now += 1_001;
    expect(host.settleRequest(request)).toMatchObject({ state: 'cancelled', reason: 'request-not-retained', quiescent: true });
    expect(() => host.open(request)).toThrow('request-not-retained');
    expect(prepared.call).toHaveBeenCalledTimes(1);
    const next = host.open({ ...request, requestId: 'next_request', executionId: 'next_execution' });
    expect(next.state).toBe('ready');
  });
});
