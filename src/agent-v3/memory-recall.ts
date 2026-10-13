import { createHash } from 'node:crypto';
import { astraJournalJson, type AstraJson } from './journal';
import type { AstraContextSource } from './context-engine';

export const ASTRA_MEMORY_RECALL_SCHEMA_VERSION = 'monarch.astra-v3-memory-recall.internal.v1' as const;
const MAX_MEMORY_ITEMS = 8;
const MAX_MEMORY_TEXT_BYTES = 2_400;
const MAX_CONTEXT_PROJECTION_BYTES = 4_096;
const MAX_SNAPSHOT_BYTES = 8_192;

export type AstraMemoryRecallKind = 'explicit' | 'episode' | 'capsule';
export interface AstraMemoryRecallItem {
  kind: AstraMemoryRecallKind;
  itemDigest: `sha256:${string}`;
  text: string;
  truncated: boolean;
  origin?: { conversationId?: string; turnId?: string; capsuleId?: string };
}
export interface AstraMemoryRecallSnapshot {
  schemaVersion: typeof ASTRA_MEMORY_RECALL_SCHEMA_VERSION;
  scope: { type: 'chat' };
  revision: string;
  crossChatEnabled: boolean;
  items: AstraMemoryRecallItem[];
  omittedItems: number;
  sourceDigest: `sha256:${string}`;
  queryDigest: `sha256:${string}`;
  validityToken?: `sha256:${string}`;
}

type MemoryV4Item = {
  kind: AstraMemoryRecallKind;
  id: string;
  text: string;
  origin: { conversationId?: string; turnId?: string; capsuleId?: string };
};

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error('astra-memory-recall:' + code);
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function digest(value: unknown): `sha256:${string}` {
  return ('sha256:' + createHash('sha256').update(astraJournalJson(value as AstraJson)).digest('hex')) as `sha256:${string}`;
}
function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}
function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 48 && Number.isFinite(Date.parse(value));
}
function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString('utf8').trimEnd();
}
function readItem(value: unknown, expected: 'explicit' | 'episode'): MemoryV4Item {
  check(record(value) && Object.keys(value).every(key =>
    ['kind', 'id', 'text', 'title', 'createdAt', 'score', 'reason', 'origin'].includes(key)), 'item-shape');
  const kind = value.kind;
  check(kind === expected || expected === 'episode' && kind === 'capsule', 'item-kind');
  check(safeId(value.id) && typeof value.text === 'string' && value.text.trim().length > 0
    && Buffer.byteLength(value.text) <= 16_384 && typeof value.title === 'string' && Buffer.byteLength(value.title) <= 2_048
    && validIso(value.createdAt) && typeof value.score === 'number' && Number.isFinite(value.score)
    && value.score >= 0 && value.score <= 1 && typeof value.reason === 'string' && value.reason.length <= 160
    && record(value.origin) && Object.keys(value.origin).every(key => ['conversationId', 'turnId', 'capsuleId'].includes(key)), 'item-fields');
  const origin: MemoryV4Item['origin'] = {};
  for (const key of ['conversationId', 'turnId', 'capsuleId'] as const) {
    const item = value.origin[key];
    if (item !== undefined) { check(safeId(item), 'item-origin'); origin[key] = item; }
  }
  return { kind: kind as AstraMemoryRecallKind, id: value.id, text: value.text.trim(), origin };
}
function projection(snapshot: Omit<AstraMemoryRecallSnapshot, 'sourceDigest'>): AstraContextSource['optional'] {
  return snapshot.items.map((item, index) => ({
    kind: 'recalled-memory' as const,
    ref: `memory_${index}_${item.itemDigest.slice(7, 23)}`,
    text: astraJournalJson({
      trust: 'untrusted-recalled-memory',
      instructionsAllowed: false,
      authorityEligible: false,
      kind: item.kind,
      text: item.text,
      truncated: item.truncated,
    }),
  }));
}

/** Converts the existing Memory V4 response into a small immutable Astra
 * snapshot. This is an admission boundary, not another memory store or search
 * engine. Invalid scope/provenance fails closed; optional tail items may be
 * omitted to keep the complete serialized ContextEngine projection <= 4 KiB. */
