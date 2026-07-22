import { MonarchStartup } from '/startup/monarch-startup.js';
import { state, updateState, subscribeState } from './modules/state.js';
import { fetchState, revokeCapabilityLease, rollbackAction, updateAutonomyMode } from './modules/api.js';
import './modules/test-suite.js';
import { readErrorMessage, renderError } from './modules/utils.js';
import { cancelIntentJobAction, initChatPane, renderChatPane, submitIntentAction, renderThread } from './modules/chat-pane.js';
import { initOscarPane, loadOscarConversations, loadOscarStatus, renderOscar, startNewOscarConversation } from './modules/oscar-pane.js';
import { initSecurityPane, loadSecurityStatus, renderSecurity, renderSecurityPolicyControls } from './modules/security-pane.js';
import { renderModelManager } from './modules/model-manager.js';
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
import { normalizeUiPreferences, serializeUiPreferences } from './modules/ui-preferences.js';

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
  oscarDiagnostics: document.querySelector('#oscar-diagnostics'),
  oscarDiagnosticsToggle: document.querySelector('#oscar-diagnostics-toggle'),
  modelDropdownBtn: document.querySelector('#model-dropdown-btn'),
  modelPopover: document.querySelector('#model-popover'),
  reasoningDropdownBtn: document.querySelector('#reasoning-dropdown-btn'),
  reasoningPopover: document.querySelector('#reasoning-popover'),
  autonomyModeSelect: document.querySelector('#autonomy-mode-select'),
  permissionProfileNote: document.querySelector('#permission-profile-note'),
  activeLeasesList: document.querySelector('#active-leases-list'),
  actionLedgerList: document.querySelector('#action-ledger-list'),
  revokeAllLeases: document.querySelector('#revoke-all-leases'),
};

const preferences = readPreferences();
const reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const animatedMotionKeys = new Set();
let typingTimer = 0;
let safeLaunchFeedbackTimer = 0;
let securityStatusRequested = false;

// Render Coordinator
function render() {
  renderActiveView(readActiveViewId());
  renderMascot();
}

