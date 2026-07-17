import path from 'node:path';

const SAFE_STORAGE_SEGMENTS = Object.freeze(['MonarchData', 'Safe', 'safe-v1']);

export function resolveSafeStorageRoot({ workspaceRoot, qaUserDataRoot = null }) {
  if (qaUserDataRoot) {
    if (!path.isAbsolute(qaUserDataRoot)) throw new TypeError('Monarch Safe QA user-data root must be absolute.');
    return path.join(path.resolve(qaUserDataRoot), 'safe-v1');
  }
  if (!path.isAbsolute(workspaceRoot)) throw new TypeError('Monarch workspace root must be absolute.');
  return path.join(path.parse(path.resolve(workspaceRoot)).root, ...SAFE_STORAGE_SEGMENTS);
}

export const SAFE_STORAGE_LAYOUT = Object.freeze({
  dataDirectory: 'MonarchData',
  safeDirectory: 'Safe',
  versionDirectory: 'safe-v1',
});
