import { app, BrowserWindow, ipcMain, MessageChannelMain, safeStorage, utilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateSafeDeviceKey } from './device-binding.mjs';
import { isAllowedSafeResourceUrl } from '../electron/safe-window-policy.mjs';
import { createSafeCapabilityToken } from './capability-token.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..', '..');
const outputRoot = path.join(workspaceRoot, 'output', 'safe-qa');
const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-electron-qa-'));
const vaultRoot = path.join(profileRoot, 'vault');
const qaAutoLockMs = 20_000;
const screenshotPaths = {
  setup: path.join(outputRoot, 'safe-setup.png'),
  recovery: path.join(outputRoot, 'safe-recovery.png'),
  unlock: path.join(outputRoot, 'safe-unlock-motion.png'),
  formats: path.join(outputRoot, 'safe-file-formats.png'),
  importAll: path.join(outputRoot, 'safe-import-all.png'),
  vault: path.join(outputRoot, 'safe-vault.png'),
  compact: path.join(outputRoot, 'safe-compact.png'),
  locked: path.join(outputRoot, 'safe-locked.png'),
  recoveryUnlockCompact: path.join(outputRoot, 'safe-recovery-unlock-compact.png'),
};
const stagePath = path.join(outputRoot, 'qa-stage.log');

await mkdir(outputRoot, { recursive: true });
await writeFile(stagePath, `start ${new Date().toISOString()}\n`, 'utf8');
process.on('uncaughtException', (error) => {
  void appendFile(stagePath, `uncaught ${error?.stack || error}\n`, 'utf8');
});
process.on('unhandledRejection', (error) => {
  void appendFile(stagePath, `unhandled ${error?.stack || error}\n`, 'utf8');
});

app.setPath('userData', path.join(profileRoot, 'profile'));
let child = null;
let window = null;
let capabilityKey = null;
let serviceSequence = 0;
const servicePending = new Map();
ipcMain.handle('monarch-safe:authorize-write', (event, value = {}) => {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id || !capabilityKey) return null;
  const fileId = String(value?.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return null;
  return createSafeCapabilityToken({ key: capabilityKey, action: 'writeFile', resourceId: fileId });
});
app.whenReady().then(runQa).catch(async (error) => {
  await appendFile(stagePath, `ready-failure ${error?.stack || error}\n`, 'utf8');
  app.exit(1);
});

