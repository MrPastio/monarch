import { state } from './state.js';
import {
  escapeHtml,
  initials,
  formatRuntimeStatus,
  formatTime,
  previewItem
} from './utils.js';

const elements = {
  modules: document.querySelector('#context-modules'),
  models: document.querySelector('#models'),
  pipeline: document.querySelector('#pipeline'),
  recentEvent: document.querySelector('#recent-event'),
  workspaceSummary: document.querySelector('#workspace-summary'),
  workspaceModuleList: document.querySelector('#workspace-module-list'),
};

export function renderModelManager() {
  if (!state.data) {
    return;
  }

  renderModules();
  renderModels();
  renderPipeline();
  renderRecentEvent();
  renderWorkspace();
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
  const models = state.data.models.models || [];
  const runtimes = state.data.modelRuntime.entries || [];

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
      return status === 'experimental' || model.role === 'gemma4-deepthinking' || model.role === 'gemma4-31b';
    }).length;
    pageList.innerHTML = `
      <div class="models-page-shell">
        <div class="models-summary-strip" aria-label="Сводка моделей">
          <span><strong>${models.length}</strong> всего</span>
          <span><strong>${readyCount}</strong> готовы</span>
          <span><strong>${experimentalCount}</strong> deep</span>
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
    'gemma4-deepthinking': 'Pro · Deep Thinking',
    'gemma4-31b': 'Extra · максимум',
    micro: 'Micro · мгновенно',
    lite: 'Lite · голос',
  };
  return labels[role] || String(role || 'Локальная модель');
}

function modelRoleDescription(role) {
  const descriptions = {
    'gemma4-fast': 'Короткие ответы, повседневные задачи и быстрые уточнения.',
    'gemma4-balanced': 'Основной профиль для разработки, анализа и длинных диалогов.',
    'gemma4-deepthinking': 'Сложные задачи, где важнее глубина рассуждения, чем скорость.',
    'gemma4-31b': 'Редкий тяжёлый маршрут с максимальным расходом ресурсов.',
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

function renderWorkspace() {
  if (!elements.workspaceSummary && !elements.workspaceModuleList) return;
  const app = state.data.app || {};
  const modules = state.data.runtime.snapshot.modules || [];
  const events = state.data.runtime.snapshot.events || [];
  const capabilities = state.data.runtime.snapshot.capabilities || [];
  const models = state.data.models.models || [];

  if (elements.workspaceSummary) {
    elements.workspaceSummary.innerHTML = [
      previewItem('Путь', app.workspaceRoot || 'неизвестно'),
      previewItem('Модулей', modules.length),
      previewItem('Возможностей', capabilities.length),
      previewItem('Моделей', models.length),
      previewItem('Событий', events.length),
    ].join('');
  }

  if (elements.workspaceModuleList) {
    const rows = modules.map((record) => {
      const manifest = record.manifest || {};
      const capabilityCount = Array.isArray(manifest.capabilities) ? manifest.capabilities.length : 0;
      return `
        <article class="workspace-module-card" data-status="${escapeHtml(record.status || 'unknown')}">
          <header>
            <strong>${escapeHtml(manifest.name || manifest.id || 'Monarch module')}</strong>
            <span class="status-text ${escapeHtml(record.status || 'unknown')}">${escapeHtml(formatRuntimeStatus(record.status || 'unknown'))}</span>
          </header>
          <p>${escapeHtml(manifest.id || 'module')} · ${escapeHtml(manifest.kind || 'service')}</p>
          <small>${capabilityCount} ${capabilityCount === 1 ? 'возможность' : 'возможностей'}</small>
        </article>
      `;
    }).join('');
    elements.workspaceModuleList.innerHTML = rows || '<div class="tree-item">Модули ещё не загружены</div>';
  }
}
