import { initReminders } from './modules/reminders-pane.js';
import { reducedUiMotion, setUiMotionPreference } from './modules/ui-motion.js';
import { initSharedSelects } from './modules/ui-select.js';
import { initCompactLayout } from './modules/compact-layout.js';
import { renderMaxModeButton } from './modules/max-identity.js';
import { initUiNavigation } from './modules/ui-navigation.js';
import { state, updateState, subscribeState } from './modules/state.js';
import { executeCapability, fetchState, revokeCapabilityLease, rollbackAction, updateAutonomyMode } from './modules/api.js';
import './modules/test-suite.js';
import { escapeHtml, readErrorMessage, readOscarModelStatus, renderError } from './modules/utils.js';
import { formatOscarContextTokenCount, resolveOscarContextMeterState } from './modules/oscar-context-meter.js';
import { cancelIntentJobAction, initChatPane, renderChatPane, submitIntentAction, renderThread } from './modules/chat-pane.js';
import { initOscarPane, loadOscarConversations, loadOscarStatus, renderOscar, startNewOscarConversation } from './modules/oscar-pane.js';
import { initSecurityPane, loadSecurityStatus, renderSecurity, renderSecurityPolicyControls } from './modules/security-pane.js';
import { initModelManager, renderModelManager } from './modules/model-manager.js';
import { initModelOnboarding, renderModelOnboarding } from './modules/model-onboarding.js';
import { initSettingsExtras, renderSettingsExtras } from './modules/settings-extras.js';
import { initServiceSwitcher } from './modules/service-switcher.js';
import { initPaperPixel } from './modules/paper-pixel.js';
import { customModelLabel, initCustomModelsPane, isReadyCustomModel, renderCustomModelsPane, syncComposerCustomModels } from './modules/custom-models-pane.js';
import { initModelSetupWelcome, renderModelSetupWelcome } from './modules/model-setup-welcome.js';
import { initSharingPane, renderSharingPane } from './modules/sharing-pane.js';
import { deriveOscarMascotRuntime, initMascotInteraction, syncMascotFromRuntime } from './modules/mascot-controller.js';
import { initSettingsPane } from './modules/settings-pane.js';
import { initUpdatePane } from './modules/update-pane.js';
import { mountMonarchMarks } from './modules/brand-mark.js';
import { initVoiceInput } from './modules/voice-input.js';
import { initOscarVoiceMode } from './modules/oscar-voice-mode.js';
import { initVoiceWakeService } from './modules/voice-wake-service.js';
import { installOscarSnakeEasterEgg } from './modules/oscar-snake-game.js';
import { installMonarchBrandEasterEgg } from './modules/brand-easter-egg.js';
import { initCoderPane } from './modules/coder-pane.js';
import { initImageGenerationPane, renderImageGenerationPane } from './modules/image-generation-pane.js';
import { msUntilThemeBoundary, normalizeUiPreferences, resolveTheme, serializeUiPreferences } from './modules/ui-preferences.js';
import { initComputerUseControl, syncComputerUsePermissionProfile } from './modules/computer-use-control.js';
import { closeOscarComposerMenu, initOscarPlusMenu } from './modules/oscar-plus-menu.js';
import { installComposerTypeToFocus } from './modules/composer-type-to-focus.js';
import { copyTextToClipboard } from './modules/clipboard.js';
import { initAstraMaxSetup } from './modules/astra-max-setup.js';
import { renderAccessMatrix } from './modules/access-matrix.js';
import { initAwaySummary } from './modules/away-summary.js';
import { renderSystemMap } from './modules/system-map.js';
import { initHelpPanel } from './modules/help-panel.js';
import { createLanguagePicker, detectUiLanguage, setUiLanguage } from './modules/ui-i18n.js';
import { initEarlyAccessNotices, mountSecurityDevelopmentBanner } from './modules/early-access-notice.js';
import {
  resolveSelectableOscarModelAvailability,
} from './modules/oscar-model-availability.js';

// Auto theme: Windows' scheme and the clock timer (applyTheme owns both).
const systemDarkQuery = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
let autoThemeTimer;

