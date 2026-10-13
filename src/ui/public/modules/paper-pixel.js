/* PaperPixel runtime: the pixel physics that CSS cannot do.
   One owner for every animated pixel in the app: a single requestAnimationFrame
   ticker drives all loaders and bursts, and sleeps when none are on screen.

   - Pixel loaders replace the classic thinking orb and spinners: a chaotic cloud
     of rotating rounded squares assembles into a ring, spins and scatters again.
   - burst(x, y) throws a handful of pixels that fall under gravity — only for
     confirmations (a finished first setup, an applied setting), never on every click.
   - Range inputs get their filled pixel track (--pp-range-fill).
   Everything is inert unless html[data-design="pp"]; reduced motion draws the
   final state without movement. */

import { reducedUiMotion } from './ui-motion.js';

const LOADER_SIZES = Object.freeze({
  xs: { box: 16, n: 7, px: 2.6, r: 5 },
  s: { box: 20, n: 8, px: 3, r: 6.2 },
  m: { box: 36, n: 10, px: 4.5, r: 12 },
  l: { box: 64, n: 12, px: 7, r: 22 },
});
const LOADER_CYCLE = 2.8; // seconds: 62% ring, 38% scatter
const CHECK_CELLS = [[0, 3], [1, 4], [2, 5], [3, 4], [4, 3], [5, 2], [6, 1]];

export function isPaperPixelDesign(root = document.documentElement) {
  return root?.dataset?.design === 'pp';
}

function prefersReduced() {
  return reducedUiMotion?.matches === true
    || document.documentElement.dataset.motion === 'reduced';
}

/* ----------------------------------------------------------- physics core */

function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const quarterDiff = (a, b) => { let d = (a - b) % 90; if (d > 45) d -= 90; if (d < -45) d += 90; return d; };

export function makePixel(x, y, size) {
  return { x, y, vx: 0, vy: 0, a: 0, va: 0, tx: x, ty: y, ta: 0, s: size, o: 1, k: 240, c: 18, free: false };
}

/** Semi-implicit Euler spring toward (tx, ty, ta); a square is symmetric every 90°. */
export function stepPixel(p, dt, gravity = 0) {
  if (p.free) {
    p.vy += gravity * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.va * dt;
    return;
  }
  p.vx += (-p.k * (p.x - p.tx) - p.c * p.vx) * dt;
  p.vy += (-p.k * (p.y - p.ty) - p.c * p.vy) * dt;
  p.x += p.vx * dt; p.y += p.vy * dt;
  p.va += (-p.k * quarterDiff(p.a, p.ta) - p.c * p.va) * dt;
  p.a += p.va * dt;
}

function drawPixels(ctx, pixels, color, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  for (const p of pixels) {
    if (p.o <= 0.01) continue;
    const s = p.s, r = s * 0.28, x = -s / 2, y = -s / 2;
    ctx.save();
    ctx.globalAlpha = p.o;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.a * Math.PI / 180);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + s, y, x + s, y + s, r);
    ctx.arcTo(x + s, y + s, x, y + s, r);
    ctx.arcTo(x, y + s, x, y, r);
    ctx.arcTo(x, y, x + s, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function setupCanvas(canvas, w, h) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/* ------------------------------------------------------ the one ticker */

const actors = new Set();
let frame = 0;
let last = 0;

function tick(now) {
  const dt = Math.min(0.033, Math.max(0, (now - last) / 1000));
  last = now;
  for (const actor of [...actors]) {
    if (actor.step(dt) === false) actors.delete(actor);
  }
  frame = actors.size ? requestAnimationFrame(tick) : 0;
}

function wake(actor) {
  actors.add(actor);
  if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); }
}

/* ------------------------------------------------------------- loader */

