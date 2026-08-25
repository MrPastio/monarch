import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync('desktop/electron/main.mjs', 'utf8');
const preload = readFileSync('desktop/electron/preload.mjs', 'utf8');
const http = readFileSync('src/app/http-server.ts', 'utf8');
const api = readFileSync('src/ui/public/modules/api.js', 'utf8');
const computerUseControl = readFileSync('src/ui/public/modules/computer-use-control.js', 'utf8');
const html = readFileSync('src/ui/public/index.html', 'utf8');
const css = readFileSync('src/ui/public/ui-refresh.css', 'utf8');
const native = readFileSync('tools/computer-use/MonarchComputerUse.cs', 'utf8');
const cursorAnimation = readFileSync('tools/computer-use/OscarCursorAnimation.cs', 'utf8');
const nativeBridge = readFileSync('src/modules/computer/native-bridge.ts', 'utf8');
const nativeBuilder = readFileSync('scripts/build-computer-use-native.mjs', 'utf8');
const offlinePayloadBuilder = readFileSync('installer/build-offline-payload.ps1', 'utf8');

describe('Computer Use emergency stop and own cursor', () => {
  it('owns a global shortcut in Electron and unregisters it during shutdown', () => {
    expect(main).toContain("globalShortcut.register(accelerator");
    expect(main).toContain("const accelerator = 'Control+Alt+Escape'");
    expect(main).toContain("globalShortcut.unregister('Control+Alt+Escape')");
    expect(main).toContain("/api/computer-use/emergency-stop");
  });

  it('uses a dedicated payload-free stop route outside Agent planning', () => {
    expect(http).toContain("url.pathname === '/api/computer-use/emergency-stop'");
    expect(http).toContain("capabilityId: 'computer.control.stop'");
    expect(api).toContain("fetch('/api/computer-use/emergency-stop'");
    expect(computerUseControl).toContain('await emergencyStopComputerUse()');
  });

  it('exposes only stop receipts to the renderer preload, not a generic privileged input bridge', () => {
    expect(preload).toContain('onComputerUseEmergencyStop: (listener) =>');
    expect(preload).toContain("ipcRenderer.on('monarch:computer-use-emergency-stop'");
    expect(preload).not.toContain('sendComputerInput');
    expect(preload).not.toContain('setComputerCursor');
  });

  it('keeps a quiet glass stop control and a native Oscar cursor overlay', () => {
    expect(html).toContain('id="computer-use-stop"');
    expect(html).toContain('Ctrl+Alt+Escape');
    expect(css).toContain('backdrop-filter: blur(18px)');
    expect(css).toContain('.computer-use-control[data-state="ready"]');
    expect(cursorAnimation).toContain('class OscarCursorOverlay');
    expect(cursorAnimation).toContain('ExtendedNoActivate');
    expect(cursorAnimation).toContain('continuous-vector-360');
    expect(cursorAnimation).toContain('PreClickVibration');
    expect(cursorAnimation).toContain('entire-sprite-max-1.5x-system-cursor');
    expect(cursorAnimation).toContain('rotatedExtent > maximumVisibleExtent');
    expect(native).toContain('activeLeaseId');
    expect(native).toContain('control.Verify()');
    expect(native).toContain('userTakeoverDetected');
    expect(native).toContain('SendUnicodeText(text, control, window, original, originalKnown)');
    expect(native).toContain('SystemCursorMovedByUser(originalCursor, 8)');
  });

  it('ships a source-bound and binary-hash-verified native helper in the offline payload', () => {
    expect(nativeBuilder).toContain('`${outputPath}.binary.sha256`');
    expect(nativeBuilder).toContain(".update('\\0oscar-cursor-animation\\0')");
    expect(offlinePayloadBuilder).toContain('build-computer-use-native.mjs');
    expect(offlinePayloadBuilder).toContain('tools\\computer-use\\bin\\monarch-computer-use.exe');
    expect(nativeBridge).toContain('prebuiltBinaryPath');
    expect(nativeBridge).toContain('ownerHeartbeatPath');
    expect(nativeBridge).toContain('binaryMarker.trim() === await fileSha256(this.binaryPath)');
    expect(nativeBridge).toContain('prebuiltBinaryMarker.trim() === await fileSha256(this.prebuiltBinaryPath)');
    expect(cursorAnimation).toContain('OwnerRuntimeIsAlive(ownerProcessId, ownerHeartbeatPath)');
  });
});
