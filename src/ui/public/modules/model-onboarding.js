import { fetchState, installModels, skipModelOnboarding } from './api.js';
import { state, updateState } from './state.js';
import { escapeHtml, readErrorMessage } from './utils.js';

const elements = {
  root: document.querySelector('#model-setup'),
  shell: document.querySelector('#app-shell'),
  hardware: document.querySelector('#model-setup-hardware'),
  list: document.querySelector('#model-setup-list'),
  reveal: document.querySelector('#model-setup-reveal'),
  all: document.querySelector('#model-setup-all'),
  allInput: document.querySelector('#model-setup-all-input'),
  totalSize: document.querySelector('#model-setup-total-size'),
  install: document.querySelector('#model-setup-install'),
  skip: document.querySelector('#model-setup-skip'),
  feedback: document.querySelector('#model-setup-feedback'),
  progress: document.querySelector('#model-setup-progress'),
  manualModels: document.querySelector('#model-setup-manual-models'),
  openFolder: document.querySelector('#model-setup-open-folder'),
  manualFeedback: document.querySelector('#model-setup-manual-feedback'),
};

let initialized = false;
let expanded = false;
let selectionTouched = false;
let selectedRoles = new Set();

export function initModelOnboarding() {
  if (initialized) return;
  initialized = true;

  elements.reveal?.addEventListener('click', () => {
    expanded = !expanded;
    renderModelOnboarding();
  });
  elements.allInput?.addEventListener('change', () => {
    const roles = readModels().map((model) => model.role);
    selectedRoles = elements.allInput.checked ? new Set(roles) : new Set();
    selectionTouched = true;
    renderModelOnboarding();
  });
  elements.list?.addEventListener('change', (event) => {
    const input = event.target.closest('[data-model-setup-role]');
    if (!(input instanceof HTMLInputElement)) return;
    const role = input.dataset.modelSetupRole;
    if (!role) return;
    if (input.checked) selectedRoles.add(role);
    else selectedRoles.delete(role);
    selectionTouched = true;
    renderModelOnboarding();
  });
  elements.install?.addEventListener('click', () => void beginInstall());
  elements.skip?.addEventListener('click', () => void skipInstall());
  elements.openFolder?.addEventListener('click', () => void openModelsFolder());
}

export function renderModelOnboarding() {
  const components = readComponents();
  const required = components?.onboarding?.required === true;
  if (!elements.root) return;
  elements.root.hidden = !required;
  document.body.classList.toggle('model-setup-open', required);
  if (elements.shell) {
    if (required) elements.shell.setAttribute('inert', '');
    else elements.shell.removeAttribute('inert');
  }
  if (!required) return;

  const models = readModels();
  const recommendedRole = components.onboarding.recommendedRole;
  const active = components.activeInstall?.source === 'onboarding' ? components.activeInstall : null;
  if (!selectionTouched) {
    const persisted = components.onboarding.selectedRoles || [];
    selectedRoles = new Set(persisted.length > 0 ? persisted : [recommendedRole]);
  }

  renderHardware(components.onboarding.hardware);
  const visibleModels = expanded ? models : models.filter((model) => model.role === recommendedRole);
  elements.list.innerHTML = visibleModels.map((model) => modelCard(
    model,
    recommendedRole,
    selectedRoles.has(model.role),
    Boolean(active),
  )).join('');

  if (elements.reveal) {
    elements.reveal.textContent = expanded ? 'Скрыть остальные' : 'Показать все модели';
    elements.reveal.setAttribute('aria-expanded', String(expanded));
    elements.reveal.hidden = Boolean(active);
  }
  if (elements.all) elements.all.hidden = !expanded || Boolean(active);
  if (elements.allInput) {
    elements.allInput.checked = models.length > 0 && models.every((model) => selectedRoles.has(model.role));
  }
  if (elements.totalSize) {
    elements.totalSize.textContent = formatBytes(models.reduce((sum, model) => sum + model.expectedBytes, 0));
  }
  if (elements.install) {
    const count = selectedRoles.size;
    elements.install.disabled = Boolean(active) || count === 0;
    elements.install.textContent = active
      ? 'Загружаем…'
      : count > 1
        ? `Скачать модели (${count})`
        : 'Скачать и продолжить';
  }
  if (elements.skip) {
    elements.skip.hidden = Boolean(active);
    elements.skip.disabled = Boolean(active);
  }
  if (elements.feedback) {
    elements.feedback.textContent = components.onboarding.error || (selectedRoles.size === 0 ? 'Выбери хотя бы одну модель.' : '');
  }
  renderProgress(models, active);
  renderManualModels(models);
}

