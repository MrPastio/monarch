import path from 'node:path';
import { createHmac } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMonarchHttpServer } from '../../src/app/http-server';
import { ImageGenerationService, looksLikeImageGenerationRequest } from '../../src/image-generation/service';
import type { MonarchApplication } from '../../src/app/application';
import type { OscarTurnCheckpoint } from '../../src/oscar-turn/types';
import { LocalJsonOscarTurnStore } from '../../src/oscar-turn/turn-store';
import { oscarBridgeHost, oscarBridgeMarker, oscarBridgeRequest } from '../fixtures/agent-v3/oscar-bridge-host';

const roots: string[] = [], token = 'owned-oscar-http-token';
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const modelHeaders = { Authorization: 'Bearer astra-synthetic-test', 'Content-Type': 'application/json' };
const route = '/api/oscar/turns';
let modelProcess: ChildProcessWithoutNullStreams, modelRoot: string;
let modelHost: { endpoint: string; hostGeneration: string; modelDigest: string };
beforeAll(async () => {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  modelRoot = await realpath(await mkdtemp(path.join(parent, 'astra-v3-prepared-model-')));
  await writeFile(path.join(modelRoot, '.fixture-marker'), 'astra-v3-prepared-model-synthetic-only', { flag: 'wx' });
  modelProcess = spawn(path.resolve('oscar/.venv/Scripts/python.exe'), ['-B', path.resolve('tests/fixtures/agent-v3/model-server.py'), modelRoot],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }); modelProcess.stdin.end();
  modelHost = await new Promise((resolve, reject) => {
    let stdout = '', stderr = ''; const timer = setTimeout(() => { modelProcess.kill(); reject(Error('owned-oscar-model-timeout')); }, 15000);
    modelProcess.once('error', error => { clearTimeout(timer); reject(error); });
    modelProcess.once('exit', code => { clearTimeout(timer); reject(Error('owned-oscar-model-exit:' + code + ':' + stderr)); });
    modelProcess.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    modelProcess.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 32768) { clearTimeout(timer); modelProcess.kill(); reject(Error('owned-oscar-model-output')); }
      if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))); } catch (error) { reject(error); } } });
  });
}, 20000);
afterEach(async () => { vi.restoreAllMocks(); const parent = await realpath('.test-tmp');
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent); expect(path.basename(root).startsWith('astra-v3-oscar-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe(oscarBridgeMarker); await rm(root, { recursive: true, force: false });
  }
});
afterAll(async () => {
  if (modelProcess && modelProcess.exitCode === null && modelProcess.signalCode === null) {
    const exited = new Promise<void>(resolve => modelProcess.once('exit', () => resolve())); modelProcess.kill(); await exited;
  }
  if (modelRoot) {
    expect(await realpath(modelRoot)).toBe(modelRoot); expect(path.dirname(modelRoot)).toBe(await realpath('.test-tmp'));
    expect(path.basename(modelRoot).startsWith('astra-v3-prepared-model-')).toBe(true);
    expect(await readFile(path.join(modelRoot, '.fixture-marker'), 'utf8')).toBe('astra-v3-prepared-model-synthetic-only');
    await rm(modelRoot, { recursive: true, force: false });
  }
});
const actor = { id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/api').digest('hex'), source: 'api' as const };
function body(kind: 'read' | 'literal' | 'reply' | 'draft' = 'read') {
  const request = oscarBridgeRequest(kind === 'draft' ? 'reply' : kind);
  if (kind === 'draft') request.astra!.goal = { kind: 'create', target: 'output', content: { kind: 'draft' } };
  return { version: 1, clientRequestId: request.clientRequestId, conversationId: request.conversationId,
    inputMessageId: request.inputMessageId!, text: request.text, privacyMode: request.privacyMode, astra: request.astra! };
}
const post = (base: string, pathname: string, value: unknown, auth = headers) => fetch(base + pathname, { method: 'POST', headers: auth, body: JSON.stringify(value) });
async function checkpoint(response: Response): Promise<OscarTurnCheckpoint> {
  const value = await response.json(); expect(response.status, JSON.stringify(value)).toBeLessThan(300);
  expect(value.turn).toBeDefined(); return value;
}
async function setup(input: { model?: boolean; ask?: boolean; selections?: boolean; references?: boolean; ordinary?: boolean; genericAgent?: boolean } = {}) {
  const parent = await realpath('.test-tmp'), root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-oscar-http-'))); roots.push(root);
  await writeFile(path.join(root, '.fixture-marker'), oscarBridgeMarker, { flag: 'wx' });
  await writeFile(path.join(root, 'selected.txt'), 'HTTP synthetic selected bytes 🟠', { flag: 'wx' });
  let openings = 0; const preparedSurfaces: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/prepare')) preparedSurfaces.push(JSON.parse(String(init!.body)).surface);
    if (String(url).endsWith('/model-turns') && init?.method === 'POST') {
      const first = openings++ === 0;
      const output = input.genericAgent ? { kind: 'complete', text: 'Явная V3 Agent-задача завершена.', evidenceRef: 'none' }
        : input.ask && first ? { kind: 'ask-user', question: 'Какой заголовок нужен?' }
        : { kind: 'create', requirementId: 'draft_file', capabilityHandle: 'create_file', targetHandle: 'selected_file', content: 'Согласованный черновик 🟠' };
      const response = await fetch(modelHost.endpoint + '/__fixture/control', { method: 'POST', headers: modelHeaders,
        body: JSON.stringify({ output: JSON.stringify(output), finish: 'stop', block: false }) }); expect(response.ok).toBe(true);
    }
    return fetch(url, init);
  };
  const selectedActor = input.ordinary ? { id: 'sha256:' + createHmac('sha256', 'owned-desktop-only').update('monarch.astra-v3.http-actor.v1/desktop').digest('hex'), source: 'desktop' as const } : actor;
  const s = await oscarBridgeHost(root, { actor: selectedActor, durableSelections: input.selections === true, referenceInputs: input.references === true,
    genericAgent: input.genericAgent === true,
    ...(input.model ? { model: { ...modelHost, fetch: transport } } : {}) });
  await s.start(); const servers: Server[] = []; let zeroRetention = false, legacyGate = false;
  const appAccess = vi.fn((_: unknown, property: string | symbol) => {
    if (property === 'oscarTurnCoordinator') return s.coordinator;
    if (property === 'astraProductPilot') return { bridge: s.bridge };
    if (property === 'getOwnerDevSettings') return () => ({ zeroRetentionEnabled: zeroRetention, internetEnabled: false, historyContextEnabled: false });
    if (input.ordinary && property === 'getComponentManagerSnapshot') return () => ({ ready: true });
    if (input.ordinary && property === 'imageGeneration') return {
      evaluateIntent: async (text: string) => ({ isImageGeneration: looksLikeImageGenerationRequest(text) }),
      readCapabilitySnapshot: ImageGenerationService.prototype.readCapabilitySnapshot,
    };
    if (input.ordinary && property === 'readComputerUseCapabilitySnapshot') return async () => ({
      schemaVersion: 1, available: false, enabled: false, surface: 'computer-use', invocation: '@Computer Use',
      ownCursor: true, observeAnalyzeAct: true, emergencyShortcut: 'Ctrl+Alt+Escape',
    });
    if (property === 'getComponentManagerSnapshot' && legacyGate) return () => ({ ready: false, autoRepairEnabled: false,
      onboarding: { required: true }, requiredModel: { phase: 'not-installed' } });
    throw Error('ordinary-product-access-forbidden:' + String(property));
  });
  const app = new Proxy<MonarchApplication>({} as MonarchApplication, { get: appAccess });
  async function server(serverToken = token, enabled = true, requireToken = true) {
    const http = createMonarchHttpServer({ app, publicDirectory: root, apiToken: serverToken, desktopAttestationToken: 'owned-desktop-only',
      requireApiToken: requireToken, allowNonLoopbackMutations: false, astraOscarTurns: enabled, ...(s.selections ? { astraSelections: s.selections } : {}) }); servers.push(http);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + (http.address() as { port: number }).port;
  }
  const base = await server();
  return { ...s, base, server, appAccess, preparedSurfaces, openings: () => openings, zeroRetention: () => { zeroRetention = true; }, legacyGate: () => { legacyGate = true; },
    close: async () => { await Promise.all(servers.map(http => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }))); await s.close(); } };
}
const context = (turn: OscarTurnCheckpoint['turn']) => ({ version: 1, conversationId: turn.conversationId, inputMessageId: turn.inputMessageId });
const eventPayload = (cp: OscarTurnCheckpoint, type: string) => cp.events.filter(event => event.type === type).at(-1)!.payload;

