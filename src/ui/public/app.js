import { MonarchStartup } from '/startup/monarch-startup.js';
import { mountMonarchLogo3D } from '/startup/monarch-logo-3d.js';
import { state, updateState, subscribeState } from './modules/state.js';
import { executeCapability, fetchState, revokeCapabilityLease, rollbackAction, updateAutonomyMode } from './modules/api.js';
import './modules/test-suite.js';
import { readErrorMessage, readOscarModelStatus, renderError } from './modules/utils.js';
import { formatOscarContextTokenCount, resolveOscarContextMeterState } from './modules/oscar-context-meter.js';
import { cancelIntentJobAction, initChatPane, renderChatPane, submitIntentAction, renderThread } from './modules/chat-pane.js';
import { initOscarPane, loadOscarConversations, loadOscarStatus, renderOscar, startNewOscarConversation } from './modules/oscar-pane.js';
import { initSecurityPane, loadSecurityStatus, renderSecurity, renderSecurityPolicyControls } from './modules/security-pane.js';
import { initModelManager, renderModelManager } from './modules/model-manager.js';
import { initModelOnboarding, renderModelOnboarding } from './modules/model-onboarding.js';
import { initModelSetupWelcome, renderModelSetupWelcome } from './modules/model-setup-welcome.js';
import { initSharingPane, renderSharingPane } from './modules/sharing-pane.js';
import { initMascotInteraction, syncMascotFromRuntime } from './modules/mascot-controller.js';
import { initSettingsPane } from './modules/settings-pane.js';
import { initUpdatePane } from './modules/update-pane.js';
import { initVoiceInput } from './modules/voice-input.js';
import { initOscarVoiceMode } from './modules/oscar-voice-mode.js';
import { installOscarSnakeEasterEgg } from './modules/oscar-snake-game.js';
import { installMonarchBrandEasterEgg } from './modules/brand-easter-egg.js';
import { initCoderPane } from './modules/coder-pane.js';
import { initStudioPane, setStudioActive } from './modules/studio-pane.js';
import { initImageGenerationPane, renderImageGenerationPane } from './modules/image-generation-pane.js';
import { normalizeUiPreferences, serializeUiPreferences } from './modules/ui-preferences.js';
import { initComputerUseControl, syncComputerUsePermissionProfile } from './modules/computer-use-control.js';
import { installComposerTypeToFocus } from './modules/composer-type-to-focus.js';
import { copyTextToClipboard } from './modules/clipboard.js';
import {
  filterSelectableOscarModelScale,
  resolveSelectableOscarModelAvailability,
} from './modules/oscar-model-availability.js';

// Elements
const elements = {
  intentInput: document.querySelector('#intent-input'),
  oscarInput: document.querySelector('#oscar-input'),
  oscarComposer: document.querySelector('#oscar-composer'),
  thread: document.querySelector('#thread'),
  shell: document.querySelector('#app-shell'),
  densitySelect: document.querySelector('#density-select'),
  inspectorDefaultSelect: document.querySelector('#inspector-default-select'),
  startupAnimationSelect: document.querySelector('#startup-animation-select'),
  startupAnimationPreview: document.querySelector('#startup-animation-preview'),
  startupAnimationStatus: document.querySelector('#startup-animation-status'),
  oscarDiagnostics: document.querySelector('#oscar-diagnostics'),
  oscarDiagnosticsToggle: document.querySelector('#oscar-diagnostics-toggle'),
  modelDropdownBtn: document.querySelector('#model-dropdown-btn'),
  modelPopover: document.querySelector('#model-popover'),
  autonomyModeSelect: document.querySelector('#autonomy-mode-select'),
  permissionProfileNote: document.querySelector('#permission-profile-note'),
  authorityStatusCard: document.querySelector('#authority-status-card'),
  authorityTier: document.querySelector('#authority-tier'),
  authorityDetail: document.querySelector('#authority-detail'),
  activeLeasesList: document.querySelector('#active-leases-list'),
  actionLedgerList: document.querySelector('#action-ledger-list'),
  revokeAllLeases: document.querySelector('#revoke-all-leases'),
};

const MODEL_LABELS = Object.freeze({
  auto: 'Авто',
  none: 'Авто',
  'gemma4-fast': 'Basic 2B',
  'gemma4-balanced': 'Basic 12B',
  'qwen3.8-27b-pro': 'Pro 27B',
  'gemma4-deepthinking': 'Pro 27B',
  'gemma4-31b': 'Pro 27B',
});
const OSCAR_MODEL_SCALE = Object.freeze([
  'gemma4-fast',
  'gemma4-balanced',
  'qwen3.8-27b-pro',
]);

async function copyOscarCodeBlock(button) {
  const code = button.closest('.oscar-code-block')?.querySelector('code')?.textContent;
  const label = button.querySelector('.oscar-copy-label');
  if (code === undefined || !label) return;

  window.clearTimeout(Number(button.dataset.resetTimer || 0));
  button.disabled = true;
  button.dataset.copyState = 'pending';
  const copied = await copyTextToClipboard(code);
  button.disabled = false;
  button.dataset.copyState = copied ? 'copied' : 'error';
  label.textContent = copied ? 'Готово' : 'Ошибка';
  button.setAttribute('aria-label', copied ? 'Код скопирован' : 'Не удалось скопировать код');

  button.dataset.resetTimer = String(window.setTimeout(() => {
    button.dataset.copyState = 'idle';
    label.textContent = 'Копировать';
    button.setAttribute('aria-label', 'Скопировать весь код');
    delete button.dataset.resetTimer;
  }, 1400));
}

const STARTUP_TYPE_LABELS = Object.freeze({
  classic: 'Классическая',
  generated: 'Generated 3D',
  model: 'Полная 3D-модель',
  test: 'Системная',
  disabled: 'Отключена',
});
const STARTUP_DURATIONS = Object.freeze({
  classic: 2380,
  generated: 2700,
  model: 3040,
});
const startupMotionTemplate = document.querySelector('#startup-motion')?.cloneNode(true) || null;
let activeStartupPreviewCleanup = null;

const preferences = readPreferences();
const reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const animatedMotionKeys = new Set();
let typingTimer = 0;
let safeLaunchFeedbackTimer = 0;
let securityStatusRequested = false;
let componentStateTimer = 0;

// Render Coordinator
function render() {
  if (state.data?.permissions) syncComputerUsePermissionProfile(state.data.permissions);
  renderModelOnboarding();
  renderModelSetupWelcome();
  scheduleComponentStateRefresh(state.data?.components);
  renderModelManager();
  renderActiveView(readActiveViewId());
  renderMascot();
}

function renderActiveView(activeView) {
  if (activeView === 'oscar-section') {
    syncOscarModelDropdowns();
    renderOscar();
    return;
  }
  if (activeView === 'security-section') {
    renderSecurity();
    return;
  }
  if (activeView === 'images-section') {
    renderImageGenerationPane();
    return;
  }
  if (activeView === 'sharing-section') {
    renderSharingPane();
    return;
  }
  if (activeView === 'settings-section') {
    renderPermissionSettings();
    return;
  }
  renderChatPane();
}

