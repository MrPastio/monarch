import { confirmAction, promptValue } from './ui-dialogs.js';
import { initTelegramV2Settings } from './telegram-v2-settings.js';
import { initGmailSettings } from './gmail-settings.js';
import { initGitHubSettings } from './github-settings.js';
import { initCalendarSettings } from './calendar-settings.js';
import {
  controlTelegram,
  executeCapability,
  createSkillDraft,
  fetchSkills,
  publishSkillDraft,
  previewPersonality,
  readLocalSettings,
  fetchImageGenerationContext,
  updateImageGenerationPolicy,
  validateSkillDraft,
  writeLocalSettings,
} from './api.js';
import { escapeHtml, readErrorMessage } from './utils.js';
import { skillUserFacingDescription, skillUserFacingName } from './skill-ux.js';
import { initOwnerEnrollment, loadOwnerEnrollment } from './owner-enrollment.js';
import { initOwnerRedZones } from './owner-red-zones.js';
import { swapUiSurface } from './ui-motion.js';
import { state, subscribeState } from './state.js';
import {
  DEFAULT_OSCAR_VOICE_PREFERENCES,
  OSCAR_VOICE_PRESETS,
  applyVoiceRuntimeCapabilities,
  applyVoiceSettingsSnapshot,
  isVoicePronunciationControlAvailable,
  normalizeOscarVoicePreferences,
  normalizeVoicePreferencesDocument,
  readLegacyOscarVoicePreferences,
  readOscarVoicePreferences,
  readVoiceRuntimeCapabilities,
  readVoiceSettingsSnapshot,
} from './oscar-voice-settings.js';

export const PERSONALITY_DIMENSIONS = Object.freeze({
  brevity: 'Краткость',
  warmth: 'Теплота',
  directness: 'Прямота',
  initiative: 'Инициативность',
  humor: 'Юмор',
  skepticism: 'Осторожность в выводах',
  technicalDepth: 'Технические подробности',
  structure: 'Структура',
});

/** Each answer-style choice has three positions; the middle one adds nothing to the prompt. */
const STYLE_LEVELS = Object.freeze([15, 50, 85]);
const STYLE_SAVE_DELAY_MS = 450;

const CATEGORY_LABELS = Object.freeze({
  fact: 'Факт',
  preference: 'Предпочтение',
  project: 'Проект',
  correction: 'Исправление',
  note: 'Заметка',
});

const SETTINGS_TABS = new Set(['style', 'voice', 'images', 'max', 'models', 'memory', 'skills', 'integrations', 'telegram', 'safe', 'access', 'system', 'dev']);
const SETTINGS_HEADER_COMPACT_AT = 32;
const SETTINGS_HEADER_EXPAND_AT = 2;
const SKILL_INITIAL_LIMIT = 12;
const SKILL_PAGE_SIZE = 12;
const VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION = '2026-08-29.1';

export function resolveSettingsHeaderCompactState(scrollTop, isCompact) {
  const position = Number.isFinite(Number(scrollTop)) ? Math.max(0, Number(scrollTop)) : 0;
  return isCompact
    ? position > SETTINGS_HEADER_EXPAND_AT
    : position >= SETTINGS_HEADER_COMPACT_AT;
}

let personalitySettingsRevision = 0;
let personalitySettingsDocument = null;
let styleSaveTimer = 0;
let styleSaveQueue = Promise.resolve();
let memorySettingsRevision = 0;
let memorySettingsRecords = [];
let currentSettingsTab = 'models';
let telegramExpiresAt = '';
let telegramTimer;
let telegramAstraAvailable = false;
let discoveredSkills = [];
let visibleSkillLimit = SKILL_INITIAL_LIMIT;
let verifiedSkillDraftHash = '';
let voicePulseTimer;
let voiceSaveTimer;
let voiceSettingsRevision = 0;
let voiceSettingsDocument = normalizeVoicePreferencesDocument(null);
let voiceSettingsLoaded = false;
let voiceMutationVersion = 0;
let voiceSavedVersion = 0;
let voiceSaveQueue = Promise.resolve();
let voiceLoadPromise = null;
let activeVoicePresetId = null;
let imageGenerationPolicy = null;
let ownerDevRevision = 0;
let ownerPromptRevision = 0;
const loadedSettingsTabs = new Set();

export function initSettingsPane() {
  initTelegramV2Settings();
  initGmailSettings();
  initGitHubSettings();
  initCalendarSettings();
  initOwnerEnrollment();
  initOwnerRedZones();
  initStyleSettings();
  const memoryForm = document.querySelector('#memory-create-form');
  const memoryList = document.querySelector('#memory-settings-list');
  const memoryCrossChat = document.querySelector('#memory-cross-chat-enabled');
  const memorySearch = document.querySelector('#memory-search');
  const memoryCategoryFilter = document.querySelector('#memory-category-filter');
  const memoryComposeToggle = document.querySelector('#memory-compose-toggle');
  const memoryComposeClose = document.querySelector('#memory-compose-close');
  const memoryDerivedList = document.querySelector('#memory-derived-list');
  const memoryDerivedForgetAll = document.querySelector('#memory-derived-forget-all');
  const createCodeButton = document.querySelector('#telegram-create-code');
  const copyCodeButton = document.querySelector('#telegram-copy-code');
  const refreshTelegramButton = document.querySelector('#telegram-refresh-status');
  const toggleTelegramConnectionButton = document.querySelector('#telegram-toggle-connection');
  const toggleTelegramRemoteButton = document.querySelector('#telegram-toggle-remote');
  const revokeTelegramButton = document.querySelector('#telegram-revoke-all');
  const refreshSkillsButton = document.querySelector('#skills-refresh');
  const skillsSearch = document.querySelector('#skills-search');
  const skillsList = document.querySelector('#skills-settings-list');
  const skillsOpenChatPicker = document.querySelector('#skills-open-chat-picker');
  const skillCreateToggle = document.querySelector('#skill-create-toggle');
  const skillAuthoringClose = document.querySelector('#skill-authoring-close');
  const skillAuthoringForm = document.querySelector('#skill-authoring-form');
  const skillEditor = document.querySelector('#skill-editor');
  const skillValidateButton = document.querySelector('#skill-validate');
  const skillPublishButton = document.querySelector('#skill-publish');
  const voiceForm = document.querySelector('#oscar-voice-settings-form');
  const testVoiceButton = document.querySelector('#oscar-voice-test');
  const resetVoiceTuningButton = document.querySelector('#oscar-voice-reset-tuning');
  const voiceStopButton = document.querySelector('#oscar-voice-stop');
  const voiceRetryButton = document.querySelector('#oscar-voice-retry');
  const voiceSavePresetButton = document.querySelector('#oscar-voice-save-preset');
  const voiceCustomPresets = document.querySelector('#oscar-voice-custom-presets');
  const voicePronunciationAdd = document.querySelector('#voice-pronunciation-add');
  const voicePronunciationList = document.querySelector('#voice-pronunciation-list');
  const voiceAutoSend = document.querySelector('#voice-input-auto-send');
  const voiceSimplifiedMode = document.querySelector('#voice-simplified-mode');
  const voiceBackgroundWake = document.querySelector('#voice-background-wake');
  const voiceInformationProviders = document.querySelector('#voice-information-providers');
  const voiceWeatherLocationMode = document.querySelector('#voice-weather-location-mode');
  const voiceWeatherLocation = document.querySelector('#voice-weather-location');
  const safeSettingsButton = document.querySelector('#safe-open-security-settings');
  const safeShortcutButton = document.querySelector('#safe-shortcut-toggle');
  const safeOpenButton = document.querySelector('#safe-open-now');
  const imageProviderConsentToggle = document.querySelector('#image-provider-consent-toggle');
  const imageIncognitoPersistence = document.querySelector('#image-incognito-persistence');
  const ownerDevReset = document.querySelector('#owner-dev-reset');
  const ownerPromptsResetAll = document.querySelector('#owner-prompts-reset-all');
  const ownerPromptList = document.querySelector('#owner-prompt-list');
  const ownerModeDisable = document.querySelector('#owner-mode-disable');
  const settingsFeed = document.querySelector('#settings-section .document-feed');

  subscribeState(syncOwnerDevVisibility);
  subscribeState(renderVoiceRecognitionState);
  syncOwnerDevVisibility();
  document.querySelectorAll('[data-dev-setting]').forEach((input) => {
    input.addEventListener('change', () => void saveOwnerDevSetting(input));
  });
  ownerDevReset?.addEventListener('click', () => void resetOwnerDevSettings());
  ownerPromptsResetAll?.addEventListener('click', () => void resetAllOwnerPrompts());
  ownerPromptList?.addEventListener('click', (event) => {
    const save = event.target.closest('[data-owner-prompt-save]');
    if (save) void saveOwnerPrompt(save.dataset.ownerPromptSave, save);
    const reset = event.target.closest('[data-owner-prompt-reset]');
    if (reset) void resetOwnerPrompt(reset.dataset.ownerPromptReset, reset);
  });

  const settingsSection = document.querySelector('#settings-section');
  let settingsScrollFrame = 0;
  const syncSettingsHeader = () => {
    settingsScrollFrame = 0;
    if (!settingsFeed || !settingsSection) return;
    const compact = resolveSettingsHeaderCompactState(
      settingsFeed.scrollTop,
      settingsSection.classList.contains('is-scrolled'),
    );
    settingsSection.classList.toggle('is-scrolled', compact);
  };
  settingsFeed?.addEventListener('scroll', () => {
    if (settingsScrollFrame) return;
    settingsScrollFrame = window.requestAnimationFrame(syncSettingsHeader);
  }, { passive: true });
  syncSettingsHeader();
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tabs = [...document.querySelectorAll('[data-settings-tab]:not([hidden])')];
      const direction = tabs.indexOf(button) >= tabs.findIndex((item) => item.dataset.settingsTab === currentSettingsTab) ? 1 : -1;
      void swapUiSurface(document.querySelector('.settings-panel-stack'), () => selectSettingsTab(button.dataset.settingsTab), { direction });
    });
  });
  ownerModeDisable?.addEventListener('click', () => void disableOwnerMode(ownerModeDisable));
  window.addEventListener('monarch:settings-tab', (event) => {
    selectSettingsTab(event.detail?.tab || event.detail);
  });
  window.addEventListener('monarch:view-change', (event) => {
    if (event.detail?.view !== 'settings-section') {
      clearInterval(telegramTimer);
      telegramTimer = undefined;
    }
  });
  window.addEventListener('monarch:images-policy-changed', (event) => {
    if (event.detail?.policy) {
      imageGenerationPolicy = event.detail.policy;
      renderImageSettingsPolicy(imageGenerationPolicy);
    } else {
      loadedSettingsTabs.delete('images');
    }
  });
  imageProviderConsentToggle?.addEventListener('click', () => void toggleImageProviderConsent());
  imageIncognitoPersistence?.addEventListener('change', () => void mutateImagePolicy({
    action: 'incognito-persistence',
    value: imageIncognitoPersistence.value,
  }));
  document.querySelectorAll('[data-image-mature-mode]').forEach((button) => {
    button.addEventListener('click', () => void mutateImagePolicy({
      action: 'mature-mode',
      mode: button.dataset.imageMatureMode,
      adultAttested: button.dataset.imageMatureMode === 'off'
        || document.querySelector('#image-adult-attestation')?.checked === true,
    }));
  });
  voiceForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    void flushOscarVoiceAutosave();
  });
  document.querySelectorAll('[data-voice-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      activeVoicePresetId = null;
      selectOscarVoicePreset(button.dataset.voicePreset, true);
      scheduleOscarVoiceAutosave();
    });
  });
  // Arrow keys move between the three voices, as in the answer-style choices.
  document.querySelector('#voice-settings .style-segment')?.addEventListener('keydown', (event) => {
    const option = event.target.closest?.('[data-voice-preset]');
    if (!option || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const options = [...option.parentElement.querySelectorAll('[data-voice-preset]')];
    const index = options.indexOf(option);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
        : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + options.length) % options.length;
    event.preventDefault();
    options[next].focus();
    options[next].click();
  });
  document.querySelector('#oscar-voice-style')?.addEventListener('change', () => {
    activeVoicePresetId = null;
    pulseOscarVoiceVisualizer();
    scheduleOscarVoiceAutosave();
  });
  document.querySelector('#oscar-voice-instruction')?.addEventListener('input', () => {
    activeVoicePresetId = null;
    scheduleOscarVoiceAutosave();
  });
  document.querySelectorAll('[data-voice-slider]').forEach((slider) => {
    slider.addEventListener('input', () => {
      activeVoicePresetId = null;
      syncOscarVoiceSlider(slider);
      pulseOscarVoiceVisualizer();
      scheduleOscarVoiceAutosave();
    });
  });
  voiceAutoSend?.addEventListener('change', () => scheduleOscarVoiceAutosave());
  voiceSimplifiedMode?.addEventListener('change', () => scheduleOscarVoiceAutosave());
  voiceBackgroundWake?.addEventListener('change', () => scheduleOscarVoiceAutosave());
  voiceInformationProviders?.addEventListener('change', () => {
    if (voiceInformationProviders.checked) {
      voiceInformationProviders.dataset.agreementVersion = VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION;
      voiceInformationProviders.dataset.consentedAt = new Date().toISOString();
    } else {
      voiceInformationProviders.dataset.agreementVersion = '';
      voiceInformationProviders.dataset.consentedAt = '';
    }
    syncVoiceInformationProviderControls();
    scheduleOscarVoiceAutosave('Сохраняю сетевое разрешение…');
  });
  voiceWeatherLocationMode?.addEventListener('change', () => {
    syncVoiceInformationProviderControls();
    scheduleOscarVoiceAutosave();
  });
  voiceWeatherLocation?.addEventListener('input', () => scheduleOscarVoiceAutosave());
  window.addEventListener('monarch:voice-wake-state', (event) => {
    const label = document.querySelector('#voice-wake-runtime-state');
    if (label) label.textContent = String(event.detail?.label || 'Отклик на обращение недоступен');
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
    activeVoicePresetId = null;
    pulseOscarVoiceVisualizer();
    scheduleOscarVoiceAutosave('Настройка сброшена · сохраняю…');
  });
  testVoiceButton?.addEventListener('click', () => void testOscarVoice());
  voiceStopButton?.addEventListener('click', () => void stopOscarVoicePreview());
  voiceRetryButton?.addEventListener('click', () => void retryOscarVoiceAutosave());
  voiceSavePresetButton?.addEventListener('click', () => void createOscarVoicePreset());
  voiceCustomPresets?.addEventListener('click', (event) => {
    const select = event.target.closest?.('[data-voice-custom-select]');
    const update = event.target.closest?.('[data-voice-custom-update]');
    const remove = event.target.closest?.('[data-voice-custom-delete]');
    if (select) selectCustomOscarVoicePreset(select.dataset.voiceCustomSelect);
    if (update) void updateOscarVoicePreset(update.dataset.voiceCustomUpdate, update);
    if (remove) void deleteOscarVoicePreset(remove.dataset.voiceCustomDelete, remove);
  });
  voicePronunciationAdd?.addEventListener('click', () => void createVoicePronunciationRule());
  voicePronunciationList?.addEventListener('change', (event) => {
    const toggle = event.target.closest?.('[data-voice-pronunciation-toggle]');
    if (toggle) void updateVoicePronunciationRule(toggle.dataset.voicePronunciationToggle, { enabled: toggle.checked }, toggle);
  });
  voicePronunciationList?.addEventListener('click', (event) => {
    const test = event.target.closest?.('[data-voice-pronunciation-test]');
    const remove = event.target.closest?.('[data-voice-pronunciation-delete]');
    if (test) void testVoicePronunciationRule(test.dataset.voicePronunciationTest, test);
    if (remove) void deleteVoicePronunciationRule(remove.dataset.voicePronunciationDelete, remove);
  });
  memoryForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    void createMemoryRecord();
  });
  memorySearch?.addEventListener('input', () => renderMemoryRecords());
  memoryCategoryFilter?.addEventListener('change', () => renderMemoryRecords());
  memoryComposeToggle?.addEventListener('click', () => {
    setMemoryComposerOpen(memoryComposeToggle.getAttribute('aria-expanded') !== 'true');
  });
  memoryComposeClose?.addEventListener('click', () => setMemoryComposerOpen(false));
  memoryCrossChat?.addEventListener('change', () => void setCrossChatMemory(memoryCrossChat));
  memoryList?.addEventListener('click', (event) => {
    const saveButton = event.target.closest('[data-memory-save]');
    const deleteButton = event.target.closest('[data-memory-delete]');
    const retryButton = event.target.closest('[data-memory-retry]');
    if (saveButton) void updateMemoryRecord(saveButton.dataset.memorySave, saveButton);
    if (deleteButton) void deleteMemoryRecord(deleteButton.dataset.memoryDelete, deleteButton);
    if (retryButton) void loadMemorySettings();
  });
  memoryDerivedList?.addEventListener('click', (event) => {
    const forgetEpisode = event.target.closest('[data-memory-derived-forget-episode]');
    const forgetCapsule = event.target.closest('[data-memory-derived-forget-capsule]');
    const retryButton = event.target.closest('[data-memory-derived-retry]');
    if (forgetEpisode) void forgetDerivedMemoryEpisode(forgetEpisode.dataset.memoryDerivedForgetEpisode, forgetEpisode);
    if (forgetCapsule) void forgetDerivedMemoryCapsule(forgetCapsule.dataset.memoryDerivedForgetCapsule, forgetCapsule);
    if (retryButton) void loadDerivedMemory();
  });
  memoryDerivedForgetAll?.addEventListener('click', () => void forgetAllDerivedMemory());
  createCodeButton?.addEventListener('click', () => void rotateTelegramCode());
  copyCodeButton?.addEventListener('click', () => void copyTelegramCode());
  refreshTelegramButton?.addEventListener('click', () => void loadTelegramSettings());
  toggleTelegramConnectionButton?.addEventListener('click', () => void toggleTelegramConnection());
  toggleTelegramRemoteButton?.addEventListener('click', () => void toggleTelegramRemote());
  revokeTelegramButton?.addEventListener('click', () => void revokeTelegramPairings());
  safeSettingsButton?.addEventListener('click', () => void openSafeSecuritySettings());
  safeShortcutButton?.addEventListener('click', () => void toggleSafeShortcut());
  safeOpenButton?.addEventListener('click', () => void openSafeNow());
  refreshSkillsButton?.addEventListener('click', () => void loadSkillSettings(true));
  skillsOpenChatPicker?.addEventListener('click', () => openSkillPickerFromSettings());
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
  skillCreateToggle?.addEventListener('click', () => {
    setSkillAuthoringOpen(skillCreateToggle.getAttribute('aria-expanded') !== 'true');
  });
  skillAuthoringClose?.addEventListener('click', () => setSkillAuthoringOpen(false));
  skillAuthoringForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    void generateAutoSkillDraft();
  });
  skillEditor?.addEventListener('input', () => invalidateSkillDraftValidation());
  skillEditor?.addEventListener('change', () => invalidateSkillDraftValidation());
  document.querySelector('#skill-scope')?.addEventListener('change', () => {
    if (!skillEditor?.hidden) invalidateSkillDraftValidation();
  });
  skillValidateButton?.addEventListener('click', () => void validateCurrentSkillDraft());
  skillPublishButton?.addEventListener('click', () => void publishCurrentSkillDraft());

  renderOscarVoiceForm(readOscarVoicePreferences());
  renderOscarVoiceDocument(voiceSettingsDocument);
  renderVoiceRuntimeCapabilities(readVoiceRuntimeCapabilities());
  void loadVoiceSettings();
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
    activePresetId: activeVoicePresetId,
  });
}

