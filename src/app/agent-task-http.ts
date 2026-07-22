import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MonarchApplication } from './application';
import { normalizeAgentBudget } from '../agent/budget-manager';
import type {
  AgentBudgetLimits,
  AgentExpectedOutput,
  AgentGoalConstraint,
  AgentSuccessCriterion,
  AgentTaskCheckpoint,
  AgentTaskEvent,
} from '../agent/types';

const MAX_AGENT_JSON_BODY_BYTES = 256 * 1024;
const TERMINAL_EVENTS = new Set(['task.completed', 'task.failed', 'task.cancelled']);
const AGENT_TASK_SURFACES = new Set(['desktop', 'telegram', 'voice', 'api', 'coder', 'system', 'smoke']);
const AGENT_OUTPUT_KINDS = new Set(['answer', 'artifact', 'state-change', 'verification', 'other']);
const AGENT_CONSTRAINT_KINDS = new Set(['safety', 'permission', 'scope', 'format', 'resource', 'other']);
const AGENT_COMPUTE_CLASSES = new Set(['light', 'medium', 'heavy']);
const AGENT_INTEGER_BUDGET_KEYS = [
  'maxSteps',
  'maxModelTurns',
  'maxToolCalls',
  'maxWallTimeMs',
  'maxFailures',
  'maxConsecutiveNoProgress',
] as const;

export interface AgentTaskHttpContext {
  app: MonarchApplication;
  url: URL;
  request: IncomingMessage;
  response: ServerResponse;
  enforceMutation: () => void;
  enforceRead: () => void;
}

