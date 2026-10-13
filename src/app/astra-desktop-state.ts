import { createHash } from 'node:crypto';
import { AstraJournal, astraJournalJson, type AstraJson, type AstraJournalReservation } from '../agent-v3/journal';
import type { AstraAuthenticatedHttpActor } from './astra-task-facade';
import type { OscarTurnCheckpoint } from '../oscar-turn/types';

export interface AstraDesktopState { state: 'idle' | 'pending' | 'linked'; requestId: string | null; turnId: string | null }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
function check(value: unknown, code: string): asserts value { if (!value) throw Error('astra-desktop-state:' + code); }

/** Allows the owning conversation directory to reserve future pointers atomically.
 * Identical replay of a reservation does not replenish its remaining capacity. */
export function astraDesktopStateReservation(scopeId: string, limit = 256): AstraJournalReservation {
  check(id(scopeId) && Number.isSafeInteger(limit) && limit >= 4 && limit <= 1024, 'configuration');
  const streamId = 'desktop_' + createHash('sha256').update(scopeId).digest('hex').slice(0, 32);
  return { id: streamId + '_budget', allocations: [{ streamId, commits: limit + 1, checkpointBytes: 1024, eventBytes: 256 * (limit + 1) }] };
}

/** Minimal UI pointer in the EXISTING journal. No text, file bytes or token.
 * It neither executes/cancels work nor grants authority. Real Turn/selection
 * stores remain authoritative. One fixed host surface; finite reserved cohort. */
export class AstraDesktopStateStore {
  private readonly stream: string;
  private readonly binding: string;
  private readonly reservation: AstraJournalReservation;
  constructor(private readonly options: { deployment: 'isolated-validation'; scopeId: string; journal: AstraJournal;
    actor: AstraAuthenticatedHttpActor; conversationId: string; getTurn(id: string): Promise<OscarTurnCheckpoint | null>; maxTransitions?: number;
    reservationPlan?: AstraJournalReservation }) {
    const limit = options.maxTransitions ?? 256;
    check(options.deployment === 'isolated-validation' && id(options.scopeId) && id(options.conversationId)
      && options.actor.source === 'desktop' && /^sha256:[a-f0-9]{64}$/u.test(options.actor.id)
      && Number.isSafeInteger(limit) && limit >= 4 && limit <= 1024, 'configuration');
    this.stream = 'desktop_' + createHash('sha256').update(options.scopeId).digest('hex').slice(0, 32);
    const own = astraDesktopStateReservation(options.scopeId, limit);
    this.reservation = structuredClone(options.reservationPlan ?? own);
    check(astraJournalJson(json(this.reservation.allocations.find(item => item.streamId === this.stream) ?? null))
      === astraJournalJson(json(own.allocations[0])), 'reservation-allocation');
    this.binding = createHash('sha256').update(astraJournalJson(json({ version: 1, actor: options.actor, conversationId: options.conversationId, limit,
      ...(options.reservationPlan ? { reservationId: this.reservation.id } : {}) }))).digest('hex');
    if (!options.journal.read(this.stream)) {
      options.journal.appendAtomic({ primary: { streamId: this.stream, requestId: 'initialize', expectedRevision: 0, reservationId: this.reservation.id,
        checkpoint: json({ binding: this.binding, state: 'idle', requestId: null, turnId: null }), events: [{ type: 'desktop.initialized' }] },
        reserve: [this.reservation] });
    }
    this.read();
  }
  read(): AstraDesktopState {
    const value = this.options.journal.read(this.stream)?.checkpoint as unknown as AstraDesktopState & { binding: string };
    check(value?.binding === this.binding && Object.keys(value).every(key => ['binding', 'state', 'requestId', 'turnId'].includes(key))
      && (value.state === 'idle' && value.requestId === null && value.turnId === null
        || value.state === 'pending' && id(value.requestId) && value.turnId === null
        || value.state === 'linked' && id(value.requestId) && id(value.turnId)), 'state-or-binding');
    return { state: value.state, requestId: value.requestId, turnId: value.turnId };
  }
  async pending(requestId: string, assertSource: () => void = () => {}): Promise<AstraDesktopState> {
    assertSource();
    check(id(requestId), 'request'); const before = this.read();
    if (before.requestId === requestId) return before;
    check(before.state !== 'pending', 'pending-submission');
    if (before.state === 'linked') {
      const turn = await this.turn(before.turnId!);
      check(['succeeded', 'failed', 'blocked', 'cancelled'].includes(turn.status), 'active-turn');
    }
    assertSource(); return this.commit(before, { state: 'pending', requestId, turnId: null });
  }
  async linked(turnId: string, assertSource: () => void = () => {}): Promise<AstraDesktopState> {
    assertSource();
    check(id(turnId), 'turn'); const before = this.read(), turn = await this.turn(turnId);
    assertSource();
    if (before.state === 'linked' && before.turnId === turn.id && before.requestId === turn.clientRequestId) return this.commit(before, before);
    check(before.state === 'pending' && before.requestId === turn.clientRequestId, 'link-mismatch');
    return this.commit(before, { state: 'linked', requestId: turn.clientRequestId, turnId });
  }
  clear(requestId: string): AstraDesktopState {
    check(id(requestId), 'request'); const before = this.read();
    if (before.state === 'idle') return before;
    check(before.state === 'pending' && before.requestId === requestId, 'clear-mismatch');
    // Called only after the separate server rejection/cancellation flow. Clearing
    // a view is NOT proof that a physical action stopped; no task is deleted.
    return this.commit(before, { state: 'idle', requestId: null, turnId: null });
  }
  private async turn(turnId: string) {
    const turn = (await this.options.getTurn(turnId))?.turn;
    check(turn?.id === turnId && turn.request.astra && turn.conversationId === this.options.conversationId && turn.source === 'desktop'
      && turn.request.astra.actor.id === this.options.actor.id && turn.request.astra.actor.source === 'desktop', 'turn-owner');
    return turn;
  }
  private commit(before: AstraDesktopState, next: AstraDesktopState): AstraDesktopState {
    const current = this.read();
    if (JSON.stringify(current) === JSON.stringify(next)) return current;
    check(JSON.stringify(current) === JSON.stringify(before), 'stale-transition');
    const snapshot = this.options.journal.read(this.stream)!;
    this.options.journal.appendAtomic({ primary: { streamId: this.stream, requestId: 'transition_' + (snapshot.revision + 1), expectedRevision: snapshot.revision,
      reservationId: this.reservation.id, checkpoint: json({ binding: this.binding, ...next }), events: [{ type: 'desktop.' + next.state }] } });
    return this.read();
  }
}
