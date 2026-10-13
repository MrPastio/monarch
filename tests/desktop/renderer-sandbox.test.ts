import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');

describe('renderer sandbox', () => {
  it('runs every Monarch window in the Chromium sandbox', () => {
    const preferences = [...main.matchAll(/webPreferences:\s*\{([\s\S]*?)\n\s*\}/g)].map(match => match[1]!);
    expect(preferences.length).toBeGreaterThanOrEqual(6);
    for (const block of preferences) {
      expect(block).toMatch(/sandbox:\s*true/);
      expect(block).not.toMatch(/nodeIntegration:\s*true/);
      expect(block).not.toMatch(/contextIsolation:\s*false/);
    }
    expect(main).not.toMatch(/sandbox:\s*false/);
  });

  it('loads only CommonJS preloads that a sandboxed renderer can run', () => {
    const preloads = [...main.matchAll(/path\.join\([^)]*'([^']*preload[^']*)'\)/g)].map(match => match[1]!);
    expect(preloads).toContain('preload.cjs');
    for (const name of preloads) expect(name.endsWith('.cjs')).toBe(true);
    const source = readFileSync(path.resolve('desktop/electron/preload.cjs'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    // A sandboxed preload gets only Electron's renderer modules.
    for (const [, name] of source.matchAll(/require\('([^']+)'\)/g)) expect(name).toBe('electron');
  });
});
