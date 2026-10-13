import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AstraJournal, type AstraJournalAtomicCommit } from '../../src/agent-v3/journal';
import { AstraPreparedModelClient } from '../../src/agent-v3/prepared-model-client';
import { AstraWorkScheduler } from '../../src/agent-v3/work-scheduler';
import { MonarchKernel } from '../../src/core/kernel';
import { WorkspaceModule } from '../../src/modules/workspace';
import type { MonarchApplication } from '../../src/app/application';
import { createMonarchHttpServer } from '../../src/app/http-server';
import { MonarchAstraTaskFacade, type AstraTaskHttpTask } from '../../src/app/astra-task-facade';
import { AstraSourceGoalCompiler, type AstraSourceGoalInput, type AstraSelectedTargetSnapshot } from '../../src/app/astra-source-goal-compiler';
import { compiledFixtureTargets, compiledFixtureRequest, compiledFixtureContent } from '../fixtures/agent-v3/application-source-contract';
import { approvalFixtureRequest, approvalFixtureTargets } from '../fixtures/agent-v3/application-approval-contract';
import { createApprovalAnswerId, type AstraCreateApprovalAnswer } from '../../src/agent-v3/create-approval';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';
import { fixtureRequest, createSelection, readSelection, literalContent, draftContent, type FixtureTaskKind } from '../fixtures/agent-v3/application-create-contract';

const marker = 'astra-v3-prepared-model-synthetic-only', apiToken = 'owned-create-api', desktopToken = 'owned-create-desktop';
const headers = { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' };
const modelHeaders = { Authorization: 'Bearer astra-synthetic-test', 'Content-Type': 'application/json' };
const route = '/api/astra/v3/create-tasks', readRoute = '/api/astra/v3/read-tasks';
let parent: string, fixture: string, processHost: ChildProcessWithoutNullStreams, sequence = 0;
let host: { marker: string; endpoint: string; hostGeneration: string; modelDigest: string };
beforeAll(async () => {
  parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  fixture = await realpath(await mkdtemp(path.join(parent, 'astra-v3-prepared-model-'))); expect(path.dirname(fixture)).toBe(parent);
  await writeFile(path.join(fixture, '.fixture-marker'), marker, { flag: 'wx' });
  processHost = spawn(path.resolve('oscar/.venv/Scripts/python.exe'), ['-B', path.resolve('tests/fixtures/agent-v3/model-server.py'), fixture],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }); processHost.stdin.end();
  host = await new Promise((resolve, reject) => {
    let stdout = '', stderr = ''; const timer = setTimeout(() => reject(Error('create-http-host-timeout')), 15000);
    processHost.once('error', error => { clearTimeout(timer); reject(error); });
    processHost.once('exit', code => { clearTimeout(timer); reject(Error('create-http-host-exit:' + code + ':' + stderr)); });
    processHost.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-8192); });
    processHost.stdout.on('data', data => { stdout += String(data);
      if (stdout.length > 32768) { clearTimeout(timer); reject(Error('create-http-host-stdout')); return; }
      if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))); } catch (error) { reject(error); } }
    });
  }); expect(host.marker).toBe(marker);
}, 20000);
afterAll(async () => {
  if (processHost && processHost.exitCode === null && processHost.signalCode === null) {
    const exited = new Promise<void>(resolve => processHost.once('exit', () => resolve())); processHost.kill(); await exited;
  }
  if (!fixture) return; expect(await realpath(fixture)).toBe(fixture); expect(path.dirname(fixture)).toBe(parent);
  expect(path.basename(fixture).startsWith('astra-v3-prepared-model-')).toBe(true);
  expect(await readFile(path.join(fixture, '.fixture-marker'), 'utf8')).toBe(marker); await rm(fixture, { recursive: true, force: false });
});
const post = (base: string, pathname: string, body: unknown, auth: Record<string, string> = headers) => fetch(base + pathname, { method: 'POST', headers: auth, body: JSON.stringify(body) });
const context = (kind: FixtureTaskKind) => { const request = fixtureRequest(kind); return { version: 1, conversationId: request.conversationId, inputMessageId: request.inputMessageId }; };
const query = (kind: FixtureTaskKind) => { const source = context(kind); return '?' + new URLSearchParams({ conversationId: source.conversationId, inputMessageId: source.inputMessageId }); };
async function task(response: Response): Promise<AstraTaskHttpTask> { const body = await response.json() as { task?: AstraTaskHttpTask }; expect(body.task).toBeDefined(); return body.task!; }
const hasEvent = (input: AstraJournalAtomicCommit, type: string) => [input.primary, ...(input.additional ?? [])].some(item => item.events.some(event => (event as { type?: string }).type === type));
async function setup(input: { compiler?: boolean; approvalTargets?: boolean; literalApprovals?: boolean; compositeApprovals?: boolean; requiredInputs?: boolean; askFirst?: boolean; wrong?: boolean; block?: boolean; readonly?: boolean; file?: string; root?: string; scopeId?: string; start?: boolean; noCatalog?: boolean } = {}) {
  // Independent tests must respect the real host's finite replay fence, not evict
  // active/retained turns or raise product limits when this suite exceeds32turns.
  const deadline = Date.now() + 6500;
  while ((await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { retainedTurns: number }).retainedTurns >= 24) {
    if (Date.now() >= deadline) throw Error('owned-http-retirement-timeout'); await new Promise(resolve => setTimeout(resolve, 100));
  }
  const root = input.root ?? path.join(fixture, 'workspace_' + sequence++); if (!input.root) { await mkdir(root); await writeFile(path.join(root, 'selected.txt'), 'owned observation', { flag: 'wx' }); }
  const journal = new AstraJournal(input.file ?? ':memory:'), scopeId = input.scopeId ?? 'create_http_' + sequence++;
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: { sandboxMode: input.readonly ? 'read-only' : 'workspace-write', approvalPolicy: 'never' } });
  const workspace = new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] }); kernel.registerModule(workspace); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
  // Observe recovery from BEFORE host.start(): startup may complete literal work
  // before the HTTP listener exists. Installing spies later undercounts effects.
  const dispatch = vi.spyOn(kernel, 'executeActionProposal'), writes = vi.spyOn(workspace, 'executeCapability');
  let calls = 0, revoked = false, openings = 0;
  const catalog = { resolve: vi.fn(readSelection) }, createCatalog = { resolve: vi.fn((id, source) => {
    if (revoked || input.noCatalog) throw Error('owned-create-source-revoked'); return createSelection(id, source);
  }) };
  const selectedTargets: AstraSelectedTargetSnapshot = input.approvalTargets ? approvalFixtureTargets() : compiledFixtureTargets();
  const targetPort = { resolve: vi.fn(() => { if (revoked || input.noCatalog) throw Error('owned-target-revoked'); return structuredClone(selectedTargets); }) };
  const transport: typeof fetch = async (url, init) => {
    calls++;
    if (String(url).endsWith('/model-turns') && init?.method === 'POST') {
      const opening = JSON.parse(String(init.body)), read = JSON.stringify(opening.responseSchema).includes('"read"');
      const output = input.askFirst && openings++ === 0 ? { kind: 'ask-user', question: 'What should the file contain?' }
        : read ? { kind: 'read', requirementId: 'first', capabilityHandle: 'read_first', targetHandle: 'target_first' }
        : { kind: 'create', requirementId: 'draft_file', capabilityHandle: 'create_file', targetHandle: 'selected_file', content: input.wrong ? 'WRONG' : draftContent };
      const configured = await fetch(host.endpoint + '/__fixture/control', { method: 'POST', headers: modelHeaders,
        body: JSON.stringify({ output: JSON.stringify(output), finish: 'stop', block: input.block ?? false }) }); expect(configured.status).toBe(200);
    }
    return fetch(url, init);
  };
  const options = { deployment: 'isolated-validation' as const, canonicalRoot: root, scopeId, journal, kernel,
    ...(input.compiler ? { sourceCompiler: new AstraSourceGoalCompiler(targetPort) } : { catalog, createCatalog }),
    requiredInputs: input.requiredInputs ?? false,
    literalApprovals: input.literalApprovals ?? false,
    compositeApprovals: input.compositeApprovals ?? false,
    client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: host.endpoint, hostGeneration: host.hostGeneration,
      bearerToken: 'astra-synthetic-test', fetch: transport, timeoutMs: 10000 }),
    policy: { expectedModelDigest: host.modelDigest, maxOutputTokens: 256, modelTimeoutMs: 5000, contextLimits: { tokenizerTimeoutMs: 1000 } } };
  const facade = new MonarchAstraTaskFacade(options), scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', scopeId, journal,
    adapters: facade.adapters, limits: { activationTimeoutMs: 5000, leaseMs: 1000, kernelSlots: 1 } }); facade.attach(scheduler);
  if (input.start !== false) { facade.start(); await facade.drain(); }
  const appAccess = vi.fn(() => { throw Error('ordinary-application-access-forbidden'); }), app = new Proxy({} as MonarchApplication, { get: appAccess });
  const servers: Server[] = [];
  async function http(mode: 'unified' | 'legacy' | 'disabled' = 'unified', token = apiToken) {
    const server = createMonarchHttpServer({ app, publicDirectory: root, host: '127.0.0.1', port: 4317, apiToken: token,
      desktopAttestationToken: desktopToken, requireApiToken: true, allowNonLoopbackMutations: false,
      ...(mode === 'unified' ? { astraTasks: facade } : mode === 'legacy' ? { astraReadTasks: facade } : {}) }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  }
  const base = await http(); let closed = false;
  const release = async () => { await fetch(host.endpoint + '/__fixture/release', { method: 'POST', headers: modelHeaders }); };
  return { root, journal, kernel, facade, scheduler, options, base, http, dispatch, writes, appAccess, catalog, createCatalog, selectedTargets, targetPort, release,
    calls: () => calls, revoke: () => { revoked = true; }, close: async () => {
      if (closed) return; closed = true; await release(); if (facade.hostStatus().phase === 'running') await facade.drain();
      await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
      await facade.stop(); await kernel.stop(); journal.close(); dispatch.mockRestore(); writes.mockRestore();
    } };
}

