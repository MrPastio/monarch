import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOwnerDeviceRequest,
  exportOwnerDeviceRequest,
  importOwnerEntitlement,
  readOwnerEnrollmentStatus,
} from '../../desktop/electron/owner-enrollment.mjs';
import { ownerAuthorityPaths } from '../../desktop/electron/owner-authority.mjs';
import { canonicalOwnerAuthorityBytes } from '../../src/authority/owner-authority';

const roots: string[] = [];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8').replace(/^sealed:/u, ''),
};
const allowTestAcl = async () => true;
const now = new Date('2026-08-03T04:00:00.000Z');

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('packaged Owner enrollment', () => {
  it('creates and exports only the public device request', async () => {
    const root = await tempRoot();
    await expect(readOwnerEnrollmentStatus({ authorityRoot: root, safeStorage, now, restrictAcl: allowTestAcl }))
      .resolves.toMatchObject({ deviceStatus: 'absent', requestReady: false });

    const created = await createOwnerDeviceRequest({ authorityRoot: root, safeStorage, now, restrictAcl: allowTestAcl });
    expect(created).toMatchObject({ ok: true, status: { deviceStatus: 'ready', requestReady: true } });
    const transfer = path.join(root, 'transfer');
    await mkdir(transfer);
    const destinationPath = path.join(transfer, 'device-request.json');
    await expect(exportOwnerDeviceRequest({ authorityRoot: root, destinationPath }))
      .resolves.toEqual({ ok: true, fileName: 'device-request.json', alreadyExported: false });

    const request = JSON.parse(await readFile(destinationPath, 'utf8'));
    expect(Object.keys(request).sort()).toEqual([
      'createdAt', 'devicePublicKeySha256', 'devicePublicKeySpkiBase64', 'schemaVersion',
    ]);
    expect(JSON.stringify(request)).not.toMatch(/private|signature|entitlement/iu);
    await expect(stat(ownerAuthorityPaths(root).privateKeyPath)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it('validates, installs and recoverably replaces a current-device entitlement', async () => {
    const root = await tempRoot();
    const vendor = generateKeyPairSync('ed25519');
    const publicKeys = vendorPublicKeys(vendor.publicKey);
    const request = await createRequest(root);
    const transfer = path.join(root, 'transfer');
    await mkdir(transfer);
    const sourcePath = path.join(transfer, 'owner-entitlement.json');
    const first = signedEntitlement(vendor.privateKey, request.devicePublicKeySha256, 'owner_first');
    await writeFile(sourcePath, `${JSON.stringify(first)}\n`);

    const installed = await importOwnerEntitlement({
      authorityRoot: root,
      sourcePath,
      safeStorage,
      now,
      restrictAcl: allowTestAcl,
      publicKeys,
      randomBytesFactory: () => Buffer.alloc(8, 1),
    });
    expect(installed).toMatchObject({
      ok: true,
      restartRequired: true,
      backupCreated: false,
      status: { entitlementStatus: 'valid', entitlementId: 'owner_first' },
    });

    const second = signedEntitlement(vendor.privateKey, request.devicePublicKeySha256, 'owner_second');
    await writeFile(sourcePath, `${JSON.stringify(second)}\n`);
    const replaced = await importOwnerEntitlement({
      authorityRoot: root,
      sourcePath,
      safeStorage,
      now,
      restrictAcl: allowTestAcl,
      publicKeys,
      randomBytesFactory: () => Buffer.alloc(8, 2),
    });
    expect(replaced).toMatchObject({ ok: true, backupCreated: true, status: { entitlementId: 'owner_second' } });
    const files = await readdir(root);
    expect(files.filter((name) => name.startsWith('owner-entitlement.backup-'))).toHaveLength(1);
    expect(JSON.parse(await readFile(ownerAuthorityPaths(root).entitlementPath, 'utf8')))
      .toMatchObject({ entitlementId: 'owner_second' });
  });

  it.each([
    ['wrong device', (vendor: ReturnType<typeof generateKeyPairSync>, fingerprint: string) => (
      signedEntitlement(vendor.privateKey, 'f'.repeat(64), 'owner_wrong_device')
    ), 'owner-device-mismatch'],
    ['bad signature', (_vendor: ReturnType<typeof generateKeyPairSync>, fingerprint: string) => ({
      ...signedEntitlement(generateKeyPairSync('ed25519').privateKey, fingerprint, 'owner_bad_signature'),
    }), 'owner-entitlement-signature-invalid'],
    ['expired', (vendor: ReturnType<typeof generateKeyPairSync>, fingerprint: string) => (
      signedEntitlement(vendor.privateKey, fingerprint, 'owner_expired', '2026-08-03T03:59:59.000Z')
    ), 'owner-entitlement-expired'],
  ])('rejects %s without writing an entitlement', async (_label, build, diagnostic) => {
    const root = await tempRoot();
    const vendor = generateKeyPairSync('ed25519');
    const request = await createRequest(root);
    const transfer = path.join(root, 'transfer');
    await mkdir(transfer);
    const sourcePath = path.join(transfer, 'owner-entitlement.json');
    await writeFile(sourcePath, `${JSON.stringify(build(vendor, request.devicePublicKeySha256))}\n`);

    await expect(importOwnerEntitlement({
      authorityRoot: root,
      sourcePath,
      safeStorage,
      now,
      restrictAcl: allowTestAcl,
      publicKeys: vendorPublicKeys(vendor.publicKey),
    })).resolves.toMatchObject({ ok: false, diagnostic });
    await expect(stat(ownerAuthorityPaths(root).entitlementPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back to the previous entitlement when final ACL verification fails', async () => {
    const root = await tempRoot();
    const vendor = generateKeyPairSync('ed25519');
    const publicKeys = vendorPublicKeys(vendor.publicKey);
    const request = await createRequest(root);
    const transfer = path.join(root, 'transfer');
    await mkdir(transfer);
    const sourcePath = path.join(transfer, 'owner-entitlement.json');
    const original = signedEntitlement(vendor.privateKey, request.devicePublicKeySha256, 'owner_original');
    await writeFile(sourcePath, `${JSON.stringify(original)}\n`);
    await expect(importOwnerEntitlement({
      authorityRoot: root,
      sourcePath,
      safeStorage,
      now,
      restrictAcl: allowTestAcl,
      publicKeys,
    })).resolves.toMatchObject({ ok: true });

    const replacement = signedEntitlement(vendor.privateKey, request.devicePublicKeySha256, 'owner_replacement');
    await writeFile(sourcePath, `${JSON.stringify(replacement)}\n`);
    let aclCalls = 0;
    const failFinalAcl = async () => {
      aclCalls += 1;
      return aclCalls === 1;
    };
    await expect(importOwnerEntitlement({
      authorityRoot: root,
      sourcePath,
      safeStorage,
      now,
      restrictAcl: failFinalAcl,
      publicKeys,
      randomBytesFactory: () => Buffer.alloc(8, 7),
    })).resolves.toMatchObject({ ok: false, diagnostic: 'owner-authority-acl-failed' });
    expect(JSON.parse(await readFile(ownerAuthorityPaths(root).entitlementPath, 'utf8')))
      .toMatchObject({ entitlementId: 'owner_original' });
  });
});

async function createRequest(root: string): Promise<Record<string, string>> {
  const created = await createOwnerDeviceRequest({ authorityRoot: root, safeStorage, now, restrictAcl: allowTestAcl });
  expect(created.ok).toBe(true);
  return JSON.parse(await readFile(ownerAuthorityPaths(root).deviceRequestPath, 'utf8'));
}

function signedEntitlement(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  fingerprint: string,
  entitlementId: string,
  expiresAt: string | null = null,
) {
  const unsigned = {
    schemaVersion: 1,
    entitlementId,
    tier: 'owner',
    devicePublicKeySha256: fingerprint,
    issuedAt: '2026-08-03T03:00:00.000Z',
    expiresAt,
    keyId: 'owner-root-test',
  } as const;
  return {
    ...unsigned,
    signature: sign(null, canonicalOwnerAuthorityBytes(unsigned), privateKey).toString('base64'),
  };
}

function vendorPublicKeys(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']) {
  return [{
    keyId: 'owner-root-test',
    publicKeySpkiBase64: Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64'),
  }];
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), 'runtime', 'owner-enrollment-test-'));
  roots.push(root);
  return root;
}
