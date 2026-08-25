import { state } from './state.js';
import { copyTextToClipboard } from './clipboard.js';
import { createOscarGreeting } from './oscar-greetings.js';
import {
  armAgentTaskApproval,
  cancelAgentTask,
  cancelOscarTurn,
  cancelOscarTurnSubmission,
  createOscarIncognitoConversation,
  createOscarDataEgressConsent,
  createOscarTurn,
  decideOscarDataEgressConsent,
  discardOscarIncognitoConversation,
  executeCapability,
  executeCapabilityStream,
  executeConfirmedCapability,
  executeConfirmedCapabilityStream,
  evaluateImageGenerationIntent,
  fetchOscarAttachment,
  fetchAgentTask,
  fetchOscarRequestDisposition,
  fetchOscarTurn,
  fetchOscarTurnByClientRequestId,
  listAgentTasks,
  pauseAgentTask,
  repeatAgentTask,
  resumeAgentTask,
  fetchSkills,
  fetchSkillMatches,
  readLocalSettings,
  resolveAgentTaskApproval,
  streamOscarTurn,
  uploadOscarAttachment,
  writeLocalSettings,
} from './api.js';
import {
  closeOscarImageProviderReservation,
  handoffOscarImageGeneration,
  reserveOscarImageProviderWindow,
} from './image-generation-pane.js';
import {
  escapeHtml,
  renderError,
  statusPill,
  keyValueRow,
  readOscarBackend,
  readOscarModelStatus,
  readOscarModeLabel,
  readOscarMemoryLabel,
  readOscarSources,
  readUserFacingFailure,
  renderOscarMessage,
  syncThreadDOM,
  sanitizeVisibleAssistantContent,
  formatOscarWorkDuration,
  createOscarMessage,
  replacePendingOscarMessage,
  createThinkParser,
} from './utils.js';
import { hasSentOscarMessage, setMascotState } from './mascot-controller.js';
import { createOscarSpeechController } from './oscar-speech.js';
import { resolveOscarComposerPrimaryAction } from './voice-mode-state.js';
import { resolveModelReasoningEffort, resolveOscarRequestedModel } from './oscar-composer-policy.js';
import { buildOscarRamNotice } from './oscar-ram-pressure.js';
import {
  appendUnhydratedLocalAssistant,
  formatOscarModelLabel,
  isHydratedOscarFailure,
  OSCAR_CANCELLED_SUMMARY,
  presentOscarHistoryContent,
  resolveHydratedOscarMessageLabel,
  resolveOscarHistoryListState,
} from './oscar-history-reconciliation.js';
import { createLatestRequestOwner } from './latest-request-owner.js';
import {
  filterSkillPickerSkills,
  parseSkillInvocation,
  skillUserFacingDescription,
  skillUserFacingName,
} from './skill-ux.js';
import {
  insertOscarFunctionInvocation,
  isComputerUseFunctionInvocation,
  listOscarFunctions,
  readOscarFunctionQuery,
} from './oscar-functions.js';
import { ensureComputerUseReady } from './computer-use-control.js';

const MAX_OSCAR_NEW_TOKENS = 65_536;
const MAX_OSCAR_ATTACHMENTS = 3;
const MAX_OSCAR_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const OSCAR_HISTORY_PAGE_SIZE = 80;
const OSCAR_CANCEL_ACK_TIMEOUT_MS = 15_000;
const OSCAR_DATA_EGRESS_CLEANUP_TIMEOUT_MS = 3_000;
const OSCAR_ACTIVE_SESSION_KEY = 'monarch.oscar.active-session.v1';
let oscarAttachmentReads = 0;

const elements = {
  oscarStatusPills: document.querySelector('#oscar-status-pills'),
  oscarRefresh: document.querySelector('#oscar-refresh'),
  oscarStartBackend: document.querySelector('#oscar-start-backend'),
  oscarClear: document.querySelector('#oscar-clear'),
  oscarIncognitoToggle: document.querySelector('#oscar-incognito-toggle'),
  oscarSafeEncrypt: document.querySelector('#oscar-safe-encrypt'),
  oscarSection: document.querySelector('#oscar-section'),
  oscarThread: document.querySelector('#oscar-thread'),
  oscarComposer: document.querySelector('#oscar-composer'),
  oscarInput: document.querySelector('#oscar-input'),
  oscarImageUpload: document.querySelector('#oscar-image-upload'),
  oscarAttachPhoto: document.querySelector('[data-oscar-attach-photo]'),
  oscarAttachmentsPreview: document.querySelector('#oscar-attachments-preview'),
  oscarAttachmentViewer: document.querySelector('#oscar-attachment-viewer'),
  oscarAttachmentViewerImage: document.querySelector('#oscar-attachment-viewer-image'),
  oscarAttachmentViewerTitle: document.querySelector('#oscar-attachment-viewer-title'),
  oscarAttachmentViewerMeta: document.querySelector('#oscar-attachment-viewer-meta'),
  oscarAttachmentViewerClose: document.querySelector('#oscar-attachment-viewer-close'),
  oscarEditingBanner: document.querySelector('#oscar-editing-banner'),
  oscarEditingCancel: document.querySelector('#oscar-editing-cancel'),
  oscarSend: document.querySelector('#oscar-send'),
  oscarVoiceMode: document.querySelector('#oscar-voice-mode'),
  oscarStop: document.querySelector('#oscar-stop'),
  oscarSkillRadar: document.querySelector('#oscar-skill-radar'),
  oscarSkillPickerToggle: document.querySelector('#oscar-skill-picker-toggle'),
  oscarSkillMenuState: document.querySelector('#oscar-skill-menu-state'),
  oscarSkillPicker: document.querySelector('#oscar-skill-picker'),
  oscarSkillPickerClose: document.querySelector('#oscar-skill-picker-close'),
  oscarSkillPickerSearch: document.querySelector('#oscar-skill-picker-search'),
  oscarSkillPickerResults: document.querySelector('#oscar-skill-picker-results'),
  oscarFunctionPicker: document.querySelector('#oscar-function-picker'),
  oscarFunctionPickerClose: document.querySelector('#oscar-function-picker-close'),
  oscarFunctionPickerResults: document.querySelector('#oscar-function-picker-results'),
  oscarSelectedSkill: document.querySelector('#oscar-selected-skill'),
  oscarSelectedSkillName: document.querySelector('#oscar-selected-skill-name'),
  oscarSelectedSkillRemove: document.querySelector('#oscar-selected-skill-remove'),
  oscarRamWarning: document.querySelector('#oscar-ram-warning'),
  oscarGenerationStatus: document.querySelector('#oscar-generation-status'),
  oscarMemoryToggle: document.querySelector('#oscar-memory-toggle'),
  oscarWebToggle: document.querySelector('#oscar-web-toggle'),
  oscarReasoning: document.querySelector('#oscar-reasoning'),
  oscarBackendLabel: document.querySelector('#oscar-backend-label'),
  oscarBackend: document.querySelector('#oscar-backend'),
  oscarContextLabel: document.querySelector('#oscar-context-label'),
  oscarContext: document.querySelector('#oscar-context'),
  oscarDiagnosticsState: document.querySelector('#oscar-diagnostics-state'),
  oscarGemmaTier: document.querySelector('#oscar-gemma-tier'),
  oscarConversationList: document.querySelector('#oscar-conversation-list'),
  oscarHistoryPanel: document.querySelector('#oscar-history-panel'),
  oscarHistoryToggle: document.querySelector('#oscar-history-toggle'),
  oscarHistoryOpen: document.querySelector('#oscar-history-open'),
  oscarHistoryClose: document.querySelector('#oscar-history-close'),
  oscarHistoryCount: document.querySelector('#oscar-history-count'),
  oscarHistoryClear: document.querySelector('#oscar-history-clear'),
  oscarHistoryRefresh: document.querySelector('#oscar-history-refresh'),
  oscarMissionsToggle: document.querySelector('#oscar-missions-toggle'),
  oscarMissionsPanel: document.querySelector('#oscar-missions-panel'),
  oscarMissionsClose: document.querySelector('#oscar-missions-close'),
  oscarMissionsRefresh: document.querySelector('#oscar-missions-refresh'),
  oscarMissionsSummary: document.querySelector('#oscar-missions-summary'),
  oscarMissionsList: document.querySelector('#oscar-missions-list'),
  oscarHistorySearch: document.querySelector('#oscar-history-search'),
  oscarMemoryNav: document.querySelector('[data-oscar-memory-nav]'),
  oscarMemoryManager: document.querySelector('#oscar-memory-manager'),
  oscarMemoryPanel: document.querySelector('#oscar-memory-panel'),
  oscarMemoryClose: document.querySelector('#oscar-memory-close'),
  oscarMemoryForm: document.querySelector('#oscar-memory-form'),
  oscarMemoryInput: document.querySelector('#oscar-memory-input'),
  oscarMemoryCategory: document.querySelector('#oscar-memory-category'),
  oscarMemoryItems: document.querySelector('#oscar-memory-items'),
  oscarPriorityCard: document.querySelector('#oscar-priority-card'),
  oscarPriorityTitle: document.querySelector('#oscar-priority-title'),
  oscarPriorityDetail: document.querySelector('#oscar-priority-detail'),
  oscarPriorityAction: document.querySelector('#oscar-priority-action'),
  oscarPriorityBackend: document.querySelector('#oscar-priority-backend'),
  oscarPriorityModel: document.querySelector('#oscar-priority-model'),
  oscarPriorityDevice: document.querySelector('#oscar-priority-device'),
  oscarPriorityMemory: document.querySelector('#oscar-priority-memory'),
  assistantGpuResource: document.querySelector('#assistant-gpu-resource'),
  assistantVramResource: document.querySelector('#assistant-vram-resource'),
  assistantRamResource: document.querySelector('#assistant-ram-resource'),
  assistantTorchResource: document.querySelector('#assistant-torch-resource'),
  shell: document.querySelector('#app-shell'),
};

let skillRadarTimer = null;
let skillRadarRequest = 0;
let skillPickerLoadPromise = null;
let functionPickerOpen = false;
let mascotResetTimer = null;
let renderApp = () => {};
let oscarAutoFollow = true;
// This latch closes the first-await gap before `state.oscar.busy` is set.
let oscarSubmitInFlight = false;
let oscarConversationTransitionId = 0;
let oscarNewConversationInFlight = false;
const oscarConversationListOwner = createLatestRequestOwner();
const animatedOscarUserMessages = new Set();
let lastOscarHistoryTrigger = null;
let oscarSpeechController = null;
let activeOscarRouteConsent = null;
let oscarWorkTimerInterval = null;
let activeOscarAgentTaskId = '';
let activeOscarTurnId = '';
let activeOscarTurnStreamController = null;
let activeOscarSubmissionController = null;
let activeOscarSubmission = null;
let activeOscarApprovalSettlement = null;
let waitingOscarTurn = null;
let oscarMemoryRevision = 0;
let oscarMissionTasks = [];
let oscarMissionsOpen = false;
let oscarMissionsLoading = false;
let oscarMissionsPollTimer = null;
let oscarMissionsRefreshTimer = null;
let oscarSessionRestoreAttempted = false;
const expandedOscarMissions = new Set();
const armedOscarMissionApprovals = new Set();

export function initOscarPane(appRenderCallback) {
  renderApp = appRenderCallback;
  oscarSpeechController = createOscarSpeechController({
    desktop: window.monarchDesktop,
    speechSynthesis: window.speechSynthesis,
    Utterance: window.SpeechSynthesisUtterance,
    onStateChange: syncOscarSpeechControls,
  });
  window.monarchDesktop?.onSafeChatStatus?.((status) => {
    const unlocked = status?.unlocked === true;
    state.oscar.safeUnlocked = unlocked;
    if (!unlocked) {
      state.oscar.conversations = state.oscar.conversations.filter((conversation) => conversation.encrypted !== true);
      if (state.oscar.encrypted) void sealActiveEncryptedConversation();
      else {
        renderConversationList();
        syncOscarControlsToDom();
      }
    } else {
      syncOscarControlsToDom();
      if (unlocked) void loadOscarConversations({ supersede: true });
    }
  });
  void refreshSafeChatStatus();
  renderOscarAttachments();
  renderSelectedSkill();
  syncOscarInputHeight();
  const updateAutoFollow = (event) => {
    const target = event?.currentTarget || readOscarScrollTarget();
    if (!target) return;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    oscarAutoFollow = distanceFromBottom <= 120;
  };
  elements.oscarSection?.addEventListener('scroll', updateAutoFollow, { passive: true });
  elements.oscarThread?.addEventListener('scroll', updateAutoFollow, { passive: true });
  window.addEventListener('scroll', () => updateAutoFollow({ currentTarget: document.scrollingElement }), { passive: true });
  if (elements.oscarComposer) {
    elements.oscarComposer.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitOscarMessage(appRenderCallback);
    });
  }

  if (elements.oscarInput) {
    elements.oscarInput.addEventListener('input', () => {
      syncOscarInputHeight();
      syncOscarComposerState();
      syncSkillPickerFromComposer();
      syncFunctionPickerFromComposer();
      scheduleSkillRadar();
    });
    elements.oscarInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && functionPickerOpen) {
        event.preventDefault();
        setFunctionPickerOpen(false);
        return;
      }
      if (event.key === 'Escape' && state.oscar.skillPickerOpen) {
        event.preventDefault();
        setSkillPickerOpen(false);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        if (functionPickerOpen) {
          const first = elements.oscarFunctionPickerResults?.querySelector('[data-oscar-function]');
          if (first) {
            event.preventDefault();
            first.click();
            return;
          }
        }
        event.preventDefault();
        void submitOscarMessage(appRenderCallback);
      }
    });
    elements.oscarInput.addEventListener('paste', (event) => {
      const imageFiles = imageFilesFromTransfer(event.clipboardData);
      if (!imageFiles.length) return;
      event.preventDefault();
      void addOscarImageAttachments(imageFiles);
    });
  }

  if (elements.oscarComposer) {
    elements.oscarComposer.addEventListener('dragover', (event) => {
      if (!imageFilesFromTransfer(event.dataTransfer).length) return;
      event.preventDefault();
      elements.oscarComposer.classList.add('is-dragging-image');
    });
    elements.oscarComposer.addEventListener('dragleave', (event) => {
      if (!elements.oscarComposer.contains(event.relatedTarget)) {
        elements.oscarComposer.classList.remove('is-dragging-image');
      }
    });
    elements.oscarComposer.addEventListener('drop', (event) => {
      const imageFiles = imageFilesFromTransfer(event.dataTransfer);
      elements.oscarComposer.classList.remove('is-dragging-image');
      if (!imageFiles.length) return;
      event.preventDefault();
      void addOscarImageAttachments(imageFiles);
    });
  }

  elements.oscarImageUpload?.addEventListener('change', () => {
    void addOscarImageAttachments(elements.oscarImageUpload.files);
  });
  elements.oscarAttachPhoto?.addEventListener('click', () => {
    elements.oscarAttachPhoto.closest('details')?.removeAttribute('open');
    elements.oscarImageUpload?.click();
  });
  elements.oscarAttachmentsPreview?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-attachment-remove]');
    if (!button) return;
    const index = Number(button.getAttribute('data-attachment-remove'));
    if (!Number.isInteger(index)) return;
    state.oscar.attachments.splice(index, 1);
    renderOscarAttachments();
    syncOscarComposerState();
  });
  elements.oscarAttachmentViewerClose?.addEventListener('click', () => {
    elements.oscarAttachmentViewer?.close();
  });
  elements.oscarAttachmentViewer?.addEventListener('click', (event) => {
    if (event.target === elements.oscarAttachmentViewer) elements.oscarAttachmentViewer.close();
  });

  if (elements.oscarSkillRadar) {
    elements.oscarSkillRadar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-skill-invoke]');
      if (!button || !elements.oscarInput) return;
      const name = button.getAttribute('data-skill-invoke') || '';
      if (!name) return;
      const match = (state.oscar.skillMatches || []).find((entry) => entry.skill?.name === name);
      selectComposerSkill(match?.skill || {
        name,
        displayName: button.querySelector('.skill-radar-name')?.textContent?.trim() || name,
      });
    });
  }

  if (elements.oscarThread) {
    elements.oscarThread.addEventListener('click', (event) => {
      const attachmentButton = event.target.closest('[data-message-attachment]');
      if (attachmentButton) {
        event.preventDefault();
        const [messageId, rawIndex] = String(attachmentButton.getAttribute('data-message-attachment') || '').split(':');
        void openOscarAttachment(messageId, Number(rawIndex), attachmentButton);
        return;
      }
      const routeDecisionButton = event.target.closest('[data-oscar-route-decision]');
      if (routeDecisionButton) {
        event.preventDefault();
        event.stopPropagation();
        settleOscarRouteConsent(routeDecisionButton.getAttribute('data-oscar-route-decision') === 'allow' ? 'allow' : 'deny');
        return;
      }
      const loadOlderButton = event.target.closest('[data-oscar-load-older]');
      if (loadOlderButton) {
        void loadOlderOscarMessages();
        return;
      }
      const copyButton = event.target.closest('[data-message-copy]');
      if (copyButton) {
        void copyOscarMessage(copyButton.getAttribute('data-message-copy') || '', copyButton);
        return;
      }
      const speechButton = event.target.closest('[data-message-speak]');
      if (speechButton) {
        event.preventDefault();
        const messageId = speechButton.getAttribute('data-message-speak') || '';
        const message = state.oscar.messages.find((item) => item.id === messageId && item.role === 'assistant');
        oscarSpeechController?.toggle({ messageId, text: message?.content || '' });
        return;
      }
      const editButton = event.target.closest('[data-message-edit]');
      if (editButton) {
        editOscarUserMessage(editButton.getAttribute('data-message-edit') || '');
        return;
      }
      const armButton = event.target.closest('[data-oscar-arm-action]');
      if (armButton) {
        event.preventDefault();
        event.stopPropagation();
        const messageId = armButton.getAttribute('data-message-id') || '';
        void armOscarMessageAction(messageId, armButton);
        return;
      }
      const button = event.target.closest('[data-oscar-confirm-action]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const messageId = button.getAttribute('data-message-id') || '';
      const grantScope = button.getAttribute('data-grant-scope') === 'task' ? 'task' : 'once';
      const agentTaskId = button.getAttribute('data-agent-task-id') || '';
      const agentApprovalId = button.getAttribute('data-agent-approval-id') || '';
      if (agentTaskId && agentApprovalId) {
        const decision = button.getAttribute('data-agent-decision') === 'deny' ? 'deny' : 'approve';
        void settleOscarAgentApproval(
          agentTaskId,
          agentApprovalId,
          decision,
          messageId,
          appRenderCallback,
          grantScope,
        );
        return;
      }
      button.disabled = true;
      button.title = 'Старый UI execution path удалён. Новые действия выполняются только через Agent Task.';
    });
  }

  elements.oscarEditingCancel?.addEventListener('click', () => {
    cancelOscarMessageEdit();
  });

  if (elements.oscarStop) {
    elements.oscarStop.addEventListener('click', () => {
      void stopOscarGeneration(appRenderCallback);
    });
  }

  if (elements.oscarRefresh) {
    elements.oscarRefresh.addEventListener('click', () => {
      void loadOscarStatus(appRenderCallback);
    });
  }

  if (elements.oscarStartBackend) {
    elements.oscarStartBackend.addEventListener('click', () => {
      void startOscarBackend(appRenderCallback);
    });
  }

  if (elements.oscarClear) {
    elements.oscarClear.addEventListener('click', () => {
      void startNewOscarConversation();
    });
  }

  elements.oscarIncognitoToggle?.addEventListener('click', () => {
    void toggleOscarIncognitoConversation();
  });
  window.addEventListener('monarch:owner-dev-changed', (event) => {
    if (state.data) state.data.ownerDev = event.detail || state.data.ownerDev;
    enforceOscarOwnerDevState();
    renderApp();
  });
  window.addEventListener('pagehide', () => {
    if (!state.oscar.incognito || !state.oscar.conversationId) return;
    void discardOscarIncognitoConversation(state.oscar.conversationId, { keepalive: true }).catch(() => undefined);
  });

  elements.oscarSafeEncrypt?.addEventListener('click', () => {
    if (state.oscar.encrypted) void lockEncryptedChats();
    else void encryptOscarConversation(state.oscar.conversationId || '');
  });

  elements.oscarHistorySearch?.addEventListener('input', () => renderConversationList());
  for (const historyButton of [elements.oscarHistoryToggle, elements.oscarHistoryOpen]) {
    historyButton?.addEventListener('click', () => {
      const nextOpen = !state.oscar.historyPanelOpen;
      setOscarHistoryOpen(nextOpen, {
        restoreFocus: !nextOpen,
        trigger: historyButton,
      });
    });
  }

  elements.oscarHistoryClose?.addEventListener('click', () => {
    setOscarHistoryOpen(false, { restoreFocus: true });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.oscar.historyPanelOpen) {
      setOscarHistoryOpen(false, { restoreFocus: true });
    }
  });

  if (elements.oscarHistoryRefresh) {
    elements.oscarHistoryRefresh.addEventListener('click', () => {
      void loadOscarConversations();
    });
  }

  elements.oscarSkillPickerToggle?.addEventListener('click', () => {
    void setSkillPickerOpen(!state.oscar.skillPickerOpen, { focusSearch: true });
  });
  elements.oscarSkillPickerClose?.addEventListener('click', () => setSkillPickerOpen(false));
  elements.oscarSelectedSkillRemove?.addEventListener('click', () => clearSelectedSkill());
  elements.oscarSkillPickerSearch?.addEventListener('input', () => renderSkillPicker());
  elements.oscarSkillPickerSearch?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setSkillPickerOpen(false);
      elements.oscarInput?.focus();
      return;
    }
    if (event.key === 'Enter') {
      const first = elements.oscarSkillPickerResults?.querySelector('[data-skill-pick]');
      if (!first) return;
      event.preventDefault();
      first.click();
    }
  });
  elements.oscarSkillPickerResults?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-skill-pick]');
    if (!button) return;
    const name = button.getAttribute('data-skill-pick') || '';
    const skill = (state.oscar.skillPickerSkills || []).find((entry) => String(entry.name || '') === name);
    if (skill) selectComposerSkill(skill);
  });
  elements.oscarFunctionPickerClose?.addEventListener('click', () => {
    setFunctionPickerOpen(false);
    elements.oscarInput?.focus();
  });
  elements.oscarFunctionPickerResults?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-oscar-function]');
    if (!button) return;
    selectOscarFunction(button.getAttribute('data-oscar-function') || '');
  });
  window.addEventListener('monarch:computer-use-selected', () => {
    selectOscarFunction('computer-use', { start: false });
  });
  window.addEventListener('monarch:open-skill-picker', () => {
    void setSkillPickerOpen(true, { focusSearch: true });
  });
  window.addEventListener('monarch:view-change', (event) => {
    if (event.detail?.view !== 'oscar-section') {
      setSkillPickerOpen(false);
      setFunctionPickerOpen(false);
    }
  });
  window.addEventListener('monarch:select-skill', (event) => {
    const detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
    if (!detail.name) return;
    selectComposerSkill(detail);
  });

  if (elements.oscarHistoryClear) {
    elements.oscarHistoryClear.addEventListener('click', () => {
      void clearOscarHistory();
    });
  }

  if (elements.oscarConversationList) {
    elements.oscarConversationList.addEventListener('focusin', (event) => {
      syncConversationActionTabStops(event.target.closest('.conversation-item'));
    });

    elements.oscarConversationList.addEventListener('focusout', (event) => {
      const currentItem = event.target.closest('.conversation-item');
      if (currentItem && currentItem.contains(event.relatedTarget)) return;
      requestAnimationFrame(() => {
        const activeItem = elements.oscarConversationList.contains(document.activeElement)
          ? document.activeElement.closest('.conversation-item')
          : null;
        syncConversationActionTabStops(activeItem);
      });
    });

    elements.oscarConversationList.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const activeItem = document.activeElement?.closest?.('.conversation-item');
      if (activeItem && elements.oscarConversationList.contains(activeItem)) {
        syncConversationActionTabStops(activeItem);
      }
    });

    elements.oscarConversationList.addEventListener('click', (event) => {
      const retryButton = event.target.closest('[data-oscar-history-retry]');
      if (retryButton) {
        void loadOscarConversations();
        return;
      }
      const deleteButton = event.target.closest('[data-conversation-delete]');
      if (deleteButton) {
        event.stopPropagation();
        void deleteOscarConversation(deleteButton.getAttribute('data-conversation-delete') || '');
        return;
      }
      const renameButton = event.target.closest('[data-conversation-rename]');
      if (renameButton) {
        event.stopPropagation();
        void renameOscarConversation(renameButton.getAttribute('data-conversation-rename') || '');
        return;
      }
      const encryptButton = event.target.closest('[data-conversation-encrypt]');
      if (encryptButton) {
        event.stopPropagation();
        void encryptOscarConversation(encryptButton.getAttribute('data-conversation-encrypt') || '');
        return;
      }
      const conversationButton = event.target.closest('[data-conversation-open]');
      if (conversationButton) {
        void openOscarConversation(conversationButton.getAttribute('data-conversation-open') || '');
      }
    });
  }

  if (elements.oscarMemoryManager) {
    elements.oscarMemoryManager.addEventListener('click', () => {
      state.oscar.memoryPanelOpen = !state.oscar.memoryPanelOpen;
      renderOscar();
      if (state.oscar.memoryPanelOpen) void loadOscarMemoryItems();
    });
  }

  if (elements.oscarMemoryClose) {
    elements.oscarMemoryClose.addEventListener('click', () => {
      state.oscar.memoryPanelOpen = false;
      renderOscar();
    });
  }

  if (elements.oscarMemoryForm) {
    elements.oscarMemoryForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void createOscarMemoryItem();
    });
  }

  if (elements.oscarMemoryItems) {
    elements.oscarMemoryItems.addEventListener('click', (event) => {
      const saveButton = event.target.closest('[data-memory-save]');
      const toggleButton = event.target.closest('[data-memory-toggle]');
      const deleteButton = event.target.closest('[data-memory-delete]');
      if (saveButton) void saveOscarMemoryItem(saveButton.getAttribute('data-memory-save') || '');
      if (toggleButton) void toggleOscarMemoryItem(toggleButton.getAttribute('data-memory-toggle') || '');
      if (deleteButton) void deleteOscarMemoryItem(deleteButton.getAttribute('data-memory-delete') || '');
    });
  }

  if (elements.oscarMemoryToggle) {
    elements.oscarMemoryToggle.addEventListener('change', () => {
      state.oscar.useMemory = elements.oscarMemoryToggle.checked;
      renderOscar();
    });
  }

  if (elements.oscarWebToggle) {
    elements.oscarWebToggle.addEventListener('change', () => {
      state.oscar.web = elements.oscarWebToggle.checked;
      renderOscar();
    });
  }

  if (elements.oscarGemmaTier) {
    elements.oscarGemmaTier.addEventListener('change', () => {
      state.oscar.gemmaTier = elements.oscarGemmaTier.value;
      renderOscar();
    });
  }

  if (elements.oscarReasoning) {
    elements.oscarReasoning.addEventListener('change', () => {
      state.oscar.reasoning = elements.oscarReasoning.value;
      renderOscar();
    });
  }

  elements.oscarMissionsToggle?.addEventListener('click', () => {
    setOscarMissionsOpen(!oscarMissionsOpen);
  });
  elements.oscarMissionsClose?.addEventListener('click', () => setOscarMissionsOpen(false));
  elements.oscarMissionsRefresh?.addEventListener('click', () => void loadOscarMissions());
  elements.oscarMissionsList?.addEventListener('click', (event) => {
    const detailButton = event.target.closest('[data-mission-detail]');
    if (detailButton) {
      const taskId = detailButton.getAttribute('data-mission-detail') || '';
      if (expandedOscarMissions.has(taskId)) expandedOscarMissions.delete(taskId);
      else expandedOscarMissions.add(taskId);
      renderOscarMissions();
      return;
    }
    const actionButton = event.target.closest('[data-mission-action]');
    if (!actionButton) return;
    const taskId = actionButton.getAttribute('data-task-id') || '';
    const action = actionButton.getAttribute('data-mission-action') || '';
    if (taskId && action) void runOscarMissionAction(taskId, action, actionButton);
  });
}

