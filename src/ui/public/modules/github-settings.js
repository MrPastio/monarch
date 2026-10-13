import { confirmAction } from './ui-dialogs.js';
import { readErrorMessage } from './utils.js';

const emptyStatus = Object.freeze({ connected: false, login: '', repositories: Object.freeze([]),
  permissions: Object.freeze({ read: false, issues: false, pullRequests: false }) });

function isGitHubRepository(value) {
  if (typeof value !== 'string') return false;
  const [owner, name, extra] = value.split('/');
  return extra === undefined
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner || '')
    && /^[A-Za-z0-9_.-]{1,100}$/u.test(name || '')
    && name !== '.' && name !== '..';
}

export function normalizeGitHubStatus(value) {
  if (!value || typeof value !== 'object') return emptyStatus;
  const permissions = value.permissions && typeof value.permissions === 'object' ? value.permissions : {};
  return {
    connected: value.connected === true,
    login: value.connected === true && typeof value.login === 'string' ? value.login.slice(0, 39) : '',
    repositories: Array.isArray(value.repositories) ? value.repositories
      .filter(isGitHubRepository).slice(0, 20) : [],
    permissions: {
      read: permissions.read === true,
      issues: permissions.issues === true,
      pullRequests: permissions.pullRequests === true,
    },
  };
}

export function parseGitHubRepositories(value) {
  const repositories = String(value || '').split(/[\n,]/u).map(item => item.trim()).filter(Boolean);
  if (repositories.length < 1 || repositories.length > 20
    || repositories.some(item => !isGitHubRepository(item))
    || new Set(repositories.map(item => item.toLocaleLowerCase('en-US'))).size !== repositories.length) return null;
  return repositories;
}

export function initGitHubSettings() {
  const panel = document.querySelector('[data-settings-panel="integrations"]');
  const form = document.querySelector('#github-connect-form');
  if (!panel || !form) return;
  const integrations = window.monarchDesktop?.integrations;
  const bridge = integrations ? {
    status: () => integrations.status('github'),
    connect: input => integrations.connect('github', input),
    disconnect: () => integrations.disconnect('github'),
  } : null;
  const state = document.querySelector('#github-connection-state');
  const connected = document.querySelector('#github-connected');
  const account = document.querySelector('#github-account');
  const repositories = document.querySelector('#github-repositories-connected');
  const feedback = document.querySelector('#github-feedback');
  const connectButton = document.querySelector('#github-connect');
  const refreshButton = document.querySelector('#github-refresh');
  const disconnectButton = document.querySelector('#github-disconnect');
  let loading = null;

  const setFeedback = (message = '', error = false) => {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.state = error ? 'error' : message ? 'ready' : 'idle';
  };
  const setBusy = busy => {
    form.closest('.service-card')?.toggleAttribute('aria-busy', busy);
    for (const button of [connectButton, refreshButton, disconnectButton]) if (button) button.disabled = busy;
  };
  const render = raw => {
    const status = normalizeGitHubStatus(raw);
    state.textContent = status.connected ? 'Подключён' : bridge ? 'Не подключён' : 'Только в приложении';
    state.dataset.state = status.connected ? 'ready' : 'attention';
    connected.hidden = !status.connected;
    form.hidden = status.connected;
    account.textContent = status.login ? `@${status.login}` : 'Аккаунт GitHub';
    repositories.textContent = status.repositories.join(', ') || 'Нет разрешённых репозиториев';
    document.querySelectorAll('[data-github-permission]').forEach(element => {
      const enabled = status.permissions[element.dataset.githubPermission] === true;
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
      if (announce) setFeedback(result.connected ? 'Подключение работает.' : 'GitHub пока не подключён.');
      return result;
    }).catch(error => { render(emptyStatus); setFeedback(readErrorMessage(error), true); })
      .finally(() => { loading = null; setBusy(false); });
    return loading;
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!bridge) return;
    const allowedRepositories = parseGitHubRepositories(document.querySelector('#github-repositories')?.value);
    if (!allowedRepositories) {
      setFeedback('Укажи 1–20 уникальных репозиториев, по одному owner/name на строку.', true); return;
    }
    const permissions = {
      read: document.querySelector('#github-scope-read')?.checked === true,
      issues: document.querySelector('#github-scope-issues')?.checked === true,
      pullRequests: document.querySelector('#github-scope-pulls')?.checked === true,
    };
    if (!Object.values(permissions).some(Boolean)) {
      setFeedback('Выбери хотя бы одну возможность GitHub.', true); return;
    }
    const token = document.querySelector('#github-token');
    setBusy(true); setFeedback('Проверяю token и точный список репозиториев…');
    try {
      const status = await bridge.connect({ token: token.value, repositories: allowedRepositories, permissions });
      token.value = '';
      render(status); setFeedback('GitHub подключён. Oscar видит только выбранные репозитории и действия.');
    } catch (error) {
      token.value = ''; setFeedback(readErrorMessage(error), true);
    } finally { setBusy(false); }
  });
  refreshButton?.addEventListener('click', () => void load(true));
  disconnectButton?.addEventListener('click', async () => {
    if (!bridge || !await confirmAction('Отключить GitHub? Локальный token будет удалён, и Oscar потеряет доступ к выбранным репозиториям.')) return;
    setBusy(true); setFeedback('Отключаю GitHub…');
    try { render(await bridge.disconnect()); setFeedback('GitHub отключён.'); }
    catch (error) { setFeedback(readErrorMessage(error), true); }
    finally { setBusy(false); }
  });
  window.addEventListener('monarch:settings-selection', event => {
    if (event.detail?.tab === 'integrations') void load();
  });
  render(emptyStatus);
}
