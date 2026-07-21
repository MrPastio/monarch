import { gzipSync } from 'node:zlib';
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeVault } from '../../desktop/safe/vault.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createVault(pin = '1234') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-test-'));
  roots.push(root);
  const vault = new SafeVault(root, { testKdf: true, autoLockMs: 60_000, deviceKey: Buffer.alloc(32, 0x41) });
  await vault.initialize();
  const setup = await vault.setup({ pin, pinLength: pin.length, destructionConfirmed: true });
  await vault.completeSetup({ recoveryAcknowledged: true });
  return { root, vault, setup };
}

async function reopenVault(root: string, runtimeSessionId: string) {
  const vault = new SafeVault(root, {
    testKdf: true,
    autoLockMs: 60_000,
    deviceKey: Buffer.alloc(32, 0x41),
    runtimeSessionId,
  });
  await vault.initialize();
  return vault;
}

async function currentBlobPath(root: string, fileId: string): Promise<string> {
  const matches = (await readdir(path.join(root, 'blobs')))
    .filter((name) => name.startsWith(`${fileId}.`) && name.endsWith('.blob'));
  expect(matches).toHaveLength(1);
  return path.join(root, 'blobs', matches[0]);
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('Monarch Safe adversarial security gates', () => {
  it.each(['1234', '123456', '123456789012'])('accepts and reopens the supported %i-digit PIN policy', async (pin) => {
    const { vault } = await createVault(pin);
    vault.lock();
    await expect(vault.unlockWithPin(pin)).resolves.toMatchObject({ unlocked: true, pinLength: pin.length });
  });

  it.each([9, 12, 24])('creates a checksummed emergency phrase with %i words and never persists it as plaintext', async (wordCount) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-test-'));
    roots.push(root);
    const vault = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await vault.initialize();
    const setup = await vault.setup({
      pin: '1234',
      pinLength: 4,
      emergencyWordCount: wordCount,
      destructionConfirmed: true,
    });
    expect(setup.emergencyPhrase.split(' ')).toHaveLength(wordCount);
    expect(await readFile(path.join(root, 'config.safe.json'), 'utf8')).not.toContain(setup.emergencyPhrase);
  });

  it('1/5 never persists plaintext content and denies reads after lock', async () => {
    const { root, vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    await vault.createFile({ name: 'secret.txt', mime: 'text/plain', text: 'ULTRA_PRIVATE_MARKER_92F1', sectionId });
    const files = await recursiveFiles(root);
    const persisted = Buffer.concat(await Promise.all(files.map((file) => readFile(file)))).toString('latin1');
    expect(persisted).not.toContain('ULTRA_PRIVATE_MARKER_92F1');
    vault.lock();
    expect(() => vault.list()).toThrow(/locked/i);
  });

  it('2/5 wipes only vault data after three wrong PINs and offers a cryptographically fresh setup', async () => {
    const { root, vault, setup: oldSetup } = await createVault();
    const configPath = path.join(root, 'config.safe.json');
    const manifestPath = path.join(root, 'manifest.safe');
    const oldConfig = JSON.parse(await readFile(configPath, 'utf8'));
    const sectionId = vault.list().sections[0].id;
    await vault.createFile({ name: 'target.txt', mime: 'text/plain', text: 'destroy-me', sectionId });
    vault.lock();
    await expect(vault.unlockWithPin('0000')).rejects.toMatchObject({ code: 'invalid-pin' });
    await expect(vault.unlockWithPin('0000')).rejects.toMatchObject({ code: 'invalid-pin' });
    await expect(vault.unlockWithPin('0000')).rejects.toMatchObject({ code: 'vault-wiped' });
    expect(vault.status()).toMatchObject({ configured: false, provisioning: false, wiped: true, setupAvailable: true, unlocked: false });
    expect(await readdir(path.join(root, 'blobs'))).toEqual([]);
    for (const candidate of [manifestPath, `${manifestPath}.previous`, `${manifestPath}.next`]) {
      await expect(readFile(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
    }

    const tombstone = JSON.parse(await readFile(configPath, 'utf8'));
    expect(tombstone).toMatchObject({ status: 'destroyed', vaultId: oldConfig.vaultId, pin: null, recovery: [] });
    expect(JSON.stringify(tombstone)).not.toMatch(/"(?:ciphertext|nonce|salt|tag)"/);
    await expect(vault.unlockWithPin('1234')).rejects.toMatchObject({ code: 'not-configured' });
    await expect(vault.unlockWithRecoveryKey(oldSetup.recoveryKeys[0])).rejects.toMatchObject({ code: 'not-configured' });

    const resetVault = new SafeVault(root, { testKdf: true, autoLockMs: 60_000, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(resetVault.initialize()).resolves.toMatchObject({ wiped: true, setupAvailable: true, configured: false });
    const newSetup = await resetVault.setup({ pin: '5678', pinLength: 4, destructionConfirmed: true });
    const newConfig = JSON.parse(await readFile(configPath, 'utf8'));
    expect(newConfig.vaultId).not.toBe(oldConfig.vaultId);
    expect(new Set([...oldSetup.recoveryKeys, ...newSetup.recoveryKeys]).size).toBe(6);
    await resetVault.completeSetup({ recoveryAcknowledged: true });
    const newSectionId = resetVault.list().sections[0].id;
    await resetVault.createFile({ name: 'new-vault.txt', text: 'new-generation', sectionId: newSectionId });
    resetVault.lock();
    await writeFile(`${configPath}.previous`, JSON.stringify(tombstone), 'utf8');

    const oldCredentialProbe = new SafeVault(root, { testKdf: true, autoLockMs: 60_000, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(oldCredentialProbe.initialize()).resolves.toMatchObject({ configured: true, wiped: false });
    await expect(oldCredentialProbe.unlockWithPin('1234')).rejects.toMatchObject({ code: 'invalid-pin' });
    await expect(oldCredentialProbe.unlockWithRecoveryKey(oldSetup.recoveryKeys[0])).rejects.toMatchObject({ code: 'invalid-recovery-key' });
    await expect(oldCredentialProbe.unlockWithPin('5678')).resolves.toMatchObject({ unlocked: true });
    expect(oldCredentialProbe.list().files).toEqual([expect.objectContaining({ name: 'new-vault.txt' })]);
    oldCredentialProbe.lock();

    const newRecoveryProbe = new SafeVault(root, { testKdf: true, autoLockMs: 60_000, deviceKey: Buffer.alloc(32, 0x41) });
    await newRecoveryProbe.initialize();
    await expect(newRecoveryProbe.unlockWithRecoveryKey(newSetup.recoveryKeys[0])).resolves.toMatchObject({ unlocked: true, recoveryKeysRemaining: 2 });
  });

  it('3/5 enforces one recovery attempt per runtime and consumes a successful key permanently', async () => {
    const { root, vault, setup } = await createVault();
    vault.lock();
    await expect(vault.unlockWithRecoveryKey('AAAA-AAAA-AAAA-AAAA-AAAA')).rejects.toMatchObject({ code: 'invalid-recovery-key' });
    await expect(vault.unlockWithRecoveryKey(setup.recoveryKeys[0])).rejects.toMatchObject({ code: 'recovery-attempt-used' });
    const restarted = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await restarted.initialize();
    await expect(restarted.unlockWithRecoveryKey(setup.recoveryKeys[0])).resolves.toMatchObject({ unlocked: true, recoveryKeysRemaining: 2 });
    restarted.lock();
    const restartedAgain = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await restartedAgain.initialize();
    await expect(restartedAgain.unlockWithRecoveryKey(setup.recoveryKeys[0])).rejects.toMatchObject({ code: 'invalid-recovery-key' });
  });

  it('arms the emergency phrase only after two distinct clean PIN sessions and durably consumes a wrong phrase attempt', async () => {
    const { root, vault, setup } = await createVault();
    expect(setup.emergencyPhrase.split(' ')).toHaveLength(12);
    expect(await readFile(path.join(root, 'config.safe.json'), 'utf8')).not.toContain(setup.emergencyPhrase);
    vault.lock();

    const firstClean = await reopenVault(root, 'clean-session-a');
    await expect(firstClean.unlockWithPin('1234')).resolves.toMatchObject({ emergencyCleanSessions: 1, emergencyArmed: false });
    firstClean.lock();
    await expect(firstClean.unlockWithPin('1234')).resolves.toMatchObject({ emergencyCleanSessions: 1, emergencyArmed: false });
    firstClean.lock();

    const secondClean = await reopenVault(root, 'clean-session-b');
    await expect(secondClean.unlockWithPin('1234')).resolves.toMatchObject({ emergencyCleanSessions: 2, emergencyArmed: true });
    secondClean.lock();

    const lockout = await reopenVault(root, 'lockout-session-c');
    await expect(lockout.unlockWithPin('0000')).rejects.toMatchObject({ code: 'invalid-pin' });
    expect(lockout.status()).toMatchObject({ attemptsRemaining: 2, emergencyRecoveryOffered: false });
    await expect(lockout.unlockWithPin('0000')).rejects.toMatchObject({ code: 'invalid-pin' });
    expect(lockout.status()).toMatchObject({ attemptsRemaining: 1, emergencyRecoveryOffered: true, emergencyAttemptAvailable: true });

    await expect(lockout.unlockWithEmergencyPhrase('wrong phrase')).rejects.toMatchObject({ code: 'invalid-emergency-phrase' });
    expect(lockout.status()).toMatchObject({ attemptsRemaining: 1, emergencyRecoveryOffered: false, emergencyAttemptAvailable: false });

    const restarted = await reopenVault(root, 'lockout-session-d');
    expect(restarted.status()).toMatchObject({ attemptsRemaining: 1, emergencyRecoveryOffered: false, emergencyAttemptAvailable: false });
    await expect(restarted.unlockWithEmergencyPhrase(setup.emergencyPhrase)).rejects.toMatchObject({ code: 'emergency-attempt-used' });
    await expect(restarted.unlockWithPin('1234')).resolves.toMatchObject({ unlocked: true, emergencyCleanSessions: 0, emergencyArmed: false });
  });

  it('opens the whole Safe with a valid emergency phrase while keeping the final PIN attempt intact on failure', async () => {
    const { root, vault, setup } = await createVault();
    vault.lock();
    const firstClean = await reopenVault(root, 'phrase-clean-a');
    await firstClean.unlockWithPin('1234');
    firstClean.lock();
    const secondClean = await reopenVault(root, 'phrase-clean-b');
    await secondClean.unlockWithPin('1234');
    secondClean.lock();

    const recovery = await reopenVault(root, 'phrase-lockout-c');
    await expect(recovery.unlockWithPin('0000')).rejects.toMatchObject({ code: 'invalid-pin' });
    await expect(recovery.unlockWithPin('0000')).rejects.toMatchObject({ code: 'invalid-pin' });
    await expect(recovery.unlockWithEmergencyPhrase(setup.emergencyPhrase)).resolves.toMatchObject({
      unlocked: true,
      attemptsRemaining: 3,
      emergencyCleanSessions: 0,
      emergencyArmed: false,
      emergencyRecoveryOffered: false,
    });
    expect(recovery.list().sections.length).toBeGreaterThan(0);
  });

  it('4/5 rejects a single-byte ciphertext modification before returning any content', async () => {
    const { root, vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    const file = await vault.createFile({ name: 'integrity.txt', mime: 'text/plain', text: 'authenticated', sectionId });
    const blobPath = await currentBlobPath(root, file.id);
    const blob = await readFile(blobPath);
    blob[blob.length - 1] ^= 0xff;
    await writeFile(blobPath, blob);
    await expect(vault.readFile({ id: file.id })).rejects.toMatchObject({ code: 'file-integrity-failed' });
  });

  it('5/5 rejects archive traversal names before creating extracted files', async () => {
    const { vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    const descriptors = Buffer.from(JSON.stringify([{ name: '../escape.txt', mime: 'text/plain', size: 1, offset: 0 }]));
    const header = Buffer.alloc(10);
    Buffer.from('MSAR01').copy(header, 0);
    header.writeUInt32BE(descriptors.length, 6);
    const malicious = gzipSync(Buffer.concat([header, descriptors, Buffer.from('x')]));
    const archive = await vault.importFile({ name: 'malicious.msa', mime: 'application/x-monarch-safe-archive', bytes: malicious, sectionId });
    await expect(vault.extractArchive({ id: archive.id, sectionId })).rejects.toMatchObject({ code: 'invalid-name' });
    expect(vault.list().files).toHaveLength(1);
  });

  it('rejects negative archive bounds and unreferenced trailing payload bytes', async () => {
    const { vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    for (const [name, descriptors, payload] of [
      ['negative.msa', [{ name: 'negative.txt', mime: 'text/plain', size: -1, offset: 0 }], Buffer.alloc(0)],
      ['trailing.msa', [{ name: 'one.txt', mime: 'text/plain', size: 1, offset: 0 }], Buffer.from('xy')],
    ] as const) {
      const descriptorBytes = Buffer.from(JSON.stringify(descriptors));
      const header = Buffer.alloc(10);
      Buffer.from('MSAR01').copy(header, 0);
      header.writeUInt32BE(descriptorBytes.length, 6);
      const archive = await vault.importFile({ name, mime: 'application/x-monarch-safe-archive', bytes: gzipSync(Buffer.concat([header, descriptorBytes, payload])), sectionId });
      await expect(vault.extractArchive({ id: archive.id, sectionId })).rejects.toMatchObject({ code: 'invalid-archive' });
    }
    expect(vault.list().files).toHaveLength(2);
  });

  it('rejects encrypted blobs whose actual length exceeds authenticated metadata', async () => {
    const { root, vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    const file = await vault.createFile({ name: 'length.txt', text: 'bounded', sectionId });
    const blobPath = await currentBlobPath(root, file.id);
    const blob = await readFile(blobPath);
    await writeFile(blobPath, Buffer.concat([blob, Buffer.from([0])]))
    await expect(vault.readFile({ id: file.id })).rejects.toMatchObject({ code: 'file-integrity-failed' });
  });

  it('rotates a random per-file key on write and never exposes its envelope through the public manifest', async () => {
    const { root, vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    const file = await vault.createFile({ name: 'rotating.txt', text: 'version-one', sectionId });
    const firstBlobPath = await currentBlobPath(root, file.id);
    const firstGeneration = await readFile(firstBlobPath);
    expect(vault.list().files[0]).not.toHaveProperty('keyEnvelope');
    expect(vault.list().files[0]).not.toHaveProperty('blobId');

    await vault.writeFile({ id: file.id, text: 'version-two' });
    const secondBlobPath = await currentBlobPath(root, file.id);
    expect(secondBlobPath).not.toBe(firstBlobPath);
    await writeFile(secondBlobPath, firstGeneration);
    await expect(vault.readFile({ id: file.id })).rejects.toMatchObject({ code: 'file-integrity-failed' });
  });

  it('binds PIN unlock to the protected device secret while recovery keys remain usable', async () => {
    const { root, vault, setup } = await createVault();
    vault.lock();
    const copiedDevice = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x42) });
    await copiedDevice.initialize();
    await expect(copiedDevice.unlockWithPin('1234')).rejects.toMatchObject({ code: 'vault-config-integrity-failed' });
    expect(copiedDevice.status()).toMatchObject({ attemptsRemaining: 3, pinUnlockAvailable: false });

    const recovered = new SafeVault(root, { testKdf: true });
    await recovered.initialize();
    await expect(recovered.unlockWithPin('1234')).rejects.toMatchObject({ code: 'device-binding-unavailable' });
    await expect(recovered.unlockWithRecoveryKey(setup.recoveryKeys[0])).resolves.toMatchObject({ unlocked: true });
  });

  it('blocks setup over corrupt configuration artifacts and preserves existing ciphertext', async () => {
    const { root, vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    await vault.createFile({ name: 'preserve.txt', text: 'must-survive-config-error', sectionId });
    vault.lock();
    await writeFile(path.join(root, 'config.safe.json'), '{"version":1,"status":"active"', 'utf8');

    const reopened = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(reopened.initialize()).resolves.toMatchObject({ blocked: true, blockReason: 'vault-config-invalid' });
    await expect(reopened.setup({ pin: '9999', pinLength: 4, destructionConfirmed: true })).rejects.toMatchObject({ code: 'vault-config-invalid' });
    expect((await readdir(path.join(root, 'blobs'))).filter((name) => name.endsWith('.blob'))).toHaveLength(1);
  });

  it('blocks setup when encrypted payloads survive but every config candidate is missing', async () => {
    const { root, vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    const file = await vault.createFile({ name: 'orphaned-config.txt', text: 'preserve-ciphertext', sectionId });
    const blobPath = await currentBlobPath(root, file.id);
    const before = await readFile(blobPath);
    vault.lock();
    await rm(path.join(root, 'config.safe.json'), { force: true });
    await rm(path.join(root, 'config.safe.json.previous'), { force: true });
    await rm(path.join(root, 'config.safe.json.next'), { force: true });

    const reopened = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(reopened.initialize()).resolves.toMatchObject({ blocked: true, blockReason: 'vault-config-missing' });
    await expect(reopened.setup({ pin: '9999', pinLength: 4, destructionConfirmed: true })).rejects.toMatchObject({ code: 'vault-config-missing' });
    expect(await readFile(blobPath)).toEqual(before);
  });

  it('does not count a KDF runtime failure as an incorrect PIN or destroy the vault', async () => {
    const { root, vault } = await createVault();
    vault.lock();
    const configPath = path.join(root, 'config.safe.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.pin.kdf = { name: 'scrypt', N: 2 ** 20, r: 32, p: 8, maxmem: 4 * 1024 * 1024 };
    await writeFile(configPath, JSON.stringify(config), 'utf8');

    const reopened = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await reopened.initialize();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(reopened.unlockWithPin('1234')).rejects.not.toMatchObject({ code: 'invalid-pin' });
    }
    expect(reopened.status()).toMatchObject({ wiped: false, attemptsRemaining: 3 });
  });

  it('blocks PIN attempts when the device-sealed PIN envelope is modified and preserves recovery', async () => {
    const { root, vault, setup } = await createVault();
    vault.lock();
    const configPath = path.join(root, 'config.safe.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.pin.ciphertext = `${config.pin.ciphertext.slice(0, -2)}AA`;
    await writeFile(configPath, JSON.stringify(config), 'utf8');

    const reopened = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(reopened.initialize()).resolves.toMatchObject({ pinIntegrity: 'failed', pinUnlockAvailable: false });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(reopened.unlockWithPin('1234')).rejects.toMatchObject({ code: 'vault-config-integrity-failed' });
    }
    expect(reopened.status()).toMatchObject({ wiped: false, attemptsRemaining: 3, recoveryKeysRemaining: 3 });
    await expect(reopened.unlockWithRecoveryKey(setup.recoveryKeys[0])).resolves.toMatchObject({ unlocked: true, recoveryKeysRemaining: 2 });
  });

  it('upgrades an unsealed pre-release config only after a successful PIN unlock', async () => {
    const { root, vault } = await createVault();
    vault.lock();
    const configPath = path.join(root, 'config.safe.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.deviceSeal;
    await writeFile(configPath, JSON.stringify(config), 'utf8');

    const reopened = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(reopened.initialize()).resolves.toMatchObject({ pinIntegrity: 'legacy', attemptsRemaining: 3 });
    await expect(reopened.unlockWithPin('1234')).resolves.toMatchObject({ unlocked: true, pinIntegrity: 'valid' });
    expect(JSON.parse(await readFile(configPath, 'utf8')).deviceSeal).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('lets recovery without the device binding invalidate the stale seal and reseal on the original device', async () => {
    const { root, vault, setup } = await createVault();
    vault.lock();
    const portableRecovery = new SafeVault(root, { testKdf: true });
    await portableRecovery.initialize();
    await expect(portableRecovery.unlockWithRecoveryKey(setup.recoveryKeys[0])).resolves.toMatchObject({ unlocked: true });
    portableRecovery.lock();

    const originalDevice = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(originalDevice.initialize()).resolves.toMatchObject({ pinIntegrity: 'legacy', attemptsRemaining: 3 });
    await expect(originalDevice.unlockWithPin('1234')).resolves.toMatchObject({ unlocked: true, pinIntegrity: 'valid', recoveryKeysRemaining: 2 });
  });

  it('prefers a newer recovery-consumption config over an older valid-sealed atomic sibling', async () => {
    const { root, vault, setup } = await createVault();
    vault.lock();
    const configPath = path.join(root, 'config.safe.json');
    const oldValid = await readFile(configPath);
    const portableRecovery = new SafeVault(root, { testKdf: true });
    await portableRecovery.initialize();
    await portableRecovery.unlockWithRecoveryKey(setup.recoveryKeys[0]);
    portableRecovery.lock();
    await writeFile(`${configPath}.previous`, oldValid);

    const reopened = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(reopened.initialize()).resolves.toMatchObject({ recoveryKeysRemaining: 2, pinIntegrity: 'legacy' });
  });

  it('never resurrects an active config over a newer wipe tombstone with a damaged seal', async () => {
    const { root, vault } = await createVault();
    const configPath = path.join(root, 'config.safe.json');
    const oldActive = await readFile(configPath);
    await vault.destroy('test-destruction');
    const wiped = JSON.parse(await readFile(configPath, 'utf8'));
    wiped.deviceSeal = `${wiped.deviceSeal.slice(0, -2)}AA`;
    await writeFile(configPath, JSON.stringify(wiped), 'utf8');
    await writeFile(`${configPath}.previous`, oldActive);

    const reopened = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(reopened.initialize()).resolves.toMatchObject({ wiped: true, configured: false, setupAvailable: true });
  });

  it('keeps setup pending until recovery acknowledgement and safely resets an interrupted empty provisioning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-test-'));
    roots.push(root);
    const deviceKey = Buffer.alloc(32, 0x51);
    const vault = new SafeVault(root, { testKdf: true, deviceKey });
    await vault.initialize();
    await expect(vault.setup({ pin: '1234', pinLength: 4, destructionConfirmed: true })).resolves.toMatchObject({ provisioning: true, configured: false });
    expect(() => vault.list()).toThrow(/not configured/i);
    vault.lock();

    const reopened = new SafeVault(root, { testKdf: true, deviceKey });
    await expect(reopened.initialize()).resolves.toMatchObject({ provisioning: true, configured: false });
    await expect(reopened.setup({ pin: '5678', pinLength: 4, destructionConfirmed: true })).rejects.toMatchObject({ code: 'already-configured' });
    await expect(reopened.resetProvisioning()).resolves.toMatchObject({ provisioning: false, configured: false, blocked: false });
    expect((await readdir(path.join(root, 'blobs'))).filter((name) => name.endsWith('.blob'))).toHaveLength(0);
    await expect(reopened.setup({ pin: '5678', pinLength: 4, destructionConfirmed: true })).resolves.toMatchObject({ provisioning: true });
  });

  it('defers auto-lock until an in-flight generation commit finishes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-test-'));
    roots.push(root);
    let pauseBlobWrite = false;
    let releaseBlobWrite: (() => void) | null = null;
    let markBlobWriteEntered: (() => void) | null = null;
    const blobWriteEntered = new Promise<void>((resolve) => { markBlobWriteEntered = resolve; });
    const blobWriteGate = new Promise<void>((resolve) => { releaseBlobWrite = resolve; });
    let autoLockEvents = 0;
    const vault = new SafeVault(root, {
      testKdf: true,
      autoLockMs: 20,
      deviceKey: Buffer.alloc(32, 0x61),
      onAutoLock: () => { autoLockEvents += 1; },
      beforeAtomicReplace: async (targetPath: string) => {
        if (!pauseBlobWrite || !targetPath.endsWith('.blob')) return;
        markBlobWriteEntered?.();
        await blobWriteGate;
      },
    });
    await vault.initialize();
    const setup = await vault.setup({ pin: '1234', pinLength: 4, destructionConfirmed: true });
    expect(setup.recoveryKeys).toHaveLength(3);
    await vault.completeSetup({ recoveryAcknowledged: true });
    const sectionId = vault.list().sections[0].id;
    const file = await vault.createFile({ name: 'lease.txt', text: 'before', sectionId });

    pauseBlobWrite = true;
    const write = vault.writeFile({ id: file.id, text: 'after' });
    await blobWriteEntered;
    await delay(60);
    expect(vault.status()).toMatchObject({ unlocked: true });
    expect(autoLockEvents).toBe(0);
    releaseBlobWrite?.();
    await write;
    await expect(vault.readFile({ id: file.id })).resolves.toMatchObject({ bytes: new Uint8Array(Buffer.from('after')) });
    await delay(60);
    expect(vault.status()).toMatchObject({ unlocked: false });
    expect(autoLockEvents).toBe(1);
  });

  it('renews the authoritative auto-lock lease on explicit user activity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-test-'));
    roots.push(root);
    const vault = new SafeVault(root, {
      testKdf: true,
      autoLockMs: 40,
      deviceKey: Buffer.alloc(32, 0x63),
    });
    await vault.initialize();
    await vault.setup({ pin: '1234', pinLength: 4, destructionConfirmed: true });
    await vault.completeSetup({ recoveryAcknowledged: true });

    await delay(25);
    await expect(vault.touch()).resolves.toMatchObject({ unlocked: true });
    await delay(25);
    expect(vault.status()).toMatchObject({ unlocked: true });
    await delay(35);
    expect(vault.status()).toMatchObject({ unlocked: false });
  });

  it('keeps the previous active generation readable when a manifest commit fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-test-'));
    roots.push(root);
    let failManifestCommit = false;
    const vault = new SafeVault(root, {
      testKdf: true,
      autoLockMs: 60_000,
      deviceKey: Buffer.alloc(32, 0x62),
      beforeAtomicReplace: async (targetPath: string) => {
        if (failManifestCommit && targetPath.endsWith('manifest.safe')) throw new Error('synthetic manifest commit failure');
      },
    });
    await vault.initialize();
    await vault.setup({ pin: '1234', pinLength: 4, destructionConfirmed: true });
    await vault.completeSetup({ recoveryAcknowledged: true });
    const sectionId = vault.list().sections[0].id;
    const file = await vault.createFile({ name: 'transaction.txt', text: 'stable-version', sectionId });
    const activeBlobBefore = await currentBlobPath(root, file.id);

    failManifestCommit = true;
    await expect(vault.writeFile({ id: file.id, text: 'rejected-version' })).rejects.toThrow('synthetic manifest commit failure');
    failManifestCommit = false;
    expect(await currentBlobPath(root, file.id)).toBe(activeBlobBefore);
    const restored = await vault.readFile({ id: file.id });
    expect(Buffer.from(restored.bytes).toString('utf8')).toBe('stable-version');
  });

  it('recovers the newest authenticated manifest sibling after an interrupted replace', async () => {
    const { root, vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    const file = await vault.createFile({ name: 'recover.txt', text: 'version-one', sectionId });
    const manifestPath = path.join(root, 'manifest.safe');
    const oldManifest = await readFile(manifestPath);
    await vault.writeFile({ id: file.id, text: 'version-two' });
    const newManifest = await readFile(manifestPath);
    vault.lock();
    await writeFile(manifestPath, oldManifest);
    await writeFile(`${manifestPath}.next`, newManifest);

    const reopened = new SafeVault(root, { testKdf: true, autoLockMs: 60_000, deviceKey: Buffer.alloc(32, 0x41) });
    await reopened.initialize();
    await reopened.unlockWithPin('1234');
    const recovered = await reopened.readFile({ id: file.id });
    expect(Buffer.from(recovered.bytes).toString('utf8')).toBe('version-two');
  });

  it('requires the current PIN and explicit acknowledgement before lowering security settings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-test-'));
    roots.push(root);
    const vault = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await vault.initialize();
    await vault.setup({ pin: '1234', pinLength: 4, destructionConfirmed: true });
    await vault.completeSetup({ recoveryAcknowledged: true });
    const lowPolicy = {
      autoLockMs: 0,
      clipboardMode: 'read-write',
      minimizeAction: 'keep-unlocked',
      lockOnBlur: false,
      clearClipboardOnLock: false,
    };

    await expect(vault.updateSecurityPolicy({ pin: '9999', policy: lowPolicy, lowSecurityAcknowledged: true }))
      .rejects.toMatchObject({ code: 'invalid-pin' });
    expect(vault.status().attemptsRemaining).toBe(3);
    await expect(vault.updateSecurityPolicy({ pin: '1234', policy: lowPolicy }))
      .rejects.toMatchObject({ code: 'low-security-acknowledgement-required' });
    await expect(vault.updateSecurityPolicy({ pin: '1234', policy: lowPolicy, lowSecurityAcknowledged: true }))
      .resolves.toMatchObject({ securityLevel: 'low', securityPolicy: lowPolicy, autoLockMs: 0 });

    vault.lock();
    const reopened = new SafeVault(root, { testKdf: true, deviceKey: Buffer.alloc(32, 0x41) });
    await expect(reopened.initialize()).resolves.toMatchObject({ securityLevel: 'low', securityPolicy: lowPolicy, autoLockMs: 0 });
  });

  it('renames and removes empty containers while preserving non-empty boundaries', async () => {
    const { vault } = await createVault();
    const section = await vault.createSection({ name: 'Проект', color: '#f59e0b' });
    const folder = await vault.createFolder({ name: 'Черновики', sectionId: section.id });
    await expect(vault.updateFolder({ id: folder.id, name: 'Финальные' })).resolves.toMatchObject({ name: 'Финальные' });
    await vault.createFile({ name: 'plan.txt', text: 'safe', sectionId: section.id, folderId: folder.id });
    await expect(vault.deleteFolder({ id: folder.id })).rejects.toMatchObject({ code: 'folder-not-empty' });
    await expect(vault.deleteSection({ id: section.id })).rejects.toMatchObject({ code: 'section-not-empty' });
  });

  it('unlinks a hostile hardlink without overwriting the linked victim during file deletion', async () => {
    const { root, vault } = await createVault();
    const sectionId = vault.list().sections[0].id;
    const file = await vault.createFile({ name: 'delete-me.txt', text: 'ciphertext', sectionId });
    const blobPath = await currentBlobPath(root, file.id);
    const victimPath = path.join(root, 'victim.txt');
    const marker = Buffer.from('DO_NOT_OVERWRITE_THIS_FILE', 'utf8');
    await writeFile(victimPath, marker);
    await rm(blobPath);
    await link(victimPath, blobPath);

    await expect(vault.deleteFile({ id: file.id })).resolves.toMatchObject({ deleted: true });
    await expect(readFile(victimPath)).resolves.toEqual(marker);
    await expect(readFile(blobPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function recursiveFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await recursiveFiles(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}
