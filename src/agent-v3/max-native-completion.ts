import { parseCloudRole } from './max-cloud-catalog';
import type { MaxCloudHost } from './max-cloud-host';
import { randomUUID } from 'node:crypto';
import { maxCloudInputBytes } from './max-cloud-limits';
import { isMaxNativeRole, maxNativeChatOutputTokens, maxNativeModel, type MaxNativeRole } from './max-native-contract';
import {
  ASTRA_MAX_CONSERVATIVE_TEXT_BYTES,
  ASTRA_MAX_IMAGE_BYTES,
  ASTRA_MAX_IMAGE_COUNT,
  ASTRA_MAX_NATIVE_REQUEST_BYTES,
  ASTRA_MAX_TOTAL_IMAGE_BYTES,
  type AstraMaxMessageContentV1,
  type AstraMaxMessageV1,
} from './max-provider-contract';
import type { AstraMaxHostService } from './max-host-service';
import type { AstraJson } from './journal';

/** Main-process boundary: no filesystem, tools, history lookup or provider-selected actions. */
export async function completeMaxNative(host: Pick<AstraMaxHostService, 'proposePrepared'> & { proposeCloud?: MaxCloudHost['propose'] },
  value: unknown, signal?: AbortSignal): Promise<{ text: string; model: string }> {
  const fail = (code: string): never => { throw new Error('astra-max-native:' + code); };
  const { role, requestedOutputTokens, textOnly, request, cloudEffort } = prepareMaxNativeRequest(value, signal);
  const result = parseCloudRole(role)
    ? host.proposeCloud ? await host.proposeCloud({ role, messages: request.messages as AstraMaxMessageV1[], responseSchema: request.responseSchema, maxTokens: requestedOutputTokens, ...cloudEffort }, signal) : fail('not-configured')
    : await host.proposePrepared({ ...request, messages: request.messages as AstraMaxMessageV1[] });
  if (signal?.aborted) fail('cancelled');
  const answer = textOnly ? (result.value as { text?: unknown })?.text : JSON.stringify(result.value);
  if (typeof answer !== 'string' || !answer.trim()) fail('empty-output');
  const text = textOnly ? restoreDoubleEscapedLineBreaks(answer as string) : answer as string;
  return { text, model: result.modelId };
}

/** A chat answer as it is written. Connected cloud services stream plain text
 * (screened before and after); Groq keeps its sealed proposal path with the
 * dedicated safety model and arrives as one piece. */
export async function* streamMaxNative(host: Pick<AstraMaxHostService, 'proposePrepared'> & {
  proposeCloud?: MaxCloudHost['propose']; streamCloud?: MaxCloudHost['streamText'] },
  value: unknown, signal?: AbortSignal): AsyncGenerator<{ delta: string } | { done: true; model: string; stopReason: 'stop' | 'length' }, void> {
  const fail = (code: string): never => { throw new Error('astra-max-native:' + code); };
  const { role, requestedOutputTokens, textOnly, messages, cloudEffort } = prepareMaxNativeRequest(value, signal);
  const cloud = parseCloudRole(role);
  if (!cloud || !textOnly || !host.streamCloud) {
    const result = await completeMaxNative(host, value, signal);
    yield { delta: result.text };
    yield { done: true, model: result.model, stopReason: 'stop' };
    return;
  }
  if (messages.some(message => typeof message.content !== 'string')) fail('image-model-unavailable');
  const stream = host.streamCloud({ role, messages, maxTokens: requestedOutputTokens, ...cloudEffort }, signal);
  let model = cloud.model;
  let stopReason: 'stop' | 'length' = 'stop';
  while (true) {
    const next = await stream.next();
    if (signal?.aborted) fail('cancelled');
    if (next.done) {
      if (next.value?.modelId) model = next.value.modelId;
      if (next.value?.stopReason === 'length') stopReason = 'length';
      break;
    }
    yield { delta: next.value };
  }
  yield { done: true, model, stopReason };
}

