import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const DEFAULT_OSCAR_API_TIMEOUT_MS = 30000;
const DEFAULT_OSCAR_CHAT_TIMEOUT_MS = 300000;
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

export interface OscarCapabilityContext {
  id: string;
  module: string;
  system: string;
  title: string;
  description: string;
  risk: string;
  inputSchema?: unknown;
}

export interface OscarAccessContext {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'on-request' | 'never';
}

export interface OscarChatRequest {
  messages: OscarChatMessage[];
  conversation_id?: string;
  incognito?: boolean;
  image_attachments?: unknown[];
  web_search?: boolean;
  research_mode?: 'auto' | 'off' | 'deep';
  use_memory: boolean;
  reasoning_effort: 'low' | 'medium' | 'high';
  requested_model?: string;
  model_selection_source?: 'auto' | 'user-explicit' | 'fallback' | 'recovery';
  deep_thinking_consent?: 'allow' | 'deny';
  max_new_tokens: number;
  temperature: number;
  top_p: number;
  route?: OscarRouteHint;
  skills?: OscarAgentSkillContext[];
  capabilities?: OscarCapabilityContext[];
  access?: OscarAccessContext;
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
}

export interface OscarVoiceFastRequest {
  text: string;
  language?: 'ru' | 'uk' | 'bg' | 'en';
  history?: OscarVoiceHistoryMessage[];
}

export interface OscarVoiceHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface OscarVoiceFastResponse {
  text: string;
  model: 'gemma4-fast';
  generation_ms: number;
}

export interface OscarVoiceRealtimeRequest {
  text: string;
  kind: 'weather' | 'web-search';
  language?: 'ru' | 'uk' | 'bg' | 'en';
  location?: string;
  history?: OscarVoiceHistoryMessage[];
}

export interface OscarVoiceRealtimeResponse {
  text: string;
  model: 'none' | 'gemma4-fast' | 'open-meteo';
  kind: 'weather' | 'web-search';
  source_count: number;
  search_ms: number;
  generation_ms: number;
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
  timeoutMs?: number;
  chatTimeoutMs?: number;
  deepResearchTimeoutMs?: number;
  autoStart?: boolean;
}

export interface OscarBridgeConfig {
  apiBase: string;
  projectRoot: string;
  timeoutMs: number;
  chatTimeoutMs: number;
  deepResearchTimeoutMs: number;
  autoStart: boolean;
  apiToken: string;
}

