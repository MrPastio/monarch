import { createHash, createPublicKey, verify } from 'node:crypto';
import type { MonarchAuthorityContext } from '../core/contracts';

export interface OwnerEntitlementV1 {
  schemaVersion: 1;
  entitlementId: string;
  tier: 'owner';
  devicePublicKeySha256: string;
  issuedAt: string;
  expiresAt: string | null;
  keyId: string;
  signature: string;
}

export interface OwnerSessionProofV1 {
  schemaVersion: 1;
  entitlementId: string;
  sessionNonce: string;
  desktopAttestationSha256: string;
  runtimePort: number;
  issuedAt: string;
  expiresAt: string;
}

export interface OwnerAuthorityEnvelopeV1 {
  schemaVersion: 1;
  entitlement: OwnerEntitlementV1;
  devicePublicKeySpkiBase64: string;
  proof: OwnerSessionProofV1;
  proofSignature: string;
}

export interface OwnerAuthorityPublicKey {
  keyId: string;
  publicKeySpkiBase64: string;
}

export const MONARCH_OWNER_PUBLIC_KEYS: readonly OwnerAuthorityPublicKey[] = Object.freeze([
  Object.freeze({
    keyId: 'owner-root-2026-01',
    publicKeySpkiBase64: 'MCowBQYDK2VwAyEAyNKmYUz+hxz68D5Kcy+CyS2WJSMQ0oDRu6MdXw6luJ0=',
  }),
]);

export function publicAuthorityContext(diagnostic = 'owner-entitlement-absent'): MonarchAuthorityContext {
  return Object.freeze({
    tier: 'public',
    source: 'default',
    entitlementId: null,
    keyId: null,
    verifiedAt: null,
    deviceIdPrefix: null,
    diagnostic,
  });
}

export function resolveOwnerAuthorityFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    now?: Date;
    publicKeys?: readonly OwnerAuthorityPublicKey[];
  } = {},
): MonarchAuthorityContext {
  const encoded = String(env.MONARCH_OWNER_AUTHORITY_ENVELOPE || '').trim();
  if (!encoded) return publicAuthorityContext();
  if (encoded.length > 96 * 1024) return publicAuthorityContext('owner-envelope-too-large');
  try {
    const json = decodeBase64UrlText(encoded);
    const envelope = JSON.parse(json) as unknown;
    return verifyOwnerAuthorityEnvelope(envelope, {
      desktopAttestationToken: String(env.MONARCH_DESKTOP_ATTESTATION_TOKEN || ''),
      runtimePort: Number(env.MONARCH_UI_PORT || 0),
      ...(options.now ? { now: options.now } : {}),
      ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}),
    });
  } catch {
    return publicAuthorityContext('owner-envelope-invalid');
  }
}

export function verifyOwnerAuthorityEnvelope(
  value: unknown,
  options: {
    desktopAttestationToken: string;
    runtimePort: number;
    now?: Date;
    publicKeys?: readonly OwnerAuthorityPublicKey[];
  },
): MonarchAuthorityContext {
  const now = options.now || new Date();
  try {
    const envelope = readEnvelope(value);
    const entitlement = envelope.entitlement;
    const proof = envelope.proof;
    const vendor = (options.publicKeys || MONARCH_OWNER_PUBLIC_KEYS)
      .find((entry) => entry.keyId === entitlement.keyId && entry.publicKeySpkiBase64);
    if (!vendor) return publicAuthorityContext('owner-signing-key-unknown');

    const deviceDer = decodeBase64(envelope.devicePublicKeySpkiBase64, 4 * 1024);
    const deviceFingerprint = createHash('sha256').update(deviceDer).digest('hex');
    if (deviceFingerprint !== entitlement.devicePublicKeySha256) {
      return publicAuthorityContext('owner-device-mismatch');
    }
    const vendorKey = createPublicKey({
      key: decodeBase64(vendor.publicKeySpkiBase64, 4 * 1024),
      format: 'der',
      type: 'spki',
    });
    if (!verify(null, canonicalBytes(entitlementUnsigned(entitlement)), vendorKey, decodeBase64(entitlement.signature, 4 * 1024))) {
      return publicAuthorityContext('owner-entitlement-signature-invalid');
    }

    const entitlementIssuedAt = parseIso(entitlement.issuedAt);
    const entitlementExpiresAt = entitlement.expiresAt === null ? null : parseIso(entitlement.expiresAt);
    if (entitlementIssuedAt > now.getTime() + 5 * 60 * 1000) {
      return publicAuthorityContext('owner-entitlement-not-yet-valid');
    }
    if (entitlementExpiresAt !== null && entitlementExpiresAt <= now.getTime()) {
      return publicAuthorityContext('owner-entitlement-expired');
    }

    if (!options.desktopAttestationToken || !Number.isSafeInteger(options.runtimePort) || options.runtimePort < 1) {
      return publicAuthorityContext('owner-desktop-proof-missing');
    }
    if (proof.entitlementId !== entitlement.entitlementId) {
      return publicAuthorityContext('owner-proof-entitlement-mismatch');
    }
    if (proof.runtimePort !== options.runtimePort) {
      return publicAuthorityContext('owner-proof-runtime-mismatch');
    }
    const attestationHash = createHash('sha256').update(options.desktopAttestationToken, 'utf8').digest('hex');
    if (proof.desktopAttestationSha256 !== attestationHash) {
      return publicAuthorityContext('owner-proof-session-mismatch');
    }
    const proofIssuedAt = parseIso(proof.issuedAt);
    const proofExpiresAt = parseIso(proof.expiresAt);
    if (proofIssuedAt > now.getTime() + 60_000
      || proofExpiresAt <= now.getTime()
      || proofExpiresAt - proofIssuedAt > 5 * 60 * 1000
      || now.getTime() - proofIssuedAt > 5 * 60 * 1000) {
      return publicAuthorityContext('owner-proof-expired');
    }
    const deviceKey = createPublicKey({ key: deviceDer, format: 'der', type: 'spki' });
    if (!verify(null, canonicalBytes(proof), deviceKey, decodeBase64(envelope.proofSignature, 4 * 1024))) {
      return publicAuthorityContext('owner-proof-signature-invalid');
    }

    return Object.freeze({
      tier: 'owner',
      source: 'signed-device-entitlement',
      entitlementId: entitlement.entitlementId,
      keyId: entitlement.keyId,
      verifiedAt: now.toISOString(),
      deviceIdPrefix: deviceFingerprint.slice(0, 12),
      diagnostic: null,
    });
  } catch {
    return publicAuthorityContext('owner-envelope-invalid');
  }
}

