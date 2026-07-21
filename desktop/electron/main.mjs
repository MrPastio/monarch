import {
  app,
  BrowserWindow,
  Menu,
  MessageChannelMain,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  safeStorage,
  shell,
  utilityProcess,
} from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isTrustedRuntimeUrl,
  readExternalHttpUrl,
  shouldAllowDesktopPermission,
} from './security-policy.mjs';
import { shouldHideToTrayOnClose, trayWindowLabel } from './tray-policy.mjs';
import { loadOrCreateSafeDeviceKey } from '../safe/device-binding.mjs';
import { createSafeCapabilityToken } from '../safe/capability-token.mjs';
import { normalizeSafeSecurityPolicy } from '../safe/security-policy.mjs';
import { buildSafeShortcutDetails, safeShortcutPath } from './safe-shortcut.mjs';
import { isAllowedSafeResourceUrl } from './safe-window-policy.mjs';
import { ownsSafeSessionResource } from './safe-session-policy.mjs';
import { resolveSafeStorageRoot } from './safe-storage-path.mjs';
import { resolveRuntimeLaunch } from './runtime-entry.mjs';
import { waitForRuntimeReady } from './runtime-startup.mjs';
import {
  createSpeechDiagnosticRecord,
  createSpeechWarmupCoordinator,
  createWindowsSpeechOutput,
} from './speech-output.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..', '..');
const preloadPath = path.join(__dirname, 'preload.mjs');
const safeEntryQaMode = process.argv.includes('--safe-entry-qa');
const safeEntryQaProfile = safeEntryQaMode
  ? mkdtempSync(path.join(os.tmpdir(), 'monarch-safe-entry-qa-'))
  : null;
if (safeEntryQaProfile) app.setPath('userData', safeEntryQaProfile);
const safeRoot = resolveSafeStorageRoot({
  workspaceRoot,
  qaUserDataRoot: safeEntryQaProfile ? app.getPath('userData') : null,
});
const safeUiRoot = path.join(workspaceRoot, 'desktop', 'safe');
const safePreloadPath = path.join(safeUiRoot, 'preload.cjs');
const safeRuntimePath = path.join(safeUiRoot, 'runtime.mjs');
const safeIndexPath = path.join(safeUiRoot, 'index.html');
const safeIconPath = path.join(workspaceRoot, 'assets', 'safe', 'monarch-safe.ico');
const smokeMode = process.argv.includes('--smoke');
const safeLaunchMode = process.argv.includes('--safe') && !safeEntryQaMode;
const appName = 'Monarch';
let mainWindow = null;
const speechDiagnosticsPath = path.join(workspaceRoot, 'runtime', 'electron-speech.log');
let speechLogQueue = Promise.resolve();
const speechOutput = createWindowsSpeechOutput({
  workspaceRoot,
  onTelemetry: (frame) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('monarch:speech-telemetry', frame);
  },
});
const speechWarmup = createSpeechWarmupCoordinator({
  warmup: () => speechOutput.warmup(),
  onDiagnostics: (result) => {
    if (result.status !== 'loading') logSpeechDiagnostic('warmup', result);
  },
});

let safeWindow = null;
let safeProcess = null;
let safeCapabilityKey = null;
let safeServiceSequence = 0;
const safeServicePending = new Map();
let serverProcess = null;
let runtimeReady = false;
let runtimeUrl = '';
let tray = null;
let quitRequested = false;
let trayHintShown = false;
let shuttingDown = false;
let shutdownComplete = false;
let shutdownPromise = null;
const configuredSafeSessions = new WeakSet();
const safeEntryQaEvents = [];
let safeSecurityPolicy = normalizeSafeSecurityPolicy(null);

if (!safeEntryQaMode && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (!safeEntryQaMode) {
    app.on('second-instance', (_event, commandLine) => {
      if (commandLine.includes('--safe')) void showSafeWindow();
      else void showMainWindow();
    });
  }

  app.setAppUserModelId(safeLaunchMode ? 'Monarch.Safe' : 'Monarch.App');

  app.whenReady()
    .then(startDesktopApp)
    .catch(async (error) => {
      await showFatalError(error);
      app.exit(1);
    });
}

app.on('window-all-closed', () => {
  // Monarch intentionally stays alive in the system tray.
});

app.on('before-quit', (event) => {
  if (!smokeMode && !shutdownComplete) {
    event.preventDefault();
    if (!shutdownPromise) {
      shutdownPromise = shutdownDesktop().finally(() => {
        shutdownComplete = true;
        app.quit();
      });
    }
    return;
  }
  shuttingDown = true;
  tray?.destroy();
  tray = null;
  stopRuntime();
});

app.on('activate', () => {
  if (safeLaunchMode && !mainWindow) void showSafeWindow();
  else void showMainWindow();
});

