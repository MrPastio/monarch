import {
  fetchState,
  installModels,
  saveModelPreference,
  skipModelOnboarding,
} from './api.js';
import { state, updateState } from './state.js';
import { changeThemeWithReveal } from './theme-transition.js';
import { reducedUiMotion } from './ui-motion.js';
import { createLanguagePicker } from './ui-i18n.js';
import { escapeHtml, readErrorMessage } from './utils.js';

/* First setup: theme → where Oscar thinks (local / MAX / both) → the matching
   setup → summary. One animation owner (`showStep`), interruptible, with a
   reduced-motion path. The flow opens by itself on a fresh install and from
   Settings → Система at any time. */

const BACKGROUND_KEY = 'monarch.setup.background-install';
const FEATURED_PROVIDERS = ['groq', 'gemini', 'openai', 'anthropic', 'openrouter', 'deepseek'];
const PROVIDER_LOGOS = new Set(['groq', 'openai', 'anthropic', 'gemini', 'openrouter', 'deepseek', 'mistral', 'xai', 'together', 'fireworks', 'cerebras', 'nvidia']);
const PROVIDER_HINTS = { groq: 'Есть бесплатный старт', gemini: 'Есть бесплатный старт', openrouter: 'Много моделей в одном ключе' };
const STEP_LABELS = { look: 'Вид', mode: 'Режим', local: 'Модель', max: 'MAX', done: 'Готово' };
const MODE_LABELS = { local: 'На компьютере', max: 'Через MAX', hybrid: 'MAX + компьютер' };
const KEY_PATTERN = /^[\x21-\x7e]{20,512}$/u;
const CHECK_SVG = '<svg viewBox="0 0 16 16"><path d="M3.5 8.4l2.9 2.9 6.1-6.6" pathLength="1"/></svg>';

const $ = (selector, root = document) => root.querySelector(selector);
const elements = {
  root: $('#model-setup'),
  shell: $('#app-shell'),
  stage: $('#setup-stage'),
  rail: $('#setup-rail'),
  close: $('#setup-close'),
  hardware: $('#model-setup-hardware'),
  list: $('#model-setup-list'),
  reveal: $('#model-setup-reveal'),
  all: $('#model-setup-all'),
  allInput: $('#model-setup-all-input'),
  totalSize: $('#model-setup-total-size'),
  install: $('#model-setup-install'),
  skip: $('#model-setup-skip'),
  feedback: $('#model-setup-feedback'),
  progress: $('#model-setup-progress'),
  manualModels: $('#model-setup-manual-models'),
  openFolder: $('#model-setup-open-folder'),
  manualFeedback: $('#model-setup-manual-feedback'),
  providers: $('#setup-providers'),
  providersMore: $('#setup-providers-more'),
  connect: $('#setup-connect'),
  connectSubmit: $('#setup-connect-submit'),
  connected: $('#setup-connected'),
  key: $('#setup-key'),
  summary: $('#setup-summary'),
  fallback: $('#setup-fallback'),
  fallbackInput: $('#setup-fallback-input'),
  finish: $('#setup-finish'),
  pill: $('#setup-download-pill'),
};

const flow = {
  open: false,
  mode: 'first',
  step: 'hello',
  work: null,
  local: 'pending',
  max: 'pending',
  providers: [],
  providersLoaded: false,
  providersExpanded: false,
  chosenProvider: null,
  connectedProvider: null,
  connecting: false,
  finishing: false,
  fallback: true,
  opener: null,
};

let initialized = false;
let expanded = false;
let selectionTouched = false;
let selectedRoles = new Set();
let running = [];

export function initModelOnboarding() {
  if (initialized || !elements.root) return;
  initialized = true;
  // Language comes first: everything after it reads in the chosen one.
  const hello = elements.root.querySelector('[data-setup-step="hello"] .setup-actions');
  hello?.before(createLanguagePicker({ className: 'setup-language', onChange: (language) => window.dispatchEvent(
    new CustomEvent('monarch:set-ui-preference', { detail: { key: 'language', value: language } })) }));

  elements.root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-setup-next]')) { void next(); return; }
    if (target.closest('[data-setup-back]')) { back(); return; }
    const theme = target.closest('[data-setup-theme]');
    if (theme) { chooseTheme(theme.dataset.setupTheme, theme); return; }
    const mode = target.closest('[data-setup-mode]');
    if (mode) { chooseMode(mode.dataset.setupMode); return; }
    const provider = target.closest('[data-setup-provider]');
    if (provider) { chooseProvider(provider.dataset.setupProvider); return; }
    if (target.closest('[data-setup-max-skip]')) { flow.max = 'skipped'; void goTo(nextStepAfter('max'), 1); return; }
    if (target.closest('[data-setup-reconnect]')) { flow.connectedProvider = null; flow.max = 'pending'; renderMax(); return; }
    if (target.closest('[data-setup-paste]')) { void pasteKey(); }
  });
  elements.root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && flow.mode === 'revisit') { event.preventDefault(); closeFlow(); return; }
    const radio = event.target instanceof Element ? event.target.closest('[role="radio"]') : null;
    if (radio && ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const group = [...radio.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]:not([hidden])')];
      const index = group.indexOf(radio) + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1);
      const target = group[(index + group.length) % group.length];
      target?.focus();
      target?.click();
    }
  });
  elements.close?.addEventListener('click', () => closeFlow());
  elements.root.addEventListener('scroll', () => {
    elements.root.dataset.scrolled = String(elements.root.scrollTop > 4);
  }, { passive: true });
  elements.reveal?.addEventListener('click', () => { expanded = !expanded; renderLocal(); });
  elements.allInput?.addEventListener('change', () => {
    const roles = readModels().map((model) => model.role);
    selectedRoles = elements.allInput.checked ? new Set(roles) : new Set();
    selectionTouched = true;
    renderLocal();
  });
  elements.list?.addEventListener('change', (event) => {
    const input = event.target instanceof Element ? event.target.closest('[data-model-setup-role]') : null;
    if (!(input instanceof HTMLInputElement)) return;
    const role = input.dataset.modelSetupRole;
    if (!role) return;
    if (input.checked) selectedRoles.add(role);
    else selectedRoles.delete(role);
    selectionTouched = true;
    renderLocal();
  });
  elements.install?.addEventListener('click', () => void beginInstall());
  elements.skip?.addEventListener('click', () => { flow.local = 'skipped'; void goTo(nextStepAfter('local'), 1); });
  elements.openFolder?.addEventListener('click', () => void openModelsFolder());
  elements.providersMore?.addEventListener('click', () => { flow.providersExpanded = !flow.providersExpanded; renderMax(); });
  elements.connect?.addEventListener('input', () => syncConnect());
  elements.connect?.addEventListener('change', () => syncConnect());
  elements.connect?.addEventListener('submit', (event) => { event.preventDefault(); void connectProvider(); });
  elements.fallbackInput?.addEventListener('change', () => { flow.fallback = elements.fallbackInput.checked; });
  elements.finish?.addEventListener('click', () => void finish());
  elements.pill?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view: 'settings-section', subview: 'models' } }));
  });
  window.addEventListener('monarch:open-setup', (event) => openFlow('revisit', event.detail?.opener || null));
  window.addEventListener('monarch:ui-preferences-applied', () => { if (flow.open) syncChoices(); });
}

