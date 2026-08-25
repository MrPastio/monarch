import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../src/ui/public/runtime/three/three.module.min.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');
const OUTPUT_DIR = join(ROOT_DIR, 'assets', 'brand', '3d');
const PUBLIC_3D_DIR = join(ROOT_DIR, 'src', 'ui', 'public', 'assets', 'brand', '3d');

const MODEL_DEPTH = 0.3;
const FRONT_Z = 0.34;

function shapeFromPoints(points) {
  const shape = new THREE.Shape();
  points.forEach(([x, y], index) => {
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();
  return shape;
}

function frameShape(outerPoints, innerPoints) {
  const shape = shapeFromPoints(outerPoints);
  const hole = new THREE.Path();
  [...innerPoints].reverse().forEach(([x, y], index) => {
    if (index === 0) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  });
  hole.closePath();
  shape.holes.push(hole);
  return shape;
}

function extrudedGeometry(shape, options = {}) {
  const depth = options.depth ?? MODEL_DEPTH;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    bevelEnabled: options.bevelEnabled !== false,
    bevelSegments: options.bevelSegments ?? 3,
    bevelSize: options.bevelSize ?? 0.035,
    bevelThickness: options.bevelThickness ?? 0.035,
    curveSegments: 24,
  });
  geometry.translate(0, 0, (options.frontZ ?? FRONT_Z) - depth);
  geometry.computeVertexNormals();
  return geometry;
}

