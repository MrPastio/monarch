import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
  type MonarchModule,
  type MonarchModulePackage,
} from './core';
import { OscarClient } from './modules/oscar/client';

let smokeExecutionSequence = 0;

async function executeSmokeCapability(
  kernel: MonarchKernel,
  capabilityId: string,
  input: Record<string, unknown> = {},
  confirmed = false,
): Promise<MonarchExecutionResult> {
  const capability = kernel.getCapability(capabilityId);
  if (!capability) throw new Error(`Smoke capability is unavailable: ${capabilityId}`);
  smokeExecutionSequence += 1;
  return kernel.execute({
    id: `exec_smoke_typed_${smokeExecutionSequence}`,
    intentId: `intent_smoke_typed_${smokeExecutionSequence}`,
    moduleId: capability.moduleId,
    capabilityId,
    input,
    createdAt: new Date(0).toISOString(),
    requestedBy: 'smoke',
    source: 'smoke',
    confirmed,
  });
}


async function main(): Promise<void> {
  const previousSmokeTest = process.env.MONARCH_SMOKE_TEST;

  // Applications started by the smoke must not reconcile the owner's source
  // turns, outbox or settings: give them their own data and state roots.
  const isolationParent = path.join(process.cwd(), 'runtime');
  await mkdir(isolationParent, { recursive: true });
  const isolationRoot = await mkdtemp(path.join(isolationParent, 'smoke-isolation-'));
  const previousRoots = { MONARCH_DATA_ROOT: process.env.MONARCH_DATA_ROOT, MONARCH_STATE_ROOT: process.env.MONARCH_STATE_ROOT };
  process.env.MONARCH_DATA_ROOT = path.join(isolationRoot, 'data');
  process.env.MONARCH_STATE_ROOT = path.join(isolationRoot, 'state');
  process.env.MONARCH_SMOKE_TEST = '1';
  try {
    await runSmokeSuite();
  } finally {
    for (const [key, value] of Object.entries(previousRoots)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(isolationRoot, { recursive: true, force: true, maxRetries: 3 });
    if (previousSmokeTest === undefined) {
      delete process.env.MONARCH_SMOKE_TEST;
    } else {
      process.env.MONARCH_SMOKE_TEST = previousSmokeTest;
    }
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
  await assertVoiceBridgeModuleStatusAndMissingCommand();
  await assertPluginRegistryModuleRoutes();
  await assertAstraSkillLayerRoutes();
  await assertOscarPortRoutes();
  await assertOscarClientTimeoutMessageIsReadable();
  await assertSecurityModuleRoutes();
  await assertHttpMutationApiRequiresSessionToken();
  await assertApplicationLayerAssemblesProgram();
  await assertStreamCompletionAndCancellationFlow();

  const kernel = createMonarchKernel();
  kernel.registerModule(createThrowingExecutionModule());
  await kernel.start();


  const diagnosticsModules = await executeSmokeCapability(kernel, 'diagnostics.modules.list');
  const diagnosticsCapabilities = await executeSmokeCapability(kernel, 'diagnostics.capabilities.list');
  const thrownExecution = await kernel.execute({
    id: 'exec_smoke_throw',
    intentId: 'intent_smoke_throw',
    moduleId: 'smoke-throwing-executor',
    capabilityId: 'smoke.throw',
    input: {},
    createdAt: new Date(0).toISOString(),
    requestedBy: 'smoke',
  });

  if (!diagnosticsModules.ok) {
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
    const unhealthy = health.modules
      .filter((entry) => entry.status !== 'active' || entry.health?.ok === false)
      .map((entry) => `${entry.moduleId}:${entry.status}:${entry.health?.error || 'health-failed'}`)
      .join(', ');
    throw new Error(`Health smoke failed: ${unhealthy || 'unknown module state'}.`);
  }

  const snapshot = kernel.getSnapshot();
  if (snapshot.audit.length === 0 || snapshot.events.length === 0) {
    throw new Error('Observability smoke failed: expected audit and event history.');
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
  const profileOnlyRuntime = createMonarchRuntime({
    enabledModules: ['profile'],
  });
  const moduleIds = profileOnlyRuntime.modules.map((module) => module.manifest.id);
  const diagnosticsRecord = profileOnlyRuntime.loadRecords.find((record) => record.packageId === 'diagnostics');

  if (moduleIds.join(',') !== 'profile' || diagnosticsRecord?.status !== 'skipped') {
    throw new Error('Bootstrap selection smoke failed: enabledModules should load only profile.');
  }

  await profileOnlyRuntime.kernel.start();
  const diagnosticsCapability = profileOnlyRuntime.kernel.getCapability('diagnostics.modules.list');
  await profileOnlyRuntime.kernel.stop();

  if (diagnosticsCapability) {
    throw new Error('Bootstrap selection smoke failed: disabled diagnostics capability was registered.');
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
    const result = await executeSmokeCapability(runtime.kernel, 'assistant.reply', {
      text: 'hello, explain Monarch briefly',
    });

    if (!result.ok) {
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
    const fresh = await executeSmokeCapability(runtime.kernel, 'knowledge.policy.evaluate', {
      text: 'should search web for latest news about Monarch',
    });
    const freshDecision = (
      fresh.output as { decision?: { policy?: unknown } } | undefined
    )?.decision;
    if (
      !fresh.ok
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
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        let stream = false;
        try {
          stream = JSON.parse(body || '{}').stream === true;
        } catch {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }

        if (stream) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end([
            'data: {"model":"smoke-model","choices":[{"delta":{"content":"Monarch smoke reply"},"finish_reason":"stop"}]}',
            '',
            'data: [DONE]',
            '',
          ].join('\n'));
          return;
        }

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
      });
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

    await assertAssistantPlainChatRoutes();
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
    const status = await executeSmokeCapability(runtime.kernel, 'voice.status');
    if (!status.ok) {
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
  const result = await runtime.kernel.execute({
    id: 'exec_smoke_plugins_catalog',
    intentId: 'intent_smoke_plugins_catalog',
    moduleId: 'plugins',
    capabilityId: 'plugins.catalog.list',
    input: {},
    createdAt: new Date(0).toISOString(),
    requestedBy: 'smoke',
    source: 'smoke',
  });
  await runtime.kernel.stop();

  const modules = (
    result.output as { modules?: Array<{ id?: unknown }> } | undefined
  )?.modules || [];

  if (
    !result.ok
    || !modules.some((module) => module.id === 'plugins')
  ) {
    throw new Error(`Plugins registry smoke failed: ${result.summary}`);
  }
}

async function assertAstraSkillLayerRoutes(): Promise<void> {
  const runtime = createMonarchRuntime({
    enabledModules: ['profile', 'astra'],
    enableLocalSystemRouter: false,
  });

  await runtime.kernel.start();
  try {
    const indexResult = await executeSmokeCapability(runtime.kernel, 'astra.skills.index');
    const slotResult = await executeSmokeCapability(runtime.kernel, 'astra.slot.preview', {
      capabilityId: 'profile.read',
    });
    const bridgeResult = await executeSmokeCapability(runtime.kernel, 'astra.oscar.bridge.describe');

    const cards = (
      indexResult.output as { cards?: Array<{ capabilityId?: unknown }> } | undefined
    )?.cards || [];
    const slot = (
      slotResult.output as { slot?: { capabilityId?: unknown; moduleId?: unknown } } | undefined
    )?.slot;
    const bridge = (
      bridgeResult.output as { oscar?: { apiBase?: unknown } } | undefined
    );

    if (
      !indexResult.ok
      || !cards.some((card) => card.capabilityId === 'profile.read')
    ) {
      throw new Error(`Astra skill index smoke failed: ${indexResult.summary}`);
    }

    if (
      !slotResult.ok
      || slot?.capabilityId !== 'profile.read'
      || slot.moduleId !== 'profile'
    ) {
      throw new Error(`Astra slot preview smoke failed: ${slotResult.summary}`);
    }

    if (
      !bridgeResult.ok
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
    const statusResult = await executeSmokeCapability(runtime.kernel, 'oscar.status');
    const startBackendResult = await executeSmokeCapability(runtime.kernel, 'oscar.backend.start');
    const unloadResult = await executeSmokeCapability(runtime.kernel, 'oscar.model.unload');
    const stopBackendResult = await executeSmokeCapability(runtime.kernel, 'oscar.backend.stop');
    const webSearchResult = await executeSmokeCapability(runtime.kernel, 'oscar.search.ingest', {
      query: 'Monarch',
    });

    const statusOutput = statusResult.output as {
      backend?: { connected?: unknown };
    } | undefined;

    if (
      !statusResult.ok
      || statusOutput?.backend?.connected !== false
    ) {
      throw new Error(`Oscar status smoke failed: ${statusResult.summary}`);
    }

    if (
      startBackendResult.error !== 'confirmation-required'
    ) {
      throw new Error(`Oscar backend start permission smoke failed: ${startBackendResult.summary}`);
    }

    if (
      unloadResult.error !== 'confirmation-required'
    ) {
      throw new Error(`Oscar unload permission smoke failed: ${unloadResult.summary}`);
    }

    if (
      stopBackendResult.error !== 'confirmation-required'
    ) {
      throw new Error(`Oscar backend stop permission smoke failed: ${stopBackendResult.summary}`);
    }

    if (
      webSearchResult.error !== 'confirmation-required'
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
      execution_authority: 'none',
      persistence_owner: 'backend',
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
    const statusResult = await executeSmokeCapability(runtime.kernel, 'security.status');
    const startResult = await executeSmokeCapability(runtime.kernel, 'security.protection.start');

    const statusOutput = statusResult.output as {
      payload?: { running?: unknown };
    } | undefined;

    if (
      !statusResult.ok
      || typeof statusOutput?.payload?.running !== 'boolean'
    ) {
      throw new Error(`Security status smoke failed: ${statusResult.summary}`);
    }

    if (
      startResult.error !== 'confirmation-required'
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
    const result = await app.executeCapability({
      moduleId: 'plugins',
      capabilityId: 'plugins.catalog.list',
      input: {},
      source: 'smoke',
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
      !result.ok
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
    if (directMissingConfirmation.status !== 410) {
      throw new Error(`HTTP direct authority smoke failed: confirmed=true returned ${directMissingConfirmation.status}.`);
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
      }),
    });
    const directBlockedPayload = await directBlocked.json() as {
      ok?: boolean;
      result?: { ok?: boolean; error?: string };
    };
    if (
      directBlocked.status !== 200
      || directBlockedPayload.ok !== false
      || directBlockedPayload.result?.ok !== false
      || directBlockedPayload.result?.error !== 'confirmation-required'
      || directBlocked.headers.get('deprecation') !== 'true'
      || JSON.stringify(directBlockedPayload).includes('confirmationToken')
    ) {
      throw new Error('HTTP direct authority smoke failed: exact effectful capability did not retain the Kernel confirmation boundary.');
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
        confirmationToken: 'obsolete-text-token',
      }),
    });
    if (directConfirmed.status !== 410) {
      throw new Error(`HTTP direct authority smoke failed: obsolete token returned ${directConfirmed.status}.`);
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
    if (missingConfirmationToken.status !== 410) {
      throw new Error(`HTTP intent authority smoke failed: confirmed=true returned ${missingConfirmationToken.status}.`);
    }

    const blockedIntent = await fetch(`${baseUrl}/api/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'smoke-session-token',
      },
      body: JSON.stringify({
        text: 'smoke confirm write intent',
      }),
    });
    const blockedPayload = await blockedIntent.json() as { ok?: boolean; result?: unknown };
    if (
      !blockedIntent.ok
      || blockedPayload.ok !== true
      || blockedIntent.headers.get('deprecation') !== 'true'
      || JSON.stringify(blockedPayload).includes('confirmationToken')
    ) {
      throw new Error('HTTP intent authority smoke failed: legacy intent was not adapted to a token-free Turn.');
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
    if (badConfirmation.status !== 410) {
      throw new Error(`HTTP intent authority smoke failed: bad token returned ${badConfirmation.status}.`);
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
        confirmationToken: 'replayed-obsolete-token',
      }),
    });
    if (replayConfirmation.status !== 410) {
      throw new Error(`HTTP intent authority smoke failed: replay token returned ${replayConfirmation.status}.`);
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
      description: 'Smoke-only module for structured approval and legacy authority rejection.',
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
          // Effectful legacy calls must become Agent Turns; text tokens never
          // authorize this capability.
          risk: 'execute',
        },
      ],
    },
    async activate(): Promise<void> {},
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

