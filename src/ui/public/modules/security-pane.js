import { state } from './state.js';
import { executeConfirmedCapability, executeCapability } from './api.js';
import {
  escapeHtml,
  renderError,
  readNumber,
  metricCard,
  statusPill,
  keyValueRow
} from './utils.js';

let benchmarkPollTimer = null;
let benchmarkStatusInFlight = false;

const elements = {
  securityProtectionTitle: document.querySelector('#security-protection-title'),
  securityProtectionCopy: document.querySelector('#security-protection-copy'),
  securityStatusPills: document.querySelector('#security-status-pills'),
  securityRefresh: document.querySelector('#security-refresh'),
  securityScanSystem: document.querySelector('#security-scan-system'),
  securityIntegrity: document.querySelector('#security-integrity'),
  securityAudit: document.querySelector('#security-audit'),
  securityBaseline: document.querySelector('#security-baseline'),
  securityBaselinePreview: document.querySelector('#security-baseline-preview'),
  securityReplay: document.querySelector('#security-replay'),
  securityReplayMetrics: document.querySelector('#security-replay-metrics'),
  securityBenchmarkStart: document.querySelector('#security-benchmark-start'),
  securityBenchmarkCancel: document.querySelector('#security-benchmark-cancel'),
  securityBenchmarkStatus: document.querySelector('#security-benchmark-status'),
  securityStart: document.querySelector('#security-start'),
  securityStop: document.querySelector('#security-stop'),
  securitySummary: document.querySelector('#security-summary'),
  securityFindings: document.querySelector('#security-findings'),
  securityRuntimeLabel: document.querySelector('#security-runtime-label'),
  securityRuntime: document.querySelector('#security-runtime'),
  securityAuditLabel: document.querySelector('#security-audit-label'),
  securityAuditOutput: document.querySelector('#security-audit-output'),
  securityTabs: typeof document.querySelectorAll === 'function'
    ? Array.from(document.querySelectorAll('[data-security-tab]'))
    : [],
  securityPanels: {
    overview: document.querySelector('#security-overview-panel'),
    incidents: document.querySelector('#security-incidents-panel'),
    network: document.querySelector('#security-network-panel'),
    quarantine: document.querySelector('#security-quarantine-panel'),
    settings: document.querySelector('#security-settings-panel'),
  },
  securityFileDrop: document.querySelector('#security-file-drop'),
  securityFileChoose: document.querySelector('#security-file-choose'),
  securityScanFeedback: document.querySelector('#security-scan-feedback'),
  securityRecentScans: document.querySelector('#security-recent-scans'),
  securityRecentCount: document.querySelector('#security-recent-count'),
  securityOpenIncidents: document.querySelector('#security-open-incidents'),
  securityIncidentSummaryCopy: document.querySelector('#security-incident-summary-copy'),
  securityIncidentSummaryCount: document.querySelector('#security-incident-summary-count'),
  securityIncidentTabCount: document.querySelector('#security-incident-tab-count'),
  securityIncidentList: document.querySelector('#security-incident-list'),
  securityIncidentDetail: document.querySelector('#security-incident-detail'),
  securityIncidentsRefresh: document.querySelector('#security-incidents-refresh'),
  securityScanNetwork: document.querySelector('#security-scan-network'),
  securityNetworkResult: document.querySelector('#security-network-result'),
  securityNetworkMetrics: document.querySelector('#security-network-metrics'),
  securityNetworkProfiles: document.querySelector('#security-network-profiles'),
  securityNetworkConnections: document.querySelector('#security-network-connections'),
  securityNetworkListeners: document.querySelector('#security-network-listeners'),
  securityNetworkHistory: document.querySelector('#security-network-history'),
  securityResponseService: document.querySelector('#security-response-service'),
  securityResponseActions: document.querySelector('#security-response-actions'),
  securityQuarantineList: document.querySelector('#security-quarantine-list'),
  securityQuarantineRefresh: document.querySelector('#security-quarantine-refresh'),
  securityPinStatus: document.querySelector('#security-pin-status'),
  securityPinCurrentWrap: document.querySelector('#security-pin-current-wrap'),
  securityPinCurrent: document.querySelector('#security-pin-current'),
  securityPinNew: document.querySelector('#security-pin-new'),
  securityPinConfirm: document.querySelector('#security-pin-confirm'),
  securityPinSave: document.querySelector('#security-pin-save'),
  securityPinFeedback: document.querySelector('#security-pin-feedback'),
  securityPinRecoveryCode: document.querySelector('#security-pin-recovery-code'),
  securityPinRecover: document.querySelector('#security-pin-recover'),
  securityPinRecoveryCodes: document.querySelector('#security-pin-recovery-codes'),
  securityPinRecoveryClear: document.querySelector('#security-pin-recovery-clear'),
  securityEmergencyPanel: document.querySelector('#security-emergency-panel'),
  securityEmergencyTitle: document.querySelector('#security-emergency-title'),
  securityEmergencyCopy: document.querySelector('#security-emergency-copy'),
  securityEmergencyPin: document.querySelector('#security-emergency-pin'),
  securityEmergencyRelease: document.querySelector('#security-emergency-release'),
  securityEmergencyContinue: document.querySelector('#security-emergency-continue'),
  securityEmergencyFeedback: document.querySelector('#security-emergency-feedback'),
  securityLevel: document.querySelector('#security-level'),
  securityLevelChoices: typeof document.querySelectorAll === 'function'
    ? Array.from(document.querySelectorAll('[data-security-level-choice]'))
    : [],
  securitySettingsStatus: document.querySelector('#security-settings-status'),
  securityModelCommandsEnabled: document.querySelector('#security-model-commands-enabled'),
  securityModelConfirmation: document.querySelector('#security-model-confirmation'),
  securityModelPolicySave: document.querySelector('#security-model-policy-save'),
  securityModelPolicyFeedback: document.querySelector('#security-model-policy-feedback'),
};

export function initSecurityPane(appRenderCallback) {
  for (const tab of elements.securityTabs) {
    tab.addEventListener('click', () => {
      setSecurityTab(tab.dataset.securityTab || 'overview');
      renderSecurity();
      resetSecurityViewport(tab);
      if (tab.dataset.securityTab === 'quarantine') {
        void loadSecurityQuarantine(appRenderCallback);
        void loadSecurityPinStatus(appRenderCallback);
      }
      if (tab.dataset.securityTab === 'network') {
        void loadSecurityNetworkCenter(appRenderCallback);
      }
    });
  }

  if (elements.securityOpenIncidents) {
    elements.securityOpenIncidents.addEventListener('click', () => {
      setSecurityTab('incidents');
      renderSecurity();
      resetSecurityViewport(elements.securityTabs.find((tab) => tab.dataset.securityTab === 'incidents'));
    });
  }

  if (elements.securityIncidentsRefresh) {
    elements.securityIncidentsRefresh.addEventListener('click', () => {
      void loadSecurityIncidents(appRenderCallback);
    });
  }

  if (elements.securityFileChoose) {
    elements.securityFileChoose.addEventListener('click', () => {
      void chooseSecurityFile(appRenderCallback);
    });
  }

  if (elements.securityFileDrop) {
    elements.securityFileDrop.addEventListener('dragover', (event) => {
      event.preventDefault();
      elements.securityFileDrop.classList.add('drag-active');
    });
    elements.securityFileDrop.addEventListener('dragleave', () => {
      elements.securityFileDrop.classList.remove('drag-active');
    });
    elements.securityFileDrop.addEventListener('drop', (event) => {
      event.preventDefault();
      elements.securityFileDrop.classList.remove('drag-active');
      const file = event.dataTransfer?.files?.[0];
      const targetPath = file && window.monarchDesktop?.getPathForFile
        ? window.monarchDesktop.getPathForFile(file)
        : '';
      if (targetPath) {
        void scanSecurityFile(targetPath, appRenderCallback);
      } else {
        state.security.scanFeedback = {
          ok: false,
          summary: 'Перетаскивание файлов доступно в desktop-приложении Monarch.',
        };
        renderSecurity();
      }
    });
    elements.securityFileDrop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void chooseSecurityFile(appRenderCallback);
      }
    });
  }

  if (elements.securityScanNetwork) {
    elements.securityScanNetwork.addEventListener('click', () => {
      void loadSecurityNetworkCenter(appRenderCallback);
    });
  }

  if (elements.securityNetworkProfiles) {
    elements.securityNetworkProfiles.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-security-network-profile]');
      if (!button) return;
      void changeNetworkProfileTrust(
        button.dataset.securityNetworkProfile || '',
        button.dataset.securityNetworkTrusted !== 'true',
        appRenderCallback,
      );
    });
  }

  if (elements.securityQuarantineRefresh) {
    elements.securityQuarantineRefresh.addEventListener('click', () => {
      void loadSecurityQuarantine(appRenderCallback);
    });
  }

  if (elements.securityScanFeedback) {
    elements.securityScanFeedback.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-security-isolate-path]');
      const targetPath = button?.dataset?.securityIsolatePath;
      if (targetPath) {
        void runQuarantineAction('security.quarantine.isolate', { path: targetPath }, appRenderCallback);
      }
    });
  }

  if (elements.securityQuarantineList) {
    elements.securityQuarantineList.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-security-restore-id]');
      const quarantineId = button?.dataset?.securityRestoreId;
      if (quarantineId) {
        void runQuarantineAction('security.quarantine.restore', { quarantineId }, appRenderCallback);
      }
    });
  }

  if (elements.securityIncidentDetail) {
    elements.securityIncidentDetail.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-security-incident-status]');
      const status = button?.dataset?.securityIncidentStatus;
      const incidentId = button?.dataset?.securityIncidentId;
      if (status && incidentId) {
        void runIncidentStatusAction(incidentId, status, appRenderCallback);
      }
      const proposeNetwork = event.target?.closest?.('[data-security-propose-network]');
      if (proposeNetwork) {
        void proposeNetworkContainment(proposeNetwork.dataset.securityProposeNetwork || '', appRenderCallback);
      }
      const approveResponse = event.target?.closest?.('[data-security-approve-response]');
      if (approveResponse) {
        void approvePendingResponse(appRenderCallback);
      }
    });
  }

  if (elements.securityPinSave) {
    elements.securityPinSave.addEventListener('click', () => {
      void saveSecurityPin(appRenderCallback);
    });
  }
  if (elements.securityPinRecover) {
    elements.securityPinRecover.addEventListener('click', () => {
      void recoverSecurityPin(appRenderCallback);
    });
  }
  if (elements.securityPinRecoveryClear) {
    elements.securityPinRecoveryClear.addEventListener('click', () => {
      state.security.recoveryCodes = [];
      renderSecurity();
    });
  }

  if (elements.securityEmergencyRelease) {
    elements.securityEmergencyRelease.addEventListener('click', () => {
      void resolveEmergencyResponse('release', appRenderCallback);
    });
  }
  if (elements.securityEmergencyContinue) {
    elements.securityEmergencyContinue.addEventListener('click', () => {
      void resolveEmergencyResponse('continue', appRenderCallback);
    });
  }

  if (elements.securityRefresh) {
    elements.securityRefresh.addEventListener('click', () => {
      void loadSecurityStatus(appRenderCallback);
    });
  }

  if (elements.securityScanSystem) {
    elements.securityScanSystem.addEventListener('click', () => {
      void runSecurityAction('security.scan.system', {
        summaryOnly: true,
        includeFiles: false,
        includeInstalls: false,
        fileLimit: 100,
        noLlm: true,
      }, false, appRenderCallback);
    });
  }

  if (elements.securityIntegrity) {
    elements.securityIntegrity.addEventListener('click', () => {
      void runSecurityAction('security.integrity.verify', {}, false, appRenderCallback);
    });
  }

  if (elements.securityAudit) {
    elements.securityAudit.addEventListener('click', () => {
      void runSecurityAction('security.audit.tail', { lines: 20 }, false, appRenderCallback);
    });
  }

  if (elements.securityBaseline) {
    elements.securityBaseline.addEventListener('click', () => {
      void previewSecurityBaseline(appRenderCallback);
    });
  }
  if (elements.securityBaselinePreview) {
    elements.securityBaselinePreview.addEventListener('click', (event) => {
      if (event.target?.closest?.('[data-security-baseline-approve]')) {
        void approveSecurityBaseline(appRenderCallback);
      }
      if (event.target?.closest?.('[data-security-baseline-cancel]')) {
        state.security.baselinePreview = null;
        state.security.baselineFeedback = '';
        renderSecurity();
      }
    });
  }

  if (elements.securityReplay) {
    elements.securityReplay.addEventListener('click', () => {
      void runSecurityReplay(appRenderCallback);
    });
  }

  if (elements.securityBenchmarkStart) {
    elements.securityBenchmarkStart.addEventListener('click', () => {
      void startSecurityBenchmark(appRenderCallback);
    });
  }

  if (elements.securityBenchmarkCancel) {
    elements.securityBenchmarkCancel.addEventListener('click', () => {
      void cancelSecurityBenchmark(appRenderCallback);
    });
  }

  if (elements.securityStart) {
    elements.securityStart.addEventListener('click', () => {
      void runSecurityAction('security.protection.start', { noLlm: true }, true, appRenderCallback);
    });
  }

  if (elements.securityStop) {
    elements.securityStop.addEventListener('click', () => {
      void runSecurityAction('security.protection.stop', { waitSeconds: 10 }, true, appRenderCallback);
    });
  }
  if (elements.securityLevel) {
    elements.securityLevel.addEventListener('change', () => {
      void changeSecurityLevel(elements.securityLevel.value, appRenderCallback);
    });
  }
  for (const choice of elements.securityLevelChoices) {
    choice.addEventListener('click', () => {
      void changeSecurityLevel(choice.dataset.securityLevelChoice || '', appRenderCallback);
    });
  }
  if (elements.securityModelPolicySave) {
    elements.securityModelPolicySave.addEventListener('click', () => {
      void saveModelCommandPolicy(appRenderCallback);
    });
  }
}

