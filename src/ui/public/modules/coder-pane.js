// Coder: a project, its conversations, and the work Oscar/Astra does inside it.
// Presentation and requests only. Kernel, approvals and completion stay with
// the common Oscar Turn → Astra V3 Agent Task runtime.
import { confirmAction, promptValue } from './ui-dialogs.js';
import { coderLineDiff, coderProposedContent, renderCoderDiff } from './coder-diff.js';
import { formatOscarContent } from './utils.js';
import { mountCoderView, CODER_ICONS } from './coder-view.js';
import {
  coderAvailableModels, coderChangedFiles, coderChecks, coderEvidenceNote, coderPatchRows, coderRelativePath, coderRunState,
  coderSessionGroup, coderSessions, coderStepDetail, coderSteps, coderTitle, isCoderRunActive,
} from './coder-thread.js';
import {
  armAgentTaskApproval, cancelCoderRun, deleteCoderRun, executeCapability, fetchCoderChanges, fetchCoderOverview,
  fetchCoderRun, mutateCoderProject, resolveAgentTaskApproval, resumeCoderRun, startCoderRun, streamCoderRun,
  submitCoderReply,
} from './api.js';

const MODEL_KEY = 'monarch.coder.model';
const RAIL_KEY = 'monarch.coder.rail';
const STEP_COLLAPSE_AT = 5;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const state = {
  initialized: false,
  mode: 'chat',
  generation: 0,
  overview: null,
  snapshot: null,
  runs: [],
  sessionId: null,
  models: [],
  model: '',
  submitting: false,
  request: null,
  streams: new Map(),
  disconnected: new Set(),
  railOpen: true,
  search: '',
  review: { open: false, tab: 'changes', changes: null, loading: false, error: '', expanded: new Set(), fileQuery: '',
    preview: null },
  expandedSteps: new Set(),
  expandedRuns: new Set(),
  approvalBusy: '',
  stopping: '',
  questionBusy: '',
  questionDrafts: new Map(),
  /** The question that already got focus once (run:question id). */
  focusedQuestion: '',
  approvalDiffs: new Map(),
  renderedTurns: new Set(),
  safe: { unlocked: false, chats: [], busy: false, viewing: null },
  banner: '',
  tick: 0,
};

const ui = {};

export function initCoderPane() {
  if (state.initialized) return;
  const root = document.querySelector('#coder-mode-root');
  if (!root) return;
  Object.assign(ui, mountCoderView(root), {
    root,
    section: document.querySelector('#oscar-section'),
    chatTab: document.querySelector('#chat-mode-standard'),
    coderTab: document.querySelector('#chat-mode-coder'),
  });
  state.initialized = true;
  const breadcrumb = document.querySelector('.oscar-breadcrumb');
  if (breadcrumb) {
    ui.topbarTitle = Object.assign(document.createElement('span'), { className: 'cdr-topbar-title' });
    ui.topbarTitle.innerHTML = '<b>Coder</b><span></span>';
    breadcrumb.append(ui.topbarTitle);
  }
  try { state.railOpen = localStorage.getItem(RAIL_KEY) !== 'closed'; } catch { /* storage is a convenience */ }
  try { state.model = localStorage.getItem(MODEL_KEY) || ''; } catch { /* storage is a convenience */ }
  bindEvents();
  window.monarchDesktop?.onSafeChatStatus?.(status => {
    state.safe.unlocked = status?.unlocked === true;
    if (!state.safe.unlocked) { state.safe.chats = []; state.safe.viewing = null; render(); }
    else void loadSafeChats();
  });
  let savedMode = 'chat';
  try { savedMode = localStorage.getItem('monarch.oscar.mode') === 'coder' ? 'coder' : 'chat'; } catch { /* default chat */ }
  setCoderMode(savedMode, { persist: false });
}

