import { reducedUiMotion } from './ui-motion.js';
const MENU_ID = 'oscar-composer-menu';
const CLOSE_MS = 220;
let closeTimer = 0;

export function initOscarPlusMenu() {
  const menu = document.getElementById(MENU_ID);
  const summary = menu?.querySelector(':scope > summary');
  if (!menu || !summary || summary.dataset.plusMenuBound === 'true') return;
  summary.dataset.plusMenuBound = 'true';
  summary.addEventListener('click', (event) => {
    if (!menu.open || menu.dataset.closing === 'true') return;
    event.preventDefault();
    closeOscarComposerMenu();
  });
  menu.addEventListener('toggle', () => {
    if (menu.open) {
      menu.removeAttribute('data-closing');
      summary.setAttribute('aria-expanded', 'true');
      return;
    }
    summary.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!menu.open || menu.dataset.closing === 'true') return;
    closeOscarComposerMenu();
  });
}

export function closeOscarComposerMenu(options = {}) {
  const menu = document.getElementById(MENU_ID);
  if (!menu?.open) return;
  if (options.immediate === true || prefersReducedMotion()) {
    finishClose(menu);
    return;
  }
  if (menu.dataset.closing === 'true') return;
  menu.dataset.closing = 'true';
  const popover = menu.querySelector('#oscar-composer-menu-popover');
  const finish = () => finishClose(menu);
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(finish, CLOSE_MS);
  if (!popover) {
    finish();
    return;
  }
  const onEnd = (event) => {
    if (event.target !== popover) return;
    if (event.animationName && !String(event.animationName).includes('oscarPlusMenuOut')) return;
    popover.removeEventListener('animationend', onEnd);
    finish();
  };
  popover.addEventListener('animationend', onEnd);
}

function finishClose(menu) {
  window.clearTimeout(closeTimer);
  closeTimer = 0;
  menu.removeAttribute('open');
  menu.removeAttribute('data-closing');
  menu.querySelector(':scope > summary')?.setAttribute('aria-expanded', 'false');
}

function prefersReducedMotion() {
  return reducedUiMotion.matches === true;
}
