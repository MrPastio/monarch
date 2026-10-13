// Settings -> System -> "Если что-то не работает": common problems, each with
// one action that actually repairs or checks it. No action pretends to fix
// something it cannot: a check reports what it found.
export const HELP_ITEMS = Object.freeze([
  { id: 'oscar', problem: 'Оскар молчит или отвечает ошибкой', hint: 'Проверю связь с Оскаром и моделью.', action: 'Проверить Оскара' },
  { id: 'models', problem: 'Модель не загружается или отвечает медленно', hint: 'На странице моделей видно, готова ли модель и хватает ли памяти.', action: 'Открыть модели' },
  { id: 'security', problem: 'Безопасность пишет «недоступно»', hint: 'Открою Security и заново проверю состояние.', action: 'Проверить защиту' },
  { id: 'access', problem: 'Оскар спрашивает слишком часто или не делает нужное', hint: 'Режим самостоятельности решает, что он делает сам.', action: 'Открыть доступ' },
  { id: 'logs', problem: 'Нужно разобраться в ошибке', hint: 'Журналы Monarch лежат в отдельной папке. Их можно приложить к сообщению об ошибке.', action: 'Открыть журналы', desktopOnly: true },
]);

export function renderHelpPanel(items, { desktop = false } = {}, escapeHtml) {
  return `<ul class="help-list">${items.filter(item => desktop || !item.desktopOnly).map(item => (
    `<li><div><strong>${escapeHtml(item.problem)}</strong><small>${escapeHtml(item.hint)}</small><output data-help-result="${item.id}" aria-live="polite"></output></div>
      <button type="button" class="claude-secondary-btn" data-help-action="${item.id}">${escapeHtml(item.action)}</button></li>`
  )).join('')}</ul>`;
}

export function initHelpPanel(container, { escapeHtml, navigate, checkOscar, openLogs }) {
  if (!container) return;
  container.innerHTML = renderHelpPanel(HELP_ITEMS, { desktop: typeof openLogs === 'function' }, escapeHtml);
  container.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-help-action]');
    if (!button || button.disabled) return;
    const id = button.getAttribute('data-help-action');
    const result = container.querySelector(`[data-help-result="${id}"]`);
    const say = text => { if (result) result.textContent = text; };
    button.disabled = true;
    try {
      if (id === 'oscar') say(await checkOscar() ? 'Оскар на связи.' : 'Оскар не отвечает. Открой «Модели» и проверь, запущена ли модель.');
      else if (id === 'models') navigate('settings-section', 'models');
      else if (id === 'security') navigate('security-section');
      else if (id === 'access') navigate('settings-section', 'access');
      else if (id === 'logs') say((await openLogs())?.ok ? 'Папка журналов открыта.' : 'Не удалось открыть папку журналов.');
    } catch {
      say('Проверка не удалась. Попробуй ещё раз.');
    } finally {
      button.disabled = false;
    }
  });
}
