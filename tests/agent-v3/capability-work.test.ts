import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AstraCapabilityWorkAdapter, type AstraCapabilityWorkInput } from '../../src/agent-v3/capability-work-adapter';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraWorkScheduler } from '../../src/agent-v3/work-scheduler';
import { MonarchKernel } from '../../src/core/kernel';
import { WorkspaceModule } from '../../src/modules/workspace';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';

let parent: string, fixture: string, sequence = 0;
beforeAll(async () => {
  parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  fixture = await realpath(await mkdtemp(path.join(parent, 'astra-capability-work-')));
  await writeFile(path.join(fixture, '.fixture-marker'), 'astra-v3-capability-work-synthetic-only', { flag: 'wx' });
});
afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: false }); });

async function setup(options: { current?: () => boolean; allow?: (capabilityId: string) => boolean; ownerDirect?: boolean } = {}) {
  const root = path.join(fixture, 'workspace_' + sequence++); await mkdir(root);
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' },
    ...(options.ownerDirect ? { authorityContext: { tier: 'owner' as const, source: 'signed-device-entitlement' as const,
      entitlementId: 'owner_capability_work_test', keyId: 'owner-capability-test', verifiedAt: new Date(0).toISOString(),
      deviceIdPrefix: '0123456789ab', diagnostic: null } } : {}) });
  kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] }));
  kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
  if (options.ownerDirect) await kernel.emitRuntimeEvent('security.owner_override.changed', 'security', {
    ownerOverride: { enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' },
  });
  const journal = new AstraJournal(':memory:'), scopeId = 'capability_scope_' + sequence++;
  const adapter = new AstraCapabilityWorkAdapter({ deployment: 'isolated-validation', journal, kernel,
    isSourceCurrent: input => (options.current?.() ?? true) && input.source.taskId === 'task_owned',
    isCapabilityAllowed: capability => options.allow?.(capability.id) ?? capability.id === 'workspace.root.get' });
  const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId, adapters: [adapter] });
  scheduler.acquire();
  const gateway = vi.spyOn(kernel, 'executeActionProposal');
  const input: AstraCapabilityWorkInput = { capabilityId: 'workspace.root.get', args: {}, modelId: 'fixture/model',
    source: { taskId: 'task_owned', interactionId: 'interaction_owned', messageId: 'message_owned', revision: 1,
      userText: 'Inspect the exact workspace root.', surface: 'desktop' } };
  return { root, kernel, journal, adapter, scheduler, gateway, input,
    submit: (requestId = 'capability_' + sequence++, override: Partial<AstraCapabilityWorkInput> = {}) => scheduler.submit({
      requestId, adapterId: adapter.id, input: { ...input, ...override } as unknown as import('../../src/agent-v3/journal').AstraJson,
    }),
    close: async () => { await scheduler.close(); await kernel.stop(); journal.close(); gateway.mockRestore(); } };
}

