import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { astraJournalJson, type AstraJson } from './journal';
import {
  ASTRA_MAX_PRIMARY_MODELS,
  ASTRA_MAX_CONSERVATIVE_TEXT_BYTES,
  ASTRA_MAX_CONTEXT_SAFETY_TOKENS,
  ASTRA_MAX_IMAGE_BYTES,
  ASTRA_MAX_IMAGE_COUNT,
  ASTRA_MAX_IMAGE_INPUT_TOKENS,
  ASTRA_MAX_NATIVE_REQUEST_BYTES,
  ASTRA_MAX_PROVIDER_ID,
  ASTRA_MAX_SAFETY_MODEL,
  astraMaxInputDigest,
  astraMaxModelLimits,
  astraMaxOutputDigest,
  validAstraMaxConsent,
  type AstraMaxDeployment,
  type AstraMaxMessageV1,
  type AstraMaxProposalRequestV1,
  type AstraMaxProposalV1,
} from './max-provider-contract';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_REQUEST_BYTES = ASTRA_MAX_NATIVE_REQUEST_BYTES;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// A 429 is refused before generation and is not billed. Groq names the exact
// wait in `retry-after`; an agent loop on a per-minute token budget needs that
// pause, not a failed task. Longer waits (daily quotas) stay failures.
const RATE_LIMIT_MAX_RETRIES = 8;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;
const SAFETY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['allow', 'block'] },
    reasonCode: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' },
    summary: { type: 'string', maxLength: 240 },
  },
  required: ['decision', 'reasonCode', 'summary'],
}) as unknown as AstraJson;
const SAFETY_POLICY = [
  'You are the safety classification stage for Monarch Astra MAX.',
  'Classify the supplied payload using applicable Groq policies and this local rule:',
  'block requests or outputs that meaningfully facilitate malware, credential theft, evasion,',
  'non-consensual access, sexual abuse, or instructions to harm a person. Allow benign analysis,',
  'defensive security, ordinary coding, and transformations that do not increase harmful capability.',
  'Return only the requested JSON object. This verdict grants no tool or execution authority.',
].join(' ');

export class AstraMaxProviderError extends Error {
  constructor(readonly code: string, readonly statusCode = 0) {
    super('astra-max-provider:' + code);
    this.name = 'AstraMaxProviderError';
  }
}

export interface AstraGroqMaxProviderOptions {
  deployment: AstraMaxDeployment;
  resolveApiKey: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Test seam for the bounded rate-limit wait; defaults to a real timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface GroqCompletion {
  content: string;
  finishReason: 'stop';
}

export class AstraGroqMaxProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly ajv = new Ajv2020({ strict: true, allErrors: true });

  constructor(private readonly options: AstraGroqMaxProviderOptions) {
    check(['isolated-validation', 'source-preview', 'native-desktop'].includes(options.deployment), 'deployment');
    check(typeof options.resolveApiKey === 'function', 'credential-resolver');
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 480_000;
    this.sleep = options.sleep ?? abortableDelay;
    check(integer(this.timeoutMs, 1_000, 600_000), 'timeout');
  }

  descriptor() {
    return Object.freeze({
      providerId: ASTRA_MAX_PROVIDER_ID,
      endpoint: GROQ_CHAT_COMPLETIONS_URL,
      primaryModels: [...ASTRA_MAX_PRIMARY_MODELS],
      safetyModel: ASTRA_MAX_SAFETY_MODEL,
      authority: 'none' as const,
      tools: 'disabled' as const,
      productActivation: false,
    });
  }

