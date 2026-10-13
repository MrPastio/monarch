import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Sealed files: AES-256-GCM envelopes for runtime stores (Monarch Security
 * stage 3). A store key comes from the profile data key that only Desktop
 * holds; this module never sees that key, only a store key derived from it.
 *
 * Layout: magic "MSF1" | nonce (12) | ciphertext | tag (16). The additional
 * data binds the format version, the store and the file name, so a sealed file
 * cannot be swapped between stores or renamed to another record. */

const MAGIC = Buffer.from('MSF1', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const STORE_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export class SealedFileError extends Error {
  constructor(readonly code: 'key' | 'store' | 'format' | 'authentication') {
    super(`sealed-file:${code}`);
  }
}

/** HKDF-SHA256 store key; the same derivation as Desktop's profile data key. */
export function deriveStoreKey(profileDataKey: Uint8Array, storeId: string): Buffer {
  if (profileDataKey.byteLength !== KEY_BYTES) throw new SealedFileError('key');
  if (!STORE_ID.test(storeId)) throw new SealedFileError('store');
  return Buffer.from(hkdfSync('sha256', profileDataKey, Buffer.alloc(0), `monarch.store.v1/${storeId}`, KEY_BYTES));
}

function additionalData(storeId: string, name: string): Buffer {
  if (!STORE_ID.test(storeId)) throw new SealedFileError('store');
  return Buffer.from(`monarch.sealed-file.v1\0${storeId}\0${name}`, 'utf8');
}

export function isSealed(bytes: Uint8Array): boolean {
  return bytes.byteLength >= MAGIC.length + NONCE_BYTES + TAG_BYTES
    && Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC);
}

export function sealBytes(key: Uint8Array, storeId: string, name: string, plaintext: Uint8Array): Buffer {
  if (key.byteLength !== KEY_BYTES) throw new SealedFileError('key');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additionalData(storeId, name));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()]);
}

export function openBytes(key: Uint8Array, storeId: string, name: string, sealed: Uint8Array): Buffer {
  if (key.byteLength !== KEY_BYTES) throw new SealedFileError('key');
  if (!isSealed(sealed)) throw new SealedFileError('format');
  const bytes = Buffer.from(sealed);
  const nonce = bytes.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const body = bytes.subarray(MAGIC.length + NONCE_BYTES, bytes.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(additionalData(storeId, name));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new SealedFileError('authentication');
  }
}

/** Atomic write: a sealed temporary file renamed over the target. The record
 * name in the additional data is the target's base name. */
export async function writeSealedFile(filePath: string, key: Uint8Array, storeId: string, plaintext: Uint8Array): Promise<void> {
  const sealed = sealBytes(key, storeId, path.basename(filePath), plaintext);
  const temporary = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, sealed, { flag: 'wx', mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readSealedFile(filePath: string, key: Uint8Array, storeId: string): Promise<Buffer> {
  return openBytes(key, storeId, path.basename(filePath), await readFile(filePath));
}
