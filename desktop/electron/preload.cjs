const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('monarchDesktop', {
  windowControlsOverlay: process.platform === 'win32',
  setTheme: theme => ipcRenderer.invoke('monarch:set-theme', theme),
  getRuntimeUrl: () => ipcRenderer.invoke('monarch:get-runtime-url'),
  telegram: Object.freeze({
    configure: input => ipcRenderer.invoke('monarch:telegram-configure', input),
    configureCloud: input => ipcRenderer.invoke('monarch:telegram-cloud-configure', input),
    inspectPersonalCloud: () => ipcRenderer.invoke('monarch:telegram-cloud-inspect'),
    provisionPersonalCloud: input => ipcRenderer.invoke('monarch:telegram-cloud-provision', input),
    status: role => ipcRenderer.invoke('monarch:telegram-credentials-status', role),
  }),
  integrations: Object.freeze({
    status: serviceId => ipcRenderer.invoke('monarch:integration-status', serviceId),
    connect: (serviceId, input) => ipcRenderer.invoke('monarch:integration-connect', { serviceId, input }),
    disconnect: serviceId => ipcRenderer.invoke('monarch:integration-disconnect', { serviceId, confirmed: true }),
  }),
  getMutationAttestation: () => ipcRenderer.invoke('monarch:get-desktop-attestation'),
  getAppInfo: () => ipcRenderer.invoke('monarch:get-app-info'),
  astraPilot: Object.freeze({
    pickTarget: (request) => ipcRenderer.invoke('monarch:astra-product-pick-target', request),
    pickTelegramTarget: (request) => ipcRenderer.invoke('monarch:astra-product-pick-telegram-target', request),
    pickWindow: (request) => ipcRenderer.invoke('monarch:astra-product-pick-window', request),
    issueComputerAction: (request) => ipcRenderer.invoke('monarch:astra-product-issue-computer-action', request),
    windowSelections: (request) => ipcRenderer.invoke('monarch:astra-product-window-selections', request),
    computerActionPlans: (request) => ipcRenderer.invoke('monarch:astra-product-computer-action-plans', request),
  }),
  astraMax: Object.freeze({
    providers: () => ipcRenderer.invoke('monarch:astra-max-providers'),
    listProviderModels: request => ipcRenderer.invoke('monarch:astra-max-models', request),
    listStoredProviderModels: id => ipcRenderer.invoke('monarch:astra-max-stored-models', id),
    selectProvider: id => ipcRenderer.invoke('monarch:astra-max-select-provider', id),
    configureProvider: request => ipcRenderer.invoke('monarch:astra-max-configure-provider', request),
    updateProviderModel: request => ipcRenderer.invoke('monarch:astra-max-update-model', request),
    setReasoningEffort: value => ipcRenderer.invoke('monarch:astra-max-reasoning-effort', value),
    verifyProvider: id => ipcRenderer.invoke('monarch:astra-max-verify-provider', id),
    verify: () => ipcRenderer.invoke('monarch:astra-max-verify'),
    status: () => ipcRenderer.invoke('monarch:astra-max-status'),
    configure: (request) => ipcRenderer.invoke('monarch:astra-max-configure', request),
  }),
  updateVoiceOverlay: (value) => ipcRenderer.invoke('monarch:voice-overlay-update', value),
  updateVoiceWakeState: (value) => ipcRenderer.invoke('monarch:voice-wake-state', value),
  reminders: Object.freeze({
    changed: () => ipcRenderer.invoke('monarch:reminders-changed'),
    onDelivered: (listener) => {
      if (typeof listener !== 'function') return () => {};
      const handler = (_event, value) => listener(value);
      ipcRenderer.on('monarch:reminder-delivered', handler);
      return () => ipcRenderer.removeListener('monarch:reminder-delivered', handler);
    },
    onOpen: (listener) => {
      if (typeof listener !== 'function') return () => {};
      const handler = (_event, value) => listener(value);
      ipcRenderer.on('monarch:reminder-open', handler);
      return () => ipcRenderer.removeListener('monarch:reminder-open', handler);
    },
  }),
  onComputerUseEmergencyStop: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('monarch:computer-use-emergency-stop', handler);
    return () => ipcRenderer.removeListener('monarch:computer-use-emergency-stop', handler);
  },
  copyText: (value) => ipcRenderer.invoke('monarch:copy-text', value),
  pickRedZoneFolder: () => ipcRenderer.invoke('monarch:pick-red-zone-folder'),
  pickModelFile: () => ipcRenderer.invoke('monarch:pick-model-file'),
  pathForDroppedFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  openModelsFolder: () => ipcRenderer.invoke('monarch:open-models-folder'),
  openImageProvider: (value) => ipcRenderer.invoke('monarch:open-image-provider', value),
  showEmbeddedImageProvider: (value) => ipcRenderer.invoke('monarch:show-embedded-image-provider', value),
  updateEmbeddedImageProviderBounds: (value) => ipcRenderer.invoke('monarch:update-embedded-image-provider-bounds', value),
  hideEmbeddedImageProvider: () => ipcRenderer.invoke('monarch:hide-embedded-image-provider'),
  navigateEmbeddedImageProvider: (action) => ipcRenderer.invoke('monarch:navigate-embedded-image-provider', action),
  closeImageProvider: () => ipcRenderer.invoke('monarch:close-image-provider'),
  onImageProviderState: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('monarch:image-provider-state', handler);
    return () => ipcRenderer.removeListener('monarch:image-provider-state', handler);
  },
  onImageProviderDownload: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('monarch:image-provider-download', handler);
    return () => ipcRenderer.removeListener('monarch:image-provider-download', handler);
  },
  warmSpeechOutput: (value = {}) => ipcRenderer.invoke('monarch:speech-warmup', { retry: value?.retry === true }),
  getSpeechDiagnostics: () => ipcRenderer.invoke('monarch:speech-diagnostics'),
  openLogs: () => ipcRenderer.invoke('monarch:open-logs'),
  reportBug: (value = {}) => ipcRenderer.invoke('monarch:report-bug', {
    description: String(value?.description || ''),
    context: String(value?.context || ''),
    version: String(value?.version || ''),
    via: value?.via === 'gmail' ? 'gmail' : 'mail',
  }),
  getSpeechCapabilities: () => ipcRenderer.invoke('monarch:speech-capabilities'),
  getOwnerEnrollmentStatus: () => ipcRenderer.invoke('monarch:owner-enrollment-status'),
  createOwnerDeviceRequest: () => ipcRenderer.invoke('monarch:owner-device-request-create'),
  exportOwnerDeviceRequest: () => ipcRenderer.invoke('monarch:owner-device-request-export'),
  importOwnerEntitlement: () => ipcRenderer.invoke('monarch:owner-entitlement-import'),
  restartForOwnerEnrollment: () => ipcRenderer.invoke('monarch:owner-enrollment-restart'),
  disableOwnerMode: () => ipcRenderer.invoke('monarch:owner-mode-set-suspended', true),
  enableOwnerMode: () => ipcRenderer.invoke('monarch:owner-mode-set-suspended', false),
  speakText: (value) => ipcRenderer.invoke('monarch:speech-speak', value),
  stopSpeaking: () => ipcRenderer.invoke('monarch:speech-stop'),
  releaseSpeechOutput: () => ipcRenderer.invoke('monarch:speech-release'),
  onSpeechTelemetry: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('monarch:speech-telemetry', handler);
    return () => ipcRenderer.removeListener('monarch:speech-telemetry', handler);
  },
  copySharingToken: () => ipcRenderer.invoke('monarch:copy-sharing-token'),
  pickSecurityFile: () => ipcRenderer.invoke('monarch:pick-security-file'),
  pickCoderFolder: (purpose) => ipcRenderer.invoke('monarch:pick-coder-folder', purpose === 'telegram' ? 'telegram' : 'coder'),
  openSafe: () => ipcRenderer.invoke('monarch:open-safe'),
  openSafeSettings: () => ipcRenderer.invoke('monarch:open-safe-settings'),
  profileKey: Object.freeze({
    status: () => ipcRenderer.invoke('monarch:profile-key-status'),
    createRecoveryCode: () => ipcRenderer.invoke('monarch:profile-key-create-code'),
    recover: (method, code) => ipcRenderer.invoke('monarch:profile-key-recover',
      { method: method === 'code' ? 'code' : 'safe', ...(method === 'code' ? { code: String(code || '') } : {}) }),
  }),
  getSafeShortcutStatus: () => ipcRenderer.invoke('monarch:safe-shortcut-status'),
  createSafeShortcut: () => ipcRenderer.invoke('monarch:safe-shortcut-create'),
  removeSafeShortcut: () => ipcRenderer.invoke('monarch:safe-shortcut-remove'),
  getSafeChatStatus: () => ipcRenderer.invoke('monarch:safe-chat-status'),
  listSafeChats: () => ipcRenderer.invoke('monarch:safe-chat-list'),
  readSafeChat: (id, kind = 'oscar') => ipcRenderer.invoke('monarch:safe-chat-read', { id, kind }),
  writeSafeChat: (record) => ipcRenderer.invoke('monarch:safe-chat-upsert', { record }),
  deleteSafeChat: (id, kind = 'oscar') => ipcRenderer.invoke('monarch:safe-chat-delete', { id, kind }),
  lockSafeChats: () => ipcRenderer.invoke('monarch:safe-chat-lock'),
  updates: Object.freeze({
    check: () => ipcRenderer.invoke('monarch:update-intent', 'check'),
    download: () => ipcRenderer.invoke('monarch:update-intent', 'download'),
    install: () => ipcRenderer.invoke('monarch:update-intent', 'install'),
    pause: () => ipcRenderer.invoke('monarch:update-intent', 'pause'),
    resume: () => ipcRenderer.invoke('monarch:update-intent', 'resume'),
    cancel: () => ipcRenderer.invoke('monarch:update-intent', 'cancel'),
    discard: () => ipcRenderer.invoke('monarch:update-intent', 'discard'),
    getState: () => ipcRenderer.invoke('monarch:update-state'),
    onStateChanged: (listener) => {
      if (typeof listener !== 'function') return () => {};
      const handler = (_event, value) => listener(value);
      ipcRenderer.on('monarch:update-state-changed', handler);
      return () => ipcRenderer.removeListener('monarch:update-state-changed', handler);
    },
  }),
  onSafeChatStatus: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('monarch:safe-chat-status-changed', handler);
    return () => ipcRenderer.removeListener('monarch:safe-chat-status-changed', handler);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