ipcMain.handle('monarch:get-runtime-url', () => runtimeUrl);
ipcMain.handle('monarch:get-app-info', () => ({
  name: appName,
  version: app.getVersion(),
  workspaceRoot,
  runtimeUrl,
}));
ipcMain.handle('monarch:copy-text', (_event, value) => {
  clipboard.writeText(String(value ?? ''));
  return true;
});
ipcMain.handle('monarch:speech-speak', async (event, value = {}) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  // Persist the trusted IPC hand-off before awaiting the whole playback. The
  // completion record can arrive several seconds later, so without this line a
  // healthy in-progress Qwen turn is indistinguishable from a renderer drop.
  logSpeechDiagnostic('playback-requested', {
    ok: true,
    status: 'requested',
    engine: 'qwen3-tts-pending',
  });
  const result = await speechOutput.speak(value);
  logSpeechDiagnostic('playback', result);
  return result;
});
ipcMain.handle('monarch:speech-stop', (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  return { ok: true, stopped: speechOutput.stop() };
});
ipcMain.handle('monarch:speech-release', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, released: false, error: 'untrusted-renderer' };
  }
  const result = await speechOutput.releaseNeural();
  if (result.ok) speechWarmup.reset();
  logSpeechDiagnostic('release', result);
  return result;
});
ipcMain.handle('monarch:speech-warmup', (event, value = {}) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { status: 'failed', ok: false, error: 'untrusted-renderer', summary: 'Недоверенный renderer не может запускать TTS.' };
  }
  if (smokeMode || safeEntryQaMode) {
    return { status: 'unavailable', ok: false, error: 'speech-warmup-disabled', summary: 'Прогрев TTS отключён для служебного запуска.' };
  }
  return value?.retry === true ? speechWarmup.retry() : speechWarmup.start();
});
ipcMain.handle('monarch:speech-diagnostics', (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { status: 'failed', ok: false, error: 'untrusted-renderer', summary: 'Диагностика TTS недоступна.' };
  }
  return speechWarmup.snapshot();
});

