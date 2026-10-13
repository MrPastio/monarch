import path from 'node:path';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRisk,
} from '../../core';
import {
  createDefaultOscarChatRequest,
  OscarClient,
  readBooleanInput,
  readMessagesInput,
  readNumberInput,
  readStringInput,
  type OscarChatMessage,
  type OscarAgentSkillContext,
} from './client';
import { oscarManifest } from './manifest';
import { buildLocalUserContextPrompt } from '../profile/prompt-context';

export class OscarModule implements MonarchModule {
  readonly manifest = oscarManifest;
  private readonly client: OscarClient;
  private ownerDevSettingsProvider: () => OscarOwnerDevPolicy = () => ({});

  constructor(client = new OscarClient()) {
    this.client = client;
  }

  setOwnerDevSettingsProvider(provider: () => OscarOwnerDevPolicy): void {
    this.ownerDevSettingsProvider = provider;
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('oscar.activated', this.manifest.id, {
      mode: 'monarch-port-bridge',
      apiBase: this.client.config.apiBase,
      projectRoot: this.client.config.projectRoot,
    });
  }

  async deactivate(context: MonarchKernelContext): Promise<void> {
    await this.client.shutdownManagedBackend();
    await context.emit('oscar.backend.stopped', this.manifest.id, {
      apiBase: this.client.config.apiBase,
    });
  }

  async health(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const status = await this.client.status();
    await context.emit('oscar.backend.checked', this.manifest.id, {
      connected: status.connected,
      apiBase: status.apiBase,
      error: status.error,
    });

    return {
      ok: true,
      summary: status.connected
        ? 'Oscar compatibility backend is reachable.'
        : 'Oscar compatibility backend is configured but not reachable.',
      output: status,
    };
  }

