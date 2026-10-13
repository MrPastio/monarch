import { createOscarAstraTurn, sendOscarAstraInput, controlOscarAstraTurn, recoverOscarAstraTurn, fetchOscarTurn,
  fetchOscarTurnByClientRequestId, streamOscarTurn, cancelOscarTurnSubmission, fetchAstraComputerObservation } from './api.js';

const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);
const id = () => crypto.randomUUID();
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

/** Labels are display-only; the backend still resolves the immutable selection. */
export function astraSelectionTargets(response) {
  if (!Array.isArray(response?.selections) || response.selections.length > 64) throw Error('Не удалось открыть список выбранных файлов.');
  return response.selections.flatMap(selection => {
    if (!validId(selection.selectionId) || !Array.isArray(selection.targets)
      || selection.targets.length < 1 || selection.targets.length > 32)
      throw Error('Список выбранных файлов повреждён. Выбери их заново.');
    const admitted = selection.targets.map(target => {
      if (!validId(target.targetId) || typeof target.label !== 'string' || target.label.length > 1024
        || !['observe', 'exclusive-create'].includes(target.access)) throw Error('Один из выбранных файлов недоступен. Выбери его заново.');
      return { key: selection.selectionId + '_' + target.targetId, selectionId: selection.selectionId, targetId: target.targetId,
        access: target.access, label: (target.access === 'observe' ? 'Прочитать ' : 'Создать ') + target.label };
    });
    if (admitted.length <= 1) return admitted;
    if (admitted.length > 8) throw Error('За один раз можно выбрать не больше 8 файлов.');
    if (!admitted.every(target => target.access === 'observe')) throw Error('Группа выбранных файлов повреждена. Выбери её заново.');
    const names = selection.targets.map(target => target.label).join(' · ').slice(0, 900);
    return [{ key: selection.selectionId + '_all', selectionId: selection.selectionId,
      targetIds: admitted.map(target => target.targetId), access: 'observe',
      label: `Прочитать ${admitted.length} ${admitted.length <= 4 ? 'файла' : 'файлов'} · ${names}` }];
  });
}

export function astraWindowTargets(selections) {
  if (!Array.isArray(selections) || selections.length > 32) throw Error('Некорректный список окон Astra.');
  return selections.map(item => {
    if (!validId(item.selectionId) || item.authority !== 'observe' || item.authorizesInput !== false
      || typeof item.title !== 'string' || item.title.length > 4096 || typeof item.processName !== 'string'
      || item.processName.length > 256 || !Number.isSafeInteger(item.expiresAt)) throw Error('Некорректный выбор окна.');
    return { key: 'window_' + item.selectionId, selectionId: item.selectionId, access: 'computer-observe', expiresAt: item.expiresAt,
      label: 'Наблюдать окно · ' + item.processName + ' · ' + item.title.slice(0, 160) };
  });
}

/** Display descriptors for exact plans already issued by the trusted host. The
 * renderer cannot construct an action, select a native handle or grant input. */
export function astraActionTargets(plans) {
  if (!Array.isArray(plans) || plans.length > 32) throw Error('Не удалось открыть список доступных действий.');
  return plans.map(item => {
    if (!validId(item.selectionId) || item.authority !== 'approval-required' || item.grantScope !== 'none'
      || typeof item.title !== 'string' || item.title.length > 4096 || typeof item.summary !== 'string'
      || !item.summary.trim() || item.summary.length > 1024 || !Number.isSafeInteger(item.expiresAt))
      throw Error('Выбранное действие устарело или повреждено. Выбери его заново.');
    return { key: 'action_' + item.selectionId, selectionId: item.selectionId, access: 'computer-action', expiresAt: item.expiresAt,
      authority: 'approval-required', grantScope: 'none',
      label: 'Действие с подтверждением · ' + item.title.slice(0, 120) + ' · ' + item.summary.slice(0, 160) };
  });
}

/** This descriptor comes from an explicit trusted host bootstrap, never model
 * text. It displays already selected handles; it is NOT a filesystem picker or
 * grant. The source compiler independently resolves every submitted handle. */
