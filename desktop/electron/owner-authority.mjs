import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const PRIVATE_KEY_FILE = 'device-private-key.dpapi';
const PUBLIC_KEY_FILE = 'device-public-key.spki';
const DEVICE_REQUEST_FILE = 'device-request.json';
const ENTITLEMENT_FILE = 'owner-entitlement.json';
const OWNER_SUSPENDED_FILE = 'owner-mode-suspended.json';
const execFileAsync = promisify(execFile);

export const MONARCH_OWNER_PUBLIC_KEYS = Object.freeze([
  Object.freeze({
    keyId: 'owner-root-2026-01',
    publicKeySpkiBase64: 'MCowBQYDK2VwAyEAyNKmYUz+hxz68D5Kcy+CyS2WJSMQ0oDRu6MdXw6luJ0=',
  }),
]);

export async function prepareOwnerAuthoritySession({
  authorityRoot,
  safeStorage,
  desktopAttestationToken,
  runtimePort,
  now = new Date(),
  randomBytesFactory = randomBytes,
  restrictAcl = restrictOwnerAuthorityAcl,
  publicKeys = MONARCH_OWNER_PUBLIC_KEYS,
}) {
  if (await isOwnerModeSuspended(authorityRoot)) {
    return { environmentValue: '', summary: publicSummary('owner-mode-suspended', null) };
  }
  const identity = await loadOrCreateOwnerDeviceIdentity({ authorityRoot, safeStorage, now, restrictAcl });
  if (identity.status !== 'ready') return { environmentValue: '', summary: identity.summary };
  const entitlementPath = path.join(identity.authorityRoot, ENTITLEMENT_FILE);
  if (!await isRegularFile(entitlementPath)) {
    return { environmentValue: '', summary: publicSummary('owner-entitlement-absent', identity.deviceIdPrefix) };
  }
  let entitlement;
  try {
    const bytes = await readFile(entitlementPath);
    if (bytes.byteLength > 64 * 1024) throw new Error('large');
    entitlement = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { environmentValue: '', summary: publicSummary('owner-entitlement-invalid', identity.deviceIdPrefix) };
  }
  const validation = validateOwnerEntitlement(entitlement, {
    devicePublicKeySha256: createHash('sha256').update(identity.publicKeyDer).digest('hex'),
    now,
    publicKeys,
  });
  if (!validation.ok) {
    return { environmentValue: '', summary: publicSummary(validation.diagnostic, identity.deviceIdPrefix) };
  }
  entitlement = validation.entitlement;
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  const proof = {
    schemaVersion: 1,
    entitlementId: String(entitlement?.entitlementId || ''),
    sessionNonce: randomBytesFactory(24).toString('base64url'),
    desktopAttestationSha256: createHash('sha256').update(String(desktopAttestationToken || ''), 'utf8').digest('hex'),
    runtimePort,
    issuedAt,
    expiresAt,
  };
  const envelope = {
    schemaVersion: 1,
    entitlement,
    devicePublicKeySpkiBase64: identity.publicKeyDer.toString('base64'),
    proof,
    proofSignature: sign(null, canonicalBytes(proof), identity.privateKey).toString('base64'),
  };
  return {
    environmentValue: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url'),
    summary: publicSummary('owner-proof-created', identity.deviceIdPrefix),
  };
}

export async function isOwnerModeSuspended(authorityRoot) {
  if (!path.isAbsolute(authorityRoot)) return false;
  return isRegularFile(path.join(path.resolve(authorityRoot), OWNER_SUSPENDED_FILE));
}

export async function setOwnerModeSuspended({ authorityRoot, suspended, now = new Date(), restrictAcl = restrictOwnerAuthorityAcl }) {
  if (!path.isAbsolute(authorityRoot)) return { ok: false, diagnostic: 'owner-authority-root-invalid' };
  const root = path.resolve(authorityRoot);
  const marker = path.join(root, OWNER_SUSPENDED_FILE);
  await mkdir(root, { recursive: true });
  if (suspended) {
    await writeFile(marker, `${JSON.stringify({ schemaVersion: 1, suspendedAt: now.toISOString() })}\n`, { mode: 0o600 });
  } else {
    await rm(marker, { force: true });
  }
  if (!await restrictAcl(root)) return { ok: false, diagnostic: 'owner-authority-acl-failed' };
  return { ok: true, suspended: suspended === true };
}