// Elements
const elements = {
  intentInput: document.querySelector('#intent-input'),
  oscarInput: document.querySelector('#oscar-input'),
  oscarComposer: document.querySelector('#oscar-composer'),
  thread: document.querySelector('#thread'),
  shell: document.querySelector('#app-shell'),
  densitySelect: document.querySelector('#density-select'),
  themeSelect: document.querySelector('#theme-select'),
  motionSelect: document.querySelector('#motion-select'),
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
  accessMatrix: document.querySelector('#access-matrix'),
  systemMap: document.querySelector('#system-map'),
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
  'gemma4-fast': 'Fast 2B',
  'gemma4-balanced': 'Balanced 12B',
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

const DEFAULT_STARTUP_TYPE = 'mark';
const STARTUP_TYPE_LABELS = Object.freeze({
  mark: 'Знак Monarch',
  disabled: 'Отключена',
});
const startupMotionTemplate = document.querySelector('#startup-motion')?.cloneNode(true) || null;
let activeStartupPreviewCleanup = null;

const preferences = readPreferences();
// The interface language paints before the rest of the shell settles.
void setUiLanguage(preferences.language || detectUiLanguage());
mountSettingsLanguagePicker();
let astraMaxMode = null;
state.oscar = state.oscar || {};
state.oscar.reasoningEffort = preferences.reasoningEffort;
const reducedMotionMedia = reducedUiMotion;
const animatedMotionKeys = new Set();
let typingTimer = 0;
let safeLaunchFeedbackTimer = 0;
let securityStatusRequested = false;
let componentStateTimer = 0;
let astraProductPilotActive = false;

/** Sidebar "Поймал баг?": the bug runs off to the right, then the letter form
 * opens in Settings -> System -> "Если что-то не работает". Desktop only. */
function initBugNavItem() {
  const button = document.querySelector('[data-report-bug]');
  if (!button || typeof window.monarchDesktop?.reportBug !== 'function') return;
  button.hidden = false;
  button.addEventListener('click', () => {
    const open = () => {
      window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view: 'settings-section', subview: 'system' } }));
      const help = document.querySelector('#monarch-help');
      const panel = help?.closest('[data-settings-panel="system"]');
      const groups = [...document.querySelectorAll('[data-settings-panel="system"]')]
        .filter((group) => !group.classList.contains('legacy-system-diagnostics') && !group.classList.contains('service-switcher'));
      document.querySelectorAll('.system-switcher [role="tab"]')[groups.indexOf(panel)]?.click();
      help?.dispatchEvent(new CustomEvent('monarch:open-bug-report'));
    };
    const icon = button.querySelector('.nav-bug-icon');
    if (reducedUiMotion.matches || !icon?.animate) { open(); return; }
    icon.getAnimations().forEach((animation) => animation.cancel());
    // The bug scurries off along the row, the form opens as it leaves.
    icon.animate([
      { transform: 'translateX(0) rotate(0deg)' },
      { transform: 'translateX(4px) rotate(90deg)', offset: 0.25 },
      { transform: 'translateX(150px) rotate(90deg)', opacity: 0, offset: 0.6 },
      { transform: 'translateX(-14px) rotate(90deg)', opacity: 0, offset: 0.61 },
      { transform: 'translateX(0) rotate(0deg)', opacity: 1 },
    ], { duration: 1100, easing: 'cubic-bezier(.4, 0, .2, 1)' });
    setTimeout(open, 260);
  });
}

/** What a bug report says about the app: look, language and model state. No chats, keys or paths. */
function describeAppForBugReport() {
  const root = document.documentElement;
  const components = state.data?.components;
  const models = [...(components?.models || []), ...(components?.extras || [])]
    .map((model) => `${model.role}: ${model.installed ? 'скачана' : model.phase}${model.phase === 'failed' ? ' (ошибка)' : ''}`)
    .join(', ');
  return [
    `Вид: ${root.dataset.design || 'обычный'}, тема ${root.dataset.theme || 'авто'}, язык ${root.lang || 'ru'}`,
    `Режим работы: ${state.data?.modelPreference?.work || 'не выбран'}`,
    `Первая настройка: ${components?.onboarding?.completion || 'нет данных'}`,
    models ? `Модели: ${models}` : null,
  ].filter(Boolean).join('\n');
}

// Render Coordinator
function render() {
  if (state.data?.permissions) syncComputerUsePermissionProfile(state.data.permissions);
  renderModelOnboarding();
  renderModelSetupWelcome();
  scheduleComponentStateRefresh(state.data?.components);
  renderModelManager();
  renderCustomModelsPane();
  renderSettingsExtras();
  renderActiveView(readActiveViewId());
  renderMascot();
}

