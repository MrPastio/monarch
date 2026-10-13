// "Что нового" inside Monarch: release notes shipped with the app, filtered by
// kind. Opens once after an update to this line, and any time from Updates.
import { escapeHtml } from './utils.js';

const SEEN_KEY = 'monarch.whatsNew.seenVersion';
const FILTERS = Object.freeze([['all', 'Всё'], ['feature', 'Функции'], ['fix', 'Исправления'], ['security', 'Безопасность']]);
const TYPE_LABELS = Object.freeze({ feature: 'Функция', fix: 'Исправление', security: 'Безопасность' });
let notesPromise = null;
// A returning profile already has Monarch keys from earlier runs. Read once at
// module load, before this session writes anything, so a fresh install (or an
// isolated test profile) is not greeted with "what changed" it never saw.
const returningProfile = (() => {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      if (String(localStorage.key(index) || '').startsWith('monarch.')) return true;
    }
  } catch { /* storage unavailable */ }
  return false;
})();

function loadNotes() {
  notesPromise ||= fetch('/whats-new.json', { cache: 'no-store' })
    .then(response => (response.ok ? response.json() : null)).catch(() => null);
  return notesPromise;
}

export function whatsNewEntries(notes, filter = 'all') {
  const entries = Array.isArray(notes?.entries) ? notes.entries.filter(entry => TYPE_LABELS[entry?.type]) : [];
  return filter === 'all' ? entries : entries.filter(entry => entry.type === filter);
}

export function renderWhatsNewList(entries) {
  if (!entries.length) return '<p class="whats-new-empty">В этой группе изменений нет.</p>';
  return `<ol class="whats-new-list">${entries.map(entry => (
    `<li data-type="${escapeHtml(entry.type)}"><span>${escapeHtml(TYPE_LABELS[entry.type])}</span><strong>${escapeHtml(entry.title)}</strong><p>${escapeHtml(entry.text)}</p></li>`
  )).join('')}</ol>`;
}

export function shouldShowWhatsNew(currentVersion, notesVersion, seenVersion, returning = true) {
  return returning && typeof currentVersion === 'string' && typeof notesVersion === 'string'
    && (currentVersion === notesVersion || currentVersion.startsWith(notesVersion + '.')) && seenVersion !== notesVersion;
}

function selectedFilter(dialog) {
  return dialog.querySelector('[data-whats-new-filter][aria-checked="true"]')?.dataset.whatsNewFilter || 'all';
}

export async function openWhatsNew() {
  const notes = await loadNotes();
  if (!notes) return;
  let dialog = document.querySelector('#whats-new-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'whats-new-dialog';
    dialog.className = 'whats-new-dialog';
    dialog.setAttribute('aria-labelledby', 'whats-new-title');
    dialog.innerHTML = `<header><h3 id="whats-new-title">${escapeHtml(notes.title || 'Что нового')}</h3><button type="button" class="claude-ghost-btn" data-whats-new-close aria-label="Закрыть">×</button></header>
      <div class="whats-new-filters" role="radiogroup" aria-label="Показать">${FILTERS.map(([id, label], index) => (
        `<button type="button" role="radio" data-whats-new-filter="${id}" aria-checked="${index === 0}">${label}</button>`)).join('')}</div>
      <div class="whats-new-body"></div>`;
    dialog.querySelector('[data-whats-new-close]').addEventListener('click', () => dialog.close());
    dialog.querySelectorAll('[data-whats-new-filter]').forEach(button => button.addEventListener('click', () => {
      dialog.querySelectorAll('[data-whats-new-filter]').forEach(item => item.setAttribute('aria-checked', String(item === button)));
      dialog.querySelector('.whats-new-body').innerHTML = renderWhatsNewList(whatsNewEntries(notes, selectedFilter(dialog)));
    }));
    document.body.append(dialog);
  }
  dialog.querySelector('.whats-new-body').innerHTML = renderWhatsNewList(whatsNewEntries(notes, selectedFilter(dialog)));
  if (!dialog.open) dialog.showModal();
  try { localStorage.setItem(SEEN_KEY, String(notes.version)); } catch { /* optional convenience */ }
}

/** Called with the running version once the updater reports it. */
export async function maybeShowWhatsNew(currentVersion) {
  const notes = await loadNotes();
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { return; }
  if (shouldShowWhatsNew(currentVersion, notes?.version, seen, returningProfile)) await openWhatsNew();
  else if (!returningProfile && notes?.version) {
    try { localStorage.setItem(SEEN_KEY, String(notes.version)); } catch { /* optional convenience */ }
  }
}
