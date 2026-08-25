import { describe, expect, it } from 'vitest';
import {
  IMAGE_PROVIDER_DEFAULT_ZOOM,
  PERCHANCE_IMAGE_PROVIDER_URL,
  isAllowedImageProviderUrl,
  resolveEmbeddedImageProviderBounds,
  resolveImageProviderEntryUrl,
  resolveImageProviderZoom,
} from '../../desktop/electron/image-provider-policy.mjs';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync('desktop/electron/main.mjs', 'utf8');
const preloadSource = readFileSync('desktop/electron/preload.mjs', 'utf8');

describe('interactive image provider navigation policy', () => {
  it('allows only HTTPS Perchance origins', () => {
    expect(isAllowedImageProviderUrl('https://perchance.org/ai-text-to-image-generator')).toBe(true);
    expect(isAllowedImageProviderUrl('https://image-generation.perchance.org/embed')).toBe(true);
    expect(isAllowedImageProviderUrl('http://perchance.org/ai-text-to-image-generator')).toBe(false);
    expect(isAllowedImageProviderUrl('https://perchance.org.evil.example/')).toBe(false);
    expect(isAllowedImageProviderUrl('javascript:alert(1)')).toBe(false);
  });

  it('falls back to the canonical provider entrypoint', () => {
    expect(resolveImageProviderEntryUrl('https://example.com/')).toBe(PERCHANCE_IMAGE_PROVIDER_URL);
  });

  it('clamps the embedded desktop surface and zoom to the host window', () => {
    expect(resolveImageProviderZoom(undefined)).toBe(IMAGE_PROVIDER_DEFAULT_ZOOM);
    expect(resolveImageProviderZoom(2)).toBe(1.15);
    expect(resolveImageProviderZoom(0.2)).toBe(0.75);
    expect(resolveEmbeddedImageProviderBounds(
      { x: 180, y: 100, width: 2_000, height: 1_400 },
      { width: 1_200, height: 800 },
    )).toEqual({ x: 180, y: 100, width: 1_020, height: 700 });
    expect(resolveEmbeddedImageProviderBounds({}, { width: 320, height: 300 })).toBeNull();
  });

  it('embeds Perchance as a sandboxed ephemeral WebContentsView without DOM automation', () => {
    const embeddedProviderSource = mainSource.slice(
      mainSource.indexOf('async function showEmbeddedImageProvider'),
      mainSource.indexOf('async function startRuntime'),
    );
    expect(mainSource).toContain('new WebContentsView({');
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
    expect(mainSource).toContain('sandbox: true');
    expect(mainSource).toContain("partition: 'monarch-perchance-provider'");
    expect(mainSource).toContain('setPermissionRequestHandler');
    expect(mainSource).toContain('setPermissionCheckHandler(() => false)');
    expect(embeddedProviderSource).not.toContain('executeJavaScript(');
    expect(preloadSource).toContain("showEmbeddedImageProvider: (value) => ipcRenderer.invoke('monarch:show-embedded-image-provider', value)");
    expect(preloadSource).toContain("hideEmbeddedImageProvider: () => ipcRenderer.invoke('monarch:hide-embedded-image-provider')");
  });

  it('lets a consent revocation close the managed provider window', () => {
    expect(preloadSource).toContain("closeImageProvider: () => ipcRenderer.invoke('monarch:close-image-provider')");
    expect(mainSource).toContain("ipcMain.handle('monarch:close-image-provider'");
    expect(mainSource).toContain('imageProviderWindow.close()');
    expect(mainSource).toContain('destroyEmbeddedImageProvider()');
    expect(mainSource).toContain('providerSession.clearStorageData()');
  });

  it('captures only a user-initiated provider download and exposes no DOM scraping bridge', () => {
    expect(mainSource).toContain("providerSession.on('will-download', createImageProviderDownloadHandler({");
    expect(mainSource).toContain('isTrustedSource: (contents) => contents?.id === embeddedImageProviderView?.webContents.id');
    expect(preloadSource).toContain("ipcRenderer.on('monarch:image-provider-download', handler)");
    expect(preloadSource).toContain("ipcRenderer.removeListener('monarch:image-provider-download', handler)");
    expect(preloadSource).not.toContain('executeJavaScript');
  });

  it('keeps the native Windows frame while removing only the Electron menu bar', () => {
    expect(mainSource).not.toContain("titleBarStyle: 'hidden'");
    expect(mainSource).toMatch(/mainWindow = new BrowserWindow\(\{[\s\S]*?autoHideMenuBar: true,[\s\S]*?\}\);\s*mainWindow\.setMenu\(null\);/);
    expect(preloadSource).not.toContain('desktopShell');
  });
});
