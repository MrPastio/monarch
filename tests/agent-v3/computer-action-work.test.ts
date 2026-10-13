import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core/kernel';
import { ComputerModule, type ComputerNativeActionReceipt, type ComputerNativeObservation, type ComputerNativeProvider } from '../../src/modules/computer';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraWorkScheduler } from '../../src/agent-v3/work-scheduler';
import { AstraComputerActionWorkAdapter, type AstraComputerActionInput } from '../../src/agent-v3/computer-action-work-adapter';
import { AstraComputerActionTaskProfile } from '../../src/agent-v3/computer-action-task-profile';
import type { AstraComputerObservation, AstraComputerWindowSelection } from '../../src/agent-v3/computer-observe-work-adapter';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';

const ref = 'hwnd:0000000000000042', title = 'Astra action owned synthetic window', elementId = 'owned_editor';
const processInstanceId = 'process:' + '4'.repeat(64);
let sequence = 0;
async function setup(failNative = false, fractionalTransientTelemetry = false, durableAgency = false) {
  const parent = await realpath('.test-tmp'); expect(parent).toBe('D:\\Monarch-test-tmp-astra-v3');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-computer-action-')));
  await writeFile(path.join(root, '.fixture-marker'), 'astra-computer-action-owned-only', { flag: 'wx' });
  let observed = 0, current = true;
  const native: ComputerNativeProvider = {
    status: async () => ({ available: true }), listWindows: async () => { throw Error('enumeration-forbidden'); },
    observe: vi.fn(async (_ref, screenshotPath, _signal, selection): Promise<ComputerNativeObservation> => ({ observedAt: new Date().toISOString(), selectionBinding: selection,
      window: { windowRef: ref, processId: 42, processInstanceId, processName: 'owned', title, minimized: false, foreground: false, bounds: { x: 0, y: 0, width: 400, height: 300 } },
      screenshot: { path: screenshotPath, sha256: (++observed).toString(16).padStart(64, '0'), perceptualHash: '0'.repeat(16), width: 400, height: 300,
        captureMethod: 'synthetic', occlusionSafe: true }, stateFingerprint: 'owned-' + observed, focusedElementId: elementId, truncated: false,
      elements: [{ elementId, name: 'Owned editor', value: '', automationId: 'owned', className: 'Edit', controlType: 'Edit',
        bounds: { x: 1, y: 1, width: 200, height: 40 }, enabled: true, offscreen: false, focusable: true, focused: true, password: false, patterns: ['value'] }] })),
    act: vi.fn(async request => {
      if (failNative) throw Error('owned-native-return-lost');
      const after = await native.observe(request.windowRef, request.afterScreenshotPath, undefined, { processId: 42, processInstanceId, title });
      const action = request.action;
      const receipt: ComputerNativeActionReceipt = { dispatchedAt: new Date().toISOString(), actionKind: action.kind,
        foregroundVerified: action.kind !== 'type' || action.textMode !== 'replace', exactTargetVerified: action.kind === 'type' && action.textMode === 'replace',
        dispatchMode: action.kind === 'type' && action.textMode === 'replace' ? 'uia-semantic' : 'windows-input', inputLeaseId: request.inputLeaseId,
        controlEpoch: request.controlEpoch, cursor: { x: 20, y: 20, style: 'oscar-orange',
          nativeOverlay: true, systemCursorRestored: true, userTakeoverDetected: false, dispatchMode: action.kind === 'type' && action.textMode === 'replace' ? 'uia-semantic' : 'windows-input',
          exactTargetVerifiedAtDispatch: action.kind === 'type' && action.textMode === 'replace' }, after };
      if (action.kind === 'type') receipt.textVerification = { textMode: action.textMode ?? 'insert',
        textSha256: createHash('sha256').update(action.text).digest('hex'), valueVerifiedAfterDispatch: action.textMode === 'replace' };
      return receipt;
    }),
  };
  const computer = new ComputerModule({ monarchRoot: root, runtimeRoot: path.join(root, 'runtime'), observationRoot: path.join(root, 'observations'),
    controlStatePath: path.join(root, 'control.json'), nativeProvider: native,
    visionAnalyzer: { analyze: async () => { throw Error('vision-forbidden'); } } });
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: durableAgency ? 'agency' : false,
    permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
  kernel.registerModule(computer); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start(); computer.control.start('owned-user');
  const selection: AstraComputerWindowSelection = { id: 'owned_window', windowRef: ref, processId: 42, processInstanceId, title, expiresAt: Date.now() + 60000,
    source: { conversationId: 'owned_chat', inputMessageId: 'owned_request', userText: 'Replace the selected owned test field exactly.' } };
  const proposal = kernel.prepareActionProposal({ capabilityId: 'computer.window.observe', proposalId: 'observe_' + sequence++, args: {
    windowRef: ref, captureNonce: 'owned_action_seed', selectionBinding: { processId: 42, processInstanceId, title } }, reason: 'Owned setup observation.' },
  { requestedBy: 'user:owned-test', intentId: 'owned_observe', originatingUserText: selection.source.userText });
  const capture = await kernel.executeActionProposal(proposal, { requestedBy: 'user:owned-test', intentId: 'owned_observe', source: 'desktop',
    originatingUserText: selection.source.userText });
  expect(capture.result.ok).toBe(true); const output = capture.result.output as any;
  if (fractionalTransientTelemetry) {
    const execute = kernel.executeActionProposal.bind(kernel);
    kernel.executeActionProposal = async (...args) => {
      const returned = await execute(...args);
      if (!returned.result.ok || returned.proposal.capabilityId === 'computer.window.observe') return returned;
      return { ...returned, result: { ...returned.result, metadata: { ...returned.result.metadata,
        runtimeTelemetry: { toolLatencyMs: 1.25, verificationLatencyMs: 0.5 } } } };
    };
  }
  const observation: AstraComputerObservation = { authority: 'none', authorizesInput: false, temporalSemantics: 'snapshot-at-capture',
    observationId: output.observationId, observedAt: output.observedAt, windowRef: ref, processId: 42, processInstanceId, title,
    screenshotDigest: 'sha256:' + output.screenshot.sha256, truncated: false, omittedPasswordElements: 0,
    elements: output.elements.map((e: any) => ({ elementId: e.elementId, name: e.name, value: e.value, automationId: e.automationId,
      className: e.className, controlType: e.controlType, enabled: e.enabled, offscreen: e.offscreen, focused: e.focused })) };
  const journal = new AstraJournal(path.join(root, 'astra.sqlite'));
  const adapter = new AstraComputerActionWorkAdapter({ deployment: 'isolated-validation', kernel, journal, selection, observation,
    isSourceCurrent: () => current });
  const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'computer_action_scope', adapters: [adapter] }); scheduler.acquire();
  const submit = (action: AstraComputerActionInput['action']) => scheduler.submit({ requestId: 'action_' + sequence++, adapterId: adapter.id,
    input: { action, timeoutMs: 3000 } });
  const approve = (job: ReturnType<AstraWorkScheduler['job']>, decision: 'approve' | 'reject' = 'approve') => {
    const card = adapter.approvalCard(job.input)!;
    adapter.answer(job.input, { approvalId: card.id, approvalDigest: card.digest, reviewedInputDigest: card.inputDigest,
      conversationId: selection.source.conversationId, predecessorMessageId: selection.source.inputMessageId,
      messageId: 'answer_' + sequence++, decision }, () => scheduler.ownerIsCurrent(), journal);
    return card;
  };
  return { root, kernel, computer, native, journal, adapter, scheduler, selection, observation, submit, approve, revoke: () => { current = false; },
    close: async () => { await scheduler.close(); await kernel.stop(); journal.close(); expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe('astra-computer-action-owned-only'); await rm(root, { recursive: true }); } };
}

