import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SafeVault } from '../../desktop/safe/vault.mjs';
import { createSafeCapabilityToken, verifySafeCapabilityToken } from '../../desktop/safe/capability-token.mjs';
import { authorizeSafeFiles } from '../../desktop/electron/safe-file-authorization.mjs';
import { enforceSafeHostLock } from '../../desktop/electron/safe-host-lock.mjs';
import { MAX_SAFE_FILE_BYTES, readBoundedImport } from '../../desktop/safe/limits.mjs';

const roots: string[] = [];
const vaults: SafeVault[] = [];
afterEach(async () => { vaults.forEach((vault) => vault.lock()); vaults.length = 0; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-security-'));
  roots.push(root);
  const vault = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41), autoLockMs: 60_000 });
  vaults.push(vault);
  await vault.initialize();
  await vault.setup({ pin: '1234', pinLength: 4, destructionConfirmed: true });
  await vault.completeSetup({ recoveryAcknowledged: true });
  const section = await vault.createSection({ name: 'Trusted section', color: '#f59e0b' });
  const file = await vault.createFile({ name: 'actual-secret.txt', text: 'old', sectionId: section.id });
  return { root, vault, file };
}

describe('Safe security controls on synthetic data', () => {
  it('rejects the locked settings oracle before verifying any PIN', async () => {
    const { vault } = await fixture();
    vault.lock();
    for (const pin of ['9999', '9999', '9999', '9999', '1234']) {
      await expect(vault.updateSecurityPolicy({ pin, policy: {} })).rejects.toMatchObject({ code: 'vault-locked' });
    }
    expect(vault.status().attemptsRemaining).toBe(3);
    await vault.unlockWithPin('1234');
    await expect(vault.updateSecurityPolicy({ pin: '1234', policy: {} })).resolves.toMatchObject({ unlocked: true });
  });

  it('persists one shared PIN budget across settings, reopen and unlock', async () => {
    const { root, vault } = await fixture();
    await expect(vault.updateSecurityPolicy({ pin: '9999', policy: {} })).rejects.toMatchObject({ code: 'invalid-pin', details: { attemptsRemaining: 2 } });
    vault.lock();
    const reopened = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    vaults.push(reopened);
    await reopened.initialize();
    expect(reopened.status().attemptsRemaining).toBe(2);
    await expect(reopened.unlockWithPin('9999')).rejects.toMatchObject({ code: 'invalid-pin', details: { attemptsRemaining: 1 } });
    await expect(reopened.unlockWithPin('9999')).rejects.toMatchObject({ code: 'vault-wiped' });
    expect(reopened.status()).toMatchObject({ wiped: true, unlocked: false });
  });

  it('uses trusted names and binds exact bytes, MIME, generation and unlock epoch', async () => {
    const { vault, file } = await fixture();
    const key = Buffer.alloc(32, 0x77);
    const bytes = new Uint8Array([1, 2, 3]);
    const prepare = async (payload: any) => vault.getFileActionContext(payload);
    const prompt = vi.fn(async (_options: any) => true);
    const token = await authorizeSafeFiles({ action: 'writeFile', value: { id: file.id, name: 'decoy.txt', bytes }, key, prepare, prompt, isCurrent: () => true });
    expect(prompt.mock.calls[0][0].message).toContain('actual-secret.txt');
    expect(prompt.mock.calls[0][0].message).not.toContain('decoy.txt');
    expect([...bytes]).toEqual([1, 2, 3]);
    const verify = (payload: any) => verifySafeCapabilityToken({ token, key, action: 'writeFile', resourceId: file.id, binding: vault.getFileActionContext({ id: file.id, action: 'writeFile', ...payload }), usedNonces: new Set() });
    expect(verify({ bytes })).toBe(true);
    expect(verify({ bytes: new Uint8Array([9]) })).toBe(false);
    expect(verify({ bytes, mime: 'image/png' })).toBe(false);
    await vault.writeFile({ id: file.id, bytes: new Uint8Array([4]) });
    expect(verify({ bytes })).toBe(false);
    const binding = vault.getFileActionContext({ id: file.id, action: 'deleteFile' });
    const deletion = createSafeCapabilityToken({ key, action: 'deleteFile', resourceId: file.id, binding });
    vault.lock(); await vault.unlockWithPin('1234');
    expect(verifySafeCapabilityToken({ token: deletion, key, action: 'deleteFile', resourceId: file.id, binding: vault.getFileActionContext({ id: file.id, action: 'deleteFile' }) })).toBe(false);
  });

  it('rejects a changed proposal or locked session after native approval', async () => {
    const { vault, file } = await fixture();
    const options = { action: 'deleteFile', value: { id: file.id }, key: Buffer.alloc(32, 0x77), prepare: async (p: any) => vault.getFileActionContext(p), isCurrent: () => true };
    await expect(authorizeSafeFiles({ ...options, prompt: async () => { await vault.writeFile({ id: file.id, text: 'changed' }); return true; } })).rejects.toThrow('proposal-changed');
    await expect(authorizeSafeFiles({ ...options, prompt: async () => { vault.lock(); return true; } })).rejects.toMatchObject({ code: 'vault-locked' });
  });

  it('shows every batch member and rejects invalid/duplicate IDs before approval', async () => {
    const { vault, file } = await fixture();
    const prompt = vi.fn(async (_options: any) => true);
    const options = { action: 'deleteFile', key: Buffer.alloc(32, 0x77), prepare: async (p: any) => vault.getFileActionContext(p), prompt, isCurrent: () => true };
    await expect(authorizeSafeFiles({ ...options, value: { files: [{ id: file.id }, { id: file.id }] } })).rejects.toThrow('invalid-id');
    await expect(authorizeSafeFiles({ ...options, value: { files: [{ id: 'bad-id' }] } })).rejects.toThrow('invalid-id');
    expect(prompt).not.toHaveBeenCalled();
    const files = [file];
    for (let i = 0; i < 5; i++) files.push(await vault.createFile({ name: `member-${i}.txt`, text: 'x', sectionId: file.sectionId }));
    const result = await authorizeSafeFiles({ ...options, value: { files: files.map((f) => ({ id: f.id, name: 'decoy' })) } });
    expect(result.tokens).toHaveLength(6);
    for (const entry of files) expect(prompt.mock.calls[0][0].detail).toContain(entry.id);
  });

  it('locks without renderer acknowledgement and closes captured session on failure', async () => {
    const { vault } = await fixture();
    const close = vi.fn();
    expect(await enforceSafeHostLock({ isCurrent: () => true, requestLock: async () => vault.lock(), notify: () => { throw new Error('renderer stalled'); }, close })).toBe(true);
    expect(vault.status().unlocked).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(await enforceSafeHostLock({ isCurrent: () => true, requestLock: async () => { throw new Error('utility failed'); }, notify: () => {}, close })).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    const requestLock = vi.fn();
    await enforceSafeHostLock({ isCurrent: () => false, requestLock, notify: () => {}, close });
    expect(requestLock).not.toHaveBeenCalled();
  });

  it('rejects oversized imports before arrayBuffer and checks changed sizes', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    for (const size of [MAX_SAFE_FILE_BYTES + 1, -1, NaN, Infinity, 0.5]) {
      await expect(readBoundedImport({ size, arrayBuffer })).rejects.toThrow();
    }
    expect(arrayBuffer).not.toHaveBeenCalled();
    await expect(readBoundedImport({ size: 2, arrayBuffer: async () => new ArrayBuffer(3) })).rejects.toThrow('Размер');
    await expect(readBoundedImport({ size: 3, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer })).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});
