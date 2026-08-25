import type { MonarchRuntimePaths } from '../core';
import path from 'node:path';
import type { MonarchAgentRuntime } from '../agent';
import {
  renderPersonalitySystemContext,
  resolvePersonalityContext,
  DEFAULT_OWNER_DEV_SETTINGS,
  type MonarchOwnerDevSettingsV1,
  type SettingsCommandBus,
} from '../settings';
import {
  OscarClient,
  createDefaultOscarChatRequest,
  type OscarAgentSkillContext,
  type OscarBackendStatus,
  type OscarChatMessage,
  type OscarChatRequest,
} from '../modules/oscar/client';
import {
  LocalJsonOscarTurnStore,
  InMemoryOscarTurnStore,
  OscarAttachmentStore,
  OscarDataEgressConsentStore,
  OscarTurnCoordinator,
  effectiveTurnRequest,
  type OscarAnswerExecutionInput,
  type OscarAnswerExecutorEvent,
  type OscarMessagePersistenceReceipt,
  type OscarPersistedMessage,
} from '../oscar-turn';
import {
  getAgentSkillRegistry,
  type AgentSkillRegistry,
} from '../modules/astra/agent-skills';
import { requestReferencesComputerUseCapability } from '../modules/computer';

export function createApplicationOscarTurnCoordinator(input: {
  sourceRoot: string;
  runtimePaths: MonarchRuntimePaths;
  agentRuntime: MonarchAgentRuntime | null;
  incognitoAgentRuntime: MonarchAgentRuntime | null;
  attachments: OscarAttachmentStore;
  dataEgressConsents: OscarDataEgressConsentStore;
  settingsCommandBus: SettingsCommandBus;
  getOwnerDevSettings?: () => MonarchOwnerDevSettingsV1;
  agentSkills?: Pick<AgentSkillRegistry, 'activateForPrompt'>;
}): OscarTurnCoordinator {
  const client = new OscarClient({
    workspaceRoot: input.sourceRoot,
    projectRoot: path.join(input.sourceRoot, 'oscar'),
    logsRoot: input.runtimePaths.logsRoot,
    secretsRoot: input.runtimePaths.secretsRoot,
  });
  const agentSkills = input.agentSkills || getAgentSkillRegistry(input.sourceRoot);
  return new OscarTurnCoordinator({
    persistentStore: new LocalJsonOscarTurnStore(
      path.join(input.runtimePaths.stateRoot, 'oscar', 'turns.v1.json'),
    ),
    volatileStore: new InMemoryOscarTurnStore(),
    agentRuntime: input.agentRuntime,
    incognitoAgentRuntime: input.incognitoAgentRuntime,
    answerExecutor: async (execution) => {
      const requestText = effectiveTurnRequest(execution.turn);
      if (isDirectRuntimeStatusQuestion(requestText)) {
        return verifiedRuntimeStatusStream(await client.status({ autoStart: true }), requestText);
      }
      const devSettings = input.getOwnerDevSettings?.() || DEFAULT_OWNER_DEV_SETTINGS;
      const skills = await resolveOscarTurnSkillContexts(
        requestText,
        agentSkills,
        devSettings.skillsEnabled,
      );
      return mapOscarAnswerStream(client.streamChat(
        buildOscarTurnAnswerRequest(execution, 'auto', devSettings, skills),
        execution.signal,
      ));
    },
    answerFallback: async (execution) => {
      const devSettings = input.getOwnerDevSettings?.() || DEFAULT_OWNER_DEV_SETTINGS;
      const skills = await resolveOscarTurnSkillContexts(
        effectiveTurnRequest(execution.turn),
        agentSkills,
        devSettings.skillsEnabled,
      );
      const payload = await client.chat(
        buildOscarTurnAnswerRequest(execution, 'recovery', devSettings, skills),
        execution.signal,
      );
      const record = asRecord(payload) || {};
      const answer = readAnswerText(record.answer) || readAnswerText(record.content) || readChoiceAnswer(record);
      const usage = asRecord(record.usage);
      if (isRejectedOscarRecoveryPayload(record)) {
        throw new Error('Oscar recovery finished without a trustworthy final answer.');
      }
      return {
        answer,
        sources: Array.isArray(record.sources) ? record.sources : [],
        ...(usage ? { usage } : {}),
      };
    },
    persistMessage: (message) => input.getOwnerDevSettings?.().zeroRetentionEnabled
      ? Promise.resolve({ disposition: 'duplicate' as const })
      : persistCoordinatorMessage(client, message, input.getOwnerDevSettings?.()),
    resolveAttachments: (ids, privacyMode, source, conversationId) => (
      input.attachments.resolve(ids, privacyMode, source, conversationId)
    ),
    consumeDataEgressConsent: (consentId, turn) => input.dataEgressConsents.consume(consentId, turn.id, {
      conversationId: turn.conversationId,
      privacyMode: turn.privacyMode,
      source: turn.source,
      text: effectiveTurnRequest(turn),
      attachmentIds: turn.request.attachmentIds,
      webSearch: turn.request.modifiers.webSearch === true,
      researchMode: turn.request.modifiers.researchMode || 'auto',
    }).then(() => undefined),
    resolvePersonality: async ({ source, privacyMode }) => {
      const dev = input.getOwnerDevSettings?.();
      if (source !== 'desktop' || privacyMode !== 'persistent' || dev?.zeroRetentionEnabled || dev?.personalityEnabled === false) return null;
      const context = await input.settingsCommandBus.read({
        schemaVersion: 1,
        kind: 'personality',
        scope: { type: 'chat' },
      }, 'desktop');
      return resolvePersonalityContext(context.value);
    },
    rememberMemory: async ({ turn, text }) => {
      const dev = input.getOwnerDevSettings?.();
      if (dev?.zeroRetentionEnabled || dev?.memoryEnabled === false) {
        throw new Error('Permanent memory is disabled by the verified Owner DEV policy.');
      }
      const scope = { type: 'chat' as const };
      const current = await input.settingsCommandBus.read({
        schemaVersion: 1,
        kind: 'memory',
        scope,
      }, 'desktop');
      const receipt = await input.settingsCommandBus.execute({
        schemaVersion: 1,
        clientRequestId: `memory_turn_${turn.id}`,
        command: 'memory.create',
        scope,
        expectedRevision: current.revision,
        payload: {
          text,
          category: inferMemoryCategory(text),
          source: 'user-explicit-chat-command',
          pinned: /(?:всегда|никогда|always|never)/iu.test(text),
        },
      }, 'desktop');
      return {
        receiptId: receipt.receiptId,
        revision: receipt.revision,
        contentHash: receipt.contentHash,
      };
    },
  });
}

