/** Explicit isolated composition only; main.mjs/preload do NOT register this.
 * Inject Electron's dialog + exact BrowserWindow. No default window/discovery,
 * raw-path IPC return, renderer authority or write inside a Save dialog. */
export function createAstraTargetDialog({ deployment, dialog, window, assertWindow }) {
  if (deployment !== 'isolated-validation' || !dialog || !window || typeof assertWindow !== 'function')
    throw Error('astra-dialog:isolated-host-required');
  return async (access, defaultDirectory) => {
    assertWindow();
    if (access === 'observe') {
      const selection = await dialog.showOpenDialog(window, { title: 'Astra V3: выбери файл для чтения',
        defaultPath: defaultDirectory, properties: ['openFile', 'dontAddToRecent'], buttonLabel: 'Выбрать для Astra' });
      assertWindow();
      if (selection.canceled) return null;
      if (!Array.isArray(selection.filePaths) || selection.filePaths.length !== 1) throw Error('astra-dialog:single-file-required');
      return selection.filePaths[0];
    }
    if (access !== 'exclusive-create') throw Error('astra-dialog:unsupported-action');
    const selection = await dialog.showSaveDialog(window, { title: 'Astra V3: выбери имя нового файла (без перезаписи)',
      defaultPath: defaultDirectory, properties: ['dontAddToRecent'], buttonLabel: 'Выбрать для Astra' });
    assertWindow();
    if (selection.canceled) return null;
    if (typeof selection.filePath !== 'string' || !selection.filePath) throw Error('astra-dialog:single-file-required');
    return selection.filePath;
  };
}

/** Isolated host explicitly installs/removes this handler. The exact trusted
 * sender/frame check runs before AND after the modal wait via the producer. */
export function acquireAstraRendererGuard({ window, origin, event, assertTrustedRenderer, isActive = () => true }) {
  const frame = event.senderFrame, contents = window.webContents, frameUrl = frame?.url;
  let navigated = false;
  const assert = () => {
    if (!isActive() || navigated || window.isDestroyed() || contents.isDestroyed() || event.sender !== contents
      || !frame || frame !== contents.mainFrame || frame !== event.senderFrame || frame.url !== frameUrl
      || new URL(frameUrl).origin !== origin) throw Error('astra-dialog:untrusted-frame');
    assertTrustedRenderer(event);
  };
  assert();
  const onNavigation = details => { if (details?.isMainFrame !== false) navigated = true; };
  contents.on('did-start-navigation', onNavigation);
  return { assert, dispose: () => contents.removeListener('did-start-navigation', onNavigation) };
}
export function registerAstraTargetPickerIpc({ deployment, ipcMain, picker, window, origin, assertTrustedRenderer }) {
  if (deployment !== 'isolated-validation' || !ipcMain || !picker || !window || typeof assertTrustedRenderer !== 'function'
    || typeof origin !== 'string' || new URL(origin).origin !== origin || new URL(origin).hostname !== '127.0.0.1')
    throw Error('astra-dialog:isolated-host-required');
  const channel = 'monarch:astra-pick-target'; let disposed = false;
  ipcMain.handle(channel, async (event, request) => {
    // Same-URL reload must invalidate an open dialog too, not just URL changes.
    const guard = acquireAstraRendererGuard({ window, origin, event, assertTrustedRenderer, isActive: () => !disposed });
    try { return await picker.pick(request, guard.assert); }
    finally { guard.dispose(); }
  });
  return () => { disposed = true; ipcMain.removeHandler(channel); };
}
