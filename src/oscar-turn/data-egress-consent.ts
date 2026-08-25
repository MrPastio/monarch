import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DurableJsonFile } from '../core/durable-json-file';
import type { OscarPrivacyMode, OscarTurnSource } from './types';

export const OSCAR_DATA_EGRESS_CONSENT_VERSION = 'monarch.oscar-data-egress-consent.v1' as const;
const STORE_VERSION = 'monarch.oscar-data-egress-consent-store.v1' as const;
const CONSENT_TTL_MS = 5 * 60 * 1_000;

export interface OscarDataEgressBindingInput {
  conversationId: string;
  privacyMode: OscarPrivacyMode;
  source: OscarTurnSource;
  text: string;
  attachmentIds: string[];
  webSearch: boolean;
  researchMode: 'auto' | 'off' | 'deep';
}

export interface OscarDataEgressConsentV1 {
  schemaVersion: typeof OSCAR_DATA_EGRESS_CONSENT_VERSION;
  id: string;
  clientRequestId: string;
  conversationId: string;
  privacyMode: OscarPrivacyMode;
  source: OscarTurnSource;
  purpose: 'web-search' | 'deep-research';
  requestDigest: string;
  attachmentCount: number;
  canonicalBindingHash: string;
  status: 'pending' | 'granted' | 'denied' | 'consumed' | 'expired';
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  consumedByTurnId?: string;
}

interface ConsentDocument {
  schemaVersion: typeof STORE_VERSION;
  consents: Record<string, OscarDataEgressConsentV1>;
  clientRequests: Record<string, { fingerprint: string; consentId: string }>;
  updatedAt: string;
}

export class OscarDataEgressConsentStore {
  private readonly persistent: DurableJsonFile<ConsentDocument>;
  private readonly volatile: ConsentDocument = emptyDocument();
  private volatileQueue: Promise<void> = Promise.resolve();

  constructor(stateRoot: string) {
    this.persistent = new DurableJsonFile(path.resolve(stateRoot, 'oscar', 'data-egress-consents.v1.json'), {
      createEmpty: emptyDocument,
      validate: assertDocument,
    });
  }