async function beginInstall() {
  const roles = [...selectedRoles];
  if (roles.length === 0 || !elements.install) return;
  elements.install.disabled = true;
  if (elements.feedback) elements.feedback.textContent = '';
  try {
    await installModels(roles, 'onboarding');
    updateState(await fetchState());
  } catch (error) {
    if (elements.feedback) elements.feedback.textContent = readErrorMessage(error);
    elements.install.disabled = false;
  }
}

async function skipInstall() {
  if (!elements.skip) return;
  elements.skip.disabled = true;
  if (elements.feedback) elements.feedback.textContent = '';
  try {
    await skipModelOnboarding();
    updateState(await fetchState());
  } catch (error) {
    if (elements.feedback) elements.feedback.textContent = readErrorMessage(error);
    elements.skip.disabled = false;
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

function renderHardware(hardware) {
  if (!elements.hardware) return;
  const values = [];
  const ram = Number(hardware?.ramTotalGb);
  if (Number.isFinite(ram) && ram > 0) values.push(`<span><small>Память</small><strong>${escapeHtml(formatNumber(ram))} ГБ</strong></span>`);
  const disk = Number(hardware?.diskFreeBytes);
  if (Number.isFinite(disk) && disk >= 0) values.push(`<span><small>Свободно</small><strong>${escapeHtml(formatBytes(disk))}</strong></span>`);
  elements.hardware.innerHTML = values.join('');
  elements.hardware.hidden = values.length === 0;
}

function modelCard(model, recommendedRole, selected, disabled) {
  const warning = model.warning ? `<p class="model-setup-warning">${escapeHtml(model.warning)}</p>` : '';
  return `
    <label class="model-setup-card ${selected ? 'is-selected' : ''}" data-phase="${escapeHtml(model.phase)}">
      <input type="checkbox" data-model-setup-role="${escapeHtml(model.role)}" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="model-setup-card-orb" aria-hidden="true"></span>
      <span class="model-setup-card-copy">
        <span><strong>${escapeHtml(model.label)}</strong>${model.role === recommendedRole ? '<b>Рекомендуется</b>' : ''}${model.beta ? '<em>Beta</em>' : ''}</span>
        <small>${escapeHtml(model.summary)}</small>
        ${warning}
      </span>
      <span class="model-setup-card-size">${escapeHtml(formatBytes(model.expectedBytes))}</span>
      <span class="model-setup-check" aria-hidden="true">✓</span>
    </label>
  `;
}

function renderProgress(models, active) {
  if (!elements.progress) return;
  if (!active) {
    elements.progress.hidden = true;
    elements.progress.innerHTML = '';
    return;
  }
  const selected = models.filter((model) => active.roles.includes(model.role));
  const expected = selected.reduce((sum, model) => sum + model.expectedBytes, 0);
  const downloaded = selected.reduce((sum, model) => sum + model.downloadedBytes, 0);
  const percent = expected > 0 ? Math.max(0, Math.min(100, Math.round((downloaded / expected) * 100))) : 0;
  const current = selected.find((model) => ['checking', 'downloading', 'verifying'].includes(model.phase))
    || selected.find((model) => !model.complete)
    || selected.at(-1);
  elements.progress.hidden = false;
  elements.progress.innerHTML = `
    <div><strong>${escapeHtml(current?.label || 'Модели')}</strong><span>${percent}%</span></div>
    <progress max="100" value="${percent}">${percent}%</progress>
    <p>${escapeHtml(formatBytes(downloaded))} из ${escapeHtml(formatBytes(expected))}</p>
  `;
}

function renderManualModels(models) {
  if (!elements.manualModels) return;
  elements.manualModels.innerHTML = models.map((model) => {
    const files = Array.isArray(model.manualInstall) ? model.manualInstall : [];
    const directories = [...new Set(files.map((file) => file.directory))];
    return `
      <article class="model-setup-manual-model">
        <header><strong>${escapeHtml(model.label)}</strong><span>${files.length} ${files.length === 1 ? 'файл' : 'файла'}</span></header>
        ${directories.map((directory) => `<p>Папка: <code>${escapeHtml(directory.replaceAll('/', '\\'))}</code></p>`).join('')}
        <div>${files.map((file) => `
          <a href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer">
            <span>Скачать</span><strong>${escapeHtml(file.fileName)}</strong>
          </a>
        `).join('')}</div>
      </article>
    `;
  }).join('');
}

function readComponents() {
  return state.data?.components?.schemaVersion === 2 ? state.data.components : null;
}

function readModels() {
  return Array.isArray(readComponents()?.models) ? readComponents().models : [];
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
