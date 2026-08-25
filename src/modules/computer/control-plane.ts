import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ComputerLogicalCursorState {
  visible: boolean;
  x: number | null;
  y: number | null;
  windowRef: string | null;
  leaseId: string | null;
  updatedAt: string;
}

export interface ComputerUseControlSnapshot {
  schemaVersion: 1;
  enabled: boolean;
  controlEpoch: number;
  stoppedAt: string | null;
  stoppedBy: string | null;
  activeLease: {
    leaseId: string;
    requestId: string;
    windowRef: string;
    startedAt: string;
  } | null;
  logicalCursor: ComputerLogicalCursorState;
  emergencyShortcut: 'Ctrl+Alt+Escape';
}

export interface ComputerUseCapabilitySnapshotV1 {
  schemaVersion: 1;
  available: boolean;
  enabled: boolean;
  surface: 'computer-use';
  invocation: '@Computer Use';
  ownCursor: true;
  observeAnalyzeAct: true;
  emergencyShortcut: 'Ctrl+Alt+Escape';
}

/**
 * Decide whether an answer-only turn needs a trusted Computer Use snapshot.
 * This is context selection only and never grants execution authority.
 */
export function requestReferencesComputerUseCapability(value: unknown): boolean {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!text) return false;
  if (/(?:@?computer[\s_-]*use\b|@cu\b|\bc\.?\s*use\b|компьютер\s*use\b)/iu.test(text)) return true;
  if (/(?:курсор(?:ом|а|у)?\s+(?:oscar|оскар)|(?:свой|собственн\w*)\s+курсор)/iu.test(text)) return true;
  if (/(?:управл\w*|контрол\w*)\s+(?:моим\s+|этим\s+)?(?:компьютер\w*|мыш\w*|клавиатур\w*)/iu.test(text)) return true;
  return /(?:что|какие)\s+(?:ты\s+)?(?:умеешь|можешь|возможност)|\bwhat\s+can\s+you\s+do\b|\byour\s+capabilit/iu.test(text);
}

export interface ComputerUseLease {
  leaseId: string;
  requestId: string;
  windowRef: string;
  controlEpoch: number;
  startedAt: string;
  signal: AbortSignal;
}

interface PersistedControlState {
  schemaVersion: 1;
  enabled: boolean;
  controlEpoch: number;
  stoppedAt: string | null;
  stoppedBy: string | null;
  activeLeaseId: string | null;
  logicalCursor: ComputerLogicalCursorState;
}

export class ComputerUseControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ComputerUseControlError';
  }
}

export class ComputerUseControlPlane {
  // Computer Use is an explicit local-user capability. A missing or corrupt
  // state file must fail closed instead of silently creating input authority.
  private enabled = false;
  private controlEpoch = 1;
  private stoppedAt: string | null = null;
  private stoppedBy: string | null = null;
  private active: {
    lease: ComputerUseLease;
    controller: AbortController;
    detachCallerAbort: () => void;
  } | null = null;
  private logicalCursor: ComputerLogicalCursorState = {
    visible: false,
    x: null,
    y: null,
    windowRef: null,
    leaseId: null,
    updatedAt: new Date(0).toISOString(),
  };

  constructor(readonly statePath: string, private readonly now: () => Date = () => new Date()) {
    this.statePath = path.resolve(statePath);
    const loadedPersistedState = this.loadPersisted();
    if (!loadedPersistedState) this.persistSynchronously();
  }

  snapshot(): ComputerUseControlSnapshot {
    return {
      schemaVersion: 1,
      enabled: this.enabled,
      controlEpoch: this.controlEpoch,
      stoppedAt: this.stoppedAt,
      stoppedBy: this.stoppedBy,
      activeLease: this.active ? {
        leaseId: this.active.lease.leaseId,
        requestId: this.active.lease.requestId,
        windowRef: this.active.lease.windowRef,
        startedAt: this.active.lease.startedAt,
      } : null,
      logicalCursor: { ...this.logicalCursor },
      emergencyShortcut: 'Ctrl+Alt+Escape',
    };
  }

  start(_requestedBy: string): ComputerUseControlSnapshot {
    const active = this.active;
    if (active) active.detachCallerAbort();
    this.active = null;
    this.controlEpoch += 1;
    this.enabled = true;
    this.stoppedAt = null;
    this.stoppedBy = null;
    this.logicalCursor = {
      ...this.logicalCursor,
      visible: true,
      leaseId: null,
      updatedAt: this.now().toISOString(),
    };
    this.persistSynchronously();
    if (active) {
      active.controller.abort(new ComputerUseControlError(
        'computer-control-restarted',
        'Computer Use control was re-keyed by the user.',
      ));
    }
    return this.snapshot();
  }

