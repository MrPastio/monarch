import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MONARCH_OWNER_PUBLIC_KEYS as DESKTOP_OWNER_PUBLIC_KEYS,
  loadOrCreateOwnerDeviceIdentity,
  ownerAuthorityPaths,
  prepareOwnerAuthoritySession,
  setOwnerModeSuspended,
} from '../../desktop/electron/owner-authority.mjs';
import {
  MONARCH_OWNER_PUBLIC_KEYS as RUNTIME_OWNER_PUBLIC_KEYS,
  canonicalOwnerAuthorityBytes,
  verifyOwnerAuthorityEnvelope,
} from '../../src/authority/owner-authority';

const roots: string[] = [];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8').replace(/^sealed:/u, ''),
};
const allowTestAcl = async () => true;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Electron Owner device identity', () => {
  it('keeps the packaged verifier public-key registry aligned with the runtime', () => {
    expect(DESKTOP_OWNER_PUBLIC_KEYS).toEqual(RUNTIME_OWNER_PUBLIC_KEYS);
  });

  it('creates one protected device keypair and reuses it', async () => {
    const root = await tempRoot();
    const first = await loadOrCreateOwnerDeviceIdentity({ authorityRoot: root, safeStorage, restrictAcl: allowTestAcl });
    const second = await loadOrCreateOwnerDeviceIdentity({ authorityRoot: root, safeStorage, restrictAcl: allowTestAcl });
    expect(first).toMatchObject({ status: 'ready' });
    expect(second).toMatchObject({ status: 'ready', deviceIdPrefix: first.deviceIdPrefix });
    const request = JSON.parse(await readFile(ownerAuthorityPaths(root).deviceRequestPath, 'utf8'));
    expect(request).toMatchObject({ schemaVersion: 1, devicePublicKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it('fails Public on a partial or corrupt keypair without regenerating it', async () => {
    const partialRoot = await tempRoot();
    const partialPaths = ownerAuthorityPaths(partialRoot);
    await writeFile(partialPaths.privateKeyPath, Buffer.from('partial'), { flag: 'wx' });
    await expect(loadOrCreateOwnerDeviceIdentity({ authorityRoot: partialRoot, safeStorage, restrictAcl: allowTestAcl }))
      .resolves.toMatchObject({ status: 'public', summary: { diagnostic: 'owner-device-key-partial' } });

    const corruptRoot = await tempRoot();
    const ready = await loadOrCreateOwnerDeviceIdentity({ authorityRoot: corruptRoot, safeStorage, restrictAcl: allowTestAcl });
    expect(ready.status).toBe('ready');
    const corruptPaths = ownerAuthorityPaths(corruptRoot);
    const publicBefore = await readFile(corruptPaths.publicKeyPath, 'utf8');
    await writeFile(corruptPaths.privateKeyPath, Buffer.from('corrupt-key'));
    await expect(loadOrCreateOwnerDeviceIdentity({ authorityRoot: corruptRoot, safeStorage, restrictAcl: allowTestAcl }))
      .resolves.toMatchObject({ status: 'public', summary: { diagnostic: 'owner-device-key-corrupt' } });
    await expect(readFile(corruptPaths.publicKeyPath, 'utf8')).resolves.toBe(publicBefore);
  });

  it('binds the short-lived proof to the runtime port and Desktop attestation', async () => {
    const root = await tempRoot();
    const identity = await loadOrCreateOwnerDeviceIdentity({ authorityRoot: root, safeStorage, restrictAcl: allowTestAcl });
    expect(identity.status).toBe('ready');
    const vendor = generateKeyPairSync('ed25519');
    const request = JSON.parse(await readFile(ownerAuthorityPaths(root).deviceRequestPath, 'utf8'));
    const unsigned = {
      schemaVersion: 1,
      entitlementId: 'owner_desktop_test',
      tier: 'owner',
      devicePublicKeySha256: request.devicePublicKeySha256,
      issuedAt: '2026-08-02T11:00:00.000Z',
      expiresAt: null,
      keyId: 'owner-root-test',
    } as const;
    const entitlement = {
      ...unsigned,
      signature: sign(null, canonicalOwnerAuthorityBytes(unsigned), vendor.privateKey).toString('base64'),
    };
    const publicKeySpkiBase64 = Buffer.from(vendor.publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
    await writeFile(ownerAuthorityPaths(root).entitlementPath, `${JSON.stringify(entitlement)}\n`, { flag: 'wx' });
    const session = await prepareOwnerAuthoritySession({
      authorityRoot: root,
      safeStorage,
      desktopAttestationToken: 'desktop-token',
      runtimePort: 4317,
      now: new Date('2026-08-02T12:00:00.000Z'),
      randomBytesFactory: () => Buffer.alloc(24, 3),
      restrictAcl: async () => true,
      publicKeys: [{ keyId: 'owner-root-test', publicKeySpkiBase64 }],
    });
    const envelope = JSON.parse(Buffer.from(session.environmentValue, 'base64url').toString('utf8'));
    expect(verifyOwnerAuthorityEnvelope(envelope, {
      desktopAttestationToken: 'desktop-token',
      runtimePort: 4317,
      now: new Date('2026-08-02T12:00:30.000Z'),
      publicKeys: [{ keyId: 'owner-root-test', publicKeySpkiBase64 }],
    })).toMatchObject({ tier: 'owner', source: 'signed-device-entitlement' });
    expect(verifyOwnerAuthorityEnvelope(envelope, {
      desktopAttestationToken: 'desktop-token',
      runtimePort: 4318,
      now: new Date('2026-08-02T12:00:30.000Z'),
      publicKeys: [{ keyId: 'owner-root-test', publicKeySpkiBase64 }],
    })).toMatchObject({ tier: 'public', diagnostic: 'owner-proof-runtime-mismatch' });
    expect(session.environmentValue).not.toContain(request.devicePublicKeySha256);
    expect(createHash('sha256').update(session.environmentValue).digest('hex')).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('switches to Public without deleting the Owner identity or entitlement', async () => {
    const root = await tempRoot();
    const identity = await loadOrCreateOwnerDeviceIdentity({ authorityRoot: root, safeStorage, restrictAcl: allowTestAcl });
    expect(identity.status).toBe('ready');
    const paths = ownerAuthorityPaths(root);
    const publicKeyBefore = await readFile(paths.publicKeyPath, 'utf8');
    await expect(setOwnerModeSuspended({ authorityRoot: root, suspended: true, restrictAcl: allowTestAcl }))
      .resolves.toMatchObject({ ok: true, suspended: true });
    await expect(prepareOwnerAuthoritySession({
      authorityRoot: root,
      safeStorage,
      desktopAttestationToken: 'desktop-token',
      runtimePort: 4317,
      restrictAcl: allowTestAcl,
    })).resolves.toMatchObject({ environmentValue: '', summary: { tier: 'public', diagnostic: 'owner-mode-suspended' } });
    await expect(readFile(paths.publicKeyPath, 'utf8')).resolves.toBe(publicKeyBefore);
    await expect(setOwnerModeSuspended({ authorityRoot: root, suspended: false, restrictAcl: allowTestAcl }))
      .resolves.toMatchObject({ ok: true, suspended: false });
  });
});

async function tempRoot(): Promise<string> {
  const base = path.join(process.cwd(), 'runtime');
  const root = await mkdtemp(path.join(base, 'owner-authority-test-'));
  roots.push(root);
  return root;
}
