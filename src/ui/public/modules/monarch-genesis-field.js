const ACTIVE_STATES = new Set(['preparing', 'generating']);

export class MonarchGenesisField {
  constructor(root, options = {}) {
    this.root = root;
    this.canvas = root?.querySelector('canvas') || null;
    this.context = this.canvas?.getContext('2d', { alpha: true }) || null;
    this.statusLabel = root?.querySelector('#genesis-status-label') || null;
    this.lowPerformance = options.lowPerformance ?? detectLowPerformance();
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    this.state = 'idle';
    this.frame = 0;
    this.lastFrameAt = 0;
    this.startedAt = performance.now();
    this.focus = null;
    this.nextFocusAt = this.startedAt + randomBetween(2_800, 5_400);
    this.nextVariationAt = this.startedAt + randomBetween(3_500, 5_500);
    this.nodes = createNodes(this.lowPerformance ? 24 : 42);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    if (root) this.resizeObserver.observe(root);
    this.resize();
  }

  setState(state, label = '') {
    this.state = state;
    if (!this.root) return;
    this.root.dataset.state = state;
    if (this.statusLabel) this.statusLabel.textContent = label || statusLabelFor(state);
    this.root.classList.remove('is-locking', 'is-collapsing', 'is-error');
    if (ACTIVE_STATES.has(state)) {
      this.root.hidden = false;
      this.resize();
      this.start();
      return;
    }
    if (state === 'error') {
      this.root.hidden = false;
      this.root.classList.add('is-error');
      window.setTimeout(() => this.stop(true), 520);
      return;
    }
    if (state === 'idle') {
      this.stop();
      this.root.hidden = true;
    }
  }

  async resolve(src, imageElement) {
    if (!this.root || !imageElement || !src) return;
    const decoded = new Image();
    decoded.src = src;
    await decoded.decode();
    imageElement.src = src;
    imageElement.hidden = false;
    this.root.classList.add('is-locking');
    await delay(130);
    this.root.classList.remove('is-locking');
    this.root.classList.add('is-collapsing');
    await delay(190);
    imageElement.classList.add('is-resolving');
    await delay(this.reducedMotion ? 180 : 390);
    imageElement.classList.remove('is-resolving');
    imageElement.classList.add('is-resolved');
    this.stop();
    this.root.hidden = true;
    this.root.classList.remove('is-collapsing');
    this.state = 'complete';
  }

  resetResolved(imageElement) {
    if (!imageElement) return;
    imageElement.classList.remove('is-resolving', 'is-resolved');
    imageElement.removeAttribute('src');
    imageElement.hidden = true;
  }

  destroy() {
    this.stop();
    this.resizeObserver.disconnect();
  }

  start() {
    if (this.frame || this.reducedMotion) {
      this.draw(performance.now());
      return;
    }
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }

  stop(keepFrame = false) {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (!keepFrame && this.context && this.canvas) this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  tick(time) {
    this.frame = 0;
    if (!ACTIVE_STATES.has(this.state) && this.state !== 'error') return;
    const interval = this.lowPerformance ? 66 : 34;
    if (time - this.lastFrameAt >= interval) {
      this.lastFrameAt = time;
      this.draw(time);
    }
    this.frame = requestAnimationFrame((next) => this.tick(next));
  }

  resize() {
    if (!this.canvas || !this.root) return;
    const bounds = this.root.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, this.lowPerformance ? 1 : 1.5);
    this.canvas.width = Math.max(1, Math.floor(bounds.width * ratio));
    this.canvas.height = Math.max(1, Math.floor(bounds.height * ratio));
    this.canvas.style.width = `${bounds.width}px`;
    this.canvas.style.height = `${bounds.height}px`;
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.width = bounds.width;
    this.height = bounds.height;
    this.draw(performance.now());
  }

