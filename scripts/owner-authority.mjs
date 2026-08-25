import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restrictOwnerAuthorityAcl } from '../desktop/electron/owner-authority.mjs';

const OWNER_KEY_ROOT = path.resolve('E:\\', 'MonarchReleaseKeys', 'owner-entitlements');
const PRIVATE_KEY_PATH = path.join(OWNER_KEY_ROOT, 'owner-ed25519-private.pem');
const PUBLIC_KEY_PATH = path.join(OWNER_KEY_ROOT, 'owner-ed25519-public.pem');
const KEY_ID = 'owner-root-2026-01';

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const command = String(process.argv[2] || '').trim().toLowerCase();
  if (command === 'init-vendor') return initVendorKey();
  if (command === 'public-key') return printPublicKey();
  if (command === 'issue') return issueEntitlement();
  throw new Error('Usage: node scripts/owner-authority.mjs <init-vendor|public-key|issue --request PATH --out PATH [--expires ISO]>');
}

async function initVendorKey() {
  await mkdir(OWNER_KEY_ROOT, { recursive: true, mode: 0o700 });
  await assertExactKeyRoot();
  const privateExists = existsSync(PRIVATE_KEY_PATH);
  const publicExists = existsSync(PUBLIC_KEY_PATH);
  if (privateExists !== publicExists) throw new Error('Owner signing key directory is partial; refusing to regenerate or overwrite it.');
  if (!privateExists) {
    const pair = generateKeyPairSync('ed25519');
    await writeFile(PRIVATE_KEY_PATH, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
    await writeFile(PUBLIC_KEY_PATH, pair.publicKey.export({ format: 'pem', type: 'spki' }), { flag: 'wx', mode: 0o600 });
  }
  if (!await restrictOwnerAuthorityAcl(OWNER_KEY_ROOT)) throw new Error('Could not restrict ACL on the dedicated Owner signing-key directory.');
  const publicDer = await readPublicDer();
  console.log(JSON.stringify({
    ok: true,
    keyId: KEY_ID,
    root: OWNER_KEY_ROOT,
    publicKeySha256: createHash('sha256').update(publicDer).digest('hex'),
  }, null, 2));
}

async function printPublicKey() {
  await assertExactKeyRoot();
  const publicDer = await readPublicDer();
  console.log(JSON.stringify({
    keyId: KEY_ID,
    publicKeySpkiBase64: publicDer.toString('base64'),
    publicKeySha256: createHash('sha256').update(publicDer).digest('hex'),
  }, null, 2));
}

async function issueEntitlement() {
  await assertExactKeyRoot();
  const requestPath = readPathFlag('--request');
  const outPath = readPathFlag('--out');
  if (path.basename(outPath).toLowerCase() !== 'owner-entitlement.json') {
    throw new Error('Owner entitlement output filename must be owner-entitlement.json.');
  }
  if (existsSync(outPath)) throw new Error('Owner entitlement already exists; refusing to overwrite it.');
  const requestBytes = await readFile(requestPath);
  if (requestBytes.byteLength > 64 * 1024) throw new Error('Device request is too large.');
  const request = JSON.parse(requestBytes.toString('utf8'));
  assertDeviceRequest(request);
  const publicDer = decodeBase64(request.devicePublicKeySpkiBase64, 4 * 1024);
  const fingerprint = createHash('sha256').update(publicDer).digest('hex');
  if (fingerprint !== request.devicePublicKeySha256) throw new Error('Device request fingerprint mismatch.');
  createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
  const expires = readOptionalFlag('--expires');
  if (expires && !Number.isFinite(Date.parse(expires))) throw new Error('--expires must be an ISO timestamp.');
  const unsigned = {
    schemaVersion: 1,
    entitlementId: `owner_${randomUUID()}`,
    tier: 'owner',
    devicePublicKeySha256: fingerprint,
    issuedAt: new Date().toISOString(),
    expiresAt: expires || null,
    keyId: KEY_ID,
  };
  const privateKey = createPrivateKey(await readFile(PRIVATE_KEY_PATH));
  const entitlement = {
    ...unsigned,
    signature: sign(null, canonicalBytes(unsigned), privateKey).toString('base64'),
  };
  await mkdir(path.dirname(outPath), { recursive: true, mode: 0o700 });
  await writeFile(outPath, `${JSON.stringify(entitlement, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    entitlementId: entitlement.entitlementId,
    keyId: KEY_ID,
    deviceIdPrefix: fingerprint.slice(0, 12),
    expiresAt: entitlement.expiresAt,
    outPath,
  }, null, 2));
}

async function assertExactKeyRoot() {
  if (!existsSync(OWNER_KEY_ROOT)) throw new Error(`Dedicated Owner key directory does not exist: ${OWNER_KEY_ROOT}`);
  const resolved = path.resolve(await realpath(OWNER_KEY_ROOT));
  if (resolved.toLowerCase() !== OWNER_KEY_ROOT.toLowerCase()) {
    throw new Error('Dedicated Owner key directory resolves outside its exact configured path.');
  }
}

async function readPublicDer() {
  const publicKey = createPublicKey(await readFile(PUBLIC_KEY_PATH));
  return Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
}

function assertDeviceRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid device request.');
  const keys = Object.keys(value);
  if (keys.some((key) => !['schemaVersion', 'devicePublicKeySpkiBase64', 'devicePublicKeySha256', 'createdAt'].includes(key))) {
    throw new Error('Device request contains unknown fields.');
  }
  if (value.schemaVersion !== 1
    || typeof value.devicePublicKeySpkiBase64 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(String(value.devicePublicKeySha256 || ''))
    || !Number.isFinite(Date.parse(String(value.createdAt || '')))) {
    throw new Error('Invalid device request fields.');
  }
}

function readPathFlag(name) {
  const value = readOptionalFlag(name);
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} requires an absolute path.`);
  return path.resolve(value);
}

function readOptionalFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function decodeBase64(value, maximum) {
  const normalized = String(value || '').trim();
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) throw new Error('Invalid base64.');
  const decoded = Buffer.from(normalized, 'base64');
  if (!decoded.length || decoded.byteLength > maximum) throw new Error('Decoded key is invalid.');
  return decoded;
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
