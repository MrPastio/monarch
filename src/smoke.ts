import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createMonarchHttpServer, MonarchApplication } from './app';
import { createMonarchKernel, createMonarchRuntime } from './bootstrap';
import {
  MonarchKernel,
  MonarchModuleLoader,
  classifyIntentText,
  normalizeModelOutput,
  selectModelRouteForText,
  type MonarchExecutionRequest,
  type MonarchExecutionResult,
  type MonarchIntent,
  type MonarchModule,
  type MonarchModulePackage,
  type MonarchRouteDecision,
} from './core';
import { MemoryModule } from './modules/memory';
import { OscarClient } from './modules/oscar/client';


async function main(): Promise<void> {
  const previousMemoryPath = process.env.MONARCH_MEMORY_STORE_PATH;
  const previousSmokeTest = process.env.MONARCH_SMOKE_TEST;
  const smokeMemoryPath = path.join(
    process.cwd(),
    'runtime',
    `smoke-default-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );

  process.env.MONARCH_MEMORY_STORE_PATH = smokeMemoryPath;
  process.env.MONARCH_SMOKE_TEST = '1';
  try {
    await runSmokeSuite();
  } finally {
    if (previousMemoryPath === undefined) {
      delete process.env.MONARCH_MEMORY_STORE_PATH;
    } else {
      process.env.MONARCH_MEMORY_STORE_PATH = previousMemoryPath;
    }
    if (previousSmokeTest === undefined) {
      delete process.env.MONARCH_SMOKE_TEST;
    } else {
      process.env.MONARCH_SMOKE_TEST = previousSmokeTest;
    }
    await rm(smokeMemoryPath, { force: true });
  }
}

async function runSmokeSuite(): Promise<void> {
  assertDisabledPackageIsSkipped();
  assertIncompatiblePackageFails();
  assertLegacyFactoryStillLoads();
  assertCustomPackageCatalogLoads();
  assertManifestPermissionValidation();
  await assertBootstrapCanSelectModules();
  await assertDependencyLifecycleOrder();
  assertMarkStyleIntentClassifier();
  await assertKnowledgePolicyRoutesFreshness();
  assertModelOutputNormalizer();
  await assertModelsCompletionUsesOpenAiCompatibleEndpoint();
  await assertFallbackCandidateRouting();
  await assertAssistantPlainChatRoutes();
  await assertAmbiguousStatusLikeRequestDoesNotRoute();
  await assertRiskThresholdBlocksLowConfidenceAction();
  await assertRouteTraceIsGenerated();
  await assertVoiceBridgeModuleStatusAndMissingCommand();
  await assertPluginRegistryModuleRoutes();
  await assertAstraSkillLayerRoutes();
  await assertOscarPortRoutes();
  await assertOscarClientTimeoutMessageIsReadable();
  await assertSecurityModuleRoutes();
  await assertHttpMutationApiRequiresSessionToken();
  await assertApplicationLayerAssemblesProgram();
  await assertUnifiedMemoryBridgeFlow();
  await assertStreamCompletionAndCancellationFlow();
  await assertClarificationRequiredFlow();

  const kernel = createMonarchKernel();
  kernel.registerModule(createThrowingRouterModule());
  kernel.registerModule(createThrowingExecutionModule());
  await kernel.start();


  const diagnosticsModules = await kernel.submitIntent('Покажи модули ядра');
  const diagnosticsCapabilities = await kernel.execute({
    id: 'exec_smoke_diagnostics_capabilities',
    intentId: 'intent_smoke_diagnostics_capabilities',
    moduleId: 'diagnostics',
    capabilityId: 'diagnostics.capabilities.list',
    input: {},
    createdAt: new Date(0).toISOString(),
    requestedBy: 'smoke',
  });
  const thrownExecution = await kernel.execute({
    id: 'exec_smoke_throw',
    intentId: 'intent_smoke_throw',
    moduleId: 'smoke-throwing-executor',
    capabilityId: 'smoke.throw',
    input: {},
    createdAt: new Date(0).toISOString(),
    requestedBy: 'smoke',
  });

  if (!diagnosticsModules.execution?.ok) {
    throw new Error(`Diagnostics module list smoke failed: ${diagnosticsModules.summary}`);
  }

  if (!diagnosticsCapabilities.ok) {
    throw new Error(`Diagnostics capabilities smoke failed: ${diagnosticsCapabilities.summary}`);
  }

  if (thrownExecution.error !== 'capability-execution-failed') {
    throw new Error(`Execution failure isolation smoke failed: ${thrownExecution.summary}`);
  }

  const health = await kernel.checkHealth();
  if (!health.ok) {
    throw new Error('Health smoke failed: expected all modules healthy.');
  }

  const snapshot = kernel.getSnapshot();
  if (snapshot.audit.length === 0 || snapshot.events.length === 0) {
    throw new Error('Observability smoke failed: expected audit and event history.');
  }

  if (!snapshot.events.some((event) => event.type === 'module.route_failed')) {
    throw new Error('Router isolation smoke failed: expected failed route event.');
  }

  if (!snapshot.audit.some((entry) => entry.category === 'routing')) {
    throw new Error('Router audit smoke failed: expected routing audit entry.');
  }

  await kernel.stop();
}

void main();

function assertDisabledPackageIsSkipped(): void {
  const kernel = new MonarchKernel();
  const loader = new MonarchModuleLoader();
  loader.registerPackage({
    id: 'smoke-disabled-package',
    version: '0.1.0',
    enabled: false,
    factory: () => {
      throw new Error('Disabled module package factory should not run.');
    },
  });

  const modules = loader.loadInto(kernel);
  const record = loader.getLoadRecords()[0];

  if (modules.length !== 0 || record?.status !== 'skipped') {
    throw new Error('Module loader smoke failed: disabled package should be skipped.');
  }
}

function assertIncompatiblePackageFails(): void {
  const kernel = new MonarchKernel();
  const loader = new MonarchModuleLoader();
  loader.registerPackage({
    id: 'smoke-incompatible-package',
    version: '0.1.0',
    core: {
      minVersion: '99.0.0',
    },
    factory: createThrowingRouterModule,
  });

  let failed = false;
  try {
    loader.loadInto(kernel);
  } catch {
    failed = true;
  }

  const record = loader.getLoadRecords()[0];
  if (!failed || record?.status !== 'failed') {
    throw new Error('Module loader smoke failed: incompatible package should fail.');
  }
}

function assertLegacyFactoryStillLoads(): void {
  const kernel = new MonarchKernel();
  const loader = new MonarchModuleLoader();
  loader.registerFactory(createThrowingRouterModule);

  const modules = loader.loadInto(kernel);
  const record = loader.getLoadRecords()[0];

  if (
    modules[0]?.manifest.id !== 'smoke-throwing-router'
    || record?.status !== 'loaded'
    || record.moduleId !== 'smoke-throwing-router'
  ) {
    throw new Error('Module loader smoke failed: legacy factory should still load.');
  }
}

function assertCustomPackageCatalogLoads(): void {
  const runtime = createMonarchRuntime({
    packages: [
      createSmokePackage('smoke-catalog-module'),
    ],
  });

  if (
    runtime.modules[0]?.manifest.id !== 'smoke-catalog-module'
    || runtime.packages[0]?.id !== 'smoke-catalog-module'
    || runtime.loadRecords[0]?.status !== 'loaded'
  ) {
    throw new Error('Bootstrap smoke failed: custom package catalog should load.');
  }
}

function assertManifestPermissionValidation(): void {
  const kernel = new MonarchKernel();
  let failed = false;

  try {
    kernel.registerModule({
      manifest: {
        id: 'smoke-invalid-permissions',
        name: 'Smoke Invalid Permissions',
        version: '0.1.0',
        kind: 'system',
        description: 'Smoke-only invalid manifest.',
        owns: ['invalid manifest'],
        permissions: [],
        capabilities: [
          {
            id: 'smoke-invalid.write',
            moduleId: 'smoke-invalid-permissions',
            title: 'Invalid write',
            risk: 'write',
          },
        ],
      },
      async activate(): Promise<void> {},
    });
  } catch {
    failed = true;
  }

  if (!failed) {
    throw new Error('Manifest validation smoke failed: capability risk must be declared in permissions.');
  }
}

async function assertBootstrapCanSelectModules(): Promise<void> {
  const memoryOnlyRuntime = createMonarchRuntime({
    enabledModules: ['memory'],
  });
  const moduleIds = memoryOnlyRuntime.modules.map((module) => module.manifest.id);
  const diagnosticsRecord = memoryOnlyRuntime.loadRecords.find((record) => record.packageId === 'diagnostics');

  if (moduleIds.join(',') !== 'memory' || diagnosticsRecord?.status !== 'skipped') {
    throw new Error('Bootstrap selection smoke failed: enabledModules should load only memory.');
  }

  await memoryOnlyRuntime.kernel.start();
  const diagnosticsResult = await memoryOnlyRuntime.kernel.submitIntent('Покажи модули ядра');
  await memoryOnlyRuntime.kernel.stop();

  if (diagnosticsResult.route) {
    throw new Error('Bootstrap selection smoke failed: disabled diagnostics should not route intents.');
  }
}

async function assertDependencyLifecycleOrder(): Promise<void> {
  const events: string[] = [];
  const kernel = new MonarchKernel();
  kernel.registerModule(createLifecycleOrderModule('feature-module', ['base-module'], events));
  kernel.registerModule(createLifecycleOrderModule('base-module', [], events));

  await kernel.start();
  await kernel.stop();

  const expected = [
    'start:base-module',
    'start:feature-module',
    'stop:feature-module',
    'stop:base-module',
  ].join(',');

  if (events.join(',') !== expected) {
    throw new Error(`Dependency lifecycle smoke failed: ${events.join(',')}`);
  }
}

function assertMarkStyleIntentClassifier(): void {
  const fileAuthoring = classifyIntentText('создай markdown отчет в файл');
  if (
    fileAuthoring.kind !== 'file_generation'
    || fileAuthoring.fileIntentMode !== 'authoring'
    || fileAuthoring.routingPreference !== 'model'
  ) {
    throw new Error(`Router v0.3 classifier smoke failed for file authoring: ${fileAuthoring.kind}.`);
  }

  const fileDelete = classifyIntentText('удали файл temp.txt');
  if (
    fileDelete.kind !== 'file_operation'
    || fileDelete.fileOperation !== 'delete'
    || fileDelete.riskHint !== 'delete'
    || !fileDelete.toolRoutingAllowed
  ) {
    throw new Error(`Router v0.3 classifier smoke failed for file delete: ${fileDelete.kind}/${fileDelete.fileOperation}.`);
  }

  const codeWork = classifyIntentText('implement router pipeline and return strict json');
  const modelRoute = selectModelRouteForText('implement router pipeline and return strict json', codeWork);
  if (codeWork.kind !== 'code' || modelRoute.selectedRole !== 'gemma4-balanced') {
    throw new Error(`Router v0.3 model route smoke failed: ${codeWork.kind}/${modelRoute.selectedRole}.`);
  }
}

async function assertAssistantPlainChatRoutes(): Promise<void> {
  const runtime = createMonarchRuntime({
    enabledModules: ['assistant'],
    enableLocalSystemRouter: false,
  });

  await runtime.kernel.start();
  try {
    const result = await runtime.kernel.submitIntent('hello, explain Monarch briefly');

    if (
      result.route?.targetModuleId !== 'assistant'
      || result.route.capabilityId !== 'assistant.reply'
      || !result.execution?.ok
    ) {
      throw new Error(`Assistant route smoke failed: ${result.summary}`);
    }
  } finally {
    await runtime.kernel.stop().catch(() => undefined);
  }
}

async function assertKnowledgePolicyRoutesFreshness(): Promise<void> {
  const runtime = createMonarchRuntime({
    enabledModules: ['knowledge'],
    enableLocalSystemRouter: false,
  });

  await runtime.kernel.start();
  try {
    const fresh = await runtime.kernel.submitIntent('should search web for latest news about Monarch');
    const freshDecision = (
      fresh.execution?.output as { decision?: { policy?: unknown } } | undefined
    )?.decision;
    if (
      fresh.route?.targetModuleId !== 'knowledge'
      || fresh.route.capabilityId !== 'knowledge.policy.evaluate'
      || !fresh.execution?.ok
      || freshDecision?.policy !== 'web_required'
    ) {
      throw new Error(`Knowledge freshness smoke failed: ${fresh.summary}`);
    }

    const local = await runtime.kernel.execute({
      id: 'exec_smoke_knowledge_local',
      intentId: 'intent_smoke_knowledge_local',
      moduleId: 'knowledge',
      capabilityId: 'knowledge.policy.evaluate',
      input: {
        text: 'write code to parse json',
      },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'smoke',
    });
    const localDecision = (
      local.output as { decision?: { policy?: unknown } } | undefined
    )?.decision;
    if (!local.ok || localDecision?.policy !== 'local_only') {
      throw new Error(`Knowledge local-only smoke failed: ${local.summary}`);
    }
  } finally {
    await runtime.kernel.stop().catch(() => undefined);
  }
}

function assertModelOutputNormalizer(): void {
  const envelope = normalizeModelOutput('{"intent":"file_generation","output_type":"json","data":{"ok":true},"user_message":"done"}');
  if (
    envelope.schemaVersion !== 'monarch.model-output.v1'
    || envelope.outputType !== 'json'
    || envelope.userMessage !== 'done'
  ) {
    throw new Error('Model output normalizer smoke failed for strict JSON envelope.');
  }

  const fencedCode = normalizeModelOutput('```ts\nconst ok = true;\n```');
  const codeData = fencedCode.data as { language?: unknown; code?: unknown };
  if (
    fencedCode.outputType !== 'code'
    || codeData.language !== 'ts'
    || codeData.code !== 'const ok = true;'
  ) {
    throw new Error('Model output normalizer smoke failed for fenced code.');
  }

  const markdown = normalizeModelOutput('# Title\n\n- item');
  if (markdown.outputType !== 'md') {
    throw new Error('Model output normalizer smoke failed for markdown text.');
  }
}

async function assertModelsCompletionUsesOpenAiCompatibleEndpoint(): Promise<void> {
  const previousFastEndpoint = process.env.MONARCH_GEMMA4_FAST_MODEL_ENDPOINT;
  const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
  const previousAllowExternalEndpoints = process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'smoke-model' }] }));
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        model: 'smoke-model',
        choices: [
          {
            message: {
              content: '{"output_type":"json","data":{"reply":"ok"},"user_message":"ok"}',
            },
          },
        ],
      }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Models endpoint smoke failed: mock server address is invalid.');
  }

  process.env.MONARCH_GEMMA4_FAST_MODEL_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS = '1';
  delete process.env.MONARCH_CHAT_MODEL_ENDPOINT;

  const runtime = createMonarchRuntime({
    enabledModules: ['models'],
    enableLocalSystemRouter: false,
  });

  try {
    await runtime.kernel.start();
    const result = await runtime.kernel.execute({
      id: 'exec_smoke_models_complete',
      intentId: 'intent_smoke_models_complete',
      moduleId: 'models',
      capabilityId: 'models.chat.complete',
      input: {
        role: 'gemma4-fast',
        text: 'reply ok as json',
        responseFormat: 'json',
        timeoutMs: 3000,
      },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'smoke',
      confirmed: true,
    });
    await runtime.kernel.stop();

    const output = result.output as {
      output?: { outputType?: unknown; data?: { reply?: unknown } };
      role?: unknown;
      model?: unknown;
    } | undefined;
    if (
      !result.ok
      || output?.role !== 'gemma4-fast'
      || output.model !== 'smoke-model'
      || output.output?.outputType !== 'json'
      || output.output.data?.reply !== 'ok'
    ) {
      throw new Error(`Models endpoint completion smoke failed: ${result.summary}`);
    }
  } finally {
    await runtime.kernel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousFastEndpoint === undefined) {
      delete process.env.MONARCH_GEMMA4_FAST_MODEL_ENDPOINT;
    } else {
      process.env.MONARCH_GEMMA4_FAST_MODEL_ENDPOINT = previousFastEndpoint;
    }
    if (previousChatEndpoint === undefined) {
      delete process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    } else {
      process.env.MONARCH_CHAT_MODEL_ENDPOINT = previousChatEndpoint;
    }
    if (previousAllowExternalEndpoints === undefined) {
      delete process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;
    } else {
      process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS = previousAllowExternalEndpoints;
    }
  }
}

async function assertFallbackCandidateRouting(): Promise<void> {
  const kernel = new MonarchKernel();
  kernel.registerModule(createFallbackOnlyNotesModule());

  await kernel.start();
  const result = await kernel.submitIntent('show notes');
  await kernel.stop();

  if (
    result.route?.targetModuleId !== 'smoke-notes'
    || result.route.capabilityId !== 'smoke.notes.list'
  ) {
    throw new Error('Router v0.2 fallback smoke failed: expected metadata candidate selection.');
  }

  if (!result.execution?.ok) {
    throw new Error(`Router v0.2 fallback execution smoke failed: ${result.summary}`);
  }
}

async function assertAmbiguousStatusLikeRequestDoesNotRoute(): Promise<void> {
  const kernel = new MonarchKernel();
  kernel.registerModule(createStatusCandidateModule('smoke-status-a'));
  kernel.registerModule(createStatusCandidateModule('smoke-status-b'));

  await kernel.start();
  const result = await kernel.submitIntent('show status');
  const snapshot = kernel.getSnapshot();
  await kernel.stop();

  if (result.route) {
    throw new Error(`Router v0.2 ambiguity smoke failed: selected ${result.route.targetModuleId}.${result.route.capabilityId || 'no-capability'}.`);
  }

  if (!snapshot.events.some((event) => event.type === 'router.route_trace')) {
    throw new Error('Router v0.2 ambiguity smoke failed: expected route trace event.');
  }
}

async function assertRiskThresholdBlocksLowConfidenceAction(): Promise<void> {
  const kernel = new MonarchKernel();
  kernel.registerModule(createLowConfidenceDeviceModule());

  await kernel.start();
  const route = await kernel.routeIntent(createSmokeIntent('intent_smoke_low_confidence_device', 'unlock lock'));
  await kernel.stop();

  if (route) {
    throw new Error('Router v0.2 risk threshold smoke failed: low-confidence device-control route should be blocked.');
  }
}

async function assertRouteTraceIsGenerated(): Promise<void> {
  const kernel = createMonarchKernel({
    enabledModules: ['memory'],
  });

  await kernel.start();
  await kernel.submitIntent('list memory');
  const snapshot = kernel.getSnapshot();
  await kernel.stop();

  const routeTrace = snapshot.events.find((event) => event.type === 'router.route_trace');
  if (!routeTrace) {
    throw new Error('Router v0.3 trace smoke failed: expected route trace event.');
  }

  if (!hasLlmRouterStage(routeTrace.payload)) {
    throw new Error('Router v0.3 trace smoke failed: expected LLM router stage summary.');
  }

  if (!hasRouterAnalysis(routeTrace.payload)) {
    throw new Error('Router v0.3 trace smoke failed: expected classifier and model router metadata.');
  }

  if (!snapshot.audit.some((entry) => entry.category === 'routing' && entry.message === 'Router v0.3 route trace.')) {
    throw new Error('Router v0.3 trace smoke failed: expected route trace audit entry.');
  }
}

async function assertVoiceBridgeModuleStatusAndMissingCommand(): Promise<void> {
  const previousStt = process.env.MONARCH_STT_COMMAND;
  const previousTts = process.env.MONARCH_TTS_COMMAND;
  delete process.env.MONARCH_STT_COMMAND;
  delete process.env.MONARCH_TTS_COMMAND;

  const runtime = createMonarchRuntime({
    enabledModules: ['voice'],
    enableLocalSystemRouter: false,
  });

  try {
    await runtime.kernel.start();
    const status = await runtime.kernel.submitIntent('voice status');
    if (
      status.route?.targetModuleId !== 'voice'
      || status.route.capabilityId !== 'voice.status'
      || !status.execution?.ok
    ) {
      throw new Error(`Voice status smoke failed: ${status.summary}`);
    }

    const start = await runtime.kernel.execute({
      id: 'exec_smoke_voice_start',
      intentId: 'intent_smoke_voice_start',
      moduleId: 'voice',
      capabilityId: 'voice.bridge.start',
      input: { bridge: 'stt' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'smoke',
      confirmed: true,
    });
    if (start.error !== 'voice-bridge-command-missing') {
      throw new Error(`Voice missing command smoke failed: ${start.summary}`);
    }
  } finally {
    await runtime.kernel.stop().catch(() => undefined);
    if (previousStt === undefined) {
      delete process.env.MONARCH_STT_COMMAND;
    } else {
      process.env.MONARCH_STT_COMMAND = previousStt;
    }
    if (previousTts === undefined) {
      delete process.env.MONARCH_TTS_COMMAND;
    } else {
      process.env.MONARCH_TTS_COMMAND = previousTts;
    }
  }
}

async function assertPluginRegistryModuleRoutes(): Promise<void> {
  const runtime = createMonarchRuntime({
    enabledModules: ['plugins'],
  });

  await runtime.kernel.start();
  const result = await runtime.kernel.submitIntent('Покажи плагины');
  await runtime.kernel.stop();

  const modules = (
    result.execution?.output as { modules?: Array<{ id?: unknown }> } | undefined
  )?.modules || [];

  if (
    result.route?.targetModuleId !== 'plugins'
    || result.route.capabilityId !== 'plugins.catalog.list'
    || !result.execution?.ok
    || !modules.some((module) => module.id === 'plugins')
  ) {
    throw new Error(`Plugins registry smoke failed: ${result.summary}`);
  }
}

async function assertAstraSkillLayerRoutes(): Promise<void> {
  const runtime = createMonarchRuntime({
    enabledModules: ['memory', 'astra'],
    enableLocalSystemRouter: false,
  });

  await runtime.kernel.start();
  try {
    const indexResult = await runtime.kernel.submitIntent('Покажи навыки Astra');
    const slotResult = await runtime.kernel.submitIntent('preview slot for memory.search');
    const bridgeResult = await runtime.kernel.submitIntent('oscar bridge');

    const cards = (
      indexResult.execution?.output as { cards?: Array<{ capabilityId?: unknown }> } | undefined
    )?.cards || [];
    const slot = (
      slotResult.execution?.output as { slot?: { capabilityId?: unknown; moduleId?: unknown } } | undefined
    )?.slot;
    const bridge = (
      bridgeResult.execution?.output as { oscar?: { apiBase?: unknown } } | undefined
    );

    if (
      indexResult.route?.targetModuleId !== 'astra'
      || indexResult.route.capabilityId !== 'astra.skills.index'
      || !indexResult.execution?.ok
      || !cards.some((card) => card.capabilityId === 'memory.search')
    ) {
      throw new Error(`Astra skill index smoke failed: ${indexResult.summary}`);
    }

    if (
      slotResult.route?.targetModuleId !== 'astra'
      || slotResult.route.capabilityId !== 'astra.slot.preview'
      || !slotResult.execution?.ok
      || slot?.capabilityId !== 'memory.search'
      || slot.moduleId !== 'memory'
    ) {
      throw new Error(`Astra slot preview smoke failed: ${slotResult.summary}`);
    }

    if (
      bridgeResult.route?.targetModuleId !== 'astra'
      || bridgeResult.route.capabilityId !== 'astra.oscar.bridge.describe'
      || !bridgeResult.execution?.ok
      || typeof bridge?.oscar?.apiBase !== 'string'
    ) {
      throw new Error(`Astra Oscar bridge smoke failed: ${bridgeResult.summary}`);
    }
  } finally {
    await runtime.kernel.stop();
  }
}

async function assertOscarPortRoutes(): Promise<void> {
  const previousOscarApiBase = process.env.OSCAR_API_BASE;
  process.env.OSCAR_API_BASE = 'http://127.0.0.1:9';

  const runtime = createMonarchRuntime({
    enabledModules: ['oscar'],
    enableLocalSystemRouter: false,
  });

  try {
    await runtime.kernel.start();
    const statusResult = await runtime.kernel.submitIntent('oscar status');
    const startBackendResult = await runtime.kernel.submitIntent('oscar start backend');
    const unloadResult = await runtime.kernel.submitIntent('oscar unload model');
    const stopBackendResult = await runtime.kernel.submitIntent('oscar stop backend');
    const webSearchResult = await runtime.kernel.submitIntent('oscar search Monarch');

    const statusOutput = statusResult.execution?.output as {
      backend?: { connected?: unknown };
    } | undefined;

    if (
      statusResult.route?.targetModuleId !== 'oscar'
      || statusResult.route.capabilityId !== 'oscar.status'
      || !statusResult.execution?.ok
      || statusOutput?.backend?.connected !== false
    ) {
      throw new Error(`Oscar status smoke failed: ${statusResult.summary}`);
    }

    if (
      startBackendResult.route?.targetModuleId !== 'oscar'
      || startBackendResult.route.capabilityId !== 'oscar.backend.start'
      || startBackendResult.execution?.error !== 'confirmation-required'
    ) {
      throw new Error(`Oscar backend start permission smoke failed: ${startBackendResult.summary}`);
    }

    if (
      unloadResult.route?.targetModuleId !== 'oscar'
      || unloadResult.route.capabilityId !== 'oscar.model.unload'
      || unloadResult.execution?.error !== 'confirmation-required'
    ) {
      throw new Error(`Oscar unload permission smoke failed: ${unloadResult.summary}`);
    }

    if (
      stopBackendResult.route?.targetModuleId !== 'oscar'
      || stopBackendResult.route.capabilityId !== 'oscar.backend.stop'
      || stopBackendResult.execution?.error !== 'confirmation-required'
    ) {
      throw new Error(`Oscar backend stop permission smoke failed: ${stopBackendResult.summary}`);
    }

    if (
      webSearchResult.route?.targetModuleId !== 'oscar'
      || webSearchResult.route.capabilityId !== 'oscar.search.ingest'
      || webSearchResult.execution?.error !== 'confirmation-required'
    ) {
      throw new Error(`Oscar permission smoke failed: ${webSearchResult.summary}`);
    }
  } finally {
    await runtime.kernel.stop().catch(() => undefined);
    if (previousOscarApiBase === undefined) {
      delete process.env.OSCAR_API_BASE;
    } else {
      process.env.OSCAR_API_BASE = previousOscarApiBase;
    }
  }
}

async function assertOscarClientTimeoutMessageIsReadable(): Promise<void> {
  const server = createServer((_request, _response) => {
    // Intentionally keep the response open so the client timeout path is exercised.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Oscar timeout smoke failed: mock server address is invalid.');
  }

  const client = new OscarClient({
    apiBase: `http://127.0.0.1:${address.port}`,
    autoStart: false,
    timeoutMs: 50,
    chatTimeoutMs: 50,
  });

  try {
    await client.chat({
      messages: [{ role: 'user', content: 'ping' }],
      web_search: false,
      use_memory: false,
      reasoning_effort: 'low',
      max_new_tokens: 32,
      temperature: 0,
      top_p: 1,
    });
    throw new Error('Oscar timeout smoke failed: hanging chat should time out.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Oscar backend request timed out after 50ms')) {
      throw new Error(`Oscar timeout smoke failed: unreadable message "${message}".`);
    }
    if (/This operation was aborted/i.test(message)) {
      throw new Error(`Oscar timeout smoke failed: raw abort leaked "${message}".`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function assertSecurityModuleRoutes(): Promise<void> {
  const runtime = createMonarchRuntime({
    enabledModules: ['security'],
    enableLocalSystemRouter: false,
  });

  try {
    await runtime.kernel.start();
    const statusResult = await runtime.kernel.submitIntent('security status');
    const startResult = await runtime.kernel.submitIntent('start security protection');

    const statusOutput = statusResult.execution?.output as {
      payload?: { running?: unknown };
    } | undefined;

    if (
      statusResult.route?.targetModuleId !== 'security'
      || statusResult.route.capabilityId !== 'security.status'
      || !statusResult.execution?.ok
      || typeof statusOutput?.payload?.running !== 'boolean'
    ) {
      throw new Error(`Security status smoke failed: ${statusResult.summary}`);
    }

    if (
      startResult.route?.targetModuleId !== 'security'
      || startResult.route.capabilityId !== 'security.protection.start'
      || startResult.execution?.error !== 'confirmation-required'
    ) {
      throw new Error(`Security permission smoke failed: ${startResult.summary}`);
    }
  } finally {
    await runtime.kernel.stop().catch(() => undefined);
  }
}

async function assertApplicationLayerAssemblesProgram(): Promise<void> {
  const app = new MonarchApplication({
    enabledModules: ['memory', 'diagnostics', 'plugins'],
    enableLocalSystemRouter: false,
  });

  await app.start();
  try {
    const state = await app.getState('show plugin capability map');
    const profile = app.getSystemProfile();
    const result = await app.submitIntent({
      text: 'Покажи плагины',
    });

    if (!state.runtime.health.ok) {
      throw new Error('Application layer smoke failed: health should be ok.');
    }

    if (!profile.runtimeContract.modules.some((module) => module.id === 'plugins')) {
      throw new Error('Application layer smoke failed: system profile should expose plugins module.');
    }

    if (!profile.runtimeContract.capabilities.some((capability) => capability.id === 'plugins.catalog.list')) {
      throw new Error('Application layer smoke failed: system profile should expose plugin catalog capability.');
    }

    if (
      result.route?.targetModuleId !== 'plugins'
      || result.route.capabilityId !== 'plugins.catalog.list'
      || !result.execution?.ok
    ) {
      throw new Error(`Application layer smoke failed: ${result.summary}`);
    }
  } finally {
    await app.stop();
  }
}

async function assertHttpMutationApiRequiresSessionToken(): Promise<void> {
  const app = new MonarchApplication({
    packages: [createSmokeConfirmationPackage()],
    enabledModules: ['smoke-confirm-risk'],
    enableLocalSystemRouter: false,
    permissionProfile: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  });
  await app.start();

  const server = createMonarchHttpServer({
    app,
    publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
    host: '127.0.0.1',
    port: 4317,
    apiToken: 'smoke-session-token',
    requireApiToken: true,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('HTTP session smoke failed: server address is invalid.');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({
    moduleId: 'smoke-confirm-risk',
    capabilityId: 'smoke.confirm.read',
    input: {},
  });

  try {
    const unauthenticatedState = await fetch(`${baseUrl}/api/state`);
    if (unauthenticatedState.status !== 401) {
      throw new Error(`HTTP sensitive GET smoke failed: unauthenticated state returned ${unauthenticatedState.status}.`);
    }

    const authenticatedSystem = await fetch(`${baseUrl}/api/system`, {
      headers: {
        'X-Monarch-Session': 'smoke-session-token',
      },
    });
    const systemPayload = await authenticatedSystem.json() as { id?: unknown };
    if (!authenticatedSystem.ok || systemPayload.id !== 'monarch.system.profile') {
      throw new Error(`HTTP sensitive GET smoke failed: authenticated system returned ${authenticatedSystem.status}.`);
    }

    const unauthenticated = await fetch(`${baseUrl}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (unauthenticated.status !== 401) {
      throw new Error(`HTTP session smoke failed: unauthenticated execute returned ${unauthenticated.status}.`);
    }

    const crossOrigin = await fetch(`${baseUrl}/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'http://example.invalid',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body,
    });
    if (crossOrigin.status !== 403) {
      throw new Error(`HTTP session smoke failed: cross-origin execute returned ${crossOrigin.status}.`);
    }

    const authenticated = await fetch(`${baseUrl}/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body,
    });
    const payload = await authenticated.json() as { ok?: boolean; result?: { ok?: boolean } };
    if (!authenticated.ok || !payload.ok || !payload.result?.ok) {
      throw new Error(`HTTP session smoke failed: authenticated execute returned ${authenticated.status}.`);
    }

    const directMissingConfirmation = await fetch(`${baseUrl}/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body: JSON.stringify({
        moduleId: 'smoke-confirm-risk',
        capabilityId: 'smoke.confirm.write',
        input: { value: 'missing-token' },
        confirmed: true,
      }),
    });
    if (directMissingConfirmation.status !== 400) {
      throw new Error(`HTTP direct confirmation smoke failed: missing token returned ${directMissingConfirmation.status}.`);
    }

    const directBlocked = await fetch(`${baseUrl}/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body: JSON.stringify({
        moduleId: 'smoke-confirm-risk',
        capabilityId: 'smoke.confirm.write',
        input: { value: 'original-direct-request' },
        confirmed: false,
      }),
    });
    const directBlockedPayload = await directBlocked.json() as {
      result?: { error?: string; metadata?: { confirmation?: { token?: string } } };
    };
    const directToken = directBlockedPayload.result?.metadata?.confirmation?.token;
    if (!directBlocked.ok || directBlockedPayload.result?.error !== 'confirmation-required' || !directToken) {
      throw new Error('HTTP direct confirmation smoke failed: unconfirmed execute did not return a confirmation token.');
    }

    const directConfirmed = await fetch(`${baseUrl}/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body: JSON.stringify({
        moduleId: 'smoke-confirm-risk',
        capabilityId: 'smoke.confirm.write',
        input: { value: 'tampered-direct-request' },
        confirmed: true,
        confirmationToken: directToken,
      }),
    });
    const directConfirmedPayload = await directConfirmed.json() as { result?: { ok?: boolean; summary?: string } };
    if (!directConfirmed.ok || !directConfirmedPayload.result?.ok || !/original-direct-request/.test(directConfirmedPayload.result.summary || '')) {
      throw new Error('HTTP direct confirmation smoke failed: confirmed execute did not replay the original saved request.');
    }

    const missingConfirmationToken = await fetch(`${baseUrl}/api/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body: JSON.stringify({
        text: 'smoke confirm write intent',
        confirmed: true,
      }),
    });
    if (missingConfirmationToken.status !== 400) {
      throw new Error(`HTTP confirmation smoke failed: missing token returned ${missingConfirmationToken.status}.`);
    }

    const blockedIntent = await fetch(`${baseUrl}/api/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body: JSON.stringify({
        text: 'smoke confirm write intent',
        confirmed: false,
      }),
    });
    const blockedPayload = await blockedIntent.json() as {
      result?: {
        execution?: { error?: string; metadata?: { confirmation?: { token?: string } } };
        confirmation?: { token?: string };
      };
    };
    const confirmationToken = blockedPayload.result?.confirmation?.token
      || blockedPayload.result?.execution?.metadata?.confirmation?.token;
    if (!blockedIntent.ok || blockedPayload.result?.execution?.error !== 'confirmation-required' || !confirmationToken) {
      throw new Error('HTTP confirmation smoke failed: unconfirmed intent did not return a confirmation token.');
    }

    const badConfirmation = await fetch(`${baseUrl}/api/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body: JSON.stringify({
        text: 'smoke confirm write intent',
        confirmed: true,
        confirmationToken: 'wrong-token',
      }),
    });
    if (badConfirmation.status !== 400) {
      throw new Error(`HTTP confirmation smoke failed: bad token returned ${badConfirmation.status}.`);
    }

    const confirmedIntent = await fetch(`${baseUrl}/api/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body: JSON.stringify({
        text: 'smoke confirm write intent',
        confirmed: true,
        confirmationToken,
      }),
    });
    const confirmedPayload = await confirmedIntent.json() as { result?: { execution?: { ok?: boolean }; plan?: { status?: string } } };
    if (!confirmedIntent.ok || !confirmedPayload.result?.execution?.ok || confirmedPayload.result?.plan?.status !== 'completed') {
      throw new Error(`HTTP confirmation smoke failed: confirmed token returned ${confirmedIntent.status}.`);
    }

    const replayConfirmation = await fetch(`${baseUrl}/api/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body: JSON.stringify({
        text: 'smoke confirm write intent',
        confirmed: true,
        confirmationToken,
      }),
    });
    if (replayConfirmation.status !== 400) {
      throw new Error(`HTTP confirmation smoke failed: replay token returned ${replayConfirmation.status}.`);
    }

    const index = await fetch(baseUrl).then((response) => response.text());
    if (!index.includes('name="monarch-api-token"') || !index.includes('smoke-session-token')) {
      throw new Error('HTTP session smoke failed: UI index did not receive the API token metadata.');
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await app.stop();
  }
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

function createLifecycleOrderModule(
  id: string,
  dependencies: string[],
  events: string[]
): MonarchModule {
  return {
    manifest: {
      id,
      name: id,
      version: '0.1.0',
      kind: 'system',
      description: 'Smoke-only module for dependency lifecycle ordering.',
      owns: [id],
      permissions: [],
      dependencies,
      capabilities: [],
    },
    async activate(): Promise<void> {
      events.push(`start:${id}`);
    },
    async deactivate(): Promise<void> {
      events.push(`stop:${id}`);
    },
  };
}

function createSmokePackage(id: string): MonarchModulePackage {
  return {
    id,
    moduleId: id,
    version: '0.1.0',
    core: {
      minVersion: '0.1.0',
    },
    factory: () => createLifecycleOrderModule(id, [], []),
  };
}

function createSmokeConfirmationPackage(): MonarchModulePackage {
  return {
    id: 'smoke-confirm-risk',
    moduleId: 'smoke-confirm-risk',
    version: '0.1.0',
    core: {
      minVersion: '0.1.0',
    },
    factory: createSmokeConfirmationModule,
  };
}

function createSmokeConfirmationModule(): MonarchModule {
  return {
    manifest: {
      id: 'smoke-confirm-risk',
      name: 'Smoke Confirm Risk',
      version: '0.1.0',
      kind: 'system',
      description: 'Smoke-only module for API confirmation and token flows.',
      owns: ['smoke confirmation'],
      permissions: ['none', 'execute'],
      capabilities: [
        {
          id: 'smoke.confirm.read',
          moduleId: 'smoke-confirm-risk',
          title: 'Smoke read',
          risk: 'none',
        },
        {
          id: 'smoke.confirm.write',
          moduleId: 'smoke-confirm-risk',
          title: 'Smoke write',
          // Auto mode intentionally permits workspace writes. Use an execute
          // risk here so this smoke keeps validating one-time approval tokens.
          risk: 'execute',
          routing: {
            aliases: ['smoke confirm write'],
            keywords: ['smoke', 'confirm', 'write'],
            intentKinds: ['smoke.confirm'],
          },
        },
      ],
    },
    async activate(): Promise<void> {},
    async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
      if (!/smoke confirm write/i.test(intent.text)) {
        return null;
      }

      return {
        intentId: intent.id,
        targetModuleId: 'smoke-confirm-risk',
        capabilityId: 'smoke.confirm.write',
        confidence: 0.99,
        reason: 'Smoke-only confirmation route.',
        permissionMode: 'confirm',
        input: { value: intent.text },
      };
    },
    async executeCapability(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
      if (request.capabilityId === 'smoke.confirm.read') {
        return {
          ok: true,
          summary: 'Smoke read executed.',
          output: { ok: true },
        };
      }

      if (request.capabilityId === 'smoke.confirm.write') {
        const input = request.input && typeof request.input === 'object'
          ? request.input as { value?: unknown }
          : {};
        const value = typeof input.value === 'string' ? input.value : 'empty';
        return {
          ok: true,
          summary: `Smoke confirmed write: ${value}`,
          output: { value },
        };
      }

      return {
        ok: false,
        summary: `Unsupported smoke confirmation capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    },
  };
}