export function buildMonarchLogo3D() {
  const parts = [];

  const outerShield = [
    [-1.08, 0.72],
    [-0.48, 0.31],
    [0, 0.75],
    [0.48, 0.31],
    [1.08, 0.72],
    [1.03, -0.42],
    [0.76, -0.93],
    [0, -1.62],
    [-0.76, -0.93],
    [-1.03, -0.42],
  ];
  const innerShield = [
    [-0.8, 0.45],
    [-0.46, 0.23],
    [0, 0.59],
    [0.46, 0.23],
    [0.8, 0.45],
    [0.76, -0.32],
    [0.57, -0.7],
    [0, -1.26],
    [-0.57, -0.7],
    [-0.76, -0.32],
  ];
  const crownBand = [
    [-1.09, 1.42],
    [-0.64, 1.09],
    [-0.22, 1.47],
    [0, 1.2],
    [0.22, 1.47],
    [0.64, 1.09],
    [1.09, 1.42],
    [1.02, 0.94],
    [0.63, 0.67],
    [0, 1.14],
    [-0.63, 0.67],
    [-1.02, 0.94],
  ];
  const crownGem = [
    [0, 1.98],
    [0.19, 1.64],
    [0, 1.31],
    [-0.19, 1.64],
  ];

  // 1. Shield Base
  const baseGeom = extrudedGeometry(shapeFromPoints(outerShield), {
    depth: 0.38,
    frontZ: 0.22,
    bevelSize: 0.045,
    bevelThickness: 0.045,
    bevelSegments: 4,
  });
  parts.push({
    name: 'Shield_Base',
    materialName: 'Material_Graphite_Base',
    geometry: baseGeom,
    pbr: {
      color: [0.07, 0.08, 0.1, 1.0],
      metallic: 0.7,
      roughness: 0.3,
      emissive: [0, 0, 0],
    },
  });

  // 2. Shield Frame
  const frameGeom = extrudedGeometry(frameShape(outerShield, innerShield), {
    depth: 0.2,
    frontZ: 0.42,
    bevelSize: 0.028,
    bevelThickness: 0.028,
    bevelSegments: 3,
  });
  parts.push({
    name: 'Shield_Frame',
    materialName: 'Material_Titanium_White',
    geometry: frameGeom,
    pbr: {
      color: [0.98, 0.97, 0.94, 1.0],
      metallic: 0.25,
      roughness: 0.22,
      emissive: [0, 0, 0],
    },
  });

  // 3. Crown Band
  const crownGeom = extrudedGeometry(shapeFromPoints(crownBand), {
    depth: 0.3,
    frontZ: 0.43,
    bevelSize: 0.04,
    bevelThickness: 0.04,
    bevelSegments: 4,
  });
  parts.push({
    name: 'Crown_Band',
    materialName: 'Material_Imperial_Gold',
    geometry: crownGeom,
    pbr: {
      color: [1.0, 0.74, 0.12, 1.0],
      metallic: 0.88,
      roughness: 0.18,
      emissive: [0.05, 0.03, 0.0],
    },
  });

  // 4. Crown Gem
  const gemGeom = extrudedGeometry(shapeFromPoints(crownGem), {
    depth: 0.32,
    frontZ: 0.47,
    bevelSize: 0.035,
    bevelThickness: 0.035,
    bevelSegments: 4,
  });
  parts.push({
    name: 'Crown_Gem',
    materialName: 'Material_Imperial_Gold',
    geometry: gemGeom,
    pbr: {
      color: [1.0, 0.74, 0.12, 1.0],
      metallic: 0.88,
      roughness: 0.18,
      emissive: [0.05, 0.03, 0.0],
    },
  });

  // 5. Circuit Segments
  const circuitSegments = [
    { from: [0, -1.02, 0.46], to: [0, 0.28, 0.46], radius: 0.043 },
    { from: [-0.23, -0.83, 0.46], to: [-0.23, -0.47, 0.46], radius: 0.038 },
    { from: [-0.23, -0.47, 0.46], to: [-0.58, -0.16, 0.46], radius: 0.038 },
    { from: [0.23, -0.83, 0.46], to: [0.23, -0.47, 0.46], radius: 0.038 },
    { from: [0.23, -0.47, 0.46], to: [0.58, -0.16, 0.46], radius: 0.038 },
  ];

  circuitSegments.forEach((seg, idx) => {
    const start = new THREE.Vector3(...seg.from);
    const end = new THREE.Vector3(...seg.to);
    const dir = end.clone().sub(start);
    const len = dir.length();
    const geom = new THREE.CylinderGeometry(seg.radius, seg.radius, len, 16, 1, false);
    geom.computeVertexNormals();

    const mid = start.clone().add(end).multiplyScalar(0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.normalize(),
    );
    const matrix = new THREE.Matrix4().compose(
      mid,
      quat,
      new THREE.Vector3(1, 1, 1),
    );
    geom.applyMatrix4(matrix);

    parts.push({
      name: `Circuit_Trace_${idx + 1}`,
      materialName: 'Material_Circuit_Glow',
      geometry: geom,
      pbr: {
        color: [1.0, 0.62, 0.08, 1.0],
        metallic: 0.4,
        roughness: 0.2,
        emissive: [0.95, 0.45, 0.0],
      },
    });
  });

  // 6. Circuit Nodes
  const nodes = [
    { x: 0, y: 0.34, scale: 0.92 },
    { x: 0, y: -1.04, scale: 0.92 },
    { x: -0.62, y: -0.12, scale: 0.86 },
    { x: 0.62, y: -0.12, scale: 0.86 },
  ];

  nodes.forEach((node, idx) => {
    const ringGeom = new THREE.TorusGeometry(0.105 * node.scale, 0.035 * node.scale, 14, 28);
    ringGeom.applyMatrix4(new THREE.Matrix4().makeTranslation(node.x, node.y, 0.47));
    ringGeom.computeVertexNormals();
    parts.push({
      name: `Circuit_Ring_${idx + 1}`,
      materialName: 'Material_Imperial_Gold',
      geometry: ringGeom,
      pbr: {
        color: [1.0, 0.74, 0.12, 1.0],
        metallic: 0.85,
        roughness: 0.2,
        emissive: [0.1, 0.06, 0.0],
      },
    });

    const socketGeom = new THREE.CylinderGeometry(0.055 * node.scale, 0.055 * node.scale, 0.045, 20);
    socketGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    socketGeom.applyMatrix4(new THREE.Matrix4().makeTranslation(node.x, node.y, 0.47));
    socketGeom.computeVertexNormals();
    parts.push({
      name: `Circuit_Socket_${idx + 1}`,
      materialName: 'Material_Graphite_Base',
      geometry: socketGeom,
      pbr: {
        color: [0.08, 0.09, 0.12, 1.0],
        metallic: 0.8,
        roughness: 0.25,
        emissive: [0, 0, 0],
      },
    });
  });

  return parts;
}

