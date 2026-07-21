const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monarchSafeAuthorization', {
  onPrompt: (listener) => {
    if (typeof listener !== 'function') return;
    ipcRenderer.once('monarch-safe:authorization-prompt', (_event, prompt) => listener(prompt || {}));
  },
  respond: (confirmed) => ipcRenderer.send('monarch-safe:authorization-response', confirmed === true),
});
