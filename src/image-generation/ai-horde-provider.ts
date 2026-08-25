import type { ImageContentRatingV1, ImageGenerationDraftV1 } from './contracts';

const DEFAULT_API_BASE_URL = 'https://aihorde.net/api/v2';
const ANONYMOUS_API_KEY = '0000000000';
const CLIENT_AGENT = 'Monarch:0.2.5:local-desktop';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_RESPONSE_BYTES = 48 * 1024 * 1024;

export interface AiHordeSubmitResult {
  requestId: string;
  kudos: number;
  message: string | null;
  warnings: string[];
}

export interface AiHordeCheckResult {
  finished: number;
  processing: number;
  restarted: number;
  waiting: number;
  done: boolean;
  faulted: boolean;
  waitTime: number;
  queuePosition: number;
  kudos: number;
  isPossible: boolean;
}

export interface AiHordeGenerationResult {
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  seed: string;
  model: string;
  censored: boolean;
  state: string;
  metadataTypes: string[];
}

export interface AiHordeStatusResult extends AiHordeCheckResult {
  shared: boolean;
  generations: AiHordeGenerationResult[];
}

export interface AiHordeProviderLike {
  submit(draft: ImageGenerationDraftV1, contentRating: ImageContentRatingV1): Promise<AiHordeSubmitResult>;
  check(requestId: string): Promise<AiHordeCheckResult>;
  status(requestId: string): Promise<AiHordeStatusResult>;
  cancel(requestId: string): Promise<void>;
}

interface AiHordeProviderOptions {
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
  clientAgent?: string;
}

export class AiHordeProvider implements AiHordeProviderLike {
  private readonly fetchFn: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly clientAgent: string;

  constructor(options: AiHordeProviderOptions = {}) {
    this.fetchFn = options.fetchFn || fetch;
    this.apiBaseUrl = String(options.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/u, '');
    this.clientAgent = options.clientAgent || CLIENT_AGENT;
  }

  async submit(draft: ImageGenerationDraftV1, contentRating: ImageContentRatingV1): Promise<AiHordeSubmitResult> {
    const dimensions = readDimensions(draft.aspectRatio);
    const prompt = formatPrompt(draft);
    const params: Record<string, unknown> = {
      sampler_name: 'k_euler_a',
      cfg_scale: 7,
      width: dimensions.width,
      height: dimensions.height,
      steps: 24,
      n: normalizeCount(draft.count),
      karras: true,
    };
    const seed = String(draft.seed || '').trim();
    if (seed) params.seed = seed.slice(0, 128);

    const payload = await this.requestJson('/generate/async', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        params,
        nsfw: contentRating === 'nsfw',
        trusted_workers: true,
        validated_backends: true,
        slow_workers: true,
        extra_slow_workers: true,
        censor_nsfw: contentRating !== 'nsfw',
        r2: false,
        shared: true,
        replacement_filter: true,
        allow_downgrade: true,
      }),
    }, 2 * 1024 * 1024);

    const requestId = normalizeRequestId(payload.id);
    return {
      requestId,
      kudos: finiteNumber(payload.kudos),
      message: typeof payload.message === 'string' && payload.message.trim() ? payload.message.trim().slice(0, 1_000) : null,
      warnings: readWarnings(payload.warnings),
    };
  }

  async check(requestId: string): Promise<AiHordeCheckResult> {
    const payload = await this.requestJson(`/generate/check/${encodeURIComponent(normalizeRequestId(requestId))}`);
    return normalizeCheck(payload);
  }

  async status(requestId: string): Promise<AiHordeStatusResult> {
    const payload = await this.requestJson(`/generate/status/${encodeURIComponent(normalizeRequestId(requestId))}`);
    const generations = Array.isArray(payload.generations)
      ? payload.generations.map(readGeneration)
      : [];
    return {
      ...normalizeCheck(payload),
      shared: payload.shared === true,
      generations,
    };
  }

  async cancel(requestId: string): Promise<void> {
    await this.requestJson(`/generate/status/${encodeURIComponent(normalizeRequestId(requestId))}`, { method: 'DELETE' }, 2 * 1024 * 1024);
  }

  private async requestJson(pathname: string, init: RequestInit = {}, maxBytes = MAX_JSON_RESPONSE_BYTES): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(`${this.apiBaseUrl}${pathname}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          apikey: ANONYMOUS_API_KEY,
          'Client-Agent': this.clientAgent,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
        redirect: 'error',
        signal: controller.signal,
      });
      const payload = await readBoundedJson(response, maxBytes);
      if (!response.ok) {
        const message = typeof payload.message === 'string' && payload.message.trim()
          ? payload.message.trim()
          : `AI Horde returned HTTP ${response.status}.`;
        throw new AiHordeProviderError(response.status, providerErrorCode(response.status), message);
      }
      return payload;
    } catch (error) {
      if (error instanceof AiHordeProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiHordeProviderError(504, 'provider-timeout', 'AI Horde did not respond before the request timeout.');
      }
      throw new AiHordeProviderError(502, 'provider-unavailable', error instanceof Error ? error.message : 'AI Horde is unavailable.');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class AiHordeProviderError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AiHordeProviderError';
  }
}

function formatPrompt(draft: ImageGenerationDraftV1): string {
  const promptParts = [String(draft.prompt || '').trim()];
  const style = String(draft.style || '').trim();
  if (style && style !== 'none') promptParts.push(`style: ${style}`);
  const positive = promptParts.filter(Boolean).join(', ');
  const negative = String(draft.negativePrompt || '').trim();
  return negative ? `${positive} ### ${negative}` : positive;
}

