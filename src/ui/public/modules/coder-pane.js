import {
  armAgentTaskApproval,
  cancelCoderRun,
  deleteCoderRun,
  executeCapability,
  fetchCoderOverview,
  fetchCoderProject,
  fetchCoderRun,
  fetchCoderRuns,
  mutateCoderProject,
  resumeCoderRun,
  resolveAgentTaskApproval,
  startCoderRun,
  submitCoderFastChat,
} from './api.js';

const coderState = {
  initialized: false,
  mode: 'chat',
  overview: null,
  allRuns: [],
  snapshot: null,
  run: null,
  model: 'qwen3-coder-30b-a3b-instruct',
  pollTimer: 0,
  fastHistory: [],
  safeChats: [],
  safeUnlocked: false,
  safeBusy: false,
  runEncrypted: false,
  eventFilter: 'focus',
  fileQuery: '',
  expandedDirectories: new Set(),
  activeFilePath: '',
  mobilePanel: null,
  pollFailures: 0,
  pollDisconnected: false,
  pollGeneration: 0,
  cancelBusy: false,
  lastEventSignature: '',
  lastPrompt: '',
  fastBusy: false,
  historyOpen: false,
  historyQuery: '',
  historyProject: 'all',
  historyStatus: 'all',
  historyBusy: false,
  historyFocusReturn: null,
  pendingDeleteRunId: '',
  approvalBusy: false,
  continuationSourceId: '',
};

const elements = {};
const CODER_FOCUS_EVENT_LIMIT = 6;

const CODER_RUN_STATUS_LABELS = Object.freeze({
  queued: 'В очереди',
  running: 'В работе',
  interrupted: 'Прервано перезапуском',
  completed: 'Готово',
  failed: 'Нужна проверка',
  cancelled: 'Остановлено',
});

export function initCoderPane() {
  if (coderState.initialized) return;
  coderState.initialized = true;
  collectElements();
  bindEvents();
  window.monarchDesktop?.onSafeChatStatus?.((status) => {
    coderState.safeUnlocked = status?.unlocked === true;
    if (!coderState.safeUnlocked) {
      coderState.safeChats = [];
      if (coderState.runEncrypted) coderState.run = null;
      coderState.runEncrypted = false;
      renderSafeChats();
      renderRun();
    } else {
      void loadCoderSafeChats();
    }
  });
  const savedMode = localStorage.getItem('monarch.oscar.mode') === 'coder' ? 'coder' : 'chat';
  setCoderMode(savedMode, { persist: false });
}

export async function loadCoderOverview() {
  if (!elements.root) return;
  setWorkspaceBusy(true);
  try {
    const [payload, historyPayload] = await Promise.all([fetchCoderOverview(), fetchCoderRuns()]);
    coderState.overview = payload;
    coderState.allRuns = Array.isArray(historyPayload?.runs) ? historyPayload.runs : [];
    coderState.snapshot = payload.active || null;
    coderState.run = selectCurrentRun(payload.runs || []);
    coderState.runEncrypted = false;
    await loadCoderSafeChats();
    renderAll();
    if (coderState.run?.status === 'running' || coderState.run?.status === 'queued') startPolling(coderState.run.id);
  } catch (error) {
    renderInlineError(error instanceof Error ? error.message : String(error));
  } finally {
    setWorkspaceBusy(false);
    closeCoderActionMenu(elements.projectSelect);
  }
}

function collectElements() {
  const selectors = {
    section: '#oscar-section', root: '#coder-mode-root', chatTab: '#chat-mode-standard', coderTab: '#chat-mode-coder',
    projectName: '#coder-project-name', projectPath: '#coder-project-path', projectSelect: '#coder-project-select',
    projectNew: '#coder-project-new', projectImport: '#coder-project-import', onboarding: '#coder-onboarding',
    onboardingCreate: '#coder-onboarding-create', onboardingImport: '#coder-onboarding-import', workspace: '#coder-workspace',
    projectDialog: '#coder-project-dialog', projectForm: '#coder-project-form', projectInput: '#coder-project-input',
    projectFormError: '#coder-project-form-error', onboardingError: '#coder-onboarding-error',
    dialogCancel: '#coder-project-dialog-cancel', refresh: '#coder-refresh', git: '#coder-git-summary', tree: '#coder-file-tree',
    fileSearch: '#coder-file-search', explorer: '#coder-explorer', explorerClose: '#coder-explorer-close',
    runTitle: '#coder-run-title', runProjectRoot: '#coder-run-project-root', runStatus: '#coder-run-status', activity: '#coder-activity', composer: '#coder-composer',
    historyOpen: '#coder-history-open', historyCount: '#coder-history-count', runSummary: '#coder-run-summary',
    runSummaryKicker: '#coder-run-summary-kicker', runSummaryTitle: '#coder-run-summary-title', runSummaryDetail: '#coder-run-summary-detail',
    runRetry: '#coder-run-retry', eventCount: '#coder-event-count', suggestions: '#coder-suggestions', composerContext: '#coder-composer-context',
    input: '#coder-input', submit: '#coder-run-submit', cancel: '#coder-run-cancel', contextPercent: '#coder-context-percent',
    contextFill: '#coder-context-fill', contextBudget: '#coder-context-budget', contextCompactions: '#coder-context-compactions',
    contextEvents: '#coder-context-events', contextModelTokens: '#coder-context-model-tokens', contextFiles: '#coder-context-files', contextTests: '#coder-context-tests',
    contextPending: '#coder-context-pending', contextPanel: '#coder-context-panel', contextClose: '#coder-context-close',
    preview: '#coder-file-preview', previewShell: '#coder-file-preview-shell', previewTitle: '#coder-file-preview-title', previewClose: '#coder-file-preview-close',
    workspaceFocus: '#coder-workspace-focus', mobileProject: '#coder-mobile-project', mobileResult: '#coder-mobile-result', panelBackdrop: '#coder-panel-backdrop',
    progressBrief: '#coder-progress-brief', progressWork: '#coder-progress-work', progressVerify: '#coder-progress-verify',
    historyDrawer: '#coder-history-drawer', historyBackdrop: '#coder-history-backdrop', historyClose: '#coder-history-close',
    historySearch: '#coder-history-search', historyProject: '#coder-history-project', historySummary: '#coder-history-summary',
    historyError: '#coder-history-error', historyList: '#coder-history-list',
    fastOpen: '#coder-fast-open',
    safeEncrypt: '#coder-safe-encrypt', safeSelect: '#coder-safe-chat-select',
    fastDrawer: '#coder-fast-drawer', fastClose: '#coder-fast-close', fastMessages: '#coder-fast-messages',
    fastForm: '#coder-fast-form', fastInput: '#coder-fast-input',
  };
  for (const [key, selector] of Object.entries(selectors)) elements[key] = document.querySelector(selector);
  elements.modelButtons = [...document.querySelectorAll('[data-coder-model]')];
  elements.eventFilterButtons = [...document.querySelectorAll('[data-coder-event-filter]')];
  elements.templateButtons = [...document.querySelectorAll('[data-coder-template]')];
  elements.historyStatusButtons = [...document.querySelectorAll('[data-coder-history-status]')];
}

function bindEvents() {
  elements.chatTab?.addEventListener('click', () => setCoderMode('chat'));
  elements.coderTab?.addEventListener('click', () => setCoderMode('coder'));
  elements.projectNew?.addEventListener('click', (event) => {
    closeCoderActionMenu(event.currentTarget);
    openProjectDialog();
  });
  elements.onboardingCreate?.addEventListener('click', openProjectDialog);
  elements.dialogCancel?.addEventListener('click', () => elements.projectDialog?.close());
  elements.projectForm?.addEventListener('submit', handleCreateProject);
  elements.projectImport?.addEventListener('click', (event) => {
    closeCoderActionMenu(event.currentTarget);
    void handleImportProject();
  });
  elements.onboardingImport?.addEventListener('click', handleImportProject);
  elements.projectSelect?.addEventListener('change', handleActivateProject);
  elements.refresh?.addEventListener('click', refreshActiveProject);
  elements.composer?.addEventListener('submit', handleStartRun);
  elements.cancel?.addEventListener('click', handleCancelRun);
  elements.input?.addEventListener('input', autoGrowTextarea);
  elements.input?.addEventListener('keydown', handleComposerKeydown);
  elements.tree?.addEventListener('click', handleFileClick);
  elements.fileSearch?.addEventListener('input', handleFileSearch);
  elements.historyOpen?.addEventListener('click', openCoderHistory);
  elements.historyClose?.addEventListener('click', closeCoderHistory);
  elements.historyBackdrop?.addEventListener('click', closeCoderHistory);
  elements.historySearch?.addEventListener('input', handleHistorySearch);
  elements.historyProject?.addEventListener('change', handleHistoryProjectFilter);
  elements.historyList?.addEventListener('click', handleHistoryAction);
  for (const button of elements.historyStatusButtons || []) button.addEventListener('click', handleHistoryStatusFilter);
  elements.runRetry?.addEventListener('click', retryCurrentRun);
  elements.previewClose?.addEventListener('click', closeFilePreview);
  elements.workspaceFocus?.addEventListener('click', closeMobilePanels);
  elements.mobileProject?.addEventListener('click', () => toggleMobilePanel('project'));
  elements.mobileResult?.addEventListener('click', () => toggleMobilePanel('result'));
  elements.explorerClose?.addEventListener('click', closeMobilePanels);
  elements.contextClose?.addEventListener('click', closeMobilePanels);
  elements.panelBackdrop?.addEventListener('click', closeMobilePanels);
  document.addEventListener('keydown', handleCoderEscape);
  for (const button of elements.eventFilterButtons || []) button.addEventListener('click', handleEventFilter);
  for (const button of elements.templateButtons || []) button.addEventListener('click', applyTaskTemplate);
  for (const button of elements.modelButtons || []) button.addEventListener('click', handleModelChange);
  elements.fastOpen?.addEventListener('click', (event) => {
    closeCoderActionMenu(event.currentTarget);
    toggleFastDrawer(true);
  });
  elements.fastClose?.addEventListener('click', () => toggleFastDrawer(false));
  elements.fastForm?.addEventListener('submit', handleFastChat);
  elements.safeEncrypt?.addEventListener('click', () => {
    closeCoderActionMenu(elements.safeEncrypt);
    if (coderState.runEncrypted) void lockCoderSafeChats();
    else void encryptCurrentCoderRun();
  });
  elements.safeSelect?.addEventListener('change', openSelectedCoderSafeChat);
}

