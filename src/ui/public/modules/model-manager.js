import { state, updateState } from './state.js';
import { ensureRequiredComponents, fetchState, installModels } from './api.js';
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
        const isPluginSurface = ['plugins', 'memory', 'models', 'diagnostics'].includes(manifest.id);
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

  // B. Large tactile list table inside dedicated Models View Page
  const pageList = document.querySelector('#models-page-list');
  if (pageList) {
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
    pageList.innerHTML = `
      <div class="models-page-shell">
        <div class="models-summary-strip" aria-label="Сводка моделей">
          <span><strong>${models.length}</strong> всего</span>
          <span><strong>${readyCount}</strong> готовы</span>
          <span><strong>${experimentalCount}</strong> Pro</span>
          ${provisionedModels.some((model) => !model.complete) ? '<button type="button" class="claude-secondary-btn" data-model-install="gemma4-fast,gemma4-balanced,qwen3.8-27b-pro">Скачать все</button>' : ''}
        </div>
        <div class="models-card-grid">
          ${models.map((model) => {
            const runtime = runtimes.find((entry) => entry.role === model.role);
            const status = runtime?.runnerStatus || model.status;
            const displayStatus = formatRuntimeStatus(status);
            const asset = model.primaryAsset?.name || model.directoryName;
            const detail = formatModelDetail(runtime?.detail || asset || 'локально');
            const roleLabel = modelRoleLabel(model.role);
            const roleDescription = modelRoleDescription(model.role);
            const provisioned = provisionedModels.find((entry) => entry.role === model.role) || null;
            const managed = provisioned?.components?.[0]
              || (model.role === requiredComponent?.role ? requiredComponent : null);
            const managedStatus = provisioned
              ? renderProvisionedModel(provisioned)
              : managed && managed.phase !== 'ready'
                ? renderManagedComponent(managed)
                : '';
            const canInstall = provisioned && (!provisioned.installed || !provisioned.complete);
            return `
              <article class="model-record-card" data-status="${escapeHtml(status)}">
                <header>
                  <div>
                    <span class="model-role-pill">${escapeHtml(roleLabel)}</span>
                    <h3>${escapeHtml(model.label)}</h3>
                    <p class="model-role-description">${escapeHtml(roleDescription)}</p>
                  </div>
                  <span class="status-text ${escapeHtml(status)}">${escapeHtml(displayStatus)}</span>
                </header>
                ${managedStatus}
                ${canInstall ? `<button type="button" class="claude-primary-btn model-install-action" data-model-install="${escapeHtml(model.role)}">${provisioned.phase === 'failed' ? 'Повторить' : provisioned.installed ? 'Докачать' : 'Скачать'}</button>` : ''}
                <details class="model-record-details">
                  <summary>Технические детали</summary>
                  <div class="model-record-meta">
                    <span>
                      <small>Runtime</small>
                      <strong>${escapeHtml(model.provider || 'llama.cpp')}</strong>
                    </span>
                    <span>
                      <small>Размер</small>
                      <strong>${escapeHtml(model.totalSize || 'Н/Д')}</strong>
                    </span>
                    <span>
                      <small>Файл</small>
                      <strong>${escapeHtml(asset || 'локально')}</strong>
                    </span>
                  </div>
                  <p class="model-record-path">${escapeHtml(detail)}</p>
                </details>
              </article>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }
}

function renderProvisionedModel(model) {
  if (model.complete && model.installed) return '';
  const percent = Math.max(0, Math.min(100, Math.round(Number(model.progress || 0) * 100)));
  const active = ['checking', 'downloading', 'verifying'].includes(model.phase);
  if (!active && model.phase !== 'failed') {
    return model.warning ? `<p class="model-install-note">${escapeHtml(model.warning)}</p>` : '';
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
      <div><strong>${failed ? 'Нужен повтор установки' : 'Monarch устанавливает модель'}</strong><span>${percent}%</span></div>
      <progress max="100" value="${percent}">${percent}%</progress>
      <p>${escapeHtml(component.error || `${formatManagedBytes(component.downloadedBytes)} из ${formatManagedBytes(component.expectedBytes)}`)}</p>
      ${failed ? '<button type="button" class="claude-primary-btn" data-component-ensure>Повторить</button>' : ''}
    </div>
  `;
}

function formatManagedBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  return `${(bytes / (1024 ** 3)).toFixed(2)} ГБ`;
}

function formatModelDetail(detail) {
  switch (detail) {
  case 'Model is present and ready.':
    return 'Готова локально';
  case 'Model is ready (experimental).':
    return 'Готова, экспериментальный профиль';
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
    'qwen3.8-27b-pro': 'Полный адаптивный Agent для сложной разработки, анализа и мультимодальных задач. Vision пока beta.',
    micro: 'Минимальная задержка для простых локальных реплик.',
    lite: 'Лёгкий профиль для голосового режима и коротких ответов.',
  };
  return descriptions[role] || 'Локальный профиль Monarch с собственным runtime-маршрутом.';
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
