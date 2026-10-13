import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { renameWithRetry } from './windows-rename.mjs';

const scrypt = promisify(scryptCallback);

/** Monarch Security stage 3f: copies of the profile data key (PDK).
 *
 * The PDK record is bound to this Windows account. A damaged record or a
 * reinstalled system would leave every sealed store unreadable, so the person
 * chooses where copies live (policy control storage.keyRecovery, owner
 * decision 2026-10-12: Monarch Safe by default, with alternatives):
 *
 *   safe           wrapped with a key Monarch Safe derives from its master key
 *   safe-and-code  both copies; either restores the key
 *   code           wrapped with a recovery code shown to the person once
 *   none           no copy; losing the record loses the history
 *
 * A copy is never readable without a secret that is not in the profile: the
 * Safe master key (behind its PIN, recovery key or emergency phrase) or the
 * code, which Monarch does not keep. Each copy names the key it holds by a
 * one-way identifier, so an outdated copy is noticed without opening it. */

export const KEY_RECOVERY_LEVELS = Object.freeze(['safe', 'safe-and-code', 'code', 'none']);
const KEY_BYTES = 32;
const FORMAT = 'monarch.profile-key-backup.v1';
const FILES = Object.freeze({ safe: 'profile-data-key.safe-backup.json', code: 'profile-data-key.code-backup.json' });
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_GROUPS = 5;
const CODE_GROUP_LENGTH = 5;
const SCRYPT = Object.freeze({ N: 1 << 17, r: 8, p: 1 });

export function wantsCopy(level, kind) {
  if (kind === 'safe') return level === 'safe' || level === 'safe-and-code';
  if (kind === 'code') return level === 'code' || level === 'safe-and-code';
  return false;
}

export function profileKeyId(profileDataKey) {
  assertKey(profileDataKey);
  return Buffer.from(hkdfSync('sha256', profileDataKey, Buffer.alloc(0), 'monarch.profile-key-id.v1', 16)).toString('hex');
}

/** 25 characters of Crockford base32 (125 bits) in five groups. */
export function generateRecoveryCode() {
  const bytes = randomBytes(CODE_GROUPS * CODE_GROUP_LENGTH);
  const characters = [...bytes].map(byte => CODE_ALPHABET[byte & 31]);
  bytes.fill(0);
  const groups = [];
  for (let index = 0; index < CODE_GROUPS; index += 1) {
    groups.push(characters.slice(index * CODE_GROUP_LENGTH, (index + 1) * CODE_GROUP_LENGTH).join(''));
  }
  return groups.join('-');
}

/** Case, spaces, dashes and the usual look-alikes (O→0, I/L→1) do not matter. */
export function normalizeRecoveryCode(value) {
  const compact = String(value || '').toUpperCase().replace(/[\s-]/gu, '').replace(/O/gu, '0').replace(/[IL]/gu, '1');
  if (compact.length !== CODE_GROUPS * CODE_GROUP_LENGTH || [...compact].some(character => !CODE_ALPHABET.includes(character))) {
    throw Error('profile-key-recovery:code-format');
  }
  return compact;
}

