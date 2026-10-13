import { createHash } from 'node:crypto';
import { AstraContextEngine, type AstraContextLimits, type AstraContextSource, type AstraContextPlan } from './context-engine';
import { astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';
import { AstraModelClientError, AstraPreparedModelClient, type AstraModelTurn, type AstraPreparedModelInput,
  type AstraPreparedModelOutput } from './prepared-model-client';
import type { AstraReadCandidate, AstraReadProposal } from './read-decision-gateway';
import type { AstraCreateCandidate, AstraCreateProposal } from './create-decision-gateway';
import { astraAgentArgsJsonChars, type AstraAgentCapabilityCandidate, type AstraAgentCapabilityPage, type AstraAgentEvidenceRef,
  type AstraAgentProposal } from './agent-decision-gateway';
import { astraModelDecisionProfile, ASTRA_MODEL_RESERVED_REFS } from './model-decision-profile';

const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
export interface AstraReadModelTrace {
  requestId: string; hostGeneration?: string; turnId?: string; preparedId?: string;
  surfaceDigest?: string; promptDigest?: string; inputTokens?: number;
  slotState: 'not-opened' | 'released' | 'pending-stop' | 'unknown';
}
export type AstraReadModelDecision = {
  status: 'accepted'; authority: 'none'; proposal: AstraReadProposal; normalized: string[];
  context: { surfaceDigest: string; sourceRevision: number; tokenCount: number; omittedRefs: string[] };
  model: AstraReadModelTrace;
} | { status: 'blocked'; code: string; model: AstraReadModelTrace };
export type AstraStructuredModelDecision = Extract<AstraReadModelDecision, { status: 'blocked' }>
  | Omit<Extract<AstraReadModelDecision, { status: 'accepted' }>, 'proposal'>
    & { proposal: AstraReadProposal | AstraCreateProposal | AstraAgentProposal };

/** One model decision, not an autonomous loop, an effect executor or a Certifier.
 * Uses the existing Context/Gateway and a real prepared-driver transport. A
 * validated proposal still has authority:none. The scheduler/application owns
 * invocation budgets, source admission and any later exact Kernel dispatch.
 */
export interface AstraModelDecisionOptions {
  memoryValidityToken?: string;
  deployment: 'isolated-validation'; client: AstraPreparedModelClient; journal: AstraJournalAccess;
  source: AstraContextSource; candidates: AstraReadCandidate[]; requestId: string;
  createCandidate?: AstraCreateCandidate;
  agentCandidates?: AstraAgentCapabilityCandidate[];
  agentPages?: AstraAgentCapabilityPage[];
  agentEvidence?: AstraAgentEvidenceRef[];
  agentMinimumCompletionEvidence?: number;
  modelId?: string;
  expectedModelDigest: string; controlEpoch: number; catalogRevision: number;
  isCurrent: () => boolean; signal?: AbortSignal; limits?: Partial<AstraContextLimits>;
  /** Fresh host check before each remote input boundary; never model supplied. */
  validateSource?: (signal: AbortSignal) => Promise<boolean>;
  turnTimeoutMs?: number;
  notAfterMs?: number;
  // Host-only persistence hooks, never supplied by model output. Synchronous
  // commits keep intent/seal/results bracketed without an unowned async gap.
  checkpoints?: {
    opened?: (turn: AstraModelTurn) => void;
    prepared?: (prepared: AstraPreparedModelInput, context: AstraContextPlan) => void;
    generated?: (output: AstraPreparedModelOutput) => void;
  };
}
export async function decideAstraReadWithModel(options: Omit<AstraModelDecisionOptions, 'createCandidate'>): Promise<AstraReadModelDecision> {
  const result = await decideAstraModel(options);
  if (result.status === 'accepted' && result.proposal.kind === 'create') throw Error('astra-decision:unexpected-family');
  return result as AstraReadModelDecision;
}
export async function decideAstraModel(options: AstraModelDecisionOptions): Promise<AstraStructuredModelDecision> {
  const trace: AstraReadModelTrace = { requestId: options.requestId, slotState: 'not-opened' };
  const blocked = (code: string): AstraStructuredModelDecision => ({ status: 'blocked', code, model: trace });
  if (options.deployment !== 'isolated-validation') return blocked('deployment');
  const source = JSON.parse(astraJournalJson(options.source as unknown as AstraJson)) as AstraContextSource;
  const candidates = JSON.parse(astraJournalJson(options.candidates as unknown as AstraJson)) as AstraReadCandidate[];
  if (source.mandatory.some(item => ASTRA_MODEL_RESERVED_REFS.includes(item.ref))) return blocked('reserved-context-reference');
  const profile = astraModelDecisionProfile(candidates, options.createCandidate, options.agentCandidates,
    options.agentEvidence, options.agentPages, options.agentMinimumCompletionEvidence,
    options.agentCandidates ? astraAgentArgsJsonChars(options.modelId) : undefined), responseSchema = profile.schema;
  source.mandatory.push(...profile.mandatory);
  const sourceDigest = sha(astraJournalJson(json(source)));
  const current = (): boolean => !options.signal?.aborted && options.isCurrent() === true;
  const validateSource = async (signal?: AbortSignal): Promise<void> => {
    if (!current() || signal?.aborted) throw new AstraModelClientError('stale-source');
    if (!options.validateSource) return;
    const bounded = AbortSignal.any([AbortSignal.timeout(2000), ...(options.signal ? [options.signal] : []), ...(signal ? [signal] : [])]);
    let abort!: () => void;
    try {
      const cancelled = new Promise<boolean>(resolve => {
        abort = () => resolve(false);
        bounded.addEventListener('abort', abort, { once: true });
        if (bounded.aborted) abort();
      });
      const valid = await Promise.race([Promise.resolve().then(() => options.validateSource!(bounded)), cancelled]);
      if (valid !== true || bounded.aborted || !current()) throw new AstraModelClientError('stale-source');
    } catch { throw new AstraModelClientError('stale-source'); }
    finally { bounded.removeEventListener('abort', abort); }
  };
  if (!current()) return blocked('stale-source');
  let turn: AstraModelTurn | undefined;
  let lastPrepared: AstraPreparedModelInput | undefined;
  let generationAcknowledged = false;
  let result: AstraStructuredModelDecision = blocked('model-unavailable');
  try {
    await validateSource();
    const outputTokens = options.limits?.reservedOutputTokens ?? 1024;
    trace.slotState = 'unknown'; // An interrupted open may already hold a backend slot.
    turn = await options.client.open({ requestId: options.requestId, executionId: source.executionId,
      expectedModelDigest: options.expectedModelDigest, responseSchema, maxOutputTokens: outputTokens,
      timeoutMs: options.turnTimeoutMs ?? 60000, lane: 'agent',
      ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
      ...(options.memoryValidityToken === undefined ? {} : { memoryValidityToken: options.memoryValidityToken }),
      ...(options.notAfterMs === undefined ? {} : { notAfterMs: options.notAfterMs }) }, options.signal);
    trace.hostGeneration = turn.hostGeneration; trace.turnId = turn.turnId;
    options.checkpoints?.opened?.(structuredClone(turn));
    const usableTokens = turn.binding.contextTokens - turn.binding.safetyTokens;
    const hardTokens = Math.min(options.limits?.hardTokens ?? usableTokens, usableTokens);
    const softTokens = Math.min(options.limits?.softTokens ?? Math.floor(hardTokens * 0.75), hardTokens - 1);
    const rearmTokens = Math.min(options.limits?.rearmTokens ?? Math.floor(hardTokens * 0.5), softTokens - 1);
    if (outputTokens >= rearmTokens) result = blocked('context-capacity-insufficient');
    else {
      const context = new AstraContextEngine({ deployment: 'isolated-validation', journal: options.journal,
        executionId: source.executionId,
        tokenizer: { driverGeneration: turn.binding.driverGeneration, modelDigest: turn.binding.modelDigest,
          tokenizerDigest: turn.binding.tokenizerDigest },
        countTokens: async (surface, signal) => {
          await validateSource(signal);
          lastPrepared = await options.client.prepare(turn!.turnId, surface,
            options.signal ? AbortSignal.any([signal, options.signal]) : signal);
          return lastPrepared.tokenCount;
        },
        isCurrent: (revision, digest) => current() && revision === source.revision && digest === sourceDigest,
        limits: { ...options.limits, hardTokens, softTokens, rearmTokens, reservedOutputTokens: outputTokens },
      });
      const preparedContext = await context.prepare(source);
      if (preparedContext.status !== 'ready') result = blocked(preparedContext.code);
      else if (!current()) result = blocked('stale-source');
      else {
        const plan: AstraContextPlan = preparedContext.plan;
        // A cache hit or rejected compaction can leave another candidate in the
        // backend. Re-prepare the exact active surface, never silently use it.
        if (lastPrepared?.surfaceDigest !== plan.surfaceDigest) {
          await validateSource();
          lastPrepared = await options.client.prepare(turn.turnId, plan.surface, options.signal);
        }
        if (!current()) result = blocked('stale-source');
        else if (!lastPrepared.fits || lastPrepared.tokenCount !== plan.tokenCount) result = blocked('context-driver-drift');
        else {
          trace.preparedId = lastPrepared.preparedId; trace.surfaceDigest = lastPrepared.surfaceDigest;
          trace.promptDigest = lastPrepared.promptDigest; trace.inputTokens = lastPrepared.tokenCount;
          const accept = profile.offer(plan, options.controlEpoch, options.catalogRevision,
            () => current() && plan.executionId === source.executionId && plan.tokenizer.driverGeneration === turn!.binding.driverGeneration);
          options.checkpoints?.prepared?.(structuredClone(lastPrepared), structuredClone(plan));
          if (!current()) throw new AstraModelClientError('stale-source');
          await validateSource();
          const generated = await options.client.generate(lastPrepared, options.signal);
          generationAcknowledged = true; trace.slotState = 'released';
          options.checkpoints?.generated?.(structuredClone(generated));
          if (!current()) result = blocked('stale-source');
          else if (generated.finishReason !== 'stop') result = blocked('model-output-limit');
          else {
            const decision = accept(generated.text);
            result = decision.status === 'accepted' ? { ...decision, context: { surfaceDigest: plan.surfaceDigest,
              sourceRevision: plan.sourceRevision, tokenCount: plan.tokenCount, omittedRefs: plan.omittedRefs }, model: trace }
              : blocked(decision.code);
          }
        }
      }
    }
  } catch (error) {
    result = blocked(error instanceof AstraModelClientError ? error.code : 'model-decision-failed');
  } finally {
    if (turn && !generationAcknowledged) {
      try {
        const stopped = await options.client.cancel(turn.turnId);
        trace.slotState = stopped.slotReserved ? 'pending-stop' : ['cancelled', 'generated'].includes(stopped.state) ? 'released' : 'unknown';
      } catch { trace.slotState = 'unknown'; }
    }
    if (turn && trace.slotState === 'released') options.client.forget(turn.turnId);
  }
  return result;
}
