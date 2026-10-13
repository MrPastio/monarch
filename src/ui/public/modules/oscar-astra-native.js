import { astraGoalRequest, astraSelectionTargets, astraWindowTargets } from './astra-turn-panel.js';
import { fetchOscarAstraSelections } from './api.js';

export function oscarAstraNativeRequest(selection, text, identity, maxSelection = null) {
  const references = selection.references || [];
  return astraGoalRequest({ deployment: 'isolated-validation', conversationId: selection.conversationId,
    targets: [selection.target, ...references], localAnalysis: selection.localAnalysis,
    referenceInputs: selection.referenceInputs === true, computerObservation: true },
  { target: selection.target.key, text, contentKind: selection.target.access === 'exclusive-create'
    && selection.mode === 'draft' && (selection.localAnalysis === true || maxSelection) ? 'draft' : 'reply',
    ...(references.length ? { references: references.map(target => target.key) } : {}),
    ...(maxSelection && ['observe', 'exclusive-create'].includes(selection.target.access)
      && ['analyze', 'draft'].includes(selection.mode) ? { modelMode: 'max', ...maxSelection }
      : selection.target.access === 'observe' && selection.mode === 'analyze' ? { modelMode: 'local' } : {}) }, identity);
}

/** Selection and presentation only. The ordinary Oscar submit/stream/history
 * owner sends the exact request; native main and Kernel retain all authority. */