export function astraGoalRequest(config, value, identity) {
  if (config?.deployment !== 'isolated-validation' || !validId(config.conversationId)
    || !validId(identity?.clientRequestId) || !validId(identity?.inputMessageId)) throw Error('Не удалось безопасно начать задачу.');
  const target = config.targets?.find(item => item.key === value.target);
  const hasGroupedTargets = target?.targetIds !== undefined;
  const groupedTargetIds = Array.isArray(target?.targetIds) ? target.targetIds : null;
  const targetIdentity = hasGroupedTargets ? Boolean(groupedTargetIds
    && target?.access === 'observe' && target.targetId === undefined && groupedTargetIds.length >= 2 && groupedTargetIds.length <= 8
    && groupedTargetIds.every(validId) && new Set(groupedTargetIds).size === groupedTargetIds.length)
    : ['computer-observe', 'computer-action'].includes(target?.access) || validId(target?.targetId);
  if (!target || !validId(target.selectionId) || !targetIdentity
    || !['observe', 'exclusive-create', 'computer-observe', 'computer-action'].includes(target.access)) throw Error('Выбранная цель недоступна.');
  const maxTextBytes = target.access === 'observe' ? 8192 : 4096;
  if (typeof value.text !== 'string' || !value.text.trim() || new TextEncoder().encode(value.text).length > maxTextBytes)
    throw Error(`Введи задачу длиной до ${maxTextBytes} байт UTF-8.`);
  if (target.access === 'computer-observe') {
    if (config.computerObservation !== true || !Number.isSafeInteger(target.expiresAt) || target.expiresAt <= Date.now()
      || value.references?.length) throw Error('Выбор окна истёк или недоступен. Выбери окно заново.');
    return { version: 1, clientRequestId: identity.clientRequestId, conversationId: config.conversationId, inputMessageId: identity.inputMessageId,
      text: value.text, privacyMode: 'persistent', astra: { selectionId: target.selectionId, goal: { kind: 'computer-observe' } } };
  }
  if (target.access === 'computer-action') {
    if (config.computerActions !== true || target.authority !== 'approval-required' || target.grantScope !== 'none'
      || !Number.isSafeInteger(target.expiresAt) || target.expiresAt <= Date.now()
      || value.references?.length) throw Error('План действия истёк или недоступен. Выбери действие заново.');
    return { version: 1, clientRequestId: identity.clientRequestId, conversationId: config.conversationId, inputMessageId: identity.inputMessageId,
      text: value.text, privacyMode: 'persistent', astra: { selectionId: target.selectionId, goal: { kind: 'computer-action' } } };
  }
  let maxModel = null;
  if (value.modelMode === 'local') {
    if (config.localAnalysis !== true || target.access !== 'observe' || value.modelChoice !== undefined
      || value.previewAcknowledged !== undefined) throw Error('Локальный анализ недоступен для этой задачи.');
    maxModel = { modelMode: 'local' };
  } else if (value.modelMode !== undefined) {
    if (value.modelMode !== 'max') throw Error('Режим модели недоступен для этой задачи.');
    maxModel = { modelMode: 'max' };
    if (value.modelChoice !== undefined) {
      if (String(value.modelChoice).startsWith('max-cloud:')) throw Error('Этот способ работы с выбранным файлом пока доступен только через Groq. Для другого сервиса добавь файл обычным вложением в чат или опиши задачу сообщением.');
      if (!['gpt-oss-120b', 'qwen-3.8-27b'].includes(value.modelChoice)) throw Error('Выбранная модель MAX недоступна.');
      maxModel.modelChoice = value.modelChoice;
    }
    if (value.modelChoice === 'qwen-3.8-27b') {
      if (value.previewAcknowledged !== true) throw Error('Подтверди тестовый статус Qwen.');
      maxModel.previewAcknowledged = true;
    } else if (value.previewAcknowledged !== undefined) throw Error('Некорректное подтверждение модели MAX.');
  } else if (value.modelChoice !== undefined || value.previewAcknowledged !== undefined) {
    throw Error('Сначала выбери MAX.');
  }
  if (target.access === 'observe') {
    if (value.references?.length) throw Error('Материалы нельзя добавлять к чтению выбранного файла.');
    const targetIds = groupedTargetIds || [target.targetId];
    return { version: 1, clientRequestId: identity.clientRequestId, conversationId: config.conversationId, inputMessageId: identity.inputMessageId,
      text: value.text, privacyMode: 'persistent', astra: { selectionId: target.selectionId,
        goal: maxModel ? { kind: 'analyze', targets: targetIds, ...maxModel }
          : { kind: 'observe', targets: targetIds } } };
  }
  if (!['literal', 'reply', 'draft'].includes(value.contentKind)) throw Error('Неизвестный источник содержимого.');
  const content = value.contentKind === 'literal' ? { kind: 'literal', text: value.content } : { kind: value.contentKind };
  if (maxModel) {
    if (content.kind !== 'draft') throw Error('Режим модели недоступен для этой задачи.');
    Object.assign(content, maxModel);
  }
  if (value.references !== undefined) {
    if (!Array.isArray(value.references) || value.references.length > 8 || new Set(value.references).size !== value.references.length)
      throw Error('Можно выбрать до 8 разных материалов.');
    if (value.references.length) {
      if (config.referenceInputs !== true || target.access !== 'exclusive-create' || content.kind !== 'draft')
        throw Error('Материалы доступны только для черновика нового файла.');
      content.references = value.references.map(key => {
        const input = config.targets.find(item => item.key === key);
        if (!input || input.access !== 'observe' || !validId(input.selectionId) || !validId(input.targetId)
          || Array.isArray(input.targetIds))
          throw Error('Материал недоступен. Убери его из списка или выбери заново.');
        return { selectionId: input.selectionId, target: input.targetId };
      });
    }
  }
  if (content.kind === 'literal' && (typeof content.text !== 'string' || new TextEncoder().encode(content.text).length > 16384))
    throw Error('Содержимое слишком большое. Сократи его и попробуй снова.');
  return { version: 1, clientRequestId: identity.clientRequestId, conversationId: config.conversationId, inputMessageId: identity.inputMessageId,
    text: value.text, privacyMode: 'persistent', astra: { selectionId: target.selectionId,
      goal: { kind: 'create', target: target.targetId, content } } };
}

