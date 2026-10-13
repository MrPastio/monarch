import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MonarchKernel } from '../core/kernel';
import type { MonarchExecutionResult } from '../core/contracts';
import { AstraJournalError, astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';

// First executable V3 read pack, explicitly isolated from product admission.
// These are internal checkpoints, NOT native AgentEvent/Goal/Certificate wire bodies.
// A real observation stops at observed; only a future admitted Certifier may finish
// an Execution. The driver never invokes V2 AgentLoop or invents a verified result.
export interface AstraReadRequest { requestId: string; relativePath: string; maxBytes?: number; timeoutMs?: number }
export type AstraReadPhase = 'ready' | 'paused' | 'dispatching' | 'cancelling' | 'observed' | 'cancelled' | 'failed' | 'indeterminate';
export interface AstraReadObservation {
  sizeBytes: number; content: string; contentDigest: string; targetDigest: string; proposalHash: string;
}
export interface AstraReadCheckpoint {
  schemaVersion: 'monarch.astra-v3-read-checkpoint.internal.v1';
  runId: string; phase: AstraReadPhase; controlEpoch: number;
  goal: { requirementId: 'read-result'; capabilityId: 'workspace.files.read'; relativePath: string;
    maxBytes: number; timeoutMs: number; rootDigest: string; contractDigest: string };
  observation?: AstraReadObservation;
  invocation?: { proposalHash: string; idempotencyKey: string };
  reason?: string;
}
export interface AstraReadView { revision: number; checkpoint: AstraReadCheckpoint; nativeCompletionCertified: false }
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
export const astraReadRunId = (requestId: string): string => 'read_' + sha(requestId).slice(7, 39);
const samePath = (left: string, right: string): boolean => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
function failure(code: string): never { throw new Error('astra-read:' + code); }
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const phases = new Set<AstraReadPhase>(['ready', 'paused', 'dispatching', 'cancelling', 'observed', 'cancelled', 'failed', 'indeterminate']);

export function validateAstraReadRequest(request: AstraReadRequest): { maxBytes: number; timeoutMs: number } {
  if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(request.requestId)) failure('request-identity');
  validateRelative(request.relativePath);
  const maxBytes = request.maxBytes ?? 65536, timeoutMs = request.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 524288
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000) failure('budget');
  return { maxBytes, timeoutMs };
}
function validateRelative(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || path.isAbsolute(value)
    || /[:*?"<>|\x00-\x1f]/u.test(value) || value.split(/[\\/]/u).some(part => !part || part === '.' || part === '..'
      || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part))) failure('relative-target');
}

export class AstraReadRuntime {
  private readonly controllers = new Map<string, AbortController>();
  private readonly flights = new Map<string, Promise<AstraReadView>>();
  private readonly root: string;

  constructor(private readonly options: {
    deployment: 'isolated-validation'; canonicalRoot: string; kernel: MonarchKernel; journal: AstraJournalAccess;
    dispatchGuard?: () => boolean;
    signal?: AbortSignal;
  }) {
    if (options.deployment !== 'isolated-validation' || !path.isAbsolute(options.canonicalRoot)) failure('isolated-root-required');
    this.root = path.resolve(options.canonicalRoot);
  }

  get scopeDigest(): string { return sha(this.root.toLowerCase()); }
  get capabilityDigest(): string { return this.contractDigest(); }

  admit(request: AstraReadRequest): AstraReadView {
    const { maxBytes, timeoutMs } = validateAstraReadRequest(request);
    const runId = astraReadRunId(request.requestId);
    let view = this.read(runId);
    const goal: AstraReadCheckpoint['goal'] = { requirementId: 'read-result', capabilityId: 'workspace.files.read',
      relativePath: request.relativePath, maxBytes, timeoutMs, rootDigest: sha(this.root.toLowerCase()),
      contractDigest: view?.checkpoint.goal.contractDigest ?? this.contractDigest() };
    if (!view) {
      const checkpoint: AstraReadCheckpoint = { schemaVersion: 'monarch.astra-v3-read-checkpoint.internal.v1', runId,
        phase: 'ready', controlEpoch: 0, goal };
      this.options.journal.append({ streamId: runId, requestId: 'admit_' + request.requestId,
        expectedRevision: 0, events: [{ type: 'goal.accepted', goal: json(goal) }], checkpoint: json(checkpoint) });
      view = this.required(runId);
    }
    if (astraJournalJson(json(view.checkpoint.goal)) !== astraJournalJson(json(goal))) failure('request-conflict');
    return view;
  }

