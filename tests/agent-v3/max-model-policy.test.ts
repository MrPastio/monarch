import { describe, expect, it } from 'vitest';
import { ASTRA_MAX_MODEL_POLICY_VERSION, selectAstraMaxModel } from '../../src/agent-v3/max-model-policy';
import { astraMaxPreparedModelDigest } from '../../src/agent-v3/max-provider-contract';

const request = (overrides: Record<string, unknown> = {}) => ({
  preference: 'automatic', inputModality: 'text', providerToolsRequired: false,
  previewAcknowledged: false, maxOutputTokens: 8_192, reasoningEffort: 'high', ...overrides,
});

describe('Astra MAX host-owned model policy', () => {
  it('uses production GPT OSS for automatic text work and binds its exact digest', () => {
    expect(selectAstraMaxModel(request())).toEqual({ status: 'accepted', policyVersion: ASTRA_MAX_MODEL_POLICY_VERSION,
      modelId: 'openai/gpt-oss-120b', modelDigest: astraMaxPreparedModelDigest('openai/gpt-oss-120b'),
      reasoningEffort: 'high', lifecycle: 'production', inputModality: 'text', providerTools: 'disabled' });
  });

  it.each([false, true])('blocks retired Qwen regardless of preview acknowledgement %s', previewAcknowledged => {
    expect(selectAstraMaxModel(request({ preference: 'qwen-3.8-27b', previewAcknowledged })))
      .toMatchObject({ status: 'blocked', code: 'request-invalid' });
  });

  it('blocks cloud tools, image input and output beyond the current prepared-host contract', () => {
    expect(selectAstraMaxModel(request({ providerToolsRequired: true })))
      .toMatchObject({ status: 'blocked', code: 'provider-tools-disabled' });
    expect(selectAstraMaxModel(request({ inputModality: 'image' })))
      .toMatchObject({ status: 'blocked', code: 'image-transport-unavailable' });
    expect(selectAstraMaxModel(request({ maxOutputTokens: 65_536 })))
      .toMatchObject({ status: 'accepted', modelId: 'openai/gpt-oss-120b' });
    expect(selectAstraMaxModel(request({ maxOutputTokens: 65_537 })))
      .toMatchObject({ status: 'blocked', code: 'output-budget-unavailable' });
  });

  it('rejects unknown fields and arbitrary provider model IDs', () => {
    expect(selectAstraMaxModel(request({ preference: 'provider/arbitrary' })))
      .toMatchObject({ status: 'blocked', code: 'request-invalid' });
    expect(selectAstraMaxModel({ ...request(), modelId: 'qwen/qwen3.8-27b' }))
      .toMatchObject({ status: 'blocked', code: 'request-invalid' });
  });
});
