import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import type {
  MonarchApplication,
  MonarchActionProposalSubmission,
  MonarchCapabilityExecution,
  MonarchIntentJobSubmission,
  MonarchIntentSubmission,
} from './application';
import { getAgentSkillRegistry } from '../modules/astra/agent-skills';
import type { MonarchApprovalPolicy, MonarchAutonomyMode, MonarchSandboxMode } from '../core';
import { CoderAgentController } from './coder-agent-controller';
import type { CoderModelId } from '../modules/coder/types';
import { handleAgentTaskHttpRequest } from './agent-task-http';

export interface MonarchHttpServerOptions {
  app: MonarchApplication;
  publicDirectory: string;
  host?: string;
  port?: number;
  apiToken?: string;
  requireApiToken?: boolean;
  allowNonLoopbackMutations?: boolean;
}

export interface MonarchHttpServerHandle {
  server: Server;
  url: string;
  apiToken: string;
  requireApiToken: boolean;
  close(): Promise<void>;
}

interface JsonError {
  statusCode: number;
  code: string;
  message: string;
}

interface MonarchHttpSession {
  apiToken: string;
  requireApiToken: boolean;
  origin: string;
  allowNonLoopbackMutations: boolean;
}

const MAX_JSON_BODY_BYTES = 50 * 1024 * 1024; // 50MB
const INTERNAL_ERROR_MESSAGE = 'Monarch столкнулся с внутренней ошибкой. Детали остались в локальных логах.';
const STREAM_ERROR_MESSAGE = 'Поток ответа прервался. Попробуй повторить запрос.';
const coderControllers = new WeakMap<MonarchApplication, CoderAgentController>();

export function createMonarchHttpServer(options: MonarchHttpServerOptions): Server {
  const publicRoot = path.resolve(options.publicDirectory);
  const session = createHttpSession(options);

  return createServer((request, response) => {
    void handleRequest(options.app, publicRoot, session, request, response).catch((error: unknown) => {
      const normalized = normalizeError(error);
      sendJson(response, normalized.statusCode, {
        ...(isAgentTaskApiRequest(request.url) ? { version: 1 } : {}),
        ok: false,
        error: normalized.code,
        message: normalized.message,
      });
    });
  });
}

function isAgentTaskApiRequest(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname;
    return pathname === '/api/agent/tasks' || pathname.startsWith('/api/agent/tasks/');
  } catch {
    return false;
  }
}

