import { AstraJournal } from '../agent-v3/journal';
import { modelReadDigest as digest, modelReadIdentity as id, modelReadJson as json } from '../agent-v3/model-read-task-state';
import { validateComputerWindowSelection } from '../modules/computer/native-bridge';
import type { AstraAuthenticatedHttpActor, AstraComputerSelectionCatalog, AstraComputerSelectionSnapshot, AstraTaskSourceContext } from './astra-task-facade';

export interface AstraWindowChoice { windowRef: string; processId: number; processInstanceId: string; title: string; processName: string }
type Principal = { actor: AstraAuthenticatedHttpActor; conversationId: string };
interface Issue extends Principal { requestId: string; window: AstraWindowChoice; ttlMs: number; timeoutMs: number }
interface Record { schemaVersion: 'monarch.astra-window-selection.internal.v1'; configDigest: string;
  selectionId: string; input: Issue; inputDigest: string; issuedAt: number; expiresAt: number; revoked: boolean }
interface Index { schemaVersion: 'monarch.astra-window-index.internal.v1'; configDigest: string; selections: string[] }
export interface AstraWindowSelectionDescriptor {
  selectionId: string; title: string; processName: string; expiresAt: number; authority: 'observe'; authorizesInput: false;
}
function check(value: unknown, code: string, statusCode = 409): asserts value {
  if (!value) throw Object.assign(Error('astra-window-selection:' + code), { statusCode, code: 'astra-window-selection-' + code });
}
function principal(value: Principal): void { check(value && id(value.conversationId) && value.actor
  && Object.keys(value.actor).length === 2 && /^sha256:[a-f0-9]{64}$/u.test(value.actor.id)
  && value.actor.source === 'desktop', 'principal', 403); }
export function validateAstraWindowChoice(value: AstraWindowChoice): void {
  check(value && Object.keys(value).length === 5 && Object.keys(value).every(key => ['windowRef', 'processId', 'processInstanceId', 'title', 'processName'].includes(key))
    && /^hwnd:[0-9A-F]{16}$/u.test(value.windowRef) && value.windowRef !== 'hwnd:0000000000000000'
    && typeof value.processName === 'string' && value.processName.length > 0 && value.processName.length <= 256, 'window');
  validateComputerWindowSelection({ processId: value.processId, processInstanceId: value.processInstanceId, title: value.title });
}

/** Host-only issuance in the SAME journal, not a second execution owner or an
 * HTTP grant API. One immutable window, finite cohort, reserved revocation, no
 * automatic renewal/discovery. Reopen retains expiry and revocation exactly. */
