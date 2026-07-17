import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isAllowedSafeResourceUrl(value, safeUiRoot) {
  const candidate = String(value || '');
  if (/^(?:blob:|data:)/i.test(candidate)) return true;
  if (!/^file:/i.test(candidate) || !path.isAbsolute(safeUiRoot)) return false;
  try {
    const relative = path.relative(path.resolve(safeUiRoot), path.resolve(fileURLToPath(candidate)));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}
