import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { MonarchKernel } from '../core/kernel';
import type { MonarchActionLedgerRecord, MonarchExecutionResult } from '../core/contracts';
import { AstraJournalError, astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';
import type { AstraWorkAdapter, AstraWorkControl, AstraWorkResult } from './work-scheduler';
import { makeCreateApproval, validateCreateApproval, createApprovalDigest,
  type AstraCreateApproval, type AstraCreateApprovalAnswer } from './create-approval';

export interface AstraCreateWorkInput {
  basename: string; content: string; timeoutMs?: number; workId?: string;
  requireExactConfirmation?: true;
  /** Supplied and authenticated by the host source port, NEVER synthesized from
   * the desired tool or substituted with a model's statement of user intent. */
  source: { interactionId: string; messageId: string; revision: number; userText: string };
}
interface CompiledInput extends AstraCreateWorkInput { workId: string; timeoutMs: number }
export interface AstraCreateWorkCheckpoint {
  schemaVersion: 'monarch.astra-v3-create-work.internal.v1'; workId: string; inputDigest: string;
  phase: 'ready' | 'dispatching' | 'awaiting-approval' | 'settled'; desired: 'run' | 'pause' | 'cancel'; quiescent: boolean;
  effect: 'not-applied' | 'applied' | 'unknown';
  invocation?: { proposalHash: string; idempotencyKey: string };
  observation?: { bytes: number; contentDigest: string; targetDigest: string; proposalHash: string; ledgerId: string;
    temporalSemantics: 'snapshot-after-create' };
  reason?: string;
  approval?: AstraCreateApproval;
  approvalAnswerDigest?: string;
}
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown): boolean => astraJournalJson(json(a)) === astraJournalJson(json(b));
const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-create:' + code); }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
export const astraCreateWorkId = (scopeId: string, jobId: string): string => 'create_work_' + sha(scopeId + '/' + jobId).slice(7, 39);
export const astraCreateInputDigest = (root: string, input: AstraCreateWorkInput): string =>
  sha(astraJournalJson(json({ root: path.resolve(root).toLowerCase(), input })));
export const astraCreateSelectionDigest = (input: AstraCreateWorkInput): string =>
  sha(astraJournalJson(json({ basename: input.basename, content: input.content, timeoutMs: input.timeoutMs ?? 5000, source: input.source,
    ...(input.requireExactConfirmation === true ? { requireExactConfirmation: true } : {}) })));

/** First effect pack on the COMMON scheduler. Host-selected bounded text, one leaf
 * in an already existing isolated root, exclusive create, no overwrite/mkdir/delete.
 * Kernel owns policy, dispatch, mutation journal and readback. A failed/cancelled
 * module is NOT evidence that no effect occurred; unknown outcomes are never retried.
 * This is neither product source authentication nor a native completion certificate.
 */
