export const MONARCH_BRAND_STAGES = Object.freeze([
  'Monarch',
  'Mark',
  'F1 Core',
  'Astra',
  'Зачем?',
  'Уже все',
  'Хватит',
]);

export const MONARCH_BRAND_CLICKS_PER_STAGE = 5;

const INSTALL_KEY = '__monarchBrandEasterEgg';

export function advanceMonarchBrandClick(state = {}, clicksPerStage = MONARCH_BRAND_CLICKS_PER_STAGE) {
  const stageIndex = normalizeStageIndex(state.stageIndex);
  const clickCount = Math.max(0, Number(state.clickCount) || 0) + 1;
  if (clickCount < clicksPerStage) {
    return { stageIndex, clickCount, changed: false };
  }
  return {
    stageIndex: (stageIndex + 1) % MONARCH_BRAND_STAGES.length,
    clickCount: 0,
    changed: true,
  };
}

export function installMonarchBrandEasterEgg(options = {}) {
  const documentObject = options.documentObject || globalThis.document;
  if (!documentObject?.querySelector) return null;
  if (documentObject[INSTALL_KEY]) return documentObject[INSTALL_KEY];

  const root = documentObject.querySelector(options.selector || '[data-monarch-brand-cycle]');
  const label = root?.querySelector('[data-monarch-brand-label]');
  if (!root || !label) return null;

  let state = { stageIndex: 0, clickCount: 0 };

  const onClick = () => {
    state = advanceMonarchBrandClick(state);
    if (!state.changed) return;
    const nextLabel = MONARCH_BRAND_STAGES[state.stageIndex];
    label.textContent = nextLabel;
    root.setAttribute('aria-label', nextLabel);
    root.dataset.brandStage = String(state.stageIndex);
    label.classList.remove('is-changing');
    void label.offsetWidth;
    label.classList.add('is-changing');
  };

  root.addEventListener('click', onClick);
  const controller = {
    getState: () => ({ ...state }),
    destroy() {
      root.removeEventListener('click', onClick);
      delete documentObject[INSTALL_KEY];
    },
  };
  documentObject[INSTALL_KEY] = controller;
  return controller;
}

function normalizeStageIndex(value) {
  const index = Number(value);
  if (!Number.isInteger(index)) return 0;
  return ((index % MONARCH_BRAND_STAGES.length) + MONARCH_BRAND_STAGES.length) % MONARCH_BRAND_STAGES.length;
}
