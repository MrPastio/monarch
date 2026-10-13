import { confirmAction } from './ui-dialogs.js';
import { readErrorMessage } from './utils.js';

const emptyStatus = Object.freeze({ connected: false, email: '',
  permissions: Object.freeze({ search: false, read: false, compose: false }) });

export function normalizeGmailStatus(value) {
  if (!value || typeof value !== 'object') return emptyStatus;
  const permissions = value.permissions && typeof value.permissions === 'object' ? value.permissions : {};
  return {
    connected: value.connected === true,
    email: value.connected === true && typeof value.email === 'string' ? value.email.slice(0, 320) : '',
    permissions: {
      search: permissions.search === true,
      read: permissions.read === true,
      compose: permissions.compose === true,
    },
  };
}

export function initGmailSettings() {
  const panel = document.querySelector('[data-settings-panel="integrations"]');
  const form = document.querySelector('#gmail-connect-form');
  if (!panel || !form) return;
  const integrations = window.monarchDesktop?.integrations;
  const bridge = integrations ? {
    status: () => integrations.status('gmail'),
    connect: input => integrations.connect('gmail', input),
    disconnect: () => integrations.disconnect('gmail'),
  } : null;
  const state = document.querySelector('#gmail-connection-state');
  const connected = document.querySelector('#gmail-connected');
  const account = document.querySelector('#gmail-account');
  const feedback = document.querySelector('#gmail-feedback');
  const connectButton = document.querySelector('#gmail-connect');
  const refreshButton = document.querySelector('#gmail-refresh');
  const disconnectButton = document.querySelector('#gmail-disconnect');
  let loading = null;

  const setFeedback = (message = '', error = false) => {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.state = error ? 'error' : message ? 'ready' : 'idle';
  };
  const setBusy = busy => {
    panel.toggleAttribute('aria-busy', busy);
    for (const button of [connectButton, refreshButton, disconnectButton]) if (button) button.disabled = busy;
  };
  const render = raw => {
    const status = normalizeGmailStatus(raw);
    state.textContent = status.connected ? 'Подключён' : bridge ? 'Не подключён' : 'Только в приложении';
    state.dataset.state = status.connected ? 'ready' : 'attention';
    connected.hidden = !status.connected;
    form.hidden = status.connected;
    account.textContent = status.email || 'Аккаунт Google';
    document.querySelectorAll('[data-gmail-permission]').forEach(element => {
      const enabled = status.permissions[element.dataset.gmailPermission] === true;
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
      if (announce) setFeedback(result.connected ? 'Подключение работает.' : 'Gmail пока не подключён.');
      return result;
    }).catch(error => {
      render(emptyStatus); setFeedback(readErrorMessage(error), true);
    }).finally(() => { loading = null; setBusy(false); });
    return loading;
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!bridge) return;
    const permissions = {
      search: document.querySelector('#gmail-scope-search')?.checked === true,
      read: document.querySelector('#gmail-scope-read')?.checked === true,
      compose: document.querySelector('#gmail-scope-compose')?.checked === true,
    };
    if (!Object.values(permissions).some(Boolean)) {
      setFeedback('Выбери хотя бы одну возможность Gmail.', true); return;
    }
    const clientId = document.querySelector('#gmail-client-id');
    const clientSecret = document.querySelector('#gmail-client-secret');
    setBusy(true); setFeedback('Открыл вход Google в системном браузере…');
    try {
      const status = await bridge.connect({ clientId: clientId.value.trim(), clientSecret: clientSecret.value, permissions });
      clientId.value = ''; clientSecret.value = '';
      render(status); setFeedback('Gmail подключён. Oscar уже видит разрешённые возможности.');
    } catch (error) {
      clientSecret.value = ''; setFeedback(readErrorMessage(error), true);
    } finally { setBusy(false); }
  });
  refreshButton?.addEventListener('click', () => void load(true));
  disconnectButton?.addEventListener('click', async () => {
    if (!bridge || !await confirmAction('Отключить Gmail? Локальный refresh token будет удалён, и Oscar потеряет доступ к почте.')) return;
    setBusy(true); setFeedback('Отключаю Gmail…');
    try { render(await bridge.disconnect()); setFeedback('Gmail отключён.'); }
    catch (error) { setFeedback(readErrorMessage(error), true); }
    finally { setBusy(false); }
  });
  window.addEventListener('monarch:settings-selection', event => {
    if (event.detail?.tab === 'integrations') void load();
  });
  render(emptyStatus);
}
