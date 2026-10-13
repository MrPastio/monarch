import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DurableJsonFile, renameWithWindowsRetry, writeFileAtomically } from '../core/durable-json-file';
import { StoreProtectionError, decodeStoreLine, encodeStoreLine, storeProtection } from '../core/store-protection';

const ARCHIVE_STORE_ID = 'oscar-turns-archive';
import { validateAstraAuthenticatedActor, validateOscarAstraBinding, type OscarAstraBinding } from './astra-contract';
import { isAstraAgentTaskSpecification } from '../agent-v3/agent-task-contract';
import {
  OSCAR_TURN_EVENT_SCHEMA_VERSION,
  OSCAR_TURN_SCHEMA_VERSION,
  type OscarTurnCheckpoint,
  type OscarTurnCreateOptions,
  type OscarTurnAgentBindingOptions,
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
    astraActorId?: string;
    clientRequestId?: string;
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
    const storageKey = cancellationStorageKey({ ...reservation, clientRequestId });
    const expiresAt = validIso(reservation.expiresAt, 'client cancellation expiry');
    await this.mutateDocument((document) => {
      const now = Date.now();
      document.clientCancellations ||= {};
      for (const [key, current] of Object.entries(document.clientCancellations)) {
        if (Date.parse(current.expiresAt) <= now) delete document.clientCancellations[key];
      }
      const current = document.clientCancellations[storageKey];
      if (current
        && (current.source !== reservation.source || current.privacyMode !== reservation.privacyMode
          || current.astraActorId !== reservation.astraActorId)) {
        throw new OscarTurnStoreError(
          'client-request-reused',
          'clientRequestId cancellation is already bound to another Oscar Turn scope.',
        );
      }
      document.clientCancellations[storageKey] = {
        ...(reservation.astraActorId ? { astraActorId: reservation.astraActorId, clientRequestId } : {}),
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
    const current = (await this.readDocument()).clientCancellations?.[cancellationStorageKey({ ...reservation, clientRequestId })];
    return Boolean(current
      && current.source === reservation.source
      && current.privacyMode === reservation.privacyMode
      && current.astraActorId === reservation.astraActorId
      && Date.parse(current.expiresAt) > now.getTime());
  }

  async clearClientCancellation(
    reservation: Omit<OscarTurnCancellationReservation, 'expiresAt'>,
  ): Promise<void> {
    const clientRequestId = identifier(reservation.clientRequestId, 'client request');
    const storageKey = cancellationStorageKey({ ...reservation, clientRequestId });
    await this.mutateDocument((document) => {
      const current = document.clientCancellations?.[storageKey];
      if (!current
        || current.source !== reservation.source
        || current.privacyMode !== reservation.privacyMode || current.astraActorId !== reservation.astraActorId) {
        return { changed: false, value: undefined };
      }
      delete document.clientCancellations![storageKey];
      document.updatedAt = new Date().toISOString();
      return { changed: true, value: undefined };
    });
  }

  async listLiveTurns(): Promise<OscarTurnV1[]> {
    return Object.values((await this.readDocument()).turns)
      .map((entry) => clone(entry.turn))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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

  async bindOrdinaryAgent(
    turnId: string,
    bindingInput: OscarAstraBinding,
    options: OscarTurnAgentBindingOptions,
  ): Promise<OscarTurnStoreCommit> {
    const id = identifier(turnId, 'turn');
    const binding = clone(bindingInput);
    validateOscarAstraBinding(binding);
    if (binding.admission !== 'ordinary-agent-v1' || binding.goal.kind !== 'agent') {
      throw new OscarTurnStoreError('invalid-agent-binding', 'Only an ordinary semantic agent binding can enrich a routed Turn.');
    }
    const result = await this.mutateDocument((document) => {
      const current = document.turns[id];
      if (!current) throw new OscarTurnStoreError('turn-not-found', 'Oscar Turn was not found.');
      if (current.turn.revision !== options.expectedRevision) {
        throw new OscarTurnStoreError('turn-revision-conflict', 'Oscar Turn revision changed before agent binding.');
      }
      if (current.turn.request.astra) {
        if (stableJson(current.turn.request.astra) === stableJson(binding)) {
          return { changed: false, value: commit(current, [], true) };
        }
        throw new OscarTurnStoreError('immutable-turn-field', 'Oscar Turn executor binding cannot be replaced.');
      }
      const localSurface = ['desktop', 'voice', 'system'].includes(current.turn.source)
        && current.turn.request.executionProfile === undefined;
      const coder = current.turn.source === 'coder'
        && current.turn.request.executionProfile?.schemaVersion === 'monarch.agent-execution-profile.v1'
        && current.turn.request.executionProfile.kind === 'coder-project';
      const api = current.turn.source === 'api'
        && current.turn.request.authenticatedAgentActor?.source === 'api'
        && current.turn.request.authenticatedAgentActor.id === binding.actor.id;
      const telegram = current.turn.source === 'telegram' && validTelegramActor(current.turn.request.telegramActor);
      if (current.turn.status !== 'routing'
        || !(localSurface || coder || api || telegram)
        || !['persistent', 'incognito'].includes(current.turn.privacyMode)
        || binding.actor.source !== current.turn.source) {
        throw new OscarTurnStoreError('invalid-agent-binding', 'Oscar Turn is not eligible for ordinary semantic agent binding.');
      }
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.turn.updatedAt) + 1)).toISOString();
      const next: OscarTurnV1 = {
        ...current.turn,
        request: { ...current.turn.request, astra: binding },
        revision: current.turn.revision + 1,
        updatedAt,
      };
      assertTurn(next);
      const checkpoint = { turn: next, events: current.events };
      document.turns[id] = checkpoint;
      document.updatedAt = updatedAt;
      return { changed: true, value: commit(checkpoint, [], false) };
    });
    if (!result.replayed) this.publish(result);
    return result;
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
        || stableJson(candidate.request.astra ?? null) !== stableJson(current.turn.request.astra ?? null)
        || stableJson(candidate.request.authenticatedAgentActor ?? null) !== stableJson(current.turn.request.authenticatedAgentActor ?? null)
        || stableJson(candidate.request.telegramActor ?? null) !== stableJson(current.turn.request.telegramActor ?? null)
        || stableJson(candidate.request.explicitAgentTask ?? null) !== stableJson(current.turn.request.explicitAgentTask ?? null)
        || !(current.turn.astraRecoveryRequests ?? []).every((id, index) => candidate.astraRecoveryRequests?.[index] === id)
        || (current.turn.request.astra && (candidate.inputMessageId !== current.turn.inputMessageId
          || candidate.request.text !== current.turn.request.text))
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
    // Read-only first: on startup this runs for every settled Turn, and taking
    // the write lock and a full copy of the document only to find nothing to
    // repair cost seconds.
    const snapshot = await this.readDocument();
    const known = snapshot.turns[id];
    if (!known) throw new OscarTurnStoreError('turn-not-found', 'Oscar Turn was not found.');
    if (known.turn.outputMessageId === messageId && snapshot.outbox[repair.outbox.id]
      && stableJson(snapshot.outbox[repair.outbox.id]!.payload) === stableJson(repair.outbox.payload)
      && !Object.values(snapshot.outbox).some((item) => item.supersededBy === repair.outbox.id && item.status !== 'superseded')) {
      assertTerminalMessageRepair(known.turn, messageId, repair.outbox);
      return commit(clone(known), [], true);
    }
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

  /** Read one outbox entry in any state, including settled ones that
   * `listPendingOutbox` filters out — an abandoned message stays inspectable. */
  async readOutboxItem(outboxId: string): Promise<OscarTurnOutboxItem | null> {
    const item = (await this.readDocument()).outbox[identifier(outboxId, 'outbox')];
    return item ? clone(item) : null;
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

  /** `abandonedReason` retains the exact last delivery error for a message the
   * host gave up on, so an undeliverable entry stays diagnosable in the store. */
  async markOutboxSuperseded(outboxId: string, abandonedReason?: string): Promise<void> {
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
      const retained = String(abandonedReason || '').trim();
      document.outbox[id] = {
        ...settled,
        ...(retained ? { lastError: retained.slice(0, 2_000) } : {}),
        status: 'superseded',
        updatedAt: now,
      };
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

/** Settled Turns leave the document that every single change rewrites.
 *
 * The store keeps one JSON document and rewrites all of it on every mutation,
 * so the price of recording one event is the size of the entire history, and a
 * Turn performs dozens of them. Measured here at 405 Turns: 5.65 MiB per
 * rewrite, ~130 ms an operation, and submitting a greeting blocked for 3.5 s
 * before the Turn was even accepted. It got worse with every conversation.
 *
 * Nothing is deleted. A settled Turn, its events, its idempotency receipt and
 * its delivered outbox are appended to a durable archive beside the document
 * and are still returned by reads - `listTurns` included, because the
 * attachment reference scan runs through it and would otherwise treat an
 * archived Turn's attachments as unreferenced. Only live work stays in the file
 * that mutations rewrite.
 *
 * Archiving appends before it removes. A crash between the two leaves a Turn in
 * both places, which reads resolve in favour of the document; the other order
 * could lose it. */
const ARCHIVE_HIGH_WATER_TURNS = 120;
const ARCHIVE_ROTATE_BYTES = 32 * 1024 * 1024;
const ARCHIVE_LOW_WATER_TURNS = 60;
const SETTLED_OUTBOX_STATUSES = new Set(['succeeded', 'superseded']);
const TERMINAL_STORE_TURN_STATUSES = new Set(['succeeded', 'blocked', 'failed', 'cancelled']);

interface OscarTurnArchiveRecord {
  turn: OscarTurnV1;
  events: OscarTurnEventV1[];
  clientRequest?: { clientRequestId: string; fingerprint: string; createdAt: string };
  outbox: OscarTurnOutboxItem[];
}

export class LocalJsonOscarTurnStore extends BaseOscarTurnStore {
  private readonly file: DurableJsonFile<OscarTurnStoreDocument>;
  private readonly archivePath: string;
  private archiveCache: { mtimeMs: number; size: number; records: OscarTurnArchiveRecord[] } | undefined;
  private compacting: Promise<void> | undefined;

  constructor(filePath: string, private readonly retention: { highWaterTurns: number; lowWaterTurns: number;
    archiveRotateBytes?: number } = { highWaterTurns: ARCHIVE_HIGH_WATER_TURNS, lowWaterTurns: ARCHIVE_LOW_WATER_TURNS },
  private readonly report: (entry: Record<string, string | number>) => void = reportTurnStoreDiagnostic) {
    super();
    // One damaged turns.v1.json used to stop every Oscar answer until the file
    // was fixed by hand. It is set aside unchanged (nothing in it is run or
    // trusted) and Oscar continues; conversations live in their own store.
    this.file = new DurableJsonFile(filePath, {
      createEmpty: emptyDocument,
      validate: assertDocument,
      sensitive: { storeId: 'oscar-turns' },
      onQuarantine: ({ code, quarantinePath }) => this.report({
        diagnostic: 'oscar-turn-store-quarantined', code, file: path.basename(quarantinePath) }),
    });
    this.archivePath = this.file.filePath + '.archive.jsonl';
    // Owner decision: no plain original stays once sealing is on. The archive is
    // otherwise only read when an old Turn is looked up.
    if (storeProtection().mode === 'sealed') {
      void this.file.read().catch(() => undefined);
      this.scheduleArchiveResealing();
    }
  }

  /** Every reader in the base store copies what it keeps, so the shared
   * (frozen, cached) document is safe here and spares a full parse and clone
   * of turns.v1.json per lookup. */
  protected readDocument(): Promise<OscarTurnStoreDocument> {
    return this.file.readShared() as Promise<OscarTurnStoreDocument>;
  }

  protected async mutateDocument<R>(
    mutator: (document: OscarTurnStoreDocument) => { changed: boolean; value: R },
  ): Promise<R> {
    // The mutation already holds the document, so the count comes from there.
    // Reading the file again just to decide whether to compact would add back
    // exactly the cost this archive exists to remove.
    let liveTurns = 0;
    const value = await this.file.mutate((document) => {
      const result = mutator(document);
      liveTurns = Object.keys(document.turns).length;
      return result;
    });
    if (liveTurns > this.retention.highWaterTurns) await this.compact();
    return value;
  }

  async getTurn(turnId: string): Promise<OscarTurnCheckpoint | null> {
    const live = await super.getTurn(turnId);
    if (live) return live;
    const id = identifier(turnId, 'turn');
    const record = (await this.readArchive()).find((entry) => entry.turn.id === id);
    return record ? clone({ turn: record.turn, events: record.events }) : null;
  }

  async getTurnByClientRequestId(clientRequestId: string): Promise<OscarTurnCheckpoint | null> {
    const live = await super.getTurnByClientRequestId(clientRequestId);
    if (live) return live;
    const id = identifier(clientRequestId, 'client request');
    // An archived receipt still has to answer a replayed request, or the same
    // clientRequestId would be admitted a second time as new work.
    const record = (await this.readArchive()).find((entry) => entry.clientRequest?.clientRequestId === id);
    return record ? clone({ turn: record.turn, events: record.events }) : null;
  }

  async listTurns(): Promise<OscarTurnV1[]> {
    const live = await super.listTurns();
    const liveIds = new Set(live.map((turn) => turn.id));
    const archived = (await this.readArchive())
      .filter((entry) => !liveIds.has(entry.turn.id))
      .map((entry) => clone(entry.turn));
    return [...archived, ...live].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async deleteTurn(turnId: string): Promise<boolean> {
    const removed = await super.deleteTurn(turnId);
    if (removed) return true;
    // The archive is append-only, so reporting success here would claim a
    // removal that did not happen.
    const id = identifier(turnId, 'turn');
    if ((await this.readArchive()).some((entry) => entry.turn.id === id)) {
      throw new OscarTurnStoreError('turn-archived', 'Oscar Turn has been archived and cannot be deleted.');
    }
    return false;
  }

  /** The archive is read whole when an old Turn is looked up, and it only
   * grew. Past ARCHIVE_ROTATE_BYTES it is set aside under a dated name (kept,
   * no longer searched): such Turns are months old and their messages live in
   * the conversation store. */
  private archiveChain: Promise<void> = Promise.resolve();
  private resealScheduled = false;

  private withArchive<R>(operation: () => Promise<R>): Promise<R> {
    const run = this.archiveChain.then(operation, operation);
    this.archiveChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Sealed protection: plain lines left by an earlier version — in the live
   * archive and in rotated ones — are rewritten sealed, once, in the background. */
  private scheduleArchiveResealing(): void {
    if (this.resealScheduled || storeProtection().mode !== 'sealed') return;
    this.resealScheduled = true;
    void this.withArchive(() => this.resealArchives())
      .catch(() => this.report({ diagnostic: 'oscar-turn-archive-reseal-failed' }))
      .finally(() => { this.resealScheduled = false; });
  }

  private async resealArchives(): Promise<void> {
    const directory = path.dirname(this.archivePath);
    const base = path.basename(this.archivePath).replace(/\.jsonl$/u, '');
    const names = (await readdir(directory).catch(() => [] as string[]))
      .filter(name => name === path.basename(this.archivePath) || (name.startsWith(base + '.') && name.endsWith('.jsonl')));
    for (const name of names) {
      const file = path.join(directory, name);
      const raw = await readFile(file, 'utf8');
      let changed = false;
      const lines = raw.split('\n').map(line => {
        if (!line.trim()) return line;
        const decoded = decodeStoreLine(line.trim(), ARCHIVE_STORE_ID);
        if (!decoded.legacy) return line;
        changed = true;
        return encodeStoreLine(decoded.text, ARCHIVE_STORE_ID);
      });
      if (changed) await writeFileAtomically(file, lines.join('\n'));
    }
    this.archiveCache = undefined;
  }

  private async rotateArchiveIfLarge(): Promise<void> {
    const info = await stat(this.archivePath).catch(() => null);
    if (!info || info.size <= (this.retention.archiveRotateBytes ?? ARCHIVE_ROTATE_BYTES)) return;
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    await renameWithWindowsRetry(this.archivePath, this.archivePath.replace(/\.jsonl$/u, `.${stamp}.jsonl`));
    this.archiveCache = undefined;
  }

  private async readArchive(): Promise<OscarTurnArchiveRecord[]> {
    let info;
    try { info = await stat(this.archivePath); }
    catch (error) {
      if ((error as { code?: string } | null)?.code === 'ENOENT') return [];
      throw error;
    }
    const cached = this.archiveCache;
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.records;
    const raw = await readFile(this.archivePath, 'utf8');
    const records: OscarTurnArchiveRecord[] = [];
    const lines = raw.split('\n');
    let skipped = 0;
    let legacy = false;
    for (const [index, line] of lines.entries()) {
      const stored = line.trim();
      if (!stored) continue;
      let text: string;
      try {
        const decoded = decodeStoreLine(stored, ARCHIVE_STORE_ID);
        text = decoded.text;
        legacy ||= decoded.legacy;
      } catch (error) {
        // Without the key nothing archived can be read: stop, never skip it all.
        if (error instanceof StoreProtectionError) throw error;
        text = '';
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text) as unknown; } catch { parsed = null; }
      const record = parsed as OscarTurnArchiveRecord | null;
      if (!record || typeof record !== 'object' || !record.turn || !Array.isArray(record.events)) {
        // A last line without its newline is a record still being appended (or
        // torn by a crash), not damage. Any other unreadable record costs only
        // itself: one bad line used to make every lookup of an old Turn fail.
        if (index !== lines.length - 1) skipped += 1;
        continue;
      }
      records.push(record);
    }
    if (skipped) this.report({ diagnostic: 'oscar-turn-archive-records-skipped', count: skipped });
    if (legacy) this.scheduleArchiveResealing();
    this.archiveCache = { mtimeMs: info.mtimeMs, size: info.size, records };
    return records;
  }

  /** One compaction at a time, and never inside the mutation that triggered it:
   * the document lock is not reentrant. */
  private compact(): Promise<void> {
    this.compacting ??= this.compactOnce().finally(() => { this.compacting = undefined; });
    return this.compacting;
  }

  private async compactOnce(): Promise<void> {
    const document = await this.file.read();
    const selected = selectArchivableTurns(document, this.retention);
    if (!selected.length) return;
    const records = selected.map((turnId) => archiveRecord(document, turnId));
    await this.withArchive(async () => {
      await this.rotateArchiveIfLarge();
      await appendArchiveRecords(this.archivePath, records);
    });
    this.archiveCache = undefined;
    await this.file.mutate((current) => {
      let changed = false;
      for (const record of records) {
        if (!current.turns[record.turn.id]) continue;
        delete current.turns[record.turn.id];
        if (record.clientRequest) delete current.clientRequests[record.clientRequest.clientRequestId];
        for (const item of record.outbox) delete current.outbox[item.id];
        changed = true;
      }
      if (changed) current.updatedAt = new Date().toISOString();
      return { changed, value: undefined };
    });
  }
}

function selectArchivableTurns(document: OscarTurnStoreDocument,
  retention: { highWaterTurns: number; lowWaterTurns: number }): string[] {
  const entries = Object.values(document.turns);
  if (entries.length <= retention.highWaterTurns) return [];
  const pinned = new Set<string>();
  for (const item of Object.values(document.outbox)) {
    // Undelivered work is live work, whatever its Turn's status says.
    if (!SETTLED_OUTBOX_STATUSES.has(item.status)) pinned.add(item.turnId);
  }
  return entries
    .slice()
    .sort((left, right) => right.turn.createdAt.localeCompare(left.turn.createdAt))
    .slice(retention.lowWaterTurns)
    .filter((entry) => TERMINAL_STORE_TURN_STATUSES.has(entry.turn.status) && !pinned.has(entry.turn.id))
    .map((entry) => entry.turn.id);
}

function archiveRecord(document: OscarTurnStoreDocument, turnId: string): OscarTurnArchiveRecord {
  const checkpoint = document.turns[turnId];
  if (!checkpoint) throw new OscarTurnStoreError('store-corrupt', 'Oscar Turn selected for archive is missing.');
  const receipt = Object.entries(document.clientRequests).find(([, value]) => value.turnId === turnId);
  return clone({
    turn: checkpoint.turn,
    events: checkpoint.events,
    ...(receipt ? { clientRequest: { clientRequestId: receipt[0], fingerprint: receipt[1].fingerprint,
      createdAt: receipt[1].createdAt } } : {}),
    outbox: Object.values(document.outbox).filter((item) => item.turnId === turnId),
  });
}

async function appendArchiveRecords(archivePath: string, records: OscarTurnArchiveRecord[]): Promise<void> {
  const payload = records.map((record) => encodeStoreLine(JSON.stringify(record), ARCHIVE_STORE_ID)).join('\n') + '\n';
  const handle = await open(archivePath, 'a+');
  try {
    // A tail torn by a crash must not swallow the first new record.
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    const tornTail = size > 0 && (await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] !== 0x0a;
    await handle.writeFile((tornTail ? '\n' : '') + payload, 'utf8');
    // The document may only forget a Turn once the archive durably holds it.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function reportTurnStoreDiagnostic(entry: Record<string, string | number>): void {
  console.error(JSON.stringify(entry));
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
      authenticatedAgentActor: turn.request.authenticatedAgentActor || null,
      telegramActor: turn.request.telegramActor || null,
      executionProfile: turn.request.executionProfile || null,
      explicitAgentTask: turn.request.explicitAgentTask || null,
      ...(turn.request.astra ? { astra: turn.request.astra, inputMessageId: turn.inputMessageId } : {}),
    },
    supersedesTurnId: turn.supersedesTurnId || null,
    retryOf: turn.retryOf || null,
  }), 'utf8').digest('hex');
}

function cancellationStorageKey(reservation: { clientRequestId: string; astraActorId?: string }): string {
  if (reservation.astraActorId === undefined) return reservation.clientRequestId;
  if (!/^sha256:[a-f0-9]{64}$/u.test(reservation.astraActorId)) throw new OscarTurnStoreError('invalid-turn', 'Invalid Astra cancellation actor.');
  return 'astra_cancel_' + createHash('sha256').update(reservation.astraActorId + '/' + reservation.clientRequestId).digest('hex');
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
      || !['persistent', 'incognito', 'encrypted'].includes(String(reservation.privacyMode))
      || reservation.astraActorId !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(String(reservation.astraActorId))) {
      throw new OscarTurnStoreError('invalid-document', 'Oscar Turn cancellation reservation is invalid.');
    }
    validIso(String(reservation.expiresAt || ''), 'client cancellation expiry');
    if (reservation.astraActorId !== undefined) {
      const sourceRequestId = identifier(String(reservation.clientRequestId || ''), 'Astra cancellation request');
      if (cancellationStorageKey({ clientRequestId: sourceRequestId, astraActorId: String(reservation.astraActorId) }) !== clientRequestId)
        throw new OscarTurnStoreError('invalid-document', 'Astra cancellation namespace mismatch.');
    }
  }
}

