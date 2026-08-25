import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentKernelExecutionAdapter,
  InMemoryAgentTaskStore,
  LocalAgentDecisionProvider,
  MonarchAgentRuntime,
  type AgentDecisionProvider,
  type AgentModelDecisionRequest,
  type AgentModelDecisionResponse,
} from '../src/agent';
import {
  MonarchKernel,
  createMonarchId,
  nowIso,
  type MonarchActionProposalInput,
  type MonarchActionProposalV1,
  type MonarchExecutionRequest,
} from '../src/core';
import {
  ComputerModule,
  ComputerUseNativeBridge,
  type ComputerNativeProvider,
} from '../src/modules/computer';
import { AgentActionGuard } from '../src/modules/security/agent-guard';
import { SecurityClient } from '../src/modules/security/client';
import { SecurityModule } from '../src/modules/security';
import { OscarClient } from '../src/modules/oscar/client';
import { completeWithModelRole } from '../src/modules/models/runtime-client';

const MONARCH_ROOT = path.resolve(process.cwd());
const QA_PARENT = path.resolve(
  process.env.MONARCH_COMPUTER_MODEL_QA_ROOT || 'E:\\MonarchQA\\computer-use-model-e2e',
);
const MODEL_ROLE = 'gemma4-fast' as const;
const ACCEPTANCE_SCENARIO = process.env.MONARCH_COMPUTER_MODEL_SCENARIO === 'click-commit'
  ? 'click-commit'
  : 'type-marker';