function inferMemoryCategory(text: string): 'preference' | 'profile' | 'project' | 'instruction' | 'fact' {
  if (/(?:предпочитаю|люблю|не\s+люблю|мне\s+нрав|prefer|preference)/iu.test(text)) return 'preference';
  if (/(?:меня\s+зовут|я\s+живу|я\s+работаю|my\s+name|i\s+am)/iu.test(text)) return 'profile';
  if (/(?:проект|репозитор|workspace|project)/iu.test(text)) return 'project';
  if (/(?:всегда|никогда|отвечай|обращайся|always|never)/iu.test(text)) return 'instruction';
  return 'fact';
}

export function buildOscarTurnAnswerRequest(
  input: OscarAnswerExecutionInput,
  selectionSource: 'auto' | 'recovery' = 'auto',
  devSettings: MonarchOwnerDevSettingsV1 = DEFAULT_OWNER_DEV_SETTINGS,
  skills: OscarAgentSkillContext[] = [],
): OscarChatRequest {
  const zeroRetention = devSettings.zeroRetentionEnabled;
  const contextProfile = resolveOscarAnswerContextProfile(input);
  const effectiveRequest = effectiveTurnRequest(input.turn);
  const modifiers = input.turn.request.modifiers;
  const includeImageCapability = Boolean(modifiers.imageGeneration)
    || requestReferencesImageGenerationCapability(effectiveRequest);
  const includeComputerUseCapability = requestReferencesComputerUseCapability(effectiveRequest);
  const messages: OscarChatMessage[] = [
    ...(devSettings.personalityEnabled && input.turn.request.personality ? [{
      role: 'system' as const,
      content: renderPersonalitySystemContext(input.turn.request.personality),
    }] : []),
    ...(includeImageCapability && modifiers.imageGenerationCapability ? [{
      role: 'system' as const,
      content: renderImageGenerationCapabilitySystemContext(
        modifiers.imageGenerationCapability,
      ),
    }] : []),
    ...(includeComputerUseCapability && modifiers.computerUseCapability ? [{
      role: 'system' as const,
      content: renderComputerUseCapabilitySystemContext(
        modifiers.computerUseCapability,
      ),
    }] : []),
    ...(input.turn.request.modifiers.imageGeneration ? [{
      role: 'system' as const,
      content: renderImageGenerationSystemContext(input.turn.request.modifiers.imageGeneration),
    }] : []),
    ...(devSettings.historyContextEnabled ? (input.turn.request.history || []).map((message) => ({ ...message })) : []),
    { role: 'user', content: effectiveRequest },
  ];
  const research = devSettings.internetEnabled
    ? resolveOscarAnswerResearchPolicy(modifiers)
    : { webSearch: false, researchMode: 'off' as const };
  const request = createDefaultOscarChatRequest(messages, research.webSearch, {
    conversation_id: input.turn.conversationId,
    incognito: zeroRetention || input.turn.privacyMode !== 'persistent',
    image_attachments: input.attachments.map((attachment) => ({
      mime_type: attachment.mimeType,
      data_base64: attachment.dataBase64,
      name: attachment.name,
      size_bytes: attachment.sizeBytes,
    })),
    research_mode: research.researchMode,
    use_memory: contextProfile === 'full'
      && !zeroRetention
      && devSettings.memoryEnabled
      && input.turn.privacyMode === 'persistent',
    context_profile: contextProfile,
    ...(contextProfile === 'compact-social' ? { max_new_tokens: 256 } : {}),
    reasoning_effort: modifiers.reasoningEffort || 'medium',
    requested_model: modifiers.requestedModel,
    model_selection_source: modifiers.requestedModel ? selectionSource : undefined,
    execution_authority: 'none',
    persistence_owner: 'coordinator',
    turn_id: input.turn.id,
    client_message_id: input.turn.inputMessageId,
    dev_mode: {
      zero_retention: zeroRetention,
      internet_enabled: devSettings.internetEnabled,
      memory_enabled: devSettings.memoryEnabled,
      history_context_enabled: devSettings.historyContextEnabled,
      personality_enabled: devSettings.personalityEnabled,
      skills_enabled: devSettings.skillsEnabled,
      runtime_context_enabled: devSettings.runtimeContextEnabled,
      quality_regeneration_enabled: devSettings.qualityRegenerationEnabled,
    },
  });
  if (devSettings.skillsEnabled && skills.length > 0) request.skills = skills.slice(0, 3);
  return request;
}

