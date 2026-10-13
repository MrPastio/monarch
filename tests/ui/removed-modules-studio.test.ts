import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { findNavigationDestinations } from '../../src/ui/public/modules/ui-navigation.js';

const publicRoot = new URL('../../src/ui/public/', import.meta.url);

describe('removed Modules and Studio product surfaces', () => {
  it('keeps them out of the sidebar and Ctrl+K destinations', async () => {
    const html = await readFile(new URL('index.html', publicRoot), 'utf8');
    const sidebar = html.match(/<aside class="sidebar"[\s\S]*?<\/aside>/u)?.[0] ?? '';

    expect(sidebar).not.toMatch(/(?:data-scroll-target|data-view|href)=["'][^"']*(?:modules|studio)/iu);
    expect(findNavigationDestinations('Studio')).toEqual([]);
    expect(findNavigationDestinations('Модули')).toEqual([]);
  });

  it('does not leave a directly served Studio route or downloadable model assets', async () => {
    for (const relative of [
      'logo-3d.html',
      'logo-3d.css',
      'startup/monarch-3d-studio.js',
      'startup/monarch-logo-3d.js',
      'assets/brand/3d/monarch-logo.gltf',
      'assets/brand/3d/monarch-logo.mtl',
      'assets/brand/3d/monarch-logo.obj',
      'assets/brand/3d/monarch-logo.stl',
    ]) {
      await expect(access(new URL(relative, publicRoot))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('retains the generic module registry API without restoring a Modules UI', async () => {
    const server = await readFile(new URL('../../src/app/http-server.ts', import.meta.url), 'utf8');
    expect(server).toContain("request.method === 'GET' && url.pathname === '/api/modules'");
    expect(server).toContain('modules: state.runtime.snapshot.modules');
  });
});
