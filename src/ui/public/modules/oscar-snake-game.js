const BOARD_SIZE = 18;
const REQUIRED_RAPID_CLICKS = 16;
const RAPID_CLICK_GAP_MS = 750;
const RAPID_CLICK_WINDOW_MS = 7_000;
const STEP_MS = 116;
const INSTALL_KEY = '__monarchOscarSnakeEasterEgg';

const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const KEY_DIRECTIONS = {
  ArrowUp: 'up',
  w: 'up',
  W: 'up',
  ArrowDown: 'down',
  s: 'down',
  S: 'down',
  ArrowLeft: 'left',
  a: 'left',
  A: 'left',
  ArrowRight: 'right',
  d: 'right',
  D: 'right',
};

const OPPOSITE_DIRECTION = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

export function registerRapidClick(clicks, now, options = {}) {
  const requiredClicks = Number(options.requiredClicks) || REQUIRED_RAPID_CLICKS;
  const maxGapMs = Number(options.maxGapMs) || RAPID_CLICK_GAP_MS;
  const maxWindowMs = Number(options.maxWindowMs) || RAPID_CLICK_WINDOW_MS;
  const previous = Array.isArray(clicks) ? clicks : [];
  const next = previous.length > 0 && now - previous.at(-1) <= maxGapMs
    ? [...previous, now].filter((timestamp) => now - timestamp <= maxWindowMs)
    : [now];
  return {
    clicks: next.slice(-requiredClicks),
    unlocked: next.length >= requiredClicks,
  };
}

export function directionForKey(key, currentDirection = 'right') {
  const requested = KEY_DIRECTIONS[key];
  if (!requested || OPPOSITE_DIRECTION[currentDirection] === requested) {
    return currentDirection;
  }
  return requested;
}

export function advanceSnake(snake, direction, bug, boardSize = BOARD_SIZE) {
  const vector = DIRECTIONS[direction] || DIRECTIONS.right;
  const head = snake[0];
  const nextHead = { x: head.x + vector.x, y: head.y + vector.y };
  const hitWall = nextHead.x < 0 || nextHead.y < 0 || nextHead.x >= boardSize || nextHead.y >= boardSize;
  const ate = Boolean(bug && nextHead.x === bug.x && nextHead.y === bug.y);
  const bodyToCheck = ate ? snake : snake.slice(0, -1);
  const hitSelf = bodyToCheck.some((part) => part.x === nextHead.x && part.y === nextHead.y);
  if (hitWall || hitSelf) {
    return { snake, ate: false, collided: true };
  }
  const nextSnake = [nextHead, ...snake];
  if (!ate) nextSnake.pop();
  return { snake: nextSnake, ate, collided: false };
}

export function findFreeBug(snake, boardSize = BOARD_SIZE, random = Math.random) {
  const occupied = new Set(snake.map((part) => `${part.x}:${part.y}`));
  const free = [];
  for (let y = 0; y < boardSize; y += 1) {
    for (let x = 0; x < boardSize; x += 1) {
      if (!occupied.has(`${x}:${y}`)) free.push({ x, y });
    }
  }
  if (free.length === 0) return null;
  const index = Math.min(free.length - 1, Math.floor(Math.max(0, random()) * free.length));
  return free[index];
}