export async function loadOscarStatus(appRenderCallback, { captureContextForConversation = '' } = {}) {
  if (state.oscar.statusBusy) {
    return;
  }

  state.oscar.statusBusy = true;
  state.oscar.error = '';
  renderOscar();

  try {
    const result = await executeOscarCapabilityAction('oscar.status', {}, false);
    state.oscar.status = result.output;
    const captureConversationId = String(captureContextForConversation || '').trim();
    const activeConversationId = String(state.oscar.conversationId || '').trim();
    const contextWindow = readOscarModelStatus(state.oscar)?.last_context_window;
    const contextTokens = Number(contextWindow?.context_tokens || 0);
    const inputTokens = Number(contextWindow?.input_tokens);
    if (
      captureConversationId
      && captureConversationId === activeConversationId
      && contextWindow && typeof contextWindow === 'object'
      && contextTokens > 0
      && Number.isFinite(inputTokens) && inputTokens >= 0
    ) {
      state.oscar.contextWindows = {
        ...(state.oscar.contextWindows || {}),
        [captureConversationId]: { ...contextWindow },
      };
    }
  } catch (error) {
    state.oscar.error = formatOscarStatusError(error);
  } finally {
    state.oscar.statusBusy = false;
    appRenderCallback();
  }
}

async function submitOscarMessage(appRenderCallback) {
  enforceOscarOwnerDevState();
  if (requiredModelBlocksChat()) {
    renderGenerationStatus();
    return;
  }
  const ownerDev = readOscarOwnerDevSettings();
  const attachments = [...(state.oscar.attachments || [])];
  const enteredText = elements.oscarInput.value.trim();
  const visibleText = enteredText || (attachments.length ? 'Опиши прикреплённое изображение.' : '');
  const selectedSkillName = ownerDev.skillsEnabled === false
    ? ''
    : String(state.oscar.selectedSkill?.name || '').trim();
  const hasExplicitSkill = selectedSkillName
    && new RegExp(`^\\s*\\$${escapeRegExp(selectedSkillName)}(?:\\s|$)`, 'i').test(visibleText);
  const explicitComputerUse = isComputerUseFunctionInvocation(visibleText);
  const text = selectedSkillName && !hasExplicitSkill && !explicitComputerUse
    ? `$${selectedSkillName} ${visibleText}`.trim()
    : visibleText;
  if (!visibleText || state.oscar.busy || oscarSubmitInFlight) {
    return;
  }
  oscarSubmitInFlight = true;
  if (explicitComputerUse) {
    try {
      await ensureComputerUseReady('ui:oscar-explicit-function');
    } catch (error) {
      state.oscar.error = formatOscarStatusError(error);
      oscarSubmitInFlight = false;
      appRenderCallback();
      return;
    }
  }
  reserveOscarImageProviderWindow(visibleText);
  const submissionController = new AbortController();
  activeOscarSubmissionController = submissionController;
  const submissionSignal = submissionController.signal;
  let conversationId = '';
  const encryptedAtSubmission = state.oscar.encrypted === true;
  const encryptedSessionActive = () => !encryptedAtSubmission
    || (state.oscar.encrypted === true && state.oscar.conversationId === conversationId && state.oscar.safeUnlocked === true);
  let activeSubmissionTurnId = '';
  let turnCreationStarted = false;
  let cancellationConfirmed = false;

  syncOscarControls();
  const showDebugTrace = /(?:debug|отлад|ревью|review|trace|трассиров|диагностик)/i.test(text);
  const editingMessageId = state.oscar.editingMessageId;
  const editingIndex = editingMessageId
    ? state.oscar.messages.findIndex((message) => message.id === editingMessageId && message.role === 'user')
    : -1;
  const supersedesTurnId = editingIndex >= 0
    ? String(state.oscar.messages[editingIndex]?.turnId || '')
    : '';
  const userMessage = createOscarMessage('user', text, 'ты', { attachments, sendActive: true });
  const clientRequestId = `oscar_submit_${userMessage.id}`;
  const submissionState = {
    controller: submissionController,
    clientRequestId,
    conversationId: '',
    privacyMode: '',
    turnCreationStarted: false,
    turnId: '',
    cancellationConfirmed: false,
    dataEgressConsentClientRequestId: `${clientRequestId}_egress`,
    dataEgressConsentRequest: null,
    dataEgressConsent: null,
    dataEgressCleanupPromise: null,
  };
  activeOscarSubmission = submissionState;
  const pendingMessage = createOscarMessage('assistant', '', readOscarModeLabel(state.oscar), {
    pending: true,
    showTrace: showDebugTrace,
    streamPhase: 'route',
    streamEvents: [{
      kind: 'status',
      label: 'маршрутизация',
      detail: state.oscar.web ? 'web-поиск включен' : 'подбираю модель',
      at: new Date().toISOString(),
    }],
  });

  state.oscar.messages = editingIndex >= 0
    ? [...state.oscar.messages.slice(0, editingIndex), userMessage, pendingMessage]
    : [...state.oscar.messages, userMessage, pendingMessage];
  oscarAutoFollow = true;
  state.oscar.editingMessageId = null;
  state.oscar.context = null;
  state.oscar.activeSkills = [];
  state.oscar.skillMatches = [];
  state.oscar.selectedSkill = null;
  state.oscar.attachments = [];
  state.oscar.stopRequested = false;
  elements.oscarInput.value = '';
  setSkillPickerOpen(false);
  setFunctionPickerOpen(false);
  renderSelectedSkill();
  syncOscarInputHeight();
  if (elements.oscarImageUpload) elements.oscarImageUpload.value = '';
  setOscarBusy(true);
  renderOscar();
  scheduleOscarScrollToBottom('smooth');

  try {
    try {
      const imageIntent = await evaluateImageGenerationIntent(visibleText, { signal: submissionSignal });
      if (imageIntent?.isImageGeneration) {
        const handoff = await handoffOscarImageGeneration(imageIntent, {
          privacyMode: state.oscar.incognito ? 'incognito' : 'persistent',
          signal: submissionSignal,
        });
        pendingMessage.streamEvents.push({
          kind: 'status',
          label: 'изображение',
          detail: handoff.status === 'started'
            ? 'prompt готов для ручной генерации в Perchance'
            : handoff.status === 'cancelled' ? 'handoff отменён пользователем' : 'handoff не выполнен',
          at: new Date().toISOString(),
        });
        renderOscar();
      } else {
        closeOscarImageProviderReservation();
      }
    } catch (error) {
      closeOscarImageProviderReservation();
      if (submissionSignal.aborted) throw error;
      pendingMessage.streamEvents.push({
        kind: 'status',
        label: 'изображение',
        detail: 'image provider недоступен; Oscar продолжает ответ без ложного результата',
        at: new Date().toISOString(),
      });
      renderOscar();
    }
    conversationId = await ensureActiveConversation({ signal: submissionSignal });
    submissionState.conversationId = conversationId;
    throwIfOscarSubmissionAborted(submissionSignal);
    if (oscarSpeechController?.releaseForInference) {
      const released = await oscarSpeechController.releaseForInference();
      if (released?.ok === false) {
        throw new Error(released.summary || 'Не удалось освободить память голосовой модели перед запуском Oscar.');
      }
      throwIfOscarSubmissionAborted(submissionSignal);
    }

    const privacyMode = state.oscar.encrypted
      ? 'encrypted'
      : state.oscar.incognito ? 'incognito' : 'persistent';
    const continuation = waitingOscarTurn?.conversationId === conversationId ? waitingOscarTurn : null;
    if (continuation && attachments.length) {
      throw new Error('Вложение нельзя добавить к уже ожидающему уточнения Turn. Отправь его отдельным новым запросом.');
    }
    const uploadedAttachments = [];
    for (const [index, attachment] of attachments.entries()) {
      const uploaded = await uploadOscarAttachment(attachment, {
        conversationId,
        privacyMode,
        signal: submissionSignal,
      });
      uploadedAttachments.push(uploaded.attachment);
      const receipt = uploaded.attachment || {};
      Object.assign(attachment, {
        id: receipt.id || attachment.id,
        digest: receipt.digest || attachment.digest,
        name: receipt.name || attachment.name,
        mime_type: receipt.mimeType || attachment.mime_type,
        size_bytes: receipt.sizeBytes || attachment.size_bytes,
      });
      if (userMessage.attachments?.[index] && userMessage.attachments[index] !== attachment) {
        Object.assign(userMessage.attachments[index], attachment);
      }
    }
    const history = (ownerDev.historyContextEnabled === false ? [] : state.oscar.messages)
      .filter((message) => message.id !== userMessage.id && !message.pending && !message.error)
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.content }));
    let webSearch = ownerDev.internetEnabled !== false && state.oscar.web === true;
    let researchMode = ['auto', 'off', 'deep'].includes(state.oscar.researchMode) ? state.oscar.researchMode : 'auto';
    if (ownerDev.internetEnabled === false) researchMode = 'off';
    let dataEgressConsentId = '';
    let externalResearchRequired = false;
    if (!continuation) {
      const disposition = await fetchOscarRequestDisposition(text, history, { signal: submissionSignal });
      externalResearchRequired = disposition?.requiresExternalResearch === true;
      if (externalResearchRequired) webSearch = true;
      if (ownerDev.internetEnabled === false) webSearch = false;
    }
    if (!continuation && (webSearch || researchMode === 'deep')) {
      const consentRequest = {
        conversationId,
        privacyMode,
        text,
        attachmentIds: uploadedAttachments.map((attachment) => attachment.id),
        webSearch,
        researchMode,
      };
      submissionState.dataEgressConsentRequest = consentRequest;
      const proposal = await createOscarDataEgressConsent(consentRequest, {
        clientRequestId: submissionState.dataEgressConsentClientRequestId,
        signal: submissionSignal,
      });
      const consent = proposal?.consent || {};
      submissionState.dataEgressConsent = {
        id: String(consent.id || ''),
        canonicalBindingHash: String(consent.canonicalBindingHash || ''),
      };
      const decision = await requestOscarRouteConsent({
        webSearch: true,
        deepResearch: researchMode === 'deep',
        messageId: pendingMessage.id,
        presentation: proposal?.presentation || {},
        signal: submissionSignal,
      });
      await decideOscarDataEgressConsent(
        consent.id,
        decision === 'allow' ? 'grant' : 'deny',
        consent.canonicalBindingHash,
        { signal: submissionSignal },
      );
      if (decision === 'allow') {
        dataEgressConsentId = String(consent.id || '');
      } else {
        webSearch = false;
        researchMode = 'off';
      }
    }
    throwIfOscarSubmissionAborted(submissionSignal);
    const requestedModel = readOscarRequestedModel();
    turnCreationStarted = true;
    submissionState.turnCreationStarted = true;
    submissionState.privacyMode = privacyMode;
    submissionState.turnId = String(continuation?.turnId || '');
    rememberActiveOscarSession({
      conversationId,
      turnId: submissionState.turnId,
      clientRequestId,
      text,
    });
    const created = await createOscarTurn({
      conversationId,
      text,
      privacyMode,
      attachmentIds: uploadedAttachments.map((attachment) => attachment.id),
      history,
      modifiers: {
        requestedModel: requestedModel || undefined,
        reasoningEffort: resolveModelReasoningEffort(requestedModel),
        webSearch,
        researchMode,
        ...(dataEgressConsentId ? { dataEgressConsentId } : {}),
      },
      ...(continuation ? { replyToTurnId: continuation.turnId } : {}),
      ...(supersedesTurnId ? { supersedesTurnId } : {}),
    }, {
      clientRequestId,
      inputMessageId: userMessage.id,
      signal: submissionSignal,
    });
    if (!encryptedSessionActive()) return;
    if (state.oscar.incognito) {
      state.oscar.conversationId = String(created?.turn?.conversationId || conversationId || '').trim() || null;
    }
    const turnId = String(created?.turn?.id || continuation?.turnId || '');
    if (!turnId) throw new Error('Monarch Turn Coordinator не вернул turn id.');
    activeSubmissionTurnId = turnId;
    submissionState.turnId = turnId;
    userMessage.turnId = turnId;
    pendingMessage.turnId = turnId;
    rememberActiveOscarSession({ conversationId, turnId, clientRequestId, text });
    waitingOscarTurn = null;
    if (submissionSignal.aborted) {
      const cancelled = await cancelOscarTurn(turnId);
      cancellationConfirmed = isOscarTurnCancellationConfirmed(cancelled);
      if (!cancellationConfirmed) {
        if (isOscarTurnTerminal(cancelled)) {
          state.oscar.stopRequested = false;
          await consumeOscarTurn({
            turnId,
            text,
            pendingMessageId: pendingMessage.id,
            showTrace: showDebugTrace,
            appRenderCallback,
            after: continuation?.after || 0,
          });
          return;
        }
        throw new Error('Monarch не подтвердил отмену Turn, созданного одновременно со Stop.');
      }
      throw submissionSignal.reason || new DOMException('Aborted', 'AbortError');
    }
    const turnResult = await consumeOscarTurn({
      turnId,
      text,
      pendingMessageId: pendingMessage.id,
      showTrace: showDebugTrace,
      appRenderCallback,
      after: continuation?.after || 0,
    });
    if (!state.oscar.incognito && !state.oscar.encrypted) {
      await refreshActiveConversationMessages();
      void loadOscarConversations({ supersede: true });
    }
    void loadOscarStatus(appRenderCallback, turnResult?.status === 'succeeded'
      ? { captureContextForConversation: conversationId }
      : undefined);
  } catch (error) {
    if (!activeSubmissionTurnId && submissionState.turnId) {
      activeSubmissionTurnId = submissionState.turnId;
      userMessage.turnId = submissionState.turnId;
      pendingMessage.turnId = submissionState.turnId;
    }
    if (!activeSubmissionTurnId && !submissionState.turnId) {
      void denyUnusedOscarDataEgressConsent(submissionState);
    }
    const cancelledBeforeTurn = submissionSignal.aborted && !turnCreationStarted;
    const cancelledCreatedTurn = submissionSignal.aborted
      && (cancellationConfirmed || submissionState.cancellationConfirmed);
    if (state.oscar.stopRequested && (cancelledBeforeTurn || cancelledCreatedTurn)) {
      settleLocalOscarCancellation({
        pendingMessageId: pendingMessage.id,
        turnId: activeSubmissionTurnId,
        showTrace: showDebugTrace,
      });
    } else {
      settleLocalOscarError({
        error,
        pendingMessageId: pendingMessage.id,
        turnId: activeSubmissionTurnId,
        label: 'ошибка',
      });
    }
  } finally {
    closeOscarImageProviderReservation();
    if (state.oscar.encrypted && state.oscar.conversationId === conversationId) {
      try {
        await persistActiveEncryptedConversation();
      } catch (error) {
        state.oscar.error = `Safe не сохранил обновление чата: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (activeOscarSubmissionController === submissionController) {
      activeOscarSubmissionController = null;
    }
    if (activeOscarSubmission === submissionState) activeOscarSubmission = null;
    oscarSubmitInFlight = false;
    setOscarBusy(false);
    appRenderCallback();
  }

}

async function executeOscarCapabilityAction(capabilityId, input, confirmed) {
  if (confirmed) {
    return executeConfirmedCapability('oscar', capabilityId, input, 'ui:oscar');
  }

  const result = await executeCapability('oscar', capabilityId, input, 'ui:oscar', confirmed);
  if (!result.ok && !result.result?.ok) {
    const err = readUserFacingFailure(
      result.result || result,
      result.result?.summary || result.result?.error || result.summary || result.error || 'Oscar не выполнил запрос.',
    );
    throw new Error(err || 'Oscar не выполнил запрос.');
  }
  return result.result || result;
}

export async function loadOscarConversations(options = {}) {
  if (state.oscar.historyBusy && options.supersede !== true) return;
  const requestId = oscarConversationListOwner.begin();
  state.oscar.historyBusy = true;
  state.oscar.historyError = '';
  renderConversationList();
  try {
    const result = await executeOscarCapabilityAction('oscar.conversations.manage', { action: 'list' }, false);
    const persistent = Array.isArray(result.output?.conversations)
      ? result.output.conversations
      : [];
    const encrypted = await loadSafeChatSummaries();
    if (!oscarConversationListOwner.isCurrent(requestId)) return;
    state.oscar.conversations = [...encrypted, ...persistent]
      .sort((left, right) => String(right.updated_at || right.updatedAt || '').localeCompare(String(left.updated_at || left.updatedAt || '')));
    state.oscar.historyError = '';
  } catch (error) {
    if (oscarConversationListOwner.isCurrent(requestId)) {
      state.oscar.historyError = formatOscarStatusError(error);
    }
  } finally {
    if (oscarConversationListOwner.isCurrent(requestId)) {
      state.oscar.historyBusy = false;
      renderConversationList();
    }
  }
  if (!oscarConversationListOwner.isCurrent(requestId)) return;
  if (!oscarSessionRestoreAttempted) {
    oscarSessionRestoreAttempted = true;
    await restoreActiveOscarSession();
  }
}

async function refreshSafeChatStatus() {
  if (typeof window.monarchDesktop?.getSafeChatStatus !== 'function') {
    state.oscar.safeUnlocked = false;
    return false;
  }
  try {
    const status = await window.monarchDesktop.getSafeChatStatus();
    state.oscar.safeUnlocked = status?.unlocked === true;
    syncOscarControlsToDom();
    return state.oscar.safeUnlocked;
  } catch {
    state.oscar.safeUnlocked = false;
    syncOscarControlsToDom();
    return false;
  }
}

async function loadSafeChatSummaries() {
  const bridge = window.monarchDesktop;
  if (typeof bridge?.getSafeChatStatus !== 'function' || typeof bridge?.listSafeChats !== 'function') return [];
  try {
    const status = await bridge.getSafeChatStatus();
    state.oscar.safeUnlocked = status?.unlocked === true;
    if (!state.oscar.safeUnlocked) return [];
    const payload = await bridge.listSafeChats();
    return (Array.isArray(payload?.chats) ? payload.chats : [])
      .filter((chat) => chat?.kind === 'oscar' && typeof chat.id === 'string')
      .map((chat) => ({ ...chat, encrypted: true, message_count: Number(chat.messageCount || 0) }));
  } catch {
    state.oscar.safeUnlocked = false;
    return [];
  }
}

function requireSafeChatBridge() {
  const bridge = window.monarchDesktop;
  if (
    typeof bridge?.getSafeChatStatus !== 'function'
    || typeof bridge?.readSafeChat !== 'function'
    || typeof bridge?.writeSafeChat !== 'function'
    || typeof bridge?.deleteSafeChat !== 'function'
  ) {
    throw new Error('Шифрование чатов доступно только в Monarch Desktop.');
  }
  return bridge;
}

async function encryptOscarConversation(conversationId) {
  if (!conversationId || state.oscar.safeChatBusy || state.oscar.busy) return;
  const known = state.oscar.conversations.find((conversation) => conversation.id === conversationId);
  if (known?.encrypted === true) return;
  let bridge;
  try {
    bridge = requireSafeChatBridge();
  } catch (error) {
    state.oscar.error = error instanceof Error ? error.message : String(error);
    renderApp();
    return;
  }
  state.oscar.safeChatBusy = true;
  state.oscar.error = '';
  syncOscarControlsToDom();
  try {
    const status = await bridge.getSafeChatStatus();
    if (status?.unlocked !== true) {
      await bridge.openSafe?.();
      state.oscar.error = 'Разблокируй Monarch Safe и снова нажми кнопку шифрования.';
      return;
    }
    const accepted = window.confirm(
      'Перенести этот чат в Monarch Safe? Обычная копия будет удалена из Oscar SQLite после проверенной записи в Safe.',
    );
    if (!accepted) return;
    const result = await executeOscarCapabilityAction('oscar.conversations.manage', { action: 'get', id: conversationId }, false);
    const conversation = result.output || {};
    const messages = mapConversationMessages(conversation.messages || []);
    const now = new Date().toISOString();
    const record = {
      version: 1,
      id: conversation.id || conversationId,
      kind: 'oscar',
      title: formatConversationTitle(conversation),
      createdAt: conversation.created_at || now,
      updatedAt: conversation.updated_at || now,
      messages,
    };
    const stored = await bridge.writeSafeChat(record);
    if (stored?.verified !== true) throw new Error('Safe не подтвердил authenticated reread новой записи.');
    try {
      const removed = await executeOscarCapabilityAction('oscar.conversations.manage', { action: 'delete', id: conversationId }, false);
      if (removed.output?.ok !== true || removed.output?.deleted !== conversationId) {
        throw new Error('Oscar не подтвердил удаление plaintext-копии.');
      }
    } catch (error) {
      await bridge.deleteSafeChat(conversationId, 'oscar').catch(() => undefined);
      throw error;
    }
    if (state.oscar.conversationId === conversationId) {
      state.oscar.messages = messages;
      state.oscar.incognito = false;
      state.oscar.encrypted = true;
      resetOscarMessagePage();
      state.oscar.memoryPanelOpen = false;
    }
    state.oscar.safeUnlocked = true;
    await loadOscarConversations({ supersede: true });
  } catch (error) {
    state.oscar.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.oscar.safeChatBusy = false;
    renderApp();
  }
}

async function openEncryptedOscarConversation(conversationId) {
  if (!conversationId || state.oscar.safeChatBusy) return;
  const bridge = requireSafeChatBridge();
  state.oscar.safeChatBusy = true;
  state.oscar.historyBusy = true;
  renderConversationList();
  try {
    const status = await bridge.getSafeChatStatus();
    if (status?.unlocked !== true) {
      await bridge.openSafe?.();
      throw new Error('Разблокируй Monarch Safe, чтобы открыть зашифрованный чат.');
    }
    const payload = await bridge.readSafeChat(conversationId, 'oscar');
    const record = payload?.record || {};
    oscarSpeechController?.stop();
    state.oscar.incognito = false;
    state.oscar.encrypted = true;
    state.oscar.safeUnlocked = true;
    state.oscar.conversationId = record.id || conversationId;
    state.oscar.editingMessageId = null;
    state.oscar.messages = Array.isArray(record.messages) ? structuredClone(record.messages) : [];
    state.oscar.context = null;
    state.oscar.memoryPanelOpen = false;
    resetOscarMessagePage();
    setOscarHistoryOpen(false);
  } catch (error) {
    state.oscar.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.oscar.safeChatBusy = false;
    state.oscar.historyBusy = false;
    renderApp();
  }
}

async function persistActiveEncryptedConversation() {
  if (!state.oscar.encrypted || !state.oscar.conversationId) return;
  const bridge = requireSafeChatBridge();
  const conversation = state.oscar.conversations.find((item) => item.id === state.oscar.conversationId);
  const messages = state.oscar.messages
    .filter((message) => !message.pending)
    .map((message) => structuredClone(message));
  const firstUser = messages.find((message) => message.role === 'user' && message.content?.trim());
  const now = new Date().toISOString();
  const stored = await bridge.writeSafeChat({
    version: 1,
    id: state.oscar.conversationId,
    kind: 'oscar',
    title: conversation?.title || cleanConversationSummary(firstUser?.content || '', 72) || 'Зашифрованный чат',
    createdAt: conversation?.createdAt || now,
    updatedAt: now,
    messages,
  });
  if (stored?.verified !== true) throw new Error('Safe не подтвердил сохранение encrypted chat generation.');
}

async function lockEncryptedChats() {
  if (typeof window.monarchDesktop?.lockSafeChats !== 'function') return;
  try {
    await window.monarchDesktop.lockSafeChats();
  } finally {
    await sealActiveEncryptedConversation();
    await loadOscarConversations({ supersede: true });
  }
}

async function sealActiveEncryptedConversation() {
  state.oscar.safeUnlocked = false;
  state.oscar.conversations = state.oscar.conversations.filter((conversation) => conversation.encrypted !== true);
  if (!state.oscar.encrypted) {
    renderConversationList();
    syncOscarControlsToDom();
    return;
  }
  const cancellation = state.oscar.busy
    ? stopOscarGeneration(renderApp).catch(() => undefined)
    : Promise.resolve();
  oscarSpeechController?.stop();
  clearActiveOscarConversationState();
  renderApp();
  await cancellation;
}

function clearActiveOscarConversationState() {
  forgetActiveOscarSession();
  state.oscar.messages = [];
  state.oscar.conversationId = null;
  state.oscar.incognito = false;
  state.oscar.encrypted = false;
  state.oscar.editingMessageId = null;
  state.oscar.context = null;
  state.oscar.activeSkills = [];
  state.oscar.selectedSkill = null;
  state.oscar.attachments = [];
  state.oscar.memoryPanelOpen = false;
  state.oscar.error = '';
  resetOscarMessagePage();
  if (elements.oscarInput) {
    elements.oscarInput.value = '';
    syncOscarInputHeight();
    syncOscarComposerState();
  }
  setSkillPickerOpen(false);
  renderSelectedSkill();
}

export async function startNewOscarConversation() {
  if (state.oscar.busy || oscarSubmitInFlight || oscarNewConversationInFlight) return;
  oscarNewConversationInFlight = true;
  const transitionId = ++oscarConversationTransitionId;
  // A superseded conversation load must not keep the history surface locked.
  oscarConversationListOwner.invalidate();
  state.oscar.historyBusy = false;
  const discardedIncognitoId = state.oscar.incognito ? state.oscar.conversationId : null;
  oscarSpeechController?.stop();
  forgetActiveOscarSession();
  setOscarHistoryOpen(false);
  state.oscar.editingMessageId = null;
  state.oscar.messages = [];
  resetOscarMessagePage();
  state.oscar.context = null;
  state.oscar.activeSkills = [];
  state.oscar.selectedSkill = null;
  state.oscar.conversationId = null;
  state.oscar.incognito = readOscarOwnerDevSettings().zeroRetentionEnabled === true;
  state.oscar.encrypted = false;
  if (elements.oscarInput) {
    elements.oscarInput.value = '';
    syncOscarInputHeight();
    syncOscarComposerState();
  }
  setSkillPickerOpen(false);
  renderSelectedSkill();
  renderOscar();
  try {
    if (discardedIncognitoId) {
      await discardOscarIncognitoConversation(discardedIncognitoId).catch(() => undefined);
    }
    if (!state.oscar.incognito) {
      const result = await executeOscarCapabilityAction('oscar.conversations.manage', {
        action: 'create',
        title: 'Новый чат',
      }, false);
      if (transitionId !== oscarConversationTransitionId) return;
      state.oscar.conversationId = result.output?.id || null;
      rememberActiveOscarSession({ conversationId: state.oscar.conversationId });
      await loadOscarConversations({ supersede: true });
    }
  } catch (error) {
    if (transitionId === oscarConversationTransitionId) {
      state.oscar.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (transitionId === oscarConversationTransitionId) {
      oscarNewConversationInFlight = false;
    }
  }
  renderApp();
  elements.oscarInput?.focus();
}

async function toggleOscarIncognitoConversation() {
  if (state.oscar.busy || oscarNewConversationInFlight) return;
  if (readOscarOwnerDevSettings().zeroRetentionEnabled === true) {
    enforceOscarOwnerDevState();
    renderApp();
    return;
  }
  if (state.oscar.incognito) {
    await startNewOscarConversation();
    return;
  }
  oscarSpeechController?.stop();
  forgetActiveOscarSession();
  setOscarHistoryOpen(false);
  state.oscar.editingMessageId = null;
  state.oscar.messages = [];
  resetOscarMessagePage();
  state.oscar.context = null;
  state.oscar.activeSkills = [];
  state.oscar.selectedSkill = null;
  state.oscar.conversationId = null;
  state.oscar.incognito = true;
  state.oscar.encrypted = false;
  state.oscar.memoryPanelOpen = false;
  if (elements.oscarInput) {
    elements.oscarInput.value = '';
    syncOscarInputHeight();
    syncOscarComposerState();
  }
  setSkillPickerOpen(false);
  renderSelectedSkill();
  renderOscar();
  renderApp();
  elements.oscarInput?.focus();
}

async function ensureActiveConversation(options = {}) {
  enforceOscarOwnerDevState();
  if (state.oscar.incognito) {
    if (state.oscar.conversationId) return state.oscar.conversationId;
    const created = await createOscarIncognitoConversation({ signal: options.signal });
    state.oscar.conversationId = String(created?.conversationId || '').trim() || null;
    if (!state.oscar.conversationId) throw new Error('Monarch не создал ephemeral incognito session.');
    return state.oscar.conversationId;
  }
  if (state.oscar.conversationId) return state.oscar.conversationId;
  // `/api/chat/stream` persists this id atomically with the first message.
  // Avoid a separate round trip before dispatching the user request.
  state.oscar.conversationId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `oscar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  rememberActiveOscarSession({ conversationId: state.oscar.conversationId });
  return state.oscar.conversationId;
}

function rememberActiveOscarSession({
  conversationId,
  turnId = '',
  clientRequestId = '',
  text = '',
  cancelRequested = false,
} = {}) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId || state.oscar.incognito || state.oscar.encrypted
    || readOscarOwnerDevSettings().zeroRetentionEnabled === true) {
    forgetActiveOscarSession();
    return;
  }
  try {
    window.sessionStorage.setItem(OSCAR_ACTIVE_SESSION_KEY, JSON.stringify({
      conversationId: normalizedConversationId.slice(0, 256),
      turnId: String(turnId || '').trim().slice(0, 256),
      clientRequestId: String(clientRequestId || '').trim().slice(0, 256),
      text: String(text || '').slice(0, 20_000),
      cancelRequested: cancelRequested === true,
    }));
  } catch {
    // Reload recovery is best-effort; the durable Turn remains server-side.
  }
}

