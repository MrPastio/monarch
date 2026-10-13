import { createHash, randomUUID } from 'node:crypto';
import { astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';
import { validateAstraContextSource, type AstraContextLimits, type AstraContextPlan, type AstraContextSource } from './context-engine';
import { AstraPreparedModelClient, type AstraModelOpenRequest, type AstraModelTurn,
  type AstraPreparedModelInput, type AstraPreparedModelOutput } from './prepared-model-client';
import { decideAstraModel, type AstraStructuredModelDecision, type AstraReadModelTrace } from './read-model-decision';
import type { AstraReadCandidate } from './read-decision-gateway';
import type { AstraCreateCandidate } from './create-decision-gateway';
import { astraAgentArgsJsonChars, type AstraAgentCapabilityCandidate, type AstraAgentCapabilityPage, type AstraAgentEvidenceRef } from './agent-decision-gateway';
import { astraModelDecisionProfile, ASTRA_MODEL_RESERVED_REFS } from './model-decision-profile';
import { validateAstraReadRequest } from './read-runtime';
import type { AstraWorkAdapter, AstraWorkControl, AstraWorkResult } from './work-scheduler';

export interface AstraModelWorkInput {
  /** Host-owned memory version; retained with input and every remote attempt. */
  memoryValidityToken?: string;
  source: AstraContextSource; candidates: AstraReadCandidate[]; catalogRevision: number; expectedModelDigest: string;
  /** Exact dynamic provider/model role; host validates it against the digest. */
  modelId?: string;
  /** Closed create family: candidates must be empty, never a fake read target. */
  createCandidate?: AstraCreateCandidate;
  /** Closed generic-agent family. Capabilities are host-admitted snapshots, not model-authored IDs. */
  agentCandidates?: AstraAgentCapabilityCandidate[];
  agentPages?: AstraAgentCapabilityPage[];
  agentEvidence?: AstraAgentEvidenceRef[];
  agentMinimumCompletionEvidence?: number;
  maxOutputTokens?: number; timeoutMs?: number; maxAttempts?: number; contextLimits?: Partial<AstraContextLimits>;
  workId?: string; contextExecutionId?: string;
}
interface CompiledInput extends AstraModelWorkInput {
  workId: string; contextExecutionId: string; maxOutputTokens: number; timeoutMs: number; maxAttempts: number;
}
export interface AstraModelWorkCheckpoint {
  schemaVersion: 'monarch.astra-v3-model-work.internal.v1'; workId: string; inputDigest: string;
  phase: 'ready' | 'remote-pending' | 'prepared' | 'returned' | 'settled';
  desired: 'run' | 'pause' | 'cancel'; attempts: number; quiescent: boolean;
  remote?: { descriptor: { hostGeneration: string; endpointDigest: string }; request: AstraModelOpenRequest & { notAfterMs: number } };
  turn?: AstraModelTurn; seal?: AstraPreparedModelInput;
  contextFrontier?: { streamId: string; revision: number; commitHash: string };
  output?: AstraPreparedModelOutput; decision?: AstraStructuredModelDecision; reason?: string;
}
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-model-work:' + code); }
const same = (a: unknown, b: unknown): boolean => astraJournalJson(json(a)) === astraJournalJson(json(b));

export function astraModelWorkProgressDigest(checkpoint: Pick<AstraModelWorkCheckpoint,
  'phase' | 'desired' | 'attempts' | 'quiescent' | 'decision'>): string {
  return sha(astraJournalJson(json({ phase: checkpoint.phase, desired: checkpoint.desired,
    attempts: checkpoint.attempts, quiescent: checkpoint.quiescent, decision: checkpoint.decision ?? null })));
}

/** Durable one-decision work pack, not a second scheduler or a tool executor.
 * Intent and exact prepared seal are committed before their remote side; native
 * output is retained before interpretation. Unknown physical work keeps the
 * scheduler's slot. Recovery either uses saved output or fences the exact old
 * request through its absolute deadline before a bounded new attempt is possible.
 */
export class AstraModelWorkAdapter implements AstraWorkAdapter {
  readonly id: string;
  readonly version = 'v1';
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly options: { deployment: 'isolated-validation'; journal: AstraJournalAccess;
    modelClients?: Readonly<Record<string, AstraPreparedModelClient>>;
    clientForInput?: (input: AstraModelWorkInput) => AstraPreparedModelClient | undefined;
    client: AstraPreparedModelClient; isSourceCurrent: (input: AstraModelWorkInput) => boolean; decisionFamily?: 'read' | 'create' | 'agent';
    validateSource?: (input: AstraModelWorkInput, signal: AbortSignal) => Promise<boolean> }) {
    check(options.deployment === 'isolated-validation', 'deployment');
    this.id = options.decisionFamily === 'create' ? 'prepared-create-model'
      : options.decisionFamily === 'agent' ? 'prepared-agent-model' : 'prepared-read-model';
  }

  private client(input: AstraModelWorkInput): AstraPreparedModelClient {
    const selected = this.options.clientForInput?.(input) ?? this.options.modelClients?.[input.expectedModelDigest];
    check(!selected || input.memoryValidityToken === undefined, 'cloud-memory-forbidden');
    return selected ?? this.options.client;
  }

  compile(raw: AstraJson, context: { jobId: string; scopeId: string; controlBudget: number }): ReturnType<AstraWorkAdapter['compile']> {
    check(raw && typeof raw === 'object' && !Array.isArray(raw)
      && Object.keys(raw).every(key => ['source', 'candidates', 'catalogRevision', 'expectedModelDigest', 'maxOutputTokens',
        'timeoutMs', 'maxAttempts', 'contextLimits', 'workId', 'contextExecutionId', 'createCandidate', 'agentCandidates',
        'agentPages', 'agentEvidence', 'agentMinimumCompletionEvidence', 'memoryValidityToken', 'modelId'].includes(key)), 'input-shape');
    const input = JSON.parse(astraJournalJson(raw)) as AstraModelWorkInput;
    const workId = 'model_work_' + sha(context.scopeId + '/' + context.jobId).slice(7, 39);
    const contextExecutionId = 'model_context_' + sha(workId).slice(7, 39);
    check((input.workId === undefined || input.workId === workId)
      && (input.contextExecutionId === undefined || input.contextExecutionId === contextExecutionId), 'identity-owner');
    validateAstraContextSource(input.source);
    check(!input.source.mandatory.some(item => ASTRA_MODEL_RESERVED_REFS.includes(item.ref)), 'reserved-context-reference');
    this.profile(input);
    check(new Set(input.candidates.map(item => item.handle)).size === input.candidates.length
      && new Set(input.candidates.map(item => item.requirementId)).size === input.candidates.length, 'candidate-identity');
    input.candidates.forEach(item => validateAstraReadRequest(item.request));
    check(/^sha256:[0-9a-f]{64}$/u.test(input.expectedModelDigest)
      && (input.modelId === undefined || typeof input.modelId === 'string' && /^[\x21-\x7e]{1,200}$/u.test(input.modelId))
      && (input.memoryValidityToken === undefined || typeof input.memoryValidityToken === 'string'
        && /^sha256:[0-9a-f]{64}$/u.test(input.memoryValidityToken))
      && Number.isSafeInteger(input.catalogRevision) && input.catalogRevision >= 0, 'binding');
    const normalized: CompiledInput = { ...input, workId, contextExecutionId,
      maxOutputTokens: input.maxOutputTokens ?? 256, timeoutMs: input.timeoutMs ?? 60000, maxAttempts: input.maxAttempts ?? 2 };
    check(Number.isSafeInteger(normalized.maxOutputTokens) && normalized.maxOutputTokens >= 1 && normalized.maxOutputTokens <= 65_536
      && Number.isSafeInteger(normalized.timeoutMs) && normalized.timeoutMs >= 20 && normalized.timeoutMs <= 600_000
      && Number.isSafeInteger(normalized.maxAttempts) && normalized.maxAttempts >= 1 && normalized.maxAttempts <= 4, 'budget');
    const contextLimits = normalized.contextLimits;
    if (contextLimits) check(Object.keys(contextLimits).every(key => ['hardTokens', 'softTokens', 'rearmTokens', 'reservedOutputTokens',
      'hardBytes', 'recentNarrativeItems', 'minimumSavedTokens', 'tokenizerTimeoutMs'].includes(key))
      && Object.values(contextLimits).every(value => Number.isSafeInteger(value) && value >= 0)
      && (contextLimits.reservedOutputTokens === undefined || contextLimits.reservedOutputTokens === normalized.maxOutputTokens), 'context-limits');
    check(this.current(normalized), 'source-stale');
    const declaredContextBytes = normalized.contextLimits?.hardBytes;
    const inputBudget = declaredContextBytes === undefined ? 65_536
      : Math.min(640 * 1024, Math.max(65_536, declaredContextBytes + 128 * 1024));
    const encoded = astraJournalJson(json(normalized)); check(Buffer.byteLength(encoded) <= inputBudget, 'input-budget');
    const commits = 24 + 8 * normalized.maxAttempts + 4 * context.controlBudget;
    // The shared watchdog must cover the admitted end-to-end model deadline plus
    // bounded transport/retention cleanup. This grants no extra generation time.
    return { input: json(normalized), activationBudgetMs: normalized.timeoutMs + 5000,
      bindingDigest: sha(astraJournalJson(json({ version: this.version,
      host: this.client(normalized).descriptor(), model: normalized.expectedModelDigest }))),
      resources: { kernelSlots: 0, modelSlots: 1, declaredBytes: 2 * 1024 * 1024 + 4 * Buffer.byteLength(encoded), exclusiveKeys: [] },
      storage: { maxActivations: normalized.maxAttempts + 2 * context.controlBudget + 4, streams: [
        { streamId: workId, commits, eventBytes: commits * 4096, checkpointBytes: 262144 },
        { streamId: 'context_' + contextExecutionId, commits: 16 * normalized.maxAttempts,
          eventBytes: 16 * normalized.maxAttempts * 4096, checkpointBytes: 524288 },
      ] } };
  }

  async execute(raw: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult> {
    const input = this.input(raw), journal = control.journal;
    check(control.isCurrent(), 'activation-fenced');
    let checkpoint = this.admit(input, journal, control.ownerIsCurrent);
    if (checkpoint.output && checkpoint.quiescent) return this.finishSaved(input, journal, control.ownerIsCurrent, control.controlEpoch);
    if (checkpoint.desired !== 'run' || !checkpoint.quiescent || checkpoint.phase === 'settled') return this.project(input, journal);
    if (!this.current(input) || checkpoint.attempts >= input.maxAttempts) {
      this.save(input, journal, { ...checkpoint, phase: 'settled', reason: this.current(input) ? 'model-attempt-budget' : 'source-stale' }, control.ownerIsCurrent);
      return this.project(input, journal);
    }
    const attemptClient = await this.client(input).forNewAttempt(control.signal);
    check(control.isCurrent() && this.current(input), 'activation-fenced');
    const attempt = checkpoint.attempts + 1, controller = new AbortController();
    const request: AstraModelOpenRequest & { notAfterMs: number } = {
      requestId: 'model_attempt_' + sha(input.workId + '/' + attempt).slice(7, 39), executionId: input.contextExecutionId,
      expectedModelDigest: input.expectedModelDigest, responseSchema: this.profile(input).schema,
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      maxOutputTokens: input.maxOutputTokens, timeoutMs: input.timeoutMs, lane: 'agent', notAfterMs: Date.now() + input.timeoutMs,
      ...(input.memoryValidityToken === undefined ? {} : { memoryValidityToken: input.memoryValidityToken }),
    };
    checkpoint = { schemaVersion: checkpoint.schemaVersion, workId: input.workId, inputDigest: checkpoint.inputDigest,
      phase: 'remote-pending', desired: 'run', attempts: attempt, quiescent: false,
      remote: { descriptor: attemptClient.descriptor(), request } };
    // Before even opening a remote turn, retain identity/deadline for recovery.
    this.save(input, journal, checkpoint, control.isCurrent);
    this.active.set(input.workId, controller);
    const stillOwned = (): boolean => control.ownerIsCurrent() && this.read(input, journal)?.attempts === attempt;
    let resultNotRetained = false;
    const record = (change: Partial<AstraModelWorkCheckpoint>) => {
      check(stillOwned(), 'owner-fenced'); const fresh = this.read(input, journal)!;
      this.save(input, journal, { ...fresh, ...change }, stillOwned);
    };
    try {
      const decision = await decideAstraModel({ deployment: 'isolated-validation', client: attemptClient, journal,
        source: { ...input.source, executionId: input.contextExecutionId }, candidates: input.candidates,
        ...(input.createCandidate ? { createCandidate: input.createCandidate } : {}),
        ...(input.agentCandidates ? { agentCandidates: input.agentCandidates, agentPages: input.agentPages ?? [],
          agentEvidence: input.agentEvidence ?? [],
          agentMinimumCompletionEvidence: input.agentMinimumCompletionEvidence } : {}),
        requestId: request.requestId, expectedModelDigest: input.expectedModelDigest,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(request.memoryValidityToken === undefined ? {} : { memoryValidityToken: request.memoryValidityToken }),
        controlEpoch: control.controlEpoch, catalogRevision: input.catalogRevision,
        isCurrent: () => control.isCurrent() && this.current(input), signal: AbortSignal.any([control.signal, controller.signal]),
        ...(this.options.validateSource ? { validateSource: (signal: AbortSignal) => this.options.validateSource!(structuredClone(input), signal) } : {}),
        limits: { ...input.contextLimits, reservedOutputTokens: input.maxOutputTokens },
        turnTimeoutMs: input.timeoutMs, notAfterMs: request.notAfterMs, checkpoints: {
          opened: turn => record({ turn }),
          prepared: (seal, context) => {
            const frontier = journal.read('context_' + input.contextExecutionId);
            check(frontier && same((frontier.checkpoint as unknown as { active: AstraContextPlan }).active, context), 'context-frontier');
            record({ phase: 'prepared', seal, contextFrontier: { streamId: frontier.streamId, revision: frontier.revision, commitHash: frontier.commitHash } });
          },
          generated: output => {
            try { record({ phase: 'returned', output, quiescent: true }); }
            catch (error) { resultNotRetained = true; throw error; }
          },
        } });
      if (!stillOwned()) return this.project(input, journal);
      const fresh = this.read(input, journal)!;
      if (fresh.output && fresh.quiescent) return this.finishSaved(input, journal, control.ownerIsCurrent, control.controlEpoch);
      const quiescent = ['released', 'not-opened'].includes(decision.model.slotState);
      this.save(input, journal, { ...fresh, phase: quiescent && !resultNotRetained ? 'settled' : fresh.phase, quiescent, decision,
        ...(resultNotRetained ? { reason: 'model-result-not-retained' }
          : decision.status === 'blocked' ? { reason: decision.code } : {}) }, stillOwned);
      return this.project(input, journal);
    } finally { if (this.active.get(input.workId) === controller) this.active.delete(input.workId); }
  }

  control(raw: AstraJson, command: 'pause' | 'resume' | 'cancel', owner: () => boolean, journal = this.options.journal): AstraWorkResult {
    const input = this.input(raw), checkpoint = this.admit(input, journal, owner);
    const desired: AstraModelWorkCheckpoint['desired'] = command === 'cancel' ? 'cancel' : command === 'pause' ? 'pause' : 'run';
    if (command === 'resume') check(checkpoint.desired === 'pause' && checkpoint.quiescent && this.current(input), 'not-resumable');
    if (desired !== checkpoint.desired) {
      const next = { ...checkpoint, desired };
      // A cached, acknowledged output still needs a fresh Gateway decision in
      // the resumed epoch. Queue that verification, not another model call.
      if (command === 'resume') { next.phase = 'ready'; delete next.decision; delete next.reason; }
      this.save(input, journal, next, owner);
    }
    if (command === 'cancel') this.active.get(input.workId)?.abort('model-work-cancelled');
    return this.project(input, journal);
  }

  reconcile(raw: AstraJson, owner: () => boolean, journal = this.options.journal, context?: { controlEpoch: number }): AstraWorkResult {
    const input = this.input(raw), checkpoint = this.admit(input, journal, owner);
    if (checkpoint.quiescent && checkpoint.output && checkpoint.desired === 'run') return this.finishSaved(input, journal, owner, context?.controlEpoch ?? 0);
    return this.project(input, journal);
  }

  async reconcileRemote(raw: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult> {
    const input = this.input(raw), journal = control.journal;
    let checkpoint = this.admit(input, journal, control.ownerIsCurrent);
    if (checkpoint.quiescent && (checkpoint.output || ['ready', 'settled'].includes(checkpoint.phase) || checkpoint.desired === 'cancel')) {
      return this.reconcile(raw, control.ownerIsCurrent, journal, control);
    }
    check(checkpoint.remote, 'recovery-host-missing');
    const recycleRejected = checkpoint.decision?.status === 'blocked'
      && checkpoint.decision.code === 'model-tier-recycle-required'
      && !checkpoint.turn && !checkpoint.seal && !checkpoint.output;
    if (recycleRejected) {
      await this.client(input).waitForHostExit(checkpoint.remote.descriptor, control.signal);
      check(control.isCurrent(), 'recovery-fenced');
    }
    if (this.client(input).hostExited(checkpoint.remote.descriptor)) {
      check(control.isCurrent(), 'recovery-fenced');
      // Process exit proves resource release, not whether generation completed.
      // Replay only the explicit pre-generation residency rejection, once.
      const replay = recycleRejected && checkpoint.attempts === 1 && checkpoint.attempts < input.maxAttempts;
      this.save(input, journal, { ...checkpoint, quiescent: true,
        phase: replay ? 'ready' : 'settled',
        reason: replay ? 'interrupted-model-retry-ready' : 'host-exited-outcome-unknown' }, control.isCurrent);
      return this.project(input, journal);
    }
    const recoveryClient = this.client(input).forDescriptor(checkpoint.remote.descriptor);
    check(recoveryClient, 'recovery-host-changed');
    const attempt = checkpoint.attempts;
    const snapshot = await recoveryClient.settleRequest(checkpoint.remote.request, control.signal);
    check(control.isCurrent(), 'recovery-fenced');
    checkpoint = this.read(input, journal)!; check(checkpoint.attempts === attempt, 'recovery-attempt-changed');
    if (!snapshot.quiescent) return this.project(input, journal); // Keep declared/native slot reserved.
    if (snapshot.output) {
      check(checkpoint.seal && snapshot.prepared && same(checkpoint.seal, snapshot.prepared), 'recovery-seal-missing-or-changed');
      this.save(input, journal, { ...checkpoint, phase: 'returned', quiescent: true, output: snapshot.output }, control.isCurrent);
      return this.finishSaved(input, journal, control.ownerIsCurrent, control.controlEpoch);
    }
    // Only a same-host exact cancellation fence plus actual physical ack permits
    // another pre-accounted attempt. There is no malformed-output repair loop.
    this.save(input, journal, { ...checkpoint, quiescent: true, phase: checkpoint.attempts < input.maxAttempts ? 'ready' : 'settled',
      reason: checkpoint.attempts < input.maxAttempts ? 'interrupted-model-retry-ready' : 'model-attempt-budget' }, control.isCurrent);
    return this.project(input, journal);
  }

  decision(raw: AstraJson): AstraStructuredModelDecision | undefined {
    const input = this.input(raw), checkpoint = this.read(input, this.options.journal);
    return checkpoint?.quiescent && checkpoint.desired === 'run' && checkpoint.phase === 'settled'
      && this.current(input) ? structuredClone(checkpoint.decision) : undefined;
  }

  private finishSaved(input: CompiledInput, journal: AstraJournalAccess, owner: () => boolean, epoch: number): AstraWorkResult {
    const checkpoint = this.read(input, journal)!;
    if (checkpoint.desired !== 'run') return this.project(input, journal);
    check(checkpoint.quiescent && checkpoint.output && checkpoint.seal && checkpoint.contextFrontier, 'saved-output-incomplete');
    const frontier = journal.read(checkpoint.contextFrontier.streamId);
    check(frontier && frontier.revision === checkpoint.contextFrontier.revision && frontier.commitHash === checkpoint.contextFrontier.commitHash, 'saved-context-changed');
    const plan = (frontier.checkpoint as unknown as { active: AstraContextPlan }).active;
    const seal = checkpoint.seal, output = checkpoint.output;
    check(plan.surfaceDigest === seal.surfaceDigest && plan.tokenCount === seal.tokenCount
      && output.promptDigest === seal.promptDigest && output.surfaceDigest === seal.surfaceDigest
      && output.schemaDigest === seal.schemaDigest && output.preparedId === seal.preparedId && output.turnId === seal.turnId
      && output.inputTokens === seal.tokenCount && same(output.binding, seal.binding), 'saved-output-binding');
    const trace: AstraReadModelTrace = { requestId: checkpoint.remote!.request.requestId, hostGeneration: output.hostGeneration,
      turnId: output.turnId, preparedId: output.preparedId, surfaceDigest: output.surfaceDigest,
      promptDigest: output.promptDigest, inputTokens: output.inputTokens, slotState: 'released' };
    let decision: AstraStructuredModelDecision;
    if (!this.current(input) || output.finishReason !== 'stop') decision = { status: 'blocked',
      code: this.current(input) ? 'model-output-limit' : 'source-stale', model: trace };
    else {
      const accepted = this.profile(input).offer(plan, epoch, input.catalogRevision, () => owner() && this.current(input))(output.text);
      decision = accepted.status === 'accepted' ? { ...accepted, model: trace, context: { surfaceDigest: plan.surfaceDigest,
        sourceRevision: plan.sourceRevision, tokenCount: plan.tokenCount, omittedRefs: plan.omittedRefs } }
        : { status: 'blocked', code: accepted.code, model: trace };
    }
    if (checkpoint.phase !== 'settled' || !same(checkpoint.decision ?? null, decision)) {
      this.save(input, journal, { ...checkpoint, phase: 'settled', decision,
        ...(decision.status === 'blocked' ? { reason: decision.code } : {}) }, owner);
    }
    return this.project(input, journal);
  }

  private admit(input: CompiledInput, journal: AstraJournalAccess, owner: () => boolean): AstraModelWorkCheckpoint {
    const previous = this.read(input, journal); if (previous) return previous;
    return this.save(input, journal, { schemaVersion: 'monarch.astra-v3-model-work.internal.v1', workId: input.workId,
      inputDigest: sha(astraJournalJson(json(input))), phase: 'ready', desired: 'run', attempts: 0, quiescent: true }, owner);
  }
  private input(raw: AstraJson): CompiledInput {
    const input = JSON.parse(astraJournalJson(raw)) as CompiledInput;
    check(input && identity(input.workId) && identity(input.contextExecutionId) && Number.isSafeInteger(input.maxAttempts)
      && input.maxAttempts >= 1 && input.maxAttempts <= 4, 'compiled-input-required'); this.profile(input); return input;
  }
  private profile(input: AstraModelWorkInput) {
    const family = this.options.decisionFamily ?? 'read';
    check(!!input.createCandidate === (family === 'create') && !!input.agentCandidates === (family === 'agent')
      && (family === 'agent' || input.agentEvidence === undefined), 'decision-family');
    return astraModelDecisionProfile(input.candidates, input.createCandidate, input.agentCandidates,
      input.agentEvidence, input.agentPages, input.agentMinimumCompletionEvidence,
      input.agentCandidates ? astraAgentArgsJsonChars(input.modelId) : undefined);
  }
  private current(input: AstraModelWorkInput): boolean {
    try { return this.options.isSourceCurrent(structuredClone(input)) === true; } catch { return false; }
  }
  private read(input: CompiledInput, journal: AstraJournalAccess): AstraModelWorkCheckpoint | undefined {
    const snapshot = journal.read(input.workId); if (!snapshot) return undefined;
    const value = snapshot.checkpoint as unknown as AstraModelWorkCheckpoint;
    check(value.schemaVersion === 'monarch.astra-v3-model-work.internal.v1' && value.workId === input.workId
      && value.inputDigest === sha(astraJournalJson(json(input))) && ['run', 'pause', 'cancel'].includes(value.desired)
      && ['ready', 'remote-pending', 'prepared', 'returned', 'settled'].includes(value.phase)
      && Number.isSafeInteger(value.attempts) && value.attempts >= 0 && value.attempts <= input.maxAttempts
      && typeof value.quiescent === 'boolean' && (value.quiescent || value.remote), 'checkpoint-binding');
    if (value.remote) check(value.remote.request.executionId === input.contextExecutionId
      && value.remote.request.requestId === 'model_attempt_' + sha(input.workId + '/' + value.attempts).slice(7, 39)
      && value.remote.request.expectedModelDigest === input.expectedModelDigest
      && value.remote.request.memoryValidityToken === input.memoryValidityToken
      && value.remote.request.maxOutputTokens === input.maxOutputTokens && value.remote.request.timeoutMs === input.timeoutMs
      && same(value.remote.request.responseSchema, this.profile(input).schema), 'remote-input-binding');
    return value;
  }
  private save(input: CompiledInput, journal: AstraJournalAccess, checkpoint: AstraModelWorkCheckpoint, owner: () => boolean): AstraModelWorkCheckpoint {
    check(owner(), 'owner-fenced');
    const previous = journal.read(input.workId);
    journal.append({ streamId: input.workId, requestId: 'model_' + randomUUID(), expectedRevision: previous?.revision ?? 0,
      checkpoint: json(checkpoint), events: [{ type: 'model-work.' + checkpoint.phase, attempts: checkpoint.attempts,
        desired: checkpoint.desired, quiescent: checkpoint.quiescent, outputDigest: checkpoint.output ? sha(checkpoint.output.text) : null }] });
    return this.read(input, journal)!;
  }
  private project(input: CompiledInput, journal: AstraJournalAccess): AstraWorkResult {
    const snapshot = journal.read(input.workId)!, checkpoint = this.read(input, journal)!;
    const state = checkpoint.desired === 'cancel' ? checkpoint.quiescent ? 'cancelled' : 'cancelling'
      : checkpoint.desired === 'pause' ? checkpoint.quiescent ? 'paused' : 'pausing'
      : !checkpoint.quiescent ? 'indeterminate' : checkpoint.phase === 'ready' ? 'queued'
      : checkpoint.phase === 'settled' ? checkpoint.decision?.status === 'accepted' ? 'observed' : 'blocked' : 'indeterminate';
    return { state, checkpointRef: input.workId, checkpointRevision: snapshot.revision,
      progressDigest: astraModelWorkProgressDigest(checkpoint),
      ...(checkpoint.reason ? { reason: checkpoint.reason } : {}) };
  }
}
