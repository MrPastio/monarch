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
  MonarchApplicationState,
  MonarchActionProposalSubmission,
  MonarchCapabilityExecution,
  MonarchIntentJobSubmission,
  MonarchIntentSubmission,
} from './application';
import { classifyOscarRequestDisposition, MONARCH_PUBLIC_AUTHORITY_CONTEXT } from '../core';
import { classifyOscarServerDisposition } from '../oscar-turn/disposition';
import { getAgentSkillRegistry } from '../modules/astra/agent-skills';
import { getAgentSkillAuthoringService } from '../modules/astra/skill-authoring';
import type { MonarchApprovalPolicy, MonarchAutonomyMode, MonarchIntentResult, MonarchSandboxMode } from '../core';
import { CoderAgentController } from './coder-agent-controller';
import type { CoderModelId } from '../modules/coder/types';
import type { MonarchInstallableModelRole } from '../modules/models/model-provisioning-manager';
import { handleAgentTaskHttpRequest } from './agent-task-http';
import { handleOscarTurnHttpRequest } from './oscar-turn-http';
import type { OscarTurnCheckpoint, OscarTurnV1 } from '../oscar-turn';
import type {
  MonarchSettingsCommandRequestV1,
  MonarchSettingsReadRequestV1,
} from '../settings';
import { IMAGE_PROVIDER_AGREEMENT } from '../image-generation';

export interface MonarchHttpServerOptions {
  app: MonarchApplication;
  publicDirectory: string;
  host?: string;
  port?: number;
  apiToken?: string;
  desktopAttestationToken?: string;
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
  desktopAttestationToken: string;
  requireApiToken: boolean;
  origin: string;
  allowNonLoopbackMutations: boolean;
}

export type MonarchHttpOriginState = 'absent' | 'same-origin' | 'mismatch';
export type MonarchHttpCredentialState = 'disabled' | 'absent' | 'valid' | 'invalid';

export interface MonarchHttpPrincipal {
  source: 'desktop' | 'api';
  loopback: boolean;
  mutationPeerAllowed: boolean;
  origin: MonarchHttpOriginState;
  apiToken: MonarchHttpCredentialState;
  desktopAttestation: Exclude<MonarchHttpCredentialState, 'disabled'>;
}