export function installOscarSnakeEasterEgg(options = {}) {
  const documentObject = options.documentObject || globalThis.document;
  const windowObject = options.windowObject || globalThis.window;
  if (!documentObject?.addEventListener || !windowObject?.requestAnimationFrame) return null;
  if (documentObject[INSTALL_KEY]) return documentObject[INSTALL_KEY];

  let rapidClicks = [];
  let activeGame = null;

  const conversationIsEmpty = () => {
    if (typeof options.isConversationEmpty === 'function') return Boolean(options.isConversationEmpty());
    const liveThread = documentObject.querySelector('#oscar-thread');
    if (liveThread) return liveThread.classList.contains('is-empty');
    return Boolean(documentObject.querySelector('.messages.is-empty'));
  };

  const findHost = () => documentObject.querySelector('#mascot-view, #preview-mascot-view')
    || documentObject.querySelector('.mascot-panel');

  const onClick = (event) => {
    if (activeGame || !conversationIsEmpty()) {
      rapidClicks = [];
      return;
    }
    const target = event.target;
    if (!(target instanceof windowObject.Element)) return;
    const onMascot = target.closest('#mascot-view, #preview-mascot-view, .mascot-panel');
    const onEmptyChat = target.closest('#oscar-thread.is-empty, .messages.is-empty');
    const isControl = target.closest('button, a, input, textarea, select, [role="button"]');
    if ((!onMascot && !onEmptyChat) || isControl) return;

    const result = registerRapidClick(rapidClicks, performanceNow(windowObject), options);
    rapidClicks = result.clicks;
    if (!result.unlocked) return;
    rapidClicks = [];
    const host = findHost();
    if (host) activeGame = createGame({ documentObject, windowObject, host, onClosed: () => { activeGame = null; } });
  };

  const onPointerDown = (event) => {
    if (!activeGame || activeGame.contains(event.target)) return;
    activeGame.close();
  };

  const onKeyDown = (event) => {
    if (!activeGame) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      activeGame.close();
      return;
    }
    if (activeGame.handleKey(event.key)) event.preventDefault();
  };

  documentObject.addEventListener('click', onClick);
  documentObject.addEventListener('pointerdown', onPointerDown, true);
  documentObject.addEventListener('keydown', onKeyDown);

  const controller = {
    close: () => activeGame?.close(),
    isOpen: () => Boolean(activeGame),
    destroy() {
      activeGame?.close({ immediate: true });
      documentObject.removeEventListener('click', onClick);
      documentObject.removeEventListener('pointerdown', onPointerDown, true);
      documentObject.removeEventListener('keydown', onKeyDown);
      delete documentObject[INSTALL_KEY];
    },
  };
  documentObject[INSTALL_KEY] = controller;
  return controller;
}

