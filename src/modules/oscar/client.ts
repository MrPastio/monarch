import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { renameWithWindowsRetrySync } from '../../core/durable-json';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { AstraModelHostBinding } from '../../agent-v3/model-host-provider';
import { resolveMonarchRuntimePaths, stableStringify } from '../../core';
import { securityPolicyFilePath } from '../../settings/security-policy';
import { oscarStorageEnvironment } from '../../core/store-protection';
import { hasWorkingNvidiaRuntime } from './runtime-profile';
import { CUSTOM_MODELS_DIRECTORY } from '../models/custom-models';
import { MONARCH_CODER_MODEL_COMPONENTS, MONARCH_OPTIONAL_BALANCED_MODEL,
  MONARCH_REQUIRED_FAST_MODEL } from '../models/component-manager';
import type {
  MonarchSettingsCommandRequestV1,
  MonarchSettingsReadRequestV1,
  MonarchSettingsReadResultV1,
  MonarchSettingsWriteReceiptV1,
} from '../../settings/contracts';

const DEFAULT_OSCAR_API_TIMEOUT_MS = 30000;
const DEFAULT_OSCAR_CHAT_TIMEOUT_MS = 300000;
/** Silence allowed between two chunks of a local answer stream, and its hard cap. */
const OSCAR_STREAM_IDLE_MS = 120_000;
const OSCAR_STREAM_TOTAL_MS = 30 * 60_000;
const DEFAULT_OSCAR_DEEP_RESEARCH_TIMEOUT_MS = 1800000;
const MAX_OSCAR_NEW_TOKENS = 65_536;

export type OscarChatRole = 'system' | 'user' | 'assistant';

export interface OscarChatMessage {
  role: OscarChatRole;
  content: string;
}

export interface OscarAgentSkillContext {
  name: string;
  description: string;
  instructions: string;
  source: string;
  explicit: boolean;
}

export interface OscarChatRequest {
  messages: OscarChatMessage[];
  conversation_id?: string;
  incognito?: boolean;
  image_attachments?: unknown[];
  web_search?: boolean;
  research_mode?: 'auto' | 'off' | 'deep';
  use_memory: boolean;
  context_profile?: 'full' | 'compact-social';
  reasoning_effort: 'low' | 'medium' | 'high';
  requested_model?: string;
  model_selection_source?: 'auto' | 'user-explicit' | 'fallback' | 'recovery';
  deep_thinking_consent?: 'allow' | 'deny';
  max_new_tokens: number;
  temperature: number;
  top_p: number;
  route?: OscarRouteHint;
  skills?: OscarAgentSkillContext[];
  inference_lane?: 'interactive' | 'agent' | 'coder' | 'background';
  execution_authority: 'none';
  persistence_owner: 'backend' | 'coordinator';
  turn_id?: string;
  client_message_id?: string;
  dev_mode?: {
    zero_retention: boolean;
    internet_enabled: boolean;
    memory_enabled: boolean;
    history_context_enabled: boolean;
    personality_enabled: boolean;
    skills_enabled: boolean;
    runtime_context_enabled: boolean;
    quality_regeneration_enabled: boolean;
  };
}

export interface OscarRawChatCompletionRequest {
  model: string;
  messages: OscarChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
  response_format?: { type: 'text' | 'json_object'; schema?: Record<string, unknown> };
  inference_lane?: 'interactive' | 'agent' | 'coder' | 'background';
  agent_session_id?: string;
}

export interface OscarChatRoutePreview {
  selected_model: string;
  fallback_model?: string | null;
  auto_selected: boolean;
  deep_thinking: boolean;
  requires_confirmation: boolean;
  web_search: boolean;
  search_reason: string;
  research_mode: 'off' | 'standard' | 'deep';
  research_reason: string;
  research_score: number;
  ram_available_gb?: number | null;
  estimated_ram_required_gb?: number | null;
  projected_ram_available_gb?: number | null;
  ram_warning?: 'none' | 'caution' | 'critical';
  ram_warning_message?: string | null;
  configured_context_tokens?: number | null;
  effective_context_tokens?: number | null;
  adaptive_context_applied?: boolean;
}

export interface OscarImageAttachment {
  mime_type: string;
  data_base64: string;
  name: string;
  size_bytes: number;
}

export interface OscarRouteHint {
  intentKind?: string;
  modelTier?: string;
  riskHint?: string;
  language?: string;
}

export function resolveOscarChatTimeoutMs(
  request: Pick<OscarChatRequest, 'research_mode'>,
  chatTimeoutMs: number,
  deepResearchTimeoutMs: number,
): number {
  return request.research_mode === 'deep'
    ? Math.max(chatTimeoutMs, deepResearchTimeoutMs)
    : chatTimeoutMs;
}

export interface OscarClientOptions {
  apiBase?: string;
  projectRoot?: string;
  workspaceRoot?: string;
  logsRoot?: string;
  secretsRoot?: string;
  timeoutMs?: number;
  chatTimeoutMs?: number;
  deepResearchTimeoutMs?: number;
  autoStart?: boolean;
}

export interface OscarBridgeConfig {
  apiBase: string;
  projectRoot: string;
  logsRoot: string;
  timeoutMs: number;
  chatTimeoutMs: number;
  deepResearchTimeoutMs: number;
  autoStart: boolean;
  apiToken: string;
}

function getOrCreateOscarToken(secretsDir: string): string {
  const tokenFile = path.join(secretsDir, 'oscar_token.txt');

  if (existsSync(tokenFile)) {
    try {
      const existing = readFileSync(tokenFile, 'utf8').trim();
      if (existing) {
        return existing;
      }
    } catch {
      // Proceed to generate
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  try {
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(tokenFile, token, 'utf8');
  } catch {
    // Fail silently if directories are read-only
  }
  return token;
}

export interface OscarBackendStatus {
  connected: boolean;
  apiBase: string;
  projectRoot: string;
  autoStart: boolean;
  startupAttempted: boolean;
  timeoutMs: number;
  chatTimeoutMs: number;
  deepResearchTimeoutMs: number;
  health?: unknown;
  modelStatus?: unknown;
  memoryStats?: unknown;
  hardware?: unknown;
  error?: string;
}

export interface OscarStatusOptions {
  autoStart?: boolean;
}

export interface OscarConversationMessageAppendResult {
  ok: true;
  disposition: 'created' | 'duplicate' | 'superseded';
  message: Record<string, unknown> | null;
  duplicate: boolean;
}

export interface OscarConversationMessageAppendInput {
  role: 'user' | 'assistant';
  content: string;
  content_mode?: 'exact';
  token_count?: number;
  elapsed_ms?: number;
  model_tier?: string;
  client_message_id?: string;
  turn_id?: string;
  task_id?: string;
  provenance?: Record<string, unknown>;
  outcome?: string;
  integrity_warning?: string;
  /** MAX did not answer and the local model did; why, as a failure code. */
  max_fallback_code?: string;
  research_steps?: Array<{ kind: 'plan' | 'search' | 'read' | 'verify' | 'write'; detail: string }>;
  create_conversation_if_missing?: boolean;
  required_previous_message_id?: string;
  causal_parent_id?: string;
  attachments?: Array<Record<string, unknown>>;
  sources?: Array<Record<string, unknown>>;
}

export interface OscarMemoryEpisodeIndexRequest {
  schemaVersion: 1;
  source: 'desktop' | 'coder';
  scope: { type: 'chat' } | { type: 'coder-project'; projectId: string };
  conversationId: string;
  turnId: string;
  projectName?: string;
  userText?: string;
  assistantText?: string;
  structuredSummary?: Record<string, unknown>;
}

export class OscarBackendHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OscarBackendHttpError';
  }
}

