import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request as rawHttpRequest, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AstraJournal, type AstraJournalAtomicCommit } from '../../src/agent-v3/journal';
import { AstraPreparedModelClient } from '../../src/agent-v3/prepared-model-client';
import { AstraWorkScheduler } from '../../src/agent-v3/work-scheduler';
import { modelReadDigest, type AstraModelReadTaskRecord } from '../../src/agent-v3/model-read-task-state';
import { MonarchKernel } from '../../src/core/kernel';
import { WorkspaceModule } from '../../src/modules/workspace';
import type { MonarchApplication } from '../../src/app/application';
import { createMonarchHttpServer } from '../../src/app/http-server';
import { MonarchAstraReadTaskFacade, type AstraReadHttpRequest, type AstraReadHttpTask } from '../../src/app/astra-read-task-facade';

// Actual Monarch HTTP principal/router + Application seam + shared scheduler +
// disposable Python host + Kernel. No normal Application bootstrap/user data.
// Python framing/grammar/tokenizer are real; model vocabulary/output synthetic.
const marker = 'astra-v3-prepared-model-synthetic-only';
const apiToken = 'owned-astra-http-fixture-api', desktopToken = 'owned-astra-http-fixture-desktop';
const modelHeaders = { Authorization: 'Bearer astra-synthetic-test', 'Content-Type': 'application/json' };
const apiHeaders = { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' };
const route = '/api/astra/v3/read-tasks';
const request: AstraReadHttpRequest = { version: 1, clientRequestId: 'request_first', conversationId: 'conversation_first',
  inputMessageId: 'message_first', text: 'Read the selected synthetic file and report observed byte count.',
  selectionId: 'selection_first', privacyMode: 'persistent' };
const context = { version: 1, conversationId: request.conversationId, inputMessageId: request.inputMessageId };
const query = '?' + new URLSearchParams({ conversationId: request.conversationId, inputMessageId: request.inputMessageId });
let parent: string, fixture: string, root: string, processHost: ChildProcessWithoutNullStreams;
let host: { marker: string; endpoint: string; hostGeneration: string; modelDigest: string };
let sequence = 0;

beforeAll(async () => {
  parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  fixture = await realpath(await mkdtemp(path.join(parent, 'astra-v3-prepared-model-')));
  expect(path.dirname(fixture)).toBe(parent);
  await writeFile(path.join(fixture, '.fixture-marker'), marker, { flag: 'wx' });
  root = path.join(fixture, 'workspace'); await mkdir(root);
  await writeFile(path.join(root, 'synthetic.txt'), 'Private synthetic file payload 🟠', { flag: 'wx' });
  processHost = spawn(path.resolve('oscar/.venv/Scripts/python.exe'), ['-B', path.resolve('tests/fixtures/agent-v3/model-server.py'), fixture],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  processHost.stdin.end();
  host = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => reject(Error('fixture-startup-deadline')), 15000);
    processHost.once('error', error => { clearTimeout(timer); reject(error); });
    processHost.once('exit', code => { clearTimeout(timer); reject(Error(`fixture-exit:${code}:${stderr.slice(-1000)}`)); });
    processHost.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    processHost.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.length > 32768) { clearTimeout(timer); reject(Error('fixture-stdout-budget')); return; }
      if (stdout.includes('\n')) { clearTimeout(timer);
        try { resolve(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))); } catch { reject(Error('fixture-startup-json')); }
      }
    });
  });
  expect(host.marker).toBe(marker); expect(host.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
}, 20000);
afterAll(async () => {
  if (processHost && processHost.exitCode === null && processHost.signalCode === null) {
    const exit = new Promise<void>(resolve => processHost.once('exit', () => resolve())); processHost.kill(); await exit;
  }
  if (!fixture) return;
  expect(await realpath(fixture)).toBe(fixture); expect(path.dirname(fixture)).toBe(parent);
  expect(path.basename(fixture).startsWith('astra-v3-prepared-model-')).toBe(true);
  expect(await readFile(path.join(fixture, '.fixture-marker'), 'utf8')).toBe(marker);
  await rm(fixture, { recursive: true, force: false }); // Exact owned synthetic child only.
});

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture-address');
  return 'http://127.0.0.1:' + address.port;
}
async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
async function post(base: string, pathname = route, body: unknown = request, headers: Record<string, string> = apiHeaders) {
  return fetch(base + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function task(response: Response): Promise<AstraReadHttpTask> {
  const body = await response.json() as { task?: AstraReadHttpTask };
  expect(body.task).toBeDefined(); return body.task!;
}
async function waitFor(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await condition()) { if (Date.now() > deadline) throw Error('fixture-condition-deadline'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const hasEvent = (input: AstraJournalAtomicCommit, type: string) => [input.primary, ...(input.additional ?? [])]
  .some(item => item.events.some(event => (event as { type?: string }).type === type));

async function setup(input: { file?: string; block?: boolean; now?: () => number; start?: boolean; scopeId?: string } = {}) {
  const scopeId = input.scopeId ?? 'http_scope_' + sequence++, journal = new AstraJournal(input.file ?? ':memory:');
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
  kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] })); await kernel.start();
  let revoked = false, calls = 0;
  const catalog = { resolve: vi.fn((selectionId: string) => {
    if (revoked || selectionId !== 'selection_first') throw Error('selection-unavailable');
    return { authority: 'observe' as const, revision: 1, digest: modelReadDigest('fixture-selection'),
      requirements: [{ id: 'first', relativePath: 'synthetic.txt', maxBytes: 8192 }] };
  }) };
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/model-turns') && init?.method === 'POST') {
      const configured = await fetch(host.endpoint + '/__fixture/control', { method: 'POST', headers: modelHeaders,
        body: JSON.stringify({ output: JSON.stringify({ kind: 'read', requirementId: 'first', capabilityHandle: 'read_first', targetHandle: 'target_first' }),
          finish: 'stop', block: input.block ?? false }) });
      expect(configured.status).toBe(200);
    }
    if (String(url).endsWith('/generate')) calls++;
    return fetch(url, init);
  };
  const clientOptions = { deployment: 'isolated-validation' as const, endpoint: host.endpoint,
    bearerToken: 'astra-synthetic-test', hostGeneration: host.hostGeneration, timeoutMs: 10000 };
  const options = { deployment: 'isolated-validation' as const, canonicalRoot: root, scopeId, journal, kernel, catalog,
    client: new AstraPreparedModelClient({ ...clientOptions, fetch: transport }),
    policy: { expectedModelDigest: host.modelDigest, modelTimeoutMs: 5000, contextLimits: { tokenizerTimeoutMs: 1000 } } };
  const facade = new MonarchAstraReadTaskFacade(options);
  const schedulerOptions = { deployment: 'isolated-validation' as const, journal, scopeId,
    adapters: facade.adapters, limits: { activationTimeoutMs: 5000, leaseMs: 1000 }, ...(input.now ? { now: input.now } : {}) };
  const scheduler = new AstraWorkScheduler(schedulerOptions); facade.attach(scheduler); if (input.start !== false) facade.start();
  const appAccess = vi.fn(() => { throw Error('ordinary-application-must-not-be-accessed'); });
  const app = new Proxy({} as MonarchApplication, { get: appAccess });
  const servers: Server[] = [];
  async function http(extra: { apiToken?: string; requireApiToken?: boolean; enabled?: boolean } = {}) {
    const server = createMonarchHttpServer({ app, publicDirectory: root, host: '127.0.0.1', port: 4317,
      apiToken: extra.apiToken ?? apiToken, desktopAttestationToken: desktopToken,
      requireApiToken: extra.requireApiToken ?? true, allowNonLoopbackMutations: false,
      ...(extra.enabled === false ? {} : { astraReadTasks: facade }) });
    servers.push(server); return listen(server);
  }
  const base = await http(), dispatch = vi.spyOn(kernel, 'executeActionProposal'); let closed = false;
  const release = async () => { await fetch(host.endpoint + '/__fixture/release', { method: 'POST', headers: modelHeaders }); };
  return { base, http, facade, journal, kernel, scheduler, catalog, appAccess, dispatch, options, schedulerOptions, clientOptions,
    calls: () => calls, revoke: () => { revoked = true; }, release,
    close: async () => { if (closed) return; closed = true; await release(); if (facade.hostStatus().phase === 'running') await facade.drain();
      await Promise.all(servers.map(closeServer)); await facade.stop(); await kernel.stop(); journal.close(); dispatch.mockRestore(); },
  };
}

