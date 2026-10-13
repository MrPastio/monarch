import { lstat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { renameWithRetry } from './windows-rename.mjs';

// A preference for new requests only. Running requests retain their exact role.
export function createMaxSelection(root) {
  const file = path.join(root, 'selected-provider.json');
  async function checkRoot() {
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('max-selection:root');
  }
  return {
    async read() {
      await checkRoot();
      const info = await lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!info) return 'groq';
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256) throw Error('max-selection:record');
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value.version !== 1 || !/^[a-z]{2,20}$/.test(value.providerId)) throw Error('max-selection:record');
      return value.providerId;
    },
    async write(providerId) {
      if (!/^[a-z]{2,20}$/.test(providerId)) throw Error('max-selection:provider');
      await checkRoot();
      const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, providerId }), { flag: 'wx', mode: 0o600 });
      await renameWithRetry(temporary, file);
    },
  };
}
