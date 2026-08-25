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
    const runtimeBody = source.match(/async function startRuntime\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(runtimeBody).toContain('delete env.MONARCH_STT_PREWARM_ON_ACTIVATE');
    expect(runtimeBody).not.toMatch(/MONARCH_STT_PREWARM_ON_ACTIVATE:\s*['"]1['"]/);
  });

  it('prefers the packaged runtime and surfaces both startup logs', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');

    expect(source).toContain("import { resolveRuntimeLaunch } from './runtime-entry.mjs'");
    expect(source).toContain('preferSource: !app.isPackaged');
    expect(source).toContain("[...runtimeLaunch.args, 'serve'");
    expect(source).toContain("MONARCH_STARTUP_TRACE: '1'");
    expect(source).toContain("import { waitForRuntimeReady } from './runtime-startup.mjs'");
    expect(source).toContain("fetchJson(`${url}/api/ready`)");
    expect(source).toContain('timeoutMs: 60_000');
    expect(source).toContain('readErrorLog: () => readRuntimeLogTail(errPath)');
    expect(source).toContain('readOutputLog: () => readRuntimeLogTail(outPath)');
    expect(source).not.toContain('waitForSystemProfile(url, 15000)');
    expect(source).toContain("fetchJson(`${runtimeUrl}/api/health`, {}, 30_000)");
    expect(source).toContain('function fetchJson(url, headers = {}, timeoutMs = 5000)');
  });

  it('keeps Qwen TTS lazy while exposing trusted warmup and diagnostics IPC', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const preload = readFileSync(path.resolve('desktop/electron/preload.mjs'), 'utf8');
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
    const preload = readFileSync(path.resolve('desktop/electron/preload.mjs'), 'utf8');

    expect(source).toContain("ipcMain.handle('monarch:open-models-folder'");
    expect(source).toContain('process.env.MONARCH_MODELS_ROOT');
    expect(source).toContain('await shell.openPath(modelsRoot)');
    expect(preload).toContain("openModelsFolder: () => ipcRenderer.invoke('monarch:open-models-folder')");
  });
});
