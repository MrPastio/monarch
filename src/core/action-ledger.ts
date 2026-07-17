import type {
  MonarchActionLedgerRecord,
  MonarchActionRollbackState,
  MonarchExecutionRequest,
  MonarchExecutionResult,
} from './contracts';
import { createMonarchId, nowIso } from './utils';
import { readDurableJson, writeDurableJson } from './durable-json';

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
      if (existing.status === 'failed' && existing.error === 'interrupted-before-completion' && existing.result) {
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
      status: 'executing',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.records.set(key, record);
    this.prune();
    this.persist();
    return { status: 'started', record: cloneRecord(record) };
  }

  complete(idempotencyKey: string, result: MonarchExecutionResult): MonarchActionLedgerRecord | null {
    const record = this.records.get(idempotencyKey);
    if (!record) return null;
    record.status = result.ok ? 'completed' : 'failed';
    record.updatedAt = nowIso();
    record.summary = result.summary.slice(0, 1_000);
    if (result.error) record.error = result.error.slice(0, 200);
    record.result = cloneResult(result);
    this.persist();
    return cloneRecord(record);
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
    record.rollback = { ...rollback };
    record.updatedAt = nowIso();
    this.persist();
    return cloneRecord(record);
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
      if (!isPersistedRecord(candidate) || candidate.durable !== true) continue;
      const record = cloneRecord(candidate);
      if (record.status === 'authorized' || record.status === 'executing') {
        record.status = 'failed';
        record.error = 'interrupted-before-completion';
        record.summary = 'Action was interrupted before completion; the same idempotency key will not execute again automatically.';
        record.updatedAt = nowIso();
        record.result = {
          ok: false,
          summary: record.summary,
          error: record.error,
        };
      }
      this.records.set(record.idempotencyKey, record);
    }
    this.prune();
    this.persist();
  }

  private persist(): void {
    if (!this.persistencePath) return;
    writeDurableJson(this.persistencePath, {
      version: 1,
      records: this.list(this.maxRecords).filter((record) => record.durable === true).map(sanitizeRecordForPersistence),
    } satisfies PersistedActionLedgerV1);
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
  const result = record.result
    ? {
      ok: record.result.ok,
      summary: record.result.summary.slice(0, 1_000),
      ...(record.result.error ? { error: record.result.error.slice(0, 200) } : {}),
      ...(record.result.metadata ? { metadata: sanitizeMetadata(record.result.metadata) } : {}),
    }
    : undefined;
  return {
    ...cloneRecord(record),
    ...(result ? { result } : {}),
  };
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(metadata);
    if (serialized.length <= 32_000) return JSON.parse(serialized) as Record<string, unknown>;
    return { truncated: true, originalChars: serialized.length };
  } catch {
    return { truncated: true, reason: 'non-json-metadata' };
  }
}

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

function isDurableAction(request: MonarchExecutionRequest): boolean {
  return Boolean(request.proposalId)
    && request.riskVector?.effect !== 'none'
    && request.riskVector?.effect !== 'read';
}
