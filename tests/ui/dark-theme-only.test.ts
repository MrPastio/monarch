import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync('src/ui/public/index.html', 'utf8');
const appSource = readFileSync('src/ui/public/app.js', 'utf8');
const activeStyles = readFileSync('src/ui/public/styles-v2.css', 'utf8');

describe('dark-only Monarch shell', () => {
  it('ships no light or system theme controls', () => {
    expect(indexHtml).toContain('<body data-theme="dark">');
    expect(indexHtml).not.toContain('theme-toggle-btn');
    expect(indexHtml).not.toContain('theme-select');
    expect(indexHtml).not.toContain('Светлая тема');
    expect(indexHtml).not.toContain('<option value="light">');
  });

  it('has no runtime or CSS branch capable of activating light mode', () => {
    expect(appSource).toContain("document.body.dataset.theme = 'dark';");
    expect(appSource).not.toContain('preferences.theme');
    expect(appSource).not.toContain('prefers-color-scheme');
    expect(activeStyles).toContain('color-scheme: dark;');
    expect(activeStyles).not.toContain('body[data-theme="light"]');
    expect(activeStyles).not.toContain('color-scheme: light;');
  });
});
