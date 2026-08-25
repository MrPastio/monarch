import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('monarchDesktop', {
  getRuntimeUrl: () => ipcRenderer.invoke('monarch:get-runtime-url'),
  getMutationAttestation: () => ipcRenderer.invoke('monarch:get-desktop-attestation'),
  getAppInfo: () => ipcRenderer.invoke('monarch:get-app-info'),
  onComputerUseEmergencyStop: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('monarch:computer-use-emergency-stop', handler);
    return () => ipcRenderer.removeListener('monarch:computer-use-emergency-stop', handler);
  },
  copyText: (value) => ipcRenderer.invoke('monarch:copy-text', value),
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
  pickCoderFolder: () => ipcRenderer.invoke('monarch:pick-coder-folder'),
  openSafe: () => ipcRenderer.invoke('monarch:open-safe'),
  openSafeSettings: () => ipcRenderer.invoke('monarch:open-safe-settings'),
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