export function canonicalOwnerAuthorityBytes(value: unknown): Buffer {
  return canonicalBytes(value);
}

function readEnvelope(value: unknown): OwnerAuthorityEnvelopeV1 {
  const envelope = objectWithKeys(value, [
    'schemaVersion', 'entitlement', 'devicePublicKeySpkiBase64', 'proof', 'proofSignature',
  ]);
  if (envelope.schemaVersion !== 1) throw new Error('schema');
  const entitlement = objectWithKeys(envelope.entitlement, [
    'schemaVersion', 'entitlementId', 'tier', 'devicePublicKeySha256', 'issuedAt', 'expiresAt', 'keyId', 'signature',
  ]);
  const proof = objectWithKeys(envelope.proof, [
    'schemaVersion', 'entitlementId', 'sessionNonce', 'desktopAttestationSha256', 'runtimePort', 'issuedAt', 'expiresAt',
  ]);
  if (entitlement.schemaVersion !== 1 || entitlement.tier !== 'owner') throw new Error('entitlement');
  if (proof.schemaVersion !== 1) throw new Error('proof');
  const normalizedEntitlement: OwnerEntitlementV1 = {
    schemaVersion: 1,
    entitlementId: identifier(entitlement.entitlementId, 'entitlementId'),
    tier: 'owner',
    devicePublicKeySha256: sha256Hex(entitlement.devicePublicKeySha256),
    issuedAt: isoString(entitlement.issuedAt),
    expiresAt: entitlement.expiresAt === null ? null : isoString(entitlement.expiresAt),
    keyId: identifier(entitlement.keyId, 'keyId'),
    signature: boundedString(entitlement.signature, 4 * 1024),
  };
  const normalizedProof: OwnerSessionProofV1 = {
    schemaVersion: 1,
    entitlementId: identifier(proof.entitlementId, 'proof.entitlementId'),
    sessionNonce: identifier(proof.sessionNonce, 'sessionNonce'),
    desktopAttestationSha256: sha256Hex(proof.desktopAttestationSha256),
    runtimePort: safePort(proof.runtimePort),
    issuedAt: isoString(proof.issuedAt),
    expiresAt: isoString(proof.expiresAt),
  };
  return {
    schemaVersion: 1,
    entitlement: normalizedEntitlement,
    devicePublicKeySpkiBase64: boundedString(envelope.devicePublicKeySpkiBase64, 8 * 1024),
    proof: normalizedProof,
    proofSignature: boundedString(envelope.proofSignature, 4 * 1024),
  };
}

function entitlementUnsigned(entitlement: OwnerEntitlementV1): Omit<OwnerEntitlementV1, 'signature'> {
  const { signature: _signature, ...unsigned } = entitlement;
  return unsigned;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(stableJson(value), 'utf8');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function objectWithKeys(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error('unknown-field');
  return record;
}

function boundedString(value: unknown, maximum: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum) throw new Error('string');
  return text;
}

function identifier(value: unknown, label: string): string {
  const text = boundedString(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)) throw new Error(label);
  return text;
}

function sha256Hex(value: unknown): string {
  const text = boundedString(value, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error('sha256');
  return text;
}

function isoString(value: unknown): string {
  const text = boundedString(value, 64);
  parseIso(text);
  return text;
}

function parseIso(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('timestamp');
  return parsed;
}

function safePort(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('port');
  return Number(value);
}

function decodeBase64(value: string, maximum: number): Buffer {
  const normalized = boundedString(value, maximum).replace(/\s+/gu, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) throw new Error('base64');
  const decoded = Buffer.from(normalized, 'base64');
  if (!decoded.length || decoded.byteLength > maximum) throw new Error('base64-size');
  return decoded;
}

function decodeBase64UrlText(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('base64url');
  return Buffer.from(value, 'base64url').toString('utf8');
}
