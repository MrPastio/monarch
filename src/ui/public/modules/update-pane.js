import { maybeShowWhatsNew, openWhatsNew } from './whats-new.js';
const STATE_COPY = Object.freeze({
  idle: ['Готово к проверке', 'Проверить обновления'],
  checking: ['Ищу обновление', 'Проверка…'],
  'verifying-manifest': ['Проверяю подлинность обновления', 'Проверка…'],
  'up-to-date': ['Последняя версия', 'Проверить снова'],
  'update-available': ['Доступно обновление', 'Обновить и перезапустить'],
  downloading: ['Скачиваю', 'Поставить на паузу'],
  paused: ['Загрузка на паузе', 'Продолжить'],
  'verifying-installer': ['Проверяю установщик', 'Проверка…'],
  'ready-to-install': ['Готово к установке', 'Установить и перезапустить'],
  'waiting-for-tasks': ['Жду завершения задач', 'Подготовка…'],
  installing: ['Устанавливаю', 'Установка…'],
  'restart-pending': ['Перезапуск', 'Перезапуск…'],
  completed: ['Обновление готово', 'Проверить снова'],
  cancelled: ['Обновление отменено', 'Продолжить загрузку'],
  failed: ['Не удалось обновить', 'Повторить проверку'],
});

const BUSY_STATES = new Set([
  'checking',
  'verifying-manifest',
  'verifying-installer',
  'waiting-for-tasks',
  'installing',
  'restart-pending',
]);
const NOTICE_HIDDEN_STATES = new Set(['idle', 'checking', 'verifying-manifest', 'up-to-date', 'completed']);

let snapshot = null;
let unsubscribe = null;

export function initUpdatePane(documentRef = document, desktop = window.monarchDesktop) {
  const root = documentRef.querySelector('.monarch-update-panel');
  const notice = documentRef.querySelector('#monarch-update-notice');
  if (!root && !notice) return;
  if (!desktop?.updates) {
    if (root) root.hidden = true;
    if (notice) notice.hidden = true;
    return;
  }

  documentRef.querySelector('#monarch-update-primary')?.addEventListener('click', () => {
    void runPrimaryIntent(desktop.updates);
  });
  documentRef.querySelector('#monarch-update-cancel')?.addEventListener('click', () => {
    void desktop.updates.cancel().then(renderUpdateSnapshot);
  });
  documentRef.querySelector('#monarch-update-discard')?.addEventListener('click', () => {
    void desktop.updates.discard().then(renderUpdateSnapshot);
  });
  documentRef.querySelector('#monarch-whats-new')?.addEventListener('click', () => { void openWhatsNew(); });
  documentRef.querySelector('#monarch-update-notice-action')?.addEventListener('click', () => {
    void runPrimaryIntent(desktop.updates);
  });
  unsubscribe?.();
  unsubscribe = desktop.updates.onStateChanged?.(renderUpdateSnapshot) || null;
  void desktop.updates.getState()
    .then(renderUpdateSnapshot)
    .then(() => desktop.updates.check())
    .then(renderUpdateSnapshot)
    .catch((error) => renderBridgeError(error));
}

export function primaryIntentForState(state) {
  if (state === 'update-available' || state === 'ready-to-install') return 'install';
  if (state === 'downloading') return 'pause';
  if (state === 'paused' || state === 'cancelled') return 'resume';
  return 'check';
}

export function shouldShowUpdateNotice(value) {
  const state = String(value?.state || 'idle');
  return Boolean(
    value?.installation?.canInstall !== false
    && value?.release
    && !NOTICE_HIDDEN_STATES.has(state),
  );
}

async function runPrimaryIntent(updates) {
  const intent = primaryIntentForState(snapshot?.state);
  const result = await updates[intent]().catch((error) => {
    renderBridgeError(error);
    return null;
  });
  if (result) renderUpdateSnapshot(result);
}

function renderUpdateSnapshot(next) {
  if (!next || typeof next !== 'object') return;
  snapshot = next;
  const state = String(next.state || 'idle');
  const development = next.reason === 'development-workspace';
  const [statusCopy, actionCopy] = development ? ['Режим разработки', 'Проверить снова'] : STATE_COPY[state] || STATE_COPY.idle;
  renderGlobalNotice(next, state, statusCopy, actionCopy);
  setText('#monarch-update-status', statusCopy);
  const status = document.querySelector('#monarch-update-status');
  if (status) status.dataset.state = development ? 'development' : state;
  setText('#monarch-update-primary', actionCopy);
  setText('#monarch-current-version', versionLabel(next.currentVersion));
  setText('#monarch-available-version', next.release?.version ? versionLabel(next.release.version) : '—');
  setText('#monarch-update-size', next.release?.size ? formatBytes(next.release.size) : '—');

  const primary = document.querySelector('#monarch-update-primary');
  if (primary) primary.disabled = BUSY_STATES.has(state);
  toggle('#monarch-update-cancel', Boolean(next.canCancel));
  toggle('#monarch-update-discard', Boolean(next.canDiscard));

  const progressRoot = document.querySelector('#monarch-update-progress');
  const progress = Number(next.progress?.percent || 0);
  if (progressRoot) progressRoot.hidden = !next.progress;
  const progressBar = document.querySelector('#monarch-update-progress-bar');
  if (progressBar) progressBar.value = progress;
  setText('#monarch-update-progress-value', `${progress.toFixed(progress % 1 ? 1 : 0)}%`);
  setText(
    '#monarch-update-progress-label',
    next.progress
      ? `${formatBytes(next.progress.downloaded)} из ${formatBytes(next.progress.total)}`
      : 'Загрузка',
  );

  const notes = document.querySelector('#monarch-update-notes');
  if (notes) {
    notes.hidden = !next.release?.releaseNotesUrl;
    if (next.release?.releaseNotesUrl) notes.href = next.release.releaseNotesUrl;
  }
  setText('#monarch-update-message', updateMessage(next));
  // Only a real installation announces its update; source and demo runs never do.
  if (next.installation?.mode === 'installed' && !whatsNewChecked && next.currentVersion) {
    whatsNewChecked = true;
    void maybeShowWhatsNew(String(next.currentVersion));
  }
}
let whatsNewChecked = false;