function getOrCreateOscarToken(): string {
  const secretsDir = path.join(process.cwd(), 'secrets');
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

export class OscarClient {
  readonly config: OscarBridgeConfig;

  constructor(options: OscarClientOptions = {}) {
    const configuredApiBase = options.apiBase || process.env.OSCAR_API_BASE;
    const projectRoot = path.resolve(options.projectRoot || process.env.OSCAR_PROJECT_ROOT || defaultOscarProjectRoot());
    const apiToken = getOrCreateOscarToken();

    this.config = {
      apiBase: normalizeApiBase(configuredApiBase || 'http://127.0.0.1:7861'),
      projectRoot,
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

  async chat(request: OscarChatRequest): Promise<unknown> {
    await this.ensureBackendAvailable();
    let response: unknown;
    try {
      response = await this.postJson('/api/chat', request, this.chatTimeoutForRequest(request));
    } catch (error) {
      if (isCoderChatRequest(request) && isLocalApiBase(this.config.apiBase)) {
        await this.releaseFailedCoderGeneration();
      }
      throw error;
    }
    if (this.config.autoStart && isLocalApiBase(this.config.apiBase)
      && isCoderChatRequest(request) && isTerminalCoderResponse(response)) {
      await stopManagedOscarBackend();
    }
    return response;
  }

  async previewChatRoute(request: OscarChatRequest): Promise<OscarChatRoutePreview> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/chat/route', request, this.config.timeoutMs) as Promise<OscarChatRoutePreview>;
  }

  async voiceFast(request: OscarVoiceFastRequest): Promise<OscarVoiceFastResponse> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/voice/fast', request, this.config.chatTimeoutMs) as Promise<OscarVoiceFastResponse>;
  }

  async voiceRealtime(request: OscarVoiceRealtimeRequest): Promise<OscarVoiceRealtimeResponse> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/voice/realtime', request, this.config.chatTimeoutMs) as Promise<OscarVoiceRealtimeResponse>;
  }

  async *streamChat(request: OscarChatRequest): AsyncGenerator<any, void, unknown> {
    await this.ensureBackendAvailable();
    const url = new URL('/api/chat/stream', this.config.apiBase);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiToken) {
      headers['X-Oscar-Token'] = this.config.apiToken;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.chatTimeoutForRequest(request));
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
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const drained = drainOscarSseBuffer(buffer);
          buffer = drained.buffer;
          for (const event of drained.events) {
            if (event.type === 'done') {
              receivedDoneEvent = true;
            }
            yield event;
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
      if (isAbortLikeError(normalized)) {
        throw normalized;
      }
      const memory = hostMemoryInfo();
      const available = memory.ram_available_gb;
      const extra = request.requested_model === 'gemma4-31b';
      const lowRam = typeof available === 'number' && available < 1.5;
      yield {
        type: 'error',
        data: {
          code: lowRam ? 'ram-pressure' : 'runtime-disconnected',
          ram_available_gb: available,
          message: lowRam
            ? `Свободно ${available.toFixed(1)} ГБ RAM. Закрой лишние программы и повтори запрос; красная граница — 1,5 ГБ.`
            : extra
              ? 'Extra завершилась до финального события. Проверь предупреждение RAM, закрой тяжёлые программы и повтори запрос.'
              : 'Локальный runtime завершился до финального события. Попробуй повторить запрос.',
        },
      };
    } finally {
      clearTimeout(timeout);
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

  async listConversations(): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.getJson('/api/conversations');
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

  async updateConversation(conversationId: string, input: { title?: string; archived?: boolean }): Promise<unknown> {
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
    input: {
      role: 'user' | 'assistant';
      content: string;
      token_count?: number;
      elapsed_ms?: number;
      model_tier?: string;
    }
  ): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, input);
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

  async unloadModel(): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/model/unload', {});
  }

  async stopBackend(): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/backend/stop', {});
  }

  async shutdownManagedBackend(): Promise<void> {
    await stopManagedOscarBackend();
  }

  async cancelGeneration(): Promise<unknown> {
    await this.ensureBackendAvailable();
    return this.postJson('/api/generation/cancel', {});
  }

  private async releaseFailedCoderGeneration(): Promise<void> {
    try {
      await this.cancelGeneration();
    } catch {
      // Preserve the original chat failure even if the backend is already gone.
    }
    if (this.config.autoStart && managedBackendProcess) {
      await stopManagedOscarBackend();
      return;
    }
    try {
      await this.unloadModel();
    } catch {
      // Cleanup is best-effort; the caller still receives the original failure.
    }
  }

  private async ensureBackendAvailable(): Promise<void> {
    if (!this.config.autoStart || !isLocalApiBase(this.config.apiBase)) {
      return;
    }
    if (await this.isBackendReachable()) {
      return;
    }
    await startManagedOscarBackend(this.config);
  }

  private async isBackendReachable(): Promise<boolean> {
    try {
      await this.fetchJson('/api/health', { method: 'GET' }, 5000);
      return true;
    } catch {
      return false;
    }
  }

  private async getJson(path: string): Promise<unknown> {
    return this.fetchJson(path, {
      method: 'GET',
    });
  }

  private async postJson(path: string, body: unknown, timeoutMs = this.config.timeoutMs): Promise<unknown> {
    return this.fetchJson(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, timeoutMs);
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

  private async fetchJson(path: string, init: RequestInit, timeoutMs = this.config.timeoutMs): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
        throw new Error(`Oscar backend returned HTTP ${response.status}.`);
      }
      return await response.json() as unknown;
    } catch (error) {
      throw new Error(normalizeError(error, timeoutMs));
    } finally {
      clearTimeout(timeout);
    }
  }
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
  const request: OscarChatRequest = {
    messages,
    use_memory: readBooleanInput(input, 'use_memory', true),
    reasoning_effort: readReasoningEffort(input),
    max_new_tokens: readNumberInput(input, 'max_new_tokens', MAX_OSCAR_NEW_TOKENS, 32, MAX_OSCAR_NEW_TOKENS),
    temperature: readNumberInput(input, 'temperature', 0.3, 0, 1.5),
    top_p: readNumberInput(input, 'top_p', 0.9, 0.1, 1),
  };
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
let managedBackendStart: Promise<void> | null = null;

function cleanupManagedBackendOnExit() {
  if (managedBackendProcess) {
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

  const runtimeDir = path.join(projectRoot, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const packagedEnvironment = resolvePackagedOscarEnvironment(projectRoot);

  const port = readApiPort(config.apiBase);
  const out = openSync(path.join(runtimeDir, 'monarch-managed-backend.out.log'), 'a');
  const err = openSync(path.join(runtimeDir, 'monarch-managed-backend.err.log'), 'a');

  const child = spawn(
    pythonPath,
    ['-m', 'uvicorn', 'oscar_agent.main:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...packagedEnvironment,
        PYTORCH_CUDA_ALLOC_CONF: process.env.PYTORCH_CUDA_ALLOC_CONF || 'expandable_segments:True,max_split_size_mb:128',
        TOKENIZERS_PARALLELISM: process.env.TOKENIZERS_PARALLELISM || 'false',
        OSCAR_API_TOKEN: config.apiToken,
      },
      detached: false,
      windowsHide: true,
      stdio: ['ignore', out, err],
    }
  );
  closeSync(out);
  closeSync(err);
  managedBackendProcess = child;
  child.once('exit', () => {
    managedBackendProcess = null;
  });
  await waitForOscarHealth(config.apiBase, 15000);
}

async function stopManagedOscarBackend(): Promise<void> {
  const child = managedBackendProcess;
  managedBackendProcess = null;
  if (!child || child.killed) {
    return;
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
    : hasNvidiaRuntime()
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

function hasNvidiaRuntime(): boolean {
  if (process.platform !== 'win32') {
    return false;
  }
  return [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
    path.join(
      process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files',
      'NVIDIA Corporation',
      'NVSMI',
      'nvidia-smi.exe'
    ),
  ].some((candidate) => existsSync(candidate));
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

function isCoderChatRequest(request: OscarChatRequest): boolean {
  return request.messages.some((message) => message.role === 'system'
    && message.content.trim().startsWith('<monarch_coder_mode>')
    && message.content.trim().endsWith('</monarch_coder_mode>'));
}

function isTerminalCoderResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return true;
  }
  const proposals = (response as Record<string, unknown>).action_proposals;
  return !Array.isArray(proposals) || proposals.length === 0;
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