describe('Astra V3 generic capability work', () => {
  it('dispatches one exact model-owned capability through Kernel and retains only a receipt-bound observation', async () => {
    const s = await setup();
    try {
      const job = s.submit(); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('observed');
      const view = s.adapter.inspect(job.input);
      expect(view).toMatchObject({ nativeCompletionCertified: false, checkpoint: { phase: 'settled', effect: 'acknowledged',
        observation: { authority: 'kernel-receipt', temporalSemantics: 'acknowledged-after-dispatch',
          result: { ok: true, output: { workspaceRoot: s.root } } } } });
      expect(s.gateway).toHaveBeenCalledTimes(1);
      expect(s.gateway.mock.calls[0]?.[0]).toMatchObject({ capabilityId: 'workspace.root.get', proposalId: job.input.workId,
        provenance: { source: 'model-tool-call', model: 'fixture/model' } });
      expect(s.gateway.mock.calls[0]?.[1]).toMatchObject({ requestedBy: 'agent:task_owned', intentId: 'task_owned',
        source: 'desktop', executionMode: 'agent-runtime' });
      await s.scheduler.drain(); expect(s.scheduler.reconcile(job.id).state).toBe('observed');
      expect(s.gateway).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('accepts the Coder 20 KiB source contract instead of applying the old 8 KiB capability ceiling', async () => {
    const s = await setup();
    try {
      const userText = 'я'.repeat(5000); expect(Buffer.byteLength(userText)).toBe(10_000);
      const job = s.submit('coder_long_source', { source: { ...s.input.source, surface: 'coder', userText } });
      expect(job.state).toBe('queued');
      expect(s.scheduler.command(job.id, 'cancel').state).toBe('cancelled');
      expect(s.gateway).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('rejects unadmitted capabilities and stale authenticated sources before Kernel dispatch', async () => {
    let current = true; const s = await setup({ current: () => current });
    try {
      expect(() => s.submit('denied_capability', { capabilityId: 'workspace.files.write', args: { path: 'x', content: 'x' } }))
        .toThrow('capability-not-admitted');
      const job = s.submit('stale_source'); current = false; await s.scheduler.drain();
      expect(s.scheduler.job(job.id)).toMatchObject({ state: 'blocked', reason: 'adapter-readiness-unavailable' });
      expect(s.gateway).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('reconciles a lost adapter return from the exact Action Ledger receipt without redispatch', async () => {
    const s = await setup();
    try {
      const actual = MonarchKernel.prototype.executeActionProposal.bind(s.kernel);
      s.gateway.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('synthetic-return-loss'); });
      const job = s.submit('return_loss'); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('indeterminate'); expect(s.gateway).toHaveBeenCalledTimes(1);
      expect(s.scheduler.reconcile(job.id).state).toBe('observed'); expect(s.gateway).toHaveBeenCalledTimes(1);
      expect(s.adapter.inspect(job.input).checkpoint.observation?.result.ok).toBe(true);
    } finally { await s.close(); }
  });

  it('reports an action cut off by a process exit as a failure with unknown outcome, never redispatching it', async () => {
    // Held as indeterminate, such an action froze the whole task until its
    // deadline (hours) after a crash.
    const s = await setup();
    try {
      const actual = MonarchKernel.prototype.executeActionProposal.bind(s.kernel);
      s.gateway.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('synthetic-process-exit'); });
      const job = s.submit('interrupted_action'); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('indeterminate');
      // What a restart leaves in the ledger for an action that was executing.
      const records = (s.kernel as unknown as { actionLedger: { records: Map<string, any> } }).actionLedger.records;
      for (const record of records.values()) {
        record.status = 'failed'; record.error = 'interrupted-before-completion';
        record.result = { ok: false, summary: 'Action was interrupted before completion.', error: 'interrupted-before-completion' };
      }
      // No longer indeterminate: dispatched, result unconfirmed (partial), and the reason is what the agent sees.
      const settled = s.scheduler.reconcile(job.id);
      expect(settled.state).toBe('partial');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ phase: 'settled', reason: 'interrupted-before-completion' });
      expect(s.adapter.inspect(job.input).checkpoint.observation).toBeUndefined();
      expect(s.gateway).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('observes a repeated effect through its Kernel replay and re-reads a repeated read', async () => {
    // Live: a DeepSeek agent repeated mkdir, Kernel replayed the first receipt,
    // and the receipt-binding throw made the host retire the whole task.
    const s = await setup({ ownerDirect: true, allow: id => ['workspace.files.mkdir', 'workspace.root.get'].includes(id) });
    try {
      const args = { path: path.join(s.root, 'src', 'core') };
      const first = s.submit('mkdir_first', { capabilityId: 'workspace.files.mkdir', args });
      await s.scheduler.drain();
      const second = s.submit('mkdir_repeat', { capabilityId: 'workspace.files.mkdir', args });
      await s.scheduler.drain();
      expect(s.scheduler.job(first.id).state).toBe('observed');
      expect(s.scheduler.job(second.id).state).toBe('observed');
      const ledgerOf = (job: typeof first) => s.adapter.inspect(job.input).checkpoint.observation?.ledgerId;
      expect(ledgerOf(second)).toBe(ledgerOf(first));
      const readA = s.submit('read_first'); await s.scheduler.drain();
      const readB = s.submit('read_repeat'); await s.scheduler.drain();
      expect(s.scheduler.job(readB.id).state).toBe('observed');
      expect(ledgerOf(readB)).not.toBe(ledgerOf(readA));
    } finally { await s.close(); }
  });
  it('carries persistent Owner Direct Access into a real model-owned workspace effect', async () => {
    const s = await setup({ ownerDirect: true, allow: id => id === 'workspace.files.write' });
    try {
      const target = path.join(s.root, 'direct-result.txt');
      const job = s.submit('direct_write', { capabilityId: 'workspace.files.write',
        args: { path: target, content: 'Astra V3 direct effect', overwrite: false } });
      await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state, JSON.stringify(s.kernel.getSnapshot().audit.slice(-8))).toBe('observed');
      expect(await readFile(target, 'utf8')).toBe('Astra V3 direct effect');
      expect(s.adapter.inspect(job.input).checkpoint.observation?.result.ok).toBe(true);
      expect(s.gateway).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('holds one exact Security warning and resumes the same capability only after a bound decision', async () => {
    const s = await setup({ allow: id => id === 'workspace.files.write' });
    try {
      const target = path.join(s.root, 'reviewed-result.txt');
      const job = s.submit('reviewed_write', { capabilityId: 'workspace.files.write',
        args: { path: target, content: 'reviewed Astra V3 effect', overwrite: false } });
      await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('awaiting-approval');
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const card = s.adapter.approvalCard(job.input)!;
      expect(card).toMatchObject({ capability: { id: 'workspace.files.write', risk: 'write' },
        args: { path: target, content: 'reviewed Astra V3 effect' }, grantScope: 'once', nativeCompletionCertified: false });
      s.adapter.answer(job.input, { approvalId: card.id, approvalDigest: card.digest,
        messageId: 'approval_message', decision: 'approve' }, () => s.scheduler.ownerIsCurrent());
      expect(s.scheduler.command(job.id, 'resume').state).toBe('queued');
      await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('observed');
      expect(await readFile(target, 'utf8')).toBe('reviewed Astra V3 effect');
      expect(s.gateway).toHaveBeenCalledTimes(2);
    } finally { await s.close(); }
  });

  it('keeps an expired Security card rejectable without making its approval executable', async () => {
    const s = await setup({ allow: id => id === 'workspace.files.write' });
    try {
      const target = path.join(s.root, 'expired-review.txt');
      const job = s.submit('expired_review', { capabilityId: 'workspace.files.write',
        args: { path: target, content: 'must never be written', overwrite: false } });
      await s.scheduler.drain();
      const card = s.adapter.approvalCard(job.input)!;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(card.expiresAt + 1);
      try {
        expect(() => s.adapter.answer(job.input, { approvalId: card.id, approvalDigest: card.digest,
          messageId: 'expired_approval', decision: 'approve' }, () => true)).toThrow('approval-not-current');
        s.adapter.answer(job.input, { approvalId: card.id, approvalDigest: card.digest,
          messageId: 'expired_rejection', decision: 'reject' }, () => true);
        expect(s.adapter.control(job.input, 'resume', () => true)).toMatchObject({ state: 'blocked', reason: 'approval-rejected' });
      } finally { clock.mockRestore(); }
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(s.gateway).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
});