async function changeSecurityLevel(level, appRenderCallback) {
  if (!['off', 'minimal', 'balanced', 'strict', 'maximum'].includes(level) || state.security.busy) return;
  await runSecurityAction('security.profile.set', { level }, true, appRenderCallback);
}

async function saveModelCommandPolicy(appRenderCallback) {
  if (state.security.busy) return;
  const enabled = elements.securityModelCommandsEnabled?.checked !== false;
  const confirmationMode = elements.securityModelConfirmation?.value === 'always' ? 'always' : 'adaptive';
  state.security.modelPolicyFeedback = 'Security сохраняет правила Oscar...';
  renderSecurity();
  await runSecurityAction('security.model_policy.set', {
    enabled,
    confirmationMode,
  }, true, appRenderCallback);
  state.security.modelPolicyFeedback = state.security.error
    ? state.security.error
    : 'Правила команд Oscar сохранены и применены.';
  appRenderCallback();
}

export async function loadSecurityStatus(appRenderCallback) {
  if (state.security.statusBusy) {
    return;
  }

  state.security.statusBusy = true;
  state.security.error = '';
  renderSecurity();

  try {
    const [result, emergency] = await Promise.all([
      executeSecurityCapabilityAction('security.status', {}, false),
      executeSecurityCapabilityAction('security.emergency.status', {}, false),
    ]);
    state.security.status = result;
    state.security.emergency = emergency;
    if (!state.security.lastResult) {
      state.security.lastResult = result;
    }
    const payload = readSecurityPayload(result) || {};
    const profile = payload.profile && typeof payload.profile === 'object' ? payload.profile : {};
    if (profile.level !== 'off') {
      void loadSecurityIncidents(appRenderCallback);
      void loadSecurityPinStatus(appRenderCallback);
    }
  } catch (error) {
    state.security.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.statusBusy = false;
    appRenderCallback();
  }

}

export async function loadSecurityIncidents(appRenderCallback) {
  if (state.security.incidentsBusy) return;
  state.security.incidentsBusy = true;
  renderSecurity();
  try {
    const [incidentResult, responseServiceStatus] = await Promise.all([
      executeSecurityCapabilityAction('security.incidents.list', { limit: 100 }, false),
      executeSecurityCapabilityAction('security.response.service.status', {}, false),
    ]);
    state.security.incidents = incidentResult;
    state.security.responseServiceStatus = responseServiceStatus;
    const incidents = readSecurityIncidents();
    if (!state.security.selectedIncidentId && incidents.length) {
      state.security.selectedIncidentId = incidents[0].incident_id || null;
    }
  } catch (error) {
    state.security.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.incidentsBusy = false;
    appRenderCallback();
  }
}

export async function loadSecurityQuarantine(appRenderCallback) {
  if (state.security.quarantineBusy) return;
  state.security.quarantineBusy = true;
  renderSecurity();
  try {
    state.security.quarantine = await executeSecurityCapabilityAction(
      'security.quarantine.list',
      {},
      false,
    );
  } catch (error) {
    state.security.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.quarantineBusy = false;
    appRenderCallback();
  }
}

export async function loadSecurityNetworkCenter(appRenderCallback) {
  if (state.security.networkBusy) return;
  state.security.networkBusy = true;
  state.security.error = '';
  renderSecurity();
  try {
    const [networkCenter, responseActions, responseServiceStatus] = await Promise.all([
      executeSecurityCapabilityAction('security.network.center', { limit: 100 }, false),
      executeSecurityCapabilityAction('security.response.actions', {}, false),
      executeSecurityCapabilityAction('security.response.service.status', {}, false),
    ]);
    state.security.networkCenter = networkCenter;
    state.security.responseActions = responseActions;
    state.security.responseServiceStatus = responseServiceStatus;
  } catch (error) {
    state.security.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.networkBusy = false;
    appRenderCallback();
  }
}

async function changeNetworkProfileTrust(profileId, trusted, appRenderCallback) {
  if (!/^[a-f0-9]{24}$/i.test(profileId) || state.security.networkBusy) return;
  state.security.networkBusy = true;
  renderSecurity();
  try {
    await executeSecurityCapabilityAction(
      'security.network.profile.trust',
      { profileId, trusted },
      true,
    );
    state.security.networkCenter = await executeSecurityCapabilityAction(
      'security.network.center',
      { limit: 100 },
      false,
    );
  } catch (error) {
    state.security.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.networkBusy = false;
    appRenderCallback();
  }
}

export async function loadSecurityPinStatus(appRenderCallback) {
  if (state.security.pinBusy) return;
  try {
    state.security.pinStatus = await executeSecurityCapabilityAction('security.pin.status', {}, false);
  } catch (error) {
    state.security.pinFeedback = error instanceof Error ? error.message : String(error);
  } finally {
    appRenderCallback();
  }
}

async function saveSecurityPin(appRenderCallback) {
  if (state.security.pinBusy) return;
  const newPin = String(elements.securityPinNew?.value || '');
  const confirmation = String(elements.securityPinConfirm?.value || '');
  const currentPin = String(elements.securityPinCurrent?.value || '');
  if (!/^\d{6}$/.test(newPin) || newPin !== confirmation) {
    state.security.pinFeedback = 'PIN должен содержать ровно 6 цифр и совпадать с повтором.';
    renderSecurity();
    return;
  }
  state.security.pinBusy = true;
  state.security.pinFeedback = 'Сохраняем защищённый verifier...';
  renderSecurity();
  try {
    const input = { newPin, confirmation };
    if (currentPin) input.currentPin = currentPin;
    const result = await executeSecurityCapabilityAction('security.pin.set', input, true);
    state.security.recoveryCodes = readOneTimeRecoveryCodes(result);
    state.security.pinFeedback = state.security.recoveryCodes.length
      ? 'Security PIN настроен. Сохрани новые recovery-коды сейчас.'
      : 'Security PIN настроен.';
    if (elements.securityPinCurrent) elements.securityPinCurrent.value = '';
    if (elements.securityPinNew) elements.securityPinNew.value = '';
    if (elements.securityPinConfirm) elements.securityPinConfirm.value = '';
    state.security.pinStatus = await executeSecurityCapabilityAction('security.pin.status', {}, false);
  } catch (error) {
    state.security.pinFeedback = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.pinBusy = false;
    appRenderCallback();
  }
}

async function recoverSecurityPin(appRenderCallback) {
  if (state.security.pinBusy) return;
  const recoveryCode = String(elements.securityPinRecoveryCode?.value || '').trim();
  const newPin = String(elements.securityPinNew?.value || '');
  const confirmation = String(elements.securityPinConfirm?.value || '');
  if (!recoveryCode || recoveryCode.length > 64 || !/^\d{6}$/.test(newPin) || newPin !== confirmation) {
    state.security.pinFeedback = 'Укажи recovery-код и совпадающий новый PIN из 6 цифр.';
    renderSecurity();
    return;
  }
  state.security.pinBusy = true;
  state.security.pinFeedback = 'Проверяем одноразовый recovery-код...';
  renderSecurity();
  try {
    const result = await executeSecurityCapabilityAction('security.pin.recover', {
      recoveryCode,
      newPin,
      confirmation,
    }, true);
    state.security.recoveryCodes = readOneTimeRecoveryCodes(result);
    state.security.pinFeedback = 'PIN восстановлен. Старые recovery-коды аннулированы — сохрани новые.';
    if (elements.securityPinRecoveryCode) elements.securityPinRecoveryCode.value = '';
    if (elements.securityPinCurrent) elements.securityPinCurrent.value = '';
    if (elements.securityPinNew) elements.securityPinNew.value = '';
    if (elements.securityPinConfirm) elements.securityPinConfirm.value = '';
    state.security.pinStatus = await executeSecurityCapabilityAction('security.pin.status', {}, false);
  } catch (error) {
    state.security.pinFeedback = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.pinBusy = false;
    appRenderCallback();
  }
}

async function runQuarantineAction(capabilityId, input, appRenderCallback) {
  await runSecurityAction(capabilityId, input, true, appRenderCallback);
  setSecurityTab('quarantine');
  await loadSecurityQuarantine(appRenderCallback);
}

async function runIncidentStatusAction(incidentId, status, appRenderCallback) {
  await runSecurityAction(
    'security.incident.status',
    {
      incidentId,
      status,
      reason: status === 'dismissed'
        ? 'Пользователь подтвердил, что событие безопасно'
        : 'Пользователь обновил статус инцидента',
    },
    true,
    appRenderCallback,
  );
  await loadSecurityIncidents(appRenderCallback);
}

