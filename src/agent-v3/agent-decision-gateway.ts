import { createHash, randomUUID } from 'node:crypto';
import type { MonarchJsonSchema, MonarchRisk } from '../core/contracts';
import { astraJournalJson, type AstraJson } from './journal';
import type { AstraContextPlan } from './context-engine';
import { parseAstraDecisionJson } from './decision-json';
import { isAstraMaxModelChoice } from './source-goal-contract';

export const ASTRA_AGENT_DECISION_VERSION = 'monarch.astra-v3-agent-decision.internal.v1';

export interface AstraAgentCapabilityCandidate {
  /** Per-task opaque handle. The model never authors a capability identifier. */
  handle: string;
  capabilityId: string;
  moduleId: string;
  title: string;
  description: string;
  risk: MonarchRisk;
  inputSchema: MonarchJsonSchema;
}

export interface AstraAgentCapabilityPage {
  /** Per-task opaque handle exposed to the model. */
  handle: string;
  /** Host-owned page identity, never accepted from model output. */
  pageId: string;
  title: string;
  description: string;
  /** Present on nested catalog pages; absent on top-level module pages. */
  parentPageId?: string;
  /** Host-owned descendants. Their opaque handles are revealed only after expansion. */
  childPageIds?: string[];
  candidateHandles: string[];
}

export interface AstraAgentCapabilityCatalog {
  candidates: AstraAgentCapabilityCandidate[];
  pages: AstraAgentCapabilityPage[];
}

export interface AstraAgentEvidenceRef {
  ref: string;
  digest: string;
  summary: string;
  /** Host-only equivalence class. Retries of one capability do not satisfy
   * several independently required task outputs. */
  group?: string;
}

export type AstraAgentProposal =
  | { kind: 'act'; capabilityId: string; args: { [key: string]: AstraJson }; reason: string; thought?: string }
  | { kind: 'expand'; pageId: string }
  | { kind: 'complete'; text: string; evidenceRefs: string[] }
  | { kind: 'ask-user'; question: string };

export type AstraAgentDecisionResult =
  | { status: 'accepted'; authority: 'none'; proposal: AstraAgentProposal; normalized: string[] }
  | { status: 'rejected'; code: string };

interface AstraAgentDecisionBinding {
  executionId: string;
  controlEpoch: number;
  catalogRevision: number;
  contextRevision: number;
  contextDigest: string;
  driverGeneration: string;
  catalogDigest: string;
  pagesDigest: string;
  evidenceDigest: string;
}

interface Offer {
  binding: AstraAgentDecisionBinding;
  candidates: AstraAgentCapabilityCandidate[];
  pages: AstraAgentCapabilityPage[];
  evidence: AstraAgentEvidenceRef[];
  minimumCompletionEvidence: number;
  argsJsonChars: number;
  expiresAt: number;
  rawDigest?: string;
  result?: AstraAgentDecisionResult;
}

const risks = new Set<MonarchRisk>(['none', 'read', 'write', 'delete', 'execute', 'network', 'device-control',
  'money', 'identity', 'security-sensitive']);
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
const capabilityId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-z0-9][a-z0-9._-]{2,159}$/u.test(value);
function reject(code: string): never { throw new Error('astra-agent-decision:' + code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('object');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) reject('branch-fields');
}
function narrative(value: unknown, field: 'reason' | 'thought' | 'text' | 'question', maximum = 16_384): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum) reject(field + '-size');
  return value;
}

function copyCandidates(value: AstraAgentCapabilityCandidate[], allowEmpty = false): AstraAgentCapabilityCandidate[] {
  const copied = JSON.parse(astraJournalJson(value as unknown as AstraJson)) as AstraAgentCapabilityCandidate[];
  if (!Array.isArray(copied) || copied.length < (allowEmpty ? 0 : 1) || copied.length > 16
    || new Set(copied.map(item => item.handle)).size !== copied.length
    || new Set(copied.map(item => item.capabilityId)).size !== copied.length) reject('candidate-budget');
  for (const item of copied) {
    if (!id(item.handle) || !capabilityId(item.capabilityId) || !capabilityId(item.moduleId)
      || typeof item.title !== 'string' || !item.title.trim() || Buffer.byteLength(item.title) > 256
      || typeof item.description !== 'string' || Buffer.byteLength(item.description) > 2048
      || !risks.has(item.risk) || !item.inputSchema || typeof item.inputSchema !== 'object'
      || Array.isArray(item.inputSchema) || item.inputSchema.type !== 'object'
      || Buffer.byteLength(astraJournalJson(item.inputSchema as AstraJson)) > 8192) reject('candidate-shape');
  }
  if (Buffer.byteLength(astraJournalJson(copied as unknown as AstraJson)) > 22_000) reject('catalog-size');
  return copied;
}