export async function loadCoderOverview() {
  if (!ui.root) return;
  const generation = ++state.generation;
  try {
    const payload = await fetchCoderOverview();
    let providers = [];
    if (payload.runtime?.maxConfigured && typeof window.monarchDesktop?.astraMax?.providers === 'function') {
      const view = await window.monarchDesktop.astraMax.providers().catch(() => null);
      providers = (Array.isArray(view?.providers) ? view.providers : [])
        .filter(entry => entry?.state === 'ready')
        .map(entry => entry.id === 'groq' ? { ...entry, model: 'GPT OSS 120B' } : entry)
        .sort((a, b) => Number(b.id === view.selectedProviderId) - Number(a.id === view.selectedProviderId));
    }
    if (generation !== state.generation || state.mode !== 'coder') return;
    state.overview = payload;
    state.snapshot = payload.active || null;
    mergeRuns(payload.runs || [], { replaceProject: state.snapshot?.project?.id });
    state.models = coderAvailableModels(payload.runtime, providers);
    // A conversation keeps the MAX model it started with, even where the
    // desktop bridge cannot list services (the host still validates the role).
    if (payload.runtime?.maxConfigured) {
      for (const run of [...(payload.runs || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
        if (String(run.model).startsWith('max-cloud:') && !state.models.some(model => model.id === run.model)) {
          const [, providerId = '', ...rest] = String(run.model).split(':');
          state.models.push({ id: run.model, label: rest.join(':'), provider: providerId, source: 'max' });
        }
      }
    }
    if (!state.models.some(model => model.id === state.model)) {
      state.model = state.models.find(model => model.source === 'max')?.id
        || state.models.find(model => model.id === payload.runtime?.defaultModel)?.id || state.models[0]?.id || '';
    }
    const sessions = projectSessions();
    if (state.sessionId && !sessions.some(session => session.id === state.sessionId)) state.sessionId = null;
    if (state.sessionId === null && !state.request && sessions[0]) {
      const latest = sessions[0];
      // Reopen the conversation the person left, unless it is long finished.
      if (latest.active || latest.attention || Date.now() - Date.parse(latest.updatedAt) < 6 * 3_600_000) state.sessionId = latest.id;
    }
    adoptSessionModel();
    state.banner = '';
    render();
    for (const run of state.runs) if (isCoderRunActive(run)) follow(run.id);
    void loadSafeChats();
    if (state.review.open) void loadChanges();
  } catch (error) {
    if (generation !== state.generation) return;
    state.banner = messageOf(error);
    render();
  }
}

// ── Mode (the shared Chat/Coder switch keeps its established behaviour) ─────

function setCoderMode(mode, options = {}) {
  state.mode = mode === 'coder' ? 'coder' : 'chat';
  const active = state.mode === 'coder';
  ui.section?.classList.toggle('coder-mode-active', active);
  ui.root.hidden = !active;
  ui.chatTab?.setAttribute('aria-selected', String(!active));
  ui.coderTab?.setAttribute('aria-selected', String(active));
  ui.chatTab?.closest('.chat-mode-switch')?.setAttribute('data-active-mode', active ? 'coder' : 'chat');
  const shell = document.querySelector('#app-shell');
  shell?.classList.toggle('coder-workspace-active', active);
  shell?.dispatchEvent(new Event('monarch:mascot-surface-changed'));
  if (options.persist !== false) { try { localStorage.setItem('monarch.oscar.mode', active ? 'coder' : 'chat'); } catch { /* ignore */ } }
  if (active) void loadCoderOverview();
  else {
    state.generation += 1;
    for (const controller of state.streams.values()) controller.abort();
    state.streams.clear();
    closeMenus();
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

function bindEvents() {
  ui.chatTab?.addEventListener('click', () => setCoderMode('chat'));
  ui.coderTab?.addEventListener('click', () => setCoderMode('coder'));
  window.addEventListener('monarch:max-selection-changed', () => {
    if (state.mode === 'coder' && !state.submitting) void loadCoderOverview();
  });

  ui['project-button'].addEventListener('click', () => toggleMenu(ui['project-button'], ui['project-menu']));
  ui['project-list'].addEventListener('click', event => {
    const id = event.target.closest('[data-project-id]')?.dataset.projectId;
    if (id) void activateProject(id);
  });
  ui['project-import'].addEventListener('click', () => void importProject());
  ui['project-create'].addEventListener('click', openCreateDialog);
  ui['welcome-import'].addEventListener('click', () => void importProject());
  ui['welcome-create'].addEventListener('click', openCreateDialog);
  ui['create-cancel'].addEventListener('click', () => ui['create-dialog'].close());
  ui['create-form'].addEventListener('submit', event => void createProject(event));

  ui['new-session'].addEventListener('click', () => newSession());
  ui['session-search'].addEventListener('input', event => { state.search = event.currentTarget.value; renderSessions(); });
  ui.sessions.addEventListener('click', event => {
    const id = event.target.closest('[data-session-id]')?.dataset.sessionId;
    if (id) openSession(id);
    const safeId = event.target.closest('[data-safe-id]')?.dataset.safeId;
    if (safeId) void openSafeChat(safeId);
  });
  ui['rail-toggle'].addEventListener('click', () => {
    const shown = ui.root.dataset.rail === 'true';
    if (!shown && state.review.open && !narrow() && ui.root.clientWidth < 1300) { state.review.open = false; renderReview(); }
    setRail(!shown);
  });

  ui['open-changes'].addEventListener('click', () => toggleReview('changes'));
  ui['open-files'].addEventListener('click', () => toggleReview('files'));
  ui['review-close'].addEventListener('click', () => setReview(false));
  ui.scrim.addEventListener('click', () => { setReview(false); if (narrow()) setRail(false); });
  for (const tab of ui.tabs) tab.addEventListener('click', () => { state.review.tab = tab.dataset.cdrTab; renderReview(); if (tab.dataset.cdrTab === 'changes') void loadChanges(); });
  ui['review-body'].addEventListener('click', handleReviewClick);
  ui['review-body'].addEventListener('input', event => {
    if (!event.target.matches('[data-file-search]')) return;
    state.review.fileQuery = event.target.value; renderFileList();
  });

  ui.more.addEventListener('click', () => toggleMenu(ui.more, ui['more-menu']));
  ui['safe-move'].addEventListener('click', () => { closeMenus(); void moveSessionToSafe(); });
  ui['session-delete'].addEventListener('click', () => { closeMenus(); void deleteSession(); });

  ui.composer.addEventListener('submit', event => { event.preventDefault(); void send(); });
  ui.input.addEventListener('input', () => { growInput(); renderComposer(); });
  ui.input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
  });
  ui.stop.addEventListener('click', () => void stop());
  ui['model-button'].addEventListener('click', () => toggleMenu(ui['model-button'], ui['model-menu']));
  ui['model-menu'].addEventListener('click', event => {
    const option = event.target.closest('[data-model-id]');
    if (option) { chooseModel(option.dataset.modelId); return; }
    const settingsTarget = event.target.closest('[data-open-max], [data-open-models]');
    if (settingsTarget) {
      closeMenus();
      const subview = settingsTarget.hasAttribute('data-open-models') ? 'models' : 'max';
      window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view: 'settings-section', subview } }));
    }
  });

  ui.thread.addEventListener('click', handleThreadClick);
  ui.thread.addEventListener('submit', handleThreadSubmit);
  ui.thread.addEventListener('keydown', event => {
    const form = event.target.closest?.('[data-question-run]');
    if (!form || event.target.tagName !== 'TEXTAREA') return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  ui.thread.addEventListener('input', event => {
    const runId = event.target.closest('[data-question-run]')?.dataset.questionRun;
    if (runId) state.questionDrafts.set(runId, event.target.value);
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.cdr-menu, [aria-haspopup]')) closeMenus();
  });
  document.addEventListener('keydown', event => {
    if (state.mode !== 'coder' || ui.root.hidden) return;
    if (event.key === 'Escape') {
      if (closeMenus()) return;
      if (state.review.open) { setReview(false); return; }
      if (narrow() && state.railOpen) setRail(false);
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'n'
      && ui.root.contains(document.activeElement ?? document.body)) { event.preventDefault(); newSession(); }
  });
  new ResizeObserver(() => syncLayout()).observe(ui.root);
  window.setInterval(() => { if (state.mode === 'coder' && currentRuns().some(isCoderRunActive)) renderClocks(); }, 1000);
}

// ── Data ─────────────────────────────────────────────────────────────────────

function mergeRuns(runs, { replaceProject } = {}) {
  const incoming = new Map(runs.map(run => [run.id, run]));
  const kept = state.runs.filter(run => !incoming.has(run.id) && (!replaceProject || run.projectId !== replaceProject
    || isCoderRunActive(run)));
  state.runs = [...kept, ...incoming.values()];
}

function upsertRun(run) {
  const index = state.runs.findIndex(entry => entry.id === run.id);
  if (index >= 0) {
    if (String(state.runs[index].updatedAt) > String(run.updatedAt)) return false;
    state.runs[index] = run;
  } else state.runs.push(run);
  return true;
}

function projectId() { return state.snapshot?.project?.id || ''; }
function projectRuns() { return state.runs.filter(run => run.projectId === projectId()); }
function projectSessions() { return coderSessions(projectRuns()); }
function currentRuns() {
  if (state.safe.viewing) return [state.safe.viewing];
  if (!state.sessionId) return [];
  return projectRuns().filter(run => (run.sessionId || run.id) === state.sessionId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}
function activeProjectRun() { return projectRuns().find(isCoderRunActive) ?? null; }
function narrow() { return ui.root.clientWidth < 900; }
function messageOf(error) { return error instanceof Error ? error.message : String(error); }

/** Follow one run live; reconnects with backoff, falls back to a single read. */
function follow(runId) {
  if (state.streams.has(runId) || state.mode !== 'coder') return;
  const controller = new AbortController();
  state.streams.set(runId, controller);
  void (async () => {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        for await (const run of streamCoderRun(runId, { signal: controller.signal })) {
          failures = 0;
          if (state.disconnected.delete(runId)) state.banner = '';
          if (upsertRun(run)) onRunChanged(run);
        }
        const latest = await fetchCoderRun(runId);
        if (latest?.run && upsertRun(latest.run)) onRunChanged(latest.run);
        if (!latest?.run || !isCoderRunActive(latest.run) && !latest.run.agentQuestion && !latest.run.agentApproval) break;
      } catch (error) {
        if (controller.signal.aborted) break;
        failures += 1;
        state.disconnected.add(runId);
        renderHead();
        if (/not.found|404/iu.test(messageOf(error))) break;
        await new Promise(resolve => window.setTimeout(resolve, Math.min(15_000, 600 * 2 ** Math.min(failures, 5))));
      }
    }
    if (state.streams.get(runId) === controller) state.streams.delete(runId);
    state.disconnected.delete(runId);
    renderHead();
  })();
}

function onRunChanged(run) {
  const visible = currentRuns().some(entry => entry.id === run.id);
  if (!isCoderRunActive(run) && state.review.open && state.review.tab === 'changes' && visible) void loadChanges();
  renderSessions();
  if (visible) { renderHead(); renderThread(); renderComposer(); }
}

// ── Projects ─────────────────────────────────────────────────────────────────

async function activateProject(id) {
  closeMenus();
  if (id === projectId()) return;
  if (activeProjectRun()) { setBanner('Дождись завершения задачи или останови её, чтобы сменить проект.'); return; }
  try {
    await mutateCoderProject('activate', { projectId: id });
    state.sessionId = null; state.safe.viewing = null; state.review.changes = null; state.review.preview = null;
    await loadCoderOverview();
  } catch (error) { setBanner(messageOf(error)); }
}

async function importProject() {
  closeMenus();
  try {
    const picked = typeof window.monarchDesktop?.pickCoderFolder === 'function'
      ? await window.monarchDesktop.pickCoderFolder() : await promptValue('Полный путь к папке проекта');
    if (!picked) return;
    await mutateCoderProject('import', { path: picked });
    state.sessionId = null; state.review.changes = null;
    await loadCoderOverview();
  } catch (error) {
    if (projectId()) setBanner(messageOf(error));
    else showInline(ui['welcome-error'], messageOf(error));
  }
}

