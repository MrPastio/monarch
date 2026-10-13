// Interface language. Russian is the source text; every other language is a
// dictionary keyed by the exact Russian string (as gettext keys by msgid).
// Presentation only: user text, model answers, code and form values are
// never touched, and a string without a translation stays as written.

export const UI_LANGUAGES = Object.freeze([
  { id: 'ru', label: 'Русский', short: 'RU' },
  { id: 'uk', label: 'Українська', short: 'UK' },
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'bg', label: 'Български', short: 'BG' },
]);
const IDS = UI_LANGUAGES.map((item) => item.id);
const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];
// Content that belongs to the person or the model, or is typed data.
const SKIP = 'script,style,pre,code,[contenteditable="true"],[data-no-i18n],'
  + '.message-text,.oscar-reasoning-content,.conversation-title,.conversation-preview,.coder-output,.markdown-body';

// Form fields keep what the person typed; only their hints are translated.
const FIELDS = 'textarea,input';

export function normalizeUiLanguage(value, fallback = 'ru') {
  return IDS.includes(value) ? value : fallback;
}

/** First launch follows the system language when Monarch speaks it. */
export function detectUiLanguage(languages = globalThis.navigator?.languages || []) {
  for (const tag of languages) {
    const base = String(tag || '').toLowerCase().split('-')[0];
    if (IDS.includes(base)) return base;
  }
  return 'ru';
}

const key = (value) => value.replace(/\s+/g, ' ').trim();

/** Pure lookup, kept whitespace around the text. */
export function translateText(value, dictionary) {
  if (!dictionary || typeof value !== 'string') return value;
  const source = key(value);
  const target = source && dictionary[source];
  if (!target) return value;
  const lead = value.match(/^\s*/)[0];
  const tail = value.slice(lead.length).match(/\s*$/)[0];
  return lead + target + tail;
}

let language = 'ru';
let dictionary = null;
let observer = null;
const loaded = new Map();
// Source (Russian) text of each node and attribute, and what we wrote over it.
// A later write by the app that differs from ours is a new source.
const textSource = new WeakMap();
const textShown = new WeakMap();
const attrSource = new WeakMap();
const listeners = new Set();

export function currentUiLanguage() { return language; }
export function onUiLanguageChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

/** Translate a string built in code (for text set outside the DOM walk). */
export function t(value) { return language === 'ru' ? value : translateText(value, dictionary); }

async function loadDictionary(id) {
  if (id === 'ru') return null;
  if (!loaded.has(id)) {
    loaded.set(id, fetch(`/i18n/${id}.json`, { cache: 'no-cache' })
      .then((response) => { if (!response.ok) throw Error('i18n'); return response.json(); })
      .catch((error) => { loaded.delete(id); throw error; }));
  }
  return loaded.get(id);
}

function skipped(element) {
  return !element || Boolean(element.closest?.(SKIP));
}
const textSkipped = (element) => skipped(element) || Boolean(element.closest(FIELDS));

function translateNode(node) {
  const known = textSource.has(node);
  if (known && node.nodeValue !== textShown.get(node)) textSource.set(node, node.nodeValue);
  const source = known ? textSource.get(node) : node.nodeValue;
  if (!source || !/[А-Яа-яЁё]/.test(source)) return;
  if (!known) textSource.set(node, source);
  const next = language === 'ru' ? source : translateText(source, dictionary);
  textShown.set(node, next);
  if (node.nodeValue !== next) node.nodeValue = next;
}

function translateAttributes(element) {
  let sources = attrSource.get(element);
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    const entry = sources?.[name];
    if (entry && value !== entry.shown) entry.source = value;
    const source = entry ? entry.source : value;
    if (!/[А-Яа-яЁё]/.test(source)) continue;
    if (!sources) { sources = {}; attrSource.set(element, sources); }
    const next = language === 'ru' ? source : translateText(source, dictionary);
    sources[name] = { source, shown: next };
    if (value !== next) element.setAttribute(name, next);
  }
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (!textSkipped(root.parentElement)) translateNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || skipped(root)) return;
  translateAttributes(root);
  if (root.matches(FIELDS)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (node.matches(SKIP)) return NodeFilter.FILTER_REJECT;
      if (node.matches(FIELDS)) { translateAttributes(node); return NodeFilter.FILTER_REJECT; }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) translateNode(node);
    else translateAttributes(node);
  }
}

function watch() {
  observer?.disconnect();
  observer = null;
  if (language === 'ru') return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(translateTree);
      else if (record.type === 'characterData') { if (!textSkipped(record.target.parentElement)) translateNode(record.target); }
      else if (record.target.nodeType === Node.ELEMENT_NODE && !skipped(record.target)) translateAttributes(record.target);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ATTRIBUTES });
}

/** Paint the interface in `id`. A missing dictionary keeps the current language. */
export async function setUiLanguage(id) {
  const next = normalizeUiLanguage(id);
  let nextDictionary = null;
  try { nextDictionary = await loadDictionary(next); } catch { return language; }
  language = next;
  dictionary = nextDictionary;
  document.documentElement.lang = next;
  translateTree(document.body);
  if (document.title) document.title = t(document.title);
  watch();
  syncPickers();
  for (const listener of listeners) { try { listener(language); } catch { /* one listener must not stop others */ } }
  return language;
}

/* ---------- picker ---------- */

const pickers = new Set();
function syncPickers() {
  // Two pickers live for the whole session (first setup and Settings).
  for (const picker of pickers) {
    picker.querySelectorAll('[data-ui-language]').forEach((button) => {
      const checked = button.dataset.uiLanguage === language;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    });
  }
}

/** A four-way radio group; language names stay in their own language. */
export function createLanguagePicker({ onChange, className = '' } = {}) {
  const group = document.createElement('div');
  group.className = ('ui-language-picker ' + className).trim();
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Язык интерфейса');
  for (const item of UI_LANGUAGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-language-option';
    button.setAttribute('role', 'radio');
    button.dataset.uiLanguage = item.id;
    button.lang = item.id;
    const name = document.createElement('span');
    name.dataset.noI18n = '';
    name.textContent = item.label;
    button.append(name);
    group.append(button);
  }
  group.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ui-language]');
    if (button) onChange?.(button.dataset.uiLanguage);
  });
  group.addEventListener('keydown', (event) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const index = IDS.indexOf(language);
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = IDS[(index + step + IDS.length) % IDS.length];
    onChange?.(next);
    requestAnimationFrame(() => group.querySelector(`[data-ui-language="${next}"]`)?.focus());
  });
  pickers.add(group);
  syncPickers();
  return group;
}