async function proposeNetworkContainment(incidentId, appRenderCallback) {
  if (state.security.busy) return;
  const incident = readSecurityIncidents().find((item) => item.incident_id === incidentId);
  const scope = networkResponseScope(incident);
  if (!incident || !scope) {
    state.security.responseFeedback = 'В инциденте нет точного IP/порта для безопасной блокировки.';
    renderIncidentWorkspace();
    return;
  }
  setSecurityBusy(true);
  state.security.responseFeedback = 'Проверяем границы временной блокировки...';
  renderSecurity();
  try {
    const result = await executeSecurityCapabilityAction('security.response.propose', {
      incidentId,
      action: 'block_network',
      scope,
      rationale: ['Пользователь запросил временную блокировку endpoint из доказательств инцидента'],
      proposedBy: 'user',
      ttlSeconds: 900,
    }, true);
    const payload = readSecurityPayload(result) || {};
    const stored = payload.stored_proposal && typeof payload.stored_proposal === 'object'
      ? payload.stored_proposal : {};
    const proposal = stored.proposal && typeof stored.proposal === 'object' ? stored.proposal : {};
    if (!proposal.proposal_id) throw new Error('Security не вернул идентификатор response proposal.');
    state.security.pendingResponse = {
      incidentId,
      proposalId: proposal.proposal_id,
      scope,
      expiresAt: proposal.expires_at,
    };
    state.security.responseFeedback = 'Предложение проверено. Введи Security PIN для одноразового grant.';
  } catch (error) {
    state.security.responseFeedback = error instanceof Error ? error.message : String(error);
  } finally {
    setSecurityBusy(false);
    appRenderCallback();
  }
}

async function approvePendingResponse(appRenderCallback) {
  const pending = state.security.pendingResponse;
  const pinInput = elements.securityIncidentDetail?.querySelector?.('[data-security-response-pin]');
  const pin = String(pinInput?.value || '');
  if (!pending?.proposalId || !/^\d{6}$/.test(pin)) {
    state.security.responseFeedback = 'Введи ровно 6 цифр Security PIN.';
    renderIncidentWorkspace();
    return;
  }
  setSecurityBusy(true);
  state.security.responseFeedback = 'Исполнитель повторно проверяет PIN, evidence и TTL...';
  renderSecurity();
  try {
    await executeSecurityCapabilityAction('security.response.approve', {
      proposalId: pending.proposalId,
      pin,
    }, true);
    state.security.pendingResponse = null;
    state.security.responseFeedback = 'Правило применено отдельным executor и будет автоматически отменено по TTL.';
    const [actions, service] = await Promise.all([
      executeSecurityCapabilityAction('security.response.actions', {}, false),
      executeSecurityCapabilityAction('security.response.service.status', {}, false),
    ]);
    state.security.responseActions = actions;
    state.security.responseServiceStatus = service;
  } catch (error) {
    state.security.responseFeedback = error instanceof Error ? error.message : String(error);
  } finally {
    if (pinInput) pinInput.value = '';
    setSecurityBusy(false);
    appRenderCallback();
  }
}

async function resolveEmergencyResponse(decision, appRenderCallback) {
  if (state.security.busy) return;
  const pin = String(elements.securityEmergencyPin?.value || '');
  if (!/^\d{6}$/.test(pin)) {
    state.security.emergencyFeedback = 'Введи ровно 6 цифр Security PIN.';
    renderEmergencyResponse();
    return;
  }
  setSecurityBusy(true);
  state.security.emergencyFeedback = decision === 'release'
    ? 'Освобождаем временные ограничения...'
    : 'Продлеваем только ограниченное containment...';
  renderSecurity();
  try {
    await executeSecurityCapabilityAction('security.emergency.resolve', { decision, pin }, true);
    state.security.emergency = await executeSecurityCapabilityAction('security.emergency.status', {}, false);
    state.security.responseActions = await executeSecurityCapabilityAction('security.response.actions', {}, false);
    state.security.emergencyFeedback = decision === 'release'
      ? 'Аварийный режим завершён. Управление возвращено пользователю.'
      : 'Security продолжит ограниченное наблюдение до указанного TTL.';
  } catch (error) {
    state.security.emergencyFeedback = error instanceof Error ? error.message : String(error);
  } finally {
    if (elements.securityEmergencyPin) elements.securityEmergencyPin.value = '';
    setSecurityBusy(false);
    appRenderCallback();
  }
}

async function chooseSecurityFile(appRenderCallback) {
  if (!window.monarchDesktop?.pickSecurityFile) {
    state.security.scanFeedback = {
      ok: false,
      summary: 'Выбор локального файла доступен в desktop-приложении Monarch.',
    };
    renderSecurity();
    return;
  }
  const targetPath = await window.monarchDesktop.pickSecurityFile();
  if (targetPath) {
    await scanSecurityFile(targetPath, appRenderCallback);
  }
}

async function scanSecurityFile(targetPath, appRenderCallback) {
  state.security.scanFeedback = {
    ok: true,
    pending: true,
    path: targetPath,
    summary: `Проверяю ${securityPathName(targetPath)} локально...`,
  };
  renderSecurity();
  await runSecurityAction(
    'security.deep_scan.file',
    { path: targetPath, defender: false, noLlm: true },
    false,
    appRenderCallback
  );
}

async function runSecurityAction(capabilityId, input, confirmed, appRenderCallback) {
  if (state.security.busy) {
    return;
  }

  setSecurityBusy(true);
  state.security.error = '';
  renderSecurity();

  try {
    const result = await executeSecurityCapabilityAction(capabilityId, input, confirmed);
    state.security.lastResult = result;
    if (capabilityId === 'security.status') {
      state.security.status = result;
    }
    if (
      (capabilityId === 'security.protection.start' || capabilityId === 'security.protection.stop')
      && readProtectionRunning(readSecurityPayload(result)) !== null
    ) {
      state.security.status = result;
    }
    if (capabilityId === 'security.audit.tail') {
      state.security.audit = result;
    }
    if (capabilityId === 'security.scan.network') {
      state.security.networkResult = result;
    }
    if (capabilityId === 'security.deep_scan.file') {
      const payload = readSecurityPayload(result);
      const assessment = payload?.assessment && typeof payload.assessment === 'object'
        ? payload.assessment
        : {};
      const event = assessment.event && typeof assessment.event === 'object'
        ? assessment.event
        : {};
      const targetPath = String(input?.path || event.subject || 'Файл');
      const eventScore = readNumber(assessment.score, 0);
      const score = Math.min(400, eventScore * 4);
      const scanRecord = {
        path: targetPath,
        name: securityPathName(targetPath),
        score,
        severity: String(assessment.severity || 'clean'),
        scannedAt: new Date().toISOString(),
      };
      state.security.recentScans = [scanRecord, ...state.security.recentScans].slice(0, 8);
      state.security.scanFeedback = {
        ok: result.ok !== false,
        pending: false,
        path: targetPath,
        score,
        summary: score >= 250
          ? 'Файл требует внимания. Откройте детали результата перед запуском.'
          : score > 0
            ? 'Проверка завершена: обнаружены сигналы для ручной оценки.'
            : 'Проверка завершена: опасные признаки не обнаружены.',
      };
    }
    if (capabilityId !== 'security.status') {
      void loadSecurityStatus(appRenderCallback);
    }
  } catch (error) {
    const failedResult = readErrorExecutionResult(error);
    if (failedResult) {
      state.security.lastResult = failedResult;
    }
    state.security.error = error instanceof Error ? error.message : String(error);
    if (capabilityId === 'security.deep_scan.file') {
      state.security.scanFeedback = {
        ok: false,
        pending: false,
        summary: state.security.error,
      };
    }
  } finally {
    setSecurityBusy(false);
    appRenderCallback();
  }
}

async function executeSecurityCapabilityAction(capabilityId, input, confirmed) {
  if (confirmed) {
    return executeConfirmedCapability('security', capabilityId, input, 'ui:security');
  }

  const result = await executeCapability('security', capabilityId, input, 'ui:security', confirmed);
  if (!result.ok && !result.result?.ok) {
    const err = result.result?.summary || result.result?.error || result.summary || result.error;
    throwSecurityExecutionError(err || 'Security не выполнил команду.', result.result || result);
  }
  return result.result || result;
}

async function runSecurityReplay(appRenderCallback) {
  if (state.security.busy) return;
  setSecurityBusy(true);
  state.security.error = '';
  renderSecurity();
  try {
    state.security.replayMetrics = await executeSecurityCapabilityAction(
      'security.attack.simulation',
      { withLlm: false },
      true,
    );
  } catch (error) {
    state.security.error = error instanceof Error ? error.message : String(error);
  } finally {
    setSecurityBusy(false);
    appRenderCallback();
  }
}

async function startSecurityBenchmark(appRenderCallback) {
  if (state.security.benchmarkBusy || state.security.benchmarkJob?.status === 'running') return;
  state.security.benchmarkBusy = true;
  state.security.error = '';
  renderSecurity();
  try {
    const result = await executeSecurityCapabilityAction(
      'security.benchmark.start',
      { durationSeconds: 300, intervalSeconds: 0.5 },
      true,
    );
    state.security.benchmarkJob = readBenchmarkJob(result);
    scheduleBenchmarkPoll(appRenderCallback);
  } catch (error) {
    state.security.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.benchmarkBusy = false;
    appRenderCallback();
  }
}

async function loadSecurityBenchmarkStatus(appRenderCallback) {
  if (benchmarkStatusInFlight) return;
  benchmarkStatusInFlight = true;
  try {
    const result = await executeSecurityCapabilityAction('security.benchmark.status', {}, false);
    const next = readBenchmarkJob(result);
    const current = state.security.benchmarkJob;
    if (current?.status === 'running' || next.status !== 'running' || current?.jobId !== next.jobId) {
      state.security.benchmarkJob = next;
    }
  } catch (error) {
    state.security.error = error instanceof Error ? error.message : String(error);
  } finally {
    benchmarkStatusInFlight = false;
    appRenderCallback();
    scheduleBenchmarkPoll(appRenderCallback);
  }
}

async function cancelSecurityBenchmark(appRenderCallback) {
  const jobId = String(state.security.benchmarkJob?.jobId || '');
  if (!jobId || state.security.benchmarkBusy) return;
  state.security.benchmarkBusy = true;
  clearBenchmarkPoll();
  try {
    const result = await executeSecurityCapabilityAction('security.benchmark.cancel', { jobId }, true);
    state.security.benchmarkJob = readBenchmarkJob(result);
  } catch (error) {
    state.security.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.benchmarkBusy = false;
    appRenderCallback();
  }
}

function scheduleBenchmarkPoll(appRenderCallback) {
  clearBenchmarkPoll();
  if (state.security.benchmarkJob?.status !== 'running') return;
  benchmarkPollTimer = setTimeout(() => {
    benchmarkPollTimer = null;
    void loadSecurityBenchmarkStatus(appRenderCallback);
  }, 1000);
}

function clearBenchmarkPoll() {
  if (benchmarkPollTimer !== null) clearTimeout(benchmarkPollTimer);
  benchmarkPollTimer = null;
}

function readBenchmarkJob(result) {
  const direct = result?.output;
  if (direct && typeof direct === 'object' && typeof direct.status === 'string') return direct;
  const payload = readSecurityPayload(result);
  if (payload && typeof payload.status === 'string') return payload;
  return { status: 'idle', progressPercent: 0 };
}

function throwSecurityExecutionError(message, result) {
  const error = new Error(message);
  error.result = result;
  throw error;
}

function setSecurityBusy(isBusy) {
  state.security.busy = isBusy;
  syncSecurityButtons();
}