export function exportToOBJ(parts) {
  let obj = `# Monarch Local AI Ecosystem — Official 3D Logo\n`;
  obj += `# Generated by Monarch 3D Exporter\n`;
  obj += `mtllib monarch-logo.mtl\n\n`;

  let vertexOffset = 1;
  let normalOffset = 1;

  for (const part of parts) {
    obj += `o ${part.name}\n`;
    obj += `usemtl ${part.materialName}\n`;
    obj += `s 1\n`;

    const geom = part.geometry;
    const posAttr = geom.attributes.position;
    const normAttr = geom.attributes.normal;
    const indexAttr = geom.index;

    for (let i = 0; i < posAttr.count; i++) {
      obj += `v ${posAttr.getX(i).toFixed(6)} ${posAttr.getY(i).toFixed(6)} ${posAttr.getZ(i).toFixed(6)}\n`;
    }

    if (normAttr) {
      for (let i = 0; i < normAttr.count; i++) {
        obj += `vn ${normAttr.getX(i).toFixed(6)} ${normAttr.getY(i).toFixed(6)} ${normAttr.getZ(i).toFixed(6)}\n`;
      }
    }

    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i += 3) {
        const a = indexAttr.getX(i) + vertexOffset;
        const b = indexAttr.getX(i + 1) + vertexOffset;
        const c = indexAttr.getX(i + 2) + vertexOffset;
        if (normAttr) {
          const na = indexAttr.getX(i) + normalOffset;
          const nb = indexAttr.getX(i + 1) + normalOffset;
          const nc = indexAttr.getX(i + 2) + normalOffset;
          obj += `f ${a}//${na} ${b}//${nb} ${c}//${nc}\n`;
        } else {
          obj += `f ${a} ${b} ${c}\n`;
        }
      }
    } else {
      for (let i = 0; i < posAttr.count; i += 3) {
        const a = i + vertexOffset;
        const b = i + 1 + vertexOffset;
        const c = i + 2 + vertexOffset;
        if (normAttr) {
          const na = i + normalOffset;
          const nb = i + 1 + normalOffset;
          const nc = i + 2 + normalOffset;
          obj += `f ${a}//${na} ${b}//${nb} ${c}//${nc}\n`;
        } else {
          obj += `f ${a} ${b} ${c}\n`;
        }
      }
    }

    vertexOffset += posAttr.count;
    if (normAttr) normalOffset += normAttr.count;
    obj += `\n`;
  }

  return obj;
}

export function exportToMTL(parts) {
  const materials = new Map();
  for (const part of parts) {
    if (!materials.has(part.materialName)) {
      materials.set(part.materialName, part.pbr);
    }
  }

  let mtl = `# Monarch 3D Material Library\n\n`;
  for (const [name, pbr] of materials.entries()) {
    mtl += `newmtl ${name}\n`;
    mtl += `Ka 0.1 0.1 0.1\n`;
    mtl += `Kd ${pbr.color[0].toFixed(3)} ${pbr.color[1].toFixed(3)} ${pbr.color[2].toFixed(3)}\n`;
    mtl += `Ks ${(pbr.metallic * 0.9).toFixed(3)} ${(pbr.metallic * 0.9).toFixed(3)} ${(pbr.metallic * 0.9).toFixed(3)}\n`;
    mtl += `Ke ${pbr.emissive[0].toFixed(3)} ${pbr.emissive[1].toFixed(3)} ${pbr.emissive[2].toFixed(3)}\n`;
    mtl += `Ns ${Math.round((1 - pbr.roughness) * 128)}\n`;
    mtl += `d ${pbr.color[3].toFixed(2)}\n`;
    mtl += `illum 2\n\n`;
  }
  return mtl;
}

