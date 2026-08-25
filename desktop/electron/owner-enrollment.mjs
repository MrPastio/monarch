import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MONARCH_OWNER_PUBLIC_KEYS,
  loadOrCreateOwnerDeviceIdentity,
  ownerAuthorityPaths,
  restrictOwnerAuthorityAcl,
  validateOwnerEntitlement,
} from './owner-authority.mjs';

const DEVICE_REQUEST_FILE = 'device-request.json';
const ENTITLEMENT_FILE = 'owner-entitlement.json';
const MAX_PUBLIC_DOCUMENT_BYTES = 64 * 1024;

export async function readOwnerEnrollmentStatus({
  authorityRoot,
  safeStorage,
  now = new Date(),
  restrictAcl = restrictOwnerAuthorityAcl,
  publicKeys = MONARCH_OWNER_PUBLIC_KEYS,
} = {}) {
  if (!path.isAbsolute(String(authorityRoot || ''))) {
    return enrollmentStatus({ deviceStatus: 'unavailable', diagnostic: 'owner-authority-root-invalid' });
  }
  const paths = ownerAuthorityPaths(authorityRoot);
  const [privateExists, publicExists, entitlementExists] = await Promise.all([
    isRegularFile(paths.privateKeyPath),
    isRegularFile(paths.publicKeyPath),
    isRegularFile(paths.entitlementPath),
  ]);
  if (privateExists !== publicExists) {
    return enrollmentStatus({
      deviceStatus: 'partial',
      entitlementStatus: entitlementExists ? 'invalid' : 'absent',
      diagnostic: 'owner-device-key-partial',
    });
  }
  if (!privateExists) {
    return enrollmentStatus({
      deviceStatus: 'absent',
      entitlementStatus: entitlementExists ? 'invalid' : 'absent',
      diagnostic: entitlementExists ? 'owner-device-key-missing' : 'owner-device-request-absent',
    });
  }

  const identity = await loadOrCreateOwnerDeviceIdentity({ authorityRoot, safeStorage, now, restrictAcl });
  if (identity.status !== 'ready') {
    return enrollmentStatus({
      deviceStatus: identity.summary?.diagnostic === 'owner-device-key-corrupt' ? 'corrupt' : 'unavailable',
      entitlementStatus: entitlementExists ? 'invalid' : 'absent',
      diagnostic: identity.summary?.diagnostic || 'owner-device-unavailable',
    });
  }
  const requestReady = await isRegularFile(paths.deviceRequestPath);
  if (!entitlementExists) {
    return enrollmentStatus({
      deviceStatus: 'ready',
      deviceIdPrefix: identity.deviceIdPrefix,
      requestReady,
      diagnostic: 'owner-entitlement-absent',
    });
  }

  const parsed = await readBoundedJson(paths.entitlementPath).catch(() => null);
  const validation = validateOwnerEntitlement(parsed, {
    devicePublicKeySha256: createHash('sha256').update(identity.publicKeyDer).digest('hex'),
    now,
    publicKeys,
  });
  if (!validation.ok) {
    return enrollmentStatus({
      deviceStatus: 'ready',
      deviceIdPrefix: identity.deviceIdPrefix,
      requestReady,
      entitlementStatus: entitlementStatusForDiagnostic(validation.diagnostic),
      diagnostic: validation.diagnostic,
    });
  }
  return enrollmentStatus({
    deviceStatus: 'ready',
    deviceIdPrefix: identity.deviceIdPrefix,
    requestReady,
    entitlementStatus: 'valid',
    entitlementId: validation.entitlement.entitlementId,
    keyId: validation.entitlement.keyId,
    expiresAt: validation.entitlement.expiresAt,
    diagnostic: 'owner-entitlement-valid-restart-required',
  });
}

export async function createOwnerDeviceRequest(options = {}) {
  const identity = await loadOrCreateOwnerDeviceIdentity(options);
  if (identity.status !== 'ready') {
    return {
      ok: false,
      status: enrollmentStatus({
        deviceStatus: identity.summary?.diagnostic === 'owner-device-key-partial'
          ? 'partial'
          : identity.summary?.diagnostic === 'owner-device-key-corrupt'
            ? 'corrupt'
            : 'unavailable',
        diagnostic: identity.summary?.diagnostic || 'owner-device-unavailable',
      }),
    };
  }
  return {
    ok: true,
    status: await readOwnerEnrollmentStatus(options),
  };
}

export async function exportOwnerDeviceRequest({ authorityRoot, destinationPath } = {}) {
  if (!path.isAbsolute(String(authorityRoot || '')) || !path.isAbsolute(String(destinationPath || ''))) {
    return { ok: false, error: 'owner-device-request-path-invalid' };
  }
  if (path.basename(destinationPath).toLowerCase() !== DEVICE_REQUEST_FILE) {
    return { ok: false, error: 'owner-device-request-filename-invalid' };
  }
  const sourcePath = ownerAuthorityPaths(authorityRoot).deviceRequestPath;
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
    return { ok: true, fileName: DEVICE_REQUEST_FILE, alreadyExported: true };
  }
  try {
    const bytes = await readBoundedBytes(sourcePath);
    validateDeviceRequest(JSON.parse(bytes.toString('utf8')));
    await writeFile(destinationPath, bytes, { mode: 0o600 });
    return { ok: true, fileName: DEVICE_REQUEST_FILE, alreadyExported: false };
  } catch {
    return { ok: false, error: 'owner-device-request-export-failed' };
  }
}

