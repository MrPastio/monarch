const API_TOKEN = typeof document === 'undefined'
  ? ''
  : document.querySelector('meta[name="monarch-api-token"]')?.getAttribute('content') || '';

const CLIENT_SESSION_ID_KEY = 'monarch.clientSessionId';
const CLIENT_CONVERSATION_ID_KEY = 'monarch.clientConversationId.default';
const VOICE_STREAM_CLIENT_ID_KEY = 'monarch.voiceStreamClientId';

export function apiHeaders(customHeaders = {}) {
  const headers = { ...customHeaders };
  if (API_TOKEN) {
    headers['Authorization'] = `Bearer ${API_TOKEN}`;
    headers['X-Monarch-Session'] = API_TOKEN;
  }
  return headers;
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

export async function submitIntent(text, confirmed, confirmationToken = '') {
  const response = await fetch('/api/intent', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
      confirmed,
      ...(confirmationToken ? { confirmationToken } : {}),
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
  const response = await fetch('/api/intent-jobs', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
      confirmed,
      timeoutMs,
      context: {
        ...getClientJobContext(),
        ...context,
      },
      ...(confirmationToken ? { confirmationToken } : {}),
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

export async function updatePermissionProfile(sandboxMode, approvalPolicy) {
  const response = await fetch('/api/permissions', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
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
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
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
  const response = await fetch('/api/agent/proposals', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      proposal,
      originatingUserText,
      requestedBy,
      confirmed,
      grantScope,
      ...(model ? { model } : {}),
      ...(skillIds.length ? { skillIds } : {}),
      ...(confirmationToken ? { confirmationToken } : {}),
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
  const response = await fetch('/api/agent/dispatch', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
      confirmed,
      ...(confirmationToken ? { confirmationToken } : {}),
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

export async function executeCapability(
  moduleId,
  capabilityId,
  input,
  requestedBy,
  confirmed,
  confirmationToken = '',
  requestOptions = {},
) {
  const response = await fetch('/api/execute', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
    body: JSON.stringify({
      moduleId,
      capabilityId,
      input,
      requestedBy,
      confirmed,
      ...(confirmationToken ? { confirmationToken } : {}),
      ...(requestOptions.includeState === false ? { includeState: false } : {}),
    }),
  });
  const payload = await readOptionalJson(response);
  if (!response.ok) {
    throw new Error(formatMonarchHttpError(response.status, payload));
  }
  return payload;
}

export async function submitAgentActionJob(text, confirmed = false, confirmationToken = '', timeoutMs = 180000, contextOverrides = {}) {
  const response = await fetch('/api/agent/jobs', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
      confirmed,
      timeoutMs,
      context: { ...getClientJobContext(), ...contextOverrides },
      ...(confirmationToken ? { confirmationToken } : {}),
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

export async function prepareVoiceModeModels(signal) {
  const payload = await executeCapability(
    'voice',
    'voice.mode.prepare',
    {},
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  return normalizeVoiceModeCapabilityResult(payload, { requireText: false });
}

export async function startVoiceModeSession(signal) {
  const payload = await executeCapability(
    'voice',
    'voice.mode.session.start',
    {},
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  const result = normalizeVoiceModeCapabilityResult(payload, { requireText: false });
  const sessionId = String(result.output?.sessionId || '').trim();
  if (!result.ok || !sessionId) {
    const error = new Error(result.message || 'Voice session не запустилась.');
    error.code = result.error || 'voice-session-start-failed';
    throw error;
  }
  return sessionId;
}

export async function completeVoiceModeTurn({ sessionId, turnId, response, actionId, signal } = {}) {
  if (!sessionId || !turnId || !String(response || '').trim()) return null;
  const payload = await executeCapability(
    'voice',
    'voice.mode.session.complete',
    {
      sessionId: String(sessionId),
      turnId: String(turnId),
      response: String(response).trim(),
      ...(String(actionId || '').trim() ? { actionId: String(actionId).trim() } : {}),
    },
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  return normalizeVoiceModeCapabilityResult(payload, { requireText: false });
}

export async function closeVoiceModeSession(sessionId, signal) {
  if (!String(sessionId || '').trim()) return null;
  const payload = await executeCapability(
    'voice',
    'voice.mode.session.close',
    { sessionId: String(sessionId).trim() },
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  return normalizeVoiceModeCapabilityResult(payload, { requireText: false });
}

export async function releaseVoiceModeModels(signal) {
  const payload = await executeCapability(
    'voice',
    'voice.mode.release',
    { profiles: ['lite'] },
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  return normalizeVoiceModeCapabilityResult(payload, { requireText: false });
}

export async function executeVoiceModeScripted(text, signal) {
  const payload = await executeCapability(
    'voice',
    'voice.mode.execute-scripted',
    { text: String(text || '').trim() },
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  return normalizeVoiceModeCapabilityResult(payload);
}

export async function executeVoiceModeDeviceAction(text, signal) {
  const input = { text: String(text || '').trim() };
  let payload = await executeCapability(
    'voice',
    'voice.mode.execute-scripted',
    input,
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  const result = payload?.result || payload || {};
  if (result.error === 'confirmation-required') {
    const token = result.metadata?.confirmation?.token;
    if (typeof token === 'string' && token) {
      // A spoken device command is explicit user intent. The retry remains
      // bound to the exact capability and input by Monarch's one-time token.
      payload = await executeCapability(
        'voice',
        'voice.mode.execute-scripted',
        input,
        'ui:voice-mode',
        true,
        token,
        { ...(signal ? { signal } : {}), includeState: false },
      );
    }
  }
  const normalized = normalizeVoiceModeCapabilityResult(payload);
  if (normalized.ok
    && normalized.output?.actionId === 'device.volume'
    && normalized.output?.verified !== true) {
    return {
      ...normalized,
      ok: false,
      text: '',
      error: 'voice-volume-unverified',
      message: 'Windows не подтвердил новый уровень громкости.',
    };
  }
  return normalized;
}

export async function executeVoiceModeAction(candidate, text, signal) {
  const actionId = String(candidate?.actionId || '').trim();
  const slots = candidate?.slots && typeof candidate.slots === 'object' ? candidate.slots : {};
  if (actionId === 'time.query') {
    return executeVoiceConfirmedCapability('device', 'device.system.time.get', { kind: 'time' }, signal);
  }

  if (actionId === 'device.volume.status') {
    return executeVoiceConfirmedCapability('device', 'device.volume.get', {}, signal);
  }

  if (actionId === 'device.volume') {
    const action = String(slots.operation || '').trim();
    const value = Number(slots.value);
    const delta = Number(slots.delta);
    if (action === 'set' && Number.isFinite(value) && value >= 0 && value <= 100) {
      return executeVoiceConfirmedCapability('device', 'device.volume.set', { action, value: Math.round(value) }, signal);
    }
    if (action === 'change' && Number.isFinite(delta) && delta !== 0 && Math.abs(delta) <= 100) {
      return executeVoiceConfirmedCapability('device', 'device.volume.set', { action, delta: Math.round(delta) }, signal);
    }
    if (action === 'mute' || action === 'unmute') {
      return executeVoiceConfirmedCapability('device', 'device.volume.set', { action }, signal);
    }
    return voiceActionClarification('Как изменить громкость?');
  }

  if (actionId === 'device.brightness.status') {
    return executeVoiceConfirmedCapability('device', 'device.brightness.get', {}, signal);
  }

  if (actionId === 'device.brightness') {
    const operation = String(slots.operation || '').trim();
    const value = Number(slots.value);
    const delta = Number(slots.delta);
    if (operation === 'set' && Number.isFinite(value) && value >= 0 && value <= 100) {
      return executeVoiceConfirmedCapability('device', 'device.brightness.set', {
        operation,
        value: Math.round(value),
      }, signal);
    }
    if (operation === 'change' && Number.isFinite(delta) && delta !== 0 && Math.abs(delta) <= 100) {
      return executeVoiceConfirmedCapability('device', 'device.brightness.set', {
        operation,
        delta: Math.round(delta),
      }, signal);
    }
    return voiceActionClarification('Какую яркость установить?');
  }

  if (actionId === 'device.app.open') {
    const app = String(slots.app || '').trim();
    if (!app) return voiceActionClarification('Какое приложение открыть?');
    return executeVoiceConfirmedCapability('device', 'device.app.open', { app }, signal);
  }

  if (actionId === 'device.browser.open') {
    return executeVoiceConfirmedCapability('device', 'device.browser.open', {
      ...(String(slots.url || '').trim() ? { url: String(slots.url).trim() } : {}),
      ...(String(slots.query || '').trim() ? { query: String(slots.query).trim() } : {}),
      browser: ['chrome', 'edge', 'firefox'].includes(String(slots.browser)) ? String(slots.browser) : 'default',
      provider: 'google',
    }, signal);
  }

  if (actionId === 'device.media.open') {
    return executeVoiceConfirmedCapability('device', 'device.browser.open', {
      ...(String(slots.query || '').trim() ? { query: String(slots.query).trim() } : {}),
      browser: 'default',
      provider: slots.provider === 'youtube' ? 'youtube' : 'google',
    }, signal);
  }

  if (actionId === 'workspace.create') {
    const path = String(slots.path || '').trim();
    if (!path) return voiceActionClarification('Как назвать файл или папку?');
    const directory = slots.kind === 'directory';
    const result = await executeVoiceConfirmedCapability(
      'workspace',
      directory ? 'workspace.files.mkdir' : 'workspace.files.write',
      directory
        ? { path, ensureUnique: false }
        : { path, content: String(slots.content || ''), overwrite: false },
      signal,
    );
    return result.ok
      ? { ...result, text: directory ? `Создал папку ${path}.` : `Создал файл ${path}.` }
      : result;
  }

  if (actionId === 'workspace.delete') {
    const path = String(slots.path || '').trim();
    if (!path) return voiceActionClarification('Какой файл удалить?');
    const result = await executeVoiceConfirmedCapability(
      'workspace',
      'workspace.files.delete',
      { path },
      signal,
    );
    return result.ok ? { ...result, text: `Удалил файл ${path}.` } : result;
  }

  return executeVoiceModeScripted(String(text || '').trim(), signal);
}

async function executeVoiceConfirmedCapability(moduleId, capabilityId, input, signal) {
  let payload = await executeCapability(
    moduleId,
    capabilityId,
    input,
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  let result = payload?.result || payload || {};
  if (result.error === 'confirmation-required') {
    const token = result.metadata?.confirmation?.token;
    if (typeof token === 'string' && token) {
      payload = await executeCapability(
        moduleId,
        capabilityId,
        input,
        'ui:voice-mode',
        true,
        token,
        { ...(signal ? { signal } : {}), includeState: false },
      );
      result = payload?.result || payload || {};
    }
  }
  return normalizeVoiceModeCapabilityResult(payload);
}

function voiceActionClarification(message) {
  return { ok: true, text: message, error: '', message, output: { status: 'clarification', performed: false } };
}

export async function respondVoiceMode(text, profile, signal) {
  if (profile !== 'micro' && profile !== 'lite') {
    throw new TypeError(`Unsupported voice mode profile: ${String(profile || 'empty')}`);
  }
  const payload = await executeCapability(
    'voice',
    'voice.mode.respond',
    { text: String(text || '').trim(), profile },
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  return normalizeVoiceModeCapabilityResult(payload);
}

export async function respondVoiceModeFast(text, language = 'ru', signal, history = []) {
  const payload = await executeCapability(
    'oscar',
    'oscar.voice.fast',
    {
      text: String(text || '').trim(),
      language: String(language || 'ru').trim() || 'ru',
      ...(Array.isArray(history) && history.length ? { history } : {}),
    },
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  return normalizeVoiceModeCapabilityResult(payload);
}

export async function respondVoiceModeRealtime(text, kind, language = 'ru', signal, location, history = []) {
  if (kind !== 'weather' && kind !== 'web-search') {
    throw new TypeError(`Unsupported realtime voice kind: ${String(kind || 'empty')}`);
  }
  const input = {
    text: String(text || '').trim(),
    kind,
    language: String(language || 'ru').trim() || 'ru',
    ...(kind === 'weather' && String(location || '').trim()
      ? { location: String(location).replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim() }
      : {}),
    ...(Array.isArray(history) && history.length ? { history } : {}),
  };
  let payload = await executeCapability(
    'oscar',
    'oscar.voice.realtime',
    input,
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  const result = payload?.result || payload || {};
  if (result.error === 'confirmation-required') {
    const token = result.metadata?.confirmation?.token;
    if (typeof token === 'string' && token) {
      // The classified utterance is the user's explicit, token-bound consent for
      // this exact read-only network lookup. Kernel still validates the token and
      // approval policy; no other voice or network capability is auto-confirmed.
      payload = await executeCapability(
        'oscar',
        'oscar.voice.realtime',
        input,
        'ui:voice-mode',
        true,
        token,
        { ...(signal ? { signal } : {}), includeState: false },
      );
    }
  }
  return normalizeVoiceModeCapabilityResult(payload);
}

export async function classifyVoiceModeText(text, signal, sessionId = '') {
  const payload = await executeCapability(
    'voice',
    'voice.mode.classify',
    {
      text: String(text || '').trim(),
      ...(String(sessionId || '').trim() ? { sessionId: String(sessionId).trim() } : {}),
    },
    'ui:voice-mode',
    false,
    '',
    { ...(signal ? { signal } : {}), includeState: false },
  );
  const result = payload.result || payload;
  if (!result.ok || !result.output) {
    const error = new Error(readFailureMessage(result, 'Voice router не смог разобрать команду.'));
    error.code = result.error;
    error.result = result;
    throw error;
  }
  return result.output;
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

  const confirmationToken = prepared.result?.metadata?.confirmation?.token || prepared.metadata?.confirmation?.token;
  if (!confirmationToken) {
    throw new Error('Monarch не вернул confirmation token.');
  }

  const confirmed = await executeCapability(moduleId, capabilityId, input, requestedBy, true, confirmationToken);
  if (!confirmed.ok && !confirmed.result?.ok) {
    const confirmErr = readFailureMessage(
      confirmed.result || confirmed,
      confirmed.result?.summary || confirmed.result?.error || confirmed.summary || confirmed.error,
    );
    throwCapabilityExecutionError(confirmErr || 'Команда не выполнена после подтверждения.', confirmed.result || confirmed, confirmed);
  }
  return confirmed.result || confirmed;
}

function throwCapabilityExecutionError(message, result, payload) {
  const error = new Error(message);
  error.result = result;
  error.payload = payload;
  throw error;
}

export async function executeCapabilityStream(moduleId, capabilityId, input, requestedBy, confirmed, confirmationToken = '') {
  const response = await fetch('/api/execute-stream', {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      moduleId,
      capabilityId,
      input,
      requestedBy,
      confirmed,
      ...(confirmationToken ? { confirmationToken } : {}),
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

export function formatMonarchHttpError(status, payload = {}) {
  if (status === 401) {
    return 'Нет доступа к Monarch API. Обнови страницу или перезапусти локальный UI.';
  }
  if (status === 403) {
    return 'Monarch заблокировал этот запрос из-за защиты локального API.';
  }
  if (status === 404) {
    return 'Monarch API не нашел нужный endpoint. Похоже, UI и runtime разных версий.';
  }
  if (status === 429) {
    return 'Monarch сейчас занят. Попробуй еще раз через несколько секунд.';
  }
  if (status >= 500) {
    return 'Monarch столкнулся с внутренней ошибкой. Детали остались в локальных логах.';
  }

  const message = typeof payload?.message === 'string' && payload.message.trim()
    ? payload.message.trim()
    : typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : '';
  return message || `Monarch API вернул ошибку ${status}.`;
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
  const token = prepared.result?.metadata?.confirmation?.token || prepared.metadata?.confirmation?.token;
  if (!token) {
    throw new Error('Monarch не вернул confirmation token для потока.');
  }
  return executeCapabilityStream(moduleId, capabilityId, input, requestedBy, true, token);
}