// Global Action Delegate
document.addEventListener('click', (event) => {
  const brandMascotToggle = event.target.closest('[data-monarch-brand-cycle]');
  if (brandMascotToggle) {
    toggleMascotVisibility();
    return;
  }

  // A. Toggle Context Drawer
  const toggleBtn = event.target.closest('#toggle-inspector-btn, [data-inspector-toggle]');
  if (toggleBtn) {
    toggleMascotVisibility();
    return;
  }

  // B. New Task Reset Action
  const newTaskBtn = event.target.closest('#new-task-button');
  if (newTaskBtn) {
    const oscarTab = document.querySelector('.nav-item[data-scroll-target="oscar-section"]');
    oscarTab?.click();
    void startNewOscarConversation();
    return;
  }

  // C. Mascot guidance actions
  const mascotPromptButton = event.target.closest('[data-mascot-prompt]');
  if (mascotPromptButton) {
    const oscarTab = document.querySelector('.nav-item[data-scroll-target="oscar-section"]');
    oscarTab?.click();
    if (elements.oscarInput) {
      elements.oscarInput.value = mascotPromptButton.getAttribute('data-mascot-prompt') || '';
      elements.oscarInput.dispatchEvent(new Event('input', { bubbles: true }));
      elements.oscarInput.focus();
    }
    return;
  }

  const mascotTargetButton = event.target.closest('[data-mascot-target]');
  if (mascotTargetButton) {
    const targetId = mascotTargetButton.getAttribute('data-mascot-target') || '';
    const targetTab = [...document.querySelectorAll('.nav-item')].find((item) => item.getAttribute('data-scroll-target') === targetId);
    targetTab?.click();
    return;
  }

  const safeFeedbackClose = event.target.closest('#safe-launch-feedback-close');
  if (safeFeedbackClose) {
    hideSafeLaunchFeedback();
    return;
  }

  const safeButton = event.target.closest('[data-open-safe]');
  if (safeButton) {
    void launchSafeFromUi(safeButton);
    return;
  }

  // D. Oscar Prompt button
  const oscarPromptButton = event.target.closest('[data-oscar-prompt]');
  if (oscarPromptButton) {
    if (elements.oscarInput) {
      elements.oscarInput.value = oscarPromptButton.getAttribute('data-oscar-prompt') || '';
      elements.oscarInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (elements.oscarComposer) {
      elements.oscarComposer.dispatchEvent(new Event('submit'));
    }
    return;
  }

  const oscarRamAction = event.target.closest('[data-oscar-ram-action]');
  if (oscarRamAction) {
    const action = oscarRamAction.getAttribute('data-oscar-ram-action');
    if (action === 'use-balanced') {
      state.oscar = state.oscar || {};
      state.oscar.intelligenceEnabled = true;
      state.oscar.modelSelection = 'gemma4-balanced';
      syncOscarModelDropdowns();
      renderOscar();
      requestAnimationFrame(() => document.querySelector('#oscar-model-dropdown-btn')?.focus());
    } else if (action === 'refresh') {
      oscarRamAction.disabled = true;
      oscarRamAction.setAttribute('aria-busy', 'true');
      void loadOscarStatus(render).finally(() => {
        oscarRamAction.disabled = false;
        oscarRamAction.removeAttribute('aria-busy');
      });
    }
    return;
  }


  const modelDropdownTrigger = event.target.closest('#model-dropdown-btn');
  if (modelDropdownTrigger) {
    toggleDropdown(elements.modelPopover);
    closeOtherDropdowns(elements.modelPopover);
    return;
  }

  const oscarModelDropdownTrigger = event.target.closest('#oscar-model-dropdown-btn');
  if (oscarModelDropdownTrigger) {
    const popover = document.querySelector('#oscar-model-popover');
    toggleDropdown(popover);
    closeOtherDropdowns(popover);
    return;
  }

  const oscarIntelligenceToggle = event.target.closest('#oscar-intelligence-toggle');
  if (oscarIntelligenceToggle) {
    state.oscar = state.oscar || {};
    state.oscar.intelligenceEnabled = state.oscar.intelligenceEnabled !== true;
    syncOscarModelDropdowns();
    renderOscar();
    const popover = document.querySelector('#oscar-model-popover');
    if (state.oscar.intelligenceEnabled) {
      document.querySelector('#oscar-composer-menu')?.removeAttribute('open');
      openDropdown(popover);
      closeOtherDropdowns(popover);
    }
    return;
  }

  const oscarContextMeterToggle = event.target.closest('#oscar-context-meter-toggle');
  if (oscarContextMeterToggle) {
    preferences.contextMeterVisible = preferences.contextMeterVisible === false;
    savePreferences();
    syncOscarModelDropdowns();
    return;
  }

  const oscarResearchDropdownTrigger = event.target.closest('#oscar-research-dropdown-btn');
  if (oscarResearchDropdownTrigger) {
    const popover = document.querySelector('#oscar-research-popover');
    toggleDropdown(popover);
    closeOtherDropdowns(popover);
    return;
  }

  const modelDropdownItem = event.target.closest('#model-popover .dropdown-item');
  if (modelDropdownItem) {
    if (modelDropdownItem.getAttribute('aria-disabled') === 'true') return;
    state.chat = state.chat || {};
    state.chat.modelSelection = modelDropdownItem.getAttribute('data-value') || 'auto';
    syncChatModelDropdowns();
    closeDropdown(elements.modelPopover);
    return;
  }

  const oscarModelPopover = document.querySelector('#oscar-model-popover');
  const oscarModelDropdownItem = event.target.closest('#oscar-model-popover .dropdown-item');
  if (oscarModelDropdownItem?.closest('.dropdown-popover') === oscarModelPopover) {
    if (oscarModelDropdownItem.getAttribute('aria-disabled') === 'true') return;
    state.oscar = state.oscar || {};
    const currentSelection = state.oscar.modelSelection || 'none';
    let nextSelection = oscarModelDropdownItem.getAttribute('data-value') || 'none';
    if (nextSelection === 'none' && currentSelection === 'none') {
      nextSelection = resolveOscarManualModelSelection(state.oscar.lastManualModelSelection);
    } else if (nextSelection === 'none' && currentSelection !== 'none') {
      state.oscar.lastManualModelSelection = currentSelection;
    }
    state.oscar.modelSelection = nextSelection;
    if (nextSelection !== 'none') state.oscar.lastManualModelSelection = nextSelection;
    syncOscarModelDropdowns();
    import('./modules/oscar-pane.js').then(m => m.renderOscar && m.renderOscar());
    return;
  }

  const oscarResearchDropdownItem = event.target.closest('#oscar-research-popover .dropdown-item');
  if (oscarResearchDropdownItem) {
    state.oscar = state.oscar || {};
    state.oscar.researchMode = oscarResearchDropdownItem.getAttribute('data-value') || 'auto';
    syncOscarModelDropdowns();
    closeDropdown(document.querySelector('#oscar-research-popover'));
    import('./modules/oscar-pane.js').then(m => m.renderOscar && m.renderOscar());
    return;
  }

  if (!event.target.closest('.custom-dropdown')) {
    closeAllDropdowns();
  }
  if (!event.target.closest('.composer-options')) {
    closeComposerOptions();
  }

  // D. Prompt Mode Chips Delegate
  const copyBtn = event.target.closest('.oscar-copy-btn');
  if (copyBtn) {
    event.preventDefault();
    void copyOscarCodeBlock(copyBtn);
    return;
  }

  const modeChip = event.target.closest('.mode-chip[data-mode]');
  if (modeChip) {
    const mode = modeChip.getAttribute('data-mode') || '';
    if (elements.intentInput) {
      const current = elements.intentInput.value.trim();
      elements.intentInput.value = current ? `${mode}: ${current}` : `${mode}: `;
      elements.intentInput.focus();
    }
    return;
  }

  // E. Intent Execution button
  const intentButton = event.target.closest('[data-intent]');
  if (intentButton) {
    const intent = intentButton.getAttribute('data-intent') || '';
    const confirmed = intentButton.getAttribute('data-confirm') === 'true';
    const confirmationToken = intentButton.getAttribute('data-confirmation-token') || '';
    if (elements.intentInput) {
      elements.intentInput.value = intent;
    }
    if (confirmed || confirmationToken) {
      intentButton.disabled = true;
      intentButton.title = 'Текстовое подтверждение отключено. Используй точную Agent action-card.';
      return;
    }
    void submitIntentAction(intent, false);
    return;
  }

  // F. Confirmation cancels
  if (event.target.closest('[data-testid="cancel-intent"]')) {
    renderThread();
    return;
  }

  if (event.target.closest('[data-cancel-intent-job]')) {
    void cancelIntentJobAction();
    return;
  }

  // G. Single-Page View Switcher Router
  const navItem = event.target.closest('.nav-item');
  if (navItem) {
    activatePrimaryView(navItem);
  }
});

window.addEventListener('monarch:navigate', (event) => {
  const targetId = String(event.detail?.view || '');
  if (!targetId) return;
  const navItem = [...document.querySelectorAll('.nav-item')]
    .find((item) => item.getAttribute('data-scroll-target') === targetId);
  if (navItem) activatePrimaryView(navItem);
});

function activatePrimaryView(navItem) {
  const targetId = navItem.getAttribute('data-scroll-target') || '';
  const target = document.getElementById(targetId);
  if (!target) return;
  hideSafeLaunchFeedback();
  closeAllDropdowns();
  closeComposerOptions();
  const applyViewChange = () => {
    setActiveNavItem(navItem);
    const views = [
      'command-center',
      'oscar-section',
      'security-section',
      'images-section',
      'modules-section',
      'sharing-section',
      'logs-section',
      'settings-section'
    ];
    views.forEach(id => {
      const element = document.getElementById(id);
      if (element) element.classList.add('view-hidden');
    });
    target.classList.remove('view-hidden');
    elements.shell?.classList.toggle('modules-active', targetId === 'modules-section');
    setStudioActive(targetId === 'modules-section');
    resetViewScroll(target);
    renderActiveView(targetId);
    window.dispatchEvent(new CustomEvent('monarch:view-change', { detail: { view: targetId } }));
    const settingsTab = navItem.getAttribute('data-settings-open');
    if (targetId === 'settings-section') {
      window.dispatchEvent(new CustomEvent('monarch:settings-tab', { detail: { tab: settingsTab || 'general' } }));
    }
    if ((targetId === 'security-section' || targetId === 'settings-section') && !securityStatusRequested) {
      securityStatusRequested = true;
      void loadSecurityStatus(render);
    }
    renderMascot(targetId);
    window.scrollTo(0, 0);
  };

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (!reduceMotion && typeof document.startViewTransition === 'function') {
    document.startViewTransition(applyViewChange);
  } else {
    applyViewChange();
    target.classList.remove('view-entering');
    window.requestAnimationFrame(() => target.classList.add('view-entering'));
    window.setTimeout(() => target.classList.remove('view-entering'), 460);
  }
}

elements.shell?.addEventListener('monarch:mascot-surface-changed', () => {
  updateInspectorToggleControls(preferences.inspector === 'closed');
});

async function launchSafeFromUi(button) {
  if (!window.monarchDesktop?.openSafe) {
    showSafeLaunchFeedback(
      'desktop-only',
      'Открой Monarch Desktop',
      'Safe изолирован от веб-страницы. Запусти desktop-приложение и нажми этот раздел там.',
      0,
    );
    return;
  }

  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  showSafeLaunchFeedback('opening', 'Открываю Monarch Safe', 'Создаю отдельное защищённое окно…', 0);
  try {
    const result = await window.monarchDesktop.openSafe();
    if (result?.ok !== true) throw new Error('Desktop runtime отклонил открытие Safe.');
    showSafeLaunchFeedback('opened', 'Monarch Safe открыт', 'Защищённое окно выведено на передний план.', 3600);
  } catch (error) {
    showSafeLaunchFeedback('error', 'Не удалось открыть Monarch Safe', readErrorMessage(error), 0);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

function showSafeLaunchFeedback(kind, title, detail, hideAfterMs) {
  const node = document.querySelector('#safe-launch-feedback');
  if (!node) return;
  clearTimeout(safeLaunchFeedbackTimer);
  node.dataset.kind = kind;
  node.querySelector('#safe-launch-feedback-title').textContent = title;
  node.querySelector('#safe-launch-feedback-detail').textContent = detail;
  node.hidden = false;
  if (hideAfterMs > 0) safeLaunchFeedbackTimer = window.setTimeout(hideSafeLaunchFeedback, hideAfterMs);
}

function hideSafeLaunchFeedback() {
  clearTimeout(safeLaunchFeedbackTimer);
  safeLaunchFeedbackTimer = 0;
  const node = document.querySelector('#safe-launch-feedback');
  if (node) node.hidden = true;
}

function toggleMascotVisibility() {
  const shell = elements.shell || document.getElementById('app-shell');
  if (!shell) return;
  if (!shell.classList.contains('mascot-dialog-active')) {
    updateInspectorToggleControls(preferences.inspector === 'closed');
    return;
  }
  const isVisible = !shell.classList.contains('mascot-visible');
  preferences.inspector = isVisible ? 'open' : 'closed';
  savePreferences();
  applyPreferences();
  renderMascot();
}

function closeComposerOptions() {
  const details = document.querySelector('.composer-options[open]');
  details?.removeAttribute('open');
}

function resetViewScroll(target) {
  if (!(target instanceof Element)) return;
  const scrollTargets = [target, ...target.querySelectorAll('.document-feed')];
  for (const node of scrollTargets) {
    if (!(node instanceof HTMLElement)) continue;
    node.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }
}

document.addEventListener('input', (event) => {
  const range = event.target instanceof Element
    ? event.target.closest('#oscar-intelligence-range')
    : null;
  if (!(range instanceof HTMLInputElement)) return;
  const availableScale = readAvailableOscarModelScale();
  const modelSelection = availableScale[Number(range.value)] || availableScale[0] || 'none';
  const available = readSelectableOscarModelAvailability();
  if (available?.[modelSelection] === false) {
    syncOscarModelDropdowns();
    return;
  }
  state.oscar = state.oscar || {};
  state.oscar.modelSelection = modelSelection;
  state.oscar.lastManualModelSelection = modelSelection;
  syncOscarModelDropdowns();
  renderOscar();
});

document.addEventListener('keydown', (event) => {
  if (!(event.target instanceof Element)) return;

  const trigger = event.target.closest('.dropdown-trigger');
  if (trigger) {
    const popover = getControlledDropdown(trigger);
    if (!popover) return;

    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      openDropdown(popover, { focus: event.key === 'ArrowUp' ? 'last' : 'active' });
      closeOtherDropdowns(popover);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeDropdown(popover);
      trigger.focus({ preventScroll: true });
      return;
    }
  }

  const item = event.target.closest('.dropdown-item[role="option"]');
  const popover = item?.closest('.dropdown-popover');
  if (!item || !popover) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusRelativeDropdownItem(item, 1);
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    focusRelativeDropdownItem(item, -1);
    return;
  }

  if (event.key === 'Home') {
    event.preventDefault();
    focusDropdownItem(popover, 'first');
    return;
  }

  if (event.key === 'End') {
    event.preventDefault();
    focusDropdownItem(popover, 'last');
    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (item.getAttribute('aria-disabled') !== 'true') {
      const dropdownTrigger = getDropdownTrigger(popover);
      item.click();
      dropdownTrigger?.focus({ preventScroll: true });
    }
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    const dropdownTrigger = getDropdownTrigger(popover);
    closeDropdown(popover);
    dropdownTrigger?.focus({ preventScroll: true });
  }
});

for (const [select, key] of [
  [elements.densitySelect, 'density'],
  [elements.inspectorDefaultSelect, 'inspector'],
]) {
  if (select) {
    select.addEventListener('change', () => {
      preferences[key] = select.value;
      savePreferences();
      applyPreferences();
    });
  }
}

elements.autonomyModeSelect?.addEventListener('change', () => {
  void savePermissionProfile();
});

window.addEventListener('monarch:permission-profile-changed', (event) => {
  const profile = event.detail && typeof event.detail === 'object' ? event.detail : null;
  if (!profile) return;
  if (state.data) state.data.permissions = profile;
  renderPermissionSettings();
});

elements.activeLeasesList?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-revoke-lease]');
  if (button) void revokeLeaseAndRefresh(button.getAttribute('data-revoke-lease') || '');
});

