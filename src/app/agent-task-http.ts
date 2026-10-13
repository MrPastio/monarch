import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { MonarchApplication } from './application';
import type { MonarchHttpPrincipal } from './http-server';
import type {
  AgentBudgetLimits,
  AgentExpectedOutput,
  AgentGoalConstraint,
  AgentSuccessCriterion,
  AgentTaskSurface,
} from '../agent-protocol';
import { normalizeAgentBudget } from '../agent-protocol';
import type { AstraAuthenticatedHttpActor, AstraTaskHttpTask } from './astra-task-facade';
import type { OscarTurnCheckpoint, OscarTurnV1 } from '../oscar-turn/types';
import { isAstraAgentTaskSpecification, type AstraAgentTaskSpecification } from '../agent-v3/agent-task-contract';
import { isExecutableMaxRole } from '../agent-v3/max-native-contract';
import { isAstraLocalAgentModelChoice } from '../agent-v3/source-goal-contract';

const MAX_AGENT_JSON_BODY_BYTES = 256 * 1024;
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
  principal: MonarchHttpPrincipal;
  astraV3Enabled?: boolean;
  authenticatedActor?: (source?: Extract<AstraAuthenticatedHttpActor['source'], 'desktop' | 'voice' | 'api' | 'coder'>) => AstraAuthenticatedHttpActor;
}