function createGame({ documentObject, windowObject, host, onClosed }) {
  const root = documentObject.createElement('section');
  root.className = 'oscar-snake-game';
  root.dataset.phase = 'assembling';
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', 'Oscar Bug Hunt. Управление WASD или стрелками. Клик снаружи закрывает игру.');
  root.innerHTML = `
    <div class="oscar-snake-game__header">
      <span><i aria-hidden="true"></i> Oscar // Bug Hunt</span>
      <strong data-snake-score>BUGS 00</strong>
    </div>
    <div class="oscar-snake-game__board">
      <canvas data-snake-canvas aria-label="Игровое поле змейки Oscar"></canvas>
      <div class="oscar-snake-game__status" data-snake-status aria-live="polite"></div>
    </div>
    <div class="oscar-snake-game__hint">
      <span>WASD / ↑ ↓ ← →</span>
      <span>клик снаружи — выход</span>
    </div>
  `;

  host.append(root);
  host.classList.add('snake-game-active');
  const inspector = host.closest('.inspector');
  inspector?.classList.add('snake-game-host-active');

  const canvas = root.querySelector('[data-snake-canvas]');
  const scoreNode = root.querySelector('[data-snake-score]');
  const statusNode = root.querySelector('[data-snake-status]');
  const context = canvas.getContext('2d');
  const reducedMotion = windowObject.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const palette = readPalette(windowObject, host);
  const particles = createAssemblyParticles();
  let snake = initialSnake();
  let bug = findFreeBug(snake);
  let score = 0;
  let direction = 'right';
  let queuedDirection = 'right';
  let phase = reducedMotion ? 'ready' : 'assembling';
  let openedAt = performanceNow(windowObject);
  let lastStepAt = openedAt;
  let closingAt = 0;
  let frameId = 0;
  let closed = false;
  let viewportSize = 0;

  if (reducedMotion) root.dataset.phase = 'ready';

  const resizeObserver = typeof windowObject.ResizeObserver === 'function'
    ? new windowObject.ResizeObserver(() => resizeCanvas())
    : null;
  resizeObserver?.observe(canvas);

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const size = Math.min(520, Math.max(220, Math.round(rect.width || 320)));
    const dpr = Math.min(2, Math.max(1, windowObject.devicePixelRatio || 1));
    if (viewportSize === size && canvas.width === Math.round(size * dpr)) return;
    viewportSize = size;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resetGame() {
    snake = initialSnake();
    bug = findFreeBug(snake);
    score = 0;
    direction = 'right';
    queuedDirection = 'right';
    phase = 'playing';
    lastStepAt = performanceNow(windowObject);
    scoreNode.textContent = 'BUGS 00';
    statusNode.textContent = '';
    root.dataset.phase = 'playing';
  }

  function handleKey(key) {
    if (phase === 'closing') return false;
    if (phase === 'over' && ['r', 'R', 'Enter', ' '].includes(key)) {
      resetGame();
      return true;
    }
    if (!KEY_DIRECTIONS[key]) return false;
    queuedDirection = directionForKey(key, direction);
    if (phase === 'ready') {
      direction = queuedDirection;
      phase = 'playing';
      root.dataset.phase = 'playing';
      lastStepAt = performanceNow(windowObject);
    }
    return true;
  }

  function close(closeOptions = {}) {
    if (closed || phase === 'closing') return;
    if (closeOptions.immediate || reducedMotion) {
      teardown();
      return;
    }
    phase = 'closing';
    closingAt = performanceNow(windowObject);
    root.dataset.phase = 'closing';
    host.classList.add('snake-game-closing');
  }

  function teardown() {
    if (closed) return;
    closed = true;
    windowObject.cancelAnimationFrame(frameId);
    resizeObserver?.disconnect();
    root.remove();
    host.classList.remove('snake-game-active', 'snake-game-closing');
    inspector?.classList.remove('snake-game-host-active');
    onClosed();
  }

  function tick(now) {
    if (closed) return;
    resizeCanvas();
    if (phase === 'assembling' && now - openedAt >= 1080) {
      phase = 'ready';
      root.dataset.phase = 'ready';
      lastStepAt = now;
    }
    if (phase === 'playing' && now - lastStepAt >= STEP_MS) {
      direction = queuedDirection;
      const result = advanceSnake(snake, direction, bug);
      lastStepAt = now;
      if (result.collided) {
        phase = 'over';
        root.dataset.phase = 'over';
        statusNode.innerHTML = `<strong>BUG ESCAPED</strong><span>Оскар поймал ${score} · R — снова</span>`;
      } else {
        snake = result.snake;
        if (result.ate) {
          score += 1;
          bug = findFreeBug(snake);
          scoreNode.textContent = `BUGS ${String(score).padStart(2, '0')}`;
          root.classList.remove('bug-caught');
          void root.offsetWidth;
          root.classList.add('bug-caught');
        }
      }
    }
    drawFrame(context, {
      now,
      size: viewportSize,
      phase,
      openedAt,
      closingAt,
      particles,
      palette,
      snake,
      bug,
      direction,
    });
    if (phase === 'closing' && now - closingAt >= 540) {
      teardown();
      return;
    }
    frameId = windowObject.requestAnimationFrame(tick);
  }

  resizeCanvas();
  frameId = windowObject.requestAnimationFrame(tick);
  return { root, contains: (target) => root.contains(target), close, handleKey };
}

function initialSnake() {
  return [
    { x: 8, y: 9 },
    { x: 7, y: 9 },
    { x: 6, y: 9 },
    { x: 5, y: 9 },
    { x: 4, y: 9 },
  ];
}

function createAssemblyParticles() {
  const particles = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const seed = (x * 41 + y * 67 + (x + 3) * (y + 5) * 13) % 101;
      particles.push({
        x,
        y,
        drift: ((seed % 9) - 4) * 0.72,
        rise: 2.5 + (seed % 8) * 0.62,
        delay: ((x * 17 + y * 29 + seed) % 310),
        tone: (x + y * 3 + seed) % 19,
      });
    }
  }
  return particles;
}

