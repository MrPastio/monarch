import { reducedUiMotion } from './ui-motion.js';
import { initMaxModelPicker } from './max-model-picker.js';
import { maxNetworkVisual } from './max-identity.js';
import { decideMaxMemoryConsent, fetchMaxMemoryConsent } from './api.js';
const VIEW_STATES = new Set(['off', 'ready', 'not-configured', 'corrupt', 'unavailable']);
const MODEL_CHOICES = new Set(['gpt-oss-120b']);
// Known local assets only; provider names remain the accessible label.
const PROVIDER_LOGOS = ['groq', 'openai', 'anthropic', 'gemini', 'openrouter', 'deepseek', 'mistral', 'xai', 'together', 'fireworks', 'cerebras', 'nvidia'];

export function normalizeAstraMaxSetupView(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const state = VIEW_STATES.has(source.state) ? source.state : 'unavailable';
  const models = Array.isArray(source.models) ? source.models
    .filter(model => model && typeof model === 'object'
      && MODEL_CHOICES.has(model.id)
      && typeof model.label === 'string' && model.label.length > 0 && model.label.length <= 80)
    .slice(0, 3)
    .map(model => ({ id: model.id, label: model.label,
      detail: typeof model.detail === 'string' ? model.detail.slice(0, 120) : '',
      preview: false })) : [];
  const connectionVerified = state === 'ready' && source.connectionVerified === true;
  return Object.freeze({
    available: source.available === true,
    state,
    connectionVerified,
    title: state === 'ready' ? connectionVerified ? 'MAX готов' : 'Ключ MAX сохранён'
      : text(source.title, 'MAX временно недоступен'),
    detail: state === 'ready' ? connectionVerified
      ? 'Подключение проверено. MAX можно использовать для новых задач.' : 'Доступ проверится при первой задаче.'
      : text(source.detail, 'Попробуй ещё раз.'),
    nextAction: ['none', 'connect', 'reconnect', 'retry'].includes(source.nextAction) ? source.nextAction : 'retry',
    models,
  });
}

export function validAstraMaxSetupInput(apiKey, acknowledgements) {
  return typeof apiKey === 'string' && /^[\x21-\x7e]{20,512}$/u.test(apiKey.trim())
    && acknowledgements?.nonLocalProcessing === true
    && acknowledgements?.selectedContext === true
    && acknowledgements?.providerTerms === true;
}

