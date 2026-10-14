import { installMainDiagnosticsMirror } from './main-diagnostics-log.mjs';
import { renameWithRetry } from './windows-rename.mjs';
import {
  app,
  BrowserWindow,
  Menu,
  MessageChannelMain,
  Notification,
  Tray,
  WebContentsView,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  utilityProcess,
} from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createTelegramSecretBroker, startTelegramSecretServer } from './telegram-secret-broker.mjs';
import { createReminderDelivery } from './reminder-delivery.mjs';
import { createTelegramCloudflareSetup } from './telegram-cloudflare-setup.mjs';
import { createGmailSecretBroker, startGmailSecretServer } from './gmail-secret-broker.mjs';
import { createGmailOAuthController } from './gmail-oauth-controller.mjs';
import { createGitHubSecretBroker, startGitHubSecretServer } from './github-secret-broker.mjs';
import { createCalendarSecretBroker, startCalendarSecretServer } from './calendar-secret-broker.mjs';
import { createCalendarOAuthController } from './calendar-oauth-controller.mjs';
import { createServiceIntegrationRegistry, registerServiceIntegrationIpc } from './service-integration-registry.mjs';
import { restrictProtectedIntegrationAcl } from './protected-integration-acl.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isTrustedRuntimeUrl,
  readExternalHttpUrl,
  shouldOpenContentLink,
  shouldAllowDesktopPermission,
} from './security-policy.mjs';
import { shouldHideToTrayOnClose, trayWindowLabel } from './tray-policy.mjs';
import {
  isAllowedImageProviderUrl,
  resolveEmbeddedImageProviderBounds,
  resolveImageProviderEntryUrl,
  resolveImageProviderZoom,
} from './image-provider-policy.mjs';
import { createImageProviderDownloadHandler } from './image-provider-download.mjs';
import { bugReportGmailUrl, bugReportMailto, composeBugReport } from './bug-report.mjs';
import { loadOrCreateSafeDeviceKey } from '../safe/device-binding.mjs';
import { authorizeSafeFiles } from './safe-file-authorization.mjs';
import { normalizeSafeSecurityPolicy } from '../safe/security-policy.mjs';
import { buildSafeShortcutDetails, safeShortcutPath } from './safe-shortcut.mjs';
import { isAllowedSafeResourceUrl } from './safe-window-policy.mjs';
import { ownsSafeSessionResource, shouldLockSafeOnBlur } from './safe-session-policy.mjs';
import { resolveSafeMainStorageRoot } from './safe-storage-path.mjs';
import { writeSafeExport } from './safe-export.mjs';
import { enforceSafeHostLock } from './safe-host-lock.mjs';
import { prepareDevelopmentMaxBundle, prepareDevelopmentRuntime } from './development-runtime.mjs';
import { prepareDevelopmentProfile } from './development-profile.mjs';
import { waitForRuntimeReady } from './runtime-startup.mjs';
import { createRuntimeRecoveryPolicy } from './runtime-recovery-policy.mjs';
import { prepareAstraRuntimePilotEnvironment, resolveAstraRuntimePilotMode,
  resolveAstraTelegramPilotMode } from './astra-pilot-policy.mjs';
import { loadOrCreateAstraJournalKey } from './astra-journal-key.mjs';
import { acquireAstraProductRendererGuard, controlAstraProductComputerActions, controlAstraProductWindows, issueAstraProductComputerAction,
  pickAstraProductTarget, pickAstraProductWindow, pickAstraTelegramTarget } from './astra-product-host.mjs';
import { createAstraMaxDesktopBridge, resolveAstraMaxSourceModelSelection,
  resolveAstraMaxSourcePreviewMode } from './astra-max-desktop-bridge.mjs';
import { startAstraMaxModelServer } from './astra-max-model-server.mjs';
import { startAstraMaxNativeServer } from './astra-max-native-server.mjs';
import { isOwnerModeSuspended, prepareOwnerAuthoritySession, setOwnerModeSuspended } from './owner-authority.mjs';
import {
  createOwnerDeviceRequest,
  exportOwnerDeviceRequest,
  importOwnerEntitlement,
  readOwnerEnrollmentStatus,
} from './owner-enrollment.mjs';
import {
  createSpeechDiagnosticRecord,
  createSpeechWarmupCoordinator,
  createWindowsSpeechOutput,
} from './speech-output.mjs';
import { MONARCH_RELEASE_PUBLIC_KEYS, createMonarchUpdateEndpoints } from './update-config.mjs';
import { createUpdateDemoRuntime } from './update-demo.mjs';
import { MonarchUpdateService, startBackgroundUpdateChecks } from './update-service.mjs';
import { resolveDesktopUpdatePolicy } from './update-policy.mjs';
import { createTransactionalInstallerCoordinator } from './installer-coordinator.mjs';
import {
  preparePostUpdateTrial,
  prepareRollback,
  writeHealthAcknowledgement,
} from './update-transaction.mjs';
import { migrateLegacySecretsForCurrentUser } from './protected-storage-migration.mjs';
import { createOscarApiKeyStore } from './oscar-api-key.mjs';
import { createProfileDataKeyStore, deriveProfileStoreKey } from './profile-data-key.mjs';
import { createProfileKeyRecovery, generateRecoveryCode, wantsCopy } from './profile-key-recovery.mjs';
import { cleanupRetainedUpdateComponents } from './retention-cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..', '..');
const desktopIconPath = path.join(
  workspaceRoot,
  'assets',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png',
);
const workspacePackage = readJsonFileIfPresent(path.join(workspaceRoot, 'package.json'));
const safeEntryQaMode = process.argv.includes('--safe-entry-qa');
const updateDemoMode = process.argv.includes('--update-demo') && !app.isPackaged;
const desktopAcceptanceMode = process.argv.includes('--desktop-acceptance') && !app.isPackaged;
const smokeMode = process.argv.includes('--smoke');
const astraRuntimePilotMode = resolveAstraRuntimePilotMode({ argv: process.argv, isPackaged: app.isPackaged,
  isolatedMode: safeEntryQaMode || updateDemoMode || desktopAcceptanceMode || smokeMode });
const astraTelegramPilotMode = resolveAstraTelegramPilotMode({ argv: process.argv, isPackaged: app.isPackaged,
  isolatedMode: safeEntryQaMode || updateDemoMode || desktopAcceptanceMode || smokeMode,
  runtimeMode: astraRuntimePilotMode });
const astraMaxSourcePreviewMode = resolveAstraMaxSourcePreviewMode({ argv: process.argv, isPackaged: app.isPackaged,
  isolatedMode: safeEntryQaMode || updateDemoMode || desktopAcceptanceMode || smokeMode });
const astraMaxSourceModelSelection = resolveAstraMaxSourceModelSelection({ argv: process.argv,
  previewMode: astraMaxSourcePreviewMode });
const configuredInstallRoot = process.env.MONARCH_INSTALL_ROOT && path.isAbsolute(process.env.MONARCH_INSTALL_ROOT)
  ? path.resolve(process.env.MONARCH_INSTALL_ROOT)
  : null;
const installedDescriptor = readJsonFileIfPresent(path.join(workspaceRoot, 'version.json'));
const installedLayout = configuredInstallRoot
  ? readJsonFileIfPresent(path.join(configuredInstallRoot, 'install-layout.json'))
  : null;
const installedPointer = configuredInstallRoot
  ? readJsonFileIfPresent(path.join(configuredInstallRoot, 'current.json'))
  : null;
const installedLauncher = configuredInstallRoot
  ? readJsonFileIfPresent(path.join(configuredInstallRoot, 'launcher-version.json'))
  : null;
const configuredPayloadRoot = process.env.MONARCH_PAYLOAD_ROOT && path.isAbsolute(process.env.MONARCH_PAYLOAD_ROOT)
  ? path.resolve(process.env.MONARCH_PAYLOAD_ROOT)
  : null;
const configuredModelsRoot = process.env.MONARCH_MODELS_ROOT && path.isAbsolute(process.env.MONARCH_MODELS_ROOT)
  ? path.resolve(process.env.MONARCH_MODELS_ROOT)
  : null;
const configuredDataRoot = process.env.MONARCH_DATA_ROOT && path.isAbsolute(process.env.MONARCH_DATA_ROOT)
  ? path.resolve(process.env.MONARCH_DATA_ROOT)
  : null;
const configuredLogsRoot = process.env.MONARCH_LOGS_ROOT && path.isAbsolute(process.env.MONARCH_LOGS_ROOT)
  ? path.resolve(process.env.MONARCH_LOGS_ROOT)
  : null;
const configuredSecretsRoot = process.env.MONARCH_SECRETS_ROOT && path.isAbsolute(process.env.MONARCH_SECRETS_ROOT)
  ? path.resolve(process.env.MONARCH_SECRETS_ROOT)
  : configuredInstallRoot
    ? path.join(configuredInstallRoot, 'secrets')
    : path.join(workspaceRoot, 'secrets');
const desktopRuntimeRoot = configuredDataRoot
  ? path.join(configuredDataRoot, 'runtime', 'desktop')
  : path.join(workspaceRoot, 'runtime');
const imageProviderDownloadParent = path.join(desktopRuntimeRoot, 'image-provider-downloads');
const imageProviderDownloadRoot = path.join(imageProviderDownloadParent, randomBytes(12).toString('hex'));
const desktopLogsRoot = configuredLogsRoot
  ? path.join(configuredLogsRoot, 'desktop')
  : desktopRuntimeRoot;
const desktopStartupTracePath = path.join(desktopLogsRoot, 'startup-phases.jsonl');
installMainDiagnosticsMirror({ filePath: path.join(desktopLogsRoot, 'main-diagnostics.jsonl') });
const desktopStartupSession = randomBytes(12).toString('hex');
let desktopStartupLogQueue = Promise.resolve();
const updatePolicy = resolveDesktopUpdatePolicy({
  isPackaged: app.isPackaged,
  demoMode: updateDemoMode,
  fallbackVersion: !app.isPackaged ? workspacePackage?.version : app.getVersion(),
  installRoot: configuredInstallRoot,
  payloadRoot: configuredPayloadRoot,
  installedDescriptor,
  installedPointer,
  installedLayout,
});
const currentAppVersion = updatePolicy.currentVersion;
const currentLauncherVersion = /^\d+\.\d+\.\d+$/.test(String(installedLauncher?.version || ''))
  ? installedLauncher.version
  : '1.0.0';
const updateRoot = configuredPayloadRoot
  ? path.join(configuredPayloadRoot, 'updates')
  : path.join(workspaceRoot, 'runtime', 'updates');
const preloadPath = path.join(__dirname, 'preload.cjs');
const voiceOverlayPreloadPath = path.join(__dirname, 'voice-overlay-preload.cjs');
const voiceOverlayIndexPath = path.join(__dirname, 'voice-overlay.html');
const safeEntryQaProfile = safeEntryQaMode
  ? mkdtempSync(path.join(os.tmpdir(), 'monarch-safe-entry-qa-'))
  : null;
const updateDemoProfile = updateDemoMode
  ? mkdtempSync(path.join(os.tmpdir(), 'monarch-update-demo-'))
  : null;
const desktopIsolationParent = configuredDataRoot
  ? path.join(configuredDataRoot, 'runtime', 'desktop-isolation')
  : path.join(workspaceRoot, 'runtime');
const sourceSmokeMode = smokeMode && !app.isPackaged;
if (desktopAcceptanceMode || sourceSmokeMode) mkdirSync(desktopIsolationParent, { recursive: true });
const desktopAcceptanceProfile = desktopAcceptanceMode
  ? mkdtempSync(path.join(desktopIsolationParent, 'desktop-acceptance-'))
  : null;
const desktopSmokeProfile = sourceSmokeMode
  ? mkdtempSync(path.join(desktopIsolationParent, 'desktop-smoke-'))
  : null;
// Every diagnostic mode that starts the runtime gets its own data/state roots;
// Safe entry QA must never reconcile the owner's turns, outbox or authority.
const desktopRuntimeIsolationProfile = desktopAcceptanceProfile || desktopSmokeProfile || safeEntryQaProfile;
const isolatedUserDataRoot = safeEntryQaProfile || updateDemoProfile || desktopAcceptanceProfile || desktopSmokeProfile;
if (isolatedUserDataRoot) app.setPath('userData', isolatedUserDataRoot);
else if (!app.isPackaged && !installedLayout) {
  app.setPath('userData', prepareDevelopmentProfile({ defaultProfile: app.getPath('userData'),
    developmentProfile: path.join(desktopRuntimeRoot, 'electron-development-profile') }));
}
const astraMaxPreviewVersionRoot = path.join(workspaceRoot, 'runtime', 'astra-max-preview', 'version');
const astraMaxNativeEnabled = !safeEntryQaMode && !updateDemoMode && !desktopAcceptanceMode && !smokeMode && !astraMaxSourcePreviewMode;
const astraMaxPreviewDataRoot = configuredDataRoot
  ? path.join(configuredDataRoot, 'runtime', 'astra-max-preview')
  : path.join(workspaceRoot, 'runtime', 'astra-max-preview-data');
const astraMaxNativeDataRoot = path.join(configuredDataRoot || desktopRuntimeRoot, 'max');
const astraJournalProtectionRoot = path.join(configuredDataRoot || desktopRuntimeRoot, 'astra-v3-protection');
const gmailSecretRoot = path.join(configuredDataRoot || desktopRuntimeRoot, 'integrations', 'gmail');
const gmailSecretBroker = createGmailSecretBroker({ dataRoot: gmailSecretRoot, safeStorage,
  restrictAccess: target => restrictProtectedIntegrationAcl(target, { recordNames: ['gmail-oauth.encrypted'] }) });
const gmailOAuthController = createGmailOAuthController({ broker: gmailSecretBroker,
  openExternal: value => shell.openExternal(value) });
const githubSecretRoot = path.join(configuredDataRoot || desktopRuntimeRoot, 'integrations', 'github');
const githubSecretBroker = createGitHubSecretBroker({ dataRoot: githubSecretRoot, safeStorage,
  restrictAccess: target => restrictProtectedIntegrationAcl(target, { recordNames: ['github-token.encrypted'] }) });
// A diagnostic profile has its own OS encryption key: its record stays inside
// that profile and it never removes the owner's legacy file.
const oscarApiKeyRoot = isolatedUserDataRoot ? path.join(isolatedUserDataRoot, 'oscar-api-key')
  : path.join(configuredDataRoot || desktopRuntimeRoot, 'integrations', 'oscar');
const oscarApiKeyStore = createOscarApiKeyStore({ dataRoot: oscarApiKeyRoot, safeStorage,
  legacyPath: path.join(configuredSecretsRoot, 'oscar_token.txt'),
  removeLegacyFile: !isolatedUserDataRoot,
  restrictAccess: target => restrictProtectedIntegrationAcl(target, { recordNames: [oscarApiKeyStore.recordName] }) });
