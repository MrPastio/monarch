import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DurableJsonFile, writeFileAtomically } from '../core/durable-json-file';
import { isSealed, openBytes, sealBytes } from '../core/sealed-file';
import { StoreProtectionError, storeProtection } from '../core/store-protection';
import type { OscarPrivacyMode, OscarTurnSource } from './types';
import type { OscarTurnAttachmentPayload } from './coordinator';

const ATTACHMENT_INDEX_VERSION = 'monarch.oscar-attachment-store.v1' as const;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const OSCAR_TEXT_ATTACHMENT_MAX_BYTES = 32 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'application/json']);
const SUPPORTED_MIME_TYPES = new Set([...IMAGE_MIME_TYPES, ...TEXT_MIME_TYPES]);
const TEXT_EXTENSIONS = new Map([
  ['text/plain', new Set(['txt'])],
  ['text/markdown', new Set(['md', 'markdown'])],
  ['application/json', new Set(['json'])],
]);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const BLOB_STORE_ID = 'oscar-attachment-blob';

interface AttachmentMetadata {
  id: string;
  conversationId: string;
  privacyMode: OscarPrivacyMode;
  source: OscarTurnSource;
  name: string;
  mimeType: string;
  sizeBytes: number;
  digest: string;
  blobName: string;
  createdAt: string;
}

interface AttachmentIndex {
  schemaVersion: typeof ATTACHMENT_INDEX_VERSION;
  attachments: Record<string, AttachmentMetadata>;
  updatedAt: string;
}

export interface PutOscarAttachmentInput {
  conversationId: string;
  privacyMode: OscarPrivacyMode;
  source: OscarTurnSource;
  name: string;
  mimeType: string;
  dataBase64: string;
  /** Optional trusted-surface replay key. Same binding+key must always contain identical immutable bytes. */
  idempotencyKey?: string;
}

export interface OscarAttachmentReceipt extends Omit<AttachmentMetadata, 'blobName'> {}

export interface OscarAttachmentPruneResult {
  removedAttachments: number;
  removedBytes: number;
  removedOrphanBlobs: number;
}

export class OscarAttachmentStore {
  private readonly root: string;
  private readonly blobRoot: string;
  private readonly index: DurableJsonFile<AttachmentIndex>;
  private readonly volatile = new Map<string, { metadata: AttachmentMetadata; data: Buffer }>();
  /** Session-only storage protection: persistent attachment bytes stay in memory. */
  private readonly sessionBlobs = new Map<string, Buffer>();
  private legacySweep: Promise<void> | undefined;

  constructor(stateRoot: string) {
    this.root = path.resolve(stateRoot, 'oscar', 'attachments');
    this.blobRoot = path.join(this.root, 'blobs');
    this.index = new DurableJsonFile(path.join(this.root, 'index.v1.json'), {
      createEmpty: emptyIndex,
      validate: assertIndex,
      sensitive: { storeId: 'oscar-attachments' },
    });
    // Owner decision: no plain original stays once sealing is on.
    if (storeProtection().mode === 'sealed') {
      void this.index.read().catch(() => undefined);
      this.sweepLegacyBlobs();
    }
  }

  /** Persistent attachment bytes under Monarch Security storage protection:
   * sealed on disk, in memory for the session, or plain when turned off. */
  private async writeBlob(blobName: string, data: Uint8Array): Promise<void> {
    const protection = storeProtection();
    if (protection.mode === 'session') {
      const existing = this.sessionBlobs.get(blobName);
      if (existing && !existing.equals(data)) {
        throw new OscarAttachmentStoreError('attachment-id-reused', 'Attachment replay bytes changed for the same idempotency key.');
      }
      this.sessionBlobs.set(blobName, Buffer.from(data));
      return;
    }
    await mkdir(this.blobRoot, { recursive: true });
    const blobPath = path.join(this.blobRoot, blobName);
    const stored = protection.mode === 'sealed' && protection.key
      ? sealBytes(protection.key, BLOB_STORE_ID, blobName, data) : data;
    try {
      await writeFile(blobPath, stored, { flag: 'wx' });
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
      if (!(await this.readBlob(blobName)).equals(data)) {
        throw new OscarAttachmentStoreError('attachment-id-reused', 'Attachment replay bytes changed for the same idempotency key.');
      }
    }
    this.sweepLegacyBlobs();
  }

