import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AstraJournal, type AstraJson } from '../../src/agent-v3/journal';
import type { AstraContextPlan, AstraContextSource } from '../../src/agent-v3/context-engine';
import { AstraPreparedModelClient } from '../../src/agent-v3/prepared-model-client';
import { AstraModelHostProvider } from '../../src/agent-v3/model-host-provider';
import { decideAstraReadWithModel } from '../../src/agent-v3/read-model-decision';
import { astraReadDecisionSchema, type AstraReadCandidate } from '../../src/agent-v3/read-decision-gateway';
import { AstraReadRuntime } from '../../src/agent-v3/read-runtime';
import { MonarchKernel } from '../../src/core/kernel';
import { WorkspaceModule } from '../../src/modules/workspace';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';
import { AstraModelWorkAdapter, type AstraModelWorkInput, type AstraModelWorkCheckpoint } from '../../src/agent-v3/model-work-adapter';
import { astraAgentCapabilityCatalog, type AstraAgentCapabilityCandidate } from '../../src/agent-v3/agent-decision-gateway';
import { AstraAgentTaskProfile, astraAgentHistoryTail, astraAgentTaskId,
  ASTRA_AGENT_HISTORY_MAX_BYTES } from '../../src/agent-v3/agent-task-profile';
import { AstraWorkScheduler } from '../../src/agent-v3/work-scheduler';
import { astraTaskFaultCode, astraTaskFaultReason, type AstraTaskFaultPolicy } from '../../src/agent-v3/task-fault';
import { AstraReadWorkAdapter } from '../../src/agent-v3/read-work-adapter';
import { ASTRA_PRODUCT_PILOT_MODE, createAstraProductPilotRuntime } from '../../src/app/astra-product-pilot';
import { OscarTurnCoordinator } from '../../src/oscar-turn/coordinator';
import { InMemoryOscarTurnStore } from '../../src/oscar-turn/turn-store';
import { MonarchApplication } from '../../src/app/application';
import { GmailModule } from '../../src/modules/gmail';
import { GitHubModule } from '../../src/modules/github';
import { CalendarModule } from '../../src/modules/calendar';
import { CoderModule } from '../../src/modules/coder';

// Real disposable Python HTTP host + existing inference coordinator + actual
// llama.cpp formatter/grammar. Token vocabulary and generated text are synthetic.
// Real Kernel reads below touch only this exact marked D-backed child.
const marker = 'astra-v3-prepared-model-synthetic-only';
const headers = { Authorization: 'Bearer astra-synthetic-test', 'Content-Type': 'application/json' };
const readDecision = { kind: 'read', requirementId: 'read_requirement', capabilityHandle: 'read_handle', targetHandle: 'file_handle' };
let parent: string, fixture: string, root: string, server: ChildProcessWithoutNullStreams;
let host: { marker: string; endpoint: string; hostGeneration: string; modelDigest: string };
let sequence = 0;

beforeAll(async () => {
  parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  fixture = await realpath(await mkdtemp(path.join(parent, 'astra-v3-prepared-model-')));
  expect(path.dirname(fixture)).toBe(parent);
  await writeFile(path.join(fixture, '.fixture-marker'), marker, { flag: 'wx' });
  root = path.join(fixture, 'workspace'); await mkdir(root);
  await writeFile(path.join(root, 'synthetic.txt'), 'x'.repeat(4103), { flag: 'wx' });
  server = spawn(path.resolve('oscar/.venv/Scripts/python.exe'), ['-B', path.resolve('tests/fixtures/agent-v3/model-server.py'), fixture],
    { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  server.stdin.end();
  host = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => reject(new Error('synthetic-model-host-startup-deadline')), 15000);
    server.once('error', reject);
    server.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 32768) reject(new Error('fixture-stderr-budget')); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`synthetic-model-host-exit:${code}:${stderr.slice(0,1000)}`)); });
    server.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.length > 32768) { clearTimeout(timer); reject(new Error('fixture-stdout-budget')); return; }
      if (stdout.includes('\n')) {
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))); } catch { reject(new Error('fixture-startup-json')); }
      }
    });
  });
  expect(host.marker).toBe(marker); expect(host.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
}, 20000);

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
    server.kill(); await exited; // Only the exact child started by this suite.
  }
  if (!fixture) return;
  expect(await realpath(fixture)).toBe(fixture); expect(path.dirname(fixture)).toBe(parent);
  expect(path.basename(fixture).startsWith('astra-v3-prepared-model-')).toBe(true);
  expect(await readFile(path.join(fixture, '.fixture-marker'), 'utf8')).toBe(marker);
  await rm(fixture, { recursive: true, force: false });
});

function client(transport?: typeof fetch) {
  return new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: host.endpoint,
    bearerToken: 'astra-synthetic-test', hostGeneration: host.hostGeneration, timeoutMs: 10000,
    ...(transport ? { fetch: transport } : {}) });
}
function source(executionId = 'model_execution_' + sequence++): AstraContextSource {
  return { executionId, revision: 1, mandatory: [
    { ref: 'goal', kind: 'goal', text: 'Read the exact synthetic file. Return factual bytes only after a Kernel receipt.' },
    { ref: 'authority', kind: 'authority', text: 'One read-only selected target. Model proposals have no execution authority.' },
    { ref: 'workflow', kind: 'workflow', text: 'read_requirement pending' },
    { ref: 'budget', kind: 'budget', text: 'One model decision, one bounded Kernel read.' },
  ], optional: [] };
}
const candidates: AstraReadCandidate[] = [{ handle: 'read_handle', requirementId: 'read_requirement', targetHandle: 'file_handle',
  request: { requestId: 'model_pinned_read', relativePath: 'synthetic.txt', maxBytes: 8192 } }];