export function createProfileKeyRecovery({ dataRoot }) {
  const filePath = kind => path.join(dataRoot, FILES[kind]);

  async function readCopy(kind) {
    let text;
    try { text = await readFile(filePath(kind), 'utf8'); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw Error('profile-key-recovery:copy-unreadable');
    }
    let copy;
    try { copy = JSON.parse(text); } catch { throw Error('profile-key-recovery:copy-damaged'); }
    if (copy?.format !== FORMAT || copy.kind !== kind || !/^[0-9a-f]{32}$/u.test(String(copy.keyId))) {
      throw Error('profile-key-recovery:copy-damaged');
    }
    return copy;
  }

  async function writeCopy(kind, copy) {
    await mkdir(dataRoot, { recursive: true });
    const target = filePath(kind);
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(copy), { flag: 'wx', mode: 0o600 });
      await renameWithRetry(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async function removeCopy(kind) {
    await unlink(filePath(kind)).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  }

  return {
    fileNames: Object.values(FILES),

    /** What exists and whether it holds the current key. Nothing is opened. */
    async status(profileDataKey = null) {
      const keyId = profileDataKey ? profileKeyId(profileDataKey) : null;
      const describe = async kind => {
        try {
          const copy = await readCopy(kind);
          if (!copy) return { present: false, current: false };
          return { present: true, current: keyId ? copy.keyId === keyId : false,
            ...(kind === 'safe' ? { vaultId: String(copy.vaultId || '') } : {}) };
        } catch {
          return { present: true, current: false, damaged: true };
        }
      };
      return { safe: await describe('safe'), code: await describe('code') };
    },

    async hasAnyCopy() {
      const current = await this.status();
      return current.safe.present || current.code.present;
    },

    async writeSafeCopy(profileDataKey, { vaultId, key }) {
      const wrappingKey = readWrappingKey(key);
      const id = String(vaultId || '');
      if (!/^[A-Za-z0-9-]{8,80}$/u.test(id)) throw Error('profile-key-recovery:vault-id');
      try {
        const envelope = seal(wrappingKey, profileDataKey, `${FORMAT}|safe|${id}`);
        await writeCopy('safe', { format: FORMAT, kind: 'safe', keyId: profileKeyId(profileDataKey), vaultId: id, ...envelope });
      } finally { wrappingKey.fill(0); }
      const opened = await this.openSafeCopy({ vaultId: id, key });
      try { if (!opened.equals(profileDataKey)) throw Error('profile-key-recovery:verification'); } finally { opened.fill(0); }
    },

    async openSafeCopy({ vaultId, key }) {
      const copy = await readCopy('safe');
      if (!copy) throw Error('profile-key-recovery:no-safe-copy');
      if (copy.vaultId !== String(vaultId || '')) throw Error('profile-key-recovery:other-safe');
      const wrappingKey = readWrappingKey(key);
      try { return open(wrappingKey, copy, `${FORMAT}|safe|${copy.vaultId}`); } finally { wrappingKey.fill(0); }
    },

    async writeCodeCopy(profileDataKey, code) {
      const normalized = normalizeRecoveryCode(code);
      const salt = randomBytes(16);
      const wrappingKey = await deriveCodeKey(normalized, salt, SCRYPT);
      try {
        const envelope = seal(wrappingKey, profileDataKey, `${FORMAT}|code`);
        await writeCopy('code', { format: FORMAT, kind: 'code', keyId: profileKeyId(profileDataKey),
          kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') }, ...envelope });
      } finally { wrappingKey.fill(0); }
      const opened = await this.openCodeCopy(normalized);
      try { if (!opened.equals(profileDataKey)) throw Error('profile-key-recovery:verification'); } finally { opened.fill(0); }
    },

    async openCodeCopy(code) {
      const copy = await readCopy('code');
      if (!copy) throw Error('profile-key-recovery:no-code-copy');
      const kdf = copy.kdf || {};
      if (kdf.name !== 'scrypt' || kdf.N !== SCRYPT.N || kdf.r !== SCRYPT.r || kdf.p !== SCRYPT.p) {
        throw Error('profile-key-recovery:copy-damaged');
      }
      const wrappingKey = await deriveCodeKey(normalizeRecoveryCode(code), Buffer.from(String(kdf.salt || ''), 'base64'), SCRYPT);
      try { return open(wrappingKey, copy, `${FORMAT}|code`); } finally { wrappingKey.fill(0); }
    },

    /** Copies the level does not ask for are removed: a person who chose
     * fewer copies must not keep one silently. */
    async removeUnwanted(level) {
      for (const kind of ['safe', 'code']) if (!wantsCopy(level, kind)) await removeCopy(kind);
    },

    removeCopy,
  };
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw Error('profile-key-recovery:key');
}

function readWrappingKey(encoded) {
  const key = Buffer.from(String(encoded || ''), 'base64');
  if (key.length !== KEY_BYTES) { key.fill(0); throw Error('profile-key-recovery:wrapping-key'); }
  return key;
}

async function deriveCodeKey(code, salt, { N, r, p }) {
  if (salt.length !== 16) throw Error('profile-key-recovery:copy-damaged');
  return Buffer.from(await scrypt(code, salt, KEY_BYTES, { N, r, p, maxmem: 256 * 1024 * 1024 }));
}

function seal(wrappingKey, profileDataKey, aad) {
  assertKey(profileDataKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(profileDataKey), cipher.final()]);
  return { nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

/** A wrong code or another Safe fails the authentication tag; that is reported
 * as one plain error, never as a partial key. */
function open(wrappingKey, copy, aad) {
  const nonce = Buffer.from(String(copy.nonce || ''), 'base64');
  const tag = Buffer.from(String(copy.tag || ''), 'base64');
  const ciphertext = Buffer.from(String(copy.ciphertext || ''), 'base64');
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length !== KEY_BYTES) throw Error('profile-key-recovery:copy-damaged');
  let key;
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw Error('profile-key-recovery:wrong-secret');
  }
  const expected = Buffer.from(String(copy.keyId), 'hex');
  const actual = Buffer.from(profileKeyId(key), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    key.fill(0);
    throw Error('profile-key-recovery:copy-damaged');
  }
  return key;
}
