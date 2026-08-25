const activeSwaps = new WeakMap();

export function prefersReducedUiMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

export async function swapUiSurface(container, update, { direction = 1 } = {}) {
  if (!container || typeof update !== 'function' || prefersReducedUiMotion() || typeof Element.prototype.animate !== 'function') {
    update();
    return;
  }
  activeSwaps.get(container)?.cancel?.();
  const current = visibleChildren(container);
  const leaving = current.map((element) => {
    element.dataset.uiMotion = 'leaving';
    return element.animate([
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
      { opacity: 0, transform: `translate3d(${-12 * direction}px,6px,0) scale(.988)` },
    ], { duration: 145, easing: 'cubic-bezier(.4,0,.7,.2)', fill: 'forwards' });
  });
  const controller = { cancel: () => leaving.forEach((animation) => animation.cancel()) };
  activeSwaps.set(container, controller);
  await Promise.allSettled(leaving.map((animation) => animation.finished));
  if (activeSwaps.get(container) !== controller) return;
  current.forEach((element) => {
    element.removeAttribute('data-ui-motion');
    element.getAnimations?.().forEach((animation) => animation.cancel());
  });
  update();
  const next = visibleChildren(container);
  const entering = next.map((element) => {
    element.dataset.uiMotion = 'entering';
    const animation = element.animate([
      { opacity: 0, transform: `translate3d(${18 * direction}px,-5px,0) scale(.986)` },
      { opacity: 1, transform: 'translate3d(-1px,0,0) scale(1.002)', offset: .78 },
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
    ], { duration: 390, easing: 'cubic-bezier(.16,1,.3,1)' });
    animation.finished.finally(() => element.removeAttribute('data-ui-motion'));
    return animation;
  });
  activeSwaps.set(container, { cancel: () => entering.forEach((animation) => animation.cancel()) });
  await Promise.allSettled(entering.map((animation) => animation.finished));
  activeSwaps.delete(container);
}

function visibleChildren(container) {
  const children = container.id === 'modules-workspace'
    ? [...container.querySelectorAll(':scope > [data-modules-panel]')]
    : [...container.children];
  return children.filter((element) => !element.hidden && getComputedStyle(element).display !== 'none');
}
