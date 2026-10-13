import { rename } from 'node:fs/promises';

const TRANSIENT = new Set(['EACCES', 'EBUSY', 'EPERM']);

/** rename() for the main process, retried while Windows reports the source or
 * target as briefly held. Defender, the search indexer or a reader opened the
 * freshly written file without FILE_SHARE_DELETE, and a single attempt then
 * failed a key save or a state write outright (live: the MAX key replacement
 * failed about one time in eight). ~1.6 s in all; any other error, or a hold
 * that outlasts the budget, is thrown unchanged. */
export async function renameWithRetry(source, target, { attempts = 12, baseDelayMs = 25, renameFile = rename,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, target);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      if (!TRANSIENT.has(code) || attempt >= attempts - 1) throw error;
      await sleep(baseDelayMs * (attempt + 1));
    }
  }
}
