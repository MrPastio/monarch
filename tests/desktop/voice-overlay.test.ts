import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync('desktop/electron/main.mjs', 'utf8');
const preload = readFileSync('desktop/electron/preload.cjs', 'utf8');
const html = readFileSync('desktop/electron/voice-overlay.html', 'utf8');
const css = readFileSync('desktop/electron/voice-overlay.css', 'utf8');
const wakeService = readFileSync('src/ui/public/modules/voice-wake-service.js', 'utf8');

describe('Desktop Voice overlay and tray wake lifecycle', () => {
  it('keeps the hidden main renderer alive and exposes bounded Voice IPC only', () => {
    expect(main).toMatch(/preload: preloadPath,[\s\S]*?backgroundThrottling: false/);
    expect(preload).toContain("ipcRenderer.invoke('monarch:voice-overlay-update', value)");
    expect(preload).toContain("ipcRenderer.invoke('monarch:voice-wake-state', value)");
    expect(main).toContain("assertTrustedMainRenderer(event)");
    expect(wakeService).toContain('let settingsReady = readVoiceSettingsSnapshot().ready === true');
    expect(wakeService).toContain('if (!settingsReady)');
    expect(wakeService).toContain('onPartialTranscript: ({ transcript }) => handlePartialTranscript(transcript)');
    expect(wakeService).toContain('parseWakePartialInvocation(value)');
    expect(wakeService).toContain('voiceMode.acknowledgeWake?.()');
    expect(wakeService).toContain('maxRecordingMs: 0');
    expect(wakeService).toContain('retainFallbackAudio: false');
    expect(wakeService).toContain('noSpeechMs: 60_000');
    expect(wakeService).toContain('capture.resetSegment?.()');
  });

  it('creates a transparent click-through overlay without microphone or network permission', () => {
    expect(main).toMatch(/voiceOverlayWindow = overlay/);
    expect(main).toContain('transparent: true');
    expect(main).toContain("overlay.setAlwaysOnTop(true, 'screen-saver')");
    expect(main).toContain('overlay.setIgnoreMouseEvents(true');
    expect(main).toContain("partition: 'monarch-voice-overlay'");
    expect(main).toContain("isolatedSession.setPermissionCheckHandler(() => false)");
    expect(html).toContain("default-src 'none'");
    expect(css).toContain('backdrop-filter:blur(28px)');
    expect(html).toContain('id="voice-data-card"');
    expect(main).toContain("['weather', 'exchange-rate']");
    expect(css).toContain('.voice-data-card');
  });

  it('shows the desktop overlay only while the main window is not in front', () => {
    // The in-window voice surface already shows the same state; both at once overlapped.
    expect(main).toMatch(/function mainWindowInFront\(\)[\s\S]*?isVisible\(\)[\s\S]*?!mainWindow\.isMinimized\(\)[\s\S]*?isFocused\(\)/);
    expect(main).toMatch(/if \(!payload\?\.visible \|\| mainWindowInFront\(\)\)[\s\S]*?voiceOverlayWindow\.hide\(\)/);
    expect(main).toContain("for (const windowEvent of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'])");
  });

  it('makes active background microphone state visible in the tray copy', () => {
    expect(main).toContain('микрофон активен · ждёт wake-фразу');
    expect(main).toContain('syncTrayTooltip()');
  });
});
