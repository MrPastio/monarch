import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Installed Monarch retains its existing Electron profile and encrypted keys.
// Development gets its own instance lock/profile, while retaining access to
// its existing main-process encrypted records through the same OS-wrapped key.
// Never copy browser cookies, sessions, Safe files or credential records.
export function prepareDevelopmentProfile({ defaultProfile, developmentProfile }) {
  mkdirSync(developmentProfile, { recursive: true });
  const target = path.join(developmentProfile, 'Local State');
  if (existsSync(target)) return developmentProfile;
  const original = path.join(defaultProfile, 'Local State');
  if (!existsSync(original)) return developmentProfile;
  const state = JSON.parse(readFileSync(original, 'utf8').replace(/^\uFEFF/, ''));
  if (!state.os_crypt || typeof state.os_crypt !== 'object' || Array.isArray(state.os_crypt)) {
    throw Error('development-profile-encryption-metadata-missing');
  }
  try {
    writeFileSync(target, JSON.stringify({ os_crypt: state.os_crypt }), { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return developmentProfile;
}
