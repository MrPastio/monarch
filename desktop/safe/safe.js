import {
  SAFE_FILE_FORMAT_GROUPS,
  getSafeFileFormat,
  isSafeEditableTextMime,
  seedSafeFileContent,
  withSafeFileExtension,
} from './file-formats.mjs';
import { assessSafeSecurityPolicy, normalizeSafeSecurityPolicy } from './security-policy.mjs';

const bridge = window.monarchSafe;
const $ = (selector) => document.querySelector(selector);
const MAX_EDITABLE_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_EDITABLE_HEX_BYTES = 64 * 1024;
const UI_AUTO_LOCK_GRACE_MS = 1500;
const RUNTIME_ACTIVITY_TOUCH_THROTTLE_MS = 750;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  status: null,
  manifest: null,
  pinLength: 12,
  emergencyWordCount: 12,
  authMode: 'pin',
  sectionId: 'all',
  folderId: null,
  selected: new Set(),
  currentFile: null,
  currentBytes: null,
  currentEditable: false,
  currentDirty: false,
  objectUrl: null,
  itemMode: 'file',
  importing: false,
  lockTimer: 0,
  runtimeTouchAt: 0,
  runtimeTouchPending: false,
  transitionPromise: null,
  pendingSettingsOpen: false,
};

bridge?.onEvent(({ event, data }) => {
  if (event === 'force-lock') { void lockVault(); return; }
  if (event === 'status' || event === 'auto-lock') {
    state.status = data;
    if (!data.unlocked) {
      showAuth();
      if (event === 'auto-lock') void playSafeTransition('lock');
    }
  }
});
bridge?.onOpenSettings?.(() => {
  state.pendingSettingsOpen = true;
  if (state.status?.unlocked) openSecuritySettings();
});

document.addEventListener('DOMContentLoaded', init);

async function init() {
  populateFileFormats();
  if (!bridge) {
    $('#auth-error').textContent = 'Safe доступен только в изолированном desktop-окне Monarch.';
    return;
  }
  bindEvents();
  state.status = await request('status');
  showAuth();
}

function bindEvents() {
  document.addEventListener('click', armUiLock, true);
  document.addEventListener('click', handleClick);
  document.addEventListener('pointerdown', armUiLock, true);
  document.addEventListener('keydown', armUiLock, true);
  $('#setup-form').addEventListener('submit', setupVault);
  $('#unlock-form').addEventListener('submit', unlockVault);
  $('#item-form').addEventListener('submit', submitItemDialog);
  $('#item-cancel').addEventListener('click', () => $('#item-dialog').close('cancel'));
  $('#item-close').addEventListener('click', () => $('#item-dialog').close('cancel'));
  $('#item-delete').addEventListener('click', deleteEditedContainer);
  $('#item-type').addEventListener('change', updateFileFormatHint);
  $('#safe-settings-form').addEventListener('submit', saveSecuritySettings);
  $('#safe-settings-close').addEventListener('click', closeSecuritySettings);
  $('#safe-settings-cancel').addEventListener('click', closeSecuritySettings);
  $('#confirm-action').addEventListener('click', (event) => {
    event.preventDefault();
    $('#confirm-dialog').close('default');
  });
  $('#confirm-form button[value="cancel"]').addEventListener('click', (event) => {
    event.preventDefault();
    $('#confirm-dialog').close('cancel');
  });
  for (const selector of ['#safe-auto-lock', '#safe-minimize-action', '#safe-clipboard-mode', '#safe-lock-on-blur', '#safe-clear-clipboard']) {
    $(selector).addEventListener('change', renderSecurityAssessment);
  }
  $('#recovery-saved').addEventListener('change', (event) => { $('#enter-vault').disabled = !event.target.checked; });
  $('#emergency-word-count').addEventListener('input', (event) => {
    state.emergencyWordCount = Number(event.target.value);
    $('#emergency-word-count-value').textContent = `${state.emergencyWordCount} слов`;
  });
  $('#safe-search').addEventListener('input', renderFiles);
  $('#type-filter').addEventListener('change', renderFiles);
  $('#sort-order').addEventListener('change', renderFiles);
  $('#file-input').addEventListener('change', (event) => importFiles(event.target.files));
  $('#select-all').addEventListener('change', toggleSelectAll);
  $('#text-editor').addEventListener('input', markCurrentFileDirty);
  $('#hex-editor').addEventListener('input', markCurrentFileDirty);
  const dropSurface = $('#vault-screen');
  ['dragenter', 'dragover'].forEach((type) => dropSurface.addEventListener(type, (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    const destination = resolveImportDestination();
    $('#drop-overlay').textContent = destination
      ? `Отпусти файлы — Safe зашифрует их в разделе «${destination.name}»`
      : 'Создай раздел перед импортом файлов';
    $('#drop-overlay').hidden = false;
  }));
  dropSurface.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && dropSurface.contains(event.relatedTarget)) return;
    $('#drop-overlay').hidden = true;
  });
  dropSurface.addEventListener('drop', (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    $('#drop-overlay').hidden = true;
    void importFiles(event.dataTransfer.files);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.status?.unlocked && currentSecurityPolicy().lockOnBlur) void lockVault();
  });
  window.addEventListener('pagehide', () => { if (state.status?.unlocked) void request('lock').catch(() => undefined); });
  for (const type of ['copy', 'cut', 'paste']) {
    document.addEventListener(type, (event) => {
      if (!shouldBlockClipboardEvent(type)) return;
      event.preventDefault();
      toast('Системный буфер обмена отключён внутри Safe.', true);
    }, true);
  }
  document.addEventListener('dragstart', (event) => event.preventDefault(), true);
}