function renderActiveView(activeView) {
  if (activeView === 'oscar-section') {
    syncOscarModelDropdowns();
    if (!astraProductPilotActive) renderOscar();
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
    closeOscarComposerMenu({ immediate: true });
    const popover = document.querySelector('#oscar-model-popover');
    toggleDropdown(popover);
    closeOtherDropdowns(popover);
    return;
  }

  const oscarWebToggleButton = event.target.closest('#oscar-web-toggle');
  if (oscarWebToggleButton) {
    state.oscar = state.oscar || {};
    if (state.data?.ownerDev?.internetEnabled === false) return;
    state.oscar.web = state.oscar.web !== true;
    syncOscarModelDropdowns();
    return;
  }

  const oscarEffortChoice = event.target.closest('#oscar-model-popover [data-effort]');
  if (oscarEffortChoice) {
    if (oscarEffortChoice.getAttribute('aria-disabled') === 'true') return;
    setOscarReasoningEffort(oscarEffortChoice.getAttribute('data-effort'));
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
    state.oscar.modelSelection = oscarModelDropdownItem.getAttribute('data-value') || 'none';
    window.dispatchEvent(new CustomEvent('monarch-local-model-selected'));
    syncOscarModelDropdowns();
    closeDropdown(oscarModelPopover);
    import('./modules/oscar-pane.js').then(m => m.renderOscar && m.renderOscar());
    return;
  }

  const oscarResearchChoice = event.target.closest('#oscar-model-popover [data-research]');
  if (oscarResearchChoice) {
    state.oscar = state.oscar || {};
    state.oscar.researchMode = oscarResearchChoice.getAttribute('data-research') || 'auto';
    syncOscarModelDropdowns();
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
  if (navItem) activatePrimaryView(navItem, { subview: event.detail?.subview, focusContent: event.detail?.focusContent });
});

window.addEventListener('monarch:settings-selection', event => {
  if (document.querySelector('#settings-section')?.classList.contains('view-hidden')) return;
  const selector = event.detail?.tab === 'memory'
    ? '.nav-item[data-settings-open="memory"]'
    : '.nav-item[data-scroll-target="settings-section"]:not([data-settings-open])';
  const item = document.querySelector(selector);
  if (item) setActiveNavItem(item);
});

function activatePrimaryView(navItem, { subview, focusContent = false } = {}) {
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
      'sharing-section',
      'logs-section',
      'settings-section'
    ];
    views.forEach(id => {
      const element = document.getElementById(id);
      if (element) element.classList.add('view-hidden');
    });
    target.classList.remove('view-hidden');
    resetViewScroll(target);
    renderActiveView(targetId);
    window.dispatchEvent(new CustomEvent('monarch:view-change', { detail: { view: targetId } }));
    const settingsTab = subview || navItem.getAttribute('data-settings-open');
    if (targetId === 'settings-section') {
      window.dispatchEvent(new CustomEvent('monarch:settings-tab', { detail: { tab: settingsTab || 'models' } }));
    }
    if (subview && targetId !== 'settings-section') {
      const attribute = { 'security-section': 'data-security-tab', 'images-section': 'data-images-tab' }[targetId];
      const tab = attribute && [...target.querySelectorAll(`[${attribute}]`)].find(button => button.getAttribute(attribute) === subview && !button.hidden && !button.disabled);
      tab?.click();
    }
    if (focusContent) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    if ((targetId === 'security-section' || targetId === 'settings-section') && !securityStatusRequested) {
      securityStatusRequested = true;
      void loadSecurityStatus(render);
    }
    renderMascot(targetId);
    window.scrollTo(0, 0);
  };

  const reduceMotion = reducedUiMotion.matches === true;
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
  closeOscarComposerMenu();
  document.querySelectorAll('.composer-options[open]').forEach((details) => {
    if (details.id === 'oscar-composer-menu') return;
    details.removeAttribute('open');
  });
}

function resetViewScroll(target) {
  if (!(target instanceof Element)) return;
  const scrollTargets = [target, ...target.querySelectorAll('.document-feed')];
  for (const node of scrollTargets) {
    if (!(node instanceof HTMLElement)) continue;
    node.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }
}

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
  [elements.themeSelect, 'theme'],
  [elements.densitySelect, 'density'],
  [elements.motionSelect, 'motion'],
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

