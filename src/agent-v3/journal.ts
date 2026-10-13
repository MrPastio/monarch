import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// V3 persistence primitive, not protocol admission, a Certifier or an execution
// grant. Callers must validate native commands/events before committing them.
// Kept out of the application's default imports until runtime admission exists.
export type AstraJson = null | boolean | number | string | AstraJson[] | { [key: string]: AstraJson };
export interface AstraJournalCommit {
  streamId: string;
  requestId: string;
  expectedRevision: number;
  events: AstraJson[];
  checkpoint: AstraJson;
  /** A storage reservation is accounting only, never execution authority. */
  reservationId?: string;
}
export interface AstraJournalAllocation {
  streamId: string;
  commits: number;
  eventBytes: number;
  checkpointBytes: number;
}
export interface AstraJournalReservation { id: string; allocations: AstraJournalAllocation[] }
/** Exact retained frontier that may be reclaimed only inside a sealed atomic
 * transition. This is storage lifecycle authority, never execution authority. */
export interface AstraJournalStreamRetirement {
  streamId: string;
  revision: number;
  commitHash: string;
}
export interface AstraJournalAtomicCommit {
  primary: AstraJournalCommit;
  additional?: AstraJournalCommit[];
  reserve?: AstraJournalReservation[];
  release?: string[];
  retire?: AstraJournalStreamRetirement[];
  /** Drop all but the latest `keepLatest` commits of the PRIMARY stream after
   * this write. For an owner-local control stream (the scheduler lease) whose
   * old commits are never replayed: its revision keeps counting, its retained
   * history stays bounded, and `history()` anchors at the oldest kept commit. */
  compactHistory?: { keepLatest: number };
}
export interface AstraJournalReservationView {
  plan: AstraJournalReservation;
  released: boolean;
  remaining: AstraJournalAllocation[];
}
export interface AstraJournalCapacity {
  occupiedOrReservedStreams: number;
  retainedBytes: number;
  reservedBytes: number;
  remainingBytes: number;
  remainingStreamSlots: number;
}
export interface AstraJournalOpeningRecovery { attempts: number; waitedMs: number; recoveredCodes: number[] }
/** The scoped writer used by an admitted component cannot silently drop its debit. */
export interface AstraJournalAccess {
  append(input: AstraJournalCommit): AstraJournalReceipt;
  read(streamId: string): AstraJournalSnapshot | null;
  history(streamId: string, afterRevision?: number, limit?: number): Array<{ receipt: AstraJournalReceipt; events: AstraJson[] }>;
}
export interface AstraJournalReceipt {
  streamId: string;
  requestId: string;
  revision: number;
  previousHash: string;
  commitHash: string;
  inputDigest: string;
  checkpointDigest: string;
}
export interface AstraJournalSnapshot {
  streamId: string;
  revision: number;
  commitHash: string;
  checkpoint: AstraJson;
}

const APPLICATION_ID = 0x41535433;
const ZERO = 'sha256:' + '0'.repeat(64);
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_STREAM_COMMITS = 4096;
const MIN_COMPACTED_COMMITS = 64;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
// Long AgentTasks keep immutable model/context/capability evidence in distinct
// streams. Bytes remain hard-capped at 64 MiB; this wider identity cohort lets
// several 64-turn tasks coexist without weakening the storage bound.
const MAX_STREAMS = 1024;
const MAX_RESERVATIONS = 256;
const MAX_RESERVATION_TOMBSTONES = 4096;
const ENCRYPTED_SCHEMA_VERSION = 3;
const ENCRYPTION_KEY_BYTES = 32;
const ENCRYPTION_NONCE_BYTES = 12;
const ENCRYPTION_TAG_BYTES = 16;
const ENCRYPTION_HEADER_BYTES = 1 + ENCRYPTION_NONCE_BYTES + ENCRYPTION_TAG_BYTES;
const ENCRYPTION_FORMAT = 1;
const ENCRYPTION_CHECK = Buffer.from('monarch.astra-v3.journal-encryption.v1', 'utf8');
const digest = (bytes: string | Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export class AstraJournalError extends Error {
  constructor(readonly code: string) { super('astra-journal:' + code); this.name = 'AstraJournalError'; }
}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AstraJournalError(code);
}
function id(value: string): void { check(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value), 'identity'); }
function integer(value: unknown): asserts value is number { check(Number.isSafeInteger(value) && Number(value) >= 0, 'revision'); }

/** Internal storage encoding only; does not replace the native protocol digest profile. */
export function astraJournalJson(value: AstraJson): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: AstraJson, depth: number): string => {
    check(depth <= 24 && ++nodes <= 50_000, 'value-complexity');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      check(Number.isSafeInteger(item) && !Object.is(item, -0), 'unsafe-number');
      return JSON.stringify(item);
    }
    if (typeof item === 'string') {
      check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item), 'unicode');
      check(Buffer.byteLength(item) <= MAX_VALUE_BYTES, 'value-size');
      return JSON.stringify(item);
    }
    check(typeof item === 'object' && item !== undefined && !ancestors.has(item), 'non-json-or-cycle');
    check(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, 'non-json-object');
    ancestors.add(item);
    let encoded: string;
    if (Array.isArray(item)) {
      check(item.length <= 50_000 && Object.keys(item).length === item.length, 'sparse-or-decorated-array');
      encoded = '[' + Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        check(descriptor && 'value' in descriptor, 'accessor');
        return visit(descriptor.value as AstraJson, depth + 1);
      }).join(',') + ']';
    } else {
      check(Object.getOwnPropertySymbols(item).length === 0, 'symbol-key');
      encoded = '{' + Object.keys(item).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        check(descriptor && 'value' in descriptor, 'accessor');
        return visit(key, depth + 1) + ':' + visit(descriptor.value as AstraJson, depth + 1);
      }).join(',') + '}';
    }
    ancestors.delete(item);
    check(Buffer.byteLength(encoded) <= MAX_VALUE_BYTES, 'value-size');
    return encoded;
  };
  return visit(value, 0);
}

