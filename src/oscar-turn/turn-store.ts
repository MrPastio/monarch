import { createHash, randomUUID } from 'node:crypto';
import { DurableJsonFile } from '../core/durable-json-file';
import {
  OSCAR_TURN_EVENT_SCHEMA_VERSION,
  OSCAR_TURN_SCHEMA_VERSION,
  type OscarTurnCheckpoint,
  type OscarTurnCreateOptions,
  type OscarTurnCancellationReservation,
  type OscarTurnEventDraft,
  type OscarTurnEventV1,
  type OscarTurnOutboxDraft,
  type OscarTurnOutboxItem,
  type OscarTurnSaveOptions,
  type OscarTurnStore,
  type OscarTurnStoreCommit,
  type OscarTurnStoreListener,
  type OscarTerminalMessageRepair,
  type OscarTurnV1,
} from './types';

export const OSCAR_TURN_STORE_SCHEMA_VERSION = 'monarch.oscar-turn-store.v1' as const;

interface OscarTurnStoreDocument {
  schemaVersion: typeof OSCAR_TURN_STORE_SCHEMA_VERSION;
  turns: Record<string, OscarTurnCheckpoint>;
  clientRequests: Record<string, {
    fingerprint: string;
    turnId: string;
    createdAt: string;
  }>;
  clientCancellations?: Record<string, {
    source: OscarTurnCancellationReservation['source'];
    privacyMode: OscarTurnCancellationReservation['privacyMode'];
    expiresAt: string;
  }>;
  outbox: Record<string, OscarTurnOutboxItem>;
  updatedAt: string;
}

export class OscarTurnStoreError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OscarTurnStoreError';
    this.code = code;
    this.statusCode = turnStoreStatus(code);
  }
}

abstract class BaseOscarTurnStore implements OscarTurnStore {
  private readonly listeners = new Map<string, Set<OscarTurnStoreListener>>();

  protected abstract readDocument(): Promise<OscarTurnStoreDocument>;
  protected abstract mutateDocument<R>(
    mutator: (document: OscarTurnStoreDocument) => { changed: boolean; value: R },
  ): Promise<R>;

  async createTurn(turnInput: OscarTurnV1, options: OscarTurnCreateOptions = {}): Promise<OscarTurnStoreCommit> {
    const turn = clone(turnInput);
    assertTurn(turn);
    if (turn.revision !== 0) throw new OscarTurnStoreError('invalid-turn', 'A new Oscar Turn must start at revision 0.');
    const fingerprint = turnFingerprint(turn);
    const now = turn.createdAt;
    const result = await this.mutateDocument((document) => {
      const request = document.clientRequests[turn.clientRequestId];
      if (request) {
        const existing = document.turns[request.turnId];
        if (!existing) throw new OscarTurnStoreError('store-corrupt', 'Oscar Turn idempotency receipt has no Turn.');
        if (request.fingerprint !== fingerprint && turnFingerprint(existing.turn) !== fingerprint) {
          throw new OscarTurnStoreError(
            'client-request-reused',
            'clientRequestId is already bound to a different Oscar Turn request.',
          );
        }
        return { changed: false, value: commit(existing, [], true) };
      }
      if (document.turns[turn.id]) throw new OscarTurnStoreError('turn-exists', 'Oscar Turn id already exists.');
      const appendedEvents = appendEvents(turn.id, [], options.events || [], now);
      const checkpoint = { turn, events: appendedEvents };
      document.turns[turn.id] = checkpoint;
      document.clientRequests[turn.clientRequestId] = {
        fingerprint,
        turnId: turn.id,
        createdAt: now,
      };
      addOutbox(document, options.outbox || [], now);
      document.updatedAt = now;
      return { changed: true, value: commit(checkpoint, appendedEvents, false) };
    });
    if (!result.replayed) this.publish(result);
    return result;
  }

  async getTurn(turnId: string): Promise<OscarTurnCheckpoint | null> {
    const id = identifier(turnId, 'turn');
    const checkpoint = (await this.readDocument()).turns[id];
    return checkpoint ? clone(checkpoint) : null;
  }