/** Project durable events, not model claims. Consumed cards must not reappear
 * while the existing outbox is still applying an accepted input. */
export function astraTurnView(checkpoint) {
  const turn = checkpoint?.turn;
  if (!turn?.request?.astra || !validId(turn.id)) throw Error('Не удалось прочитать состояние задачи.');
  const events = [...(checkpoint.events || [])].sort((a, b) => a.sequence - b.sequence);
  const projections = events.filter(event => event.type === 'agent.progress' && event.payload?.runtime === 'astra-v3');
  // Projection itself may fail, producing an issue without a new snapshot/hash.
  // Only a later actual projection clears it; input/control events cannot do so.
  const latestState = projections.filter(event => event.payload.astraProjection || event.payload.runtimeIssue).at(-1);
  const projectedStatus = projections.filter(event => event.payload.astraProjection).at(-1)?.payload.status;
  // Oscar `succeeded` means the terminal result was durably delivered. Preserve
  // Astra's narrower partial outcome instead of presenting delivery as task success.
  const status = turn.status === 'succeeded' && projectedStatus === 'partial' ? 'partial'
    : terminal.has(turn.status) ? turn.status : projectedStatus || turn.status;
  const consumed = projections.filter(event => event.payload.astraInputId).at(-1)?.sequence || 0;
  const card = events.filter(event => event.payload?.runtime === 'astra-v3' && event.sequence > consumed
    && (event.type === 'user.input.required' && turn.status === 'waiting-for-user'
      || event.type === 'approval.required' && turn.status === 'waiting-for-approval' && event.payload.id === turn.activeApprovalId)).at(-1);
  return { turn, status, terminal: terminal.has(turn.status), card: terminal.has(turn.status) ? null : card || null,
    sequence: events.at(-1)?.sequence || 0, summary: turn.outcome?.summary || '',
    issue: latestState?.payload.runtimeIssue || null };
}

export function astraCardInput(card, answer, identity) {
  const data = card?.payload;
  if (!validId(data?.id) || !digest(data?.digest) || !validId(identity?.messageId)) throw Error('Это подтверждение устарело. Обнови состояние задачи.');
  if (card.type === 'approval.required') {
    if (!['approve', 'reject'].includes(answer)) throw Error('Требуется точное решение по действию.');
    return { kind: 'decide', decision: { approvalId: data.id, approvalDigest: data.digest, messageId: identity.messageId, decision: answer } };
  }
  if (card.type !== 'user.input.required' || !validId(identity.requestId) || typeof answer !== 'string') throw Error('Требуется точный ответ.');
  return { kind: 'reply', reply: { requestId: identity.requestId, questionId: data.id, questionDigest: data.digest,
    messageId: identity.messageId, text: answer } };
}

const labels = { admitted: 'Принято', queued: 'В очереди', running: 'Выполняется', preparing: 'Подготовка',
  'waiting-for-user': 'Нужен ответ', 'awaiting-input': 'Нужен ответ', 'awaiting-user': 'Нужен ответ', 'waiting-for-approval': 'Нужно разрешение',
  'awaiting-approval': 'Нужно разрешение', paused: 'На паузе', pausing: 'Останавливается', cancelling: 'Отмена запрошена',
  indeterminate: 'Результат действия неизвестен — повтор запрещён', succeeded: 'Обработка завершена', partial: 'Завершено не полностью',
  failed: 'Ошибка', blocked: 'Заблокировано', cancelled: 'Отменено', expired: 'Срок истёк' };
const issueMessages = Object.freeze({
  'progression-failed': 'Не удалось продолжить задачу. Проверь её состояние ещё раз.',
  'recovery-required': 'После сбоя нужно проверить состояние задачи. Оскар не будет повторять действие автоматически.',
  'host-unavailable': 'Оскар временно недоступен. Проверь задачу ещё раз, когда подключение восстановится.',
  'source-restore-required': 'Нужно заново выбрать недоступный файл или окно.',
  'source-projection-failed': 'Не удалось обновить состояние задачи. Выполненное действие не будет повторено автоматически.',
});
export function astraHumanIssue(issue) {
  const code = typeof issue === 'string' ? issue : issue?.code || issue?.kind;
  return typeof code === 'string' && Object.hasOwn(issueMessages, code) ? issueMessages[code]
    : 'Не удалось достоверно определить состояние задачи. Проверь её ещё раз.';
}
export function astraElapsedLabel(turn) {
  const startedAt = Date.parse(String(turn?.createdAt || ''));
  const finishedAt = Date.parse(String(turn?.outcome?.completedAt || turn?.updatedAt || ''));
  const elapsed = finishedAt - startedAt;
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || elapsed < 0 || elapsed > 31 * 24 * 60 * 60 * 1000) return '';
  if (elapsed < 1000) return 'Время работы: меньше секунды';
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `Время работы: ${seconds} сек`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (minutes < 60) return `Время работы: ${minutes} мин${rest ? ` ${rest} сек` : ''}`;
  const hours = Math.floor(minutes / 60), restMinutes = minutes % 60;
  return `Время работы: ${hours} ч${restMinutes ? ` ${restMinutes} мин` : ''}`;
}
/** The badge states what the panel actually guarantees, never a mode.
 * `localAnalysis` only advertises that the local-model read option is offered
 * for this conversation; every panel runs the same isolated deployment, so the
 * absence of that option is not a test run and must not be labelled one. */
