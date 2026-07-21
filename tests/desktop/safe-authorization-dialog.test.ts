import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Monarch Safe trusted authorization dialog', () => {
  it('uses an isolated styled surface instead of the Windows message box', async () => {
    const [main, html, preload] = await Promise.all([
      readFile('desktop/electron/main.mjs', 'utf8'),
      readFile('desktop/safe/authorization.html', 'utf8'),
      readFile('desktop/safe/authorization-preload.cjs', 'utf8'),
    ]);

    expect(main).toContain('showSafeAuthorizationPrompt({');
    expect(main).toContain("partition: 'monarch-safe-authorization-isolated'");
    expect(main).not.toContain('dialog.showMessageBox(safeWindow');
    expect(html).toContain('Защищённое подтверждение');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script(?![^>]*src=)/i);
    expect(preload).toContain("contextBridge.exposeInMainWorld('monarchSafeAuthorization'");
    expect(preload).not.toContain('ipcRenderer.invoke');
  });

  it('keeps unrelated focus loss fail-closed while exempting only the owned prompt', async () => {
    const main = await readFile('desktop/electron/main.mjs', 'utf8');

    expect(main).toContain('trustedAuthorizationOpen');
    expect(main).toContain("promptWindow.on('blur'");
    expect(main).toContain("parentWindow.webContents.send('monarch-safe:force-lock')");
  });
});
