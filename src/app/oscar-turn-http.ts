import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { MonarchApplication } from './application';
import type { MonarchHttpPrincipal } from './http-server';
import type {
  OscarPrivacyMode,
  OscarTurnCheckpoint,
  OscarTurnModifiers,
  OscarTurnSource,
  OscarTurnStoreCommit,
} from '../oscar-turn';
import { requestReferencesComputerUseCapability } from '../modules/computer';

const MAX_TURN_BODY_BYTES = 512 * 1024;
const MAX_ATTACHMENT_BODY_BYTES = 12 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(['succeeded', 'blocked', 'failed', 'cancelled']);

export interface OscarTurnHttpContext {
  app: MonarchApplication;
  url: URL;
  request: IncomingMessage;
  response: ServerResponse;
  enforceMutation: () => void;
  enforceRead: () => void;
  principal: MonarchHttpPrincipal;
}

export async function handleOscarTurnHttpRequest(context: OscarTurnHttpContext): Promise<boolean> {
  const { app, url, request, response } = context;
  if (url.pathname !== '/api/oscar/attachments'
    && !url.pathname.startsWith('/api/oscar/attachments/')
    && url.pathname !== '/api/oscar/data-egress-consents'
    && !url.pathname.startsWith('/api/oscar/data-egress-consents/')
    && url.pathname !== '/api/oscar/incognito-conversations'
    && !url.pathname.startsWith('/api/oscar/incognito-conversations/')
    && url.pathname !== '/api/oscar/turn-cancellations'
    && url.pathname !== '/api/oscar/turns'
    && !url.pathname.startsWith('/api/oscar/turns/')) return false;

  const devSettings = app.getOwnerDevSettings();
  const zeroRetention = devSettings.zeroRetentionEnabled;

  if (request.method === 'POST' && url.pathname === '/api/oscar/attachments') {
    context.enforceMutation();
    const body = await readBoundedJson(request, MAX_ATTACHMENT_BODY_BYTES);
    assertVersion(body);
    assertKeys(body, ['version', 'conversationId', 'privacyMode', 'surface', 'name', 'mimeType', 'dataBase64']);
    const privacyMode = zeroRetention ? 'incognito' : readPrivacyMode(body.privacyMode);
    if (privacyMode === 'incognito') assertDesktopIncognitoPrincipal(context.principal.source);
    const source = resolveHttpSource(body.surface, context.principal.source);
    const attachment = await app.oscarAttachmentStore.put({
      conversationId: readId(body.conversationId, 'conversationId'),
      privacyMode,
      source,
      name: readText(body.name, 'name', 120),
      mimeType: readText(body.mimeType, 'mimeType', 80),
      dataBase64: readText(body.dataBase64, 'dataBase64', 12 * 1024 * 1024, false),
    });
    sendJson(response, 201, { version: 1, ok: true, attachment });
    return true;
  }

  const attachmentRead = url.pathname.match(/^\/api\/oscar\/attachments\/([^/]+)$/u);
  if (request.method === 'GET' && attachmentRead?.[1]) {
    context.enforceRead();
    const privacyMode = readPrivacyMode(url.searchParams.get('privacyMode') || undefined);
    const source = resolveHttpSource(url.searchParams.get('surface') || undefined, context.principal.source);
    const conversationId = readId(url.searchParams.get('conversationId'), 'conversationId');
    const [attachment] = await app.oscarAttachmentStore.resolve([
      decodeId(attachmentRead[1], 'attachmentId'),
    ], privacyMode, source, conversationId);
    sendJson(response, 200, { version: 1, ok: true, attachment });
    return true;
  }

  if (url.pathname === '/api/oscar/attachments' || url.pathname.startsWith('/api/oscar/attachments/')) {
    sendJson(response, 405, { version: 1, ok: false, error: 'method-not-allowed', message: 'Use POST to upload or GET to read a bound Oscar attachment.' });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/oscar/data-egress-consents') {
    context.enforceMutation();
    if (!devSettings.internetEnabled) {
      throw httpError(403, 'oscar-internet-disabled', 'Интернет отключён политикой Owner DEV.');
    }
    const body = await readBoundedJson(request, MAX_TURN_BODY_BYTES);
    assertVersion(body);
    assertKeys(body, [
      'version', 'clientRequestId', 'conversationId', 'privacyMode', 'surface', 'text',
      'attachmentIds', 'webSearch', 'researchMode',
    ]);
    const source = resolveHttpSource(body.surface, context.principal.source);
    if (zeroRetention) assertDesktopIncognitoPrincipal(context.principal.source);
    const consent = await app.oscarDataEgressConsentStore.createProposal(
      readId(body.clientRequestId, 'clientRequestId'),
      {
        conversationId: readId(body.conversationId, 'conversationId'),
        privacyMode: zeroRetention ? 'incognito' : readPrivacyMode(body.privacyMode),
        source,
        text: readText(body.text, 'text', 20_000),
        attachmentIds: body.attachmentIds === undefined ? [] : readIdArray(body.attachmentIds, 'attachmentIds', 3),
        webSearch: body.webSearch === true,
        researchMode: body.researchMode === 'deep' ? 'deep' : body.researchMode === 'off' ? 'off' : 'auto',
      },
    );
    sendJson(response, 201, {
      version: 1,
      ok: true,
      consent,
      presentation: {
        title: consent.purpose === 'deep-research' ? 'Передать данные для Deep Research?' : 'Передать данные для web-поиска?',
        target: 'Публичные интернет-источники',
        dataClasses: ['текст запроса', ...(consent.attachmentCount ? [`вложения: ${consent.attachmentCount}`] : [])],
        expiresAt: consent.expiresAt,
        canonicalBindingHash: consent.canonicalBindingHash,
      },
    });
    return true;
  }

  const consentDecision = url.pathname.match(/^\/api\/oscar\/data-egress-consents\/([^/]+)\/decision$/u);
  if (request.method === 'POST' && consentDecision?.[1]) {
    context.enforceMutation();
    if (!devSettings.internetEnabled) {
      throw httpError(403, 'oscar-internet-disabled', 'Интернет отключён политикой Owner DEV.');
    }
    const body = await readBoundedJson(request, 16 * 1024);
    assertVersion(body);
    assertKeys(body, ['version', 'decision', 'canonicalBindingHash', 'surface']);
    const source = resolveHttpSource(body.surface, context.principal.source);
    const consent = await app.oscarDataEgressConsentStore.decide({
      consentId: decodeId(consentDecision[1], 'consentId'),
      source,
      canonicalBindingHash: readText(body.canonicalBindingHash, 'canonicalBindingHash', 80),
      decision: body.decision === 'grant' ? 'grant' : body.decision === 'deny'
        ? 'deny'
        : (() => { throw httpError(400, 'invalid-consent-decision', 'decision must be grant or deny.'); })(),
    });
    sendJson(response, 200, { version: 1, ok: true, consent });
    return true;
  }

  if (url.pathname === '/api/oscar/data-egress-consents' || url.pathname.startsWith('/api/oscar/data-egress-consents/')) {
    sendJson(response, 405, { version: 1, ok: false, error: 'method-not-allowed', message: 'Unsupported data-egress consent method.' });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/oscar/incognito-conversations') {
    context.enforceMutation();
    assertDesktopIncognitoPrincipal(context.principal.source);
    const body = await readBoundedJson(request, 8 * 1024);
    assertVersion(body);
    assertKeys(body, ['version']);
    sendJson(response, 201, {
      version: 1,
      ok: true,
      conversationId: createIncognitoConversationId(),
    });
    return true;
  }

  const incognitoConversation = url.pathname.match(/^\/api\/oscar\/incognito-conversations\/([^/]+)$/u);
  if (request.method === 'DELETE' && incognitoConversation?.[1]) {
    context.enforceMutation();
    assertDesktopIncognitoPrincipal(context.principal.source);
    const body = await readBoundedJson(request, 8 * 1024);
    assertVersion(body);
    assertKeys(body, ['version']);
    const conversationId = decodeId(incognitoConversation[1], 'conversationId');
    const discardedTurns = await app.oscarTurnCoordinator.discardIncognitoConversation(
      conversationId,
      context.principal.source,
    );
    sendJson(response, 200, { version: 1, ok: true, conversationId, discardedTurns });
    return true;
  }

  if (url.pathname === '/api/oscar/incognito-conversations' || url.pathname.startsWith('/api/oscar/incognito-conversations/')) {
    sendJson(response, 405, { version: 1, ok: false, error: 'method-not-allowed', message: 'Unsupported incognito conversation method.' });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/oscar/turn-cancellations') {
    context.enforceMutation();
    const body = await readBoundedJson(request, 8 * 1024);
    assertVersion(body);
    assertKeys(body, ['version', 'clientRequestId', 'privacyMode', 'surface']);
    const source = resolveHttpSource(body.surface, context.principal.source);
    const privacyMode = zeroRetention ? 'incognito' : readPrivacyMode(body.privacyMode);
    if (privacyMode === 'incognito') assertDesktopIncognitoPrincipal(context.principal.source);
    const cancellation = await app.oscarTurnCoordinator.cancelByClientRequestId({
      clientRequestId: readId(body.clientRequestId, 'clientRequestId'),
      source,
      privacyMode,
    });
    sendJson(response, 200, {
      version: 1,
      ok: true,
      cancellation: {
        clientRequestId: cancellation.clientRequestId,
        reserved: cancellation.reserved,
      },
      ...(cancellation.checkpoint ? {
        turn: cancellation.checkpoint.turn,
        events: cancellation.checkpoint.events,
      } : {}),
    });
    return true;
  }

  if (url.pathname === '/api/oscar/turn-cancellations') {
    sendJson(response, 405, { version: 1, ok: false, error: 'method-not-allowed', message: 'Use POST to reserve or resolve an Oscar submission cancellation.' });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/oscar/turns') {
    context.enforceMutation();
    const components = app.getComponentManagerSnapshot();
    const onboardingRequired = 'onboarding' in components && components.onboarding.required;
    if (!components.ready && (onboardingRequired || components.autoRepairEnabled)) {
      if (!onboardingRequired && components.autoRepairEnabled) void app.ensureRequiredComponents();
      sendJson(response, 409, {
        version: 1,
        ok: false,
        error: 'required-model-not-ready',
        message: components.requiredModel.phase === 'failed'
          ? components.requiredModel.error
          : onboardingRequired
            ? 'Сначала выбери модель на стартовом экране.'
            : 'Monarch устанавливает модель. Чат станет доступен автоматически.',
        component: components.requiredModel,
      });
      return true;
    }
    const body = await readBoundedJson(request, MAX_TURN_BODY_BYTES);
    assertVersion(body);
    assertKeys(body, [
      'version', 'clientRequestId', 'conversationId', 'text', 'privacyMode', 'surface', 'inputMessageId',
      'attachmentIds', 'modifiers', 'history', 'replyToTurnId', 'supersedesTurnId', 'retryOf',
    ]);
    const source = resolveHttpSource(body.surface, context.principal.source);
    const privacyMode = zeroRetention ? 'incognito' : readPrivacyMode(body.privacyMode);
    if (privacyMode === 'incognito') assertDesktopIncognitoPrincipal(context.principal.source);
    const conversationId = privacyMode === 'incognito' && !String(body.conversationId || '').trim()
      ? createIncognitoConversationId()
      : readId(body.conversationId, 'conversationId');
    const text = readText(body.text, 'text', 20_000);
    const clientModifiers = body.modifiers !== undefined ? readModifiers(body.modifiers) : {};
    if (!devSettings.internetEnabled) {
      clientModifiers.webSearch = false;
      clientModifiers.researchMode = 'off';
      delete clientModifiers.dataEgressConsentId;
    }
    const needsComputerUseCapability = requestReferencesComputerUseCapability(text);
    const [imageIntent, computerUseCapability] = await Promise.all([
      app.imageGeneration.evaluateIntent(text),
      needsComputerUseCapability
        ? app.readComputerUseCapabilitySnapshot()
        : Promise.resolve(undefined),
    ]);
    const modifiers: OscarTurnModifiers = {
      ...clientModifiers,
      imageGenerationCapability: app.imageGeneration.readCapabilitySnapshot(),
      ...(computerUseCapability ? { computerUseCapability } : {}),
      ...(imageIntent.isImageGeneration ? {
        imageGeneration: {
          schemaVersion: 1,
          contentRating: imageIntent.contentRating === 'nsfw' ? 'nsfw' : 'safe',
          disposition: imageIntent.disposition as Exclude<typeof imageIntent.disposition, 'not-image-generation'>,
          providerId: imageIntent.providerId,
        },
      } : {}),
    };
    const checkpoint = await app.oscarTurnCoordinator.submit({
      clientRequestId: readId(body.clientRequestId, 'clientRequestId'),
      conversationId,
      text,
      privacyMode,
      source,
      ...(body.inputMessageId !== undefined ? { inputMessageId: readId(body.inputMessageId, 'inputMessageId') } : {}),
      ...(body.attachmentIds !== undefined ? { attachmentIds: readIdArray(body.attachmentIds, 'attachmentIds', 3) } : {}),
      ...(Object.keys(modifiers).length ? { modifiers } : {}),
      ...(devSettings.historyContextEnabled && body.history !== undefined ? { history: readHistory(body.history) } : {}),
      ...(!zeroRetention && body.replyToTurnId !== undefined ? { replyToTurnId: readId(body.replyToTurnId, 'replyToTurnId') } : {}),
      ...(!zeroRetention && body.supersedesTurnId !== undefined ? { supersedesTurnId: readId(body.supersedesTurnId, 'supersedesTurnId') } : {}),
      ...(!zeroRetention && body.retryOf !== undefined ? { retryOf: readId(body.retryOf, 'retryOf') } : {}),
    });
    sendJson(response, checkpoint.turn.status === 'blocked' ? 200 : 202, publicCheckpoint(checkpoint));
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/oscar/turns') {
    context.enforceRead();
    const clientRequestIdInput = url.searchParams.get('clientRequestId');
    if (clientRequestIdInput !== null) {
      const source = resolveHttpSource(url.searchParams.get('surface') || undefined, context.principal.source);
      const privacyMode = zeroRetention ? 'incognito' : readPrivacyMode(url.searchParams.get('privacyMode') || undefined);
      if (privacyMode === 'incognito') assertDesktopIncognitoPrincipal(context.principal.source);
      const checkpoint = await app.oscarTurnCoordinator.findTurnByClientRequestId({
        clientRequestId: readId(clientRequestIdInput, 'clientRequestId'),
        source,
        privacyMode,
      });
      if (!checkpoint) throw httpError(404, 'turn-not-found', 'Oscar Turn was not found.');
      sendJson(response, 200, publicCheckpoint(checkpoint));
      return true;
    }
    const turns = (await app.oscarTurnCoordinator.persistentStore.listTurns())
      .filter((turn) => sourceCanRead(context.principal.source, turn.source));
    sendJson(response, 200, { version: 1, ok: true, turns });
    return true;
  }

  const match = url.pathname.match(/^\/api\/oscar\/turns\/([^/]+)(?:\/(events|messages|cancel))?$/u);
  if (!match?.[1]) {
    sendJson(response, 405, { version: 1, ok: false, error: 'method-not-allowed', message: 'Unsupported Oscar Turn method.' });
    return true;
  }
  const turnId = decodeId(match[1], 'turnId');
  const action = match[2] || '';
  if (request.method === 'GET') context.enforceRead();
  else if (request.method === 'POST') context.enforceMutation();
  else {
    sendJson(response, 405, { version: 1, ok: false, error: 'method-not-allowed', message: 'Unsupported Oscar Turn method.' });
    return true;
  }
  const checkpoint = await app.oscarTurnCoordinator.getTurn(turnId);
  if (!checkpoint) throw httpError(404, 'turn-not-found', 'Oscar Turn was not found.');
  assertReadableSource(context.principal.source, checkpoint.turn.source);

  if (request.method === 'GET' && !action) {
    sendJson(response, 200, publicCheckpoint(checkpoint));
    return true;
  }

  if (request.method === 'GET' && action === 'events') {
    const after = readAfterSequence(request, url);
    if (url.searchParams.get('format') === 'json' || !acceptsEventStream(request)) {
      sendJson(response, 200, {
        version: 1,
        ok: true,
        turn: checkpoint.turn,
        events: checkpoint.events.filter((event) => event.sequence > after),
      });
      return true;
    }
    streamTurnEvents(app, turnId, after, request, response);
    return true;
  }

  if (request.method === 'POST' && action === 'messages') {
    if (zeroRetention && checkpoint.turn.privacyMode === 'persistent') {
      throw httpError(409, 'zero-retention-new-session-required', 'Нулевое хранение требует нового volatile-чата.');
    }
    const body = await readBoundedJson(request, MAX_TURN_BODY_BYTES);
    assertVersion(body);
    assertKeys(body, ['version', 'content', 'messageId']);
    const updated = await app.oscarTurnCoordinator.sendMessage(turnId, {
      content: readText(body.content, 'content', 16_000),
      source: checkpoint.turn.source,
      ...(body.messageId !== undefined ? { messageId: readId(body.messageId, 'messageId') } : {}),
    });
    sendJson(response, 200, publicCheckpoint(updated));
    return true;
  }

  if (request.method === 'POST' && action === 'cancel') {
    const body = await readBoundedJson(request, 8 * 1024);
    assertVersion(body);
    assertKeys(body, ['version']);
    const updated = await app.oscarTurnCoordinator.cancel(turnId, checkpoint.turn.source);
    sendJson(response, 200, publicCheckpoint(updated));
    return true;
  }

  sendJson(response, 405, { version: 1, ok: false, error: 'method-not-allowed', message: 'Unsupported Oscar Turn method.' });
  return true;
}