export async function resolveOscarTurnSkillContexts(
  prompt: string,
  registry: Pick<AgentSkillRegistry, 'activateForPrompt'>,
  enabled = true,
): Promise<OscarAgentSkillContext[]> {
  if (!enabled) return [];
  const activated = await registry.activateForPrompt(prompt, {
    limit: 2,
    minimumScore: 0.55,
  });
  return activated.map((skill) => ({
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    source: skill.location,
    explicit: skill.explicit,
  }));
}

export function resolveOscarAnswerContextProfile(
  input: Pick<OscarAnswerExecutionInput, 'turn' | 'attachments'>,
): 'full' | 'compact-social' {
  const text = effectiveTurnRequest(input.turn).replace(/\s+/gu, ' ').trim();
  if (!text || input.attachments.length > 0 || text.length > 240) return 'full';
  if (input.turn.request.modifiers.webSearch === true
    || input.turn.request.modifiers.researchMode === 'deep'
    || input.turn.request.modifiers.imageGeneration
    ) return 'full';
  const memoryDependent = /(?:\b(?:remember|recall|previous|earlier|last\s+time|we\s+(?:discussed|decided)|my\s+(?:preference|project|settings))\b|помнишь|вспомни|раньше|в\s+прошл(?:ый|ом)\s+раз|мы\s+(?:обсуждали|решили)|мо[ийяе]\s+(?:предпочтени|проект|настройк)|как\s+тебе\s+(?:это|этот|эта|эти)(?:\s*[?!.]|$))/iu.test(text);
  if (memoryDependent) return 'full';
  const compactSocial = /^(?:(?:ну|а|и)\s+)?(?:привет|здравствуй|доброе\s+(?:утро|утречко)|спасибо|благодарю|как\s+дела|как\s+настроение|как\s+тебе(?=\s|[?!.]|$)|тебе\s+нравится(?=\s|[?!.]|$)|ты\s+(?:рад|доволен|готов)(?=\s|[?!.]|$)|что\s+думаешь\s+(?:о|про)(?=\s|[?!.]|$)|hello|hi|hey|thanks|thank\s+you|how\s+are\s+you|how\s+do\s+you\s+like\b|do\s+you\s+like\b|what\s+do\s+you\s+think\s+(?:of|about)\b)/iu.test(text);
  return compactSocial ? 'compact-social' : 'full';
}

