import { acknowledgeModelOnboardingWelcome } from './api.js';
import { state } from './state.js';

const MODEL_WELCOME_BRAND_MS = 4_200;
const MODEL_WELCOME_MESSAGE_MS = 5_000;
const MODEL_WELCOME_STORAGE_KEY = 'monarch.model-setup-welcome.v1';

const elements = {
  root: document.querySelector('#model-setup-welcome'),
  shell: document.querySelector('#app-shell'),
};

let initialized = false;
let resolved = false;
let presenting = false;
let finishTimer = 0;

export function initModelSetupWelcome() {
  if (initialized) return;
  initialized = true;
  elements.root?.addEventListener('click', finishWelcome);
  elements.root?.addEventListener('keydown', (event) => {
    if (!['Enter', ' ', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    finishWelcome();
  });
}

export function renderModelSetupWelcome() {
  const onboarding = state.data?.components?.schemaVersion === 2
    ? state.data.components.onboarding
    : null;
  if (resolved || presenting || onboarding?.welcomeRequired !== true || !elements.root) return;

  if (onboarding.welcomeToken && readLocalReceipt() === onboarding.welcomeToken) {
    resolved = true;
    void acknowledgeModelOnboardingWelcome().catch(() => undefined);
    return;
  }

  presenting = true;
  writeLocalReceipt(onboarding.welcomeToken);
  void acknowledgeModelOnboardingWelcome().catch(() => undefined);
  elements.root.hidden = false;
  elements.root.tabIndex = 0;
  elements.shell?.setAttribute('inert', '');
  document.body.classList.add('model-setup-welcome-open');
  window.requestAnimationFrame(() => elements.root?.classList.add('is-running'));

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const brandDuration = reducedMotion ? 260 : MODEL_WELCOME_BRAND_MS;
  finishTimer = window.setTimeout(finishWelcome, brandDuration + MODEL_WELCOME_MESSAGE_MS);
  elements.root.focus({ preventScroll: true });
}

function finishWelcome() {
  if (!presenting || !elements.root) return;
  presenting = false;
  resolved = true;
  if (finishTimer) window.clearTimeout(finishTimer);
  finishTimer = 0;
  elements.root.classList.add('is-exiting');
  window.setTimeout(() => {
    if (!elements.root) return;
    elements.root.hidden = true;
    elements.root.classList.remove('is-running', 'is-exiting');
    document.body.classList.remove('model-setup-welcome-open');
    const onboardingRequired = state.data?.components?.schemaVersion === 2
      && state.data.components.onboarding?.required === true;
    if (!onboardingRequired) elements.shell?.removeAttribute('inert');
  }, window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 80 : 520);
}

function readLocalReceipt() {
  try {
    return localStorage.getItem(MODEL_WELCOME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocalReceipt(token) {
  if (!token) return;
  try {
    localStorage.setItem(MODEL_WELCOME_STORAGE_KEY, token);
  } catch {
    // The persisted runtime receipt remains authoritative when storage is unavailable.
  }
}