export async function loadOrCreateOwnerDeviceIdentity({
  authorityRoot,
  safeStorage,
  now = new Date(),
  restrictAcl = restrictOwnerAuthorityAcl,
}) {
  if (!path.isAbsolute(authorityRoot)) return failedIdentity('owner-authority-root-invalid');
  if (!safeStorage?.isEncryptionAvailable?.()) return failedIdentity('owner-device-encryption-unavailable');
  const resolvedRoot = path.resolve(authorityRoot);
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const privatePath = path.join(resolvedRoot, PRIVATE_KEY_FILE);
  const publicPath = path.join(resolvedRoot, PUBLIC_KEY_FILE);
  const privateExists = await isRegularFile(privatePath);
  const publicExists = await isRegularFile(publicPath);
  if (privateExists !== publicExists) return failedIdentity('owner-device-key-partial', resolvedRoot);

  if (!privateExists) {
    try {
      const generated = generateKeyPairSync('ed25519');
      const privateDer = generated.privateKey.export({ format: 'der', type: 'pkcs8' });
      const publicDer = generated.publicKey.export({ format: 'der', type: 'spki' });
      const encrypted = safeStorage.encryptString(Buffer.from(privateDer).toString('base64'));
      await writeFile(privatePath, encrypted, { flag: 'wx', mode: 0o600 });
      await writeFile(publicPath, Buffer.from(publicDer).toString('base64'), { flag: 'wx', mode: 0o600 });
    } catch {
      return failedIdentity('owner-device-key-create-failed', resolvedRoot);
    }
  }

  try {
    const [encrypted, publicText] = await Promise.all([readFile(privatePath), readFile(publicPath, 'utf8')]);
    if (encrypted.byteLength > 16 * 1024 || publicText.length > 8 * 1024) throw new Error('large');
    const privateDer = decodeBase64(safeStorage.decryptString(encrypted), 8 * 1024);
    const publicDer = decodeBase64(publicText, 4 * 1024);
    const privateKey = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
    const derivedPublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    if (!Buffer.from(derivedPublic).equals(publicDer)) throw new Error('pair');
    const probe = Buffer.from('monarch-owner-device-key-probe', 'utf8');
    const probeSignature = sign(null, probe, privateKey);
    if (!verify(null, probe, publicKey, probeSignature)) throw new Error('key');
    const fingerprint = createHash('sha256').update(publicDer).digest('hex');
    const request = {
      schemaVersion: 1,
      devicePublicKeySpkiBase64: publicDer.toString('base64'),
      devicePublicKeySha256: fingerprint,
      createdAt: now.toISOString(),
    };
    await writeFile(path.join(resolvedRoot, DEVICE_REQUEST_FILE), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    await Promise.all([
      process.platform === 'win32' ? Promise.resolve() : chmod(privatePath, 0o600).catch(() => undefined),
      process.platform === 'win32' ? Promise.resolve() : chmod(publicPath, 0o600).catch(() => undefined),
    ]);
    if (!await restrictAcl(resolvedRoot)) {
      return failedIdentity('owner-authority-acl-failed', resolvedRoot);
    }
    return {
      status: 'ready',
      authorityRoot: resolvedRoot,
      privateKey,
      publicKey,
      publicKeyDer: publicDer,
      deviceIdPrefix: fingerprint.slice(0, 12),
      summary: publicSummary('owner-device-ready', fingerprint.slice(0, 12)),
    };
  } catch {
    return failedIdentity('owner-device-key-corrupt', resolvedRoot);
  }
}

export function ownerAuthorityPaths(authorityRoot) {
  const root = path.resolve(authorityRoot);
  return Object.freeze({
    authorityRoot: root,
    privateKeyPath: path.join(root, PRIVATE_KEY_FILE),
    publicKeyPath: path.join(root, PUBLIC_KEY_FILE),
    deviceRequestPath: path.join(root, DEVICE_REQUEST_FILE),
    entitlementPath: path.join(root, ENTITLEMENT_FILE),
  });
}

export function validateOwnerEntitlement(value, {
  devicePublicKeySha256,
  now = new Date(),
  publicKeys = MONARCH_OWNER_PUBLIC_KEYS,
} = {}) {
  try {
    const entitlement = normalizeOwnerEntitlement(value);
    const vendor = publicKeys.find((entry) => entry?.keyId === entitlement.keyId && entry.publicKeySpkiBase64);
    if (!vendor) return { ok: false, diagnostic: 'owner-signing-key-unknown' };
    const vendorKey = createPublicKey({
      key: decodeBase64(vendor.publicKeySpkiBase64, 4 * 1024),
      format: 'der',
      type: 'spki',
    });
    const signature = decodeBase64(entitlement.signature, 4 * 1024);
    const { signature: _signature, ...unsigned } = entitlement;
    if (!verify(null, canonicalBytes(unsigned), vendorKey, signature)) {
      return { ok: false, diagnostic: 'owner-entitlement-signature-invalid' };
    }
    const issuedAt = parseIsoTimestamp(entitlement.issuedAt);
    const expiresAt = entitlement.expiresAt === null ? null : parseIsoTimestamp(entitlement.expiresAt);
    if (issuedAt > now.getTime() + 5 * 60 * 1000) {
      return { ok: false, diagnostic: 'owner-entitlement-not-yet-valid' };
    }
    if (expiresAt !== null && expiresAt <= now.getTime()) {
      return { ok: false, diagnostic: 'owner-entitlement-expired' };
    }
    const fingerprint = String(devicePublicKeySha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(fingerprint) || fingerprint !== entitlement.devicePublicKeySha256) {
      return { ok: false, diagnostic: 'owner-device-mismatch' };
    }
    return { ok: true, diagnostic: null, entitlement: Object.freeze(entitlement) };
  } catch {
    return { ok: false, diagnostic: 'owner-entitlement-invalid' };
  }
}

export async function restrictOwnerAuthorityAcl(authorityRoot, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return true;
  const domain = String(options.domain || process.env.USERDOMAIN || '').trim();
  const username = String(options.username || process.env.USERNAME || '').trim();
  if (!username) return false;
  const actor = domain ? `${domain}\\${username}` : username;
  try {
    await execFileAsync('icacls.exe', [
      path.resolve(authorityRoot),
      '/inheritance:r',
      '/grant:r', `${actor}:(OI)(CI)F`,
      '/grant:r', '*S-1-5-18:(OI)(CI)F',
      '/C', '/Q',
    ], { windowsHide: true, timeout: 15_000 });
    for (const fileName of [
      PRIVATE_KEY_FILE,
      PUBLIC_KEY_FILE,
      DEVICE_REQUEST_FILE,
      ENTITLEMENT_FILE,
      'owner-ed25519-private.pem',
      'owner-ed25519-public.pem',
    ]) {
      const filePath = path.join(path.resolve(authorityRoot), fileName);
      if (!await isRegularFile(filePath)) continue;
      await execFileAsync('icacls.exe', [
        filePath,
        '/inheritance:r',
        '/grant:r', `${actor}:F`,
        '/grant:r', '*S-1-5-18:F',
        '/C', '/Q',
      ], { windowsHide: true, timeout: 15_000 });
    }
    return true;
  } catch {
    return false;
  }
}

function failedIdentity(diagnostic, authorityRoot = '') {
  return {
    status: 'public',
    authorityRoot,
    summary: publicSummary(diagnostic, null),
  };
}

function publicSummary(diagnostic, deviceIdPrefix) {
  return Object.freeze({ tier: 'public', diagnostic, deviceIdPrefix: deviceIdPrefix || null });
}

async function isRegularFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function decodeBase64(value, maximum) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maximum * 2 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) throw new Error('base64');
  const decoded = Buffer.from(normalized, 'base64');
  if (!decoded.length || decoded.byteLength > maximum) throw new Error('base64-size');
  return decoded;
}

