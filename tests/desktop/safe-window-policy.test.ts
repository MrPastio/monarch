import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAllowedSafeResourceUrl } from '../../desktop/electron/safe-window-policy.mjs';

describe('Monarch Safe renderer resource allowlist', () => {
  const safeUiRoot = path.resolve('desktop/safe');

  it('allows only local Safe UI resources plus in-memory blob/data URLs', () => {
    expect(isAllowedSafeResourceUrl(pathToFileURL(path.join(safeUiRoot, 'index.html')).href, safeUiRoot)).toBe(true);
    expect(isAllowedSafeResourceUrl(pathToFileURL(path.join(safeUiRoot, 'safe.js')).href, safeUiRoot)).toBe(true);
    expect(isAllowedSafeResourceUrl('blob:file:///safe-preview', safeUiRoot)).toBe(true);
    expect(isAllowedSafeResourceUrl('data:image/png;base64,AA==', safeUiRoot)).toBe(true);
  });

  it('denies sibling files, network schemes and malformed URLs', () => {
    expect(isAllowedSafeResourceUrl(pathToFileURL(path.resolve('package.json')).href, safeUiRoot)).toBe(false);
    expect(isAllowedSafeResourceUrl('https://example.com/file', safeUiRoot)).toBe(false);
    expect(isAllowedSafeResourceUrl('file:///%zz', safeUiRoot)).toBe(false);
    expect(isAllowedSafeResourceUrl('javascript:alert(1)', safeUiRoot)).toBe(false);
  });
});
