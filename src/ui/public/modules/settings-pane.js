import { executeCapability, fetchSkills } from './api.js';
import { readErrorMessage } from './utils.js';
import {
  DEFAULT_OSCAR_VOICE_PREFERENCES,
  OSCAR_VOICE_PRESETS,
  normalizeOscarVoicePreferences,
  readOscarVoicePreferences,
  saveOscarVoicePreferences,
} from './oscar-voice-settings.js';

export const COMMUNICATION_PRESETS = Object.freeze({
  balanced: {
    traits: ['спокойный', 'любопытный', 'живой'],
    rules: ['Обращайся на ты.', 'Сначала показывай результат.', 'Пиши ясно, естественно и без лишней церемонии.'],
  },
  concise: {
    traits: ['собранный', 'прямой'],
    rules: ['Обращайся на ты.', 'Отвечай максимально кратко.', 'Не повторяй условия задачи и не объясняй очевидное.'],
  },
  warm: {
    traits: ['тёплый', 'любопытный', 'игривый'],
    rules: ['Обращайся на ты.', 'Пиши тепло и естественно.', 'Умеренно проявляй характер, мнение и эмоции, когда это уместно.'],
  },
  technical: {
    traits: ['точный', 'скептичный', 'инженерный'],
    rules: ['Обращайся на ты.', 'Сначала давай проверяемый результат.', 'Отделяй факты от предположений и указывай выполненные проверки.'],
  },
});

const CATEGORY_LABELS = Object.freeze({
  fact: 'Факт',
  preference: 'Предпочтение',
  project: 'Проект',
  correction: 'Исправление',
  note: 'Заметка',
});

const SETTINGS_TABS = new Set(['general', 'memory', 'skills', 'telegram', 'safe', 'system']);
const SKILL_INITIAL_LIMIT = 12;
const SKILL_PAGE_SIZE = 12;

let currentPreset = 'balanced';
let currentSettingsTab = 'general';
let telegramExpiresAt = '';
let telegramTimer;
let discoveredSkills = [];
let visibleSkillLimit = SKILL_INITIAL_LIMIT;
let voicePulseTimer;
const loadedSettingsTabs = new Set();

export function initSettingsPane() {
  const profileForm = document.querySelector('#profile-settings-form');
  const memoryForm = document.querySelector('#memory-create-form');
  const memoryList = document.querySelector('#memory-settings-list');
  const createCodeButton = document.querySelector('#telegram-create-code');
  const copyCodeButton = document.querySelector('#telegram-copy-code');
  const refreshTelegramButton = document.querySelector('#telegram-refresh-status');
  const toggleTelegramRemoteButton = document.querySelector('#telegram-toggle-remote');
  const revokeTelegramButton = document.querySelector('#telegram-revoke-all');
  const refreshSkillsButton = document.querySelector('#skills-refresh');
  const skillsSearch = document.querySelector('#skills-search');
  const skillsList = document.querySelector('#skills-settings-list');
  const voiceForm = document.querySelector('#oscar-voice-settings-form');
  const testVoiceButton = document.querySelector('#oscar-voice-test');
  const resetVoiceTuningButton = document.querySelector('#oscar-voice-reset-tuning');
  const safeSettingsButton = document.querySelector('#safe-open-security-settings');
  const safeShortcutButton = document.querySelector('#safe-shortcut-toggle');
  const safeOpenButton = document.querySelector('#safe-open-now');

  document.querySelectorAll('[data-settings-preset]').forEach((button) => {
    button.addEventListener('click', () => selectCommunicationPreset(button.dataset.settingsPreset, true));
  });
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.addEventListener('click', () => selectSettingsTab(button.dataset.settingsTab));
  });
  window.addEventListener('monarch:settings-tab', (event) => {
    selectSettingsTab(event.detail?.tab || event.detail);
  });
  window.addEventListener('monarch:view-change', (event) => {
    if (event.detail?.view !== 'settings-section') {
      clearInterval(telegramTimer);
      telegramTimer = undefined;
    }
  });
  profileForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveProfileSettings();
  });
  voiceForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    saveOscarVoiceForm();
  });
  document.querySelectorAll('[data-voice-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      selectOscarVoicePreset(button.dataset.voicePreset, true);
      markOscarVoiceSettingsDirty();
    });
  });
  document.querySelector('#oscar-voice-style')?.addEventListener('change', () => {
    pulseOscarVoiceVisualizer();
    markOscarVoiceSettingsDirty();
  });
  document.querySelectorAll('[data-voice-slider]').forEach((slider) => {
    slider.addEventListener('input', () => {
      syncOscarVoiceSlider(slider);
      pulseOscarVoiceVisualizer();
      markOscarVoiceSettingsDirty();
    });
  });
  resetVoiceTuningButton?.addEventListener('click', () => {
    const current = readOscarVoiceForm();
    renderOscarVoiceForm({
      ...current,
      speed: DEFAULT_OSCAR_VOICE_PREFERENCES.speed,
      pitch: DEFAULT_OSCAR_VOICE_PREFERENCES.pitch,
      expressiveness: DEFAULT_OSCAR_VOICE_PREFERENCES.expressiveness,
      pauseMs: DEFAULT_OSCAR_VOICE_PREFERENCES.pauseMs,
      volume: DEFAULT_OSCAR_VOICE_PREFERENCES.volume,
    });
    pulseOscarVoiceVisualizer();
    markOscarVoiceSettingsDirty('Настройка сброшена · не сохранено');
  });
  testVoiceButton?.addEventListener('click', () => void testOscarVoice());
  memoryForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    void createMemoryRecord();
  });
  memoryList?.addEventListener('click', (event) => {
    const saveButton = event.target.closest('[data-memory-save]');
    const deleteButton = event.target.closest('[data-memory-delete]');
    if (saveButton) void updateMemoryRecord(saveButton.dataset.memorySave, saveButton);
    if (deleteButton) void deleteMemoryRecord(deleteButton.dataset.memoryDelete, deleteButton);
  });
  createCodeButton?.addEventListener('click', () => void rotateTelegramCode());
  copyCodeButton?.addEventListener('click', () => void copyTelegramCode());
  refreshTelegramButton?.addEventListener('click', () => void loadTelegramSettings());
  toggleTelegramRemoteButton?.addEventListener('click', () => void toggleTelegramRemote());
  revokeTelegramButton?.addEventListener('click', () => void revokeTelegramPairings());
  safeSettingsButton?.addEventListener('click', () => void openSafeSecuritySettings());
  safeShortcutButton?.addEventListener('click', () => void toggleSafeShortcut());
  safeOpenButton?.addEventListener('click', () => void openSafeNow());
  refreshSkillsButton?.addEventListener('click', () => void loadSkillSettings(true));
  skillsSearch?.addEventListener('input', () => {
    visibleSkillLimit = SKILL_INITIAL_LIMIT;
    renderSkillSettings();
  });
  skillsList?.addEventListener('click', (event) => {
    const moreButton = event.target.closest('[data-skills-show-more]');
    if (moreButton) {
      visibleSkillLimit += SKILL_PAGE_SIZE;
      renderSkillSettings();
      return;
    }
    const button = event.target.closest('[data-settings-skill]');
    if (button) useSkillFromSettings(button.dataset.settingsSkill || '');
  });

  renderOscarVoiceForm(readOscarVoicePreferences());
  selectSettingsTab(currentSettingsTab, false);
}

