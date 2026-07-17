import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateSafeDeviceKey } from '../../desktop/safe/device-binding.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-device-'));
  roots.push(root);
  return root;
}

const protectedStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5),
  decryptString: (value: Buffer) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString('utf8'),
};

describe('Monarch Safe protected device binding', () => {
  it('persists only the protected form and reopens the same device key', async () => {
    const root = await tempRoot();
    const expected = Buffer.alloc(32, 0x5a);
    const first = await loadOrCreateSafeDeviceKey({ rootPath: root, safeStorage: protectedStorage, randomBytesFactory: () => expected });
    const persisted = await readFile(path.join(root, 'device-key.safe'));
    expect(persisted.toString('utf8')).not.toContain(expected.toString('base64'));
    const reopened = await loadOrCreateSafeDeviceKey({ rootPath: root, safeStorage: protectedStorage });
    expect(first).toEqual(expected);
    expect(reopened).toEqual(expected);
  });

  it('fails closed when operating-system encryption is unavailable', async () => {
    const root = await tempRoot();
    await expect(loadOrCreateSafeDeviceKey({ rootPath: root, safeStorage: { isEncryptionAvailable: () => false } })).resolves.toBeNull();
  });

  it('does not silently replace a corrupt protected binding', async () => {
    const root = await tempRoot();
    const bindingPath = path.join(root, 'device-key.safe');
    await writeFile(bindingPath, 'corrupt-binding', 'utf8');
    await expect(loadOrCreateSafeDeviceKey({ rootPath: root, safeStorage: protectedStorage })).resolves.toBeNull();
    await expect(readFile(bindingPath, 'utf8')).resolves.toBe('corrupt-binding');
  });
});
