import * as THREE from '/runtime/three/three.module.min.js';

const MODEL_DEPTH = 0.3;
const FRONT_Z = 0.34;
const STARTUP_DURATION_MS = 3000;

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

function extrudedMesh(shape, frontMaterial, sideMaterial, options = {}) {
  const depth = options.depth ?? MODEL_DEPTH;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    bevelEnabled: options.bevelEnabled !== false,
    bevelSegments: options.bevelSegments ?? 3,
    bevelSize: options.bevelSize ?? 0.035,
    bevelThickness: options.bevelThickness ?? 0.035,
    curveSegments: 16,
  });
  geometry.translate(0, 0, (options.frontZ ?? FRONT_Z) - depth);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, [frontMaterial, sideMaterial]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addCircuitSegment(group, from, to, material, radius = 0.038) {
  const start = new THREE.Vector3(from[0], from[1], from[2] ?? 0.46);
  const end = new THREE.Vector3(to[0], to[1], to[2] ?? 0.46);
  const direction = end.clone().sub(start);
  const length = direction.length();
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 18, 1, false);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  mesh.castShadow = true;
  group.add(mesh);
}

function addCircuitNode(group, x, y, material, scale = 1) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.105 * scale, 0.035 * scale, 14, 32),
    material,
  );
  ring.position.set(x, y, 0.47);
  ring.castShadow = true;
  group.add(ring);

  const socket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055 * scale, 0.055 * scale, 0.045, 24),
    new THREE.MeshPhysicalMaterial({
      color: 0x111315,
      metalness: 0.72,
      roughness: 0.28,
    }),
  );
  socket.rotation.x = Math.PI / 2;
  socket.position.set(x, y, 0.47);
  socket.castShadow = true;
  group.add(socket);
}

export function createMonarchLogoModel(clippingPlane) {
  const group = new THREE.Group();
  group.name = 'MonarchLogo3D';

  const graphite = new THREE.MeshPhysicalMaterial({
    color: 0x111419,
    metalness: 0.58,
    roughness: 0.32,
    clearcoat: 0.55,
    clearcoatRoughness: 0.2,
    clippingPlanes: [clippingPlane],
  });
  const graphiteSide = new THREE.MeshPhysicalMaterial({
    color: 0x080a0d,
    metalness: 0.72,
    roughness: 0.27,
    clearcoat: 0.4,
    clippingPlanes: [clippingPlane],
  });
  const ivory = new THREE.MeshPhysicalMaterial({
    color: 0xfff8ea,
    metalness: 0.2,
    roughness: 0.26,
    clearcoat: 0.8,
    clearcoatRoughness: 0.12,
    clippingPlanes: [clippingPlane],
  });
  const gold = new THREE.MeshPhysicalMaterial({
    color: 0xffb316,
    metalness: 0.7,
    roughness: 0.22,
    clearcoat: 0.9,
    clearcoatRoughness: 0.1,
    clippingPlanes: [clippingPlane],
  });

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

  const shieldBase = extrudedMesh(
    shapeFromPoints(outerShield),
    graphite,
    graphiteSide,
    {
      depth: 0.38,
      frontZ: 0.22,
      bevelSize: 0.045,
      bevelThickness: 0.045,
      bevelSegments: 4,
    },
  );
  group.add(shieldBase);

  const shieldFrame = extrudedMesh(
    frameShape(outerShield, innerShield),
    ivory,
    graphiteSide,
    {
      depth: 0.2,
      frontZ: 0.42,
      bevelSize: 0.028,
      bevelThickness: 0.028,
      bevelSegments: 3,
    },
  );
  group.add(shieldFrame);

  const crown = extrudedMesh(
    shapeFromPoints(crownBand),
    gold,
    graphiteSide,
    {
      depth: 0.3,
      frontZ: 0.43,
      bevelSize: 0.04,
      bevelThickness: 0.04,
      bevelSegments: 4,
    },
  );
  group.add(crown);

  const gem = extrudedMesh(
    shapeFromPoints(crownGem),
    gold,
    graphiteSide,
    {
      depth: 0.32,
      frontZ: 0.47,
      bevelSize: 0.035,
      bevelThickness: 0.035,
      bevelSegments: 4,
    },
  );
  group.add(gem);

  addCircuitSegment(group, [0, -1.02], [0, 0.28], ivory, 0.043);
  addCircuitSegment(group, [-0.23, -0.83], [-0.23, -0.47], ivory);
  addCircuitSegment(group, [-0.23, -0.47], [-0.58, -0.16], ivory);
  addCircuitSegment(group, [0.23, -0.83], [0.23, -0.47], ivory);
  addCircuitSegment(group, [0.23, -0.47], [0.58, -0.16], ivory);
  addCircuitNode(group, 0, 0.34, ivory, 0.92);
  addCircuitNode(group, 0, -1.04, ivory, 0.92);
  addCircuitNode(group, -0.62, -0.12, ivory, 0.86);
  addCircuitNode(group, 0.62, -0.12, ivory, 0.86);

  group.userData.monarchMaterials = [graphite, graphiteSide, ivory, gold];
  group.userData.meshCount = 16;
  return group;
}

