import { afterEach, describe, expect, it, vi } from 'vitest';
import { animateUserMessageArrivals, markUserMessageOrigin } from '../../src/ui/public/modules/ui-motion.js';
import { createOscarMessage, renderOscarMessage } from '../../src/ui/public/modules/utils.js';
afterEach(() => vi.unstubAllGlobals());
describe('user message design and send motion', () => {
  it('has no header inside the bubble and keeps copy/edit outside it', () => {
    const html = renderOscarMessage(createOscarMessage('user', 'Привет', 'ты', { sendActive: true }));
    expect(html).not.toContain('message-meta-row');
    expect(html).not.toContain('message-send-sync');
    expect(html).toContain('data-message-edit=');
    expect(html).toContain('data-message-copy=');
    expect(html.indexOf('user-message-actions')).toBeGreaterThan(html.indexOf('Привет'));
  });
  it('animates a sent ID once, without a second glow animation', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const animate = vi.fn();
    const root = { querySelectorAll: () => [{ getAttribute: () => 'sent', animate }] };
    const seen = new Set();
    expect(animateUserMessageArrivals(root, seen)).toBe(1);
    expect(animateUserMessageArrivals(root, seen)).toBe(0);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][1].duration).toBe(320);
    expect(JSON.stringify(animate.mock.calls)).not.toMatch(/filter|boxShadow/);
  });
  it('consumes reduced-motion sends without replaying them when motion is enabled', () => {
    let reduced = true;
    vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) });
    const animate = vi.fn(), seen = new Set();
    const root = { querySelectorAll: () => [{ getAttribute: () => 'sent', animate }] };
    expect(animateUserMessageArrivals(root, seen)).toBe(0);
    reduced = false;
    expect(animateUserMessageArrivals(root, seen)).toBe(0);
    expect(animate).not.toHaveBeenCalled();
  });
  it('flies the first sent bubble from the composer it was typed in', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const animate = vi.fn();
    const bubble = { animate, getBoundingClientRect: () => ({ left: 500, bottom: 300, width: 200, height: 40 }) };
    const root = { querySelectorAll: () => [{ getAttribute: () => 'flight', animate: vi.fn(), querySelector: () => bubble }] };
    markUserMessageOrigin({ getBoundingClientRect: () => ({ left: 100, bottom: 700, width: 600, height: 44 }) });
    expect(animateUserMessageArrivals(root, new Set())).toBe(1);
    const [frames, options] = animate.mock.calls[0];
    expect(frames[0].transform).toBe('translate3d(-400px,400px,0) scale(1)');
    expect(frames.at(-1).transform).toBe('translate3d(0,0,0) scale(1)');
    expect(options.duration).toBe(420);
    // The origin is consumed: a later arrival uses the ordinary rise.
    const later = vi.fn();
    expect(animateUserMessageArrivals({ querySelectorAll: () => [{ getAttribute: () => 'next', animate: later, querySelector: () => null }] }, new Set())).toBe(1);
    expect(later.mock.calls[0][1].duration).toBe(320);
  });
});
