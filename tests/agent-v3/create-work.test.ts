import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core/kernel';
import { MonarchActionLedger } from '../../src/core/action-ledger';
import { WorkspaceModule, type WorkspaceModuleOptions } from '../../src/modules/workspace';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraCreateWorkAdapter, type AstraCreateWorkInput } from '../../src/agent-v3/create-work-adapter';
import { AstraWorkScheduler, type AstraWorkLimits } from '../../src/agent-v3/work-scheduler';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';

let parent: string, fixture: string, sequence = 0;
const marker = 'astra-v3-create-owned-kernel-effects-only';
beforeAll(async () => {
  parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  fixture = await realpath(await mkdtemp(path.join(parent, 'astra-v3-create-')));
  expect(path.dirname(fixture)).toBe(parent);
  await writeFile(path.join(fixture, '.fixture-marker'), marker, { flag: 'wx' });
});
afterAll(async () => {
  if (!fixture) return;
  expect(await realpath(fixture)).toBe(fixture); expect(path.dirname(fixture)).toBe(parent);
  expect(path.basename(fixture).startsWith('astra-v3-create-')).toBe(true);
  expect(await readFile(path.join(fixture, '.fixture-marker'), 'utf8')).toBe(marker);
  await rm(fixture, { recursive: true, force: false });
});
async function setup(options: { current?: () => boolean; beforeMutation?: WorkspaceModuleOptions['beforeMutation'];
  profile?: 'read-only' | 'workspace-write'; security?: boolean; file?: boolean; limits?: Partial<AstraWorkLimits> } = {}) {
  const root = path.join(fixture, 'workspace_' + sequence++); await mkdir(root);
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: { sandboxMode: options.profile ?? 'workspace-write', approvalPolicy: 'never' } });
  const workspace = new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [], ...(options.beforeMutation ? { beforeMutation: options.beforeMutation } : {}) });
  kernel.registerModule(workspace);
  if (options.security !== false) kernel.registerModule(isolatedLocalSecurity(root));
  await kernel.start();
  const file = options.file ? path.join(root, 'owned.sqlite') : ':memory:';
  const journal = new AstraJournal(file), scopeId = 'create_scope_' + sequence++;
  const sources = new Map<string, Pick<AstraCreateWorkInput, 'basename' | 'content' | 'source'>>();
  const adapter = new AstraCreateWorkAdapter({ deployment: 'isolated-validation', canonicalRoot: root, kernel, journal,
    isSourceCurrent: input => (options.current?.() ?? true) && JSON.stringify(sources.get(input.source.messageId))
      === JSON.stringify({ basename: input.basename, content: input.content, source: input.source }) });
  const schedulerOptions = { deployment: 'isolated-validation' as const, journal, scopeId, adapters: [adapter],
    ...(options.limits ? { limits: options.limits } : {}) };
  const scheduler = new AstraWorkScheduler(schedulerOptions); scheduler.acquire();
  const calls = vi.spyOn(workspace, 'executeCapability'), gateway = vi.spyOn(kernel, 'executeActionProposal');
  const submit = (basename = 'new.txt', content = 'owned create', requestId = 'create_' + sequence++, timeoutMs = 5000, sourceText?: string) => {
    const source = { interactionId: 'synthetic_interaction', messageId: 'message_' + requestId, revision: 1,
      userText: sourceText ?? 'Create the synthetic file ' + basename + ' with the explicitly selected content.' };
    sources.set(source.messageId, { basename, content, source });
    return scheduler.submit({ requestId, adapterId: adapter.id, input: { basename, content, timeoutMs, source } });
  };
  return { root, kernel, workspace, journal, file, adapter, scheduler, schedulerOptions, calls, gateway, submit,
    close: async () => { await scheduler.close(); await kernel.stop(); journal.close(); calls.mockRestore(); gateway.mockRestore(); } };
}

async function crashWorker(root: string, stage: 'before-ledger' | 'after-ledger'): Promise<{
  stage: string; jobId: string; workspaceCalls: number; phase: string; effect: string; ledgerStatus: string; idempotencyKey: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-v3/create-work-worker.ts', root, stage],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TSX_DISABLE_CACHE: '1', TEMP: root, TMP: root } });
    let stdout = '', stderr = '', failure = '';
    const timer = setTimeout(() => { failure = 'owned-create-worker-timeout'; child.kill(); }, 10000);
    child.stdout.on('data', data => { stdout += String(data); if (stdout.length > 8192) { failure = 'worker-output-budget'; child.kill(); } });
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-16384); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== (stage === 'after-ledger' ? 62 : 63)) reject(new Error(failure || stderr || 'wrong-owned-exit:' + code));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
}

