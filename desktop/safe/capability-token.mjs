import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_TOKEN_TTL_MS = 60_000;

export function createSafeCapabilityToken({ key, action, resourceId, ttlMs = 30_000, now = Date.now, nonce = randomUUID }) {
  const secret = normalizeKey(key);
  const issuedAt = Number(now());
  const lifetime = Number.isSafeInteger(ttlMs) ? Math.max(1, Math.min(MAX_TOKEN_TTL_MS, ttlMs)) : 30_000;
  const payload = {
    version: 1,
    action: normalizeField(action),
    resourceId: normalizeField(resourceId),
    issuedAt,
    expiresAt: issuedAt + lifetime,
    nonce: normalizeField(nonce()),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(encoded, secret);
  secret.fill(0);
  return `${encoded}.${signature}`;
}

export function verifySafeCapabilityToken({ token, key, action, resourceId, usedNonces, now = Date.now }) {
  const secret = normalizeKey(key);
  let expected = null;
  let actual = null;
  try {
    const [encoded, signature, extra] = String(token || '').split('.');
    if (!encoded || !signature || extra !== undefined) return false;
    expected = Buffer.from(sign(encoded, secret), 'base64url');
    actual = Buffer.from(signature, 'base64url');
    if (expected.byteLength !== 32 || actual.byteLength !== 32 || !timingSafeEqual(expected, actual)) return false;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload?.version !== 1 || payload.action !== normalizeField(action) || payload.resourceId !== normalizeField(resourceId)) return false;
    const current = Number(now());
    if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt < current || payload.issuedAt > current + 5_000 || payload.expiresAt - payload.issuedAt > MAX_TOKEN_TTL_MS) return false;
    if (typeof payload.nonce !== 'string' || !payload.nonce || usedNonces?.has(payload.nonce)) return false;
    usedNonces?.add(payload.nonce);
    return true;
  } catch {
    return false;
  } finally {
    expected?.fill(0);
    actual?.fill(0);
    secret.fill(0);
  }
}

function sign(encoded, key) {
  return createHmac('sha256', key).update('monarch-safe:capability:v1\0', 'utf8').update(encoded, 'utf8').digest('base64url');
}

function normalizeKey(value) {
  const key = Buffer.from(value || []);
  if (key.byteLength !== 32) throw new TypeError('Monarch Safe capability key must be 32 bytes.');
  return key;
}

function normalizeField(value) {
  const field = String(value || '');
  if (!field || field.length > 160) throw new TypeError('Monarch Safe capability field is invalid.');
  return field;
}
