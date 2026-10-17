import { state, updateState } from './state.js';
import {
  cancelModelInstall,
  ensureRequiredComponents,
  fetchState,
  installModels,
  removeInstalledModel,
} from './api.js';
import { confirmAction } from './ui-dialogs.js';
import {
  formatManagedBytes,
  missingOptionalComponents,
  renderOptionalComponentNote,
} from './model-components.js';
import {
  escapeHtml,
  initials,
  formatRuntimeStatus,
  formatTime,
} from './utils.js';

const elements = {
  modules: document.querySelector('#context-modules'),
  models: document.querySelector('#models'),
  pipeline: document.querySelector('#pipeline'),
  recentEvent: document.querySelector('#recent-event'),
};

let initialized = false;
const OSCAR_MODEL_ROLES = new Set(['gemma4-fast', 'gemma4-balanced', 'qwen3.8-27b-pro']);

export function initModelManager() {
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-component-ensure]');
    if (button) {
      button.disabled = true;
      void ensureRequiredComponents()
        .then(() => fetchState())
        .then(updateState)
        .catch(() => { button.disabled = false; });
      return;
    }
    const cancelButton = event.target.closest('[data-model-cancel]');
    if (cancelButton) {
      cancelButton.disabled = true;
      void cancelModelInstall(cancelButton.dataset.modelCancel)
        .then(() => fetchState())
        .then(updateState)
        .catch(() => { cancelButton.disabled = false; });
      return;
    }
    const removeButton = event.target.closest('[data-model-remove]');
    if (removeButton) {
      void removeModelFiles(removeButton);
      return;
    }
    const installButton = event.target.closest('[data-model-install]');
    if (!installButton) return;
    const roles = String(installButton.dataset.modelInstall || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (roles.length === 0) return;
    installButton.disabled = true;
    void installModels(roles, 'settings')
      .then(() => fetchState())
      .then(updateState)
      .catch(() => { installButton.disabled = false; });
  });
}

async function removeModelFiles(button) {
  const role = button.dataset.modelRemove;
  const label = button.dataset.modelLabel || 'модель';
  if (!role) return;
  const ok = await confirmAction(`Удалить «${label}» с компьютера? Чтобы снова пользоваться ею, её придётся скачать заново.`);
  if (!ok) return;
  button.disabled = true;
  const card = button.closest('.model-record-card');
  try {
    updateState(await removeInstalledModel(role).then(() => fetchState()));
  } catch (error) {
    button.disabled = false;
    const note = card?.querySelector('[data-slot="state"]');
    if (note) {
      patchedMarkup.delete(note);
      note.innerHTML = `<p class="model-install-note">${escapeHtml(error?.message || 'Не получилось удалить. Попробуй ещё раз.')}</p>`;
    }
  }
}

const ACTIVE_PHASES = ['checking', 'downloading', 'verifying'];

/** Buttons beside a model: download / continue, stop while it downloads, delete what is on disk. */
function renderModelActions({ role, label, provisioned, queued, missingOptional }) {
  if (!provisioned) return '';
  const active = ACTIVE_PHASES.includes(provisioned.phase);
  const onDisk = provisioned.installed || Number(provisioned.downloadedBytes) > 0;
  const buttons = [];
  if (active || queued) {
    buttons.push(`<button type="button" class="claude-secondary-btn model-install-action" data-model-cancel="${escapeHtml(role)}">${active ? 'Остановить' : 'Убрать из очереди'}</button>`);
  } else if (!provisioned.installed || !provisioned.complete) {
    const resumable = !provisioned.installed && Number(provisioned.downloadedBytes) > 0;
    const text = provisioned.phase === 'failed'
      ? 'Повторить'
      : provisioned.installed
        ? (missingOptional.length ? 'Скачать дополнения' : 'Докачать')
        : resumable ? 'Продолжить' : 'Скачать';
    buttons.push(`<button type="button" class="claude-primary-btn model-install-action" data-model-install="${escapeHtml(role)}">${text}</button>`);
  }
  if (!active && !queued && onDisk) {
    buttons.push(`<button type="button" class="model-remove-action" data-model-remove="${escapeHtml(role)}" data-model-label="${escapeHtml(label)}" aria-label="Удалить ${escapeHtml(label)}">Удалить</button>`);
  }
  return buttons.join('');
}