export async function handleAgentTaskHttpRequest(context: AgentTaskHttpContext): Promise<boolean> {
  const { app, url, request, response } = context;
  if (url.pathname !== '/api/agent/tasks' && !url.pathname.startsWith('/api/agent/tasks/')) return false;
  if (!context.astraV3Enabled) {
    sendJson(response, 404, { version: 1, ok: false, error: 'agent-runtime-disabled' });
    return true;
  }

  if (context.astraV3Enabled && request.method === 'POST' && url.pathname === '/api/agent/tasks') {
    context.enforceMutation();
    const body = await readBoundedJson(request);
    assertVersion(body);
    assertKeys(body, [
      'version', 'request', 'clientRequestId', 'conversationId', 'parentTaskId', 'expectedOutputs',
      'constraints', 'successCriteria', 'userPreferences', 'budgets', 'autoStart', 'source', 'model',
    ]);
    const taskRequest = readRequiredText(body.request, 'request', 16_000);
    const clientRequestId = readOptionalId(body.clientRequestId, 'clientRequestId')
      ?? `agent_request_${randomUUID().replace(/-/g, '')}`;
    const conversationId = readOptionalId(body.conversationId, 'conversationId')
      ?? `agent_conversation_${randomUUID().replace(/-/g, '')}`;
    if (body.parentTaskId !== undefined) {
      readOptionalId(body.parentTaskId, 'parentTaskId');
      throw httpError(409, 'astra-v3-parent-task-unsupported', 'Astra V3 does not silently emulate V2 parent tasks. Submit an independent task or continue its exact question.');
    }
    const expectedOutputs = readExpectedOutputs(body.expectedOutputs);
    const constraints = readConstraints(body.constraints);
    const successCriteria = readSuccessCriteria(body.successCriteria);
    const userPreferences = readStringArray(body.userPreferences, 'userPreferences', 32, 1_000);
    const budgets = readAstraBudget(body.budgets);
    const autoStart = readOptionalBoolean(body.autoStart, 'autoStart');
    const requestedModel = readAstraAgentModel(body.model);
    const claimedSource = readOptionalSource(body.source);
    const source = resolveHttpTaskSource(claimedSource, context.principal.source);
    if (!['desktop', 'voice', 'api'].includes(source) || !context.authenticatedActor)
      throw httpError(503, 'astra-v3-agent-transport-unavailable', 'Authenticated Astra V3 Agent transport is unavailable.');
    const actor = context.authenticatedActor(source as 'desktop' | 'voice' | 'api');
    const specification: AstraAgentTaskSpecification = {
      schemaVersion: 'monarch.astra-v3-agent-task-specification.v1',
      ...(expectedOutputs?.length ? { expectedOutputs } : {}),
      ...(constraints?.length ? { constraints } : {}),
      ...(successCriteria?.length ? { successCriteria } : {}),
      ...(userPreferences?.length ? { userPreferences } : {}),
      ...(autoStart === false ? { startPaused: true as const } : {}),
      ...(budgets && Object.keys(budgets).length ? { budgets } : {}),
    };
    if (!isAstraAgentTaskSpecification(specification))
      throw httpError(413, 'astra-v3-task-contract-too-large', 'The typed V3 task contract exceeds its 12 KiB durable limit.');
    if (Buffer.byteLength(JSON.stringify({ request: taskRequest, specification }), 'utf8') > 24 * 1024)
      throw httpError(413, 'astra-v3-task-contract-too-large', 'The combined V3 task request and typed contract exceed 24 KiB.');
    const checkpoint = await app.oscarTurnCoordinator.submit({
      clientRequestId,
      conversationId,
      inputMessageId: `agent_message_${createHash('sha256').update(actor.id + '/' + clientRequestId).digest('hex').slice(0, 48)}`,
      text: taskRequest,
      privacyMode: 'persistent',
      source: source as 'desktop' | 'voice' | 'api',
      ...(requestedModel ? { modifiers: { requestedModel } } : {}),
      authenticatedAgentActor: actor,
      explicitAgentTask: specification,
    });
    sendJson(response, 202, { version: 1, ok: true, astraVersion: 3,
      task: astraV3TaskProjection(checkpoint.turn, astraV3View(app, checkpoint.turn)) });
    return true;
  }

  if (context.astraV3Enabled && request.method === 'GET' && url.pathname === '/api/agent/tasks') {
    context.enforceRead();
    if (!context.authenticatedActor) throw httpError(503, 'astra-v3-agent-transport-unavailable', 'Authenticated Astra V3 Agent transport is unavailable.');
    context.authenticatedActor(); // Collection enumeration itself requires an authenticated owner.
    const limit = normalizeLimit(url.searchParams.get('limit'));
    const turns = (await app.oscarTurnCoordinator.persistentStore.listTurns())
      .filter(turn => turn.request.astra?.goal.kind === 'agent')
      .filter(turn => astraTurnReadable(context, turn))
      .slice(-limit).reverse();
    sendJson(response, 200, { version: 1, ok: true, astraVersion: 3,
      tasks: turns.map(turn => astraV3TaskProjection(turn, astraV3View(app, turn))) });
    return true;
  }

  const match = url.pathname.match(/^\/api\/agent\/tasks\/([^/]+)(?:\/(messages|pause|resume|cancel|repeat|events|approvals)(?:\/([^/]+))?)?$/);
  if (!match?.[1]) throw httpError(405, 'method-not-allowed', 'Unsupported Agent Task method.');
  const taskId = decodePathId(match[1], 'taskId');
  const action = match[2] || '';
  const nestedId = match[3] ? decodePathId(match[3], action === 'approvals' ? 'approvalId' : 'nestedId') : '';
  if (request.method === 'GET') context.enforceRead();
  else if (request.method === 'POST') context.enforceMutation();
  const astraTurn = await app.oscarTurnCoordinator.getTurn(taskId)
    ?? await app.oscarTurnCoordinator.findTurnByTaskId(taskId);
  if (astraTurn?.turn.request.astra?.goal.kind === 'agent') {
    if (!astraTurnReadable(context, astraTurn.turn)) throw httpError(404, 'task-not-found', 'Agent task was not found.');
    const view = astraV3View(app, astraTurn.turn);
    if (!view || (view.id !== taskId && astraTurn.turn.id !== taskId)) throw httpError(404, 'task-not-found', 'Agent task was not found.');
    if (request.method === 'GET' && !action) {
      sendJson(response, 200, { version: 1, ok: true, astraVersion: 3,
        task: astraV3TaskProjection(astraTurn.turn, view) });
      return true;
    }
    if (request.method === 'GET' && action === 'events' && !nestedId) {
      const after = readAfterSequence(request, url);
      if (url.searchParams.get('format') === 'json' || !acceptsEventStream(request)) {
        sendJson(response, 200, { version: 1, ok: true, astraVersion: 3,
          events: astraTurn.events.filter(event => event.sequence > after).map(event => ({ version: 1, astraVersion: 3, ...event })) });
      } else streamAstraTurnEvents(app, astraTurn.turn.id, after, request, response);
      return true;
    }
    if (request.method === 'POST' && action === 'messages' && !nestedId) {
      const body = await readBoundedJson(request); assertVersion(body);
      assertKeys(body, ['version', 'content', 'messageId', 'requestId', 'questionId', 'questionDigest']);
      const content = readRequiredText(body.content, 'content', 4_096);
      const questionId = readOptionalId(body.questionId, 'questionId');
      const questionDigest = readOptionalText(body.questionDigest, 'questionDigest', 80);
      if (!view.question || questionId !== view.question.id || questionDigest !== view.question.digest)
        throw httpError(409, 'astra-input-binding', 'The exact pending question id and digest are required.');
      const messageId = readOptionalId(body.messageId, 'messageId') ?? 'agent_reply_' + createHash('sha256')
        .update(JSON.stringify([view.id, questionId, questionDigest, content])).digest('hex').slice(0, 48);
      const requestId = readOptionalId(body.requestId, 'requestId') ?? 'agent_reply_request_' + createHash('sha256')
        .update(JSON.stringify([view.id, messageId])).digest('hex').slice(0, 40);
      const updated = await app.oscarTurnCoordinator.submitAstraInput(astraTurn.turn.id, astraTurn.turn.source, {
        kind: 'reply', reply: { requestId, questionId, questionDigest, messageId, text: content },
      });
      sendJson(response, 200, { version: 1, ok: true, astraVersion: 3,
        task: astraV3TaskProjection(updated.turn, astraV3View(app, updated.turn)) });
      return true;
    }
    if (request.method === 'POST' && (action === 'pause' || action === 'resume' || action === 'cancel') && !nestedId) {
      const body = await readBoundedJson(request); assertVersion(body); assertKeys(body, ['version']);
      const updated = await app.oscarTurnCoordinator.commandAstra(astraTurn.turn.id, astraTurn.turn.source, action);
      sendJson(response, 200, { version: 1, ok: true, astraVersion: 3,
        task: astraV3TaskProjection(updated.turn, astraV3View(app, updated.turn)) });
      return true;
    }
    if (request.method === 'POST' && action === 'repeat' && !nestedId) {
      const body = await readBoundedJson(request); assertVersion(body); assertKeys(body, ['version', 'clientRequestId', 'autoStart', 'model']);
      const autoStart = readOptionalBoolean(body.autoStart, 'autoStart');
      const existingModifiers = astraTurn.turn.request.modifiers ?? {};
      const requestedModel = readAstraAgentModel(body.model) ?? existingModifiers.requestedModel;
      const clientRequestId = readOptionalId(body.clientRequestId, 'clientRequestId')
        ?? `agent_repeat_${randomUUID().replace(/-/g, '')}`;
      const actor = context.authenticatedActor?.(astraTurn.turn.source as 'desktop' | 'voice' | 'api');
      if (!actor) throw httpError(503, 'astra-v3-agent-transport-unavailable', 'Authenticated Astra V3 Agent transport is unavailable.');
      const { startPaused: _previousStartMode, ...previousSpecification } = astraTurn.turn.request.explicitAgentTask
        ?? { schemaVersion: 'monarch.astra-v3-agent-task-specification.v1' as const };
      const repeated = await app.oscarTurnCoordinator.submit({
        clientRequestId, conversationId: astraTurn.turn.conversationId,
        inputMessageId: `agent_message_${createHash('sha256').update(actor.id + '/' + clientRequestId).digest('hex').slice(0, 48)}`,
        text: astraTurn.turn.request.text, privacyMode: 'persistent', source: astraTurn.turn.source,
        modifiers: { ...existingModifiers, ...(requestedModel ? { requestedModel } : {}) },
        authenticatedAgentActor: actor,
        explicitAgentTask: { ...previousSpecification, ...(autoStart === false ? { startPaused: true as const } : {}) },
      });
      sendJson(response, 202, { version: 1, ok: true, astraVersion: 3,
        task: astraV3TaskProjection(repeated.turn, astraV3View(app, repeated.turn)) });
      return true;
    }
    if (request.method === 'POST' && action === 'approvals' && nestedId) {
      const body = await readBoundedJson(request); assertVersion(body);
      assertKeys(body, ['version', 'decision', 'grantScope', 'requestId', 'reason', 'canonicalProposalHash', 'capabilityId']);
      if (body.decision !== 'arm' && body.decision !== 'approve' && body.decision !== 'deny')
        throw httpError(400, 'invalid-approval-decision', 'decision must be arm, approve, or deny.');
      if (body.grantScope !== undefined && body.grantScope !== 'once')
        throw httpError(400, 'invalid-grant-scope', 'Astra V3 approvals are exact one-shot decisions.');
      const requestId = readOptionalId(body.requestId, 'requestId');
      const canonicalProposalHash = readOptionalText(body.canonicalProposalHash, 'canonicalProposalHash', 256);
      const capabilityId = readOptionalText(body.capabilityId, 'capabilityId', 256);
      const approval = view.approval;
      if (!approval || !('capability' in approval) || approval.id !== nestedId
        || approval.proposalHash !== canonicalProposalHash || approval.capability.id !== capabilityId)
        throw httpError(409, 'approval-binding-mismatch', 'The pending action changed. Review its exact target before approving again.');
      if (body.decision === 'arm') {
        sendJson(response, 200, { version: 1, ok: true, astraVersion: 3,
          task: astraV3TaskProjection(astraTurn.turn, view),
          arm: { exactOneShot: true, expiresAt: new Date(approval.expiresAt).toISOString() } });
        return true;
      }
      const messageId = 'astra_decision_' + createHash('sha256').update(JSON.stringify(
        [view.id, nestedId, requestId ?? '', body.decision])).digest('hex').slice(0, 48);
      const updated = await app.oscarTurnCoordinator.submitAstraInput(astraTurn.turn.id, astraTurn.turn.source, { kind: 'decide', decision: {
        approvalId: approval.id, approvalDigest: approval.digest, messageId,
        decision: body.decision === 'approve' ? 'approve' : 'reject',
      } });
      sendJson(response, 200, { version: 1, ok: true, astraVersion: 3,
        task: astraV3TaskProjection(updated.turn, astraV3View(app, updated.turn)) });
      return true;
    }
    throw httpError(405, 'method-not-allowed', 'Unsupported Astra V3 Agent Task method.');
  }
  throw httpError(404, 'task-not-found', 'Astra V3 Agent task was not found.');
}

