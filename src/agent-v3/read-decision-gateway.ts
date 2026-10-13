import { createHash, randomUUID } from 'node:crypto';
import { astraJournalJson, type AstraJson } from './journal';
import type { AstraContextPlan } from './context-engine';
import { validateAstraReadRequest, type AstraReadRequest } from './read-runtime';
import { parseAstraDecisionJson } from './decision-json';

// Internal read-pack gateway. This is deliberately NOT the native decision ABI,
// an approval service, a generic tool loop or a Certifier. Accepted output remains
// a proposal with authority:none; Kernel is the only executor.
export const ASTRA_READ_DECISION_VERSION = 'monarch.astra-v3-read-decision.internal.v1';
export interface AstraReadCandidate {
  handle: string; requirementId: string; targetHandle: string; request: AstraReadRequest;
}
export interface AstraReadDecisionBinding {
  executionId: string; controlEpoch: number; catalogRevision: number; contextRevision: number;
  contextDigest: string; driverGeneration: string; catalogDigest: string;
}
export type AstraReadProposal = { kind: 'read'; requirementId: string; request: AstraReadRequest }
  | { kind: 'respond'; text: string } | { kind: 'ask-user'; question: string } | { kind: 'request-completion' };
export type AstraReadDecisionResult = { status: 'accepted'; authority: 'none'; proposal: AstraReadProposal; normalized: string[] }
  | { status: 'rejected'; code: string };
interface Offer { binding: AstraReadDecisionBinding; candidates: AstraReadCandidate[]; expiresAt: number;
  rawDigest?: string; result?: AstraReadDecisionResult }
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const identity = (value: string): boolean => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(value);
function reject(code: string): never { throw new Error('astra-decision:' + code); }
const textSchema = { type: 'string', minLength: 1, maxLength: 4096 };

/** A discriminated union with branch-local fields, not a bag of optional tools. */
export function astraReadDecisionSchema(candidates: ReadonlyArray<AstraReadCandidate>): AstraJson {
  if (!Array.isArray(candidates) || candidates.length > 32
    || candidates.some(item => !item || ![item.handle, item.requirementId, item.targetHandle].every(identity))) reject('candidate-identity');
  // The model selects admitted opaque IDs, it does not transcribe arbitrary
  // strings. The Gateway still independently validates their exact tuple and
  // current epoch; grammar constraints never grant execution authority.
  const handles = (field: 'handle' | 'requirementId' | 'targetHandle'): AstraJson => {
    const values = [...new Set(candidates.map(item => item[field]))];
    return values.length === 1 ? { const: values[0]! } : { enum: values };
  };
  const branch = (kind: string, properties: Record<string, AstraJson> = {}): AstraJson => ({
    type: 'object', properties: { kind: { const: kind }, ...properties },
    required: ['kind', ...Object.keys(properties)], additionalProperties: false,
  });
  return { oneOf: [
    ...(candidates.length ? [branch('read', { requirementId: handles('requirementId'), capabilityHandle: handles('handle'),
      targetHandle: handles('targetHandle') })] : []),
    branch('respond', { text: textSchema }), branch('ask-user', { question: textSchema }), branch('request-completion'),
  ] };
}

/** Include this exact inspected catalog + decision schema as mandatory Context items. */
export function astraReadCatalogSurface(candidates: AstraReadCandidate[]): string {
  return astraJournalJson({ schemaVersion: 'monarch.astra-v3-read-catalog.internal.v1',
    catalogDigest: sha(astraJournalJson(candidates as unknown as AstraJson)),
    candidates: candidates.map(({ handle, requirementId, targetHandle }) => ({ handle, requirementId, targetHandle, capabilityId: 'workspace.files.read' })),
  });
}

export class AstraReadDecisionGateway {
  private readonly offers = new Map<string, Offer>();
  constructor(private readonly options: {
    isCurrent: (binding: AstraReadDecisionBinding) => boolean;
    now?: () => number; ttlMs?: number;
  }) {
    if (!Number.isSafeInteger(options.ttlMs ?? 30000) || (options.ttlMs ?? 30000) < 1 || (options.ttlMs ?? 30000) > 120000) reject('ttl');
  }

