import path from 'node:path';
import { ASTRA_RUNTIME_PILOT_MODE } from './astra-pilot-policy.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,91}$/u.test(value);
function check(value, code) { if (!value) throw Error('astra-product-host:' + code); }

/** Main-frame guard retained across the native modal. Same-URL reloads and any
 * navigation invalidate the caller even when the WebContents id is unchanged. */
export function acquireAstraProductRendererGuard({ window, runtimeUrl, event, assertTrustedRenderer }) {
  check(window && !window.isDestroyed() && typeof assertTrustedRenderer === 'function', 'window');
  const origin = new URL(runtimeUrl).origin, contents = window.webContents, frame = event?.senderFrame, frameUrl = frame?.url;
  let navigated = false;
  const assert = () => {
    check(!navigated && !window.isDestroyed() && !contents.isDestroyed() && event.sender === contents
      && frame && frame === contents.mainFrame && frame === event.senderFrame && frame.url === frameUrl
      && new URL(frameUrl).origin === origin, 'untrusted-renderer');
    assertTrustedRenderer(event);
  };
  assert();
  const onNavigation = () => { navigated = true; };
  contents.on('did-start-navigation', onNavigation);
  return { assert, dispose: () => contents.removeListener('did-start-navigation', onNavigation) };
}

/** Native target selection for the opt-in product pilot. Raw paths and the host
 * token travel main -> runtime only and are never returned to the renderer. */
export async function pickAstraProductTarget(options) {
  check(options?.mode === ASTRA_RUNTIME_PILOT_MODE && typeof options.assertRenderer === 'function'
    && typeof options.fetchImpl === 'function' && typeof options.hostToken === 'string' && options.hostToken.length >= 32
    && typeof options.desktopAttestationToken === 'string' && options.desktopAttestationToken.length >= 32
    && path.isAbsolute(options.defaultDirectory), 'unavailable');
  options.assertRenderer();
  const raw = options.request;
  check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 4
    && Object.keys(raw).every(key => ['version', 'conversationId', 'requestId', 'access'].includes(key))
    && raw.version === 1 && id(raw.conversationId) && requestId(raw.requestId)
    && ['observe', 'exclusive-create'].includes(raw.access), 'request');
  let selectedPath = null, selectedPaths = null;
  if (raw.access === 'observe') {
    const result = await options.dialog.showOpenDialog(options.window, { title: 'Оскар: выбери до 8 файлов для чтения',
      message: 'MAX сможет ответить по всем выбранным файлам за одну задачу.',
      defaultPath: options.defaultDirectory, properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      buttonLabel: 'Выбрать файлы' });
    options.assertRenderer();
    if (result.canceled) return { status: 'cancelled' };
    check(Array.isArray(result.filePaths) && result.filePaths.length >= 1 && result.filePaths.length <= 8,
      'file-count');
    selectedPaths = result.filePaths;
  } else {
    const result = await options.dialog.showSaveDialog(options.window, { title: 'Astra V3: выбери имя нового файла (без перезаписи)',
      defaultPath: options.defaultDirectory, properties: ['dontAddToRecent'], buttonLabel: 'Выбрать для Astra' });
    options.assertRenderer();
    if (result.canceled) return { status: 'cancelled' };
    check(typeof result.filePath === 'string' && result.filePath, 'single-file-required');
    selectedPath = result.filePath;
  }
  const paths = selectedPaths || [selectedPath];
  check(paths.every(value => typeof value === 'string' && value.length <= options.defaultDirectory.length + 1025
    && path.isAbsolute(value) && path.normalize(value) === value)
    && new Set(paths.map(value => value.toLowerCase())).size === paths.length, 'selected-path');
  const runtime = new URL(options.runtimeUrl);
  check(runtime.protocol === 'http:' && runtime.hostname === '127.0.0.1' && runtime.origin === options.runtimeUrl, 'runtime-origin');
  options.assertRenderer();
  const response = await options.fetchImpl(new URL('/api/astra/v3/host/target-selections', runtime), { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json',
      'x-monarch-desktop-attestation': options.desktopAttestationToken, 'x-monarch-astra-host-token': options.hostToken },
    body: JSON.stringify(raw.access === 'observe' ? { ...raw, selectedPaths } : { ...raw, selectedPath }) });
  const responseText = await response.text();
  check(Buffer.byteLength(responseText) <= 32 * 1024, 'response-budget');
  let payload; try { payload = JSON.parse(responseText); } catch { throw Error('astra-product-host:response-json'); }
  check(response.status === 201 && validTargetResponse(payload), 'runtime-rejected');
  options.assertRenderer();
  return { status: 'selected', selection: structuredClone(payload.selection) };
}

