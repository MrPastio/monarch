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
  it('opens the bug report letter through the desktop bridge with the app context', async () => {
    const container = document.createElement('div');
    const reportBug = vi.fn(async () => ({ ok: true, text: '' }));
    initHelpPanel(container, {
      escapeHtml, navigate: vi.fn(), checkOscar: async () => true, openLogs: async () => ({ ok: true }),
      reportBug, reportContext: () => 'Модели: gemma4-fast: скачана',
    });
    const form = container.querySelector('[data-bug-report]') as HTMLFormElement;
    expect(form.hidden).toBe(true);
    (container.querySelector('[data-help-action="report"]') as HTMLButtonElement).click();
    expect(form.hidden).toBe(false);
    (form.querySelector('[data-bug-report-via="mail"]') as HTMLButtonElement).click();
    expect(reportBug).not.toHaveBeenCalled();
    (form.querySelector('#bug-report-text') as HTMLTextAreaElement).value = 'Страница моделей дёргается';
    (form.querySelector('[data-bug-report-via="gmail"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(reportBug).toHaveBeenCalledWith({
      description: 'Страница моделей дёргается', context: 'Модели: gemma4-fast: скачана', via: 'gmail',
    }));
    await vi.waitFor(() => expect(form.querySelector('[data-bug-report-result]')?.textContent).toContain('Gmail открыт'));
  });
  it('has no bug report row outside the desktop app', () => {
    const container = document.createElement('div');
    initHelpPanel(container, { escapeHtml, navigate: vi.fn(), checkOscar: async () => true, openLogs: undefined });
    expect(container.querySelector('[data-help-action="report"]')).toBeNull();
    expect(container.querySelector('[data-bug-report]')).toBeNull();
  });
});
