const OWNER_DIAGNOSTICS = Object.freeze({
  'owner-device-request-absent': 'На этом устройстве ещё нет Owner-запроса.',
  'owner-entitlement-absent': 'Устройство готово. Экспортируй запрос и импортируй подписанный доступ.',
  'owner-entitlement-valid-restart-required': 'Доступ проверен. Нужен полный перезапуск Monarch.',
  'owner-device-key-partial': 'Данные устройства неполные. Monarch оставлен в Public-режиме.',
  'owner-device-key-corrupt': 'Данные устройства повреждены. Monarch оставлен в Public-режиме.',
  'owner-device-key-missing': 'Файл доступа не подходит этому устройству.',
  'owner-device-encryption-unavailable': 'Защита ключа Windows сейчас недоступна.',
  'owner-authority-acl-failed': 'Не удалось проверить защиту папки Owner.',
  'owner-entitlement-signature-invalid': 'Подпись файла недействительна. Доступ не установлен.',
  'owner-signing-key-unknown': 'Файл подписан неизвестным ключом. Доступ не установлен.',
  'owner-entitlement-expired': 'Срок доступа истёк. Создай новый запрос.',
  'owner-entitlement-not-yet-valid': 'Этот доступ пока не действует.',
  'owner-device-mismatch': 'Доступ создан для другого устройства или аккаунта Windows.',
  'owner-entitlement-invalid': 'Файл доступа повреждён или имеет неверный формат.',
  'owner-entitlement-filename-invalid': 'Выбери файл с точным именем owner-entitlement.json.',
  'owner-device-request-filename-invalid': 'Запрос должен называться device-request.json.',
  'owner-device-request-export-failed': 'Не удалось экспортировать публичный device-request.json.',
  'owner-entitlement-path-invalid': 'Выбранный файл недоступен.',
  'owner-entitlement-install-failed': 'Не удалось установить доступ. Старый файл сохранён.',
});

let initialized = false;
let latestStatus = null;

export function initOwnerEnrollment() {
  if (initialized) return;
  initialized = true;
  document.querySelector('#owner-request-create')?.addEventListener('click', () => void createRequest());
  document.querySelector('#owner-request-export')?.addEventListener('click', () => void exportRequest());
  document.querySelector('#owner-entitlement-import')?.addEventListener('click', () => void importEntitlement());
  document.querySelector('#owner-enrollment-restart')?.addEventListener('click', () => void restartMonarch());
  document.querySelector('#owner-mode-enable')?.addEventListener('click', () => void enableOwnerMode());
  const authorityCard = document.querySelector('#authority-status-card');
  if (authorityCard && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (latestStatus) renderOwnerEnrollment(latestStatus);
    }).observe(authorityCard, { attributes: true, attributeFilter: ['data-tier'] });
  }
}

export async function loadOwnerEnrollment() {
  const bridge = window.monarchDesktop;
  if (typeof bridge?.getOwnerEnrollmentStatus !== 'function') {
    renderOwnerEnrollment(null, 'Управление Owner доступно только в Monarch Desktop.');
    return null;
  }
  setFeedback('Проверяю устройство…');
  try {
    const result = await bridge.getOwnerEnrollmentStatus();
    if (!result?.ok) throw new Error(result?.error || 'owner-enrollment-status-failed');
    latestStatus = normalizeOwnerEnrollmentStatus(result.status);
    renderOwnerEnrollment(latestStatus);
    return latestStatus;
  } catch (error) {
    renderOwnerEnrollment(null, readOwnerError(error));
    return null;
  }
}

export function normalizeOwnerEnrollmentStatus(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    schemaVersion: 1,
    deviceStatus: ['absent', 'ready', 'partial', 'corrupt', 'unavailable'].includes(input.deviceStatus)
      ? input.deviceStatus
      : 'unavailable',
    deviceIdPrefix: /^[a-f0-9]{12}$/u.test(String(input.deviceIdPrefix || '')) ? input.deviceIdPrefix : null,
    requestReady: input.requestReady === true,
    entitlementStatus: ['absent', 'valid', 'invalid', 'wrong-device', 'expired'].includes(input.entitlementStatus)
      ? input.entitlementStatus
      : 'invalid',
    expiresAt: typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt)) ? input.expiresAt : null,
    diagnostic: String(input.diagnostic || '').slice(0, 120),
    ownerSuspended: input.ownerSuspended === true,
  };
}

async function enableOwnerMode() {
  const button = document.querySelector('#owner-mode-enable');
  setBusy(button, true, 'Перезапуск…');
  const result = await window.monarchDesktop?.enableOwnerMode?.().catch(() => null);
  if (!result?.ok) {
    setBusy(button, false, 'Вернуться в Owner');
    setFeedback('Не удалось вернуть Owner. Попробуй перезапустить Monarch.', true);
  }
}

export function ownerEnrollmentDiagnosticMessage(diagnostic) {
  return OWNER_DIAGNOSTICS[String(diagnostic || '')] || 'Owner остаётся Public до завершения проверенной активации.';
}

async function createRequest() {
  const bridge = window.monarchDesktop;
  const button = document.querySelector('#owner-request-create');
  setBusy(button, true, 'Готовлю…');
  setFeedback('Создаю запрос для этого устройства…');
  try {
    const result = await bridge?.createOwnerDeviceRequest?.();
    if (!result?.ok) throw new Error(result?.status?.diagnostic || result?.error || 'owner-device-request-failed');
    latestStatus = normalizeOwnerEnrollmentStatus(result.status);
    renderOwnerEnrollment(latestStatus, 'Запрос готов. Секретный ключ остался на этом компьютере.');
  } catch (error) {
    setFeedback(ownerEnrollmentDiagnosticMessage(readErrorCode(error)), true);
  } finally {
    if (button) {
      button.disabled = latestStatus?.requestReady === true;
      button.textContent = latestStatus?.requestReady ? 'Запрос готов' : 'Создать запрос';
    }
  }
}