/** Explicitly shares one native-picked file with one factual paired Telegram
 * actor. Main sends the raw path only to the local runtime; renderer receives
 * only a short-lived opaque read alias. */
export async function pickAstraTelegramTarget(options) {
  check(options?.mode === ASTRA_RUNTIME_PILOT_MODE && options.telegramMode === 'paired-workspace-read-v1'
    && typeof options.assertRenderer === 'function' && typeof options.fetchImpl === 'function'
    && typeof options.hostToken === 'string' && options.hostToken.length >= 32
    && typeof options.desktopAttestationToken === 'string' && options.desktopAttestationToken.length >= 32
    && path.isAbsolute(options.defaultDirectory), 'telegram-unavailable');
  options.assertRenderer();
  const raw = options.request;
  check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 5
    && Object.keys(raw).every(key => ['version', 'chatId', 'userId', 'requestId', 'ttlMs'].includes(key))
    && raw.version === 1 && Number.isSafeInteger(raw.chatId) && raw.chatId !== 0
    && Number.isSafeInteger(raw.userId) && raw.userId > 0 && requestId(raw.requestId)
    && Number.isSafeInteger(raw.ttlMs) && raw.ttlMs >= 60_000 && raw.ttlMs <= 3_600_000, 'telegram-request');
  const result = await options.dialog.showOpenDialog(options.window, {
    title: 'Astra V3: разрешить чтение через Telegram',
    message: `Только один файл для Telegram-чата ${raw.chatId}; доступ истечёт автоматически.`,
    defaultPath: options.defaultDirectory,
    properties: ['openFile', 'dontAddToRecent'],
    buttonLabel: 'Разрешить чтение',
  });
  options.assertRenderer();
  if (result.canceled) return { status: 'cancelled' };
  check(Array.isArray(result.filePaths) && result.filePaths.length === 1, 'single-file-required');
  const selectedPath = result.filePaths[0];
  check(typeof selectedPath === 'string' && path.isAbsolute(selectedPath)
    && path.normalize(selectedPath) === selectedPath, 'selected-path');
  const payload = await postHost(options, '/api/astra/v3/host/telegram-target-aliases', { ...raw, selectedPath }, 201);
  check(validTelegramAliasResponse(payload), 'telegram-alias-response');
  options.assertRenderer();
  return { status: 'selected', alias: structuredClone(payload.alias) };
}

/** Product Computer picker. The runtime retains HWND/PID/incarnation in a
 * 60-second set; main receives display labels and submits only a chosen index. */
export async function pickAstraProductWindow(options) {
  check(options?.mode === ASTRA_RUNTIME_PILOT_MODE && typeof options.assertRenderer === 'function'
    && typeof options.fetchImpl === 'function' && typeof options.hostToken === 'string' && options.hostToken.length >= 32
    && typeof options.desktopAttestationToken === 'string' && options.desktopAttestationToken.length >= 32, 'unavailable');
  options.assertRenderer(); const raw = options.request;
  check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 3
    && Object.keys(raw).every(key => ['version', 'conversationId', 'requestId'].includes(key))
    && raw.version === 1 && id(raw.conversationId) && id(raw.requestId), 'window-request');
  const candidatePayload = await postHost(options, '/api/astra/v3/host/window-candidates', raw, 200);
  check(validCandidateResponse(candidatePayload), 'candidate-response'); options.assertRenderer();
  const set = candidatePayload.candidates;
  if (!set.candidates.length) return { status: 'empty' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort('astra-product-window-dialog-timeout'), 120_000);
  let index = 0, chosen = false;
  try {
    for (let interactions = 0; interactions < 64; interactions++) {
      options.assertRenderer(); if (controller.signal.aborted) return { status: 'cancelled' };
      const item = set.candidates[index], buttons = ['Наблюдать это окно', 'Отмена',
        ...(index > 0 ? ['Предыдущее'] : []), ...(index + 1 < set.candidates.length ? ['Следующее'] : [])];
      const response = await options.dialog.showMessageBox(options.window, { type: 'question', title: 'Astra V3 — выбор окна',
        message: `Окно ${index + 1} из ${set.candidates.length}: только наблюдение`,
        detail: `Приложение: ${safeLabel(item.processName)}\nЗаголовок: ${safeLabel(item.title)}\n\nЭто не разрешение на клики или ввод.`,
        buttons, defaultId: 1, cancelId: 1, noLink: true, signal: controller.signal });
      options.assertRenderer(); if (controller.signal.aborted || response.response === 1) return { status: 'cancelled' };
      check(Number.isInteger(response.response) && response.response >= 0 && response.response < buttons.length, 'window-dialog-response');
      if (response.response === 0) { chosen = true; break; }
      index += buttons[response.response] === 'Предыдущее' ? -1 : 1;
      continue;
    }
  } finally { clearTimeout(timer); }
  check(chosen, 'window-dialog-budget'); options.assertRenderer();
  const selectedPayload = await postHost(options, '/api/astra/v3/host/window-selections',
    { ...raw, candidateSetId: set.candidateSetId, index }, 201);
  check(validWindowSelectionResponse(selectedPayload), 'window-selection-response'); options.assertRenderer();
  return { status: 'selected', selection: structuredClone(selectedPayload.selection) };
}

