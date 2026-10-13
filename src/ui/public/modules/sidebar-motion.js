// Presentation only: the existing navigation owner decides which view is active.
const mounted = new WeakMap();
export function initSidebarMotion(root = document.querySelector('.sidebar .nav-stack')) {
  if (!root) return () => {};
  if (mounted.has(root)) return mounted.get(root);
  const marker = document.createElement('span');
  marker.className = 'sidebar-selection';
  marker.setAttribute('aria-hidden', 'true');
  root.prepend(marker);
  let frame = 0, disposed = false;
  const update = () => {
    frame = 0;
    const active = root.querySelector('.nav-item.active');
    if (!active || !active.offsetWidth || !active.offsetHeight) {
      marker.hidden = true;
      return;
    }
    marker.hidden = false;
    marker.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    marker.style.width = `${active.offsetWidth}px`;
    marker.style.height = `${active.offsetHeight}px`;
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(update);
  };
  update();
  root.setAttribute('data-motion-ready', 'true');
  const observer = new MutationObserver(schedule);
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-current'], childList: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  root.querySelectorAll('.nav-item').forEach(item => resize.observe(item));
  const dispose = () => {
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    resize.disconnect();
    marker.remove();
    root.removeAttribute('data-motion-ready');
    mounted.delete(root);
  };
  mounted.set(root, dispose);
  return dispose;
}