export function readOscarVoiceForm(documentRef = document) {
  return normalizeOscarVoicePreferences({
    voice: documentRef.querySelector('#oscar-voice-preset')?.value,
    style: documentRef.querySelector('#oscar-voice-style')?.value,
    speed: documentRef.querySelector('#oscar-voice-speed')?.value,
    pitch: documentRef.querySelector('#oscar-voice-pitch')?.value,
    expressiveness: documentRef.querySelector('#oscar-voice-expressiveness')?.value,
    pauseMs: documentRef.querySelector('#oscar-voice-pause')?.value,
    volume: documentRef.querySelector('#oscar-voice-volume')?.value,
    instruction: documentRef.querySelector('#oscar-voice-instruction')?.value,
  });
}

function renderOscarVoiceForm(preferences) {
  const normalized = normalizeOscarVoicePreferences(preferences);
  selectOscarVoicePreset(normalized.voice, false);
  setValue('#oscar-voice-style', normalized.style);
  setValue('#oscar-voice-speed', normalized.speed);
  setValue('#oscar-voice-pitch', normalized.pitch);
  setValue('#oscar-voice-expressiveness', normalized.expressiveness);
  setValue('#oscar-voice-pause', normalized.pauseMs);
  setValue('#oscar-voice-volume', normalized.volume);
  setValue('#oscar-voice-instruction', normalized.instruction);
  document.querySelectorAll('[data-voice-slider]').forEach(syncOscarVoiceSlider);
}