  offer(input: { executionId: string; controlEpoch: number; catalogRevision: number;
    context: AstraContextPlan; candidates: AstraReadCandidate[] }): {
      offerId: string; binding: AstraReadDecisionBinding;
      candidates: Array<{ handle: string; requirementId: string; targetHandle: string }>;
    } {
    if (!identity(input.executionId) || !Number.isSafeInteger(input.controlEpoch) || input.controlEpoch < 0
      || !Number.isSafeInteger(input.catalogRevision) || input.catalogRevision < 0) reject('binding');
    const plan = input.context;
    if (plan.executionId !== input.executionId || !Number.isSafeInteger(plan.sourceRevision) || plan.sourceRevision < 0
      || typeof plan.surface !== 'string' || Buffer.byteLength(plan.surface) !== plan.utf8Bytes
      || sha(plan.surface) !== plan.surfaceDigest || !plan.tokenizer?.driverGeneration) reject('context-binding');
    // Bounded copy rejects non-JSON/accessor inputs. The model sees ONLY opaque
    // handles; paths and byte limits remain pinned host-owned request arguments.
    const candidates = JSON.parse(astraJournalJson(input.candidates as unknown as AstraJson)) as AstraReadCandidate[];
    if (!Array.isArray(candidates) || candidates.length > 32) reject('candidate-budget');
    if (new Set(candidates.map(item => item.handle)).size !== candidates.length
      || new Set(candidates.map(item => item.requirementId)).size !== candidates.length) reject('candidate-identity');
    for (const item of candidates) {
      if (![item.handle, item.targetHandle, item.requirementId].every(identity)) reject('candidate-identity');
      validateAstraReadRequest(item.request);
    }
    const surface = JSON.parse(plan.surface) as { executionId?: unknown; sourceRevision?: unknown;
      mandatory?: Array<{ kind?: unknown; ref?: unknown; text?: unknown }> };
    if (surface.executionId !== input.executionId || surface.sourceRevision !== plan.sourceRevision || !Array.isArray(surface.mandatory)
      || !surface.mandatory.some(item => item.kind === 'capability' && item.ref === 'astra_read_catalog' && item.text === astraReadCatalogSurface(candidates))
      || !surface.mandatory.some(item => item.kind === 'capability' && item.ref === 'astra_read_decision_schema' && item.text === astraJournalJson(astraReadDecisionSchema(candidates)))) reject('catalog-context-binding');
    const binding: AstraReadDecisionBinding = { executionId: input.executionId, controlEpoch: input.controlEpoch,
      catalogRevision: input.catalogRevision, contextRevision: plan.sourceRevision, contextDigest: plan.surfaceDigest,
      driverGeneration: plan.tokenizer.driverGeneration, catalogDigest: sha(astraJournalJson(json(candidates))) };
    if (!this.options.isCurrent(structuredClone(binding))) reject('stale-context');
    const now = this.now();
    for (const [key, value] of this.offers) if (value.expiresAt <= now) this.offers.delete(key);
    if (this.offers.size >= 32) reject('offer-budget');
    const offerId = randomUUID();
    this.offers.set(offerId, { binding, candidates, expiresAt: now + (this.options.ttlMs ?? 30000) });
    return { offerId, binding: structuredClone(binding), candidates: candidates.map(({ handle, requirementId, targetHandle }) => ({ handle, requirementId, targetHandle })) };
  }

  accept(offerId: string, raw: string): AstraReadDecisionResult {
    const offer = this.offers.get(offerId);
    if (!offer || this.now() >= offer.expiresAt || !this.options.isCurrent(structuredClone(offer.binding))) return { status: 'rejected', code: 'stale-offer' };
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384) return { status: 'rejected', code: 'decision-size' };
    const rawDigest = sha(raw);
    if (offer.rawDigest) return offer.rawDigest === rawDigest ? structuredClone(offer.result!) : { status: 'rejected', code: 'offer-already-consumed' };
    let result: AstraReadDecisionResult;
    try { result = this.parse(raw, offer); }
    catch (error) {
      // Error codes only. Do not copy invalid model text (possibly secrets or
      // injected instructions) into durable logs or the next repair prompt.
      result = { status: 'rejected', code: error instanceof Error && error.message.startsWith('astra-decision:')
        ? error.message.slice('astra-decision:'.length) : 'decision-json-invalid' };
    }
    offer.rawDigest = rawDigest; offer.result = structuredClone(result);
    return result;
  }

  private parse(raw: string, offer: Offer): AstraReadDecisionResult {
    const { value: decision, normalized } = parseAstraDecisionJson(raw);
    if ('schemaVersion' in decision) {
      if (decision.schemaVersion !== ASTRA_READ_DECISION_VERSION) reject('schema-version');
      delete decision.schemaVersion; normalized.push('checked-schema-version');
    }
    if ('auditCorrelation' in decision) {
      if (typeof decision.auditCorrelation !== 'string' || !identity(decision.auditCorrelation)) reject('audit-correlation');
      delete decision.auditCorrelation; normalized.push('inert-audit-correlation');
    }
    const exact = (names: string[]): void => {
      if (Object.keys(decision).length !== names.length || names.some(name => !Object.hasOwn(decision, name))) reject('branch-fields');
    };
    const narrative = (field: string): string => {
      const value = decision[field];
      if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 4096) reject('narrative-size');
      return value;
    };
    let proposal: AstraReadProposal;
    switch (decision.kind) {
    case 'read': {
      exact(['kind', 'requirementId', 'capabilityHandle', 'targetHandle']);
      const candidate = offer.candidates.find(item => item.handle === decision.capabilityHandle);
      if (!candidate || candidate.requirementId !== decision.requirementId || candidate.targetHandle !== decision.targetHandle) reject('goal-target-binding');
      proposal = { kind: 'read', requirementId: candidate.requirementId, request: structuredClone(candidate.request) }; break;
    }
    case 'respond': exact(['kind', 'text']); proposal = { kind: 'respond', text: narrative('text') }; break;
    case 'ask-user': exact(['kind', 'question']); proposal = { kind: 'ask-user', question: narrative('question') }; break;
    case 'request-completion': exact(['kind']); proposal = { kind: 'request-completion' }; break;
    default: reject('decision-kind');
    }
    return { status: 'accepted', authority: 'none', proposal, normalized };
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) reject('clock'); return now;
  }
}
