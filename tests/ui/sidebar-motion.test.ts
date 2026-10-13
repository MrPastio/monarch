// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { initSidebarMotion } from '../../src/ui/public/modules/sidebar-motion.js';
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
it('tracks owner selection once, coalesces changes, and disconnects cleanly', async () => {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => queue.push(fn));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
  document.body.innerHTML = '<nav><button class="nav-item active">Чат</button><button class="nav-item">Память</button><button data-open-safe class="nav-item">Сейф</button></nav>';
  const root = document.querySelector('nav')!;
  const buttons = root.querySelectorAll('button');
  buttons.forEach((button, i) => Object.defineProperties(button, {
    offsetWidth: { value: 160 }, offsetHeight: { value: 44 }, offsetTop: { value: i * 49 }, offsetLeft: { value: 0 },
  }));
  const dispose = initSidebarMotion(root);
  expect(initSidebarMotion(root)).toBe(dispose);
  expect(root.querySelectorAll('.sidebar-selection')).toHaveLength(1);
  buttons[2].click();
  expect(buttons[0].classList.contains('active')).toBe(true);
  buttons[0].classList.remove('active'); buttons[1].classList.add('active');
  buttons[1].setAttribute('aria-current', 'page');
  await Promise.resolve();
  expect(queue).toHaveLength(1);
  queue[0](0);
  expect((root.querySelector('.sidebar-selection') as HTMLElement).style.transform).toBe('translate(0px, 49px)');
  dispose();
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(root.querySelector('.sidebar-selection')).toBeNull();
  expect(root.hasAttribute('data-motion-ready')).toBe(false);
});