  /** Explicit connection check; never called by status polling or ordinary local turns. */
  async checkConnection(signal?: AbortSignal): Promise<string[]> {
    const apiKey = await this.options.resolveApiKey();
    check(typeof apiKey === 'string' && /^[\x21-\x7e]{20,512}$/u.test(apiKey), 'credential-invalid');
    const timeout = AbortSignal.timeout(20_000);
    let response: Response;
    try {
      response = await this.fetchFn('https://api.groq.com/openai/v1/models', {
        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Authorization: 'Bearer ' + apiKey },
      });
    } catch { throw new AstraMaxProviderError(signal?.aborted ? 'caller-cancelled'
      : timeout.aborted ? 'provider-timeout' : 'provider-unavailable', 502); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AstraMaxProviderError(httpError(response.status), response.status);
    }
    const value = await boundedJson(response, 256 * 1024);
    check(record(value) && Array.isArray(value.data), 'provider-models');
    const ids = value.data.filter(record).filter(item => item.active !== false).map(item => item.id)
      .filter((id): id is string => typeof id === 'string');
    check(ids.includes(ASTRA_MAX_SAFETY_MODEL), 'safety-model-unavailable');
    const available = ASTRA_MAX_PRIMARY_MODELS.filter(id => ids.includes(id));
    check(available.length > 0, 'model-not-available');
    return [...available];
  }

  async propose(input: AstraMaxProposalRequestV1, signal?: AbortSignal): Promise<AstraMaxProposalV1> {
    this.validateRequest(input);
    const schema = JSON.parse(astraJournalJson(input.responseSchema)) as AstraJson;
    const transport = groqStrictTransport(schema);
    assertGroqStrictSchema(transport.schema);
    const validate = compile(this.ajv, schema, 'response-schema');
    const validateTransport = compile(this.ajv, transport.schema, 'response-transport-schema');
    let apiKey: string;
    try {
      apiKey = await this.options.resolveApiKey();
    } catch {
      throw new AstraMaxProviderError('credential-unavailable');
    }
    check(typeof apiKey === 'string' && /^[\x21-\x7e]{20,512}$/u.test(apiKey), 'credential-invalid');

    await this.screen('input', safetyInputProjection(input.messages), apiKey, signal);
    const completion = await this.complete({
      model: input.modelId,
      messages: input.messages,
      reasoning_effort: input.reasoningEffort,
      ...(input.modelId === 'openai/gpt-oss-120b' ? { include_reasoning: false } : { reasoning_format: 'hidden' }),
      temperature: input.modelId === 'qwen/qwen3.8-27b' ? 1 : 0.6,
      top_p: 0.95,
      max_completion_tokens: input.maxCompletionTokens,
      parallel_tool_calls: false,
      tool_choice: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'monarch_astra_max_proposal', strict: true, schema: transport.schema },
      },
    }, apiKey, signal, 'primary');
    const wireValue = parseJson(completion.content, 'proposal-json');
    check(validateTransport(wireValue), transport.enveloped ? 'proposal-transport-schema' : 'proposal-schema');
    const value = transport.unwrap(wireValue);
    check(validate(value), 'proposal-schema');
    const copied = JSON.parse(astraJournalJson(value as AstraJson)) as AstraJson;
    await this.screen('output', copied, apiKey, signal);
    return Object.freeze({
      authority: 'none',
      providerId: ASTRA_MAX_PROVIDER_ID,
      modelId: input.modelId,
      safetyModelId: ASTRA_MAX_SAFETY_MODEL,
      requestId: input.requestId,
      executionId: input.executionId,
      inputDigest: astraMaxInputDigest(input),
      outputDigest: astraMaxOutputDigest(copied),
      finishReason: completion.finishReason,
      value: copied,
    });
  }

  private validateRequest(input: AstraMaxProposalRequestV1): void {
    check(record(input), 'request');
    check(id(input.requestId) && id(input.executionId), 'identity');
    check((ASTRA_MAX_PRIMARY_MODELS as readonly string[]).includes(input.modelId), 'model-not-allowed');
    check(['low', 'medium', 'high'].includes(input.reasoningEffort), 'reasoning-effort');
    const limits = astraMaxModelLimits(input.modelId);
    check(integer(input.maxCompletionTokens, 1, limits.maxOutputTokens), 'output-budget');
    check(Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 64, 'messages');
    let textBytes = 0;
    let imageCount = 0;
    let imageBytes = 0;
    for (const message of input.messages) {
      const raw: unknown = message;
      check(record(raw) && typeof raw.role === 'string' && new Set(['system', 'user', 'assistant']).has(raw.role), 'message');
      const metrics = messageMetrics(raw.content, raw.role as AstraMaxMessageV1['role'], input.modelId);
      textBytes += metrics.textBytes;
      imageCount += metrics.imageCount;
      imageBytes += metrics.imageBytes;
    }
    check(imageCount <= ASTRA_MAX_IMAGE_COUNT && imageBytes <= ASTRA_MAX_IMAGE_COUNT * ASTRA_MAX_IMAGE_BYTES, 'image-budget');
    check(record(input.responseSchema), 'response-schema');
    const schemaBytes = Buffer.byteLength(astraJournalJson(input.responseSchema), 'utf8');
    check(textBytes <= ASTRA_MAX_CONSERVATIVE_TEXT_BYTES
      && textBytes + schemaBytes + imageCount * ASTRA_MAX_IMAGE_INPUT_TOKENS
        + input.maxCompletionTokens + ASTRA_MAX_CONTEXT_SAFETY_TOKENS <= limits.contextWindowTokens,
    'input-budget');
    check(schemaBytes <= 24_000, 'response-schema');
    check(validAstraMaxConsent(input.consent, this.now()), 'consent-required');
  }

  private async screen(stage: 'input' | 'output', content: AstraJson, apiKey: string, signal?: AbortSignal): Promise<void> {
    const completion = await this.complete({
      model: ASTRA_MAX_SAFETY_MODEL,
      messages: [
        { role: 'system', content: SAFETY_POLICY },
        { role: 'user', content: astraJournalJson({ stage, content } as unknown as AstraJson) },
      ],
      temperature: 0.1,
      top_p: 1,
      max_completion_tokens: 512,
      parallel_tool_calls: false,
      tool_choice: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'monarch_astra_max_safety', strict: false, schema: SAFETY_SCHEMA },
      },
    }, apiKey, signal, 'safety-' + stage);
    const verdict = parseJson(completion.content, 'safety-json');
    const validate = compile(this.ajv, SAFETY_SCHEMA, 'safety-schema');
    check(validate(verdict), 'safety-schema');
    const decision = (verdict as Record<string, unknown>).decision;
    if (decision !== 'allow') throw new AstraMaxProviderError('safety-blocked-' + stage, 403);
  }

  private async complete(body: Record<string, unknown>, apiKey: string, signal?: AbortSignal, stage = 'primary'): Promise<GroqCompletion> {
    const serialized = JSON.stringify(body);
    check(Buffer.byteLength(serialized, 'utf8') <= MAX_REQUEST_BYTES, 'provider-request-budget');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetchFn(GROQ_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: serialized,
        });
      } catch {
        throw new AstraMaxProviderError(signal?.aborted ? 'caller-cancelled'
          : timeout.aborted ? 'provider-timeout' : 'provider-unavailable', 502);
      }
      const wait = response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES
        ? retryAfterMs(response.headers.get('retry-after')) : undefined;
      if (wait === undefined) break;
      await response.body?.cancel().catch(() => undefined);
      try { await this.sleep(wait, combined); } catch {
        throw new AstraMaxProviderError(signal?.aborted ? 'caller-cancelled' : 'provider-timeout', 502);
      }
    }
    if (!response.ok) {
      // Classify only a closed set of provider codes. Never retain message,
      // failed_generation, request bodies or credentials from provider errors.
      let code = httpError(response.status);
      if (response.status === 400) {
        try {
          const body = await boundedJson(response, 64 * 1024);
          const providerCode = record(body) && record(body.error) ? body.error.code : null;
          if (providerCode === 'json_validate_failed') code = 'json-validation-failed';
          if (providerCode === 'context_length_exceeded') code = 'context-too-large';
        } catch { /* Keep the bounded generic status classification. */ }
        code = stage + '-' + code;
      } else await response.body?.cancel().catch(() => undefined);
      throw new AstraMaxProviderError(code, response.status);
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      await response.body?.cancel().catch(() => undefined);
      throw new AstraMaxProviderError('provider-content-type', 502);
    }
    const value = await boundedJson(response, MAX_RESPONSE_BYTES);
    check(record(value), 'provider-response');
    check(Array.isArray(value.choices) && value.choices.length === 1, 'provider-choices');
    const choice = value.choices[0];
    check(record(choice), 'provider-choice');
    const message = choice.message;
    check(record(message), 'provider-message');
    check(typeof message.content === 'string' && Buffer.byteLength(message.content, 'utf8') > 0
      && Buffer.byteLength(message.content, 'utf8') <= 1024 * 1024 && !('tool_calls' in message), 'provider-content');
    if (choice.finish_reason === 'length') throw new AstraMaxProviderError('provider-output-truncated', 502);
    check(choice.finish_reason === 'stop', 'provider-finish');
    return { content: message.content, finishReason: choice.finish_reason };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function check(value: unknown, code: string): asserts value {
  if (!value) throw new AstraMaxProviderError(code);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function messageMetrics(content: unknown, role: AstraMaxMessageV1['role'], modelId: string): {
  textBytes: number; imageCount: number; imageBytes: number;
} {
  if (typeof content === 'string') {
    check(Buffer.byteLength(content, 'utf8') > 0 && Buffer.byteLength(content, 'utf8') <= 262_144, 'message');
    return { textBytes: Buffer.byteLength(content, 'utf8'), imageCount: 0, imageBytes: 0 };
  }
  check(modelId === 'qwen/qwen3.8-27b', 'image-model-unavailable');
  check(role === 'user' && Array.isArray(content)
    && content.length >= 2 && content.length <= ASTRA_MAX_IMAGE_COUNT + 1, 'image-message');
  let textBytes = 0;
  let textCount = 0;
  let imageCount = 0;
  let imageBytes = 0;
  for (const part of content) {
    check(record(part), 'image-message');
    if (part.type === 'text') {
      check(Object.keys(part).every(key => key === 'type' || key === 'text') && typeof part.text === 'string'
        && Buffer.byteLength(part.text, 'utf8') > 0 && Buffer.byteLength(part.text, 'utf8') <= 262_144, 'image-message');
      textCount += 1;
      textBytes += Buffer.byteLength(part.text, 'utf8');
      continue;
    }
    check(part.type === 'image_url' && Object.keys(part).every(key => key === 'type' || key === 'image_url')
      && record(part.image_url) && Object.keys(part.image_url).every(key => key === 'url')
      && typeof part.image_url.url === 'string', 'image-message');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(part.image_url.url);
    const encoded = match?.[2];
    check(typeof encoded === 'string' && encoded.length % 4 === 0, 'image-message');
    const bytes = Buffer.from(encoded, 'base64');
    check(bytes.byteLength > 0 && bytes.byteLength <= ASTRA_MAX_IMAGE_BYTES
      && bytes.toString('base64') === encoded, 'image-budget');
    imageCount += 1;
    imageBytes += bytes.byteLength;
  }
  check(textCount === 1 && imageCount >= 1 && (content[0] as Record<string, unknown>)?.type === 'text', 'image-message');
  return { textBytes, imageCount, imageBytes };
}

function safetyInputProjection(messages: readonly AstraMaxMessageV1[]): AstraJson {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content.map((part, index) => part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'selected-image', index, mediaType: /^data:([^;]+);/u.exec(part.image_url.url)?.[1] || 'image' }),
  })) as unknown as AstraJson;
}