  stop(requestedBy: string): ComputerUseControlSnapshot {
    const active = this.active;
    this.controlEpoch += 1;
    this.enabled = false;
    this.stoppedAt = this.now().toISOString();
    this.stoppedBy = String(requestedBy || 'user').slice(0, 200);
    // Remove the lease from the authoritative snapshot before aborting its
    // provider. The Stop receipt must never keep showing Oscar as active while
    // the child process is winding down.
    if (active) active.detachCallerAbort();
    this.active = null;
    this.hideCursor();
    // The small local control receipt is persisted synchronously before the
    // active provider is terminated. A newly spawned provider therefore sees
    // the revoked epoch even if stop races with its pre-dispatch check.
    this.persistSynchronously();
    if (active) {
      active.controller.abort(new ComputerUseControlError(
        'computer-use-stopped',
        'Computer Use was stopped by the user.',
      ));
    }
    return this.snapshot();
  }

  shutdown(): void {
    const active = this.active;
    if (active) active.detachCallerAbort();
    this.active = null;
    this.hideCursor();
    if (active) {
      // Preserve the user's enabled/disabled preference, but rotate the epoch
      // and clear the persisted lease before terminating an in-flight helper.
      this.controlEpoch += 1;
      this.persistSynchronously();
    }
    if (active) {
      active.controller.abort(new ComputerUseControlError(
        'computer-runtime-shutdown',
        'Computer Use runtime is shutting down.',
      ));
    }
  }

  assertEnabled(): void {
    if (!this.enabled) {
      throw new ComputerUseControlError(
        'computer-use-disabled',
        'Computer Use is stopped. Only the user can enable it again.',
      );
    }
  }

  acquire(
    requestId: string,
    windowRef: string,
    callerSignal?: AbortSignal,
  ): ComputerUseLease {
    this.assertEnabled();
    if (this.active) {
      throw new ComputerUseControlError(
        'computer-input-busy',
        'Oscar already owns the single short Windows input lease.',
      );
    }
    if (callerSignal?.aborted) {
      throw new ComputerUseControlError('computer-action-cancelled', 'Computer Use action was cancelled before input lease acquisition.');
    }
    const controller = new AbortController();
    const lease: ComputerUseLease = {
      leaseId: `computer-lease-${randomUUID()}`,
      requestId,
      windowRef,
      controlEpoch: this.controlEpoch,
      startedAt: this.now().toISOString(),
      signal: controller.signal,
    };
    let detachCallerAbort: () => void = () => undefined;
    const forwardAbort = () => {
      // Revoke the persisted lease before notifying the native bridge. The
      // helper checks this receipt between animation frames, characters, and
      // input transitions, so cancellation can unwind pressed input cleanly
      // before the bounded process-termination fallback fires.
      if (this.active?.lease.leaseId === lease.leaseId) {
        detachCallerAbort();
        this.active = null;
        this.controlEpoch += 1;
        this.logicalCursor = {
          ...this.logicalCursor,
          visible: this.enabled,
          leaseId: null,
          updatedAt: this.now().toISOString(),
        };
        try {
          this.persistSynchronously();
        } catch {
          // The native bridge still terminates the helper after its short
          // cooperative grace period. The action result remains uncertain and
          // cannot be reported as successful without a fresh observation.
        }
      }
      controller.abort(callerSignal?.reason);
    };
    detachCallerAbort = () => callerSignal?.removeEventListener('abort', forwardAbort);
    callerSignal?.addEventListener('abort', forwardAbort, { once: true });
    this.active = {
      lease,
      controller,
      detachCallerAbort,
    };
    this.persistSynchronously();
    return lease;
  }

  assertLease(lease: ComputerUseLease): void {
    if (
      !this.enabled
      || lease.controlEpoch !== this.controlEpoch
      || this.active?.lease.leaseId !== lease.leaseId
      || lease.signal.aborted
      || !this.persistedEpochMatches(lease.controlEpoch)
    ) {
      throw new ComputerUseControlError(
        'computer-input-lease-revoked',
        'Oscar input lease was revoked before the next Windows input atom.',
      );
    }
  }

  release(lease: ComputerUseLease): void {
    if (this.active?.lease.leaseId !== lease.leaseId) return;
    this.active.detachCallerAbort();
    this.active = null;
    this.logicalCursor = {
      ...this.logicalCursor,
      visible: true,
      leaseId: null,
      updatedAt: this.now().toISOString(),
    };
    this.persistSynchronously();
  }