const CURSOR_VISIBLE = process.env.MONARCH_COMPUTER_MODEL_CURSOR_VISIBLE !== '0';
const MODEL_TIMEOUT_MS = 90_000;
const DECISION_CYCLE_BUDGET_MS = MODEL_TIMEOUT_MS * 2 + 10_000;
const ACCEPTANCE_TIMEOUT_MS = boundedDuration(
  process.env.MONARCH_COMPUTER_MODEL_ACCEPTANCE_TIMEOUT_MS,
  8 * 60_000,
  60_000,
  20 * 60_000,
);
const PROGRESS_EVENT_TYPES = new Set([
  'model.started',
  'model.completed',
  'tool.started',
  'tool.completed',
  'observation.created',
  'approval.required',
  'approval.armed',
  'approval.resolved',
  'task.status.changed',
  'task.completed',
  'task.failed',
  'task.cancelled',
]);

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Computer Use model acceptance requires Windows.');
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const root = path.join(QA_PARENT, nonce);
  const title = `Monarch Oscar Model Computer Use QA ${nonce}`;
  const marker = `OSCAR_MODEL_E2E_${nonce}`;
  const expectedState = ACCEPTANCE_SCENARIO === 'click-commit' ? 'clicked' : `typed:${marker}`;
  const evidencePath = path.join(root, 'evidence.json');
  await mkdir(root, { recursive: true });

  const oscarClient = await verifyRealOscarBackend(root);

  const target = await launchQaWindow(title, root);
  const nativeBridge = new ComputerUseNativeBridge({
    monarchRoot: MONARCH_ROOT,
    runtimeRoot: path.join(root, 'runtime', 'computer-use', 'native'),
  });
  const nativeProvider: ComputerNativeProvider = CURSOR_VISIBLE
    ? nativeBridge
    : {
        status: () => nativeBridge.status(),
        listWindows: (limit, signal) => nativeBridge.listWindows(limit, signal),
        observe: (windowRef, screenshotPath, signal) => nativeBridge.observe(windowRef, screenshotPath, signal),
        act: (request, signal) => nativeBridge.act(request, signal),
        startCursorSession: async () => ({ started: false, persistent: false, qaCursorSuppressed: true }),
        stopCursorSession: () => nativeBridge.stopCursorSession(),
      };
  const computer = new ComputerModule({
    monarchRoot: MONARCH_ROOT,
    runtimeRoot: path.join(root, 'runtime', 'computer-use'),
    observationRoot: path.join(root, 'observations'),
    controlStatePath: path.join(root, 'runtime', 'computer-use', 'control.json'),
    nativeProvider,
  });
  const securityClient = new SecurityClient({
    projectRoot: path.join(MONARCH_ROOT, 'security'),
    dataRoot: path.join(root, 'security-data'),
  });
  const kernel = new MonarchKernel({
    workspaceRoot: MONARCH_ROOT,
    agencyStateDirectory: path.join(root, 'agency'),
    permissionProfile: {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      autonomyMode: 'full-local',
    },
  });
  kernel.registerModule(new SecurityModule(securityClient, new AgentActionGuard(MONARCH_ROOT)));
  kernel.registerModule(computer);

  const submittedActions: Array<{
    capabilityId: string;
    input: Record<string, unknown>;
    provenanceSource: string | null;
  }> = [];
  const executionAdapter = new AgentKernelExecutionAdapter(
    async (submission) => {
      if (submission.confirmed) {
        throw new Error('Unexpected approval path: an ordinary exact-window Computer Use atom must stay autonomous in Full Local.');
      }
      submittedActions.push({
        capabilityId: submission.proposal.capabilityId,
        input: acceptanceActionInput(readProposalInput(submission.proposal), marker),
        provenanceSource: readProposalProvenanceSource(submission.proposal),
      });
      return kernel.executeActionProposal(submission.proposal, {
        originatingUserText: submission.originatingUserText,
        requestedBy: submission.requestedBy,
        ...(submission.source ? { source: submission.source } : {}),
        ...(submission.model ? { model: submission.model } : {}),
        ...(submission.skillIds ? { skillIds: submission.skillIds } : {}),
        ...(submission.leaseId ? { leaseId: submission.leaseId } : {}),
        executionMode: 'agent-runtime',
        ...(submission.signal ? { signal: submission.signal } : {}),
      });
    },
    (submission) => kernel.prepareActionProposal(submission.proposal, {
      originatingUserText: submission.originatingUserText,
      requestedBy: submission.requestedBy,
      ...(submission.model ? { model: submission.model } : {}),
      ...(submission.skillIds ? { skillIds: submission.skillIds } : {}),
    }),
  );
  const modelTrace: Array<Record<string, unknown>> = [];
  let completionAttempts: Array<Record<string, unknown>> = [];
  let rawCompletionText: string | null = null;
  const localDecisionProvider = new LocalAgentDecisionProvider({
    workspaceRoot: MONARCH_ROOT,
    profile: 'balanced',
    role: MODEL_ROLE,
    timeoutMs: MODEL_TIMEOUT_MS,
    completionProvider: async (catalog, request, env) => {
      const completionStartedAt = Date.now();
      const completion = await completeWithModelRole(catalog, request, env);
      rawCompletionText = completion.rawText?.slice(0, 4_000) || null;
      completionAttempts.push({
        role: request.role,
        agentDecisionModel: request.agentDecisionModel || null,
        maxTokens: request.maxTokens || null,
        systemChars: request.messages[0]?.content.length || 0,
        inputChars: request.messages[1]?.content.length || 0,
        ok: completion.ok,
        error: completion.error || null,
        adapter: completion.adapter,
        model: completion.model || null,
        rawText: rawCompletionText,
        latencyMs: Date.now() - completionStartedAt,
        loadLatencyMs: completion.loadLatencyMs || null,
        generationLatencyMs: completion.generationLatencyMs || null,
      });
      return completion;
    },
  });
  const decisionProvider: AgentDecisionProvider = {
    decide: async (request: AgentModelDecisionRequest): Promise<AgentModelDecisionResponse> => {
      rawCompletionText = null;
      completionAttempts = [];
      const response = await localDecisionProvider.decide(request);
      modelTrace.push({
        at: nowIso(),
        executionPhase: readExecutionPhase(request.compiledContext),
        repairCode: request.repair?.code || null,
        candidateCapabilityIds: response.candidateCapabilityIds || [],
        ok: response.ok,
        error: response.error || null,
        rawText: response.rawText?.slice(0, 4_000) || null,
        rawCompletionText,
        role: response.role || null,
        model: response.model || null,
        latencyMs: response.latencyMs || null,
        inputChars: response.inputChars || null,
        modelCalls: response.modelCalls || null,
        attemptedTiers: response.attemptedTiers || [],
        escalationReason: response.escalationReason || null,
        completionAttempts,
      });
      return response;
    },
  };
  const runtime = new MonarchAgentRuntime({
    store: new InMemoryAgentTaskStore(),
    decisionProvider,
    executionAdapter,
    listCapabilities: () => kernel.listCapabilities(),
    getPermissionProfile: () => kernel.getPermissionProfile(),
    getModuleStates: () => Object.fromEntries(
      kernel.getSnapshot().modules.map((record) => [
        record.manifest.id,
        record.status === 'registered' ? 'inactive' : record.status,
      ]),
    ),
    runnerId: `computer_model_acceptance_${process.pid}`,
    decisionCycleBudgetMs: DECISION_CYCLE_BUDGET_MS,
  });

  let taskId = '';
  let checkpoint: Awaited<ReturnType<typeof runtime.getTask>> = null;
  let failure: unknown;
  const startedAt = Date.now();
  const unsubscribe = runtime.subscribe('*', (commit) => {
    for (const event of commit.appendedEvents) {
      if (!PROGRESS_EVENT_TYPES.has(event.type)) continue;
      writeProgress({
        phase: 'agent-event',
        elapsedMs: Date.now() - startedAt,
        taskId: event.taskId,
        sequence: event.sequence,
        event: event.type,
        payload: boundedProgressPayload(event.payload),
      });
    }
  });
  const heartbeat = setInterval(() => {
    writeProgress({
      phase: 'heartbeat',
      elapsedMs: Date.now() - startedAt,
      taskId: taskId || null,
    });
  }, 30_000);
  heartbeat.unref?.();
  try {
    await kernel.start();
    const enabled = await kernel.execute(directRequest('computer.control.start', {}));
    assert(enabled.ok, `Computer Use did not enable: ${enabled.error || enabled.summary}`);
    await waitForQaWindow(kernel, title, target);

    await runtime.start();
    const instruction = ACCEPTANCE_SCENARIO === 'click-commit'
      ? [
        `Работай только в синтетическом тестовом окне с точным заголовком «${title}».`,
        'Сначала сам вызови список окон, затем сделай свежий снимок найденного окна.',
        'Найди кнопку «Commit» и нажми именно её. Ничего не вводи в поле «QA editor».',
        'Проверь результат по свежему read-after-action observation и заверши задачу только если увидишь состояние «clicked».',
        'Если точного окна или кнопки нет, ничего не делай в других окнах и сообщи об остановке.',
      ].join(' ')
      : [
        `Работай только в синтетическом тестовом окне с точным заголовком «${title}».`,
        'Сначала сам вызови список окон, затем сделай свежий снимок найденного окна.',
        `Введи в элемент «QA editor» точный текст «${marker}».`,
        'При необходимости можешь кликнуть по этому полю, но никогда не нажимай кнопку Commit.',
        'Проверь результат по свежему read-after-action observation и заверши задачу только если увидишь введённый текст.',
        'Если точного окна или поля нет, ничего не делай в других окнах и сообщи об остановке.',
      ].join(' ');
    const created = await runtime.createTask({
      request: instruction,
      source: { surface: 'desktop', requestId: `computer-model-e2e-${nonce}` },
      planningMode: 'model-first',
      decisionModelPolicy: {
        requestedRole: MODEL_ROLE,
        selectionSource: 'user-explicit',
        fallback: 'exact',
      },
      constraints: [{
        id: 'exact-window-only',
        description: `Нельзя управлять окном с заголовком, отличным от «${title}».`,
        kind: 'scope',
      }],
      expectedOutputs: [{
        id: ACCEPTANCE_SCENARIO === 'click-commit' ? 'clicked-state' : 'typed-marker',
        description: ACCEPTANCE_SCENARIO === 'click-commit'
          ? 'После реального нажатия Commit состояние окна стало clicked.'
          : `Текст ${marker} реально появился в QA editor.`,
        kind: 'state-change',
        required: true,
      }],
      successCriteria: [{
        id: 'kernel-read-after-action',
        description: `Kernel receipt содержит свежий observation, где состояние ${expectedState} видно после реального Windows input atom.`,
      }],
    });
    taskId = created.task.id;
    writeProgress({
      phase: 'task-created',
      elapsedMs: Date.now() - startedAt,
      taskId,
      timeoutMs: ACCEPTANCE_TIMEOUT_MS,
    });
    await waitForAgentWithWatchdog(runtime, taskId, ACCEPTANCE_TIMEOUT_MS);
    checkpoint = await runtime.getTask(taskId);
    assert(checkpoint, 'Agent checkpoint disappeared.');
    assert(checkpoint.task.status === 'completed', failureDetails(checkpoint));

    const capabilityIds = checkpoint.observations.map((entry) => entry.capabilityId);
    assert(capabilityIds.includes('computer.windows.list'), 'Agent runtime never requested the real window list.');
    assert(capabilityIds.includes('computer.window.observe'), 'Agent runtime never requested a real screenshot/UIA observation.');
    assert(
      capabilityIds.includes(ACCEPTANCE_SCENARIO === 'click-commit' ? 'computer.window.click' : 'computer.window.type'),
      `Model never dispatched the required ${ACCEPTANCE_SCENARIO} input through Kernel.`,
    );
    assert(checkpoint.approvals.length === 0, 'Ordinary exact-window action unexpectedly required approval in Full Local.');
    assert(checkpoint.events.some((event) => (
      event.type === 'model.completed'
      && event.payload.ok === true
      && event.payload.valid === true
    )), 'No valid real-model decision was recorded.');
    assert(checkpoint.events.some((event) => (
      event.type === 'model.completed'
      && (event.payload.role === MODEL_ROLE || event.payload.model === MODEL_ROLE)
    )), `The requested ${MODEL_ROLE} decision tier was not evidenced.`);
    assert(modelTrace.length === 1, `Exact-window fast path used ${modelTrace.length} model decisions instead of exactly one.`);
    assert(modelTrace[0]?.executionPhase === 'execution', 'Exact-window fast path unexpectedly spent a model turn on planning.');
    assert(checkpoint.events.some((event) => (
      event.type === 'plan.revised'
      && String(event.payload.reason || '').includes('Runtime compiled a read-only exact-window preflight')
    )), 'Runtime-owned exact-window preflight plan was not evidenced.');

    const preflightActions = submittedActions.filter((entry) => (
      entry.capabilityId === 'computer.windows.list'
      || entry.capabilityId === 'computer.window.observe'
    ));
    assert(preflightActions.length === 2, `Expected two exact-window preflight reads, received ${preflightActions.length}.`);
    assert(preflightActions.every((entry) => entry.provenanceSource === 'runtime-grammar'), 'Read-only preflight did not retain runtime-grammar provenance.');
    const effectCapabilityId = ACCEPTANCE_SCENARIO === 'click-commit'
      ? 'computer.window.click'
      : 'computer.window.type';
    const effectActions = submittedActions.filter((entry) => entry.capabilityId === effectCapabilityId);
    assert(effectActions.length === 1, `Expected one ${effectCapabilityId} atom, received ${effectActions.length}.`);
    assert(effectActions[0]?.provenanceSource === 'model-tool-call', 'Effectful input atom was not model-authored.');

    const exactWindowRefs = collectWindowRefs(checkpoint.observations.map((entry) => entry.structuredData), title);
    assert(exactWindowRefs.size === 1, `Model observations did not bind exactly one native windowRef to ${title}.`);
    const [exactWindowRef] = exactWindowRefs;
    const targetedActions = submittedActions.filter((entry) => /^computer\.window\./u.test(entry.capabilityId));
    assert(targetedActions.length > 0, 'Model never targeted the exact synthetic window.');
    assert(targetedActions.every((entry) => entry.input.windowRef === exactWindowRef), 'Model attempted a Computer Use action outside the exact synthetic window.');
    const commitElementIds = collectElementIds(checkpoint.observations.map((entry) => entry.structuredData), 'Commit');
    const commitClicks = submittedActions.filter((entry) => (
      entry.capabilityId === 'computer.window.click'
      && typeof entry.input.elementId === 'string'
      && commitElementIds.has(entry.input.elementId)
    ));
    const typeActions = submittedActions.filter((entry) => entry.capabilityId === 'computer.window.type');
    if (ACCEPTANCE_SCENARIO === 'click-commit') {
      assert(commitClicks.length > 0, 'Model did not click the exact observed Commit control.');
      assert(typeActions.length === 0, 'Model typed into QA editor even though the click-only task forbade it.');
    } else {
      assert(commitClicks.length === 0, 'Model attempted to click the forbidden Commit control.');
      assert(typeActions.length > 0 && typeActions.every((entry) => entry.input.textMatchesMarker === true), 'Model typed text other than the exact synthetic marker.');
    }

    const effectObservation = [...checkpoint.observations].reverse().find((entry) => (
      entry.capabilityId === effectCapabilityId && entry.status === 'success'
    ));
    assert(effectObservation, `No successful Computer Use ${effectCapabilityId} observation was recorded.`);
    assert(deepContains(effectObservation.structuredData, expectedState), `Read-after-action UIA receipt does not contain ${expectedState}.`);
    const screenshot = effectObservation.artifacts.find((artifact) => artifact.kind === 'image');
    assert(screenshot, 'No post-action screenshot artifact was recorded.');
    const screenshotStat = await stat(screenshot.reference);
    assert(screenshotStat.isFile() && screenshotStat.size > 0, 'Post-action screenshot artifact is empty.');

    const evidence = acceptanceEvidence({
      ok: true,
      nonce,
      title,
      marker,
      scenario: ACCEPTANCE_SCENARIO,
      expectedState,
      cursorVisible: CURSOR_VISIBLE,
      taskId,
      checkpoint,
      kernel,
      submittedActions,
      modelTrace,
      screenshotPath: screenshot.reference,
      screenshotBytes: screenshotStat.size,
    });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      ok: true,
      taskId,
      modelRole: MODEL_ROLE,
      capabilities: capabilityIds,
      screenshotPath: screenshot.reference,
      evidencePath,
    }));
  } catch (error) {
    failure = error;
    checkpoint = taskId ? await runtime.getTask(taskId).catch(() => null) : null;
    const evidence = acceptanceEvidence({
      ok: false,
      nonce,
      title,
      marker,
      scenario: ACCEPTANCE_SCENARIO,
      expectedState,
      cursorVisible: CURSOR_VISIBLE,
      taskId,
      checkpoint,
      kernel,
      submittedActions,
      modelTrace,
      error: error instanceof Error ? error.message : String(error),
    });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8').catch(() => undefined);
    writeProgress({
      phase: 'failed',
      elapsedMs: Date.now() - startedAt,
      taskId: taskId || null,
      error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
      evidencePath,
    });
  } finally {
    clearInterval(heartbeat);
    unsubscribe();
    await settleWithin(runtime.stop(), 20_000, 'Agent runtime shutdown').catch((error) => {
      writeProgress({ phase: 'cleanup-warning', component: 'agent-runtime', error: String(error) });
    });
    await settleWithin(kernel.stop(), 20_000, 'Kernel shutdown').catch((error) => {
      writeProgress({ phase: 'cleanup-warning', component: 'kernel', error: String(error) });
    });
    await terminateExactChild(target);
    await settleWithin(oscarClient.shutdownManagedBackend(), 20_000, 'Managed Oscar backend shutdown').catch((error) => {
      writeProgress({ phase: 'cleanup-warning', component: 'oscar-backend', error: String(error) });
    });
  }
  if (failure) throw failure;
}

