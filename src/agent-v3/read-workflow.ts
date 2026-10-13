import { createHash } from 'node:crypto';
import { astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';
import { AstraReadRuntime, validateAstraReadRequest, type AstraReadRequest, type AstraReadView } from './read-runtime';

// First deterministic TaskGraph executor: exact read requirements only. No model,
// arbitrary tool name, effect execution, native admission or completion certificate.
// The host owns one journal and the read adapter; raw content is NOT duplicated here.
export interface AstraReadStep extends Omit<AstraReadRequest, 'requestId'> { id: string; dependsOn?: string[] }
export interface AstraReadWorkflowRequest { requestId: string; steps: AstraReadStep[] }
type StepState = 'waiting' | 'pending' | 'observed' | 'failed' | 'blocked' | 'indeterminate' | 'cancelled';
interface WorkflowStep {
  id: string; relativePath: string; maxBytes: number; timeoutMs: number; dependsOn: string[];
  readRequestId: string; state: StepState; readRunId?: string; readRevision?: number; contentDigest?: string; reason?: string;
}
export interface AstraReadWorkflowCheckpoint {
  schemaVersion: 'monarch.astra-v3-read-workflow.internal.v1';
  runId: string; goalDigest: string; scopeDigest: string; controlEpoch: number;
  phase: 'ready' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'observed' | 'partial' | 'failed' | 'indeterminate' | 'cancelled';
  steps: WorkflowStep[];
}
export interface AstraReadWorkflowView { revision: number; checkpoint: AstraReadWorkflowCheckpoint; nativeCompletionCertified: false }
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-workflow:' + code); }
const identity = (value: string): boolean => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(value);
const immutableSteps = (steps: WorkflowStep[]): AstraJson => json(steps.map(step => ({
  id: step.id, relativePath: step.relativePath, maxBytes: step.maxBytes, timeoutMs: step.timeoutMs,
  dependsOn: step.dependsOn, readRequestId: step.readRequestId, state: 'waiting',
})));

export class AstraReadWorkflow {
  private readonly flights = new Map<string, Promise<AstraReadWorkflowView>>();
  constructor(private readonly journal: AstraJournalAccess, private readonly reads: AstraReadRuntime,
    private readonly options: { mutationGuard?: () => boolean } = {}) {}

  admit(request: AstraReadWorkflowRequest): AstraReadWorkflowView {
    const checkpoint = AstraReadWorkflow.compile(request, this.reads.scopeDigest);
    const { runId, goalDigest, steps } = checkpoint;
    const previous = this.read(runId);
    if (previous) { requireValue(previous.checkpoint.goalDigest === goalDigest, 'request-conflict'); return previous; }
    this.assertMutationCurrent();
    this.journal.append({ streamId: runId, requestId: 'admit_' + request.requestId, expectedRevision: 0,
      checkpoint: json(checkpoint), events: [{ type: 'workflow.accepted', goalDigest, steps: steps.length }] });
    return this.required(runId);
  }

  /** Pure Goal compilation; safe to use before adding a job to a durable queue. */
  static compile(request: AstraReadWorkflowRequest, scopeDigest: string): AstraReadWorkflowCheckpoint {
    requireValue(Object.keys(request).every(key => ['requestId', 'steps'].includes(key)), 'request-fields');
    requireValue(identity(request.requestId), 'request-identity');
    requireValue(Array.isArray(request.steps) && request.steps.length > 0 && request.steps.length <= 32, 'step-budget');
    const runId = 'workflow_' + sha(request.requestId).slice(0, 32);
    const steps: WorkflowStep[] = request.steps.map(step => {
      requireValue(Object.keys(step).every(key => ['id', 'relativePath', 'maxBytes', 'timeoutMs', 'dependsOn'].includes(key)), 'step-fields');
      requireValue(identity(step.id), 'step-identity');
      requireValue(typeof step.relativePath === 'string' && step.relativePath.length > 0 && step.relativePath.length <= 1024, 'step-target');
      const maxBytes = step.maxBytes ?? 65536, timeoutMs = step.timeoutMs ?? 5000;
      requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 524288
        && Number.isSafeInteger(timeoutMs) && timeoutMs >= 50 && timeoutMs <= 10000, 'step-budget');
      requireValue(step.dependsOn === undefined || Array.isArray(step.dependsOn), 'dependencies');
      const dependsOn = step.dependsOn ? [...step.dependsOn].sort() : [];
      requireValue(dependsOn.length <= 31 && dependsOn.every(identity) && new Set(dependsOn).size === dependsOn.length, 'dependencies');
      const readRequestId = 'step_' + sha(runId + '\0' + step.id);
      validateAstraReadRequest({ requestId: readRequestId, relativePath: step.relativePath, maxBytes, timeoutMs });
      return { id: step.id, relativePath: step.relativePath, maxBytes, timeoutMs, dependsOn, readRequestId, state: 'waiting' };
    });
    requireValue(new Set(steps.map(step => step.id)).size === steps.length, 'duplicate-step');
    const known = new Set(steps.map(step => step.id)), visited = new Set<string>();
    requireValue(steps.every(step => step.dependsOn.every(id => known.has(id))), 'unknown-dependency');
    // Kahn-style progress check; no recursive traversal or unbounded graph expansion.
    while (visited.size < steps.length) {
      const next = steps.find(step => !visited.has(step.id) && step.dependsOn.every(id => visited.has(id)));
      requireValue(next, 'dependency-cycle'); visited.add(next.id);
    }
    // Result content and changing step status are outside the immutable Goal digest.
    const goalDigest = 'sha256:' + sha(astraJournalJson(immutableSteps(steps)));
    return { schemaVersion: 'monarch.astra-v3-read-workflow.internal.v1',
      runId, goalDigest, scopeDigest, controlEpoch: 0, phase: 'ready', steps };
  }

  read(runId: string): AstraReadWorkflowView | null {
    const snapshot = this.journal.read(runId);
    if (!snapshot) return null;
    const checkpoint = snapshot.checkpoint as unknown as AstraReadWorkflowCheckpoint;
    requireValue(checkpoint.schemaVersion === 'monarch.astra-v3-read-workflow.internal.v1' && checkpoint.runId === runId
      && checkpoint.scopeDigest === this.reads.scopeDigest && Number.isSafeInteger(checkpoint.controlEpoch) && checkpoint.controlEpoch >= 0
      && ['ready', 'running', 'pausing', 'paused', 'cancelling', 'observed', 'partial', 'failed', 'indeterminate', 'cancelled'].includes(checkpoint.phase)
      && Array.isArray(checkpoint.steps) && checkpoint.steps.length > 0 && checkpoint.steps.length <= 32, 'checkpoint');
    requireValue(checkpoint.goalDigest === 'sha256:' + sha(astraJournalJson(immutableSteps(checkpoint.steps))), 'checkpoint-goal');
    for (const step of checkpoint.steps) {
      requireValue(['waiting', 'pending', 'observed', 'failed', 'blocked', 'indeterminate', 'cancelled'].includes(step.state)
        && step.readRequestId === 'step_' + sha(runId + '\0' + step.id), 'checkpoint-step');
      if (step.state === 'observed') {
        const child = step.readRunId ? this.reads.read(step.readRunId) : null;
        requireValue(child?.checkpoint.phase === 'observed' && child.revision === step.readRevision
          && child.checkpoint.observation?.contentDigest === step.contentDigest
          && child.checkpoint.goal.relativePath === step.relativePath
          && child.checkpoint.goal.maxBytes === step.maxBytes, 'checkpoint-evidence');
      }
    }
    return { revision: snapshot.revision, checkpoint, nativeCompletionCertified: false };
  }

  async run(request: AstraReadWorkflowRequest, options: { maxSteps?: number } = {}): Promise<AstraReadWorkflowView> {
    const maxSteps = options.maxSteps ?? 32;
    requireValue(Number.isSafeInteger(maxSteps) && maxSteps > 0 && maxSteps <= 32, 'activation-step-budget');
    const accepted = this.admit(request), runId = accepted.checkpoint.runId;
    const existing = this.flights.get(runId);
    if (existing) return existing;
    const flight = this.drive(runId, maxSteps).finally(() => this.flights.delete(runId));
    this.flights.set(runId, flight);
    return flight;
  }

  cancel(runId: string): AstraReadWorkflowView {
    let current = this.required(runId);
    if (['observed', 'partial', 'failed', 'cancelled'].includes(current.checkpoint.phase)) return current;
    if (current.checkpoint.phase !== 'cancelling') current = this.commit(current,
      { ...current.checkpoint, phase: 'cancelling', controlEpoch: current.checkpoint.controlEpoch + 1 }, 'workflow.cancel-requested');
    // Parent cancellation is durable first. Reconstruction repeats this propagation
    // before starting any child, closing the parent/child-store crash window.
    return this.propagateCancel(current);
  }

  pause(runId: string): AstraReadWorkflowView {
    const current = this.required(runId);
    if (['observed', 'partial', 'failed', 'cancelled', 'cancelling', 'paused'].includes(current.checkpoint.phase)) return current;
    const pending = current.checkpoint.phase === 'pausing' ? current : this.commit(current,
      { ...current.checkpoint, phase: 'pausing', controlEpoch: current.checkpoint.controlEpoch + 1 }, 'workflow.pause-requested');
    // Read-only safe-boundary pause: already reserved I/O may finish; no new child
    // is dispatched. An uncertain read does not become quiescent merely by timeout.
    return this.settlePause(pending);
  }

  resume(runId: string): AstraReadWorkflowView {
    const current = this.required(runId);
    if (current.checkpoint.phase === 'ready') return current;
    requireValue(current.checkpoint.phase === 'paused', 'not-paused-or-not-quiescent');
    // This is the isolated read graph's control transition, not native Activation.
    // Every subsequent child still performs current Kernel/capability/path preflight.
    return this.commit(current, { ...current.checkpoint, phase: 'ready', controlEpoch: current.checkpoint.controlEpoch + 1 }, 'workflow.resume-requested');
  }

  /** Read exact child state/receipts only; never start a read while reconciling. */
  reconcile(runId: string): AstraReadWorkflowView {
    const current = this.required(runId);
    if (current.checkpoint.phase === 'cancelling') return this.propagateCancel(current);
    if (current.checkpoint.phase === 'pausing') return this.settlePause(current);
    if (['observed', 'partial', 'failed', 'cancelled', 'paused'].includes(current.checkpoint.phase)) return current;
    const steps = current.checkpoint.steps.map(step => {
      if (!step.readRunId || !['pending', 'indeterminate'].includes(step.state)) return step;
      const child = this.reads.reconcile(step.readRunId);
      return { ...step, ...this.project(child),
        ...(['ready', 'paused'].includes(child.checkpoint.phase) ? { state: 'waiting' as const } : {}) };
    });
    const states = steps.map(step => step.state);
    const phase = states.every(state => state === 'observed') ? 'observed'
      : states.some(state => ['pending', 'indeterminate'].includes(state)) ? 'indeterminate'
        : states.some(state => state === 'waiting') ? 'ready' : states.some(state => state === 'observed') ? 'partial' : 'failed';
    if (phase === current.checkpoint.phase && astraJournalJson(json(steps)) === astraJournalJson(json(current.checkpoint.steps))) return current;
    return this.commit(current, { ...current.checkpoint, steps, phase }, 'workflow.reconciled');
  }

  private async drive(runId: string, maxSteps: number): Promise<AstraReadWorkflowView> {
    let current = this.required(runId);
    if (current.checkpoint.phase === 'cancelling') return this.propagateCancel(current);
    if (current.checkpoint.phase === 'pausing') return this.settlePause(current);
    if (current.checkpoint.phase === 'paused') return current;
    if (['observed', 'partial', 'failed', 'cancelled'].includes(current.checkpoint.phase)) return current;
    if (current.checkpoint.phase !== 'running') current = this.commit(current, { ...current.checkpoint, phase: 'running' }, 'workflow.started');
    // Sequential by design: bounded active Kernel work, stable dependency order.
    // A process-wide scheduler/worker lease is a separate admission dependency.
    const attempted = new Set<string>();
    for (;;) {
      current = this.required(runId);
      if (current.checkpoint.phase === 'cancelling') return this.propagateCancel(current);
      if (current.checkpoint.phase === 'cancelled') return current;
      if (current.checkpoint.phase === 'pausing') return this.settlePause(current);
      if (current.checkpoint.phase === 'paused') return current;
      const states = new Map(current.checkpoint.steps.map(step => [step.id, step.state]));
      const blocked = current.checkpoint.steps.filter(step => step.state === 'waiting'
        && step.dependsOn.some(id => ['failed', 'blocked', 'cancelled'].includes(states.get(id)!)));
      if (blocked.length) {
        current = this.commit(current, { ...current.checkpoint, steps: current.checkpoint.steps.map(step => blocked.includes(step)
          ? { ...step, state: 'blocked', reason: 'dependency-unsatisfied' } : step) }, 'workflow.dependencies-blocked');
        continue;
      }
      const step = current.checkpoint.steps.find(candidate => !attempted.has(candidate.id)
        && ['waiting', 'pending', 'indeterminate'].includes(candidate.state)
        && candidate.dependsOn.every(id => states.get(id) === 'observed'));
      if (!step) break;
      if (attempted.size >= maxSteps) return this.commit(current, { ...current.checkpoint, phase: 'ready' }, 'workflow.activation-yielded');
      attempted.add(step.id);
      const childRequest = { requestId: step.readRequestId, relativePath: step.relativePath, maxBytes: step.maxBytes, timeoutMs: step.timeoutMs };
      let child = this.reads.admit(childRequest);
      if (child.checkpoint.phase === 'paused') child = this.reads.resumeReady(child.checkpoint.runId);
      current = this.patchStep(current, step.id, { state: 'pending', readRunId: child.checkpoint.runId }, 'workflow.step-reserved');
      // Child Kernel reservation survives a lost parent update. Run never blindly
      // repeats an indeterminate child; reconcile inspects only its exact receipt.
      let result = await this.reads.run(childRequest);
      if (['dispatching', 'indeterminate'].includes(result.checkpoint.phase)) result = this.reads.reconcile(result.checkpoint.runId);
      current = this.required(runId);
      if (current.checkpoint.phase === 'cancelling') return this.propagateCancel(current);
      if (current.checkpoint.phase === 'cancelled') return current;
      if (current.checkpoint.phase === 'paused') return current;
      current = this.patchStep(current, step.id, this.project(result), 'workflow.step-returned');
    }
    const states = current.checkpoint.steps.map(step => step.state);
    const phase = states.every(state => state === 'observed') ? 'observed'
      : states.some(state => ['waiting', 'pending', 'indeterminate'].includes(state)) ? 'indeterminate'
        : states.some(state => state === 'observed') ? 'partial' : 'failed';
    return this.commit(current, { ...current.checkpoint, phase }, 'workflow.settled');
  }

  private settlePause(current: AstraReadWorkflowView): AstraReadWorkflowView {
    const steps = current.checkpoint.steps.map(step => {
      if (!step.readRunId || !['pending', 'indeterminate'].includes(step.state)) return step;
      let child = this.reads.read(step.readRunId);
      requireValue(child, 'missing-child');
      if (child.checkpoint.phase === 'ready') child = this.reads.parkReady(step.readRunId);
      if (child.checkpoint.phase === 'paused') return { ...step, state: 'waiting' as const, readRevision: child.revision };
      if (['dispatching', 'indeterminate', 'cancelling'].includes(child.checkpoint.phase)) child = this.reads.reconcile(step.readRunId);
      return { ...step, ...this.project(child) };
    });
    const phase = steps.some(step => ['pending', 'indeterminate'].includes(step.state)) ? 'pausing' : 'paused';
    if (phase === current.checkpoint.phase && astraJournalJson(json(steps)) === astraJournalJson(json(current.checkpoint.steps))) return current;
    return this.commit(current, { ...current.checkpoint, phase, steps }, 'workflow.pause-settled');
  }

  private propagateCancel(current: AstraReadWorkflowView): AstraReadWorkflowView {
    const steps = current.checkpoint.steps.map(step => {
      if (['observed', 'failed', 'blocked', 'cancelled'].includes(step.state)) return step;
      if (!step.readRunId) return { ...step, state: 'cancelled' as const, reason: 'parent-cancelled-before-dispatch' };
      let child = this.reads.cancel(step.readRunId, 'parent_' + current.checkpoint.controlEpoch);
      if (child.checkpoint.phase === 'cancelling') child = this.reads.reconcile(step.readRunId);
      return { ...step, ...this.project(child) };
    });
    const pending = steps.some(step => ['pending', 'indeterminate', 'waiting'].includes(step.state));
    return this.commit(current, { ...current.checkpoint, steps, phase: pending ? 'cancelling' : 'cancelled' }, 'workflow.cancel-propagated');
  }
  private project(child: AstraReadView): Partial<WorkflowStep> {
    const phase = child.checkpoint.phase;
    const state: StepState = ['observed', 'failed', 'cancelled'].includes(phase) ? phase as StepState : 'indeterminate';
    return { state, readRunId: child.checkpoint.runId, readRevision: child.revision,
      ...(child.checkpoint.observation ? { contentDigest: child.checkpoint.observation.contentDigest } : {}),
      ...(child.checkpoint.reason ? { reason: child.checkpoint.reason } : {}) };
  }
  private patchStep(current: AstraReadWorkflowView, id: string, patch: Partial<WorkflowStep>, event: string): AstraReadWorkflowView {
    return this.commit(current, { ...current.checkpoint, steps: current.checkpoint.steps.map(step => {
      if (step.id !== id) return step;
      const next = { ...step, ...patch };
      if (next.state === 'observed') delete next.reason;
      return next;
    }) }, event);
  }
  private commit(before: AstraReadWorkflowView, checkpoint: AstraReadWorkflowCheckpoint, type: string): AstraReadWorkflowView {
    this.assertMutationCurrent();
    this.journal.append({ streamId: checkpoint.runId, requestId: 'transition_' + before.revision,
      expectedRevision: before.revision, checkpoint: json(checkpoint), events: [{ type, phase: checkpoint.phase }] });
    return this.required(checkpoint.runId);
  }
  private assertMutationCurrent(): void {
    let current = false;
    try { current = !this.options.mutationGuard || this.options.mutationGuard() === true; } catch { /* Deny stale/unreadable ownership. */ }
    requireValue(current, 'activation-fenced');
  }
  private required(runId: string): AstraReadWorkflowView {
    const view = this.read(runId); requireValue(view, 'missing-run'); return view;
  }
}