function readAstraBudget(value: unknown): AstraAgentTaskSpecification['budgets'] | undefined {
  const budget = readBudget(value);
  if (!budget) return undefined;
  const unsupported = ['maxSteps', 'maxFailures', 'maxConsecutiveNoProgress', 'maxComputeClass']
    .filter(key => (budget as Record<string, unknown>)[key] !== undefined);
  if (unsupported.length) throw httpError(409, 'astra-v3-budget-unsupported',
    `Astra V3 does not silently emulate these V2 budgets: ${unsupported.join(', ')}.`);
  if (budget.maxModelTurns !== undefined && (budget.maxModelTurns < 2 || budget.maxModelTurns > 64)
    || budget.maxToolCalls !== undefined && (budget.maxToolCalls < 1 || budget.maxToolCalls > 48)
    || budget.maxWallTimeMs !== undefined && (budget.maxWallTimeMs < 1_000 || budget.maxWallTimeMs > 12 * 60 * 60 * 1_000)) {
    throw httpError(400, 'invalid-budget', 'Astra V3 budgets exceed the native Agent Runtime limits.');
  }
  return {
    ...(budget.maxModelTurns !== undefined ? { maxModelTurns: budget.maxModelTurns } : {}),
    ...(budget.maxToolCalls !== undefined ? { maxToolCalls: budget.maxToolCalls } : {}),
    ...(budget.maxWallTimeMs !== undefined ? { maxWallTimeMs: budget.maxWallTimeMs } : {}),
  };
}