async function verifyRealOscarBackend(root: string): Promise<OscarClient> {
  writeProgress({ phase: 'backend-preflight', status: 'starting' });
  const client = new OscarClient({
    projectRoot: path.join(MONARCH_ROOT, 'oscar'),
    workspaceRoot: MONARCH_ROOT,
    logsRoot: path.join(root, 'backend-logs'),
    autoStart: true,
    timeoutMs: 30_000,
    chatTimeoutMs: MODEL_TIMEOUT_MS,
  });
  const status = await settleWithin(client.status({ autoStart: true }), 60_000, 'Oscar backend preflight');
  assert(status.connected, `Real Oscar backend is unavailable: ${status.error || 'unknown error'}`);
  const modelStatus = status.modelStatus && typeof status.modelStatus === 'object'
    ? status.modelStatus as Record<string, unknown>
    : {};
  const availableTiers = modelStatus.available_tiers && typeof modelStatus.available_tiers === 'object'
    ? modelStatus.available_tiers as Record<string, unknown>
    : {};
  assert(modelStatus.mock === false, 'Oscar model acceptance refuses mock or unproven model runtime.');
  assert(
    availableTiers[MODEL_ROLE] === true,
    `Oscar reports that the requested real model tier ${MODEL_ROLE} is not ready.`,
  );
  writeProgress({
    phase: 'backend-preflight',
    status: 'ready',
    mock: modelStatus.mock,
    requestedTier: MODEL_ROLE,
    requestedTierReady: availableTiers[MODEL_ROLE],
    loaded: modelStatus.loaded,
    tier: typeof modelStatus.tier === 'string' ? modelStatus.tier : null,
  });
  return client;
}