async function handleClick(event) {
  const length = event.target.closest('[data-pin-length]');
  if (length) {
    state.pinLength = Number(length.dataset.pinLength);
    document.querySelectorAll('[data-pin-length]').forEach((button) => button.classList.toggle('active', button === length));
    buildPinInputs($('#setup-pin'), state.pinLength);
    buildPinInputs($('#setup-pin-confirm'), state.pinLength);
    return;
  }
  const mode = event.target.closest('[data-auth-mode]');
  if (mode) { setAuthMode(mode.dataset.authMode); return; }
  if (event.target.closest('#enter-vault')) { await enterVault(); return; }
  if (event.target.closest('#restart-provisioning')) { state.status = await request('resetProvisioning'); showAuth(); return; }
  if (event.target.closest('#lock-now,#lock-now-top')) { await requestManualLock(); return; }
  if (event.target.closest('#safe-settings')) { openSecuritySettings(); return; }
  if (event.target.closest('#edit-section')) { openItemDialog('edit-section'); return; }
  if (event.target.closest('#new-section')) { openItemDialog('section'); return; }
  if (event.target.closest('#new-folder')) { openItemDialog('folder'); return; }
  if (event.target.closest('#new-file')) { openItemDialog('file'); return; }
  if (event.target.closest('#import-files')) { $('#file-input').click(); return; }
  if (event.target.closest('#archive-files')) { await archiveSelected(); return; }
  if (event.target.closest('#delete-selected')) { await deleteSelectedFiles(); return; }
  if (event.target.closest('#save-file')) { await saveCurrentFile(); return; }
  if (event.target.closest('#delete-file')) { await deleteCurrentFile(); return; }
  if (event.target.closest('#extract-archive')) { await extractCurrentArchive(); return; }
  const deleteFile = event.target.closest('[data-delete-file]');
  if (deleteFile) { event.stopPropagation(); await deleteFilesById([deleteFile.dataset.deleteFile]); return; }
  const editFolder = event.target.closest('[data-edit-folder]');
  if (editFolder) { event.stopPropagation(); openItemDialog('edit-folder', editFolder.dataset.editFolder); return; }
  const deleteFolder = event.target.closest('[data-delete-folder]');
  if (deleteFolder) { event.stopPropagation(); await deleteFolderById(deleteFolder.dataset.deleteFolder); return; }
  const tab = event.target.closest('[data-editor-tab]');
  if (tab) { setEditorTab(tab.dataset.editorTab); return; }
  const folderBack = event.target.closest('[data-folder-back]');
  if (folderBack) {
    const previousFolderId = state.folderId;
    state.folderId = null;
    state.selected.clear();
    renderFiles();
    focusFileControl('[data-folder-id]', previousFolderId);
    return;
  }
  const section = event.target.closest('[data-section-id]');
  if (section) { state.sectionId = section.dataset.sectionId; state.folderId = null; state.selected.clear(); renderAll(); return; }
  const folder = event.target.closest('[data-folder-id]');
  if (folder) { state.folderId = folder.dataset.folderId; state.selected.clear(); renderFiles(); $('#breadcrumb [data-folder-back]')?.focus({ preventScroll: true }); return; }
  const check = event.target.closest('[data-file-check]');
  if (check) { event.stopPropagation(); check.checked ? state.selected.add(check.dataset.fileCheck) : state.selected.delete(check.dataset.fileCheck); renderSelectionState(); return; }
  const row = event.target.closest('[data-file-id]');
  if (row) await openFile(row.dataset.fileId);
}

function showAuth() {
  clearTimeout(state.lockTimer);
  if ($('#safe-settings-dialog')?.open) $('#safe-settings-dialog').close();
  purgePlaintextUi();
  $('#vault-screen').hidden = true;
  $('#recovery-screen').hidden = true;
  $('#auth-screen').hidden = false;
  $('#setup-form').hidden = true;
  $('#unlock-form').hidden = true;
  $('#wiped-notice').hidden = true;
  $('#blocked-state').hidden = true;
  $('#provisioning-state').hidden = true;
  $('#auth-error').textContent = '';
  $('.auth-core').classList.remove('recovery-mode', 'emergency-mode');
  if (state.status?.blocked) { $('#blocked-state').hidden = false; return; }
  if (state.status?.provisioning) { $('#provisioning-state').hidden = false; return; }
  if (!state.status?.configured) {
    $('#setup-form').hidden = false;
    $('#wiped-notice').hidden = !state.status?.wiped;
    $('#destruction-consent').checked = false;
    state.pinLength = 12;
    state.emergencyWordCount = 12;
    $('#emergency-word-count').value = '12';
    $('#emergency-word-count-value').textContent = '12 слов';
    buildPinInputs($('#setup-pin'), 12);
    buildPinInputs($('#setup-pin-confirm'), 12);
    return;
  }
  $('#unlock-form').hidden = false;
  state.pinLength = state.status.pinLength;
  buildPinInputs($('#unlock-pin'), state.pinLength);
  buildRecoveryInputs();
  setAuthMode('pin');
  updateAttempts();
}

function buildPinInputs(container, length) {
  container.replaceChildren();
  container.classList.toggle('long', length === 12);
  for (let index = 0; index < length; index += 1) {
    const input = document.createElement('input');
    input.className = 'pin-cell'; input.type = 'password'; input.inputMode = 'numeric'; input.maxLength = 1;
    input.autocomplete = 'off'; input.setAttribute('aria-label', `Цифра ${index + 1}`);
    wireCell(input, container);
    container.append(input);
  }
}

function buildRecoveryInputs() {
  const container = $('#recovery-input'); container.replaceChildren();
  for (let groupIndex = 0; groupIndex < 5; groupIndex += 1) {
    const group = document.createElement('span'); group.className = 'recovery-group';
    for (let index = 0; index < 4; index += 1) {
      const input = document.createElement('input'); input.className = 'recovery-cell'; input.maxLength = 1; input.autocomplete = 'off';
      input.setAttribute('aria-label', `Символ ключа ${groupIndex * 4 + index + 1}`); wireCell(input, container); group.append(input);
    }
    container.append(group);
  }
}

function wireCell(input, container) {
  input.addEventListener('input', () => {
    input.value = input.classList.contains('pin-cell') ? input.value.replace(/\D/g, '').slice(-1) : input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-1);
    input.classList.toggle('has-value', Boolean(input.value));
    if (input.value) allInputs(container)[allInputs(container).indexOf(input) + 1]?.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !input.value) allInputs(container)[allInputs(container).indexOf(input) - 1]?.focus();
    if ((event.ctrlKey || event.metaKey) && ['v', 'c', 'x'].includes(event.key.toLowerCase())) event.preventDefault();
  });
  input.addEventListener('paste', (event) => event.preventDefault());
}