  private async readBlob(blobName: string): Promise<Buffer> {
    const protection = storeProtection();
    if (protection.mode === 'session') {
      const data = this.sessionBlobs.get(blobName);
      if (!data) throw new OscarAttachmentStoreError('attachment-not-found', 'Attachment bytes are not in this session.');
      return Buffer.from(data);
    }
    const bytes = await readFile(path.join(this.blobRoot, blobName));
    if (!isSealed(bytes)) {
      this.sweepLegacyBlobs();
      return bytes;
    }
    if (!protection.key) throw new StoreProtectionError('sealed-without-key');
    try {
      return openBytes(protection.key, BLOB_STORE_ID, blobName, bytes);
    } catch {
      throw new OscarAttachmentStoreError('attachment-integrity-failed', 'Attachment bytes no longer match the immutable receipt.');
    }
  }

  /** Once per process under sealed protection: plain attachment files from an
   * earlier version are replaced by sealed ones (the plain bytes are gone). */
  private sweepLegacyBlobs(): void {
    const protection = storeProtection();
    if (this.legacySweep || protection.mode !== 'sealed' || !protection.key) return;
    const key = protection.key;
    this.legacySweep = (async () => {
      const entries = await readdir(this.blobRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !/^oscar_attachment_[a-f0-9]{32}\.bin$/u.test(entry.name)) continue;
        const blobPath = path.join(this.blobRoot, entry.name);
        const bytes = await readFile(blobPath).catch(() => null);
        if (!bytes || isSealed(bytes)) continue;
        await writeFileAtomically(blobPath, sealBytes(key, BLOB_STORE_ID, entry.name, bytes)).catch(() => undefined);
      }
    })().catch(() => undefined);
  }

  async put(input: PutOscarAttachmentInput): Promise<OscarAttachmentReceipt> {
    const conversationId = identifier(input.conversationId, 'conversation');
    const source = normalizeSource(input.source);
    const privacyMode = normalizePrivacy(input.privacyMode);
    const mimeType = String(input.mimeType || '').trim().toLowerCase();
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      throw new OscarAttachmentStoreError(
        'unsupported-attachment-type',
        'Only PNG, JPEG, WebP and bounded UTF-8 TXT, Markdown or JSON attachments are supported.',
      );
    }
    const name = normalizeName(input.name);
    const data = decodeBoundedBase64(input.dataBase64);
    assertAttachmentPayload(data, mimeType, name);
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    const idempotencyKey = input.idempotencyKey
      ? identifier(input.idempotencyKey, 'attachment-idempotency-key')
      : '';
    const id = idempotencyKey
      ? deterministicAttachmentId({ conversationId, privacyMode, source, idempotencyKey })
      : `oscar_attachment_${randomUUID().replace(/-/g, '')}`;
    const createdAt = new Date().toISOString();
    const metadata: AttachmentMetadata = {
      id,
      conversationId,
      privacyMode,
      source,
      name,
      mimeType,
      sizeBytes: data.byteLength,
      digest,
      blobName: `${id}.bin`,
      createdAt,
    };
    if (privacyMode !== 'persistent') {
      const existing = this.volatile.get(id);
      if (existing) {
        assertSameAttachment(existing.metadata, metadata);
        if (!existing.data.equals(data)) {
          throw new OscarAttachmentStoreError('attachment-id-reused', 'Attachment replay bytes changed for the same idempotency key.');
        }
        return publicReceipt(existing.metadata);
      }
      this.volatile.set(id, { metadata, data: Buffer.from(data) });
      return publicReceipt(metadata);
    }
    await this.writeBlob(metadata.blobName, data);
    const selected = await this.index.mutate((document) => {
      const existing = document.attachments[id];
      if (existing) {
        assertSameAttachment(existing, metadata);
        return { changed: false, value: existing };
      }
      document.attachments[id] = metadata;
      document.updatedAt = createdAt;
      return { changed: true, value: metadata };
    });
    return publicReceipt(selected);
  }

  async remove(
    idInput: string,
    privacyMode: OscarPrivacyMode,
    source: OscarTurnSource,
    conversationId: string,
  ): Promise<boolean> {
    const id = identifier(idInput, 'attachment');
    const normalizedPrivacy = normalizePrivacy(privacyMode);
    const normalizedSource = normalizeSource(source);
    const normalizedConversation = identifier(conversationId, 'conversation');
    if (normalizedPrivacy !== 'persistent') {
      const existing = this.volatile.get(id);
      if (!existing) return false;
      assertAttachmentBinding(existing.metadata, normalizedPrivacy, normalizedSource, normalizedConversation);
      return this.volatile.delete(id);
    }
    const removed = await this.index.mutate((document) => {
      const existing = document.attachments[id];
      if (!existing) return { changed: false, value: null as AttachmentMetadata | null };
      assertAttachmentBinding(existing, normalizedPrivacy, normalizedSource, normalizedConversation);
      delete document.attachments[id];
      document.updatedAt = new Date().toISOString();
      return { changed: true, value: existing };
    });
    if (!removed) return false;
    await unlink(path.join(this.blobRoot, removed.blobName)).catch((error) => {
      if (!isErrorCode(error, 'ENOENT')) throw error;
    });
    return true;
  }

  async resolve(
    ids: string[],
    privacyMode: OscarPrivacyMode,
    source: OscarTurnSource,
    conversationId: string,
  ): Promise<OscarTurnAttachmentPayload[]> {
    const uniqueIds = [...new Set(ids.map((id) => identifier(id, 'attachment')))];
    if (uniqueIds.length > 3) throw new OscarAttachmentStoreError('too-many-attachments', 'At most three attachments are allowed.');
    const normalizedPrivacy = normalizePrivacy(privacyMode);
    const normalizedSource = normalizeSource(source);
    const normalizedConversation = identifier(conversationId, 'conversation');
    const index = normalizedPrivacy === 'persistent' ? await this.index.read() : null;
    const output: OscarTurnAttachmentPayload[] = [];
    for (const id of uniqueIds) {
      const volatile = this.volatile.get(id);
      const metadata = normalizedPrivacy === 'persistent' ? index?.attachments[id] : volatile?.metadata;
      if (!metadata) throw new OscarAttachmentStoreError('attachment-not-found', `Attachment ${id} was not found.`);
      if (
        metadata.privacyMode !== normalizedPrivacy
        || metadata.source !== normalizedSource
        || metadata.conversationId !== normalizedConversation
      ) {
        throw new OscarAttachmentStoreError('attachment-binding-mismatch', 'Attachment belongs to another conversation, privacy mode, or surface.');
      }
      const data = normalizedPrivacy === 'persistent'
        ? await this.readBlob(metadata.blobName)
        : Buffer.from(volatile!.data);
      const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
      if (data.byteLength !== metadata.sizeBytes || digest !== metadata.digest) {
        throw new OscarAttachmentStoreError('attachment-integrity-failed', 'Attachment bytes no longer match the immutable receipt.');
      }
      output.push({
        id,
        name: metadata.name,
        mimeType: metadata.mimeType,
        sizeBytes: metadata.sizeBytes,
        digest: metadata.digest,
        dataBase64: data.toString('base64'),
      });
    }
    return output;
  }

  async pruneUnreferencedPersistent(
    referencedIdInputs: string[],
    options: { minimumAgeMs?: number; now?: Date } = {},
  ): Promise<OscarAttachmentPruneResult> {
    const referencedIds = new Set(referencedIdInputs.map((id) => identifier(id, 'attachment')));
    const minimumAgeMs = options.minimumAgeMs === undefined ? 24 * 60 * 60 * 1000 : options.minimumAgeMs;
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0 || minimumAgeMs > 365 * 24 * 60 * 60 * 1000) {
      throw new OscarAttachmentStoreError('invalid-attachment-prune-age', 'Invalid attachment prune age.');
    }
    const now = options.now || new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new OscarAttachmentStoreError('invalid-attachment-prune-time', 'Invalid attachment prune time.');
    }
    const cutoff = now.getTime() - minimumAgeMs;
    const removed = await this.index.mutate((document) => {
      const selected: AttachmentMetadata[] = [];
      for (const [id, metadata] of Object.entries(document.attachments)) {
        if (!referencedIds.has(id) && Date.parse(metadata.createdAt) <= cutoff) {
          selected.push(metadata);
          delete document.attachments[id];
        }
      }
      if (selected.length > 0) document.updatedAt = now.toISOString();
      return { changed: selected.length > 0, value: selected };
    });
    for (const metadata of removed) {
      await unlink(path.join(this.blobRoot, metadata.blobName)).catch((error) => {
        if (!isErrorCode(error, 'ENOENT')) throw error;
      });
    }

    const retained = await this.index.read();
    const retainedBlobNames = new Set(Object.values(retained.attachments).map((metadata) => metadata.blobName));
    const entries = await readdir(this.blobRoot, { withFileTypes: true }).catch((error) => {
      if (isErrorCode(error, 'ENOENT')) return [];
      throw error;
    });
    let removedOrphanBlobs = 0;
    for (const entry of entries) {
      if (!entry.isFile()
        || retainedBlobNames.has(entry.name)
        || !/^oscar_attachment_[a-f0-9]{32}\.bin$/u.test(entry.name)) continue;
      const blobPath = path.join(this.blobRoot, entry.name);
      const metadata = await stat(blobPath).catch((error) => {
        if (isErrorCode(error, 'ENOENT')) return null;
        throw error;
      });
      if (!metadata || metadata.mtimeMs > cutoff) continue;
      await unlink(blobPath).catch((error) => {
        if (!isErrorCode(error, 'ENOENT')) throw error;
      });
      removedOrphanBlobs += 1;
    }
    return {
      removedAttachments: removed.length,
      removedBytes: removed.reduce((total, metadata) => total + metadata.sizeBytes, 0),
      removedOrphanBlobs,
    };
  }

  clearVolatile(): void {
    this.volatile.clear();
  }
}