function renderOscarVoiceForm(preferences) {
  const normalized = normalizeOscarVoicePreferences(preferences);
  activeVoicePresetId = normalized.activePresetId;
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
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
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

function renderOscarVoiceDocument(value) {
  voiceSettingsDocument = normalizeVoicePreferencesDocument(value);
  renderOscarVoiceForm(voiceSettingsDocument.preferences);
  const autoSend = document.querySelector('#voice-input-auto-send');
  if (autoSend) autoSend.checked = voiceSettingsDocument.input.autoSendAfterDictation === true;
  const simplifiedMode = document.querySelector('#voice-simplified-mode');
  if (simplifiedMode) simplifiedMode.checked = voiceSettingsDocument.input.simplifiedModeEnabled !== false;
  const backgroundWake = document.querySelector('#voice-background-wake');
  if (backgroundWake) backgroundWake.checked = voiceSettingsDocument.input.backgroundWakeEnabled !== false;
  const providers = document.querySelector('#voice-information-providers');
  if (providers) {
    providers.checked = voiceSettingsDocument.input.informationProvidersEnabled === true
      && voiceSettingsDocument.input.informationProviderAgreementVersion === VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION;
    providers.dataset.agreementVersion = providers.checked ? VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION : '';
    providers.dataset.consentedAt = providers.checked
      ? voiceSettingsDocument.input.informationProviderConsentedAt || ''
      : '';
  }
  setValue('#voice-weather-location-mode', voiceSettingsDocument.input.weatherLocationMode === 'device' ? 'device' : 'manual');
  setValue('#voice-weather-location', voiceSettingsDocument.input.weatherLocation || '');
  syncVoiceInformationProviderControls();
  renderOscarVoicePresets();
  renderVoicePronunciations();
}

function renderOscarVoicePresets() {
  const list = document.querySelector('#oscar-voice-custom-presets');
  if (!list) return;
  list.replaceChildren();
  if (!voiceSettingsDocument.presets.length) {
    const empty = document.createElement('span');
    empty.className = 'voice-empty-copy';
    empty.textContent = 'Пока нет своих пресетов';
    list.append(empty);
    return;
  }
  voiceSettingsDocument.presets.forEach((preset) => {
    const item = document.createElement('span');
    item.className = `voice-custom-preset${activeVoicePresetId === preset.id ? ' is-selected' : ''}`;
    const select = document.createElement('button');
    select.type = 'button';
    select.dataset.voiceCustomSelect = preset.id;
    select.textContent = preset.name;
    select.title = `Применить пресет «${preset.name}»`;
    const update = document.createElement('button');
    update.type = 'button';
    update.dataset.voiceCustomUpdate = preset.id;
    update.textContent = '↻';
    update.title = 'Обновить текущими параметрами';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.voiceCustomDelete = preset.id;
    remove.textContent = '×';
    remove.title = 'Удалить пресет';
    item.append(select, update, remove);
    list.append(item);
  });
}

function renderVoicePronunciations() {
  const list = document.querySelector('#voice-pronunciation-list');
  if (!list) return;
  const pronunciationAvailable = isVoicePronunciationControlAvailable(readVoiceRuntimeCapabilities());
  list.replaceChildren();
  if (!voiceSettingsDocument.pronunciations.length) {
    const empty = document.createElement('span');
    empty.className = 'voice-empty-copy';
    empty.textContent = 'Пользовательских правил пока нет';
    list.append(empty);
    return;
  }
  voiceSettingsDocument.pronunciations.forEach((rule) => {
    const item = document.createElement('div');
    item.className = 'voice-pronunciation-rule';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = rule.enabled !== false;
    toggle.dataset.voicePronunciationToggle = rule.id;
    toggle.setAttribute('aria-label', `Использовать произношение ${rule.word}`);
    toggle.disabled = !pronunciationAvailable;
    if (!pronunciationAvailable) toggle.title = 'Этот голос пока не умеет ставить ударения по правилам';
    const copy = document.createElement('span');
    copy.className = 'voice-pronunciation-copy';
    const title = document.createElement('strong');
    title.textContent = `${rule.word} → ${rule.pronunciation}`;
    const context = document.createElement('span');
    context.textContent = rule.context || 'В любых фразах';
    copy.append(title, context);
    const actions = document.createElement('span');
    actions.className = 'voice-pronunciation-actions';
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'claude-ghost-btn';
    test.dataset.voicePronunciationTest = rule.id;
    test.textContent = 'Тест';
    test.disabled = !pronunciationAvailable;
    if (!pronunciationAvailable) test.title = 'Проверка заработает, когда голос будет поддерживать ударения';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'claude-ghost-btn';
    remove.dataset.voicePronunciationDelete = rule.id;
    remove.textContent = 'Удалить';
    actions.append(test, remove);
    item.append(toggle, copy, actions);
    list.append(item);
  });
}

function renderVoiceRuntimeCapabilities(value) {
  const capabilities = applyVoiceRuntimeCapabilities(value);
  const strip = document.querySelector('#oscar-voice-runtime');
  if (strip) {
    // One plain line about what the person will hear, not a list of engine features.
    const badge = document.createElement('span');
    const neural = capabilities.neuralInstalled === true;
    badge.textContent = neural
      ? 'Нейросетевой голос готов'
      : 'Сейчас Оскар говорит голосом Windows — нейросетевой голос на этом компьютере не установлен';
    badge.className = neural ? 'is-ready' : 'is-unavailable';
    strip.replaceChildren(badge);
  }
  renderVoiceRecognitionState();
  const controls = capabilities.controls;
  const supported = {
    speed: controls.speed === 'dsp',
    pitch: controls.pitch === 'dsp',
    expressiveness: controls.expressiveness === 'generation-parameters',
    pauseMs: controls.pause === 'audio-pipeline',
    volume: controls.volume !== 'unavailable',
  };
  Object.entries(supported).forEach(([name, available]) => {
    const input = document.querySelector(`[data-voice-slider="${name}"]`);
    if (input?.closest('.voice-slider')) input.closest('.voice-slider').hidden = !available;
  });
  const style = document.querySelector('.voice-style-field');
  if (style) style.hidden = !supported.expressiveness;
  const instructionField = document.querySelector('#oscar-voice-instruction-field');
  const instructionNote = document.querySelector('#oscar-voice-instruction-note');
  const instructionAvailable = controls.freeFormInstruction === true;
  if (instructionField) instructionField.hidden = !instructionAvailable;
  if (instructionNote) instructionNote.hidden = instructionAvailable;
  renderVoicePronunciationAvailability(capabilities);
  renderVoicePronunciations();
}

/** Dictation and Voice need the «Распознавание речи» download; offer it right here. */
export function renderVoiceRecognitionState() {
  const host = document.querySelector('#voice-recognition-state');
  if (!host) return;
  const extra = (state.data?.components?.extras || []).find((entry) => entry.role === 'voice-recognition');
  if (!extra) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const active = ['checking', 'downloading', 'verifying'].includes(extra.phase);
  const percent = Math.round(Math.max(0, Math.min(1, Number(extra.progress) || 0)) * 100);
  host.dataset.ready = String(extra.installed === true);
  host.innerHTML = extra.installed
    ? '<strong>Распознавание речи готово</strong><small>Оскар понимает голос без интернета.</small>'
    : active
      ? `<strong>Скачиваю распознавание речи · ${percent}%</strong><small>Можно продолжать пользоваться Monarch.</small>`
      : `<span><strong>Распознавание речи не скачано</strong><small>Без него не работают диктовка и голосовой режим.</small></span><button type="button" class="claude-primary-btn" data-model-install="voice-recognition">Скачать</button>`;
}

function renderVoicePronunciationAvailability(capabilities) {
  const available = isVoicePronunciationControlAvailable(capabilities);
  const qwenIncompatible = capabilities.pronunciationDiagnostic === 'qwen-base-stress-markup-unsupported';
  const section = document.querySelector('.voice-pronunciation');
  if (section) section.dataset.pronunciationControl = available ? 'available' : 'unavailable';
  setText('#voice-stress-status', available ? 'Работает' : 'Пока недоступно');
  setText('#voice-pronunciation-support', available
    ? 'Эти правила меняют только произношение. Текст в чате останется прежним.'
    : qwenIncompatible
      ? 'Этот голос пока не умеет ставить ударения по правилам. Сохранённые правила не пропадут и заработают, когда голос это поддержит.'
      : 'Ударения для этого голоса пока недоступны.');
  ['#voice-pronunciation-word', '#voice-pronunciation-value', '#voice-pronunciation-context', '#voice-pronunciation-add']
    .forEach((selector) => {
      const control = document.querySelector(selector);
      if (!control) return;
      control.disabled = !available;
      control.title = available ? '' : 'Недоступно для Qwen3-TTS 0.6B Base';
    });
}

function adoptVoiceSettingsContext(context, render = true) {
  const snapshot = applyVoiceSettingsSnapshot(context);
  voiceSettingsRevision = snapshot.revision;
  voiceSettingsDocument = snapshot.value;
  voiceSettingsLoaded = true;
  if (render) renderOscarVoiceDocument(voiceSettingsDocument);
  return snapshot;
}

function scheduleOscarVoiceAutosave(message = 'Сохраняю…') {
  voiceMutationVersion += 1;
  clearTimeout(voiceSaveTimer);
  setStatus(document.querySelector('#oscar-voice-save-state'), message);
  voiceSaveTimer = setTimeout(() => { void persistOscarVoiceSettings(); }, 400);
}

async function flushOscarVoiceAutosave(force = false) {
  clearTimeout(voiceSaveTimer);
  voiceSaveTimer = undefined;
  if (!voiceSettingsLoaded) {
    await loadVoiceSettings();
    if (!voiceSettingsLoaded) return null;
  }
  if (force && voiceMutationVersion <= voiceSavedVersion) voiceMutationVersion += 1;
  return persistOscarVoiceSettings();
}

async function retryOscarVoiceAutosave() {
  clearTimeout(voiceSaveTimer);
  voiceSaveTimer = undefined;
  const status = document.querySelector('#oscar-voice-save-state');
  const retry = document.querySelector('#oscar-voice-retry');
  const preferences = readOscarVoiceForm();
  const input = readVoiceInputForm();
  setStatus(status, 'Проверяю сохранение…');
  try {
    const context = await readLocalSettings('voice');
    const current = normalizeVoicePreferencesDocument(context?.value);
    adoptVoiceSettingsContext(context, false);
    if (JSON.stringify(current.preferences) === JSON.stringify(preferences)
      && JSON.stringify(current.input) === JSON.stringify(input)) {
      renderOscarVoiceDocument(current);
      voiceSavedVersion = voiceMutationVersion;
      if (retry) retry.hidden = true;
      setStatus(status, 'Сохранено');
      return readVoiceSettingsSnapshot();
    }
  } catch {
    // The regular save path below keeps the truthful error state if recovery
    // cannot refresh the current durable revision.
    if (!voiceSettingsLoaded) {
      await loadVoiceSettings();
      if (!voiceSettingsLoaded) return null;
      renderOscarVoiceForm(preferences);
      const autoSend = document.querySelector('#voice-input-auto-send');
      if (autoSend) autoSend.checked = input.autoSendAfterDictation;
      const simplifiedMode = document.querySelector('#voice-simplified-mode');
      if (simplifiedMode) simplifiedMode.checked = input.simplifiedModeEnabled;
      const backgroundWake = document.querySelector('#voice-background-wake');
      if (backgroundWake) backgroundWake.checked = input.backgroundWakeEnabled;
    }
  }
  voiceMutationVersion += 1;
  return persistOscarVoiceSettings();
}

async function persistOscarVoiceSettings() {
  const requestedVersion = voiceMutationVersion;
  if (!voiceSettingsLoaded || requestedVersion <= voiceSavedVersion) return readVoiceSettingsSnapshot();
  const preferences = readOscarVoiceForm();
  const input = readVoiceInputForm();
  const status = document.querySelector('#oscar-voice-save-state');
  const retry = document.querySelector('#oscar-voice-retry');
  voiceSaveQueue = voiceSaveQueue.catch(() => undefined).then(async () => {
    if (requestedVersion <= voiceSavedVersion) return readVoiceSettingsSnapshot();
    setStatus(status, 'Сохраняю…');
    try {
      const saved = await writeLocalSettings('voice.update', { patch: { preferences, input } }, {
        expectedRevision: voiceSettingsRevision,
      });
      adoptVoiceSettingsContext(saved.context, voiceMutationVersion === requestedVersion);
      voiceSavedVersion = requestedVersion;
      if (retry) retry.hidden = true;
      setStatus(status, voiceMutationVersion === requestedVersion ? 'Сохранено' : 'Сохраняю новые изменения…');
      return readVoiceSettingsSnapshot();
    } catch (error) {
      if (retry) retry.hidden = false;
      setStatus(status, `Не сохранено · ${readErrorMessage(error)}`, true);
      return null;
    }
  });
  return voiceSaveQueue;
}

function readVoiceInputForm() {
  const providers = document.querySelector('#voice-information-providers');
  const providersEnabled = providers?.checked === true;
  return {
    schemaVersion: 1,
    autoSendAfterDictation: document.querySelector('#voice-input-auto-send')?.checked === true,
    simplifiedModeEnabled: document.querySelector('#voice-simplified-mode')?.checked !== false,
    backgroundWakeEnabled: document.querySelector('#voice-background-wake')?.checked !== false,
    informationProvidersEnabled: providersEnabled,
    informationProviderAgreementVersion: providersEnabled
      ? providers?.dataset.agreementVersion || VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION
      : null,
    informationProviderConsentedAt: providersEnabled ? providers?.dataset.consentedAt || null : null,
    weatherLocationMode: document.querySelector('#voice-weather-location-mode')?.value === 'device' ? 'device' : 'manual',
    weatherLocation: String(document.querySelector('#voice-weather-location')?.value || '').trim().slice(0, 100),
  };
}

function syncVoiceInformationProviderControls() {
  const enabled = document.querySelector('#voice-information-providers')?.checked === true;
  const mode = document.querySelector('#voice-weather-location-mode');
  const manual = document.querySelector('#voice-weather-location-field');
  const disclosure = document.querySelector('#voice-information-provider-state');
  if (mode) mode.disabled = !enabled;
  if (manual) manual.hidden = !enabled || mode?.value === 'device';
  if (disclosure) disclosure.textContent = enabled
    ? `Разрешено · соглашение ${VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION}`
    : 'Сеть выключена · команды устройств остаются локальными';
}

async function testOscarVoice(options = {}) {
  const button = options.button || document.querySelector('#oscar-voice-test');
  const status = document.querySelector('#oscar-voice-save-state');
  await flushOscarVoiceAutosave();
  const preferences = { ...readOscarVoiceForm(), ...(options.voice ? { voice: options.voice } : {}) };
  const visual = document.querySelector('#oscar-voice-visual');
  if (typeof window.monarchDesktop?.speakText !== 'function') {
    setStatus(status, 'Проверка голоса доступна в Monarch Desktop', true);
    return;
  }
  const buttonLabel = button?.textContent || 'Проверить';
  setBusy(button, true, 'Озвучиваю…');
  setStatus(status, 'Проверка');
  visual?.classList.add('is-previewing');
  try {
    await window.monarchDesktop.stopSpeaking?.();
    const result = await window.monarchDesktop.speakText({
      text: 'Привет. Это выбранный голос Оскара. Я готов отвечать естественно, быстро и по делу.',
      language: 'ru-RU',
      ...preferences,
      pronunciations: options.pronunciations || voiceSettingsDocument.pronunciations,
      ...(options.text ? { text: options.text } : {}),
    });
    if (result?.ok === false) throw new Error(result.summary || result.error);
    setStatus(status, 'Голос готов');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
  } finally {
    visual?.classList.remove('is-previewing');
    setBusy(button, false, buttonLabel);
  }
}

async function stopOscarVoicePreview() {
  const status = document.querySelector('#oscar-voice-save-state');
  await window.monarchDesktop?.stopSpeaking?.();
  document.querySelector('#oscar-voice-visual')?.classList.remove('is-previewing');
  setStatus(status, 'Озвучка остановлена');
}

function selectCustomOscarVoicePreset(id) {
  const preset = voiceSettingsDocument.presets.find((entry) => entry.id === id);
  if (!preset) return;
  activeVoicePresetId = preset.id;
  renderOscarVoiceForm({ ...preset.preferences, activePresetId: preset.id });
  renderOscarVoicePresets();
  pulseOscarVoiceVisualizer();
  scheduleOscarVoiceAutosave('Применяю пресет…');
}

async function createOscarVoicePreset() {
  const button = document.querySelector('#oscar-voice-save-preset');
  const status = document.querySelector('#oscar-voice-save-state');
  const name = readValue('#oscar-voice-preset-name');
  if (!name) {
    setStatus(status, 'Укажи название пресета', true);
    return;
  }
  setBusy(button, true, 'Сохраняю…');
  try {
    await flushOscarVoiceAutosave();
    const saved = await writeLocalSettings('voice.preset.create', { name, preferences: readOscarVoiceForm() }, {
      expectedRevision: voiceSettingsRevision,
    });
    adoptVoiceSettingsContext(saved.context, true);
    voiceSavedVersion = voiceMutationVersion;
    setValue('#oscar-voice-preset-name', '');
    setStatus(status, 'Пресет сохранён');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Сохранить текущий голос');
  }
}

async function updateOscarVoicePreset(id, button) {
  const status = document.querySelector('#oscar-voice-save-state');
  setBusy(button, true, '…');
  try {
    await flushOscarVoiceAutosave();
    const saved = await writeLocalSettings('voice.preset.update', { id, patch: { preferences: readOscarVoiceForm() } }, {
      expectedRevision: voiceSettingsRevision,
    });
    adoptVoiceSettingsContext(saved.context, true);
    setStatus(status, 'Пресет обновлён');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
  } finally {
    setBusy(button, false, '↻');
  }
}

async function deleteOscarVoicePreset(id, button) {
  const status = document.querySelector('#oscar-voice-save-state');
  setBusy(button, true, '…');
  try {
    await flushOscarVoiceAutosave();
    const saved = await writeLocalSettings('voice.preset.delete', { id }, { expectedRevision: voiceSettingsRevision });
    adoptVoiceSettingsContext(saved.context, true);
    setStatus(status, 'Пресет удалён');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
    setBusy(button, false, '×');
  }
}

async function createVoicePronunciationRule() {
  const button = document.querySelector('#voice-pronunciation-add');
  const status = document.querySelector('#oscar-voice-save-state');
  if (!isVoicePronunciationControlAvailable(readVoiceRuntimeCapabilities())) {
    setStatus(status, 'Qwen Base не поддерживает проверенную разметку ударений', true);
    return;
  }
  const payload = {
    word: readValue('#voice-pronunciation-word'),
    pronunciation: readValue('#voice-pronunciation-value'),
    context: readValue('#voice-pronunciation-context'),
    enabled: true,
  };
  if (!payload.word || !payload.pronunciation) {
    setStatus(status, 'Укажи слово и ударение', true);
    return;
  }
  setBusy(button, true, 'Добавляю…');
  try {
    await flushOscarVoiceAutosave();
    const saved = await writeLocalSettings('voice.pronunciation.create', payload, { expectedRevision: voiceSettingsRevision });
    adoptVoiceSettingsContext(saved.context, true);
    setValue('#voice-pronunciation-word', '');
    setValue('#voice-pronunciation-value', '');
    setValue('#voice-pronunciation-context', '');
    setStatus(status, 'Произношение сохранено');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Добавить');
  }
}

async function updateVoicePronunciationRule(id, patch, control) {
  const status = document.querySelector('#oscar-voice-save-state');
  if (!isVoicePronunciationControlAvailable(readVoiceRuntimeCapabilities())) {
    setStatus(status, 'Правило сохранено, но недоступно для текущего Qwen Base', true);
    return;
  }
  if (control) control.disabled = true;
  try {
    await flushOscarVoiceAutosave();
    const saved = await writeLocalSettings('voice.pronunciation.update', { id, patch }, { expectedRevision: voiceSettingsRevision });
    adoptVoiceSettingsContext(saved.context, true);
    setStatus(status, 'Произношение обновлено');
  } catch (error) {
    if (control?.type === 'checkbox') control.checked = !control.checked;
    setStatus(status, readErrorMessage(error), true);
  } finally {
    if (control) control.disabled = false;
  }
}

async function deleteVoicePronunciationRule(id, button) {
  const status = document.querySelector('#oscar-voice-save-state');
  setBusy(button, true, '…');
  try {
    await flushOscarVoiceAutosave();
    const saved = await writeLocalSettings('voice.pronunciation.delete', { id }, { expectedRevision: voiceSettingsRevision });
    adoptVoiceSettingsContext(saved.context, true);
    setStatus(status, 'Правило удалено');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
    setBusy(button, false, 'Удалить');
  }
}

async function testVoicePronunciationRule(id, button) {
  if (!isVoicePronunciationControlAvailable(readVoiceRuntimeCapabilities())) {
    setStatus(document.querySelector('#oscar-voice-save-state'), 'Qwen Base не поддерживает проверенную разметку ударений', true);
    return;
  }
  const rule = voiceSettingsDocument.pronunciations.find((entry) => entry.id === id);
  if (!rule) return;
  await testOscarVoice({
    button,
    text: rule.context || `Проверяю произношение слова ${rule.word}.`,
    pronunciations: [{ ...rule, enabled: true }],
  });
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
      skillUserFacingName(skill),
      skillUserFacingDescription(skill),
      skill.provider,
      skill.scope,
    ].some((value) => String(value || '').toLocaleLowerCase('ru').includes(needle)))
    .sort((left, right) => (
      skillScopeRank(right.scope) - skillScopeRank(left.scope)
      || skillUserFacingName(left).localeCompare(skillUserFacingName(right), 'ru')
    ))
    .slice(0, Math.max(1, limit));
}

