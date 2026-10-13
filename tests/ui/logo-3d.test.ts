import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildMonarchLogo3D, exportToGLTF, exportToMTL, exportToOBJ, exportToSTL } from '../../scripts/export-logo-3d.mjs';

const removedStudioPaths = [
  '../../src/ui/public/logo-3d.html',
  '../../src/ui/public/logo-3d.css',
  '../../src/ui/public/startup/monarch-3d-studio.js',
  '../../src/ui/public/startup/monarch-logo-3d.js',
  '../../src/ui/public/assets/brand/3d/monarch-logo.gltf',
  '../../src/ui/public/assets/brand/3d/monarch-logo.mtl',
  '../../src/ui/public/assets/brand/3d/monarch-logo.obj',
  '../../src/ui/public/assets/brand/3d/monarch-logo.stl',
].map(relative => new URL(relative, import.meta.url));

describe('Monarch 3D logo generation', () => {
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

  it('does not expose the removed Studio page, controller, or generated downloads', async () => {
    await Promise.all(removedStudioPaths.map(async file => {
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }));
  });
});