export class OscarAttachmentStoreError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OscarAttachmentStoreError';
    this.code = code;
    this.statusCode = attachmentStatus(code);
  }
}

function emptyIndex(): AttachmentIndex {
  return {
    schemaVersion: ATTACHMENT_INDEX_VERSION,
    attachments: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function assertIndex(value: unknown): asserts value is AttachmentIndex {
  if (!record(value) || value.schemaVersion !== ATTACHMENT_INDEX_VERSION || !record(value.attachments)) {
    throw new OscarAttachmentStoreError('invalid-attachment-index', 'Invalid Oscar attachment index.');
  }
  if (!Number.isFinite(Date.parse(String(value.updatedAt || '')))) {
    throw new OscarAttachmentStoreError('invalid-attachment-index', 'Invalid Oscar attachment index timestamp.');
  }
  for (const [id, candidate] of Object.entries(value.attachments)) {
    if (!record(candidate) || candidate.id !== id) {
      throw new OscarAttachmentStoreError('invalid-attachment-index', 'Invalid Oscar attachment identity.');
    }
    identifier(id, 'attachment');
    identifier(String(candidate.conversationId || ''), 'conversation');
    normalizePrivacy(candidate.privacyMode as OscarPrivacyMode);
    normalizeSource(candidate.source as OscarTurnSource);
    if (!SUPPORTED_MIME_TYPES.has(String(candidate.mimeType || '')) || !/^sha256:[a-f0-9]{64}$/u.test(String(candidate.digest || ''))) {
      throw new OscarAttachmentStoreError('invalid-attachment-index', 'Invalid Oscar attachment metadata.');
    }
    const maximumBytes = isOscarTextAttachmentMimeType(String(candidate.mimeType || ''))
      ? OSCAR_TEXT_ATTACHMENT_MAX_BYTES
      : MAX_ATTACHMENT_BYTES;
    if (!Number.isSafeInteger(candidate.sizeBytes) || Number(candidate.sizeBytes) < 1 || Number(candidate.sizeBytes) > maximumBytes) {
      throw new OscarAttachmentStoreError('invalid-attachment-index', 'Invalid Oscar attachment size.');
    }
  }
}

function decodeBoundedBase64(value: string): Buffer {
  const normalized = String(value || '').replace(/^data:[^,]+,/iu, '').replace(/\s+/g, '');
  if (!normalized || normalized.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    throw new OscarAttachmentStoreError('invalid-attachment-data', 'Attachment must contain bounded valid base64.');
  }
  const data = Buffer.from(normalized, 'base64');
  if (data.byteLength < 1 || data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new OscarAttachmentStoreError('attachment-too-large', 'Attachment exceeds the 8 MiB limit.');
  }
  if (data.toString('base64').replace(/=+$/u, '') !== normalized.replace(/=+$/u, '')) {
    throw new OscarAttachmentStoreError('invalid-attachment-data', 'Attachment base64 is malformed.');
  }
  return data;
}

function assertAttachmentPayload(data: Buffer, mimeType: string, name: string): void {
  if (isOscarTextAttachmentMimeType(mimeType)) {
    if (data.byteLength > OSCAR_TEXT_ATTACHMENT_MAX_BYTES) {
      throw new OscarAttachmentStoreError(
        'attachment-too-large',
        `Text attachment exceeds the ${OSCAR_TEXT_ATTACHMENT_MAX_BYTES}-byte projection limit.`,
      );
    }
    const allowedExtensions = TEXT_EXTENSIONS.get(mimeType)!;
    const extension = /\.([\p{L}\p{N}]{1,16})$/u.exec(name)?.[1]?.toLowerCase() || '';
    if (!allowedExtensions.has(extension)) {
      throw new OscarAttachmentStoreError(
        'attachment-type-extension-mismatch',
        'Text attachment extension does not match the declared MIME type.',
      );
    }
    const text = decodeOscarTextAttachment(data, mimeType);
    if (text.includes('\0')) {
      throw new OscarAttachmentStoreError('attachment-text-nul', 'Text attachment contains a NUL byte.');
    }
    if (mimeType === 'application/json') {
      try {
        JSON.parse(text.replace(/^\uFEFF/u, ''));
      } catch {
        throw new OscarAttachmentStoreError('attachment-json-invalid', 'JSON attachment is not valid JSON.');
      }
    }
    return;
  }
  const png = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const webp = data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP';
  if ((mimeType === 'image/png' && png) || (mimeType === 'image/jpeg' && jpeg) || (mimeType === 'image/webp' && webp)) return;
  throw new OscarAttachmentStoreError('attachment-signature-mismatch', 'Attachment bytes do not match the declared image MIME type.');
}

export function isOscarTextAttachmentMimeType(mimeType: string): boolean {
  return TEXT_MIME_TYPES.has(String(mimeType || '').trim().toLowerCase());
}

export function readOscarTextAttachment(attachment: Pick<OscarTurnAttachmentPayload, 'name' | 'mimeType' | 'dataBase64'>): string {
  const mimeType = String(attachment.mimeType || '').trim().toLowerCase();
  if (!isOscarTextAttachmentMimeType(mimeType)) {
    throw new OscarAttachmentStoreError('attachment-not-text', 'Attachment is not a supported text document.');
  }
  const data = decodeBoundedBase64(attachment.dataBase64);
  if (data.byteLength > OSCAR_TEXT_ATTACHMENT_MAX_BYTES) {
    throw new OscarAttachmentStoreError('attachment-too-large', 'Text attachment exceeds its projection limit.');
  }
  assertAttachmentPayload(data, mimeType, attachment.name);
  return decodeOscarTextAttachment(data, mimeType);
}

function decodeOscarTextAttachment(data: Buffer, mimeType: string): string {
  try {
    return strictUtf8.decode(data);
  } catch {
    throw new OscarAttachmentStoreError(
      'attachment-text-invalid-utf8',
      `${mimeType} attachment must contain strict UTF-8 text.`,
    );
  }
}

function normalizeName(value: string): string {
  const name = String(value || 'attachment').normalize('NFC').trim();
  if (!name || name.length > 120 || /[\\/\u0000-\u001F\u007F]/u.test(name) || name === '.' || name === '..') {
    throw new OscarAttachmentStoreError('invalid-attachment-name', 'Attachment name is invalid.');
  }
  return name;
}

function identifier(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) {
    throw new OscarAttachmentStoreError(`invalid-${label}-id`, `Invalid ${label} id.`);
  }
  return normalized;
}

function normalizePrivacy(value: OscarPrivacyMode): OscarPrivacyMode {
  if (value !== 'persistent' && value !== 'incognito' && value !== 'encrypted') {
    throw new OscarAttachmentStoreError('invalid-privacy-mode', 'Invalid Oscar privacy mode.');
  }
  return value;
}

function normalizeSource(value: OscarTurnSource): OscarTurnSource {
  if (!['desktop', 'voice', 'telegram', 'api', 'coder', 'system'].includes(value)) {
    throw new OscarAttachmentStoreError('invalid-source', 'Invalid Oscar attachment source.');
  }
  return value;
}

function publicReceipt(metadata: AttachmentMetadata): OscarAttachmentReceipt {
  const { blobName: _blobName, ...receipt } = metadata;
  return receipt;
}

function deterministicAttachmentId(input: {
  conversationId: string;
  privacyMode: OscarPrivacyMode;
  source: OscarTurnSource;
  idempotencyKey: string;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['monarch.oscar-attachment.idempotency.v1', input]))
    .digest('hex');
  return `oscar_attachment_${digest.slice(0, 32)}`;
}