function copyPages(value: AstraAgentCapabilityPage[], maximum = 32): AstraAgentCapabilityPage[] {
  const copied = JSON.parse(astraJournalJson(value as unknown as AstraJson)) as AstraAgentCapabilityPage[];
  if (!Array.isArray(copied) || copied.length > maximum
    || new Set(copied.map(item => item.handle)).size !== copied.length
    || new Set(copied.map(item => item.pageId)).size !== copied.length) reject('page-budget');
  for (const item of copied) {
    if (!id(item.handle) || !id(item.pageId) || typeof item.title !== 'string' || !item.title.trim()
      || Buffer.byteLength(item.title) > 256 || typeof item.description !== 'string'
      || Buffer.byteLength(item.description) > 2048
      || (item.parentPageId !== undefined && !id(item.parentPageId))
      || (item.childPageIds !== undefined && (!Array.isArray(item.childPageIds)
        || item.childPageIds.length < 1 || item.childPageIds.length > 32
        || new Set(item.childPageIds).size !== item.childPageIds.length
        || item.childPageIds.some(child => !id(child))))
      || !Array.isArray(item.candidateHandles) || item.candidateHandles.length > 16
      || new Set(item.candidateHandles).size !== item.candidateHandles.length
      || item.candidateHandles.some(handle => !id(handle))
      || (item.candidateHandles.length > 0) === Boolean(item.childPageIds?.length)) reject('page-shape');
  }
  if (Buffer.byteLength(astraJournalJson(copied as unknown as AstraJson)) > (maximum > 32 ? 256 * 1024 : 32_768)) reject('page-size');
  return copied;
}

/** A page description stands in for what the page holds.
 *
 * Measured live: the workspace page's description was cut at 160 bytes and
 * ended mid-word at "Read f". "Write file" is the twelfth of sixteen commands,
 * so it never appeared, and the agent reported — truthfully, from what it had
 * been shown — that Monarch has no command to write a file. It had already
 * created the folder the file was meant to go in.
 *
 * Whole entries only, and always say how many were left out, so an incomplete
 * list reads as a reason to expand rather than as proof of absence.
 */
const PAGE_CONTENTS_BUDGET = 960;

function describePageContents(titles: string[], budget = PAGE_CONTENTS_BUDGET): string {
  const kept: string[] = [];
  let used = 0;
  for (const title of titles) {
    const entry = title.trim();
    if (!entry) continue;
    const cost = Buffer.byteLength(entry) + (kept.length ? 2 : 0);
    if (used + cost > budget) break;
    kept.push(entry);
    used += cost;
  }
  const omitted = titles.length - kept.length;
  if (kept.length === 0) return `${titles.length} commands; expand to list them`;
  return omitted > 0 ? `${kept.join('; ')}; +${omitted} more, expand to list them` : kept.join('; ');
}

/** Deterministic host-side paging for a large live capability snapshot. Pages
 * are semantic module cohorts, never keyword matches against the user request.
 */