function readActiveOscarSession() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(OSCAR_ACTIVE_SESSION_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const conversationId = String(parsed.conversationId || '').trim();
    if (!conversationId) return null;
    return {
      conversationId,
      turnId: String(parsed.turnId || '').trim(),
      clientRequestId: String(parsed.clientRequestId || '').trim(),
      text: String(parsed.text || ''),
      cancelRequested: parsed.cancelRequested === true,
    };
  } catch {
    return null;
  }
}

function forgetActiveOscarSession() {
  try {
    window.sessionStorage.removeItem(OSCAR_ACTIVE_SESSION_KEY);
  } catch {
    // The current in-memory conversation remains usable when storage is unavailable.
  }
}

async function restoreActiveOscarSession() {
  if (readOscarOwnerDevSettings().zeroRetentionEnabled === true) {
    forgetActiveOscarSession();
    enforceOscarOwnerDevState();
    return;
  }
  if (state.oscar.busy || state.oscar.incognito || state.oscar.encrypted
    || state.oscar.conversationId || state.oscar.messages.length > 0) return;
  const saved = readActiveOscarSession();
  if (!saved) return;
  let checkpointError = '';
  let recoverableTurn = null;
  let recoverableText = '';

  if (saved.turnId || saved.clientRequestId) {
    try {
      let checkpoint;
      if (saved.cancelRequested && saved.clientRequestId) {
        checkpoint = await cancelOscarTurnSubmission(saved.clientRequestId, { privacyMode: 'persistent' });
        if (checkpoint?.cancellation?.reserved === true && !checkpoint?.turn) {
          const userMessage = createOscarMessage('user', saved.text, 'ты');
          const cancelledMessage = createOscarMessage(
            'assistant',
            formatAgentTaskCancellation(),
            'Oscar · отмена',
            { outcome: 'cancelled', provenance: { origin: 'system', verification: 'system-state' } },
          );
          state.oscar.conversationId = saved.conversationId;
          state.oscar.messages = [userMessage, cancelledMessage];
          state.oscar.context = {
            summary: cancelledMessage.content,
            request: null,
            sources: [],
            outcome: 'cancelled',
            provenance: 'system-state',
          };
          resetOscarMessagePage();
          renderApp();
          return;
        }
      } else {
        checkpoint = saved.turnId
          ? await fetchOscarTurn(saved.turnId)
          : await fetchOscarTurnByClientRequestId(saved.clientRequestId, { privacyMode: 'persistent' });
      }
      const turn = checkpoint?.turn;
      if (!turn || (saved.turnId && turn.id !== saved.turnId)
        || (saved.clientRequestId && turn.clientRequestId !== saved.clientRequestId)
        || turn.conversationId !== saved.conversationId
        || !['desktop', 'coder'].includes(turn.source)
        || turn.privacyMode !== 'persistent') {
        throw new Error('Сохранённая сессия не совпадает с durable Turn.');
      }
      const text = String(turn.request?.text || saved.text || '').trim();
      if (!text) throw new Error('Durable Turn не содержит исходного сообщения.');
      recoverableTurn = turn;
      recoverableText = text;
    } catch (error) {
      checkpointError = error instanceof Error ? error.message : String(error);
    }
  }

  if (recoverableTurn) {
    const turn = recoverableTurn;
    const userMessage = createOscarMessage('user', recoverableText, 'ты', { turnId: turn.id });
    const pendingMessage = createOscarMessage('assistant', '', 'Oscar · Turn', {
      pending: true,
      streamPhase: 'turn-recovery',
      turnId: turn.id,
    });
    state.oscar.conversationId = turn.conversationId;
    state.oscar.messages = [userMessage, pendingMessage];
    state.oscar.context = null;
    resetOscarMessagePage();
    rememberActiveOscarSession({
      conversationId: turn.conversationId,
      turnId: turn.id,
      clientRequestId: saved.clientRequestId,
      text: recoverableText,
      cancelRequested: saved.cancelRequested,
    });
    setOscarBusy(true);
    renderApp();
    try {
      try {
        const restoredTurn = await consumeOscarTurn({
          turnId: turn.id,
          text: recoverableText,
          pendingMessageId: pendingMessage.id,
          showTrace: false,
          appRenderCallback: renderApp,
          after: 0,
        });
        await refreshActiveConversationMessages();
        if (restoredTurn?.status === 'succeeded') {
          await loadOscarStatus(renderApp, { captureContextForConversation: turn.conversationId });
        }
      } catch (error) {
        settleLocalOscarError({
          error,
          pendingMessageId: pendingMessage.id,
          turnId: turn.id,
          label: 'Oscar · восстановление',
        });
        await refreshActiveConversationMessages();
      }
    } finally {
      setOscarBusy(false);
      renderApp();
    }
    return;
  }

  if (state.oscar.conversations.some((conversation) => conversation.id === saved.conversationId)) {
    await openOscarConversation(saved.conversationId);
    return;
  }
  forgetActiveOscarSession();
  if (checkpointError) {
    state.oscar.error = `Не удалось восстановить последний Turn: ${checkpointError}`;
    renderApp();
  }
}

function settleLocalOscarError({ error, pendingMessageId, turnId = '', label = 'Oscar · ошибка' }) {
  const summary = error instanceof Error ? error.message : String(error);
  const boundTurnId = String(turnId || '').trim();
  const replaced = replacePendingOscarMessage(createOscarMessage('assistant', summary, label, {
    error: true,
    turnId: boundTurnId,
    outcome: boundTurnId ? 'transport-error' : 'failed',
    provenance: { origin: 'system', verification: 'system-state' },
  }), pendingMessageId);
  if (!replaced) return false;
  state.oscar.context = {
    summary,
    request: boundTurnId ? { turnId: boundTurnId } : null,
    sources: [],
    outcome: boundTurnId ? 'transport-error' : 'failed',
  };
  setMascotState('error', { detail: summary });
  return true;
}

