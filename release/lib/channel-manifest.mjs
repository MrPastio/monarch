import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { stat } from 'node:fs/promises';

export const CHANNEL_MANIFEST_SCHEMA_VERSION = 1;
export const CHANNEL_MANIFEST_LIFETIME_DAYS = 90;
export const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
export const RELEASE_KEY_ID = 'monarch-release-2026-01';
export const RELEASE_REPOSITORY = 'MrPastio/monarch-releases';
export const PRIMARY_MANIFEST_URL =
  `https://raw.githubusercontent.com/${RELEASE_REPOSITORY}/main/channels/stable/manifest.json`;
export const PRIMARY_SIGNATURE_URL =
  `https://raw.githubusercontent.com/${RELEASE_REPOSITORY}/main/channels/stable/manifest.sig`;

const MONARCH_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function fail(message) {
  throw new Error(`Invalid Monarch channel manifest: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail(`${path} must be an object`);
}

function assertExactKeys(value, allowed, path) {
  const actual = Object.keys(value);
  const extras = actual.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in value));
  if (extras.length > 0) fail(`${path} contains unsupported fields: ${extras.join(', ')}`);
  if (missing.length > 0) fail(`${path} is missing fields: ${missing.join(', ')}`);
}

function assertString(value, path, { allowEmpty = false, maxLength = 2048 } = {}) {
  if (typeof value !== 'string') fail(`${path} must be a string`);
  if (!allowEmpty && value.trim().length === 0) fail(`${path} must not be empty`);
  if (value.length > maxLength) fail(`${path} exceeds ${maxLength} characters`);
}

function assertNullableString(value, path) {
  if (value === null) return;
  assertString(value, path, { maxLength: 512 });
}

function assertMonarchVersion(value, path) {
  assertString(value, path, { maxLength: 128 });
  if (!MONARCH_VERSION_PATTERN.test(value)) {
    fail(`${path} must contain three or four numeric version components without a leading v`);
  }
}

function assertUtcTimestamp(value, path) {
  assertString(value, path, { maxLength: 32 });
  if (!ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${path} must be an ISO-8601 UTC timestamp`);
  }
}

function assertHttpsUrl(value, path) {
  assertString(value, path);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${path} must be an absolute URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail(`${path} must use HTTPS without credentials`);
  }
  if (url.hash) fail(`${path} must not contain a fragment`);
  return url;
}