  async createProposal(
    clientRequestIdInput: string,
    bindingInput: OscarDataEgressBindingInput,
  ): Promise<OscarDataEgressConsentV1> {
    const clientRequestId = identifier(clientRequestIdInput, 'client request');
    const binding = normalizeBinding(bindingInput);
    if (!requiresConsent(binding)) {
      throw new OscarDataEgressConsentError(400, 'egress-not-requested', 'Web or deep research must be requested for data-egress consent.');
    }
    const fingerprint = bindingHash(binding);
    return this.mutate(binding.privacyMode, (document) => {
      const existingRequest = document.clientRequests[clientRequestId];
      if (existingRequest) {
        if (existingRequest.fingerprint !== fingerprint) {
          throw new OscarDataEgressConsentError(409, 'consent-request-reused', 'Consent clientRequestId is bound to another request.');
        }
        const existing = document.consents[existingRequest.consentId];
        if (!existing) throw new OscarDataEgressConsentError(500, 'consent-store-corrupt', 'Consent idempotency record is orphaned.');
        return { changed: false, value: expireIfNeeded(existing) };
      }
      const now = new Date();
      const consent: OscarDataEgressConsentV1 = {
        schemaVersion: OSCAR_DATA_EGRESS_CONSENT_VERSION,
        id: `oscar_egress_${randomUUID().replace(/-/g, '')}`,
        clientRequestId,
        conversationId: binding.conversationId,
        privacyMode: binding.privacyMode,
        source: binding.source,
        purpose: binding.researchMode === 'deep' ? 'deep-research' : 'web-search',
        requestDigest: requestDigest(binding),
        attachmentCount: binding.attachmentIds.length,
        canonicalBindingHash: fingerprint,
        status: 'pending',
        expiresAt: new Date(now.getTime() + CONSENT_TTL_MS).toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      document.consents[consent.id] = consent;
      document.clientRequests[clientRequestId] = { fingerprint, consentId: consent.id };
      document.updatedAt = consent.updatedAt;
      return { changed: true, value: consent };
    });
  }

  async decide(input: {
    consentId: string;
    source: OscarTurnSource;
    canonicalBindingHash: string;
    decision: 'grant' | 'deny';
  }): Promise<OscarDataEgressConsentV1> {
    const consentId = identifier(input.consentId, 'consent');
    const source = normalizeSource(input.source);
    const hash = normalizeHash(input.canonicalBindingHash);
    const privacy = await this.findPrivacy(consentId);
    if (!privacy) throw new OscarDataEgressConsentError(404, 'consent-not-found', 'Data-egress consent was not found.');
    return this.mutate(privacy, (document) => {
      const current = document.consents[consentId];
      if (!current) throw new OscarDataEgressConsentError(404, 'consent-not-found', 'Data-egress consent was not found.');
      const active = expireIfNeeded(current);
      if (active.source !== source) throw new OscarDataEgressConsentError(403, 'consent-source-mismatch', 'Consent belongs to another surface.');
      if (active.canonicalBindingHash !== hash) throw new OscarDataEgressConsentError(409, 'stale-consent-binding', 'Consent binding is stale.');
      if (active.status === 'expired') {
        document.consents[consentId] = active;
        document.updatedAt = active.updatedAt;
        throw new OscarDataEgressConsentError(410, 'consent-expired', 'Data-egress consent expired.');
      }
      const requestedStatus = input.decision === 'grant' ? 'granted' as const : 'denied' as const;
      if (active.status === requestedStatus) {
        return { changed: false, value: active };
      }
      // Stop may race a grant response that already reached the local server.
      // A granted-but-unconsumed proposal remains revocable; consumed authority
      // is immutable and continues to be bound to its exact Turn receipt.
      const revokingUnusedGrant = input.decision === 'deny' && active.status === 'granted';
      if (active.status !== 'pending' && !revokingUnusedGrant) {
        throw new OscarDataEgressConsentError(409, 'consent-already-decided', 'Data-egress consent was already decided.');
      }
      const now = new Date().toISOString();
      const next = { ...active, status: requestedStatus, updatedAt: now };
      document.consents[consentId] = next;
      document.updatedAt = now;
      return { changed: true, value: next };
    });
  }

  async consume(
    consentIdInput: string,
    turnIdInput: string,
    bindingInput: OscarDataEgressBindingInput,
  ): Promise<OscarDataEgressConsentV1> {
    const consentId = identifier(consentIdInput, 'consent');
    const turnId = identifier(turnIdInput, 'turn');
    const binding = normalizeBinding(bindingInput);
    const expectedHash = bindingHash(binding);
    return this.mutate(binding.privacyMode, (document) => {
      const current = document.consents[consentId];
      if (!current) throw new OscarDataEgressConsentError(404, 'consent-not-found', 'Data-egress consent was not found.');
      const active = expireIfNeeded(current);
      if (active.source !== binding.source || active.conversationId !== binding.conversationId) {
        throw new OscarDataEgressConsentError(403, 'consent-binding-mismatch', 'Consent belongs to another conversation or surface.');
      }
      if (active.canonicalBindingHash !== expectedHash) {
        throw new OscarDataEgressConsentError(409, 'stale-consent-binding', 'Turn data differs from the approved egress binding.');
      }
      if (active.status === 'consumed' && active.consumedByTurnId === turnId) return { changed: false, value: active };
      if (active.status === 'expired') {
        document.consents[consentId] = active;
        document.updatedAt = active.updatedAt;
        throw new OscarDataEgressConsentError(410, 'consent-expired', 'Data-egress consent expired.');
      }
      if (active.status !== 'granted') {
        throw new OscarDataEgressConsentError(409, 'consent-not-granted', 'Data-egress consent was not granted for this Turn.');
      }
      const now = new Date().toISOString();
      const consumed = { ...active, status: 'consumed' as const, consumedByTurnId: turnId, updatedAt: now };
      document.consents[consentId] = consumed;
      document.updatedAt = now;
      return { changed: true, value: consumed };
    });
  }

  clearVolatile(): void {
    this.volatile.consents = {};
    this.volatile.clientRequests = {};
    this.volatile.updatedAt = new Date().toISOString();
  }

  private async findPrivacy(consentId: string): Promise<OscarPrivacyMode | null> {
    if (this.volatile.consents[consentId]) return this.volatile.consents[consentId].privacyMode;
    const persistent = await this.persistent.read();
    return persistent.consents[consentId]?.privacyMode || null;
  }

  private mutate<R>(
    privacyMode: OscarPrivacyMode,
    mutator: (document: ConsentDocument) => { changed: boolean; value: R },
  ): Promise<R> {
    if (privacyMode === 'persistent') return this.persistent.mutate(mutator);
    const operation = this.volatileQueue.then(() => {
      const result = mutator(this.volatile);
      assertDocument(this.volatile);
      return clone(result.value);
    });
    this.volatileQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export class OscarDataEgressConsentError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'OscarDataEgressConsentError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeBinding(input: OscarDataEgressBindingInput): OscarDataEgressBindingInput {
  const privacyMode = normalizePrivacy(input.privacyMode);
  return {
    conversationId: identifier(input.conversationId, 'conversation'),
    privacyMode,
    source: normalizeSource(input.source),
    text: String(input.text || '').replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 20_000),
    attachmentIds: [...new Set((input.attachmentIds || []).map((id) => identifier(id, 'attachment')))].slice(0, 3).sort(),
    webSearch: input.webSearch === true,
    researchMode: input.researchMode === 'deep' ? 'deep' : input.researchMode === 'off' ? 'off' : 'auto',
  };
}

function requiresConsent(binding: OscarDataEgressBindingInput): boolean {
  return binding.webSearch || binding.researchMode === 'deep';
}

function bindingHash(binding: OscarDataEgressBindingInput): string {
  return `sha256:${createHash('sha256').update(stableJson({
    conversationId: binding.conversationId,
    privacyMode: binding.privacyMode,
    source: binding.source,
    requestDigest: requestDigest(binding),
    attachmentIds: binding.attachmentIds,
    webSearch: binding.webSearch,
    researchMode: binding.researchMode,
  }), 'utf8').digest('hex')}`;
}

function requestDigest(binding: OscarDataEgressBindingInput): string {
  return `sha256:${createHash('sha256').update(binding.text, 'utf8').digest('hex')}`;
}

function expireIfNeeded(consent: OscarDataEgressConsentV1): OscarDataEgressConsentV1 {
  if ((consent.status === 'pending' || consent.status === 'granted') && Date.parse(consent.expiresAt) <= Date.now()) {
    return { ...consent, status: 'expired', updatedAt: new Date().toISOString() };
  }
  return consent;
}

function emptyDocument(): ConsentDocument {
  return { schemaVersion: STORE_VERSION, consents: {}, clientRequests: {}, updatedAt: new Date(0).toISOString() };
}

function assertDocument(value: unknown): asserts value is ConsentDocument {
  if (!record(value) || value.schemaVersion !== STORE_VERSION || !record(value.consents) || !record(value.clientRequests)) {
    throw new OscarDataEgressConsentError(500, 'invalid-consent-store', 'Invalid data-egress consent store.');
  }
  for (const [id, consent] of Object.entries(value.consents)) {
    if (!record(consent) || consent.id !== id || consent.schemaVersion !== OSCAR_DATA_EGRESS_CONSENT_VERSION) {
      throw new OscarDataEgressConsentError(500, 'invalid-consent-store', 'Invalid data-egress consent record.');
    }
    identifier(id, 'consent');
    normalizePrivacy(consent.privacyMode as OscarPrivacyMode);
    normalizeSource(consent.source as OscarTurnSource);
    normalizeHash(String(consent.canonicalBindingHash || ''));
    if (!Number.isFinite(Date.parse(String(consent.expiresAt || '')))) {
      throw new OscarDataEgressConsentError(500, 'invalid-consent-store', 'Invalid data-egress expiry.');
    }
  }
}

function identifier(value: string, label: string): string {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) {
    throw new OscarDataEgressConsentError(400, `invalid-${label}-id`, `Invalid ${label} id.`);
  }
  return id;
}

function normalizeHash(value: string): string {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) {
    throw new OscarDataEgressConsentError(400, 'invalid-consent-hash', 'Invalid data-egress binding hash.');
  }
  return hash;
}

function normalizePrivacy(value: OscarPrivacyMode): OscarPrivacyMode {
  if (value !== 'persistent' && value !== 'incognito' && value !== 'encrypted') {
    throw new OscarDataEgressConsentError(400, 'invalid-privacy-mode', 'Invalid Oscar privacy mode.');
  }
  return value;
}

function normalizeSource(value: OscarTurnSource): OscarTurnSource {
  if (!['desktop', 'voice', 'telegram', 'api', 'coder', 'system'].includes(value)) {
    throw new OscarDataEgressConsentError(400, 'invalid-source', 'Invalid Oscar source.');
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
