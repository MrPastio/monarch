import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without type declarations
import { createProfileDataKeyStore } from '../../desktop/electron/profile-data-key.mjs';
import {
  createProfileKeyRecovery, generateRecoveryCode, normalizeRecoveryCode, profileKeyId, wantsCopy,
  // @ts-expect-error -- plain ESM module without type declarations
} from '../../desktop/electron/profile-key-recovery.mjs';
import { SafeVault } from '../../desktop/safe/vault.mjs';

/** Monarch Security 3f: copies of the profile data key in Monarch Safe and
 * behind a recovery code. Only temporary vaults and fake OS encryption. */

const roots: string[] = [];
const tempRoot = async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'monarch-key-recovery-')); roots.push(dir); return dir; };
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const fakeSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from('enc:' + Buffer.from(value).toString('hex')),
  decryptString: (bytes: Buffer) => {
    const text = bytes.toString();
    if (!text.startsWith('enc:')) throw Error('bad');
    return Buffer.from(text.slice(4), 'hex').toString();
  },
});

async function createVault(root: string, deviceByte = 0x73) {
  const vault = new SafeVault(root, { testKdf: true, autoLockMs: 60_000, deviceKey: Buffer.alloc(32, deviceByte) });
  await vault.initialize();
  return vault;
}

describe('recovery codes', () => {
  it('are 25 characters in five groups and forgive case, spaces and look-alikes', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/u);
    expect(normalizeRecoveryCode(code.toLowerCase().replaceAll('-', ' '))).toBe(code.replaceAll('-', ''));
    expect(normalizeRecoveryCode('OOOOO-IIIII-LLLLL-00000-11111')).toBe('0000011111111110000011111');
    expect(() => normalizeRecoveryCode('short')).toThrow('profile-key-recovery:code-format');
  });

  it('follow the level the person chose', () => {
    expect(['safe-and-code', 'safe', 'code', 'none'].map(level => [wantsCopy(level, 'safe'), wantsCopy(level, 'code')]))
      .toEqual([[true, true], [true, false], [false, true], [false, false]]);
  });
});

describe('copy behind a recovery code', () => {
  it('opens with the code only and keeps the key out of the file', async () => {
    const dataRoot = await tempRoot();
    const recovery = createProfileKeyRecovery({ dataRoot });
    const key = randomBytes(32);
    const code = generateRecoveryCode();
    await recovery.writeCodeCopy(key, code);
    const file = await readFile(path.join(dataRoot, 'profile-data-key.code-backup.json'));
    expect(file.includes(key)).toBe(false);
    expect(file.includes(Buffer.from(key.toString('base64')))).toBe(false);
    expect(file.toString()).not.toContain(code.replaceAll('-', ''));
    expect((await recovery.openCodeCopy(code)).equals(key)).toBe(true);
    await expect(recovery.openCodeCopy(generateRecoveryCode())).rejects.toThrow('profile-key-recovery:wrong-secret');
    expect(await recovery.status(key)).toMatchObject({ code: { present: true, current: true }, safe: { present: false } });
    expect((await recovery.status(randomBytes(32))).code.current).toBe(false);
  }, 30_000);
});

describe('copy in Monarch Safe', () => {
  it('opens after a PIN unlock and after a recovery-key unlock on another device', async () => {
    const safeRoot = await tempRoot();
    const dataRoot = await tempRoot();
    const vault = await createVault(safeRoot);
    const setup = await vault.setup({ pin: '1234', pinLength: 4, destructionConfirmed: true }) as { recoveryKeys: string[] };
    await vault.completeSetup({ recoveryAcknowledged: true });
    const recovery = createProfileKeyRecovery({ dataRoot });
    const key = randomBytes(32);
    const wrapping = vault.profileKeyBackupKey();
    await recovery.writeSafeCopy(key, wrapping);
    const file = await readFile(path.join(dataRoot, 'profile-data-key.safe-backup.json'));
    expect(file.includes(key)).toBe(false);
    expect(file.toString()).not.toContain(wrapping.key);
    vault.lock();
    expect(() => vault.profileKeyBackupKey()).toThrow();

    // A reinstalled system: another device key, the Safe opens with a recovery key.
    const moved = await createVault(safeRoot, 0x29);
    await moved.unlockWithRecoveryKey(setup.recoveryKeys[0]!);
    expect((await recovery.openSafeCopy(moved.profileKeyBackupKey())).equals(key)).toBe(true);
    await expect(recovery.openSafeCopy({ ...moved.profileKeyBackupKey(), key: randomBytes(32).toString('base64') }))
      .rejects.toThrow('profile-key-recovery:wrong-secret');
    await expect(recovery.openSafeCopy({ ...moved.profileKeyBackupKey(), vaultId: 'another-vault-0000' }))
      .rejects.toThrow('profile-key-recovery:other-safe');
  }, 30_000);

  it('removes copies the chosen level does not ask for', async () => {
    const dataRoot = await tempRoot();
    const recovery = createProfileKeyRecovery({ dataRoot });
    const key = randomBytes(32);
    await recovery.writeCodeCopy(key, generateRecoveryCode());
    await recovery.writeSafeCopy(key, { vaultId: 'vault-1234-abcd', key: randomBytes(32).toString('base64') });
    await recovery.removeUnwanted('safe');
    expect((await readdir(dataRoot)).sort()).toEqual(['profile-data-key.safe-backup.json']);
    await recovery.removeUnwanted('none');
    expect(await readdir(dataRoot)).toEqual([]);
  }, 30_000);
});

describe('restoring the profile data key', () => {
  it('does not make a new key when a copy exists, and restores the lost one', async () => {
    const dataRoot = await tempRoot();
    const recovery = createProfileKeyRecovery({ dataRoot });
    const options = { dataRoot, safeStorage: fakeSafeStorage(), recoveryAvailable: () => recovery.hasAnyCopy() };
    const original = await createProfileDataKeyStore(options).load();
    const code = generateRecoveryCode();
    await recovery.writeCodeCopy(original.key, code);

    await rm(path.join(dataRoot, 'profile-data-key.encrypted'));
    await expect(createProfileDataKeyStore(options).load()).rejects.toThrow('profile-data-key:needs-recovery');

    const store = createProfileDataKeyStore(options);
    await expect(store.restore(await recovery.openCodeCopy(code))).resolves.toEqual({ restored: true });
    expect((await createProfileDataKeyStore(options).load()).key.equals(original.key)).toBe(true);
    expect(profileKeyId((await store.load()).key)).toBe(profileKeyId(original.key));
  }, 30_000);

  it('keeps a damaged record aside and refuses to replace a readable record with another key', async () => {
    const dataRoot = await tempRoot();
    const store = createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage() });
    const original = await store.load();
    await expect(createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage() }).restore(randomBytes(32)))
      .rejects.toThrow('profile-data-key:different-key');

    await writeFile(path.join(dataRoot, 'profile-data-key.encrypted'), 'damaged');
    await createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage() }).restore(original.key);
    const names = await readdir(dataRoot);
    expect(names.some(name => name.startsWith('profile-data-key.encrypted.damaged-'))).toBe(true);
    expect((await createProfileDataKeyStore({ dataRoot, safeStorage: fakeSafeStorage() }).load()).key.equals(original.key)).toBe(true);
  });
});
