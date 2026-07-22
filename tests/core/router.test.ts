import { describe, it, expect } from 'vitest';
import { createMonarchKernel } from '../../src/bootstrap';
import { AssistantModule } from '../../src/modules/assistant';
import {
  MonarchKernel,
  classifyIntentText,
  mergeRouteCandidates,
  selectModelRouteForText,
  type MonarchExecutionRequest,
  type MonarchExecutionResult,
  type MonarchIntent,
  type MonarchModule,
  type MonarchRouteCandidate,
} from '../../src/core';

function createSmokeIntent(id: string, text: string): MonarchIntent {
  return {
    id,
    source: 'desktop',
    text,
    createdAt: new Date(0).toISOString(),
  };
}

function hasLlmRouterStage(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const llmRouter = (payload as { llmRouter?: unknown }).llmRouter;
  if (!llmRouter || typeof llmRouter !== 'object') {
    return false;
  }

  return typeof (llmRouter as { status?: unknown }).status === 'string'
    && typeof (llmRouter as { candidates?: unknown }).candidates === 'number';
}

function hasRouterAnalysis(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as {
    classification?: unknown;
    parentRouter?: unknown;
    modelRouter?: unknown;
  };
  const classification = record.classification as { kind?: unknown } | undefined;
  const parentRouter = record.parentRouter as { action?: unknown } | undefined;
  const modelRouter = record.modelRouter as { selectedRole?: unknown } | undefined;

  return typeof classification?.kind === 'string'
    && typeof parentRouter?.action === 'string'
    && typeof modelRouter?.selectedRole === 'string';
}