function setCoderMode(mode, options = {}) {
  coderState.mode = mode === 'coder' ? 'coder' : 'chat';
  const active = coderState.mode === 'coder';
  elements.section?.classList.toggle('coder-mode-active', active);
  if (elements.root) elements.root.hidden = !active;
  elements.chatTab?.setAttribute('aria-selected', String(!active));
  elements.coderTab?.setAttribute('aria-selected', String(active));
  elements.chatTab?.closest('.chat-mode-switch')?.setAttribute('data-active-mode', active ? 'coder' : 'chat');
  const shell = document.querySelector('#app-shell');
  shell?.classList.toggle('coder-workspace-active', active);
  shell?.dispatchEvent(new Event('monarch:mascot-surface-changed'));
  if (options.persist !== false) localStorage.setItem('monarch.oscar.mode', active ? 'coder' : 'chat');
  if (active) void loadCoderOverview();
  else {
    stopPolling();
    closeCoderHistory({ restoreFocus: false });
    closeMobilePanels();
    toggleFastDrawer(false);
  }
}

function openProjectDialog() {
  if (!elements.projectDialog) return;
  elements.projectInput.value = '';
  setInlineMessage(elements.projectFormError, '');
  elements.projectDialog.showModal();
  requestAnimationFrame(() => elements.projectInput?.focus());
}

async function handleCreateProject(event) {
  event.preventDefault();
  const name = elements.projectInput?.value.trim() || '';
  if (!name) return;
  setWorkspaceBusy(true);
  try {
    const payload = await mutateCoderProject('create', { name });
    coderState.snapshot = payload.project;
    elements.projectDialog?.close();
    await loadCoderOverview();
  } catch (error) {
    setInlineMessage(elements.projectFormError, error instanceof Error ? error.message : String(error));
  } finally {
    setWorkspaceBusy(false);
  }
}

async function handleImportProject() {
  try {
    let projectPath = '';
    if (typeof window.monarchDesktop?.pickCoderFolder === 'function') {
      projectPath = await window.monarchDesktop.pickCoderFolder() || '';
    } else {
      projectPath = window.prompt('Полный путь к существующей папке проекта') || '';
    }
    if (!projectPath) return;
    setWorkspaceBusy(true);
    const payload = await mutateCoderProject('import', { path: projectPath });
    coderState.snapshot = payload.project;
    await loadCoderOverview();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (coderState.snapshot?.project) renderInlineError(message);
    else setInlineMessage(elements.onboardingError, message);
  } finally {
    setWorkspaceBusy(false);
  }
}

async function handleActivateProject() {
  if (isRunActive(coderState.run)) return;
  const projectId = elements.projectSelect?.value || '';
  if (!projectId) return;
  setWorkspaceBusy(true);
  try {
    stopPolling();
    const payload = await mutateCoderProject('activate', { projectId });
    coderState.snapshot = payload.project;
    coderState.run = null;
    coderState.runEncrypted = false;
    coderState.activeFilePath = '';
    coderState.expandedDirectories.clear();
    closeFilePreview();
    await loadCoderOverview();
  } catch (error) {
    renderInlineError(error instanceof Error ? error.message : String(error));
  } finally {
    setWorkspaceBusy(false);
  }
}

async function refreshActiveProject() {
  const projectId = coderState.snapshot?.project?.id;
  if (!projectId) return;
  try {
    const payload = await fetchCoderProject(projectId);
    coderState.snapshot = payload.project;
    renderProject();
  } catch (error) {
    renderInlineError(error instanceof Error ? error.message : String(error));
  }
}

async function handleStartRun(event) {
  event.preventDefault();
  const prompt = elements.input?.value.trim() || '';
  const projectId = coderState.snapshot?.project?.id;
  if (!prompt || !projectId || isRunActive(coderState.run)) return;
  coderState.lastPrompt = prompt;
  setRunBusy(true);
  try {
    if (typeof window.monarchDesktop?.releaseSpeechOutput === 'function') {
      const released = await window.monarchDesktop.releaseSpeechOutput();
      if (released?.ok === false) {
        throw new Error(released.summary || 'Не удалось освободить память голосовой модели для Coder Mode.');
      }
    }
    const payload = await startCoderRun(prompt, projectId, coderState.model);
    coderState.cancelBusy = false;
    coderState.run = payload.run;
    mergeRunIntoOverview(payload.run);
    coderState.runEncrypted = false;
    coderState.continuationSourceId = '';
    coderState.pollDisconnected = false;
    elements.input.value = '';
    autoGrowTextarea.call(elements.input);
    renderRun();
    renderRunHistory();
    startPolling(payload.run.id);
  } catch (error) {
    renderInlineError(error instanceof Error ? error.message : String(error));
    setRunBusy(false);
  }
}

async function handleCancelRun() {
  if (!coderState.run?.id || !isRunActive(coderState.run) || coderState.cancelBusy || coderState.run.cancelled) return;
  coderState.cancelBusy = true;
  setRunBusy(true);
  try {
    const payload = await cancelCoderRun(coderState.run.id);
    coderState.run = payload.run;
    mergeRunIntoOverview(payload.run);
    renderRun();
    renderRunHistory();
  } catch (error) {
    renderInlineError(error instanceof Error ? error.message : String(error));
  } finally {
    coderState.cancelBusy = false;
    renderRun();
  }
}

function startPolling(runId) {
  stopPolling();
  const generation = coderState.pollGeneration;
  coderState.pollFailures = 0;
  coderState.pollDisconnected = false;
  const poll = async () => {
    if (generation !== coderState.pollGeneration) return;
    let delay = 1100;
    try {
      const payload = await fetchCoderRun(runId);
      if (generation !== coderState.pollGeneration) return;
      coderState.pollFailures = 0;
      coderState.pollDisconnected = false;
      coderState.run = payload.run;
      mergeRunIntoOverview(payload.run);
      renderRun();
      renderRunHistory();
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(payload.run.status)) {
        stopPolling();
        await refreshActiveProject();
        return;
      }
    } catch (error) {
      if (generation !== coderState.pollGeneration) return;
      coderState.pollFailures += 1;
      coderState.pollDisconnected = true;
      renderRunSummary(coderState.run);
      if (coderState.pollFailures >= 4) {
        stopPolling();
        return;
      }
      delay = Math.min(5000, 1100 * (coderState.pollFailures + 1));
    }
    if (generation === coderState.pollGeneration) coderState.pollTimer = window.setTimeout(poll, delay);
  };
  coderState.pollTimer = window.setTimeout(poll, 0);
}

function stopPolling() {
  if (coderState.pollTimer) window.clearTimeout(coderState.pollTimer);
  coderState.pollTimer = 0;
  coderState.pollGeneration += 1;
}

function handleModelChange(event) {
  if (isRunActive(coderState.run)) return;
  const model = event.currentTarget?.dataset?.coderModel;
  if (!model) return;
  coderState.model = model;
  renderModelSelection();
  closeCoderActionMenu(event.currentTarget);
}

async function handleFileClick(event) {
  const button = event.target.closest('[data-coder-file]');
  const projectId = coderState.snapshot?.project?.id;
  if (!button || !projectId) return;
  const requestedPath = button.dataset.coderFile;
  if (button.dataset.type === 'directory') {
    if (coderState.expandedDirectories.has(requestedPath)) coderState.expandedDirectories.delete(requestedPath);
    else coderState.expandedDirectories.add(requestedPath);
    renderFileTree(coderState.snapshot?.entries || []);
    return;
  }
  coderState.activeFilePath = requestedPath;
  if (elements.previewShell) elements.previewShell.hidden = false;
  if (elements.previewTitle) elements.previewTitle.textContent = requestedPath;
  elements.preview.textContent = `Читаю ${requestedPath}…`;
  renderFileTree(coderState.snapshot?.entries || []);
  openWorkspaceDrawer('result');
  try {
    const payload = await executeCapability('coder', 'coder.files.read', { projectId, path: requestedPath, maxBytes: 262144 }, 'coder-ui', false, '', { includeState: false });
    if (!payload.result?.ok) throw new Error(payload.result?.summary || 'Файл не прочитан');
    elements.preview.textContent = payload.result.output?.content || 'Файл пуст.';
  } catch (error) {
    elements.preview.textContent = error instanceof Error ? error.message : String(error);
  }
}

function toggleFastDrawer(open) {
  if (!elements.fastDrawer) return;
  elements.fastDrawer.hidden = !open;
  elements.fastOpen?.setAttribute('aria-expanded', String(open));
  if (open) requestAnimationFrame(() => elements.fastInput?.focus());
}

async function handleFastChat(event) {
  event.preventDefault();
  if (coderState.fastBusy) return;
  const message = elements.fastInput?.value.trim() || '';
  if (!message) return;
  coderState.fastBusy = true;
  setFastBusy(true);
  coderState.fastHistory.push({ role: 'user', content: message });
  elements.fastInput.value = '';
  renderFastHistory(true);
  try {
    const payload = await submitCoderFastChat(message, coderState.fastHistory.slice(0, -1));
    const answer = payload.result?.output?.response?.answer || payload.result?.summary || 'Fast модель не вернула текст.';
    coderState.fastHistory.push({ role: 'assistant', content: String(answer) });
  } catch (error) {
    coderState.fastHistory.push({ role: 'assistant', content: `Ошибка: ${error instanceof Error ? error.message : String(error)}` });
  }
  coderState.fastBusy = false;
  setFastBusy(false);
  renderFastHistory(false);
}

