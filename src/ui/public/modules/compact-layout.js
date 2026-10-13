/** Presentation only: original nodes, handlers, values and action scopes are retained. */
export function paginateExistingList(root, pageSize = 6) {
  const selectedIndex = [...root.children].findIndex(item => item.matches('.is-selected, [aria-selected="true"], [aria-pressed="true"]'));
  let page = Math.floor(Math.max(0, selectedIndex) / pageSize);
  const nav = document.createElement('nav');
  nav.className = 'collection-pager';
  nav.setAttribute('aria-label', 'Страницы списка');
  const previous = document.createElement('button');
  const next = document.createElement('button');
  const counter = document.createElement('span');
  counter.setAttribute('role', 'status');
  previous.type = next.type = 'button';
  previous.textContent = '←'; next.textContent = '→';
  previous.setAttribute('aria-label', 'Предыдущая страница');
  next.setAttribute('aria-label', 'Следующая страница');
  nav.append(previous, counter, next);
  root.after(nav);
  const update = () => {
    const items = [...root.children];
    const total = Math.max(1, Math.ceil(items.length / pageSize));
    page = Math.min(page, total - 1);
    items.forEach((item, index) => item.classList.toggle('collection-page-hidden', index < page * pageSize || index >= (page + 1) * pageSize));
    nav.hidden = items.length <= pageSize;
    previous.disabled = page === 0; next.disabled = page + 1 === total;
    counter.textContent = `${page * pageSize + 1}–${Math.min(items.length, (page + 1) * pageSize)} из ${items.length}`;
  };
  previous.addEventListener('click', () => { page = Math.max(0, page - 1); update(); (previous.disabled ? next : previous).focus({ preventScroll: true }); });
  next.addEventListener('click', () => { page += 1; update(); (next.disabled ? previous : next).focus({ preventScroll: true }); });
  const observer = new MutationObserver(update);
  observer.observe(root, { childList: true });
  update();
  return () => { observer.disconnect(); nav.remove(); [...root.children].forEach(item => item.classList.remove('collection-page-hidden')); };
}

export function sectionSwitcher(root, groups, label) {
  if (!root) return;
  const available = groups.map(([title, selector]) => ({ title, nodes: [...root.querySelectorAll(selector)] })).filter(group => group.nodes.length);
  if (available.length < 2) return;
  const nav = document.createElement('nav');
  nav.className = 'compact-section-tabs';
  nav.setAttribute('aria-label', label);
  const panels = [];
  const buttons = [];
  const show = index => {
    panels.forEach((panel, i) => { panel.hidden = i !== index; buttons[i].setAttribute('aria-pressed', String(i === index)); });
  };
  available.forEach((group, index) => {
    const panel = document.createElement('div');
    panel.className = 'compact-section-panel';
    const first = group.nodes[0];
    first.before(panel);
    group.nodes.forEach(node => panel.append(node));
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = group.title;
    button.addEventListener('click', () => show(index));
    panel.addEventListener('invalid', () => show(index), true);
    panel.addEventListener('monarch:reveal', () => show(index));
    buttons.push(button); panels.push(panel); nav.append(button);
  });
  panels[0].before(nav);
  show(0);
}

function disclose(element, title) {
  if (!element || element.closest('.compact-disclosure')) return;
  const details = document.createElement('details');
  details.className = 'compact-disclosure';
  const summary = document.createElement('summary'); summary.textContent = title;
  element.before(details); details.append(summary, element);
  details.addEventListener('invalid', () => { details.open = true; }, true);
}

export function initCompactLayout() {
  sectionSwitcher(document.querySelector('#security-settings-panel'), [
    ['Фон', ':scope > .security-background-card'], ['Приватность', ':scope > #security-privacy-policy'],
    ['Режим', ':scope > .security-settings-shell:not(#security-privacy-policy)'], ['PIN', ':scope > .security-pin-card'],
    ['Диагностика', ':scope > .security-maintenance'],
  ], 'Настройки защиты');
  sectionSwitcher(document.querySelector('.security-network-center'), [
    ['Подключения', ':scope > .security-network-columns'],
    ['Сети', ':scope > section:has(#security-network-profiles)'],
    ['Действия', ':scope > section:has(#security-response-actions)'],
    ['История', ':scope > section:has(#security-network-history)'],
  ], 'Данные сети');
  disclose(document.querySelector('.owner-enrollment-steps'), 'Настроить доступ на устройстве');
  const system = document.querySelector('details.settings-system:not(.legacy-system-diagnostics)');
  if (system) system.open = false;

  const listSelectors = '#memory-settings-list, #skills-settings-list, #module-library-grid, #image-gallery-grid, [data-max-providers], #voice-pronunciation-list, #oscar-voice-custom-presets, #owner-prompt-list, #active-leases-list, #action-ledger-list, #coder-history-list, .models-card-grid, .sharing-model-rail, .sharing-tts-rail, #red-zone-list';
  const managed = new Map();
  const scan = () => {
    for (const [element, dispose] of managed) if (!element.isConnected) { dispose(); managed.delete(element); }
    document.querySelectorAll(listSelectors).forEach(element => {
      if (!managed.has(element)) managed.set(element, paginateExistingList(element, element.id === 'image-gallery-grid' ? 8 : 6));
    });
  };
  scan();
  // Model and sharing renderers can replace whole collection roots.
  const observer = new MutationObserver(records => {
    const collectionsChanged = records.some(record => [...record.addedNodes, ...record.removedNodes]
      .some(node => node.nodeType === 1 && (node.matches(listSelectors) || node.querySelector(listSelectors))));
    if (collectionsChanged) scan();
  });
  observer.observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
  return () => { observer.disconnect(); managed.forEach(dispose => dispose()); };
}