// Settings (custom models) and first setup pick a chat model through here, so
// the composer, MAX switch and model button stay one owner's state.
window.addEventListener('monarch:select-model', (event) => {
  const model = String(event.detail?.model || 'none');
  state.oscar = state.oscar || {};
  state.oscar.modelSelection = model;
  window.dispatchEvent(new CustomEvent('monarch-local-model-selected'));
  syncOscarModelDropdowns();
});

// One owner for interface preferences: other surfaces (first setup, the
// theme cards in Settings) ask here instead of writing storage themselves.
window.addEventListener('monarch:set-ui-preference', (event) => {
  const { key, value } = event.detail || {};
  if (!['design', 'theme', 'autoTheme', 'density', 'motion', 'language'].includes(key)) return;
  const next = normalizeUiPreferences({ ...serializeUiPreferences(preferences), [key]: value });
  if (next[key] !== value) return;
  preferences[key] = value;
  savePreferences();
  if (key === 'language') void setUiLanguage(value);
  else applyPreferences();
  window.dispatchEvent(new CustomEvent('monarch:ui-preferences-applied', { detail: { ...preferences } }));
});

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
async function init() {
  mountMonarchMarks();
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
  initReminders();
  initCustomModelsPane();
  initSettingsExtras();
  initServiceSwitcher();
  initPaperPixel();
  initEarlyAccessNotices();
  mountSecurityDevelopmentBanner();
  astraMaxMode = initAstraMaxSetup();
  applyOscarReasoningEffortToMax();
  initHelpPanel(document.querySelector('#monarch-help'), {
    escapeHtml,
    navigate: (view, subview) => window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view, ...(subview ? { subview } : {}) } })),
    checkOscar: async () => { await loadOscarStatus(render); return !state.oscar.error && Boolean(state.oscar.status); },
    openLogs: typeof window.monarchDesktop?.openLogs === 'function' ? () => window.monarchDesktop.openLogs() : undefined,
    reportBug: typeof window.monarchDesktop?.reportBug === 'function'
      ? (value) => window.monarchDesktop.reportBug({ ...value, version: state.data?.app?.version || '' })
      : undefined,
    reportContext: describeAppForBugReport,
    reducedMotion: reducedUiMotion,
  });
  initBugNavItem();
  // Updates must work even if a later part of startup fails or waits: they are
  // how a broken build gets replaced.
  try { initUpdatePane(); } catch (error) { console.error('Update panel failed to start.', error); }
  initAwaySummary({ openSecurity: () => window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view: 'security-section' } })) });
  initSharedSelects();
  let astraBridge = null;
  try {
    const { createAstraProductBridge } = await import('./modules/astra-product-bridge.js');
    astraBridge = await createAstraProductBridge();
  } catch (error) {
    console.error('Astra product pilot bootstrap failed closed.', error);
    const thread = document.querySelector('#oscar-thread');
    if (thread) thread.innerHTML = renderError('Astra product pilot не запущен: ' + readErrorMessage(error));
    return;
  }
  astraProductPilotActive = Boolean(astraBridge && astraBridge.surface === 'composer');
  if (astraProductPilotActive) await initOscarPane(render, { astra: { deployment: 'isolated-validation', bridge: astraBridge, maxMode: astraMaxMode } });
  else {
    await initOscarPane(render, { nativeAstra: astraBridge, maxMode: astraMaxMode });
  }
  initComputerUseControl();
  initOscarPlusMenu();
  initCoderPane();
  initSecurityPane(render);
  initSharingPane();
  initSettingsPane();
  initCompactLayout();
  initUiNavigation();
  initImageGenerationPane();
  initMascotInteraction();
  if (!astraProductPilotActive) {
    initVoiceInput();
    const voiceMode = initOscarVoiceMode();
    initVoiceWakeService({ voiceMode });
    installComposerTypeToFocus();
    installOscarSnakeEasterEgg({
      isConversationEmpty: () => state.oscar.messages.length === 0,
    });
  }
  installMonarchBrandEasterEgg();

  // Subscribe render to reactive state changes
  subscribeState(render);
  renderMascot();

  // Initial queries
  void loadState().then(() => {
    if (!astraProductPilotActive) {
      void loadOscarStatus(render);
      void loadOscarConversations();
    }
  });
}

// Start Monarch Web Shell
void init();

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

  playMarkStartupMotion(originalDOM, { completeShell: true });
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
  return Object.hasOwn(STARTUP_TYPE_LABELS, value) ? value : DEFAULT_STARTUP_TYPE;
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