function normalizeOwnerEntitlement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
  const allowed = new Set([
    'schemaVersion', 'entitlementId', 'tier', 'devicePublicKeySha256',
    'issuedAt', 'expiresAt', 'keyId', 'signature',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('unknown-field');
  if (value.schemaVersion !== 1 || value.tier !== 'owner') throw new Error('schema');
  const entitlementId = boundedIdentifier(value.entitlementId, 128);
  const keyId = boundedIdentifier(value.keyId, 128);
  const devicePublicKeySha256 = boundedString(value.devicePublicKeySha256, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(devicePublicKeySha256)) throw new Error('fingerprint');
  const issuedAt = boundedString(value.issuedAt, 64);
  parseIsoTimestamp(issuedAt);
  const expiresAt = value.expiresAt === null ? null : boundedString(value.expiresAt, 64);
  if (expiresAt !== null) parseIsoTimestamp(expiresAt);
  return {
    schemaVersion: 1,
    entitlementId,
    tier: 'owner',
    devicePublicKeySha256,
    issuedAt,
    expiresAt,
    keyId,
    signature: boundedString(value.signature, 4 * 1024),
  };
}

function boundedIdentifier(value, maximum) {
  const text = boundedString(value, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)) throw new Error('identifier');
  return text;
}

function boundedString(value, maximum) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum) throw new Error('string');
  return text;
}

function parseIsoTimestamp(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('timestamp');
  return parsed;
}

function canonicalBytes(value) {
  return Buffer.from(stableJson(value), 'utf8');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