export function renderModelOnboarding() {
  if (!elements.root) return;
  const components = readComponents();
  const required = components?.onboarding?.required === true;
  const active = components?.activeInstall || null;
  if (!required) clearBackgroundInstall();
  if (!required && setupNeverFinished(components) && !flow.open && !flow.finishing) {
    // An install that already had models (an update from 0.2.x, or files placed
    // by hand) never saw this setup: theme, work mode and MAX are asked once.
    openFlow('first');
  }
  if (required && !flow.open && !flow.finishing) {
    const background = readBackgroundInstall() && (active || !components.onboarding.error);
    if (!background) {
      clearBackgroundInstall();
      openFlow('first');
      // A failed background download brings the person back to the model step.
      if (components.onboarding.error && components.onboarding.selectedRoles?.length) {
        flow.work = flow.work || 'local';
        void goTo('local', 1, { instant: true });
      }
    }
  }
  if (flow.open) {
    if (flow.step === 'local') renderLocal();
    if (flow.step === 'done') renderSummary();
  }
  renderPill(active);
}

/** The installed app has never finished the first setup: the work mode it saves
 * is still unset. Development runs (`not-applicable`) never open it by themselves. */
function setupNeverFinished(components) {
  const completion = components?.onboarding?.completion;
  if (!completion || completion === 'not-applicable' || completion === 'pending') return false;
  const preference = state.data?.modelPreference;
  return Boolean(preference) && (preference.work === null || preference.work === undefined);
}

/* ---------- open / close ---------- */

function openFlow(mode, opener = null) {
  if (flow.open) return;
  Object.assign(flow, {
    open: true,
    mode,
    step: 'hello',
    work: state.data?.modelPreference?.work || null,
    local: 'pending',
    max: 'pending',
    chosenProvider: null,
    connectedProvider: null,
    finishing: false,
    fallback: state.data?.modelPreference?.maxLocalFallback !== false,
    opener,
  });
  selectionTouched = false;
  expanded = false;
  elements.root.hidden = false;
  elements.root.dataset.mode = mode;
  elements.close.hidden = mode !== 'revisit';
  $('[data-setup-kicker]', elements.root).textContent = mode === 'revisit' ? 'Настройка Monarch' : 'Первый запуск';
  $('#setup-title').textContent = mode === 'revisit' ? 'Настроим заново?' : 'Привет! Я Оскар.';
  $('[data-setup-step="hello"] .setup-lead', elements.stage).textContent = mode === 'revisit'
    ? 'Можно поменять вид, режим работы, модели и MAX. Ничего не изменится, пока не нажмёшь «Начать общение».'
    : 'Настроим Monarch под тебя. Это займёт минуту — потом всё можно поменять в настройках.';
  elements.shell?.setAttribute('inert', '');
  document.body.classList.add('model-setup-open');
  for (const step of elements.stage.querySelectorAll('[data-setup-step]')) step.hidden = step.dataset.setupStep !== 'hello';
  elements.root.dataset.step = 'hello';
  renderRail();
  syncChoices();
  if (!reducedUiMotion.matches) {
    elements.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out' });
    staggerIn($('[data-setup-step="hello"]', elements.stage), '.setup-oscar, .setup-kicker, h1, .setup-lead, .setup-actions', 120);
  }
  requestAnimationFrame(() => focusStep($('[data-setup-step="hello"]', elements.stage)));
}

async function closeFlow() {
  if (!flow.open) return;
  flow.open = false;
  settleTransitions();
  const done = () => {
    elements.root.hidden = true;
    document.body.classList.remove('model-setup-open');
    const stillRequired = readComponents()?.onboarding?.required === true && !readBackgroundInstall();
    if (!stillRequired) elements.shell?.removeAttribute('inert');
    flow.opener?.focus?.({ preventScroll: true });
  };
  if (reducedUiMotion.matches) { done(); return; }
  const card = elements.stage;
  const animations = [
    elements.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }),
    card.animate([{ transform: 'none' }, { transform: 'translateY(10px) scale(.985)' }], { duration: 360, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }),
  ];
  await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  done();
  animations.forEach((animation) => animation.cancel());
}