function openCreateDialog() {
  closeMenus();
  ui['create-name'].value = '';
  showInline(ui['create-error'], '');
  ui['create-dialog'].showModal();
  requestAnimationFrame(() => ui['create-name'].focus());
}

async function createProject(event) {
  event.preventDefault();
  const name = ui['create-name'].value.trim();
  if (!name) return;
  try {
    await mutateCoderProject('create', { name });
    ui['create-dialog'].close();
    state.sessionId = null; state.review.changes = null;
    await loadCoderOverview();
  } catch (error) { showInline(ui['create-error'], messageOf(error)); }
}

// ── Conversations ────────────────────────────────────────────────────────────

function newSession() {
  state.sessionId = null; state.safe.viewing = null;
  // A new conversation starts on the model the person chose last, not on the
  // one an older conversation they just looked at happened to use.
  let chosen = '';
  try { chosen = localStorage.getItem(MODEL_KEY) || ''; } catch { /* storage is a convenience */ }
  if (state.models.some(model => model.id === chosen)) state.model = chosen;
  if (narrow()) setRail(false);
  render();
  ui.input.focus();
}

function openSession(id) {
  state.sessionId = id; state.safe.viewing = null;
  adoptSessionModel();
  if (narrow()) setRail(false);
  render();
  scrollToEnd(true);
  for (const run of currentRuns()) if (isCoderRunActive(run) || run.agentQuestion || run.agentApproval) follow(run.id);
}

/** Follow-ups continue on the model the conversation used, when it is still offered. */
function adoptSessionModel() {
  const runs = currentRuns();
  const last = runs.filter(run => run.status !== 'cancelled').at(-1) ?? runs.at(-1);
  if (last && state.models.some(model => model.id === last.model)) state.model = last.model;
}

function chooseModel(id) {
  if (!state.models.some(model => model.id === id)) return;
  state.model = id;
  try { localStorage.setItem(MODEL_KEY, id); } catch { /* convenience */ }
  closeMenus();
  renderComposer();
  ui.input.focus();
}

async function send() {
  const prompt = ui.input.value.trim();
  if (!prompt || state.submitting || !projectId() || state.safe.viewing) return;
  // While Coder waits for an answer, what the person types here is that answer
  // (as in Oscar chat): it used to be refused as a second task, so the reply
  // had to be retyped in the card and sent with its button.
  const asking = pendingQuestionRun();
  if (asking) {
    if (await answerQuestion(asking.id, ui.input.value)) { ui.input.value = ''; growInput(); renderComposer(); }
    return;
  }
  if (activeProjectRun()) { setBanner('В проекте уже идёт задача. Дождись её или останови.'); return; }
  if (!state.models.some(model => model.id === state.model)) {
    setBanner('Нет доступной модели. Подключи сервис в Настройки → MAX или скачай модель Coder в Настройки → Модели.');
    return;
  }
  const request = state.request?.prompt === prompt && state.request.sessionId === state.sessionId
    && state.request.model === state.model ? state.request
    : { id: `cdr_${crypto.randomUUID().replace(/-/gu, '')}`, prompt, model: state.model, sessionId: state.sessionId };
  state.request = request;
  state.submitting = true;
  renderComposer(); renderHead(); renderThread();
  try {
    // A local model needs the memory the idle neural voice holds.
    if (state.models.find(model => model.id === request.model)?.source === 'local'
      && typeof window.monarchDesktop?.releaseSpeechOutput === 'function') {
      await window.monarchDesktop.releaseSpeechOutput().catch(() => undefined);
    }
    let payload;
    try {
      payload = await startCoderRun(prompt, projectId(), request.model, request.id, request.sessionId || undefined);
    } catch (error) {
      // The request identity makes a retry after a lost response return the same run.
      if (!(error instanceof TypeError)) throw error;
      payload = await startCoderRun(prompt, projectId(), request.model, request.id, request.sessionId || undefined);
    }
    const run = payload.run;
    upsertRun(run);
    state.sessionId = run.sessionId || run.id;
    state.request = null;
    ui.input.value = '';
    growInput();
    state.banner = '';
    follow(run.id);
  } catch (error) {
    setBanner(messageOf(error));
  } finally {
    state.submitting = false;
    render();
    scrollToEnd(true);
  }
}

async function stop() {
  const run = currentRuns().find(isCoderRunActive);
  if (!run || run.cancelled || state.stopping) return;
  state.stopping = run.id;
  renderComposer();
  try { const payload = await cancelCoderRun(run.id); if (payload?.run && upsertRun(payload.run)) onRunChanged(payload.run); }
  catch (error) { setBanner(messageOf(error)); }
  finally { state.stopping = ''; renderComposer(); }
}

async function deleteSession() {
  const runs = currentRuns();
  if (!runs.length || state.safe.viewing) return;
  if (runs.some(isCoderRunActive)) { setBanner('Сначала останови задачу.'); return; }
  if (!await confirmAction(`Удалить разговор «${coderTitle(runs[0].prompt)}» и его журнал? Файлы проекта останутся как есть.`)) return;
  try {
    for (const run of runs) await deleteCoderRun(run.id);
    state.runs = state.runs.filter(run => !runs.includes(run));
    state.sessionId = null;
    render();
  } catch (error) { setBanner(messageOf(error)); }
}

// ── Thread interactions ──────────────────────────────────────────────────────

function handleThreadClick(event) {
  const step = event.target.closest('[data-step-toggle]');
  if (step) {
    const id = step.dataset.stepToggle;
    if (state.expandedSteps.has(id)) state.expandedSteps.delete(id); else state.expandedSteps.add(id);
    renderThread({ keepScroll: true });
    return;
  }
  const group = event.target.closest('[data-steps-toggle]');
  if (group) {
    const id = group.dataset.stepsToggle;
    if (state.expandedRuns.has(id)) state.expandedRuns.delete(id); else state.expandedRuns.add(id);
    renderThread({ keepScroll: true });
    return;
  }
  const file = event.target.closest('[data-open-change]');
  if (file) { state.review.expanded.add(file.dataset.openChange); setReview(true, 'changes'); return; }
  const approval = event.target.closest('[data-approval]');
  if (approval) { void settleApproval(approval.dataset.approval, approval.dataset.runId); return; }
  const retry = event.target.closest('[data-retry]');
  if (retry) { const run = state.runs.find(entry => entry.id === retry.dataset.retry); if (run) { ui.input.value = run.prompt; growInput(); void send(); } return; }
  const resume = event.target.closest('[data-resume]');
  if (resume) { void resumeRun(resume.dataset.resume); return; }
  const starter = event.target.closest('[data-starter]');
  if (starter) { ui.input.value = starter.dataset.starter; growInput(); renderComposer(); ui.input.focus(); ui.input.setSelectionRange(ui.input.value.length, ui.input.value.length); }
}

function handleThreadSubmit(event) {
  const form = event.target.closest('[data-question-run]');
  if (!form) return;
  event.preventDefault();
  void answerQuestion(form.dataset.questionRun, form.querySelector('textarea')?.value || '');
}

async function settleApproval(decision, runId) {
  const run = state.runs.find(entry => entry.id === runId);
  const approval = run?.agentApproval;
  if (!approval || !run.agentTaskId || state.approvalBusy) return;
  state.approvalBusy = runId;
  renderThread({ keepScroll: true });
  const binding = { canonicalProposalHash: String(approval.canonicalProposalHash || ''), capabilityId: String(approval.capabilityId || '') };
  try {
    if (decision === 'approve') await armAgentTaskApproval(run.agentTaskId, approval.id, binding);
    await resolveAgentTaskApproval(run.agentTaskId, approval.id, decision === 'approve' ? 'approve' : 'deny', 'once', binding);
    const payload = await fetchCoderRun(runId);
    if (payload?.run && upsertRun(payload.run)) onRunChanged(payload.run);
    follow(runId);
  } catch (error) { setBanner(messageOf(error)); }
  finally { state.approvalBusy = ''; renderThread({ keepScroll: true }); }
}