function streamTurnEvents(
  app: MonarchApplication,
  turnId: string,
  after: number,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  let cursor = after;
  let initialized = false;
  let closed = false;
  const buffered: OscarTurnStoreCommit[] = [];
  const emitCheckpoint = (checkpoint: OscarTurnCheckpoint) => {
    for (const event of checkpoint.events.filter((candidate) => candidate.sequence > cursor)) {
      response.write(`id: ${event.sequence}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify({ version: 1, turnId, event })}\n\n`);
      cursor = event.sequence;
    }
    if (TERMINAL_STATUSES.has(checkpoint.turn.status)) close();
  };
  const unsubscribe = app.oscarTurnCoordinator.subscribe(turnId, (commit) => {
    if (!initialized) buffered.push(commit);
    else emitCheckpoint({ turn: commit.turn, events: commit.appendedEvents });
  });
  const keepAlive = setInterval(() => {
    if (!closed) response.write(': keep-alive\n\n');
  }, 15_000);
  keepAlive.unref?.();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
    if (!response.writableEnded) response.end();
  };
  request.once('close', close);
  void app.oscarTurnCoordinator.getTurn(turnId).then((latest) => {
    if (!latest || closed) return close();
    emitCheckpoint(latest);
    initialized = true;
    for (const commit of buffered.splice(0)) {
      if (closed) break;
      emitCheckpoint({ turn: commit.turn, events: commit.appendedEvents });
    }
  }).catch(() => close());
}

