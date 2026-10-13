import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderWhatsNewList, shouldShowWhatsNew, whatsNewEntries } from '../../src/ui/public/modules/whats-new.js';

const notes = JSON.parse(readFileSync('src/ui/public/whats-new.json', 'utf8'));

describe('what is new', () => {
  it('ships notes for the package line with all three kinds', () => {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
    expect(version === notes.version || version.startsWith(notes.version + '.')).toBe(true);
    for (const kind of ['feature', 'fix', 'security']) expect(whatsNewEntries(notes, kind).length).toBeGreaterThan(0);
  });
  it('filters by kind and renders plain entries', () => {
    const fixes = whatsNewEntries(notes, 'fix');
    expect(fixes.every((entry: any) => entry.type === 'fix')).toBe(true);
    expect(renderWhatsNewList(fixes)).toContain('Исправление');
    expect(renderWhatsNewList([])).toContain('изменений нет');
  });
  it('opens once per line after an update and never in another line', () => {
    expect(shouldShowWhatsNew('0.3.0.95', '0.3.0', null)).toBe(true);
    expect(shouldShowWhatsNew('0.3.0.95', '0.3.0', '0.3.0')).toBe(false);
    expect(shouldShowWhatsNew('0.3.1.0', '0.3.0', null)).toBe(false);
    expect(shouldShowWhatsNew('0.3.0.95', '0.3.0', null, false)).toBe(false);
  });
});