/** Mount a pixel loader into `host`. Returns the loader element. */
export function createPixelLoader({ size = 's', label = 'Загрузка' } = {}) {
  const cfg = LOADER_SIZES[size] || LOADER_SIZES.s;
  const el = document.createElement('span');
  el.className = 'pp-loader';
  el.dataset.ppSize = size;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  el.append(canvas);
  const B = cfg.box, C = B / 2;
  const ctx = setupCanvas(canvas, B, B);
  if (!ctx) return el;
  const rand = rng(B * 7919 + Math.floor(Math.random() * 1e6));
  const cloud = (p) => { const m = cfg.px; p.tx = m + rand() * (B - 2 * m); p.ty = m + rand() * (B - 2 * m); p.ta = rand() * 90; };
  const pixels = Array.from({ length: cfg.n }, () => { const p = makePixel(0, 0, cfg.px); cloud(p); p.x = p.tx; p.y = p.ty; p.a = rand() * 90; return p; });
  const kSnap = 520, cSnap = 34, kSoft = 84, cSoft = 9, spin = 720, impulse = 380 * B / 120;
  let t = rand() * LOADER_CYCLE, phase = '', ring = 0, colorAge = 1, color = '#0b0b0b', settled = 0, done = false, stepIndex = 0, stepClock = 0;

  const readColor = () => { color = getComputedStyle(el).color || color; };
  const placeRing = (dim) => pixels.forEach((p, i) => {
    const ang = i / pixels.length * Math.PI * 2 - Math.PI / 2;
    p.x = C + Math.cos(ang) * cfg.r; p.y = C + Math.sin(ang) * cfg.r; p.a = ang * 180 / Math.PI;
    p.o = dim ? (i === stepIndex % pixels.length ? 1 : 0.3) : 1;
  });
  const placeCheck = () => pixels.forEach((p, i) => {
    const [cx, cy] = CHECK_CELLS[i % CHECK_CELLS.length], g = B * 0.78 / 7;
    p.tx = C + (cx - 3) * g; p.ty = C + (cy - 3) * g; p.ta = 0; p.k = kSnap; p.c = cSnap;
  });

  const actor = {
    step(dt) {
      if (!el.isConnected) return false;
      colorAge += dt;
      if (colorAge > 0.5) { readColor(); colorAge = 0; }
      if (prefersReduced()) {
        stepClock += dt;
        if (done) { placeCheck(); pixels.forEach((p) => { p.x = p.tx; p.y = p.ty; p.a = 0; p.o = 1; }); drawPixels(ctx, pixels, color, B, B); return false; }
        if (stepClock >= 0.16 || phase !== 'reduced') { stepClock = 0; stepIndex += 1; phase = 'reduced'; placeRing(true); drawPixels(ctx, pixels, color, B, B); }
        return true;
      }
      t += dt;
      const u = (t % LOADER_CYCLE) / LOADER_CYCLE;
      const next = done ? 'done' : u < 0.62 ? 'ring' : 'scatter';
      if (next !== phase) {
        if (next === 'scatter') {
          for (const p of pixels) {
            const dx = p.x - C, dy = p.y - C, d = Math.hypot(dx, dy) || 1;
            p.vx += dx / d * impulse * (0.6 + rand() * 0.8);
            p.vy += dy / d * impulse * (0.6 + rand() * 0.8);
            p.va += (rand() - 0.5) * 2 * spin;
            p.k = kSoft; p.c = cSoft; cloud(p);
          }
        } else if (next === 'ring') {
          for (const p of pixels) { p.k = kSnap; p.c = cSnap; p.o = 1; }
        } else if (next === 'done') {
          placeCheck();
        }
        phase = next; settled = 0;
      }
      if (phase === 'ring') {
        ring += dt * 300;
        const local = t % LOADER_CYCLE;
        pixels.forEach((p, i) => {
          if (local < i * 0.035) return; // each pixel joins in turn: a chase
          const deg = ring + i * 360 / pixels.length, ang = deg * Math.PI / 180;
          p.tx = C + Math.cos(ang) * cfg.r; p.ty = C + Math.sin(ang) * cfg.r; p.ta = deg;
        });
      } else if (phase === 'scatter' && rand() < dt * 3) {
        cloud(pixels[Math.floor(rand() * pixels.length)]);
      }
      for (const p of pixels) stepPixel(p, dt);
      drawPixels(ctx, pixels, color, B, B);
      if (phase === 'done') {
        const energy = pixels.reduce((e, p) => e + Math.abs(p.vx) + Math.abs(p.vy) + Math.abs(p.x - p.tx) + Math.abs(p.y - p.ty), 0);
        settled = energy < 0.5 ? settled + dt : 0;
        if (settled > 0.3) return false;
      }
      return true;
    },
  };
  /** Collapse the ring into a pixel tick (the process finished). */
  el.ppDone = () => { done = true; el.setAttribute('aria-label', 'Готово'); wake(actor); };
  el.ppRestart = () => { done = false; wake(actor); };
  queueMicrotask(() => { readColor(); wake(actor); });
  return el;
}

/* -------------------------------------------------------------- burst */