/** Renderer supplies semantic action + acknowledged observation task only.
 * Runtime derives all native identity and still requires structured approval. */
export async function issueAstraProductComputerAction(options) {
  check(options?.mode === ASTRA_RUNTIME_PILOT_MODE && typeof options.assertRenderer === 'function'
    && typeof options.fetchImpl === 'function' && typeof options.hostToken === 'string' && options.hostToken.length >= 32
    && typeof options.desktopAttestationToken === 'string' && options.desktopAttestationToken.length >= 32, 'unavailable');
  options.assertRenderer(); const raw = options.request;
  check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 5
    && Object.keys(raw).every(key => ['version', 'conversationId', 'requestId', 'taskId', 'action'].includes(key))
    && raw.version === 1 && id(raw.conversationId) && id(raw.requestId) && id(raw.taskId)
    && raw.action && typeof raw.action === 'object' && !Array.isArray(raw.action)
    && Buffer.byteLength(JSON.stringify(raw)) <= 8 * 1024, 'computer-action-request');
  const payload = await postHost(options, '/api/astra/v3/host/computer-action-plans', raw, 201);
  check(validComputerActionPlanResponse(payload), 'computer-action-response'); options.assertRenderer();
  return { status: 'proposed', plan: structuredClone(payload.plan) };
}

export async function controlAstraProductWindows(options) {
  const raw = catalogRequest(options, /^window_selection_[a-f0-9]{32}$/u);
  const payload = await postHost(options, '/api/astra/v3/host/window-selections/control', raw, 200);
  check(payload && Object.keys(payload).length === 2 && payload.ok === true && Array.isArray(payload.selections)
    && payload.selections.length <= 32 && payload.selections.every(validWindowSelectionDescriptor), 'window-catalog-response');
  options.assertRenderer(); return structuredClone(payload.selections);
}

export async function controlAstraProductComputerActions(options) {
  const raw = catalogRequest(options, /^computer_action_plan_[a-f0-9]{32}$/u);
  const payload = await postHost(options, '/api/astra/v3/host/computer-action-plans/control', raw, 200);
  check(payload && Object.keys(payload).length === 2 && payload.ok === true && Array.isArray(payload.plans)
    && payload.plans.length <= 32 && payload.plans.every(validComputerActionPlanDescriptor), 'computer-action-catalog-response');
  options.assertRenderer(); return structuredClone(payload.plans);
}

function catalogRequest(options, selectionPattern) {
  check(options?.mode === ASTRA_RUNTIME_PILOT_MODE && typeof options.assertRenderer === 'function'
    && typeof options.fetchImpl === 'function' && typeof options.hostToken === 'string' && options.hostToken.length >= 32
    && typeof options.desktopAttestationToken === 'string' && options.desktopAttestationToken.length >= 32, 'unavailable');
  options.assertRenderer(); const raw = options.request;
  const revoke = raw?.kind === 'revoke';
  check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === (revoke ? 4 : 3)
    && Object.keys(raw).every(key => ['version', 'conversationId', 'kind', 'selectionId'].includes(key))
    && raw.version === 1 && id(raw.conversationId) && ['list', 'revoke'].includes(raw.kind)
    && (revoke ? selectionPattern.test(raw.selectionId) : raw.selectionId === undefined), 'catalog-request');
  return raw;
}