export function normalizeSettingsTab(value) {
  const tab = String(value || '').trim().toLowerCase();
  // 'general' was the old combined «Личность и голос» tab.
  if (tab === 'general' || tab === 'personality') return 'style';
  return SETTINGS_TABS.has(tab) ? tab : 'models';
}

export function selectSettingsTab(value, load = true) {
  currentSettingsTab = normalizeSettingsTab(value);
  if (currentSettingsTab === 'dev' && !isVerifiedOwner()) currentSettingsTab = 'models';
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
    if (active && panel.tagName === 'DETAILS' && !panel.hasAttribute('data-default-collapsed')) {
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
  window.dispatchEvent(new CustomEvent('monarch:settings-selection', { detail: { tab: currentSettingsTab } }));
}

function setMemoryComposerOpen(open) {
  const panel = document.querySelector('#memory-compose-panel');
  const toggle = document.querySelector('#memory-compose-toggle');
  if (!panel || !toggle) return;
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? 'Скрыть форму' : 'Новая запись';
  if (open) window.setTimeout(() => document.querySelector('#memory-create-text')?.focus(), 0);
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
    if (tab === 'style') await loadPersonalitySettings();
    else if (tab === 'voice') await loadVoiceSettings();
    else if (tab === 'memory') await Promise.all([loadMemorySettings(), loadDerivedMemory()]);
    else if (tab === 'skills') await loadSkillSettings();
    else if (tab === 'telegram') await loadTelegramSettings();
    else if (tab === 'safe') await loadSafeSettings();
    else if (tab === 'images') await loadImageSettings();
    else if (tab === 'models') {
      const { renderModelManager } = await import('./model-manager.js');
      renderModelManager();
    }
    else if (tab === 'system') await loadOwnerEnrollment();
    else if (tab === 'dev' && isVerifiedOwner()) await loadOwnerDevSettings();
  } catch {
    loadedSettingsTabs.delete(tab);
  }
}

