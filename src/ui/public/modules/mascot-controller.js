const MASCOT_BASE_PATH = '/assets/mascot/';

export const MASCOT_STATES = {
  idle: { asset: 'oscar-idle.png', alt: 'Oscar idle' },
  sleep: { asset: 'oscar-idle.png', alt: 'Oscar resting' },
  read: { asset: 'oscar-thinking.png', alt: 'Oscar reading' },
  play: { asset: 'oscar-success.png', alt: 'Oscar playing' },
  listening: { asset: 'oscar-listening.png', alt: 'Oscar listening' },
  thinking: { asset: 'oscar-thinking.png', alt: 'Oscar thinking' },
  coding: { asset: 'oscar-coding.png', alt: 'Oscar coding' },
  security: { asset: 'oscar-security.png', alt: 'Oscar security watch' },
  success: { asset: 'oscar-success.png', alt: 'Oscar completed' },
  error: { asset: 'oscar-error.png', alt: 'Oscar needs attention' },
};

const MASCOT_VISIBLE_VIEWS = new Set([
  'oscar-section',
]);

const MASCOT_LAYOUT_STORAGE_KEY = 'monarch.mascot.layout.v2';
const MASCOT_INTERACTION_INSTALL_KEY = '__monarchMascotInteraction';
const MASCOT_MIN_SIZE = 88;
const MASCOT_MAX_SIZE = 320;

let currentMascotState = '';
let idleActionTimer = null;
let idleActionResetTimer = null;
let idleActionUntil = 0;
let idleActionState = '';

const IDLE_ACTIONS = [
  { state: 'play', title: 'Oscar играет', detail: 'Пауза. Можно дать следующую задачу.', meta: 'Пауза', duration: 6200 },
  { state: 'read', title: 'Oscar читает', detail: 'Тихо держит контекст рядом.', meta: 'Контекст', duration: 6800 },
  { state: 'sleep', title: 'Oscar отдыхает', detail: 'Ждет нового запроса без лишнего шума.', meta: 'Тихий режим', duration: 7200 },
];

export function setMascotView(viewId) {
  const inspector = document.getElementById('inspector');
  if (!inspector) {
    return;
  }
  inspector.classList.toggle('mascot-active', MASCOT_VISIBLE_VIEWS.has(viewId));
  inspector.dataset.mascotView = viewId || '';
  const shell = inspector.closest('.app-shell');
  const visible = shell?.classList.contains('mascot-empty-home') === true
    || (shell?.classList.contains('mascot-dialog-active') === true
      && shell.classList.contains('mascot-visible'));
  inspector.setAttribute('aria-hidden', String(!visible || !MASCOT_VISIBLE_VIEWS.has(viewId)));
  if (!MASCOT_VISIBLE_VIEWS.has(viewId) || !visible) {
    clearIdleAction();
    clearIdleActionTimer();
  } else if (currentMascotState === 'idle') {
    scheduleIdleAction();
  }
}

export function setMascotState(stateName, options = {}) {
  const mascotImg = document.getElementById('mascot-img');
  const mascotView = document.getElementById('mascot-view');
  const mascotTitle = document.getElementById('mascot-title');
  const mascotDetail = document.getElementById('mascot-detail');
  const mascotMeta = document.getElementById('mascot-meta');
  if (!mascotImg || !mascotView) {
    return;
  }

  const resolvedState = resolveMascotState(stateName);
  const now = Date.now();
  if (resolvedState === 'idle' && idleActionState && now < idleActionUntil && !options.force) {
    return;
  }
  if (resolvedState !== 'idle' && !options.transient) {
    clearIdleAction();
  }
  const config = MASCOT_STATES[resolvedState];
  const src = `${MASCOT_BASE_PATH}${config.asset}`;
  mascotView.dataset.mascotState = resolvedState;
  if (mascotTitle) {
    mascotTitle.textContent = options.title || titleForMascotState(resolvedState);
  }
  if (mascotDetail) {
    mascotDetail.textContent = options.detail || detailForMascotState(resolvedState);
  }
  if (mascotMeta) {
    mascotMeta.textContent = options.meta || metaForMascotState(resolvedState);
  }
  if (options.detail) {
    mascotView.title = String(options.detail);
  }
  if (currentMascotState !== resolvedState || mascotImg.getAttribute('src') !== src) {
    currentMascotState = resolvedState;
    mascotImg.src = src;
    mascotImg.alt = config.alt;
  }
  if (resolvedState === 'idle') {
    scheduleIdleAction();
  }
}

export function syncMascotFromRuntime({ activeView, busy, errored, securityRunning, coding, detail } = {}) {
  if (activeView) {
    setMascotView(activeView);
  }
  if (errored) {
    setMascotState('error', { title: 'Oscar', detail: detail || 'Нужно внимание к runtime' });
    return;
  }
  if (coding) {
    setMascotState('coding', { title: 'Oscar пишет код', detail: 'Кодовое полотно обновляется' });
    return;
  }
  if (busy) {
    setMascotState('thinking', { title: 'Oscar думает', detail: 'Идёт локальная генерация' });
    return;
  }
  if (activeView === 'security-section') {
    setMascotState(securityRunning ? 'security' : 'listening', {
      title: 'Monarch Security',
      detail: securityRunning ? 'Мониторинг активен' : 'Готов к проверке',
    });
    return;
  }
  setMascotState('idle', { title: 'Oscar', detail: detail || 'Готов к локальной работе' });
}