/** Set once the runtime was started with it; shutdown never creates a key. */
let oscarApiKey = null;
// Profile data key (Monarch Security stage 3): personal stores of the runtime
// are sealed with a key derived from it. Diagnostic profiles keep their own.
const profileProtectionRoot = isolatedUserDataRoot ? path.join(isolatedUserDataRoot, 'protection')
  : path.join(configuredDataRoot || desktopRuntimeRoot, 'protection');
// Stage 3f: copies of that key (Monarch Safe / recovery code) live beside it.
const profileKeyRecovery = createProfileKeyRecovery({ dataRoot: profileProtectionRoot });
const profileDataKeyStore = createProfileDataKeyStore({
  dataRoot: profileProtectionRoot,
  safeStorage,
  restrictAccess: target => restrictProtectedIntegrationAcl(target, { recordNames: [profileDataKeyStore.recordName] }),
  recoveryAvailable: () => profileKeyRecovery.hasAnyCopy(),
});
/** Why the runtime has no persistent key, if it has none. */
let profileKeyProblem = null;
let runtimeStoreKey;
let oscarDatabaseKey;
const calendarSecretRoot = path.join(configuredDataRoot || desktopRuntimeRoot, 'integrations', 'calendar');
const calendarSecretBroker = createCalendarSecretBroker({ dataRoot: calendarSecretRoot, safeStorage,
  restrictAccess: target => restrictProtectedIntegrationAcl(target, { recordNames: ['calendar-oauth.encrypted'] }) });
const calendarOAuthController = createCalendarOAuthController({ broker: calendarSecretBroker,
  openExternal: value => shell.openExternal(value) });
const serviceIntegrationRegistry = createServiceIntegrationRegistry([
  {
    id: 'gmail', envPrefix: 'MONARCH_GMAIL_HOST', status: () => gmailSecretBroker.status(),
    connect: input => gmailOAuthController.connect(input), disconnect: () => gmailSecretBroker.disconnect(),
    startServer: () => startGmailSecretServer(gmailSecretBroker), close: () => gmailOAuthController.close(),
    messages: {
      status: 'Не удалось прочитать защищённое подключение Gmail.',
      connect: 'Не удалось подключить Gmail. Проверь настройки OAuth и повтори.',
      disconnect: 'Не удалось удалить локальное подключение Gmail.',
      'gmail:oauth-client': 'Проверь OAuth Client ID для приложения типа Desktop.',
      'gmail:oauth-scope': 'Выбери хотя бы одну возможность Gmail.',
      'gmail:oauth-denied': 'Google не разрешил подключение Gmail.',
      'gmail:oauth-timeout': 'Подключение Gmail не завершено вовремя.',
      'gmail:oauth-in-progress': 'Подключение Gmail уже открыто в браузере.',
      'gmail:encryption-unavailable': 'Защищённое хранилище Windows сейчас недоступно.',
      'gmail:protected-record': 'Не удалось защитить подключение Gmail на диске.',
    },
  },
  {
    id: 'github', envPrefix: 'MONARCH_GITHUB_HOST', status: () => githubSecretBroker.status(),
    connect: input => githubSecretBroker.configure(input), disconnect: () => githubSecretBroker.disconnect(),
    startServer: () => startGitHubSecretServer(githubSecretBroker),
    messages: {
      status: 'Не удалось прочитать защищённое подключение GitHub.',
      connect: 'Не удалось подключить GitHub. Проверь token и список репозиториев.',
      disconnect: 'Не удалось удалить локальное подключение GitHub.',
      'github:token': 'Проверь fine-grained personal access token GitHub.',
      'github:repositories': 'Укажи от одного до двадцати репозиториев в формате owner/name.',
      'github:permissions': 'Выбери хотя бы одну возможность GitHub.',
      'github:authentication': 'GitHub отклонил token. Создай новый fine-grained token.',
      'github:permission-required': 'Token не имеет нужного разрешения GitHub.',
      'github:provider-not-found': 'GitHub не дал доступ к одному из указанных репозиториев.',
      'github:repository-denied': 'Проверь точные имена и доступ token к каждому репозиторию.',
      'github:encryption-unavailable': 'Защищённое хранилище Windows сейчас недоступно.',
      'github:protected-record': 'Не удалось защитить подключение GitHub на диске.',
    },
  },
  {
    id: 'calendar', envPrefix: 'MONARCH_CALENDAR_HOST', status: () => calendarSecretBroker.status(),
    connect: input => calendarOAuthController.connect(input), disconnect: () => calendarSecretBroker.disconnect(),
    startServer: () => startCalendarSecretServer(calendarSecretBroker), close: () => calendarOAuthController.close(),
    messages: {
      status: 'Не удалось прочитать защищённое подключение Google Calendar.',
      connect: 'Не удалось подключить Google Calendar. Проверь настройки OAuth и повтори.',
      disconnect: 'Не удалось удалить локальное подключение Google Calendar.',
      'calendar:oauth-client': 'Проверь OAuth Client ID для приложения типа Desktop.',
      'calendar:oauth-scope': 'Выбери хотя бы одну возможность Google Calendar.',
      'calendar:oauth-denied': 'Google не разрешил подключение Calendar.',
      'calendar:oauth-timeout': 'Подключение Calendar не завершено вовремя.',
      'calendar:oauth-in-progress': 'Подключение Calendar уже открыто в браузере.',
      'calendar:encryption-unavailable': 'Защищённое хранилище Windows сейчас недоступно.',
      'calendar:protected-record': 'Не удалось защитить подключение Calendar на диске.',
    },
  },
]);
const telegramSecretBroker = createTelegramSecretBroker({ dataRoot: path.join(configuredDataRoot || desktopRuntimeRoot, 'telegram-credentials'), safeStorage,
  cloudKeyPolicy: async () => (await readSecurityPolicyLevel('telegram.cloudSeparateKey')) ?? 'required',
  cloudSetup: createTelegramCloudflareSetup({ workerPath: path.join(workspaceRoot, 'cloud', 'oscar-bot', 'dist', 'worker.mjs') }),
  withSelectedMaxConnection: consume => astraMaxDesktopBridge.withSelectedConnection(consume), selectedMax: async () => {
  const view = await astraMaxDesktopBridge.providers();
  const selected = view.providers.find(p => p.id === view.selectedProviderId && p.state === 'ready');
  return selected ? { available: true, providerId: selected.id, modelId: selected.model, role: selected.role } : { available: false };
} });
let telegramSecretServer = null;
if (astraMaxSourcePreviewMode) mkdirSync(astraMaxPreviewDataRoot, { recursive: true });
if (astraMaxNativeEnabled) mkdirSync(astraMaxNativeDataRoot, { recursive: true });
const astraMaxDesktopBridge = createAstraMaxDesktopBridge({
  beforeSelectionChange: () => telegramSecretBroker.beforeMaxChange(),
  afterSelectionChange: () => telegramSecretBroker.afterMaxChange(),
  mode: astraMaxNativeEnabled ? 'native-desktop' : astraMaxSourcePreviewMode,
  versionRoot: astraMaxNativeEnabled ? workspaceRoot : astraMaxPreviewVersionRoot,
  dataRoot: astraMaxNativeEnabled ? astraMaxNativeDataRoot : astraMaxPreviewDataRoot,
  runtimeWorkspaceRoot: workspaceRoot,
  runtimeEnvironment: { ...process.env, ...(desktopRuntimeIsolationProfile ? {
    MONARCH_STATE_ROOT: path.join(desktopRuntimeIsolationProfile, 'state'),
  } : {}) },
  safeStorage,
  modelSelection: astraMaxSourceModelSelection,
});
const ownerAuthorityRoot = desktopRuntimeIsolationProfile
  ? path.join(desktopRuntimeIsolationProfile, 'owner-authority')
  : path.join(app.getPath('appData'), 'Monarch', 'authority');
const safeRoot = resolveSafeMainStorageRoot({
  workspaceRoot,
  qaUserDataRoot: isolatedUserDataRoot ? app.getPath('userData') : null,
  installedConfigRoot: installedLayout?.configRoot,
  updateDemoMode,
});
const safeUiRoot = path.join(workspaceRoot, 'desktop', 'safe');
const safePreloadPath = path.join(safeUiRoot, 'preload.cjs');
const safeRuntimePath = path.join(safeUiRoot, 'runtime.mjs');
const safeIndexPath = path.join(safeUiRoot, 'index.html');
const safeAuthorizationPath = path.join(safeUiRoot, 'authorization.html');
const safeAuthorizationPreloadPath = path.join(safeUiRoot, 'authorization-preload.cjs');
const safeIconPath = path.join(workspaceRoot, 'assets', 'safe', 'monarch-safe.ico');
const safeLaunchMode = process.argv.includes('--safe') && !safeEntryQaMode;
const appName = updateDemoMode
  ? 'Monarch · безопасная демонстрация обновления'
  : desktopAcceptanceMode ? 'Monarch · Acceptance' : 'Monarch';
const desktopAttestationToken = randomBytes(32).toString('base64url');
// One UI session token for the life of this desktop process, handed to every
// runtime start. A recovered runtime used to mint its own, so the open window
// got 401 "Sensitive Monarch API reads require a valid UI session token" for
// everything it sent while the restart was under way.
const runtimeApiToken = randomBytes(32).toString('base64url');
// This capability is intentionally distinct from renderer mutation attestation.
// It is never returned through preload and exists only for main -> runtime host calls.
const astraV3HostToken = randomBytes(32).toString('base64url');
let mainWindow = null;
let voiceOverlayWindow = null;
// Last state from the main renderer; the overlay only shows it while the main window is not in front,
// otherwise the in-window voice surface already shows the same state and the two would overlap.
let voiceOverlayPayload = null;
let voiceWakeState = { state: 'disabled', enabled: false };
let imageProviderWindow = null;
let embeddedImageProviderView = null;
let installerCoordinator = null;
let postUpdateTrial = null;
const updateDemo = updateDemoMode ? createUpdateDemoRuntime() : null;
const updateService = new MonarchUpdateService({
  currentVersion: currentAppVersion,
  updaterVersion: currentAppVersion,
  launcherVersion: currentLauncherVersion,
  endpoints: updateDemo?.endpoints || createMonarchUpdateEndpoints({
    sitesOrigin: process.env.MONARCH_UPDATE_SITES_ORIGIN || undefined,
  }),
  publicKeys: updateDemo?.publicKeys || MONARCH_RELEASE_PUBLIC_KEYS,
  updateRoot: updateDemoProfile ? path.join(updateDemoProfile, 'updates') : updateRoot,
  fetchImpl: updateDemo?.fetchImpl || globalThis.fetch,
  diskReserveBytes: updateDemoMode ? 0 : undefined,
  installationPolicy: updatePolicy,
  launchInstaller: updateDemo?.launchInstaller || (async (context) => {
    if (!installerCoordinator) {
      const error = new Error('Transactional installer coordination is unavailable outside an installed Monarch layout.');
      error.code = 'installer-coordinator-unavailable';
      throw error;
    }
    return installerCoordinator(context);
  }),
});
updateService.on('state', (snapshot) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('monarch:update-state-changed', snapshot);
});
const speechDiagnosticsPath = path.join(desktopLogsRoot, 'electron-speech.log');
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
let safeExportDialogWindow = null;
let safeAuthorizationWindow = null;
let safeProcess = null;
let safeCapabilityKey = null;
let safeServiceSequence = 0;
const safeServicePending = new Map();
let serverProcess = null;
let astraMaxModelServer = null;
let astraMaxNativeServer = null;
let astraMaxNativePreparedServer = null;
let runtimeReady = false;
let runtimeUrl = '';
let runtimeRecoveryPromise = null;
const runtimeRecovery = createRuntimeRecoveryPolicy();
let tray = null;
let quitRequested = false;
let trayHintShown = false;
let shuttingDown = false;
let shutdownComplete = false;
let shutdownPromise = null;
let retainedUpdateCleanupPromise = null;
let computerUseEmergencyStopRunning = false;
const configuredSafeSessions = new WeakSet();
const configuredImageProviderSessions = new WeakSet();
const safeEntryQaEvents = [];
let safeSecurityPolicy = normalizeSafeSecurityPolicy(null);

markDesktopStartup('module-ready');

if (!updateDemoMode && configuredInstallRoot && configuredPayloadRoot) {
  installerCoordinator = createTransactionalInstallerCoordinator({
    installRoot: configuredInstallRoot,
    updateRoot,
    runtimeUrl: () => runtimeUrl,
    shutdown: shutdownDesktop,
    requestQuit: () => {
      quitRequested = true;
      shutdownComplete = true;
      app.quit();
    },
  });
}

if (!safeEntryQaMode && !updateDemoMode && !smokeMode && !desktopAcceptanceMode && !app.requestSingleInstanceLock()) {
  markDesktopStartup('single-instance-denied');
  app.quit();
} else {
  markDesktopStartup('single-instance-ready');
  if (!safeEntryQaMode && !updateDemoMode && !smokeMode && !desktopAcceptanceMode) {
    app.on('second-instance', (_event, commandLine) => {
      if (commandLine.includes('--safe')) void showSafeWindow();
      else void showMainWindow();
    });
  }

  app.setAppUserModelId(safeLaunchMode ? 'Monarch.Safe' : updateDemoMode ? 'Monarch.UpdateDemo' : 'Monarch.App');

  app.whenReady()
    .then(startDesktopApp)
    .catch(async (error) => {
      await showFatalError(error);
      await cleanupDesktopRuntimeIsolation();
      app.exit(1);
    });
}

app.on('window-all-closed', () => {
  if (updateDemoMode || desktopAcceptanceMode) {
    app.quit();
    return;
  }
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
  if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) voiceOverlayWindow.destroy();
  voiceOverlayWindow = null;
  tray?.destroy();
  tray = null;
  stopRuntime();
});

app.on('activate', () => {
  if (safeLaunchMode && !mainWindow) void showSafeWindow();
  else void showMainWindow();
});

