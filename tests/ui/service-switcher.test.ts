// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { initServiceSwitcher } from '../../src/ui/public/modules/service-switcher.js';

const card = (name: string) => `<article class="service-card"><header class="service-card-heading"><strong>${name}</strong></header></article>`;
const group = (cls: string) => `<section class="settings-group ${cls}" data-settings-panel="system"></section>`;

describe('service switcher', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="settings-panel-stack">
        <section class="service-settings">${card('Gmail')}${card('Google Calendar')}${card('GitHub')}</section>
        ${group('settings-appearance')}${group('monarch-update-panel')}${group('monarch-help-panel')}${group('monarch-docs-panel')}
        <details class="settings-group legacy-system-diagnostics" data-settings-panel="system" hidden></details>
      </div>`;
    initServiceSwitcher();
  });

  it('shows one service card at a time and follows the tab row', () => {
    const cards = [...document.querySelectorAll('.service-card')];
    const tabs = [...document.querySelectorAll('.service-settings .service-switcher [role="tab"]')] as HTMLButtonElement[];
    expect(tabs.map(tab => tab.textContent)).toEqual(['Gmail', 'Google Calendar', 'GitHub']);
    expect(cards.map(node => node.hasAttribute('data-service-active'))).toEqual([true, false, false]);
    tabs[2].click();
    expect(cards.map(node => node.hasAttribute('data-service-active'))).toEqual([false, false, true]);
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
  });

  it('moves between services with the arrow keys', () => {
    const tabs = [...document.querySelectorAll('.service-settings .service-switcher [role="tab"]')] as HTMLButtonElement[];
    tabs[0].parentElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  });

  it('groups System by area, joins the settings tab visibility, and skips the legacy diagnostics', () => {
    const row = document.querySelector('.system-switcher') as HTMLElement;
    expect(row.dataset.settingsPanel).toBe('system');
    expect([...row.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Внешний вид', 'Обновления', 'Если что-то не работает', 'Документация']);
    expect(document.querySelector('.settings-panel-stack')!.hasAttribute('data-system-tabs')).toBe(true);
    expect(document.querySelector('.legacy-system-diagnostics')!.hasAttribute('data-system-active')).toBe(false);
    expect(document.querySelector('.settings-appearance')!.hasAttribute('data-system-active')).toBe(true);
  });

  it('is idempotent', () => {
    initServiceSwitcher();
    expect(document.querySelectorAll('.service-switcher').length).toBe(2);
  });
});
