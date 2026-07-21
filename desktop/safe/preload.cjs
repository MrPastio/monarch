const { contextBridge, ipcRenderer } = require('electron');

let port = null;
let requestSequence = 0;
let readyResolve;
const ready = new Promise((resolve) => { readyResolve = resolve; });
const pending = new Map();
const listeners = new Set();
const settingsListeners = new Set();

ipcRenderer.on('monarch-safe:connect', (event) => {
  const nextPort = event.ports?.[0];
  if (!nextPort || port) return;
  port = nextPort;
  port.onmessage = (messageEvent) => {
    const message = messageEvent.data;
    if (message?.type === 'response' && typeof message.id === 'string') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) {
        request.resolve(message.result);
        if (request.action === 'lock') ipcRenderer.send('monarch-safe:sealed');
      }
      else request.reject(Object.assign(new Error(message.error?.message || 'Safe request failed.'), message.error || {}));
      return;
    }
    if (message?.type === 'event') {
      listeners.forEach((listener) => {
        try { listener({ event: message.event, data: message.data }); } catch { /* isolated listener */ }
      });
      if (message.event === 'auto-lock') ipcRenderer.send('monarch-safe:sealed');
    }
  };
  port.start();
  readyResolve();
});

ipcRenderer.on('monarch-safe:force-lock', () => {
  listeners.forEach((listener) => {
    try { listener({ event: 'force-lock', data: null }); } catch { /* isolated listener */ }
  });
});
ipcRenderer.on('monarch-safe:open-settings', () => {
  settingsListeners.forEach((listener) => {
    try { listener(); } catch { /* isolated listener */ }
  });
});

contextBridge.exposeInMainWorld('monarchSafe', {
  authorizeDelete: (value) => ipcRenderer.invoke('monarch-safe:authorize-delete', value),
  authorizeWrite: (value) => ipcRenderer.invoke('monarch-safe:authorize-write', value),
  request: async (action, payload = {}) => {
    await ready;
    if (!port) throw new Error('Safe runtime channel is unavailable.');
    requestSequence += 1;
    const id = `${Date.now().toString(36)}-${requestSequence.toString(36)}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, action: String(action || '') });
      port.postMessage({ id, action: String(action || ''), payload });
    });
  },
  onEvent: (listener) => {
    if (typeof listener !== 'function') return () => undefined;
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onOpenSettings: (listener) => {
    if (typeof listener !== 'function') return () => undefined;
    settingsListeners.add(listener);
    return () => settingsListeners.delete(listener);
  },
});
