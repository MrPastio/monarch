import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const publicDir = new URL('../../src/ui/public/', import.meta.url);
const indexPath = new URL('index.html', publicDir);
const stylesPath = new URL('styles-v2.css', publicDir);
const appPath = new URL('app.js', publicDir);
const generatedAssetPath = new URL('assets/brand/monarch-startup-3d.png', publicDir);

const readStartupMarkup = async () => {
  const html = await readFile(indexPath, 'utf8');
  return {
    html,
    markup: html.match(/<div class="startup-motion"[\s\S]*?<div class="app-shell/)?.[0] ?? '',
  };
};

describe('Monarch startup animation', () => {
  it('offers the Generated 3D and assembly variants and a way to switch it off', async () => {
    const { html, markup } = await readStartupMarkup();
    const app = await readFile(appPath, 'utf8');

    expect(markup).toContain('startup-variant--generated');
    expect(markup).toContain('startup-variant--assembly');
    expect(html).toContain('<option value="generated">Generated 3D</option>');
    expect(html).toContain('<option value="assembly">Сборка знака — по умолчанию</option>');
    expect(html).toContain('<option value="disabled">Отключена</option>');
    expect(html).toContain("new Set(['generated', 'assembly', 'disabled'])");
    expect(app).toContain("assembly: 'Сборка знака'");
  });

  it('makes the assembly the default and moves earlier defaults to it exactly once', async () => {
    const { html } = await readStartupMarkup();
    const app = await readFile(appPath, 'utf8');

    expect(html).toContain("let startupType = 'assembly'");
    expect(html).toContain("localStorage.getItem('monarch.startup.default') !== 'assembly-v1'");
    expect(html).toContain("localStorage.setItem('monarch.startup.default', 'assembly-v1')");
    // Only a deliberate opt-out survives the move.
    expect(html).toContain("savedStartupType !== 'disabled'");
    expect(app).toContain("const DEFAULT_STARTUP_TYPE = 'assembly'");
    expect(app).toContain('Object.hasOwn(STARTUP_TYPE_LABELS, value) ? value : DEFAULT_STARTUP_TYPE');
  });

  it('no longer ships the classic, full 3D model or system startup variants', async () => {
    const [{ html, markup }, app, styles] = await Promise.all([
      readStartupMarkup(),
      readFile(appPath, 'utf8'),
      readFile(stylesPath, 'utf8'),
    ]);

    expect(markup).not.toContain('startup-variant--classic');
    expect(markup).not.toContain('startup-variant--model');
    expect(markup).not.toContain('data-monarch-logo-3d');
    expect(html).not.toContain('value="classic"');
    expect(html).not.toContain('value="model"');
    expect(html).not.toContain('value="test"');
    expect(html).not.toContain('/startup/monarch-startup.css');
    expect(app).not.toContain('mountMonarchLogo3D');
    expect(app).not.toContain('MonarchStartup');
    expect(app).not.toContain('playSystemStartupMotion');
    expect(styles).not.toContain('.startup-logo-webgl');
    expect(styles).not.toContain('startupCrown');
    expect(styles).not.toContain('.startup-wordmark');
    expect(styles).not.toContain('startupFallbackRise');
    for (const file of ['monarch-startup.js', 'monarch-startup.ts', 'monarch-startup.css']) {
      expect(existsSync(new URL(`startup/${file}`, publicDir))).toBe(false);
    }
  });

  it('keeps the generated PNG that Generated 3D and the first-run panel still use', async () => {
    const [{ markup }, asset] = await Promise.all([readStartupMarkup(), readFile(generatedAssetPath)]);

    expect(markup).toContain('/assets/brand/monarch-startup-3d.png');
    expect(asset.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('ships the assembly assets and the display face used for its name', async () => {
    const [{ markup }, styles, crown, shield, font] = await Promise.all([
      readStartupMarkup(),
      readFile(stylesPath, 'utf8'),
      readFile(new URL('assets/brand/monarch-assembly-crown.png', publicDir)),
      readFile(new URL('assets/brand/monarch-assembly-shield.png', publicDir)),
      readFile(new URL('assets/fonts/MonarchDisplay-Bold.woff2', publicDir)),
    ]);

    expect(markup).toContain('/assets/brand/monarch-assembly-crown.png');
    expect(markup).toContain('/assets/brand/monarch-assembly-shield.png');
    expect(markup.match(/data-sa="letter"/g)).toHaveLength(7);
    expect(crown.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(shield.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(font.subarray(0, 4).toString('ascii')).toBe('wOF2');
    expect(styles).toContain('font-family: "Monarch Display"');
    expect(styles).toContain('.startup-assembly-word');
  });

  it('drives the assembly with cancellable animations and falls back without movement', async () => {
    const [app, styles] = await Promise.all([readFile(appPath, 'utf8'), readFile(stylesPath, 'utf8')]);
    const assembly = app.match(/function playAssemblyStartupMotion[\s\S]*?\nfunction measureBrandFlight/)?.[0];

    expect(assembly).toBeDefined();
    expect(assembly).toContain('animations.forEach((animation) => animation.cancel())');
    expect(assembly).toContain('timers.forEach((timer) => window.clearTimeout(timer))');
    expect(assembly).toContain('reducedMotionMedia?.matches');
    expect(assembly).toContain("root.classList.add('is-static')");
    expect(assembly).toContain('measureBrandFlight(mark)');
    expect(assembly).toContain("elements.shell?.classList.add('startup-complete')");
    expect(app).toContain("startupType === 'assembly'");
    expect(app).toContain('playAssemblyStartupMotion(originalDOM');
    expect(app).toContain('playAssemblyStartupMotion(previewRoot');
    expect(styles).toContain('.startup-motion.is-static .startup-variant--assembly [data-sa-in]');
    expect(styles).toContain('html[data-theme="light"] .startup-assembly-shield');
  });

  it('persists the selected default and previews it without restarting the app', async () => {
    const [html, app, styles] = await Promise.all([
      readFile(indexPath, 'utf8'),
      readFile(appPath, 'utf8'),
      readFile(stylesPath, 'utf8'),
    ]);

    expect(html).toContain('id="startup-animation-preview"');
    expect(html).toContain('id="startup-animation-status"');
    expect(app).toContain("localStorage.setItem('monarch.startup.type', startupType)");
    expect(app).toContain('function previewStartupMotion(value)');
    expect(app).toContain('startupMotionTemplate.cloneNode(true)');
    expect(app).toContain('elements.shell.before(previewRoot)');
    expect(styles).toContain('.startup-preview-button');
  });
});
