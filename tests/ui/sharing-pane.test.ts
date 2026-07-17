import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync('src/ui/public/index.html', 'utf8');
const appSource = readFileSync('src/ui/public/app.js', 'utf8');
const paneSource = readFileSync('src/ui/public/modules/sharing-pane.js', 'utf8');
const styles = readFileSync('src/ui/public/sharing.css', 'utf8');
const desktopMain = readFileSync('desktop/electron/main.mjs', 'utf8');
const desktopPreload = readFileSync('desktop/electron/preload.mjs', 'utf8');

describe('Monarch Sharing UI', () => {
  it('registers a dedicated navigable Sharing surface', () => {
    expect(indexHtml).toContain('href="/sharing.css"');
    expect(indexHtml).toContain('data-scroll-target="sharing-section"');
    expect(indexHtml).toContain('id="sharing-section"');
    expect(indexHtml).toContain('id="sharing-page-root"');
    expect(appSource).toContain("import { initSharingPane, renderSharingPane } from './modules/sharing-pane.js';");
    expect(appSource).toMatch(/if \(activeView === 'sharing-section'\) \{\s*renderSharingPane\(\);\s*return;/);
    expect(appSource).toContain("'sharing-section',");
    expect(appSource).toContain('initSharingPane();');
  });

  it('keeps connection setup local, copyable, and backed by real capabilities', () => {
    expect(paneSource).toContain("executeCapability('sharing', 'sharing.status'");
    expect(paneSource).toContain("executeConfirmedCapability('oscar', 'oscar.backend.start'");
    expect(paneSource).toContain('data-sharing-action="copy-token"');
    expect(paneSource).toContain('data-sharing-copy="environment"');
    expect(paneSource).toContain("renderPresetButton('python', 'Python')");
    expect(paneSource).toContain("renderPresetButton('node', 'Node.js')");
    expect(paneSource).toContain("renderPresetButton('powershell', 'PowerShell')");
    expect(paneSource).toContain("Super Fast — Qwen");
    expect(paneSource).toContain("'qwen2.5-0.5b-instruct'");
    expect(paneSource).toContain("'qwen3-1.7b-instruct'");
    expect(paneSource).toContain('TTS Models');
    expect(paneSource).toContain('sharing-tts-model-select');
    expect(paneSource).toContain('data-sharing-copy="tts-snippet"');
    expect(paneSource).toContain('buildTtsSnippet');
    expect(paneSource).toContain('Только этот компьютер');
    expect(paneSource).toContain('Без облака');
  });

  it('copies the API key through a bounded desktop bridge without returning it', () => {
    expect(desktopPreload).toContain("copySharingToken: () => ipcRenderer.invoke('monarch:copy-sharing-token')");
    expect(desktopMain).toContain("ipcMain.handle('monarch:copy-sharing-token', async (event) => {");
    expect(desktopMain).toContain('event.sender.id !== mainWindow.webContents.id');
    expect(desktopMain).toContain("path.join(workspaceRoot, 'secrets', 'oscar_token.txt')");
    expect(desktopMain).toContain('clipboard.writeText(token);');
    expect(desktopMain).toContain('return { ok: true };');
    expect(desktopMain).not.toContain('return { ok: true, token };');
  });

  it('preserves the dark glass layout and responsive access to Sharing', () => {
    expect(styles).toContain('backdrop-filter: blur(26px)');
    expect(styles).toContain('rgba(255, 184, 24');
    expect(styles).toContain('@media (max-width: 620px)');
    expect(styles).toContain('.nav-stack { grid-template-columns: repeat(7, 1fr); }');
    expect(styles).toContain('.app-shell:has(#sharing-section:not(.view-hidden)) .inspector');
    expect(styles).toContain('.sharing-tts-panel');
    expect(styles).toContain('.sharing-tts-rail');
  });
});