function renderActiveView(activeView) {
  if (activeView === 'oscar-section') {
    renderOscar();
    return;
  }
  if (activeView === 'security-section') {
    renderSecurity();
    return;
  }
  if (activeView === 'models-section' || activeView === 'workspace-section') {
    renderModelManager();
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


  const modelDropdownTrigger = event.target.closest('#model-dropdown-btn');
  if (modelDropdownTrigger) {
    toggleDropdown(elements.modelPopover);
    closeOtherDropdowns(elements.modelPopover);
    return;
  }

  const reasoningDropdownTrigger = event.target.closest('#reasoning-dropdown-btn');
  if (reasoningDropdownTrigger) {
    toggleDropdown(elements.reasoningPopover);
    closeOtherDropdowns(elements.reasoningPopover);
    return;
  }

  const oscarModelDropdownTrigger = event.target.closest('#oscar-model-dropdown-btn');
  if (oscarModelDropdownTrigger) {
    const popover = document.querySelector('#oscar-model-popover');
    toggleDropdown(popover);
    closeOtherDropdowns(popover);
    return;
  }

  const oscarReasoningDropdownTrigger = event.target.closest('#oscar-reasoning-dropdown-btn');
  if (oscarReasoningDropdownTrigger) {
    const popover = document.querySelector('#oscar-reasoning-popover');
    toggleDropdown(popover);
    closeOtherDropdowns(popover);
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

  const reasoningDropdownItem = event.target.closest('#reasoning-popover .dropdown-item');
  if (reasoningDropdownItem) {
    if (reasoningDropdownItem.getAttribute('aria-disabled') === 'true') return;
    state.chat = state.chat || {};
    state.chat.deepThinking = reasoningDropdownItem.getAttribute('data-value') || 'none';
    syncChatModelDropdowns();
    closeDropdown(elements.reasoningPopover);
    return;
  }

  const oscarModelDropdownItem = event.target.closest('#oscar-model-popover .dropdown-item');
  if (oscarModelDropdownItem) {
    if (oscarModelDropdownItem.getAttribute('aria-disabled') === 'true') return;
    state.oscar = state.oscar || {};
    state.oscar.modelSelection = oscarModelDropdownItem.getAttribute('data-value') || 'none';
    syncOscarModelDropdowns();
    closeDropdown(document.querySelector('#oscar-model-popover'));
    import('./modules/oscar-pane.js').then(m => m.renderOscar && m.renderOscar());
    return;
  }

  const oscarReasoningDropdownItem = event.target.closest('#oscar-reasoning-popover .dropdown-item');
  if (oscarReasoningDropdownItem) {
    if (oscarReasoningDropdownItem.getAttribute('aria-disabled') === 'true') return;
    state.oscar = state.oscar || {};
    state.oscar.deepThinking = oscarReasoningDropdownItem.getAttribute('data-value') || 'none';
    syncOscarModelDropdowns();
    closeDropdown(document.querySelector('#oscar-reasoning-popover'));
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
    const codeBlock = copyBtn.closest('.oscar-code-block');
    const codeEl = codeBlock?.querySelector('code');
    if (codeEl) {
      navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Скопировано';
        setTimeout(() => { copyBtn.textContent = originalText; }, 2000);
      });
    }
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
    void submitIntentAction(intent, confirmed, confirmationToken);
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
    const targetId = navItem.getAttribute('data-scroll-target') || '';
    const target = document.getElementById(targetId);
    if (target) {
      hideSafeLaunchFeedback();
      closeAllDropdowns();
      closeComposerOptions();
      setActiveNavItem(navItem);

      const views = [
        'command-center',
        'oscar-section',
        'security-section',
        'workspace-section',
        'modules-section',
        'models-section',
        'sharing-section',
        'logs-section',
        'settings-section'
      ];
      views.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('view-hidden');
      });
      target.classList.remove('view-hidden');
      elements.shell?.classList.toggle('modules-active', targetId === 'modules-section');
      setStudioActive(targetId === 'modules-section');
      resetViewScroll(target);
      renderActiveView(targetId);
      target.classList.remove('view-entering');
      window.requestAnimationFrame(() => {
        resetViewScroll(target);
        target.classList.add('view-entering');
      });
      window.setTimeout(() => target.classList.remove('view-entering'), 160);
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
    }
  }
});

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
  elements.startupAnimationSelect.value = localStorage.getItem('monarch.startup.type') || 'original';
  elements.startupAnimationSelect.addEventListener('change', () => {
    localStorage.setItem('monarch.startup.type', elements.startupAnimationSelect.value);
    document.documentElement.dataset.startupType = elements.startupAnimationSelect.value;
  });
}

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
  initOscarPane(render);
  initCoderPane();
  initSecurityPane(render);
  initSharingPane();
  initSettingsPane();
  initStudioPane();
  initUpdatePane();
  initMascotInteraction();
  initVoiceInput();
  initOscarVoiceMode();
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
  const startupType = localStorage.getItem('monarch.startup.type') || 'original';
  const forceReplay = new URLSearchParams(window.location.search).get('intro') === '1';
  let alreadyPlayed = false;
  try {
    alreadyPlayed = sessionStorage.getItem('monarch.startup-motion.v4') === 'played';
    if (!alreadyPlayed || forceReplay) sessionStorage.setItem('monarch.startup-motion.v4', 'played');
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

  if (startupType === 'original') {
    const duration = reducedMotionMedia?.matches ? 240 : 2380;
    window.setTimeout(() => {
      originalDOM?.classList.add('is-exiting');
      shell?.classList.add('startup-complete');
    }, duration);
    window.setTimeout(() => originalDOM?.remove(), duration + (reducedMotionMedia?.matches ? 120 : 520));
    return;
  }

  if (startupType === 'test') {
    if (originalDOM) originalDOM.remove();
    const startup = new MonarchStartup({
      title: "MONARCH",
      subtitle: "Local Intelligence Environment",
      initialStatus: "Пробуждение системы",
      minimumVisibleTime: reducedMotionMedia?.matches ? 500 : 1800,
    });

    startup.mount();

    // Simulate progress
    setTimeout(() => { startup.setStatus("Запуск Oscar"); startup.setProgress(0.45); }, 600);
    setTimeout(() => { startup.setStatus("Проверка Security"); startup.setProgress(0.8); }, 1200);

    // Complete after simulation
    setTimeout(async () => {
      await startup.complete("Система готова");
      shell?.classList.add('startup-complete');
    }, 1800);
  }
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
    if (!(event.target instanceof Element) || !event.target.matches('input, textarea')) return;
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
  const surfaceVisible = emptyHome || (dialogActive && !isCollapsed);
  document.querySelectorAll('#toggle-inspector-btn, [data-inspector-toggle], [data-monarch-brand-cycle]').forEach((button) => {
    const label = emptyHome
      ? 'Центральный маскот Oscar всегда видим до первого сообщения'
      : isCollapsed ? 'Показать мини-маскота Oscar' : 'Скрыть мини-маскота Oscar';
    const textLabel = button.querySelector('span:not([aria-hidden="true"])');
    if (textLabel && !button.matches('[data-monarch-brand-cycle]')) textLabel.textContent = 'Мини-маскот';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(surfaceVisible));
    button.setAttribute('aria-disabled', String(emptyHome));
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
  const profile = state.data?.permissions;
  if (!profile) return;
  const autonomyMode = profile.autonomyMode
    || (profile.sandboxMode === 'read-only' ? 'guided' : profile.sandboxMode === 'danger-full-access' ? 'full-local' : 'workspace-autonomous');
  if (elements.autonomyModeSelect) elements.autonomyModeSelect.value = autonomyMode;
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
    elements.reasoningPopover,
    document.querySelector('#oscar-model-popover'),
    document.querySelector('#oscar-reasoning-popover'),
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
    if (popover !== activePopover) closeDropdown(popover);
  });
}