async function waitForAgentWithWatchdog(
  runtime: MonarchAgentRuntime,
  taskId: string,
  timeoutMs: number,
): Promise<void> {
  const outcome = await Promise.race([
    runtime.waitForIdle(taskId).then(() => 'idle' as const),
    delay(timeoutMs).then(() => 'timeout' as const),
  ]);
  if (outcome === 'idle') return;
  writeProgress({ phase: 'watchdog', taskId, status: 'cancelling', timeoutMs });
  await settleWithin(runtime.cancel(taskId), 10_000, 'Agent watchdog cancellation').catch(() => undefined);
  await Promise.race([
    runtime.waitForIdle(taskId).catch(() => null),
    delay(20_000),
  ]);
  throw new Error(`Real-model Computer Use acceptance exceeded ${timeoutMs} ms and was cancelled.`);
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeProgress(payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ kind: 'computer-use-model-progress', at: nowIso(), ...payload }));
}

function boundedProgressPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) return {};
  const allowedKeys = new Set([
    'attempt',
    'adapter',
    'capabilityId',
    'code',
    'decisionKind',
    'durationMs',
    'error',
    'from',
    'generationLatencyMs',
    'model',
    'ok',
    'phase',
    'reason',
    'repair',
    'role',
    'status',
    'summary',
    'to',
    'valid',
  ]);
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value === 'string') bounded[key] = value.slice(0, 240);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) bounded[key] = value;
  }
  return bounded;
}