async function loadCoderSafeChats() {
  const bridge = window.monarchDesktop;
  if (typeof bridge?.getSafeChatStatus !== 'function' || typeof bridge?.listSafeChats !== 'function') {
    coderState.safeUnlocked = false;
    coderState.safeChats = [];
    renderSafeChats();
    return;
  }
  try {
    const status = await bridge.getSafeChatStatus();
    coderState.safeUnlocked = status?.unlocked === true;
    if (!coderState.safeUnlocked) {
      coderState.safeChats = [];
    } else {
      const payload = await bridge.listSafeChats();
      coderState.safeChats = (Array.isArray(payload?.chats) ? payload.chats : [])
        .filter((chat) => chat?.kind === 'coder');
    }
  } catch {
    coderState.safeUnlocked = false;
    coderState.safeChats = [];
  }
  renderSafeChats();
}

async function encryptCurrentCoderRun() {
  const run = coderState.run;
  const bridge = window.monarchDesktop;
  if (!run || coderState.safeBusy || ['queued', 'running'].includes(run.status)) return;
  if (
    typeof bridge?.getSafeChatStatus !== 'function'
    || typeof bridge?.writeSafeChat !== 'function'
    || typeof bridge?.deleteSafeChat !== 'function'
  ) {
    renderInlineError('Шифрование Coder-сессий доступно только в Monarch Desktop.');
    return;
  }
  coderState.safeBusy = true;
  renderRun();
  try {
    const status = await bridge.getSafeChatStatus();
    if (status?.unlocked !== true) {
      await bridge.openSafe?.();
      throw new Error('Разблокируй Monarch Safe и снова нажми Safe в Coder Mode.');
    }
    if (!window.confirm('Перенести эту Coder-сессию в Monarch Safe и удалить plaintext run journal?')) return;
    const now = new Date().toISOString();
    const stored = await bridge.writeSafeChat({
      version: 1,
      id: run.id,
      kind: 'coder',
      title: conciseTitle(run.prompt),
      createdAt: run.createdAt || now,
      updatedAt: run.updatedAt || now,
      messages: [
        { id: `${run.id}:prompt`, role: 'user', content: String(run.prompt || '') },
        ...(run.events || []).map((event) => ({
          id: event.id,
          role: event.kind === 'tool-start' || event.kind === 'tool-result' ? 'tool' : 'assistant',
          content: `${event.title}\n${event.detail}`.trim(),
        })),
      ],
      run,
    });
    if (stored?.verified !== true) throw new Error('Safe не подтвердил authenticated reread Coder-сессии.');
    try {
      const removed = await deleteCoderRun(run.id);
      if (removed?.deleted !== run.id) throw new Error('Coder runtime не подтвердил удаление plaintext journal.');
    } catch (error) {
      await bridge.deleteSafeChat(run.id, 'coder').catch(() => undefined);
      throw error;
    }
    if (Array.isArray(coderState.overview?.runs)) {
      coderState.overview.runs = coderState.overview.runs.filter((entry) => entry.id !== run.id);
    }
    coderState.allRuns = coderState.allRuns.filter((entry) => entry.id !== run.id);
    coderState.runEncrypted = true;
    coderState.safeUnlocked = true;
    await loadCoderSafeChats();
  } catch (error) {
    renderInlineError(error instanceof Error ? error.message : String(error));
  } finally {
    coderState.safeBusy = false;
    renderRun();
  }
}

async function openSelectedCoderSafeChat() {
  const id = elements.safeSelect?.value || '';
  if (!id || typeof window.monarchDesktop?.readSafeChat !== 'function') return;
  stopPolling();
  coderState.safeBusy = true;
  try {
    const payload = await window.monarchDesktop.readSafeChat(id, 'coder');
    const run = payload?.record?.run;
    if (!run || run.id !== id || !Array.isArray(run.events)) throw new Error('Safe Coder record is invalid.');
    coderState.run = structuredClone(run);
    coderState.runEncrypted = true;
    renderRun();
  } catch (error) {
    renderInlineError(error instanceof Error ? error.message : String(error));
  } finally {
    coderState.safeBusy = false;
    renderRun();
  }
}

async function lockCoderSafeChats() {
  if (typeof window.monarchDesktop?.lockSafeChats !== 'function') return;
  try {
    await window.monarchDesktop.lockSafeChats();
  } finally {
    coderState.safeUnlocked = false;
    coderState.safeChats = [];
    coderState.runEncrypted = false;
    coderState.run = null;
    renderSafeChats();
    renderRun();
  }
}

function renderAll() {
  renderProjectSelect();
  renderProject();
  renderRun();
  renderRunHistory();
  renderModelSelection();
  renderSafeChats();
}

function renderSafeChats() {
  if (!elements.safeSelect) return;
  const activeId = coderState.runEncrypted ? coderState.run?.id : '';
  elements.safeSelect.replaceChildren(new Option('Safe-чаты', ''));
  for (const chat of coderState.safeChats) {
    elements.safeSelect.append(new Option(chat.title || 'Coder session', chat.id, false, chat.id === activeId));
  }
  elements.safeSelect.hidden = coderState.safeChats.length === 0;
  elements.safeSelect.disabled = !coderState.safeUnlocked || coderState.safeBusy;
}

function renderProjectSelect() {
  if (!elements.projectSelect) return;
  const projects = coderState.overview?.projects?.projects || [];
  const activeId = coderState.snapshot?.project?.id || '';
  elements.projectSelect.replaceChildren();
  if (!projects.length) {
    elements.projectSelect.append(new Option('Нет проектов', ''));
    elements.projectSelect.disabled = true;
    return;
  }
  elements.projectSelect.disabled = isRunActive(coderState.run);
  for (const project of projects) elements.projectSelect.append(new Option(project.name, project.id, false, project.id === activeId));
}

function renderProject() {
  const snapshot = coderState.snapshot;
  const hasProject = Boolean(snapshot?.project);
  if (elements.onboarding) elements.onboarding.hidden = hasProject;
  if (elements.workspace) elements.workspace.hidden = !hasProject;
  if (!hasProject) {
    elements.projectName.textContent = 'Проект не выбран';
    elements.projectPath.textContent = coderState.overview?.projects?.workspaceCoderRoot || 'Workspace Coder';
    return;
  }
  elements.projectName.textContent = snapshot.project.name;
  elements.projectPath.textContent = snapshot.project.root;
  elements.git.textContent = snapshot.git?.repository
    ? `Git · ${snapshot.git.branch || 'без ветки'}${snapshot.git.status?.length ? ` · изменений: ${snapshot.git.status.length}` : ' · без изменений'}`
    : 'Git · репозиторий не инициализирован';
  renderFileTree(snapshot.entries || []);
  renderComposerContext();
}

function renderFileTree(entries) {
  if (!elements.tree) return;
  const query = coderState.fileQuery.trim().toLocaleLowerCase('ru-RU');
  const normalized = entries.map((entry) => ({ ...entry, path: String(entry.path || '').replaceAll('\\', '/') }));
  const matches = query ? normalized.filter((entry) => entry.path.toLocaleLowerCase('ru-RU').includes(query)) : [];
  const visibleEntries = normalized.filter((entry) => {
    if (query) return matches.some((match) => match.path === entry.path || match.path.startsWith(`${entry.path}/`));
    const parts = entry.path.split('/');
    if (parts.length === 1) return true;
    return parts.slice(0, -1).every((_, index) => coderState.expandedDirectories.has(parts.slice(0, index + 1).join('/')));
  });
  const fragment = document.createDocumentFragment();
  for (const entry of visibleEntries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'coder-file-entry';
    button.dataset.coderFile = entry.path;
    button.dataset.type = entry.type;
    button.setAttribute('role', 'treeitem');
    button.setAttribute('aria-level', String(entry.path.split('/').length));
    if (entry.type === 'directory') button.setAttribute('aria-expanded', String(query.length > 0 || coderState.expandedDirectories.has(entry.path)));
    if (entry.path === coderState.activeFilePath) button.setAttribute('aria-current', 'true');
    button.style.paddingLeft = `${7 + Math.min(6, entry.path.split('/').length - 1) * 10}px`;
    const icon = document.createElement('i');
    icon.textContent = entry.type === 'directory' ? 'DIR' : '';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = entry.path.split('/').at(-1);
    label.title = entry.path;
    button.append(icon, label);
    fragment.append(button);
  }
  elements.tree.replaceChildren(fragment);
  if (!entries.length) elements.tree.textContent = 'Папка пока пустая.';
  else if (!visibleEntries.length) elements.tree.textContent = 'Файлы не найдены.';
}

