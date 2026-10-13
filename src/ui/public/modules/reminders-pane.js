// Reminders the person asked Oscar for («напомни через 20 минут …»). The list
// lives at the top of the «Поручения» panel; a reminder that comes due shows a
// Windows notification (Desktop host) and a card in the window.
import { fetchReminders, updateReminder } from './api.js';
import { reducedUiMotion } from './ui-motion.js';
import { escapeHtml, readErrorMessage } from './utils.js';

const elements = {
  panel: document.querySelector('#oscar-missions-panel'),
  list: document.querySelector('#oscar-reminders-list'),
  count: document.querySelector('#oscar-reminders-count'),
};

let reminders = [];
let loading = false;
let toast = null;

export function initReminders() {
  if (!elements.list) return;
  elements.list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reminder-action]');
    if (button) void runReminderAction(button.dataset.reminderId, button.dataset.reminderAction, button);
  });
  // Load whenever the panel opens; it is hidden most of the time.
  if (elements.panel) {
    new MutationObserver(() => {
      if (!elements.panel.hidden) void loadReminders();
    }).observe(elements.panel, { attributes: true, attributeFilter: ['hidden'] });
  }
  const bridge = window.monarchDesktop?.reminders;
  bridge?.onDelivered?.((reminder) => {
    showReminderCard(reminder);
    void loadReminders();
  });
  bridge?.onOpen?.((reminder) => showReminderCard(reminder));
  // A chat answer that set a reminder: ask the host to look sooner than its next tick.
  window.addEventListener('monarch:oscar-turn-settled', () => void bridge?.changed?.().catch(() => undefined));
}

export async function loadReminders() {
  if (loading || !elements.list) return;
  loading = true;
  try {
    reminders = await fetchReminders();
    renderReminders();
  } catch (error) {
    elements.list.innerHTML = `<p class="oscar-reminders-empty">${escapeHtml(readErrorMessage(error))}</p>`;
  } finally {
    loading = false;
  }
}

function renderReminders() {
  const visible = reminders.filter((entry) => entry.status === 'scheduled' || entry.status === 'delivered');
  if (elements.count) elements.count.textContent = visible.length ? String(visible.length) : '';
  if (!visible.length) {
    elements.list.innerHTML = '<p class="oscar-reminders-empty">Попроси Оскара: «напомни через 20 минут проверить духовку» или «напомни завтра в 9:00 позвонить маме».</p>';
    return;
  }
  elements.list.innerHTML = visible.map((entry) => {
    const due = new Date(entry.dueAt);
    const repeat = entry.recurrence === 'daily' ? ' · каждый день' : entry.recurrence === 'weekly' ? ' · каждую неделю' : '';
    const actions = entry.status === 'delivered'
      ? `${actionButton(entry.id, 'done', 'Готово')}${actionButton(entry.id, 'snooze', 'Ещё 10 мин')}`
      : actionButton(entry.id, 'cancel', 'Отменить');
    return `
      <article class="oscar-reminder" role="listitem" data-status="${escapeHtml(entry.status)}">
        <span class="oscar-reminder-dot" aria-hidden="true"></span>
        <div class="oscar-reminder-copy">
          <strong>${escapeHtml(entry.text)}</strong>
          <small>${escapeHtml(entry.status === 'delivered' ? `Было ${describeReminderTime(due)}` : describeReminderTime(due))}${escapeHtml(repeat)}</small>
        </div>
        <div class="oscar-reminder-actions">${actions}</div>
      </article>`;
  }).join('');
}

function actionButton(id, action, label) {
  return `<button type="button" class="claude-ghost-btn" data-reminder-id="${escapeHtml(id)}" data-reminder-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`;
}

async function runReminderAction(id, action, button) {
  if (!id || !action) return;
  if (button) button.disabled = true;
  try {
    await updateReminder(id, action, action === 'snooze' ? { minutes: 10 } : {});
    if (action === 'snooze') void window.monarchDesktop?.reminders?.changed?.().catch(() => undefined);
    await loadReminders();
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.title = readErrorMessage(error);
    }
  }
}

/** One card at a time, arriving from the bottom edge; a new reminder replaces it in place. */
function showReminderCard(reminder) {
  if (!reminder?.id) return;
  if (!toast) {
    toast = document.createElement('section');
    toast.className = 'reminder-toast';
    toast.setAttribute('role', 'alert');
    toast.addEventListener('click', (event) => {
      const button = event.target.closest('[data-reminder-action]');
      if (!button) return;
      if (button.dataset.reminderAction !== 'close') {
        void runReminderAction(button.dataset.reminderId, button.dataset.reminderAction, button);
      }
      hideReminderCard();
    });
    document.body.append(toast);
  }
  toast.innerHTML = `
    <span class="reminder-toast-kicker">Напоминание</span>
    <strong>${escapeHtml(reminder.text)}</strong>
    <div class="reminder-toast-actions">
      <button type="button" class="claude-primary-btn" data-reminder-id="${escapeHtml(reminder.id)}" data-reminder-action="done">Готово</button>
      <button type="button" class="claude-ghost-btn" data-reminder-id="${escapeHtml(reminder.id)}" data-reminder-action="snooze">Ещё 10 мин</button>
      <button type="button" class="claude-ghost-btn" data-reminder-action="close" aria-label="Скрыть">Скрыть</button>
    </div>`;
  if (!toast.hidden && toast.isConnected && toast.dataset.visible === 'true') return;
  toast.hidden = false;
  toast.dataset.visible = 'true';
  if (!reducedUiMotion.matches) {
    toast.getAnimations().forEach((animation) => animation.cancel());
    toast.animate(
      [{ opacity: 0, transform: 'translateY(18px) scale(.97)' }, { opacity: 1, transform: 'none' }],
      { duration: 380, easing: 'cubic-bezier(.16, 1, .3, 1)' },
    );
  }
}

function hideReminderCard() {
  if (!toast || toast.dataset.visible !== 'true') return;
  toast.dataset.visible = 'false';
  if (reducedUiMotion.matches) {
    toast.hidden = true;
    return;
  }
  toast.getAnimations().forEach((animation) => animation.cancel());
  const exit = toast.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(12px) scale(.98)' }],
    { duration: 220, easing: 'cubic-bezier(.4, 0, 1, 1)' },
  );
  exit.onfinish = () => { if (toast.dataset.visible === 'false') toast.hidden = true; };
}

/** «сегодня в 15:30», «завтра в 9:00», «в пятницу в 10:00», «14 октября в 18:00». */
export function describeReminderTime(dueAt, now = new Date()) {
  if (Number.isNaN(dueAt.getTime())) return '';
  const time = dueAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(dueAt) - startOf(now)) / 86_400_000);
  if (days === 0) return `сегодня в ${time}`;
  if (days === 1) return `завтра в ${time}`;
  if (days === -1) return `вчера в ${time}`;
  if (days === 2) return `послезавтра в ${time}`;
  return `${dueAt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${time}`;
}