function acceptanceActionInput(input: unknown, marker: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const acceptedKeys = new Set([
    'windowRef',
    'observationId',
    'elementId',
    'visionTargetId',
    'x',
    'y',
    'key',
    'modifiers',
    'limit',
    'exactTitle',
  ]);
  const accepted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (acceptedKeys.has(key)) accepted[key] = value;
  }
  if (typeof record.text === 'string') {
    accepted.textMatchesMarker = record.text === marker;
    accepted.textLength = record.text.length;
  }
  return accepted;
}

function readProposalInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const proposal = value as Record<string, unknown>;
  return proposal.args || proposal.input || proposal.parameters || {};
}

function readProposalProvenanceSource(value: MonarchActionProposalInput | MonarchActionProposalV1): string | null {
  const source = value.provenance?.source;
  return typeof source === 'string' ? source : null;
}

function collectWindowRefs(values: unknown, exactTitle: string): Set<string> {
  const refs = new Set<string>();
  walkRecords(values, (record) => {
    const nestedWindow = record.window && typeof record.window === 'object' && !Array.isArray(record.window)
      ? record.window as Record<string, unknown>
      : undefined;
    const title = typeof record.title === 'string' ? record.title : nestedWindow?.title;
    const windowRef = typeof record.windowRef === 'string' ? record.windowRef : nestedWindow?.windowRef;
    if (title === exactTitle && typeof windowRef === 'string') refs.add(windowRef);
  });
  return refs;
}