  draw(time) {
    const context = this.context;
    if (!context || !this.width || !this.height) return;
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim() || '#ffbd22';
    const accent2 = style.getPropertyValue('--accent-2').trim() || '#ff7a18';
    const text = style.getPropertyValue('--text-soft').trim() || '#b6b7b9';
    context.clearRect(0, 0, this.width, this.height);
    if (!this.reducedMotion) this.updateProceduralState(time);
    const seconds = (time - this.startedAt) / 1000;
    const focusProgress = this.focus ? clamp01((time - this.focus.startedAt) / this.focus.duration) : 0;
    const focusIntensity = this.focus ? Math.sin(focusProgress * Math.PI) : 0;
    const positions = this.nodes.map((node) => nodePosition(
      node,
      this.width,
      this.height,
      seconds,
      this.focus,
      focusIntensity,
      this.reducedMotion,
    ));

    context.lineCap = 'round';
    for (let index = 0; index < positions.length; index += 1) {
      const left = positions[index];
      if (!left) continue;
      for (let neighbor = index + 1; neighbor < Math.min(positions.length, index + 7); neighbor += 1) {
        const right = positions[neighbor];
        if (!right) continue;
        const distance = Math.hypot(right.x - left.x, right.y - left.y);
        const focusBoost = this.focus && (left.focused || right.focused) ? focusIntensity * 0.16 : 0;
        if (distance > Math.min(this.width, this.height) * 0.2) continue;
        context.globalAlpha = Math.max(0, 0.11 - distance / Math.max(this.width, this.height) * 0.3) + focusBoost;
        context.strokeStyle = neighbor % 4 === 0 ? accent2 : text;
        context.lineWidth = 0.55 + Math.min(left.depth, right.depth) * 0.35;
        context.beginPath();
        context.moveTo(left.x, left.y);
        context.lineTo(right.x, right.y);
        context.stroke();
      }
    }

    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index];
      if (!position) continue;
      context.globalAlpha = (0.24 + position.depth * 0.32) * (this.state === 'error' ? 0.48 : 1)
        + (position.focused ? focusIntensity * 0.2 : 0);
      context.fillStyle = index % 5 === 0 ? accent2 : accent;
      context.beginPath();
      context.arc(position.x, position.y, 0.65 + position.depth * 0.75, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  updateProceduralState(time) {
    if (time >= this.nextVariationAt) {
      for (const node of this.nodes) {
        node.targetX = randomBetween(-0.026, 0.026);
        node.targetY = randomBetween(-0.022, 0.022);
      }
      this.nextVariationAt = time + randomBetween(3_500, 5_500);
    }
    for (const node of this.nodes) {
      node.offsetX += (node.targetX - node.offsetX) * 0.012;
      node.offsetY += (node.targetY - node.offsetY) * 0.012;
    }
    if (this.focus && time >= this.focus.startedAt + this.focus.duration) this.focus = null;
    if (!this.focus && time >= this.nextFocusAt) {
      this.focus = {
        x: randomBetween(0.24, 0.76),
        y: randomBetween(0.22, 0.78),
        startedAt: time,
        duration: randomBetween(360, 580),
      };
      this.nextFocusAt = time + randomBetween(3_200, 6_400);
    }
  }
}

function createNodes(count) {
  return Array.from({ length: count }, (_, index) => ({
    x: (index * 0.61803398875 + Math.random() * 0.08) % 1,
    y: (index * 0.38196601125 + Math.random() * 0.12) % 1,
    offsetX: 0,
    offsetY: 0,
    targetX: randomBetween(-0.02, 0.02),
    targetY: randomBetween(-0.018, 0.018),
    depth: randomBetween(0.25, 1),
    phase: randomBetween(0, Math.PI * 2),
    speed: randomBetween(0.18, 0.38),
  }));
}

function nodePosition(node, width, height, seconds, focus, focusIntensity, reducedMotion) {
  const waveX = reducedMotion ? 0 : Math.sin(seconds * node.speed + node.phase) * (1.5 + node.depth * 2.2);
  const waveY = reducedMotion ? 0 : Math.cos(seconds * node.speed * 0.78 + node.phase) * (1.2 + node.depth * 1.8);
  let x = (node.x + node.offsetX) * width + waveX;
  let y = (node.y + node.offsetY) * height + waveY;
  let focused = false;
  if (focus) {
    const distance = Math.hypot(node.x - focus.x, node.y - focus.y);
    if (distance < 0.24) {
      focused = true;
      const direction = Math.atan2(node.y - focus.y, node.x - focus.x);
      const radius = distance * Math.min(width, height) * (1 - focusIntensity * 0.08);
      x = focus.x * width + Math.cos(direction) * radius;
      y = focus.y * height + Math.sin(direction) * radius * 0.72;
    }
  }
  return { x, y, depth: node.depth, focused };
}

function statusLabelFor(state) {
  if (state === 'preparing') return 'Подготовка provider';
  if (state === 'generating') return 'Генерация';
  if (state === 'error') return 'Генерация остановлена';
  return 'Генерация';
}

function detectLowPerformance() {
  return Number(navigator.hardwareConcurrency || 4) <= 4
    || Number(navigator.deviceMemory || 8) <= 4;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
