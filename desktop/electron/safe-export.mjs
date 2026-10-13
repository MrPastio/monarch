import { randomUUID } from 'node:crypto';
import { open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './windows-rename.mjs';

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function writeSafeExport({ destinationPath, safeRoot, bytes, shouldCommit = () => true }) {
  if (!path.isAbsolute(destinationPath) || !path.isAbsolute(safeRoot)) throw new Error('safe-export-invalid-path');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 256 * 1024 * 1024) throw new Error('safe-export-invalid-content');
  const destination = path.resolve(destinationPath);
  const parent = await realpath(path.dirname(destination));
  const protectedRoot = await realpath(safeRoot);
  const target = path.join(parent, path.basename(destination));
  if (within(protectedRoot, target)) throw new Error('safe-export-protected-root');
  const temporary = path.join(parent, `.monarch-safe-export-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    if (!await shouldCommit()) throw new Error('safe-export-session-changed');
    await renameWithRetry(temporary, target);
    return { ok: true, path: target, bytes: bytes.byteLength };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
