import { describe, expect, it } from 'vitest';
import { createSafeCapabilityToken, verifySafeCapabilityToken } from '../../desktop/safe/capability-token.mjs';

describe('Monarch Safe destructive capability tokens', () => {
  const key = Buffer.alloc(32, 0x77);
  const fileId = '11111111-1111-4111-8111-111111111111';

  it('binds authorization to one action, resource, expiry and nonce', () => {
    const usedNonces = new Set<string>();
    const token = createSafeCapabilityToken({ key, action: 'deleteFile', resourceId: fileId, now: () => 1_000, nonce: () => 'nonce-1' });
    expect(verifySafeCapabilityToken({ token, key, action: 'deleteFile', resourceId: fileId, usedNonces, now: () => 1_001 })).toBe(true);
    expect(verifySafeCapabilityToken({ token, key, action: 'deleteFile', resourceId: fileId, usedNonces, now: () => 1_002 })).toBe(false);
  });

  it('rejects the wrong resource, signature and expired token', () => {
    const token = createSafeCapabilityToken({ key, action: 'deleteFile', resourceId: fileId, ttlMs: 10, now: () => 5_000, nonce: () => 'nonce-2' });
    expect(verifySafeCapabilityToken({ token, key, action: 'writeFile', resourceId: fileId, usedNonces: new Set(), now: () => 5_001 })).toBe(false);
    expect(verifySafeCapabilityToken({ token, key, action: 'deleteFile', resourceId: '22222222-2222-4222-8222-222222222222', usedNonces: new Set(), now: () => 5_001 })).toBe(false);
    expect(verifySafeCapabilityToken({ token: `${token.slice(0, -1)}A`, key, action: 'deleteFile', resourceId: fileId, usedNonces: new Set(), now: () => 5_001 })).toBe(false);
    expect(verifySafeCapabilityToken({ token, key, action: 'deleteFile', resourceId: fileId, usedNonces: new Set(), now: () => 5_011 })).toBe(false);
  });
});
