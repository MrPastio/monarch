import { createHash } from 'node:crypto';
import { MonarchKernel } from '../core/kernel';
import { AstraJournal, astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';
import { AstraReadRuntime, astraReadRunId } from './read-runtime';
import { AstraReadWorkflow, type AstraReadWorkflowRequest, type AstraReadWorkflowView } from './read-workflow';
import type { AstraWorkAdapter, AstraWorkControl, AstraWorkResult } from './work-scheduler';

const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
export const astraReadWorkRequestId = (scopeId: string, jobId: string): string => 'work_' + sha(scopeId + '/' + jobId).slice(7, 39);

/** First registered pack for the common scheduler. No default app import/activation.
 * Each activation uses exactly one graph step and captures its own immutable fence.
 * Control/recovery use a fresh owner-bound view, not the old activation's generation.
 */
export class AstraReadWorkAdapter implements AstraWorkAdapter {
  readonly id = 'workspace-read';
  readonly version: 'v1' | 'v2';
  constructor(private readonly options: { canonicalRoot: string; kernel: MonarchKernel; journal: AstraJournal; restartSafeAdmission?: boolean }) {
    this.version = options.restartSafeAdmission ? 'v2' : 'v1';
  }

  compile(input: AstraJson, context: { jobId: string; scopeId: string; controlBudget: number }): ReturnType<AstraWorkAdapter['compile']> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('astra-read-adapter:request-shape');
    const requestId = astraReadWorkRequestId(context.scopeId, context.jobId);
    if ('requestId' in input && input.requestId !== requestId) throw new Error('astra-read-adapter:request-identity-owner');
    const request = this.request({ ...input, requestId }), reads = this.reads();
    const compiled = AstraReadWorkflow.compile(request, reads.scopeDigest);
    const maximumRead = Math.max(...compiled.steps.map(step => step.maxBytes));
    // Until read results have a retained binary-artifact representation, admit
    // only a bound that fits even maximally escaped JSON. Do not accept a large
    // goal and discover after its Kernel call that evidence cannot be retained.
    if (8192 + 6 * maximumRead > 1024 * 1024) throw new Error('astra-read-adapter:evidence-storage-budget');
    const normalizedInput = json(request);
    return { input: normalizedInput, resources: { kernelSlots: 1, modelSlots: 0,
      declaredBytes: 1024 * 1024 + 4 * maximumRead + Buffer.byteLength(astraJournalJson(normalizedInput)), exclusiveKeys: [] },
      bindingDigest: this.bindingDigest('admission'), storage: {
        maxActivations: compiled.steps.length + 2 * context.controlBudget + 8,
        streams: [
          { streamId: compiled.runId, commits: 16 + 8 * compiled.steps.length + 4 * context.controlBudget,
            eventBytes: (16 + 8 * compiled.steps.length + 4 * context.controlBudget) * 4096,
            checkpointBytes: Buffer.byteLength(astraJournalJson(json(compiled))) + compiled.steps.length * 1024 + 4096 },
          ...compiled.steps.map(step => ({ streamId: astraReadRunId(step.readRequestId),
            commits: 8 + 4 * context.controlBudget, eventBytes: (8 + 4 * context.controlBudget) * 4096,
            checkpointBytes: 8192 + 6 * step.maxBytes })),
        ],
      } };
  }

  async execute(input: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult> {
    if (!control.isCurrent()) throw new Error('astra-read-adapter:activation-fenced');
    const bindingDigest = this.bindingDigest();
    const current = (): boolean => {
      try { return control.isCurrent() && this.bindingDigest() === bindingDigest; } catch { return false; }
    };
    const reads = this.reads(current, control.signal, control.journal);
    const workflow = new AstraReadWorkflow(control.journal, reads, { mutationGuard: current });
    const request = this.request(input), initial = workflow.admit(request);
    // A previous owner may have left a pending checkpoint after a known child
    // result. Reconciliation reads exact receipts before a new activation runs.
    workflow.reconcile(initial.checkpoint.runId);
    return this.project(await workflow.run(request, { maxSteps: 1 }));
  }

  control(input: AstraJson, command: 'pause' | 'resume' | 'cancel', ownerIsCurrent: () => boolean, journal = this.options.journal as AstraJournalAccess): AstraWorkResult {
    const workflow = new AstraReadWorkflow(journal, this.reads(ownerIsCurrent, undefined, journal), { mutationGuard: ownerIsCurrent });
    const accepted = workflow.admit(this.request(input));
    return this.project(command === 'pause' ? workflow.pause(accepted.checkpoint.runId)
      : command === 'resume' ? workflow.resume(accepted.checkpoint.runId) : workflow.cancel(accepted.checkpoint.runId));
  }

  reconcile(input: AstraJson, ownerIsCurrent: () => boolean, journal = this.options.journal as AstraJournalAccess): AstraWorkResult {
    const workflow = new AstraReadWorkflow(journal, this.reads(ownerIsCurrent, undefined, journal), { mutationGuard: ownerIsCurrent });
    const request = this.request(input), compiled = AstraReadWorkflow.compile(request, this.reads().scopeDigest);
    const existing = workflow.read(compiled.runId);
    if (!existing) {
      // No child was admitted, hence no invocation can belong to this exact graph.
      return { state: 'queued', checkpointRef: compiled.runId, checkpointRevision: 0,
        progressDigest: compiled.goalDigest, reason: 'no-child-admission' };
    }
    return this.project(workflow.reconcile(existing.checkpoint.runId));
  }

  private project(view: AstraReadWorkflowView): AstraWorkResult {
    const checkpoint = view.checkpoint;
    // Exclude event/heartbeat counts from the fingerprint: extra bookkeeping alone
    // cannot make an unproductive adapter appear to have made semantic progress.
    const progressDigest = sha(astraJournalJson(json({ goalDigest: checkpoint.goalDigest, steps: checkpoint.steps.map(step => ({
      id: step.id, state: step.state, readRevision: step.readRevision ?? null, contentDigest: step.contentDigest ?? null,
    })) })));
    return { state: checkpoint.phase === 'ready' ? 'queued' : checkpoint.phase === 'running' ? 'indeterminate' : checkpoint.phase,
      progressDigest, checkpointRef: checkpoint.runId, checkpointRevision: view.revision };
  }
  private request(input: AstraJson): AstraReadWorkflowRequest {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['requestId', 'steps'].includes(key))) throw new Error('astra-read-adapter:request-shape');
    // Pure compilation validates every step/target/dependency before queueing.
    const request = JSON.parse(astraJournalJson(input)) as AstraReadWorkflowRequest;
    AstraReadWorkflow.compile(request, this.reads().scopeDigest);
    return request;
  }
  private reads(dispatchGuard?: () => boolean, signal?: AbortSignal, journal = this.options.journal as AstraJournalAccess): AstraReadRuntime {
    return new AstraReadRuntime({ deployment: 'isolated-validation', ...this.options, journal,
      ...(dispatchGuard ? { dispatchGuard } : {}), ...(signal ? { signal } : {}) });
  }
  private bindingDigest(phase: 'admission' | 'activation' = 'activation'): string {
    const readiness = this.options.kernel.getCapabilityReadiness('workspace.files.read');
    if (!readiness || readiness.status !== 'active') throw new Error('astra-read-adapter:capability-not-active');
    const reads = this.reads();
    // Only the explicitly assembled v2 cohort separates durable admission from
    // volatile process readiness. execute() always pins FULL fresh readiness,
    // including Kernel instance/lifecycle, across async preflight and dispatch.
    const binding = phase === 'admission' && this.version === 'v2'
      ? { capabilityId: readiness.capabilityId, moduleId: readiness.moduleId, moduleVersion: readiness.moduleVersion, status: readiness.status }
      : readiness;
    return sha(astraJournalJson(json({ version: this.version, scopeDigest: reads.scopeDigest,
      capabilityDigest: reads.capabilityDigest, readiness: binding })));
  }
}
