import type {
  MonarchActionLedgerRecord,
  MonarchActionRollbackState,
  MonarchExecutionRequest,
  MonarchExecutionResult,
} from './contracts';
import { createHash } from 'node:crypto';
import { createMonarchId, nowIso } from './utils';
import { readDurableJson, writeDurableJson } from './durable-json';
import { actionResultDigest } from './action-result-digest';
import path from 'node:path';

interface PersistedActionLedgerV1 {
  version: 1;
  records: MonarchActionLedgerRecord[];
}

export type ActionLedgerBeginResult =
  | { status: 'started'; record: MonarchActionLedgerRecord }
  | { status: 'replay'; record: MonarchActionLedgerRecord; result: MonarchExecutionResult }
  | { status: 'running'; record: MonarchActionLedgerRecord }
  | { status: 'conflict'; record: MonarchActionLedgerRecord };

export class MonarchActionLedger {
  private readonly records = new Map<string, MonarchActionLedgerRecord>();

  constructor(
    private readonly maxRecords = 500,
    private readonly persistencePath?: string,
  ) {
    this.restore();
  }

  begin(request: MonarchExecutionRequest): ActionLedgerBeginResult {
    const key = request.idempotencyKey || request.id;
    const existing = this.records.get(key);
    if (existing) {
      if (request.proposalHash && existing.proposalHash && request.proposalHash !== existing.proposalHash) {
        return { status: 'conflict', record: cloneRecord(existing) };
      }
      if (existing.status === 'completed' && existing.result) {
        return { status: 'replay', record: cloneRecord(existing), result: cloneResult(existing.result) };
      }
      if (existing.status === 'failed' && existing.result
        && (existing.error === 'interrupted-before-completion' || isComputerActionRecord(existing))) {
        return { status: 'replay', record: cloneRecord(existing), result: cloneResult(existing.result) };
      }
      if (existing.status === 'authorized' || existing.status === 'executing') {
        return { status: 'running', record: cloneRecord(existing) };
      }
    }

    const timestamp = nowIso();
    const record: MonarchActionLedgerRecord = {
      ledgerId: createMonarchId('ledger'),
      idempotencyKey: key,
      ...(request.proposalId ? { proposalId: request.proposalId } : {}),
      ...(request.proposalHash ? { proposalHash: request.proposalHash } : {}),
      intentId: request.intentId,
      capabilityId: request.capabilityId,
      moduleId: request.moduleId,
      ...(request.leaseId ? { leaseId: request.leaseId } : {}),
      ...(request.modelId ? { modelId: request.modelId } : {}),
      ...(request.skillIds?.length ? { skillIds: [...request.skillIds] } : {}),
      ...(isDurableAction(request) ? { durable: true } : {}),
      // Reads and other agent steps were kept in memory only, so a task that
      // spanned a restart could not certify its completion (live: Coder task
      // failed with certificate-ledger after the runtime was restarted).
      ...(request.proposalId ? { receipt: true } : {}),
      status: 'executing',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.commit(() => {
      // A repeat of a failed action used to overwrite the earlier receipt, so a
      // completion certificate could no longer find the round that observed it
      // (live: an agent re-ran a failed command and the task ended with
      // certificate-ledger). The earlier receipt stays, under its own ledger id.
      if (existing) this.records.set(`${key}#${existing.ledgerId}`, existing);
      this.records.set(key, record);
      this.prune();
      return { status: 'started', record: cloneRecord(record) };
    });
  }

  complete(idempotencyKey: string, result: MonarchExecutionResult): MonarchActionLedgerRecord | null {
    const record = this.records.get(idempotencyKey);
    if (!record) return null;
    return this.commit(() => {
      record.status = result.ok ? 'completed' : 'failed';
      record.updatedAt = nowIso();
      record.summary = result.summary.slice(0, 1_000);
      if (result.error) record.error = result.error.slice(0, 200);
      else delete record.error;
      record.result = cloneResult(result);
      try { record.resultDigest = actionResultDigest(result); } catch { delete record.resultDigest; }
      return cloneRecord(record);
    });
  }

  list(limit = 100): MonarchActionLedgerRecord[] {
    return [...this.records.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(Math.trunc(limit), this.maxRecords)))
      .map(cloneRecord);
  }

  getByIdempotencyKey(key: string): MonarchActionLedgerRecord | null {
    const record = this.records.get(key);
    return record ? cloneRecord(record) : null;
  }

  getByLedgerId(ledgerId: string): MonarchActionLedgerRecord | null {
    const record = [...this.records.values()].find((candidate) => candidate.ledgerId === ledgerId);
    return record ? cloneRecord(record) : null;
  }

