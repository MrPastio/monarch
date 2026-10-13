import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SAFE_SHARED_UI_RESOURCES, isAllowedSafeResourceUrl } from '../../desktop/electron/safe-window-policy.mjs';

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

describe('Monarch Safe renderer resource graph', () => {
  const safeUiRoot = path.resolve('desktop/safe');
  const referencePattern = /(?:\b(?:src|href)=["']([^"'#?]+)["']|\bimport\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\))/g;

  function localReferences(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    const found: string[] = [];
    for (const match of source.matchAll(referencePattern)) {
      const reference = match[1] ?? match[2] ?? match[3];
      if (!reference || /^(?:[a-z]+:|\/\/)/i.test(reference)) continue;
      found.push(path.resolve(path.dirname(file), reference));
    }
    return found;
  }

  it('loads every page, script and stylesheet the Safe windows reference', () => {
    const queue = ['index.html', 'authorization.html'].map((page) => path.join(safeUiRoot, page));
    const seen = new Set<string>();
    while (queue.length) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      expect(isAllowedSafeResourceUrl(pathToFileURL(file).href, safeUiRoot), path.relative(process.cwd(), file)).toBe(true);
      if (/\.(?:html|m?js|cjs)$/.test(file)) queue.push(...localReferences(file));
    }
    expect([...seen].some((file) => file.endsWith(path.join('modules', 'ui-select.js')))).toBe(true);
  });

  it('keeps shared resources exact and import-free', () => {
    for (const resource of SAFE_SHARED_UI_RESOURCES) {
      const file = path.resolve(resource);
      expect(existsSync(file), resource).toBe(true);
      if (resource.endsWith('.js')) expect(localReferences(file), resource).toEqual([]);
      else expect(readFileSync(file, 'utf8'), resource).not.toMatch(/@import|url\(\s*["']?(?!data:)/);
    }
    const sibling = path.resolve('src/ui/public/modules/ui-dialogs.js');
    expect(isAllowedSafeResourceUrl(pathToFileURL(sibling).href, safeUiRoot)).toBe(false);
    expect(isAllowedSafeResourceUrl(pathToFileURL(path.resolve('src/ui/public/app.js')).href, safeUiRoot)).toBe(false);
  });
});