  async run(request: AstraReadRequest): Promise<AstraReadView> {
    const view = this.admit(request), runId = view.checkpoint.runId;
    const running = this.flights.get(runId);
    if (running) return running;
    if (view.checkpoint.phase !== 'ready') return view;
    const flight = this.execute(view).finally(() => { this.flights.delete(runId); this.controllers.delete(runId); });
    this.flights.set(runId, flight);
    return flight;
  }

  read(runId: string): AstraReadView | null {
    const snapshot = this.options.journal.read(runId);
    if (!snapshot) return null;
    const checkpoint = snapshot.checkpoint as unknown as AstraReadCheckpoint;
    if (checkpoint.schemaVersion !== 'monarch.astra-v3-read-checkpoint.internal.v1' || checkpoint.runId !== runId
      || !phases.has(checkpoint.phase) || !Number.isSafeInteger(checkpoint.controlEpoch) || checkpoint.controlEpoch < 0
      || checkpoint.goal?.capabilityId !== 'workspace.files.read' || checkpoint.goal.rootDigest !== sha(this.root.toLowerCase())) failure('checkpoint-scope');
    this.relative(checkpoint.goal.relativePath);
    if (!Number.isSafeInteger(checkpoint.goal.maxBytes) || checkpoint.goal.maxBytes < 1 || checkpoint.goal.maxBytes > 524288
      || !Number.isSafeInteger(checkpoint.goal.timeoutMs) || checkpoint.goal.timeoutMs < 50 || checkpoint.goal.timeoutMs > 10000) failure('checkpoint-budget');
    if (checkpoint.phase === 'observed') {
      const observed = checkpoint.observation;
      if (!observed || typeof observed.content !== 'string' || !Number.isSafeInteger(observed.sizeBytes)
        || observed.sizeBytes < 0 || observed.sizeBytes > checkpoint.goal.maxBytes
        || Buffer.byteLength(observed.content, 'utf8') !== observed.sizeBytes || sha(observed.content) !== observed.contentDigest
        || observed.targetDigest !== sha(path.resolve(this.root, checkpoint.goal.relativePath).toLowerCase())
        || observed.proposalHash !== checkpoint.invocation?.proposalHash) failure('checkpoint-observation');
    }
    if (['dispatching', 'indeterminate', 'cancelling', 'observed'].includes(checkpoint.phase)
      && (!/^[a-f0-9]{64}$/u.test(checkpoint.invocation?.proposalHash ?? '')
        || !/^action:[a-f0-9]{64}$/u.test(checkpoint.invocation?.idempotencyKey ?? ''))) failure('checkpoint-invocation');
    return { revision: snapshot.revision, checkpoint, nativeCompletionCertified: false };
  }

