import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MonarchOwnerUnrestrictedOverride } from '../core/contracts';
import type {
  MonarchSettingsBackend,
  MonarchSettingsCommandRequestV1,
  MonarchSettingsReadRequestV1,
  MonarchSettingsReadResultV1,
  MonarchSettingsWriteReceiptV1,
} from './contracts';

interface StoredOwnerOverrideV1 {
  schemaVersion: 1;
  revision: number;
  value: MonarchOwnerUnrestrictedOverride;
  receipts: Record<string, { requestHash: string; receipt: MonarchSettingsWriteReceiptV1 }>;
}

export const DEFAULT_OWNER_UNRESTRICTED_OVERRIDE: Readonly<MonarchOwnerUnrestrictedOverride> = Object.freeze({
  enabled: false,
  lifetime: 'session',
  shellApprovalPolicy: 'always',
});

/**
 * Local Owner-only control state. Session grants are deliberately cleared on
 * process construction; task grants remain inert outside their exact task id.
 */
export class LocalOwnerUnrestrictedOverrideStore implements MonarchSettingsBackend {
  private readonly filePath: string;
  private state: StoredOwnerOverrideV1;

  constructor(stateRoot: string) {
    this.filePath = path.join(stateRoot, 'settings', 'owner-unrestricted-override.v1.json');
    this.state = this.readState();
    if (this.state.value.enabled && this.state.value.lifetime === 'session') {
      this.state = {
        ...this.state,
        revision: this.state.revision + 1,
        value: { ...DEFAULT_OWNER_UNRESTRICTED_OVERRIDE },
      };
      this.persist();
    }
  }

  snapshot(): MonarchOwnerUnrestrictedOverride {
    return { ...this.state.value };
  }

  async read(request: MonarchSettingsReadRequestV1): Promise<MonarchSettingsReadResultV1> {
    if (request.kind !== 'owner-override' || request.scope.type !== 'chat') {
      throw new Error('Owner override supports only its global local scope.');
    }
    return this.readBack();
  }

  async execute(request: MonarchSettingsCommandRequestV1 & { policyDecisionHash: string }): Promise<MonarchSettingsWriteReceiptV1> {
    if (!request.command.startsWith('owner-override.') || request.scope.type !== 'chat') {
      throw new Error('Owner override accepts only local Owner override commands.');
    }
    const requestHash = sha256({
      clientRequestId: request.clientRequestId,
      command: request.command,
      expectedRevision: request.expectedRevision,
      payload: request.payload,
      policyDecisionHash: request.policyDecisionHash,
    });
    const replay = this.state.receipts[request.clientRequestId];
    if (replay) {
      if (replay.requestHash !== requestHash) throw new Error('clientRequestId was reused for another Owner override command.');
      return { ...replay.receipt, replayed: true };
    }
    if (request.expectedRevision !== this.state.revision) {
      throw new Error(`Owner override revision changed: expected ${request.expectedRevision}, actual ${this.state.revision}.`);
    }

    const now = new Date().toISOString();
    const value = request.command === 'owner-override.reset'
      ? { ...DEFAULT_OWNER_UNRESTRICTED_OVERRIDE }
      : normalizeOverride(request.payload, now);
    this.state = { ...this.state, revision: this.state.revision + 1, value };
    const readBack = this.readBack();
    const receipt: MonarchSettingsWriteReceiptV1 = {
      schemaVersion: 1,
      receiptId: `owner_override_receipt_${randomUUID().replaceAll('-', '')}`,
      clientRequestId: request.clientRequestId,
      command: request.command,
      scope: request.scope,
      revision: readBack.revision,
      contentHash: readBack.contentHash,
      readBackHash: readBack.contentHash,
      policyDecisionHash: request.policyDecisionHash,
      committedAt: now,
      replayed: false,
      result: { value },
    };
    this.state.receipts[request.clientRequestId] = { requestHash, receipt };
    this.state.receipts = Object.fromEntries(Object.entries(this.state.receipts).slice(-64));
    this.persist();
    return receipt;
  }

  private readBack(): MonarchSettingsReadResultV1 {
    const response: MonarchSettingsReadResultV1 = {
      schemaVersion: 1,
      kind: 'owner-override',
      scope: { type: 'chat' },
      revision: this.state.revision,
      contentHash: '',
      value: this.snapshot(),
    };
    response.contentHash = sha256({ ...response, contentHash: undefined });
    return response;
  }

  private readState(): StoredOwnerOverrideV1 {
    if (!existsSync(this.filePath)) return freshState();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredOwnerOverrideV1>;
      if (parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 0) throw new Error('invalid envelope');
      return {
        schemaVersion: 1,
        revision: Number(parsed.revision),
        value: normalizeStoredOverride(parsed.value),
        receipts: parsed.receipts && typeof parsed.receipts === 'object' ? parsed.receipts : {},
      };
    } catch {
      return freshState();
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

function normalizeOverride(value: unknown, activatedAt: string): MonarchOwnerUnrestrictedOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Owner override payload must be an object.');
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !['enabled', 'lifetime', 'taskId', 'shellApprovalPolicy'].includes(key));
  if (unknown.length) throw new Error(`Unsupported Owner override fields: ${unknown.join(', ')}.`);
  const enabled = record.enabled === true;
  const lifetime = record.lifetime;
  const shellApprovalPolicy = record.shellApprovalPolicy;
  if (lifetime !== 'task' && lifetime !== 'session' && lifetime !== 'persistent') throw new Error('Invalid Owner override lifetime.');
  if (shellApprovalPolicy !== 'always' && shellApprovalPolicy !== 'risk-based' && shellApprovalPolicy !== 'never') {
    throw new Error('Invalid shell approval policy.');
  }
  const taskId = typeof record.taskId === 'string' ? record.taskId.trim() : '';
  if (enabled && lifetime === 'task' && !/^agent_task_[A-Za-z0-9_-]{4,200}$/u.test(taskId)) {
    throw new Error('Task lifetime requires one exact Agent task id.');
  }
  return {
    enabled,
    lifetime,
    shellApprovalPolicy,
    ...(enabled && lifetime === 'task' ? { taskId } : {}),
    ...(enabled ? { activatedAt } : {}),
  };
}

function normalizeStoredOverride(value: unknown): MonarchOwnerUnrestrictedOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid value');
  const record = value as Record<string, unknown>;
  return normalizeOverride({
    enabled: record.enabled === true,
    lifetime: record.lifetime,
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
    shellApprovalPolicy: record.shellApprovalPolicy,
  }, typeof record.activatedAt === 'string' ? record.activatedAt : new Date(0).toISOString());
}

function freshState(): StoredOwnerOverrideV1 {
  return { schemaVersion: 1, revision: 0, value: { ...DEFAULT_OWNER_UNRESTRICTED_OVERRIDE }, receipts: {} };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}
