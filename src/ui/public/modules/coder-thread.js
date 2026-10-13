// Coder conversation model. Pure functions: a run journal in, what the person
// reads out. Execution, receipts and completion stay with Oscar/Astra/Kernel.

const ACTIVE = new Set(['queued', 'running']);

export function isCoderRunActive(run) {
  return Boolean(run) && ACTIVE.has(run.status);
}

export function coderSessionId(run) {
  return run?.sessionId || run?.id || '';
}

/** Runs grouped into conversations, newest conversation first. */
export function coderSessions(runs) {
  const sessions = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const id = coderSessionId(run);
    if (!id) continue;
    const session = sessions.get(id) ?? { id, projectId: run.projectId, projectName: run.projectName || '', runs: [] };
    session.runs.push(run);
    sessions.set(id, session);
  }
  return [...sessions.values()].map(session => {
    session.runs.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    const first = session.runs[0], last = session.runs.at(-1);
    return { ...session, title: coderTitle(first.prompt), updatedAt: last.updatedAt || last.createdAt,
      status: last.status, active: session.runs.some(isCoderRunActive),
      attention: Boolean(last.agentApproval || last.agentQuestion) || last.status === 'failed' || last.status === 'interrupted' };
  }).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export function coderTitle(prompt) {
  const line = String(prompt || '').replace(/\s+/gu, ' ').trim();
  if (!line) return 'Без названия';
  return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line;
}

export function coderSessionGroup(value, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Ранее';
  const day = 86_400_000;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= start) return 'Сегодня';
  if (date.getTime() >= start - day) return 'Вчера';
  if (date.getTime() >= start - 6 * day) return 'На этой неделе';
  return 'Ранее';
}

