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
    expect(shutdownBody).toContain('if (!safeEntryQaMode)');
    expect(shutdownBody).toContain('stopRuntime');
  });

  it('never lets Safe entry QA stop a production Oscar backend', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const shutdownBody = source.match(/async function shutdownDesktop\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(shutdownBody).toMatch(/if \(!safeEntryQaMode\) await stopOscarBackend\(\)/);
  });

  it('keeps desktop STT activation lazy so Qwen owns cold-start commit first', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const runtimeBody = source.match(/async function startRuntime\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(runtimeBody).toContain('delete env.MONARCH_STT_PREWARM_ON_ACTIVATE');
    expect(runtimeBody).not.toMatch(/MONARCH_STT_PREWARM_ON_ACTIVATE:\s*['"]1['"]/);
  });

  it('starts one shared Qwen warmup before the local runtime and exposes trusted diagnostics IPC', () => {
    const source = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const preload = readFileSync(path.resolve('desktop/electron/preload.mjs'), 'utf8');
    const startupBody = source.match(/async function startDesktopApp\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(source).toContain('createSpeechWarmupCoordinator');
    expect(startupBody).toContain('speechWarmup.start()');
    expect(startupBody).not.toContain('speechOutput.warmup()');
    expect(startupBody.indexOf('speechWarmup.start()')).toBeLessThan(startupBody.indexOf('startRuntime()'));
    expect(source).toContain("ipcMain.handle('monarch:speech-warmup'");
    expect(source).toContain("ipcMain.handle('monarch:speech-diagnostics'");
    expect(source).toContain("ipcMain.handle('monarch:speech-release'");
    expect(source).toContain('await speechOutput.releaseNeural()');
    expect(source).toContain('speechWarmup.reset()');
    expect(source).toContain("runtime', 'electron-speech.log'");
    expect(source).toContain('appendFile(speechDiagnosticsPath');
    expect(source).toContain("logSpeechDiagnostic('playback-requested'");
    expect(source.indexOf("logSpeechDiagnostic('playback-requested'"))
      .toBeLessThan(source.indexOf('await speechOutput.speak(value)'));
    expect(preload).toContain("ipcRenderer.invoke('monarch:speech-warmup'");
    expect(preload).toContain("ipcRenderer.invoke('monarch:speech-diagnostics'");
    expect(preload).toContain("ipcRenderer.invoke('monarch:speech-release'");
  });
});
