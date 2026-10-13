import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makePixel, stepPixel } from '../../src/ui/public/modules/paper-pixel.js';

const indexHtml = readFileSync('src/ui/public/index.html', 'utf8');
const appSource = readFileSync('src/ui/public/app.js', 'utf8');
const layer = readFileSync('src/ui/public/paper-pixel.css', 'utf8');
const transitions = readFileSync('src/ui/public/modules/theme-transition.js', 'utf8');
const extras = readFileSync('src/ui/public/modules/settings-extras.js', 'utf8');
const voiceMode = readFileSync('src/ui/public/modules/oscar-voice-mode.js', 'utf8');
const desktopMain = readFileSync('desktop/electron/main.mjs', 'utf8');
const overlayCss = readFileSync('desktop/electron/voice-overlay.css', 'utf8');
const overlayJs = readFileSync('desktop/electron/voice-overlay.js', 'utf8');

/** Top-level selectors of a stylesheet, with nested blocks folded away. */
function topLevelSelectors(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors: string[] = [];
  let depth = 0;
  let buffer = '';
  for (const char of clean) {
    if (char === '{') {
      if (depth === 0) selectors.push(buffer.trim());
      depth += 1;
      buffer = '';
    } else if (char === '}') {
      depth -= 1;
      buffer = '';
    } else if (depth === 0) {
      buffer += char;
    }
  }
  return selectors.filter(Boolean);
}

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((channel) => parseInt(channel, 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + .05) / (lo + .05);
};

describe('PaperPixel design', () => {
  it('is the default design and is resolved before the first paint', () => {
    expect(indexHtml).toContain("document.documentElement.dataset.design = stored.design === 'classic' ? 'classic' : 'pp';");
    expect(appSource).toContain('document.documentElement.dataset.design = preferences.design;');
    expect(appSource).toContain("['design', 'theme', 'autoTheme', 'density', 'motion', 'language'].includes(key)");
  });

  it('loads its layer after every other stylesheet', () => {
    const links = [...indexHtml.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1]);
    expect(links.at(-1)).toBe('/paper-pixel.css');
  });

  it('leaves the classic design untouched: every rule is scoped to html[data-design="pp"]', () => {
    const allowedUnscoped = /^(@font-face|@media|\.pp-|\.settings-appearance-label|\.settings-design-grid|\.settings-design-card|\.pp-design-preview|\.setup-design-switch)/;
    for (const selector of topLevelSelectors(layer)) {
      if (selector.startsWith('@media')) continue;
      if (allowedUnscoped.test(selector)) continue;
      expect(selector, selector).toMatch(/^html:root\[data-design="pp"\]/);
    }
    // media blocks are scoped inside as well
    for (const block of layer.match(/@media[^{]+\{[\s\S]*?\n\}/g) || []) {
      expect(block).toContain('html:root[data-design="pp"]');
    }
  });

  it('draws ranges and progress as smooth bars, never as rows of dots', () => {
    expect(layer).not.toMatch(/repeating-linear-gradient\(90deg, var\(--pp-ink/);
    expect(layer).not.toMatch(/radial-gradient\(circle, var\(--pp-ink-faint\)/);
  });

  it('snaps strokes to whole device pixels on fractional display scales', () => {
    expect(layer).toContain('(min-resolution: 1.2dppx) and (max-resolution: 1.39dppx)');
    expect(layer).toMatch(/--pp-stroke: 1\.61px/);
  });

  it('keeps Paper and Ink text legible on every paper tone', () => {
    const paper = { paper: '#ffffff', paper2: '#f4f4f2', paper3: '#e9e9e6', ink: '#0b0b0b', ink2: '#3a3a38', muted: '#696965' };
    const inkTheme = { paper: '#0b0b0b', paper2: '#171716', paper3: '#232322', ink: '#f7f7f5', ink2: '#c9c9c5', muted: '#9b9b96' };
    for (const theme of [paper, inkTheme]) {
      for (const ground of [theme.paper, theme.paper2, theme.paper3]) {
        for (const text of [theme.ink, theme.ink2, theme.muted]) expect(contrast(text, ground)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(layer).toContain('--pp-ink-muted: #696965;');
    expect(layer).toContain('--pp-ink-muted: #9b9b96;');
  });

  it('offers the design choice in Settings with the same reveal as the theme', () => {
    expect(indexHtml).toContain('data-design-card="pp"');
    expect(indexHtml).toContain('data-design-card="classic"');
    expect(transitions).toContain('export function changeDesignWithReveal');
    expect(extras).toContain("closest('[data-design-card]')");
  });

  it('drives pixels with springs that settle on their target and respect square symmetry', () => {
    const pixel = makePixel(0, 0, 8);
    pixel.tx = 40; pixel.ty = -20; pixel.ta = 88; pixel.k = 520; pixel.c = 34;
    for (let i = 0; i < 240; i++) stepPixel(pixel, 1 / 60);
    expect(pixel.x).toBeCloseTo(40, 1);
    expect(pixel.y).toBeCloseTo(-20, 1);
    // 88° is 2° away from a quarter turn: the square turns back 2°, never 88°.
    expect(Math.abs(pixel.a)).toBeLessThan(3);
    const falling = makePixel(0, 0, 8);
    falling.free = true; falling.vy = -100;
    for (let i = 0; i < 60; i++) stepPixel(falling, 1 / 60, 2200);
    expect(falling.vy).toBeGreaterThan(2000);
  });

  it('brings the desktop voice overlay along with the main window look', () => {
    expect(voiceMode).toContain("design: root.dataset.design === 'classic' ? 'classic' : 'pp'");
    expect(desktopMain).toContain("design: input.design === 'classic' ? 'classic' : 'pp',");
    expect(overlayJs).toContain('pixelRing.setPhase');
    expect(overlayCss).toContain('body[data-design="pp"] .voice-pixels{display:block}');
    // the classic overlay keeps its glass
    expect(overlayCss).toContain('backdrop-filter:blur(28px)');
  });
});
