const COMPOSER_INPUT_SELECTOR = '[data-composer-type-to-focus]';
const EDITABLE_TARGET_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const SPACE_ACTIVATION_TARGET_SELECTOR = 'button, summary, a[href], [role="button"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="option"], [role="menuitem"]';
const BLOCKING_SURFACE_SELECTOR = [
  'dialog[open]',
  '[aria-modal="true"]:not([hidden])',
  '.dropdown-popover:not(.hidden)',
  '.composer-options[open]',
  '.oscar-function-picker:not(.hidden)',
  '.oscar-skill-picker:not(.hidden)',
].join(', ');

export function installComposerTypeToFocus(documentObject = document) {
  const onKeyDown = (event) => routePrintableKeyToComposer(event, documentObject);
  documentObject.addEventListener('keydown', onKeyDown);
  return () => documentObject.removeEventListener('keydown', onKeyDown);
}

export function routePrintableKeyToComposer(event, documentObject) {
  if (!isUnclaimedPrintableKey(event)) return false;
  if (closestElement(event.target, EDITABLE_TARGET_SELECTOR)) return false;
  if (event.key === ' ' && closestElement(event.target, SPACE_ACTIVATION_TARGET_SELECTOR)) return false;
  if (documentObject.querySelector(BLOCKING_SURFACE_SELECTOR)) return false;

  const input = findVisibleComposerInput(documentObject);
  if (!input) return false;

  event.preventDefault();
  focusWithoutScroll(input);
  insertTextAtSelection(input, event.key);
  dispatchComposerInput(input, event.key, documentObject);
  return true;
}

export function isUnclaimedPrintableKey(event) {
  return !event.defaultPrevented
    && !event.isComposing
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && typeof event.key === 'string'
    && event.key.length === 1;
}

export function findVisibleComposerInput(documentObject) {
  const inputs = documentObject.querySelectorAll(COMPOSER_INPUT_SELECTOR);
  return [...inputs].find((input) => isAvailableComposerInput(input, documentObject)) || null;
}

function isAvailableComposerInput(input, documentObject) {
  if (!input || input.disabled || input.readOnly || typeof input.focus !== 'function') return false;
  if (closestElement(input, '[hidden], [aria-hidden="true"]')) return false;
  const style = documentObject.defaultView?.getComputedStyle?.(input);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  if (typeof input.getClientRects === 'function' && input.getClientRects().length === 0) return false;
  return true;
}

function insertTextAtSelection(input, text) {
  const current = String(input.value || '');
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : current.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  if (typeof input.setRangeText === 'function') {
    input.setRangeText(text, start, end, 'end');
    return;
  }
  input.value = `${current.slice(0, start)}${text}${current.slice(end)}`;
  const caret = start + text.length;
  if (typeof input.setSelectionRange === 'function') input.setSelectionRange(caret, caret);
}

function dispatchComposerInput(input, text, documentObject) {
  const view = documentObject.defaultView || globalThis;
  let inputEvent;
  try {
    inputEvent = new view.InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    });
  } catch {
    inputEvent = new view.Event('input', { bubbles: true });
  }
  input.dispatchEvent(inputEvent);
}

function focusWithoutScroll(input) {
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
}

function closestElement(target, selector) {
  return target && typeof target.closest === 'function' ? target.closest(selector) : null;
}
