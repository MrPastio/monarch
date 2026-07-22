import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRisk,
  MonarchRouteDecision,
} from '../../core';
import { classifyIntentText } from '../../core';
import {
  createDefaultOscarChatRequest,
  OscarClient,
  readBooleanInput,
  readMessagesInput,
  readNumberInput,
  readStringInput,
  type OscarChatMessage,
  type OscarAgentSkillContext,
  type OscarCapabilityContext,
  type OscarRouteHint,
} from './client';
import { oscarManifest } from './manifest';
import {
  type AgentSkillRegistry,
  getAgentSkillRegistry,
} from '../astra/agent-skills';
import { buildLocalUserContextPrompt } from '../profile/prompt-context';

export class OscarModule implements MonarchModule {
  readonly manifest = oscarManifest;
  private readonly client: OscarClient;
  private readonly agentSkills: Pick<AgentSkillRegistry, 'activateForPrompt'>;

  constructor(
    client = new OscarClient(),
    agentSkills: Pick<AgentSkillRegistry, 'activateForPrompt'> = getAgentSkillRegistry()
  ) {
    this.client = client;
    this.agentSkills = agentSkills;
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

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.trim();
    const lower = text.toLowerCase();
    if (!mentionsOscar(lower)) {
      return null;
    }
    const routedText = stripLeadingOscarAddress(text).toLowerCase();

    // Operational Security requests must be executed by the Security module itself.
    // Oscar remains the conversational surface, while Kernel keeps permission gates,
    // audit and dynamic risk resolution at the privileged capability boundary.
    if (isOscarSecurityOperation(routedText)) {
      return null;
    }

    if (isOscarWholeSystemInspection(routedText)) {
      return {
        intentId: intent.id,
        targetModuleId: 'diagnostics',
        capabilityId: 'diagnostics.system.inspect',
        confidence: 0.96,
        reason: 'Oscar delegates a requested whole-system inspection to live Monarch Diagnostics.',
        permissionMode: 'allow',
        input: { query: text },
      };
    }

    if (isOscarGenerationCancel(routedText)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'oscar.generation.cancel',
        confidence: 0.94,
        reason: 'User asks to cancel the active Oscar generation queue.',
        permissionMode: 'allow',
        input: {},
      };
    }