function assertSameAttachment(existing: AttachmentMetadata, candidate: AttachmentMetadata): void {
  if (
    existing.id !== candidate.id
    || existing.conversationId !== candidate.conversationId
    || existing.privacyMode !== candidate.privacyMode
    || existing.source !== candidate.source
    || existing.name !== candidate.name
    || existing.mimeType !== candidate.mimeType
    || existing.sizeBytes !== candidate.sizeBytes
    || existing.digest !== candidate.digest
    || existing.blobName !== candidate.blobName
  ) {
    throw new OscarAttachmentStoreError('attachment-id-reused', 'Attachment idempotency key was reused with different metadata or bytes.');
  }
}

function assertAttachmentBinding(
  metadata: AttachmentMetadata,
  privacyMode: OscarPrivacyMode,
  source: OscarTurnSource,
  conversationId: string,
): void {
  if (metadata.privacyMode !== privacyMode || metadata.source !== source || metadata.conversationId !== conversationId) {
    throw new OscarAttachmentStoreError('attachment-binding-mismatch', 'Attachment belongs to another conversation, privacy mode, or surface.');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code);
}

function attachmentStatus(code: string): number {
  if (code === 'attachment-not-found') return 404;
  if (/reused|binding-mismatch/u.test(code)) return 409;
  if (code === 'attachment-too-large') return 413;
  if (/integrity|index/u.test(code)) return 500;
  return 400;
}
