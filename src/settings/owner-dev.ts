import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  MonarchOwnerDevSettingsV1,
  MonarchSettingsBackend,
  MonarchSettingsCommandRequestV1,
  MonarchSettingsReadRequestV1,
  MonarchSettingsReadResultV1,
  MonarchSettingsWriteReceiptV1,
} from './contracts';

interface StoredOwnerDevSettingsV1 {
  schemaVersion: 1;
  revision: number;
  value: MonarchOwnerDevSettingsV1;
  receipts: Record<string, { requestHash: string; receipt: MonarchSettingsWriteReceiptV1 }>;
}

const BOOLEAN_KEYS = [
  'zeroRetentionEnabled',
  'internetEnabled',
  'memoryEnabled',
  'historyContextEnabled',
  'personalityEnabled',
  'skillsEnabled',
  'runtimeContextEnabled',
  'qualityRegenerationEnabled',
] as const;

export const DEFAULT_OWNER_DEV_SETTINGS: Readonly<MonarchOwnerDevSettingsV1> = Object.freeze({
  schemaVersion: 1,
  zeroRetentionEnabled: false,
  internetEnabled: true,
  memoryEnabled: true,
  historyContextEnabled: true,
  personalityEnabled: true,
  skillsEnabled: true,
  runtimeContextEnabled: true,
  qualityRegenerationEnabled: true,
  updatedAt: '',
});

export class LocalOwnerDevSettingsStore implements MonarchSettingsBackend {
  private readonly filePath: string;
  private state: StoredOwnerDevSettingsV1;

  constructor(stateRoot: string) {
    this.filePath = path.join(stateRoot, 'settings', 'owner-dev.v1.json');
    this.state = this.readState();
  }

  snapshot(): MonarchOwnerDevSettingsV1 {
    return { ...this.state.value };
  }

  async read(request: MonarchSettingsReadRequestV1): Promise<MonarchSettingsReadResultV1> {
    if (request.kind !== 'dev' || request.scope.type !== 'chat') {
      throw new Error('Owner DEV settings support only the global chat scope.');
    }
    return this.readBack();
  }

  async execute(
    request: MonarchSettingsCommandRequestV1 & { policyDecisionHash: string },
  ): Promise<MonarchSettingsWriteReceiptV1> {
    if (!request.command.startsWith('dev.') || request.scope.type !== 'chat') {
      throw new Error('Owner DEV settings support only DEV commands in the global chat scope.');
    }
    const requestHash = sha256({
      schemaVersion: request.schemaVersion,
      clientRequestId: request.clientRequestId,
      command: request.command,
      scope: request.scope,
      expectedRevision: request.expectedRevision,
      payload: request.payload,
      policyDecisionHash: request.policyDecisionHash,
    });
    const replay = this.state.receipts[request.clientRequestId];
    if (replay) {
      if (replay.requestHash !== requestHash) throw new Error('clientRequestId was already used for a different DEV command.');
      return { ...replay.receipt, replayed: true };
    }
    if (request.expectedRevision !== this.state.revision) {
      throw new Error(`DEV settings revision changed: expected ${request.expectedRevision}, actual ${this.state.revision}.`);
    }

    const now = new Date().toISOString();
    const value = request.command === 'dev.reset'
      ? { ...DEFAULT_OWNER_DEV_SETTINGS, updatedAt: now }
      : this.applyPatch(request.payload.patch, now);
    this.state = { ...this.state, revision: this.state.revision + 1, value };
    const readBack = this.readBack();
    const receipt: MonarchSettingsWriteReceiptV1 = {
      schemaVersion: 1,
      receiptId: `owner_dev_receipt_${randomUUID().replaceAll('-', '')}`,
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
    this.trimReceipts();
    this.persist();
    return receipt;
  }

  private applyPatch(input: unknown, now: string): MonarchOwnerDevSettingsV1 {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('DEV patch must be an object.');
    const patch = input as Record<string, unknown>;
    const unknown = Object.keys(patch).filter((key) => !BOOLEAN_KEYS.includes(key as typeof BOOLEAN_KEYS[number]));
    if (unknown.length) throw new Error(`Unsupported DEV settings fields: ${unknown.join(', ')}.`);
    const next: MonarchOwnerDevSettingsV1 = { ...this.state.value, updatedAt: now };
    delete next.diagnostic;
    for (const key of BOOLEAN_KEYS) {
      if (!(key in patch)) continue;
      if (typeof patch[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
      next[key] = patch[key];
    }
    return next;
  }

  private readBack(): MonarchSettingsReadResultV1 {
    const response: MonarchSettingsReadResultV1 = {
      schemaVersion: 1,
      kind: 'dev',
      scope: { type: 'chat' },
      revision: this.state.revision,
      contentHash: '',
      value: this.snapshot(),
    };
    response.contentHash = sha256({ ...response, contentHash: undefined });
    return response;
  }

  private readState(): StoredOwnerDevSettingsV1 {
    if (!existsSync(this.filePath)) return freshState(DEFAULT_OWNER_DEV_SETTINGS);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredOwnerDevSettingsV1>;
      if (parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 0) {
        throw new Error('invalid owner DEV envelope');
      }
      const value = normalizeValue(parsed.value);
      return {
        schemaVersion: 1,
        revision: Number(parsed.revision),
        value,
        receipts: parsed.receipts && typeof parsed.receipts === 'object' ? parsed.receipts : {},
      };
    } catch (error) {
      return freshState({
        ...DEFAULT_OWNER_DEV_SETTINGS,
        zeroRetentionEnabled: true,
        diagnostic: `fail-closed:${error instanceof Error ? error.name : 'invalid-file'}`,
      });
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }

  private trimReceipts(): void {
    const entries = Object.entries(this.state.receipts);
    if (entries.length <= 64) return;
    this.state.receipts = Object.fromEntries(entries.slice(-64));
  }
}

function normalizeValue(value: unknown): MonarchOwnerDevSettingsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid owner DEV value');
  const record = value as Record<string, unknown>;
  const normalized: MonarchOwnerDevSettingsV1 = {
    ...DEFAULT_OWNER_DEV_SETTINGS,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt.slice(0, 80) : '',
  };
  for (const key of BOOLEAN_KEYS) {
    if (typeof record[key] !== 'boolean') throw new Error(`invalid owner DEV field ${key}`);
    normalized[key] = record[key];
  }
  return normalized;
}

function freshState(value: MonarchOwnerDevSettingsV1): StoredOwnerDevSettingsV1 {
  return { schemaVersion: 1, revision: 0, value: { ...value }, receipts: {} };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}
