import { astraJournalJson } from './journal';
import type { AstraContextPlan } from './context-engine';
import { AstraReadDecisionGateway, astraReadCatalogSurface, astraReadDecisionSchema, type AstraReadCandidate, type AstraReadDecisionResult } from './read-decision-gateway';
import { astraCreateCatalogSurface, astraCreateDecisionSchema, inspectAstraCreateDecision, type AstraCreateCandidate, type AstraCreateDecisionResult } from './create-decision-gateway';
import { AstraAgentDecisionGateway, astraAgentCatalogSurface, astraAgentDecisionSchema, astraAgentDecisionSurface,
  type AstraAgentCapabilityCandidate, type AstraAgentCapabilityPage, type AstraAgentDecisionResult,
  type AstraAgentEvidenceRef } from './agent-decision-gateway';

export type AstraStructuredDecisionResult = AstraReadDecisionResult | AstraCreateDecisionResult | AstraAgentDecisionResult;
export const ASTRA_MODEL_RESERVED_REFS = ['astra_read_catalog', 'astra_read_decision_schema', 'astra_create_catalog',
  'astra_create_decision_schema', 'astra_agent_catalog', 'astra_agent_decision_schema'];
/** Closed family registry, not a caller-supplied schema/tool/plugin override. */
export function astraModelDecisionProfile(candidates: AstraReadCandidate[], createCandidate?: AstraCreateCandidate,
  agentCandidates?: AstraAgentCapabilityCandidate[], agentEvidence: AstraAgentEvidenceRef[] = [],
  agentPages: AstraAgentCapabilityPage[] = [], agentMinimumCompletionEvidence?: number,
  agentArgsJsonChars?: number) {
  if ((createCandidate ? 1 : 0) + (agentCandidates ? 1 : 0) > 1 || (createCandidate || agentCandidates) && candidates.length !== 0) {
    throw Error('astra-decision:mixed-family');
  }
  const schema = agentCandidates ? astraAgentDecisionSchema(agentCandidates, agentEvidence, agentPages, agentMinimumCompletionEvidence, agentArgsJsonChars)
    : createCandidate ? astraCreateDecisionSchema(createCandidate) : astraReadDecisionSchema(candidates);
  const catalog = agentCandidates ? astraAgentCatalogSurface(agentCandidates, agentEvidence, agentPages, agentMinimumCompletionEvidence)
    : createCandidate ? astraCreateCatalogSurface(createCandidate) : astraReadCatalogSurface(candidates);
  const prefix = agentCandidates ? 'astra_agent_' : createCandidate ? 'astra_create_' : 'astra_read_';
  const decisionSurface = agentCandidates
    ? astraAgentDecisionSurface(agentCandidates, agentEvidence, agentPages, agentMinimumCompletionEvidence, agentArgsJsonChars)
    : astraJournalJson(schema);
  return { schema, mandatory: [{ kind: 'capability' as const, ref: prefix + 'catalog', text: catalog },
    { kind: 'capability' as const, ref: prefix + 'decision_schema', text: decisionSurface }],
  offer(plan: AstraContextPlan, controlEpoch: number, catalogRevision: number, current: () => boolean): (raw: string) => AstraStructuredDecisionResult {
    if (agentCandidates) {
      const gateway = new AstraAgentDecisionGateway({ isCurrent: () => current() });
      const offer = gateway.offer({ executionId: plan.executionId, context: plan, controlEpoch, catalogRevision,
        candidates: agentCandidates, pages: agentPages, evidence: agentEvidence,
        ...(agentMinimumCompletionEvidence === undefined ? {} : { minimumCompletionEvidence: agentMinimumCompletionEvidence }),
        ...(agentArgsJsonChars === undefined ? {} : { argsJsonChars: agentArgsJsonChars }) });
      return raw => gateway.accept(offer.offerId, raw);
    }
    if (!createCandidate) {
      const gateway = new AstraReadDecisionGateway({ isCurrent: () => current() });
      const offer = gateway.offer({ executionId: plan.executionId, context: plan, controlEpoch, catalogRevision, candidates });
      return raw => gateway.accept(offer.offerId, raw);
    }
    const pinned = structuredClone(createCandidate), context = structuredClone(plan);
    let consumed: { raw: string; result: AstraStructuredDecisionResult } | undefined;
    return raw => {
      if (!current()) return { status: 'rejected', code: 'stale-offer' };
      if (consumed) return raw === consumed.raw ? structuredClone(consumed.result) : { status: 'rejected', code: 'offer-already-consumed' };
      const result = inspectAstraCreateDecision(raw, pinned, context); consumed = { raw, result }; return result;
    };
  } };
}
