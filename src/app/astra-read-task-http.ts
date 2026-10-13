import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MonarchHttpPrincipal } from './http-server';
import type { AstraAuthenticatedHttpActor, AstraTaskHttpRequest, AstraTaskHttpSurface } from './astra-task-facade';

export const ASTRA_READ_TASK_HTTP_PATH = '/api/astra/v3/read-tasks';
export const ASTRA_CREATE_TASK_HTTP_PATH = '/api/astra/v3/create-tasks';
export const ASTRA_COMPUTER_OBSERVE_TASK_HTTP_PATH = '/api/astra/v3/computer-observe-tasks';
export const ASTRA_COMPUTER_ACTION_TASK_HTTP_PATH = '/api/astra/v3/computer-action-tasks';
interface Context {
  facade?: AstraTaskHttpSurface; url: URL; request: IncomingMessage; response: ServerResponse;
  principal: MonarchHttpPrincipal; enforceMutation: () => void; enforceRead: () => void;
  authenticatedActor: () => AstraAuthenticatedHttpActor;
}
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
const error = (statusCode: number, code: string) => ({ statusCode, code, message: code });
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.version !== 1) throw error(400, 'astra-invalid-request');
}
function conversation(value: { conversationId?: unknown; inputMessageId?: unknown }): { conversationId: string; inputMessageId: string } {
  if (!identity(value.conversationId) || !identity(value.inputMessageId)) throw error(400, 'astra-invalid-source-context');
  return { conversationId: value.conversationId, inputMessageId: value.inputMessageId };
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status; response.setHeader('content-type', 'application/json; charset=utf-8'); response.end(JSON.stringify(body));
}

/** Default-off Application extension. It reuses the server's authenticated
 * principal, never a body/header assertion of actor/source. No default imports
 * of an instantiated Astra host, no direct Kernel access, no ordinary Turn route. */
