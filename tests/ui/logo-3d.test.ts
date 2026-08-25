import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildMonarchLogo3D, exportToGLTF, exportToMTL, exportToOBJ, exportToSTL } from '../../scripts/export-logo-3d.mjs';

const studioHtmlPath = new URL('../../src/ui/public/logo-3d.html', import.meta.url);
const studioJsPath = new URL('../../src/ui/public/startup/monarch-3d-studio.js', import.meta.url);

describe('Monarch 3D Logo Generation and Studio', () => {
  it('generates a multi-part 3D geometry structure with accurate layers', () => {
    const parts = buildMonarchLogo3D();
    expect(parts.length).toBeGreaterThanOrEqual(10);

    const partNames = parts.map((p) => p.name);
    expect(partNames).toContain('Shield_Base');
    expect(partNames).toContain('Shield_Frame');
    expect(partNames).toContain('Crown_Band');
    expect(partNames).toContain('Crown_Gem');
    expect(partNames.some((n) => n.startsWith('Circuit_Trace'))).toBe(true);
    expect(partNames.some((n) => n.startsWith('Circuit_Ring'))).toBe(true);
  });

  it('exports valid Wavefront OBJ and MTL files', async () => {
    const parts = buildMonarchLogo3D();
    const obj = exportToOBJ(parts);
    const mtl = exportToMTL(parts);

    expect(obj).toContain('mtllib monarch-logo.mtl');
    expect(obj).toContain('o Shield_Base');
    expect(obj).toContain('o Crown_Band');
    expect(obj).toContain('usemtl Material_Imperial_Gold');
    expect(obj).toContain('usemtl Material_Titanium_White');
    expect(obj).toContain('usemtl Material_Graphite_Base');
    expect(obj).toContain('usemtl Material_Circuit_Glow');

    // Counts vertices and faces
    const vertexMatches = obj.match(/^v\s+/gm);
    const faceMatches = obj.match(/^f\s+/gm);
    expect(vertexMatches?.length).toBeGreaterThan(1000);
    expect(faceMatches?.length).toBeGreaterThan(1000);

    expect(mtl).toContain('newmtl Material_Imperial_Gold');
    expect(mtl).toContain('newmtl Material_Titanium_White');
    expect(mtl).toContain('newmtl Material_Graphite_Base');
    expect(mtl).toContain('newmtl Material_Circuit_Glow');
  });

  it('exports valid STL format for 3D printing', async () => {
    const stl = exportToSTL(buildMonarchLogo3D());

    expect(stl.startsWith('solid monarch_logo_3d')).toBe(true);
    expect(stl.trim().endsWith('endsolid monarch_logo_3d')).toBe(true);

    const facetMatches = stl.match(/facet normal/g);
    expect(facetMatches?.length).toBeGreaterThan(2000);
  });

  it('exports valid glTF 2.0 with embedded buffers and PBR materials', async () => {
    const gltfRaw = exportToGLTF(buildMonarchLogo3D());
    const gltf = JSON.parse(gltfRaw);

    expect(gltf.asset?.version).toBe('2.0');
    expect(gltf.scenes).toBeDefined();
    expect(gltf.nodes.length).toBeGreaterThanOrEqual(10);
    expect(gltf.meshes.length).toBeGreaterThanOrEqual(10);
    expect(gltf.materials.length).toBeGreaterThanOrEqual(4);
    expect(gltf.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/);
  });

  it('includes complete 3D studio markup and controller', async () => {
    const [html, js] = await Promise.all([
      readFile(studioHtmlPath, 'utf8'),
      readFile(studioJsPath, 'utf8'),
    ]);

    expect(html).toContain('id="canvas-container"');
    expect(html).toContain('id="explode-slider"');
    expect(html).toContain('id="btn-autorotate"');
    expect(html).toContain('/assets/brand/3d/monarch-logo.obj');
    expect(html).toContain('/assets/brand/3d/monarch-logo.stl');
    expect(html).toContain('/assets/brand/3d/monarch-logo.gltf');

    expect(js).toContain('export function init3DStudio');
    expect(js).toContain('createInteractiveLogoGroup');
    expect(js).toContain('setExplode');
    expect(js).toContain('setPreset');
    expect(js).toContain('setWireframe');
  });
});