export function astraAgentCapabilityCatalog(value: AstraAgentCapabilityCandidate[]): AstraAgentCapabilityCatalog {
  const encoded = astraJournalJson(value as unknown as AstraJson);
  if (Buffer.byteLength(encoded) > 384 * 1024) reject('catalog-size');
  const raw = JSON.parse(encoded) as AstraAgentCapabilityCandidate[];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 384
    || new Set(raw.map(item => item.handle)).size !== raw.length
    || new Set(raw.map(item => item.capabilityId)).size !== raw.length) reject('catalog-budget');
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const candidates = raw.slice().sort((left, right) => compare(left.moduleId, right.moduleId)
    || compare(left.capabilityId, right.capabilityId));
  for (let index = 0; index < candidates.length; index += 16) copyCandidates(candidates.slice(index, index + 16));
  if (candidates.length <= 16) return { candidates, pages: [] };
  const groups = new Map<string, AstraAgentCapabilityCandidate[]>();
  for (const candidate of candidates) groups.set(candidate.moduleId, [...(groups.get(candidate.moduleId) ?? []), candidate]);
  const pages: AstraAgentCapabilityPage[] = [];
  const identity = (body: AstraJson): { pageId: string; handle: string } => {
    const pageId = 'page_' + sha(astraJournalJson(body)).slice(7, 39);
    return { pageId, handle: 'catalog_' + sha(pageId).slice(7, 31) };
  };
  for (const [moduleId, group] of groups) {
    if (group.length === 1) {
      const only = group[0]!, current = identity(json({ moduleId, kind: 'module-leaf', capabilityId: only.capabilityId }));
      pages.push({ ...current, title: moduleId, description: describePageContents([only.title]),
        candidateHandles: [only.handle] });
      continue;
    }
    const moduleSummary = describePageContents(group.map(candidate => candidate.title));
    const root = identity(json({ moduleId, kind: 'module-root', capabilities: group.map(item => item.capabilityId) }));
    const leafPages = group.map(candidate => {
      const leaf = identity(json({ moduleId, kind: 'capability-leaf', capabilityId: candidate.capabilityId }));
      return { ...leaf, title: candidate.title.slice(0, 160),
        description: describePageContents([candidate.title, candidate.description]),
        parentPageId: root.pageId, candidateHandles: [candidate.handle] } satisfies AstraAgentCapabilityPage;
    });
    if (leafPages.length <= 16) {
      pages.push({ ...root, title: moduleId, description: moduleSummary,
        childPageIds: leafPages.map(page => page.pageId), candidateHandles: [] },
        ...leafPages);
      continue;
    }
    const partitions: AstraAgentCapabilityPage[] = [];
    for (let offset = 0; offset < leafPages.length; offset += 16) {
      const part = Math.floor(offset / 16) + 1, children = leafPages.slice(offset, offset + 16);
      const partition = identity(json({ moduleId, kind: 'module-partition', part,
        capabilities: group.slice(offset, offset + 16).map(item => item.capabilityId) }));
      partitions.push({ ...partition, title: `${moduleId} · ${part}`,
        description: describePageContents(group.slice(offset, offset + 16).map(item => item.title)),
        parentPageId: root.pageId,
        childPageIds: children.map(page => page.pageId), candidateHandles: [] });
      for (const child of children) child.parentPageId = partition.pageId;
    }
    pages.push({ ...root, title: moduleId, description: moduleSummary,
      childPageIds: partitions.map(page => page.pageId), candidateHandles: [] },
      ...partitions, ...leafPages);
  }
  const copiedPages = copyPages(pages, 384);
  return { candidates, pages: copiedPages };
}

function copyEvidence(value: AstraAgentEvidenceRef[]): AstraAgentEvidenceRef[] {
  const copied = JSON.parse(astraJournalJson(value as unknown as AstraJson)) as AstraAgentEvidenceRef[];
  if (!Array.isArray(copied) || copied.length > 32 || new Set(copied.map(item => item.ref)).size !== copied.length
    || copied.some(item => !id(item.ref) || !/^sha256:[a-f0-9]{64}$/u.test(item.digest)
      || (item.group !== undefined && !capabilityId(item.group))
      || typeof item.summary !== 'string' || Buffer.byteLength(item.summary) > 2048)) reject('evidence-shape');
  return copied;
}

function completionEvidence(value: AstraAgentEvidenceRef[]): AstraAgentEvidenceRef[] {
  const latest = new Map<string, AstraAgentEvidenceRef>();
  for (const item of value) latest.set(item.group ?? item.ref, item);
  return [...latest.values()];
}

function minimumEvidence(value: number | undefined): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 32) reject('completion-evidence-minimum');
  return normalized;
}

/** Model-facing schema projection. Kernel retains and validates the complete
 * manifest schema; annotation-heavy JSON Schema prose must not consume a 4K
 * local model's working window twice. Structural and validation keywords stay
 * exact, while non-authoritative annotations are bounded or omitted. */