/* ---------- navigation ---------- */

function sequence() {
  const steps = ['hello', 'look', 'mode'];
  if (flow.work === 'local') steps.push('local');
  if (flow.work === 'max') steps.push('max');
  if (flow.work === 'hybrid') steps.push('local', 'max');
  steps.push('done');
  return steps;
}

function nextStepAfter(step) {
  const steps = sequence();
  return steps[Math.min(steps.length - 1, steps.indexOf(step) + 1)] || 'done';
}

async function next() {
  if (flow.step === 'mode' && !flow.work) return;
  if (flow.step === 'mode') {
    // Remember the choice right away so the rest of Monarch can adapt.
    void saveModelPreference({ work: flow.work }).catch(() => undefined);
  }
  await goTo(nextStepAfter(flow.step), 1);
}

function back() {
  const steps = sequence();
  const index = steps.indexOf(flow.step);
  if (index > 0) void goTo(steps[index - 1], -1);
}

async function goTo(step, direction, options = {}) {
  if (!elements.stage) return;
  const current = $(`[data-setup-step="${flow.step}"]`, elements.stage);
  const incoming = $(`[data-setup-step="${step}"]`, elements.stage);
  if (!incoming || current === incoming) return;
  settleTransitions();
  flow.step = step;
  elements.root.dataset.step = step;
  renderStep(step);
  renderRail();
  const fromHeight = elements.stage.getBoundingClientRect().height;
  incoming.hidden = false;
  const reduce = options.instant || reducedUiMotion.matches;
  if (reduce || !current) {
    if (current) current.hidden = true;
    focusStep(incoming);
    return;
  }
  // Both steps share one grid cell: the old one leaves the way it came, the
  // new one arrives from the direction of travel, and the stage eases between
  // the two heights instead of jumping.
  current.classList.add('is-leaving');
  const toHeight = incoming.getBoundingClientRect().height;
  const shift = direction >= 0 ? 1 : -1;
  running = [
    current.animate([
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: `translateX(${-28 * shift}px) scale(.985)` },
    ], { duration: 240, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }),
    incoming.animate([
      { opacity: 0, transform: `translateX(${36 * shift}px)` },
      { opacity: 1, transform: 'none' },
    ], { duration: 460, delay: 90, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' }),
    elements.stage.animate([{ height: `${fromHeight}px` }, { height: `${toHeight}px` }], { duration: 420, easing: 'cubic-bezier(.2, .8, .2, 1)' }),
  ];
  staggerIn(incoming, '.setup-choice, .setup-provider, .setup-model, .setup-summary > *', 60, 140);
  const leaving = running[0];
  leaving.finished.then(() => {
    current.hidden = true;
    current.classList.remove('is-leaving');
    leaving.cancel();
  }, () => undefined);
  focusStep(incoming);
}

function settleTransitions() {
  for (const animation of running) animation.cancel();
  running = [];
  for (const step of elements.stage?.querySelectorAll('.setup-step.is-leaving') || []) {
    step.hidden = true;
    step.classList.remove('is-leaving');
  }
}

function focusStep(step) {
  const heading = step.querySelector('h1, h2');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  elements.root.scrollTo?.({ top: 0 });
}

function staggerIn(root, selector, gap = 60, delay = 0) {
  if (!root || reducedUiMotion.matches) return;
  [...root.querySelectorAll(selector)].forEach((node, index) => {
    node.animate([
      { opacity: 0, transform: 'translateY(10px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 420, delay: delay + index * gap, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' });
  });
}

function renderStep(step) {
  syncChoices();
  if (step === 'local') renderLocal();
  if (step === 'max') { renderMax(); if (!flow.providersLoaded) void loadProviders(); }
  if (step === 'done') renderSummary();
  renderCounts();
}

function renderCounts() {
  const steps = sequence().filter((name) => name !== 'hello' && name !== 'done');
  for (const section of elements.stage.querySelectorAll('[data-setup-step]')) {
    const node = section.querySelector('[data-setup-count]');
    const index = steps.indexOf(section.dataset.setupStep);
    if (node) node.textContent = index >= 0 ? `Шаг ${index + 1} из ${steps.length}` : '';
  }
}

function renderRail() {
  if (!elements.rail) return;
  const steps = sequence().filter((name) => name !== 'hello');
  const current = steps.indexOf(flow.step);
  elements.rail.dataset.idle = String(flow.step === 'hello');
  elements.rail.style.setProperty('--rail-progress', String(Math.max(0, current) / Math.max(1, steps.length - 1)));
  const signature = steps.join('|');
  if (elements.rail.dataset.signature !== signature) {
    elements.rail.dataset.signature = signature;
    elements.rail.innerHTML = steps.map((name) => `<li data-rail="${name}"><span aria-hidden="true"></span><small>${STEP_LABELS[name]}</small></li>`).join('');
  }
  steps.forEach((name, index) => {
    const item = elements.rail.querySelector(`[data-rail="${name}"]`);
    if (!item) return;
    item.dataset.state = index < current ? 'done' : index === current ? 'current' : 'next';
    if (index === current) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}

/* ---------- theme & mode ---------- */

function chooseTheme(theme, origin) {
  void changeThemeWithReveal(theme, origin);
}

function chooseMode(mode) {
  if (!MODE_LABELS[mode]) return;
  flow.work = mode;
  syncChoices();
  renderRail();
  renderCounts();
}

function syncChoices() {
  const root = document.documentElement;
  const theme = root.dataset.themePreference || (root.dataset.theme === 'dark' ? 'dark' : 'light');
  for (const node of elements.root.querySelectorAll('[data-setup-theme]')) {
    node.setAttribute('aria-checked', String(node.dataset.setupTheme === theme));
    node.tabIndex = node.dataset.setupTheme === theme ? 0 : -1;
  }
  for (const node of elements.root.querySelectorAll('[data-setup-mode]')) {
    const checked = node.dataset.setupMode === flow.work;
    node.setAttribute('aria-checked', String(checked));
    node.tabIndex = checked || (!flow.work && node.dataset.setupMode === recommendedMode()) ? 0 : -1;
  }
  const recommended = recommendedMode();
  for (const node of elements.root.querySelectorAll('[data-setup-mode] .setup-badge')) {
    const mode = node.closest('[data-setup-mode]').dataset.setupMode;
    node.classList.toggle('is-recommended', mode === recommended);
    if (mode === recommended) node.textContent = 'Рекомендуем';
    else node.textContent = { local: 'Приватно', max: 'Мощно', hybrid: 'Вместе' }[mode];
  }
  const nextButton = $('[data-setup-step="mode"] [data-setup-next]', elements.stage);
  if (nextButton) nextButton.disabled = !flow.work;
  const hint = $('[data-setup-mode-hint]', elements.stage);
  if (hint) hint.textContent = modeHint();
}

function recommendedMode() {
  const ram = Number(readComponents()?.onboarding?.hardware?.ramTotalGb);
  return Number.isFinite(ram) && ram > 0 && ram < 8 ? 'max' : 'hybrid';
}

function modeHint() {
  const recommended = readModels().find((model) => model.role === readComponents()?.onboarding?.recommendedRole);
  const size = recommended ? formatBytes(recommended.expectedBytes) : '';
  if (flow.work === 'local') return size ? `Скачаем модель под твой компьютер — около ${size}.` : 'Выберем модель под твой компьютер.';
  if (flow.work === 'max') return 'Понадобится ключ сервиса — покажу, где его взять.';
  if (flow.work === 'hybrid') return 'Сначала выберем модель для компьютера, потом подключим MAX.';
  return '';
}

/* ---------- local models ---------- */

function renderLocal() {
  const components = readComponents();
  if (!components) {
    elements.list.innerHTML = '<p class="setup-empty">Модели можно будет скачать в Настройки → Модели.</p>';
    return;
  }
  const models = readModels();
  const recommendedRole = components.onboarding?.recommendedRole;
  const active = components.activeInstall;
  const installing = Boolean(active);
  if (!selectionTouched) {
    const persisted = components.onboarding?.selectedRoles || [];
    selectedRoles = new Set(persisted.length > 0 ? persisted : [recommendedRole].filter(Boolean));
  }
  renderHardware(components.onboarding?.hardware);
  const visible = expanded ? models : models.filter((model) => model.role === recommendedRole || selectedRoles.has(model.role));
  const signature = JSON.stringify([visible.map((model) => [model.role, model.installed, model.warning]), [...selectedRoles], installing]);
  if (elements.list.dataset.signature !== signature) {
    elements.list.dataset.signature = signature;
    elements.list.innerHTML = visible.map((model) => modelCard(model, recommendedRole, selectedRoles.has(model.role), installing)).join('');
  }
  if (elements.reveal) {
    elements.reveal.textContent = expanded ? 'Скрыть остальные' : 'Показать все модели';
    elements.reveal.setAttribute('aria-expanded', String(expanded));
    elements.reveal.hidden = installing || models.length < 2;
  }
  if (elements.all) elements.all.hidden = !expanded || installing;
  if (elements.allInput) elements.allInput.checked = models.length > 0 && models.every((model) => selectedRoles.has(model.role));
  if (elements.totalSize) elements.totalSize.textContent = formatBytes(models.reduce((sum, model) => sum + model.expectedBytes, 0));
  const allInstalled = [...selectedRoles].length > 0 && [...selectedRoles].every((role) => models.find((model) => model.role === role)?.installed);
  if (elements.install) {
    const count = selectedRoles.size;
    elements.install.disabled = count === 0 && !installing;
    elements.install.textContent = installing ? 'Дальше — скачается в фоне'
      : allInstalled ? 'Уже скачано — дальше'
        : count > 1 ? `Скачать модели (${count})` : 'Скачать и продолжить';
  }
  if (elements.skip) elements.skip.hidden = installing || allInstalled;
  if (elements.feedback) {
    elements.feedback.textContent = components.onboarding?.error
      || (selectedRoles.size === 0 ? 'Выбери хотя бы одну модель — или пропусти этот шаг.' : '');
  }
  renderProgress(models, active);
  renderManualModels(models);
}

function renderHardware(hardware) {
  if (!elements.hardware) return;
  const chips = [];
  const ram = Number(hardware?.ramTotalGb);
  if (Number.isFinite(ram) && ram > 0) chips.push(chip('memory', 'Память', `${formatNumber(ram)} ГБ`));
  const disk = Number(hardware?.diskFreeBytes);
  if (Number.isFinite(disk) && disk >= 0) chips.push(chip('disk', 'Свободно', formatBytes(disk)));
  elements.hardware.innerHTML = chips.join('');
  elements.hardware.hidden = chips.length === 0;
}

function chip(kind, label, value) {
  const icon = kind === 'memory'
    ? '<path d="M4 8h16v8H4z"/><path d="M8 8V5M12 8V5M16 8V5M8 19v-3M12 19v-3M16 19v-3"/>'
    : '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>';
  return `<span class="setup-chip"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`;
}

function modelCard(model, recommendedRole, selected, disabled) {
  const status = model.installed ? '<b class="setup-state is-ready">Уже скачана</b>' : '';
  const warning = model.warning ? `<small class="setup-model-warning">${escapeHtml(model.warning)}</small>` : '';
  return `
    <label class="setup-model ${selected ? 'is-selected' : ''}" data-phase="${escapeHtml(model.phase)}">
      <input type="checkbox" data-model-setup-role="${escapeHtml(model.role)}" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="setup-model-meter" aria-hidden="true" data-tier="${escapeHtml(model.role)}"><i></i><i></i><i></i></span>
      <span class="setup-model-copy">
        <span class="setup-model-title"><strong>${escapeHtml(model.label)}</strong>${model.role === recommendedRole ? '<b class="setup-state is-recommended">Подходит лучше всего</b>' : ''}${model.beta ? '<em>Beta</em>' : ''}${status}</span>
        <small>${escapeHtml(model.summary)} · нужно ${escapeHtml(String(model.recommendedRamGb || '—'))} ГБ памяти</small>
        ${warning}
      </span>
      <span class="setup-model-size">${escapeHtml(formatBytes(model.expectedBytes))}</span>
      <span class="setup-tick" aria-hidden="true">${CHECK_SVG}</span>
    </label>`;
}

function renderProgress(models, active) {
  if (!elements.progress) return;
  const snapshot = installProgress(models, active);
  if (!snapshot) {
    elements.progress.hidden = true;
    elements.progress.innerHTML = '';
    return;
  }
  elements.progress.hidden = false;
  elements.progress.style.setProperty('--progress', String(snapshot.percent / 100));
  elements.progress.innerHTML = `
    <div><strong>${escapeHtml(snapshot.label)}</strong><span>${snapshot.percent}%</span></div>
    <span class="setup-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${snapshot.percent}"><i></i></span>
    <p>${escapeHtml(formatBytes(snapshot.downloaded))} из ${escapeHtml(formatBytes(snapshot.expected))} · можно идти дальше, загрузка продолжится</p>`;
}

function installProgress(models, active) {
  if (!active) return null;
  const selected = models.filter((model) => active.roles.includes(model.role));
  const expected = selected.reduce((sum, model) => sum + model.expectedBytes, 0);
  const downloaded = selected.reduce((sum, model) => sum + model.downloadedBytes, 0);
  const percent = expected > 0 ? Math.max(0, Math.min(100, Math.round((downloaded / expected) * 100))) : 0;
  const current = selected.find((model) => ['checking', 'downloading', 'verifying'].includes(model.phase))
    || selected.find((model) => !model.complete) || selected.at(-1);
  return { percent, expected, downloaded, label: current?.label || 'Модель' };
}

function renderManualModels(models) {
  if (!elements.manualModels) return;
  const signature = models.map((model) => model.role).join('|');
  if (elements.manualModels.dataset.signature === signature) return;
  elements.manualModels.dataset.signature = signature;
  elements.manualModels.innerHTML = models.map((model) => {
    const files = Array.isArray(model.manualInstall) ? model.manualInstall : [];
    const directories = [...new Set(files.map((file) => file.directory))];
    return `
      <article class="setup-manual-model">
        <header><strong>${escapeHtml(model.label)}</strong><span>${files.length} ${files.length === 1 ? 'файл' : 'файла'}</span></header>
        ${directories.map((directory) => `<p>Папка: <code>${escapeHtml(directory.replaceAll('/', '\\'))}</code></p>`).join('')}
        <div>${files.map((file) => `
          <a href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer"><span>Скачать</span><strong>${escapeHtml(file.fileName)}</strong></a>`).join('')}</div>
      </article>`;
  }).join('');
}

async function beginInstall() {
  const components = readComponents();
  if (components?.activeInstall) { flow.local = 'installing'; await goTo(nextStepAfter('local'), 1); return; }
  const roles = [...selectedRoles];
  const models = readModels();
  if (roles.length > 0 && roles.every((role) => models.find((model) => model.role === role)?.installed)) {
    flow.local = 'ready';
    await goTo(nextStepAfter('local'), 1);
    return;
  }
  if (roles.length === 0 || !elements.install) return;
  elements.install.disabled = true;
  if (elements.feedback) elements.feedback.textContent = '';
  try {
    const required = components?.onboarding?.required === true;
    await installModels(roles, required && flow.mode === 'first' ? 'onboarding' : 'settings');
    flow.local = 'installing';
    updateState(await fetchState());
    await goTo(nextStepAfter('local'), 1);
  } catch (error) {
    if (elements.feedback) elements.feedback.textContent = readErrorMessage(error);
    elements.install.disabled = false;
  }
}

async function openModelsFolder() {
  if (elements.manualFeedback) elements.manualFeedback.textContent = '';
  const openFolder = window.monarchDesktop?.openModelsFolder;
  if (typeof openFolder !== 'function') {
    if (elements.manualFeedback) {
      elements.manualFeedback.textContent = 'Открой эту инструкцию в установленном приложении Monarch — кнопка сама найдёт нужную папку.';
    }
    return;
  }
  const result = await openFolder().catch(() => ({ ok: false }));
  if (!result?.ok && elements.manualFeedback) {
    elements.manualFeedback.textContent = 'Папка не открылась. Перезапусти Monarch и попробуй ещё раз.';
  }
}

/* ---------- MAX ---------- */

async function loadProviders() {
  const bridge = window.monarchDesktop?.astraMax;
  if (typeof bridge?.providers !== 'function') {
    flow.providersLoaded = true;
    flow.providers = [];
    renderMax('MAX подключается в приложении Monarch. Этот шаг можно пропустить.');
    return;
  }
  try {
    const value = await bridge.providers();
    flow.providers = Array.isArray(value?.providers) ? value.providers.filter(validProvider) : [];
    flow.providersLoaded = true;
    const ready = flow.providers.find((item) => item.id === value?.selectedProviderId && item.state === 'ready')
      || flow.providers.find((item) => item.state === 'ready');
    if (ready && flow.max !== 'skipped') { flow.connectedProvider = ready; flow.max = 'connected'; }
    renderMax(value?.available === false ? value.detail || 'Подключения сейчас недоступны.' : '');
  } catch {
    flow.providersLoaded = true;
    renderMax('Не удалось загрузить сервисы. Этот шаг можно пропустить и вернуться позже.');
  }
}

function validProvider(item) {
  return item && /^[a-z]{2,20}$/u.test(item.id) && typeof item.name === 'string'
    && [item.keysUrl, item.termsUrl, item.privacyUrl].every((url) => typeof url === 'string' && url.startsWith('https://'));
}

function renderMax(notice = '') {
  if (!elements.providers) return;
  const connected = flow.max === 'connected' && flow.connectedProvider;
  const ordered = [...flow.providers].sort((left, right) => rank(left.id) - rank(right.id));
  const visible = flow.providersExpanded ? ordered : ordered.filter((item) => FEATURED_PROVIDERS.includes(item.id) || item.id === flow.chosenProvider?.id);
  elements.providers.hidden = Boolean(connected);
  const signature = JSON.stringify([ordered.map((item) => [item.id, item.state]), visible.length, flow.chosenProvider?.id || '']);
  if (elements.providers.dataset.signature !== signature) {
    const first = !elements.providers.dataset.signature;
    elements.providers.dataset.signature = signature;
    elements.providers.innerHTML = visible.length
      ? visible.map(providerTile).join('')
      : `<p class="setup-empty">${escapeHtml(notice || 'Загружаю сервисы…')}</p>`;
    if (!first) staggerIn(elements.providers, '.setup-provider', 30);
  }
  if (elements.providersMore) {
    elements.providersMore.hidden = Boolean(connected) || ordered.length <= FEATURED_PROVIDERS.length;
    elements.providersMore.textContent = flow.providersExpanded ? 'Только популярные' : `Ещё сервисы (${Math.max(0, ordered.length - FEATURED_PROVIDERS.length)})`;
    elements.providersMore.setAttribute('aria-expanded', String(flow.providersExpanded));
  }
  const showForm = !connected && Boolean(flow.chosenProvider);
  revealBlock(elements.connect, showForm);
  revealBlock(elements.connected, Boolean(connected));
  if (connected) {
    $('[data-setup-connected-title]', elements.connected).textContent = `${flow.connectedProvider.name} подключён`;
  }
  if (showForm) fillConnect(flow.chosenProvider);
  const maxStep = $('[data-setup-step="max"]', elements.stage);
  $('[data-setup-max-continue]', maxStep).hidden = !connected;
  elements.connectSubmit.hidden = Boolean(connected);
  $('[data-setup-max-skip]', maxStep).hidden = Boolean(connected);
  syncConnect();
}

function rank(id) {
  const index = FEATURED_PROVIDERS.indexOf(id);
  return index === -1 ? 100 : index;
}

function providerTile(provider) {
  const selected = flow.chosenProvider?.id === provider.id;
  const logo = PROVIDER_LOGOS.has(provider.id)
    ? `<img src="/assets/provider-logos/${provider.id}.svg" alt="" width="26" height="26">`
    : `<span>${escapeHtml(provider.mark || provider.name.slice(0, 1))}</span>`;
  // Nothing picked or connected yet: Groq is the free way in, named with its model.
  const freeOffer = !flow.chosenProvider && !flow.providers.some((item) => item.state === 'ready');
  const freeStart = freeOffer && provider.id === 'groq';
  // While Groq carries the free badge, other "free start" hints would dilute it.
  const hint = freeOffer && PROVIDER_HINTS[provider.id] === 'Есть бесплатный старт' ? '' : PROVIDER_HINTS[provider.id] || '';
  const note = provider.state === 'ready' ? 'Ключ уже сохранён' : freeStart ? 'GPT OSS 120B' : hint;
  return `
    <button class="setup-provider${freeStart ? ' setup-provider--free' : ''}" type="button" role="radio" aria-checked="${selected}" tabindex="${selected || (!flow.chosenProvider && provider.id === 'groq') ? 0 : -1}" data-setup-provider="${escapeHtml(provider.id)}">
      <span class="setup-provider-logo" aria-hidden="true">${logo}</span>
      <span class="setup-provider-copy"><strong>${escapeHtml(provider.name)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</span>
      ${freeStart ? '<span class="setup-free-badge">Бесплатно</span>' : ''}
    </button>`;
}

function chooseProvider(id) {
  const provider = flow.providers.find((item) => item.id === id);
  if (!provider || flow.connecting) return;
  if (provider.state === 'ready') {
    // Already connected earlier: pick it, no key needed.
    void selectExisting(provider);
    return;
  }
  flow.chosenProvider = provider;
  renderMax();
  requestAnimationFrame(() => elements.key?.focus({ preventScroll: false }));
}

async function selectExisting(provider) {
  const bridge = window.monarchDesktop?.astraMax;
  try {
    const result = await bridge?.selectProvider?.(provider.id);
    if (result && !result.ok) throw new Error(result.detail);
    flow.connectedProvider = provider;
    flow.max = 'connected';
    window.dispatchEvent(new CustomEvent('monarch:max-connected', { detail: { providerId: provider.id } }));
    renderMax();
  } catch (error) {
    const feedback = $('[data-setup-connect-feedback]', elements.connect);
    if (feedback) feedback.textContent = readErrorMessage(error) || 'Не удалось выбрать сервис.';
  }
}

function fillConnect(provider) {
  const form = elements.connect;
  if (form.dataset.provider === provider.id) return;
  form.dataset.provider = provider.id;
  const logo = $('[data-setup-connect-logo]', form);
  logo.innerHTML = PROVIDER_LOGOS.has(provider.id) ? `<img src="/assets/provider-logos/${provider.id}.svg" alt="" width="28" height="28">` : escapeHtml(provider.mark || '');
  $('[data-setup-connect-name]', form).textContent = provider.name;
  $('[data-setup-connect-model]', form).textContent = `Модель: ${provider.id === 'groq' ? 'GPT OSS 120B' : provider.model}. Сменить можно потом.`;
  $('[data-setup-keys]', form).href = provider.keysUrl;
  $('[data-setup-terms]', form).href = provider.termsUrl;
  $('[data-setup-privacy]', form).href = provider.privacyUrl;
  elements.key.value = '';
  form.querySelectorAll('[data-setup-consent]').forEach((input) => { input.checked = false; });
  $('[data-setup-connect-feedback]', form).textContent = '';
}

function acknowledgements() {
  return Object.fromEntries([...elements.connect.querySelectorAll('[data-setup-consent]')]
    .map((input) => [input.dataset.setupConsent, input.checked]));
}

function syncConnect() {
  if (!elements.connectSubmit) return;
  const ack = acknowledgements();
  const ready = Boolean(flow.chosenProvider) && KEY_PATTERN.test(elements.key.value.trim())
    && ack.nonLocalProcessing && ack.selectedContext && ack.providerTerms;
  elements.connectSubmit.disabled = !ready || flow.connecting;
  elements.connectSubmit.textContent = flow.connecting ? 'Проверяю ключ…' : 'Подключить';
  elements.connect.setAttribute('aria-busy', String(flow.connecting));
}

async function pasteKey() {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) { elements.key.value = text; syncConnect(); }
  } catch {
    elements.key.focus();
    const feedback = $('[data-setup-connect-feedback]', elements.connect);
    if (feedback) feedback.textContent = 'Нажми Ctrl+V в поле ключа.';
  }
}

async function connectProvider() {
  const provider = flow.chosenProvider;
  const bridge = window.monarchDesktop?.astraMax;
  const feedback = $('[data-setup-connect-feedback]', elements.connect);
  if (!provider || flow.connecting || elements.connectSubmit.disabled) return;
  if (typeof bridge?.configureProvider !== 'function') {
    feedback.textContent = 'Подключить MAX можно в приложении Monarch.';
    return;
  }
  flow.connecting = true;
  syncConnect();
  feedback.textContent = 'Проверяю ключ и модель. Ещё немного…';
  const input = { providerId: provider.id, modelId: provider.model, apiKey: elements.key.value.trim(), acknowledgements: acknowledgements() };
  try {
    const result = await bridge.configureProvider(input);
    if (!result?.ok) { feedback.textContent = result?.detail || 'Подключение не сохранено. Попробуй снова.'; return; }
    if (Array.isArray(result.providers)) flow.providers = result.providers.filter(validProvider);
    flow.connectedProvider = flow.providers.find((item) => item.id === provider.id) || provider;
    flow.max = 'connected';
    flow.chosenProvider = null;
    elements.key.value = '';
    feedback.textContent = '';
    window.dispatchEvent(new CustomEvent('monarch:max-connected', { detail: { providerId: provider.id } }));
    renderMax();
    $('[data-setup-max-continue]', elements.stage)?.focus({ preventScroll: true });
  } catch {
    feedback.textContent = 'Не получилось сохранить подключение. Попробуй ещё раз.';
  } finally {
    input.apiKey = '';
    flow.connecting = false;
    syncConnect();
  }
}

/* One owner for show/hide of in-step blocks: height and opacity from the
   place the block belongs to, never a jump. */
function revealBlock(node, visible) {
  if (!node || node.hidden === !visible) return;
  if (reducedUiMotion.matches || !flow.open) { node.hidden = !visible; return; }
  node.getAnimations().forEach((animation) => animation.cancel());
  if (visible) {
    node.hidden = false;
    const height = node.scrollHeight;
    node.animate([
      { opacity: 0, height: '0px', transform: 'translateY(-6px)' },
      { opacity: 1, height: `${height}px`, transform: 'none' },
    ], { duration: 380, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  } else {
    const height = node.getBoundingClientRect().height;
    const animation = node.animate([
      { opacity: 1, height: `${height}px` },
      { opacity: 0, height: '0px' },
    ], { duration: 220, easing: 'cubic-bezier(.4, 0, 1, 1)' });
    animation.finished.then(() => { node.hidden = true; }, () => undefined);
  }
}

/* ---------- summary & finish ---------- */

function renderSummary() {
  const components = readComponents();
  const models = readModels();
  const active = components?.activeInstall || null;
  const progress = installProgress(models, active);
  const theme = document.documentElement.dataset.theme === 'dark' ? 'Тёмная' : 'Светлая';
  const installed = models.filter((model) => model.installed);
  const selectedLabels = models.filter((model) => selectedRoles.has(model.role)).map((model) => model.label).join(', ');
  const localValue = progress ? `Скачивается · ${progress.percent}%`
    : flow.local === 'skipped' ? 'Можно скачать потом'
      : installed.length ? installed.map((model) => model.label).join(', ')
        : selectedLabels || 'Не выбрана';
  const tiles = [
    ['theme', 'Вид', theme],
    ['mode', 'Режим', MODE_LABELS[flow.work] || 'Не выбран'],
    ...(flow.work !== 'max' ? [['local', 'Модель', localValue]] : []),
    ...(flow.work !== 'local' ? [['max', 'MAX', flow.connectedProvider ? flow.connectedProvider.name : 'Не подключён']] : []),
  ];
  const signature = JSON.stringify(tiles);
  if (elements.summary.dataset.signature !== signature) {
    elements.summary.dataset.signature = signature;
    elements.summary.innerHTML = tiles.map(([kind, label, value]) => `
      <div class="setup-summary-tile" data-kind="${kind}"${kind === 'local' && progress ? ` style="--progress:${progress.percent / 100}"` : ''}>
        <small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong>${kind === 'local' && progress ? '<span class="setup-bar"><i></i></span>' : ''}
      </div>`).join('');
  }
  const showFallback = flow.work === 'hybrid' || (flow.work !== 'max' && flow.connectedProvider);
  elements.fallback.hidden = !showFallback;
  elements.fallbackInput.checked = flow.fallback;
  const lead = $('[data-setup-done-lead]', elements.stage);
  lead.textContent = progress && flow.work === 'local'
    ? 'Модель скачивается — это займёт несколько минут. Можно пока осмотреться.'
    : progress ? 'Модель докачается в фоне, а MAX уже готов отвечать.'
      : flow.work === 'max' && !flow.connectedProvider ? 'MAX можно подключить в любой момент: Настройки → MAX.'
        : 'Оскар готов. Всё это меняется потом в настройках.';
}

async function finish() {
  if (flow.finishing) return;
  flow.finishing = true;
  elements.finish.disabled = true;
  try {
    await saveModelPreference({ work: flow.work || 'local', maxLocalFallback: flow.fallback }).catch(() => undefined);
    const components = readComponents();
    const required = components?.onboarding?.required === true;
    if (required && components.activeInstall) {
      writeBackgroundInstall();
    } else if (required && flow.mode === 'first') {
      await skipModelOnboarding().catch(() => undefined);
    }
    if (flow.connectedProvider && flow.work !== 'local') {
      window.dispatchEvent(new CustomEvent('monarch:max-connected', { detail: { providerId: flow.connectedProvider.id, enable: true } }));
    } else if (flow.work === 'local') {
      // Working on the computer: the chat starts on the local model.
      window.dispatchEvent(new CustomEvent('monarch-local-model-selected'));
    }
    updateState(await fetchState().catch(() => state.data));
    await closeFlow();
  } finally {
    flow.finishing = false;
    elements.finish.disabled = false;
  }
}

/* ---------- background download pill ---------- */

function renderPill(active) {
  if (!elements.pill) return;
  const visible = Boolean(active) && !flow.open;
  const progress = visible ? installProgress([...readModels(), ...readExtras()], active) : null;
  if (!visible || !progress) {
    if (!elements.pill.hidden) revealPill(false);
    return;
  }
  elements.pill.style.setProperty('--progress', String(progress.percent));
  $('[data-setup-pill-title]', elements.pill).textContent = `Скачиваю ${progress.label}`;
  $('[data-setup-pill-detail]', elements.pill).textContent = `${progress.percent}% · ${formatBytes(progress.downloaded)} из ${formatBytes(progress.expected)}`;
  elements.pill.setAttribute('aria-label', `Скачивается модель ${progress.label}: ${progress.percent}%. Открыть модели`);
  if (elements.pill.hidden) revealPill(true);
}

function revealPill(visible) {
  const pill = elements.pill;
  if (reducedUiMotion.matches) { pill.hidden = !visible; return; }
  pill.getAnimations().forEach((animation) => animation.cancel());
  if (visible) {
    pill.hidden = false;
    pill.animate([{ opacity: 0, transform: 'translateY(14px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  } else {
    pill.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(.97)' }], { duration: 240, easing: 'cubic-bezier(.4, 0, 1, 1)' })
      .finished.then(() => { pill.hidden = true; }, () => undefined);
  }
}

/* ---------- helpers ---------- */

function readBackgroundInstall() {
  try { return localStorage.getItem(BACKGROUND_KEY) === '1'; } catch { return false; }
}
function writeBackgroundInstall() {
  try { localStorage.setItem(BACKGROUND_KEY, '1'); } catch { /* optional convenience */ }
}
function clearBackgroundInstall() {
  try { localStorage.removeItem(BACKGROUND_KEY); } catch { /* optional convenience */ }
}

function readComponents() {
  return state.data?.components?.schemaVersion === 2 ? state.data.components : null;
}

function readModels() {
  return Array.isArray(readComponents()?.models) ? readComponents().models : [];
}

/** Coder, speech recognition and memory search downloads started from Settings. */
function readExtras() {
  return Array.isArray(readComponents()?.extras) ? readComponents().extras : [];
}

export function formatModelDownloadSize(value) {
  return formatBytes(value);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / (1024 ** 2)))} МБ`;
  return `${formatNumber(bytes / (1024 ** 3))} ГБ`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
}