function prepareMaxNativeRequest(value: unknown, signal?: AbortSignal) {
  const fail = (code: string): never => { throw new Error('astra-max-native:' + code); };
  if (signal?.aborted) fail('cancelled');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['role', 'messages', 'reasoningEffort', 'maxTokens', 'responseSchema'].includes(key))) fail('request');
  if (!isMaxNativeRole(input.role)) fail('model');
  if (input.role !== 'max-gpt-oss-120b' && !parseCloudRole(input.role)) fail('model-retired');
  const role = input.role as MaxNativeRole;
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 128) fail('messages');
  let imageCount = 0;
  let imageBytes = 0;
  let textBytes = 0;
  const messages: AstraMaxMessageV1[] = (input.messages as unknown[]).map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('messages');
    const item = message as Record<string, unknown>;
    if (Object.keys(item).some(key => key !== 'role' && key !== 'content')
      || !['system', 'user', 'assistant'].includes(String(item.role))) return fail('messages');
    const messageRole = item.role as AstraMaxMessageV1['role'];
    const content = normalizeMessageContent(item.content, messageRole, fail);
    if (typeof content === 'string') textBytes += Buffer.byteLength(content, 'utf8');
    else for (const part of content) {
      if (part.type === 'text') textBytes += Buffer.byteLength(part.text, 'utf8');
      else {
        if (role !== 'max-qwen-3.8-27b') fail('image-model-unavailable');
        imageCount += 1;
        const encoded = part.image_url.url.slice(part.image_url.url.indexOf(',') + 1);
        imageBytes += Buffer.from(encoded, 'base64').byteLength;
      }
    }
    return { role: messageRole, content };
  });
  if (textBytes > (parseCloudRole(role) ? Math.max(ASTRA_MAX_CONSERVATIVE_TEXT_BYTES, maxCloudInputBytes()) : ASTRA_MAX_CONSERVATIVE_TEXT_BYTES) || imageCount > ASTRA_MAX_IMAGE_COUNT
    || imageBytes > ASTRA_MAX_TOTAL_IMAGE_BYTES
    || Buffer.byteLength(JSON.stringify(messages)) > ASTRA_MAX_NATIVE_REQUEST_BYTES) fail('input-budget');
  if (input.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(String(input.reasoningEffort))) fail('reasoning');
  const maxOutputTokens = maxNativeChatOutputTokens(role);
  if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens)
    || Number(input.maxTokens) < 1 || Number(input.maxTokens) > maxOutputTokens)) fail('output-budget');
  const requestedOutputTokens = Number(input.maxTokens) || maxOutputTokens;
  const textOnly = input.responseSchema === undefined;
  const schema = textOnly ? { type: 'object', additionalProperties: false,
    properties: { text: { type: 'string' } }, required: ['text'] } : input.responseSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail('schema');
  const request = { requestId: 'max_' + randomUUID(), executionId: 'turn_' + randomUUID(),
    modelId: maxNativeModel(role) as 'openai/gpt-oss-120b',
    reasoningEffort: (input.reasoningEffort ?? 'medium') as 'low' | 'medium' | 'high',
    maxCompletionTokens: Math.max(2048, requestedOutputTokens),
    // Few-shot assistant history must use the same wire representation as the next
    // response. Oscar stores visible text, not this transport-only JSON envelope.
    messages: textOnly ? [{ role: 'system', content: 'Answer the user in their language. Return only a JSON object with exactly one string field named text. Previous assistant messages use this same JSON format. The text must be self-contained and visibly complete: finish every promised section and list, close code fences, and end with a concise conclusion or next step. If space is tight and the user did not ask for a specific length, compress earlier sections instead of dropping the ending; a length the user asked for outranks brevity. Do not claim to have executed actions.' },
      ...messages.map(message => message.role === 'assistant'
        ? { role: message.role, content: JSON.stringify({ text: message.content }) } : message)] : messages,
    responseSchema: schema as AstraJson, ...(signal ? { signal } : {}) };
  // A connected service keeps its own default unless the person chose a depth.
  const cloudEffort = input.reasoningEffort ? { reasoningEffort: input.reasoningEffort as 'low' | 'medium' | 'high' } : {};
  return { role, messages, requestedOutputTokens, textOnly, request, cloudEffort };
}

/** The reply travels as one JSON string. A model that escapes that string a second time hands
 * back the two characters backslash and n instead of line breaks, and the chat then shows
 * them as text with every list and heading glued into one paragraph. Real line breaks are the
 * proof the string was decoded once, so only a reply with none and several escaped ones is
 * repaired; a single `\n` in an inline explanation stays as written. */
const DOUBLE_ESCAPED_BREAKS_MIN = 3;
export function restoreDoubleEscapedLineBreaks(text: string): string {
  if (text.includes('\n')) return text;
  const escaped = text.match(/\\n/gu)?.length ?? 0;
  return escaped >= DOUBLE_ESCAPED_BREAKS_MIN ? text.replace(/\\n/gu, '\n') : text;
}

function normalizeMessageContent(value: unknown, role: AstraMaxMessageV1['role'], fail: (code: string) => never): AstraMaxMessageContentV1 {
  if (typeof value === 'string') {
    if (!value || Buffer.byteLength(value, 'utf8') > 262_144) fail('messages');
    return value;
  }
  if (!Array.isArray(value) || role !== 'user' || value.length < 2 || value.length > ASTRA_MAX_IMAGE_COUNT + 1) fail('image-message');
  let textParts = 0;
  let imageParts = 0;
  const normalized = value.map(part => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return fail('image-message');
    const item = part as Record<string, unknown>;
    if (item.type === 'text') {
      if (Object.keys(item).some(key => key !== 'type' && key !== 'text') || typeof item.text !== 'string'
        || !item.text || Buffer.byteLength(item.text, 'utf8') > 262_144) return fail('image-message');
      textParts += 1;
      return { type: 'text' as const, text: item.text };
    }
    if (item.type !== 'image_url' || Object.keys(item).some(key => key !== 'type' && key !== 'image_url')
      || !item.image_url || typeof item.image_url !== 'object' || Array.isArray(item.image_url)) return fail('image-message');
    const image = item.image_url as Record<string, unknown>;
    if (Object.keys(image).some(key => key !== 'url') || typeof image.url !== 'string') return fail('image-message');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(image.url);
    const encoded = match?.[2];
    if (typeof encoded !== 'string' || encoded.length % 4 !== 0) return fail('image-message');
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.byteLength < 1 || decoded.byteLength > ASTRA_MAX_IMAGE_BYTES
      || decoded.toString('base64') !== encoded) return fail('image-budget');
    imageParts += 1;
    return { type: 'image_url' as const, image_url: { url: image.url } };
  });
  if (textParts !== 1 || imageParts < 1 || imageParts > ASTRA_MAX_IMAGE_COUNT || normalized[0]?.type !== 'text') fail('image-message');
  return normalized;
}