function renderRun() {
  const run = coderState.run;
  renderSafeRunButton(run);
  renderRunProgress(run);
  if (!run) {
    elements.runTitle.textContent = 'Что нужно получить?';
    renderRunProjectRoot('');
    elements.runStatus.textContent = 'Готов';
    elements.runStatus.dataset.status = 'idle';
    setRunBusy(false);
    renderRunSummary(null);
    renderContext(null);
    renderComposerVisibility(null);
    if (elements.eventCount) elements.eventCount.textContent = '';
    if (elements.activity) {
      const empty = document.createElement('div');
      empty.className = 'coder-empty-activity';
      const title = document.createElement('strong');
      title.textContent = 'Сформулируй конечный результат';
      const detail = document.createElement('span');
      detail.textContent = 'Coder изучит выбранный проект, выполнит изменения и покажет только подтверждённый итог.';
      empty.append(title, detail);
      elements.activity.replaceChildren(empty);
      coderState.lastEventSignature = '';
    }
    renderComposerContext();
    return;
  }
  elements.runTitle.textContent = conciseTitle(run.prompt);
  renderRunProjectRoot(run.projectRoot || coderState.snapshot?.project?.root || '');
  elements.runStatus.textContent = `${CODER_RUN_STATUS_LABELS[run.status] || run.status} · ${run.iteration}/${run.maxIterations}`;
  elements.runStatus.dataset.status = run.status;
  setRunBusy(run.status === 'queued' || run.status === 'running');
  renderRunSummary(run);
  renderEvents(run.events || [], run.model, run.agentApproval, run.agentTaskId);
  renderContext(run);
  renderComposerVisibility(run);
  renderComposerContext();
}

function renderRunProgress(run) {
  const progress = [elements.progressBrief, elements.progressWork, elements.progressVerify];
  if (progress.some((element) => !element)) return;
  const events = Array.isArray(run?.events) ? run.events : [];
  const hasVerifiedWork = events.some((event) => event?.kind === 'tool-result' && event?.ok === true);
  const hasVerification = Array.isArray(run?.summary?.tests) && run.summary.tests.length > 0;
  const completed = run?.status === 'completed';
  const stopped = Boolean(run && ['failed', 'cancelled', 'interrupted'].includes(run.status));

  const states = !run
    ? ['current', 'idle', 'idle']
    : completed
      ? ['done', 'done', 'done']
      : hasVerification
        ? ['done', 'done', stopped ? 'warning' : 'current']
        : hasVerifiedWork
          ? ['done', stopped ? 'warning' : 'done', stopped ? 'idle' : 'current']
          : ['done', stopped ? 'warning' : 'current', 'idle'];
  progress.forEach((element, index) => {
    element.dataset.state = states[index];
    element.setAttribute('aria-current', states[index] === 'current' ? 'step' : 'false');
  });
}

function renderRunSummary(run) {
  if (!elements.runSummary) return;
  const disconnected = isRunActive(run) && coderState.pollDisconnected;
  const terminal = run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
  const warningCount = run?.status === 'completed' && Array.isArray(run?.summary?.failures)
    ? run.summary.failures.filter(Boolean).length
    : 0;
  elements.runSummary.hidden = !disconnected && !terminal;
  elements.runSummary.dataset.status = disconnected
    ? 'disconnected'
    : warningCount > 0
      ? 'warning'
      : run?.status || '';
  elements.runRetry.hidden = true;
  if (!run || (!disconnected && !terminal)) return;
  if (disconnected) {
    elements.runSummaryKicker.textContent = 'СВЯЗЬ С СЕССИЕЙ';
    elements.runSummaryTitle.textContent = coderState.pollFailures >= 4 ? 'Автообновление приостановлено' : 'Восстанавливаю обновления';
    elements.runSummaryDetail.textContent = 'Сессия может продолжаться локально. Её состояние не потеряно.';
    if (coderState.pollFailures >= 4) {
      elements.runRetry.textContent = 'Обновить состояние';
      elements.runRetry.hidden = false;
    }
    return;
  }
  elements.runSummaryKicker.textContent = run.status === 'completed'
    ? warningCount > 0 ? 'РЕЗУЛЬТАТ С ПРЕДУПРЕЖДЕНИЯМИ' : 'РЕЗУЛЬТАТ'
    : 'СЕССИЯ ОСТАНОВЛЕНА';
  if (run.status === 'completed') {
    elements.runSummaryTitle.textContent = warningCount > 0 ? 'Часть результата требует проверки' : 'Задача завершена';
    const outcome = terminalAnswerPreview(run);
    elements.runSummaryDetail.textContent = warningCount > 0
      ? `${warningCount} ${warningCount === 1 ? 'предупреждение осталось' : 'предупреждения осталось'} в журнале.${outcome ? ` ${outcome}` : ''}`
      : outcome || 'Проверенный результат доступен в разделе «Контекст».';
    elements.runRetry.textContent = 'Новая задача';
  } else if (run.status === 'failed') {
    elements.runSummaryTitle.textContent = 'Не удалось завершить задачу';
    elements.runSummaryDetail.textContent = lastFailureDetail(run.events) || 'Открой основные события ниже, чтобы увидеть причину.';
    elements.runRetry.textContent = 'Изменить задачу';
  } else if (run.status === 'interrupted') {
    elements.runSummaryKicker.textContent = 'СЕССИЯ ПРЕРВАНА';
    elements.runSummaryTitle.textContent = 'Можно продолжить с checkpoint';
    elements.runSummaryDetail.textContent = 'Проверенные receipts сохранены. Действие без достоверного receipt автоматически не повторится.';
    elements.runRetry.textContent = 'Продолжить с checkpoint';
  } else {
    elements.runSummaryTitle.textContent = 'Работа остановлена';
    elements.runSummaryDetail.textContent = 'Контекст и журнал сохранены. Можно начать новую задачу.';
    elements.runRetry.textContent = 'Новая задача';
  }
  elements.runRetry.hidden = false;
}

function renderRunProjectRoot(value) {
  if (!elements.runProjectRoot) return;
  const projectRoot = typeof value === 'string' ? value : '';
  const hasProjectRoot = projectRoot.trim().length > 0;
  elements.runProjectRoot.textContent = hasProjectRoot ? `Папка запуска · ${projectRoot}` : '';
  elements.runProjectRoot.title = hasProjectRoot ? projectRoot : '';
  elements.runProjectRoot.hidden = !hasProjectRoot;
}

function renderRunHistory() {
  const runs = Array.isArray(coderState.allRuns) ? coderState.allRuns : [];
  if (elements.historyCount) elements.historyCount.textContent = String(runs.length);
  if (elements.historyOpen) elements.historyOpen.disabled = runs.length === 0 && !coderState.historyOpen;
  renderHistoryProjectOptions();
  if (!elements.historyList || !coderState.historyOpen) return;

  const query = coderState.historyQuery.trim().toLocaleLowerCase('ru-RU');
  const filtered = runs.filter((run) => {
    const project = coderProjectForRun(run);
    const projectName = coderProjectName(run, project);
    const matchesProject = coderState.historyProject === 'all' || run.projectId === coderState.historyProject;
    const matchesStatus = coderState.historyStatus === 'all'
      || run.status === coderState.historyStatus
      || (coderState.historyStatus === 'failed' && ['cancelled', 'interrupted'].includes(run.status));
    const haystack = [
      run.prompt,
      run.answer,
      run.summary?.lastAssistantSummary,
      ...(Array.isArray(run.summary?.modifiedFiles) ? run.summary.modifiedFiles : []),
      ...(Array.isArray(run.summary?.tests) ? run.summary.tests : []),
      projectName,
      run.projectRoot || project?.root,
      CODER_RUN_STATUS_LABELS[run.status] || run.status,
    ].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU');
    return matchesProject && matchesStatus && (!query || haystack.includes(query));
  });

  if (elements.historySummary) {
    const projectCount = new Set(filtered.map((run) => run.projectId)).size;
    elements.historySummary.textContent = `${filtered.length} из ${runs.length} сессий · проектов: ${projectCount}`;
  }

  const fragment = document.createDocumentFragment();
  let currentGroup = '';
  for (const run of filtered) {
    const group = historyDateGroup(run.updatedAt || run.createdAt);
    if (group !== currentGroup) {
      currentGroup = group;
      const heading = document.createElement('h3');
      heading.className = 'coder-history-group';
      heading.textContent = group;
      fragment.append(heading);
    }
    fragment.append(createHistoryRunCard(run));
  }
  if (!filtered.length) fragment.append(createHistoryEmptyState(runs.length === 0));
  elements.historyList.replaceChildren(fragment);
}

function renderHistoryProjectOptions() {
  if (!elements.historyProject) return;
  const projects = coderState.overview?.projects?.projects || [];
  const registeredIds = new Set(projects.map((project) => project.id));
  const archivedProjects = [];
  const archivedIds = new Set();
  for (const run of coderState.allRuns || []) {
    if (!run?.projectId || registeredIds.has(run.projectId) || archivedIds.has(run.projectId)) continue;
    archivedIds.add(run.projectId);
    archivedProjects.push({ id: run.projectId, name: coderProjectName(run, null) });
  }
  const currentValue = coderState.historyProject;
  elements.historyProject.replaceChildren(new Option('Все проекты', 'all'));
  for (const project of projects) elements.historyProject.append(new Option(project.name, project.id));
  for (const project of archivedProjects) elements.historyProject.append(new Option(`${project.name} · не подключён`, project.id));
  if (currentValue !== 'all' && !registeredIds.has(currentValue) && !archivedIds.has(currentValue)) coderState.historyProject = 'all';
  elements.historyProject.value = coderState.historyProject;
}