function publicCheckpoint(checkpoint: OscarTurnCheckpoint) {
  return { version: 1, ok: true, turn: checkpoint.turn, events: checkpoint.events };
}

function readAfterSequence(request: IncomingMessage, url: URL): number {
  const query = url.searchParams.get('after');
  const header = request.headers['last-event-id'];
  const raw = query || (Array.isArray(header) ? header[0] : header) || '0';
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function acceptsEventStream(request: IncomingMessage): boolean {
  return String(request.headers.accept || '').toLowerCase().includes('text/event-stream');
}

async function readBoundedJson(request: IncomingMessage, maximum: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximum) throw httpError(413, 'request-too-large', `Request body exceeds ${maximum} bytes.`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!record(value)) throw new Error('not-object');
    return value;
  } catch {
    throw httpError(400, 'invalid-json', 'Request body must be a JSON object.');
  }
}

function assertVersion(body: Record<string, unknown>): void {
  if (body.version !== 1) throw httpError(400, 'unsupported-version', 'Oscar Turn API version must be 1.');
}

function assertKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw httpError(400, 'unknown-fields', `Unsupported fields: ${unknown.join(', ')}.`);
}

function readId(value: unknown, label: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) throw httpError(400, `invalid-${label}`, `${label} is invalid.`);
  return id;
}

