const CLARIFICATION_TTL_MS = 30_000;
const CANCEL_PATTERN = /^(?:отмена|отмени|не надо|не нужно|забудь|стоп)$/iu;

export function createVoiceModeClarification(candidate, now = Date.now()) {
  if (candidate?.lane !== 'scripted') return null;
  if (candidate.actionId === 'weather.query' && !candidate?.slots?.location) {
    return { kind: 'weather-location', expiresAt: now + CLARIFICATION_TTL_MS };
  }
  if (candidate.actionId === 'web.search' && !candidate?.slots?.query) {
    return { kind: 'web-query', expiresAt: now + CLARIFICATION_TTL_MS };
  }
  if (candidate.actionId === 'device.volume.clarification') {
    return { kind: 'volume-level', expiresAt: now + CLARIFICATION_TTL_MS };
  }
  return null;
}

export function resolveVoiceModeClarification(pending, candidate, rawText, now = Date.now()) {
  if (!pending || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= now) {
    return { candidate, pending: null, consumed: false };
  }

  const normalizedText = String(candidate?.normalizedText || rawText || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (CANCEL_PATTERN.test(normalizedText)) {
    return {
      candidate: {
        ...candidate,
        actionId: 'listen.continue',
        lane: 'scripted',
        modelRoute: 'none',
        maxNewTokens: 0,
        requiresConfirmation: false,
        usesLlm: false,
        requiresRealtime: false,
        slots: { acknowledgement: 'Хорошо.' },
        reason: 'The user cancelled the pending voice clarification.',
      },
      pending: null,
      consumed: true,
    };
  }

  // A bare wake word is an acknowledgement, not the clarification value.
  if (candidate?.actionId === 'listen.continue') {
    return { candidate, pending, consumed: false };
  }

  // A recognized deterministic command supersedes the old clarification.
  if (candidate?.actionId !== 'assistant.fallback') {
    return { candidate, pending: null, consumed: false };
  }

  if (pending.kind === 'weather-location' && isPlausibleWeatherLocation(normalizedText)) {
    return {
      candidate: {
        ...candidate,
        actionId: 'weather.query',
        lane: 'voice-realtime',
        modelRoute: 'none',
        maxNewTokens: 0,
        requiresConfirmation: false,
        usesLlm: false,
        requiresRealtime: true,
        slots: { location: normalizedText },
        reason: 'Completes the bounded pending weather-location clarification without a model.',
      },
      pending: null,
      consumed: true,
    };
  }

  if (pending.kind === 'web-query' && normalizedText.length > 0 && normalizedText.length <= 240) {
    return {
      candidate: {
        ...candidate,
        actionId: 'web.search',
        lane: 'voice-realtime',
        modelRoute: 'gemma4-fast',
        maxNewTokens: 128,
        requiresConfirmation: false,
        usesLlm: true,
        requiresRealtime: true,
        slots: { query: normalizedText },
        reason: 'Completes the bounded pending realtime web-query clarification.',
      },
      pending: null,
      consumed: true,
    };
  }

  if (pending.kind === 'volume-level') {
    const level = readBoundedVolumeLevel(normalizedText);
    if (level !== null) {
      const canonicalCommand = `установи громкость на ${level} процентов`;
      return {
        candidate: {
          ...candidate,
          actionId: 'device.volume',
          normalizedText: canonicalCommand,
          lane: 'scripted',
          modelRoute: 'none',
          maxNewTokens: 0,
          risk: 'write',
          requiresConfirmation: true,
          usesLlm: false,
          requiresRealtime: false,
          slots: {
            domain: 'volume',
            operation: 'set',
            value: String(level),
            canonicalCommand,
            clarificationResolved: 'true',
          },
          reason: 'Completes a bounded pending volume level; Kernel still reclassifies and confirms the canonical command.',
        },
        pending: null,
        consumed: true,
      };
    }
    const canonicalCommand = 'установи громкость';
    return {
      candidate: {
        ...candidate,
        actionId: 'device.volume.clarification',
        normalizedText: canonicalCommand,
        lane: 'scripted',
        modelRoute: 'none',
        maxNewTokens: 0,
        risk: 'read',
        requiresConfirmation: false,
        usesLlm: false,
        requiresRealtime: false,
        slots: {
          domain: 'volume',
          intent: 'clarification',
          canonicalCommand,
          clarificationRetry: 'true',
        },
        reason: 'Invalid bounded volume follow-up stays in model-free clarification.',
      },
      pending,
      consumed: true,
    };
  }

  return { candidate, pending: null, consumed: false };
}

function readBoundedVolumeLevel(value) {
  const text = String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^на\s+/u, '')
    .replace(/\s+процент\p{L}*$/u, '')
    .trim();
  if (/^(?:100|[1-9]?\d)$/u.test(text)) return Number(text);

  const values = {
    ноль: 0, один: 1, одна: 1, два: 2, три: 3, четыре: 4, пять: 5,
    шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
    одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14,
    пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18,
    девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40,
    пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80,
    девяносто: 90, сто: 100,
  };
  const tokens = text.split(' ');
  if (tokens.length < 1 || tokens.length > 2) return null;
  const first = values[tokens[0]];
  if (!Number.isFinite(first)) return null;
  if (tokens.length === 1) return first;
  const second = values[tokens[1]];
  if (!(first >= 20 && first < 100 && first % 10 === 0 && second > 0 && second < 10)) return null;
  return first + second;
}

function isPlausibleWeatherLocation(value) {
  return value.length > 0
    && value.length <= 120
    && /^[\p{L}\p{N} .,'’\-]+$/u.test(value)
    && /\p{L}/u.test(value)
    && value.split(/\s+/).length <= 8;
}