function selectOscarVoicePreset(value, animate) {
  const voice = Object.hasOwn(OSCAR_VOICE_PRESETS, value) ? value : DEFAULT_OSCAR_VOICE_PREFERENCES.voice;
  setValue('#oscar-voice-preset', voice);
  document.querySelectorAll('[data-voice-preset]').forEach((button) => {
    const selected = button.dataset.voicePreset === voice;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  const visual = document.querySelector('#oscar-voice-visual');
  const preset = OSCAR_VOICE_PRESETS[voice];
  if (visual) visual.dataset.voice = voice;
  setText('[data-voice-visual-name]', preset.label);
  setText('[data-voice-visual-description]', preset.description);
  setText('[data-voice-monogram]', voice === 'aurora' ? 'A' : 'O');
  if (animate) pulseOscarVoiceVisualizer();
}

function syncOscarVoiceSlider(slider) {
  const key = slider?.dataset?.voiceSlider;
  if (!key) return;
  const value = Number(slider.value);
  const minimum = Number(slider.min);
  const maximum = Number(slider.max);
  const fill = maximum > minimum ? ((value - minimum) / (maximum - minimum)) * 100 : 0;
  slider.style.setProperty('--voice-range-fill', `${fill}%`);
  const output = document.querySelector(`#oscar-voice-${key === 'pauseMs' ? 'pause' : key}-value`);
  if (!output) return;
  if (key === 'pitch') output.textContent = value > 0 ? `+${value}` : String(value);
  else if (key === 'pauseMs') output.textContent = `${value} мс`;
  else output.textContent = `${value}%`;
}

function pulseOscarVoiceVisualizer() {
  const visual = document.querySelector('#oscar-voice-visual');
  if (!visual) return;
  visual.classList.remove('is-pulsing');
  void visual.offsetWidth;
  visual.classList.add('is-pulsing');
  clearTimeout(voicePulseTimer);
  voicePulseTimer = setTimeout(() => visual.classList.remove('is-pulsing'), 760);
}

function markOscarVoiceSettingsDirty(message = 'Не сохранено') {
  setStatus(document.querySelector('#oscar-voice-save-state'), message);
}

function saveOscarVoiceForm() {
  const saved = saveOscarVoicePreferences(readOscarVoiceForm());
  renderOscarVoiceForm(saved);
  setStatus(document.querySelector('#oscar-voice-save-state'), 'Сохранено');
  return saved;
}

async function testOscarVoice() {
  const button = document.querySelector('#oscar-voice-test');
  const status = document.querySelector('#oscar-voice-save-state');
  const preferences = saveOscarVoiceForm();
  const visual = document.querySelector('#oscar-voice-visual');
  if (typeof window.monarchDesktop?.speakText !== 'function') {
    setStatus(status, 'Проверка голоса доступна в Monarch Desktop', true);
    return;
  }
  setBusy(button, true, 'Озвучиваю…');
  setStatus(status, 'Проверка');
  visual?.classList.add('is-previewing');
  try {
    await window.monarchDesktop.stopSpeaking?.();
    const result = await window.monarchDesktop.speakText({
      text: 'Привет. Это выбранный голос Оскара. Я готов отвечать естественно, быстро и по делу.',
      language: 'ru-RU',
      ...preferences,
    });
    if (result?.ok === false) throw new Error(result.summary || result.error);
    setStatus(status, 'Голос готов');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
  } finally {
    visual?.classList.remove('is-previewing');
    setBusy(button, false, 'Проверить голос');
  }
}

export function splitSettingsLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatPairingTime(expiresAt, now = Date.now()) {
  const remaining = Math.max(0, Date.parse(expiresAt || '') - now);
  if (!Number.isFinite(remaining) || remaining <= 0) return 'Код истёк';
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return `Действует ещё ${minutes} мин`;
}

export function unwrapCapabilityPayload(payload) {
  return payload?.result || payload || {};
}

export function filterVisibleSkills(skills, query, limit = 80) {
  const needle = String(query || '').trim().toLocaleLowerCase('ru');
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => !needle || [
      skill.name,
      skill.displayName,
      skill.description,
      skill.provider,
      skill.scope,
    ].some((value) => String(value || '').toLocaleLowerCase('ru').includes(needle)))
    .sort((left, right) => (
      skillScopeRank(right.scope) - skillScopeRank(left.scope)
      || String(left.displayName || left.name).localeCompare(String(right.displayName || right.name), 'ru')
    ))
    .slice(0, Math.max(1, limit));
}

export function normalizeSettingsTab(value) {
  const tab = String(value || '').trim().toLowerCase();
  return SETTINGS_TABS.has(tab) ? tab : 'general';
}

export function selectSettingsTab(value, load = true) {
  currentSettingsTab = normalizeSettingsTab(value);
  let activeTabButton = null;
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    const active = button.dataset.settingsTab === currentSettingsTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    if (active) activeTabButton = button;
  });
  let primaryDetailsOpened = false;
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
    const active = panel.dataset.settingsPanel === currentSettingsTab;
    panel.hidden = !active;
    if (active && panel.tagName === 'DETAILS') {
      panel.open = !primaryDetailsOpened;
      primaryDetailsOpened = true;
    }
  });
  clearInterval(telegramTimer);
  telegramTimer = undefined;
  if (currentSettingsTab === 'telegram') {
    telegramTimer = setInterval(renderTelegramExpiry, 15_000);
  }
  keepHorizontalTabVisible(activeTabButton);
  const settingsView = activeTabButton?.closest?.('#settings-section');
  if (settingsView && !settingsView.classList.contains('view-hidden')) {
    settingsView.querySelector('.document-feed')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }
  if (load) void ensureSettingsTabLoaded(currentSettingsTab);
}

