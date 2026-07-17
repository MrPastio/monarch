import { notifyStateChange, state, updateState } from './state.js';
import { cancelIntentJob, executeCapability, fetchIntentJob, streamIntentJob, submitIntentJob } from './api.js';
import {
  escapeHtml,
  summarizeOutput,
  miniMeta,
  routeSummaryState,
  confirmationBanner,
  computeInlineDiff,
  statusPill,
  readNumber,
  formatTime,
  formatOscarContent,
  syncThreadDOM
} from './utils.js';

const elements = {
  topStatus: document.querySelector('#top-status'),
  runtimeSummary: document.querySelector('#runtime-summary'),
  routeSummary: document.querySelector('#route-summary'),
  routeTimeline: document.querySelector('#route-timeline'),
  routePill: document.querySelector('#route-pill'),
  thread: document.querySelector('#thread'),
  composer: document.querySelector('#composer'),
  intentInput: document.querySelector('#intent-input'),
};

const intentJobStreamDrafts = new Map();
const activeIntentJobStreams = new Set();

export function initChatPane() {
  if (elements.composer) {
    elements.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitIntentAction(elements.intentInput.value, false);
    });
  }
}

export async function submitIntentAction(text, confirmed, confirmationToken = '') {
  const normalizedText = String(text || '').trim();
  if (!normalizedText || state.busy) {
    return;
  }

  state.pendingIntentText = normalizedText;
  state.currentIntentJob = null;
  setBusy(true);
  try {
    const payload = await submitIntentJob(
      normalizedText,
      confirmed,
      confirmationToken,
      90000,
      readChatModelContext()
    );
    if (!confirmed && elements.intentInput) {
      elements.intentInput.value = '';
    }
    state.currentIntentJob = payload.job || null;
    if (payload.state) {
      updateState(payload.state);
    }
    void startIntentJobStream(payload.job?.id);
    void pollIntentJob(payload.job?.id);
  } catch (error) {
    if (!confirmed && elements.intentInput) {
      elements.intentInput.value = normalizedText;
    }
    const errText = error instanceof Error ? error.message : String(error);
    if (elements.thread) {
      elements.thread.innerHTML = `
        <div class="error-state">
          <strong>Команда не выполнена</strong>
          <p>${escapeHtml(errText)}</p>
        </div>
      `;
    }
    setBusy(false);
  }
}

export async function cancelIntentJobAction() {
  const jobId = state.currentIntentJob?.id;
  if (!jobId) {
    return;
  }
  try {
    const payload = await cancelIntentJob(jobId);
    state.currentIntentJob = payload.job || state.currentIntentJob;
    if (payload.state) {
      updateState(payload.state);
    } else {
      renderThread();
    }
    if (jobId) {
      intentJobStreamDrafts.delete(jobId);
    }
  } catch (error) {
    const errText = error instanceof Error ? error.message : String(error);
    if (elements.thread) {
      elements.thread.insertAdjacentHTML('beforeend', `
        <div class="error-state">
          <strong>Отмена не выполнена</strong>
          <p>${escapeHtml(errText)}</p>
        </div>
      `);
    }
  } finally {
    setBusy(false);
  }
}

async function pollIntentJob(jobId) {
  if (!jobId) {
    setBusy(false);
    return;
  }

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timeout']);
  try {
    while (true) {
      await sleep(700);
      const payload = await fetchIntentJob(jobId);
      state.currentIntentJob = payload.job || state.currentIntentJob;
      if (payload.state) {
        updateState(payload.state);
      } else {
        renderThread();
      }
      if (terminalStatuses.has(state.currentIntentJob?.status)) {
        setBusy(false);
        intentJobStreamDrafts.delete(jobId);
        return;
      }
    }
  } catch (error) {
    const errText = error instanceof Error ? error.message : String(error);
    if (elements.thread) {
      elements.thread.innerHTML = `
        <div class="error-state">
          <strong>Не удалось получить статус задачи</strong>
          <p>${escapeHtml(errText)}</p>
        </div>
      `;
    }
    setBusy(false);
  }
}