ipcMain.handle('monarch:get-runtime-url', () => runtimeUrl);
/** Window chrome follows the painted theme; "system" is resolved by Windows. */
function paintWindowChrome() {
  const light = !nativeTheme.shouldUseDarkColors;
  mainWindow?.setBackgroundColor(light ? '#faf8f4' : '#08090a');
  if (process.platform === 'win32') mainWindow?.setTitleBarOverlay({
    color: light ? '#faf8f4' : '#08090a',
    symbolColor: light ? '#26221d' : '#f7f7f5', height: 32,
  });
}
nativeTheme.on('updated', () => { if (nativeTheme.themeSource === 'system') paintWindowChrome(); });
ipcMain.handle('monarch:set-theme', (event, theme) => {
  assertTrustedMainRenderer(event);
  if (theme !== 'dark' && theme !== 'light' && theme !== 'system') throw Error('Invalid theme');
  nativeTheme.themeSource = theme;
  paintWindowChrome();
  return theme;
});
ipcMain.handle('monarch:telegram-configure', (event, input) => {
  assertTrustedMainRenderer(event);
  return telegramSecretBroker.configure(input).catch(() => { throw Error('Не удалось проверить и сохранить ключ Telegram.'); });
});
ipcMain.handle('monarch:telegram-cloud-configure', (event, input) => {
  assertTrustedMainRenderer(event);
  return telegramSecretBroker.configureCloud(input).catch(() => { throw Error('Проверь адрес личного Worker, ключ устройства и облачное согласие.'); });
});
let maxConfigurationTail = Promise.resolve();
const serializeMaxConfiguration = action => {
  const result = maxConfigurationTail.then(action); maxConfigurationTail = result.catch(() => undefined); return result;
};
ipcMain.handle('monarch:telegram-cloud-inspect', event => {
  assertTrustedMainRenderer(event);
  return telegramSecretBroker.inspectPersonalCloud().catch(() => { throw Error('Не удалось найти облако. Проверь вход в Cloudflare и наличие компонента Oscar.'); });
});
ipcMain.handle('monarch:telegram-cloud-provision', (event, input) => {
  assertTrustedMainRenderer(event);
  return serializeMaxConfiguration(() => telegramSecretBroker.provisionPersonalCloud(input)).catch((error) => {
    const code = String(error?.message || '');
    if (code === 'telegram:cloud-key-required') throw Error('Укажи отдельный ключ MAX для облака. Основной ключ с компьютера в облако не передаётся.');
    if (code === 'telegram:cloud-key-same') throw Error('Это основной ключ MAX. Создай у сервиса новый ключ для облака — лучше с лимитом расходов.');
    if (code === 'telegram:cloud-key-format') throw Error('Ключ выглядит неполным. Скопируй его у сервиса целиком.');
    throw Error('Облако не подтвердило подключение. Проверь вход в Cloudflare и выбранный MAX, затем повтори. Сохранённые ключи устройства будут использованы снова.');
  });
});
ipcMain.handle('monarch:telegram-credentials-status', (event, role) => {
  assertTrustedMainRenderer(event);
  return telegramSecretBroker.status(role);
});
registerServiceIntegrationIpc({ ipcMain, registry: serviceIntegrationRegistry,
  assertTrustedRenderer: assertTrustedMainRenderer });
ipcMain.handle('monarch:get-desktop-attestation', (event) => {
  assertTrustedMainRenderer(event);
  return desktopAttestationToken;
});
ipcMain.handle('monarch:astra-max-select-provider', (event, id) => {
  assertTrustedMainRenderer(event);
  return serializeMaxConfiguration(() => astraMaxDesktopBridge.selectProvider(id));
});
ipcMain.handle('monarch:astra-max-providers', (event, input) => {
  assertTrustedMainRenderer(event);
  return astraMaxDesktopBridge.providers(input);
});
ipcMain.handle('monarch:astra-max-models', (event, input) => {
  assertTrustedMainRenderer(event);
  return astraMaxDesktopBridge.listProviderModels(input);
});
ipcMain.handle('monarch:astra-max-stored-models', (event, input) => {
  assertTrustedMainRenderer(event);
  return astraMaxDesktopBridge.listStoredProviderModels(input);
});
ipcMain.handle('monarch:astra-max-configure-provider', (event, input) => {
  assertTrustedMainRenderer(event);
  return serializeMaxConfiguration(() => astraMaxDesktopBridge.configureProvider(input));
});
ipcMain.handle('monarch:astra-max-update-model', (event, input) => {
  assertTrustedMainRenderer(event);
  return serializeMaxConfiguration(() => astraMaxDesktopBridge.updateProviderModel(input));
});
ipcMain.handle('monarch:astra-max-reasoning-effort', (event, value) => {
  assertTrustedMainRenderer(event);
  return astraMaxDesktopBridge.setReasoningEffort(value);
});
ipcMain.handle('monarch:astra-max-verify-provider', (event, input) => {
  assertTrustedMainRenderer(event);
  return astraMaxDesktopBridge.verifyProvider(input);
});
ipcMain.handle('monarch:astra-max-status', (event) => {
  assertTrustedMainRenderer(event);
  return astraMaxDesktopBridge.status();
});
ipcMain.handle('monarch:astra-max-configure', (event, request) => {
  assertTrustedMainRenderer(event);
  return serializeMaxConfiguration(() => astraMaxDesktopBridge.configure(request));
});
ipcMain.handle('monarch:astra-max-verify', (event) => {
  assertTrustedMainRenderer(event);
  return astraMaxDesktopBridge.verify();
});
ipcMain.handle('monarch:astra-product-pick-target', async (event, request) => {
  if (!astraRuntimePilotMode || !mainWindow || !runtimeUrl) throw Error('astra-product-host:unavailable');
  const guard = acquireAstraProductRendererGuard({ window: mainWindow, runtimeUrl, event, assertTrustedRenderer: assertTrustedMainRenderer });
  try {
    const defaultDirectory = process.env.MONARCH_WORKSPACE_ROOT && path.isAbsolute(process.env.MONARCH_WORKSPACE_ROOT)
      ? path.resolve(process.env.MONARCH_WORKSPACE_ROOT) : workspaceRoot;
    return await pickAstraProductTarget({ mode: astraRuntimePilotMode, request, dialog, window: mainWindow, runtimeUrl,
      defaultDirectory, desktopAttestationToken, hostToken: astraV3HostToken, fetchImpl: fetch, assertRenderer: guard.assert });
  } finally { guard.dispose(); }
});
ipcMain.handle('monarch:astra-product-pick-telegram-target', async (event, request) => {
  if (!astraRuntimePilotMode || !astraTelegramPilotMode || !mainWindow || !runtimeUrl) {
    throw Error('astra-product-host:telegram-unavailable');
  }
  const guard = acquireAstraProductRendererGuard({ window: mainWindow, runtimeUrl, event, assertTrustedRenderer: assertTrustedMainRenderer });
  try {
    const defaultDirectory = process.env.MONARCH_WORKSPACE_ROOT && path.isAbsolute(process.env.MONARCH_WORKSPACE_ROOT)
      ? path.resolve(process.env.MONARCH_WORKSPACE_ROOT) : workspaceRoot;
    return await pickAstraTelegramTarget({ mode: astraRuntimePilotMode, telegramMode: astraTelegramPilotMode,
      request, dialog, window: mainWindow, runtimeUrl, defaultDirectory, desktopAttestationToken,
      hostToken: astraV3HostToken, fetchImpl: fetch, assertRenderer: guard.assert });
  } finally { guard.dispose(); }
});
ipcMain.handle('monarch:astra-product-pick-window', async (event, request) => {
  if (!astraRuntimePilotMode || !mainWindow || !runtimeUrl) throw Error('astra-product-host:unavailable');
  const guard = acquireAstraProductRendererGuard({ window: mainWindow, runtimeUrl, event, assertTrustedRenderer: assertTrustedMainRenderer });
  try {
    return await pickAstraProductWindow({ mode: astraRuntimePilotMode, request, dialog, window: mainWindow, runtimeUrl,
      desktopAttestationToken, hostToken: astraV3HostToken, fetchImpl: fetch, assertRenderer: guard.assert });
  } finally { guard.dispose(); }
});
ipcMain.handle('monarch:astra-product-issue-computer-action', async (event, request) => {
  if (!astraRuntimePilotMode || !mainWindow || !runtimeUrl) throw Error('astra-product-host:unavailable');
  const guard = acquireAstraProductRendererGuard({ window: mainWindow, runtimeUrl, event, assertTrustedRenderer: assertTrustedMainRenderer });
  try {
    return await issueAstraProductComputerAction({ mode: astraRuntimePilotMode, request, runtimeUrl,
      desktopAttestationToken, hostToken: astraV3HostToken, fetchImpl: fetch, assertRenderer: guard.assert });
  } finally { guard.dispose(); }
});
ipcMain.handle('monarch:astra-product-window-selections', async (event, request) => {
  if (!astraRuntimePilotMode || !mainWindow || !runtimeUrl) throw Error('astra-product-host:unavailable');
  const guard = acquireAstraProductRendererGuard({ window: mainWindow, runtimeUrl, event, assertTrustedRenderer: assertTrustedMainRenderer });
  try {
    return await controlAstraProductWindows({ mode: astraRuntimePilotMode, request, runtimeUrl,
      desktopAttestationToken, hostToken: astraV3HostToken, fetchImpl: fetch, assertRenderer: guard.assert });
  } finally { guard.dispose(); }
});
ipcMain.handle('monarch:astra-product-computer-action-plans', async (event, request) => {
  if (!astraRuntimePilotMode || !mainWindow || !runtimeUrl) throw Error('astra-product-host:unavailable');
  const guard = acquireAstraProductRendererGuard({ window: mainWindow, runtimeUrl, event, assertTrustedRenderer: assertTrustedMainRenderer });
  try {
    return await controlAstraProductComputerActions({ mode: astraRuntimePilotMode, request, runtimeUrl,
      desktopAttestationToken, hostToken: astraV3HostToken, fetchImpl: fetch, assertRenderer: guard.assert });
  } finally { guard.dispose(); }
});
ipcMain.handle('monarch:get-app-info', () => ({
  name: appName,
  version: currentAppVersion,
  workspaceRoot,
  runtimeUrl,
  astra: { pilot: Boolean(astraRuntimePilotMode), telegramRead: Boolean(astraTelegramPilotMode),
    surface: process.argv.includes('--astra-v3-same-owner-pilot') ? 'composer' : 'native-chat',
    maxPreview: Boolean(astraMaxSourcePreviewMode) },
}));
ipcMain.handle('monarch:voice-overlay-update', async (event, value = {}) => {
  assertTrustedMainRenderer(event);
  voiceOverlayPayload = normalizeVoiceOverlayPayload(value);
  const visible = await syncVoiceOverlayVisibility();
  return { ok: true, visible };
});
ipcMain.handle('monarch:voice-wake-state', (event, value = {}) => {
  assertTrustedMainRenderer(event);
  voiceWakeState = normalizeVoiceWakeState(value);
  rebuildTrayMenu();
  syncTrayTooltip();
  return { ok: true, ...voiceWakeState };
});
ipcMain.handle('monarch:update-state', (event) => {
  assertTrustedMainRenderer(event);
  return updateService.snapshot();
});
ipcMain.handle('monarch:update-intent', async (event, intent) => {
  assertTrustedMainRenderer(event);
  switch (intent) {
    case 'check': return updateService.check();
    case 'download': return updateService.download();
    case 'install': return updateService.install();
    case 'pause': return updateService.pause();
    case 'resume': return updateService.resume();
    case 'cancel': return updateService.cancel();
    case 'discard': return updateService.discard();
    default: return {
      ...updateService.snapshot(),
      intentError: { code: 'unknown-update-intent' },
    };
  }
});
ipcMain.handle('monarch:copy-text', (_event, value) => {
  clipboard.writeText(String(value ?? ''));
  return true;
});
ipcMain.handle('monarch:open-models-folder', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  if (!configuredModelsRoot) return { ok: false, error: 'models-root-unavailable' };
  const modelsRoot = configuredModelsRoot;
  mkdirSync(modelsRoot, { recursive: true });
  const error = await shell.openPath(modelsRoot);
  return error ? { ok: false, error: 'models-folder-open-failed' } : { ok: true };
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
  if (smokeMode || safeEntryQaMode || updateDemoMode) {
    return { status: 'unavailable', ok: false, error: 'speech-warmup-disabled', summary: 'Прогрев TTS отключён для служебного запуска.' };
  }
  return value?.retry === true ? speechWarmup.retry() : speechWarmup.start();
});
// Help -> "Если что-то не работает": reveal Monarch's own log folder. The
// path is fixed here; the renderer cannot choose what gets opened.
ipcMain.handle('monarch:open-logs', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false, error: 'untrusted-renderer' };
  await mkdir(desktopLogsRoot, { recursive: true });
  const failure = await shell.openPath(desktopLogsRoot);
  return failure ? { ok: false, error: 'open-failed' } : { ok: true };
});

// Help -> "Сообщить об ошибке": opens a filled-in letter to the fixed address
// in the mail program (or Gmail in the browser). Monarch sends nothing itself.
ipcMain.handle('monarch:report-bug', async (event, value) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false, error: 'untrusted-renderer' };
  let report;
  try {
    report = composeBugReport(value, {
      version: value?.version || app.getVersion(),
      os: `Windows ${os.release()} ${os.arch()}`,
      memory: `${Math.round(os.totalmem() / (1024 ** 3))} ГБ`,
    });
  } catch {
    return { ok: false, error: 'empty' };
  }
  const text = `Кому: mrpastio@gmail.com\nТема: ${report.subject}\n\n${report.body}`;
  const target = value?.via === 'gmail' ? bugReportGmailUrl(report) : bugReportMailto(report);
  try {
    await shell.openExternal(target);
    return { ok: true, text };
  } catch {
    return { ok: false, error: 'open-failed', text };
  }
});

