// A soft, one-time note on surfaces that are still early alpha. It watches the
// surface itself becoming visible, so every way of opening it (button,
// keyboard, wake word, navigation) shows the note the same single time.
import { reducedUiMotion } from './ui-motion.js';

export const EARLY_ACCESS_SURFACES = Object.freeze([
  { id: 'voice', host: '#oscar-voice-mode-surface', overlay: true, open: (node) => !node.hidden,
    title: 'Голосовой режим — ранняя альфа',
    text: 'Он пока работает крайне нестабильно: может ошибаться в распознавании, отвечать с задержкой или обрываться.' },
  { id: 'coder', host: '#coder-mode-root', watch: '#chat-mode-coder', open: (_node, tab) => tab?.getAttribute('aria-selected') === 'true',
    title: 'Coder — ранняя альфа',
    text: 'Он пока работает крайне нестабильно. Проверяй изменения перед тем, как на них полагаться.' },
  { id: 'sharing', host: '#sharing-section', open: (node) => !node.classList.contains('view-hidden') && !node.hidden,
    title: 'Общий доступ — ранняя альфа',
    text: 'Он пока работает крайне нестабильно: подключение может обрываться или не работать.' },
]);

const storageKey = (id) => `monarch.early-access.${id}.seen`;
function seen(id) { try { return localStorage.getItem(storageKey(id)) === '1'; } catch { return false; } }
function remember(id) { try { localStorage.setItem(storageKey(id), '1'); } catch { /* shown again next time: harmless */ } }

function show(surface, host) {
  remember(surface.id);
  const note = document.createElement('div');
  note.className = 'early-access-note' + (surface.overlay ? ' early-access-note--overlay' : '');
  note.setAttribute('role', 'status');
  note.dataset.surface = surface.id;
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = surface.title;
  const text = document.createElement('small');
  text.textContent = surface.text;
  copy.append(title, text);
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Понятно';
  close.addEventListener('click', () => dismiss(note));
  note.append(copy, close);
  // Pages get it in the flow above their content; the full-screen voice
  // surface gets it floating at its top edge.
  if (surface.overlay) host.append(note); else host.prepend(note);
  const from = surface.overlay ? 'translate(-50%, -8px)' : 'translateY(-6px)';
  const rest = surface.overlay ? 'translate(-50%, 0)' : 'none';
  note.dataset.from = from; note.dataset.rest = rest;
  if (!reducedUiMotion.matches) {
    note.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: rest }],
      { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }
}

function dismiss(note) {
  if (note.dataset.leaving) return;
  note.dataset.leaving = 'true';
  if (reducedUiMotion.matches) { note.remove(); return; }
  note.animate([{ opacity: 1, transform: note.dataset.rest }, { opacity: 0, transform: note.dataset.from }],
    { duration: 200, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }).finished.finally(() => note.remove());
}

export function initEarlyAccessNotices(root = document) {
  for (const surface of EARLY_ACCESS_SURFACES) {
    if (seen(surface.id)) continue;
    const host = root.querySelector(surface.host);
    const watched = surface.watch ? root.querySelector(surface.watch) : host;
    if (!host || !watched) continue;
    const check = () => {
      if (seen(surface.id) || !surface.open(host, watched)) return;
      observer.disconnect();
      show(surface, host);
    };
    const observer = new MutationObserver(check);
    observer.observe(watched, { attributes: true, attributeFilter: ['hidden', 'class', 'aria-selected'] });
    check();
  }
}

/** Monarch Security is still in development. The note stays until the person
 * acknowledges it once; after that it is remembered and not shown again. */
export function mountSecurityDevelopmentBanner(root = document) {
  const chrome = root.querySelector('#security-section .security-chrome');
  if (!chrome || seen('security') || chrome.parentElement.querySelector('.security-dev-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'security-dev-banner';
  banner.setAttribute('role', 'note');
  const mark = document.createElement('span');
  mark.className = 'security-dev-mark';
  mark.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  copy.className = 'security-dev-copy';
  const title = document.createElement('strong');
  title.textContent = 'Monarch Security ещё в разработке';
  const text = document.createElement('small');
  text.textContent = 'Он может работать нестабильно: пропустить угрозу, ошибиться в оценке или остановиться. Держи включённым Microsoft Defender или другой антивирус.';
  copy.append(title, text);
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.textContent = 'Я осознаю';
  accept.addEventListener('click', () => {
    remember('security');
    if (reducedUiMotion.matches) { banner.remove(); return; }
    // Collapses into the place it occupied instead of blinking out.
    const height = banner.offsetHeight;
    banner.animate([{ opacity: 1, height: height + 'px' }, { opacity: 0, height: '0px', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' }],
      { duration: 240, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }).finished.finally(() => banner.remove());
  });
  banner.append(mark, copy, accept);
  chrome.after(banner);
}