function collectElementIds(values: unknown, exactName: string): Set<string> {
  const ids = new Set<string>();
  walkRecords(values, (record) => {
    if (record.name === exactName && typeof record.elementId === 'string') ids.add(record.elementId);
  });
  return ids;
}

function walkRecords(value: unknown, visitor: (record: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 12 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) walkRecords(entry, visitor, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  visitor(record);
  for (const entry of Object.values(record)) walkRecords(entry, visitor, depth + 1);
}

function boundedDuration(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed))) : fallback;
}

function acceptanceEvidence(input: {
  ok: boolean;
  nonce: string;
  title: string;
  marker: string;
  scenario: 'type-marker' | 'click-commit';
  expectedState: string;
  cursorVisible: boolean;
  taskId: string;
  checkpoint: Awaited<ReturnType<MonarchAgentRuntime['getTask']>>;
  kernel: MonarchKernel;
  submittedActions: Array<{
    capabilityId: string;
    input: Record<string, unknown>;
    provenanceSource: string | null;
  }>;
  modelTrace: Array<Record<string, unknown>>;
  screenshotPath?: string;
  screenshotBytes?: number;
  error?: string;
}): Record<string, unknown> {
  const checkpoint = input.checkpoint;
  const modelEvents = checkpoint?.events
    .filter((event) => event.type === 'model.completed')
    .map((event) => ({ sequence: event.sequence, createdAt: event.createdAt, ...event.payload })) || [];
  const kernelEvents = input.kernel.getSnapshot().events
    .filter((event) => /^(?:action\.proposal|computer\.|security\.action\.reviewed|capability\.execution)/u.test(event.type))
    .map((event) => ({ type: event.type, createdAt: event.createdAt, payload: redactKernelEvent(event.payload, input.title) }));
  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    ok: input.ok,
    modelRole: MODEL_ROLE,
    taskId: input.taskId || null,
    scenario: input.scenario,
    exactTarget: { title: input.title, marker: input.marker, expectedState: input.expectedState },
    cursorVisible: input.cursorVisible,
    status: checkpoint?.task.status || null,
    terminalReason: checkpoint?.task.terminalReason || null,
    usage: checkpoint?.task.usage || null,
    approvals: checkpoint?.approvals.map((entry) => ({ capabilityId: entry.capabilityId, status: entry.status })) || [],
    observations: checkpoint?.observations.map((entry) => ({
      capabilityId: entry.capabilityId,
      status: entry.status,
      summary: entry.summary,
      evidence: entry.evidence.map((item) => ({ class: item.evidenceClass, kind: item.kind, reference: item.reference, checksum: item.checksum })),
      artifacts: entry.artifacts.map((artifact) => ({ kind: artifact.kind, label: artifact.label, reference: artifact.reference, checksum: artifact.checksum })),
      expectedStateVerified: deepContains(entry.structuredData, input.expectedState),
      exactWindowVerified: deepContains(entry.structuredData, input.title),
    })) || [],
    submittedActions: input.submittedActions,
    modelTrace: input.modelTrace,
    modelEvents,
    kernelEvents,
    ...(input.screenshotPath ? { screenshot: { path: input.screenshotPath, bytes: input.screenshotBytes } } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function readExecutionPhase(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const phase = (value as Record<string, unknown>).executionPhase;
  return typeof phase === 'string' ? phase : null;
}

function redactKernelEvent(payload: unknown, exactTitle: string): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (/windows|elements|input|text|path/iu.test(key)) continue;
    if (typeof value === 'string' && value !== exactTitle && value.length > 200) continue;
    redacted[key] = value;
  }
  return redacted;
}

