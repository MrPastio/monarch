import { mountAstraTurnPanel, astraSelectionTargets, astraWindowTargets, astraActionTargets } from './astra-turn-panel.js';
import { fetchOscarAstraSelections } from './api.js';

/** Explicit native composition; default Oscar init never calls this. Native
 * bootstrap owns sources and retained IDs. Switching disposes the VIEW only. */
export async function mountAstraDesktopPane(container, bridge = window.monarchAstraDesktop, view = {}) {
  if (!bridge || !['bootstrap', 'pickTarget', 'savePending', 'saveLinked', 'clearPending'].every(key => typeof bridge[key] === 'function'))
    throw Error('Требуется изолированный desktop-хост Astra.');
  const shell = document.createElement('section'), navigation = document.createElement('div'), alert = document.createElement('p'), body = document.createElement('div');
  navigation.className = 'astra-actions astra-turn-panel'; alert.className = 'astra-error'; alert.setAttribute('role', 'alert');
  shell.append(navigation, alert, body); container.append(shell);
  const drafts = new Map(); let disposed = false, switching = false, activated = false, active = null;
  const button = (label, handler, parent) => { const element = document.createElement('button'); element.type = 'button';
    element.textContent = label; element.addEventListener('click', handler); parent.append(element); return element; };
  function retainDraft() {
    if (!active) return;
    const draft = active.panel.draft(), next = new Map(drafts); next.set(active.boot.conversationId, draft);
    if (next.size > 16 || new TextEncoder().encode(JSON.stringify([...next])).length > 131072)
      throw Error('Черновики достигли лимита 128 КиБ. Сократи или сохрани текст перед переключением — он не удалён.');
    drafts.set(active.boot.conversationId, draft);
  }
  function retire() {
    if (active) { active.alive = false; active.panel.dispose(); active.toolbar.remove(); active = null; }
    if (view.composer) for (const key of ['input', 'submit', 'stop']) view.composer[key].disabled = true;
    body.replaceChildren();
  }
  async function transition(request) {
    if (disposed || switching) return;
    try { retainDraft(); } catch (cause) { alert.textContent = cause.message; return; }
    switching = true; alert.textContent = ''; const source = active?.boot.source;
    retire(); for (const control of navigation.querySelectorAll('button, select')) control.disabled = true;
    try {
      const boot = request ? await bridge.conversations({ version: 1, source, ...request }) : await bridge.bootstrap();
      await activate(boot);
    } catch (cause) {
      // A lost switch/create response never authorizes creating again.
      try { await activate(await bridge.bootstrap()); } catch { navigation.replaceChildren();
        button('Синхронизировать разговор', () => void transition(), navigation); }
      if (!disposed) alert.textContent = 'Переключение требует проверки: ' + (cause.message || String(cause));
    } finally { switching = false; }
  }
  async function activate(boot) {
    if (disposed) return;
    if (boot?.deployment !== 'isolated-validation' || !['idle', 'pending', 'linked'].includes(boot.surface?.state)
      || typeof boot.conversationId !== 'string') throw Error('Некорректное состояние desktop-хоста Astra.');
    const multi = boot.source !== undefined;
    if (multi && (typeof bridge.conversations !== 'function' || boot.source.conversationId !== boot.conversationId
      || !Array.isArray(boot.conversations) || !boot.conversations.length || boot.conversations.length > 16
      || !boot.conversations.some(entry => entry.id === boot.conversationId))) throw Error('Некорректный источник разговора.');
    const computer = boot.computerObservation === true;
    if (boot.modelUnavailable) alert.textContent = 'Локальная модель не подключена. Чтение файлов и работа с окнами доступны. Проверь модель в настройках и перезапусти Monarch.';
    if (computer && (typeof bridge.pickWindow !== 'function' || typeof bridge.windowSelections !== 'function'
      || boot.computerSource?.conversationId !== boot.conversationId)) throw Error('Недоступен доверенный выбор окна.');
    const computerActions = computer && boot.computerActions === true;
    if (computerActions && (typeof bridge.issueComputerAction !== 'function' || typeof bridge.computerActionPlans !== 'function'))
      throw Error('Недоступен доверенный выпуск плана действия.');
    const readTargets = async () => [...astraSelectionTargets(await fetchOscarAstraSelections(boot.conversationId)),
      ...(computer ? astraWindowTargets(await bridge.windowSelections({ version: 1, kind: 'list', source: boot.computerSource })) : []),
      ...(computerActions ? astraActionTargets(await bridge.computerActionPlans({ version: 1, kind: 'list', source: boot.computerSource })) : [])];
    const targets = await readTargets(); if (disposed) return;
    const toolbar = document.createElement('div'), panelRoot = document.createElement('div');
    toolbar.className = 'astra-desktop-picker astra-turn-panel'; body.replaceChildren(panelRoot);
    if (view.composer) { if (activated) view.composer.input.value = ''; view.composer.form.prepend(toolbar); } else body.prepend(toolbar);
    activated = true;
    const config = { deployment: boot.deployment, conversationId: boot.conversationId, targets,
      ...(boot.localAnalysis === true ? { localAnalysis: true } : {}),
      ...(computer ? { computerObservation: true } : {}),
      ...(computerActions ? { computerActions: true } : {}),
      ...(boot.referenceInputs === true ? { referenceInputs: true } : {}),
      ...(boot.surface.state === 'pending' ? { pendingRequestId: boot.surface.requestId } : {}),
      ...(boot.surface.state === 'linked' ? { turnId: boot.surface.turnId } : {}) };
    const panel = mountAstraTurnPanel(panelRoot, config, {
      onSubmissionPending: id => bridge.savePending(id, boot.source), onTurnLinked: id => bridge.saveLinked(id, boot.source),
      onSubmissionCancelled: id => bridge.clearPending(id, boot.source),
    }, { ...view, draft: drafts.get(boot.conversationId) });
    const owner = { alive: true, boot, panel, toolbar }; active = owner; shell.dataset.conversationId = boot.conversationId;
    const live = () => !disposed && owner.alive && active === owner;
    let choosing = false;
    for (const [access, label, reference] of [['observe', 'Выбрать файл для чтения'], ['exclusive-create', 'Выбрать новый файл'],
      ...(boot.referenceInputs === true ? [['observe', 'Добавить материал к черновику', true]] : [])]) {
      button(label, async () => {
        if (!live() || choosing || switching) return; choosing = true; alert.textContent = '';
        for (const control of toolbar.children) control.disabled = true;
        try {
          if (reference && !panel.canAddReference()) throw Error('Выбери новый файл до добавления материалов; предел — 8, только до отправки задачи.');
          const result = await bridge.pickTarget({ version: 1, requestId: crypto.randomUUID(), access, ...(multi ? { source: boot.source } : {}) });
          if (!live() || result?.status === 'cancelled') return;
          if (result?.status !== 'selected') throw Error('Выбор файла не подтверждён хостом.');
          const catalog = await readTargets();
          if (!live()) return;
          const target = catalog.find(item => item.selectionId === result.selection.selectionId);
          if (!target) throw Error('Выбранная цель уже недоступна.');
          panel.updateTargets(catalog, reference ? panel.draft().target : target.key);
          if (reference) panel.addReference(target.key);
        } catch (cause) { if (live()) alert.textContent = cause.message || String(cause); }
        finally { choosing = false; if (live()) for (const control of toolbar.children) control.disabled = false; }
      }, toolbar);
    }
    if (computer) {
      button('Выбрать окно для наблюдения', async () => {
        if (!live() || choosing || switching) return; choosing = true; alert.textContent = '';
        for (const control of toolbar.children) control.disabled = true;
        try {
          if (typeof bridge.prepareComputerUse === 'function') await bridge.prepareComputerUse();
          const picked = await bridge.pickWindow({ version: 1, requestId: crypto.randomUUID(), source: boot.computerSource });
          if (!live() || picked?.status === 'cancelled') return;
          if (picked?.status === 'empty') { alert.textContent = 'Нет доступных окон для выбора.'; return; }
          if (picked?.status !== 'selected') throw Error('Выбор окна не подтверждён.');
          const catalog = await readTargets(); if (!live()) return;
          const target = catalog.find(item => item.selectionId === picked.selection.selectionId && item.access === 'computer-observe');
          if (!target) throw Error('Выбранное окно уже недоступно.');
          panel.updateTargets(catalog, target.key);
          alert.textContent = 'Разрешено только наблюдение до ' + new Date(target.expiresAt).toLocaleTimeString('ru-RU') + '. Клики и ввод не разрешены.';
        } catch (cause) { if (live()) alert.textContent = cause.message || String(cause); }
        finally { choosing = false; if (live()) for (const control of toolbar.children) control.disabled = false; }
      }, toolbar);
      button('Отозвать выбор окна', async () => {
        if (!live() || choosing || switching) return; choosing = true; alert.textContent = '';
        for (const control of toolbar.children) control.disabled = true;
        try {
          const catalog = await readTargets(); if (!live()) return;
          const target = catalog.find(item => item.key === panel.draft().target && item.access === 'computer-observe');
          if (!target) throw Error('Сначала выбери окно из списка целей.');
          await bridge.windowSelections({ version: 1, kind: 'revoke', selectionId: target.selectionId, source: boot.computerSource });
          const next = await readTargets(); if (!live()) return;
          panel.updateTargets(next, ''); alert.textContent = 'Выбор окна отозван. Сохранённый снимок остаётся историческим результатом.';
        } catch (cause) { if (live()) alert.textContent = cause.message || String(cause); }
        finally { choosing = false; if (live()) for (const control of toolbar.children) control.disabled = false; }
      }, toolbar);
      if (computerActions) button('Подготовить действие из снимка', () => {
        if (!live() || choosing || switching) return;
        const retained = panel.currentObservation();
        if (!retained) { alert.textContent = 'Сначала заверши наблюдение и нажми «Показать сохранённое наблюдение».'; return; }
        const elements = retained.observation.elements.filter(item => item && typeof item.elementId === 'string'
          && item.enabled === true && item.offscreen === false && item.password !== true);
        const editor = document.createElement('section'); editor.className = 'astra-turn-panel astra-action-editor';
        editor.setAttribute('aria-label', 'Подготовка точного действия');
        const heading = document.createElement('h3'); heading.textContent = 'Подготовить точное действие';
        const warning = document.createElement('p'); warning.className = 'astra-note';
        warning.textContent = 'Это ещё не разрешение. Перед единственным вводом Astra отдельно покажет точную карточку подтверждения.';
        const kind = document.createElement('select'); kind.setAttribute('aria-label', 'Тип действия');
        for (const [value, label] of [['type', 'Ввести текст'], ['click', 'Клик'], ['scroll', 'Прокрутка'], ['key', 'Клавиша'], ['close', 'Закрыть окно']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = label; kind.append(option);
        }
        const targetElement = document.createElement('select'); targetElement.setAttribute('aria-label', 'Элемент окна');
        for (const item of elements) { const option = document.createElement('option'); option.value = item.elementId;
          option.textContent = [item.controlType, item.name, item.value].filter(value => typeof value === 'string' && value).join(' · ').slice(0, 220)
            || 'Элемент ' + item.elementId; targetElement.append(option); }
        const text = document.createElement('textarea'); text.rows = 3; text.setAttribute('aria-label', 'Точный текст действия');
        const textMode = document.createElement('select'); textMode.setAttribute('aria-label', 'Режим текста');
        for (const [value, label] of [['replace', 'Заменить значение'], ['insert', 'Вставить в позицию']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = label; textMode.append(option);
        }
        const mouseButton = document.createElement('select'); mouseButton.setAttribute('aria-label', 'Кнопка мыши');
        for (const value of ['left', 'right', 'middle']) { const option = document.createElement('option'); option.value = value; option.textContent = value; mouseButton.append(option); }
        const clicks = document.createElement('select'); clicks.setAttribute('aria-label', 'Число кликов');
        for (const value of ['1', '2']) { const option = document.createElement('option'); option.value = value; option.textContent = value; clicks.append(option); }
        const delta = document.createElement('input'); delta.type = 'number'; delta.min = '-1200'; delta.max = '1200'; delta.step = '1'; delta.value = '-360';
        delta.setAttribute('aria-label', 'Величина прокрутки');
        const key = document.createElement('select'); key.setAttribute('aria-label', 'Клавиша');
        for (const value of ['enter', 'escape', 'tab', 'backspace', 'delete', 'space', 'left', 'right', 'up', 'down', 'home', 'end',
          'pageup', 'pagedown', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
          'a', 'c', 'f', 'l', 'n', 'o', 'p', 'r', 's', 't', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
          const option = document.createElement('option'); option.value = value; option.textContent = value; key.append(option);
        }
        const modifiers = document.createElement('div'); modifiers.className = 'astra-actions';
        const modifierInputs = ['ctrl', 'alt', 'shift'].map(value => { const label = document.createElement('label'), input = document.createElement('input');
          input.type = 'checkbox'; input.value = value; label.append(input, document.createTextNode(' ' + value)); modifiers.append(label); return input; });
        const makeField = (labelText, control) => { const label = document.createElement('label'); label.className = 'astra-field';
          const caption = document.createElement('span'); caption.textContent = labelText; label.append(caption, control); editor.append(label); return label; };
        editor.append(heading, warning); const kindField = makeField('Действие', kind), elementField = makeField('Точный элемент из снимка', targetElement),
          textField = makeField('Текст без скрытого обрезания пробелов', text), modeField = makeField('Режим текста', textMode),
          buttonField = makeField('Кнопка мыши', mouseButton), clicksField = makeField('Клики', clicks),
          deltaField = makeField('Прокрутка: от -1200 до 1200', delta), keyField = makeField('Клавиша', key), modifierField = makeField('Модификаторы', modifiers);
        const controls = document.createElement('div'); controls.className = 'astra-actions'; editor.append(controls);
        const sync = () => { const value = kind.value, element = ['type', 'click', 'scroll'].includes(value);
          elementField.hidden = !element; textField.hidden = modeField.hidden = value !== 'type'; buttonField.hidden = clicksField.hidden = value !== 'click';
          deltaField.hidden = value !== 'scroll'; keyField.hidden = modifierField.hidden = value !== 'key'; };
        kind.addEventListener('change', sync); sync();
        button('Отмена', () => editor.remove(), controls);
        button('Сохранить план без разрешения на ввод', async () => {
          if (!live() || choosing) return; choosing = true; alert.textContent = '';
          try {
            let action;
            if (kind.value === 'type') action = { kind: 'type', elementId: targetElement.value, text: text.value, textMode: textMode.value };
            else if (kind.value === 'click') action = { kind: 'click', elementId: targetElement.value, button: mouseButton.value, clicks: Number(clicks.value) };
            else if (kind.value === 'scroll') action = { kind: 'scroll', elementId: targetElement.value, deltaY: Number(delta.value) };
            else if (kind.value === 'key') action = { kind: 'key', key: key.value, modifiers: modifierInputs.filter(input => input.checked).map(input => input.value) };
            else action = { kind: 'close' };
            const plan = await bridge.issueComputerAction({ version: 1, requestId: crypto.randomUUID(), taskId: retained.taskId,
              action, source: boot.computerSource });
            const catalog = await readTargets(); if (!live()) return;
            const target = catalog.find(item => item.selectionId === plan.selectionId && item.access === 'computer-action');
            if (!target) throw Error('Хост не подтвердил сохранённый план.');
            panel.updateTargets(catalog, target.key); editor.remove();
            alert.textContent = 'План сохранён без права ввода до ' + new Date(target.expiresAt).toLocaleTimeString('ru-RU')
              + '. Отправь задачу и отдельно проверь карточку подтверждения.';
          } catch (cause) { if (live()) alert.textContent = cause.message || String(cause); }
          finally { choosing = false; }
        }, controls);
        body.querySelector('.astra-action-editor')?.remove(); body.insertBefore(editor, panelRoot);
      }, toolbar);
      button('Отозвать план действия', async () => {
        if (!live() || choosing || switching) return; choosing = true; alert.textContent = '';
        try {
          const catalog = await readTargets(); if (!live()) return;
          const target = catalog.find(item => item.key === panel.draft().target && item.access === 'computer-action');
          if (!target) throw Error('Сначала выбери план действия из списка целей.');
          await bridge.computerActionPlans({ version: 1, kind: 'revoke', selectionId: target.selectionId, source: boot.computerSource });
          const next = await readTargets(); if (!live()) return; panel.updateTargets(next, '');
          alert.textContent = 'План действия отозван. Он больше не может быть отправлен или подтверждён.';
        } catch (cause) { if (live()) alert.textContent = cause.message || String(cause); }
        finally { choosing = false; }
      }, toolbar);
    }
    navigation.replaceChildren(); navigation.hidden = !multi;
    if (!multi) return;
    const select = document.createElement('select'); select.setAttribute('aria-label', 'Разговор Astra');
    for (const entry of boot.conversations) { const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.label; select.append(option); }
    select.value = boot.conversationId; navigation.append(select);
    select.addEventListener('change', () => { const conversationId = select.value; select.value = boot.conversationId; void transition({ kind: 'select', conversationId }); });
    button('Новый разговор', () => void transition({ kind: 'create', requestId: crypto.randomUUID() }), navigation);
    const history = document.createElement('section'); history.className = 'astra-turn-panel'; history.setAttribute('aria-label', 'История разговора');
    const heading = document.createElement('h3'); heading.textContent = 'Сохранённая история';
    const historyNote = document.createElement('p'); historyNote.className = 'astra-note';
    historyNote.textContent = 'По 4 сообщения за запрос. Это история, а не новые команды. Черновики сохраняются только до закрытия страницы.';
    const rows = document.createElement('div'), historyError = document.createElement('p'), controls = document.createElement('div');
    historyError.className = 'astra-error'; historyError.setAttribute('role', 'alert'); controls.className = 'astra-actions';
    history.append(heading, historyNote, rows, historyError, controls); body.append(history);
    let loading = false, before = null;
    const newest = button('Обновить историю', () => void loadHistory(), controls);
    const older = button('Предыдущие сообщения', () => void loadHistory(before), controls); older.hidden = true;
    async function loadHistory(cursor) {
      if (!live() || loading) return; loading = true; newest.disabled = older.disabled = true; historyError.textContent = '';
      try {
        const result = await bridge.conversations({ version: 1, kind: 'history', source: boot.source, ...(cursor ? { before: cursor } : {}) });
        if (!live()) return;
        if (result?.conversationId !== boot.conversationId || !Array.isArray(result.messages) || result.messages.length > 4)
          throw Error('История относится к другому источнику или превышает лимит.');
        rows.replaceChildren();
        for (const message of result.messages) {
          const row = document.createElement('article'), label = document.createElement('small'), text = document.createElement('pre');
          row.dataset.messageId = message.messageId; label.className = 'astra-note'; text.className = 'astra-result';
          label.textContent = (message.role === 'user' ? 'Ты' : 'Astra') + ' · задача ' + message.turnId
            + (message.causalParentId ? ' · ответ на ' + message.causalParentId : '');
          text.textContent = message.content; row.append(label, text); rows.append(row);
        }
        if (result.availability === 'not-found') historyError.textContent = 'История пока не найдена в хранилище. Это не отменяет задачу и не подтверждает доставку результата.';
        before = result.before; older.hidden = !result.hasMore;
      } catch (cause) { if (live()) historyError.textContent = 'История недоступна: ' + (cause.message || String(cause)); }
      finally { loading = false; if (live()) newest.disabled = older.disabled = false; }
    }
    void loadHistory();
  }
  try { await activate(await bridge.bootstrap()); } catch (error) { retire(); shell.remove(); throw error; }
  return { dispose() { disposed = true; retire(); drafts.clear(); shell.remove(); } };
}