export function astraDeploymentBadge(config) {
  return config?.localAnalysis === true ? 'Локальный анализ' : 'Только выбранное';
}
function node(tag, text, className) {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text;
  if (className) element.className = className; return element;
}
function taskErrorMessage(cause) {
  if (cause?.code === 'astra-model-mode-required') return 'Выбери MAX в меню моделей и отправь задачу снова.';
  if (typeof cause?.message === 'string' && /[А-Яа-яЁё]/u.test(cause.message) && !/astra|runtime|sha256/iu.test(cause.message)) return cause.message;
  return 'Не удалось начать задачу. Проверь выбранные файлы и попробуй снова.';
}
function button(text, action) { const element = node('button', text); element.type = 'button'; element.addEventListener('click', action); return element; }
function field(text, element) {
  const label = node('label'); element.setAttribute('aria-label', text);
  label.append(node('span', text), element); return label;
}

/** One UI owner only. No executor, polling timer, auto-approval or localStorage.
 * dispose() closes UI subscriptions; it NEVER cancels an admitted durable task. */
export function mountAstraTurnPanel(container, inputConfig, lifecycle = {}, view = {}) {
  const config = structuredClone(inputConfig);
  if (config?.deployment !== 'isolated-validation' || !validId(config.conversationId) || !Array.isArray(config.targets)
    || config.targets.length > 2048 || new Set(config.targets.map(t => t.key)).size !== config.targets.length
    || config.pendingRequestId && (!validId(config.pendingRequestId) || config.turnId)
    || typeof lifecycle.onSubmissionPending !== 'function' || typeof lifecycle.onSubmissionCancelled !== 'function'
    || typeof lifecycle.onTurnLinked !== 'function')
    throw Error('Не удалось безопасно открыть задачи Оскара.');
  const composer = view.composer;
  if (composer && (!(composer.form instanceof HTMLFormElement) || !(composer.input instanceof HTMLTextAreaElement)
    || !(composer.submit instanceof HTMLButtonElement) || !(composer.stop instanceof HTMLButtonElement)
    || ![composer.input, composer.submit, composer.stop].every(element => composer.form.contains(element))))
    throw Error('Не удалось открыть поле ввода Оскара.');
  const listeners = new AbortController();
  const root = node('section', undefined, 'astra-turn-panel'); root.setAttribute('aria-label', 'Работа Оскара');
  const heading = node('header'); heading.append(node('strong', 'Оскар'), node('span', astraDeploymentBadge(config), 'astra-badge'));
  const note = node('p', 'Оскар работает только с файлами и окнами, которые ты выбрал для этой задачи.', 'astra-note');
  const form = composer?.form || node('form'), target = node('select'), kind = node('select'), text = composer?.input || node('textarea'), content = node('textarea');
  for (const entry of config.targets) { const option = node('option', entry.label); option.value = entry.key; target.append(option); }
  const readMode = node('select');
  for (const [value, label] of [['observe', 'Прочитать точное содержимое'], ['analyze', 'Проанализировать локальной моделью']]) {
    const option = node('option', label); option.value = value; readMode.append(option);
  }
  const readModeField = field('Работа с файлом', readMode);
  for (const [value, label] of [['literal', 'Записать мой текст'], ['reply', 'Сначала уточнить содержимое'], ['draft', 'Подготовить черновик']]) {
    const option = node('option', label); option.value = value; kind.append(option);
  }
  text.rows = 3; content.rows = 5; const kindField = field('Как подготовить файл', kind), contentField = field('Содержимое файла — без изменений', content);
  const start = composer?.submit || node('button', 'Выполнить выбранное действие'); start.type = 'submit';
  const references = new Map(), referenceField = node('fieldset', undefined, 'astra-references'), referenceList = node('div'), referenceSelect = node('select');
  const referenceAdd = button('Добавить материал из списка', () => {
    try { addReference(referenceSelect.value); } catch (cause) { error.textContent = cause.message; }
  });
  referenceField.append(node('legend', 'Материалы для черновика'),
    node('p', 'Можно добавить до 8 выбранных файлов. Оскар сначала прочитает их, затем покажет черновик перед записью.', 'astra-note'),
    referenceList, field('Доступный материал', referenceSelect), referenceAdd);
  const sourceFields = composer ? node('div', undefined, 'astra-composer-options astra-turn-panel') : form;
  sourceFields.append(node('h3', 'Что сделать'), field('Выбранная цель', target), ...(composer ? [] : [field('Задача', text)]), kindField, contentField, referenceField);
  sourceFields.insertBefore(readModeField, kindField);
  if (composer) form.prepend(sourceFields); else form.append(start);
  const result = node('div'), error = node('p', '', 'astra-error'); error.setAttribute('role', 'alert');
  const notice = node('p', '', 'astra-status'); notice.setAttribute('role', 'status'); notice.hidden = true;
  const recovery = node('div', undefined, 'astra-actions');
  root.append(heading, note, result, ...(composer ? [] : [form]), error, notice, recovery); container.append(root);
  if (!document.querySelector('link[data-astra-panel-style]')) {
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = new URL('./astra-turn-panel.css', import.meta.url).href;
    style.dataset.astraPanelStyle = ''; document.head.append(style);
  }
  let current = null, pending = null, busy = false, disposed = false, stream = null, refresh = null, generation = 0;
  let lastCardKey = '', replyDraft = '', observationDetail = null, observationLoading = false;
  // Ephemeral same-conversation draft, never persisted history or authority.
  if (view.draft) {
    text.value = view.draft.text; content.value = view.draft.content; kind.value = view.draft.kind;
    if (view.draft.readMode === 'analyze') readMode.value = 'analyze';
    if (config.targets.some(item => item.key === view.draft.target)) target.value = view.draft.target;
    replyDraft = view.draft.replyDraft; lastCardKey = view.draft.lastCardKey;
    if (view.draft.references) {
      if (!Array.isArray(view.draft.references) || view.draft.references.length > 8) throw Error('Некорректный список материалов черновика.');
      for (const item of view.draft.references) {
        if (typeof item.key !== 'string' || typeof item.label !== 'string' || item.label.length > 1100 || references.has(item.key))
          throw Error('Некорректный материал черновика.');
        references.set(item.key, item.label);
      }
    }
  }
  const editable = () => !disposed && !busy && !pending && (!current || current.terminal);
  function canAddReference() { return config.referenceInputs === true && editable() && references.size < 8
    && config.targets.find(item => item.key === target.value)?.access === 'exclusive-create'; }
  function addReference(key) {
    const input = config.targets.find(item => item.key === key);
    if (!canAddReference() || !input || input.access !== 'observe' || !validId(input.targetId)
      || Array.isArray(input.targetIds) || references.has(key))
      throw Error('Сначала выбери новый файл; можно добавить до 8 разных материалов до отправки задачи.');
    references.set(key, input.label); kind.value = 'draft'; syncForm();
  }
  function syncReferences() {
    if (config.referenceInputs !== true) return;
    const old = referenceSelect.value; referenceSelect.replaceChildren();
    const empty = node('option', 'Выбери материал'); empty.value = ''; referenceSelect.append(empty);
    for (const input of config.targets.filter(item => item.access === 'observe' && validId(item.targetId)
      && !Array.isArray(item.targetIds) && !references.has(item.key))) {
      const option = node('option', input.label); option.value = input.key; referenceSelect.append(option);
    }
    referenceSelect.value = old; if (referenceSelect.selectedIndex < 0) referenceSelect.value = '';
    referenceList.replaceChildren();
    if (!references.size) referenceList.append(node('p', 'Материалы не добавлены.', 'astra-note'));
    for (const [key, label] of references) {
      const available = config.targets.find(item => item.key === key && item.access === 'observe');
      const row = node('div', undefined, 'astra-reference-row'); row.dataset.astraReference = key;
      row.append(node('span', available ? available.label : label + ' — недоступен', available ? '' : 'astra-error'));
      const remove = button('Убрать', () => { if (editable()) { references.delete(key); syncForm(); } });
      remove.setAttribute('aria-label', 'Убрать материал: ' + label); remove.disabled = !editable(); row.append(remove); referenceList.append(row);
    }
    referenceSelect.disabled = !canAddReference(); referenceAdd.disabled = !canAddReference() || !referenceSelect.value;
  }
  const syncForm = () => {
    const create = config.targets.find(item => item.key === target.value)?.access === 'exclusive-create';
    kindField.hidden = !create; contentField.hidden = !create || kind.value !== 'literal';
    readModeField.hidden = config.localAnalysis !== true || config.targets.find(item => item.key === target.value)?.access !== 'observe';
    referenceField.hidden = config.referenceInputs !== true || !create || kind.value !== 'draft';
    const active = Boolean(current && !current.terminal);
    form.hidden = !composer && active;
    if (composer) sourceFields.hidden = active; // Keep the ordinary Stop reachable.
    for (const element of [target, kind, text, content, start, readMode]) element.disabled = !config.targets.length || busy || Boolean(pending) || Boolean(current && !current.terminal);
    if (composer) { start.hidden = false; composer.stop.hidden = !pending && (!current || current.terminal); composer.stop.disabled = busy; }
    syncReferences();
  };
  referenceSelect.addEventListener('change', () => { referenceAdd.disabled = !canAddReference() || !referenceSelect.value; });
  target.addEventListener('change', syncForm); kind.addEventListener('change', syncForm); syncForm();
  async function accept(checkpoint) {
    const expectedGeneration = generation;
    const next = astraTurnView(checkpoint);
    if (next.turn.conversationId !== config.conversationId) throw Error('Ответ относится к другому разговору.');
    if (current && next.turn.id === current.turn.id && next.turn.revision < current.turn.revision) return;
    const changed = current?.turn.id !== next.turn.id;
    if (changed) observationDetail = null;
    if (changed) await lifecycle.onTurnLinked(next.turn.id);
    if (disposed || generation !== expectedGeneration) return;
    if (current && next.turn.id === current.turn.id && next.turn.revision < current.turn.revision) return;
    current = next; render();
  }
  function render() {
    if (disposed) return;
    const focusedReply = document.activeElement?.dataset?.astraReply === 'true' ? document.activeElement : null;
    const caret = focusedReply ? [focusedReply.selectionStart, focusedReply.selectionEnd] : null;
    syncForm(); result.replaceChildren(); recovery.replaceChildren();
    if (pending && !busy) {
      recovery.append(button(pending.kind === 'lookup' ? 'Проверить отправку' : 'Повторить тот же запрос',
        () => void (pending.kind === 'lookup' ? lookupPending() : sendPending())));
      if (pending.kind === 'create' || pending.kind === 'lookup') recovery.append(button('Отменить отправку', () => void cancelPendingSource()));
    }
    if (!current) return;
    const status = node('p', labels[current.status] || 'Состояние обновляется', 'astra-status'); status.setAttribute('role', 'status'); result.append(status);
    result.append(node('p', current.turn.request.text, 'astra-source-text'));
    if (current.summary) result.append(node('pre', current.summary, 'astra-result'));
    if (current.turn.request.astra.goal.kind === 'computer-observe') {
      result.append(node('p', 'Это сохранённый снимок окна. При просмотре Оскар не нажимает кнопки и не вводит текст.', 'astra-note'));
      if (current.terminal && current.status === 'succeeded') {
        const show = button(observationLoading ? 'Загрузка наблюдения…' : 'Показать сохранённое наблюдение', () => void loadObservation());
        show.disabled = observationLoading; result.append(show);
        if (observationDetail) {
          result.append(node('p', observationDetail.title + ' · ' + observationDetail.observedAt, 'astra-note'));
          const text = observationDetail.elements.map(item => [item.controlType, item.name, item.value]
            .filter(value => typeof value === 'string' && value.length > 0).join('\n')).filter(Boolean).join('\n\n');
          result.append(node('pre', text || 'Текстовых элементов в сохранённом снимке нет.', 'astra-result'));
          result.append(node('p', (observationDetail.truncated ? 'Снимок сокращён. ' : '')
            + `Парольные поля скрыты: ${observationDetail.omittedPasswordElements}.`, 'astra-note'));
        }
      }
    }
    if (current.terminal) {
      const elapsed = astraElapsedLabel(current.turn);
      if (elapsed) result.append(node('p', elapsed, 'astra-note'));
      result.append(node('p', 'Оскар проверил доступные подтверждения выполнения. Важный результат всё равно стоит просмотреть.', 'astra-note'));
    }
    if (current.issue) result.append(node('p', astraHumanIssue(current.issue), 'astra-error'));
    const card = current.card, cardKey = card ? card.type + ':' + card.payload.digest : '';
    if (cardKey !== lastCardKey) { replyDraft = ''; lastCardKey = cardKey; }
    if (card && !pending) {
      const box = node('div', undefined, 'astra-card'), data = card.payload;
      if (card.type === 'approval.required') {
        if (data.approvalKind === 'computer-action') {
          const action = data.action || {}, detail = action.kind === 'type'
            ? `${action.textMode === 'replace' ? 'Заменить значение' : 'Вставить текст'}: ${String(action.text ?? '')}`
            : action.kind === 'click' ? `Клик ${action.button}, ${action.clicks} раз`
              : action.kind === 'scroll' ? `Прокрутка ${action.deltaY}`
                : action.kind === 'key' ? `Клавиша ${action.key}${action.modifiers?.length ? ' + ' + action.modifiers.join(' + ') : ''}`
                  : action.kind === 'close' ? 'Закрыть окно' : 'Неизвестное действие';
          box.append(node('h3', 'Разрешить точное действие с окном?'), node('p', String(data.windowTitle || 'Выбранное окно')),
            node('pre', detail, 'astra-content'), node('small', 'Состояние окна перед действием сохранено.', 'astra-note'),
            node('p', 'Действие будет выполнено один раз. После него Оскар проверит доступное состояние окна.', 'astra-note'),
            node('p', 'До: ' + new Date(data.expiresAt).toLocaleString('ru-RU'), 'astra-note'));
        } else {
          box.append(node('h3', 'Разрешить создание файла?'), node('p', data.basename),
            node('p', 'Новый файл · без перезаписи · один раз'), node('pre', data.content, 'astra-content'),
            node('small', 'Содержимое будет записано точно в показанном виде.', 'astra-note'),
            node('p', 'До: ' + new Date(data.expiresAt).toLocaleString('ru-RU'), 'astra-note'));
        }
        for (const [answer, label] of [['approve', 'Разрешить один раз'], ['reject', 'Отклонить']]) {
          const action = button(label, () => submitCard(card, answer)); action.disabled = busy || Boolean(current.issue) || Date.now() >= data.expiresAt; box.append(action);
        }
      } else {
        const reply = node('textarea'); reply.rows = 4; reply.value = replyDraft; reply.dataset.astraReply = 'true';
        reply.addEventListener('input', () => { replyDraft = reply.value; });
        box.append(node('h3', data.origin === 'host-required-input' ? 'Нужно содержимое файла' : 'Вопрос модели'), field(data.text, reply));
        const action = button('Отправить точный ответ', () => submitCard(card, reply.value)); action.disabled = busy || Boolean(current.issue); box.append(action);
      }
      result.append(box);
      if (caret) { const reply = box.querySelector('textarea'); reply?.focus(); reply?.setSelectionRange(...caret); }
    }
    const controls = node('div', undefined, 'astra-actions');
    controls.append(button('Обновить состояние', () => void load()));
    if (!current.terminal && current.issue) controls.append(button('Проверить ещё раз', () => {
      if (busy || pending) return;
      pending = { kind: 'recover', turn: structuredClone(current.turn), requestId: id() }; void sendPending();
    }));
    if (!current.terminal) {
      const paused = current.status === 'paused' || current.turn.astraControl?.desired === 'pause';
      if (!current.issue && !['indeterminate', 'cancelling', 'pausing'].includes(current.status)) controls.append(button(paused ? 'Продолжить' : 'Пауза', () => command(paused ? 'resume' : 'pause')));
      controls.append(button('Отменить задачу', () => command('cancel')));
    }
    for (const control of controls.children) control.disabled = busy || Boolean(pending);
    result.append(controls);
  }
  function submitCard(card, answer) {
    if (busy || pending || current?.issue) return;
    try { pending = { kind: 'input', turn: structuredClone(current.turn), input: astraCardInput(card, answer, { requestId: id(), messageId: id() }) }; void sendPending(); }
    catch (cause) { error.textContent = cause.message; }
  }
  function command(value) {
    if (busy || pending || !current) return;
    pending = { kind: 'control', turn: structuredClone(current.turn), command: value }; void sendPending();
  }
  async function sendPending() {
    if (busy || !pending || disposed) return;
    busy = true; error.textContent = ''; render(); const operation = pending;
    try {
      let cp; const options = { signal: AbortSignal.timeout(15000) };
      if (operation.kind === 'create') {
        // Host durably retains only the opaque ID BEFORE the network can admit
        // work. Text/content are never copied to browser storage or the URL.
        await lifecycle.onSubmissionPending(operation.request.clientRequestId);
        if (disposed) return;
        cp = await createOscarAstraTurn(operation.request, options);
      }
      else if (operation.kind === 'input') cp = await sendOscarAstraInput(operation.turn, operation.input, options);
      else if (operation.kind === 'recover') cp = await recoverOscarAstraTurn(operation.turn, operation.requestId, options);
      else cp = await controlOscarAstraTurn(operation.turn, operation.command, options);
      if (disposed) return; await accept(cp); if (disposed) return; pending = null; watch();
    } catch (cause) {
      if (disposed) return;
      if (cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) {
        error.textContent = taskErrorMessage(cause);
        if (operation.kind === 'create') {
          try { await lifecycle.onSubmissionCancelled(operation.request.clientRequestId); }
          catch { error.textContent += ' Не удалось сохранить состояние отправки. Попробуй ещё раз.'; return; }
        }
        pending = null;
        if (operation.kind !== 'create') await load();
        return;
      }
      // An observation/network error is not proof that a write failed. Keep the
      // exact same request and IDs for retry; never generate a replacement task.
      error.textContent = 'Не удалось получить ответ. Состояние задачи не угадано; повтор использует тот же запрос.';
      if (operation.kind === 'create') {
        try { const cp = await fetchOscarTurnByClientRequestId(operation.request.clientRequestId, { signal: AbortSignal.timeout(15000) });
          if (!disposed && cp?.turn) { await accept(cp); pending = null; error.textContent = ''; watch(); } } catch { /* Exact retry remains available. */ }
      }
    } finally { busy = false; render(); }
  }
  async function cancelPendingSource() {
    if (busy || !['create', 'lookup'].includes(pending?.kind) || disposed) return;
    busy = true; render(); const requestId = pending.kind === 'create' ? pending.request.clientRequestId : pending.requestId;
    try {
      const cp = await cancelOscarTurnSubmission(requestId, { astra: true, signal: AbortSignal.timeout(15000) });
      if (disposed) return; error.textContent = '';
      if (cp?.turn) { await accept(cp); watch(); }
      else { await lifecycle.onSubmissionCancelled(requestId); notice.textContent = 'Отмена отправки принята.'; notice.hidden = false; }
      pending = null;
    } catch (cause) { if (!disposed) error.textContent = cause.message || String(cause); }
    finally { busy = false; render(); }
  }
  async function lookupPending() {
    if (disposed || busy || pending?.kind !== 'lookup') return;
    busy = true; render(); const requestId = pending.requestId;
    try {
      const cp = await fetchOscarTurnByClientRequestId(requestId, { signal: AbortSignal.timeout(15000) });
      if (disposed) return; await accept(cp); pending = null; error.textContent = ''; watch();
    } catch (cause) {
      if (!disposed) error.textContent = cause.status === 404
        ? 'Пока неизвестно, принята ли отправка. Проверь её ещё раз или отмени. Новая задача не запущена.'
        : cause.message || String(cause);
    } finally { busy = false; render(); }
  }
  async function load() {
    if (!current || disposed) return;
    if (refresh) return refresh;
    const turnId = current.turn.id;
    refresh = (async () => { try { const cp = await fetchOscarTurn(turnId, { signal: AbortSignal.timeout(15000) }); if (!disposed && current?.turn.id === turnId) await accept(cp); }
      catch (cause) { if (!disposed) error.textContent = cause.message || String(cause); } finally { refresh = null; } })();
    return refresh;
  }
  function watch() {
    if (disposed || !current || stream?.turnId === current.turn.id) return;
    stream?.controller.abort(); if (current.terminal) return;
    const run = { turnId: current.turn.id, controller: new AbortController() }; stream = run;
    void (async () => { try {
      for await (const _event of await streamOscarTurn(run.turnId, current.sequence, { signal: run.controller.signal })) { await load(); }
    } catch (cause) { if (!disposed && !run.controller.signal.aborted) error.textContent = 'Поток прерван. Обнови состояние: ' + cause.message; }
    finally { if (stream === run) stream = null; } })();
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || pending || current && !current.terminal) return;
    try {
      notice.hidden = true;
      const selectedTarget = config.targets.find(item => item.key === target.value);
      const maxSelection = kind.value === 'draft' || selectedTarget?.access === 'observe' ? view.maxMode?.selected?.() : null;
      pending = { kind: 'create', request: astraGoalRequest(config, { target: target.value, text: text.value,
        references: kind.value === 'draft' && config.targets.find(item => item.key === target.value)?.access === 'exclusive-create' ? [...references.keys()] : [],
        contentKind: kind.value, content: content.value,
        ...(config.localAnalysis === true && selectedTarget?.access === 'observe' && readMode.value === 'analyze' ? { modelMode: 'local' } : {}),
        ...(maxSelection ? { modelMode: 'max', modelChoice: maxSelection.modelChoice,
          ...(maxSelection.previewAcknowledged ? { previewAcknowledged: true } : {}) } : {})
      }, { clientRequestId: id(), inputMessageId: id() }) };
      generation++; current = null; void sendPending();
    } catch (cause) { error.textContent = cause.message; }
  }, { signal: listeners.signal });
  if (composer) {
    text.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(start); }
    }, { signal: listeners.signal });
    composer.stop.addEventListener('click', () => {
      if (busy) return;
      if (pending?.kind === 'create' || pending?.kind === 'lookup') void cancelPendingSource();
      else if (!pending && current && !current.terminal) command('cancel');
    }, { signal: listeners.signal });
  }
  if (!config.targets.length) { notice.textContent = 'Нет доступных целей. Новый выбор должен выдать хост.'; notice.hidden = false; }
  if (config.pendingRequestId) { pending = { kind: 'lookup', requestId: config.pendingRequestId }; void lookupPending(); }
  else if (config.turnId) {
    if (!validId(config.turnId)) throw Error('Не удалось восстановить задачу.');
    busy = true; syncForm(); void fetchOscarTurn(config.turnId).then(async cp => { if (!disposed) { await accept(cp); watch(); } })
      .catch(cause => { if (!disposed) error.textContent = cause.message; }).finally(() => { busy = false; render(); });
  }
  async function loadObservation() {
    if (disposed || observationLoading || observationDetail || current?.turn.request.astra.goal.kind !== 'computer-observe') return;
    const turn = current.turn, expectedGeneration = generation; observationLoading = true; render();
    try {
      const { task } = await fetchAstraComputerObservation(turn, { signal: AbortSignal.timeout(15000) });
      if (disposed || current?.turn.id !== turn.id || generation !== expectedGeneration) return;
      const data = task?.observation;
      if (task?.id !== turn.taskId || task.conversationId !== config.conversationId || task.inputMessageId !== turn.inputMessageId
        || task.status !== 'observed' || data?.authority !== 'none' || data.authorizesInput !== false || data.temporalSemantics !== 'snapshot-at-capture'
        || !Array.isArray(data.elements) || data.elements.length > 128 || new TextEncoder().encode(JSON.stringify(data)).length > 65536)
        throw Error('Наблюдение не соответствует исходной задаче.');
      observationDetail = data;
    } catch (cause) { if (!disposed && current?.turn.id === turn.id) error.textContent = cause.message || String(cause); }
    finally { observationLoading = false; render(); }
  }
  return { draft() { return { text: text.value, content: content.value, kind: kind.value, readMode: readMode.value, target: target.value, replyDraft, lastCardKey,
      ...(references.size ? { references: [...references].map(([key, label]) => ({ key, label })) } : {}) }; }, canAddReference, addReference,
    currentObservation() {
      if (disposed || !current?.terminal || current.status !== 'succeeded' || current.turn.request.astra.goal.kind !== 'computer-observe'
        || !observationDetail || current.turn.taskId === undefined) return null;
      return { turnId: current.turn.id, taskId: current.turn.taskId, observation: structuredClone(observationDetail) };
    },
    dispose() { disposed = true; generation++; listeners.abort(); stream?.controller.abort(); root.remove(); if (composer) sourceFields.remove(); }, refresh: load,
    updateTargets(next, selectedKey) {
      if (disposed || !Array.isArray(next) || next.length > 2048 || new Set(next.map(item => item.key)).size !== next.length
        || selectedKey !== '' && !next.some(item => item.key === selectedKey)) throw Error('Не удалось обновить список выбранных файлов.');
      config.targets = structuredClone(next); target.replaceChildren();
      for (const entry of config.targets) { const option = node('option', entry.label); option.value = entry.key; target.append(option); }
      target.value = selectedKey; if (!pending && !current) notice.hidden = true; syncForm();
    } };
}