/** A handful of pixels thrown from (x, y) that fall and fade. Confirmations only. */
export function burst(x, y, { count = 10, size = 8, color } = {}) {
  if (!isPaperPixelDesign() || prefersReduced()) return;
  const W = 220, H = 220;
  const canvas = document.createElement('canvas');
  canvas.className = 'pp-burst';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.left = `${x - W / 2}px`;
  canvas.style.top = `${y - H / 2}px`;
  document.body.append(canvas);
  const ctx = setupCanvas(canvas, W, H);
  if (!ctx) { canvas.remove(); return; }
  const ink = color || getComputedStyle(document.documentElement).getPropertyValue('--pp-ink').trim() || '#0b0b0b';
  const rand = rng(Math.floor(x * 131 + y * 17 + performance.now()));
  const pixels = Array.from({ length: count }, () => {
    const p = makePixel(W / 2, H / 2, size * (0.6 + rand() * 0.5));
    const ang = -Math.PI / 2 + (rand() - 0.5) * Math.PI * 1.1, speed = 380 * (0.7 + rand() * 0.9);
    p.vx = Math.cos(ang) * speed; p.vy = Math.sin(ang) * speed; p.va = (rand() - 0.5) * 1440; p.a = rand() * 90; p.free = true;
    return p;
  });
  let t = 0;
  wake({
    step(dt) {
      t += dt;
      const k = t / 0.62;
      for (const p of pixels) { stepPixel(p, dt, 2200); p.o = Math.min(1, Math.max(0, 1.4 - k * 1.4)); }
      drawPixels(ctx, pixels, ink, W, H);
      if (k >= 1) { canvas.remove(); return false; }
      return true;
    },
  });
}

/* ---------------------------------------------- mounting in the app shell */

/* Hosts whose own animation the pixel loader replaces, and its size there. */
const LOADER_HOSTS = [
  ['.monarch-thinking-orb', 'xs', 'append'],
  ['.spinner', 'xs', 'append'],
  ['.memory-loading-state > span', 'xs', 'append'],
  ['.attachment-loading', 'xs', 'prepend'],
];

function mountLoaders(scope) {
  if (!isPaperPixelDesign()) return;
  for (const [selector, size, place] of LOADER_HOSTS) {
    const hosts = scope.matches?.(selector) ? [scope] : [...(scope.querySelectorAll?.(selector) || [])];
    for (const host of hosts) {
      if (host.querySelector(':scope > .pp-loader')) continue;
      // Hosts live in re-rendered markup: the loader is a decoration the DOM
      // sync keeps, and the host is styled by `:has(> .pp-loader)`, not a class.
      const loader = createPixelLoader({ size, label: host.getAttribute('aria-label') || 'Загрузка' });
      loader.setAttribute('data-dom-decoration', '');
      if (place === 'prepend') host.prepend(loader); else host.append(loader);
    }
  }
}

function syncRange(input) {
  const min = Number(input.min || 0), max = Number(input.max || 100);
  const pct = max > min ? (Number(input.value) - min) / (max - min) * 100 : 0;
  input.style.setProperty('--pp-range-fill', `${Math.max(0, Math.min(100, pct))}%`);
}

function syncRanges(scope) {
  const inputs = scope.matches?.('input[type="range"]') ? [scope] : [...(scope.querySelectorAll?.('input[type="range"]') || [])];
  inputs.forEach(syncRange);
}

/* ------------------------------------------------ voice mode: pixel ring */

/* In PaperPixel the voice orb is a ring of pixels. The surface's visual state
   picks the motion: listening turns slowly and follows the microphone level,
   thinking scatters and gathers, speaking ripples with the voice, paused dims,
   an error lets the pixels fall. Sleeps while voice mode is hidden. */
