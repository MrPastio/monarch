import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Electron desktop lifecycle', () => {
  it('does not stop global Security protection when the UI shuts down', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const shutdownBody = source.match(/async function shutdownDesktop\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(shutdownBody).not.toContain('stopSecurityProtector');
    expect(source).not.toContain('async function stopSecurityProtector');
    expect(shutdownBody).toContain('stopOscarBackend');
    expect(shutdownBody).toContain('if (!safeEntryQaMode && !safeLaunchMode && !updateDemoMode && !desktopAcceptanceMode)');
    expect(shutdownBody).toContain('stopRuntime');
  });

  it('never lets Safe entry QA stop a production Oscar backend', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const shutdownBody = source.match(/async function shutdownDesktop\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(shutdownBody).toContain('if (!safeEntryQaMode && !safeLaunchMode && !updateDemoMode && !desktopAcceptanceMode)');
    expect(shutdownBody).toContain('await stopOscarBackend().catch(() => undefined)');
  });

  it('binds a real Oscar shutdown to its authenticated stop receipt', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const stopBody = source.match(/async function stopOscarBackend\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(stopBody).toContain("'X-Monarch-Stop-Correlation': correlation");
    expect(stopBody).toContain("'X-Monarch-Expected-Host-Generation': candidateBinding.generation");
    expect(stopBody).toContain("'X-Monarch-Expected-Pid': String(candidateBinding.pid)");
    expect(stopBody).toContain("payload?.authenticated !== true");
    expect(stopBody).toContain("const token = oscarApiKey?.key;");
    expect(stopBody).not.toContain("oscar_token.txt");
    expect(stopBody).toContain("response.status === 401");
    expect(stopBody).toContain("const response = await requestStop(token, binding)");
    expect(stopBody).toContain("randomBytes(18).toString('base64url')");
    expect(stopBody).toContain('receipt.correlation !== correlation');
    expect(stopBody).toContain("receipt.ok !== true || receipt.stopping !== true");
    expect(stopBody).toContain("receipt.hostGeneration !== binding.generation");
    expect(stopBody).toContain("receipt.staleProcess !== false");
    expect(stopBody).not.toContain('console.log(token)');
  });

  it('never lets the standalone Safe shortcut stop a production Oscar backend', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const shutdownBody = source.match(/async function shutdownDesktop\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(source).toContain("const safeLaunchMode = process.argv.includes('--safe')");
    expect(shutdownBody).toContain('!safeLaunchMode');
  });

  it('never lets the isolated updater demo stop a production Oscar backend', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const shutdownBody = source.match(/async function shutdownDesktop\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(source).toContain("const updateDemoMode = process.argv.includes('--update-demo') && !app.isPackaged");
    expect(shutdownBody).toContain('!updateDemoMode');
  });

  it('isolates Desktop acceptance and cannot stop the shared Oscar backend', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const shutdownBody = source.match(/async function shutdownDesktop\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
    const startupBody = source.match(/async function startDesktopApp\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(source).toContain("const desktopAcceptanceMode = process.argv.includes('--desktop-acceptance') && !app.isPackaged");
    expect(source).toContain("path.join(configuredDataRoot, 'runtime', 'desktop-isolation')");
    expect(source).toContain("mkdtempSync(path.join(desktopIsolationParent, 'desktop-acceptance-'))");
    expect(startupBody).toContain('if (!updateDemoMode && !desktopAcceptanceMode)');
    expect(shutdownBody).toContain('!desktopAcceptanceMode');
    expect(source).toContain("const allowedPrefix = desktopAcceptanceProfile ? 'desktop-acceptance-' : 'desktop-smoke-'");
  });

  it('isolates source smoke runtime state from a running Desktop instance', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');

    expect(source).toContain("mkdtempSync(path.join(desktopIsolationParent, 'desktop-smoke-'))");
    expect(source).toContain("path.join(desktopRuntimeIsolationProfile, 'owner-authority')");
    expect(source).toContain('env.MONARCH_DATA_ROOT = isolatedDataRoot');
    expect(source).toContain('env.MONARCH_STATE_ROOT = isolatedStateRoot');
    expect(source).toContain('await cleanupDesktopRuntimeIsolation()');
  });

  it('keeps desktop STT activation lazy so Qwen owns cold-start commit first', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const runtimeBody = source.match(/async function startRuntime\([^)]*\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(runtimeBody).toContain('delete env.MONARCH_STT_PREWARM_ON_ACTIVATE');
    expect(runtimeBody).not.toMatch(/MONARCH_STT_PREWARM_ON_ACTIVATE:\s*['"]1['"]/);
  });

  it('prefers the packaged runtime and surfaces both startup logs', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');

    // Source launches build a fresh bundle; the launch resolution itself lives in runtime-entry.
    expect(source).toContain("import { prepareDevelopmentMaxBundle, prepareDevelopmentRuntime } from './development-runtime.mjs'");
    expect(readFileSync(path.resolve('desktop/electron/development-runtime.mjs'), 'utf8'))
      .toContain("import { resolveRuntimeLaunch } from './runtime-entry.mjs'");
    expect(source).toContain('preferSource: !app.isPackaged');
    expect(source).toContain("[...runtimeLaunch.args, 'serve'");
    expect(source).toContain("MONARCH_STARTUP_TRACE: '1'");
    expect(source).toContain("import { waitForRuntimeReady } from './runtime-startup.mjs'");
    expect(source).toContain("fetchJson(`${url}/api/ready`)");
    expect(source).toContain('timeoutMs: 60_000');
    expect(source).toContain('readErrorLog: () => readRuntimeLogTail(errPath)');
    expect(source).toContain('readOutputLog: () => readRuntimeLogTail(outPath)');
    expect(source).toContain("path.join(desktopLogsRoot, 'startup-phases.jsonl')");
    expect(source).toContain("schemaVersion: 'monarch.desktop-startup-phase.v1'");
    expect(source).toContain("markDesktopStartup('runtime-process-spawned')");
    expect(source).toContain("markDesktopStartup('runtime-health-ready')");
    expect(source).toContain("markDesktopStartup('retention-cleanup-scheduled')");
    expect(source).toContain("markDesktopStartup('retention-cleanup-start')");
    expect(source).toContain("markDesktopStartup('retention-cleanup-ready')");
    expect(source).toContain('new Promise((resolve) => setImmediate(resolve))');
    const startupSource = source.slice(
      source.indexOf('async function startDesktopApp()'),
      source.indexOf('function scheduleRetainedUpdateCleanup()'),
    );
    expect(startupSource).not.toContain('await cleanupRetainedUpdateComponents');
    expect(startupSource.indexOf('await createMainWindow()'))
      .toBeLessThan(startupSource.indexOf('scheduleRetainedUpdateCleanup();'));
    expect(source).not.toContain('waitForSystemProfile(url, 15000)');
    expect(source).toContain("fetchJson(`${runtimeUrl}/api/health`, {}, 30_000)");
    expect(source).toContain('function fetchJson(url, headers = {}, timeoutMs = 5000)');
  });

  it('keeps a lifeline to the runtime so it stops gracefully and never outlives the desktop', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const server = readFileSync(path.resolve('src/main.ts'), 'utf8');
    expect(source).toContain("env: { ...env, MONARCH_PARENT_LIFELINE: 'stdin' },");
    expect(source).toContain("stdio: ['pipe', 'pipe', 'pipe'],");
    expect(source).toContain('await stopRuntimeGracefully();');
    expect(server).toContain("process.env.MONARCH_PARENT_LIFELINE === 'stdin'");
    expect(server).toContain("process.stdin.on('end', () => { void shutdown(); });");
  });

  it('bounds runtime recovery in every mode and preserves the main-owned model host', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');

    // A single runtime fault restarts the runtime instead of closing the app.
    expect(source).toContain('void recoverRuntime(port, failure);');
    expect(source).not.toContain('else { void showFatalError(failure); app.quit(); }');
    expect(source).toContain('if (astraRuntimePilotMode) reloadLinkedAstraPilot();');
    expect(source).toContain('else reloadMainWindowAfterRecovery();');
    // Repeated exits back off; recovery never closes Monarch on its own.
    expect(source).toContain('const delayMs = runtimeRecovery.nextDelay();');
    const start = source.indexOf('async function recoverRuntime(port, originalFailure) {');
    const recovery = source.slice(start, source.indexOf('\nfunction reloadMainWindowAfterRecovery', start));
    expect(recovery).toContain('runtimeRecovery.healthy();');
    expect(recovery).not.toContain('app.quit()');
    expect(recovery).not.toContain('showFatalError');
    expect(source).toContain('startRuntime({ requestedPort: port, preserveModelHostOnFailure: true })');
    expect(source).toContain("current.searchParams.has('astraTurnId')");
    expect(source).toContain("current.searchParams.has('astraPendingRequestId')");
  });

  it('keeps Qwen TTS lazy while exposing trusted warmup and diagnostics IPC', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const preload = readFileSync(path.resolve('desktop/electron/preload.cjs'), 'utf8');
    const startupBody = source.match(/async function startDesktopApp\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(source).toContain('createSpeechWarmupCoordinator');
    expect(startupBody).not.toContain('speechWarmup.start()');
    expect(startupBody).not.toContain('speechOutput.warmup()');
    expect(startupBody).toContain('runtimeUrl = await startRuntime()');
    expect(source).toContain("ipcMain.handle('monarch:speech-warmup'");
    expect(source).toContain("ipcMain.handle('monarch:speech-diagnostics'");
    expect(source).toContain("ipcMain.handle('monarch:speech-release'");
    expect(source).toContain("ipcMain.handle('monarch:speech-capabilities'");
    expect(source).toContain('await speechOutput.releaseNeural()');
    expect(source).toContain('speechWarmup.reset()');
    expect(source).toContain("path.join(desktopLogsRoot, 'electron-speech.log')");
    expect(source).toContain('appendFile(speechDiagnosticsPath');
    expect(source).toContain("logSpeechDiagnostic('playback-requested'");
    expect(source.indexOf("logSpeechDiagnostic('playback-requested'"))
      .toBeLessThan(source.indexOf('await speechOutput.speak(value)'));
    expect(preload).toContain("ipcRenderer.invoke('monarch:speech-warmup'");
    expect(preload).toContain("ipcRenderer.invoke('monarch:speech-diagnostics'");
    expect(preload).toContain("ipcRenderer.invoke('monarch:speech-release'");
    expect(preload).toContain("ipcRenderer.invoke('monarch:speech-capabilities'");
    expect(source).toContain("ipcMain.handle('monarch:owner-enrollment-status'");
    expect(source).toContain("ipcMain.handle('monarch:owner-device-request-export'");
    expect(source).toContain("ipcMain.handle('monarch:owner-entitlement-import'");
    expect(preload).toContain("ipcRenderer.invoke('monarch:owner-enrollment-status'");
    expect(preload).toContain("ipcRenderer.invoke('monarch:owner-entitlement-import'");
  });

  it('opens only the configured models root for the manual first-run fallback', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const preload = readFileSync(path.resolve('desktop/electron/preload.cjs'), 'utf8');

    expect(source).toContain("ipcMain.handle('monarch:open-models-folder'");
    expect(source).toContain('process.env.MONARCH_MODELS_ROOT');
    expect(source).toContain('await shell.openPath(modelsRoot)');
    expect(preload).toContain("openModelsFolder: () => ipcRenderer.invoke('monarch:open-models-folder')");
  });

  it('keeps Telegram Astra sharing behind main-only host authority and exact IPC', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const preload = readFileSync(path.resolve('desktop/electron/preload.cjs'), 'utf8');
    const policy = readFileSync(path.resolve('desktop/electron/astra-pilot-policy.mjs'), 'utf8');

    expect(policy).toContain("ASTRA_TELEGRAM_PILOT_SWITCH = '--astra-v3-telegram-read-pilot'");
    expect(policy).toContain('delete next.MONARCH_ASTRA_TELEGRAM_MODE');
    expect(source).toContain("ipcMain.handle('monarch:astra-product-pick-telegram-target'");
    expect(source).toContain('if (!astraRuntimePilotMode || !astraTelegramPilotMode || !mainWindow || !runtimeUrl)');
    expect(source).toContain('hostToken: astraV3HostToken');
    expect(preload).toContain("ipcRenderer.invoke('monarch:astra-product-pick-telegram-target'");
    expect(preload).not.toContain('astraV3HostToken');
    expect(preload).not.toContain('MONARCH_ASTRA_TELEGRAM_MODE');
  });
});