function createHistoryRunCard(run) {
  const project = coderProjectForRun(run);
  const available = Boolean(project);
  const active = run.id === coderState.run?.id;
  const runningElsewhere = isRunActive(coderState.run) && !active;
  const article = document.createElement('article');
  article.className = 'coder-history-item';
  article.dataset.status = run.status;
  article.dataset.active = String(active);
  article.setAttribute('role', 'listitem');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'coder-history-item-main';
  open.dataset.coderHistoryOpen = run.id;
  open.disabled = !available || runningElsewhere || coderState.historyBusy;
  open.setAttribute('aria-label', `Открыть сессию: ${conciseTitle(run.prompt)}`);

  const top = document.createElement('span');
  top.className = 'coder-history-item-top';
  const status = document.createElement('b');
  status.textContent = CODER_RUN_STATUS_LABELS[run.status] || run.status;
  const time = document.createElement('time');
  time.dateTime = run.updatedAt || run.createdAt || '';
  time.textContent = formatHistoryTime(run.updatedAt || run.createdAt);
  top.append(status, time);

  const title = document.createElement('strong');
  title.textContent = conciseHistoryTitle(run.prompt);
  const projectLine = document.createElement('span');
  projectLine.className = 'coder-history-item-project';
  projectLine.textContent = available
    ? `${coderProjectName(run, project)} · ${coderModelLabel(run.model)}`
    : `${coderProjectName(run, project)} · проект не подключён`;

  const metrics = document.createElement('span');
  metrics.className = 'coder-history-item-metrics';
  const modified = Array.isArray(run.summary?.modifiedFiles) ? run.summary.modifiedFiles.length : 0;
  const tests = Array.isArray(run.summary?.tests) ? run.summary.tests.length : 0;
  const events = Array.isArray(run.events) ? run.events.length : Number(run.context?.totalEvents || 0);
  metrics.textContent = `${formatHistoryMetric(modified, 'изменение', 'изменения', 'изменений')} · ${formatHistoryMetric(tests, 'проверка', 'проверки', 'проверок')} · событий: ${events}`;
  open.append(top, title, projectLine, metrics);

  const actions = document.createElement('div');
  actions.className = 'coder-history-item-actions';
  if (active) {
    const marker = document.createElement('span');
    marker.textContent = 'Открыто';
    actions.append(marker);
  }
  if (available && !isRunActive(run) && !runningElsewhere) {
    const continueButton = document.createElement('button');
    continueButton.type = 'button';
    continueButton.dataset.coderHistoryContinue = run.id;
    continueButton.textContent = 'Продолжить';
    actions.append(continueButton);
  }
  if (!isRunActive(run)) {
    if (coderState.pendingDeleteRunId === run.id) {
      const cancelDelete = document.createElement('button');
      cancelDelete.type = 'button';
      cancelDelete.dataset.coderHistoryDeleteCancel = run.id;
      cancelDelete.textContent = 'Отмена';
      const confirmDelete = document.createElement('button');
      confirmDelete.type = 'button';
      confirmDelete.className = 'is-danger';
      confirmDelete.dataset.coderHistoryDeleteConfirm = run.id;
      confirmDelete.textContent = 'Удалить журнал';
      actions.append(cancelDelete, confirmDelete);
    } else {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.dataset.coderHistoryDelete = run.id;
      deleteButton.textContent = 'Удалить';
      deleteButton.setAttribute('aria-label', `Удалить сессию: ${conciseTitle(run.prompt)}`);
      actions.append(deleteButton);
    }
  }
  article.append(open, actions);
  return article;
}

function createHistoryEmptyState(noRuns) {
  const empty = document.createElement('div');
  empty.className = 'coder-history-empty';
  const title = document.createElement('strong');
  title.textContent = noRuns ? 'История пока пустая' : 'Сессии не найдены';
  const detail = document.createElement('span');
  detail.textContent = noRuns ? 'Первая запущенная задача появится здесь автоматически.' : 'Измени запрос или фильтры.';
  empty.append(title, detail);
  return empty;
}

function renderModelSelection() {
  const active = isRunActive(coderState.run);
  for (const button of elements.modelButtons || []) {
    const selected = button.dataset.coderModel === coderState.model;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = active;
  }
}

function renderSafeRunButton(run) {
  if (!elements.safeEncrypt) return;
  const terminal = run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
  elements.safeEncrypt.disabled = coderState.safeBusy || (!coderState.runEncrypted && !terminal);
  elements.safeEncrypt.classList.toggle('is-active', coderState.runEncrypted);
  elements.safeEncrypt.textContent = coderState.runEncrypted ? 'Safe · закрыть' : 'Safe';
  elements.safeEncrypt.title = coderState.runEncrypted
    ? 'Заблокировать Monarch Safe и закрыть зашифрованную Coder-сессию'
    : 'Зашифровать завершённую Coder-сессию в Monarch Safe';
}

function renderEvents(events, requestedModel, approval = null, agentTaskId = '') {
  if (!elements.activity) return;
  const presented = [];
  for (const event of events) {
    const presentation = presentCoderEvent(event, requestedModel);
    if (coderState.eventFilter === 'focus' && !isFocusEvent(event, presentation)) continue;
    const previous = presented.at(-1);
    const fingerprint = `${presentation.tone}|${presentation.title}|${presentation.detail}`;
    const repeatedFailure = coderState.eventFilter === 'focus' && presentation.tone === 'failure'
      ? presented.find((item) => item.fingerprint === fingerprint)
      : null;
    if (repeatedFailure) {
      repeatedFailure.repeats += 1;
      continue;
    }
    if (previous?.fingerprint === fingerprint) {
      previous.repeats += 1;
      continue;
    }
    presented.push({ event, presentation, fingerprint, repeats: 1 });
  }
  const approvalSignature = approval
    ? `${agentTaskId}:${approval.id}:${approval.canonicalProposalHash}:${coderState.approvalBusy}`
    : '';
  const signature = `${coderState.eventFilter}:${presented.map((item) => `${item.event.id || item.event.createdAt}:${item.fingerprint}:${item.repeats}`).join('|')}:${approvalSignature}`;
  if (elements.eventCount) {
    elements.eventCount.textContent = coderState.eventFilter === 'focus'
      ? `${presented.length} ключевых · ${events.length} всего`
      : `${events.length} событий`;
  }
  if (signature === coderState.lastEventSignature) return;
  coderState.lastEventSignature = signature;
  const stickToBottom = elements.activity.scrollHeight - elements.activity.scrollTop - elements.activity.clientHeight < 100;
  const fragment = document.createDocumentFragment();
  const archiveCount = coderState.eventFilter === 'focus'
    ? Math.max(0, presented.length - CODER_FOCUS_EVENT_LIMIT)
    : 0;
  if (archiveCount > 0) {
    const archive = document.createElement('details');
    archive.className = 'coder-event-archive';
    const summary = document.createElement('summary');
    summary.textContent = `Ранее · ${archiveCount} ${pluralizeSteps(archiveCount)}`;
    const archiveList = document.createElement('div');
    for (const item of presented.slice(0, archiveCount)) {
      archiveList.append(createCoderEventArticle(item, { compact: true }));
    }
    archive.append(summary, archiveList);
    fragment.append(archive);
  }
  for (const item of presented.slice(archiveCount)) {
    fragment.append(createCoderEventArticle(item, { compact: coderState.eventFilter === 'focus' }));
  }
  if (approval && agentTaskId) fragment.append(createCoderApprovalArticle(approval, agentTaskId));
  if (!presented.length && !approval) {
    const empty = document.createElement('div');
    empty.className = 'coder-empty-activity';
    empty.innerHTML = '<strong>Основных событий пока нет</strong><span>Открой «Все события», чтобы увидеть технический журнал.</span>';
    fragment.append(empty);
  }
  elements.activity.replaceChildren(fragment);
  if (stickToBottom && isRunActive(coderState.run)) elements.activity.scrollTop = elements.activity.scrollHeight;
  else if (!isRunActive(coderState.run)) elements.activity.scrollTop = 0;
}

function createCoderApprovalArticle(approval, agentTaskId) {
  const article = document.createElement('article');
  article.className = 'coder-event coder-agent-approval';
  article.dataset.tone = 'warning';
  const header = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = 'Точное действие требует подтверждения';
  const capability = document.createElement('code');
  capability.textContent = String(approval.capabilityId || 'capability');
  header.append(title, capability);
  const detail = document.createElement('p');
  const proposal = approval.proposal || {};
  const target = Array.isArray(proposal?.scope?.paths)
    ? proposal.scope.paths.join(', ')
    : Array.isArray(proposal?.scope?.roots) ? proposal.scope.roots.join(', ') : '';
  detail.textContent = [String(approval.reason || ''), target ? `Цель: ${target}` : ''].filter(Boolean).join(' · ');
  const hash = document.createElement('small');
  hash.textContent = `binding ${String(approval.canonicalProposalHash || '').slice(0, 16)}…`;
  const actions = document.createElement('div');
  actions.className = 'coder-agent-approval-actions';
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.textContent = 'Отклонить';
  deny.disabled = coderState.approvalBusy;
  deny.addEventListener('click', () => void settleCoderApproval('deny', approval, agentTaskId));
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'primary';
  approve.textContent = coderState.approvalBusy ? 'Проверяю…' : 'Разрешить один раз';
  approve.disabled = coderState.approvalBusy;
  approve.addEventListener('click', () => void settleCoderApproval('approve', approval, agentTaskId));
  actions.append(deny, approve);
  article.append(header, detail, hash, actions);
  return article;
}

async function settleCoderApproval(decision, approval, agentTaskId) {
  if (coderState.approvalBusy || !coderState.run?.id) return;
  coderState.approvalBusy = true;
  coderState.lastEventSignature = '';
  renderRun();
  const binding = {
    canonicalProposalHash: String(approval.canonicalProposalHash || ''),
    capabilityId: String(approval.capabilityId || ''),
  };
  try {
    if (decision === 'approve') await armAgentTaskApproval(agentTaskId, approval.id, binding);
    await resolveAgentTaskApproval(agentTaskId, approval.id, decision, 'once', binding);
    const payload = await fetchCoderRun(coderState.run.id);
    coderState.run = payload.run;
    mergeRunIntoOverview(payload.run);
  } catch (error) {
    renderInlineError(error instanceof Error ? error.message : String(error));
  } finally {
    coderState.approvalBusy = false;
    coderState.lastEventSignature = '';
    renderRun();
  }
}