export class AstraCreateWorkAdapter implements AstraWorkAdapter {
  readonly id = 'workspace-create'; readonly version: 'v1' | 'v2';
  private readonly root: string;
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly options: { deployment: 'isolated-validation'; canonicalRoot: string;
    kernel: MonarchKernel; journal: AstraJournalAccess; isSourceCurrent: (input: AstraCreateWorkInput) => boolean;
    approvalPort?: { deadline(input: AstraCreateWorkInput): number;
      answer(input: AstraCreateWorkInput, challenge: AstraCreateApproval): AstraCreateApprovalAnswer | undefined } }) {
    check(options.deployment === 'isolated-validation' && path.isAbsolute(options.canonicalRoot), 'isolated-root');
    this.root = path.resolve(options.canonicalRoot);
    this.version = options.approvalPort ? 'v2' : 'v1';
  }

  compile(raw: AstraJson, context: { jobId: string; scopeId: string; controlBudget: number }): ReturnType<AstraWorkAdapter['compile']> {
    const input = this.validate(raw);
    const workId = astraCreateWorkId(context.scopeId, context.jobId);
    check(input.workId === undefined || input.workId === workId, 'identity-owner');
    const normalized: CompiledInput = { ...input, workId, timeoutMs: input.timeoutMs ?? 5000 };
    check(this.current(normalized), 'source-stale');
    const encoded = astraJournalJson(json(normalized)); check(Buffer.byteLength(encoded) <= 65536, 'input-budget');
    const commits = 24 + 4 * context.controlBudget;
    return { input: json(normalized), bindingDigest: this.binding('admission'),
      resources: { kernelSlots: 1, modelSlots: 0,
        declaredBytes: 1024 * 1024 + 4 * Buffer.byteLength(input.content) + Buffer.byteLength(encoded),
        exclusiveKeys: ['file_' + sha(this.targetName(input).toLowerCase()).slice(7)] },
      storage: { maxActivations: 8 + 2 * context.controlBudget,
        streams: [{ streamId: workId, commits, eventBytes: commits * 4096, checkpointBytes: this.options.approvalPort ? 32768 : 8192 }] } };
  }

  async execute(raw: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult> {
    const input = this.input(raw), journal = control.journal;
    check(control.isCurrent(), 'activation-fenced');
    let before = this.admit(input, journal, control.ownerIsCurrent);
    if (before.checkpoint.phase !== 'ready' || before.checkpoint.desired !== 'run') return this.project(before);
    const initialRevision = before.revision, binding = this.binding();
    const current = (): boolean => {
      try { return control.isCurrent() && this.current(input) && this.binding() === binding; } catch { return false; }
    };
    if (!current()) return this.project(this.save(input, journal, before,
      { ...before.checkpoint, phase: 'settled', reason: 'source-stale' }, control.ownerIsCurrent));
    try {
      await this.preflight(input);
    } catch (error) {
      const fresh = this.required(input, journal);
      if (!control.ownerIsCurrent() || fresh.revision !== initialRevision) return this.project(fresh);
      const reason = error instanceof Error && error.message.startsWith('astra-create:') ? error.message.slice(13) : 'target-unavailable';
      return this.project(this.save(input, journal, fresh, { ...fresh.checkpoint, phase: 'settled', reason }, control.ownerIsCurrent));
    }
    if (!current()) return this.project(this.required(input, journal));
    const proposal = this.options.kernel.prepareActionProposal({ capabilityId: 'workspace.files.write', proposalId: input.workId,
      args: { path: this.targetName(input), content: input.content, overwrite: false },
      reason: 'Astra V3 isolated host-selected exclusive file creation.' }, { requestedBy: 'agent:astra-v3', intentId: input.workId,
      originatingUserText: input.source.userText });
    const approval = before.checkpoint.approval;
    const answer = approval ? this.options.approvalPort?.answer(input, approval) : undefined;
    if (approval && (!answer || answer.decision.decision !== 'approve'
      || before.checkpoint.approvalAnswerDigest !== createApprovalDigest(answer)
      || approval.proposalHash !== proposal.canonicalHash || Date.now() >= approval.expiresAt)) {
      return this.project(this.save(input, journal, before, { ...before.checkpoint, phase: 'settled', reason: 'approval-stale' }, current));
    }
    try {
      // Distinct command identity + expectedRevision selects ONE dispatcher, not
      // same-command replay. Reservation is durable before any Kernel invocation.
      before = this.save(input, journal, before, { ...before.checkpoint, phase: 'dispatching', quiescent: false, effect: 'unknown',
        invocation: { proposalHash: proposal.canonicalHash, idempotencyKey: proposal.idempotencyKey } }, current);
    } catch (error) {
      if (error instanceof AstraJournalError && error.code === 'revision-conflict') return this.project(this.required(input, journal));
      throw error;
    }
    const controller = new AbortController(); this.active.set(input.workId, controller);
    const signal = AbortSignal.any([control.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completion = this.options.kernel.executeActionProposal(proposal, {
      requestedBy: 'agent:astra-v3', intentId: input.workId, source: 'desktop', signal, dispatchGuard: current,
      originatingUserText: input.source.userText,
      ...(input.requireExactConfirmation === true ? { requireExactConfirmation: true as const } : {}),
      // Only a retained source-bound exact answer can set these Kernel fields.
      // No security override, broad lease, permission override or rewritten text.
      ...(approval && answer ? { confirmed: true, approvalPolicyDecisionHash: approval.policyDecisionHash,
        approvalPurpose: approval.purpose, authorityTierAtApproval: approval.authorityTier } : {}),
    }).then(returned => {
      const fresh = this.required(input, journal);
      if (!control.ownerIsCurrent() || fresh.checkpoint.phase !== 'dispatching') return this.project(fresh);
      if (returned.proposal.canonicalHash !== proposal.canonicalHash) {
        return this.project(this.save(input, journal, fresh, { ...fresh.checkpoint, reason: 'proposal-binding' }, control.ownerIsCurrent));
      }
      return this.settle(input, journal, fresh, returned.result, control.ownerIsCurrent);
    }, () => {
      const fresh = this.required(input, journal);
      if (!control.ownerIsCurrent() || fresh.checkpoint.phase !== 'dispatching') return this.project(fresh);
      return this.project(this.save(input, journal, fresh, { ...fresh.checkpoint, reason: 'kernel-return-unavailable' }, control.ownerIsCurrent));
    }).finally(() => { if (this.active.get(input.workId) === controller) this.active.delete(input.workId); });
    try {
      const expired = new Promise<AstraWorkResult>((resolve, reject) => { timer = setTimeout(() => {
        controller.abort('create-deadline');
        try { resolve(this.project(this.required(input, journal))); } catch (error) { reject(error); }
      }, input.timeoutMs); });
      return await Promise.race([completion, expired]);
    } finally { if (timer) clearTimeout(timer); }
    // If the deadline wins, completion still captures a late acknowledged fact.
    // Unknown effect never becomes ready and no automatic create retry exists.
  }

  control(raw: AstraJson, command: 'pause' | 'resume' | 'cancel', owner: () => boolean, journal = this.options.journal): AstraWorkResult {
    const input = this.input(raw), before = this.admit(input, journal, owner), cp = before.checkpoint;
    if (command === 'resume') {
      const approvalAnswer = cp.phase === 'awaiting-approval' && cp.approval
        ? this.options.approvalPort?.answer(input, cp.approval) : undefined;
      const approvalSettlement = cp.phase === 'awaiting-approval' && cp.approval
        && Boolean(approvalAnswer || Date.now() >= cp.approval.expiresAt);
      check(cp.quiescent && cp.effect !== 'unknown'
        && (cp.desired === 'pause' && this.current(input)
          || cp.phase === 'awaiting-approval' && (this.current(input) || approvalSettlement)), 'not-resumable');
      if (cp.phase === 'awaiting-approval' && cp.approval) {
        const answer = approvalAnswer;
        if (answer || Date.now() >= cp.approval.expiresAt) return this.project(this.save(input, journal, before, { ...cp, desired: 'run',
          phase: answer?.decision.decision === 'approve' && Date.now() < cp.approval.expiresAt ? 'ready' : 'settled',
          ...(answer ? { approvalAnswerDigest: createApprovalDigest(answer) } : {}),
          reason: answer?.decision.decision === 'reject' ? 'approval-rejected'
            : Date.now() >= cp.approval.expiresAt ? 'approval-expired' : 'approval-accepted' }, owner));
      }
    }
    const desired = command === 'resume' ? 'run' : command;
    if (desired !== cp.desired) this.save(input, journal, before, { ...cp, desired,
      ...(command === 'cancel' && ['ready', 'awaiting-approval'].includes(cp.phase) ? { phase: 'settled', reason: 'cancelled-before-dispatch' } as const : {}) }, owner);
    if (command === 'cancel') this.active.get(input.workId)?.abort('create-cancelled');
    return this.project(this.required(input, journal));
  }

  reconcile(raw: AstraJson, owner: () => boolean, journal = this.options.journal): AstraWorkResult {
    const input = this.input(raw), before = this.admit(input, journal, owner);
    if (before.checkpoint.phase !== 'dispatching') return this.project(before);
    const record = this.receipt(input, before.checkpoint);
    if (!record || !record.result || !['completed', 'failed'].includes(record.status)
      || record.error === 'interrupted-before-completion' || record.result.error === 'interrupted-before-completion') return this.project(before);
    check((record.status === 'completed') === record.result.ok, 'receipt-status');
    // Exact retained receipt only. Existing file bytes alone cannot prove which
    // actor created them; neither recovery nor a poll invokes Kernel/reads a file.
    return this.settle(input, journal, before, record.result, owner);
  }

  inspect(raw: AstraJson): { revision: number; checkpoint: AstraCreateWorkCheckpoint; nativeCompletionCertified: false } {
    const view = this.required(this.input(raw), this.options.journal); return { ...view, nativeCompletionCertified: false };
  }

  private settle(input: CompiledInput, journal: AstraJournalAccess, before: ReturnType<AstraCreateWorkAdapter['required']>,
    result: MonarchExecutionResult, owner: () => boolean): AstraWorkResult {
    const cp = before.checkpoint, output = result.output as Record<string, unknown> | undefined;
    const dispatch = result.metadata?.dispatchControl as { dispatched?: unknown } | undefined;
    const policy = result.metadata?.policy as { outcome?: unknown } | undefined;
    if (result.ok) {
      const record = this.receipt(input, cp);
      const valid = record?.status === 'completed' && record.result?.ok && same(record.result.output ?? null, result.output ?? null)
        && dispatch?.dispatched === true && output?.verified === true && output.createdExclusively === true
        && typeof output.path === 'string' && samePath(output.path, this.targetName(input))
        && output.bytes === Buffer.byteLength(input.content) && output.readbackSha256 === sha(input.content).slice(7);
      if (!valid) return this.project(this.save(input, journal, before, { ...cp, quiescent: true, reason: 'create-evidence-binding' }, owner));
      const acknowledged = { ...cp }; delete acknowledged.reason;
      return this.project(this.save(input, journal, before, { ...acknowledged, phase: 'settled', quiescent: true, effect: 'applied',
        observation: { bytes: Buffer.byteLength(input.content), contentDigest: sha(input.content), targetDigest: sha(this.targetName(input).toLowerCase()),
          proposalHash: cp.invocation!.proposalHash, ledgerId: record.ledgerId, temporalSemantics: 'snapshot-after-create' } }, owner));
    }
    if (this.options.approvalPort && !cp.approval && cp.desired !== 'cancel'
      && dispatch?.dispatched !== true && !this.receipt(input, cp)) {
      const approval = makeCreateApproval(result, { workId: input.workId, inputDigest: cp.inputDigest,
        proposalHash: cp.invocation!.proposalHash, expiresAt: this.options.approvalPort.deadline(input) });
      if (approval) return this.project(this.save(input, journal, before, { ...cp, phase: 'awaiting-approval',
        quiescent: true, effect: 'not-applied', reason: 'confirmation-required', approval }, owner));
    }
    const notApplied = dispatch?.dispatched === false || policy?.outcome === 'deny' || policy?.outcome === 'confirm'
      || ['file-exists', 'target-is-directory', 'file-too-large', 'rollback-snapshot-failed'].includes(result.error ?? '');
    return this.project(this.save(input, journal, before, { ...cp, phase: notApplied ? 'settled' : 'dispatching', quiescent: true,
      effect: notApplied ? 'not-applied' : 'unknown', reason: /^[a-z0-9-]{1,96}$/u.test(result.error ?? '') ? result.error! : 'kernel-failed' }, owner));
  }

  private receipt(input: CompiledInput, cp: AstraCreateWorkCheckpoint): MonarchActionLedgerRecord | null {
    check(cp.invocation, 'invocation-required');
    const record = this.options.kernel.getActionLedgerRecord(cp.invocation.idempotencyKey);
    if (record) check(record.idempotencyKey === cp.invocation.idempotencyKey && record.proposalHash === cp.invocation.proposalHash
      && record.proposalId === input.workId && record.intentId === input.workId
      && record.moduleId === 'workspace' && record.capabilityId === 'workspace.files.write', 'receipt-binding');
    return record;
  }
  private validate(raw: AstraJson): AstraCreateWorkInput {
    check(raw && typeof raw === 'object' && !Array.isArray(raw)
      && Object.keys(raw).every(key => ['basename', 'content', 'timeoutMs', 'workId', 'source', 'requireExactConfirmation'].includes(key)), 'input-shape');
    const input = JSON.parse(astraJournalJson(raw)) as AstraCreateWorkInput;
    check(input.requireExactConfirmation === undefined || input.requireExactConfirmation === true && this.options.approvalPort,
      'exact-confirmation-port-required');
    check(typeof input.basename === 'string' && input.basename.length >= 1 && input.basename.length <= 255
      && !/[:\\/*?"<>|\x00-\x1f\x7f]/u.test(input.basename) && !/[. ]$/u.test(input.basename)
      && !/^(con(?:in\$|out\$)?|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(input.basename), 'single-leaf-required');
    check(typeof input.content === 'string' && Buffer.byteLength(input.content) <= 16384, 'content-budget');
    const source = input.source;
    check(source && typeof source === 'object' && !Array.isArray(source)
      && Object.keys(source).every(key => ['interactionId', 'messageId', 'revision', 'userText'].includes(key))
      && id(source.interactionId) && id(source.messageId) && Number.isSafeInteger(source.revision) && source.revision >= 1
      && typeof source.userText === 'string' && source.userText.trim().length > 0 && source.userText.length <= 4096, 'host-source-required');
    check(input.timeoutMs === undefined || Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 50 && input.timeoutMs <= 10000, 'deadline-budget');
    return input;
  }
  private input(raw: AstraJson): CompiledInput {
    const input = this.validate(raw); check(id(input.workId) && input.timeoutMs !== undefined, 'compiled-input-required'); return input as CompiledInput;
  }
  private targetName(input: AstraCreateWorkInput): string { return path.join(this.root, input.basename); }
  private current(input: AstraCreateWorkInput): boolean { try { return this.options.isSourceCurrent(structuredClone(input)) === true; } catch { return false; } }
  private binding(phase: 'admission' | 'activation' = 'activation'): string {
    const capability = this.options.kernel.listCapabilities().find(item => item.id === 'workspace.files.write');
    const readiness = this.options.kernel.getCapabilityReadiness('workspace.files.write');
    check(capability?.moduleId === 'workspace' && capability.risk === 'write' && readiness?.status === 'active', 'capability-not-ready');
    // Queue admission pins immutable effect semantics, not a process instance.
    // execute() separately captures FULL fresh instance/lifecycle readiness and
    // fences it after async preflight/observers immediately before dispatch.
    // A dispatching/unknown checkpoint is never returned to ready by this change.
    const binding = phase === 'admission' ? { capabilityId: readiness.capabilityId, moduleId: readiness.moduleId,
      moduleVersion: readiness.moduleVersion, status: readiness.status } : readiness;
    return sha(astraJournalJson(json({ version: this.version, root: this.root.toLowerCase(), capability, readiness: binding })));
  }
  private async preflight(input: CompiledInput): Promise<void> {
    // Stronger hostile concurrent reparse containment needs a native handle ABI.
    // This profile permits only an explicitly owned canonical isolated directory.
    check(samePath(await realpath(this.root), this.root) && !(await lstat(this.root)).isSymbolicLink(), 'root-alias');
    try { await lstat(this.targetName(input)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;
    }
    throw new Error('astra-create:target-exists');
  }
  private admit(input: CompiledInput, journal: AstraJournalAccess, owner: () => boolean): ReturnType<AstraCreateWorkAdapter['required']> {
    const existing = this.read(input, journal); if (existing) return existing;
    return this.save(input, journal, { revision: 0 }, { schemaVersion: 'monarch.astra-v3-create-work.internal.v1', workId: input.workId,
      inputDigest: astraCreateInputDigest(this.root, input), phase: 'ready', desired: 'run', quiescent: true, effect: 'not-applied' }, owner);
  }
  private read(input: CompiledInput, journal: AstraJournalAccess): { revision: number; checkpoint: AstraCreateWorkCheckpoint } | undefined {
    const view = journal.read(input.workId); if (!view) return undefined;
    const cp = view.checkpoint as unknown as AstraCreateWorkCheckpoint;
    check(cp.schemaVersion === 'monarch.astra-v3-create-work.internal.v1' && cp.workId === input.workId
      && cp.inputDigest === astraCreateInputDigest(this.root, input)
      && ['ready', 'dispatching', 'settled', 'awaiting-approval'].includes(cp.phase) && ['run', 'pause', 'cancel'].includes(cp.desired)
      && ['not-applied', 'unknown', 'applied'].includes(cp.effect) && typeof cp.quiescent === 'boolean'
      && (cp.phase !== 'dispatching' || cp.invocation), 'checkpoint-binding');
    if (cp.approval) { validateCreateApproval(cp.approval); check(this.options.approvalPort && cp.approval.workId === cp.workId
      && cp.approval.inputDigest === cp.inputDigest && cp.approval.proposalHash === cp.invocation?.proposalHash, 'approval-binding'); }
    check(cp.phase !== 'awaiting-approval' || cp.approval && cp.effect === 'not-applied' && cp.quiescent, 'approval-state');
    if (cp.invocation) check(/^[a-f0-9]{64}$/u.test(cp.invocation.proposalHash) && /^action:[a-f0-9]{64}$/u.test(cp.invocation.idempotencyKey), 'invocation-binding');
    if (cp.effect === 'applied') check(cp.phase === 'settled' && cp.quiescent && cp.observation
      && cp.observation.bytes === Buffer.byteLength(input.content) && cp.observation.contentDigest === sha(input.content)
      && cp.observation.targetDigest === sha(this.targetName(input).toLowerCase()) && cp.observation.proposalHash === cp.invocation?.proposalHash
      && cp.observation.temporalSemantics === 'snapshot-after-create' && typeof cp.observation.ledgerId === 'string', 'observation-binding');
    return { revision: view.revision, checkpoint: cp };
  }
  private required(input: CompiledInput, journal: AstraJournalAccess): { revision: number; checkpoint: AstraCreateWorkCheckpoint } {
    const view = this.read(input, journal); check(view, 'checkpoint-missing'); return view;
  }
  private save(input: CompiledInput, journal: AstraJournalAccess, before: { revision: number }, checkpoint: AstraCreateWorkCheckpoint,
    owner: () => boolean): ReturnType<AstraCreateWorkAdapter['required']> {
    check(owner(), 'owner-fenced');
    journal.append({ streamId: input.workId, requestId: 'create_' + randomUUID(), expectedRevision: before.revision, checkpoint: json(checkpoint),
      events: [{ type: 'create.' + checkpoint.phase, desired: checkpoint.desired, effect: checkpoint.effect, quiescent: checkpoint.quiescent }] });
    return this.required(input, journal);
  }
  private project(view: ReturnType<AstraCreateWorkAdapter['required']>): AstraWorkResult {
    const cp = view.checkpoint;
    const state = !cp.quiescent || cp.effect === 'unknown' ? cp.desired === 'cancel' ? 'cancelling' : cp.desired === 'pause' ? 'pausing' : 'indeterminate'
      : cp.desired === 'cancel' ? 'cancelled' : cp.desired === 'pause' ? 'paused'
      : cp.phase === 'awaiting-approval' ? 'awaiting-approval'
      : cp.phase === 'ready' ? 'queued' : cp.effect === 'applied' ? 'observed' : 'blocked';
    return { state, checkpointRef: cp.workId, checkpointRevision: view.revision,
      progressDigest: sha(astraJournalJson(json({ phase: cp.phase, effect: cp.effect, observation: cp.observation ?? null, quiescent: cp.quiescent }))),
      ...(cp.reason ? { reason: cp.reason } : {}) };
  }
}