elements.actionLedgerList?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-rollback-action]');
  if (button) void rollbackActionAndRefresh(button.getAttribute('data-rollback-action') || '', button);
});

elements.revokeAllLeases?.addEventListener('click', () => {
  void revokeAllLeasesAndRefresh();
});

if (elements.startupAnimationSelect) {
  elements.startupAnimationSelect.value = readStartupType();
  syncStartupPreferenceControls();
  elements.startupAnimationSelect.addEventListener('change', () => {
    const startupType = persistStartupType(elements.startupAnimationSelect.value);
    elements.startupAnimationSelect.value = startupType;
    syncStartupPreferenceControls();
  });
}

elements.startupAnimationPreview?.addEventListener('click', () => {
  previewStartupMotion(elements.startupAnimationSelect?.value);
});

// Load global state from server
async function loadState() {
  try {
    const data = await fetchState();
    updateState(data);
  } catch (error) {
    const errText = readErrorMessage(error);
    if (elements.thread) {
      elements.thread.innerHTML = renderError(`UI недоступен: ${errText}`);
    }
  }
}

// Initialization Flow
function init() {
  initStartupMotion();
  initMotionSystem();
  applyPreferences();
  savePreferences();
  syncDiagnosticsToggleControl();
  elements.oscarDiagnostics?.addEventListener('toggle', syncDiagnosticsToggleControl);

  // Bind module pane event listeners
  initChatPane();
  initModelManager();
  initModelOnboarding();
  initModelSetupWelcome();
  initOscarPane(render);
  initComputerUseControl();
  initCoderPane();
  initSecurityPane(render);
  initSharingPane();
  initSettingsPane();
  initStudioPane();
  initImageGenerationPane();
  initUpdatePane();
  initMascotInteraction();
  initVoiceInput();
  initOscarVoiceMode();
  installComposerTypeToFocus();
  installOscarSnakeEasterEgg({
    isConversationEmpty: () => state.oscar.messages.length === 0,
  });
  installMonarchBrandEasterEgg();

  // Subscribe render to reactive state changes
  subscribeState(render);
  renderMascot();

  // Initial queries
  void loadState().then(() => {
    void loadOscarStatus(render);
    void loadOscarConversations();
  });
}

