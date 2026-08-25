const API_TOKEN = typeof document === 'undefined'
  ? ''
  : document.querySelector('meta[name="monarch-api-token"]')?.getAttribute('content') || '';
let desktopAttestationPromise = null;
let desktopAttestationBridge = null;

const CLIENT_SESSION_ID_KEY = 'monarch.clientSessionId';
const CLIENT_CONVERSATION_ID_KEY = 'monarch.clientConversationId.default';
const VOICE_STREAM_CLIENT_ID_KEY = 'monarch.voiceStreamClientId';

function rejectLegacyConfirmation(confirmed, confirmationToken) {
  if (confirmed === true || String(confirmationToken || '').trim()) {
    const error = new Error('Текстовое подтверждение отключено. Используй точную Agent action-card.');
    error.code = 'legacy-text-confirmation-disabled';
    throw error;
  }
}

export function apiHeaders(customHeaders = {}) {
  const headers = { ...customHeaders };
  if (API_TOKEN) {
    headers['Authorization'] = `Bearer ${API_TOKEN}`;
    headers['X-Monarch-Session'] = API_TOKEN;
  }
  return headers;
}

async function mutationApiHeaders(customHeaders = {}) {
  const headers = apiHeaders(customHeaders);
  const bridge = typeof window === 'undefined' ? null : window.monarchDesktop;
  if (typeof bridge?.getMutationAttestation !== 'function') return headers;
  if (desktopAttestationBridge !== bridge) {
    desktopAttestationBridge = bridge;
    desktopAttestationPromise = null;
  }
  desktopAttestationPromise ||= Promise.resolve(bridge.getMutationAttestation())
    .then((value) => String(value || '').trim())
    .catch(() => '');
  const attestation = await desktopAttestationPromise;
  if (attestation) headers['X-Monarch-Desktop-Attestation'] = attestation;
  return headers;
}

async function refreshDesktopAttestation() {
  const bridge = typeof window === 'undefined' ? null : window.monarchDesktop;
  if (typeof bridge?.getMutationAttestation !== 'function') return false;
  desktopAttestationBridge = bridge;
  desktopAttestationPromise = null;
  const headers = await mutationApiHeaders();
  return Boolean(headers['X-Monarch-Desktop-Attestation']);
}

export async function fetchState() {
  const response = await fetch('/api/state', {
    headers: apiHeaders(),
  });
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status));
  }
  return response.json();
}