/** true when the answer was handed over. */
async function answerQuestion(runId, text) {
  const run = state.runs.find(entry => entry.id === runId);
  const question = run?.agentQuestion;
  const reply = String(text || '');
  if (!question || !reply.trim() || state.questionBusy) return false;
  if (new TextEncoder().encode(reply).byteLength > 4096) { setBanner('Ответ должен занимать не больше 4096 байт.'); return false; }
  state.questionBusy = runId;
  renderThread({ keepScroll: true });
  renderComposer();
  try {
    const payload = await submitCoderReply(runId, question.id, question.digest, reply);
    state.questionDrafts.delete(runId);
    if (payload?.run && upsertRun(payload.run)) onRunChanged(payload.run);
    follow(runId);
    return true;
  } catch (error) { setBanner(messageOf(error)); return false; }
  finally { state.questionBusy = ''; renderThread({ keepScroll: true }); renderComposer(); }
}

/** The run of this conversation that waits for the person's answer. */
function pendingQuestionRun() {
  return currentRuns().find(run => run.agentQuestion) ?? null;
}

async function resumeRun(runId) {
  try {
    const payload = await resumeCoderRun(runId);
    if (payload?.run && upsertRun(payload.run)) onRunChanged(payload.run);
    follow(runId);
  } catch (error) { setBanner(messageOf(error)); }
}

// ── Review panel ─────────────────────────────────────────────────────────────

function toggleReview(tab) {
  if (state.review.open && state.review.tab === tab) setReview(false);
  else setReview(true, tab);
}

function setReview(open, tab = state.review.tab) {
  state.review.open = open;
  state.review.tab = tab;
  if (open && narrow()) setRail(false);
  renderReview();
  syncLayout();
  renderHead();
  if (open && tab === 'changes') void loadChanges();
}

async function loadChanges() {
  const id = projectId();
  if (!id || state.review.loading) return;
  state.review.loading = true; state.review.error = '';
  renderReview();
  try {
    const payload = await fetchCoderChanges(id);
    if (id === projectId()) state.review.changes = payload.changes;
  } catch (error) { state.review.error = messageOf(error); }
  finally { state.review.loading = false; renderReview(); renderHead(); }
}

async function readProjectFile(filePath) {
  const payload = await executeCapability('coder', 'coder.files.read', { projectId: projectId(), path: filePath, maxBytes: 262144 },
    'coder-ui', false, '', { includeState: false });
  if (!payload.result?.ok) throw new Error(payload.result?.summary || 'Файл не прочитан.');
  return String(payload.result.output?.content ?? '');
}

function handleReviewClick(event) {
  const change = event.target.closest('[data-change-path]');
  if (change) {
    const target = change.dataset.changePath;
    if (state.review.expanded.has(target)) state.review.expanded.delete(target); else state.review.expanded.add(target);
    renderReview();
    return;
  }
  const file = event.target.closest('[data-file-path]');
  if (file) { void previewFile(file.dataset.filePath); return; }
  if (event.target.closest('[data-preview-close]')) { state.review.preview = null; renderReview(); return; }
  if (event.target.closest('[data-refresh-changes]')) void loadChanges();
}

async function previewFile(filePath) {
  state.review.preview = { path: filePath, content: null, error: '' };
  renderReview();
  try { state.review.preview = { path: filePath, content: await readProjectFile(filePath), error: '' }; }
  catch (error) { state.review.preview = { path: filePath, content: null, error: messageOf(error) }; }
  renderReview();
}

// ── Safe ─────────────────────────────────────────────────────────────────────

async function loadSafeChats() {
  const bridge = window.monarchDesktop;
  if (typeof bridge?.getSafeChatStatus !== 'function' || typeof bridge?.listSafeChats !== 'function') return;
  try {
    const status = await bridge.getSafeChatStatus();
    state.safe.unlocked = status?.unlocked === true;
    state.safe.chats = state.safe.unlocked
      ? ((await bridge.listSafeChats())?.chats ?? []).filter(chat => chat?.kind === 'coder') : [];
  } catch { state.safe.unlocked = false; state.safe.chats = []; }
  renderSessions();
}

async function moveSessionToSafe() {
  const runs = currentRuns();
  const bridge = window.monarchDesktop;
  if (!runs.length || state.safe.viewing || state.safe.busy) return;
  if (runs.some(isCoderRunActive)) { setBanner('Сначала дождись завершения задачи.'); return; }
  if (typeof bridge?.writeSafeChat !== 'function' || typeof bridge?.deleteSafeChat !== 'function') {
    setBanner('Перенос в Safe доступен в Monarch Desktop.'); return;
  }
  state.safe.busy = true;
  try {
    if ((await bridge.getSafeChatStatus())?.unlocked !== true) {
      await bridge.openSafe?.();
      throw new Error('Разблокируй Monarch Safe и повтори перенос.');
    }
    if (!await confirmAction('Перенести разговор в Monarch Safe? Открытый журнал Coder будет удалён после проверки записи.')) return;
    for (const run of runs) {
      const stored = await bridge.writeSafeChat({ version: 1, id: run.id, kind: 'coder', title: coderTitle(run.prompt),
        createdAt: run.createdAt, updatedAt: run.updatedAt,
        messages: [{ id: `${run.id}:prompt`, role: 'user', content: String(run.prompt || '') },
          ...(run.events || []).map(event => ({ id: event.id,
            role: event.kind === 'tool-start' || event.kind === 'tool-result' ? 'tool' : 'assistant',
            content: `${event.title}\n${event.detail}`.trim() }))],
        run });
      if (stored?.verified !== true) throw new Error('Safe не подтвердил запись разговора.');
      try {
        const removed = await deleteCoderRun(run.id);
        if (removed?.deleted !== run.id) throw new Error('Не удалось подтвердить удаление журнала.');
      } catch (error) { await bridge.deleteSafeChat(run.id, 'coder').catch(() => undefined); throw error; }
      state.runs = state.runs.filter(entry => entry.id !== run.id);
    }
    state.sessionId = null;
    await loadSafeChats();
  } catch (error) { setBanner(messageOf(error)); }
  finally { state.safe.busy = false; render(); }
}

async function openSafeChat(id) {
  if (typeof window.monarchDesktop?.readSafeChat !== 'function') return;
  try {
    const run = (await window.monarchDesktop.readSafeChat(id, 'coder'))?.record?.run;
    if (!run || run.id !== id || !Array.isArray(run.events)) throw new Error('Запись Coder в Safe повреждена.');
    state.safe.viewing = structuredClone(run);
    state.sessionId = null;
    if (narrow()) setRail(false);
    render();
  } catch (error) { setBanner(messageOf(error)); }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  if (!ui.root) return;
  const hasProject = Boolean(state.snapshot?.project);
  const loaded = Boolean(state.overview);
  ui.root.dataset.state = !loaded ? 'loading' : hasProject ? 'workspace' : 'welcome';
  ui.welcome.hidden = !loaded || hasProject;
  renderProject();
  renderSessions();
  renderHead();
  renderThread();
  renderComposer();
  renderReview();
  syncLayout();
}

function renderProject() {
  const project = state.snapshot?.project;
  ui['project-name'].textContent = project?.name || 'Проект не выбран';
  ui['project-path'].textContent = project?.root || '';
  ui['project-button'].title = project?.root || '';
  const topbarProject = ui.topbarTitle?.querySelector('span');
  if (topbarProject) topbarProject.textContent = project ? `· ${project.name}` : '';
  const projects = state.overview?.projects?.projects ?? [];
  ui['project-list'].replaceChildren(...projects.map(entry => {
    const button = el('button', 'cdr-menu-item', '', { type: 'button', role: 'menuitemradio', 'data-project-id': entry.id,
      'aria-checked': String(entry.id === project?.id) });
    button.append(el('strong', '', entry.name), el('small', '', entry.root));
    return button;
  }));
  if (!projects.length) ui['project-list'].append(el('p', 'cdr-menu-empty', 'Проектов пока нет'));
}