// The two bands of the mark come in from above along their own diagonals and
// close into the sign, a light runs across the glass, then the bands lift a
// little and slide on down their slopes in opposite directions, through each
// other and out; only then does the app open. Timing follows the owner's sample
// (enter 650 ms with a long settle, hold 1 s with the sheen, lift 250 ms, exit
// 420 ms). One owner, HTML layers on the compositor, cancellable at any moment.
function playMarkStartupMotion(root, options = {}) {
  if (!(root instanceof HTMLElement)) return () => {};
  root.classList.remove('is-exiting', 'is-static');
  const frame = root.querySelector('[data-startup-mark]');
  const line = root.querySelector('[data-mark="line"]');
  const glass = root.querySelector('[data-mark="glass"]');
  const sheen = root.querySelector('[data-mark="sheen"]');
  const timers = [];
  const animations = [];
  let finished = false;
  let frameRequest = 0;

  const finish = (complete) => {
    if (finished) return;
    finished = true;
    if (frameRequest) cancelAnimationFrame(frameRequest);
    timers.forEach((timer) => window.clearTimeout(timer));
    animations.forEach((animation) => animation.cancel());
    root.remove();
    if (complete) options.onComplete?.();
  };
  const open = () => {
    root.classList.add('is-exiting');
    if (options.completeShell) elements.shell?.classList.add('startup-complete');
  };

  if (!frame || !line || !glass || !sheen || typeof line.animate !== 'function') {
    // Markup is incomplete: leave the app usable instead of a stuck overlay.
    if (options.completeShell) elements.shell?.classList.add('startup-complete');
    finish(true);
    return () => {};
  }

  if (reducedMotionMedia?.matches) {
    // No movement: the finished sign shows briefly, then the overlay fades.
    root.classList.add('is-static');
    timers.push(window.setTimeout(open, 500));
    timers.push(window.setTimeout(() => finish(true), 900));
    return () => finish(false);
  }

  const ENTER = 650;
  const HOLD = 1000;
  const LIFT = 250;
  const EXIT = 420;
  const total = ENTER + HOLD + LIFT + EXIT;
  const at = (ms) => ms / total;
  const start = () => {
    frameRequest = 0;
    const width = frame.getBoundingClientRect().width || 300;
    const unit = width / 49;
    // Unit vectors down each band's slope (17u across, 26u down).
    const length = Math.hypot(17, 26);
    const slope = { line: { x: 17 / length, y: 26 / length }, glass: { x: -17 / length, y: 26 / length } };
    const move = (direction, distance, lift = 0) =>
      `translate3d(${(direction.x * distance * unit).toFixed(1)}px, ${((direction.y * distance + lift) * unit).toFixed(1)}px, 0)`;
    const band = (element, direction) => {
      animations.push(element.animate([
        { transform: move(direction, -30), opacity: 0, offset: 0, easing: 'cubic-bezier(.22, 1, .36, 1)' },
        { transform: move(direction, -14), opacity: 1, offset: at(ENTER * .28), easing: 'cubic-bezier(.33, 1, .68, 1)' },
        { transform: move(direction, 0), opacity: 1, offset: at(ENTER), easing: 'linear' },
        { transform: move(direction, 0), opacity: 1, offset: at(ENTER + HOLD), easing: 'cubic-bezier(.45, 0, .55, 1)' },
        { transform: move(direction, 0, -1.1), opacity: 1, offset: at(ENTER + HOLD + LIFT), easing: 'cubic-bezier(.55, 0, .9, .45)' },
        { transform: move(direction, 34, -1.1), opacity: 1, offset: at(ENTER + HOLD + LIFT + EXIT * .7), easing: 'linear' },
        { transform: move(direction, 48, -1.1), opacity: 0, offset: 1 },
      ], { duration: total, fill: 'both' }));
    };
    band(line, slope.line);
    band(glass, slope.glass);
    // From the glass's left edge to past its right one, along the band.
    animations.push(sheen.animate([
      { transform: `translateX(${(0.30 * width).toFixed(1)}px) rotate(33.18deg)`, opacity: 0 },
      { transform: `translateX(${(0.46 * width).toFixed(1)}px) rotate(33.18deg)`, opacity: 1, offset: .3 },
      { transform: `translateX(${(0.86 * width).toFixed(1)}px) rotate(33.18deg)`, opacity: 1, offset: .8 },
      { transform: `translateX(${(1.02 * width).toFixed(1)}px) rotate(33.18deg)`, opacity: 0 },
    ], { duration: 520, delay: ENTER + 230, easing: 'cubic-bezier(.45, 0, .55, 1)', fill: 'both' }));
    // The app opens once the bands have gone.
    timers.push(window.setTimeout(open, total - 40));
    timers.push(window.setTimeout(() => finish(true), total + 460));
  };
  // Start on the first painted frame, so loading work cannot eat the entrance.
  frameRequest = requestAnimationFrame(() => { frameRequest = requestAnimationFrame(start); });
  return () => finish(false);
}