export class OscarClient {
  readonly config: OscarBridgeConfig;
  private readonly astraHostProcesses = new Map<string, { pid: number; child: ChildProcess }>();

  astraHostExited(binding: AstraModelHostBinding): boolean {
    const owned = this.astraHostProcesses.get(binding.hostGeneration);
    return !!owned && owned.pid === binding.hostPid && observedManagedBackendExits.has(owned.child);
  }

  /** Discover only our existing authenticated local owner. No model load. */
  async astraLocalModelHost() {
    if (process.env.MONARCH_ASTRA_V3_MODEL_MODE !== 'managed-local'
      || process.env.MONARCH_ASTRA_V3_PILOT !== 'runtime-same-owner-v1') throw Error('astra-local-host-not-enabled');
    const endpoint = new URL(this.config.apiBase);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/'
      || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw Error('astra-local-host-loopback-required');
    }
    await this.ensureBackendAvailable();
    const descriptorChild = managedBackendProcess;
    const raw = await this.getJson('/internal/astra/v3/model-descriptor') as Record<string, unknown>;
    const allowed = [MONARCH_REQUIRED_FAST_MODEL, ...(MONARCH_REQUIRED_FAST_MODEL.acceptedExistingVariants ?? [])];
    const modelDigests = raw.modelDigests as Record<string, unknown> | undefined;
    const localSpecs = [MONARCH_REQUIRED_FAST_MODEL, MONARCH_OPTIONAL_BALANCED_MODEL, ...MONARCH_CODER_MODEL_COMPONENTS];
    const localKeys: string[] = localSpecs.map(spec => spec.role);
    const advertisedKeys = modelDigests ? Object.keys(modelDigests) : [];
    const digestMatchesCatalog = (role: string, digest: unknown) => localSpecs.some(spec => spec.role === role
      && [spec, ...(spec.acceptedExistingVariants ?? [])].some(variant => digest === 'sha256:' + variant.sha256));
    if (!raw || raw.schemaVersion !== 1 || raw.configurationOnly !== true || raw.authority !== 'none'
      || raw.memoryGuard !== 'chat-validity-v1' || typeof raw.hostGeneration !== 'string'
      || !/^[A-Za-z0-9_-]{1,96}$/u.test(raw.hostGeneration)
      || !allowed.some(variant => 'sha256:' + variant.sha256 === raw.modelDigest)
      || !modelDigests || advertisedKeys.length < 1 || advertisedKeys.length > localKeys.length
      || advertisedKeys.some(key => !localKeys.includes(key) || !digestMatchesCatalog(key, modelDigests[key]))
      || modelDigests['gemma4-fast'] !== raw.modelDigest
      || new Set(Object.values(modelDigests)).size !== advertisedKeys.length) throw Error('astra-local-host-descriptor');
    if (raw.hostPid !== undefined && (!Number.isSafeInteger(raw.hostPid) || Number(raw.hostPid) < 1))
      throw Error('astra-local-host-pid');
    const child = managedBackendProcess;
    if (child && child === descriptorChild && !observedManagedBackendExits.has(child)
      && child.pid === raw.hostPid && !this.astraHostProcesses.has(raw.hostGeneration)) {
      if (this.astraHostProcesses.size >= 256) throw Error('astra-local-host-history-budget');
      this.astraHostProcesses.set(raw.hostGeneration, { pid: child.pid!, child });
    }
    return { endpoint: endpoint.origin, bearerToken: this.config.apiToken,
      ...(typeof raw.hostPid === 'number' ? { hostPid: raw.hostPid } : {}),
      hostGeneration: raw.hostGeneration, modelDigest: raw.modelDigest as string,
      modelDigests: modelDigests as { 'gemma4-fast': string; 'gemma4-balanced'?: string;
        'qwen3-coder-30b-a3b-instruct'?: string; 'deepseek-coder-v2-lite-instruct'?: string } };
  }

  constructor(options: OscarClientOptions = {}) {
    const configuredApiBase = options.apiBase || process.env.OSCAR_API_BASE;
    const projectRoot = path.resolve(options.projectRoot || process.env.OSCAR_PROJECT_ROOT || defaultOscarProjectRoot());
    const workspaceRoot = path.resolve(options.workspaceRoot || path.dirname(projectRoot));
    const runtimePaths = resolveMonarchRuntimePaths(workspaceRoot);
    // Desktop owns the key as an encrypted record and passes it in; only a
    // standalone runtime falls back to the legacy secrets file.
    const apiToken = process.env.OSCAR_API_TOKEN?.trim()
      || getOrCreateOscarToken(path.resolve(options.secretsRoot || runtimePaths.secretsRoot));

    this.config = {
      apiBase: normalizeApiBase(configuredApiBase || 'http://127.0.0.1:7861'),
      projectRoot,
      logsRoot: path.resolve(options.logsRoot || runtimePaths.logsRoot),
      timeoutMs: readConfiguredTimeout(options.timeoutMs, 'OSCAR_API_TIMEOUT_MS', DEFAULT_OSCAR_API_TIMEOUT_MS),
      chatTimeoutMs: readConfiguredTimeout(options.chatTimeoutMs, 'OSCAR_CHAT_TIMEOUT_MS', DEFAULT_OSCAR_CHAT_TIMEOUT_MS),
      deepResearchTimeoutMs: readConfiguredTimeout(
        options.deepResearchTimeoutMs,
        'OSCAR_DEEP_RESEARCH_TIMEOUT_MS',
        DEFAULT_OSCAR_DEEP_RESEARCH_TIMEOUT_MS,
      ),
      autoStart: options.autoStart ?? readBooleanEnv('OSCAR_AUTO_START', !configuredApiBase),
      apiToken,
    };
  }

  async status(options: OscarStatusOptions = {}): Promise<OscarBackendStatus> {
    let startupError = '';
    const startupAttempted = options.autoStart === true;
    if (startupAttempted) {
      try {
        await this.ensureBackendAvailable();
      } catch (error) {
        startupError = normalizeError(error, this.config.timeoutMs);
      }
    }

    try {
      const [health, modelStatus, memoryStats, hardware] = await Promise.all([
        this.getJson('/api/health'),
        this.getJson('/api/model/status'),
        this.getJson('/api/memory/stats'),
        this.getJson('/api/hardware').catch(() => hostMemoryInfo()),
      ]);

      return {
        connected: true,
        apiBase: this.config.apiBase,
        projectRoot: this.config.projectRoot,
        autoStart: this.config.autoStart,
        startupAttempted,
        timeoutMs: this.config.timeoutMs,
        chatTimeoutMs: this.config.chatTimeoutMs,
        deepResearchTimeoutMs: this.config.deepResearchTimeoutMs,
        health,
        modelStatus,
        memoryStats,
        hardware,
      };
    } catch (error) {
      return {
        connected: false,
        apiBase: this.config.apiBase,
        projectRoot: this.config.projectRoot,
        autoStart: this.config.autoStart,
        startupAttempted,
        timeoutMs: this.config.timeoutMs,
        chatTimeoutMs: this.config.chatTimeoutMs,
        deepResearchTimeoutMs: this.config.deepResearchTimeoutMs,
        hardware: hostMemoryInfo(),
        error: startupError
          ? `Oscar backend auto-start failed: ${startupError}; request failed: ${normalizeError(error, this.config.timeoutMs)}`
          : normalizeError(error, this.config.timeoutMs),
      };
    }
  }

  async chat(request: OscarChatRequest, signal?: AbortSignal): Promise<unknown> {
    await this.ensureBackendAvailable();
    let response: unknown;
    const send = () => this.postJson('/api/chat', request,
      this.chatTimeoutForRequest(request), signal);
    try {
      response = await send();
    } catch (error) {
      // A declined model swap generated nothing, so replaying against a fresh
      // process repeats no work and claims no result.
      if (!isOscarTierRecycleRefusal(error)) throw error;
      if (!(await recycleManagedOscarBackend(this.config))) throw error;
      response = await send();
    }
    return response;
  }

  async completeRaw(request: OscarRawChatCompletionRequest, signal?: AbortSignal): Promise<unknown> {
    await this.ensureBackendAvailable();
    const send = () => this.postJson('/v1/chat/completions', request,
      this.config.chatTimeoutMs, signal);
    try {
      return await send();
    } catch (error) {
      // The backend declined a model swap rather than aborting on it. Nothing
      // was generated, so replaying against a fresh process repeats no work.
      if (!isOscarTierRecycleRefusal(error)) throw error;
      if (!(await recycleManagedOscarBackend(this.config))) throw error;
      return await send();
    }
  }

  async previewChatRoute(request: OscarChatRequest): Promise<OscarChatRoutePreview> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/chat/route', request, this.config.timeoutMs) as Promise<OscarChatRoutePreview>;
  }

  /** Retries exactly once when the backend declines a model swap.
   *
   * A CUDA process that already holds one tier cannot load another: ggml turns
   * the CUDA error into abort() and the process dies mid-request, leaving the
   * user with no answer. The backend now declines instead, and the only way to
   * honour the request is a fresh process — which the swap was going to cost
   * anyway. Nothing has been generated at that point, so replaying the request
   * repeats no work and claims no result.
   */
  async *streamChat(request: OscarChatRequest, signal?: AbortSignal): AsyncGenerator<any, void, unknown> {
    let declined = false;
    for await (const event of this.streamChatOnce(request, signal)) {
      if (event?.type === 'error' && event?.data?.code === OSCAR_TIER_RECYCLE_REQUIRED_CODE) {
        declined = true;
        continue;
      }
      if (declined && event?.type === 'done') continue;
      yield event;
    }
    if (!declined) return;
    if (!(await recycleManagedOscarBackend(this.config))) {
      yield { type: 'error', data: { code: OSCAR_TIER_RECYCLE_REQUIRED_CODE,
        message: 'Нужна другая модель, но перезапустить локальный runtime не удалось. Повтори запрос.' } };
      yield { type: 'done', data: { ok: false } };
      return;
    }
    yield* this.streamChatOnce(request, signal);
  }

  private async *streamChatOnce(request: OscarChatRequest, signal?: AbortSignal): AsyncGenerator<any, void, unknown> {
    await this.ensureBackendAvailable();
    const url = new URL('/api/chat/stream', this.config.apiBase);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiToken) {
      headers['X-Oscar-Token'] = this.config.apiToken;
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener('abort', abortFromCaller, { once: true });
    }
    // Bounded by silence, not by length: one 300 s timer cut every local answer
    // that streamed longer (live: a 5-minute answer ended at exactly 300 s and
    // showed as "cancelled"). The first byte keeps the configured window, each
    // chunk re-arms an idle window, and a total cap still ends a stuck stream.
    const timedOut = () => controller.abort(Object.assign(new Error('oscar-chat-timeout'), { name: 'TimeoutError' }));
    let timeout = setTimeout(timedOut, this.chatTimeoutForRequest(request));
    const rearm = () => { clearTimeout(timeout); timeout = setTimeout(timedOut, OSCAR_STREAM_IDLE_MS); };
    const totalCap = setTimeout(timedOut, Math.max(OSCAR_STREAM_TOTAL_MS, this.chatTimeoutForRequest(request)));
    let receivedDoneEvent = false;

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Oscar stream request failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Oscar stream request returned no body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            const drained = drainOscarSseBuffer(buffer, true);
            for (const event of drained.events) {
              if (event.type === 'done') {
                receivedDoneEvent = true;
              }
              yield event;
              if (receivedDoneEvent) {
                break;
              }
            }
            break;
          }

          rearm();
          buffer += decoder.decode(value, { stream: true });
          const drained = drainOscarSseBuffer(buffer);
          buffer = drained.buffer;
          for (const event of drained.events) {
            if (event.type === 'done') {
              receivedDoneEvent = true;
              try {
                await reader.cancel();
              } catch {
                // The backend may close the response at the same moment.
              }
            }
            yield event;
            if (receivedDoneEvent) {
              break;
            }
          }
          if (receivedDoneEvent) {
            break;
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!receivedDoneEvent) {
        throw new Error('Oscar stream ended before the terminal done event.');
      }
    } catch (error) {
      // The managed backend may recycle immediately after its terminal SSE
      // event. A connection reset after `done` is therefore a successful
      // stream completion, not a generation failure.
      if (receivedDoneEvent) {
        return;
      }
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (normalized.message === 'oscar-chat-timeout') {
        yield { type: 'error', data: { code: 'local-timeout',
          message: 'Локальная модель слишком долго не присылала ответ, и он остановлен. Повтори запрос или выбери более быструю модель.' } };
        return;
      }
      if (isAbortLikeError(normalized)) {
        throw normalized;
      }
      const memory = hostMemoryInfo();
      const available = memory.ram_available_gb;
      const pro = ['qwen3.8-27b-pro', 'gemma4-deepthinking', 'gemma4-31b'].includes(
        String(request.requested_model || ''),
      );
      const lowRam = typeof available === 'number' && available < 1.5;
      yield {
        type: 'error',
        data: {
          code: lowRam ? 'ram-pressure' : 'runtime-disconnected',
          ram_available_gb: available,
          message: lowRam
            ? `Свободно ${available.toFixed(1)} ГБ RAM. Закрой лишние программы и повтори запрос; красная граница — 1,5 ГБ.`
            : pro
              ? 'Qwen Pro завершилась до финального события. Проверь предупреждение RAM, закрой тяжёлые программы и повтори запрос.'
              : 'Локальный runtime завершился до финального события. Попробуй повторить запрос.',
        },
      };
    } finally {
      clearTimeout(timeout);
      clearTimeout(totalCap);
      signal?.removeEventListener('abort', abortFromCaller);
      if (!receivedDoneEvent) {
        controller.abort();
        try {
          await this.cancelGeneration();
        } catch {
          // Ignore error
        }
      }
    }
  }

  private chatTimeoutForRequest(request: OscarChatRequest): number {
    return resolveOscarChatTimeoutMs(
      request,
      this.config.chatTimeoutMs,
      this.config.deepResearchTimeoutMs,
    );
  }

  async searchMemory(query: string, limit: number): Promise<unknown> {
    await this.ensureBackendAvailable();
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
    });
    return this.getJson(`/api/memory/search?${params.toString()}`);
  }

  async listMemoryItems(includeInactive = true): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.getJson(`/api/memory/items?include_inactive=${includeInactive ? 'true' : 'false'}`);
  }

  async createMemoryItem(input: {
    content: string;
    category?: string;
    type?: string;
    title?: string;
    tags?: string[];
    priority?: number;
    expires_at?: string;
    related_files?: string[];
    related_modules?: string[];
  }): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/memory/items', input);
  }

  async updateMemoryItem(itemId: string, input: {
    content?: string;
    category?: string;
    type?: string;
    title?: string;
    tags?: string[];
    priority?: number;
    expires_at?: string;
    related_files?: string[];
    related_modules?: string[];
    closed?: boolean;
    enabled?: boolean;
  }): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.patchJson(`/api/memory/items/${encodeURIComponent(itemId)}`, input);
  }

  async deleteMemoryItem(itemId: string): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.deleteJson(`/api/memory/items/${encodeURIComponent(itemId)}`);
  }

  /** Episodes/capsules Memory V4 captured on its own from past turns — the
   * automatic counterpart to listMemoryItems, which only covers explicit
   * memory. Chat scope only: this backs the owner-facing "Из памяти" review,
   * not the coder-project corpus. */
  async listDerivedMemory(): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.getJson('/api/memory/episodes?scopeType=chat');
  }

  async forgetMemoryEpisode(episodeId: string): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.deleteJson(`/api/memory/episodes/${encodeURIComponent(episodeId)}?scopeType=chat`);
  }

  async forgetMemoryCapsule(capsuleId: string): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.deleteJson(`/api/memory/capsules/${encodeURIComponent(capsuleId)}?scopeType=chat`);
  }

  async forgetAllDerivedMemory(): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.deleteJson('/api/memory/episodes?scopeType=chat');
  }

  async listConversations(options: { includeArchived?: boolean; limit?: number } = {}): Promise<unknown> {
    await this.ensureBackendAvailable();
    const query = new URLSearchParams();
    if (options.includeArchived) query.set('include_archived', 'true');
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.size ? '?' + query.toString() : '';
    return this.getJson('/api/conversations' + suffix);
  }

  async readSettingsContext(request: MonarchSettingsReadRequestV1): Promise<MonarchSettingsReadResultV1> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/settings/read', request) as Promise<MonarchSettingsReadResultV1>;
  }

  async executeSettingsCommand(
    request: MonarchSettingsCommandRequestV1 & { policyDecisionHash: string },
  ): Promise<MonarchSettingsWriteReceiptV1> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/settings/commands', request) as Promise<MonarchSettingsWriteReceiptV1>;
  }

  async indexMemoryEpisode(request: OscarMemoryEpisodeIndexRequest): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/memory/episodes', request);
  }

  async retrieveMemoryContext(input: {
    query: string;
    scope: { type: 'chat' } | { type: 'coder-project'; projectId: string };
  }): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/memory/context', { schemaVersion: 1, ...input });
  }

  /** Agent preparation: exact local chat scope, bounded/cancellable, no startup.
   * Ordinary interactive retrieval above keeps its existing lifecycle behavior. */
  async retrieveAgentMemoryContext(query: string, signal: AbortSignal): Promise<unknown> {
    if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > 8192) {
      throw new Error('oscar-agent-memory-query');
    }
    return this.postJson('/api/memory/context', { schemaVersion: 1, query, scope: { type: 'chat' } }, 2_000, signal);
  }

  /** MAX answer preparation: chat scope without the chat being answered,
   * bounded and cancellable, no backend startup. Consent is checked by the caller. */
  async retrieveMaxMemoryContext(query: string, conversationId: string | undefined, signal: AbortSignal): Promise<unknown> {
    if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > 8192) {
      throw new Error('oscar-max-memory-query');
    }
    return this.postJson('/api/memory/context', { schemaVersion: 1, query, scope: { type: 'chat' },
      ...(conversationId ? { excludeConversationId: conversationId } : {}) }, 2_000, signal);
  }

  /** Live metadata only. Never starts a backend or initiates a memory search. */
  async readMemoryContextValidity(scope: { type: 'chat' } | { type: 'coder-project'; projectId: string }, signal?: AbortSignal): Promise<unknown> {
    return this.postJson('/api/memory/context/validity', { schemaVersion: 1, scope }, 2_000, signal);
  }

  async clearConversations(): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.deleteJson('/api/conversations');
  }

  async createConversation(title = 'Новый чат'): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/conversations', { title });
  }

  async getConversation(
    conversationId: string,
    options: { messageLimit?: number; before?: number } = {},
  ): Promise<unknown> {
    await this.ensureBackendAvailable();
    const search = new URLSearchParams();
    if (options.messageLimit !== undefined) search.set('message_limit', String(options.messageLimit));
    if (options.before !== undefined) search.set('before', String(options.before));
    const query = search.size > 0 ? `?${search.toString()}` : '';
    return this.getJson(`/api/conversations/${encodeURIComponent(conversationId)}${query}`);
  }

  async updateConversation(conversationId: string, input: { title?: string; archived?: boolean; local_only?: boolean }): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.patchJson(`/api/conversations/${encodeURIComponent(conversationId)}`, input);
  }

  async editConversationMessage(conversationId: string, messageId: string, content: string): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.patchJson(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      { content },
    );
  }

  async appendConversationMessage(
    conversationId: string,
    input: OscarConversationMessageAppendInput,
  ): Promise<OscarConversationMessageAppendResult> {
    await this.ensureBackendAvailable();
    const result = await this.postJson(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, input);
    return conversationMessageAppendResult(result, conversationId, input);
  }

  async deleteConversation(conversationId: string): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.deleteJson(`/api/conversations/${encodeURIComponent(conversationId)}`);
  }

  async searchAndIngest(input: {
    query: string;
    max_results: number;
    fetch_pages: boolean;
  }): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/search', input);
  }

  async searchContext(input: { query: string; deep: boolean; queries?: string[] }, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    await this.ensureBackendAvailable();
    signal?.throwIfAborted();
    return this.postJson('/api/search/context', input, 85_000, signal);
  }

  async unloadModel(): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/model/unload', {});
  }

  async stopBackend(): Promise<unknown> {
    await this.ensureBackendAvailable();
    const correlation = crypto.randomUUID().replace(/-/gu, '');
    const value = await this.fetchJson('/api/backend/stop', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Monarch-Stop-Correlation': correlation }, body: '{}' });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('oscar-stop-receipt');
    const receipt = value as Record<string, unknown>;
    if (receipt.ok !== true || receipt.stopping !== true || receipt.correlation !== correlation
      || !Number.isSafeInteger(receipt.pid) || Number(receipt.pid) < 1
      || !Number.isSafeInteger(receipt.activeInferenceSlots) || Number(receipt.activeInferenceSlots) < 0
      || receipt.tokenSource !== 'authenticated-header') throw Error('oscar-stop-receipt');
    return receipt;
  }

  async shutdownManagedBackend(): Promise<void> {
    await stopManagedOscarBackend();
  }

  async cancelGeneration(): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/generation/cancel', {});
  }

  private async ensureBackendAvailable(): Promise<void> {
    if (!this.config.autoStart || !isLocalApiBase(this.config.apiBase)) {
      return;
    }
    const reachable = await this.backendHealth();
    if (reachable) {
      await this.restartUnderOtherProtection(reachable);
      return;
    }
    await startManagedOscarBackend(this.config);
  }

  private protectionChecked = false;

  /** An Oscar started earlier (another runtime, an older Monarch) may run under
   * other storage protection, e.g. on a plain database while sealing is on. It
   * is restarted once so the database follows the person's choice. */
  private async restartUnderOtherProtection(health: Record<string, unknown>): Promise<void> {
    if (this.protectionChecked) return;
    this.protectionChecked = true;
    const expected = oscarStorageEnvironment().OSCAR_STORE_PROTECTION;
    const actual = typeof health.storage_protection === 'string' ? health.storage_protection : 'plain';
    if (!expected || actual === expected) return;
    await this.stopBackend().catch(() => undefined);
    for (let attempt = 0; attempt < 50 && await this.isBackendReachable(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await startManagedOscarBackend(this.config);
  }

  private async backendHealth(): Promise<Record<string, unknown> | null> {
    try {
      const value = await fetchJsonWithTimeout(`${this.config.apiBase}/api/health`, 5000);
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
      return null;
    }
  }

  private async isBackendReachable(): Promise<boolean> {
    try {
      // The public health reply is readiness only. Sending the owner token
      // requests the full diagnostic status (including model directory scans),
      // which must not block discovery or every ordinary backend request.
      await fetchJsonWithTimeout(`${this.config.apiBase}/api/health`, 5000);
      return true;
    } catch {
      return false;
    }
  }

  /** The local tier resident in the backend right now, or null when none is
   * loaded or the backend is not up. Never starts the backend: routing asks
   * this to avoid a swap, not to cause a load. */
  async residentTier(): Promise<string | null> {
    try {
      const status = await this.getJson('/api/model/status') as { loaded?: unknown; fallback_active?: unknown; active_tier?: unknown };
      return status?.loaded === true && status.fallback_active !== true && typeof status.active_tier === 'string'
        ? status.active_tier : null;
    } catch {
      return null;
    }
  }

  private async getJson(path: string): Promise<unknown> {
    return this.fetchJson(path, {
      method: 'GET',
    });
  }

  private async postJson(
    path: string,
    body: unknown,
    timeoutMs = this.config.timeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.fetchJson(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, timeoutMs, signal);
  }

  private async patchJson(path: string, body: unknown): Promise<unknown> {
    return this.fetchJson(path, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private async deleteJson(path: string): Promise<unknown> {
    return this.fetchJson(path, { method: 'DELETE' });
  }

  private async fetchJson(
    path: string,
    init: RequestInit,
    timeoutMs = this.config.timeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener('abort', abortFromCaller, { once: true });
    }

    const headers = {
      ...(init.headers || {}),
    } as Record<string, string>;

    if (this.config.apiToken) {
      headers['X-Oscar-Token'] = this.config.apiToken;
    }

    try {
      const response = await fetch(`${this.config.apiBase}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as unknown;
        const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : undefined;
        const detail = payloadRecord?.detail;
        const openAiError = payloadRecord?.error && typeof payloadRecord.error === 'object' && !Array.isArray(payloadRecord.error)
          ? payloadRecord.error as Record<string, unknown>
          : undefined;
        const detailRecord = detail && typeof detail === 'object' && !Array.isArray(detail)
          ? detail as Record<string, unknown>
          : undefined;
        throw new OscarBackendHttpError(
          response.status,
          typeof detailRecord?.code === 'string'
            ? detailRecord.code
            : typeof openAiError?.code === 'string'
              ? openAiError.code
              : `oscar-http-${response.status}`,
          typeof detailRecord?.message === 'string'
            ? detailRecord.message
            : typeof openAiError?.message === 'string'
              ? openAiError.message
            : typeof detail === 'string'
              ? detail
              : `Oscar backend returned HTTP ${response.status}.`,
        );
      }
      return await response.json() as unknown;
    } catch (error) {
      if (error instanceof OscarBackendHttpError) throw error;
      throw new Error(normalizeError(error, timeoutMs));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

function conversationMessageAppendResult(
  value: unknown,
  conversationId: string,
  input: OscarConversationMessageAppendInput,
): OscarConversationMessageAppendResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Oscar backend returned an invalid conversation message append receipt.');
  }
  const record = value as Record<string, unknown>;
  const disposition = record.disposition;
  const message = record.message;
  const duplicate = record.duplicate;
  const validDisposition = disposition === 'created' || disposition === 'duplicate' || disposition === 'superseded';
  const validMessage = message === null || (typeof message === 'object' && !Array.isArray(message));
  const consistent = disposition === 'created'
    ? duplicate === false && message !== null
    : disposition === 'duplicate'
      ? duplicate === true && message === null
      : duplicate === false && message === null;
  if (record.ok !== true || !validDisposition || !validMessage || !consistent) {
    throw new Error('Oscar backend returned an invalid conversation message append receipt.');
  }
  if (disposition === 'superseded' && (
    input.role !== 'assistant'
    || !input.required_previous_message_id
  )) {
    throw new Error('Oscar backend returned an invalid conversation message append receipt.');
  }
  if (input.content_mode === 'exact' && disposition !== 'superseded'
    && (record.content_mode !== 'exact' || record.content_sha256 !== crypto.createHash('sha256').update(input.content, 'utf8').digest('hex'))) {
    throw new Error('Oscar backend did not confirm exact conversation message content.');
  }
  if (input.causal_parent_id && record.causal_parent_id !== input.causal_parent_id)
    throw new Error('Oscar backend did not confirm the causal conversation message binding.');
  if (disposition === 'created') {
    const created = message as Record<string, unknown>;
    const exactBindings = created.conversation_id === conversationId
      && created.role === input.role
      && created.content === (input.content_mode === 'exact' ? input.content : input.content.trim())
      && optionalReceiptBinding(created.client_message_id, input.client_message_id)
      && optionalReceiptBinding(created.turn_id, input.turn_id)
      && optionalReceiptBinding(created.causal_parent_id, input.causal_parent_id)
      && optionalReceiptBinding(created.task_id, input.task_id)
      && optionalReceiptBinding(created.outcome, input.outcome)
      && (input.provenance === undefined || stableStringify(created.provenance) === stableStringify(input.provenance));
    if (!exactBindings) {
      throw new Error('Oscar backend returned a conversation message receipt for a different append request.');
    }
  }
  return {
    ok: true,
    disposition,
    message: message as Record<string, unknown> | null,
    duplicate: disposition === 'duplicate',
  };
}

function optionalReceiptBinding(actual: unknown, expected: string | undefined): boolean {
  return expected === undefined || actual === expected.trim();
}

function hostMemoryInfo() {
  return {
    ram_total_gb: Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100,
    ram_available_gb: Math.round((os.freemem() / (1024 ** 3)) * 100) / 100,
  };
}

export function createDefaultOscarChatRequest(
  messages: OscarChatMessage[],
  webSearch: boolean | undefined,
  input: unknown
): OscarChatRequest {
  const requestedModel = readStringInput(input, 'requested_model');
  const selectionSource = readStringInput(input, 'model_selection_source');
  const conversationId = readStringInput(input, 'conversation_id');
  const incognito = readBooleanInput(input, 'incognito', false);
  const imageAttachments = readArrayInput(input, 'image_attachments');
  const researchMode = readStringInput(input, 'research_mode');
  const route = readRouteInput(input);
  const deepThinkingConsent = readStringInput(input, 'deep_thinking_consent');
  const inferenceLane = readStringInput(input, 'inference_lane');
  const persistenceOwner = readStringInput(input, 'persistence_owner');
  const turnId = readStringInput(input, 'turn_id');
  const clientMessageId = readStringInput(input, 'client_message_id');
  const devMode = readRecordInput(input, 'dev_mode');
  const contextProfile = readStringInput(input, 'context_profile');
  // Compatibility chat is answer-only. Agent execution belongs exclusively to
  // Oscar Turn + Astra V3 and cannot be activated by a message marker or input.
  const executionAuthority = 'none' as const;
  const effectiveMessages = [
    { role: 'system' as const, content: '<monarch_answer_only_authority version="1" />' },
    ...messages.filter((message) => !(message.role === 'system'
      && message.content.trim().startsWith('<monarch_coder_mode>')
      && message.content.trim().endsWith('</monarch_coder_mode>'))),
  ];
  const request: OscarChatRequest = {
    messages: effectiveMessages,
    use_memory: readBooleanInput(input, 'use_memory', true),
    reasoning_effort: readReasoningEffort(input),
    max_new_tokens: readNumberInput(input, 'max_new_tokens', MAX_OSCAR_NEW_TOKENS, 32, MAX_OSCAR_NEW_TOKENS),
    temperature: readNumberInput(input, 'temperature', 0.3, 0, 1.5),
    top_p: readNumberInput(input, 'top_p', 0.9, 0.1, 1),
    execution_authority: executionAuthority,
    persistence_owner: persistenceOwner === 'coordinator' ? 'coordinator' : 'backend',
  };
  if (contextProfile === 'full' || contextProfile === 'compact-social') {
    request.context_profile = contextProfile;
  }
  if (turnId) request.turn_id = turnId;
  if (clientMessageId) request.client_message_id = clientMessageId;
  if (devMode) {
    request.dev_mode = {
      zero_retention: readBooleanInput(devMode, 'zero_retention', false),
      internet_enabled: readBooleanInput(devMode, 'internet_enabled', true),
      memory_enabled: readBooleanInput(devMode, 'memory_enabled', true),
      history_context_enabled: readBooleanInput(devMode, 'history_context_enabled', true),
      personality_enabled: readBooleanInput(devMode, 'personality_enabled', true),
      skills_enabled: readBooleanInput(devMode, 'skills_enabled', true),
      runtime_context_enabled: readBooleanInput(devMode, 'runtime_context_enabled', true),
      quality_regeneration_enabled: readBooleanInput(devMode, 'quality_regeneration_enabled', true),
    };
  }
  if (typeof webSearch === 'boolean') {
    request.web_search = webSearch;
  }
  if (researchMode === 'auto' || researchMode === 'off' || researchMode === 'deep') {
    request.research_mode = researchMode;
  }
  if (requestedModel) {
    request.requested_model = requestedModel;
    request.model_selection_source = selectionSource === 'fallback' || selectionSource === 'recovery'
      ? selectionSource
      : 'user-explicit';
  } else if (selectionSource === 'user-explicit' || selectionSource === 'fallback' || selectionSource === 'recovery') {
    request.model_selection_source = selectionSource;
  }
  if (conversationId) {
    request.conversation_id = conversationId;
  }
  if (incognito) {
    request.incognito = true;
  }
  if (imageAttachments.length) {
    request.image_attachments = imageAttachments;
  }
  if (route) {
    request.route = route;
  }
  if (deepThinkingConsent === 'allow' || deepThinkingConsent === 'deny') {
    request.deep_thinking_consent = deepThinkingConsent;
  }
  if (
    inferenceLane === 'interactive'
    || inferenceLane === 'agent'
    || inferenceLane === 'coder'
    || inferenceLane === 'background'
  ) {
    request.inference_lane = inferenceLane;
  }
  return request;
}

export function readRouteInput(input: unknown): OscarRouteHint | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const route = (input as Record<string, unknown>).route;
  if (!route || typeof route !== 'object') {
    return undefined;
  }
  const result: OscarRouteHint = {};
  const r = route as Record<string, unknown>;
  if (typeof r.intentKind === 'string') result.intentKind = r.intentKind.trim();
  if (typeof r.modelTier === 'string') result.modelTier = r.modelTier.trim();
  if (typeof r.riskHint === 'string') result.riskHint = r.riskHint.trim();
  if (typeof r.language === 'string') result.language = r.language.trim();
  return result;
}

export function readMessagesInput(input: unknown): OscarChatMessage[] {
  if (!input || typeof input !== 'object') {
    return [];
  }

  const messages = (input as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map(normalizeMessage)
    .filter((message): message is OscarChatMessage => Boolean(message));
}

export function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function readArrayInput(input: unknown, key: string): unknown[] {
  if (!input || typeof input !== 'object') {
    return [];
  }

  const value = (input as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function readRecordInput(input: unknown, key: string): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readNumberInput(
  input: unknown,
  key: string,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY
): number {
  if (!input || typeof input !== 'object') {
    return fallback;
  }

  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

export function readBooleanInput(input: unknown, key: string, fallback: boolean): boolean {
  if (!input || typeof input !== 'object') {
    return fallback;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function drainOscarSseBuffer(buffer: string, flush = false): { events: Array<{ type: string; data: unknown }>; buffer: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const tail = blocks.pop() ?? '';
  const completeBlocks = flush && tail.trim() ? [...blocks, tail] : blocks;
  const events = completeBlocks
    .map((block) => parseOscarSseBlock(block))
    .filter((event): event is { type: string; data: unknown } => event !== null);

  return {
    events,
    buffer: flush ? '' : tail,
  };
}

export function parseOscarSseBlock(block: string): { type: string; data: unknown } | null {
  const lines = block.split('\n');
  const eventType = lines
    .find((line) => line.startsWith('event:'))
    ?.replace('event:', '')
    .trim() || 'message';
  const dataStr = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace('data:', '').trim())
    .join('\n');

  if (!dataStr) {
    return null;
  }

  try {
    return { type: eventType, data: JSON.parse(dataStr) };
  } catch {
    return { type: eventType, data: dataStr };
  }
}

export function normalizeOscarImageAttachments(input: unknown): OscarImageAttachment[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map(normalizeOscarImageAttachment)
    .filter((attachment): attachment is OscarImageAttachment => Boolean(attachment))
    .slice(0, 3);
}

function normalizeOscarImageAttachment(value: unknown): OscarImageAttachment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const mimeType = readAttachmentString(record, 'mime_type') || readAttachmentString(record, 'media_type');
  if (!/^(image\/png|image\/jpeg|image\/webp)$/.test(mimeType)) {
    return null;
  }

  const rawData = readAttachmentString(record, 'data_base64') || readAttachmentString(record, 'dataUrl') || readAttachmentString(record, 'data_url');
  const dataBase64 = stripDataUrl(rawData).replace(/\s+/g, '');
  if (!dataBase64) {
    return null;
  }

  const sizeBytes = readAttachmentSize(record.size_bytes);
  return {
    mime_type: mimeType,
    data_base64: dataBase64,
    name: readAttachmentString(record, 'name') || 'image',
    size_bytes: sizeBytes,
  };
}

function stripDataUrl(value: string): string {
  const match = value.match(/^data:[^,]+,(.+)$/i);
  return match?.[1] || value;
}

function readAttachmentString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readAttachmentSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}


function readReasoningEffort(input: unknown): OscarChatRequest['reasoning_effort'] {
  const value = readStringInput(input, 'reasoning_effort');
  switch (value) {
  case 'low':
  case 'medium':
  case 'high':
    return value;
  default:
    return 'low';
  }
}

function normalizeMessage(value: unknown): OscarChatMessage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const role = record.role;
  const content = record.content;
  if (
    (role !== 'system' && role !== 'user' && role !== 'assistant')
    || typeof content !== 'string'
    || content.trim().length === 0
  ) {
    return null;
  }

  return {
    role,
    content: content.trim(),
  };
}

function normalizeApiBase(value: string): string {
  return value.replace(/\/+$/, '');
}

function defaultOscarProjectRoot(): string {
  return path.join(process.cwd(), 'oscar');
}

function readConfiguredTimeout(value: number | undefined, envKey: string, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : readTimeout(envKey, fallback);
}

function readTimeout(envKey: string, fallback: number): number {
  const parsed = Number(process.env[envKey] || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(value);
}

function normalizeError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    return isAbortLikeError(error)
      ? `Oscar backend request timed out after ${timeoutMs}ms while waiting for the local backend.`
      : error.message;
  }
  const message = String(error);
  return /aborted/i.test(message)
    ? `Oscar backend request timed out after ${timeoutMs}ms while waiting for the local backend.`
    : message;
}

function isAbortLikeError(error: Error): boolean {
  return error.name === 'AbortError' || /aborted/i.test(error.message);
}

let managedBackendProcess: ChildProcess | null = null;
const observedManagedBackendExits = new WeakSet<ChildProcess>();
let managedBackendStart: Promise<void> | null = null;
const hostStoppedManagedBackendPids = new Set<number>();

function cleanupManagedBackendOnExit() {
  if (managedBackendProcess) {
    if (managedBackendProcess.pid) {
      hostStoppedManagedBackendPids.add(managedBackendProcess.pid);
    }
    killProcessTree(managedBackendProcess.pid);
  }
}

process.on('exit', cleanupManagedBackendOnExit);
process.on('SIGINT', () => {
  cleanupManagedBackendOnExit();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupManagedBackendOnExit();
  process.exit(0);
});

async function startManagedOscarBackend(config: OscarBridgeConfig): Promise<void> {
  if (managedBackendProcess && !managedBackendProcess.killed) {
    await waitForOscarHealth(config.apiBase, 15000);
    return;
  }
  if (managedBackendStart) {
    await managedBackendStart;
    return;
  }

  managedBackendStart = doStartManagedOscarBackend(config);
  try {
    await managedBackendStart;
  } finally {
    managedBackendStart = null;
  }
}

async function doStartManagedOscarBackend(config: OscarBridgeConfig): Promise<void> {
  const projectRoot = path.resolve(config.projectRoot);
  const pythonPath = resolveOscarPython(projectRoot);
  const backendMain = path.join(projectRoot, 'backend', 'oscar_agent', 'main.py');
  if (!existsSync(pythonPath)) {
    throw new Error(`Oscar Python runtime is missing: ${pythonPath}`);
  }
  if (!existsSync(backendMain)) {
    throw new Error(`Oscar backend is missing: ${backendMain}`);
  }

  const runtimeDir = path.join(config.logsRoot, 'oscar');
  await mkdir(runtimeDir, { recursive: true });
  const packagedEnvironment = resolvePackagedOscarEnvironment(projectRoot);

  const port = readApiPort(config.apiBase);
  const astraEnvironment = prepareOscarAstraEnvironment(process.env, path.dirname(projectRoot));
  // Appended on every start and never rotated; one previous generation is kept.
  for (const name of ['monarch-managed-backend.out.log', 'monarch-managed-backend.err.log', 'monarch-managed-backend.lifecycle.log']) {
    const logPath = path.join(runtimeDir, name);
    try { if (statSync(logPath).size > 8 * 1024 * 1024) renameWithWindowsRetrySync(logPath, logPath + '.1'); } catch { /* keep appending */ }
  }
  const out = openSync(path.join(runtimeDir, 'monarch-managed-backend.out.log'), 'a');
  const err = openSync(path.join(runtimeDir, 'monarch-managed-backend.err.log'), 'a');

  const child = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'oscar_agent.main:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: projectRoot,
      env: {
        ...astraEnvironment,
        ...packagedEnvironment,
        PYTORCH_CUDA_ALLOC_CONF: process.env.PYTORCH_CUDA_ALLOC_CONF || 'expandable_segments:True,max_split_size_mb:128',
        TOKENIZERS_PARALLELISM: process.env.TOKENIZERS_PARALLELISM || 'false',
        OSCAR_API_TOKEN: config.apiToken,
        // Monarch Security storage protection for Oscar's database (stage 3c).
        ...oscarStorageEnvironment(),
        // Oscar reads its own Monarch Security levels (search query cleaning) from here.
        OSCAR_SECURITY_POLICY_PATH: securityPolicyFilePath(
          resolveMonarchRuntimePaths(path.dirname(projectRoot), process.env).stateRoot),
        // Owner-added GGUF models: the same registry the host writes.
        OSCAR_CUSTOM_MODELS_DIR: path.join(
          resolveMonarchRuntimePaths(path.dirname(projectRoot), process.env).modelsRoot,
          CUSTOM_MODELS_DIRECTORY,
        ),
      },
      detached: false,
      windowsHide: true,
      stdio: ['ignore', out, err],
    }
  );
  closeSync(out);
  closeSync(err);
  managedBackendProcess = child;
  const startedAt = Date.now();
  const childPid = child.pid;
  child.once('exit', (code, signal) => {
    observedManagedBackendExits.add(child);
    const hostStopRequested = childPid ? hostStoppedManagedBackendPids.delete(childPid) : false;
    try {
      appendFileSync(path.join(runtimeDir, 'monarch-managed-backend.lifecycle.log'), `${JSON.stringify({
        at: new Date().toISOString(),
        event: 'managed-backend-exit',
        pid: childPid ?? null,
        code,
        signal,
        hostStopRequested,
        uptimeMs: Date.now() - startedAt,
      })}\n`, 'utf8');
    } catch {
      // Lifecycle evidence must never prevent recovery from a dead backend.
    }
    if (managedBackendProcess === child) {
      managedBackendProcess = null;
    }
  });
  // A Python that cannot be started (missing, blocked by antivirus) emits
  // 'error' instead of 'exit'. Without a listener that is an uncaught
  // exception and the whole Monarch server ended with it.
  child.on('error', (error) => {
    observedManagedBackendExits.add(child);
    try {
      appendFileSync(path.join(runtimeDir, 'monarch-managed-backend.lifecycle.log'), `${JSON.stringify({
        at: new Date().toISOString(), event: 'managed-backend-spawn-error', pid: childPid ?? null,
        code: (error as NodeJS.ErrnoException).code ?? error.name,
      })}\n`, 'utf8');
    } catch { /* The health wait below reports the failure. */ }
    if (managedBackendProcess === child) managedBackendProcess = null;
  });
  await waitForOscarHealth(config.apiBase, 15000);
}

export const OSCAR_TIER_RECYCLE_REQUIRED_CODE = 'model-tier-recycle-required';
/** The OpenAI-compatible lane spells its codes snake_case. */
export const OSCAR_TIER_RECYCLE_REQUIRED_CODE_OPENAI = 'model_tier_recycle_required';

export function isOscarTierRecycleRefusal(error: unknown): boolean {
  const code = (error as OscarBackendHttpError | undefined)?.code;
  return code === OSCAR_TIER_RECYCLE_REQUIRED_CODE
    || code === OSCAR_TIER_RECYCLE_REQUIRED_CODE_OPENAI;
}

/** Stop the host-managed backend and bring a fresh one up.
 *
 * Returns false when this host does not own the process, in which case the
 * caller must surface the refusal instead of silently retrying into it. */
async function recycleManagedOscarBackend(config: OscarBridgeConfig): Promise<boolean> {
  if (!managedBackendProcess) return false;
  await stopManagedOscarBackend();
  try {
    await startManagedOscarBackend(config);
    return true;
  } catch {
    return false;
  }
}

async function stopManagedOscarBackend(): Promise<void> {
  const child = managedBackendProcess;
  managedBackendProcess = null;
  if (!child || child.killed) {
    return;
  }

  if (child.pid) {
    hostStoppedManagedBackendPids.add(child.pid);
  }
  killProcessTree(child.pid);
  await sleep(500);
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already exited.
  }
}

/** Authored from the shipped component catalog, never renderer/model input. */
export function prepareOscarAstraEnvironment(environment: NodeJS.ProcessEnv, workspaceRoot: string): NodeJS.ProcessEnv {
  const next = { ...environment };
  delete next.OSCAR_ASTRA_LOCAL_COMPONENT;
  if (environment.MONARCH_ASTRA_V3_MODEL_MODE === 'managed-local'
    && environment.MONARCH_ASTRA_V3_PILOT === 'runtime-same-owner-v1') {
    const runtimePaths = resolveMonarchRuntimePaths(workspaceRoot, environment);
    const specs = [MONARCH_REQUIRED_FAST_MODEL, MONARCH_OPTIONAL_BALANCED_MODEL, ...MONARCH_CODER_MODEL_COMPONENTS];
    next.OSCAR_ASTRA_LOCAL_COMPONENT = JSON.stringify({ version: 2, root: runtimePaths.modelsRoot,
      components: specs.map(spec => ({
        relativePath: runtimePaths.mode === 'installed' && spec.role.includes('coder')
          ? path.join('coder', spec.role, spec.remoteFile) : spec.relativePath,
        tier: spec.role,
        variants: [spec, ...(spec.acceptedExistingVariants ?? [])]
          .map(variant => ({ size: variant.expectedBytes, digest: 'sha256:' + variant.sha256 })),
      })) });
    // A process-local prepared host must outlive ordinary chat completions.
    // Keep ONE shared resident; explicit unload, Stop and application shutdown
    // still belong to the existing runtime owner. No second process/cache.
    next.OSCAR_AUTO_UNLOAD_AFTER_GENERATION = 'false';
    next.OSCAR_RECYCLE_BACKEND_AFTER_GENERATION = 'false';
    // Native MTP speculative decoding is not stable when llama.cpp also owns
    // the exact JSON grammar sampler used by prepared Agent turns. One resident
    // model is slower but keeps long multi-call work inside a single live host.
    next.OSCAR_GEMMA_SPECULATIVE_DECODING = 'false';
    // Thirty 12B layers leave too little transient CUDA headroom on the tested
    // 8 GiB device and can fast-fail the native process during grammar sampling.
    // Twenty layers retain acceleration while keeping Agent turns repeatable.
    next.OSCAR_GEMMA4_BALANCED_GPU_LAYERS = '20';
  }
  return next;
}

function resolveOscarPython(projectRoot: string): string {
  return process.env.OSCAR_PYTHON
    || path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
}

function resolvePackagedOscarEnvironment(projectRoot: string): NodeJS.ProcessEnv {
  const environmentRoot = String(process.env.MONARCH_BACKEND_ENVIRONMENT_ROOT || '').trim();
  if (!environmentRoot) {
    return {
      PYTHONPATH: path.join(projectRoot, 'backend'),
    };
  }

  const explicitProfile = String(process.env.MONARCH_OSCAR_PROFILE || '').trim().toLowerCase();
  const profile = explicitProfile === 'cpu' || explicitProfile === 'cuda'
    ? explicitProfile
    : hasWorkingNvidiaRuntime()
      ? 'cuda'
      : 'cpu';
  const profileRoot = path.join(environmentRoot, 'oscar', 'profiles', profile);
  const pythonPath = [
    path.join(environmentRoot, 'oscar', 'common'),
    profileRoot,
    path.join(projectRoot, 'backend'),
  ].join(path.delimiter);
  const inheritedPath = process.env.PATH || process.env.Path || '';
  const cudaBins = profile === 'cuda'
    ? [
      path.join(profileRoot, 'bin'),
      path.join(profileRoot, 'nvidia', 'cublas', 'bin'),
      path.join(profileRoot, 'nvidia', 'cuda_runtime', 'bin'),
      path.join(profileRoot, 'nvidia', 'nvjitlink', 'bin'),
    ].filter((entry) => existsSync(entry))
    : [];

  return {
    MONARCH_OSCAR_PROFILE: profile,
    PYTHONPATH: pythonPath,
    PATH: [...cudaBins, inheritedPath].filter(Boolean).join(path.delimiter),
  };
}

function readApiPort(apiBase: string): number {
  try {
    const url = new URL(apiBase);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80)) || 7861;
  } catch {
    return 7861;
  }
}

function isLocalApiBase(apiBase: string): boolean {
  try {
    const hostname = new URL(apiBase).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function waitForOscarHealth(apiBase: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetchJsonWithTimeout(`${apiBase}/api/health`, 5000);
      return;
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }

  throw lastError || new Error('Timed out waiting for Oscar backend health.');
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Oscar backend returned HTTP ${response.status}.`);
    }
    return await response.json() as unknown;
  } catch (error) {
    throw new Error(normalizeError(error, timeoutMs));
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