function renderSessions() {
  const query = state.search.trim().toLocaleLowerCase('ru');
  const sessions = projectSessions().filter(session => !query || session.title.toLocaleLowerCase('ru').includes(query));
  const nodes = [];
  let group = '';
  for (const session of sessions) {
    const label = coderSessionGroup(session.updatedAt);
    if (label !== group) { group = label; nodes.push(el('h3', 'cdr-group', label)); }
    const button = el('button', 'cdr-session', '', { type: 'button', 'data-session-id': session.id,
      'aria-current': session.id === state.sessionId && !state.safe.viewing ? 'true' : 'false' });
    const mark = el('span', 'cdr-mark', '', { 'aria-hidden': 'true' });
    mark.dataset.state = session.active ? 'running' : session.attention ? 'attention' : session.status === 'completed' ? 'done' : 'idle';
    if (session.active) mark.append(el('span', 'spinner', '', { 'aria-label': 'Идёт работа' }));
    button.append(mark, el('span', 'cdr-session-title', session.title), el('time', 'cdr-session-time', relativeTime(session.updatedAt)));
    button.title = session.title;
    nodes.push(button);
  }
  if (!sessions.length) {
    nodes.push(el('p', 'cdr-rail-empty', query ? 'Ничего не нашлось.' : 'Разговоров пока нет. Опиши задачу — Coder начнёт работу.'));
  }
  if (state.safe.unlocked && state.safe.chats.length) {
    nodes.push(el('h3', 'cdr-group', 'В Safe'));
    for (const chat of state.safe.chats.slice(0, 30)) {
      const button = el('button', 'cdr-session', '', { type: 'button', 'data-safe-id': chat.id,
        'aria-current': state.safe.viewing?.id === chat.id ? 'true' : 'false' });
      const mark = el('span', 'cdr-mark', '', { 'aria-hidden': 'true' }); mark.dataset.state = 'safe';
      button.append(mark, el('span', 'cdr-session-title', chat.title || 'Разговор'), el('time', 'cdr-session-time', relativeTime(chat.updatedAt)));
      nodes.push(button);
    }
  }
  ui.sessions.replaceChildren(...nodes);
  const git = state.snapshot?.git;
  ui['rail-foot'].replaceChildren(el('span', 'cdr-branch', git?.repository ? `⎇ ${git.branch || 'без ветки'}` : 'Без Git'));
}

function renderHead() {
  const runs = currentRuns();
  const last = runs.at(-1) ?? null;
  const view = coderRunState(last, { submitting: state.submitting, disconnected: last ? state.disconnected.has(last.id) : false });
  ui['session-title'].textContent = state.safe.viewing ? `${coderTitle(state.safe.viewing.prompt)} · Safe`
    : runs.length ? coderTitle(runs[0].prompt) : state.submitting ? coderTitle(state.request?.prompt) : 'Новый разговор';
  ui.state.textContent = runs.length || state.submitting ? view.label : '';
  ui.state.dataset.stage = view.stage;
  const changes = state.review.changes?.files?.length ?? 0;
  ui['changes-count'].hidden = !changes;
  ui['changes-count'].textContent = String(changes);
  ui['open-changes'].setAttribute('aria-expanded', String(state.review.open && state.review.tab === 'changes'));
  ui['open-files'].setAttribute('aria-expanded', String(state.review.open && state.review.tab === 'files'));
  const railShown = ui.root.dataset.rail === 'true';
  ui['rail-toggle'].setAttribute('aria-expanded', String(railShown));
  ui['rail-toggle'].setAttribute('aria-label', railShown ? 'Скрыть разговоры' : 'Показать разговоры');
  ui['safe-move'].disabled = !runs.length || Boolean(state.safe.viewing) || runs.some(isCoderRunActive);
  ui['session-delete'].disabled = ui['safe-move'].disabled;
  ui.banner.hidden = !state.banner;
  ui.banner.textContent = state.banner;
}

function renderComposer() {
  const active = currentRuns().find(isCoderRunActive);
  const busyElsewhere = !active && activeProjectRun();
  const shown = active ? active.model : state.model;
  const model = state.models.find(entry => entry.id === shown)
    ?? (active ? { id: shown, label: modelLabel(shown), source: String(shown).startsWith('max') ? 'max' : 'local' } : undefined);
  ui['model-label'].textContent = model ? model.label : state.models.length ? 'Выбери модель' : 'Нет модели';
  ui['model-kind'].textContent = model?.source === 'max' ? 'MAX' : model ? 'Локально' : '';
  ui['model-kind'].hidden = !model;
  ui['model-button'].disabled = Boolean(active) || state.submitting;
  renderModelMenu();
  const blocked = !projectId() || Boolean(state.safe.viewing);
  const asking = pendingQuestionRun();
  ui.input.disabled = blocked || Boolean(asking && state.questionBusy === asking.id);
  ui.input.placeholder = state.safe.viewing ? 'Разговор из Safe открыт только для чтения'
    : asking ? 'Ответь на вопрос Coder'
    : currentRuns().length ? 'Продолжи разговор: уточни, поправь или дай следующую задачу' : 'Опиши задачу для проекта';
  ui.send.hidden = Boolean(active) && !asking;
  ui.stop.hidden = !active;
  ui.stop.disabled = Boolean(active?.cancelled) || state.stopping === active?.id;
  ui.stop.setAttribute('aria-label', ui.stop.disabled ? 'Останавливаю…' : 'Остановить');
  ui.send.disabled = blocked || state.submitting || !ui.input.value.trim() || (asking
    ? state.questionBusy === asking.id
    : Boolean(busyElsewhere) || !state.models.some(entry => entry.id === state.model));
  ui.send.setAttribute('aria-label', asking ? 'Ответить Coder' : 'Отправить');
  ui.send.classList.toggle('is-sending', state.submitting);
  ui.hint.textContent = asking ? 'Enter — ответить · Shift Enter — строка'
    : busyElsewhere ? 'В проекте идёт задача в другом разговоре'
    : !state.models.length ? 'Подключи MAX или скачай модель Coder в Настройки → Модели' : 'Enter — отправить · Shift Enter — строка';
}

function renderModelMenu() {
  const nodes = [];
  const groups = [['max', 'MAX'], ['local', 'На этом компьютере']];
  for (const [source, title] of groups) {
    const models = state.models.filter(model => model.source === source);
    if (!models.length) continue;
    nodes.push(el('span', 'cdr-menu-label', title));
    for (const model of models) {
      const option = el('button', 'cdr-menu-item cdr-model-option', '', { type: 'button', role: 'option',
        'data-model-id': model.id, 'aria-selected': String(model.id === state.model) });
      option.append(el('strong', '', model.label), el('small', '', source === 'max' ? model.provider || 'Облачный сервис' : 'Локальная модель'));
      nodes.push(option);
    }
  }
  if (!state.models.length) nodes.push(el('p', 'cdr-menu-empty', state.overview?.runtime?.reason || 'Модели для задач не подключены.'));
  nodes.push(el('hr'));
  // Without a local Coder model the menu offers the download right here.
  if (!state.models.some(model => model.source === 'local')) {
    nodes.push(el('button', 'cdr-menu-item', 'Скачать модель Coder…', { type: 'button', 'data-open-models': '' }));
  }
  nodes.push(el('button', 'cdr-menu-item', 'Настроить MAX…', { type: 'button', 'data-open-max': '' }));
  ui['model-menu'].replaceChildren(...nodes);
}

