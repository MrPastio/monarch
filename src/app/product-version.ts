import { readFileSync } from 'node:fs';
import path from 'node:path';

const PRODUCT_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/u;

export const UNKNOWN_MONARCH_PRODUCT_VERSION = '0.0.0';

export function readMonarchProductVersion(sourceRoot: string): string {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    const version = typeof manifest.version === 'string'
      ? manifest.version.trim()
      : '';
    return PRODUCT_VERSION_PATTERN.test(version)
      ? version
      : UNKNOWN_MONARCH_PRODUCT_VERSION;
  } catch {
    return UNKNOWN_MONARCH_PRODUCT_VERSION;
  }
}
