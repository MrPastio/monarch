import {
  addCustomModelFile,
  downloadCustomModel,
  inspectCustomModelHub,
  listCustomModels,
  removeCustomModel,
  renameCustomModel,
} from './api.js';
import { state } from './state.js';
import { confirmAction, promptValue } from './ui-dialogs.js';
import { reducedUiMotion } from './ui-motion.js';
import { escapeHtml, readErrorMessage } from './utils.js';

/* Settings → Модели → «Свои модели». Three ways in, all one step deep:
   drop a .gguf, pick it from disk, or paste a Hugging Face link and take the
   suggested file. The chat model menu lists every ready model. */

const $ = (selector) => document.querySelector(selector);
const elements = {
  root: $('#custom-models'),
  drop: $('#custom-models-drop'),
  hub: $('#custom-models-hub'),
  link: $('#custom-hub-link'),
  files: $('#custom-hub-files'),
  final: $('#custom-hub-final'),
  name: $('#custom-hub-name'),
  feedback: $('#custom-models-feedback'),
  list: $('#custom-models-list'),
  linkToggle: $('[data-custom-link]'),
};

let initialized = false;
let busy = false;
let inspection = null;
let chosenFile = '';
let showAllFiles = false;
// Four plain-language choices instead of every quantization a repo ships.
const FILE_PRESETS = [['Q3_K_M', 'Компактно'], ['Q4_K_M', 'Баланс'], ['Q5_K_M', 'Точнее'], ['Q8_0', 'Максимум']];
let pollTimer = 0;

export function initCustomModelsPane() {
  if (initialized || !elements.root) return;
  initialized = true;
  elements.root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-custom-pick]')) { void pickFile(); return; }
    if (target.closest('[data-custom-link]')) { toggleHub(); return; }
    if (target.closest('[data-custom-download]')) { void startDownload(); return; }
    if (target.closest('[data-custom-all-files]')) { showAllFiles = !showAllFiles; renderFiles(); return; }
    const file = target.closest('[data-custom-file]');
    if (file) { chooseFile(file.dataset.customFile); return; }
    const use = target.closest('[data-custom-use]');
    if (use) { selectInChat(use.dataset.customUse); return; }
    const rename = target.closest('[data-custom-rename]');
    if (rename) { void renameModel(rename.dataset.customRename); return; }
    const remove = target.closest('[data-custom-remove]');
    if (remove) void removeModel(remove.dataset.customRemove);
  });
  elements.hub?.addEventListener('submit', (event) => { event.preventDefault(); void inspectLink(); });
  elements.link?.addEventListener('input', () => { if (inspection) resetInspection(); });
  const drop = elements.drop;
  drop?.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    drop.dataset.dragging = 'true';
  });
  drop?.addEventListener('dragleave', (event) => {
    if (!drop.contains(event.relatedTarget)) delete drop.dataset.dragging;
  });
  drop?.addEventListener('drop', (event) => {
    event.preventDefault();
    delete drop.dataset.dragging;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const filePath = window.monarchDesktop?.pathForDroppedFile?.(file) || '';
    if (!filePath) { say('Перетаскивание работает в приложении Monarch. Нажми «Выбрать файл».'); return; }
    void addFile(filePath);
  });
}

export function renderCustomModelsPane() {
  if (!elements.list) return;
  const models = readModels();
  const selection = String(state.oscar?.modelSelection || '');
  const signature = JSON.stringify([models.map((model) => [model.id, model.label, model.status, model.sizeBytes,
    model.status === 'downloading' ? Math.round((model.downloadedBytes / Math.max(1, model.sizeBytes)) * 100) : 0, model.error]), selection]);
  if (elements.list.dataset.signature !== signature) {
    elements.list.dataset.signature = signature;
    elements.list.innerHTML = models.map((model) => modelRow(model, selection)).join('');
  }
  schedulePoll(models);
}

/** Ready owner models in the chat model menu, right after the Monarch scale. */
export function syncComposerCustomModels(selection) {
  const container = document.querySelector('[data-custom-models]');
  if (!container) return;
  const ready = readModels().filter((model) => model.status === 'ready');
  container.hidden = ready.length === 0;
  const signature = JSON.stringify([ready.map((model) => [model.id, model.label]), selection]);
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.innerHTML = ready.length
    ? `<span class="omenu-divider">Свои модели</span>${ready.map((model) => `
      <button type="button" class="dropdown-item omenu-row${model.id === selection ? ' active' : ''}" data-value="${escapeHtml(model.id)}" role="option" aria-selected="${model.id === selection}" tabindex="-1">
        <span class="omenu-row-mark" aria-hidden="true">${escapeHtml(initial(model.label))}</span>
        <span class="omenu-row-text"><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(formatBytes(model.sizeBytes))} · только обычный чат</small></span>
        <span class="omenu-check" aria-hidden="true"></span>
      </button>`).join('')}`
    : '';
}

export function customModelLabel(id) {
  return readModels().find((model) => model.id === id)?.label || '';
}

