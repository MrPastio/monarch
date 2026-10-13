export const ASTRA_RUNTIME_PILOT_MODE = 'runtime-same-owner-v1';
export const ASTRA_RUNTIME_PILOT_SWITCH = '--astra-v3-same-owner-pilot';
export const ASTRA_TELEGRAM_PILOT_MODE = 'paired-workspace-read-v1';
export const ASTRA_TELEGRAM_PILOT_SWITCH = '--astra-v3-telegram-read-pilot';

/** Local desktop tasks are available in source and installed builds. Isolated
 * diagnostic modes remain excluded; environment cannot grant host authority. */
export function resolveAstraRuntimePilotMode({ argv, isPackaged, isolatedMode = false }) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw Error('astra-pilot-policy:argv');
  return !isolatedMode && !argv.includes('--disable-astra-v3') ? ASTRA_RUNTIME_PILOT_MODE : null;
}

/** Telegram remote reads require their own exact source switch in addition to
 * the same-owner runtime pilot. This prevents a generic pilot launch from
 * silently admitting remote work. */
export function resolveAstraTelegramPilotMode({ argv, isPackaged, isolatedMode = false, runtimeMode }) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw Error('astra-pilot-policy:argv');
  return runtimeMode === ASTRA_RUNTIME_PILOT_MODE && !isPackaged && !isolatedMode
    && argv.includes(ASTRA_TELEGRAM_PILOT_SWITCH) ? ASTRA_TELEGRAM_PILOT_MODE : null;
}

/** Build the child environment without ever forwarding inherited pilot authority. */
export function prepareAstraRuntimePilotEnvironment({ environment, mode, telegramMode = null, hostToken, modelHost = null,
  managedLocal = false, journalKey = null }) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw Error('astra-pilot-policy:environment');
  const next = { ...environment };
  delete next.MONARCH_ASTRA_V3_PILOT;
  delete next.MONARCH_ASTRA_V3_HOST_TOKEN;
  delete next.MONARCH_ASTRA_TELEGRAM_MODE;
  delete next.MONARCH_ASTRA_V3_MODEL_HOST_ENDPOINT;
  delete next.MONARCH_ASTRA_V3_MODEL_HOST_TOKEN;
  delete next.MONARCH_ASTRA_V3_MODEL_HOST_GENERATION;
  delete next.MONARCH_ASTRA_V3_MODEL_DIGEST;
  delete next.MONARCH_ASTRA_V3_MODEL_DIGESTS;
  delete next.MONARCH_ASTRA_V3_MODEL_MODE;
  delete next.MONARCH_ASTRA_V3_LOCAL_MEMORY;
  delete next.MONARCH_ASTRA_V3_JOURNAL_KEY;
  delete next.OSCAR_ASTRA_LOCAL_COMPONENT;
  if (mode === null) {
    if (managedLocal) throw Error('astra-pilot-policy:model-authority');
    if (telegramMode !== null) throw Error('astra-pilot-policy:telegram-authority');
    if (modelHost !== null) throw Error('astra-pilot-policy:model-authority');
    return next;
  }
  if (mode !== ASTRA_RUNTIME_PILOT_MODE || typeof hostToken !== 'string' || hostToken.length < 32 || hostToken.length > 4096
    || !validJournalKey(journalKey))
    throw Error('astra-pilot-policy:authority');
  next.MONARCH_ASTRA_V3_PILOT = mode;
  next.MONARCH_ASTRA_V3_HOST_TOKEN = hostToken;
  next.MONARCH_ASTRA_V3_JOURNAL_KEY = journalKey;
  if (managedLocal) {
    if (modelHost !== null) throw Error('astra-pilot-policy:model-destination-conflict');
    next.MONARCH_ASTRA_V3_MODEL_MODE = 'managed-local';
  }
  if (telegramMode !== null) {
    if (telegramMode !== ASTRA_TELEGRAM_PILOT_MODE) throw Error('astra-pilot-policy:telegram-authority');
    next.MONARCH_ASTRA_TELEGRAM_MODE = telegramMode;
  }
  if (modelHost !== null) {
    if (!modelHost || typeof modelHost !== 'object' || Array.isArray(modelHost)
      || Object.keys(modelHost).length !== 5
      || typeof modelHost.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(modelHost.endpoint)
      || typeof modelHost.bearerToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/u.test(modelHost.bearerToken)
      || typeof modelHost.hostGeneration !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(modelHost.hostGeneration)
      || typeof modelHost.modelDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(modelHost.modelDigest)
      || !validModelDigests(modelHost.modelDigests)
      || !Object.values(modelHost.modelDigests).includes(modelHost.modelDigest)) {
      throw Error('astra-pilot-policy:model-authority');
    }
    next.MONARCH_ASTRA_V3_MODEL_HOST_ENDPOINT = modelHost.endpoint;
    next.MONARCH_ASTRA_V3_MODEL_HOST_TOKEN = modelHost.bearerToken;
    next.MONARCH_ASTRA_V3_MODEL_HOST_GENERATION = modelHost.hostGeneration;
    next.MONARCH_ASTRA_V3_MODEL_DIGEST = modelHost.modelDigest;
    next.MONARCH_ASTRA_V3_MODEL_DIGESTS = JSON.stringify({
      'openai/gpt-oss-120b': modelHost.modelDigests['openai/gpt-oss-120b'],
      'qwen/qwen3.8-27b': modelHost.modelDigests['qwen/qwen3.8-27b'],
    });
  }
  return next;
}

function validModelDigests(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.every(key => ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(key))
    && keys.every(key => typeof value[key] === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value[key]))
    && value['openai/gpt-oss-120b'] !== value['qwen/qwen3.8-27b'];
}

function validJournalKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength === 32 && decoded.toString('base64') === value;
}