function keepHorizontalTabVisible(button) {
  const tabList = button?.parentElement;
  if (!button || !tabList || tabList.scrollWidth <= tabList.clientWidth) return;
  const safeInset = 12;
  const buttonStart = button.offsetLeft;
  const buttonEnd = buttonStart + button.offsetWidth;
  const visibleStart = tabList.scrollLeft + safeInset;
  const visibleEnd = tabList.scrollLeft + tabList.clientWidth - safeInset;
  if (buttonStart < visibleStart) tabList.scrollTo({ left: Math.max(0, buttonStart - safeInset), behavior: 'auto' });
  else if (buttonEnd > visibleEnd) tabList.scrollTo({ left: buttonEnd - tabList.clientWidth + safeInset, behavior: 'auto' });
}

async function ensureSettingsTabLoaded(tab) {
  if (loadedSettingsTabs.has(tab)) return;
  loadedSettingsTabs.add(tab);
  try {
    if (tab === 'general') await loadProfileSettings();
    else if (tab === 'memory') await loadMemorySettings();
    else if (tab === 'skills') await loadSkillSettings();
    else if (tab === 'telegram') await loadTelegramSettings();
    else if (tab === 'safe') await loadSafeSettings();
  } catch {
    loadedSettingsTabs.delete(tab);
  }
}

async function loadSafeSettings() {
  const bridge = window.monarchDesktop;
  const badge = document.querySelector('#safe-shortcut-status');
  const button = document.querySelector('#safe-shortcut-toggle');
  const feedback = document.querySelector('#safe-settings-feedback');
  if (!bridge?.getSafeShortcutStatus) {
    if (badge) badge.textContent = 'Только Desktop';
    if (button) button.disabled = true;
    setStatus(feedback, 'Ярлык и изолированные настройки доступны в приложении Monarch для Windows.');
    return;
  }
  try {
    const result = await bridge.getSafeShortcutStatus();
    if (!result?.ok) throw new Error(result?.error === 'unsupported-platform' ? 'Отдельный ярлык сейчас поддерживается только в Windows.' : 'Не удалось проверить ярлык Safe.');
    if (badge) badge.textContent = result.created ? 'Ярлык создан' : 'Без отдельного ярлыка';
    if (button) {
      button.disabled = false;
      button.dataset.created = String(result.created === true);
      button.textContent = result.created ? 'Удалить отдельный ярлык' : 'Создать отдельный ярлык';
    }
    setStatus(feedback, result.created ? 'Monarch Safe можно запускать отдельно с рабочего стола.' : 'Основное приложение и данные Safe останутся общими; ярлык меняет только способ запуска.');
  } catch (error) {
    if (badge) badge.textContent = 'Недоступно';
    setStatus(feedback, readErrorMessage(error), true);
  }
}

async function toggleSafeShortcut() {
  const bridge = window.monarchDesktop;
  const button = document.querySelector('#safe-shortcut-toggle');
  const feedback = document.querySelector('#safe-settings-feedback');
  if (!bridge?.createSafeShortcut || !bridge?.removeSafeShortcut) return loadSafeSettings();
  const remove = button?.dataset.created === 'true';
  setBusy(button, true, remove ? 'Удаляю…' : 'Создаю…');
  try {
    const result = remove ? await bridge.removeSafeShortcut() : await bridge.createSafeShortcut();
    if (!result?.ok) throw new Error('Windows не подтвердил изменение ярлыка Monarch Safe.');
    loadedSettingsTabs.delete('safe');
    await loadSafeSettings();
  } catch (error) {
    setStatus(feedback, readErrorMessage(error), true);
    setBusy(button, false, remove ? 'Удалить отдельный ярлык' : 'Создать отдельный ярлык');
  }
}

async function openSafeSecuritySettings() {
  const feedback = document.querySelector('#safe-settings-feedback');
  try {
    const result = await window.monarchDesktop?.openSafeSettings?.();
    if (!result?.ok) throw new Error('Изолированное окно Safe недоступно.');
    setStatus(feedback, 'Настройки открыты в изолированном окне. Разблокируй Safe и подтверди изменения текущим PIN.');
  } catch (error) { setStatus(feedback, readErrorMessage(error), true); }
}

async function openSafeNow() {
  const feedback = document.querySelector('#safe-settings-feedback');
  try {
    const result = await window.monarchDesktop?.openSafe?.();
    if (!result?.ok) throw new Error('Изолированное окно Safe недоступно.');
    setStatus(feedback, result.created ? 'Monarch Safe открыт.' : 'Окно Monarch Safe уже было открыто.');
  } catch (error) { setStatus(feedback, readErrorMessage(error), true); }
}