function failureDetails(checkpoint: NonNullable<Awaited<ReturnType<MonarchAgentRuntime['getTask']>>>): string {
  return JSON.stringify({
    status: checkpoint.task.status,
    terminalReason: checkpoint.task.terminalReason,
    approvals: checkpoint.approvals.map((entry) => ({ capabilityId: entry.capabilityId, status: entry.status })),
    observations: checkpoint.observations.map((entry) => ({ capabilityId: entry.capabilityId, status: entry.status, summary: entry.summary })),
    modelEvents: checkpoint.events
      .filter((event) => event.type === 'model.completed')
      .map((event) => event.payload),
  });
}

async function waitForQaWindow(kernel: MonarchKernel, title: string, target: ChildProcess & { qaStderr?: string }): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (target.exitCode !== null) throw new Error(`Synthetic QA window exited early: ${target.qaStderr || 'no stderr'}`);
    const result = await kernel.execute(directRequest('computer.windows.list', { limit: 100 }));
    const windows = result.output && typeof result.output === 'object'
      ? (result.output as { windows?: Array<{ title?: string }> }).windows || []
      : [];
    if (windows.some((entry) => entry.title === title)) return;
    await delay(100);
  }
  throw new Error(`Synthetic QA window was not visible after 15 seconds: ${title}`);
}