export async function handleAstraReadTaskHttpRequest(context: Context): Promise<boolean> {
  return handleAstraTaskHttpRequest(context, ASTRA_READ_TASK_HTTP_PATH);
}
export async function handleAstraCreateTaskHttpRequest(context: Context): Promise<boolean> {
  return handleAstraTaskHttpRequest(context, ASTRA_CREATE_TASK_HTTP_PATH);
}
export async function handleAstraComputerObserveTaskHttpRequest(context: Context): Promise<boolean> {
  return handleAstraTaskHttpRequest(context, ASTRA_COMPUTER_OBSERVE_TASK_HTTP_PATH);
}
export async function handleAstraComputerActionTaskHttpRequest(context: Context): Promise<boolean> {
  return handleAstraTaskHttpRequest(context, ASTRA_COMPUTER_ACTION_TASK_HTTP_PATH);
}
async function handleAstraTaskHttpRequest(context: Context, basePath: typeof ASTRA_READ_TASK_HTTP_PATH | typeof ASTRA_CREATE_TASK_HTTP_PATH
  | typeof ASTRA_COMPUTER_OBSERVE_TASK_HTTP_PATH | typeof ASTRA_COMPUTER_ACTION_TASK_HTTP_PATH): Promise<boolean> {
  const { url, request, response, facade } = context;
  if (url.pathname !== basePath && !url.pathname.startsWith(basePath + '/')) return false;
  response.setHeader('cache-control', 'no-store');
  if (!facade) { send(response, 404, { version: 1, ok: false, error: 'astra-runtime-disabled' }); return true; }
  if (!context.principal.loopback) throw error(403, 'astra-loopback-required');
  if (request.method === 'GET') context.enforceRead(); else context.enforceMutation();
  const actor = context.authenticatedActor();
  if (url.pathname === basePath && request.method === 'GET') {
    if ([...url.searchParams.keys()].some(key => key !== 'conversationId') || url.searchParams.getAll('conversationId').length !== 1
      || !identity(url.searchParams.get('conversationId'))) throw error(400, 'astra-invalid-source-context');
    send(response, 200, { version: 1, ok: true, tasks: facade.list(actor, url.searchParams.get('conversationId')!) }); return true;
  }
  if (url.pathname === basePath && request.method === 'POST') {
    const body = await boundedJson(request);
    fields(body, ['version', 'clientRequestId', 'conversationId', 'inputMessageId', 'text', 'selectionId', 'privacyMode', 'goal']);
    const task = facade.submit(actor, body as unknown as AstraTaskHttpRequest);
    send(response, 202, { version: 1, ok: true, task }); return true;
  }
  const match = /^\/([A-Za-z0-9_-]{1,96})(?:\/(pause|resume|cancel|reconcile|ack|reply|decide))?$/u.exec(url.pathname.slice(basePath.length));
  if (!match?.[1]) throw error(405, 'astra-method-not-allowed');
  const taskId = match[1], action = match[2];
  if (request.method === 'GET' && !action) {
    if ([...url.searchParams.keys()].some(key => !['conversationId', 'inputMessageId'].includes(key))
      || url.searchParams.getAll('conversationId').length !== 1 || url.searchParams.getAll('inputMessageId').length !== 1) throw error(400, 'astra-invalid-source-context');
    const source = conversation({ conversationId: url.searchParams.get('conversationId'), inputMessageId: url.searchParams.get('inputMessageId') });
    send(response, 200, { version: 1, ok: true, task: facade.read(actor, taskId, source) }); return true;
  }
  if (request.method !== 'POST' || !action) throw error(405, 'astra-method-not-allowed');
  if (action === 'reply' && (basePath !== ASTRA_CREATE_TASK_HTTP_PATH || !facade.reply)) throw error(405, 'astra-reply-unsupported');
  if (action === 'decide' && (![ASTRA_CREATE_TASK_HTTP_PATH, ASTRA_COMPUTER_ACTION_TASK_HTTP_PATH].includes(basePath) || !facade.decide))
    throw error(405, 'astra-approval-unsupported');
  const body = await boundedJson(request);
  fields(body, ['version', 'conversationId', 'inputMessageId', ...(action === 'ack' ? ['certificateDigest']
    : action === 'reply' ? ['clientRequestId', 'questionId', 'questionDigest', 'replyMessageId', 'text']
      : action === 'decide' ? ['approvalId', 'approvalDigest', 'replyMessageId', 'decision'] : [])]);
  const source = conversation(body);
  const task = action === 'reply' ? facade.reply!(actor, taskId, source, {
    requestId: body.clientRequestId as string, questionId: body.questionId as string, questionDigest: body.questionDigest as string,
    messageId: body.replyMessageId as string, text: body.text as string })
    : action === 'decide' ? facade.decide!(actor, taskId, source, { approvalId: body.approvalId as string,
      approvalDigest: body.approvalDigest as string, messageId: body.replyMessageId as string, decision: body.decision as 'approve' | 'reject' })
    : action === 'reconcile' ? await facade.reconcile(actor, taskId, source)
    : action === 'ack' ? facade.acknowledge(actor, taskId, source, typeof body.certificateDigest === 'string' ? body.certificateDigest : '')
      : facade.command(actor, taskId, source, action as 'pause' | 'resume' | 'cancel');
  send(response, 200, { version: 1, ok: true, task }); return true;
}

function boundedJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/iu.test(String(request.headers['content-type'] ?? ''))) throw error(415, 'astra-json-required');
  const maximum = 65536, declared = request.headers['content-length'];
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw error(413, 'astra-request-too-large');
  return new Promise((resolve, reject) => {
    let bytes = 0, done = false; const chunks: Buffer[] = [];
    const finish = (failure?: unknown) => {
      if (done) return; done = true; clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', failed);
      if (failure) { request.resume(); reject(failure); return; }
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('object-required');
        resolve(value as Record<string, unknown>);
      } catch { reject(error(400, 'astra-invalid-json')); }
    };
    const data = (chunk: Buffer) => { bytes += chunk.length;
      if (bytes > maximum) finish(error(413, 'astra-request-too-large')); else chunks.push(chunk); };
    const end = () => finish();
    const failed = () => finish(error(400, 'astra-request-interrupted'));
    const timer = setTimeout(() => finish(error(408, 'astra-request-timeout')), 5000);
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed);
  });
}
