import { createHash } from 'node:crypto';

/** Public metadata only. Endpoints are host-owned; requests never supply URLs. */
export const MAX_CLOUD_AGREEMENT = 'monarch.max.providers.2026-09-07.v1';
export const MAX_CLOUD_PROVIDERS = [
  { id: 'groq', name: 'Groq', mark: 'G', model: 'openai/gpt-oss-120b', base: 'https://api.groq.com/openai/v1', format: 'schema', keys: 'https://console.groq.com/keys', terms: 'https://console.groq.com/docs/legal', privacy: 'https://console.groq.com/docs/your-data' },
  { id: 'openai', name: 'OpenAI', mark: 'O', model: 'gpt-4.1', base: 'https://api.openai.com/v1', format: 'schema', keys: 'https://platform.openai.com/api-keys', terms: 'https://openai.com/policies/terms-of-use/', privacy: 'https://openai.com/policies/api-data-usage-policies/' },
  { id: 'anthropic', name: 'Claude', mark: 'C', model: 'claude-sonnet-4-6', base: 'https://api.anthropic.com/v1', format: 'anthropic', keys: 'https://platform.claude.com/settings/keys', terms: 'https://www.anthropic.com/legal/commercial-terms', privacy: 'https://www.anthropic.com/legal/privacy' },
  { id: 'gemini', name: 'Google Gemini', mark: '✦', model: 'gemini-3.8-flash', base: 'https://generativelanguage.googleapis.com/v1beta/openai', format: 'schema', keys: 'https://aistudio.google.com/apikey', terms: 'https://ai.google.dev/gemini-api/terms', privacy: 'https://ai.google.dev/gemini-api/terms' },
  { id: 'openrouter', name: 'OpenRouter', mark: '↗', model: 'openai/gpt-4.1', base: 'https://openrouter.ai/api/v1', format: 'schema', keys: 'https://openrouter.ai/settings/keys', terms: 'https://openrouter.ai/terms', privacy: 'https://openrouter.ai/privacy' },
  { id: 'deepseek', name: 'DeepSeek', mark: 'D', model: 'deepseek-chat', base: 'https://api.deepseek.com', format: 'json', keys: 'https://platform.deepseek.com/api_keys', terms: 'https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html', privacy: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html' },
  { id: 'mistral', name: 'Mistral', mark: 'M', model: 'mistral-large-latest', base: 'https://api.mistral.ai/v1', format: 'json', keys: 'https://console.mistral.ai/api-keys', terms: 'https://mistral.ai/terms', privacy: 'https://mistral.ai/terms/#privacy-policy' },
  { id: 'xai', name: 'xAI · Grok', mark: '𝕏', model: 'grok-4', base: 'https://api.x.ai/v1', format: 'schema', keys: 'https://console.x.ai', terms: 'https://x.ai/legal/terms-of-service', privacy: 'https://x.ai/legal/privacy-policy' },
  { id: 'together', name: 'Together AI', mark: 'T', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', base: 'https://api.together.xyz/v1', format: 'schema', keys: 'https://api.together.ai/settings/api-keys', terms: 'https://www.together.ai/terms-of-service', privacy: 'https://www.together.ai/privacy' },
  { id: 'fireworks', name: 'Fireworks AI', mark: 'F', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', base: 'https://api.fireworks.ai/inference/v1', format: 'schema', keys: 'https://app.fireworks.ai/settings/users/api-keys', terms: 'https://fireworks.ai/terms-of-service', privacy: 'https://fireworks.ai/privacy-policy' },
  { id: 'cerebras', name: 'Cerebras', mark: 'Cb', model: 'gpt-oss-120b', base: 'https://api.cerebras.ai/v1', format: 'schema', keys: 'https://cloud.cerebras.ai/platform', terms: 'https://www.cerebras.ai/terms-of-service', privacy: 'https://www.cerebras.ai/privacy-policy' },
  { id: 'nvidia', name: 'NVIDIA', mark: 'N', model: 'meta/llama-3.3-70b-instruct', base: 'https://integrate.api.nvidia.com/v1', format: 'json', keys: 'https://build.nvidia.com', terms: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-api-trial-terms-of-service/', privacy: 'https://www.nvidia.com/en-us/about-nvidia/privacy-policy/' },
] as const;
export type MaxCloudProviderId = typeof MAX_CLOUD_PROVIDERS[number]['id'];
export type MaxCloudRole = `max-cloud:${string}:${string}`;
export function cloudProvider(id: unknown) { return MAX_CLOUD_PROVIDERS.find(provider => provider.id === id); }
export function validCloudModel(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/:@+-]{0,159}$/u.test(value);
}
export function cloudRole(providerId: MaxCloudProviderId, model: string): MaxCloudRole {
  if (!cloudProvider(providerId) || !validCloudModel(model)) throw Error('astra-max-cloud:model');
  return `max-cloud:${providerId}:${model}`;
}
export function parseCloudRole(value: unknown): { providerId: MaxCloudProviderId; model: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^max-cloud:([a-z]+):(.+)$/u.exec(value);
  const provider = cloudProvider(match?.[1]);
  return provider && validCloudModel(match?.[2]) ? { providerId: provider.id, model: match[2] } : null;
}
/** Stable executable identity. It names the exact provider/model and the
 * proposal-only, same-provider-screened transport, never a credential. */
export function maxCloudPreparedModelDigest(role: MaxCloudRole): string {
  const parsed = parseCloudRole(role);
  if (!parsed || parsed.providerId === 'groq') throw Error('astra-max-cloud:model');
  return 'sha256:' + createHash('sha256').update(JSON.stringify({
    profile: 'monarch.astra-max.cloud-prepared-model.v1',
    providerId: parsed.providerId,
    model: parsed.model,
    screening: 'same-provider-input-output-v1',
    tools: 'disabled',
  })).digest('hex');
}

export type MaxCloudEffort = 'low' | 'medium' | 'high';
/** Reasoning depth each service accepts, per its own API. A model that takes
 * no such parameter gets none: sending one would make the request fail, and
 * swapping the model silently is not allowed. */
export function maxCloudEffortTunable(providerId: MaxCloudProviderId, model: string): boolean {
  const id = model.toLowerCase();
  switch (providerId) {
    case 'groq': case 'deepseek': return true;
    case 'openai': return OPENAI_REASONING.test(id);
    case 'anthropic': return /claude-(opus|sonnet|haiku)-[4-9]|claude-3-7/u.test(id);
    case 'gemini': return /gemini-(2\.5|[3-9])/u.test(id);
    case 'xai': return /grok-3-mini/u.test(id);
    case 'openrouter': return /(^|\/)(o[1-9]|gpt-[5-9]|gpt-oss|deepseek-r1|claude-(opus|sonnet|haiku)-[4-9]|claude-3\.?7|gemini-(2\.5|[3-9])|grok-(3-mini|4)|qwen3)/u.test(id);
    case 'together': case 'fireworks': case 'cerebras': return /gpt-oss/u.test(id);
    default: return false;
  }
}
/** OpenAI reasoning families, including later GPT generations (live: gpt-6-luna
 * matched neither the depth rule nor the sampling rule below). */
const OPENAI_REASONING = /^(o[1-9]|gpt-[5-9])/u;
/** OpenAI reasoning models accept only their default sampling: any explicit
 * `temperature` is a 400. The classifier's deterministic temperature is
 * therefore not sent to them; the reply is still validated against the schema. */
export function maxCloudAcceptsTemperature(providerId: MaxCloudProviderId, model: string): boolean {
  const id = model.toLowerCase();
  if (providerId === 'openai') return !OPENAI_REASONING.test(id);
  if (providerId === 'openrouter') return !/(^|\/)(o[1-9]|gpt-[5-9])/u.test(id);
  return true;
}
/** Anthropic thinking budgets; the answer keeps its full token allowance on top. */
export const MAX_CLOUD_THINKING_BUDGET: Readonly<Record<MaxCloudEffort, number>> = Object.freeze({ low: 1024, medium: 4096, high: 12_000 });
/** Request fields for the chosen depth; `{}` means the service's own default. */
export function maxCloudEffortFields(providerId: MaxCloudProviderId, model: string, effort: MaxCloudEffort | undefined): Record<string, unknown> {
  if (!effort || !maxCloudEffortTunable(providerId, model)) return {};
  switch (providerId) {
    case 'anthropic': return { thinking: { type: 'enabled', budget_tokens: MAX_CLOUD_THINKING_BUDGET[effort] } };
    case 'deepseek': return { thinking: { type: 'enabled' }, reasoning_effort: { low: 'low', medium: 'high', high: 'max' }[effort] };
    case 'openrouter': return { reasoning: { effort } };
    // grok-3-mini knows only low and high.
    case 'xai': return { reasoning_effort: effort === 'high' ? 'high' : 'low' };
    default: return { reasoning_effort: effort };
  }
}