async function postHost(options, pathname, body, expectedStatus) {
  const runtime = new URL(options.runtimeUrl);
  check(runtime.protocol === 'http:' && runtime.hostname === '127.0.0.1' && runtime.origin === options.runtimeUrl, 'runtime-origin');
  const response = await options.fetchImpl(new URL(pathname, runtime), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', 'x-monarch-desktop-attestation': options.desktopAttestationToken,
      'x-monarch-astra-host-token': options.hostToken }, body: JSON.stringify(body) });
  const text = await response.text(); check(Buffer.byteLength(text) <= 32 * 1024, 'response-budget');
  let payload; try { payload = JSON.parse(text); } catch { throw Error('astra-product-host:response-json'); }
  if (response.status !== expectedStatus) {
    const code = typeof payload?.error === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/u.test(payload.error)
      ? payload.error : 'unspecified';
    throw Error('astra-product-host:runtime-rejected:' + code);
  }
  return payload;
}

function validCandidateResponse(value) {
  const set = value?.candidates;
  return value && Object.keys(value).length === 2 && value.ok === true && set && Object.keys(set).length === 3
    && /^window_candidates_[a-f0-9]{32}$/u.test(set.candidateSetId) && Number.isSafeInteger(set.expiresAt) && set.expiresAt > Date.now()
    && Array.isArray(set.candidates) && set.candidates.length <= 32 && set.candidates.every((candidate, index) => candidate
      && Object.keys(candidate).length === 3 && candidate.index === index && typeof candidate.title === 'string' && candidate.title.length <= 512
      && typeof candidate.processName === 'string' && candidate.processName.length > 0 && candidate.processName.length <= 256);
}
function validWindowSelectionResponse(value) {
  const selection = value?.selection;
  return value && Object.keys(value).length === 2 && value.ok === true && validWindowSelectionDescriptor(selection);
}
function validComputerActionPlanResponse(value) {
  const plan = value?.plan;
  return value && Object.keys(value).length === 2 && value.ok === true && validComputerActionPlanDescriptor(plan);
}
function validWindowSelectionDescriptor(selection) {
  return selection && Object.keys(selection).length === 6
    && /^window_selection_[a-f0-9]{32}$/u.test(selection.selectionId) && typeof selection.title === 'string' && selection.title.length <= 512
    && typeof selection.processName === 'string' && selection.processName.length > 0 && selection.processName.length <= 256
    && Number.isSafeInteger(selection.expiresAt) && selection.expiresAt > Date.now()
    && selection.authority === 'observe' && selection.authorizesInput === false;
}
function validComputerActionPlanDescriptor(plan) {
  return plan && Object.keys(plan).length === 6
    && /^computer_action_plan_[a-f0-9]{32}$/u.test(plan.selectionId) && typeof plan.title === 'string' && plan.title.length <= 512
    && typeof plan.summary === 'string' && plan.summary.length > 0 && plan.summary.length <= 512
    && Number.isSafeInteger(plan.expiresAt) && plan.expiresAt > Date.now()
    && plan.authority === 'approval-required' && plan.grantScope === 'none';
}
function safeLabel(value) { return String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, 512); }

function validTargetResponse(value) {
  const selection = value?.selection;
  return value && Object.keys(value).length === 2 && value.ok === true && selection
    && Object.keys(selection).length === 3 && /^selection_[a-f0-9]{32}$/u.test(selection.selectionId)
    && Number.isSafeInteger(selection.expiresAt) && selection.expiresAt > Date.now()
    && Array.isArray(selection.targets) && selection.targets.length >= 1 && selection.targets.length <= 8
    && selection.targets.every((target, index) => target && Object.keys(target).length === 4
      && target.targetId === (selection.targets.length === 1 ? 'picked' : 'picked_' + index)
      && typeof target.label === 'string' && target.label.length > 0 && target.label.length <= 1024
      && ['observe', 'exclusive-create'].includes(target.access)
      && (selection.targets.length === 1 || target.access === 'observe')
      && Number.isSafeInteger(target.maxBytes) && target.maxBytes > 0 && target.maxBytes <= 65_536)
    && new Set(selection.targets.map(target => target.label.toLowerCase())).size === selection.targets.length;
}

function validTelegramAliasResponse(value) {
  const alias = value?.alias;
  return value && Object.keys(value).length === 2 && value.ok === true && alias
    && Object.keys(alias).length === 5 && /^astra_remote_alias_[a-f0-9]{32}$/u.test(alias.targetAlias)
    && Number.isSafeInteger(alias.expiresAt) && alias.expiresAt > Date.now()
    && alias.authority === 'read-only' && alias.authorizesCreate === false && alias.authorizesComputer === false;
}