describe('Astra V3 create-only work → actual Kernel → real isolated file', () => {
  it.each(['', 'Привет 🌟\n', 'x'.repeat(4103)])('creates exact bounded text and replays it without another action (%#.case)', async content => {
    const s = await setup();
    try {
      const job = s.submit('result.txt', content);
      await s.scheduler.drain(); expect(s.scheduler.job(job.id).state, JSON.stringify(s.kernel.getSnapshot().audit.slice(-5))).toBe('observed');
      const view = s.adapter.inspect(job.input);
      expect(view).toMatchObject({ nativeCompletionCertified: false, checkpoint: { phase: 'settled', effect: 'applied', quiescent: true,
        observation: { bytes: Buffer.byteLength(content), temporalSemantics: 'snapshot-after-create' } } });
      expect(await readFile(path.join(s.root, 'result.txt'), 'utf8')).toBe(content);
      expect(s.calls).toHaveBeenCalledTimes(1); expect(s.gateway).toHaveBeenCalledTimes(1);
      await s.scheduler.drain(); expect(s.scheduler.reconcile(job.id).state).toBe('observed'); expect(s.calls).toHaveBeenCalledTimes(1);
      expect(s.journal.reservation(job.reservationId)).toBeNull();
    } finally { await s.close(); }
  });

  it('rejects traversal, aliases, authority injection and resource overflow before admitting any work', async () => {
    const s = await setup();
    try {
      for (const basename of ['../wrong.txt', 'folder/file.txt', 'folder\\file.txt', 'C:bad', 'nul.txt', 'COM¹.txt', 'LPT²', 'CONOUT$',
        'bad.', 'bad ', '.', '..', '\u007f.txt']) {
        expect(() => s.submit(basename)).toThrow('single-leaf-required');
      }
      expect(() => s.submit('big.txt', 'x'.repeat(16385))).toThrow('content-budget');
      expect(() => s.submit('\ud800.txt')).toThrow('astra-journal:unicode');
      expect(() => s.submit('invalid-text.txt', '\ud800')).toThrow('astra-journal:unicode');
      expect(() => s.scheduler.submit({ requestId: 'injected', adapterId: s.adapter.id,
        input: { basename: 'x.txt', content: '', confirmed: true } })).toThrow('input-shape');
      expect(s.scheduler.list()).toHaveLength(0); expect(s.calls).not.toHaveBeenCalled(); expect(s.gateway).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('preserves an existing file or directory without reading it through Kernel', async () => {
    const s = await setup();
    try {
      await writeFile(path.join(s.root, 'existing.txt'), 'KEEP'); await mkdir(path.join(s.root, 'folder'));
      const a = s.submit('existing.txt', 'bad'), b = s.submit('folder', 'bad');
      await s.scheduler.drain();
      expect([s.scheduler.job(a.id).state, s.scheduler.job(b.id).state]).toEqual(['blocked', 'blocked']);
      expect(s.adapter.inspect(a.input).checkpoint.effect).toBe('not-applied');
      expect(await readFile(path.join(s.root, 'existing.txt'), 'utf8')).toBe('KEEP'); expect(s.gateway).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('preserves a competing file created after preflight and before the real exclusive open', async () => {
    const s = await setup({ beforeMutation: async (operation, targets) => {
      if (operation === 'write') await writeFile(targets[0]!, 'OTHER ACTOR', { flag: 'wx' });
    } });
    try {
      const job = s.submit('raced.txt', 'MUST NOT REPLACE'); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('blocked');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ effect: 'not-applied', reason: 'file-exists' });
      expect(await readFile(path.join(s.root, 'raced.txt'), 'utf8')).toBe('OTHER ACTOR');
      expect(s.calls).toHaveBeenCalledTimes(1); expect(s.gateway).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('serializes same-target jobs with an exclusive resource key without replacing the first artifact', async () => {
    const s = await setup();
    try {
      const a = s.submit('once.txt', 'FIRST'), b = s.submit('once.txt', 'SECOND');
      expect(a.resources.exclusiveKeys).toEqual(b.resources.exclusiveKeys);
      await s.scheduler.drain(); expect(s.scheduler.job(a.id).state).toBe('observed'); expect(s.scheduler.job(b.id).state).toBe('blocked');
      expect(await readFile(path.join(s.root, 'once.txt'), 'utf8')).toBe('FIRST'); expect(s.calls).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('does not turn an admitted source into a permission override', async () => {
    const s = await setup({ profile: 'read-only' });
    try {
      const job = s.submit(); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('blocked'); expect(s.adapter.inspect(job.input).checkpoint.effect).toBe('not-applied');
      expect(s.calls).not.toHaveBeenCalled(); expect(s.gateway).toHaveBeenCalledTimes(1);
      await expect(readFile(path.join(s.root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await s.close(); }
  });

  it('does not bypass missing Security even for an admitted synthetic source', async () => {
    const s = await setup({ security: false });
    try {
      const job = s.submit(); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('blocked');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ effect: 'not-applied', reason: 'permission-denied' });
      expect(s.calls).not.toHaveBeenCalled(); expect(s.gateway).toHaveBeenCalledTimes(1);
      await expect(readFile(path.join(s.root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await s.close(); }
  });

  it('does not invent a write request from the desired action when the original source only asked to summarize', async () => {
    const s = await setup();
    try {
      const job = s.submit('unasked.txt', 'NO', 'unasked_source', 5000, 'Summarize this conversation.');
      await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('blocked');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ effect: 'not-applied' });
      expect(s.calls).not.toHaveBeenCalled();
      await expect(readFile(path.join(s.root, 'unasked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await s.close(); }
  });

  it('rejects revoked source admission without queuing or dispatching anything', async () => {
    const s = await setup({ current: () => false });
    try {
      expect(() => s.submit()).toThrow('source-stale'); expect(s.scheduler.list()).toHaveLength(0);
      expect(s.calls).not.toHaveBeenCalled(); expect(s.gateway).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('keeps a queued pause across reconstruction and executes only on explicit resume', async () => {
    const s = await setup();
    try {
      const job = s.submit(); expect(s.scheduler.command(job.id, 'pause').state).toBe('paused');
      await s.scheduler.close();
      const restored = new AstraWorkScheduler(s.schedulerOptions); restored.acquire();
      try {
        await restored.drain(); expect(restored.job(job.id).state).toBe('paused'); expect(s.calls).not.toHaveBeenCalled();
        restored.command(job.id, 'resume'); await restored.drain(); expect(restored.job(job.id).state).toBe('observed');
        expect(s.calls).toHaveBeenCalledTimes(1);
      } finally { await restored.close(); }
    } finally { await s.close(); }
  });

  it.each(['module-version', 'capability', 'inactive'] as const)('rejects queued admission drift (%s) before Kernel invocation', async mode => {
    const s = await setup();
    const readiness = s.kernel.getCapabilityReadiness.bind(s.kernel), capabilities = s.kernel.listCapabilities.bind(s.kernel);
    try {
      const job = s.submit();
      const readinessSpy = vi.spyOn(s.kernel, 'getCapabilityReadiness').mockImplementation(id => {
        const value = readiness(id); return !value ? value : { ...value,
          ...(mode === 'module-version' ? { moduleVersion: value.moduleVersion + '-changed' } : {}),
          ...(mode === 'inactive' ? { status: 'inactive' as const } : {}) };
      });
      const capabilitySpy = vi.spyOn(s.kernel, 'listCapabilities').mockImplementation(() => capabilities().map(value =>
        mode === 'capability' && value.id === 'workspace.files.write' ? { ...value, description: value.description + ' changed' } : value));
      try {
        await s.scheduler.drain(); expect(s.scheduler.job(job.id).state).toBe('blocked');
        expect(s.gateway).not.toHaveBeenCalled(); expect(s.calls).not.toHaveBeenCalled();
        await expect(readFile(path.join(s.root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { readinessSpy.mockRestore(); capabilitySpy.mockRestore(); }
    } finally { await s.close(); }
  });

  it('fences changed Kernel lifecycle at the final async dispatch boundary despite stable admission', async () => {
    const s = await setup(); let changed = false;
    const readiness = s.kernel.getCapabilityReadiness.bind(s.kernel);
    const spy = vi.spyOn(s.kernel, 'getCapabilityReadiness').mockImplementation(id => {
      const value = readiness(id); return value && changed ? { ...value, lifecycleRevision: value.lifecycleRevision + 1 } : value;
    });
    const off = s.kernel.subscribeEvent('capability.execution.started', async event => {
      if ((event.payload as { moduleId?: string }).moduleId === 'workspace') { await Promise.resolve(); changed = true; }
    });
    try {
      const job = s.submit(); await s.scheduler.drain();
      expect(changed).toBe(true); expect(s.scheduler.job(job.id).state).toBe('blocked');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ effect: 'not-applied', quiescent: true });
      expect(s.gateway).toHaveBeenCalledTimes(1); expect(s.calls).not.toHaveBeenCalled();
      await expect(readFile(path.join(s.root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { off(); spy.mockRestore(); await s.close(); }
  });

  it('cancels queued work without invoking Kernel and without claiming an effect', async () => {
    const s = await setup();
    try {
      const job = s.submit(); expect(s.scheduler.command(job.id, 'cancel').state).toBe('cancelled');
      await s.scheduler.drain(); expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ effect: 'not-applied', quiescent: true });
      expect(s.gateway).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(['cancel', 'revoke'])('honors %s at the last async Kernel boundary and retains positive no-dispatch proof', async mode => {
    let current = true;
    const s = await setup({ current: () => current });
    try {
      const job = s.submit();
      const off = s.kernel.subscribeEvent('capability.execution.started', async event => {
        if ((event.payload as { moduleId?: string }).moduleId !== 'workspace') return;
        await Promise.resolve(); if (mode === 'cancel') s.scheduler.command(job.id, 'cancel'); else current = false;
      });
      try { await s.scheduler.drain(); } finally { off(); }
      expect(s.scheduler.job(job.id).state).toBe(mode === 'cancel' ? 'cancelled' : 'blocked');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ effect: 'not-applied', quiescent: true });
      expect(s.calls).not.toHaveBeenCalled(); await expect(readFile(path.join(s.root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await s.close(); }
  });

  it.each(['cancel', 'pause'] as const)('retains the already created effect when %s arrives after native write/readback', async command => {
    const s = await setup();
    try {
      const job = s.submit('late.txt', 'ALREADY APPLIED');
      const off = s.kernel.subscribeEvent('workspace.file.written', () => { s.scheduler.command(job.id, command); });
      try { await s.scheduler.drain(); } finally { off(); }
      expect(s.scheduler.job(job.id).state).toBe(command === 'cancel' ? 'cancelled' : 'paused');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ effect: 'applied', quiescent: true });
      expect(await readFile(path.join(s.root, 'late.txt'), 'utf8')).toBe('ALREADY APPLIED');
      if (command === 'pause') { expect(s.scheduler.command(job.id, 'resume').state).toBe('observed'); await s.scheduler.drain(); }
      expect(s.calls).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('recovers a lost post-effect return only from the exact receipt, without a second dispatch', async () => {
    const s = await setup();
    try {
      const actual = MonarchKernel.prototype.executeActionProposal.bind(s.kernel);
      s.gateway.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('owned-lost-return'); });
      const job = s.submit(); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('indeterminate'); expect(s.journal.reservation(job.reservationId)).not.toBeNull();
      expect(s.scheduler.reconcile(job.id).state).toBe('observed');
      expect(s.adapter.inspect(job.input).checkpoint.effect).toBe('applied'); expect(s.calls).toHaveBeenCalledTimes(1); expect(s.gateway).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('keeps a real applied effect uncertain when its Store capture fails, then reuses the existing receipt', async () => {
    const s = await setup({ file: true }), fault = new DatabaseSync(s.file);
    try {
      const job = s.submit();
      fault.exec("CREATE TRIGGER reject_created BEFORE UPDATE ON astra_streams WHEN NEW.stream_id LIKE 'create_work_%' AND CAST(NEW.checkpoint AS TEXT) LIKE '%\"effect\":\"applied\"%' BEGIN SELECT RAISE(ABORT,'owned-effect-save-fault'); END;");
      await s.scheduler.drain(); expect(s.scheduler.job(job.id).state).toBe('indeterminate'); expect(s.calls).toHaveBeenCalledTimes(1);
      fault.exec('DROP TRIGGER reject_created');
      expect(s.scheduler.reconcile(job.id).state).toBe('observed'); expect(s.calls).toHaveBeenCalledTimes(1);
      expect(await readFile(path.join(s.root, 'new.txt'), 'utf8')).toBe('owned create');
    } finally { fault.close(); await s.close(); }
  });

  it('does not treat matching file bytes as ownership proof when the exact receipt is missing', async () => {
    const s = await setup();
    let receipt: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const actual = MonarchKernel.prototype.executeActionProposal.bind(s.kernel);
      s.gateway.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('owned-lost-return'); });
      const job = s.submit(); await s.scheduler.drain();
      receipt = vi.spyOn(s.kernel, 'getActionLedgerRecord').mockReturnValue(null);
      expect(s.scheduler.reconcile(job.id).state).toBe('indeterminate'); await s.scheduler.drain();
      expect(s.journal.reservation(job.reservationId)).not.toBeNull(); expect(s.gateway).toHaveBeenCalledTimes(1);
      expect(s.adapter.inspect(job.input).checkpoint.effect).toBe('unknown');
    } finally { receipt?.mockRestore(); await s.close(); }
  });

  it.each(['cancelled', 'write-failed'])('retains a real partial file after an injected %s instead of retrying or reporting no effect', async error => {
    const s = await setup();
    try {
      s.calls.mockImplementationOnce(async request => {
        await writeFile((request.input as { path: string }).path, 'PARTIAL', { flag: 'wx' });
        return { ok: false, summary: 'Injected failure after a real partial write.', error,
          metadata: { dispatchControl: { dispatched: false } } };
      });
      const job = s.submit('partial.txt', 'INTENDED COMPLETE CONTENT'); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('indeterminate');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ effect: 'unknown', quiescent: true });
      expect(s.scheduler.reconcile(job.id).state).toBe('indeterminate'); await s.scheduler.drain();
      expect(await readFile(path.join(s.root, 'partial.txt'), 'utf8')).toBe('PARTIAL');
      expect(s.calls).toHaveBeenCalledTimes(1); expect(s.gateway).toHaveBeenCalledTimes(1);
      expect(s.journal.reservation(job.reservationId)).not.toBeNull();
    } finally { await s.close(); }
  });

  it('retains the deadline-late acknowledged write while holding resources until its exact receipt arrives', async () => {
    const s = await setup();
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const off = s.kernel.subscribeEvent('workspace.file.written', async () => { enter(); await gate; });
    try {
      const job = s.submit('late-deadline.txt', 'ACTUALLY WRITTEN', 'deadline_late', 50);
      const running = s.scheduler.drain(); await started; await running;
      expect(s.scheduler.job(job.id).state).toBe('indeterminate'); expect(s.journal.reservation(job.reservationId)).not.toBeNull();
      expect(s.scheduler.reconcile(job.id).state).toBe('indeterminate'); release();
      await vi.waitFor(() => expect(s.adapter.inspect(job.input).checkpoint.effect).toBe('applied'), { timeout: 2000 });
      expect(s.scheduler.reconcile(job.id).state).toBe('observed'); await s.scheduler.drain();
      expect(s.calls).toHaveBeenCalledTimes(1); expect(s.gateway).toHaveBeenCalledTimes(1);
      expect(await readFile(path.join(s.root, 'late-deadline.txt'), 'utf8')).toBe('ACTUALLY WRITTEN');
      expect(s.journal.reservation(job.reservationId)).toBeNull();
    } finally { release(); off(); await s.close(); }
  });

  it('rejects a mismatched returned readback and recovers only from the independent exact Kernel receipt', async () => {
    const s = await setup();
    try {
      const actual = MonarchKernel.prototype.executeActionProposal.bind(s.kernel);
      s.gateway.mockImplementationOnce(async (...args) => {
        const result = structuredClone(await actual(...args));
        (result.result.output as { readbackSha256: string }).readbackSha256 = '0'.repeat(64); return result;
      });
      const job = s.submit(); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('indeterminate');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ effect: 'unknown', reason: 'create-evidence-binding' });
      expect(s.scheduler.reconcile(job.id).state).toBe('observed'); expect(s.calls).toHaveBeenCalledTimes(1);
      expect(s.adapter.inspect(job.input).checkpoint.reason).toBeUndefined();
    } finally { await s.close(); }
  });

  it('refuses a target junction and does not touch the other owned directory', async () => {
    const s = await setup();
    try {
      const destination = path.join(fixture, 'other_' + sequence++); await mkdir(destination);
      await symlink(destination, path.join(s.root, 'linked'), 'junction');
      const job = s.submit('linked', 'NO'); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('blocked'); expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(['before-ledger', 'after-ledger'] as const)('handles a real process crash %s without another write or invented evidence', async stage => {
    const root = path.join(fixture, 'crash_' + sequence++); await mkdir(root);
    const report = await crashWorker(root, stage);
    expect(report, JSON.stringify(report)).toMatchObject({ stage, workspaceCalls: 1, helperCalls: 0, phase: 'dispatching', effect: 'unknown',
      ledgerStatus: stage === 'after-ledger' ? 'completed' : 'executing' });
    await new Promise(resolve => setTimeout(resolve, 600)); // Actual lease expires after the owned process has exited.
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: path.join(root, 'owned-agency'),
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } });
    const workspace = new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] });
    kernel.registerModule(workspace); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
    const calls = vi.spyOn(workspace, 'executeCapability'), gateway = vi.spyOn(kernel, 'executeActionProposal');
    const journal = new AstraJournal(path.join(root, 'owned.sqlite'));
    const adapter = new AstraCreateWorkAdapter({ deployment: 'isolated-validation', canonicalRoot: root, kernel, journal,
      isSourceCurrent: input => input.basename === 'crashed.txt' && input.content === 'OWNED CRASH ARTIFACT\n'
        && input.source.interactionId === 'synthetic_crash' && input.source.messageId === 'synthetic_crash_message' && input.source.revision === 1
        && input.source.userText === 'Create the synthetic file crashed.txt with the explicitly selected content.' });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'create_crash',
      adapters: [adapter], limits: { leaseMs: 500 } });
    try {
      scheduler.acquire(); expect(scheduler.job(report.jobId).state).toBe('indeterminate');
      const receipt = kernel.getActionLedgerRecord(report.idempotencyKey);
      if (stage === 'before-ledger') expect(receipt).toMatchObject({ status: 'failed', error: 'interrupted-before-completion' });
      else expect(receipt).toMatchObject({ status: 'completed' });
      const recovered = scheduler.reconcile(report.jobId);
      expect(recovered.state).toBe(stage === 'after-ledger' ? 'observed' : 'indeterminate');
      expect(adapter.inspect(recovered.input).checkpoint.effect).toBe(stage === 'after-ledger' ? 'applied' : 'unknown');
      await scheduler.drain(); expect(calls).not.toHaveBeenCalled(); expect(gateway).not.toHaveBeenCalled();
      expect(await readFile(path.join(root, 'crashed.txt'), 'utf8')).toBe('OWNED CRASH ARTIFACT\n');
      expect(journal.reservation(recovered.reservationId) === null).toBe(stage === 'after-ledger');
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); calls.mockRestore(); gateway.mockRestore(); }
  }, 20000);

  it.each(['valid', 'overwrite', 'unverified', 'wrong-hash', 'wrong-size', 'foreign-capability', 'failed', 'not-dispatched'])(
    'persists only the bounded allowlisted create receipt (%s), never raw output', async mode => {
      const s = await setup();
      try {
        const file = path.join(s.root, 'receipt-shape.json'), first = new MonarchActionLedger(4, file);
        const proposal = s.kernel.prepareActionProposal({ capabilityId: 'workspace.files.write', args: { path: path.join(s.root, 'shape.txt'), content: 'x' } });
        first.begin({ id: 'synthetic_receipt', intentId: 'synthetic_receipt', moduleId: 'workspace',
          capabilityId: mode === 'foreign-capability' ? 'workspace.files.append' : 'workspace.files.write',
          input: proposal.args, createdAt: new Date(0).toISOString(), requestedBy: 'synthetic-shape-test',
          idempotencyKey: proposal.idempotencyKey, proposalId: proposal.proposalId, proposalHash: proposal.canonicalHash, riskVector: proposal.riskVector });
        first.complete(proposal.idempotencyKey, { ok: mode !== 'failed', summary: 'Synthetic serialization fixture, not execution proof.',
          output: { path: path.join(s.root, 'shape.txt'), bytes: mode === 'wrong-size' ? 524289 : 1,
            readbackSha256: mode === 'wrong-hash' ? 'invalid' : 'a'.repeat(64), verified: mode !== 'unverified',
            createdExclusively: mode !== 'overwrite', content: 'MUST-NOT-PERSIST-CONTENT', extra: 'MUST-NOT-PERSIST-EXTRA' },
          metadata: { dispatchControl: { dispatched: mode !== 'not-dispatched' } } });
        const persisted = await readFile(file, 'utf8');
        expect(persisted).not.toContain('MUST-NOT-PERSIST');
        const restored = new MonarchActionLedger(4, file).getByIdempotencyKey(proposal.idempotencyKey);
        if (mode === 'valid') expect(restored?.result?.output).toEqual({ path: path.join(s.root, 'shape.txt'), bytes: 1,
          verified: true, createdExclusively: true, readbackSha256: 'a'.repeat(64) });
        else expect(restored?.result?.output).toBeUndefined();
        expect(s.calls).not.toHaveBeenCalled();
      } finally { await s.close(); }
    });
});