function modelInputSchema(value: MonarchJsonSchema): MonarchJsonSchema {
  const visit = (input: unknown, depth = 0): unknown => {
    if (depth > 16 || input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (['$comment', 'default', 'deprecated', 'examples', 'example', 'readOnly', 'writeOnly'].includes(key)) continue;
      if ((key === 'description' || key === 'title') && typeof item === 'string') {
        const maximum = key === 'description' ? 160 : 96;
        if (item) output[key] = item.slice(0, maximum);
        continue;
      }
      output[key] = visit(item, depth + 1);
    }
    return output;
  };
  return visit(value) as MonarchJsonSchema;
}

/** The bounded native grammar currently supports an exact empty nested object.
 * Use it for the many status/list capabilities that take no arguments; retain
 * the serialized compatibility field for richer manifests until their complete
 * structural subset can be represented without weakening Kernel validation. */
function nativeTypedArgsSchema(value: MonarchJsonSchema): AstraJson | undefined {
  const schema = modelInputSchema(value) as Record<string, unknown>;
  const properties = schema.properties;
  if (schema.type !== 'object' || schema.additionalProperties !== false
    || !properties || typeof properties !== 'object' || Array.isArray(properties)
    || Object.keys(properties).length !== 0) return undefined;
  return { type: 'object', properties: {}, required: [], additionalProperties: false };
}

/** The schema is the model's grammar locally, but a remote strict-schema provider
 * only validates the finished JSON: a `complete.text` longer than this fails the whole
 * generation and the task dies with a provider error instead of an answer. The surface
 * therefore states these limits to the model rather than leaving them implicit. */
export const ASTRA_AGENT_DECISION_LIMITS = Object.freeze({ text: 4096, question: 4096, argsJson: 4096, reason: 1000, thought: 1200 });
/** MAX models only validate the finished JSON; locally the schema is the
 * generation grammar and keeps the 4096 default. Live, a DeepSeek agent could
 * not write any game source file over 4096 characters in one step and lost
 * the task on the second identical rejection. */
export const ASTRA_AGENT_MAX_ARGS_JSON_CHARS = 12_000;
export function astraAgentArgsJsonChars(modelId: unknown): number {
  return isAstraMaxModelChoice(modelId) ? ASTRA_AGENT_MAX_ARGS_JSON_CHARS : ASTRA_AGENT_DECISION_LIMITS.argsJson;
}
/** The person sees a MAX model's reasoning beside each step. It is written into
 * the decision itself, so the output screen checks it like every other field;
 * it costs output tokens, so local models (schema = grammar) never get it. */
const visibleThought = (argsJsonChars: number): boolean => argsJsonChars === ASTRA_AGENT_MAX_ARGS_JSON_CHARS;
function argsJsonLimit(value: number): number {
  if (value !== ASTRA_AGENT_DECISION_LIMITS.argsJson && value !== ASTRA_AGENT_MAX_ARGS_JSON_CHARS) reject('args-json-limit');
  return value;
}

const textSchema = (maximum: number): AstraJson => ({ type: 'string', minLength: 1, maxLength: maximum });
const branch = (kind: string, properties: Record<string, AstraJson> = {}): AstraJson => ({
  type: 'object', properties: { kind: { const: kind }, ...properties },
  required: ['kind', ...Object.keys(properties)], additionalProperties: false,
});

/** Closed response schema generated from an already admitted live capability page.
 * Dynamic arguments keep the exact manifest schema; Kernel still revalidates the
 * proposal and remains the only dispatcher.
 */