  moveLogicalCursor(lease: ComputerUseLease, x: number, y: number): ComputerLogicalCursorState {
    this.assertLease(lease);
    this.logicalCursor = {
      visible: true,
      x: Math.round(x),
      y: Math.round(y),
      windowRef: lease.windowRef,
      leaseId: lease.leaseId,
      updatedAt: this.now().toISOString(),
    };
    this.persistSynchronously();
    return { ...this.logicalCursor };
  }

  logicalCursorOrigin(fallbackX: number, fallbackY: number): { x: number; y: number } {
    return {
      x: this.logicalCursor.x ?? Math.round(fallbackX),
      y: this.logicalCursor.y ?? Math.round(fallbackY),
    };
  }

  persistedEpochMatches(epoch: number): boolean {
    const persisted = this.readPersisted();
    return persisted?.enabled === true && persisted.controlEpoch === epoch;
  }

  private hideCursor(): void {
    this.logicalCursor = {
      visible: false,
      x: this.logicalCursor.x,
      y: this.logicalCursor.y,
      windowRef: this.logicalCursor.windowRef,
      leaseId: null,
      updatedAt: this.now().toISOString(),
    };
  }

  private loadPersisted(): boolean {
    const persisted = this.readPersisted();
    if (!persisted) return false;
    this.enabled = persisted.enabled;
    this.controlEpoch = Math.max(1, persisted.controlEpoch);
    this.stoppedAt = persisted.stoppedAt;
    this.stoppedBy = persisted.stoppedBy;
    this.logicalCursor = { ...persisted.logicalCursor };
    if (persisted.activeLeaseId) {
      // A persisted active lease belongs to a previous/crashed runtime and is
      // never resumable. Re-key it synchronously before any provider can run.
      this.controlEpoch += 1;
      this.persistSynchronously();
    }
    return true;
  }

  private readPersisted(): PersistedControlState | null {
    if (!existsSync(this.statePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersistedControlState>;
      if (
        parsed.schemaVersion !== 1
        || typeof parsed.enabled !== 'boolean'
        || !Number.isSafeInteger(parsed.controlEpoch)
        || Number(parsed.controlEpoch) < 1
      ) return null;
      return {
        schemaVersion: 1,
        enabled: parsed.enabled,
        controlEpoch: Number(parsed.controlEpoch),
        stoppedAt: typeof parsed.stoppedAt === 'string' ? parsed.stoppedAt : null,
        stoppedBy: typeof parsed.stoppedBy === 'string' ? parsed.stoppedBy : null,
        activeLeaseId: typeof parsed.activeLeaseId === 'string' ? parsed.activeLeaseId : null,
        logicalCursor: readLogicalCursor(parsed.logicalCursor, parsed.enabled),
      };
    } catch {
      return null;
    }
  }

  private persistSynchronously(): void {
    const parent = path.dirname(this.statePath);
    mkdirSync(parent, { recursive: true });
    const temporary = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    const payload: PersistedControlState = {
      schemaVersion: 1,
      enabled: this.enabled,
      controlEpoch: this.controlEpoch,
      stoppedAt: this.stoppedAt,
      stoppedBy: this.stoppedBy,
      activeLeaseId: this.enabled ? this.active?.lease.leaseId || null : null,
      logicalCursor: {
        ...this.logicalCursor,
        visible: this.enabled && this.logicalCursor.visible,
        leaseId: this.enabled ? this.active?.lease.leaseId || null : null,
      },
    };
    try {
      writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx' });
      if (existsSync(this.statePath)) rmSync(this.statePath, { force: true });
      renameWithWindowsReaderRetry(temporary, this.statePath);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }
}

function readLogicalCursor(value: unknown, enabled: boolean): ComputerLogicalCursorState {
  const cursor = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<ComputerLogicalCursorState>
    : {};
  return {
    visible: enabled,
    x: Number.isFinite(cursor.x) ? Math.round(Number(cursor.x)) : null,
    y: Number.isFinite(cursor.y) ? Math.round(Number(cursor.y)) : null,
    windowRef: typeof cursor.windowRef === 'string' ? cursor.windowRef : null,
    leaseId: null,
    updatedAt: typeof cursor.updatedAt === 'string' ? cursor.updatedAt : new Date(0).toISOString(),
  };
}

function renameWithWindowsReaderRetry(source: string, destination: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code || '')) throw error;
      const until = Date.now() + 3;
      while (Date.now() < until) {
        // A Windows reader may still hold the old delete-pending directory
        // entry for a few milliseconds even with FileShare.Delete enabled.
      }
    }
  }
  throw lastError;
}