const MAX_JSON_BODY_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_OSCAR_DISPOSITION_BODY_BYTES = 128 * 1024;
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
    return pathname === '/api/agent/tasks'
      || pathname.startsWith('/api/agent/tasks/')
      || pathname === '/api/oscar/attachments'
      || pathname.startsWith('/api/oscar/attachments/')
      || pathname === '/api/oscar/turns'
      || pathname.startsWith('/api/oscar/turns/');
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
    desktopAttestationToken: session.desktopAttestationToken,
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
  const principal = deriveMonarchHttpPrincipal(request, session);

  if (request.method === 'GET' && url.pathname === '/api/ready') {
    sendJson(response, 200, { ok: true, ready: true });
    return;
  }

  if (await handleOscarTurnHttpRequest({
    app,
    url,
    request,
    response,
    enforceMutation: () => enforceMutationGuards(principal),
    enforceRead: () => enforceReadApiToken(principal),
    principal,
  })) {
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/settings/read') {
    enforceDesktopSettingsPrincipal(principal, false);
    const body = await readJsonBody<MonarchSettingsReadRequestV1>(request, 128 * 1024);
    const result = await app.settingsCommandBus.read(body, principal.source);
    sendJson(response, 200, { ok: true, context: result });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/settings/commands') {
    enforceDesktopSettingsPrincipal(principal, true);
    const body = await readJsonBody<MonarchSettingsCommandRequestV1>(request, 512 * 1024);
    const receipt = await app.settingsCommandBus.execute(body, principal.source);
    sendJson(response, 200, { ok: true, receipt });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/settings/personality/preview') {
    enforceDesktopSettingsPrincipal(principal, false);
    const body = await readJsonBody<{ scope?: MonarchSettingsReadRequestV1['scope'] }>(request, 64 * 1024);
    if (!body.scope) throw badRequest('personality-scope-required', 'Personality preview requires an explicit scope.');
    const preview = await app.previewPersonality(body.scope);
    sendJson(response, 200, { ok: true, preview });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/images/context') {
    enforceReadApiToken(principal);
    sendJson(response, 200, { ok: true, context: await app.imageGeneration.readContext() });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/images/provider-agreement') {
    enforceReadApiToken(principal);
    sendJson(response, 200, { ok: true, agreement: IMAGE_PROVIDER_AGREEMENT });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/images/prompt/translate') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<{ text?: string }>(request, 16 * 1024);
    const translation = await app.translateImagePrompt(body.text || '');
    sendJson(response, 200, { ok: true, translation });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/images/policy') {
    enforceDesktopSettingsPrincipal(principal, true);
    const body = await readJsonBody<{
      action?: 'provider-consent' | 'perchance-access' | 'perchance-intro' | 'mature-mode' | 'incognito-persistence';
      enabled?: boolean;
      agreementVersion?: string;
      cloudProcessingAccepted?: boolean;
      thirdPartyTermsAccepted?: boolean;
      mode?: 'off' | 'one-hour' | 'persistent';
      adultAttested?: boolean;
      value?: 'never' | 'ask' | 'always';
    }>(request, 64 * 1024);
    if (!body.action) throw badRequest('image-policy-action-required', 'Image policy action is required.');
    const policy = await app.imageGeneration.updatePolicy({
      action: body.action,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.agreementVersion ? { agreementVersion: body.agreementVersion } : {}),
      ...(body.cloudProcessingAccepted !== undefined ? { cloudProcessingAccepted: body.cloudProcessingAccepted } : {}),
      ...(body.thirdPartyTermsAccepted !== undefined ? { thirdPartyTermsAccepted: body.thirdPartyTermsAccepted } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.adultAttested !== undefined ? { adultAttested: body.adultAttested } : {}),
      ...(body.value ? { value: body.value } : {}),
    });
    sendJson(response, 200, { ok: true, policy });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/images/intents/evaluate') {
    enforceReadApiToken(principal);
    const body = await readJsonBody<{ text?: string }>(request, 64 * 1024);
    const intent = await app.imageGeneration.evaluateIntent(body.text || '');
    sendJson(response, 200, { ok: true, intent });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/images/generations') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<{
      prompt?: string;
      providerId?: 'aihorde-anonymous' | 'perchance-interactive';
      negativePrompt?: string;
      style?: string;
      aspectRatio?: string;
      count?: number;
      seed?: string;
      privacyMode?: 'persistent' | 'incognito';
      confirmationId?: string;
    }>(request, 64 * 1024);
    const preparation = await app.imageGeneration.startGeneration({
      prompt: body.prompt || '',
      ...(body.providerId ? { providerId: body.providerId } : {}),
      ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
      ...(body.style ? { style: body.style } : {}),
      ...(body.aspectRatio ? { aspectRatio: body.aspectRatio } : {}),
      ...(body.count !== undefined ? { count: body.count } : {}),
      ...(body.seed ? { seed: body.seed } : {}),
      ...(body.privacyMode ? { privacyMode: body.privacyMode } : {}),
      ...(body.confirmationId ? { confirmationId: body.confirmationId } : {}),
    });
    const accepted = preparation.status !== 'blocked' && preparation.status !== 'confirmation-required';
    sendJson(response, accepted ? 202 : 409, { ok: accepted, preparation });
    return;
  }

  const generationResultMatch = url.pathname.match(/^\/api\/images\/generations\/(image_job_[a-f0-9]{32})\/results\/([0-3])$/u);
  if (request.method === 'GET' && generationResultMatch?.[1] && generationResultMatch[2] !== undefined) {
    enforceReadApiToken(principal);
    const asset = await app.imageGeneration.readGenerationResult(generationResultMatch[1], Number(generationResultMatch[2]));
    response.writeHead(200, {
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(asset.bytes);
    return;
  }

  const generationSaveMatch = url.pathname.match(/^\/api\/images\/generations\/(image_job_[a-f0-9]{32})\/save$/u);
  if (request.method === 'POST' && generationSaveMatch?.[1]) {
    enforceMutationGuards(principal);
    const job = await app.imageGeneration.saveGenerationResults(generationSaveMatch[1]);
    sendJson(response, 200, { ok: true, job });
    return;
  }

  const generationMatch = url.pathname.match(/^\/api\/images\/generations\/(image_job_[a-f0-9]{32})$/u);
  if (request.method === 'GET' && generationMatch?.[1]) {
    enforceReadApiToken(principal);
    const job = await app.imageGeneration.readGenerationJob(generationMatch[1]);
    sendJson(response, 200, { ok: true, job });
    return;
  }

  if (request.method === 'DELETE' && generationMatch?.[1]) {
    enforceMutationGuards(principal);
    const job = await app.imageGeneration.cancelGeneration(generationMatch[1]);
    sendJson(response, 200, { ok: true, job });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/images/library/import') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<{
      name?: string;
      mimeType?: string;
      dataBase64?: string;
      contentRating?: 'safe' | 'nsfw' | 'unknown';
      prompt?: string;
      privacyMode?: 'persistent' | 'incognito';
      explicitSave?: boolean;
    }>(request, 34 * 1024 * 1024);
    const record = await app.imageGeneration.importImage(body);
    sendJson(response, 201, { ok: true, record });
    return;
  }

  const imageContentMatch = url.pathname.match(/^\/api\/images\/library\/(image_[a-f0-9]{32})\/content$/u);
  if (request.method === 'GET' && imageContentMatch?.[1]) {
    enforceReadApiToken(principal);
    const asset = await app.imageGeneration.readImage(imageContentMatch[1]);
    const details = await stat(asset.filePath);
    response.writeHead(200, {
      'Content-Type': asset.record.mimeType,
      'Content-Length': String(details.size),
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(asset.filePath).pipe(response);
    return;
  }

  const imageRecordMatch = url.pathname.match(/^\/api\/images\/library\/(image_[a-f0-9]{32})$/u);
  if (request.method === 'DELETE' && imageRecordMatch?.[1]) {
    enforceMutationGuards(principal);
    await app.imageGeneration.deleteImage(imageRecordMatch[1]);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/oscar/request-disposition') {
    enforceReadApiToken(principal);
    const body = await readJsonBody<{ text?: unknown; history?: unknown }>(request, MAX_OSCAR_DISPOSITION_BODY_BYTES);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw badRequest('empty-oscar-request', 'Oscar request text is required.');
    if (text.length > 16_000) throw badRequest('oscar-request-too-long', 'Oscar request text is too long.');
    const history = readOscarDispositionHistory(body.history);
    const deterministic = classifyOscarRequestDisposition(text);
    const contextual = await classifyOscarServerDisposition(text, undefined, { history });
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, {
      ok: true,
      disposition: {
        ...deterministic,
        mode: contextual.lane === 'agent' ? 'agent' : 'chat',
        kind: contextual.kind === 'material_review' ? contextual.kind : deterministic.kind,
        confidence: contextual.confidence,
        reason: contextual.reason,
        requiresExternalResearch: contextual.requiresExternalResearch === true,
      },
    });
    return;
  }
  if (url.pathname === '/api/oscar/request-disposition') {
    sendJson(response, 405, {
      ok: false,
      error: 'method-not-allowed',
      message: 'Use POST for Oscar request disposition.',
    });
    return;
  }

  if (await handleAgentTaskHttpRequest({
    app,
    url,
    request,
    response,
    enforceMutation: () => enforceMutationGuards(principal),
    enforceRead: () => enforceReadApiToken(principal),
    principal,
  })) {
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/coder') {
    enforceReadApiToken(principal);
    const coder = getCoderController(app);
    const projects = coder.listProjects();
    const active = projects.activeProjectId
      ? await coder.projectSnapshot(projects.activeProjectId).catch(() => null)
      : null;
    sendJson(response, 200, { ok: true, projects, active, runs: coder.runs.list(projects.activeProjectId || undefined) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/coder/projects') {
    enforceMutationGuards(principal);
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
    enforceReadApiToken(principal);
    const projectId = decodeURIComponent(coderProjectMatch[1]);
    sendJson(response, 200, { ok: true, project: await getCoderController(app).projectSnapshot(projectId) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/coder/runs') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<{ prompt?: string; projectId?: string; model?: string }>(request);
    const projectId = String(body.projectId || '').trim();
    if (!projectId) throw badRequest('missing-coder-project', 'Select an explicit Coder project before starting a run.');
    if (app.getOwnerDevSettings().zeroRetentionEnabled) {
      throw {
        statusCode: 409,
        code: 'coder-durable-run-disabled-by-zero-retention',
        message: 'Coder хранит журнал выполнения, поэтому новые Coder-сессии отключены при полной незаписи.',
      } satisfies JsonError;
    }
    const model: CoderModelId = body.model === 'deepseek-coder-v2-lite-instruct'
      ? 'deepseek-coder-v2-lite-instruct'
      : 'qwen3-coder-30b-a3b-instruct';
    const run = await getCoderController(app).start(String(body.prompt || ''), projectId, model);
    sendJson(response, 202, { ok: true, run });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/coder/runs') {
    enforceReadApiToken(principal);
    sendJson(response, 200, { ok: true, runs: getCoderController(app).runs.list(url.searchParams.get('projectId') || undefined) });
    return;
  }

  const coderRunMatch = url.pathname.match(/^\/api\/coder\/runs\/([^/]+)$/);
  if (request.method === 'DELETE' && coderRunMatch?.[1]) {
    enforceMutationGuards(principal);
    const run = getCoderController(app).runs.delete(decodeURIComponent(coderRunMatch[1]));
    sendJson(response, 200, { ok: true, deleted: run.id });
    return;
  }
  if (request.method === 'GET' && coderRunMatch?.[1]) {
    enforceReadApiToken(principal);
    const run = getCoderController(app).runs.get(decodeURIComponent(coderRunMatch[1]));
    if (!run) { sendJson(response, 404, { ok: false, error: 'coder-run-not-found' }); return; }
    sendJson(response, 200, { ok: true, run });
    return;
  }

  const coderCancelMatch = url.pathname.match(/^\/api\/coder\/runs\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && coderCancelMatch?.[1]) {
    enforceMutationGuards(principal);
    sendJson(response, 200, { ok: true, run: await getCoderController(app).cancel(decodeURIComponent(coderCancelMatch[1])) });
    return;
  }

  const coderResumeMatch = url.pathname.match(/^\/api\/coder\/runs\/([^/]+)\/resume$/);
  if (request.method === 'POST' && coderResumeMatch?.[1]) {
    enforceMutationGuards(principal);
    if (app.getOwnerDevSettings().zeroRetentionEnabled) {
      throw {
        statusCode: 409,
        code: 'coder-durable-run-disabled-by-zero-retention',
        message: 'Coder хранит журнал выполнения, поэтому возобновление Coder-сессий отключено при полной незаписи.',
      } satisfies JsonError;
    }
    sendJson(response, 202, { ok: true, run: await getCoderController(app).resume(decodeURIComponent(coderResumeMatch[1])) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/coder/fast-chat') {
    enforceMutationGuards(principal);
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
        execution_authority: 'none',
        persistence_owner: 'coordinator',
        max_new_tokens: 1_024,
        temperature: 0.35,
        top_p: 0.9,
      },
    });
    sendJson(response, result.ok ? 200 : 503, { ok: result.ok, result });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    enforceReadApiToken(principal);
    const state = await app.getState(url.searchParams.get('input') || '');
    sendJson(response, 200, projectMonarchStateForPrincipal(state, principal));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/components') {
    enforceReadApiToken(principal);
    sendJson(response, 200, app.getComponentManagerSnapshot());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/components/ensure') {
    enforceMutationGuards(principal);
    const snapshot = app.startRequiredComponents();
    sendJson(response, snapshot.ready ? 200 : 202, snapshot);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/models/install') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<{ roles?: unknown; source?: unknown }>(request, 16 * 1024);
    if (!Array.isArray(body.roles) || body.roles.length < 1 || body.roles.length > 3) {
      throw {
        statusCode: 400,
        code: 'model-selection-invalid',
        message: 'Выбери хотя бы одну модель.',
      } satisfies JsonError;
    }
    const allowed = new Set<MonarchInstallableModelRole>([
      'gemma4-fast',
      'gemma4-balanced',
      'qwen3.8-27b-pro',
    ]);
    const roles = [...new Set(body.roles.map((value) => String(value).trim()))];
    if (!roles.every((role): role is MonarchInstallableModelRole => allowed.has(role as MonarchInstallableModelRole))) {
      throw {
        statusCode: 400,
        code: 'model-selection-invalid',
        message: 'Неизвестная модель.',
      } satisfies JsonError;
    }
    const source = body.source === 'settings' ? 'settings' : 'onboarding';
    const snapshot = app.startModelInstall(roles, source);
    sendJson(response, snapshot.ready && !('activeInstall' in snapshot && snapshot.activeInstall) ? 200 : 202, snapshot);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/models/onboarding/skip') {
    enforceMutationGuards(principal);
    sendJson(response, 200, await app.skipModelOnboarding());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/models/onboarding/welcome') {
    enforceMutationGuards(principal);
    sendJson(response, 200, await app.acknowledgeModelOnboardingWelcome());
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
    enforceReadApiToken(principal);
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
    enforceReadApiToken(principal);
    const limit = normalizeLimit(url.searchParams.get('limit'));
    const state = await app.getState();
    sendJson(response, 200, {
      events: state.runtime.snapshot.events.slice(-limit).reverse(),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/intent') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<Partial<MonarchIntentSubmission>>(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw badRequest('empty-intent', 'Intent text is required.');
    }

    rejectLegacyTextConfirmation(body);
    markLegacyAdapter(response, '/api/intent');
    const result = await submitLegacyTurn(app, request, principal, '/api/intent', text, readContext(body.context));
    sendJson(response, 200, {
      ok: true,
      result,
      state: await app.getState(text),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/intent-jobs') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<Partial<MonarchIntentJobSubmission>>(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw badRequest('empty-intent', 'Intent text is required.');
    }

    rejectLegacyTextConfirmation(body);
    markLegacyAdapter(response, '/api/intent-jobs');
    const result = await submitLegacyTurn(app, request, principal, '/api/intent-jobs', text, readContext(body.context));
    const job = legacyTurnJob(result, text, typeof body.timeoutMs === 'number' ? body.timeoutMs : 180_000);
    sendJson(response, 202, {
      ok: true,
      job,
      state: await app.getState(text),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/intent-jobs') {
    enforceReadApiToken(principal);
    markLegacyAdapter(response, '/api/intent-jobs');
    sendJson(response, 200, {
      ok: true,
      jobs: await listLegacyTurnJobs(app, normalizeLimit(url.searchParams.get('limit'))),
    });
    return;
  }

  const intentJobMatch = url.pathname.match(/^\/api\/intent-jobs\/([^/]+)$/);
  if (request.method === 'GET' && intentJobMatch?.[1]) {
    enforceReadApiToken(principal);
    markLegacyAdapter(response, '/api/intent-jobs/:id');
    const checkpoint = await app.oscarTurnCoordinator.getTurn(decodeURIComponent(intentJobMatch[1]));
    if (!checkpoint || !checkpoint.turn.conversationId.startsWith('legacy:')) {
      sendJson(response, 404, {
        ok: false,
        error: 'job-not-found',
        message: 'Intent job was not found.',
      });
      return;
    }
    const job = legacyCheckpointJob(checkpoint);
    sendJson(response, 200, {
      ok: true,
      job,
      state: await app.getState(job.text),
    });
    return;
  }

  const streamIntentJobMatch = url.pathname.match(/^\/api\/intent-jobs\/([^/]+)\/stream$/);
  if (request.method === 'GET' && streamIntentJobMatch?.[1]) {
    enforceReadApiToken(principal);
    const jobId = decodeURIComponent(streamIntentJobMatch[1]);
    markLegacyAdapter(response, '/api/intent-jobs/:id/stream');
    const initial = await app.oscarTurnCoordinator.getTurn(jobId);
    if (!initial || !initial.turn.conversationId.startsWith('legacy:')) {
      sendJson(response, 404, { ok: false, error: 'job-not-found' });
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let closed = false;
    let latest = initial;
    const emit = (name: string, data: unknown) => {
      if (!closed) response.write(`event: ${name}\ndata: ${formatSseData(data)}\n\n`);
    };
    const emitTurnEvents = (events: OscarTurnCheckpoint['events']) => {
      for (const event of events) {
        emit(event.type === 'answer.delta' ? 'token' : 'turn-event', event.type === 'answer.delta'
          ? { token: event.payload.content || '' }
          : { sequence: event.sequence, type: event.type, payload: event.payload });
      }
    };
    const finish = (checkpoint: OscarTurnCheckpoint) => {
      latest = checkpoint;
      if (!isLegacyTurnSettled(checkpoint.turn.status)) return false;
      emit('outcome', legacyCheckpointJob(checkpoint));
      emit('done', { turnId: checkpoint.turn.id, status: checkpoint.turn.status });
      response.end();
      closed = true;
      return true;
    };
    emit('started', { turnId: jobId });
    emitTurnEvents(initial.events);
    if (finish(initial)) return;
    const unsubscribe = app.oscarTurnCoordinator.subscribe(jobId, (commit) => {
      emitTurnEvents(commit.appendedEvents);
      finish({ turn: commit.turn, events: [...latest.events, ...commit.appendedEvents] });
    });
    response.on('close', () => {
      closed = true;
      unsubscribe();
    });
    const current = await app.oscarTurnCoordinator.getTurn(jobId);
    if (current && !closed && current.turn.revision !== initial.turn.revision) {
      emitTurnEvents(current.events.filter((event) => event.sequence > (initial.events.at(-1)?.sequence || 0)));
      if (finish(current)) unsubscribe();
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
    enforceReadApiToken(principal);
    const registry = getAgentSkillRegistry(app.sourceRoot || app.workspaceRoot);
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

  if (request.method === 'POST' && url.pathname === '/api/skills/draft') {
    enforceDesktopSettingsPrincipal(principal, false);
    const body = await readJsonBody<Record<string, unknown>>(request, 64 * 1024);
    const unknownFields = Object.keys(body).filter((field) => !['purpose', 'scope'].includes(field));
    if (unknownFields.length) {
      throw badRequest('skill-draft-fields', `Unsupported skill draft fields: ${unknownFields.join(', ')}.`);
    }
    const workspaceRoot = app.sourceRoot || app.workspaceRoot;
    const registry = getAgentSkillRegistry(workspaceRoot);
    const authoring = getAgentSkillAuthoringService(workspaceRoot, registry);
    const draft = authoring.createAutoDraft(body.purpose, body.scope);
    const validation = await authoring.validate(draft, {
      availableCapabilities: app.runtime.kernel.listCapabilities().map((capability) => capability.id),
    });
    sendJson(response, 200, { ok: true, ...validation });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/skills/validate') {
    enforceDesktopSettingsPrincipal(principal, false);
    const body = await readJsonBody<Record<string, unknown>>(request, 256 * 1024);
    const unknownFields = Object.keys(body).filter((field) => field !== 'draft');
    if (unknownFields.length) {
      throw badRequest('skill-validation-fields', `Unsupported skill validation fields: ${unknownFields.join(', ')}.`);
    }
    const workspaceRoot = app.sourceRoot || app.workspaceRoot;
    const registry = getAgentSkillRegistry(workspaceRoot);
    const validation = await getAgentSkillAuthoringService(workspaceRoot, registry).validate(body.draft, {
      availableCapabilities: app.runtime.kernel.listCapabilities().map((capability) => capability.id),
    });
    sendJson(response, 200, { ok: true, ...validation });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/skills') {
    enforceDesktopSettingsPrincipal(principal, true);
    const body = await readJsonBody<Record<string, unknown>>(request, 256 * 1024);
    const unknownFields = Object.keys(body).filter((field) => !['draft', 'expectedDraftHash'].includes(field));
    if (unknownFields.length) {
      throw badRequest('skill-create-fields', `Unsupported skill creation fields: ${unknownFields.join(', ')}.`);
    }
    const policy = app.runtime.kernel.evaluateLocalSettingsCommand({
      source: principal.source,
      command: 'skill.create',
      scope: { type: 'chat' },
      payload: body,
    });
    if (policy.outcome !== 'allow') {
      throw {
        statusCode: 403,
        code: 'skill-create-policy-denied',
        message: policy.reason,
      } satisfies JsonError;
    }
    const workspaceRoot = app.sourceRoot || app.workspaceRoot;
    const registry = getAgentSkillRegistry(workspaceRoot);
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    const result = await getAgentSkillAuthoringService(workspaceRoot, registry).publish(
      body.draft,
      body.expectedDraftHash,
      {
        availableCapabilities: app.runtime.kernel.listCapabilities().map((capability) => capability.id),
        signal: controller.signal,
      },
    );
    sendJson(response, 201, {
      ok: true,
      receipt: result.receipt,
      skill: result.skill,
      policyDecisionHash: policy.policyDecisionHash,
    });
    return;
  }

  const activateSkillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/activate$/);
  if (request.method === 'GET' && activateSkillMatch?.[1]) {
    enforceReadApiToken(principal);
    const skillId = decodeURIComponent(activateSkillMatch[1]);
    const prompt = url.searchParams.get('prompt') || '';
    const skill = await getAgentSkillRegistry(app.sourceRoot || app.workspaceRoot)
      .activate(skillId, prompt, { explicit: true });
    if (!skill) {
      sendJson(response, 404, { ok: false, error: 'skill-not-found' });
      return;
    }
    sendJson(response, 200, { ok: true, skill });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/permissions') {
    enforceReadApiToken(principal);
    sendJson(response, 200, {
      ok: true,
      profile: app.getPermissionProfile(),
      authority: app.getAuthorityContext(),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/permissions') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const allowedFields = new Set(['autonomyMode', 'sandboxMode', 'approvalPolicy']);
    const unknownFields = Object.keys(body).filter((field) => !allowedFields.has(field));
    if (unknownFields.length > 0) {
      const authorityFields = new Set([
        'authority', 'authorityContext', 'authorityTier', 'tier', 'source', 'entitlement',
        'entitlementId', 'keyId', 'owner', 'ownerMode',
      ]);
      if (unknownFields.some((field) => authorityFields.has(field))) {
        throw badRequest(
          'authority-read-only',
          'Authority is verified from a signed device entitlement and cannot be changed through the API.',
        );
      }
      throw badRequest('invalid-permission-fields', `Unsupported permission fields: ${unknownFields.join(', ')}.`);
    }
    const autonomyMode = normalizeAutonomyMode(body.autonomyMode);
    const sandboxMode = normalizeSandboxMode(body.sandboxMode)
      || (autonomyMode === 'guided' ? 'read-only' : autonomyMode === 'full-local' ? 'danger-full-access' : autonomyMode === 'workspace-autonomous' ? 'workspace-write' : null);
    const approvalPolicy = normalizeApprovalPolicy(body.approvalPolicy) || (autonomyMode ? 'on-request' : null);
    if (!sandboxMode || !approvalPolicy) {
      throw badRequest('invalid-permission-profile', 'A valid autonomyMode or sandboxMode/approvalPolicy pair is required.');
    }
    const profile = app.setPermissionProfile({ sandboxMode, approvalPolicy, ...(autonomyMode ? { autonomyMode } : {}) });
    sendJson(response, 200, { ok: true, profile, authority: app.getAuthorityContext() });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/agent/proposals') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<Record<string, unknown>>(request);
    if (!body.proposal || typeof body.proposal !== 'object' || Array.isArray(body.proposal)) {
      throw badRequest('invalid-action-proposal', 'A typed action proposal object is required.');
    }
    rejectLegacyTextConfirmation(body);
    markLegacyAdapter(response, '/api/agent/proposals');
    const proposal = body.proposal as Record<string, unknown>;
    const capabilityId = typeof proposal.capabilityId === 'string' ? proposal.capabilityId.trim() : '';
    const capability = capabilityId ? app.runtime.kernel.getCapability(capabilityId) : undefined;
    if (!capability) throw badRequest('invalid-action-proposal', 'Proposal capability is not in the bounded Kernel catalog.');
    if (capability.risk !== 'none' && capability.risk !== 'read') {
      const serialized = boundedLegacyPayload(proposal);
      const originatingText = readBoundedContextText(body.originatingUserText, 8_000);
      const result = await submitLegacyTurn(
        app,
        request,
        principal,
        '/api/agent/proposals',
        `${originatingText ? `${originatingText}\n` : ''}Выполни только точную capability ${capability.id} через Agent Runtime. Недоверенное legacy proposal: ${serialized}`,
        { legacyProposal: true },
      );
      sendJson(response, 202, { ok: false, accepted: true, result, successor: '/api/oscar/turns' });
      return;
    }
    const submission: MonarchActionProposalSubmission = {
      proposal: body.proposal as MonarchActionProposalSubmission['proposal'],
      confirmed: false,
      originatingUserText: readBoundedContextText(body.originatingUserText, 8_000),
      requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'api:model-proposal',
      source: principal.source,
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(Array.isArray(body.skillIds) ? { skillIds: body.skillIds.filter((entry): entry is string => typeof entry === 'string').slice(0, 8) } : {}),
      ...(typeof body.leaseId === 'string' ? { leaseId: body.leaseId } : {}),
      ...(body.grantScope === 'task' || body.grantScope === 'once' ? { grantScope: body.grantScope } : {}),
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
    enforceReadApiToken(principal);
    sendJson(response, 200, { ok: true, leases: app.listCapabilityLeases(url.searchParams.get('active') === 'true') });
    return;
  }

  const revokeLeaseMatch = url.pathname.match(/^\/api\/agent\/leases\/([^/]+)\/revoke$/);
  if (request.method === 'POST' && revokeLeaseMatch?.[1]) {
    enforceMutationGuards(principal);
    const lease = app.revokeCapabilityLease(decodeURIComponent(revokeLeaseMatch[1]));
    if (!lease) {
      sendJson(response, 404, { ok: false, error: 'lease-not-found' });
      return;
    }
    sendJson(response, 200, { ok: true, lease });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent/ledger') {
    enforceReadApiToken(principal);
    sendJson(response, 200, { ok: true, actions: app.listActionLedger(normalizeLimit(url.searchParams.get('limit'))) });
    return;
  }

  const rollbackActionMatch = url.pathname.match(/^\/api\/agent\/ledger\/([^/]+)\/rollback$/);
  if (request.method === 'POST' && rollbackActionMatch?.[1]) {
    enforceMutationGuards(principal);
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
    enforceMutationGuards(principal);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw badRequest('empty-agent-action', 'Agent action text is required.');
    }
    rejectLegacyTextConfirmation(body);
    markLegacyAdapter(response, '/api/agent/dispatch');
    const result = await submitLegacyTurn(app, request, principal, '/api/agent/dispatch', text, {
      ...readContext(body.context),
      legacyAgentDispatch: true,
    });
    sendJson(response, 200, {
      ok: true,
      handled: Boolean(result.execution),
      result,
      profile: app.getPermissionProfile(),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/agent/jobs') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      throw badRequest('empty-agent-action', 'Agent action text is required.');
    }
    const clientContext = readContext(body.context);
    rejectLegacyTextConfirmation(body);
    markLegacyAdapter(response, '/api/agent/jobs');
    const result = await submitLegacyTurn(app, request, principal, '/api/agent/jobs', text, {
      ...clientContext,
      legacyAgentDispatch: true,
      modelProposed: clientContext.modelProposed === true,
      originatingUserText: readBoundedContextText(clientContext.originatingUserText, 4000),
      proposalReason: readBoundedContextText(clientContext.proposalReason, 500),
    });
    const job = legacyTurnJob(result, text, typeof body.timeoutMs === 'number' ? body.timeoutMs : 180_000);
    sendJson(response, 202, { ok: true, job, profile: app.getPermissionProfile() });
    return;
  }

  const cancelIntentJobMatch = url.pathname.match(/^\/api\/intent-jobs\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelIntentJobMatch?.[1]) {
    enforceMutationGuards(principal);
    markLegacyAdapter(response, '/api/intent-jobs/:id/cancel');
    const turnId = decodeURIComponent(cancelIntentJobMatch[1]);
    const checkpoint = await app.oscarTurnCoordinator.getTurn(turnId);
    if (!checkpoint || !checkpoint.turn.conversationId.startsWith('legacy:')) {
      sendJson(response, 404, {
        ok: false,
        error: 'job-not-found',
        message: 'Intent job was not found.',
      });
      return;
    }
    const requestSource = principal.source;
    if (checkpoint.turn.source !== requestSource) {
      throw { statusCode: 403, code: 'turn-source-mismatch', message: 'Legacy Turn belongs to another surface.' } satisfies JsonError;
    }
    const cancelled = await app.oscarTurnCoordinator.cancel(turnId, requestSource);
    const job = legacyCheckpointJob(cancelled);
    sendJson(response, 200, {
      ok: true,
      job,
      state: await app.getState(job.text),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/computer-use/emergency-stop') {
    // This is deliberately a dedicated, payload-free control path. It never
    // enters Agent planning or the legacy device-control adapter, so the
    // desktop global shortcut can revoke the native input epoch immediately
    // while an unrelated Agent task is still running.
    enforceMutationGuards(principal);
    const result = await app.executeCapability({
      moduleId: 'computer',
      capabilityId: 'computer.control.stop',
      input: {},
      requestedBy: principal.source === 'desktop'
        ? 'desktop-emergency-stop'
        : 'local-emergency-stop',
      source: principal.source,
      confirmed: false,
    });
    sendJson(response, 200, { ok: result.ok, result });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/execute') {
    enforceMutationGuards(principal);
    const body = await readJsonBody<Partial<MonarchCapabilityExecution> & { includeState?: boolean }>(request);
    const moduleId = typeof body.moduleId === 'string' ? body.moduleId.trim() : '';
    const capabilityId = typeof body.capabilityId === 'string' ? body.capabilityId.trim() : '';
    if (!moduleId || !capabilityId) {
      throw badRequest('empty-execution-target', 'moduleId and capabilityId are required.');
    }

    rejectLegacyTextConfirmation(body);
    markLegacyAdapter(response, '/api/execute');
    const capability = app.runtime.kernel.getCapability(capabilityId);
    if (!capability || capability.moduleId !== moduleId) {
      throw badRequest('capability-not-found', 'moduleId and capabilityId do not identify one bounded Kernel capability.');
    }
    if (capability.risk !== 'none' && capability.risk !== 'read') {
      const result = await submitLegacyTurn(
        app,
        request,
        principal,
        '/api/execute',
        `Выполни только точную capability ${capabilityId} через Agent Runtime с exact input=${boundedLegacyPayload(body.input ?? {})}.`,
        { legacyCapabilityExecution: true },
      );
      sendJson(response, 202, {
        ok: false,
        accepted: true,
        result,
        successor: '/api/oscar/turns',
        ...(body.includeState === false ? {} : { state: await app.getState() }),
      });
      return;
    }

    const execution: MonarchCapabilityExecution = {
      moduleId,
      capabilityId,
      input: body.input,
      requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'api',
      source: principal.source,
      confirmed: false,
    };
    if (typeof body.intentId === 'string') {
      execution.intentId = body.intentId;
    }

    const result = await app.executeCapability(execution);

    const clientIp = request.socket.remoteAddress || 'unknown';
    const auditMessage = `Legacy read-only API capability observation: ${moduleId}.${capabilityId} requested by '${execution.requestedBy}'.`;
    app.runtime.kernel.audit(
      'security',
      auditMessage,
      {
        moduleId,
        capabilityId,
        requestedBy: execution.requestedBy,
        confirmed: false,
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
    enforceMutationGuards(principal);
    const body = await readJsonBody<Partial<MonarchCapabilityExecution>>(request);
    const moduleId = typeof body.moduleId === 'string' ? body.moduleId.trim() : '';
    const capabilityId = typeof body.capabilityId === 'string' ? body.capabilityId.trim() : '';
    if (!moduleId || !capabilityId) {
      throw badRequest('empty-execution-target', 'moduleId and capabilityId are required.');
    }

    rejectLegacyTextConfirmation(body);
    markLegacyAdapter(response, '/api/execute-stream');
    const capability = app.runtime.kernel.getCapability(capabilityId);
    if (!capability || capability.moduleId !== moduleId) {
      throw badRequest('capability-not-found', 'moduleId and capabilityId do not identify one bounded Kernel capability.');
    }
    if (capability.risk !== 'none' && capability.risk !== 'read') {
      const result = await submitLegacyTurn(
        app,
        request,
        principal,
        '/api/execute-stream',
        `Выполни только точную capability ${capabilityId} через Agent Runtime с exact input=${boundedLegacyPayload(body.input ?? {})}.`,
        { legacyCapabilityExecution: true },
      );
      response.writeHead(202, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      response.write(`event: turn\ndata: ${formatSseData(result)}\n\n`);
      response.write(`event: done\ndata: ${formatSseData({ turnId: result.intent.id })}\n\n`);
      response.end();
      return;
    }

    const execution: MonarchCapabilityExecution = {
      moduleId,
      capabilityId,
      input: body.input,
      requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'api',
      source: principal.source,
      confirmed: false,
    };
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

async function readJsonBody<T>(request: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw {
        statusCode: 413,
        code: 'request-too-large',
        message: `Request body exceeds ${maxBytes} bytes.`,
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

function readOscarDispositionHistory(value: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw badRequest('invalid-oscar-disposition-history', 'Oscar disposition history must contain at most 4 messages.');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || !('role' in entry) || !('content' in entry)) {
      throw badRequest('invalid-oscar-disposition-history', 'Oscar disposition history contains an invalid message.');
    }
    const role = entry.role;
    const content = entry.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim() || content.length > 4_000) {
      throw badRequest('invalid-oscar-disposition-history', 'Oscar disposition history contains an invalid message.');
    }
    return { role, content };
  });
}

function markLegacyAdapter(response: ServerResponse, endpoint: string): void {
  response.setHeader('Deprecation', 'true');
  response.setHeader('Sunset', 'Sat, 29 Aug 2026 00:00:00 GMT');
  response.setHeader('Link', '</api/oscar/turns>; rel="successor-version"');
  response.setHeader('X-Monarch-Legacy-Adapter', endpoint);
}

function rejectLegacyTextConfirmation(body: Record<string, unknown>): void {
  if (body.confirmed === true || typeof body.confirmationToken === 'string') {
    throw {
      statusCode: 410,
      code: 'legacy-text-confirmation-disabled',
      message: 'Text confirmation tokens cannot authorize an action. Use the exact structured Agent approval endpoint.',
    } satisfies JsonError;
  }
}

function boundedLegacyPayload(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 12_000) {
    throw badRequest('legacy-payload-too-large', 'Legacy action payload is too large for a bounded Agent Turn.');
  }
  return serialized;
}

async function submitLegacyTurn(
  app: MonarchApplication,
  request: IncomingMessage,
  principal: MonarchHttpPrincipal,
  endpoint: string,
  text: string,
  contextInput: Record<string, unknown>,
) {
  const source = principal.source;
  const nonce = randomBytes(12).toString('hex');
  const context = {
    ...contextInput,
    clientConversationId: `legacy:${source}:${readBoundedContextText(contextInput.clientConversationId, 160) || nonce}`,
    clientRequestId: readBoundedContextText(contextInput.clientRequestId, 256)
      || `legacy:${source}:${endpoint.replace(/[^A-Za-z0-9]/g, '_')}:${nonce}`,
    clientMessageId: readBoundedContextText(contextInput.clientMessageId, 256)
      || `legacy:${source}:message:${nonce}`,
  };
  await app.runtime.kernel.audit('legacy-api', 'Legacy endpoint adapted to Oscar Turn.', {
    endpoint,
    method: request.method || 'UNKNOWN',
    source,
  }, 'warn');
  return app.submitAgentSurfaceIntent({ text, source, context });
}

function legacyTurnJob(result: MonarchIntentResult, text: string, timeoutMs: number) {
  const now = new Date().toISOString();
  const output = result.execution?.output && typeof result.execution.output === 'object'
    ? result.execution.output as Record<string, unknown>
    : {};
  const id = typeof output.turnId === 'string' ? output.turnId : result.intent.id;
  const pending = result.execution?.error === 'confirmation-required'
    || result.execution?.error === 'clarification-required'
    || result.execution?.error === 'turn-running';
  const status = pending ? 'running' : result.execution?.ok ? 'completed' : 'failed';
  return {
    id,
    text,
    source: result.intent.source,
    status,
    createdAt: result.intent.createdAt,
    updatedAt: now,
    startedAt: result.intent.createdAt,
    finishedAt: pending ? null : now,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, Math.min(600_000, Math.floor(timeoutMs))) : 180_000,
    summary: result.summary,
    progress: [`turn:${String(output.status || status)}`],
    result,
    error: pending || result.execution?.ok ? null : result.execution?.error || 'turn-failed',
    turnId: id,
    legacy: true,
  };
}

function legacyCheckpointJob(checkpoint: OscarTurnCheckpoint) {
  const turn = checkpoint.turn;
  const status = legacyTurnStatus(turn);
  const terminal = ['completed', 'failed', 'cancelled'].includes(status);
  const summary = turn.outcome?.summary
    || latestTurnPrompt(checkpoint)
    || 'Oscar Turn выполняется.';
  const result = legacyTurnResult(checkpoint, summary);
  return {
    id: turn.id,
    text: turn.request.text,
    source: turn.source,
    status,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    startedAt: turn.createdAt,
    finishedAt: terminal ? turn.outcome?.completedAt || turn.updatedAt : null,
    timeoutMs: 180_000,
    summary,
    progress: checkpoint.events.map((event) => event.type),
    result,
    error: turn.status === 'failed' || turn.status === 'blocked' ? turn.outcome?.kind || turn.status : null,
    turnId: turn.id,
    legacy: true,
  };
}

function legacyTurnStatus(turn: OscarTurnV1): string {
  if (turn.status === 'succeeded') return 'completed';
  if (turn.status === 'cancelled') return 'cancelled';
  if (turn.status === 'blocked' || turn.status === 'failed') return 'failed';
  return turn.status;
}

function isLegacyTurnSettled(status: OscarTurnV1['status']): boolean {
  return ['waiting-for-user', 'waiting-for-approval', 'succeeded', 'blocked', 'failed', 'cancelled'].includes(status);
}

function legacyTurnResult(checkpoint: OscarTurnCheckpoint, summary: string): MonarchIntentResult {
  const turn = checkpoint.turn;
  const ok = turn.status === 'succeeded';
  const error = turn.status === 'waiting-for-approval'
    ? 'confirmation-required'
    : turn.status === 'waiting-for-user'
      ? 'clarification-required'
      : turn.status === 'blocked'
        ? 'turn-blocked'
        : turn.status === 'failed'
          ? 'turn-failed'
          : turn.status === 'cancelled'
            ? 'turn-cancelled'
            : ok ? undefined : 'turn-running';
  const approval = [...checkpoint.events].reverse().find((event) => event.type === 'approval.required');
  return {
    intent: {
      id: turn.id,
      text: turn.request.text,
      source: turn.source === 'coder' ? 'desktop' : turn.source,
      createdAt: turn.createdAt,
    },
    route: null,
    plan: null,
    execution: {
      ok,
      summary,
      ...(error ? { error } : {}),
      output: {
        reply: summary,
        turnId: turn.id,
        taskId: turn.taskId || null,
        status: turn.status,
        outcome: turn.outcome?.kind || null,
      },
      ...(approval ? { metadata: { approvalPresentation: approval.payload } } : {}),
    },
    summary,
  };
}

function latestTurnPrompt(checkpoint: OscarTurnCheckpoint): string {
  const event = [...checkpoint.events].reverse().find((candidate) => candidate.type === 'user.input.required');
  return typeof event?.payload.question === 'string' ? event.payload.question : '';
}

async function listLegacyTurnJobs(app: MonarchApplication, limit: number) {
  const turns = [
    ...await app.oscarTurnCoordinator.persistentStore.listTurns(),
    ...await app.oscarTurnCoordinator.volatileStore.listTurns(),
  ]
    .filter((turn) => turn.conversationId.startsWith('legacy:'))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
  const checkpoints = await Promise.all(turns.map((turn) => app.oscarTurnCoordinator.getTurn(turn.id)));
  return checkpoints.filter((entry): entry is OscarTurnCheckpoint => Boolean(entry)).map(legacyCheckpointJob);
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
  const desktopAttestationToken = (
    options.desktopAttestationToken
    || process.env.MONARCH_DESKTOP_ATTESTATION_TOKEN
    || ''
  ).trim();

  return {
    apiToken,
    desktopAttestationToken,
    requireApiToken,
    origin: `http://${host}:${port}`,
    allowNonLoopbackMutations: options.allowNonLoopbackMutations
      ?? readBooleanEnv('MONARCH_ALLOW_NON_LOOPBACK_MUTATIONS', false),
  };
}

function deriveMonarchHttpPrincipal(
  request: IncomingMessage,
  session: MonarchHttpSession,
): MonarchHttpPrincipal {
  const loopback = isLoopbackRemoteAddress(request.socket.remoteAddress);
  const originHeader = readHeader(request, 'origin').trim();
  const origin: MonarchHttpOriginState = !originHeader
    ? 'absent'
    : sameOrigin(originHeader, session.origin)
      ? 'same-origin'
      : 'mismatch';
  const suppliedToken = readApiToken(request);
  const apiToken: MonarchHttpCredentialState = !session.requireApiToken
    ? 'disabled'
    : !suppliedToken
      ? 'absent'
      : constantTimeEquals(suppliedToken, session.apiToken)
        ? 'valid'
        : 'invalid';
  const attestation = readHeader(request, 'x-monarch-desktop-attestation').trim();
  const desktopAttestation: MonarchHttpPrincipal['desktopAttestation'] = !attestation
    ? 'absent'
    : session.desktopAttestationToken && constantTimeEquals(attestation, session.desktopAttestationToken)
      ? 'valid'
      : 'invalid';
  const source = loopback && desktopAttestation === 'valid' && origin !== 'mismatch'
    ? 'desktop'
    : 'api';

  return Object.freeze({
    source,
    loopback,
    mutationPeerAllowed: isMutationPeerAllowed(request.socket.remoteAddress, session.allowNonLoopbackMutations),
    origin,
    apiToken,
    desktopAttestation,
  });
}

export function projectMonarchStateForPrincipal(
  state: MonarchApplicationState,
  principal: MonarchHttpPrincipal,
): MonarchApplicationState {
  if (principal.source === 'desktop' && principal.desktopAttestation === 'valid') return state;
  const { ownerDev: _ownerDev, ...publicState } = state;
  return {
    ...publicState,
    authority: MONARCH_PUBLIC_AUTHORITY_CONTEXT,
  };
}

function enforceMutationGuards(principal: MonarchHttpPrincipal): void {
  if (!principal.mutationPeerAllowed) {
    throw {
      statusCode: 403,
      code: 'non-loopback-host-blocked',
      message: 'Mutating Monarch API calls are only allowed from a loopback connection.',
    } satisfies JsonError;
  }

  if (principal.origin === 'mismatch') {
    throw {
      statusCode: 403,
      code: 'untrusted-origin',
      message: 'Mutating Monarch API calls require the trusted Monarch UI origin.',
    } satisfies JsonError;
  }

  if (principal.source === 'desktop' && principal.desktopAttestation === 'valid') {
    return;
  }
  if (principal.apiToken === 'disabled' || principal.apiToken === 'valid') {
    return;
  }
  throw {
    statusCode: 401,
    code: 'invalid-api-token',
    message: 'Mutating Monarch API calls require a valid UI session token.',
  } satisfies JsonError;
}

function enforceReadApiToken(principal: MonarchHttpPrincipal): void {
  if (principal.origin === 'mismatch') {
    throw {
      statusCode: 403,
      code: 'untrusted-origin',
      message: 'Monarch API reads reject a mismatched browser origin.',
    } satisfies JsonError;
  }

  if (principal.source === 'desktop' && principal.desktopAttestation === 'valid') {
    return;
  }
  if (principal.apiToken === 'disabled' || principal.apiToken === 'valid') {
    return;
  }
  throw {
    statusCode: 401,
    code: 'invalid-api-token',
    message: 'Sensitive Monarch API reads require a valid UI session token.',
  } satisfies JsonError;
}

function enforceDesktopSettingsPrincipal(principal: MonarchHttpPrincipal, mutation: boolean): void {
  if (mutation && !principal.mutationPeerAllowed) {
    throw {
      statusCode: 403,
      code: 'settings-loopback-required',
      message: 'Local settings changes require the local Desktop runtime.',
    } satisfies JsonError;
  }
  if (principal.origin === 'mismatch') {
    throw {
      statusCode: 403,
      code: 'untrusted-origin',
      message: 'Local settings reject a mismatched browser origin.',
    } satisfies JsonError;
  }
  if (!principal.loopback || principal.source !== 'desktop' || principal.desktopAttestation !== 'valid') {
    throw {
      statusCode: 403,
      code: 'settings-desktop-required',
      message: 'Local context settings require a valid Desktop attestation.',
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