function renderThread(options = {}) {
  const scroller = ui.scroll;
  const nearEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const runs = currentRuns();
  const nodes = [];
  if (!runs.length && !state.submitting) nodes.push(emptyState());
  for (const run of runs) {
    nodes.push(userMessage(run.prompt, run.id), turn(run));
  }
  if (state.submitting && state.request) {
    nodes.push(userMessage(state.request.prompt, 'pending'), pendingTurn());
  }
  const focused = document.activeElement?.closest?.('[data-question-run]') && document.activeElement.tagName === 'TEXTAREA'
    ? { runId: document.activeElement.closest('[data-question-run]').dataset.questionRun,
      start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
    : null;
  ui.thread.replaceChildren(...nodes);
  ui.thread.dataset.empty = String(!runs.length && !state.submitting);
  if (!options.keepScroll && nearEnd) scrollToEnd(false);
  const field = (runId) => ui.thread.querySelector(`[data-question-run="${CSS.escape(runId)}"] textarea`);
  if (focused) {
    const restored = field(focused.runId);
    if (restored && !restored.disabled) { restored.focus({ preventScroll: true }); restored.setSelectionRange(focused.start, focused.end); }
    return;
  }
  const asking = pendingQuestionRun();
  const questionKey = asking ? `${asking.id}:${asking.agentQuestion.id}` : '';
  if (questionKey && questionKey !== state.focusedQuestion) {
    state.focusedQuestion = questionKey;
    // Only when the person is not typing somewhere else.
    const typing = document.activeElement && document.activeElement !== document.body
      && document.activeElement !== ui.input && /^(INPUT|TEXTAREA|SELECT)$/u.test(document.activeElement.tagName);
    const target = ui.input.value.trim() ? null : field(asking.id);
    if (!typing && target && !target.disabled && !ui.root.hidden) target.focus({ preventScroll: true });
  }
}

function emptyState() {
  const project = state.snapshot?.project;
  const box = el('section', 'cdr-empty');
  box.append(el('span', 'cdr-kicker', project?.name || 'Coder'), el('h2', '', 'Что сделаем в проекте?'),
    el('p', '', 'Coder прочитает нужные файлы, внесёт правки и запустит проверки. Каждое действие видно здесь, а изменения — в панели справа.'));
  const starters = el('div', 'cdr-starters');
  for (const [label, text] of [
    ['Разобраться в проекте', 'Изучи проект и коротко объясни, как он устроен: главные части, точки входа, как запустить и проверить.'],
    ['Найти и исправить ошибку', 'Найди причину проблемы: '],
    ['Добавить функцию', 'Добавь в проект: '],
    ['Запустить проверки', 'Найди и запусти тесты и проверки проекта, затем расскажи, что не проходит и почему.'],
  ]) starters.append(el('button', 'cdr-starter', label, { type: 'button', 'data-starter': text }));
  box.append(starters);
  return box;
}

function userMessage(text, id) {
  const node = el('div', 'cdr-user');
  node.append(el('p', '', text));
  enter(node, `user:${id}`);
  return node;
}

function pendingTurn() {
  const node = el('article', 'cdr-turn');
  node.dataset.state = 'starting';
  node.append(turnHeader(state.models.find(model => model.id === state.request?.model)?.label || ''),
    workingLine('Отправляю задачу…', null));
  return node;
}

function turnHeader(modelLabel, run = null) {
  const header = el('header', 'cdr-turn-head');
  header.append(el('span', 'cdr-avatar', '', { 'aria-hidden': 'true' }), el('strong', '', 'Coder'));
  if (modelLabel) header.append(el('span', 'cdr-turn-model', modelLabel));
  if (run?.finishedAt && run.startedAt) header.append(el('span', 'cdr-turn-time', duration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))));
  return header;
}

function turn(run) {
  const node = el('article', 'cdr-turn');
  const view = coderRunState(run, { disconnected: state.disconnected.has(run.id) });
  node.dataset.state = view.stage;
  node.append(turnHeader(modelLabel(run.model), run));
  const steps = coderSteps(run);
  const active = isCoderRunActive(run);
  if (steps.length) {
    const list = el('ol', 'cdr-steps');
    const collapsed = !active && steps.length > STEP_COLLAPSE_AT && !state.expandedRuns.has(run.id);
    if (collapsed) {
      const changed = coderChangedFiles(run).length;
      const failed = steps.filter(step => step.state === 'failed').length;
      const summary = el('button', 'cdr-steps-summary', '', { type: 'button', 'data-steps-toggle': run.id, 'aria-expanded': 'false' });
      summary.append(el('span', 'cdr-mark', '', { 'data-state': failed ? 'attention' : 'done', 'aria-hidden': 'true' }),
        el('span', '', `${plural(steps.length, 'действие', 'действия', 'действий')}${changed ? ` · ${plural(changed, 'файл изменён', 'файла изменено', 'файлов изменено')}` : ''}${failed ? ` · ${plural(failed, 'неудача', 'неудачи', 'неудач')}` : ''}`),
        chevron());
      node.append(summary);
    } else {
      for (const step of steps) list.append(stepItem(step));
      if (!active && steps.length > STEP_COLLAPSE_AT) {
        node.append(el('button', 'cdr-steps-summary is-open', 'Свернуть шаги', { type: 'button', 'data-steps-toggle': run.id, 'aria-expanded': 'true' }));
      }
      node.append(list);
    }
  }
  if (run.agentApproval) node.append(approvalCard(run));
  if (run.agentQuestion) node.append(questionCard(run));
  if (active && !run.agentApproval && !run.agentQuestion) {
    const current = steps.at(-1);
    const label = run.cancelled ? 'Останавливаю…' : state.disconnected.has(run.id) ? 'Восстанавливаю связь…'
      : run.status === 'queued' ? 'Готовлю задачу…' : current?.state === 'running' ? `${current.label}…` : 'Думаю над следующим шагом…';
    node.append(workingLine(label, run));
  }
  if (run.status === 'completed' && run.answer) {
    const answer = el('div', 'cdr-answer oscar-message-content');
    answer.innerHTML = formatOscarContent(run.answer);
    node.append(answer);
    const evidenceNote = coderEvidenceNote(run);
    if (evidenceNote) node.append(el('p', 'cdr-quiet cdr-evidence-note', evidenceNote));
  }
  if (run.status === 'failed') node.append(noticeCard('Не получилось завершить', run.error || 'Причина не сохранена.', [['Повторить', { 'data-retry': run.id }]]));
  if (run.status === 'interrupted') node.append(noticeCard('Работа прервалась', run.error || 'Задачу можно продолжить с того же места.', [['Продолжить', { 'data-resume': run.id }]]));
  if (run.status === 'cancelled') node.append(el('p', 'cdr-quiet', 'Остановлено. Уже сделанные изменения остались в проекте.'));
  if (!active) {
    const footer = turnFooter(run);
    if (footer) node.append(footer);
  }
  enter(node, `turn:${run.id}`);
  return node;
}

function stepItem(step) {
  const item = el('li', 'cdr-step');
  item.dataset.state = step.state;
  if (step.note) item.append(el('p', 'cdr-step-note', step.note));
  const detail = step.state === 'running' ? null : coderStepDetail(step);
  const expandable = Boolean(detail || step.thought);
  const open = expandable && state.expandedSteps.has(step.id);
  const row = el(expandable ? 'button' : 'div', 'cdr-step-row', '', expandable
    ? { type: 'button', 'data-step-toggle': step.id, 'aria-expanded': String(open) } : {});
  const mark = el('span', 'cdr-mark', '', { 'aria-hidden': 'true', 'data-state': step.state === 'running' ? 'running' : step.state === 'failed' ? 'attention' : 'done' });
  if (step.state === 'running') mark.append(el('span', 'spinner', '', { 'aria-label': 'Выполняется' }));
  row.append(mark, el('span', 'cdr-step-label', step.label));
  if (step.target) row.append(el('code', 'cdr-step-target', step.target));
  if (step.exitCode !== undefined && step.exitCode !== 0) row.append(el('span', 'cdr-step-meta', `код ${step.exitCode}`));
  if (expandable) row.append(chevron());
  item.append(row);
  if (open) {
    const body = el('div', 'cdr-step-detail');
    if (step.thought) body.append(el('p', 'cdr-thought', step.thought));
    if (detail?.kind === 'code') body.append(el('pre', '', detail.text));
    else if (detail) body.append(el('p', '', detail.text));
    item.append(body);
  }
  return item;
}