export function mountOscarAstraNative(elements, bridge, owner) {
  const menu = document.querySelector('#oscar-composer-menu-popover');
  if (!menu || !elements.oscarComposer || typeof bridge?.forConversation !== 'function') throw Error('Не удалось подключить файлы к чату.');
  let selected = null, choosing = false;
  const chip = document.createElement('div'); chip.className = 'oscar-selected-skill oscar-astra-attachment hidden';
  chip.id = 'oscar-astra-attachment'; chip.setAttribute('aria-live', 'polite');
  const label = document.createElement('span'), mode = document.createElement('select'), remove = document.createElement('button');
  mode.setAttribute('aria-label', 'Обработка прикреплённого файла');
  remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Убрать выбранный файл или окно');
  remove.addEventListener('click', () => { selected = null; sync(); elements.oscarInput.focus(); });
  mode.addEventListener('change', () => { if (selected) selected = { ...selected, mode: mode.value }; });
  chip.append(label, mode, remove); elements.oscarComposer.prepend(chip);
  const actions = [];
  const current = () => selected?.conversationId === owner.state().conversationId ? selected : null;
  const privateMode = () => owner.state().incognito === true || owner.state().encrypted === true;
  const sync = () => {
    const value = privateMode() ? null : current();
    chip.classList.toggle('hidden', !value);
    if (value) {
      label.textContent = value.target.label.replace(/^(Прочитать|Создать) /u, '')
        + (value.references?.length ? ` · материалов: ${value.references.length}` : ''); label.title = value.target.label;
      const create = value.target.access === 'exclusive-create';
      mode.replaceChildren();
      for (const [key, text] of create ? [['draft', 'Написать по поручению'], ['reply', 'Ввести точный текст']]
        : [['analyze', 'Проанализировать'], ['observe', 'Прочитать точно']]) {
        const option = document.createElement('option'); option.value = key; option.textContent = text;
        option.disabled = key === 'reply' && Boolean(value.references?.length); mode.append(option);
      }
      mode.setAttribute('aria-label', create ? 'Содержимое нового файла' : 'Обработка прикреплённого файла');
      // Offer the choice whenever a model can take the file. Keyed on local
      // analysis only, a MAX-only setup defaulted to sending the file to the
      // cloud and hid "Прочитать точно", the local exact read, altogether.
      mode.hidden = !['observe', 'exclusive-create'].includes(value.target.access)
        || !(value.modelAvailable ?? value.localAnalysis); mode.value = value.mode;
    }
    for (const action of [...actions, mode, remove]) action.disabled = choosing || owner.state().busy || privateMode();
  };
  const choose = async access => {
    if (choosing || owner.state().busy || privateMode()) return;
    choosing = true; sync();
    try {
      const conversationId = await owner.ensureConversation();
      const scoped = await bridge.forConversation(conversationId);
      const boot = await scoped.bootstrap();
      const request = { version: 1, requestId: crypto.randomUUID() };
      if (access === 'computer-observe') await scoped.prepareComputerUse();
      const response = access === 'computer-observe' ? await scoped.pickWindow(request) : await scoped.pickTarget({ ...request, access });
      if (response?.status === 'cancelled') return;
      if (response?.status !== 'selected') throw Error('Выбор не подтверждён.');
      const targets = access === 'computer-observe'
        ? astraWindowTargets(await scoped.windowSelections({ version: 1, kind: 'list', source: boot.computerSource }))
        : astraSelectionTargets(await fetchOscarAstraSelections(conversationId));
      const target = targets.find(item => item.selectionId === response.selection?.selectionId);
      if (!target) throw Error('Выбранный материал больше недоступен. Выбери его заново.');
      if (conversationId !== owner.state().conversationId || privateMode()) return;
      const previous = current();
      const modelAvailable = boot.localAnalysis === true || boot.maxAnalysis === true;
      const canReference = boot.referenceInputs === true && modelAvailable;
      if (target.access === 'observe' && previous?.target.access === 'exclusive-create') {
        if (!canReference) throw Error('Добавление материалов к новому файлу сейчас недоступно.');
        if (Array.isArray(target.targetIds)) throw Error('Добавляй материалы к новому файлу по одному.');
        const references = [...(previous.references || []).filter(item => item.key !== target.key), target];
        if (references.length > 8) throw Error('Можно добавить до 8 материалов.');
        selected = { ...previous, mode: 'draft', referenceInputs: true, references };
      } else {
        const references = target.access === 'exclusive-create'
          ? previous?.target.access === 'observe' ? [previous.target]
            : previous?.target.access === 'exclusive-create' ? previous.references || [] : [] : [];
        if (references.some(item => Array.isArray(item.targetIds))) throw Error('Добавляй материалы к новому файлу по одному.');
        if (references.length && !canReference) throw Error('Создание файла по прикреплённому материалу сейчас недоступно.');
        selected = { conversationId, target, localAnalysis: boot.localAnalysis === true, modelAvailable,
          referenceInputs: boot.referenceInputs === true, references,
          mode: target.access === 'exclusive-create' ? modelAvailable ? 'draft' : 'reply'
            : modelAvailable ? 'analyze' : 'observe' };
      }
      const { closeOscarComposerMenu } = await import('./oscar-plus-menu.js');
      closeOscarComposerMenu({ immediate: true });
      elements.oscarInput.focus();
    } catch (error) { owner.error(error.message || String(error)); }
    finally { choosing = false; sync(); }
  };
  // Attachments are tiles beside Фото; creating a file is a tool row.
  for (const [access, title, detail, drawing] of [['observe', 'Файл', 'Прочитать или проанализировать файл', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5'],
    ['computer-observe', 'Окно', 'Добавить содержимое открытого окна', 'M4 4h16v16H4z M4 9h16 M7 6.5h.01 M10 6.5h.01'],
    ['exclusive-create', 'Создать файл', 'Покажу его до записи', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M12 12v6 M9 15h6']]) {
    const tile = access !== 'exclusive-create';
    const button = document.createElement('button'); button.type = 'button'; button.className = tile ? 'omenu-tile' : 'omenu-row';
    button.dataset.oscarAstraSelect = access;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', drawing); svg.append(path);
    if (tile) {
      const label = document.createElement('span'); label.textContent = title;
      button.title = title + ' · ' + detail; button.append(svg, label);
    } else {
      const icon = document.createElement('span'); icon.className = 'omenu-row-icon'; icon.setAttribute('aria-hidden', 'true'); icon.append(svg);
      const copy = document.createElement('span'); copy.className = 'omenu-row-text';
      const strong = document.createElement('strong'), small = document.createElement('small');
      strong.textContent = title; small.textContent = detail; copy.append(strong, small); button.append(icon, copy);
    }
    button.addEventListener('click', () => void choose(access)); actions.push(button);
    const slot = menu.querySelector(tile ? '#oscar-composer-attachments' : '#oscar-composer-tools');
    if (tile || !slot) (slot || menu).append(button);
    else slot.insertBefore(button, slot.querySelector('#oscar-computer-use-toggle'));
  }
  sync();
  return {
    sync, capture: () => privateMode() ? null : current() && structuredClone(current()),
    request(selection, text, identity, maxSelection = null) {
      if (!selection || privateMode() || selection.conversationId !== owner.state().conversationId)
        throw Error('Материал относится к другому чату. Выбери его в текущем разговоре.');
      return oscarAstraNativeRequest(selection, text, identity, maxSelection);
    },
    submitted(selection) { if (selected?.target.key === selection?.target.key) selected = null; sync(); },
    dispose() { chip.remove(); for (const action of actions) action.remove(); selected = null; },
  };
}
