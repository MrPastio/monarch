import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { MARK_LEFT_BAND, MARK_RIGHT_BAND, monarchMarkSvg } from '../../src/ui/public/modules/brand-mark.js';

const publicDir = new URL('../../src/ui/public/', import.meta.url);
const indexPath = new URL('index.html', publicDir);
const stylesPath = new URL('styles-v2.css', publicDir);
const appPath = new URL('app.js', publicDir);

const readStartupMarkup = async () => {
  const html = await readFile(indexPath, 'utf8');
  return {
    html,
    markup: html.match(/<div class="startup-motion"[\s\S]*?<section class="setup"/)?.[0] ?? '',
  };
};

describe('Monarch mark', () => {
  it('draws both bands on the 49u x 26u grid: contour left, glass on top right', () => {
    expect(MARK_LEFT_BAND).toBe('M0 0H15L32 26H17Z');
    expect(MARK_RIGHT_BAND).toBe('M34 0H49L32 26H17Z');
    const svg = monarchMarkSvg();
    expect(svg).toContain('viewBox="0 0 49 26"');
    // The glass comes after the contour, so the contour never shows through it.
    expect(svg.indexOf('data-mark="line"')).toBeLessThan(svg.indexOf('data-mark="glass"'));
    expect(svg).toContain('vector-effect="non-scaling-stroke"');
    expect(svg).toContain('var(--mark-glass-a)');
    expect(monarchMarkSvg()).not.toBe(svg); // clip ids stay unique per copy
  });
});

describe('Monarch startup animation', () => {
  it('has one intro, the mark, and a way to switch it off', async () => {
    const { html, markup } = await readStartupMarkup();
    const app = await readFile(appPath, 'utf8');

    expect(markup).toContain('class="startup-mark" data-startup-mark');
    expect(markup).toContain('data-mark="sheen"');
    expect(html).toContain('<option value="mark">Знак Monarch — по умолчанию</option>');
    expect(html).toContain('<option value="disabled">Отключена</option>');
    expect(app).toContain("const DEFAULT_STARTUP_TYPE = 'mark'");
    expect(app).toContain("mark: 'Знак Monarch'");
  });

  it('moves every earlier intro to the mark exactly once and keeps a deliberate opt-out', async () => {
    const { html } = await readStartupMarkup();
    expect(html).toContain("localStorage.getItem('monarch.startup.default') !== 'mark-v1'");
    expect(html).toContain("if (savedStartupType !== 'disabled') savedStartupType = 'mark'");
    expect(html).toContain("localStorage.setItem('monarch.startup.default', 'mark-v1')");
  });

  it('no longer ships the Generated 3D, assembly or older intros and their assets', async () => {
    const [{ html, markup }, app, styles] = await Promise.all([
      readStartupMarkup(),
      readFile(appPath, 'utf8'),
      readFile(stylesPath, 'utf8'),
    ]);
    for (const removed of ['startup-variant', 'startup-generated', 'startup-assembly', 'data-sa=']) {
      expect(markup).not.toContain(removed);
      expect(styles).not.toContain(removed);
    }
    expect(html).not.toContain('value="generated"');
    expect(html).not.toContain('value="assembly"');
    expect(app).not.toContain('playAssemblyStartupMotion');
    expect(app).not.toContain('playDomStartupMotion');
    expect(app).not.toContain('measureBrandFlight');
    expect(styles).not.toContain('Monarch Display');
    for (const file of ['brand/monarch-startup-3d.png', 'brand/monarch-assembly-crown.png',
      'brand/monarch-assembly-shield.png', 'brand/monarch-mark.png', 'brand/monarch-icon.png',
      'fonts/MonarchDisplay-Bold.woff2']) {
      expect(existsSync(new URL(`assets/${file}`, publicDir))).toBe(false);
    }
  });

  it('meets along the diagonals, shines, then leaves down the slopes; cancellable, reduced motion still', async () => {
    const app = await readFile(appPath, 'utf8');
    const intro = app.match(/function playMarkStartupMotion[\s\S]*?\nfunction previewStartupMotion/)?.[0];

    expect(intro).toBeDefined();
    // Owner's sample: enter 650 ms, hold 1 s with the sheen, lift 250 ms, exit 420 ms.
    expect(intro).toContain('const ENTER = 650;');
    expect(intro).toContain('const HOLD = 1000;');
    expect(intro).toContain('const LIFT = 250;');
    expect(intro).toContain('const EXIT = 420;');
    expect(intro).toContain("glass: { x: -17 / length, y: 26 / length }");
    expect(intro).toContain('band(line, slope.line)');
    expect(intro).toContain('band(glass, slope.glass)');
    // HTML layers move on the compositor; the start waits for a painted frame.
    expect(intro).toContain('translate3d(');
    expect(intro).toContain('requestAnimationFrame(start)');
    expect(intro).toContain('timers.push(window.setTimeout(open, total - 40))');
    expect(intro).toContain('animations.forEach((animation) => animation.cancel())');
    expect(intro).toContain('timers.forEach((timer) => window.clearTimeout(timer))');
    expect(intro).toContain('reducedMotionMedia?.matches');
    expect(intro).toContain("root.classList.add('is-static')");
    expect(app).toContain('playMarkStartupMotion(originalDOM, { completeShell: true })');
    expect(app).toContain('playMarkStartupMotion(previewRoot, { onComplete: finish })');
  });

  it('persists the choice and previews it without restarting the app', async () => {
    const [html, app, styles] = await Promise.all([
      readFile(indexPath, 'utf8'),
      readFile(appPath, 'utf8'),
      readFile(stylesPath, 'utf8'),
    ]);
    expect(html).toContain('id="startup-animation-preview"');
    expect(html).toContain('id="startup-animation-status"');
    expect(app).toContain("localStorage.setItem('monarch.startup.type', startupType)");
    expect(app).toContain('startupMotionTemplate.cloneNode(true)');
    expect(app).toContain('elements.shell.before(previewRoot)');
    expect(styles).toContain('.startup-preview-button');
  });
});
