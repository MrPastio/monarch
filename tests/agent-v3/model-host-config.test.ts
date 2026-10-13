import { describe, expect, it } from 'vitest';
import { readAstraModelHostConfiguration, readOptionalMaxHost } from '../../src/app/astra-model-host-config';
import { prepareOscarAstraEnvironment } from '../../src/modules/oscar/client';
import { MONARCH_CODER_MODEL_COMPONENTS, MONARCH_OPTIONAL_BALANCED_MODEL,
  MONARCH_REQUIRED_FAST_MODEL } from '../../src/modules/models/component-manager';
const base = { MONARCH_ASTRA_V3_PILOT: 'runtime-same-owner-v1', MONARCH_ASTRA_V3_MODEL_HOST_ENDPOINT: 'http://127.0.0.1:9',
  MONARCH_ASTRA_V3_MODEL_HOST_TOKEN: 'x'.repeat(64), MONARCH_ASTRA_V3_MODEL_HOST_GENERATION: 'fixture',
  MONARCH_ASTRA_V3_MODEL_DIGEST: 'sha256:' + 'a'.repeat(64) };
const map = JSON.stringify({ 'openai/gpt-oss-120b': base.MONARCH_ASTRA_V3_MODEL_DIGEST, 'qwen/qwen3.8-27b': 'sha256:' + 'b'.repeat(64) });
describe('Application model host configuration', () => {
  it('takes managed discovery only from the local desktop owner and scrubs inherited asset admission', () => {
    const env = { MONARCH_ASTRA_V3_PILOT: 'runtime-same-owner-v1', MONARCH_ASTRA_V3_MODEL_MODE: 'managed-local' };
    expect(readAstraModelHostConfiguration(env)).toEqual({ managedLocal: true, localMemory: false });
    expect(() => readAstraModelHostConfiguration({ ...base, ...env })).toThrow('managed-local-environment');
    expect(prepareOscarAstraEnvironment({ OSCAR_ASTRA_LOCAL_COMPONENT: 'untrusted' }, 'E:\\synthetic')).toEqual({});
    const authored = prepareOscarAstraEnvironment({ ...env, OSCAR_ASTRA_LOCAL_COMPONENT: 'untrusted' }, 'E:\\synthetic');
    const component = JSON.parse(authored.OSCAR_ASTRA_LOCAL_COMPONENT!);
    expect(authored.OSCAR_AUTO_UNLOAD_AFTER_GENERATION).toBe('false');
    expect(authored.OSCAR_RECYCLE_BACKEND_AFTER_GENERATION).toBe('false');
    expect(authored.OSCAR_GEMMA_SPECULATIVE_DECODING).toBe('false');
    expect(authored.OSCAR_GEMMA4_BALANCED_GPU_LAYERS).toBe('20');
    expect(component).toMatchObject({ version: 2, root: 'E:\\synthetic' });
    expect(component.components.map((entry: { tier: string }) => entry.tier)).toEqual([
      'gemma4-fast', 'gemma4-balanced', 'qwen3-coder-30b-a3b-instruct', 'deepseek-coder-v2-lite-instruct',
    ]);
    expect(component.components[0]).toMatchObject({ tier: 'gemma4-fast',
      relativePath: MONARCH_REQUIRED_FAST_MODEL.relativePath });
    expect(component.components[0].variants).toEqual([MONARCH_REQUIRED_FAST_MODEL, ...MONARCH_REQUIRED_FAST_MODEL.acceptedExistingVariants!]
      .map(value => ({ size: value.expectedBytes, digest: 'sha256:' + value.sha256 })));
    expect(component.components.slice(1)).toEqual([MONARCH_OPTIONAL_BALANCED_MODEL, ...MONARCH_CODER_MODEL_COMPONENTS].map(spec => ({
      relativePath: spec.relativePath,
      tier: spec.role,
      variants: [spec, ...(spec.acceptedExistingVariants ?? [])]
        .map(variant => ({ size: variant.expectedBytes, digest: 'sha256:' + variant.sha256 })),
    })));
  });
  it('preserves default-off and legacy MAX configuration', () => {
    expect(readAstraModelHostConfiguration({})).toEqual({ localMemory: false });
    expect(readAstraModelHostConfiguration({ ...base, MONARCH_ASTRA_V3_MODEL_DIGESTS: map })).toMatchObject({ localMemory: false, modelHost: { modelDigest: base.MONARCH_ASTRA_V3_MODEL_DIGEST } });
  });
  it('accepts only an exact dynamic cloud descriptor from the main-process prepared host', () => {
    const role = 'max-cloud:deepseek:deepseek-chat', digest = 'sha256:' + 'c'.repeat(64);
    const value = { endpoint: 'http://127.0.0.1:4318', bearerToken: 'x'.repeat(64), hostGeneration: 'cloud_fixture',
      modelDigest: digest, modelDigests: { [role]: digest }, dynamicMaxCloud: true };
    expect(readOptionalMaxHost({ MONARCH_ASTRA_V3_PILOT: 'runtime-same-owner-v1',
      MONARCH_MAX_PREPARED_HOST: JSON.stringify(value) })).toEqual(value);
    expect(() => readOptionalMaxHost({ MONARCH_ASTRA_V3_PILOT: 'runtime-same-owner-v1',
      MONARCH_MAX_PREPARED_HOST: JSON.stringify({ ...value, dynamicMaxCloud: false }) })).toThrow('optional-max-environment');
  });
  it('requires a separate explicit memory opt-in on a local host', () => {
    expect(readAstraModelHostConfiguration({ ...base, MONARCH_ASTRA_V3_MODEL_MODE: 'local' })).toMatchObject({ localMemory: false, localModelHost: { modelDigest: base.MONARCH_ASTRA_V3_MODEL_DIGEST } });
    expect(readAstraModelHostConfiguration({ ...base, MONARCH_ASTRA_V3_MODEL_MODE: 'local', MONARCH_ASTRA_V3_LOCAL_MEMORY: 'owner-settings-v1' }).localMemory).toBe(true);
  });
  it.each([
    { MONARCH_ASTRA_V3_MODEL_MODE: 'local' },
    { ...base, MONARCH_ASTRA_V3_MODEL_MODE: 'auto' },
    { ...base, MONARCH_ASTRA_V3_MODEL_MODE: 'local', MONARCH_ASTRA_V3_MODEL_DIGESTS: map },
    { ...base, MONARCH_ASTRA_V3_MODEL_DIGESTS: map, MONARCH_ASTRA_V3_LOCAL_MEMORY: 'owner-settings-v1' },
    { ...base, MONARCH_ASTRA_V3_MODEL_MODE: 'local', MONARCH_ASTRA_V3_LOCAL_MEMORY: 'true' },
    { ...base, MONARCH_ASTRA_V3_MODEL_MODE: 'local', MONARCH_ASTRA_V3_PILOT: '' },
    { ...base, MONARCH_ASTRA_V3_MODEL_DIGESTS: '{}' },
  ])('rejects ambiguous or mixed mode %#', env => {
    expect(() => readAstraModelHostConfiguration(env)).toThrow('astra-product-pilot:');
  });
});