async function startIntentJobStream(jobId) {
  if (!jobId || activeIntentJobStreams.has(jobId)) {
    return;
  }

  activeIntentJobStreams.add(jobId);
  let draft = '';
  let lastRenderAt = 0;
  try {
    const stream = await streamIntentJob(jobId);
    for await (const event of stream) {
      if (event.type !== 'token') {
        continue;
      }
      const token = typeof event.data?.token === 'string' ? event.data.token : '';
      if (!token) {
        continue;
      }
      draft += token;
      intentJobStreamDrafts.set(jobId, draft);
      const now = Date.now();
      if (state.currentIntentJob?.id === jobId && now - lastRenderAt > 50) {
        renderThread();
        lastRenderAt = now;
      }
    }
  } catch {
    // Polling still delivers the final job result if the live stream is unavailable.
  } finally {
    activeIntentJobStreams.delete(jobId);
  }
}

function setBusy(isBusy) {
  state.busy = isBusy;
  if (elements.composer) {
    elements.composer.setAttribute('aria-busy', String(isBusy));
    const button = elements.composer.querySelector('button[type="submit"]');
    if (button) {
      button.disabled = isBusy;
      const labelSpan = button.querySelector('span:last-child');
      if (labelSpan) {
        labelSpan.textContent = isBusy ? 'Выполняю' : 'Отправить';
      }
    }
  }
  notifyStateChange();
}

function readChatModelContext() {
  const deepThinking = state.chat?.deepThinking || 'none';
  const modelSelection = state.chat?.modelSelection || 'auto';
  const modelOverride = deepThinking !== 'none'
    ? deepThinking
    : modelSelection !== 'auto'
      ? modelSelection
      : '';
  return modelOverride ? {
    model_override: modelOverride,
    ...(deepThinking !== 'none' ? { deep_thinking_consent: 'allow' } : {}),
  } : {};
}

export function renderChatPane() {
  if (!state.data) {
    return;
  }

  renderTopStatus();
  renderRuntimeSummary();
  renderRouteSummary();
  renderRouteTimeline();

  // New Claude-style Center page rendering
  renderComposerStatusBar();
  renderRecentActivityList();
  renderLogsPage();

  renderThread();
}

function renderTopStatus() {
  if (!elements.topStatus) return;
  const healthOk = Boolean(state.data.runtime.health.ok);
  const selected = state.data.selectedModel;
  const selectedRuntime = state.data.modelRuntime.entries.find((entry) => entry.role === selected.role);
  const routerRuntime = state.data.modelRuntime.entries.find((entry) => entry.role === 'router');

  elements.topStatus.innerHTML = [
    statusPill(healthOk ? 'Ядро активно' : 'Ядро требует внимания', healthOk ? 'green' : 'red'),
    statusPill(
      `${selected.label} · ${selectedRuntime?.canInfer ? 'готова' : routerRuntime?.canInfer ? 'маршрутизация готова' : 'ожидает'}`,
      selectedRuntime?.canInfer ? 'green' : selected.available ? 'amber' : 'red',
    ),
  ].join('');
}

