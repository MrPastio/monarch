import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeGmailStatus } from '../../src/ui/public/modules/gmail-settings.js';

const html = readFileSync('src/ui/public/index.html', 'utf8');
const source = readFileSync('src/ui/public/modules/gmail-settings.js', 'utf8');
const preload = readFileSync('desktop/electron/preload.cjs', 'utf8');
const main = readFileSync('desktop/electron/main.mjs', 'utf8');
const styles = readFileSync('src/ui/public/styles-v2.css', 'utf8');

describe('Gmail settings surface', () => {
  it('normalizes only the public connection projection', () => {
    expect(normalizeGmailStatus({ connected: true, email: 'owner@example.com', refreshToken: 'must-not-render',
      permissions: { search: true, read: false, compose: true, unknown: true } })).toEqual({
      connected: true, email: 'owner@example.com', permissions: { search: true, read: false, compose: true },
    });
  });

  it('uses trusted Desktop IPC and never persists OAuth fields in the renderer', () => {
    expect(html).toContain('data-settings-tab="integrations"');
    expect(html).toContain('id="gmail-connect-form"');
    expect(html).toContain('специальных команд и фраз-активаторов нет');
    expect(html).toContain('Google технически выдаёт <code>gmail.readonly</code>');
    expect(html).toContain('не запрашивает полный доступ <code>mail.google.com</code>');
    expect(source).toContain('window.monarchDesktop?.integrations');
    expect(source).toContain("integrations.connect('gmail', input)");
    expect(source).toContain('clientSecret.value =');
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
    expect(preload).toContain("ipcRenderer.invoke('monarch:integration-connect', { serviceId, input })");
    expect(main).toContain('registerServiceIntegrationIpc({ ipcMain');
    expect(main).toContain("id: 'gmail', envPrefix: 'MONARCH_GMAIL_HOST'");
  });

  it('keeps the service card theme-aware and glass-like', () => {
    expect(styles).toContain('.service-card');
    expect(styles).toContain('backdrop-filter: blur(22px)');
    expect(styles).toContain('var(--service-accent)');
    expect(styles).toContain('var(--surface-strong)');
    expect(styles).toContain('.service-scope-list input[type="checkbox"]');
  });
});