export function createDefaultMascotLayout(viewport = {}) {
  const width = Math.max(320, Number(viewport.width) || 1280);
  const height = Math.max(320, Number(viewport.height) || 720);
  const size = width <= 620 ? 88 : width <= 980 ? 92 : 104;
  const x = width - size - (width <= 620 ? 18 : 32);
  const y = Math.max(86, height - size - (width <= 620 ? 190 : 180));
  return clampMascotLayout({ x, y, size }, { width, height });
}

export function hasSentOscarMessage(messages) {
  return Array.isArray(messages) && messages.some((message) => message?.role === 'user');
}

export function clampMascotLayout(layout = {}, viewport = {}) {
  const width = Math.max(320, Number(viewport.width) || 1280);
  const height = Math.max(320, Number(viewport.height) || 720);
  const maxSize = Math.max(MASCOT_MIN_SIZE, Math.min(MASCOT_MAX_SIZE, width - 16, height - 16));
  const size = clampNumber(Number(layout.size) || MASCOT_MIN_SIZE, MASCOT_MIN_SIZE, maxSize);
  return {
    x: clampNumber(Number(layout.x) || 0, 8, Math.max(8, width - size - 8)),
    y: clampNumber(Number(layout.y) || 0, 8, Math.max(8, height - size - 8)),
    size,
  };
}

export function initMascotInteraction(options = {}) {
  const documentObject = options.documentObject || globalThis.document;
  const windowObject = options.windowObject || globalThis.window;
  if (!documentObject?.querySelector || !windowObject?.addEventListener) return null;
  if (documentObject[MASCOT_INTERACTION_INSTALL_KEY]) return documentObject[MASCOT_INTERACTION_INSTALL_KEY];

  const inspector = documentObject.querySelector(options.inspectorSelector || '#inspector');
  const mascotView = documentObject.querySelector(options.mascotSelector || '#mascot-view');
  const resizeHandle = documentObject.querySelector(options.resizeSelector || '[data-mascot-resize]');
  if (!inspector || !mascotView || !resizeHandle) return null;

  const readViewport = () => ({
    width: Math.max(320, Number(windowObject.innerWidth) || 1280),
    height: Math.max(320, Number(windowObject.innerHeight) || 720),
  });
  let layout = loadMascotLayout(windowObject, readViewport());
  let gesture = null;
  let suppressClick = false;

  const applyLayout = (nextLayout) => {
    layout = clampMascotLayout(nextLayout, readViewport());
    inspector.style.setProperty('--mascot-x', `${Math.round(layout.x)}px`);
    inspector.style.setProperty('--mascot-y', `${Math.round(layout.y)}px`);
    inspector.style.setProperty('--mascot-size', `${Math.round(layout.size)}px`);
    inspector.dataset.mascotPositioned = 'true';
  };

  const persistLayout = () => {
    try {
      windowObject.localStorage?.setItem(MASCOT_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Layout persistence is optional.
    }
  };

  const beginGesture = (mode, event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (inspector.classList.contains('snake-game-host-active')) return;
    const shell = inspector.closest('.app-shell');
    if (
      !shell?.classList.contains('mascot-dialog-active')
      || !shell.classList.contains('mascot-visible')
      || !inspector.classList.contains('mascot-active')
    ) return;
    event.preventDefault();
    event.stopPropagation();
    gesture = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      layout: { ...layout },
      moved: false,
    };
    inspector.classList.toggle('is-resizing', mode === 'resize');
    inspector.classList.toggle('is-dragging', mode === 'drag');
    event.currentTarget?.setPointerCapture?.(event.pointerId);
  };

  const onMascotPointerDown = (event) => {
    if (event.target.closest('button, a, input, textarea, select, [role="button"], .oscar-snake-game')) return;
    beginGesture('drag', event);
  };
  const onResizePointerDown = (event) => beginGesture('resize', event);
  const onPointerMove = (event) => {
    if (!gesture || (gesture.pointerId !== undefined && event.pointerId !== gesture.pointerId)) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    gesture.moved ||= Math.abs(deltaX) + Math.abs(deltaY) > 4;
    if (gesture.mode === 'resize') {
      applyLayout({
        ...gesture.layout,
        size: gesture.layout.size + Math.max(deltaX, deltaY),
      });
    } else {
      applyLayout({
        ...gesture.layout,
        x: gesture.layout.x + deltaX,
        y: gesture.layout.y + deltaY,
      });
    }
  };
  const endGesture = (event) => {
    if (!gesture || (gesture.pointerId !== undefined && event.pointerId !== gesture.pointerId)) return;
    suppressClick = gesture.moved;
    gesture = null;
    inspector.classList.remove('is-dragging', 'is-resizing');
    persistLayout();
    windowObject.setTimeout?.(() => { suppressClick = false; }, 0);
  };
  const suppressDraggedClick = (event) => {
    if (!suppressClick || !mascotView.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  };
  const onWindowResize = () => {
    applyLayout(layout);
    persistLayout();
  };

  mascotView.addEventListener('pointerdown', onMascotPointerDown);
  resizeHandle.addEventListener('pointerdown', onResizePointerDown);
  windowObject.addEventListener('pointermove', onPointerMove);
  windowObject.addEventListener('pointerup', endGesture);
  windowObject.addEventListener('pointercancel', endGesture);
  windowObject.addEventListener('resize', onWindowResize);
  documentObject.addEventListener('click', suppressDraggedClick, true);
  applyLayout(layout);

  const controller = {
    getLayout: () => ({ ...layout }),
    resetPosition() {
      applyLayout(createDefaultMascotLayout(readViewport()));
      persistLayout();
      return { ...layout };
    },
    destroy() {
      mascotView.removeEventListener('pointerdown', onMascotPointerDown);
      resizeHandle.removeEventListener('pointerdown', onResizePointerDown);
      windowObject.removeEventListener('pointermove', onPointerMove);
      windowObject.removeEventListener('pointerup', endGesture);
      windowObject.removeEventListener('pointercancel', endGesture);
      windowObject.removeEventListener('resize', onWindowResize);
      documentObject.removeEventListener('click', suppressDraggedClick, true);
      delete documentObject[MASCOT_INTERACTION_INSTALL_KEY];
    },
  };
  documentObject[MASCOT_INTERACTION_INSTALL_KEY] = controller;
  return controller;
}

function scheduleIdleAction() {
  clearIdleActionTimer();
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    return;
  }
  const mascotView = document.getElementById('mascot-view');
  const inspector = document.getElementById('inspector');
  if (!mascotView || !inspector || !inspector.classList.contains('mascot-active')) {
    return;
  }
  const delay = 9000 + Math.floor(Math.random() * 9000);
  idleActionTimer = setTimeout(startIdleAction, delay);
}