function isVerifiedOwner() {
  const authority = state.data?.authority;
  return authority?.tier === 'owner' && authority?.source === 'signed-device-entitlement';
}

function syncOwnerDevVisibility() {
  const owner = isVerifiedOwner();
  document.querySelectorAll('[data-owner-dev]').forEach((element) => {
    if (element.matches('[data-settings-tab]')) element.hidden = !owner;
    else if (!owner) element.hidden = true;
  });
  if (!owner && currentSettingsTab === 'dev') {
    loadedSettingsTabs.delete('dev');
    selectSettingsTab('models', false);
    return;
  }
  selectSettingsTab(currentSettingsTab, false);
}

async function loadOwnerDevSettings() {
  const status = document.querySelector('#owner-dev-state');
  setStatus(status, 'Загрузка');
  try {
    const devContext = await readLocalSettings('dev');
    ownerDevRevision = Number(devContext?.revision) || 0;
    renderOwnerDevSettings(devContext?.value);
    if (state.data) state.data.ownerDev = devContext?.value;
    try {
      const promptContext = await readLocalSettings('prompts');
      ownerPromptRevision = Number(promptContext?.revision) || 0;
      renderOwnerPrompts(promptContext?.value?.prompts);
      setStatus(status, 'Сохранено');
    } catch (error) {
      renderOwnerPrompts([]);
      setStatus(status, `Политики активны · prompts недоступны: ${readErrorMessage(error)}`, true);
    }
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
    throw error;
  }
}

function renderOwnerDevSettings(value) {
  document.querySelectorAll('[data-dev-setting]').forEach((input) => {
    const key = input.dataset.devSetting;
    input.checked = value?.[key] === true;
  });
  const zeroCard = document.querySelector('.dev-zero-retention-card');
  zeroCard?.classList.toggle('active', value?.zeroRetentionEnabled === true);
  const diagnostic = document.querySelector('#owner-dev-diagnostic');
  if (diagnostic) {
    diagnostic.textContent = value?.diagnostic
      ? `Fail-closed: ${value.diagnostic}`
      : value?.zeroRetentionEnabled
        ? 'Новые чаты: только volatile RAM. После завершения сессии содержимое исчезает.'
        : 'Стандартное локальное хранение новых persistent-чатов включено.';
  }
}

async function disableOwnerMode(button) {
  if (typeof window.monarchDesktop?.disableOwnerMode !== 'function') {
    setStatus(document.querySelector('#owner-dev-state'), 'Доступно только в Monarch Desktop', true);
    return;
  }
  button.disabled = true;
  button.textContent = 'Переключаю…';
  setStatus(document.querySelector('#owner-dev-state'), 'Перезапускаю в Public…');
  const result = await window.monarchDesktop.disableOwnerMode().catch(() => null);
  if (!result?.ok) {
    button.disabled = false;
    button.textContent = 'Перейти в Public';
    setStatus(document.querySelector('#owner-dev-state'), 'Не удалось перейти в Public', true);
  }
}

async function saveOwnerDevSetting(input) {
  const key = String(input?.dataset?.devSetting || '');
  if (!key) return;
  if (key === 'zeroRetentionEnabled' && input.checked && state.oscar?.busy) {
    input.checked = false;
    setStatus(document.querySelector('#owner-dev-state'), 'Сначала останови текущий ответ', true);
    return;
  }
  input.disabled = true;
  const status = document.querySelector('#owner-dev-state');
  setStatus(status, 'Применяю…');
  try {
    const saved = await writeLocalSettings('dev.update', { patch: { [key]: input.checked } }, {
      expectedRevision: ownerDevRevision,
    });
    ownerDevRevision = Number(saved.context?.revision) || ownerDevRevision;
    renderOwnerDevSettings(saved.context?.value);
    if (state.data) state.data.ownerDev = saved.context?.value;
    window.dispatchEvent(new CustomEvent('monarch:owner-dev-changed', { detail: saved.context?.value }));
    setStatus(status, 'Сохранено');
  } catch (error) {
    loadedSettingsTabs.delete('dev');
    setStatus(status, readErrorMessage(error), true);
    await loadOwnerDevSettings().catch(() => undefined);
  } finally {
    input.disabled = false;
  }
}