function options(journal: AstraJournal, input = source(), transport?: typeof fetch) {
  return { deployment: 'isolated-validation' as const, client: client(transport), journal, source: input,
    candidates, requestId: 'model_request_' + sequence++, expectedModelDigest: host.modelDigest,
    controlEpoch: 1, catalogRevision: 1, isCurrent: () => true,
    limits: { reservedOutputTokens: 256, tokenizerTimeoutMs: 3000 }, turnTimeoutMs: 10000 };
}
async function control(output = JSON.stringify(readDecision), extra: { finish?: 'stop' | 'length'; block?: boolean } = {}) {
  const response = await fetch(host.endpoint + '/__fixture/control', { method: 'POST', headers, body: JSON.stringify({ output, ...extra }) });
  expect(response.status).toBe(200); expect((await response.json() as { syntheticOnly: boolean }).syntheticOnly).toBe(true);
}
async function metrics() {
  return await (await fetch(host.endpoint + '/__fixture/metrics', { headers })).json() as {
    generationCalls: number; tokenizationCalls: number; lastSubmittedTokenCount: number; slotReserved: boolean; workerStarted: boolean; memoryRejections: number };
}
async function release() { await fetch(host.endpoint + '/__fixture/release', { method: 'POST', headers }); }
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error('fixture-condition-deadline'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

function modelWorkSetup(options: { file?: string; current?: () => boolean; transport?: typeof fetch; scopeId?: string; now?: () => number; modelClient?: AstraPreparedModelClient } = {}) {
  const journal = new AstraJournal(options.file ?? ':memory:'), scopeId = options.scopeId ?? 'model_work_scope_' + sequence++;
  const adapter = new AstraModelWorkAdapter({ deployment: 'isolated-validation', journal, client: options.modelClient ?? client(options.transport),
    isSourceCurrent: options.current ?? (() => true) });
  const hostOptions = { deployment: 'isolated-validation' as const, journal, scopeId, adapters: [adapter],
    limits: { leaseMs: 1000, activationTimeoutMs: 5000 }, ...(options.now ? { now: options.now } : {}) };
  const scheduler = new AstraWorkScheduler(hostOptions); scheduler.acquire();
  const submit = (overrides: Partial<AstraModelWorkInput> = {}) => scheduler.submit({ requestId: 'work_request_' + sequence++,
    adapterId: adapter.id, input: JSON.parse(JSON.stringify({ source: source(), candidates, catalogRevision: 1,
      expectedModelDigest: host.modelDigest, maxOutputTokens: 256, timeoutMs: 5000, maxAttempts: 2,
      contextLimits: { tokenizerTimeoutMs: 1000 }, ...overrides })) as AstraJson });
  let closed = false;
  return { journal, adapter, scheduler, hostOptions, submit,
    close: async () => { if (!closed) { await scheduler.close(); journal.close(); closed = true; } } };
}

describe('Astra V3 durable model work on the common scheduler', () => {
  it('replays residency rejection once only after old-process exit proof', async () => {
    await control();
    let exited = false, oldOpens = 0;
    const initial = { endpoint: host.endpoint, bearerToken: 'astra-synthetic-test',
      hostGeneration: 'old_fixture_host', hostPid: 101, modelDigest: host.modelDigest };
    const provider = new AstraModelHostProvider(initial, {
      discover: async () => exited ? { ...initial, hostGeneration: host.hostGeneration, hostPid: 102 } : initial,
      exited: binding => binding.hostPid === 101 && exited,
    });
    const transport: typeof fetch = async (input, init) => {
      if (!exited && String(input).endsWith('/model-turns') && init?.method === 'POST') {
        oldOpens++;
        return new Response(JSON.stringify({ detail: { code: 'model-tier-recycle-required' } }), {
          status: 409, headers: { 'Content-Type': 'application/json' },
        });
      }
      return fetch(input, init);
    };
    const setup = modelWorkSetup({ modelClient: new AstraPreparedModelClient({ deployment: 'isolated-validation',
      ...initial, hostProvider: provider, fetch: transport }) });
    try {
      const job = setup.submit();
      await setup.scheduler.drain();
      expect(setup.scheduler.job(job.id).state).toBe('indeterminate');
      await setup.scheduler.reconcileRemote(job.id, 20);
      expect(setup.scheduler.job(job.id).state).toBe('indeterminate');
      expect(oldOpens).toBe(1);
      exited = true;
      await setup.scheduler.reconcileRemote(job.id);
      await setup.scheduler.drain();
      expect(setup.scheduler.job(job.id).state).toBe('observed');
      expect(setup.adapter.decision(job.input)?.status).toBe('accepted');
      await setup.scheduler.drain();
      expect(oldOpens).toBe(1);
    } finally { await setup.close(); }
  });

  it('runs the generic agent decision family through the prepared model transport without dispatch authority', async () => {
    const agentCandidates: AstraAgentCapabilityCandidate[] = [{ handle: 'workspace_root_handle',
      capabilityId: 'workspace.root.get', moduleId: 'workspace', title: 'Workspace root',
      description: 'Return the current workspace root.', risk: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
    await control(JSON.stringify({ kind: 'act', capabilityHandle: 'workspace_root_handle', argsJson: '{}', reason: 'Inspect the active root.' }));
    const before = await metrics(), journal = new AstraJournal(':memory:');
    const adapter = new AstraModelWorkAdapter({ deployment: 'isolated-validation', journal, client: client(),
      decisionFamily: 'agent', isSourceCurrent: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId: 'agent_model_family_' + sequence++, adapters: [adapter], limits: { activationTimeoutMs: 5000 } });
    scheduler.acquire();
    try {
      const job = scheduler.submit({ requestId: 'agent_model_request_' + sequence++, adapterId: adapter.id,
        input: JSON.parse(JSON.stringify({ source: source(), candidates: [], agentCandidates, agentEvidence: [],
          catalogRevision: 1, expectedModelDigest: host.modelDigest, maxOutputTokens: 256, timeoutMs: 5000,
          contextLimits: { tokenizerTimeoutMs: 1000 } })) as AstraJson });
      await scheduler.drain();
      const settled = scheduler.job(job.id);
      expect(settled.state, JSON.stringify({ reason: settled.reason, result: settled.result })).toBe('observed');
      expect(adapter.decision(job.input)).toMatchObject({ status: 'accepted', authority: 'none', proposal: {
        kind: 'act', capabilityId: 'workspace.root.get', args: {}, reason: 'Inspect the active root.',
      } });
      expect((await metrics()).generationCalls - before.generationCalls).toBe(1);
    } finally { await scheduler.close(); journal.close(); }
  });

  it('binds the exact bounded conversation tail to untrusted model context, never Kernel authority', async () => {
    const longTail = Array.from({ length: 26 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: 'history-' + index }));
    const history = astraAgentHistoryTail(longTail);
    expect(history).toEqual(longTail.slice(-24));
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(ASTRA_AGENT_HISTORY_MAX_BYTES);
    expect(astraAgentHistoryTail([{ role: 'user', content: 'older' },
      { role: 'assistant', content: 'я'.repeat(20_000) }])).toEqual([]);

    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const candidate: AstraAgentCapabilityCandidate = { handle: 'history_workspace_root_handle', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } };
    const scopeId = 'agent_history_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle: candidate.handle, argsJson: '{}',
        reason: 'Inspect the active workspace root.' }));
      const task = profile.submit({ requestId: 'history_context', finishWithinMs: 30_000, source: {
        interactionId: 'history_context_interaction', messageId: 'history_context_message', revision: 1,
        userText: 'Продолжи задачу с учетом предыдущего диалога.', surface: 'desktop', history,
        initialEvidence: [{ ref: 'agent_attachment_0', digest: 'sha256:' + 'a'.repeat(64),
          text: JSON.stringify({ name: 'report.txt', content: 'immutable user data' }) }],
        specification: { schemaVersion: 'monarch.astra-v3-agent-task-specification.v1',
          expectedOutputs: [{ id: 'bounded_answer', description: 'Вернуть проверяемый ответ.', kind: 'answer', required: true }],
          constraints: [{ description: 'Не изменять рабочую область.', kind: 'scope' }],
          budgets: { maxModelTurns: 3, maxToolCalls: 1, maxWallTimeMs: 30_000 } },
      } });
      const modelEnvelope = scheduler.job(task.activeJobId).input as unknown as { model: AstraModelWorkInput };
      const goal = JSON.parse(modelEnvelope.model.source.mandatory.find(item => item.ref === 'agent_goal')!.text);
      const workflow = JSON.parse(modelEnvelope.model.source.mandatory.find(item => item.ref === 'agent_workflow')!.text);
      expect(goal.explicitTaskSpecification).toMatchObject({
        expectedOutputs: [{ id: 'bounded_answer', description: 'Вернуть проверяемый ответ.' }],
        constraints: [{ description: 'Не изменять рабочую область.' }],
        budgets: { maxModelTurns: 3, maxToolCalls: 1, maxWallTimeMs: 30_000 },
      });
      expect(goal.specificationDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(workflow.instruction).toContain('fresh receipts and the live catalog');
      expect(workflow.instruction).toContain('do not ask the user to provide tools');
      expect((journal.read(task.taskId)!.checkpoint as any).policy).toMatchObject({ maxModelTurns: 3, maxCapabilityCalls: 1 });
      // The task keeps the whole bounded tail; each model round carries only the
      // newest six messages, so a long chat cannot inflate every round.
      expect((journal.read(task.taskId)!.checkpoint as any).history).toEqual(history);
      expect(modelEnvelope.model.source.optional.map(item => item.ref))
        .toEqual(Array.from({ length: 6 }, (_, index) => 'agent_history_' + (18 + index)));
      expect(modelEnvelope.model.source.optional.map(item => JSON.parse(item.text))).toEqual(history.slice(-6).map(message => ({
        role: message.role, content: message.content, untrusted: true, authorityEligible: false,
      })));
      expect(modelEnvelope.model.source.mandatory.find(item => item.ref === 'agent_attachment_0')).toMatchObject({ kind: 'evidence' });
      expect(JSON.parse(modelEnvelope.model.source.mandatory.find(item => item.ref === 'agent_attachment_0')!.text))
        .toMatchObject({ digest: 'sha256:' + 'a'.repeat(64), untrusted: true, authorityEligible: false,
          instructionsAllowed: false });
      await scheduler.drain(); const capabilityTask = profile.synchronize(task.taskId);
      expect(capabilityTask.phase).toBe('capability');
      const capabilityEnvelope = scheduler.job(capabilityTask.activeJobId).input as unknown as {
        capability: { source: Record<string, unknown> } };
      expect(Object.keys(capabilityEnvelope.capability.source).sort()).toEqual(
        ['interactionId', 'messageId', 'revision', 'surface', 'taskId', 'userText'].sort());
      expect(capabilityEnvelope.capability.source).not.toHaveProperty('history');
      expect(capabilityEnvelope.capability.source).not.toHaveProperty('initialEvidence');
      expect(profile.command(task.taskId, 'cancel')).toMatchObject({ status: 'cancelled', phase: 'settled' });
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('bounds each carried history message and marks the cut', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const candidate: AstraAgentCapabilityCandidate = { handle: 'history_bound_handle', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } };
    const scopeId = 'agent_history_bound_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    try {
      const history = [{ role: 'user' as const, content: 'Короткий вопрос.' },
        { role: 'assistant' as const, content: 'ё'.repeat(5_000) }];
      const task = profile.submit({ requestId: 'history_bound', finishWithinMs: 30_000, source: {
        interactionId: 'history_bound_interaction', messageId: 'history_bound_message', revision: 1,
        userText: 'Продолжи.', surface: 'desktop', history } });
      const carried = (scheduler.job(task.activeJobId).input as unknown as { model: AstraModelWorkInput })
        .model.source.optional.map(item => JSON.parse(item.text));
      expect(carried[0]).toEqual({ role: 'user', content: 'Короткий вопрос.', untrusted: true, authorityEligible: false });
      expect(carried[1]).toMatchObject({ role: 'assistant', truncated: true });
      expect(Buffer.byteLength(carried[1].content)).toBeLessThanOrEqual(1200);
      expect(profile.command(task.taskId, 'cancel')).toMatchObject({ status: 'cancelled' });
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('ends the task when its owner abandons the work instead of leaving it without an outcome', async () => {
    // A task host that gives up on a job used to only forget it. The job stayed
    // non-terminal, so the task above it never finished and the person saw a
    // turn that never ended and a Stop that did nothing.
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const candidate: AstraAgentCapabilityCandidate = { handle: 'abandon_workspace_root_handle',
      capabilityId: capability.id, moduleId: capability.moduleId, title: capability.title,
      description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } };
    const scopeId = 'agent_abandon_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    try {
      const task = profile.submit({ requestId: 'abandoned_task', finishWithinMs: 30_000, source: {
        interactionId: 'abandoned_interaction', messageId: 'abandoned_message', revision: 1,
        userText: 'Сделай работу, которую исполнитель бросит.', surface: 'desktop' } });
      expect(task.status).not.toBe('blocked');

      // Two rounds, because a first abandoned round is still worth one repair.
      let view = task;
      for (let round = 0; round < 2 && view.status !== 'blocked'; round++) {
        expect(scheduler.abandon(view.activeJobId, 'agent-runtime-host-retired').state).toBe('blocked');
        view = profile.synchronize(view.taskId);
      }

      expect(view).toMatchObject({ status: 'blocked', phase: 'settled',
        stopReason: 'agent-runtime-host-retired' });
      // Nothing was claimed to have run on the person's machine.
      expect(view.evidence ?? []).toHaveLength(0);
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('runs a durable generic V3 model → Kernel receipt → model completion cycle', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const agentCandidates: AstraAgentCapabilityCandidate[] = [{ handle: 'workspace_root_handle',
      capabilityId: capability.id, moduleId: capability.moduleId, title: capability.title,
      description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } }];
    let sourceCurrent = true;
    const scopeId = 'agent_cycle_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => agentCandidates, isSourceCurrent: () => sourceCurrent,
      isCapabilityAllowed: candidate => candidate.id === capability.id });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    const dispatch = vi.spyOn(kernel, 'executeActionProposal'), before = await metrics();
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle: 'workspace_root_handle', argsJson: '{}',
        reason: 'Read the active workspace root.' }));
      const request = { requestId: 'generic_cycle', finishWithinMs: 30_000, source: {
        interactionId: 'generic_cycle_interaction', messageId: 'generic_cycle_message', revision: 1,
        userText: 'Проверь корень текущего проекта и сообщи результат.', surface: 'desktop',
      } } as const;
      const task = profile.submit(request);
      await scheduler.drain(); expect(profile.synchronize(task.taskId).phase).toBe('capability');
      await scheduler.drain(); expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model', modelTurns: 2, capabilityCalls: 1 });
      await control(JSON.stringify({ kind: 'complete', text: 'Корень проекта подтверждён.', evidenceRef: 'receipt_0' }));
      const finalStreams = scheduler.list()[0]!.storage.streams.map(stream => stream.streamId);
      await scheduler.drain();
      const settled = profile.synchronize(task.taskId);
      expect(settled).toMatchObject({ status: 'completed', phase: 'settled', modelTurns: 2,
        capabilityCalls: 1, responseText: 'Корень проекта подтверждён.', nativeCompletionCertified: true,
        certificate: { schemaVersion: 'monarch.astra-v3-agent-task-certificate.internal.v1', status: 'completed',
          authority: 'none', businessCompletionCertified: false, nativeCompletionCertified: true,
          receipts: [{ ref: 'receipt_0', capabilityId: capability.id, ledgerId: expect.any(String) }] },
        message: { content: 'Корень проекта подтверждён.', delivery: 'pending',
          certificateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) } });
      expect(scheduler.list()).toEqual([]);
      expect(finalStreams.every(streamId => journal.read(streamId) === null)).toBe(true);
      const archive = journal.read(task.taskId)?.checkpoint as any;
      expect(archive).toMatchObject({
        schemaVersion: 'monarch.astra-v3-agent-task-archive.internal.v2', taskId: task.taskId,
        evidence: [{ ref: 'receipt_0', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }],
        receipts: [{ ref: 'receipt_0', proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          ledgerId: expect.any(String), resultDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }],
        completion: { proposalDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          modelProgressDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u), evidenceRefs: ['receipt_0'],
          messageRef: settled.message!.id, certificateRef: expect.any(String), certificateDigest: settled.message!.certificateDigest },
        view: { status: 'completed', responseText: 'Корень проекта подтверждён.', nativeCompletionCertified: true },
      });
      expect(journal.read(archive.completion.certificateRef)?.checkpoint).toEqual(settled.certificate);
      expect(journal.read(settled.message!.id)?.checkpoint).toEqual(settled.message);
      expect(JSON.stringify(journal.read(task.taskId)?.checkpoint)).not.toContain('rounds');
      expect(profile.list()).toEqual([settled]);
      // An archived task owns no job. Recovery enumeration must skip it rather
      // than read it as a live record: that read threw per archived task and,
      // at three per pass, stopped the whole host.
      expect(profile.recoveryCandidates()).toEqual([]);
      const faults: string[] = [];
      expect(profile.recoveryCandidates({ skip: () => false, fault: (taskId, error) => {
        faults.push(taskId + '=' + String((error as Error).message)); } })).toEqual([]);
      expect(faults).toEqual([]);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await metrics()).generationCalls - before.generationCalls).toBe(2);
      expect(journal.reservation('agent_parent_' + createHash('sha256').update(task.taskId).digest('hex').slice(0, 32))).toBeNull();
      sourceCurrent = false;
      expect(profile.submit(request)).toEqual(settled);
      await scheduler.close();
      const recoveredProfile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
        kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
          maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
        resolveCandidates: () => agentCandidates, isSourceCurrent: () => false, isCapabilityAllowed: () => false });
      const recoveredScheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
        scopeId, adapters: recoveredProfile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
      recoveredScheduler.acquire(); recoveredProfile.attach(recoveredScheduler);
      try {
        expect(recoveredProfile.list()).toEqual([settled]);
        const acknowledged = recoveredProfile.acknowledgeMessage(task.taskId, settled.message!.certificateDigest);
        expect(acknowledged.message?.delivery).toBe('acknowledged');
        const acknowledgedRevision = journal.read(settled.message!.id)!.revision;
        expect(recoveredProfile.acknowledgeMessage(task.taskId, settled.message!.certificateDigest)).toEqual(acknowledged);
        expect(journal.read(settled.message!.id)!.revision).toBe(acknowledgedRevision);
        expect(recoveredProfile.submit(request)).toEqual(acknowledged);
        expect(recoveredScheduler.list()).toEqual([]);
      } finally { await recoveredScheduler.close(); }
    } finally { dispatch.mockRestore(); await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('rejects a stale accepted model read once, then repairs against a fresh receipt without dispatch', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const candidates: AstraAgentCapabilityCandidate[] = [{ handle: 'stale_receipt_root_handle',
      capabilityId: capability.id, moduleId: capability.moduleId, title: capability.title,
      description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } }];
    const scopeId = 'agent_stale_receipt_' + sequence++;
    let readCount = 0;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => candidates, isSourceCurrent: () => true, isCapabilityAllowed: () => true,
      testHooks: { modelDecisionReadIssue: () => readCount++ === 0 ? 'source-stale' : undefined } });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    const dispatch = vi.spyOn(kernel, 'executeActionProposal'), before = await metrics();
    try {
      await control(JSON.stringify({ kind: 'ask-user', question: 'Какой формат ответа использовать?' }));
      const task = profile.submit({ requestId: 'stale_receipt_repair', finishWithinMs: 30_000, source: {
        interactionId: 'stale_receipt_interaction', messageId: 'stale_receipt_message', revision: 1,
        userText: 'Подготовь ответ в подходящем формате.', surface: 'desktop' } });
      await scheduler.drain();

      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'queued', phase: 'model', modelTurns: 2 });
      const repaired = journal.read(task.taskId)?.checkpoint as any;
      expect(repaired.rounds[0]).toMatchObject({ repairCode: 'agent-decision-stale:source-stale' });
      expect(repaired.rounds[0].modelReceipt).toBeUndefined();
      await scheduler.drain();

      const view = profile.synchronize(task.taskId);
      expect(view).toMatchObject({ status: 'awaiting-input', phase: 'waiting-input', modelTurns: 2,
        question: 'Какой формат ответа использовать?' });
      const checkpoint = journal.read(task.taskId)?.checkpoint as any;
      expect(checkpoint.rounds[1].modelReceipt).toMatchObject({ taskId: task.taskId, round: 1,
        inputDigest: expect.stringMatching(/^sha256:/u), proposalDigest: expect.stringMatching(/^sha256:/u),
        schedulerProgressDigest: expect.stringMatching(/^sha256:/u), checkpointRevision: expect.any(Number),
        sourceRevision: 1, catalogRevision: expect.any(Number), policyDigest: expect.stringMatching(/^sha256:/u) });
      expect(readCount).toBe(2);
      expect(dispatch).not.toHaveBeenCalled();
      expect((await metrics()).generationCalls - before.generationCalls).toBe(2);
    } finally { dispatch.mockRestore(); await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('refuses a native Agent completion certificate when the Kernel ledger binding changed', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const candidates: AstraAgentCapabilityCandidate[] = [{ handle: 'certificate_root_handle',
      capabilityId: capability.id, moduleId: capability.moduleId, title: capability.title,
      description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } }];
    const scopeId = 'agent_certificate_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal, kernel, client: client(),
      policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => candidates, isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId,
      adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle: 'certificate_root_handle', argsJson: '{}',
        reason: 'Read the exact root.' }));
      const task = profile.submit({ requestId: 'certificate_binding', finishWithinMs: 30_000, source: {
        interactionId: 'certificate_binding_interaction', messageId: 'certificate_binding_message', revision: 1,
        userText: 'Проверь корень и заверши задачу с подтверждением.', surface: 'desktop' } });
      await scheduler.drain(); profile.synchronize(task.taskId);
      await scheduler.drain(); profile.synchronize(task.taskId);
      await control(JSON.stringify({ kind: 'complete', text: 'Корень проверен.', evidenceRef: 'receipt_0' }));
      await scheduler.drain();
      const exact = kernel.getActionLedgerRecordById.bind(kernel);
      const altered = vi.spyOn(kernel, 'getActionLedgerRecordById').mockImplementation(ledgerId => {
        const record = exact(ledgerId); return record ? { ...record, proposalHash: '0'.repeat(64) } : null;
      });
      expect(() => profile.synchronize(task.taskId)).toThrow('astra-agent-certifier:kernel-receipt');
      expect(journal.read(task.taskId)?.checkpoint).toMatchObject({
        schemaVersion: 'monarch.astra-v3-agent-task.internal.v3', phase: 'model' });
      expect(journal.read('agent_certificate_' + createHash('sha256').update(task.taskId).digest('hex').slice(0, 32))).toBeNull();
      altered.mockRestore();
      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'completed', nativeCompletionCertified: true,
        message: { delivery: 'pending' } });
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('continues beyond the former 24-call ceiling, retains only current work, then archives it', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const real: AstraAgentCapabilityCandidate = { handle: 'long_cycle_root_handle', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } };
    const decoys = Array.from({ length: 16 }, (_, index): AstraAgentCapabilityCandidate => ({
      handle: `long_cycle_decoy_${index}`, capabilityId: `long-cycle.operation.${index}`, moduleId: 'long-cycle',
      title: `Long cycle ${index}`, description: 'Synthetic catalog page.', risk: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }));
    const live = [...decoys, real], page = astraAgentCapabilityCatalog(live).pages
      .find(item => item.candidateHandles.includes(real.handle))!;
    const scopeId = 'agent_long_cycle_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 32, maxCapabilityCalls: 2 },
      resolveCandidates: () => live, isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 4, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler); const before = await metrics();
    try {
      await control(JSON.stringify({ kind: 'expand', pageHandle: page.handle }));
      const task = profile.submit({ requestId: 'long_cycle', source: { interactionId: 'long_cycle_interaction',
        messageId: 'long_cycle_message', revision: 1, userText: 'Продолжай агентный цикл до проверенного завершения.', surface: 'desktop',
      } });
      for (let turn = 0; turn < 25; turn += 1) {
        if (turn > 0) await control(JSON.stringify({ kind: 'expand', pageHandle: page.handle }));
        await scheduler.drain(); const progressed = profile.synchronize(task.taskId);
        expect(progressed, JSON.stringify({ turn, progressed,
          checkpoint: journal.read(task.taskId)?.checkpoint }, null, 2))
          .toMatchObject({ phase: 'model', modelTurns: turn + 2 });
        expect(scheduler.list()).toHaveLength(1);
      }
      await control(JSON.stringify({ kind: 'act', capabilityHandle: real.handle, args: {},
        reason: 'Finish the long cycle with a live root receipt.' }));
      await scheduler.drain(); expect(profile.synchronize(task.taskId).phase).toBe('capability');
      await scheduler.drain();
      const observed = profile.synchronize(task.taskId);
      expect(observed).toMatchObject({ phase: 'model', modelTurns: 27, capabilityCalls: 1 });
      const receiptRef = 'receipt_' + observed.activities.at(-1)!.round;
      await control(JSON.stringify({ kind: 'complete', text: 'Длинный цикл завершён.', evidenceRef: receiptRef }));
      await scheduler.drain();
      const completed = profile.synchronize(task.taskId);
      expect(completed, JSON.stringify({ completed, checkpoint: journal.read(task.taskId)?.checkpoint }, null, 2))
        .toMatchObject({ status: 'completed', phase: 'settled',
        modelTurns: 27, capabilityCalls: 1, responseText: 'Длинный цикл завершён.' });
      expect(scheduler.list()).toHaveLength(0);
      expect((await metrics()).generationCalls - before.generationCalls).toBe(27);
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  }, 20_000);

  it('rearms one bounded model repair after valid progress in a long agent task', async () => {
    const testId = String(sequence++), projectRoot = path.join(root, 'repair-rearm-project-' + testId);
    const coderRoot = path.join(fixture, 'repair-rearm-coder-host-' + testId);
    await mkdir(projectRoot); await mkdir(coderRoot);
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: projectRoot,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    const coder = new CoderModule({ monarchRoot: coderRoot });
    kernel.registerModule(coder); await kernel.start();
    const project = await coder.projects.import(projectRoot, 'Repair rearm project');
    const capability = kernel.getCapability('coder.files.list')!;
    const candidate: AstraAgentCapabilityCandidate = { handle: 'repair_rearm_root_handle', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } };
    const scopeId = 'agent_repair_rearm_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 5, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 12, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler); const before = await metrics();
    try {
      await control('{');
      const task = profile.submit({ requestId: 'repair_rearm', finishWithinMs: 30_000, source: {
        interactionId: 'repair_rearm_interaction', messageId: 'repair_rearm_message', revision: 1,
        userText: 'Проверь проект и продолжай после отдельных ошибок ответа модели.', surface: 'coder',
        executionProfile: { schemaVersion: 'monarch.agent-execution-profile.v1', kind: 'coder-project',
          projectId: project.id, projectRoot: project.root,
          permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } },
      } });
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model', modelTurns: 2, capabilityCalls: 0 });
      expect(journal.read(task.taskId)?.checkpoint).toMatchObject({ repairTurns: 1 });

      await control(JSON.stringify({ kind: 'act', capabilityHandle: candidate.handle,
        argsJson: JSON.stringify({ projectId: project.id, path: '.', recursive: false, limit: 20 }),
        reason: 'Inspect the bound project tree.' }));
      await scheduler.drain(); expect(profile.synchronize(task.taskId).phase).toBe('capability');
      expect(journal.read(task.taskId)?.checkpoint).toMatchObject({ repairTurns: 0 });
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model', modelTurns: 3, capabilityCalls: 1 });

      await control('{'); await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model', modelTurns: 4, capabilityCalls: 1 });
      expect(journal.read(task.taskId)?.checkpoint).toMatchObject({ repairTurns: 1 });

      await control(JSON.stringify({ kind: 'complete', text: 'Корень проекта проверен после двух раздельных восстановлений.',
        evidenceRef: 'receipt_1' }));
      await scheduler.drain();
      const completed = profile.synchronize(task.taskId);
      expect(completed, JSON.stringify(completed, null, 2)).toMatchObject({ status: 'completed', phase: 'settled', modelTurns: 4,
        capabilityCalls: 1, responseText: 'Корень проекта проверен после двух раздельных восстановлений.' });
      expect((await metrics()).generationCalls - before.generationCalls).toBe(4);

      const beforeConsecutive = await metrics(); await control('{');
      const consecutive = profile.submit({ requestId: 'repair_streak_stops', finishWithinMs: 30_000, source: {
        interactionId: 'repair_streak_interaction', messageId: 'repair_streak_message', revision: 1,
        userText: 'Не продолжай бесконечно после некорректных ответов модели.', surface: 'coder',
        executionProfile: { schemaVersion: 'monarch.agent-execution-profile.v1', kind: 'coder-project',
          projectId: project.id, projectRoot: project.root,
          permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } },
      } });
      await scheduler.drain();
      expect(profile.synchronize(consecutive.taskId)).toMatchObject({ phase: 'model', modelTurns: 2 });
      await control('{'); await scheduler.drain();
      expect(profile.synchronize(consecutive.taskId)).toMatchObject({ status: 'blocked', phase: 'settled',
        modelTurns: 2, stopReason: 'decision-json-invalid' });
      expect((await metrics()).generationCalls - beforeConsecutive.generationCalls).toBe(2);
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('allows one transient retry but stops a third exact failed capability proposal without dispatch', async () => {
    const journal = new AstraJournal(':memory:'), workspace = path.join(root, 'failed-action-loop-' + sequence++);
    await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'never' } });
    const execute = vi.fn(async () => ({ ok: false, summary: 'Synthetic service remains unavailable.',
      error: 'synthetic-service-unavailable' }));
    kernel.registerModule({ manifest: { id: 'agent-failure-fixture', name: 'Agent failure fixture', version: '1.0.0',
      kind: 'runtime', description: 'Exact retry accounting fixture.', owns: ['synthetic failure'], permissions: ['read'],
      capabilities: [{ id: 'agent.fixture.unavailable', moduleId: 'agent-failure-fixture', title: 'Unavailable service',
        description: 'Return one bounded synthetic service failure.', risk: 'read',
        inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'],
          additionalProperties: false } }] }, async activate() {}, executeCapability: execute });
    kernel.registerModule(isolatedLocalSecurity(workspace)); await kernel.start();
    const candidate: AstraAgentCapabilityCandidate = { handle: 'failed_action_handle',
      capabilityId: 'agent.fixture.unavailable', moduleId: 'agent-failure-fixture', title: 'Unavailable service',
      description: 'Return one bounded synthetic service failure.', risk: 'read',
      inputSchema: kernel.getCapability('agent.fixture.unavailable')!.inputSchema! };
    const scopeId = 'agent_failed_action_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 6, maxCapabilityCalls: 5 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    const exactAction = JSON.stringify({ kind: 'act', capabilityHandle: candidate.handle,
      argsJson: JSON.stringify({ target: 'same-service' }), reason: 'Retry the same transient service operation.' });
    try {
      await control(exactAction);
      const task = profile.submit({ requestId: 'failed_action_loop', finishWithinMs: 30_000, source: {
        interactionId: 'failed_action_interaction', messageId: 'failed_action_message', revision: 1,
        userText: 'Попробуй временно недоступный сервис, но не зацикливайся.', surface: 'desktop',
      } });
      await scheduler.drain(); expect(profile.synchronize(task.taskId).phase).toBe('capability');
      await scheduler.drain(); expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model',
        modelTurns: 2, capabilityCalls: 1 });

      await control(exactAction); await scheduler.drain();
      expect(profile.synchronize(task.taskId).phase).toBe('capability');
      await scheduler.drain(); expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model',
        modelTurns: 3, capabilityCalls: 2 });

      await control(exactAction); await scheduler.drain();
      const stopped = profile.synchronize(task.taskId);
      expect(stopped, JSON.stringify(stopped, null, 2)).toMatchObject({ status: 'partial', phase: 'settled',
        modelTurns: 3, capabilityCalls: 2, stopReason: 'failed-action-repeated' });
      expect(stopped.activities).toEqual([
        expect.objectContaining({ state: 'observed', ok: false, summary: 'Synthetic service remains unavailable.' }),
        expect.objectContaining({ state: 'observed', ok: false, summary: 'Synthetic service remains unavailable.' }),
        expect.objectContaining({ state: 'failed', ok: false, summary: 'failed-action-repeated' }),
      ]);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('hands a long Cyrillic receipt to the next model turn instead of stalling the task host', async () => {
    // Live 2026-09-18: a listing of "C:\Users\...\OneDrive\Рабочий стол" was cut to
    // 2048 characters (~3 KB of UTF-8); the decision gateway refused it as
    // evidence-shape and the delete-shortcut task hung until the owner stopped it.
    const journal = new AstraJournal(':memory:'), workspace = path.join(root, 'cyrillic-receipt-' + sequence++);
    await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'never' } });
    const listing = 'Рабочий стол: ' + 'Ярлык программы.lnk; '.repeat(90);
    const execute = vi.fn(async () => ({ ok: true, summary: listing, output: { verified: true } }));
    kernel.registerModule({ manifest: { id: 'agent-listing-fixture', name: 'Agent listing fixture', version: '1.0.0',
      kind: 'runtime', description: 'Long Cyrillic receipt fixture.', owns: ['synthetic listing'], permissions: ['read'],
      capabilities: [{ id: 'agent.fixture.listing', moduleId: 'agent-listing-fixture', title: 'List desktop',
        description: 'Return one long Cyrillic listing.', risk: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] },
    async activate() {}, executeCapability: execute });
    kernel.registerModule(isolatedLocalSecurity(workspace)); await kernel.start();
    const candidate: AstraAgentCapabilityCandidate = { handle: 'listing_handle',
      capabilityId: 'agent.fixture.listing', moduleId: 'agent-listing-fixture', title: 'List desktop',
      description: 'Return one long Cyrillic listing.', risk: 'read',
      inputSchema: kernel.getCapability('agent.fixture.listing')!.inputSchema! };
    const scopeId = 'agent_cyrillic_receipt_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    try {
      expect(Buffer.byteLength(listing)).toBeGreaterThan(2048);
      await control(JSON.stringify({ kind: 'act', capabilityHandle: candidate.handle, argsJson: '{}',
        reason: 'List the desktop.' }));
      const task = profile.submit({ requestId: 'cyrillic_receipt', finishWithinMs: 30_000, source: {
        interactionId: 'cyrillic_receipt_interaction', messageId: 'cyrillic_receipt_message', revision: 1,
        userText: 'Что лежит на рабочем столе?', surface: 'desktop',
      } });
      await scheduler.drain(); expect(profile.synchronize(task.taskId).phase).toBe('capability');
      await scheduler.drain(); expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model', capabilityCalls: 1 });
      await control(JSON.stringify({ kind: 'complete', text: 'На рабочем столе ярлыки программ.', evidenceRef: 'receipt_0' }));
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'completed', phase: 'settled' });
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('settles a task whose own progression faults and keeps driving the other tasks', async () => {
    // One task's synchronize() throwing used to reject the whole pass: every
    // other task froze and the host reported progression-failed for all of them.
    const journal = new AstraJournal(':memory:'), workspace = path.join(root, 'task-fault-' + sequence++);
    await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'never' } });
    const execute = vi.fn(async () => ({ ok: true, summary: 'Desktop has two shortcuts.', output: { verified: true } }));
    kernel.registerModule({ manifest: { id: 'agent-fault-fixture', name: 'Agent fault fixture', version: '1.0.0',
      kind: 'runtime', description: 'Task fault fixture.', owns: ['synthetic listing'], permissions: ['read'],
      capabilities: [{ id: 'agent.fixture.fault', moduleId: 'agent-fault-fixture', title: 'List desktop',
        description: 'Return one listing.', risk: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] },
    async activate() {}, executeCapability: execute });
    kernel.registerModule(isolatedLocalSecurity(workspace)); await kernel.start();
    const candidate: AstraAgentCapabilityCandidate = { handle: 'fault_handle',
      capabilityId: 'agent.fixture.fault', moduleId: 'agent-fault-fixture', title: 'List desktop',
      description: 'Return one listing.', risk: 'read',
      inputSchema: kernel.getCapability('agent.fixture.fault')!.inputSchema! };
    const scopeId = 'agent_task_fault_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true,
      bindCapabilityArgs: (_id, args, source) => source.interactionId === 'poison_interaction'
        ? [] as unknown as Record<string, AstraJson> : args });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    const faults: string[] = [];
    const policy: AstraTaskFaultPolicy = { skip: () => false, fault: (taskId, error) => {
      const code = astraTaskFaultCode(error); if (!code) throw error;
      faults.push(code); profile.settleFault(taskId, astraTaskFaultReason(code));
    } };
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle: candidate.handle, argsJson: '{}', reason: 'List the desktop.' }));
      const submit = (name: string) => profile.submit({ requestId: name, finishWithinMs: 30_000, source: {
        interactionId: name + '_interaction', messageId: name + '_message', revision: 1,
        userText: 'Что лежит на рабочем столе?', surface: 'desktop' } });
      const poisoned = submit('poison'), healthy = submit('healthy');
      await scheduler.drain();
      expect(() => profile.synchronizeAll()).toThrow('astra-agent-task:capability-args-binding');
      profile.synchronizeAll(policy);
      expect(faults).toEqual(['astra-agent-task:capability-args-binding']);
      expect(profile.read(poisoned.taskId)).toMatchObject({ status: 'blocked', phase: 'settled',
        stopReason: 'task-fault:astra-agent-task:capability-args-binding' });
      expect(profile.read(healthy.taskId).phase).toBe('capability');
      await scheduler.drain(); profile.synchronizeAll(policy);
      expect(profile.read(healthy.taskId)).toMatchObject({ phase: 'model', capabilityCalls: 1 });
      await control(JSON.stringify({ kind: 'complete', text: 'На рабочем столе два ярлыка.', evidenceRef: 'receipt_0' }));
      await scheduler.drain(); profile.synchronizeAll(policy);
      expect(profile.read(healthy.taskId)).toMatchObject({ status: 'completed', phase: 'settled' });
      expect(faults).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('keeps the full output budget for a MAX index-only turn, where reasoning precedes the answer', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const live: AstraAgentCapabilityCandidate[] = [...Array.from({ length: 16 }, (_, index): AstraAgentCapabilityCandidate => ({
      handle: `mail_budget_handle_${index}`, capabilityId: `mail.operation.${index}`, moduleId: 'mail',
      title: `Mail operation ${index}`, description: 'A separately admitted service operation.', risk: 'network',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } })),
    { handle: 'workspace_root_budget', capabilityId: capability.id, moduleId: capability.moduleId, title: capability.title,
      description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } }];
    const scopeId = 'agent_max_budget_' + sequence++;
    // 256 tokens was sized for a non-reasoning 4K local window. A MAX model
    // spends it on hidden reasoning, the provider then sees an empty final
    // answer and every MAX agent task failed on its first catalog turn.
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'gpt-oss-120b', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 8192, modelTimeoutMs: 5000, maxModelTurns: 5, maxCapabilityCalls: 2,
        contextLimits: { hardTokens: 131_072, softTokens: 114_688, rearmTokens: 98_304, reservedOutputTokens: 8192,
          hardBytes: 524_288, tokenizerTimeoutMs: 1000 } },
      resolveCandidates: () => live, isSourceCurrent: () => true,
      isCapabilityAllowed: candidate => candidate.id === capability.id });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    try {
      profile.submit({ requestId: 'max_budget_cycle', finishWithinMs: 30_000, source: {
        interactionId: 'max_budget_interaction', messageId: 'max_budget_message', revision: 1,
        userText: 'Определи корень проекта.', surface: 'desktop' } });
      expect(scheduler.list()[0]!.input).toMatchObject({ model: { maxOutputTokens: 8192,
        contextLimits: { reservedOutputTokens: 8192 }, agentCandidates: [] } });
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('lets the model browse a large live catalog before the Kernel action, without keyword routing', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const real: AstraAgentCapabilityCandidate = { handle: 'workspace_root_large_catalog', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } };
    const decoys = Array.from({ length: 16 }, (_, index): AstraAgentCapabilityCandidate => ({
      handle: `mail_operation_handle_${index}`, capabilityId: `mail.operation.${index}`, moduleId: 'mail',
      title: `Mail operation ${index}`, description: 'A separately admitted service operation.', risk: 'network',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }));
    const live = [...decoys, real], catalog = astraAgentCapabilityCatalog(live);
    const page = catalog.pages.find(item => item.candidateHandles.includes(real.handle))!;
    const scopeId = 'agent_catalog_cycle_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 1024, modelTimeoutMs: 5000, maxModelTurns: 5, maxCapabilityCalls: 2,
        contextLimits: { hardTokens: 8192, softTokens: 6144, rearmTokens: 4096, reservedOutputTokens: 1024,
          hardBytes: 262144, recentNarrativeItems: 4, minimumSavedTokens: 64, tokenizerTimeoutMs: 1000 } },
      resolveCandidates: () => live, isSourceCurrent: () => true,
      isCapabilityAllowed: candidate => candidate.id === capability.id });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    const dispatch = vi.spyOn(kernel, 'executeActionProposal'), before = await metrics();
    try {
      await control(JSON.stringify({ kind: 'expand', pageHandle: page.handle }));
      const task = profile.submit({ requestId: 'large_catalog_cycle', finishWithinMs: 30_000, source: {
        interactionId: 'large_catalog_interaction', messageId: 'large_catalog_message', revision: 1,
        userText: 'Определи корень проекта и верни подтвержденный результат.', surface: 'desktop',
      } });
      expect(scheduler.list()[0]!.input).toMatchObject({ model: { maxOutputTokens: 256,
        contextLimits: { reservedOutputTokens: 256 }, agentCandidates: [] } });
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model', modelTurns: 2, capabilityCalls: 0 });
      expect(scheduler.list()[0]!.input).toMatchObject({ model: { maxOutputTokens: 1024,
        contextLimits: { reservedOutputTokens: 1024 } } });
      await control(JSON.stringify({ kind: 'act', capabilityHandle: real.handle, args: {},
        reason: 'Inspect the active workspace root.' }));
      await scheduler.drain(); expect(profile.synchronize(task.taskId).phase).toBe('capability');
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model', modelTurns: 3, capabilityCalls: 1 });
      await control(JSON.stringify({ kind: 'complete', text: 'Корень проекта подтвержден.', evidenceRef: 'receipt_1' }));
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'completed', phase: 'settled', modelTurns: 3,
        capabilityCalls: 1, responseText: 'Корень проекта подтвержден.' });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await metrics()).generationCalls - before.generationCalls).toBe(3);
    } finally { dispatch.mockRestore(); await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('lets a MAX model act from a whole group and stay there after the effect', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const toCandidate = (id: string, handle: string): AstraAgentCapabilityCandidate => {
      const capability = kernel.getCapability(id)!;
      return { handle, capabilityId: capability.id, moduleId: capability.moduleId, title: capability.title,
        description: capability.description ?? '', risk: capability.risk,
        inputSchema: capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } };
    };
    const rootGet = toCandidate('workspace.root.get', 'workspace_root_wide');
    const sibling = toCandidate(kernel.listCapabilities().find(item => item.moduleId === rootGet.moduleId
      && item.id !== rootGet.capabilityId)!.id, 'workspace_sibling_wide');
    const decoys = Array.from({ length: 16 }, (_, index): AstraAgentCapabilityCandidate => ({
      handle: `mail_wide_handle_${index}`, capabilityId: `mail.operation.${index}`, moduleId: 'mail',
      title: `Mail operation ${index}`, description: 'A separately admitted service operation.', risk: 'network',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }));
    const live = [...decoys, rootGet, sibling], catalog = astraAgentCapabilityCatalog(live);
    const group = catalog.pages.find(page => !page.parentPageId && page.title === rootGet.moduleId)!;
    const scopeId = 'agent_wide_catalog_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'gpt-oss-120b', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 1024, modelTimeoutMs: 5000, maxModelTurns: 5, maxCapabilityCalls: 2,
        contextLimits: { hardTokens: 131_072, softTokens: 114_688, rearmTokens: 98_304, reservedOutputTokens: 1024,
          hardBytes: 524_288, tokenizerTimeoutMs: 1000 } },
      resolveCandidates: () => live, isSourceCurrent: () => true,
      isCapabilityAllowed: candidate => candidate.id === rootGet.capabilityId });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    const dispatch = vi.spyOn(kernel, 'executeActionProposal'), before = await metrics();
    try {
      await control(JSON.stringify({ kind: 'expand', pageHandle: group.handle }));
      const task = profile.submit({ requestId: 'wide_catalog_cycle', finishWithinMs: 30_000, source: {
        interactionId: 'wide_catalog_interaction', messageId: 'wide_catalog_message', revision: 1,
        userText: 'Определи корень проекта.', surface: 'desktop' } });
      expect(scheduler.list()[0]!.input).toMatchObject({ model: { agentCandidates: [] } });
      await scheduler.drain(); profile.synchronize(task.taskId);
      // One expand makes the whole group actionable; other modules stay reachable by title.
      const grouped = (scheduler.list()[0]!.input as any).model;
      const navigation = JSON.parse(grouped.source.mandatory.find((item: any) => item.ref === 'agent_workflow').text);
      expect(navigation).toMatchObject({ activeCatalogPage: group.title,
        recentCatalogNavigation: [{ round: 0, page: group.title }] });
      expect(grouped.agentCandidates.map((item: any) => item.handle).sort()).toEqual([rootGet.handle, sibling.handle].sort());
      expect(grouped.agentPages.map((page: any) => [page.title, page.description])).toEqual([['mail', '']]);
      await control(JSON.stringify({ kind: 'act', capabilityHandle: rootGet.handle, argsJson: '{}',
        reason: 'Inspect the active workspace root.' }));
      await scheduler.drain(); expect(profile.synchronize(task.taskId).phase).toBe('capability');
      await scheduler.drain(); profile.synchronize(task.taskId);
      // After the effect the model is still inside the group, not back at the index.
      expect((scheduler.list()[0]!.input as any).model.agentCandidates.map((item: any) => item.handle).sort())
        .toEqual([rootGet.handle, sibling.handle].sort());
      const afterEffect = (scheduler.list()[0]!.input as any).model.source;
      expect(JSON.parse(afterEffect.mandatory.find((item: any) => item.ref === 'agent_workflow').text).activeCatalogPage).toBe(group.title);
      await control(JSON.stringify({ kind: 'complete', text: 'Корень проекта подтвержден.', evidenceRef: 'receipt_1' }));
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'completed', modelTurns: 3, capabilityCalls: 1 });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await metrics()).generationCalls - before.generationCalls).toBe(3);
    } finally { dispatch.mockRestore(); await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('pauses a generic V3 task on the exact Security challenge and continues after approval', async () => {
    const journal = new AstraJournal(':memory:'), workspace = path.join(root, 'approval-cycle');
    await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: workspace, localReadOnlyRoots: [] }));
    kernel.registerModule(isolatedLocalSecurity(workspace)); await kernel.start();
    const capability = kernel.getCapability('workspace.files.write')!, target = path.join(workspace, 'approved.txt');
    const candidate: AstraAgentCapabilityCandidate = { handle: 'workspace_write_approval_handle', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema! };
    const scopeId = 'agent_approval_cycle_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true,
      isCapabilityAllowed: current => current.id === capability.id });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle: candidate.handle,
        argsJson: JSON.stringify({ path: target, content: 'approved V3 result', overwrite: false }),
        reason: 'Write the requested result.' }));
      const task = profile.submit({ requestId: 'approval_cycle', finishWithinMs: 30_000, source: {
        interactionId: 'approval_cycle_interaction', messageId: 'approval_cycle_message', revision: 1,
        userText: 'Проверь возможность операции и дождись моего решения.', surface: 'desktop',
      } });
      await scheduler.drain(); expect(profile.synchronize(task.taskId).phase).toBe('capability');
      await scheduler.drain();
      const waiting = profile.synchronize(task.taskId);
      expect(waiting).toMatchObject({ status: 'awaiting-approval', phase: 'capability', approval: {
        capability: { id: 'workspace.files.write' }, args: { path: target, content: 'approved V3 result' }, grantScope: 'once' } });
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      // The host asks for recovery candidates after every pump. During the whole
      // approval wait that read resolved the retired model job and threw
      // astra-scheduler:missing-job, stopping the host behind the card.
      expect(profile.recoveryCandidates()).toEqual([]);
      const approval = waiting.approval!;
      profile.decide(task.taskId, { approvalId: approval.id, approvalDigest: approval.digest,
        messageId: 'approval_cycle_answer', decision: 'approve' });
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model', modelTurns: 2, capabilityCalls: 1 });
      await control(JSON.stringify({ kind: 'complete', text: 'Операция выполнена после подтверждения.', evidenceRef: 'receipt_0' }));
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'completed', phase: 'settled',
        responseText: 'Операция выполнена после подтверждения.' });
      expect(await readFile(target, 'utf8')).toBe('approved V3 result');
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('never reopens the same rejected capability and gives the model one bounded safer-decision turn', async () => {
    const journal = new AstraJournal(':memory:'), workspace = path.join(root, 'rejected-action-cycle');
    await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: workspace, localReadOnlyRoots: [] }));
    kernel.registerModule(isolatedLocalSecurity(workspace)); await kernel.start();
    const capability = kernel.getCapability('workspace.files.write')!, target = path.join(workspace, 'rejected.txt');
    const candidate: AstraAgentCapabilityCandidate = { handle: 'workspace_write_rejected_handle', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema! };
    const scopeId = 'agent_rejected_cycle_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true,
      isCapabilityAllowed: current => current.id === capability.id });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    const exactAction = JSON.stringify({ kind: 'act', capabilityHandle: candidate.handle,
      argsJson: JSON.stringify({ path: target, content: 'must not be written', overwrite: false }),
      reason: 'Attempt the exact requested write.' });
    try {
      await control(exactAction);
      const task = profile.submit({ requestId: 'rejected_action_cycle', finishWithinMs: 30_000, source: {
        interactionId: 'rejected_action_interaction', messageId: 'rejected_action_message', revision: 1,
        userText: 'Не повторяй действие, если я его отклоню.', surface: 'desktop',
      } });
      await scheduler.drain(); expect(profile.synchronize(task.taskId).phase).toBe('capability');
      await scheduler.drain(); const waiting = profile.synchronize(task.taskId); const approval = waiting.approval!;
      profile.decide(task.taskId, { approvalId: approval.id, approvalDigest: approval.digest,
        messageId: 'rejected_action_answer', decision: 'reject' });
      await control(exactAction); await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ phase: 'model', modelTurns: 3, capabilityCalls: 1,
        activities: [expect.objectContaining({ state: 'failed', summary: 'approval-rejected' }),
          expect.objectContaining({ state: 'failed', summary: 'rejected-action-repeated' })] });
      await control(JSON.stringify({ kind: 'complete', text: 'Отклонённое действие не повторялось.', evidenceRef: 'none' }));
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'completed', phase: 'settled', capabilityCalls: 1,
        responseText: 'Отклонённое действие не повторялось.' });
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('continues the same durable V3 task after one bound model clarification', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const candidate: AstraAgentCapabilityCandidate = { handle: 'clarification_capability', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema! };
    const scopeId = 'agent_clarification_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler); const before = await metrics();
    try {
      await control(JSON.stringify({ kind: 'ask-user', question: 'Какой формат ответа использовать?' }));
      const task = profile.submit({ requestId: 'clarification_cycle', finishWithinMs: 30_000, source: {
        interactionId: 'clarification_interaction', messageId: 'clarification_message', revision: 1,
        userText: 'Подготовь результат в выбранном формате.', surface: 'desktop',
      } });
      await scheduler.drain(); const waiting = profile.synchronize(task.taskId);
      expect(waiting).toMatchObject({ status: 'awaiting-input', phase: 'waiting-input',
        question: 'Какой формат ответа использовать?', predecessorMessageId: 'clarification_message' });
      profile.reply(task.taskId, { requestId: 'clarification_reply_request', questionId: waiting.questionId!,
        questionDigest: waiting.questionDigest!, messageId: 'clarification_reply_message', text: 'Короткий текст.' });
      await control(JSON.stringify({ kind: 'complete', text: 'Короткий результат.', evidenceRef: 'none' }));
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'completed', phase: 'settled',
        responseText: 'Короткий результат.', predecessorMessageId: 'clarification_reply_message', modelTurns: 2 });
      expect((await metrics()).generationCalls - before.generationCalls).toBe(2);
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('ends a task whose question outlived the deadline instead of waiting forever', async () => {
    // Live: three tasks from 23.09 still showed their questions eleven days
    // later; reply() refuses an expired question, so nothing could end them.
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const candidate: AstraAgentCapabilityCandidate = { handle: 'expired_question_capability', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema! };
    const scopeId = 'agent_expired_question_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    try {
      await control(JSON.stringify({ kind: 'ask-user', question: 'Какой отчёт нужен?' }));
      const task = profile.submit({ requestId: 'expired_question', finishWithinMs: 30_000, source: {
        interactionId: 'expired_question_interaction', messageId: 'expired_question_message', revision: 1,
        userText: 'Сделай отчёт.', surface: 'desktop',
      } });
      await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'awaiting-input', phase: 'waiting-input' });
      expect(profile.synchronizeAll()).toEqual([]);
      const later = Date.now() + 60_000;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      scheduler.acquire(); // the host takes its lease again on the next start
      expect(profile.synchronizeAll()).toEqual([expect.objectContaining({ taskId: task.taskId,
        status: 'blocked', phase: 'settled', stopReason: 'task-deadline' })]);
    } finally { vi.restoreAllMocks(); await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('stops a question loop: three answered questions, one hint to act, then a truthful stop', async () => {
    // Live: gpt-6-luna asked five questions about one file path and never acted.
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const candidate: AstraAgentCapabilityCandidate = { handle: 'question_loop_capability', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema! };
    const scopeId = 'agent_question_loop_' + sequence++;
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 12, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 32, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler);
    try {
      await control(JSON.stringify({ kind: 'ask-user', question: 'Какой путь использовать?' }));
      const task = profile.submit({ requestId: 'question_loop', finishWithinMs: 30_000, source: {
        interactionId: 'question_loop_interaction', messageId: 'question_loop_message', revision: 1,
        userText: 'Создай файл.', surface: 'desktop',
      } });
      for (let answer = 0; answer < 3; answer++) {
        await scheduler.drain(); const waiting = profile.synchronize(task.taskId);
        expect(waiting).toMatchObject({ status: 'awaiting-input', phase: 'waiting-input' });
        profile.reply(task.taskId, { requestId: 'question_loop_reply_' + answer, questionId: waiting.questionId!,
          questionDigest: waiting.questionDigest!, messageId: 'question_loop_reply_message_' + answer, text: 'Ответ ' + answer });
      }
      for (let pass = 0; pass < 8 && profile.synchronize(task.taskId).phase !== 'settled'; pass++) await scheduler.drain();
      expect(profile.synchronize(task.taskId)).toMatchObject({ status: 'blocked', phase: 'settled', stopReason: 'question-budget',
        modelTurns: 5 });
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('gives an action-free first finish one repair round, then accepts it as an unverified answer', async () => {
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root,
      agencyStateDirectory: false, permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const capability = kernel.getCapability('workspace.root.get')!;
    const candidate: AstraAgentCapabilityCandidate = { handle: 'repair_capability', capabilityId: capability.id,
      moduleId: capability.moduleId, title: capability.title, description: capability.description ?? '', risk: capability.risk,
      inputSchema: capability.inputSchema! };
    const scopeId = 'agent_completion_repair_' + sequence++;
    const sent: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      if (typeof init?.body === 'string') sent.push(init.body);
      return fetch(input, init);
    };
    const profile = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId, journal,
      kernel, client: client(recording), policy: { modelId: 'synthetic-model', expectedModelDigest: host.modelDigest,
        maxOutputTokens: 256, modelTimeoutMs: 5000, maxModelTurns: 4, maxCapabilityCalls: 2 },
      resolveCandidates: () => [candidate], isSourceCurrent: () => true, isCapabilityAllowed: () => true });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId, adapters: profile.adapters, limits: { maxJobs: 16, activationTimeoutMs: 10_000 } });
    scheduler.acquire(); profile.attach(scheduler); const before = await metrics();
    try {
      // The model describes the work instead of doing it, twice.
      await control(JSON.stringify({ kind: 'complete', text: 'Я воспользуюсь инструментом записи файла.', evidenceRef: 'none' }));
      const task = profile.submit({ requestId: 'completion_repair_cycle', finishWithinMs: 30_000, source: {
        interactionId: 'completion_repair_interaction', messageId: 'completion_repair_message', revision: 1,
        userText: 'Создай файл с текстом.', surface: 'desktop',
      } });
      let view = profile.synchronize(task.taskId); const deadline = Date.now() + 10_000;
      while (view.status !== 'completed' && Date.now() < deadline) { await scheduler.drain(); view = profile.synchronize(task.taskId); }
      expect(view).toMatchObject({ status: 'completed', modelTurns: 2,
        responseText: 'Я воспользуюсь инструментом записи файла.' });
      expect((await metrics()).generationCalls - before.generationCalls).toBe(2);
      // Live: Gemma, told only "act or finish", finished "Удали файл" with its
      // question in the answer text instead of asking the person.
      expect(sent.some(body => body.includes('then use ask-user with one concrete question'))).toBe(true);
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); }
  });

  it('routes an ordinary semantic Oscar agent Turn into the product V3 loop instead of V2', async () => {
    const workspace = path.join(root, 'product-agent-' + sequence++); await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    const productCapabilityId = 'product-agent-fixture.root.get';
    kernel.registerModule({ manifest: { id: 'product-agent-fixture', name: 'Product agent route fixture', version: '1.0.0',
      kind: 'runtime', description: 'One read-only capability isolates product V3 routing.', owns: ['synthetic product route'],
      permissions: ['read'], capabilities: [{ id: productCapabilityId, moduleId: 'product-agent-fixture',
        title: 'Read synthetic product root', description: 'Returns the exact disposable test root.', risk: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        agent: { supportedSources: ['desktop'], cancellation: 'supported' } }] },
      async activate() {}, async executeCapability() { return { ok: true, summary: 'Disposable product root observed.',
        output: { root: workspace, verified: true } }; } });
    await kernel.start();
    const journalKey = Buffer.alloc(32, 0x5c), desktopToken = 'desktop-' + 'd'.repeat(48);
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: workspace,
      stateRoot: path.join(workspace, 'state'), kernel, desktopAttestationToken: desktopToken,
      hostToken: 'host-' + 'h'.repeat(48), journalEncryptionKey: journalKey,
      localModelHost: { endpoint: host.endpoint, bearerToken: 'astra-synthetic-product-local-only',
        hostGeneration: host.hostGeneration, modelDigest: host.modelDigest } });
    expect(pilot?.facade.agentTasks).toBeDefined(); if (!pilot) throw Error('pilot-required');
    const surfaceTurn = (source: 'voice' | 'system' | 'api' | 'telegram', request: Record<string, unknown> = {}) => ({
      clientRequestId: `surface_${source}_request`, conversationId: `surface_${source}_conversation`,
      inputMessageId: `surface_${source}_message`, source, privacyMode: 'persistent',
      request: { text: 'Выполни связанную задачу.', attachmentIds: [], modifiers: {}, ...request },
    });
    expect(pilot.bridge.bindAgent(surfaceTurn('voice') as never)?.actor).toEqual(pilot.voiceActor);
    expect(pilot.bridge.bindAgent(surfaceTurn('system') as never)?.actor).toEqual(pilot.systemActor);
    const apiActor = { source: 'api' as const, id: 'sha256:' + '9'.repeat(64) };
    expect(pilot.bridge.bindAgent(surfaceTurn('api', { authenticatedAgentActor: apiActor }) as never)?.actor).toEqual(apiActor);
    const telegramEnvelope = { ownerUserId: 7, controlChatId: 7, botId: 123456, threadId: 11,
      pairingEpoch: '2026-09-13T00:00:00.000Z' };
    expect(pilot.bridge.bindAgent(surfaceTurn('telegram', { telegramActor: telegramEnvelope }) as never)?.actor)
      .toMatchObject({ source: 'telegram', id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) });
    expect(pilot.bridge.bindAgent(surfaceTurn('api') as never)).toBeNull();
    const deliveries: Array<{ role: string; content: string }> = [];
    const attachment = { id: 'oscar_attachment_' + 'a'.repeat(32), digest: 'sha256:' + 'b'.repeat(64),
      name: 'requirements.txt', mimeType: 'text/plain', sizeBytes: 24,
      dataBase64: Buffer.from('Use the verified root only.', 'utf8').toString('base64') };
    const coordinator = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(),
      volatileStore: new InMemoryOscarTurnStore(), astra: pilot.bridge,
      dispositionProvider: { classify: async () => ({ lane: 'agent', kind: 'semantic-request', confidence: 1,
        reason: 'fixture semantic work', requiresExternalResearch: false }) },
      answerExecutor: async () => { throw Error('answer-forbidden'); },
      resolveAttachments: async ids => ids.length === 1 && ids[0] === attachment.id ? [attachment] : [],
      persistMessage: async message => { deliveries.push({ role: message.role, content: message.content });
        return { disposition: 'created' }; } });
    const clientRequestId = 'product_generic_agent_request'; let taskId = '';
    let enter!: () => void, proceed!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    const execute = kernel.executeActionProposal.bind(kernel);
    kernel.executeActionProposal = async (...args) => {
      if (args[0].capabilityId === productCapabilityId) { enter(); await gate; }
      return execute(...args);
    };
    const before = await metrics();
    try {
      await control(JSON.stringify({ kind: 'ask-user', question: 'Подтвердить формат краткого отчёта?' }));
      await pilot.facade.startWithSourceRestore(() => coordinator.start());
      let turn = await coordinator.submit({ clientRequestId, conversationId: 'product_generic_agent',
        inputMessageId: 'product_generic_agent_message', source: 'desktop', privacyMode: 'persistent',
        text: 'Проверь корень этого проекта и сообщи подтвержденный результат.', history: [
          { role: 'user', content: 'Ранее мы договорились использовать краткий формат.' },
          { role: 'assistant', content: 'Продолжу с учетом этого формата.' },
        ], attachmentIds: [attachment.id] });
      let deadline = Date.now() + 5_000;
      while (turn.turn.status !== 'waiting-for-user' && Date.now() < deadline) {
        await pilot.facade.drain(); await coordinator.flushOutbox();
        turn = (await coordinator.getTurn(turn.turn.id))!;
      }
      expect(turn.turn.status).toBe('waiting-for-user');
      const question = pilot.bridge.find(turn.turn)?.question; expect(question).toBeDefined();
      const sourceId = 'app_source_' + createHash('sha256').update(pilot.actor.id + '/oscar_' + turn.turn.id).digest('hex').slice(0, 32);
      taskId = astraAgentTaskId('product_pilot', sourceId); expect(turn.turn.taskId).toBe(taskId);
      expect(pilot.journal.read(taskId)?.checkpoint).toMatchObject({ initialEvidence: [{
        ref: 'agent_attachment_0', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      }] });
      expect(JSON.stringify(pilot.journal.read(taskId)?.checkpoint)).toContain('Use the verified root only.');
      expect(JSON.stringify(pilot.journal.read(taskId)?.checkpoint)).toContain(attachment.digest);
      const catalogKey = createHmac('sha256', journalKey).update('monarch.astra-v3.generic-agent-catalog.v1').digest();
      const capabilityHandle = 'cap_' + createHmac('sha256', catalogKey)
        .update(taskId + '/product-agent-fixture/' + productCapabilityId).digest('hex').slice(0, 48); catalogKey.fill(0);
      await control(JSON.stringify({ kind: 'act', capabilityHandle, argsJson: '{}', reason: 'Inspect the active root.' }));
      await coordinator.submitAstraInput(turn.turn.id, 'desktop', { kind: 'reply', reply: {
        requestId: 'product_agent_reply_request', questionId: question!.id, questionDigest: question!.digest,
        messageId: 'product_agent_reply_message', text: 'Да, краткий отчёт.' } });
      const actionEntered = await Promise.race([entered.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 5000))]);
      if (!actionEntered) {
        await coordinator.flushOutbox(); turn = (await coordinator.getTurn(turn.turn.id))!;
        throw Error('product-agent-action-timeout:' + JSON.stringify({ turn: turn.turn,
          tasks: pilot.facade.agentTasks!.list(pilot.actor, turn.turn.conversationId), host: pilot.facade.hostStatus(),
          outbox: await coordinator.persistentStore.listPendingOutbox(), metrics: await metrics() }));
      }
      await control(JSON.stringify({ kind: 'complete', text: 'Корень проекта подтвержден через V3.', evidenceRef: 'receipt_1' }));
      proceed();
      deadline = Date.now() + 10_000;
      while (turn.turn.status !== 'succeeded' && Date.now() < deadline) {
        await pilot.facade.drain(); await coordinator.flushOutbox();
        turn = (await coordinator.getTurn(turn.turn.id))!;
        if (turn.turn.status !== 'succeeded') await new Promise(resolve => setTimeout(resolve, 10));
      }
      await coordinator.flushOutbox();
      if (turn.turn.status !== 'succeeded') throw Error('product-agent-completion-timeout:' + JSON.stringify({ turn,
        tasks: pilot.facade.agentTasks!.list(pilot.actor, turn.turn.conversationId), host: pilot.facade.hostStatus(),
        outbox: await coordinator.persistentStore.listPendingOutbox(), metrics: await metrics() }));
      expect(turn.turn).toMatchObject({ status: 'succeeded', mode: 'agent', taskId,
        request: { astra: { admission: 'ordinary-agent-v1', goal: { kind: 'agent', modelMode: 'local' } } },
        outcome: { summary: 'Корень проекта подтвержден через V3.' } });
      expect(turn.turn.outcome?.warning).toBeUndefined();
      expect(deliveries.some(message => message.role === 'assistant'
        && message.content === 'Корень проекта подтвержден через V3.')).toBe(true);
      expect(pilot.bridge.find(turn.turn)).toMatchObject({ nativeCompletionCertified: true,
        message: { delivery: 'acknowledged', nativeCompletionCertified: true,
          verification: 'native-agent-completion-certificate' } });
      expect((await metrics()).generationCalls - before.generationCalls).toBe(3);
    } finally {
      proceed(); await coordinator.stop(); await pilot.stop(); await kernel.stop(); journalKey.fill(0);
    }
  }, 20_000);

  it('runs an incognito Oscar Agent on a separate memory-only V3 owner without V2 or message persistence', async () => {
    const workspace = path.join(root, 'product-incognito-' + sequence++); await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: workspace }));
    kernel.registerModule(isolatedLocalSecurity(workspace)); await kernel.start();
    const journalKey = Buffer.alloc(32, 0x6d);
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: workspace,
      stateRoot: path.join(workspace, 'state'), kernel, desktopAttestationToken: 'incognito-' + 'd'.repeat(48),
      hostToken: 'incognito-host-' + 'h'.repeat(48), journalEncryptionKey: journalKey,
      localModelHost: { endpoint: host.endpoint, bearerToken: 'astra-synthetic-product-local-only',
        hostGeneration: host.hostGeneration, modelDigest: host.modelDigest } });
    if (!pilot) throw Error('pilot-required');
    const persistMessage = vi.fn(async () => ({ disposition: 'created' as const }));
    const coordinator = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(),
      volatileStore: new InMemoryOscarTurnStore(), astra: pilot.bridge,
      dispositionProvider: { classify: async () => ({ lane: 'agent', kind: 'semantic-request', confidence: 1,
        reason: 'fixture incognito work', requiresExternalResearch: false }) },
      answerExecutor: async () => { throw Error('answer-forbidden'); }, persistMessage });
    try {
      await control(JSON.stringify({ kind: 'complete', text: 'Инкогнито-задача завершена в V3.', evidenceRef: 'none' }));
      await pilot.startWithSourceRestore(() => coordinator.start());
      let turn = await coordinator.submit({ clientRequestId: 'incognito_v3_request', conversationId: 'incognito_v3_chat',
        inputMessageId: 'incognito_v3_message', source: 'desktop', privacyMode: 'incognito',
        text: 'Проверь задачу без сохранения истории.' });
      const deadline = Date.now() + 10_000;
      while (turn.turn.status !== 'succeeded' && Date.now() < deadline) {
        await pilot.drain();
        turn = (await coordinator.getTurn(turn.turn.id))!;
        if (turn.turn.status !== 'succeeded') await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(turn.turn).toMatchObject({ status: 'succeeded', privacyMode: 'incognito',
        request: { astra: { admission: 'ordinary-agent-v1' } },
        outcome: { summary: 'Инкогнито-задача завершена в V3.' } });
      expect(turn.turn.taskId).toBeTruthy();
      expect(pilot.journal.read(turn.turn.taskId!)).toBeNull();
      expect(persistMessage).not.toHaveBeenCalled();
      expect(await coordinator.discardIncognitoConversation('incognito_v3_chat', 'desktop')).toBe(1);
      expect(await coordinator.getTurn(turn.turn.id)).toBeNull();
    } finally { await coordinator.stop(); await pilot.stop(); await kernel.stop(); journalKey.fill(0); }
  }, 20_000);

  it('keeps an ordinary Telegram Agent Turn in V3 and rechecks its exact pairing before Kernel dispatch', async () => {
    const workspace = path.join(root, 'product-telegram-' + sequence++); await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    const telegramEnvelope = { ownerUserId: 77, controlChatId: 77, botId: 123456, threadId: 4,
      pairingEpoch: '2026-09-13T00:00:00.000Z' };
    const requestId = 'telegram_exact_request', conversationId = 'telegram_exact_conversation';
    let observedInput: Record<string, unknown> | undefined, permitChecks = 0;
    let enter!: () => void, proceed!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    const telegramV2 = {
      request: (id: string) => id === requestId ? { grantId: null } : null,
      activeGrant: () => null,
      permits: (id: string, conversation: string, capability: string, input: unknown) => {
        permitChecks += 1;
        const args = input as Record<string, unknown>;
        return id === requestId && conversation === conversationId
          && (capability === 'telegram.capabilities.describe'
            || capability === 'telegram.reminder.list' && args.chatId === telegramEnvelope.controlChatId);
      },
    };
    kernel.registerModule({ v2: telegramV2, manifest: { id: 'telegram', name: 'Telegram V3 fixture', version: '1.0.0',
      kind: 'runtime', description: 'Exact paired Telegram fixture.', owns: ['synthetic Telegram scope'], permissions: ['read'],
      capabilities: [
        { id: 'telegram.capabilities.describe', moduleId: 'telegram', title: 'Describe Telegram', risk: 'read',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { id: 'telegram.reminder.list', moduleId: 'telegram', title: 'List own reminders', risk: 'read',
          inputSchema: { type: 'object', properties: { chatId: { type: 'number' } }, additionalProperties: false } },
      ] }, async activate() {}, async executeCapability(request) {
        if (request.capabilityId !== 'telegram.reminder.list') throw Error('unexpected-telegram-capability');
        observedInput = structuredClone(request.input); enter(); await gate;
        return { ok: true, summary: 'Own reminders observed.', output: { count: 0, verified: true } };
      } } as never);
    kernel.registerModule(isolatedLocalSecurity(workspace)); await kernel.start();
    const journalKey = Buffer.alloc(32, 0x4a), desktopToken = 'telegram-' + 't'.repeat(48);
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: workspace,
      stateRoot: path.join(workspace, 'state'), kernel, desktopAttestationToken: desktopToken,
      hostToken: 'telegram-host-' + 'h'.repeat(48), journalEncryptionKey: journalKey,
      localModelHost: { endpoint: host.endpoint, bearerToken: 'astra-synthetic-product-local-only',
        hostGeneration: host.hostGeneration, modelDigest: host.modelDigest } });
    if (!pilot?.facade.agentTasks) throw Error('pilot-required');
    const turn = { id: 'telegram_v3_turn', clientRequestId: requestId, conversationId,
      inputMessageId: 'telegram_exact_message', source: 'telegram' as const, privacyMode: 'persistent' as const,
      request: { text: 'Покажи мои напоминания.', attachmentIds: [], modifiers: {}, telegramActor: telegramEnvelope } };
    const binding = pilot.bridge.bindAgent(turn as never); if (!binding) throw Error('telegram-binding-required');
    const facadeRequestId = 'oscar_' + turn.id;
    const sourceId = 'app_source_' + createHash('sha256').update(binding.actor.id + '/' + facadeRequestId).digest('hex').slice(0, 32);
    const taskId = astraAgentTaskId('product_pilot', sourceId);
    const catalogKey = createHmac('sha256', journalKey).update('monarch.astra-v3.generic-agent-catalog.v1').digest();
    const capabilityHandle = 'cap_' + createHmac('sha256', catalogKey)
      .update(taskId + '/telegram/telegram.reminder.list').digest('hex').slice(0, 48); catalogKey.fill(0);
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle, argsJson: '{}', reason: 'Read own reminders.' }));
      await pilot.facade.startWithSourceRestore(async () => undefined);
      let task = pilot.facade.agentTasks.submit(binding.actor, { version: 1, clientRequestId: facadeRequestId,
        conversationId, inputMessageId: turn.inputMessageId, text: turn.request.text, privacyMode: 'persistent',
        selectionId: binding.selectionId, goal: binding.goal,
        telegramActor: { ...telegramEnvelope, requestId } });
      expect(await Promise.race([entered.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000))])).toBe(true);
      const activeRecord = pilot.journal.read(task.id)?.checkpoint as unknown as { candidates: AstraAgentCapabilityCandidate[] };
      expect(activeRecord.candidates.find(candidate => candidate.capabilityId === 'telegram.reminder.list')?.inputSchema.properties)
        .not.toHaveProperty('chatId');
      await control(JSON.stringify({ kind: 'complete', text: 'Напоминаний нет.', evidenceRef: 'receipt_0' }));
      proceed();
      const deadline = Date.now() + 10_000;
      while (!['completed', 'blocked', 'failed', 'cancelled'].includes(task.status) && Date.now() < deadline) {
        await pilot.facade.drain();
        task = pilot.facade.agentTasks.read(binding.actor, task.id,
          { conversationId, inputMessageId: turn.inputMessageId });
        if (task.status !== 'completed') await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (task.status !== 'completed') throw Error('telegram-v3-task:' + JSON.stringify({ task,
        record: pilot.journal.read(task.id)?.checkpoint }, null, 2));
      expect(task).toMatchObject({ status: 'completed', source: 'telegram', modelJobs: 2, capabilityJobs: 1,
        nativeCompletionCertified: true, message: { content: 'Напоминаний нет.', delivery: 'pending',
          verification: 'native-agent-completion-certificate', nativeCompletionCertified: true } });
      expect(pilot.journal.read(task.id)?.checkpoint).toMatchObject({
        schemaVersion: 'monarch.astra-v3-agent-task-archive.internal.v2', taskId: task.id,
      });
      expect(observedInput).toEqual({ chatId: 77 });
      expect(permitChecks).toBeGreaterThanOrEqual(2);
    } finally { proceed(); await pilot.stop(); await kernel.stop(); journalKey.fill(0); }
  }, 20_000);

  it('executes Gmail as an ordinary semantic V3 capability through Kernel without an activation phrase', async () => {
    const workspace = path.join(root, 'product-gmail-' + sequence++); await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    let enter!: () => void, proceed!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    const request = vi.fn(async (operation: string) => {
      if (operation !== 'status') throw Error('unexpected-gmail-operation');
      enter(); await gate;
      return { connected: true, email: 'owner@example.com',
        permissions: { search: true, read: false, compose: false } };
    });
    kernel.registerModule(new GmailModule({ available: true, request } as never));
    await kernel.start();
    const journalKey = Buffer.alloc(32, 0x2f);
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: workspace,
      stateRoot: path.join(workspace, 'state'), kernel, desktopAttestationToken: 'gmail-' + 'd'.repeat(48),
      hostToken: 'gmail-host-' + 'h'.repeat(48), journalEncryptionKey: journalKey,
      localModelHost: { endpoint: host.endpoint, bearerToken: 'astra-synthetic-product-local-only',
        hostGeneration: host.hostGeneration, modelDigest: host.modelDigest } });
    if (!pilot?.facade.agentTasks) throw Error('pilot-required');
    const turn = { id: 'gmail_v3_turn', clientRequestId: 'gmail_v3_request', conversationId: 'gmail_v3_conversation',
      inputMessageId: 'gmail_v3_message', source: 'desktop' as const, privacyMode: 'persistent' as const,
      request: { text: 'Проверь состояние моей подключённой почты.', attachmentIds: [], modifiers: {} } };
    const binding = pilot.bridge.bindAgent(turn as never); if (!binding) throw Error('gmail-binding-required');
    const facadeRequestId = 'oscar_' + turn.id;
    const sourceId = 'app_source_' + createHash('sha256').update(binding.actor.id + '/' + facadeRequestId).digest('hex').slice(0, 32);
    const taskId = astraAgentTaskId('product_pilot', sourceId);
    const catalogKey = createHmac('sha256', journalKey).update('monarch.astra-v3.generic-agent-catalog.v1').digest();
    const capabilityHandle = 'cap_' + createHmac('sha256', catalogKey)
      .update(taskId + '/gmail/gmail.connection.status').digest('hex').slice(0, 48); catalogKey.fill(0);
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle, argsJson: '{}', reason: 'Inspect the connected Gmail account.' }));
      await pilot.facade.startWithSourceRestore(async () => undefined);
      let task = pilot.facade.agentTasks.submit(binding.actor, { version: 1, clientRequestId: facadeRequestId,
        conversationId: turn.conversationId, inputMessageId: turn.inputMessageId, text: turn.request.text,
        privacyMode: 'persistent', selectionId: binding.selectionId, goal: binding.goal });
      expect(await Promise.race([entered.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000))])).toBe(true);
      const activeRecord = pilot.journal.read(task.id)?.checkpoint as unknown as { candidates: AstraAgentCapabilityCandidate[] };
      expect(activeRecord.candidates.filter(candidate => candidate.moduleId === 'gmail').map(candidate => candidate.capabilityId))
        .toEqual(['gmail.connection.status', 'gmail.draft.create', 'gmail.draft.send', 'gmail.message.read', 'gmail.messages.search']);
      await control(JSON.stringify({ kind: 'complete', text: 'Gmail подключён.', evidenceRef: 'receipt_0' }));
      proceed();
      const deadline = Date.now() + 10_000;
      while (!['completed', 'blocked', 'failed', 'cancelled'].includes(task.status) && Date.now() < deadline) {
        await pilot.facade.drain();
        task = pilot.facade.agentTasks.read(binding.actor, task.id,
          { conversationId: turn.conversationId, inputMessageId: turn.inputMessageId });
        if (task.status !== 'completed') await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (task.status !== 'completed') throw Error('gmail-v3-task:' + JSON.stringify({ task,
        record: pilot.journal.read(task.id)?.checkpoint }, null, 2));
      expect(task).toMatchObject({ id: taskId, status: 'completed', source: 'desktop', modelJobs: 2,
        capabilityJobs: 1, nativeCompletionCertified: true, message: { content: 'Gmail подключён.', delivery: 'pending',
          verification: 'native-agent-completion-certificate', nativeCompletionCertified: true } });
      expect(request).toHaveBeenCalledWith('status', {}, expect.anything());
      expect(pilot.journal.read(task.id)?.checkpoint).toMatchObject({
        schemaVersion: 'monarch.astra-v3-agent-task-archive.internal.v2', taskId,
      });
    } finally { proceed(); await pilot.stop(); await kernel.stop(); journalKey.fill(0); }
  }, 20_000);

  it('executes GitHub as an ordinary semantic V3 capability through Kernel without an activation phrase', async () => {
    const workspace = path.join(root, 'product-github-' + sequence++); await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    let enter!: () => void, proceed!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    const request = vi.fn(async (operation: string) => {
      if (operation !== 'status') throw Error('unexpected-github-operation');
      enter(); await gate;
      return { connected: true, login: 'owner', repositories: ['owner/project'],
        permissions: { read: true, issues: false, pullRequests: false } };
    });
    kernel.registerModule(new GitHubModule({ available: true, request } as never));
    await kernel.start();
    const journalKey = Buffer.alloc(32, 0x3f);
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: workspace,
      stateRoot: path.join(workspace, 'state'), kernel, desktopAttestationToken: 'github-' + 'd'.repeat(48),
      hostToken: 'github-host-' + 'h'.repeat(48), journalEncryptionKey: journalKey,
      localModelHost: { endpoint: host.endpoint, bearerToken: 'astra-synthetic-product-local-only',
        hostGeneration: host.hostGeneration, modelDigest: host.modelDigest } });
    if (!pilot?.facade.agentTasks) throw Error('pilot-required');
    const turn = { id: 'github_v3_turn', clientRequestId: 'github_v3_request', conversationId: 'github_v3_conversation',
      inputMessageId: 'github_v3_message', source: 'desktop' as const, privacyMode: 'persistent' as const,
      request: { text: 'Проверь состояние подключённого GitHub.', attachmentIds: [], modifiers: {} } };
    const binding = pilot.bridge.bindAgent(turn as never); if (!binding) throw Error('github-binding-required');
    const facadeRequestId = 'oscar_' + turn.id;
    const sourceId = 'app_source_' + createHash('sha256').update(binding.actor.id + '/' + facadeRequestId).digest('hex').slice(0, 32);
    const taskId = astraAgentTaskId('product_pilot', sourceId);
    const catalogKey = createHmac('sha256', journalKey).update('monarch.astra-v3.generic-agent-catalog.v1').digest();
    const capabilityHandle = 'cap_' + createHmac('sha256', catalogKey)
      .update(taskId + '/github/github.connection.status').digest('hex').slice(0, 48); catalogKey.fill(0);
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle, argsJson: '{}', reason: 'Inspect the connected GitHub account.' }));
      await pilot.facade.startWithSourceRestore(async () => undefined);
      let task = pilot.facade.agentTasks.submit(binding.actor, { version: 1, clientRequestId: facadeRequestId,
        conversationId: turn.conversationId, inputMessageId: turn.inputMessageId, text: turn.request.text,
        privacyMode: 'persistent', selectionId: binding.selectionId, goal: binding.goal });
      expect(await Promise.race([entered.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000))])).toBe(true);
      const activeRecord = pilot.journal.read(task.id)?.checkpoint as unknown as { candidates: AstraAgentCapabilityCandidate[] };
      expect(activeRecord.candidates.filter(candidate => candidate.moduleId === 'github').map(candidate => candidate.capabilityId))
        .toEqual(['github.connection.status', 'github.issue.create', 'github.issues.list', 'github.pull-request.comment',
          'github.pull-requests.list', 'github.repositories.list', 'github.repository.file.read']);
      await control(JSON.stringify({ kind: 'complete', text: 'GitHub подключён.', evidenceRef: 'receipt_0' }));
      proceed();
      const deadline = Date.now() + 10_000;
      while (!['completed', 'blocked', 'failed', 'cancelled'].includes(task.status) && Date.now() < deadline) {
        await pilot.facade.drain();
        task = pilot.facade.agentTasks.read(binding.actor, task.id,
          { conversationId: turn.conversationId, inputMessageId: turn.inputMessageId });
        if (task.status !== 'completed') await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (task.status !== 'completed') throw Error('github-v3-task:' + JSON.stringify({ task,
        record: pilot.journal.read(task.id)?.checkpoint }, null, 2));
      expect(task).toMatchObject({ id: taskId, status: 'completed', source: 'desktop', modelJobs: 2,
        capabilityJobs: 1, nativeCompletionCertified: true, message: { content: 'GitHub подключён.', delivery: 'pending',
          verification: 'native-agent-completion-certificate', nativeCompletionCertified: true } });
      expect(request).toHaveBeenCalledWith('status', {}, expect.anything());
      expect(pilot.journal.read(task.id)?.checkpoint).toMatchObject({
        schemaVersion: 'monarch.astra-v3-agent-task-archive.internal.v2', taskId,
      });
    } finally { proceed(); await pilot.stop(); await kernel.stop(); journalKey.fill(0); }
  }, 20_000);

  it('executes Google Calendar as an ordinary semantic V3 capability without an activation phrase', async () => {
    const workspace = path.join(root, 'product-calendar-' + sequence++); await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    let enter!: () => void, proceed!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    const request = vi.fn(async (operation: string) => {
      if (operation !== 'status') throw Error('unexpected-calendar-operation');
      enter(); await gate;
      return { connected: true, account: 'owner@example.com', calendarName: 'Owner calendar',
        permissions: { read: true, manage: false } };
    });
    kernel.registerModule(new CalendarModule({ available: true, request } as never));
    await kernel.start();
    const journalKey = Buffer.alloc(32, 0x4f);
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: workspace,
      stateRoot: path.join(workspace, 'state'), kernel, desktopAttestationToken: 'calendar-' + 'd'.repeat(48),
      hostToken: 'calendar-host-' + 'h'.repeat(48), journalEncryptionKey: journalKey,
      localModelHost: { endpoint: host.endpoint, bearerToken: 'astra-synthetic-product-local-only',
        hostGeneration: host.hostGeneration, modelDigest: host.modelDigest } });
    if (!pilot?.facade.agentTasks) throw Error('pilot-required');
    const turn = { id: 'calendar_v3_turn', clientRequestId: 'calendar_v3_request', conversationId: 'calendar_v3_conversation',
      inputMessageId: 'calendar_v3_message', source: 'desktop' as const, privacyMode: 'persistent' as const,
      request: { text: 'Проверь состояние подключённого календаря.', attachmentIds: [], modifiers: {} } };
    const binding = pilot.bridge.bindAgent(turn as never); if (!binding) throw Error('calendar-binding-required');
    const facadeRequestId = 'oscar_' + turn.id;
    const sourceId = 'app_source_' + createHash('sha256').update(binding.actor.id + '/' + facadeRequestId).digest('hex').slice(0, 32);
    const taskId = astraAgentTaskId('product_pilot', sourceId);
    const catalogKey = createHmac('sha256', journalKey).update('monarch.astra-v3.generic-agent-catalog.v1').digest();
    const capabilityHandle = 'cap_' + createHmac('sha256', catalogKey)
      .update(taskId + '/calendar/calendar.connection.status').digest('hex').slice(0, 48); catalogKey.fill(0);
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle, argsJson: '{}', reason: 'Inspect the connected calendar.' }));
      await pilot.facade.startWithSourceRestore(async () => undefined);
      let task = pilot.facade.agentTasks.submit(binding.actor, { version: 1, clientRequestId: facadeRequestId,
        conversationId: turn.conversationId, inputMessageId: turn.inputMessageId, text: turn.request.text,
        privacyMode: 'persistent', selectionId: binding.selectionId, goal: binding.goal });
      expect(await Promise.race([entered.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000))])).toBe(true);
      const activeRecord = pilot.journal.read(task.id)?.checkpoint as unknown as { candidates: AstraAgentCapabilityCandidate[] };
      expect(activeRecord.candidates.filter(candidate => candidate.moduleId === 'calendar').map(candidate => candidate.capabilityId))
        .toEqual(['calendar.calendars.list', 'calendar.connection.status', 'calendar.event.create',
          'calendar.event.update', 'calendar.events.list']);
      await control(JSON.stringify({ kind: 'complete', text: 'Google Calendar подключён.', evidenceRef: 'receipt_0' }));
      proceed();
      const deadline = Date.now() + 10_000;
      while (!['completed', 'blocked', 'failed', 'cancelled'].includes(task.status) && Date.now() < deadline) {
        await pilot.facade.drain();
        task = pilot.facade.agentTasks.read(binding.actor, task.id,
          { conversationId: turn.conversationId, inputMessageId: turn.inputMessageId });
        if (task.status !== 'completed') await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (task.status !== 'completed') throw Error('calendar-v3-task:' + JSON.stringify({ task,
        record: pilot.journal.read(task.id)?.checkpoint }, null, 2));
      expect(task).toMatchObject({ id: taskId, status: 'completed', source: 'desktop', modelJobs: 2,
        capabilityJobs: 1, nativeCompletionCertified: true, message: { content: 'Google Calendar подключён.',
          delivery: 'pending', verification: 'native-agent-completion-certificate', nativeCompletionCertified: true } });
      expect(request).toHaveBeenCalledWith('status', {}, expect.anything());
    } finally { proceed(); await pilot.stop(); await kernel.stop(); journalKey.fill(0); }
  }, 20_000);

  it('binds a Coder V3 capability to the host-selected project and hides project switching from the model', async () => {
    const workspace = path.join(root, 'product-coder-' + sequence++); await mkdir(workspace);
    const kernel = new MonarchKernel({ workspaceRoot: workspace, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    const capabilityId = 'coder.fixture.inspect';
    let observedInput: Record<string, unknown> | undefined;
    let enter!: () => void, proceed!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    kernel.registerModule({ manifest: { id: 'coder-v3-fixture', name: 'Coder V3 route fixture', version: '1.0.0',
      kind: 'runtime', description: 'Project binding fixture.', owns: ['synthetic project scope'], permissions: ['read'],
      capabilities: [
        { id: capabilityId, moduleId: 'coder-v3-fixture', title: 'Inspect selected Coder project', risk: 'read',
          inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, path: { type: 'string' } },
            required: ['projectId', 'path'], additionalProperties: false },
          agent: { supportedSources: ['coder'], cancellation: 'supported' } },
        { id: 'coder.projects.activate', moduleId: 'coder-v3-fixture', title: 'Switch Coder project', risk: 'read',
          inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false },
          agent: { supportedSources: ['coder'], cancellation: 'supported' } },
        { id: 'coder.fixture.desktop-only', moduleId: 'coder-v3-fixture', title: 'Desktop-only decoy', risk: 'read',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          agent: { supportedSources: ['desktop'], cancellation: 'supported' } },
      ] }, async activate() {}, async executeCapability(request) {
        if (request.capabilityId !== capabilityId) throw Error('unexpected-coder-capability');
        observedInput = structuredClone(request.input); enter(); await gate;
        return { ok: true, summary: 'The bound Coder project was observed.', output: { projectId: request.input.projectId, verified: true } };
      } });
    kernel.registerModule(isolatedLocalSecurity(workspace)); await kernel.start();
    const journalKey = Buffer.alloc(32, 0x6d), clientRequestId = 'coder_v3_facade_request';
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: workspace,
      stateRoot: path.join(workspace, 'state'), kernel, desktopAttestationToken: 'coder-' + 'd'.repeat(48),
      hostToken: 'coder-host-' + 'h'.repeat(48), journalEncryptionKey: journalKey,
      localModelHost: { endpoint: host.endpoint, bearerToken: 'astra-synthetic-product-local-only',
        hostGeneration: host.hostGeneration, modelDigest: 'sha256:' + '1'.repeat(64), modelDigests: {
          'gemma4-fast': 'sha256:' + '1'.repeat(64),
          'qwen3-coder-30b-a3b-instruct': host.modelDigest,
          'deepseek-coder-v2-lite-instruct': 'sha256:' + '2'.repeat(64),
        } } });
    expect(pilot?.facade.agentTasks).toBeDefined(); if (!pilot) throw Error('pilot-required');
    const executionProfile = {
      schemaVersion: 'monarch.agent-execution-profile.v1' as const, kind: 'coder-project' as const,
      projectId: 'project_selected_by_host', projectRoot: workspace,
      permissionProfile: { sandboxMode: 'workspace-write' as const, approvalPolicy: 'on-request' as const,
        autonomyMode: 'workspace-autonomous' as const },
    };
    const coderPrompt = 'Проверь src/ready.ts только в выбранном Coder проекте.';
    expect(pilot.bridge.bindAgent({ clientRequestId, conversationId: 'coder_v3_conversation',
      inputMessageId: 'coder_v3_message', source: 'coder', privacyMode: 'persistent',
      request: { text: coderPrompt, attachmentIds: [],
        modifiers: { requestedModel: 'qwen3-coder-30b-a3b-instruct', reasoningEffort: 'high', researchMode: 'off' },
        executionProfile },
    } as never)).toMatchObject({ goal: { kind: 'agent', modelMode: 'local',
      modelChoice: 'qwen3-coder-30b-a3b-instruct' }, actor: pilot.coderActor });
    const sourceId = 'app_source_' + createHash('sha256').update(pilot.coderActor.id + '/' + clientRequestId).digest('hex').slice(0, 32);
    const taskId = astraAgentTaskId('product_pilot', sourceId);
    const catalogKey = createHmac('sha256', journalKey).update('monarch.astra-v3.generic-agent-catalog.v1').digest();
    const capabilityHandle = 'cap_' + createHmac('sha256', catalogKey)
      .update(taskId + '/coder-v3-fixture/' + capabilityId).digest('hex').slice(0, 48); catalogKey.fill(0);
    const before = await metrics();
    try {
      await control(JSON.stringify({ kind: 'act', capabilityHandle, argsJson: '{"path":"src/ready.ts"}',
        reason: 'Inspect the requested path inside the selected project.' }));
      await pilot.facade.startWithSourceRestore(async () => undefined);
      const submitted = pilot.facade.agentTasks!.submit(pilot.coderActor, {
        version: 1, clientRequestId, conversationId: 'coder_v3_conversation', inputMessageId: 'coder_v3_message',
        text: coderPrompt, selectionId: 'coder_v3_selection', privacyMode: 'persistent',
        goal: { kind: 'agent', modelMode: 'local', modelChoice: 'qwen3-coder-30b-a3b-instruct' }, executionProfile,
      });
      expect(submitted.id).toBe(taskId);
      const actionEntered = await Promise.race([entered.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 5000))]);
      if (!actionEntered) throw Error('coder-v3-capability-timeout:' + JSON.stringify({
        task: pilot.facade.agentTasks!.read(pilot.coderActor, taskId,
          { conversationId: 'coder_v3_conversation', inputMessageId: 'coder_v3_message' }),
        jobs: pilot.scheduler.list(), host: pilot.facade.hostStatus(), metrics: await metrics(),
      }));
      const taskRecord = pilot.journal.read(taskId)!.checkpoint as unknown as {
        candidates: AstraAgentCapabilityCandidate[]; policy: { expectedModelDigest: string; maxModelTurns: number; maxCapabilityCalls: number };
        deadline: number; createdAt: number;
      };
      expect(taskRecord.candidates).toEqual([expect.objectContaining({ capabilityId })]);
      expect(taskRecord.candidates[0]?.inputSchema).toMatchObject({ required: ['path'] });
      expect(taskRecord.candidates[0]?.inputSchema.properties).not.toHaveProperty('projectId');
      expect(taskRecord.policy).toMatchObject({ expectedModelDigest: host.modelDigest, maxModelTurns: 64, maxCapabilityCalls: 48 });
      expect(taskRecord.deadline - taskRecord.createdAt).toBe(12 * 60 * 60 * 1000);
      expect(pilot.scheduler.list()).toHaveLength(1);
      expect(observedInput).toEqual({ path: 'src/ready.ts', projectId: 'project_selected_by_host' });

      await control(JSON.stringify({ kind: 'complete', text: 'Проект подтверждён через V3.', evidenceRef: 'receipt_0' }));
      proceed();
      let completed = submitted, deadline = Date.now() + 10_000;
      while (completed.status !== 'completed' && Date.now() < deadline) {
        await pilot.facade.drain();
        completed = pilot.facade.agentTasks!.read(pilot.coderActor, taskId,
          { conversationId: 'coder_v3_conversation', inputMessageId: 'coder_v3_message' });
        if (completed.status !== 'completed') await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(completed).toMatchObject({ status: 'completed', source: 'coder', modelJobs: 2, capabilityJobs: 1,
        message: { content: 'Проект подтверждён через V3.' },
        activities: [{ capabilityId, state: 'observed', ok: true }] });
      expect((await metrics()).generationCalls - before.generationCalls).toBe(2);
    } finally {
      proceed(); await pilot.stop(); await kernel.stop(); journalKey.fill(0);
    }
  }, 20_000);

  it.each([20, 45000, 90000, 120000])('seals admitted model timeout %s plus bounded cleanup, without making a model call', async timeoutMs => {
    const s = modelWorkSetup(), before = await metrics();
    try {
      const job = s.submit({ timeoutMs }); expect(job.activationBudgetMs).toBe(timeoutMs + 5000);
      expect((job.input as unknown as AstraModelWorkInput).timeoutMs).toBe(timeoutMs);
      expect((await metrics()).generationCalls).toBe(before.generationCalls);
    } finally { await s.close(); }
  });
  it('allows an independent real Kernel read while the common model slot is occupied', async () => {
    await control(JSON.stringify(readDecision), { block: true });
    const journal = new AstraJournal(':memory:'), kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root })); await kernel.start();
    const model = new AstraModelWorkAdapter({ deployment: 'isolated-validation', journal, client: client(), isSourceCurrent: () => true });
    const reads = new AstraReadWorkAdapter({ canonicalRoot: root, kernel, journal });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'shared_native_' + sequence++,
      adapters: [model, reads], limits: { activationTimeoutMs: 5000 } });
    const dispatch = vi.spyOn(kernel, 'executeActionProposal'); scheduler.acquire();
    try {
      const modelJob = scheduler.submit({ requestId: 'independent_model', adapterId: model.id, input: JSON.parse(JSON.stringify({
        source: source(), candidates, catalogRevision: 1, expectedModelDigest: host.modelDigest, timeoutMs: 5000 })) as AstraJson });
      const readJob = scheduler.submit({ requestId: 'independent_read', adapterId: reads.id,
        input: { steps: [{ id: 'owned_read', relativePath: 'synthetic.txt', maxBytes: 8192 }] } });
      const draining = scheduler.drain(); await waitFor(async () => (await metrics()).workerStarted);
      await waitFor(async () => scheduler.job(readJob.id).state === 'observed');
      expect((await metrics()).slotReserved).toBe(true); expect(dispatch).toHaveBeenCalledTimes(1);
      await release(); await draining; expect(scheduler.job(modelJob.id).state).toBe('observed');
      expect(dispatch).toHaveBeenCalledTimes(1); // A model proposal did not dispatch its own tool.
    } finally { await release(); await scheduler.close(); dispatch.mockRestore(); await kernel.stop(); journal.close(); }
  });

  it.each([undefined, 'sha256:' + 'a'.repeat(64)])('persists guarded intent/output (%s) and recovers after journal reopen without another call', async memoryValidityToken => {
    await control(); const before = await metrics(), file = path.join(fixture, 'model-work-' + sequence++ + '.sqlite');
    const s = modelWorkSetup({ file });
    try {
      const job = s.submit(memoryValidityToken === undefined ? {} : { memoryValidityToken }); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('observed');
      const input = job.input as unknown as AstraModelWorkInput;
      const checkpoint = s.journal.read(input.workId!)!.checkpoint as unknown as AstraModelWorkCheckpoint;
      expect(input.memoryValidityToken).toBe(memoryValidityToken);
      expect(checkpoint.remote?.request.memoryValidityToken).toBe(memoryValidityToken);
      expect(checkpoint.turn?.memoryValidityToken).toBe(memoryValidityToken);
      expect(checkpoint).toMatchObject({ attempts: 1, phase: 'settled', quiescent: true,
        seal: { promptDigest: expect.stringMatching(/^sha256:/u) }, output: { authority: 'none' } });
      const decision = s.adapter.decision(job.input);
      expect(decision).toMatchObject({ status: 'accepted', proposal: { kind: 'read', request: candidates[0]!.request } });
      expect(s.journal.reservation(job.reservationId)).toBeNull();
      await s.close();
      const noNetwork = vi.fn<typeof fetch>(async () => { throw Error('reopen must not use network'); });
      const reopened = modelWorkSetup({ file, scopeId: s.hostOptions.scopeId, transport: noNetwork });
      try {
        await reopened.scheduler.drain(); expect(reopened.scheduler.job(job.id).state).toBe('observed');
        expect(reopened.adapter.decision(job.input)).toEqual(decision); expect(noNetwork).not.toHaveBeenCalled();
      } finally { await reopened.close(); }
      expect((await metrics()).generationCalls - before.generationCalls).toBe(1);
    } finally { await s.close(); }
  });

  it('parks queued work without model admission and supports explicit resume/cancel', async () => {
    await control(); const before = await metrics(), s = modelWorkSetup();
    try {
      const job = s.submit(); expect(s.scheduler.command(job.id, 'pause').state).toBe('paused');
      await s.scheduler.drain(); expect((await metrics()).generationCalls).toBe(before.generationCalls);
      expect(s.scheduler.command(job.id, 'resume').state).toBe('queued');
      await s.scheduler.drain(); expect(s.scheduler.job(job.id).state).toBe('observed');
      const cancelled = s.submit(); expect(s.scheduler.command(cancelled.id, 'cancel').state).toBe('cancelled');
      await s.scheduler.drain(); expect((await metrics()).generationCalls - before.generationCalls).toBe(1);
    } finally { await s.close(); }
  });

  it('finishes an in-flight paused generation but does not use its proposal until explicit resume', async () => {
    await control(JSON.stringify(readDecision), { block: true }); const before = await metrics(), s = modelWorkSetup();
    try {
      const job = s.submit(), draining = s.scheduler.drain();
      await waitFor(async () => (await metrics()).workerStarted);
      expect(s.scheduler.command(job.id, 'pause').state).toBe('pausing');
      expect(s.adapter.decision(job.input)).toBeUndefined(); expect((await metrics()).slotReserved).toBe(true);
      await release(); await draining;
      expect(s.scheduler.job(job.id).state).toBe('paused'); expect(s.adapter.decision(job.input)).toBeUndefined();
      s.scheduler.command(job.id, 'resume'); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('observed');
      expect((await metrics()).generationCalls - before.generationCalls).toBe(1);
    } finally { await release(); await s.close(); }
  });

  it('cancel keeps the unresolved model reservation until remote physical acknowledgement', async () => {
    await control(JSON.stringify(readDecision), { block: true }); const s = modelWorkSetup();
    try {
      const job = s.submit(), draining = s.scheduler.drain();
      await waitFor(async () => (await metrics()).workerStarted);
      expect(s.scheduler.command(job.id, 'cancel').state).toBe('cancelling'); await draining;
      expect(s.scheduler.job(job.id).state).toBe('cancelling'); expect(s.journal.reservation(job.reservationId)).not.toBeNull();
      expect((await s.scheduler.reconcileRemote(job.id)).state).toBe('cancelling');
      expect((await metrics()).slotReserved).toBe(true);
      await release(); await waitFor(async () => !(await metrics()).slotReserved);
      expect((await s.scheduler.reconcileRemote(job.id)).state).toBe('cancelled');
      expect(s.journal.reservation(job.reservationId)).toBeNull(); expect(s.adapter.decision(job.input)).toBeUndefined();
    } finally { await release(); await s.close(); }
  });

  it.each([undefined, 'sha256:' + 'a'.repeat(64)])('recovers guarded result (%s) after first durable write fails without repeating inference', async memoryValidityToken => {
    await control(); const before = await metrics(), s = modelWorkSetup();
    const write = s.journal.appendAtomic.bind(s.journal); let failed = false;
    const fault = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((commit, guard) => {
      if (!failed && commit.primary.streamId.startsWith('model_work_')
        && (commit.primary.checkpoint as unknown as AstraModelWorkCheckpoint).phase === 'returned') {
        failed = true; throw Error('owned model-output storage fault');
      }
      return write(commit, guard);
    });
    try {
      const job = s.submit(memoryValidityToken === undefined ? {} : { memoryValidityToken }); await s.scheduler.drain();
      expect(failed).toBe(true); expect(s.scheduler.job(job.id).state).toBe('indeterminate');
      expect(s.journal.reservation(job.reservationId)).not.toBeNull(); expect((await metrics()).slotReserved).toBe(false);
      expect((await s.scheduler.reconcileRemote(job.id)).state).toBe('observed');
      expect(s.adapter.decision(job.input)).toMatchObject({ status: 'accepted', proposal: { kind: 'read' } });
      expect((await metrics()).generationCalls - before.generationCalls).toBe(1);
    } finally { fault.mockRestore(); await s.close(); }
  });

  it('does not repair malformed model decisions or turn completion prose into executed work', async () => {
    const s = modelWorkSetup();
    try {
      await control('{'); const before = await metrics(), invalid = s.submit(); await s.scheduler.drain();
      expect(s.scheduler.job(invalid.id).state).toBe('blocked');
      expect(s.adapter.decision(invalid.input)).toMatchObject({ status: 'blocked', code: 'decision-json-invalid' });
      expect((await metrics()).generationCalls - before.generationCalls).toBe(1);
      await control('{"kind":"request-completion"}'); const requested = s.submit(); await s.scheduler.drain();
      expect(s.adapter.decision(requested.input)).toMatchObject({ status: 'accepted', authority: 'none', proposal: { kind: 'request-completion' } });
      expect(JSON.stringify(s.adapter.decision(requested.input))).not.toContain('nativeCompletionCertified');
    } finally { await s.close(); }
  });

  it('a replacement owner fences old work and retries only after physical quiescence within the attempt budget', async () => {
    await control(JSON.stringify(readDecision), { block: true }); let now = Date.now();
    const s = modelWorkSetup({ now: () => now }), before = await metrics();
    let replacement: AstraWorkScheduler | undefined;
    try {
      const job = s.submit(), oldDrain = s.scheduler.drain();
      await waitFor(async () => (await metrics()).workerStarted);
      const workId = (job.input as unknown as AstraModelWorkInput).workId!;
      now += 2000; replacement = new AstraWorkScheduler(s.hostOptions); replacement.acquire();
      expect(replacement.job(job.id).state).toBe('indeterminate');
      expect((await replacement.reconcileRemote(job.id)).state).toBe('indeterminate');
      const fencedRevision = s.journal.read(workId)!.revision;
      expect((await metrics()).slotReserved).toBe(true);
      await release(); await oldDrain; await waitFor(async () => !(await metrics()).slotReserved);
      expect(s.journal.read(workId)!.revision).toBe(fencedRevision); // Old callback cannot rewrite the new owner's facts.
      expect((await replacement.reconcileRemote(job.id)).state).toBe('queued');
      await control(); await replacement.drain();
      expect(replacement.job(job.id).state).toBe('observed');
      expect((s.journal.read(workId)!.checkpoint as unknown as AstraModelWorkCheckpoint).attempts).toBe(2);
      expect((await metrics()).generationCalls - before.generationCalls).toBe(2);
    } finally { await release(); await replacement?.close(); await s.close(); }
  });

  it('rejects contradictory remote quiescence instead of releasing a still-running native reservation', async () => {
    await control(JSON.stringify(readDecision), { block: true }); let corrupt = true;
    const transport: typeof fetch = async (...args) => {
      const response = await fetch(...args);
      if (corrupt && String(args[0]).endsWith('/settle-request') && response.ok) {
        const body = await response.json() as Record<string, unknown>;
        return new Response(JSON.stringify({ ...body, quiescent: true }), { headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    };
    const s = modelWorkSetup({ transport });
    try {
      const job = s.submit(), draining = s.scheduler.drain();
      await waitFor(async () => (await metrics()).workerStarted);
      s.scheduler.command(job.id, 'cancel'); await draining;
      const refused = await s.scheduler.reconcileRemote(job.id);
      expect(refused).toMatchObject({ state: 'cancelling', reason: 'adapter-recovery-failed' });
      expect(s.journal.reservation(job.reservationId)).not.toBeNull(); expect((await metrics()).slotReserved).toBe(true);
      corrupt = false; await release(); await waitFor(async () => !(await metrics()).slotReserved);
      expect((await s.scheduler.reconcileRemote(job.id)).state).toBe('cancelled');
    } finally { await release(); await s.close(); }
  });

  it('rejects stale source before native admission and cannot overwrite a revoked goal with model output', async () => {
    let current = true; const s = modelWorkSetup({ current: () => current });
    try {
      await control(); const before = await metrics(), job = s.submit(); current = false;
      await s.scheduler.drain(); expect(s.scheduler.job(job.id).state).toBe('blocked');
      expect((await metrics()).generationCalls).toBe(before.generationCalls);
      expect(() => s.submit()).toThrow('source-stale');
    } finally { await s.close(); }
  });
});

describe('Astra V3 prepared model transport → exact Context → Decision Gateway', () => {
  it.each([false, true])('joins real Memory V4, Application and local model (delete at generation boundary=%s)', async revokeMemory => {
    const memoryRoot = await realpath(await mkdtemp(path.join(parent, 'astra-v3-memory-')));
    const memoryMarker = 'astra-v3-memory-server-synthetic-only';
    await writeFile(path.join(memoryRoot, '.fixture-marker'), memoryMarker, { flag: 'wx' });
    await writeFile(path.join(memoryRoot, 'oscar_token.txt'), 'synthetic-memory-only', { flag: 'wx' });
    const memoryChild = spawn(path.resolve('oscar/.venv/Scripts/python.exe'), ['-B', path.resolve('tests/fixtures/agent-v3/memory-server.py'), memoryRoot],
      { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    memoryChild.stdin.end();
    const exited = new Promise<void>(resolve => memoryChild.once('exit', () => resolve()));
    const old = new Map<string, string | undefined>();
    let app: MonarchApplication | undefined;
    let restorePrepare = () => {};
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = '', errors = '';
        const timer = setTimeout(() => reject(Error('memory-start-timeout')), 10000);
        memoryChild.once('error', error => { clearTimeout(timer); reject(error); });
        memoryChild.once('exit', () => { clearTimeout(timer); reject(Error('memory-exit:' + errors.slice(-1000))); });
        memoryChild.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
        memoryChild.stdout.on('data', chunk => { output += chunk; if (!output.includes('\n')) return;
          clearTimeout(timer); const info = JSON.parse(output.split('\n')[0]!); expect(info.marker).toBe(memoryMarker); resolve(info.endpoint); });
      });
      const env: Record<string, string | undefined> = {
        MONARCH_ASTRA_V3_PILOT: ASTRA_PRODUCT_PILOT_MODE, MONARCH_DESKTOP_ATTESTATION_TOKEN: 'a'.repeat(64), MONARCH_ASTRA_V3_HOST_TOKEN: 'b'.repeat(64),
        MONARCH_ASTRA_V3_JOURNAL_KEY: Buffer.alloc(32, 0x4f).toString('base64'),
        MONARCH_ASTRA_V3_MODEL_MODE: 'local', MONARCH_ASTRA_V3_LOCAL_MEMORY: 'owner-settings-v1',
        MONARCH_ASTRA_V3_MODEL_HOST_ENDPOINT: host.endpoint, MONARCH_ASTRA_V3_MODEL_HOST_TOKEN: 'astra-synthetic-product-local-only',
        MONARCH_ASTRA_V3_MODEL_HOST_GENERATION: host.hostGeneration, MONARCH_ASTRA_V3_MODEL_DIGEST: host.modelDigest,
        MONARCH_ASTRA_V3_MODEL_DIGESTS: undefined, MONARCH_ASTRA_TELEGRAM_MODE: undefined,
        MONARCH_STATE_ROOT: path.join(memoryRoot, 'app-state'), MONARCH_WORKSPACE_ROOT: root, MONARCH_SECRETS_ROOT: memoryRoot,
        MONARCH_DATA_ROOT: path.join(memoryRoot, 'app-data'), MONARCH_LOGS_ROOT: path.join(memoryRoot, 'logs'),
        MONARCH_MODELS_ROOT: path.join(memoryRoot, 'models'), OSCAR_API_BASE: endpoint, OSCAR_AUTO_START: 'false',
      };
      for (const [key, value] of Object.entries(env)) { old.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      app = new MonarchApplication({ workspaceRoot: root, enabledModules: ['workspace'], enableLocalSystemRouter: false,
        modelComponentManager: { initialize: async () => {}, stop: async () => {} } as any });
      const pilot = app.astraProductPilot!, coordinator = app.oscarTurnCoordinator;
      expect((await fetch(host.endpoint + '/__fixture/memory', { method: 'POST', headers,
        body: JSON.stringify({ root: memoryRoot }) })).ok).toBe(true);
      if (revokeMemory) {
        const original = AstraPreparedModelClient.prototype.generate;
        let deleted = false;
        const spy = vi.spyOn(AstraPreparedModelClient.prototype, 'generate').mockImplementation(async function (
          this: AstraPreparedModelClient, prepared, signal?: AbortSignal) {
          if (!deleted) {
            deleted = true;
            const receipt = await fetch(endpoint + '/fixture/delete', { method: 'POST', headers: { 'X-Oscar-Token': 'synthetic-memory-only' }, body: '{}' });
            expect(receipt.ok).toBe(true);
          }
          return original.call(this, prepared, signal);
        });
        restorePrepare = () => spy.mockRestore();
      }
      const dispatch = vi.spyOn(app.runtime.kernel, 'executeActionProposal');
      await control(JSON.stringify({ kind: 'respond', text: 'В выбранном файле находятся символы x.' }));
      const before = await metrics();
      const selected = pilot.issuePickedTarget(pilot.actor, { version: 1, conversationId: 'memory_chain', requestId: 'memory_target',
        access: 'observe', selectedPath: path.join(root, 'synthetic.txt') });
      await app.start();
      const request = { clientRequestId: 'memory_chain_request', conversationId: 'memory_chain', inputMessageId: 'memory_chain_message',
        source: 'desktop' as const, privacyMode: 'persistent' as const, text: 'syntheticneedle: проанализируй выбранный файл.',
        astra: { selectionId: selected.selectionId, goal: { kind: 'analyze' as const, targets: [selected.targets[0]!.targetId], modelMode: 'local' as const } } };
      let checkpoint = await coordinator.submit(request);
      const deadline = Date.now() + 10000;
      const expectedStatus = revokeMemory ? 'blocked' : 'succeeded';
      while (checkpoint.turn.status !== expectedStatus && Date.now() < deadline) {
        await pilot.facade.drain(); await coordinator.flushOutbox(); checkpoint = (await coordinator.getTurn(checkpoint.turn.id))!;
      }
      expect(checkpoint.turn.status).toBe(expectedStatus);
      const task = pilot.bridge.find(checkpoint.turn)!;
      const retained = pilot.journal.read(task.id)!.checkpoint as any;
      expect(retained.memoryRecall.items[0].text).toBe('syntheticneedle use concise answers');
      const model = (pilot.scheduler.list().find(job => job.adapterId === 'goal-read-model')!.input as any).model;
      expect(model.memoryValidityToken).toBe(retained.memoryRecall.validityToken);
      const context = pilot.journal.read('context_' + model.contextExecutionId)!.checkpoint as any;
      expect(context.active.surface).toContain('syntheticneedle use concise answers');
      expect(dispatch).toHaveBeenCalledTimes(1); expect((await metrics()).generationCalls - before.generationCalls).toBe(revokeMemory ? 0 : 1);
      expect((await metrics()).slotReserved).toBe(false);
      expect((await metrics()).memoryRejections - before.memoryRejections).toBe(revokeMemory ? 1 : 0);
      if (!revokeMemory) expect(task.message?.delivery).toBe('acknowledged');
      expect((await coordinator.submit(request)).turn.id).toBe(checkpoint.turn.id);
      const counts = await fetch(endpoint + '/fixture/metrics', { method: 'POST', headers: { 'X-Oscar-Token': 'synthetic-memory-only' }, body: '{}' });
      expect(await counts.json()).toEqual({ retrievals: 1 });
      dispatch.mockRestore();
    } finally {
      restorePrepare();
      await app?.stop(); await app?.astraProductPilot?.stop();
      expect((await fetch(host.endpoint + '/__fixture/memory', { method: 'POST', headers, body: '{}' })).ok).toBe(true);
      for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      if (memoryChild.exitCode === null) memoryChild.kill(); await exited;
      expect(await realpath(memoryRoot)).toBe(memoryRoot); expect(path.dirname(memoryRoot)).toBe(parent);
      expect(await readFile(path.join(memoryRoot, '.fixture-marker'), 'utf8')).toBe(memoryMarker);
      await rm(memoryRoot, { recursive: true });
    }
  });
  it('runs explicit local analysis through the same product host, Oscar and Kernel', async () => {
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'never' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] })); await kernel.start();
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(fixture, 'local-product-state'), kernel,
      desktopAttestationToken: 'a'.repeat(64), hostToken: 'b'.repeat(64),
      journalEncryptionKey: Buffer.alloc(32, 0x4f),
      localModelHost: { ...host, bearerToken: 'astra-synthetic-product-local-only' } })!;
    const coordinator = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(),
      volatileStore: new InMemoryOscarTurnStore(), astra: pilot.bridge,
      answerExecutor: async () => { throw Error('legacy-forbidden'); }, persistMessage: async () => ({ disposition: 'created' }) });
    const dispatch = vi.spyOn(kernel, 'executeActionProposal');
    try {
      await control(JSON.stringify({ kind: 'respond', text: 'В выбранном синтетическом файле записаны символы x.' }));
      const before = await metrics();
      const selection = pilot.issuePickedTarget(pilot.actor, { version: 1, conversationId: 'local_conversation',
        requestId: 'local_target', access: 'observe', selectedPath: path.join(root, 'synthetic.txt') });
      await pilot.facade.startWithSourceRestore(() => coordinator.start());
      let task = await coordinator.submit({ clientRequestId: 'local_analysis', conversationId: 'local_conversation',
        inputMessageId: 'local_message', source: 'desktop', privacyMode: 'persistent', text: 'Проанализируй выбранный файл.',
        astra: { selectionId: selection.selectionId,
          goal: { kind: 'analyze', targets: [selection.targets[0]!.targetId], modelMode: 'local' } } });
      const deadline = Date.now() + 10000;
      while (task.turn.status !== 'succeeded' && Date.now() < deadline) {
        await pilot.facade.drain(); await coordinator.flushOutbox(); task = (await coordinator.getTurn(task.turn.id))!;
      }
      expect(task.turn.status).toBe('succeeded');
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await metrics()).generationCalls - before.generationCalls).toBe(1);
      expect(pilot.bridge.find(task.turn)?.message?.content).toContain('синтетическом файле');
    } finally { await coordinator.stop(); await pilot.stop(); await kernel.stop(); dispatch.mockRestore(); }
  });
  it.each(['cancel', 'timeout'] as const)('bounds a non-cooperative live-source probe: %s', async mode => {
    const journal = new AstraJournal(':memory:');
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const opt = options(journal);
    const open = vi.spyOn(opt.client, 'open');
    let probeSignal: AbortSignal | undefined;
    try {
      const run = decideAstraReadWithModel({ ...opt, signal: controller.signal,
        validateSource: signal => { probeSignal = signal; started(); return new Promise<boolean>(() => {}); } });
      await entered;
      if (mode === 'cancel') controller.abort();
      await expect(run).resolves.toMatchObject({ status: 'blocked', code: 'stale-source', model: { slotState: 'not-opened' } });
      expect(probeSignal?.aborted).toBe(true);
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); journal.close(); }
  });
  it('checks client capacity before remote admission, while allowing an owned request replay', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; executionId: string };
      return new Response(JSON.stringify({ turnId: 'turn_' + request.requestId, hostGeneration: host.hostGeneration,
        executionId: request.executionId, state: 'ready', reason: null, slotReserved: true,
        binding: { driverGeneration: 'owned_fixture_driver', modelDigest: host.modelDigest,
          tokenizerDigest: 'sha256:' + 'a'.repeat(64), framingDigest: 'sha256:' + 'b'.repeat(64), contextTokens: 16384,
          safetyTokens: 96, profile: 'monarch.astra-v3-prepared-text.internal.v1' },
        remainingMs: 2000, preparedId: null, prepareCount: 0, authority: 'none', persistence: 'process-local' }),
        { headers: { 'Content-Type': 'application/json' } });
    });
    const c = client(transport), request = { requestId: 'capacity_0', executionId: 'capacity_exec', expectedModelDigest: host.modelDigest,
      responseSchema: astraReadDecisionSchema(candidates), maxOutputTokens: 256 };
    for (let i = 0; i < 32; i++) await c.open({ ...request, requestId: 'capacity_' + i });
    await expect(c.open({ ...request, requestId: 'capacity_33' })).rejects.toThrow('client-turn-budget');
    expect(transport).toHaveBeenCalledTimes(32);
    expect((await c.open(request)).turnId).toBe('turn_capacity_0'); expect(transport).toHaveBeenCalledTimes(33);
  });

  it.each([undefined, 'sha256:' + 'a'.repeat(64)])('recovers exact completed output with memory guard %s from a fresh client', async memoryValidityToken => {
    await control(); const before = await metrics(), first = client();
    const request = { requestId: 'recovery_' + sequence++, executionId: 'recovery_execution', expectedModelDigest: host.modelDigest,
      responseSchema: astraReadDecisionSchema(candidates), maxOutputTokens: 256, timeoutMs: 10000, notAfterMs: Date.now() + 9000,
      ...(memoryValidityToken === undefined ? {} : { memoryValidityToken }) };
    const turn = await first.open(request), prepared = await first.prepare(turn.turnId, 'owned synthetic context');
    expect((await first.inspect(turn.turnId)).memoryValidityToken).toBe(memoryValidityToken);
    if (memoryValidityToken) await expect(client().settleRequest({ ...request, memoryValidityToken: 'sha256:' + 'b'.repeat(64) }))
      .rejects.toThrow('request-conflict');
    const output = await first.generate(prepared); first.forget(turn.turnId);
    const recovered = await client().settleRequest(request);
    expect(recovered).toMatchObject({ quiescent: true, slotReserved: false, prepared, output });
    expect((await metrics()).generationCalls - before.generationCalls).toBe(1);
  });

  it('rejects missing memory guard acknowledgement and settles the exact guarded request', async () => {
    const request = { requestId: 'guard_echo_' + sequence++, executionId: 'guard_echo', expectedModelDigest: host.modelDigest,
      responseSchema: astraReadDecisionSchema(candidates), maxOutputTokens: 256, timeoutMs: 10000, notAfterMs: Date.now() + 9000,
      memoryValidityToken: 'sha256:' + 'a'.repeat(64) };
    const before = await metrics();
    const c = client(async (url, init) => {
      const response = await fetch(url, init), body = await response.json() as Record<string, unknown>;
      delete body.memoryValidityToken;
      return new Response(JSON.stringify(body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    });
    try { await expect(c.open(request)).rejects.toThrow('memory-guard-binding'); }
    finally { expect(await client().settleRequest(request)).toMatchObject({ quiescent: true, state: 'cancelled' }); }
    expect((await metrics()).generationCalls).toBe(before.generationCalls);
    await expect(client().open({ ...request, memoryValidityToken: 'invalid' })).rejects.toThrow('request');
  });

  it('fences a delayed original open instead of mistaking a missing request for absence of future work', async () => {
    const c = client(), before = await metrics();
    const request = { requestId: 'unseen_' + sequence++, executionId: 'recovery_execution', expectedModelDigest: host.modelDigest,
      responseSchema: astraReadDecisionSchema(candidates), maxOutputTokens: 256, timeoutMs: 10000, notAfterMs: Date.now() + 9000 };
    expect(await c.settleRequest(request)).toMatchObject({ quiescent: true, slotReserved: false, state: 'cancelled', output: null });
    await expect(c.open(request)).rejects.toThrow('turn-unavailable');
    expect((await metrics()).generationCalls).toBe(before.generationCalls);
  });

  it('joins a real Python model-turn route to exactly one Kernel read without granting model authority', async () => {
    await control(); const before = await metrics(), journal = new AstraJournal(':memory:');
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    const workspace = new WorkspaceModule({ workspaceRoot: root }); kernel.registerModule(workspace); await kernel.start();
    const moduleCalls = vi.spyOn(workspace, 'executeCapability'), dispatch = vi.spyOn(kernel, 'executeActionProposal');
    try {
      const result = await decideAstraReadWithModel(options(journal));
      expect(result.status).toBe('accepted');
      expect(moduleCalls).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
      if (result.status !== 'accepted' || result.proposal.kind !== 'read') throw new Error(JSON.stringify(result));
      expect(result.authority).toBe('none'); expect(result.model.slotState).toBe('released');
      expect(result.proposal.request).toEqual(candidates[0]!.request);
      const runtime = new AstraReadRuntime({ deployment: 'isolated-validation', canonicalRoot: root, kernel, journal });
      const observed = await runtime.run(result.proposal.request);
      expect(observed.nativeCompletionCertified).toBe(false);
      expect(observed.checkpoint).toMatchObject({ phase: 'observed', observation: { sizeBytes: 4103, content: 'x'.repeat(4103) } });
      expect(moduleCalls).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(1);
      expect(await runtime.run(result.proposal.request)).toEqual(observed);
      expect(dispatch).toHaveBeenCalledTimes(1);
      const after = await metrics(); expect(after.generationCalls - before.generationCalls).toBe(1);
      expect(after.lastSubmittedTokenCount).toBe(result.context.tokenCount);
      expect(after.slotReserved).toBe(false);
    } finally { moduleCalls.mockRestore(); dispatch.mockRestore(); await kernel.stop(); journal.close(); }
  });

  it('counts actual chat framing and automatically compacts old optional history, not mandatory facts', async () => {
    await control(); const journal = new AstraJournal(':memory:'), input = source();
    input.optional = Array.from({ length: 12 }, (_, index) => ({ kind: 'narrative', ref: 'history_' + index, text: 'untrusted optional '.repeat(50) }));
    input.mandatory.push({ kind: 'receipt', ref: 'preserved_receipt', text: 'Pinned receipt value: 4103, not zero.' });
    try {
      const opt = options(journal, input), result = await decideAstraReadWithModel({ ...opt, limits: {
        hardTokens: 6500, softTokens: 5200, rearmTokens: 3600, reservedOutputTokens: 256,
        recentNarrativeItems: 2, minimumSavedTokens: 64, tokenizerTimeoutMs: 3000,
      } });
      expect(result.status).toBe('accepted'); if (result.status !== 'accepted') throw new Error(JSON.stringify(result));
      expect(result.context.omittedRefs).toHaveLength(10);
      const plan = (journal.read('context_' + input.executionId)!.checkpoint as unknown as { active: AstraContextPlan }).active;
      const surface = JSON.parse(plan.surface) as { mandatory: Array<{ ref: string; text: string }>; data: Array<{ ref?: string }> };
      expect(surface.mandatory).toEqual(expect.arrayContaining(input.mandatory));
      expect(surface.data.map(item => item.ref)).toEqual(expect.arrayContaining(['history_10', 'history_11']));
      expect(result.context.tokenCount).toBeGreaterThan(Buffer.byteLength(plan.surface));
      expect((await metrics()).lastSubmittedTokenCount).toBe(result.context.tokenCount);
    } finally { journal.close(); }
  });

  it('refuses a mandatory minimum that cannot fit, without invoking generation', async () => {
    await control(); const journal = new AstraJournal(':memory:'), input = source(), before = await metrics();
    input.mandatory[0]!.text = 'mandatory '.repeat(2000);
    try {
      const result = await decideAstraReadWithModel({ ...options(journal, input), limits: {
        hardTokens: 6500, softTokens: 5200, rearmTokens: 3600, reservedOutputTokens: 256, tokenizerTimeoutMs: 3000,
      } });
      expect(result).toMatchObject({ status: 'blocked', code: 'context-capacity-insufficient', model: { slotState: 'released' } });
      expect((await metrics()).generationCalls).toBe(before.generationCalls);
      expect((await metrics()).slotReserved).toBe(false);
    } finally { journal.close(); }
  });

  it.each([
    ['malformed JSON', '{', 'decision-json-invalid'],
    ['wrong target', JSON.stringify({ ...readDecision, targetHandle: 'different_file' }), 'goal-target-binding'],
    ['model authority field', JSON.stringify({ ...readDecision, authority: 'execute' }), 'branch-fields'],
    ['model path substitution', JSON.stringify({ ...readDecision, path: 'other.txt' }), 'branch-fields'],
    ['duplicate property', '{"kind":"request-completion","kind":"read"}', 'duplicate-key'],
  ])('rejects %s after one model call, without repair loops or execution', async (_label, raw, code) => {
    await control(raw); const journal = new AstraJournal(':memory:'), before = await metrics();
    try {
      expect(await decideAstraReadWithModel(options(journal))).toMatchObject({ status: 'blocked', code, model: { slotState: 'released' } });
      expect((await metrics()).generationCalls - before.generationCalls).toBe(1);
    } finally { journal.close(); }
  });

  it('keeps completion as a non-authoritative request and makes output truncation visible', async () => {
    await control('{"kind":"request-completion"}'); const journal = new AstraJournal(':memory:');
    try {
      expect(await decideAstraReadWithModel(options(journal))).toMatchObject({ status: 'accepted', authority: 'none', proposal: { kind: 'request-completion' } });
      await control('{"kind":"request-completion"}', { finish: 'length' });
      expect(await decideAstraReadWithModel(options(journal))).toMatchObject({ status: 'blocked', code: 'model-output-limit' });
    } finally { journal.close(); }
  });

  it('rejects a late response after its host-owned source is revoked', async () => {
    // The shared host fences each ended turn until its own deadline (32 at most);
    // earlier cases in this file may still hold that window.
    const capacityDeadline = Date.now() + 90_000;
    while ((await metrics() as { retainedTurns?: number }).retainedTurns! >= 30 && Date.now() < capacityDeadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await control(); const journal = new AstraJournal(':memory:'); let current = true;
    const transport: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/generate')) current = false;
      return response;
    };
    try {
      const result = await decideAstraReadWithModel({ ...options(journal, source(), transport), isCurrent: () => current });
      expect(result).toMatchObject({ status: 'blocked', code: 'stale-source', model: { slotState: 'released' } });
    } finally { journal.close(); }
  }, 120_000);

  it('refuses stale source before even opening a model turn', async () => {
    const journal = new AstraJournal(':memory:'), before = await metrics();
    try {
      expect(await decideAstraReadWithModel({ ...options(journal), isCurrent: () => false }))
        .toMatchObject({ status: 'blocked', code: 'stale-source', model: { slotState: 'not-opened' } });
      // No model work happened. `retainedTurns` is excluded: earlier turns age out on the shared host's clock.
      const { retainedTurns: _after, ...after } = await metrics() as Record<string, unknown>;
      const { retainedTurns: _before, ...expected } = before as Record<string, unknown>;
      expect(after).toEqual(expected);
    } finally { journal.close(); }
  });

  it('cancels over real HTTP while retaining the native slot until an explicit worker acknowledgement', async () => {
    await release();
    await waitFor(async () => !(await metrics()).slotReserved);
    // The shared fixture has a deliberate 32-turn cap. Let terminal receipts
    // age into its normal one-second pruning window before opening this case.
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await control(JSON.stringify(readDecision), { block: true });
    const journal = new AstraJournal(':memory:'), signal = new AbortController();
    try {
      const run = decideAstraReadWithModel({ ...options(journal), signal: signal.signal });
      await waitFor(async () => (await metrics()).workerStarted);
      signal.abort('synthetic-cancel');
      const result = await run;
      expect(result.status).toBe('blocked'); expect(result.model.slotState).toBe('pending-stop');
      expect((await metrics()).slotReserved).toBe(true);
      await release(); await waitFor(async () => !(await metrics()).slotReserved);
    } finally { await release(); await waitFor(async () => !(await metrics()).slotReserved); journal.close(); }
  }, 10_000);

  it('rejects transport-corrupted token counts without turning a driver echo into evidence', async () => {
    await control(); const journal = new AstraJournal(':memory:');
    const transport: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!String(url).endsWith('/generate')) return response;
      const value = await response.json() as Record<string, unknown>;
      return Response.json({ ...value, inputTokens: 0 });
    };
    try {
      expect(await decideAstraReadWithModel(options(journal, source(), transport)))
        .toMatchObject({ status: 'blocked', code: 'generation-input-binding', model: { slotState: 'released' } });
    } finally { journal.close(); }
  });

  it('bounds model endpoints, response bodies and forgetting an unsettled owned turn', async () => {
    for (const endpoint of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://127.0.0.1:1234/other', 'http://example.com:1234']) {
      expect(() => new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint, bearerToken: 'synthetic', hostGeneration: host.hostGeneration })).toThrow('owned-loopback-required');
    }
    // This suite deliberately shares one host with a 32-turn hard cap and a
    // one-second receipt-retention window. Let completed prior scenarios age
    // into the host's normal pruning window before exercising a fresh open.
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await control(); const c = client();
    const turn = await c.open({ requestId: 'forget_test', executionId: 'forget_test', expectedModelDigest: host.modelDigest,
      maxOutputTokens: 256, responseSchema: { type: 'object' } });
    expect(() => c.forget(turn.turnId)).toThrow('turn-not-settled');
    await c.cancel(turn.turnId); c.forget(turn.turnId);
    const wrong = client(async () => Response.json({ invalid: 'x'.repeat(3_200_000) }));
    await expect(wrong.open({ requestId: 'oversized', executionId: 'oversized', expectedModelDigest: host.modelDigest,
      maxOutputTokens: 256, responseSchema: { type: 'object' } })).rejects.toThrow('response-byte-budget');
  });
});