export function astraAgentDecisionSchema(candidates: AstraAgentCapabilityCandidate[], evidence: AstraAgentEvidenceRef[],
  pages: AstraAgentCapabilityPage[] = [], minimumCompletionEvidence?: number,
  argsJsonChars: number = ASTRA_AGENT_DECISION_LIMITS.argsJson): AstraJson {
  const admittedPages = copyPages(pages), admitted = copyCandidates(candidates, admittedPages.length > 0);
  if (admitted.length === 0 && admittedPages.length === 0) reject('empty-catalog');
  const requiredEvidence = minimumEvidence(minimumCompletionEvidence);
  const refs = completionEvidence(copyEvidence(evidence)).map(item => item.ref);
  // Selecting a concrete capability page is a semantic commitment to inspect
  // live state. The catalog only advertises callable commands; it is never a
  // receipt proving that an account, file, process or service is available.
  const completionReady = refs.length >= Math.max(requiredEvidence,
    admitted.length > 0 && admittedPages.length > 0 ? 1 : 0);
  const typedArgsSchema = admitted.length === 1 && admittedPages.length > 0
    ? nativeTypedArgsSchema(admitted[0]!.inputSchema) : undefined;
  const decisions: AstraJson[] = [
    ...(admitted.length ? [branch('act', { capabilityHandle: admitted.length === 1 ? { const: admitted[0]!.handle }
      : { enum: admitted.map(item => item.handle) },
    ...(typedArgsSchema ? { args: typedArgsSchema } : { argsJson: textSchema(argsJsonLimit(argsJsonChars)) }),
    reason: textSchema(ASTRA_AGENT_DECISION_LIMITS.reason),
    ...(visibleThought(argsJsonChars) ? { thought: textSchema(ASTRA_AGENT_DECISION_LIMITS.thought) } : {}) })] : []),
    ...(admittedPages.length ? [branch('expand', { pageHandle: admittedPages.length === 1 ? { const: admittedPages[0]!.handle }
      : { enum: admittedPages.map(item => item.handle) } })] : []),
    ...(completionReady ? [requiredEvidence > 1
      ? branch('complete', { text: textSchema(ASTRA_AGENT_DECISION_LIMITS.text), evidenceRefs: { type: 'array',
        items: { enum: refs }, minItems: requiredEvidence, maxItems: refs.length, uniqueItems: true } })
      : branch('complete', { text: textSchema(ASTRA_AGENT_DECISION_LIMITS.text), evidenceRef: refs.length === 0 ? { const: 'none' }
        : refs.length === 1 ? { const: refs[0]! } : { enum: refs } })] : []),
    // A page-only index is itself the available tool directory. The model must
    // inspect a relevant page before it can truthfully claim that an input or
    // capability is missing. Questions remain available on concrete pages.
    ...(admitted.length > 0 ? [branch('ask-user', { question: textSchema(ASTRA_AGENT_DECISION_LIMITS.question) })] : []),
  ];
  const schema: AstraJson = { oneOf: decisions };
  if (Buffer.byteLength(astraJournalJson(schema)) > 24_000) reject('schema-size');
  return schema;
}

export function astraAgentCatalogSurface(candidates: AstraAgentCapabilityCandidate[], evidence: AstraAgentEvidenceRef[],
  pages: AstraAgentCapabilityPage[] = [], minimumCompletionEvidence?: number): string {
  const admittedPages = copyPages(pages), admitted = copyCandidates(candidates, admittedPages.length > 0);
  if (admitted.length === 0 && admittedPages.length === 0) reject('empty-catalog');
  const observations = copyEvidence(evidence);
  const completionRefs = completionEvidence(observations).map(item => item.ref);
  return astraJournalJson(json({ schemaVersion: 'monarch.astra-v3-agent-catalog.internal.v1',
    catalogDigest: sha(astraJournalJson(admitted as unknown as AstraJson)),
    pagesDigest: sha(astraJournalJson(admittedPages as unknown as AstraJson)),
    evidenceDigest: sha(astraJournalJson(observations as unknown as AstraJson)),
    pages: admittedPages.map(({ handle, title, description, candidateHandles, childPageIds }) => ({
      handle, title, ...(description ? { description } : {}), itemCount: candidateHandles.length || childPageIds?.length || 0,
    })),
    catalogSemantics: 'Callable commands only; presence does not prove current connection, availability, contents or state.',
    // Exact capability/module identifiers remain host-side. The model can act
    // only with an opaque handle and therefore needs the semantic contract,
    // risk and compact input shape, not a second authority-looking identifier.
    candidates: admitted.map(({ handle, title, description, risk, inputSchema }) => ({
      handle, title, description, risk, inputSchema: modelInputSchema(inputSchema),
    })),
    completionEvidenceRefs: completionRefs.length ? completionRefs : ['none'],
    minimumCompletionEvidence: minimumEvidence(minimumCompletionEvidence),
  }));
}

