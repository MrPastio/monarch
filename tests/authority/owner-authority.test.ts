import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalOwnerAuthorityBytes,
  resolveOwnerAuthorityFromEnvironment,
  verifyOwnerAuthorityEnvelope,
  type OwnerAuthorityEnvelopeV1,
  type OwnerAuthorityPublicKey,
} from '../../src/authority/owner-authority';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const TOKEN = 'desktop-session-test-token';
const PORT = 4317;

describe('signed Owner authority', () => {
  it('activates Owner only for a vendor-signed entitlement and current device session proof', () => {
    const fixture = createFixture();
    expect(verify(fixture)).toMatchObject({
      tier: 'owner',
      source: 'signed-device-entitlement',
      entitlementId: 'owner_entitlement_test',
      keyId: 'owner-root-test',
      diagnostic: null,
    });
  });

  it('fails to Public for a bad vendor signature, another device, corrupt key, and expiry', () => {
    const badSignature = createFixture();
    badSignature.envelope.entitlement.signature = Buffer.alloc(64, 7).toString('base64');
    expect(verify(badSignature)).toMatchObject({ tier: 'public', diagnostic: 'owner-entitlement-signature-invalid' });

    const otherDevice = createFixture();
    const replacement = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    otherDevice.envelope.devicePublicKeySpkiBase64 = Buffer.from(replacement).toString('base64');
    expect(verify(otherDevice)).toMatchObject({ tier: 'public', diagnostic: 'owner-device-mismatch' });

    const corruptKey = createFixture();
    corruptKey.envelope.devicePublicKeySpkiBase64 = 'not-base64';
    expect(verify(corruptKey)).toMatchObject({ tier: 'public', diagnostic: 'owner-envelope-invalid' });

    const expired = createFixture({ entitlementExpiresAt: '2026-08-02T11:59:59.000Z' });
    expect(verify(expired)).toMatchObject({ tier: 'public', diagnostic: 'owner-entitlement-expired' });
  });

  it('rejects stale or session-mismatched device proofs', () => {
    const stale = createFixture({ proofIssuedAt: '2026-08-02T11:50:00.000Z', proofExpiresAt: '2026-08-02T11:52:00.000Z' });
    expect(verify(stale)).toMatchObject({ tier: 'public', diagnostic: 'owner-proof-expired' });

    const wrongSession = createFixture();
    expect(verifyOwnerAuthorityEnvelope(wrongSession.envelope, {
      desktopAttestationToken: 'another-session-token',
      runtimePort: PORT,
      now: NOW,
      publicKeys: wrongSession.publicKeys,
    })).toMatchObject({ tier: 'public', diagnostic: 'owner-proof-session-mismatch' });
  });

  it('does not enable Owner through ordinary environment flags', () => {
    expect(resolveOwnerAuthorityFromEnvironment({
      MONARCH_OWNER: '1',
      MONARCH_AUTHORITY_TIER: 'owner',
      MONARCH_UI_PORT: String(PORT),
      MONARCH_DESKTOP_ATTESTATION_TOKEN: TOKEN,
    })).toMatchObject({ tier: 'public', source: 'default', diagnostic: 'owner-entitlement-absent' });
  });
});

function createFixture(options: {
  entitlementExpiresAt?: string | null;
  proofIssuedAt?: string;
  proofExpiresAt?: string;
} = {}): { envelope: OwnerAuthorityEnvelopeV1; publicKeys: readonly OwnerAuthorityPublicKey[] } {
  const vendor = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const deviceDer = Buffer.from(device.publicKey.export({ format: 'der', type: 'spki' }));
  const unsigned = {
    schemaVersion: 1 as const,
    entitlementId: 'owner_entitlement_test',
    tier: 'owner' as const,
    devicePublicKeySha256: createHash('sha256').update(deviceDer).digest('hex'),
    issuedAt: '2026-08-02T11:00:00.000Z',
    expiresAt: options.entitlementExpiresAt === undefined ? null : options.entitlementExpiresAt,
    keyId: 'owner-root-test',
  };
  const entitlement = {
    ...unsigned,
    signature: sign(null, canonicalOwnerAuthorityBytes(unsigned), vendor.privateKey).toString('base64'),
  };
  const proof = {
    schemaVersion: 1 as const,
    entitlementId: entitlement.entitlementId,
    sessionNonce: 'session_nonce_test',
    desktopAttestationSha256: createHash('sha256').update(TOKEN, 'utf8').digest('hex'),
    runtimePort: PORT,
    issuedAt: options.proofIssuedAt || '2026-08-02T11:59:00.000Z',
    expiresAt: options.proofExpiresAt || '2026-08-02T12:01:00.000Z',
  };
  return {
    envelope: {
      schemaVersion: 1,
      entitlement,
      devicePublicKeySpkiBase64: deviceDer.toString('base64'),
      proof,
      proofSignature: sign(null, canonicalOwnerAuthorityBytes(proof), device.privateKey).toString('base64'),
    },
    publicKeys: [{
      keyId: unsigned.keyId,
      publicKeySpkiBase64: Buffer.from(vendor.publicKey.export({ format: 'der', type: 'spki' })).toString('base64'),
    }],
  };
}

function verify(fixture: ReturnType<typeof createFixture>) {
  return verifyOwnerAuthorityEnvelope(fixture.envelope, {
    desktopAttestationToken: TOKEN,
    runtimePort: PORT,
    now: NOW,
    publicKeys: fixture.publicKeys,
  });
}
