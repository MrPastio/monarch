import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core/kernel';
import { WorkspaceModule } from '../../src/modules/workspace';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraReadRuntime } from '../../src/agent-v3/read-runtime';
import { AstraReadWorkflow } from '../../src/agent-v3/read-workflow';
import { AstraContextEngine } from '../../src/agent-v3/context-engine';
import { astraJournalJson } from '../../src/agent-v3/journal';
import { AstraReadDecisionGateway, astraReadCatalogSurface, astraReadDecisionSchema } from '../../src/agent-v3/read-decision-gateway';

let parent: string, fixture: string, root: string;
const content = 'ASTRA_V3_REAL_KERNEL\n';
const marker = 'astra-v3-read-real-kernel-synthetic-only';
beforeAll(async () => {
  parent = await realpath('.test-tmp');
  expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  fixture = await realpath(await mkdtemp(path.join(parent, 'astra-v3-read-')));
  expect(path.dirname(fixture)).toBe(parent);
  await writeFile(path.join(fixture, '.fixture-marker'), marker, { flag: 'wx' });
  root = path.join(fixture, 'workspace'); await mkdir(root);
  await writeFile(path.join(root, 'ordinary.txt'), content, { flag: 'wx' });
  await writeFile(path.join(root, 'unicode.txt'), 'Привет 🌟\n', { flag: 'wx' });
  await writeFile(path.join(root, 'empty.txt'), '', { flag: 'wx' });
  await mkdir(path.join(root, 'folder'));
});