function createSmokeIntent(id: string, text: string): MonarchIntent {
  return {
    id,
    source: 'desktop',
    text,
    createdAt: new Date(0).toISOString(),
  };
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

function createStatusCandidateModule(id: string): MonarchModule {
  return {
    manifest: {
      id,
      name: id,
      version: '0.1.0',
      kind: 'system',
      description: 'Smoke-only status candidate for ambiguity checks.',
      owns: ['status'],
      permissions: ['read'],
      capabilities: [
        {
          id: `${id}.status`,
          moduleId: id,
          title: 'Show status',
          risk: 'read',
          routing: {
            aliases: ['show status'],
            keywords: ['status'],
            intentKinds: ['status.read'],
          },
        },
      ],
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return {
        ok: true,
        summary: `${id} status read.`,
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
    async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
      if (!/unlock/i.test(intent.text)) {
        return null;
      }

      return {
        intentId: intent.id,
        targetModuleId: 'smoke-low-confidence-device',
        capabilityId: 'smoke.lock.unlock',
        confidence: 0.72,
        reason: 'Smoke module reports a low-confidence device-control route.',
        permissionMode: 'confirm',
        input: {},
      };
    },
  };
}

function createThrowingRouterModule(): MonarchModule {
  return {
    manifest: {
      id: 'smoke-throwing-router',
      name: 'Smoke Throwing Router',
      version: '0.1.0',
      kind: 'system',
      description: 'Smoke-only module that throws during route handling.',
      owns: ['smoke routing failure'],
      permissions: [],
      capabilities: [],
    },
    async activate(): Promise<void> {},
    async handleIntent(): Promise<null> {
      throw new Error('smoke route failure');
    },
  };
}

function createThrowingExecutionModule(): MonarchModule {
  return {
    manifest: {
      id: 'smoke-throwing-executor',
      name: 'Smoke Throwing Executor',
      version: '0.1.0',
      kind: 'system',
      description: 'Smoke-only module that throws during capability execution.',
      owns: ['smoke execution failure'],
      permissions: ['none'],
      capabilities: [
        {
          id: 'smoke.throw',
          moduleId: 'smoke-throwing-executor',
          title: 'Throw during execution',
          risk: 'none',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    },
    async activate(): Promise<void> {},
    async health(): Promise<MonarchExecutionResult> {
      return {
        ok: true,
        summary: 'Smoke throwing executor is ready.',
      };
    },
    async executeCapability(
      _request: MonarchExecutionRequest
    ): Promise<MonarchExecutionResult> {
      throw new Error('smoke execution failure');
    },
  };
}

async function assertUnifiedMemoryBridgeFlow(): Promise<void> {
  const filePath = path.join(
    process.cwd(),
    'runtime',
    `smoke-unified-mem-${Date.now()}.json`
  );

  const kernel = new MonarchKernel();

  // Register unified MemoryModule
  kernel.registerModule(new MemoryModule({ storePath: filePath }));

  // Register a mock OscarModule
  kernel.registerModule({
    manifest: {
      id: 'oscar',
      name: 'Oscar Mock',
      version: '0.1.0',
      kind: 'system',
      description: 'Mock Oscar backend module',
      owns: ['oscar'],
      permissions: ['read', 'write'],
      capabilities: [
        {
          id: 'oscar.memory.search',
          moduleId: 'oscar',
          title: 'Search Oscar Memory',
          risk: 'read',
        }
      ]
    },
    async activate(): Promise<void> {},
    async executeCapability(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
      if (request.capabilityId === 'oscar.memory.search') {
        return {
          ok: true,
          summary: 'Mock search finished',
          output: {
            results: [
              {
                id: 101,
                title: 'Oscar Fact 1',
                url: null,
                excerpt: 'Oscar has GGUF models running locally',
                score: -1.5,
              },
              {
                id: 102,
                title: 'Oscar Fact 2',
                url: null,
                excerpt: 'Oscar low relevance fact',
                score: -0.1,
              }
            ]
          }
        };
      }
      return { ok: false, summary: 'unsupported' };
    }
  });

  await kernel.start();
  try {
    // 1. Remember a local record
    await kernel.execute({
      id: 'exec_smoke_remember',
      intentId: 'intent_smoke_remember',
      moduleId: 'memory',
      capabilityId: 'memory.remember',
      input: { text: 'Monarch is a private local AI kernel', pinned: true },
      createdAt: new Date().toISOString(),
      requestedBy: 'smoke',
      confirmed: true,
    });

    // 2. Perform unified memory search
    const searchResult = await kernel.execute({
      id: 'exec_smoke_search',
      intentId: 'intent_smoke_search',
      moduleId: 'memory',
      capabilityId: 'memory.search',
      input: { query: 'local AI models', limit: 10 },
      createdAt: new Date().toISOString(),
      requestedBy: 'smoke',
    });

    if (!searchResult.ok) {
      throw new Error(`Unified memory search execution failed: ${searchResult.summary}`);
    }

    const records = (searchResult.output as any)?.records || [];
    const hasLocal = records.some((r: any) => r.text.includes('private local AI kernel'));
    const hasOscarRelevant = records.some((r: any) => r.text.includes('GGUF models running locally'));
    const hasOscarLowRel = records.some((r: any) => r.text.includes('low relevance fact'));

    if (!hasLocal || !hasOscarRelevant || hasOscarLowRel) {
      throw new Error(`Unified memory bridge validation failed. local: ${hasLocal}, oscar: ${hasOscarRelevant}, filtered: ${!hasOscarLowRel}`);
    }
  } finally {
    await kernel.stop();
    await rm(filePath, { force: true });
  }
}

async function assertStreamCompletionAndCancellationFlow(): Promise<void> {
  const previousChatEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
  const previousAllowExternalEndpoints = process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;

  let requestCount = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url?.includes('/chat/completions')) {
      requestCount++;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Send some tokens
      response.write('data: {"choices":[{"delta":{"content":"Mon"}}]}\n\n');
      setTimeout(() => {
        response.write('data: {"choices":[{"delta":{"content":"arch"}}]}\n\n');
        setTimeout(() => {
          response.write('data: [DONE]\n\n');
          response.end();
        }, 50);
      }, 50);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Mock streaming server address is invalid.');
  }

  process.env.MONARCH_CHAT_MODEL_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS = '1';

  const runtime = createMonarchRuntime({
    enabledModules: ['assistant', 'models'],
    enableLocalSystemRouter: false,
  });

  await runtime.kernel.start();
  try {
    const replyResult = await runtime.kernel.execute({
      id: 'exec_stream_test',
      intentId: 'intent_stream_test',
      moduleId: 'assistant',
      capabilityId: 'assistant.reply',
      input: { text: 'hello explain Monarch' },
      createdAt: new Date().toISOString(),
      requestedBy: 'smoke',
      confirmed: true,
    });

    if (!replyResult.ok) {
      throw new Error(`Stream completion execution failed: ${replyResult.summary}`);
    }

    const events = runtime.kernel.getEvents();
    const tokenEvents = events.filter((e) => e.type === 'assistant.token');
    const receivedTokens = tokenEvents.map((e) => (e.payload as any).token);
    const fullReply = receivedTokens.join('');
    if (fullReply !== 'Monarch') {
      throw new Error(`Stream completion token verification failed: expected 'Monarch', got '${fullReply}'`);
    }

    // Now test cancellation
    const cancelResult = await runtime.kernel.execute({
      id: 'exec_cancel_test',
      intentId: 'intent_cancel_nonexistent',
      moduleId: 'assistant',
      capabilityId: 'assistant.cancel',
      input: { intentId: 'intent_cancel_nonexistent' },
      createdAt: new Date().toISOString(),
      requestedBy: 'smoke',
      confirmed: true,
    });

    if (!cancelResult.ok) {
      throw new Error('Cancel assistant reply execution failed.');
    }
  } finally {
    await runtime.kernel.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.MONARCH_CHAT_MODEL_ENDPOINT = previousChatEndpoint || '';
    process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS = previousAllowExternalEndpoints || '';
  }
}

async function assertClarificationRequiredFlow(): Promise<void> {
  const kernel = new MonarchKernel();

  // Register two mock modules with identical routing keywords to trigger ambiguity
  kernel.registerModule({
    manifest: {
      id: 'mock-module-a',
      name: 'Mock Module A',
      version: '0.1.0',
      kind: 'system',
      description: 'Mock A',
      owns: ['ambiguity trigger'],
      permissions: ['read'],
      capabilities: [
        {
          id: 'mock.capability.a',
          moduleId: 'mock-module-a',
          title: 'Capability A',
          risk: 'read',
          routing: {
            aliases: ['trigger ambiguity'],
            keywords: ['ambiguity'],
            intentKinds: ['mock.a'],
          }
        }
      ]
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'A done' };
    }
  });

  kernel.registerModule({
    manifest: {
      id: 'mock-module-b',
      name: 'Mock Module B',
      version: '0.1.0',
      kind: 'system',
      description: 'Mock B',
      owns: ['ambiguity trigger'],
      permissions: ['read'],
      capabilities: [
        {
          id: 'mock.capability.b',
          moduleId: 'mock-module-b',
          title: 'Capability B',
          risk: 'read',
          routing: {
            aliases: ['trigger ambiguity'],
            keywords: ['ambiguity'],
            intentKinds: ['mock.b'],
          }
        }
      ]
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'B done' };
    }
  });

  await kernel.start();
  try {
    const result = await kernel.submitIntent('trigger ambiguity');

    if (result.route !== null) {
      throw new Error('Ambiguity clarification test failed: expected route to be null.');
    }

    const execution = result.execution as any;
    if (!execution || execution.ok !== false || execution.error !== 'clarification-required') {
      throw new Error(`Ambiguity clarification test failed: expected clarification-required execution error, got ${JSON.stringify(execution)}`);
    }

    const output = execution.output;
    if (
      output.mode !== 'clarification-required' ||
      output.clarificationMode !== 'ambiguous' ||
      !Array.isArray(output.candidates) ||
      output.candidates.length < 2
    ) {
      throw new Error('Ambiguity clarification response output payload is invalid.');
    }
  } finally {
    await kernel.stop();
  }
}