export function isReadyCustomModel(id) {
  return readModels().some((model) => model.id === id && model.status === 'ready');
}

function readModels() {
  return Array.isArray(state.data?.customModels) ? state.data.customModels : [];
}

function modelRow(model, selection) {
  const percent = model.status === 'downloading' && model.sizeBytes > 0
    ? Math.max(0, Math.min(100, Math.round((model.downloadedBytes / model.sizeBytes) * 100))) : 0;
  const origin = model.source === 'download' ? 'Скачана по ссылке' : 'С диска';
  const context = `до ${Math.round(model.contextTokens / 1024)}K токенов`;
  const meta = model.status === 'downloading'
    ? `Скачивается · ${percent}%${model.sizeBytes ? ` из ${formatBytes(model.sizeBytes)}` : ''}`
    : model.status === 'ready' ? `${origin} · ${formatBytes(model.sizeBytes)} · ${context}`
      : model.error || 'Не готова';
  const selected = model.id === selection;
  const action = model.status === 'ready'
    ? `<button type="button" class="${selected ? 'claude-ghost-btn' : 'claude-secondary-btn'}" data-custom-use="${escapeHtml(model.id)}" ${selected ? 'aria-pressed="true"' : ''}>${selected ? 'Выбрана в чате ✓' : 'Выбрать в чате'}</button>`
    : '';
  return `
    <article class="custom-model" data-status="${escapeHtml(model.status)}" style="--progress:${percent / 100}">
      <span class="custom-model-mark" aria-hidden="true">${escapeHtml(initial(model.label))}</span>
      <span class="custom-model-copy">
        <strong>${escapeHtml(model.label)}</strong>
        <small>${escapeHtml(meta)}</small>
        ${model.status === 'downloading' ? '<span class="custom-model-bar" aria-hidden="true"><i></i></span>' : ''}
      </span>
      <span class="custom-model-actions">
        ${action}
        <button type="button" class="ds-icon-btn" data-custom-rename="${escapeHtml(model.id)}" aria-label="Переименовать ${escapeHtml(model.label)}" title="Переименовать"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
        <button type="button" class="ds-icon-btn" data-custom-remove="${escapeHtml(model.id)}" aria-label="${model.status === 'downloading' ? 'Отменить загрузку' : 'Убрать'} ${escapeHtml(model.label)}" title="${model.status === 'downloading' ? 'Отменить загрузку' : 'Убрать'}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg></button>
      </span>
    </article>`;
}

async function pickFile() {
  const pick = window.monarchDesktop?.pickModelFile;
  if (typeof pick !== 'function') { say('Выбор файла работает в приложении Monarch.'); return; }
  const filePath = await pick().catch(() => null);
  if (filePath) await addFile(filePath);
}

async function addFile(filePath) {
  if (busy) return;
  busy = true;
  say('Проверяю файл…');
  try {
    const result = await addCustomModelFile({ path: filePath });
    applyModels(result.models);
    say(`«${result.model.label}» добавлена. Её можно выбрать в чате.`);
    highlight(result.model.id);
  } catch (error) {
    say(readErrorMessage(error));
  } finally {
    busy = false;
  }
}

function toggleHub(force) {
  const open = typeof force === 'boolean' ? force : elements.hub.hidden;
  elements.linkToggle?.setAttribute('aria-expanded', String(open));
  reveal(elements.hub, open);
  if (open) requestAnimationFrame(() => elements.link?.focus());
}

async function inspectLink() {
  const link = elements.link.value.trim();
  if (!link || busy) return;
  busy = true;
  say('Ищу файлы модели…');
  resetInspection();
  try {
    inspection = await inspectCustomModelHub(link);
    chosenFile = inspection.files.find((file) => file.recommended)?.file || inspection.files[0]?.file || '';
    elements.name.value = inspection.suggestedLabel;
    renderFiles();
    reveal(elements.files, true);
    reveal(elements.final, true);
    say(`Нашлось вариантов: ${inspection.files.length}. Рекомендуемый уже выбран.`);
  } catch (error) {
    say(readErrorMessage(error));
  } finally {
    busy = false;
  }
}

function renderFiles() {
  if (!inspection) return;
  const presets = FILE_PRESETS
    .map(([quantization, label]) => ({ file: inspection.files.find((item) => item.quantization === quantization), label }))
    .filter((entry) => entry.file);
  const picked = inspection.files.find((item) => item.file === chosenFile);
  if (picked && !presets.some((entry) => entry.file === picked)) presets.push({ file: picked, label: 'Выбранный' });
  const compact = !showAllFiles && presets.length >= 2 && inspection.files.length > presets.length;
  const entries = compact ? presets : inspection.files.map((file) => ({ file, label: '' }));
  elements.files.dataset.compact = String(compact);
  elements.files.innerHTML = entries.map(({ file, label }) => `
    <button type="button" class="custom-hub-file" role="radio" aria-checked="${file.file === chosenFile}" tabindex="${file.file === chosenFile ? 0 : -1}" data-custom-file="${escapeHtml(file.file)}">
      <strong>${escapeHtml(label || file.quantization || shortName(file.file))}</strong>
      <small>${escapeHtml(file.sizeBytes ? formatBytes(file.sizeBytes) : 'размер неизвестен')}${label && file.quantization ? ` · ${escapeHtml(file.quantization)}` : ''}</small>
      ${file.recommended ? '<em>Рекомендуем</em>' : ''}
    </button>`).join('')
    + (inspection.files.length > presets.length && presets.length >= 2
      ? `<button type="button" class="custom-hub-more" data-custom-all-files>${compact ? `Все варианты (${inspection.files.length})` : 'Только основные'}</button>` : '');
}