function drawFrame(context, game) {
  const { size } = game;
  context.clearRect(0, 0, size, size);
  const pad = Math.max(5, size * 0.018);
  const cell = (size - pad * 2) / BOARD_SIZE;
  drawBoardPixels(context, game, pad, cell);
  if (game.phase !== 'closing') {
    const reveal = game.phase === 'assembling'
      ? clamp((game.now - game.openedAt - 650) / 280)
      : 1;
    if (reveal > 0) {
      context.save();
      context.globalAlpha = reveal;
      drawBug(context, game.bug, pad, cell, game.palette, game.now);
      drawOscarSnake(context, game.snake, game.direction, pad, cell, game.palette);
      context.restore();
    }
  }
}

function drawBoardPixels(context, game, pad, cell) {
  const elapsed = game.phase === 'closing'
    ? game.now - game.closingAt
    : game.now - game.openedAt;
  for (const particle of game.particles) {
    const targetX = pad + particle.x * cell;
    const targetY = pad + particle.y * cell;
    let x = targetX;
    let y = targetY;
    let alpha = 1;
    let scale = 1;
    if (game.phase === 'assembling') {
      const progress = clamp((elapsed - particle.delay) / 620);
      const eased = easeOutBack(progress);
      x += particle.drift * cell * (1 - eased);
      y -= particle.rise * cell * (1 - eased);
      alpha = progress;
      scale = 0.34 + progress * 0.66;
    } else if (game.phase === 'closing') {
      const progress = clamp((elapsed - particle.delay * 0.28) / 390);
      const eased = progress * progress;
      x += particle.drift * cell * 1.8 * eased;
      y += (3.4 + particle.rise * 0.7) * cell * eased;
      alpha = 1 - progress;
      scale = 1 - progress * 0.54;
    }
    context.save();
    context.globalAlpha = alpha;
    context.translate(x + cell / 2, y + cell / 2);
    context.scale(scale, scale);
    context.fillStyle = boardTone(game.palette, particle.tone);
    roundedRect(context, -cell * 0.46, -cell * 0.46, cell * 0.92, cell * 0.92, Math.max(1.5, cell * 0.13));
    context.fill();
    context.restore();
  }
}

function drawOscarSnake(context, snake, direction, pad, cell, palette) {
  snake.slice().reverse().forEach((part, reverseIndex) => {
    const index = snake.length - 1 - reverseIndex;
    const cx = pad + (part.x + 0.5) * cell;
    const cy = pad + (part.y + 0.5) * cell;
    if (index === 0) {
      drawOscarHead(context, cx, cy, cell, palette, direction);
      return;
    }
    const inset = cell * 0.13;
    context.save();
    context.fillStyle = index % 3 === 0 ? palette.orange : palette.ink;
    roundedRect(context, cx - cell / 2 + inset, cy - cell / 2 + inset, cell - inset * 2, cell - inset * 2, cell * 0.28);
    context.fill();
    context.fillStyle = index % 3 === 0 ? palette.ink : palette.yellow;
    context.globalAlpha = 0.92;
    const dot = Math.max(2, cell * 0.2);
    roundedRect(context, cx - dot / 2, cy - dot / 2, dot, dot, dot * 0.34);
    context.fill();
    context.restore();
  });
}

