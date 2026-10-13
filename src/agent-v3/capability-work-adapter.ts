import { createHash, randomUUID } from 'node:crypto';
import type { MonarchActionLedgerRecord, MonarchActionProposalV1, MonarchAgentCapabilitySource,
  MonarchCapability, MonarchExecutionResult, MonarchPermissionProfile } from '../core/contracts';
import type { MonarchKernel } from '../core/kernel';
import { AstraJournalError, astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';
import type { AstraWorkAdapter, AstraWorkControl, AstraWorkResult } from './work-scheduler';
import { makeCreateApproval as makePolicyChallenge, validateCreateApproval as validatePolicyChallenge,
  validateCreateApprovalDecision, type AstraCreateApproval as PolicyChallenge,
  type AstraCreateApprovalDecision } from './create-approval';

export interface AstraCapabilityWorkSource {
  /** Stable task owner used by task-scoped Direct Access and durable approvals. */
  taskId: string;
  interactionId: string;
  messageId: string;
  revision: number;
  userText: string;
  surface: MonarchAgentCapabilitySource;
}

export interface AstraCapabilityWorkInput {
  capabilityId: string;
  args: { [key: string]: AstraJson };
  modelId: string;
  skillIds?: string[];
  reason?: string;
  timeoutMs?: number;
  source: AstraCapabilityWorkSource;
  workId?: string;
}

interface CompiledInput extends AstraCapabilityWorkInput {
  workId: string;
  timeoutMs: number;
  proposal: MonarchActionProposalV1;
  capabilityBindingDigest: string;
}

export interface AstraCapabilityObservation {
  authority: 'kernel-receipt';
  temporalSemantics: 'acknowledged-after-dispatch';
  proposalHash: string;
  ledgerId: string;
  resultDigest: string;
  result: { ok: boolean; summary: string; output?: AstraJson; error?: string };
}

export interface AstraCapabilityWorkCheckpoint {
  schemaVersion: 'monarch.astra-v3-capability-work.internal.v1';
  workId: string;
  inputDigest: string;
  phase: 'ready' | 'dispatching' | 'awaiting-approval' | 'settled';
  desired: 'run' | 'pause' | 'cancel';
  quiescent: boolean;
  effect: 'not-dispatched' | 'unknown' | 'acknowledged';
  invocation?: { proposalHash: string; idempotencyKey: string };
  approval?: PolicyChallenge;
  answer?: { decision: AstraCreateApprovalDecision; receivedAt: number };
  observation?: AstraCapabilityObservation;
  reason?: string;
}

export interface AstraCapabilityApprovalCard extends PolicyChallenge {
  capability: { id: string; moduleId: string; title: string; description: string; risk: MonarchCapability['risk'] };
  args: { [key: string]: AstraJson };
  reason?: string;
  source: AstraCapabilityWorkSource;
  grantScope: 'once';
  nativeCompletionCertified: false;
}

const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const sha = (value: string | Uint8Array): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown): boolean => astraJournalJson(json(left)) === astraJournalJson(json(right));
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-capability-work:' + code); }

/** Exact bounded projection used both by the adapter receipt and the Agent
 * completion certifier. Keeping one implementation prevents certification from
 * silently hashing a different Kernel result shape. */
export function astraCapabilityResultProjection(result: MonarchExecutionResult): AstraCapabilityObservation['result'] {
  check(typeof result.ok === 'boolean' && typeof result.summary === 'string' && result.summary.length <= 32_768,
    'result-shape');
  const retained = json({ ok: result.ok, summary: result.summary,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(typeof result.error === 'string' ? { error: result.error.slice(0, 1024) } : {}) }) as unknown as AstraCapabilityObservation['result'];
  check(Buffer.byteLength(astraJournalJson(retained as unknown as AstraJson)) <= 262_144, 'result-budget');
  return retained;
}

export function astraCapabilityResultDigest(result: MonarchExecutionResult): string {
  return sha(astraJournalJson(json(astraCapabilityResultProjection(result))));
}