function compile(ajv: Ajv2020, schema: AstraJson, code: string): ValidateFunction {
  try { return ajv.compile(schema as object); }
  catch { throw new AstraMaxProviderError(code); }
}

function assertGroqStrictSchema(schema: AstraJson): void {
  check(record(schema) && schema.type === 'object', 'response-schema-root');
  const visit = (value: unknown): void => {
    if (!record(value)) return;
    if (value.type === 'object') {
      check(value.additionalProperties === false && record(value.properties), 'response-schema-strict-object');
      const keys = Object.keys(value.properties);
      check(Array.isArray(value.required) && value.required.length === keys.length
        && keys.every(key => (value.required as unknown[]).includes(key)), 'response-schema-strict-required');
      Object.values(value.properties).forEach(visit);
    }
    if (value.type === 'array') visit(value.items);
    if (Array.isArray(value.anyOf)) value.anyOf.forEach(visit);
    if (Array.isArray(value.oneOf)) value.oneOf.forEach(visit);
  };
  visit(schema);
}

/** Groq strict output requires an object root and documents `anyOf`, while
 * Astra's authority-neutral decision ABI deliberately uses a root `oneOf`.
 * Keep the original ABI as the local validation authority and use one closed
 * transport envelope only when the root is a union. Converting `const` to a
 * singleton enum and `oneOf` to `anyOf` stays within Groq's documented subset;
 * the original AJV validation still rejects any semantic widening.
 */
