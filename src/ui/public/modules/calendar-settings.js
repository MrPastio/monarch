import { confirmAction } from './ui-dialogs.js';
import { readErrorMessage } from './utils.js';

const emptyStatus = Object.freeze({ connected: false, account: '', calendarName: '',
  permissions: Object.freeze({ read: false, manage: false }) });

export function normalizeCalendarStatus(value) {
  if (!value || typeof value !== 'object') return emptyStatus;
  const permissions = value.permissions && typeof value.permissions === 'object' ? value.permissions : {};
  return {
    connected: value.connected === true,
    account: value.connected === true && typeof value.account === 'string' ? value.account.slice(0, 320) : '',
    calendarName: value.connected === true && typeof value.calendarName === 'string' ? value.calendarName.slice(0, 512) : '',
    permissions: { read: permissions.read === true, manage: permissions.manage === true },
  };
}

export function initCalendarSettings() {
  const form = document.querySelector('#calendar-connect-form');
  if (!form) return;
  const integrations = window.monarchDesktop?.integrations;
  const bridge = integrations ? {
    status: () => integrations.status('calendar'),
    connect: input => integrations.connect('calendar', input),
    disconnect: () => integrations.disconnect('calendar'),
  } : null;
  const card = form.closest('.service-card');
  const state = document.querySelector('#calendar-connection-state');
  const connected = document.querySelector('#calendar-connected');
  const account = document.querySelector('#calendar-account');
  const calendarName = document.querySelector('#calendar-name');
  const feedback = document.querySelector('#calendar-feedback');
  const connectButton = document.querySelector('#calendar-connect');
  const refreshButton = document.querySelector('#calendar-refresh');
  const disconnectButton = document.querySelector('#calendar-disconnect');
  let loading = null;

  const setFeedback = (message = '', error = false) => {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.state = error ? 'error' : message ? 'ready' : 'idle';
  };
  const setBusy = busy => {
    card?.toggleAttribute('aria-busy', busy);
    for (const button of [connectButton, refreshButton, disconnectButton]) if (button) button.disabled = busy;
  };
  const render = raw => {
    const status = normalizeCalendarStatus(raw);
    state.textContent = status.connected ? 'Подключён' : bridge ? 'Не подключён' : 'Только в приложении';
    state.dataset.state = status.connected ? 'ready' : 'attention';
    connected.hidden = !status.connected;
    form.hidden = status.connected;
    account.textContent = status.account || 'Аккаунт Google';
    calendarName.textContent = status.calendarName || 'Основной календарь';
    document.querySelectorAll('[data-calendar-permission]').forEach(element => {
      const enabled = status.permissions[element.dataset.calendarPermission] === true;
      element.dataset.enabled = String(enabled);
      element.setAttribute('aria-disabled', String(!enabled));
    });
    if (!bridge) {
      for (const field of form.elements) field.disabled = true;
      setFeedback('Подключение доступно в приложении Monarch Desktop.', true);
    }
    return status;
  };
  const load = (announce = false) => {
    if (!bridge) return Promise.resolve(render(emptyStatus));
    if (loading) return loading;
    setBusy(true);
    loading = bridge.status().then(status => {
      const result = render(status);
      if (announce) setFeedback(result.connected ? 'Подключение работает.' : 'Google Calendar пока не подключён.');
      return result;
    }).catch(error => { render(emptyStatus); setFeedback(readErrorMessage(error), true); })
      .finally(() => { loading = null; setBusy(false); });
    return loading;
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!bridge) return;
    const permissions = {
      read: document.querySelector('#calendar-scope-read')?.checked === true,
      manage: document.querySelector('#calendar-scope-manage')?.checked === true,
    };
    if (!Object.values(permissions).some(Boolean)) {
      setFeedback('Выбери хотя бы одну возможность Google Calendar.', true);
      return;
    }
    const clientId = document.querySelector('#calendar-client-id');
    const clientSecret = document.querySelector('#calendar-client-secret');
    setBusy(true);
    setFeedback('Открыл отдельное разрешение Calendar в системном браузере…');
    try {
      const status = await bridge.connect({ clientId: clientId.value.trim(), clientSecret: clientSecret.value, permissions });
      clientId.value = '';
      clientSecret.value = '';
      render(status);
      setFeedback('Google Calendar подключён. Oscar видит только выбранные действия.');
    } catch (error) {
      clientSecret.value = '';
      setFeedback(readErrorMessage(error), true);
    } finally { setBusy(false); }
  });
  refreshButton?.addEventListener('click', () => void load(true));
  disconnectButton?.addEventListener('click', async () => {
    if (!bridge || !await confirmAction('Отключить Google Calendar? Отдельный локальный refresh token будет удалён.')) return;
    setBusy(true);
    setFeedback('Отключаю Google Calendar…');
    try { render(await bridge.disconnect()); setFeedback('Google Calendar отключён.'); }
    catch (error) { setFeedback(readErrorMessage(error), true); }
    finally { setBusy(false); }
  });
  window.addEventListener('monarch:settings-selection', event => {
    if (event.detail?.tab === 'integrations') void load();
  });
  render(emptyStatus);
}