function startIdleAction() {
  clearIdleActionTimer();
  if (currentMascotState !== 'idle') {
    return;
  }
  const action = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)];
  idleActionState = action.state;
  idleActionUntil = Date.now() + action.duration;
  setMascotState(action.state, {
    title: action.title,
    detail: action.detail,
    meta: action.meta,
    transient: true,
  });
  clearTimeout(idleActionResetTimer);
  idleActionResetTimer = setTimeout(() => {
    idleActionState = '';
    idleActionUntil = 0;
    setMascotState('idle', { force: true });
  }, action.duration);
}

function clearIdleActionTimer() {
  clearTimeout(idleActionTimer);
  idleActionTimer = null;
}

function clearIdleAction() {
  clearIdleActionTimer();
  clearTimeout(idleActionResetTimer);
  idleActionResetTimer = null;
  idleActionState = '';
  idleActionUntil = 0;
}

function resolveMascotState(value) {
  return Object.prototype.hasOwnProperty.call(MASCOT_STATES, value) ? value : 'idle';
}

function titleForMascotState(value) {
  switch (value) {
  case 'play':
    return 'Oscar играет';
  case 'read':
    return 'Oscar читает';
  case 'thinking':
    return 'Oscar думает';
  case 'coding':
    return 'Oscar пишет код';
  case 'security':
    return 'Monarch Security';
  case 'success':
    return 'Готово';
  case 'error':
    return 'Нужно внимание';
  default:
    return 'Oscar';
  }
}

function detailForMascotState(value) {
  switch (value) {
  case 'play':
    return 'Пауза перед следующим запросом';
  case 'read':
    return 'Держит контекст рядом';
  case 'sleep':
    return 'Ждет без лишнего шума';
  case 'thinking':
    return 'Идёт локальная генерация';
  case 'coding':
    return 'Кодовое полотно обновляется';
  case 'security':
    return 'Мониторинг активен';
  case 'success':
    return 'Операция завершена';
  case 'error':
    return 'Проверь runtime';
  default:
    return 'Готов к локальной работе';
  }
}

function metaForMascotState(value) {
  switch (value) {
  case 'play':
    return 'Пауза';
  case 'read':
    return 'Контекст';
  case 'listening':
    return 'Контекст';
  case 'thinking':
    return 'Анализ';
  case 'coding':
    return 'Код';
  case 'security':
    return 'Защита';
  case 'success':
    return 'Готово';
  case 'error':
    return 'Внимание';
  case 'sleep':
    return 'Пауза';
  default:
    return 'Готов';
  }
}

function loadMascotLayout(windowObject, viewport) {
  try {
    const stored = JSON.parse(windowObject.localStorage?.getItem(MASCOT_LAYOUT_STORAGE_KEY) || 'null');
    if (stored && typeof stored === 'object') return clampMascotLayout(stored, viewport);
  } catch {
    // Use a safe in-chat default when storage is unavailable or invalid.
  }
  return createDefaultMascotLayout(viewport);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