function requestReferencesImageGenerationCapability(value: unknown): boolean {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!text) return false;
  if (/(?:изображен\w*|картин\w*|рисунк\w*|нарис\w*|генер\w*\s+(?:фото|арт|визуал)|\bimage\w*|\bpicture\w*|\bdraw\w*|\bphoto\w*)/iu.test(text)) return true;
  return /(?:что|какие)\s+(?:ты\s+)?(?:умеешь|можешь|возможност)|\bwhat\s+can\s+you\s+do\b|\byour\s+capabilit/iu.test(text);
}

function renderComputerUseCapabilitySystemContext(
  capability: NonNullable<OscarAnswerExecutionInput['turn']['request']['modifiers']['computerUseCapability']>,
): string {
  return [
    '<monarch_computer_use_capability version="1">',
    'Это доверенный снимок реальной функции Monarch, а не текст пользователя и не доказательство уже выполненного действия.',
    capability.available
      ? 'Нативный Computer Use доступен: Oscar может в Agent Runtime получить снимок окна, проанализировать его и выполнить проверенное типизированное действие.'
      : 'Функция Computer Use существует, но нативный provider сейчас недоступен; не изображай управление компьютером до восстановления runtime.',
    capability.enabled
      ? 'Сейчас Computer Use включён пользователем.'
      : 'Сейчас Computer Use остановлен. Пользователь может включить его через явный UI-контрол; Oscar не включает его сам.',
    'У Computer Use есть постоянно отображаемый собственный логический курсор Oscar; поддерживаемые атомы включают наблюдение окна, клик, ввод текста, клавиши, прокрутку и закрытие точного окна.',
    `Явный вызов в чате: ${capability.invocation}. Мгновенная остановка: ${capability.emergencyShortcut} или кнопка Stop.`,
    'На вопрос о впечатлении или отношении дай короткое собственное мнение и назови минимум два конкретных свойства из этого снимка — например цикл «снимок → анализ → действие» и собственный курсор либо аварийную остановку. Не отвечай общими словами о «новых возможностях».',
    'Каждое действие всё равно проходит Kernel, Action Guard и receipt-проверку. executionAuthority=none этого answer-turn запрещает утверждать, что окно уже открыто, курсор двигался или действие завершено.',
    '</monarch_computer_use_capability>',
  ].join('\n');
}