export function compileAstraMemoryRecall(value: unknown, query: string): AstraMemoryRecallSnapshot {
  check(typeof query === 'string' && query.trim().length > 0 && Buffer.byteLength(query) <= 8192, 'query');
  const queryDigest = digest(query);
  check(record(value) && Object.keys(value).every(key => ['schemaVersion', 'scope', 'revision', 'explicitMemories',
    'episodes', 'budgetChars', 'usedChars', 'engine', 'semanticTimedOut', 'retrievalReason', 'rerankerStatus',
    'crossChatEnabled', 'cache', 'validityToken'].includes(key)), 'response-shape');
  check(value.validityToken === undefined || typeof value.validityToken === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value.validityToken), 'validity-token');
  const validity = value.validityToken === undefined ? {} : { validityToken: value.validityToken as `sha256:${string}` };
  check(value.schemaVersion === 1 && record(value.scope) && Object.keys(value.scope).length === 1 && value.scope.type === 'chat'
    && typeof value.revision === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(value.revision)
    && Array.isArray(value.explicitMemories) && value.explicitMemories.length <= 4
    && Array.isArray(value.episodes) && value.episodes.length <= 4
    && Number.isSafeInteger(value.budgetChars) && Number(value.budgetChars) >= 0 && Number(value.budgetChars) <= 16_384
    && Number.isSafeInteger(value.usedChars) && Number(value.usedChars) >= 0 && Number(value.usedChars) <= Number(value.budgetChars)
    && typeof value.engine === 'string' && value.engine.length > 0 && value.engine.length <= 160
    && typeof value.semanticTimedOut === 'boolean'
    && (value.retrievalReason === undefined || ['reranker-ready', 'lexical-floor-fallback'].includes(String(value.retrievalReason)))
    && (value.rerankerStatus === undefined || ['reranker-ready', 'reranker-timeout', 'reranker-unavailable'].includes(String(value.rerankerStatus)))
    && typeof value.crossChatEnabled === 'boolean'
    && ['hit', 'miss'].includes(String(value.cache)), 'response-fields');
  check(value.crossChatEnabled || value.episodes.length === 0, 'cross-chat-disabled');
  const source = [
    ...value.explicitMemories.map(item => readItem(item, 'explicit')),
    ...value.episodes.map(item => readItem(item, 'episode')),
  ];
  check(new Set(source.map(item => item.kind + ':' + item.id)).size === source.length, 'duplicate-item');
  const items: AstraMemoryRecallItem[] = [];
  let remainingTextBytes = MAX_MEMORY_TEXT_BYTES;
  for (const candidate of source.slice(0, MAX_MEMORY_ITEMS)) {
    if (remainingTextBytes <= 0) break;
    const text = truncateUtf8(candidate.text, Math.min(600, remainingTextBytes));
    if (!text) continue;
    const item: AstraMemoryRecallItem = {
      kind: candidate.kind,
      itemDigest: digest({ kind: candidate.kind, id: candidate.id, text: candidate.text, origin: candidate.origin }),
      text,
      truncated: text !== candidate.text,
      ...(Object.keys(candidate.origin).length ? { origin: candidate.origin } : {}),
    };
    const base = { schemaVersion: ASTRA_MEMORY_RECALL_SCHEMA_VERSION, scope: { type: 'chat' as const },
      revision: value.revision, crossChatEnabled: value.crossChatEnabled, items: [...items, item],
      omittedItems: source.length - items.length - 1, queryDigest, ...validity };
    if (projectionBytes(base) > MAX_CONTEXT_PROJECTION_BYTES
      || Buffer.byteLength(astraJournalJson({ ...base, sourceDigest: 'sha256:' + '0'.repeat(64) } as unknown as AstraJson)) > MAX_SNAPSHOT_BYTES) break;
    items.push(item); remainingTextBytes -= Buffer.byteLength(text);
  }
  const body = { schemaVersion: ASTRA_MEMORY_RECALL_SCHEMA_VERSION, scope: { type: 'chat' as const },
    revision: value.revision, crossChatEnabled: value.crossChatEnabled, items,
    omittedItems: source.length - items.length, queryDigest, ...validity };
  const snapshot: AstraMemoryRecallSnapshot = { ...body, sourceDigest: digest(body) };
  validateAstraMemoryRecall(snapshot);
  return snapshot;
}