function syncSecurityButtons() {
  const isBusy = state.security.busy || state.security.statusBusy || state.security.networkBusy;
  const buttons = [
    elements.securityRefresh,
    elements.securityScanSystem,
    elements.securityIntegrity,
    elements.securityAudit,
    elements.securityBaseline,
    elements.securityReplay,
    elements.securityFileChoose,
    elements.securityScanNetwork,
  ];
  for (const btn of buttons) {
    if (btn) btn.disabled = isBusy;
  }
  if (elements.securityBaseline) {
    elements.securityBaseline.disabled = Boolean(isBusy || state.security.baselineBusy);
  }
  if (elements.securityIncidentsRefresh) {
    elements.securityIncidentsRefresh.disabled = Boolean(state.security.incidentsBusy);
  }

  const running = readSecurityRunningState();
  const emergency = readSecurityPayload(state.security.emergency) || {};
  const emergencyActive = emergency.active === true;
  if (elements.securityStart) {
    elements.securityStart.hidden = running;
    elements.securityStart.disabled = isBusy || running;
  }
  if (elements.securityStop) {
    elements.securityStop.hidden = !running;
    elements.securityStop.disabled = isBusy || !running || emergencyActive;
    elements.securityStop.title = emergencyActive ? 'Сначала заверши аварийный режим' : '';
  }
  if (elements.securityLevel) {
    const payload = readSecurityPayload(state.security.status) || {};
    const profile = payload.profile && typeof payload.profile === 'object' ? payload.profile : {};
    elements.securityLevel.value = ['off', 'minimal', 'balanced', 'strict', 'maximum'].includes(profile.level)
      ? profile.level
      : 'balanced';
    elements.securityLevel.disabled = isBusy;
  }
}

export function renderSecurity() {
  if (!elements.securitySummary) {
    return;
  }

  renderProtectionOverview();
  renderSecurityTabs();
  renderScanLab();
  renderIncidentWorkspace();
  renderNetworkResult();
  renderQuarantine();
  renderSecurityPin();
  renderReplayMetrics();
  renderBaselinePreview();
  renderBenchmarkStatus();
  renderEmergencyResponse();
  renderSecuritySettings();
  renderSecurityPills();
  renderSecuritySummary();
  renderSecurityFindings();
  renderSecurityRuntime();
  renderSecurityAudit();
  syncSecurityButtons();
}

function renderSecuritySettings() {
  const payload = readSecurityPayload(state.security.status) || {};
  const profile = payload.profile && typeof payload.profile === 'object' ? payload.profile : {};
  const policy = payload.model_policy && typeof payload.model_policy === 'object' ? payload.model_policy : {};
  const level = ['off', 'minimal', 'balanced', 'strict', 'maximum'].includes(profile.level)
    ? profile.level
    : 'balanced';
  const labels = { off: 'Защита отключена', minimal: 'Минимальный профиль', balanced: 'Средний профиль', strict: 'Строгий профиль', maximum: 'Максимальный профиль' };
  if (elements.securitySettingsStatus) elements.securitySettingsStatus.textContent = labels[level];
  for (const choice of elements.securityLevelChoices) {
    const selected = choice.dataset.securityLevelChoice === level;
    choice.classList.toggle('selected', selected);
    choice.setAttribute('aria-checked', String(selected));
    choice.disabled = state.security.busy || state.security.statusBusy;
  }
  if (elements.securityModelCommandsEnabled) {
    elements.securityModelCommandsEnabled.checked = policy.enabled !== false;
    elements.securityModelCommandsEnabled.disabled = state.security.busy;
  }
  if (elements.securityModelConfirmation) {
    elements.securityModelConfirmation.value = policy.confirmation_mode === 'always' ? 'always' : 'adaptive';
    elements.securityModelConfirmation.disabled = state.security.busy || policy.enabled === false;
  }
  if (elements.securityModelPolicySave) elements.securityModelPolicySave.disabled = state.security.busy;
  if (elements.securityModelPolicyFeedback) {
    elements.securityModelPolicyFeedback.textContent = state.security.modelPolicyFeedback || '';
  }
}

export function renderSecurityPolicyControls() {
  renderSecuritySettings();
}

function renderReplayMetrics() {
  if (!elements.securityReplayMetrics) return;
  const payload = readSecurityPayload(state.security.replayMetrics);
  const metrics = payload?.metrics && typeof payload.metrics === 'object' ? payload.metrics : null;
  if (!metrics) {
    elements.securityReplayMetrics.innerHTML = '<div class="security-list-empty">Replay lab ещё не запускался. Он использует только инертные локальные сценарии.</div>';
    return;
  }
  const detection = Math.round(readNumber(metrics.detection_rate, 0) * 100);
  const falsePositive = Math.round(readNumber(metrics.false_positive_rate, 0) * 100);
  const protectorIdle = metrics.protector_idle && typeof metrics.protector_idle === 'object' ? metrics.protector_idle : {};
  const replayBurst = metrics.replay_process_burst && typeof metrics.replay_process_burst === 'object' ? metrics.replay_process_burst : {};
  const incidentLatency = metrics.sensor_to_incident && typeof metrics.sensor_to_incident === 'object' ? metrics.sensor_to_incident : {};
  const coverage = metrics.coverage && typeof metrics.coverage === 'object' ? metrics.coverage : {};
  const attackCoverage = formatReplayCoverage(coverage.attack_families, {
    rat: 'RAT', persistence: 'автозапуск', exfiltration: 'эксфильтрация', file: 'файлы',
    network: 'сеть', process: 'процессы', device: 'устройства',
  });
  const benignCoverage = formatReplayCoverage(coverage.benign_workloads, {
    administrator: 'администрирование', developer: 'разработка', network_admin: 'настройка сети',
    file: 'файлы', network: 'сеть', process: 'процессы', device: 'устройства',
  });
  elements.securityReplayMetrics.innerHTML = `
    <section>
      <span><strong>Replay quality gate</strong><small>${payload.passed ? 'Пройден' : 'Требует внимания'} · ${escapeHtml(payload.case_count || 0)} атак / ${escapeHtml(payload.benign_case_count || 0)} benign</small></span>
      <div>
        <b>${escapeHtml(detection)}%<small>детекция</small></b>
        <b>${escapeHtml(falsePositive)}%<small>false positive</small></b>
        <b>${escapeHtml(readNumber(metrics.case_latency_ms_p95, 0).toFixed(2))} ms<small>p95 case</small></b>
        <b>${protectorIdle.available === true ? `${escapeHtml(readNumber(protectorIdle.cpu_percent, 0).toFixed(2))}%` : '—'}<small>protector CPU p50</small></b>
        <b>${protectorIdle.available === true ? `${escapeHtml(readNumber(protectorIdle.cpu_percent_p95, 0).toFixed(2))}%` : '—'}<small>protector CPU p95</small></b>
        <b>${protectorIdle.available === true ? escapeHtml(formatSecurityBytes(protectorIdle.rss_bytes)) : '—'}<small>protector RSS</small></b>
        <b>${replayBurst.available === true ? `${escapeHtml(readNumber(replayBurst.cpu_percent, 0).toFixed(2))}%` : '—'}<small>replay CPU</small></b>
        <b>${replayBurst.available === true ? `${escapeHtml(readNumber(replayBurst.system_cpu_percent, 0).toFixed(2))}%` : '—'}<small>system CPU during replay</small></b>
        <b>${replayBurst.available === true ? escapeHtml(formatSecurityBytes(replayBurst.rss_peak_observed_bytes)) : '—'}<small>replay peak RSS</small></b>
        <b>${incidentLatency.available === true ? `${escapeHtml(readNumber(incidentLatency.latency_ms_p95, 0).toFixed(2))} ms` : '—'}<small>event → incident p95</small></b>
      </div>
      ${(attackCoverage || benignCoverage) ? `<p class="security-replay-coverage">
        ${attackCoverage ? `<span><em>Атаки</em>${attackCoverage}</span>` : ''}
        ${benignCoverage ? `<span><em>Безопасные нагрузки</em>${benignCoverage}</span>` : ''}
      </p>` : ''}
    </section>
  `;
}

function formatReplayCoverage(values, labels) {
  if (!Array.isArray(values)) return '';
  return values
    .map((value) => labels[String(value)] || String(value))
    .filter(Boolean)
    .map((value) => escapeHtml(value))
    .join(' · ');
}

async function previewSecurityBaseline(appRenderCallback) {
  if (state.security.baselineBusy) return;
  state.security.baselineBusy = true;
  state.security.baselineFeedback = 'Сравниваем текущий автозапуск с одобренной нормой...';
  renderSecurity();
  try {
    const result = await executeSecurityCapabilityAction('security.baseline.preview', {}, false);
    state.security.baselinePreview = readSecurityPayload(result);
    state.security.baselineFeedback = '';
  } catch (error) {
    state.security.baselineFeedback = error instanceof Error ? error.message : String(error);
  } finally {
    state.security.baselineBusy = false;
    appRenderCallback();
  }
}

async function approveSecurityBaseline(appRenderCallback) {
  const digest = String(state.security.baselinePreview?.digest || '');
  if (!/^[a-f0-9]{64}$/i.test(digest) || state.security.baselineBusy) return;
  state.security.baselineBusy = true;
  let refreshPreview = false;
  state.security.baselineFeedback = 'Проверяем, что автозапуск не изменился после preview...';
  renderSecurity();
  try {
    await executeSecurityCapabilityAction(
      'security.baseline.write',
      { scope: 'persistence', expectedDigest: digest },
      true,
    );
    state.security.baselinePreview = null;
    state.security.baselineFeedback = 'Новая норма автозапуска одобрена и HMAC-защищена.';
  } catch (error) {
    state.security.baselineFeedback = error instanceof Error ? error.message : String(error);
    refreshPreview = true;
  } finally {
    state.security.baselineBusy = false;
    appRenderCallback();
  }
  if (refreshPreview) await previewSecurityBaseline(appRenderCallback);
}

function renderBaselinePreview() {
  if (!elements.securityBaselinePreview) return;
  const preview = state.security.baselinePreview;
  if (!preview) {
    elements.securityBaselinePreview.innerHTML = state.security.baselineFeedback
      ? `<small class="security-baseline-feedback">${escapeHtml(state.security.baselineFeedback)}</small>`
      : '';
    return;
  }
  const counts = preview.counts && typeof preview.counts === 'object' ? preview.counts : {};
  const changes = Array.isArray(preview.changes) ? preview.changes.slice(0, 20) : [];
  const labels = { added: 'Новая', changed: 'Изменена', removed: 'Удалена' };
  elements.securityBaselinePreview.innerHTML = `
    <section>
      <header><span><strong>Изменения автозапуска</strong><small>Одобрение будет привязано к этому snapshot</small></span><code>${escapeHtml(String(preview.digest || '').slice(0, 12))}…</code></header>
      <div class="security-baseline-counts">
        <b>${escapeHtml(readNumber(counts.added, 0))}<small>новых</small></b>
        <b>${escapeHtml(readNumber(counts.changed, 0))}<small>изменено</small></b>
        <b>${escapeHtml(readNumber(counts.removed, 0))}<small>удалено</small></b>
        <b>${escapeHtml(readNumber(counts.unchanged, 0))}<small>без изменений</small></b>
      </div>
      <div class="security-baseline-changes">
        ${changes.length ? changes.map((item) => `<div><span class="${escapeHtml(item.status || '')}">${escapeHtml(labels[item.status] || item.status || 'Изменение')}</span><code>${escapeHtml(item.key || '')}</code></div>`).join('') : '<small>Изменений нет. Можно безопасно подтвердить текущую норму.</small>'}
        ${preview.changes_truncated ? `<small>Ещё ${escapeHtml(preview.changes_truncated)} изменений скрыто из bounded preview.</small>` : ''}
      </div>
      <footer>
        <button type="button" class="claude-primary-btn" data-security-baseline-approve ${state.security.baselineBusy ? 'disabled' : ''}>Одобрить эту норму</button>
        <button type="button" class="claude-ghost-btn" data-security-baseline-cancel ${state.security.baselineBusy ? 'disabled' : ''}>Отмена</button>
      </footer>
      ${state.security.baselineFeedback ? `<small class="security-baseline-feedback">${escapeHtml(state.security.baselineFeedback)}</small>` : ''}
    </section>`;
}