function renderRuntimeSummary() {
  if (!elements.runtimeSummary) return;
  const modules = state.data.runtime.snapshot.modules || [];
  const diagnostics = state.data.runtime.diagnostics || {};
  const queue = diagnostics.queue || {};
  const active = modules.filter((record) => record.status === 'active').length;
  const queueLoad = readNumber(queue.queued, 0) + readNumber(queue.running, 0);
  const healthOk = Boolean(state.data.runtime.health.ok);
  const selected = state.data.selectedModel;
  const selectedRuntime = state.data.modelRuntime.entries.find((entry) => entry.role === selected.role);

  elements.runtimeSummary.innerHTML = `
    <div class="inspector-health-list">
      <div class="inspector-health-row">
        <span><i class="health-dot ${healthOk ? 'ok' : 'error'}"></i>Ядро</span>
        <strong>${healthOk ? `активно · ${active}` : 'требует внимания'}</strong>
      </div>
      <div class="inspector-health-row">
        <span><i class="health-dot ${selectedRuntime?.canInfer ? 'ok' : 'idle'}"></i>Модель</span>
        <strong>${escapeHtml(selected.label)} · ${selectedRuntime?.canInfer ? 'готова' : 'ожидает'}</strong>
      </div>
      <div class="inspector-health-row">
        <span><i class="health-dot ${queueLoad ? 'active' : 'ok'}"></i>Очередь</span>
        <strong>${queueLoad ? `${queueLoad} в работе` : 'свободна'}</strong>
      </div>
    </div>
  `;
}

function renderRouteSummary() {
  if (!elements.routeSummary || !elements.routePill) return;
  const lastIntent = state.data.lastIntent;
  const route = lastIntent?.route;
  const execution = lastIntent?.execution;
  const plan = lastIntent?.plan;
  const summary = routeSummaryState(lastIntent);

  elements.routePill.textContent = route?.capabilityId
    ? `${route.targetModuleId} · ${Math.round((route.confidence || 0) * 100)}%`
    : summary.label;

  elements.routeSummary.innerHTML = `
    <div class="decision-card ${summary.tone}">
      <div class="decision-topline">
        <span class="state-dot ${summary.tone}"></span>
        <span>${escapeHtml(summary.label)}</span>
      </div>
      <strong>${escapeHtml(route?.capabilityId || 'Навык пока не выбран')}</strong>
      <p>${escapeHtml(lastIntent?.summary || 'Готов принять команду через kernel.')}</p>
      <div class="decision-meta">
        ${miniMeta('модуль', route?.targetModuleId || 'router')}
        ${miniMeta('план', plan?.status || 'pending')}
        ${miniMeta('доступ', execution?.metadata?.permission?.mode || route?.permissionMode || 'pending')}
      </div>
    </div>
  `;
}

function renderRouteTimeline() {
  if (!elements.routeTimeline) return;
  const lastIntent = state.data.lastIntent;
  const route = lastIntent?.route;
  const execution = lastIntent?.execution;
  const plan = lastIntent?.plan;
  const needsConfirmation = execution?.error === 'confirmation-required';
  const failed = Boolean(execution && !execution.ok && !needsConfirmation);

  const stages = [
    {
      label: 'Команда',
      detail: lastIntent?.intent?.source || 'desktop',
      status: lastIntent ? 'done' : 'current',
    },
    {
      label: 'Маршрут',
      detail: route?.capabilityId || 'router ожидает',
      status: route ? 'done' : lastIntent ? 'blocked' : 'waiting',
    },
    {
      label: 'Доступ',
      detail: needsConfirmation ? 'нужно подтверждение' : route?.permissionMode || 'pending',
      status: needsConfirmation ? 'blocked' : route ? 'done' : 'waiting',
    },
    {
      label: 'Выполнение',
      detail: execution?.ok ? 'готово' : failed ? execution.error : plan?.status || 'pending',
      status: execution?.ok ? 'done' : failed ? 'blocked' : needsConfirmation ? 'waiting' : 'waiting',
    },
  ];

  elements.routeTimeline.innerHTML = stages.map((stage) => `
    <div class="timeline-step ${stage.status}">
      <span class="step-marker"></span>
      <div>
        <strong>${escapeHtml(stage.label)}</strong>
        <p>${escapeHtml(stage.detail)}</p>
      </div>
    </div>
  `).join('');
}