async function resetOwnerDevSettings() {
  const button = document.querySelector('#owner-dev-reset');
  const status = document.querySelector('#owner-dev-state');
  if (button) button.disabled = true;
  setStatus(status, 'Сбрасываю…');
  try {
    const saved = await writeLocalSettings('dev.reset', {}, { expectedRevision: ownerDevRevision });
    ownerDevRevision = Number(saved.context?.revision) || ownerDevRevision;
    renderOwnerDevSettings(saved.context?.value);
    if (state.data) state.data.ownerDev = saved.context?.value;
    window.dispatchEvent(new CustomEvent('monarch:owner-dev-changed', { detail: saved.context?.value }));
    setStatus(status, 'Стандартные политики восстановлены');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderOwnerPrompts(prompts) {
  const list = document.querySelector('#owner-prompt-list');
  if (!list) return;
  list.replaceChildren();
  const records = Array.isArray(prompts) ? prompts : [];
  records.forEach((prompt) => list.append(createOwnerPromptCard(prompt)));
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'voice-empty-copy';
    empty.textContent = 'Prompt catalog недоступен.';
    list.append(empty);
  }
}

function createOwnerPromptCard(prompt) {
  const card = document.createElement('article');
  card.className = 'dev-prompt-card';
  card.dataset.overridden = String(prompt?.overridden === true);
  const heading = document.createElement('div');
  heading.className = 'dev-prompt-card-heading';
  const identity = document.createElement('div');
  const lane = document.createElement('span');
  lane.textContent = `${prompt?.lane || 'prompt'} · ${prompt?.language || 'auto'}`;
  const title = document.createElement('strong');
  title.textContent = prompt?.title || prompt?.id || 'Oscar prompt';
  const description = document.createElement('small');
  description.textContent = prompt?.description || '';
  identity.append(lane, title, description);
  const badge = document.createElement('b');
  badge.textContent = prompt?.overridden ? 'Override' : `Default v${prompt?.defaultVersion || '1'}`;
  heading.append(identity, badge);
  const textarea = document.createElement('textarea');
  textarea.value = String(prompt?.content || '');
  textarea.maxLength = Math.max(1, Number(prompt?.maxCharacters) || 20_000);
  textarea.rows = prompt?.lane === 'chat' ? 16 : 8;
  textarea.spellcheck = false;
  textarea.dataset.ownerPromptContent = String(prompt?.id || '');
  textarea.setAttribute('aria-label', `Prompt ${prompt?.title || prompt?.id || ''}`);
  const actions = document.createElement('div');
  actions.className = 'dev-prompt-actions';
  const hash = document.createElement('code');
  hash.textContent = String(prompt?.contentHash || '').slice(0, 12);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'claude-ghost-btn';
  reset.dataset.ownerPromptReset = String(prompt?.id || '');
  reset.textContent = 'К стандартному';
  reset.disabled = prompt?.overridden !== true;
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'claude-primary-btn';
  save.dataset.ownerPromptSave = String(prompt?.id || '');
  save.textContent = 'Применить';
  actions.append(hash, reset, save);
  const defaults = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Показать стандартный prompt';
  const pre = document.createElement('pre');
  pre.textContent = String(prompt?.defaultContent || '');
  defaults.append(summary, pre);
  card.append(heading, textarea, actions, defaults);
  return card;
}

async function saveOwnerPrompt(promptId, button) {
  const textarea = [...document.querySelectorAll('[data-owner-prompt-content]')]
    .find((field) => field.dataset.ownerPromptContent === promptId);
  if (!textarea || !String(textarea.value || '').trim()) return;
  button.disabled = true;
  const status = document.querySelector('#owner-dev-state');
  setStatus(status, 'Применяю prompt…');
  try {
    const saved = await writeLocalSettings('prompts.update', {
      promptId,
      content: textarea.value,
    }, { expectedRevision: ownerPromptRevision });
    ownerPromptRevision = Number(saved.context?.revision) || ownerPromptRevision;
    renderOwnerPrompts(saved.context?.value?.prompts);
    setStatus(status, 'Prompt применён');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
  } finally {
    button.disabled = false;
  }
}

async function resetOwnerPrompt(promptId, button) {
  button.disabled = true;
  const status = document.querySelector('#owner-dev-state');
  setStatus(status, 'Восстанавливаю default…');
  try {
    const saved = await writeLocalSettings('prompts.reset', { promptId }, {
      expectedRevision: ownerPromptRevision,
    });
    ownerPromptRevision = Number(saved.context?.revision) || ownerPromptRevision;
    renderOwnerPrompts(saved.context?.value?.prompts);
    setStatus(status, 'Стандартный prompt восстановлен');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
  } finally {
    button.disabled = false;
  }
}

async function resetAllOwnerPrompts() {
  const button = document.querySelector('#owner-prompts-reset-all');
  const status = document.querySelector('#owner-dev-state');
  if (button) button.disabled = true;
  setStatus(status, 'Восстанавливаю prompts…');
  try {
    const saved = await writeLocalSettings('prompts.reset-all', {}, {
      expectedRevision: ownerPromptRevision,
    });
    ownerPromptRevision = Number(saved.context?.revision) || ownerPromptRevision;
    renderOwnerPrompts(saved.context?.value?.prompts);
    setStatus(status, 'Все prompts сброшены');
  } catch (error) {
    setStatus(status, readErrorMessage(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadImageSettings() {
  const stateLabel = document.querySelector('#image-settings-state');
  setStatus(stateLabel, 'Загрузка');
  try {
    const context = await fetchImageGenerationContext();
    imageGenerationPolicy = context?.policy || null;
    renderImageSettingsPolicy(imageGenerationPolicy);
    setStatus(stateLabel, 'Сохранено');
  } catch (error) {
    setStatus(stateLabel, `Недоступно · ${readErrorMessage(error)}`, true);
    throw error;
  }
}

async function mutateImagePolicy(command) {
  const feedback = command.action === 'mature-mode'
    ? document.querySelector('#image-mature-feedback')
    : document.querySelector('#image-settings-state');
  setStatus(feedback, 'Сохраняю…');
  try {
    imageGenerationPolicy = await updateImageGenerationPolicy(command);
    renderImageSettingsPolicy(imageGenerationPolicy);
    setStatus(feedback, 'Сохранено');
    window.dispatchEvent(new CustomEvent('monarch:images-policy-changed', {
      detail: { policy: imageGenerationPolicy },
    }));
  } catch (error) {
    setStatus(feedback, readErrorMessage(error), true);
  }
}

async function toggleImageProviderConsent() {
  if (imageGenerationPolicy?.providerConsentCurrent === true) {
    await mutateImagePolicy({ action: 'provider-consent', enabled: false });
    return;
  }
  const feedback = document.querySelector('#image-settings-state');
  setStatus(feedback, 'Открываю соглашение…');
  try {
    const { acceptImageProviderAgreement } = await import('./image-generation-pane.js');
    const policy = await acceptImageProviderAgreement();
    if (!policy) {
      setStatus(feedback, 'Не принято · генерация заблокирована');
      return;
    }
    imageGenerationPolicy = policy;
    renderImageSettingsPolicy(policy);
    setStatus(feedback, 'Сохранено');
  } catch (error) {
    setStatus(feedback, readErrorMessage(error), true);
  }
}

function renderImageSettingsPolicy(policy) {
  if (!policy) return;
  const consentState = document.querySelector('#image-provider-consent-state');
  const consentButton = document.querySelector('#image-provider-consent-toggle');
  const matureState = document.querySelector('#image-mature-mode-state');
  const matureExpiry = document.querySelector('#image-mature-mode-expiry');
  const persistence = document.querySelector('#image-incognito-persistence');
  const attestation = document.querySelector('#image-adult-attestation');
  const active = policy.matureModeActive === true;
  if (consentState) consentState.textContent = policy.providerConsentCurrent
    ? `Принято · ${policy.providerAgreementVersion}`
    : 'Не принято · генерация недоступна';
  if (consentButton) consentButton.textContent = policy.providerConsentCurrent ? 'Отозвать' : 'Открыть соглашение';
  if (matureState) matureState.textContent = active ? 'NSFW активен' : 'PG-13';
  if (matureExpiry) {
    matureExpiry.textContent = policy.matureMode === 'persistent'
      ? 'Постоянно · можно отключить сразу'
      : policy.matureMode === 'one-hour' && active
        ? `Ещё ${Math.max(1, Math.ceil(Number(policy.matureModeRemainingMs || 0) / 60_000))} мин`
        : 'По умолчанию';
  }
  if (persistence) persistence.value = policy.incognitoPersistence || 'never';
  if (attestation) attestation.checked = active;
  document.querySelector('#image-mature-settings')?.classList.toggle('is-active', active);
}

function loadVoiceSettings() {
  if (!voiceLoadPromise) {
    voiceLoadPromise = performVoiceSettingsLoad().finally(() => { voiceLoadPromise = null; });
  }
  return voiceLoadPromise;
}

async function performVoiceSettingsLoad() {
  const status = document.querySelector('#oscar-voice-save-state');
  setStatus(status, 'Загрузка');
  try {
    const capabilities = typeof window.monarchDesktop?.getSpeechCapabilities === 'function'
      ? await window.monarchDesktop.getSpeechCapabilities()
      : readVoiceRuntimeCapabilities();
    renderVoiceRuntimeCapabilities(capabilities);
  } catch {
    renderVoiceRuntimeCapabilities(readVoiceRuntimeCapabilities());
  }
  try {
    let context = await readLocalSettings('voice');
    const legacyPreferences = Number(context?.revision || 0) === 0
      ? readLegacyOscarVoicePreferences()
      : null;
    if (legacyPreferences) {
      const migrated = await writeLocalSettings('voice.update', {
        patch: {
          preferences: legacyPreferences,
          legacyPreferences,
        },
      }, { expectedRevision: 0 });
      context = migrated.context;
    }
    adoptVoiceSettingsContext(context, true);
    voiceMutationVersion = 0;
    voiceSavedVersion = 0;
    document.querySelector('#oscar-voice-retry')?.setAttribute('hidden', '');
    setStatus(status, legacyPreferences ? 'Перенесено и сохранено' : 'Сохранено');
  } catch (error) {
    voiceSettingsLoaded = false;
    setStatus(status, `Не сохранено · ${readErrorMessage(error)}`, true);
    document.querySelector('#oscar-voice-retry')?.removeAttribute('hidden');
  }
}

async function loadSafeSettings() {
  const bridge = window.monarchDesktop;
  const badge = document.querySelector('#safe-shortcut-status');
  const button = document.querySelector('#safe-shortcut-toggle');
  const feedback = document.querySelector('#safe-settings-feedback');
  if (!bridge?.getSafeShortcutStatus) {
    if (badge) badge.textContent = 'Только в приложении';
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

async function loadPersonalitySettings() {
  const saveState = document.querySelector('#personality-save-state');
  setStatus(saveState, 'Загрузка');
  try {
    const context = await readLocalSettings('personality', { type: 'chat' });
    acceptPersonalityReadBack(context);
    setStatus(saveState, 'Сохранено');
  } catch (error) {
    personalitySettingsDocument = null;
    renderStyleSettings(null);
    setStatus(saveState, readErrorMessage(error), true);
  }
}

function initStyleSettings() {
  const root = document.querySelector('#style-settings');
  if (!root) return;
  root.addEventListener('click', (event) => {
    const option = event.target.closest?.('[data-style-dimension], [data-style-address]');
    if (!option || option.disabled) return;
    selectStyleOption(option);
    scheduleStyleSave();
  });
  root.addEventListener('keydown', (event) => {
    const option = event.target.closest?.('[role="radio"]');
    if (!option || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const options = [...option.parentElement.querySelectorAll('[role="radio"]')];
    const index = options.indexOf(option);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
        : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + options.length) % options.length;
    event.preventDefault();
    options[next].focus();
    selectStyleOption(options[next]);
    scheduleStyleSave();
  });
  document.querySelector('#personality-enabled')?.addEventListener('change', () => {
    syncStyleEnabledState();
    scheduleStyleSave(0);
  });
  document.querySelector('#personality-language')?.addEventListener('change', () => scheduleStyleSave());
  document.querySelector('#style-rules')?.addEventListener('input', () => scheduleStyleSave(900));
  document.querySelector('#personality-settings-form')?.addEventListener('submit', (event) => event.preventDefault());
  document.querySelector('#personality-preview-button')?.addEventListener('click', () => void runPersonalityPreview());
}

/** Exactly one option of a group is checked; it owns the roving tab stop. */
function selectStyleOption(option) {
  option.parentElement.querySelectorAll('[role="radio"]').forEach((candidate) => {
    const checked = candidate === option;
    candidate.setAttribute('aria-checked', String(checked));
    candidate.tabIndex = checked ? 0 : -1;
  });
}

function syncStyleEnabledState() {
  const enabled = document.querySelector('#personality-enabled')?.checked === true;
  const choices = document.querySelector('#style-choices');
  if (choices) choices.dataset.enabled = String(enabled);
  const previewButton = document.querySelector('#personality-preview-button');
  if (previewButton) previewButton.disabled = !enabled;
}

/** Turns, Coder runs and the preview read the stored style, so a short pause batches quick taps. */
function scheduleStyleSave(delay = STYLE_SAVE_DELAY_MS) {
  if (styleSaveTimer) window.clearTimeout(styleSaveTimer);
  setStatus(document.querySelector('#personality-save-state'), 'Сохраняю…');
  styleSaveTimer = window.setTimeout(() => {
    styleSaveTimer = 0;
    styleSaveQueue = styleSaveQueue.then(saveStyleSettings, saveStyleSettings);
  }, delay);
}

async function saveStyleSettings() {
  const saveState = document.querySelector('#personality-save-state');
  try {
    const saved = await writeLocalSettings('personality.style.set', readStyleSettings(), {
      scope: { type: 'chat' },
      expectedRevision: personalitySettingsRevision,
    });
    personalitySettingsRevision = Number(saved?.context?.revision) || personalitySettingsRevision;
    personalitySettingsDocument = saved?.context?.value || personalitySettingsDocument;
    setStatus(saveState, 'Сохранено');
    const output = document.querySelector('#personality-preview-output');
    if (output) output.textContent = readStyleSettings().enabled
      ? 'Стиль применится к следующему ответу. Нажми «Показать пример», чтобы проверить.'
      : 'Свой стиль выключен — Оскар отвечает в обычной манере.';
  } catch (error) {
    setStatus(saveState, readErrorMessage(error), true);
    // A revision conflict means another window changed the style: show what is stored now.
    await loadPersonalitySettings().catch(() => undefined);
  }
}

export function readStyleSettings(root = document) {
  const dimensions = {};
  Object.keys(PERSONALITY_DIMENSIONS).forEach((key) => {
    const checked = root.querySelector(`[data-style-dimension="${key}"][aria-checked="true"]`);
    dimensions[key] = clampPersonalityValue(checked?.dataset.styleValue, 50);
  });
  return {
    enabled: root.querySelector('#personality-enabled')?.checked === true,
    dimensions,
    addressForm: root.querySelector('[data-style-address][aria-checked="true"]')?.dataset.styleAddress || 'ты',
    language: root.querySelector('#personality-language')?.value || 'auto',
    customRules: splitSettingsLines(root.querySelector('#style-rules')?.value || '').slice(0, 12),
  };
}

/** Stored values from older versions (sliders 0-100) snap to the nearest of the three positions. */
export function nearestStyleLevel(value) {
  const number = clampPersonalityValue(value, 50);
  return number <= 35 ? STYLE_LEVELS[0] : number >= 65 ? STYLE_LEVELS[2] : STYLE_LEVELS[1];
}

function selectedStyleProfile(documentValue) {
  const profiles = Array.isArray(documentValue?.profiles) ? documentValue.profiles : [];
  return profiles.find((profile) => profile?.id === documentValue?.selectedProfileId) || profiles[0] || null;
}

function renderStyleSettings(value) {
  const documentValue = value && typeof value === 'object' ? value : {};
  const profile = selectedStyleProfile(documentValue) || {};
  const dimensions = profile.dimensions || documentValue.questionnaire || {};
  Object.keys(PERSONALITY_DIMENSIONS).forEach((key) => {
    const level = String(nearestStyleLevel(dimensions[key] ?? 50));
    const option = document.querySelector(`[data-style-dimension="${key}"][data-style-value="${level}"]`);
    if (option) selectStyleOption(option);
  });
  const address = document.querySelector(`[data-style-address="${profile.addressForm || 'ты'}"]`);
  if (address) selectStyleOption(address);
  setValue('#personality-language', profile.language || 'auto');
  const rules = document.querySelector('#style-rules');
  if (rules) rules.value = Array.isArray(profile.customRules) ? profile.customRules.join('\n') : '';
  const enabled = document.querySelector('#personality-enabled');
  if (enabled) enabled.checked = documentValue.enabled === true;
  syncStyleEnabledState();
  const output = document.querySelector('#personality-preview-output');
  if (output) output.textContent = documentValue.enabled === true
    ? 'Нажми «Показать пример», чтобы услышать, как Оскар ответит в этом стиле.'
    : 'Свой стиль выключен — Оскар отвечает в обычной манере.';
}

async function runPersonalityPreview() {
  const button = document.querySelector('#personality-preview-button');
  const output = document.querySelector('#personality-preview-output');
  if (styleSaveTimer) {
    window.clearTimeout(styleSaveTimer);
    styleSaveTimer = 0;
    styleSaveQueue = styleSaveQueue.then(saveStyleSettings, saveStyleSettings);
  }
  await styleSaveQueue;
  setBusy(button, true, 'Пишу пример…');
  if (output) output.textContent = 'Оскар пишет пример. Он не попадёт в историю.';
  try {
    const preview = await previewPersonality({ type: 'chat' });
    if (output) output.textContent = String(preview?.answer || 'Не удалось получить ответ.');
  } catch (error) {
    if (output) output.textContent = readErrorMessage(error);
  } finally {
    setBusy(button, false, 'Показать пример');
    syncStyleEnabledState();
  }
}

function acceptPersonalityReadBack(context) {
  personalitySettingsRevision = Number(context?.revision) || 0;
  personalitySettingsDocument = context?.value || null;
  renderStyleSettings(personalitySettingsDocument);
}

function clampPersonalityValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(Math.round(parsed), 100)) : fallback;
}

async function loadDerivedMemory() {
  const list = document.querySelector('#memory-derived-list');
  const feedback = document.querySelector('#memory-derived-feedback');
  const summary = document.querySelector('#memory-derived-summary');
  if (feedback) feedback.textContent = '';
  try {
    const result = await runCapability('oscar', 'oscar.memory.derived.manage', { action: 'list' });
    const episodes = Array.isArray(result?.output?.episodes) ? result.output.episodes : [];
    const capsules = Array.isArray(result?.output?.capsules) ? result.output.capsules : [];
    renderDerivedMemory(episodes, capsules);
    if (summary) {
      summary.textContent = episodes.length || capsules.length
        ? `Прошлых ходов: ${episodes.length}, тематических сводок: ${capsules.length}`
        : 'То, что Oscar сам сохранил из прошлых разговоров';
    }
  } catch (error) {
    if (list) {
      list.innerHTML = `
        <div class="memory-unavailable-state">
          <span><strong>Автоматическая память недоступна</strong><small>${escapeHtml(readErrorMessage(error))}</small></span>
          <button type="button" class="claude-ghost-btn" data-memory-derived-retry>Повторить</button>
        </div>
      `;
    }
  }
}

function renderDerivedMemory(episodes, capsules) {
  const list = document.querySelector('#memory-derived-list');
  const forgetAllButton = document.querySelector('#memory-derived-forget-all');
  if (!list) return;
  if (forgetAllButton) forgetAllButton.hidden = episodes.length === 0 && capsules.length === 0;
  if (episodes.length === 0 && capsules.length === 0) {
    list.innerHTML = '<div class="empty-state">Oscar пока ничего не запомнил сам из прошлых разговоров.</div>';
    return;
  }
  const capsuleItems = capsules.map((capsule) => `
    <article class="memory-item memory-derived-item" data-memory-derived-capsule="${escapeHtml(capsule.id)}">
      <p class="memory-derived-text">${escapeHtml(capsule.summary || '')}</p>
      <div class="memory-item-footer">
        <span>Тема · ${escapeHtml(capsule.topic || '')} · сводка ${capsule.childCount || 0} ходов</span>
        <button type="button" class="danger-link" data-memory-derived-forget-capsule="${escapeHtml(capsule.id)}">Забыть</button>
      </div>
    </article>
  `);
  const episodeItems = episodes.map((episode) => `
    <article class="memory-item memory-derived-item" data-memory-derived-episode="${escapeHtml(episode.id)}">
      ${renderEpisodeSummary(episode.summary)}
      <div class="memory-item-footer">
        <span>${escapeHtml(episode.title || 'Прошлый чат')} · ${formatMemoryTimestamp(episode.createdAt)}</span>
        <button type="button" class="danger-link" data-memory-derived-forget-episode="${escapeHtml(episode.id)}">Забыть</button>
      </div>
    </article>
  `);
  list.innerHTML = capsuleItems.join('') + episodeItems.join('');
}

/** Episodes are stored as "Запрос: …\nИтог: …". Show the request as the
 * line you recognise and the outcome as a short, expandable excerpt. */
export function renderEpisodeSummary(summary) {
  const text = String(summary || '');
  const match = /^Запрос:\s*([\s\S]*?)\s*Итог:\s*([\s\S]*)$/u.exec(text);
  if (!match) return `<p class="memory-derived-text">${escapeHtml(text)}</p>`;
  const [, request, outcome] = match;
  return `
      <p class="memory-derived-request"><span>Ты спросил</span><b>${escapeHtml(request)}</b></p>
      <details class="memory-derived-outcome">
        <summary><span class="memory-derived-text">${escapeHtml(outcome)}</span></summary>
      </details>`;
}

function formatMemoryTimestamp(value) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function forgetDerivedMemoryEpisode(id, button) {
  if (!await confirmAction('Забыть этот прошлый разговор?')) return;
  setBusy(button, true, 'Забываю…');
  try {
    await runCapability('oscar', 'oscar.memory.derived.manage', { action: 'forget_episode', id });
    await loadDerivedMemory();
  } catch (error) {
    const feedback = document.querySelector('#memory-derived-feedback');
    if (feedback) feedback.textContent = readErrorMessage(error);
    setBusy(button, false, 'Забыть');
  }
}

async function forgetDerivedMemoryCapsule(id, button) {
  if (!await confirmAction('Забыть эту тематическую сводку?')) return;
  setBusy(button, true, 'Забываю…');
  try {
    await runCapability('oscar', 'oscar.memory.derived.manage', { action: 'forget_capsule', id });
    await loadDerivedMemory();
  } catch (error) {
    const feedback = document.querySelector('#memory-derived-feedback');
    if (feedback) feedback.textContent = readErrorMessage(error);
    setBusy(button, false, 'Забыть');
  }
}

async function forgetAllDerivedMemory() {
  if (!await confirmAction('Забыть всё, что Oscar сам сохранил из прошлых разговоров? Явные записи из «Долговременной памяти» это не затронет.')) return;
  const button = document.querySelector('#memory-derived-forget-all');
  setBusy(button, true, 'Забываю…');
  try {
    await runCapability('oscar', 'oscar.memory.derived.manage', { action: 'forget_all' });
    await loadDerivedMemory();
  } catch (error) {
    const feedback = document.querySelector('#memory-derived-feedback');
    if (feedback) feedback.textContent = readErrorMessage(error);
  } finally {
    setBusy(button, false, 'Забыть всё автоматическое');
  }
}

async function loadMemorySettings() {
  const list = document.querySelector('#memory-settings-list');
  try {
    const context = await readLocalSettings('memory');
    memorySettingsRevision = Number(context?.revision) || 0;
    const records = Array.isArray(context?.value?.records) ? context.value.records : [];
    const crossChat = document.querySelector('#memory-cross-chat-enabled');
    if (crossChat) crossChat.checked = context?.value?.crossChatEnabled !== false;
    updateCrossChatMemoryLabel(context?.value?.crossChatEnabled !== false);
    renderMemoryRecords(records);
  } catch (error) {
    memorySettingsRecords = [];
    renderMemoryUnavailable(list, readErrorMessage(error));
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
    const saved = await writeLocalSettings('memory.create', {
      text,
      source: 'settings-ui',
      category: readValue('#memory-create-category') || 'preference',
      tier: pinned ? 'permanent' : 'long',
      importance: pinned ? 0.95 : 0.65,
      pinned,
    }, {
      expectedRevision: memorySettingsRevision,
    });
    memorySettingsRevision = saved.context.revision;
    setValue('#memory-create-text', '');
    setStatus(feedback, 'Запись добавлена');
    renderMemoryRecords(saved.context.value?.records || []);
    setMemoryComposerOpen(false);
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
    const saved = await writeLocalSettings('memory.update', {
      id,
      text: item.querySelector('[data-memory-text]')?.value || '',
      category: item.querySelector('[data-memory-category]')?.value || 'note',
      tier: pinned ? 'permanent' : 'long',
      pinned,
      importance: pinned ? 0.95 : 0.65,
    }, {
      expectedRevision: memorySettingsRevision,
    });
    memorySettingsRevision = saved.context.revision;
    renderMemoryRecords(saved.context.value?.records || []);
    setItemStatus(document.querySelector(`[data-memory-id="${CSS.escape(String(id))}"]`), 'Сохранено');
  } catch (error) {
    setItemStatus(item, readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Сохранить');
  }
}

async function deleteMemoryRecord(id, button) {
  if (!await confirmAction('Удалить эту запись из постоянной памяти?')) return;
  const item = button.closest('.memory-settings-item');
  setBusy(button, true, 'Удаляю…');
  try {
    const saved = await writeLocalSettings('memory.delete', { id }, {
      expectedRevision: memorySettingsRevision,
    });
    memorySettingsRevision = saved.context.revision;
    renderMemoryRecords(saved.context.value?.records || []);
  } catch (error) {
    setItemStatus(item, readErrorMessage(error), true);
    setBusy(button, false, 'Удалить');
  }
}

function renderMemoryRecords(records = memorySettingsRecords) {
  const list = document.querySelector('#memory-settings-list');
  if (!list) return;
  if (Array.isArray(records) && records !== memorySettingsRecords) memorySettingsRecords = records;
  const query = document.querySelector('#memory-search')?.value || '';
  const category = document.querySelector('#memory-category-filter')?.value || 'all';
  const visibleRecords = filterMemoryRecords(memorySettingsRecords, query, category);
  document.querySelector('.memory-control-center')?.setAttribute('data-memory-state', 'ready');
  list.replaceChildren();
  if (!visibleRecords.length) {
    const empty = document.createElement('div');
    empty.className = 'memory-empty-state';
    const strong = document.createElement('strong');
    strong.textContent = memorySettingsRecords.length ? 'Ничего не найдено' : 'Память пока пустая';
    const copy = document.createElement('span');
    copy.textContent = memorySettingsRecords.length
      ? 'Измени запрос или выбери другую категорию.'
      : 'Добавь факт, правило или предпочтение — Oscar подтвердит сохранение.';
    empty.append(strong, copy);
    list.append(empty);
  } else {
    visibleRecords.forEach((record) => list.append(createMemoryItem(record)));
  }
  updateMemoryCount();
  const summary = document.querySelector('#memory-library-summary');
  if (summary) summary.textContent = memorySettingsRecords.length === visibleRecords.length
    ? 'Сначала закреплённые, затем недавно изменённые'
    : `Показано ${visibleRecords.length} из ${memorySettingsRecords.length}`;
}

export function filterMemoryRecords(records, query = '', category = 'all') {
  const needle = normalizeMemorySearch(query);
  return [...(Array.isArray(records) ? records : [])]
    .filter((record) => category === 'all' || String(record?.category || 'note') === category)
    .filter((record) => !needle || normalizeMemorySearch([
      record?.text,
      record?.title,
      record?.source,
      CATEGORY_LABELS[record?.category],
    ].filter(Boolean).join(' ')).includes(needle))
    .sort((left, right) => {
      const pinnedDelta = Number(right?.pinned === true || right?.tier === 'permanent')
        - Number(left?.pinned === true || left?.tier === 'permanent');
      if (pinnedDelta) return pinnedDelta;
      return Date.parse(right?.updatedAt || right?.createdAt || 0)
        - Date.parse(left?.updatedAt || left?.createdAt || 0);
    });
}

function normalizeMemorySearch(value) {
  return String(value || '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

function renderMemoryUnavailable(list, message) {
  if (!list) return;
  document.querySelector('.memory-control-center')?.setAttribute('data-memory-state', 'unavailable');
  list.replaceChildren();
  const state = document.createElement('div');
  state.className = 'memory-unavailable-state';
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = 'Память временно недоступна';
  const detail = document.createElement('small');
  detail.textContent = message || 'Локальный сервис не ответил.';
  copy.append(title, detail);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'claude-secondary-btn';
  retry.dataset.memoryRetry = '';
  retry.textContent = 'Повторить';
  state.append(copy, retry);
  list.append(state);
  const label = document.querySelector('#memory-count');
  if (label) label.textContent = 'Недоступно';
  const explicitCount = document.querySelector('#memory-explicit-count');
  if (explicitCount) explicitCount.textContent = '—';
  const summary = document.querySelector('#memory-library-summary');
  if (summary) summary.textContent = 'Локальный сервис не вернул данные';
}

function createMemoryItem(record) {
  const item = document.createElement('article');
  item.className = 'memory-settings-item';
  item.dataset.memoryId = String(record.id || '');

  const header = document.createElement('header');
  header.className = 'memory-item-heading';
  const categoryBadge = document.createElement('span');
  categoryBadge.className = 'memory-category-badge';
  categoryBadge.dataset.category = String(record.category || 'note');
  categoryBadge.textContent = CATEGORY_LABELS[record.category] || 'Заметка';
  header.append(categoryBadge);
  if (record.pinned === true || record.tier === 'permanent') {
    const pinnedBadge = document.createElement('span');
    pinnedBadge.className = 'memory-pinned-badge';
    pinnedBadge.textContent = 'Всегда';
    header.append(pinnedBadge);
  }

  const content = document.createElement('p');
  content.className = 'memory-item-copy';
  content.textContent = String(record.text || record.content || '');

  const metadata = document.createElement('div');
  metadata.className = 'memory-item-metadata';
  const source = document.createElement('span');
  source.textContent = `Источник: ${formatMemorySource(record.source)}`;
  const updated = document.createElement('span');
  updated.textContent = record.updatedAt ? `Обновлено ${formatShortDate(record.updatedAt)}` : 'Дата не указана';
  metadata.append(source, updated);
  if (Number(record.accessCount) > 0) {
    const used = document.createElement('span');
    used.textContent = `Учтено в ответах: ${Number(record.accessCount)}`;
    metadata.append(used);
  }

  const editor = document.createElement('details');
  editor.className = 'memory-item-editor';
  const summary = document.createElement('summary');
  summary.textContent = 'Изменить запись';
  const editorBody = document.createElement('div');
  editorBody.className = 'memory-item-editor-body';

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
  pinLabel.className = 'memory-inline-pin';
  const pinned = document.createElement('input');
  pinned.type = 'checkbox';
  pinned.checked = record.pinned === true || record.tier === 'permanent';
  pinned.dataset.memoryPinned = '';
  const pinSwitch = document.createElement('span');
  pinSwitch.className = 'control-switch';
  pinSwitch.setAttribute('aria-hidden', 'true');
  pinLabel.append(pinned, pinSwitch, document.createTextNode(' Всегда учитывать'));

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
  editorBody.append(textarea, controls);
  editor.append(summary, editorBody);
  item.append(header, content, metadata, editor);
  return item;
}

function formatMemorySource(value) {
  const source = String(value || '').trim();
  if (source === 'settings-ui') return 'Monarch Control';
  if (source === 'chat-command' || source === 'oscar-chat') return 'Команда в чате';
  if (source === 'migration-profile-v1') return 'Перенос старого профиля';
  if (source.startsWith('migration')) return 'Миграция данных';
  return source ? source.replace(/[-_]+/g, ' ') : 'Oscar';
}

function setSkillAuthoringOpen(open) {
  const panel = document.querySelector('#skill-authoring-panel');
  const toggle = document.querySelector('#skill-create-toggle');
  if (!panel || !toggle) return;
  panel.hidden = !open;
  toggle.hidden = open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = 'Создать свой';
  if (open) document.querySelector('#skill-purpose')?.focus();
}

async function generateAutoSkillDraft() {
  const button = document.querySelector('#skill-auto-draft');
  const purpose = document.querySelector('#skill-purpose')?.value || '';
  const scope = document.querySelector('#skill-scope')?.value || 'project';
  setBusy(button, true, 'Готовлю…');
  setSkillAuthoringState('Готовлю черновик локально');
  try {
    const result = await createSkillDraft(purpose, scope);
    populateSkillDraft(result.draft);
    document.querySelector('#skill-editor').hidden = false;
    verifiedSkillDraftHash = '';
    document.querySelector('#skill-publish').disabled = true;
    renderSkillValidation({
      ...result,
      diagnostics: [
        ...(Array.isArray(result.diagnostics) ? result.diagnostics : []),
        {
          level: 'warning',
          code: 'skill-review-required',
          field: 'draft',
          message: 'Черновик ещё не создан. Просмотри правила и нажми «Проверить».',
        },
      ],
    });
    setSkillAuthoringState('Черновик готов · файлы не записаны');
    document.querySelector('#skill-display-name')?.focus();
  } catch (error) {
    setSkillAuthoringState(readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Подготовить черновик');
  }
}

async function validateCurrentSkillDraft() {
  const button = document.querySelector('#skill-validate');
  setBusy(button, true, 'Проверяю…');
  setSkillAuthoringState('Проверяю правила и возможные конфликты');
  try {
    const result = await validateSkillDraft(readSkillDraftForm());
    populateSkillDraft(result.draft);
    renderSkillValidation(result);
    verifiedSkillDraftHash = result.valid ? String(result.draftHash || '') : '';
    document.querySelector('#skill-publish').disabled = !verifiedSkillDraftHash;
    setSkillAuthoringState(result.valid
      ? 'Проверено · можно создать навык'
      : 'Нужно исправить отмеченные поля', !result.valid);
  } catch (error) {
    verifiedSkillDraftHash = '';
    document.querySelector('#skill-publish').disabled = true;
    setSkillAuthoringState(readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Проверить');
  }
}

async function publishCurrentSkillDraft() {
  const button = document.querySelector('#skill-publish');
  if (!verifiedSkillDraftHash) {
    setSkillAuthoringState('Сначала проверь актуальный черновик', true);
    return;
  }
  setBusy(button, true, 'Создаю…');
  setSkillAuthoringState('Сохраняю навык и проверяю результат');
  try {
    const result = await publishSkillDraft(readSkillDraftForm(), verifiedSkillDraftHash);
    verifiedSkillDraftHash = '';
    button.disabled = true;
    renderSkillCreationReceipt(result.receipt);
    setSkillAuthoringState('Навык создан и проверен');
    await loadSkillSettings(true);
  } catch (error) {
    verifiedSkillDraftHash = '';
    button.disabled = true;
    setSkillAuthoringState(readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Создать навык');
    if (button) button.disabled = !verifiedSkillDraftHash;
  }
}

function populateSkillDraft(draft) {
  if (!draft || typeof draft !== 'object') return;
  const panel = document.querySelector('#skill-authoring-panel');
  if (panel) panel.dataset.draftSource = draft.source === 'auto' ? 'auto' : 'manual';
  setInputValue('#skill-scope', draft.scope === 'user' ? 'user' : 'project');
  setInputValue('#skill-name', draft.name);
  setInputValue('#skill-display-name', draft.displayName);
  setInputValue('#skill-description', draft.description);
  setInputValue('#skill-instructions', draft.instructions);
  setInputValue('#skill-examples', Array.isArray(draft.examples) ? draft.examples.join('\n') : '');
  setInputValue('#skill-capabilities', Array.isArray(draft.requiredCapabilities)
    ? draft.requiredCapabilities.join('\n')
    : '');
  const implicit = document.querySelector('#skill-implicit');
  if (implicit) implicit.checked = draft.allowImplicitInvocation === true;
}

function setInputValue(selector, value) {
  const input = document.querySelector(selector);
  if (input) input.value = String(value || '');
}

export function normalizeSkillDraftValues(values = {}) {
  return {
    schemaVersion: 1,
    source: values.source === 'auto' ? 'auto' : 'manual',
    scope: values.scope === 'user' ? 'user' : 'project',
    name: String(values.name || '').trim().toLowerCase(),
    displayName: String(values.displayName || '').trim(),
    description: String(values.description || '').trim(),
    instructions: String(values.instructions || '').replace(/\r\n/g, '\n').trim(),
    examples: splitSettingsLines(values.examples).slice(0, 8),
    requiredCapabilities: splitSettingsLines(values.requiredCapabilities)
      .map((value) => value.toLowerCase())
      .slice(0, 32),
    allowImplicitInvocation: values.allowImplicitInvocation === true,
  };
}

function readSkillDraftForm() {
  const panel = document.querySelector('#skill-authoring-panel');
  return normalizeSkillDraftValues({
    source: panel?.dataset.draftSource,
    scope: document.querySelector('#skill-scope')?.value,
    name: document.querySelector('#skill-name')?.value,
    displayName: document.querySelector('#skill-display-name')?.value,
    description: document.querySelector('#skill-description')?.value,
    instructions: document.querySelector('#skill-instructions')?.value,
    examples: document.querySelector('#skill-examples')?.value,
    requiredCapabilities: document.querySelector('#skill-capabilities')?.value,
    allowImplicitInvocation: document.querySelector('#skill-implicit')?.checked === true,
  });
}

function invalidateSkillDraftValidation() {
  verifiedSkillDraftHash = '';
  document.querySelector('#skill-publish').disabled = true;
  setSkillAuthoringState('Черновик изменён · проверь ещё раз');
  const summary = document.querySelector('#skill-validation-summary');
  if (summary) summary.replaceChildren();
}

function renderSkillValidation(result) {
  const summary = document.querySelector('#skill-validation-summary');
  if (!summary) return;
  summary.replaceChildren();
  const location = document.createElement('p');
  location.className = 'skill-target-location';
  location.textContent = `Цель · ${String(result?.targetLocation || 'локальный каталог навыков')}`;
  summary.append(location);
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
  if (!diagnostics.length) {
    const ready = document.createElement('p');
    ready.className = 'skill-diagnostic skill-diagnostic-ok';
    ready.textContent = 'Схема, имя, границы и конфликты проверены.';
    summary.append(ready);
    return;
  }
  diagnostics.forEach((diagnostic) => {
    const item = document.createElement('p');
    item.className = `skill-diagnostic skill-diagnostic-${diagnostic.level === 'error' ? 'error' : 'warning'}`;
    item.textContent = String(diagnostic.message || 'Проверь черновик.');
    summary.append(item);
  });
}

function renderSkillCreationReceipt(receipt) {
  const summary = document.querySelector('#skill-validation-summary');
  if (!summary) return;
  summary.replaceChildren();
  const item = document.createElement('div');
  item.className = 'skill-creation-receipt';
  const title = document.createElement('strong');
  title.textContent = 'Навык создан и проверен';
  const hint = document.createElement('span');
  hint.textContent = 'Теперь его можно выбрать в чате.';
  const details = document.createElement('details');
  const detailsTitle = document.createElement('summary');
  detailsTitle.textContent = 'Техническая квитанция';
  const location = document.createElement('span');
  location.textContent = String(receipt?.location || 'Локальный пакет');
  const hash = document.createElement('code');
  hash.textContent = `receipt ${shortHash(receipt?.readBackHash)}`;
  details.append(detailsTitle, location, hash);
  item.append(title, hint, details);
  summary.append(item);
}

function setSkillAuthoringState(message, error = false) {
  const state = document.querySelector('#skill-authoring-state');
  if (!state) return;
  state.textContent = String(message || '');
  state.classList.toggle('error', error);
}

function shortHash(value) {
  const hash = String(value || '');
  return hash ? hash.slice(0, 10) : 'без hash';
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
  const hasQuery = Boolean(String(query).trim());
  const personal = matching.filter((skill) => skill.scope === 'project' || skill.scope === 'user');
  const primary = hasQuery
    ? matching
    : personal.length ? personal : matching.filter((skill) => skill.compatible !== false).slice(0, 6);
  const visible = primary.slice(0, visibleSkillLimit);
  const localCount = discoveredSkills.filter((skill) => skill.scope === 'project').length;
  const userCount = discoveredSkills.filter((skill) => skill.scope === 'user').length;
  const compatibleCount = discoveredSkills.filter((skill) => skill.compatible !== false).length;
  setText('#skills-count', hasQuery
    ? `${matching.length} найдено`
    : `${personal.length} твоих · ${discoveredSkills.length} всего`);
  setText('#skills-list-title', hasQuery ? 'Результаты поиска' : 'Твои навыки');
  setText('#skills-list-hint', hasQuery
    ? (matching.length ? 'Выбери нужный и продолжи задачу в чате.' : 'Попробуй другое простое слово.')
    : 'Полный системный каталог появится только при поиске.');
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
  if (visible.length < primary.length) {
    list.append(createSkillsMoreButton(visible.length, primary.length));
  }
}

function createSkillItem(skill) {
  const item = document.createElement('article');
  item.className = 'skill-settings-item';
  item.dataset.scope = String(skill.scope || 'system');
  item.dataset.compatible = String(skill.compatible !== false);

  const copy = document.createElement('div');
  copy.className = 'skill-settings-copy';
  const displayName = skillUserFacingName(skill);
  const title = document.createElement('strong');
  title.textContent = displayName;
  const description = document.createElement('p');
  description.textContent = skillUserFacingDescription(skill);
  const badges = document.createElement('div');
  badges.className = 'skill-settings-badges';
  [scopeLabel(skill.scope), skill.allowImplicitInvocation ? 'Oscar может предложить' : 'по твоему выбору'].forEach((label) => {
    const badge = document.createElement('span');
    badge.textContent = label;
    badges.append(badge);
  });
  const details = document.createElement('details');
  details.className = 'skill-settings-details';
  const detailsSummary = document.createElement('summary');
  detailsSummary.textContent = 'Технические детали';
  const detailsBody = document.createElement('div');
  const technicalMeta = document.createElement('p');
  technicalMeta.textContent = [
    providerLabel(skill.provider),
    skill.creationSource === 'auto' ? 'авто-черновик'
      : skill.creationSource === 'manual' ? 'создан вручную' : 'внешний пакет',
    skill.trust === 'linked' ? 'внешняя ссылка' : 'проверенный путь',
    skill.resourceCount ? `${skill.resourceCount} ресурс.` : 'без ресурсов',
  ].join(' · ');
  const location = document.createElement('code');
  location.textContent = String(skill.location || 'SKILL.md');
  const capabilities = document.createElement('p');
  capabilities.textContent = Array.isArray(skill.requiredCapabilities) && skill.requiredCapabilities.length
    ? `Capability: ${skill.requiredCapabilities.join(', ')}`
    : 'Capability не заявлены · права не добавляются.';
  const activation = document.createElement('p');
  activation.textContent = skill.allowImplicitInvocation
    ? 'Подбирается под задачу. Проверка разрешений остаётся обязательной.'
    : 'Запускается только явным вызовом.';
  detailsBody.append(technicalMeta, location, capabilities, activation);
  details.append(detailsSummary, detailsBody);
  copy.append(title, description, badges, details);

  const action = document.createElement('button');
  action.type = 'button';
  // One primary per screen: every skill row offers the quiet action.
  action.className = 'secondary-button';
  action.dataset.settingsSkill = String(skill.name || '');
  action.textContent = skill.compatible === false ? 'Недоступен' : 'Использовать в чате';
  action.disabled = skill.compatible === false;
  action.setAttribute('aria-label', skill.compatible === false
    ? `${displayName} недоступен в этом окружении`
    : `Использовать ${displayName} в чате`);
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
  const skill = discoveredSkills.find((entry) => String(entry.name || '') === name);
  window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view: 'oscar-section' } }));
  window.dispatchEvent(new CustomEvent('monarch:select-skill', {
    detail: {
      name,
      displayName: skillUserFacingName(skill || { name }),
      description: skillUserFacingDescription(skill || { name }),
    },
  }));
}

function openSkillPickerFromSettings() {
  window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view: 'oscar-section' } }));
  window.dispatchEvent(new CustomEvent('monarch:open-skill-picker'));
}

function providerLabel(provider) {
  return provider === 'gemini' ? 'Gemini CLI'
    : provider === 'monarch' ? 'Monarch'
      : provider === 'claude' ? 'Claude'
        : 'Codex';
}

function scopeLabel(scope) {
  return scope === 'project' ? 'В этом проекте' : scope === 'user' ? 'Для тебя' : 'Системный';
}

function skillScopeRank(scope) {
  return scope === 'project' ? 3 : scope === 'user' ? 2 : 1;
}

async function loadTelegramSettings() {
  const refresh = document.querySelector('#telegram-refresh-status');
  setBusy(refresh, true, 'Проверяю…');
  try {
    const [result, appInfo] = await Promise.all([
      runCapability('telegram', 'telegram.status', {}),
      typeof window.monarchDesktop?.getAppInfo === 'function'
        ? window.monarchDesktop.getAppInfo().catch(() => null)
        : Promise.resolve(null),
    ]);
    telegramAstraAvailable = appInfo?.astra?.telegramRead === true;
    renderTelegramSettings(result.output || {}, appInfo);
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
    const result = await controlTelegram('rotate-pairing');
    renderTelegramSettings(result.output || {});
    setStatus(document.querySelector('#telegram-feedback'), 'Новый код готов. Отправь его боту командой /pair.');
  } catch (error) {
    setStatus(document.querySelector('#telegram-feedback'), readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Создать новый код');
  }
}

async function toggleTelegramConnection() {
  const button = document.querySelector('#telegram-toggle-connection');
  const running = button?.dataset.running === 'true';
  setBusy(button, true, running ? 'Останавливаю…' : 'Подключаю…');
  try {
    const result = await controlTelegram(running ? 'stop' : 'start');
    if (!result?.ok) throw new Error(result?.summary || 'Не удалось изменить Telegram-подключение.');
    renderTelegramSettings(result.output || {});
    setStatus(document.querySelector('#telegram-feedback'), running
      ? 'Telegram polling остановлен'
      : 'Telegram-бот подключён и готов к привязке');
  } catch (error) {
    setStatus(document.querySelector('#telegram-feedback'), readErrorMessage(error), true);
  } finally {
    const nowRunning = button?.dataset.running === 'true';
    setBusy(button, false, nowRunning ? 'Остановить бота' : 'Подключить бота');
  }
}

async function toggleTelegramRemote() {
  const button = document.querySelector('#telegram-toggle-remote');
  const paused = button?.dataset.paused === 'true';
  setBusy(button, true, paused ? 'Возобновляю…' : 'Останавливаю…');
  try {
    const result = await controlTelegram(paused ? 'resume' : 'pause');
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
  if (!await confirmAction('Отозвать все Telegram-привязки и удалить их напоминания?')) return;
  setBusy(button, true, 'Отзываю…');
  try {
    const result = await controlTelegram('revoke-all');
    renderTelegramSettings(result.output || {});
    setStatus(document.querySelector('#telegram-feedback'), 'Все Telegram-привязки и их напоминания удалены');
  } catch (error) {
    setStatus(document.querySelector('#telegram-feedback'), readErrorMessage(error), true);
  } finally {
    setBusy(button, false, 'Отозвать все привязки');
  }
}

function renderTelegramSettings(status, appInfo = null) {
  const username = typeof status.bot?.username === 'string' ? status.bot.username : '';
  const pairings = Array.isArray(status.pairedChats) ? status.pairedChats : [];
  const botName = document.querySelector('#telegram-bot-name');
  const detail = document.querySelector('#telegram-bot-detail');
  const badge = document.querySelector('#telegram-status-badge');
  const code = document.querySelector('#telegram-pairing-code');
  const tokenPath = document.querySelector('#telegram-token-path');
  const createCode = document.querySelector('#telegram-create-code');
  const copyCode = document.querySelector('#telegram-copy-code');
  const toggleConnection = document.querySelector('#telegram-toggle-connection');
  const toggleRemote = document.querySelector('#telegram-toggle-remote');
  const revokeAll = document.querySelector('#telegram-revoke-all');
  const pairingCode = status.remotePaused ? '' : String(status.pairingCode || '');
  const pendingDeliveries = Math.max(0, Number(status.pendingTaskDeliveries || 0));

  if (botName) botName.textContent = username ? `@${username}` : status.configured ? 'Бот настроен' : 'Ключ бота не добавлен';
  if (detail) detail.textContent = status.remotePaused
    ? 'Защитный режим · удалённые задачи остановлены'
    : status.running
    ? status.pollingMode === 'standby'
      ? `Бот подключён в другом окне Monarch · чатов: ${pairings.length}`
      : pendingDeliveries > 0
        ? `Работает локально · доставляет результатов: ${pendingDeliveries}`
        : pairings.length ? `Работает локально · привязок: ${pairings.length}` : 'Работает локально · ждёт привязки'
    : status.configured ? 'Настроен, но не запущен' : 'Добавь ключ бота по инструкции ниже';
  if (badge) {
    badge.textContent = status.remotePaused ? 'Защита' : pairings.length ? 'Привязан' : status.running ? 'Готов' : status.configured ? 'Остановлен' : 'Не настроен';
    badge.dataset.state = status.remotePaused ? 'attention' : pairings.length ? 'paired' : status.running ? 'ready' : 'attention';
  }
  if (code) code.textContent = pairingCode || '••••••';
  if (tokenPath && status.tokenPath) tokenPath.textContent = String(status.tokenPath);
  if (createCode) createCode.disabled = status.remotePaused === true;
  if (copyCode) copyCode.disabled = status.remotePaused === true || !/^\d{6}$/.test(pairingCode);
  if (toggleConnection) {
    toggleConnection.dataset.running = String(status.running === true);
    toggleConnection.textContent = status.running ? 'Остановить бота' : 'Подключить бота';
  }
  if (toggleRemote) {
    toggleRemote.dataset.paused = String(status.remotePaused === true);
    toggleRemote.textContent = status.remotePaused ? 'Возобновить удалённый доступ' : 'Остановить удалённый доступ';
  }
  if (revokeAll) revokeAll.disabled = pairings.length === 0;
  setText('#telegram-task-mode', status.remotePaused
    ? 'Lockdown · задачи остановлены'
    : status.running
      ? pendingDeliveries > 0 ? `Agent · доставка ${pendingDeliveries}` : `Agent · ${status.pollingMode || 'owner'}`
      : 'Stopped · polling не активен');
  setText('#telegram-security-mode', status.securityMode === 'paired-chat + confirmation-gated'
    ? 'Привязка + подтверждения'
    : String(status.securityMode || 'confirmation-gated'));
  telegramExpiresAt = String(status.pairingExpiresAt || '');
  renderTelegramExpiry();
  renderTelegramInsights(status, pairings);
  if (appInfo) telegramAstraAvailable = appInfo?.astra?.telegramRead === true;
  renderTelegramAstraPairings(status, pairings, telegramAstraAvailable);
}

function renderTelegramAstraPairings(status, pairings, available) {
  const host = document.querySelector('#telegram-astra-pairings');
  const command = document.querySelector('#telegram-astra-command');
  if (!host) return;
  host.replaceChildren();
  if (command) { command.hidden = true; command.textContent = ''; }
  if (!available) {
    const note = document.createElement('small');
    note.textContent = 'Пилот выключен. Для source-сборки нужны оба флага Astra V3 и Telegram read pilot.';
    host.append(note); return;
  }
  if (status.remotePaused) {
    const note = document.createElement('small'); note.textContent = 'Lockdown включён: выдача новых alias запрещена.'; host.append(note); return;
  }
  if (!pairings.length) {
    const note = document.createElement('small'); note.textContent = 'Сначала привяжи хотя бы один Telegram-чат.'; host.append(note); return;
  }
  for (const pairing of pairings) {
    if (!Number.isSafeInteger(pairing?.chatId) || pairing.chatId === 0
      || !Number.isSafeInteger(pairing?.userId) || pairing.userId <= 0) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'claude-primary-btn';
    const name = typeof pairing.username === 'string' && pairing.username ? '@' + pairing.username : 'чат ' + pairing.chatId;
    button.textContent = 'Выбрать файл для ' + name;
    button.addEventListener('click', () => void shareTelegramAstraTarget(pairing, button));
    host.append(button);
  }
}

async function shareTelegramAstraTarget(pairing, button) {
  const command = document.querySelector('#telegram-astra-command');
  const idleLabel = button.textContent;
  setBusy(button, true, 'Выбираю…');
  try {
    const picked = await window.monarchDesktop?.astraPilot?.pickTelegramTarget?.({
      version: 1,
      chatId: pairing.chatId,
      userId: pairing.userId,
      requestId: crypto.randomUUID(),
      ttlMs: 3_600_000,
    });
    if (picked?.status === 'cancelled') return;
    if (picked?.status !== 'selected' || !/^astra_remote_alias_[a-f0-9]{32}$/u.test(picked.alias?.targetAlias || '')) {
      throw Error('Хост не подтвердил Telegram alias.');
    }
    const text = `/astra_read ${picked.alias.targetAlias} Прочитай выбранный файл и дай точный результат.`;
    if (command) { command.textContent = text; command.hidden = false; }
    try { await navigator.clipboard.writeText(text); } catch { /* command remains visible for manual copy */ }
    setStatus(document.querySelector('#telegram-feedback'), 'Команда готова и скопирована. Отправь её именно выбранному боту/чату до истечения alias.');
  } catch (error) {
    setStatus(document.querySelector('#telegram-feedback'), readErrorMessage(error), true);
  } finally {
    setBusy(button, false, idleLabel);
  }
}

function renderTelegramInsights(status, pairings) {
  const attachmentMaxBytes = Math.max(0, Number(status.attachmentTransport?.maxBytesPerAttachment || 0));
  const textDocumentMaxBytes = Math.max(0, Number(status.attachmentTransport?.maxTextDocumentBytes || 0));
  const artifactOffers = Math.max(0, Number(status.pendingArtifactEgressOffers || 0));
  setText('#telegram-paired-summary', `Привязок: ${pairings.length}`);
  setText('#telegram-pending-summary', `Доставок: ${Math.max(0, Number(status.pendingTaskDeliveries || 0))} · файлов: ${artifactOffers}`);
  setText('#telegram-photo-summary', attachmentMaxBytes > 0
    ? `Вложения: ${Math.round(attachmentMaxBytes / 1024 / 1024)} МиБ · текст ${Math.round(textDocumentMaxBytes / 1024)} КиБ`
    : 'Вложения: недоступны');
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
  const result = unwrapCapabilityPayload(payload);
  if (result.ok) return result;
  throw new Error(result.summary || (result.error === 'confirmation-required'
    ? 'Действие ждёт точную Agent action-card.'
    : result.error) || 'Действие не выполнено.');
}

async function setCrossChatMemory(control) {
  if (!control || control.disabled) return;
  const feedback = document.querySelector('#memory-feedback');
  const enabled = control.checked === true;
  control.disabled = true;
  setStatus(feedback, 'Сохраняю режим памяти…');
  try {
    const saved = await writeLocalSettings('memory.cross-chat.set', { enabled }, {
      expectedRevision: memorySettingsRevision,
    });
    memorySettingsRevision = saved.context.revision;
    control.checked = saved.context.value?.crossChatEnabled !== false;
    updateCrossChatMemoryLabel(control.checked);
    setStatus(feedback, control.checked ? 'Контекст прошлых чатов включён' : 'Контекст прошлых чатов выключен');
  } catch (error) {
    control.checked = !enabled;
    updateCrossChatMemoryLabel(control.checked);
    setStatus(feedback, readErrorMessage(error), true);
  } finally {
    control.disabled = false;
  }
}

function updateCrossChatMemoryLabel(enabled) {
  const label = document.querySelector('#memory-cross-chat-label');
  if (label) label.textContent = enabled ? 'Включён' : 'Выключен';
  document.querySelector('.memory-cross-chat-card')?.classList.toggle('is-disabled', !enabled);
}

function updateMemoryCount() {
  const count = memorySettingsRecords.length;
  const label = document.querySelector('#memory-count');
  if (label) label.textContent = `${count} ${count === 1 ? 'запись' : count > 1 && count < 5 ? 'записи' : 'записей'}`;
  const explicitCount = document.querySelector('#memory-explicit-count');
  if (explicitCount) explicitCount.textContent = String(count);
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