/** Path as the person knows it: relative to the project when it lies inside. */
export function coderRelativePath(value, root) {
  const text = String(value || '').replace(/\\/gu, '/');
  const base = String(root || '').replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (base && text.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return text.slice(base.length + 1);
  return text;
}

function outputOf(event) {
  return event?.output && typeof event.output === 'object' && !Array.isArray(event.output) ? event.output : {};
}

function commandLine(output) {
  const executable = typeof output.executable === 'string' ? output.executable : '';
  const args = Array.isArray(output.args) ? output.args.map(String).join(' ') : '';
  return `${executable}${args ? ` ${args}` : ''}`.trim();
}

const VERBS = {
  'coder.files.list': ['Смотрю структуру проекта', 'Просмотрел структуру проекта', 'Не смог открыть структуру проекта'],
  'coder.files.read': ['Читаю файл', 'Прочитал', 'Не смог прочитать'],
  'coder.files.write': ['Записываю файл', 'Записал', 'Не смог записать'],
  'coder.files.patch': ['Правлю файл', 'Изменил', 'Не смог изменить'],
  'coder.files.delete': ['Удаляю файл', 'Удалил', 'Не смог удалить'],
  'coder.command.run': ['Выполняю команду', 'Выполнил', 'Команда завершилась с ошибкой'],
  'coder.git.status': ['Смотрю состояние Git', 'Проверил состояние Git', 'Git не ответил'],
  'coder.git.diff': ['Смотрю изменения в Git', 'Посмотрел изменения в Git', 'Git не показал изменения'],
  'coder.git.init': ['Создаю репозиторий Git', 'Создал репозиторий Git', 'Не смог создать репозиторий'],
  'coder.git.stage': ['Готовлю файлы к коммиту', 'Подготовил файлы к коммиту', 'Не смог подготовить файлы'],
  'coder.git.commit': ['Создаю коммит', 'Создал коммит', 'Коммит не создан'],
  'coder.git.branch.create': ['Создаю ветку', 'Создал ветку', 'Ветка не создана'],
  'coder.git.push': ['Отправляю изменения', 'Отправил изменения', 'Изменения не отправлены'],
  'coder.network.fetch': ['Открываю страницу', 'Открыл', 'Страница не открылась'],
  'coder.network.request': ['Отправляю запрос', 'Отправил запрос', 'Запрос не прошёл'],
  'coder.skills.create': ['Сохраняю навык', 'Сохранил навык', 'Навык не сохранён'],
};

/** The object of an action: a file, a command, an address. */
export function coderStepTarget(capabilityId, output, root) {
  if (/^coder\.files\.(read|write|patch|delete)$/u.test(capabilityId) && output.path) return coderRelativePath(output.path, root);
  if (capabilityId === 'coder.command.run') return commandLine(output);
  if (capabilityId.startsWith('coder.network.') && output.url) return String(output.url);
  if (capabilityId === 'coder.git.commit' && output.subject) return String(output.subject);
  if (capabilityId === 'coder.git.branch.create' && (output.branch || output.requested)) return String(output.branch || output.requested);
  return '';
}

export function coderStepLabel(capabilityId, state) {
  const verbs = VERBS[capabilityId];
  if (!verbs) {
    const name = String(capabilityId || '').replace(/^coder\./u, '').replace(/[._]/gu, ' ');
    return state === 'running' ? `Выполняю: ${name}` : state === 'failed' ? `Не получилось: ${name}` : `Выполнено: ${name}`;
  }
  return state === 'running' ? verbs[0] : state === 'failed' ? verbs[2] : verbs[1];
}

/**
 * Steps of one run in journal order. Each step is the agent's own sentence to
 * the person (`note`), its optional visible reasoning (`thought`) and the
 * action that followed, with its Kernel receipt.
 */
export function coderSteps(run) {
  const steps = [];
  const open = new Map();
  let thought = '';
  for (const event of Array.isArray(run?.events) ? run.events : []) {
    // Visible reasoning the model wrote for the person before its next action.
    if (event.kind === 'assistant' && event.title === 'План следующего шага') { thought = String(event.detail || '').trim(); continue; }
    if (event.kind === 'tool-start' && event.capabilityId) {
      const reason = String(event.detail || '').trim();
      const step = { id: event.id, capabilityId: event.capabilityId,
        note: reason === 'Astra V3 dispatched a project-bound Kernel capability.' ? '' : reason, thought,
        state: 'running', ok: undefined, summary: '', output: null, createdAt: event.createdAt };
      thought = '';
      steps.push(step);
      const queue = open.get(event.capabilityId) ?? [];
      queue.push(step);
      open.set(event.capabilityId, queue);
      continue;
    }
    if (event.kind === 'tool-result' && event.capabilityId) {
      const step = open.get(event.capabilityId)?.shift();
      if (!step) continue;
      step.state = event.ok === true ? 'done' : 'failed';
      step.ok = event.ok === true;
      step.summary = String(event.error || event.detail || '').trim();
      step.output = event.output ?? null;
    }
  }
  const root = run?.projectRoot || '';
  for (const step of steps) {
    const output = step.output && typeof step.output === 'object' ? step.output : {};
    step.label = coderStepLabel(step.capabilityId, step.state);
    step.target = coderStepTarget(step.capabilityId, output, root);
    if (step.capabilityId === 'coder.command.run' && Number.isInteger(output.exitCode)) step.exitCode = output.exitCode;
  }
  return steps;
}

/** Text worth opening under a finished step. Never more than the person can scan. */
export function coderStepDetail(step) {
  const output = step?.output && typeof step.output === 'object' ? step.output : {};
  if (step.state === 'failed') return { kind: 'text', text: step.summary || 'Действие не выполнено.' };
  if (step.capabilityId === 'coder.files.read' && typeof output.content === 'string') {
    return { kind: 'code', text: clip(output.content, 60) };
  }
  if (step.capabilityId === 'coder.command.run') {
    const text = [output.stdout, output.stderr].filter(value => typeof value === 'string' && value.trim()).join('\n');
    return text ? { kind: 'code', text: tail(text, 40) } : null;
  }
  if (step.capabilityId === 'coder.files.list' && Array.isArray(output.entries)) {
    return { kind: 'code', text: clip(output.entries.map(entry => `${entry.type === 'directory' ? '▸ ' : '  '}${entry.path}`).join('\n'), 40) };
  }
  if (step.capabilityId.startsWith('coder.git.') && typeof output.stdout === 'string' && output.stdout.trim()) {
    return { kind: 'code', text: clip(output.stdout, 40) };
  }
  return null;
}

function clip(text, lines) {
  const all = String(text).split(/\r?\n/u);
  return all.length > lines ? `${all.slice(0, lines).join('\n')}\n… ещё строк: ${all.length - lines}` : String(text);
}

function tail(text, lines) {
  const all = String(text).split(/\r?\n/u);
  return all.length > lines ? `… строк выше: ${all.length - lines}\n${all.slice(-lines).join('\n')}` : String(text);
}

/** What the cited receipts say about a completed answer; '' when it is backed.
 * The answer is the model's text. Live: Gemma answered "Файл создан" twice
 * without a single action, and Coder showed it as done. */
export function coderEvidenceNote(run) {
  if (run?.status !== 'completed') return '';
  if (run.completionEvidence === 'none' && !coderSteps(run).length) return 'Coder ничего не делал в проекте: это только ответ модели, изменений нет.';
  if (run.completionEvidence === 'failed') return 'Действия, на которые опирается ответ, не удались — проверь шаги выше.';
  if (run.completionEvidence === 'mixed') return 'Часть действий, на которые опирается ответ, не удалась — проверь шаги выше.';
  return '';
}

/** Files the run changed, project-relative and unique, in the order they changed. */
export function coderChangedFiles(run) {
  const files = [];
  for (const step of coderSteps(run)) {
    if (step.state !== 'done' || !/^coder\.files\.(write|patch|delete)$/u.test(step.capabilityId) || !step.target) continue;
    if (!files.includes(step.target)) files.push(step.target);
  }
  return files;
}

/** Checks the agent actually ran. A missing check is never shown as passed. */
export function coderChecks(run) {
  return (Array.isArray(run?.summary?.tests) ? run.summary.tests : []).map(entry => {
    const match = /^(PASS|FAIL):\s*(.*)$/u.exec(String(entry));
    return match ? { ok: match[1] === 'PASS', command: match[2] } : null;
  }).filter(Boolean);
}

/** One word for where the run stands. Presentation only. */
export function coderRunState(run, { submitting = false, disconnected = false } = {}) {
  if (submitting) return { stage: 'starting', label: 'Отправляю', busy: true };
  if (!run) return { stage: 'idle', label: 'Готов', busy: false };
  if (run.agentApproval) return { stage: 'approval', label: 'Нужно разрешение', busy: true };
  if (run.agentQuestion) return { stage: 'question', label: 'Жду ответа', busy: true };
  if (disconnected && isCoderRunActive(run)) return { stage: 'disconnected', label: 'Восстанавливаю связь', busy: true };
  if (run.cancelled && isCoderRunActive(run)) return { stage: 'stopping', label: 'Останавливаю', busy: true };
  const states = {
    queued: ['queued', 'В очереди', true], running: ['working', 'Работаю', true],
    completed: ['completed', 'Готово', false], failed: ['failed', 'Не получилось', false],
    interrupted: ['paused', 'Прервано', false], cancelled: ['cancelled', 'Остановлено', false],
  };
  const [stage, label, busy] = states[run.status] ?? ['unknown', 'Неизвестно', true];
  return { stage, label, busy };
}

/** Models the person can choose: the host's agent catalog plus the exact selected MAX service. */
/** Every ready MAX service, the selected one first, then local models. With
 * only the selected service listed, a model that misbehaved on a task (live:
 * gpt-6-luna asking instead of acting) left nothing to switch to in Coder,
 * although the other services were connected and the host serves each by its
 * own key and model. */
export function coderAvailableModels(runtime, maxProviders) {
  const models = Array.isArray(runtime?.models) ? runtime.models.map(model => ({ ...model })) : [];
  if (!runtime?.maxConfigured) return models;
  const ready = (Array.isArray(maxProviders) ? maxProviders : [maxProviders])
    .filter(provider => provider?.state === 'ready' && typeof provider.role === 'string');
  const seen = new Set();
  const max = ready.filter(provider => !seen.has(provider.role) && seen.add(provider.role))
    .map(provider => ({ id: provider.role, label: provider.model || provider.name || provider.id,
      provider: provider.name || provider.id, source: 'max' }));
  return [...max, ...models];
}

/** Unified git patch → rows for the diff view. */
export function coderPatchRows(patch) {
  const rows = [];
  let oldNo = 0, newNo = 0;
  for (const line of String(patch || '').split(/\r?\n/u)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(line);
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); rows.push({ type: 'hunk', text: hunk[3].trim() }); continue; }
    if (!rows.length || /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/u.test(line)) continue;
    if (line.startsWith('+')) rows.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
    else if (line.startsWith('-')) rows.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
    else if (line.startsWith('\\')) continue;
    else rows.push({ type: 'same', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return rows;
}
