import { MAX_CLOUD_AGREEMENT, cloudProvider, type MaxCloudProviderId } from './max-cloud-catalog';
import { createHash } from 'node:crypto';
import { astraJournalJson, type AstraJson } from './journal';

export const ASTRA_MAX_PROVIDER_ID = 'groq' as const;
export const ASTRA_MAX_PROVIDER_AGREEMENT_VERSION = 'monarch.astra-max.groq-consent.2026-09-04.v1' as const;
export const ASTRA_MAX_PRIMARY_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'] as const;
export const ASTRA_MAX_SAFETY_MODEL = 'openai/gpt-oss-safeguard-20b' as const;
export type AstraMaxDeployment = 'isolated-validation' | 'source-preview' | 'native-desktop';
export type AstraMaxPrimaryModel = typeof ASTRA_MAX_PRIMARY_MODELS[number];
export type AstraMaxReasoningEffort = 'low' | 'medium' | 'high';
export const ASTRA_MAX_CONTEXT_SAFETY_TOKENS = 1_024;
export const ASTRA_MAX_CONSERVATIVE_TEXT_BYTES = 128 * 1024;
export const ASTRA_MAX_IMAGE_INPUT_TOKENS = 2_048;
export const ASTRA_MAX_IMAGE_COUNT = 3;
export const ASTRA_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ASTRA_MAX_TOTAL_IMAGE_BYTES = ASTRA_MAX_IMAGE_COUNT * ASTRA_MAX_IMAGE_BYTES;
export const ASTRA_MAX_NATIVE_REQUEST_BYTES = 36 * 1024 * 1024;
export { ASTRA_MAX_CLOUD_CONTEXT_TOKENS, ASTRA_MAX_MODEL_LIMITS, astraMaxModelLimits } from './max-model-limits';

export interface AstraMaxProviderConsentV1 {
  agreementVersion: typeof ASTRA_MAX_PROVIDER_AGREEMENT_VERSION | typeof MAX_CLOUD_AGREEMENT;
  providerId: MaxCloudProviderId;
  acceptedAt: string;
  nonLocalProcessingAcknowledged: true;
  selectedContextAcknowledged: true;
  providerTermsAcknowledged: true;
}

export type AstraMaxImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type AstraMaxMessageContentV1 = string | readonly (
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'image_url'; image_url: Readonly<{ url: string }> }>
)[];

export interface AstraMaxMessageV1 {
  role: 'system' | 'user' | 'assistant';
  content: AstraMaxMessageContentV1;
}

export interface AstraMaxProposalRequestV1 {
  requestId: string;
  executionId: string;
  modelId: AstraMaxPrimaryModel;
  reasoningEffort: AstraMaxReasoningEffort;
  maxCompletionTokens: number;
  messages: readonly AstraMaxMessageV1[];
  responseSchema: AstraJson;
  consent: AstraMaxProviderConsentV1;
}

export interface AstraMaxProposalV1 {
  authority: 'none';
  providerId: typeof ASTRA_MAX_PROVIDER_ID;
  modelId: AstraMaxPrimaryModel;
  safetyModelId: typeof ASTRA_MAX_SAFETY_MODEL;
  requestId: string;
  executionId: string;
  inputDigest: string;
  outputDigest: string;
  finishReason: 'stop' | 'length';
  value: AstraJson;
}

export const ASTRA_MAX_FIRST_USE_DISCLOSURE = Object.freeze({
  title: 'MAX использует облако',
  summary: 'Текст задачи и только выбранный для неё контекст будут отправлены в Groq. Без твоего согласия MAX не подключается.',
  checks: Object.freeze([
    'Я понимаю, что обработка будет не на моём компьютере.',
    'Я понимаю, что в Groq уйдёт текст задачи и выбранные мной материалы.',
    'Я прочитал условия и политику данных Groq.',
  ]),
  providerDataUrl: 'https://console.groq.com/docs/your-data',
  providerTermsUrl: 'https://console.groq.com/docs/legal',
});

export function astraMaxInputDigest(input: Pick<AstraMaxProposalRequestV1,
  'requestId' | 'executionId' | 'modelId' | 'reasoningEffort' | 'maxCompletionTokens' | 'messages' | 'responseSchema' | 'consent'>): string {
  return digest(astraJournalJson(JSON.parse(JSON.stringify(input)) as AstraJson));
}

export function astraMaxOutputDigest(value: AstraJson): string {
  return digest(astraJournalJson(value));
}

export function astraMaxPreparedModelDigest(modelId: AstraMaxPrimaryModel): string {
  if (!(ASTRA_MAX_PRIMARY_MODELS as readonly string[]).includes(modelId)) throw new Error('astra-max-contract:model');
  return digest(astraJournalJson({
    profile: 'monarch.astra-max.prepared-model.v1',
    providerId: ASTRA_MAX_PROVIDER_ID,
    modelId,
    safetyModelId: ASTRA_MAX_SAFETY_MODEL,
    tools: 'disabled',
  }));
}

export function validAstraMaxConsent(value: unknown, now: number, providerId: MaxCloudProviderId = 'groq'): value is AstraMaxProviderConsentV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(now) || now < 0) return false;
  const consent = value as Record<string, unknown>;
  if (typeof consent.acceptedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(consent.acceptedAt)) return false;
  const accepted = Date.parse(consent.acceptedAt);
  return Boolean(cloudProvider(providerId))
    && (consent.agreementVersion === MAX_CLOUD_AGREEMENT || providerId === 'groq' && consent.agreementVersion === ASTRA_MAX_PROVIDER_AGREEMENT_VERSION)
    && consent.providerId === providerId
    && consent.nonLocalProcessingAcknowledged === true
    && consent.selectedContextAcknowledged === true
    && consent.providerTermsAcknowledged === true
    && Number.isFinite(accepted)
    && accepted <= now + 300_000;
}

function digest(value: string): string {
  return 'sha256:' + createHash('sha256').update(value, 'utf8').digest('hex');
}