    if (isOscarBackendStop(routedText) || isOscarModelUnload(routedText)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: isOscarBackendStop(routedText)
          ? 'oscar.backend.stop'
          : 'oscar.model.unload',
        confidence: 0.96,
        reason: 'User asks to stop or unload Oscar runtime memory through Monarch.',
        permissionMode: 'confirm',
        input: {},
      };
    }

    if (/(?:\b(?:start|launch|boot|run)\b|запусти|включи|подними).*(backend|runtime|server|oscar|оскар)|(?:backend|runtime|server|oscar|оскар).*(?:\b(?:start|launch|boot|run)\b|запусти|включи|подними)/i.test(routedText)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'oscar.backend.start',
        confidence: 0.96,
        reason: 'User asks to start the managed Oscar backend.',
        permissionMode: 'confirm',
        input: {},
      };
    }
    if (mentionsBridgeOrSkillPreview(lower)) {
      return null;
    }

    if (isOscarStatusQuery(routedText)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'oscar.status',
        confidence: 0.98,
        reason: 'User asks for Oscar status through Monarch.',
        permissionMode: 'allow',
        input: {},
      };
    }

    if (isOscarWebSearch(routedText)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'oscar.search.ingest',
        confidence: 0.9,
        reason: 'User asks Oscar to run web search through Monarch.',
        permissionMode: 'confirm',
        input: {
          query: extractQuery(text),
          max_results: 5,
          fetch_pages: true,
        },
      };
    }

    if (isOscarMemorySearch(routedText)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'oscar.memory.search',
        confidence: 0.9,
        reason: 'User asks to search Oscar memory through Monarch.',
        permissionMode: 'allow',
        input: {
          query: extractQuery(text),
          limit: 6,
        },
      };
    }

    const requestedModel = /(gemma|гемма)/i.test(lower) ? 'gemma' : undefined;

    const chatText = extractQuery(text) || text;
    const classification = classifyIntentText(chatText);
    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'oscar.chat.local',
      confidence: 0.88,
      reason: 'User asks Oscar to chat through Monarch.',
      permissionMode: 'allow',
      input: {
        messages: createUserMessages(chatText),
        use_memory: true,
        reasoning_effort: 'low',
        route: createOscarRouteHint(classification, chatText),
        max_new_tokens: 65_536,
        temperature: 0.3,
        top_p: 0.9,
        ...(requestedModel ? { requested_model: requestedModel } : {}),
      },
    };
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
    case 'oscar.voice.fast':
      return this.runVoiceFast(request.input, context);
    case 'oscar.voice.realtime':
      return this.runVoiceRealtime(request.input, context);
    case 'oscar.chat.stream':
      return this.runChatStream(request.input, context);
    case 'oscar.conversations.manage':
      return this.manageConversations(request.input, context);
    case 'oscar.memory.manage':
      return this.manageMemory(request.input, context);
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
    const coderMode = isCoderModeMessages(messages);
    let effectiveWebSearch = webSearch;
    if (effectiveWebSearch === true && shouldKeepOscarQueryLocal(lastUserMessage)) {
      effectiveWebSearch = false;
    }

    try {
      const chatRequest = createDefaultOscarChatRequest(
        coderMode ? messages : await withLocalUserContext(messages, context, lastUserMessage),
        effectiveWebSearch,
        input
      );
      if (!coderMode) applyMonarchRegistryRouteFloor(chatRequest, lastUserMessage);
      this.attachCapabilityCatalog(chatRequest, context, lastUserMessage);
      if (!coderMode) {
        await this.attachAgentSkills(chatRequest, lastUserMessage, context);
      } else {
        chatRequest.skills = [];
      }
      const response = await this.client.chat(chatRequest);
      await context.emit('oscar.chat.completed', this.manifest.id, {
        webSearch: effectiveWebSearch === true,
        messages: messages.length,
      });

      if (effectiveWebSearch === false && response && typeof response === 'object' && Array.isArray((response as Record<string, unknown>).sources)) {
        const anyResponse = response as { sources: unknown[] };
        anyResponse.sources = anyResponse.sources.filter((s: unknown) => {
          const url = typeof s === 'string' ? s : ((s as Record<string, unknown>)?.url || (s as Record<string, unknown>)?.href || (s as Record<string, unknown>)?.source || '');
          return !/^https?:\/\//i.test(String(url));
        });
      }

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
    const coderMode = isCoderModeMessages(messages);
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    let effectiveWebSearch = typeof record.web_search === 'boolean' ? record.web_search : undefined;
    if (effectiveWebSearch === true && shouldKeepOscarQueryLocal(lastUserMessage)) {
      effectiveWebSearch = false;
    }

    try {
      const chatRequest = createDefaultOscarChatRequest(
        coderMode ? messages : await withLocalUserContext(messages, context, lastUserMessage),
        effectiveWebSearch,
        input
      );
      if (!coderMode) applyMonarchRegistryRouteFloor(chatRequest, lastUserMessage);
      this.attachCapabilityCatalog(chatRequest, context, lastUserMessage);
      if (!coderMode) {
        await this.attachAgentSkills(chatRequest, lastUserMessage, context);
      } else {
        chatRequest.skills = [];
      }
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
    const webSearch = typeof record.web_search === 'boolean' ? record.web_search : undefined;
    try {
      const request = createDefaultOscarChatRequest(messages, webSearch, input);
      applyMonarchRegistryRouteFloor(request, messages.slice(-1).find(message => message.role === 'user')?.content || '');
      const output = await this.client.previewChatRoute(request);
      return { ok: true, summary: 'Oscar route preview ready.', output };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async runVoiceFast(
    input: unknown,
    context: MonarchKernelContext,
  ): Promise<MonarchExecutionResult> {
    const record = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const text = typeof record.text === 'string'
      ? record.text.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    if (!text) {
      return { ok: false, summary: 'Fast voice needs a non-empty transcript.', error: 'voice-fast-text-empty' };
    }
    if (text.length > 1_200) {
      return { ok: false, summary: 'Fast voice transcript is too long.', error: 'voice-fast-text-too-long' };
    }
    const language = normalizeVoiceLanguage(record.language);
    if (record.language !== undefined && !language) {
      return { ok: false, summary: 'Fast voice language is not supported.', error: 'voice-fast-language-unsupported' };
    }
    const history = normalizeVoiceHistory(record.history);
    if (record.history !== undefined && !history) {
      return { ok: false, summary: 'Fast voice history is invalid.', error: 'voice-fast-history-invalid' };
    }
    try {
      const response = await this.client.voiceFast({
        text,
        ...(language ? { language } : {}),
        ...(history?.length ? { history } : {}),
      });
      await context.emit('oscar.voice.fast.completed', this.manifest.id, {
        model: response.model,
        generationMs: response.generation_ms,
        responseLength: response.text.length,
      });
      return {
        ok: true,
        summary: 'Dedicated Fast voice response completed.',
        output: response,
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async runVoiceRealtime(
    input: unknown,
    context: MonarchKernelContext,
  ): Promise<MonarchExecutionResult> {
    const record = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const text = typeof record.text === 'string'
      ? record.text.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    if (!text) {
      return { ok: false, summary: 'Realtime voice search needs a non-empty transcript.', error: 'voice-realtime-text-empty' };
    }
    if (text.length > 600) {
      return { ok: false, summary: 'Realtime voice search transcript is too long.', error: 'voice-realtime-text-too-long' };
    }
    const kind = record.kind === 'weather' || record.kind === 'web-search' ? record.kind : undefined;
    if (!kind) {
      return { ok: false, summary: 'Realtime voice search kind is not supported.', error: 'voice-realtime-kind-unsupported' };
    }
    const language = normalizeVoiceLanguage(record.language);
    if (record.language !== undefined && !language) {
      return { ok: false, summary: 'Realtime voice language is not supported.', error: 'voice-realtime-language-unsupported' };
    }
    const location = typeof record.location === 'string'
      ? record.location.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim()
      : undefined;
    if (record.location !== undefined && (!location || location.length > 120 || !/[\p{L}\p{N}]/u.test(location))) {
      return { ok: false, summary: 'Realtime voice weather location is invalid.', error: 'voice-realtime-location-invalid' };
    }
    if (kind === 'weather' && !location) {
      return { ok: false, summary: 'Realtime voice weather needs a location.', error: 'voice-weather-location-required' };
    }
    const history = normalizeVoiceHistory(record.history);
    if (record.history !== undefined && !history) {
      return { ok: false, summary: 'Realtime voice history is invalid.', error: 'voice-realtime-history-invalid' };
    }
    try {
      const response = await this.client.voiceRealtime({
        text,
        kind,
        ...(language ? { language } : {}),
        ...(kind === 'weather' && location ? { location } : {}),
        ...(history?.length ? { history } : {}),
      });
      await context.emit('oscar.voice.realtime.completed', this.manifest.id, {
        kind: response.kind,
        model: response.model,
        sourceCount: response.source_count,
        searchMs: response.search_ms,
        generationMs: response.generation_ms,
        responseLength: response.text.length,
      });
      return {
        ok: true,
        summary: 'Dedicated realtime voice search completed.',
        output: response,
      };
    } catch (error) {
      return backendUnavailableResult(error);
    }
  }

  private async attachAgentSkills(
    request: ReturnType<typeof createDefaultOscarChatRequest>,
    prompt: string,
    context: MonarchKernelContext
  ): Promise<void> {
    const skills = await this.agentSkills.activateForPrompt(prompt, {
      limit: 2,
      minimumScore: 0.55,
    });
    const activated = skills.map((skill): OscarAgentSkillContext => ({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      source: skill.location,
      explicit: skill.explicit,
    }));
    request.skills = [
      ...(mentionsOscarSecuritySubsystem(prompt) ? [MONARCH_SECURITY_SKILL] : []),
      ...activated,
    ];
    await context.emit('oscar.skills.activated', this.manifest.id, {
      skills: request.skills.map((skill) => skill.name),
      explicit: skills.filter((skill) => skill.explicit).map((skill) => skill.name),
    });
  }

  private attachCapabilityCatalog(
    request: ReturnType<typeof createDefaultOscarChatRequest>,
    context: MonarchKernelContext,
    prompt: string,
  ): void {
    const coderMode = isCoderModeMessages(request.messages);
    request.access = context.getPermissionProfile();
    const catalog = selectCapabilityCatalog(
      context.listCapabilities()
        .filter((capability) => !capability.id.startsWith('assistant.')
          && capability.id !== 'oscar.chat.stream'
          && (!request.incognito || capability.id !== 'memory.remember')
          && (!coderMode || capability.id.startsWith('coder.'))),
      prompt,
    );
    const coderSchemaIds = coderMode
      ? selectCoderDetailedSchemaIds(
          catalog,
          request.messages.map((message) => message.content).join('\n').slice(-24_000),
        )
      : null;
    request.capabilities = catalog
      .map((capability, index): OscarCapabilityContext => ({
        id: capability.id,
        module: capability.moduleId,
        system: subsystemName(capability.moduleId),
        title: capability.title,
        description: (capability.description || '').slice(0, 180),
        risk: capability.risk,
        ...(((coderSchemaIds?.has(capability.id) || (!coderMode && index < 8))) && capability.inputSchema
          ? { inputSchema: capability.inputSchema }
          : {}),
      }));
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
        output = await this.client.listConversations();
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

function isCoderModeMessages(messages: readonly OscarChatMessage[]): boolean {
  return messages.some((message) => message.role === 'system'
    && message.content.trim().startsWith('<monarch_coder_mode>')
    && message.content.trim().endsWith('</monarch_coder_mode>'));
}

function createOscarRouteHint(
  classification: ReturnType<typeof classifyIntentText>,
  text: string
): OscarRouteHint {
  const hint: OscarRouteHint = {
    intentKind: classification.kind,
    riskHint: classification.riskHint,
    language: /[А-Яа-яЁё]/.test(text) ? 'ru' : 'en',
  };
  if (classification.modelRolePreference !== 'vision' && classification.modelRolePreference !== 'router') {
    hint.modelTier = classification.modelRolePreference;
  }
  return hint;
}

function mentionsOscar(text: string): boolean {
  return /(oscar|оскар)/i.test(text);
}

function pairedOperationalMatch(text: string, action: RegExp, target: RegExp): boolean {
  return action.test(text) && target.test(text);
}

function isOscarGenerationCancel(text: string): boolean {
  return pairedOperationalMatch(
    text,
    /\b(?:cancel|abort)\b|отмени|прерви|сбрось/i,
    /\b(?:generation|response|queue)\b|генерац|ответ|очеред/i,
  );
}

function isOscarBackendStop(text: string): boolean {
  return pairedOperationalMatch(
    text,
    /\b(?:stop|kill|shutdown|disable)\b|останови|выключи|убей/i,
    /\b(?:backend|runtime|server|process|service)\b|бэкенд|рантайм|сервер|процесс|сервис/i,
  );
}

function isOscarModelUnload(text: string): boolean {
  return pairedOperationalMatch(
    text,
    /\b(?:unload|free|release|stop|clear)\b|свободи|освободи|выгрузи|останови|очисти/i,
    /\b(?:model|vram|model memory)\b|модел|видеопамят|памят\w*\s+модел/i,
  );
}

function isOscarStatusQuery(text: string): boolean {
  return /^(?:status|health|статус|состояние)[.!? ]*$/i.test(text) || pairedOperationalMatch(
    text,
    /\b(?:status|health|state)\b|статус|состояни|здоров/i,
    /\b(?:oscar|model|backend|runtime)\b|оскар|модел|бэкенд|рантайм/i,
  ) || /(?:which|what|какая|какой).{0,24}(?:model|модель).{0,24}(?:loaded|active|загруж|активн)/i.test(text);
}

function isOscarMemorySearch(text: string): boolean {
  return /\brecall\b|вспомни/i.test(text)
    || pairedOperationalMatch(
      text,
      /\b(?:search|find|show|remember)\b|найди|поищи|покажи|что\s+ты\s+помнишь/i,
      /\bmemory\b|памят/i,
    );
}

function isOscarWebSearch(text: string): boolean {
  if (/\bmemory\b|памят/i.test(text)) return false;
  if (/\b(?:file|folder|project|repo(?:sitory)?|code|workspace)\b|файл|папк|проект|репозитор|код|workspace/i.test(text)) return false;
  return /^(?:search|find|найди|поищи)\b/i.test(text)
    || /\b(?:web\s+search|search\s+(?:the\s+)?web)\b|веб[- ]?поиск/i.test(text)
    || pairedOperationalMatch(
      text,
      /\b(?:search|find|look\s+up|check)\b|найди|поищи|проверь|посмотри/i,
      /\b(?:internet|online|web|site)\b|интернет|в\s+сети|сайт/i,
    );
}

const MONARCH_SECURITY_SKILL: OscarAgentSkillContext = {
  name: 'monarch-security',
  description: 'Native knowledge and operating contract for the Monarch Security subsystem.',
  source: 'builtin://monarch/security',
  explicit: false,
  instructions: [
    'Monarch Security is the local protection subsystem integrated with Oscar through Monarch Kernel; its explicit user profile can disable both monitoring and controller checks.',
    'Use declared security.* capabilities for status, incidents, integrity, audit, network center, quarantine, scans, reports, response proposals, emergency state, PIN, baseline and protection control.',
    'Read-only scans and status may run directly when policy allows. Mutating, privileged, emergency, quarantine restore, trust, protection stop and response actions must retain Kernel confirmation, PIN and dynamic risk checks.',
    'Never execute Security CLI commands directly, bypass Kernel, invent a scan result, approve a baseline, weaken protection, expose signatures/PIN/recovery codes, or treat LLM output as authorization.',
    'For a suspicious file prefer security.deep_scan.file or security.scan.path; for the host use security.scan.system; for connections use security.scan.network and security.network.center; for active threats inspect security.incidents.list before proposing a response.',
    'Only report an action as completed after a real Monarch capability execution result.',
  ].join('\n'),
};

function isOscarSecurityOperation(text: string): boolean {
  const mentionsSubsystem = mentionsOscarSecuritySubsystem(text);
  const requestsAction = /scan|check|status|start|stop|enable|disable|verify|inspect|list|show|report|audit|diagnos|quarantine|isolate|restore|block|approve|resolve|baseline|benchmark|скан|проверь|провер|статус|запуст|останов|включ|выключ|покаж|список|отч[её]т|аудит|диагност|карантин|изолир|восстанов|заблок|одобр|реши|норм|бенчмарк/i.test(text);
  return mentionsSubsystem && requestsAction;
}

function mentionsOscarSecuritySubsystem(text: string): boolean {
  const strongTechnicalCue = /\b(?:security|monarch security|protector|defender|firewall|antivirus|malware|trojan|ransomware|quarantine|autorun|persistence|agent guard|usb)\b|монарх\s+security|модул[а-яё]*\s+безопасност|антивирус|троян|rat(?:ка|ки)?|карантин|автозапуск|фаервол|защитник\s+windows/i;
  if (strongTechnicalCue.test(text)) return true;
  if (/^(?:security|безопасность|проверь безопасность|статус защиты)[.!? ]*$/i.test(text)) return true;
  const weakSecurityCue = /\b(?:security|protect|virus|threat|incident|emergency|audit|integrity|scan)\b|безопас|защит|вирус|угроз|инцидент|экстрен|скан|аудит|целост/i;
  const technicalTarget = /\b(?:monarch|oscar|windows|computer|host|system|file|process|network|port|device|code|repo(?:sitory)?)\b|монарх|оскар|windows|компьютер|хост|систем|файл|процесс|сеть|порт|устройств|код|репозитор/i;
  return weakSecurityCue.test(text) && technicalTarget.test(text);
}

function isOscarWholeSystemInspection(text: string): boolean {
  return /\b(?:check|inspect|diagnose|audit|self[- ]?check)\b.{0,48}\b(?:monarch|all\s+modules?|whole\s+system|entire\s+system|full\s+system)\b/i.test(text)
    || /(?:проверь|проверить|диагност|самопровер|проаудит).{0,48}(?:monarch|монарх|все\s+модул|всю\s+систем|систем\w*\s+целиком)/i.test(text)
    || /^(?:check|inspect|diagnose)\s+(?:the\s+)?(?:whole\s+|entire\s+|full\s+)?system[.!? ]*$/i.test(text)
    || /^(?:проверь|диагностируй)\s+(?:всю\s+|полностью\s+)?систему[.!? ]*$/i.test(text);
}

function extractQuery(text: string): string {
  return text
    .replace(/^(ask|chat|search|find|recall|show|status|health|спроси|чат|найди|вспомни|покажи|статус)\s+/i, '')
    .replace(/\b(oscar|оскар)\b[:,\s-]*/i, '')
    .replace(/\b(with web|web search|через веб|с вебом|в интернете)\b/ig, '')
    .trim();
}

function createUserMessages(content: string): OscarChatMessage[] {
  const normalized = content.trim();
  return normalized ? [{ role: 'user', content: normalized }] : [];
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
  capabilities?: OscarCapabilityContext[];
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
    capabilities: (request.capabilities || []).length,
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

function subsystemName(moduleId: string): string {
  const names: Record<string, string> = {
    astra: 'Monarch Skills',
    diagnostics: 'Monarch Diagnostics',
    device: 'Monarch Device',
    memory: 'Monarch Memory',
    models: 'Monarch Models',
    plugins: 'Monarch Extensions',
    safe: 'Monarch Safe',
    security: 'Monarch Security',
    sharing: 'Monarch Sharing',
    telegram: 'Monarch Telegram',
    voice: 'Monarch Voice',
    workspace: 'Monarch Workspace',
    'custom-tools': 'Monarch Tools',
  };
  return names[moduleId] || `Monarch ${moduleId}`;
}

function mentionsBridgeOrSkillPreview(text: string): boolean {
  return /\b(?:bridge|integration|slot|preview|agent card|skill card)\b|интеграц|слот|карточк/i.test(text)
    || containsRussianBridgeTerm(text);
}

function containsRussianBridgeTerm(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}_])(?:мост(?:а|ом|у|ы|е|ах|ами)?|связ(?:ь|и|ью|ям|ями|ях)?)(?=$|[^\p{L}\p{N}_])/iu.test(text);
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
    || /(?:\bmodule\b|модул[а-яё]*)\s+(?:oscar|оскар|safe|sharing|security|безопасност|memory|памят|models?|модел|voice|голос|astra|studio|coder|telegram)/i.test(text)
    || /(?:oscar|оскар|safe|sharing|security|безопасност|memory|памят|models?|модел|voice|голос|astra|studio|coder|telegram)\s+(?:\bmodule\b|модул[а-яё]*)/i.test(text);
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
    powerful: 2,
    reasoning: 2,
    'gemma4-deepthinking': 2,
    'gemma4-31b': 3,
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
  const unscopedDistinctiveIds = new Set(['safe', 'sharing', 'astra', 'studio', 'coder', 'telegram']);
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

function capabilityPromptScore(
  capability: {
    id: string;
    moduleId: string;
    title: string;
    description?: string;
    routing?: { aliases?: string[]; keywords?: string[]; examples?: string[]; intentKinds?: string[] };
  },
  prompt: string,
): number {
  const priorities: Record<string, number> = {
    coder: 110,
    device: 95,
    workspace: 90,
    models: 80,
    diagnostics: 75,
    memory: 70,
    security: 65,
    sharing: 64,
    safe: 63,
    'custom-tools': 60,
    astra: 55,
    plugins: 45,
    profile: 35,
    voice: 30,
    telegram: 28,
    artifacts: 25,
    oscar: 20,
  };
  const routing = capability.routing;
  const haystack = [
    capability.id,
    capability.moduleId,
    capability.title,
    capability.description || '',
    ...(routing?.aliases || []),
    ...(routing?.keywords || []),
    ...(routing?.examples || []),
    ...(routing?.intentKinds || []),
  ].join(' ').toLowerCase();
  const terms = prompt.toLowerCase().split(/[^\p{L}\p{N}._]+/u).filter(term => term.length >= 3);
  const relevance = terms.reduce((score, term) => score + (haystack.includes(term) ? 50 : 0), 0);
  return relevance + (priorities[capability.moduleId] || 0);
}

function selectCapabilityCatalog<T extends {
  id: string;
  moduleId: string;
  title: string;
  description?: string;
  routing?: { aliases?: string[]; keywords?: string[]; examples?: string[]; intentKinds?: string[] };
}>(
  capabilities: readonly T[],
  prompt: string,
): T[] {
  const ranked = [...capabilities].sort(
    (left, right) => capabilityPromptScore(right, prompt) - capabilityPromptScore(left, prompt),
  );
  const selected: T[] = [];
  const seen = new Set<string>();
  const securityFocused = /security|безопасност|защит|угроз|вирус|троян|карантин|инцидент|сеть|автозапуск/i.test(prompt);
  const systemFocused = isMonarchSystemAwarenessQuery(prompt);
  if (systemFocused) {
    for (const capability of ranked.filter((entry) => entry.id === 'diagnostics.system.inspect'
      || entry.id === 'diagnostics.modules.list')) {
      selected.push(capability);
      seen.add(capability.id);
    }
  }
  if (securityFocused) {
    for (const capability of ranked.filter(entry => entry.moduleId === 'security')) {
      selected.push(capability);
      seen.add(capability.id);
    }
  }
  const systemOrder = ['coder', 'device', 'workspace', 'models', 'diagnostics', 'memory', 'astra', 'security', 'sharing', 'safe', 'voice', 'telegram'];

  for (const moduleId of systemOrder) {
    for (const capability of ranked.filter(entry => entry.moduleId === moduleId).slice(0, 1)) {
      if (!seen.has(capability.id)) {
        selected.push(capability);
        seen.add(capability.id);
      }
    }
  }
  for (const capability of ranked) {
    if (selected.length >= 48) break;
    if (!seen.has(capability.id)) {
      selected.push(capability);
      seen.add(capability.id);
    }
  }
  return selected.slice(0, 48);
}

const MAX_CODER_DETAILED_SCHEMAS = 12;
const CORE_CODER_SCHEMA_IDS = new Set([
  'coder.files.list',
  'coder.files.read',
  'coder.files.write',
  'coder.files.patch',
  'coder.files.delete',
  'coder.command.run',
]);

function selectCoderDetailedSchemaIds<T extends { id: string; moduleId: string; title: string; description?: string }>(
  capabilities: readonly T[],
  prompt: string,
): Set<string> {
  const available = new Set(capabilities.map((capability) => capability.id));
  const selected = new Set([...CORE_CODER_SCHEMA_IDS].filter((id) => available.has(id)));
  const ranked = [...capabilities].sort(
    (left, right) => capabilityPromptScore(right, prompt) - capabilityPromptScore(left, prompt),
  );
  for (const capability of ranked) {
    if (selected.size >= MAX_CODER_DETAILED_SCHEMAS) break;
    selected.add(capability.id);
  }
  return selected;
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

function normalizeVoiceLanguage(value: unknown): 'ru' | 'uk' | 'bg' | 'en' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().split(/[-_]/, 1)[0];
  return normalized === 'ru' || normalized === 'uk' || normalized === 'bg' || normalized === 'en'
    ? normalized
    : undefined;
}

function normalizeVoiceHistory(
  value: unknown,
): Array<{ role: 'user' | 'assistant'; content: string }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return null;
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (record.role !== 'user' && record.role !== 'assistant') return null;
    const content = typeof record.content === 'string'
      ? record.content.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    if (!content || content.length > 800) return null;
    history.push({ role: record.role, content });
  }
  return history;
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

export function createOscarModule(): MonarchModule {
  return new OscarModule();
}

export const oscarModulePackage: MonarchModulePackage = {
  id: oscarManifest.id,
  moduleId: oscarManifest.id,
  version: oscarManifest.version,
  description: oscarManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createOscarModule,
};
