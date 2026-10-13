import type { AstraMaxPrimaryModel } from './max-provider-contract';

// Pure model metadata: importing chat identity must not load the SQLite journal.
export const ASTRA_MAX_MODEL_LIMITS: Readonly<Record<AstraMaxPrimaryModel, Readonly<{
  contextWindowTokens: number; maxOutputTokens: number;
}>>> = Object.freeze({
  'openai/gpt-oss-120b': Object.freeze({ contextWindowTokens: 131_072, maxOutputTokens: 65_536 }),
  'qwen/qwen3.8-27b': Object.freeze({ contextWindowTokens: 131_042, maxOutputTokens: 16_384 }),
});

export function astraMaxModelLimits(modelId: AstraMaxPrimaryModel): Readonly<{
  contextWindowTokens: number; maxOutputTokens: number;
}> {
  if (!Object.hasOwn(ASTRA_MAX_MODEL_LIMITS, modelId)) throw new Error('astra-max-contract:model');
  return ASTRA_MAX_MODEL_LIMITS[modelId];
}

/** Context window for dynamic cloud MAX roles, counted as UTF-8 bytes (an upper
 * bound on tokens): the smallest among the catalogue's default models. */
export const ASTRA_MAX_CLOUD_CONTEXT_TOKENS = 65_536;