ipcMain.handle('monarch:speech-diagnostics', (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { status: 'failed', ok: false, error: 'untrusted-renderer', summary: 'Диагностика TTS недоступна.' };
  }
  return speechWarmup.snapshot();
});
ipcMain.handle('monarch:speech-capabilities', (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { schemaVersion: 1, platform: process.platform, primaryEngine: 'unavailable', neuralInstalled: false };
  }
  return speechOutput.capabilities();
});
ipcMain.handle('monarch:owner-enrollment-status', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  const status = await readOwnerEnrollmentStatus({ authorityRoot: ownerAuthorityRoot, safeStorage });
  return { ok: true, status: { ...status, ownerSuspended: await isOwnerModeSuspended(ownerAuthorityRoot) } };
});
ipcMain.handle('monarch:owner-mode-set-suspended', async (event, suspended) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false, error: 'untrusted-renderer' };
  const result = await setOwnerModeSuspended({ authorityRoot: ownerAuthorityRoot, suspended: suspended === true });
  if (!result.ok) return result;
  setImmediate(() => {
    quitRequested = true;
    app.relaunch();
    app.quit();
  });
  return result;
});
ipcMain.handle('monarch:owner-device-request-create', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  return createOwnerDeviceRequest({ authorityRoot: ownerAuthorityRoot, safeStorage });
});
ipcMain.handle('monarch:owner-device-request-export', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  const prepared = await createOwnerDeviceRequest({ authorityRoot: ownerAuthorityRoot, safeStorage });
  if (!prepared.ok) return prepared;
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: 'Сохранить публичный запрос Owner',
    defaultPath: path.join(app.getPath('downloads'), 'device-request.json'),
    buttonLabel: 'Сохранить запрос',
    filters: [{ name: 'Monarch Owner request', extensions: ['json'] }],
    showOverwriteConfirmation: true,
  });
  if (selection.canceled || !selection.filePath) return { ok: false, canceled: true };
  return exportOwnerDeviceRequest({ authorityRoot: ownerAuthorityRoot, destinationPath: selection.filePath });
});
ipcMain.handle('monarch:owner-entitlement-import', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Импортировать Owner entitlement',
    defaultPath: app.getPath('downloads'),
    buttonLabel: 'Проверить и импортировать',
    properties: ['openFile'],
    filters: [{ name: 'Monarch Owner entitlement', extensions: ['json'] }],
  });
  if (selection.canceled || selection.filePaths.length !== 1) return { ok: false, canceled: true };
  return importOwnerEntitlement({
    authorityRoot: ownerAuthorityRoot,
    sourcePath: selection.filePaths[0],
    safeStorage,
  });
});
ipcMain.handle('monarch:owner-enrollment-restart', (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  setImmediate(() => {
    quitRequested = true;
    app.relaunch();
    app.quit();
  });
  return { ok: true };
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
  // The key the running Oscar actually accepts, persistent or session-only.
  const loaded = oscarApiKey;
  if (!loaded) {
    return { ok: false, error: 'token-missing' };
  }
  clipboard.writeText(loaded.key);
  return { ok: true, persistent: loaded.persistent };
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
ipcMain.handle('monarch:pick-model-file', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return null;
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбери свою модель (.gguf)',
    properties: ['openFile'],
    buttonLabel: 'Добавить модель',
    filters: [{ name: 'Модель GGUF', extensions: ['gguf'] }],
  });
  if (selection.canceled || selection.filePaths.length !== 1) return null;
  return selection.filePaths[0];
});
ipcMain.handle('monarch:pick-red-zone-folder', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return null;
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Красная зона: выбери папку, куда Oscar не заходит',
    properties: ['openDirectory'],
    buttonLabel: 'Закрыть эту папку',
  });
  if (selection.canceled || selection.filePaths.length !== 1) return null;
  return selection.filePaths[0];
});
ipcMain.handle('monarch:pick-coder-folder', async (event, purpose) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return null;
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: purpose === 'telegram' ? 'Выбери папку для поручений из Telegram' : 'Выбери папку проекта для Coder Mode',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: purpose === 'telegram' ? 'Выбрать папку' : 'Открыть как проект',
  });
  if (selection.canceled || selection.filePaths.length !== 1) return null;
  return selection.filePaths[0];
});
ipcMain.handle('monarch:open-image-provider', async (event, value = {}) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  const prompt = String(value?.prompt || '').replace(/[\u0000-\u001F\u007F]/gu, '').trim().slice(0, 8_000);
  if (prompt) clipboard.writeText(prompt);
  const url = resolveImageProviderEntryUrl(value?.url);
  await showImageProviderWindow(url);
  return { ok: true, url, promptCopied: Boolean(prompt) };
});
ipcMain.handle('monarch:show-embedded-image-provider', async (event, value = {}) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return { ok: false, error: 'untrusted-renderer' };
  }
  const bounds = resolveEmbeddedImageProviderBounds(value?.bounds, mainWindow.getContentBounds());
  if (!bounds) return { ok: false, error: 'provider-view-too-small' };
  const prompt = normalizeImageProviderPrompt(value?.prompt);
  if (prompt) clipboard.writeText(prompt);
  const url = resolveImageProviderEntryUrl(value?.url);
  await showEmbeddedImageProvider(url, bounds, resolveImageProviderZoom(value?.zoom));
  return { ok: true, url, promptCopied: Boolean(prompt), bounds };
});
ipcMain.handle('monarch:update-embedded-image-provider-bounds', (event, value = {}) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || !embeddedImageProviderView) {
    return { ok: false };
  }
  const bounds = resolveEmbeddedImageProviderBounds(value, mainWindow.getContentBounds());
  if (!bounds) return { ok: false, error: 'provider-view-too-small' };
  embeddedImageProviderView.setBounds(bounds);
  return { ok: true, bounds };
});
ipcMain.handle('monarch:hide-embedded-image-provider', (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false };
  embeddedImageProviderView?.setVisible(false);
  return { ok: true };
});
ipcMain.handle('monarch:navigate-embedded-image-provider', async (event, action) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || !embeddedImageProviderView) {
    return { ok: false };
  }
  const contents = embeddedImageProviderView.webContents;
  if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  else if (action === 'reload') contents.reload();
  else return { ok: false, error: 'unsupported-provider-navigation' };
  return { ok: true };
});
ipcMain.handle('monarch:close-image-provider', async (event) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false };
  if (imageProviderWindow && !imageProviderWindow.isDestroyed()) imageProviderWindow.close();
  imageProviderWindow = null;
  destroyEmbeddedImageProvider();
  return { ok: true };
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
ipcMain.handle('monarch-safe:export-file', async (event, value = {}) => {
  const targetWindow = safeWindow;
  const targetProcess = safeProcess;
  if (!trustedSafeSender(event, targetWindow) || !targetProcess) {
    throw new Error('safe-export-untrusted-window');
  }
  const id = String(value?.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('safe-export-invalid-id');
  const context = await requestSafeService('fileActionContext', { id, action: 'exportRead' }, targetProcess);
  if (!ownsSafeSessionResource(safeWindow, targetWindow) || !ownsSafeSessionResource(safeProcess, targetProcess)) throw new Error('safe-export-session-changed');
  if (safeExportDialogWindow) throw new Error('safe-export-dialog-busy');
  const name = String(context.name || 'file').replace(/[\\/:*?"<>|\r\n\t\u202a-\u202e\u2066-\u2069]/g, '_').slice(0, 160) || 'file';
  safeExportDialogWindow = targetWindow;
  try {
    const selection = await dialog.showSaveDialog(targetWindow, {
      title: 'Экспортировать расшифрованный файл',
      defaultPath: path.join(path.parse(safeRoot).root, name),
      buttonLabel: 'Экспортировать',
      showOverwriteConfirmation: true,
    });
    if (selection.canceled || !selection.filePath) return { ok: false, canceled: true };
    if (!ownsSafeSessionResource(safeWindow, targetWindow) || !ownsSafeSessionResource(safeProcess, targetProcess)) {
      throw new Error('safe-export-session-changed');
    }
    const result = await requestSafeService('exportRead', { id, context }, targetProcess);
    try {
      if (result?.file?.id !== id || !(result?.bytes instanceof Uint8Array)) throw new Error('safe-export-invalid-response');
      if (!ownsSafeSessionResource(safeWindow, targetWindow) || !ownsSafeSessionResource(safeProcess, targetProcess)) {
        throw new Error('safe-export-session-changed');
      }
      return await writeSafeExport({
        destinationPath: selection.filePath,
        safeRoot,
        bytes: result.bytes,
        shouldCommit: async () => ownsSafeSessionResource(safeWindow, targetWindow)
          && ownsSafeSessionResource(safeProcess, targetProcess)
          && await requestSafeService('validateFileActionContext', { context }, targetProcess)
          && ownsSafeSessionResource(safeWindow, targetWindow)
          && ownsSafeSessionResource(safeProcess, targetProcess),
      });
    } finally {
      result?.bytes?.fill(0);
    }
  } finally {
    if (safeExportDialogWindow === targetWindow) safeExportDialogWindow = null;
  }
});
ipcMain.handle('monarch-safe:authorize-delete', (event, value = {}) => authorizeSafeMutation(event, 'deleteFile', value));
ipcMain.handle('monarch-safe:authorize-write', (event, value = {}) => authorizeSafeMutation(event, 'writeFile', value));

function trustedSafeSender(event, targetWindow) {
  return Boolean(targetWindow && !targetWindow.isDestroyed()
    && event.sender === targetWindow.webContents
    && event.senderFrame === targetWindow.webContents.mainFrame
    && event.senderFrame.url === pathToFileURL(safeIndexPath).toString());
}

async function authorizeSafeMutation(event, action, value) {
  const targetWindow = safeWindow;
  const targetProcess = safeProcess;
  const targetCapabilityKey = safeCapabilityKey;
  if (!trustedSafeSender(event, targetWindow) || !targetProcess || !targetCapabilityKey) return null;
  const isCurrent = () => ownsSafeSessionResource(safeWindow, targetWindow)
    && !targetWindow.isDestroyed() && ownsSafeSessionResource(safeProcess, targetProcess)
    && ownsSafeSessionResource(safeCapabilityKey, targetCapabilityKey);
  try {
    return await authorizeSafeFiles({
      action, value, key: targetCapabilityKey, isCurrent,
      prepare: (payload) => requestSafeService('fileActionContext', payload, targetProcess),
      prompt: (options) => showSafeAuthorizationPrompt({ parentWindow: targetWindow, ...options }),
    });
  } finally { if (value?.bytes instanceof Uint8Array) value.bytes.fill(0); }
}
ipcMain.on('monarch-safe:sealed', (event) => {
  if (!safeWindow || safeWindow.isDestroyed() || event.sender.id !== safeWindow.webContents.id) return;
  if (safeSecurityPolicy.clearClipboardOnLock) clipboard.clear();
});

async function startDesktopApp() {
  await rotateRuntimeLog(speechDiagnosticsPath);
  markDesktopStartup('app-ready');
  markDesktopStartup('maintenance-start');
  if (!updateDemoMode && !desktopAcceptanceMode) {
    markDesktopStartup('post-update-trial-start');
    postUpdateTrial = await preparePostUpdateTrial().catch((error) => {
      if (process.argv.some((value) => value.startsWith('--post-update='))) throw error;
      return null;
    });
    markDesktopStartup('post-update-trial-ready');
    markDesktopStartup('rollback-prepare-start');
    await prepareRollback().catch((error) => {
      if (process.argv.some((value) => value.startsWith('--rollback-update='))) throw error;
    });
    markDesktopStartup('rollback-prepare-ready');
    if (installedLayout?.configRoot) {
      markDesktopStartup('secret-migration-start');
      await migrateLegacySecretsForCurrentUser({
        migrationRoot: path.join(installedLayout.configRoot, 'migration', 'secrets'),
        safeRoot,
        safeStorage,
      });
      markDesktopStartup('secret-migration-ready');
    }
  }
  markDesktopStartup('maintenance-ready');
  await Promise.all([
    mkdir(desktopRuntimeRoot, { recursive: true }),
    mkdir(desktopLogsRoot, { recursive: true }),
  ]);
  // Neural TTS is intentionally lazy. Qwen Pro is the primary text/agent
  // runtime and must not compete with an unused multi-gigabyte voice worker.
  // Voice Mode starts the shared warmup through trusted IPC when it opens.
  runtimeUrl = await startRuntime();
  markDesktopStartup('runtime-ready');
  void syncProfileKeyCopies();
  if (!(smokeMode || safeEntryQaMode || updateDemoMode || desktopAcceptanceMode || safeLaunchMode)) {
    reminderDelivery.start();
  }

  if (smokeMode) {
    const [health, capabilityPayload, permissionPayload] = await Promise.all([
      fetchJson(`${runtimeUrl}/api/health`, {}, 30_000),
      fetchJson(`${runtimeUrl}/api/capabilities`),
      fetchJson(`${runtimeUrl}/api/permissions`, {
        'X-Monarch-Desktop-Attestation': desktopAttestationToken,
      }),
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
      authorityTier: permissionPayload?.authority?.tier || 'public',
      authoritySource: permissionPayload?.authority?.source || 'default',
      authorityDiagnostic: permissionPayload?.authority?.diagnostic || null,
      autonomyMode: permissionPayload?.profile?.autonomyMode || null,
      approvalPolicy: permissionPayload?.profile?.approvalPolicy || null,
    }, null, 2));
    stopRuntime();
    await cleanupDesktopRuntimeIsolation();
    app.quit();
    return;
  }

  Menu.setApplicationMenu(createApplicationMenu());
  registerComputerUseEmergencyShortcut();
  powerMonitor.on('lock-screen', () => closeSafeForSystemBoundary());
  powerMonitor.on('suspend', () => closeSafeForSystemBoundary());
  if (!safeEntryQaMode && !safeLaunchMode && !updateDemoMode && !desktopAcceptanceMode) createTray();
  if (safeLaunchMode) {
    await showSafeWindow();
  } else {
    await createMainWindow();
    if (postUpdateTrial) {
      const health = await fetchJson(`${runtimeUrl}/api/health`, {}, 30_000);
      await writeHealthAcknowledgement({
        trial: postUpdateTrial,
        backendHealth: health,
        configValid: Boolean(installedDescriptor && installedLayout),
        securityState: readSecurityStartupState(health),
        windowReady: Boolean(mainWindow && !mainWindow.isDestroyed()),
      });
    }
    scheduleRetainedUpdateCleanup();
    if (updatePolicy.mode === 'installed' && !safeEntryQaMode) startBackgroundUpdateChecks(updateService);
  }
  if (safeEntryQaMode) await runSafeEntryQa();
}

function scheduleRetainedUpdateCleanup() {
  if (
    retainedUpdateCleanupPromise
    || !configuredInstallRoot
    || !configuredPayloadRoot
    || safeEntryQaMode
    || safeLaunchMode
    || updateDemoMode
    || desktopAcceptanceMode
    || smokeMode
    || process.argv.some((value) => value.startsWith('--post-update=') || value.startsWith('--rollback-update='))
  ) {
    return retainedUpdateCleanupPromise;
  }
  markDesktopStartup('retention-cleanup-scheduled');
  retainedUpdateCleanupPromise = new Promise((resolve) => setImmediate(resolve))
    .then(async () => {
      if (shuttingDown || quitRequested) {
        markDesktopStartup('retention-cleanup-cancelled');
        return Object.freeze({ status: 'skipped', reason: 'desktop-shutting-down', removed: Object.freeze([]) });
      }
      markDesktopStartup('retention-cleanup-start');
      const result = await cleanupRetainedUpdateComponents({
        installRoot: configuredInstallRoot,
        payloadRoot: configuredPayloadRoot,
      });
      if (result.status === 'completed') markDesktopStartup('retention-cleanup-ready');
      else markDesktopStartup('retention-cleanup-skipped');
      return result;
    })
    .catch(() => {
      // Retention is opportunistic. An inventory or filesystem failure must not
      // make the interactive product unavailable or authorize a retry/delete.
      markDesktopStartup('retention-cleanup-failed');
      console.warn('Retained update cleanup failed safely.');
      return Object.freeze({ status: 'skipped', reason: 'retention-cleanup-failed', removed: Object.freeze([]) });
    });
  return retainedUpdateCleanupPromise;
}

async function createMainWindow() {
  markDesktopStartup('window-create');
  // Windows' own theme until the renderer applies the saved choice, so an
  // "auto" preference reads the truth from prefers-color-scheme before paint.
  nativeTheme.themeSource = 'system';
  mainWindow = new BrowserWindow({
    title: appName,
    icon: desktopIconPath,
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#08090a',
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#08090a', symbolColor: '#f7f7f5', height: 32 } } : {}),
    autoHideMenuBar: true,
    show: false,
    ...(safeEntryQaMode ? { x: -32000, y: -32000, opacity: 0, focusable: false, skipTaskbar: true } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // The page renders model output; its preload needs only IPC.
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.setMenu(null);

  const readyToShow = new Promise((resolve) => mainWindow.once('ready-to-show', () => {
    markDesktopStartup('window-ready-to-show');
    mainWindow?.show();
    rebuildTrayMenu();
    resolve();
  }));

  if (safeEntryQaMode) {
    mainWindow.webContents.on('preload-error', (_event, preload, error) => {
      safeEntryQaEvents.push({ type: 'preload-error', preload, message: error?.message || String(error) });
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      safeEntryQaEvents.push({ type: 'did-fail-load', code, description, validatedUrl, isMainFrame });
    });
  }

  mainWindow.on('close', (event) => {
    if (!shouldHideToTrayOnClose({
      smokeMode: smokeMode || updateDemoMode || desktopAcceptanceMode,
      shuttingDown,
      quitRequested,
    })) {
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
    rebuildTrayMenu();
    showTrayHintOnce();
  });

  mainWindow.on('show', rebuildTrayMenu);
  mainWindow.on('hide', rebuildTrayMenu);
  for (const windowEvent of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) {
    mainWindow.on(windowEvent, () => { void syncVoiceOverlayVisibility().catch(() => undefined); });
  }

  mainWindow.on('closed', () => {
    if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) voiceOverlayWindow.destroy();
    voiceOverlayWindow = null;
    if (imageProviderWindow && !imageProviderWindow.isDestroyed()) imageProviderWindow.close();
    imageProviderWindow = null;
    destroyEmbeddedImageProvider();
    mainWindow = null;
    rebuildTrayMenu();
  });

  configureMainWindowSecurity(mainWindow, runtimeUrl);

  await mainWindow.loadURL(runtimeUrl);
  markDesktopStartup('page-loaded');
  if (updateDemoMode || desktopAcceptanceMode) mainWindow.setTitle(appName);
  await readyToShow;
}

const reminderDelivery = createReminderDelivery({
  getRuntimeUrl: () => runtimeUrl,
  attestationToken: desktopAttestationToken,
  notify: showReminderNotification,
  onDelivered: (reminder) => sendToMainWindow('monarch:reminder-delivered', reminderView(reminder)),
});

function reminderView(reminder) {
  return {
    id: String(reminder?.id || ''),
    text: String(reminder?.text || '').slice(0, 500),
    dueAt: String(reminder?.dueAt || ''),
    conversationId: typeof reminder?.conversationId === 'string' ? reminder.conversationId : null,
  };
}

function sendToMainWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** A Windows notification; a click brings Monarch forward on the chat it was asked in. */
function showReminderNotification(reminder) {
  if (!Notification.isSupported()) return;
  const view = reminderView(reminder);
  const notification = new Notification({
    title: 'Напоминание от Оскара',
    body: view.text,
    silent: false,
  });
  notification.on('click', () => {
    void showMainWindow().then(() => sendToMainWindow('monarch:reminder-open', view)).catch(() => undefined);
  });
  notification.show();
}

ipcMain.handle('monarch:reminders-changed', (event) => {
  assertTrustedMainRenderer(event);
  reminderDelivery.poke();
  return { ok: true };
});

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
  if (updateDemoMode) throw new Error('Monarch Safe is disabled in the isolated update demonstration.');
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
    icon: existsSync(safeIconPath) ? safeIconPath : desktopIconPath,
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
      void lockSafeFromMain(launchedSafeWindow, launchedSafeProcess, launchedCapabilityKey);
    }
  });
  launchedSafeWindow.on('hide', () => {
    if (!ownsSafeSessionResource(safeWindow, launchedSafeWindow)) return;
    if (safeSecurityPolicy.minimizeAction === 'close') closeSafeForSystemBoundary(launchedSafeWindow, launchedSafeProcess, launchedCapabilityKey);
    else if (safeSecurityPolicy.minimizeAction === 'lock') void lockSafeFromMain(launchedSafeWindow, launchedSafeProcess, launchedCapabilityKey);
  });
  launchedSafeWindow.on('blur', () => {
    const ownsSession = ownsSafeSessionResource(safeWindow, launchedSafeWindow);
    const trustedAuthorizationOpen = Boolean(
      safeAuthorizationWindow
      && !safeAuthorizationWindow.isDestroyed()
      && safeAuthorizationWindow.getParentWindow() === launchedSafeWindow,
    );
    const trustedExportDialogOpen = safeExportDialogWindow === launchedSafeWindow;
    if (shouldLockSafeOnBlur({ ownsSession, lockOnBlur: safeSecurityPolicy.lockOnBlur, trustedAuthorizationOpen: trustedAuthorizationOpen || trustedExportDialogOpen })) {
      void lockSafeFromMain(launchedSafeWindow, launchedSafeProcess, launchedCapabilityKey);
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

async function showSafeAuthorizationPrompt({ parentWindow, title, message, detail, confirmLabel, tone = 'danger' }) {
  if (!ownsSafeSessionResource(safeWindow, parentWindow) || parentWindow.isDestroyed()) return false;
  if (safeAuthorizationWindow && !safeAuthorizationWindow.isDestroyed()) {
    safeAuthorizationWindow.focus();
    return false;
  }

  const promptWindow = new BrowserWindow({
    title: 'Monarch Safe · подтверждение',
    parent: parentWindow,
    modal: true,
    frame: false,
    width: 510,
    height: 400,
    minWidth: 510,
    minHeight: 400,
    maxWidth: 510,
    maxHeight: 400,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    backgroundColor: '#090909',
    show: false,
    skipTaskbar: true,
    ...(safeEntryQaMode ? { x: -32000, y: -32000, opacity: 0 } : {}),
    webPreferences: {
      preload: safeAuthorizationPreloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: 'monarch-safe-authorization-isolated',
    },
  });
  safeAuthorizationWindow = promptWindow;
  promptWindow.setMenu(null);
  promptWindow.setContentProtection(true);
  configureSafeWindowSecurity(promptWindow, safeAuthorizationPath);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (confirmed) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('monarch-safe:authorization-response', onResponse);
      if (ownsSafeSessionResource(safeAuthorizationWindow, promptWindow)) safeAuthorizationWindow = null;
      if (!promptWindow.isDestroyed()) promptWindow.destroy();
      if (ownsSafeSessionResource(safeWindow, parentWindow) && !parentWindow.isDestroyed()) {
        parentWindow.focus();
      }
      resolve(confirmed === true);
    };
    const onResponse = (event, confirmed) => {
      if (promptWindow.isDestroyed() || event.sender.id !== promptWindow.webContents.id) return;
      settle(confirmed === true);
    };
    ipcMain.on('monarch-safe:authorization-response', onResponse);
    promptWindow.once('closed', () => settle(false));
    promptWindow.on('blur', () => {
      if (settled || safeEntryQaMode) return;
      settle(false);
      if (ownsSafeSessionResource(safeWindow, parentWindow) && safeSecurityPolicy.lockOnBlur) {
        void lockSafeFromMain(parentWindow);
      }
    });
    promptWindow.loadFile(safeAuthorizationPath).then(() => {
      if (settled || promptWindow.isDestroyed() || !ownsSafeSessionResource(safeWindow, parentWindow)) return settle(false);
      promptWindow.webContents.send('monarch-safe:authorization-prompt', {
        title: String(title || 'Подтверждение').slice(0, 120),
        message: String(message || '').slice(0, 240),
        detail: String(detail || '').slice(0, 1200),
        confirmLabel: String(confirmLabel || 'Продолжить').slice(0, 80),
        tone: tone === 'primary' ? 'primary' : 'danger',
      });
      promptWindow.show();
      promptWindow.focus();
    }).catch(() => settle(false));
  });
}

async function runSafeEntryQa() {
  const outputRoot = process.env.MONARCH_SAFE_QA_OUTPUT_ROOT && path.isAbsolute(process.env.MONARCH_SAFE_QA_OUTPUT_ROOT)
    ? path.resolve(process.env.MONARCH_SAFE_QA_OUTPUT_ROOT, 'safe-entry-qa')
    : path.join(workspaceRoot, 'output', 'safe-entry-qa');
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

    await safeWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-pin-length="6"]').click();
      const fill = (selector, value) => {
        [...document.querySelectorAll(selector + ' input')].forEach((input, index) => {
          input.value = value[index] || '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      };
      fill('#setup-pin', '482951');
      fill('#setup-pin-confirm', '482951');
      document.querySelector('#destruction-consent').checked = true;
      document.querySelector('#setup-form').requestSubmit();
    })()`, true);
    await waitForSafeEntryQa(async () => safeWindow.webContents.executeJavaScript(
      `!document.querySelector('#recovery-screen').hidden`,
      true,
    ), 30000, 'Safe entry QA could not complete isolated first-run setup.');
    await safeWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('#recovery-saved').click();
      document.querySelector('#enter-vault').click();
    })()`, true);
    await waitForSafeEntryQa(async () => safeWindow.webContents.executeJavaScript(
      `document.querySelector('#safe-transition').hidden && !document.querySelector('#vault-screen').hidden`,
      true,
    ), 15000, 'Safe entry QA could not enter the disposable vault.');

    await safeWindow.webContents.executeJavaScript(`document.querySelector('#new-file').click()`, true);
    await waitForSafeEntryQa(async () => safeWindow.webContents.executeJavaScript(
      `document.querySelector('#item-dialog').open`,
      true,
    ), 5000, 'Safe entry QA new-file dialog did not open.');
    await safeWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('#item-name').value = 'delete-regression';
      document.querySelector('#item-type').value = 'text/markdown';
      document.querySelector('#item-form').requestSubmit();
    })()`, true);
    await waitForSafeEntryQa(async () => safeWindow.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('delete-regression.md'))`,
      true,
    ), 10000, 'Safe entry QA file was not created.');

    await safeWindow.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('[data-file-id]')].find((entry) => entry.textContent.includes('delete-regression.md'));
      row.querySelector('[data-delete-file]').click();
    })()`, true);
    await waitForSafeEntryQa(
      () => Boolean(safeAuthorizationWindow && !safeAuthorizationWindow.isDestroyed()),
      5000,
      'Styled Monarch Safe deletion confirmation did not open.',
    );
    await waitForSafeEntryQa(async () => safeAuthorizationWindow.webContents.executeJavaScript(
      `document.body.dataset.ready === 'true'`,
      true,
    ), 5000, 'Styled Monarch Safe deletion confirmation did not receive its prompt.');
    safeAuthorizationWindow.setOpacity(1);
    const confirmationState = await safeAuthorizationWindow.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('#authorization-title').textContent,
      message: document.querySelector('#authorization-message').textContent,
      detail: document.querySelector('#authorization-detail').textContent,
      confirmLabel: document.querySelector('#authorization-confirm').textContent,
      tone: document.body.dataset.tone,
      bridgeKeys: Object.keys(window.monarchSafeAuthorization || {}).sort(),
    }))()`, true);
    await sleep(350);
    const confirmationCapture = await safeAuthorizationWindow.webContents.capturePage();
    await writeFile(path.join(outputRoot, 'safe-delete-confirmation.png'), confirmationCapture.toPNG());
    await safeAuthorizationWindow.webContents.executeJavaScript(
      `document.querySelector('#authorization-cancel').click()`,
      true,
    );
    await waitForSafeEntryQa(
      () => !safeAuthorizationWindow || safeAuthorizationWindow.isDestroyed(),
      5000,
      'Cancelling the styled Safe confirmation did not close it.',
    );
    const cancelState = await safeWindow.webContents.executeJavaScript(`Promise.all([
      window.monarchSafe.request('status'),
      Promise.resolve([...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('delete-regression.md'))),
    ]).then(([status, filePresent]) => ({ unlocked: status.unlocked, filePresent }))`, true);

    await safeWindow.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('[data-file-id]')].find((entry) => entry.textContent.includes('delete-regression.md'));
      row.querySelector('[data-delete-file]').click();
    })()`, true);
    await waitForSafeEntryQa(
      () => Boolean(safeAuthorizationWindow && !safeAuthorizationWindow.isDestroyed()),
      5000,
      'Styled Monarch Safe deletion confirmation did not reopen.',
    );
    await waitForSafeEntryQa(async () => safeAuthorizationWindow.webContents.executeJavaScript(
      `document.body.dataset.ready === 'true'`,
      true,
    ), 5000, 'Reopened Safe deletion confirmation was not ready.');
    await safeAuthorizationWindow.webContents.executeJavaScript(
      `document.querySelector('#authorization-confirm').click()`,
      true,
    );
    await waitForSafeEntryQa(async () => safeWindow.webContents.executeJavaScript(
      `![...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('delete-regression.md'))`,
      true,
    ), 10000, 'Confirmed Safe deletion did not remove the file.');
    const confirmedDeleteState = await safeWindow.webContents.executeJavaScript(`window.monarchSafe.request('status').then((status) => ({
      unlocked: status.unlocked,
      toast: document.querySelector('#toast').textContent,
      authVisible: !document.querySelector('#auth-screen').hidden,
    }))`, true);

    await safeWindow.webContents.executeJavaScript(`document.querySelector('#new-file').click()`, true);
    await waitForSafeEntryQa(async () => safeWindow.webContents.executeJavaScript(
      `document.querySelector('#item-dialog').open`,
      true,
    ), 5000, 'Safe entry QA save-regression dialog did not open.');
    await safeWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('#item-name').value = 'save-regression';
      document.querySelector('#item-type').value = 'text/markdown';
      document.querySelector('#item-form').requestSubmit();
    })()`, true);
    await waitForSafeEntryQa(async () => safeWindow.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-file-id]')].some((row) => row.textContent.includes('save-regression.md'))`,
      true,
    ), 10000, 'Safe entry QA save-regression file was not created.');
    await safeWindow.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('[data-file-id]')].find((entry) => entry.textContent.includes('save-regression.md'));
      row.querySelector('.file-open-button').click();
    })()`, true);
    await waitForSafeEntryQa(async () => safeWindow.webContents.executeJavaScript(
      `!document.querySelector('#editor-active').hidden`,
      true,
    ), 5000, 'Safe entry QA save-regression editor did not open.');
    await safeWindow.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('#text-editor');
      editor.value = '# QA save regression';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#save-file').click();
    })()`, true);
    await waitForSafeEntryQa(
      () => Boolean(safeAuthorizationWindow && !safeAuthorizationWindow.isDestroyed()),
      5000,
      'Styled Monarch Safe save confirmation did not open.',
    );
    await waitForSafeEntryQa(async () => safeAuthorizationWindow.webContents.executeJavaScript(
      `document.body.dataset.ready === 'true'`,
      true,
    ), 5000, 'Styled Safe save confirmation was not ready.');
    const saveConfirmationState = await safeAuthorizationWindow.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('#authorization-title').textContent,
      confirmLabel: document.querySelector('#authorization-confirm').textContent,
      tone: document.body.dataset.tone,
    }))()`, true);
    await safeAuthorizationWindow.webContents.executeJavaScript(
      `document.querySelector('#authorization-confirm').click()`,
      true,
    );
    await waitForSafeEntryQa(async () => safeWindow.webContents.executeJavaScript(
      `document.querySelector('#toast').textContent.includes('сохранён') && document.querySelector('#save-file').dataset.dirty === 'false'`,
      true,
    ), 10000, 'Confirmed Safe save did not commit the new file generation.');
    const confirmedSaveState = await safeWindow.webContents.executeJavaScript(`window.monarchSafe.request('status').then((status) => ({
      unlocked: status.unlocked,
      toast: document.querySelector('#toast').textContent,
      dirty: document.querySelector('#save-file').dataset.dirty,
    }))`, true);

    if (confirmationState.title !== 'Удалить выбранные файлы?'
      || confirmationState.tone !== 'danger'
      || confirmationState.confirmLabel !== 'Удалить · 1'
      || !confirmationState.message.includes('«delete-regression.md» · Личное · ')
      || !/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(confirmationState.message)
      || JSON.stringify(confirmationState.bridgeKeys) !== JSON.stringify(['onPrompt', 'respond'])) {
      throw new Error(`Styled Safe confirmation contract is invalid: ${JSON.stringify(confirmationState)}`);
    }
    if (!cancelState.unlocked || !cancelState.filePresent) {
      throw new Error(`Cancelling deletion must keep Safe unlocked and preserve the file: ${JSON.stringify(cancelState)}`);
    }
    if (!confirmedDeleteState.unlocked || confirmedDeleteState.authVisible || !confirmedDeleteState.toast.includes('Файл удалён')) {
      throw new Error(`Confirmed deletion must remove the file without locking Safe: ${JSON.stringify(confirmedDeleteState)}`);
    }
    if (saveConfirmationState.tone !== 'primary'
      || saveConfirmationState.confirmLabel !== 'Сохранить версию'
      || !confirmedSaveState.unlocked
      || confirmedSaveState.dirty !== 'false') {
      throw new Error(`Confirmed save must commit without locking Safe: ${JSON.stringify({ saveConfirmationState, confirmedSaveState })}`);
    }

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
      deleteAuthorization: {
        styledDialog: confirmationState,
        cancelState,
        confirmedDeleteState,
        screenshot: path.join(outputRoot, 'safe-delete-confirmation.png'),
      },
      saveAuthorization: {
        styledDialog: saveConfirmationState,
        confirmedSaveState,
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
    cleaner.on('error', () => undefined); // Spawn failure is async; never an uncaught error in main.
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

function requestSafeService(action, payload = {}, targetProcess = safeProcess) {
  if (!targetProcess || !ownsSafeSessionResource(safeProcess, targetProcess)) {
    const error = new Error('Monarch Safe is closed. Open and unlock Safe first.');
    error.code = 'safe-runtime-closed';
    return Promise.reject(error);
  }
  if (safeServicePending.size >= 32 && action !== 'chatLock') return Promise.reject(new Error('safe-service-busy'));
  safeServiceSequence += 1;
  const id = `safe-chat-${Date.now().toString(36)}-${safeServiceSequence.toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      safeServicePending.delete(id);
      const error = new Error('Monarch Safe chat operation timed out.');
      error.code = 'safe-service-timeout';
      reject(error);
    }, action === 'chatLock' ? 5_000 : 60_000);
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
    if (payload.data?.unlocked === true) void syncProfileKeyCopies();
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