describe('Astra V3 approved Computer action on the shared scheduler', () => {
  it('requires an exact source-bound answer, dispatches once, and retains verified native evidence', async () => {
    const s = await setup(); try {
      const action = { kind: 'type' as const, elementId, text: '  Exact 🟠  ', textMode: 'replace' as const };
      const job = s.submit(action); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('awaiting-approval'); expect(s.native.act).not.toHaveBeenCalled();
      const card = s.approve(s.scheduler.job(job.id)); expect(card.action).toEqual(action); expect(card.source.userText).toContain('Replace');
      s.scheduler.command(job.id, 'resume'); await s.scheduler.drain(); expect(s.scheduler.job(job.id).state,
        JSON.stringify({ inspect: s.adapter.inspect(job.input), audit: s.kernel.getSnapshot().audit.slice(-8) })).toBe('observed');
      expect(s.native.act).toHaveBeenCalledTimes(1);
      expect(s.native.act).toHaveBeenCalledWith(expect.objectContaining({ expectedProcessId: 42, expectedProcessInstanceId: processInstanceId }), expect.any(AbortSignal));
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ phase: 'settled', effect: 'applied', reason: 'native-action-acknowledged',
        evidence: { beforeObservationId: card.observationId, textDigest: 'sha256:' + createHash('sha256').update(action.text).digest('hex'),
          temporalSemantics: 'acknowledged-native-action', businessCompletionCertified: false } });
      s.scheduler.reconcile(job.id); await s.scheduler.drain(); expect(s.native.act).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('certifies from the bound Action Ledger when transient telemetry contains safe finite fractions', async () => {
    const s = await setup(false, true); try {
      const action = { kind: 'type' as const, elementId, text: 'Fractional telemetry proof', textMode: 'replace' as const };
      const job = s.submit(action); await s.scheduler.drain(); s.approve(s.scheduler.job(job.id));
      s.scheduler.command(job.id, 'resume'); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('observed');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ phase: 'settled', effect: 'applied',
        reason: 'native-action-acknowledged' });
      expect(s.native.act).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('rejects forged answers and a rejection can never dispatch', async () => {
    const s = await setup(); try {
      const job = s.submit({ kind: 'click', elementId, button: 'left', clicks: 1 }); await s.scheduler.drain();
      const card = s.adapter.approvalCard(job.input)!;
      expect(() => s.adapter.answer(job.input, { approvalId: card.id, approvalDigest: card.digest, reviewedInputDigest: card.inputDigest,
        conversationId: 'wrong', predecessorMessageId: 'owned_request', messageId: 'answer_bad', decision: 'approve' },
      () => s.scheduler.ownerIsCurrent(), s.journal)).toThrow('answer-binding');
      s.approve(s.scheduler.job(job.id), 'reject'); s.scheduler.command(job.id, 'resume'); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('blocked'); expect(s.native.act).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('allows only rejection after the exact Computer approval expires', async () => {
    const s = await setup(); try {
      const job = s.submit({ kind: 'click', elementId, button: 'left', clicks: 1 }); await s.scheduler.drain();
      const card = s.adapter.approvalCard(job.input)!;
      const decision = { approvalId: card.id, approvalDigest: card.digest, reviewedInputDigest: card.inputDigest,
        conversationId: s.selection.source.conversationId, predecessorMessageId: s.selection.source.inputMessageId,
        messageId: 'expired_computer_decision' };
      const clock = vi.spyOn(Date, 'now').mockReturnValue(card.expiresAt + 1);
      try {
        expect(() => s.adapter.answer(job.input, { ...decision, decision: 'approve' }, () => true, s.journal))
          .toThrow('approval-not-current');
        s.adapter.answer(job.input, { ...decision, decision: 'reject' }, () => true, s.journal);
        expect(s.adapter.control(job.input, 'resume', () => true, s.journal))
          .toMatchObject({ state: 'blocked', reason: 'approval-rejected' });
      } finally { clock.mockRestore(); }
      expect(s.native.act).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('retains a lost native result as indeterminate and never automatically retries', async () => {
    const s = await setup(true); try {
      const job = s.submit({ kind: 'key', key: 's', modifiers: ['ctrl'] }); await s.scheduler.drain(); s.approve(s.scheduler.job(job.id));
      s.scheduler.command(job.id, 'resume'); await s.scheduler.drain(); expect(s.scheduler.job(job.id).state).toBe('indeterminate');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ phase: 'dispatching', effect: 'unknown' });
      expect(s.native.act, JSON.stringify({ inspect: s.adapter.inspect(job.input), audit: s.kernel.getSnapshot().audit.slice(-8) })).toHaveBeenCalledTimes(1);
      s.scheduler.reconcile(job.id); await s.scheduler.drain(); expect(s.native.act).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('treats a post-dispatch process-incarnation change as unknown and never retries', async () => {
    const s = await setup();
    const original = s.native.act;
    s.native.act = vi.fn(async (...args: Parameters<ComputerNativeProvider['act']>) => {
      const receipt = await original(...args);
      receipt.after!.window.processInstanceId = `process:${'5'.repeat(64)}`;
      return receipt;
    });
    try {
      const job = s.submit({ kind: 'click', elementId, button: 'left', clicks: 1 });
      await s.scheduler.drain(); s.approve(s.scheduler.job(job.id));
      s.scheduler.command(job.id, 'resume'); await s.scheduler.drain();
      expect(s.scheduler.job(job.id).state).toBe('indeterminate');
      expect(s.adapter.inspect(job.input).checkpoint).toMatchObject({ phase: 'dispatching', effect: 'unknown' });
      expect(s.native.act).toHaveBeenCalledTimes(1);
      s.scheduler.reconcile(job.id); await s.scheduler.drain(); expect(s.native.act).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('settles after restart from a privacy-safe durable receipt without a second native action', async () => {
    const s = await setup(false, false, true);
    const appendAtomic = s.journal.appendAtomic.bind(s.journal);
    let cut = true, firstOpen = true;
    const fault = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((operation, guard) => {
      const checkpoint = operation.primary.checkpoint as Record<string, unknown>;
      if (cut && operation.primary.streamId.startsWith('computer_action_') && checkpoint.phase === 'settled') {
        cut = false; throw Error('owned-after-ledger-before-astra-cut');
      }
      return appendAtomic(operation, guard);
    });
    let secondKernel: MonarchKernel | undefined, secondComputer: ComputerModule | undefined;
    let secondJournal: AstraJournal | undefined, secondScheduler: AstraWorkScheduler | undefined;
    try {
      const action = { kind: 'type' as const, elementId, text: 'Durable restart proof', textMode: 'replace' as const };
      const job = s.submit(action); await s.scheduler.drain(); s.approve(s.scheduler.job(job.id));
      s.scheduler.command(job.id, 'resume'); await s.scheduler.drain();
      expect(cut).toBe(false); expect(s.scheduler.job(job.id).state).toBe('indeterminate');
      expect(s.native.act).toHaveBeenCalledTimes(1);
      fault.mockRestore(); await s.scheduler.close(); await s.kernel.stop(); s.journal.close(); firstOpen = false;

      const secondNative: ComputerNativeProvider = { status: async () => ({ available: true }),
        listWindows: async () => { throw Error('restart-enumeration-forbidden'); },
        observe: async () => { throw Error('restart-capture-forbidden'); },
        act: vi.fn(async () => { throw Error('restart-native-action-forbidden'); }) };
      secondComputer = new ComputerModule({ monarchRoot: s.root, runtimeRoot: path.join(s.root, 'runtime-2'),
        observationRoot: path.join(s.root, 'observations-2'), controlStatePath: path.join(s.root, 'control-2.json'),
        nativeProvider: secondNative, visionAnalyzer: { analyze: async () => { throw Error('restart-vision-forbidden'); } } });
      secondKernel = new MonarchKernel({ workspaceRoot: s.root, agencyStateDirectory: 'agency',
        permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
      secondKernel.registerModule(secondComputer); secondKernel.registerModule(isolatedLocalSecurity(s.root)); await secondKernel.start();
      secondJournal = new AstraJournal(path.join(s.root, 'astra.sqlite'));
      const secondAdapter = new AstraComputerActionWorkAdapter({ deployment: 'isolated-validation', kernel: secondKernel,
        journal: secondJournal, selection: s.selection, observation: s.observation, isSourceCurrent: () => true });
      secondScheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal: secondJournal,
        scopeId: 'computer_action_scope', adapters: [secondAdapter] }); secondScheduler.acquire();
      expect(secondScheduler.job(job.id).state).toBe('indeterminate');
      const reconciled = secondScheduler.reconcile(job.id);
      expect(reconciled.state, JSON.stringify({ job: reconciled, checkpoint: secondAdapter.inspect(reconciled.input),
        ledger: secondKernel.listActionLedger(4) })).toBe('observed');
      expect(secondAdapter.inspect(secondScheduler.job(job.id).input).checkpoint).toMatchObject({ phase: 'settled', effect: 'applied',
        reason: 'native-action-acknowledged', evidence: { textDigest: 'sha256:' + createHash('sha256').update(action.text).digest('hex') } });
      expect(secondNative.act).not.toHaveBeenCalled();
      const durable = await readFile(path.join(s.root, 'agency', 'action-ledger.json'), 'utf8');
      expect(durable).not.toContain(title); expect(durable).not.toContain(action.text); expect(durable).not.toContain('elements');
    } finally {
      fault.mockRestore();
      if (secondScheduler) await secondScheduler.close().catch(() => undefined);
      if (secondKernel) await secondKernel.stop().catch(() => undefined);
      secondJournal?.close();
      if (firstOpen) { await s.scheduler.close().catch(() => undefined); await s.kernel.stop().catch(() => undefined); s.journal.close(); }
      await rm(s.root, { recursive: true, force: true });
    }
  });
  it('rejects unobserved targets and action/source changes before work or approval', async () => {
    const s = await setup(); try {
      expect(() => s.submit({ kind: 'click', elementId: 'not_observed', button: 'left', clicks: 1 })).toThrow('observed-target');
      expect(() => s.submit({ kind: 'type', elementId, text: '', textMode: 'insert' })).toThrow(expect.objectContaining({ code: 'computer-text-input-invalid' }));
      expect(s.scheduler.list()).toHaveLength(0); expect(s.native.act).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('owns approval and terminal proof in one source-authenticated Astra task profile', async () => {
    const s = await setup(); const journal = new AstraJournal(path.join(s.root, 'profile.sqlite'));
    const action = { kind: 'click' as const, elementId, button: 'left' as const, clicks: 1 as const };
    const source = { interactionId: 'app_source_owned', messageId: 'owned_request' };
    const selected = { revision: 1, digest: 'sha256:' + 'b'.repeat(64), timeoutMs: 3000,
      selection: s.selection, observation: s.observation, action };
    const profile = new AstraComputerActionTaskProfile({ deployment: 'isolated-validation', scopeId: 'computer_action_profile',
      kernel: s.kernel, journal, admission: { resolve: candidate => { expect(candidate).toEqual(source); return selected; },
        isCurrent: (candidate, value) => JSON.stringify(candidate) === JSON.stringify(source)
          && value.digest === selected.digest && value.revision === selected.revision } });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'computer_action_profile',
      adapters: [profile.adapter] }); profile.attach(scheduler); scheduler.acquire();
    try {
      const task = profile.submit({ requestId: 'owned_action_task', source }); await scheduler.drain();
      const waiting = profile.synchronize(task.taskId); expect(waiting.status).toBe('awaiting-approval');
      expect(waiting.approval).toMatchObject({ action, source: s.selection.source, grantScope: 'once', businessCompletionCertified: false });
      const card = waiting.approval!;
      const decision = { approvalId: card.id, approvalDigest: card.digest, messageId: 'owned_approval_answer', decision: 'approve' as const };
      const delegate = [...(profile as any).delegates.values()][0].adapter as AstraComputerActionWorkAdapter;
      const answer = vi.spyOn(delegate, 'answer').mockImplementationOnce(() => { throw Error('owned-after-source-binding-cut'); });
      expect(() => profile.decide(task.taskId, decision)).toThrow('owned-after-source-binding-cut');
      profile.decide(task.taskId, decision); answer.mockRestore();
      await scheduler.drain(); const finished = profile.synchronize(task.taskId);
      expect(finished).toMatchObject({ status: 'observed', proof: { effect: 'applied', nativeCompletionCertified: false,
        businessCompletionCertified: false }, message: { predecessorMessageId: source.messageId, delivery: 'pending' } });
      expect(s.native.act).toHaveBeenCalledTimes(1);
      const acknowledged = profile.acknowledgeMessage(task.taskId, finished.message!.certificateDigest);
      expect(acknowledged.message?.delivery).toBe('acknowledged');
    } finally { await scheduler.close(); journal.close(); await s.close(); }
  });
});