  setRollback(idempotencyKey: string, rollback: MonarchActionRollbackState): MonarchActionLedgerRecord | null {
    const record = this.records.get(idempotencyKey);
    if (!record) return null;
    return this.commit(() => {
      record.rollback = { ...rollback };
      record.updatedAt = nowIso();
      return cloneRecord(record);
    });
  }

  private prune(): void {
    if (this.records.size <= this.maxRecords) return;
    const removable = [...this.records.entries()]
      .filter(([, record]) => record.status === 'completed' || record.status === 'failed')
      .sort(([, left], [, right]) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
    for (const [key] of removable) {
      if (this.records.size <= this.maxRecords) break;
      this.records.delete(key);
    }
  }

  private restore(): void {
    if (!this.persistencePath) return;
    const persisted = readDurableJson<PersistedActionLedgerV1>(this.persistencePath);
    if (!persisted || persisted.version !== 1 || !Array.isArray(persisted.records)) return;
    for (const candidate of persisted.records.slice(-this.maxRecords)) {
      if (!isPersistedRecord(candidate) || !isKeptAcrossRestart(candidate)) continue;
      const record = cloneRecord(candidate);
      if (record.status === 'authorized' || record.status === 'executing') {
        record.status = 'failed';
        record.error = 'interrupted-before-completion';
        record.summary = 'Action was interrupted before completion, so its outcome is unknown: check the current state before doing anything like it again. The same idempotency key will not execute again automatically.';
        record.updatedAt = nowIso();
        record.result = {
          ok: false,
          summary: record.summary,
          error: record.error,
        };
      }
      // Repeats share an idempotency key: the newest holds it, earlier receipts
      // keep their own ledger-id slot (see begin()).
      const holder = this.records.get(record.idempotencyKey);
      if (holder && Date.parse(holder.updatedAt) > Date.parse(record.updatedAt)) {
        this.records.set(`${record.idempotencyKey}#${record.ledgerId}`, record);
      } else {
        if (holder) this.records.set(`${holder.idempotencyKey}#${holder.ledgerId}`, holder);
        this.records.set(record.idempotencyKey, record);
      }
    }
    this.prune();
    this.persist();
  }

  private persist(): void {
    if (!this.persistencePath) return;
    writeDurableJson(this.persistencePath, {
      version: 1,
      records: this.list(this.maxRecords).filter(isKeptAcrossRestart).map(sanitizeRecordForPersistence),
    } satisfies PersistedActionLedgerV1);
  }

  private commit<R>(mutation: () => R): R {
    const previous = new Map(
      [...this.records.entries()].map(([key, record]) => [key, cloneRecord(record)]),
    );
    try {
      const result = mutation();
      this.persist();
      return result;
    } catch (error) {
      this.records.clear();
      for (const [key, record] of previous) this.records.set(key, record);
      throw error;
    }
  }
}

function cloneRecord(record: MonarchActionLedgerRecord): MonarchActionLedgerRecord {
  return {
    ...record,
    ...(record.skillIds ? { skillIds: [...record.skillIds] } : {}),
    ...(record.result ? { result: cloneResult(record.result) } : {}),
    ...(record.rollback ? { rollback: { ...record.rollback } } : {}),
  };
}

function cloneResult(result: MonarchExecutionResult): MonarchExecutionResult {
  return {
    ...result,
    ...(result.metadata ? { metadata: { ...result.metadata } } : {}),
    ...(result.userFacing ? { userFacing: { ...result.userFacing } } : {}),
  };
}

function sanitizeRecordForPersistence(record: MonarchActionLedgerRecord): MonarchActionLedgerRecord {
  // A receipt kept only so a completion certificate survives a restart needs
  // identity, status and the result digest - never text, output or metadata
  // (an observation summary can name a window or a file's contents).
  if (record.durable !== true && record.receipt === true) {
    const errorCode = record.error && /^[a-z0-9:-]{1,96}$/u.test(record.error) ? record.error : undefined;
    const minimal: MonarchActionLedgerRecord = { ...cloneRecord(record), summary: 'Agent receipt.' };
    delete minimal.rollback;
    if (errorCode) minimal.error = errorCode; else delete minimal.error;
    if (record.result) minimal.result = { ok: record.result.ok, summary: 'Agent receipt.', ...(errorCode ? { error: errorCode } : {}) };
    return minimal;
  }
  const computerAction = isComputerActionRecord(record);
  const computerRecovery = computerAction ? durableComputerActionObservation(record) : undefined;
  const output = durableExclusiveCreateObservation(record) ?? computerRecovery?.output;
  const result = record.result
    ? {
      ok: record.result.ok,
      summary: computerAction ? 'Durable Computer action receipt.' : record.result.summary.slice(0, 1_000),
      ...(record.result.error ? { error: computerAction ? safeComputerError(record.result.error) : record.result.error.slice(0, 200) } : {}),
      ...(record.result.metadata ? { metadata: sanitizeMetadata(record, record.result.metadata, computerRecovery) } : {}),
      ...(output ? { output } : {}),
    }
    : undefined;
  const sanitized = {
    ...cloneRecord(record),
    ...(result ? { result } : {}),
  };
  if (computerAction) {
    sanitized.summary = 'Durable Computer action receipt.';
    if (sanitized.error && !/^[a-z0-9-]{1,96}$/u.test(sanitized.error)) delete sanitized.error;
    delete sanitized.rollback;
  }
  return sanitized;
}

/** Retain the bounded workspace-create receipt, not arbitrary tool output or
 * file contents. Otherwise a completed effect loses its readback facts after
 * process restart, and recovering callers cannot distinguish it from a claim.
 * Other capability families still need their own explicit persistence contract. */
function durableExclusiveCreateObservation(record: MonarchActionLedgerRecord): Record<string, unknown> | undefined {
  if (record.moduleId !== 'workspace' || record.capabilityId !== 'workspace.files.write'
    || record.status !== 'completed' || record.result?.ok !== true) return undefined;
  const output = record.result.output;
  const dispatch = record.result.metadata?.dispatchControl as { dispatched?: unknown } | undefined;
  if (!output || typeof output !== 'object' || Array.isArray(output) || dispatch?.dispatched !== true) return undefined;
  const value = output as Record<string, unknown>;
  if (value.verified !== true || value.createdExclusively !== true
    || typeof value.path !== 'string' || !path.isAbsolute(value.path) || value.path.length > 4096
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || Number(value.bytes) > 512 * 1024
    || typeof value.readbackSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.readbackSha256)) return undefined;
  return { path: value.path, bytes: value.bytes, verified: true, readbackSha256: value.readbackSha256, createdExclusively: true,
    ...(typeof value.cancellationObservedAfterDispatch === 'boolean' ? { cancellationObservedAfterDispatch: value.cancellationObservedAfterDispatch } : {}) };
}

