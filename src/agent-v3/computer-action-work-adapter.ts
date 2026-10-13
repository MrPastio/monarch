import { createHash, randomUUID } from 'node:crypto';
import type { MonarchExecutionResult } from '../core/contracts';
import type { MonarchKernel } from '../core/kernel';
import { AstraJournalError, astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';
import type { AstraWorkAdapter, AstraWorkControl, AstraWorkResult } from './work-scheduler';
import type { AstraComputerObservation, AstraComputerWindowSelection } from './computer-observe-work-adapter';
import { validateComputerTextInput, validateComputerWindowSelection } from '../modules/computer/native-bridge';
// This existing primitive only validates a Kernel policy challenge; it has no
// file/create semantics. Reuse its format without changing existing store cohorts.
import { makeCreateApproval as makePolicyChallenge, validateCreateApproval as validatePolicyChallenge,
  createApprovalDigest as digest, type AstraCreateApproval as PolicyChallenge } from './create-approval';

export type AstraComputerAction =
  | { kind: 'type'; elementId: string; text: string; textMode: 'insert' | 'replace' }
  | { kind: 'click'; elementId: string; button: 'left' | 'right' | 'middle'; clicks: 1 | 2 }
  | { kind: 'scroll'; elementId: string; deltaY: number }
  | { kind: 'key'; key: string; modifiers: string[] }
  | { kind: 'close' };
export interface AstraComputerActionInput { action: AstraComputerAction; timeoutMs?: number; workId?: string }
interface Input extends AstraComputerActionInput { timeoutMs: number; workId: string }
export interface AstraComputerActionDecision {
  approvalId: string; approvalDigest: string; reviewedInputDigest: string;
  conversationId: string; predecessorMessageId: string; messageId: string; decision: 'approve' | 'reject';
}
export interface AstraComputerActionApprovalCard extends PolicyChallenge {
  source: AstraComputerWindowSelection['source']; action: AstraComputerAction;
  window: { windowRef: string; processId: number; title: string };
  observationId: string; screenshotDigest: string; grantScope: 'once'; businessCompletionCertified: false;
}
export interface AstraComputerActionCheckpoint {
  schemaVersion: 'monarch.astra-v3-computer-action.internal.v1'; workId: string; inputDigest: string;
  phase: 'ready' | 'dispatching' | 'awaiting-approval' | 'settled'; desired: 'run' | 'pause' | 'cancel';
  effect: 'not-applied' | 'unknown' | 'applied'; quiescent: boolean; reason?: string;
  invocation?: { proposalHash: string; idempotencyKey: string; startedAt: number };
  approval?: PolicyChallenge; answer?: { decision: AstraComputerActionDecision; receivedAt: number };
  evidence?: { actionReceiptId: string; ledgerId: string; proposalHash: string; beforeObservationId: string;
    afterObservationId?: string; screenshotDigest?: string; textDigest?: string;
    temporalSemantics: 'acknowledged-native-action'; businessCompletionCertified: false };
}
type View = { revision: number; checkpoint: AstraComputerActionCheckpoint };
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
function check(value: unknown, code: string): asserts value { if (!value) throw Error('astra-computer-action:' + code); }
const keys = (value: object, allowed: string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(k => allowed.includes(k));
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);

/** Explicit isolated effect pack on the SAME scheduler and real Kernel. The host
 * must authenticate the original source, selected observation and exact action.
 * A decision is a separate trusted-source event, never window/model text. No
 * enumeration, self-arming, permission override, auto retry or product activation.
 * Unknown actions retain the shared window resource until exact receipt recovery. */
export class AstraComputerActionWorkAdapter implements AstraWorkAdapter {
  readonly id = 'computer-action'; readonly version = 'v1';
  private readonly selection: AstraComputerWindowSelection;
  private readonly observation: AstraComputerObservation;
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly options: { deployment: 'isolated-validation'; kernel: MonarchKernel; journal: AstraJournalAccess;
    selection: AstraComputerWindowSelection; observation: AstraComputerObservation;
    isSourceCurrent: (input: AstraComputerActionInput) => boolean }) {
    check(options.deployment === 'isolated-validation', 'isolated-only');
    this.selection = structuredClone(options.selection); this.observation = structuredClone(options.observation);
    const s = this.selection, o = this.observation;
    validateComputerWindowSelection({ processId: s.processId, processInstanceId: s.processInstanceId, title: s.title });
    check(id(s.id) && /^hwnd:[0-9a-fA-F]{1,16}$/u.test(s.windowRef) && Number.isSafeInteger(s.expiresAt)
      && id(s.source?.conversationId) && id(s.source?.inputMessageId) && typeof s.source.userText === 'string'
      && s.source.userText.trim().length > 0 && Buffer.byteLength(s.source.userText) <= 8192, 'selection');
    check(o.authority === 'none' && o.authorizesInput === false && o.temporalSemantics === 'snapshot-at-capture'
      && o.windowRef === s.windowRef && o.processId === s.processId && o.title === s.title && hash(o.screenshotDigest)
      && o.processInstanceId === s.processInstanceId
      && /^computer-observation-[0-9a-f-]{36}$/u.test(o.observationId) && Number.isFinite(Date.parse(o.observedAt))
      && Array.isArray(o.elements) && o.elements.length <= 128 && Buffer.byteLength(astraJournalJson(json(o))) <= 65536, 'observation');
  }
  compile(raw: AstraJson, context: { jobId: string; scopeId: string; controlBudget: number }): ReturnType<AstraWorkAdapter['compile']> {
    const parsed = this.validate(raw), workId = 'computer_action_' + digest([context.scopeId, context.jobId]).slice(7, 39);
    check(parsed.workId === undefined || parsed.workId === workId, 'work-identity');
    const input: Input = { ...parsed, workId, timeoutMs: parsed.timeoutMs ?? 5000 };
    check(this.current(input), 'source-stale'); const commits = 24 + 4 * context.controlBudget;
    return { input: json(input), bindingDigest: this.binding(input, true), activationBudgetMs: input.timeoutMs + 1000,
      resources: { kernelSlots: 1, modelSlots: 0, declaredBytes: 8 * 1024 * 1024,
        exclusiveKeys: ['computer_window_' + digest(this.selection.windowRef).slice(7)] },
      storage: { maxActivations: 6 + 2 * context.controlBudget,
        streams: [{ streamId: workId, commits, eventBytes: commits * 1024, checkpointBytes: 32768 }] } };
  }
  async execute(raw: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult> {
    const input = this.input(raw), journal = control.journal; check(control.isCurrent(), 'activation-fenced');
    let before = this.admit(input, journal, control.ownerIsCurrent);
    if (before.checkpoint.phase !== 'ready' || before.checkpoint.desired !== 'run') return this.project(before);
    const binding = this.binding(input);
    const current = () => { try { return control.isCurrent() && this.current(input) && this.binding(input) === binding; } catch { return false; } };
    if (!current()) return this.project(this.save(input, journal, before, { ...before.checkpoint, phase: 'settled', reason: 'source-stale' }, control.ownerIsCurrent));
    const { kind, ...actionArgs } = input.action;
    const proposal = this.options.kernel.prepareActionProposal({ capabilityId: 'computer.window.' + kind, proposalId: input.workId,
      args: { ...actionArgs, windowRef: this.selection.windowRef, observationId: this.observation.observationId },
      reason: 'Astra exact source-reviewed native action; one observation, one input atom.' },
    { requestedBy: 'agent:astra-v3', intentId: input.workId, originatingUserText: this.selection.source.userText });
    const { approval, answer } = before.checkpoint;
    if (approval && (!answer || answer.decision.decision !== 'approve' || approval.proposalHash !== proposal.canonicalHash
      || Date.now() >= approval.expiresAt)) return this.project(this.save(input, journal, before,
      { ...before.checkpoint, phase: 'settled', reason: 'approval-stale' }, control.ownerIsCurrent));
    try {
      before = this.save(input, journal, before, { ...before.checkpoint, phase: 'dispatching', effect: 'unknown', quiescent: false,
        invocation: { proposalHash: proposal.canonicalHash, idempotencyKey: proposal.idempotencyKey, startedAt: Date.now() } }, current);
    } catch (error) {
      if (error instanceof AstraJournalError && error.code === 'revision-conflict') return this.project(this.required(input, journal));
      throw error;
    }
    const controller = new AbortController(); this.active.set(input.workId, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completion = this.options.kernel.executeActionProposal(proposal, { requestedBy: 'agent:astra-v3', intentId: input.workId,
      source: 'desktop', originatingUserText: this.selection.source.userText,
      signal: AbortSignal.any([control.signal, controller.signal]), dispatchGuard: current, requireExactConfirmation: true,
      ...(approval && answer ? { confirmed: true, approvalPolicyDecisionHash: approval.policyDecisionHash,
        approvalPurpose: approval.purpose, authorityTierAtApproval: approval.authorityTier } : {}) }).then(returned => {
      const fresh = this.required(input, journal);
      if (!control.ownerIsCurrent() || fresh.checkpoint.phase !== 'dispatching') return this.project(fresh);
      if (returned.proposal.canonicalHash !== fresh.checkpoint.invocation!.proposalHash)
        return this.project(this.save(input, journal, fresh, { ...fresh.checkpoint, reason: 'proposal-binding' }, control.ownerIsCurrent));
      return this.settle(input, journal, fresh, returned.result, control.ownerIsCurrent);
    }).catch(error => {
      // A Kernel rejection or a post-return evidence/persistence fault occurs
      // after effect:unknown was durably committed. Keep it unknown, expose a
      // bounded diagnostic and never let the scheduler infer a safe retry.
      let fresh = this.required(input, journal);
      if (control.ownerIsCurrent() && fresh.checkpoint.phase === 'dispatching') {
        const message = error instanceof Error ? error.message : '';
        const code = /^astra-computer-action:([a-z0-9-]{1,64})$/u.exec(message)?.[1]
          ?? (error instanceof AstraJournalError ? 'journal-' + error.code : 'settlement-failed');
        try { fresh = this.save(input, journal, fresh, { ...fresh.checkpoint, quiescent: true,
          reason: 'post-dispatch-' + code }, control.ownerIsCurrent); } catch { /* retained unknown checkpoint remains authoritative */ }
      }
      return this.project(fresh);
    }).finally(() => {
      if (this.active.get(input.workId) === controller) this.active.delete(input.workId);
    });
    try {
      return await Promise.race([completion, new Promise<AstraWorkResult>((resolve, reject) => { timer = setTimeout(() => {
        controller.abort('computer-action-deadline');
        try { resolve(this.project(this.required(input, journal))); } catch (error) { reject(error); }
      }, input.timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  /** Trusted host command only. Caller must authenticate the decision's source.
   * Write-once CAS is in the adapter's existing reserved journal stream. */
  answer(raw: AstraJson, decision: AstraComputerActionDecision, owner: () => boolean, journal: AstraJournalAccess): AstraWorkResult {
    const input = this.input(raw), before = this.required(input, journal), cp = before.checkpoint;
    this.validateDecision(decision, cp); check(owner(), 'owner-fenced');
    if (cp.answer) { check(digest(cp.answer.decision) === digest(decision), 'answer-conflict'); return this.project(before); }
    check(cp.phase === 'awaiting-approval' && cp.desired !== 'cancel'
      && (decision.decision === 'reject' || this.current(input) && Date.now() < cp.approval!.expiresAt), 'approval-not-current');
    return this.project(this.save(input, journal, before, { ...cp, answer: { decision: structuredClone(decision), receivedAt: Date.now() } }, owner));
  }
  approvalCard(raw: AstraJson): AstraComputerActionApprovalCard | undefined {
    const input = this.input(raw), cp = this.read(input, this.options.journal)?.checkpoint;
    if (!cp) return undefined;
    if (cp.phase !== 'awaiting-approval' || !cp.approval || cp.answer) return undefined;
    return { ...structuredClone(cp.approval), source: structuredClone(this.selection.source), action: structuredClone(input.action),
      window: { windowRef: this.selection.windowRef, processId: this.selection.processId, title: this.selection.title },
      observationId: this.observation.observationId, screenshotDigest: this.observation.screenshotDigest,
      grantScope: 'once' as const, businessCompletionCertified: false as const };
  }
  control(raw: AstraJson, command: 'pause' | 'resume' | 'cancel', owner: () => boolean, journal = this.options.journal): AstraWorkResult {
    const input = this.input(raw), before = this.admit(input, journal, owner), cp = before.checkpoint;
    if (command === 'resume') {
      const approvalSettlement = cp.phase === 'awaiting-approval'
        && Boolean(cp.answer || Date.now() >= cp.approval!.expiresAt);
      check(cp.quiescent && cp.effect !== 'unknown'
        && (cp.desired === 'pause' && this.current(input)
          || cp.phase === 'awaiting-approval' && (this.current(input) || approvalSettlement)), 'not-resumable');
      if (cp.phase === 'awaiting-approval') {
        check(cp.answer || Date.now() >= cp.approval!.expiresAt, 'answer-required');
        const approved = cp.answer?.decision.decision === 'approve' && Date.now() < cp.approval!.expiresAt;
        return this.project(this.save(input, journal, before, { ...cp, desired: 'run', phase: approved ? 'ready' : 'settled',
          reason: approved ? 'approval-accepted' : cp.answer?.decision.decision === 'reject' ? 'approval-rejected' : 'approval-expired' }, owner));
      }
    }
    const desired = command === 'resume' ? 'run' : command;
    if (desired !== cp.desired) this.save(input, journal, before, { ...cp, desired,
      ...(command === 'cancel' && ['ready', 'awaiting-approval'].includes(cp.phase) ? { phase: 'settled' as const, reason: 'cancelled-before-dispatch' } : {}) }, owner);
    if (command === 'cancel') this.active.get(input.workId)?.abort('computer-action-cancelled');
    return this.project(this.required(input, journal));
  }
  reconcile(raw: AstraJson, owner: () => boolean, journal = this.options.journal): AstraWorkResult {
    const input = this.input(raw), before = this.admit(input, journal, owner);
    if (before.checkpoint.phase !== 'dispatching') return this.project(before);
    const record = this.receipt(input, before.checkpoint);
    if (!record?.result || !['completed', 'failed'].includes(record.status) || record.error === 'interrupted-before-completion'
      || record.result.error === 'interrupted-before-completion') return this.project(before);
    return this.settle(input, journal, before, record.result, owner);
  }
  inspect(raw: AstraJson) { return { ...this.required(this.input(raw), this.options.journal), nativeCompletionCertified: false as const }; }
  private settle(input: Input, journal: AstraJournalAccess, before: View, result: MonarchExecutionResult, owner: () => boolean): AstraWorkResult {
    const cp = before.checkpoint, record = this.receipt(input, cp);
    const bound = !!record?.result && ['completed', 'failed'].includes(record.status)
      && (record.status === 'completed') === record.result.ok && record.result.ok === result.ok && record.result.error === result.error;
    // Action Ledger is the durable result authority. Do not hash incidental
    // fractional runtime telemetry through the integer-only Journal codec.
    // Critical effect fields below are still checked one by one.
    const retained = bound ? record!.result! : result;
    const output = retained.output as Record<string, any> | undefined;
    const dispatch = retained.metadata?.dispatchControl as { dispatched?: boolean } | undefined;
    if (retained.ok) {
      let valid = bound && record!.status === 'completed' && dispatch?.dispatched === true && output?.performed === true && output.verified === true
        && output.windowRef === this.selection.windowRef && output.beforeObservationId === this.observation.observationId
        && typeof output.actionReceiptId === 'string' && /^computer-action-[0-9a-f-]{36}$/u.test(output.actionReceiptId);
      if (input.action.kind === 'close') valid = valid && output?.closed === true;
      else valid = valid && output?.after?.verified === true && output.after.window?.windowRef === this.selection.windowRef
        && output.after.window?.processId === this.selection.processId
        && (output.after.window?.title === this.selection.title
          || output?.recoverySchemaVersion === 'monarch.computer-action-recovery-output.v1'
            && output.after.window?.titleDigest === utf8Digest(this.selection.title))
        && output.after.window?.processInstanceId === this.selection.processInstanceId
        && typeof output.afterObservationId === 'string' && /^computer-observation-[0-9a-f-]{36}$/u.test(output.afterObservationId)
        && output.after.observationId === output.afterObservationId && /^[a-f0-9]{64}$/u.test(output.after.screenshot?.sha256)
        && Date.parse(output.after.observedAt) >= cp.invocation!.startedAt && Date.parse(output.after.observedAt) <= Date.now() + 1000;
      if (input.action.kind === 'type') valid = valid && output?.textVerification?.textMode === input.action.textMode
        && output.textVerification.textSha256 === createHash('sha256').update(input.action.text).digest('hex')
        && output.textVerification.valueVerifiedAfterDispatch === (input.action.textMode === 'replace');
      if (!valid || !cp.approval || cp.answer?.decision.decision !== 'approve')
        return this.project(this.save(input, journal, before, { ...cp, quiescent: true, reason: 'native-evidence-binding' }, owner));
      return this.project(this.save(input, journal, before, { ...cp, phase: 'settled', effect: 'applied', quiescent: true, reason: 'native-action-acknowledged',
        evidence: { actionReceiptId: output!.actionReceiptId, ledgerId: record!.ledgerId, proposalHash: cp.invocation!.proposalHash,
          beforeObservationId: this.observation.observationId, ...(input.action.kind === 'close' ? {} : {
            afterObservationId: output!.afterObservationId, screenshotDigest: 'sha256:' + output!.after.screenshot.sha256 }),
          ...(input.action.kind === 'type' ? { textDigest: 'sha256:' + output!.textVerification.textSha256 } : {}),
          temporalSemantics: 'acknowledged-native-action', businessCompletionCertified: false } }, owner));
    }
    if (!record && !cp.approval && cp.desired !== 'cancel' && dispatch?.dispatched !== true) {
      const approval = makePolicyChallenge(result, { workId: input.workId, inputDigest: cp.inputDigest,
        proposalHash: cp.invocation!.proposalHash, expiresAt: Math.min(this.selection.expiresAt, Date.now() + 90000) });
      if (approval) return this.project(this.save(input, journal, before, { ...cp, phase: 'awaiting-approval', effect: 'not-applied', quiescent: true,
        approval, reason: 'confirmation-required' }, owner));
    }
    const native = retained.metadata?.computerDispatch as { phase?: string; mayHaveDispatched?: boolean; nativePreflightRejected?: boolean } | undefined;
    const nativeNoInput = bound && output?.performed === false && native?.mayHaveDispatched === false
      && (['before-native', 'prepared'].includes(native.phase ?? '') || native.phase === 'native-entered' && native.nativePreflightRejected === true);
    const noInput = !record && dispatch?.dispatched === false || nativeNoInput;
    return this.project(this.save(input, journal, before, { ...cp, phase: noInput ? 'settled' : 'dispatching',
      effect: noInput ? 'not-applied' : 'unknown', quiescent: true,
      reason: /^[a-z0-9-]{1,96}$/u.test(retained.error ?? '') ? retained.error! : 'kernel-failed' }, owner));
  }
  private receipt(input: Input, cp: AstraComputerActionCheckpoint) {
    check(cp.invocation, 'invocation-required'); const record = this.options.kernel.getActionLedgerRecord(cp.invocation.idempotencyKey);
    if (record) check(record.proposalId === input.workId && record.intentId === input.workId && record.proposalHash === cp.invocation.proposalHash
      && record.idempotencyKey === cp.invocation.idempotencyKey && record.moduleId === 'computer'
      && record.capabilityId === 'computer.window.' + input.action.kind, 'receipt-binding'); return record;
  }
  private validate(raw: AstraJson): AstraComputerActionInput {
    check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every(k => ['action', 'timeoutMs', 'workId'].includes(k)), 'input');
    const input = JSON.parse(astraJournalJson(raw)) as AstraComputerActionInput, a = input.action;
    check(a && typeof a === 'object' && !Array.isArray(a), 'action');
    if (a.kind === 'type') { check(keys(a, ['kind', 'elementId', 'text', 'textMode']), 'action-fields'); validateComputerTextInput(a.text, a.textMode); }
    else if (a.kind === 'click') check(keys(a, ['kind', 'elementId', 'button', 'clicks']) && ['left', 'right', 'middle'].includes(a.button) && [1, 2].includes(a.clicks), 'click');
    else if (a.kind === 'scroll') check(keys(a, ['kind', 'elementId', 'deltaY']) && Number.isSafeInteger(a.deltaY) && a.deltaY !== 0 && Math.abs(a.deltaY) <= 1200, 'scroll');
    else if (a.kind === 'key') {
      const capability = this.options.kernel.listCapabilities().find(c => c.id === 'computer.window.key');
      const allowed = (capability?.inputSchema as any)?.properties?.key?.enum;
      check(keys(a, ['kind', 'key', 'modifiers']) && Array.isArray(allowed) && allowed.includes(a.key)
        && Array.isArray(a.modifiers) && a.modifiers.length <= 3 && new Set(a.modifiers).size === a.modifiers.length
        && a.modifiers.every(m => ['ctrl', 'alt', 'shift'].includes(m)), 'key');
    } else check(a.kind === 'close' && keys(a, ['kind']), 'action-kind');
    if ('elementId' in a) {
      check(typeof a.elementId === 'string' && a.elementId.length >= 2 && a.elementId.length <= 100, 'element');
      const matches = this.observation.elements.filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.elementId === a.elementId) as Record<string, AstraJson>[];
      check(matches.length === 1 && matches[0]!.enabled === true && matches[0]!.offscreen === false && matches[0]!.password !== true, 'observed-target');
    }
    check(input.timeoutMs === undefined || Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 50 && input.timeoutMs <= 10000, 'timeout');
    return input;
  }
  private input(raw: AstraJson): Input { const input = this.validate(raw); check(id(input.workId) && input.timeoutMs !== undefined, 'compiled-input'); return input as Input; }
  private current(input: Input): boolean { try { return Date.now() < this.selection.expiresAt && this.options.isSourceCurrent(structuredClone(input)) === true; } catch { return false; } }
  private binding(input: Input, admission = false): string {
    const capability = this.options.kernel.listCapabilities().find(c => c.id === 'computer.window.' + input.action.kind);
    const readiness = this.options.kernel.getCapabilityReadiness('computer.window.' + input.action.kind);
    check(capability?.moduleId === 'computer' && capability.risk === 'device-control' && readiness?.status === 'active', 'capability-unavailable');
    return digest({ selection: this.selection, observation: this.observation, version: this.version, capability,
      readiness: admission ? { capabilityId: readiness.capabilityId, moduleId: readiness.moduleId, moduleVersion: readiness.moduleVersion, status: readiness.status } : readiness });
  }
  private inputDigest(input: Input): string { return digest([this.selection, this.observation, input]); }
  private validateDecision(d: AstraComputerActionDecision, cp: AstraComputerActionCheckpoint): void {
    check(d && keys(d, ['approvalId', 'approvalDigest', 'reviewedInputDigest', 'conversationId', 'predecessorMessageId', 'messageId', 'decision'])
      && cp.approval && d.approvalId === cp.approval.id && d.approvalDigest === cp.approval.digest && d.reviewedInputDigest === cp.inputDigest
      && d.conversationId === this.selection.source.conversationId && d.predecessorMessageId === this.selection.source.inputMessageId
      && id(d.messageId) && d.messageId !== d.predecessorMessageId && ['approve', 'reject'].includes(d.decision), 'answer-binding');
  }
  private admit(input: Input, journal: AstraJournalAccess, owner: () => boolean): View {
    return this.read(input, journal) ?? this.save(input, journal, { revision: 0 }, { schemaVersion: 'monarch.astra-v3-computer-action.internal.v1',
      workId: input.workId, inputDigest: this.inputDigest(input), phase: 'ready', desired: 'run', effect: 'not-applied', quiescent: true }, owner);
  }
  private read(input: Input, journal: AstraJournalAccess): View | undefined {
    const view = journal.read(input.workId); if (!view) return undefined; const cp = view.checkpoint as unknown as AstraComputerActionCheckpoint;
    check(cp.schemaVersion === 'monarch.astra-v3-computer-action.internal.v1' && cp.workId === input.workId && cp.inputDigest === this.inputDigest(input)
      && ['ready', 'dispatching', 'awaiting-approval', 'settled'].includes(cp.phase) && ['run', 'pause', 'cancel'].includes(cp.desired)
      && ['not-applied', 'unknown', 'applied'].includes(cp.effect) && typeof cp.quiescent === 'boolean', 'checkpoint-binding');
    if (cp.invocation) check(/^[a-f0-9]{64}$/u.test(cp.invocation.proposalHash) && /^action:[a-f0-9]{64}$/u.test(cp.invocation.idempotencyKey)
      && Number.isSafeInteger(cp.invocation.startedAt), 'invocation-binding');
    check(cp.phase !== 'dispatching' || cp.invocation && cp.effect === 'unknown', 'dispatch-state');
    if (cp.approval) { validatePolicyChallenge(cp.approval); check(cp.approval.workId === input.workId && cp.approval.inputDigest === cp.inputDigest
      && cp.approval.proposalHash === cp.invocation?.proposalHash, 'approval-binding'); }
    if (cp.answer) { this.validateDecision(cp.answer.decision, cp); check(Number.isSafeInteger(cp.answer.receivedAt)
      && cp.answer.receivedAt > 0 && (cp.answer.decision.decision === 'reject'
        || cp.answer.receivedAt < cp.approval!.expiresAt), 'answer-time'); }
    check(cp.phase !== 'awaiting-approval' || cp.approval && cp.effect === 'not-applied' && cp.quiescent, 'approval-state');
    const evidence = cp.evidence;
    check(cp.effect !== 'applied' || cp.phase === 'settled' && cp.quiescent && cp.answer?.decision.decision === 'approve'
      && evidence?.proposalHash === cp.invocation?.proposalHash && evidence?.beforeObservationId === this.observation.observationId
      && evidence?.temporalSemantics === 'acknowledged-native-action' && evidence?.businessCompletionCertified === false, 'evidence-state');
    return { revision: view.revision, checkpoint: cp };
  }
  private required(input: Input, journal: AstraJournalAccess): View { const view = this.read(input, journal); check(view, 'checkpoint-missing'); return view; }
  private save(input: Input, journal: AstraJournalAccess, before: { revision: number }, checkpoint: AstraComputerActionCheckpoint, owner: () => boolean): View {
    check(owner(), 'owner-fenced'); journal.append({ streamId: input.workId, requestId: 'computer_action_' + randomUUID(), expectedRevision: before.revision,
      checkpoint: json(checkpoint), events: [{ type: 'computer-action.' + checkpoint.phase, effect: checkpoint.effect, desired: checkpoint.desired, quiescent: checkpoint.quiescent }] });
    return this.required(input, journal);
  }
  private project(view: View): AstraWorkResult {
    const cp = view.checkpoint;
    const state = !cp.quiescent || cp.effect === 'unknown' ? cp.desired === 'cancel' ? 'cancelling' : cp.desired === 'pause' ? 'pausing' : 'indeterminate'
      : cp.desired === 'cancel' ? 'cancelled' : cp.desired === 'pause' ? 'paused' : cp.phase === 'ready' ? 'queued'
      : cp.phase === 'awaiting-approval' ? 'awaiting-approval' : cp.effect === 'applied' ? 'observed' : 'blocked';
    return { state, checkpointRef: cp.workId, checkpointRevision: view.revision, progressDigest: digest(cp), ...(cp.reason ? { reason: cp.reason } : {}) };
  }
}

function utf8Digest(value: string): string { return 'sha256:' + createHash('sha256').update(value, 'utf8').digest('hex'); }