export async function importOwnerEntitlement({
  authorityRoot,
  sourcePath,
  safeStorage,
  now = new Date(),
  restrictAcl = restrictOwnerAuthorityAcl,
  publicKeys = MONARCH_OWNER_PUBLIC_KEYS,
  randomBytesFactory = randomBytes,
} = {}) {
  if (!path.isAbsolute(String(authorityRoot || '')) || !path.isAbsolute(String(sourcePath || ''))) {
    return { ok: false, diagnostic: 'owner-entitlement-path-invalid' };
  }
  if (path.basename(sourcePath).toLowerCase() !== ENTITLEMENT_FILE) {
    return { ok: false, diagnostic: 'owner-entitlement-filename-invalid' };
  }
  const identity = await loadOrCreateOwnerDeviceIdentity({ authorityRoot, safeStorage, now, restrictAcl });
  if (identity.status !== 'ready') {
    return { ok: false, diagnostic: identity.summary?.diagnostic || 'owner-device-unavailable' };
  }
  let parsed;
  try {
    parsed = await readBoundedJson(sourcePath);
  } catch {
    return { ok: false, diagnostic: 'owner-entitlement-invalid' };
  }
  const validation = validateOwnerEntitlement(parsed, {
    devicePublicKeySha256: createHash('sha256').update(identity.publicKeyDer).digest('hex'),
    now,
    publicKeys,
  });
  if (!validation.ok) return { ok: false, diagnostic: validation.diagnostic };

  const paths = ownerAuthorityPaths(authorityRoot);
  const normalizedBytes = Buffer.from(`${JSON.stringify(validation.entitlement, null, 2)}\n`, 'utf8');
  const existingBytes = await readBoundedBytes(paths.entitlementPath).catch(() => null);
  if (existingBytes?.equals(normalizedBytes)) {
    if (!await restrictAcl(paths.authorityRoot)) return { ok: false, diagnostic: 'owner-authority-acl-failed' };
    return {
      ok: true,
      restartRequired: true,
      backupCreated: false,
      status: await readOwnerEnrollmentStatus({ authorityRoot, safeStorage, now, restrictAcl, publicKeys }),
    };
  }

  await mkdir(paths.authorityRoot, { recursive: true, mode: 0o700 });
  const nonce = randomBytesFactory(8).toString('hex');
  const temporaryPath = path.join(paths.authorityRoot, `.owner-entitlement-${nonce}.tmp`);
  const backupPath = path.join(
    paths.authorityRoot,
    `owner-entitlement.backup-${now.toISOString().replace(/[:.]/gu, '-')}-${nonce}.json`,
  );
  let movedExisting = false;
  let installedNew = false;
  try {
    await writeFile(temporaryPath, normalizedBytes, { flag: 'wx', mode: 0o600 });
    if (existingBytes) {
      await rename(paths.entitlementPath, backupPath);
      movedExisting = true;
    }
    await rename(temporaryPath, paths.entitlementPath);
    installedNew = true;
    if (!await restrictAcl(paths.authorityRoot)) throw new Error('acl');
  } catch {
    if (installedNew) await rm(paths.entitlementPath, { force: true }).catch(() => undefined);
    if (movedExisting) await rename(backupPath, paths.entitlementPath).catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return { ok: false, diagnostic: installedNew ? 'owner-authority-acl-failed' : 'owner-entitlement-install-failed' };
  }
  return {
    ok: true,
    restartRequired: true,
    backupCreated: movedExisting,
    status: await readOwnerEnrollmentStatus({ authorityRoot, safeStorage, now, restrictAcl, publicKeys }),
  };
}

function enrollmentStatus({
  deviceStatus = 'absent',
  deviceIdPrefix = null,
  requestReady = false,
  entitlementStatus = 'absent',
  entitlementId = null,
  keyId = null,
  expiresAt = null,
  diagnostic = 'owner-device-request-absent',
} = {}) {
  return Object.freeze({
    schemaVersion: 1,
    deviceStatus,
    deviceIdPrefix,
    requestReady: requestReady === true,
    entitlementStatus,
    entitlementId,
    keyId,
    expiresAt,
    diagnostic,
  });
}

function entitlementStatusForDiagnostic(diagnostic) {
  if (diagnostic === 'owner-entitlement-expired') return 'expired';
  if (diagnostic === 'owner-device-mismatch') return 'wrong-device';
  return 'invalid';
}

async function readBoundedJson(filePath) {
  const bytes = await readBoundedBytes(filePath);
  return JSON.parse(bytes.toString('utf8'));
}

async function readBoundedBytes(filePath) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 2 || info.size > MAX_PUBLIC_DOCUMENT_BYTES) throw new Error('document');
  return readFile(filePath);
}

async function isRegularFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function validateDeviceRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request');
  const keys = Object.keys(value);
  if (keys.some((key) => !['schemaVersion', 'devicePublicKeySpkiBase64', 'devicePublicKeySha256', 'createdAt'].includes(key))) {
    throw new Error('request-fields');
  }
  if (value.schemaVersion !== 1
    || !/^[a-f0-9]{64}$/u.test(String(value.devicePublicKeySha256 || ''))
    || !String(value.devicePublicKeySpkiBase64 || '').trim()
    || !Number.isFinite(Date.parse(String(value.createdAt || '')))) {
    throw new Error('request-shape');
  }
  return value;
}
