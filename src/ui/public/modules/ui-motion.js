const activeSwaps = new WeakMap();

// One animation owner, called by the ordinary composer after DOM reconciliation.
// Where the next sent message leaves from: the composer text box, captured
// right before its text is cleared. Consumed by the first arrival only.
let pendingMessageOrigin = null;
export function markUserMessageOrigin(element) {
  const rect = element?.getBoundingClientRect?.();
  pendingMessageOrigin = rect && rect.width > 0 && rect.height > 0 ? { rect, at: Date.now() } : null;
}

export function animateUserMessageArrivals(root, seen) {
  if (!root) return 0;
  const reduced = prefersReducedUiMotion();
  let count = 0;
  root.querySelectorAll('.oscar-message.user[data-send-active="true"][data-message-id]').forEach(item => {
    const id = item.getAttribute('data-message-id');
    if (!id || seen.has(id)) return;
    seen.add(id); // Also consume while reduced motion is on: never replay later.
    const origin = pendingMessageOrigin && Date.now() - pendingMessageOrigin.at < 1500 ? pendingMessageOrigin.rect : null;
    pendingMessageOrigin = null;
    if (reduced || typeof item.animate !== 'function') return;
    const bubble = item.querySelector?.('.oscar-message-card') || item;
    const target = origin ? bubble.getBoundingClientRect?.() : null;
    if (origin && target?.width > 0 && typeof bubble.animate === 'function') {
      // FLIP: the bubble starts where the text was typed (left edge and bottom
      // of the input), then settles into the thread with its own weight.
      const dx = origin.left - target.left, dy = origin.bottom - target.bottom;
      const scale = Math.max(.6, Math.min(1, origin.width / target.width));
      bubble.animate([
        { opacity: .4, transform: `translate3d(${dx}px,${dy}px,0) scale(${scale})`, transformOrigin: 'left bottom' },
        { opacity: 1, transform: 'translate3d(0,0,0) scale(1)', transformOrigin: 'left bottom' },
      ], { duration: 420, easing: 'cubic-bezier(.2,.9,.25,1)' });
    } else {
      item.animate([
        { opacity: 0, transform: 'translate3d(0,14px,0) scale(.97)' },
        { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
      ], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    count += 1;
  });
  return count;
}

// One owner of "less motion": the Windows setting, or Monarch's own switch
// (Settings -> System) on top of it. Shaped like a MediaQueryList so callers
// read `.matches` and listen for `change` the same way as before.
const motionListeners = new Set();
let systemMotionQuery;
function systemReducedMotion() {
  if (systemMotionQuery === undefined) systemMotionQuery = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  return systemMotionQuery;
}
export const reducedUiMotion = Object.freeze({
  get matches() {
    return (typeof document !== 'undefined' && document.documentElement?.dataset.motion === 'reduced')
      || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true);
  },
  addEventListener(type, listener) {
    if (type !== 'change' || typeof listener !== 'function') return;
    motionListeners.add(listener); systemReducedMotion()?.addEventListener?.('change', listener);
  },
  removeEventListener(type, listener) {
    if (type !== 'change') return;
    motionListeners.delete(listener); systemReducedMotion()?.removeEventListener?.('change', listener);
  },
});

export function setUiMotionPreference(mode) {
  const next = mode === 'reduced' ? 'reduced' : 'system';
  if (typeof document === 'undefined' || document.documentElement.dataset.motion === next) return;
  document.documentElement.dataset.motion = next;
  const event = { matches: reducedUiMotion.matches };
  for (const listener of motionListeners) listener(event);
}

export function prefersReducedUiMotion() {
  return reducedUiMotion.matches;
}

export async function swapUiSurface(container, update, { direction = 1 } = {}) {
  activeSwaps.get(container)?.cancel?.();
  if (!container || typeof update !== 'function' || prefersReducedUiMotion() || typeof Element.prototype.animate !== 'function') {
    if (typeof update === 'function') update();
    return;
  }
  const current = visibleChildren(container);
  let ownedAnimations = [];
  let ownedElements = current;
  const controller = { cancel: () => {
    ownedAnimations.forEach(animation => animation.cancel());
    ownedElements.forEach(element => element.removeAttribute('data-ui-motion'));
    if (activeSwaps.get(container) === controller) activeSwaps.delete(container);
  } };
  activeSwaps.set(container, controller);
  const leaving = current.map((element) => {
    element.dataset.uiMotion = 'leaving';
    return element.animate([
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
      { opacity: 0, transform: `translate3d(${-6 * direction}px,2px,0) scale(.996)` },
    ], { duration: 100, easing: 'cubic-bezier(.4,0,.7,.2)', fill: 'forwards' });
  });
  ownedAnimations = leaving;
  await Promise.allSettled(leaving.map((animation) => animation.finished));
  if (activeSwaps.get(container) !== controller) return;
  current.forEach((element) => {
    element.removeAttribute('data-ui-motion');
  });
  leaving.forEach(animation => animation.cancel());
  update();
  const next = visibleChildren(container);
  ownedElements = next;
  const entering = next.map((element) => {
    element.dataset.uiMotion = 'entering';
    const animation = element.animate([
      { opacity: 0, transform: `translate3d(${8 * direction}px,2px,0) scale(.996)` },
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
    ], { duration: 240, easing: 'cubic-bezier(.16,1,.3,1)' });
    return animation;
  });
  ownedAnimations = entering;
  await Promise.allSettled(entering.map((animation) => animation.finished));
  if (activeSwaps.get(container) === controller) controller.cancel();
}

function visibleChildren(container) {
  return [...container.children].filter((element) => !element.hidden && getComputedStyle(element).display !== 'none');
}