// 1. Re-render Composer Status Bar Under Prompt (Claude Style)
function renderComposerStatusBar() {
  const statusBar = document.querySelector('#composer-status-bar');
  if (!statusBar) return;

  const selectedModel = state.data.selectedModel?.label || 'Нет модели';
  const selectedRuntime = state.data.modelRuntime.entries.find((entry) => entry.role === state.data.selectedModel.role);
  const modelStatus = selectedRuntime?.canInfer ? 'Готова' : 'Отключена';

  const oscarBackend = state.oscar?.status?.backend;
  const oscarStatus = formatOscarBackendStatus(oscarBackend);

  const securityRunning = state.security?.status?.runtime?.running;
  const securityStatus = securityRunning ? 'Защищено' : 'Требуется проверка';

  const memoryHealth = state.data.runtime.health.modules.find((entry) => entry.moduleId === 'memory')?.health;
  const memoryStatus = memoryHealth?.ok ? 'Включена' : 'Отключена';
  const workspaceRoot = state.data.app?.workspaceRoot || 'неизвестно';
  const diagnostics = state.data.runtime.diagnostics || {};
  const queue = diagnostics.queue || {};
  const cache = diagnostics.cache || {};
  const trace = state.data.lastIntent?.execution?.output?.trace || null;

  statusBar.innerHTML = `
    <span class="status-item">Локальная модель: <strong>${escapeHtml(selectedModel)} (${modelStatus})</strong></span>
    <span class="status-item">Oscar: <strong>${oscarStatus}</strong></span>
    <span class="status-item">Безопасность: <strong>${securityStatus}</strong></span>
    <span class="status-item">Память: <strong>${memoryStatus}</strong></span>
    <span class="status-item">Очередь: <strong>${readNumber(queue.queued, 0)}/${readNumber(queue.running, 0)}</strong></span>
    <span class="status-item">Кэш: <strong>${formatDuration(cache.healthAgeMs)}</strong></span>
    <span class="status-item">LLM: <strong>${escapeHtml(trace ? `${formatTraceSource(trace.source)} · ${trace.status}` : 'нет запуска')}</strong></span>
    <span class="status-item">Рабочая область: <strong title="${escapeHtml(workspaceRoot)}">${escapeHtml(workspaceRoot)}</strong></span>
  `;
}

// 2. Render Events as Simple Activity List (No heavy cards)
function renderRecentActivityList() {
  const activityList = document.querySelector('#recent-activity-list');
  if (!activityList) return;

  const events = state.data.runtime.snapshot.events || [];
  if (events.length === 0) {
    activityList.innerHTML = '<div class="empty-state">Нет недавней активности.</div>';
    return;
  }

  activityList.innerHTML = events.slice(-4).reverse().map(e => `
    <div class="activity-item">
      <span class="activity-icon"></span>
      <span class="activity-text"><strong>${escapeHtml(e.type)}</strong> via ${escapeHtml(e.source)}</span>
      <span class="activity-time">${formatTime(e.createdAt)}</span>
    </div>
  `).join('');
}

// 3. Render Audit log into Logs View
function renderLogsPage() {
  const logsOutput = document.querySelector('#logs-audit-output');
  if (!logsOutput) return;

  const auditLog = state.data.runtime.snapshot.audit || [];
  if (auditLog.length === 0) {
    logsOutput.textContent = 'Журнал аудита пуст.';
    return;
  }

  logsOutput.textContent = auditLog.slice(-50).reverse().map(entry => {
    return `[${formatTime(entry.createdAt)}] [${entry.category.toUpperCase()}] ${entry.message} (Риск: ${entry.riskLevel})`;
  }).join('\n');
}

