import { fetchState, saveModelPreference } from './api.js';
import { state, updateState } from './state.js';
import { syncDesignCards } from './paper-pixel.js';
import { changeDesignWithReveal, changeThemeWithReveal } from './theme-transition.js';
import { readErrorMessage } from './utils.js';

/* Small Settings pieces that sit on existing owners: design and theme cards
   (the preference owner in app.js), "run first setup again" (model-onboarding.js)
   and the MAX → local fallback switch (the host's model preference). */

let initialized = false;
const LIMIT_SELECTS = [['#max-output-select', 'maxOutputTokens'], ['#max-context-select', 'maxContextTokens']];

export function initSettingsExtras() {
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const designCard = target?.closest('[data-design-card]');
    if (designCard) { void changeDesignWithReveal(designCard.dataset.designCard, designCard); return; }
    const card = target?.closest('[data-theme-card]');
    if (card) { void changeThemeWithReveal(card.dataset.themeCard, card); return; }
    const autoChoice = target?.closest('[data-auto-theme-choice] [data-auto-theme]');
    if (autoChoice) { void changeThemeWithReveal(autoChoice.dataset.autoTheme, autoChoice, 'autoTheme'); return; }
    const setup = target?.closest('[data-open-setup]');
    if (setup) window.dispatchEvent(new CustomEvent('monarch:open-setup', { detail: { opener: setup } }));
  });
  window.addEventListener('monarch:ui-preferences-applied', syncThemeCards);
  const fallback = document.querySelector('#max-fallback-input');
  fallback?.addEventListener('change', () => void saveFallback(fallback));
  for (const [selector, key] of LIMIT_SELECTS) {
    const select = document.querySelector(selector);
    select?.addEventListener('change', () => void saveLimit(select, key));
  }
  syncThemeCards();
}

export function renderSettingsExtras() {
  syncThemeCards();
  syncFallback();
  syncLimits();
}

function syncThemeCards() {
  syncDesignCards();
  const root = document.documentElement;
  const theme = root.dataset.themePreference || (root.dataset.theme === 'dark' ? 'dark' : 'light');
  const autoTheme = root.dataset.autoTheme === 'time' ? 'time' : 'system';
  document.querySelectorAll('[data-theme-card]').forEach((card) => {
    const checked = card.dataset.themeCard === theme;
    card.setAttribute('aria-checked', String(checked));
    card.tabIndex = checked ? 0 : -1;
  });
  document.querySelectorAll('[data-auto-theme-choice]').forEach((group) => { group.hidden = theme !== 'auto'; });
  document.querySelectorAll('[data-auto-theme-choice] [data-auto-theme]').forEach((choice) => {
    const checked = choice.dataset.autoTheme === autoTheme;
    choice.setAttribute('aria-checked', String(checked));
    choice.tabIndex = checked ? 0 : -1;
  });
}

function syncFallback() {
  const input = document.querySelector('#max-fallback-input');
  const copy = document.querySelector('[data-max-fallback-copy]');
  if (!input || !copy || input.dataset.saving === 'true') return;
  const preference = state.data?.modelPreference;
  if (!preference) return;
  input.checked = preference.maxLocalFallback !== false && preference.work !== 'max';
  const models = Array.isArray(state.data?.components?.models) ? state.data.components.models : [];
  const localReady = models.some((model) => model.installed);
  copy.textContent = preference.work === 'max'
    ? 'Сейчас выбран режим «только MAX». Включи — и если MAX не ответит, ответит модель на компьютере.'
    : !localReady
      ? 'Для подстраховки нужна скачанная модель — её можно скачать выше, в разделе «Модели».'
      : 'Если MAX не ответит, ответит локальная модель. Запрос в MAX повторно не отправляется, а ответ будет помечен.';
}

async function saveFallback(input) {
  const enabled = input.checked;
  const preference = state.data?.modelPreference || {};
  input.dataset.saving = 'true';
  try {
    // Turning the safety net on in MAX-only mode also allows local work.
    const patch = enabled && preference.work === 'max'
      ? { work: 'hybrid', maxLocalFallback: true }
      : { maxLocalFallback: enabled };
    const saved = await saveModelPreference(patch);
    if (state.data) state.data.modelPreference = saved;
  } catch (error) {
    input.checked = !enabled;
    const copy = document.querySelector('[data-max-fallback-copy]');
    if (copy) copy.textContent = readErrorMessage(error);
  } finally {
    delete input.dataset.saving;
    syncFallback();
    void fetchState().then(updateState).catch(() => undefined);
  }
}

function syncLimits() {
  const preference = state.data?.modelPreference;
  if (!preference) return;
  for (const [selector, key] of LIMIT_SELECTS) {
    const select = document.querySelector(selector);
    if (select && select.dataset.saving !== 'true') select.value = typeof preference[key] === 'number' ? String(preference[key]) : '';
  }
}

async function saveLimit(select, key) {
  select.dataset.saving = 'true';
  const copy = document.querySelector('[data-max-limits-copy]');
  try {
    const saved = await saveModelPreference({ [key]: select.value ? Number(select.value) : null });
    if (state.data) state.data.modelPreference = saved;
  } catch (error) {
    if (copy) copy.textContent = readErrorMessage(error);
  } finally {
    delete select.dataset.saving;
    syncLimits();
    void fetchState().then(updateState).catch(() => undefined);
  }
}
