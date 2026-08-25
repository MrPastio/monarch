import * as THREE from '/runtime/three/three.module.min.js';

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

function extrudedMesh(shape, frontMaterial, sideMaterial, options = {}) {
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

  const mesh = new THREE.Mesh(geometry, [frontMaterial, sideMaterial]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createInteractiveLogoGroup() {
  const root = new THREE.Group();
  root.name = 'MonarchLogoInteractive';

  // Layer groups for explode view
  const layerBase = new THREE.Group(); layerBase.name = 'Layer_Base';
  const layerFrame = new THREE.Group(); layerFrame.name = 'Layer_Frame';
  const layerCrown = new THREE.Group(); layerCrown.name = 'Layer_Crown';
  const layerCircuits = new THREE.Group(); layerCircuits.name = 'Layer_Circuits';

  root.add(layerBase);
  root.add(layerFrame);
  root.add(layerCrown);
  root.add(layerCircuits);

  // Default PBR Materials
  const graphiteMat = new THREE.MeshPhysicalMaterial({
    color: 0x111419,
    metalness: 0.65,
    roughness: 0.3,
    clearcoat: 0.6,
    clearcoatRoughness: 0.15,
  });
  const graphiteSideMat = new THREE.MeshPhysicalMaterial({
    color: 0x07090c,
    metalness: 0.75,
    roughness: 0.25,
    clearcoat: 0.4,
  });
  const ivoryMat = new THREE.MeshPhysicalMaterial({
    color: 0xfff9ee,
    metalness: 0.2,
    roughness: 0.22,
    clearcoat: 0.85,
    clearcoatRoughness: 0.1,
  });
  const goldMat = new THREE.MeshPhysicalMaterial({
    color: 0xffb81c,
    metalness: 0.88,
    roughness: 0.16,
    clearcoat: 0.95,
    clearcoatRoughness: 0.08,
  });
  const circuitGlowMat = new THREE.MeshStandardMaterial({
    color: 0xff8a00,
    emissive: 0xff7a00,
    emissiveIntensity: 0.85,
    metalness: 0.4,
    roughness: 0.25,
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

  // 1. Base Plate
  const shieldBase = extrudedMesh(shapeFromPoints(outerShield), graphiteMat, graphiteSideMat, {
    depth: 0.38,
    frontZ: 0.22,
    bevelSize: 0.045,
    bevelThickness: 0.045,
    bevelSegments: 4,
  });
  layerBase.add(shieldBase);

  // 2. Shield Frame
  const shieldFrame = extrudedMesh(frameShape(outerShield, innerShield), ivoryMat, graphiteSideMat, {
    depth: 0.2,
    frontZ: 0.42,
    bevelSize: 0.028,
    bevelThickness: 0.028,
    bevelSegments: 3,
  });
  layerFrame.add(shieldFrame);

  // 3. Crown & Gem
  const crown = extrudedMesh(shapeFromPoints(crownBand), goldMat, graphiteSideMat, {
    depth: 0.3,
    frontZ: 0.43,
    bevelSize: 0.04,
    bevelThickness: 0.04,
    bevelSegments: 4,
  });
  const gem = extrudedMesh(shapeFromPoints(crownGem), goldMat, graphiteSideMat, {
    depth: 0.32,
    frontZ: 0.47,
    bevelSize: 0.035,
    bevelThickness: 0.035,
    bevelSegments: 4,
  });
  layerCrown.add(crown);
  layerCrown.add(gem);

  // 4. Circuit Traces & Nodes
  const addTrace = (from, to, radius = 0.038) => {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const dir = end.clone().sub(start);
    const len = dir.length();
    const geom = new THREE.CylinderGeometry(radius, radius, len, 18, 1, false);
    geom.computeVertexNormals();
    const mesh = new THREE.Mesh(geom, circuitGlowMat);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    mesh.castShadow = true;
    layerCircuits.add(mesh);
  };

  addTrace([0, -1.02, 0.46], [0, 0.28, 0.46], 0.043);
  addTrace([-0.23, -0.83, 0.46], [-0.23, -0.47, 0.46]);
  addTrace([-0.23, -0.47, 0.46], [-0.58, -0.16, 0.46]);
  addTrace([0.23, -0.83, 0.46], [0.23, -0.47, 0.46]);
  addTrace([0.23, -0.47, 0.46], [0.58, -0.16, 0.46]);

  const addNode = (x, y, scale = 1) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.105 * scale, 0.035 * scale, 14, 32),
      goldMat,
    );
    ring.position.set(x, y, 0.47);
    ring.castShadow = true;
    layerCircuits.add(ring);

    const socket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055 * scale, 0.055 * scale, 0.045, 24),
      graphiteSideMat,
    );
    socket.rotation.x = Math.PI / 2;
    socket.position.set(x, y, 0.47);
    socket.castShadow = true;
    layerCircuits.add(socket);
  };

  addNode(0, 0.34, 0.92);
  addNode(0, -1.04, 0.92);
  addNode(-0.62, -0.12, 0.86);
  addNode(0.62, -0.12, 0.86);

  root.userData = {
    layerBase,
    layerFrame,
    layerCrown,
    layerCircuits,
    materials: {
      graphiteMat,
      graphiteSideMat,
      ivoryMat,
      goldMat,
      circuitGlowMat,
    },
  };

  return root;
}