function chooseFile(file) {
  chosenFile = file;
  renderFiles();
  elements.files.querySelector('[aria-checked="true"]')?.focus();
}

function resetInspection() {
  inspection = null;
  chosenFile = '';
  showAllFiles = false;
  reveal(elements.files, false);
  reveal(elements.final, false);
}

async function startDownload() {
  if (!inspection || !chosenFile || busy) return;
  busy = true;
  try {
    const result = await downloadCustomModel({
      repository: inspection.repository,
      revision: inspection.revision,
      file: chosenFile,
      label: elements.name.value.trim(),
    });
    applyModels(result.models);
    say(`Скачиваю «${result.model.label}». Можно закрыть настройки — загрузка продолжится.`);
    elements.link.value = '';
    resetInspection();
    toggleHub(false);
    highlight(result.model.id);
  } catch (error) {
    say(readErrorMessage(error));
  } finally {
    busy = false;
  }
}

function selectInChat(id) {
  window.dispatchEvent(new CustomEvent('monarch:select-model', { detail: { model: id } }));
  renderCustomModelsPane();
  say('Готово: Оскар отвечает этой моделью в обычном чате.');
}

async function renameModel(id) {
  const model = readModels().find((item) => item.id === id);
  if (!model) return;
  const label = await promptValue('Новое название модели', model.label);
  if (typeof label !== 'string' || !label.trim() || label.trim() === model.label) return;
  try {
    applyModels((await renameCustomModel(id, label.trim())).models);
  } catch (error) {
    say(readErrorMessage(error));
  }
}

async function removeModel(id) {
  const model = readModels().find((item) => item.id === id);
  if (!model) return;
  const question = model.status === 'downloading'
    ? `Отменить загрузку «${model.label}»?`
    : model.source === 'download'
      ? `Убрать «${model.label}»? Скачанный файл тоже удалится.`
      : `Убрать «${model.label}» из Monarch? Сам файл останется на диске.`;
  if (!await confirmAction(question)) return;
  try {
    applyModels((await removeCustomModel(id)).models);
    if (state.oscar?.modelSelection === id) {
      window.dispatchEvent(new CustomEvent('monarch:select-model', { detail: { model: 'none' } }));
    }
    say('Модель убрана.');
  } catch (error) {
    say(readErrorMessage(error));
  }
}

function applyModels(models) {
  if (!state.data || !Array.isArray(models)) return;
  state.data.customModels = models;
  renderCustomModelsPane();
  syncComposerCustomModels(String(state.oscar?.modelSelection || ''));
}

function schedulePoll(models) {
  const downloading = models.some((model) => model.status === 'downloading');
  if (!downloading || pollTimer) return;
  pollTimer = window.setTimeout(async () => {
    pollTimer = 0;
    try { applyModels((await listCustomModels()).models); } catch { /* next state refresh retries */ }
  }, 1000);
}

function highlight(id) {
  if (reducedUiMotion.matches) return;
  requestAnimationFrame(() => {
    const row = [...elements.list.querySelectorAll('.custom-model')].find((node) => node.querySelector(`[data-custom-remove="${CSS.escape(id)}"]`));
    row?.animate([
      { opacity: 0, transform: 'translateY(-8px) scale(.98)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 420, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  });
}

/* One owner for show/hide inside this section: height and opacity. */
function reveal(node, visible) {
  if (!node || node.hidden === !visible) return;
  node.getAnimations().forEach((animation) => animation.cancel());
  if (reducedUiMotion.matches) { node.hidden = !visible; return; }
  if (visible) {
    node.hidden = false;
    node.animate([
      { opacity: 0, height: '0px' },
      { opacity: 1, height: `${node.scrollHeight}px` },
    ], { duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  } else {
    node.animate([
      { opacity: 1, height: `${node.getBoundingClientRect().height}px` },
      { opacity: 0, height: '0px' },
    ], { duration: 200, easing: 'cubic-bezier(.4, 0, 1, 1)' }).finished.then(() => { node.hidden = true; }, () => undefined);
  }
}

function say(message) {
  if (elements.feedback) elements.feedback.textContent = message;
}

function initial(label) {
  return String(label || '?').trim().charAt(0).toUpperCase() || '?';
}

function shortName(file) {
  return String(file).split('/').pop().replace(/\.gguf$/iu, '');
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes === 0) return '—';
  if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / (1024 ** 2)))} МБ`;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes / (1024 ** 3))} ГБ`;
}