// 4. Overhaul Thread to Conversation-first (Claude Style)
export function renderThread() {
  if (!elements.thread) return;
  const lastIntent = state.data.lastIntent;
  const job = state.currentIntentJob;
  const text = lastIntent?.intent?.text || state.pendingIntentText || job?.text;
  const route = lastIntent?.route;
  const execution = lastIntent?.execution;
  const plan = lastIntent?.plan;
  const needsConfirmation = execution?.error === 'confirmation-required';
  const outputPreview = summarizeOutput(execution?.output);

  const isAssistantReply = execution?.output?.mode === 'assistant-reply-completed' || execution?.output?.mode === 'assistant-reply-prepared';
  const replyText = execution?.output?.reply || '';
  const replyError = execution?.output?.error || '';
  const cleanOutputPreview = isAssistantReply ? '' : outputPreview;

  if (!text) {
    syncThreadDOM(elements.thread, '<div class="empty-state">Ожидание новой задачи...</div>');
    return;
  }

  if (job && ['queued', 'running'].includes(job.status)) {
    const streamingReply = job.id ? intentJobStreamDrafts.get(job.id) || '' : '';
    const newHtml = `
      <div class="thread-message message-user">
        <div class="message-meta">Запрос пользователя</div>
        <div class="message-text">${escapeHtml(job.text)}</div>
      </div>
      <div class="thread-message message-assistant">
        <div class="message-meta">Monarch Job</div>
        <div class="message-text">
          <div class="result-summary">${escapeHtml(job.status === 'queued' ? 'Задача в очереди' : 'Выполняю через kernel')}</div>
          ${streamingReply ? `
            <div class="assistant-reply-container">
              <div class="reply-text">${formatOscarContent(streamingReply)}</div>
            </div>
          ` : ''}
          <div class="job-status-panel">
            <div class="job-status-row">
              <span class="spinner"></span>
              <span>${escapeHtml(job.summary || 'Monarch готовит ответ.')}</span>
            </div>
            <div class="job-progress">
              ${(job.progress || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
            </div>
            <button class="secondary-button" type="button" data-cancel-intent-job="${escapeHtml(job.id)}">Отменить</button>
          </div>
        </div>
      </div>
    `;
    syncThreadDOM(elements.thread, newHtml);
    return;
  }

  if (job && ['failed', 'cancelled', 'timeout'].includes(job.status) && !job.result) {
    syncThreadDOM(elements.thread, `
      <div class="thread-message message-user">
        <div class="message-meta">Запрос пользователя</div>
        <div class="message-text">${escapeHtml(job.text)}</div>
      </div>
      <div class="error-state">
        <strong>${escapeHtml(job.status === 'cancelled' ? 'Задача отменена' : 'Задача не завершилась')}</strong>
        <p>${escapeHtml(job.error || job.summary || job.status)}</p>
      </div>
    `);
    return;
  }

  // A. Plan steps transformed into collapsible inline execution blocks
  const steps = plan?.steps || [];
  const stepsHtml = steps.length > 0
    ? `<div class="plan-steps-container">
         <h4>План действий (${steps.length} шагов)</h4>
         ${steps.map((step, idx) => {
           const status = readStepDisplayStatus(plan?.status, idx);
           const risk = step.expectedRisk || 'none';
           const statusTone = status === 'completed' ? 'success' : status === 'failed' ? 'failed' : 'pending';
           return `
             <div class="tool-call-block">
               <div class="tool-call-header">
                 <span class="tool-status-icon ${statusTone}"></span>
                 <strong>Шаг ${idx + 1}: ${escapeHtml(step.capabilityId)}</strong>
                 <span class="tool-status-label">${status}</span>
               </div>
               <div class="tool-call-details">
                 <p>Модуль: <code>${escapeHtml(step.moduleId)}</code> · Риск: <span class="severity-badge ${risk}">${risk}</span></p>
                 ${step.input ? `<pre class="tool-call-input">${escapeHtml(JSON.stringify(step.input, null, 2))}</pre>` : ''}
               </div>
             </div>
           `;
         }).join('')}
       </div>`
    : '';

  const newHtml = `
    <!-- User block -->
    <div class="thread-message message-user">
      <div class="message-meta">Запрос пользователя</div>
      <div class="message-text">${escapeHtml(text)}</div>
    </div>

    <!-- Assistant block -->
    <div class="thread-message message-assistant">
      <div class="message-meta">Monarch Kernel</div>
      <div class="message-text">
        <div class="result-summary">${escapeHtml(lastIntent?.summary || 'Сеанс выполнения инициализирован.')}</div>

        <!-- Assistant reply block -->
        ${isAssistantReply ? `
          <div class="assistant-reply-container">
            ${replyText ? `<div class="reply-text">${formatOscarContent(replyText)}</div>` : ''}
            ${replyError ? `
              <div class="reply-error-banner">
                <strong>Внимание: Ошибка LLM</strong>
                <p>${escapeHtml(replyError)}</p>
              </div>
            ` : ''}
          </div>
        ` : ''}

        <!-- Collapsible inline tools/plans -->
        ${stepsHtml}

        <!-- Diff / Permission block -->
        ${needsConfirmation ? confirmationBanner(text, lastIntent?.confirmation || execution?.metadata?.confirmation, plan) : ''}

        <!-- Tool output details -->
        ${cleanOutputPreview ? `
          <div class="tool-result-panel">
            <h5>Результат вызова инструмента</h5>
            <pre class="output-preview">${escapeHtml(cleanOutputPreview)}</pre>
          </div>
        ` : ''}
      </div>
    </div>
  `;
  syncThreadDOM(elements.thread, newHtml);

  // Asynchronously trigger diff loading if we are confirming a file write
  if (needsConfirmation) {
    const writeStep = plan?.steps?.find((step) => step.capabilityId === 'workspace.files.write');
    if (writeStep) {
      void loadDiffPreview(writeStep);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStepDisplayStatus(planStatus, index) {
  switch (planStatus) {
  case 'completed':
    return 'выполнено';
  case 'failed':
    return 'ошибка';
  case 'blocked':
    return index === 0 ? 'ожидает подтверждения' : 'в очереди';
  case 'running':
    return index === 0 ? 'выполняется' : 'в очереди';
  default:
    return 'в очереди';
  }
}

function formatDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    return 'нет данных';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} мс`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} сек`;
  }
  return `${Math.round(ms / 60000)} мин`;
}