/** Persist only opaque, bounded facts required to reconcile a Computer action.
 * No screenshot path/pixels, element text, window title, action text, policy
 * target or arbitrary module metadata crosses a process restart. */
interface DurableComputerRecoveryProjection { output?: Record<string, unknown>; reason: string }
function durableComputerActionObservation(record: MonarchActionLedgerRecord): DurableComputerRecoveryProjection {
  if (!isComputerActionRecord(record) || !record.result) return { reason: 'result-missing' };
  const output = plainRecord(record.result.output);
  if (!output || output.verified !== (record.result.ok === true)) return { reason: 'result-shape' };
  const base = {
    recoverySchemaVersion: 'monarch.computer-action-recovery-output.v1',
    performed: output.performed,
    verified: output.verified,
  };
  if (!record.result.ok) {
    if (output.performed !== false && output.performed !== 'unknown') return { reason: 'failure-effect-shape' };
    return { output: base, reason: 'retained-failure' };
  }
  if (record.status !== 'completed' || output.performed !== true
    || !computerId(output.actionReceiptId, 'computer-action') || !computerId(output.beforeObservationId, 'computer-observation')
    || !windowRef(output.windowRef)) return { reason: 'success-identity' };
  const common = { ...base, actionReceiptId: output.actionReceiptId, beforeObservationId: output.beforeObservationId,
    windowRef: output.windowRef };
  if (record.capabilityId === 'computer.window.close') {
    return output.closed === true ? { output: { ...common, closed: true }, reason: 'retained-success' } : { reason: 'close-shape' };
  }
  const after = plainRecord(output.after), afterWindow = plainRecord(after?.window), screenshot = plainRecord(after?.screenshot);
  if (!computerId(output.afterObservationId, 'computer-observation') || after?.verified !== true
    || after.observationId !== output.afterObservationId) return { reason: 'after-identity' };
  if (!validIso(after.observedAt)) return { reason: 'after-time' };
  if (!afterWindow || afterWindow.windowRef !== output.windowRef || !Number.isSafeInteger(afterWindow.processId)
    || Number(afterWindow.processId) < 1 || Number(afterWindow.processId) > 2147483647)
    return { reason: 'after-process' };
  if (typeof afterWindow.processInstanceId !== 'string' || !/^process:[a-f0-9]{64}$/u.test(afterWindow.processInstanceId))
    return { reason: 'after-process-instance' };
  const titleDigest = typeof afterWindow.title === 'string' && afterWindow.title.length >= 1 && afterWindow.title.length <= 4096
    ? sha256(afterWindow.title)
    : typeof afterWindow.titleDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(afterWindow.titleDigest)
      ? afterWindow.titleDigest
      : undefined;
  if (!titleDigest) return { reason: 'after-title' };
  if (typeof screenshot?.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(screenshot.sha256))
    return { reason: 'after-screenshot' };
  const recovered: Record<string, unknown> = { ...common, afterObservationId: output.afterObservationId,
    after: { verified: true, observationId: after.observationId, observedAt: after.observedAt,
      window: { windowRef: afterWindow.windowRef, processId: afterWindow.processId,
        processInstanceId: afterWindow.processInstanceId, titleDigest },
      screenshot: { sha256: screenshot.sha256 } } };
  if (record.capabilityId === 'computer.window.type') {
    const text = plainRecord(output.textVerification);
    if (!text || !['insert', 'replace'].includes(String(text.textMode))
      || typeof text.textSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(text.textSha256)
      || text.valueVerifiedAfterDispatch !== (text.textMode === 'replace')) return { reason: 'text-shape' };
    recovered.textVerification = { textMode: text.textMode, textSha256: text.textSha256,
      valueVerifiedAfterDispatch: text.valueVerifiedAfterDispatch };
  }
  return { output: recovered, reason: 'retained-success' };
}