export function validateAstraMemoryRecall(value: unknown): asserts value is AstraMemoryRecallSnapshot {
  check(record(value) && Object.keys(value).length === (value.validityToken === undefined ? 8 : 9) && Object.keys(value).every(key =>
    ['schemaVersion', 'scope', 'revision', 'crossChatEnabled', 'items', 'omittedItems', 'sourceDigest', 'queryDigest', 'validityToken'].includes(key)), 'snapshot-shape');
  check(value.validityToken === undefined || typeof value.validityToken === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value.validityToken), 'validity-token');
  check(value.schemaVersion === ASTRA_MEMORY_RECALL_SCHEMA_VERSION && record(value.scope)
    && Object.keys(value.scope).length === 1 && value.scope.type === 'chat'
    && typeof value.revision === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(value.revision)
    && typeof value.crossChatEnabled === 'boolean' && Array.isArray(value.items) && value.items.length <= MAX_MEMORY_ITEMS
    && Number.isSafeInteger(value.omittedItems) && Number(value.omittedItems) >= 0 && Number(value.omittedItems) + value.items.length <= 8
    && typeof value.queryDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.queryDigest)
    && typeof value.sourceDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.sourceDigest), 'snapshot-fields');
  let textBytes = 0;
  for (const item of value.items) {
    check(record(item) && Object.keys(item).every(key => ['kind', 'itemDigest', 'text', 'truncated', 'origin'].includes(key))
      && ['explicit', 'episode', 'capsule'].includes(String(item.kind))
      && typeof item.itemDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(item.itemDigest)
      && typeof item.truncated === 'boolean' && (value.crossChatEnabled || item.kind === 'explicit')
      && typeof item.text === 'string' && item.text.trim().length > 0 && Buffer.byteLength(item.text) <= 600, 'snapshot-item');
    textBytes += Buffer.byteLength(item.text);
    if (item.origin !== undefined) {
      check(record(item.origin) && Object.keys(item.origin).every(key => ['conversationId', 'turnId', 'capsuleId'].includes(key))
        && Object.values(item.origin).every(safeId), 'snapshot-origin');
    }
  }
  check(textBytes <= MAX_MEMORY_TEXT_BYTES, 'snapshot-text-budget');
  check(new Set(value.items.map(item => item.itemDigest)).size === value.items.length, 'snapshot-duplicate');
  const { sourceDigest, ...body } = value as unknown as AstraMemoryRecallSnapshot;
  check(digest(body) === sourceDigest
    && projectionBytes(body) <= MAX_CONTEXT_PROJECTION_BYTES
    && Buffer.byteLength(astraJournalJson(value as unknown as AstraJson)) <= MAX_SNAPSHOT_BYTES,
  'snapshot-integrity');
}

function projectionBytes(snapshot: Omit<AstraMemoryRecallSnapshot, 'sourceDigest'>): number {
  // Match ContextEngine's final wrappers, not the pre-render projection.
  return Buffer.byteLength(astraJournalJson(projection(snapshot).map(item => ({ ...item, authorityEligible: false })) as unknown as AstraJson));
}

export function validateAstraMemoryQuery(value: AstraMemoryRecallSnapshot, query: string): void {
  validateAstraMemoryRecall(value);
  check(value.queryDigest === digest(query), 'query-binding');
}

export function projectAstraMemoryRecall(value: AstraMemoryRecallSnapshot): AstraContextSource['optional'] {
  validateAstraMemoryRecall(value);
  return structuredClone(projection(value));
}

/** Compare only a fresh authenticated backend response; this is not a lease or
 * permission grant. Legacy snapshots remain readable but cannot pass live admission. */
export function isAstraMemoryRecallCurrent(snapshot: AstraMemoryRecallSnapshot, response: unknown): boolean {
  try { validateAstraMemoryRecall(snapshot); } catch { return false; }
  return snapshot.validityToken !== undefined && record(response) && Object.keys(response).length === 5
    && Object.keys(response).every(key => ['schemaVersion', 'scope', 'revision', 'crossChatEnabled', 'validityToken'].includes(key))
    && response.schemaVersion === 1 && record(response.scope) && Object.keys(response.scope).length === 1
    && response.scope.type === 'chat' && response.revision === snapshot.revision
    && response.crossChatEnabled === snapshot.crossChatEnabled && response.validityToken === snapshot.validityToken;
}