function createFallbackOnlyNotesModule(): MonarchModule {
  return {
    manifest: {
      id: 'smoke-notes',
      name: 'Smoke Notes',
      version: '0.1.0',
      kind: 'tooling',
      description: 'Smoke-only fallback routing module.',
      owns: ['notes'],
      permissions: ['read'],
      capabilities: [
        {
          id: 'smoke.notes.list',
          moduleId: 'smoke-notes',
          title: 'List notes',
          description: 'List smoke notes through manifest routing metadata.',
          risk: 'read',
          routing: {
            aliases: ['show notes'],
            keywords: ['notes', 'list'],
            examples: ['show notes'],
            intentKinds: ['notes.read'],
          },
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    },
    async activate(): Promise<void> {},
    async executeCapability(
      request: MonarchExecutionRequest
    ): Promise<MonarchExecutionResult> {
      if (request.capabilityId !== 'smoke.notes.list') {
        return {
          ok: false,
          summary: `Unsupported notes capability: ${request.capabilityId}`,
          error: 'unsupported-capability',
        };
      }

      return {
        ok: true,
        summary: 'Smoke notes listed.',
        output: {
          notes: [],
        },
      };
    },
  };
}

function createLowConfidenceDeviceModule(): MonarchModule {
  return {
    manifest: {
      id: 'smoke-low-confidence-device',
      name: 'Smoke Low Confidence Device',
      version: '0.1.0',
      kind: 'tooling',
      description: 'Smoke-only route threshold module.',
      owns: ['lock'],
      permissions: ['device-control'],
      capabilities: [
        {
          id: 'smoke.lock.unlock',
          moduleId: 'smoke-low-confidence-device',
          title: 'Unlock lock',
          description: 'Unlock a smoke-only lock.',
          risk: 'device-control',
          routing: {
            aliases: ['unlock lock'],
            keywords: ['unlock', 'lock'],
            examples: ['unlock lock'],
            intentKinds: ['device-control'],
          },
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    },
    async activate(): Promise<void> {},
    async handleIntent(): Promise<null> {
      return null;
    },
  };
}


describe('Router Mesh & Intent Classifier', () => {
  it('keeps complete arguments when another source repairs the same capability candidate', () => {
    const common = {
      intentId: 'intent_complete_arguments',
      targetModuleId: 'workspace',
      capabilityId: 'workspace.files.write',
      permissionMode: 'confirm' as const,
    };
    const candidates: MonarchRouteCandidate[] = [
      {
        ...common,
        confidence: 0.93,
        reason: 'Module regex selected the capability but could not resolve the path.',
        source: 'module',
        input: { path: '', content: '' },
        missingInput: ['path'],
      },
      {
        ...common,
        confidence: 0.9,
        reason: 'Structured argument builder resolved the contextual target.',
        source: 'llm',
        input: {
          path: 'newtestfolder/main.py',
          content: 'print("Hello World")',
        },
      },
    ];

    const [merged] = mergeRouteCandidates(candidates);

    expect(merged?.source).toBe('module');
    expect(merged?.input).toEqual({
      path: 'newtestfolder/main.py',
      content: 'print("Hello World")',
    });
    expect(merged?.missingInput).toBeUndefined();
  });

  it('should correctly classify intents (MARK-style)', () => {
    const fileAuthoring = classifyIntentText('создай markdown отчет в файл');
    expect(fileAuthoring.kind).toBe('file_generation');
    if (fileAuthoring.kind === 'file_generation') {
      expect(fileAuthoring.fileIntentMode).toBe('authoring');
      expect(fileAuthoring.routingPreference).toBe('model');
    }

    const fileDelete = classifyIntentText('удали файл temp.txt');
    expect(fileDelete.kind).toBe('file_operation');
    if (fileDelete.kind === 'file_operation') {
      expect(fileDelete.fileOperation).toBe('delete');
      expect(fileDelete.riskHint).toBe('delete');
      expect(fileDelete.toolRoutingAllowed).toBe(true);
    }

    const codeWork = classifyIntentText('implement router pipeline and return strict json');
    const modelRoute = selectModelRouteForText('implement router pipeline and return strict json', codeWork);
    expect(codeWork.kind).toBe('code');
    expect(modelRoute.selectedRole).toBe('gemma4-balanced');
    expect(modelRoute.fallbackRoles).not.toContain('gemma4-31b');

    const identity = classifyIntentText('Расскажи о себе');
    expect(identity.kind).toBe('assistant_identity');
    expect(identity.riskHint).toBe('none');
    expect(selectModelRouteForText('Расскажи о себе', identity).selectedRole).toBe('gemma4-fast');

    const capabilityQuestion = classifyIntentText('Ты можешь удалить logs/debug.log?');
    expect(capabilityQuestion.kind).toBe('capabilities_question');
    expect(capabilityQuestion.riskHint).toBe('none');
    expect(selectModelRouteForText('Ты можешь удалить logs/debug.log?', capabilityQuestion).selectedRole).toBe('gemma4-fast');

    const socialChat = classifyIntentText('как дела?');
    expect(socialChat.kind).toBe('chat');
    expect(selectModelRouteForText('как дела?', socialChat).selectedRole).toBe('gemma4-fast');

    const shortQuestion = classifyIntentText('Почему небо голубое?');
    expect(selectModelRouteForText('Почему небо голубое?', shortQuestion).selectedRole).toBe('gemma4-fast');

    const detailedMeta = classifyIntentText('Подробно расскажи о себе и своих возможностях');
    expect(detailedMeta.kind).toBe('assistant_identity');
    expect(selectModelRouteForText('Подробно расскажи о себе и своих возможностях', detailedMeta).selectedRole).toBe('gemma4-balanced');

    const deleteAction = classifyIntentText('Удали logs/debug.log');
    expect(deleteAction.kind).toBe('file_operation');
    expect(deleteAction.riskHint).toBe('delete');

    const explanation = classifyIntentText('Объясни как удалить файл в Node.js');
    expect(explanation.kind).toBe('explanation');
    expect(explanation.riskHint).toBe('none');

    const teamwork = classifyIntentText('Что означает командная работа?');
    expect(teamwork.kind).toBe('explanation');
    expect(teamwork.riskHint).toBe('none');

    const electricalCurrent = classifyIntentText('Объясни current в электричестве');
    expect(electricalCurrent.kind).toBe('explanation');

    const currentCode = classifyIntentText('Что сейчас происходит в моем коде?');
    expect(currentCode.kind).not.toBe('search');

    const personalSchedule = classifyIntentText('Составь расписание тренировок');
    expect(personalSchedule.kind).not.toBe('search');

    const publicSchedule = classifyIntentText('Расписание поездов Киев Львов');
    expect(publicSchedule.kind).toBe('search');

    const externalRanking = classifyIntentText('Найди и выведи топ 3 самых умных моделей LLM в диапазоне 2B');
    expect(externalRanking.kind).toBe('search');
    expect(externalRanking.searchScope).toBe('web_required');
    expect(externalRanking.signals).toContain('external comparative research');

    const localTopList = classifyIntentText('Назови топ 3 причины регулярно делать перерывы');
    expect(localTopList.kind).not.toBe('search');

    const directExternalLookup = classifyIntentText('Найди официальную документацию Pydantic');
    expect(directExternalLookup.kind).toBe('search');
    expect(directExternalLookup.searchScope).toBe('web_required');

    const directLocalLookup = classifyIntentText('Найди файл package.json');
    expect(directLocalLookup.kind).toBe('file_operation');

    const telegramPost = classifyIntentText('Напиши пост для Telegram');
    expect(telegramPost.kind).toBe('text_generation');
    expect(telegramPost.riskHint).toBe('none');

    const routerArchitecture = classifyIntentText('Спроектируй архитектуру роутера и проверь риски');
    expect(selectModelRouteForText('Спроектируй архитектуру роутера и проверь риски', routerArchitecture).selectedRole).toBe('gemma4-deepthinking');
  });

  it('should route to fallback candidate', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(createFallbackOnlyNotesModule());

    await kernel.start();
    const result = await kernel.submitIntent('show notes', 'smoke');
    await kernel.stop();

    expect(result.route?.targetModuleId).toBe('smoke-notes');
    expect(result.route?.capabilityId).toBe('smoke.notes.list');
    expect(result.execution?.ok).toBe(true);
  });

  it('should prefer a strong module route over a nearby fallback candidate', async () => {
    const kernel = createMonarchKernel({
      enabledModules: ['diagnostics', 'astra'],
      enableLocalSystemRouter: false,
    });

    await kernel.start();
    const result = await kernel.submitIntent('покажи возможности', 'smoke');
    await kernel.stop();

    expect(result.route?.targetModuleId).toBe('diagnostics');
    expect(result.route?.capabilityId).toBe('diagnostics.capabilities.list');
    expect(result.execution?.ok).toBe(true);
  });

  it('should route Russian system status to diagnostics', async () => {
    const kernel = createMonarchKernel({
      enabledModules: ['diagnostics'],
      enableLocalSystemRouter: false,
    });

    await kernel.start();
    const result = await kernel.submitIntent('покажи статус системы', 'smoke');
    await kernel.stop();

    expect(result.route?.targetModuleId).toBe('diagnostics');
    expect(result.route?.capabilityId).toBe('diagnostics.modules.list');
    expect(result.execution?.ok).toBe(true);
  });

  it('should route meta questions through the model assistant and keep explicit diagnostics available', async () => {
    const assistant = new AssistantModule();
    const ability = await assistant.handleIntent(createSmokeIntent('ability', 'что ты умеешь'));
    const tools = await assistant.handleIntent(createSmokeIntent('tools', 'какими инструментами ты можешь пользоваться'));
    const kernel = createMonarchKernel({
      enabledModules: ['diagnostics'],
      enableLocalSystemRouter: false,
    });

    await kernel.start();
    const diagnostics = await kernel.submitIntent('покажи возможности', 'smoke');
    await kernel.stop();

    expect(ability?.targetModuleId).toBe('assistant');
    expect(ability?.capabilityId).toBe('assistant.reply');
    expect((ability?.input as any)?.route?.modelTier).toBe('weak');
    expect(tools?.targetModuleId).toBe('assistant');
    expect(tools?.capabilityId).toBe('assistant.reply');
    expect((tools?.input as any)?.route?.modelTier).toBe('weak');
    expect(diagnostics.route?.targetModuleId).toBe('diagnostics');
    expect(diagnostics.route?.capabilityId).toBe('diagnostics.capabilities.list');
    expect(diagnostics.execution?.ok).toBe(true);
  });

  it.each([
    'Что такое память человека?',
    'Как работает интернет?',
    'Что означает статус-кво?',
    'Объясни модель поведения человека',
  ])('keeps semantic subsystem vocabulary in ordinary assistant chat: %s', async (text) => {
    const assistant = new AssistantModule();

    const route = await assistant.handleIntent(createSmokeIntent('semantic-chat', text));

    expect(route?.targetModuleId).toBe('assistant');
    expect(route?.capabilityId).toBe('assistant.reply');
  });

  it.each([
    'Расскажи про новую систему образования',
    'Что означает статус системы кровообращения?',
    'Объясни модель поведения человека',
    'Что такое математическая модель?',
  ])('does not let Diagnostics or Models steal semantic chat: %s', async (text) => {
    const kernel = createMonarchKernel({
      enabledModules: ['assistant', 'diagnostics', 'models'],
      enableLocalSystemRouter: false,
    });

    await kernel.start();
    const route = await kernel.routeIntent(createSmokeIntent('semantic-module-competition', text));
    await kernel.stop();

    expect(route?.targetModuleId).toBe('assistant');
    expect(route?.capabilityId).toBe('assistant.reply');
  });

  it('does not mistake independence questions for Astra bridge requests', async () => {
    const kernel = createMonarchKernel({
      enabledModules: ['assistant', 'astra', 'oscar'],
      enableLocalSystemRouter: false,
    });

    await kernel.start();
    const route = await kernel.routeIntent(createSmokeIntent(
      'intent_independence_followup',
      'А как ты думаешь твой создатель мог создать тебя ради этого,что бы он имел цифровую независимость?'
    ));
    await kernel.stop();

    expect(route?.targetModuleId).toBe('assistant');
    expect(route?.capabilityId).toBe('assistant.reply');
  });

  it('still routes explicit Astra Oscar bridge questions to Astra', async () => {
    const kernel = createMonarchKernel({
      enabledModules: ['assistant', 'astra', 'oscar'],
      enableLocalSystemRouter: false,
    });

    await kernel.start();
    const route = await kernel.routeIntent(createSmokeIntent(
      'intent_explicit_astra_bridge',
      'Покажи мост Oscar с Astra'
    ));
    await kernel.stop();

    expect(route?.targetModuleId).toBe('astra');
    expect(route?.capabilityId).toBe('astra.oscar.bridge.describe');
  });

  it('should prefer workspace file reads over direct assistant chat', async () => {
    const kernel = createMonarchKernel({
      enabledModules: ['workspace', 'assistant'],
      enableLocalSystemRouter: false,
    });

    await kernel.start();
    const result = await kernel.submitIntent('можешь прочитать package.json', 'smoke');
    await kernel.stop();

    expect(result.route?.targetModuleId).toBe('workspace');
    expect(result.route?.capabilityId).toBe('workspace.files.read');
    expect((result.route?.input as any)?.path).toBe('package.json');
    expect(result.execution?.ok).toBe(true);
  });

  it('should not route ambiguous status-like request', async () => {
    const kernel = createMonarchKernel({ packages: [], enableLocalSystemRouter: false });

    await kernel.start();
    const result = await kernel.submitIntent('make a sandwich', 'smoke');
    const snapshot = kernel.getSnapshot();
    await kernel.stop();

    expect(result.route).toBeNull();
    expect(snapshot.events.some((event) => event.type === 'router.route_trace')).toBe(true);
  });

  it('routes a direct Russian Security status request without asking for clarification', async () => {
    const kernel = createMonarchKernel({ enableLocalSystemRouter: false });

    await kernel.start();
    const route = await kernel.routeIntent(createSmokeIntent(
      'intent_security_status_ru',
      'Покажи текущий статус Security',
    ));
    await kernel.stop();

    expect(route?.targetModuleId).toBe('security');
    expect(route?.capabilityId).toBe('security.status');
  });

  it('should block low-confidence actions via risk threshold', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(createLowConfidenceDeviceModule());

    await kernel.start();
    const route = await kernel.routeIntent(createSmokeIntent('intent_smoke_low_confidence_device', 'unlock lock'));
    await kernel.stop();

    expect(route).toBeNull();
  });

  it('should generate complete route trace', async () => {
    const kernel = createMonarchKernel({
      enabledModules: ['memory'],
    });

    await kernel.start();
    await kernel.submitIntent('list memory', 'smoke');
    const snapshot = kernel.getSnapshot();
    await kernel.stop();

    const routeTrace = snapshot.events.find((event) => event.type === 'router.route_trace');
    expect(routeTrace).toBeDefined();
    
    if (routeTrace) {
      expect(hasLlmRouterStage(routeTrace.payload)).toBe(true);
      expect(hasRouterAnalysis(routeTrace.payload)).toBe(true);
    }

    expect(snapshot.audit.some((entry) => entry.category === 'routing' && entry.message === 'Router v0.3 route trace.')).toBe(true);
  });
});