describe('authenticated typed Astra on the real Oscar HTTP transport', () => {
  it('routes the explicit Agent Task API into V3 without a phrase activator and preserves its typed contract', async () => {
    const s = await setup({ model: true, genericAgent: true });
    const taskRoute = '/api/agent/tasks';
    const request = {
      version: 1,
      request: 'Ответь, чему равно два плюс два. Это намеренно не операционная ключевая фраза.',
      clientRequestId: 'explicit_agent_api_request',
      conversationId: 'explicit_agent_api_conversation',
      expectedOutputs: [{ id: 'answer', description: 'Краткий проверяемый ответ.', kind: 'answer', required: true }],
      constraints: [{ description: 'Не выполнять внешние действия.', kind: 'scope' }],
      successCriteria: [{ description: 'Ответ завершён.', verificationHint: 'Есть native V3 certificate.' }],
      userPreferences: ['Кратко.'],
      budgets: { maxModelTurns: 3, maxToolCalls: 2, maxWallTimeMs: 30_000 },
    };
    try {
      const createdResponse = await post(s.base, taskRoute, request);
      const created = await createdResponse.json() as any;
      expect(createdResponse.status, JSON.stringify(created)).toBe(202);
      expect(created).toMatchObject({ astraVersion: 3, task: { id: expect.stringMatching(/^oscar_turn_/u),
        goal: { originalRequest: request.request, expectedOutputs: request.expectedOutputs,
          constraints: request.constraints, successCriteria: request.successCriteria, userPreferences: request.userPreferences },
        budgets: request.budgets } });
      const turnId = created.task.id;
      await s.flush();
      const detailResponse = await fetch(s.base + taskRoute + '/' + turnId, { headers });
      const detail = await detailResponse.json() as any;
      expect(detailResponse.status, JSON.stringify(detail)).toBe(200);
      expect(detail).toMatchObject({ astraVersion: 3, task: { id: turnId, status: 'completed',
        nativeCompletionCertified: true, message: { content: 'Явная V3 Agent-задача завершена.',
          verification: 'native-agent-completion-certificate' } } });
      const stored = (await s.coordinator.getTurn(turnId))!.turn;
      // A certified reply that cited no Kernel action is an answer, not a
      // confirmed execution.
      expect(stored.outcome?.kind).toBe('answered');
      expect(stored.request.explicitAgentTask).toMatchObject({ schemaVersion: 'monarch.astra-v3-agent-task-specification.v1',
        budgets: request.budgets });
      expect(stored.request.astra).toMatchObject({ admission: 'ordinary-agent-v1', goal: { kind: 'agent', modelMode: 'local' } });
      const list = await (await fetch(s.base + taskRoute, { headers })).json() as any;
      expect(list.tasks).toHaveLength(1); expect(list.tasks[0]).toMatchObject({ id: turnId, nativeCompletionCertified: true });
      const rotatedBase = await s.server('rotated-agent-task-owner');
      const rotatedHeaders = { Authorization: 'Bearer rotated-agent-task-owner', 'Content-Type': 'application/json' };
      expect((await (await fetch(rotatedBase + taskRoute, { headers: rotatedHeaders })).json() as any).tasks).toEqual([]);
      expect((await fetch(rotatedBase + taskRoute + '/' + turnId, { headers: rotatedHeaders })).status).toBe(404);
      const events = await (await fetch(s.base + taskRoute + '/' + turnId + '/events?format=json', { headers })).json() as any;
      expect(events.events.map((event: any) => event.type)).toContain('turn.routed');
      expect(events.events.map((event: any) => event.type)).toContain('turn.outcome');
      const modelCallsAfterCompletion = s.counts().modelCalls;
      const replay = await post(s.base, taskRoute, request); expect(replay.status).toBe(202);
      expect((await replay.json() as any).task.id).toBe(turnId); await s.flush();
      expect(s.counts()).toEqual({ modelCalls: modelCallsAfterCompletion, legacyCalls: 0, answerCalls: 0 });

      const pausedResponse = await post(s.base, taskRoute, { version: 1, request: 'Ожидать явного запуска.',
        clientRequestId: 'explicit_agent_paused', conversationId: request.conversationId, autoStart: false });
      const paused = await pausedResponse.json() as any;
      expect(pausedResponse.status, JSON.stringify(paused)).toBe(202);
      await s.flush();
      const pausedDetailResponse = await fetch(s.base + taskRoute + '/' + paused.task.id, { headers });
      const pausedDetail = await pausedDetailResponse.json() as any;
      expect(pausedDetailResponse.status, JSON.stringify({ body: pausedDetail,
        turn: await s.coordinator.getTurn(paused.task.id), jobs: s.scheduler.list(), failures: s.progressionFailures,
        outbox: await s.persistentStore.listPendingOutbox(new Date(Date.now() + 120_000)) })).toBe(200);
      expect(pausedDetail.task).toMatchObject({ id: paused.task.id, status: 'paused', nativeCompletionCertified: false });
      expect(s.counts().modelCalls).toBe(modelCallsAfterCompletion);
      expect((await post(s.base, taskRoute + '/' + paused.task.id + '/cancel', { version: 1 })).status).toBe(200);
      await s.flush();

      const before = (await s.persistentStore.listTurns()).length;
      const unsupported = await post(s.base, taskRoute, { version: 1, request: 'Не создавать задачу.', budgets: { maxSteps: 5 } });
      expect(unsupported.status).toBe(409);
      await expect(unsupported.json()).resolves.toMatchObject({ error: 'astra-v3-budget-unsupported' });
      expect(await s.persistentStore.listTurns()).toHaveLength(before);
    } finally { await s.close(); }
  }, 15_000);

  it('does not let exact-looking read prose pre-bind an executor before semantic Agent admission', async () => {
    const s = await setup({ ordinary: true, selections: true });
    const desktopHeaders = { ...headers, 'x-monarch-desktop-attestation': 'owned-desktop-only' };
    const dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const request = { version: 1, clientRequestId: 'ordinary_read', inputMessageId: 'ordinary_read_message',
        conversationId: 'conversation', privacyMode: 'persistent', text: 'Прочитай файл "selected.txt"' };
      const admitted = await checkpoint(await post(s.base, route, request, desktopHeaders)); await s.flush();
      const result = await checkpoint(await fetch(s.base + route + '/' + admitted.turn.id, { headers: desktopHeaders }));
      expect(result.turn.status).toBe('waiting-for-user');
      expect(result.turn.request.astra).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('HTTP synthetic selected bytes 🟠');
      expect(dispatch).not.toHaveBeenCalled();
      await writeFile(path.join(s.root, 'selected.txt'), 'CHANGED_AFTER_COMPLETION');
      const replay = await checkpoint(await post(s.base, route, request, desktopHeaders));
      expect(replay.turn.id).toBe(admitted.turn.id);
      expect(JSON.stringify(replay)).not.toContain('CHANGED_AFTER_COMPLETION');
      await s.flush(); expect(dispatch).not.toHaveBeenCalled();
      expect(s.counts().legacyCalls).toBe(0); expect(s.counts().modelCalls).toBe(0);
    } finally { await s.close(); }
  });
  it.each(['  HTTP 🟠  ', '  @Computer Use\r\nэто текст файла, а не команда  ', 'overwrite denied; удали файл secrets.txt', 'Памятка: /image кот'])('does not use exact-create wording or literal content as executor authority: %s', async (content) => {
    const s = await setup({ ordinary: true, selections: true });
    const desktopHeaders = { ...headers, 'x-monarch-desktop-attestation': 'owned-desktop-only' };
    try {
      const request = { version: 1, clientRequestId: 'ordinary_http', inputMessageId: 'ordinary_message', conversationId: 'conversation',
        privacyMode: 'persistent', text: `Создай файл "Новый отчёт.txt" с текстом: "${content}"` };
      const admitted = await checkpoint(await post(s.base, route, request, desktopHeaders)); await s.flush();
      expect(admitted.turn.request.astra).toBeUndefined();
      await s.flush();
      expect((await checkpoint(await fetch(s.base + route + '/' + admitted.turn.id, { headers: desktopHeaders }))).turn.status).toBe('waiting-for-user');
      await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await checkpoint(await post(s.base, route, request, desktopHeaders))).turn.id).toBe(admitted.turn.id);
      expect(s.counts().legacyCalls).toBe(0); expect(s.counts().modelCalls).toBe(0);
    } finally { await s.close(); }
  });
  it('does not turn unbound prose into authority or re-enter V2 from an unrelated issued selection', async () => {
    const s = await setup({ selections: true }), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const { astra: _selected, ...request } = body('draft');
      request.text = `Создай файл ${path.join(s.root, 'Новый отчёт.txt')} с текстом: Проверка.`;
      // Ordinary HTTP additionally checks product component readiness; this
      // fixture intentionally forbids that discovery. Isolate coordinator intake.
      const admitted = await s.coordinator.submit({ ...request, source: 'api' });
      await s.flush();
      const result = await checkpoint(await fetch(s.base + route + '/' + admitted.turn.id, { headers }));
      // Preserve both fences: a planner must bind an explicit validated Astra
      // source and must never fall back into the retired V2 Agent Runtime.
      expect(result.turn.request.astra).toBeUndefined();
      expect(s.counts().legacyCalls).toBe(0);
      expect(s.counts().modelCalls).toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
      await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await s.close(); }
  });
  it('progresses three admitted reference tasks autonomously, cancels two and writes only the approved result', async () => {
    const s = await setup({ model: true, references: true, selections: true }), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const request = body('draft'); request.astra.selectionId = s.selectionId;
      request.text = 'Create a summary of the selected material, only after my approval.';
      request.astra.goal = { kind: 'create', target: 'output', content: { kind: 'draft',
        references: [{ selectionId: s.selectionId, target: 'selected' }] } };
      const admitted = await Promise.all(Array.from({ length: 3 }, (_, index) =>
        post(s.base, route, { ...request, clientRequestId: 'batch_request_' + index, inputMessageId: 'batch_message_' + index }).then(checkpoint)));
      const readBatch = () => Promise.all(admitted.map(item => fetch(s.base + route + '/' + item.turn.id, { headers }).then(checkpoint)));
      const waitFor = async (done: (values: OscarTurnCheckpoint[]) => boolean) => {
        const deadline = Date.now() + 25000; let values = await readBatch();
        while (!done(values) && !s.progressionFailures.length && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50)); values = await readBatch();
        }
        expect(s.progressionFailures).toEqual([]);
        expect(done(values), JSON.stringify(values.map(value => ({ status: value.turn.status, outcome: value.turn.outcome })))).toBe(true);
        return values;
      };
      // GET-only observation: no test-side drain/wake can hide a stalled host.
      const pending = await waitFor(values => values.every(value => value.turn.status === 'waiting-for-approval'));
      expect(s.openings()).toBe(3); expect(dispatch).toHaveBeenCalledTimes(6);
      await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const item of pending.slice(1)) expect((await post(s.base, route + '/' + item.turn.id + '/cancel', { version: 1 })).status).toBe(200);
      await waitFor(values => values.slice(1).every(value => value.turn.status === 'cancelled'));
      const first = pending[0]!, approval = eventPayload(first, 'approval.required');
      expect((await post(s.base, route + '/' + first.turn.id + '/astra-input', { ...context(first.turn), input: { kind: 'decide', decision: {
        approvalId: approval.id, approvalDigest: approval.digest, messageId: 'batch_approval', decision: 'approve' } } })).status).toBe(200);
      const final = await waitFor(values => values[0]!.turn.status === 'succeeded');
      expect(final.slice(1).every(value => value.turn.status === 'cancelled')).toBe(true);
      expect(final[0]!.turn.outcome?.kind).toBe('partial'); expect(s.openings()).toBe(3);
      expect(dispatch).toHaveBeenCalledTimes(7); expect(s.counts().legacyCalls).toBe(0); expect(s.counts().answerCalls).toBe(0);
      expect(await readFile(path.join(s.root, 'Новый отчёт.txt'), 'utf8')).toBe(approval.content);
    } finally { await s.close(); }
  }, 45000);
  it('recovers a host fault by exact durable HTTP wake, without generation, approval or duplicate intent', async () => {
    const s = await setup({ model: true }), dispatch = vi.spyOn(s.kernel, 'executeActionProposal'), wake = vi.spyOn(s.bridge, 'wake');
    try {
      const admitted = await checkpoint(await post(s.base, route, body('draft'))); await s.flush();
      let cp = await checkpoint(await fetch(s.base + route + '/' + admitted.turn.id, { headers }));
      expect(cp.turn.status).toBe('waiting-for-approval'); const approval = eventPayload(cp, 'approval.required');
      s.progressFault(true); await s.facade.drain(); await s.coordinator.reconcileAstraTurn(cp.turn.id);
      const latestIssue = (value: OscarTurnCheckpoint) => value.events.filter(event => event.payload.astraProjection).at(-1)?.payload.runtimeIssue;
      cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers })); expect(latestIssue(cp)).toBe('progression-failed');
      s.progressFault(false);
      cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers })); expect(latestIssue(cp)).toBe('progression-failed');
      const endpoint = route + '/' + cp.turn.id + '/astra-recover', request = { ...context(cp.turn), requestId: 'same_recovery' };
      expect((await post(s.base, endpoint, { ...request, inputMessageId: 'foreign_message' })).status).toBe(409);
      expect((await post(s.base, endpoint, { ...request, conversationId: 'foreign_chat' })).status).toBe(409);
      expect((await post(s.base, endpoint, { ...request, confirmed: true })).status).toBe(400);
      const foreignBase = await s.server('other-actor');
      expect((await post(foreignBase, endpoint, request, { ...headers, Authorization: 'Bearer other-actor' })).status).toBe(404);
      const disabledBase = await s.server(token, false); expect((await post(disabledBase, endpoint, request)).status).toBe(404);
      expect(wake).not.toHaveBeenCalled();
      const concurrent = await Promise.all([post(s.base, endpoint, request), post(s.base, endpoint, request)]);
      expect(concurrent.map(response => response.status)).toEqual([200, 200]);
      for (let i = 0; i < 80; i++) {
        cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers }));
        if (!latestIssue(cp) && wake.mock.calls.length) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(latestIssue(cp)).toBeUndefined(); expect(cp.turn.astraRecoveryRequests).toEqual(['same_recovery']);
      expect(wake).toHaveBeenCalledTimes(1); expect(eventPayload(cp, 'approval.required').digest).toBe(approval.digest);
      expect(s.openings()).toBe(1); expect(dispatch).toHaveBeenCalledTimes(1);
      const reloaded = new LocalJsonOscarTurnStore(path.join(s.root, 'turns.json'));
      expect((await reloaded.getTurn(cp.turn.id))!.turn.astraRecoveryRequests).toEqual(['same_recovery']);
      await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (let i = 1; i < 8; i++) expect((await post(s.base, endpoint, { ...request, requestId: 'recovery_' + i })).status).toBe(200);
      expect((await post(s.base, endpoint, { ...request, requestId: 'recovery_9' })).status).toBe(409);
      expect((await post(s.base, endpoint, request)).status).toBe(200); // Exact replay is still allowed at the cap.
      await s.flush(); expect(s.openings()).toBe(1); expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  }, 15000);

  it.each(['pause', 'cancel'] as const)('explicit recovery preserves durable %s and never resumes by itself', async command => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      let cp = await checkpoint(await post(s.base, route, body('literal'))); await s.flush();
      cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers }));
      const approval = eventPayload(cp, 'approval.required');
      expect((await post(s.base, route + '/' + cp.turn.id + '/' + command, command === 'cancel' ? { version: 1 } : context(cp.turn))).status).toBe(200);
      await s.flush();
      expect((await post(s.base, route + '/' + cp.turn.id + '/astra-recover', { ...context(cp.turn), requestId: 'wake_preserve_control' })).status).toBe(200);
      await s.flush(); cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers }));
      expect(cp.turn.astraControl?.desired).toBe(command); expect(dispatch).toHaveBeenCalledTimes(1);
      await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (command === 'pause') {
        const input = { kind: 'decide', decision: { approvalId: approval.id, approvalDigest: approval.digest, messageId: 'paused_decision', decision: 'approve' } };
        expect((await post(s.base, route + '/' + cp.turn.id + '/astra-input', { ...context(cp.turn), input })).status).toBe(200);
        await s.flush(); expect(dispatch).toHaveBeenCalledTimes(1);
        await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else expect(cp.turn.status).toBe('cancelled');
    } finally { await s.close(); }
  }, 15000);

  it.each(['approve', 'revoke'] as const)('runs a selected reference through real Oscar HTTP and gates the result (%s)', async mode => {
    const s = await setup({ model: true, references: true, selections: true }), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const request = body('draft'); request.astra.selectionId = s.selectionId;
      const reference = s.selections!.issue({ actor, conversationId: 'conversation', requestId: 'separate_reference', ttlMs: 3600000,
        targets: [{ id: 'selected', relativePath: 'selected.txt', access: 'observe', maxBytes: 4096, timeoutMs: 1000 }] });
      // Explicit write wording must NOT bypass source-required result review.
      request.text = 'Create the selected output file by summarizing the selected material, after my approval.';
      request.astra.goal = { kind: 'create', target: 'output', content: { kind: 'draft',
        references: [{ selectionId: reference.selectionId, target: 'selected' }] } };
      const admitted = await checkpoint(await post(s.base, route, request)); await s.flush();
      let cp = await checkpoint(await fetch(s.base + route + '/' + admitted.turn.id, { headers }));
      expect(cp.turn.status, JSON.stringify({ status: cp.turn.status, progressionFailures: s.progressionFailures })).toBe('waiting-for-approval');
      expect(dispatch).toHaveBeenCalledTimes(2); expect(s.openings()).toBe(1);
      expect(s.preparedSurfaces.at(-1)).toContain('HTTP synthetic selected bytes 🟠');
      await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const approval = eventPayload(cp, 'approval.required');
      const input = { kind: 'decide', decision: { approvalId: approval.id, approvalDigest: approval.digest, messageId: 'reference_approval', decision: 'approve' } };
      if (mode === 'revoke') {
        s.selections!.revoke(reference.selectionId, { actor, conversationId: 'conversation' }); await s.flush();
        expect((await post(s.base, route + '/' + cp.turn.id + '/astra-input', { ...context(cp.turn), input })).status).toBeGreaterThanOrEqual(400);
        await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(dispatch).toHaveBeenCalledTimes(2);
      } else {
        expect((await post(s.base, route + '/' + cp.turn.id + '/astra-input', { ...context(cp.turn), input })).status).toBe(200);
        await s.flush(); cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers }));
        expect(cp.turn.status, JSON.stringify(cp)).toBe('succeeded'); expect(cp.turn.outcome?.kind).toBe('partial');
        expect(await readFile(path.join(s.root, 'Новый отчёт.txt'), 'utf8')).toBe(approval.content);
        expect(dispatch).toHaveBeenCalledTimes(3);
        expect((await s.delivered()).at(-1)!.requiredPreviousMessageId).toBe('reference_approval');
      }
      expect(s.openings()).toBe(1); expect(s.counts().legacyCalls).toBe(0); expect(s.counts().answerCalls).toBe(0);
    } finally { await s.close(); }
  }, 15000);

  it('lists only the authenticated owner selection and never accepts HTTP path issuance', async () => {
    const s = await setup({ selections: true }), selectionRoute = '/api/oscar/astra/selections';
    try {
      const response = await fetch(s.base + selectionRoute + '?conversationId=conversation', { headers }); expect(response.status).toBe(200);
      const list = await response.json(); expect(list.selections).toHaveLength(1); expect(list.selections[0].selectionId).toBe(s.selectionId);
      expect(JSON.stringify(list)).not.toContain(s.root); expect(JSON.stringify(list)).not.toContain(actor.id);
      const other = await s.server('other-actor'), auth = { Authorization: 'Bearer other-actor', 'Content-Type': 'application/json' };
      expect((await (await fetch(other + selectionRoute + '?conversationId=conversation', { headers: auth })).json()).selections).toEqual([]);
      expect((await post(other, selectionRoute + '/' + s.selectionId + '/revoke', { version: 1, conversationId: 'conversation' }, auth)).status).toBe(404);
      expect((await post(s.base, selectionRoute, { version: 1, path: 'C:/Safe' })).status).toBe(404);
      const disabled = await s.server(token, false);
      expect((await fetch(disabled + selectionRoute + '?conversationId=conversation', { headers })).status).toBe(404);
      expect((await fetch(s.base + selectionRoute + '?conversationId=conversation&conversationId=other', { headers })).status).toBe(400);
      expect(await s.persistentStore.listTurns()).toHaveLength(0);
    } finally { await s.close(); }
  });
  it('revokes a pending exact create through HTTP and wakes the same host without writing the file', async () => {
    const s = await setup({ selections: true }), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const request = body('literal'); request.astra.selectionId = s.selectionId;
      const cp = await checkpoint(await post(s.base, route, request)); await s.flush();
      expect((await s.coordinator.getTurn(cp.turn.id))!.turn.status).toBe('waiting-for-approval');
      expect(dispatch).toHaveBeenCalledTimes(1);
      const revoked = await post(s.base, '/api/oscar/astra/selections/' + s.selectionId + '/revoke', { version: 1, conversationId: 'conversation' });
      expect(revoked.status).toBe(200); await s.flush();
      expect(dispatch).toHaveBeenCalledTimes(1); await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const current = (await s.coordinator.getTurn(cp.turn.id))!.turn; expect(['cancelled', 'blocked']).toContain(current.status);
      const list = await (await fetch(s.base + '/api/oscar/astra/selections?conversationId=conversation', { headers })).json(); expect(list.selections).toEqual([]);
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
    } finally { await s.close(); }
  });
  it('executes a model-free read without model/onboarding discovery and preserves exact source text', async () => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const request = { ...body(), text: '  Прочитай\n  выбранный файл. 🟠  ' };
      const admitted = await checkpoint(await post(s.base, route, request)); await s.flush();
      const cp = await checkpoint(await fetch(s.base + route + '/' + admitted.turn.id, { headers }));
      expect(cp.turn.status).toBe('succeeded'); expect(cp.turn.request.text).toBe(request.text); expect(cp.turn.outcome?.kind).toBe('partial');
      expect(cp.turn.request.astra!.actor).toEqual(actor); expect(dispatch).toHaveBeenCalledTimes(1);
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
      expect(new Set(s.appAccess.mock.calls.map(call => call[1]))).toEqual(new Set(['getOwnerDevSettings', 'oscarTurnCoordinator']));
      expect((await checkpoint(await post(s.base, route, request))).turn.id).toBe(cp.turn.id); await s.flush(); expect(dispatch).toHaveBeenCalledTimes(1);
      const stream = await fetch(s.base + route + '/' + cp.turn.id + '/events', { headers: { ...headers, Accept: 'text/event-stream' } });
      expect(stream.status).toBe(200); const events = await stream.text(); expect(events).toContain('event: turn.outcome'); expect(events).toContain('"nativeCompletionCertified":false');
    } finally { await s.close(); }
  });
  it('keeps default-off, token-disabled and actor-mismatched submissions from creating any Turn', async () => {
    const s = await setup();
    try {
      const disabled = await s.server(token, false); expect((await post(disabled, route, body())).status).toBe(404);
      const noAuth = await s.server(token, true, false); expect((await post(noAuth, route, body(), { Authorization: '', 'Content-Type': 'application/json' })).status).toBe(401);
      const rotated = await s.server('rotated-token'); expect((await post(rotated, route, body(), { Authorization: 'Bearer rotated-token', 'Content-Type': 'application/json' })).status).toBe(403);
      // Admission itself checks the actor, even if a custom host port neglects
      // the optional authenticated-actor argument.
      const bind = s.bridge.bind.bind(s.bridge); vi.spyOn(s.bridge, 'bind').mockImplementation((turn, selection) => bind(turn, selection));
      expect((await post(rotated, route, body(), { Authorization: 'Bearer rotated-token', 'Content-Type': 'application/json' })).status).toBe(403);
      expect(await s.persistentStore.listTurns()).toHaveLength(0); expect(s.counts().modelCalls).toBe(0);
    } finally { await s.close(); }
  });
  it('retains the ordinary model-onboarding gate and rejects malformed UTF-8 instead of rewriting source bytes', async () => {
    const s = await setup();
    try {
      s.legacyGate(); const ordinary = { version: 1, clientRequestId: 'ordinary', conversationId: 'conversation', text: 'Привет' };
      const response = await post(s.base, route, ordinary); expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('required-model-not-ready');
      const raw = JSON.stringify({ ...body(), text: 'BADBYTE' }).split('BADBYTE');
      const invalid = Buffer.concat([Buffer.from(raw[0]!), Buffer.from([255]), Buffer.from(raw[1]!)]);
      const malformed = await fetch(s.base + route, { method: 'POST', headers, body: invalid });
      expect(malformed.status).toBe(400); expect((await malformed.json()).error).toBe('invalid-json');
      expect(await s.persistentStore.listTurns()).toHaveLength(0);
    } finally { await s.close(); }
  });
  it('blocks forged source/actor/permissions, unsupported privacy and zero retention before work', async () => {
    const s = await setup();
    try {
      for (const request of [{ ...body(), surface: 'desktop' }, { ...body(), astraActor: actor }, { ...body(), confirmed: true },
        { ...body(), astra: { ...body().astra, actor } }, { ...body(), privacyMode: 'incognito' }])
        expect((await post(s.base, route, request)).status).toBeGreaterThanOrEqual(400);
      s.zeroRetention(); expect((await post(s.base, route, body())).status).toBe(409);
      expect(await s.persistentStore.listTurns()).toHaveLength(0);
    } finally { await s.close(); }
  });
  it('does not expose or cancel old actor tasks through get/list/events/client-request aliases', async () => {
    const s = await setup();
    try {
      const admitted = await checkpoint(await post(s.base, route, body('literal'))); await s.flush();
      const rotated = await s.server('other-actor'), auth = { Authorization: 'Bearer other-actor', 'Content-Type': 'application/json' };
      for (const suffix of ['/' + admitted.turn.id, '/' + admitted.turn.id + '/events?format=json', '?clientRequestId=source_request'])
        expect((await fetch(rotated + route + suffix, { headers: auth })).status).toBe(404);
      const list = await (await fetch(rotated + route, { headers: auth })).json(); expect(list.turns).toEqual([]);
      expect((await post(rotated, route + '/' + admitted.turn.id + '/cancel', { version: 1 }, auth)).status).toBe(404);
      expect((await post(rotated, '/api/oscar/turn-cancellations', { version: 1, clientRequestId: 'source_request' }, auth)).status).toBe(404);
      // The Turn may become visible between HTTP's lookup and the coordinator's
      // atomic reservation path. It must not infer the newly found victim actor.
      const lookup = vi.spyOn(s.coordinator, 'findTurnByClientRequestId'); lookup.mockResolvedValueOnce(null);
      expect((await post(rotated, '/api/oscar/turn-cancellations', { version: 1, clientRequestId: 'source_request' }, auth)).status).toBe(403);
      lookup.mockRestore();
      expect((await s.coordinator.getTurn(admitted.turn.id))!.turn.status).toBe('waiting-for-approval');
    } finally { await s.close(); }
  });
  it.each([false, true])('binds pre-admission cancellation to the Astra actor (typed=%s)', async typed => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      expect((await post(s.base, '/api/oscar/turn-cancellations', { version: 1, clientRequestId: 'source_request', ...(typed ? { astra: true } : {}) })).status).toBe(200);
      const admitted = await checkpoint(await post(s.base, route, body())); await s.flush();
      expect((await s.coordinator.getTurn(admitted.turn.id))!.turn.status).toBe(typed ? 'cancelled' : 'succeeded');
      expect(dispatch).toHaveBeenCalledTimes(typed ? 0 : 1);
    } finally { await s.close(); }
  });
  it('keeps legacy and actor-specific cancellation reservations separate for the same request', async () => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      expect((await post(s.base, '/api/oscar/turn-cancellations', { version: 1, clientRequestId: 'source_request' })).status).toBe(200);
      expect((await post(s.base, '/api/oscar/turn-cancellations', { version: 1, clientRequestId: 'source_request', astra: true })).status).toBe(200);
      const admitted = await checkpoint(await post(s.base, route, body())); await s.flush();
      expect((await s.coordinator.getTurn(admitted.turn.id))!.turn.status).toBe('cancelled'); expect(dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('cannot cancel a future task by reserving its client ID under another authenticated actor', async () => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const other = await s.server('other-actor');
      expect((await post(other, '/api/oscar/turn-cancellations', { version: 1, clientRequestId: 'source_request', astra: true },
        { Authorization: 'Bearer other-actor', 'Content-Type': 'application/json' })).status).toBe(200);
      const admitted = await checkpoint(await post(s.base, route, body())); await s.flush();
      expect((await s.coordinator.getTurn(admitted.turn.id))!.turn.status).toBe('succeeded'); expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('accepts empty literal input over HTTP, keeps pause effective through approval, then resumes once', async () => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      let cp = await checkpoint(await post(s.base, route, body('reply'))); await s.flush();
      cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers })); const question = eventPayload(cp, 'user.input.required');
      const reply = { kind: 'reply', reply: { requestId: 'empty_reply', questionId: question.id, questionDigest: question.digest, messageId: 'empty_content', text: '' } };
      expect((await post(s.base, route + '/' + cp.turn.id + '/astra-input', { ...context(cp.turn), input: reply })).status).toBe(200); await s.flush();
      cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers })); const approval = eventPayload(cp, 'approval.required');
      expect((await post(s.base, route + '/' + cp.turn.id + '/pause', context(cp.turn))).status).toBe(200); await s.flush();
      const decision = { kind: 'decide', decision: { approvalId: approval.id, approvalDigest: approval.digest, messageId: 'empty_approval', decision: 'approve' } };
      expect((await post(s.base, route + '/' + cp.turn.id + '/astra-input', { ...context(cp.turn), input: { ...decision, confirmed: true } })).status).toBe(400);
      expect((await post(s.base, route + '/' + cp.turn.id + '/astra-input', { ...context(cp.turn), input: decision })).status).toBe(200); await s.flush();
      expect(dispatch).toHaveBeenCalledTimes(1); await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await post(s.base, route + '/' + cp.turn.id + '/resume', context(cp.turn))).status).toBe(200); await s.flush();
      expect(dispatch).toHaveBeenCalledTimes(2); expect(await readFile(path.join(s.root, 'Новый отчёт.txt'), 'utf8')).toBe('');
      expect((await s.delivered()).at(-1)!.requiredPreviousMessageId).toBe('empty_approval'); expect(s.counts().modelCalls).toBe(0);
    } finally { await s.close(); }
  });
  it.each([false, true])('runs a sealed model draft through HTTP -> coordinator -> approval -> real Kernel (clarify=%s)', async ask => {
    const s = await setup({ model: true, ask }), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const admitted = await checkpoint(await post(s.base, route, body('draft'))); await s.flush();
      let cp = await checkpoint(await fetch(s.base + route + '/' + admitted.turn.id, { headers }));
      if (ask) {
        expect(cp.turn.status).toBe('waiting-for-user'); expect(dispatch).not.toHaveBeenCalled();
        const question = eventPayload(cp, 'user.input.required');
        const input = { kind: 'reply', reply: { requestId: 'reply_request', questionId: question.id, questionDigest: question.digest, messageId: 'draft_guidance', text: 'Краткий отчёт 🟠' } };
        const response = await post(s.base, route + '/' + cp.turn.id + '/astra-input', { ...context(cp.turn), input });
        expect(response.status, await response.text()).toBe(200); await s.flush();
        cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers }));
      }
      expect(cp.turn.status, JSON.stringify(cp)).toBe('waiting-for-approval'); expect(dispatch).toHaveBeenCalledTimes(1);
      const approval = eventPayload(cp, 'approval.required'); expect(approval.content).toBe('Согласованный черновик 🟠');
      const input = { kind: 'decide', decision: { approvalId: approval.id, approvalDigest: approval.digest, messageId: 'draft_approval', decision: 'approve' } };
      expect((await post(s.base, route + '/' + cp.turn.id + '/astra-input', { ...context(cp.turn), inputMessageId: 'wrong_source', input })).status).toBe(409);
      expect((await post(s.base, route + '/' + cp.turn.id + '/astra-input', { ...context(cp.turn), input })).status).toBe(200);
      await s.flush(); cp = await checkpoint(await fetch(s.base + route + '/' + cp.turn.id, { headers }));
      expect(cp.turn.status).toBe('succeeded'); expect(cp.turn.outcome?.kind).toBe('partial'); expect(dispatch).toHaveBeenCalledTimes(2);
      expect(await readFile(path.join(s.root, 'Новый отчёт.txt'), 'utf8')).toBe('Согласованный черновик 🟠');
      expect(s.openings()).toBe(ask ? 2 : 1); expect(s.counts().legacyCalls).toBe(0); expect(s.counts().answerCalls).toBe(0);
      expect((await s.delivered()).at(-1)!.requiredPreviousMessageId).toBe('draft_approval');
    } finally { await s.close(); }
  }, 15000);
});