function directRequest(capabilityId: string, input: Record<string, unknown>): MonarchExecutionRequest {
  return {
    id: createMonarchId('exec_computer_model_qa'),
    intentId: createMonarchId('intent_computer_model_qa'),
    moduleId: 'computer',
    capabilityId,
    input,
    createdAt: nowIso(),
    requestedBy: capabilityId === 'computer.control.start' ? 'ui:computer-control' : 'computer-model-qa-preflight',
    source: 'desktop',
    confirmed: false,
  };
}

async function launchQaWindow(title: string, root: string): Promise<ChildProcess & { qaStderr?: string }> {
  const compiler = path.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  const executable = path.join(root, 'monarch-computer-use-model-qa.exe');
  await runChild(compiler, [
    '/nologo',
    '/target:winexe',
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    `/out:${executable}`,
    path.join(MONARCH_ROOT, 'scripts', 'fixtures', 'MonarchComputerUseQaTarget.cs'),
  ], true);
  const child = spawn(executable, [title], {
    windowsHide: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  }) as ChildProcess & { qaStderr?: string };
  child.qaStderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    child.qaStderr = `${child.qaStderr || ''}${chunk.toString('utf8')}`.slice(-4_000);
  });
  return child;
}

async function runChild(executable: string, args: string[], hidden: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: hidden, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`QA child failed (${code}): ${output.slice(-4_000)}`));
    });
  });
}

async function terminateExactChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  if (!child.killed) child.kill();
  await Promise.race([closed, delay(3_000)]);
}

function deepContains(value: unknown, expected: string, depth = 0): boolean {
  if (depth > 10) return false;
  if (typeof value === 'string') return value === expected || value.includes(expected);
  if (Array.isArray(value)) return value.some((entry) => deepContains(entry, expected, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((entry) => deepContains(entry, expected, depth + 1));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  },
);
