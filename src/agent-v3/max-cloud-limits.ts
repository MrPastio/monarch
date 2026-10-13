import { parseCloudRole } from './max-cloud-catalog';

/** Owner decision 2026-09-28: cloud MAX must not inherit the limits made for local
 * models. Output and context are the person's settings (Settings → MAX); `null`
 * means automatic. The host writes the saved choice here once, and every cloud
 * path (chat stream, agent policy, prepared host, provider clamp) reads it, so a
 * change applies to the next request without a restart. */
/** `0` is «не ограничено»: Monarch sends no answer limit where the service allows
 * that, and its own largest value (the ceiling) everywhere else. */
export const MAX_CLOUD_OUTPUT_UNLIMITED = 0;
export const MAX_CLOUD_OUTPUT_CHOICES = [8192, 16_384, 32_768, 65_536, MAX_CLOUD_OUTPUT_UNLIMITED] as const;
/** Services whose default answer size is the model's own maximum, so leaving the
 * limit out is safe. DeepSeek, Mistral and others default to a few thousand. */
const OMIT_LIMIT_PROVIDERS: readonly string[] = ['openai', 'openrouter', 'gemini', 'xai'];
export const MAX_CLOUD_CONTEXT_CHOICES = [65_536, 131_072, 262_144, 1_000_000] as const;
/** Hard ceiling for one answer, whatever was chosen. */
export const MAX_CLOUD_OUTPUT_CEILING = 65_536;
const AUTO_OUTPUT_TOKENS = 32_768;
/** deepseek-chat rejects any max_tokens above 8192 (thinking modes raise it, and the
 * provider adds that room itself), so its automatic value stays at the API limit. */
const DEEPSEEK_AUTO_OUTPUT_TOKENS = 8192;
const AUTO_CONTEXT_TOKENS = 131_072;

export interface MaxCloudLimitChoice { outputTokens: number | null; contextTokens: number | null }

let choice: MaxCloudLimitChoice = { outputTokens: null, contextTokens: null };

export function setMaxCloudLimitChoice(next: Partial<MaxCloudLimitChoice>): void {
  choice = {
    outputTokens: pick(next.outputTokens, MAX_CLOUD_OUTPUT_CHOICES),
    contextTokens: pick(next.contextTokens, MAX_CLOUD_CONTEXT_CHOICES),
  };
}

function pick(value: unknown, allowed: readonly number[]): number | null {
  return typeof value === 'number' && allowed.includes(value) ? value : null;
}

/** Tokens one cloud answer may use, including the provider's hidden thinking. */
export function maxCloudOutputTokens(role?: string): number {
  const wanted = choice.outputTokens === MAX_CLOUD_OUTPUT_UNLIMITED ? MAX_CLOUD_OUTPUT_CEILING
    : choice.outputTokens
    ?? (parseCloudRole(role)?.providerId === 'deepseek' ? DEEPSEEK_AUTO_OUTPUT_TOKENS : AUTO_OUTPUT_TOKENS);
  // An answer larger than half the window would leave no room for the request.
  return Math.min(wanted, maxCloudAgentContextTokens() / 2);
}

/** True when the answer limit should not be sent to this service at all. */
export function maxCloudOmitOutputLimit(providerId: string): boolean {
  return choice.outputTokens === MAX_CLOUD_OUTPUT_UNLIMITED && OMIT_LIMIT_PROVIDERS.includes(providerId);
}

/** Context window the agent may fill before it compacts its history. */
export function maxCloudContextTokens(): number {
  return choice.contextTokens ?? AUTO_CONTEXT_TOKENS;
}

/** The agent's surface is one request of at most 512 KiB counted in bytes (an upper
 * bound on tokens), and its context engine allows 2 * window bytes. A larger window
 * chosen for chat therefore cannot be filled by an agent: a 1M window declared to
 * the prepared-model binding was rejected (`driver-binding`) and stalled the task
 * as `recovery-required` with no visible action. */
export const MAX_CLOUD_AGENT_CONTEXT_TOKENS = 262_144;
export function maxCloudAgentContextTokens(): number {
  return Math.min(maxCloudContextTokens(), MAX_CLOUD_AGENT_CONTEXT_TOKENS);
}

/** Largest request body Monarch itself sends to a cloud service, counted as UTF-8
 * bytes (an upper bound on tokens). Never below the former fixed 96 KiB. */
export function maxCloudInputBytes(): number {
  return Math.max(96 * 1024, maxCloudContextTokens());
}