function renderImageGenerationCapabilitySystemContext(
  capability: NonNullable<OscarAnswerExecutionInput['turn']['request']['modifiers']['imageGenerationCapability']>,
): string {
  return [
    '<monarch_image_generation_capability version="1">',
    'Это доверенный снимок возможностей продукта Monarch, а не текст пользователя и не доказательство выполненного действия.',
    'В Monarch доступно создание изображений через отдельную поверхность «Изображения». Поэтому на вопрос о своих возможностях Oscar должен естественно и утвердительно сообщать, что умеет помогать создавать изображения.',
    `Основной provider — ${capability.primaryProvider.label}: независимый интерактивный сервис, которым пользователь управляет вручную.`,
    `${capability.emergencyProvider.label} доступен только как явно обозначенный аварийный сервис при недоступности основного provider.`,
    'executionAuthority=none запрещает этому конкретному answer-turn изображать клики, сетевую генерацию или готовый файл, но не отменяет реальную продуктовую возможность Monarch.',
    'Конкретный запрос на генерацию проходит отдельный typed policy-gate; его более точное состояние имеет приоритет над этим общим снимком.',
    'Не используй заготовленную рекламную фразу и не утверждай, что результат уже создан, открыт или сохранён без фактического UI/runtime receipt.',
    '</monarch_image_generation_capability>',
  ].join('\n');
}

function renderImageGenerationSystemContext(
  context: NonNullable<OscarAnswerExecutionInput['turn']['request']['modifiers']['imageGeneration']>,
): string {
  const common = [
    '<monarch_image_generation_policy>',
    'Это доверенное состояние Monarch, а не текст пользователя.',
    'Запрос действительно относится к созданию изображения через основной интерактивный Perchance.',
    'UI выполняет policy-gate, открывает независимую страницу и копирует подготовленный prompt. Пользователь сам вставляет prompt и нажимает Generate; не утверждай, что файл уже создан или сохранён.',
  ];
  if (context.disposition === 'mature-mode-disabled') {
    common.push(
      'Режим 18+ выключен. Своими естественными словами и с учётом конкретного запроса объясни, что сейчас не можешь создать такое изображение.',
      'Не используй заготовленную повторяющуюся фразу и не подсказывай скрытый путь обхода настроек.',
    );
  } else if (context.disposition === 'prohibited-content') {
    common.push('Запрос запрещён политикой защиты несовершеннолетних. Кратко и естественно откажись создавать его.');
  } else if (context.disposition === 'confirmation-required') {
    common.push('Режим 18+ активен, но UI требует отдельное разовое подтверждение именно этого запроса. Естественно сообщи, что ожидаешь решения пользователя.');
  } else if (context.disposition === 'provider-consent-required') {
    common.push('Перед первым открытием внешнего generator UI запросит согласие на независимые облачные сервисы. Кратко объясни следующий шаг, не изображая завершённую генерацию.');
  } else if (context.disposition === 'perchance-adult-attestation-required') {
    common.push('Perchance по своим Terms требует подтверждение возраста 18+. UI запросит его отдельно; не предлагай обход и не изображай завершённую генерацию.');
  } else {
    common.push('Запрос прошёл текущую политику; UI откроет Perchance и скопирует prompt. Ответь кратко и естественно, не выдавая интерактивную передачу за готовое изображение.');
  }
  common.push(`Текущая классификация: ${context.contentRating}.`, '</monarch_image_generation_policy>');
  return common.join('\n');
}

export function resolveOscarAnswerResearchPolicy(
  modifiers: OscarAnswerExecutionInput['turn']['request']['modifiers'],
): { webSearch: boolean; researchMode: 'auto' | 'off' | 'deep' } {
  const requested = modifiers.webSearch === true || modifiers.researchMode === 'deep';
  const authorized = requested && Boolean(modifiers.dataEgressConsentId);
  if (!authorized) return { webSearch: false, researchMode: 'off' };
  return {
    webSearch: true,
    researchMode: modifiers.researchMode === 'deep'
      ? 'deep'
      : modifiers.researchMode === 'off' ? 'off' : 'auto',
  };
}