describe('Default-off Astra Application HTTP read-task route', () => {
  it.each(['admitted', 'model-result', 'certified'])('automatically recovers a controller process exit at %s and discovers its causal message over HTTP', async stage => {
    const configured = await fetch(host.endpoint + '/__fixture/control', { method: 'POST', headers: modelHeaders,
      body: JSON.stringify({ output: JSON.stringify({ kind: 'read', requirementId: 'first', capabilityHandle: 'read_first', targetHandle: 'target_first' }), finish: 'stop', block: false }) });
    expect(configured.status).toBe(200);
    const before = await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { generationCalls: number };
    const scopeId = 'http_crash_' + sequence++, file = 'http-crash-' + scopeId + '.sqlite';
    const worker = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-v3/application-host-worker.ts',
      fixture, file, scopeId, stage, host.endpoint, host.hostGeneration, host.modelDigest], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TSX_DISABLE_CACHE: '1', TEMP: fixture, TMP: fixture },
    });
    const crashed = await new Promise<{ marker: string; taskId: string; dispatches: number }>((resolve, reject) => {
      let stdout = '', stderr = '', expired = false;
      const timer = setTimeout(() => { expired = true; worker.kill(); }, 12000);
      worker.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 8192) worker.kill(); });
      worker.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('close', code => { clearTimeout(timer);
        if (expired || code !== 66) { reject(Error('owned-application-worker:' + code + ':' + stderr)); return; }
        try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
      });
    });
    expect(crashed.marker).toBe('owned-application-host-crash');
    const probe = new AstraJournal(path.join(fixture, file));
    const expiresAt = (probe.read('scheduler_' + scopeId)!.checkpoint as { expiresAt: number }).expiresAt; probe.close();
    const wait = Math.max(0, expiresAt - Date.now() + 25); expect(wait).toBeLessThan(2000);
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const s = await setup({ file: path.join(fixture, file), scopeId });
    try {
      await s.facade.drain();
      const response = await fetch(s.base + route + '?conversationId=conversation_first', { headers: apiHeaders });
      expect(response.status).toBe(200);
      const views = (await response.json() as { tasks: AstraReadHttpTask[] }).tasks;
      expect(views).toHaveLength(1); expect(views[0]).toMatchObject({ id: crashed.taskId, status: 'completed',
        message: { predecessorMessageId: 'message_first', conversationId: 'conversation_first', delivery: 'pending' } });
      const after = await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { generationCalls: number };
      expect(after.generationCalls - before.generationCalls).toBe(1);
      expect(s.calls()).toBe(stage === 'admitted' ? 1 : 0); expect(crashed.dispatches + s.dispatch.mock.calls.length).toBe(1);
      expect(s.facade.hostStatus()).toEqual({ phase: 'running', recoveryScheduled: false });
    } finally { await s.close(); }
  }, 20000);

  it('requires explicit lifecycle start and reacquires an expired idle lease only on an authenticated mutation', async () => {
    let now = Date.now(); const s = await setup({ start: false, now: () => now });
    try {
      expect((await post(s.base)).status).toBe(503); expect(s.scheduler.list()).toHaveLength(0); expect(s.calls()).toBe(0);
      s.facade.start(); const first = await task(await post(s.base)); await s.facade.drain();
      const scope = 'scheduler_' + s.options.scopeId, frontier = s.journal.read(scope)!;
      now += 1001; expect(s.scheduler.ownerIsCurrent()).toBe(false);
      expect((await task(await fetch(s.base + route + '/' + first.id + query, { headers: apiHeaders }))).status).toBe('completed');
      expect(s.journal.read(scope)).toEqual(frontier); expect(s.facade.hostStatus().recoveryScheduled).toBe(false);
      const next = await post(s.base, route, { ...request, clientRequestId: 'second_request', inputMessageId: 'second_message' });
      expect(next.status).toBe(202); await s.facade.drain();
      expect(s.scheduler.ownerIsCurrent()).toBe(true); expect(s.calls()).toBe(2); expect(s.dispatch).toHaveBeenCalledTimes(2);
    } finally { await s.close(); }
  });

  it('discovers durable conversation results after client reconnect without revealing another actor or conversation', async () => {
    const s = await setup();
    try {
      const first = await task(await post(s.base)); await s.facade.drain();
      const collection = route + '?conversationId=' + request.conversationId, capacity = s.journal.capacity();
      const read = await fetch(s.base + collection, { headers: apiHeaders }); expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ tasks: [{ id: first.id, status: 'completed', message: { delivery: 'pending' } }] });
      expect(await (await fetch(s.base + collection.replace('conversation_first', 'other'), { headers: apiHeaders })).json()).toMatchObject({ tasks: [] });
      expect(await (await fetch(s.base + collection, { headers: { ...apiHeaders, 'x-monarch-desktop-attestation': desktopToken } })).json()).toMatchObject({ tasks: [] });
      expect((await fetch(s.base + collection + '&conversationId=another', { headers: apiHeaders })).status).toBe(400);
      expect(s.journal.capacity()).toEqual(capacity); expect(s.calls()).toBe(1); expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('rejects late admission during stop and retains unknown native work rather than certifying shutdown as completion', async () => {
    const s = await setup({ block: true });
    try {
      const before = await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { generationCalls: number };
      const first = await task(await post(s.base));
      await waitFor(async () => {
        const value = await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { generationCalls: number; workerStarted: boolean };
        return value.generationCalls > before.generationCalls && value.workerStarted;
      });
      const stopped = s.facade.stop(); expect(s.facade.stop()).toBe(stopped);
      expect((await post(s.base, route, { ...request, clientRequestId: 'late', inputMessageId: 'late' })).status).toBe(503);
      expect(await stopped).toEqual({ unresolvedWork: 1 });
      const view = await task(await fetch(s.base + route + '/' + first.id + query, { headers: apiHeaders }));
      expect(view.message).toBeUndefined(); expect(view.runtimeIssue).toBe('host-unavailable'); expect(s.dispatch).not.toHaveBeenCalled();
      expect(() => s.facade.start()).toThrow('astra-host-stopped');
      expect((await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { slotReserved: boolean }).slotReserved).toBe(true);
    } finally { await s.close(); }
  });
  it('delivers one source-bound result over actual HTTP, replays requests, and acknowledges exact proof', async () => {
    const s = await setup();
    try {
      const admitted = await post(s.base); expect(admitted.status).toBe(202); expect(admitted.headers.get('cache-control')).toBe('no-store');
      const first = await task(admitted); await s.facade.drain();
      const done = await task(await fetch(s.base + route + '/' + first.id + query, { headers: apiHeaders }));
      expect(done).toMatchObject({ status: 'completed', conversationId: request.conversationId, inputMessageId: request.inputMessageId,
        modelJobs: 1, readJobs: 1, source: 'api', nativeCompletionCertified: false,
        message: { conversationId: request.conversationId, predecessorMessageId: request.inputMessageId, delivery: 'pending', verification: 'internal-read-certificate' } });
      for (const forbidden of ['Private synthetic', 'synthetic.txt', root, apiToken, desktopToken, 'checkpointRef', 'userText']) expect(JSON.stringify(done)).not.toContain(forbidden);
      expect(s.catalog.resolve.mock.calls[0]).toMatchObject(['selection_first', { conversationId: request.conversationId, inputMessageId: request.inputMessageId, text: request.text,
        actor: { source: 'api', id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) } }]);
      expect((await task(await post(s.base))).id).toBe(first.id); await s.facade.drain();
      for (const patch of [{ text: 'changed' }, { conversationId: 'another' }, { inputMessageId: 'another' }, { clientRequestId: 'another' }]) {
        expect((await post(s.base, route, { ...request, ...patch })).status).toBe(409);
      }
      expect((await post(s.base, route + '/' + first.id + '/ack', { ...context, certificateDigest: 'sha256:' + '0'.repeat(64) })).status).toBe(409);
      const ack = { ...context, certificateDigest: done.message!.certificateDigest };
      for (let count = 0; count < 2; count++) expect((await task(await post(s.base, route + '/' + first.id + '/ack', ack))).message!.delivery).toBe('acknowledged');
      const record = s.journal.read(first.id)!.checkpoint as unknown as AstraModelReadTaskRecord;
      expect(s.journal.reservation(record.reservationId)).toBeNull();
      expect(s.calls()).toBe(1); expect(s.dispatch).toHaveBeenCalledTimes(1); expect(s.appAccess).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('rejects unauthenticated, foreign-origin, disabled-auth and source-spoofing input before admission', async () => {
    const s = await setup();
    try {
      const capacity = s.journal.capacity();
      for (const auth of ['', 'Bearer wrong']) expect((await post(s.base, route, request, { ...apiHeaders, Authorization: auth })).status).toBe(401);
      expect((await post(s.base, route, request, { ...apiHeaders, Origin: 'https://foreign.invalid' })).status).toBe(403);
      const unprotected = await s.http({ requireApiToken: false }); expect((await post(unprotected)).status).toBe(401);
      for (const patch of [{ source: 'desktop' }, { actor: { id: 'forged' } }, { paths: ['outside'] },
        { privacyMode: 'incognito' }, { privacyMode: 'encrypted' }, { text: '\ud800' }, { text: 'x'.repeat(8193) }]) {
        expect((await post(s.base, route, { ...request, ...patch })).status).toBe(400);
      }
      expect(s.journal.capacity()).toEqual(capacity); expect(s.scheduler.list()).toHaveLength(0);
      expect(s.calls()).toBe(0); expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('is absent without explicit injection, without touching ordinary Application methods', async () => {
    const s = await setup();
    try { const base = await s.http({ enabled: false }); const response = await post(base);
      expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: 'astra-runtime-disabled' });
      expect(s.appAccess).not.toHaveBeenCalled(); expect(s.scheduler.list()).toHaveLength(0);
    } finally { await s.close(); }
  });

  it('requires the same authenticated actor and exact conversation/message for reads and commands', async () => {
    const s = await setup();
    try {
      const first = await task(await post(s.base)); await s.facade.drain(); const taskRoute = route + '/' + first.id;
      const another = await s.http({ apiToken: 'other-owned-fixture-token' });
      expect((await fetch(another + taskRoute + query, { headers: { Authorization: 'Bearer other-owned-fixture-token' } })).status).toBe(404);
      const desktopHeaders = { ...apiHeaders, 'x-monarch-desktop-attestation': desktopToken };
      expect((await fetch(s.base + taskRoute + query, { headers: desktopHeaders })).status).toBe(404);
      for (const action of ['pause', 'resume', 'cancel', 'reconcile', 'ack']) {
        expect((await post(s.base, taskRoute + '/' + action, { ...context, ...(action === 'ack' ? { certificateDigest: 'sha256:' + '0'.repeat(64) } : {}) }, desktopHeaders)).status).toBe(404);
      }
      expect((await fetch(s.base + taskRoute + query.replace('conversation_first', 'another'), { headers: apiHeaders })).status).toBe(404);
      expect((await fetch(s.base + taskRoute + query.replace('message_first', 'another'), { headers: apiHeaders })).status).toBe(404);
      for (const invalid of ['', query + '&inputMessageId=message_first', query + '&source=desktop']) {
        expect((await fetch(s.base + taskRoute + invalid, { headers: apiHeaders })).status).toBe(400);
      }
      const desktopTask = await task(await post(s.base, route, request, desktopHeaders)); await s.facade.drain();
      expect(desktopTask.source).toBe('desktop'); expect(desktopTask.id).not.toBe(first.id);
      expect((await fetch(s.base + route + '/' + desktopTask.id + query, { headers: apiHeaders })).status).toBe(404);
      expect(s.calls()).toBe(2); expect(s.dispatch).toHaveBeenCalledTimes(2);
    } finally { await s.close(); }
  });

  it('bounds JSON body bytes and rejects malformed UTF-8 before writing any source', async () => {
    const s = await setup();
    try {
      expect((await post(s.base, route, { ...request, text: 'x'.repeat(66000) })).status).toBe(413);
      expect((await post(s.base, route, request, { ...apiHeaders, 'Content-Type': 'text/plain' })).status).toBe(415);
      expect((await fetch(s.base + route, { method: 'POST', headers: apiHeaders, body: Buffer.from([0xff, 0xfe]) })).status).toBe(400);
      expect(s.scheduler.list()).toHaveLength(0); expect(s.calls()).toBe(0);
    } finally { await s.close(); }
  });

  it('bounds a chunked body and survives a disconnected body sender without touching the application', async () => {
    const s = await setup();
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = rawHttpRequest(s.base + route, { method: 'POST', headers: { ...apiHeaders, 'Transfer-Encoding': 'chunked' } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        outgoing.on('error', reject); outgoing.write('x'.repeat(32768)); outgoing.end('x'.repeat(32769));
      });
      expect(status).toBe(413);
      await new Promise<void>(resolve => {
        const outgoing = rawHttpRequest(s.base + route, { method: 'POST', headers: { ...apiHeaders, 'Content-Length': '1000' } });
        outgoing.on('error', () => undefined); outgoing.on('close', resolve);
        outgoing.write('{"version":1,'); setTimeout(() => outgoing.destroy(), 25);
      });
      expect((await fetch(s.base + '/api/ready')).status).toBe(200);
      expect(s.scheduler.list()).toHaveLength(0); expect(s.calls()).toBe(0); expect(s.appAccess).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('rolls source, message uniqueness, Goal, queue and reservations back after all SQLite writes but before commit', async () => {
    const s = await setup();
    try {
      const capacity = s.journal.capacity(), append = s.journal.appendAtomic.bind(s.journal);
      let checks = 0;
      const fault = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((input, guard) => {
        if (hasEvent(input, 'application.source-admitted')) return append(input, () => ++checks === 1 && (!guard || guard()));
        return append(input, guard);
      });
      expect((await post(s.base)).status).toBe(500); fault.mockRestore();
      expect(checks).toBe(2);
      expect(s.journal.capacity()).toEqual(capacity); expect(s.scheduler.list()).toHaveLength(0); expect(s.calls()).toBe(0);
      const retried = await post(s.base); expect(retried.status).toBe(202); await s.facade.drain();
      expect((await task(await fetch(s.base + route + '/' + (await task(retried)).id + query, { headers: apiHeaders }))).status).toBe('completed');
      expect(s.calls()).toBe(1); expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it.each(['task.model-decision-linked', 'task.certified'])('exposes progression failure at %s and recovers without repeating completed calls', async event => {
    const s = await setup();
    try {
      const append = s.journal.appendAtomic.bind(s.journal); let failures = 0;
      const fault = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((input, guard) => {
        if (hasEvent(input, event)) { failures++; throw Error('injected-progression-failure'); } return append(input, guard);
      });
      const first = await task(await post(s.base));
      await waitFor(async () => (await task(await fetch(s.base + route + '/' + first.id + query, { headers: apiHeaders }))).runtimeIssue === 'progression-failed');
      const pending = await task(await fetch(s.base + route + '/' + first.id + query, { headers: apiHeaders }));
      expect(pending.message).toBeUndefined(); expect(failures).toBeGreaterThan(0); expect(s.calls()).toBe(1);
      fault.mockRestore(); expect((await post(s.base, route + '/' + first.id + '/reconcile', context)).status).toBe(200);
      await s.facade.drain(); const done = await task(await fetch(s.base + route + '/' + first.id + query, { headers: apiHeaders }));
      expect(done.status).toBe('completed'); expect(done.runtimeIssue).toBeUndefined();
      expect(s.calls()).toBe(1); expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('revalidates the host selection after generation and prevents a revoked Kernel read', async () => {
    const s = await setup({ block: true });
    try {
      const first = await task(await post(s.base)); await waitFor(async () => s.calls() === 1);
      s.revoke(); await s.release(); await s.facade.drain();
      const done = await task(await fetch(s.base + route + '/' + first.id + query, { headers: apiHeaders }));
      expect(done.status).toBe('blocked'); expect(done.readJobs).toBe(0); expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(['pause', 'cancel'] as const)('applies %s through the authenticated HTTP route while native work is active', async command => {
    const s = await setup({ block: true });
    try {
      const before = await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { generationCalls: number };
      const first = await task(await post(s.base)), taskRoute = route + '/' + first.id;
      await waitFor(async () => {
        const value = await (await fetch(host.endpoint + '/__fixture/metrics', { headers: modelHeaders })).json() as { generationCalls: number; workerStarted: boolean };
        return value.generationCalls > before.generationCalls && value.workerStarted;
      });
      const controlled = await post(s.base, taskRoute + '/' + command, context); expect(controlled.status).toBe(200);
      expect((await task(controlled)).message).toBeUndefined();
      await s.release(); await s.facade.drain();
      let view = await task(await fetch(s.base + taskRoute + query, { headers: apiHeaders }));
      if (command === 'pause') {
        expect(view.status).toBe('paused'); expect(view.message).toBeUndefined(); expect(s.dispatch).not.toHaveBeenCalled();
        expect((await post(s.base, taskRoute + '/resume', context)).status).toBe(200); await s.facade.drain();
        view = await task(await fetch(s.base + taskRoute + query, { headers: apiHeaders }));
        expect(view.status).toBe('completed'); expect(s.dispatch).toHaveBeenCalledTimes(1);
      } else {
        // The host now obtains physical acknowledgement automatically; repeated
        // read-only GETs cannot themselves drive recovery or repeat native work.
        await waitFor(async () => (await task(await fetch(s.base + taskRoute + query, { headers: apiHeaders }))).status === 'cancelled');
        const reconciled = await post(s.base, taskRoute + '/reconcile', context); expect(reconciled.status).toBe(200);
        view = await task(reconciled); expect(view.status).toBe('cancelled'); expect(s.dispatch).not.toHaveBeenCalled();
      }
      expect(s.calls()).toBe(1);
    } finally { await s.close(); }
  });

  it('reopens HTTP result delivery with exact credential/source binding and no model or catalog access', async () => {
    const file = path.join(fixture, 'http-reopen-' + sequence++ + '.sqlite'), s = await setup({ file });
    const first = await task(await post(s.base)); await s.facade.drain();
    const done = await task(await fetch(s.base + route + '/' + first.id + query, { headers: apiHeaders })); await s.close();
    const journal = new AstraJournal(file), kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    const noNetwork = vi.fn<typeof fetch>(async () => { throw Error('historical-model-access-forbidden'); });
    const noCatalog = vi.fn(() => { throw Error('historical-catalog-access-forbidden'); });
    const facade = new MonarchAstraReadTaskFacade({ ...s.options, journal, kernel, catalog: { resolve: noCatalog },
      client: new AstraPreparedModelClient({ ...s.clientOptions, fetch: noNetwork }) });
    const scheduler = new AstraWorkScheduler({ ...s.schedulerOptions, journal, adapters: facade.adapters }); facade.attach(scheduler); facade.start();
    const server = createMonarchHttpServer({ app: new Proxy({} as MonarchApplication, { get: s.appAccess }), publicDirectory: root,
      host: '127.0.0.1', port: 4317, apiToken, desktopAttestationToken: desktopToken, requireApiToken: true, allowNonLoopbackMutations: false, astraReadTasks: facade });
    const base = await listen(server);
    try {
      expect(await task(await fetch(base + route + '/' + first.id + query, { headers: apiHeaders }))).toEqual(done);
      expect((await task(await post(base, route + '/' + first.id + '/ack', { ...context, certificateDigest: done.message!.certificateDigest }))).message!.delivery).toBe('acknowledged');
      expect(noNetwork).not.toHaveBeenCalled(); expect(noCatalog).not.toHaveBeenCalled(); expect(s.appAccess).not.toHaveBeenCalled();
    } finally { await closeServer(server); await facade.stop(); journal.close(); }
  });
});
