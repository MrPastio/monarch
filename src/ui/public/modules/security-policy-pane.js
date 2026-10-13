import { fetchSecurityPolicy, saveSecurityPolicy } from './api.js';

/** Monarch Security policy center in the Security settings tab (stage 9
 * minimum before the full redesign): every wired measure with its levels.
 * Basic measures are shown at once, rare ones under «Расширенные параметры».
 * Weakening asks first with the consequence in plain words; the runtime
 * refuses it without that confirmation anyway. */

const view = { controls: [], busy: false, pendingWeakening: null, recovery: null, recoveryCode: '', recoveryBusy: false };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, primary, onClick) {
  const node = element('button', primary ? 'claude-primary-btn' : 'claude-ghost-btn', text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function feedback(text) {
  const node = document.querySelector('#security-policy-feedback');
  if (node) node.textContent = text || '';
}

let safeStatusSubscribed = false;

export async function renderSecurityPolicyPane() {
  if (!document.querySelector('#security-policy-controls')) return;
  if (!safeStatusSubscribed && typeof window.monarchDesktop?.onSafeChatStatus === 'function') {
    safeStatusSubscribed = true;
    // Opening Safe lets Desktop refresh the key copy; show the new state.
    window.monarchDesktop.onSafeChatStatus(status => {
      if (status?.unlocked === true && view.recovery) void refreshKeyRecovery();
    });
  }
  try {
    view.controls = (await fetchSecurityPolicy())?.controls || [];
  } catch {
    feedback('Не удалось загрузить настройки приватности. Повтори позже.');
  }
  await refreshKeyRecovery(false);
  draw();
}

async function refreshKeyRecovery(redraw = true) {
  const bridge = window.monarchDesktop?.profileKey;
  view.recovery = bridge ? await bridge.status().catch(() => null) : null;
  if (redraw) draw();
}

function draw() {
  const basic = document.querySelector('#security-policy-controls');
  const advanced = document.querySelector('#security-policy-advanced-controls');
  if (!basic || !advanced) return;
  basic.replaceChildren(...view.controls.filter(item => item.visibility !== 'advanced').map(drawControl));
  advanced.replaceChildren(...view.controls.filter(item => item.visibility === 'advanced').map(drawControl));
  const advancedBlock = document.querySelector('#security-policy-advanced');
  if (advancedBlock) advancedBlock.hidden = !advanced.children.length;
}

function drawControl(control) {
  const card = element('section', 'security-settings-section security-policy-control');
  card.dataset.securityPolicyControl = control.id;
  const heading = element('div', 'security-settings-heading');
  const label = element('span');
  label.append(element('strong', '', control.title), element('small', '', control.description));
  heading.append(label);
  card.append(heading);

  const row = element('div', 'security-policy-row');
  const field = element('label');
  field.append(element('span', '', 'Уровень'));
  const select = element('select');
  select.disabled = view.busy;
  for (const level of control.levels) {
    const option = element('option', '', level.title);
    option.value = level.id;
    option.selected = level.id === control.level;
    select.append(option);
  }
  select.addEventListener('change', () => choose(control, select.value));
  field.append(select);
  row.append(field);
  card.append(row);
  const current = control.levels.find(level => level.id === control.level);
  card.append(element('p', 'security-policy-note', current?.description || ''));

  const pending = view.pendingWeakening;
  if (pending?.controlId === control.id) {
    const target = control.levels.find(level => level.id === pending.level);
    const warning = element('div', 'security-agent-off-warning');
    warning.setAttribute('role', 'alert');
    warning.append(element('strong', '', 'Это ослабит защиту'), element('span', '', target?.description || ''));
    const actions = element('div', 'security-policy-actions');
    actions.append(
      button('Ослабить', true, () => choose(control, pending.level, true)),
      button('Оставить как есть', false, () => { view.pendingWeakening = null; draw(); }),
    );
    warning.append(actions);
    card.append(warning);
  }
  if (control.id === 'storage.keyRecovery') card.append(drawKeyRecovery(control.level));
  return card;
}

async function choose(control, level, confirmWeakening = false) {
  if (level === control.level && !confirmWeakening) return;
  view.busy = true;
  feedback('');
  try {
    view.controls = (await saveSecurityPolicy(control.id, level, confirmWeakening))?.controls || view.controls;
    view.pendingWeakening = null;
    feedback('Сохранено.');
    if (control.id === 'storage.keyRecovery') await refreshKeyRecovery(false);
  } catch (error) {
    if (error?.code === 'security-policy-weakening-unconfirmed') view.pendingWeakening = { controlId: control.id, level };
    else feedback('Не удалось сохранить. Повтори.');
  } finally {
    view.busy = false;
    draw();
  }
}

/** The key that seals history and memory: where its copies are, and the way
 * back when the key itself was lost. */
function drawKeyRecovery(level) {
  const box = element('div', 'security-key-recovery');
  const bridge = window.monarchDesktop?.profileKey;
  const status = view.recovery;
  if (!bridge || !status) {
    box.append(element('p', 'security-policy-note', 'Копии ключа доступны в приложении Monarch для компьютера.'));
    return box;
  }
  if (status.state === 'needs-recovery' || status.state === 'damaged-record') {
    box.append(drawRecoveryNeeded(status));
    return box;
  }
  if (status.state === 'session') {
    box.append(element('p', 'security-policy-note', 'Шифрование Windows недоступно: история хранится только до закрытия Monarch, ключа для копии нет.'));
    return box;
  }
  const wantsSafe = level === 'safe' || level === 'safe-and-code';
  const wantsCode = level === 'code' || level === 'safe-and-code';
  if (wantsSafe) {
    const line = element('div', 'security-policy-row');
    const ready = status.copies.safe.present && status.copies.safe.current;
    line.append(element('span', 'security-policy-note', ready
      ? 'Копия ключа в Monarch Safe на месте.'
      : 'Копия в Monarch Safe появится, когда ты откроешь Safe.'));
    if (!ready) line.append(button('Открыть Safe', false, () => window.monarchDesktop?.openSafe?.()));
    box.append(line);
  }
  if (wantsCode) {
    const line = element('div', 'security-policy-row');
    const ready = status.copies.code.present && status.copies.code.current;
    line.append(element('span', 'security-policy-note', ready
      ? 'Код восстановления создан. Если ты его потерял, создай новый — старый перестанет работать.'
      : 'Создай код восстановления и сохрани его вне этого компьютера.'));
    line.append(button(ready ? 'Создать новый код' : 'Создать код', !ready, createCode));
    box.append(line);
  }
  if (view.recoveryCode) {
    const shown = element('div', 'security-recovery-code-box');
    shown.append(
      element('strong', '', 'Код восстановления'),
      element('code', 'security-recovery-code', view.recoveryCode),
      element('small', '', 'Запиши его или сохрани в менеджере паролей. Monarch больше его не покажет.'),
      button('Я сохранил код · скрыть', false, () => { view.recoveryCode = ''; draw(); }),
    );
    box.append(shown);
  }
  return box;
}

async function createCode() {
  if (view.recoveryBusy) return;
  view.recoveryBusy = true;
  feedback('');
  try {
    view.recoveryCode = (await window.monarchDesktop.profileKey.createRecoveryCode())?.code || '';
    await refreshKeyRecovery(false);
  } catch (error) {
    feedback(readIpcError(error, 'Не удалось создать код. Повтори.'));
  } finally {
    view.recoveryBusy = false;
    draw();
  }
}

function drawRecoveryNeeded(status) {
  const panel = element('div', 'security-agent-off-warning');
  panel.setAttribute('role', 'alert');
  panel.append(
    element('strong', '', 'Ключ истории не найден'),
    element('span', '', 'История и память сейчас не открываются, новые сообщения хранятся только до закрытия Monarch. Файлы на диске целы. Верни ключ из копии — после этого Monarch перезапустится.'),
  );
  if (status.copies.safe.present) {
    const line = element('div', 'security-policy-actions');
    if (!status.safeOpen) line.append(button('Открыть Safe', false, async () => {
      await window.monarchDesktop?.openSafe?.();
    }));
    line.append(button('Восстановить из Safe', true, () => recover('safe')));
    panel.append(line);
  }
  if (status.copies.code.present) {
    const line = element('div', 'security-policy-actions');
    const input = element('input', 'security-recovery-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX';
    input.setAttribute('aria-label', 'Код восстановления');
    line.append(input, button('Восстановить по коду', !status.copies.safe.present, () => recover('code', input)));
    panel.append(line);
  }
  if (!status.copies.safe.present && !status.copies.code.present) {
    panel.append(element('span', '', 'Копий ключа нет, поэтому прежнюю историю открыть не получится.'));
  }
  return panel;
}

async function recover(method, input) {
  if (view.recoveryBusy) return;
  view.recoveryBusy = true;
  feedback('Проверяю копию ключа…');
  try {
    await window.monarchDesktop.profileKey.recover(method, input?.value || '');
    feedback('Ключ восстановлен. Monarch перезапускается.');
  } catch (error) {
    feedback(readIpcError(error, 'Не удалось восстановить ключ. Данные на диске не изменены.'));
    await refreshKeyRecovery();
  } finally {
    if (input) input.value = '';
    view.recoveryBusy = false;
  }
}

/** Electron prefixes IPC errors with the handler name; the person sees only
 * the plain message Desktop chose. */
function readIpcError(error, fallback) {
  const text = String(error?.message || '');
  const plain = text.replace(/^Error invoking remote method '[^']+': (Error: )?/u, '').trim();
  return plain && /[а-яё]/iu.test(plain) ? plain : fallback;
}