// Start Monarch Web Shell
init();

function initStartupMotion() {
  const startupType = readStartupType();
  const forceReplay = new URLSearchParams(window.location.search).get('intro') === '1';
  let alreadyPlayed = false;
  try {
    alreadyPlayed = sessionStorage.getItem('monarch.startup-motion.v8') === 'played';
    if (!alreadyPlayed || forceReplay) sessionStorage.setItem('monarch.startup-motion.v8', 'played');
  } catch {
    // Storage is optional
  }

  const shell = elements.shell;
  const originalDOM = document.querySelector('#startup-motion');

  if (startupType === 'disabled' || (alreadyPlayed && !forceReplay)) {
    if (originalDOM) originalDOM.remove();
    shell?.classList.add('startup-complete');
    return;
  }

  if (startupType === 'classic' || startupType === 'generated' || startupType === 'model') {
    playDomStartupMotion(originalDOM, startupType, {
      completeShell: true,
    });
    return;
  }

  if (startupType === 'test') {
    if (originalDOM) originalDOM.remove();
    playSystemStartupMotion({
      completeShell: true,
    });
  }
}

function scheduleComponentStateRefresh(components) {
  if (componentStateTimer) window.clearTimeout(componentStateTimer);
  componentStateTimer = 0;
  const activeInstall = Boolean(components?.activeInstall);
  const legacyRepair = Boolean(components?.autoRepairEnabled && !components.ready);
  if (!activeInstall && !legacyRepair) return;
  componentStateTimer = window.setTimeout(() => {
    componentStateTimer = 0;
    void loadState();
  }, components.requiredModel?.phase === 'failed' ? 5_000 : 750);
}

function normalizeStartupType(value) {
  if (value === 'original') return 'generated';
  return Object.hasOwn(STARTUP_TYPE_LABELS, value) ? value : 'generated';
}

function readStartupType() {
  let stored = '';
  try {
    stored = localStorage.getItem('monarch.startup.type') || '';
  } catch {
    // Storage is optional.
  }
  const startupType = normalizeStartupType(stored);
  if (stored !== startupType) {
    try {
      localStorage.setItem('monarch.startup.type', startupType);
    } catch {
      // Storage is optional.
    }
  }
  document.documentElement.dataset.startupType = startupType;
  return startupType;
}

function persistStartupType(value) {
  const startupType = normalizeStartupType(value);
  try {
    localStorage.setItem('monarch.startup.type', startupType);
  } catch {
    // Storage is optional.
  }
  document.documentElement.dataset.startupType = startupType;
  return startupType;
}

function syncStartupPreferenceControls({ previewing = false } = {}) {
  const startupType = normalizeStartupType(elements.startupAnimationSelect?.value);
  if (elements.startupAnimationPreview) {
    elements.startupAnimationPreview.disabled = previewing || startupType === 'disabled';
    elements.startupAnimationPreview.textContent = previewing ? 'Показываю…' : 'Предпросмотр';
  }
  if (elements.startupAnimationStatus && !previewing) {
    elements.startupAnimationStatus.textContent = startupType === 'disabled'
      ? 'Стартовая анимация отключена'
      : `По умолчанию: ${STARTUP_TYPE_LABELS[startupType]}`;
  }
}

function playDomStartupMotion(root, startupType, options = {}) {
  if (!(root instanceof HTMLElement)) return () => {};
  root.dataset.startupVariant = startupType;
  root.classList.remove('is-exiting');

  const logo3D = startupType === 'model'
    ? mountMonarchLogo3D(root.querySelector('[data-monarch-logo-3d]'))
    : null;
  const duration = reducedMotionMedia?.matches
    ? 240
    : STARTUP_DURATIONS[startupType];
  const exitDelay = reducedMotionMedia?.matches ? 120 : 520;
  const timers = [];
  let finished = false;

  timers.push(window.setTimeout(() => {
    root.classList.add('is-exiting');
    if (options.completeShell) elements.shell?.classList.add('startup-complete');
  }, duration));
  timers.push(window.setTimeout(() => {
    if (finished) return;
    finished = true;
    logo3D?.dispose();
    root.remove();
    options.onComplete?.();
  }, duration + exitDelay));

  return () => {
    if (finished) return;
    finished = true;
    timers.forEach((timer) => window.clearTimeout(timer));
    logo3D?.dispose();
    root.remove();
  };
}

