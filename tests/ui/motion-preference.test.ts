// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedUiMotion, reducedUiMotion, setUiMotionPreference } from '../../src/ui/public/modules/ui-motion.js';
import { normalizeUiPreferences } from '../../src/ui/public/modules/ui-preferences.js';

afterEach(() => { setUiMotionPreference('system'); vi.restoreAllMocks(); });

describe('less motion preference', () => {
  it('reduces motion from the Monarch switch even when Windows does not', () => {
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
    expect(prefersReducedUiMotion()).toBe(false);
    const listener = vi.fn();
    reducedUiMotion.addEventListener('change', listener);
    setUiMotionPreference('reduced');
    expect(document.documentElement.dataset.motion).toBe('reduced');
    expect(prefersReducedUiMotion()).toBe(true);
    expect(listener).toHaveBeenCalledWith({ matches: true });
    reducedUiMotion.removeEventListener('change', listener);
  });
  it('follows Windows in the default mode', () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as any;
    setUiMotionPreference('system');
    expect(prefersReducedUiMotion()).toBe(true);
  });
  it('stores only the two known modes', () => {
    expect(normalizeUiPreferences({ motion: 'reduced' }).motion).toBe('reduced');
    expect(normalizeUiPreferences({ motion: 'wild' }).motion).toBe('system');
  });
});