export function exportToSTL(parts) {
  let stl = `solid monarch_logo_3d\n`;

  for (const part of parts) {
    const geom = part.geometry;
    const posAttr = geom.attributes.position;
    const normAttr = geom.attributes.normal;
    const indexAttr = geom.index;

    const getTriangle = (i1, i2, i3) => {
      const p1 = [posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1)];
      const p2 = [posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2)];
      const p3 = [posAttr.getX(i3), posAttr.getY(i3), posAttr.getZ(i3)];

      let nx = 0, ny = 0, nz = 1;
      if (normAttr) {
        nx = (normAttr.getX(i1) + normAttr.getX(i2) + normAttr.getX(i3)) / 3;
        ny = (normAttr.getY(i1) + normAttr.getY(i2) + normAttr.getY(i3)) / 3;
        nz = (normAttr.getZ(i1) + normAttr.getZ(i2) + normAttr.getZ(i3)) / 3;
      }
      return (
        `  facet normal ${nx.toFixed(5)} ${ny.toFixed(5)} ${nz.toFixed(5)}\n` +
        `    outer loop\n` +
        `      vertex ${p1[0].toFixed(5)} ${p1[1].toFixed(5)} ${p1[2].toFixed(5)}\n` +
        `      vertex ${p2[0].toFixed(5)} ${p2[1].toFixed(5)} ${p2[2].toFixed(5)}\n` +
        `      vertex ${p3[0].toFixed(5)} ${p3[1].toFixed(5)} ${p3[2].toFixed(5)}\n` +
        `    endloop\n` +
        `  endfacet\n`
      );
    };

    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i += 3) {
        stl += getTriangle(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
      }
    } else {
      for (let i = 0; i < posAttr.count; i += 3) {
        stl += getTriangle(i, i + 1, i + 2);
      }
    }
  }

  stl += `endsolid monarch_logo_3d\n`;
  return stl;
}

export function exportToGLTF(parts) {
  // Collect all vertex data into a single binary buffer
  const bufferArrays = [];
  let currentByteOffset = 0;

  const accessors = [];
  const bufferViews = [];
  const meshes = [];
  const nodes = [];
  const materials = [];
  const materialMap = new Map();

  for (const part of parts) {
    let matIndex = materialMap.get(part.materialName);
    if (matIndex === undefined) {
      matIndex = materials.length;
      materialMap.set(part.materialName, matIndex);
      materials.push({
        name: part.materialName,
        pbrMetallicRoughness: {
          baseColorFactor: part.pbr.color,
          metallicFactor: part.pbr.metallic,
          roughnessFactor: part.pbr.roughness,
        },
        emissiveFactor: part.pbr.emissive,
      });
    }

    const geom = part.geometry;
    const posAttr = geom.attributes.position;
    const normAttr = geom.attributes.normal;
    const indexAttr = geom.index;

    // Positions
    const posArray = new Float32Array(posAttr.array);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const z = posAttr.getZ(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    const posBufferViewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: currentByteOffset,
      byteLength: posArray.byteLength,
      target: 34962, // ARRAY_BUFFER
    });
    bufferArrays.push(Buffer.from(posArray.buffer));
    currentByteOffset += posArray.byteLength;

    const posAccessorIndex = accessors.length;
    accessors.push({
      bufferView: posBufferViewIndex,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: posAttr.count,
      type: 'VEC3',
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    });

    // Normals
    const normArray = new Float32Array(normAttr.array);
    const normBufferViewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: currentByteOffset,
      byteLength: normArray.byteLength,
      target: 34962, // ARRAY_BUFFER
    });
    bufferArrays.push(Buffer.from(normArray.buffer));
    currentByteOffset += normArray.byteLength;

    const normAccessorIndex = accessors.length;
    accessors.push({
      bufferView: normBufferViewIndex,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: normAttr.count,
      type: 'VEC3',
    });

    // Indices
    let indexAccessorIndex;
    if (indexAttr) {
      const indArray = indexAttr.count > 65535 ? new Uint32Array(indexAttr.array) : new Uint16Array(indexAttr.array);
      const compType = indexAttr.count > 65535 ? 5125 : 5123;
      const indBufferViewIndex = bufferViews.length;
      bufferViews.push({
        buffer: 0,
        byteOffset: currentByteOffset,
        byteLength: indArray.byteLength,
        target: 34963, // ELEMENT_ARRAY_BUFFER
      });
      bufferArrays.push(Buffer.from(indArray.buffer));
      currentByteOffset += indArray.byteLength;

      // 4-byte align padding if needed
      const remainder = currentByteOffset % 4;
      if (remainder !== 0) {
        const pad = 4 - remainder;
        bufferArrays.push(Buffer.alloc(pad));
        currentByteOffset += pad;
      }

      indexAccessorIndex = accessors.length;
      accessors.push({
        bufferView: indBufferViewIndex,
        byteOffset: 0,
        componentType: compType,
        count: indexAttr.count,
        type: 'SCALAR',
      });
    }

    const meshIndex = meshes.length;
    const primitive = {
      attributes: {
        POSITION: posAccessorIndex,
        NORMAL: normAccessorIndex,
      },
      material: matIndex,
    };
    if (indexAccessorIndex !== undefined) {
      primitive.indices = indexAccessorIndex;
    }

    meshes.push({
      name: part.name,
      primitives: [primitive],
    });

    nodes.push({
      name: part.name,
      mesh: meshIndex,
    });
  }

  const combinedBuffer = Buffer.concat(bufferArrays);
  const base64Uri = `data:application/octet-stream;base64,${combinedBuffer.toString('base64')}`;

  const gltf = {
    asset: {
      version: '2.0',
      generator: 'Monarch 3D Logo Generator',
    },
    scene: 0,
    scenes: [
      {
        name: 'MonarchLogoScene',
        nodes: nodes.map((_, i) => i),
      },
    ],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [
      {
        byteLength: combinedBuffer.byteLength,
        uri: base64Uri,
      },
    ],
  };

  return JSON.stringify(gltf, null, 2);
}