async function openOscarConversation(conversationId) {
  if (!conversationId || state.oscar.busy || oscarNewConversationInFlight) return;
  const selected = state.oscar.conversations.find((conversation) => conversation.id === conversationId);
  if (selected?.encrypted === true) {
    await openEncryptedOscarConversation(conversationId);
    return;
  }
  oscarSpeechController?.stop();
  const transitionId = ++oscarConversationTransitionId;
  state.oscar.historyBusy = true;
  renderConversationList();
  try {
    const result = await executeOscarCapabilityAction('oscar.conversations.manage', {
      action: 'get',
      id: conversationId,
      message_limit: OSCAR_HISTORY_PAGE_SIZE,
    }, false);
    if (transitionId !== oscarConversationTransitionId) return;
    const conversation = result.output || {};
    state.oscar.incognito = false;
    state.oscar.encrypted = false;
    state.oscar.conversationId = conversation.id || conversationId;
    state.oscar.editingMessageId = null;
    state.oscar.messages = mapConversationMessages(conversation.messages || []);
    state.oscar.messagePage = readOscarMessagePage(conversation.message_page, 1);
    state.oscar.context = null;
    rememberActiveOscarSession({
      conversationId: state.oscar.conversationId,
      turnId: [...state.oscar.messages].reverse().find((message) => message.turnId)?.turnId || '',
      text: [...state.oscar.messages].reverse().find((message) => message.role === 'user')?.content || '',
    });
    setOscarHistoryOpen(false);
  } catch (error) {
    if (transitionId === oscarConversationTransitionId) {
      state.oscar.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (transitionId === oscarConversationTransitionId) {
      state.oscar.historyBusy = false;
      renderApp();
    }
  }
}

async function loadOlderOscarMessages() {
  const conversationId = state.oscar.conversationId;
  const page = state.oscar.messagePage || {};
  const before = Number(page.nextBefore);
  if (!conversationId || state.oscar.incognito || state.oscar.encrypted || state.oscar.historyPageBusy || !page.hasMore || !Number.isSafeInteger(before) || before < 1) {
    return;
  }

  const scrollTarget = readOscarScrollTarget();
  const previousScrollHeight = scrollTarget?.scrollHeight || 0;
  const previousScrollTop = scrollTarget?.scrollTop || 0;
  state.oscar.historyPageBusy = true;
  oscarAutoFollow = false;
  renderOscar();

  try {
    const result = await executeOscarCapabilityAction('oscar.conversations.manage', {
      action: 'get',
      id: conversationId,
      message_limit: OSCAR_HISTORY_PAGE_SIZE,
      before,
    }, false);
    if (state.oscar.conversationId !== conversationId) return;

    const conversation = result.output || {};
    const olderMessages = mapConversationMessages(conversation.messages || []);
    const currentIds = new Set(state.oscar.messages.map((message) => message.id).filter(Boolean));
    state.oscar.messages = [
      ...olderMessages.filter((message) => !currentIds.has(message.id)),
      ...state.oscar.messages,
    ];
    state.oscar.messagePage = readOscarMessagePage(
      conversation.message_page,
      Math.max(1, Number(page.loadedPages) || 1) + 1,
    );
  } catch (error) {
    state.oscar.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.oscar.historyPageBusy = false;
    if (state.oscar.conversationId === conversationId) {
      renderOscar();
      if (scrollTarget) {
        const addedHeight = Math.max(0, scrollTarget.scrollHeight - previousScrollHeight);
        scrollTarget.scrollTop = previousScrollTop + addedHeight;
      }
    }
  }
}

async function refreshActiveConversationMessages() {
  if (state.oscar.incognito || state.oscar.encrypted) return;
  const conversationId = state.oscar.conversationId;
  if (!conversationId) return;
  try {
    const result = await executeOscarCapabilityAction('oscar.conversations.manage', {
      action: 'get',
      id: conversationId,
      message_limit: OSCAR_HISTORY_PAGE_SIZE,
    }, false);
    if (Array.isArray(result.output?.messages)) {
      const hydratedMessages = mapConversationMessages(result.output.messages);
      const existingMessages = state.oscar.messages;
      const existingPage = state.oscar.messagePage || {};
      const hydratedTail = appendUnhydratedLocalAssistant(existingMessages, hydratedMessages);
      const hydratedWithPreviews = hydratedTail.map((message) => inheritAttachmentPreviews(existingMessages, message));
      state.oscar.messages = Number(existingPage.loadedPages) > 1
        ? mergeHydratedConversationTail(existingMessages, hydratedWithPreviews)
        : hydratedWithPreviews;
      if (Number(existingPage.loadedPages) <= 1) {
        state.oscar.messagePage = readOscarMessagePage(result.output?.message_page, 1);
      }
      renderOscar();
    }
  } catch {
    // The streamed answer remains visible even if history hydration is temporarily unavailable.
  }
}

function readOscarMessagePage(page, loadedPages = 1) {
  const nextBefore = Number(page?.next_before);
  const hasMore = page?.has_more === true && Number.isSafeInteger(nextBefore) && nextBefore > 0;
  return {
    hasMore,
    nextBefore: hasMore ? nextBefore : null,
    loadedPages: Math.max(0, Math.trunc(Number(loadedPages) || 0)),
  };
}

function resetOscarMessagePage() {
  state.oscar.historyPageBusy = false;
  state.oscar.messagePage = { hasMore: false, nextBefore: null, loadedPages: 0 };
}

function mergeHydratedConversationTail(existingMessages, hydratedTail) {
  const hydratedWithPreviews = hydratedTail.map((message) => inheritAttachmentPreviews(existingMessages, message));
  const hydratedIds = new Set(hydratedWithPreviews.map((message) => message.id).filter(Boolean));
  const firstOverlap = existingMessages.findIndex((message) => hydratedIds.has(message.id));
  return firstOverlap >= 0
    ? [...existingMessages.slice(0, firstOverlap), ...hydratedWithPreviews]
    : hydratedWithPreviews;
}

function inheritAttachmentPreviews(existingMessages, hydratedMessage) {
  if (!Array.isArray(hydratedMessage.attachments) || !hydratedMessage.attachments.length) return hydratedMessage;
  const existing = existingMessages.find((message) => message.id && message.id === hydratedMessage.id)
    || [...existingMessages].reverse().find((message) => (
      message.role === hydratedMessage.role
      && message.content === hydratedMessage.content
      && Array.isArray(message.attachments)
    ));
  if (!existing) return hydratedMessage;
  return {
    ...hydratedMessage,
    attachments: hydratedMessage.attachments.map((attachment, index) => {
      const prior = existing.attachments.find((candidate) => attachment.id && candidate.id === attachment.id)
        || existing.attachments.find((candidate) => attachment.digest && candidate.digest === attachment.digest)
        || existing.attachments[index];
      return isRenderableAttachmentPreview(prior?.preview_url)
        ? { ...attachment, preview_url: prior.preview_url }
        : attachment;
    }),
  };
}

function mapConversationMessages(messages) {
  return messages.map((message) => {
    const rendered = createOscarMessage(
      message.role === 'user' ? 'user' : 'assistant',
      message.role === 'assistant'
        ? presentOscarHistoryContent(message.content, message.outcome)
        : message.content || '',
      resolveHydratedOscarMessageLabel(message),
      message.role === 'assistant' ? {
        id: message.id || '',
        clientMessageId: message.client_message_id || '',
        sources: Array.isArray(message.sources) ? message.sources : [],
        usage: {
          total_tokens: Number(message.token_count || 0),
          elapsed_ms: Number(message.elapsed_ms || 0),
          model_tier: message.model_tier || '',
          estimated: true,
        },
        turnId: message.turn_id || '',
        taskId: message.task_id || '',
        provenance: message.provenance || null,
        outcome: message.outcome || '',
        integrityWarning: message.integrity_warning || '',
        error: isHydratedOscarFailure(message.outcome),
      } : {
        id: message.id || '',
        clientMessageId: message.client_message_id || '',
        attachments: Array.isArray(message.attachments)
          ? message.attachments.map((attachment) => {
              const mimeType = attachment.mime_type || attachment.mimeType || '';
              const dataBase64 = String(attachment.data_base64 || attachment.dataBase64 || '').trim();
              return {
                ...attachment,
                id: attachment.id || '',
                mime_type: mimeType,
                size_bytes: Number(attachment.size_bytes || attachment.sizeBytes || 0),
                ...(dataBase64 ? { data_base64: dataBase64, preview_url: `data:${mimeType};base64,${dataBase64}` } : {}),
              };
            })
          : [],
        turnId: message.turn_id || '',
        taskId: message.task_id || '',
        provenance: message.provenance || null,
        outcome: message.outcome || '',
        integrityWarning: message.integrity_warning || '',
      },
    );
    rendered.id = message.id || rendered.id;
    return rendered;
  });
}

async function copyOscarMessage(messageId, button) {
  const message = state.oscar.messages.find((item) => item.id === messageId);
  if (!message?.content) return;
  const copied = await copyTextToClipboard(message.content);
  if (!copied) return;
  const copyLabel = message.role === 'user' ? 'Копировать сообщение' : 'Копировать ответ Oscar';
  button.dataset.copied = 'true';
  button.setAttribute('aria-label', 'Скопировано');
  button.title = 'Скопировано';
  window.setTimeout(() => {
    button.dataset.copied = 'false';
    button.setAttribute('aria-label', copyLabel);
    button.title = copyLabel;
  }, 1200);
}

function editOscarUserMessage(messageId) {
  if (state.oscar.busy) return;
  const message = state.oscar.messages.find((item) => item.id === messageId && item.role === 'user');
  if (!message || !elements.oscarInput) return;
  const invocation = parseSkillInvocation(message.content);
  state.oscar.editingMessageId = messageId;
  elements.oscarInput.value = invocation.visibleContent;
  state.oscar.selectedSkill = invocation.skillName
    ? (state.oscar.skillPickerSkills.find((skill) => skill.name === invocation.skillName) || { name: invocation.skillName })
    : null;
  renderSelectedSkill();
  renderOscar();
  syncOscarInputHeight();
  syncOscarComposerState();
  elements.oscarInput.focus();
  elements.oscarInput.setSelectionRange(elements.oscarInput.value.length, elements.oscarInput.value.length);
}

function cancelOscarMessageEdit() {
  state.oscar.editingMessageId = null;
  state.oscar.selectedSkill = null;
  if (elements.oscarInput) {
    elements.oscarInput.value = '';
    syncOscarInputHeight();
    syncOscarComposerState();
  }
  renderSelectedSkill();
  renderOscar();
  elements.oscarInput?.focus();
}

async function renameOscarConversation(conversationId) {
  const conversation = state.oscar.conversations.find((item) => item.id === conversationId);
  const title = window.prompt('Название чата', conversation?.title || 'Новый чат');
  if (!title?.trim()) return;
  if (conversation?.encrypted === true) {
    const payload = await requireSafeChatBridge().readSafeChat(conversationId, 'oscar');
    await requireSafeChatBridge().writeSafeChat({
      ...payload.record,
      title: title.trim(),
      updatedAt: new Date().toISOString(),
    });
    await loadOscarConversations({ supersede: true });
    return;
  }
  await executeOscarCapabilityAction('oscar.conversations.manage', {
    action: 'update',
    id: conversationId,
    title: title.trim(),
  }, false);
  await loadOscarConversations({ supersede: true });
}

async function deleteOscarConversation(conversationId) {
  if (!conversationId || !window.confirm('Удалить этот чат и все его сообщения?')) return;
  const conversation = state.oscar.conversations.find((item) => item.id === conversationId);
  try {
    if (conversation?.encrypted === true) {
      const bridge = requireSafeChatBridge();
      const payload = await bridge.readSafeChat(conversationId, 'oscar');
      if (hasActionLinkedConversationEvidence(payload?.record)) {
        throw new Error('Чат связан с поручением и не может быть удалён. Его можно только архивировать в Agent Runtime.');
      }
      await bridge.deleteSafeChat(conversationId, 'oscar');
      if (state.oscar.conversationId === conversationId) {
        clearActiveOscarConversationState();
      }
      await loadOscarConversations({ supersede: true });
      return;
    }
    await executeOscarCapabilityAction('oscar.conversations.manage', {
      action: 'delete',
      id: conversationId,
    }, false);
    if (state.oscar.conversationId === conversationId) {
      clearActiveOscarConversationState();
    }
    await loadOscarConversations({ supersede: true });
    renderApp();
  } catch (error) {
    state.oscar.error = formatOscarStatusError(error);
    renderApp();
  }
}

function isRenderableAttachmentPreview(value) {
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(String(value || ''));
}

async function openOscarAttachment(messageId, attachmentIndex, button) {
  const message = state.oscar.messages.find((item) => item.id === messageId && item.role === 'user');
  const attachment = Number.isInteger(attachmentIndex) ? message?.attachments?.[attachmentIndex] : null;
  if (!attachment || !elements.oscarAttachmentViewer) return;
  const originalLabel = button?.getAttribute('aria-label') || '';
  try {
    button?.setAttribute('aria-busy', 'true');
    button?.setAttribute('aria-label', 'Открываю изображение');
    let source = isRenderableAttachmentPreview(attachment.preview_url) ? attachment.preview_url : '';
    if (!source) {
      if (!attachment.id) throw new Error('У сохранённого изображения отсутствует immutable attachment id.');
      const privacyMode = state.oscar.encrypted
        ? 'encrypted'
        : state.oscar.incognito ? 'incognito' : 'persistent';
      const payload = await fetchOscarAttachment(attachment.id, {
        conversationId: state.oscar.conversationId,
        privacyMode,
      });
      const resolved = payload?.attachment || {};
      if (resolved.id !== attachment.id || (attachment.digest && resolved.digest !== attachment.digest)) {
        throw new Error('Monarch отклонил изображение: immutable receipt не совпал.');
      }
      source = `data:${resolved.mimeType};base64,${resolved.dataBase64}`;
      if (!isRenderableAttachmentPreview(source)) throw new Error('Хранилище вернуло неподдерживаемый формат изображения.');
      Object.assign(attachment, {
        preview_url: source,
        mime_type: resolved.mimeType,
        size_bytes: resolved.sizeBytes,
        digest: resolved.digest,
      });
      renderOscar();
    }
    elements.oscarAttachmentViewerImage.src = source;
    elements.oscarAttachmentViewerImage.alt = attachment.name || 'Прикреплённое изображение';
    elements.oscarAttachmentViewerTitle.textContent = attachment.name || 'Прикреплённое изображение';
    elements.oscarAttachmentViewerMeta.textContent = [
      attachment.mime_type || 'image',
      formatAttachmentSize(attachment.size_bytes),
    ].filter(Boolean).join(' · ');
    if (!elements.oscarAttachmentViewer.open) elements.oscarAttachmentViewer.showModal();
  } catch (error) {
    elements.oscarAttachmentViewerImage.removeAttribute('src');
    elements.oscarAttachmentViewerTitle.textContent = attachment.name || 'Изображение недоступно';
    elements.oscarAttachmentViewerMeta.textContent = error?.message || 'Не удалось открыть изображение.';
    if (!elements.oscarAttachmentViewer.open) elements.oscarAttachmentViewer.showModal();
  } finally {
    button?.removeAttribute('aria-busy');
    if (button?.isConnected) button.setAttribute('aria-label', originalLabel || 'Открыть изображение');
  }
}

function formatAttachmentSize(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

async function loadOscarMemoryItems() {
  if (state.oscar.memoryBusy) return;
  state.oscar.memoryBusy = true;
  renderMemoryPanel();
  try {
    const context = await readLocalSettings('memory');
    applyOscarMemoryContext(context);
  } catch (error) {
    state.oscar.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.oscar.memoryBusy = false;
    renderMemoryPanel();
  }
}

async function createOscarMemoryItem() {
  if (state.oscar.incognito || state.oscar.encrypted) return;
  const content = elements.oscarMemoryInput?.value.trim() || '';
  if (!content || state.oscar.memoryBusy) return;
  state.oscar.memoryBusy = true;
  renderMemoryPanel();
  try {
    const saved = await writeLocalSettings('memory.create', {
      text: content,
      category: elements.oscarMemoryCategory?.value || 'other',
      source: 'oscar-memory-panel',
    }, { expectedRevision: oscarMemoryRevision });
    applyOscarMemoryContext(saved.context);
    elements.oscarMemoryInput.value = '';
    await loadOscarStatus(renderApp);
  } finally {
    state.oscar.memoryBusy = false;
    await loadOscarMemoryItems();
  }
}

async function saveOscarMemoryItem(itemId) {
  if (state.oscar.incognito || state.oscar.encrypted) return;
  const item = elements.oscarMemoryItems?.querySelector(`[data-memory-item="${CSS.escape(itemId)}"]`);
  const content = item?.querySelector('[data-memory-content]')?.value.trim() || '';
  const category = item?.querySelector('[data-memory-category]')?.value || 'other';
  if (!content) return;
  const saved = await writeLocalSettings('memory.update', {
    id: itemId, text: content, category,
  }, { expectedRevision: oscarMemoryRevision });
  applyOscarMemoryContext(saved.context);
  renderMemoryPanel();
}

async function toggleOscarMemoryItem(itemId) {
  if (state.oscar.incognito || state.oscar.encrypted) return;
  const current = state.oscar.memoryItems.find((item) => item.id === itemId);
  if (!current) return;
  const saved = await writeLocalSettings('memory.update', {
    id: itemId, enabled: !current.enabled,
  }, { expectedRevision: oscarMemoryRevision });
  applyOscarMemoryContext(saved.context);
  renderMemoryPanel();
  await loadOscarStatus(renderApp);
}

async function deleteOscarMemoryItem(itemId) {
  if (state.oscar.incognito || state.oscar.encrypted) return;
  if (!itemId || !window.confirm('Удалить эту запись памяти?')) return;
  const saved = await writeLocalSettings('memory.delete', { id: itemId }, {
    expectedRevision: oscarMemoryRevision,
  });
  applyOscarMemoryContext(saved.context);
  renderMemoryPanel();
  await loadOscarStatus(renderApp);
}

function applyOscarMemoryContext(context) {
  oscarMemoryRevision = Math.max(0, Number(context?.revision) || 0);
  state.oscar.memoryItems = Array.isArray(context?.value?.records) ? context.value.records : [];
}

function readOscarRequestedModel() {
  return resolveOscarRequestedModel({
    intelligenceEnabled: state.oscar.intelligenceEnabled,
    modelSelection: state.oscar.modelSelection,
  });
}

function syncOscarControls() {
  state.oscar.useMemory = true;
  state.oscar.web = null;

  if (elements.oscarReasoning) {
    state.oscar.reasoning = elements.oscarReasoning.value;
  }
  if (elements.oscarGemmaTier) {
    state.oscar.gemmaTier = elements.oscarGemmaTier.value;
  }
}

function syncOscarControlsToDom() {
  enforceOscarOwnerDevState();
  if (elements.oscarReasoning) elements.oscarReasoning.value = state.oscar.reasoning;
  if (elements.oscarGemmaTier) elements.oscarGemmaTier.value = state.oscar.gemmaTier;
  const isIncognito = state.oscar.incognito === true;
  const isEncrypted = state.oscar.encrypted === true;
  if (elements.oscarIncognitoToggle) {
    elements.oscarIncognitoToggle.classList.toggle('is-active', isIncognito);
    elements.oscarIncognitoToggle.setAttribute('aria-pressed', String(isIncognito));
    const forced = readOscarOwnerDevSettings().zeroRetentionEnabled === true;
    const label = forced
      ? 'Owner DEV: нулевое хранение принудительно включено'
      : isIncognito ? 'Выйти из инкогнито-чата и начать обычный чат' : 'Начать инкогнито-чат';
    elements.oscarIncognitoToggle.setAttribute('aria-label', label);
    elements.oscarIncognitoToggle.title = label;
    elements.oscarIncognitoToggle.disabled = forced;
  }
  for (const button of [elements.oscarMemoryManager, elements.oscarMemoryNav]) {
    if (!button) continue;
    button.disabled = isIncognito || isEncrypted;
    button.setAttribute('aria-disabled', String(isIncognito || isEncrypted));
  }
  if (elements.oscarSafeEncrypt) {
    const label = isEncrypted
      ? 'Заблокировать зашифрованный чат и Monarch Safe'
      : 'Зашифровать чат в Monarch Safe';
    elements.oscarSafeEncrypt.classList.toggle('is-active', isEncrypted);
    elements.oscarSafeEncrypt.classList.toggle('safe-available', state.oscar.safeUnlocked === true);
    elements.oscarSafeEncrypt.setAttribute('aria-pressed', String(isEncrypted));
    elements.oscarSafeEncrypt.setAttribute('aria-label', label);
    elements.oscarSafeEncrypt.title = label;
    elements.oscarSafeEncrypt.disabled = isIncognito
      || state.oscar.safeChatBusy === true
      || (!isEncrypted && !state.oscar.conversationId);
  }
}

function setOscarBusy(isBusy) {
  state.oscar.busy = isBusy;
  setOscarWorkTimerRunning(isBusy);
  clearTimeout(mascotResetTimer);
  if (!isBusy) {
    state.oscar.messages = state.oscar.messages.map((message) => (
      message.sendActive ? { ...message, sendActive: false } : message
    ));
    state.oscar.stopRequested = false;
    state.oscar.generationStatus = null;
    const lastMessage = state.oscar.messages.at(-1);
    const outcome = String(lastMessage?.outcome || '');
    if (lastMessage?.error) {
      setMascotState('error');
      mascotResetTimer = setTimeout(() => setMascotState('idle'), 3200);
    } else if (outcome === 'waiting-for-approval') {
      setMascotState('listening', { detail: 'Жду точное разрешение' });
    } else if (outcome === 'waiting-for-user') {
      setMascotState('listening', { detail: 'Жду уточнение' });
    } else if (outcome === 'cancelled' || outcome === 'blocked') {
      setMascotState('idle');
    } else {
      setMascotState('success');
      mascotResetTimer = setTimeout(() => setMascotState('idle'), 1900);
    }
  } else {
    state.oscar.streamTokens = 0;
    setGenerationPhase('Подключаю runtime', 'Подготовка локальной модели');
    setMascotState('listening', { detail: 'Готовлю запрос' });
  }
  elements.oscarComposer.setAttribute('aria-busy', String(isBusy));
  elements.oscarComposer.classList.toggle('is-generating', isBusy);
  syncOscarComposerState();
  renderGenerationStatus();
}

function readOscarOwnerDevSettings() {
  return state.data?.ownerDev || {};
}

function enforceOscarOwnerDevState() {
  const dev = readOscarOwnerDevSettings();
  if (dev.internetEnabled === false) state.oscar.web = false;
  if (dev.memoryEnabled === false || dev.zeroRetentionEnabled === true) state.oscar.memoryPanelOpen = false;
  if (dev.skillsEnabled === false) {
    state.oscar.activeSkills = [];
    state.oscar.selectedSkill = null;
    state.oscar.skillPickerOpen = false;
  }
  if (dev.zeroRetentionEnabled !== true || state.oscar.busy || state.oscar.incognito) return;
  forgetActiveOscarSession();
  state.oscar.messages = [];
  state.oscar.conversationId = null;
  state.oscar.incognito = true;
  state.oscar.encrypted = false;
  state.oscar.editingMessageId = null;
  state.oscar.context = null;
  state.oscar.historyPanelOpen = false;
  state.oscar.memoryPanelOpen = false;
  resetOscarMessagePage();
}

function setOscarMissionsOpen(open) {
  oscarMissionsOpen = open === true;
  if (elements.oscarMissionsPanel) elements.oscarMissionsPanel.hidden = !oscarMissionsOpen;
  elements.oscarMissionsToggle?.setAttribute('aria-expanded', String(oscarMissionsOpen));
  if (oscarMissionsPollTimer) {
    clearInterval(oscarMissionsPollTimer);
    oscarMissionsPollTimer = null;
  }
  if (!oscarMissionsOpen) return;
  void loadOscarMissions();
  oscarMissionsPollTimer = setInterval(() => {
    if (oscarMissionsOpen && !document.hidden) void loadOscarMissions({ silent: true });
  }, 3_000);
}

async function loadOscarMissions(options = {}) {
  if (oscarMissionsLoading) return;
  oscarMissionsLoading = true;
  if (!options.silent) renderOscarMissions();
  try {
    const payload = await listAgentTasks(50);
    oscarMissionTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  } catch (error) {
    if (!options.silent && elements.oscarMissionsSummary) {
      elements.oscarMissionsSummary.textContent = error instanceof Error ? error.message : String(error);
    }
  } finally {
    oscarMissionsLoading = false;
    renderOscarMissions();
  }
}

async function clearOscarHistory() {
  if (state.oscar.historyBusy || state.oscar.safeChatBusy || state.oscar.busy) return;
  const conversations = [...(state.oscar.conversations || [])];
  if (conversations.length === 0) return;
  const encrypted = conversations.filter((conversation) => conversation.encrypted === true);
  const hasPersistentConversations = conversations.some((conversation) => conversation.encrypted !== true);
  const safeMessage = encrypted.length > 0
    ? ' Зашифрованные чаты в Safe будут удалены только после проверки доступности Safe.'
    : '';
  if (!window.confirm(
    `Очистить историю чатов? Обычные чаты будут удалены, а связанные с поручениями — перемещены в архив.${safeMessage}`,
  )) return;

  state.oscar.historyBusy = true;
  state.oscar.safeChatBusy = encrypted.length > 0;
  state.oscar.error = '';
  renderConversationList();
  const failures = [];
  let persistentResult = null;
  try {
    if (hasPersistentConversations) {
      const result = await executeOscarCapabilityAction(
        'oscar.conversations.manage',
        { action: 'clear' },
        false,
      );
      persistentResult = result.output || {};
    }

    if (encrypted.length > 0) {
      let bridge;
      try {
        bridge = requireSafeChatBridge();
        const status = await bridge.getSafeChatStatus();
        if (status?.unlocked !== true) {
          await bridge.openSafe?.();
          throw new Error('Monarch Safe заблокирован. Защищённые чаты не удалены.');
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }

      if (bridge && failures.length === 0) {
        for (const conversation of encrypted) {
          try {
            const payload = await bridge.readSafeChat(conversation.id, 'oscar');
            if (hasActionLinkedConversationEvidence(payload?.record)) {
              failures.push(`«${formatConversationTitle(conversation)}» связано с поручением и оставлено в Safe.`);
              continue;
            }
            await bridge.deleteSafeChat(conversation.id, 'oscar');
          } catch (error) {
            failures.push(`«${formatConversationTitle(conversation)}»: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    clearActiveOscarConversationState();
    await loadOscarConversations({ supersede: true });
    const deleted = Number(persistentResult?.deleted || 0);
    const archived = Number(persistentResult?.archived || 0);
    if (failures.length > 0) {
      const details = failures.slice(0, 2).join(' ');
      const suffix = failures.length > 2 ? ` Ещё ошибок: ${failures.length - 2}.` : '';
      state.oscar.error = `История очищена частично: удалено обычных чатов ${deleted}, в архиве ${archived}. ${details}${suffix}`;
    }
  } catch (error) {
    state.oscar.error = formatOscarStatusError(error);
  } finally {
    state.oscar.historyBusy = false;
    state.oscar.safeChatBusy = false;
    renderApp();
  }
}

function hasActionLinkedConversationEvidence(record) {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  return messages.some((message) => {
    const provenance = message?.provenance;
    const verification = String(provenance?.verification || message?.verification || '');
    return Boolean(
      message?.task_id
      || message?.taskId
      || provenance?.taskId
      || provenance?.task_id
      || message?.outcome === 'verified'
      || verification === 'kernel-verified'
      || verification === 'kernel-observation',
    );
  });
}

function scheduleOscarMissionsRefresh() {
  if (!oscarMissionsOpen || oscarMissionsRefreshTimer) return;
  oscarMissionsRefreshTimer = setTimeout(() => {
    oscarMissionsRefreshTimer = null;
    void loadOscarMissions({ silent: true });
  }, 180);
}

function renderOscarMissions() {
  if (!elements.oscarMissionsList) return;
  const active = oscarMissionTasks.filter((task) => !isTerminalOscarMission(task));
  if (elements.oscarMissionsSummary) {
    elements.oscarMissionsSummary.textContent = oscarMissionsLoading
      ? 'Синхронизирую локальный журнал…'
      : `${active.length} активных · ${oscarMissionTasks.length} всего`;
  }
  if (!oscarMissionTasks.length) {
    elements.oscarMissionsList.innerHTML = '<div class="oscar-missions-empty">Здесь появятся только реальные Agent Tasks.<br>Обычные вопросы остаются обычным чатом.</div>';
    return;
  }
  elements.oscarMissionsList.innerHTML = oscarMissionTasks.map((task) => renderOscarMission(task)).join('');
}

function renderOscarMission(task) {
  const steps = Array.isArray(task?.plan?.steps) ? task.plan.steps : [];
  const current = steps.find((step) => step.id === task.currentStepId)
    || steps.find((step) => ['running', 'waiting-approval', 'blocked', 'ready'].includes(step.status))
    || steps.at(-1);
  const observations = Array.isArray(task.observations)
    ? task.observations.filter((entry) => entry.status === 'success').slice(-2).reverse()
    : [];
  const approval = Array.isArray(task.approvals)
    ? task.approvals.find((entry) => entry.id === task.activeApprovalId && entry.status === 'pending')
    : null;
  const terminal = isTerminalOscarMission(task);
  const expanded = expandedOscarMissions.has(task.id) || (!terminal && steps.length > 1);
  const compact = steps.length <= 1;
  const actions = [];
  if (task.status === 'paused' || task.status === 'interrupted' || task.status === 'created') {
    actions.push(missionActionButton(task.id, 'resume', 'Продолжить'));
  } else if (!terminal && task.status !== 'waiting-for-approval' && task.status !== 'waiting-for-user' && task.status !== 'cancelling') {
    actions.push(missionActionButton(task.id, 'pause', 'Пауза'));
  }
  if (approval) {
    const bindingKey = oscarMissionApprovalBindingKey(task.id, approval);
    const requiresArm = requiresSensitiveApprovalArm(approval);
    actions.push(missionActionButton(
      task.id,
      'approve',
      requiresArm
        ? armedOscarMissionApprovals.has(bindingKey) ? 'Подтвердить точное действие' : 'Arm'
        : 'Разрешить один раз',
    ));
    actions.push(missionActionButton(task.id, 'deny', 'Отклонить'));
  }
  if (!terminal) actions.push(missionActionButton(task.id, 'cancel', 'Отменить'));
  if (terminal) actions.push(missionActionButton(task.id, 'repeat', 'Повторить'));
  const title = task.goal?.originalRequest || task.goal?.normalizedObjective || 'Поручение Oscar';
  const latestObservation = observations[0]?.summary
    || (task.status === 'cancelled' ? formatAgentTaskCancellation() : task.terminalReason?.summary)
    || '';
  return `
    <article class="oscar-mission ${terminal ? '' : 'is-active'} ${compact ? 'is-compact' : ''}" data-status="${escapeHtml(String(task.status || 'created'))}" role="listitem">
      <div class="oscar-mission-head">
        <span class="oscar-mission-state">${escapeHtml(oscarMissionStatusLabel(task.status))}</span>
        <div class="oscar-mission-title">
          <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
          <small>${escapeHtml(formatOscarMissionTime(task.updatedAt || task.createdAt))}${task.parentTaskId ? ' · повтор' : ''}</small>
        </div>
        <button class="oscar-mission-toggle-detail" type="button" data-mission-detail="${escapeHtml(task.id)}" aria-label="${expanded ? 'Свернуть' : 'Развернуть'}">${expanded ? '⌃' : '⌄'}</button>
      </div>
      <div class="oscar-mission-detail" ${expanded ? '' : 'hidden'}>
        ${current ? `<div class="oscar-mission-current"><span>Текущий шаг</span><br>${escapeHtml(current.title || current.expectedEffects?.[0]?.description || 'Проверяю состояние')}</div>` : ''}
        ${steps.length > 1 ? `<div class="oscar-mission-plan">${steps.map((step) => `<div class="oscar-mission-step is-${escapeHtml(step.status)}">${escapeHtml(step.title || 'Шаг')}</div>`).join('')}</div>` : ''}
        ${approval ? renderOscarMissionApproval(approval) : ''}
        ${latestObservation ? `<div class="oscar-mission-observation"><span>${terminal ? 'Результат' : 'Проверено'}</span><br>${escapeHtml(latestObservation)}</div>` : ''}
      </div>
      <div class="oscar-mission-actions">${actions.join('')}</div>
    </article>`;
}

function missionActionButton(taskId, action, label) {
  return `<button type="button" data-mission-action="${action}" data-task-id="${escapeHtml(taskId)}">${label}</button>`;
}

async function runOscarMissionAction(taskId, action, button) {
  button.disabled = true;
  try {
    const task = oscarMissionTasks.find((entry) => entry.id === taskId);
    if (action === 'pause') await pauseAgentTask(taskId);
    else if (action === 'resume') await resumeAgentTask(taskId);
    else if (action === 'cancel') await cancelAgentTask(taskId);
    else if (action === 'repeat') await repeatAgentTask(taskId);
    else if (action === 'approve' || action === 'deny') {
      const approval = task?.approvals?.find((entry) => entry.id === task.activeApprovalId && entry.status === 'pending');
      if (!approval) throw new Error('Активное подтверждение уже изменилось.');
      const bindingKey = oscarMissionApprovalBindingKey(taskId, approval);
      if (action === 'approve' && requiresSensitiveApprovalArm(approval) && !armedOscarMissionApprovals.has(bindingKey)) {
        const armed = await armAgentTaskApproval(taskId, approval.id, {
          canonicalProposalHash: approval.canonicalProposalHash,
          capabilityId: approval.capabilityId,
        });
        armedOscarMissionApprovals.add(bindingKey);
        const expiresAt = Date.parse(armed?.arm?.expiresAt || '');
        window.setTimeout(() => {
          armedOscarMissionApprovals.delete(bindingKey);
          if (oscarMissionsOpen) renderOscarMissions();
        }, Math.max(0, Number.isFinite(expiresAt) ? expiresAt - Date.now() + 25 : 8_025));
        renderOscarMissions();
        return;
      }
      armedOscarMissionApprovals.delete(bindingKey);
      await resolveAgentTaskApproval(
        taskId,
        approval.id,
        action === 'approve' ? 'approve' : 'deny',
        'once',
        {
          canonicalProposalHash: approval.canonicalProposalHash,
          capabilityId: approval.capabilityId,
        },
      );
    }
    await loadOscarMissions({ silent: true });
  } catch (error) {
    if (elements.oscarMissionsSummary) {
      elements.oscarMissionsSummary.textContent = error instanceof Error ? error.message : String(error);
    }
  } finally {
    button.disabled = false;
  }
}

function oscarMissionApprovalBindingKey(taskId, approval) {
  return `${taskId}:${String(approval?.id || '')}:${String(approval?.canonicalProposalHash || '')}`;
}

function requiresSensitiveApprovalArm(approval) {
  const effect = String(approval?.proposal?.riskVector?.effect || '');
  return /(?:delete|device-control|identity|irreversible|sensitive)/i.test(effect)
    || /(?:delete|trash|recycle-bin\.empty|identity|credential)/i.test(String(approval?.capabilityId || ''));
}

function renderOscarMissionApproval(approval) {
  const proposal = approval?.proposal || {};
  const args = proposal?.args || {};
  const target = args.path || args.target || args.app || args.url || proposal?.scope?.targets?.[0] || 'точная цель не указана';
  const hash = String(approval?.canonicalProposalHash || '');
  return `<div class="oscar-mission-approval">
    <span>Требуется подтверждение</span><br>
    <strong>${escapeHtml(String(approval?.capabilityId || 'действие'))}</strong><br>
    Цель: <code>${escapeHtml(String(target))}</code><br>
    Эффект: ${escapeHtml(String(proposal?.riskVector?.effect || approval?.reason || 'локальное действие'))}
    ${hash ? `<br><small>Отпечаток: ${escapeHtml(hash.slice(0, 24))}…</small>` : ''}
  </div>`;
}

function isTerminalOscarMission(task) {
  return ['completed', 'failed', 'cancelled'].includes(task?.status);
}

function oscarMissionStatusLabel(status) {
  const labels = {
    created: 'создано',
    preparing: 'готовлю',
    running: 'в работе',
    'waiting-for-user': 'уточнение',
    'waiting-for-approval': 'доступ',
    'waiting-for-runtime': 'runtime',
    paused: 'пауза',
    cancelling: 'отмена',
    interrupted: 'прервано',
    completed: 'готово',
    failed: 'ошибка',
    cancelled: 'отменено',
  };
  return labels[status] || String(status || 'задача');
}

function formatOscarMissionTime(value) {
  const parsed = new Date(value || 0);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

async function consumeOscarTurn({
  turnId,
  text,
  pendingMessageId,
  showTrace,
  appRenderCallback,
  after = 0,
}) {
  activeOscarTurnStreamController?.abort();
  const streamController = new AbortController();
  activeOscarTurnStreamController = streamController;
  activeOscarTurnId = turnId;
  let content = '';
  let lastSequence = Number(after || 0);
  const progress = [];
  const remember = (kind, label, detail = '', activity = null) => {
    progress.push({
      kind,
      label,
      detail: detail || label,
      ...(activity && typeof activity === 'object' ? { activity: { ...activity } } : {}),
      at: new Date().toISOString(),
    });
    if (progress.length > 8) progress.shift();
  };
  const renderProgress = (phase, label, detail = '', activity = null) => {
    remember(phase, label, detail, activity);
    replacePendingOscarMessage(createOscarMessage('assistant', content, 'Oscar · Turn', {
      pending: true,
      showTrace,
      streamPhase: phase,
      streamEvents: [...progress],
      turnId,
    }), pendingMessageId);
    setGenerationPhase(label, detail || 'Turn Coordinator');
    setMascotState(/kernel|task|approval|observation/i.test(phase) ? 'listening' : 'thinking', { detail: label });
    renderOscarStreamFrame();
  };
  renderProgress('turn-routing', 'Маршрут · Задача', 'Определяю безопасный контур');
  try {
    for await (const envelope of await streamOscarTurn(turnId, after, { signal: streamController.signal })) {
      const event = envelope?.data?.event || {};
      const payload = event.payload || {};
      lastSequence = Math.max(lastSequence, Number(event.sequence || 0));
      switch (envelope.type) {
      case 'turn.routed':
        renderProgress(payload.disposition === 'agent' ? 'turn-agent' : 'turn-answer',
          payload.disposition === 'agent' ? 'Запуск · Задача' : 'Ответ · Локально',
          payload.disposition === 'agent' ? 'Подготавливаю проверяемые действия' : 'Формирую ответ');
        break;
      case 'task.linked':
        activeOscarAgentTaskId = String(payload.taskId || '');
        scheduleOscarMissionsRefresh();
        renderProgress('turn-task', 'Подготовка · Инструменты', 'Задача принята Agent Runtime');
        break;
      case 'agent.progress':
        renderProgress(
          `agent-${String(payload.phase || 'running')}`,
          String(payload.label || 'Agent выполняет задачу'),
          String(payload.detail || ''),
          payload.activity && typeof payload.activity === 'object' ? payload.activity : null,
        );
        break;
      case 'answer.delta': {
        const delta = typeof payload.content === 'string' ? payload.content : '';
        if (delta) content += delta;
        state.oscar.streamTokens += delta ? 1 : 0;
        renderProgress('turn-answer', 'Ответ · Проверка', 'Проверяю видимый текст');
        break;
      }
      case 'answer.replace': {
        content = typeof payload.content === 'string' ? payload.content : '';
        renderProgress('turn-answer', 'Ответ · Обновление', 'Применяю проверенную версию');
        break;
      }
      case 'approval.required': {
        const taskId = String(payload.taskId || '');
        const approvalId = String(payload.approvalId || '');
        replacePendingOscarMessage(createOscarMessage('assistant', [
          '**Monarch Access подготовил точное действие.**',
          payload.target ? `\nЦель: \`${String(payload.target)}\`` : '',
          payload.expiresAt ? `\nДействует до: ${new Date(payload.expiresAt).toLocaleTimeString('ru-RU')}` : '',
        ].join('\n'), 'Oscar · Monarch Access', {
          turnId,
          provenance: { origin: 'system', verification: 'system-state' },
          outcome: 'waiting-for-approval',
          action: {
            text: String(payload.capabilityId || 'действие'),
            risk: String(payload.risk || 'действие'),
            target: String(payload.target || ''),
            expiresAt: String(payload.expiresAt || ''),
            proposalHash: String(payload.canonicalProposalHash || ''),
            label: 'Разрешить один раз',
            grantOptions: ['once'],
            requiresArm: payload.requiresArm === true,
            agentTaskId: taskId,
            agentApprovalId: approvalId,
            agentApprovalHash: String(payload.canonicalProposalHash || ''),
            agentCapabilityId: String(payload.capabilityId || ''),
            agentAfter: lastSequence,
            oscarTurnId: turnId,
            oscarTurnAfter: lastSequence,
            originatingUserText: text,
            showTrace,
          },
        }), pendingMessageId);
        activeOscarTurnId = '';
        activeOscarAgentTaskId = '';
        appRenderCallback();
        return { status: 'waiting-for-approval', turnId, sequence: lastSequence };
      }
      case 'user.input.required':
        waitingOscarTurn = {
          turnId,
          conversationId: state.oscar.conversationId,
          after: lastSequence,
          originalText: text,
        };
        replacePendingOscarMessage(createOscarMessage(
          'assistant',
          String(payload.question || 'Нужно уточнение для продолжения задачи.'),
          'Oscar · уточнение',
          { turnId, outcome: 'waiting-for-user', provenance: { origin: 'system', verification: 'system-state' } },
        ), pendingMessageId);
        activeOscarTurnId = '';
        activeOscarAgentTaskId = '';
        appRenderCallback();
        return { status: 'waiting-for-user', turnId, sequence: lastSequence };
      case 'non-authoritative-confirmation':
        renderProgress('turn-approval', 'Текст не является подтверждением', 'Фокусирую текущую action-card');
        break;
      case 'turn.outcome': {
        const checkpoint = await fetchOscarTurn(turnId, { signal: streamController.signal });
        const outcome = String(checkpoint?.turn?.outcome?.kind || payload.outcome || 'failed');
        const checkpointSummary = String(checkpoint?.turn?.outcome?.summary || '');
        const payloadSummary = String(payload.summary || '');
        const rawSummary = checkpointSummary.trim()
          ? checkpointSummary
          : payloadSummary.trim() ? payloadSummary : content;
        const summary = presentOscarHistoryContent(rawSummary, outcome);
        const evidence = Array.isArray(checkpoint?.turn?.outcome?.evidenceRefs)
          ? checkpoint.turn.outcome.evidenceRefs
          : [];
        const sources = evidence
          .filter((entry) => entry?.evidenceClass === 'external-source')
          .map((entry) => {
            const reference = String(entry.reference || '');
            const memory = reference.startsWith('memory://');
            return {
              title: memory ? 'Из памяти' : entry.summary || 'Источник',
              detail: memory ? String(entry.summary || 'Локальный контекст Memory V4') : '',
              url: reference,
              ...(memory ? { kind: 'memory' } : {}),
            };
          });
        const verification = outcome === 'verified'
          ? 'kernel-verified'
          : outcome === 'partial' ? 'kernel-partial'
          : outcome === 'answered:source-grounded' ? 'source-grounded'
          : ['blocked', 'failed', 'cancelled'].includes(outcome) ? 'system-state' : 'unverified-model';
        const origin = verification === 'kernel-verified' || verification === 'kernel-partial'
          ? 'kernel'
          : verification === 'system-state' ? 'system'
          : sources.length ? 'external-source' : 'model';
        replacePendingOscarMessage(createOscarMessage('assistant', summary || 'Turn завершён без отображаемого текста.', 'Oscar', {
          turnId,
          taskId: checkpoint?.turn?.taskId || '',
          outcome,
          provenance: { origin, verification },
          integrityWarning: checkpoint?.turn?.outcome?.warning || '',
          sources,
          error: outcome === 'failed',
          showTrace,
          streamEvents: [...progress],
        }), pendingMessageId);
        state.oscar.context = { summary, request: { turnId }, sources, outcome, provenance: verification };
        setMascotState(outcome === 'failed' ? 'error' : outcome === 'cancelled' ? 'idle' : 'success');
        activeOscarTurnId = '';
        activeOscarAgentTaskId = '';
        appRenderCallback();
        return { status: checkpoint?.turn?.status || 'succeeded', turnId, sequence: lastSequence };
      }
      case 'turn.failed': {
        const summary = String(payload.summary || 'Turn завершился с ошибкой.');
        replacePendingOscarMessage(createOscarMessage('assistant', summary, 'Oscar · ошибка', {
          turnId,
          outcome: 'failed',
          provenance: { origin: 'system', verification: 'system-state' },
          error: true,
        }), pendingMessageId);
        state.oscar.context = { summary, request: { turnId }, sources: [], outcome: 'failed' };
        setMascotState('error', { detail: summary });
        activeOscarTurnId = '';
        activeOscarAgentTaskId = '';
        appRenderCallback();
        return { status: 'failed', turnId, sequence: lastSequence };
      }
      default:
        break;
      }
    }
    throw new Error('Oscar Turn stream closed without a replayable terminal outcome.');
  } catch (error) {
    if (isAbortError(error) && state.oscar.stopRequested) {
      const replaced = settleLocalOscarCancellation({
        pendingMessageId,
        turnId,
        showTrace,
        streamEvents: [...progress],
      });
      if (replaced) {
        appRenderCallback();
      }
      return { status: 'cancelled', turnId, sequence: lastSequence };
    }
    throw error;
  } finally {
    if (activeOscarTurnId === turnId) activeOscarTurnId = '';
    if (activeOscarTurnStreamController === streamController) activeOscarTurnStreamController = null;
  }
}

function settleLocalOscarCancellation({ pendingMessageId, turnId = '', showTrace = false, streamEvents = [] }) {
  const summary = formatAgentTaskCancellation();
  const boundTurnId = String(turnId || '').trim();
  const replaced = replacePendingOscarMessage(createOscarMessage('assistant', summary, 'Oscar · отмена', {
    turnId: boundTurnId,
    outcome: 'cancelled',
    provenance: { origin: 'system', verification: 'system-state' },
    showTrace,
    streamEvents,
  }), pendingMessageId);
  if (!replaced) return false;
  state.oscar.context = {
    summary,
    request: boundTurnId ? { turnId: boundTurnId } : null,
    sources: [],
    outcome: 'cancelled',
    provenance: 'system-state',
  };
  setMascotState('idle');
  return true;
}

function formatAgentTaskCancellation() {
  return OSCAR_CANCELLED_SUMMARY;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function throwIfOscarSubmissionAborted(signal) {
  throwIfOscarRequestAborted(signal);
}

function throwIfOscarRequestAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || new DOMException('Aborted', 'AbortError');
  }
}

function isOscarTurnCancellationConfirmed(checkpoint) {
  return checkpoint?.turn?.status === 'cancelled'
    || checkpoint?.turn?.outcome?.kind === 'cancelled';
}

function isOscarTurnTerminal(checkpoint) {
  return ['succeeded', 'failed', 'blocked', 'cancelled'].includes(String(checkpoint?.turn?.status || ''));
}

async function armOscarMessageAction(messageId, button) {
  const message = state.oscar.messages.find((entry) => entry.id === messageId);
  const action = message?.action;
  if (!action?.requiresArm || !action.agentTaskId || !action.agentApprovalId) return;
  button.disabled = true;
  try {
    const response = await armAgentTaskApproval(action.agentTaskId, action.agentApprovalId, {
      canonicalProposalHash: action.agentApprovalHash,
      capabilityId: action.agentCapabilityId,
    });
    const expiresAt = Date.parse(response?.arm?.expiresAt || '');
    const armedUntil = Number.isFinite(expiresAt) ? expiresAt : Date.now() + 8_000;
    if (message.action?.agentApprovalHash !== action.agentApprovalHash) return;
    message.action.armedUntil = armedUntil;
    renderOscar();
    window.setTimeout(() => {
      if (message.action?.armedUntil !== armedUntil) return;
      message.action.armedUntil = 0;
      renderOscar();
    }, Math.max(0, armedUntil - Date.now() + 25));
  } catch (error) {
    state.oscar.error = error instanceof Error ? error.message : String(error);
    renderApp();
  } finally {
    button.disabled = false;
  }
}

async function settleOscarAgentApproval(
  taskId,
  approvalId,
  decision,
  messageId,
  appRenderCallback,
  grantScope,
) {
  if (!taskId || !approvalId || state.oscar.busy) return;
  const message = state.oscar.messages.find((entry) => entry.id === messageId);
  const action = message?.action || {};
  const approvalTurnId = String(action.oscarTurnId || '').trim();
  const approvalController = new AbortController();
  const approvalSettlement = {
    controller: approvalController,
    turnId: approvalTurnId,
    cancellationConfirmed: false,
  };
  activeOscarApprovalSettlement = approvalSettlement;
  if (message) {
    message.pending = true;
    message.action = { ...action, settling: true };
    message.content = decision === 'approve'
      ? 'Monarch Access применяет разрешение к точному Agent Task…'
      : 'Останавливаю действие — разрешение отклонено.';
  }
  setOscarBusy(true);
  activeOscarAgentTaskId = taskId;
  renderOscar();
  try {
    if (!approvalTurnId) {
      throw new Error('Устаревшая approval-карточка не связана с Oscar Turn и не может выполнить действие.');
    }
    if (oscarSpeechController?.releaseForInference) {
      await oscarSpeechController.releaseForInference();
    }
    await resolveAgentTaskApproval(taskId, approvalId, decision, grantScope, {
      canonicalProposalHash: action.agentApprovalHash,
      capabilityId: action.agentCapabilityId,
    }, { signal: approvalController.signal });
    throwIfOscarRequestAborted(approvalController.signal);
    const resumedTurn = await consumeOscarTurn({
      turnId: approvalTurnId,
      text: action.originatingUserText || '',
      pendingMessageId: messageId,
      showTrace: action.showTrace === true,
      appRenderCallback,
      after: Number(action.oscarTurnAfter || 0),
    });
    if (resumedTurn?.status === 'succeeded') {
      await loadOscarStatus(appRenderCallback, {
        captureContextForConversation: state.oscar.conversationId,
      });
    }
  } catch (error) {
    if (isAbortError(error) && state.oscar.stopRequested && approvalSettlement.cancellationConfirmed) {
      settleLocalOscarCancellation({
        pendingMessageId: messageId,
        turnId: approvalTurnId,
      });
    } else if (error?.code === 'approval-binding-mismatch' && await refreshChangedOscarApproval({
      taskId,
      message,
      action,
    })) {
      state.oscar.error = '';
    } else {
      if (message) {
        message.pending = false;
        message.action = { ...action, settling: false };
      }
      settleLocalOscarError({
        error,
        pendingMessageId: messageId,
        turnId: approvalTurnId,
        label: 'Oscar · Monarch Access',
      });
    }
  } finally {
    if (activeOscarApprovalSettlement === approvalSettlement) {
      activeOscarApprovalSettlement = null;
    }
    activeOscarAgentTaskId = '';
    setOscarBusy(false);
    appRenderCallback();
  }
}

async function refreshChangedOscarApproval({ taskId, message, action }) {
  if (!message) return false;
  try {
    const payload = await fetchAgentTask(taskId);
    const checkpoint = payload?.checkpoint;
    const task = checkpoint?.task;
    const approval = Array.isArray(checkpoint?.approvals)
      ? checkpoint.approvals.find((entry) => entry.id === task?.activeApprovalId && entry.status === 'pending')
      : null;
    if (!approval) return false;
    const proposal = approval.proposal && typeof approval.proposal === 'object' ? approval.proposal : {};
    const risk = readAgentApprovalRisk(proposal);
    const target = readAgentApprovalTarget(proposal);
    const requiresArm = ['delete', 'device-control', 'identity', 'irreversible', 'sensitive'].includes(risk)
      || /(?:delete|trash|recycle-bin\.empty|identity|credential)/i.test(String(approval.capabilityId || ''));
    message.pending = false;
    message.error = false;
    message.content = [
      '**Действие изменилось — проверь точную цель ещё раз.**',
      target ? `\nЦель: \`${target}\`` : '',
      approval.expiresAt ? `\nДействует до: ${new Date(approval.expiresAt).toLocaleTimeString('ru-RU')}` : '',
    ].join('');
    message.action = {
      ...action,
      settling: false,
      armedUntil: 0,
      text: String(approval.capabilityId || 'действие'),
      risk,
      target,
      expiresAt: String(approval.expiresAt || ''),
      proposalHash: String(approval.canonicalProposalHash || ''),
      requiresArm,
      agentApprovalId: String(approval.id || ''),
      agentApprovalHash: String(approval.canonicalProposalHash || ''),
      agentCapabilityId: String(approval.capabilityId || ''),
    };
    return true;
  } catch {
    return false;
  }
}

function readAgentApprovalRisk(proposal) {
  const riskVector = proposal?.riskVector;
  return riskVector && typeof riskVector === 'object'
    ? String(riskVector.effect || riskVector.risk || 'action')
    : 'action';
}

function readAgentApprovalTarget(proposal) {
  const args = proposal?.args;
  if (args && typeof args === 'object') {
    for (const key of ['path', 'targetPath', 'target', 'app', 'url', 'device']) {
      if (typeof args[key] === 'string' && args[key]) return args[key];
    }
  }
  const paths = proposal?.scope?.paths;
  return Array.isArray(paths) && typeof paths[0] === 'string' ? paths[0] : '';
}

function subsystemDisplayName(moduleId) {
  const names = {
    assistant: 'Monarch Agent',
    astra: 'Monarch Skills',
    diagnostics: 'Monarch Diagnostics',
    device: 'Monarch Device',
    memory: 'Monarch Memory',
    models: 'Monarch Models',
    oscar: 'Monarch Oscar',
    plugins: 'Monarch Extensions',
    security: 'Monarch Security',
    workspace: 'Monarch Workspace',
    'custom-tools': 'Monarch Tools',
  };
  return names[moduleId] || `Monarch ${String(moduleId || 'System')}`;
}

async function stopOscarGeneration(appRenderCallback) {
  if (!state.oscar.busy || state.oscar.stopRequested) {
    return;
  }

  state.oscar.error = '';
  state.oscar.stopRequested = true;
  setMascotState('thinking', { title: 'Oscar', detail: 'Останавливаю генерацию...' });
  renderOscar();

  try {
    if (activeOscarTurnId) {
      const turnId = activeOscarTurnId;
      const streamController = activeOscarTurnStreamController;
      const cancelled = await cancelOscarTurnWithDeadline(turnId);
      if (isOscarTurnCancellationConfirmed(cancelled)) {
        activeOscarTurnId = '';
        streamController?.abort();
      } else if (isOscarTurnTerminal(cancelled)) {
        state.oscar.stopRequested = false;
      } else {
        throw new Error('Monarch не вернул подтверждённое состояние остановки Turn.');
      }
    } else if (activeOscarApprovalSettlement?.turnId) {
      const settlement = activeOscarApprovalSettlement;
      const cancelled = await cancelOscarTurnWithDeadline(settlement.turnId);
      if (isOscarTurnCancellationConfirmed(cancelled)) {
        settlement.cancellationConfirmed = true;
        settlement.controller.abort(new DOMException('Oscar approval settlement cancelled by user.', 'AbortError'));
      } else if (isOscarTurnTerminal(cancelled)) {
        state.oscar.stopRequested = false;
      } else {
        throw new Error('Monarch не вернул подтверждённое состояние остановки approval Turn.');
      }
    } else if (activeOscarSubmissionController) {
      settleOscarRouteConsent('deny', { immediate: true });
      const submission = activeOscarSubmission;
      if (submission?.turnCreationStarted) {
        const cancelled = submission.turnId
          ? await cancelOscarTurnWithDeadline(submission.turnId)
          : await cancelOscarSubmissionWithDeadline(
            submission.clientRequestId,
            submission.privacyMode,
          );
        const reservationConfirmed = cancelled?.cancellation?.reserved === true;
        if (reservationConfirmed || isOscarTurnCancellationConfirmed(cancelled)) {
          submission.cancellationConfirmed = true;
          submission.turnId = String(cancelled?.turn?.id || submission.turnId || '');
          rememberActiveOscarSession({
            conversationId: submission.conversationId,
            turnId: submission.turnId,
            clientRequestId: submission.clientRequestId,
            text: String(state.oscar.messages.find((message) => message.sendActive)?.content || ''),
            cancelRequested: true,
          });
          submission.controller.abort(
            new DOMException('Oscar submission cancelled by user.', 'AbortError'),
          );
          void denyUnusedOscarDataEgressConsent(submission);
        } else if (isOscarTurnTerminal(cancelled)) {
          state.oscar.stopRequested = false;
        } else {
          throw new Error('Monarch не подтвердил остановку создаваемого Turn.');
        }
      } else {
        (submission?.controller || activeOscarSubmissionController)?.abort(
          new DOMException('Oscar submission cancelled by user.', 'AbortError'),
        );
        void denyUnusedOscarDataEgressConsent(submission);
      }
    } else {
      await executeOscarCapabilityAction('oscar.generation.cancel', {}, false);
    }
  } catch (error) {
    const cancellationTimedOut = error?.name === 'TimeoutError';
    state.oscar.error = cancellationTimedOut
      ? 'Oscar не подтвердил остановку за 15 секунд. Turn продолжает отслеживаться — можно повторить Stop.'
      : error instanceof Error ? error.message : String(error);
    if (cancellationTimedOut) {
      markOscarCancellationRetry(state.oscar.error);
      setGenerationPhase('Остановка не подтверждена', state.oscar.error);
      setMascotState('error', { title: 'Oscar', detail: state.oscar.error });
    }
    state.oscar.stopRequested = false;
  } finally {
    appRenderCallback();
  }
}

async function cancelOscarTurnWithDeadline(turnId) {
  const cancelController = new AbortController();
  const cancelTimer = window.setTimeout(() => {
    cancelController.abort(new DOMException('Oscar cancellation acknowledgement timed out.', 'TimeoutError'));
  }, OSCAR_CANCEL_ACK_TIMEOUT_MS);
  try {
    return await cancelOscarTurn(turnId, { signal: cancelController.signal });
  } catch (error) {
    if (cancelController.signal.aborted && cancelController.signal.reason) {
      throw cancelController.signal.reason;
    }
    throw error;
  } finally {
    window.clearTimeout(cancelTimer);
  }
}

async function cancelOscarSubmissionWithDeadline(clientRequestId, privacyMode) {
  const cancelController = new AbortController();
  const cancelTimer = window.setTimeout(() => {
    cancelController.abort(new DOMException('Oscar submission cancellation timed out.', 'TimeoutError'));
  }, OSCAR_CANCEL_ACK_TIMEOUT_MS);
  try {
    return await cancelOscarTurnSubmission(clientRequestId, {
      privacyMode,
      signal: cancelController.signal,
    });
  } catch (error) {
    if (cancelController.signal.aborted && cancelController.signal.reason) {
      throw cancelController.signal.reason;
    }
    throw error;
  } finally {
    window.clearTimeout(cancelTimer);
  }
}

function denyUnusedOscarDataEgressConsent(submission) {
  if (!submission || submission.dataEgressCleanupPromise) {
    return submission?.dataEgressCleanupPromise || Promise.resolve();
  }
  const request = submission.dataEgressConsentRequest;
  const knownConsent = submission.dataEgressConsent;
  if (!request && !knownConsent?.id) return Promise.resolve();

  const cleanupController = new AbortController();
  const cleanupTimer = window.setTimeout(() => {
    cleanupController.abort(new DOMException('Oscar data-egress cleanup timed out.', 'TimeoutError'));
  }, OSCAR_DATA_EGRESS_CLEANUP_TIMEOUT_MS);
  submission.dataEgressCleanupPromise = (async () => {
    try {
      let consent = knownConsent;
      if (!consent?.id && request) {
        const proposal = await createOscarDataEgressConsent(request, {
          clientRequestId: submission.dataEgressConsentClientRequestId,
          signal: cleanupController.signal,
        });
        const proposed = proposal?.consent || {};
        consent = {
          id: String(proposed.id || ''),
          canonicalBindingHash: String(proposed.canonicalBindingHash || ''),
        };
        submission.dataEgressConsent = consent;
      }
      if (!consent?.id || !consent?.canonicalBindingHash) return;
      await decideOscarDataEgressConsent(
        consent.id,
        'deny',
        consent.canonicalBindingHash,
        { signal: cleanupController.signal },
      );
    } catch {
      // A consumed consent is immutable; an unreachable local server cannot
      // leak execution authority because every proposal is exact-bound and
      // expires after five minutes.
    } finally {
      window.clearTimeout(cleanupTimer);
    }
  })();
  return submission.dataEgressCleanupPromise;
}

function markOscarCancellationRetry(detail) {
  const pending = [...state.oscar.messages].reverse().find((message) => message.pending);
  if (!pending) return;
  pending.streamPhase = 'cancel-timeout';
  pending.streamEvents = [
    ...(Array.isArray(pending.streamEvents) ? pending.streamEvents : []),
    {
      kind: 'cancel-timeout',
      label: 'Остановка не подтверждена',
      detail: String(detail || ''),
      at: new Date().toISOString(),
    },
  ].slice(-8);
}

async function startOscarBackend(appRenderCallback) {
  if (state.oscar.statusBusy) {
    return;
  }

  state.oscar.statusBusy = true;
  state.oscar.error = '';
  setMascotState('thinking', { title: 'Oscar', detail: 'Запускаю backend...' });
  renderOscar();

  try {
    const result = await executeOscarCapabilityAction('oscar.backend.start', {}, true);
    state.oscar.status = result.output;
  } catch (error) {
    state.oscar.error = formatOscarUiError(error);
    const previousBackend = readOscarBackend(state.oscar) || {};
    state.oscar.status = {
      mode: 'monarch-port-bridge',
      nativePortStatus: 'backend-start-failed',
      backend: {
        ...previousBackend,
        connected: false,
        startupAttempted: true,
        error: state.oscar.error,
      },
    };
    setMascotState('error', { title: 'Oscar', detail: state.oscar.error });
  } finally {
    state.oscar.statusBusy = false;
    appRenderCallback();
  }
}

let emptyOscarGreeting = createOscarGreeting();
let previousOscarConversationEmpty = true;

export function renderOscar() {
  if (!elements.oscarThread) {
    return;
  }
  const scrollTarget = readOscarScrollTarget();
  const previousScrollTop = scrollTarget?.scrollTop || elements.oscarThread.scrollTop;

  syncOscarControlsToDom();
  renderOscarPriority();
  renderAssistantResources();
  renderOscarPills();
  renderOscarBackend();
  renderOscarContext();
  renderSkillRadar();
  renderConversationList();
  renderMemoryPanel();
  renderOscarAttachments();
  renderRamWarning();
  renderGenerationStatus();

  const isEmptyConversation = !hasSentOscarMessage(state.oscar.messages);
  elements.oscarThread.classList.toggle('is-empty', isEmptyConversation);
  elements.shell?.classList.toggle('mascot-empty-home', isEmptyConversation);
  elements.shell?.classList.toggle('mascot-dialog-active', !isEmptyConversation);
  elements.shell?.dispatchEvent(new Event('monarch:mascot-surface-changed'));
  if (isEmptyConversation) {
    if (!previousOscarConversationEmpty) emptyOscarGreeting = createOscarGreeting();
    animatedOscarUserMessages.clear();
    elements.oscarThread.innerHTML = `
      <div class="oscar-empty-focus">
        <div class="empty-mark" aria-hidden="true"><img src="/assets/brand/monarch-mark.png" alt="" /></div>
        <span class="empty-kicker">Oscar Workspace</span>
        <h1>${escapeHtml(emptyOscarGreeting.title)}</h1>
        ${emptyOscarGreeting.copy ? `<p>${escapeHtml(emptyOscarGreeting.copy)}</p>` : ''}
      </div>
    `;
  } else {
    const newHtml = renderOscarMessageWindow();
    syncThreadDOM(elements.oscarThread, newHtml);
    syncOscarWorkTimers();
    animateNewOscarUserMessages();
    syncOscarSpeechControls();
  }

  previousOscarConversationEmpty = isEmptyConversation;
  if (oscarAutoFollow) {
    scrollOscarToBottom();
  } else if (scrollTarget) {
    scrollTarget.scrollTop = previousScrollTop;
  } else {
    elements.oscarThread.scrollTop = previousScrollTop;
  }
  syncOscarComposerState();
  if (elements.oscarInput) {
    elements.oscarInput.disabled = state.oscar.busy || requiredModelBlocksChat();
  }
  if (elements.oscarEditingBanner) {
    const editingMessage = Boolean(state.oscar.editingMessageId);
    elements.oscarEditingBanner.hidden = !editingMessage;
    if (elements.oscarEditingCancel) {
      elements.oscarEditingCancel.disabled = !editingMessage;
      elements.oscarEditingCancel.tabIndex = editingMessage ? 0 : -1;
      elements.oscarEditingCancel.setAttribute('aria-hidden', String(!editingMessage));
    }
  }
  elements.oscarComposer?.classList.toggle('editing-message', Boolean(state.oscar.editingMessageId));
  syncOscarButtons();
}

function renderOscarStreamFrame() {
  if (!elements.oscarThread || state.oscar.messages.length === 0) return;
  const newHtml = renderOscarMessageWindow();
  syncThreadDOM(elements.oscarThread, newHtml);
  syncOscarWorkTimers();
  syncOscarSpeechControls();
  if (oscarAutoFollow) scrollOscarToBottom();
}

function setOscarWorkTimerRunning(isRunning) {
  if (oscarWorkTimerInterval !== null) {
    window.clearInterval(oscarWorkTimerInterval);
    oscarWorkTimerInterval = null;
  }
  syncOscarWorkTimers();
  if (isRunning) {
    oscarWorkTimerInterval = window.setInterval(syncOscarWorkTimers, 1000);
  }
}

function syncOscarWorkTimers() {
  if (!elements.oscarThread) return;
  const now = Date.now();
  for (const timer of elements.oscarThread.querySelectorAll('[data-oscar-work-timer]')) {
    const startedAt = Date.parse(timer.getAttribute('data-work-started-at') || '');
    const label = timer.querySelector('strong');
    if (!label || !Number.isFinite(startedAt)) continue;
    label.textContent = `Работает ${formatOscarWorkDuration(Math.max(0, now - startedAt))}`;
  }
}

function syncOscarSpeechControls() {
  if (!elements.oscarThread) return;
  const speechState = oscarSpeechController?.getState() || { status: 'idle', messageId: '', error: '' };
  const supported = oscarSpeechController?.isSupported() === true;
  for (const button of elements.oscarThread.querySelectorAll('[data-message-speak]')) {
    const messageId = button.getAttribute('data-message-speak') || '';
    const isActive = speechState.status === 'speaking' && speechState.messageId === messageId;
    const isError = speechState.status === 'error' && speechState.messageId === messageId;
    const label = isActive
      ? 'Остановить озвучку ответа Oscar'
      : supported
        ? 'Озвучить весь ответ Oscar'
        : 'Озвучка недоступна в этой оболочке';
    button.dataset.speechState = isActive ? 'speaking' : isError ? 'error' : 'idle';
    button.dataset.speechSupported = String(supported);
    button.setAttribute('aria-pressed', String(isActive));
    button.setAttribute('aria-label', label);
    button.title = label;
    const status = button.parentElement?.querySelector('[data-speech-status]');
    if (status) status.textContent = isActive ? 'Озвучиваю весь ответ' : isError ? speechState.error : '';
  }
}

function renderOscarMessageWindow() {
  const page = state.oscar.messagePage || {};
  const olderControl = page.hasMore ? `
    <div class="oscar-history-load">
      <button type="button" data-oscar-load-older ${state.oscar.historyPageBusy ? 'disabled aria-busy="true"' : ''}>
        ${state.oscar.historyPageBusy ? 'Загружаю ранние сообщения…' : 'Показать ранние сообщения'}
      </button>
    </div>
  ` : '';
  return olderControl + state.oscar.messages.map(renderOscarMessage).join('');
}

function readOscarScrollTarget() {
  const candidates = [
    elements.oscarSection,
    elements.oscarThread?.closest?.('.claude-view'),
    elements.oscarThread,
    document.scrollingElement,
  ].filter(Boolean);
  return candidates.find((target) => target.scrollHeight > target.clientHeight + 1)
    || candidates[0]
    || null;
}

function collectOscarScrollTargets() {
  return [...new Set([
    elements.oscarThread,
    elements.oscarSection,
    elements.oscarThread?.closest?.('.claude-view'),
    document.scrollingElement,
  ].filter(Boolean))];
}

function scrollOscarToBottom(behavior = 'auto') {
  for (const target of collectOscarScrollTargets()) {
    const top = target.scrollHeight;
    if (typeof target.scrollTo === 'function') {
      target.scrollTo({ top, behavior });
    } else {
      target.scrollTop = top;
    }
  }
}

function scheduleOscarScrollToBottom(behavior = 'auto') {
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const scrollBehavior = prefersReducedMotion ? 'auto' : behavior;
  const requestFrame = window.requestAnimationFrame?.bind(window);
  if (!requestFrame) {
    scrollOscarToBottom(scrollBehavior);
    return;
  }
  requestFrame(() => {
    scrollOscarToBottom(scrollBehavior);
    requestFrame(() => scrollOscarToBottom('auto'));
  });
}

function quickActionIcon(kind) {
  const icons = {
    context: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h10"></path><path d="M4 18h7"></path><path d="m16 15 2 2 4-5"></path></svg>',
    plan: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M4 12h10"></path><path d="M4 17h7"></path><path d="m17 14 3 3-3 3"></path></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"></path><path d="M14 2v5h5"></path><path d="M9 15h6"></path><path d="M12 12v6"></path></svg>',
  };
  return icons[kind] || icons.context;
}

function animateNewOscarUserMessages() {
  if (!elements.oscarThread || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    return;
  }
  elements.oscarThread.querySelectorAll('.oscar-message.user[data-send-active="true"][data-message-id]').forEach((item) => {
    const messageId = item.getAttribute('data-message-id');
    if (!messageId || animatedOscarUserMessages.has(messageId)) {
      return;
    }
    animatedOscarUserMessages.add(messageId);
    const card = item.querySelector('.oscar-message-card');
    if (typeof item.animate === 'function') {
      item.animate([
        { opacity: 0, transform: 'translate3d(26px, 18px, 0) scale(0.985)' },
        { opacity: 1, transform: 'translate3d(-2px, -1px, 0) scale(1.01)', offset: 0.72 },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
      ], {
        duration: 520,
        easing: 'cubic-bezier(0.18, 0.9, 0.18, 1)',
      });
    }
    if (card && typeof card.animate === 'function') {
      card.animate([
        { boxShadow: '0 0 0 rgba(217, 119, 6, 0)', filter: 'saturate(1)' },
        { boxShadow: '0 16px 38px rgba(217, 119, 6, 0.16)', filter: 'saturate(1.12)', offset: 0.48 },
        { boxShadow: '0 8px 22px rgba(9, 9, 11, 0.04)', filter: 'saturate(1)' },
      ], {
        duration: 760,
        easing: 'cubic-bezier(0.18, 0.9, 0.18, 1)',
      });
    }
  });
}

function setAssistantResource(element, value, state = 'unknown', ariaValue = value) {
  if (!element) return;
  element.textContent = value;
  const card = element.closest?.('.assistant-resource-card');
  if (card) {
    card.dataset.resourceState = state;
    const label = card.querySelector('span')?.textContent?.trim();
    if (label) {
      const resourceLabel = `${label}: ${ariaValue}`;
      card.setAttribute('aria-label', resourceLabel);
      card.title = resourceLabel;
    }
  }
}

function renderAssistantResources() {
  const backend = readOscarBackend(state.oscar);
  const modelStatus = readOscarModelStatus(state.oscar);
  const hardware = backend?.hardware && typeof backend.hardware === 'object' ? backend.hardware : null;
  const deviceMap = modelStatus?.device_map && typeof modelStatus.device_map === 'object' ? modelStatus.device_map : null;
  const waitingForStatus = !backend && !modelStatus;
  const pendingValue = waitingForStatus ? 'ожидание' : 'нет данных';
  const pendingAria = waitingForStatus ? 'ожидание проверки' : 'нет данных';

  if (elements.assistantGpuResource) {
    let gpuValue = pendingValue;
    let gpuAria = pendingAria;
    let gpuState = 'unknown';
    if (typeof hardware?.cuda_available === 'boolean') {
      if (hardware.cuda_available) {
        gpuValue = deviceMap?.backend === 'cuda' ? 'CUDA' : 'CUDA ок';
        gpuAria = gpuValue;
        gpuState = deviceMap?.backend === 'cuda' ? 'active' : 'ready';
      } else {
        gpuValue = 'CPU';
        gpuAria = 'CPU режим';
        gpuState = 'muted';
      }
    }
    setAssistantResource(elements.assistantGpuResource, gpuValue, gpuState, gpuAria);
  }

  if (elements.assistantVramResource) {
    const vram = Number(hardware?.vram_total_gb ?? hardware?.gpu_vram_total_gb);
    if (Number.isFinite(vram) && vram > 0) {
      setAssistantResource(elements.assistantVramResource, `${vram.toFixed(1)} ГБ`, 'ready');
    } else {
      setAssistantResource(
        elements.assistantVramResource,
        hardware ? 'нет' : pendingValue,
        hardware ? 'muted' : 'unknown',
        hardware ? 'видеопамять не найдена' : pendingAria,
      );
    }
  }

  if (elements.assistantRamResource) {
    const ram = Number(hardware?.ram_available_gb);
    if (Number.isFinite(ram)) {
      setAssistantResource(elements.assistantRamResource, `${ram.toFixed(1)} ГБ`, ram >= 8 ? 'ready' : 'watch', `${ram.toFixed(1)} ГБ свободно`);
    } else {
      setAssistantResource(elements.assistantRamResource, pendingValue, 'unknown', pendingAria);
    }
  }

  if (elements.assistantTorchResource) {
    let torchValue = waitingForStatus ? 'ожидание' : 'проверка';
    let torchAria = waitingForStatus ? 'ожидание проверки' : 'проверка';
    let torchState = 'unknown';
    if (modelStatus?.gpu_offload_available) {
      torchValue = 'готов';
      torchAria = 'готов';
      torchState = 'ready';
    } else if (modelStatus?.mock || modelStatus?.fallback_active) {
      torchValue = 'не нужен';
      torchAria = 'не нужен';
      torchState = 'muted';
    } else if (modelStatus) {
      torchValue = 'не найден';
      torchAria = 'не найден';
      torchState = 'watch';
    }
    setAssistantResource(elements.assistantTorchResource, torchValue, torchState, torchAria);
  }
}

function renderOscarPriority() {
  if (!elements.oscarPriorityCard) return;
  const backend = readOscarBackend(state.oscar);
  const modelStatus = readOscarModelStatus(state.oscar);
  const generation = state.oscar.generationStatus;
  let tone = 'pending';
  let title = 'Проверить локальный backend';
  let detail = 'Oscar готов к работе после запуска backend. Модель и память останутся рядом с полем ввода.';
  let action = 'Запустить backend';

  if (state.oscar.busy) {
    tone = 'working';
    title = generation?.title || 'Oscar работает';
    detail = generation?.detail || 'Идет локальная генерация. Дождись ответа или останови поток.';
    action = 'Дождаться ответа';
  } else if (state.oscar.error) {
    const offline = isOscarOfflineMessage(state.oscar.error);
    tone = offline ? 'pending' : 'danger';
    title = offline ? 'Подними backend' : 'Нужна проверка Oscar';
    detail = formatOscarUiError(state.oscar.error);
    action = offline ? 'Запустить backend' : 'Диагностика';
  } else if (state.oscar.statusBusy && !backend) {
    tone = 'working';
    title = 'Проверяю состояние';
    detail = 'Собираю backend, модель, память и доступные тировые режимы.';
    action = 'Подождать';
  } else if (backend?.connected) {
    tone = 'ready';
    title = 'Oscar готов к работе';
    detail = modelStatus?.loaded
      ? `Активная модель: ${formatOscarModelLabel(modelStatus.active_tier) || readOscarModeLabel(state.oscar, modelStatus)}.`
      : 'Backend в сети. Модель загрузится под запрос или останется в Auto.';
    action = state.oscar.messages.length ? 'Продолжить диалог' : 'Написать запрос';
  } else if (backend?.startupAttempted) {
    tone = 'danger';
    title = 'Backend не запустился';
    detail = backend.error || 'Запуск уже пробовали, но backend недоступен. Диагностика покажет причину.';
    action = 'Разобрать ошибку';
  }

  if (state.oscar.encrypted && !state.oscar.busy) {
    tone = 'ready';
    title = 'Чат защищён Monarch Safe';
    detail = 'История хранится только внутри разблокированного Safe. Память и обычная SQLite-персистентность отключены.';
    action = 'Encrypted chat';
  } else if (state.oscar.incognito && !state.oscar.busy) {
    tone = 'ready';
    const zeroRetention = readOscarOwnerDevSettings().zeroRetentionEnabled === true;
    title = zeroRetention ? 'Нулевое хранение активно' : 'Инкогнито-чат';
    detail = zeroRetention
      ? 'Содержимое живёт только в RAM этой сессии: без истории, памяти, TurnStore, файлов и текстовых логов.'
      : 'Диалог не сохранится в истории. Oscar не читает и не записывает постоянную память.';
    action = zeroRetention ? 'Owner DEV privacy' : 'Приватный диалог';
  }

  elements.oscarPriorityCard.dataset.tone = tone;
  if (elements.oscarPriorityTitle) elements.oscarPriorityTitle.textContent = title;
  if (elements.oscarPriorityDetail) elements.oscarPriorityDetail.textContent = detail;
  if (elements.oscarPriorityAction) elements.oscarPriorityAction.textContent = action;
  if (elements.oscarPriorityBackend) {
    elements.oscarPriorityBackend.textContent = backend
      ? readOscarBackendLabel(backend)
      : state.oscar.statusBusy
        ? 'проверка'
        : 'ожидание';
  }
  if (elements.oscarPriorityModel) {
    elements.oscarPriorityModel.textContent = modelStatus?.fallback_active
      ? 'fallback'
      : modelStatus?.mock
        ? 'mock'
        : modelStatus?.loaded
          ? formatOscarModelLabel(modelStatus.active_tier) || 'loaded'
          : readOscarModeLabel(state.oscar, modelStatus);
  }
  if (elements.oscarPriorityDevice) {
    const hardware = backend?.hardware && typeof backend.hardware === 'object' ? backend.hardware : null;
    elements.oscarPriorityDevice.textContent = hardware?.cuda_available ? 'CUDA' : 'CPU';
  }
  if (elements.oscarPriorityMemory) {
    elements.oscarPriorityMemory.textContent = backend?.memoryStats
      ? readOscarMemoryLabel(backend.memoryStats)
      : state.oscar.memoryItems?.length
        ? `${state.oscar.memoryItems.length} записей`
        : 'нет данных';
  }
}

function formatOscarUiError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (!message.trim()) return 'Oscar пока не вернул состояние.';
  if (/Unexpected token|DOCTYPE|Unsupported method|Failed to fetch|Load failed|NetworkError/i.test(message)) {
    return 'Нет связи с локальным Monarch/Oscar API. Запусти backend или открой UI через Monarch runtime.';
  }
  if (/endpoint|404|not found/i.test(message)) {
    return 'UI и локальный runtime смотрят в разные версии API. Перезапусти Monarch runtime.';
  }
  return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}