export async function handleAgentTaskHttpRequest(context: AgentTaskHttpContext): Promise<boolean> {
  const { app, url, request, response } = context;
  if (url.pathname !== '/api/agent/tasks' && !url.pathname.startsWith('/api/agent/tasks/')) return false;
  const runtime = app.agentRuntime;
  if (!runtime) {
    sendJson(response, 404, { version: 1, ok: false, error: 'agent-runtime-disabled' });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/agent/tasks') {
    context.enforceMutation();
    const body = await readBoundedJson(request);
    assertVersion(body);
    assertKeys(body, [
      'version', 'request', 'clientRequestId', 'conversationId', 'parentTaskId', 'expectedOutputs',
      'constraints', 'successCriteria', 'userPreferences', 'budgets', 'autoStart', 'source',
    ]);
    const taskRequest = readRequiredText(body.request, 'request', 16_000);
    const clientRequestId = readOptionalId(body.clientRequestId, 'clientRequestId');
    const conversationId = readOptionalId(body.conversationId, 'conversationId');
    const parentTaskId = readOptionalId(body.parentTaskId, 'parentTaskId');
    const expectedOutputs = readExpectedOutputs(body.expectedOutputs);
    const constraints = readConstraints(body.constraints);
    const successCriteria = readSuccessCriteria(body.successCriteria);
    const userPreferences = readStringArray(body.userPreferences, 'userPreferences', 32, 1_000);
    const budgets = readBudget(body.budgets);
    const autoStart = readOptionalBoolean(body.autoStart, 'autoStart');
    assertOptionalSource(body.source);
    const checkpoint = await app.createAgentTask({
      request: taskRequest,
      source: { surface: 'api', ...(clientRequestId ? { requestId: clientRequestId } : {}) },
      ...(clientRequestId ? { clientRequestId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(parentTaskId ? { parentTaskId } : {}),
      ...(expectedOutputs ? { expectedOutputs } : {}),
      ...(constraints ? { constraints } : {}),
      ...(successCriteria ? { successCriteria } : {}),
      ...(userPreferences ? { userPreferences } : {}),
      ...(budgets ? { budgets } : {}),
      ...(autoStart !== undefined ? { autoStart } : {}),
    });
    sendJson(response, 202, { version: 1, ok: true, task: checkpoint.task });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent/tasks') {
    context.enforceRead();
    const limit = normalizeLimit(url.searchParams.get('limit'));
    const tasks = (await runtime.listTasks()).slice(-limit).reverse();
    sendJson(response, 200, { version: 1, ok: true, tasks });
    return true;
  }

  const match = url.pathname.match(/^\/api\/agent\/tasks\/([^/]+)(?:\/(messages|pause|resume|cancel|events|approvals)(?:\/([^/]+))?)?$/);
  if (!match?.[1]) throw httpError(405, 'method-not-allowed', 'Unsupported Agent Task method.');
  const taskId = decodePathId(match[1], 'taskId');
  const action = match[2] || '';
  const nestedId = match[3] ? decodePathId(match[3], action === 'approvals' ? 'approvalId' : 'nestedId') : '';

  if (request.method === 'GET' && !action) {
    context.enforceRead();
    const checkpoint = await runtime.getTask(taskId);
    if (!checkpoint) throw httpError(404, 'task-not-found', 'Agent task was not found.');
    sendJson(response, 200, { version: 1, ok: true, checkpoint });
    return true;
  }

  if (request.method === 'POST' && action === 'messages' && !nestedId) {
    context.enforceMutation();
    const body = await readBoundedJson(request);
    assertVersion(body);
    assertKeys(body, ['version', 'content', 'messageId']);
    const messageId = readOptionalId(body.messageId, 'messageId');
    const checkpoint = await runtime.sendMessage(taskId, {
      content: readRequiredText(body.content, 'content', 16_000),
      ...(messageId ? { messageId } : {}),
    });
    sendJson(response, 200, { version: 1, ok: true, task: checkpoint.task });
    return true;
  }

  if (request.method === 'POST' && (action === 'pause' || action === 'resume' || action === 'cancel') && !nestedId) {
    context.enforceMutation();
    const body = await readBoundedJson(request);
    assertVersion(body);
    assertKeys(body, ['version']);
    const checkpoint = action === 'pause'
      ? await runtime.pause(taskId)
      : action === 'resume'
        ? await runtime.resume(taskId)
        : await runtime.cancel(taskId);
    sendJson(response, 200, { version: 1, ok: true, task: checkpoint.task });
    return true;
  }

  if (request.method === 'POST' && action === 'approvals' && nestedId) {
    context.enforceMutation();
    const body = await readBoundedJson(request);
    assertVersion(body);
    assertKeys(body, ['version', 'decision', 'grantScope', 'requestId', 'reason']);
    if (body.decision !== 'approve' && body.decision !== 'deny') {
      throw httpError(400, 'invalid-approval-decision', 'decision must be approve or deny.');
    }
    if (body.grantScope !== undefined && body.grantScope !== 'once' && body.grantScope !== 'task') {
      throw httpError(400, 'invalid-grant-scope', 'grantScope must be once or task.');
    }
    const requestId = readOptionalId(body.requestId, 'requestId');
    const reason = readOptionalText(body.reason, 'reason', 1_000);
    const checkpoint = await runtime.resolveApproval(taskId, nestedId, {
      decision: body.decision,
      ...(body.grantScope ? { grantScope: body.grantScope } : {}),
      ...(requestId ? { requestId } : {}),
      ...(reason ? { reason } : {}),
    });
    sendJson(response, 200, { version: 1, ok: true, task: checkpoint.task });
    return true;
  }

  if (request.method === 'GET' && action === 'events' && !nestedId) {
    context.enforceRead();
    const checkpoint = await runtime.getTask(taskId);
    if (!checkpoint) throw httpError(404, 'task-not-found', 'Agent task was not found.');
    const after = readAfterSequence(request, url);
    if (url.searchParams.get('format') === 'json' || !acceptsEventStream(request)) {
      sendJson(response, 200, {
        version: 1,
        ok: true,
        events: checkpoint.events.filter((event) => event.sequence > after).map(toPublicEvent),
      });
      return true;
    }
    streamTaskEvents(runtime, taskId, after, request, response, checkpoint);
    return true;
  }

  throw httpError(405, 'method-not-allowed', 'Unsupported Agent Task method.');
}

function streamTaskEvents(
  runtime: NonNullable<MonarchApplication['agentRuntime']>,
  taskId: string,
  after: number,
  request: IncomingMessage,
  response: ServerResponse,
  initialCheckpoint: AgentTaskCheckpoint,
): void {
  let lastSequence = after;
  let replaying = true;
  let closed = false;
  let terminalSeen = isTerminalTask(initialCheckpoint);
  const buffered: AgentTaskEvent[] = [];
  const unsubscribe = runtime.subscribe(taskId, (commit) => {
    for (const event of commit.appendedEvents) {
      if (event.sequence <= lastSequence) continue;
      if (replaying) buffered.push(event);
      else emit(event);
    }
  });
  const heartbeat = setInterval(() => {
    if (!closed) response.write(': heartbeat\n\n');
  }, 15_000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const finish = () => {
    if (closed) return;
    cleanup();
    response.end();
  };
  const finishIfSettled = () => {
    if (!terminalSeen || closed) return;
    void runtime.getTask(taskId).then((checkpoint) => {
      if (checkpoint && isTerminalTask(checkpoint)) terminalSeen = true;
      if (terminalSeen && !checkpoint?.task.runnerClaim) finish();
    }).catch(finish);
  };
  const emit = (event: AgentTaskEvent) => {
    if (closed || event.sequence <= lastSequence) return;
    lastSequence = event.sequence;
    response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(toPublicEvent(event))}\n\n`);
    if (TERMINAL_EVENTS.has(event.type)) {
      terminalSeen = true;
      finishIfSettled();
    } else if (event.type === 'runner.released' && terminalSeen) finish();
  };
  request.once('close', cleanup);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  void runtime.getEvents(taskId, after).then((events) => {
    for (const event of events) emit(event);
    replaying = false;
    for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) emit(event);
    buffered.length = 0;
    finishIfSettled();
  }).catch(() => {
    cleanup();
    response.end();
  });
}

function isTerminalTask(checkpoint: AgentTaskCheckpoint): boolean {
  return checkpoint.task.status === 'completed'
    || checkpoint.task.status === 'failed'
    || checkpoint.task.status === 'cancelled';
}

function toPublicEvent(event: AgentTaskEvent) {
  return {
    version: 1,
    id: event.id,
    sequence: event.sequence,
    taskId: event.taskId,
    traceId: event.traceId,
    type: event.type,
    createdAt: event.createdAt,
    ...(event.payload ? { payload: event.payload } : {}),
  };
}

async function readBoundedJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_AGENT_JSON_BODY_BYTES) {
      throw httpError(413, 'request-too-large', `Agent request exceeds ${MAX_AGENT_JSON_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('not-object');
    return parsed;
  } catch {
    throw httpError(400, 'invalid-json', 'Agent request body must be one JSON object.');
  }
}

function assertVersion(body: Record<string, unknown>): void {
  if (body.version !== 1) throw httpError(400, 'unsupported-version', 'Agent Task API requires version: 1.');
}

function assertKeys(body: Record<string, unknown>, allowed: string[]): void {
  const set = new Set(allowed);
  const extra = Object.keys(body).filter((key) => !set.has(key));
  if (extra.length > 0) throw httpError(400, 'unexpected-field', `Unexpected Agent Task fields: ${extra.join(', ')}.`);
}

function readExpectedOutputs(value: unknown): Array<Partial<AgentExpectedOutput> & { description: string }> | undefined {
  const values = readOptionalArray(value, 'expectedOutputs', 32);
  return values?.map((entry, index) => {
    const field = `expectedOutputs[${index}]`;
    const record = readGoalRecord(entry, field, ['id', 'description', 'kind', 'required']);
    const id = readOptionalId(record.id, `${field}.id`);
    const kind = readOptionalEnum(record.kind, `${field}.kind`, AGENT_OUTPUT_KINDS);
    const required = readOptionalBoolean(record.required, `${field}.required`);
    return {
      description: readRequiredText(record.description, `${field}.description`, 2_000),
      ...(id ? { id } : {}),
      ...(kind ? { kind: kind as NonNullable<AgentExpectedOutput['kind']> } : {}),
      ...(required !== undefined ? { required } : {}),
    };
  });
}

function readConstraints(value: unknown): Array<Partial<AgentGoalConstraint> & { description: string }> | undefined {
  const values = readOptionalArray(value, 'constraints', 32);
  return values?.map((entry, index) => {
    const field = `constraints[${index}]`;
    const record = readGoalRecord(entry, field, ['id', 'description', 'kind']);
    const id = readOptionalId(record.id, `${field}.id`);
    const kind = readOptionalEnum(record.kind, `${field}.kind`, AGENT_CONSTRAINT_KINDS);
    return {
      description: readRequiredText(record.description, `${field}.description`, 2_000),
      ...(id ? { id } : {}),
      ...(kind ? { kind: kind as NonNullable<AgentGoalConstraint['kind']> } : {}),
    };
  });
}

function readSuccessCriteria(value: unknown): Array<Partial<AgentSuccessCriterion> & { description: string }> | undefined {
  const values = readOptionalArray(value, 'successCriteria', 32);
  return values?.map((entry, index) => {
    const field = `successCriteria[${index}]`;
    const record = readGoalRecord(entry, field, ['id', 'description', 'verificationHint']);
    const id = readOptionalId(record.id, `${field}.id`);
    const verificationHint = readOptionalText(record.verificationHint, `${field}.verificationHint`, 2_000);
    return {
      description: readRequiredText(record.description, `${field}.description`, 2_000),
      ...(id ? { id } : {}),
      ...(verificationHint ? { verificationHint } : {}),
    };
  });
}

function readGoalRecord(value: unknown, field: string, allowed: string[]): Record<string, unknown> {
  if (!isRecord(value)) throw httpError(400, 'invalid-goal-record', `${field} must be an object.`);
  assertKeys(value, allowed);
  return value;
}

function readBudget(value: unknown): Partial<AgentBudgetLimits> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw httpError(400, 'invalid-budget', 'budgets must be an object.');
  assertKeys(value, [...AGENT_INTEGER_BUDGET_KEYS, 'maxComputeClass']);
  const output: Partial<AgentBudgetLimits> = {};
  for (const key of AGENT_INTEGER_BUDGET_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate)) {
      throw httpError(400, 'invalid-budget', `budgets.${key} must be a safe integer.`);
    }
    const normalized = normalizeAgentBudget({ [key]: candidate } as Partial<AgentBudgetLimits>)[key];
    if (normalized !== candidate) {
      throw httpError(400, 'invalid-budget', `budgets.${key} is outside the supported range.`);
    }
    (output as Record<string, unknown>)[key] = candidate;
  }
  if (value.maxComputeClass !== undefined) {
    if (typeof value.maxComputeClass !== 'string' || !AGENT_COMPUTE_CLASSES.has(value.maxComputeClass)) {
      throw httpError(400, 'invalid-budget', 'budgets.maxComputeClass must be light, medium, or heavy.');
    }
    output.maxComputeClass = value.maxComputeClass as NonNullable<AgentBudgetLimits['maxComputeClass']>;
  }
  return output;
}