function createCoderEventArticle({ event, presentation, repeats }, options = {}) {
  const article = document.createElement('article');
  article.className = 'coder-event';
  article.dataset.kind = event.kind;
  article.dataset.tone = presentation.tone;
  if (typeof event.ok === 'boolean') article.dataset.ok = String(event.ok);
  const header = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = presentation.title;
  if (repeats > 1) title.textContent += ` · ×${repeats}`;
  const time = document.createElement('time');
  time.textContent = formatTime(event.createdAt);
  header.append(title, time);
  article.append(header);

  const detailText = String(presentation.detail || '').trim();
  if (options.compact && detailText.length > 240) {
    const preview = document.createElement('p');
    preview.textContent = `${detailText.slice(0, 200).trimEnd()}…`;
    const fullDetail = document.createElement('details');
    fullDetail.className = 'coder-event-detail';
    const summary = document.createElement('summary');
    summary.textContent = 'Показать полностью';
    const fullText = document.createElement('p');
    fullText.textContent = detailText;
    fullDetail.append(summary, fullText);
    article.append(preview, fullDetail);
  } else {
    const detail = document.createElement('p');
    detail.textContent = detailText;
    article.append(detail);
  }

  if (coderState.eventFilter === 'all' && shouldShowTechnicalEventDetail(event, presentation)) {
    const technical = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Технические данные';
    const raw = document.createElement('pre');
    raw.textContent = `${event.title || ''}\n${event.detail || ''}`.trim();
    technical.append(summary, raw);
    article.append(technical);
  }
  return article;
}

function presentCoderEvent(event, requestedModel) {
  const title = String(event?.title || 'Событие Coder');
  const detail = String(event?.detail || '');
  const calledModel = /^Calling\s+(.+)$/i.exec(title)?.[1] || '';
  const runStatus = /^Task\s+(queued|running|completed|failed|cancelled)$/i.exec(title)?.[1]?.toLowerCase() || '';
  const isFallbackSwitch = calledModel === 'deepseek-coder-v2-lite-instruct'
    && requestedModel !== 'deepseek-coder-v2-lite-instruct';

  const modelIteration = /^Coder response\s*·\s*iteration\s+(\d+)$/i.exec(title)?.[1];
  if (modelIteration) {
    return { tone: 'progress', title: `Ответ модели · шаг ${modelIteration}`, detail };
  }

  if (/^Cancellation requested$/i.test(title)) {
    return {
      tone: 'progress',
      title: 'Останавливаю модель',
      detail: 'Активный ответ прерывается. Новые действия Coder больше не запускаются.',
    };
  }

  if (calledModel) {
    return {
      tone: isFallbackSwitch ? 'switching' : 'progress',
      title: isFallbackSwitch ? 'Резервная модель · DeepSeek Coder' : `Модель · ${coderModelLabel(calledModel)}`,
      detail: isFallbackSwitch ? 'Основная модель не ответила. Работа продолжается локально.' : 'Локальная генерация началась.',
    };
  }

  const primaryUnavailable = event?.kind === 'error'
    && /qwen3-coder-30b-a3b-instruct\s+unavailable/i.test(title);
  if (primaryUnavailable) {
    return {
      tone: 'switching',
      title: 'Переключаю модель',
      detail: 'Основная модель не ответила. Подключаю резервную локальную модель.',
    };
  }

  if (runStatus === 'cancelled') {
    return {
      tone: 'neutral',
      title: 'Сессия остановлена',
      detail: 'Работа остановлена. Контекст сессии сохранён.',
    };
  }

  if (runStatus) {
    const labels = {
      queued: ['Задача поставлена в очередь', 'Coder готовит локальную сессию.'],
      running: ['Сессия запущена', 'Coder работает с закреплённой папкой проекта.'],
      completed: ['Сессия завершена', 'Подтверждённый результат сохранён.'],
      failed: ['Сессия остановлена', presentCoderFailureDetail(detail)],
    };
    const [statusTitle, statusDetail] = labels[runStatus] || [title, detail];
    return { tone: runStatus === 'failed' ? 'failure' : 'neutral', title: statusTitle, detail: statusDetail };
  }

  if (/^Context compacted$/i.test(title)) {
    return { tone: 'neutral', title: 'Контекст сжат', detail: 'Старые события свёрнуты, полный журнал сохранён.' };
  }

  const toolStart = /^Run\s+(.+)$/i.exec(title)?.[1] || '';
  const toolDone = /^Completed\s+(.+)$/i.exec(title)?.[1] || '';
  if (toolStart || toolDone) {
    const capability = toolStart || toolDone;
    return {
      tone: toolDone ? 'progress' : 'neutral',
      title: `${toolDone ? 'Действие выполнено' : 'Выполняю действие'} · ${coderCapabilityLabel(capability)}`,
      detail: toolDone ? presentCoderSuccessDetail(detail) : 'Подробности доступны в техническом журнале.',
    };
  }

  if (event?.kind === 'error' || event?.ok === false) {
    return {
      tone: 'failure',
      title: event?.capabilityId ? `Шаг требует внимания · ${event.capabilityId}` : 'Нужна проверка',
      detail: presentCoderFailureDetail(detail),
    };
  }

  return { tone: 'neutral', title, detail };
}

function isFocusEvent(event, presentation) {
  if (event?.kind === 'error' || event?.ok === false || presentation.tone === 'failure' || presentation.tone === 'switching') return true;
  if (event?.kind === 'assistant') return true;
  if (/^Task\s+(completed|failed|cancelled|interrupted)$/i.test(String(event?.title || ''))) return true;
  if (event?.kind !== 'tool-result') return false;
  const capability = /^Completed\s+(.+)$/i.exec(String(event?.title || ''))?.[1] || String(event?.capabilityId || '');
  return !['coder.files.read', 'coder.files.list'].includes(capability);
}

function shouldShowTechnicalEventDetail(event, presentation) {
  const raw = `${event?.title || ''}\n${event?.detail || ''}`.trim();
  const friendly = `${presentation.title}\n${presentation.detail}`.trim();
  return raw.length > 0 && raw !== friendly;
}

function coderCapabilityLabel(capability) {
  const labels = {
    'coder.files.read': 'чтение файла',
    'coder.files.write': 'изменение файла',
    'coder.files.list': 'обзор проекта',
    'coder.workspace.execute': 'команда проекта',
  };
  return labels[capability] || capability;
}

function presentCoderFailureDetail(detail) {
  if (/required verified receipts:/i.test(detail)) {
    if (/must read at least one tests file/i.test(detail)) {
      return 'Аудит остановлен: Coder не подтвердил чтение тестов проекта. Проверенные шаги сохранены — задачу можно продолжить.';
    }
    return 'Не хватило подтверждённых результатов для честного завершения. Проверенные шаги сохранены.';
  }
  if (/request timed out after\s+\d+ms/i.test(detail)) {
    return 'Локальная модель не завершила ответ вовремя. Сессию можно повторить.';
  }
  if (/backend adapter failed:\s*fetch failed/i.test(detail)) {
    return 'Локальный backend не ответил. Повтори сессию после его перезапуска.';
  }
  if (/model returned no action envelope/i.test(detail)) {
    return 'Модель не предложила подтверждаемое действие. Контекст сессии сохранён.';
  }
  if (/^coder\.[\w.-]+$/i.test(detail.trim())) {
    return 'Действие не выполнено. Подробности доступны в полном журнале.';
  }
  return detail;
}

function presentCoderSuccessDetail(detail) {
  const listed = /^Listed\s+(\d+)\s+project entries\.?$/i.exec(detail)?.[1];
  if (listed) return `Найдено элементов проекта: ${listed}.`;
  const read = /^Read\s+(\d+)\s+characters\.?$/i.exec(detail)?.[1];
  if (read) return `Прочитано символов: ${read}.`;
  return detail || 'Шаг завершён.';
}

function coderModelLabel(model) {
  if (model === 'qwen3-coder-30b-a3b-instruct') return 'Qwen Coder';
  if (model === 'deepseek-coder-v2-lite-instruct') return 'DeepSeek Coder';
  return model;
}

function renderContext(run) {
  const context = run?.context;
  const summary = run?.summary;
  const used = context?.estimatedPromptTokens || 0;
  const budget = Math.max(1, (context?.budgetTokens || 0) - (context?.reservedOutputTokens || 0));
  const percent = context ? Math.min(100, Math.round(used / budget * 100)) : 0;
  elements.contextPercent.textContent = `${percent}%`;
  elements.contextFill.style.width = `${percent}%`;
  elements.contextBudget.textContent = context ? `${formatNumber(used)} / ${formatNumber(budget)}` : '—';
  elements.contextCompactions.textContent = String(context?.compactions || 0);
  elements.contextEvents.textContent = String(context?.totalEvents || 0);
  elements.contextModelTokens.textContent = formatNumber(context?.modelTotalTokens || 0);
  renderContextList(elements.contextFiles, summary?.modifiedFiles, 'Пока нет');
  renderContextList(elements.contextTests, summary?.tests, 'Пока нет');
  const pendingFallback = run?.status === 'completed'
    ? 'Завершено'
    : run?.status === 'failed'
      ? 'Повтори задачу после проверки локальной модели'
      : run?.status === 'cancelled'
        ? 'Начни новую задачу, когда будешь готов'
        : run?.status === 'interrupted'
          ? 'Продолжи задачу с последнего checkpoint'
        : 'Жду задачу';
  renderContextList(elements.contextPending, ['failed', 'cancelled', 'interrupted'].includes(run?.status) ? null : summary?.pending, pendingFallback);
}

function renderContextList(container, values, fallback) {
  if (!container) return;
  container.replaceChildren();
  if (!Array.isArray(values) || !values.length) { container.textContent = fallback; return; }
  for (const value of values.slice(-12)) {
    const row = document.createElement('span');
    row.textContent = value;
    container.append(row);
  }
}