function assertInteger(value, path, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${path} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertCompatibility(value) {
  assertRecord(value, 'compatibility');
  assertExactKeys(
    value,
    [
      'runtimeVersion',
      'backendEnvironment',
      'dataSchemaVersion',
      'minimumReadableDataSchema',
      'maximumReadableDataSchema',
      'minimumModelCatalogSchema',
      'maximumModelCatalogSchema',
    ],
    'compatibility',
  );
  assertString(value.runtimeVersion, 'compatibility.runtimeVersion', { maxLength: 128 });
  assertString(value.backendEnvironment, 'compatibility.backendEnvironment', { maxLength: 128 });
  assertInteger(value.dataSchemaVersion, 'compatibility.dataSchemaVersion', 1);
  assertInteger(value.minimumReadableDataSchema, 'compatibility.minimumReadableDataSchema', 1);
  assertInteger(value.maximumReadableDataSchema, 'compatibility.maximumReadableDataSchema', 1);
  assertInteger(value.minimumModelCatalogSchema, 'compatibility.minimumModelCatalogSchema', 1);
  assertInteger(value.maximumModelCatalogSchema, 'compatibility.maximumModelCatalogSchema', 1);
  if (
    value.minimumReadableDataSchema > value.dataSchemaVersion ||
    value.dataSchemaVersion > value.maximumReadableDataSchema
  ) {
    fail('compatibility data schema range must include dataSchemaVersion');
  }
  if (value.minimumModelCatalogSchema > value.maximumModelCatalogSchema) {
    fail('compatibility model catalog range is inverted');
  }
}

function assertAsset(value, manifest) {
  if (value === null) {
    if (manifest.available) fail('asset is required when available is true');
    return;
  }
  if (!manifest.available) fail('asset must be null when available is false');
  assertRecord(value, 'asset');
  assertExactKeys(value, ['url', 'mirrors', 'size', 'sha256', 'fileName'], 'asset');
  const url = assertHttpsUrl(value.url, 'asset.url');
  const expectedPrefix =
    `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${manifest.version}/`;
  if (!value.url.startsWith(expectedPrefix)) {
    fail(`asset.url must use the immutable ${RELEASE_REPOSITORY} release path`);
  }
  assertInteger(value.size, 'asset.size', 1, MAX_INSTALLER_BYTES);
  assertString(value.sha256, 'asset.sha256', { maxLength: 64 });
  if (!SHA256_PATTERN.test(value.sha256)) {
    fail('asset.sha256 must be 64 lowercase hexadecimal characters');
  }
  assertString(value.fileName, 'asset.fileName', { maxLength: 180 });
  const expectedFileName = `Monarch-Setup-${manifest.version}.exe`;
  if (value.fileName !== expectedFileName) {
    fail(`asset.fileName must be ${expectedFileName}`);
  }
  if (!decodeURIComponent(url.pathname).endsWith(`/${value.fileName}`)) {
    fail('asset.url path must end with asset.fileName');
  }
  if (!Array.isArray(value.mirrors) || value.mirrors.length > 4) {
    fail('asset.mirrors must be an array with at most four entries');
  }
  const mirrorSet = new Set();
  for (const [index, mirror] of value.mirrors.entries()) {
    assertHttpsUrl(mirror, `asset.mirrors[${index}]`);
    if (mirrorSet.has(mirror) || mirror === value.url) {
      fail('asset.mirrors must be unique and must not repeat asset.url');
    }
    mirrorSet.add(mirror);
  }
}

export function validateChannelManifest(manifest) {
  assertRecord(manifest, 'manifest');
  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'sequence',
      'channel',
      'version',
      'publishedAt',
      'expiresAt',
      'minimumUpdaterVersion',
      'minimumLauncherVersion',
      'available',
      'withdrawnReason',
      'revokedVersions',
      'releaseNotesUrl',
      'compatibility',
      'asset',
      'keyId',
    ],
    'manifest',
  );
  if (manifest.schemaVersion !== CHANNEL_MANIFEST_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${CHANNEL_MANIFEST_SCHEMA_VERSION}`);
  }
  assertInteger(manifest.sequence, 'sequence', 0);
  if (manifest.channel !== 'stable') fail('channel must be stable');
  assertMonarchVersion(manifest.version, 'version');
  assertUtcTimestamp(manifest.publishedAt, 'publishedAt');
  assertUtcTimestamp(manifest.expiresAt, 'expiresAt');
  const publishedAt = Date.parse(manifest.publishedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (expiresAt <= publishedAt) fail('expiresAt must be later than publishedAt');
  const lifetimeDays = (expiresAt - publishedAt) / 86_400_000;
  if (lifetimeDays > CHANNEL_MANIFEST_LIFETIME_DAYS) {
    fail(`manifest lifetime must not exceed ${CHANNEL_MANIFEST_LIFETIME_DAYS} days`);
  }
  assertMonarchVersion(manifest.minimumUpdaterVersion, 'minimumUpdaterVersion');
  assertMonarchVersion(manifest.minimumLauncherVersion, 'minimumLauncherVersion');
  if (typeof manifest.available !== 'boolean') fail('available must be a boolean');
  assertNullableString(manifest.withdrawnReason, 'withdrawnReason');
  if (manifest.available && manifest.withdrawnReason !== null) {
    fail('withdrawnReason must be null when available is true');
  }
  if (!manifest.available && manifest.withdrawnReason === null) {
    fail('withdrawnReason is required when available is false');
  }
  if (!Array.isArray(manifest.revokedVersions) || manifest.revokedVersions.length > 128) {
    fail('revokedVersions must be an array with at most 128 entries');
  }
  const revoked = new Set();
  for (const [index, version] of manifest.revokedVersions.entries()) {
    assertMonarchVersion(version, `revokedVersions[${index}]`);
    if (revoked.has(version)) fail('revokedVersions must not contain duplicates');
    revoked.add(version);
  }
  if (manifest.available && revoked.has(manifest.version)) {
    fail('an available version must not revoke itself');
  }
  assertHttpsUrl(manifest.releaseNotesUrl, 'releaseNotesUrl');
  assertCompatibility(manifest.compatibility);
  assertAsset(manifest.asset, manifest);
  assertString(manifest.keyId, 'keyId', { maxLength: 64 });
  if (!KEY_ID_PATTERN.test(manifest.keyId)) fail('keyId has an invalid format');
  return manifest;
}

export function parseAndValidateManifestBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length === 0 || bytes.length > 256 * 1024) {
    fail('manifest byte length must be between 1 and 262144');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateChannelManifest(parsed);
}

export function encodeManifest(manifest) {
  validateChannelManifest(manifest);
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function requireEd25519PrivateKey(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Release private key must be Ed25519.');
  }
  return key;
}

function requireEd25519PublicKey(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Release public key must be Ed25519.');
  }
  return key;
}

export function signManifestBytes(bytes, privateKeyPem) {
  parseAndValidateManifestBytes(bytes);
  return sign(null, bytes, requireEd25519PrivateKey(privateKeyPem)).toString('base64');
}

export function verifyManifestSignature(bytes, signatureText, publicKeyPem) {
  const manifest = parseAndValidateManifestBytes(bytes);
  if (typeof signatureText !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signatureText.trim())) {
    throw new Error('Manifest signature must be one Base64-encoded Ed25519 signature.');
  }
  const valid = verify(
    null,
    bytes,
    requireEd25519PublicKey(publicKeyPem),
    Buffer.from(signatureText.trim(), 'base64'),
  );
  if (!valid) throw new Error('Manifest Ed25519 signature verification failed.');
  return manifest;
}

export function generateReleaseKeyPair(keyId = RELEASE_KEY_ID) {
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error('Invalid release keyId.');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    keyId,
    privateKey,
    publicKey,
    keyring: {
      schemaVersion: 1,
      keys: {
        [keyId]: publicKey,
      },
    },
  };
}

export function publicKeyFromPrivate(privateKeyPem) {
  return createPublicKey(requireEd25519PrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

export function resolveKeyringPublicKey(keyring, keyId) {
  assertRecord(keyring, 'keyring');
  if (keyring.schemaVersion !== 1) throw new Error('Unsupported release keyring schema.');
  assertRecord(keyring.keys, 'keyring.keys');
  const publicKey = keyring.keys[keyId];
  if (typeof publicKey !== 'string') throw new Error(`Unknown release keyId: ${keyId}`);
  requireEd25519PublicKey(publicKey);
  return publicKey;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  const file = await import('node:fs').then(({ createReadStream }) => createReadStream(filePath));
  for await (const chunk of file) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareManifest({
  spec,
  installerPath,
  sequence,
  publishedAt,
  expiresAt,
}) {
  assertRecord(spec, 'release spec');
  if (spec.available !== true) {
    throw new Error('Release spec is not armed: available must be true before publication.');
  }
  assertRecord(spec.asset, 'release spec asset');
  const installer = await stat(installerPath);
  const manifest = {
    ...spec,
    schemaVersion: CHANNEL_MANIFEST_SCHEMA_VERSION,
    sequence,
    publishedAt,
    expiresAt,
    asset: {
      ...spec.asset,
      size: installer.size,
      sha256: await sha256File(installerPath),
    },
  };
  return validateChannelManifest(manifest);
}

export function refreshManifest(manifest, now = new Date()) {
  validateChannelManifest(manifest);
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error('Invalid refresh time.');
  const expiresAt = new Date(now.valueOf() + CHANNEL_MANIFEST_LIFETIME_DAYS * 86_400_000);
  return validateChannelManifest({
    ...manifest,
    sequence: manifest.sequence + 1,
    publishedAt: now.toISOString().replace('.000Z', 'Z'),
    expiresAt: expiresAt.toISOString().replace('.000Z', 'Z'),
  });
}

export function getExpiryStatus(manifest, now = new Date()) {
  validateChannelManifest(manifest);
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error('Invalid status time.');
  const remainingMs = Date.parse(manifest.expiresAt) - now.valueOf();
  const remainingDays = remainingMs / 86_400_000;
  return {
    remainingDays,
    refreshDue: remainingDays <= 30,
    urgent: remainingDays <= 14,
    expired: remainingDays < 0,
  };
}