function sanitizeMetadata(record: MonarchActionLedgerRecord, metadata: Record<string, unknown>, recovery?: DurableComputerRecoveryProjection): Record<string, unknown> {
  if (isComputerActionRecord(record)) {
    const result: Record<string, unknown> = { recoveryReceipt: { retained: !!recovery?.output, reason: recovery?.reason ?? 'unavailable' } };
    const dispatch = plainRecord(metadata.dispatchControl);
    if (typeof dispatch?.dispatched === 'boolean') result.dispatchControl = { dispatched: dispatch.dispatched,
      ...(typeof dispatch.reason === 'string' && /^[a-z0-9-]{1,96}$/u.test(dispatch.reason) ? { reason: dispatch.reason } : {}) };
    const native = plainRecord(metadata.computerDispatch);
    if (native && ['before-native', 'prepared', 'native-entered', 'receipt-returned'].includes(String(native.phase))
      && typeof native.nativePreflightRejected === 'boolean' && typeof native.mayHaveDispatched === 'boolean'
      && typeof native.reportingFailed === 'boolean') result.computerDispatch = { phase: native.phase,
        nativePreflightRejected: native.nativePreflightRejected, mayHaveDispatched: native.mayHaveDispatched,
        reportingFailed: native.reportingFailed,
        ...(typeof native.failureCode === 'string' && /^[a-z0-9._-]{1,96}$/u.test(native.failureCode)
          ? { failureCode: native.failureCode } : {}) };
    return result;
  }
  try {
    const serialized = JSON.stringify(metadata);
    if (serialized.length <= 32_000) return JSON.parse(serialized) as Record<string, unknown>;
    return { truncated: true, originalChars: serialized.length };
  } catch {
    return { truncated: true, reason: 'non-json-metadata' };
  }
}

function isComputerActionRecord(record: MonarchActionLedgerRecord): boolean {
  return record.moduleId === 'computer' && ['computer.window.click', 'computer.window.close', 'computer.window.type',
    'computer.window.key', 'computer.window.scroll'].includes(record.capabilityId);
}

function safeComputerError(value: string): string {
  return /^[a-z0-9-]{1,96}$/u.test(value) ? value : 'computer-action-recovery-failed';
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function computerId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp('^' + prefix + '-[0-9a-f-]{36}$', 'u').test(value);
}

function windowRef(value: unknown): value is string {
  return typeof value === 'string' && /^hwnd:[0-9a-fA-F]{1,16}$/u.test(value);
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function sha256(value: string): string { return 'sha256:' + createHash('sha256').update(value).digest('hex'); }

function isPersistedRecord(value: unknown): value is MonarchActionLedgerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.ledgerId === 'string'
    && typeof record.idempotencyKey === 'string'
    && typeof record.intentId === 'string'
    && typeof record.capabilityId === 'string'
    && typeof record.moduleId === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && (record.status === 'authorized' || record.status === 'executing' || record.status === 'completed' || record.status === 'failed');
}

/** Effectful actions from the moment they start; any other agent receipt
 * once finished (an interrupted read simply runs again). */
function isKeptAcrossRestart(record: MonarchActionLedgerRecord): boolean {
  return record.durable === true
    || (record.receipt === true && (record.status === 'completed' || record.status === 'failed'));
}

function isDurableAction(request: MonarchExecutionRequest): boolean {
  return Boolean(request.proposalId)
    && request.riskVector?.effect !== 'none'
    && request.riskVector?.effect !== 'read';
}
