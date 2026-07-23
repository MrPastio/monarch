const STATE_COPY = Object.freeze({
  idle: ['Готово к проверке', 'Проверить обновления'],
  checking: ['Проверяю канал', 'Проверка…'],
  'verifying-manifest': ['Проверяю подпись', 'Проверка…'],
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
  const [statusCopy, actionCopy] = STATE_COPY[state] || STATE_COPY.idle;
  renderGlobalNotice(next, state, statusCopy, actionCopy);
  setText('#monarch-update-status', statusCopy);
  const status = document.querySelector('#monarch-update-status');
  if (status) status.dataset.state = state;
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
}

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
    return 'Режим разработки: release-updater отключён, поэтому установщик не скачивается и не предлагается.';
  }
  if (value.error?.code === 'installed-version-mismatch') {
    return 'Launcher и запущенные файлы указывают на разные версии. Запусти Monarch через Monarch.exe или repair installer.';
  }
  if (value.error?.code === 'installed-layout-missing') {
    return 'Установка не содержит доверенного launcher-layout. Обновление остановлено до repair installer.';
  }
  if (value.error?.code === 'launcher-version-unsupported') {
    return 'Нужен ручной bootstrap/repair installer: текущий launcher не поддерживает этот layout.';
  }
  if (value.error?.message) return value.error.message;
  if (value.reason === 'current-version-revoked') {
    return 'Эта версия отозвана. Monarch продолжает работать; установи следующий исправленный релиз.';
  }
  if (value.state === 'update-available') {
    return 'Один клик скачает проверенный пакет обновления, дождётся завершения задач и перезапустит Monarch.';
  }
  if (value.state === 'waiting-for-tasks') {
    return 'Voice, Coder и активные задачи завершаются перед point of no return.';
  }
  return 'UpdateService не отправляет идентификаторы, историю, запросы или hardware inventory.';
}

function renderBridgeError(error) {
  setText('#monarch-update-status', 'Проверка недоступна');
  setText('#monarch-update-message', error instanceof Error ? error.message : String(error));
}

function versionLabel(value) {
  return value ? `v${String(value).replace(/^v/i, '')}` : '—';
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