function workingLine(label, run) {
  const line = el('div', 'cdr-working', '', { role: 'status' });
  line.append(el('span', 'spinner cdr-working-spinner', '', { 'aria-hidden': 'true' }), el('span', '', label));
  if (run?.startedAt || run?.createdAt) {
    const clock = el('time', 'cdr-clock');
    clock.dataset.since = run.startedAt || run.createdAt;
    clock.textContent = duration(Date.now() - Date.parse(clock.dataset.since));
    line.append(clock);
  }
  return line;
}

function approvalCard(run) {
  const approval = run.agentApproval;
  const card = el('section', 'cdr-card cdr-approval', '', { 'aria-label': 'Нужно разрешение' });
  card.append(el('span', 'cdr-kicker', 'Нужно твоё разрешение'), el('p', 'cdr-card-text', approval.reason || 'Coder просит выполнить действие.'));
  const args = approval.proposal?.args ?? {};
  const target = typeof args.path === 'string' ? args.path : typeof args.executable === 'string'
    ? [args.executable, ...(Array.isArray(args.args) ? args.args : [])].join(' ') : '';
  if (target) card.append(el('code', 'cdr-approval-target', coderRelativePath(target, run.projectRoot)));
  const diff = approvalDiff(run);
  if (diff) card.append(diff);
  const busy = state.approvalBusy === run.id;
  const actions = el('div', 'cdr-card-actions');
  actions.append(el('button', 'cdr-secondary', 'Отклонить', { type: 'button', 'data-approval': 'deny', 'data-run-id': run.id, ...(busy ? { disabled: '' } : {}) }),
    el('button', 'cdr-primary', busy ? 'Проверяю…' : 'Разрешить один раз', { type: 'button', 'data-approval': 'approve', 'data-run-id': run.id, 'data-pp-burst': '', ...(busy ? { disabled: '' } : {}) }));
  card.append(actions);
  return card;
}

function approvalDiff(run) {
  const approval = run.agentApproval;
  const capabilityId = approval?.capabilityId;
  const args = approval?.proposal?.args ?? {};
  if (!['coder.files.write', 'coder.files.patch'].includes(capabilityId) || typeof args.path !== 'string') return null;
  const key = `${approval.id}:${approval.canonicalProposalHash}`;
  const cached = state.approvalDiffs.get(key);
  if (cached) return cached.cloneNode(true);
  const slot = el('div', 'cdr-approval-diff', 'Готовлю сравнение…');
  void (async () => {
    let current = null;
    try { current = await readProjectFile(args.path); }
    catch { current = capabilityId === 'coder.files.write' ? '' : null; }
    const proposed = coderProposedContent(capabilityId, args, current);
    const rows = proposed === null || current === null ? null : coderLineDiff(current, proposed);
    const view = rows ? renderCoderDiff(coderRelativePath(args.path, run.projectRoot), rows)
      : el('p', 'cdr-quiet', 'Сравнение недоступно: файл большой или уже изменился. Проверь цель перед разрешением.');
    const wrapper = el('div', 'cdr-approval-diff'); wrapper.append(view);
    state.approvalDiffs.set(key, wrapper);
    renderThread({ keepScroll: true });
  })();
  return slot;
}

function questionCard(run) {
  const question = run.agentQuestion;
  const busy = state.questionBusy === run.id;
  const card = el('form', 'cdr-card cdr-question', '', { 'data-question-run': run.id, 'aria-label': 'Вопрос Coder' });
  card.append(el('span', 'cdr-kicker', 'Coder уточняет'), el('p', 'cdr-card-text', question.text));
  const input = el('textarea', '', '', { rows: '2', maxlength: '4096', placeholder: 'Ответь, и Coder продолжит', 'aria-label': 'Ответ для Coder', ...(busy ? { disabled: '' } : {}) });
  input.value = state.questionDrafts.get(run.id) || '';
  const actions = el('div', 'cdr-card-actions');
  actions.append(el('button', 'cdr-primary', busy ? 'Передаю…' : 'Ответить', { type: 'submit', ...(busy ? { disabled: '' } : {}) }));
  card.append(input, actions);
  return card;
}

function noticeCard(title, text, actions) {
  const card = el('section', 'cdr-card cdr-notice');
  card.append(el('strong', '', title), el('p', 'cdr-card-text', text));
  const row = el('div', 'cdr-card-actions');
  for (const [label, attrs] of actions) row.append(el('button', 'cdr-secondary', label, { type: 'button', ...attrs }));
  card.append(row);
  return card;
}

function turnFooter(run) {
  const files = coderChangedFiles(run);
  const checks = coderChecks(run);
  if (!files.length && !checks.length) return null;
  const footer = el('footer', 'cdr-turn-foot');
  if (files.length) {
    const group = el('div', 'cdr-foot-group');
    group.append(el('span', 'cdr-foot-label', plural(files.length, 'изменённый файл', 'изменённых файла', 'изменённых файлов')));
    for (const file of files.slice(0, 8)) group.append(el('button', 'cdr-file-chip', file, { type: 'button', 'data-open-change': file, title: 'Показать изменения' }));
    if (files.length > 8) group.append(el('span', 'cdr-quiet', `и ещё ${files.length - 8}`));
    footer.append(group);
  }
  if (checks.length) {
    const group = el('div', 'cdr-foot-group');
    group.append(el('span', 'cdr-foot-label', 'Проверки'));
    for (const check of checks.slice(0, 6)) {
      const chip = el('span', 'cdr-check', '', { 'data-ok': String(check.ok) });
      chip.append(el('span', 'cdr-mark', '', { 'aria-hidden': 'true', 'data-state': check.ok ? 'done' : 'attention' }),
        el('span', '', `${check.ok ? 'Прошла' : 'Не прошла'}: `), el('code', '', check.command));
      group.append(chip);
    }
    footer.append(group);
  }
  return footer;
}

function renderReview() {
  const open = state.review.open && Boolean(projectId());
  ui.review.hidden = !open;
  ui.root.dataset.review = String(open);
  for (const tab of ui.tabs) tab.setAttribute('aria-selected', String(tab.dataset.cdrTab === state.review.tab));
  if (!open) return;
  if (state.review.preview) { ui['review-body'].replaceChildren(previewView()); return; }
  ui['review-body'].replaceChildren(state.review.tab === 'files' ? filesView() : changesView());
}

function changesView() {
  const box = el('div', 'cdr-changes');
  const changes = state.review.changes;
  const head = el('div', 'cdr-review-sub');
  head.append(el('span', '', changes?.repository ? `Ветка ${changes.branch || '—'}` : 'Рабочая папка'),
    el('button', 'cdr-link', state.review.loading ? 'Обновляю…' : 'Обновить', { type: 'button', 'data-refresh-changes': '', ...(state.review.loading ? { disabled: '' } : {}) }));
  box.append(head);
  if (state.review.error) { box.append(el('p', 'cdr-inline-error', state.review.error)); return box; }
  if (!changes) { box.append(el('p', 'cdr-quiet', 'Загружаю изменения…')); return box; }
  if (!changes.repository) {
    const files = [...new Set(currentRuns().flatMap(coderChangedFiles))];
    box.append(el('p', 'cdr-quiet', 'Проект не под Git, поэтому полного сравнения нет. Вот файлы, которые Coder менял в этом разговоре:'));
    if (!files.length) box.append(el('p', 'cdr-quiet', 'Пока ничего не менялось.'));
    for (const file of files) box.append(el('button', 'cdr-change', file, { type: 'button', 'data-file-path': file }));
    return box;
  }
  if (!changes.files.length) {
    const empty = el('div', 'cdr-review-empty');
    empty.append(el('strong', '', 'Изменений нет'), el('p', '', 'Рабочее дерево совпадает с последним коммитом.'));
    box.append(empty);
    return box;
  }
  const marks = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };
  const titles = { modified: 'изменён', added: 'добавлен', deleted: 'удалён', renamed: 'переименован', untracked: 'новый' };
  for (const file of changes.files) {
    const expanded = state.review.expanded.has(file.path);
    const row = el('button', 'cdr-change', '', { type: 'button', 'data-change-path': file.path, 'aria-expanded': String(expanded) });
    const stats = file.patch ? patchStats(file.patch) : null;
    row.append(el('span', 'cdr-change-mark', marks[file.state] || '•', { title: titles[file.state] || file.state }),
      el('span', 'cdr-change-path', file.path));
    if (stats) row.append(el('span', 'cdr-change-stat', `+${stats.added} −${stats.removed}`));
    row.append(chevron());
    box.append(row);
    if (expanded) box.append(diffView(file));
  }
  if (changes.truncated) box.append(el('p', 'cdr-quiet', 'Показана часть изменений — их слишком много для панели.'));
  return box;
}

