type Host = { endpoint: string; bearerToken: string; hostGeneration: string; modelDigest: string };
type Digests = Readonly<Record<'openai/gpt-oss-120b' | 'qwen/qwen3.8-27b', string>>;
type OptionalMaxDigests = Readonly<Record<string, string>>;
export type AstraLocalModelDigests = Readonly<Record<'gemma4-fast', string>
  & Partial<Record<'gemma4-balanced' | 'qwen3-coder-30b-a3b-instruct'
    | 'deepseek-coder-v2-lite-instruct', string>>>;
export type AstraModelHostConfiguration = { modelHost?: Host & { modelDigests: Digests };
  localModelHost?: Host & { modelDigests?: AstraLocalModelDigests }; localMemory: boolean; managedLocal?: boolean };

export function readOptionalMaxHost(env: Record<string, string | undefined>): (Host & { modelDigests: OptionalMaxDigests;
  dynamicMaxCloud?: true }) | undefined {
  const raw = env.MONARCH_MAX_PREPARED_HOST;
  if (!raw) return undefined;
  if (raw.length > 2048 || env.MONARCH_ASTRA_V3_PILOT !== 'runtime-same-owner-v1') throw Error('astra-product-pilot:optional-max-environment');
  const value = JSON.parse(raw) as Host & { modelDigests: OptionalMaxDigests; dynamicMaxCloud?: unknown };
  const keys = Object.keys(value || {}).sort().join(',');
  if (!value || !['bearerToken,dynamicMaxCloud,endpoint,hostGeneration,modelDigest,modelDigests',
    'bearerToken,endpoint,hostGeneration,modelDigest,modelDigests'].includes(keys)
    || value.dynamicMaxCloud !== undefined && value.dynamicMaxCloud !== true) throw Error('astra-product-pilot:optional-max-environment');
  const { dynamicMaxCloud: _dynamicMaxCloud, ...host } = value;
  return { ...host, modelDigests: parseOptionalMaxDigests(value.modelDigests, value.dynamicMaxCloud === true),
    ...(value.dynamicMaxCloud === true ? { dynamicMaxCloud: true as const } : {}) };
}

/** Pure configuration parsing. No discovery, credential reads, writes or startup. */
export function readAstraModelHostConfiguration(env: Record<string, string | undefined>): AstraModelHostConfiguration {
  const mode = env.MONARCH_ASTRA_V3_MODEL_MODE;
  const memory = env.MONARCH_ASTRA_V3_LOCAL_MEMORY;
  const values = [env.MONARCH_ASTRA_V3_MODEL_HOST_ENDPOINT, env.MONARCH_ASTRA_V3_MODEL_HOST_TOKEN,
    env.MONARCH_ASTRA_V3_MODEL_HOST_GENERATION, env.MONARCH_ASTRA_V3_MODEL_DIGEST];
  const map = env.MONARCH_ASTRA_V3_MODEL_DIGESTS;
  const configured = values.some(value => value !== undefined) || map !== undefined;
  if (mode === 'managed-local') {
    if (configured || memory !== undefined || env.MONARCH_ASTRA_V3_PILOT !== 'runtime-same-owner-v1') {
      throw Error('astra-product-pilot:managed-local-environment');
    }
    return { managedLocal: true, localMemory: false };
  }
  if (mode !== undefined && !['local', 'max'].includes(mode) || memory !== undefined && memory !== 'owner-settings-v1') {
    throw Error('astra-product-pilot:model-mode-environment');
  }
  if (!configured) {
    if (mode !== undefined || memory !== undefined) throw Error('astra-product-pilot:model-host-environment-incomplete');
    return { localMemory: false };
  }
  if (values.some(value => value === undefined) || mode !== 'local' && map === undefined) {
    throw Error('astra-product-pilot:model-host-environment-incomplete');
  }
  if (env.MONARCH_ASTRA_V3_PILOT !== 'runtime-same-owner-v1') throw Error('astra-product-pilot:model-host-without-pilot');
  if (mode === 'local' && map !== undefined || memory !== undefined && mode !== 'local') {
    throw Error('astra-product-pilot:model-destination-conflict');
  }
  const host: Host = { endpoint: values[0]!, bearerToken: values[1]!, hostGeneration: values[2]!, modelDigest: values[3]! };
  if (mode === 'local') return { localModelHost: host, localMemory: memory === 'owner-settings-v1' };
  return { modelHost: { ...host, modelDigests: parseDigests(map!) }, localMemory: false };
}

function parseDigests(serialized: string): Digests {
  if (serialized.length < 2 || serialized.length > 512) throw Error('astra-product-pilot:model-host-environment');
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw Error('astra-product-pilot:model-host-environment'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('astra-product-pilot:model-host-environment');
  const value = parsed as Record<string, unknown>, keys = Object.keys(value);
  if (keys.length !== 2 || keys.some(key => !['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(key))
    || keys.some(key => typeof value[key] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value[key] as string))
    || value['openai/gpt-oss-120b'] === value['qwen/qwen3.8-27b']) throw Error('astra-product-pilot:model-host-environment');
  return Object.freeze({ 'openai/gpt-oss-120b': value['openai/gpt-oss-120b'] as string,
    'qwen/qwen3.8-27b': value['qwen/qwen3.8-27b'] as string });
}

function parseOptionalMaxDigests(parsed: unknown, dynamic: boolean): OptionalMaxDigests {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('astra-product-pilot:model-host-environment');
  const value = parsed as Record<string, unknown>, keys = Object.keys(value);
  const cloudRole = (key: string) => /^max-cloud:(?:openai|anthropic|gemini|openrouter|deepseek|mistral|xai|together|fireworks|cerebras|nvidia):[a-zA-Z0-9][a-zA-Z0-9._/:@+-]{0,159}$/u.test(key);
  if (keys.length < 1 || keys.length > 3
    || keys.some(key => !['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(key) && !(dynamic && cloudRole(key)))
    || keys.some(key => typeof value[key] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value[key] as string))
    || new Set(Object.values(value)).size !== keys.length) throw Error('astra-product-pilot:model-host-environment');
  return Object.freeze({ ...value } as Record<string, string>);
}