function playSystemStartupMotion(options = {}) {
  const startup = new MonarchStartup({
    title: 'MONARCH',
    subtitle: 'Local Intelligence Environment',
    initialStatus: 'Пробуждение системы',
    minimumVisibleTime: reducedMotionMedia?.matches ? 500 : 1800,
  });
  const timers = [];
  let finished = false;
  startup.mount();

  timers.push(window.setTimeout(() => {
    startup.setStatus('Запуск Oscar');
    startup.setProgress(0.45);
  }, 600));
  timers.push(window.setTimeout(() => {
    startup.setStatus('Проверка Security');
    startup.setProgress(0.8);
  }, 1200));
  timers.push(window.setTimeout(async () => {
    await startup.complete('Система готова');
    if (finished) return;
    finished = true;
    if (options.completeShell) elements.shell?.classList.add('startup-complete');
    options.onComplete?.();
  }, 1800));

  return () => {
    if (finished) return;
    finished = true;
    timers.forEach((timer) => window.clearTimeout(timer));
    startup.destroy();
  };
}

function previewStartupMotion(value) {
  const startupType = normalizeStartupType(value);
  if (startupType === 'disabled') {
    syncStartupPreferenceControls();
    return;
  }

  activeStartupPreviewCleanup?.();
  document.querySelector('#startup-motion')?.remove();
  document.querySelector('#monarch-startup')?.remove();
  syncStartupPreferenceControls({ previewing: true });
  if (elements.startupAnimationStatus) {
    elements.startupAnimationStatus.textContent =
      `Предпросмотр: ${STARTUP_TYPE_LABELS[startupType]}`;
  }

  let cleanup = null;
  const finish = () => {
    if (activeStartupPreviewCleanup === cleanup) activeStartupPreviewCleanup = null;
    syncStartupPreferenceControls();
  };

  if (startupType === 'test') {
    cleanup = playSystemStartupMotion({ onComplete: finish });
  } else if (startupMotionTemplate instanceof HTMLElement && elements.shell) {
    const previewRoot = startupMotionTemplate.cloneNode(true);
    previewRoot.dataset.startupVariant = startupType;
    elements.shell.before(previewRoot);
    cleanup = playDomStartupMotion(previewRoot, startupType, {
      onComplete: finish,
    });
  } else {
    syncStartupPreferenceControls();
    return;
  }

  activeStartupPreviewCleanup = cleanup;
}

function initMotionSystem() {
  const interactiveSelector = 'button, summary, a[href], [role="button"], .dropdown-item';
  const enterSelector = '.oscar-message, .attachment-preview-item, .source-chip, .tool-result-panel, .sidebar-history:not([hidden]), .oscar-memory-panel:not([hidden]), .dropdown-popover:not(.hidden)';

  document.addEventListener('pointerdown', (event) => {
    if (reducedMotionMedia?.matches || !(event.target instanceof Element)) return;
    const target = event.target.closest(interactiveSelector);
    if (!(target instanceof HTMLElement) || target.matches(':disabled, [aria-disabled="true"]')) return;
    target.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(.975)' }, { transform: 'scale(1)' }],
      { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  }, { passive: true });

  document.addEventListener('input', (event) => {
    if (!(event.target instanceof Element) || !event.target.matches('textarea, input:not([type]), input[type="text"], input[type="search"]')) return;
    const composer = event.target.closest('form, .claude-composer');
    if (!composer) return;
    composer.classList.add('is-typing');
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => composer.classList.remove('is-typing'), 420);
  }, { passive: true });

  let mutationFrame = 0;
  const pendingMotionNodes = new Set();
  const queueMotionNode = (node) => {
    if (!(node instanceof Element)) return;
    if (node.matches(enterSelector)) pendingMotionNodes.add(node);
    node.querySelectorAll(enterSelector).forEach((match) => pendingMotionNodes.add(match));
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        queueMotionNode(record.target);
        continue;
      }
      record.addedNodes.forEach(queueMotionNode);
    }
    if (mutationFrame) return;
    mutationFrame = window.requestAnimationFrame(() => {
      mutationFrame = 0;
      pendingMotionNodes.forEach((node) => animateEnteredNode(node));
      pendingMotionNodes.clear();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  document.querySelectorAll(enterSelector).forEach((node) => animateEnteredNode(node));
}

function animateEnteredNode(node) {
  if (!(node instanceof HTMLElement) || reducedMotionMedia?.matches) return;
  const messageId = node.getAttribute('data-message-id');
  const key = messageId ? `message:${messageId}` : '';
  if (key && animatedMotionKeys.has(key)) return;
  if (key) animatedMotionKeys.add(key);
  if (!key && node.dataset.motionEntered === 'true') return;
  node.dataset.motionEntered = 'true';
  node.animate(
    [
      { opacity: 0, transform: 'translateY(6px) scale(.992)', filter: 'blur(2px)' },
      { opacity: 1, transform: 'none', filter: 'none' },
    ],
    { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }
  );
}

function readPreferences() {
  try {
    return normalizeUiPreferences(JSON.parse(localStorage.getItem('monarch.ui.preferences') || '{}'));
  } catch {
    return normalizeUiPreferences({});
  }
}

function savePreferences() {
  try {
    localStorage.setItem('monarch.ui.preferences', JSON.stringify(serializeUiPreferences(preferences)));
  } catch {
    // UI preferences are optional; Monarch should still boot without browser storage.
  }
}

function applyPreferences() {
  document.body.dataset.theme = 'dark';
  document.body.dataset.density = preferences.density;

  if (elements.shell) {
    const mascotHidden = preferences.inspector === 'closed';
    elements.shell.classList.toggle('inspector-collapsed', mascotHidden);
    elements.shell.classList.toggle('mascot-visible', !mascotHidden);
  }

  if (elements.densitySelect) {
    elements.densitySelect.value = preferences.density;
  }
  if (elements.inspectorDefaultSelect) {
    elements.inspectorDefaultSelect.value = preferences.inspector;
  }

  updateInspectorToggleControls(preferences.inspector === 'closed');
}

function updateInspectorToggleControls(isCollapsed) {
  const shell = elements.shell || document.getElementById('app-shell');
  const emptyHome = shell?.classList.contains('mascot-empty-home') === true;
  const dialogActive = shell?.classList.contains('mascot-dialog-active') === true;
  const coderActive = shell?.classList.contains('coder-workspace-active') === true;
  const surfaceVisible = !coderActive && (emptyHome || (dialogActive && !isCollapsed));
  document.querySelectorAll('#toggle-inspector-btn, [data-inspector-toggle], [data-monarch-brand-cycle]').forEach((button) => {
    const label = coderActive
      ? 'Маскот Oscar скрыт в Coder'
      : emptyHome
      ? 'Центральный маскот Oscar всегда видим до первого сообщения'
      : isCollapsed ? 'Показать мини-маскота Oscar' : 'Скрыть мини-маскота Oscar';
    const textLabel = button.querySelector('span:not([aria-hidden="true"])');
    if (textLabel && !button.matches('[data-monarch-brand-cycle]')) textLabel.textContent = 'Мини-маскот';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(surfaceVisible));
    button.setAttribute('aria-disabled', String(coderActive || emptyHome));
    if (button.matches('[data-monarch-brand-cycle]')) button.setAttribute('aria-pressed', String(dialogActive && !isCollapsed));
  });
  const inspector = document.getElementById('inspector');
  if (inspector) inspector.setAttribute('aria-hidden', String(!surfaceVisible || !inspector.classList.contains('mascot-active')));
}

