import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { AstraJournal, astraJournalJson, type AstraJson, type AstraJournalSnapshot } from '../agent-v3/journal';
import { validateAstraSelectedTargetSnapshot, type AstraSelectedTarget, type AstraSelectedTargetPort, type AstraSelectedTargetSnapshot } from './astra-source-goal-compiler';
import type { AstraAuthenticatedHttpActor, AstraTaskSourceContext } from './astra-task-facade';

type Principal = { actor: AstraAuthenticatedHttpActor; conversationId: string };
export interface AstraTargetSelectionRequest extends Principal { requestId: string; targets: AstraSelectedTarget[]; ttlMs: number }
export interface AstraTargetSelectionDescriptor {
  selectionId: string; expiresAt: number;
  targets: Array<{ targetId: string; label: string; access: AstraSelectedTarget['access']; maxBytes: number }>;
}
/** HTTP can list/revoke an already issued selection, NEVER issue raw paths. */
export interface AstraTargetSelectionSurface {
  list(principal: Principal): AstraTargetSelectionDescriptor[];
  revoke(selectionId: string, principal: Principal): void;
}
interface Index { schemaVersion: 'monarch.astra-target-index.internal.v1'; configDigest: string; selections: string[] }
interface Record extends Principal {
  schemaVersion: 'monarch.astra-target-selection.internal.v1'; selectionId: string; configDigest: string;
  requestId: string; requestDigest: string; ttlMs: number; issuedAt: number; expiresAt: number;
  state: 'active' | 'revoked'; snapshot: AstraSelectedTargetSnapshot;
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const hash = (value: unknown): string => createHash('sha256').update(astraJournalJson(json(value))).digest('hex');
function check(value: unknown, statusCode: number, code: string): asserts value {
  if (!value) throw Object.assign(Error('astra-selection:' + code), { statusCode, code: 'astra-selection-' + code });
}
function principal(value: Principal): void {
  check(value && id(value.conversationId) && value.actor && /^sha256:[a-f0-9]{64}$/u.test(value.actor.id)
    && ['desktop', 'api', 'telegram'].includes(value.actor.source) && Object.keys(value.actor).every(key => ['id', 'source'].includes(key)), 400, 'principal');
}

/** Local host-owned selection lifecycle in the EXISTING journal. This is not a
 * picker, permission grant, scheduler or filesystem reader. Issued targets are
 * immutable; replacement needs a NEW selection. Revocation capacity is reserved
 * with issuance, so pressure cannot silently keep a selection authorized.
 * Finite cohort (default32, maximum64 lifetime selections); no unbounded history,
 * silent eviction/renewal or expiry polling. Product archival remains separate. */
export class AstraTargetSelectionStore implements AstraSelectedTargetPort, AstraTargetSelectionSurface {
  private readonly streamId: string;
  private readonly configDigest: string;
  private readonly limit: number;
  private readonly clock: () => number;
  constructor(private readonly options: { deployment: 'isolated-validation'; journal: AstraJournal; scopeId: string;
    canonicalRoot: string; maxSelections?: number; now?: () => number; onRevoked?: () => void }) {
    this.limit = options.maxSelections ?? 32; this.clock = options.now ?? Date.now;
    check(options.deployment === 'isolated-validation' && id(options.scopeId) && Number.isSafeInteger(this.limit)
      && this.limit >= 1 && this.limit <= 64, 400, 'configuration');
    check(path.isAbsolute(options.canonicalRoot) && realpathSync(options.canonicalRoot) === options.canonicalRoot, 409, 'canonical-root');
    this.streamId = 'target_index_' + hash(options.scopeId).slice(0, 32);
    this.configDigest = hash({ version: 1, scopeId: options.scopeId, root: options.canonicalRoot, limit: this.limit });
    if (!options.journal.read(this.streamId)) {
      const reservationId = this.streamId + '_budget';
      options.journal.appendAtomic({ primary: { streamId: this.streamId, requestId: 'initialize', expectedRevision: 0,
        reservationId, checkpoint: json({ schemaVersion: 'monarch.astra-target-index.internal.v1', configDigest: this.configDigest, selections: [] }),
        events: [{ type: 'selection.index-initialized' }] }, reserve: [{ id: reservationId, allocations: [{ streamId: this.streamId,
        commits: this.limit + 1, eventBytes: 256 * (this.limit + 1), checkpointBytes: 8192 }] }] });
    }
    this.index();
  }
  issue(input: AstraTargetSelectionRequest): AstraSelectedTargetSnapshot {
    principal(input);
    check(Object.keys(input).every(key => ['actor', 'conversationId', 'requestId', 'targets', 'ttlMs'].includes(key))
      && id(input.requestId) && Number.isSafeInteger(input.ttlMs) && input.ttlMs >= 1000 && input.ttlMs <= 86400000, 400, 'request');
    const selectionId = this.selectionId(input.requestId, input);
    const requestDigest = hash(input), old = this.options.journal.read(selectionId);
    if (old) {
      const record = this.record(selectionId); check(record.requestDigest === requestDigest, 409, 'request-conflict');
      this.active(record); return structuredClone(record.snapshot);
    }
    const snapshot: AstraSelectedTargetSnapshot = { selectionId, actor: structuredClone(input.actor), conversationId: input.conversationId,
      revision: 1, targets: structuredClone(input.targets) };
    validateAstraSelectedTargetSnapshot(snapshot, snapshot);
    const index = this.index(); check(index.value.selections.length < this.limit, 429, 'cohort-capacity');
    const issuedAt = this.now(), record: Record = { schemaVersion: 'monarch.astra-target-selection.internal.v1', configDigest: this.configDigest,
      selectionId, actor: snapshot.actor, conversationId: snapshot.conversationId, requestId: input.requestId, requestDigest,
      ttlMs: input.ttlMs, issuedAt, expiresAt: issuedAt + input.ttlMs, state: 'active', snapshot };
    check(Number.isSafeInteger(record.expiresAt), 400, 'expiry');
    const checkpoint = json(record), bytes = Buffer.byteLength(astraJournalJson(checkpoint));
    check(bytes <= 65536, 400, 'selection-bytes');
    const reservationId = selectionId + '_budget';
    this.options.journal.appendAtomic({ primary: { streamId: selectionId, requestId: 'issue', expectedRevision: 0,
      reservationId, checkpoint, events: [{ type: 'selection.issued', requestDigest }] },
      additional: [{ streamId: this.streamId, requestId: selectionId, expectedRevision: index.snapshot.revision, reservationId: this.streamId + '_budget',
        checkpoint: json({ ...index.value, selections: [...index.value.selections, selectionId] }), events: [{ type: 'selection.indexed', selectionId }] }],
      reserve: [{ id: reservationId, allocations: [{ streamId: selectionId, commits: 2, eventBytes: 1024, checkpointBytes: bytes + 128 }] }] });
    return structuredClone(snapshot);
  }
  /** Host recovery lookup, NOT an active grant or a renewal. */
  findIssued(requestId: string, context: Principal): { selectionId: string; state: Record['state']; expiresAt: number } | null {
    principal(context); check(id(requestId), 400, 'request'); const selectionId = this.selectionId(requestId, context);
    if (!this.options.journal.read(selectionId)) return null;
    const record = this.owned(selectionId, context); return { selectionId, state: record.state, expiresAt: record.expiresAt };
  }
  /** Lifecycle-owner identity check. Unlike resolve/list this deliberately does
   * not turn expiry/revocation into actor loss, so cancellation remains possible. */
  owns(selectionId: string, context: Principal): boolean {
    try { this.owned(selectionId, context); return true; } catch { return false; }
  }
  /** Trusted producer must not validate a path against a different root. */
  assertCanonicalRoot(root: string): void { check(root === this.options.canonicalRoot, 409, 'producer-root'); }
  resolve(selectionId: string, context: AstraTaskSourceContext): AstraSelectedTargetSnapshot {
    const record = this.owned(selectionId, context); this.active(record); return structuredClone(record.snapshot);
  }
  list(context: Principal): AstraTargetSelectionDescriptor[] {
    principal(context); const now = this.now();
    return this.index().value.selections.map(selectionId => this.record(selectionId))
      .filter(record => this.matches(record, context) && record.state === 'active' && now >= record.issuedAt && now < record.expiresAt)
      .map(record => ({ selectionId: record.selectionId, expiresAt: record.expiresAt,
        targets: record.snapshot.targets.map(target => ({ targetId: target.id, label: target.relativePath, access: target.access, maxBytes: target.maxBytes })) }));
  }
  revoke(selectionId: string, context: Principal): void {
    const record = this.owned(selectionId, context);
    if (record.state === 'revoked') { this.options.onRevoked?.(); return; }
    const snapshot = this.options.journal.read(selectionId)!;
    this.options.journal.appendAtomic({ primary: { streamId: selectionId, requestId: 'revoke', expectedRevision: snapshot.revision,
      reservationId: selectionId + '_budget', checkpoint: json({ ...record, state: 'revoked' }), events: [{ type: 'selection.revoked' }] },
      release: [selectionId + '_budget'] });
    // Notification is after the durable deny. A host notification failure cannot
    // roll the revoke back; retry notifies again without another journal write.
    this.options.onRevoked?.();
  }
  private owned(selectionId: string, context: Principal): Record {
    principal(context); check(typeof selectionId === 'string' && /^selection_[a-f0-9]{32}$/u.test(selectionId), 404, 'not-found');
    const record = this.record(selectionId);
    check(this.matches(record, context), 404, 'not-found'); return record;
  }
  private matches(record: Record, context: Principal): boolean {
    return record.actor.id === context.actor.id && record.actor.source === context.actor.source && record.conversationId === context.conversationId;
  }
  private selectionId(requestId: string, context: Principal): string {
    return 'selection_' + hash({ config: this.configDigest, actor: context.actor, conversationId: context.conversationId, requestId }).slice(0, 32);
  }
  private active(record: Record): void { const now = this.now(); check(record.state === 'active' && now >= record.issuedAt && now < record.expiresAt, 409, 'unavailable'); }
  private now(): number { const now = this.clock(); check(Number.isSafeInteger(now) && now > 0, 409, 'clock'); return now; }
  private index(): { snapshot: AstraJournalSnapshot; value: Index } {
    const snapshot = this.options.journal.read(this.streamId), value = snapshot?.checkpoint as unknown as Index;
    check(value?.schemaVersion === 'monarch.astra-target-index.internal.v1' && value.configDigest === this.configDigest
      && Object.keys(value).every(key => ['schemaVersion', 'configDigest', 'selections'].includes(key))
      && Array.isArray(value.selections) && value.selections.length <= this.limit && value.selections.every(id)
      && new Set(value.selections).size === value.selections.length, 409, 'index-config-or-corruption');
    return { snapshot: snapshot!, value };
  }
  private record(selectionId: string): Record {
    const stored = this.options.journal.read(selectionId); check(stored, 404, 'not-found');
    const value = stored.checkpoint as unknown as Record;
    check(value?.schemaVersion === 'monarch.astra-target-selection.internal.v1' && value.configDigest === this.configDigest
      && Object.keys(value).every(key => ['schemaVersion', 'selectionId', 'configDigest', 'requestId', 'requestDigest', 'ttlMs',
        'issuedAt', 'expiresAt', 'state', 'snapshot', 'actor', 'conversationId'].includes(key))
      && value.selectionId === selectionId && ['active', 'revoked'].includes(value.state)
      && Number.isSafeInteger(value.issuedAt) && value.issuedAt > 0 && Number.isSafeInteger(value.ttlMs)
      && value.ttlMs >= 1000 && value.ttlMs <= 86400000 && Number.isSafeInteger(value.expiresAt) && value.expiresAt === value.issuedAt + value.ttlMs
      && id(value.requestId), 409, 'record-corruption');
    validateAstraSelectedTargetSnapshot(value.snapshot, { selectionId, actor: value.actor, conversationId: value.conversationId });
    check(value.requestDigest === hash({ actor: value.actor, conversationId: value.conversationId, requestId: value.requestId,
      targets: value.snapshot.targets, ttlMs: value.ttlMs }) && selectionId === 'selection_' + hash({ config: this.configDigest,
      actor: value.actor, conversationId: value.conversationId, requestId: value.requestId }).slice(0, 32), 409, 'request-corruption');
    return value;
  }
}
