import { describe, expect, it, vi } from 'vitest';
import {
  buildOscarTurnAnswerRequest,
  coordinatorMessageAppendInput,
  isIncompleteOscarUsage,
  isRejectedOscarRecoveryPayload,
  isRejectedOscarUsage,
  mapOscarAnswerStream,
  persistCoordinatorMessage,
  renderVerifiedRuntimeStatusAnswer,
  resolveOscarTurnSkillContexts,
  resolveOscarAnswerContextProfile,
  resolveOscarAnswerResearchPolicy,
} from '../../src/app/oscar-turn-runtime';
import type { OscarClient } from '../../src/modules/oscar/client';
import { MESSAGE_PROVENANCE_SCHEMA_VERSION } from '../../src/oscar-turn';

describe('Oscar Turn answer stream adapter', () => {
  it.each([
    [{}, { webSearch: false, researchMode: 'off' }],
    [{ webSearch: false, researchMode: 'auto' }, { webSearch: false, researchMode: 'off' }],
    [{ researchMode: 'auto' }, { webSearch: false, researchMode: 'off' }],
    [{ dataEgressConsentId: 'orphan-consent' }, { webSearch: false, researchMode: 'off' }],
    [{ webSearch: true, researchMode: 'auto' }, { webSearch: false, researchMode: 'off' }],
    [
      { webSearch: true, researchMode: 'auto', dataEgressConsentId: 'egress-auto' },
      { webSearch: true, researchMode: 'auto' },
    ],
    [
      { webSearch: true, researchMode: 'off', dataEgressConsentId: 'egress-standard' },
      { webSearch: true, researchMode: 'off' },
    ],
    [
      { webSearch: false, researchMode: 'deep', dataEgressConsentId: 'egress-deep' },
      { webSearch: true, researchMode: 'deep' },
    ],
  ])('fails closed research policy for modifiers %j', (modifiers, expected) => {
    expect(resolveOscarAnswerResearchPolicy(modifiers as any)).toEqual(expected);
  });

  it('serializes omitted API research modifiers as explicit backend opt-out', () => {
    const request = buildOscarTurnAnswerRequest(answerExecution({}));
    expect(request).toMatchObject({
      web_search: false,
      research_mode: 'off',
      execution_authority: 'none',
      persistence_owner: 'coordinator',
    });
  });

  it('passes a selected skill into answer-only model context without granting execution authority', async () => {
    const activateForPrompt = vi.fn(async () => [{
      name: 'playwright',
      description: 'Browser automation workflow.',
      instructions: 'Explain the real Playwright workflow and its bounded tools.',
      location: 'C:/skills/playwright/SKILL.md',
      explicit: true,
    }] as any);
    const skills = await resolveOscarTurnSkillContexts(
      '$playwright что может этот skill?',
      { activateForPrompt },
      true,
    );
    const request = buildOscarTurnAnswerRequest(
      answerExecution({}, '$playwright что может этот skill?'),
      'auto',
      undefined,
      skills,
    );

    expect(activateForPrompt).toHaveBeenCalledWith(
      '$playwright что может этот skill?',
      { limit: 2, minimumScore: 0.55 },
    );
    expect(request.skills).toEqual([expect.objectContaining({
      name: 'playwright',
      explicit: true,
      instructions: expect.stringContaining('real Playwright workflow'),
    })]);
    expect(request.execution_authority).toBe('none');
    expect(request.messages[0]?.content).toContain('monarch_answer_only_authority');
  });

  it('honors the Owner DEV skills switch for explicit invocations', async () => {
    const activateForPrompt = vi.fn();
    await expect(resolveOscarTurnSkillContexts(
      '$playwright покажи пример',
      { activateForPrompt },
      false,
    )).resolves.toEqual([]);
    expect(activateForPrompt).not.toHaveBeenCalled();
  });

  it('uses a compact memory-free context for a short standalone social question', () => {
    const execution = answerExecution({}, 'Как настроение?');
    const request = buildOscarTurnAnswerRequest(execution);

    expect(resolveOscarAnswerContextProfile(execution)).toBe('compact-social');
    expect(request).toMatchObject({
      context_profile: 'compact-social',
      use_memory: false,
      max_new_tokens: 256,
    });
  });

  it('keeps full context when a short question depends on prior conversation', () => {
    const execution = answerExecution({}, 'Как тебе это?');
    const request = buildOscarTurnAnswerRequest(execution);

    expect(resolveOscarAnswerContextProfile(execution)).toBe('full');
    expect(request).toMatchObject({ context_profile: 'full', use_memory: true });
    expect(request.max_new_tokens).toBeGreaterThan(256);
  });

  it('serializes an exact consent-bound deep request as explicit backend opt-in', () => {
    const request = buildOscarTurnAnswerRequest(answerExecution({
      webSearch: false,
      researchMode: 'deep',
      dataEgressConsentId: 'egress-deep',
    }));
    expect(request).toMatchObject({ web_search: true, research_mode: 'deep' });
  });

  it('applies Owner DEV privacy and context switches to the backend request', () => {
    const execution = answerExecution({
      webSearch: true,
      researchMode: 'deep',
      dataEgressConsentId: 'egress-deep',
    });
    execution.turn.request.history = [{ role: 'assistant', content: 'stored history text' }];
    execution.turn.request.personality = {
      schemaVersion: 2,
      profileId: 'profile-owner-dev',
      profileRevision: 1,
      profileHash: 'a'.repeat(64),
      variant: 'direct',
      name: 'Direct',
      dimensions: {
        brevity: 50, warmth: 50, directness: 50, initiative: 50,
        humor: 50, skepticism: 50, technicalDepth: 50, structure: 50,
      },
      addressForm: 'ты',
      language: 'ru',
      customRules: [],
    };
    const request = buildOscarTurnAnswerRequest(execution, 'auto', {
      schemaVersion: 1,
      zeroRetentionEnabled: true,
      internetEnabled: false,
      memoryEnabled: false,
      historyContextEnabled: false,
      personalityEnabled: false,
      skillsEnabled: false,
      runtimeContextEnabled: false,
      qualityRegenerationEnabled: false,
      updatedAt: '',
    });

    expect(request).toMatchObject({
      incognito: true,
      use_memory: false,
      web_search: false,
      research_mode: 'off',
      dev_mode: {
        zero_retention: true,
        internet_enabled: false,
        history_context_enabled: false,
        runtime_context_enabled: false,
      },
    });
    expect(request.messages.some((message) => message.content.includes('stored history text'))).toBe(false);
    expect(request.messages.some((message) => message.content.includes('monarch_personality_context'))).toBe(false);
  });

  it('grounds natural Oscar image replies in trusted mature policy state', () => {
    const request = buildOscarTurnAnswerRequest(answerExecution({
      imageGeneration: {
        schemaVersion: 1,
        contentRating: 'nsfw',
        disposition: 'mature-mode-disabled',
        providerId: 'perchance-interactive',
      },
    }));
    const policy = request.messages.find((message) => message.role === 'system'
      && message.content.includes('<monarch_image_generation_policy>'));
    expect(policy?.content).toContain('Режим 18+ выключен');
    expect(policy?.content).toContain('Своими естественными словами');
    expect(policy?.content).toContain('Не используй заготовленную повторяющуюся фразу');
    expect(policy?.content).not.toContain('prompt уже отправлен');
  });

  it('grounds image capability questions without granting answer-turn execution authority', () => {
    const request = buildOscarTurnAnswerRequest(answerExecution({
      imageGenerationCapability: {
        schemaVersion: 1,
        available: true,
        surface: 'images',
        primaryProvider: {
          id: 'perchance-interactive',
          label: 'Perchance',
          mode: 'interactive',
          url: 'https://perchance.org/ai-text-to-image-generator',
        },
        emergencyProvider: {
          id: 'aihorde-anonymous',
          label: 'AI Horde',
          mode: 'emergency',
          activation: 'provider-error-or-explicit-user-action',
        },
      },
    }, 'Ты умеешь создавать изображения?'));
    const capability = request.messages.find((message) => message.role === 'system'
      && message.content.includes('<monarch_image_generation_capability'));
    expect(capability?.content).toContain('должен естественно и утвердительно сообщать');
    expect(capability?.content).toContain('executionAuthority=none');
    expect(capability?.content).toContain('не отменяет реальную продуктовую возможность Monarch');
    expect(capability?.content).toContain('не утверждай, что результат уже создан');
  });

  it('grounds Computer Use questions in trusted live capability state', () => {
    const request = buildOscarTurnAnswerRequest(answerExecution({
      computerUseCapability: {
        schemaVersion: 1,
        available: true,
        enabled: false,
        surface: 'computer-use',
        invocation: '@Computer Use',
        ownCursor: true,
        observeAnalyzeAct: true,
        emergencyShortcut: 'Ctrl+Alt+Escape',
      },
    }, 'Как тебе новый Computer Use?'));
    const capability = request.messages.find((message) => message.role === 'system'
      && message.content.includes('<monarch_computer_use_capability'));

    expect(resolveOscarAnswerContextProfile(answerExecution({
      computerUseCapability: {
        schemaVersion: 1,
        available: true,
        enabled: false,
        surface: 'computer-use',
        invocation: '@Computer Use',
        ownCursor: true,
        observeAnalyzeAct: true,
        emergencyShortcut: 'Ctrl+Alt+Escape',
      },
    }, 'Как тебе новый Computer Use?'))).toBe('compact-social');
    expect(request).toMatchObject({
      context_profile: 'compact-social',
      use_memory: false,
      max_new_tokens: 256,
    });
    expect(capability?.content).toContain('Нативный Computer Use доступен');
    expect(capability?.content).toContain('Сейчас Computer Use остановлен');
    expect(capability?.content).toContain('@Computer Use');
    expect(capability?.content).toContain('минимум два конкретных свойства');
    expect(capability?.content).toContain('Ctrl+Alt+Escape');
    expect(capability?.content).toContain('executionAuthority=none');
  });

  it('does not inject unrelated product capability blocks into an ordinary greeting', () => {
    const request = buildOscarTurnAnswerRequest(answerExecution({
      imageGenerationCapability: {
        schemaVersion: 1,
        available: true,
        surface: 'images',
        primaryProvider: {
          id: 'perchance-interactive', label: 'Perchance', mode: 'interactive',
          url: 'https://perchance.org/ai-text-to-image-generator',
        },
        emergencyProvider: {
          id: 'aihorde-anonymous', label: 'AI Horde', mode: 'emergency',
          activation: 'provider-error-or-explicit-user-action',
        },
      },
      computerUseCapability: {
        schemaVersion: 1,
        available: true,
        enabled: false,
        surface: 'computer-use',
        invocation: '@Computer Use',
        ownCursor: true,
        observeAnalyzeAct: true,
        emergencyShortcut: 'Ctrl+Alt+Escape',
      },
    }, 'Привет!'));

    expect(request.context_profile).toBe('compact-social');
    expect(request.messages.some((message) => message.content.includes('monarch_computer_use_capability'))).toBe(false);
    expect(request.messages.some((message) => message.content.includes('monarch_image_generation_capability'))).toBe(false);
  });

  it('preserves leading and whitespace-only model fragments exactly', async () => {
    const events = [];

    for await (const event of mapOscarAnswerStream(backendStream())) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'token', token: 'Моя' },
      { type: 'token', token: ' безопасность' },
      { type: 'token', token: ' ' },
      { type: 'token', token: 'основана' },
      { type: 'done' },
    ]);
    expect(events
      .filter((event): event is Extract<typeof event, { type: 'token' }> => event.type === 'token')
      .map((event) => event.token)
      .join(''))
      .toBe('Моя безопасность основана');
  });

  it('maps the first backend rejection exactly and ignores all events after it', async () => {
    const events = [];
    for await (const event of mapOscarAnswerStream((async function* () {
      yield { type: 'token', data: { token: 'partial' } };
      yield { type: 'done', data: { ok: false, usage: { generation_stop_reason: 'error', partial: true } } };
      yield { type: 'token', data: { token: 'poisoned-late-token' } };
      yield {
        type: 'done',
        data: {
          ok: true,
          usage: { generation_stop_reason: 'length', likely_truncated: true },
        },
      };
    })())) events.push(event);

    expect(events).toEqual([
      { type: 'token', token: 'partial' },
      {
        type: 'done',
        usage: { generation_stop_reason: 'error', partial: true },
        ok: false,
        failure: 'model-generation-failed',
      },
    ]);
  });

  it('maps explicit token-limit telemetry to a truncation failure', async () => {
    const events = [];
    for await (const event of mapOscarAnswerStream((async function* () {
      yield {
        type: 'done',
        data: {
          ok: true,
          usage: { generation_stop_reason: 'length', likely_truncated: true },
        },
      };
    })())) events.push(event);

    expect(events).toEqual([{
      type: 'done',
      usage: { generation_stop_reason: 'length', likely_truncated: true },
      ok: false,
      failure: 'model-output-truncated',
    }]);
  });

  it.each([
    [{ likely_truncated: true }, true],
    [{ partial: true }, true],
    [{ generation_stop_reason: 'length' }, true],
    [{ generation_stop_reason: 'max_tokens' }, true],
    [{ generation_stop_reason: 'error' }, false],
    [{ generation_stop_reason: 'cancelled' }, false],
    [{ generation_stop_reason: 'content_filter' }, false],
    [{ generation_stop_reason: 'tool_calls' }, false],
    [{ generation_stop_reason: 'stop', likely_truncated: false }, false],
    [{ generation_stop_reason: 'unknown' }, false],
    [null, false],
  ])('classifies incomplete Oscar usage %j as %s', (usage, expected) => {
    expect(isIncompleteOscarUsage(usage)).toBe(expected);
  });

  it.each([
    [{ likely_truncated: true }, true],
    [{ generation_stop_reason: 'error' }, true],
    [{ generation_stop_reason: 'cancelled' }, true],
    [{ generation_stop_reason: 'content_filter' }, true],
    [{ generation_stop_reason: 'tool_calls' }, true],
    [{ generation_stop_reason: 'stop' }, false],
    [{ generation_stop_reason: 'unknown' }, false],
  ])('classifies rejected Oscar usage %j as %s', (usage, expected) => {
    expect(isRejectedOscarUsage(usage)).toBe(expected);
  });

  it.each([
    [{ ok: false, answer: 'Выглядит завершённым', usage: { generation_stop_reason: 'stop' } }, true],
    [{ ok: true, answer: 'Выглядит завершённым', usage: { generation_stop_reason: 'error' } }, true],
    [{ ok: true, answer: 'Локальный runtime завершил ответ до финала.', usage: {} }, true],
    [{ ok: true, answer: '', usage: { generation_stop_reason: 'stop' } }, true],
    [{ ok: true, answer: 'Полный восстановленный ответ.', usage: { generation_stop_reason: 'stop' } }, false],
  ])('classifies recovery payload %j as rejected=%s', (payload, expected) => {
    expect(isRejectedOscarRecoveryPayload(payload)).toBe(expected);
  });

  it('preserves exact replacement bytes and renders runtime identity only from verified status', async () => {
    const events = [];
    for await (const event of mapOscarAnswerStream((async function* () {
      yield { type: 'replace', data: { content: '  Проверенный ответ.\n' } };
      yield { type: 'done', data: {} };
    })())) events.push(event);
    expect(events[0]).toEqual({ type: 'replace', content: '  Проверенный ответ.\n' });

    const answer = renderVerifiedRuntimeStatusAnswer({
      connected: true,
      apiBase: 'http://127.0.0.1:7861',
      projectRoot: 'E:\\Monarch\\oscar',
      autoStart: true,
      startupAttempted: true,
      timeoutMs: 1,
      chatTimeoutMs: 1,
      deepResearchTimeoutMs: 1,
      modelStatus: { loaded: true, active_tier: 'gemma4-fast', device_map: { device: 'cuda' } },
    }, 'Какая модель сейчас активна?');
    expect(answer).toContain('Активная модель: gemma4-fast; устройство: CUDA');
    expect(answer).toContain('Я остаюсь Oscar');
    expect(answer).not.toContain('языковая модель Google');
  });

  it('preserves terminal recovery preconditions through the TypeScript-to-Python request adapter', () => {
    const request = coordinatorMessageAppendInput({
      conversationId: 'conversation-existing',
      messageId: 'message-terminal',
      role: 'assistant',
      content: 'Turn отменён пользователем.',
      turnId: 'turn-terminal',
      provenance: {
        schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
        origin: 'system',
        verification: 'system-state',
        turnId: 'turn-terminal',
      },
      outcome: 'cancelled',
      createConversationIfMissing: false,
      requiredPreviousMessageId: 'message-user',
    });

    expect(request).toMatchObject({
      client_message_id: 'message-terminal',
      turn_id: 'turn-terminal',
      create_conversation_if_missing: false,
      required_previous_message_id: 'message-user',
    });
  });

  it('retires a superseded history append without indexing an answer that was never inserted', async () => {
    const appendConversationMessage = vi.fn(async () => ({
      ok: true as const,
      disposition: 'superseded' as const,
      message: null,
      duplicate: false,
    }));
    const indexMemoryEpisode = vi.fn(async () => ({ ok: true }));
    const client = { appendConversationMessage, indexMemoryEpisode } as unknown as OscarClient;

    await expect(persistCoordinatorMessage(client, {
      conversationId: 'conversation-stale',
      messageId: 'message-stale-answer',
      role: 'assistant',
      content: 'Устаревший ответ.',
      turnId: 'turn-stale',
      provenance: {
        schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
        origin: 'model',
        verification: 'unverified-model',
        turnId: 'turn-stale',
      },
      outcome: 'answered',
      source: 'desktop',
      privacyMode: 'persistent',
      createConversationIfMissing: false,
      requiredPreviousMessageId: 'message-user-stale',
    })).resolves.toEqual({ disposition: 'superseded' });

    expect(appendConversationMessage).toHaveBeenCalledTimes(1);
    expect(indexMemoryEpisode).not.toHaveBeenCalled();
  });
});

async function* backendStream(): AsyncIterable<unknown> {
  yield { type: 'token', data: { token: 'Моя' } };
  yield { type: 'token', data: { token: ' безопасность' } };
  yield { type: 'token', data: { token: ' ' } };
  yield { type: 'token', data: { token: 'основана' } };
  yield { type: 'done', data: {} };
}

function answerExecution(modifiers: Record<string, unknown>, text = 'Разбери локально переданный материал.') {
  return {
    turn: {
      id: 'turn-research-policy',
      conversationId: 'conversation-research-policy',
      inputMessageId: 'message-research-policy',
      privacyMode: 'persistent',
      request: {
        text,
        history: [],
        modifiers,
        attachmentIds: [],
      },
    },
    attachments: [],
    signal: new AbortController().signal,
  } as any;
}
