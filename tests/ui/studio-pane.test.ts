import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STUDIO_PRESETS,
  buildPhotoFilter,
  formatMediaTime,
  pickMediaRecorderMime,
  slugifyModuleName,
  unwrapCapabilityResponse,
} from '../../src/ui/public/modules/studio-pane.js';

describe('Monarch Studio UI helpers', () => {
  it('builds stable beginner presets and readable media time', () => {
    expect(Object.keys(STUDIO_PRESETS)).toEqual(['auto', 'warm', 'cool']);
    expect(buildPhotoFilter(STUDIO_PRESETS.auto)).toContain('brightness(1.08)');
    expect(buildPhotoFilter({ ...STUDIO_PRESETS.warm, skin: true })).toContain('blur(0.3px)');
    expect(formatMediaTime(125.9)).toBe('2:05');
  });

  it('creates safe module ids from Latin, Russian, and Ukrainian names', () => {
    expect(slugifyModuleName('Monarch Notes')).toBe('monarch-notes');
    expect(slugifyModuleName('Быстрые Заметки')).toBe('bystrye-zametki');
    expect(slugifyModuleName('Мої інструменти')).toBe('moyi-instrumenti');
  });

  it('unwraps execution responses and chooses a supported WebM recorder', () => {
    const result = { ok: true, output: { modules: [] } };
    expect(unwrapCapabilityResponse({ ok: true, result })).toBe(result);
    expect(pickMediaRecorderMime({
      isTypeSupported: (type: string) => type.includes('vp8'),
    } as typeof MediaRecorder)).toBe('video/webm;codecs=vp8,opus');
  });

  it('ships the complete Guided Studio shell with real local assets', async () => {
    const root = process.cwd();
    const html = await readFile(path.join(root, 'src', 'ui', 'public', 'index.html'), 'utf8');
    const app = await readFile(path.join(root, 'src', 'ui', 'public', 'app.js'), 'utf8');
    const script = await readFile(path.join(root, 'src', 'ui', 'public', 'modules', 'studio-pane.js'), 'utf8');
    const styles = await readFile(path.join(root, 'src', 'ui', 'public', 'studio.css'), 'utf8');
    for (const marker of [
      'id="modules-section"',
      'id="studio-photo-preview"',
      'id="studio-video-preview"',
      'id="studio-photo-format"',
      'id="module-builder-form"',
      'id="module-library-grid"',
    ]) expect(html).toContain(marker);
    expect(html).toContain('--studio-split: 34%');
    expect(html).toContain('value="34" aria-label="Граница сравнения до и после"');
    expect(html).toContain('<link rel="stylesheet" href="/styles-v2.css">');
    expect(html).toContain('<link rel="stylesheet" href="/studio.css">');
    expect(html).not.toContain('<link rel="stylesheet" href="/styles.css">');
    expect(html).toContain('data-scroll-target="modules-section"');
    expect(html.match(/data-studio-advanced-group hidden/g)).toHaveLength(2);
    expect(app).toContain("import { initStudioPane, setStudioActive } from './modules/studio-pane.js';");
    expect(app).toContain("elements.shell?.classList.toggle('modules-active', targetId === 'modules-section')");
    expect(script).toContain('group.hidden = !expanded');
    expect(script).toContain('MediaRecorder');
    expect(script).toContain('monarch-modules.scaffold.preview');
    expect(script).toContain('monarch-modules.scaffold.create');
    expect(styles).toContain('MONARCH MODULES · GUIDED STUDIO');
    expect(styles).toContain('.studio-editor');
    expect(styles).not.toContain('.app-shell.modules-active .sidebar');
    expect(styles).not.toContain('.app-shell.modules-active .nav-item[data-scroll-target="models-section"]');

    const assetSources = [...html.matchAll(/src="(\/assets\/(?:studio|icons\/phosphor)\/[^"?]+)"/g)]
      .map((match) => match[1]);
    expect(assetSources.length).toBeGreaterThan(20);
    await Promise.all(assetSources.map((source) => readFile(path.join(root, 'src', 'ui', 'public', source.slice(1)))));
  });
});