type Row = Record<string, unknown>;
interface PreparedCommit { input: AstraJournalCommit; events: Buffer; checkpoint: Buffer; checkpointDigest: string; inputDigest: string }
function text(row: Row, name: string): string { check(typeof row[name] === 'string', 'corrupt-column'); return row[name]; }
function bytes(row: Row, name: string): Buffer {
  check(row[name] instanceof Uint8Array, 'corrupt-column');
  return Buffer.from(row[name]);
}
function receipt(row: Row): AstraJournalReceipt {
  integer(row.revision);
  return { streamId: text(row, 'stream_id'), requestId: text(row, 'request_id'), revision: row.revision,
    previousHash: text(row, 'previous_hash'), commitHash: text(row, 'commit_hash'), inputDigest: text(row, 'input_digest'),
    checkpointDigest: text(row, 'checkpoint_digest') };
}

function openAndProbe(filePath: string) {
  const recovery: AstraJournalOpeningRecovery = { attempts: 0, waitedMs: 0, recoveredCodes: [] };
  const delays = [20, 60, 120];
  for (;;) {
    const db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true, allowExtension: false });
    recovery.attempts++;
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;');
      // First WAL access establishes the VFS shared-memory connection. No schema,
      // checkpoint, command or application transaction has been written yet.
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      return { db, version, recovery };
    } catch (error) {
      db.close(); // Never keep a failed VFS connection or delete its WAL/SHM.
      const native = error as { code?: unknown; errcode?: unknown } | null;
      const delay = delays[recovery.attempts - 1];
      // Observed Windows concurrent-open/exit race: SQLITE_IOERR_TRUNCATE at
      // the initial SHM probe (SQLite 3.51.3 winLockSharedMemory). Node does not
      // expose the underlying Win32 error. This is bounded re-admission, not a
      // claim that every 1546 is transient. Persistent faults still fail closed.
      if (process.platform !== 'win32' || filePath === ':memory:' || native?.code !== 'ERR_SQLITE_ERROR'
        || native.errcode !== 1546 || delay === undefined) throw error;
      recovery.recoveredCodes.push(1546); recovery.waitedMs += delay;
      // Constructor-only wait, at most 200 ms across three retries. No polling
      // or retry in transaction/commit paths; their outcome may be uncertain.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

export class AstraJournal {
  private readonly db: DatabaseSync;
  private readonly opening: AstraJournalOpeningRecovery;
  private readonly encryptionKey?: Buffer;
  private encrypted = false;
  private closed = false;

  constructor(filePath: string, options: { upgradeFromV1?: boolean; upgradeFromV2?: boolean; encryptionKey?: Uint8Array } = {}) {
    check(filePath === ':memory:' || path.isAbsolute(filePath), 'absolute-storage-path-required');
    check(options.encryptionKey === undefined || filePath !== ':memory:', 'memory-encryption-forbidden');
    if (options.encryptionKey !== undefined) {
      check(options.encryptionKey.byteLength === ENCRYPTION_KEY_BYTES, 'encryption-key');
      this.encryptionKey = Buffer.from(options.encryptionKey);
    }
    // No default directory, implicit migrations, extensions or generic SQL surface.
    // The caller owns the exact storage directory and privacy/retention policy.
    const opened = openAndProbe(filePath);
    this.db = opened.db; this.opening = opened.recovery;
    try {
      const version = opened.version;
      const application = this.db.prepare('PRAGMA application_id').get()?.application_id;
      const tables = this.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.count;
      if (version === 0 && application === 0 && tables === 0) {
        this.transaction(() => {
          this.db.exec(`
            CREATE TABLE astra_streams (
              stream_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0),
              commit_hash TEXT NOT NULL, checkpoint BLOB NOT NULL, checkpoint_digest TEXT NOT NULL,
              checkpoint_bytes INTEGER NOT NULL CHECK(checkpoint_bytes>=0)
            ) STRICT;
            CREATE TABLE astra_commits (
              stream_id TEXT NOT NULL REFERENCES astra_streams(stream_id), request_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK(revision>0), previous_hash TEXT NOT NULL, commit_hash TEXT NOT NULL,
              input_digest TEXT NOT NULL, checkpoint_digest TEXT NOT NULL, events BLOB NOT NULL,
              event_bytes INTEGER NOT NULL CHECK(event_bytes>=0),
              PRIMARY KEY(stream_id,revision), UNIQUE(stream_id,request_id)
            ) STRICT;
            PRAGMA application_id=${APPLICATION_ID};
          `);
          this.createCapacityTables(this.encryptionKey ? ENCRYPTED_SCHEMA_VERSION : 2);
          if (this.encryptionKey) this.createEncryptionMetadata();
        });
        this.encrypted = Boolean(this.encryptionKey);
      } else if (version === 1 && application === APPLICATION_ID) {
        check(options.upgradeFromV1 === true, 'explicit-schema-upgrade-required');
        const names = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        check(names.map(row => row.name).join(',') === 'astra_commits,astra_streams', 'unsupported-database');
        // Only this exact application/schema may be upgraded, never another DB.
        // The caller explicitly owns migration of this path and must opt in.
        this.transaction(() => {
          for (const row of this.db.prepare('SELECT stream_id FROM astra_streams').all()) this.read(text(row, 'stream_id'));
          this.createCapacityTables();
        });
        if (this.encryptionKey) {
          check(options.upgradeFromV2 === true, 'explicit-schema-upgrade-required');
          this.upgradePlaintextToEncrypted();
        }
      } else if (version === 2 && application === APPLICATION_ID) {
        if (this.encryptionKey) {
          check(options.upgradeFromV2 === true, 'explicit-schema-upgrade-required');
          this.upgradePlaintextToEncrypted();
        }
      } else if (version === ENCRYPTED_SCHEMA_VERSION && application === APPLICATION_ID) {
        check(this.encryptionKey, 'encryption-key-required');
        this.encrypted = true;
        this.validateEncryptionMetadata();
      } else check(false, 'unsupported-database');
      const ownedTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const expectedTables = this.encrypted
        ? 'astra_allocations,astra_commits,astra_metadata,astra_reservation_tombstones,astra_reservations,astra_streams'
        : 'astra_allocations,astra_commits,astra_reservation_tombstones,astra_reservations,astra_streams';
      check(ownedTables.map(row => row.name).join(',') === expectedTables, 'unsupported-database');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
      check(this.db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok', 'database-integrity');
    } catch (error) { this.encryptionKey?.fill(0); this.db.close(); throw error; }
  }

  openingRecovery(): AstraJournalOpeningRecovery { return structuredClone(this.opening); }

  append(input: AstraJournalCommit): AstraJournalReceipt {
    return this.appendAtomic({ primary: input }).receipt;
  }

  /** All checkpoint/event writes and capacity changes have one SQLite commit point.
   * The primary command seals the complete group; replay never recharges capacity.
   */
  appendAtomic(operation: AstraJournalAtomicCommit, guard?: () => boolean): { receipt: AstraJournalReceipt; receipts: AstraJournalReceipt[] } {
    this.open();
    const inputs = [operation.primary, ...(operation.additional ?? [])];
    check(inputs.length <= 64 && new Set(inputs.map(input => input.streamId)).size === inputs.length, 'atomic-stream-set');
    const reserve = (operation.reserve ?? []).map(plan => JSON.parse(astraJournalJson(plan as unknown as AstraJson)) as AstraJournalReservation);
    const release = [...(operation.release ?? [])];
    const retire = (operation.retire ?? []).map(frontier => ({ ...frontier }));
    check(reserve.length <= 8 && release.length <= 8 && new Set(reserve.map(plan => plan.id)).size === reserve.length
      && new Set(release).size === release.length && !reserve.some(plan => release.includes(plan.id)), 'atomic-reservation-set');
    reserve.forEach(plan => this.validatePlan(plan)); release.forEach(id);
    check(retire.length <= 256 && new Set(retire.map(frontier => frontier.streamId)).size === retire.length
      && retire.every(frontier => Object.keys(frontier).length === 3
        && Object.keys(frontier).every(key => ['streamId', 'revision', 'commitHash'].includes(key))), 'atomic-retirement-set');
    for (const frontier of retire) {
      id(frontier.streamId); integer(frontier.revision);
      check(frontier.revision > 0 && /^sha256:[a-f0-9]{64}$/u.test(frontier.commitHash), 'retirement-frontier');
    }
    const compact = operation.compactHistory;
    check(compact === undefined || Object.keys(compact).length === 1 && Number.isSafeInteger(compact.keepLatest)
      && compact.keepLatest >= MIN_COMPACTED_COMMITS && compact.keepLatest <= MAX_STREAM_COMMITS / 2
      && !retire.some(frontier => frontier.streamId === operation.primary.streamId), 'compact-history');
    const retiredStreams = new Set(retire.map(frontier => frontier.streamId));
    check(inputs.every(input => !retiredStreams.has(input.streamId))
      && reserve.every(plan => plan.allocations.every(allocation => !retiredStreams.has(allocation.streamId))), 'retirement-stream-conflict');
    const prepared = inputs.map(input => this.prepare(input));
    check(prepared.reduce((sum, item) => sum + item.events.length + item.checkpoint.length, 0) <= 4 * MAX_VALUE_BYTES, 'atomic-byte-budget');
    if (inputs.length > 1 || reserve.length || release.length || retire.length || compact) {
      const group = digest(astraJournalJson({ inputs: prepared.map(item => item.inputDigest),
        reserve: reserve as unknown as AstraJson, release, retire: retire as unknown as AstraJson,
        ...(compact ? { compact: compact.keepLatest } : {}) }));
      for (const item of prepared) item.inputDigest = digest(astraJournalJson({ inputDigest: item.inputDigest, group }));
    }
    return this.transaction(() => {
      this.checkGuard(guard);
      const replay = this.findCommand(prepared[0]!);
      if (replay) {
        const receipts = prepared.map(item => { const row = this.findCommand(item); check(row, 'atomic-replay-incomplete'); return receipt(row); });
        return { receipt: receipts[0]!, receipts };
      }
      check(prepared.slice(1).every(item => !this.findCommand(item)), 'atomic-member-already-present');
      for (const frontier of retire) this.validateRetirement(frontier);
      reserve.forEach(plan => this.reserve(plan));
      const releasing = new Set(release);
      const receipts = prepared.map(item => this.appendPrepared(item, releasing));
      for (const reservationId of release) {
        this.release(reservationId);
      }
      for (const frontier of retire) this.retire(frontier);
      if (compact) this.db.prepare('DELETE FROM astra_commits WHERE stream_id=? AND revision<=?')
        .run(receipts[0]!.streamId, receipts[0]!.revision - compact.keepLatest);
      this.capacitySnapshot();
      this.checkGuard(guard);
      return { receipt: receipts[0]!, receipts };
    });
  }

  scoped(reservationId: string, guard?: () => boolean): AstraJournalAccess {
    id(reservationId);
    return Object.freeze({
      append: (input: AstraJournalCommit) => {
        check(!input.reservationId || input.reservationId === reservationId, 'reservation-scope');
        return this.appendAtomic({ primary: { ...input, reservationId } }, guard).receipt;
      },
      read: (streamId: string) => this.read(streamId),
      history: (streamId: string, afterRevision?: number, limit?: number) => this.history(streamId, afterRevision, limit),
    });
  }

  capacity(): AstraJournalCapacity { this.open(); return this.transaction(() => this.capacitySnapshot()); }

  reservation(reservationId: string): AstraJournalReservationView | null {
    this.open(); id(reservationId);
    const row = this.db.prepare('SELECT * FROM astra_reservations WHERE reservation_id=?').get(reservationId);
    if (!row) return null;
    const encoded = bytes(row, 'plan');
    check(encoded.length === row.plan_bytes && digest(encoded) === row.plan_digest, 'reservation-integrity');
    const plan = JSON.parse(encoded.toString('utf8')) as AstraJournalReservation;
    this.validatePlan(plan);
    check(plan.id === reservationId && astraJournalJson(plan as unknown as AstraJson) === encoded.toString('utf8'), 'reservation-integrity');
    const rows = this.db.prepare('SELECT * FROM astra_allocations WHERE reservation_id=? ORDER BY stream_id').all(reservationId);
    const remaining = rows.map(allocation => {
      const original = plan.allocations.find(item => item.streamId === allocation.stream_id);
      check(original && Number.isSafeInteger(allocation.commits_remaining) && Number(allocation.commits_remaining) >= 0
        && Number(allocation.commits_remaining) <= original.commits && Number.isSafeInteger(allocation.events_remaining)
        && Number(allocation.events_remaining) >= 0 && Number(allocation.events_remaining) <= original.eventBytes
        && allocation.checkpoint_bytes === original.checkpointBytes, 'reservation-integrity');
      return { streamId: original.streamId, commits: Number(allocation.commits_remaining),
        eventBytes: Number(allocation.events_remaining), checkpointBytes: original.checkpointBytes };
    });
    check(remaining.length === plan.allocations.length && (row.released === 0 || row.released === 1), 'reservation-integrity');
    return { plan, released: row.released === 1, remaining };
  }

  private prepare(input: AstraJournalCommit): PreparedCommit {
    this.open(); id(input.streamId); id(input.requestId); integer(input.expectedRevision);
    if (input.reservationId) id(input.reservationId);
    check(Array.isArray(input.events) && input.events.length > 0 && input.events.length <= 128, 'event-count');
    const events = Buffer.from(astraJournalJson(input.events));
    const checkpoint = Buffer.from(astraJournalJson(input.checkpoint));
    check(events.length <= MAX_EVENT_BYTES, 'event-size');
    const checkpointDigest = digest(checkpoint);
    const inputDigest = digest(astraJournalJson({ streamId: input.streamId, requestId: input.requestId,
      expectedRevision: input.expectedRevision, eventsDigest: digest(events), checkpointDigest,
      ...(input.reservationId ? { reservationId: input.reservationId } : {}) }));
    // Detach metadata, not just bodies: callers cannot mutate command identity while
    // another group is being prepared. Only an explicitly supplied synchronous,
    // read-only deny guard may run inside the transaction; never serialized input.
    return { input: { ...input }, events, checkpoint, checkpointDigest, inputDigest };
  }

  private findCommand(item: PreparedCommit): Row | undefined {
    const old = this.db.prepare('SELECT * FROM astra_commits WHERE stream_id=? AND request_id=?').get(item.input.streamId, item.input.requestId);
    if (old) { this.validateCommit(old); check(old.input_digest === item.inputDigest, 'idempotency-conflict'); }
    return old;
  }

  private appendPrepared({ input, events, checkpoint, checkpointDigest, inputDigest }: PreparedCommit,
    releasing: ReadonlySet<string> = new Set()): AstraJournalReceipt {
      const current = this.read(input.streamId);
      check((current?.revision ?? 0) === input.expectedRevision, 'revision-conflict');
      // Retained history is what is bounded; a compacted stream keeps counting.
      check(input.expectedRevision < MAX_STREAM_COMMITS || Number(this.db.prepare('SELECT count(*) AS count FROM astra_commits WHERE stream_id=?')
        .get(input.streamId)!.count) < MAX_STREAM_COMMITS, 'stream-budget');
      if (input.reservationId) {
        const reservation = this.reservation(input.reservationId);
        check(reservation && !reservation.released, 'reservation-unavailable');
        // A commit that ends its own reservation in this same atomic write is
        // settling the work, not extending its use of it - it must not need
        // spare budget from the resource it is about to release. Without this,
        // a job reconciled enough times to exhaust its own reservation could
        // never reach a terminal write: the settling commit needed budget the
        // reservation no longer had, so it stayed unsettled and (with a single
        // model slot) held every later agent task behind it indefinitely.
        if (!releasing.has(input.reservationId)) {
          const allocation = reservation.remaining.find(item => item.streamId === input.streamId);
          check(allocation && allocation.commits > 0 && allocation.eventBytes >= events.length
            && allocation.checkpointBytes >= checkpoint.length, 'reservation-budget');
          this.db.prepare(`UPDATE astra_allocations SET commits_remaining=commits_remaining-1,events_remaining=events_remaining-?
            WHERE reservation_id=? AND stream_id=?`).run(events.length, input.reservationId, input.streamId);
        } else {
          check(reservation.remaining.some(item => item.streamId === input.streamId), 'reservation-scope');
        }
      }
      const revision = input.expectedRevision + 1, previousHash = current?.commitHash ?? ZERO;
      const commitHash = digest(astraJournalJson({ streamId: input.streamId, requestId: input.requestId,
        revision, previousHash, inputDigest, checkpointDigest, eventsDigest: digest(events) }));
      const storedCheckpoint = this.encodePayload(checkpoint, input, revision, 'checkpoint');
      const storedEvents = this.encodePayload(events, input, revision, 'events');
      this.db.prepare(`INSERT INTO astra_streams VALUES(?,?,?,?,?,?) ON CONFLICT(stream_id) DO UPDATE SET
        revision=excluded.revision,commit_hash=excluded.commit_hash,checkpoint=excluded.checkpoint,
        checkpoint_digest=excluded.checkpoint_digest,checkpoint_bytes=excluded.checkpoint_bytes`)
        .run(input.streamId, revision, commitHash, storedCheckpoint, checkpointDigest, checkpoint.length);
      this.db.prepare('INSERT INTO astra_commits VALUES(?,?,?,?,?,?,?,?,?)')
        .run(input.streamId, input.requestId, revision, previousHash, commitHash, inputDigest, checkpointDigest, storedEvents, events.length);
      return { streamId: input.streamId, requestId: input.requestId, revision, previousHash, commitHash, inputDigest, checkpointDigest };
  }

  private createCapacityTables(version = 2): void {
    this.db.exec(`
      CREATE TABLE astra_reservations (
        reservation_id TEXT PRIMARY KEY, plan_digest TEXT NOT NULL, plan BLOB NOT NULL,
        plan_bytes INTEGER NOT NULL CHECK(plan_bytes>=0), released INTEGER NOT NULL CHECK(released IN(0,1))
      ) STRICT;
      CREATE TABLE astra_allocations (
        reservation_id TEXT NOT NULL REFERENCES astra_reservations(reservation_id), stream_id TEXT NOT NULL,
        commits_remaining INTEGER NOT NULL CHECK(commits_remaining>=0),
        events_remaining INTEGER NOT NULL CHECK(events_remaining>=0), checkpoint_bytes INTEGER NOT NULL CHECK(checkpoint_bytes>0),
        PRIMARY KEY(reservation_id,stream_id)
      ) STRICT;
      CREATE TABLE astra_reservation_tombstones (
        reservation_id TEXT PRIMARY KEY, plan_digest TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version=${version};
    `);
  }

  private createEncryptionMetadata(): void {
    check(this.encryptionKey, 'encryption-key-required');
    this.db.exec('CREATE TABLE astra_metadata (key TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;');
    const keyId = Buffer.from(digest(Buffer.concat([Buffer.from('monarch.astra-v3.journal-key.v1\0'), this.encryptionKey])), 'utf8');
    const checkValue = this.encrypt(ENCRYPTION_CHECK, { streamId: 'metadata', requestId: 'encryption_check' }, 1, 'metadata');
    this.db.prepare('INSERT INTO astra_metadata VALUES(?,?),(?,?)')
      .run('encryption.key_id', keyId, 'encryption.check', checkValue);
  }

  private validateEncryptionMetadata(): void {
    check(this.encryptionKey, 'encryption-key-required');
    const rows = this.db.prepare('SELECT key,value FROM astra_metadata ORDER BY key').all();
    check(rows.length === 2 && rows[0]?.key === 'encryption.check' && rows[1]?.key === 'encryption.key_id', 'encryption-metadata');
    const expectedKeyId = Buffer.from(digest(Buffer.concat([Buffer.from('monarch.astra-v3.journal-key.v1\0'), this.encryptionKey])), 'utf8');
    const storedKeyId = bytes(rows[1]!, 'value');
    check(storedKeyId.length === expectedKeyId.length && timingSafeEqual(storedKeyId, expectedKeyId), 'encryption-key-mismatch');
    const opened = this.decrypt(bytes(rows[0]!, 'value'), { streamId: 'metadata', requestId: 'encryption_check' }, 1, 'metadata');
    check(opened.length === ENCRYPTION_CHECK.length && timingSafeEqual(opened, ENCRYPTION_CHECK), 'encryption-key-mismatch');
  }

  private upgradePlaintextToEncrypted(): void {
    check(this.encryptionKey, 'encryption-key-required');
    // Validate the complete plaintext chain before changing a byte. Migration is
    // one SQLite transaction, so a crash exposes either the old v2 store or the
    // fully encrypted v3 store, never a mixed payload format.
    const streamIds = this.db.prepare('SELECT stream_id FROM astra_streams ORDER BY stream_id').all().map(row => text(row, 'stream_id'));
    for (const streamId of streamIds) {
      this.read(streamId);
      let after = 0;
      for (;;) {
        const page = this.history(streamId, after, 128);
        if (!page.length) break;
        after = page[page.length - 1]!.receipt.revision;
      }
    }
    try {
      this.transaction(() => {
        for (const row of this.db.prepare('SELECT stream_id,request_id,revision,events FROM astra_commits').all()) {
          integer(row.revision);
          const input = { streamId: text(row, 'stream_id'), requestId: text(row, 'request_id') };
          this.db.prepare('UPDATE astra_commits SET events=? WHERE stream_id=? AND revision=?')
            .run(this.encrypt(bytes(row, 'events'), input, row.revision, 'events'), input.streamId, row.revision);
        }
        for (const row of this.db.prepare(`SELECT s.stream_id,s.revision,s.checkpoint,c.request_id FROM astra_streams s
          JOIN astra_commits c ON c.stream_id=s.stream_id AND c.revision=s.revision`).all()) {
          integer(row.revision);
          const input = { streamId: text(row, 'stream_id'), requestId: text(row, 'request_id') };
          this.db.prepare('UPDATE astra_streams SET checkpoint=? WHERE stream_id=?')
            .run(this.encrypt(bytes(row, 'checkpoint'), input, row.revision, 'checkpoint'), input.streamId);
        }
        this.createEncryptionMetadata();
        this.db.exec(`PRAGMA user_version=${ENCRYPTED_SCHEMA_VERSION};`);
        this.encrypted = true;
        this.capacitySnapshot();
      });
    } catch (error) { this.encrypted = false; throw error; }
    this.validateEncryptionMetadata();
  }

  private encodePayload(value: Buffer, input: Pick<AstraJournalCommit, 'streamId' | 'requestId'>,
    revision: number, field: 'events' | 'checkpoint'): Buffer {
    return this.encrypted ? this.encrypt(value, input, revision, field) : value;
  }

  private decodePayload(value: Buffer, row: Row, field: 'events' | 'checkpoint'): Buffer {
    if (!this.encrypted) return value;
    integer(row.revision);
    return this.decrypt(value, { streamId: text(row, 'stream_id'), requestId: text(row, 'request_id') }, row.revision, field);
  }

  private encrypt(value: Buffer, input: { streamId: string; requestId: string }, revision: number,
    field: 'events' | 'checkpoint' | 'metadata'): Buffer {
    check(this.encryptionKey, 'encryption-key-required');
    const nonce = randomBytes(ENCRYPTION_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(this.encryptionAad(input, revision, field));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([Buffer.from([ENCRYPTION_FORMAT]), nonce, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(value: Buffer, input: { streamId: string; requestId: string }, revision: number,
    field: 'events' | 'checkpoint' | 'metadata'): Buffer {
    check(this.encryptionKey && value.length >= ENCRYPTION_HEADER_BYTES && value[0] === ENCRYPTION_FORMAT, 'encrypted-payload');
    try {
      const nonce = value.subarray(1, 1 + ENCRYPTION_NONCE_BYTES);
      const tag = value.subarray(1 + ENCRYPTION_NONCE_BYTES, ENCRYPTION_HEADER_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, nonce);
      decipher.setAAD(this.encryptionAad(input, revision, field));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(value.subarray(ENCRYPTION_HEADER_BYTES)), decipher.final()]);
    } catch { throw new AstraJournalError('encrypted-payload-integrity'); }
  }

  private encryptionAad(input: { streamId: string; requestId: string }, revision: number,
    field: 'events' | 'checkpoint' | 'metadata'): Buffer {
    return Buffer.from(astraJournalJson({ applicationId: APPLICATION_ID, schemaVersion: ENCRYPTED_SCHEMA_VERSION,
      streamId: input.streamId, requestId: input.requestId, revision, field }), 'utf8');
  }

  private validatePlan(plan: AstraJournalReservation): void {
    check(Object.keys(plan).every(key => key === 'id' || key === 'allocations'), 'reservation-plan-fields');
    id(plan.id);
    check(Array.isArray(plan.allocations) && plan.allocations.length > 0 && plan.allocations.length <= 64
      && new Set(plan.allocations.map(item => item.streamId)).size === plan.allocations.length, 'reservation-stream-set');
    for (const allocation of plan.allocations) {
      check(Object.keys(allocation).every(key => ['streamId', 'commits', 'eventBytes', 'checkpointBytes'].includes(key)), 'reservation-plan-fields');
      id(allocation.streamId);
      check(Number.isSafeInteger(allocation.commits) && allocation.commits > 0 && allocation.commits <= MAX_STREAM_COMMITS
        && Number.isSafeInteger(allocation.eventBytes) && allocation.eventBytes >= 0 && allocation.eventBytes <= MAX_STORE_BYTES
        && Number.isSafeInteger(allocation.checkpointBytes) && allocation.checkpointBytes > 0
        && allocation.checkpointBytes <= MAX_VALUE_BYTES, 'reservation-plan-budget');
    }
    check(Buffer.byteLength(astraJournalJson(plan as unknown as AstraJson)) <= 32768, 'reservation-plan-size');
  }

  private reserve(plan: AstraJournalReservation): void {
    const tombstone = this.db.prepare('SELECT plan_digest FROM astra_reservation_tombstones WHERE reservation_id=?').get(plan.id);
    check(!tombstone, 'reservation-released');
    const old = this.reservation(plan.id), encoded = Buffer.from(astraJournalJson(plan as unknown as AstraJson));
    if (old) {
      check(astraJournalJson(old.plan as unknown as AstraJson) === encoded.toString('utf8'), 'reservation-conflict');
      check(!old.released, 'reservation-released'); return;
    }
    check(Number(this.db.prepare('SELECT count(*) AS count FROM astra_reservations').get()!.count) < MAX_RESERVATIONS, 'reservation-count-budget');
    this.db.prepare('INSERT INTO astra_reservations VALUES(?,?,?,?,0)').run(plan.id, digest(encoded), encoded, encoded.length);
    for (const allocation of plan.allocations) this.db.prepare('INSERT INTO astra_allocations VALUES(?,?,?,?,?)')
      .run(plan.id, allocation.streamId, allocation.commits, allocation.eventBytes, allocation.checkpointBytes);
  }

  private release(reservationId: string): void {
    const current = this.db.prepare('SELECT plan_digest FROM astra_reservations WHERE reservation_id=?').get(reservationId);
    if (!current) {
      check(this.db.prepare('SELECT 1 AS found FROM astra_reservation_tombstones WHERE reservation_id=?').get(reservationId), 'reservation-missing');
      return;
    }
    this.db.prepare('INSERT OR IGNORE INTO astra_reservation_tombstones VALUES(?,?)').run(reservationId, text(current, 'plan_digest'));
    this.db.prepare('DELETE FROM astra_allocations WHERE reservation_id=?').run(reservationId);
    this.db.prepare('DELETE FROM astra_reservations WHERE reservation_id=?').run(reservationId);
    const count = Number(this.db.prepare('SELECT count(*) AS count FROM astra_reservation_tombstones').get()!.count);
    if (count > MAX_RESERVATION_TOMBSTONES) this.db.prepare(`DELETE FROM astra_reservation_tombstones WHERE rowid IN
      (SELECT rowid FROM astra_reservation_tombstones ORDER BY rowid LIMIT ?)`).run(count - MAX_RESERVATION_TOMBSTONES);
  }

  private validateRetirement(frontier: AstraJournalStreamRetirement): void {
    const current = this.read(frontier.streamId);
    check(current && current.revision === frontier.revision && current.commitHash === frontier.commitHash, 'retirement-frontier-changed');
    const allocated = this.db.prepare(`SELECT 1 AS found FROM astra_allocations a JOIN astra_reservations r
      ON r.reservation_id=a.reservation_id WHERE r.released=0 AND a.stream_id=? LIMIT 1`).get(frontier.streamId);
    check(!allocated, 'retirement-stream-reserved');
  }

  private retire(frontier: AstraJournalStreamRetirement): void {
    // The exact frontier and all live allocations were checked inside this same
    // SQLite transaction. Commits must go first because their FK is restrictive.
    this.db.prepare('DELETE FROM astra_commits WHERE stream_id=?').run(frontier.streamId);
    const deleted = this.db.prepare('DELETE FROM astra_streams WHERE stream_id=? AND revision=? AND commit_hash=?')
      .run(frontier.streamId, frontier.revision, frontier.commitHash);
    check(deleted.changes === 1, 'retirement-frontier-changed');
  }

  private checkGuard(guard: (() => boolean) | undefined): void {
    if (!guard) return;
    let allowed = false;
    try { allowed = guard() === true; } catch { /* Do not expose guard exception details. */ }
    check(allowed, 'commit-fenced');
  }

  private capacitySnapshot(): AstraJournalCapacity {
    const streams = new Map<string, { revision: number; commits: number; checkpoint: number; reservedCheckpoint: number }>();
    const payloadOverhead = this.encrypted ? ENCRYPTION_HEADER_BYTES : 0;
    let retainedBytes = Number(this.db.prepare('SELECT coalesce(sum(length(events)),0) AS bytes FROM astra_commits').get()!.bytes)
      + Number(this.db.prepare('SELECT coalesce(sum(plan_bytes),0) AS bytes FROM astra_reservations').get()!.bytes)
      + Number(this.db.prepare('SELECT coalesce(sum(length(reservation_id)+length(plan_digest)),0) AS bytes FROM astra_reservation_tombstones').get()!.bytes)
      + (this.encrypted ? Number(this.db.prepare('SELECT coalesce(sum(length(key)+length(value)),0) AS bytes FROM astra_metadata').get()!.bytes) : 0);
    let reservedBytes = 0;
    // Retained commits, not the lifetime revision: a compacted stream keeps counting.
    const retained = new Map(this.db.prepare('SELECT stream_id,count(*) AS count FROM astra_commits GROUP BY stream_id').all()
      .map(row => [text(row, 'stream_id'), Number(row.count)] as const));
    for (const row of this.db.prepare('SELECT stream_id,revision,checkpoint_bytes FROM astra_streams').all()) {
      const streamId = text(row, 'stream_id');
      retainedBytes += this.encrypted
        ? Number(this.db.prepare('SELECT length(checkpoint) AS bytes FROM astra_streams WHERE stream_id=?').get(streamId)!.bytes)
        : Number(row.checkpoint_bytes);
      streams.set(streamId, { revision: retained.get(streamId) ?? Number(row.revision), commits: 0,
        checkpoint: Number(row.checkpoint_bytes) + payloadOverhead, reservedCheckpoint: 0 });
    }
    for (const row of this.db.prepare(`SELECT a.* FROM astra_allocations a JOIN astra_reservations r
      ON r.reservation_id=a.reservation_id WHERE r.released=0`).all()) {
      const streamId = text(row, 'stream_id'), stream = streams.get(streamId)
        ?? { revision: 0, commits: 0, checkpoint: 0, reservedCheckpoint: 0 };
      stream.commits += Number(row.commits_remaining);
      stream.reservedCheckpoint = Math.max(stream.reservedCheckpoint, Number(row.checkpoint_bytes) + payloadOverhead);
      reservedBytes += Number(row.events_remaining) + Number(row.commits_remaining) * payloadOverhead; streams.set(streamId, stream);
    }
    check(streams.size <= MAX_STREAMS, 'stream-count-budget');
    for (const stream of streams.values()) {
      check(stream.revision + stream.commits <= MAX_STREAM_COMMITS, 'stream-budget');
      reservedBytes += Math.max(0, stream.reservedCheckpoint - stream.checkpoint);
    }
    check(retainedBytes + reservedBytes <= MAX_STORE_BYTES, 'store-budget');
    return { occupiedOrReservedStreams: streams.size, retainedBytes, reservedBytes,
      remainingBytes: MAX_STORE_BYTES - retainedBytes - reservedBytes, remainingStreamSlots: MAX_STREAMS - streams.size };
  }

  read(streamId: string): AstraJournalSnapshot | null {
    this.open(); id(streamId);
    // One joined statement gives a coherent snapshot even across other processes.
    const row = this.db.prepare(`SELECT s.*, c.request_id,c.previous_hash,c.input_digest,c.events,c.event_bytes,
      c.checkpoint_digest AS commit_checkpoint_digest,c.commit_hash AS journal_hash FROM astra_streams s
      LEFT JOIN astra_commits c ON c.stream_id=s.stream_id AND c.revision=s.revision WHERE s.stream_id=?`).get(streamId);
    if (!row) return null;
    const storedCheckpoint = bytes(row, 'checkpoint');
    const checkpoint = this.decodePayload(storedCheckpoint, row, 'checkpoint');
    check(checkpoint.length <= MAX_VALUE_BYTES && checkpoint.length === row.checkpoint_bytes
      && digest(checkpoint) === row.checkpoint_digest && row.checkpoint_digest === row.commit_checkpoint_digest
      && row.commit_hash === row.journal_hash, 'checkpoint-integrity');
    this.validateCommit(row);
    const value = JSON.parse(checkpoint.toString('utf8')) as AstraJson;
    check(astraJournalJson(value) === checkpoint.toString('utf8'), 'checkpoint-encoding');
    integer(row.revision);
    return { streamId, revision: row.revision, commitHash: text(row, 'commit_hash'), checkpoint: value };
  }

  history(streamId: string, afterRevision = 0, limit = 128): Array<{ receipt: AstraJournalReceipt; events: AstraJson[] }> {
    this.open(); id(streamId); integer(afterRevision);
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 128, 'history-limit');
    const rows = this.db.prepare(`SELECT c.*,(SELECT commit_hash FROM astra_commits p
      WHERE p.stream_id=c.stream_id AND p.revision=?) AS anchor FROM astra_commits c
      WHERE c.stream_id=? AND c.revision>? ORDER BY c.revision LIMIT ?`).all(afterRevision, streamId, afterRevision, limit);
    // A compacted stream starts at its oldest retained commit, anchored by that
    // commit's own predecessor hash; a gap anywhere after it is still a fault.
    const floor = rows.length && rows[0]!.anchor === null && Number(rows[0]!.revision) > afterRevision + 1
      && !this.db.prepare('SELECT 1 AS found FROM astra_commits WHERE stream_id=? AND revision<? LIMIT 1').get(streamId, Number(rows[0]!.revision))
      ? Number(rows[0]!.revision) - 1 : afterRevision;
    let previousHash = floor !== afterRevision ? text(rows[0]!, 'previous_hash')
      : afterRevision === 0 ? ZERO : rows.length ? text(rows[0]!, 'anchor') : ZERO;
    return rows.map((row, index) => {
      this.validateCommit(row);
      check(row.revision === floor + index + 1 && row.previous_hash === previousHash, 'history-integrity');
      previousHash = text(row, 'commit_hash');
      const encoded = this.decodePayload(bytes(row, 'events'), row, 'events');
      const events = JSON.parse(encoded.toString('utf8')) as AstraJson[];
      check(Array.isArray(events) && astraJournalJson(events) === encoded.toString('utf8'), 'event-encoding');
      return { receipt: receipt(row), events };
    });
  }

  close(): void { if (!this.closed) { this.db.close(); this.encryptionKey?.fill(0); this.closed = true; } }
  private open(): void { check(!this.closed, 'closed'); }
  private validateCommit(row: Row): void {
    const r = receipt(row), events = this.decodePayload(bytes(row, 'events'), row, 'events');
    check(events.length <= MAX_EVENT_BYTES && events.length === row.event_bytes, 'event-integrity');
    check(digest(astraJournalJson({ streamId: r.streamId, requestId: r.requestId, revision: r.revision,
      previousHash: r.previousHash, inputDigest: r.inputDigest, checkpointDigest: r.checkpointDigest,
      eventsDigest: digest(events) })) === r.commitHash, 'commit-integrity');
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ } throw error; }
  }
}