function renderBenchmarkStatus() {
  if (!elements.securityBenchmarkStatus) return;
  const job = state.security.benchmarkJob;
  const status = String(job?.status || 'idle');
  const running = status === 'running';
  if (elements.securityBenchmarkStart) {
    elements.securityBenchmarkStart.hidden = running;
    elements.securityBenchmarkStart.disabled = Boolean(state.security.benchmarkBusy || state.security.busy);
  }
  if (elements.securityBenchmarkCancel) {
    elements.securityBenchmarkCancel.hidden = !running;
    elements.securityBenchmarkCancel.disabled = Boolean(state.security.benchmarkBusy);
  }
  if (!job || status === 'idle') {
    elements.securityBenchmarkStatus.innerHTML = '';
    return;
  }
  const progress = Math.max(0, Math.min(100, readNumber(job.progressPercent, 0)));
  const result = job.result && typeof job.result === 'object' ? job.result : {};
  const cpu = result.cpu_percent && typeof result.cpu_percent === 'object' ? result.cpu_percent : {};
  const rss = result.rss_bytes && typeof result.rss_bytes === 'object' ? result.rss_bytes : {};
  const statusLabel = {
    running: 'Идёт наблюдение', completed: 'Измерение завершено', failed: 'Измерение не завершено', cancelled: 'Остановлено',
  }[status] || status;
  elements.securityBenchmarkStatus.innerHTML = `
    <section class="security-benchmark-card ${escapeHtml(status)}">
      <header><span><strong>${escapeHtml(statusLabel)}</strong><small>${escapeHtml(readNumber(job.elapsedSeconds, 0).toFixed(1))} / ${escapeHtml(readNumber(job.durationSeconds, 0).toFixed(0))} сек</small></span><b>${escapeHtml(progress.toFixed(0))}%</b></header>
      <div class="security-benchmark-progress"><i style="width:${escapeHtml(progress.toFixed(1))}%"></i></div>
      ${status === 'completed' ? `<div class="security-benchmark-result">
        <span><b>${escapeHtml(readNumber(cpu.p50, 0).toFixed(2))}%</b><small>CPU p50</small></span>
        <span><b>${escapeHtml(readNumber(cpu.p95, 0).toFixed(2))}%</b><small>CPU p95</small></span>
        <span><b>${escapeHtml(formatSecurityBytes(rss.p50))}</b><small>RSS p50</small></span>
        <span><b>${escapeHtml(formatSecurityBytes(rss.p95))}</b><small>RSS p95</small></span>
      </div>` : ''}
      ${job.error ? `<small class="security-benchmark-error">${escapeHtml(job.error)}</small>` : ''}
    </section>`;
}

function renderEmergencyResponse() {
  if (!elements.securityEmergencyPanel) return;
  const emergency = readSecurityPayload(state.security.emergency) || {};
  const active = emergency.active === true && ['activating', 'awaiting_user', 'contained'].includes(String(emergency.state || ''));
  elements.securityEmergencyPanel.hidden = !active;
  if (!active) return;
  if (elements.securityEmergencyTitle) {
    elements.securityEmergencyTitle.textContent = emergency.state === 'contained'
      ? 'Аварийное containment активно'
      : 'Обнаружена подтверждённая критическая опасность';
  }
  if (elements.securityEmergencyCopy) {
    const lockCopy = emergency.native_lock_succeeded === true
      ? 'Windows был заблокирован штатным механизмом.'
      : 'Штатная блокировка не применена; восстановление остаётся fail-open.';
    elements.securityEmergencyCopy.textContent = `${lockCopy} Риск ${readNumber(emergency.risk_score, 0)}/800 · TTL до ${formatSecurityTime(emergency.expires_at)}.`;
  }
  const service = readSecurityPayload(state.security.responseServiceStatus) || {};
  if (elements.securityEmergencyRelease) elements.securityEmergencyRelease.disabled = Boolean(state.security.busy);
  if (elements.securityEmergencyContinue) {
    elements.securityEmergencyContinue.disabled = Boolean(state.security.busy || service.running !== true);
    elements.securityEmergencyContinue.title = service.running === true ? '' : 'Elevated executor не запущен';
  }
  if (elements.securityEmergencyPin) elements.securityEmergencyPin.disabled = Boolean(state.security.busy);
  if (elements.securityEmergencyFeedback) elements.securityEmergencyFeedback.textContent = state.security.emergencyFeedback || emergency.reason || '';
}

function renderNetworkResult() {
  if (!elements.securityNetworkResult) return;
  if (state.security.error && state.security.activeTab === 'network') {
    elements.securityNetworkResult.innerHTML = `
      <div class="security-scan-result failed">
        <strong>Network Center требует внимания</strong>
        <span>${escapeHtml(state.security.error)}</span>
      </div>
    `;
    if (!state.security.networkCenter) renderNetworkCollections({});
    return;
  }
  if (state.security.networkBusy && !state.security.networkCenter) {
    elements.securityNetworkResult.innerHTML = `
      <div class="security-scan-result pending">
        <strong>Проверяем сеть</strong>
        <span>Собираем локальные подключения, порты, DNS и состояние firewall.</span>
      </div>
    `;
    return;
  }
  const result = state.security.networkCenter;
  if (!result) {
    elements.securityNetworkResult.innerHTML = '<div class="security-list-empty"><strong>Network Center готов</strong><span>Нажми «Обновить», чтобы собрать локальную сетевую картину.</span></div>';
    renderNetworkCollections({});
    return;
  }
  const payload = readSecurityPayload(result) || {};
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  elements.securityNetworkResult.innerHTML = `
    <div class="security-scan-result ${result.ok === false ? 'failed' : Number(summary.high_attention || 0) ? 'pending' : 'active'}">
      <strong>${escapeHtml(result.ok === false ? 'Состояние сети недоступно' : Number(summary.high_attention || 0) ? 'Сеть требует внимания' : 'Критических сетевых сигналов нет')}</strong>
      <span>${escapeHtml(result.ok === false ? (result.summary || 'Не удалось собрать данные.') : `${Number(summary.active_connections || 0)} подключений · ${Number(summary.listeners || 0)} слушающих портов`)}</span>
    </div>
  `;
  renderNetworkCollections(payload);
}