function astraTurnReadable(context: AgentTaskHttpContext, turn: OscarTurnV1): boolean {
  // Legacy test/composition hosts never exposed an Astra actor callback. The
  // product V3 host always does and therefore takes the exact actor-bound path.
  if (!context.astraV3Enabled) return context.principal.source === 'desktop' || turn.source === 'api';
  if (!turn.request.astra || !context.authenticatedActor) return false;
  if (context.principal.source === 'api' && turn.source !== 'api') return false;
  // Coder is a desktop-owned projection surface. Its actor is still a separate
  // domain-separated principal, so a Desktop credential may operate on the
  // task only after reproducing and matching that exact Coder actor binding.
  if (context.principal.source === 'desktop' && !['desktop', 'voice', 'coder'].includes(turn.source)) return false;
  try {
    const actor = context.authenticatedActor(turn.source as 'desktop' | 'voice' | 'api' | 'coder');
    return actor.id === turn.request.astra.actor.id && actor.source === turn.request.astra.actor.source;
  } catch { return false; }
}

function astraV3TaskProjection(turn: OscarTurnV1, view: AstraTaskHttpTask | null) {
  const specification = turn.request.explicitAgentTask;
  return {
    id: turn.id,
    turnId: turn.id,
    ...(view ? { runtimeTaskId: view.id } : turn.taskId ? { runtimeTaskId: turn.taskId } : {}),
    // Oscar's outer `succeeded` means only that a terminal projection was
    // delivered. Preserve Astra's actual `partial`/`blocked` outcome so clients
    // never present an uncertified incomplete task as successful.
    status: view?.status ?? turn.status,
    source: { surface: turn.source, remote: turn.source === 'api' },
    goal: {
      originalRequest: turn.request.text,
      ...(specification?.expectedOutputs ? { expectedOutputs: specification.expectedOutputs } : {}),
      ...(specification?.constraints ? { constraints: specification.constraints } : {}),
      ...(specification?.successCriteria ? { successCriteria: specification.successCriteria } : {}),
      ...(specification?.userPreferences ? { userPreferences: specification.userPreferences } : {}),
    },
    ...(specification?.budgets ? { budgets: specification.budgets } : {}),
    ...(turn.request.modifiers?.requestedModel ? { model: turn.request.modifiers.requestedModel } : {}),
    modelTurns: view?.modelJobs ?? 0,
    capabilityCalls: view?.capabilityJobs ?? 0,
    nativeCompletionCertified: view?.nativeCompletionCertified ?? false,
    ...(view?.failureReason ? { failureReason: view.failureReason } : {}),
    ...(view?.message ? { message: view.message } : {}),
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
}

function astraV3View(app: MonarchApplication, turn: OscarTurnV1): AstraTaskHttpTask | null {
  if (turn.request.astra?.goal.kind !== 'agent' || !app.astraProductPilot) return null;
  try { return app.astraProductPilot.bridge.find(turn); } catch { return null; }
}

function streamAstraTurnEvents(
  app: MonarchApplication,
  turnId: string,
  after: number,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.flushHeaders?.();
  let cursor = after, initialized = false, closed = false;
  const buffered: OscarTurnCheckpoint[] = [];
  const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); if (!response.writableEnded) response.end(); };
  const emit = (checkpoint: OscarTurnCheckpoint) => {
    for (const event of checkpoint.events.filter(candidate => candidate.sequence > cursor)) {
      response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ version: 1, astraVersion: 3, turnId, event })}\n\n`);
      cursor = event.sequence;
    }
    if (['succeeded', 'blocked', 'failed', 'cancelled'].includes(checkpoint.turn.status)) close();
  };
  const unsubscribe = app.oscarTurnCoordinator.subscribe(turnId, commit => {
    if (!initialized) buffered.push({ turn: commit.turn, events: commit.appendedEvents });
    else emit({ turn: commit.turn, events: commit.appendedEvents });
  });
  const heartbeat = setInterval(() => { if (!closed) response.write(': keep-alive\n\n'); }, 15_000);
  heartbeat.unref?.(); request.once('close', close);
  void app.oscarTurnCoordinator.getTurn(turnId).then(checkpoint => {
    if (!checkpoint || closed) return close();
    emit(checkpoint); initialized = true;
    for (const commit of buffered.splice(0)) { if (closed) break; emit(commit); }
  }).catch(close);
}

function resolveHttpTaskSource(
  claimedSource: AgentTaskSurface | undefined,
  httpSource: Extract<AgentTaskSurface, 'desktop' | 'api'>,
): AgentTaskSurface {
  if (httpSource === 'desktop' && claimedSource === 'voice') {
    // Voice is a narrower local UI surface than Desktop: it cannot access
    // destructive local capabilities because Kernel rechecks supportedSources.
    return 'voice';
  }
  if (claimedSource && claimedSource !== httpSource) {
    throw httpError(
      403,
      'untrusted-agent-source',
      `HTTP Agent Task source is derived by Monarch as ${httpSource}; callers cannot claim ${claimedSource}.`,
    );
  }
  return httpSource;
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

function readOptionalSource(value: unknown): AgentTaskSurface | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !AGENT_TASK_SURFACES.has(value)) {
    throw httpError(400, 'invalid-source', 'source must be a supported Agent Task surface name.');
  }
  return value as AgentTaskSurface;
}

function readAstraAgentModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const model = readRequiredText(value, 'model', 200);
  if (!isExecutableMaxRole(model) && !isAstraLocalAgentModelChoice(model)) {
    throw httpError(400, 'invalid-agent-model', 'Agent Task model must name an exact executable local or MAX model role.');
  }
  return model;
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
