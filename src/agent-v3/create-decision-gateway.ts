import { createHash } from 'node:crypto';
import { astraJournalJson, type AstraJson } from './journal';
import type { AstraContextPlan } from './context-engine';
import type { AstraReadDecisionResult } from './read-decision-gateway';
import { parseAstraDecisionJson } from './decision-json';

export interface AstraCreateCandidate { handle: string; requirementId: string; targetHandle: string; maxBytes: number }
export type AstraCreateProposal = { kind: 'create'; requirementId: string; content: string; candidateDigest: string }
  | { kind: 'ask-user'; question: string };
export type AstraCreateDecisionResult = { status: 'accepted'; authority: 'none'; proposal: AstraCreateProposal; normalized: string[] }
  | Extract<AstraReadDecisionResult, { status: 'rejected' }>;
const sha = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const check = (value: unknown, code: string): void => { if (!value) throw Error('astra-decision:' + code); };
export const astraCreateCandidateDigest = (candidate: AstraCreateCandidate): string => sha(astraJournalJson(json(candidate)));

export function astraCreateDecisionSchema(candidate: AstraCreateCandidate): AstraJson {
  check(candidate && Object.keys(candidate).every(key => ['handle', 'requirementId', 'targetHandle', 'maxBytes'].includes(key))
    && [candidate.handle, candidate.requirementId, candidate.targetHandle].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(id))
    && Number.isSafeInteger(candidate.maxBytes) && candidate.maxBytes >= 0 && candidate.maxBytes <= 16384, 'create-candidate');
  const branch = (kind: string, fields: Record<string, AstraJson> = {}): AstraJson => ({ type: 'object',
    properties: { kind: { const: kind }, ...fields }, required: ['kind', ...Object.keys(fields)], additionalProperties: false });
  const narrative = { type: 'string', minLength: 1, maxLength: 4096 };
  return { oneOf: [branch('create', { requirementId: { const: candidate.requirementId }, capabilityHandle: { const: candidate.handle },
    targetHandle: { const: candidate.targetHandle }, content: { type: 'string', minLength: 0, maxLength: Math.min(4096, candidate.maxBytes) } }),
    branch('ask-user', { question: narrative })] };
}
export function astraCreateCatalogSurface(candidate: AstraCreateCandidate): string {
  astraCreateDecisionSchema(candidate);
  return astraJournalJson({ schemaVersion: 'monarch.astra-v3-create-catalog.internal.v1', catalogDigest: astraCreateCandidateDigest(candidate),
    candidate: { ...candidate, capabilityId: 'workspace.files.write', operation: 'exclusive-create', authority: 'none' } });
}

/** Pure proposal revalidation over the exact counted Context. The host separately
 * owns source/epoch freshness and atomic once-only effect admission. Neither model
 * content nor this validator selects a path, confirms approval or certifies effect. */
export function inspectAstraCreateDecision(raw: string, candidate: AstraCreateCandidate, plan: AstraContextPlan): AstraCreateDecisionResult {
  try {
    const schema = astraCreateDecisionSchema(candidate);
    check(typeof plan.surface === 'string' && sha(plan.surface) === plan.surfaceDigest && Buffer.byteLength(plan.surface) === plan.utf8Bytes
      && plan.tokenizer?.driverGeneration, 'context-binding');
    const surface = JSON.parse(plan.surface) as { executionId?: string; sourceRevision?: number; mandatory?: Array<{ kind?: string; ref?: string; text?: string }> };
    check(surface.executionId === plan.executionId && surface.sourceRevision === plan.sourceRevision && Array.isArray(surface.mandatory)
      && surface.mandatory.some(item => item.kind === 'capability' && item.ref === 'astra_create_catalog' && item.text === astraCreateCatalogSurface(candidate))
      && surface.mandatory.some(item => item.kind === 'capability' && item.ref === 'astra_create_decision_schema' && item.text === astraJournalJson(schema)), 'catalog-context-binding');
    const { value, normalized } = parseAstraDecisionJson(raw, 65536);
    const exact = (keys: string[]) => check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'branch-fields');
    let proposal: AstraCreateProposal;
    if (value.kind === 'create') {
      exact(['kind', 'requirementId', 'capabilityHandle', 'targetHandle', 'content']);
      check(value.requirementId === candidate.requirementId && value.capabilityHandle === candidate.handle
        && value.targetHandle === candidate.targetHandle, 'goal-target-binding');
      check(typeof value.content === 'string' && [...value.content].length <= 4096 && Buffer.byteLength(value.content) <= candidate.maxBytes, 'create-content-budget');
      proposal = { kind: 'create', requirementId: candidate.requirementId, content: value.content as string, candidateDigest: astraCreateCandidateDigest(candidate) };
    } else {
      // This is a pending draft stage, not a general conversation/completion
      // decision. Missing information may stop it; completion is never available
      // until a separate Kernel effect and pure family certification exist.
      check(value.kind === 'ask-user', 'decision-kind'); exact(['kind', 'question']);
      const content = value.question; check(typeof content === 'string' && content.trim().length > 0 && Buffer.byteLength(content) <= 4096, 'narrative-size');
      proposal = { kind: 'ask-user', question: content as string };
    }
    return { status: 'accepted', authority: 'none', proposal, normalized };
  } catch (error) { return { status: 'rejected', code: error instanceof Error && error.message.startsWith('astra-decision:')
    ? error.message.slice('astra-decision:'.length) : 'decision-json-invalid' }; }
}