function decodeId(value: string, label: string): string {
  try {
    return readId(decodeURIComponent(value), label);
  } catch (error) {
    if (error instanceof URIError) throw httpError(400, `invalid-${label}`, `${label} is invalid.`);
    throw error;
  }
}

function readText(value: unknown, label: string, maximum: number, collapse = true): string {
  let text = typeof value === 'string' ? value : '';
  text = collapse ? text.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim() : text.trim();
  if (!text) throw httpError(400, `empty-${label}`, `${label} is required.`);
  if (text.length > maximum) throw httpError(413, `${label}-too-long`, `${label} is too long.`);
  return text;
}

function readIdArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw httpError(400, `invalid-${label}`, `${label} is invalid.`);
  return value.map((entry) => readId(entry, label));
}

function readPrivacyMode(value: unknown): OscarPrivacyMode {
  if (value === undefined || value === 'persistent') return 'persistent';
  if (value === 'incognito' || value === 'encrypted') return value;
  throw httpError(400, 'invalid-privacy-mode', 'privacyMode must be persistent, incognito, or encrypted.');
}

function resolveHttpSource(value: unknown, httpSource: 'desktop' | 'api'): OscarTurnSource {
  if (value === undefined || value === httpSource) return httpSource;
  if (httpSource === 'desktop' && value === 'voice') return 'voice';
  throw httpError(403, 'untrusted-oscar-source', `Oscar source is derived by Monarch as ${httpSource}.`);
}