export async function startMonarchHttpServer(
  options: MonarchHttpServerOptions
): Promise<MonarchHttpServerHandle> {
  await options.app.start();
  const host = options.host || '127.0.0.1';
  const port = options.port || 4317;
  const session = createHttpSession({ ...options, host, port });
  const server = createMonarchHttpServer({
    ...options,
    host,
    port,
    apiToken: session.apiToken,
    requireApiToken: session.requireApiToken,
    allowNonLoopbackMutations: session.allowNonLoopbackMutations,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    url: `http://${host}:${port}`,
    apiToken: session.apiToken,
    requireApiToken: session.requireApiToken,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  app: MonarchApplication,
  publicRoot: string,
  session: MonarchHttpSession,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);

  if (request.method === 'GET' && url.pathname === '/api/ready') {
    sendJson(response, 200, { ok: true, ready: true });
    return;
  }

  if (await handleAgentTaskHttpRequest({
    app,
    url,
    request,
    response,
    enforceMutation: () => enforceMutationGuards(request, session),
    enforceRead: () => enforceReadApiToken(request, session),
  })) {
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/coder') {
    enforceReadApiToken(request, session);
    const coder = getCoderController(app);
    const projects = coder.listProjects();
    const active = projects.activeProjectId
      ? await coder.projectSnapshot(projects.activeProjectId).catch(() => null)
      : null;
    sendJson(response, 200, { ok: true, projects, active, runs: coder.runs.list(projects.activeProjectId || undefined) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/coder/projects') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<{ action?: string; name?: string; path?: string; projectId?: string }>(request);
    const coder = getCoderController(app);
    let project;
    if (body.action === 'create') project = await coder.createProject(String(body.name || ''));
    else if (body.action === 'import') project = await coder.importProject(String(body.path || ''), typeof body.name === 'string' ? body.name : undefined);
    else if (body.action === 'activate') project = await coder.activateProject(String(body.projectId || ''));
    else throw badRequest('invalid-coder-project-action', 'Coder project action must be create, import, or activate.');
    sendJson(response, 200, { ok: true, project });
    return;
  }

  const coderProjectMatch = url.pathname.match(/^\/api\/coder\/projects\/([^/]+)$/);
  if (request.method === 'GET' && coderProjectMatch?.[1]) {
    enforceReadApiToken(request, session);
    const projectId = decodeURIComponent(coderProjectMatch[1]);
    sendJson(response, 200, { ok: true, project: await getCoderController(app).projectSnapshot(projectId) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/coder/runs') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<{ prompt?: string; projectId?: string; model?: string }>(request);
    const projectId = String(body.projectId || '').trim();
    if (!projectId) throw badRequest('missing-coder-project', 'Select an explicit Coder project before starting a run.');
    const model: CoderModelId = body.model === 'deepseek-coder-v2-lite-instruct'
      ? 'deepseek-coder-v2-lite-instruct'
      : 'qwen3-coder-30b-a3b-instruct';
    const run = getCoderController(app).start(String(body.prompt || ''), projectId, model);
    sendJson(response, 202, { ok: true, run });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/coder/runs') {
    enforceReadApiToken(request, session);
    sendJson(response, 200, { ok: true, runs: getCoderController(app).runs.list(url.searchParams.get('projectId') || undefined) });
    return;
  }

  const coderRunMatch = url.pathname.match(/^\/api\/coder\/runs\/([^/]+)$/);
  if (request.method === 'DELETE' && coderRunMatch?.[1]) {
    enforceMutationGuards(request, session);
    const run = getCoderController(app).runs.delete(decodeURIComponent(coderRunMatch[1]));
    sendJson(response, 200, { ok: true, deleted: run.id });
    return;
  }
  if (request.method === 'GET' && coderRunMatch?.[1]) {
    enforceReadApiToken(request, session);
    const run = getCoderController(app).runs.get(decodeURIComponent(coderRunMatch[1]));
    if (!run) { sendJson(response, 404, { ok: false, error: 'coder-run-not-found' }); return; }
    sendJson(response, 200, { ok: true, run });
    return;
  }

  const coderCancelMatch = url.pathname.match(/^\/api\/coder\/runs\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && coderCancelMatch?.[1]) {
    enforceMutationGuards(request, session);
    sendJson(response, 200, { ok: true, run: await getCoderController(app).cancel(decodeURIComponent(coderCancelMatch[1])) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/coder/fast-chat') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<{ message?: string; history?: Array<{ role: string; content: string }> }>(request);
    const message = String(body.message || '').trim();
    if (!message) throw badRequest('empty-fast-chat-message', 'Fast chat message is required.');
    const history = Array.isArray(body.history)
      ? body.history.filter((entry) => (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string').slice(-10)
      : [];
    const result = await app.executeCapability({
      moduleId: 'oscar',
      capabilityId: 'oscar.chat.local',
      requestedBy: 'coder-fast-chat',
      input: {
        messages: [...history, { role: 'user', content: message }],
        incognito: true,
        use_memory: false,
        research_mode: 'off',
        reasoning_effort: 'low',
        requested_model: 'gemma4-fast',
        model_selection_source: 'user-explicit',
        max_new_tokens: 1_024,
        temperature: 0.35,
        top_p: 0.9,
      },
    });
    sendJson(response, result.ok ? 200 : 503, { ok: result.ok, result });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    enforceReadApiToken(request, session);
    sendJson(response, 200, await app.getState(url.searchParams.get('input') || ''));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    const state = await app.getState(url.searchParams.get('input') || '');
    sendJson(response, 200, {
      ok: state.runtime.health.ok,
      app: state.app,
      health: state.runtime.health,
      loadRecords: state.runtime.loadRecords,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/system') {
    enforceReadApiToken(request, session);
    sendJson(response, 200, app.getSystemProfile());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/modules') {
    const state = await app.getState();
    sendJson(response, 200, {
      modules: state.runtime.snapshot.modules,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/capabilities') {
    const moduleId = url.searchParams.get('moduleId') || '';
    const state = await app.getState();
    const capabilities = moduleId
      ? state.runtime.snapshot.capabilities.filter((capability) => capability.moduleId === moduleId)
      : state.runtime.snapshot.capabilities;
    sendJson(response, 200, { capabilities });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events') {
    enforceReadApiToken(request, session);
    const limit = normalizeLimit(url.searchParams.get('limit'));
    const state = await app.getState();
    sendJson(response, 200, {
      events: state.runtime.snapshot.events.slice(-limit).reverse(),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/intent') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<Partial<MonarchIntentSubmission>>(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw badRequest('empty-intent', 'Intent text is required.');
    }

    const submission: MonarchIntentSubmission = {
      text,
      confirmed: Boolean(body.confirmed),
      context: readContext(body.context),
    };
    if (submission.confirmed && typeof body.confirmationToken !== 'string') {
      throw badRequest('missing-confirmation-token', 'Confirmed intent execution requires a confirmation token.');
    }
    if (typeof body.confirmationToken === 'string') {
      submission.confirmationToken = body.confirmationToken;
    }
    if (body.source) {
      submission.source = body.source;
    }

    const result = await app.submitIntent(submission);
    sendJson(response, 200, {
      ok: true,
      result,
      state: await app.getState(text),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/intent-jobs') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<Partial<MonarchIntentJobSubmission>>(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw badRequest('empty-intent', 'Intent text is required.');
    }

    const submission: MonarchIntentJobSubmission = {
      text,
      confirmed: Boolean(body.confirmed),
      context: readContext(body.context),
    };
    if (typeof body.timeoutMs === 'number') {
      submission.timeoutMs = body.timeoutMs;
    }
    if (submission.confirmed && typeof body.confirmationToken !== 'string') {
      throw badRequest('missing-confirmation-token', 'Confirmed intent execution requires a confirmation token.');
    }
    if (typeof body.confirmationToken === 'string') {
      submission.confirmationToken = body.confirmationToken;
    }
    if (body.source) {
      submission.source = body.source;
    }

    const job = await app.submitIntentJob(submission);
    sendJson(response, 202, {
      ok: true,
      job,
      state: await app.getState(text),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/intent-jobs') {
    enforceReadApiToken(request, session);
    sendJson(response, 200, {
      ok: true,
      jobs: app.listIntentJobs(normalizeLimit(url.searchParams.get('limit'))),
    });
    return;
  }

  const intentJobMatch = url.pathname.match(/^\/api\/intent-jobs\/([^/]+)$/);
  if (request.method === 'GET' && intentJobMatch?.[1]) {
    enforceReadApiToken(request, session);
    const job = app.getIntentJob(decodeURIComponent(intentJobMatch[1]));
    if (!job) {
      sendJson(response, 404, {
        ok: false,
        error: 'job-not-found',
        message: 'Intent job was not found.',
      });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      job,
      state: await app.getState(job.text),
    });
    return;
  }

  const streamIntentJobMatch = url.pathname.match(/^\/api\/intent-jobs\/([^/]+)\/stream$/);
  if (request.method === 'GET' && streamIntentJobMatch?.[1]) {
    enforceReadApiToken(request, session);
    const jobId = decodeURIComponent(streamIntentJobMatch[1]);
    const job = app.getIntentJob(jobId);
    if (!job) {
      sendJson(response, 404, { ok: false, error: 'job-not-found' });
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    response.write(`event: started\ndata: {}\n\n`);

    let isClientClosed = false;
    let checkInterval: ReturnType<typeof setInterval> | null = null;
    const unsubscribers: Array<() => void> = [];
    const cleanup = () => {
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    };
    const emitJobEvent = (eventName: string, data: unknown) => {
      if (!isClientClosed) {
        response.write(`event: ${eventName}\ndata: ${formatSseData(data)}\n\n`);
      }
    };
    unsubscribers.push(app.runtime.kernel.subscribeEvent('assistant.token', (event) => {
      const payload: any = event.payload || {};
      if (payload.intentId === jobId && payload.token) {
        response.write(`event: token\ndata: ${formatSseData({ token: payload.token })}\n\n`);
      }
    }));
    unsubscribers.push(app.runtime.kernel.subscribeEvent('intent.routed', (event) => {
      const payload: any = event.payload || {};
      if (payload.intentId !== jobId) return;
      const route = payload.route || {};
      emitJobEvent('route', {
        moduleId: route.targetModuleId,
        capabilityId: route.capabilityId,
        message: `Oscar выбрал ${route.targetModuleId || 'модуль'} · ${route.capabilityId || 'действие'}`,
      });
    }));
    unsubscribers.push(app.runtime.kernel.subscribeEvent('plan.execution.started', (event) => {
      const payload: any = event.payload || {};
      if (payload.intentId === jobId) emitJobEvent('status', { phase: 'plan', message: 'План готов, начинаю выполнение' });
    }));
    unsubscribers.push(app.runtime.kernel.subscribeEvent('capability.execution.started', (event) => {
      const payload: any = event.payload || {};
      if (payload.intentId !== jobId) return;
      if (isInternalAgentProgressCapability(payload.moduleId, payload.capabilityId)) return;
      emitJobEvent('capability-started', {
        moduleId: payload.moduleId,
        capabilityId: payload.capabilityId,
        message: `${payload.moduleId} выполняет ${payload.capabilityId}`,
      });
    }));
    unsubscribers.push(app.runtime.kernel.subscribeEvent('permission.evaluated', (event) => {
      const payload: any = event.payload || {};
      if (payload.intentId !== jobId && !String(payload.requestId || '').includes(jobId)) return;
      if (isInternalAgentProgressCapability(payload.moduleId, payload.capabilityId)) return;
      emitJobEvent('permission', {
        moduleId: payload.moduleId,
        capabilityId: payload.capabilityId,
        mode: payload.permission?.mode,
        message: payload.permission?.mode === 'confirm' ? 'Требуется твоё подтверждение' : 'Проверка доступа пройдена',
      });
    }));
    unsubscribers.push(app.runtime.kernel.subscribeEvent('capability.execution.finished', (event) => {
      const payload: any = event.payload || {};
      if (payload.intentId !== jobId) return;
      if (isInternalAgentProgressCapability(payload.moduleId, payload.capabilityId)) return;
      emitJobEvent('capability-finished', {
        moduleId: payload.moduleId,
        capabilityId: payload.capabilityId,
        ok: payload.ok,
        message: payload.ok ? 'Операция завершена, Oscar анализирует результат' : 'Операция завершилась с ошибкой',
      });
    }));

    response.on('close', () => {
      isClientClosed = true;
      cleanup();
    });

    const finishIfTerminal = () => {
      const currentJob = app.getIntentJob(jobId);
      if (isClientClosed || !currentJob || ['completed', 'failed', 'cancelled', 'timeout'].includes(currentJob.status)) {
        cleanup();
        if (!isClientClosed) {
          response.write(`event: done\ndata: {}\n\n`);
          response.end();
        }
        return true;
      }
      return false;
    };

    if (!finishIfTerminal()) {
      checkInterval = setInterval(finishIfTerminal, 1000);
    }

    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/capabilities/search') {
    const query = (url.searchParams.get('query') || '').trim().toLowerCase();
    const limit = Math.min(normalizeLimit(url.searchParams.get('limit')), 80);
    const capabilities = app.runtime.kernel.listCapabilities()
      .filter((capability) => !query || `${capability.id} ${capability.moduleId} ${capability.title} ${capability.description}`.toLowerCase().includes(query))
      .slice(0, limit);
    sendJson(response, 200, { ok: true, query, capabilities });
    return;
  }

  const capabilityDetailMatch = url.pathname.match(/^\/api\/capabilities\/([^/]+)$/);
  if (request.method === 'GET' && capabilityDetailMatch?.[1]) {
    const capability = app.runtime.kernel.getCapability(decodeURIComponent(capabilityDetailMatch[1]));
    if (!capability) {
      sendJson(response, 404, { ok: false, error: 'capability-not-found' });
      return;
    }
    sendJson(response, 200, { ok: true, capability });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/skills') {
    enforceReadApiToken(request, session);
    const registry = getAgentSkillRegistry(app.workspaceRoot);
    const query = (url.searchParams.get('query') || '').trim();
    if (query) {
      const matches = await registry.match(query, {
        limit: normalizeSkillLimit(url.searchParams.get('limit')),
      });
      sendJson(response, 200, { ok: true, query, matches });
      return;
    }
    const skills = await registry.list({
      refresh: url.searchParams.get('refresh') === 'true',
    });
    sendJson(response, 200, {
      ok: true,
      skills,
      progressiveDisclosure: true,
      invocation: ['implicit', '$skill', '/skill'],
    });
    return;
  }

  const activateSkillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/activate$/);
  if (request.method === 'GET' && activateSkillMatch?.[1]) {
    enforceReadApiToken(request, session);
    const skillId = decodeURIComponent(activateSkillMatch[1]);
    const prompt = url.searchParams.get('prompt') || '';
    const skill = await getAgentSkillRegistry(app.workspaceRoot).activate(skillId, prompt, { explicit: true });
    if (!skill) {
      sendJson(response, 404, { ok: false, error: 'skill-not-found' });
      return;
    }
    sendJson(response, 200, { ok: true, skill });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/permissions') {
    enforceReadApiToken(request, session);
    sendJson(response, 200, { ok: true, profile: app.getPermissionProfile() });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/permissions') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const autonomyMode = normalizeAutonomyMode(body.autonomyMode);
    const sandboxMode = normalizeSandboxMode(body.sandboxMode)
      || (autonomyMode === 'guided' ? 'read-only' : autonomyMode === 'full-local' ? 'danger-full-access' : autonomyMode === 'workspace-autonomous' ? 'workspace-write' : null);
    const approvalPolicy = normalizeApprovalPolicy(body.approvalPolicy) || (autonomyMode ? 'on-request' : null);
    if (!sandboxMode || !approvalPolicy) {
      throw badRequest('invalid-permission-profile', 'A valid autonomyMode or sandboxMode/approvalPolicy pair is required.');
    }
    const profile = app.setPermissionProfile({ sandboxMode, approvalPolicy, ...(autonomyMode ? { autonomyMode } : {}) });
    sendJson(response, 200, { ok: true, profile });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/agent/proposals') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<Record<string, unknown>>(request);
    if (!body.proposal || typeof body.proposal !== 'object' || Array.isArray(body.proposal)) {
      throw badRequest('invalid-action-proposal', 'A typed action proposal object is required.');
    }
    const confirmed = body.confirmed === true;
    if (confirmed && typeof body.confirmationToken !== 'string') {
      throw badRequest('missing-confirmation-token', 'Confirmed action proposal requires a confirmation token.');
    }
    const submission: MonarchActionProposalSubmission = {
      proposal: body.proposal as MonarchActionProposalSubmission['proposal'],
      confirmed,
      originatingUserText: readBoundedContextText(body.originatingUserText, 8_000),
      requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'api:model-proposal',
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(Array.isArray(body.skillIds) ? { skillIds: body.skillIds.filter((entry): entry is string => typeof entry === 'string').slice(0, 8) } : {}),
      ...(typeof body.leaseId === 'string' ? { leaseId: body.leaseId } : {}),
      ...(body.grantScope === 'task' || body.grantScope === 'once' ? { grantScope: body.grantScope } : {}),
      ...(typeof body.confirmationToken === 'string' ? { confirmationToken: body.confirmationToken } : {}),
    };
    let proposalResult;
    try {
      proposalResult = await app.submitActionProposal(submission);
    } catch (error) {
      if (error instanceof Error && (error.name === 'MonarchActionProtocolError' || /Unknown action proposal capability/i.test(error.message))) {
        throw badRequest('invalid-action-proposal', error.message);
      }
      throw error;
    }
    sendJson(response, 200, { ok: proposalResult.result.ok, ...proposalResult });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent/leases') {
    enforceReadApiToken(request, session);
    sendJson(response, 200, { ok: true, leases: app.listCapabilityLeases(url.searchParams.get('active') === 'true') });
    return;
  }

  const revokeLeaseMatch = url.pathname.match(/^\/api\/agent\/leases\/([^/]+)\/revoke$/);
  if (request.method === 'POST' && revokeLeaseMatch?.[1]) {
    enforceMutationGuards(request, session);
    const lease = app.revokeCapabilityLease(decodeURIComponent(revokeLeaseMatch[1]));
    if (!lease) {
      sendJson(response, 404, { ok: false, error: 'lease-not-found' });
      return;
    }
    sendJson(response, 200, { ok: true, lease });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent/ledger') {
    enforceReadApiToken(request, session);
    sendJson(response, 200, { ok: true, actions: app.listActionLedger(normalizeLimit(url.searchParams.get('limit'))) });
    return;
  }

  const rollbackActionMatch = url.pathname.match(/^\/api\/agent\/ledger\/([^/]+)\/rollback$/);
  if (request.method === 'POST' && rollbackActionMatch?.[1]) {
    enforceMutationGuards(request, session);
    const rollback = await app.rollbackAction(decodeURIComponent(rollbackActionMatch[1]));
    if (!rollback) {
      sendJson(response, 404, { ok: false, error: 'rollback-not-found' });
      return;
    }
    sendJson(response, rollback.status === 'rolled-back' ? 200 : 409, {
      ok: rollback.status === 'rolled-back',
      rollback,
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/agent/dispatch') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw badRequest('empty-agent-action', 'Agent action text is required.');
    }
    const confirmed = body.confirmed === true;
    const submission: MonarchIntentSubmission = {
      text,
      source: 'api',
      confirmed,
      context: {
        agentDispatch: true,
        excludedModuleIds: ['assistant', 'oscar'],
      },
    };
    if (confirmed) {
      if (typeof body.confirmationToken !== 'string') {
        throw badRequest('missing-confirmation-token', 'Confirmed agent action requires a confirmation token.');
      }
      submission.confirmationToken = body.confirmationToken;
    }
    const result = await app.submitIntent(submission);
    sendJson(response, 200, {
      ok: true,
      handled: Boolean(result.route),
      result,
      profile: app.getPermissionProfile(),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/agent/jobs') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw badRequest('empty-agent-action', 'Agent action text is required.');
    }
    const confirmed = body.confirmed === true;
    const clientContext = readContext(body.context);
    const submission: MonarchIntentJobSubmission = {
      text,
      source: 'api',
      confirmed,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : 180000,
      context: {
        ...clientContext,
        agentDispatch: true,
        excludedModuleIds: ['assistant', 'oscar'],
        modelProposed: clientContext.modelProposed === true,
        originatingUserText: readBoundedContextText(clientContext.originatingUserText, 4000),
        proposalReason: readBoundedContextText(clientContext.proposalReason, 500),
      },
    };
    if (confirmed) {
      if (typeof body.confirmationToken !== 'string') {
        throw badRequest('missing-confirmation-token', 'Confirmed agent action requires a confirmation token.');
      }
      submission.confirmationToken = body.confirmationToken;
    }
    const job = await app.submitIntentJob(submission);
    sendJson(response, 202, { ok: true, job, profile: app.getPermissionProfile() });
    return;
  }

  const cancelIntentJobMatch = url.pathname.match(/^\/api\/intent-jobs\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelIntentJobMatch?.[1]) {
    enforceMutationGuards(request, session);
    const job = app.cancelIntentJob(decodeURIComponent(cancelIntentJobMatch[1]));
    if (!job) {
      sendJson(response, 404, {
        ok: false,
        error: 'job-not-found',
        message: 'Intent job was not found.',
      });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      job,
      state: await app.getState(job.text),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/execute') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<Partial<MonarchCapabilityExecution> & { includeState?: boolean }>(request);
    const moduleId = typeof body.moduleId === 'string' ? body.moduleId.trim() : '';
    const capabilityId = typeof body.capabilityId === 'string' ? body.capabilityId.trim() : '';
    if (!moduleId || !capabilityId) {
      throw badRequest('empty-execution-target', 'moduleId and capabilityId are required.');
    }

    const execution: MonarchCapabilityExecution = {
      moduleId,
      capabilityId,
      input: body.input,
      requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'api',
      confirmed: Boolean(body.confirmed),
    };
    if (execution.confirmed && typeof body.confirmationToken !== 'string') {
      throw badRequest('missing-confirmation-token', 'Confirmed capability execution requires a confirmation token.');
    }
    if (typeof body.confirmationToken === 'string') {
      execution.confirmationToken = body.confirmationToken;
    }
    if (typeof body.intentId === 'string') {
      execution.intentId = body.intentId;
    }

    const result = await app.executeCapability(execution);

    const clientIp = request.socket.remoteAddress || 'unknown';
    const auditMessage = `Direct API capability execution: ${moduleId}.${capabilityId} requested by '${execution.requestedBy}' (confirmed: ${execution.confirmed}).`;
    app.runtime.kernel.audit(
      'security',
      auditMessage,
      {
        moduleId,
        capabilityId,
        requestedBy: execution.requestedBy,
        confirmed: execution.confirmed,
        ok: result.ok,
        error: result.error || null,
        clientIp,
        userAgent: request.headers['user-agent'] || 'none',
      },
      result.ok ? 'info' : result.error === 'confirmation-required' ? 'warn' : 'error'
    );

    sendJson(response, 200, {
      ok: result.ok,
      result,
      ...(body.includeState === false ? {} : { state: await app.getState() }),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/execute-stream') {
    enforceMutationGuards(request, session);
    const body = await readJsonBody<Partial<MonarchCapabilityExecution>>(request);
    const moduleId = typeof body.moduleId === 'string' ? body.moduleId.trim() : '';
    const capabilityId = typeof body.capabilityId === 'string' ? body.capabilityId.trim() : '';
    if (!moduleId || !capabilityId) {
      throw badRequest('empty-execution-target', 'moduleId and capabilityId are required.');
    }

    const execution: MonarchCapabilityExecution = {
      moduleId,
      capabilityId,
      input: body.input,
      requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'api',
      confirmed: Boolean(body.confirmed),
    };
    if (execution.confirmed && typeof body.confirmationToken !== 'string') {
      throw badRequest('missing-confirmation-token', 'Confirmed capability execution requires a confirmation token.');
    }
    if (typeof body.confirmationToken === 'string') {
      execution.confirmationToken = body.confirmationToken;
    }
    if (typeof body.intentId === 'string') {
      execution.intentId = body.intentId;
    }

    const result = await app.executeCapability(execution);

    if (result.ok && result.output && typeof (result.output as any).stream === 'object') {
      const stream = (result.output as any).stream;
      if (typeof stream[Symbol.asyncIterator] === 'function') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        let terminalEventSeen = false;
        try {
          // Listen for client disconnect to stop the generator
          let isClientClosed = false;
          request.on('aborted', () => {
            isClientClosed = true;
          });
          response.on('close', () => {
            if (!response.writableEnded) isClientClosed = true;
          });
          // Yield a 'started' event just in case
          response.write(`event: started\ndata: {}\n\n`);

          for await (const chunk of stream) {
            if (isClientClosed) break; // Exit the loop if client disconnected

            if (chunk && chunk.type) {
              if (chunk.type === 'done') terminalEventSeen = true;
              response.write(`event: ${formatSseEventName(chunk.type)}\ndata: ${formatSseData(chunk.data)}\n\n`);
            }
          }
        } catch (e) {
          if (!terminalEventSeen) {
            response.write(`event: error\ndata: ${formatSseData({ code: 'stream-error', message: STREAM_ERROR_MESSAGE })}\n\n`);
          }
        } finally {
          response.end();
          if (typeof stream.return === 'function') {
            try { await stream.return(); } catch (_) {}
          }
        }
        return;
      }
    }

    sendJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      result,
      state: await app.getState(),
    });
    return;
  }

  if (request.method === 'GET') {
    await serveStatic(publicRoot, url.pathname, request, response, session);
    return;
  }

  sendJson(response, 405, {
    ok: false,
    error: 'method-not-allowed',
  });
}

async function serveStatic(
  publicRoot: string,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  session: MonarchHttpSession
): Promise<void> {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    sendJson(response, 400, {
      ok: false,
      error: 'bad-path',
    });
    return;
  }

  const resolvedPath = path.resolve(publicRoot, `.${decodedPath}`);

  if (!isPathInsideRoot(resolvedPath, publicRoot, { allowRoot: true })) {
    sendJson(response, 403, {
      ok: false,
      error: 'forbidden',
    });
    return;
  }

  try {
    const realPublicRoot = await realpath(publicRoot).catch(() => publicRoot);
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      throw new Error('Not a file.');
    }
    const realResolvedPath = await realpath(resolvedPath);
    if (!isPathInsideRoot(realResolvedPath, realPublicRoot, { allowRoot: true })) {
      sendJson(response, 403, {
        ok: false,
        error: 'forbidden',
      });
      return;
    }

    if (path.basename(resolvedPath).toLowerCase() === 'index.html') {
      const html = injectSessionMetadata(
        await readFile(resolvedPath, 'utf8'),
        session,
        isLoopbackRemoteAddress(request.socket.remoteAddress),
      );
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html, 'utf8'),
        'Cache-Control': 'no-store',
      });
      response.end(html);
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentTypeForPath(resolvedPath),
      'Content-Length': fileStat.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(resolvedPath).pipe(response);
  } catch {
    const fallbackPath = path.join(publicRoot, 'index.html');
    const html = injectSessionMetadata(
      await readFile(fallbackPath, 'utf8'),
      session,
      isLoopbackRemoteAddress(request.socket.remoteAddress),
    );
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html, 'utf8'),
      'Cache-Control': 'no-store',
    });
    response.end(html);
  }
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw {
        statusCode: 413,
        code: 'request-too-large',
        message: `Request body exceeds ${MAX_JSON_BODY_BYTES} bytes.`,
      } satisfies JsonError;
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw badRequest('invalid-json', 'Request body must be valid JSON.');
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
  case '.html':
    return 'text/html; charset=utf-8';
  case '.css':
    return 'text/css; charset=utf-8';
  case '.js':
    return 'text/javascript; charset=utf-8';
  case '.json':
    return 'application/json; charset=utf-8';
  case '.svg':
    return 'image/svg+xml';
  case '.png':
    return 'image/png';
  case '.jpg':
  case '.jpeg':
    return 'image/jpeg';
  case '.webp':
    return 'image/webp';
  case '.gif':
    return 'image/gif';
  case '.woff':
    return 'font/woff';
  case '.woff2':
    return 'font/woff2';
  default:
    return 'application/octet-stream';
  }
}

function normalizeLimit(value: string | null): number {
  const parsed = Number(value || 50);
  return Math.max(1, Math.min(Math.floor(Number.isFinite(parsed) ? parsed : 50), 500));
}

function isPathInsideRoot(
  targetPath: string,
  rootPath: string,
  options: { allowRoot?: boolean } = {}
): boolean {
  const target = path.resolve(targetPath);
  const root = path.resolve(rootPath);
  if (target.toLowerCase() === root.toLowerCase()) {
    return options.allowRoot !== false;
  }
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readContext(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function badRequest(code: string, message: string): JsonError {
  return {
    statusCode: 400,
    code,
    message,
  };
}

function normalizeError(error: unknown): JsonError {
  if (isJsonError(error)) {
    return sanitizeJsonError(error);
  }

  if (error instanceof Error) {
    const candidate = error as Error & { statusCode?: unknown; code?: unknown };
    if (typeof candidate.statusCode === 'number' && typeof candidate.code === 'string') {
      return sanitizeJsonError({
        statusCode: candidate.statusCode,
        code: candidate.code,
        message: error.message,
      });
    }
  }

  return {
    statusCode: 500,
    code: 'internal-error',
    message: INTERNAL_ERROR_MESSAGE,
  };
}

function getCoderController(app: MonarchApplication): CoderAgentController {
  const existing = coderControllers.get(app);
  if (existing) return existing;
  const controller = new CoderAgentController(app);
  coderControllers.set(app, controller);
  return controller;
}

function readBoundedContextText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeSkillLimit(value: string | null): number {
  const parsed = Number(value || 5);
  return Math.max(1, Math.min(Math.floor(Number.isFinite(parsed) ? parsed : 5), 20));
}

function normalizeSandboxMode(value: unknown): MonarchSandboxMode | null {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
    ? value
    : null;
}

function normalizeAutonomyMode(value: unknown): MonarchAutonomyMode | null {
  return value === 'guided' || value === 'workspace-autonomous' || value === 'full-local'
    ? value
    : null;
}

function normalizeApprovalPolicy(value: unknown): MonarchApprovalPolicy | null {
  return value === 'on-request' || value === 'never' ? value : null;
}

function sanitizeJsonError(error: JsonError): JsonError {
  if (error.statusCode >= 500) {
    return {
      ...error,
      message: INTERNAL_ERROR_MESSAGE,
    };
  }
  return error;
}

function isJsonError(error: unknown): error is JsonError {
  return Boolean(
    error
      && typeof error === 'object'
      && typeof (error as JsonError).statusCode === 'number'
      && typeof (error as JsonError).code === 'string'
      && typeof (error as JsonError).message === 'string'
  );
}

function formatSseEventName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : 'message';
}

function isInternalAgentProgressCapability(moduleId: unknown, capabilityId: unknown): boolean {
  return (moduleId === 'memory' && capabilityId === 'memory.search')
    || (moduleId === 'security' && capabilityId === 'security.controller.check');
}

function formatSseData(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function createHttpSession(options: MonarchHttpServerOptions): MonarchHttpSession {
  const host = options.host || '127.0.0.1';
  const port = options.port || 4317;
  const requireApiToken = options.requireApiToken ?? !readBooleanEnv('MONARCH_DISABLE_API_TOKEN', false);
  const configuredToken = (options.apiToken || process.env.MONARCH_API_TOKEN || '').trim();
  const apiToken = requireApiToken
    ? configuredToken || randomBytes(32).toString('base64url')
    : configuredToken;

  return {
    apiToken,
    requireApiToken,
    origin: `http://${host}:${port}`,
    allowNonLoopbackMutations: options.allowNonLoopbackMutations
      ?? readBooleanEnv('MONARCH_ALLOW_NON_LOOPBACK_MUTATIONS', false),
  };
}

function enforceMutationGuards(request: IncomingMessage, session: MonarchHttpSession): void {
  if (!isMutationPeerAllowed(request.socket.remoteAddress, session.allowNonLoopbackMutations)) {
    throw {
      statusCode: 403,
      code: 'non-loopback-host-blocked',
      message: 'Mutating Monarch API calls are only allowed from a loopback connection.',
    } satisfies JsonError;
  }

  const origin = readHeader(request, 'origin');
  if (origin && !sameOrigin(origin, session.origin)) {
    throw {
      statusCode: 403,
      code: 'untrusted-origin',
      message: 'Mutating Monarch API calls require the trusted Monarch UI origin.',
    } satisfies JsonError;
  }

  if (!session.requireApiToken) {
    return;
  }

  const suppliedToken = readApiToken(request);
  if (!suppliedToken || !constantTimeEquals(suppliedToken, session.apiToken)) {
    throw {
      statusCode: 401,
      code: 'invalid-api-token',
      message: 'Mutating Monarch API calls require a valid UI session token.',
    } satisfies JsonError;
  }
}

function enforceReadApiToken(request: IncomingMessage, session: MonarchHttpSession): void {
  if (!session.requireApiToken) {
    return;
  }

  const suppliedToken = readApiToken(request);
  if (!suppliedToken || !constantTimeEquals(suppliedToken, session.apiToken)) {
    throw {
      statusCode: 401,
      code: 'invalid-api-token',
      message: 'Sensitive Monarch API reads require a valid UI session token.',
    } satisfies JsonError;
  }
}

function readApiToken(request: IncomingMessage): string {
  const sessionHeader = readHeader(request, 'x-monarch-session');
  if (sessionHeader) {
    return sessionHeader.trim();
  }

  const authorization = readHeader(request, 'authorization');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function sameOrigin(actual: string, expected: string): boolean {
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    return actualUrl.protocol === expectedUrl.protocol
      && actualUrl.hostname === expectedUrl.hostname
      && normalizePort(actualUrl) === normalizePort(expectedUrl);
  } catch {
    return false;
  }
}

function normalizePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === 'https:' ? '443' : '80';
}

export function isMutationPeerAllowed(
  remoteAddress: string | undefined,
  allowNonLoopbackMutations: boolean,
): boolean {
  return allowNonLoopbackMutations || isLoopbackRemoteAddress(remoteAddress);
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  let address = remoteAddress.trim().toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (address.startsWith('::ffff:')) {
    address = address.slice('::ffff:'.length);
  }
  return address.startsWith('127.');
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function readHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] || '';
  }
  return value || '';
}

function injectSessionMetadata(
  html: string,
  session: MonarchHttpSession,
  exposeApiToken: boolean,
): string {
  const token = session.requireApiToken && exposeApiToken ? session.apiToken : '';
  const tags = [
    `<meta name="monarch-api-token" content="${escapeAttribute(token)}">`,
    `<meta name="monarch-api-origin" content="${escapeAttribute(session.origin)}">`,
  ].join('\n    ');

  if (/<meta\s+name=["']monarch-api-token["']/i.test(html)) {
    return html
      .replace(/<meta\s+name=["']monarch-api-token["']\s+content=["'][^"']*["']\s*>/i, tags);
  }

  return html.replace(/<\/head>/i, `    ${tags}\n  </head>`);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function readBooleanEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(value);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