const safeHostLocks = new WeakMap();
function lockSafeFromMain(targetWindow = safeWindow, targetProcess = safeProcess, targetCapabilityKey = safeCapabilityKey) {
  if (!targetProcess) return Promise.resolve(false);
  if (safeHostLocks.has(targetProcess)) return safeHostLocks.get(targetProcess);
  const pending = enforceSafeHostLock({
    isCurrent: () => ownsSafeSessionResource(safeWindow, targetWindow) && !targetWindow.isDestroyed()
      && ownsSafeSessionResource(safeProcess, targetProcess) && ownsSafeSessionResource(safeCapabilityKey, targetCapabilityKey),
    requestLock: () => requestSafeService('chatLock', {}, targetProcess),
    notify: () => targetWindow.webContents.send('monarch-safe:force-lock'),
    close: () => closeSafeForSystemBoundary(targetWindow, targetProcess, targetCapabilityKey),
  }).finally(() => safeHostLocks.delete(targetProcess));
  safeHostLocks.set(targetProcess, pending);
  return pending;
}

function configureSafeWindowSecurity(window, allowedDocumentPath = safeIndexPath) {
  const allowedDocumentUrl = pathToFileURL(allowedDocumentPath).toString();
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
  const source = nativeImage.createFromPath(desktopIconPath);
  const icon = process.platform === 'win32' ? source.resize({ width: 16, height: 16 }) : source;
  tray = new Tray(icon);
  syncTrayTooltip();
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
    {
      label: voiceWakeState.enabled
        ? voiceWakeState.state === 'listening'
          ? 'Оскар: микрофон активен · ждёт wake-фразу'
          : `Оскар: ${voiceWakeTrayLabel(voiceWakeState.state)}`
        : 'Оскар в фоне выключен',
      enabled: false,
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

function markDesktopStartup(phase) {
  // Numeric process-relative timings only: no paths, keys or user content.
  // Keep just the first launch; reopening a tray window is not a cold startup.
  const name = 'monarch:startup:' + phase;
  if (!performance.getEntriesByName(name).length) {
    const processElapsedMs = Math.round(process.uptime() * 1000);
    performance.mark(name, { detail: { processElapsedMs } });
    const record = JSON.stringify({
      schemaVersion: 'monarch.desktop-startup-phase.v1',
      session: desktopStartupSession,
      phase,
      processElapsedMs,
    }) + '\n';
    desktopStartupLogQueue = desktopStartupLogQueue
      .then(async () => {
        await mkdir(desktopLogsRoot, { recursive: true });
        await appendFile(desktopStartupTracePath, record, { encoding: 'utf8' });
      })
      .catch(() => undefined);
  }
}

function syncTrayTooltip() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(voiceWakeState.enabled
    ? `Monarch · Оскар: ${voiceWakeTrayLabel(voiceWakeState.state)}`
    : 'Monarch · защита работает в фоне');
}

function voiceWakeTrayLabel(state) {
  if (state === 'listening') return 'слушает wake-фразу';
  if (state === 'hearing') return 'слышит речь';
  if (state === 'recognizing') return 'распознаёт локально';
  if (state === 'activated' || state === 'voice-active') return 'активен';
  if (state === 'permission-denied') return 'нет доступа к микрофону';
  if (state === 'dictation-active') return 'микрофон у диктовки';
  if (state === 'starting') return 'подключает микрофон';
  if (state === 'settings-loading') return 'загружает настройки';
  if (state === 'error') return 'перезапускается';
  return 'выключен';
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
    void openContentLink(window, url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (isTrustedRuntimeUrl(navigationUrl, trustedRuntimeUrl)) {
      return;
    }
    event.preventDefault();
    void openContentLink(window, navigationUrl);
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

/** Stage 3f: keeps the copies of the profile data key the person chose in
 * Monarch Security. The Safe copy is refreshed only while Safe is open; this
 * never asks for its PIN. While the key itself is lost nothing is removed:
 * the copies are then the only way back. */
let profileKeySync = null;
function syncProfileKeyCopies() {
  profileKeySync ||= (async () => {
    try {
      if (profileKeyProblem || !runtimeStoreKey) return;
      const level = await readSecurityPolicyLevel('storage.keyRecovery');
      if (!level) return;
      await profileKeyRecovery.removeUnwanted(level);
      if (!wantsCopy(level, 'safe') || !safeProcess) return;
      if ((await requestSafeService('chatStatus'))?.unlocked !== true) return;
      const { key } = await profileDataKeyStore.load();
      if (!key) return;
      const wrapping = await requestSafeService('profileKeyBackupKey');
      const copies = await profileKeyRecovery.status(key);
      if (copies.safe.current && copies.safe.vaultId === wrapping?.vaultId) return;
      await profileKeyRecovery.writeSafeCopy(key, wrapping);
    } catch (error) {
      console.warn(`Profile key copy not updated (${error?.message || 'error'}).`);
    } finally {
      profileKeySync = null;
    }
  })();
  return profileKeySync;
}

async function profileKeyRecoveryView() {
  const level = await readSecurityPolicyLevel('storage.keyRecovery');
  const key = profileKeyProblem || !runtimeStoreKey ? null : (await profileDataKeyStore.load().catch(() => null))?.key ?? null;
  const copies = await profileKeyRecovery.status(key);
  const safeOpen = safeProcess ? (await requestSafeService('chatStatus').catch(() => null))?.unlocked === true : false;
  const describe = copy => ({ present: copy.present, current: copy.current, damaged: copy.damaged === true });
  return {
    state: profileKeyProblem ?? (key ? 'ok' : 'session'),
    level,
    safeOpen,
    copies: { safe: describe(copies.safe), code: describe(copies.code) },
  };
}

function profileKeyRecoveryMessage(error) {
  switch (String(error?.message || '')) {
  case 'profile-key-recovery:code-format': return 'Код выглядит неполным: в нём 25 букв и цифр.';
  case 'profile-key-recovery:wrong-secret': return 'Не подошло. Проверь код или открой тот Safe, где лежит копия.';
  case 'profile-key-recovery:other-safe': return 'Копия ключа сделана в другом Monarch Safe.';
  case 'profile-key-recovery:safe-locked': return 'Открой Monarch Safe и повтори.';
  case 'profile-key-recovery:no-safe-copy': return 'Копии ключа в Monarch Safe нет.';
  case 'profile-key-recovery:no-code-copy': return 'Копии ключа под кодом восстановления нет.';
  case 'profile-data-key:different-key': return 'На этом компьютере уже работает другой ключ истории. Восстановление его не заменит.';
  case 'profile-data-key:os-encryption': return 'Шифрование Windows недоступно, ключ некуда сохранить.';
  default: return 'Не удалось восстановить ключ. Данные на диске не изменены.';
  }
}

ipcMain.handle('monarch:profile-key-status', async (event) => {
  assertTrustedMainRenderer(event);
  await syncProfileKeyCopies();
  return profileKeyRecoveryView();
});
ipcMain.handle('monarch:profile-key-create-code', async (event) => {
  assertTrustedMainRenderer(event);
  if (profileKeyProblem) throw Error('Сначала восстанови доступ к истории.');
  if (!wantsCopy(await readSecurityPolicyLevel('storage.keyRecovery'), 'code')) {
    throw Error('Код восстановления выключен в настройках восстановления ключа.');
  }
  const { key } = await profileDataKeyStore.load();
  if (!key || !runtimeStoreKey) throw Error('Шифрование Windows недоступно: история хранится только до закрытия Monarch, копировать нечего.');
  const code = generateRecoveryCode();
  await profileKeyRecovery.writeCodeCopy(key, code);
  return { code };
});
ipcMain.handle('monarch:profile-key-recover', async (event, value = {}) => {
  assertTrustedMainRenderer(event);
  if (!['needs-recovery', 'damaged-record'].includes(profileKeyProblem)) throw Error('Ключ истории на месте, восстанавливать нечего.');
  let key = null;
  try {
    if (value?.method === 'code') {
      key = await profileKeyRecovery.openCodeCopy(String(value.code || ''));
    } else if (value?.method === 'safe') {
      if (!safeProcess || (await requestSafeService('chatStatus'))?.unlocked !== true) throw Error('profile-key-recovery:safe-locked');
      key = await profileKeyRecovery.openSafeCopy(await requestSafeService('profileKeyBackupKey'));
    } else {
      throw Error('profile-key-recovery:method');
    }
    await profileDataKeyStore.restore(key);
  } catch (error) {
    throw Error(profileKeyRecoveryMessage(error));
  } finally {
    key?.fill(0);
  }
  // The runtime and Oscar start again with the recovered key.
  setImmediate(() => {
    quitRequested = true;
    app.relaunch();
    app.quit();
  });
  return { ok: true, relaunching: true };
});

/** A level from the Monarch Security policy center, or null when the runtime
 * cannot answer; callers then keep their safe default. */
async function readSecurityPolicyLevel(controlId) {
  try {
    if (!runtimeUrl) return null;
    const response = await fetch(new URL('/api/security/policy', runtimeUrl), {
      headers: { 'X-Monarch-Desktop-Attestation': desktopAttestationToken },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const view = await response.json();
    const level = view?.controls?.find?.(item => item?.id === controlId)?.level;
    return typeof level === 'string' ? level : null;
  } catch {
    return null;
  }
}

/** Links in the main window come from model answers and pages: the person
 * confirms each one unless they turned that off in Monarch Security (F-10). */
async function openContentLink(window, value) {
  const open = await shouldOpenContentLink({
    url: value,
    readLevel: async () => {
      const level = await readSecurityPolicyLevel('links.confirmOpen');
      if (!level) throw new Error('policy-unavailable');
      return level;
    },
    confirm: async (target) => {
      const url = new URL(target);
      const shown = target.length > 300 ? target.slice(0, 300) + '…' : target;
      const { response } = await dialog.showMessageBox(window && !window.isDestroyed() ? window : undefined, {
        type: 'question',
        buttons: ['Открыть', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Открыть ссылку',
        message: `Открыть сайт ${url.hostname} в браузере?`,
        detail: `${shown}\n\nСайт узнает о переходе и обо всём, что записано в ссылке.`,
      });
      return response === 0;
    },
  });
  if (open) await openExternalSafely(value);
}

async function openExternalSafely(value) {
  const url = readExternalHttpUrl(value);
  if (!url) return false;
  await shell.openExternal(url).catch(() => undefined);
  return true;
}

async function ensureVoiceOverlayWindow() {
  if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) return voiceOverlayWindow;
  if (![voiceOverlayPreloadPath, voiceOverlayIndexPath].every(existsSync)) {
    throw new Error('Voice overlay runtime files are missing.');
  }
  const overlay = new BrowserWindow({
    width: 620,
    height: 260,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
      webPreferences: {
        partition: 'monarch-voice-overlay',
        preload: voiceOverlayPreloadPath,
        contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  voiceOverlayWindow = overlay;
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== pathToFileURL(voiceOverlayIndexPath).toString()) event.preventDefault();
  });
  const isolatedSession = overlay.webContents.session;
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  overlay.on('closed', () => {
    if (voiceOverlayWindow === overlay) voiceOverlayWindow = null;
  });
  await overlay.loadFile(voiceOverlayIndexPath);
  positionVoiceOverlay(overlay);
  return overlay;
}

function mainWindowInFront() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    && !mainWindow.isMinimized() && mainWindow.isFocused());
}

async function syncVoiceOverlayVisibility() {
  const payload = voiceOverlayPayload;
  if (!payload?.visible || mainWindowInFront()) {
    if (voiceOverlayWindow && !voiceOverlayWindow.isDestroyed()) voiceOverlayWindow.hide();
    return false;
  }
  const overlay = await ensureVoiceOverlayWindow();
  if (voiceOverlayPayload !== payload) return Boolean(voiceOverlayPayload?.visible) && overlay.isVisible();
  positionVoiceOverlay(overlay);
  overlay.webContents.send('monarch:voice-overlay-state', payload);
  if (!overlay.isVisible()) overlay.showInactive();
  return true;
}

function positionVoiceOverlay(overlay = voiceOverlayWindow) {
  if (!overlay || overlay.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = overlay.getBounds();
  const x = Math.round(display.workArea.x + (display.workArea.width - bounds.width) / 2);
  const y = Math.round(display.workArea.y + display.workArea.height - bounds.height - 12);
  overlay.setPosition(x, y, false);
}

function normalizeVoiceOverlayPayload(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clean = (field, maximum) => String(input[field] || '')
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
  const rawCard = input.card && typeof input.card === 'object' && !Array.isArray(input.card) ? input.card : null;
  const cardKind = rawCard && ['weather', 'exchange-rate'].includes(String(rawCard.kind || ''))
    ? String(rawCard.kind)
    : '';
  const metrics = cardKind && Array.isArray(rawCard.metrics)
    ? rawCard.metrics.slice(0, 3).flatMap((metric) => {
        if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return [];
        const label = String(metric.label || '').replace(/[\u0000-\u001F\u007F]/gu, ' ').trim().slice(0, 40);
        const metricValue = String(metric.value || '').replace(/[\u0000-\u001F\u007F]/gu, ' ').trim().slice(0, 60);
        return label && metricValue ? [{ label, value: metricValue }] : [];
      })
    : [];
  const card = cardKind ? {
    kind: cardKind,
    title: String(rawCard.title || '').replace(/[\u0000-\u001F\u007F]/gu, ' ').trim().slice(0, 120),
    primary: String(rawCard.primary || '').replace(/[\u0000-\u001F\u007F]/gu, ' ').trim().slice(0, 80),
    summary: String(rawCard.summary || '').replace(/[\u0000-\u001F\u007F]/gu, ' ').trim().slice(0, 160),
    metrics,
    attribution: String(rawCard.provider?.attribution || '').replace(/[\u0000-\u001F\u007F]/gu, ' ').trim().slice(0, 120),
  } : null;
  return {
    visible: input.visible === true,
    phase: clean('phase', 32) || 'idle',
    lane: clean('lane', 32) || 'simplified',
    kicker: clean('kicker', 80),
    title: clean('title', 120),
    detail: clean('detail', 300),
    text: clean('text', 360),
    design: input.design === 'classic' ? 'classic' : 'pp',
    theme: input.theme === 'dark' ? 'dark' : 'light',
    ...(card ? { card } : {}),
  };
}

function normalizeVoiceWakeState(value) {
  const allowed = new Set([
    'disabled', 'settings-loading', 'starting', 'listening', 'hearing', 'recognizing', 'activated',
    'voice-active', 'dictation-active', 'permission-denied', 'manual-only', 'error',
  ]);
  const state = String(value?.state || 'disabled').trim();
  const diagnostic = value?.diagnostic && typeof value.diagnostic === 'object'
    ? {
        stage: String(value.diagnostic.stage || '').trim().slice(0, 80),
        code: String(value.diagnostic.code || '').trim().slice(0, 80),
        message: String(value.diagnostic.message || '').trim().replace(/\s+/g, ' ').slice(0, 240),
      }
    : null;
  return {
    state: allowed.has(state) ? state : 'error',
    enabled: value?.enabled === true,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

async function showImageProviderWindow(url) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main Monarch window is unavailable.');
  if (!imageProviderWindow || imageProviderWindow.isDestroyed()) {
    imageProviderWindow = new BrowserWindow({
      title: 'Monarch Images · Perchance',
      parent: mainWindow,
      width: 1180,
      height: 820,
      minWidth: 760,
      minHeight: 620,
      backgroundColor: '#101112',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'monarch-perchance-provider',
      },
    });
    imageProviderWindow.setMenu(null);
    imageProviderWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    imageProviderWindow.webContents.session.setPermissionCheckHandler(() => false);
    imageProviderWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      if (isAllowedImageProviderUrl(targetUrl)) {
        void imageProviderWindow?.loadURL(targetUrl);
      } else {
        void openExternalSafely(targetUrl);
      }
      return { action: 'deny' };
    });
    imageProviderWindow.webContents.on('will-navigate', (event, targetUrl) => {
      if (isAllowedImageProviderUrl(targetUrl)) return;
      event.preventDefault();
      void openExternalSafely(targetUrl);
    });
    imageProviderWindow.webContents.on('did-finish-load', () => applyImageProviderSurfaceCss(imageProviderWindow?.webContents));
    configureImageProviderDownloads(imageProviderWindow.webContents.session);
    imageProviderWindow.on('closed', () => { imageProviderWindow = null; });
    imageProviderWindow.once('ready-to-show', () => imageProviderWindow?.show());
  }
  if (imageProviderWindow.webContents.getURL() !== url) await imageProviderWindow.loadURL(url);
  imageProviderWindow.show();
  imageProviderWindow.focus();
}

async function showEmbeddedImageProvider(url, bounds, zoom) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main Monarch window is unavailable.');
  if (!embeddedImageProviderView || embeddedImageProviderView.webContents.isDestroyed()) {
    embeddedImageProviderView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        spellcheck: true,
        partition: 'monarch-perchance-provider',
      },
    });
    embeddedImageProviderView.setBackgroundColor('#101112');
    embeddedImageProviderView.setBorderRadius(14);
    mainWindow.contentView.addChildView(embeddedImageProviderView);
    configureEmbeddedImageProvider(embeddedImageProviderView);
  }
  embeddedImageProviderView.setBounds(bounds);
  embeddedImageProviderView.webContents.zoomFactor = zoom;
  if (embeddedImageProviderView.webContents.getURL() !== url) {
    embeddedImageProviderView.setVisible(false);
    await embeddedImageProviderView.webContents.loadURL(url);
  }
  embeddedImageProviderView.setVisible(true);
  embeddedImageProviderView.webContents.focus();
}