export class AstraComputerSelectionStore implements AstraComputerSelectionCatalog {
  private readonly configDigest: string; private readonly indexId: string; private readonly limit: number;
  constructor(private readonly options: { deployment: 'isolated-validation'; journal: AstraJournal; scopeId: string;
    maxSelections?: number; now?: () => number; onRevoked?: () => void }) {
    this.limit = options.maxSelections ?? 16;
    check(options.deployment === 'isolated-validation' && id(options.scopeId)
      && Number.isSafeInteger(this.limit) && this.limit >= 1 && this.limit <= 32, 'configuration');
    this.configDigest = digest({ scopeId: options.scopeId, version: 2, processIncarnationRequired: true, limit: this.limit });
    this.indexId = 'window_index_' + digest(options.scopeId).slice(7, 39);
    if (!options.journal.read(this.indexId)) options.journal.appendAtomic({ primary: { streamId: this.indexId, requestId: 'initialize', expectedRevision: 0,
      reservationId: this.indexId, checkpoint: json({ schemaVersion: 'monarch.astra-window-index.internal.v1', configDigest: this.configDigest, selections: [] }),
      events: [{ type: 'window-selection.index-initialized' }] }, reserve: [{ id: this.indexId, allocations: [{ streamId: this.indexId,
        commits: this.limit + 1, eventBytes: 512 * (this.limit + 1), checkpointBytes: 4096 }] }] });
    this.index();
  }
  usesJournal(journal: AstraJournal): boolean { return this.options.journal === journal; }
  issue(raw: Issue, guard: () => boolean): AstraWindowSelectionDescriptor {
    const input = structuredClone(raw); principal(input); validateAstraWindowChoice(input.window);
    check(Object.keys(input).length === 6 && Object.keys(input).every(key => ['actor', 'conversationId', 'requestId', 'window', 'ttlMs', 'timeoutMs'].includes(key))
      && id(input.requestId) && Number.isSafeInteger(input.ttlMs) && input.ttlMs >= 1000 && input.ttlMs <= 600000
      && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 50 && input.timeoutMs <= 10000, 'request');
    check(guard(), 'source-changed'); const selectionId = this.key(input.requestId, input), previous = this.options.journal.read(selectionId);
    if (previous) { const record = this.record(selectionId); check(record.inputDigest === digest(input), 'request-conflict'); this.active(record); return this.descriptor(record); }
    const before = this.options.journal.read(this.indexId)!, index = this.index(); check(index.selections.length < this.limit, 'cohort-capacity', 429);
    const issuedAt = this.now(), record: Record = { schemaVersion: 'monarch.astra-window-selection.internal.v1', configDigest: this.configDigest,
      selectionId, input, inputDigest: digest(input), issuedAt, expiresAt: issuedAt + input.ttlMs, revoked: false };
    check(Number.isSafeInteger(record.expiresAt), 'expiry');
    this.options.journal.appendAtomic({ primary: { streamId: selectionId, requestId: 'issue', expectedRevision: 0,
      reservationId: selectionId, checkpoint: json(record), events: [{ type: 'window-selection.issued', inputDigest: record.inputDigest }] },
      additional: [{ streamId: this.indexId, requestId: selectionId, expectedRevision: before.revision, reservationId: this.indexId,
        checkpoint: json({ ...index, selections: [...index.selections, selectionId] }), events: [{ type: 'window-selection.indexed', selectionId }] }],
      reserve: [{ id: selectionId, allocations: [{ streamId: selectionId, commits: 2, eventBytes: 1024,
        checkpointBytes: Buffer.byteLength(JSON.stringify(record)) + 256 }] }] }, guard);
    return this.descriptor(record);
  }
  findIssued(requestId: string, context: Principal): AstraWindowSelectionDescriptor | null {
    principal(context); check(id(requestId), 'request'); const key = this.key(requestId, context);
    if (!this.options.journal.read(key)) return null; const record = this.owned(key, context); this.active(record); return this.descriptor(record);
  }
  resolve(selectionId: string, context: AstraTaskSourceContext): AstraComputerSelectionSnapshot {
    const record = this.owned(selectionId, context); this.active(record); const input = record.input;
    return { selectionId, actor: structuredClone(input.actor), conversationId: input.conversationId, revision: 1,
      windowRef: input.window.windowRef, processId: input.window.processId, processInstanceId: input.window.processInstanceId, title: input.window.title,
      expiresAt: record.expiresAt, timeoutMs: input.timeoutMs };
  }
  list(context: Principal): AstraWindowSelectionDescriptor[] {
    principal(context); const now = this.now(); return this.index().selections.map(key => this.record(key))
      .filter(record => this.matches(record, context) && !record.revoked && now >= record.issuedAt && now < record.expiresAt).map(record => this.descriptor(record));
  }
  revoke(selectionId: string, context: Principal): void {
    const record = this.owned(selectionId, context);
    if (!record.revoked) this.options.journal.appendAtomic({ primary: { streamId: selectionId, requestId: 'revoke',
      expectedRevision: this.options.journal.read(selectionId)!.revision, reservationId: selectionId,
      checkpoint: json({ ...record, revoked: true }), events: [{ type: 'window-selection.revoked' }] }, release: [selectionId] });
    this.options.onRevoked?.(); // Durable deny first; a failed notification cannot undo it.
  }
  private index(): Index {
    const index = this.options.journal.read(this.indexId)?.checkpoint as unknown as Index;
    check(index?.schemaVersion === 'monarch.astra-window-index.internal.v1' && index.configDigest === this.configDigest
      && Object.keys(index).length === 3 && Array.isArray(index.selections) && index.selections.length <= this.limit
      && index.selections.every(key => /^window_selection_[a-f0-9]{32}$/u.test(key)) && new Set(index.selections).size === index.selections.length, 'index'); return index;
  }
  private record(selectionId: string): Record {
    const record = this.options.journal.read(selectionId)?.checkpoint as unknown as Record; check(record, 'not-found', 404);
    check(record.schemaVersion === 'monarch.astra-window-selection.internal.v1' && record.configDigest === this.configDigest
      && Object.keys(record).length === 8 && record.selectionId === selectionId && typeof record.revoked === 'boolean'
      && Number.isSafeInteger(record.issuedAt) && record.issuedAt > 0 && Number.isSafeInteger(record.expiresAt)
      && record.expiresAt === record.issuedAt + record.input.ttlMs && record.inputDigest === digest(record.input)
      && selectionId === this.key(record.input.requestId, record.input), 'record');
    principal(record.input); validateAstraWindowChoice(record.input.window); return record;
  }
  private owned(selectionId: string, context: Principal): Record {
    principal(context); check(/^window_selection_[a-f0-9]{32}$/u.test(selectionId), 'not-found', 404);
    const record = this.record(selectionId); check(this.matches(record, context), 'not-found', 404); return record;
  }
  private matches(record: Record, context: Principal): boolean { return digest(record.input.actor) === digest(context.actor) && record.input.conversationId === context.conversationId; }
  private key(requestId: string, context: Principal): string { return 'window_selection_' + digest({ config: this.configDigest, requestId, actor: context.actor, conversationId: context.conversationId }).slice(7, 39); }
  private active(record: Record): void { const now = this.now(); check(!record.revoked && now >= record.issuedAt && now < record.expiresAt, 'unavailable'); }
  private now(): number { const now = (this.options.now ?? Date.now)(); check(Number.isSafeInteger(now) && now > 0, 'clock'); return now; }
  private descriptor(record: Record): AstraWindowSelectionDescriptor { return { selectionId: record.selectionId,
    title: record.input.window.title, processName: record.input.window.processName, expiresAt: record.expiresAt, authority: 'observe', authorizesInput: false }; }
}