/** Generic typed effect primitive for the common V3 scheduler. It does not plan,
 * select a capability, infer intent or certify task completion. A future V3 task
 * workflow may submit only a model decision already bound to an authenticated
 * source. Kernel remains the sole policy/dispatch authority and Monarch Security
 * remains the independent action observer. Unknown dispatch outcomes never retry.
 */
export class AstraCapabilityWorkAdapter implements AstraWorkAdapter {
  readonly id = 'kernel-capability';
  readonly version = 'v1';
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly options: {
    deployment: 'isolated-validation';
    journal: AstraJournalAccess;
    kernel: MonarchKernel;
    isSourceCurrent: (input: AstraCapabilityWorkInput) => boolean;
    isCapabilityAllowed: (capability: MonarchCapability, input: AstraCapabilityWorkInput) => boolean;
    permissionProfile?: (input: AstraCapabilityWorkInput) => MonarchPermissionProfile | undefined;
  }) { check(options.deployment === 'isolated-validation', 'deployment'); }

  compile(raw: AstraJson, context: { jobId: string; scopeId: string; controlBudget: number }): ReturnType<AstraWorkAdapter['compile']> {
    const input = this.validate(raw), workId = 'capability_work_' + sha(context.scopeId + '/' + context.jobId).slice(7, 39);
    check(input.workId === undefined || input.workId === workId, 'identity-owner');
    check(this.current(input), 'source-stale');
    const capabilityBindingDigest = this.binding(input, 'admission');
    const proposal = this.prepare({ ...input, workId, timeoutMs: input.timeoutMs ?? 30_000 } as CompiledInput);
    const normalized: CompiledInput = { ...input, workId, timeoutMs: input.timeoutMs ?? 30_000,
      proposal, capabilityBindingDigest };
    const encoded = astraJournalJson(json(normalized)); check(Buffer.byteLength(encoded) <= 65_536, 'input-budget');
    const commits = 24 + 4 * context.controlBudget;
    return { input: json(normalized), activationBudgetMs: normalized.timeoutMs + 5_000,
      bindingDigest: sha(astraJournalJson(json({ version: this.version, capabilityBindingDigest }))),
      resources: { kernelSlots: 1, modelSlots: 0,
        declaredBytes: 2 * 1024 * 1024 + 4 * Buffer.byteLength(encoded),
        exclusiveKeys: ['action_' + proposal.canonicalHash.slice(0, 48)] },
      storage: { maxActivations: 8 + 2 * context.controlBudget,
        streams: [{ streamId: workId, commits, eventBytes: commits * 4096, checkpointBytes: 384 * 1024 }] } };
  }

  async execute(raw: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult> {
    const input = this.input(raw), journal = control.journal;
    check(control.isCurrent(), 'activation-fenced');
    let before = this.admit(input, journal, control.ownerIsCurrent);
    if (before.checkpoint.phase !== 'ready' || before.checkpoint.desired !== 'run') return this.project(before);
    if (!this.current(input)) return this.project(this.save(input, journal, before,
      { ...before.checkpoint, phase: 'settled', reason: 'source-stale' }, control.ownerIsCurrent));
    const activationBinding = this.binding(input, 'activation');
    const current = (): boolean => {
      try {
        return control.isCurrent() && this.current(input) && this.binding(input, 'admission') === input.capabilityBindingDigest
          && this.binding(input, 'activation') === activationBinding;
      } catch { return false; }
    };
    if (!current()) return this.project(this.save(input, journal, before,
      { ...before.checkpoint, phase: 'settled', reason: 'source-or-capability-stale' }, control.ownerIsCurrent));
    const proposal = this.prepare(input);
    check(proposal.canonicalHash === input.proposal.canonicalHash && proposal.idempotencyKey === input.proposal.idempotencyKey,
      'proposal-changed');
    const { approval, answer } = before.checkpoint;
    if (approval && (!answer || answer.decision.decision !== 'approve' || approval.proposalHash !== proposal.canonicalHash
      || Date.now() >= approval.expiresAt)) return this.project(this.save(input, journal, before,
      { ...before.checkpoint, phase: 'settled', reason: 'approval-stale' }, control.ownerIsCurrent));
    try {
      before = this.save(input, journal, before, { ...before.checkpoint, phase: 'dispatching', quiescent: false, effect: 'unknown',
        invocation: { proposalHash: proposal.canonicalHash, idempotencyKey: proposal.idempotencyKey } }, current);
    } catch (error) {
      if (error instanceof AstraJournalError && error.code === 'revision-conflict') return this.project(this.required(input, journal));
      throw error;
    }
    const controller = new AbortController(); this.active.set(input.workId, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const permissionProfile = this.permissionProfile(input);
    const completion = this.options.kernel.executeActionProposal(proposal, {
      requestedBy: 'agent:' + input.source.taskId,
      intentId: input.source.taskId,
      originatingUserText: input.source.userText,
      source: input.source.surface,
      model: input.modelId,
      ...(input.skillIds ? { skillIds: input.skillIds } : {}),
      executionMode: 'agent-runtime',
      ...(permissionProfile ? { permissionProfileOverride: permissionProfile } : {}),
      ...(approval && answer ? { confirmed: true, approvalPolicyDecisionHash: approval.policyDecisionHash,
        approvalPurpose: approval.purpose, authorityTierAtApproval: approval.authorityTier } : {}),
      signal: AbortSignal.any([control.signal, controller.signal]),
      dispatchGuard: current,
    }).then(returned => {
      const fresh = this.required(input, journal);
      if (!control.ownerIsCurrent() || fresh.checkpoint.phase !== 'dispatching') return this.project(fresh);
      check(returned.proposal.canonicalHash === proposal.canonicalHash, 'proposal-binding');
      return this.settle(input, journal, fresh, returned.result, control.ownerIsCurrent);
    }, () => this.project(this.required(input, journal))).finally(() => {
      if (this.active.get(input.workId) === controller) this.active.delete(input.workId);
    });
    try {
      const expired = new Promise<AstraWorkResult>((resolve, reject) => { timer = setTimeout(() => {
        controller.abort('capability-deadline');
        try { resolve(this.project(this.required(input, journal))); } catch (error) { reject(error); }
      }, input.timeoutMs); });
      return await Promise.race([completion, expired]);
    } finally { if (timer) clearTimeout(timer); }
  }

  control(raw: AstraJson, command: 'pause' | 'resume' | 'cancel', owner: () => boolean,
    journal = this.options.journal): AstraWorkResult {
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
      ...(command === 'cancel' && ['ready', 'awaiting-approval'].includes(cp.phase)
        ? { phase: 'settled' as const, effect: 'not-dispatched' as const, reason: 'cancelled-before-dispatch' } : {}) }, owner);
    if (command === 'cancel') this.active.get(input.workId)?.abort('capability-cancelled');
    return this.project(this.required(input, journal));
  }

  reconcile(raw: AstraJson, owner: () => boolean, journal = this.options.journal): AstraWorkResult {
    const input = this.input(raw), before = this.admit(input, journal, owner);
    if (before.checkpoint.phase !== 'dispatching') return this.project(before);
    const record = this.receipt(input, before.checkpoint);
    if (!record?.result || !['completed', 'failed'].includes(record.status)) return this.project(before);
    // An action cut off by a process exit settles as partial, with no
    // observation - never retried: Kernel replays the same refusal for the
    // same idempotency key. Holding it instead froze the whole task until its
    // deadline (hours) after a crash; the agent sees the tool error and can
    // check the current state before deciding.
    if (record.error === 'interrupted-before-completion' || record.result.error === 'interrupted-before-completion') {
      // The ledger proves it was dispatched; only its result is unconfirmed: partial.
      return this.project(this.save(input, journal, before, { ...before.checkpoint, phase: 'settled', quiescent: true,
        effect: 'acknowledged', reason: 'interrupted-before-completion' }, owner));
    }
    return this.settle(input, journal, before, record.result, owner);
  }

  inspect(raw: AstraJson): { revision: number; checkpoint: AstraCapabilityWorkCheckpoint; nativeCompletionCertified: false } {
    return { ...this.required(this.input(raw), this.options.journal), nativeCompletionCertified: false };
  }

  answer(raw: AstraJson, decision: AstraCreateApprovalDecision, owner: () => boolean,
    journal = this.options.journal): AstraWorkResult {
    const input = this.input(raw), before = this.required(input, journal), cp = before.checkpoint;
    validateCreateApprovalDecision(decision); check(owner(), 'owner-fenced');
    check(cp.approval && decision.approvalId === cp.approval.id && decision.approvalDigest === cp.approval.digest,
      'approval-binding');
    if (cp.answer) {
      check(same(cp.answer.decision, decision), 'answer-conflict'); return this.project(before);
    }
    check(cp.phase === 'awaiting-approval' && cp.desired !== 'cancel'
      && (decision.decision === 'reject' || this.current(input) && Date.now() < cp.approval.expiresAt), 'approval-not-current');
    return this.project(this.save(input, journal, before,
      { ...cp, answer: { decision: structuredClone(decision), receivedAt: Date.now() } }, owner));
  }

  approvalCard(raw: AstraJson): AstraCapabilityApprovalCard | undefined {
    const input = this.input(raw), cp = this.read(input, this.options.journal)?.checkpoint;
    if (!cp || cp.phase !== 'awaiting-approval' || !cp.approval || cp.answer) return undefined;
    const capability = this.capability(input);
    return { ...structuredClone(cp.approval), capability: { id: capability.id, moduleId: capability.moduleId,
      title: capability.title, description: capability.description ?? '', risk: capability.risk },
      args: structuredClone(input.args), ...(input.reason ? { reason: input.reason } : {}),
      source: structuredClone(input.source), grantScope: 'once', nativeCompletionCertified: false };
  }

  private settle(input: CompiledInput, journal: AstraJournalAccess,
    before: { revision: number; checkpoint: AstraCapabilityWorkCheckpoint }, result: MonarchExecutionResult,
    owner: () => boolean): AstraWorkResult {
    const cp = before.checkpoint;
    const dispatched = (result.metadata?.dispatchControl as { dispatched?: unknown } | undefined)?.dispatched === true;
    if (!dispatched && !cp.approval && cp.desired !== 'cancel') {
      const approval = makePolicyChallenge(result, { workId: input.workId, inputDigest: cp.inputDigest,
        proposalHash: cp.invocation!.proposalHash, expiresAt: Date.now() + 90_000 });
      if (approval) return this.project(this.save(input, journal, before, { ...cp, phase: 'awaiting-approval',
        quiescent: true, effect: 'not-dispatched', approval, reason: 'confirmation-required' }, owner));
    }
    if (!dispatched) return this.project(this.save(input, journal, before, { ...cp, phase: 'settled', quiescent: true,
      effect: 'not-dispatched', reason: this.reason(result) }, owner));
    const record = this.receipt(input, cp);
    if (!record?.result || !['completed', 'failed'].includes(record.status)
      || (record.status === 'completed') !== record.result.ok) {
      receiptBindingDiagnostic(input.capabilityId, 'ledger-record', { record: Boolean(record), status: record?.status ?? null,
        recordResult: Boolean(record?.result), recordOk: record?.result?.ok ?? null, liveOk: result.ok });
      return this.project(this.save(input, journal, before, { ...cp, quiescent: true, reason: 'receipt-binding' }, owner));
    }
    let retained: AstraCapabilityObservation['result'], recorded: AstraCapabilityObservation['result'];
    try { retained = astraCapabilityResultProjection(result); recorded = astraCapabilityResultProjection(record.result); }
    catch {
      return this.project(this.save(input, journal, before, { ...cp, phase: 'settled', quiescent: true,
        effect: 'acknowledged', reason: 'result-not-retainable' }, owner));
    }
    if (!same(recorded, retained)) {
      const keys = (value: AstraCapabilityObservation['result']) => Object.keys(value ?? {}).sort().join(',');
      receiptBindingDiagnostic(input.capabilityId, 'result-differs', { recordedKeys: keys(recorded), liveKeys: keys(retained),
        recordedBytes: Buffer.byteLength(astraJournalJson(json(recorded))), liveBytes: Buffer.byteLength(astraJournalJson(json(retained))),
        summaryEqual: recorded.summary === retained.summary, okEqual: recorded.ok === retained.ok,
        outputEqual: astraJournalJson(json(recorded.output ?? null)) === astraJournalJson(json(retained.output ?? null)) });
      return this.project(this.save(input, journal, before, { ...cp, quiescent: true, reason: 'receipt-binding' }, owner));
    }
    const resultDigest = sha(astraJournalJson(json(retained)));
    return this.project(this.save(input, journal, before, { ...cp, phase: 'settled', quiescent: true, effect: 'acknowledged',
      observation: { authority: 'kernel-receipt', temporalSemantics: 'acknowledged-after-dispatch',
        proposalHash: cp.invocation!.proposalHash, ledgerId: record.ledgerId, resultDigest, result: retained } }, owner));
  }

  private reason(result: MonarchExecutionResult): string {
    const value = typeof result.error === 'string' ? result.error : 'kernel-not-dispatched';
    return /^[a-z0-9-]{1,96}$/u.test(value) ? value : 'kernel-not-dispatched';
  }

  private receipt(input: CompiledInput, cp: AstraCapabilityWorkCheckpoint): MonarchActionLedgerRecord | null {
    check(cp.invocation, 'invocation-required');
    const record = this.options.kernel.getActionLedgerRecord(cp.invocation.idempotencyKey);
    // Kernel keys a completed effect by the exact canonical action within the
    // task and answers a repeat with that receipt (idempotent replay). The
    // record then names the earlier proposal; key, hash, task and capability
    // still bind it to this very action. Requiring the new proposal id threw,
    // and the task host retired a live agent on a repeated mkdir.
    if (record) check(record.idempotencyKey === cp.invocation.idempotencyKey && record.proposalHash === cp.invocation.proposalHash
      && (record.proposalId === input.workId || record.status === 'completed') && record.intentId === input.source.taskId
      && record.capabilityId === input.capabilityId && record.moduleId === this.capability(input).moduleId, 'receipt-binding');
    return record;
  }

  private prepare(input: CompiledInput): MonarchActionProposalV1 {
    return this.options.kernel.prepareActionProposal({ capabilityId: input.capabilityId, proposalId: input.workId,
      intentId: input.source.taskId, args: input.args, ...(input.reason ? { reason: input.reason } : {}),
      provenance: { source: 'model-tool-call', model: input.modelId, skillIds: input.skillIds ?? [] } }, {
      requestedBy: 'agent:' + input.source.taskId, intentId: input.source.taskId,
      originatingUserText: input.source.userText, model: input.modelId, ...(input.skillIds ? { skillIds: input.skillIds } : {}),
    });
  }

  private capability(input: AstraCapabilityWorkInput): MonarchCapability {
    const capability = this.options.kernel.getCapability(input.capabilityId);
    check(capability && this.allowed(capability, input), 'capability-not-admitted'); return capability;
  }

  private binding(input: AstraCapabilityWorkInput, phase: 'admission' | 'activation'): string {
    const capability = this.capability(input), readiness = this.options.kernel.getCapabilityReadiness(capability.id);
    check(readiness?.status === 'active' && readiness.moduleId === capability.moduleId, 'capability-not-ready');
    const boundReadiness = phase === 'admission' ? { capabilityId: readiness.capabilityId, moduleId: readiness.moduleId,
      moduleVersion: readiness.moduleVersion, status: readiness.status } : readiness;
    return sha(astraJournalJson(json({ version: this.version, capability, readiness: boundReadiness })));
  }

  private validate(raw: AstraJson): AstraCapabilityWorkInput {
    check(raw && typeof raw === 'object' && !Array.isArray(raw)
      && Object.keys(raw).every(key => ['capabilityId', 'args', 'modelId', 'skillIds', 'reason', 'timeoutMs', 'source', 'workId',
        'proposal', 'capabilityBindingDigest'].includes(key)),
    'input-shape');
    const input = JSON.parse(astraJournalJson(raw)) as unknown as AstraCapabilityWorkInput;
    check(typeof input.capabilityId === 'string' && /^[a-z0-9][a-z0-9._-]{2,159}$/u.test(input.capabilityId)
      && input.args && typeof input.args === 'object' && !Array.isArray(input.args)
      && typeof input.modelId === 'string' && input.modelId.length >= 1 && input.modelId.length <= 200
      && (input.reason === undefined || typeof input.reason === 'string' && input.reason.length <= 1000)
      && (input.skillIds === undefined || Array.isArray(input.skillIds) && input.skillIds.length <= 16
        && input.skillIds.every(item => typeof item === 'string' && item.length >= 1 && item.length <= 120)
        && new Set(input.skillIds).size === input.skillIds.length)
      && (input.timeoutMs === undefined || Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 50 && input.timeoutMs <= 600_000),
    'input-binding');
    const source = input.source;
    check(source && typeof source === 'object' && !Array.isArray(source)
      && Object.keys(source).every(key => ['taskId', 'interactionId', 'messageId', 'revision', 'userText', 'surface'].includes(key))
      && identity(source.taskId) && identity(source.interactionId) && identity(source.messageId)
      && Number.isSafeInteger(source.revision) && source.revision >= 1
      && typeof source.userText === 'string' && source.userText.trim().length > 0
      && Buffer.byteLength(source.userText) <= (source.surface === 'coder' ? 20_000 : 16_384)
      && ['desktop', 'voice', 'telegram', 'api', 'system', 'smoke', 'coder'].includes(source.surface), 'host-source-required');
    return input;
  }

  private input(raw: AstraJson): CompiledInput {
    const input = this.validate(raw) as CompiledInput;
    check(identity(input.workId) && Number.isSafeInteger(input.timeoutMs) && input.proposal
      && input.proposal.proposalId === input.workId && input.proposal.capabilityId === input.capabilityId
      && input.proposal.intentId === input.source.taskId && input.proposal.provenance.source === 'model-tool-call'
      && /^sha256:[a-f0-9]{64}$/u.test(input.capabilityBindingDigest), 'compiled-input-required');
    return input;
  }

  private current(input: AstraCapabilityWorkInput): boolean {
    try { return this.options.isSourceCurrent(structuredClone(input)) === true; } catch { return false; }
  }
  private allowed(capability: MonarchCapability, input: AstraCapabilityWorkInput): boolean {
    try { return this.options.isCapabilityAllowed(structuredClone(capability), structuredClone(input)) === true; } catch { return false; }
  }
  private permissionProfile(input: AstraCapabilityWorkInput): MonarchPermissionProfile | undefined {
    try { return this.options.permissionProfile?.(structuredClone(input)); } catch { return undefined; }
  }

  private admit(input: CompiledInput, journal: AstraJournalAccess, owner: () => boolean) {
    const existing = this.read(input, journal); if (existing) return existing;
    return this.save(input, journal, { revision: 0 }, { schemaVersion: 'monarch.astra-v3-capability-work.internal.v1',
      workId: input.workId, inputDigest: sha(astraJournalJson(json(input))), phase: 'ready', desired: 'run', quiescent: true,
      effect: 'not-dispatched' }, owner);
  }

  private read(input: CompiledInput, journal: AstraJournalAccess): { revision: number; checkpoint: AstraCapabilityWorkCheckpoint } | undefined {
    const snapshot = journal.read(input.workId); if (!snapshot) return undefined;
    const cp = snapshot.checkpoint as unknown as AstraCapabilityWorkCheckpoint;
    check(cp.schemaVersion === 'monarch.astra-v3-capability-work.internal.v1' && cp.workId === input.workId
      && cp.inputDigest === sha(astraJournalJson(json(input))) && ['ready', 'dispatching', 'awaiting-approval', 'settled'].includes(cp.phase)
      && ['run', 'pause', 'cancel'].includes(cp.desired) && typeof cp.quiescent === 'boolean'
      && ['not-dispatched', 'unknown', 'acknowledged'].includes(cp.effect)
      && (cp.phase !== 'dispatching' || cp.invocation), 'checkpoint-binding');
    if (cp.invocation) check(cp.invocation.proposalHash === input.proposal.canonicalHash
      && cp.invocation.idempotencyKey === input.proposal.idempotencyKey, 'invocation-binding');
    if (cp.observation) check(cp.phase === 'settled' && cp.quiescent && cp.effect === 'acknowledged'
      && cp.observation.authority === 'kernel-receipt' && cp.observation.temporalSemantics === 'acknowledged-after-dispatch'
      && cp.observation.proposalHash === cp.invocation?.proposalHash
      && cp.observation.resultDigest === sha(astraJournalJson(json(cp.observation.result))), 'observation-binding');
    if (cp.approval) {
      validatePolicyChallenge(cp.approval);
      check(cp.approval.workId === input.workId && cp.approval.inputDigest === cp.inputDigest
        && cp.approval.proposalHash === cp.invocation?.proposalHash, 'approval-binding');
    }
    if (cp.answer) {
      validateCreateApprovalDecision(cp.answer.decision);
      check(cp.approval && cp.answer.decision.approvalId === cp.approval.id
        && cp.answer.decision.approvalDigest === cp.approval.digest && Number.isSafeInteger(cp.answer.receivedAt)
        && cp.answer.receivedAt > 0 && (cp.answer.decision.decision === 'reject'
          || cp.answer.receivedAt < cp.approval.expiresAt), 'answer-binding');
    }
    check(cp.phase !== 'awaiting-approval' || cp.approval && cp.effect === 'not-dispatched' && cp.quiescent,
      'approval-state');
    return { revision: snapshot.revision, checkpoint: cp };
  }

  private required(input: CompiledInput, journal: AstraJournalAccess) {
    const value = this.read(input, journal); check(value, 'checkpoint-missing'); return value;
  }

  private save(input: CompiledInput, journal: AstraJournalAccess, before: { revision: number },
    checkpoint: AstraCapabilityWorkCheckpoint, owner: () => boolean) {
    check(owner(), 'owner-fenced');
    journal.append({ streamId: input.workId, requestId: 'capability_' + randomUUID(), expectedRevision: before.revision,
      checkpoint: json(checkpoint), events: [{ type: 'capability-work.' + checkpoint.phase, desired: checkpoint.desired,
        effect: checkpoint.effect, quiescent: checkpoint.quiescent }] });
    return this.required(input, journal);
  }

  private project(view: { revision: number; checkpoint: AstraCapabilityWorkCheckpoint }): AstraWorkResult {
    const cp = view.checkpoint;
    const state = !cp.quiescent || cp.effect === 'unknown'
      ? cp.desired === 'cancel' ? 'cancelling' : cp.desired === 'pause' ? 'pausing' : 'indeterminate'
      : cp.desired === 'cancel' ? 'cancelled' : cp.desired === 'pause' ? 'paused'
      : cp.phase === 'ready' ? 'queued' : cp.phase === 'awaiting-approval' ? 'awaiting-approval'
        : cp.observation ? 'observed' : cp.effect === 'acknowledged' ? 'partial' : 'blocked';
    return { state, checkpointRef: cp.workId, checkpointRevision: view.revision,
      progressDigest: sha(astraJournalJson(json({ phase: cp.phase, desired: cp.desired, effect: cp.effect,
        observation: cp.observation ?? null, quiescent: cp.quiescent }))), ...(cp.reason ? { reason: cp.reason } : {}) };
  }
}

/** Why a dispatched action could not be bound to its Kernel receipt: shapes and
 * sizes only, never content. The task above it otherwise just stalls. */
function receiptBindingDiagnostic(capabilityId: string, branch: string, facts: Record<string, unknown>): void {
  console.error(JSON.stringify({ diagnostic: 'astra-capability-receipt-binding', capabilityId, branch, ...facts }));
}