function configureEmbeddedImageProvider(view) {
  const contents = view.webContents;
  const providerSession = contents.session;
  providerSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  providerSession.setPermissionCheckHandler(() => false);
  configureImageProviderDownloads(providerSession);
  contents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isAllowedImageProviderUrl(targetUrl)) void contents.loadURL(targetUrl);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedImageProviderUrl(targetUrl)) return;
    event.preventDefault();
  });
  contents.on('did-start-loading', () => sendEmbeddedImageProviderState('loading'));
  contents.on('did-finish-load', () => {
    applyImageProviderSurfaceCss(contents);
    sendEmbeddedImageProviderState('ready', { url: contents.getURL() });
  });
  contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame === false || code === -3) return;
    sendEmbeddedImageProviderState('error', { code, description, url: validatedUrl });
  });
  contents.on('render-process-gone', (_event, details) => {
    sendEmbeddedImageProviderState('error', { description: details?.reason || 'provider-renderer-stopped' });
  });
}

function applyImageProviderSurfaceCss(contents) {
  if (!contents || contents.isDestroyed()) return;
  void contents.insertCSS(`
    :root { color-scheme: dark; }
    html, body { background-color: #101112 !important; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: #101112; }
    ::-webkit-scrollbar-thumb { background: #4a4032; border: 2px solid #101112; border-radius: 999px; }
    ::selection { background: #ff9c3538; }
    :focus-visible { outline-color: #ff9c35 !important; }
  `).catch(() => undefined);
}