export async function* mapOscarAnswerStream(
  stream: AsyncIterable<unknown>,
): AsyncIterable<OscarAnswerExecutorEvent> {
  for await (const candidate of stream) {
    const event = asRecord(candidate);
    const data = asRecord(event?.data) || {};
    const type = readString(event?.type);
    if (type === 'token') {
      const token = readTextFragment(data.token) || readTextFragment(event?.content);
      if (token) yield { type: 'token', token };
    } else if (type === 'replace') {
      const content = readAnswerText(data.content);
      if (content.trim()) yield { type: 'replace', content };
    } else if (type === 'sources') {
      yield { type: 'sources', sources: Array.isArray(data.sources) ? data.sources : [] };
    } else if (type === 'action_proposal') {
      yield { type: 'error', message: 'Answer-only runtime returned a forbidden action proposal.' };
    } else if (type === 'error') {
      yield { type: 'error', message: readString(data.message) || 'Oscar answer runtime failed.' };
    } else if (type === 'done') {
      const usage = asRecord(data.usage);
      const usageFailure = oscarUsageFailure(usage);
      const backendRejected = data.ok === false;
      yield {
        type: 'done',
        ...(usage ? { usage } : {}),
        ...(data.cancelled === true ? { cancelled: true } : {}),
        ...((backendRejected || usageFailure) ? {
          ok: false,
          failure: usageFailure || 'oscar-answer-runtime-failed',
        } : {}),
      };
      return;
    }
  }
}

export function isIncompleteOscarUsage(value: unknown): boolean {
  const usage = asRecord(value);
  if (!usage) return false;
  const stopReason = readString(usage.generation_stop_reason).toLowerCase();
  return usage.likely_truncated === true
    || usage.partial === true
    || stopReason === 'length'
    || stopReason === 'max_tokens'
    || stopReason === 'max_new_tokens';
}

export function isRejectedOscarUsage(value: unknown): boolean {
  return Boolean(oscarUsageFailure(value));
}

function oscarUsageFailure(value: unknown): string {
  const usage = asRecord(value);
  if (!usage) return '';
  const stopReason = readString(usage.generation_stop_reason).toLowerCase();
  if (usage.likely_truncated === true
    || stopReason === 'length'
    || stopReason === 'max_tokens'
    || stopReason === 'max_new_tokens') {
    return 'model-output-truncated';
  }
  if (stopReason === 'error') return 'model-generation-failed';
  if (stopReason === 'cancelled' || stopReason === 'canceled') return 'model-generation-cancelled';
  if (stopReason === 'content_filter' || stopReason === 'content-filter') return 'model-output-filtered';
  if (stopReason === 'tool_calls' || stopReason === 'tool-calls' || stopReason === 'function_call') {
    return 'model-finish-reason-unsupported';
  }
  return usage.partial === true ? 'oscar-answer-runtime-failed' : '';
}

export function isRejectedOscarRecoveryPayload(value: unknown): boolean {
  const record = asRecord(value) || {};
  const answer = readAnswerText(record.answer) || readAnswerText(record.content) || readChoiceAnswer(record);
  return record.ok === false
    || !answer
    || isRuntimeRecoveryAnswer(answer)
    || isRejectedOscarUsage(record.usage);
}

export async function persistCoordinatorMessage(
  client: OscarClient,
  message: OscarPersistedMessage,
  devSettings: MonarchOwnerDevSettingsV1 = DEFAULT_OWNER_DEV_SETTINGS,
): Promise<OscarMessagePersistenceReceipt> {
  const receipt = await client.appendConversationMessage(
    message.conversationId,
    coordinatorMessageAppendInput(message),
  );
  if (
    receipt.disposition !== 'superseded'
    && !devSettings.zeroRetentionEnabled
    && devSettings.memoryEnabled
    && message.role === 'assistant'
    && message.source === 'desktop'
    && message.privacyMode === 'persistent'
    && !message.taskId
    && (message.outcome === 'answered' || message.outcome === 'answered:source-grounded')
  ) {
    void client.indexMemoryEpisode({
      schemaVersion: 1,
      source: 'desktop',
      scope: { type: 'chat' },
      conversationId: message.conversationId,
      turnId: message.turnId,
    }).catch(() => undefined);
  }
  return { disposition: receipt.disposition };
}