async function runQa() {
 try {
  await appendFile(stagePath, `ready ${new Date().toISOString()}\n`, 'utf8');
  await appendFile(stagePath, `runtime ${new Date().toISOString()}\n`, 'utf8');
  child = utilityProcess.fork(path.join(__dirname, 'runtime.mjs'), [], {
    serviceName: 'Monarch Safe QA Runtime',
    env: {
      MONARCH_SAFE_ROOT: vaultRoot,
      MONARCH_SAFE_QA: '1',
      MONARCH_SAFE_QA_AUTO_LOCK_MS: String(qaAutoLockMs),
    },
    stdio: 'pipe',
  });
  child.stdout?.on('data', (chunk) => void appendFile(stagePath, `utility-out ${chunk}`, 'utf8'));
  child.stderr?.on('data', (chunk) => void appendFile(stagePath, `utility-err ${chunk}`, 'utf8'));
  child.on('message', handleServiceMessage);
  window = new BrowserWindow({
    title: 'Monarch Safe QA',
    width: 1520,
    height: 960,
    x: -32_000,
    y: -32_000,
    show: true,
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: '#080808',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: `monarch-safe-qa-${Date.now()}`,
      backgroundThrottling: false,
    },
  });
  window.setMenu(null);
  window.webContents.on('console-message', (event) => void appendFile(stagePath, `console ${event.level} ${event.message}\n`, 'utf8'));
  window.webContents.on('render-process-gone', (_event, details) => void appendFile(stagePath, `renderer-gone ${JSON.stringify(details)}\n`, 'utf8'));
  window.webContents.on('did-fail-load', (_event, code, description, url) => void appendFile(stagePath, `load-failed ${code} ${description} ${url}\n`, 'utf8'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedSafeResourceUrl(details.url, __dirname) }));
  window.webContents.session.on('will-download', (event) => event.preventDefault());

  await window.loadFile(path.join(__dirname, 'index.html'));
  await appendFile(stagePath, `loaded ${new Date().toISOString()}\n`, 'utf8');
  const { port1, port2 } = new MessageChannelMain();
  const deviceKey = await loadOrCreateSafeDeviceKey({ rootPath: vaultRoot, safeStorage });
  assert(deviceKey?.byteLength === 32, 'operating-system protected device binding must be available');
  capabilityKey = randomBytes(32);
  child.postMessage({ type: 'connect', deviceKey: new Uint8Array(deviceKey), capabilityKey: new Uint8Array(capabilityKey) }, [port1]);
  deviceKey.fill(0);
  window.webContents.postMessage('monarch-safe:connect', null, [port2]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await appendFile(stagePath, `bootstrap ${JSON.stringify(await evaluate(`({ bridge: Boolean(window.monarchSafe), setupHidden: document.querySelector('#setup-form')?.hidden, authError: document.querySelector('#auth-error')?.textContent, body: document.body.innerText.slice(0, 300) })`))}\n`, 'utf8');

  await waitFor(() => evaluate(`!document.querySelector('#setup-form').hidden`));
  await appendFile(stagePath, `setup-visible ${new Date().toISOString()}\n`, 'utf8');
  assert(await evaluate(`document.querySelectorAll('#setup-pin .pin-cell').length`) === 12, 'setup must default to twelve isolated PIN cells');
  await evaluate(`document.querySelector('[data-pin-length="4"]').click()`);
  assert(await evaluate(`document.querySelectorAll('#setup-pin .pin-cell').length`) === 4, 'four-digit policy must render four isolated PIN cells');
  await evaluate(`document.querySelector('[data-pin-length="12"]').click()`);
  assert(await evaluate(`document.querySelectorAll('#setup-pin .pin-cell').length`) === 12, 'twelve-digit policy must render twelve isolated PIN cells');
  await capture(screenshotPaths.setup);

  await evaluate(`document.querySelector('[data-pin-length="6"]').click()`);
  await fillCells('#setup-pin', '482951');
  await fillCells('#setup-pin-confirm', '482951');
  await evaluate(`document.querySelector('#destruction-consent').checked = true; document.querySelector('#setup-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.querySelector('#recovery-screen').hidden`));
  const recoveryKeys = await evaluate(`[...document.querySelectorAll('#recovery-key-list li')].map((node) => node.textContent)`);
  assert(recoveryKeys.length === 3, 'setup must issue exactly three recovery keys');
  assert(recoveryKeys.every((key) => /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){4}$/.test(key)), 'recovery key format must be five groups of four');
  const emergencyWordCount = await evaluate(`document.querySelectorAll('#emergency-phrase-list li').length`);
  assert(emergencyWordCount === 12, 'setup must display the default twelve-word emergency phrase exactly once');
  const setupCredentialResidue = await evaluate(`[...document.querySelectorAll('#setup-pin input,#setup-pin-confirm input')].some((node) => node.value !== '')`);
  assert(setupCredentialResidue === false, 'setup PIN must be cleared from renderer fields immediately after submission');
  await capture(screenshotPaths.recovery);

  await evaluate(`document.querySelector('#recovery-saved').click(); document.querySelector('#enter-vault').click()`);
  await waitFor(() => evaluate(`!document.querySelector('#safe-transition').hidden && document.querySelector('#safe-transition').dataset.mode === 'unlock'`));
  await waitFor(() => evaluate(`document.querySelector('#safe-transition').dataset.phase === 'decrypt'`));
  const unlockMotion = await evaluate(`({
    visible: !document.querySelector('#safe-transition').hidden,
    phase: document.querySelector('#safe-transition').dataset.phase,
    title: document.querySelector('#transition-title').textContent,
    activeRail: document.querySelectorAll('.transition-rail .is-active').length,
  })`);
  assert(unlockMotion.visible && unlockMotion.activeRail === 1, 'unlock motion must expose one meaningful active security phase');
  await evaluate(`new Promise((resolve) => setTimeout(resolve, 150))`);
  await capture(screenshotPaths.unlock);
  await waitFor(() => evaluate(`document.querySelector('#safe-transition').hidden && !document.querySelector('#vault-screen').hidden`));

  const chatMarker = 'SAFE_QA_CHAT_MARKER_63D9';
  const encryptedChat = await requestSafeService('chatUpsert', {
    record: {
      version: 1,
      id: 'safe-qa-chat',
      kind: 'oscar',
      title: 'QA encrypted chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ id: 'qa-message', role: 'user', content: chatMarker }],
    },
  });
  assert(encryptedChat.verified === true, 'parent chat service must verify the encrypted generation before success');
  const encryptedChatList = await requestSafeService('chatList');
  assert(encryptedChatList.chats.length === 1 && encryptedChatList.chats[0].id === 'safe-qa-chat', 'parent chat service must list only authenticated chat metadata');
  const encryptedChatRead = await requestSafeService('chatRead', { id: 'safe-qa-chat', kind: 'oscar' });
  assert(encryptedChatRead.record.messages[0].content === chatMarker, 'parent chat service must decrypt the selected chat only while Safe is unlocked');
  assert(await evaluate(`![...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('QA encrypted chat'))`), 'hidden chat records must not appear as ordinary Safe files');
  await requestSafeService('chatDelete', { id: 'safe-qa-chat', kind: 'oscar' });

  await importBrowserFile('all-view-import.txt', 'text/plain', [...new TextEncoder().encode('import from all view')]);
  const importFromAllView = await evaluate(`({
    visible: [...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('all-view-import.txt')),
    toast: document.querySelector('#toast').textContent,
    activeSection: document.querySelector('[data-section-id].active')?.dataset.sectionId || '',
  })`);
  assert(importFromAllView.visible && importFromAllView.activeSection === 'all' && importFromAllView.toast.includes('Личное'), 'Import from All files must use the first Safe section without forcing manual navigation');
  await dropBrowserFile('all-view-drop.txt', 'text/plain', [...new TextEncoder().encode('drop on toolbar')]);
  const dropFromWholeWindow = await evaluate(`({
    visible: [...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('all-view-drop.txt')),
    toast: document.querySelector('#toast').textContent,
  })`);
  assert(dropFromWholeWindow.visible && dropFromWholeWindow.toast.includes('Личное'), 'File drop on the Safe window must import into the default section');
  await capture(screenshotPaths.importAll);
  await evaluate(`document.querySelector('#toast').hidden = true`);

  await openItem('section', 'Закрытый проект', { color: '#f97316' });
  await evaluate(`[...document.querySelectorAll('[data-section-id]')].find((node) => node.textContent.includes('Закрытый проект')).click()`);
  const itemCountBeforeClose = await evaluate(`document.querySelectorAll('[data-file-id]').length`);
  await evaluate(`document.querySelector('#new-file').click()`);
  await waitFor(() => evaluate(`document.querySelector('#item-dialog').open`));
  await evaluate(`document.querySelector('#item-name').value = 'НЕ СОЗДАВАТЬ'; document.querySelector('#item-close').click()`);
  await waitFor(() => evaluate(`!document.querySelector('#item-dialog').open`));
  const itemDialogClose = await evaluate(`({
    closeType: document.querySelector('#item-close').type,
    itemCount: document.querySelectorAll('[data-file-id]').length,
    accidentalItem: [...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('НЕ СОЗДАВАТЬ')),
  })`);
  assert(itemDialogClose.closeType === 'button' && itemDialogClose.itemCount === itemCountBeforeClose && !itemDialogClose.accidentalItem, 'item-dialog close control must close without submitting or mutating Safe');
  await evaluate(`document.querySelector('#edit-section').click()`);
  await waitFor(() => evaluate(`document.querySelector('#item-dialog').open`));
  await evaluate(`document.querySelector('#item-name').value = 'Закрытый архив'; document.querySelector('#item-color').value = '#ff7a00'; document.querySelector('#item-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.querySelector('#item-dialog').open`));
  const sectionCustomization = await evaluate(`(() => { const node = [...document.querySelectorAll('[data-section-id]')].find((entry) => entry.textContent.includes('Закрытый архив')); return { name: node?.children[1]?.textContent || '', color: node?.style.getPropertyValue('--section-color') || '' }; })()`);
  assert(sectionCustomization.name === 'Закрытый архив' && sectionCustomization.color === '#ff7a00', 'existing section name and color must be customizable inside Safe');
  await openItem('folder', 'Материалы');
  const fileFormatCatalog = await evaluate(`(() => {
    const select = document.querySelector('#item-type');
    const powerShell = [...select.querySelectorAll('optgroup')].find((group) => group.label === 'PowerShell');
    return {
      total: select.options.length,
      groups: select.querySelectorAll('optgroup').length,
      powerShellValues: [...(powerShell?.querySelectorAll('option') || [])].map((option) => option.value),
    };
  })()`);
  assert(fileFormatCatalog.total >= 80 && fileFormatCatalog.groups >= 6, 'new-file dialog must expose the broad grouped format catalog');
  assert(['powershell-script', 'powershell-module', 'powershell-data', 'powershell-script-xml', 'powershell-session-config', 'powershell-role-capability', 'powershell-cdxml', 'powershell-clixml', 'powershell-console'].every((id) => fileFormatCatalog.powerShellValues.includes(id)), 'new-file dialog must cover the PowerShell-specific format family');
  await evaluate(`document.querySelector('#new-file').click()`);
  await waitFor(() => evaluate(`document.querySelector('#item-dialog').open`));
  await evaluate(`document.querySelector('#item-type').value = 'powershell-script'; document.querySelector('#item-type').dispatchEvent(new Event('change', { bubbles: true }))`);
  assert(await evaluate(`document.querySelector('#item-type-hint').textContent.includes('.ps1')`), 'PowerShell selection must show its exact extension and local editor policy');
  await capture(screenshotPaths.formats);
  await evaluate(`document.querySelector('#item-cancel').click()`);
  await waitFor(() => evaluate(`!document.querySelector('#item-dialog').open`));
  await openItem('file', 'Deploy', { format: 'powershell-script' });
  await waitFor(() => evaluate(`[...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('Deploy.ps1'))`));
  await openItem('file', 'План', { mime: 'text/markdown' });
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-file-id]'))`));
  const keyboardFileAccess = await evaluate(`({
    fileControl: document.querySelector('[data-file-id] .file-open-button')?.tagName || '',
    fileTabIndex: document.querySelector('[data-file-id] .file-open-button')?.tabIndex ?? -1,
    folderControl: document.querySelector('[data-folder-id] .file-open-button')?.tagName || '',
    folderTabIndex: document.querySelector('[data-folder-id] .file-open-button')?.tabIndex ?? -1,
  })`);
  assert(keyboardFileAccess.fileControl === 'BUTTON' && keyboardFileAccess.fileTabIndex === 0 && keyboardFileAccess.folderControl === 'BUTTON' && keyboardFileAccess.folderTabIndex === 0, 'file and folder names must be native keyboard-operable buttons');
  await evaluate(`document.querySelector('[data-file-id] .file-open-button').click()`);
  await waitFor(() => evaluate(`!document.querySelector('#editor-active').hidden || !document.querySelector('#toast').hidden`));
  const fileOpenState = await evaluate(`({ editorVisible: !document.querySelector('#editor-active').hidden, toast: document.querySelector('#toast').textContent })`);
  if (!fileOpenState.editorVisible) throw new Error(`Safe could not open QA file: ${fileOpenState.toast || 'unknown error'}`);
  const dirtyGuardMarker = 'SAFE_QA_UNSAVED_GUARD_4E2A';
  await evaluate(`document.querySelector('#text-editor').value = ${JSON.stringify(dirtyGuardMarker)}; document.querySelector('#text-editor').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-file-id] .file-open-button').click()`);
  await waitFor(() => evaluate(`document.querySelector('#confirm-dialog').open`));
  await evaluate(`document.querySelector('#confirm-form button[value="cancel"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('#confirm-dialog').open`));
  const dirtyCancelState = await evaluate(`({ value: document.querySelector('#text-editor').value, dirty: document.querySelector('#save-file').dataset.dirty, meta: document.querySelector('#editor-meta').textContent })`);
  assert(dirtyCancelState.value === dirtyGuardMarker && dirtyCancelState.dirty === 'true' && dirtyCancelState.meta.includes('не сохранено'), 'canceling the discard guard must preserve the current plaintext draft and explicit dirty state');
  await evaluate(`document.querySelector('#lock-now-top').click()`);
  await waitFor(() => evaluate(`document.querySelector('#confirm-dialog').open`));
  await evaluate(`document.querySelector('#confirm-form button[value="cancel"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('#confirm-dialog').open`));
  assert(await evaluate(`!document.querySelector('#vault-screen').hidden && document.querySelector('#text-editor').value === ${JSON.stringify(dirtyGuardMarker)}`), 'canceling manual lock with a dirty draft must keep the unlocked editor intact');
  await evaluate(`window.monarchSafe.request('touch')`);
  await evaluate(`document.querySelector('[data-file-id] .file-open-button').click()`);
  await waitFor(() => evaluate(`document.querySelector('#confirm-dialog').open`));
  await evaluate(`document.querySelector('#confirm-action').click()`);
  await waitFor(() => evaluate(`!document.querySelector('#confirm-dialog').open && document.querySelector('#save-file').dataset.dirty === 'false'`));
  const dirtyDiscardState = await evaluate(`({ value: document.querySelector('#text-editor').value, dirty: document.querySelector('#save-file').dataset.dirty })`);
  assert(dirtyDiscardState.value !== dirtyGuardMarker && dirtyDiscardState.dirty === 'false', 'confirming discard must reload the encrypted generation and clear dirty state');
  await evaluate(`window.monarchSafe.request('list')`);
  const marker = 'SAFE_QA_PLAINTEXT_MARKER_7C91';
  await evaluate(`document.querySelector('#text-editor').value = ${JSON.stringify(`# План\n\n${marker}\n`)}; document.querySelector('#text-editor').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#save-file').click()`);
  await waitFor(() => evaluate(`document.querySelector('#toast').textContent.includes('сохранён')`));
  await evaluate(`document.querySelector('[data-editor-tab="preview"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#preview-pane').textContent.includes(${JSON.stringify(marker)})`));

  await evaluate(`document.querySelector('[data-file-check]').click(); document.querySelector('#archive-files').click()`);
  await waitFor(() => evaluate(`[...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('Архив-'))`));
  await evaluate(`[...document.querySelectorAll('[data-file-id]')].find((row) => row.textContent.includes('Архив-')).click()`);
  await waitFor(() => evaluate(`!document.querySelector('#extract-archive').hidden`));
  await evaluate(`document.querySelector('#extract-archive').click()`);
  await waitFor(() => evaluate(`document.querySelector('#toast').textContent.includes('распакован')`));

  await importBrowserFile('pixel.png', 'image/png', pngPixelBytes());
  const imagePolicy = await assertPreview('pixel.png', '#preview-pane img');
  await importBrowserFile('sample.mp3', 'audio/mpeg', [73, 68, 51, 4, 0, 0, 0, 0]);
  const audioPolicy = await assertPreview('sample.mp3', '#preview-pane audio[controls]');
  await importBrowserFile('sample.mp4', 'video/mp4', [0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  const videoPolicy = await assertPreview('sample.mp4', '#preview-pane video[controls]');
  await importBrowserFile('sample.pdf', 'application/pdf', [...new TextEncoder().encode('%PDF-1.4\n%%EOF\n')]);
  const pdfPolicy = await assertPreview('sample.pdf', '#preview-pane [data-pdf-preview]');
  await importBrowserFile('sample.bin', 'application/octet-stream', [0, 1, 2, 3, 254, 255]);
  const binaryPolicy = await assertPreview('sample.bin', '#preview-pane pre');
  assert([imagePolicy, audioPolicy, videoPolicy, pdfPolicy].every((policy) => policy.saveHidden && policy.summaryVisible), 'decoded formats must not expose the raw byte editor or save action');
  assert(binaryPolicy.saveHidden === false && binaryPolicy.hexVisible, 'small unknown binaries must use the bounded internal HEX editor');
  const previewKinds = ['image', 'audio', 'video', 'pdf', 'hex'];

  await evaluate(`document.querySelector('#safe-search').value = 'План'; document.querySelector('#safe-search').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#type-filter').value = 'text'; document.querySelector('#type-filter').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#sort-order').value = 'name-asc'; document.querySelector('#sort-order').dispatchEvent(new Event('change', { bubbles: true }))`);
  const filteredRows = await evaluate(`document.querySelectorAll('[data-file-id]').length`);
  assert(filteredRows >= 1, 'search/type/sort controls must leave matching text files visible');
  await evaluate(`document.querySelector('#safe-search').value = ''; document.querySelector('#safe-search').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#type-filter').value = 'all'; document.querySelector('#type-filter').dispatchEvent(new Event('change', { bubbles: true }))`);
  await evaluate(`[...document.querySelectorAll('[data-file-id]')].find((row) => row.textContent.includes('План.md')).click()`);
  await waitFor(() => evaluate(`document.querySelector('#editor-file-name').textContent.includes('План.md')`));
  await evaluate(`document.querySelector('[data-editor-tab="preview"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#preview-pane').textContent.includes(${JSON.stringify(marker)})`));
  await capture(screenshotPaths.vault);
  window.setSize(1040, 700);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const compactLayout = await evaluate(`({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollX,
    bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    toolbarVisible: Boolean(document.querySelector('.safe-toolbar')?.offsetParent),
    sidebarVisible: Boolean(document.querySelector('.safe-sidebar')?.offsetParent),
    sidebarRect: (() => { const rect = document.querySelector('.safe-sidebar')?.getBoundingClientRect(); return rect ? { x: rect.x, width: rect.width, height: rect.height } : null; })(),
    sidebarOpacity: getComputedStyle(document.querySelector('.safe-sidebar')).opacity,
    vaultWidth: document.querySelector('#vault-screen')?.getBoundingClientRect().width,
    toolbarWidth: document.querySelector('.safe-toolbar')?.scrollWidth,
    contentWidth: document.querySelector('.safe-content')?.scrollWidth,
    isolationWidth: document.querySelector('.isolation-bar')?.scrollWidth,
  })`);
  assert(Math.abs(compactLayout.width - 1040) <= 4 && Math.abs(compactLayout.height - 700) <= 4 && compactLayout.bodyOverflowX === false, `minimum desktop Safe layout must fit without horizontal overflow: ${JSON.stringify(compactLayout)}`);
  assert(compactLayout.toolbarVisible && compactLayout.sidebarVisible, 'minimum desktop Safe layout must keep primary navigation visible');
  await capture(screenshotPaths.compact);
  window.setSize(1520, 960);
  await new Promise((resolve) => setTimeout(resolve, 180));

  const bridgeSurface = await evaluate(`Object.keys(window.monarchSafe).sort()`);
  assert(JSON.stringify(bridgeSurface) === JSON.stringify(['authorizeDelete', 'authorizeWrite', 'onEvent', 'request']), 'Safe preload must expose only bounded confirmations, request and event subscription');
  const popupDenied = await evaluate(`window.open('https://example.com') === null`);
  assert(popupDenied, 'new windows must be denied');
  const networkDenied = await evaluate(`fetch('https://example.com').then(() => false).catch(() => true)`);
  assert(networkDenied, 'network fetch must be denied');
  const clipboardDenied = await evaluate(`!document.querySelector('#text-editor').dispatchEvent(new ClipboardEvent('copy', { cancelable: true }))`);
  assert(clipboardDenied, 'system clipboard events must be canceled');
  const rendererDestroyResult = await evaluate(`window.monarchSafe.request('destroy').then(() => ({ denied: false })).catch(() => ({ denied: true }))`);
  const postDestroyProbe = await evaluate(`window.monarchSafe.request('status')`);
  const rendererDestroyDenied = rendererDestroyResult.denied && postDestroyProbe.configured && !postDestroyProbe.destroyed;
  assert(rendererDestroyDenied, 'Safe renderer must not own an unconditional vault-destruction action');
  const deletionTarget = await evaluate(`[...document.querySelectorAll('[data-file-id]')].find((row) => row.textContent.includes('sample.bin')).dataset.fileId`);
  const deletionTargetLiteral = JSON.stringify(deletionTarget);
  const unauthorisedWriteDenied = await evaluate(`window.monarchSafe.request('writeFile', { id: ${deletionTargetLiteral}, bytes: new Uint8Array([9]) }).then(() => false).catch(() => true)`);
  assert(unauthorisedWriteDenied, 'file overwrite must reject renderer requests without a signed capability');
  const writeToken = createSafeCapabilityToken({ key: capabilityKey, action: 'writeFile', resourceId: deletionTarget });
  const writeTokenLiteral = JSON.stringify(writeToken);
  const authorisedWrite = await evaluate(`window.monarchSafe.request('writeFile', { id: ${deletionTargetLiteral}, bytes: new Uint8Array([0,1,2,3,254,255]), capabilityToken: ${writeTokenLiteral} }).then(() => true).catch(() => false)`);
  const replayWriteDenied = await evaluate(`window.monarchSafe.request('writeFile', { id: ${deletionTargetLiteral}, bytes: new Uint8Array([9]), capabilityToken: ${writeTokenLiteral} }).then(() => false).catch(() => true)`);
  assert(authorisedWrite && replayWriteDenied, 'file overwrite capability must be resource-bound and single-use');
  const mutationAuthorization = { unauthorisedWriteDenied, authorisedWrite, replayWriteDenied };
  const unauthorisedDeleteDenied = await evaluate(`window.monarchSafe.request('deleteFile', { id: ${deletionTargetLiteral} }).then(() => false).catch(() => true)`);
  assert(unauthorisedDeleteDenied, 'file deletion must reject renderer requests without a signed capability');
  const deletionToken = createSafeCapabilityToken({ key: capabilityKey, action: 'deleteFile', resourceId: deletionTarget });
  const deletionTokenLiteral = JSON.stringify(deletionToken);
  const authorisedDelete = await evaluate(`window.monarchSafe.request('deleteFile', { id: ${deletionTargetLiteral}, capabilityToken: ${deletionTokenLiteral} }).then(() => true).catch(() => false)`);
  assert(authorisedDelete, 'signed single-use file deletion capability must authorize only its bound file');
  const replayDeleteDenied = await evaluate(`window.monarchSafe.request('deleteFile', { id: ${deletionTargetLiteral}, capabilityToken: ${deletionTokenLiteral} }).then(() => false).catch(() => true)`);
  assert(replayDeleteDenied, 'file deletion capability must be single-use');
  const destructiveAuthorization = { unauthorisedDeleteDenied, authorisedDelete, replayDeleteDenied };
  await evaluate(`document.querySelector('#toast').hidden = true`);

  await evaluate(`window.__safeAutoLockEvents = 0; window.monarchSafe.onEvent(({ event }) => { if (event === 'auto-lock') window.__safeAutoLockEvents += 1; }); window.monarchSafe.request('list')`);
  await waitFor(
    () => evaluate(`!document.querySelector('#auth-screen').hidden && window.__safeAutoLockEvents === 1`),
    qaAutoLockMs + 5_000,
  );
  const autoLockEvents = await evaluate(`window.__safeAutoLockEvents`);
  const cleanup = await evaluate(`({
    markerInText: document.body.innerText.includes(${JSON.stringify(marker)}),
    markerInInputs: [...document.querySelectorAll('input,textarea')].some((node) => node.value.includes(${JSON.stringify(marker)})),
    sectionNamePresent: document.body.innerText.includes('Закрытый архив'),
    recoveryKeysPresent: document.querySelectorAll('#recovery-key-list li').length,
    emergencyWordsPresent: document.querySelectorAll('#emergency-phrase-list li').length,
    credentialValuesPresent: [...document.querySelectorAll('#setup-pin input,#setup-pin-confirm input,#unlock-pin input,#recovery-input input,#emergency-input')].some((node) => node.value !== ''),
    pinCells: document.querySelectorAll('#unlock-pin .pin-cell').length,
  })`);
  assert(cleanup.markerInText === false && cleanup.markerInInputs === false, 'lock must purge plaintext from DOM values and rendered text');
  assert(cleanup.sectionNamePresent === false && cleanup.recoveryKeysPresent === 0 && cleanup.emergencyWordsPresent === 0, 'lock must purge encrypted metadata and every recovery secret from DOM');
  assert(cleanup.credentialValuesPresent === false, 'lock must leave no credential values in renderer fields');
  assert(cleanup.pinCells === 6, 'configured six-digit PIN must render six isolated input frames');
  await capture(screenshotPaths.locked);
  await waitFor(() => evaluate(`document.querySelector('#safe-transition').hidden`));
  window.setSize(1040, 700);
  await evaluate(`document.querySelector('[data-auth-mode="recovery"]').click()`);
  await new Promise((resolve) => setTimeout(resolve, 520));
  const recoveryUnlockLayout = await evaluate(`(() => {
    const form = document.querySelector('#unlock-form').getBoundingClientRect();
    const row = document.querySelector('#recovery-input').getBoundingClientRect();
    const cells = [...document.querySelectorAll('#recovery-input .recovery-cell')];
    const first = cells[0].getBoundingClientRect();
    const last = cells.at(-1).getBoundingClientRect();
    return {
      inputCount: cells.length,
      documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rowOverflowX: document.querySelector('#recovery-input').scrollWidth > document.querySelector('#recovery-input').clientWidth,
      formLeft: form.left,
      formRight: form.right,
      rowLeft: row.left,
      rowRight: row.right,
      firstLeft: first.left,
      lastRight: last.right,
      cellWidth: first.width,
    };
  })()`);
  assert(recoveryUnlockLayout.inputCount === 20, 'recovery unlock must render exactly twenty bounded key cells');
  assert(!recoveryUnlockLayout.documentOverflowX && !recoveryUnlockLayout.rowOverflowX, `recovery unlock must not create horizontal overflow: ${JSON.stringify(recoveryUnlockLayout)}`);
  assert(recoveryUnlockLayout.firstLeft >= recoveryUnlockLayout.formLeft - 1 && recoveryUnlockLayout.lastRight <= recoveryUnlockLayout.formRight + 1, `every recovery cell must remain inside the auth form: ${JSON.stringify(recoveryUnlockLayout)}`);
  await capture(screenshotPaths.recoveryUnlockCompact);
  window.setSize(1520, 960);
  await evaluate(`document.querySelector('[data-auth-mode="pin"]').click()`);

  console.log(JSON.stringify({
    ok: true,
    recoveryKeyCount: recoveryKeys.length,
    emergencyWordCount,
    unlockMotion,
    compactLayout,
    recoveryUnlockLayout,
    importFromAllView,
    dropFromWholeWindow,
    itemDialogClose,
    sectionCustomization,
    keyboardFileAccess,
    dirtyCancelState,
    dirtyDiscardState,
    previewKinds,
    filteredRows,
    bridgeSurface,
    popupDenied,
    networkDenied,
    clipboardDenied,
    rendererDestroyDenied,
    destructiveAuthorization,
    mutationAuthorization,
    autoLockEvents,
    cleanup,
    encryptedChat: { verified: encryptedChat.verified, listed: encryptedChatList.chats.length, readBack: encryptedChatRead.record.id },
    screenshots: screenshotPaths,
  }, null, 2));
  await writeFile(path.join(outputRoot, 'qa-report.json'), JSON.stringify({ ok: true, recoveryKeyCount: recoveryKeys.length, emergencyWordCount, unlockMotion, compactLayout, recoveryUnlockLayout, importFromAllView, dropFromWholeWindow, itemDialogClose, sectionCustomization, keyboardFileAccess, dirtyCancelState, dirtyDiscardState, previewKinds, filteredRows, bridgeSurface, popupDenied, networkDenied, clipboardDenied, rendererDestroyDenied, destructiveAuthorization, mutationAuthorization, autoLockEvents, cleanup, encryptedChat: { verified: encryptedChat.verified, listed: encryptedChatList.chats.length, readBack: encryptedChatRead.record.id }, screenshots: screenshotPaths }, null, 2), 'utf8');
 } catch (error) {
  console.error(error?.stack || error);
  await appendFile(stagePath, `failure ${error?.stack || error}\n`, 'utf8');
  try { await capture(path.join(outputRoot, 'safe-failure.png')); } catch { /* renderer may be unavailable */ }
  await writeFile(path.join(outputRoot, 'qa-report.json'), JSON.stringify({ ok: false, error: String(error?.stack || error) }, null, 2), 'utf8');
  process.exitCode = 1;
 } finally {
 try { child?.kill(); } catch { /* stopped */ }
  capabilityKey?.fill(0);
  try { window?.destroy(); } catch { /* closed */ }
  queueProfileCleanup();
  app.exit(process.exitCode || 0);
 }
}