function syncDiagnosticsToggleControl() {
  const panel = elements.oscarDiagnostics;
  const toggle = elements.oscarDiagnosticsToggle;
  if (!panel || !toggle) return;
  const isOpen = panel.hasAttribute('open');
  const label = isOpen ? 'Закрыть статус Oscar' : 'Открыть статус Oscar';
  toggle.setAttribute('aria-expanded', String(isOpen));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

async function savePermissionProfile() {
  if (!elements.autonomyModeSelect) return;
  elements.autonomyModeSelect.disabled = true;
  try {
    const profile = await updateAutonomyMode(elements.autonomyModeSelect.value);
    if (state.data) state.data.permissions = profile;
  } catch (error) {
    if (elements.permissionProfileNote) {
      elements.permissionProfileNote.textContent = readErrorMessage(error);
      elements.permissionProfileNote.classList.add('error-text');
    }
  } finally {
    elements.autonomyModeSelect.disabled = false;
    renderPermissionSettings();
  }
}

function renderPermissionSettings() {
  renderAuthorityStatus();
  const profile = state.data?.permissions;
  if (!profile) return;
  const autonomyMode = profile.autonomyMode
    || (profile.sandboxMode === 'read-only' ? 'guided' : profile.sandboxMode === 'danger-full-access' ? 'full-local' : 'workspace-autonomous');
  if (elements.autonomyModeSelect) elements.autonomyModeSelect.value = autonomyMode;
  syncComputerUsePermissionProfile(profile);
  if (!elements.permissionProfileNote) return;
  elements.permissionProfileNote.classList.remove('error-text');
  const descriptions = {
    guided: 'Чтения выполняются свободно; изменения, запуск и сеть требуют точного разового разрешения.',
    'workspace-autonomous': 'Чтения и обратимые изменения внутри workspace автономны. Удаление, внешние адреса и системные действия остаются под контролем.',
    'full-local': 'Обычные локальные действия автономны. Необратимые, внешние и security-sensitive операции всё равно проходят hard boundaries.',
  };
  elements.permissionProfileNote.textContent = descriptions[autonomyMode] || '';
  renderSecurityPolicyControls();
  renderAgencyControls();
}

function renderAuthorityStatus() {
  const authority = state.data?.authority;
  const owner = authority?.tier === 'owner' && authority?.source === 'signed-device-entitlement';
  if (elements.authorityStatusCard) elements.authorityStatusCard.dataset.tier = owner ? 'owner' : 'public';
  if (elements.authorityTier) elements.authorityTier.textContent = owner ? 'Owner' : 'Public';
  if (elements.authorityDetail) {
    const device = owner && authority.deviceIdPrefix ? ` · устройство ${authority.deviceIdPrefix}` : '';
    const diagnostic = !owner && authority?.diagnostic ? ` · ${authority.diagnostic}` : '';
    elements.authorityDetail.textContent = owner
      ? `Подписанное локальное право активно${device}`
      : `Стандартная публичная политика${diagnostic}`;
  }
}

function renderAgencyControls() {
  const leases = Array.isArray(state.data?.agency?.activeLeases) ? state.data.agency.activeLeases : [];
  const actions = Array.isArray(state.data?.agency?.recentActions) ? state.data.agency.recentActions : [];
  if (elements.revokeAllLeases) elements.revokeAllLeases.disabled = leases.length === 0;
  if (elements.activeLeasesList) {
    elements.activeLeasesList.innerHTML = leases.length > 0
      ? leases.map((lease) => `<div class="agency-control-item"><div><strong>${escapeAttribute(lease.capabilities?.join(', ') || 'task lease')}</strong><span>${escapeAttribute(`${lease.usage?.actions || 0}/${lease.budgets?.maxActions || 0} действий · до ${new Date(lease.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`)}</span></div><button type="button" data-revoke-lease="${escapeAttribute(lease.leaseId)}">Отозвать</button></div>`).join('')
      : '<span class="setting-note">Нет активных разрешений</span>';
  }
  if (elements.actionLedgerList) {
    elements.actionLedgerList.innerHTML = actions.length > 0
      ? actions.slice(0, 12).map((action) => `<div class="agency-control-item"><div><strong>${escapeAttribute(action.capabilityId || 'action')}</strong><span>${escapeAttribute(`${action.status || 'unknown'} · ${action.summary || action.error || ''}`)}</span></div>${action.rollback?.status === 'available' ? `<button type="button" data-rollback-action="${escapeAttribute(action.ledgerId)}">Откатить</button>` : `<code>${escapeAttribute(action.rollback?.status === 'rolled-back' ? 'откачено' : String(action.ledgerId || '').slice(-8))}</code>`}</div>`).join('')
      : '<span class="setting-note">Действий пока нет</span>';
  }
}

async function revokeLeaseAndRefresh(leaseId) {
  if (!leaseId) return;
  await revokeCapabilityLease(leaseId);
  updateState(await fetchState());
}

async function revokeAllLeasesAndRefresh() {
  const leases = Array.isArray(state.data?.agency?.activeLeases) ? state.data.agency.activeLeases : [];
  await Promise.all(leases.map((lease) => revokeCapabilityLease(lease.leaseId)));
  updateState(await fetchState());
}

async function rollbackActionAndRefresh(ledgerId, button) {
  if (!ledgerId) return;
  button.disabled = true;
  try {
    await rollbackAction(ledgerId);
  } catch (error) {
    button.textContent = readErrorMessage(error);
  } finally {
    updateState(await fetchState());
  }
}

function escapeAttribute(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderMascot(activeView = readActiveViewId()) {
  const execution = state.data?.lastIntent?.execution;
  const output = execution?.output;
  const reply = typeof output?.reply === 'string' ? output.reply : '';
  const backend = state.oscar?.status?.backend;
  const backendConnected = Boolean(backend?.connected);
  const backendAttempted = Boolean(backend?.startupAttempted);
  const backendNeedsAttention = Boolean(backend && !backendConnected && backendAttempted);
  const detail = backendConnected
    ? 'Локально · готов'
    : backendNeedsAttention
      ? 'Backend не запустился'
      : 'Backend готов к запуску';
  syncMascotFromRuntime({
    activeView,
    busy: Boolean(state.busy || state.oscar?.busy),
    errored: Boolean(execution?.error || state.oscar?.error || backendNeedsAttention),
    securityRunning: Boolean(state.security?.status?.runtime?.running),
    coding: /```/.test(reply),
    detail,
  });
  updateInspectorToggleControls(preferences.inspector === 'closed');
}

function readActiveViewId() {
  return document.querySelector('.nav-item.active')?.getAttribute('data-scroll-target') || 'oscar-section';
}


function getDropdownPopovers() {
  return [
    elements.modelPopover,
    document.querySelector('#oscar-model-popover'),
    document.querySelector('#oscar-research-popover'),
  ].filter(Boolean);
}

function getControlledDropdown(trigger) {
  const id = trigger?.getAttribute('aria-controls');
  return id ? document.getElementById(id) : trigger?.closest('.custom-dropdown')?.querySelector('.dropdown-popover');
}

function getDropdownTrigger(popover) {
  return popover?.closest('.custom-dropdown')?.querySelector('.dropdown-trigger');
}

function syncOscarDropdownLift(popover) {
  const composer = popover?.closest('#oscar-composer');
  if (!composer) return;
  const trigger = getDropdownTrigger(popover);
  const input = composer.querySelector('#oscar-input');
  if (!trigger || !input) return;
  const triggerRect = trigger.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();
  const lift = Math.max(64, Math.min(120, Math.ceil(triggerRect.top - inputRect.top + 10)));
  popover.style.setProperty('--composer-dropdown-lift', `${lift}px`);
}

function openDropdown(popover, options = {}) {
  if (!popover) return;
  syncOscarDropdownLift(popover);
  popover.classList.remove('hidden');
  popover.setAttribute('aria-hidden', 'false');
  getDropdownTrigger(popover)?.setAttribute('aria-expanded', 'true');
  if (options.focus) focusDropdownItem(popover, options.focus);
}

function toggleDropdown(popover) {
  if (!popover) return;
  if (popover.classList.contains('hidden')) openDropdown(popover);
  else closeDropdown(popover);
}

function closeDropdown(popover) {
  if (!popover) return;
  popover.classList.add('hidden');
  popover.setAttribute('aria-hidden', 'true');
  getDropdownTrigger(popover)?.setAttribute('aria-expanded', 'false');
}

function closeOtherDropdowns(activePopover) {
  getDropdownPopovers().forEach((popover) => {
    if (popover !== activePopover && !popover.contains(activePopover)) closeDropdown(popover);
  });
}

function closeAllDropdowns() {
  getDropdownPopovers().forEach(closeDropdown);
}

function getEnabledDropdownItems(popover) {
  return [...popover.querySelectorAll('.dropdown-item[data-value]')]
    .filter((item) => item.closest('.dropdown-popover') === popover && item.getAttribute('aria-disabled') !== 'true');
}

function focusDropdownItem(popover, preference = 'active') {
  const enabledItems = getEnabledDropdownItems(popover);
  if (!enabledItems.length) return;
  let item = popover.querySelector('.dropdown-item.active[aria-disabled="false"], .dropdown-item.active:not([aria-disabled])');
  if (preference === 'first') item = enabledItems[0];
  if (preference === 'last') item = enabledItems[enabledItems.length - 1];
  if (!item || item.getAttribute('aria-disabled') === 'true') item = enabledItems[0];
  item.focus({ preventScroll: true });
}

function focusRelativeDropdownItem(currentItem, offset) {
  const popover = currentItem.closest('.dropdown-popover');
  if (!popover) return;
  const enabledItems = getEnabledDropdownItems(popover);
  if (!enabledItems.length) return;
  const currentIndex = Math.max(enabledItems.indexOf(currentItem), 0);
  const nextIndex = (currentIndex + offset + enabledItems.length) % enabledItems.length;
  enabledItems[nextIndex].focus({ preventScroll: true });
}

function syncChatModelDropdowns() {
  syncDropdown({
    button: elements.modelDropdownBtn,
    popover: elements.modelPopover,
    value: (state.chat && state.chat.modelSelection) || 'auto',
    prefix: 'Модель',
    labelPrefix: 'Выбрать модель',
    labels: MODEL_LABELS,
  });
}

function syncOscarContextMeter(visible, contextWindow) {
  const meter = document.querySelector('#oscar-context-meter');
  if (!meter) return;
  meter.hidden = !visible;

  const meterState = resolveOscarContextMeterState(contextWindow);
  const { hasTelemetry, percent, remainingPercent, total, used } = meterState;
  const valueCircle = meter.querySelector('.oscar-context-meter-value');
  const percentLabel = meter.querySelector('[data-context-meter-percent]');
  const tokensLabel = meter.querySelector('[data-context-meter-tokens]');
  const note = meter.querySelector('[data-context-meter-note]');

  meter.classList.toggle('has-telemetry', hasTelemetry);
  meter.dataset.usage = meterState.usage;
  if (valueCircle) valueCircle.style.strokeDashoffset = String(100 - percent);
  if (hasTelemetry) {
    meter.setAttribute('aria-valuenow', String(percent));
    meter.setAttribute('aria-valuetext', `${percent}% использовано, осталось ${remainingPercent}%`);
    meter.setAttribute('aria-label', `Контекстное окно: ${percent}% использовано, ${formatOscarContextTokenCount(used)} из ${formatOscarContextTokenCount(total)} токенов`);
    if (percentLabel) percentLabel.textContent = `${percent}% использовано · осталось ${remainingPercent}%`;
    if (tokensLabel) tokensLabel.textContent = `${formatOscarContextTokenCount(used)} / ${formatOscarContextTokenCount(total)} токенов`;
    const contextNote = meterState.contextTrimmed
      ? `История сжата${meterState.droppedMessages ? ` · исключено сообщений: ${meterState.droppedMessages}` : ''}`
      : '';
    if (note) {
      note.textContent = contextNote;
      note.hidden = !contextNote;
    }
  } else {
    meter.removeAttribute('aria-valuenow');
    meter.setAttribute('aria-valuetext', 'Данные появятся после ответа');
    meter.setAttribute('aria-label', 'Контекстное окно: данные появятся после ответа');
    if (percentLabel) percentLabel.textContent = 'Данные появятся после ответа';
    if (tokensLabel) tokensLabel.textContent = 'Использование пока не измерено';
    if (note) {
      note.textContent = '';
      note.hidden = true;
    }
  }
}

function syncOscarModelDropdowns() {
  if (['gemma4-deepthinking', 'gemma4-31b', 'powerful', 'reasoning', 'pro', 'extra'].includes(
    String(state.oscar?.modelSelection || '').toLowerCase(),
  )) {
    state.oscar.modelSelection = 'qwen3.8-27b-pro';
  }
  const modelStatus = readOscarModelStatus(state.oscar);
  const available = readSelectableOscarModelAvailability() || modelStatus?.available_tiers || null;
  const installedOnly = state.data?.components?.schemaVersion === 2;
  syncModelAvailability(document.querySelector('#oscar-model-popover'), available, installedOnly);
  syncModelAvailability(elements.modelPopover, available, installedOnly);

  if (available && state.oscar?.modelSelection !== 'none' && available[state.oscar.modelSelection] === false) {
    state.oscar.modelSelection = 'none';
  }
  const intelligenceEnabled = state.oscar?.intelligenceEnabled === true;
  const contextMeterVisible = preferences.contextMeterVisible !== false;
  const contextControls = document.querySelector('#oscar-context-controls');
  const modelContainer = document.querySelector('#oscar-model-dropdown-container');
  const intelligenceToggle = document.querySelector('#oscar-intelligence-toggle');
  const intelligenceState = intelligenceToggle?.querySelector('[data-intelligence-state]');
  const contextMeterToggle = document.querySelector('#oscar-context-meter-toggle');
  const contextMeterState = contextMeterToggle?.querySelector('[data-context-meter-state]');
  if (contextControls) contextControls.hidden = !intelligenceEnabled && !contextMeterVisible;
  if (modelContainer) modelContainer.hidden = !intelligenceEnabled;
  elements.oscarComposer?.classList.toggle('intelligence-enabled', intelligenceEnabled);
  elements.oscarComposer?.classList.toggle('context-meter-enabled', contextMeterVisible);
  if (intelligenceToggle) {
    intelligenceToggle.classList.toggle('is-active', intelligenceEnabled);
    intelligenceToggle.setAttribute('aria-pressed', String(intelligenceEnabled));
  }
  if (intelligenceState) intelligenceState.textContent = intelligenceEnabled ? 'Вкл' : 'Выкл';
  if (contextMeterToggle) {
    contextMeterToggle.classList.toggle('is-active', contextMeterVisible);
    contextMeterToggle.setAttribute('aria-pressed', String(contextMeterVisible));
  }
  if (contextMeterState) contextMeterState.textContent = contextMeterVisible ? 'Вкл' : 'Выкл';
  if (!intelligenceEnabled) closeDropdown(document.querySelector('#oscar-model-popover'));
  const modelValue = (state.oscar && state.oscar.modelSelection) || 'none';
  syncDropdown({
    button: document.querySelector('#oscar-model-dropdown-btn'),
    popover: document.querySelector('#oscar-model-popover'),
    value: modelValue,
    prefix: 'Модель',
    separator: ' · ',
    displayPrefix: false,
    labelPrefix: 'Выбрать модель Oscar',
    labels: MODEL_LABELS,
  });
  syncDropdown({
    button: document.querySelector('#oscar-research-dropdown-btn'),
    popover: document.querySelector('#oscar-research-popover'),
    value: (state.oscar && state.oscar.researchMode) || 'auto',
    prefix: 'Исследование',
    separator: ' · ',
    labelPrefix: 'Выбрать исследование Oscar',
    labels: {
      auto: 'Авто',
      off: 'выкл',
      deep: 'Глубокое',
    },
  });

  const modelButton = document.querySelector('#oscar-model-dropdown-btn');
  const modelLabel = MODEL_LABELS[modelValue] || modelValue;
  if (modelButton) {
    modelButton.textContent = modelLabel;
    modelButton.dataset.modelPower = modelValue === 'qwen3.8-27b-pro' ? 'max' : 'standard';
    const accessibleLabel = `Настроить модель Oscar: ${modelLabel}`;
    modelButton.setAttribute('aria-label', accessibleLabel);
    modelButton.title = accessibleLabel;
  }
  const modelCaption = document.querySelector('[data-intelligence-model-caption]');
  if (modelCaption) {
    const descriptions = {
      none: 'Oscar подбирает под задачу',
      'gemma4-fast': 'Быстрые ответы и простые команды',
      'gemma4-balanced': 'Баланс скорости и качества',
      'qwen3.8-27b-pro': 'Сложные задачи и полный Agent',
    };
    modelCaption.textContent = descriptions[modelValue] || 'Ручной выбор модели';
  }
  const intelligenceScale = document.querySelector('#oscar-intelligence-scale');
  const availableScale = readAvailableOscarModelScale();
  if (intelligenceScale) {
    intelligenceScale.dataset.selection = modelValue;
    intelligenceScale.dataset.power = String(Math.max(0, OSCAR_MODEL_SCALE.indexOf(modelValue) + 1));
    intelligenceScale.dataset.availableCount = String(availableScale.length);
  }
  const intelligenceRange = document.querySelector('#oscar-intelligence-range');
  if (intelligenceRange instanceof HTMLInputElement) {
    const modelIndex = availableScale.indexOf(modelValue);
    const rangeIndex = modelIndex >= 0 ? modelIndex : Math.max(0, Math.floor((availableScale.length - 1) / 2));
    const progress = availableScale.length > 1 ? (rangeIndex / (availableScale.length - 1)) * 100 : 50;
    intelligenceRange.max = String(Math.max(0, availableScale.length - 1));
    intelligenceRange.disabled = availableScale.length <= 1;
    intelligenceRange.value = String(rangeIndex);
    intelligenceRange.closest('.oscar-intelligence-range-shell')?.style.setProperty('--intelligence-progress', `${progress}%`);
    intelligenceRange.dataset.auto = String(modelIndex < 0);
    intelligenceRange.setAttribute('aria-valuetext', modelLabel);
    intelligenceRange.title = `Модель: ${modelLabel}`;
  }
  const conversationId = String(state.oscar?.conversationId || '').trim();
  const contextWindow = conversationId
    ? state.oscar?.contextWindows?.[conversationId] || null
    : null;
  syncOscarContextMeter(contextMeterVisible, contextWindow);
}

function syncModelAvailability(popover, available, hideUnavailable = false) {
  if (!popover || !available) return;
  popover.querySelectorAll('.dropdown-item[data-value]').forEach((item) => {
    if (item.closest('.dropdown-popover') !== popover) return;
    const value = item.getAttribute('data-value');
    if (!value || value === 'auto' || value === 'none') return;
    const disabled = available[value] === false;
    item.hidden = hideUnavailable && disabled;
    item.setAttribute('aria-disabled', String(disabled));
    if (disabled) item.tabIndex = -1;
    item.title = disabled ? 'Файл этой модели отсутствует или повреждён' : '';
    const subtitle = item.querySelector('.item-sub');
    if (subtitle) {
      if (!subtitle.dataset.availableLabel) subtitle.dataset.availableLabel = subtitle.textContent || '';
      subtitle.textContent = disabled ? 'Недоступна · проверь файл модели' : subtitle.dataset.availableLabel;
    }
  });
}

function readSelectableOscarModelAvailability() {
  return resolveSelectableOscarModelAvailability(state.data, OSCAR_MODEL_SCALE);
}

function readAvailableOscarModelScale() {
  return filterSelectableOscarModelScale(OSCAR_MODEL_SCALE, readSelectableOscarModelAvailability());
}

function resolveOscarManualModelSelection(preferredModel = '') {
  const availableScale = readAvailableOscarModelScale();
  if (preferredModel && availableScale.includes(preferredModel)) return preferredModel;
  return availableScale[Math.max(0, Math.floor((availableScale.length - 1) / 2))] || 'none';
}

function setActiveNavItem(activeItem) {
  document.querySelectorAll('.nav-item').forEach((item) => {
    const isActive = item === activeItem;
    item.classList.toggle('active', isActive);
    if (item.hasAttribute('data-scroll-target')) {
      if (isActive) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
  });
}

function syncDropdown({ button, popover, value, prefix, labels, separator = ': ', labelPrefix, displayPrefix = true }) {
  const selectedLabel = labels[value] || value;
  if (button) {
    const buttonLabel = displayPrefix ? prefix + separator + selectedLabel : selectedLabel;
    const accessibleLabel = (labelPrefix || `Выбрать ${prefix.toLowerCase()}`) + ': ' + selectedLabel;
    const valueTarget = button.querySelector('[data-dropdown-value]');
    if (valueTarget) valueTarget.textContent = selectedLabel;
    else button.textContent = buttonLabel;
    button.setAttribute('aria-label', accessibleLabel);
    button.title = accessibleLabel;
  }
  if (!popover) return;
  popover.querySelectorAll('.dropdown-item').forEach((item) => {
    if (item.closest('.dropdown-popover') !== popover) return;
    const isActive = item.getAttribute('data-value') === value;
    if (isActive) item.classList.add('active');
    else item.classList.remove('active');
    item.setAttribute('aria-selected', String(isActive));
    item.tabIndex = isActive && item.getAttribute('aria-disabled') !== 'true' ? 0 : -1;
  });
}