/** Compact prompt contract. The complete JSON Schema is still supplied to the
 * prepared driver as its native grammar and is bound to the generated receipt;
 * repeating that large schema inside the prompt wastes scarce local context. */
export function astraAgentDecisionSurface(candidates: AstraAgentCapabilityCandidate[], evidence: AstraAgentEvidenceRef[],
  pages: AstraAgentCapabilityPage[] = [], minimumCompletionEvidence?: number,
  argsJsonChars: number = ASTRA_AGENT_DECISION_LIMITS.argsJson): string {
  const admittedPages = copyPages(pages), admitted = copyCandidates(candidates, admittedPages.length > 0);
  if (admitted.length === 0 && admittedPages.length === 0) reject('empty-catalog');
  const observations = copyEvidence(evidence);
  const requiredEvidence = minimumEvidence(minimumCompletionEvidence);
  const completionRefs = completionEvidence(observations).map(item => item.ref);
  const completionReady = completionRefs.length >= Math.max(requiredEvidence,
    admitted.length > 0 && admittedPages.length > 0 ? 1 : 0);
  const typedArguments = admitted.length === 1 && admittedPages.length > 0
    && nativeTypedArgsSchema(admitted[0]!.inputSchema) !== undefined;
  return astraJournalJson(json({
    schemaVersion: 'monarch.astra-v3-agent-decision-surface.internal.v1',
    output: 'one-json-object',
    // Exceeding a limit is not a truncated answer, it is a rejected decision and a
    // dead task, so the way out has to be named here: say what fits and offer the rest.
    limits: 'maxChars is a hard per-field ceiling; exceeding it voids the whole decision. '
      + 'If the result does not fit, complete with the part that fits and name what remains.',
    decisions: [
      ...(admittedPages.length ? [{ kind: 'expand', fields: ['pageHandle'] }] : []),
      ...(admitted.length ? [{ kind: 'act', fields: ['capabilityHandle', typedArguments ? 'args' : 'argsJson', 'reason',
        ...(visibleThought(argsJsonChars) ? ['thought'] : [])],
        ...(typedArguments ? { args: 'schema-bound-json-object' } : { argsJson: 'serialized-json-object' }),
        // How to write `reason` lives in the workflow instruction: this surface
        // must stay inside a 4K local window.
        ...(visibleThought(argsJsonChars) ? { thought: 'shown to the person as your reasoning: the short chain of facts and considerations that led to this step' } : {}),
        maxChars: { ...(typedArguments ? {} : { argsJson: argsJsonLimit(argsJsonChars) }),
          reason: ASTRA_AGENT_DECISION_LIMITS.reason,
          ...(visibleThought(argsJsonChars) ? { thought: ASTRA_AGENT_DECISION_LIMITS.thought } : {}) } }] : []),
      ...(completionReady ? [requiredEvidence > 1
        ? { kind: 'complete', fields: ['text', 'evidenceRefs'], evidenceRefs: completionRefs,
          minimumDistinctReceipts: requiredEvidence, maxChars: { text: ASTRA_AGENT_DECISION_LIMITS.text } }
        : { kind: 'complete', fields: ['text', 'evidenceRef'],
          evidenceRef: completionRefs.length ? completionRefs : ['none'],
          maxChars: { text: ASTRA_AGENT_DECISION_LIMITS.text } }] : []),
      ...(admitted.length ? [{ kind: 'ask-user', fields: ['question'],
        maxChars: { question: ASTRA_AGENT_DECISION_LIMITS.question } }] : []),
    ],
  }));
}

/** A model-output gateway, not capability admission. The accepted result has
 * authority:none and must still pass the source-bound V3 capability adapter.
 */
export class AstraAgentDecisionGateway {
  private readonly offers = new Map<string, Offer>();

