// Navigation only. Destinations invoke the existing view/tab owners; this module
// must never start services, grant access, or expose hidden owner-only controls.
import { initSidebarMotion } from './sidebar-motion.js';
const destinations = [
  ['Диалог', 'Oscar', 'oscar', '', 'чат вопрос ответ'],
  ['Стиль ответов', 'Настройки', 'settings', 'style', 'личность характер тон обращение'],
  ['Голос', 'Настройки', 'settings', 'voice', 'диктовка речь тембр произношение'],
  ['Модели', 'Настройки', 'settings', 'models', 'скачать установка локальные AI'],
  ['Память', 'Настройки', 'settings', 'memory', 'факты заметки предпочтения'],
  ['Навыки', 'Настройки', 'settings', 'skills', 'действия skills'],
  ['Telegram', 'Настройки', 'settings', 'telegram', 'бот удалённый доступ подключить'],
  ['Monarch Safe', 'Настройки', 'settings', 'safe', 'хранилище защита'],
  ['Система', 'Настройки', 'settings', 'system', 'обновления интерфейс запуск доступ'],
  ['Изображения', 'Создание', 'images', '', 'рисунок фото генерация perchance'],
  ['Галерея', 'Изображения', 'images', 'gallery', 'результаты картинки'],
  ['Подключения MAX', 'Настройки', 'settings', 'max', 'ключ облако сервис openai claude gemini groq'],
  ['Настройки изображений', 'Настройки', 'settings', 'images', 'хранение провайдер'],
  ['Обзор безопасности', 'Безопасность', 'security', 'overview', 'security защита сканирование файл'],
  ['События', 'Безопасность', 'security', 'incidents', 'угрозы история инциденты'],
  ['Сеть', 'Безопасность', 'security', 'network', 'соединения интернет'],
  ['Изоляция', 'Безопасность', 'security', 'quarantine', 'карантин'],
  ['Настройки безопасности', 'Безопасность', 'security', 'settings', 'защита уровень pin приватность'],
  ['Общий доступ', 'Sharing', 'sharing', '', 'поделиться подключение сеть'],
];

export function findNavigationDestinations(query) {
  const words = String(query || '').toLocaleLowerCase('ru').trim().split(/\s+/u).filter(Boolean);
  return destinations.filter(item => words.every(word => item.join(' ').toLocaleLowerCase('ru').includes(word)));
}

export function initUiNavigation() {
  initSidebarMotion();
  const dialog = document.querySelector('#navigation-search');
  const input = document.querySelector('#navigation-search-input');
  const results = document.querySelector('#navigation-search-results');
  const trigger = document.querySelector('#navigation-search-open');
  let returnFocus;
  const close = () => dialog.close();
  const render = () => {
    const matches = findNavigationDestinations(input.value);
    results.replaceChildren(...matches.map(([title, group, view, subview]) => {
      const button = document.createElement('button');
      button.type = 'button';
      const label = document.createElement('strong');
      label.textContent = title;
      const detail = document.createElement('span');
      detail.textContent = group;
      button.append(label, detail);
      button.addEventListener('click', () => {
        close();
        window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view: `${view}-section`, subview, focusContent: true } }));
      });
      return button;
    }));
    document.querySelector('#navigation-search-count').textContent = matches.length
      ? `Разделов: ${matches.length}` : 'Ничего не найдено. Попробуй другое название.';
  };
  const open = () => {
    if (dialog.open || document.querySelector('dialog[open], [aria-modal="true"]:not([hidden]):not(.hidden)')) return;
    returnFocus = document.activeElement;
    input.value = '';
    render();
    dialog.showModal();
    input.focus();
  };
  trigger.addEventListener('click', open);
  document.querySelector('#navigation-search-close').addEventListener('click', close);
  dialog.addEventListener('close', () => returnFocus?.isConnected && returnFocus.focus({ preventScroll: true }));
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) close();
  });
  input.addEventListener('input', render);
  dialog.addEventListener('keydown', event => {
    const buttons = [...results.querySelectorAll('button')];
    if (event.key === 'Enter' && event.target === input) {
      event.preventDefault(); buttons[0]?.click();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key) && buttons.length) {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault(); if (dialog.open) close(); else open();
    }
  });
  initTabNavigation();
  // Sharing and model controls are rendered after their data arrives.
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element && (node.matches('[role="tablist"]') || node.querySelector('[role="tablist"]'))) initTabNavigation(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
}

const initializedTablists = new WeakSet();
function initTabNavigation(root = document) {
  const lists = [...(root.matches?.('[role="tablist"]') ? [root] : []), ...root.querySelectorAll('[role="tablist"]')];
  lists.forEach(list => {
    if (initializedTablists.has(list)) return;
    initializedTablists.add(list);
    const attributes = ['settings', 'security', 'images', 'sharing'];
    for (const name of attributes) {
      list.querySelectorAll(`[data-${name}-tab]`).forEach(tab => {
        const panels = [...document.querySelectorAll(`[data-${name}-panel]`)]
          .filter(panel => panel.getAttribute(`data-${name}-panel`) === tab.getAttribute(`data-${name}-tab`));
        if (!tab.id) tab.id = `ui-${name}-tab-${tab.getAttribute(`data-${name}-tab`)}`;
        panels.forEach((panel, index) => {
          if (!panel.id) panel.id = `${tab.id}-panel-${index}`;
          if (panel.tagName === 'SECTION') { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); }
        });
        if (panels.length) tab.setAttribute('aria-controls', panels.map(panel => panel.id).join(' '));
      });
    }
    const tabs = () => [...list.querySelectorAll('[role="tab"]')].filter(tab => !tab.hidden && !tab.disabled && tab.getAttribute('aria-disabled') !== 'true');
    const sync = () => {
      const available = tabs();
      const selected = available.find(tab => tab.getAttribute('aria-selected') === 'true') || available[0];
      list.querySelectorAll('[role="tab"]').forEach(tab => { tab.tabIndex = tab === selected ? 0 : -1; });
      // Settings changes between a vertical rail and a horizontal strip.
      if (list.classList.contains('settings-tabs')) list.setAttribute('aria-orientation', getComputedStyle(list).display === 'flex' ? 'horizontal' : 'vertical');
    };
    sync();
    new MutationObserver(sync).observe(list, { subtree: true, attributes: true, attributeFilter: ['aria-selected', 'hidden', 'disabled', 'aria-disabled'] });
    if (list.classList.contains('settings-tabs') && typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(list);
    list.addEventListener('keydown', event => {
      const available = tabs();
      const current = available.indexOf(event.target);
      if (current < 0) return;
      const vertical = list.getAttribute('aria-orientation') === 'vertical';
      const previous = vertical ? 'ArrowUp' : 'ArrowLeft';
      const next = vertical ? 'ArrowDown' : 'ArrowRight';
      let index;
      if (event.key === previous) index = (current - 1 + available.length) % available.length;
      else if (event.key === next) index = (current + 1) % available.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = available.length - 1;
      else return;
      event.preventDefault();
      // Manual activation: arrow keys explore without triggering network work.
      available.forEach((tab, i) => { tab.tabIndex = i === index ? 0 : -1; });
      available[index].focus({ preventScroll: true });
      available[index].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
  });
}