export function init3DStudio(container) {
  if (!container) return null;

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0.2, 7.8);
  camera.lookAt(0, 0.1, 0);

  // Logo Model Group
  const modelGroup = createInteractiveLogoGroup();
  scene.add(modelGroup);

  // Lights
  const ambientLight = new THREE.HemisphereLight(0xfff6e8, 0x090c12, 2.2);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xfff0d8, 6.2);
  keyLight.position.set(-3.6, 5.2, 6.5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.bias = -0.0003;
  scene.add(keyLight);

  const fillLight = new THREE.PointLight(0xffb81c, 24, 16, 1.6);
  fillLight.position.set(-1.2, 0.6, 5.2);
  scene.add(fillLight);

  const amberAccentLight = new THREE.PointLight(0xff8a00, 22, 12, 1.7);
  amberAccentLight.position.set(2.2, -2.5, 3.8);
  scene.add(amberAccentLight);

  const rimLight = new THREE.DirectionalLight(0xffbe28, 3.2);
  rimLight.position.set(4.0, 1.2, -3.0);
  scene.add(rimLight);

  // Floor Shadow & Glow Plate
  const floorMat = new THREE.ShadowMaterial({ opacity: 0.42 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 8), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -2.0, 0.2);
  floor.receiveShadow = true;
  scene.add(floor);

  const glowPlateMat = new THREE.MeshBasicMaterial({
    color: 0xff8a00,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glowPlate = new THREE.Mesh(new THREE.CircleGeometry(1.6, 64), glowPlateMat);
  glowPlate.rotation.x = -Math.PI / 2;
  glowPlate.scale.set(1.6, 0.4, 1);
  glowPlate.position.set(0, -1.98, 0.2);
  scene.add(glowPlate);

  // Simple Orbit Controls State
  let isDragging = false;
  let previousMousePosition = { x: 0, y: 0 };
  let targetRotation = { x: -0.12, y: 0.22 };
  let currentRotation = { x: -0.12, y: 0.22 };
  let targetDistance = 7.8;
  let currentDistance = 7.8;
  let autoRotate = true;
  let explodeFactor = 0;
  let targetExplode = 0;
  let wireframeMode = false;
  let currentPreset = 'signature';

  const onPointerDown = (e) => {
    isDragging = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - previousMousePosition.x;
    const deltaY = e.clientY - previousMousePosition.y;

    targetRotation.y += deltaX * 0.008;
    targetRotation.x += deltaY * 0.008;
    targetRotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, targetRotation.x));

    previousMousePosition = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = () => {
    isDragging = false;
  };

  const onWheel = (e) => {
    e.preventDefault();
    targetDistance += e.deltaY * 0.005;
    targetDistance = Math.max(3.5, Math.min(14, targetDistance));
  };

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  // Resize Handling
  const resize = () => {
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  // Render Loop
  let frameId = 0;
  let lastTime = performance.now();

  const applyExplode = (factor) => {
    const { layerBase, layerFrame, layerCrown, layerCircuits } = modelGroup.userData;
    if (layerBase) layerBase.position.z = -factor * 0.9;
    if (layerFrame) layerFrame.position.z = factor * 0.3;
    if (layerCrown) {
      layerCrown.position.z = factor * 0.7;
      layerCrown.position.y = factor * 0.4;
    }
    if (layerCircuits) layerCircuits.position.z = factor * 1.2;
  };

  const render = (now) => {
    const delta = (now - lastTime) / 1000;
    lastTime = now;

    if (autoRotate && !isDragging) {
      targetRotation.y += 0.35 * delta;
    }

    // Smooth inertia
    currentRotation.x += (targetRotation.x - currentRotation.x) * 0.08;
    currentRotation.y += (targetRotation.y - currentRotation.y) * 0.08;
    currentDistance += (targetDistance - currentDistance) * 0.08;
    explodeFactor += (targetExplode - explodeFactor) * 0.1;

    applyExplode(explodeFactor);

    // Update Camera / Model
    modelGroup.rotation.x = currentRotation.x;
    modelGroup.rotation.y = currentRotation.y;

    camera.position.z = currentDistance;
    camera.lookAt(0, 0.05, 0);

    // Pulsing circuit emissive intensity
    const pulse = 0.7 + 0.3 * Math.sin(now * 0.0035);
    if (modelGroup.userData.materials?.circuitGlowMat) {
      modelGroup.userData.materials.circuitGlowMat.emissiveIntensity = pulse;
    }

    renderer.render(scene, camera);
    frameId = requestAnimationFrame(render);
  };
  frameId = requestAnimationFrame(render);

  // Material Presets
  const setPreset = (presetName) => {
    currentPreset = presetName;
    const mats = modelGroup.userData.materials;
    if (!mats) return;

    if (presetName === 'signature') {
      mats.graphiteMat.color.setHex(0x111419);
      mats.graphiteMat.metalness = 0.65;
      mats.graphiteMat.roughness = 0.3;
      mats.ivoryMat.color.setHex(0xfff9ee);
      mats.ivoryMat.metalness = 0.2;
      mats.ivoryMat.roughness = 0.22;
      mats.goldMat.color.setHex(0xffb81c);
      mats.goldMat.metalness = 0.88;
      mats.circuitGlowMat.color.setHex(0xff8a00);
      mats.circuitGlowMat.emissive.setHex(0xff7a00);
      glowPlateMat.color.setHex(0xff8a00);
    } else if (presetName === 'obsidian') {
      mats.graphiteMat.color.setHex(0x050608);
      mats.graphiteMat.metalness = 0.95;
      mats.graphiteMat.roughness = 0.08;
      mats.ivoryMat.color.setHex(0x1a1d24);
      mats.ivoryMat.metalness = 0.85;
      mats.ivoryMat.roughness = 0.12;
      mats.goldMat.color.setHex(0xffaa00);
      mats.goldMat.metalness = 0.95;
      mats.circuitGlowMat.color.setHex(0xff5500);
      mats.circuitGlowMat.emissive.setHex(0xff3300);
      glowPlateMat.color.setHex(0xff4400);
    } else if (presetName === 'cyberpunk') {
      mats.graphiteMat.color.setHex(0x0a0f18);
      mats.graphiteMat.metalness = 0.5;
      mats.graphiteMat.roughness = 0.4;
      mats.ivoryMat.color.setHex(0x00e5ff);
      mats.ivoryMat.metalness = 0.3;
      mats.ivoryMat.roughness = 0.2;
      mats.goldMat.color.setHex(0xff0055);
      mats.goldMat.metalness = 0.7;
      mats.circuitGlowMat.color.setHex(0x00ffcc);
      mats.circuitGlowMat.emissive.setHex(0x00ffaa);
      glowPlateMat.color.setHex(0x00e5ff);
    } else if (presetName === 'puregold') {
      mats.graphiteMat.color.setHex(0x8a6200);
      mats.graphiteMat.metalness = 0.9;
      mats.graphiteMat.roughness = 0.25;
      mats.ivoryMat.color.setHex(0xffd700);
      mats.ivoryMat.metalness = 0.95;
      mats.ivoryMat.roughness = 0.15;
      mats.goldMat.color.setHex(0xffc400);
      mats.goldMat.metalness = 0.98;
      mats.circuitGlowMat.color.setHex(0xffe680);
      mats.circuitGlowMat.emissive.setHex(0xffb700);
      glowPlateMat.color.setHex(0xffaa00);
    }
  };

  const setWireframe = (enabled) => {
    wireframeMode = enabled;
    modelGroup.traverse((obj) => {
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => (m.wireframe = enabled));
        } else {
          obj.material.wireframe = enabled;
        }
      }
    });
  };

  const resetCamera = () => {
    targetRotation = { x: -0.12, y: 0.22 };
    targetDistance = 7.8;
    targetExplode = 0;
  };

  return {
    renderer,
    scene,
    modelGroup,
    setExplode: (val) => { targetExplode = Math.max(0, Math.min(2.5, val)); },
    setAutoRotate: (val) => { autoRotate = !!val; },
    getAutoRotate: () => autoRotate,
    setPreset,
    setWireframe,
    resetCamera,
    dispose: () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