function renderFastHistory(pending) {
  const fragment = document.createDocumentFragment();
  for (const message of coderState.fastHistory) {
    const item = document.createElement('p');
    item.dataset.role = message.role;
    item.textContent = message.content;
    fragment.append(item);
  }
  if (pending) {
    const item = document.createElement('p');
    item.textContent = 'Fast думает…';
    fragment.append(item);
  }
  elements.fastMessages.replaceChildren(fragment);
  elements.fastMessages.scrollTop = elements.fastMessages.scrollHeight;
}

function handleFileSearch(event) {
  coderState.fileQuery = event.currentTarget?.value || '';
  renderFileTree(coderState.snapshot?.entries || []);
}

function handleComposerKeydown(event) {
  if (event.key !== 'Enter' || !event.ctrlKey) return;
  event.preventDefault();
  elements.composer?.requestSubmit();
}

function openCoderHistory(event) {
  closeMobilePanels();
  closeCoderContextMenu();
  toggleFastDrawer(false);
  coderState.historyFocusReturn = event?.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : document.activeElement instanceof HTMLElement ? document.activeElement : elements.historyOpen;
  coderState.historyOpen = true;
  syncWorkspaceNavigation('history');
  coderState.pendingDeleteRunId = '';
  setInlineMessage(elements.historyError, '');
  if (elements.historyDrawer) elements.historyDrawer.hidden = false;
  if (elements.historyBackdrop) elements.historyBackdrop.hidden = false;
  elements.historyOpen?.setAttribute('aria-expanded', 'true');
  renderRunHistory();
  requestAnimationFrame(() => elements.historySearch?.focus());
}

function closeCoderHistory(options = {}) {
  coderState.historyOpen = false;
  syncWorkspaceNavigation('work');
  coderState.pendingDeleteRunId = '';
  if (elements.historyDrawer) elements.historyDrawer.hidden = true;
  if (elements.historyBackdrop) elements.historyBackdrop.hidden = true;
  elements.historyOpen?.setAttribute('aria-expanded', 'false');
  if (options.restoreFocus !== false) {
    const target = coderState.historyFocusReturn?.isConnected ? coderState.historyFocusReturn : elements.historyOpen;
    target?.focus();
  }
  coderState.historyFocusReturn = null;
}

function handleHistorySearch(event) {
  coderState.historyQuery = event.currentTarget?.value || '';
  renderRunHistory();
}

function handleHistoryProjectFilter(event) {
  coderState.historyProject = event.currentTarget?.value || 'all';
  renderRunHistory();
}

function handleHistoryStatusFilter(event) {
  coderState.historyStatus = event.currentTarget?.dataset?.coderHistoryStatus || 'all';
  for (const button of elements.historyStatusButtons || []) {
    button.setAttribute('aria-pressed', String(button.dataset.coderHistoryStatus === coderState.historyStatus));
  }
  renderRunHistory();
}

async function handleHistoryAction(event) {
  const open = event.target.closest('[data-coder-history-open]');
  const continueButton = event.target.closest('[data-coder-history-continue]');
  const requestDelete = event.target.closest('[data-coder-history-delete]');
  const confirmDelete = event.target.closest('[data-coder-history-delete-confirm]');
  const cancelDelete = event.target.closest('[data-coder-history-delete-cancel]');
  if (open) await openHistoryRun(open.dataset.coderHistoryOpen);
  else if (continueButton) await continueHistoryRun(continueButton.dataset.coderHistoryContinue);
  else if (requestDelete) {
    coderState.pendingDeleteRunId = requestDelete.dataset.coderHistoryDelete || '';
    renderRunHistory();
  } else if (confirmDelete) await deleteHistoryRun(confirmDelete.dataset.coderHistoryDeleteConfirm);
  else if (cancelDelete) {
    coderState.pendingDeleteRunId = '';
    renderRunHistory();
  }
}

async function openHistoryRun(runId) {
  const run = coderState.allRuns.find((entry) => entry.id === runId);
  if (!run || coderState.historyBusy) return;
  if (!coderProjectForRun(run)) {
    setInlineMessage(elements.historyError, 'Проект этой сессии больше не подключён. Журнал сохранён, но открыть его рядом с чужим workspace нельзя.');
    return;
  }
  if (isRunActive(coderState.run) && coderState.run.id !== run.id) {
    setInlineMessage(elements.historyError, 'Сначала останови текущую сессию. Во время работы другой проект и журнал не переключаются.');
    return;
  }
  setHistoryBusy(true);
  try {
    await activateHistoryProject(run.projectId);
    const payload = await fetchCoderRun(run.id);
    stopPolling();
    coderState.run = payload.run;
    coderState.runEncrypted = false;
    coderState.continuationSourceId = '';
    coderState.lastEventSignature = '';
    mergeRunIntoOverview(payload.run);
    closeCoderHistory({ restoreFocus: false });
    renderAll();
    if (isRunActive(payload.run)) startPolling(payload.run.id);
  } catch (error) {
    setInlineMessage(elements.historyError, error instanceof Error ? error.message : String(error));
  } finally {
    setHistoryBusy(false);
  }
}

async function continueHistoryRun(runId) {
  const run = coderState.allRuns.find((entry) => entry.id === runId);
  if (!run || coderState.historyBusy || isRunActive(coderState.run)) return;
  if (!coderProjectForRun(run)) {
    setInlineMessage(elements.historyError, 'Чтобы продолжить эту сессию, сначала снова подключи её проект.');
    return;
  }
  setHistoryBusy(true);
  try {
    await activateHistoryProject(run.projectId);
    coderState.continuationSourceId = run.id;
    closeCoderHistory({ restoreFocus: false });
    startFreshTask({ keepContinuation: true });
    if (elements.input) {
      elements.input.value = buildHistoryContinuationPrompt(run);
      autoGrowTextarea.call(elements.input);
      elements.input.focus();
    }
    renderComposerContext();
  } catch (error) {
    setInlineMessage(elements.historyError, error instanceof Error ? error.message : String(error));
  } finally {
    setHistoryBusy(false);
  }
}

async function deleteHistoryRun(runId) {
  const run = coderState.allRuns.find((entry) => entry.id === runId);
  if (!run || isRunActive(run) || coderState.historyBusy) return;
  setHistoryBusy(true);
  try {
    await deleteCoderRun(run.id);
    coderState.allRuns = coderState.allRuns.filter((entry) => entry.id !== run.id);
    if (Array.isArray(coderState.overview?.runs)) coderState.overview.runs = coderState.overview.runs.filter((entry) => entry.id !== run.id);
    if (coderState.run?.id === run.id) {
      coderState.run = null;
      coderState.lastEventSignature = '';
    }
    coderState.pendingDeleteRunId = '';
    renderAll();
  } catch (error) {
    setInlineMessage(elements.historyError, error instanceof Error ? error.message : String(error));
  } finally {
    setHistoryBusy(false);
  }
}

async function activateHistoryProject(projectId) {
  if (coderState.snapshot?.project?.id === projectId) return;
  const payload = await mutateCoderProject('activate', { projectId });
  const overview = await fetchCoderOverview();
  coderState.overview = overview;
  coderState.snapshot = overview.active || payload.project;
  coderState.activeFilePath = '';
  coderState.expandedDirectories.clear();
  closeFilePreview();
  renderProjectSelect();
  renderProject();
}

function setHistoryBusy(busy) {
  coderState.historyBusy = busy;
  elements.historyDrawer?.setAttribute('aria-busy', String(busy));
  for (const control of [elements.historySearch, elements.historyProject, elements.historyClose]) if (control) control.disabled = busy;
  for (const button of elements.historyStatusButtons || []) button.disabled = busy;
  if (!busy && coderState.historyOpen) renderRunHistory();
}

function startFreshTask(options = {}) {
  if (isRunActive(coderState.run)) return;
  stopPolling();
  coderState.run = null;
  coderState.runEncrypted = false;
  coderState.pollDisconnected = false;
  coderState.lastEventSignature = '';
  if (options.keepContinuation !== true) coderState.continuationSourceId = '';
  renderRun();
  renderRunHistory();
  requestAnimationFrame(() => elements.input?.focus());
}

async function retryCurrentRun() {
  const run = coderState.run;
  if (!run) return;
  if (isRunActive(run) && coderState.pollDisconnected) {
    startPolling(run.id);
    renderRunSummary(run);
    return;
  }
  if (run.status === 'interrupted') {
    setRunBusy(true);
    try {
      const payload = await resumeCoderRun(run.id);
      coderState.run = payload.run;
      mergeRunIntoOverview(payload.run);
      renderRun();
      renderRunHistory();
      startPolling(run.id);
    } catch (error) {
      renderInlineError(error instanceof Error ? error.message : String(error));
      setRunBusy(false);
    }
    return;
  }
  const prompt = run.status === 'failed' ? String(run.prompt || coderState.lastPrompt || '') : '';
  coderState.continuationSourceId = run.id;
  startFreshTask({ keepContinuation: true });
  if (prompt && elements.input) {
    elements.input.value = prompt;
    autoGrowTextarea.call(elements.input);
  }
}

function handleEventFilter(event) {
  const value = event.currentTarget?.dataset?.coderEventFilter === 'all' ? 'all' : 'focus';
  coderState.eventFilter = value;
  for (const button of elements.eventFilterButtons || []) {
    button.setAttribute('aria-pressed', String(button.dataset.coderEventFilter === value));
  }
  coderState.lastEventSignature = '';
  renderEvents(
    coderState.run?.events || [],
    coderState.run?.model || coderState.model,
    coderState.run?.agentApproval,
    coderState.run?.agentTaskId,
  );
  event.currentTarget?.closest('details.coder-journal-menu')?.removeAttribute('open');
}

