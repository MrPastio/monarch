import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOscarGreeting, OSCAR_EASTER_EGGS, OSCAR_GREETING_COUNT } from '../../src/ui/public/modules/oscar-greetings.js';

const html = readFileSync('src/ui/public/index.html', 'utf8');
const styles = readFileSync('src/ui/public/ui-refresh.css', 'utf8');
const motion = readFileSync('src/ui/public/modules/ui-motion.js', 'utf8');
const app = readFileSync('src/ui/public/app.js', 'utf8');

describe('Monarch unified UI refresh', () => {
  it('ships one rounded glass and physical motion system', () => {
    expect(html).toContain('href="/ui-refresh.css"');
    expect(styles).toContain('--glass-surface');
    expect(styles).toContain('--radius-lg: 28px');
    expect(styles).toContain('.settings-view-header');
    expect(styles).toContain('.security-chrome');
    expect(styles).toContain('input[type="checkbox"]:not(.voice-mode-hidden-input)');
    expect(styles).toContain('::view-transition-old(monarch-main-surface)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(motion).toContain('translate3d');
    expect(motion).toContain('cubic-bezier(.16,1,.3,1)');
    expect(app).toContain('document.startViewTransition(applyViewChange)');
  });

  it('keeps Settings motion stable and exposes one clear Security mode control', () => {
    expect(styles).not.toContain('transition: font-size');
    expect(styles).toContain('overflow-y: hidden');
    expect(html).toContain('id="security-protection-state"');
    expect(html).not.toContain('id="security-level"');
    expect(html).not.toContain('data-security-level-choice="off"');
    expect(html.match(/data-security-level-choice=/g)).toHaveLength(4);
    expect(html).toContain('Для каждого дня · советуем');
  });

  it('offers more than one hundred greetings plus the three exact easter eggs', () => {
    expect(OSCAR_GREETING_COUNT).toBeGreaterThan(100);
    expect(OSCAR_EASTER_EGGS).toEqual(['Марк скоро выйдет?', 'Оскар...или Фернандо?', 'Где мои cookies?']);
    expect(createOscarGreeting(() => 0).title).toBe('Что нового?');
    expect(createOscarGreeting(() => .9999).title).toBe('Где мои cookies?');
  });
});