function renderGlobalNotice(next, state, statusCopy, actionCopy) {
  const notice = document.querySelector('#monarch-update-notice');
  if (!notice) return;
  notice.hidden = !shouldShowUpdateNotice(next);
  notice.dataset.state = state;
  setText('#monarch-update-notice-title', statusCopy);
  setText('#monarch-update-notice-action', actionCopy);
  const action = document.querySelector('#monarch-update-notice-action');
  if (action) action.disabled = BUSY_STATES.has(state);

  const version = versionLabel(next.release?.version);
  const size = next.release?.size ? formatBytes(next.release.size) : '';
  const progress = Number(next.progress?.percent || 0);
  const detail = next.progress
    ? `${version} · ${progress.toFixed(progress % 1 ? 1 : 0)}%`
    : [version, size].filter((value) => value && value !== '—').join(' · ');
  setText('#monarch-update-notice-detail', detail);
}

function updateMessage(value) {
  if (value.reason === 'development-workspace') {
    return 'Monarch запущен из исходников. Обновления приходят вместе с кодом, установщик здесь не нужен.';
  }
  if (value.error?.code === 'installed-version-mismatch') {
    return 'Запущенные файлы и установка разных версий. Открой Monarch через Monarch.exe или переустанови его поверх.';
  }
  if (value.error?.code === 'installed-layout-missing') {
    return 'Установка неполная, поэтому обновление остановлено. Переустанови Monarch поверх, данные сохранятся.';
  }
  if (value.error?.code === 'launcher-version-unsupported') {
    return 'Эта версия запускалки устарела. Скачай установщик с сайта и установи поверх, данные сохранятся.';
  }
  if (value.error) return errorMessage(value.error.code);
  if (value.reason === 'current-version-revoked') {
    return 'Эта версия отозвана. Monarch продолжает работать; установи следующий исправленный релиз.';
  }
  if (value.state === 'update-available') {
    return 'Один клик скачает проверенный пакет обновления, дождётся завершения задач и перезапустит Monarch.';
  }
  if (value.state === 'waiting-for-tasks') {
    return 'Жду, пока закончатся голос, Coder и активные задачи. После этого обновление уже не прервётся.';
  }
  return 'При проверке не уходят история, запросы и сведения о компьютере.';
}

const ERROR_COPY = Object.freeze({
  'network-error': 'Нет связи с сервером обновлений. Проверь интернет и попробуй ещё раз — скачанное не пропадёт.',
  'request-timeout': 'Сервер обновлений отвечает слишком долго. Попробуй ещё раз чуть позже — скачанное не пропадёт.',
  'download-stalled': 'Загрузка остановилась. Попробуй ещё раз — она продолжится с того же места.',
  'download-http-error': 'Сервер не отдал установщик. Попробуй ещё раз чуть позже.',
  'no-valid-manifest': 'Не удалось получить проверенные сведения об обновлении. Попробуй ещё раз чуть позже.',
  'manifest-expired': 'Сведения об обновлении устарели. Скачай свежую версию с сайта Monarch.',
  'clock-invalid': 'На компьютере неверные дата или время, поэтому подпись обновления не проверить. Исправь время в Windows.',
  'insufficient-disk-space': 'Не хватает места на диске для обновления. Освободи место и попробуй ещё раз.',
  'installer-hash-mismatch': 'Скачанный файл не совпал с подписанным релизом и удалён. Попробуй ещё раз.',
  'installer-size-mismatch': 'Скачанный файл оказался неполным и удалён. Попробуй ещё раз.',
  'invalid-installer-format': 'Вместо установщика пришёл другой файл, он удалён. Попробуй ещё раз.',
  'invalid-installer-content-type': 'Вместо установщика пришла веб-страница. Проверь интернет и попробуй ещё раз.',
  'unsafe-redirect': 'Загрузку перенаправили на незнакомый адрес, она остановлена ради безопасности.',
  'updater-version-unsupported': 'Эта версия слишком старая для автообновления. Скачай установщик с сайта и установи поверх, данные сохранятся.',
  'manifest-replay': 'Пришли устаревшие сведения об обновлении, они отклонены. Попробуй позже.',
  'manifest-version-replay': 'Пришли устаревшие сведения об обновлении, они отклонены. Попробуй позже.',
  'manifest-sequence-conflict': 'Сведения об обновлении противоречат уже принятым, обновление остановлено ради безопасности.',
});

export function errorMessage(code) {
  return ERROR_COPY[code] || 'Обновление не удалось. Попробуй ещё раз; если повторится — скачай установщик с сайта Monarch.';
}

function renderBridgeError() {
  setText('#monarch-update-status', 'Проверка недоступна');
  setText('#monarch-update-message', errorMessage(null));
}

/** The 0.3 line ships as a Preview; the label says so next to the exact build. */
export function versionLabel(value) {
  if (!value) return '—';
  const version = String(value).replace(/^v/i, '');
  return /^0\.3(?:\.|$)/u.test(version) ? `v${version} · Preview` : `v${version}`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${(bytes / 1024).toFixed(0)} КБ`;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function toggle(selector, visible) {
  const element = document.querySelector(selector);
  if (element) element.hidden = !visible;
}