export function groqStrictTransport(schema: AstraJson): { schema: AstraJson; enveloped: boolean; unwrap: (value: unknown) => unknown } {
  const normalized = normalizeGroqSchema(schema);
  if (record(normalized) && normalized.type === 'object') {
    return { schema: normalized, enveloped: false, unwrap: value => value };
  }
  if (!record(normalized) || (!Array.isArray(normalized.anyOf) && !Array.isArray(normalized.oneOf))) {
    throw new AstraMaxProviderError('response-schema-root');
  }
  const keys = Object.keys(normalized);
  check(keys.every(key => ['anyOf', 'oneOf', 'title', 'description', '$schema'].includes(key)), 'response-schema-root');
  const alternatives = (normalized.anyOf ?? normalized.oneOf) as unknown[];
  check(alternatives.length > 0 && alternatives.length <= 32
    && alternatives.every(item => record(item) && item.type === 'object'), 'response-schema-root');
  const transport = {
    type: 'object',
    properties: { proposal: { anyOf: alternatives } },
    required: ['proposal'],
    additionalProperties: false,
  } as unknown as AstraJson;
  return {
    schema: transport,
    enveloped: true,
    unwrap: value => {
      check(record(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'proposal'), 'proposal-transport-schema');
      return value.proposal;
    },
  };
}