  cancel(runId: string, requestId: string): AstraReadView {
    if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(requestId)) failure('request-identity');
    const current = this.required(runId);
    if (['observed', 'failed', 'cancelled', 'cancelling'].includes(current.checkpoint.phase)) return current;
    const phase = ['ready', 'paused'].includes(current.checkpoint.phase) ? 'cancelled' : 'cancelling';
    const next = { ...current.checkpoint, phase, controlEpoch: current.checkpoint.controlEpoch + 1 } as AstraReadCheckpoint;
    this.options.journal.append({ streamId: runId, requestId: 'cancel_' + requestId, expectedRevision: current.revision,
      events: [{ type: 'execution.cancel-requested', controlEpoch: next.controlEpoch }], checkpoint: json(next) });
    this.controllers.get(runId)?.abort('user-cancelled');
    return this.required(runId);
  }

  parkReady(runId: string): AstraReadView {
    const current = this.required(runId);
    if (current.checkpoint.phase !== 'ready') return current;
    // Revision CAS invalidates even a concurrent asynchronous target preflight.
    // A reserved invocation is never relabelled paused/quiescent by this method.
    return this.commit(current, 'park', { ...current.checkpoint, phase: 'paused' }, { type: 'execution.parked-before-reservation' });
  }

  resumeReady(runId: string): AstraReadView {
    const current = this.required(runId);
    if (current.checkpoint.phase !== 'paused') return current;
    return this.commit(current, 'unpark', { ...current.checkpoint, phase: 'ready' }, { type: 'execution.unparked' });
  }

  /** Reconcile ONLY an existing exact Kernel receipt; never dispatch or read a target.
   * Read receipts are currently process-local in Kernel. Missing/evicted receipts
   * remain unresolved, including after Kernel restart. This is not exactly-once I/O.
   */
  reconcile(runId: string): AstraReadView {
    const view = this.required(runId), checkpoint = view.checkpoint, binding = checkpoint.invocation;
    if (!binding || !['dispatching', 'indeterminate', 'cancelling'].includes(checkpoint.phase)) return view;
    const record = this.options.kernel.getActionLedgerRecord(binding.idempotencyKey);
    if (!record) return view;
    if (record.idempotencyKey !== binding.idempotencyKey || record.proposalHash !== binding.proposalHash
      || record.proposalId !== runId || record.intentId !== runId || record.moduleId !== 'workspace'
      || record.capabilityId !== checkpoint.goal.capabilityId) failure('receipt-binding');
    if (!['completed', 'failed'].includes(record.status) || !record.result
      || record.error === 'interrupted-before-completion' || record.result.error === 'interrupted-before-completion') return view;
    if ((record.status === 'completed') !== record.result.ok) failure('receipt-status');
    if (checkpoint.phase === 'cancelling' || checkpoint.controlEpoch > 0) {
      return this.commit(view, 'reconcile-cancelled', { ...checkpoint, phase: 'cancelled', reason: 'cancelled-after-reservation' },
        { type: 'invocation.reconciled-after-cancel', kernelOk: record.result.ok });
    }
    return this.settle(view, record.result, binding.proposalHash, 'reconciled');
  }

  private async execute(view: AstraReadView): Promise<AstraReadView> {
    const initial = view.checkpoint, goal = initial.goal, runId = initial.runId;
    const admittedRevision = view.revision;
    let dispatched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(); this.controllers.set(runId, controller);
    const executionSignal = this.options.signal ? AbortSignal.any([controller.signal, this.options.signal]) : controller.signal;
    try {
      if (!this.dispatchAllowed()) failure('dispatch-fenced');
      const target = await this.target(goal.relativePath);
      if (!this.dispatchAllowed()) failure('dispatch-fenced');
      if (this.contractDigest() !== goal.contractDigest) failure('capability-changed');
      const proposal = this.options.kernel.prepareActionProposal({ capabilityId: goal.capabilityId,
        args: { path: target, maxBytes: goal.maxBytes }, proposalId: runId, reason: 'Astra V3 isolated exact read requirement.' },
      { requestedBy: 'agent:astra-v3', intentId: runId });
      // A replayable command receipt is not ownership of a dispatch. Each contender
      // uses a distinct reservation command so the durable expectedRevision CAS,
      // not identical-command replay, selects the single dispatching instance.
      view = this.commit(view, 'dispatch_' + randomUUID(), { ...initial, phase: 'dispatching',
        invocation: { proposalHash: proposal.canonicalHash, idempotencyKey: proposal.idempotencyKey } },
        { type: 'invocation.reserved', proposalHash: proposal.canonicalHash });
      // The durable reservation fences another runtime instance before Kernel I/O.
      dispatched = true;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort('deadline'); reject(new Error('astra-read:deadline-indeterminate')); }, goal.timeoutMs);
      });
      const execution = this.options.kernel.executeActionProposal(proposal, {
        requestedBy: 'agent:astra-v3', intentId: runId, source: 'desktop', signal: executionSignal,
        ...(this.options.dispatchGuard ? { dispatchGuard: this.options.dispatchGuard } : {}),
      });
      const returned = await Promise.race([execution, timeout]);
      clearTimeout(timer);
      view = this.required(runId);
      if (!['dispatching', 'cancelling', 'indeterminate'].includes(view.checkpoint.phase)) return view;
      if (view.checkpoint.controlEpoch !== initial.controlEpoch || controller.signal.aborted) {
        return this.commit(view, 'cancelled', { ...view.checkpoint, phase: 'cancelled', reason: 'cancelled-after-reservation' },
          { type: 'invocation.returned-after-cancel', kernelOk: returned.result.ok });
      }
      if (returned.proposal.canonicalHash !== proposal.canonicalHash) failure('proposal-binding');
      return this.settle(view, returned.result, proposal.canonicalHash, 'observed');
    } catch (error) {
      if (error instanceof AstraJournalError) {
        // Includes CAS races and failed receipt writes: never dispatch again or
        // fabricate a terminal success when persistence did not acknowledge it.
        if (error.code === 'revision-conflict') return this.required(runId);
        throw error;
      }
      const current = this.required(runId);
      if (!dispatched && !this.dispatchAllowed()) return current;
      if (['observed', 'failed', 'cancelled', 'paused'].includes(current.checkpoint.phase)) return current;
      // An asynchronous preflight/transport error from an old contender cannot
      // overwrite a pause, another reservation, or already reconciled evidence.
      if (!dispatched && current.revision !== admittedRevision) return current;
      const reason = error instanceof Error && error.message.startsWith('astra-read:')
        ? error.message.slice('astra-read:'.length) : 'execution-error';
      const unknown = dispatched && reason !== 'output-binding' && reason !== 'proposal-binding';
      const phase = current.checkpoint.phase === 'cancelling' ? 'cancelling' : unknown ? 'indeterminate' : 'failed';
      return this.commit(current, 'rejected', { ...current.checkpoint, phase, reason },
        { type: unknown ? 'invocation.indeterminate' : 'invocation.rejected', reason });
    } finally { if (timer) clearTimeout(timer); }
  }

  private settle(view: AstraReadView, result: MonarchExecutionResult, proposalHash: string,
    source: 'observed' | 'reconciled'): AstraReadView {
    // Kernel-owned last-boundary refusal is positive evidence of NO module call.
    // Only this read adapter may release the reservation for fresh admission; a
    // generic timeout/cancel/error is never treated as the same proof.
    const control = result.metadata?.dispatchControl as { dispatched?: unknown; reason?: unknown } | undefined;
    if (!result.ok && result.error === 'execution-dispatch-fenced' && control?.dispatched === false && control.reason === 'runtime-fence') {
      const next = { ...view.checkpoint, phase: 'ready', reason: 'known-not-dispatched' } as AstraReadCheckpoint;
      delete next.invocation;
      return this.commit(view, source + '-not-dispatched', next, { type: 'invocation.not-dispatched', proposalHash });
    }
    if (!result.ok) return this.commit(view, source + '-failed',
      { ...view.checkpoint, phase: 'failed', reason: result.error ?? 'kernel-failed' },
      { type: 'invocation.failed', code: result.error ?? 'kernel-failed', source });
    const goal = view.checkpoint.goal, target = path.resolve(this.root, goal.relativePath);
    const output = result.output as Record<string, unknown> | undefined;
    if (!output || typeof output.path !== 'string' || !samePath(output.path, target)
      || typeof output.content !== 'string' || !Number.isSafeInteger(output.sizeBytes)
      || Number(output.sizeBytes) < 0 || Number(output.sizeBytes) > goal.maxBytes
      || Buffer.byteLength(output.content, 'utf8') !== output.sizeBytes) failure('output-binding');
    const observation: AstraReadObservation = { content: output.content, sizeBytes: Number(output.sizeBytes),
      contentDigest: sha(output.content), targetDigest: sha(target.toLowerCase()), proposalHash };
    const next = { ...view.checkpoint, phase: 'observed', observation } as AstraReadCheckpoint;
    delete next.reason;
    return this.commit(view, source, next,
      { type: 'invocation.' + source, contentDigest: observation.contentDigest, sizeBytes: observation.sizeBytes });
  }

  private commit(before: AstraReadView, suffix: string, checkpoint: AstraReadCheckpoint, event: AstraJson): AstraReadView {
    this.options.journal.append({ streamId: checkpoint.runId, requestId: `${suffix}_${before.revision}`,
      expectedRevision: before.revision, events: [event], checkpoint: json(checkpoint) });
    return this.required(checkpoint.runId);
  }
  private required(runId: string): AstraReadView { return this.read(runId) ?? failure('missing-run'); }
  private contractDigest(): string {
    const capability = this.options.kernel.listCapabilities().find(item => item.id === 'workspace.files.read');
    if (!capability || capability.moduleId !== 'workspace' || capability.risk !== 'read') failure('capability-unavailable');
    return sha(astraJournalJson(json(capability)));
  }
  private dispatchAllowed(): boolean {
    try { return !this.options.signal?.aborted && (!this.options.dispatchGuard || this.options.dispatchGuard() === true); }
    catch { return false; }
  }
  private relative(value: string): void {
    validateRelative(value);
  }
  private async target(relative: string): Promise<string> {
    this.relative(relative);
    // The Kernel still performs its own current filesystem/permission checks.
    // This grant narrows its broader local-read scope; it is not Windows handle
    // containment against hostile concurrent reparse replacement.
    if (!samePath(await realpath(this.root), this.root) || (await lstat(this.root)).isSymbolicLink()) failure('root-alias');
    let current = this.root;
    for (const part of relative.split(/[\\/]/u)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink() || !samePath(await realpath(current), current)) failure('target-alias');
    }
    const remainder = path.relative(this.root, current);
    if (!remainder || remainder.startsWith('..') || path.isAbsolute(remainder)) failure('outside-root');
    return current;
  }
}