function previewStartupMotion(value) {
  const startupType = normalizeStartupType(value);
  if (startupType === 'disabled') {
    syncStartupPreferenceControls();
    return;
  }

  activeStartupPreviewCleanup?.();
  document.querySelector('#startup-motion')?.remove();
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

  if (!(startupMotionTemplate instanceof HTMLElement) || !elements.shell) {
    syncStartupPreferenceControls();
    return;
  }
  const previewRoot = startupMotionTemplate.cloneNode(true);
  elements.shell.before(previewRoot);
  cleanup = playMarkStartupMotion(previewRoot, { onComplete: finish });
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

/** Settings → System: the interface language, next to the theme. */
function mountSettingsLanguagePicker() {
  const section = document.querySelector('.settings-appearance');
  if (!section || section.querySelector('.settings-language')) return;
  const row = document.createElement('div');
  row.className = 'settings-appearance-row settings-language';
  const copy = document.createElement('span');
  copy.innerHTML = '<strong>Язык интерфейса</strong><small>Русский, українська, English или български. Язык ответов Оскара — в «Стиле ответов».</small>';
  row.append(copy, createLanguagePicker({ onChange: (language) => window.dispatchEvent(new CustomEvent('monarch:set-ui-preference',
    { detail: { key: 'language', value: language } })) }));
  const setupRow = section.querySelector('.settings-appearance-row');
  if (setupRow) setupRow.before(row); else section.append(row);
}

function savePreferences() {
  try {
    localStorage.setItem('monarch.ui.preferences', JSON.stringify(serializeUiPreferences(preferences)));
  } catch {
    // UI preferences are optional; Monarch should still boot without browser storage.
  }
}

/** Paint the resolved theme. "auto" asks the desktop host to follow Windows
 * (so prefers-color-scheme tells the truth) or re-checks at 07:00 / 20:00. */
function applyTheme() {
  const followsSystem = preferences.theme === 'auto' && preferences.autoTheme === 'system';
  const theme = resolveTheme(preferences, { systemDark: systemDarkQuery?.matches === true });
  document.documentElement.dataset.design = preferences.design;
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preferences.theme;
  document.documentElement.dataset.autoTheme = preferences.autoTheme;
  document.documentElement.style.colorScheme = theme;
  window.monarchDesktop?.setTheme?.(followsSystem ? 'system' : theme).catch(() => {});
  clearTimeout(autoThemeTimer);
  if (preferences.theme === 'auto' && preferences.autoTheme === 'time') {
    autoThemeTimer = setTimeout(applyTheme, msUntilThemeBoundary());
  }
}

systemDarkQuery?.addEventListener?.('change', () => {
  if (preferences.theme === 'auto' && preferences.autoTheme === 'system') applyTheme();
});
// A timer can oversleep with the computer; re-check the clock when Monarch is back.
window.addEventListener('focus', () => {
  if (preferences.theme === 'auto' && preferences.autoTheme === 'time') applyTheme();
});

function applyPreferences() {
  applyTheme();
  if (elements.themeSelect) elements.themeSelect.value = preferences.theme;
  document.body.dataset.density = preferences.density;
  setUiMotionPreference(preferences.motion);
  if (elements.motionSelect) elements.motionSelect.value = preferences.motion;

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

let systemMapGroup = 'all';
let renderedSystemMap = '';
function renderSystemMapPanel() {
  if (!elements.systemMap || !state.data?.system) return;
  const html = renderSystemMap(state.data.system, systemMapGroup, escapeHtml);
  if (html !== renderedSystemMap) { elements.systemMap.innerHTML = html; renderedSystemMap = html; }
}
elements.systemMap?.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-system-map-group]');
  if (!button) return;
  systemMapGroup = button.getAttribute('data-system-map-group') || 'all';
  renderSystemMapPanel();
});

