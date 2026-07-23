import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const indexPath = new URL('../../src/ui/public/index.html', import.meta.url);
const stylesPath = new URL('../../src/ui/public/styles-v2.css', import.meta.url);
const appPath = new URL('../../src/ui/public/app.js', import.meta.url);
const modelPath = new URL(
  '../../src/ui/public/startup/monarch-logo-3d.js',
  import.meta.url,
);
const threePath = new URL(
  '../../src/ui/public/runtime/three/three.module.min.js',
  import.meta.url,
);
const threeCorePath = new URL(
  '../../src/ui/public/runtime/three/three.core.min.js',
  import.meta.url,
);
const assetPath = new URL(
  '../../src/ui/public/assets/brand/monarch-startup-3d.png',
  import.meta.url,
);

describe('Monarch startup animation', () => {
  it('preserves every startup variant and defaults legacy or missing preferences to Generated 3D', async () => {
    const [html, app] = await Promise.all([
      readFile(indexPath, 'utf8'),
      readFile(appPath, 'utf8'),
    ]);
    const startupMarkup = html.match(
      /<div class="startup-motion"[\s\S]*?<script>\s*document\.getElementById\('startup-motion'\)/,
    )?.[0];

    expect(startupMarkup).toContain('startup-variant--classic');
    expect(startupMarkup).toContain('startup-variant--generated');
    expect(startupMarkup).toContain('startup-variant--model');
    expect(startupMarkup).toContain('startup-wordmark');
    expect(startupMarkup).toContain('startup-caption');
    expect(html).toContain('<option value="classic">Классическая</option>');
    expect(html).toContain('<option value="generated">Generated 3D — по умолчанию</option>');
    expect(html).toContain('<option value="model">Полная 3D-модель</option>');
    expect(html).toContain('<option value="test">Системная</option>');
    expect(html).toContain('<option value="disabled">Отключена</option>');
    expect(html).toContain("let startupType = 'generated'");
    expect(app).toContain("if (value === 'original') return 'generated'");
  });

  it('mounts a real WebGL Monarch model and retains the alpha PNG only as fallback', async () => {
    const [html, asset, model, three, threeCore] = await Promise.all([
      readFile(indexPath, 'utf8'),
      readFile(assetPath),
      readFile(modelPath, 'utf8'),
      readFile(threePath),
      readFile(threeCorePath),
    ]);

    const startupMarkup = html.match(
      /<div class="startup-motion"[\s\S]*?<div class="app-shell/,
    )?.[0];

    expect(startupMarkup).toContain('/assets/brand/monarch-startup-3d.png');
    expect(startupMarkup).toContain('data-monarch-logo-3d');
    expect(asset.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(model).toContain('new THREE.ExtrudeGeometry');
    expect(model).toContain("group.name = 'MonarchLogo3D'");
    expect(model).toContain('group.userData.meshCount = 16');
    expect(three.length).toBeGreaterThan(300_000);
    expect(threeCore.length).toBeGreaterThan(350_000);
  });

  it('reveals the actual mesh from its shadow and finishes facing the camera', async () => {
    const [styles, app, model] = await Promise.all([
      readFile(stylesPath, 'utf8'),
      readFile(appPath, 'utf8'),
      readFile(modelPath, 'utf8'),
    ]);

    expect(styles).toContain('.startup-logo-webgl__canvas');
    expect(model).toContain('new THREE.ShadowMaterial');
    expect(model).toContain('clippingPlane.constant');
    expect(model).toContain('model.rotation.x = THREE.MathUtils.lerp(-1.02, 0, faceCamera)');
    expect(model).toContain('container.dataset.monarch3dRotationX');
    expect(app).toContain('mountMonarchLogo3D');
    expect(app).toContain("monarch.startup-motion.v8");
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
    expect(app).toContain('playSystemStartupMotion({ onComplete: finish })');
    expect(styles).toContain('.startup-preview-button');
  });
});