export async function ensureRequiredComponents() {
  const response = await fetch('/api/components/ensure', {
    method: 'POST',
    headers: await mutationApiHeaders(),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok && response.status !== 202) throw createMonarchHttpError(response.status, payload);
  return payload;
}

export async function installModels(roles, source = 'settings') {
  const response = await fetch('/api/models/install', {
    method: 'POST',
    headers: await mutationApiHeaders(),
    body: JSON.stringify({ roles, source }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok && response.status !== 202) throw createMonarchHttpError(response.status, payload);
  return payload;
}

export async function skipModelOnboarding() {
  return postModelOnboardingMutation('/api/models/onboarding/skip');
}

export async function acknowledgeModelOnboardingWelcome() {
  return postModelOnboardingMutation('/api/models/onboarding/welcome');
}

async function postModelOnboardingMutation(url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: await mutationApiHeaders(),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload;
}

export async function fetchImageGenerationContext() {
  const response = await fetch('/api/images/context', { headers: apiHeaders() });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload?.context;
}

export async function fetchImageProviderAgreement() {
  const response = await fetch('/api/images/provider-agreement', { headers: apiHeaders() });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload?.agreement;
}

export async function translateImagePrompt(text) {
  const response = await fetch('/api/images/prompt/translate', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text: String(text || '') }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload?.translation;
}

export async function updateImageGenerationPolicy(command) {
  const response = await fetch('/api/images/policy', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(command && typeof command === 'object' ? command : {}),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload?.policy;
}

export async function evaluateImageGenerationIntent(text, options = {}) {
  const response = await fetch('/api/images/intents/evaluate', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text: String(text || '').trim() }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload?.intent;
}

export async function prepareImageGeneration(draft, options = {}) {
  const response = await fetch('/api/images/generations', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(draft && typeof draft === 'object' ? draft : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload = await readOptionalJson(response);
  if (payload?.preparation) return payload.preparation;
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload;
}

export async function fetchImageGenerationJob(id, options = {}) {
  const response = await fetch(`/api/images/generations/${encodeURIComponent(id)}`, {
    headers: apiHeaders(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload?.job;
}

export async function cancelImageGenerationJob(id) {
  const response = await fetch(`/api/images/generations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await mutationApiHeaders(),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload?.job;
}

export async function fetchImageGenerationResult(jobId, index) {
  const response = await fetch(`/api/images/generations/${encodeURIComponent(jobId)}/results/${encodeURIComponent(index)}`, {
    headers: apiHeaders(),
  });
  if (!response.ok) {
    const payload = await readOptionalJson(response);
    throw createMonarchHttpError(response.status, payload);
  }
  return response.blob();
}

export async function saveImageGenerationResults(jobId) {
  const response = await fetch(`/api/images/generations/${encodeURIComponent(jobId)}/save`, {
    method: 'POST',
    headers: await mutationApiHeaders(),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload?.job;
}

export async function importImageToLibrary(input) {
  const response = await fetch('/api/images/library/import', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(input && typeof input === 'object' ? input : {}),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload?.record;
}

export async function deleteImageLibraryRecord(id) {
  const response = await fetch(`/api/images/library/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await mutationApiHeaders(),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload;
}

export async function fetchImageLibraryAsset(id) {
  const response = await fetch(`/api/images/library/${encodeURIComponent(id)}/content`, {
    headers: apiHeaders(),
  });
  if (!response.ok) {
    const payload = await readOptionalJson(response);
    throw createMonarchHttpError(response.status, payload);
  }
  return response.blob();
}

export async function readLocalSettings(kind, scope = { type: 'chat' }) {
  const response = await fetch('/api/settings/read', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ schemaVersion: 1, kind, scope }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  // The canonical backend contract returns the context directly. Accept the
  // temporary wrapper as well for mixed-version desktop/runtime recovery.
  return payload?.context || payload;
}

export async function writeLocalSettings(command, payload, options = {}) {
  const scope = options.scope || { type: 'chat' };
  const clientRequestId = options.clientRequestId || createClientScopeId();
  const response = await fetch('/api/settings/commands', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      schemaVersion: 1,
      clientRequestId,
      command,
      scope,
      expectedRevision: Math.max(0, Number(options.expectedRevision) || 0),
      payload: payload && typeof payload === 'object' ? payload : {},
    }),
  });
  const responsePayload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, responsePayload);
  // SettingsCommandBus returns the typed durable receipt directly. Keep the
  // temporary wrapped shape readable while older desktop/runtime pairs age out.
  const receipt = responsePayload?.receipt || responsePayload;
  const kind = String(command || '').split('.')[0];
  const context = await readLocalSettings(kind, scope);
  if (!receipt || receipt.contentHash !== context?.contentHash || receipt.revision !== context?.revision) {
    const error = new Error('Сервис не подтвердил сохранённые настройки контрольным чтением.');
    error.code = 'settings-readback-mismatch';
    throw error;
  }
  return { receipt, context };
}

export async function previewPersonality(scope = { type: 'chat' }) {
  const response = await fetch('/api/settings/personality/preview', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ scope }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload.preview;
}

export async function fetchOscarRequestDisposition(text, history = [], options = {}) {
  const boundedHistory = Array.isArray(history)
    ? history.filter((message) => message?.role === 'user' || message?.role === 'assistant')
      .slice(-4).map((message) => ({
        role: message.role,
        content: String(message?.content || '').slice(0, 4_000),
      })).filter((message) => message.content.trim())
    : [];
  const response = await fetch('/api/oscar/request-disposition', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    ...(options.signal ? { signal: options.signal } : {}),
    body: JSON.stringify({
      text: String(text || '').trim(),
      ...(boundedHistory.length ? { history: boundedHistory } : {}),
    }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return payload.disposition;
}

export async function uploadOscarAttachment(attachment, options = {}) {
  return oscarTurnRequest('/api/oscar/attachments', {
    method: 'POST',
    body: {
      version: 1,
      conversationId: String(options.conversationId || '').trim(),
      privacyMode: options.privacyMode || 'persistent',
      ...(options.surface === 'voice' ? { surface: 'voice' } : {}),
      name: attachment.name,
      mimeType: attachment.mime_type,
      dataBase64: attachment.data_base64,
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function fetchOscarAttachment(attachmentId, options = {}) {
  const query = new URLSearchParams({
    conversationId: String(options.conversationId || '').trim(),
    privacyMode: options.privacyMode || 'persistent',
    ...(options.surface === 'voice' ? { surface: 'voice' } : {}),
  });
  return oscarTurnRequest(`/api/oscar/attachments/${encodeURIComponent(attachmentId)}?${query}`,
    { ...(options.signal ? { signal: options.signal } : {}) });
}

export function createOscarDataEgressConsent(input, options = {}) {
  return oscarTurnRequest('/api/oscar/data-egress-consents', {
    method: 'POST',
    body: {
      version: 1,
      clientRequestId: options.clientRequestId || createClientScopeId(),
      conversationId: String(input.conversationId || '').trim(),
      privacyMode: input.privacyMode || 'persistent',
      ...(options.surface === 'voice' ? { surface: 'voice' } : {}),
      text: String(input.text || '').trim(),
      attachmentIds: Array.isArray(input.attachmentIds) ? input.attachmentIds : [],
      webSearch: input.webSearch === true,
      researchMode: input.researchMode === 'deep' ? 'deep' : input.researchMode === 'off' ? 'off' : 'auto',
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function decideOscarDataEgressConsent(consentId, decision, canonicalBindingHash, options = {}) {
  return oscarTurnRequest(`/api/oscar/data-egress-consents/${encodeURIComponent(consentId)}/decision`, {
    method: 'POST',
    body: {
      version: 1,
      decision: decision === 'grant' ? 'grant' : 'deny',
      canonicalBindingHash,
      ...(options.surface === 'voice' ? { surface: 'voice' } : {}),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function createOscarTurn(input, options = {}) {
  return oscarTurnRequest('/api/oscar/turns', {
    method: 'POST',
    body: {
      version: 1,
      clientRequestId: options.clientRequestId || createClientScopeId(),
      conversationId: String(input.conversationId || '').trim(),
      text: String(input.text || '').trim(),
      privacyMode: input.privacyMode || 'persistent',
      inputMessageId: options.inputMessageId || createClientScopeId(),
      ...(options.surface === 'voice' ? { surface: 'voice' } : {}),
      ...(Array.isArray(input.attachmentIds) && input.attachmentIds.length ? { attachmentIds: input.attachmentIds } : {}),
      ...(input.modifiers ? { modifiers: input.modifiers } : {}),
      ...(Array.isArray(input.history) && input.history.length ? { history: input.history } : {}),
      ...(input.replyToTurnId ? { replyToTurnId: input.replyToTurnId } : {}),
      ...(input.supersedesTurnId ? { supersedesTurnId: input.supersedesTurnId } : {}),
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function createOscarIncognitoConversation(options = {}) {
  return oscarTurnRequest('/api/oscar/incognito-conversations', {
    method: 'POST',
    body: { version: 1 },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function discardOscarIncognitoConversation(conversationId, options = {}) {
  return oscarTurnRequest(`/api/oscar/incognito-conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    body: { version: 1 },
    ...(options.keepalive === true ? { keepalive: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function fetchOscarTurn(turnId, options = {}) {
  return oscarTurnRequest(`/api/oscar/turns/${encodeURIComponent(turnId)}`, options);
}

export function fetchOscarTurnByClientRequestId(clientRequestId, options = {}) {
  const query = new URLSearchParams({
    clientRequestId: String(clientRequestId || '').trim(),
    privacyMode: options.privacyMode || 'persistent',
    ...(options.surface === 'voice' ? { surface: 'voice' } : {}),
  });
  return oscarTurnRequest(`/api/oscar/turns?${query}`, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function cancelOscarTurnSubmission(clientRequestId, options = {}) {
  return oscarTurnRequest('/api/oscar/turn-cancellations', {
    method: 'POST',
    body: {
      version: 1,
      clientRequestId: String(clientRequestId || '').trim(),
      privacyMode: options.privacyMode || 'persistent',
      ...(options.surface === 'voice' ? { surface: 'voice' } : {}),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function sendOscarTurnMessage(turnId, content, options = {}) {
  return oscarTurnRequest(`/api/oscar/turns/${encodeURIComponent(turnId)}/messages`, {
    method: 'POST',
    body: { version: 1, content, messageId: options.messageId || createClientScopeId() },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function cancelOscarTurn(turnId, options = {}) {
  return oscarTurnRequest(`/api/oscar/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: 'POST',
    body: { version: 1 },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function streamOscarTurn(turnId, after = 0, options = {}) {
  let cursor = Math.max(0, Number(after) || 0);
  return (async function* () {
    let refreshedDesktopSession = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
        const response = await fetch(
          `/api/oscar/turns/${encodeURIComponent(turnId)}/events?after=${encodeURIComponent(cursor)}`,
          {
            headers: await mutationApiHeaders({ Accept: 'text/event-stream' }),
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        if (!response.ok) {
          const payload = await readOptionalJson(response);
          const error = createMonarchHttpError(response.status, payload);
          if (!refreshedDesktopSession && isRecoverableDesktopSessionError(error)) {
            refreshedDesktopSession = await refreshDesktopAttestation();
            if (refreshedDesktopSession) {
              const checkpoint = await fetchOscarTurn(turnId, { signal: options.signal });
              const recovered = terminalOscarTurnEvent(checkpoint, cursor);
              if (recovered) {
                yield recovered;
                return;
              }
              continue;
            }
          }
          throw error;
        }
        if (!response.body) throw new Error('Monarch не открыл поток Oscar Turn.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let terminal = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const drained = drainSseBuffer(buffer, done);
            buffer = drained.buffer;
            for (const event of drained.events) {
              const sequence = Number(event.data?.event?.sequence || 0);
              if (!Number.isSafeInteger(sequence) || sequence <= cursor) continue;
              cursor = sequence;
              terminal ||= event.type === 'turn.outcome' || event.type === 'turn.failed';
              yield event;
            }
            if (done) break;
          }
        } finally {
          try { await reader.cancel(); } catch { /* Stream may already be terminal or disconnected. */ }
          reader.releaseLock();
        }
        if (terminal) return;
      } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError' || error?.name === 'MonarchHttpError') {
          throw error;
        }
        // A local SSE connection can be torn down while the durable Turn keeps
        // running. Resume from the last accepted sequence instead of turning a
        // transient socket/read failure into a terminal UI error.
      }
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 120 * (attempt + 1)));
    }
    const checkpoint = await fetchOscarTurn(turnId, { signal: options.signal });
    const terminal = terminalOscarTurnEvent(checkpoint, cursor);
    if (terminal) {
      yield terminal;
      return;
    }
    throw new Error('Oscar Turn не получил durable terminal outcome после трёх reconnect-попыток.');
  })();
}

async function oscarTurnRequest(url, options = {}) {
  const method = options.method || 'GET';
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: await mutationApiHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(body === undefined ? {} : { body }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.keepalive === true ? { keepalive: true } : {}),
    });
    const payload = await readOptionalJson(response);
    if (response.ok) return payload;
    const error = createMonarchHttpError(response.status, payload);
    if (attempt === 0 && isRecoverableDesktopSessionError(error) && await refreshDesktopAttestation()) {
      continue;
    }
    throw error;
  }
  throw new Error('Monarch Turn request exhausted its bounded Desktop session recovery.');
}

export async function submitIntent(text, confirmed, confirmationToken = '') {
  rejectLegacyConfirmation(confirmed, confirmationToken);
  const response = await fetch('/api/intent', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return payload;
}

export async function fetchCoderOverview() {
  return coderRequest('/api/coder');
}

export async function mutateCoderProject(action, value = {}) {
  return coderRequest('/api/coder/projects', { method: 'POST', body: { action, ...value } });
}

export async function fetchCoderProject(projectId) {
  return coderRequest(`/api/coder/projects/${encodeURIComponent(projectId)}`);
}

export async function startCoderRun(prompt, projectId, model) {
  return coderRequest('/api/coder/runs', { method: 'POST', body: { prompt, projectId, model } });
}

export async function fetchCoderRun(runId) {
  return coderRequest(`/api/coder/runs/${encodeURIComponent(runId)}`);
}

export async function fetchCoderRuns(projectId = '') {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return coderRequest(`/api/coder/runs${query}`);
}

export async function cancelCoderRun(runId) {
  return coderRequest(`/api/coder/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: {} });
}

export async function resumeCoderRun(runId) {
  return coderRequest(`/api/coder/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST', body: {} });
}

export async function deleteCoderRun(runId) {
  return coderRequest(`/api/coder/runs/${encodeURIComponent(runId)}`, { method: 'DELETE', body: {} });
}

export async function submitCoderFastChat(message, history = []) {
  return coderRequest('/api/coder/fast-chat', { method: 'POST', body: { message, history } });
}

async function coderRequest(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: apiHeaders(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw new Error(formatMonarchHttpError(response.status, payload));
  return payload;
}

export async function submitIntentJob(text, confirmed, confirmationToken = '', timeoutMs = 90000, context = {}) {
  rejectLegacyConfirmation(confirmed, confirmationToken);
  const response = await fetch('/api/intent-jobs', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
      timeoutMs,
      context: {
        ...getClientJobContext(),
        ...context,
      },
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return payload;
}

export async function fetchSkillMatches(query, limit = 3) {
  const params = new URLSearchParams({
    query: String(query || ''),
    limit: String(limit),
  });
  const response = await fetch(`/api/skills?${params.toString()}`, {
    headers: apiHeaders(),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return Array.isArray(payload.matches) ? payload.matches : [];
}

export async function fetchSkills(refresh = false) {
  const response = await fetch(`/api/skills${refresh ? '?refresh=true' : ''}`, {
    headers: apiHeaders(),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return Array.isArray(payload.skills) ? payload.skills : [];
}

export async function createSkillDraft(purpose, scope = 'project') {
  const response = await fetch('/api/skills/draft', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ purpose, scope }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload;
}

export async function validateSkillDraft(draft) {
  const response = await fetch('/api/skills/validate', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ draft }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload;
}

export async function publishSkillDraft(draft, expectedDraftHash) {
  const response = await fetch('/api/skills', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ draft, expectedDraftHash }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload;
}

export async function updatePermissionProfile(sandboxMode, approvalPolicy) {
  const response = await fetch('/api/permissions', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sandboxMode, approvalPolicy }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return payload.profile;
}

export async function updateAutonomyMode(autonomyMode) {
  const response = await fetch('/api/permissions', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ autonomyMode }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(formatMonarchHttpError(response.status, payload));
  return payload.profile;
}

export async function submitActionProposal({
  proposal,
  originatingUserText = '',
  requestedBy = 'ui:oscar:model-proposal',
  model = '',
  skillIds = [],
  confirmed = false,
  confirmationToken = '',
  grantScope = 'once',
  leaseId = '',
}) {
  rejectLegacyConfirmation(confirmed, confirmationToken);
  const response = await fetch('/api/agent/proposals', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      proposal,
      originatingUserText,
      requestedBy,
      grantScope,
      ...(model ? { model } : {}),
      ...(skillIds.length ? { skillIds } : {}),
      ...(leaseId ? { leaseId } : {}),
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(formatMonarchHttpError(response.status, payload));
  return payload;
}

export async function fetchCapabilityLeases(activeOnly = false) {
  const response = await fetch(`/api/agent/leases${activeOnly ? '?active=true' : ''}`, { headers: apiHeaders() });
  const payload = await response.json();
  if (!response.ok) throw new Error(formatMonarchHttpError(response.status, payload));
  return Array.isArray(payload.leases) ? payload.leases : [];
}

export async function revokeCapabilityLease(leaseId) {
  const response = await fetch(`/api/agent/leases/${encodeURIComponent(leaseId)}/revoke`, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(formatMonarchHttpError(response.status, payload));
  return payload.lease;
}

export async function fetchActionLedger(limit = 50) {
  const response = await fetch(`/api/agent/ledger?limit=${encodeURIComponent(limit)}`, { headers: apiHeaders() });
  const payload = await response.json();
  if (!response.ok) throw new Error(formatMonarchHttpError(response.status, payload));
  return Array.isArray(payload.actions) ? payload.actions : [];
}

export async function rollbackAction(ledgerId) {
  const response = await fetch(`/api/agent/ledger/${encodeURIComponent(ledgerId)}/rollback`, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.rollback?.reason || formatMonarchHttpError(response.status, payload));
  return payload.rollback;
}

export async function dispatchAgentAction(text, confirmed = false, confirmationToken = '') {
  rejectLegacyConfirmation(confirmed, confirmationToken);
  const response = await fetch('/api/agent/dispatch', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return payload;
}

function getClientJobContext() {
  return {
    clientSessionId: getOrCreateSessionStorageId(CLIENT_SESSION_ID_KEY),
    clientConversationId: getOrCreateConversationIdForCurrentLane(),
  };
}

function getOrCreateConversationIdForCurrentLane() {
  // clientConversationId identifies the current chat/intent lane within this renderer session.
  return getOrCreateSessionStorageId(CLIENT_CONVERSATION_ID_KEY);
}

function getOrCreateSessionStorageId(key) {
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) {
      return existing;
    }
    const id = createClientScopeId();
    window.sessionStorage.setItem(key, id);
    return id;
  } catch {
    return '';
  }
}

function createClientScopeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `scope_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export async function fetchIntentJob(jobId) {
  const response = await fetch(`/api/intent-jobs/${encodeURIComponent(jobId)}`, {
    headers: apiHeaders(),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return payload;
}

export async function streamIntentJob(jobId) {
  const response = await fetch(`/api/intent-jobs/${encodeURIComponent(jobId)}/stream`, {
    headers: apiHeaders(),
  });
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status));
  }
  if (!response.body) {
    throw new Error('Monarch не открыл поток задачи.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  return (async function* () {
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const drained = drainSseBuffer(buffer, done);
      buffer = drained.buffer;
      yield* drained.events;
      if (done) break;
    }
  })();
}

export async function cancelIntentJob(jobId) {
  const response = await fetch(`/api/intent-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return payload;
}

export async function createAgentTask(request, options = {}) {
  const trustedDesktopBridge = typeof window !== 'undefined'
    && typeof window.monarchDesktop?.getMutationAttestation === 'function';
  const requestedSource = options.source === 'voice' && trustedDesktopBridge
    ? 'voice'
    : trustedDesktopBridge ? 'desktop' : 'api';
  return agentTaskRequest('/api/agent/tasks', {
    method: 'POST',
    body: {
      version: 1,
      request: String(request || '').trim(),
      source: requestedSource,
      clientRequestId: options.clientRequestId || createClientScopeId(),
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(Array.isArray(options.expectedOutputs) ? { expectedOutputs: options.expectedOutputs } : {}),
      ...(Array.isArray(options.constraints) ? { constraints: options.constraints } : {}),
      ...(Array.isArray(options.successCriteria) ? { successCriteria: options.successCriteria } : {}),
      ...(options.budgets ? { budgets: options.budgets } : {}),
      autoStart: options.autoStart !== false,
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function fetchAgentTask(taskId) {
  return agentTaskRequest(`/api/agent/tasks/${encodeURIComponent(taskId)}`);
}

export function listAgentTasks(limit = 40) {
  const normalized = Math.max(1, Math.min(Number(limit) || 40, 100));
  return agentTaskRequest(`/api/agent/tasks?limit=${encodeURIComponent(normalized)}`);
}

export function sendAgentTaskMessage(taskId, content) {
  return agentTaskRequest(`/api/agent/tasks/${encodeURIComponent(taskId)}/messages`, {
    method: 'POST',
    body: {
      version: 1,
      content,
      messageId: createClientScopeId(),
    },
  });
}

export function resolveAgentTaskApproval(taskId, approvalId, decision, grantScope = 'once', binding = {}, options = {}) {
  const exactBinding = requireAgentApprovalBinding(binding);
  return agentTaskRequest(
    `/api/agent/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: 'POST',
      body: {
        version: 1,
        decision: decision === 'approve' ? 'approve' : 'deny',
        grantScope: grantScope === 'task' ? 'task' : 'once',
        requestId: createClientScopeId(),
        canonicalProposalHash: exactBinding.canonicalProposalHash,
        capabilityId: exactBinding.capabilityId,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

export function armAgentTaskApproval(taskId, approvalId, binding = {}) {
  const exactBinding = requireAgentApprovalBinding(binding);
  return agentTaskRequest(
    `/api/agent/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: 'POST',
      body: {
        version: 1,
        decision: 'arm',
        grantScope: 'once',
        requestId: createClientScopeId(),
        canonicalProposalHash: exactBinding.canonicalProposalHash,
        capabilityId: exactBinding.capabilityId,
      },
    },
  );
}

function requireAgentApprovalBinding(binding) {
  const canonicalProposalHash = String(binding?.canonicalProposalHash || '').trim();
  const capabilityId = String(binding?.capabilityId || '').trim();
  if (!canonicalProposalHash || !capabilityId) {
    const error = new Error('Approval-card не содержит exact capability/hash binding.');
    error.code = 'approval-binding-missing';
    throw error;
  }
  return { canonicalProposalHash, capabilityId };
}

export function cancelAgentTask(taskId) {
  return agentTaskRequest(`/api/agent/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
    body: { version: 1 },
  });
}

export function pauseAgentTask(taskId) {
  return agentTaskRequest(`/api/agent/tasks/${encodeURIComponent(taskId)}/pause`, {
    method: 'POST',
    body: { version: 1 },
  });
}

export function resumeAgentTask(taskId) {
  return agentTaskRequest(`/api/agent/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: 'POST',
    body: { version: 1 },
  });
}

export function repeatAgentTask(taskId, options = {}) {
  return agentTaskRequest(`/api/agent/tasks/${encodeURIComponent(taskId)}/repeat`, {
    method: 'POST',
    body: {
      version: 1,
      clientRequestId: options.clientRequestId || createClientScopeId(),
      autoStart: options.autoStart !== false,
    },
  });
}

export async function streamAgentTask(taskId, after = 0, options = {}) {
  const response = await fetch(
    `/api/agent/tasks/${encodeURIComponent(taskId)}/events?after=${encodeURIComponent(after)}`,
    {
      headers: apiHeaders({ Accept: 'text/event-stream' }),
      signal: options.signal,
    },
  );
  if (!response.ok) {
    const payload = await readOptionalJson(response);
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  if (!response.body) throw new Error('Monarch не открыл поток Agent Task.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  return (async function* () {
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const drained = drainSseBuffer(buffer, done);
        buffer = drained.buffer;
        yield* drained.events;
        if (done) return;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The task stream may already be closed after a terminal event.
      }
      reader.releaseLock();
    }
  })();
}

async function agentTaskRequest(url, options = {}) {
  const method = options.method || 'GET';
  const response = await fetch(url, {
    method,
    headers: method === 'GET'
      ? apiHeaders(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
      : await mutationApiHeaders(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw createMonarchHttpError(response.status, payload);
  return payload;
}

export async function executeCapability(
  moduleId,
  capabilityId,
  input,
  requestedBy,
  confirmed,
  confirmationToken = '',
  requestOptions = {},
) {
  rejectLegacyConfirmation(confirmed, confirmationToken);
  const response = await fetch('/api/execute', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
    body: JSON.stringify({
      moduleId,
      capabilityId,
      input,
      requestedBy,
      ...(requestOptions.includeState === false ? { includeState: false } : {}),
    }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return payload;
}

export async function emergencyStopComputerUse() {
  const response = await fetch('/api/computer-use/emergency-stop', {
    method: 'POST',
    headers: await mutationApiHeaders(),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) throw new Error(formatMonarchHttpError(response.status, payload));
  return payload;
}

export async function submitAgentActionJob(text, confirmed = false, confirmationToken = '', timeoutMs = 180000, contextOverrides = {}) {
  rejectLegacyConfirmation(confirmed, confirmationToken);
  const response = await fetch('/api/agent/jobs', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
      timeoutMs,
      context: { ...getClientJobContext(), ...contextOverrides },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(formatMonarchHttpError(response.status, payload));
  return payload;
}

export async function transcribeVoiceAudio({ audioBase64, mimeType, language, durationMs, signal }) {
  const payload = await executeCapability('voice', 'voice.transcribe.audio', {
    audioBase64,
    mimeType,
    language,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
  }, 'ui:voice', false, '', { signal, includeState: false });
  const result = payload.result || payload;
  if (!result.ok) {
    const error = new Error(readFailureMessage(result, 'Локальный STT не вернул текст.'));
    error.code = result.error;
    error.result = result;
    throw error;
  }
  const transcript = typeof result.output?.transcript === 'string' ? result.output.transcript.trim() : '';
  if (!transcript) {
    throw new Error('Локальный STT не вернул текст.');
  }
  return transcript;
}

export async function startVoicePcmTranscription({ language, sampleRate, signal }) {
  return executeVoicePcmCapability('voice.transcribe.stream.start', {
    language,
    sampleRate,
  }, signal);
}

export async function pushVoicePcmTranscription({ sessionId, sequence, pcmBase64, signal }) {
  return executeVoicePcmCapability('voice.transcribe.stream.push', {
    sessionId,
    sequence,
    pcmBase64,
  }, signal);
}

export async function finishVoicePcmTranscription({ sessionId, captureStoppedAtEpochMs, signal }) {
  return executeVoicePcmCapability('voice.transcribe.stream.finish', {
    sessionId,
    ...(Number.isFinite(captureStoppedAtEpochMs) ? { captureStoppedAtEpochMs } : {}),
  }, signal);
}

export async function cancelVoicePcmTranscription({ sessionId, signal }) {
  return executeVoicePcmCapability('voice.transcribe.stream.cancel', { sessionId }, signal);
}

async function executeVoicePcmCapability(capabilityId, input, signal) {
  const payload = await executeCapability(
    'voice',
    capabilityId,
    input,
    voiceStreamRequestedBy(),
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  const result = payload?.result || payload || {};
  if (!result.ok) {
    const error = new Error(readFailureMessage(result, 'Streaming STT недоступен.'));
    error.code = result.error;
    error.result = result;
    throw error;
  }
  return result.output || {};
}

function voiceStreamRequestedBy() {
  const clientId = getOrCreateSessionStorageId(VOICE_STREAM_CLIENT_ID_KEY);
  const safeId = String(clientId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  return safeId ? `ui:voice:${safeId}` : 'ui:voice';
}

export async function prepareVoiceTranscription(signal) {
  const payload = await executeCapability(
    'voice',
    'voice.transcribe.prepare',
    {},
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  return normalizeVoiceModeCapabilityResult(payload, { requireText: false });
}

export async function executeVoiceModeDeviceAction(text, signal) {
  return executeVoiceAgentTask(text, signal);
}

export async function executeVoiceModeAction(_candidate, text, signal) {
  return executeVoiceAgentTask(text, signal);
}

/**
 * Single conversational and operational entrypoint for Voice. STT/TTS stay
 * Voice-owned transports; every ordinary transcript is owned by the common
 * TurnCoordinator and Agent Runtime.
 */
export async function executeVoiceAgentTask(text, signal) {
  const request = String(text || '').trim();
  if (!request) {
    return { ok: false, text: '', error: 'voice-text-empty', message: 'Голосовой запрос пуст.' };
  }
  let turnId = '';
  try {
    const voiceSessionId = getOrCreateSessionStorageId(VOICE_STREAM_CLIENT_ID_KEY) || createClientScopeId();
    const created = await createOscarTurn({
      conversationId: `voice:${voiceSessionId}`,
      text: request,
      privacyMode: 'persistent',
      modifiers: { reasoningEffort: 'low', webSearch: false, researchMode: 'off' },
    }, {
      surface: 'voice',
      signal,
    });
    turnId = String(created?.turn?.id || '');
    if (!turnId) throw new Error('Voice TurnCoordinator не вернул turn id.');
    const immediate = voiceTurnResult(created);
    if (immediate) return immediate;
    for await (const event of await streamOscarTurn(turnId, 0, { signal })) {
      const payload = event?.data?.event?.payload || {};
      if (event.type === 'approval.required') {
        return {
          ok: false,
          text: '',
          error: 'voice-approval-required',
          message: 'Точное действие ждёт action-card в Desktop Oscar. Голосом разрешить его нельзя.',
          output: {
            turnId,
            taskId: String(payload.taskId || ''),
            approvalId: String(payload.approvalId || ''),
            status: 'waiting-for-approval',
            performed: false,
          },
        };
      }
      if (event.type === 'user.input.required') {
        const question = String(payload.question || '').trim();
        return {
          ok: true,
          text: question || 'Нужно уточнение, чтобы продолжить.',
          error: '',
          message: question || 'Нужно уточнение, чтобы продолжить.',
          output: { turnId, taskId: String(payload.taskId || ''), status: 'waiting-for-user', performed: false },
        };
      }
      if (event.type === 'turn.outcome' || event.type === 'turn.failed') {
        const terminal = await fetchOscarTurn(turnId, { signal });
        return voiceTurnResult(terminal) || {
          ok: false,
          text: '',
          error: 'voice-turn-terminal-invalid',
          message: 'Voice Turn завершился без проверяемого outcome.',
          output: { turnId, performed: false },
        };
      }
    }
    const terminal = await fetchOscarTurn(turnId, { signal });
    return voiceTurnResult(terminal) || {
      ok: false,
      text: '',
      error: 'voice-turn-incomplete',
      message: 'TurnCoordinator не вернул проверенный результат.',
      output: { turnId, status: String(terminal?.turn?.status || 'incomplete'), performed: false },
    };
  } catch (error) {
    if (signal?.aborted && turnId) {
      await cancelOscarTurn(turnId).catch(() => undefined);
    }
    throw error;
  }
}

function voiceTurnResult(checkpoint) {
  const turn = checkpoint?.turn;
  if (!turn) return null;
  const outcome = String(turn.outcome?.kind || '');
  const summary = String(turn.outcome?.summary || '').trim();
  const baseOutput = {
    turnId: String(turn.id || ''),
    taskId: String(turn.taskId || ''),
    status: String(turn.status || ''),
  };
  if (turn.status === 'waiting-for-approval') {
    return {
      ok: false,
      text: '',
      error: 'voice-approval-required',
      message: 'Точное действие ждёт action-card в Desktop Oscar. Голосом разрешить его нельзя.',
      output: { ...baseOutput, approvalId: String(turn.activeApprovalId || ''), performed: false },
    };
  }
  if (turn.status === 'waiting-for-user') {
    return {
      ok: true,
      text: summary || 'Нужно уточнение, чтобы продолжить.',
      error: '',
      message: summary || 'Нужно уточнение, чтобы продолжить.',
      output: { ...baseOutput, performed: false },
    };
  }
  if (outcome === 'verified') {
    return { ok: true, text: summary, error: '', message: summary, output: { ...baseOutput, verified: true } };
  }
  if (outcome === 'partial') {
    return { ok: true, text: summary, error: '', message: summary, output: { ...baseOutput, verified: false, partial: true } };
  }
  if (outcome === 'answered:source-grounded') {
    return {
      ok: true,
      text: summary,
      error: '',
      message: summary,
      output: { ...baseOutput, grounded: true, verified: false, performed: false, outcome },
    };
  }
  if (outcome === 'answered') {
    return {
      ok: true,
      text: summary,
      error: '',
      message: summary,
      // Agent Runtime emits this only for models.agent.respond after the
      // integrity gate excludes current-state and completion claims.
      output: { ...baseOutput, boundedAnswer: true, verified: false, performed: false, outcome },
    };
  }
  if (['blocked', 'failed', 'cancelled'].includes(outcome) || ['blocked', 'failed', 'cancelled'].includes(turn.status)) {
    return {
      ok: false,
      text: '',
      error: `voice-turn-${outcome || turn.status}`,
      message: summary || 'Проверенный результат не получен.',
      output: { ...baseOutput, performed: false, outcome: outcome || turn.status },
    };
  }
  return null;
}

export async function executeConfirmedCapability(moduleId, capabilityId, input, requestedBy) {
  const prepared = await executeCapability(moduleId, capabilityId, input, requestedBy, false);
  if (prepared.ok || prepared.result?.ok) {
    return prepared.result || prepared;
  }

  const err = prepared.result?.error || prepared.error;
  const summary = readFailureMessage(prepared.result || prepared, prepared.result?.summary || prepared.summary);

  if (err !== 'confirmation-required') {
    throwCapabilityExecutionError(summary || err || 'Команда не выполнена.', prepared.result || prepared, prepared);
  }

  throwCapabilityExecutionError(
    summary || 'Действие ждёт точную Agent action-card; текстовое подтверждение отключено.',
    prepared.result || prepared,
    prepared,
  );
}

function throwCapabilityExecutionError(message, result, payload) {
  const error = new Error(message);
  error.result = result;
  error.payload = payload;
  throw error;
}

export async function executeCapabilityStream(moduleId, capabilityId, input, requestedBy, confirmed, confirmationToken = '') {
  rejectLegacyConfirmation(confirmed, confirmationToken);
  const response = await fetch('/api/execute-stream', {
    method: 'POST',
    headers: await mutationApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      moduleId,
      capabilityId,
      input,
      requestedBy,
    }),
  });

  if (!response.ok) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(formatMonarchHttpError(response.status));
    }
    throw new Error(formatMonarchHttpError(response.status, payload));
  }

  if (!response.body) {
    throw createRuntimeDisconnectedError();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  return (async function* () {
    let buffer = '';
    let receivedTerminalEvent = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const drained = drainSseBuffer(buffer, done);
        buffer = drained.buffer;

        for (const event of drained.events) {
          if (event.type === 'done' || event.type === 'error') {
            receivedTerminalEvent = true;
          }
          yield event;
          if (receivedTerminalEvent) {
            try {
              await reader.cancel();
            } catch {
              // The backend may have already closed or recycled after its terminal event.
            }
            return;
          }
        }

        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }

    if (!receivedTerminalEvent) {
      throw createRuntimeDisconnectedError();
    }
  })();
}

export function drainSseBuffer(buffer, flush = false) {
  const normalized = String(buffer || '').replace(/\r\n/g, '\n');
  const chunks = normalized.split('\n\n');
  const remainder = flush ? '' : chunks.pop() || '';
  const events = [];

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    let eventType = 'message';
    const dataLines = [];
    const lines = trimmed.split('\n');
    for (const line of lines) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }

    try {
      const dataStr = dataLines.join('\n');
      events.push({
        type: eventType,
        data: dataStr ? JSON.parse(dataStr) : {},
      });
    } catch {
      // Ignore malformed SSE payloads from a broken stream chunk.
    }
  }

  return { events, buffer: remainder };
}

function createRuntimeDisconnectedError() {
  const error = new Error('Oscar потерял соединение с runtime до завершения ответа. Уже полученная часть будет сохранена.');
  error.code = 'runtime-disconnected';
  return error;
}

function createMonarchHttpError(status, payload = {}) {
  const error = new Error(formatMonarchHttpError(status, payload));
  error.name = 'MonarchHttpError';
  error.status = Number(status) || 0;
  error.code = typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : `http-${error.status}`;
  return error;
}

function isRecoverableDesktopSessionError(error) {
  return error?.status === 401
    || (error?.status === 403 && [
      'invalid-desktop-attestation',
      'turn-source-mismatch',
      'untrusted-oscar-source',
    ].includes(error?.code));
}

function terminalOscarTurnEvent(checkpoint, cursor) {
  const status = checkpoint?.turn?.status;
  if (!['succeeded', 'blocked', 'failed', 'cancelled'].includes(status)) return null;
  const type = status === 'failed' ? 'turn.failed' : 'turn.outcome';
  return {
    type,
    data: {
      version: 1,
      turnId: checkpoint.turn.id,
      event: {
        sequence: cursor,
        type,
        payload: {
          outcome: checkpoint.turn.outcome?.kind || status,
          summary: checkpoint.turn.outcome?.summary || '',
          replayedFromCheckpoint: true,
        },
      },
    },
  };
}

export function formatMonarchHttpError(status, payload = {}) {
  if (status >= 500) {
    return 'Monarch столкнулся с внутренней ошибкой. Детали остались в локальных логах.';
  }

  const message = typeof payload?.message === 'string' && payload.message.trim()
    ? payload.message.trim()
    : typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : '';
  if (message) return message;
  if (status === 401) return 'Нет доступа к Monarch API. Обнови страницу или перезапусти локальный UI.';
  if (status === 403) return 'Monarch API отклонил запрос (403).';
  if (status === 404) return 'Monarch API не нашел нужный endpoint. Похоже, UI и runtime разных версий.';
  if (status === 429) return 'Monarch сейчас занят. Попробуй еще раз через несколько секунд.';
  return `Monarch API вернул ошибку ${status}.`;
}

function readFailureMessage(result, fallback = '') {
  const message = result?.userFacing?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}

function normalizeVoiceModeCapabilityResult(payload, { requireText = true } = {}) {
  const result = payload?.result || payload || {};
  const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
  if (result.ok !== true) {
    return {
      ok: false,
      text: '',
      error: typeof result.error === 'string' && result.error.trim()
        ? result.error.trim()
        : 'voice-mode-capability-failed',
      message: readFailureMessage(result, summary || 'Голосовой запрос не выполнен.'),
      output: result.output,
      result,
    };
  }

  const text = requireText ? readVoiceModeResultText(result) : '';
  if (requireText && !text) {
    return {
      ok: false,
      text: '',
      error: 'voice-mode-response-empty',
      message: 'Голосовой runtime вернул пустой ответ.',
      output: result.output,
      result,
    };
  }

  return {
    ok: true,
    text,
    error: '',
    message: summary,
    output: result.output,
    result,
  };
}

function readVoiceModeResultText(result) {
  const output = result?.output;
  const response = output && typeof output === 'object' ? output.response : undefined;
  const nestedResult = output && typeof output === 'object' ? output.result : undefined;
  const candidates = [
    typeof output === 'string' ? output : '',
    output?.text,
    output?.answer,
    output?.reply,
    output?.content,
    response?.text,
    response?.answer,
    response?.reply,
    response?.content,
    response?.message,
    nestedResult?.text,
    nestedResult?.answer,
    result?.text,
    result?.answer,
    result?.reply,
    result?.summary,
  ];
  const text = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return typeof text === 'string' ? text.trim() : '';
}

async function readOptionalJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function executeConfirmedCapabilityStream(moduleId, capabilityId, input, requestedBy) {
  const prepared = await executeCapability(moduleId, capabilityId, input, requestedBy, false);
  if (prepared.ok || prepared.result?.ok) {
    // The active profile allowed the request without confirmation. Open the
    // real stream instead of returning the non-stream preparation result.
    return executeCapabilityStream(moduleId, capabilityId, input, requestedBy, false);
  }

  const error = prepared.result?.error || prepared.error;
  const summary = readFailureMessage(
    prepared.result || prepared,
    prepared.result?.summary || prepared.summary,
  );
  if (error !== 'confirmation-required') {
    throw new Error(summary || error || 'Поток не разрешён Monarch Access.');
  }
  throw new Error(summary || 'Поток ждёт точную Agent action-card; текстовый confirmation token отключён.');
}
