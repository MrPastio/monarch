import { astraMaxModelLimits, astraMaxPreparedModelDigest,
  type AstraMaxPrimaryModel, type AstraMaxReasoningEffort } from './max-provider-contract';

export const ASTRA_MAX_MODEL_POLICY_VERSION = 'monarch.astra-max.model-policy.2026-09-07.v2' as const;
export type AstraMaxModelPreference = 'automatic' | 'gpt-oss-120b' | 'qwen-3.8-27b';

export type AstraMaxModelSelection = Readonly<{
  status: 'accepted';
  policyVersion: typeof ASTRA_MAX_MODEL_POLICY_VERSION;
  modelId: AstraMaxPrimaryModel;
  modelDigest: string;
  reasoningEffort: AstraMaxReasoningEffort;
  lifecycle: 'production' | 'preview';
  inputModality: 'text';
  providerTools: 'disabled';
}> | Readonly<{
  status: 'blocked';
  policyVersion: typeof ASTRA_MAX_MODEL_POLICY_VERSION;
  code: 'request-invalid' | 'provider-tools-disabled' | 'image-transport-unavailable'
    | 'preview-acknowledgement-required' | 'output-budget-unavailable';
}>;

const CATALOG = Object.freeze({
  'gpt-oss-120b': Object.freeze({ modelId: 'openai/gpt-oss-120b' as const,
    lifecycle: 'production' as const, maxOutputTokens: astraMaxModelLimits('openai/gpt-oss-120b').maxOutputTokens }),
  'qwen-3.8-27b': Object.freeze({ modelId: 'qwen/qwen3.8-27b' as const,
    lifecycle: 'preview' as const, maxOutputTokens: astraMaxModelLimits('qwen/qwen3.8-27b').maxOutputTokens }),
});

/** Main/host policy only. A renderer may eventually submit the bounded preference,
 * but it never supplies a provider model ID or changes the task after opening.
 * Upstream Qwen vision is intentionally not advertised as usable until Monarch's
 * prepared-message ABI can bind image bytes, MIME type and digest end to end.
 */
export function selectAstraMaxModel(raw: unknown): AstraMaxModelSelection {
  const blocked = (code: Extract<AstraMaxModelSelection, { status: 'blocked' }>['code']): AstraMaxModelSelection =>
    Object.freeze({ status: 'blocked', policyVersion: ASTRA_MAX_MODEL_POLICY_VERSION, code });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blocked('request-invalid');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).length !== 6
    || Object.keys(input).some(key => !['preference', 'inputModality', 'providerToolsRequired',
      'previewAcknowledged', 'maxOutputTokens', 'reasoningEffort'].includes(key))
    || !['automatic', 'gpt-oss-120b', 'qwen-3.8-27b'].includes(String(input.preference))
    || !['text', 'image'].includes(String(input.inputModality))
    || typeof input.providerToolsRequired !== 'boolean'
    || typeof input.previewAcknowledged !== 'boolean'
    || !Number.isSafeInteger(input.maxOutputTokens) || Number(input.maxOutputTokens) < 1
    || !['low', 'medium', 'high'].includes(String(input.reasoningEffort))) return blocked('request-invalid');
  if (input.providerToolsRequired) return blocked('provider-tools-disabled');
  if (input.preference === 'qwen-3.8-27b') return blocked('request-invalid');
  if (input.inputModality === 'image') return blocked('image-transport-unavailable');
  const preference = input.preference as AstraMaxModelPreference;
  const profile = CATALOG[preference === 'automatic' ? 'gpt-oss-120b' : preference];
  if (profile.lifecycle === 'preview' && input.previewAcknowledged !== true) {
    return blocked('preview-acknowledgement-required');
  }
  if (Number(input.maxOutputTokens) > profile.maxOutputTokens) return blocked('output-budget-unavailable');
  return Object.freeze({ status: 'accepted', policyVersion: ASTRA_MAX_MODEL_POLICY_VERSION,
    modelId: profile.modelId, modelDigest: astraMaxPreparedModelDigest(profile.modelId),
    reasoningEffort: input.reasoningEffort as AstraMaxReasoningEffort, lifecycle: profile.lifecycle,
    inputModality: 'text', providerTools: 'disabled' });
}