function smootherStep(value) {
  const x = THREE.MathUtils.clamp(value, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function phase(progress, start, end) {
  return smootherStep((progress - start) / (end - start));
}

export function mountMonarchLogo3D(container, options = {}) {
  if (!(container instanceof HTMLElement)) return null;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.34;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  renderer.domElement.className = 'startup-logo-webgl__canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, 0.14, 8.35);
  camera.lookAt(0, 0.05, 0);

  const clippingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), -1.72);
  const model = createMonarchLogoModel(clippingPlane);
  model.position.set(0, -0.34, 0);
  model.rotation.set(-1.02, -0.24, 0.035);
  model.scale.setScalar(0.8);
  scene.add(model);

  const ambient = new THREE.HemisphereLight(0xfff4dd, 0x08090c, 2.15);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffefd2, 5.8);
  key.position.set(-3.4, 4.8, 6.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -4;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const frontFill = new THREE.PointLight(0xffe5b0, 26, 16, 1.55);
  frontFill.position.set(-0.8, 0.5, 5.6);
  scene.add(frontFill);

  const amber = new THREE.PointLight(0xff8a00, 18, 9, 1.7);
  amber.position.set(0.8, -2.4, 3.2);
  scene.add(amber);

  const rim = new THREE.DirectionalLight(0xffbd36, 2.8);
  rim.position.set(3.5, 0.8, -2.5);
  scene.add(rim);

  const floorMaterial = new THREE.ShadowMaterial({
    color: 0x000000,
    opacity: 0.52,
  });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(7.5, 5),
    floorMaterial,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -1.72, 0.3);
  floor.receiveShadow = true;
  scene.add(floor);

  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xff8a00,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(1.4, 64),
    glowMaterial,
  );
  glow.rotation.x = -Math.PI / 2;
  glow.scale.set(1.5, 0.38, 1);
  glow.position.set(0, -1.7, 0.24);
  scene.add(glow);

  const resize = () => {
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  const startedAt = performance.now();
  let frameId = 0;
  let disposed = false;

  const renderFrame = (now) => {
    if (disposed) return;
    const progress = reducedMotion
      ? 1
      : THREE.MathUtils.clamp((now - startedAt) / STARTUP_DURATION_MS, 0, 1);
    const reveal = phase(progress, 0.08, 0.6);
    const rise = phase(progress, 0.08, 0.66);
    const faceCamera = phase(progress, 0.48, 0.98);
    const settle = phase(progress, 0.62, 1);

    clippingPlane.constant = THREE.MathUtils.lerp(-1.72, 2.22, reveal);
    model.position.y = THREE.MathUtils.lerp(-0.34, 0, rise);
    model.position.z = THREE.MathUtils.lerp(-0.34, 0, settle);
    model.rotation.x = THREE.MathUtils.lerp(-1.02, 0, faceCamera);
    model.rotation.y = THREE.MathUtils.lerp(-0.24, 0, faceCamera);
    model.rotation.z = THREE.MathUtils.lerp(0.035, 0, settle);
    model.scale.setScalar(THREE.MathUtils.lerp(0.8, 1, rise));

    glowMaterial.opacity =
      0.22 * phase(progress, 0.02, 0.24) * (1 - 0.72 * settle);
    amber.intensity = THREE.MathUtils.lerp(8, 18, rise) * (1 - 0.25 * settle);
    floorMaterial.opacity = THREE.MathUtils.lerp(0.62, 0.34, settle);
    camera.position.z = THREE.MathUtils.lerp(8.7, 8.35, settle);
    camera.lookAt(0, 0.05, 0);

    renderer.render(scene, camera);

    container.dataset.monarch3d = 'ready';
    container.dataset.monarch3dMeshes = String(model.userData.meshCount);
    container.dataset.monarch3dProgress = progress.toFixed(3);
    container.dataset.monarch3dRotationX = model.rotation.x.toFixed(3);
    container.dataset.monarch3dDepth = model.position.z.toFixed(3);
    container.dataset.monarch3dClip = clippingPlane.constant.toFixed(3);
    container.closest('.startup-logo-scene')?.classList.add('is-webgl-ready');

    if (progress < 1) frameId = window.requestAnimationFrame(renderFrame);
  };
  frameId = window.requestAnimationFrame(renderFrame);

  return {
    model,
    renderer,
    dispose() {
      if (disposed) return;
      disposed = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : object.material
            ? [object.material]
            : [];
        materials.forEach((material) => material.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
      container.removeAttribute('data-monarch3d');
      container.removeAttribute('data-monarch3d-meshes');
      container.removeAttribute('data-monarch3d-progress');
      container.removeAttribute('data-monarch3d-rotation-x');
      container.removeAttribute('data-monarch3d-depth');
      container.removeAttribute('data-monarch3d-clip');
    },
  };
}