function assertOutboxItem(document: OscarTurnStoreDocument, id: string, value: unknown): asserts value is OscarTurnOutboxItem {
  identifier(id, 'outbox');
  if (!record(value)
    || value.id !== id
    || typeof value.turnId !== 'string'
    || !document.turns[value.turnId]
    || !['persist-message', 'create-agent-task', 'send-agent-message', 'reconcile-turn', 'astra-input', 'astra-control', 'astra-wake'].includes(String(value.kind))
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
    'accepted', 'routing', 'answering', 'running', 'waiting-for-user', 'waiting-for-approval', 'waiting-for-runtime',
    'succeeded', 'blocked', 'failed', 'cancelled',
  ].includes(String(value.status))) throw new OscarTurnStoreError('invalid-turn', 'Invalid Oscar Turn status.');
  if (!record(value.request) || typeof value.request.text !== 'string' || !value.request.text.trim()) {
    throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn request text is required.');
  }
  if (!Array.isArray(value.request.attachmentIds) || !record(value.request.modifiers)) {
    throw new OscarTurnStoreError('invalid-turn', 'Oscar Turn request snapshot is invalid.');
  }
  if (value.request.astra !== undefined) {
    validateOscarAstraBinding(value.request.astra as OscarAstraBinding);
    const astra = value.request.astra as OscarAstraBinding;
    if ((value.privacyMode !== 'persistent'
      && !(value.privacyMode === 'incognito' && astra.admission === 'ordinary-agent-v1'))
      || astra.actor.source !== value.source)
      throw new OscarTurnStoreError('invalid-turn', 'Astra source scope mismatch.');
  }
  if (value.request.authenticatedAgentActor !== undefined) {
    try { validateAstraAuthenticatedActor(value.request.authenticatedAgentActor); }
    catch { throw new OscarTurnStoreError('invalid-turn', 'Authenticated Agent actor is invalid.'); }
    if (value.privacyMode !== 'persistent' || value.request.authenticatedAgentActor.source !== value.source
      || value.source === 'telegram' || value.source === 'coder') {
      throw new OscarTurnStoreError('invalid-turn', 'Authenticated Agent actor scope mismatch.');
    }
  }
  if (value.request.telegramActor !== undefined && (value.source !== 'telegram' || !validTelegramActor(value.request.telegramActor))) {
    throw new OscarTurnStoreError('invalid-turn', 'Telegram Agent actor is invalid.');
  }
  if (value.request.explicitAgentTask !== undefined && (!isAstraAgentTaskSpecification(value.request.explicitAgentTask)
    || value.privacyMode !== 'persistent' || !['desktop', 'voice', 'api'].includes(String(value.source))
    || value.request.authenticatedAgentActor?.source !== value.source)) {
    throw new OscarTurnStoreError('invalid-turn', 'Explicit Agent Task binding is invalid.');
  }
  if (value.astraControl !== undefined && (!value.request.astra || !record(value.astraControl)
    || !Number.isSafeInteger(value.astraControl.sequence) || Number(value.astraControl.sequence) < 1
    || !['pause', 'resume', 'cancel'].includes(String(value.astraControl.desired))))
    throw new OscarTurnStoreError('invalid-turn', 'Invalid Astra control.');
  if (value.astraRecoveryRequests !== undefined && (!value.request.astra || !Array.isArray(value.astraRecoveryRequests)
    || value.astraRecoveryRequests.length > 8 || new Set(value.astraRecoveryRequests).size !== value.astraRecoveryRequests.length
    || !value.astraRecoveryRequests.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(id))))
    throw new OscarTurnStoreError('invalid-turn', 'Invalid Astra recovery requests.');
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

function validTelegramActor(value: unknown): value is NonNullable<OscarTurnV1['request']['telegramActor']> {
  if (!record(value)) return false;
  return Number.isSafeInteger(value.ownerUserId) && Number(value.ownerUserId) > 0
    && Number.isSafeInteger(value.controlChatId) && Number(value.controlChatId) !== 0
    && Number.isSafeInteger(value.botId) && Number(value.botId) > 0
    && Number.isSafeInteger(value.threadId) && Number(value.threadId) >= 0
    && typeof value.pairingEpoch === 'string' && value.pairingEpoch.length >= 1 && value.pairingEpoch.length <= 200;
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