function normalizeGroqSchema(value: AstraJson): AstraJson {
  if (Array.isArray(value)) return value.map(item => normalizeGroqSchema(item)) as AstraJson;
  if (!record(value)) return value;
  const result: Record<string, AstraJson> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'const') {
      check(!Object.hasOwn(value, 'enum'), 'response-schema-const-enum');
      result.enum = [normalizeGroqSchema(item as AstraJson)] as AstraJson;
    } else if (key === 'oneOf') {
      check(!Object.hasOwn(value, 'anyOf') && Array.isArray(item), 'response-schema-union');
      result.anyOf = item.map(entry => normalizeGroqSchema(entry)) as AstraJson;
    } else result[key] = normalizeGroqSchema(item as AstraJson);
  }
  return result as AstraJson;
}

function parseJson(value: string, code: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new AstraMaxProviderError(code, 502); }
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  check(reader, 'provider-body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new AstraMaxProviderError('provider-response-budget', 502);
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new AstraMaxProviderError('provider-json', 502); }
}

/** Exact provider-named wait, bounded; anything absent, malformed or longer
 * than one minute is left to the ordinary rate-limited failure. */
function retryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\d+(\.\d+)?$/u.test(value.trim())) return undefined;
  const ms = Math.ceil(Number(value.trim()) * 1000);
  return Number.isFinite(ms) && ms >= 0 && ms <= RATE_LIMIT_MAX_WAIT_MS ? Math.max(ms, 250) : undefined;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function httpError(status: number): string {
  if (status === 400) return 'provider-request-rejected';
  if (status === 401 || status === 403) return 'credential-rejected';
  if (status === 429) return 'provider-rate-limited';
  if (status >= 500) return 'provider-unavailable';
  return 'provider-rejected';
}