function logSpeechDiagnostic(kind, input) {
  const payload = createSpeechDiagnosticRecord(kind, input);
  const line = JSON.stringify(payload);
  speechLogQueue = speechLogQueue
    .catch(() => undefined)
    .then(() => appendFile(speechDiagnosticsPath, `${line}\n`, 'utf8'))
    .catch(() => undefined);
  if (payload.ok && !payload.fallback) console.log(line);
  else console.warn(line);
}
ipcMain.handle('monarch:copy-sharing-token', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  const tokenPath = path.join(workspaceRoot, 'secrets', 'oscar_token.txt');
  if (!existsSync(tokenPath)) {
    return { ok: false, error: 'token-missing' };
  }
  const token = (await readFile(tokenPath, 'utf8')).trim().replace(/^\uFEFF/, '');
  if (!token) {
    return { ok: false, error: 'token-empty' };
  }
  clipboard.writeText(token);
  return { ok: true };
});
ipcMain.handle('monarch:pick-security-file', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return null;
  }
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите файл для проверки Monarch Security',
    properties: ['openFile'],
    buttonLabel: 'Проверить файл',
  });
  if (selection.canceled || selection.filePaths.length !== 1) {
    return null;
  }
  return selection.filePaths[0];
});
ipcMain.handle('monarch:pick-coder-folder', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return null;
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбери папку проекта для Coder Mode',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Открыть как проект',
  });
  if (selection.canceled || selection.filePaths.length !== 1) return null;
  return selection.filePaths[0];
});
ipcMain.handle('monarch:open-safe', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false };
  const state = await showSafeWindow();
  return { ok: true, ...state };
});
ipcMain.handle('monarch:open-safe-settings', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false };
  const state = await showSafeWindow();
  safeWindow?.webContents.send('monarch-safe:open-settings');
  return { ok: true, ...state };
});
ipcMain.handle('monarch:safe-shortcut-status', (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false, created: false };
  if (process.platform !== 'win32') return { ok: false, created: false, error: 'unsupported-platform' };
  const shortcut = safeShortcutPath(app.getPath('desktop'));
  return { ok: true, created: existsSync(shortcut), path: shortcut };
});
ipcMain.handle('monarch:safe-shortcut-create', (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false, created: false };
  if (process.platform !== 'win32') return { ok: false, created: false, error: 'unsupported-platform' };
  const shortcut = safeShortcutPath(app.getPath('desktop'));
  const details = buildSafeShortcutDetails({
    executablePath: process.execPath,
    appEntryPath: path.join(__dirname, 'main.mjs'),
    iconPath: existsSync(safeIconPath) ? safeIconPath : process.execPath,
    packaged: app.isPackaged,
  });
  const created = shell.writeShortcutLink(shortcut, 'create', details);
  return { ok: created, created, path: shortcut };
});
ipcMain.handle('monarch:safe-shortcut-remove', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false, created: false };
  if (process.platform !== 'win32') return { ok: false, created: false, error: 'unsupported-platform' };
  const shortcut = safeShortcutPath(app.getPath('desktop'));
  await rm(shortcut, { force: true });
  return { ok: true, created: false, path: shortcut };
});
ipcMain.handle('monarch:safe-chat-status', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { runtime: false, unlocked: false };
  if (!safeProcess) return { runtime: false, unlocked: false };
  return { runtime: true, ...await requestSafeService('chatStatus') };
});
ipcMain.handle('monarch:safe-chat-list', async (event) => {
  assertTrustedMainRenderer(event);
  return requestSafeService('chatList');
});
ipcMain.handle('monarch:safe-chat-read', async (event, value = {}) => {
  assertTrustedMainRenderer(event);
  return requestSafeService('chatRead', { id: String(value?.id || ''), kind: String(value?.kind || 'oscar') });
});
ipcMain.handle('monarch:safe-chat-upsert', async (event, value = {}) => {
  assertTrustedMainRenderer(event);
  return requestSafeService('chatUpsert', { record: value?.record });
});
ipcMain.handle('monarch:safe-chat-delete', async (event, value = {}) => {
  assertTrustedMainRenderer(event);
  return requestSafeService('chatDelete', { id: String(value?.id || ''), kind: String(value?.kind || 'oscar') });
});
ipcMain.handle('monarch:safe-chat-lock', async (event) => {
  assertTrustedMainRenderer(event);
  return requestSafeService('chatLock');
});
ipcMain.handle('monarch-safe:authorize-delete', async (event, value = {}) => {
  if (!safeWindow || safeWindow.isDestroyed() || event.sender.id !== safeWindow.webContents.id || !safeCapabilityKey) return null;
  const batch = Array.isArray(value?.files)
    ? value.files.slice(0, 100).map((file) => ({
      id: String(file?.id || ''),
      name: String(file?.name || 'файл').replace(/[\r\n\t]/g, ' ').slice(0, 160),
    })).filter((file) => /^[0-9a-f-]{36}$/i.test(file.id))
    : [];
  if (batch.length) {
    const confirmation = await dialog.showMessageBox(safeWindow, {
      type: 'warning',
      title: 'Monarch Safe · удаление файлов',
      message: `Удалить выбранные файлы (${batch.length})?`,
      detail: `${batch.slice(0, 4).map((file) => `• ${file.name}`).join('\n')}${batch.length > 4 ? `\n• и ещё ${batch.length - 4}` : ''}\n\nАктивные ключи версий будут уничтожены. Операция необратима внутри хранилища.`,
      buttons: ['Отмена', 'Удалить'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1 || !safeCapabilityKey) return null;
    return {
      tokens: batch.map((file) => ({
        id: file.id,
        capabilityToken: createSafeCapabilityToken({ key: safeCapabilityKey, action: 'deleteFile', resourceId: file.id }),
      })),
    };
  }
  const fileId = String(value?.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return null;
  const name = String(value?.name || 'выбранный файл').replace(/[\r\n\t]/g, ' ').slice(0, 160);
  const shortId = fileId.slice(0, 8);
  const confirmation = await dialog.showMessageBox(safeWindow, {
    type: 'warning',
    title: 'Monarch Safe · удаление',
    message: `Удалить «${name}» (${shortId}) и уничтожить активный ключ этой версии?`,
    detail: 'Операция необратима внутри активного хранилища. Физические копии в snapshots и backups не контролируются.',
    buttons: ['Отмена', 'Удалить'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (confirmation.response !== 1 || !safeCapabilityKey) return null;
  return createSafeCapabilityToken({ key: safeCapabilityKey, action: 'deleteFile', resourceId: fileId });
});
ipcMain.handle('monarch-safe:authorize-write', async (event, value = {}) => {
  if (!safeWindow || safeWindow.isDestroyed() || event.sender.id !== safeWindow.webContents.id || !safeCapabilityKey) return null;
  const fileId = String(value?.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return null;
  const name = String(value?.name || 'выбранный файл').replace(/[\r\n\t]/g, ' ').slice(0, 160);
  const shortId = fileId.slice(0, 8);
  const confirmation = await dialog.showMessageBox(safeWindow, {
    type: 'warning',
    title: 'Monarch Safe · новая версия',
    message: `Сохранить изменения в «${name}» (${shortId})?`,
    detail: 'Safe сначала запишет новую зашифрованную генерацию, затем атомарно переключит manifest и уничтожит активный ключ предыдущей версии.',
    buttons: ['Отмена', 'Сохранить'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (confirmation.response !== 1 || !safeCapabilityKey) return null;
  return createSafeCapabilityToken({ key: safeCapabilityKey, action: 'writeFile', resourceId: fileId });
});
ipcMain.on('monarch-safe:sealed', (event) => {
  if (!safeWindow || safeWindow.isDestroyed() || event.sender.id !== safeWindow.webContents.id) return;
  if (safeSecurityPolicy.clearClipboardOnLock) clipboard.clear();
});

async function startDesktopApp() {
  await mkdir(path.join(workspaceRoot, 'runtime'), { recursive: true });
  // Spawn the Qwen worker synchronously before the runtime can prewarm other
  // local models. Renderer callers await this exact shared promise via IPC.
  if (!smokeMode && !safeEntryQaMode && !safeLaunchMode) void speechWarmup.start();
  runtimeUrl = await startRuntime();

  if (smokeMode) {
    const [health, capabilityPayload] = await Promise.all([
      fetchJson(`${runtimeUrl}/api/health`),
      fetchJson(`${runtimeUrl}/api/capabilities`),
    ]);
    const loadRecords = Array.isArray(health?.loadRecords) ? health.loadRecords : [];
    const capabilities = Array.isArray(capabilityPayload?.capabilities)
      ? capabilityPayload.capabilities.length
      : 0;
    console.log(JSON.stringify({
      ok: Boolean(health?.ok),
      runtimeUrl,
      modules: loadRecords.filter((record) => record?.status === 'loaded').length,
      capabilities,
    }, null, 2));
    stopRuntime();
    app.quit();
    return;
  }

  Menu.setApplicationMenu(createApplicationMenu());
  powerMonitor.on('lock-screen', () => closeSafeForSystemBoundary());
  powerMonitor.on('suspend', () => closeSafeForSystemBoundary());
  if (!safeEntryQaMode && !safeLaunchMode) createTray();
  if (safeLaunchMode) await showSafeWindow();
  else await createMainWindow();
  if (safeEntryQaMode) await runSafeEntryQa();
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: appName,
    icon: path.join(workspaceRoot, 'assets', 'icon.png'),
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f3f5f7',
    show: false,
    ...(safeEntryQaMode ? { x: -32000, y: -32000, opacity: 0, focusable: false, skipTaskbar: true } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    rebuildTrayMenu();
  });

  if (safeEntryQaMode) {
    mainWindow.webContents.on('preload-error', (_event, preload, error) => {
      safeEntryQaEvents.push({ type: 'preload-error', preload, message: error?.message || String(error) });
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      safeEntryQaEvents.push({ type: 'did-fail-load', code, description, validatedUrl, isMainFrame });
    });
  }

  mainWindow.on('close', (event) => {
    if (!shouldHideToTrayOnClose({ smokeMode, shuttingDown, quitRequested })) {
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
    rebuildTrayMenu();
    showTrayHintOnce();
  });

  mainWindow.on('show', rebuildTrayMenu);
  mainWindow.on('hide', rebuildTrayMenu);

  mainWindow.on('closed', () => {
    mainWindow = null;
    rebuildTrayMenu();
  });

  configureMainWindowSecurity(mainWindow, runtimeUrl);

  await mainWindow.loadURL(runtimeUrl);
}

async function showMainWindow() {
  if (!runtimeUrl || shuttingDown || quitRequested) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  rebuildTrayMenu();
}

async function showSafeWindow() {
  if (shuttingDown || quitRequested) throw new Error('Monarch is shutting down.');
  if (safeWindow && !safeWindow.isDestroyed()) {
    if (safeWindow.isMinimized()) safeWindow.restore();
    presentSafeWindow();
    return { created: false, visible: safeWindow.isVisible() };
  }
  if (![safePreloadPath, safeRuntimePath, safeIndexPath].every(existsSync)) {
    throw new Error('Monarch Safe runtime files are missing.');
  }

  const launchedSafeProcess = utilityProcess.fork(safeRuntimePath, [], {
    serviceName: 'Monarch Safe Runtime',
    env: { MONARCH_SAFE_ROOT: safeRoot },
    stdio: 'ignore',
  });
  const launchedCapabilityKey = randomBytes(32);
  safeProcess = launchedSafeProcess;
  safeCapabilityKey = launchedCapabilityKey;
  let launchedSafeWindow = null;
  launchedSafeProcess.on('message', (message) => handleSafeServiceMessage(launchedSafeProcess, message));
  launchedSafeProcess.once('exit', () => {
    launchedCapabilityKey.fill(0);
    rejectSafeServiceRequests(launchedSafeProcess, 'Monarch Safe runtime closed.');
    if (!ownsSafeSessionResource(safeProcess, launchedSafeProcess)) return;
    safeProcess = null;
    if (ownsSafeSessionResource(safeCapabilityKey, launchedCapabilityKey)) safeCapabilityKey = null;
    emitSafeChatStatus({ runtime: false, unlocked: false });
    if (ownsSafeSessionResource(safeWindow, launchedSafeWindow) && !launchedSafeWindow.isDestroyed()) launchedSafeWindow.destroy();
  });

  launchedSafeWindow = new BrowserWindow({
    title: 'Monarch Safe',
    icon: existsSync(safeIconPath) ? safeIconPath : path.join(workspaceRoot, 'assets', 'icon.png'),
    width: 1520,
    height: 960,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#080808',
    show: false,
    ...(safeEntryQaMode ? { x: -32000, y: -32000, opacity: 0, focusable: false, skipTaskbar: true } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: safePreloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: 'monarch-safe-isolated',
    },
  });
  safeWindow = launchedSafeWindow;
  launchedSafeWindow.setMenu(null);
  launchedSafeWindow.setContentProtection(true);
  configureSafeWindowSecurity(launchedSafeWindow);
  launchedSafeWindow.on('minimize', () => {
    if (!ownsSafeSessionResource(safeWindow, launchedSafeWindow)) return;
    if (safeSecurityPolicy.minimizeAction === 'close') {
      closeSafeForSystemBoundary(launchedSafeWindow, launchedSafeProcess, launchedCapabilityKey);
    } else if (safeSecurityPolicy.minimizeAction === 'lock') {
      launchedSafeWindow.webContents.send('monarch-safe:force-lock');
    }
  });
  launchedSafeWindow.on('hide', () => {
    if (!ownsSafeSessionResource(safeWindow, launchedSafeWindow)) return;
    if (safeSecurityPolicy.minimizeAction === 'close') closeSafeForSystemBoundary(launchedSafeWindow, launchedSafeProcess, launchedCapabilityKey);
    else if (safeSecurityPolicy.minimizeAction === 'lock') launchedSafeWindow.webContents.send('monarch-safe:force-lock');
  });
  launchedSafeWindow.on('blur', () => {
    if (ownsSafeSessionResource(safeWindow, launchedSafeWindow) && safeSecurityPolicy.lockOnBlur) {
      launchedSafeWindow.webContents.send('monarch-safe:force-lock');
    }
  });
  launchedSafeWindow.on('closed', () => {
    if (ownsSafeSessionResource(safeWindow, launchedSafeWindow)) safeWindow = null;
    stopSafeRuntime(launchedSafeProcess, launchedCapabilityKey);
    if (safeLaunchMode && !mainWindow) {
      quitRequested = true;
      app.quit();
    }
  });

  let channel = null;
  let deviceKey = null;
  try {
    await launchedSafeWindow.loadFile(safeIndexPath);
    channel = new MessageChannelMain();
    deviceKey = await loadOrCreateSafeDeviceKey({ rootPath: safeRoot, safeStorage });
    if (!ownsSafeSessionResource(safeProcess, launchedSafeProcess)
      || !ownsSafeSessionResource(safeWindow, launchedSafeWindow)
      || launchedSafeWindow.isDestroyed()) {
      throw new Error('Monarch Safe session closed during startup.');
    }
    launchedSafeProcess.postMessage({
      type: 'connect',
      deviceKey: deviceKey ? new Uint8Array(deviceKey) : null,
      capabilityKey: new Uint8Array(launchedCapabilityKey),
    }, [channel.port1]);
    deviceKey?.fill(0);
    deviceKey = null;
    launchedSafeWindow.webContents.postMessage('monarch-safe:connect', null, [channel.port2]);
    presentSafeWindow(launchedSafeWindow);
    return { created: true, visible: launchedSafeWindow.isVisible() };
  } catch (error) {
    deviceKey?.fill(0);
    try { channel?.port1.close(); } catch { /* channel was transferred or already closed */ }
    try { channel?.port2.close(); } catch { /* channel was transferred or already closed */ }
    if (!launchedSafeWindow.isDestroyed()) launchedSafeWindow.destroy();
    else stopSafeRuntime(launchedSafeProcess, launchedCapabilityKey);
    throw error;
  }
}

function presentSafeWindow(targetWindow = safeWindow) {
  if (!ownsSafeSessionResource(safeWindow, targetWindow) || targetWindow.isDestroyed()) return;
  targetWindow.show();
  targetWindow.focus();
  targetWindow.moveTop();
}

async function runSafeEntryQa() {
  const outputRoot = path.join(workspaceRoot, 'output', 'safe-entry-qa');
  const reportPath = path.join(outputRoot, 'qa-report.json');
  await mkdir(outputRoot, { recursive: true });
  let report;

  try {
    await waitForSafeEntryQa(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      return mainWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('[data-open-safe]'))`,
        true,
      );
    }, 15000, 'Main UI Safe entry did not become ready.');
    await waitForSafeEntryQa(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      return mainWindow.webContents.executeJavaScript(
        `typeof window.monarchDesktop?.openSafe === 'function'`,
        true,
      );
    }, 5000, 'Desktop preload did not expose the Safe bridge.');
    await waitForSafeEntryQa(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      return mainWindow.webContents.executeJavaScript(
        `document.querySelector('.app-shell')?.classList.contains('startup-complete') === true`,
        true,
      );
    }, 5000, 'Main UI startup motion did not yield the interactive shell.');

    const entryState = await mainWindow.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-open-safe]');
      const bridgeAvailable = typeof window.monarchDesktop?.openSafe === 'function';
      button?.click();
      return { buttonFound: Boolean(button), bridgeAvailable };
    })()`, true);

    await waitForSafeEntryQa(
      () => Boolean(safeWindow && !safeWindow.isDestroyed()),
      15000,
      'Clicking the main UI Safe entry did not create the isolated Safe window.',
    );
    await waitForSafeEntryQa(async () => {
      if (!safeWindow || safeWindow.isDestroyed()) return false;
      return safeWindow.webContents.executeJavaScript(`(() => {
        const setup = document.querySelector('#setup-form');
        return Boolean(window.monarchSafe) && Boolean(setup) && !setup.hidden;
      })()`, true);
    }, 15000, 'Safe preload/runtime did not reach clean first-run setup.');
    await waitForSafeEntryQa(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      return mainWindow.webContents.executeJavaScript(
        `document.querySelector('#safe-launch-feedback')?.dataset.kind === 'opened'`,
        true,
      );
    }, 5000, 'Main UI did not confirm that the Safe window opened.');

    const [mainFeedback, safeState] = await Promise.all([
      mainWindow.webContents.executeJavaScript(`(() => {
        const node = document.querySelector('#safe-launch-feedback');
        return {
          kind: node?.dataset.kind || '',
          visible: Boolean(node && !node.hidden),
          title: document.querySelector('#safe-launch-feedback-title')?.textContent || '',
          detail: document.querySelector('#safe-launch-feedback-detail')?.textContent || '',
        };
      })()`, true),
      safeWindow.webContents.executeJavaScript(`(() => {
        const setup = document.querySelector('#setup-form');
        return {
          bridgeAvailable: Boolean(window.monarchSafe),
          firstRunSetupVisible: Boolean(setup && !setup.hidden),
          title: document.title,
          documentUrl: location.href,
        };
      })()`, true),
    ]);

    mainWindow.setOpacity(1);
    safeWindow.setOpacity(1);
    await sleep(450);

    const [mainCapture, safeCapture] = await Promise.all([
      mainWindow.webContents.capturePage(),
      safeWindow.webContents.capturePage(),
    ]);
    await Promise.all([
      writeFile(path.join(outputRoot, 'main-safe-entry.png'), mainCapture.toPNG()),
      writeFile(path.join(outputRoot, 'safe-first-open.png'), safeCapture.toPNG()),
    ]);

    report = {
      ok: true,
      checkedAt: new Date().toISOString(),
      entryState,
      mainFeedback,
      safeWindow: {
        created: true,
        visible: safeWindow.isVisible(),
        isolatedDocument: safeState.documentUrl === pathToFileURL(safeIndexPath).toString(),
        ...safeState,
      },
    };
  } catch (error) {
    process.exitCode = 1;
    let diagnostics = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      diagnostics = await mainWindow.webContents.executeJavaScript(`(() => ({
        readyState: document.readyState,
        url: location.href,
        title: document.title,
        buttonFound: Boolean(document.querySelector('[data-open-safe]')),
        bridgeKeys: Object.keys(window.monarchDesktop || {}),
        bodyPreview: document.body?.innerText?.slice(0, 500) || '',
      }))()`, true).catch((diagnosticError) => ({ error: diagnosticError?.message || String(diagnosticError) }));
      const capture = await mainWindow.webContents.capturePage().catch(() => null);
      if (capture) await writeFile(path.join(outputRoot, 'main-safe-entry-failure.png'), capture.toPNG());
    }
    report = {
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      diagnostics,
      events: safeEntryQaEvents,
    };
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
    shuttingDown = true;
    quitRequested = true;
    shutdownComplete = true;
    if (safeWindow && !safeWindow.isDestroyed()) safeWindow.destroy();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    stopSafeRuntime();
    stopRuntime();
    queueSafeEntryQaProfileCleanup();
    if (report?.ok) app.quit();
    else app.exit(1);
  }
}

function queueSafeEntryQaProfileCleanup() {
  if (!safeEntryQaProfile) return;
  const script = `
    const fs = require('node:fs');
    const target = ${JSON.stringify(safeEntryQaProfile)};
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
    // The next QA run can safely remove an old test-only profile.
  }
}

async function waitForSafeEntryQa(predicate, timeoutMs, message) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(40);
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}` : '';
  throw new Error(`${message}${detail}`);
}

function assertTrustedMainRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
    const error = new Error('Untrusted renderer cannot access encrypted chats.');
    error.code = 'untrusted-renderer';
    throw error;
  }
}

function requestSafeService(action, payload = {}) {
  const targetProcess = safeProcess;
  if (!targetProcess) {
    const error = new Error('Monarch Safe is closed. Open and unlock Safe first.');
    error.code = 'safe-runtime-closed';
    return Promise.reject(error);
  }
  safeServiceSequence += 1;
  const id = `safe-chat-${Date.now().toString(36)}-${safeServiceSequence.toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      safeServicePending.delete(id);
      const error = new Error('Monarch Safe chat operation timed out.');
      error.code = 'safe-service-timeout';
      reject(error);
    }, 60_000);
    safeServicePending.set(id, { process: targetProcess, resolve, reject, timer });
    try {
      targetProcess.postMessage({ type: 'service-request', id, action, payload });
    } catch (error) {
      clearTimeout(timer);
      safeServicePending.delete(id);
      reject(error);
    }
  });
}

function handleSafeServiceMessage(targetProcess, message) {
  const payload = message?.data?.type ? message.data : message;
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'service-event') {
    if (!ownsSafeSessionResource(safeProcess, targetProcess)) return;
    if (payload.data?.securityPolicy) safeSecurityPolicy = normalizeSafeSecurityPolicy(payload.data.securityPolicy);
    emitSafeChatStatus({ runtime: true, ...(payload.data || {}) });
    return;
  }
  if (payload.type !== 'service-response' || typeof payload.id !== 'string') return;
  const pending = safeServicePending.get(payload.id);
  if (!pending || !ownsSafeSessionResource(pending.process, targetProcess)) return;
  clearTimeout(pending.timer);
  safeServicePending.delete(payload.id);
  if (payload.ok === true) {
    pending.resolve(payload.result);
    return;
  }
  const error = new Error(payload.error?.message || 'Monarch Safe rejected the chat operation.');
  error.code = payload.error?.code || 'safe-chat-operation-failed';
  if (payload.error?.details !== undefined) error.details = payload.error.details;
  pending.reject(error);
}

function rejectSafeServiceRequests(targetProcess, message) {
  for (const [id, pending] of safeServicePending) {
    if (!ownsSafeSessionResource(pending.process, targetProcess)) continue;
    clearTimeout(pending.timer);
    safeServicePending.delete(id);
    const error = new Error(message);
    error.code = 'safe-runtime-closed';
    pending.reject(error);
  }
}

function emitSafeChatStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('monarch:safe-chat-status-changed', status);
}

function closeSafeForSystemBoundary(targetWindow = safeWindow, targetProcess = safeProcess, targetCapabilityKey = safeCapabilityKey) {
  const canCloseWindow = Boolean(
    targetWindow
    && typeof targetWindow.isDestroyed === 'function'
    && typeof targetWindow.destroy === 'function',
  );
  if (canCloseWindow && !targetWindow.isDestroyed()) targetWindow.destroy();
  else stopSafeRuntime(targetProcess, targetCapabilityKey);
}

function configureSafeWindowSecurity(window) {
  const allowedDocumentUrl = pathToFileURL(safeIndexPath).toString();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== allowedDocumentUrl) event.preventDefault();
  });
  const isolatedSession = window.webContents.session;
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  if (!configuredSafeSessions.has(isolatedSession)) {
    configuredSafeSessions.add(isolatedSession);
    isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isAllowedSafeResourceUrl(details.url, safeUiRoot) });
    });
    isolatedSession.on('will-download', (event) => event.preventDefault());
  }
}

function stopSafeRuntime(targetProcess = safeProcess, targetCapabilityKey = safeCapabilityKey) {
  targetCapabilityKey?.fill(0);
  if (!ownsSafeSessionResource(safeProcess, targetProcess)) return;
  const processToStop = safeProcess;
  safeProcess = null;
  if (ownsSafeSessionResource(safeCapabilityKey, targetCapabilityKey)) safeCapabilityKey = null;
  rejectSafeServiceRequests(processToStop, 'Monarch Safe runtime closed.');
  emitSafeChatStatus({ runtime: false, unlocked: false });
  try { processToStop.kill(); } catch { /* process already stopped */ }
}

function createTray() {
  if (smokeMode || tray) return;
  const iconPath = path.join(workspaceRoot, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const source = nativeImage.createFromPath(iconPath);
  const icon = process.platform === 'win32' ? source.resize({ width: 16, height: 16 }) : source;
  tray = new Tray(icon);
  tray.setToolTip('Monarch · защита работает в фоне');
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
      rebuildTrayMenu();
    } else {
      void showMainWindow();
    }
  });
  tray.on('double-click', () => void showMainWindow());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: trayWindowLabel(visible),
      click: () => {
        if (visible) {
          mainWindow?.hide();
          rebuildTrayMenu();
        } else {
          void showMainWindow();
        }
      },
    },
    { label: 'Защита работает в фоне', enabled: false },
    { type: 'separator' },
    {
      label: 'Полностью закрыть Monarch',
      click: () => {
        quitRequested = true;
        app.quit();
      },
    },
  ]));
}

function showTrayHintOnce() {
  if (!tray || trayHintShown || process.platform !== 'win32') return;
  trayHintShown = true;
  tray.displayBalloon({
    title: 'Monarch работает в фоне',
    content: 'Открой Monarch или полностью заверши его через иконку в системном трее.',
    iconType: 'info',
  });
}

function configureMainWindowSecurity(window, trustedRuntimeUrl) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (isTrustedRuntimeUrl(navigationUrl, trustedRuntimeUrl)) {
      return;
    }
    event.preventDefault();
    void openExternalSafely(navigationUrl);
  });

  const electronSession = window.webContents.session;
  electronSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const requestingUrl = details.requestingUrl || webContents.getURL();
    callback(shouldAllowDesktopPermission({
      permission,
      requestingUrl,
      runtimeUrl: trustedRuntimeUrl,
      mediaTypes: Array.isArray(details.mediaTypes) ? details.mediaTypes : [],
      isMainFrame: details.isMainFrame !== false,
      isMainWebContents: webContents.id === window.webContents.id,
    }));
  });
  electronSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
    const requestingUrl = details.requestingUrl
      || details.securityOrigin
      || requestingOrigin
      || webContents?.getURL()
      || '';
    return shouldAllowDesktopPermission({
      permission,
      requestingUrl,
      runtimeUrl: trustedRuntimeUrl,
      mediaTypes: details.mediaType ? [details.mediaType] : [],
      isMainFrame: details.isMainFrame !== false,
      isMainWebContents: webContents?.id === window.webContents.id,
    });
  });
}

async function openExternalSafely(value) {
  const url = readExternalHttpUrl(value);
  if (!url) return false;
  await shell.openExternal(url).catch(() => undefined);
  return true;
}

async function startRuntime() {
  const nodePath = resolveNodeExecutable();
  const runtimeLaunch = resolveRuntimeLaunch({ workspaceRoot });

  const port = await findFreePort(4317, 40);
  const env = {
    ...process.env,
    MONARCH_UI_PORT: String(port),
    MONARCH_STRICT_PORT: '1',
    MONARCH_STARTUP_TRACE: '1',
  };
  // Voice Mode owns STT preparation after the shared Qwen warmup settles.
  // Do not let an inherited shell flag race Vosk/sherpa allocation with TTS.
  delete env.MONARCH_STT_PREWARM_ON_ACTIVATE;
  const outPath = path.join(workspaceRoot, 'runtime', `electron-server-${port}.out.log`);
  const errPath = path.join(workspaceRoot, 'runtime', `electron-server-${port}.err.log`);
  const out = await import('node:fs').then((fs) => fs.createWriteStream(outPath, { flags: 'a' }));
  const err = await import('node:fs').then((fs) => fs.createWriteStream(errPath, { flags: 'a' }));
  out.write(`[desktop] Runtime entry: ${runtimeLaunch.kind} ${runtimeLaunch.entryPath}\n`);

  runtimeReady = false;
  let spawnError = null;
  const launchedProcess = spawn(nodePath, [...runtimeLaunch.args, 'serve', '--port', String(port)], {
    cwd: workspaceRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess = launchedProcess;
  launchedProcess.stdout.pipe(out);
  launchedProcess.stderr.pipe(err);
  launchedProcess.once('error', (error) => {
    spawnError = error;
  });
  launchedProcess.once('exit', (code, signal) => {
    if (!shuttingDown && !smokeMode && runtimeReady) {
      void showFatalError(new Error(`Monarch runtime exited (${code ?? signal ?? 'unknown'}).`));
      app.quit();
    }
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForRuntimeReady({
      fetchHealth: () => fetchJson(`${url}/api/health`),
      getProcessExit: () => {
        if (spawnError) return { error: spawnError };
        if (launchedProcess.exitCode !== null || launchedProcess.signalCode !== null) {
          return {
            code: launchedProcess.exitCode,
            signal: launchedProcess.signalCode,
          };
        }
        return null;
      },
      readErrorLog: () => readRuntimeLogTail(errPath),
      errorLogPath: errPath,
      readOutputLog: () => readRuntimeLogTail(outPath),
      outputLogPath: outPath,
      timeoutMs: 60_000,
    });
    runtimeReady = true;
    return url;
  } catch (error) {
    if (serverProcess === launchedProcess) stopRuntime();
    throw error;
  }
}

function stopRuntime() {
  runtimeReady = false;
  if (!serverProcess || serverProcess.killed) {
    return;
  }

  try {
    serverProcess.kill();
  } catch {
    // Best effort during desktop shutdown.
  } finally {
    serverProcess = null;
  }
}

async function shutdownDesktop() {
  shuttingDown = true;
  speechOutput.dispose();
  await speechLogQueue.catch(() => undefined);
  if (safeWindow && !safeWindow.isDestroyed()) safeWindow.destroy();
  stopSafeRuntime();
  // Safe entry QA can attach to an already running production Oscar backend.
  // It must never shut down a runtime owned by the real Desktop instance.
  // A standalone Safe window is a client of the already-running Monarch services.
  // Closing that shortcut must never tear down Oscar for the main Monarch app.
  if (!safeEntryQaMode && !safeLaunchMode) await stopOscarBackend().catch(() => undefined);
  stopRuntime();
}

async function stopOscarBackend() {
  const tokenPath = path.join(workspaceRoot, 'secrets', 'oscar_token.txt');
  if (!existsSync(tokenPath)) {
    return;
  }
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!token) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('http://127.0.0.1:7861/api/backend/stop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Oscar-Token': token,
      },
      body: '{}',
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Oscar shutdown returned HTTP ${response.status}.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function createApplicationMenu() {
  return Menu.buildFromTemplate([
    {
      label: appName,
      submenu: [
        {
          label: 'Hide to system tray',
          click: () => {
            mainWindow?.hide();
            rebuildTrayMenu();
          },
        },
        {
          label: 'Copy Runtime URL',
          click: () => clipboard.writeText(runtimeUrl),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ]);
}

async function readRuntimeLogTail(filePath, maxCharacters = 6_000) {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.slice(-maxCharacters);
  } catch {
    return '';
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error(`Timeout fetching ${url}`));
    });
  });
}

function findFreePort(startPort, attempts) {
  const candidates = Array.from({ length: attempts }, (_value, index) => startPort + index);
  return candidates.reduce(
    (chain, port) => chain.catch(() => assertPortFree(port)),
    Promise.reject(new Error('No candidate port tested yet.'))
  );
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      server.close(() => resolve(port));
    });
    server.listen(port, '127.0.0.1');
  });
}

function resolveNodeExecutable() {
  const candidates = [
    process.env.MONARCH_NODE_PATH,
    ...resolveProjectNodeExecutables(),
    process.env.npm_node_execpath,
    'D:\\node js\\node.exe',
    'C:\\Program Files\\nodejs\\node.exe',
    'node',
  ].filter(Boolean);

  return candidates.find((candidate) => candidate === 'node' || existsSync(candidate)) || 'node';
}

function resolveProjectNodeExecutables() {
  const toolsDir = path.join(workspaceRoot, '.tools');
  if (!existsSync(toolsDir)) {
    return [];
  }

  try {
    return readdirSync(toolsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^node-v\d+\.\d+\.\d+-win-x64$/.test(entry.name))
      .map((entry) => path.join(toolsDir, entry.name, 'node.exe'))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

async function showFatalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (smokeMode || !app.isReady()) {
    console.error(message);
    return;
  }

  await dialog.showMessageBox({
    type: 'error',
    title: 'Monarch failed to start',
    message: 'Monarch failed to start.',
    detail: message,
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