async function main() {
  console.log('[Monarch 3D] Generating 3D Logo Model...');
  const parts = buildMonarchLogo3D();
  console.log(`[Monarch 3D] Built ${parts.length} distinct geometric components.`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(PUBLIC_3D_DIR, { recursive: true });

  const objContent = exportToOBJ(parts);
  const mtlContent = exportToMTL(parts);
  const stlContent = exportToSTL(parts);
  const gltfContent = exportToGLTF(parts);

  // Write to assets/brand/3d/
  await writeFile(join(OUTPUT_DIR, 'monarch-logo.obj'), objContent, 'utf8');
  await writeFile(join(OUTPUT_DIR, 'monarch-logo.mtl'), mtlContent, 'utf8');
  await writeFile(join(OUTPUT_DIR, 'monarch-logo.stl'), stlContent, 'utf8');
  await writeFile(join(OUTPUT_DIR, 'monarch-logo.gltf'), gltfContent, 'utf8');

  // Write to src/ui/public/assets/brand/3d/ for web client download
  await writeFile(join(PUBLIC_3D_DIR, 'monarch-logo.obj'), objContent, 'utf8');
  await writeFile(join(PUBLIC_3D_DIR, 'monarch-logo.mtl'), mtlContent, 'utf8');
  await writeFile(join(PUBLIC_3D_DIR, 'monarch-logo.stl'), stlContent, 'utf8');
  await writeFile(join(PUBLIC_3D_DIR, 'monarch-logo.gltf'), gltfContent, 'utf8');

  console.log('[Monarch 3D] Successfully exported:');
  console.log(`  - OBJ:  ${join(OUTPUT_DIR, 'monarch-logo.obj')} (${Buffer.byteLength(objContent)} bytes)`);
  console.log(`  - MTL:  ${join(OUTPUT_DIR, 'monarch-logo.mtl')} (${Buffer.byteLength(mtlContent)} bytes)`);
  console.log(`  - STL:  ${join(OUTPUT_DIR, 'monarch-logo.stl')} (${Buffer.byteLength(stlContent)} bytes)`);
  console.log(`  - GLTF: ${join(OUTPUT_DIR, 'monarch-logo.gltf')} (${Buffer.byteLength(gltfContent)} bytes)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[Monarch 3D] Generation failed:', err);
    process.exit(1);
  });
}