  resolveCapabilityRisk(request: MonarchExecutionRequest): MonarchRisk | undefined {
    if (request.capabilityId === 'oscar.chat.stream' && readBooleanInput(request.input, 'web_search', false)) {
      const messages = readMessagesInput(request.input);
      const lastUserMessage = messages.slice(-1).find((message) => message.role === 'user')?.content || '';
      return shouldKeepOscarQueryLocal(lastUserMessage) ? undefined : 'network';
    }
    return undefined;
  }


  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'oscar.status':
      return this.readStatus(context);
    case 'oscar.backend.start':
      return this.startBackend(context);
    case 'oscar.model.unload':
      return this.unloadModel(context);
    case 'oscar.generation.cancel':
      return this.cancelGeneration(context);
    case 'oscar.backend.stop':
      return this.stopBackend(context);
    case 'oscar.chat.local':
      return this.runChat(request.input, undefined, context);
    case 'oscar.chat.web':
      return this.runChat(request.input, true, context);
    case 'oscar.chat.route':
      return this.previewChatRoute(request.input);
    case 'oscar.chat.stream':
      return this.runChatStream(request.input, context);
    case 'oscar.conversations.manage':
      return this.manageConversations(request.input, context);
    case 'oscar.memory.manage':
      return this.manageMemory(request.input, context);
    case 'oscar.memory.derived.manage':
      return this.manageDerivedMemory(request.input, context);
    case 'oscar.memory.search':
      return this.searchMemory(request.input);
    case 'oscar.search.ingest':
      return this.searchAndIngest(request.input, context);
    default:
      return {
        ok: false,
        summary: `Unsupported Oscar capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private async readStatus(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const status = await this.client.status();
    await context.emit('oscar.backend.checked', this.manifest.id, {
      connected: status.connected,
      apiBase: status.apiBase,
      error: status.error,
    });

    return {
      ok: true,
      summary: status.connected
        ? 'Oscar backend status loaded through Monarch.'
        : 'Oscar backend is not reachable; Monarch port surface remains available.',
      output: {
        mode: 'monarch-port-bridge',
        nativePortStatus: 'compatibility-surface-ready',
        backend: status,
      },
    };
  }

  private async startBackend(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const status = await this.client.status({ autoStart: true });
    await context.emit('oscar.backend.started', this.manifest.id, {
      connected: status.connected,
      apiBase: status.apiBase,
      startupAttempted: status.startupAttempted,
      error: status.error,
    });

    const result: MonarchExecutionResult = {
      ok: status.connected,
      summary: status.connected
        ? 'Oscar backend started and status loaded through Monarch.'
        : 'Oscar backend start was attempted but the backend is still not reachable.',
      output: {
        mode: 'monarch-port-bridge',
        nativePortStatus: status.connected ? 'compatibility-surface-ready' : 'backend-start-failed',
        backend: status,
      },
    };
    if (!status.connected) {
      result.error = 'oscar-backend-start-failed';
    }
    return result;
  }

  private async unloadModel(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    try {
      const status = await this.client.unloadModel();
      await context.emit('oscar.model.unloaded', this.manifest.id, {
        apiBase: this.client.config.apiBase,
      });
      return {
        ok: true,
        summary: 'Oscar model memory unloaded.',
        output: {
          backend: status,
        },
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async cancelGeneration(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    try {
      const result = await this.client.cancelGeneration();
      await context.emit('oscar.generation.cancelled', this.manifest.id, {
        apiBase: this.client.config.apiBase,
      });
      return {
        ok: true,
        summary: 'Oscar generation cancel requested.',
        output: {
          backend: result,
        },
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async stopBackend(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    try {
      const result = await this.client.stopBackend();
      await context.emit('oscar.backend.stopped', this.manifest.id, {
        apiBase: this.client.config.apiBase,
      });
      return {
        ok: true,
        summary: 'Oscar backend stop requested.',
        output: {
          backend: result,
        },
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async runChat(
    input: unknown,
    webSearch: boolean | undefined,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const messages = readMessagesInput(input);
    if (messages.length === 0) {
      return {
        ok: false,
        summary: 'Oscar chat requires at least one message.',
        error: 'missing-messages',
      };
    }

    const lastUserMessage = messages.slice(-1).find(m => m.role === 'user')?.content || '';
    const dev = this.ownerDevSettingsProvider();
    let effectiveWebSearch = webSearch;
    if (dev.internetEnabled === false) effectiveWebSearch = false;
    if (effectiveWebSearch === true && shouldKeepOscarQueryLocal(lastUserMessage)) {
      effectiveWebSearch = false;
    }

    try {
      const chatRequest = createDefaultOscarChatRequest(
        dev.zeroRetentionEnabled || dev.memoryEnabled === false || dev.personalityEnabled === false
          ? messages
          : await withLocalUserContext(messages, context, lastUserMessage),
        effectiveWebSearch,
        input
      );
      applyOwnerDevChatPolicy(chatRequest, dev);
      applyMonarchRegistryRouteFloor(chatRequest, lastUserMessage);
      chatRequest.skills = [];
      const response = await this.client.chat(chatRequest);

      if (effectiveWebSearch === false && response && typeof response === 'object' && Array.isArray((response as Record<string, unknown>).sources)) {
        const anyResponse = response as { sources: unknown[] };
        anyResponse.sources = anyResponse.sources.filter((s: unknown) => {
          const url = typeof s === 'string' ? s : ((s as Record<string, unknown>)?.url || (s as Record<string, unknown>)?.href || (s as Record<string, unknown>)?.source || '');
          return !/^https?:\/\//i.test(String(url));
        });
      }

      const responseRecord = response && typeof response === 'object'
        ? response as Record<string, unknown>
        : {};
      const telemetryError = oscarChatResponseError(response);
      if (responseRecord.ok === false || telemetryError) {
        const error = telemetryError || 'oscar-chat-rejected';
        await context.emit('oscar.chat.failed', this.manifest.id, {
          webSearch: effectiveWebSearch === true,
          messages: messages.length,
          error,
        });
        return {
          ok: false,
          summary: 'Oscar не сформировал полный ответ. Незавершённый результат не считается успешным.',
          error,
          output: {
            request: summarizeChatRequest(chatRequest),
            response,
          },
        };
      }

      await context.emit('oscar.chat.completed', this.manifest.id, {
        webSearch: effectiveWebSearch === true,
        messages: messages.length,
      });

      return {
        ok: true,
        summary: effectiveWebSearch === true
          ? 'Oscar web chat completed through Monarch.'
          : 'Oscar local chat completed through Monarch.',
        output: {
          request: summarizeChatRequest(chatRequest),
          response,
        },
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async runChatStream(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const messages = readMessagesInput(input);
    if (messages.length === 0) {
      return {
        ok: false,
        summary: 'Oscar chat requires at least one message.',
        error: 'missing-messages',
      };
    }

    const lastUserMessage = messages.slice(-1).find(m => m.role === 'user')?.content || '';
    const dev = this.ownerDevSettingsProvider();
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    let effectiveWebSearch = typeof record.web_search === 'boolean' ? record.web_search : undefined;
    if (dev.internetEnabled === false) effectiveWebSearch = false;
    if (effectiveWebSearch === true && shouldKeepOscarQueryLocal(lastUserMessage)) {
      effectiveWebSearch = false;
    }

    try {
      const chatRequest = createDefaultOscarChatRequest(
        dev.zeroRetentionEnabled || dev.memoryEnabled === false || dev.personalityEnabled === false
          ? messages
          : await withLocalUserContext(messages, context, lastUserMessage),
        effectiveWebSearch,
        input
      );
      applyOwnerDevChatPolicy(chatRequest, dev);
      applyMonarchRegistryRouteFloor(chatRequest, lastUserMessage);
      chatRequest.skills = [];
      const stream = this.client.streamChat(chatRequest);
      
      return {
        ok: true,
        summary: 'Oscar chat streaming started through Monarch.',
        output: { stream }
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async previewChatRoute(input: unknown): Promise<MonarchExecutionResult> {
    const messages = readMessagesInput(input);
    if (messages.length === 0) {
      return { ok: false, summary: 'Oscar route preview requires at least one message.', error: 'missing-messages' };
    }
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const dev = this.ownerDevSettingsProvider();
    const webSearch = dev.internetEnabled === false
      ? false
      : typeof record.web_search === 'boolean' ? record.web_search : undefined;
    try {
      const request = createDefaultOscarChatRequest(messages, webSearch, input);
      applyOwnerDevChatPolicy(request, dev);
      applyMonarchRegistryRouteFloor(request, messages.slice(-1).find(message => message.role === 'user')?.content || '');
      const output = await this.client.previewChatRoute(request);
      return { ok: true, summary: 'Oscar route preview ready.', output };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async searchMemory(input: unknown): Promise<MonarchExecutionResult> {
    const query = readStringInput(input, 'query');
    if (!query) {
      return {
        ok: false,
        summary: 'Oscar memory search requires query.',
        error: 'missing-query',
      };
    }

    try {
      const limit = readNumberInput(input, 'limit', 6, 1, 20);
      const results = await this.client.searchMemory(query, limit);
      return {
        ok: true,
        summary: 'Oscar memory search completed through Monarch.',
        output: {
          query,
          limit,
          results,
        },
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async manageConversations(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const action = readStringInput(input, 'action');
    const conversationId = readStringInput(input, 'id');
    const messageId = readStringInput(input, 'message_id');
    const content = readStringInput(input, 'content');
    const role = readStringInput(input, 'role');
    const title = readStringInput(input, 'title');
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const messageLimit = readOptionalInteger(record.message_limit, 1, 200);
    const before = readOptionalInteger(record.before, 1, Number.MAX_SAFE_INTEGER);

    try {
      let output: unknown;
      if (action === 'list') {
        const listLimit = readOptionalInteger(record.limit, 1, 200);
        output = await this.client.listConversations({
          ...(record.include_archived === true ? { includeArchived: true } : {}),
          ...(listLimit !== undefined ? { limit: listLimit } : {}),
        });
      } else if (action === 'clear') {
        output = await this.client.clearConversations();
      } else if (action === 'create') {
        output = await this.client.createConversation(title || 'Новый чат');
      } else if (action === 'get' && conversationId) {
        output = await this.client.getConversation(conversationId, {
          ...(messageLimit !== undefined ? { messageLimit } : {}),
          ...(before !== undefined ? { before } : {}),
        });
      } else if (action === 'update' && conversationId) {
        output = await this.client.updateConversation(conversationId, {
          ...(title ? { title } : {}),
          ...(typeof record.archived === 'boolean' ? { archived: record.archived } : {}),
        });
      } else if (action === 'edit_message' && conversationId && messageId && content) {
        output = await this.client.editConversationMessage(conversationId, messageId, content);
      } else if (action === 'append_message' && conversationId && content && (role === 'user' || role === 'assistant')) {
        output = await this.client.appendConversationMessage(conversationId, {
          role,
          content,
          ...(typeof record.token_count === 'number' ? { token_count: record.token_count } : {}),
          ...(typeof record.elapsed_ms === 'number' ? { elapsed_ms: record.elapsed_ms } : {}),
          ...(typeof record.model_tier === 'string' ? { model_tier: record.model_tier } : {}),
          ...(typeof record.client_message_id === 'string' ? { client_message_id: record.client_message_id } : {}),
          ...(typeof record.turn_id === 'string' ? { turn_id: record.turn_id } : {}),
          ...(typeof record.task_id === 'string' ? { task_id: record.task_id } : {}),
          ...(record.provenance && typeof record.provenance === 'object' && !Array.isArray(record.provenance)
            ? { provenance: record.provenance as Record<string, unknown> }
            : {}),
          ...(typeof record.outcome === 'string' ? { outcome: record.outcome } : {}),
          ...(typeof record.integrity_warning === 'string' ? { integrity_warning: record.integrity_warning } : {}),
        });
      } else if (action === 'delete' && conversationId) {
        output = await this.client.deleteConversation(conversationId);
      } else {
        return {
          ok: false,
          summary: 'Oscar conversation action is invalid or missing an id.',
          error: 'invalid-conversation-action',
        };
      }

      if (action !== 'list' && action !== 'get') {
        await context.emit('oscar.conversations.changed', this.manifest.id, { action, conversationId });
      }
      return {
        ok: true,
        summary: `Oscar conversation ${action} completed.`,
        output,
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async manageMemory(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const action = readStringInput(input, 'action');
    const itemId = readStringInput(input, 'id');
    const content = readStringInput(input, 'content');
    const category = readStringInput(input, 'category');
    const type = readStringInput(input, 'type');
    const title = readStringInput(input, 'title');
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const tags = readStringArray(record.tags);
    const relatedFiles = readStringArray(record.related_files || record.relatedFiles);
    const relatedModules = readStringArray(record.related_modules || record.relatedModules);
    const priority = typeof record.priority === 'number' && Number.isFinite(record.priority) ? record.priority : undefined;
    const expiresAt = readStringInput(input, 'expires_at') || readStringInput(input, 'expiresAt');

    try {
      let output: unknown;
      if (action === 'list') {
        output = await this.client.listMemoryItems(true);
      } else if (action === 'create' && content) {
        output = await this.client.createMemoryItem({
          content,
          ...(category ? { category } : {}),
          ...(type ? { type } : {}),
          ...(title ? { title } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          ...(relatedFiles.length > 0 ? { related_files: relatedFiles } : {}),
          ...(relatedModules.length > 0 ? { related_modules: relatedModules } : {}),
        });
      } else if (action === 'update' && itemId) {
        output = await this.client.updateMemoryItem(itemId, {
          ...(content ? { content } : {}),
          ...(category ? { category } : {}),
          ...(type ? { type } : {}),
          ...(title ? { title } : {}),
          ...(Array.isArray(record.tags) ? { tags } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          ...(Array.isArray(record.related_files) || Array.isArray(record.relatedFiles) ? { related_files: relatedFiles } : {}),
          ...(Array.isArray(record.related_modules) || Array.isArray(record.relatedModules) ? { related_modules: relatedModules } : {}),
          ...(typeof record.closed === 'boolean' ? { closed: record.closed } : {}),
          ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
        });
      } else if (action === 'delete' && itemId) {
        output = await this.client.deleteMemoryItem(itemId);
      } else {
        return {
          ok: false,
          summary: 'Oscar memory action is invalid or missing required data.',
          error: 'invalid-memory-action',
        };
      }

      if (action !== 'list') {
        await context.emit('oscar.memory.changed', this.manifest.id, { action, itemId });
      }
      return {
        ok: true,
        summary: `Oscar memory ${action} completed.`,
        output,
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async manageDerivedMemory(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const action = readStringInput(input, 'action');
    const id = readStringInput(input, 'id');
    try {
      let output: unknown;
      if (action === 'list') {
        output = await this.client.listDerivedMemory();
      } else if (action === 'forget_episode' && id) {
        output = await this.client.forgetMemoryEpisode(id);
      } else if (action === 'forget_capsule' && id) {
        output = await this.client.forgetMemoryCapsule(id);
      } else if (action === 'forget_all') {
        output = await this.client.forgetAllDerivedMemory();
      } else {
        return {
          ok: false,
          summary: 'Oscar derived-memory action is invalid or missing required data.',
          error: 'invalid-derived-memory-action',
        };
      }
      if (action !== 'list') {
        await context.emit('oscar.memory.changed', this.manifest.id, { action, itemId: id });
      }
      return {
        ok: true,
        summary: `Oscar derived memory ${action} completed.`,
        output,
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async searchAndIngest(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const query = readStringInput(input, 'query');
    if (!query) {
      return {
        ok: false,
        summary: 'Oscar web search requires query.',
        error: 'missing-query',
      };
    }

    try {
      const maxResults = readNumberInput(input, 'max_results', 5, 1, 10);
      const fetchPages = readBooleanInput(input, 'fetch_pages', true);
      const results = await this.client.searchAndIngest({
        query,
        max_results: maxResults,
        fetch_pages: fetchPages,
      });
      await context.emit('oscar.search.completed', this.manifest.id, {
        query,
        maxResults,
        fetchPages,
      });
      return {
        ok: true,
        summary: 'Oscar web search completed through Monarch.',
        output: {
          query,
          max_results: maxResults,
          fetch_pages: fetchPages,
          results,
        },
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }
}

function summarizeChatRequest(request: {
  messages: OscarChatMessage[];
  web_search?: boolean;
  incognito?: boolean;
  use_memory: boolean;
  reasoning_effort: string;
  max_new_tokens: number;
  temperature: number;
  top_p: number;
  skills?: OscarAgentSkillContext[];
}): Record<string, unknown> {
  return {
    messages: request.messages.length,
    web_search: request.web_search,
    incognito: request.incognito === true,
    use_memory: request.use_memory,
    reasoning_effort: request.reasoning_effort,
    max_new_tokens: request.max_new_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    skills: (request.skills || []).map((skill) => skill.name),
  };
}

async function withLocalUserContext(
  messages: OscarChatMessage[],
  context: MonarchKernelContext,
  prompt: string,
): Promise<OscarChatMessage[]> {
  const [localContext, systemContext] = await Promise.all([
    buildLocalUserContextPrompt(context),
    Promise.resolve(buildLiveMonarchContextPrompt(context, prompt)),
  ]);
  const contextMessages: OscarChatMessage[] = [systemContext, localContext]
    .filter((entry): entry is string => Boolean(entry))
    .map((content) => ({ role: 'system', content }));
  return contextMessages.length > 0 ? [...contextMessages, ...messages] : messages;
}

function buildLiveMonarchContextPrompt(
  context: MonarchKernelContext,
  prompt: string,
): string | undefined {
  if (typeof context.listModules !== 'function') return undefined;
  const modules = context.listModules();
  if (modules.length === 0) return undefined;
  const registryPrompt = stripLeadingOscarAddress(prompt);
  const resolvedMentions = modules.filter((record) => modulePromptScore(record.manifest, registryPrompt) > 0);
  const wholeSystem = isWholeMonarchSystemQuery(registryPrompt) && resolvedMentions.length === 0;
  const relevant = wholeSystem ? modules : resolvedMentions;
  if (relevant.length === 0) return undefined;
  const snapshot = relevant.slice(0, 32).map((record) => ({
    id: record.manifest.id,
    name: record.manifest.name,
    version: record.manifest.version,
    kind: record.manifest.kind,
    status: record.status,
    description: record.manifest.description.slice(0, 240),
    dependencies: record.manifest.dependencies || [],
    capabilities: record.manifest.capabilities.map((capability) => capability.id).slice(0, 16),
  }));
  return [
    'Актуальные read-only данные Monarch Kernel, но не health-check. Несколько resolvedMentionIds — отдельные модули: не объединяй их. Отвечай естественно и не выгружай сырой JSON без прямого запроса.',
    '<live_monarch_system>',
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      scope: wholeSystem ? 'all' : 'relevant',
      resolvedMentionIds: resolvedMentions.map((record) => record.manifest.id),
      modules: snapshot,
    }),
    '</live_monarch_system>',
  ].join('\n');
}

function stripLeadingOscarAddress(value: string): string {
  return value.replace(
    /^\s*(?:(?:эй|привет|слушай|hey|hi)\s*[,!:—-]?\s*)?(?:оскар|oscar)(?:\s*[,!:—-]\s*|\s+)/iu,
    '',
  ).trimStart();
}

function shouldKeepOscarQueryLocal(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const explicitWebMarkers = /(найди|поищи|в интернете|актуальная информация|новости|сайт|цена|релиз|документация|поиск|search the web|look up|online)/i;
  if (explicitWebMarkers.test(lower)) return false;

  const isLocalOperationalQuery = /^(?:проверка связи|ping|oscar онлайн|проверка oscar|связь с backend|monarch electron работает|health check|self check)$/i.test(lower);
  const isInternalProjectQuery = /(что такое monarch|кто такой oscar|monarch|oscar|kernel|electron)/i.test(lower);
  const isRuntimeDiagnosticQuery = /(?:\b(?:fallback|runtime|backend)\b|бэкенд|рантайм|локальн\w*\s+модел|модел\w*\s+(?:не\s+)?загруз|(?:ты|oscar|оскар).{0,40}безопасн\w*\s+режим|(?:skill|навык).{0,30}(?:актив|работ|систем))/i.test(lower);
  return isLocalOperationalQuery || isInternalProjectQuery || isRuntimeDiagnosticQuery;
}

function isMonarchSystemAwarenessQuery(text: string): boolean {
  return hasExplicitMonarchScope(text)
    || /\b(?:safe|sharing)\b/i.test(text);
}

function hasExplicitMonarchScope(text: string): boolean {
  return /\bmonarch\b|монарх/i.test(text)
    || /(?:\bmodule\b|модул[а-яё]*)\s+(?:oscar|оскар|safe|sharing|security|безопасност|memory|памят|models?|модел|voice|голос|astra|coder|telegram)/i.test(text)
    || /(?:oscar|оскар|safe|sharing|security|безопасност|memory|памят|models?|модел|voice|голос|astra|coder|telegram)\s+(?:\bmodule\b|модул[а-яё]*)/i.test(text);
}

function applyMonarchRegistryRouteFloor(
  request: ReturnType<typeof createDefaultOscarChatRequest>,
  prompt: string,
): void {
  if (!isMonarchSystemAwarenessQuery(prompt) || request.model_selection_source === 'user-explicit') return;
  const current = request.route || {};
  request.route = {
    ...current,
    intentKind: current.intentKind || 'monarch_registry_question',
    modelTier: strongerOscarRouteTier(current.modelTier, 'medium'),
    language: current.language || (/[А-Яа-яЁё]/.test(prompt) ? 'ru' : 'en'),
  };
}

function strongerOscarRouteTier(current: string | undefined, floor: string): string {
  const rank: Record<string, number> = {
    weak: 0,
    'gemma4-fast': 0,
    medium: 1,
    'gemma4-balanced': 1,
    'qwen3.8-27b-pro': 2,
    // Read-time aliases only; no retired large Gemma runtime is exposed.
    powerful: 2,
    reasoning: 2,
    'gemma4-deepthinking': 2,
    'gemma4-31b': 2,
  };
  return (rank[current || ''] ?? -1) >= (rank[floor] ?? 0) ? current! : floor;
}

function isWholeMonarchSystemQuery(text: string): boolean {
  if (!/\bmonarch\b|монарх/i.test(text)) return false;
  return /\b(?:all|whole|entire|latest|newest|new|system|modules?)\b|(?:всю|весь|полностью|целиком|нов(?:ые|ое|ого|ей)|последн|актуальн|систем|модул)/i.test(text);
}

function modulePromptScore(
  manifest: { id: string; name: string; description: string; owns: string[] },
  prompt: string,
): number {
  const normalizedPrompt = normalizeModulePhrase(prompt);
  const terms = new Set(normalizedPrompt.split(' ').filter(Boolean));
  const ignored = new Set(['monarch', 'монарх', 'module', 'modules', 'модуль', 'модули', 'system', 'система']);
  const id = normalizeModulePhrase(manifest.id);
  const shortName = normalizeModulePhrase(manifest.name).replace(/^monarch\s+/, '');
  const scoped = hasExplicitMonarchScope(prompt);
  const unscopedDistinctiveIds = new Set(['safe', 'sharing', 'astra', 'coder', 'telegram']);
  if (!scoped && !unscopedDistinctiveIds.has(id) && !unscopedDistinctiveIds.has(shortName)) {
    return 0;
  }
  let score = id.length >= 3 && !ignored.has(id) && terms.has(id) ? 100 : 0;
  if (shortName.length >= 3 && !ignored.has(shortName) && includesModulePhrase(normalizedPrompt, shortName)) {
    score += 80;
  }
  if (scoped) {
    for (const owner of manifest.owns) {
      const alias = normalizeModulePhrase(owner).replace(/^monarch\s+/, '');
      if (alias.length >= 4 && !ignored.has(alias) && includesModulePhrase(normalizedPrompt, alias)) {
        score += 20;
      }
    }
  }
  return score;
}

function normalizeModulePhrase(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function includesModulePhrase(prompt: string, phrase: string): boolean {
  return ` ${prompt} `.includes(` ${phrase} `);
}

function backendUnavailableResult(error: unknown): MonarchExecutionResult {
  return {
    ok: false,
    summary: `Oscar backend adapter failed: ${error instanceof Error ? error.message : String(error)}`,
    error: 'oscar-backend-unavailable',
    metadata: {
      adapter: 'oscar-http',
    },
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 24)
    : [];
}

function readOptionalInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

export interface OscarModuleOptions {
  workspaceRoot?: string;
  logsRoot?: string;
  secretsRoot?: string;
}

interface OscarOwnerDevPolicy {
  zeroRetentionEnabled?: boolean;
  internetEnabled?: boolean;
  memoryEnabled?: boolean;
  historyContextEnabled?: boolean;
  personalityEnabled?: boolean;
  skillsEnabled?: boolean;
  runtimeContextEnabled?: boolean;
  qualityRegenerationEnabled?: boolean;
}

function applyOwnerDevChatPolicy(request: ReturnType<typeof createDefaultOscarChatRequest>, dev: OscarOwnerDevPolicy): void {
  if (dev.zeroRetentionEnabled) request.incognito = true;
  if (dev.internetEnabled === false) {
    request.web_search = false;
    request.research_mode = 'off';
  }
  if (dev.zeroRetentionEnabled || dev.memoryEnabled === false) request.use_memory = false;
  if (dev.historyContextEnabled === false) {
    const system = request.messages.filter((message) => message.role === 'system');
    const latestUser = [...request.messages].reverse().find((message) => message.role === 'user');
    request.messages = [...system, ...(latestUser ? [latestUser] : [])];
  }
  if (dev.personalityEnabled === false) {
    request.messages = request.messages.filter((message) => !message.content.includes('<monarch_personality_context'));
  }
  if (dev.skillsEnabled === false) request.skills = [];
  if (dev.runtimeContextEnabled === false) {
    request.messages = request.messages.filter((message) => !message.content.includes('<live_monarch_system>'));
  }
  request.dev_mode = {
    zero_retention: dev.zeroRetentionEnabled === true,
    internet_enabled: dev.internetEnabled !== false,
    memory_enabled: dev.memoryEnabled !== false,
    history_context_enabled: dev.historyContextEnabled !== false,
    personality_enabled: dev.personalityEnabled !== false,
    skills_enabled: dev.skillsEnabled !== false,
    runtime_context_enabled: dev.runtimeContextEnabled !== false,
    quality_regeneration_enabled: dev.qualityRegenerationEnabled !== false,
  };
}

function oscarChatResponseError(value: unknown): string {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const usage = record.usage && typeof record.usage === 'object'
    ? record.usage as Record<string, unknown>
    : {};
  const stopReason = typeof usage.generation_stop_reason === 'string'
    ? usage.generation_stop_reason.trim().toLowerCase()
    : '';
  if (usage.likely_truncated === true || ['length', 'max_tokens', 'max_new_tokens'].includes(stopReason)) {
    return 'model-output-truncated';
  }
  if (['cancelled', 'canceled'].includes(stopReason)) return 'model-generation-cancelled';
  if (stopReason === 'error') return 'model-generation-failed';
  if (['content_filter', 'content-filter'].includes(stopReason)) return 'model-output-filtered';
  if (['tool_calls', 'tool-calls', 'function_call'].includes(stopReason)) {
    return 'model-finish-reason-unsupported';
  }
  return '';
}

export function createOscarModule(options: OscarModuleOptions = {}): MonarchModule {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  return new OscarModule(new OscarClient({
    workspaceRoot,
    projectRoot: path.join(workspaceRoot, 'oscar'),
    ...(options.logsRoot ? { logsRoot: options.logsRoot } : {}),
    ...(options.secretsRoot ? { secretsRoot: options.secretsRoot } : {}),
  }));
}

export const oscarModulePackage: MonarchModulePackage = {
  id: oscarManifest.id,
  moduleId: oscarManifest.id,
  version: oscarManifest.version,
  description: oscarManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: (context) => createOscarModule({
    ...(context?.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    ...(context?.runtimePaths?.logsRoot ? { logsRoot: context.runtimePaths.logsRoot } : {}),
    ...(context?.runtimePaths?.secretsRoot ? { secretsRoot: context.runtimePaths.secretsRoot } : {}),
  }),
};