function formatOscarStatusError(error) {
  const message = formatOscarUiError(error);
  if (/внутренней ошибкой|endpoint|версии API|Monarch API/i.test(message)) {
    return 'Нет связи с Oscar. Запусти backend или открой UI через Monarch runtime.';
  }
  return message;
}

function isOscarOfflineMessage(message) {
  return /Нет связи|backend|runtime|API/i.test(String(message || ''));
}

function setGenerationPhase(title, detail = '') {
  state.oscar.generationStatus = { title, detail };
  renderGenerationStatus();
}

function renderGenerationStatus() {
  if (!elements.oscarGenerationStatus) return;
  const component = state.data?.components?.requiredModel;
  if (requiredModelBlocksChat() && component) {
    const percent = Math.max(0, Math.min(100, Math.round(Number(component.progress || 0) * 100)));
    elements.oscarGenerationStatus.hidden = false;
    elements.oscarGenerationStatus.dataset.phase = component.phase === 'failed' ? 'error' : 'route';
    const title = elements.oscarGenerationStatus.querySelector('strong');
    const detail = elements.oscarGenerationStatus.querySelector('span:last-child');
    if (title) title.textContent = component.phase === 'failed'
      ? 'Модель требует восстановления'
      : `Устанавливаю локальную модель · ${percent}%`;
    if (detail) detail.textContent = component.error || 'Monarch скачивает, проверяет SHA-256 и активирует Fast автоматически.';
    return;
  }
  const status = state.oscar.generationStatus;
  elements.oscarGenerationStatus.hidden = !state.oscar.busy || !status;
  if (!status) return;
  elements.oscarGenerationStatus.dataset.phase = resolveGenerationStatusPhase(status);
  const title = elements.oscarGenerationStatus.querySelector('strong');
  const detail = elements.oscarGenerationStatus.querySelector('span:last-child');
  if (title) title.textContent = status.title || 'Oscar работает';
  if (detail) detail.textContent = status.detail || 'Локальная генерация';
}

