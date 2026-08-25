import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DurableJsonFile } from '../core/durable-json-file';
import type { OscarPrivacyMode, OscarTurnSource } from './types';
import type { OscarTurnAttachmentPayload } from './coordinator';

const ATTACHMENT_INDEX_VERSION = 'monarch.oscar-attachment-store.v1' as const;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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
}

export interface OscarAttachmentReceipt extends Omit<AttachmentMetadata, 'blobName'> {}

export class OscarAttachmentStore {
  private readonly root: string;
  private readonly blobRoot: string;
  private readonly index: DurableJsonFile<AttachmentIndex>;
  private readonly volatile = new Map<string, { metadata: AttachmentMetadata; data: Buffer }>();

  constructor(stateRoot: string) {
    this.root = path.resolve(stateRoot, 'oscar', 'attachments');
    this.blobRoot = path.join(this.root, 'blobs');
    this.index = new DurableJsonFile(path.join(this.root, 'index.v1.json'), {
      createEmpty: emptyIndex,
      validate: assertIndex,
    });
  }

  async put(input: PutOscarAttachmentInput): Promise<OscarAttachmentReceipt> {
    const conversationId = identifier(input.conversationId, 'conversation');
    const source = normalizeSource(input.source);
    const privacyMode = normalizePrivacy(input.privacyMode);
    const mimeType = String(input.mimeType || '').trim().toLowerCase();
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      throw new OscarAttachmentStoreError('unsupported-attachment-type', 'Only PNG, JPEG and WebP images are supported.');
    }
    const name = normalizeName(input.name);
    const data = decodeBoundedBase64(input.dataBase64);
    assertImageSignature(data, mimeType);
    const id = `oscar_attachment_${randomUUID().replace(/-/g, '')}`;
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
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
      this.volatile.set(id, { metadata, data: Buffer.from(data) });
      return publicReceipt(metadata);
    }
    await mkdir(this.blobRoot, { recursive: true });
    await writeFile(path.join(this.blobRoot, metadata.blobName), data, { flag: 'wx' });
    await this.index.mutate((document) => {
      if (document.attachments[id]) {
        throw new OscarAttachmentStoreError('attachment-id-reused', 'Attachment id already exists.');
      }
      document.attachments[id] = metadata;
      document.updatedAt = createdAt;
      return { changed: true, value: undefined };
    });
    return publicReceipt(metadata);
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
        ? await readFile(path.join(this.blobRoot, metadata.blobName))
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
    if (!Number.isSafeInteger(candidate.sizeBytes) || Number(candidate.sizeBytes) < 1 || Number(candidate.sizeBytes) > MAX_ATTACHMENT_BYTES) {
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

function assertImageSignature(data: Buffer, mimeType: string): void {
  const png = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const webp = data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP';
  if ((mimeType === 'image/png' && png) || (mimeType === 'image/jpeg' && jpeg) || (mimeType === 'image/webp' && webp)) return;
  throw new OscarAttachmentStoreError('attachment-signature-mismatch', 'Attachment bytes do not match the declared image MIME type.');
}

function normalizeName(value: string): string {
  const name = String(value || 'image').replace(/[\u0000-\u001F\u007F]/gu, '').trim().slice(0, 120);
  return name || 'image';
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

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function attachmentStatus(code: string): number {
  if (code === 'attachment-not-found') return 404;
  if (/reused|binding-mismatch/u.test(code)) return 409;
  if (code === 'attachment-too-large') return 413;
  if (/integrity|index/u.test(code)) return 500;
  return 400;
}
