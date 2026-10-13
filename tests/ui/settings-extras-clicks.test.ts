import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// <html data-auto-theme> is set by the theme owner, so a bare
// closest('[data-auto-theme]') matched every click in the document and
// swallowed "Run first setup again".
describe('Settings extras click routing', () => {
  it('matches auto-theme choices only inside their group', () => {
    const source = readFileSync('src/ui/public/modules/settings-extras.js', 'utf8');
    expect(source).not.toMatch(/closest\('\[data-auto-theme\]'\)/u);
    expect(source).not.toMatch(/querySelectorAll\('\[data-auto-theme\]'\)/u);
    expect(source).toContain("closest('[data-auto-theme-choice] [data-auto-theme]')");
    expect(source.indexOf("closest('[data-open-setup]')")).toBeGreaterThan(0);
  });
});
