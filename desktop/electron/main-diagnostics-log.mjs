import { appendFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './windows-rename.mjs';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 4096;

/** Keeps the main process's structured diagnostics after it exits.
 *
 * MAX providers, credential stores and the native hosts run in the Electron
 * main process and report codes as `{"diagnostic":...}` lines on stderr, which
 * a desktop launch does not keep. Live, three MAX failures in Coder left no
 * trace at all. Only such JSON diagnostic lines are copied — never arbitrary
 * output — into one file rotated once at `maxBytes`. Writing never throws into
 * the caller and never delays the original stderr write.
 */
export function installMainDiagnosticsMirror({ filePath, maxBytes = DEFAULT_MAX_BYTES, stream = process.stderr } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw Error('main-diagnostics:path');
  const originalWrite = stream.write.bind(stream);
  let queue = Promise.resolve();
  let pending = '';
  const persist = (line) => {
    queue = queue.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const size = await stat(filePath).then((value) => value.size, () => 0);
      if (size + line.length > maxBytes) await renameWithRetry(filePath, filePath + '.1').catch(() => undefined);
      await appendFile(filePath, line, { encoding: 'utf8' });
    }).catch(() => undefined);
  };
  stream.write = (chunk, ...rest) => {
    try {
      if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
        pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line.startsWith('{"diagnostic":') && line.length <= MAX_LINE_BYTES) {
            persist(JSON.stringify({ at: new Date().toISOString(), pid: process.pid, entry: safeParse(line) }) + '\n');
          }
        }
        if (pending.length > MAX_LINE_BYTES) pending = '';
      }
    } catch { /* The mirror must never break stderr itself. */ }
    return originalWrite(chunk, ...rest);
  };
  return {
    flush: () => queue,
    uninstall: () => { stream.write = originalWrite; },
  };
}

function safeParse(line) {
  try { return JSON.parse(line); } catch { return { unparsed: line.slice(0, 512) }; }
}
