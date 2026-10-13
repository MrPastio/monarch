// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HELP_ITEMS, initHelpPanel, renderHelpPanel } from '../../src/ui/public/modules/help-panel.js';
import { escapeHtml } from '../../src/ui/public/modules/utils.js';

describe('help panel', () => {
  it('offers the logs action only inside the desktop app', () => {
    expect(renderHelpPanel(HELP_ITEMS, { desktop: false }, escapeHtml)).not.toContain('data-help-action="logs"');
    expect(renderHelpPanel(HELP_ITEMS, { desktop: true }, escapeHtml)).toContain('data-help-action="logs"');
  });
  it('reports what the Oscar check found and navigates for the others', async () => {
    const container = document.createElement('div');
    const navigate = vi.fn();
    initHelpPanel(container, { escapeHtml, navigate, checkOscar: async () => false, openLogs: undefined });
    (container.querySelector('[data-help-action="oscar"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(container.querySelector('[data-help-result="oscar"]')?.textContent).toContain('не отвечает'));
    (container.querySelector('[data-help-action="access"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('settings-section', 'access'));
  });
});
