import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core/kernel';
import { WorkspaceModule } from '../../src/modules/workspace';
import { AstraJournal, type AstraJson } from '../../src/agent-v3/journal';
import { AstraWorkScheduler, type AstraWorkAdapter, type AstraWorkLimits } from '../../src/agent-v3/work-scheduler';
import { AstraReadWorkAdapter } from '../../src/agent-v3/read-work-adapter';

let parent: string, fixture: string, root: string;
const marker = 'astra-work-scheduler-synthetic-only';
beforeAll(async () => {
  parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  fixture = await realpath(await mkdtemp(path.join(parent, 'astra-v3-scheduler-')));
  expect(path.dirname(fixture)).toBe(parent);
  await writeFile(path.join(fixture, '.fixture-marker'), marker, { flag: 'wx' });
  root = path.join(fixture, 'workspace'); await mkdir(root);
  for (const name of ['first.txt', 'second.txt', 'quick.txt']) await writeFile(path.join(root, name), 'SYNTHETIC ' + name + '\n', { flag: 'wx' });
});
afterAll(async () => {
  if (!fixture) return;
  expect(await realpath(fixture)).toBe(fixture); expect(path.dirname(fixture)).toBe(parent);
  expect(path.basename(fixture).startsWith('astra-v3-scheduler-')).toBe(true);
  expect(await readFile(path.join(fixture, '.fixture-marker'), 'utf8')).toBe(marker);
  await rm(fixture, { recursive: true, force: false });
});
async function setup(options: { restartSafeAdmission?: boolean; limits?: Partial<AstraWorkLimits>; now?: () => number; file?: string } = {}) {
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
  const workspace = new WorkspaceModule({ workspaceRoot: root }); kernel.registerModule(workspace); await kernel.start();
  const calls = vi.spyOn(workspace, 'executeCapability');
  const journal = new AstraJournal(options.file ?? ':memory:');
  const adapter = new AstraReadWorkAdapter({ canonicalRoot: root, kernel, journal, ...(options.restartSafeAdmission ? { restartSafeAdmission: true } : {}) });
  const hostOptions = { deployment: 'isolated-validation' as const, journal, scopeId: 'scheduler_test', adapters: [adapter],
    ...(options.limits ? { limits: options.limits } : {}), ...(options.now ? { now: options.now } : {}) };
  const host = new AstraWorkScheduler(hostOptions); host.acquire();
  return { kernel, workspace, calls, journal, adapter, host, hostOptions,
    close: async () => { await host.close(); calls.mockRestore(); await kernel.stop(); journal.close(); } };
}
function request(requestId: string, files = ['first.txt']) {
  return { requestId, adapterId: 'workspace-read', input: { steps: files.map((relativePath, index) => ({ id: 'step_' + index, relativePath })) } as AstraJson };
}
function ownerWorker(): Promise<{ status: string; code?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-v3/scheduler-worker.ts', fixture],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TSX_DISABLE_CACHE: '1', TEMP: fixture, TMP: fixture } });
    let output = '', error = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
    child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { error += String(data); });
    child.once('error', failure => { clearTimeout(timer); reject(failure); });
    child.once('close', code => { clearTimeout(timer); if (timedOut || code !== 0) reject(new Error(timedOut ? 'owned-worker-timeout' : error));
      else { try { resolve(JSON.parse(output)); } catch (failure) { reject(failure); } } });
  });
}

