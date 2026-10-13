import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { shouldOpenContentLink } from '../../desktop/electron/security-policy.mjs';

describe('links from content open only after confirmation (F-10)', () => {
  const url = 'https://example.com/page?q=1';

  it('asks by default and opens only on a yes', async () => {
    const confirm = vi.fn(async () => true);
    expect(await shouldOpenContentLink({ url, readLevel: async () => 'always', confirm })).toBe(true);
    expect(confirm).toHaveBeenCalledWith(url);
    expect(await shouldOpenContentLink({ url, readLevel: async () => 'always', confirm: async () => false })).toBe(false);
  });

  it('opens at once only when the person turned asking off', async () => {
    const confirm = vi.fn(async () => false);
    expect(await shouldOpenContentLink({ url, readLevel: async () => 'off', confirm })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks when the policy cannot be read or reads as anything else', async () => {
    for (const readLevel of [async () => { throw new Error('down'); }, async () => undefined, async () => 'weird']) {
      const confirm = vi.fn(async () => false);
      expect(await shouldOpenContentLink({ url, readLevel, confirm })).toBe(false);
      expect(confirm).toHaveBeenCalledOnce();
    }
  });

  it('never opens non-HTTP links and treats a failed dialog as no', async () => {
    const confirm = vi.fn(async () => true);
    expect(await shouldOpenContentLink({ url: 'file:///C:/Windows', readLevel: async () => 'off', confirm })).toBe(false);
    expect(await shouldOpenContentLink({ url, readLevel: async () => 'always', confirm: async () => { throw new Error('x'); } })).toBe(false);
  });

  it('routes main-window links through the confirmation', () => {
    const main = readFileSync(path.resolve('desktop/electron/main.mjs'), 'utf8');
    const security = main.match(/function configureMainWindowSecurity\([^)]*\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(security).toContain('void openContentLink(window, url)');
    expect(security).toContain('void openContentLink(window, navigationUrl)');
    expect(security).not.toContain('openExternalSafely(');
  });
});