describe('Astra V3 persisted read TaskGraph → actual Kernel', () => {
  it('pauses a ready graph, stays paused across reconstruction and resumes only explicitly', async () => {
    const s = await setup();
    try {
      const workflow = new AstraReadWorkflow(s.journal, s.runtime);
      const request = { requestId: 'pause-ready-graph', steps: [{ id: 'a', relativePath: 'ordinary.txt' }] };
      const accepted = workflow.admit(request), paused = workflow.pause(accepted.checkpoint.runId);
      expect(paused.checkpoint).toMatchObject({ phase: 'paused', controlEpoch: 1 });
      const restored = new AstraReadWorkflow(s.journal, s.runtime);
      expect(await restored.run(request)).toEqual(paused);
      expect(s.dispatch).not.toHaveBeenCalled();
      expect(restored.resume(accepted.checkpoint.runId).checkpoint).toMatchObject({ phase: 'ready', controlEpoch: 2 });
      expect((await restored.run(request)).checkpoint.phase).toBe('observed');
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('parks a child during asynchronous preflight so a paused graph performs no later Kernel dispatch', async () => {
    const s = await setup();
    try {
      const workflow = new AstraReadWorkflow(s.journal, s.runtime);
      const request = { requestId: 'pause-preflight', steps: [{ id: 'a', relativePath: 'ordinary.txt' }] };
      const accepted = workflow.admit(request), running = workflow.run(request);
      expect(workflow.pause(accepted.checkpoint.runId).checkpoint.phase).toBe('paused');
      expect((await running).checkpoint.phase).toBe('paused'); expect(s.dispatch).not.toHaveBeenCalled();
      workflow.resume(accepted.checkpoint.runId);
      expect((await workflow.run(request)).checkpoint.phase).toBe('observed'); expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('lets an already reserved read settle, then pauses before the next graph step', async () => {
    const s = await setup();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.dispatch.mockImplementationOnce(async (...args) => { entered(); await gate; return WorkspaceModule.prototype.executeCapability.call(s.workspace, ...args); });
    try {
      const workflow = new AstraReadWorkflow(s.journal, s.runtime);
      const request = { requestId: 'pause-live-graph', steps: [
        { id: 'a', relativePath: 'ordinary.txt' }, { id: 'b', relativePath: 'unicode.txt', dependsOn: ['a'] },
      ] };
      const accepted = workflow.admit(request), running = workflow.run(request);
      await started;
      expect(workflow.pause(accepted.checkpoint.runId).checkpoint.phase).toBe('pausing');
      expect(() => workflow.resume(accepted.checkpoint.runId)).toThrow('not-paused-or-not-quiescent');
      release(); const paused = await running;
      expect(paused.checkpoint.phase).toBe('paused');
      expect(paused.checkpoint.steps.map(step => step.state)).toEqual(['observed', 'waiting']);
      expect(s.dispatch).toHaveBeenCalledTimes(1);
      workflow.resume(accepted.checkpoint.runId);
      expect((await workflow.run(request)).checkpoint.phase).toBe('observed'); expect(s.dispatch).toHaveBeenCalledTimes(2);
    } finally { release(); await s.close(); }
  });

  it('cancels a parked child without executing it, and refuses to resume a cancelled graph', async () => {
    const s = await setup();
    try {
      const workflow = new AstraReadWorkflow(s.journal, s.runtime);
      const request = { requestId: 'cancel-parked', steps: [{ id: 'a', relativePath: 'ordinary.txt' }] };
      const accepted = workflow.admit(request), running = workflow.run(request);
      workflow.pause(accepted.checkpoint.runId); await running;
      expect(workflow.cancel(accepted.checkpoint.runId).checkpoint.phase).toBe('cancelled');
      expect(() => workflow.resume(accepted.checkpoint.runId)).toThrow('not-paused-or-not-quiescent');
      expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('does not replay a completed workflow under a different root grant', async () => {
    const s = await setup();
    try {
      const request = { requestId: 'scoped-graph', steps: [{ id: 'first', relativePath: 'ordinary.txt' }] };
      const workflow = new AstraReadWorkflow(s.journal, s.runtime);
      expect((await workflow.run(request)).checkpoint.phase).toBe('observed');
      const otherRoot = new AstraReadRuntime({ deployment: 'isolated-validation', canonicalRoot: fixture, kernel: s.kernel, journal: s.journal });
      await expect(new AstraReadWorkflow(s.journal, otherRoot).run(request)).rejects.toThrow('checkpoint');
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('orders dependencies, keeps exact child evidence refs and never copies raw outputs into the graph', async () => {
    const s = await setup();
    try {
      const workflow = new AstraReadWorkflow(s.journal, s.runtime);
      const request = { requestId: 'graph', steps: [
        { id: 'dependent', relativePath: 'unicode.txt', dependsOn: ['first'] },
        { id: 'first', relativePath: 'ordinary.txt' },
        { id: 'independent', relativePath: 'empty.txt' },
      ] };
      const [one, two] = await Promise.all([workflow.run(request), workflow.run(request)]);
      expect(two).toEqual(one);
      expect(one.checkpoint.phase).toBe('observed'); expect(one.nativeCompletionCertified).toBe(false);
      expect(s.dispatch.mock.calls.map(call => path.basename(String((call[0].input as { path: string }).path)))).toEqual(['ordinary.txt', 'unicode.txt', 'empty.txt']);
      expect(one.checkpoint.steps.every(step => step.state === 'observed' && step.readRevision && step.contentDigest)).toBe(true);
      expect(JSON.stringify(one.checkpoint)).not.toContain(content.trim());
      expect(await workflow.run(request)).toEqual(one);
      expect(s.dispatch).toHaveBeenCalledTimes(3);
      await expect(workflow.run({ ...request, steps: [{ id: 'changed', relativePath: 'ordinary.txt' }] })).rejects.toThrow('request-conflict');
    } finally { await s.close(); }
  });

  it('blocks transitive dependents after a real failure while still executing an independent requirement', async () => {
    const s = await setup();
    try {
      const result = await new AstraReadWorkflow(s.journal, s.runtime).run({ requestId: 'partial-graph', steps: [
        { id: 'fail', relativePath: 'folder' },
        { id: 'blocked', relativePath: 'ordinary.txt', dependsOn: ['fail'] },
        { id: 'also-blocked', relativePath: 'ordinary.txt', dependsOn: ['blocked'] },
        { id: 'independent', relativePath: 'unicode.txt' },
      ] });
      expect(result.checkpoint.phase).toBe('partial');
      expect(result.checkpoint.steps.map(step => step.state)).toEqual(['failed', 'blocked', 'blocked', 'observed']);
      expect(s.dispatch).toHaveBeenCalledTimes(2);
    } finally { await s.close(); }
  });

  it.each([
    [{ id: 'a', relativePath: 'ordinary.txt', dependsOn: ['a'] }],
    [{ id: 'a', relativePath: 'ordinary.txt', dependsOn: ['missing'] }],
    [{ id: 'a', relativePath: 'ordinary.txt' }, { id: 'a', relativePath: 'unicode.txt' }],
    [{ id: 'a', relativePath: '../outside' }],
  ])('rejects an invalid graph before admitting children or performing I/O (%#)', async (...steps) => {
    const s = await setup();
    try {
      await expect(new AstraReadWorkflow(s.journal, s.runtime).run({ requestId: 'bad-graph', steps })).rejects.toThrow();
      expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('recovers a lost parent checkpoint after a successful child without executing that child twice', async () => {
    const file = path.join(fixture, 'graph-recovery.sqlite'), s = await setup(file), fault = new DatabaseSync(file);
    try {
      fault.exec(`CREATE TRIGGER reject_parent_result BEFORE INSERT ON astra_commits
        WHEN instr(CAST(NEW.events AS TEXT),'workflow.step-returned')>0
        BEGIN SELECT RAISE(ABORT,'synthetic-parent-write-failure'); END;`);
      const request = { requestId: 'recover-graph', steps: [
        { id: 'first', relativePath: 'ordinary.txt' }, { id: 'next', relativePath: 'unicode.txt', dependsOn: ['first'] },
      ] };
      const workflow = new AstraReadWorkflow(s.journal, s.runtime);
      await expect(workflow.run(request)).rejects.toThrow('synthetic-parent-write-failure');
      expect(s.dispatch).toHaveBeenCalledTimes(1);
      fault.exec('DROP TRIGGER reject_parent_result');
      const resumed = new AstraReadWorkflow(s.journal, s.runtime);
      const result = await resumed.run(request);
      expect(result.checkpoint.phase).toBe('observed');
      expect(s.dispatch).toHaveBeenCalledTimes(2);
    } finally { fault.close(); await s.close(); }
  });

  it('cancels a ready graph without creating read tasks or dispatching', async () => {
    const s = await setup();
    try {
      const workflow = new AstraReadWorkflow(s.journal, s.runtime);
      const request = { requestId: 'cancel-graph', steps: [{ id: 'a', relativePath: 'ordinary.txt' }] };
      const accepted = workflow.admit(request);
      expect(workflow.cancel(accepted.checkpoint.runId).checkpoint.phase).toBe('cancelled');
      expect((await workflow.run(request)).checkpoint.phase).toBe('cancelled');
      expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('persists parent cancellation, cancels its in-flight child and never starts the next one', async () => {
    const s = await setup();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.dispatch.mockImplementation(async (...args) => {
      entered(); await gate; return WorkspaceModule.prototype.executeCapability.call(s.workspace, ...args);
    });
    try {
      const workflow = new AstraReadWorkflow(s.journal, s.runtime);
      const request = { requestId: 'cancel-live-graph', steps: [
        { id: 'a', relativePath: 'ordinary.txt' }, { id: 'b', relativePath: 'unicode.txt' },
      ] };
      const accepted = workflow.admit(request), running = workflow.run(request);
      await started;
      expect(workflow.cancel(accepted.checkpoint.runId).checkpoint.phase).toBe('cancelling');
      release(); const result = await running;
      expect(result.checkpoint.phase).toBe('cancelled');
      expect(result.checkpoint.steps.map(step => step.state)).toEqual(['cancelled', 'cancelled']);
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { release(); await s.close(); }
  });
});
afterAll(async () => {
  if (!fixture) return;
  expect(await realpath(fixture)).toBe(fixture);
  expect(path.dirname(fixture)).toBe(parent);
  expect(path.basename(fixture).startsWith('astra-v3-read-')).toBe(true);
  expect(await readFile(path.join(fixture, '.fixture-marker'), 'utf8')).toBe(marker);
  await rm(fixture, { recursive: true, force: false });
});
async function setup(file = ':memory:') {
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
  const workspace = new WorkspaceModule({ workspaceRoot: root });
  const dispatch = vi.spyOn(workspace, 'executeCapability'); // Call through to the REAL Workspace read.
  kernel.registerModule(workspace); await kernel.start();
  const journal = new AstraJournal(file);
  const runtime = new AstraReadRuntime({ deployment: 'isolated-validation', canonicalRoot: root, kernel, journal });
  return { kernel, workspace, journal, runtime, dispatch,
    close: async () => { await kernel.stop(); journal.close(); dispatch.mockRestore(); } };
}

describe('Astra V3 isolated runtime → real Kernel → real synthetic file', () => {
  it('does not let a delayed preflight failure overwrite a parked checkpoint', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const preflight = vi.spyOn(s.runtime as any, 'target').mockImplementation(async () => { await gate; throw new Error('synthetic-preflight-failure'); });
    try {
      const request = { requestId: 'parked-preflight-failure', relativePath: 'ordinary.txt' };
      const accepted = s.runtime.admit(request), running = s.runtime.run(request);
      const parked = s.runtime.parkReady(accepted.checkpoint.runId);
      release(); expect(await running).toEqual(parked); expect(s.dispatch).not.toHaveBeenCalled();
      preflight.mockRestore(); s.runtime.resumeReady(accepted.checkpoint.runId);
      expect((await s.runtime.run(request)).checkpoint.phase).toBe('observed');
    } finally { release(); preflight.mockRestore(); await s.close(); }
  });

  it('does not replace an already reconciled real observation with a late transport error', async () => {
    const s = await setup();
    let entered!: () => void, release!: () => void;
    const recorded = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const actual = s.kernel.executeActionProposal.bind(s.kernel);
    const transport = vi.spyOn(s.kernel, 'executeActionProposal').mockImplementation(async (...args) => {
      await actual(...args); entered(); await gate; throw new Error('synthetic-return-transport-failure');
    });
    try {
      const request = { requestId: 'reconciled-transport-failure', relativePath: 'ordinary.txt' };
      const accepted = s.runtime.admit(request), running = s.runtime.run(request);
      await recorded;
      const recovered = s.runtime.reconcile(accepted.checkpoint.runId);
      expect(recovered.checkpoint.phase).toBe('observed');
      release(); expect(await running).toEqual(recovered);
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { release(); transport.mockRestore(); await s.close(); }
  });
  it('connects counted Context → pinned Catalog → synthetic model-shaped decision → real Kernel read and replay', async () => {
    const s = await setup();
    try {
      const candidates = [{ handle: 'read_tool', requirementId: 'read_text', targetHandle: 'synthetic_file',
        request: { requestId: 'context-decision-read', relativePath: 'ordinary.txt', maxBytes: 1024 } }];
      const context = new AstraContextEngine({ deployment: 'isolated-validation', journal: s.journal, executionId: 'integration',
        tokenizer: { driverGeneration: 'fixture', modelDigest: 'no-model', tokenizerDigest: 'test-byte-vocabulary' },
        countTokens: async surface => Buffer.byteLength(surface), isCurrent: () => true });
      const compiled = await context.prepare({ executionId: 'integration', revision: 1, mandatory: [
        { ref: 'goal', kind: 'goal', text: 'Read the exact marked synthetic file.' },
        { ref: 'authority', kind: 'authority', text: 'Only host-pinned workspace read; no other tools.' },
        { ref: 'workflow', kind: 'workflow', text: 'read_text pending' },
        { ref: 'budget', kind: 'budget', text: 'One read; maximum 1024 bytes.' },
        { ref: 'astra_read_catalog', kind: 'capability', text: astraReadCatalogSurface(candidates) },
        { ref: 'astra_read_decision_schema', kind: 'capability', text: astraJournalJson(astraReadDecisionSchema(candidates)) },
      ], optional: [] });
      expect(compiled.status).toBe('ready'); if (compiled.status !== 'ready') throw new Error(compiled.code);
      const gateway = new AstraReadDecisionGateway({ isCurrent: binding => binding.contextDigest === context.active()?.surfaceDigest });
      const offer = gateway.offer({ executionId: 'integration', controlEpoch: 0, catalogRevision: 1, context: compiled.plan, candidates });
      const proposal = gateway.accept(offer.offerId, JSON.stringify({ kind: 'read', requirementId: 'read_text', capabilityHandle: 'read_tool', targetHandle: 'synthetic_file' }));
      expect(s.dispatch).not.toHaveBeenCalled(); // Gateway cannot execute anything.
      if (proposal.status !== 'accepted' || proposal.proposal.kind !== 'read') throw new Error('unexpected proposal');
      const observed = await s.runtime.run(proposal.proposal.request);
      expect(observed.checkpoint).toMatchObject({ phase: 'observed', observation: { content, sizeBytes: Buffer.byteLength(content) } });
      expect(observed.nativeCompletionCertified).toBe(false);
      expect(await s.runtime.run(proposal.proposal.request)).toEqual(observed);
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('fences duplicate dispatch attempts by separate runtime instances sharing the journal', async () => {
    const s = await setup();
    const kernelCalls = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const second = new AstraReadRuntime({ deployment: 'isolated-validation', canonicalRoot: root, kernel: s.kernel, journal: s.journal });
      const request = { requestId: 'two-owners', relativePath: 'ordinary.txt' };
      const results = await Promise.all([s.runtime.run(request), second.run(request)]);
      expect(s.dispatch).toHaveBeenCalledTimes(1);
      expect(kernelCalls).toHaveBeenCalledTimes(1);
      expect(results.some(result => result.checkpoint.phase === 'observed')).toBe(true);
      expect(s.runtime.read(results[0]!.checkpoint.runId)!.checkpoint.phase).toBe('observed');
    } finally { kernelCalls.mockRestore(); await s.close(); }
  });
  it.each([['ordinary.txt', content], ['unicode.txt', 'Привет 🌟\n'], ['empty.txt', '']])(
    'records exact %s bytes with no model or V2 AgentLoop', async (relativePath, expected) => {
      const s = await setup();
      try {
        const result = await s.runtime.run({ requestId: 'read-test', relativePath: relativePath! });
        expect(result).toMatchObject({ nativeCompletionCertified: false, checkpoint: { phase: 'observed',
          observation: { content: expected, sizeBytes: Buffer.byteLength(expected!) } } });
        expect(s.dispatch).toHaveBeenCalledTimes(1);
        expect(s.dispatch.mock.calls[0]?.[0].capabilityId).toBe('workspace.files.read');
        expect(s.journal.history(result.checkpoint.runId).map(row => (row.events[0] as any).type))
          .toEqual(['goal.accepted', 'invocation.reserved', 'invocation.observed']);
      } finally { await s.close(); }
    },
  );

  it('joins concurrent duplicates and returns persisted observation after runtime reconstruction without reading again', async () => {
    const s = await setup(path.join(fixture, 'replay.sqlite'));
    try {
      const request = { requestId: 'duplicate', relativePath: 'ordinary.txt' };
      const [one, two] = await Promise.all([s.runtime.run(request), s.runtime.run(request)]);
      expect(two).toEqual(one); expect(s.dispatch).toHaveBeenCalledTimes(1);
      s.journal.close();
      const reopened = new AstraJournal(path.join(fixture, 'replay.sqlite'));
      try {
        const resumed = new AstraReadRuntime({ deployment: 'isolated-validation', canonicalRoot: root, kernel: s.kernel, journal: reopened });
        expect(await resumed.run(request)).toEqual(one);
        expect(s.dispatch).toHaveBeenCalledTimes(1);
        await expect(resumed.run({ ...request, relativePath: 'empty.txt' })).rejects.toThrow('request-conflict');
      } finally { reopened.close(); }
    } finally { await s.close(); }
  });

  it.each(['../outside', 'C:\\outside', 'ordinary.txt:stream', './ordinary.txt', 'CON', 'ordinary.txt.'])(
    'rejects out-of-contract target %s before a Kernel call', async relativePath => {
      const s = await setup();
      try {
        await expect(s.runtime.run({ requestId: 'bad-path', relativePath })).rejects.toThrow('relative-target');
        expect(s.dispatch).not.toHaveBeenCalled();
      } finally { await s.close(); }
    },
  );

  it('rejects a fixture junction before dispatch (not a hostile concurrent-reparse proof)', async () => {
    const target = path.join(fixture, 'outside'); await mkdir(target);
    await writeFile(path.join(target, 'outside.txt'), 'synthetic outside', { flag: 'wx' });
    await symlink(target, path.join(root, 'alias'), 'junction');
    const s = await setup();
    try {
      const result = await s.runtime.run({ requestId: 'alias', relativePath: 'alias/outside.txt' });
      expect(result.checkpoint).toMatchObject({ phase: 'failed', reason: 'target-alias' });
      expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each([['folder', 64, 'not-a-file'], ['ordinary.txt', 1, 'file-too-large']])(
    'preserves real Kernel failure for %s', async (relativePath, maxBytes, reason) => {
      const s = await setup();
      try {
        const result = await s.runtime.run({ requestId: 'kernel-failure', relativePath: String(relativePath), maxBytes: Number(maxBytes) });
        expect(result.checkpoint).toMatchObject({ phase: 'failed', reason });
        expect(result.checkpoint.observation).toBeUndefined();
        expect(s.dispatch).toHaveBeenCalledTimes(1);
      } finally { await s.close(); }
    },
  );

  it('rejects a corrupted returned size rather than certifying it', async () => {
    const s = await setup();
    const actual = WorkspaceModule.prototype.executeCapability.bind(s.workspace);
    s.dispatch.mockImplementation(async (...args) => {
      const returned = await actual(...args);
      return { ...returned, output: { ...(returned.output as object), sizeBytes: 0 } };
    });
    try {
      const result = await s.runtime.run({ requestId: 'corrupt-size', relativePath: 'ordinary.txt' });
      expect(result.checkpoint).toMatchObject({ phase: 'failed', reason: 'output-binding' });
      expect(result.checkpoint.observation).toBeUndefined();
    } finally { await s.close(); }
  });

  it('cancels a persisted ready task before any Kernel dispatch and replays cancellation', async () => {
    const s = await setup();
    try {
      const request = { requestId: 'cancel-before', relativePath: 'ordinary.txt' };
      const accepted = s.runtime.admit(request);
      const cancelled = s.runtime.cancel(accepted.checkpoint.runId, 'cancel-command');
      expect(cancelled.checkpoint.phase).toBe('cancelled');
      expect(s.runtime.cancel(accepted.checkpoint.runId, 'cancel-command')).toEqual(cancelled);
      expect(await s.runtime.run(request)).toEqual(cancelled);
      expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('honours a durable cancel while a real Kernel invocation is in flight', async () => {
    const s = await setup();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.dispatch.mockImplementation(async (...args) => {
      entered(); await gate;
      return WorkspaceModule.prototype.executeCapability.call(s.workspace, ...args);
    });
    try {
      const request = { requestId: 'cancel-during', relativePath: 'ordinary.txt' };
      const accepted = s.runtime.admit(request), flight = s.runtime.run(request);
      await started;
      expect(s.runtime.cancel(accepted.checkpoint.runId, 'cancel-command').checkpoint.phase).toBe('cancelling');
      release();
      const result = await flight;
      expect(result.checkpoint.phase).toBe('cancelled');
      expect(result.checkpoint.observation).toBeUndefined();
      expect((await s.runtime.run(request)).checkpoint.phase).toBe('cancelled');
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { release(); await s.close(); }
  });

  it('does not repeat a read when the result could not be committed after Kernel returned', async () => {
    const file = path.join(fixture, 'lost-receipt.sqlite'), s = await setup(file), fault = new DatabaseSync(file);
    try {
      fault.exec(`CREATE TRIGGER reject_observation BEFORE INSERT ON astra_commits
        WHEN instr(CAST(NEW.events AS TEXT),'invocation.observed')>0
        BEGIN SELECT RAISE(ABORT,'synthetic-receipt-write-failure'); END;`);
      const request = { requestId: 'lost-receipt', relativePath: 'ordinary.txt' };
      const result = await s.runtime.run(request);
      expect(result.checkpoint.phase).toBe('indeterminate');
      expect(result.checkpoint.observation).toBeUndefined();
      fault.exec('DROP TRIGGER reject_observation');
      const reconstructed = new AstraReadRuntime({ deployment: 'isolated-validation', canonicalRoot: root, kernel: s.kernel, journal: s.journal });
      expect(await reconstructed.run(request)).toEqual(result);
      expect(s.dispatch).toHaveBeenCalledTimes(1);
      const recovered = reconstructed.reconcile(result.checkpoint.runId);
      expect(recovered.checkpoint).toMatchObject({ phase: 'observed', observation: { content } });
      expect(recovered.checkpoint.reason).toBeUndefined();
      expect(reconstructed.reconcile(result.checkpoint.runId)).toEqual(recovered);
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { fault.close(); await s.close(); }
  });

  it('keeps a timed-out invocation indeterminate when a late Kernel reply arrives', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const kernelCall = vi.spyOn(s.kernel, 'executeActionProposal');
    s.dispatch.mockImplementation(async (...args) => {
      await gate;
      return WorkspaceModule.prototype.executeCapability.call(s.workspace, ...args);
    });
    try {
      const request = { requestId: 'deadline', relativePath: 'ordinary.txt', timeoutMs: 50 };
      const result = await s.runtime.run(request);
      expect(result.checkpoint).toMatchObject({ phase: 'indeterminate', reason: 'deadline-indeterminate' });
      release(); await kernelCall.mock.results[0]!.value;
      expect(await s.runtime.run(request)).toEqual(result);
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { release(); kernelCall.mockRestore(); await s.close(); }
  });

  it('keeps missing receipts unresolved and rejects a mismatched receipt without any redispatch', async () => {
    const s = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const kernelCall = vi.spyOn(s.kernel, 'executeActionProposal');
    s.dispatch.mockImplementation(async (...args) => { await gate; return WorkspaceModule.prototype.executeCapability.call(s.workspace, ...args); });
    try {
      const result = await s.runtime.run({ requestId: 'missing-receipt', relativePath: 'ordinary.txt', timeoutMs: 50 });
      const original = s.kernel.getActionLedgerRecord.bind(s.kernel);
      const lookup = vi.spyOn(s.kernel, 'getActionLedgerRecord');
      lookup.mockReturnValueOnce(null);
      expect(s.runtime.reconcile(result.checkpoint.runId)).toEqual(result);
      lookup.mockImplementationOnce(key => ({ ...original(key)!, intentId: 'different-run' }));
      expect(() => s.runtime.reconcile(result.checkpoint.runId)).toThrow('receipt-binding');
      expect(s.runtime.read(result.checkpoint.runId)).toEqual(result);
      lookup.mockRestore();
      // A still-running exact receipt cannot certify anything either.
      expect(s.runtime.reconcile(result.checkpoint.runId)).toEqual(result);
      release(); await kernelCall.mock.results[0]!.value;
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { release(); kernelCall.mockRestore(); await s.close(); }
  });

  it('does not resurrect a cancelled run from a successful retained Kernel receipt', async () => {
    const file = path.join(fixture, 'cancel-receipt.sqlite'), s = await setup(file), fault = new DatabaseSync(file);
    try {
      fault.exec(`CREATE TRIGGER reject_observation BEFORE INSERT ON astra_commits
        WHEN instr(CAST(NEW.events AS TEXT),'invocation.observed')>0
        BEGIN SELECT RAISE(ABORT,'synthetic-receipt-write-failure'); END;`);
      const result = await s.runtime.run({ requestId: 'cancel-recovery', relativePath: 'ordinary.txt' });
      expect(result.checkpoint.phase).toBe('indeterminate');
      const key = result.checkpoint.invocation!.idempotencyKey;
      const copy = s.kernel.getActionLedgerRecord(key)!;
      (copy.result!.output as { content: string }).content = 'changed external copy';
      expect((s.kernel.getActionLedgerRecord(key)!.result!.output as { content: string }).content).toBe(content);
      s.runtime.cancel(result.checkpoint.runId, 'stop');
      const reconciled = s.runtime.reconcile(result.checkpoint.runId);
      expect(reconciled.checkpoint.phase).toBe('cancelled');
      expect(reconciled.checkpoint.observation).toBeUndefined();
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { fault.close(); await s.close(); }
  });

  it('keeps durable cancellation authoritative when timeout happens before the late Kernel reply', async () => {
    const s = await setup();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const kernelCall = vi.spyOn(s.kernel, 'executeActionProposal');
    s.dispatch.mockImplementation(async (...args) => { entered(); await gate; return WorkspaceModule.prototype.executeCapability.call(s.workspace, ...args); });
    try {
      const request = { requestId: 'cancel-then-timeout', relativePath: 'ordinary.txt', timeoutMs: 50 };
      const accepted = s.runtime.admit(request), running = s.runtime.run(request);
      await started; s.runtime.cancel(accepted.checkpoint.runId, 'cancel');
      const timedOut = await running;
      expect(timedOut.checkpoint.phase).toBe('cancelling');
      expect(timedOut.checkpoint.controlEpoch).toBe(1);
      release(); await kernelCall.mock.results[0]!.value;
      const reconciled = s.runtime.reconcile(accepted.checkpoint.runId);
      expect(reconciled.checkpoint.phase).toBe('cancelled');
      expect(reconciled.checkpoint.observation).toBeUndefined();
      expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { release(); kernelCall.mockRestore(); await s.close(); }
  });
});