async function exportRequest() {
  const button = document.querySelector('#owner-request-export');
  setBusy(button, true, 'Экспорт…');
  setFeedback('Выбери место для файла запроса…');
  try {
    const result = await window.monarchDesktop?.exportOwnerDeviceRequest?.();
    if (result?.canceled) {
      setFeedback('Экспорт отменён.');
      return;
    }
    if (!result?.ok) throw new Error(result?.error || 'owner-device-request-export-failed');
    setFeedback('Файл запроса экспортирован. Передай его на доверенный компьютер для подписи.');
  } catch (error) {
    setFeedback(ownerEnrollmentDiagnosticMessage(readErrorCode(error)), true);
  } finally {
    setBusy(button, false, 'Экспортировать запрос');
  }
}

async function importEntitlement() {
  const button = document.querySelector('#owner-entitlement-import');
  setBusy(button, true, 'Проверяю…');
  setFeedback('Выбери подписанный файл доступа…');
  try {
    const result = await window.monarchDesktop?.importOwnerEntitlement?.();
    if (result?.canceled) {
      setFeedback('Импорт отменён.');
      return;
    }
    if (!result?.ok) throw new Error(result?.diagnostic || result?.error || 'owner-entitlement-import-failed');
    latestStatus = normalizeOwnerEnrollmentStatus(result.status);
    renderOwnerEnrollment(
      latestStatus,
      result.backupCreated
        ? 'Доступ проверен и установлен. Предыдущая версия сохранена. Перезапусти Monarch.'
        : 'Доступ проверен и установлен. Перезапусти Monarch.',
    );
  } catch (error) {
    setFeedback(ownerEnrollmentDiagnosticMessage(readErrorCode(error)), true);
  } finally {
    setBusy(button, false, 'Импортировать доступ');
  }
}

async function restartMonarch() {
  const button = document.querySelector('#owner-enrollment-restart');
  setBusy(button, true, 'Перезапуск…');
  const result = await window.monarchDesktop?.restartForOwnerEnrollment?.().catch(() => null);
  if (!result?.ok) {
    setBusy(button, false, 'Полностью перезапустить');
    setFeedback('Не удалось перезапустить автоматически. Закрой Monarch через трей и запусти снова.', true);
  }
}

function renderOwnerEnrollment(status, feedback) {
  const desktopAvailable = Boolean(status);
  const ownerActive = document.querySelector('#authority-status-card')?.dataset.tier === 'owner';
  const ready = status?.deviceStatus === 'ready';
  const request = document.querySelector('#owner-request-create');
  const exportButton = document.querySelector('#owner-request-export');
  const importButton = document.querySelector('#owner-entitlement-import');
  const restart = document.querySelector('#owner-enrollment-restart');
  const enableOwner = document.querySelector('#owner-mode-enable');
  const device = document.querySelector('#owner-enrollment-device');
  const entitlement = document.querySelector('#owner-enrollment-entitlement');
  if (request) {
    request.disabled = !desktopAvailable || status.requestReady;
    request.textContent = status?.requestReady ? 'Запрос готов' : 'Создать запрос';
  }
  if (exportButton) exportButton.disabled = !status?.requestReady;
  if (importButton) importButton.disabled = !ready;
  if (restart) restart.hidden = ownerActive || status?.entitlementStatus !== 'valid';
  if (enableOwner) enableOwner.hidden = !status?.ownerSuspended;
  if (device) {
    device.textContent = ready
      ? `Устройство ${status.deviceIdPrefix || 'проверено'} · ключ остаётся в этом аккаунте Windows`
      : 'Устройство ещё не готово';
  }
  if (entitlement) {
    entitlement.dataset.state = ownerActive ? 'owner' : status?.entitlementStatus || 'absent';
    entitlement.textContent = ownerActive
      ? 'Owner включён'
      : status?.entitlementStatus === 'valid'
        ? 'Доступ проверен · нужен перезапуск'
        : ownerEnrollmentDiagnosticMessage(status?.diagnostic);
  }
  setFeedback(feedback || (status?.ownerSuspended
    ? 'Сейчас действуют обычные Public-правила. Owner сохранён и может быть возвращён кнопкой выше.'
    : ownerActive
    ? 'При переносе Monarch на этом же ПК ничего делать не нужно. Для нового ПК создай новый запрос.'
    : ownerEnrollmentDiagnosticMessage(status?.diagnostic)), !ownerActive && !status?.ownerSuspended && Boolean(status?.diagnostic) && ![
    'owner-device-request-absent', 'owner-entitlement-absent', 'owner-entitlement-valid-restart-required',
  ].includes(status.diagnostic));
}

function setFeedback(message, error = false) {
  const element = document.querySelector('#owner-enrollment-feedback');
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('error-text', error);
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = label;
}

function readOwnerError(error) {
  return error instanceof Error ? ownerEnrollmentDiagnosticMessage(readErrorCode(error)) : 'Не удалось проверить Owner.';
}

function readErrorCode(error) {
  return String(error?.code || error?.message || error || '').trim().slice(0, 160);
}
