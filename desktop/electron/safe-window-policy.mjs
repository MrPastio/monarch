import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared Monarch UI files the Safe renderer may load in addition to its own
 * root. Exact files only (never a directory); each must stay import-free so
 * the Safe module graph cannot grow past this list.
 * Paths are relative to the workspace root that contains `desktop/safe`.
 */
export const SAFE_SHARED_UI_RESOURCES = Object.freeze([
  'src/ui/public/modules/ui-select.js',
  'src/ui/public/ui-controls.css',
]);

export function isAllowedSafeResourceUrl(value, safeUiRoot) {
  const candidate = String(value || '');
  if (/^(?:blob:|data:)/i.test(candidate)) return true;
  if (!/^file:/i.test(candidate) || !path.isAbsolute(safeUiRoot)) return false;
  try {
    const root = path.resolve(safeUiRoot);
    const target = path.resolve(fileURLToPath(candidate));
    const relative = path.relative(root, target);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return true;
    const workspaceRoot = path.resolve(root, '..', '..');
    return SAFE_SHARED_UI_RESOURCES.some((resource) => path.relative(path.join(workspaceRoot, resource), target) === '');
  } catch {
    return false;
  }
}
