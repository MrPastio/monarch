import { reducedUiMotion } from './ui-motion.js';
import { resolveTheme } from './ui-preferences.js';

/** Theme change with a circular reveal from where the person clicked. One
 * owner: app.js still stores and applies the preference; this only animates
 * the swap. `key` is "theme" (light | dark | auto) or "autoTheme" (system |
 * time). The reveal runs only when the painted theme actually changes; reduced
 * motion (or no View Transitions) switches instantly. */
export function changeThemeWithReveal(value, origin, key = 'theme') {
  const root = document.documentElement;
  const current = { theme: root.dataset.themePreference || root.dataset.theme, autoTheme: root.dataset.autoTheme || 'system' };
  if (current[key] === value) return Promise.resolve();
  const next = resolveTheme({ ...current, [key]: value }, {
    systemDark: window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
  });
  const apply = () => window.dispatchEvent(new CustomEvent('monarch:set-ui-preference', { detail: { key, value } }));
  if (next === root.dataset.theme || reducedUiMotion.matches === true || typeof document.startViewTransition !== 'function') {
    apply();
    return Promise.resolve();
  }
  const rect = origin instanceof Element ? origin.getBoundingClientRect() : null;
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.dataset.themeReveal = 'running';
  const transition = document.startViewTransition(apply);
  transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 560, easing: 'cubic-bezier(.2, .8, .2, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => undefined);
  return transition.finished.catch(() => undefined).finally(() => { delete root.dataset.themeReveal; });
}

/** Design change (PaperPixel ↔ classic) with the same reveal from the click.
 * app.js stays the one owner of the stored preference. */
export function changeDesignWithReveal(value, origin) {
  const root = document.documentElement;
  const next = value === 'classic' ? 'classic' : 'pp';
  if ((root.dataset.design === 'classic' ? 'classic' : 'pp') === next) return Promise.resolve();
  const apply = () => window.dispatchEvent(new CustomEvent('monarch:set-ui-preference', { detail: { key: 'design', value: next } }));
  if (reducedUiMotion.matches === true || typeof document.startViewTransition !== 'function') {
    apply();
    return Promise.resolve();
  }
  const rect = origin instanceof Element ? origin.getBoundingClientRect() : null;
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.dataset.themeReveal = 'running';
  const transition = document.startViewTransition(apply);
  transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 620, easing: 'cubic-bezier(.2, .8, .2, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => undefined);
  return transition.finished.catch(() => undefined).finally(() => { delete root.dataset.themeReveal; });
}
