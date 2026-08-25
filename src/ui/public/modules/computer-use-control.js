import {
  emergencyStopComputerUse,
  executeCapability,
  updateAutonomyMode,
} from './api.js';
import { readErrorMessage } from './utils.js';

const PERMISSION_PRESETS = Object.freeze({
  ask: 'guided',
  guard: 'workspace-autonomous',
  full: 'full-local',
});

const PRESET_BY_AUTONOMY_MODE = Object.freeze(Object.fromEntries(
  Object.entries(PERMISSION_PRESETS).map(([preset, mode]) => [mode, preset]),
));

let initialized = false;
let busy = false;
let currentState = 'unknown';
let pollTimer = 0;

export function initComputerUseControl() {
  if (initialized) return;
  initialized = true;

  document.querySelector('#computer-use-stop')?.addEventListener('click', () => {
    void stopComputerUse('ui:computer-emergency-stop');
  });
  document.querySelector('#oscar-computer-use-toggle')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLElement) || busy) return;
    button.setAttribute('aria-busy', 'true');
    try {
      await ensureComputerUseReady('ui:oscar-function-menu');
      window.dispatchEvent(new CustomEvent('monarch:computer-use-selected'));
      document.querySelector('#oscar-composer-menu')?.removeAttribute('open');
    } catch {
      // The menu row already exposes the bounded runtime error.
    } finally {
      button.removeAttribute('aria-busy');
    }
  });
  document.querySelectorAll('[data-computer-use-permission]').forEach((button) => {
    button.addEventListener('click', () => {
      void setComputerUsePermissionPreset(button.getAttribute('data-computer-use-permission') || '');
    });
  });
  window.monarchDesktop?.onComputerUseEmergencyStop?.((receipt) => {
    applyComputerUseControlReceipt(receipt?.result);
    setComputerUseControlStatus(receipt?.ok ? 'stopped' : 'error', receipt?.ok
      ? 'Остановлено глобальной клавишей · Ctrl+Alt+Esc'
      : 'Глобальная остановка не подтверждена');
  });

  void refreshComputerUseControl();
  pollTimer = window.setInterval(() => void refreshComputerUseControl(), 5_000);
  window.addEventListener('pagehide', () => window.clearInterval(pollTimer), { once: true });
}

export async function ensureComputerUseReady(requestedBy = 'ui:computer-control') {
  if (currentState === 'ready' || currentState === 'active') return currentState;
  return startComputerUse(requestedBy);
}

export async function startComputerUse(requestedBy = 'ui:computer-control') {
  return changeComputerUseControl('computer.control.start', requestedBy);
}

export async function stopComputerUse(requestedBy = 'ui:computer-emergency-stop') {
  return changeComputerUseControl('computer.control.stop', requestedBy);
}

export async function refreshComputerUseControl() {
  if (busy) return currentState;
  try {
    const payload = await executeCapability(
      'computer',
      'computer.control.status',
      {},
      'ui:computer-control',
      false,
      '',
      { includeState: false },
    );
    return applyComputerUseControlReceipt(payload?.result || payload);
  } catch (error) {
    setComputerUseControlStatus('error', readErrorMessage(error));
    return currentState;
  }
}

export async function setComputerUsePermissionPreset(preset) {
  const autonomyMode = PERMISSION_PRESETS[preset];
  if (!autonomyMode || busy) return null;
  busy = true;
  setPermissionButtonsBusy(true);
  try {
    const profile = await updateAutonomyMode(autonomyMode);
    syncComputerUsePermissionProfile(profile);
    window.dispatchEvent(new CustomEvent('monarch:permission-profile-changed', { detail: profile }));
    return profile;
  } catch (error) {
    setMenuDetail(readErrorMessage(error), true);
    return null;
  } finally {
    busy = false;
    setPermissionButtonsBusy(false);
  }
}

export function syncComputerUsePermissionProfile(profile) {
  const autonomyMode = String(profile?.autonomyMode || (
    profile?.sandboxMode === 'read-only'
      ? 'guided'
      : profile?.sandboxMode === 'danger-full-access' ? 'full-local' : 'workspace-autonomous'
  ));
  const activePreset = PRESET_BY_AUTONOMY_MODE[autonomyMode] || 'guard';
  document.querySelectorAll('[data-computer-use-permission]').forEach((button) => {
    const selected = button.getAttribute('data-computer-use-permission') === activePreset;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
}

async function changeComputerUseControl(capabilityId, requestedBy) {
  if (busy) return currentState;
  busy = true;
  setControlBusy(true);
  try {
    const payload = capabilityId === 'computer.control.stop'
      ? await emergencyStopComputerUse()
      : await executeCapability('computer', capabilityId, {}, requestedBy, false, '', { includeState: false });
    const result = payload?.result || payload;
    if (result?.ok === false) {
      throw new Error(result?.summary || result?.error || 'Kernel не подтвердил Computer Use.');
    }
    return applyComputerUseControlReceipt(result);
  } catch (error) {
    setComputerUseControlStatus('error', readErrorMessage(error));
    throw error;
  } finally {
    busy = false;
    setControlBusy(false);
  }
}

function applyComputerUseControlReceipt(result) {
  const control = result?.output?.control || result?.control || null;
  if (!control) return currentState;
  if (control.enabled === false) {
    setComputerUseControlStatus('stopped', 'Остановлено · Ctrl+Alt+Esc');
  } else if (control.activeLease) {
    setComputerUseControlStatus('active', 'Oscar управляет курсором · Ctrl+Alt+Esc');
  } else {
    setComputerUseControlStatus('ready', 'Курсор Oscar готов · Ctrl+Alt+Esc');
  }
  return currentState;
}

function setComputerUseControlStatus(status, detail) {
  currentState = status;
  const control = document.querySelector('#computer-use-control');
  if (control) {
    control.dataset.state = status;
    control.setAttribute('aria-hidden', String(!['ready', 'active'].includes(status)));
  }
  const title = document.querySelector('#computer-use-control-title');
  if (title) title.textContent = status === 'active' ? 'Oscar Computer Use' : 'Computer Use';
  const detailNode = document.querySelector('#computer-use-control-detail');
  if (detailNode) detailNode.textContent = detail;
  const toggle = document.querySelector('#oscar-computer-use-toggle');
  if (toggle) {
    const enabled = status === 'ready' || status === 'active';
    toggle.classList.toggle('is-active', enabled);
    toggle.setAttribute('aria-pressed', String(enabled));
  }
  const stateNode = document.querySelector('#oscar-computer-use-menu-state');
  if (stateNode) {
    stateNode.textContent = status === 'active'
      ? 'В работе'
      : status === 'ready' ? 'Готов' : status === 'error' ? 'Ошибка' : 'Включить';
  }
  setMenuDetail(detail, status === 'error');
}

function setMenuDetail(detail, error = false) {
  const node = document.querySelector('#oscar-computer-use-menu-detail');
  if (!node) return;
  node.textContent = detail;
  node.classList.toggle('error-text', error);
}

function setControlBusy(value) {
  document.querySelector('#computer-use-stop')?.toggleAttribute('aria-busy', value);
  document.querySelector('#oscar-computer-use-toggle')?.toggleAttribute('aria-busy', value);
}

function setPermissionButtonsBusy(value) {
  document.querySelectorAll('[data-computer-use-permission]').forEach((button) => {
    button.toggleAttribute('aria-busy', value);
    button.toggleAttribute('disabled', value);
  });
}