function mountVoiceRing() {
  const orb = document.querySelector('#oscar-voice-mode-orb');
  const surface = orb?.closest('.oscar-voice-mode');
  if (!orb || !surface || orb.querySelector('.pp-voice-ring')) return;
  const S = 240, C = S / 2, N = 18, R = 78, SIZE = 12;
  const canvas = document.createElement('canvas');
  canvas.className = 'pp-voice-ring';
  canvas.setAttribute('aria-hidden', 'true');
  orb.append(canvas);
  const ctx = setupCanvas(canvas, S, S);
  if (!ctx) return;
  const rand = rng(40503);
  const pixels = Array.from({ length: N }, (_, i) => {
    const a = i / N * Math.PI * 2;
    const p = makePixel(C + Math.cos(a) * R, C + Math.sin(a) * R, SIZE);
    p.a = a * 180 / Math.PI;
    return p;
  });
  let spin = 0, t = 0, fell = false, awake = false, color = '#0b0b0b';
  const level = (name) => Number.parseFloat(surface.style.getPropertyValue(name)) || 0;
  const stateOf = () => surface.dataset.phase === 'error' ? 'error' : (surface.dataset.visualState || 'paused');
  const placeRing = () => pixels.forEach((p, i) => { const a = i / N * Math.PI * 2; p.x = C + Math.cos(a) * R; p.y = C + Math.sin(a) * R; p.a = a * 180 / Math.PI; p.o = 1; });
  const actor = {
    step(dt) {
      if (!canvas.isConnected || surface.hidden || !isPaperPixelDesign()) { awake = false; return false; }
      color = getComputedStyle(canvas).color || color;
      const state = stateOf();
      if (prefersReduced()) { placeRing(); pixels.forEach((p) => { p.o = state === 'paused' ? 0.45 : 1; }); drawPixels(ctx, pixels, color, S, S); awake = false; return false; }
      t += dt;
      const thinking = state === 'thinking' || state === 'recognizing' || state === 'routing';
      const scatter = thinking && (t % 2.4) > 1.5;
      spin += (state === 'listening' ? 50 : state === 'speaking' ? 110 : thinking ? 240 : 0) * dt;
      const amp = state === 'speaking' ? 6 + level('--voice-output-level') * 26 : state === 'listening' ? level('--voice-input-level') * 22 : 0;
      pixels.forEach((p, i) => {
        p.o = state === 'paused' ? 0.45 : 1;
        if (state === 'error') {
          if (!fell) { p.free = true; p.vx = (rand() - 0.5) * 160; p.vy = -60 - rand() * 120; p.va = (rand() - 0.5) * 900; }
          stepPixel(p, dt, 1800);
          if (p.y > S - SIZE) { p.y = S - SIZE; p.vy *= -0.3; p.vx *= 0.8; p.va *= 0.7; }
          return;
        }
        p.free = false;
        if (scatter) {
          if (rand() < dt * 4) { p.tx = 16 + rand() * (S - 32); p.ty = 16 + rand() * (S - 32); p.ta = rand() * 90; }
          p.k = 90; p.c = 10;
        } else {
          const deg = spin + i * 360 / N, a = deg * Math.PI / 180;
          const r = R + (amp ? Math.sin(t * 8 + i * 0.9) * amp : 0);
          p.tx = C + Math.cos(a) * r; p.ty = C + Math.sin(a) * r; p.ta = deg; p.k = 360; p.c = 26;
        }
        stepPixel(p, dt);
      });
      fell = state === 'error';
      drawPixels(ctx, pixels, color, S, S);
      const resting = state === 'paused' || state === 'error' || state === 'idle';
      const energy = pixels.reduce((e, p) => e + Math.abs(p.vx) + Math.abs(p.vy), 0);
      if (resting && energy < 1 && t > 0.8) { awake = false; return false; }
      return true;
    },
  };
  const rouse = () => { if (!awake && !surface.hidden && isPaperPixelDesign()) { awake = true; t = 0; wake(actor); } };
  new MutationObserver(rouse).observe(surface, { attributes: true, attributeFilter: ['hidden', 'data-visual-state', 'data-phase', 'style'] });
  placeRing();
  drawPixels(ctx, pixels, color, S, S);
  rouse();
}

/* Confirmations that earn a burst: the primary action of a question sheet
   and the last step of first setup. */
const BURST_TARGETS = '.monarch-question-dialog .claude-primary-btn, .setup-step--done .setup-primary, [data-pp-burst]';

let started = false;

/** Start the PaperPixel runtime once; it follows the design attribute live. */
export function initPaperPixel() {
  if (started || typeof document === 'undefined') return;
  started = true;
  const root = document.documentElement;
  const refresh = () => {
    if (!isPaperPixelDesign()) return;
    mountLoaders(document.body);
    syncRanges(document.body);
    mountVoiceRing();
  };
  new MutationObserver((records) => {
    if (!isPaperPixelDesign()) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        mountLoaders(node);
        syncRanges(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  new MutationObserver(refresh).observe(root, { attributes: true, attributeFilter: ['data-design'] });
  document.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'range') syncRange(event.target);
  }, true);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest(BURST_TARGETS) : null;
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect();
    burst(event.clientX || rect.left + rect.width / 2, event.clientY || rect.top + rect.height / 2);
  }, true);
  refresh();
}

/* ---------------------------------------------------- design preference */

/** Settings → System → Design cards; the preference owner stays in app.js. */
export function syncDesignCards(root = document) {
  const design = document.documentElement.dataset.design === 'classic' ? 'classic' : 'pp';
  root.querySelectorAll('[data-design-card]').forEach((card) => {
    const checked = card.dataset.designCard === design;
    card.setAttribute('aria-checked', String(checked));
    card.tabIndex = checked ? 0 : -1;
  });
}