describe('Astra work scheduler → bounded read pack → real Kernel', () => {
  it.each([false, true])('renews a nearly expired live idle lease, but never revives an expired owner (%s)', async expired => {
    let now = 1000; const s = await setup({ now: () => now, limits: { leaseMs: 500 } });
    const off = s.kernel.subscribeEvent('action.proposal.received', () => { now = 1510; });
    try {
      const job = s.host.submit(request('near_expiry')); now = expired ? 1501 : 1495;
      if (expired) { expect(() => s.host.drain()).toThrow('owner-fenced'); expect(s.calls).not.toHaveBeenCalled(); }
      else {
        await s.host.drain(); expect(s.host.job(job.id).state).toBe('observed'); expect(s.calls).toHaveBeenCalledTimes(1);
        const checkpoint = s.journal.read('scheduler_scheduler_test')!.checkpoint as { generation: number; expiresAt: number };
        expect(checkpoint.generation).toBe(1); expect(checkpoint.expiresAt).toBeGreaterThanOrEqual(1995);
      }
    } finally { off(); await s.close(); }
  });
  it('explicit read-v2 admission survives a pre-dispatch Kernel restart but still refuses changed module semantics', async () => {
    const s = await setup({ restartSafeAdmission: true });
    try { expect(s.adapter.version).toBe('v2'); const job = s.host.submit(request('new_cohort'));
      await s.kernel.stop(); await s.kernel.start(); await s.host.drain();
      expect(s.host.job(job.id).state).toBe('observed'); expect(s.calls).toHaveBeenCalledTimes(1);
      const next = s.host.submit(request('changed_module')), readiness = s.kernel.getCapabilityReadiness.bind(s.kernel);
      const spy = vi.spyOn(s.kernel, 'getCapabilityReadiness').mockImplementation(id => { const value = readiness(id); return value ? { ...value, moduleVersion: 'changed' } : value; });
      try { await s.host.drain(); expect(s.host.job(next.id)).toMatchObject({ state: 'blocked', reason: 'adapter-binding-changed' }); }
      finally { spy.mockRestore(); }
      expect(s.calls).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('read-v2 retains the full fresh Kernel lifecycle fence after async observers and before module dispatch', async () => {
    const s = await setup({ restartSafeAdmission: true }); let changed = false;
    const readiness = s.kernel.getCapabilityReadiness.bind(s.kernel), spy = vi.spyOn(s.kernel, 'getCapabilityReadiness').mockImplementation(id => {
      const value = readiness(id); return value && changed ? { ...value, lifecycleRevision: value.lifecycleRevision + 1 } : value;
    });
    const off = s.kernel.subscribeEvent('capability.execution.started', async event => {
      if ((event.payload as { moduleId?: string }).moduleId === 'workspace') { await Promise.resolve(); changed = true; }
    });
    try { const job = s.host.submit(request('dispatch_fence')); await s.host.drain();
      expect(changed).toBe(true); expect(s.calls).not.toHaveBeenCalled(); expect(s.host.job(job.id).state).not.toBe('observed');
    } finally { off(); spy.mockRestore(); await s.close(); }
  });

  it('rejects a queue that cannot reserve its future read records before accepting or dispatching it', async () => {
    const s = await setup();
    try {
      const files = Array.from({ length: 32 }, () => 'first.txt');
      const first = s.host.submit(request('capacity_first', files));
      s.host.submit(request('capacity_second', files));
      const before = s.journal.capacity();
      expect(() => s.host.submit(request('capacity_third', files))).toThrow('store-budget');
      expect(s.host.list()).toHaveLength(2); expect(s.journal.capacity()).toEqual(before); expect(s.calls).not.toHaveBeenCalled();
      s.host.command(first.id, 'cancel');
      expect(s.journal.reservation(first.reservationId)).toBeNull();
      expect(s.host.submit(request('capacity_third', files)).state).toBe('queued');
      expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('atomically replaces one released terminal job and admits a long-lived successor without reserving the idle task lifetime', async () => {
    const s = await setup({ limits: { maxJobs: 2 } });
    try {
      const first = s.host.submit(request('retired_first')); await s.host.drain();
      expect(s.host.job(first.id).state).toBe('observed');
      expect(s.journal.reservation(first.reservationId)).toBeNull();
      const retiredStreams = first.storage.streams.map(stream => stream.streamId);
      expect(retiredStreams.some(streamId => s.journal.read(streamId))).toBe(true);
      const second = s.host.submit({ ...request('retired_second'), finishWithinMs: 12 * 60 * 60 * 1000 }, {
        commits: [], reservations: [], retireTerminalJobIds: [first.id],
      });
      expect(s.host.list()).toEqual([second]);
      expect(() => s.host.job(first.id)).toThrow('missing-job');
      expect(retiredStreams.every(streamId => s.journal.read(streamId) === null)).toBe(true);
      const schedulerBudget = s.journal.reservation(second.reservationId)!.plan.allocations
        .find(item => item.streamId === 'scheduler_scheduler_test')!;
      expect(schedulerBudget.commits).toBeLessThan(4096);
      expect(schedulerBudget.eventBytes).toBeLessThan(8 * 1024 * 1024);
      await s.host.drain(); expect(s.host.job(second.id).state).toBe('observed');
    } finally { await s.close(); }
  });

  it('refuses to retire non-terminal or still-reserved work without changing the queue', async () => {
    const s = await setup();
    try {
      const queued = s.host.submit(request('retirement_queued')), before = s.host.list();
      expect(() => s.host.submit(request('retirement_rejected'), {
        commits: [], reservations: [], retireTerminalJobIds: [queued.id],
      })).toThrow('retirement-not-terminal');
      expect(s.host.list()).toEqual(before);
      expect(s.journal.reservation(queued.reservationId)).not.toBeNull();
    } finally { await s.close(); }
  });

  it('bounds repeat controls while retaining an explicit cancel path', async () => {
    const s = await setup({ limits: { maxControlsPerJob: 2 } });
    try {
      const job = s.host.submit(request('control_budget'));
      s.host.command(job.id, 'pause'); s.host.command(job.id, 'resume');
      expect(() => s.host.command(job.id, 'pause')).toThrow('control-budget');
      expect(s.host.command(job.id, 'cancel').state).toBe('cancelled');
      expect(s.host.command(job.id, 'cancel').state).toBe('cancelled');
      expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('settles a job its owner can no longer drive, so the work above it can end', async () => {
    const s = await setup();
    try {
      const job = s.host.submit(request('abandoned'));
      const settled = s.host.abandon(job.id, 'agent-runtime-host-retired');
      // Blocked, never failed: a host giving up says nothing about what the
      // native worker did.
      expect(settled.state).toBe('blocked');
      expect(settled.result).toMatchObject({ state: 'blocked', reason: 'agent-runtime-host-retired' });
      expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('leaves an already settled job alone and refuses an unbounded abandon reason', async () => {
    const s = await setup();
    try {
      const job = s.host.submit(request('abandon_terminal'));
      expect(() => s.host.abandon(job.id, 'Reason With Spaces')).toThrow('abandon-reason');
      expect(() => s.host.abandon(job.id, 'x'.repeat(65))).toThrow('abandon-reason');
      s.host.command(job.id, 'cancel');
      expect(s.host.job(job.id).state).toBe('cancelled');
      expect(s.host.abandon(job.id, 'agent-runtime-host-retired').state).toBe('cancelled');
    } finally { await s.close(); }
  });

  it('does not activate queued work after Kernel stops or silently reuse pre-restart readiness', async () => {
    const s = await setup();
    try {
      const stopped = s.host.submit(request('stopped'));
      await s.kernel.stop(); await s.host.drain();
      expect(s.host.job(stopped.id)).toMatchObject({ state: 'blocked', reason: 'adapter-readiness-unavailable' });
      await s.kernel.start(); const restarted = s.host.submit(request('restarted'));
      await s.kernel.stop(); await s.kernel.start(); await s.host.drain();
      expect(s.host.job(restarted.id)).toMatchObject({ state: 'blocked', reason: 'adapter-binding-changed' });
      const fresh = s.host.submit(request('fresh')); await s.host.drain();
      expect(s.host.job(fresh.id).state).toBe('observed'); expect(s.calls).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('runs model-free jobs with zero model slots and fairly yields between actual graph steps', async () => {
    const s = await setup({ limits: { maxActive: 1, kernelSlots: 1, modelSlots: 0 } });
    try {
      const long = s.host.submit(request('long', ['first.txt', 'second.txt']));
      const quick = s.host.submit(request('quick', ['quick.txt']));
      expect(s.calls).not.toHaveBeenCalled();
      const result = await s.host.drain();
      expect(result.map(job => job.state)).toEqual(['observed', 'observed']);
      expect(s.calls.mock.calls.map(call => path.basename((call[0].input as { path: string }).path)))
        .toEqual(['first.txt', 'quick.txt', 'second.txt']);
      expect(s.host.job(long.id).activationGeneration).toBe(2);
      expect(s.host.job(quick.id).activationGeneration).toBe(1);
      expect(s.host.submit(request('long', ['first.txt', 'second.txt']))).toEqual(s.host.job(long.id));
      await s.host.drain(); expect(s.calls).toHaveBeenCalledTimes(3);
    } finally { await s.close(); }
  });

  it('distinguishes a new outer request from replay without letting callers mint an inner identity', async () => {
    const s = await setup();
    try {
      const a = s.host.submit(request('request_a')), b = s.host.submit(request('request_b'));
      expect((a.input as any).requestId).not.toBe((b.input as any).requestId);
      await s.host.drain(); expect(s.calls).toHaveBeenCalledTimes(2);
      expect(() => s.host.submit({ ...request('forged'), input: { requestId: 'user-selected-internal-id', steps: [{ id: 'one', relativePath: 'first.txt' }] } }))
        .toThrow('request-identity-owner');
      expect(() => s.host.submit(request('request_a', ['second.txt']))).toThrow('request-conflict');
    } finally { await s.close(); }
  });

  it('holds the configured resource capacity while another real read is in flight', async () => {
    const s = await setup({ limits: { kernelSlots: 1, maxActive: 2 } });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.calls.mockImplementationOnce(async (...args) => { entered(); await gate; return WorkspaceModule.prototype.executeCapability.call(s.workspace, ...args); });
    try {
      s.host.submit(request('resource_a')); const second = s.host.submit(request('resource_b', ['second.txt']));
      const running = s.host.drain(); await started;
      expect(s.host.job(second.id).state).toBe('queued'); expect(s.calls).toHaveBeenCalledTimes(1);
      release(); await running; expect(s.host.job(second.id).state).toBe('observed'); expect(s.calls).toHaveBeenCalledTimes(2);
    } finally { release(); await s.close(); }
  });

  it('persists queued cancellation and pause; explicit resume starts only the paused job', async () => {
    const s = await setup();
    try {
      const cancelled = s.host.submit(request('cancel_queued')), paused = s.host.submit(request('pause_queued'));
      expect(s.host.command(cancelled.id, 'cancel').state).toBe('cancelled');
      expect(s.host.command(paused.id, 'pause').state).toBe('paused');
      await s.host.drain(); expect(s.calls).not.toHaveBeenCalled();
      expect(s.host.command(paused.id, 'resume').state).toBe('queued');
      await s.host.drain(); expect(s.calls).toHaveBeenCalledTimes(1);
      expect(s.host.job(paused.id).state).toBe('observed');
    } finally { await s.close(); }
  });

  it('honours pause during an active read without running the next step or losing the read receipt', async () => {
    const s = await setup();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.calls.mockImplementationOnce(async (...args) => { entered(); await gate; return WorkspaceModule.prototype.executeCapability.call(s.workspace, ...args); });
    try {
      const job = s.host.submit(request('pause_running', ['first.txt', 'second.txt'])), running = s.host.drain();
      await started; expect(s.host.command(job.id, 'pause').state).toBe('pausing');
      release(); await running;
      expect(s.host.job(job.id).state).toBe('paused'); expect(s.calls).toHaveBeenCalledTimes(1);
      s.host.command(job.id, 'resume'); await s.host.drain();
      expect(s.host.job(job.id).state).toBe('observed'); expect(s.calls).toHaveBeenCalledTimes(2);
    } finally { release(); await s.close(); }
  });

  it('lets one new owner acquire after expiry and fences the old owner at the final Kernel boundary', async () => {
    let now = 1000;
    const s = await setup({ now: () => now, limits: { leaseMs: 1000, maxActive: 1, kernelSlots: 1 } });
    const successor = new AstraWorkScheduler(s.hostOptions);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const unsubscribe = s.kernel.subscribeEvent('capability.execution.started', async () => { if (first) { first = false; entered(); await gate; } });
    try {
      expect(() => successor.acquire()).toThrow('owner-live');
      const job = s.host.submit(request('takeover')), old = s.host.drain(); await started;
      now = 2001; successor.acquire();
      expect(() => s.host.submit(request('stale-submit'))).toThrow('owner-fenced');
      expect(successor.job(job.id).state).toBe('indeterminate');
      expect(successor.reconcile(job.id).state).toBe('indeterminate');
      expect(s.calls).not.toHaveBeenCalled();
      release(); await old; expect(s.calls).not.toHaveBeenCalled();
      expect(successor.reconcile(job.id).state).toBe('queued'); // Exact Kernel no-dispatch receipt, not a guessed retry.
      await successor.drain(); expect(successor.job(job.id).state).toBe('observed'); expect(s.calls).toHaveBeenCalledTimes(1);
    } finally { release(); unsubscribe(); await successor.close(); await s.close(); }
  });

  it('reconstructs persisted queued work after host release without losing admitted task identity', async () => {
    const s = await setup({ file: path.join(fixture, 'queue.sqlite') });
    try {
      const admitted = s.host.submit(request('durable-queue')); await s.host.close();
      const successor = new AstraWorkScheduler(s.hostOptions); successor.acquire();
      try { expect(successor.job(admitted.id).state).toBe('queued'); await successor.drain(); expect(successor.job(admitted.id).state).toBe('observed'); }
      finally { await successor.close(); }
      expect(s.calls).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('blocks an expired start deadline before any Kernel call', async () => {
    let now = 1000;
    const s = await setup({ now: () => now });
    try {
      const job = s.host.submit({ ...request('expired'), startWithinMs: 10, finishWithinMs: 100 });
      now = 1011; await s.host.drain();
      expect(s.host.job(job.id)).toMatchObject({ state: 'blocked', reason: 'queue-deadline' }); expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
});

describe('Astra work scheduler generic resource/progress contracts', () => {
  it('migrates an expired scheduler only through an explicit additive adapter set', async () => {
    const journal = new AstraJournal(':memory:'); let now = 1000;
    const make = (id: string): AstraWorkAdapter => ({ id, version: 'v1', compile: input => ({ input,
      resources: { kernelSlots: 0, modelSlots: 0, declaredBytes: 1024, exclusiveKeys: [] }, bindingDigest: id + '-binding',
      storage: { streams: [], maxActivations: 2 } }),
    execute: async () => ({ state: 'observed', progressDigest: id, checkpointRef: id, checkpointRevision: 1 }),
    control: () => { throw new Error('unused'); }, reconcile: () => { throw new Error('unused'); } });
    const oldAdapter = make('legacy_adapter'), added = make('agent_adapter'), limits = { leaseMs: 500 };
    const original = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'additive_upgrade',
      adapters: [oldAdapter], limits, now: () => now });
    original.acquire(); const legacyJob = original.submit({ requestId: 'legacy_job', adapterId: oldAdapter.id, input: {} });
    expect(() => new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'additive_upgrade',
      adapters: [oldAdapter, added], limits, now: () => now }).acquire()).toThrow('checkpoint-binding');
    const successor = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'additive_upgrade',
      adapters: [oldAdapter, added], upgradeFromAdapterSets: [[{ id: oldAdapter.id, version: oldAdapter.version }]],
      limits, now: () => now });
    try {
      expect(() => successor.acquire()).toThrow('owner-live');
      now = 1501; successor.acquire(); expect(successor.job(legacyJob.id).state).toBe('queued');
      const addedJob = successor.submit({ requestId: 'added_job', adapterId: added.id, input: {} });
      await successor.drain(); expect(successor.job(legacyJob.id).state).toBe('observed');
      expect(successor.job(addedJob.id).state).toBe('observed');
      expect(journal.read('scheduler_additive_upgrade')!.checkpoint).toMatchObject({ generation: 2 });
      expect(() => new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'wrong_upgrade',
        adapters: [oldAdapter, added], upgradeFromAdapterSets: [[{ id: oldAdapter.id, version: 'v2' }]], limits }))
        .toThrow('adapter-upgrade-not-additive');
    } finally { await successor.close(); await original.close(); journal.close(); }
  });

  it('has one real-process owner winner and recovers its queued job after unclean exit/expiry', async () => {
    const file = path.join(fixture, 'owner.sqlite'); new AstraJournal(file).close();
    const contenders = await Promise.all([ownerWorker(), ownerWorker()]);
    expect(contenders.filter(result => result.status === 'acquired')).toHaveLength(1);
    const rejected = contenders.find(result => result.status === 'rejected')!;
    expect(['astra-scheduler:owner-live', 'astra-scheduler:concurrent-update']).toContain(rejected.code);
    const journal = new AstraJournal(file);
    const adapter: AstraWorkAdapter = { id: 'fixture', version: 'v1', compile: input => ({ input,
      resources: { kernelSlots: 0, modelSlots: 0, declaredBytes: 1024, exclusiveKeys: [] }, bindingDigest: 'fixture',
      storage: { streams: [], maxActivations: 4 } }),
      execute: async () => ({ state: 'observed', progressDigest: 'fixture', checkpointRef: 'fixture', checkpointRevision: 1 }),
      control: () => { throw new Error('unused'); }, reconcile: () => { throw new Error('unused'); } };
    const successor = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'process_owner',
      adapters: [adapter], now: () => 2001, limits: { leaseMs: 1000 } });
    try {
      successor.acquire(); expect(successor.list()).toHaveLength(1); expect(successor.list()[0]!.state).toBe('queued');
      await successor.drain(); expect(successor.list()[0]!.state).toBe('observed');
      expect(journal.read('scheduler_process_owner')!.checkpoint).toMatchObject({ generation: 2 });
    } finally { await successor.close(); journal.close(); }
  }, 15000);
  it('bounds a hanging adapter, retains its resource reservation and ignores late success until reconciliation', async () => {
    const journal = new AstraJournal(':memory:');
    let finish!: (value: Awaited<ReturnType<AstraWorkAdapter['execute']>>) => void;
    let calls = 0;
    const adapter: AstraWorkAdapter = { id: 'hanging', version: 'v1', compile: input => ({ input,
      resources: { kernelSlots: 0, modelSlots: 1, declaredBytes: 1024, exclusiveKeys: ['synthetic_model'] }, bindingDigest: 'fixture',
      storage: { streams: [], maxActivations: 4 } }),
      execute: async () => { calls++; return new Promise(resolve => { finish = resolve; }); },
      control: () => { throw new Error('unused'); },
      reconcile: () => ({ state: 'observed', progressDigest: 'retained', checkpointRef: 'fixture', checkpointRevision: 1 }) };
    const host = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'hanging', adapters: [adapter], limits: { activationTimeoutMs: 50 } });
    host.acquire();
    try {
      const one = host.submit({ requestId: 'one', adapterId: adapter.id, input: {} });
      await host.drain();
      expect(host.job(one.id)).toMatchObject({ state: 'indeterminate', result: { reason: 'adapter-deadline-indeterminate' } });
      const two = host.submit({ requestId: 'two', adapterId: adapter.id, input: {} });
      finish({ state: 'observed', progressDigest: 'retained', checkpointRef: 'fixture', checkpointRevision: 1 });
      await Promise.resolve(); await host.drain();
      expect(host.job(one.id).state).toBe('indeterminate'); expect(host.job(two.id).state).toBe('queued'); expect(calls).toBe(1);
      expect(host.reconcile(one.id).state).toBe('observed');
    } finally { await host.close(); journal.close(); }
  });
  it('ignores a late error from an older control epoch even when best-effort reconcile throws', async () => {
    const journal = new AstraJournal(':memory:');
    let reject!: (error: Error) => void;
    const adapter: AstraWorkAdapter = { id: 'late_error', version: 'v1', compile: input => ({ input,
      resources: { kernelSlots: 0, modelSlots: 1, declaredBytes: 1024, exclusiveKeys: ['synthetic_model'] },
      bindingDigest: 'late-error-fixture', storage: { streams: [], maxActivations: 4 } }),
      execute: async () => new Promise((_resolve, fail) => { reject = fail; }),
      control: (_input, command) => ({ state: command === 'pause' ? 'paused' : 'cancelled',
        progressDigest: 'controlled', checkpointRef: 'fixture', checkpointRevision: 1 }),
      reconcile: () => { throw new Error('fixture-reconcile-failed'); } };
    const host = new AstraWorkScheduler({ deployment: 'isolated-validation', journal,
      scopeId: 'late_error', adapters: [adapter], limits: { activationTimeoutMs: 5000 } });
    host.acquire();
    try {
      const job = host.submit({ requestId: 'late_error', adapterId: adapter.id, input: {} });
      const draining = host.drain();
      while (!reject) await new Promise(resolve => setTimeout(resolve, 1));
      expect(host.command(job.id, 'pause').state).toBe('paused');
      reject(new Error('late-old-activation-error'));
      await expect(draining).resolves.toBeDefined();
      expect(host.job(job.id).state).toBe('paused');
    } finally { await host.close(); journal.close(); }
  });

  it('rejects changed resource demand at activation even if an adapter forgot to change its binding digest', async () => {
    const journal = new AstraJournal(':memory:'); let demand = 1, calls = 0;
    const adapter: AstraWorkAdapter = { id: 'dynamic', version: 'v1', compile: input => ({ input,
      resources: { kernelSlots: demand, modelSlots: 0, declaredBytes: 1024, exclusiveKeys: [] }, bindingDigest: 'same_digest',
      storage: { streams: [], maxActivations: 4 } }),
      execute: async () => { calls++; return { state: 'observed', progressDigest: 'done', checkpointRef: 'fixture', checkpointRevision: 1 }; },
      control: () => { throw new Error('unused'); }, reconcile: () => { throw new Error('unused'); } };
    const host = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'dynamic', adapters: [adapter] });
    host.acquire();
    try {
      const job = host.submit({ requestId: 'one', adapterId: adapter.id, input: {} }); demand = 2;
      await host.drain(); expect(host.job(job.id)).toMatchObject({ state: 'blocked', reason: 'adapter-binding-changed' }); expect(calls).toBe(0);
    } finally { await host.close(); journal.close(); }
  });
  it.each([false, true])('honors a sealed long activation budget while the job deadline still wins (%s)', async shortDeadline => {
    const journal = new AstraJournal(':memory:'); let calls = 0, aborted = false;
    const adapter: AstraWorkAdapter = { id: 'budgeted', version: 'v1', compile: input => ({ input, activationBudgetMs: 1000,
      resources: { kernelSlots: 0, modelSlots: 1, declaredBytes: 1024, exclusiveKeys: [] }, bindingDigest: 'fixture',
      storage: { streams: [], maxActivations: 4 } }),
      execute: async (_, control) => { calls++; await new Promise(resolve => setTimeout(resolve, 150));
        aborted = control.signal.aborted;
        return { state: 'observed', progressDigest: 'done', checkpointRef: 'fixture', checkpointRevision: 1 }; },
      control: () => { throw new Error('unused'); }, reconcile: () => { throw new Error('unused'); } };
    const host = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'budgeted', adapters: [adapter],
      limits: { activationTimeoutMs: 50 } }); host.acquire();
    try {
      const job = host.submit({ requestId: 'one', adapterId: adapter.id, input: {}, startWithinMs: 50,
        finishWithinMs: shortDeadline ? 100 : 2000 });
      expect(host.job(job.id).activationBudgetMs).toBe(1000);
      expect(journal.read('scheduler_budgeted')!.checkpoint).toMatchObject({ jobs: [{ activationBudgetMs: 1000 }] });
      await host.drain();
      expect(host.job(job.id).state).toBe(shortDeadline ? 'indeterminate' : 'observed');
      await new Promise(resolve => setTimeout(resolve, 175));
      expect(aborted).toBe(shortDeadline); expect(calls).toBe(1);
      expect(host.job(job.id).state).toBe(shortDeadline ? 'indeterminate' : 'observed');
      if (shortDeadline) {
        const next = host.submit({ requestId: 'two', adapterId: adapter.id, input: {} }); await host.drain();
        expect(host.job(next.id).state).toBe('queued'); expect(calls).toBe(1);
      }
    } finally { await host.close(); journal.close(); }
  });
  it.each([0, -1, 605001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid adapter time budget %s at admission', async budget => {
    const s = await setup(); const original = s.adapter.compile.bind(s.adapter);
    const spy = vi.spyOn(s.adapter, 'compile').mockImplementation((input, context) => ({ ...original(input, context), activationBudgetMs: budget }));
    try { expect(() => s.host.submit(request('invalid_budget'))).toThrow('activation-time-budget');
      expect(s.host.list()).toHaveLength(0); expect(s.calls).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); await s.close(); }
  });
  it.each([undefined, 1000])('blocks changed activation budget, including legacy absent declarations (%s)', async initialBudget => {
    const s = await setup(); let budget = initialBudget; const original = s.adapter.compile.bind(s.adapter);
    const spy = vi.spyOn(s.adapter, 'compile').mockImplementation((input, context) => ({ ...original(input, context),
      ...(budget === undefined ? {} : { activationBudgetMs: budget }) }));
    try {
      const job = s.host.submit(request('changed_budget')); budget = 2000;
      await s.host.drain(); expect(s.host.job(job.id)).toMatchObject({ state: 'blocked', reason: 'adapter-binding-changed' });
      expect(s.calls).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); await s.close(); }
  });
  it('blocks a repeatedly yielding adapter without semantic progress', async () => {
    const journal = new AstraJournal(':memory:'); let calls = 0;
    const adapter: AstraWorkAdapter = { id: 'synthetic', version: 'v1', compile: input => ({ input,
      resources: { kernelSlots: 0, modelSlots: 0, declaredBytes: 1024, exclusiveKeys: [] }, bindingDigest: 'fixture_binding',
      storage: { streams: [], maxActivations: 4 } }),
      execute: async () => { calls++; return { state: 'queued', progressDigest: 'unchanged', checkpointRef: 'fixture', checkpointRevision: calls }; },
      control: () => { throw new Error('unused'); }, reconcile: () => { throw new Error('unused'); } };
    const host = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'progress', adapters: [adapter] });
    host.acquire();
    try {
      const job = host.submit({ requestId: 'no_progress', adapterId: adapter.id, input: {} });
      await host.drain(); expect(calls).toBe(2);
      expect(host.job(job.id)).toMatchObject({ state: 'blocked', result: { reason: 'no-progress' } });
    } finally { await host.close(); journal.close(); }
  });
});

describe('Astra work scheduler lease over a long hold', () => {
  it('keeps one live owner for hours past the per-stream commit limit, with bounded retained history', async () => {
    vi.useFakeTimers(); let now = 10_000;
    const journal = new AstraJournal(':memory:');
    const adapter: AstraWorkAdapter = { id: 'hold_adapter', version: 'v1',
      compile: input => ({ input, bindingDigest: 'hold', resources: { kernelSlots: 0, modelSlots: 1, declaredBytes: 1024, exclusiveKeys: [] },
        storage: { streams: [], maxActivations: 2 } }),
      execute: async () => ({ state: 'observed', progressDigest: 'hold', checkpointRef: 'hold', checkpointRevision: 1 }),
      control: () => { throw new Error('unused'); }, reconcile: () => { throw new Error('unused'); } };
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'long_hold', adapters: [adapter], now: () => now });
    try {
      scheduler.acquire(); const generation = (journal.read('scheduler_long_hold')!.checkpoint as { generation: number }).generation;
      let lostAt = -1;
      // Three hours of progression holding the lease with no job to charge:
      // the owner allocation used to run dry after ~109 s, the stream after 4096 commits.
      await scheduler.withOwnedLease(async () => {
        for (let second = 0; second < 10_800; second++) {
          now += 1000; await vi.advanceTimersByTimeAsync(1000);
          if (lostAt < 0 && !scheduler.ownerIsCurrent()) lostAt = second;
        }
      });
      expect(lostAt).toBe(-1);
      const snapshot = journal.read('scheduler_long_hold')!;
      expect(snapshot.revision).toBeGreaterThan(4096);
      expect((snapshot.checkpoint as { generation: number }).generation).toBe(generation);
      const retained = journal.history('scheduler_long_hold', 0, 128);
      expect(retained[0]!.receipt.revision).toBeGreaterThan(1);
      let after = 0, total = 0;
      for (;;) { const page = journal.history('scheduler_long_hold', after, 128); if (!page.length) break; total += page.length; after = page.at(-1)!.receipt.revision; }
      expect(after).toBe(snapshot.revision); expect(total).toBeLessThanOrEqual(768);
    } finally { vi.useRealTimers(); await scheduler.close(); journal.close(); }
  }, 120_000);
});