  constructor(private readonly options: { isCurrent: (binding: AstraAgentDecisionBinding) => boolean;
    now?: () => number; ttlMs?: number }) {
    const ttl = options.ttlMs ?? 30_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 120_000) reject('ttl');
  }

  offer(input: { executionId: string; controlEpoch: number; catalogRevision: number; context: AstraContextPlan;
    candidates: AstraAgentCapabilityCandidate[]; pages?: AstraAgentCapabilityPage[]; evidence: AstraAgentEvidenceRef[];
    minimumCompletionEvidence?: number; argsJsonChars?: number }) {
    if (!id(input.executionId) || !Number.isSafeInteger(input.controlEpoch) || input.controlEpoch < 0
      || !Number.isSafeInteger(input.catalogRevision) || input.catalogRevision < 0) reject('binding');
    const pages = copyPages(input.pages ?? []), candidates = copyCandidates(input.candidates, pages.length > 0);
    if (candidates.length === 0 && pages.length === 0) reject('empty-catalog');
    const evidence = copyEvidence(input.evidence), requiredEvidence = minimumEvidence(input.minimumCompletionEvidence), plan = input.context;
    if (plan.executionId !== input.executionId || !Number.isSafeInteger(plan.sourceRevision) || plan.sourceRevision < 0
      || typeof plan.surface !== 'string' || Buffer.byteLength(plan.surface) !== plan.utf8Bytes
      || sha(plan.surface) !== plan.surfaceDigest || !plan.tokenizer?.driverGeneration) reject('context-binding');
    const surface = JSON.parse(plan.surface) as { executionId?: unknown; sourceRevision?: unknown;
      mandatory?: Array<{ kind?: unknown; ref?: unknown; text?: unknown }> };
    const catalog = astraAgentCatalogSurface(candidates, evidence, pages, requiredEvidence);
    const argsJsonChars = argsJsonLimit(input.argsJsonChars ?? ASTRA_AGENT_DECISION_LIMITS.argsJson);
    const decisionSurface = astraAgentDecisionSurface(candidates, evidence, pages, requiredEvidence, argsJsonChars);
    if (surface.executionId !== input.executionId || surface.sourceRevision !== plan.sourceRevision || !Array.isArray(surface.mandatory)
      || !surface.mandatory.some(item => item.kind === 'capability' && item.ref === 'astra_agent_catalog' && item.text === catalog)
      || !surface.mandatory.some(item => item.kind === 'capability' && item.ref === 'astra_agent_decision_schema'
        && item.text === decisionSurface)) {
      reject('catalog-context-binding');
    }
    const binding: AstraAgentDecisionBinding = { executionId: input.executionId, controlEpoch: input.controlEpoch,
      catalogRevision: input.catalogRevision, contextRevision: plan.sourceRevision, contextDigest: plan.surfaceDigest,
      driverGeneration: plan.tokenizer.driverGeneration,
      catalogDigest: sha(astraJournalJson(candidates as unknown as AstraJson)),
      pagesDigest: sha(astraJournalJson(pages as unknown as AstraJson)),
      evidenceDigest: sha(astraJournalJson(evidence as unknown as AstraJson)) };
    if (!this.options.isCurrent(structuredClone(binding))) reject('stale-context');
    const now = this.now();
    for (const [key, value] of this.offers) if (value.expiresAt <= now) this.offers.delete(key);
    if (this.offers.size >= 32) reject('offer-budget');
    const offerId = randomUUID();
    this.offers.set(offerId, { binding, candidates, pages, evidence, minimumCompletionEvidence: requiredEvidence, argsJsonChars,
      expiresAt: now + (this.options.ttlMs ?? 30_000) });
    return { offerId, binding: structuredClone(binding) };
  }

  accept(offerId: string, raw: string): AstraAgentDecisionResult {
    const offer = this.offers.get(offerId);
    if (!offer || this.now() >= offer.expiresAt || !this.options.isCurrent(structuredClone(offer.binding))) {
      return { status: 'rejected', code: 'stale-offer' };
    }
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32_768) return { status: 'rejected', code: 'decision-size' };
    const rawDigest = sha(raw);
    if (offer.rawDigest) return offer.rawDigest === rawDigest ? structuredClone(offer.result!)
      : { status: 'rejected', code: 'offer-already-consumed' };
    let result: AstraAgentDecisionResult;
    try { result = this.parse(raw, offer); }
    catch (error) { result = { status: 'rejected', code: error instanceof Error && error.message.startsWith('astra-agent-decision:')
      ? error.message.slice('astra-agent-decision:'.length) : 'decision-json-invalid' }; }
    offer.rawDigest = rawDigest; offer.result = structuredClone(result); return result;
  }

  private parse(raw: string, offer: Offer): AstraAgentDecisionResult {
    // A larger argsJson is escaped once more inside the decision itself.
    const { value, normalized } = parseAstraDecisionJson(raw, offer.argsJsonChars > ASTRA_AGENT_DECISION_LIMITS.argsJson ? 32_768 : 16_384), decision = object(value);
    if ('schemaVersion' in decision) {
      if (decision.schemaVersion !== ASTRA_AGENT_DECISION_VERSION) reject('schema-version');
      delete decision.schemaVersion; normalized.push('checked-schema-version');
    }
    if ('auditCorrelation' in decision) {
      if (!id(decision.auditCorrelation)) reject('audit-correlation');
      delete decision.auditCorrelation; normalized.push('inert-audit-correlation');
    }
    let proposal: AstraAgentProposal;
    if (decision.kind === 'act') {
      const typedArguments = offer.candidates.length === 1 && offer.pages.length > 0
        && nativeTypedArgsSchema(offer.candidates[0]!.inputSchema) !== undefined;
      // Reasoning is display-only: a MAX reply in plain JSON mode that leaves it
      // out still acts; it must not cost the task a repair turn.
      const thought = visibleThought(offer.argsJsonChars) && Object.hasOwn(decision, 'thought');
      exact(decision, ['kind', 'capabilityHandle', typedArguments ? 'args' : 'argsJson', 'reason', ...(thought ? ['thought'] : [])]);
      const candidate = offer.candidates.find(item => item.handle === decision.capabilityHandle);
      if (!candidate) reject('capability-handle');
      let args: Record<string, unknown>;
      if (typedArguments) args = object(decision.args);
      else {
        if (typeof decision.argsJson !== 'string') reject('arguments-json');
        try { args = parseAstraDecisionJson(decision.argsJson, offer.argsJsonChars === ASTRA_AGENT_DECISION_LIMITS.argsJson ? 4096 : 3 * offer.argsJsonChars).value; }
        catch { reject('arguments-json'); }
      }
      proposal = { kind: 'act', capabilityId: candidate.capabilityId, args: json(args) as { [key: string]: AstraJson },
        // Schema limits are characters; a Cyrillic character is two UTF-8 bytes.
        reason: narrative(decision.reason, 'reason', 4 * ASTRA_AGENT_DECISION_LIMITS.reason),
        ...(thought ? { thought: narrative(decision.thought, 'thought', 4 * ASTRA_AGENT_DECISION_LIMITS.thought) } : {}) };
    } else if (decision.kind === 'expand') {
      exact(decision, ['kind', 'pageHandle']);
      const page = offer.pages.find(item => item.handle === decision.pageHandle);
      if (!page) reject('page-handle');
      proposal = { kind: 'expand', pageId: page.pageId };
    } else if (decision.kind === 'complete') {
      const available = completionEvidence(offer.evidence);
      const requiresMany = offer.minimumCompletionEvidence > 1;
      exact(decision, ['kind', 'text', requiresMany ? 'evidenceRefs' : 'evidenceRef']);
      const selected = requiresMany ? decision.evidenceRefs : [decision.evidenceRef];
      if (!Array.isArray(selected) || selected.some(ref => typeof ref !== 'string')
        || requiresMany && (selected.length < offer.minimumCompletionEvidence || new Set(selected).size !== selected.length)
        || available.length < Math.max(offer.minimumCompletionEvidence,
          offer.candidates.length > 0 && offer.pages.length > 0 ? 1 : 0)
        || offer.evidence.length === 0 && (selected.length !== 1 || selected[0] !== 'none')
        || offer.evidence.length > 0 && selected.some(ref => !available.some(item => item.ref === ref))) {
        reject('completion-evidence');
      }
      proposal = { kind: 'complete', text: narrative(decision.text, 'text'),
        evidenceRefs: selected[0] === 'none' ? [] : selected as string[] };
    } else if (decision.kind === 'ask-user') {
      exact(decision, ['kind', 'question']); proposal = { kind: 'ask-user', question: narrative(decision.question, 'question', 4 * ASTRA_AGENT_DECISION_LIMITS.question) };
    } else reject('decision-kind');
    return { status: 'accepted', authority: 'none', proposal, normalized };
  }

  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) reject('clock'); return now;
  }
}