async function loadProfileSettings() {
  const saveState = document.querySelector('#profile-save-state');
  try {
    const result = await runCapability('profile', 'profile.read', {});
    const profile = result.output?.profile || {};
    const preset = profile.preferences?.communicationPreset;
    currentPreset = Object.hasOwn(COMMUNICATION_PRESETS, preset) ? preset : 'balanced';
    setValue('#profile-adaptive-summary', profile.adaptiveSummary || '');
    setValue('#profile-style-rules', Array.isArray(profile.styleRules) ? profile.styleRules.join('\n') : '');
    selectCommunicationPreset(currentPreset, false);
    setStatus(saveState, 'Сохранено');
  } catch (error) {
    setStatus(saveState, readErrorMessage(error), true);
  }
}

async function saveProfileSettings() {
  const form = document.querySelector('#profile-settings-form');
  const saveState = document.querySelector('#profile-save-state');
  const submit = form?.querySelector('button[type="submit"]');
  setBusy(submit, true, 'Сохраняю…');
  setStatus(saveState, 'Сохранение');
  try {
    await runCapability('profile', 'profile.update', {
      adaptiveSummary: readValue('#profile-adaptive-summary'),
      traits: COMMUNICATION_PRESETS[currentPreset]?.traits || [],
      styleRules: splitSettingsLines(readValue('#profile-style-rules')),
      preferences: { communicationPreset: currentPreset },
    });
    setStatus(saveState, 'Сохранено');
  } catch (error) {
    setStatus(saveState, readErrorMessage(error), true);
  } finally {
    setBusy(submit, false, 'Сохранить характер');
  }
}

function selectCommunicationPreset(name, applyRules) {
  if (!Object.hasOwn(COMMUNICATION_PRESETS, name)) return;
  currentPreset = name;
  document.querySelectorAll('[data-settings-preset]').forEach((button) => {
    const active = button.dataset.settingsPreset === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (applyRules) {
    setValue('#profile-style-rules', COMMUNICATION_PRESETS[name].rules.join('\n'));
  }
}

async function loadMemorySettings() {
  const list = document.querySelector('#memory-settings-list');
  try {
    const result = await runCapability('memory', 'memory.list', { limit: 100 });
    const records = Array.isArray(result.output?.records) ? result.output.records : [];
    renderMemoryRecords(records);
  } catch (error) {
    if (list) list.textContent = `Не удалось загрузить память: ${readErrorMessage(error)}`;
  }
}

async function createMemoryRecord() {
  const text = readValue('#memory-create-text');
  if (!text) return;
  const submit = document.querySelector('#memory-create-form button[type="submit"]');
  const feedback = document.querySelector('#memory-feedback');
  setBusy(submit, true, 'Сохраняю…');
  setStatus(feedback, '');
  try {
    const pinned = Boolean(document.querySelector('#memory-create-pinned')?.checked);
    await runCapability('memory', 'memory.remember', {
      text,
      source: 'settings-ui',
      category: readValue('#memory-create-category') || 'preference',
      tier: pinned ? 'permanent' : 'long',
      importance: pinned ? 0.95 : 0.65,
      pinned,
    });
    setValue('#memory-create-text', '');
    setStatus(feedback, 'Запись добавлена');
    await loadMemorySettings();
  } catch (error) {
    setStatus(feedback, readErrorMessage(error), true);
  } finally {
    setBusy(submit, false, 'Запомнить');
  }
}

async function updateMemoryRecord(id, button) {
  const item = button.closest('.memory-settings-item');
  if (!item) return;
  setBusy(button, true, 'Сохраняю…');
  try {
    const pinned = Boolean(item.querySelector('[data-memory-pinned]')?.checked);
    await runCapability('memory', 'memory.update', {
      id,
      text: item.querySelector('[data-memory-text]')?.value || '',
      category: item.querySelector('[data-memory-category]')?.value || 'note',
      tier: pinned ? 'permanent' : 'long',
      pinned,
      importance: pinned ? 0.95 : 0.65,
    });
    setItemStatus(item, 'Сохранено');
  } catch (error) {
    setItemStatus(item, readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Сохранить');
  }
}

async function deleteMemoryRecord(id, button) {
  if (!window.confirm('Удалить эту запись из постоянной памяти?')) return;
  const item = button.closest('.memory-settings-item');
  setBusy(button, true, 'Удаляю…');
  try {
    await runCapability('memory', 'memory.forget', { id });
    item?.remove();
    updateMemoryCount();
  } catch (error) {
    setItemStatus(item, readErrorMessage(error), true);
    setBusy(button, false, 'Удалить');
  }
}

function renderMemoryRecords(records) {
  const list = document.querySelector('#memory-settings-list');
  if (!list) return;
  list.replaceChildren();
  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-empty';
    empty.textContent = 'Память пока пустая. Добавь первое правило или важный факт.';
    list.append(empty);
  } else {
    records.forEach((record) => list.append(createMemoryItem(record)));
  }
  updateMemoryCount();
}

function createMemoryItem(record) {
  const item = document.createElement('article');
  item.className = 'memory-settings-item';
  item.dataset.memoryId = String(record.id || '');

  const textarea = document.createElement('textarea');
  textarea.rows = 2;
  textarea.maxLength = 1200;
  textarea.value = String(record.text || '');
  textarea.dataset.memoryText = '';
  textarea.setAttribute('aria-label', 'Текст записи памяти');

  const controls = document.createElement('div');
  controls.className = 'memory-item-controls';
  const category = document.createElement('select');
  category.dataset.memoryCategory = '';
  category.setAttribute('aria-label', 'Категория памяти');
  Object.entries(CATEGORY_LABELS).forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === record.category;
    category.append(option);
  });
  const pinLabel = document.createElement('label');
  pinLabel.className = 'toggle-control';
  const pinned = document.createElement('input');
  pinned.type = 'checkbox';
  pinned.checked = record.pinned === true || record.tier === 'permanent';
  pinned.dataset.memoryPinned = '';
  pinLabel.append(pinned, document.createTextNode(' Всегда учитывать'));

  const status = document.createElement('span');
  status.className = 'memory-item-status';
  status.textContent = record.updatedAt ? `Обновлено ${formatShortDate(record.updatedAt)}` : '';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'claude-ghost-btn';
  save.dataset.memorySave = String(record.id || '');
  save.textContent = 'Сохранить';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'memory-delete-button';
  remove.dataset.memoryDelete = String(record.id || '');
  remove.textContent = 'Удалить';
  controls.append(category, pinLabel, status, save, remove);
  item.append(textarea, controls);
  return item;
}