function drawOscarHead(context, cx, cy, cell, palette, direction) {
  const rotations = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
  context.save();
  context.translate(cx, cy);
  context.rotate(rotations[direction] || 0);
  context.fillStyle = palette.orange;
  context.beginPath();
  context.moveTo(-cell * 0.35, -cell * 0.28);
  context.lineTo(-cell * 0.12, -cell * 0.55);
  context.lineTo(cell * 0.02, -cell * 0.28);
  context.moveTo(-cell * 0.35, cell * 0.28);
  context.lineTo(-cell * 0.12, cell * 0.55);
  context.lineTo(cell * 0.02, cell * 0.28);
  context.fill();
  context.fillStyle = palette.ink;
  roundedRect(context, -cell * 0.38, -cell * 0.39, cell * 0.82, cell * 0.78, cell * 0.28);
  context.fill();
  context.fillStyle = palette.white;
  roundedRect(context, cell * 0.02, -cell * 0.25, cell * 0.22, cell * 0.18, cell * 0.07);
  context.fill();
  roundedRect(context, cell * 0.02, cell * 0.07, cell * 0.22, cell * 0.18, cell * 0.07);
  context.fill();
  context.fillStyle = palette.ink;
  context.fillRect(cell * 0.14, -cell * 0.21, cell * 0.055, cell * 0.1);
  context.fillRect(cell * 0.14, cell * 0.11, cell * 0.055, cell * 0.1);
  context.fillStyle = palette.yellow;
  context.fillRect(-cell * 0.09, -cell * 0.48, cell * 0.09, cell * 0.11);
  context.fillRect(cell * 0.01, -cell * 0.52, cell * 0.09, cell * 0.15);
  context.fillRect(cell * 0.11, -cell * 0.46, cell * 0.09, cell * 0.09);
  context.restore();
}

function drawBug(context, bug, pad, cell, palette, now) {
  if (!bug) return;
  const cx = pad + (bug.x + 0.5) * cell;
  const cy = pad + (bug.y + 0.5) * cell;
  const pulse = 0.9 + Math.sin(now / 180) * 0.08;
  context.save();
  context.translate(cx, cy);
  context.scale(pulse, pulse);
  context.globalAlpha = 0.22;
  context.fillStyle = palette.yellow;
  context.beginPath();
  context.arc(0, 0, cell * 0.62, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = palette.ink;
  context.lineWidth = Math.max(1, cell * 0.09);
  for (const sign of [-1, 1]) {
    for (const y of [-0.2, 0.06, 0.3]) {
      context.beginPath();
      context.moveTo(sign * cell * 0.22, y * cell);
      context.lineTo(sign * cell * 0.43, (y + (y === 0.06 ? 0 : y > 0 ? 0.1 : -0.1)) * cell);
      context.stroke();
    }
  }
  context.fillStyle = palette.orange;
  roundedRect(context, -cell * 0.27, -cell * 0.34, cell * 0.54, cell * 0.68, cell * 0.25);
  context.fill();
  context.fillStyle = palette.ink;
  context.fillRect(-cell * 0.035, -cell * 0.3, cell * 0.07, cell * 0.58);
  context.beginPath();
  context.arc(0, -cell * 0.35, cell * 0.16, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function boardTone(palette, tone) {
  if (tone === 0) return palette.orangeDark;
  if (tone === 5) return palette.yellowDark;
  if (tone === 11) return palette.whiteDark;
  return tone % 2 === 0 ? palette.boardA : palette.boardB;
}

function readPalette(windowObject, host) {
  const style = windowObject.getComputedStyle(host);
  const read = (...names) => {
    for (const name of names) {
      const value = style.getPropertyValue(name).trim();
      if (value) return value;
    }
    return '';
  };
  return {
    ink: '#101114',
    white: '#fffdf8',
    orange: read('--warning', '--accent-hover') || '#ed7d20',
    yellow: read('--yellow', '--accent') || '#ffc328',
    boardA: '#151619',
    boardB: '#1c1d20',
    orangeDark: '#4d2b18',
    yellowDark: '#4a3a12',
    whiteDark: '#403f3a',
  };
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function performanceNow(windowObject) {
  return windowObject.performance?.now?.() ?? Date.now();
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function easeOutBack(value) {
  const c1 = 1.42;
  const c3 = c1 + 1;
  return 1 + c3 * ((value - 1) ** 3) + c1 * ((value - 1) ** 2);
}