  async getTurnByClientRequestId(clientRequestId: string): Promise<OscarTurnCheckpoint | null> {
    const id = identifier(clientRequestId, 'client request');
    const document = await this.readDocument();
    const receipt = document.clientRequests[id];
    if (!receipt) return null;
    const checkpoint = document.turns[receipt.turnId];
    if (!checkpoint) throw new OscarTurnStoreError('store-corrupt', 'Oscar Turn idempotency receipt has no Turn.');
    return clone(checkpoint);
  }

  async reserveClientCancellation(reservation: OscarTurnCancellationReservation): Promise<void> {
    const clientRequestId = identifier(reservation.clientRequestId, 'client request');
    const expiresAt = validIso(reservation.expiresAt, 'client cancellation expiry');
    await this.mutateDocument((document) => {
      const now = Date.now();
      document.clientCancellations ||= {};
      for (const [key, current] of Object.entries(document.clientCancellations)) {
        if (Date.parse(current.expiresAt) <= now) delete document.clientCancellations[key];
      }
      const current = document.clientCancellations[clientRequestId];
      if (current
        && (current.source !== reservation.source || current.privacyMode !== reservation.privacyMode)) {
        throw new OscarTurnStoreError(
          'client-request-reused',
          'clientRequestId cancellation is already bound to another Oscar Turn scope.',
        );
      }
      document.clientCancellations[clientRequestId] = {
        source: reservation.source,
        privacyMode: reservation.privacyMode,
        expiresAt,
      };
      document.updatedAt = new Date().toISOString();
      return { changed: true, value: undefined };
    });
  }

  async hasClientCancellation(
    reservation: Omit<OscarTurnCancellationReservation, 'expiresAt'>,
    now = new Date(),
  ): Promise<boolean> {
    const clientRequestId = identifier(reservation.clientRequestId, 'client request');
    const current = (await this.readDocument()).clientCancellations?.[clientRequestId];
    return Boolean(current
      && current.source === reservation.source
      && current.privacyMode === reservation.privacyMode
      && Date.parse(current.expiresAt) > now.getTime());
  }

  async clearClientCancellation(
    reservation: Omit<OscarTurnCancellationReservation, 'expiresAt'>,
  ): Promise<void> {
    const clientRequestId = identifier(reservation.clientRequestId, 'client request');
    await this.mutateDocument((document) => {
      const current = document.clientCancellations?.[clientRequestId];
      if (!current
        || current.source !== reservation.source
        || current.privacyMode !== reservation.privacyMode) {
        return { changed: false, value: undefined };
      }
      delete document.clientCancellations![clientRequestId];
      document.updatedAt = new Date().toISOString();
      return { changed: true, value: undefined };
    });
  }