function configureImageProviderDownloads(providerSession) {
  if (configuredImageProviderSessions.has(providerSession)) return;
  configuredImageProviderSessions.add(providerSession);
  mkdirSync(imageProviderDownloadRoot, { recursive: true });
  providerSession.on('will-download', createImageProviderDownloadHandler({
    root: imageProviderDownloadRoot,
    isTrustedSource: (contents) => contents?.id === embeddedImageProviderView?.webContents.id
      || contents?.id === imageProviderWindow?.webContents.id,
    emit: sendImageProviderDownloadState,
  }));
}

function sendImageProviderDownloadState(value) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('monarch:image-provider-download', value);
}

function sendEmbeddedImageProviderState(status, detail = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('monarch:image-provider-state', { status, ...detail });
}

function destroyEmbeddedImageProvider() {
  const view = embeddedImageProviderView;
  embeddedImageProviderView = null;
  if (!view) return;
  const providerSession = view.webContents.session;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
  void providerSession.clearStorageData().catch(() => undefined);
}

function normalizeImageProviderPrompt(value) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/gu, '').trim().slice(0, 8_000);
}

let developmentMaxBundlePrepared = false;
async function startRuntime({ requestedPort = null, preserveModelHostOnFailure = false } = {}) {
  markDesktopStartup('runtime-start');
  const nodePath = resolveNodeExecutable();
  const runtimeLaunch = await prepareDevelopmentRuntime({
    workspaceRoot,
    outputRoot: desktopRuntimeRoot,
    preferSource: !app.isPackaged && !installedLayout,
  });
  if (!developmentMaxBundlePrepared) {
    developmentMaxBundlePrepared = true;
    // Before the MAX host is first loaded; a failed build keeps the last bundle.
    await prepareDevelopmentMaxBundle({ workspaceRoot,
      preferSource: !app.isPackaged && !installedLayout && astraMaxNativeEnabled }).catch((error) => {
      console.error(JSON.stringify({ diagnostic: 'development-max-build-failed', code: error?.code || error?.name || 'error' }));
    });
  }
  markDesktopStartup('runtime-entry-ready');

  const port = requestedPort === null ? await findFreePort(4317, 40) : requestedPort;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('runtime-port-invalid');
  markDesktopStartup('runtime-port-ready');
  const ownerAuthority = !safeEntryQaMode && !safeLaunchMode && !updateDemoMode
    ? await prepareOwnerAuthoritySession({
      authorityRoot: ownerAuthorityRoot,
      safeStorage,
      desktopAttestationToken,
      runtimePort: port,
    }).catch(() => ({ environmentValue: '', summary: { tier: 'public', diagnostic: 'owner-bootstrap-failed' } }))
    : { environmentValue: '', summary: { tier: 'public', diagnostic: 'owner-disabled-in-isolated-mode' } };
  markDesktopStartup('runtime-owner-authority-ready');
  const astraJournalKey = astraRuntimePilotMode
    ? await loadOrCreateAstraJournalKey({ rootPath: astraJournalProtectionRoot, safeStorage })
    : null;
  if (astraRuntimePilotMode && !astraJournalKey) {
    throw new Error('Astra V3 journal encryption is unavailable. Use --disable-astra-v3 only for isolated diagnostics without Agent execution.');
  }
  markDesktopStartup('runtime-journal-key-ready');
  // Never trust inherited shell authority. Only the source CLI policy authors
  // a fresh paired mode and main-process-only host capability for this child.
  if (astraRuntimePilotMode && astraMaxSourcePreviewMode && !astraMaxModelServer) {
    astraMaxModelServer = await startAstraMaxModelServer({ mode: astraMaxSourcePreviewMode,
      host: await astraMaxDesktopBridge.preparedModelHost() });
  }
  markDesktopStartup('runtime-source-model-host-ready');
  if (astraMaxNativeEnabled && !astraMaxNativeServer) {
    astraMaxNativeServer = await startAstraMaxNativeServer({ complete: (input, signal) => astraMaxDesktopBridge.completeNative(input, signal),
      stream: (input, signal) => astraMaxDesktopBridge.streamNative(input, signal),
      status: async () => {
        const view = await astraMaxDesktopBridge.providers();
        return view.available === true && Array.isArray(view.providers)
          && view.providers.some(provider => provider?.id === view.selectedProviderId && provider?.state === 'ready');
      } });
  }
  markDesktopStartup('runtime-native-max-ready');
  if (!telegramSecretServer && !safeLaunchMode && !desktopAcceptanceMode && !smokeMode) telegramSecretServer = await startTelegramSecretServer(telegramSecretBroker);
  markDesktopStartup('runtime-telegram-broker-ready');
  if (!safeLaunchMode && !desktopAcceptanceMode && !smokeMode) await serviceIntegrationRegistry.startAll();
  markDesktopStartup('runtime-service-integrations-ready');
  if (astraMaxNativeEnabled && astraRuntimePilotMode && !astraMaxNativePreparedServer) {
    try { astraMaxNativePreparedServer = await startAstraMaxModelServer({ mode: 'native-desktop',
      host: await astraMaxDesktopBridge.preparedModelHost() }); }
    catch { console.warn('MAX file analysis unavailable: build the MAX host bundle. Local mode is unchanged.'); }
  }
  markDesktopStartup('runtime-prepared-max-ready');
  if (runtimeStoreKey === undefined) {
    // A damaged record never becomes a new key: the runtime then keeps personal
    // data for this session only and leaves what is on disk untouched.
    const profileKey = await profileDataKeyStore.load().catch((error) => {
      console.warn(`Profile data key unavailable (${error?.message || 'error'}); personal data stays in this session.`);
      profileKeyProblem = error?.message === 'profile-data-key:needs-recovery' ? 'needs-recovery'
        : error?.message === 'profile-data-key:record' ? 'damaged-record' : 'unavailable';
      return { key: null, persistent: false };
    });
    runtimeStoreKey = profileKey.key ? deriveProfileStoreKey(profileKey.key, 'runtime-sealed').toString('base64url') : null;
    oscarDatabaseKey = profileKey.key ? deriveProfileStoreKey(profileKey.key, 'oscar-memory').toString('hex') : null;
  }
  if (!oscarApiKey) {
    // A damaged record or a refused ACL keeps Oscar running on a key for this
    // session only; it never falls back to a plain-text file.
    oscarApiKey = await oscarApiKeyStore.load().catch((error) => {
      console.warn(`Oscar API key record unavailable (${error?.message || 'error'}); using a session key.`);
      return Object.freeze({ key: randomBytes(32).toString('hex'), persistent: false, migrated: false });
    });
  }
  const modelHost = astraMaxModelServer ? { endpoint: astraMaxModelServer.endpoint,
    bearerToken: astraMaxModelServer.bearerToken, hostGeneration: astraMaxModelServer.hostGeneration,
    modelDigest: astraMaxModelServer.modelDigest, modelDigests: astraMaxModelServer.modelDigests } : null;
  let env;
  try {
    env = prepareAstraRuntimePilotEnvironment({ environment: {
      ...process.env,
      MONARCH_UI_PORT: String(port),
      MONARCH_STRICT_PORT: '1',
      MONARCH_STARTUP_TRACE: '1',
      MONARCH_DESKTOP_ATTESTATION_TOKEN: desktopAttestationToken,
      MONARCH_API_TOKEN: runtimeApiToken,
      OSCAR_API_TOKEN: oscarApiKey.key,
      MONARCH_STORE_PROTECTION: 'desktop',
      ...(runtimeStoreKey ? { MONARCH_STORE_KEY: runtimeStoreKey } : {}),
      ...(oscarDatabaseKey ? { MONARCH_OSCAR_DB_KEY: oscarDatabaseKey } : {}),
      MONARCH_MAX_NATIVE_ENDPOINT: astraMaxNativeServer?.endpoint || '',
      MONARCH_MAX_NATIVE_TOKEN: astraMaxNativeServer?.bearerToken || '',
      MONARCH_TELEGRAM_HOST_ENDPOINT: telegramSecretServer?.endpoint || '',
      MONARCH_TELEGRAM_HOST_TOKEN: telegramSecretServer?.bearerToken || '',
      ...serviceIntegrationRegistry.runtimeEnvironment(),
      MONARCH_MAX_PREPARED_HOST: astraMaxNativePreparedServer ? JSON.stringify({ endpoint: astraMaxNativePreparedServer.endpoint,
        bearerToken: astraMaxNativePreparedServer.bearerToken, hostGeneration: astraMaxNativePreparedServer.hostGeneration,
        modelDigest: astraMaxNativePreparedServer.modelDigest, modelDigests: astraMaxNativePreparedServer.modelDigests,
        ...(astraMaxNativePreparedServer.dynamicMaxCloud === true ? { dynamicMaxCloud: true } : {}) }) : '',
    }, mode: astraRuntimePilotMode, telegramMode: astraTelegramPilotMode, hostToken: astraV3HostToken, modelHost,
      journalKey: astraJournalKey?.toString('base64') ?? null,
      managedLocal: Boolean(astraRuntimePilotMode && !modelHost && !process.argv.includes('--astra-v3-same-owner-pilot')) });
  } finally { astraJournalKey?.fill(0); }
  markDesktopStartup('runtime-environment-ready');
  if (desktopRuntimeIsolationProfile) {
    const isolatedDataRoot = path.join(desktopRuntimeIsolationProfile, 'data');
    const isolatedStateRoot = path.join(desktopRuntimeIsolationProfile, 'state');
    await Promise.all([
      mkdir(isolatedDataRoot, { recursive: true }),
      mkdir(isolatedStateRoot, { recursive: true }),
    ]);
    env.MONARCH_DATA_ROOT = isolatedDataRoot;
    env.MONARCH_STATE_ROOT = isolatedStateRoot;
  }
  if (ownerAuthority.environmentValue) env.MONARCH_OWNER_AUTHORITY_ENVELOPE = ownerAuthority.environmentValue;
  else delete env.MONARCH_OWNER_AUTHORITY_ENVELOPE;
  // Voice Mode owns STT preparation after the shared Qwen warmup settles.
  // Do not let an inherited shell flag race Vosk/sherpa allocation with TTS.
  delete env.MONARCH_STT_PREWARM_ON_ACTIVATE;
  if (runtimeLaunch.kind === 'source-bundle' || runtimeLaunch.kind === 'bundle') {
    // Node keys compiled code by source content. Installed caches belong with
    // the payload on E:/D:, rather than the user profile on the system disk.
    env.NODE_COMPILE_CACHE = path.join(configuredPayloadRoot || desktopRuntimeRoot,
      'development', 'node-compile-cache');
  }
  const outPath = path.join(desktopLogsRoot, `electron-server-${port}.out.log`);
  const errPath = path.join(desktopLogsRoot, `electron-server-${port}.err.log`);
  // Appended on every start and never rotated, these logs only grew (the dev
  // ones reached megabytes in weeks). One previous generation is kept.
  await rotateRuntimeLog(outPath);
  await rotateRuntimeLog(errPath);
  const out = await import('node:fs').then((fs) => fs.createWriteStream(outPath, { flags: 'a' }));
  const err = await import('node:fs').then((fs) => fs.createWriteStream(errPath, { flags: 'a' }));
  out.write(`[desktop] Runtime entry: ${runtimeLaunch.kind} ${runtimeLaunch.entryPath}\n`);

  runtimeReady = false;
  let spawnError = null;
  let launchedProcess;
  try {
    launchedProcess = spawn(nodePath, [...runtimeLaunch.args, 'serve', '--port', String(port)], {
      cwd: workspaceRoot,
      env: { ...env, MONARCH_PARENT_LIFELINE: 'stdin' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // The lifeline is never written to; only its closing matters.
    launchedProcess.stdin.on('error', () => undefined);
  } catch (error) {
    if (!preserveModelHostOnFailure) await stopAstraMaxModelServer();
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'spawn-error';
    throw new Error(`Runtime spawn failed (${code}) using ${nodePath} and ${runtimeLaunch.kind} entry ${runtimeLaunch.entryPath}.`);
  }
  serverProcess = launchedProcess;
  markDesktopStartup('runtime-process-spawned');
  launchedProcess.stdout.pipe(out);
  launchedProcess.stderr.pipe(err);
  launchedProcess.once('error', (error) => {
    spawnError = error;
  });
  launchedProcess.once('exit', (code, signal) => {
    if (serverProcess !== launchedProcess || shuttingDown || smokeMode || !runtimeReady) return;
    runtimeReady = false;
    serverProcess = null;
    const failure = new Error(`Monarch runtime exited (${code ?? signal ?? 'unknown'}).`);
    // One runtime fault (live: an EPERM on a state file) used to close the
    // whole application. Restart it under the same bounded budget the Astra
    // pilot uses; only repeated faults end the app.
    void recoverRuntime(port, failure);
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForRuntimeReady({
      fetchHealth: () => fetchJson(`${url}/api/ready`),
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
    markDesktopStartup('runtime-health-ready');
    return url;
  } catch (error) {
    if (!preserveModelHostOnFailure) await stopAstraMaxModelServer();
    if (serverProcess === launchedProcess) stopRuntime();
    throw error;
  }
}

/** Restart a runtime that exited until it stays up; only the person closes
 * Monarch (see runtime-recovery-policy.mjs for why it no longer gives up). */
async function recoverRuntime(port, originalFailure) {
  if (runtimeRecoveryPromise || shuttingDown || quitRequested) return runtimeRecoveryPromise;
  runtimeRecoveryPromise = (async () => {
    let failure = originalFailure;
    while (!shuttingDown && !quitRequested) {
      const delayMs = runtimeRecovery.nextDelay();
      console.error(JSON.stringify({ diagnostic: 'runtime-recovery', attempt: runtimeRecovery.attempts, delayMs,
        cause: String(failure.message).slice(0, 120) }));
      await sleep(delayMs);
      if (shuttingDown || quitRequested) return;
      try {
        const recoveredUrl = await startRuntime({ requestedPort: port, preserveModelHostOnFailure: true });
        if (runtimeUrl && recoveredUrl !== runtimeUrl) {
          // The window and its session belong to the old origin; a runtime on
          // another port would be unreachable and would hold its port forever.
          stopRuntime();
          throw Error('runtime-recovery-origin-changed');
        }
        runtimeUrl = recoveredUrl;
        runtimeRecovery.healthy();
        if (astraRuntimePilotMode) reloadLinkedAstraPilot();
        else reloadMainWindowAfterRecovery();
        return;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
  })().finally(() => { runtimeRecoveryPromise = null; });
  return runtimeRecoveryPromise;
}

/** The page talks to the runtime it was loaded from; after a restart on the
 * same origin a reload resubscribes it. Conversations and Turns are durable
 * server-side, so nothing the person saw as finished is lost. */
function reloadMainWindowAfterRecovery() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    if (new URL(mainWindow.webContents.getURL()).origin === runtimeUrl) mainWindow.webContents.reload();
  } catch {
    // A window not showing the runtime has nothing to resubscribe.
  }
}

function reloadLinkedAstraPilot() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try {
    const current = new URL(mainWindow.webContents.getURL());
    if (current.origin !== runtimeUrl || !(current.searchParams.has('astraTurnId')
      || current.searchParams.has('astraPendingRequestId'))) return;
    mainWindow.webContents.reload();
  } catch {
    // The renderer can still use its exact retained request manually.
  }
}

const RUNTIME_LOG_ROTATE_BYTES = 8 * 1024 * 1024;
async function rotateRuntimeLog(filePath) {
  try {
    const info = await import('node:fs/promises').then((fs) => fs.stat(filePath));
    if (info.size > RUNTIME_LOG_ROTATE_BYTES) await renameWithRetry(filePath, filePath + '.1');
  } catch {
    // Missing or locked: keep appending; the next start tries again.
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

/** Closing the lifeline lets the server stop its application (task lease,
 * stores, model hosts) the way SIGTERM would elsewhere; kill() on Windows is
 * TerminateProcess and skipped all of that. Bounded: a server that does not
 * exit in time is still killed. */
async function stopRuntimeGracefully(timeoutMs = 8_000) {
  const child = serverProcess;
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) { stopRuntime(); return; }
  runtimeReady = false;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.stdin?.end(); } catch { /* fall through to kill */ }
  const timer = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([exited, timer]);
  if (serverProcess === child) stopRuntime();
}

function readJsonFileIfPresent(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readSecurityStartupState(health) {
  const records = Array.isArray(health?.loadRecords) ? health.loadRecords : [];
  const security = records.find((record) => record?.moduleId === 'security');
  // Module loading proves availability, not the health of the separate protector.
  if (security?.status === 'loaded') return 'available';
  return 'invalid';
}

async function shutdownDesktop() {
  shuttingDown = true;
  reminderDelivery.stop();
  globalShortcut.unregister('Control+Alt+Escape');
  speechOutput.dispose();
  await speechLogQueue.catch(() => undefined);
  if (safeWindow && !safeWindow.isDestroyed()) safeWindow.destroy();
  stopSafeRuntime();
  // Safe entry QA can attach to an already running production Oscar backend.
  // It must never shut down a runtime owned by the real Desktop instance.
  // A standalone Safe window is a client of the already-running Monarch services.
  // Closing that shortcut must never tear down Oscar for the main Monarch app.
  if (!safeEntryQaMode && !safeLaunchMode && !updateDemoMode && !desktopAcceptanceMode) {
    await stopOscarBackend().catch(() => undefined);
  }
  await stopRuntimeGracefully();
  await stopAstraMaxModelServer();
  await cleanupImageProviderDownloads();
  await cleanupDesktopRuntimeIsolation();
}

async function stopAstraMaxModelServer() {
  await serviceIntegrationRegistry.closeAll();
  telegramSecretBroker.closeCloud();
  const telegram = telegramSecretServer;
  telegramSecretServer = null;
  await telegram?.close().catch(() => undefined);
  const prepared = astraMaxNativePreparedServer;
  astraMaxNativePreparedServer = null;
  await prepared?.close().catch(() => undefined);
  const native = astraMaxNativeServer;
  astraMaxNativeServer = null;
  await native?.close().catch(() => undefined);
  const active = astraMaxModelServer;
  astraMaxModelServer = null;
  await active?.close().catch(() => undefined);
}

function registerComputerUseEmergencyShortcut() {
  const accelerator = 'Control+Alt+Escape';
  globalShortcut.unregister(accelerator);
  const registered = globalShortcut.register(accelerator, () => {
    void emergencyStopComputerUse('desktop-global-shortcut');
  });
  if (!registered) {
    console.warn(`Computer Use emergency shortcut could not be registered: ${accelerator}`);
  }
}

async function emergencyStopComputerUse(requestedBy = 'desktop-emergency-stop') {
  if (!runtimeUrl || computerUseEmergencyStopRunning) return false;
  computerUseEmergencyStopRunning = true;
  try {
    const response = await fetch(new URL('/api/computer-use/emergency-stop', runtimeUrl), {
      method: 'POST',
      headers: {
        'X-Monarch-Desktop-Attestation': desktopAttestationToken,
      },
    });
    const payload = await response.json().catch(() => ({}));
    const stopped = response.ok && payload?.result?.ok === true;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('monarch:computer-use-emergency-stop', {
        ok: stopped,
        requestedBy,
        shortcut: 'Ctrl+Alt+Escape',
        result: payload?.result || null,
      });
    }
    return stopped;
  } catch (error) {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('monarch:computer-use-emergency-stop', {
        ok: false,
        requestedBy,
        shortcut: 'Ctrl+Alt+Escape',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  } finally {
    computerUseEmergencyStopRunning = false;
  }
}

async function cleanupImageProviderDownloads() {
  const resolvedRoot = path.resolve(imageProviderDownloadRoot);
  const resolvedParent = path.resolve(imageProviderDownloadParent);
  if (path.dirname(resolvedRoot).toLowerCase() !== resolvedParent.toLowerCase()) return;
  await rm(resolvedRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function cleanupDesktopRuntimeIsolation() {
  if (!desktopRuntimeIsolationProfile) return;
  const isolationRoot = path.resolve(desktopRuntimeIsolationProfile);
  const expectedParent = path.resolve(workspaceRoot, 'runtime');
  const allowedPrefix = desktopAcceptanceProfile ? 'desktop-acceptance-' : 'desktop-smoke-';
  if (path.dirname(isolationRoot).toLowerCase() === expectedParent.toLowerCase()
    && path.basename(isolationRoot).startsWith(allowedPrefix)) {
    await rm(isolationRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function stopOscarBackend() {
  // Only a backend this Desktop started knows the key; nothing to stop otherwise.
  const token = oscarApiKey?.key;
  if (!token) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const correlation = randomBytes(18).toString('base64url');
  try {
    const readBinding = async (candidateToken) => {
      const health = await fetch('http://127.0.0.1:7861/api/health', {
        headers: { 'X-Oscar-Token': candidateToken }, signal: controller.signal,
      });
      if (!health.ok) throw new Error(`Oscar health returned HTTP ${health.status}.`);
      const payload = await health.json();
      if (payload?.authenticated !== true) return null;
      const generation = payload?.lifecycle?.host_generation;
      const pid = payload?.lifecycle?.process_id;
      if (typeof generation !== 'string' || !generation.startsWith('backend_') || !Number.isSafeInteger(pid)) {
        throw new Error('Oscar health returned an invalid host binding.');
      }
      return { generation, pid };
    };
    const binding = await readBinding(token);
    if (!binding) throw new Error('Oscar shutdown token was rejected.');
    const requestStop = (candidateToken, candidateBinding) => fetch('http://127.0.0.1:7861/api/backend/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Oscar-Token': candidateToken,
        // The backend binds a stop request to this one shutdown attempt. Do
        // not reuse a value across hosts or expose it outside this request.
        'X-Monarch-Stop-Correlation': correlation,
        'X-Monarch-Expected-Host-Generation': candidateBinding.generation,
        'X-Monarch-Expected-Pid': String(candidateBinding.pid) },
      body: '{}', signal: controller.signal,
    });
    const response = await requestStop(token, binding);
    if (response.status === 401) throw new Error('Oscar shutdown token was rejected.');
    if (!response.ok && response.status !== 404) {
      throw new Error(`Oscar shutdown returned HTTP ${response.status}.`);
    }
    if (response.status === 404) return;
    const receipt = await response.json().catch(() => null);
    if (!receipt || receipt.ok !== true || receipt.stopping !== true
      || receipt.correlation !== correlation || receipt.pid !== binding.pid
      || receipt.hostGeneration !== binding.generation || receipt.staleProcess !== false) {
      throw new Error('Oscar shutdown returned an invalid stop receipt.');
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

function fetchJson(url, headers = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
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
    request.setTimeout(timeoutMs, () => {
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