function readDimensions(value: unknown): { width: number; height: number } {
  switch (String(value || '1:1')) {
    case '16:9': return { width: 896, height: 512 };
    case '9:16': return { width: 512, height: 896 };
    case '4:5': return { width: 640, height: 768 };
    case '3:2': return { width: 768, height: 512 };
    default: return { width: 768, height: 768 };
  }
}

function normalizeCount(value: unknown): number {
  const count = Math.trunc(Number(value || 1));
  return Number.isFinite(count) ? Math.min(4, Math.max(1, count)) : 1;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AiHordeProviderError(502, 'provider-response-too-large', 'AI Horde returned a response larger than Monarch accepts.');
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AiHordeProviderError(502, 'provider-response-too-large', 'AI Horde returned a response larger than Monarch accepts.');
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AiHordeProviderError(502, 'provider-invalid-response', 'AI Horde returned malformed JSON.');
  }
}

function normalizeCheck(payload: Record<string, unknown>): AiHordeCheckResult {
  return {
    finished: finiteNumber(payload.finished),
    processing: finiteNumber(payload.processing),
    restarted: finiteNumber(payload.restarted),
    waiting: finiteNumber(payload.waiting),
    done: payload.done === true,
    faulted: payload.faulted === true,
    waitTime: Math.max(0, finiteNumber(payload.wait_time)),
    queuePosition: Math.max(0, finiteNumber(payload.queue_position)),
    kudos: finiteNumber(payload.kudos),
    isPossible: payload.is_possible !== false,
  };
}

function readGeneration(value: unknown): AiHordeGenerationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiHordeProviderError(502, 'provider-invalid-result', 'AI Horde returned an invalid generation record.');
  }
  const source = value as Record<string, unknown>;
  const encoded = typeof source.img === 'string' ? source.img.trim() : '';
  if (!encoded || /^https?:\/\//iu.test(encoded)) {
    throw new AiHordeProviderError(502, 'provider-remote-result-rejected', 'AI Horde did not return the requested inline image data.');
  }
  const bytes = decodeBase64Image(encoded);
  return {
    bytes,
    mimeType: detectImageMimeType(bytes),
    seed: String(source.seed || '').slice(0, 256),
    model: String(source.model || '').trim().slice(0, 256),
    censored: source.censored === true,
    state: String(source.state || '').trim().toLocaleLowerCase('en-US'),
    metadataTypes: readMetadataTypes(source.gen_metadata),
  };
}

function decodeBase64Image(value: string): Buffer {
  const comma = value.indexOf(',');
  const encoded = value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/u.test(encoded) || encoded.length > 32 * 1024 * 1024) {
    throw new AiHordeProviderError(502, 'provider-invalid-image', 'AI Horde returned invalid image data.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.byteLength > 24 * 1024 * 1024) {
    throw new AiHordeProviderError(502, 'provider-invalid-image', 'AI Horde returned an empty or oversized image.');
  }
  return bytes;
}

function detectImageMimeType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  throw new AiHordeProviderError(502, 'provider-invalid-image', 'AI Horde returned bytes that are not a supported image.');
}

function readMetadataTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const type = String((entry as Record<string, unknown>).type || '').trim().toLocaleLowerCase('en-US');
    return type ? [type.slice(0, 128)] : [];
  });
}

function readWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry.trim().slice(0, 1_000)];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const message = typeof source.message === 'string' ? source.message.trim() : '';
    return message ? [message.slice(0, 1_000)] : [];
  });
}

function normalizeRequestId(value: unknown): string {
  const id = String(value || '').trim();
  if (!/^[a-f0-9-]{16,64}$/iu.test(id)) {
    throw new AiHordeProviderError(502, 'provider-invalid-request-id', 'AI Horde returned an invalid request id.');
  }
  return id;
}

function finiteNumber(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function providerErrorCode(status: number): string {
  if (status === 404) return 'provider-job-not-found';
  if (status === 429) return 'provider-rate-limited';
  if (status === 503) return 'provider-busy';
  if (status >= 400 && status < 500) return 'provider-request-rejected';
  return 'provider-unavailable';
}