function queuedRoles() {
  const active = state.data?.components?.activeInstall;
  return new Set(Array.isArray(active?.roles) ? active.roles : []);
}

export function renderModelManager() {
  if (!state.data) {
    return;
  }

  renderModules();
  renderModels();
  renderPipeline();
  renderRecentEvent();
}

function renderModules() {
  if (!elements.modules) return;
  const modules = state.data.runtime.snapshot.modules || [];
  elements.modules.innerHTML = `
    <div class="module-list">
      ${modules.map((record) => {
        const manifest = record.manifest;
        const isPluginSurface = ['plugins', 'models', 'diagnostics'].includes(manifest.id);
        return `
          <article class="module-row ${isPluginSurface ? 'system-surface' : ''}">
            <div class="module-icon">${escapeHtml(initials(manifest.name))}</div>
            <div class="module-copy">
              <div class="row-main">
                <strong>${escapeHtml(manifest.name)}</strong>
                <span class="status-text ${escapeHtml(record.status)}">${escapeHtml(record.status)}</span>
              </div>
              <p>${escapeHtml(manifest.id)} · ${manifest.capabilities.length} возможностей · ${escapeHtml(manifest.kind)}</p>
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function renderModels() {
  const models = (state.data.models.models || []).filter((model) => OSCAR_MODEL_ROLES.has(model.role));
  const runtimes = state.data.modelRuntime.entries || [];
  const requiredComponent = state.data.components?.requiredModel || null;
  const provisionedModels = state.data.components?.schemaVersion === 2
    ? state.data.components.models || []
    : [];
  const ramTotalGb = Number(state.data.components?.onboarding?.hardware?.ramTotalGb);

  // A. Compact list inside right telemetry inspector drawer
  if (elements.models) {
    elements.models.innerHTML = `
      <div class="row-list">
        ${models.map((model) => {
          const runtime = runtimes.find((entry) => entry.role === model.role);
          const status = runtime?.runnerStatus || model.status;
          const displayStatus = formatRuntimeStatus(status);
          const asset = model.primaryAsset?.name || model.directoryName;
          const detail = runtime?.detail || `${asset} · ${model.totalSize}`;
          return `
            <div class="compact-row">
              <div class="row-main">
                <strong>${escapeHtml(model.label)}</strong>
                <span class="status-text ${escapeHtml(status)}">${escapeHtml(displayStatus)}</span>
              </div>
              <p>${escapeHtml(detail)}</p>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // B. Large tactile list table inside dedicated Models View Page.
  // Download progress arrives many times a second, so the page is patched in
  // place: unchanged parts keep their DOM (the memory bars do not replay their
  // grow animation, an open "О модели" stays open) and only what moved updates.
  const pageList = document.querySelector('#models-page-list');
  if (pageList) {
    const queue = queuedRoles();
    const readyCount = models.filter((model) => {
      const runtime = runtimes.find((entry) => entry.role === model.role);
      const status = runtime?.runnerStatus || model.status;
      return ['present', 'ready', 'active', 'experimental'].includes(status);
    }).length;
    const experimentalCount = models.filter((model) => {
      const runtime = runtimes.find((entry) => entry.role === model.role);
      const status = runtime?.runnerStatus || model.status;
      return status === 'experimental' || model.role === 'qwen3.8-27b-pro';
    }).length;
    const summary = `
          <span><strong>${models.length}</strong> всего</span>
          <span><strong>${readyCount}</strong> готовы</span>
          <span><strong>${experimentalCount}</strong> Pro</span>
          ${provisionedModels.some((model) => !model.installed && !queue.has(model.role)) ? '<button type="button" class="claude-secondary-btn" data-model-install="gemma4-fast,gemma4-balanced,qwen3.8-27b-pro">Скачать все</button>' : ''}`;
    const cards = models.map((model) => {
      const runtime = runtimes.find((entry) => entry.role === model.role);
      const status = runtime?.runnerStatus || model.status;
      const asset = model.primaryAsset?.name || model.directoryName;
      const detail = formatModelDetail(runtime?.detail || asset || 'локально');
      const provisioned = provisionedModels.find((entry) => entry.role === model.role) || null;
      const managed = provisioned?.components?.[0]
        || (model.role === requiredComponent?.role ? requiredComponent : null);
      const queued = queue.has(model.role) && !ACTIVE_PHASES.includes(provisioned?.phase);
      const managedStatus = provisioned
        ? renderProvisionedModel(provisioned, queued)
        : managed && managed.phase !== 'ready'
          ? renderManagedComponent(managed)
          : '';
      const missingOptional = missingOptionalComponents(provisioned);
      const notDownloaded = Boolean(provisioned && !provisioned.installed);
      return {
        key: model.role,
        status,
        head: `
                    <span class="model-role-pill">${escapeHtml(modelRoleLabel(model.role))}</span>
                    <h3>${escapeHtml(model.label)}</h3>
                    <p class="model-role-description">${escapeHtml(modelRoleDescription(model.role))}</p>`,
        side: `
                    <span class="status-text ${escapeHtml(notDownloaded ? 'missing' : status)}">${escapeHtml(queued ? 'в очереди' : notDownloaded ? 'не скачана' : formatRuntimeStatus(status))}</span>
                    ${renderModelActions({ role: model.role, label: model.label, provisioned, queued, missingOptional })}`,
        ram: renderRamFit(provisioned?.recommendedRamGb, ramTotalGb),
        state: managedStatus,
        optional: renderOptionalComponentNote(missingOptional),
        meta: `
                    <span>
                      <small>Размер</small>
                      <strong>${escapeHtml(model.totalSize || 'Н/Д')}</strong>
                    </span>
                    <span>
                      <small>Файл</small>
                      <strong>${escapeHtml(asset || 'локально')}</strong>
                    </span>`,
        path: escapeHtml(detail),
      };
    });
    const extras = state.data.components?.extras || [];
    if (!pageList.querySelector(':scope > .models-page-shell')) {
      pageList.innerHTML = `
      <div class="models-page-shell">
        <div class="models-summary-strip" aria-label="Сводка моделей" data-models-summary></div>
        <div class="models-card-grid" data-models-grid></div>
        <div class="models-extras-slot" data-models-extras></div>
      </div>
    `;
    }
    patchHtml(pageList.querySelector('[data-models-summary]'), summary);
    patchModelCards(pageList.querySelector('[data-models-grid]'), cards);
    patchExtraComponents(pageList.querySelector('[data-models-extras]'), extras, ramTotalGb, queue);
  }
}

/** Last markup written into each patched element. Kept per element, so a page
 * that is mounted anew starts from a clean slate. */
const patchedMarkup = new WeakMap();

export function patchHtml(element, html) {
  if (!element) return false;
  if (patchedMarkup.get(element) === html) return false;
  patchedMarkup.set(element, html);
  element.innerHTML = html;
  return true;
}

function sameKeys(container, selector, attribute, keys) {
  const present = [...container.querySelectorAll(`:scope > ${selector}`)].map((node) => node.getAttribute(attribute));
  return present.length === keys.length && present.every((key, index) => key === keys[index]);
}

function patchModelCards(grid, cards) {
  if (!grid) return;
  if (!sameKeys(grid, '.model-record-card', 'data-model-card', cards.map((card) => card.key))) {
    grid.innerHTML = cards.map((card) => `
              <article class="model-record-card" data-model-card="${escapeHtml(card.key)}">
                <header>
                  <div data-slot="head"></div>
                  <div class="model-record-side" data-slot="side"></div>
                </header>
                <div class="model-card-slot" data-slot="ram"></div>
                <div class="model-card-slot" data-slot="state"></div>
                <div class="model-card-slot" data-slot="optional"></div>
                <details class="model-record-details">
                  <summary>О модели</summary>
                  <div class="model-record-meta" data-slot="meta"></div>
                  <p class="model-record-path" data-slot="path"></p>
                </details>
              </article>
            `).join('');
  }
  for (const card of cards) {
    const article = [...grid.children].find((node) => node.dataset.modelCard === card.key);
    if (!article) continue;
    if (article.dataset.status !== String(card.status)) article.dataset.status = String(card.status);
    for (const slot of ['head', 'side', 'ram', 'state', 'optional', 'meta', 'path']) {
      patchHtml(article.querySelector(`[data-slot="${slot}"]`), card[slot]);
    }
  }
}

function patchExtraComponents(container, extras, ramTotalGb, queue) {
  if (!container) return;
  const list = Array.isArray(extras) ? extras : [];
  if (list.length === 0) {
    patchHtml(container, '');
    return;
  }
  let grid = container.querySelector('[data-extras-grid]');
  if (!grid) {
    patchedMarkup.delete(container);
    container.innerHTML = `
    <section class="models-extras" aria-labelledby="models-extras-title">
      <div class="models-extras-heading">
        <h3 id="models-extras-title">Для отдельных функций</h3>
        <p>Скачай, когда понадобится. Всё работает на твоём компьютере.</p>
      </div>
      <div class="models-card-grid" data-extras-grid></div>
    </section>`;
    grid = container.querySelector('[data-extras-grid]');
  }
  if (!sameKeys(grid, '.model-extra-card', 'data-extra', list.map((extra) => String(extra.role)))) {
    grid.innerHTML = list.map((extra) => `
      <article class="model-record-card model-extra-card" data-extra="${escapeHtml(extra.role)}">
        <header>
          <div data-slot="head"></div>
          <div class="model-card-slot" data-slot="side"></div>
        </header>
        <div class="model-card-slot" data-slot="ram"></div>
        <div class="model-card-slot" data-slot="state"></div>
      </article>`).join('');
  }
  for (const extra of list) {
    const article = [...grid.children].find((node) => node.dataset.extra === String(extra.role));
    if (!article) continue;
    const parts = extraCardParts(extra, ramTotalGb, queue);
    if (article.dataset.status !== parts.status) article.dataset.status = parts.status;
    for (const slot of ['head', 'side', 'ram', 'state']) {
      patchHtml(article.querySelector(`[data-slot="${slot}"]`), parts[slot]);
    }
  }
}

/** Downloads for single features (Coder, speech recognition, memory search):
 * never part of first setup, each fetched only when the person asks for it. */
export function renderExtraComponents(extras, ramTotalGb) {
  if (!Array.isArray(extras) || extras.length === 0) return '';
  return `
    <section class="models-extras" aria-labelledby="models-extras-title">
      <div class="models-extras-heading">
        <h3 id="models-extras-title">Для отдельных функций</h3>
        <p>Скачай, когда понадобится. Всё работает на твоём компьютере.</p>
      </div>
      <div class="models-card-grid">
        ${extras.map((extra) => renderExtraCard(extra, ramTotalGb)).join('')}
      </div>
    </section>
  `;
}

function extraCardParts(extra, ramTotalGb, queue = new Set()) {
  const active = ACTIVE_PHASES.includes(extra.phase);
  const queued = !active && queue.has(extra.role);
  const failed = extra.phase === 'failed';
  const ready = extra.installed === true;
  const size = formatComponentSize(extra.expectedBytes);
  const onDisk = ready || Number(extra.downloadedBytes) > 0;
  const resumable = !ready && Number(extra.downloadedBytes) > 0;

  const failure = (extra.components || []).find((component) => component.phase === 'failed');
  const percent = Math.max(0, Math.min(100, Math.round(Number(extra.progress || 0) * 100)));
  const removeButton = !active && !queued && onDisk
    ? `<button type="button" class="model-remove-action" data-model-remove="${escapeHtml(extra.role)}" data-model-label="${escapeHtml(extra.label)}" aria-label="Удалить ${escapeHtml(extra.label)}">Удалить</button>`
    : '';
  return {
    status: ready ? 'ready' : active || queued ? 'loading' : 'missing',
    head: `
          <span class="model-role-pill">${escapeHtml(extra.beta ? `${extra.summary} · бета` : extra.summary)}</span>
          <h3>${escapeHtml(extra.label)}</h3>
          <p class="model-role-description">${escapeHtml(extra.description || '')}</p>`,
    side: ready
      ? `<div class="model-record-side"><span class="status-text ready">готово</span>${removeButton}</div>`
      : queued ? '<div class="model-record-side"><span class="status-text">в очереди</span></div>' : '',
    ram: Number(extra.recommendedRamGb) > 0 ? renderRamFit(extra.recommendedRamGb, ramTotalGb) : '',
    state: `${active ? `
        <div class="model-component-state" data-phase="${escapeHtml(extra.phase)}">
          <div><strong>${extra.phase === 'verifying' ? 'Проверяем и распаковываем' : 'Загружаем'}</strong><span>${percent}%</span></div>
          <progress max="100" value="${percent}">${percent}%</progress>
          <p>${escapeHtml(`${formatComponentSize(extra.downloadedBytes)} из ${size}`)}</p>
        </div>` : ''}
      ${failed && failure?.error ? `<p class="model-install-note">${escapeHtml(failure.error)}</p>` : ''}
      ${active || queued ? `<div class="model-extra-actions"><button type="button" class="claude-secondary-btn model-install-action" data-model-cancel="${escapeHtml(extra.role)}">${active ? 'Остановить' : 'Убрать из очереди'}</button></div>` : ''}
      ${!ready && !active && !queued ? `<div class="model-extra-actions"><button type="button" class="claude-primary-btn model-install-action" data-model-install="${escapeHtml(extra.role)}">${failed ? 'Повторить' : resumable ? 'Продолжить' : `Скачать · ${escapeHtml(size)}`}</button>${removeButton}</div>` : ''}`,
  };
}

function renderExtraCard(extra, ramTotalGb) {
  const parts = extraCardParts(extra, ramTotalGb);
  return `
    <article class="model-record-card model-extra-card" data-status="${parts.status}" data-extra="${escapeHtml(extra.role)}">
      <header>
        <div>${parts.head}</div>
        ${parts.side}
      </header>
      ${parts.ram}
      ${parts.state}
    </article>
  `;
}

/** Megabytes under a gigabyte read better for the small helper packs. */
export function formatComponentSize(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / (1024 ** 2)))} МБ`;
  return `${(bytes / (1024 ** 3)).toFixed(1).replace('.', ',')} ГБ`;
}

/** How much of this computer's memory the model needs. The bar is the share
 * of your RAM it takes; past 100% the missing part is shown, not hidden. */
export function renderRamFit(needGb, haveGb) {
  const need = Number(needGb);
  const have = Number(haveGb);
  if (!(need > 0) || !(have > 0)) return '';
  const fits = have >= need;
  const share = Math.min(1, need / have);
  const missing = fits ? 0 : Math.ceil(need - have);
  const text = fits
    ? `Нужно около ${formatNumber(need)} ГБ памяти, у тебя ${formatNumber(have)} ГБ — хватает`
    : `Нужно около ${formatNumber(need)} ГБ памяти, у тебя ${formatNumber(have)} ГБ — не хватает ${missing} ГБ, будет медленнее`;
  return `
    <div class="model-ram-fit" data-fit="${fits ? 'ok' : 'short'}">
      <span class="model-ram-bar" aria-hidden="true"><i style="--share:${share.toFixed(3)}"></i></span>
      <small>${escapeHtml(text)}</small>
    </div>`;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace('.', ',');
}

function renderProvisionedModel(model, queued = false) {
  if (model.complete && model.installed) return '';
  const percent = Math.max(0, Math.min(100, Math.round(Number(model.progress || 0) * 100)));
  const active = ACTIVE_PHASES.includes(model.phase);
  if (!active && model.phase !== 'failed') {
    const stopped = !queued && !model.installed && Number(model.downloadedBytes) > 0
      ? `<p class="model-install-note">Загрузка на паузе: скачано ${escapeHtml(formatManagedBytes(model.downloadedBytes))} из ${escapeHtml(formatManagedBytes(model.expectedBytes))}.</p>`
      : '';
    return stopped || (model.warning ? `<p class="model-install-note">${escapeHtml(model.warning)}</p>` : '');
  }
  return `
    <div class="model-component-state" data-phase="${escapeHtml(model.phase)}">
      <div><strong>${model.phase === 'failed' ? 'Загрузка остановилась' : 'Загружаем'}</strong><span>${percent}%</span></div>
      <progress max="100" value="${percent}">${percent}%</progress>
      <p>${escapeHtml(model.phase === 'failed' ? 'Попробуй ещё раз.' : `${formatManagedBytes(model.downloadedBytes)} из ${formatManagedBytes(model.expectedBytes)}`)}</p>
    </div>
  `;
}

function renderManagedComponent(component) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(component.progress || 0) * 100)));
  const failed = component.phase === 'failed';
  return `
    <div class="model-component-state" data-phase="${escapeHtml(component.phase)}">
      <div><strong>${failed ? 'Установка прервалась — попробуй ещё раз' : 'Monarch устанавливает модель'}</strong><span>${percent}%</span></div>
      <progress max="100" value="${percent}">${percent}%</progress>
      <p>${escapeHtml(component.error || `${formatManagedBytes(component.downloadedBytes)} из ${formatManagedBytes(component.expectedBytes)}`)}</p>
      ${failed ? '<button type="button" class="claude-primary-btn" data-component-ensure>Повторить</button>' : ''}
    </div>
  `;
}

function formatModelDetail(detail) {
  switch (detail) {
  case 'Model is present and ready.':
    return 'Готова к работе';
  case 'Model is ready (experimental).':
    return 'Готова · пока тестовая';
  default:
    return detail;
  }
}

function modelRoleLabel(role) {
  const labels = {
    'gemma4-fast': 'Fast · каждый день',
    'gemma4-balanced': 'Medium · баланс',
    'qwen3.8-27b-pro': 'Pro · Qwen3.8 27B',
    micro: 'Micro · мгновенно',
    lite: 'Lite · голос',
  };
  return labels[role] || String(role || 'Локальная модель');
}

function modelRoleDescription(role) {
  const descriptions = {
    'gemma4-fast': 'Короткие ответы, повседневные задачи и быстрые уточнения.',
    'gemma4-balanced': 'Основной профиль для разработки, анализа и длинных диалогов.',
    'qwen3.8-27b-pro': 'Для сложных задач, разработки и анализа. Работа с изображениями — пробная.',
    micro: 'Минимальная задержка для простых локальных реплик.',
    lite: 'Лёгкий профиль для голосового режима и коротких ответов.',
  };
  return descriptions[role] || 'Модель для работы с Оскаром.';
}

function renderPipeline() {
  if (!elements.pipeline) return;
  const steps = state.data.routerPipeline || [];
  const importantSteps = steps.filter((step) => [
    'input-normalizer',
    'fast-classifier',
    'llm-router',
    'decision-validator',
    'risk-permission',
    'resource-scheduler',
    'executor',
    'response-composer',
  ].includes(step.id));

  elements.pipeline.innerHTML = `
    <div class="row-list">
      ${importantSteps.map((step) => `
        <div class="compact-row">
          <div class="row-main">
            <strong>${escapeHtml(step.label)}</strong>
            <span class="status-text ${escapeHtml(step.status)}">${escapeHtml(step.status)}</span>
          </div>
          <p>${escapeHtml(step.detail)}</p>
        </div>
      `).join('')}
    </div>
  `;
}

function renderRecentEvent() {
  if (!elements.recentEvent) return;
  const events = state.data.runtime.snapshot.events || [];
  const event = events.at(-1);
  if (!event) {
    elements.recentEvent.innerHTML = '<div class="empty-state">Событий пока нет.</div>';
    return;
  }

  elements.recentEvent.innerHTML = `
    <div class="event-card">
      <div class="row-main">
        <strong>${escapeHtml(event.type)}</strong>
        <span>${formatTime(event.createdAt)}</span>
      </div>
      <p>${escapeHtml(event.source)}</p>
    </div>
  `;
}