function closeAllDropdowns() {
  getDropdownPopovers().forEach(closeDropdown);
}

function getEnabledDropdownItems(popover) {
  return [...popover.querySelectorAll('.dropdown-item[data-value]')]
    .filter((item) => item.getAttribute('aria-disabled') !== 'true');
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
    labels: {
      auto: 'Авто',
      'gemma4-fast': 'Fast',
      'gemma4-balanced': 'Medium',
    },
  });
  syncDropdown({
    button: elements.reasoningDropdownBtn,
    popover: elements.reasoningPopover,
    value: (state.chat && state.chat.deepThinking) || 'none',
    prefix: 'Deep Thinking',
    labelPrefix: 'Выбрать Deep Thinking',
    labels: {
      none: 'выкл',
      'gemma4-deepthinking': 'Pro',
      'gemma4-31b': 'Extra',
    },
  });
}

function syncOscarModelDropdowns() {
  const available = state.oscar?.status?.backend?.modelStatus?.available_tiers || null;
  syncModelAvailability(document.querySelector('#oscar-model-popover'), available);
  syncModelAvailability(document.querySelector('#oscar-reasoning-popover'), available);
  syncModelAvailability(elements.modelPopover, available);
  syncModelAvailability(elements.reasoningPopover, available);

  if (available && state.oscar?.modelSelection !== 'none' && available[state.oscar.modelSelection] === false) {
    state.oscar.modelSelection = 'none';
  }
  if (available && state.oscar?.deepThinking !== 'none' && available[state.oscar.deepThinking] === false) {
    state.oscar.deepThinking = 'none';
  }
  syncDropdown({
    button: document.querySelector('#oscar-model-dropdown-btn'),
    popover: document.querySelector('#oscar-model-popover'),
    value: (state.oscar && state.oscar.modelSelection) || 'none',
    prefix: 'Модель',
    separator: ' · ',
    labelPrefix: 'Выбрать модель Oscar',
    labels: {
      none: 'Авто',
      'gemma4-fast': 'Fast',
      'gemma4-balanced': 'Medium',
    },
  });
  syncDropdown({
    button: document.querySelector('#oscar-reasoning-dropdown-btn'),
    popover: document.querySelector('#oscar-reasoning-popover'),
    value: (state.oscar && state.oscar.deepThinking) || 'none',
    prefix: 'Deep Thinking',
    separator: ' · ',
    labelPrefix: 'Выбрать Deep Thinking Oscar',
    labels: {
      none: 'выкл',
      'gemma4-deepthinking': 'Pro',
      'gemma4-31b': 'Extra',
    },
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
}

function syncModelAvailability(popover, available) {
  if (!popover || !available) return;
  popover.querySelectorAll('.dropdown-item[data-value]').forEach((item) => {
    const value = item.getAttribute('data-value');
    if (!value || value === 'auto' || value === 'none') return;
    const disabled = available[value] === false;
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

function syncDropdown({ button, popover, value, prefix, labels, separator = ': ', labelPrefix }) {
  const selectedLabel = labels[value] || value;
  if (button) {
    const buttonLabel = prefix + separator + selectedLabel;
    const accessibleLabel = (labelPrefix || `Выбрать ${prefix.toLowerCase()}`) + ': ' + selectedLabel;
    button.textContent = buttonLabel;
    button.setAttribute('aria-label', accessibleLabel);
    button.title = accessibleLabel;
  }
  if (!popover) return;
  popover.querySelectorAll('.dropdown-item').forEach((item) => {
    const isActive = item.getAttribute('data-value') === value;
    if (isActive) item.classList.add('active');
    else item.classList.remove('active');
    item.setAttribute('aria-selected', String(isActive));
    item.tabIndex = isActive && item.getAttribute('aria-disabled') !== 'true' ? 0 : -1;
  });
}