function sourceCanRead(httpSource: 'desktop' | 'api', turnSource: OscarTurnSource): boolean {
  return turnSource === httpSource || (httpSource === 'desktop' && turnSource === 'voice');
}

function assertReadableSource(httpSource: 'desktop' | 'api', turnSource: OscarTurnSource): void {
  if (!sourceCanRead(httpSource, turnSource)) throw httpError(403, 'turn-source-mismatch', 'Oscar Turn belongs to another surface.');
}

function assertDesktopIncognitoPrincipal(source: 'desktop' | 'api'): void {
  if (source !== 'desktop') {
    throw httpError(403, 'desktop-only-incognito', 'Incognito conversations are available only to the local Desktop surface.');
  }
}

function createIncognitoConversationId(): string {
  return `incognito_${randomUUID().replace(/-/gu, '')}`;
}

function readModifiers(value: unknown): OscarTurnModifiers {
  if (!record(value)) throw httpError(400, 'invalid-modifiers', 'modifiers must be an object.');
  assertKeys(value, ['requestedModel', 'reasoningEffort', 'webSearch', 'researchMode', 'dataEgressConsentId']);
  return {
    ...(typeof value.requestedModel === 'string' ? { requestedModel: value.requestedModel } : {}),
    ...(value.reasoningEffort === 'low' || value.reasoningEffort === 'medium' || value.reasoningEffort === 'high'
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
    ...(typeof value.webSearch === 'boolean' ? { webSearch: value.webSearch } : {}),
    ...(value.researchMode === 'auto' || value.researchMode === 'off' || value.researchMode === 'deep'
      ? { researchMode: value.researchMode }
      : {}),
    ...(typeof value.dataEgressConsentId === 'string' ? { dataEgressConsentId: value.dataEgressConsentId } : {}),
  };
}

function readHistory(value: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(value) || value.length > 24) throw httpError(400, 'invalid-history', 'history must contain at most 24 messages.');
  return value.map((entry) => {
    if (!record(entry) || (entry.role !== 'user' && entry.role !== 'assistant')) {
      throw httpError(400, 'invalid-history', 'history contains an invalid message.');
    }
    return { role: entry.role, content: readText(entry.content, 'history-content', 20_000) };
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function httpError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