describe('Unified isolated Application read/literal/draft HTTP tasks', () => {
  const compiledRequest = (goal: AstraSourceGoalInput, suffix = 'compiled') => ({ ...fixtureRequest('literal'), selectionId: 'selected_targets', goal,
    clientRequestId: 'request_' + suffix, inputMessageId: 'message_' + suffix, text: 'Обработай выбранную цель согласно явно заданному действию.' });
  const sourceContext = (request: ReturnType<typeof compiledRequest>) => ({ conversationId: request.conversationId, inputMessageId: request.inputMessageId });

  it.each([['approval-reply', 'approval-pending'], ['approval-reply', 'approval-answered'], ['approval-reply', 'approval-effect'],
    ['approval-reply', 'approval-certified'], ['approval-reply', 'approval-unrecorded'], ['approval-draft', 'approval-answered'],
    ['approval-draft', 'approval-certified']] as const)('restores composite approval HTTP after actual exit68 (%s/%s)', async (kind, stage) => {
    const root = path.join(fixture, 'workspace_' + sequence++); await mkdir(root);
    const scopeId = 'approval_crash_' + sequence++, file = path.join(root, 'owned-http.sqlite');
    const worker = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-v3/application-create-worker.ts', fixture, path.basename(root), scopeId,
      kind, stage, host.endpoint, host.hostGeneration, host.modelDigest], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TEMP: fixture, TMP: fixture, TSX_DISABLE_CACHE: '1' } });
    const crashed = await new Promise<{ taskId: string; calls: number; dispatches: number }>((resolve, reject) => {
      let stdout = '', stderr = '', timedOut = false; const timer = setTimeout(() => { timedOut = true; worker.kill(); }, 15000);
      worker.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 8192) worker.kill(); });
      worker.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
      worker.once('error', error => { clearTimeout(timer); reject(error); }); worker.once('close', code => { clearTimeout(timer);
        if (timedOut || code !== 68) return reject(Error('approval-http-crash:' + code + ':' + stderr));
        try { const result = JSON.parse(stdout.trim()); expect(result.marker).toBe('owned-create-http-crash'); resolve(result); } catch (error) { reject(error); }
      });
    });
    const probe = new AstraJournal(file), expiry = (probe.read('scheduler_' + scopeId)!.checkpoint as { expiresAt: number }).expiresAt; probe.close();
    expect(expiry - Date.now()).toBeLessThanOrEqual(1100); await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry - Date.now() + 20)));
    const s = await setup({ root, scopeId, file, compiler: true, approvalTargets: true, compositeApprovals: true, requiredInputs: true,
      noCatalog: stage === 'approval-certified' });
    try {
      await s.facade.drain(); const request = approvalFixtureRequest(kind), context = { conversationId: request.conversationId, inputMessageId: request.inputMessageId };
      const item = route + '/' + crashed.taskId, get = () => fetch(s.base + item + '?' + new URLSearchParams(context), { headers });
      let view = await task(await get());
      const record = s.journal.read(crashed.taskId)!.checkpoint as { effectTaskId: string };
      const oldAnswer = s.journal.read(createApprovalAnswerId(record.effectTaskId))?.checkpoint as unknown as AstraCreateApprovalAnswer | undefined;
      const approval = view.approval ?? oldAnswer!.challenge;
      const decision = { version: 1, ...context, approvalId: approval.id, approvalDigest: approval.digest, replyMessageId: 'approval_message', decision: 'approve' };
      expect((await post(s.base, item + '/decide', decision)).status).toBe(200); await s.facade.drain(); view = await task(await get());
      expect(s.calls()).toBe(0); if (kind === 'approval-reply') expect(crashed.calls).toBe(0); else expect(crashed.calls).toBeGreaterThan(0);
      expect(s.writes).toHaveBeenCalledTimes(['approval-pending', 'approval-answered'].includes(stage) ? 1 : 0);
      expect(crashed.dispatches + s.dispatch.mock.calls.length).toBe(2);
      expect(await readFile(path.join(root, 'Новый отчёт.txt'), 'utf8')).toBe(compiledFixtureContent);
      if (stage === 'approval-unrecorded') {
        expect(view.status).toBe('indeterminate'); expect(view.message).toBeUndefined();
        expect((await task(await post(s.base, item + '/reconcile', { version: 1, ...context }))).status).toBe('indeterminate');
        const recoveryDeadline = Date.now() + 3_000;
        while (s.facade.hostStatus().issue !== 'recovery-required' && Date.now() < recoveryDeadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(s.dispatch).not.toHaveBeenCalled(); expect(s.facade.hostStatus()).toMatchObject({
          issue: 'recovery-required', recoveryScheduled: false,
        });
      } else {
        expect(view.status).toBe(kind === 'approval-reply' ? 'completed' : 'partial'); expect(view.message?.predecessorMessageId).toBe('approval_message');
        expect((await post(s.base, item + '/ack', { version: 1, ...context, certificateDigest: view.message!.certificateDigest })).status).toBe(200);
        expect((await task(await post(s.base, item + '/decide', decision))).message?.delivery).toBe('acknowledged');
      }
      if (stage === 'approval-certified') expect(s.targetPort.resolve).not.toHaveBeenCalled();
    } finally { await s.close(); }
  }, 25000);

  it.each(['reply', 'draft', 'draft-clarification', 'reject'] as const)('binds composite HTTP approval separately from content (%s)', async mode => {
    const literal = mode === 'reply' || mode === 'reject', s = await setup({ compiler: true, compositeApprovals: true, requiredInputs: true, askFirst: mode === 'draft-clarification' });
    const progressErrors: string[] = [], progress = (s.facade as any).progress.bind(s.facade);
    (s.facade as any).progress = async () => { try { return await progress(); } catch (error) { progressErrors.push(String(error)); throw error; } };
    try {
      s.selectedTargets.targets.find(target => target.id === 'new_file')!.relativePath = 'Новый отчёт.txt';
      const request = compiledRequest({ kind: 'create', target: 'new_file', content: { kind: literal ? 'reply' : 'draft' } }, 'composite');
      const initial = await task(await post(s.base, route, request)); await s.facade.drain();
      const item = route + '/' + initial.id, context = sourceContext(request), read = () => fetch(s.base + item + '?' + new URLSearchParams(context), { headers });
      let waiting = await task(await read());
      if (waiting.question) {
        expect(waiting.question.authority).toBe('none');
        expect((await post(s.base, item + '/reply', { version: 1, ...context, clientRequestId: 'content_reply', questionId: waiting.question.id,
          questionDigest: waiting.question.digest, replyMessageId: 'content_message', text: draftContent })).status).toBe(200);
        await s.facade.drain(); waiting = await task(await read());
      }
      expect(waiting.status).toBe('awaiting-approval'); expect(waiting.approval?.content).toBe(draftContent); expect(s.writes).not.toHaveBeenCalled();
      expect(waiting.approval?.predecessorMessageId).toBe(mode === 'draft' ? request.inputMessageId : 'content_message');
      const decision = { version: 1, ...context, approvalId: waiting.approval!.id, approvalDigest: waiting.approval!.digest,
        replyMessageId: 'approval_message', decision: mode === 'reject' ? 'reject' : 'approve' };
      expect((await post(s.base, item + '/decide', { ...decision, replyMessageId: request.inputMessageId })).status).toBe(409);
      if (mode !== 'draft') expect((await post(s.base, item + '/decide', { ...decision, replyMessageId: 'content_message' })).status).toBe(409);
      const calls = s.calls(); expect((await post(s.base, item + '/decide', decision)).status).toBe(200); await s.facade.drain();
      const done = await task(await read()); expect(done.status, JSON.stringify({ done, progressErrors, host: s.facade.hostStatus(),
        jobs: s.scheduler.list().map(job => ({ state: job.state, reason: job.reason, result: job.result })) })).toBe(mode === 'reject' ? 'blocked' : literal ? 'completed' : 'partial');
      expect(done.message?.predecessorMessageId).toBe('approval_message'); expect(s.calls()).toBe(calls);
      expect(s.writes).toHaveBeenCalledTimes(mode === 'reject' ? 0 : 1);
      expect(s.dispatch).toHaveBeenCalledTimes(mode === 'reject' ? 1 : 2);
      expect(await task(await post(s.base, item + '/decide', decision))).toEqual(done);
      expect((await post(s.base, item + '/ack', { version: 1, ...context, certificateDigest: done.message!.certificateDigest })).status).toBe(200);
      expect((await task(await post(s.base, item + '/decide', decision))).message?.delivery).toBe('acknowledged');
      if (literal) expect(s.calls()).toBe(0); expect(s.appAccess).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(['approve', 'reject'] as const)('continues an authenticated source Goal after exact Kernel %s without any model', async decision => {
    const s = await setup({ compiler: true, literalApprovals: true });
    try {
      s.selectedTargets.targets.find(target => target.id === 'new_file')!.relativePath = 'Новый отчёт.txt';
      const request = compiledRequest({ kind: 'create', target: 'new_file', content: { kind: 'literal', text: 'Точные байты 🟠\r\n' } });
      const initial = await task(await post(s.base, route, request)); await s.facade.drain();
      const url = route + '/' + initial.id, context = sourceContext(request);
      const waiting = await task(await fetch(s.base + url + '?' + new URLSearchParams(context), { headers }));
      expect(waiting.status).toBe('awaiting-approval'); expect(waiting.approval?.content).toBe('Точные байты 🟠\r\n');
      expect(waiting.message).toBeUndefined(); expect(s.writes).not.toHaveBeenCalled(); expect(s.calls()).toBe(0);
      const body = { version: 1, ...context, approvalId: waiting.approval!.id, approvalDigest: waiting.approval!.digest,
        replyMessageId: 'approval_message', decision };
      expect((await post(s.base, url + '/decide', { ...body, confirmed: true })).status).toBe(400);
      expect((await post(s.base, url + '/decide', { ...body, approvalDigest: 'sha256:' + '0'.repeat(64) })).status).toBe(409);
      expect((await post(s.base, url + '/decide', { ...body, replyMessageId: request.inputMessageId })).status).toBe(409);
      const foreign = await s.http('unified', 'foreign-owned-actor');
      expect((await post(foreign, url + '/decide', body, { ...headers, Authorization: 'Bearer foreign-owned-actor' })).status).toBe(404);
      const accepted = await post(s.base, url + '/decide', body);
      expect(accepted.status, await accepted.text()).toBe(200); await s.facade.drain();
      const done = await task(await fetch(s.base + url + '?' + new URLSearchParams(context), { headers }));
      expect(done.status).toBe(decision === 'approve' ? 'completed' : 'blocked');
      expect(done.message?.predecessorMessageId).toBe(body.replyMessageId); expect(done.approval).toBeUndefined();
      expect(await task(await post(s.base, url + '/decide', body))).toEqual(done);
      expect((await post(s.base, url + '/decide', { ...body, decision: decision === 'approve' ? 'reject' : 'approve' })).status).toBe(409);
      expect(s.scheduler.list()).toHaveLength(1); expect(s.calls()).toBe(0);
      expect(s.writes).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0);
      expect(s.dispatch).toHaveBeenCalledTimes(decision === 'approve' ? 2 : 1);
      expect((await post(s.base, route, { ...request, clientRequestId: 'reused_answer_source', inputMessageId: body.replyMessageId })).status).toBe(409);
      if (decision === 'approve') expect(await readFile(path.join(s.root, 'Новый отчёт.txt'), 'utf8')).toBe('Точные байты 🟠\r\n');
      expect(s.appAccess).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('compiles a multi-file source Goal into ONE model-free read workflow with exact source and replay', async () => {
    const s = await setup({ compiler: true, requiredInputs: true });
    try { await writeFile(path.join(s.root, 'второй.txt'), 'Привет 🟠', { flag: 'wx' });
      s.selectedTargets.targets.push({ id: 'second', relativePath: 'второй.txt', access: 'observe', maxBytes: 8192, timeoutMs: 5000 });
      const request = compiledRequest({ kind: 'observe', targets: ['file', 'second'] });
      const initial = await task(await post(s.base, readRoute, request)); await s.facade.drain();
      const done = await task(await fetch(s.base + readRoute + '/' + initial.id + '?' + new URLSearchParams(sourceContext(request)), { headers }));
      expect(done).toMatchObject({ status: 'completed', modelJobs: 0, readJobs: 1,
        message: { predecessorMessageId: request.inputMessageId, verification: 'internal-read-certificate' } });
      expect(done).not.toHaveProperty('createJobs'); expect(s.scheduler.list()).toHaveLength(1);
      expect(s.scheduler.list()[0]!.adapterId).toBe('admitted-workspace-read'); expect(s.facade.adapters).toHaveLength(7);
      expect(s.calls()).toBe(0); expect(s.dispatch).toHaveBeenCalledTimes(2);
      expect(await task(await post(s.base, readRoute, request))).toEqual(done);
      expect((await post(s.base, readRoute, { ...request, text: 'Changed source text' })).status).toBe(409);
      expect((await post(s.base, route, { ...compiledRequest({ kind: 'create', target: 'new_file', content: { kind: 'literal', text: 'NO' } }), inputMessageId: request.inputMessageId })).status).toBe(409);
      expect((await post(s.base, readRoute + '/' + initial.id + '/ack', { version: 1, ...sourceContext(request), certificateDigest: done.message!.certificateDigest })).status).toBe(200);
      expect(s.catalog.resolve).not.toHaveBeenCalled(); expect(s.createCatalog.resolve).not.toHaveBeenCalled(); expect(s.appAccess).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('rejects cloud analysis before admission when no prepared MAX host was assembled', async () => {
    const s = await setup({ compiler: true, requiredInputs: true });
    try {
      const request = compiledRequest({ kind: 'analyze', targets: ['file'], modelMode: 'max', modelChoice: 'gpt-oss-120b' });
      const response = await post(s.base, readRoute, request);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'astra-model-mode-unavailable' });
      expect(s.scheduler.list()).toEqual([]); expect(s.calls()).toBe(0); expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(['literal', 'empty', 'reply', 'draft'] as const)('compiles dynamic create intent through existing source/Kernel ownership (%s)', async mode => {
    const s = await setup({ compiler: true, requiredInputs: true });
    try { s.selectedTargets.targets[1]!.relativePath = 'Новый отчёт.txt';
      const content = mode === 'empty' ? '' : mode === 'literal' ? ' Точные байты\r\ne\u0301🟠' : draftContent;
      const goal: AstraSourceGoalInput = { kind: 'create', target: 'new_file', content: mode === 'literal' || mode === 'empty'
        ? { kind: 'literal', text: content } : { kind: mode } };
      const request = { ...compiledRequest(goal), text: 'Создай новый файл «Новый отчёт.txt» с указанным содержимым.' };
      const initial = await task(await post(s.base, route, request)); await s.facade.drain();
      const itemRoute = route + '/' + initial.id, query = '?' + new URLSearchParams(sourceContext(request));
      let view = await task(await fetch(s.base + itemRoute + query, { headers }));
      if (mode === 'reply') {
        expect(view.status).toBe('awaiting-user'); expect(s.calls()).toBe(0);
        expect((await post(s.base, itemRoute + '/reply', { version: 1, ...sourceContext(request), clientRequestId: 'reply', replyMessageId: 'literal_reply',
          questionId: view.question!.id, questionDigest: view.question!.digest, text: content })).status).toBe(200);
        await s.facade.drain(); view = await task(await fetch(s.base + itemRoute + query, { headers }));
      }
      expect(view, JSON.stringify(await s.dispatch.mock.results[0]?.value)).toMatchObject({ status: mode === 'draft' ? 'partial' : 'completed', modelJobs: mode === 'draft' ? 1 : 0, createJobs: 1 });
      expect(await readFile(path.join(s.root, 'Новый отчёт.txt'))).toEqual(Buffer.from(content));
      expect(s.dispatch).toHaveBeenCalledTimes(1); expect(s.dispatch.mock.calls[0]![1]?.originatingUserText).toBe(request.text);
      if (mode !== 'draft') expect(s.calls()).toBe(0); else expect(s.calls()).toBeGreaterThan(0);
      expect((await post(s.base, itemRoute + '/ack', { version: 1, ...sourceContext(request), certificateDigest: view.message!.certificateDigest })).status).toBe(200);
      expect(s.createCatalog.resolve).not.toHaveBeenCalled(); expect(s.appAccess).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(['read', 'create'] as const)('atomically rolls back compiled source/message/Goal/capacity/queue after SQL (%s)', async operation => {
    const s = await setup({ compiler: true, requiredInputs: true });
    try { const request = compiledRequest(operation === 'read' ? { kind: 'observe', targets: ['file'] }
      : { kind: 'create', target: 'new_file', content: { kind: 'literal', text: 'BOUND' } });
      const endpoint = operation === 'read' ? readRoute : route, before = s.journal.capacity(), append = s.journal.appendAtomic.bind(s.journal);
      const fault = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((input, guard) => {
        if (!hasEvent(input, 'application.source-admitted')) return append(input, guard);
        let checks = 0; return append(input, () => ++checks === 1 && (!guard || guard()));
      });
      expect((await post(s.base, endpoint, request)).status).toBe(500); fault.mockRestore();
      expect(s.journal.capacity()).toEqual(before); expect(s.scheduler.list()).toEqual([]); expect(s.calls()).toBe(0); expect(s.dispatch).not.toHaveBeenCalled();
      expect((await post(s.base, endpoint, request)).status).toBe(202); await s.facade.drain(); expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('retains the real Kernel confirmation gap for vague wording; a typed goal alone grants no permission', async () => {
    const s = await setup({ compiler: true, requiredInputs: true });
    try { s.selectedTargets.targets[1]!.relativePath = 'Новый отчёт.txt';
      const request = compiledRequest({ kind: 'create', target: 'new_file', content: { kind: 'literal', text: 'DATA' } });
      const initial = await task(await post(s.base, route, request)); await s.facade.drain();
      const result = await task(await fetch(s.base + route + '/' + initial.id + '?' + new URLSearchParams(sourceContext(request)), { headers }));
      expect(result.status).toBe('blocked'); expect((await s.dispatch.mock.results[0]!.value).result.error).toBe('confirmation-required');
      expect(s.writes).not.toHaveBeenCalled(); expect(s.calls()).toBe(0);
      await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await s.close(); }
  });

  it('binds selected targets to the HTTP principal and rejects caller authority or unsupported goal mode', async () => {
    const s = await setup({ compiler: true, requiredInputs: true });
    try { const request = compiledRequest({ kind: 'create', target: 'new_file', content: { kind: 'literal', text: 'BOUND' } });
      expect((await post(s.base, route, { ...request, goal: { ...request.goal, confirmed: true } })).status).toBe(400);
      expect((await post(s.base, route, { ...request, goal: { ...request.goal, target: 'file' } })).status).toBe(403);
      expect((await post(s.base, readRoute, request)).status).toBe(400);
      expect((await post(s.base, route, { ...request, conversationId: 'other' })).status).toBe(404);
      const foreign = await s.http('unified', 'another-actor');
      expect((await post(foreign, route, request, { ...headers, Authorization: 'Bearer another-actor' })).status).toBe(404);
      expect(s.scheduler.list()).toEqual([]); expect(s.calls()).toBe(0); expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('keeps source compilation opt-in and refuses mixing fixed catalogs with the compiler', async () => {
    const s = await setup();
    try { expect((await post(s.base, route, { ...fixtureRequest('literal'), goal: { kind: 'create', target: 'new_file', content: { kind: 'literal', text: 'NO' } } })).status).toBe(400);
      expect(() => new MonarchAstraTaskFacade({ ...s.options, sourceCompiler: new AstraSourceGoalCompiler(s.targetPort) })).toThrow('astra-source-mode-conflict');
      expect(s.scheduler.list()).toEqual([]); expect(s.calls()).toBe(0);
    } finally { await s.close(); }
  });

  it('pins the new read-pack version in Goal/evidence and rejects silently reopening its scheduler as an old cohort', async () => {
    const s = await setup({ compiler: true, requiredInputs: true });
    try { const request = compiledRequest({ kind: 'observe', targets: ['file'] }), initial = await task(await post(s.base, readRoute, request)); await s.facade.drain();
      expect((s.journal.read(initial.id)!.checkpoint as { goal: { adapterVersion: string } }).goal.adapterVersion).toBe('v2');
      expect(s.scheduler.list()[0]!.adapterVersion).toBe('v2'); await s.facade.stop();
      const oldAdapters = s.facade.adapters.map(adapter => adapter.id === 'admitted-workspace-read' ? { ...adapter, version: 'v1' } : adapter);
      const incompatible = new AstraWorkScheduler({ deployment: 'isolated-validation', scopeId: s.options.scopeId, journal: s.journal, adapters: oldAdapters,
        limits: { activationTimeoutMs: 5000, leaseMs: 1000, kernelSlots: 1 } });
      expect(() => incompatible.acquire()).toThrow('astra-scheduler:checkpoint-binding');
    } finally { await s.close(); }
  });

  it.each(['read', 'create'] as const)('revalidates the selected target snapshot after compiled admission (%s)', async operation => {
    const s = await setup({ compiler: true, requiredInputs: true });
    try { const request = compiledRequest(operation === 'read' ? { kind: 'observe', targets: ['file'] }
      : { kind: 'create', target: 'new_file', content: { kind: 'literal', text: 'BOUND' } });
      const append = s.journal.appendAtomic.bind(s.journal), hook = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((input, guard) => {
        const result = append(input, guard); if (hasEvent(input, 'application.source-admitted')) s.selectedTargets.revision++; return result;
      });
      const initial = await task(await post(s.base, operation === 'read' ? readRoute : route, request)); hook.mockRestore(); await s.facade.drain();
      expect(s.dispatch).not.toHaveBeenCalled(); expect(s.calls()).toBe(0);
      const result = await task(await fetch(s.base + (operation === 'read' ? readRoute : route) + '/' + initial.id + '?' + new URLSearchParams(sourceContext(request)), { headers }));
      expect(result.status).not.toBe('completed');
    } finally { await s.close(); }
  });

  it.each([['compiled-read', 'admitted'], ['compiled-read', 'certified'], ['compiled-literal', 'admitted'], ['compiled-literal', 'certified'],
    ['compiled-reply', 'question'], ['compiled-reply', 'reply-admitted'], ['compiled-reply', 'reply-certified']] as const)
  ('restores compiled HTTP source/Goal after actual exit68 (%s/%s), without model calls or repeat effects', async (kind, stage) => {
    const root = path.join(fixture, 'workspace_' + sequence++); await mkdir(root); await writeFile(path.join(root, 'selected.txt'), 'SOURCE READ', { flag: 'wx' });
    const scopeId = 'compiled_crash_' + sequence++, file = path.join(root, 'owned-http.sqlite');
    const worker = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-v3/application-create-worker.ts', fixture, path.basename(root), scopeId,
      kind, stage, host.endpoint, host.hostGeneration, host.modelDigest], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TEMP: fixture, TMP: fixture, TSX_DISABLE_CACHE: '1' } });
    const crashed = await new Promise<{ taskId: string; calls: number; dispatches: number }>((resolve, reject) => {
      let stdout = '', stderr = '', timedOut = false; const timer = setTimeout(() => { timedOut = true; worker.kill(); }, 15000);
      worker.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 8192) worker.kill(); });
      worker.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
      worker.once('error', error => { clearTimeout(timer); reject(error); }); worker.once('close', code => { clearTimeout(timer);
        if (timedOut || code !== 68) return reject(Error('compiled-http-crash:' + code + ':' + stderr));
        try { const result = JSON.parse(stdout.trim()); expect(result.marker).toBe('owned-create-http-crash'); resolve(result); } catch (error) { reject(error); }
      });
    });
    const probe = new AstraJournal(file), expiry = (probe.read('scheduler_' + scopeId)!.checkpoint as { expiresAt: number }).expiresAt; probe.close();
    expect(expiry - Date.now()).toBeLessThanOrEqual(1100); await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry - Date.now() + 20)));
    const s = await setup({ compiler: true, requiredInputs: true, root, scopeId, file, noCatalog: ['certified', 'reply-certified'].includes(stage) });
    try { await s.facade.drain(); const endpoint = kind === 'compiled-read' ? readRoute : route, request = compiledFixtureRequest(kind);
      const source = { conversationId: request.conversationId, inputMessageId: request.inputMessageId }, item = endpoint + '/' + crashed.taskId;
      let view = await task(await fetch(s.base + item + '?' + new URLSearchParams(source), { headers }));
      if (kind === 'compiled-reply') {
        const record = s.journal.read(crashed.taskId)!.checkpoint as { requiredInputAnswer?: { question: NonNullable<AstraTaskHttpTask['question']> } };
        const question = view.question ?? record.requiredInputAnswer!.question;
        const reply = { version: 1, ...source, clientRequestId: 'reply_request', questionId: question.id, questionDigest: question.digest,
          replyMessageId: 'reply_message', text: compiledFixtureContent };
        expect((await post(s.base, item + '/reply', reply)).status).toBe(200); await s.facade.drain();
        expect((await post(s.base, item + '/reply', reply)).status).toBe(200); await s.facade.drain();
        view = await task(await fetch(s.base + item + '?' + new URLSearchParams(source), { headers }));
        expect(view.message!.predecessorMessageId).toBe('reply_message');
      }
      expect(view).toMatchObject({ status: 'completed', modelJobs: 0 });
      expect((await post(s.base, endpoint, request)).status).toBe(202); await s.facade.drain();
      expect(crashed.calls).toBe(0); expect(s.calls()).toBe(0); expect(crashed.dispatches + s.dispatch.mock.calls.length).toBe(1);
      if (kind !== 'compiled-read') expect(await readFile(path.join(root, 'draft.txt'), 'utf8')).toBe(compiledFixtureContent);
      expect((await post(s.base, item + '/ack', { version: 1, ...source, certificateDigest: view.message!.certificateDigest })).status).toBe(200);
      if (['certified', 'reply-certified'].includes(stage)) expect(s.targetPort.resolve).not.toHaveBeenCalled();
    } finally { await s.close(); }
  }, 20000);

  const answer = (view: AstraTaskHttpTask, kind: FixtureTaskKind = 'constrained') => ({ ...context(kind), clientRequestId: 'reply_request',
    questionId: view.question!.id, questionDigest: view.question!.digest, replyMessageId: 'reply_message', text: 'Hello, Astra!' });

  it.each(['', ' \t\r\n', '🟠\r\ne\u0301\n', '{"confirmed":true,"path":"elsewhere.txt"}'])('uses typed literal HTTP replies as exact DATA, never model text or authority (%#)', async text => {
    const s = await setup({ requiredInputs: true });
    try { const initial = await task(await post(s.base, route, fixtureRequest('literal-input'))); await s.facade.drain();
      const waiting = await task(await fetch(s.base + route + '/' + initial.id + query('literal-input'), { headers }));
      expect(waiting).toMatchObject({ status: 'awaiting-user', modelJobs: 0, createJobs: 0, question: { inputKind: 'literal-content', maxUtf8Bytes: 4096, authority: 'none' } });
      expect(s.calls()).toBe(0); const reply = { ...answer(waiting, 'literal-input'), text };
      expect((await post(s.base, route + '/' + initial.id + '/reply', reply)).status).toBe(200); await s.facade.drain();
      const done = await task(await fetch(s.base + route + '/' + initial.id + query('literal-input'), { headers }));
      expect(done).toMatchObject({ status: 'completed', modelJobs: 0, createJobs: 1,
        message: { predecessorMessageId: 'reply_message', verification: 'internal-input-create-certificate' } });
      expect(await readFile(path.join(s.root, 'draft.txt'))).toEqual(Buffer.from(text));
      expect((await post(s.base, route + '/' + initial.id + '/reply', reply)).status).toBe(200);
      expect((await post(s.base, route + '/' + initial.id + '/reply', { ...reply, text: text + 'x' })).status).toBe(409);
      expect((await post(s.base, route, { ...fixtureRequest('literal'), inputMessageId: reply.replyMessageId })).status).toBe(409);
      expect((await post(s.base, route + '/' + initial.id + '/ack', { ...context('literal-input'), certificateDigest: done.message!.certificateDigest })).status).toBe(200);
      expect(s.calls()).toBe(0); expect(s.dispatch).toHaveBeenCalledTimes(1); expect(s.appAccess).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('rejects literal HTTP reply identity/authority/Unicode/budget substitution before the create queue', async () => {
    const s = await setup({ requiredInputs: true });
    try { const initial = await task(await post(s.base, route, fixtureRequest('literal-input'))); await s.facade.drain();
      const waiting = await task(await fetch(s.base + route + '/' + initial.id + query('literal-input'), { headers })), reply = answer(waiting, 'literal-input');
      for (const [patch, status] of [[{ confirmed: true }, 400], [{ text: '\ud800' }, 400], [{ text: '🟠'.repeat(1025) }, 400],
        [{ questionDigest: 'sha256:' + '0'.repeat(64) }, 409], [{ replyMessageId: 'message_literal-input' }, 409], [{ conversationId: 'other' }, 404]] as const)
        expect((await post(s.base, route + '/' + initial.id + '/reply', { ...reply, ...patch })).status).toBe(status);
      expect((await post(s.base, route + '/' + initial.id + '/reply', reply, { ...headers, 'x-monarch-desktop-attestation': desktopToken })).status).toBe(404);
      expect(s.scheduler.list()).toHaveLength(1); expect(s.calls()).toBe(0); expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(['draft-as-literal', 'literal-as-guidance'] as const)('rejects source-catalog content-kind confusion before admission (%s)', async mode => {
    const s = await setup({ requiredInputs: true });
    try { s.createCatalog.resolve.mockImplementation((id, source) => {
      const original = createSelection(id, source);
      return (mode === 'draft-as-literal' ? { ...original, kind: 'draft' } : { ...original,
        requiredInput: { kind: 'draft-guidance', id: 'guidance', question: 'Tell me more', maxUtf8Bytes: 128 } }) as ReturnType<typeof createSelection>;
    });
      const capacity = s.journal.capacity(); expect((await post(s.base, route, fixtureRequest('literal-input'))).status).toBe(409);
      expect(s.journal.capacity()).toEqual(capacity); expect(s.scheduler.list()).toEqual([]); expect(s.calls()).toBe(0); expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('delivers a durable question, atomically admits one HTTP reply and anchors its final message to that answer', async () => {
    const s = await setup({ askFirst: true });
    try { const initial = await task(await post(s.base, route, fixtureRequest('constrained'))); await s.facade.drain();
      const waiting = await task(await fetch(s.base + route + '/' + initial.id + query('constrained'), { headers }));
      expect(waiting).toMatchObject({ status: 'awaiting-user', modelJobs: 1, createJobs: 0,
        question: { authority: 'none', conversationId: 'owned_conversation', predecessorMessageId: 'message_constrained' } });
      expect(waiting.message).toBeUndefined(); const reply = answer(waiting), replyRoute = route + '/' + initial.id + '/reply';
      expect((await post(s.base, replyRoute, reply)).status).toBe(200); expect((await post(s.base, replyRoute, reply)).status).toBe(200);
      await s.facade.drain(); const done = await task(await fetch(s.base + route + '/' + initial.id + query('constrained'), { headers }));
      expect(done).toMatchObject({ id: initial.id, status: 'completed', modelJobs: 2, createJobs: 1,
        message: { predecessorMessageId: 'reply_message' } }); expect(done.question).toBeUndefined();
      const calls = s.calls(); expect((await post(s.base, replyRoute, reply)).status).toBe(200); await s.facade.drain(); expect(s.calls()).toBe(calls);
      expect((await post(s.base, replyRoute, { ...reply, text: 'DIFFERENT' })).status).toBe(409);
      expect((await post(s.base, route, { ...fixtureRequest('literal'), inputMessageId: 'reply_message' })).status).toBe(409);
      const record = s.journal.read(initial.id)!.checkpoint as { clarifications: Array<{ sourceReservationId: string }> };
      expect((await post(s.base, route + '/' + initial.id + '/ack', { ...context('constrained'), certificateDigest: done.message!.certificateDigest })).status).toBe(200);
      expect(s.journal.reservation(record.clarifications[0]!.sourceReservationId)).toBeNull(); expect(s.dispatch).toHaveBeenCalledTimes(1);
      expect(await readFile(path.join(s.root, 'draft.txt'), 'utf8')).toBe(draftContent);
    } finally { await s.close(); }
  });

  it('rejects reply substitution, foreign actor/source and authority fields without admitting another job', async () => {
    const s = await setup({ askFirst: true });
    try { const initial = await task(await post(s.base, route, fixtureRequest('constrained'))); await s.facade.drain();
      const waiting = await task(await fetch(s.base + route + '/' + initial.id + query('constrained'), { headers })), reply = answer(waiting), replyRoute = route + '/' + initial.id + '/reply';
      for (const patch of [{ questionId: 'other' }, { questionDigest: 'sha256:' + '0'.repeat(64) }, { replyMessageId: 'message_constrained' }])
        expect((await post(s.base, replyRoute, { ...reply, ...patch })).status).toBe(409);
      for (const patch of [{ confirmed: true }, { path: 'other.txt' }, { selectionId: 'literal' }, { text: '' }, { text: 'x'.repeat(4097) }])
        expect((await post(s.base, replyRoute, { ...reply, ...patch })).status).toBe(400);
      expect((await post(s.base, replyRoute, { ...reply, conversationId: 'other' })).status).toBe(404);
      expect((await post(s.base, replyRoute, reply, { ...headers, 'x-monarch-desktop-attestation': desktopToken })).status).toBe(404);
      const foreign = await s.http('unified', 'other-token');
      expect((await post(foreign, replyRoute, reply, { ...headers, Authorization: 'Bearer other-token' })).status).toBe(404);
      expect((await post(s.base, readRoute + '/' + initial.id + '/reply', reply)).status).toBe(405);
      expect(s.scheduler.list()).toHaveLength(1); expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(['constrained', 'required', 'literal-input'] as const)('rolls back reply, global message claim, capacity and next job together after SQL writes (%s)', async kind => {
    const s = await setup({ askFirst: kind === 'constrained', requiredInputs: kind !== 'constrained' });
    try { const initial = await task(await post(s.base, route, fixtureRequest(kind))); await s.facade.drain();
      const waiting = await task(await fetch(s.base + route + '/' + initial.id + query(kind), { headers })), reply = answer(waiting, kind), before = s.journal.capacity();
      const append = s.journal.appendAtomic.bind(s.journal), fault = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((input, guard) => {
        if (!hasEvent(input, kind === 'literal-input' ? 'draft.literal-reply-admitted' : 'draft.reply-admitted')) return append(input, guard);
        let checks = 0; return append(input, () => ++checks === 1 && (!guard || guard()));
      });
      expect((await post(s.base, route + '/' + initial.id + '/reply', reply)).status).toBe(500); fault.mockRestore();
      expect(s.journal.capacity()).toEqual(before); expect(s.scheduler.list()).toHaveLength(1);
      expect((await task(await fetch(s.base + route + '/' + initial.id + query(kind), { headers }))).question).toEqual(waiting.question);
      expect((await post(s.base, route + '/' + initial.id + '/reply', reply)).status).toBe(200); await s.facade.drain();
      expect(s.dispatch).toHaveBeenCalledTimes(1); if (kind === 'literal-input') expect(s.calls()).toBe(0);
    } finally { await s.close(); }
  });

  it.each([['literal', 'admitted'], ['literal', 'certified'], ['constrained', 'model-result'], ['constrained', 'certified'],
    ['constrained', 'question'], ['constrained', 'reply-admitted'], ['constrained', 'reply-model-result'], ['constrained', 'reply-certified'],
    ['required', 'admitted'], ['required', 'input-result'], ['required', 'question'], ['required', 'reply-admitted'], ['required', 'reply-model-result'], ['required', 'reply-certified'],
    ['literal-input', 'admitted'], ['literal-input', 'input-result'], ['literal-input', 'question'], ['literal-input', 'reply-admitted'],
    ['literal-input', 'effect-unrecorded'], ['literal-input', 'effect-recorded'], ['literal-input', 'reply-certified']] as const)
  ('recovers real HTTP source/Goal after exit68 (%s/%s) and discovers its outbox without repeating effects', async (kind, stage) => {
    const root = path.join(fixture, 'workspace_' + sequence++); await mkdir(root);
    const scopeId = 'http_create_crash_' + sequence++, file = path.join(root, 'owned-http.sqlite');
    await fetch(host.endpoint + '/__fixture/control', { method: 'POST', headers: modelHeaders, body: JSON.stringify({
      output: JSON.stringify({ kind: 'create', requirementId: 'draft_file', capabilityHandle: 'create_file', targetHandle: 'selected_file', content: draftContent }),
      finish: 'stop', block: false }) });
    const before = await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { generationCalls: number };
    const worker = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-v3/application-create-worker.ts',
      fixture, path.basename(root), scopeId, kind, stage, host.endpoint, host.hostGeneration, host.modelDigest],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEMP: fixture, TMP: fixture, TSX_DISABLE_CACHE: '1' } });
    const crashed = await new Promise<{ taskId: string; calls: number; dispatches: number }>((resolve, reject) => {
      let stdout = '', stderr = '', timedOut = false; const timer = setTimeout(() => { timedOut = true; worker.kill(); }, 15000);
      worker.stdout.on('data', data => { stdout += String(data); if (stdout.length > 8192) worker.kill(); }); worker.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-8192); });
      worker.once('error', error => { clearTimeout(timer); reject(error); }); worker.once('close', code => { clearTimeout(timer);
        if (timedOut || code !== 68) { reject(Error('owned-create-http-crash:' + code + ':' + stderr)); return; }
        try { const result = JSON.parse(stdout.trim()); expect(result.marker).toBe('owned-create-http-crash'); resolve(result); } catch (error) { reject(error); }
      });
    });
    const probe = new AstraJournal(file), expiresAt = (probe.read('scheduler_' + scopeId)!.checkpoint as { expiresAt: number }).expiresAt; probe.close();
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(1100); await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 20)));
    const hostInput = kind === 'required' || kind === 'literal-input';
    const questionScenario = hostInput || stage === 'question' || stage.startsWith('reply-');
    const s = await setup({ root, scopeId, file, requiredInputs: hostInput, ...(['certified', 'reply-certified'].includes(stage) ? { noCatalog: true } : {}) });
    try { await s.facade.drain();
      const response = await fetch(s.base + route + '?conversationId=owned_conversation', { headers });
      let views = (await response.json() as { tasks: AstraTaskHttpTask[] }).tasks;
      if (questionScenario) {
        const record = s.journal.read(crashed.taskId)!.checkpoint as { question?: AstraTaskHttpTask['question']; clarifications?: Array<{ question: AstraTaskHttpTask['question'] }>;
          requiredInputAnswer?: { question: AstraTaskHttpTask['question'] } };
        if (stage === 'question' || hostInput && ['admitted', 'input-result'].includes(stage)) {
          expect(views[0]!.status).toBe('awaiting-user'); expect(s.calls()).toBe(0); expect(s.dispatch).not.toHaveBeenCalled();
          if (hostInput) { expect(crashed.calls).toBe(0); expect(views[0]).toMatchObject({ modelJobs: 0, inputJobs: 1, question: { origin: 'host-required-input' } }); }
        }
        const question = views[0]!.question ?? record.question ?? record.requiredInputAnswer?.question ?? record.clarifications![0]!.question!;
        const reply = answer({ ...views[0]!, question }, kind);
        expect((await post(s.base, route + '/' + crashed.taskId + '/reply', reply)).status).toBe(200); await s.facade.drain();
        const calls = s.calls(); expect((await post(s.base, route + '/' + crashed.taskId + '/reply', reply)).status).toBe(200); await s.facade.drain();
        expect(s.calls()).toBe(calls);
        views = [await task(await fetch(s.base + route + '/' + crashed.taskId + query(kind), { headers }))];
        expect(views[0]!.modelJobs).toBe(kind === 'literal-input' ? 0 : kind === 'required' ? 1 : 2);
        if (stage !== 'effect-unrecorded') expect(views[0]!.message!.predecessorMessageId).toBe('reply_message');
      }
      if (stage === 'effect-unrecorded') {
        expect(views).toHaveLength(1); expect(views[0]).toMatchObject({ id: crashed.taskId, status: 'indeterminate', modelJobs: 0 });
        expect(views[0]!.message).toBeUndefined(); expect(await readFile(path.join(root, 'draft.txt'), 'utf8')).toBe(draftContent);
        expect(crashed.dispatches).toBe(1); expect(s.dispatch).not.toHaveBeenCalled(); expect(s.calls()).toBe(0); expect(crashed.calls).toBe(0);
        expect((await s.facade.stop()).unresolvedWork).toBe(1); return;
      }
      expect(views).toHaveLength(1); expect(views[0]).toMatchObject({ id: crashed.taskId, status: 'completed', message: { delivery: 'pending' } });
      expect(await readFile(path.join(root, kind === 'literal' ? 'literal.txt' : 'draft.txt'), 'utf8')).toBe(kind === 'literal' ? literalContent : draftContent);
      expect(crashed.dispatches + s.dispatch.mock.calls.length).toBe(1);
      if (kind !== 'literal-input' && (['question', 'reply-admitted'].includes(stage) || kind === 'required' && ['admitted', 'input-result'].includes(stage))) expect(s.calls()).toBeGreaterThan(0); else expect(s.calls()).toBe(0);
      const after = await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { generationCalls: number };
      expect(after.generationCalls - before.generationCalls).toBe(kind === 'literal' || kind === 'literal-input' ? 0 : kind === 'required' ? 1 : questionScenario ? 2 : 1);
      if (kind === 'literal' || kind === 'literal-input') expect(crashed.calls).toBe(0); if (['certified', 'reply-certified'].includes(stage)) expect(s.createCatalog.resolve).not.toHaveBeenCalled();
      expect((await post(s.base, route + '/' + crashed.taskId + '/ack', { ...context(kind), certificateDigest: views[0]!.message!.certificateDigest })).status).toBe(200);
    } finally { await s.close(); }
  }, 20000);

  it.each(['literal', 'draft', 'constrained'] as const)('creates through the real HTTP principal and delivers replayable causal results (%s)', async kind => {
    const s = await setup();
    try { const admitted = await post(s.base, route, fixtureRequest(kind)); expect(admitted.status).toBe(202); const initial = await task(admitted);
      await s.facade.drain(); const done = await task(await fetch(s.base + route + '/' + initial.id + query(kind), { headers }));
      expect(done).toMatchObject({ status: kind === 'draft' ? 'partial' : 'completed', modelJobs: kind === 'literal' ? 0 : 1, createJobs: 1,
        message: { conversationId: 'owned_conversation', predecessorMessageId: 'message_' + kind, delivery: 'pending', nativeCompletionCertified: false } });
      expect(await readFile(path.join(s.root, kind === 'literal' ? 'literal.txt' : 'draft.txt'), 'utf8')).toBe(kind === 'literal' ? literalContent : draftContent);
      const calls = s.calls(); expect(await task(await post(s.base, route, fixtureRequest(kind)))).toEqual(done); await s.facade.drain();
      const ack = await post(s.base, route + '/' + done.id + '/ack', { ...context(kind), certificateDigest: done.message!.certificateDigest });
      expect((await task(ack)).message!.delivery).toBe('acknowledged'); expect(s.calls()).toBe(calls); if (kind === 'literal') expect(calls).toBe(0);
      expect(s.dispatch).toHaveBeenCalledTimes(1); expect(s.dispatch.mock.calls[0]![1]).not.toHaveProperty('confirmed'); expect(s.appAccess).not.toHaveBeenCalled();
      expect(JSON.stringify(done)).not.toContain(s.root); expect(JSON.stringify(done)).not.toContain(literalContent);
    } finally { await s.close(); }
  });

  it('shares ONE host and one message namespace across read, literal and draft routes', async () => {
    const s = await setup();
    try {
      const read = await task(await post(s.base, readRoute, fixtureRequest('read'))), literal = await task(await post(s.base, route, fixtureRequest('literal')));
      const draft = await task(await post(s.base, route, fixtureRequest('constrained'))); await s.facade.drain();
      expect(s.facade.list({ source: 'api', id: 'sha256:' + '0'.repeat(64) }, 'owned_conversation')).toEqual([]);
      expect((await task(await fetch(s.base + readRoute + '/' + read.id + query('read'), { headers }))).status).toBe('completed');
      const all = await (await fetch(s.base + route + '?conversationId=owned_conversation', { headers })).json() as { tasks: AstraTaskHttpTask[] };
      expect(all.tasks.map(item => item.id).sort()).toEqual([literal.id, draft.id].sort()); expect(s.dispatch).toHaveBeenCalledTimes(3);
      expect((await fetch(s.base + readRoute + '/' + literal.id + query('literal'), { headers })).status).toBe(404);
      expect((await post(s.base, route, { ...fixtureRequest('read'), selectionId: 'literal' })).status).toBe(409);
      expect((await post(s.base, route, { ...fixtureRequest('literal'), clientRequestId: 'another' })).status).toBe(409);
      expect(s.facade.adapters).toHaveLength(5); expect(new Set(s.scheduler.list().map(job => job.id)).size).toBe(5);
    } finally { await s.close(); }
  });

  it('rejects mismatching generated content before any Kernel write and exposes no raw model text', async () => {
    const s = await setup({ wrong: true });
    try { const initial = await task(await post(s.base, route, fixtureRequest('constrained'))); await s.facade.drain();
      const done = await task(await fetch(s.base + route + '/' + initial.id + query('constrained'), { headers }));
      expect(done).toMatchObject({ status: 'blocked', createJobs: 0 }); expect(done.message!.content).toContain('запись отклонена');
      expect(s.dispatch).not.toHaveBeenCalled(); await expect(readFile(path.join(s.root, 'draft.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.stringify(done)).not.toContain('WRONG');
    } finally { await s.close(); }
  });

  it('keeps create disabled without explicit unified injection, including legacy read-only injection', async () => {
    const s = await setup();
    try { for (const mode of ['legacy', 'disabled'] as const) {
      const base = await s.http(mode); expect((await post(base, route, fixtureRequest('literal'))).status).toBe(404);
    } expect(s.scheduler.list()).toEqual([]); expect(s.calls()).toBe(0); expect(s.appAccess).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('does not expose or mutate a task across credentials, desktop/API source, conversation or predecessor', async () => {
    const s = await setup();
    try {
      const initial = await task(await post(s.base, route, fixtureRequest('literal'))); await s.facade.drain();
      const foreign = await s.http('unified', 'other-owned-token'), foreignHeaders = { ...headers, Authorization: 'Bearer other-owned-token' };
      expect((await fetch(foreign + route + '/' + initial.id + query('literal'), { headers: foreignHeaders })).status).toBe(404);
      expect((await fetch(s.base + route + '/' + initial.id + query('literal'), { headers: { ...headers, 'x-monarch-desktop-attestation': desktopToken } })).status).toBe(404);
      for (const body of [{ ...context('literal'), conversationId: 'other' }, { ...context('literal'), inputMessageId: 'other' }])
        expect((await post(s.base, route + '/' + initial.id + '/cancel', body)).status).toBe(404);
      expect((await fetch(s.base + route + '/' + initial.id + query('literal'))).status).toBe(401); expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it.each([{ confirmed: true }, { path: 'outside.txt' }, { family: 'literal-create' }, { content: 'FORGED' }, { privacyMode: 'incognito' }])('rejects caller-supplied authority/content/private mode before any source commit (%#)', async patch => {
    const s = await setup();
    try { const before = s.journal.capacity(); expect((await post(s.base, route, { ...fixtureRequest('literal'), ...patch })).status).toBe(400);
      expect(s.scheduler.list()).toEqual([]); expect(s.journal.capacity()).toEqual(before); expect(s.calls()).toBe(0);
    } finally { await s.close(); }
  });

  it.each(['literal', 'draft'] as const)('rolls back source, message uniqueness, task and queue together after SQL writes (%s)', async kind => {
    const s = await setup();
    try { const before = s.journal.capacity(), append = s.journal.appendAtomic.bind(s.journal);
      const fault = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((input, guard) => {
        if (!hasEvent(input, 'application.source-admitted')) return append(input, guard);
        let count = 0; return append(input, () => ++count === 1 && (!guard || guard()));
      });
      expect((await post(s.base, route, fixtureRequest(kind))).status).toBe(500); fault.mockRestore();
      expect(s.journal.capacity()).toEqual(before); expect(s.scheduler.list()).toEqual([]); expect(s.calls()).toBe(0);
      const initial = await task(await post(s.base, route, fixtureRequest(kind))); await s.facade.drain();
      expect((await task(await fetch(s.base + route + '/' + initial.id + query(kind), { headers }))).status).toBe(kind === 'draft' ? 'partial' : 'completed');
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('preserves Kernel read-only denial for the model-free literal path', async () => {
    const s = await setup({ readonly: true });
    try { const initial = await task(await post(s.base, route, fixtureRequest('literal'))); await s.facade.drain();
      expect((await task(await fetch(s.base + route + '/' + initial.id + query('literal'), { headers }))).status).toBe('blocked');
      expect(s.writes).not.toHaveBeenCalled(); expect(s.calls()).toBe(0);
    } finally { await s.close(); }
  });

  it('forwards HTTP cancel and retains native work until the shared host observes physical acknowledgement', async () => {
    const s = await setup({ block: true });
    try {
      const initial = await task(await post(s.base, route, fixtureRequest('draft'))), end = Date.now() + 3000;
      while (true) {
        const state = await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { workerStarted: boolean; slotReserved: boolean };
        if (state.workerStarted && state.slotReserved) break; if (Date.now() >= end) throw Error('owned-http-worker-not-started');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const cancelling = await task(await post(s.base, route + '/' + initial.id + '/cancel', context('draft')));
      expect(cancelling.message).toBeUndefined(); await s.release(); await s.facade.drain();
      const done = await task(await fetch(s.base + route + '/' + initial.id + query('draft'), { headers }));
      expect(done.status).toBe('cancelled'); expect(s.writes).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('stops source admission immediately while keeping existing task results readable', async () => {
    const s = await setup();
    try { const initial = await task(await post(s.base, route, fixtureRequest('literal'))); await s.facade.drain(); await s.facade.stop();
      expect((await post(s.base, route, fixtureRequest('draft'))).status).toBe(503);
      expect((await task(await fetch(s.base + route + '/' + initial.id + query('literal'), { headers }))).status).toBe('completed');
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
});
