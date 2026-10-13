// Explicit isolated BrowserWindow only. Ordinary preload/main do NOT import this.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('monarchDesktop', Object.freeze({
  getMutationAttestation: () => ipcRenderer.invoke('monarch:astra-desktop-attestation'),
}));
contextBridge.exposeInMainWorld('monarchAstraDesktop', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('monarch:astra-desktop-bootstrap'),
  pickTarget: request => ipcRenderer.invoke('monarch:astra-pick-target', request),
  pickWindow: request => ipcRenderer.invoke('monarch:astra-pick-window', request),
  windowSelections: request => ipcRenderer.invoke('monarch:astra-window-selections', request),
  issueComputerAction: request => ipcRenderer.invoke('monarch:astra-issue-computer-action', request),
  computerActionPlans: request => ipcRenderer.invoke('monarch:astra-computer-action-plans', request),
  savePending: (id, source) => ipcRenderer.invoke('monarch:astra-desktop-state', { version: 1, kind: 'pending', id, ...(source ? { source } : {}) }),
  saveLinked: (id, source) => ipcRenderer.invoke('monarch:astra-desktop-state', { version: 1, kind: 'linked', id, ...(source ? { source } : {}) }),
  clearPending: (id, source) => ipcRenderer.invoke('monarch:astra-desktop-state', { version: 1, kind: 'clear', id, ...(source ? { source } : {}) }),
  conversations: request => ipcRenderer.invoke('monarch:astra-conversations', request),
}));