function readStringArray(value: unknown, field: string, maximum: number, maxChars: number): string[] | undefined {
  const values = readOptionalArray(value, field, maximum);
  return values?.map((entry, index) => readRequiredText(entry, `${field}[${index}]`, maxChars));
}

function readOptionalArray(value: unknown, field: string, maximum: number): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw httpError(400, invalidFieldCode(field), `${field} must be an array.`);
  if (value.length > maximum) throw httpError(400, invalidFieldCode(field), `${field} accepts at most ${maximum} entries.`);
  return value;
}

function readRequiredText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string') throw httpError(400, invalidFieldCode(field), `${field} must be a string.`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) throw httpError(400, invalidFieldCode(field), `${field} is required.`);
  if (normalized.length > maxChars) throw httpError(400, invalidFieldCode(field), `${field} exceeds ${maxChars} characters.`);
  return normalized;
}

function readOptionalText(value: unknown, field: string, maxChars: number): string | undefined {
  return value === undefined ? undefined : readRequiredText(value, field, maxChars);
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw httpError(400, invalidFieldCode(field), `${field} must be a boolean.`);
  return value;
}

function readOptionalEnum(value: unknown, field: string, allowed: ReadonlySet<string>): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw httpError(400, invalidFieldCode(field), `${field} contains an unsupported value.`);
  }
  return value;
}

function readOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw httpError(400, 'invalid-id', `${field} must be a non-empty string identifier.`);
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) throw httpError(400, 'invalid-id', `${field} contains unsupported characters or length.`);
  return id;
}

function decodePathId(value: string, field: string): string {
  let decoded = '';
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw httpError(400, 'invalid-id', `${field} is not valid URL encoding.`);
  }
  const id = readOptionalId(decoded, field);
  if (!id) throw httpError(400, 'invalid-id', `${field} is required.`);
  return id;
}

function assertOptionalSource(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !AGENT_TASK_SURFACES.has(value)) {
    throw httpError(400, 'invalid-source', 'source must be a supported Agent Task surface name.');
  }
}

function invalidFieldCode(field: string): string {
  const normalized = field
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `invalid-${normalized || 'field'}`;
}

function readAfterSequence(request: IncomingMessage, url: URL): number {
  const value = request.headers['last-event-id'] || url.searchParams.get('after') || '0';
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function acceptsEventStream(request: IncomingMessage): boolean {
  return String(request.headers.accept || '').toLowerCase().includes('text/event-stream');
}

function normalizeLimit(value: string | null): number {
  const parsed = Number(value || 50);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? Math.floor(parsed) : 50, 100));
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function httpError(statusCode: number, code: string, message: string) {
  return { statusCode, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