function setAuthMode(mode) {
  if (mode === 'emergency' && !state.status?.emergencyRecoveryOffered) mode = 'pin';
  state.authMode = mode;
  $('.auth-core').classList.toggle('recovery-mode', mode === 'recovery');
  $('.auth-core').classList.toggle('emergency-mode', mode === 'emergency');
  document.querySelectorAll('[data-auth-mode]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.authMode === mode)));
  $('#unlock-pin').hidden = mode !== 'pin';
  $('#recovery-input').hidden = mode !== 'recovery';
  $('#emergency-input').hidden = mode !== 'emergency';
  $('#auth-title').textContent = mode === 'pin' ? 'Введите PIN' : mode === 'recovery' ? 'Ключ восстановления' : 'Аварийная фраза';
  if (mode === 'emergency') $('#emergency-input').focus();
  else (mode === 'pin' ? allInputs($('#unlock-pin')) : allInputs($('#recovery-input')))[0]?.focus();
}

async function setupVault(event) {
  event.preventDefault();
  const pin = values($('#setup-pin')); const confirm = values($('#setup-pin-confirm'));
  if (pin !== confirm) { clearCredentialInputs(); return authError('PIN не совпадают.'); }
  clearCredentialInputs();
  try {
    const result = await request('setup', {
      pin,
      pinLength: state.pinLength,
      emergencyWordCount: state.emergencyWordCount,
      destructionConfirmed: $('#destruction-consent').checked,
    });
    const recoveryKeys = [...result.recoveryKeys];
    const emergencyPhrase = String(result.emergencyPhrase || '');
    delete result.recoveryKeys;
    delete result.emergencyPhrase;
    state.status = result;
    $('#auth-screen').hidden = true; $('#recovery-screen').hidden = false;
    $('#recovery-key-list').replaceChildren(...recoveryKeys.map((key) => element('li', {}, key)));
    const emergencyWords = emergencyPhrase.split(/\s+/u).filter(Boolean);
    $('#emergency-phrase-count').textContent = `${emergencyWords.length} слов`;
    $('#emergency-phrase-list').replaceChildren(...emergencyWords.map((word, index) => element('li', {}, `${index + 1}. ${word}`)));
    [...$('#recovery-key-list').children, ...$('#emergency-phrase-list').children]
      .forEach((item, index) => item.style.setProperty('--motion-index', index));
    recoveryKeys.fill('');
  } catch (error) { authError(error.message); }
}

async function unlockVault(event) {
  event.preventDefault();
  const credential = state.authMode === 'pin'
    ? { pin: values($('#unlock-pin')) }
    : state.authMode === 'recovery'
      ? { key: values($('#recovery-input')).match(/.{1,4}/g)?.join('-') || '' }
      : { phrase: $('#emergency-input').value };
  clearCredentialInputs();
  try {
    state.status = state.authMode === 'pin'
      ? await request('unlockPin', credential)
      : state.authMode === 'recovery'
        ? await request('unlockRecovery', credential)
        : await request('unlockEmergency', credential);
    await enterVault();
  } catch (error) {
    state.status = await request('status').catch(() => state.status);
    if (!state.status?.configured) showAuth(); else updateAttempts();
    authError(error.message);
  }
}

async function enterVault() {
  try {
    if (state.status?.provisioning) state.status = await request('completeSetup', { recoveryAcknowledged: true });
    state.manifest = await request('list');
    state.status = await request('status');
    $('#recovery-key-list').replaceChildren();
    $('#emergency-phrase-list').replaceChildren();
    $('#emergency-phrase-count').textContent = '';
    $('#recovery-saved').checked = false;
    $('#enter-vault').disabled = true;
    $('#auth-screen').hidden = true; $('#recovery-screen').hidden = true; $('#vault-screen').hidden = false;
    $('#vault-screen').classList.add('is-preparing');
    state.sectionId = 'all'; state.folderId = null; state.selected.clear(); closeEditor(); renderAll();
    await playSafeTransition('unlock');
    $('#vault-screen').classList.remove('is-preparing');
    $('#vault-screen').classList.add('is-revealed');
    window.setTimeout(() => $('#vault-screen').classList.remove('is-revealed'), reducedMotion.matches ? 80 : 900);
    armUiLock();
    if (state.pendingSettingsOpen) openSecuritySettings();
  } catch (error) { authError(error.message); }
}

async function lockVault() {
  state.status = { ...(state.status || {}), unlocked: false };
  showAuth();
  const transition = playSafeTransition('lock');
  await request('lock').catch(() => undefined);
  state.status = await request('status').catch(() => ({ configured: true, unlocked: false }));
  showAuth();
  await transition;
}

async function requestManualLock() {
  if (state.currentDirty) {
    const confirmed = await confirmInsideSafe({
      title: 'Несохранённые изменения',
      copy: 'Заблокировать Safe и безвозвратно очистить несохранённый черновик?',
      actionLabel: 'Заблокировать',
    });
    if (!confirmed) return;
  }
  await lockVault();
}

async function playSafeTransition(mode) {
  if (state.transitionPromise) return state.transitionPromise;
  const overlay = $('#safe-transition');
  if (!overlay) return undefined;
  state.transitionPromise = (async () => {
    overlay.dataset.mode = mode;
    overlay.classList.remove('is-leaving', 'is-open');
    overlay.hidden = false;
    document.body.classList.add('safe-transition-active');
    await nextPaint();
    overlay.classList.add('is-visible');
    await delay(reducedMotion.matches ? 20 : 55);
    overlay.classList.toggle('is-open', mode === 'unlock');
    await delay(reducedMotion.matches ? 35 : mode === 'unlock' ? 210 : 150);
    overlay.classList.add('is-leaving');
    await delay(reducedMotion.matches ? 25 : 110);
    overlay.classList.remove('is-visible', 'is-leaving', 'is-open');
    overlay.hidden = true;
    document.body.classList.remove('safe-transition-active');
  })().finally(() => { state.transitionPromise = null; });
  return state.transitionPromise;
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function renderAll() { renderSections(); renderFiles(); renderCapacity(); }

function renderSections() {
  const list = $('#section-list'); list.replaceChildren();
  const all = sectionButton('all', 'Все файлы', '#f59e0b', state.manifest.files.length); list.append(all);
  state.manifest.sections.forEach((section) => list.append(sectionButton(section.id, section.name, section.color, state.manifest.files.filter((file) => file.sectionId === section.id).length)));
  [...list.children].forEach((button, index) => button.style.setProperty('--motion-index', index));
  $('#edit-section').hidden = state.sectionId === 'all';
}

function sectionButton(id, name, color, count) {
  const button = element('button', { type: 'button', 'data-section-id': id, class: state.sectionId === id ? 'active' : '' });
  button.style.setProperty('--section-color', color); button.append(element('span', { class: 'section-dot' }), element('span', {}, name), element('span', { class: 'section-count' }, String(count))); return button;
}

function renderFiles() {
  if (!state.manifest) return;
  const body = $('#file-list'); body.replaceChildren();
  const folders = state.manifest.folders.filter((folder) => state.sectionId !== 'all' && folder.sectionId === state.sectionId && !state.folderId);
  folders.forEach((folder) => {
    const open = element('button', { type: 'button', class: 'file-open-button', 'aria-label': `Открыть папку «${folder.name}»` }, iconName('folder', folder.name));
    const actions = element('div', { class: 'row-actions' },
      element('button', { type: 'button', 'data-edit-folder': folder.id, 'aria-label': `Переименовать папку «${folder.name}»`, title: 'Переименовать' }, '✎'),
      element('button', { type: 'button', class: 'row-delete', 'data-delete-folder': folder.id, 'aria-label': `Удалить папку «${folder.name}»`, title: 'Удалить' }, '×'),
    );
    const row = element('tr', { 'data-folder-id': folder.id }); row.append(element('td'), element('td', {}, open), element('td', {}, 'Папка'), element('td', {}, formatDate(folder.updatedAt)), element('td', {}, '—'), element('td', { class: 'row-actions-cell' }, actions)); body.append(row);
  });
  let files = state.manifest.files.filter((file) => (state.sectionId === 'all' || file.sectionId === state.sectionId) && (!state.folderId || file.folderId === state.folderId));
  const query = $('#safe-search').value.trim().toLowerCase(); if (query) files = files.filter((file) => file.name.toLowerCase().includes(query));
  const type = $('#type-filter').value; if (type !== 'all') files = files.filter((file) => fileKind(file) === type);
  const sort = $('#sort-order').value; files.sort(sort === 'name-asc' ? (a,b)=>a.name.localeCompare(b.name,'ru') : sort === 'size-desc' ? (a,b)=>b.size-a.size : sort === 'type-asc' ? (a,b)=>a.mime.localeCompare(b.mime) : (a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  files.forEach((file) => {
    const row = element('tr', { 'data-file-id': file.id, class: state.currentFile?.id === file.id ? 'active' : '' });
    const checkbox = element('input', { type: 'checkbox', 'data-file-check': file.id, 'aria-label': `Выбрать ${file.name}` }); checkbox.checked = state.selected.has(file.id);
    const open = element('button', { type: 'button', class: 'file-open-button', 'aria-label': `Открыть файл «${file.name}»` }, iconName(fileKind(file), file.name));
    const deleteButton = element('button', { type: 'button', class: 'row-delete', 'data-delete-file': file.id, 'aria-label': `Удалить файл «${file.name}»`, title: 'Удалить файл' }, '×');
    row.append(element('td', { class: 'select-cell' }, checkbox), element('td', {}, open), element('td', {}, kindLabel(file)), element('td', {}, formatDate(file.updatedAt)), element('td', {}, formatBytes(file.size)), element('td', { class: 'row-actions-cell' }, deleteButton)); body.append(row);
  });
  [...body.children].forEach((row, index) => row.style.setProperty('--motion-index', index));
  $('#empty-state').hidden = folders.length + files.length > 0;
  if (state.folderId) {
    const folderName = state.manifest.folders.find((folder) => folder.id === state.folderId)?.name || '';
    $('#breadcrumb').replaceChildren(
      element('button', { type: 'button', class: 'breadcrumb-back', 'data-folder-back': '', 'aria-label': `Вернуться в раздел «${sectionName()}»` }, '← ', sectionName()),
      element('span', { 'aria-current': 'page' }, folderName),
    );
  } else $('#breadcrumb').textContent = sectionName();
  renderSelectionState(files.map((file) => file.id));
}

async function openFile(id) {
  if (state.currentDirty) {
    const confirmed = await confirmInsideSafe({
      title: 'Несохранённые изменения',
      copy: `Открыть другой файл и безвозвратно отбросить изменения в «${state.currentFile?.name || 'текущем файле'}»?`,
      actionLabel: 'Отбросить и открыть',
    });
    if (!confirmed) return;
  }
  try {
    const result = await request('readFile', { id });
    revokeObjectUrl(); state.currentBytes?.fill(0); state.currentFile = result.file; state.currentBytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes); renderFiles();
    $('#editor-empty').hidden = true; $('#editor-active').hidden = false; $('#editor-active').classList.remove('motion-reveal'); void $('#editor-active').offsetWidth; $('#editor-active').classList.add('motion-reveal'); $('#editor-file-name').textContent = result.file.name;
    const textLike = isText(result.file); const kind = fileKind(result.file);
    state.currentEditable = textLike ? result.file.size <= MAX_EDITABLE_TEXT_BYTES : kind === 'binary' && result.file.size <= MAX_EDITABLE_HEX_BYTES;
    $('#text-editor').hidden = !textLike;
    $('#hex-editor').hidden = textLike || kind !== 'binary' || !state.currentEditable;
    $('#binary-summary').hidden = textLike || (kind === 'binary' && state.currentEditable);
    $('#binary-summary').textContent = kind === 'binary'
      ? `HEX-редактор ограничен ${formatBytes(MAX_EDITABLE_HEX_BYTES)}. В просмотре показан только безопасный фрагмент.`
      : 'Байтовое редактирование отключено для этого формата. Используй изолированный просмотр.';
    $('#save-file').hidden = !state.currentEditable;
    if (textLike) {
      $('#text-editor').readOnly = !state.currentEditable;
      $('#text-editor').value = new TextDecoder().decode(state.currentBytes.subarray(0, MAX_EDITABLE_TEXT_BYTES));
    } else if (state.currentEditable) $('#hex-editor').value = bytesToHex(state.currentBytes);
    else $('#hex-editor').value = '';
    setCurrentFileDirty(false);
    $('#extract-archive').hidden = result.file.mime !== 'application/x-monarch-safe-archive'; setEditorTab('edit');
    focusFileControl('[data-file-id]', id);
  } catch (error) { toast(error.message, true); }
}

function setEditorTab(tab) {
  document.querySelectorAll('[data-editor-tab]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.editorTab === tab)));
  $('#edit-pane').hidden = tab !== 'edit'; $('#preview-pane').hidden = tab !== 'preview'; if (tab === 'preview') renderPreview();
  const activePane = tab === 'edit' ? $('#edit-pane') : $('#preview-pane');
  activePane.classList.remove('motion-tab-in'); void activePane.offsetWidth; activePane.classList.add('motion-tab-in');
}

function renderPreview() {
  const pane = $('#preview-pane'); revokeObjectUrl(); pane.replaceChildren(); if (!state.currentFile) return;
  const file = state.currentFile; const bytes = state.currentBytes; const kind = fileKind(file);
  if (isText(file)) { pane.innerHTML = file.mime === 'text/markdown' ? renderMarkdown($('#text-editor').value) : `<pre>${escapeHtml($('#text-editor').value)}</pre>`; return; }
  if (kind === 'pdf') {
    renderPdfSummary(pane, file, bytes);
  } else if (['image', 'media'].includes(kind)) {
    const blob = new Blob([bytes], { type: file.mime }); state.objectUrl = URL.createObjectURL(blob);
    if (kind === 'image') pane.append(element('img', { src: state.objectUrl, alt: file.name }));
    else if (file.mime.startsWith('video/')) pane.append(element('video', { src: state.objectUrl, controls: '' }));
    else if (file.mime.startsWith('audio/')) pane.append(element('audio', { src: state.objectUrl, controls: '' }));
  } else pane.append(element('pre', {}, bytesToHex(bytes.subarray(0, 8192)) + (bytes.length > 8192 ? '\n…' : '')));
}

function renderPdfSummary(pane, file, bytes) {
  const sample = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)));
  const validHeader = sample.startsWith('%PDF-');
  const visiblePages = (sample.match(/\/Type\s*\/Page\b/g) || []).length;
  pane.append(element('section', { class: 'pdf-summary', 'data-pdf-preview': '' },
    element('strong', {}, validHeader ? 'PDF проверен структурно' : 'PDF-сигнатура не подтверждена'),
    element('span', {}, `${file.name} · ${formatBytes(file.size)}`),
    element('span', {}, visiblePages ? `Страниц найдено в ограниченном проходе: ${visiblePages}` : 'Страницы не декодировались в этом безопасном проходе.'),
    element('small', {}, 'JavaScript, формы, вложения, внешние ссылки и системный PDF-viewer не запускаются.'),
  ));
}

async function saveCurrentFile() {
  if (!state.currentFile || !state.currentEditable) return;
  let bytes = null;
  try {
    bytes = isText(state.currentFile) ? new TextEncoder().encode($('#text-editor').value) : hexToBytes($('#hex-editor').value);
    const capabilityToken = await bridge.authorizeWrite({ id: state.currentFile.id, name: state.currentFile.name });
    if (!capabilityToken) return;
    state.currentFile = await request('writeFile', { id: state.currentFile.id, bytes, capabilityToken });
    state.currentBytes?.fill(0); state.currentBytes = bytes; bytes = null;
    state.manifest = await request('list'); setCurrentFileDirty(false); renderAll(); toast('Файл зашифрован новым ключом версии и сохранён.');
  } catch (error) { toast(error.message, true); }
  finally { bytes?.fill(0); }
}

function openItemDialog(mode, entityId = null) {
  const editingSection = mode === 'edit-section';
  const editingFolder = mode === 'edit-folder';
  const section = editingSection ? state.manifest.sections.find((entry) => entry.id === state.sectionId) : null;
  const folder = editingFolder ? state.manifest.folders.find((entry) => entry.id === entityId) : null;
  if (editingSection && !section) return toast('Раздел не найден.', true);
  if (editingFolder && !folder) return toast('Папка не найдена.', true);
  state.itemMode = mode;
  $('#item-dialog').dataset.entityId = entityId || '';
  $('#item-dialog-title').textContent = editingSection ? 'Настроить раздел' : editingFolder ? 'Переименовать папку' : mode === 'section' ? 'Новый раздел' : mode === 'folder' ? 'Новая папка' : 'Новый файл';
  $('#item-submit').textContent = editingSection || editingFolder ? 'Сохранить' : 'Создать';
  $('#item-type-row').hidden = mode !== 'file';
  $('#item-color-row').hidden = !['section', 'edit-section'].includes(mode);
  $('#item-delete').hidden = !editingSection && !editingFolder;
  $('#item-name').value = section?.name || folder?.name || '';
  $('#item-color').value = section?.color || '#f59e0b';
  const destination = ['file', 'folder'].includes(mode) ? resolveCreationDestination() : null;
  $('#item-destination').textContent = destination
    ? `Будет создано в разделе «${destination.name}»${state.folderId && mode === 'file' ? ' · в открытой папке' : ''}.`
    : '';
  $('#item-destination').hidden = !destination;
  if (mode === 'file') updateFileFormatHint();
  $('#item-dialog').showModal(); $('#item-name').focus();
}

async function submitItemDialog(event) {
  event.preventDefault();
  try {
    if (state.itemMode === 'section') await request('createSection', { name: $('#item-name').value, color: $('#item-color').value });
    else if (state.itemMode === 'edit-section') await request('updateSection', { id: state.sectionId, name: $('#item-name').value, color: $('#item-color').value });
    else if (state.itemMode === 'edit-folder') await request('updateFolder', { id: $('#item-dialog').dataset.entityId, name: $('#item-name').value });
    else if (state.itemMode === 'folder') {
      const destination = resolveCreationDestination();
      if (!destination) throw new Error('Safe не содержит раздела для новой папки.');
      const folder = await request('createFolder', { name: $('#item-name').value, sectionId: destination.id });
      if (state.sectionId === 'all') { state.sectionId = destination.id; state.folderId = folder.id; }
    }
    else {
      const destination = resolveCreationDestination();
      if (!destination) throw new Error('Safe не содержит раздела для нового файла.');
      const formatId = $('#item-type').value;
      const format = getSafeFileFormat(formatId);
      await request('createFile', {
        name: withSafeFileExtension($('#item-name').value, formatId),
        mime: format.mime,
        text: seedSafeFileContent(formatId),
        sectionId: destination.id,
        folderId: state.folderId,
      });
    }
    $('#item-dialog').close(); state.manifest = await request('list'); renderAll();
  } catch (error) { toast(error.message, true); }
}

function resolveCreationDestination() {
  if (!state.manifest?.sections?.length) return null;
  if (state.sectionId !== 'all') {
    const selected = state.manifest.sections.find((section) => section.id === state.sectionId);
    if (selected) return selected;
  }
  return state.manifest.sections[0];
}

async function deleteEditedContainer() {
  const id = $('#item-dialog').dataset.entityId;
  if (!id) return;
  const isSection = state.itemMode === 'edit-section';
  const label = isSection ? 'раздел' : 'папку';
  if (!await confirmInsideSafe({
    title: `Удалить ${label}`,
    copy: `Удалить ${label} «${$('#item-name').value}»? Это возможно только если внутри нет файлов и вложенных папок.`,
    actionLabel: 'Удалить',
  })) return;
  try {
    await request(isSection ? 'deleteSection' : 'deleteFolder', { id });
    $('#item-dialog').close();
    state.sectionId = isSection ? 'all' : state.sectionId;
    if (!isSection && state.folderId === id) state.folderId = null;
    state.manifest = await request('list');
    renderAll();
    toast(`${isSection ? 'Раздел' : 'Папка'} удалён${isSection ? '' : 'а'}.`);
  } catch (error) { toast(error.message, true); }
}

async function importFiles(fileList) {
  if (!fileList?.length || state.importing) return;
  const destination = resolveImportDestination();
  if (!destination) return toast('Сначала создай хотя бы один раздел для импорта.', true);
  state.importing = true;
  $('#import-files').disabled = true;
  $('#import-files').setAttribute('aria-busy', 'true');
  $('#file-drop-zone').classList.add('is-importing');
  let imported = 0;
  let failure = null;
  const files = [...fileList];
  try {
    for (const [index, file] of files.entries()) {
      let bytes = null;
      try {
        $('#import-files').textContent = `Шифрую ${index + 1}/${files.length}`;
        bytes = new Uint8Array(await file.arrayBuffer());
        await request('importFile', {
          name: file.name,
          mime: file.type || 'application/octet-stream',
          bytes,
          sectionId: destination.id,
          folderId: state.sectionId === 'all' ? null : state.folderId,
        });
        imported += 1;
      }
      catch (error) { failure = `${file.name}: ${error.message}`; break; }
      finally { bytes?.fill(0); }
    }
    state.manifest = await request('list');
    renderAll();
  } catch (error) {
    failure ||= error.message || 'Safe отклонил импорт.';
  } finally {
    $('#file-input').value = '';
    state.importing = false;
    $('#import-files').disabled = false;
    $('#import-files').removeAttribute('aria-busy');
    $('#import-files').textContent = 'Импорт';
    $('#file-drop-zone').classList.remove('is-importing');
  }
  if (failure) toast(`Импортировано: ${imported}. Ошибка: ${failure}. Внешние исходники не удалялись.`, true);
  else toast(`Импортировано: ${imported} в «${destination.name}». Зашифрованные копии сохранены в Safe; внешние исходники не удалялись.`);
}

function resolveImportDestination() {
  if (!state.manifest?.sections?.length) return null;
  if (state.sectionId !== 'all') {
    const selected = state.manifest.sections.find((section) => section.id === state.sectionId);
    if (selected) return selected;
  }
  return state.manifest.sections[0];
}

function hasFileDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

async function archiveSelected() {
  if (!state.selected.size || state.sectionId === 'all') return toast('Выбери файлы внутри одного раздела.', true);
  try { await request('createArchive', { fileIds: [...state.selected], name: `Архив-${new Date().toISOString().slice(0,10)}.msa`, sectionId: state.sectionId, folderId: state.folderId }); state.selected.clear(); state.manifest = await request('list'); renderAll(); toast('Внутренний архив Safe создан.'); } catch (error) { toast(error.message, true); }
}

async function extractCurrentArchive() { try { await request('extractArchive', { id: state.currentFile.id, sectionId: state.currentFile.sectionId, folderId: state.currentFile.folderId }); state.manifest = await request('list'); renderAll(); toast('Архив проверен и распакован внутри Safe.'); } catch (error) { toast(error.message, true); } }
async function deleteCurrentFile() {
  if (!state.currentFile) return;
  if (state.currentDirty && !await confirmInsideSafe({
    title: 'Несохранённый черновик',
    copy: 'Удаление также безвозвратно очистит несохранённые изменения в редакторе.',
    actionLabel: 'Продолжить',
  })) return;
  await deleteFilesById([state.currentFile.id]);
}
async function deleteSelectedFiles() {
  await deleteFilesById([...state.selected]);
}
async function deleteFilesById(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return;
  const files = uniqueIds.map((id) => state.manifest.files.find((file) => file.id === id)).filter(Boolean);
  if (!files.length) return;
  try {
    const authorization = files.length === 1
      ? await bridge.authorizeDelete({ id: files[0].id, name: files[0].name })
      : await bridge.authorizeDelete({ files: files.map(({ id, name }) => ({ id, name })) });
    const tokens = typeof authorization === 'string'
      ? [{ id: files[0].id, capabilityToken: authorization }]
      : Array.isArray(authorization?.tokens) ? authorization.tokens : [];
    if (!tokens.length) return;
    for (const token of tokens) await request('deleteFile', token);
    const deletedIds = new Set(tokens.map((entry) => entry.id));
    state.manifest = await request('list');
    deletedIds.forEach((id) => state.selected.delete(id));
    if (state.currentFile && deletedIds.has(state.currentFile.id)) closeEditor();
    renderAll();
    toast(tokens.length === 1 ? 'Файл удалён. Его активный ключ уничтожен.' : `Удалено файлов: ${tokens.length}. Активные ключи уничтожены.`);
  } catch (error) { toast(error.message, true); }
}
async function deleteFolderById(id) {
  const folder = state.manifest.folders.find((entry) => entry.id === id);
  if (!folder) return;
  if (!await confirmInsideSafe({ title: 'Удалить папку', copy: `Удалить пустую папку «${folder.name}»?`, actionLabel: 'Удалить' })) return;
  try {
    await request('deleteFolder', { id });
    state.manifest = await request('list');
    if (state.folderId === id) state.folderId = null;
    renderAll();
    toast('Папка удалена.');
  } catch (error) { toast(error.message, true); }
}
function toggleSelectAll(event) { visibleFileIds().forEach((id) => event.target.checked ? state.selected.add(id) : state.selected.delete(id)); renderFiles(); }
function renderSelectionState(visibleIds = visibleFileIds()) {
  const selectedVisible = visibleIds.filter((id) => state.selected.has(id));
  $('#delete-selected').disabled = state.selected.size === 0;
  $('#delete-selected').textContent = state.selected.size ? `Удалить · ${state.selected.size}` : 'Удалить выбранное';
  $('#archive-files').disabled = state.selected.size === 0 || state.sectionId === 'all';
  $('#select-all').checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  $('#select-all').indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
}
function closeEditor() { revokeObjectUrl(); state.currentBytes?.fill(0); state.currentFile = null; state.currentBytes = null; state.currentEditable = false; setCurrentFileDirty(false); $('#text-editor').value = ''; $('#text-editor').readOnly = false; $('#hex-editor').value = ''; $('#binary-summary').textContent = ''; $('#binary-summary').hidden = true; $('#save-file').hidden = false; $('#editor-empty').hidden = false; $('#editor-active').hidden = true; }
function markCurrentFileDirty() { armUiLock(); setCurrentFileDirty(true); }
function setCurrentFileDirty(value) {
  state.currentDirty = Boolean(value && state.currentFile && state.currentEditable);
  const saveButton = $('#save-file');
  saveButton.dataset.dirty = String(state.currentDirty);
  saveButton.textContent = state.currentDirty ? 'Сохранить •' : 'Сохранить';
  saveButton.setAttribute('aria-label', state.currentDirty ? 'Сохранить несохранённые изменения' : 'Сохранить файл');
  if (!state.currentFile) $('#editor-meta').textContent = '';
  else $('#editor-meta').textContent = state.currentDirty
    ? `${kindLabel(state.currentFile)} · ${formatBytes(state.currentFile.size)} · не сохранено; блокировка очистит черновик`
    : `${kindLabel(state.currentFile)} · ${formatBytes(state.currentFile.size)} · только внутри Safe`;
}
function focusFileControl(attribute, id) {
  if (!id) return;
  const attributeName = attribute.slice(1, -1);
  const row = [...$('#file-list').querySelectorAll(attribute)].find((entry) => entry.getAttribute(attributeName) === id);
  row?.querySelector('.file-open-button')?.focus({ preventScroll: true });
}
function armUiLock() {
  clearTimeout(state.lockTimer);
  if (!state.status?.unlocked) return;
  scheduleUiLock();
  const now = Date.now();
  if (state.runtimeTouchPending || now - state.runtimeTouchAt < RUNTIME_ACTIVITY_TOUCH_THROTTLE_MS) return;
  state.runtimeTouchAt = now;
  state.runtimeTouchPending = true;
  bridge.request('touch')
    .then((status) => { if (status?.unlocked) state.status = status; })
    .catch(() => undefined)
    .finally(() => { state.runtimeTouchPending = false; });
}
async function request(action, payload = {}) {
  clearTimeout(state.lockTimer);
  if (state.status?.unlocked) scheduleUiLock();
  return bridge.request(action, payload);
}
function scheduleUiLock() {
  const milliseconds = Number(state.status?.autoLockMs);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  state.lockTimer = setTimeout(lockVault, milliseconds + UI_AUTO_LOCK_GRACE_MS);
}
function currentSecurityPolicy() {
  return normalizeSafeSecurityPolicy(state.status?.securityPolicy);
}
function shouldBlockClipboardEvent(type) {
  const mode = currentSecurityPolicy().clipboardMode;
  if (mode === 'read-write') return false;
  if (mode === 'copy-only') return type === 'paste';
  return true;
}
function openSecuritySettings() {
  state.pendingSettingsOpen = false;
  if (!state.status?.unlocked) {
    state.pendingSettingsOpen = true;
    toast('Сначала разблокируй Safe. Настройки откроются сразу после входа.', true);
    return;
  }
  const policy = currentSecurityPolicy();
  $('#safe-auto-lock').value = String(policy.autoLockMs);
  $('#safe-minimize-action').value = policy.minimizeAction;
  $('#safe-clipboard-mode').value = policy.clipboardMode;
  $('#safe-lock-on-blur').checked = policy.lockOnBlur;
  $('#safe-clear-clipboard').checked = policy.clearClipboardOnLock;
  $('#safe-settings-pin').value = '';
  $('#safe-settings-error').textContent = '';
  renderSecurityAssessment();
  $('#safe-settings-dialog').showModal();
  $('#safe-auto-lock').focus();
}
function closeSecuritySettings() {
  $('#safe-settings-pin').value = '';
  $('#safe-settings-error').textContent = '';
  $('#safe-settings-dialog').close('cancel');
}
function readSecurityPolicyForm() {
  return normalizeSafeSecurityPolicy({
    autoLockMs: Number($('#safe-auto-lock').value),
    minimizeAction: $('#safe-minimize-action').value,
    clipboardMode: $('#safe-clipboard-mode').value,
    lockOnBlur: $('#safe-lock-on-blur').checked,
    clearClipboardOnLock: $('#safe-clear-clipboard').checked,
  });
}
function renderSecurityAssessment() {
  const assessment = assessSafeSecurityPolicy(readSecurityPolicyForm());
  const panel = $('#safe-policy-assessment');
  panel.dataset.level = assessment.level;
  panel.querySelector('strong').textContent = assessment.level === 'low'
    ? 'Пониженная защита'
    : assessment.level === 'balanced'
      ? 'Сбалансированный профиль'
      : 'Сильный профиль';
  $('#safe-policy-warnings').replaceChildren(...assessment.warnings.map((warning) => element('li', {}, warning)));
  return assessment;
}
async function saveSecuritySettings(event) {
  event.preventDefault();
  const pin = $('#safe-settings-pin').value;
  $('#safe-settings-pin').value = '';
  const assessment = renderSecurityAssessment();
  let lowSecurityAcknowledged = false;
  if (assessment.level === 'low') {
    lowSecurityAcknowledged = await confirmInsideSafe({
      title: 'Ослабить защиту Safe?',
      copy: `Эти параметры менее безопасны:\n${assessment.warnings.map((warning) => `• ${warning}`).join('\n')}\n\nПродолжить можно только осознанно.`,
      actionLabel: 'Да, применить',
    });
    if (!lowSecurityAcknowledged) return;
  }
  try {
    state.status = await request('updateSecurityPolicy', {
      pin,
      policy: assessment.policy,
      lowSecurityAcknowledged,
    });
    closeSecuritySettings();
    armUiLock();
    toast('Настройки безопасности подтверждены текущим PIN и сохранены.');
  } catch (error) {
    $('#safe-settings-error').textContent = error.message;
    $('#safe-settings-pin').focus();
  }
}
function updateAttempts() {
  $('#pin-attempts').textContent = state.status?.attemptsRemaining ?? 0;
  $('#key-attempts').textContent = state.status?.recoveryAttemptAvailable ? '1' : '0';
  const offered = state.status?.emergencyRecoveryOffered === true;
  $('#emergency-auth-tab').hidden = !offered;
  $('#emergency-offer-note').hidden = !offered;
  if (!offered && state.authMode === 'emergency') setAuthMode('pin');
}
function authError(message) { $('#auth-error').textContent = message; $('.auth-core').classList.remove('shake'); requestAnimationFrame(() => $('.auth-core').classList.add('shake')); }
function toast(message, error = false) { const node = $('#toast'); node.textContent = message; node.classList.toggle('error', error); node.hidden = false; clearTimeout(node._timer); node._timer = setTimeout(() => { node.hidden = true; }, 3600); }
function allInputs(container) { return [...container.querySelectorAll('input')]; }
function values(container) { return allInputs(container).map((input) => input.value).join(''); }
function fileKind(file) { if (file.mime === 'application/x-monarch-safe-archive') return 'archive'; if (isText(file)) return 'text'; if (file.mime.startsWith('image/')) return 'image'; if (file.mime.startsWith('audio/') || file.mime.startsWith('video/')) return 'media'; if (file.mime === 'application/pdf') return 'pdf'; return 'binary'; }
function isText(file) { return isSafeEditableTextMime(file.mime); }
function kindLabel(file) { return ({text:'Текст / код',image:'Изображение',media:file.mime.startsWith('audio/')?'Аудио':'Видео',pdf:'PDF',archive:'Архив Safe',binary:'Бинарный файл'})[fileKind(file)]; }
function iconName(kind, name) { const labels={folder:'▱',text:'TXT',image:'IMG',media:'▶',pdf:'PDF',archive:'ZIP',binary:'BIN'}; return element('span',{class:'file-name'},element('span',{class:`file-icon ${kind}`},labels[kind]||'•'),element('span',{},name)); }
function sectionName() { return state.sectionId === 'all' ? 'Все файлы' : state.manifest.sections.find((entry)=>entry.id===state.sectionId)?.name || 'Раздел'; }
function renderCapacity() { const total=state.manifest.files.reduce((sum,file)=>sum+file.size,0); $('#capacity-label').textContent=formatBytes(total); $('#capacity-fill').style.width=`${Math.min(100,total/(1024**3)*100)}%`; }
function visibleFileIds() { return [...$('#file-list').querySelectorAll('[data-file-id]')].map((row)=>row.dataset.fileId); }
function formatBytes(value) { if (!value) return '0 Б'; const units=['Б','КБ','МБ','ГБ']; const index=Math.min(units.length-1,Math.floor(Math.log(value)/Math.log(1024))); return `${(value/1024**index).toFixed(index?1:0)} ${units[index]}`; }
function formatDate(value) { return new Intl.DateTimeFormat('ru',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)); }
function bytesToHex(bytes) { return [...bytes].map((value)=>value.toString(16).padStart(2,'0')).join(' ').replace(/((?:[0-9a-f]{2} ){15}[0-9a-f]{2}) /g,'$1\n'); }
function hexToBytes(value) { const compact=value.replace(/\s/g,''); if (!/^(?:[0-9a-f]{2})*$/i.test(compact)) throw new Error('HEX содержит недопустимые символы или неполный байт.'); return Uint8Array.from(compact.match(/.{2}/g)||[],(pair)=>parseInt(pair,16)); }
function renderMarkdown(value) { return escapeHtml(value).split('\n').map((line)=>line.startsWith('### ')?`<h3>${line.slice(4)}</h3>`:line.startsWith('## ')?`<h2>${line.slice(3)}</h2>`:line.startsWith('# ')?`<h1>${line.slice(2)}</h1>`:line.startsWith('- ')?`<li>${line.slice(2)}</li>`:`<p>${line||'&nbsp;'}</p>`).join(''); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function revokeObjectUrl() { if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); state.objectUrl=null; $('#preview-pane')?.replaceChildren(); }
function purgePlaintextUi() {
  closeEditor();
  clearCredentialInputs();
  state.manifest = null;
  state.selected.clear();
  $('#file-list')?.replaceChildren();
  $('#section-list')?.replaceChildren();
  $('#breadcrumb').textContent = '';
  $('#safe-search').value = '';
  $('#recovery-key-list').replaceChildren();
  $('#emergency-phrase-list').replaceChildren();
  $('#emergency-phrase-count').textContent = '';
}
function clearCredentialInputs() {
  document.querySelectorAll('#setup-pin input,#setup-pin-confirm input,#unlock-pin input,#recovery-input input').forEach((input) => {
    input.value = '';
    input.classList.remove('has-value');
  });
  $('#emergency-input').value = '';
  $('#safe-settings-pin').value = '';
}
function confirmInsideSafe({ title = 'Подтверждение', copy, actionLabel = 'Продолжить' }) {
  const dialog = $('#confirm-dialog');
  dialog.returnValue = '';
  $('#confirm-title').textContent = title;
  $('#confirm-copy').textContent = copy;
  $('#confirm-action').textContent = actionLabel;
  return new Promise((resolve) => {
    const done = () => { dialog.removeEventListener('close', done); resolve(dialog.returnValue === 'default'); };
    dialog.addEventListener('close', done);
    dialog.showModal();
  });
}
function element(tag, attrs={}, ...children) { const node=document.createElement(tag); Object.entries(attrs).forEach(([key,value])=>{ if (key==='class') node.className=value; else if (value!==undefined) node.setAttribute(key,value); }); node.append(...children); return node; }
function populateFileFormats() {
  const select = $('#item-type');
  if (!select || select.options.length > 0) return;
  for (const group of SAFE_FILE_FORMAT_GROUPS) {
    const optgroup = element('optgroup', { label: group.label });
    for (const format of group.formats) {
      const suffix = format.extension || format.defaultName || '';
      optgroup.append(element('option', { value: format.id }, suffix ? `${format.label} · ${suffix}` : format.label));
    }
    select.append(optgroup);
  }
  select.value = 'text/plain';
  updateFileFormatHint();
}

function updateFileFormatHint() {
  const format = getSafeFileFormat($('#item-type')?.value);
  const extensionLabel = format.extensions.length > 1
    ? format.extensions.join(' / ')
    : format.extension || format.defaultName || 'без расширения';
  $('#item-type-hint').textContent = `${extensionLabel} · ${format.mime} · редактируется только внутри Safe`;
  $('#item-name').placeholder = format.defaultName || `Например: новый-файл${format.extension}`;
}