function renderPermissionSettings() {
  renderAuthorityStatus();
  const profile = state.data?.permissions;
  if (!profile) return;
  const autonomyMode = profile.autonomyMode
    || (profile.sandboxMode === 'read-only' ? 'guided' : profile.sandboxMode === 'danger-full-access' ? 'full-local' : 'workspace-autonomous');
  if (elements.autonomyModeSelect) elements.autonomyModeSelect.value = autonomyMode;
  syncComputerUsePermissionProfile(profile);
  if (elements.accessMatrix) elements.accessMatrix.innerHTML = renderAccessMatrix(state.data?.permissionMatrix, autonomyMode, escapeHtml);
  if (!elements.permissionProfileNote) return;
  elements.permissionProfileNote.classList.remove('error-text');
  const descriptions = {
    guided: 'Читает сам. Любое изменение, запуск или выход в интернет — только после твоего разрешения.',
    'workspace-autonomous': 'Читает и меняет файлы проекта сам. Удаление, интернет и системные действия — только с твоего разрешения.',
    'full-local': 'Полный доступ открывает диск, куда ты сказал. Красные зоны, Safe, Windows и ключи остаются закрытыми.',
  };
  elements.permissionProfileNote.textContent = descriptions[autonomyMode] || '';
  renderSecurityPolicyControls();
  renderAgencyControls();
  renderSystemMapPanel();
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
  syncMascotFromRuntime({
    activeView,
    ...deriveOscarMascotRuntime(state.oscar, state.busy),
    securityRunning: Boolean(state.security?.status?.runtime?.running),
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
    meter.setAttribute('aria-label', `Объём текущего диалога: ${percent}% заполнено`);
    if (percentLabel) percentLabel.textContent = `${percent}% использовано · осталось ${remainingPercent}%`;
    if (tokensLabel) tokensLabel.textContent = 'Объём текущего диалога';
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
  // Model, reasoning depth and Internet sit in the composer itself: one click
  // to see them, two to change them. No switch in the + menu hides them.
  const contextMeterVisible = true;
  const contextControls = document.querySelector('#oscar-context-controls');
  if (contextControls) contextControls.hidden = false;
  elements.oscarComposer?.classList.add('context-meter-enabled');
  const internetAllowed = state.data?.ownerDev?.internetEnabled !== false;
  const webEnabled = internetAllowed && state.oscar?.web === true;
  const webToggle = document.querySelector('#oscar-web-toggle');
  if (webToggle) {
    webToggle.classList.toggle('is-active', webEnabled);
    webToggle.setAttribute('aria-pressed', String(webEnabled));
    webToggle.disabled = !internetAllowed;
    const webLabel = !internetAllowed ? 'Интернет запрещён в настройках'
      : webEnabled ? 'Интернет включён: Oscar ищет свежие данные. Нажми, чтобы выключить'
        : 'Интернет выключен. Нажми, чтобы искать свежие данные';
    webToggle.title = webLabel;
    webToggle.setAttribute('aria-label', webLabel);
  }
  elements.oscarComposer?.classList.toggle('web-enabled', webEnabled);
  if (String(state.oscar?.modelSelection || '').startsWith('custom-') && !isReadyCustomModel(state.oscar.modelSelection)) {
    state.oscar.modelSelection = 'none';
  }
  const modelValue = (state.oscar && state.oscar.modelSelection) || 'none';
  syncComposerCustomModels(modelValue);
  const modelLabels = modelValue.startsWith('custom-')
    ? { ...MODEL_LABELS, [modelValue]: customModelLabel(modelValue) || 'Своя модель' }
    : MODEL_LABELS;
  syncDropdown({
    button: document.querySelector('[data-astra-max-open]')?.dataset.selected === 'true' ? null : document.querySelector('#oscar-model-dropdown-btn'),
    popover: document.querySelector('#oscar-model-popover'),
    value: modelValue,
    prefix: 'Модель',
    separator: ' · ',
    displayPrefix: false,
    labelPrefix: 'Выбрать модель Oscar',
    labels: modelLabels,
  });
  syncOscarResearchControl();

  const modelButton = document.querySelector('#oscar-model-dropdown-btn');
  const modelLabel = modelLabels[modelValue] || modelValue;
  const maxEntry = document.querySelector('[data-astra-max-open]');
  const maxSelection = astraMaxMode?.selected() || null;
  const effort = syncOscarEffortControl(maxSelection);
  const effortSuffix = effort.applies && effort.value !== 'auto' ? ' · ' + OSCAR_EFFORT_LABELS[effort.value].toLowerCase() : '';
  renderMaxModeButton(modelButton, maxEntry?.dataset.selected === 'true', modelLabel + effortSuffix,
    maxSelection ? maxSelection.providerName + effortSuffix : '');
  if (modelButton) modelButton.dataset.modelPower = modelValue === 'qwen3.8-27b-pro' ? 'max' : 'standard';
  const conversationId = String(state.oscar?.conversationId || '').trim();
  const contextWindow = conversationId
    ? state.oscar?.contextWindows?.[conversationId] || null
    : null;
  syncOscarContextMeter(contextMeterVisible, contextWindow);
}

// Arrow keys move within the depth and research groups, as in any radio group.
document.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const current = event.target instanceof Element ? event.target.closest('#oscar-model-popover [data-effort], #oscar-model-popover [data-research]') : null;
  if (!current) return;
  const options = [...current.parentElement.querySelectorAll('[role="radio"]')].filter((node) => node.getAttribute('aria-disabled') !== 'true');
  if (options.length < 2) return;
  event.preventDefault();
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
  const next = options[(options.indexOf(current) + step + options.length) % options.length];
  next.click();
  next.focus();
});