function renderNetworkCollections(payload) {
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  if (elements.securityNetworkMetrics) {
    elements.securityNetworkMetrics.innerHTML = [
      ['Подключения', summary.active_connections || 0],
      ['Порты', summary.listeners || 0],
      ['Профили', summary.profiles || 0],
      ['Требуют внимания', summary.high_attention || 0],
    ].map(([label, value]) => `<div><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join('');
  }
  const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  renderNetworkList(elements.securityNetworkProfiles, profiles, (profile) => `
    <div class="security-network-row">
      <span><strong>${escapeHtml(profile.interface_alias || 'Сетевой профиль')}${profile.current ? ' · активен' : ''}</strong><small>${escapeHtml([...(profile.ipv4 || []), ...(profile.gateway || [])].join(' · ') || 'Адрес не определён')}</small></span>
      <button type="button" class="claude-ghost-btn" data-security-network-profile="${escapeHtml(profile.profile_id || '')}" data-security-network-trusted="${profile.trusted === true}">${profile.trusted === true ? 'Убрать доверие' : 'Доверять'}</button>
    </div>
  `, 'Профили сети не обнаружены.');
  const connections = Array.isArray(payload.connections) ? payload.connections : [];
  renderNetworkList(elements.securityNetworkConnections, connections.slice(0, 20), (item) => networkEventRow(item, true), 'Активных подключений нет.');
  const listeners = Array.isArray(payload.listeners) ? payload.listeners : [];
  renderNetworkList(elements.securityNetworkListeners, listeners.slice(0, 20), (item) => networkEventRow(item, false), 'Слушающие порты не обнаружены.');
  const history = Array.isArray(payload.history) ? payload.history : [];
  renderNetworkList(elements.securityNetworkHistory, history.slice(0, 20), (item) => `
    <div class="security-network-row compact"><span><strong>${escapeHtml(item.subject || item.kind || 'Наблюдение')}</strong><small>${escapeHtml(item.process_name || item.remote_domain || item.kind || '')}</small></span><time>${escapeHtml(formatSecurityTime(item.observed_at))}</time></div>
  `, 'История появится после работы фоновой защиты.');
  renderResponseActions();
}

function renderResponseActions() {
  const service = readSecurityPayload(state.security.responseServiceStatus) || {};
  if (elements.securityResponseService) {
    elements.securityResponseService.textContent = service.running === true
      ? `Исполнитель работает · активных правил ${readNumber(service.active_actions, 0)}`
      : service.integrity_ok === false
        ? 'Heartbeat исполнителя не прошёл проверку целостности'
        : 'Исполнитель не запущен · автоматические действия недоступны';
  }
  const payload = readSecurityPayload(state.security.responseActions) || {};
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  renderNetworkList(elements.securityResponseActions, actions.slice(0, 20), (item) => `
    <div class="security-network-row compact">
      <span><strong>${escapeHtml(localizeResponseAction(item.action))}</strong><small>${escapeHtml(responseActionDetails(item))}</small></span>
      <b class="security-action-state ${escapeHtml(item.status || 'failed')}">${escapeHtml(localizeResponseStatus(item.status))}</b>
    </div>
  `, service.running === true ? 'Активных ограничений нет.' : 'Исполнитель не запущен; правила не применяются.');
}

function localizeResponseAction(action) {
  return action === 'block_network' ? 'Временная блокировка сети' : String(action || 'Защитное действие');
}

function localizeResponseStatus(status) {
  return ({ pending: 'подготовка', active: 'активно', rolled_back: 'отменено', failed: 'ошибка' })[status] || String(status || 'неизвестно');
}

function responseActionDetails(item) {
  const scope = item?.scope && typeof item.scope === 'object' ? item.scope : {};
  const endpoint = scope.remote_address ? `${scope.remote_address}:${scope.remote_port || '—'}` : '';
  return [endpoint, item.expires_at ? `до ${formatSecurityTime(item.expires_at)}` : '', item.reason || ''].filter(Boolean).join(' · ');
}

function renderNetworkList(element, items, renderer, emptyText) {
  if (!element) return;
  element.innerHTML = items.length ? items.map(renderer).join('') : `<div class="security-list-empty">${escapeHtml(emptyText)}</div>`;
}

function networkEventRow(item, remote) {
  const facts = item?.facts && typeof item.facts === 'object' ? item.facts : {};
  const endpoint = remote
    ? `${facts.remote_domain || facts.remote_address || item.subject || '—'}${facts.remote_port ? `:${facts.remote_port}` : ''}`
    : `${facts.local_address || '—'}:${facts.local_port || '—'}`;
  return `<div class="security-network-row compact"><span><strong>${escapeHtml(endpoint)}</strong><small>${escapeHtml(facts.process_name || 'Системный процесс')}</small></span><b class="risk-${escapeHtml(riskTone(Math.min(800, Number(item.risk_score || 0) * 4)))}">${escapeHtml(item.risk_score || 0)}</b></div>`;
}

function renderQuarantine() {
  if (!elements.securityQuarantineList) return;
  if (elements.securityQuarantineRefresh) {
    elements.securityQuarantineRefresh.disabled = Boolean(state.security.quarantineBusy);
  }
  if (state.security.quarantineBusy && !state.security.quarantine) {
    elements.securityQuarantineList.innerHTML = '<div class="security-list-empty">Проверяем карантин...</div>';
    return;
  }
  const records = readSecurityQuarantine();
  if (!records.length) {
    elements.securityQuarantineList.innerHTML = `
      <div class="security-list-empty">
        <strong>Карантин пуст</strong>
        <span>Изолированные файлы появятся здесь с хешем и безопасным восстановлением.</span>
      </div>
    `;
    return;
  }
  elements.securityQuarantineList.innerHTML = records.map((record) => `
    <div class="security-quarantine-row">
      <span>
        <strong>${escapeHtml(securityPathName(record.original_path))}</strong>
        <small>${escapeHtml(record.original_path || '')}</small>
        <code>${escapeHtml(String(record.sha256 || '').slice(0, 16))}… · ${escapeHtml(formatSecurityBytes(record.size))}</code>
      </span>
      <button type="button" class="claude-ghost-btn" data-security-restore-id="${escapeHtml(record.quarantine_id || '')}">Восстановить</button>
    </div>
  `).join('');
}

function renderSecurityPin() {
  if (!elements.securityPinStatus) return;
  const payload = readSecurityPayload(state.security.pinStatus) || {};
  const configured = payload.configured === true;
  const locked = payload.locked === true;
  const recoveryLocked = payload.recovery_locked === true;
  const recoveryRemaining = readNumber(payload.recovery_codes_remaining, 0);
  elements.securityPinStatus.textContent = locked
    ? `Временно заблокирован · ${readNumber(payload.retry_after_seconds, 0)} сек.`
    : configured
      ? `Настроен · recovery-кодов: ${recoveryRemaining}`
      : 'Не настроен';
  if (elements.securityPinCurrentWrap) elements.securityPinCurrentWrap.hidden = !configured;
  if (elements.securityPinSave) {
    elements.securityPinSave.disabled = Boolean(state.security.pinBusy || locked);
    elements.securityPinSave.textContent = configured ? 'Сменить PIN' : 'Настроить PIN';
  }
  if (elements.securityPinRecover) {
    elements.securityPinRecover.disabled = Boolean(state.security.pinBusy || !configured || recoveryLocked || recoveryRemaining < 1);
  }
  if (elements.securityPinRecoveryCode) {
    elements.securityPinRecoveryCode.disabled = Boolean(state.security.pinBusy || !configured || recoveryLocked || recoveryRemaining < 1);
  }
  if (elements.securityPinRecoveryCodes) {
    const codes = Array.isArray(state.security.recoveryCodes) ? state.security.recoveryCodes : [];
    elements.securityPinRecoveryCodes.hidden = codes.length === 0;
    elements.securityPinRecoveryCodes.innerHTML = codes.length
      ? `<strong>Сохрани сейчас — повторно они не показываются</strong><small>${codes.map((code) => `<code>${escapeHtml(code)}</code>`).join('')}</small><span>${recoveryRemaining || codes.length} активных кодов после сохранения</span>`
      : '';
  }
  if (elements.securityPinRecoveryClear) {
    elements.securityPinRecoveryClear.hidden = !Array.isArray(state.security.recoveryCodes) || state.security.recoveryCodes.length === 0;
  }
  if (elements.securityPinFeedback) {
    elements.securityPinFeedback.textContent = state.security.pinFeedback || '';
  }
}

function readOneTimeRecoveryCodes(result) {
  const payload = readSecurityPayload(result);
  const codes = payload?.status?.recovery_codes;
  return Array.isArray(codes)
    ? codes.filter((code) => typeof code === 'string' && code.length <= 64).slice(0, 16)
    : [];
}

function setSecurityTab(tabId) {
  state.security.activeTab = ['overview', 'incidents', 'network', 'quarantine', 'settings'].includes(tabId)
    ? tabId
    : 'overview';
}

function renderSecurityTabs() {
  const activeTab = state.security.activeTab || 'overview';
  let activeTabButton = null;
  for (const tab of elements.securityTabs) {
    const selected = tab.dataset.securityTab === activeTab;
    tab.setAttribute('aria-selected', String(selected));
    if (selected) activeTabButton = tab;
  }
  for (const [panelId, panel] of Object.entries(elements.securityPanels)) {
    if (panel) panel.hidden = panelId !== activeTab;
  }
  keepSecurityTabVisible(activeTabButton);
}

function resetSecurityViewport(tab) {
  const view = tab?.closest?.('#security-section');
  if (view && !view.classList.contains('view-hidden')) {
    view.querySelector('.document-feed')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }
  keepSecurityTabVisible(tab);
}

function keepSecurityTabVisible(tab) {
  const tabList = tab?.parentElement;
  if (!tab || !tabList || tabList.scrollWidth <= tabList.clientWidth) return;
  const safeInset = 16;
  const tabStart = tab.offsetLeft;
  const tabEnd = tabStart + tab.offsetWidth;
  const visibleStart = tabList.scrollLeft + safeInset;
  const visibleEnd = tabList.scrollLeft + tabList.clientWidth - safeInset;
  if (tabStart < visibleStart) tabList.scrollTo({ left: Math.max(0, tabStart - safeInset), behavior: 'auto' });
  else if (tabEnd > visibleEnd) tabList.scrollTo({ left: tabEnd - tabList.clientWidth + safeInset, behavior: 'auto' });
}

function renderProtectionOverview() {
  if (!elements.securityProtectionTitle || !elements.securityProtectionCopy) return;
  const payload = readSecurityPayload(state.security.status)
    || readSecurityPayload(state.security.lastResult);
  const protectionState = readProtectionState(payload);
  const states = {
    protected: {
      title: 'Компьютер защищён',
      copy: 'Monarch наблюдает за системой и сообщит, если потребуется ваше решение.',
    },
    starting: {
      title: 'Защита запускается',
      copy: 'Подключаем локальные датчики и проверяем их готовность.',
    },
    degraded: {
      title: 'Защита работает частично',
      copy: 'Один или несколько датчиков требуют внимания. Подробности доступны ниже.',
    },
    attention_required: {
      title: 'Требуется внимание',
      copy: 'Monarch обнаружил проблему целостности или незавершённое решение.',
    },
    stopped: {
      title: 'Защита приостановлена',
      copy: 'Фоновое наблюдение выключено. Ручная проверка файлов остаётся доступной.',
    },
    loading: {
      title: 'Состояние защиты загружается',
      copy: 'Проверяем фоновые датчики и локальные политики.',
    },
  };
  const current = states[protectionState] || states.loading;
  elements.securityProtectionTitle.textContent = current.title;
  elements.securityProtectionCopy.textContent = current.copy;
}

function renderScanLab() {
  if (elements.securityScanFeedback) {
    const feedback = state.security.scanFeedback;
    if (!feedback) {
      elements.securityScanFeedback.innerHTML = '';
    } else {
      const tone = feedback.pending ? 'pending' : feedback.ok ? 'active' : 'failed';
      const score = Number.isFinite(feedback.score) ? ` · риск ${feedback.score}/800` : '';
      elements.securityScanFeedback.innerHTML = `
        <div class="security-scan-result ${escapeHtml(tone)}">
          <span><strong>${escapeHtml(feedback.pending ? 'Проверка выполняется' : feedback.ok ? 'Проверка завершена' : 'Проверка не выполнена')}</strong><small>${escapeHtml(feedback.summary || '')}${escapeHtml(score)}</small></span>
          ${!feedback.pending && feedback.ok && feedback.path && Number(feedback.score || 0) >= 250
            ? `<button type="button" class="claude-ghost-btn" data-security-isolate-path="${escapeHtml(feedback.path)}">Изолировать</button>`
            : ''}
        </div>
      `;
    }
  }

  const scans = Array.isArray(state.security.recentScans) ? state.security.recentScans : [];
  if (elements.securityRecentCount) elements.securityRecentCount.textContent = String(scans.length);
  if (!elements.securityRecentScans) return;
  if (!scans.length) {
    elements.securityRecentScans.innerHTML = `
      <div class="security-list-empty">
        <strong>Проверок пока нет</strong>
        <span>Выберите файл — результат останется только в текущей сессии.</span>
      </div>
    `;
    return;
  }
  elements.securityRecentScans.innerHTML = scans.slice(0, 5).map((scan) => `
    <div class="security-simple-row">
      <span>
        <strong>${escapeHtml(scan.name || securityPathName(scan.path))}</strong>
        <small>${escapeHtml(formatSecurityTime(scan.scannedAt))}</small>
      </span>
      <b class="risk-${escapeHtml(riskTone(scan.score))}">${escapeHtml(scan.score ? `${scan.score}/800` : 'чисто')}</b>
    </div>
  `).join('');
}

function renderIncidentWorkspace() {
  const incidents = readSecurityIncidents();
  const openIncidents = incidents.filter((incident) => !['resolved', 'dismissed'].includes(incident.status));
  const decisions = openIncidents.filter((incident) => incident.decision_required);
  if (elements.securityIncidentSummaryCount) {
    elements.securityIncidentSummaryCount.textContent = String(decisions.length);
  }
  if (elements.securityIncidentTabCount) {
    elements.securityIncidentTabCount.textContent = decisions.length ? String(decisions.length) : '';
  }
  if (elements.securityIncidentSummaryCopy) {
    elements.securityIncidentSummaryCopy.textContent = state.security.incidentsBusy
      ? 'Обновляем очередь решений'
      : decisions.length
        ? `${decisions.length} ${decisions.length === 1 ? 'решение ожидает' : 'решения ожидают'} вашего выбора`
        : 'Нет инцидентов, требующих вашего решения';
  }

  if (elements.securityIncidentList) {
    if (state.security.incidentsBusy && !incidents.length) {
      elements.securityIncidentList.innerHTML = '<div class="security-list-empty">Загружаем инциденты...</div>';
    } else if (!incidents.length) {
      elements.securityIncidentList.innerHTML = `
        <div class="security-list-empty">
          <strong>Инцидентов пока нет</strong>
          <span>События появятся здесь после детерминированной проверки.</span>
        </div>
      `;
    } else {
      elements.securityIncidentList.innerHTML = incidents.map((incident) => `
        <button type="button" class="security-incident-row ${incident.incident_id === state.security.selectedIncidentId ? 'selected' : ''}" data-security-incident-id="${escapeHtml(incident.incident_id || '')}">
          <b class="risk-${escapeHtml(riskTone(incident.risk_score))}">${escapeHtml(incident.risk_score || 0)}<small>/800</small></b>
          <span>
            <strong>${escapeHtml(localizeIncidentTitle(incident.title))}</strong>
            <small>${escapeHtml(incident.primary_subject || 'Неизвестный объект')}</small>
          </span>
          <time>${escapeHtml(formatSecurityTime(incident.updated_at))}</time>
        </button>
      `).join('');
      for (const row of elements.securityIncidentList.querySelectorAll('[data-security-incident-id]')) {
        row.addEventListener('click', () => {
          state.security.selectedIncidentId = row.dataset.securityIncidentId;
          renderIncidentWorkspace();
        });
      }
    }
  }

  if (!elements.securityIncidentDetail) return;
  const selected = incidents.find((incident) => incident.incident_id === state.security.selectedIncidentId)
    || incidents[0];
  if (!selected) {
    elements.securityIncidentDetail.innerHTML = `
      <div class="security-list-empty">
        <strong>Выберите инцидент</strong>
        <span>Здесь появятся доказательства и безопасные следующие шаги.</span>
      </div>
    `;
    return;
  }
  const evidence = Array.isArray(selected.evidence) ? selected.evidence : [];
  const actions = Array.isArray(selected.recommended_actions) ? selected.recommended_actions : [];
  const networkScope = networkResponseScope(selected);
  const responseService = readSecurityPayload(state.security.responseServiceStatus) || {};
  const pendingResponse = state.security.pendingResponse?.incidentId === selected.incident_id
    ? state.security.pendingResponse : null;
  elements.securityIncidentDetail.innerHTML = `
    <header>
      <span>
        <small>${escapeHtml(riskLabel(selected.risk_score))}</small>
        <strong>${escapeHtml(localizeIncidentTitle(selected.title))}</strong>
      </span>
      <b class="risk-${escapeHtml(riskTone(selected.risk_score))}">${escapeHtml(selected.risk_score || 0)} / 800</b>
    </header>
    <p>${escapeHtml(incidentExplanation(selected))}</p>
    ${renderAttackChain(selected)}
    <div class="security-evidence-list">
      ${evidence.slice(-6).map((item) => `
        <div>
          <span><strong>${escapeHtml(localizeEvidenceFamily(item.family))}</strong><small>${escapeHtml(item.kind || '')}</small></span>
          <time>${escapeHtml(formatSecurityTime(item.observed_at))}</time>
        </div>
      `).join('') || '<div class="security-list-empty">Доказательства ещё не загружены.</div>'}
    </div>
    <div class="security-recommendations">
      <strong>Безопасные следующие шаги</strong>
      <div>${actions.map((action) => `<span>${escapeHtml(localizeRecommendation(action))}</span>`).join('') || '<span>Продолжить наблюдение</span>'}</div>
    </div>
    ${actions.includes('block_network') && networkScope ? `
      <section class="security-containment-card">
        <span><strong>Временная сетевая изоляция</strong><small>${escapeHtml(networkScope.remote_address)}:${escapeHtml(networkScope.remote_port)} · максимум 15 минут · автоматический откат</small></span>
        ${responseService.running !== true ? `
          <button type="button" class="claude-ghost-btn" disabled>Исполнитель не запущен</button>
        ` : pendingResponse ? `
          <label><span>Security PIN</span><input type="password" inputmode="numeric" maxlength="6" autocomplete="off" data-security-response-pin></label>
          <button type="button" class="claude-primary-btn" data-security-approve-response="${escapeHtml(pendingResponse.proposalId)}">Подтвердить блокировку</button>
        ` : `
          <button type="button" class="claude-ghost-btn" data-security-propose-network="${escapeHtml(selected.incident_id || '')}">Подготовить блокировку</button>
        `}
        <small class="security-response-feedback">${escapeHtml(state.security.responseFeedback || '')}</small>
      </section>
    ` : ''}
    ${['open', 'acknowledged'].includes(selected.status) ? `
      <div class="security-incident-actions">
        ${selected.status === 'open' ? `<button type="button" class="claude-ghost-btn" data-security-incident-status="acknowledged" data-security-incident-id="${escapeHtml(selected.incident_id || '')}">Я увидел</button>` : ''}
        <button type="button" class="claude-ghost-btn" data-security-incident-status="dismissed" data-security-incident-id="${escapeHtml(selected.incident_id || '')}">Событие безопасно</button>
      </div>
    ` : `
      <div class="security-incident-resolution">Инцидент закрыт: ${escapeHtml(selected.resolution?.reason || selected.status || '')}</div>
    `}
    <details class="security-technical-details">
      <summary>Технические детали</summary>
      <dl>
        <div><dt>ID</dt><dd>${escapeHtml(selected.incident_id || '')}</dd></div>
        <div><dt>Объект</dt><dd>${escapeHtml(selected.primary_subject || '')}</dd></div>
        <div><dt>Источники</dt><dd>${escapeHtml((selected.evidence_families || []).join(', '))}</dd></div>
      </dl>
    </details>
  `;
}

function renderAttackChain(incident) {
  const graph = incident?.attack_chain && typeof incident.attack_chain === 'object' ? incident.attack_chain : null;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.slice(0, 12) : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges.slice(0, 24) : [];
  if (nodes.length < 2 || edges.length < 1) return '';
  const connectedIds = new Set(edges.flatMap((edge) => [edge?.from, edge?.to]).filter(Boolean));
  const connected = nodes.filter((node) => connectedIds.has(node?.id));
  if (connected.length < 2) return '';
  const relations = new Map(edges.map((edge) => [`${edge?.from}:${edge?.to}`, edge?.relation]));
  return `
    <section class="security-attack-chain" aria-label="Цепочка атаки">
      <header>
        <span><strong>Цепочка атаки</strong><small>${graph.corroborated ? 'Связь подтверждена независимыми датчиками' : 'Связанные детерминированные наблюдения'}</small></span>
        <em>не меняет риск</em>
      </header>
      <div class="security-attack-chain-flow">
        ${connected.map((node, index) => {
          const next = connected[index + 1];
          const relation = next ? relations.get(`${node.id}:${next.id}`) : null;
          return `
            <article class="security-chain-node risk-${escapeHtml(riskTone(Number(node.score || 0) * 4))}">
              <small>${escapeHtml(localizeEvidenceFamily(node.family))}</small>
              <strong>${escapeHtml(node.kind || 'observation')}</strong>
              <span>${escapeHtml(node.label || '')}</span>
            </article>
            ${next ? `<div class="security-chain-edge" title="${escapeHtml(localizeChainRelation(relation))}"><b>${relation ? '→' : '⋯'}</b><small>${escapeHtml(localizeChainRelation(relation))}</small></div>` : ''}
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function localizeChainRelation(relation) {
  return {
    shared_process: 'тот же процесс',
    shared_file: 'тот же файл',
    shared_endpoint: 'тот же endpoint',
    shared_entity: 'общий объект',
  }[relation] || 'связь через другой сигнал';
}

function networkResponseScope(incident) {
  const evidence = Array.isArray(incident?.evidence) ? [...incident.evidence].reverse() : [];
  for (const item of evidence) {
    const scope = item?.response_scope && typeof item.response_scope === 'object' ? item.response_scope : {};
    if (scope.remote_address && Number(scope.remote_port) >= 1 && Number(scope.remote_port) <= 65535) {
      return {
        remote_address: String(scope.remote_address),
        remote_port: Number(scope.remote_port),
        protocol: ['tcp', 'udp'].includes(String(scope.protocol || '').toLowerCase()) ? String(scope.protocol).toLowerCase() : 'tcp',
        direction: ['inbound', 'outbound'].includes(String(scope.direction || '').toLowerCase()) ? String(scope.direction).toLowerCase() : 'outbound',
      };
    }
  }
  return null;
}

function renderSecurityPills() {
  if (!elements.securityStatusPills) return;
  const statusPayload = readSecurityPayload(state.security.status);
  const lastPayload = readSecurityPayload(state.security.lastResult);
  const payload = statusPayload || lastPayload;

  if (state.security.statusBusy && !payload) {
    elements.securityStatusPills.innerHTML = statusPill('Security проверяется', 'amber');
    return;
  }

  if (state.security.error) {
    elements.securityStatusPills.innerHTML = statusPill('Security ошибка', 'red');
    return;
  }

  if (!payload) {
    elements.securityStatusPills.innerHTML = statusPill('Security ожидает', 'amber');
    return;
  }

  const protectionState = readProtectionState(payload);
  const sensors = readSensorCoverage(payload);
  const incidents = readIncidentSummary(payload);
  const stateTone = ['protected'].includes(protectionState)
    ? 'green'
    : ['degraded', 'attention_required'].includes(protectionState)
      ? 'red'
      : 'amber';
  elements.securityStatusPills.innerHTML = [
    statusPill(
      sensors.total
        ? `${sensors.active} из ${sensors.total} областей под наблюдением`
        : protectionState === 'stopped'
          ? 'наблюдение выключено'
          : 'датчики подключаются',
      stateTone
    ),
    incidents.decisionRequired
      ? statusPill(`${incidents.decisionRequired} требует решения`, 'amber')
      : statusPill('решений не требуется', 'green'),
  ].join('');
}

function renderSecuritySummary() {
  if (!elements.securitySummary) return;
  const result = state.security.lastResult || state.security.status;
  const payload = readSecurityPayload(result);

  if (state.security.error && (!result || !payload)) {
    elements.securitySummary.innerHTML = renderError(state.security.error);
    return;
  }

  if (!result || !payload) {
    elements.securitySummary.innerHTML = `
      <div class="security-result-card">
        <div class="empty-state">Security status ещё не загружен.</div>
      </div>
    `;
    return;
  }

  const counts = readSecurityCounts(payload);
  const guard = readAgentGuard(payload);
  const command = Array.isArray(result.output?.command)
    ? result.output.command.join(' ')
    : 'security.status';
  const summary = formatSecuritySummary(result.summary, payload);
  elements.securitySummary.innerHTML = `
    <div class="security-result-card">
      <div class="security-result-head">
        <strong>${escapeHtml(summary)}</strong>
        <span class="status-text ${result.ok ? 'active' : 'failed'}">${result.ok ? 'ok' : 'сбой'}</span>
      </div>
      <p class="security-command-line">${escapeHtml(command)}</p>
      <div class="security-action-strip">
        <span>Последнее сканирование: ${escapeHtml(counts.events ? `${counts.events} событий` : 'не загружено')}</span>
        <span>Известно-хорошее состояние: базовый уровень готов</span>
        <span>Предпросмотр лога: ${escapeHtml(counts.records ? `${counts.records} записей` : 'ожидание')}</span>
        <span>Agent Guard: ${escapeHtml(guard.checks ? `${guard.checks} действий проверено` : 'готов к первой проверке')}</span>
      </div>
      <div class="metric-grid">
        ${metricCard(counts.events, 'событий')}
        ${metricCard(counts.high, 'high+')}
        ${metricCard(counts.scanned, 'проверено')}
        ${metricCard(counts.records, 'строк аудита')}
        ${metricCard(guard.checks, 'проверок агента')}
        ${metricCard(guard.approvals, 'подтверждений')}
        ${metricCard(guard.blocked, 'блокировок')}
      </div>
    </div>
  `;
}

function formatSecuritySummary(summary, payload) {
  const raw = String(summary || '').trim();
  const normalized = raw.toLowerCase();
  const running = readProtectionRunning(payload) === true;
  const known = new Map([
    ['monarch security background protection is stopped.', 'Фоновая защита Monarch Security остановлена.'],
    ['monarch security background protection is running.', 'Фоновая защита Monarch Security активна.'],
    ['security command completed.', 'Security команда выполнена.'],
  ]);
  if (known.has(normalized)) return known.get(normalized);
  if (raw) return raw;
  return running
    ? 'Фоновая защита Monarch Security активна.'
    : 'Фоновая защита Monarch Security остановлена.';
}

function renderSecurityFindings() {
  if (!elements.securityFindings) return;
  const payload = readSecurityPayload(state.security.lastResult);
  const findings = Array.isArray(payload?.top_findings) ? payload.top_findings : [];

  if (!findings.length) {
    elements.securityFindings.innerHTML = `
      <div class="security-findings-card">
        <div class="row-main">
          <strong>Находки</strong>
          <span class="status-text active">тихо</span>
        </div>
        <div class="empty-state">Высоких угроз в последнем результате не найдено.</div>
      </div>
    `;
    return;
  }

  elements.securityFindings.innerHTML = `
    <div class="security-findings-card">
      <div class="row-main">
        <strong>Разбор угроз</strong>
        <span class="status-text ${findings.length ? 'pending' : 'active'}">${findings.length} к проверке</span>
      </div>
      <div class="security-finding-list">
        ${renderGroupedFindings(findings)}
      </div>
    </div>
  `;
}

function renderGroupedFindings(findings) {
  const groups = new Map();
  for (const finding of findings.slice(0, 8)) {
    const severity = String(finding?.severity || finding?.level || 'info').toLowerCase();
    const list = groups.get(severity) || [];
    list.push(finding);
    groups.set(severity, list);
  }

  return Array.from(groups.entries()).map(([severity, entries]) => `
    <div class="security-finding-group">
      <div class="security-finding-group-title">
        <span class="severity-badge ${escapeHtml(severity)}">${escapeHtml(severity)}</span>
        <span>${entries.length} ${entries.length === 1 ? 'элемент' : 'элементов'}</span>
      </div>
      ${entries.map(renderSecurityFinding).join('')}
    </div>
  `).join('');
}

function renderSecurityFinding(finding) {
  const severity = String(finding?.severity || finding?.level || 'info').toLowerCase();
  const title = finding?.subject || finding?.title || finding?.kind || finding?.rule || 'finding';
  const reasons = Array.isArray(finding?.reasons) ? finding.reasons.join(' · ') : '';
  const detail = reasons || finding?.message || finding?.path || finding?.description || finding?.summary || finding?.source || '';
  return `
    <div class="security-finding-row">
      <span class="severity-badge ${escapeHtml(severity)}">${escapeHtml(severity)}</span>
      <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
      <p>${escapeHtml(detail)}</p>
    </div>
  `;
}

function renderSecurityRuntime() {
  if (!elements.securityRuntime || !elements.securityRuntimeLabel) return;
  const statusPayload = readSecurityPayload(state.security.status);
  const lastPayload = readSecurityPayload(state.security.lastResult);
  const preferLastResult = state.security.lastResult?.ok === false && lastPayload;
  const payload = preferLastResult ? lastPayload : statusPayload || lastPayload;
  const metadataSource = preferLastResult || !statusPayload ? state.security.lastResult : state.security.status;
  const metadata = metadataSource?.metadata || {};

  if (state.security.statusBusy && !payload) {
    elements.securityRuntimeLabel.textContent = 'проверка';
    elements.securityRuntimeLabel.className = 'status-text pending';
    elements.securityRuntime.innerHTML = '<div class="empty-state">Проверяю встроенный security runtime...</div>';
    return;
  }

  if (!payload) {
    elements.securityRuntimeLabel.textContent = state.security.error ? 'сбой' : 'ожидание';
    elements.securityRuntimeLabel.className = `status-text ${state.security.error ? 'failed' : 'pending'}`;
    elements.securityRuntime.innerHTML = state.security.error
      ? renderError(state.security.error)
      : '<div class="empty-state">Runtime status пока пустой.</div>';
    return;
  }

  const running = readProtectionRunning(payload) === true;
  const guard = readAgentGuard(payload);
  elements.securityRuntimeLabel.textContent = preferLastResult ? 'сбой' : running ? 'работает' : 'остановлен';
  elements.securityRuntimeLabel.className = `status-text ${preferLastResult ? 'failed' : running ? 'active' : 'pending'}`;
  elements.securityRuntime.innerHTML = `
    <div class="key-value-list">
      ${keyValueRow('PID', payload.pid || 'нет')}
      ${payload.launch_pid ? keyValueRow('Launch PID', payload.launch_pid) : ''}
      ${keyValueRow('Пульс', payload.heartbeat_stale ? 'устарел' : payload.heartbeat ? 'активен' : 'нет')}
      ${payload.reason ? keyValueRow('Причина', payload.reason) : ''}
      ${payload.log_path ? keyValueRow('Лог запуска', payload.log_path) : ''}
      ${keyValueRow('Журнал', payload.audit_log_path || metadata.configPath || 'неизвестно')}
      ${keyValueRow('Agent Guard', `${guard.checks} проверок · ${guard.blocked} блокировок`)}
      ${keyValueRow('Последнее решение', guard.lastStatus || 'ещё не проверял')}
      ${keyValueRow('Корень', metadata.projectRoot || 'безопасность')}
    </div>
  `;
}

function renderSecurityAudit() {
  if (!elements.securityAuditLabel || !elements.securityAuditOutput) return;
  const payload = readSecurityPayload(state.security.audit);
  const records = Array.isArray(payload?.records) ? payload.records : [];

  if (!state.security.audit) {
    elements.securityAuditLabel.textContent = 'ожидание';
    elements.securityAuditLabel.className = 'status-text pending';
    elements.securityAuditOutput.innerHTML = '<div class="empty-state">Нажмите "Журнал аудита", чтобы прочитать последние записи.</div>';
    return;
  }

  elements.securityAuditLabel.textContent = `${records.length} строк`;
  elements.securityAuditLabel.className = records.length ? 'status-text active' : 'status-text pending';
  elements.securityAuditOutput.innerHTML = records.length
    ? `<pre class="audit-output">${escapeHtml(records.slice(-12).map((record) => JSON.stringify(record)).join('\n'))}</pre>`
    : '<div class="empty-state">Журнал аудита пуст или ещё не создан.</div>';
}

function readSecurityPayload(result) {
  const payload = result?.output?.payload;
  return payload && typeof payload === 'object' ? payload : null;
}

function readSecurityRunningState() {
  const statusRunning = readProtectionRunning(readSecurityPayload(state.security.status));
  if (statusRunning !== null) {
    return statusRunning;
  }
  return readProtectionRunning(readSecurityPayload(state.security.lastResult)) === true;
}

function readProtectionRunning(payload) {
  const value = payload?.runtime?.running ?? payload?.running;
  return typeof value === 'boolean' ? value : null;
}

function readProtectionState(payload) {
  if (!payload) return state.security.statusBusy ? 'loading' : 'stopped';
  const explicit = payload?.runtime?.protection_state ?? payload?.protection_state;
  if (typeof explicit === 'string' && explicit) return explicit;
  if (payload?.heartbeat_stale) return 'degraded';
  return readProtectionRunning(payload) === true ? 'protected' : 'stopped';
}

function readSensorCoverage(payload) {
  const sensors = Array.isArray(payload?.heartbeat?.sensors)
    ? payload.heartbeat.sensors
    : Array.isArray(payload?.runtime?.heartbeat?.sensors)
      ? payload.runtime.heartbeat.sensors
      : [];
  const total = readNumber(
    payload?.heartbeat?.sensor_count,
    readNumber(payload?.runtime?.heartbeat?.sensor_count, sensors.length)
  );
  return {
    active: readProtectionRunning(payload) === true ? total : 0,
    total,
  };
}

function readIncidentSummary(payload) {
  const summary = payload?.incidents && typeof payload.incidents === 'object'
    ? payload.incidents
    : payload?.runtime?.incidents && typeof payload.runtime.incidents === 'object'
      ? payload.runtime.incidents
      : {};
  return {
    open: readNumber(summary.open, 0),
    decisionRequired: readNumber(summary.decision_required, 0),
    emergency: readNumber(summary.emergency, 0),
    highestRisk: readNumber(summary.highest_risk, 0),
  };
}

function readSecurityIncidents() {
  const payload = readSecurityPayload(state.security.incidents);
  return Array.isArray(payload?.incidents) ? payload.incidents : [];
}

function readSecurityQuarantine() {
  const payload = readSecurityPayload(state.security.quarantine);
  return Array.isArray(payload?.records) ? payload.records : [];
}

function formatSecurityBytes(value) {
  const bytes = Math.max(0, readNumber(value, 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function securityPathName(value) {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'Файл';
}

function formatSecurityTime(value) {
  if (!value) return 'только что';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function riskTone(score) {
  const value = readNumber(score, 0);
  if (value >= 700) return 'emergency';
  if (value >= 550) return 'critical';
  if (value >= 400) return 'high';
  if (value >= 250) return 'suspicious';
  if (value >= 100) return 'guarded';
  return 'clean';
}

function riskLabel(score) {
  return {
    emergency: 'Экстренный риск',
    critical: 'Критический риск',
    high: 'Высокий риск',
    suspicious: 'Подозрительная активность',
    guarded: 'Нужна дополнительная проверка',
    clean: 'Низкий риск',
  }[riskTone(score)];
}

function localizeIncidentTitle(value) {
  const title = String(value || '').trim();
  const known = {
    'Suspicious process with network activity': 'Подозрительный процесс вышел в сеть',
    'Suspicious file established persistence': 'Файл закрепился в автозапуске',
    'Suspicious file detected': 'Обнаружен подозрительный файл',
    'Suspicious process detected': 'Обнаружен подозрительный процесс',
    'Suspicious network activity': 'Подозрительная сетевая активность',
    'Unexpected persistence change': 'Неожиданное изменение автозапуска',
    'Security protection changed': 'Изменились настройки защиты',
    'Untrusted device connected': 'Подключено неизвестное устройство',
    'New software requires review': 'Новое приложение требует проверки',
  };
  return known[title] || title || 'Инцидент безопасности';
}

function localizeEvidenceFamily(value) {
  return {
    file: 'Файл',
    process: 'Процесс',
    network: 'Сеть',
    persistence: 'Автозапуск',
    posture: 'Защита Windows',
    device: 'Устройство',
    software: 'Приложение',
  }[String(value || '').toLowerCase()] || 'Событие';
}

function localizeRecommendation(value) {
  return {
    preserve: 'Сохранить доказательства',
    deep_scan: 'Запустить глубокую проверку',
    isolate: 'Предложить изоляцию',
    block_network: 'Предложить блокировку сети',
    suspend_process: 'Предложить приостановку процесса',
  }[String(value || '').toLowerCase()] || String(value || 'Продолжить наблюдение');
}

function incidentExplanation(incident) {
  const families = Array.isArray(incident.evidence_families) ? incident.evidence_families : [];
  if (families.includes('process') && families.includes('network')) {
    return 'Monarch связал запуск процесса с его сетевой активностью. Проверьте происхождение программы до принятия решения.';
  }
  if (families.includes('file')) {
    return 'Файл получил сигналы риска от локальных проверок. Не запускайте его, пока происхождение и подпись не подтверждены.';
  }
  return 'Несколько локальных сигналов объединены в один инцидент. Система продолжает наблюдение без автоматических разрушительных действий.';
}

function readErrorExecutionResult(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const result = error.result;
  return result && typeof result === 'object' ? result : null;
}

function readSecurityCounts(payload) {
  const summary = payload?.summary && typeof payload.summary === 'object'
    ? payload.summary
    : {};
  const records = Array.isArray(payload?.records) ? payload.records.length : 0;
  return {
    events: readNumber(summary.events, readNumber(payload?.events, 0)),
    high: readNumber(summary.high_or_higher, 0),
    scanned: readNumber(payload?.scanned, 0),
    records,
  };
}

function readAgentGuard(payload) {
  const guard = payload?.agentGuard && typeof payload.agentGuard === 'object'
    ? payload.agentGuard
    : {};
  return {
    checks: readNumber(guard.checks, 0),
    approvals: readNumber(guard.approvals, 0),
    blocked: readNumber(guard.blocked, 0),
    lastStatus: typeof guard.lastStatus === 'string' ? guard.lastStatus : '',
  };
}
