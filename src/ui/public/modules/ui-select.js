const instances = new WeakMap();
let sequence = 0;
/** Styled, searchable presentation over the existing exact-value form control. */
export function enhanceSelect(select) {
  if (!select) return null;
  if (instances.has(select)) return instances.get(select);
  if (select.multiple || select.size > 1) return null;
  select.dataset.enhanced = 'true';
  const prefix = select.id || 'monarch-select-' + (++sequence);
  select.classList.add('monarch-native-select');
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'max-model-trigger';
  trigger.id = prefix === 'max-provider-model' ? 'max-model-trigger' : prefix + '-trigger';
  const sourceLabel = select.labels?.[0];
  trigger.setAttribute('aria-label', select.getAttribute('aria-label') || sourceLabel?.querySelector('span')?.textContent.trim() || 'Выбрать');
  if (select.getAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
  trigger.title = select.title;
  trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span'), arrow = document.createElement('span'); arrow.className = 'max-select-chevron'; arrow.setAttribute('aria-hidden', 'true');
  // A drawn chevron: the "⌄" glyph renders as a letter "v" in the UI font.
  arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  trigger.append(label, arrow);
  const popup = document.createElement('div'); popup.className = 'max-model-popup'; popup.id = prefix + '-popup'; popup.setAttribute('popover', 'auto');
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Найти в списке'; search.autocomplete = 'off'; search.spellcheck = false;
  search.setAttribute('aria-label', 'Поиск в списке'); search.setAttribute('role', 'combobox'); search.setAttribute('aria-autocomplete', 'list'); search.setAttribute('aria-expanded', 'false');
  const list = document.createElement('div'); list.id = prefix + '-options'; list.className = 'max-model-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', trigger.getAttribute('aria-label'));
  trigger.setAttribute('aria-controls', list.id); search.setAttribute('aria-controls', list.id);
  const empty = document.createElement('p'); empty.className = 'max-model-empty'; empty.textContent = 'Ничего не найдено'; empty.setAttribute('role', 'status');
  popup.append(search, list, empty); select.after(trigger, popup);
  if (sourceLabel?.htmlFor === select.id) sourceLabel.htmlFor = trigger.id;
  else sourceLabel?.addEventListener('click', event => { if (event.target === sourceLabel) trigger.focus(); });
  let opened = false, filtered = [], cursor = 0;
  const position = () => {
    const box = trigger.getBoundingClientRect();
    const below = innerHeight - box.bottom - 12, above = box.top - 12;
    const height = Math.min(360, Math.max(below, above));
    // A narrow trigger must not squeeze its own list: options keep a readable width.
    const width = Math.min(Math.max(box.width, 200), innerWidth - 24);
    popup.style.width = width + 'px';
    popup.style.maxHeight = height + 'px';
    popup.style.left = Math.max(12, Math.min(box.left, innerWidth - width - 12)) + 'px';
    popup.style.top = below >= Math.min(360, above) ? box.bottom + 6 + 'px' : 'auto';
    popup.style.bottom = below >= Math.min(360, above) ? 'auto' : innerHeight - box.top + 6 + 'px';
    popup.dataset.side = below >= Math.min(360, above) ? 'below' : 'above';
  };
  const highlight = () => {
    [...list.children].forEach((node, index) => { node.dataset.highlighted = String(index === cursor); });
    const node = list.children[cursor];
    if (node) {
      search.setAttribute('aria-activedescendant', node.id);
      // Scroll only the list. scrollIntoView also moved the Settings document,
      // leaving the top-layer menu detached from its trigger after opening.
      const rowBox = node.getBoundingClientRect(), listBox = list.getBoundingClientRect();
      if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top;
      else if (rowBox.bottom > listBox.bottom) list.scrollTop += rowBox.bottom - listBox.bottom;
    }
    else search.removeAttribute('aria-activedescendant');
  };
  const close = (focus = false) => {
    opened = false; popup.hidePopover(); trigger.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus({ preventScroll: true });
  };
  const choose = index => {
    if (!filtered[index] || select.disabled) return;
    select.value = filtered[index].value; select.dispatchEvent(new Event('change', { bubbles: true })); close(true);
  };
  const render = () => {
    const query = search.value.toLocaleLowerCase().trim();
    filtered = [...select.options].filter(option => !option.disabled && (option.text + ' ' + option.value).toLocaleLowerCase().includes(query));
    list.replaceChildren(); empty.hidden = filtered.length > 0;
    filtered.forEach((option, index) => {
      const row = document.createElement('div'); row.className = 'max-model-option'; row.id = prefix + '-option-' + index;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.value === select.value));
      const name = document.createElement('span'); name.textContent = option.text; name.title = option.value;
      const check = document.createElement('span'); check.className = 'max-model-check'; check.textContent = option.value === select.value ? '✓' : ''; check.setAttribute('aria-hidden', 'true');
      row.append(name, check); row.addEventListener('pointerdown', event => event.preventDefault()); row.addEventListener('click', () => choose(index)); list.append(row);
    });
    cursor = Math.max(0, filtered.findIndex(option => option.value === select.value)); highlight();
  };
  const sync = () => {
    const text = select.selectedOptions[0]?.text || 'Выбери из списка';
    if (label.textContent !== text) label.textContent = text;
    trigger.disabled = select.disabled; trigger.hidden = select.hidden || select.classList.contains('hidden') || select.style.display === 'none';
    if ((select.disabled || trigger.hidden || !select.isConnected) && opened) close(); else if (opened) render();
  };
  const open = () => {
    if (trigger.disabled) return;
    search.value = ''; opened = true; render(); position(); popup.showPopover();
    trigger.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-expanded', 'true'); search.focus({ preventScroll: true }); highlight();
  };
  trigger.addEventListener('click', () => opened ? close(true) : open());
  trigger.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } });
  search.addEventListener('input', render);
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    if (event.key === 'Enter') { event.preventDefault(); choose(cursor); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); cursor = event.key === 'Home' ? 0 : event.key === 'End' ? filtered.length - 1
      : Math.max(0, Math.min(filtered.length - 1, cursor + (event.key === 'ArrowDown' ? 1 : -1))); highlight();
  });
  popup.addEventListener('toggle', event => { if (event.newState === 'closed') { opened = false; trigger.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-expanded', 'false'); } });
  select.addEventListener('change', sync);
  const reposition = () => { if (opened) position(); };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  const observer = new MutationObserver(sync); observer.observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
  // Native .value assignments do not emit DOM mutations; keep their visible label in sync.
  const timer = setInterval(() => {
    if (!select.isConnected) { clearInterval(timer); observer.disconnect(); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); trigger.remove(); popup.remove(); instances.delete(select); return; }
    if (label.textContent !== (select.selectedOptions[0]?.text || 'Выбери из списка')) sync();
  }, 200);
  select.addEventListener('invalid', event => { event.preventDefault(); trigger.focus(); });
  select.form?.addEventListener('reset', () => queueMicrotask(sync));
  const api = { sync, close, focus: () => trigger.focus({ preventScroll: true }) }; instances.set(select, api); sync();
  return api;
}

export function initSharedSelects() {
  const scan = root => { if (root.matches?.('select')) enhanceSelect(root); root.querySelectorAll?.('select').forEach(enhanceSelect); };
  scan(document);
  const observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) scan(node); });
  observer.observe(document.body, { childList: true, subtree: true });
}
