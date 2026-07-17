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
  'command-center',
  'oscar-section',
  'security-section',
  'models-section',
]);

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
  if (!MASCOT_VISIBLE_VIEWS.has(viewId)) {
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