/** Research sits in plain sight next to depth; it only runs with Internet on. */
function syncOscarResearchControl() {
  const value = ['auto', 'off', 'deep'].includes(state.oscar?.researchMode) ? state.oscar.researchMode : 'auto';
  const group = document.querySelector('#oscar-research-control');
  if (!group) return;
  group.querySelectorAll('[data-research]').forEach((option) => {
    const checked = option.getAttribute('data-research') === value;
    option.setAttribute('aria-checked', String(checked));
    option.tabIndex = checked ? 0 : -1;
  });
  const webOn = state.oscar?.web === true;
  group.dataset.web = String(webOn);
  const caption = group.querySelector('[data-research-caption]');
  if (caption) caption.textContent = !webOn ? 'Работает, когда включён Интернет'
    : { auto: 'Oscar сам распознаёт сложное исследование', off: 'Ответ без автоматического исследования',
      deep: 'План, несколько веток поиска и проверка' }[value];
}

const OSCAR_EFFORT_LABELS = Object.freeze({ auto: 'Авто', low: 'Быстро', medium: 'Обычно', high: 'Глубоко' });

function setOscarReasoningEffort(value) {
  const next = Object.hasOwn(OSCAR_EFFORT_LABELS, value) ? value : 'auto';
  state.oscar = state.oscar || {};
  state.oscar.reasoningEffort = next;
  preferences.reasoningEffort = next;
  savePreferences();
  applyOscarReasoningEffortToMax();
  syncOscarModelDropdowns();
}

/** MAX agent decisions run in the main process; the choice reaches them there. */
function applyOscarReasoningEffortToMax() {
  const value = state.oscar?.reasoningEffort || 'auto';
  void window.monarchDesktop?.astraMax?.setReasoningEffort?.(value === 'auto' ? null : value)?.catch?.(() => {});
}

function syncOscarEffortControl(maxSelection) {
  const value = state.oscar?.reasoningEffort || 'auto';
  // Each connected service takes depth in its own API form; a model that has
  // no such setting says so instead of pretending to change.
  const applies = !maxSelection || maxSelection.effortTunable === true;
  const group = document.querySelector('#oscar-effort-control');
  if (!group) return { value, applies };
  group.dataset.disabled = String(!applies);
  group.querySelectorAll('[data-effort]').forEach((option) => {
    const checked = option.getAttribute('data-effort') === value;
    option.setAttribute('aria-checked', String(checked));
    option.setAttribute('aria-disabled', String(!applies));
    option.tabIndex = checked && applies ? 0 : -1;
  });
  const caption = group.querySelector('[data-effort-caption]');
  if (caption) {
    caption.textContent = !applies ? 'Не настраивается у этой модели'
      : { auto: 'Глубина под модель', low: 'Думает коротко, отвечает быстрее', medium: 'Баланс скорости и тщательности',
        high: 'Дольше думает над сложным' }[value];
  }
  return { value, applies };
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
