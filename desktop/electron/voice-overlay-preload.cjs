const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monarchVoiceOverlay', Object.freeze({
  onState(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('monarch:voice-overlay-state', handler);
    return () => ipcRenderer.removeListener('monarch:voice-overlay-state', handler);
  },
}));
