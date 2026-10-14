// Settings -> System -> "Если что-то не работает": common problems, each with
// one action that actually repairs or checks it. No action pretends to fix
// something it cannot: a check reports what it found.
export const HELP_ITEMS = Object.freeze([
  { id: 'oscar', problem: 'Оскар молчит или отвечает ошибкой', hint: 'Проверю связь с Оскаром и моделью.', action: 'Проверить Оскара' },
  { id: 'models', problem: 'Модель не загружается или отвечает медленно', hint: 'На странице моделей видно, готова ли модель и хватает ли памяти.', action: 'Открыть модели' },
  { id: 'security', problem: 'Безопасность пишет «недоступно»', hint: 'Открою Security и заново проверю состояние.', action: 'Проверить защиту' },
  { id: 'access', problem: 'Оскар спрашивает слишком часто или не делает нужное', hint: 'Режим самостоятельности решает, что он делает сам.', action: 'Открыть доступ' },
  { id: 'logs', problem: 'Нужно разобраться в ошибке', hint: 'Журналы Monarch лежат в отдельной папке. Их можно приложить к сообщению об ошибке.', action: 'Открыть журналы', desktopOnly: true },
  { id: 'report', problem: 'Нашёл ошибку', hint: 'Опиши, что случилось, — откроется письмо разработчику. Отправишь его сам.', action: 'Сообщить об ошибке', desktopOnly: true },
]);

/** The letter form under the list: the person's words, then the mail program opens it. */
export function renderBugReportForm(escapeHtml) {
  return `<form class="bug-report-form" data-bug-report hidden>
    <label for="bug-report-text"><strong>Что случилось?</strong><small>Что ты делал, что ожидал и что получилось вместо этого.</small></label>
    <textarea id="bug-report-text" rows="5" maxlength="1200" required placeholder="Например: открыл «Модели», нажал «Скачать», и страница начала дёргаться"></textarea>
    <small class="bug-report-disclosure">${escapeHtml('В письмо добавятся версия Monarch, Windows, объём памяти и состояние моделей. Переписки, ключей и файлов в нём нет. Журналы можно приложить вручную — кнопка «Открыть журналы» выше.')}</small>
    <div class="bug-report-actions">
      <button type="submit" class="claude-primary-btn" data-bug-report-via="mail">Открыть письмо</button>
      <button type="button" class="claude-secondary-btn" data-bug-report-via="gmail">Через Gmail в браузере</button>
      <button type="button" class="model-remove-action" data-bug-report-cancel>Отмена</button>
    </div>
    <output aria-live="polite" data-bug-report-result></output>
    <textarea class="bug-report-copy" data-bug-report-copy readonly hidden aria-label="Текст письма"></textarea>
  </form>`;
}

export function renderHelpPanel(items, { desktop = false } = {}, escapeHtml) {
  return `<ul class="help-list">${items.filter(item => desktop || !item.desktopOnly).map(item => (
    `<li><div><strong>${escapeHtml(item.problem)}</strong><small>${escapeHtml(item.hint)}</small><output data-help-result="${item.id}" aria-live="polite"></output></div>
      <button type="button" class="claude-secondary-btn" data-help-action="${item.id}">${escapeHtml(item.action)}</button></li>`
  )).join('')}</ul>`;
}

export function initHelpPanel(container, { escapeHtml, navigate, checkOscar, openLogs, reportBug, reportContext, reducedMotion }) {
  if (!container) return;
  const desktop = typeof openLogs === 'function';
  const items = HELP_ITEMS.filter(item => item.id !== 'report' || typeof reportBug === 'function');
  container.innerHTML = renderHelpPanel(items, { desktop }, escapeHtml)
    + (typeof reportBug === 'function' ? renderBugReportForm(escapeHtml) : '');
  const form = container.querySelector('[data-bug-report]');
  const showForm = (open) => {
    if (!form || form.hidden === !open) return;
    form.hidden = !open;
    if (open) {
      if (!reducedMotion?.matches && typeof form.animate === 'function') {
        form.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      }
      form.querySelector('textarea')?.focus({ preventScroll: false });
    }
  };
  const sendReport = async (via) => {
    const text = form.querySelector('#bug-report-text');
    const result = form.querySelector('[data-bug-report-result]');
    const copy = form.querySelector('[data-bug-report-copy]');
    if (!text.value.trim()) { text.focus(); result.textContent = 'Напиши пару слов о том, что случилось.'; return; }
    for (const button of form.querySelectorAll('button')) button.disabled = true;
    try {
      const reply = await reportBug({ description: text.value, context: reportContext?.() || '', via });
      if (reply?.ok) {
        result.textContent = via === 'gmail'
          ? 'Gmail открыт в браузере. Проверь письмо и нажми «Отправить».'
          : 'Письмо открыто в почте. Проверь его и нажми «Отправить». Если ничего не открылось — попробуй «Через Gmail».';
        copy.hidden = true;
      } else {
        result.textContent = 'Не получилось открыть почту. Скопируй текст ниже и отправь на mrpastio@gmail.com.';
        if (reply?.text) { copy.value = reply.text; copy.hidden = false; copy.select(); }
      }
    } catch {
      result.textContent = 'Не получилось открыть почту. Напиши на mrpastio@gmail.com.';
    } finally {
      for (const button of form.querySelectorAll('button')) button.disabled = false;
    }
  };
  form?.addEventListener('submit', (event) => { event.preventDefault(); void sendReport('mail'); });
  form?.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-bug-report-via="gmail"]')) void sendReport('gmail');
    else if (event.target.closest?.('[data-bug-report-cancel]')) showForm(false);
  });
  container.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-help-action]');
    if (!button || button.disabled) return;
    const id = button.getAttribute('data-help-action');
    if (id === 'report') { showForm(form?.hidden !== false); return; }
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