function diffView(file) {
  const view = el('div', 'cdr-diff');
  if (file.state === 'untracked' || !file.patch) {
    view.append(el('p', 'cdr-quiet', file.state === 'untracked' ? 'Новый файл — Git его ещё не отслеживает.' : 'Сравнение недоступно.'),
      el('button', 'cdr-link', 'Открыть файл', { type: 'button', 'data-file-path': file.path }));
    return view;
  }
  for (const row of coderPatchRows(file.patch).slice(0, 1500)) {
    if (row.type === 'hunk') { view.append(el('div', 'cdr-diff-hunk', row.text || '···')); continue; }
    const line = el('div', 'cdr-diff-line', '', { 'data-type': row.type });
    line.append(el('span', 'cdr-diff-no', String(row.type === 'del' ? row.oldNo : row.newNo)),
      el('span', 'cdr-diff-sign', row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ', { 'aria-hidden': 'true' }),
      el('code', '', row.text || ' '));
    view.append(line);
  }
  return view;
}

function patchStats(patch) {
  let added = 0, removed = 0;
  for (const row of coderPatchRows(patch)) { if (row.type === 'add') added += 1; else if (row.type === 'del') removed += 1; }
  return { added, removed };
}

function filesView() {
  const box = el('div', 'cdr-files');
  const search = el('input', 'cdr-file-search', '', { type: 'search', placeholder: 'Найти файл', 'data-file-search': '', 'aria-label': 'Найти файл' });
  search.value = state.review.fileQuery;
  box.append(search, el('div', 'cdr-file-list'));
  queueMicrotask(renderFileList);
  return box;
}

function renderFileList() {
  const list = ui['review-body'].querySelector('.cdr-file-list');
  if (!list) return;
  const query = state.review.fileQuery.trim().toLocaleLowerCase('en-US');
  const entries = (state.snapshot?.entries ?? []).filter(entry => entry.type === 'file'
    && (!query || entry.path.toLocaleLowerCase('en-US').includes(query))).slice(0, 400);
  list.replaceChildren(...entries.map(entry => {
    const parts = entry.path.replace(/\\/gu, '/').split('/');
    const button = el('button', 'cdr-file', '', { type: 'button', 'data-file-path': entry.path, title: entry.path });
    button.append(el('span', 'cdr-file-name', parts.at(-1)), el('span', 'cdr-file-dir', parts.slice(0, -1).join('/')));
    return button;
  }));
  if (!entries.length) list.append(el('p', 'cdr-quiet', query ? 'Ничего не нашлось.' : 'Файлов нет.'));
}

function previewView() {
  const preview = state.review.preview;
  const box = el('div', 'cdr-preview');
  const head = el('div', 'cdr-review-sub');
  head.append(el('button', 'cdr-link', '← Назад', { type: 'button', 'data-preview-close': '' }), el('code', 'cdr-preview-path', preview.path));
  box.append(head);
  if (preview.error) box.append(el('p', 'cdr-inline-error', preview.error));
  else if (preview.content === null) box.append(el('p', 'cdr-quiet', 'Читаю файл…'));
  else {
    const pre = el('pre', 'cdr-code');
    const lines = preview.content.split(/\r?\n/u).slice(0, 2000);
    pre.append(...lines.map((text, index) => {
      const line = el('span', 'cdr-code-line');
      line.append(el('span', 'cdr-diff-no', String(index + 1)), el('code', '', text || ' '));
      return line;
    }));
    box.append(pre);
  }
  return box;
}

// ── Layout, menus, small helpers ─────────────────────────────────────────────

function setRail(open) {
  state.railOpen = open;
  if (!narrow()) { try { localStorage.setItem(RAIL_KEY, open ? 'open' : 'closed'); } catch { /* convenience */ } }
  syncLayout();
  renderHead();
}

function syncLayout() {
  if (!ui.root) return;
  const isNarrow = narrow();
  const width = ui.root.clientWidth;
  // Entering a narrow window starts with the conversation, not the drawer.
  if (isNarrow && ui.root.dataset.narrow !== 'true') state.railOpen = false;
  else if (!isNarrow && ui.root.dataset.narrow === 'true') {
    try { state.railOpen = localStorage.getItem(RAIL_KEY) !== 'closed'; } catch { state.railOpen = true; }
  }
  const overlayReview = width < 980;
  const reviewShown = state.review.open && Boolean(projectId());
  // The review panel needs room; the conversation list yields first, without
  // changing the person's saved preference.
  const railShown = state.railOpen && !(reviewShown && !overlayReview && width < 1300);
  ui.root.dataset.rail = String(railShown);
  ui.root.dataset.narrow = String(isNarrow);
  ui.root.dataset.overlayReview = String(overlayReview);
  ui.scrim.hidden = !((isNarrow && state.railOpen) || (overlayReview && reviewShown));
}

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  if (!open) return;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  if (!reducedMotion()) menu.animate?.([{ opacity: 0, transform: 'translateY(4px) scale(.98)' }, { opacity: 1, transform: 'none' }],
    { duration: 160, easing: 'cubic-bezier(.2,0,0,1)' });
  menu.querySelector('[aria-checked="true"], [aria-selected="true"], button:not(:disabled)')?.focus();
}

function closeMenus() {
  let closed = false;
  for (const [button, menu] of [[ui['project-button'], ui['project-menu']], [ui.more, ui['more-menu']], [ui['model-button'], ui['model-menu']]]) {
    if (!menu || menu.hidden) continue;
    menu.hidden = true; button.setAttribute('aria-expanded', 'false'); closed = true;
  }
  return closed;
}

function setBanner(message) { state.banner = message; renderHead(); }

function showInline(node, message) { node.hidden = !message; node.textContent = message; }

function growInput() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 220)}px`;
}

function scrollToEnd(force) {
  requestAnimationFrame(() => {
    const scroller = ui.scroll;
    if (force || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: force || reducedMotion() ? 'auto' : 'smooth' });
    }
  });
}

function renderClocks() {
  for (const clock of ui.thread.querySelectorAll('.cdr-clock[data-since]')) clock.textContent = duration(Date.now() - Date.parse(clock.dataset.since));
}

/** New content arrives from below once; re-renders of the same item stay still. */
function enter(node, key) {
  if (state.renderedTurns.has(key)) return;
  state.renderedTurns.add(key);
  if (!reducedMotion()) node.classList.add('is-entering');
}

function modelLabel(id) {
  const known = state.models.find(model => model.id === id);
  if (known) return known.label;
  const text = String(id || '');
  return text.startsWith('max-cloud:') ? text.split(':').slice(2).join(':') : text;
}

function el(tag, className = '', text = '', attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function chevron() {
  const span = el('span', 'cdr-chevron', '', { 'aria-hidden': 'true' });
  span.innerHTML = CODER_ICONS.chevron;
  return span;
}

function plural(count, one, few, many) {
  const mod10 = count % 10, mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${count} ${word}`;
}

function duration(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} мин ${seconds % 60} с` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function relativeTime(value) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'сейчас';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return new Date(time).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