function applyTaskTemplate(event) {
  if (!elements.input || elements.input.disabled) return;
  const template = event.currentTarget?.dataset?.coderTemplate || '';
  elements.input.value = template;
  autoGrowTextarea.call(elements.input);
  elements.input.focus();
  elements.input.setSelectionRange(template.length, template.length);
}

function openWorkspaceDrawer(panel) {
  coderState.mobilePanel = panel;
  if (elements.explorer) elements.explorer.hidden = panel !== 'project';
  if (elements.contextPanel) elements.contextPanel.hidden = panel !== 'result';
  elements.explorer?.classList.toggle('is-drawer-open', panel === 'project');
  elements.contextPanel?.classList.toggle('is-drawer-open', panel === 'result');
  elements.mobileProject?.setAttribute('aria-expanded', String(panel === 'project'));
  elements.mobileResult?.setAttribute('aria-expanded', String(panel === 'result'));
  syncWorkspaceNavigation(panel);
  if (elements.panelBackdrop) elements.panelBackdrop.hidden = false;
  closeCoderContextMenu();
}

function toggleMobilePanel(panel) {
  if (coderState.mobilePanel === panel) {
    closeMobilePanels();
    return;
  }
  openWorkspaceDrawer(panel);
}

function closeMobilePanels() {
  coderState.mobilePanel = null;
  elements.explorer?.classList.remove('is-drawer-open');
  elements.contextPanel?.classList.remove('is-drawer-open');
  if (elements.explorer) elements.explorer.hidden = true;
  if (elements.contextPanel) elements.contextPanel.hidden = true;
  elements.mobileProject?.setAttribute('aria-expanded', 'false');
  elements.mobileResult?.setAttribute('aria-expanded', 'false');
  syncWorkspaceNavigation('work');
  if (elements.panelBackdrop) elements.panelBackdrop.hidden = true;
}

function syncWorkspaceNavigation(active) {
  const navigation = [
    [elements.workspaceFocus, 'work'],
    [elements.mobileProject, 'project'],
    [elements.mobileResult, 'result'],
    [elements.historyOpen, 'history'],
  ];
  for (const [button, key] of navigation) {
    if (!button) continue;
    button.classList.toggle('is-current', key === active);
    if (key === active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function closeCoderContextMenu() {
  document.querySelector('details.coder-context-menu')?.removeAttribute('open');
}

function handleCoderEscape(event) {
  if (event.key !== 'Escape' || coderState.mode !== 'coder') return;
  if (coderState.historyOpen) {
    closeCoderHistory();
    return;
  }
  if (elements.fastDrawer && !elements.fastDrawer.hidden) {
    toggleFastDrawer(false);
    elements.fastOpen?.focus();
    return;
  }
  closeMobilePanels();
}

function closeFilePreview() {
  coderState.activeFilePath = '';
  if (elements.previewShell) elements.previewShell.hidden = true;
  if (elements.preview) elements.preview.textContent = '';
  renderFileTree(coderState.snapshot?.entries || []);
}

function renderComposerContext() {
  if (!elements.composerContext) return;
  const project = coderState.snapshot?.project?.name || 'Проект не выбран';
  const continuation = coderState.allRuns.find((run) => run.id === coderState.continuationSourceId);
  elements.composerContext.textContent = continuation
    ? `${project} · продолжение: ${conciseHistoryTitle(continuation.prompt)}`
    : `${project} · модель запуска: ${coderModelLabel(coderState.model)}`;
}

function renderComposerVisibility(run) {
  if (!elements.composer) return;
  const terminal = Boolean(run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status));
  elements.composer.hidden = terminal;
}

function mergeRunIntoOverview(run) {
  if (!run || !coderState.overview) return;
  const runs = Array.isArray(coderState.overview.runs) ? coderState.overview.runs : [];
  coderState.overview.runs = [run, ...runs.filter((entry) => entry.id !== run.id)];
  coderState.allRuns = [run, ...coderState.allRuns.filter((entry) => entry.id !== run.id)]
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function lastAssistantDetail(events) {
  const event = [...(events || [])].reverse().find((entry) => entry.kind === 'assistant' && String(entry.detail || '').trim());
  return event ? String(event.detail).trim() : '';
}

function terminalAnswerPreview(run) {
  const answer = String(run?.answer || '').trim();
  if (!answer) return lastAssistantDetail(run?.events);
  const analytical = answer.split(/\nИтог Coder:\s*\n/i).at(-1)?.trim() || answer;
  const singleLine = analytical.replace(/\s+/g, ' ').trim();
  return singleLine.length <= 360 ? singleLine : `${singleLine.slice(0, 357)}…`;
}

function lastFailureDetail(events) {
  const event = [...(events || [])].reverse().find((entry) => entry.kind === 'error' || entry.ok === false);
  return event ? presentCoderFailureDetail(String(event.detail || '')) : '';
}

function isRunActive(run) {
  return Boolean(run && (run.status === 'running' || run.status === 'queued'));
}

function setInlineMessage(element, message) {
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function setFastBusy(busy) {
  elements.fastForm?.setAttribute('aria-busy', String(busy));
  if (elements.fastInput) elements.fastInput.disabled = busy;
  const submit = elements.fastForm?.querySelector('button[type="submit"]');
  if (submit) {
    submit.disabled = busy;
    submit.textContent = busy ? 'Отвечаю…' : 'Отправить';
  }
}

function renderInlineError(message) {
  if (!elements.activity) return;
  const article = document.createElement('article');
  article.className = 'coder-event';
  article.dataset.ok = 'false';
  const strong = document.createElement('strong');
  strong.textContent = 'Coder Mode';
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  article.append(strong, paragraph);
  elements.activity.prepend(article);
}

function setWorkspaceBusy(busy) {
  for (const element of [elements.projectNew, elements.projectImport, elements.onboardingCreate, elements.onboardingImport, elements.refresh]) {
    if (element) element.disabled = busy || (isRunActive(coderState.run) && element !== elements.refresh);
  }
  const dialogSubmit = elements.projectForm?.querySelector('button[type="submit"]');
  if (dialogSubmit) dialogSubmit.disabled = busy;
}

function setRunBusy(busy) {
  const cancellationRequested = busy && (coderState.cancelBusy || coderState.run?.cancelled === true);
  elements.composer?.setAttribute('aria-busy', String(busy));
  if (elements.submit) elements.submit.hidden = busy;
  if (elements.cancel) {
    elements.cancel.hidden = !busy;
    elements.cancel.disabled = cancellationRequested;
    elements.cancel.textContent = cancellationRequested ? 'Останавливаю…' : 'Остановить';
  }
  if (elements.input) elements.input.disabled = busy;
  if (elements.suggestions) elements.suggestions.hidden = busy || Boolean(coderState.run);
  if (elements.projectSelect) elements.projectSelect.disabled = busy || !(coderState.overview?.projects?.projects || []).length;
  for (const element of [elements.projectNew, elements.projectImport, elements.onboardingCreate, elements.onboardingImport]) if (element) element.disabled = busy;
  renderModelSelection();
  for (const button of elements.modelButtons || []) button.disabled = button.disabled || busy;
}

function selectCurrentRun(runs) {
  return runs.find((run) => run.status === 'running' || run.status === 'queued') || runs[0] || null;
}

function coderProjectForRun(run) {
  return (coderState.overview?.projects?.projects || []).find((project) => project.id === run?.projectId) || null;
}

function coderProjectName(run, project = coderProjectForRun(run)) {
  return String(run?.projectName || project?.name || run?.projectRoot || 'Архивный проект');
}

function historyDateGroup(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Ранее';
  const today = new Date();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const difference = Math.round((todayDay - day) / 86_400_000);
  if (difference === 0) return 'Сегодня';
  if (difference === 1) return 'Вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function formatHistoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function conciseHistoryTitle(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > 88 ? `${normalized.slice(0, 88)}…` : normalized || 'Без названия';
}

function formatHistoryMetric(value, one, few, many) {
  const number = Math.max(0, Number(value) || 0);
  const mod100 = number % 100;
  const mod10 = number % 10;
  const label = mod100 >= 11 && mod100 <= 14 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many;
  return `${number} ${label}`;
}

function pluralizeSteps(value) {
  const number = Math.max(0, Number(value) || 0);
  const mod100 = number % 100;
  const mod10 = number % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'шагов';
  if (mod10 === 1) return 'шаг';
  if (mod10 >= 2 && mod10 <= 4) return 'шага';
  return 'шагов';
}

function closeCoderActionMenu(element) {
  element?.closest('details.coder-action-menu')?.removeAttribute('open');
}

function buildHistoryContinuationPrompt(run) {
  const lines = [
    'Продолжи работу по предыдущей Code-сессии.',
    `Предыдущая задача: ${compactHistoryText(run.prompt, 900)}`,
  ];
  const modifiedFiles = Array.isArray(run.summary?.modifiedFiles) ? run.summary.modifiedFiles.slice(-8) : [];
  const tests = Array.isArray(run.summary?.tests) ? run.summary.tests.slice(-6) : [];
  const previousResult = run.answer || run.summary?.lastAssistantSummary || '';
  if (modifiedFiles.length) lines.push(`Изменённые файлы: ${modifiedFiles.join(', ')}`);
  if (tests.length) lines.push(`Проверки: ${tests.join('; ')}`);
  if (previousResult) lines.push(`Предыдущий итог: ${compactHistoryText(previousResult, 1_200)}`);
  lines.push('Сначала проверь актуальное состояние проекта и продолжи с учётом уже подтверждённых результатов.');
  return lines.join('\n\n');
}

function compactHistoryText(value, limit) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function conciseTitle(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > 64 ? `${normalized.slice(0, 64)}…` : normalized || 'Coder task';
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU', { notation: value > 9999 ? 'compact' : 'standard' }).format(value || 0);
}

function autoGrowTextarea(event) {
  const input = event?.currentTarget || this || elements.input;
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}