export function initAstraMaxSetup() {
  const entry = document.querySelector('[data-astra-max-open]');
  const form = document.querySelector('#astra-max-setup-form');
  const grid = document.querySelector('[data-max-providers]');
  const editorDialog = document.querySelector('#max-connection-dialog');
  if (!entry || !form || !grid || !editorDialog) return null;
  document.querySelectorAll('[data-max-network]').forEach(node => { node.innerHTML = maxNetworkVisual; });
  const bridge = window.monarchDesktop?.astraMax;
  const byId = id => document.getElementById(id);
  const key = byId('astra-max-key'), model = byId('max-provider-model');
  const modelPicker = initMaxModelPicker(model);
  const loadModels = byId('max-models-load'), modelsHint = byId('max-models-hint');
  let catalogRequest = 0, catalogLoading = false;
  const checks = { nonLocalProcessing: byId('astra-max-cloud-check'), selectedContext: byId('astra-max-context-check'), providerTerms: byId('astra-max-terms-check') };
  const next = byId('astra-max-next'), connect = byId('astra-max-connect');
  const saveModel = byId('max-model-save');
  const connectCopy = form.querySelector('[data-max-connect-copy]');
  const modelCopy = form.querySelector('[data-max-model-copy]');
  const keyStorage = form.querySelector('.max-key-storage');
  const pickStep = form.querySelector('[data-max-pick-step]'), pickGrid = form.querySelector('[data-max-pick-grid]');
  const keyStep = form.querySelector('[data-max-key-step]'), consentStep = form.querySelector('[data-max-consent-step]');
  const backButton = byId('astra-max-back');
  const feedback = form.querySelector('[data-astra-max-feedback]');
  const status = document.querySelector('[data-max-settings-status]');
  const choices = document.querySelector('[data-max-choices]');
  const popover = document.querySelector('#oscar-model-popover');
  const localSource = document.querySelector('[data-oscar-source="local"]');
  const stage = popover?.querySelector('.omenu-stage');
  // One owner for the menu's height: the stage glides from where it is now to
  // the new list's height, so a quick back-and-forth never queues or jumps.
  const setSource = value => {
    if (!popover || popover.dataset.source === value) return;
    const visible = stage && !popover.classList.contains('hidden') && reducedUiMotion.matches !== true;
    const from = visible ? stage.getBoundingClientRect().height : 0;
    for (const animation of stage?.getAnimations?.() || []) animation.cancel();
    popover.dataset.source = value;
    if (!visible || typeof stage.animate !== 'function') return;
    const to = stage.getBoundingClientRect().height;
    if (Math.abs(to - from) > 1) stage.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  };
  // Remembered per device so MAX stays on after a restart; the provider itself
  // is still rechecked against its encrypted connection on every request.
  const readEnabled = () => { try { return localStorage.getItem('monarch.max.enabled') === 'true'; } catch { return false; } };
  const writeEnabled = value => { try { localStorage.setItem('monarch.max.enabled', String(value)); } catch { /* optional */ } };
  let providers = [], activeId = 'groq', editing = null, editorMode = 'connect', step = 'key', selected = readEnabled(), busy = false, loaded = false, fromPick = false;
  activeId = 'groq';
  const active = () => providers.find(item => item.id === activeId && item.state === 'ready');
  const acknowledgements = () => Object.fromEntries(Object.entries(checks).map(([name, node]) => [name, node.checked]));
  const setBusy = value => {
    busy = value; form.setAttribute('aria-busy', String(value));
    document.querySelector('.max-settings-panel').dataset.busy = String(value);
    form.querySelectorAll('input,button,select').forEach(node => { node.disabled = value; });
    sync();
  };
  const sync = () => {
    const current = active();
    if (!current && loaded) selected = false;
    entry.dataset.selected = String(selected); entry.dataset.state = current ? 'ready' : 'not-configured';
    entry.dataset.modelChoice = current?.id === 'groq' ? 'gpt-oss-120b' : current?.role || '';
    const pilot = entry.classList.contains('astra-max-pilot-entry');
    const entryLabel = !current ? 'MAX: подключить облачный сервис своим ключом' : selected
      ? 'MAX включён: ' + current.name + (pilot ? '. Нажми, чтобы вернуться к локальной модели' : '')
      : 'Включить MAX: ' + current.name + ' через интернет';
    entry.setAttribute('aria-label', entryLabel); entry.title = entryLabel;
    entry.setAttribute('aria-checked', String(Boolean(current && selected)));
    // The model menu shows the list for where Oscar works now: this computer or MAX.
    const on = Boolean(current && selected);
    setSource(on ? 'max' : 'local');
    if (localSource) { localSource.setAttribute('aria-checked', String(!on)); localSource.tabIndex = on ? -1 : 0; }
    entry.tabIndex = on || !localSource ? 0 : -1;
    renderChoices(current);
    document.querySelector('[data-max-journey-provider]').textContent = current?.name || 'Выбранный сервис';
    const storedCatalog = editorMode === 'model';
    loadModels.disabled = busy || catalogLoading || editing?.id === 'groq'
      || (!storedCatalog && !/^[\x21-\x7e]{20,512}$/u.test(key.value.trim()));
    model.disabled = busy || catalogLoading; modelPicker?.sync();
    // Key, model and consent share one screen; there is no separate "continue".
    next.hidden = true; next.disabled = true;
    const keyOk = /^[\x21-\x7e]{20,512}$/u.test(key.value.trim());
    const modelOk = /^[a-zA-Z0-9][a-zA-Z0-9._/:@+-]{0,159}$/u.test(model.value.trim());
    saveModel.hidden = !storedCatalog;
    saveModel.disabled = busy || catalogLoading || !storedCatalog
      || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@+-]{0,159}$/u.test(model.value.trim());
    connect.disabled = busy || catalogLoading || storedCatalog || step === 'pick' || !keyOk || !modelOk
      || !validAstraMaxSetupInput(key.value, acknowledgements());
    form.dataset.mode = editorMode;
    if (connectCopy) connectCopy.hidden = storedCatalog;
    if (modelCopy) modelCopy.hidden = !storedCatalog;
    if (keyStorage) keyStorage.hidden = storedCatalog;
    key.closest('label')?.toggleAttribute('hidden', storedCatalog);
    grid.querySelectorAll('button').forEach(node => { node.disabled = busy; });
    window.dispatchEvent(new CustomEvent('monarch-max-selection-change'));
  };
  const closeModelPopover = () => {
    const popover = document.querySelector('#oscar-model-popover');
    popover?.classList.add('hidden'); popover?.setAttribute('aria-hidden', 'true');
    byId('oscar-model-dropdown-btn')?.setAttribute('aria-expanded', 'false');
  };
  const openSettings = () => {
    closeModelPopover();
    window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view: 'settings-section', subview: 'max' } }));
  };
  const setSelected = value => { selected = value; writeEnabled(value); sync(); };
  // Memory reaches a cloud service only after the owner answers this once per
  // service. Closing the question without an answer sends nothing and asks again.
  const memoryDialog = byId('max-memory-consent-dialog');
  const memoryCheck = byId('max-memory-consent-check'), memoryConfirm = byId('max-memory-consent-confirm');
  const reducedMotion = () => reducedUiMotion.matches === true;
  memoryCheck?.addEventListener('change', () => {
    memoryConfirm.disabled = !memoryCheck.checked;
    memoryDialog.dataset.linked = String(memoryCheck.checked);
  });
  // The sheet leaves the way it came: back toward the model button.
  const closeMemoryDialog = value => {
    if (!memoryDialog.open || memoryDialog.dataset.state === 'closing') return;
    if (reducedMotion() || typeof memoryDialog.getAnimations !== 'function') { memoryDialog.close(value); return; }
    memoryDialog.dataset.state = 'closing';
    const done = () => { delete memoryDialog.dataset.state; if (memoryDialog.open) memoryDialog.close(value); };
    Promise.all(memoryDialog.getAnimations().map(animation => animation.finished)).then(done, done);
  };
  memoryDialog?.querySelector('form')?.addEventListener('submit', event => {
    event.preventDefault();
    closeMemoryDialog(event.submitter?.value || '');
  });
  memoryDialog?.addEventListener('cancel', event => { event.preventDefault(); closeMemoryDialog(''); });
  const askMemoryConsent = provider => new Promise(resolve => {
    if (!memoryDialog || memoryDialog.open) { resolve(null); return; }
    memoryDialog.querySelectorAll('[data-max-memory-provider]').forEach(node => { node.textContent = provider.name; });
    const mark = memoryDialog.querySelector('[data-max-memory-logo]');
    if (PROVIDER_LOGOS.includes(provider.id)) {
      const logo = document.createElement('img');
      logo.src = '/assets/provider-logos/' + provider.id + '.svg'; logo.alt = '';
      mark.replaceChildren(logo);
    } else mark.textContent = provider.mark || provider.name.slice(0, 1);
    memoryCheck.checked = false; memoryConfirm.disabled = true; memoryDialog.returnValue = '';
    memoryDialog.dataset.linked = 'false'; delete memoryDialog.dataset.state;
    memoryDialog.addEventListener('close', async () => {
      const decision = memoryDialog.returnValue;
      if (decision !== 'granted' && decision !== 'declined') { resolve(null); return; }
      try {
        const current = await fetchMaxMemoryConsent(provider.id);
        const result = await decideMaxMemoryConsent({ providerId: provider.id, decision,
          confirmed: decision === 'granted' && memoryCheck.checked, version: current.version });
        resolve(result.decision);
      } catch { resolve(null); }
    }, { once: true });
    // Arrive from the model button the request came from.
    const origin = byId('oscar-model-dropdown-btn')?.getBoundingClientRect();
    const shift = (from, center) => Math.max(-48, Math.min(48, (from - center) * 0.12)) + 'px';
    memoryDialog.style.setProperty('--enter-x', origin?.width ? shift(origin.left + origin.width / 2, window.innerWidth / 2) : '0px');
    memoryDialog.style.setProperty('--enter-y', origin?.height ? shift(origin.top + origin.height / 2, window.innerHeight / 2) : '18px');
    memoryDialog.showModal();
  });
  const memoryDecision = async provider => {
    try { return (await fetchMaxMemoryConsent(provider.id)).decision; } catch { return null; }
  };
  const ensureMemoryDecision = async provider => {
    if (await memoryDecision(provider) === 'undecided') await askMemoryConsent(provider);
  };
  const enable = async provider => { await ensureMemoryDecision(provider); setSelected(true); };
  const choose = async provider => {
    if (busy) return;
    if (provider.id !== activeId) {
      setBusy(true);
      try {
        const result = await bridge.selectProvider(provider.id);
        if (!result.ok) { status.textContent = result.detail; return; }
        render(result); window.dispatchEvent(new Event('monarch:max-selection-changed'));
      } catch { status.textContent = 'Не удалось сохранить выбор.'; return; }
      finally { setBusy(false); }
    }
    closeModelPopover(); await enable(provider); byId('oscar-model-dropdown-btn')?.focus({ preventScroll: true });
  };
  // Every connected service is one row in the MAX list; the chosen one carries the tick.
  const renderChoices = current => {
    if (!choices) return;
    const ready = providers.filter(item => item.state === 'ready');
    const signature = ready.map(item => item.id + ':' + item.model).join('|') + '/' + (current?.id || '') + '/' + selected + '/' + busy;
    if (choices.dataset.signature === signature) return;
    choices.dataset.signature = signature;
    choices.replaceChildren();
    for (const provider of ready) {
      const isOn = selected && provider.id === current?.id;
      const node = document.createElement('button'); node.type = 'button'; node.className = 'omenu-row';
      node.setAttribute('role', 'option'); node.setAttribute('aria-selected', String(isOn)); node.disabled = busy;
      node.tabIndex = isOn ? 0 : -1;
      const mark = document.createElement('span'); mark.className = 'omenu-row-mark'; mark.setAttribute('aria-hidden', 'true');
      if (PROVIDER_LOGOS.includes(provider.id)) {
        const logo = document.createElement('img'); logo.src = '/assets/provider-logos/' + provider.id + '.svg'; logo.alt = '';
        mark.append(logo);
      } else mark.textContent = provider.mark || provider.name.slice(0, 1);
      const copy = document.createElement('span'); copy.className = 'omenu-row-text';
      const name = document.createElement('strong'); name.textContent = provider.name;
      const model = document.createElement('small'); model.textContent = modelLabel(provider);
      const check = document.createElement('span'); check.className = 'omenu-check'; check.setAttribute('aria-hidden', 'true');
      node.title = 'MAX: ' + provider.name + ' · ' + provider.model;
      copy.append(name, model); node.append(mark, copy, check);
      node.addEventListener('click', event => { event.stopPropagation(); void choose(provider); });
      choices.append(node);
    }
    const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'omenu-row omenu-row-link';
    const manageText = document.createElement('span'); manageText.className = 'omenu-row-text';
    manageText.textContent = 'Настроить сервисы';
    manage.append(manageText);
    manage.insertAdjacentHTML('beforeend', '<svg class="omenu-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>');
    manage.addEventListener('click', event => { event.stopPropagation(); openSettings(); });
    choices.append(manage);
  };
  const clearEditor = () => { modelPicker?.close(); catalogRequest++; catalogLoading = false; loadModels.textContent = 'Загрузить модели'; key.value = ''; Object.values(checks).forEach(node => { node.checked = false; }); };
  const setStep = value => {
    step = value; form.dataset.step = value;
    const picking = value === 'pick';
    pickStep.hidden = !picking; keyStep.hidden = picking;
    consentStep.hidden = picking || editorMode === 'model';
    backButton.hidden = !fromPick;
    form.querySelector('[data-max-editor-step]').textContent = editorMode === 'model' ? 'МОДЕЛЬ'
      : picking ? 'ШАГ 1 ИЗ 2 · СЕРВИС' : fromPick ? 'ШАГ 2 ИЗ 2 · КЛЮЧ И СОГЛАСИЕ' : 'КЛЮЧ И СОГЛАСИЕ';
    sync();
  };
  const modelLabel = provider => provider.id === 'groq' ? 'GPT OSS 120B' : provider.model;
  const edit = (provider, mode = 'connect', viaPick = false) => {
    if (busy) return;
    fromPick = viaPick; editing = provider; editorMode = mode === 'model' && provider.id !== 'groq' ? 'model' : 'connect';
    form.dataset.mode = editorMode; clearEditor();
    model.replaceChildren(new Option(modelLabel(provider), provider.model));
    modelsHint.textContent = provider.id === 'groq' ? 'Для Groq в MAX используется GPT OSS 120B.'
      : editorMode === 'model' ? 'Загружаю модели по сохранённому ключу. В сервис уйдёт только запрос списка.'
        : 'Вставь ключ — список моделей подгрузится сам. В сервис уйдёт только ключ, без переписки.';
    loadModels.hidden = provider.id === 'groq';
    form.querySelector('[data-max-editor-title]').textContent = provider.name;
    const brand = grid.querySelector('[data-provider="' + provider.id + '"] .max-provider-mark');
    form.querySelector('[data-max-editor-logo]').replaceChildren(...(brand ? [brand.cloneNode(true)] : []));
    for (const [attr, url] of [['keys', provider.keysUrl], ['terms', provider.termsUrl], ['privacy', provider.privacyUrl]]) {
      const link = form.querySelector('[data-max-' + attr + '-link]'); link.href = url;
    }
    feedback.textContent = ''; form.hidden = false; setStep('key');
    if (!editorDialog.open) editorDialog.showModal();
    if (editorMode === 'model') void loadCatalog();
    else key.focus({ preventScroll: true });
  };
  // First connection starts in the chat itself: pick a service, then key and consent on one screen.
  const renderPick = () => {
    pickGrid.replaceChildren();
    for (const provider of providers.filter(item => item.state !== 'ready')) {
      const node = document.createElement('button'); node.type = 'button'; node.className = 'max-pick-choice';
      node.dataset.pick = provider.id;
      const mark = document.createElement('span'); mark.className = 'max-provider-mark';
      if (PROVIDER_LOGOS.includes(provider.id)) {
        const logo = document.createElement('img'); logo.src = '/assets/provider-logos/' + provider.id + '.svg';
        logo.alt = ''; logo.width = 22; logo.height = 22; logo.setAttribute('aria-hidden', 'true'); mark.append(logo);
      } else mark.textContent = provider.mark || provider.name.slice(0, 1);
      const name = document.createElement('strong'); name.textContent = provider.name;
      node.append(mark, name); node.addEventListener('click', () => edit(provider, 'connect', true));
      pickGrid.append(node);
    }
  };
  const openConnect = () => {
    if (busy) return;
    closeModelPopover();
    editing = null; editorMode = 'connect'; fromPick = true; form.dataset.mode = 'connect'; clearEditor();
    form.querySelector('[data-max-editor-title]').textContent = 'Подключить MAX';
    form.querySelector('[data-max-editor-logo]').replaceChildren();
    feedback.textContent = providers.length ? '' : 'Подключение MAX доступно в приложении Monarch.';
    form.hidden = false; renderPick(); setStep('pick');
    if (!editorDialog.open) editorDialog.showModal();
    pickGrid.querySelector('button')?.focus({ preventScroll: true });
  };
  const button = (label, handler, className = 'claude-secondary-btn') => {
    const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = label; node.addEventListener('click', handler); return node;
  };
  const render = value => {
    if (!Array.isArray(value?.providers)) return;
    if (typeof value.selectedProviderId === 'string') activeId = value.selectedProviderId;
    providers = value.providers.filter(item => item && /^[a-z]{2,20}$/.test(item.id) && typeof item.name === 'string'
      && typeof item.role === 'string' && [item.keysUrl,item.termsUrl,item.privacyUrl].every(url => typeof url === 'string' && url.startsWith('https://'))).slice(0, 24);
    grid.replaceChildren();
    for (const provider of providers) {
      const card = document.createElement('article'); card.className = 'max-provider-card'; card.dataset.provider = provider.id; card.dataset.active = String(provider.id === activeId && provider.state === 'ready');
      const heading = document.createElement('header'), mark = document.createElement('span'), name = document.createElement('h3');
      mark.className = 'max-provider-mark';
      const logo = document.createElement('img');
      if (PROVIDER_LOGOS.includes(provider.id)) {
        logo.src = '/assets/provider-logos/' + provider.id + '.svg';
        logo.alt = ''; logo.width = 24; logo.height = 24; logo.setAttribute('aria-hidden', 'true');
        mark.append(logo);
      } else mark.textContent = provider.mark;
      name.textContent = provider.name; heading.append(mark, name);
      const state = document.createElement('p'); state.className = 'max-provider-state';
      state.textContent = provider.state === 'ready' ? provider.id === activeId ? 'Выбран для MAX' : 'Ключ сохранён' : provider.state === 'corrupt' ? 'Нужен новый ключ' : provider.state === 'unavailable' ? 'Хранилище недоступно' : 'Можно подключить';
      card.append(heading, state);
      if (provider.state === 'ready' && provider.model) {
        const currentModel = document.createElement('p'); currentModel.className = 'max-provider-model';
        currentModel.textContent = modelLabel(provider);
        currentModel.title = provider.model;
        card.append(currentModel);
      }
      if (provider.state === 'ready') {
        const actions = document.createElement('div'); actions.className = 'max-provider-actions';
        const choose = button(provider.id === activeId ? 'Выбран ✓' : 'Выбрать для MAX', async () => {
          if (busy) return; setBusy(true);
          try {
            const result = await bridge.selectProvider(provider.id);
            if (!result.ok) { status.textContent = result.detail; return; }
            render(result); window.dispatchEvent(new Event('monarch:max-selection-changed'));
            status.textContent = result.warning || provider.name + ' выбран для новых запросов MAX во всех разделах.';
          } catch { status.textContent = 'Не удалось сохранить выбор.'; }
          finally { setBusy(false); }
        }); choose.setAttribute('aria-pressed', String(provider.id === activeId)); actions.append(choose);
        // One visible choice per card; the rarer actions wait behind "⋯".
        const more = document.createElement('details'); more.className = 'max-provider-more';
        const moreToggle = document.createElement('summary'); moreToggle.textContent = '⋯';
        moreToggle.setAttribute('aria-label', 'Ещё действия с ' + provider.name); moreToggle.title = 'Ещё действия';
        const menu = document.createElement('div'); more.append(moreToggle, menu);
        menu.addEventListener('click', () => { more.open = false; });
        if (provider.id !== 'groq') menu.append(button('Сменить модель', () => edit(provider, 'model'), 'claude-ghost-btn'));
        const memory = button('Память…', async () => {
          if (busy) return;
          if (await memoryDecision(provider) === 'granted') {
            try { await decideMaxMemoryConsent({ providerId: provider.id, decision: 'declined' });
              status.textContent = provider.name + ' больше не получает память.'; }
            catch { status.textContent = 'Не удалось сохранить. Попробуй ещё раз.'; }
          } else {
            const decision = await askMemoryConsent(provider);
            if (decision) status.textContent = decision === 'granted' ? provider.name + ' будет получать подходящие записи памяти.' : 'Память остаётся только на компьютере.';
          }
          void syncMemoryLabel();
        }, 'claude-ghost-btn');
        const syncMemoryLabel = async () => {
          const decision = await memoryDecision(provider);
          memory.textContent = decision === 'granted' ? 'Память: передаётся' : 'Память: не передаётся';
          memory.title = decision === 'granted' ? 'Нажми, чтобы запретить передачу памяти в ' + provider.name : 'Нажми, чтобы разрешить передачу памяти в ' + provider.name;
        };
        void syncMemoryLabel(); menu.append(memory);
        menu.append(button('Настроить ключ', () => edit(provider), 'claude-ghost-btn'));
        menu.append(button('Проверить', async () => {
          if (busy) return; setBusy(true); status.textContent = 'Проверяю ' + provider.name + '…';
          try { const result = await bridge.verifyProvider(provider.id); if (result.ok) render(result);
            status.textContent = result.ok ? provider.name + ' отвечает. Всё готово.' : result.detail; }
          catch { status.textContent = 'Не удалось проверить подключение. Попробуй ещё раз.'; }
          finally { setBusy(false); }
        }, 'claude-ghost-btn')); actions.append(more); card.append(actions);
      } else card.append(button('Подключить', () => edit(provider)));
      grid.append(card);
    }
    status.textContent = providers.some(item => item.state === 'ready') ? 'Подключения сохранены только на этом компьютере.' : 'Начни с сервиса, которым уже пользуешься.';
    sync();
  };
  const refresh = async () => {
    if (typeof bridge?.providers !== 'function') { status.textContent = 'Подключения MAX доступны в обновлённом приложении Monarch.'; sync(); return; }
    try { const value = await bridge.providers(); loaded = Array.isArray(value?.providers); render(value); if (!value.available) status.textContent = value.detail || 'Подключения сейчас недоступны.'; }
    catch { status.textContent = 'Не удалось загрузить подключения. Открой настройки ещё раз.'; }
  };
  // MAX side of the source switch: on with the chosen service (the menu stays
  // open on its list), or straight to connecting when nothing is connected yet.
  // The Astra pilot dock has no local side, so there the same button turns MAX off.
  entry.addEventListener('click', event => {
    event.stopPropagation();
    const current = active();
    if (!current) { openConnect(); return; }
    if (selected) {
      if (entry.classList.contains('astra-max-pilot-entry')) { setSelected(false); closeModelPopover(); }
      return;
    }
    if (busy) return;
    void enable(current);
  });
  localSource?.addEventListener('click', event => {
    event.stopPropagation();
    if (selected) setSelected(false);
  });
  // Arrow keys move between the two sides, as in any radio group.
  for (const node of [localSource, entry]) node?.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !localSource) return;
    event.preventDefault();
    const target = node === entry ? localSource : entry;
    target.click(); if (target.getAttribute('aria-checked') === 'true') target.focus();
  });
  const closeEditor = () => {
    const providerId = editing?.id;
    clearEditor(); form.hidden = true; editing = null; editorMode = 'connect'; form.dataset.mode = 'connect';
    if (editorDialog.open) editorDialog.close();
    grid.querySelector('[data-provider="' + providerId + '"] button')?.focus({ preventScroll: true });
    sync();
  };
  byId('max-editor-close').addEventListener('click', () => { if (!busy) closeEditor(); });
  editorDialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) closeEditor(); });
  editorDialog.addEventListener('close', () => { if (editing && !busy) closeEditor(); });
  backButton.addEventListener('click', () => {
    if (busy || !fromPick) return;
    clearEditor(); editing = null; renderPick(); setStep('pick'); pickGrid.querySelector('button')?.focus({ preventScroll: true });
  });
  const loadCatalog = async () => {
    if (loadModels.disabled || !editing) return;
    const request = ++catalogRequest, providerId = editing.id, stored = editorMode === 'model';
    const input = stored ? null : { providerId, apiKey: key.value.trim() };
    catalogLoading = true; loadModels.textContent = 'Загружаю…'; modelsHint.textContent = 'Получаю список моделей…'; sync();
    try {
      const result = stored
        ? typeof bridge.listStoredProviderModels === 'function'
          ? await bridge.listStoredProviderModels(providerId)
          : { ok: false, detail: 'Смена модели доступна в обновлённом приложении Monarch.' }
        : await bridge.listProviderModels(input);
      if (request !== catalogRequest || editing?.id !== providerId) return;
      if (!result.ok) { modelsHint.textContent = result.detail; return; }
      const choices = result.models.filter(item => item && /^[a-zA-Z0-9][a-zA-Z0-9._/:@+-]{0,159}$/.test(item.id) && typeof item.label === 'string');
      if (!choices.length) { modelsHint.textContent = 'Сервис не вернул моделей для чата. Попробуй позже.'; return; }
      const previous = model.value;
      model.replaceChildren(...choices.map(item => new Option(item.label, item.id)));
      model.value = choices.some(item => item.id === previous) ? previous : choices[0].id;
      modelsHint.textContent = 'Моделей в списке: ' + choices.length + '. Совместимость с MAX проверим при сохранении.';
      modelPicker?.focus();
    } catch { if (request === catalogRequest) modelsHint.textContent = 'Не удалось получить список. Попробуй ещё раз.'; }
    finally { if (input) input.apiKey = ''; if (request === catalogRequest) { catalogLoading = false; loadModels.textContent = 'Обновить список'; sync(); } }
  };
  loadModels.addEventListener('click', () => { void loadCatalog(); });
  let autoLoad;
  key.addEventListener('input', () => {
    clearTimeout(autoLoad);
    if (editorMode === 'connect' && editing && editing.id !== 'groq' && typeof bridge.listProviderModels === 'function'
      && /^[\x21-\x7e]{20,512}$/u.test(key.value.trim())) autoLoad = setTimeout(() => { void loadCatalog(); }, 700);
    if (catalogLoading) { catalogRequest++; catalogLoading = false; loadModels.textContent = 'Загрузить модели'; modelsHint.textContent = 'Ключ изменился. Загрузи список ещё раз.'; }
  });
  form.addEventListener('input', sync); form.addEventListener('change', sync);
  saveModel.addEventListener('click', async () => {
    if (busy || saveModel.disabled || !editing || editorMode !== 'model') return;
    if (typeof bridge.updateProviderModel !== 'function') {
      feedback.textContent = 'Смена модели доступна в обновлённом приложении Monarch.';
      return;
    }
    const chosen = { providerId: editing.id, modelId: model.value.trim() };
    setBusy(true); feedback.textContent = 'Проверяю модель. Ещё немного…';
    try {
      const result = await bridge.updateProviderModel(chosen);
      if (result.ok) {
        activeId = result.selectedProviderId || activeId;
        render(result); form.hidden = true;
        status.textContent = result.warning || editing.name + ' теперь использует ' + chosen.modelId + '.';
        window.dispatchEvent(new Event('monarch:max-selection-changed'));
      } else feedback.textContent = result.detail || 'Модель не сохранена. Прежний выбор остался.';
    } catch { feedback.textContent = 'Не получилось сменить модель. Прежний выбор сохранён.'; }
    finally { setBusy(false); if (!form.hidden) { setStep('key'); modelPicker?.focus(); } else closeEditor(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (editorMode === 'model') { saveModel.click(); return; }
    if (step === 'pick') return;
    if (busy || connect.disabled || !editing) return;
    const input = { providerId: editing.id, modelId: model.value.trim(), apiKey: key.value.trim(), acknowledgements: acknowledgements() };
    let connected = null;
    setBusy(true); feedback.textContent = 'Проверяю ключ и модель. Ещё немного…';
    try {
      const result = await bridge.configureProvider(input);
      if (result.ok) { activeId = editing.id; connected = editing.id; render(result); form.hidden = true; status.textContent = result.warning || editing.name + ' подключён и включён.';
        window.dispatchEvent(new Event('monarch:max-selection-changed')); }
      else feedback.textContent = result.detail || 'Подключение не сохранено. Попробуй снова.';
    } catch { feedback.textContent = 'Не получилось сохранить подключение. Прежний ключ остался на месте.'; }
    finally { input.apiKey = ''; clearEditor(); setBusy(false); if (!form.hidden) { setStep('key'); key.focus({ preventScroll: true }); } else closeEditor(); }
    // The button said "connect and turn on MAX": do exactly that, memory question included.
    const provider = connected && providers.find(item => item.id === connected && item.state === 'ready');
    if (provider) await enable(provider);
  });
  document.addEventListener('click', event => {
    for (const menu of grid.querySelectorAll('.max-provider-more[open]')) if (!menu.contains(event.target)) menu.open = false;
  });
  window.addEventListener('monarch-local-model-selected', () => { if (selected) setSelected(false); });
  // First setup connected a service through the same bridge: pick it up, and
  // switch MAX on when the person chose to work through it.
  window.addEventListener('monarch:max-connected', event => {
    void refresh().then(() => { if (event.detail?.enable === true && active()) setSelected(true); });
  });
  window.addEventListener('monarch:settings-selection', event => {
    if (event.detail?.tab === 'max') { if (!busy) void refresh(); }
    else if (!busy) closeEditor();
  });
  void refresh();
  return Object.freeze({ selected: () => selected && active() ? { modelChoice: active().id === 'groq' ? 'gpt-oss-120b' : active().role,
    role: active().role, providerId: active().id, providerName: active().name,
    effortTunable: active().id === 'groq' || active().effortTunable === true } : null });
}
function text(value, fallback) { return typeof value === 'string' && value.length <= 240 && value ? value : fallback; }