  async listTurns(): Promise<OscarTurnV1[]> {
    return Object.values((await this.readDocument()).turns)
      .map((entry) => clone(entry.turn))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async deleteTurn(turnId: string): Promise<boolean> {
    const id = identifier(turnId, 'turn');
    return this.mutateDocument((document) => {
      if (!document.turns[id]) return { changed: false, value: false };
      delete document.turns[id];
      for (const [clientRequestId, receipt] of Object.entries(document.clientRequests)) {
        if (receipt.turnId === id) delete document.clientRequests[clientRequestId];
      }
      for (const [outboxId, item] of Object.entries(document.outbox)) {
        if (item.turnId === id) delete document.outbox[outboxId];
      }
      document.updatedAt = new Date().toISOString();
      return { changed: true, value: true };
    });
  }

  async saveTurn(turnInput: OscarTurnV1, options: OscarTurnSaveOptions): Promise<OscarTurnStoreCommit> {
    const candidate = clone(turnInput);
    assertTurn(candidate);
    const id = identifier(candidate.id, 'turn');
    const result = await this.mutateDocument((document) => {
      const current = document.turns[id];
      if (!current) throw new OscarTurnStoreError('turn-not-found', 'Oscar Turn was not found.');
      if (current.turn.revision !== options.expectedRevision) {
        throw new OscarTurnStoreError('turn-revision-conflict', 'Oscar Turn revision changed before this update.');
      }
      if (
        candidate.clientRequestId !== current.turn.clientRequestId
        || candidate.conversationId !== current.turn.conversationId
        || candidate.source !== current.turn.source
        || candidate.privacyMode !== current.turn.privacyMode
        || candidate.createdAt !== current.turn.createdAt
      ) {
        throw new OscarTurnStoreError('immutable-turn-field', 'Immutable Oscar Turn identity fields cannot change.');
      }
      if (isTerminal(current.turn.status)) {
        if (
          stableJson(candidate) === stableJson(current.turn)
          && (options.events?.length || 0) === 0
          && (options.outbox?.length || 0) === 0
        ) {
          return { changed: false, value: commit(current, [], true) };
        }
        throw new OscarTurnStoreError('turn-terminal', 'Terminal Oscar Turns are immutable.');
      }
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.turn.updatedAt) + 1)).toISOString();
      const next: OscarTurnV1 = {
        ...candidate,
        revision: current.turn.revision + 1,
        updatedAt,
      };
      assertTurn(next);
      const appendedEvents = appendEvents(id, current.events, options.events || [], updatedAt);
      const checkpoint = { turn: next, events: [...current.events, ...appendedEvents] };
      document.turns[id] = checkpoint;
      addOutbox(document, options.outbox || [], updatedAt);
      document.updatedAt = updatedAt;
      return { changed: true, value: commit(checkpoint, appendedEvents, false) };
    });
    this.publish(result);
    return result;
  }

  async ensureTerminalMessage(
    turnId: string,
    repairInput: OscarTerminalMessageRepair,
  ): Promise<OscarTurnStoreCommit> {
    const id = identifier(turnId, 'turn');
    const repair = clone(repairInput);
    const messageId = identifier(repair.messageId, 'terminal message');
    const result = await this.mutateDocument((document) => {
      const current = document.turns[id];
      if (!current) throw new OscarTurnStoreError('turn-not-found', 'Oscar Turn was not found.');
      assertTerminalMessageRepair(current.turn, messageId, repair.outbox);
      const replacedOutbox = recoverableLegacyTerminalOutbox(document, current.turn, messageId);
      if (current.turn.outputMessageId && current.turn.outputMessageId !== messageId && !replacedOutbox) {
        throw new OscarTurnStoreError(
          'terminal-output-conflict',
          'Terminal Oscar Turn is already bound to a different output message.',
        );
      }
      const existingOutbox = document.outbox[repair.outbox.id];
      if (existingOutbox && stableJson(existingOutbox.payload) !== stableJson(repair.outbox.payload)) {
        throw new OscarTurnStoreError('outbox-id-reused', 'Oscar Turn outbox id was reused with a different payload.');
      }
      const staleSuperseded = Object.values(document.outbox).filter((item) => (
        item.supersededBy === repair.outbox.id && item.status !== 'superseded'
      ));
      if (current.turn.outputMessageId === messageId && existingOutbox && staleSuperseded.length === 0) {
        return { changed: false, value: commit(current, [], true) };
      }
      const now = new Date(Math.max(Date.now(), Date.parse(current.turn.updatedAt) + 1)).toISOString();
      for (const stale of staleSuperseded) {
        const { nextAttemptAt: _nextAttemptAt, ...historical } = stale;
        document.outbox[stale.id] = { ...historical, status: 'superseded', updatedAt: now };
      }
      if (replacedOutbox) {
        const { nextAttemptAt: _nextAttemptAt, ...historical } = replacedOutbox;
        document.outbox[replacedOutbox.id] = {
          ...historical,
          status: 'superseded',
          supersededBy: repair.outbox.id,
          updatedAt: now,
        };
      }
      const checkpoint = current.turn.outputMessageId === messageId
        ? current
        : {
            turn: {
              ...current.turn,
              outputMessageId: messageId,
              revision: current.turn.revision + 1,
              updatedAt: now,
            },
            events: current.events,
          };
      assertTurn(checkpoint.turn);
      document.turns[id] = checkpoint;
      addOutbox(document, [repair.outbox], now);
      document.updatedAt = now;
      return { changed: true, value: commit(checkpoint, [], false) };
    });
    if (!result.replayed) this.publish(result);
    return result;
  }

  async listPendingOutbox(now = new Date()): Promise<OscarTurnOutboxItem[]> {
    const timestamp = now.getTime();
    return Object.values((await this.readDocument()).outbox)
      .filter((entry) => !entry.supersededBy)
      .filter((entry) => entry.status === 'pending' || entry.status === 'retrying')
      .filter((entry) => !entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= timestamp)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async markOutboxSucceeded(outboxId: string): Promise<void> {
    const id = identifier(outboxId, 'outbox');
    await this.mutateDocument((document) => {
      const item = document.outbox[id];
      if (!item || item.supersededBy || item.status === 'succeeded' || item.status === 'superseded') {
        return { changed: false, value: undefined };
      }
      const now = new Date().toISOString();
      const {
        nextAttemptAt: _nextAttemptAt,
        lastError: _lastError,
        ...settled
      } = item;
      document.outbox[id] = { ...settled, status: 'succeeded', updatedAt: now };
      document.updatedAt = now;
      return { changed: true, value: undefined };
    });
  }

  async markOutboxSuperseded(outboxId: string): Promise<void> {
    const id = identifier(outboxId, 'outbox');
    await this.mutateDocument((document) => {
      const item = document.outbox[id];
      if (!item || item.supersededBy || item.status === 'succeeded' || item.status === 'superseded') {
        return { changed: false, value: undefined };
      }
      if (item.kind !== 'persist-message') {
        throw new OscarTurnStoreError(
          'invalid-outbox-transition',
          'Only a stale persistent message may be marked superseded without a replacement.',
        );
      }
      const now = new Date().toISOString();
      const {
        nextAttemptAt: _nextAttemptAt,
        lastError: _lastError,
        ...settled
      } = item;
      document.outbox[id] = { ...settled, status: 'superseded', updatedAt: now };
      document.updatedAt = now;
      return { changed: true, value: undefined };
    });
  }

  async markOutboxFailed(outboxId: string, error: string, nextAttemptAt: string): Promise<void> {
    const id = identifier(outboxId, 'outbox');
    const next = validIso(nextAttemptAt, 'outbox retry');
    await this.mutateDocument((document) => {
      const item = document.outbox[id];
      if (!item || item.supersededBy || item.status === 'succeeded' || item.status === 'superseded') {
        return { changed: false, value: undefined };
      }
      const now = new Date().toISOString();
      document.outbox[id] = {
        ...item,
        status: 'retrying',
        attempts: item.attempts + 1,
        lastError: String(error || 'outbox operation failed').slice(0, 2_000),
        nextAttemptAt: next,
        updatedAt: now,
      };
      document.updatedAt = now;
      return { changed: true, value: undefined };
    });
  }

  subscribe(turnId: string | '*', listener: OscarTurnStoreListener): () => void {
    const key = turnId === '*' ? '*' : identifier(turnId, 'turn');
    const listeners = this.listeners.get(key) || new Set<OscarTurnStoreListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  private publish(value: OscarTurnStoreCommit): void {
    for (const key of [value.turn.id, '*']) {
      for (const listener of this.listeners.get(key) || []) listener(clone(value));
    }
  }
}

export class InMemoryOscarTurnStore extends BaseOscarTurnStore {
  private document = emptyDocument();
  private queue: Promise<void> = Promise.resolve();

  protected readDocument(): Promise<OscarTurnStoreDocument> {
    return this.enqueue(() => clone(this.document));
  }

  protected mutateDocument<R>(
    mutator: (document: OscarTurnStoreDocument) => { changed: boolean; value: R },
  ): Promise<R> {
    return this.enqueue(() => {
      const next = clone(this.document);
      const result = mutator(next);
      if (result.changed) {
        assertDocument(next);
        this.document = next;
      }
      return clone(result.value);
    });
  }

  private enqueue<R>(operation: () => R | Promise<R>): Promise<R> {
    const running = this.queue.then(operation, operation);
    this.queue = running.then(() => undefined, () => undefined);
    return running;
  }
}

export class LocalJsonOscarTurnStore extends BaseOscarTurnStore {
  private readonly file: DurableJsonFile<OscarTurnStoreDocument>;

  constructor(filePath: string) {
    super();
    this.file = new DurableJsonFile(filePath, {
      createEmpty: emptyDocument,
      validate: assertDocument,
    });
  }

  protected readDocument(): Promise<OscarTurnStoreDocument> {
    return this.file.read();
  }

  protected mutateDocument<R>(
    mutator: (document: OscarTurnStoreDocument) => { changed: boolean; value: R },
  ): Promise<R> {
    return this.file.mutate(mutator);
  }
}

function emptyDocument(): OscarTurnStoreDocument {
  return {
    schemaVersion: OSCAR_TURN_STORE_SCHEMA_VERSION,
    turns: {},
    clientRequests: {},
    clientCancellations: {},
    outbox: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function appendEvents(
  turnId: string,
  current: OscarTurnEventV1[],
  drafts: OscarTurnEventDraft[],
  fallbackTime: string,
): OscarTurnEventV1[] {
  return drafts.map((draft, index) => ({
    schemaVersion: OSCAR_TURN_EVENT_SCHEMA_VERSION,
    id: `turn_event_${randomUUID().replace(/-/g, '')}`,
    turnId,
    sequence: current.length + index + 1,
    type: draft.type,
    createdAt: draft.createdAt ? validIso(draft.createdAt, 'event') : fallbackTime,
    payload: clone(draft.payload || {}),
  }));
}

function addOutbox(document: OscarTurnStoreDocument, drafts: OscarTurnOutboxDraft[], now: string): void {
  for (const draft of drafts) {
    const id = identifier(draft.id, 'outbox');
    if (document.outbox[id]) {
      if (stableJson(document.outbox[id].payload) !== stableJson(draft.payload)) {
        throw new OscarTurnStoreError('outbox-id-reused', 'Oscar Turn outbox id was reused with a different payload.');
      }
      continue;
    }
    if (!document.turns[draft.turnId]) throw new OscarTurnStoreError('outbox-turn-missing', 'Outbox Turn does not exist.');
    document.outbox[id] = {
      ...clone(draft),
      id,
      turnId: identifier(draft.turnId, 'turn'),
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
}

function commit(
  checkpoint: OscarTurnCheckpoint,
  appendedEvents: OscarTurnEventV1[],
  replayed: boolean,
): OscarTurnStoreCommit {
  return clone({ ...checkpoint, appendedEvents, replayed });
}

function turnFingerprint(turn: OscarTurnV1): string {
  return createHash('sha256').update(stableJson({
    conversationId: turn.conversationId,
    source: turn.source,
    privacyMode: turn.privacyMode,
    request: {
      text: turn.request.text,
      attachmentIds: turn.request.attachmentIds,
      modifiers: turn.request.modifiers,
      history: turn.request.history || [],
    },
    supersedesTurnId: turn.supersedesTurnId || null,
    retryOf: turn.retryOf || null,
  }), 'utf8').digest('hex');
}

function assertDocument(value: unknown): asserts value is OscarTurnStoreDocument {
  if (!record(value) || value.schemaVersion !== OSCAR_TURN_STORE_SCHEMA_VERSION) {
    throw new OscarTurnStoreError('invalid-document', 'Invalid Oscar Turn store schema.');
  }
  if (!record(value.turns) || !record(value.clientRequests) || !record(value.outbox)) {
    throw new OscarTurnStoreError('invalid-document', 'Oscar Turn store maps are invalid.');
  }
  if (value.clientCancellations !== undefined && !record(value.clientCancellations)) {
    throw new OscarTurnStoreError('invalid-document', 'Oscar Turn cancellation map is invalid.');
  }
  validIso(String(value.updatedAt || ''), 'store update');
  for (const [id, checkpoint] of Object.entries(value.turns)) {
    if (!record(checkpoint)) throw new OscarTurnStoreError('invalid-document', 'Oscar Turn checkpoint is invalid.');
    assertTurn(checkpoint.turn);
    if ((checkpoint.turn as OscarTurnV1).id !== id || !Array.isArray(checkpoint.events)) {
      throw new OscarTurnStoreError('invalid-document', 'Oscar Turn checkpoint identity is invalid.');
    }
    checkpoint.events.forEach((event, index) => assertEvent(event, id, index + 1));
  }
  const document = value as unknown as OscarTurnStoreDocument;
  for (const [clientRequestId, receipt] of Object.entries(document.clientRequests)) {
    identifier(clientRequestId, 'client request');
    const referencedTurn = typeof receipt?.turnId === 'string'
      ? document.turns[receipt.turnId]
      : undefined;
    if (!/^[a-f0-9]{64}$/u.test(String(receipt?.fingerprint || ''))
      || !referencedTurn
      || referencedTurn.turn.clientRequestId !== clientRequestId) {
      throw new OscarTurnStoreError('invalid-document', 'Oscar Turn idempotency receipt is invalid.');
    }
    identifier(receipt.turnId, 'turn');
    validIso(String(receipt.createdAt || ''), 'client request receipt');
  }
  for (const [turnId, checkpoint] of Object.entries(document.turns)) {
    if (document.clientRequests[checkpoint.turn.clientRequestId]?.turnId !== turnId) {
      throw new OscarTurnStoreError('invalid-document', 'Oscar Turn has no matching idempotency receipt.');
    }
  }
  for (const [id, item] of Object.entries(document.outbox)) {
    assertOutboxItem(document, id, item);
  }
  assertOutboxSupersessionAcyclic(document.outbox);
  for (const [clientRequestId, reservation] of Object.entries(document.clientCancellations || {})) {
    identifier(clientRequestId, 'client request');
    if (!record(reservation)
      || !['desktop', 'voice', 'telegram', 'api', 'coder', 'system'].includes(String(reservation.source))
      || !['persistent', 'incognito', 'encrypted'].includes(String(reservation.privacyMode))) {
      throw new OscarTurnStoreError('invalid-document', 'Oscar Turn cancellation reservation is invalid.');
    }
    validIso(String(reservation.expiresAt || ''), 'client cancellation expiry');
  }
}

function assertOutboxItem(document: OscarTurnStoreDocument, id: string, value: unknown): asserts value is OscarTurnOutboxItem {
  identifier(id, 'outbox');
  if (!record(value)
    || value.id !== id
    || typeof value.turnId !== 'string'
    || !document.turns[value.turnId]
    || !['persist-message', 'create-agent-task', 'send-agent-message', 'reconcile-turn'].includes(String(value.kind))
    || !['pending', 'retrying', 'succeeded', 'superseded'].includes(String(value.status))
    || !Number.isSafeInteger(value.attempts)
    || Number(value.attempts) < 0
    || !record(value.payload)) {
    throw new OscarTurnStoreError('invalid-document', 'Oscar Turn outbox entry is invalid.');
  }
  identifier(value.turnId, 'turn');
  validIso(String(value.createdAt || ''), 'outbox creation');
  validIso(String(value.updatedAt || ''), 'outbox update');
  if (value.nextAttemptAt !== undefined) validIso(String(value.nextAttemptAt), 'outbox retry');
  if (value.lastError !== undefined
    && (typeof value.lastError !== 'string' || value.lastError.length > 2_000)) {
    throw new OscarTurnStoreError('invalid-document', 'Oscar Turn outbox error is invalid.');
  }
  if (value.supersededBy !== undefined) {
    const replacementId = identifier(String(value.supersededBy), 'outbox replacement');
    const replacement = document.outbox[replacementId];
    if (replacementId === id || !replacement || replacement.turnId !== value.turnId) {
      throw new OscarTurnStoreError('invalid-document', 'Oscar Turn outbox replacement is invalid.');
    }
  }
}

function assertOutboxSupersessionAcyclic(outbox: Record<string, OscarTurnOutboxItem>): void {
  const validated = new Set<string>();
  for (const item of Object.values(outbox)) {
    const visiting = new Set<string>();
    const chain: string[] = [];
    let current: OscarTurnOutboxItem | undefined = item;
    while (current && !validated.has(current.id)) {
      if (visiting.has(current.id)) {
        throw new OscarTurnStoreError('invalid-document', 'Oscar Turn outbox supersession cycle is invalid.');
      }
      visiting.add(current.id);
      chain.push(current.id);
      current = current.supersededBy ? outbox[current.supersededBy] : undefined;
    }
    for (const id of chain) validated.add(id);
  }
}

function assertTurn(value: unknown): asserts value is OscarTurnV1 {
  if (!record(value) || value.schemaVersion !== OSCAR_TURN_SCHEMA_VERSION) {
    throw new OscarTurnStoreError('invalid-turn', 'Invalid Oscar Turn schema.');
  }
  for (const field of ['id', 'clientRequestId', 'conversationId', 'inputMessageId'] as const) {
    identifier(String(value[field] || ''), field);
  }
  if (!['desktop', 'voice', 'telegram', 'api', 'coder', 'system'].includes(String(value.source))) {
    throw new OscarTurnStoreError('invalid-turn', 'Invalid Oscar Turn source.');
  }
  if (!['persistent', 'incognito', 'encrypted'].includes(String(value.privacyMode))) {
    throw new OscarTurnStoreError('invalid-turn', 'Invalid Oscar Turn privacy mode.');
  }
  if (!['answer', 'agent'].includes(String(value.mode))) throw new OscarTurnStoreError('invalid-turn', 'Invalid Oscar Turn mode.');
  if (![
    'accepted', 'routing', 'answering', 'running', 'waiting-for-user', 'waiting-for-approval',
    'succeeded', 'blocked', 'failed', 'cancelled',
  ].includes(String(value.status))) throw new OscarTurnStoreError('invalid-turn', 'Invalid Oscar Turn status.');
  if (!record(value.request) || typeof value.request.text !== 'string' || !value.request.text.trim()) {
    throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn request text is required.');
  }
  if (!Array.isArray(value.request.attachmentIds) || !record(value.request.modifiers)) {
    throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn request snapshot is invalid.');
  }
  if (value.request.executionProfile !== undefined) {
    const executionProfile = value.request.executionProfile;
    if (!record(executionProfile)
      || value.source !== 'coder'
      || executionProfile.schemaVersion !== 'monarch.agent-execution-profile.v1'
      || executionProfile.kind !== 'coder-project'
      || typeof executionProfile.projectId !== 'string'
      || !executionProfile.projectId.trim()
      || typeof executionProfile.projectRoot !== 'string'
      || !/^[A-Za-z]:[\\/]/u.test(executionProfile.projectRoot)
      || !record(executionProfile.permissionProfile)
      || !['read-only', 'workspace-write', 'danger-full-access'].includes(String(executionProfile.permissionProfile.sandboxMode))
      || !['on-request', 'never'].includes(String(executionProfile.permissionProfile.approvalPolicy))) {
      throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn execution profile is invalid.');
    }
    if (executionProfile.permissionProfile.autonomyMode !== undefined
      && !['guided', 'workspace-autonomous', 'full-local'].includes(String(executionProfile.permissionProfile.autonomyMode))) {
      throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn execution profile autonomy mode is invalid.');
    }
  }
  if (value.request.continuations !== undefined) {
    if (!Array.isArray(value.request.continuations) || value.request.continuations.length > 32) {
      throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn continuations are invalid.');
    }
    for (const continuation of value.request.continuations) {
      if (!record(continuation) || typeof continuation.content !== 'string' || !continuation.content.trim()) {
        throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn continuation content is invalid.');
      }
      identifier(String(continuation.messageId || ''), 'continuation message');
      validIso(String(continuation.createdAt || ''), 'continuation');
    }
  }
  if (record(value.outcome) && value.outcome.diagnostic !== undefined) {
    const diagnostic = value.outcome.diagnostic;
    if (
      !record(diagnostic)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(String(diagnostic.code || ''))
      || typeof diagnostic.detail !== 'string'
      || !diagnostic.detail.trim()
      || diagnostic.detail.length > 2_000
      || !/^sha256:[a-f0-9]{64}$/u.test(String(diagnostic.fingerprint || ''))
    ) {
      throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn failure diagnostic is invalid.');
    }
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn revision must be monotonic.');
  }
  validIso(String(value.createdAt || ''), 'turn creation');
  validIso(String(value.updatedAt || ''), 'turn update');
}

function assertEvent(value: unknown, turnId: string, sequence: number): void {
  if (!record(value) || value.schemaVersion !== OSCAR_TURN_EVENT_SCHEMA_VERSION) {
    throw new OscarTurnStoreError('invalid-document', 'Invalid Oscar Turn event schema.');
  }
  if (value.turnId !== turnId || value.sequence !== sequence || !record(value.payload)) {
    throw new OscarTurnStoreError('invalid-document', 'Invalid Oscar Turn event binding.');
  }
  validIso(String(value.createdAt || ''), 'event');
}

function assertTerminalMessageRepair(
  turn: OscarTurnV1,
  messageId: string,
  outbox: OscarTurnOutboxDraft,
): void {
  if (!isTerminal(turn.status) || !turn.outcome) {
    throw new OscarTurnStoreError('turn-not-terminal', 'Only a terminal Oscar Turn with an outcome can recover its message.');
  }
  if (turn.privacyMode !== 'persistent') {
    throw new OscarTurnStoreError('terminal-message-not-persistent', 'Only a persistent Oscar Turn can recover its message.');
  }
  const payload = record(outbox.payload) ? outbox.payload : {};
  const provenance = record(payload.provenance) ? payload.provenance : {};
  if (
    identifier(outbox.id, 'outbox') !== `outbox_message_${messageId}`
    || outbox.turnId !== turn.id
    || outbox.kind !== 'persist-message'
    || payload.messageId !== messageId
    || payload.conversationId !== turn.conversationId
    || payload.turnId !== turn.id
    || payload.role !== 'assistant'
    || payload.content !== turn.outcome.summary
    || payload.outcome !== turn.outcome.kind
    || payload.createConversationIfMissing !== false
    || payload.requiredPreviousMessageId !== turn.inputMessageId
    || provenance.origin !== 'system'
    || provenance.verification !== 'system-state'
    || provenance.turnId !== turn.id
    || payload.source !== turn.source
    || payload.privacyMode !== turn.privacyMode
    || provenance.surface !== turn.source
    || provenance.privacyMode !== turn.privacyMode
  ) {
    throw new OscarTurnStoreError(
      'invalid-terminal-message-repair',
      'Terminal message recovery must match the immutable Turn outcome and existing conversation.',
    );
  }
  if (payload.taskId !== turn.taskId || provenance.taskId !== turn.taskId) {
    throw new OscarTurnStoreError('invalid-terminal-message-repair', 'Terminal message recovery lost its Agent Task binding.');
  }
}

export function hasRecoverableLegacyTerminalOutput(turn: OscarTurnV1): boolean {
  const outputMessageId = String(turn.outputMessageId || '');
  return outputMessageId.length > 64 && outputMessageId === `oscar_message_terminal_${turn.id}`;
}

function recoverableLegacyTerminalOutbox(
  document: OscarTurnStoreDocument,
  turn: OscarTurnV1,
  replacementMessageId: string,
): OscarTurnOutboxItem | null {
  if (!turn.outputMessageId || turn.outputMessageId === replacementMessageId || !hasRecoverableLegacyTerminalOutput(turn)) {
    return null;
  }
  const outbox = document.outbox[`outbox_message_${turn.outputMessageId}`];
  const payload = record(outbox?.payload) ? outbox.payload : {};
  const provenance = record(payload.provenance) ? payload.provenance : {};
  if (
    !outbox
    || (outbox.status !== 'pending' && outbox.status !== 'retrying')
    || outbox.turnId !== turn.id
    || outbox.kind !== 'persist-message'
    || payload.messageId !== turn.outputMessageId
    || payload.conversationId !== turn.conversationId
    || payload.turnId !== turn.id
    || payload.role !== 'assistant'
    || payload.content !== turn.outcome?.summary
    || payload.outcome !== turn.outcome?.kind
    || provenance.origin !== 'system'
    || provenance.verification !== 'system-state'
    || provenance.turnId !== turn.id
  ) return null;
  return outbox;
}

function identifier(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) {
    throw new OscarTurnStoreError('invalid-id', `Invalid Oscar ${label} id.`);
  }
  return normalized;
}

function validIso(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new OscarTurnStoreError('invalid-time', `Invalid Oscar ${label} timestamp.`);
  return new Date(value).toISOString();
}

function isTerminal(status: OscarTurnV1['status']): boolean {
  return status === 'succeeded' || status === 'blocked' || status === 'failed' || status === 'cancelled';
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function turnStoreStatus(code: string): number {
  if (code === 'turn-not-found') return 404;
  if (/reused|exists|conflict|terminal|immutable/u.test(code)) return 409;
  if (/corrupt|document|outbox-turn-missing/u.test(code)) return 500;
  return 400;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