function resolveGenerationStatusPhase(status) {
  const text = `${status?.title || ''} ${status?.detail || ''}`.toLowerCase();
  if (/ошиб|fallback/.test(text)) return 'error';
  if (/проверяю полноту|пробел|противореч/.test(text)) return 'research-reflect';
  if (/пересобираю вывод|пересобран/.test(text)) return 'research-revise';
  if (/формирую окончательный|окончательный вывод|данных достаточно/.test(text)) return 'research-finalize';
  if (/планирую исследован|план исследован/.test(text)) return 'research-plan';
  if (/исследую направление|ветк.*поиск/.test(text)) return 'research-search';
  if (/читаю|материал|сверяю источник/.test(text)) return 'research-read';
  if (/синтезирую/.test(text)) return 'research-synthesize';
  if (/проверяю вывод|сверяю ключев/.test(text)) return 'research-verify';
  if (/поиск|контекст|источник|web|search|internet/.test(text)) return 'search';
  if (/пишу|ответ|фрагм|генерац/.test(text)) return 'write';
  if (/готов|останов/.test(text)) return 'done';
  return 'route';
}

function resolveStreamPhase(status, events = [], hasContent = false) {
  const latest = Array.isArray(events) && events.length ? events[events.length - 1] : null;
  const text = `${status || ''} ${latest?.kind || ''} ${latest?.label || ''} ${latest?.detail || ''}`.toLowerCase();
  if (/error|ошиб|fallback/.test(text)) return 'error';
  if (/research-finalize|research-decision|формирую окончательный|данных достаточно/.test(text)) return 'research-finalize';
  if (/research-revise|пересобираю вывод/.test(text)) return 'research-revise';
  if (/research-reflect|проверяю полноту|пробел|противореч/.test(text)) return 'research-reflect';
  if (/research-verify|проверяю вывод/.test(text)) return 'research-verify';
  if (/research-synthesize|синтезирую/.test(text)) return 'research-synthesize';
  if (/research-read|читаю|сверяю источники/.test(text)) return 'research-read';
  if (/research-search|исследую направление/.test(text)) return 'research-search';
  if (/research-plan|планирую исследование|план исследования/.test(text)) return 'research-plan';
  if (/source|источник|поиск|контекст|web|search|internet/.test(text)) return 'search';
  if (hasContent || /token|пишу|текст|ответ|фрагм|replace|уточн/.test(text)) return 'write';
  return 'route';
}