export function coordinatorMessageAppendInput(
  message: OscarPersistedMessage,
): Parameters<OscarClient['appendConversationMessage']>[1] {
  const usage = message.usage || {};
  return {
    role: message.role,
    content: message.content,
    client_message_id: message.messageId,
    turn_id: message.turnId,
    ...(message.taskId ? { task_id: message.taskId } : {}),
    provenance: message.provenance as unknown as Record<string, unknown>,
    ...(message.outcome ? { outcome: message.outcome } : {}),
    ...(message.integrityWarning ? { integrity_warning: message.integrityWarning } : {}),
    ...(message.createConversationIfMissing === false ? { create_conversation_if_missing: false } : {}),
    ...(message.requiredPreviousMessageId ? { required_previous_message_id: message.requiredPreviousMessageId } : {}),
    ...(numberValue(usage.total_tokens) !== undefined ? { token_count: numberValue(usage.total_tokens)! } : {}),
    ...(numberValue(usage.elapsed_ms) !== undefined ? { elapsed_ms: numberValue(usage.elapsed_ms)! } : {}),
    ...(readString(usage.model_tier) ? { model_tier: readString(usage.model_tier) } : {}),
    ...(message.attachments?.length ? {
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        digest: attachment.digest,
        name: attachment.name,
        mime_type: attachment.mimeType,
        size_bytes: attachment.sizeBytes,
      })),
    } : {}),
    ...(message.sources?.length ? {
      sources: message.sources.filter((source) => asRecord(source)).map((source) => asRecord(source)!),
    } : {}),
  };
}

function readChoiceAnswer(record: Record<string, unknown> | null): string {
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const first = asRecord(choices[0]);
  return readAnswerText(asRecord(first?.message)?.content) || readAnswerText(first?.text);
}

function isRuntimeRecoveryAnswer(value: string): boolean {
  return /(?:локальн(?:ый|ая) runtime завершил|runtime завершил|попробуй повторить запрос|local runtime.*before.*final)/iu.test(value);
}

function isDirectRuntimeStatusQuestion(value: string): boolean {
  const text = String(value || '').trim();
  return /(?:какая|какой|какие|покажи|назови|скажи).{0,40}(?:модел|runtime|рантайм|провайдер)|(?:на|с)\s+какой\s+модел|(?:which|what|show|name|tell).{0,40}(?:model|runtime|provider)|runtime\s+status/iu.test(text);
}

async function* verifiedRuntimeStatusStream(
  status: OscarBackendStatus,
  requestText: string,
): AsyncIterable<OscarAnswerExecutorEvent> {
  yield { type: 'token', token: renderVerifiedRuntimeStatusAnswer(status, requestText) };
  yield { type: 'done' };
}

export function renderVerifiedRuntimeStatusAnswer(status: OscarBackendStatus, requestText: string): string {
  const russian = /[А-Яа-яЁё]/u.test(requestText);
  const modelStatus = asRecord(status.modelStatus);
  const activeTier = safeRuntimeLabel(modelStatus?.active_tier);
  const loaded = modelStatus?.loaded === true;
  const deviceMap = asRecord(modelStatus?.device_map);
  const deviceProbe = safeRuntimeLabel(deviceMap?.device) || safeRuntimeLabel(modelStatus?.device);
  const device = /cuda|gpu/iu.test(deviceProbe) ? 'CUDA' : /cpu/iu.test(deviceProbe) ? 'CPU' : '';
  return status.connected
    ? russian
      ? `Проверенный локальный runtime подключён. Активная модель: ${activeTier || (loaded ? 'загружена, имя не опубликовано runtime' : 'сейчас не загружена')}${device ? `; устройство: ${device}` : ''}. Я остаюсь Oscar — интерфейсом Monarch.`
      : `The verified local runtime is connected. Active model: ${activeTier || (loaded ? 'loaded; runtime did not publish its name' : 'not currently loaded')}${device ? `; device: ${device}` : ''}. I remain Oscar, Monarch's assistant interface.`
    : russian
      ? 'Проверенный локальный runtime сейчас не подключён; поэтому я не буду угадывать модель или провайдера.'
      : 'The verified local runtime is not connected, so I will not guess the active model or provider.';
}

function safeRuntimeLabel(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(text) ? text : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readTextFragment(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readAnswerText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}