function formatLatency(latency, trace) {
  const first = Number(latency?.firstTokenMs ?? trace?.firstTokenLatencyMs);
  const total = Number(latency?.totalMs ?? trace?.totalLatencyMs);
  if (!Number.isFinite(first) && !Number.isFinite(total)) {
    return 'нет данных';
  }
  const parts = [];
  if (Number.isFinite(first)) {
    parts.push(`1-й ${formatDuration(first)}`);
  }
  if (Number.isFinite(total)) {
    parts.push(`итог ${formatDuration(total)}`);
  }
  return parts.join(' · ');
}

function formatTraceSource(value) {
  switch (value) {
  case 'openai-compatible-endpoint':
    return 'endpoint';
  case 'oscar-managed-backend':
    return 'Oscar';
  case 'offline-guidance':
    return 'offline';
  case 'constraints':
    return 'policy';
  default:
    return value || 'unknown';
  }
}

function formatOscarBackendStatus(backend) {
  if (backend?.connected) {
    return 'В сети';
  }
  if (backend?.startupAttempted) {
    return 'Запуск не удался';
  }
  return 'Готов к запуску';
}

async function loadDiffPreview(writeStep) {
  const container = document.querySelector('#diff-preview-container');
  if (!container) return;

  const targetPath = writeStep.input.path;
  const newContent = writeStep.input.content;

  try {
    const result = await executeCapability('workspace', 'workspace.files.read', { path: targetPath }, 'ui:diff', false);
    const existingContent = result.output?.content || '';
    const diffHtml = computeInlineDiff(existingContent, newContent);
    container.innerHTML = diffHtml;
    container.classList.remove('loading');
  } catch (error) {
    const diffHtml = computeInlineDiff('', newContent);
    container.innerHTML = diffHtml;
    container.classList.remove('loading');
  }
}