async function loadSkillSettings(refresh = false) {
  const button = document.querySelector('#skills-refresh');
  setBusy(button, true, 'Обновляю…');
  try {
    discoveredSkills = await fetchSkills(refresh);
    visibleSkillLimit = SKILL_INITIAL_LIMIT;
    renderSkillSettings();
    setStatus(document.querySelector('#skills-feedback'), refresh ? 'Каталог обновлён' : '');
  } catch (error) {
    setStatus(document.querySelector('#skills-feedback'), readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Обновить');
  }
}

function renderSkillSettings() {
  const list = document.querySelector('#skills-settings-list');
  if (!list) return;
  const query = document.querySelector('#skills-search')?.value || '';
  const matching = filterVisibleSkills(discoveredSkills, query, Number.POSITIVE_INFINITY);
  const visible = matching.slice(0, visibleSkillLimit);
  const hasQuery = Boolean(String(query).trim());
  const localCount = discoveredSkills.filter((skill) => skill.scope === 'project').length;
  const userCount = discoveredSkills.filter((skill) => skill.scope === 'user').length;
  const compatibleCount = discoveredSkills.filter((skill) => skill.compatible !== false).length;
  setText('#skills-count', hasQuery ? `${matching.length} из ${discoveredSkills.length}` : `${discoveredSkills.length} навыков`);
  setText('#skills-workspace-count', String(localCount));
  setText('#skills-user-count', String(userCount));
  setText('#skills-compatible-count', String(compatibleCount));
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-empty';
    empty.textContent = query ? 'По этому запросу навыков нет.' : 'Локальные навыки пока не найдены.';
    list.append(empty);
    return;
  }
  visible.forEach((skill) => list.append(createSkillItem(skill)));
  if (visible.length < matching.length) {
    list.append(createSkillsMoreButton(visible.length, matching.length));
  }
}

function createSkillItem(skill) {
  const item = document.createElement('article');
  item.className = 'skill-settings-item';
  item.dataset.scope = String(skill.scope || 'system');
  item.dataset.compatible = String(skill.compatible !== false);

  const copy = document.createElement('div');
  copy.className = 'skill-settings-copy';
  const displayName = String(skill.displayName || skill.name || 'Agent Skill');
  const title = document.createElement('strong');
  title.textContent = displayName;
  const description = document.createElement('p');
  description.textContent = String(skill.description || 'Локальный workflow без описания.');
  const badges = document.createElement('div');
  badges.className = 'skill-settings-badges';
  [
    providerLabel(skill.provider),
    scopeLabel(skill.scope),
    skill.trust === 'linked' ? 'внешняя ссылка' : 'проверенный путь',
    skill.resourceCount ? `${skill.resourceCount} ресурс.` : 'без ресурсов',
  ].forEach((label) => {
    const badge = document.createElement('span');
    badge.textContent = label;
    badges.append(badge);
  });
  copy.append(title, description, badges);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'claude-ghost-btn';
  action.dataset.settingsSkill = String(skill.name || '');
  action.textContent = skill.compatible === false ? 'Недоступен' : 'Вставить';
  action.disabled = skill.compatible === false;
  action.setAttribute('aria-label', skill.compatible === false
    ? `${displayName} недоступен в этом окружении`
    : `Вставить ${displayName} в запрос`);
  item.append(copy, action);
  return item;
}

