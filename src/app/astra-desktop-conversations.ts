import { createHash } from 'node:crypto';
import { astraJournalJson, type AstraJournal, type AstraJson } from '../agent-v3/journal';
import type { AstraAuthenticatedHttpActor } from './astra-task-facade';
import type { OscarTurnCheckpoint } from '../oscar-turn/types';
import { AstraDesktopStateStore, astraDesktopStateReservation } from './astra-desktop-state';

interface Entry { conversationId: string; creationRequestId: string | null }
export interface AstraDesktopConversationDirectory { revision: number; activeConversationId: string; conversations: Entry[] }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function check(value: unknown, code: string): asserts value { if (!value) throw Error('astra-conversations:' + code); }

/** Registered sources and active UI identity in the EXISTING journal. Stores no
 * message content/title/token; existing Python conversation storage owns history.
 * Switching sources never runs/cancels tasks, copies targets or grants permission.
 * Finite cohort, with all future pointer capacity reserved before registration. */
export class AstraDesktopConversations {
  private readonly stream: string;
  private readonly binding: string;
  private readonly actor: AstraAuthenticatedHttpActor;
  private readonly maximum: number;
  private readonly transitions: number;
  private readonly pointers = new Map<string, AstraDesktopStateStore>();
  constructor(private readonly options: { deployment: 'isolated-validation'; scopeId: string; canonicalRoot: string;
    journal: AstraJournal; actor: AstraAuthenticatedHttpActor; initialConversationId: string;
    getTurn(id: string): Promise<OscarTurnCheckpoint | null>; maxConversations?: number; maxTransitions?: number }) {
    this.maximum = options.maxConversations ?? 8; this.transitions = options.maxTransitions ?? 256;
    this.actor = structuredClone(options.actor);
    check(options.deployment === 'isolated-validation' && id(options.scopeId) && id(options.initialConversationId)
      && options.initialConversationId.length <= 64 && typeof options.canonicalRoot === 'string' && options.canonicalRoot.length > 0
      && this.actor.source === 'desktop' && /^sha256:[a-f0-9]{64}$/.test(this.actor.id)
      && Number.isSafeInteger(this.maximum) && this.maximum >= 2 && this.maximum <= 16
      && Number.isSafeInteger(this.transitions) && this.transitions >= 4 && this.transitions <= 1024, 'configuration');
    this.stream = 'conversations_' + hash(options.scopeId).slice(0, 32);
    this.binding = hash(astraJournalJson(json({ version: 1, actor: this.actor, initial: options.initialConversationId,
      root: options.canonicalRoot, maximum: this.maximum, transitions: this.transitions, allocation: 'shared-cohort-v1' })));
    if (!options.journal.read(this.stream)) {
      options.journal.appendAtomic({ primary: { streamId: this.stream, requestId: 'initialize', expectedRevision: 0,
        reservationId: this.stream + '_budget', events: [{ type: 'conversations.initialized' }],
        checkpoint: json({ binding: this.binding, activeConversationId: options.initialConversationId,
          conversations: [{ conversationId: options.initialConversationId, creationRequestId: null }] }) },
        reserve: [{ id: this.stream + '_budget', allocations: [{ streamId: this.stream, commits: this.transitions + 1,
          checkpointBytes: 8192, eventBytes: 256 * (this.transitions + 1) }] },
        astraDesktopStateReservation(this.pointerScope(0)), this.pointerReservation()] });
    }
    this.read();
  }
  private conversationId(slot: number) {
    return slot === 0 ? this.options.initialConversationId : 'astra_chat_' + hash(this.binding + ':' + slot).slice(0, 32);
  }
  private pointerScope(slot: number) {
    return slot === 0 ? this.options.scopeId : 'conversation_' + hash(this.options.scopeId + ':' + this.conversationId(slot)).slice(0, 32);
  }
  /** Capacity cohort only, NOT admitted sources. Consumers must still use read()
   * or pointer() to authorize a registered conversation. */
  reservedSourceIds(): string[] { return Array.from({ length: this.maximum }, (_, slot) => this.conversationId(slot)); }
  private pointerReservation() {
    return { id: this.stream + '_pointers', allocations: Array.from({ length: this.maximum - 1 }, (_, slot) =>
      astraDesktopStateReservation(this.pointerScope(slot + 1)).allocations[0]!) };
  }
  read(): AstraDesktopConversationDirectory {
    const snapshot = this.options.journal.read(this.stream)!;
    const data = snapshot.checkpoint as unknown as { binding: string; activeConversationId: string; conversations: Entry[] };
    check(data?.binding === this.binding && Object.keys(data).every(key => ['binding', 'activeConversationId', 'conversations'].includes(key))
      && Array.isArray(data.conversations) && data.conversations.length >= 1 && data.conversations.length <= this.maximum
      && data.conversations.every((entry, slot) => entry && Object.keys(entry).every(key => ['conversationId', 'creationRequestId'].includes(key))
        && entry.conversationId === this.conversationId(slot) && (slot === 0 ? entry.creationRequestId === null : id(entry.creationRequestId)))
      && new Set(data.conversations.map(entry => entry.creationRequestId)).size === data.conversations.length
      && data.conversations.some(entry => entry.conversationId === data.activeConversationId), 'state-or-binding');
    return { revision: snapshot.revision, activeConversationId: data.activeConversationId, conversations: structuredClone(data.conversations) };
  }
  pointer(conversationId = this.read().activeConversationId): AstraDesktopStateStore {
    const directory = this.read(), slot = directory.conversations.findIndex(entry => entry.conversationId === conversationId);
    check(slot >= 0, 'unregistered-source');
    let pointer = this.pointers.get(conversationId);
    if (!pointer) {
      pointer = new AstraDesktopStateStore({ deployment: 'isolated-validation', scopeId: this.pointerScope(slot), journal: this.options.journal,
        actor: this.actor, conversationId, getTurn: this.options.getTurn,
        ...(slot === 0 ? {} : { reservationPlan: this.pointerReservation() }) }); this.pointers.set(conversationId, pointer);
    }
    return pointer;
  }
  create(requestId: string, expectedRevision: number): AstraDesktopConversationDirectory {
    check(id(requestId), 'request'); const before = this.read();
    check(before.revision === expectedRevision, 'stale-source');
    // Replaying create does NOT steal focus back from a later selection.
    if (before.conversations.some(entry => entry.creationRequestId === requestId)) return before;
    check(before.conversations.length < this.maximum, 'conversation-budget');
    const conversationId = this.conversationId(before.conversations.length);
    return this.commit(before, conversationId, [...before.conversations, { conversationId, creationRequestId: requestId }]);
  }
  select(conversationId: string, expectedRevision: number): AstraDesktopConversationDirectory {
    const before = this.read(); check(before.revision === expectedRevision, 'stale-source');
    check(before.conversations.some(entry => entry.conversationId === conversationId), 'unregistered-source');
    if (before.activeConversationId === conversationId) return before;
    return this.commit(before, conversationId, before.conversations);
  }
  private commit(before: AstraDesktopConversationDirectory, activeConversationId: string, conversations: Entry[]) {
    this.options.journal.appendAtomic({ primary: { streamId: this.stream, requestId: 'transition_' + (before.revision + 1),
      expectedRevision: before.revision, reservationId: this.stream + '_budget', events: [{ type: 'conversations.selected' }],
      checkpoint: json({ binding: this.binding, activeConversationId, conversations }) } });
    return this.read();
  }
}