function queueProfileCleanup() {
  const script = `
    const fs = require('node:fs');
    const target = ${JSON.stringify(profileRoot)};
    let attempts = 0;
    const clean = () => {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 80 });
        process.exit(0);
      } catch {
        attempts += 1;
        if (attempts >= 40) process.exit(1);
        setTimeout(clean, 250);
      }
    };
    setTimeout(clean, 250);
  `;
  try {
    const cleaner = spawn(process.execPath, ['-e', script], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    cleaner.unref();
  } catch {
    // Test-only profile can be removed by the next QA cleanup pass.
  }
}

function requestSafeService(action, payload = {}) {
  serviceSequence += 1;
  const id = `qa-service-${serviceSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      servicePending.delete(id);
      reject(new Error(`Safe QA service request timed out: ${action}`));
    }, 10_000);
    servicePending.set(id, { resolve, reject, timer, action });
    child.postMessage({ type: 'service-request', id, action, payload });
  });
}

function handleServiceMessage(message) {
  const payload = message?.data?.type ? message.data : message;
  if (payload?.type !== 'service-response' || typeof payload.id !== 'string') return;
  const pending = servicePending.get(payload.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  servicePending.delete(payload.id);
  if (payload.ok === true) pending.resolve(payload.result);
  else pending.reject(Object.assign(
    new Error(`Safe QA service request ${pending.action || 'unknown'} failed: ${payload.error?.message || 'Safe QA service request failed.'}`),
    payload.error || {},
  ));
}

async function evaluate(source) {
  try {
    return await window.webContents.executeJavaScript(source, true);
  } catch (error) {
    const probe = String(source).replace(/\s+/g, ' ').slice(0, 180);
    throw new Error(`Safe QA renderer probe failed (${probe}): ${error?.message || error}`);
  }
}

async function waitFor(check, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw lastError || new Error('Timed out waiting for Safe QA state.');
}

async function fillCells(selector, value) {
  await evaluate(`(() => {
    const inputs = [...document.querySelectorAll(${JSON.stringify(`${selector} input`)})];
    const value = ${JSON.stringify(value)};
    inputs.forEach((input, index) => { input.value = value[index] || ''; input.dispatchEvent(new Event('input', { bubbles: true })); });
  })()`);
}

async function openItem(mode, name, options = {}) {
  const buttonId = mode === 'section' ? '#new-section' : mode === 'folder' ? '#new-folder' : '#new-file';
  await evaluate(`document.querySelector(${JSON.stringify(buttonId)}).click()`);
  await waitFor(() => evaluate(`document.querySelector('#item-dialog').open`));
  await evaluate(`document.querySelector('#item-name').value = ${JSON.stringify(name)}`);
  if (options.color) await evaluate(`document.querySelector('#item-color').value = ${JSON.stringify(options.color)}`);
  if (options.mime) await evaluate(`document.querySelector('#item-type').value = ${JSON.stringify(options.mime)}`);
  if (options.format) await evaluate(`document.querySelector('#item-type').value = ${JSON.stringify(options.format)}; document.querySelector('#item-type').dispatchEvent(new Event('change', { bubbles: true }))`);
  await evaluate(`document.querySelector('#item-form').requestSubmit()`);
  await waitFor(() => evaluate(`!document.querySelector('#item-dialog').open`));
}

async function importBrowserFile(name, mime, bytes) {
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(${JSON.stringify(bytes)})], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
    const input = document.querySelector('#file-input');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(() => evaluate(`[...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes(${JSON.stringify(name)}))`));
}

async function dropBrowserFile(name, mime, bytes) {
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(${JSON.stringify(bytes)})], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
    document.querySelector('.safe-toolbar').dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  })()`);
  await waitFor(() => evaluate(`[...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes(${JSON.stringify(name)}))`));
}

async function assertPreview(name, selector) {
  await evaluate(`[...document.querySelectorAll('[data-file-id]')].find((row) => row.textContent.includes(${JSON.stringify(name)})).click()`);
  await waitFor(() => evaluate(`document.querySelector('#editor-file-name').textContent.includes(${JSON.stringify(name)})`));
  await evaluate(`document.querySelector('[data-editor-tab="preview"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
  return evaluate(`({ saveHidden: document.querySelector('#save-file').hidden, summaryVisible: !document.querySelector('#binary-summary').hidden, hexVisible: !document.querySelector('#hex-editor').hidden })`);
}

function pngPixelBytes() {
  return [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,13,73,68,65,84,8,215,99,248,207,192,240,31,0,5,0,1,255,137,153,61,29,0,0,0,0,73,69,78,68,174,66,96,130];
}

async function capture(destination) {
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  window.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await window.webContents.capturePage();
  await writeFile(destination, image.toPNG());
}

function assert(condition, message) {
  if (!condition) throw new Error(`Safe QA assertion failed: ${message}`);
}