function createSkillsMoreButton(shown, total) {
  const wrapper = document.createElement('div');
  wrapper.className = 'skill-settings-more';
  const summary = document.createElement('span');
  summary.textContent = `Показано ${shown} из ${total}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'claude-ghost-btn';
  button.dataset.skillsShowMore = 'true';
  button.textContent = `Показать ещё ${Math.min(SKILL_PAGE_SIZE, total - shown)}`;
  wrapper.append(summary, button);
  return wrapper;
}

function useSkillFromSettings(name) {
  if (!name) return;
  const input = document.querySelector('#oscar-input');
  if (!input) return;
  input.value = `$${name} `;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.nav-item[data-scroll-target="oscar-section"]')?.click();
  input.focus();
  setStatus(document.querySelector('#skills-feedback'), `Навык $${name} закреплён в запросе`);
}

function providerLabel(provider) {
  return provider === 'gemini' ? 'Gemini CLI'
    : provider === 'monarch' ? 'Monarch'
      : provider === 'claude' ? 'Claude'
        : 'Codex';
}

function scopeLabel(scope) {
  return scope === 'project' ? 'workspace' : scope === 'user' ? 'пользователь' : 'системный';
}

function skillScopeRank(scope) {
  return scope === 'project' ? 3 : scope === 'user' ? 2 : 1;
}

async function loadTelegramSettings() {
  const refresh = document.querySelector('#telegram-refresh-status');
  setBusy(refresh, true, 'Проверяю…');
  try {
    const result = await runCapability('telegram', 'telegram.status', {});
    renderTelegramSettings(result.output || {});
    setStatus(document.querySelector('#telegram-feedback'), 'Статус обновлён');
  } catch (error) {
    setStatus(document.querySelector('#telegram-feedback'), readErrorMessage(error), true);
  } finally {
    setBusy(refresh, false, 'Проверить привязку');
  }
}

async function rotateTelegramCode() {
  const button = document.querySelector('#telegram-create-code');
  setBusy(button, true, 'Создаю…');
  try {
    const result = await runCapability('telegram', 'telegram.pairing.rotate', {});
    renderTelegramSettings(result.output || {});
    setStatus(document.querySelector('#telegram-feedback'), 'Новый код готов. Отправь его боту командой /pair.');
  } catch (error) {
    setStatus(document.querySelector('#telegram-feedback'), readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Создать новый код');
  }
}

async function toggleTelegramRemote() {
  const button = document.querySelector('#telegram-toggle-remote');
  const paused = button?.dataset.paused === 'true';
  setBusy(button, true, paused ? 'Возобновляю…' : 'Останавливаю…');
  try {
    const capabilityId = paused ? 'telegram.remote.resume' : 'telegram.remote.pause';
    const result = await runCapability('telegram', capabilityId, {});
    renderTelegramSettings(result.output || {});
    setStatus(document.querySelector('#telegram-feedback'), paused
      ? 'Удалённые задачи снова разрешены'
      : 'Удалённые задачи и новые привязки остановлены');
  } catch (error) {
    setStatus(document.querySelector('#telegram-feedback'), readErrorMessage(error), true);
  } finally {
    const nowPaused = button?.dataset.paused === 'true';
    setBusy(button, false, nowPaused ? 'Возобновить удалённый доступ' : 'Остановить удалённый доступ');
  }
}

async function revokeTelegramPairings() {
  const button = document.querySelector('#telegram-revoke-all');
  setBusy(button, true, 'Отзываю…');
  try {
    const result = await runCapability('telegram', 'telegram.pairing.revoke', {});
    renderTelegramSettings(result.output || {});
    setStatus(document.querySelector('#telegram-feedback'), 'Все Telegram-привязки и их напоминания удалены');
  } catch (error) {
    setStatus(document.querySelector('#telegram-feedback'), readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Отозвать все привязки');
  }
}

function renderTelegramSettings(status) {
  const username = typeof status.bot?.username === 'string' ? status.bot.username : '';
  const pairings = Array.isArray(status.pairedChats) ? status.pairedChats : [];
  const botName = document.querySelector('#telegram-bot-name');
  const detail = document.querySelector('#telegram-bot-detail');
  const badge = document.querySelector('#telegram-status-badge');
  const code = document.querySelector('#telegram-pairing-code');
  const tokenPath = document.querySelector('#telegram-token-path');
  const createCode = document.querySelector('#telegram-create-code');
  const copyCode = document.querySelector('#telegram-copy-code');
  const toggleRemote = document.querySelector('#telegram-toggle-remote');
  const revokeAll = document.querySelector('#telegram-revoke-all');
  const pairingCode = status.remotePaused ? '' : String(status.pairingCode || '');

  if (botName) botName.textContent = username ? `@${username}` : status.configured ? 'Бот настроен' : 'Токен не добавлен';
  if (detail) detail.textContent = status.remotePaused
    ? 'Защитный режим · удалённые задачи остановлены'
    : status.running
    ? status.pollingMode === 'standby'
      ? `Подключён через другой локальный runtime · привязок: ${pairings.length}`
      : pairings.length ? `Работает локально · привязок: ${pairings.length}` : 'Работает локально · ждёт привязки'
    : status.configured ? 'Настроен, но локальный процесс остановлен' : 'Добавь токен по инструкции ниже';
  if (badge) {
    badge.textContent = status.remotePaused ? 'Защита' : pairings.length ? 'Привязан' : status.running ? 'Готов' : status.configured ? 'Остановлен' : 'Не настроен';
    badge.dataset.state = status.remotePaused ? 'attention' : pairings.length ? 'paired' : status.running ? 'ready' : 'attention';
  }
  if (code) code.textContent = pairingCode || '••••••';
  if (tokenPath && status.tokenPath) tokenPath.textContent = String(status.tokenPath);
  if (createCode) createCode.disabled = status.remotePaused === true;
  if (copyCode) copyCode.disabled = status.remotePaused === true || !/^\d{6}$/.test(pairingCode);
  if (toggleRemote) {
    toggleRemote.dataset.paused = String(status.remotePaused === true);
    toggleRemote.textContent = status.remotePaused ? 'Возобновить удалённый доступ' : 'Остановить удалённый доступ';
  }
  if (revokeAll) revokeAll.disabled = pairings.length === 0;
  setText('#telegram-task-mode', status.remotePaused
    ? 'Lockdown · задачи остановлены'
    : status.running
      ? `Agent · ${status.pollingMode || 'owner'}`
      : 'Stopped · polling не активен');
  setText('#telegram-security-mode', status.securityMode === 'paired-chat + confirmation-gated'
    ? 'Привязка + подтверждения'
    : String(status.securityMode || 'confirmation-gated'));
  telegramExpiresAt = String(status.pairingExpiresAt || '');
  renderTelegramExpiry();
  renderTelegramInsights(status, pairings);
}

function renderTelegramInsights(status, pairings) {
  setText('#telegram-paired-summary', `Привязок: ${pairings.length}`);
  setText('#telegram-pending-summary', `Подтверждений: ${Number(status.pendingConfirmations || 0)}`);
  setText('#telegram-reminder-summary', `Напоминаний: ${Number(status.reminders || 0)}`);
  setText('#telegram-mode-summary', status.remotePaused ? 'Режим: защита' : `Режим: ${status.pollingMode || 'stopped'}`);
  setText('#telegram-security-summary', status.remotePaused ? 'Безопасность: lockdown' : 'Безопасность: confirm-gated');
  const error = document.querySelector('#telegram-error-summary');
  if (error) {
    const message = String(status.lastError || '').trim();
    error.hidden = !message;
    error.textContent = message ? `Ошибка: ${message}` : '';
  }
}

function renderTelegramExpiry() {
  const expiry = document.querySelector('#telegram-code-expiry');
  if (expiry) expiry.textContent = formatPairingTime(telegramExpiresAt);
}

async function copyTelegramCode() {
  const value = document.querySelector('#telegram-pairing-code')?.textContent?.trim() || '';
  if (!/^\d{6}$/.test(value)) {
    setStatus(document.querySelector('#telegram-feedback'), 'Сначала создай код привязки.', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    setStatus(document.querySelector('#telegram-feedback'), 'Код скопирован');
  } catch {
    setStatus(document.querySelector('#telegram-feedback'), `Код: ${value}`);
  }
}

async function runCapability(moduleId, capabilityId, input) {
  const payload = await executeCapability(moduleId, capabilityId, input, 'ui:settings', false);
  let result = unwrapCapabilityPayload(payload);
  if (result.ok) return result;
  if (result.error !== 'confirmation-required') {
    throw new Error(result.summary || result.error || 'Действие не выполнено.');
  }
  const token = result.metadata?.confirmation?.token;
  if (!token || !window.confirm('Разрешить Monarch изменить локальные настройки?')) {
    throw new Error('Изменение отменено.');
  }
  result = unwrapCapabilityPayload(await executeCapability(moduleId, capabilityId, input, 'ui:settings', true, token));
  if (!result.ok) throw new Error(result.summary || result.error || 'Действие не выполнено.');
  return result;
}

function updateMemoryCount() {
  const count = document.querySelectorAll('.memory-settings-item').length;
  const label = document.querySelector('#memory-count');
  if (label) label.textContent = `${count} ${count === 1 ? 'запись' : count > 1 && count < 5 ? 'записи' : 'записей'}`;
}

function setItemStatus(item, message, isError = false) {
  const status = item?.querySelector('.memory-item-status');
  setStatus(status, message, isError);
}

function setStatus(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error-text', isError);
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = label;
}

function readValue(selector) {
  return document.querySelector(selector)?.value?.trim() || '';
}

function setValue(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.value = value;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function formatShortDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ru', { day: '2-digit', month: 'short' }).format(date)
    : '';
}
