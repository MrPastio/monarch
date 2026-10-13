// Settings → Services and → System: one card / group at a time. The cards stay in the DOM
// (their forms and status polling are owned by the per-service modules); this
// only adds a tab row and marks the card in front. Designs that do not style
// the row keep showing every card.
const SECTION = '.service-settings';

export function initServiceSwitcher() {
  initServiceCards();
  initSystemGroups();
}

function initServiceCards() {
  const section = document.querySelector(SECTION);
  if (!section || section.querySelector('.service-switcher')) return;
  const cards = [...section.querySelectorAll(':scope > .service-card')];
  if (cards.length < 2) return;

  const tabs = document.createElement('div');
  tabs.className = 'service-switcher';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Сервисы');
  const buttons = cards.map((card, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.textContent = card.querySelector('.service-card-heading strong')?.textContent.trim() || 'Сервис ' + (index + 1);
    button.addEventListener('click', () => select(index));
    return button;
  });

  const select = index => {
    cards.forEach((card, position) => {
      if (position === index) card.setAttribute('data-service-active', '');
      else card.removeAttribute('data-service-active');
    });
    buttons.forEach((button, position) => {
      button.setAttribute('aria-selected', String(position === index));
      button.tabIndex = position === index ? 0 : -1;
    });
  };
  tabs.addEventListener('keydown', event => {
    const current = buttons.findIndex(button => button.getAttribute('aria-selected') === 'true');
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (current + step + buttons.length) % buttons.length;
    select(next);
    buttons[next].focus();
  });

  tabs.append(...buttons);
  cards[0].before(tabs);
  section.setAttribute('data-service-tabs', '');
  select(0);
}

const SYSTEM_LABELS = [
  ['settings-appearance', 'Внешний вид'],
  ['monarch-update-panel', 'Обновления'],
  ['monarch-help-panel', 'Если что-то не работает'],
  ['monarch-docs-panel', 'Документация'],
  ['system-map-panel', 'Карта системы'],
];

/** System has four unrelated groups; the row shows one, the rest stay in the DOM. */
function initSystemGroups() {
  const groups = [...document.querySelectorAll('[data-settings-panel="system"]')]
    .filter(group => !group.classList.contains('legacy-system-diagnostics') && !group.classList.contains('service-switcher'));
  if (groups.length < 3 || document.querySelector('.system-switcher')) return;
  const stack = groups[0].parentElement;

  const tabs = document.createElement('div');
  tabs.className = 'service-switcher system-switcher';
  tabs.setAttribute('data-settings-panel', 'system');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Разделы системы');
  const buttons = groups.map((group, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.textContent = SYSTEM_LABELS.find(([name]) => group.classList.contains(name))?.[1] || 'Диагностика';
    button.addEventListener('click', () => select(index));
    return button;
  });
  const select = index => {
    groups.forEach((group, position) => {
      if (position === index) group.setAttribute('data-system-active', '');
      else group.removeAttribute('data-system-active');
    });
    buttons.forEach((button, position) => {
      button.setAttribute('aria-selected', String(position === index));
      button.tabIndex = position === index ? 0 : -1;
    });
  };
  tabs.addEventListener('keydown', event => {
    const current = buttons.findIndex(button => button.getAttribute('aria-selected') === 'true');
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (current + step + buttons.length) % buttons.length;
    select(next);
    buttons[next].focus();
  });
  tabs.append(...buttons);
  groups[0].before(tabs);
  stack.setAttribute('data-system-tabs', '');
  select(0);
}