function renderRamWarning() {
  if (!elements.oscarRamWarning) return;
  const selectedModel = readOscarRequestedModel();
  const backend = readOscarBackend(state.oscar);
  const hardware = backend?.hardware && typeof backend.hardware === 'object' ? backend.hardware : null;
  const warning = buildOscarRamNotice({
    requestedModel: selectedModel,
    hardware,
    modelStatus: readOscarModelStatus(state.oscar),
    assessment: selectedModel === 'qwen3.8-27b-pro' ? state.oscar.ramWarning : null,
  });

  elements.oscarRamWarning.hidden = !warning;
  elements.oscarRamWarning.classList.toggle('critical', warning?.level === 'critical');
  elements.oscarRamWarning.dataset.level = warning?.level || 'none';
  const title = elements.oscarRamWarning.querySelector('[data-ram-warning-title]');
  const detail = elements.oscarRamWarning.querySelector('[data-ram-warning-message]');
  const useBalanced = elements.oscarRamWarning.querySelector('[data-oscar-ram-action="use-balanced"]');
  if (title) title.textContent = warning?.title || '';
  if (detail) detail.textContent = warning?.message || '';
  if (useBalanced) useBalanced.hidden = warning?.action !== 'use-balanced';
}

function syncHistoryToggleControls(historyOpen) {
  const topbarLabel = historyOpen ? 'Закрыть историю' : 'История';
  const sidebarLabel = historyOpen ? 'Закрыть историю чатов' : 'История чатов';
  for (const [button, label] of [
    [elements.oscarHistoryOpen, topbarLabel],
    [elements.oscarHistoryToggle, sidebarLabel],
  ]) {
    if (!button) continue;
    button.setAttribute('aria-expanded', String(historyOpen));
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

function resolveVisibleHistoryTrigger(preferred = null) {
  for (const trigger of [preferred, lastOscarHistoryTrigger, elements.oscarHistoryOpen, elements.oscarHistoryToggle]) {
    if (!trigger || typeof trigger.focus !== 'function' || !document.contains(trigger)) continue;
    const rect = trigger.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return trigger;
    }
  }
  return null;
}

function restoreHistoryTriggerFocus(preferred = null) {
  const trigger = resolveVisibleHistoryTrigger(preferred);
  if (!trigger) return;
  requestAnimationFrame(() => {
    try {
      trigger.focus({ preventScroll: true });
    } catch {
      trigger.focus();
    }
  });
}

function renderConversationList() {
  if (!elements.oscarConversationList || !elements.oscarHistoryPanel) return;
  const conversations = state.oscar.conversations || [];
  const query = String(elements.oscarHistorySearch?.value || '').trim().toLocaleLowerCase('ru');
  const visibleConversations = query
    ? conversations.filter((conversation) => `${formatConversationTitle(conversation)} ${formatConversationPreview(conversation)}`.toLocaleLowerCase('ru').includes(query))
    : conversations;
  const historyOpen = state.oscar.historyPanelOpen === true;
  const listState = resolveOscarHistoryListState({
    busy: state.oscar.historyBusy,
    error: state.oscar.historyError,
    conversationCount: conversations.length,
    visibleCount: visibleConversations.length,
    queryActive: Boolean(query),
  });
  syncHistoryPanelAnchor();
  elements.oscarHistoryPanel.hidden = !historyOpen;
  syncHistoryToggleControls(historyOpen);
  if (elements.oscarHistoryCount) {
    elements.oscarHistoryCount.textContent = listState.kind === 'unavailable'
      ? 'недоступно'
      : query
      ? `${visibleConversations.length} из ${conversations.length}`
      : formatConversationCount(conversations.length);
  }
  if (listState.kind === 'loading') {
    elements.oscarConversationList.innerHTML = '<div class="sidebar-history-empty">Загружаю…</div>';
    return;
  }
  if (listState.kind === 'unavailable') {
    elements.oscarConversationList.innerHTML = renderOscarHistoryError(listState.historyError);
    return;
  }
  if (listState.kind === 'empty') {
    elements.oscarConversationList.innerHTML = '<div class="sidebar-history-empty">История пока пуста</div>';
    return;
  }
  const historyError = listState.historyError ? renderOscarHistoryError(listState.historyError) : '';
  if (listState.kind === 'no-results') {
    elements.oscarConversationList.innerHTML = `${historyError}<div class="sidebar-history-empty">Совпадений нет</div>`;
    return;
  }
  elements.oscarConversationList.innerHTML = historyError + visibleConversations.map((conversation) => {
    const active = conversation.id === state.oscar.conversationId;
    const encrypted = conversation.encrypted === true;
    const title = formatConversationTitle(conversation);
    const preview = formatConversationPreview(conversation);
    return `
      <div class="conversation-item ${active ? 'active' : ''} ${encrypted ? 'is-encrypted' : ''}" data-conversation-open="${escapeHtml(conversation.id)}">
        <button type="button" class="conversation-main" data-conversation-open="${escapeHtml(conversation.id)}" title="${escapeHtml(`${title} - ${preview}`)}">
          <strong class="conversation-title" title="${escapeHtml(title)}">${encrypted ? '<span class="conversation-safe-mark" aria-hidden="true">◆</span>' : ''}${escapeHtml(title)}</strong>
          <span class="conversation-preview" title="${escapeHtml(preview)}">${escapeHtml(preview)}</span>
        </button>
        <div class="conversation-actions" aria-hidden="true">
          ${encrypted ? '' : `<button type="button" tabindex="-1" data-conversation-encrypt="${escapeHtml(conversation.id)}" aria-label="${escapeHtml(`Зашифровать чат в Monarch Safe: ${title}`)}" title="Зашифровать в Safe">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>
          </button>`}
          <button type="button" tabindex="-1" data-conversation-rename="${escapeHtml(conversation.id)}" aria-label="${escapeHtml(`Переименовать чат: ${title}`)}" title="Переименовать">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
            </svg>
          </button>
          <button type="button" tabindex="-1" data-conversation-delete="${escapeHtml(conversation.id)}" aria-label="${escapeHtml(`Удалить чат: ${title}`)}" title="Удалить">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 6 6 18"></path>
              <path d="M6 6l12 12"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
  syncConversationActionTabStops(
    elements.oscarConversationList.contains(document.activeElement)
      ? document.activeElement.closest('.conversation-item')
      : null
  );
}

function renderOscarHistoryError(message) {
  return `
    <div class="sidebar-history-error" role="status">
      <span>История временно недоступна.</span>
      <small>${escapeHtml(message)}</small>
      <button type="button" data-oscar-history-retry>Повторить</button>
    </div>
  `;
}

function syncConversationActionTabStops(activeItem = null) {
  if (!elements.oscarConversationList) return;
  elements.oscarConversationList.querySelectorAll('.conversation-item').forEach((item) => {
    const isActive = item === activeItem;
    const actions = item.querySelector('.conversation-actions');
    if (actions) actions.setAttribute('aria-hidden', String(!isActive));
    item.querySelectorAll('.conversation-actions button').forEach((button) => {
      button.tabIndex = isActive ? 0 : -1;
    });
  });
}

function formatConversationTitle(conversation) {
  const title = cleanConversationSummary(conversation?.title || '', 72);
  if (title) return title;
  const preview = cleanConversationSummary(conversation?.preview || '', 72);
  return preview || 'Новый чат';
}

function formatConversationPreview(conversation) {
  const preview = cleanConversationSummary(conversation?.preview || '', 92);
  if (preview) return preview;
  const count = Number(conversation?.message_count ?? conversation?.messageCount ?? 0);
  return count > 0 ? formatConversationCount(count) : 'Без сообщений';
}

function cleanConversationSummary(value, limit = 96) {
  const normalized = sanitizeVisibleAssistantContent(value)
    .replace(/```[\s\S]*?```/g, ' фрагмент кода ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\{\s*["'][\w.-]+["']\s*:[\s\S]*?(?:\}|$)/g, ' ')
    .replace(/\bTop candidate is missing required input:\s*[^.?!]*(?:[.?!]|$)/gi, 'Нужно уточнение. ')
    .replace(/\bTODO:\s*[^.?!]*(?:[.?!]|$)/gi, ' ')
    .replace(/\bCreated directory\s+[A-Za-z]:\\[^\s]+/gi, 'Папка создана')
    .replace(/\bListed\s+(\d+)\s+workspace entries\.?/gi, '$1 элементов')
    .replace(/\bMonarch Workspace\b/g, 'Workspace')
    .replace(/[A-Za-z]:\\[^\s]+/g, 'локальный путь')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*~]{1,3}/g, '')
    .replace(/_{2,}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b(0 элементов)(?:\s+\1)+/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  const chars = Array.from(normalized);
  return chars.length > limit ? `${chars.slice(0, limit - 3).join('').trimEnd()}...` : normalized;
}

function setOscarHistoryOpen(open, options = {}) {
  const wasOpen = state.oscar.historyPanelOpen === true;
  const nextOpen = Boolean(open);
  if (nextOpen && options.trigger) {
    lastOscarHistoryTrigger = options.trigger;
  }
  state.oscar.historyPanelOpen = nextOpen;
  renderConversationList();
  if (state.oscar.historyPanelOpen) {
    void loadOscarConversations();
  } else if (wasOpen && options.restoreFocus) {
    restoreHistoryTriggerFocus(options.trigger);
  }
}

function syncHistoryPanelAnchor() {
  if (!elements.oscarHistoryPanel) return;
  const trigger = resolveVisibleHistoryTrigger(lastOscarHistoryTrigger);
  const anchor = trigger?.id === 'oscar-history-open' ? 'topbar' : 'sidebar';
  elements.oscarHistoryPanel.dataset.anchor = anchor;
}

function formatConversationCount(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} чат`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} чата`;
  return `${count} чатов`;
}

function renderMemoryPanel() {
  if (!elements.oscarMemoryPanel || !elements.oscarMemoryItems) return;
  if (state.oscar.incognito || state.oscar.encrypted) state.oscar.memoryPanelOpen = false;
  const memoryOpen = state.oscar.memoryPanelOpen === true;
  elements.oscarMemoryPanel.hidden = !memoryOpen;
  syncMemoryToggleControls(memoryOpen);
  if (!memoryOpen) return;
  const items = state.oscar.memoryItems || [];
  if (state.oscar.memoryBusy && items.length === 0) {
    elements.oscarMemoryItems.innerHTML = '<div class="empty-state">Загружаю память…</div>';
    return;
  }
  if (items.length === 0) {
    elements.oscarMemoryItems.innerHTML = '<div class="empty-state">Нет сохранённых воспоминаний. Добавь только действительно устойчивый факт или правило.</div>';
    return;
  }
  elements.oscarMemoryItems.innerHTML = items.map((item) => `
    <article class="memory-item ${item.enabled ? '' : 'disabled'}" data-memory-item="${escapeHtml(item.id)}">
      <textarea data-memory-content aria-label="Текст памяти">${escapeHtml(item.content || '')}</textarea>
      <div class="memory-item-footer">
        <select data-memory-category aria-label="Категория памяти">
          ${memoryCategoryOptions(item.type || item.category)}
        </select>
        <span>${escapeHtml(memoryTypeLabel(item.type || item.category))} · ${item.use_count ? `использовано ${item.use_count} раз` : 'ещё не использовалось'}</span>
        <button type="button" data-memory-toggle="${escapeHtml(item.id)}">${item.enabled ? 'Выключить' : 'Включить'}</button>
        <button type="button" data-memory-save="${escapeHtml(item.id)}">Сохранить</button>
        <button type="button" class="danger-link" data-memory-delete="${escapeHtml(item.id)}">Удалить</button>
      </div>
    </article>
  `).join('');
}

function syncMemoryToggleControls(memoryOpen) {
  if (state.oscar.incognito || state.oscar.encrypted) {
    state.oscar.memoryPanelOpen = false;
    memoryOpen = false;
  }
  for (const [button, label] of [
    [elements.oscarMemoryManager, memoryOpen ? 'Закрыть память' : 'Память'],
    [elements.oscarMemoryNav, memoryOpen ? 'Закрыть память Oscar' : 'Открыть память Oscar'],
  ]) {
    if (!button) continue;
    button.setAttribute('aria-expanded', String(memoryOpen));
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

function memoryCategoryOptions(selected) {
  const categories = [
    ['user_preference', 'Предпочтение'],
    ['project_decision', 'Решение'],
    ['architecture_note', 'Архитектура'],
    ['active_bug', 'Активный баг'],
    ['fixed_bug', 'Исправленный баг'],
    ['technical_debt', 'Техдолг'],
    ['temporary_task', 'Временная задача'],
    ['module_state', 'Состояние модуля'],
    ['handoff_note', 'Handoff'],
    ['diagnostic_note', 'Диагностика'],
    ['planning_note', 'Планирование'],
    ['preference', 'Предпочтение · legacy'],
    ['profile', 'О пользователе · legacy'],
    ['project', 'Проект · legacy'],
    ['instruction', 'Правило · legacy'],
    ['other', 'Другое · legacy'],
  ];
  return categories.map(([value, label]) =>
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`
  ).join('');
}

function memoryTypeLabel(value) {
  const labels = {
    user_preference: 'предпочтение',
    project_decision: 'решение',
    architecture_note: 'архитектура',
    active_bug: 'активный баг',
    fixed_bug: 'исправленный баг',
    technical_debt: 'техдолг',
    temporary_task: 'временная задача',
    module_state: 'состояние',
    handoff_note: 'handoff',
    diagnostic_note: 'диагностика',
    planning_note: 'планирование',
    preference: 'предпочтение',
    profile: 'профиль',
    project: 'проект',
    instruction: 'правило',
    other: 'другое',
  };
  return labels[value] || 'память';
}

function syncOscarButtons() {
  if (elements.oscarClear) {
    const unavailable = state.oscar.busy || oscarSubmitInFlight || oscarNewConversationInFlight;
    elements.oscarClear.disabled = unavailable;
    elements.oscarClear.title = unavailable ? 'Сначала останови текущий Turn' : 'Новый чат';
  }
  if (elements.oscarRefresh) {
    elements.oscarRefresh.disabled = state.oscar.statusBusy;
  }
  if (elements.oscarStartBackend) {
    const backend = readOscarBackend(state.oscar);
    elements.oscarStartBackend.hidden = Boolean(backend?.connected) && !state.oscar.statusBusy;
    elements.oscarStartBackend.disabled = state.oscar.statusBusy || Boolean(backend?.connected);
    elements.oscarStartBackend.textContent = state.oscar.statusBusy
      ? 'Проверяю...'
      : backend?.connected
        ? 'Backend в сети'
        : 'Запустить backend';
  }
}

function renderOscarPills() {
  if (!elements.oscarStatusPills) return;
  const backend = readOscarBackend(state.oscar);
  const modelStatus = readOscarModelStatus(state.oscar);
  if (state.oscar.statusBusy && !backend) {
    elements.oscarStatusPills.innerHTML = statusPill('проверка', 'amber', {
      ariaLabel: 'Oscar проверяется',
      title: 'Oscar проверяется',
    });
    return;
  }

  if (state.oscar.error) {
    const offline = isOscarOfflineMessage(state.oscar.error);
    elements.oscarStatusPills.innerHTML = statusPill(offline ? 'offline' : 'сбой', offline ? 'amber' : 'red', {
      ariaLabel: offline ? 'Oscar offline' : 'Oscar ошибка',
      title: offline ? 'Oscar offline' : 'Oscar ошибка',
    });
    return;
  }

  if (!backend) {
    elements.oscarStatusPills.innerHTML = statusPill('ожидание', 'amber', {
      ariaLabel: 'Oscar ожидает',
      title: 'Oscar ожидает',
    });
    return;
  }

  const backendTone = readOscarBackendTone(backend);
  const backendLabel = readOscarBackendLabel(backend);
  const backendPillLabel = readOscarBackendPillLabel(backend);
  const modelTone = modelStatus?.fallback_active || modelStatus?.mock
    ? 'amber'
    : modelStatus?.loaded
      ? 'green'
      : 'amber';
  const modelLabel = modelStatus?.fallback_active
    ? 'резервная заглушка'
    : modelStatus?.mock
      ? 'заглушка'
      : modelStatus?.loaded
        ? modelStatus?.device_map?.backend === 'cuda' ? 'GPU-модель загружена' : 'модель загружена'
        : 'модель в ожидании';
  const modelPillLabel = readOscarModelPillLabel(modelStatus);

  const activeSkillNames = (state.oscar.activeSkills || []).map((skill) => skill.name).filter(Boolean);
  elements.oscarStatusPills.innerHTML = [
    statusPill(backendPillLabel, backendTone, { ariaLabel: backendLabel, title: backendLabel }),
    statusPill(modelPillLabel, modelTone, { ariaLabel: modelLabel, title: modelLabel }),
    ...(state.oscar.context?.request?.web_search ? [statusPill('поиск', 'amber', {
      ariaLabel: 'поиск использован',
      title: 'поиск использован',
    })] : []),
    ...(activeSkillNames.length ? [statusPill('навык', 'amber', {
      ariaLabel: `навык: ${activeSkillNames.join(', ')}`,
      title: `навык: ${activeSkillNames.join(', ')}`,
    })] : []),
  ].join('');
}

function renderOscarBackend() {
  if (!elements.oscarBackendLabel || !elements.oscarBackend) return;
  const backend = readOscarBackend(state.oscar);
  const modelStatus = readOscarModelStatus(state.oscar);

  if (state.oscar.statusBusy && !backend) {
    elements.oscarBackendLabel.textContent = 'проверка';
    elements.oscarBackendLabel.className = 'status-text pending';
    elements.oscarBackend.innerHTML = '<div class="empty-state">Проверяю локальный backend Oscar...</div>';
    return;
  }

  if (!backend) {
    elements.oscarBackendLabel.textContent = state.oscar.error ? 'сбой' : 'ожидание';
    elements.oscarBackendLabel.className = `status-text ${state.oscar.error ? 'failed' : 'pending'}`;
    elements.oscarBackend.innerHTML = state.oscar.error
      ? renderError(state.oscar.error)
      : '<div class="empty-state">Статус Oscar ещё не загружен.</div>';
    return;
  }

  const backendTone = readOscarBackendTone(backend);
  elements.oscarBackendLabel.textContent = readOscarBackendLabel(backend);
  elements.oscarBackendLabel.className = `status-text ${backendTone === 'green' ? 'active' : backendTone === 'red' ? 'failed' : 'pending'}`;
  if (elements.oscarDiagnosticsState) {
    elements.oscarDiagnosticsState.textContent = backend.connected ? 'готов' : 'недоступен';
  }
  elements.oscarBackend.innerHTML = `
    <div class="key-value-list">
      ${keyValueRow('API', backend.apiBase || 'неизвестно')}
      ${keyValueRow('Проект', backend.projectRoot || 'неизвестно')}
      ${keyValueRow('Запуск', backend.connected ? 'активен' : backend.startupAttempted ? 'проверен' : 'не запускался')}
      ${keyValueRow('Режим', readOscarModeLabel(state.oscar, modelStatus))}
      ${modelStatus?.load_strategy ? keyValueRow('Загрузка', modelStatus.load_strategy) : ''}
      ${modelStatus ? keyValueRow(
        'GPU',
        modelStatus.gpu_offload_available
          ? modelStatus.device_map?.gpu_layers
            ? `CUDA · ${modelStatus.device_map.gpu_layers}/${modelStatus.device_map.gpu_layers_requested || modelStatus.device_map.gpu_layers} слоёв`
            : 'CUDA offload готов'
          : 'недоступен',
      ) : ''}
      ${keyValueRow('Память', readOscarMemoryLabel(backend.memoryStats))}
      ${backend.error ? keyValueRow('Ошибка', backend.error) : ''}
    </div>
  `;
}

function readOscarBackendTone(backend) {
  if (backend?.connected) {
    return 'green';
  }
  return backend?.startupAttempted ? 'red' : 'amber';
}

function readOscarBackendLabel(backend) {
  if (backend?.connected) {
    return 'бэкенд в сети';
  }
  if (backend?.startupAttempted) {
    return 'запуск не удался';
  }
  return 'готов к запуску';
}

function readOscarBackendPillLabel(backend) {
  if (backend?.connected) {
    return 'API';
  }
  if (backend?.startupAttempted) {
    return 'сбой';
  }
  return 'старт';
}

function readOscarModelPillLabel(modelStatus) {
  if (modelStatus?.fallback_active) {
    return 'резерв';
  }
  if (modelStatus?.mock) {
    return 'заглушка';
  }
  if (modelStatus?.loaded) {
    return modelStatus?.device_map?.backend === 'cuda' ? 'GPU' : 'модель';
  }
  return 'модель ждёт';
}

function renderOscarContext() {
  if (!elements.oscarContextLabel || !elements.oscarContext) return;
  const context = state.oscar.context;
  if (!context) {
    elements.oscarContextLabel.textContent = 'ожидание';
    elements.oscarContextLabel.className = 'status-text pending';
    elements.oscarContext.innerHTML = '<div class="empty-state">Контекст появится после ответа Oscar.</div>';
    return;
  }

  const sources = Array.isArray(context.sources) ? context.sources : [];
  elements.oscarContextLabel.textContent = sources.length ? `${sources.length} источн.` : 'готово';
  elements.oscarContextLabel.className = 'status-text active';
  elements.oscarContext.innerHTML = `
    <div class="key-value-list">
      ${keyValueRow('Сводка', context.summary || 'готово')}
      ${keyValueRow('Рассуждение', context.request?.reasoning_effort || state.oscar.reasoning)}
      ${keyValueRow('Память', context.request?.use_memory ? 'вкл' : 'выкл')}
      ${keyValueRow('Сеть', context.request?.web_search ? 'вкл' : 'выкл')}
      ${keyValueRow('Навыки', Array.isArray(context.skills) && context.skills.length ? context.skills.map((skill) => skill.name).join(', ') : 'не активированы')}
    </div>
    ${sources.length ? `
      <div class="source-list">
        ${sources.slice(0, 5).map(renderOscarSource).join('')}
      </div>
    ` : ''}
  `;
}

async function setSkillPickerOpen(open, options = {}) {
  const nextOpen = Boolean(open) && !state.oscar.busy;
  state.oscar.skillPickerOpen = nextOpen;
  if (nextOpen) {
    setFunctionPickerOpen(false);
    document.querySelector('#oscar-composer-menu')?.removeAttribute('open');
  }
  document.querySelector('.app-shell')?.classList.toggle('skill-picker-open', nextOpen);
  elements.oscarComposer?.classList.toggle('skill-picker-open', nextOpen);
  elements.oscarSkillPicker?.classList.toggle('hidden', !nextOpen);
  elements.oscarSkillPickerToggle?.setAttribute('aria-expanded', String(nextOpen));
  if (!nextOpen) {
    if (elements.oscarSkillPickerSearch) elements.oscarSkillPickerSearch.value = '';
    return;
  }
  if (typeof options.query === 'string' && elements.oscarSkillPickerSearch) {
    elements.oscarSkillPickerSearch.value = options.query;
  }
  await loadSkillPickerSkills();
  if (!state.oscar.skillPickerOpen) return;
  renderSkillPicker();
  if (options.focusSearch) elements.oscarSkillPickerSearch?.focus();
}

async function loadSkillPickerSkills() {
  if (state.oscar.skillPickerSkills.length || skillPickerLoadPromise) {
    await skillPickerLoadPromise;
    return;
  }
  state.oscar.skillPickerBusy = true;
  renderSkillPicker();
  skillPickerLoadPromise = fetchSkills(false)
    .then((skills) => {
      state.oscar.skillPickerSkills = Array.isArray(skills) ? skills : [];
    })
    .catch(() => {
      state.oscar.skillPickerSkills = [];
    })
    .finally(() => {
      state.oscar.skillPickerBusy = false;
      skillPickerLoadPromise = null;
    });
  await skillPickerLoadPromise;
}

function renderSkillPicker() {
  if (!elements.oscarSkillPickerResults) return;
  if (state.oscar.skillPickerBusy) {
    elements.oscarSkillPickerResults.innerHTML = '<div class="oscar-skill-picker-empty" role="status">Ищу доступные навыки…</div>';
    return;
  }
  const query = elements.oscarSkillPickerSearch?.value || '';
  const skills = filterSkillPickerSkills(state.oscar.skillPickerSkills, query, 8);
  if (!skills.length) {
    elements.oscarSkillPickerResults.innerHTML = `
      <div class="oscar-skill-picker-empty">${query.trim()
        ? 'Ничего не найдено. Попробуй другое слово.'
        : 'Твоих навыков пока нет. Найди системный навык через поиск.'}</div>
    `;
    return;
  }
  elements.oscarSkillPickerResults.innerHTML = skills.map((skill) => `
    <button type="button" class="oscar-skill-picker-item" role="option" data-skill-pick="${escapeHtml(skill.name || '')}">
      <strong>${escapeHtml(skillUserFacingName(skill))}</strong>
      <small>${escapeHtml(skillUserFacingDescription(skill))}</small>
      <span>${escapeHtml(skill.scope === 'project' ? 'проект' : skill.scope === 'user' ? 'твой' : 'системный')}</span>
    </button>
  `).join('');
}

function syncSkillPickerFromComposer() {
  const match = String(elements.oscarInput?.value || '').match(/(?:^|\s)\$([a-z0-9-]*)$/i);
  if (!match) return;
  void setSkillPickerOpen(true, { query: match[1] || '', focusSearch: false });
}

function syncFunctionPickerFromComposer() {
  const query = readOscarFunctionQuery(elements.oscarInput?.value || '');
  if (query === null) {
    if (functionPickerOpen) setFunctionPickerOpen(false);
    return;
  }
  setFunctionPickerOpen(true, query);
}

function setFunctionPickerOpen(open, query = '') {
  const nextOpen = Boolean(open) && !state.oscar.busy;
  functionPickerOpen = nextOpen;
  elements.oscarFunctionPicker?.classList.toggle('hidden', !nextOpen);
  elements.oscarComposer?.classList.toggle('function-picker-open', nextOpen);
  if (!nextOpen) return;
  void setSkillPickerOpen(false);
  document.querySelector('#oscar-composer-menu')?.removeAttribute('open');
  renderFunctionPicker(query);
}

function renderFunctionPicker(query = '') {
  if (!elements.oscarFunctionPickerResults) return;
  const matches = listOscarFunctions(query);
  elements.oscarFunctionPickerResults.innerHTML = matches.length
    ? matches.map((entry) => `
      <button type="button" class="oscar-function-picker-item" role="option" data-oscar-function="${escapeHtml(entry.id)}">
        <img src="/assets/icons/phosphor/magic-wand.svg" alt="">
        <strong>${escapeHtml(entry.name)}</strong>
        <small>${escapeHtml(entry.description)}</small>
        <span>${escapeHtml(entry.invocation)}</span>
      </button>
    `).join('')
    : '<div class="oscar-skill-picker-empty">Функция не найдена.</div>';
}

function selectOscarFunction(id, options = {}) {
  const entry = listOscarFunctions().find((candidate) => candidate.id === id);
  if (!entry || !elements.oscarInput) return;
  state.oscar.selectedSkill = null;
  renderSelectedSkill();
  elements.oscarInput.value = insertOscarFunctionInvocation(elements.oscarInput.value, entry.invocation);
  elements.oscarInput.dispatchEvent(new Event('input', { bubbles: true }));
  setFunctionPickerOpen(false);
  elements.oscarInput.focus();
  if (options.start === false || id !== 'computer-use') return;
  void ensureComputerUseReady('ui:oscar-function-picker').catch((error) => {
    state.oscar.error = formatOscarStatusError(error);
    renderApp();
  });
}

function selectComposerSkill(skill) {
  const name = String(skill?.name || '').trim();
  if (!name) return;
  state.oscar.selectedSkill = {
    ...skill,
    name,
    displayName: skillUserFacingName(skill),
    description: skillUserFacingDescription(skill),
  };
  if (elements.oscarInput) {
    elements.oscarInput.value = elements.oscarInput.value
      .replace(/(^|\s)\$[a-z0-9-]*(?=\s|$)/i, '$1')
      .replace(/^\s+/, '');
    syncOscarInputHeight();
    syncOscarComposerState();
    elements.oscarInput.focus();
  }
  state.oscar.skillMatches = [];
  renderSkillRadar();
  renderSelectedSkill();
  setSkillPickerOpen(false);
}

function clearSelectedSkill() {
  state.oscar.selectedSkill = null;
  renderSelectedSkill();
  elements.oscarInput?.focus();
}

function renderSelectedSkill() {
  if (!elements.oscarSelectedSkill || !elements.oscarSelectedSkillName) return;
  const selected = state.oscar.selectedSkill;
  elements.oscarSelectedSkill.classList.toggle('hidden', !selected);
  elements.oscarSelectedSkillName.textContent = selected ? skillUserFacingName(selected) : '';
  elements.oscarSkillPickerToggle?.classList.toggle('is-active', Boolean(selected));
  elements.oscarSkillPickerToggle?.setAttribute('aria-pressed', String(Boolean(selected)));
  if (elements.oscarSkillMenuState) elements.oscarSkillMenuState.textContent = selected ? 'Выбран' : 'Выбрать';
}

function scheduleSkillRadar(immediate = false) {
  if (skillRadarTimer) clearTimeout(skillRadarTimer);
  const query = elements.oscarInput?.value.trim() || '';
  if (query.length < 3 || state.oscar.busy || state.oscar.selectedSkill || state.oscar.skillPickerOpen || functionPickerOpen) {
    state.oscar.skillMatches = [];
    state.oscar.skillRadarBusy = false;
    renderSkillRadar();
    return;
  }
  skillRadarTimer = setTimeout(() => {
    void updateSkillRadar(query);
  }, immediate ? 0 : 180);
}

async function updateSkillRadar(query) {
  const requestId = ++skillRadarRequest;
  state.oscar.skillRadarBusy = true;
  try {
    const matches = await fetchSkillMatches(query, 3);
    if (requestId !== skillRadarRequest || query !== elements.oscarInput?.value.trim()) return;
    state.oscar.skillMatches = matches.filter((match) => match.explicit || match.score >= 0.55);
  } catch {
    if (requestId === skillRadarRequest) state.oscar.skillMatches = [];
  } finally {
    if (requestId === skillRadarRequest) {
      state.oscar.skillRadarBusy = false;
      renderSkillRadar();
    }
  }
}

function renderSkillRadar() {
  if (!elements.oscarSkillRadar) return;
  const matches = state.oscar.skillMatches || [];
  if (matches.length === 0 || state.oscar.busy || state.oscar.selectedSkill || state.oscar.skillPickerOpen || functionPickerOpen) {
    elements.oscarSkillRadar.classList.add('hidden');
    elements.oscarSkillRadar.innerHTML = '';
    return;
  }
  elements.oscarSkillRadar.classList.remove('hidden');
  elements.oscarSkillRadar.innerHTML = `
    <div class="skill-radar-heading">
      <span class="skill-radar-orbit" aria-hidden="true"></span>
      <strong>Подходящие навыки</strong>
    </div>
    ${matches.length ? `<div class="skill-radar-results">
      ${matches.map((match) => {
        const compatible = match.skill?.compatible !== false;
        const skillName = formatSkillRadarName(match.skill);
        const metaLabel = compatible ? 'Выбрать' : 'недоступен';
        const scoreLabel = compatible ? `${Math.round((match.score || 0) * 100)}% совпадение` : 'не для Windows';
        const details = [skillName, scoreLabel, match.reason].filter(Boolean).join(' - ');
        return `
        <button type="button" class="skill-radar-item" ${compatible ? `data-skill-invoke="${escapeHtml(match.skill?.name || '')}"` : 'disabled aria-disabled="true"'} aria-label="${escapeHtml(details)}" title="${escapeHtml(details)}">
          <span class="skill-radar-name">${escapeHtml(skillName)}</span>
          <span class="skill-radar-meta">${escapeHtml(metaLabel)}</span>
        </button>
      `; }).join('')}
    </div>` : ''}
  `;
}

function formatSkillRadarName(skill) {
  return skillUserFacingName(skill);
}

async function addOscarImageAttachments(fileList) {
  const files = Array.from(fileList || []);
  const remaining = Math.max(0, MAX_OSCAR_ATTACHMENTS - state.oscar.attachments.length);
  if (files.length > remaining) {
    state.oscar.error = `Можно прикрепить не больше ${MAX_OSCAR_ATTACHMENTS} изображений.`;
  }

  const acceptedFiles = files.slice(0, remaining);
  oscarAttachmentReads += acceptedFiles.length;
  elements.oscarComposer?.classList.toggle('is-attaching', oscarAttachmentReads > 0);
  renderOscarAttachments();

  try {
    for (const file of acceptedFiles) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        state.oscar.error = `Формат ${file.name} не поддерживается.`;
        oscarAttachmentReads = Math.max(0, oscarAttachmentReads - 1);
        renderOscarAttachments();
        continue;
      }
      if (file.size > MAX_OSCAR_ATTACHMENT_BYTES) {
        state.oscar.error = `${file.name} больше 8 МБ.`;
        oscarAttachmentReads = Math.max(0, oscarAttachmentReads - 1);
        renderOscarAttachments();
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        state.oscar.attachments.push({
          name: file.name,
          mime_type: file.type,
          size_bytes: file.size,
          data_base64: dataUrl.split(',', 2)[1] || '',
          preview_url: dataUrl,
        });
      } catch {
        state.oscar.error = `Не удалось прочитать ${file.name}.`;
      } finally {
        oscarAttachmentReads = Math.max(0, oscarAttachmentReads - 1);
        renderOscarAttachments();
      }
    }
  } finally {
    oscarAttachmentReads = 0;
    elements.oscarComposer?.classList.remove('is-attaching');
  }
  if (elements.oscarImageUpload) elements.oscarImageUpload.value = '';
  renderOscarAttachments();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(`Не удалось прочитать ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function toOscarAttachmentPayload(attachment) {
  return {
    name: attachment.name,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
    data_base64: attachment.data_base64,
  };
}

function renderOscarAttachments() {
  if (!elements.oscarAttachmentsPreview) return;
  const attachments = state.oscar.attachments || [];
  const loading = oscarAttachmentReads > 0
    ? `<span class="attachment-preview-item attachment-loading" role="status">Читаю ${oscarAttachmentReads === 1 ? 'изображение' : `${oscarAttachmentReads} изображения`}</span>`
    : '';
  elements.oscarAttachmentsPreview.innerHTML = attachments.map((attachment, index) => `
    <span class="attachment-preview-item">
      <img src="${escapeHtml(attachment.preview_url)}" alt="">
      <span title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</span>
      <button
        type="button"
        class="attachment-preview-remove"
        data-attachment-remove="${index}"
        aria-label="Убрать ${escapeHtml(attachment.name)}"
        title="Убрать изображение"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 6 6 18"></path>
          <path d="M6 6l12 12"></path>
        </svg>
      </button>
    </span>
  `).join('') + loading;
  elements.oscarAttachmentsPreview.classList.toggle('hidden', attachments.length === 0 && oscarAttachmentReads === 0);
  syncOscarComposerState();
}

function syncOscarComposerState() {
  if (!elements.oscarComposer) return;
  const hasPayload = Boolean(elements.oscarInput?.value.trim() || (state.oscar.attachments || []).length);
  const primaryAction = resolveOscarComposerPrimaryAction({ busy: state.oscar.busy, hasPayload });
  const modelBlocked = requiredModelBlocksChat();
  elements.oscarComposer.classList.toggle('has-draft', hasPayload);
  elements.oscarComposer.classList.toggle('is-empty-draft', !hasPayload);
  elements.oscarComposer.dataset.primaryAction = primaryAction;
  elements.oscarThread?.classList.toggle('has-draft', hasPayload);
  if (elements.oscarSend) {
    elements.oscarSend.hidden = primaryAction !== 'send';
    elements.oscarSend.disabled = primaryAction !== 'send' || modelBlocked;
    elements.oscarSend.setAttribute('aria-disabled', String(elements.oscarSend.disabled));
    elements.oscarSend.title = modelBlocked
      ? 'Monarch устанавливает и проверяет обязательную модель'
      : primaryAction === 'send' ? 'Отправить' : 'Введите сообщение';
  }
  if (elements.oscarVoiceMode) {
    elements.oscarVoiceMode.hidden = primaryAction !== 'voice';
    elements.oscarVoiceMode.disabled = primaryAction !== 'voice' || modelBlocked;
    elements.oscarVoiceMode.setAttribute('aria-disabled', String(elements.oscarVoiceMode.disabled));
  }
  if (elements.oscarStop) {
    elements.oscarStop.hidden = primaryAction !== 'stop';
    elements.oscarStop.disabled = state.oscar.stopRequested;
    elements.oscarStop.title = state.oscar.stopRequested ? 'Останавливаю генерацию...' : 'Остановить генерацию';
  }
}

function syncOscarInputHeight() {
  if (!elements.oscarInput) return;
  elements.oscarInput.style.height = 'auto';
  const minHeight = 38;
  const maxHeight = 96;
  const nextHeight = Math.max(minHeight, Math.min(elements.oscarInput.scrollHeight, maxHeight));
  elements.oscarInput.style.height = `${nextHeight}px`;
  elements.oscarInput.style.overflowY = elements.oscarInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function imageFilesFromTransfer(transfer) {
  if (!transfer) return [];
  const directFiles = Array.from(transfer.files || []);
  const itemFiles = Array.from(transfer.items || [])
    .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const files = directFiles.length ? directFiles : itemFiles;
  return files.filter((file) => String(file.type || '').startsWith('image/'));
}

function requestOscarRouteConsent({
  pro = false,
  webSearch = false,
  deepResearch = false,
  messageId = '',
  presentation = {},
  signal,
} = {}) {
  return new Promise((resolve) => {
    if (activeOscarRouteConsent) {
      settleOscarRouteConsent('deny', { immediate: true });
    }
    if (signal?.aborted) {
      resolve('deny');
      return;
    }
    const researchRequested = webSearch && deepResearch;
    const title = pro && researchRequested
      ? 'Нужны Pro и интернет-исследование'
      : pro && webSearch
        ? 'Нужны Pro и интернет-поиск'
      : pro
        ? 'Для этого запроса выбран Pro'
        : researchRequested
          ? 'Нужно интернет-исследование'
          : 'Нужен интернет-поиск';
    const description = pro && researchRequested
      ? 'Oscar будет дольше искать, проверять пробелы и пересобирать вывод. Разрешить для одного ответа?'
      : pro
        ? webSearch
          ? 'Oscar использует Pro и публичные источники. Разрешить для одного ответа?'
          : 'Pro работает глубже, но заметно дольше. Разрешить его для одного ответа?'
        : researchRequested
          ? 'Oscar изучит публичные источники и проверит вывод в несколько проходов. Разрешить для одного ответа?'
          : 'Oscar проверит актуальные данные в публичных источниках. Разрешить для одного ответа?';
    const denyLabel = researchRequested
      ? 'Ответить без исследования'
      : webSearch ? 'Ответить без интернета' : 'Остаться на Medium';
    const allowLabel = researchRequested
      ? 'Начать исследование'
      : webSearch ? 'Искать в интернете' : 'Разрешить Pro';
    const onKeyDown = (event) => {
      if (event.key === 'Escape') settleOscarRouteConsent('deny');
    };
    const onAbort = () => settleOscarRouteConsent('deny', { immediate: true });
    const pending = state.oscar.messages.find((message) => message.id === messageId && message.pending);
    const compactSurface = findOscarMessageSurface(messageId);
    const fromRect = compactSurface?.getBoundingClientRect?.() || null;
    if (!pending) {
      resolve('deny');
      return;
    }
    pending.routeConsent = {
      pro,
      webSearch,
      deepResearch: researchRequested,
      title,
      description,
      denyLabel,
      allowLabel,
      target: String(presentation.target || ''),
      dataClasses: Array.isArray(presentation.dataClasses) ? presentation.dataClasses.map(String) : [],
      expiresAt: String(presentation.expiresAt || ''),
      canonicalBindingHash: String(presentation.canonicalBindingHash || ''),
      state: 'waiting',
    };
    pending.researchFlow = researchRequested;
    pending.streamPhase = researchRequested ? 'research-consent' : 'route-consent';
    activeOscarRouteConsent = {
      messageId,
      pro,
      webSearch,
      deepResearch: researchRequested,
      resolve,
      onKeyDown,
      signal,
      onAbort,
      settled: false,
    };
    document.addEventListener('keydown', onKeyDown);
    signal?.addEventListener('abort', onAbort, { once: true });
    renderOscarStreamFrame();
    animateOscarConsentExpansion(messageId, fromRect);
    requestAnimationFrame(() => {
      findOscarMessageNode(messageId)?.querySelector('[data-oscar-route-decision="allow"]')?.focus();
    });
  });
}

function settleOscarRouteConsent(decision, options = {}) {
  const active = activeOscarRouteConsent;
  if (!active || active.settled) return;
  active.settled = true;
  document.removeEventListener('keydown', active.onKeyDown);
  active.signal?.removeEventListener('abort', active.onAbort);
  const normalizedDecision = decision === 'allow' ? 'allow' : 'deny';
  const pending = state.oscar.messages.find((message) => message.id === active.messageId && message.pending);
  if (pending?.routeConsent) {
    pending.routeConsent = {
      ...pending.routeConsent,
      state: normalizedDecision === 'allow' ? 'accepted' : 'denied',
    };
    pending.researchFlow = normalizedDecision === 'allow' && active.deepResearch;
    renderOscarStreamFrame();
  }

  const finish = () => {
    if (pending) {
      pending.routeConsent = null;
      pending.streamPhase = normalizedDecision === 'allow' && active.deepResearch ? 'research-plan' : 'route';
      pending.researchFlow = normalizedDecision === 'allow' && active.deepResearch;
      renderOscarStreamFrame();
    }
    activeOscarRouteConsent = null;
    active.resolve(normalizedDecision);
  };
  if (options.immediate === true) {
    finish();
  } else {
    window.setTimeout(finish, 260);
  }
}

function findOscarMessageNode(messageId) {
  if (!elements.oscarThread || !messageId) return null;
  return Array.from(elements.oscarThread.querySelectorAll('[data-message-id]'))
    .find((node) => node.getAttribute('data-message-id') === messageId) || null;
}

function findOscarMessageSurface(messageId) {
  const messageNode = findOscarMessageNode(messageId);
  return messageNode?.querySelector('.oscar-message-card, .oscar-thinking-only') || messageNode;
}

function animateOscarConsentExpansion(messageId, fromRect) {
  requestAnimationFrame(() => {
    const card = findOscarMessageNode(messageId)?.querySelector('.oscar-message-card');
    if (
      !card
      || !fromRect
      || typeof card.animate !== 'function'
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) return;
    const toRect = card.getBoundingClientRect();
    if (!toRect.width || !toRect.height) return;
    const translateX = fromRect.left - toRect.left;
    const translateY = fromRect.top - toRect.top;
    const scaleX = Math.max(0.52, Math.min(1, fromRect.width / toRect.width));
    const scaleY = Math.max(0.48, Math.min(1, fromRect.height / toRect.height));
    card.animate([
      {
        opacity: 0.76,
        transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
        filter: 'blur(1.5px)',
      },
      { opacity: 1, transform: 'none', filter: 'none' },
    ], {
      duration: 520,
      easing: 'cubic-bezier(.16, 1, .3, 1)',
      fill: 'both',
    });
  });
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderOscarSource(source) {
  if (typeof source === 'string') {
    return `<span class="source-chip">${escapeHtml(source)}</span>`;
  }
  const title = source?.title || source?.url || source?.source || 'source';
  const memory = source?.kind === 'memory' || String(source?.url || '').startsWith('memory://');
  const detail = source?.detail || source?.url || source?.snippet || source?.path || '';
  return `
    <span class="source-chip ${memory ? 'is-memory' : ''}" title="${escapeHtml(detail)}">
      ${escapeHtml(memory ? 'Из памяти' : title)}
    </span>
  `;
}

function requiredModelBlocksChat() {
  const components = state.data?.components;
  return components?.autoRepairEnabled === true && components.ready !== true;
}
