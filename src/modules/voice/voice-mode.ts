import { classifyVoiceVolumeIntent } from './voice-device-volume';
import { classifyVoiceBrightnessIntent } from './voice-device-brightness';

export type VoiceModeActionId =
  | 'listen.continue'
  | 'math.calculate'
  | 'time.query'
  | 'weather.query'
  | 'web.search'
  | 'workspace.create'
  | 'workspace.delete'
  | 'device.volume'
  | 'device.volume.status'
  | 'device.volume.clarification'
  | 'device.brightness'
  | 'device.brightness.status'
  | 'device.brightness.clarification'
  | 'device.control.unsupported'
  | 'device.app.open'
  | 'device.browser.open'
  | 'device.media.open'
  | 'assistant.fallback';

export type VoiceModeRisk = 'read' | 'write';
export type VoiceModeExecutionLane = 'scripted' | 'voice-micro' | 'voice-lite' | 'voice-realtime' | 'fast-llm' | 'blocked';
export type VoiceModeModelRoute = 'none' | 'qwen2.5-0.5b' | 'qwen3-1.7b' | 'gemma4-fast';
export type VoiceModeLocalProfile = 'micro' | 'lite';

export interface VoiceModeCommandCandidate {
  actionId: VoiceModeActionId;
  normalizedText: string;
  score: number;
  risk: VoiceModeRisk;
  lane: VoiceModeExecutionLane;
  modelRoute: VoiceModeModelRoute;
  maxNewTokens: number;
  requiresConfirmation: boolean;
  usesLlm: boolean;
  requiresRealtime: boolean;
  reason: string;
  slots: Record<string, string>;
}

interface VoiceModeRule {
  actionId: VoiceModeActionId;
  risk: VoiceModeRisk;
  lane: VoiceModeExecutionLane;
  requiresConfirmation?: boolean;
  patterns: RegExp[];
  reason: string;
  slot?: (text: string) => Record<string, string>;
}

const WAKE_WORDS = [
  'оскар',
  'oscar',
  'монарх',
  'monarch',
  'манарх',
];

const FILLER_WORDS = [
  'ну',
  'ээ',
  'эээ',
  'слушай',
  'пожалуйста',
  'плиз',
  'давай',
  'можешь',
  'скажи',
];

const VOICE_ACKNOWLEDGEMENTS: ReadonlyMap<string, string> = new Map([
  ['', 'Слушаю.'],
  ['оскар', 'Слушаю.'],
  ['oscar', 'Слушаю.'],
  ['монарх', 'Слушаю.'],
  ['monarch', 'Слушаю.'],
  ['манарх', 'Слушаю.'],
  ['ты тут', 'Я тут.'],
  ['ты здесь', 'Я тут.'],
  ['ты со мной', 'Я тут.'],
  ['ты на связи', 'Я тут.'],
  ['слышишь', 'Слушаю.'],
  ['ты слышишь', 'Слушаю.'],
  ['слышишь меня', 'Слушаю.'],
  ['ты меня слышишь', 'Слушаю.'],
  ['слушаешь', 'Слушаю.'],
  ['ты слушаешь', 'Слушаю.'],
  ['ты меня слушаешь', 'Слушаю.'],
  ['ау', 'Я тут.'],
  ['эй', 'Я тут.'],
  ['отзовись', 'Я тут.'],
]);

const VOICE_LOCAL_REPLIES: ReadonlyMap<string, string> = new Map([
  ['привет', 'Привет.'],
  ['здравствуй', 'Привет.'],
  ['здравствуйте', 'Здравствуйте.'],
  ['доброе утро', 'Доброе утро.'],
  ['добрый день', 'Добрый день.'],
  ['добрый вечер', 'Добрый вечер.'],
  ['как дела', 'Всё нормально.'],
  ['как ты', 'Всё нормально.'],
  ['спасибо', 'Пожалуйста.'],
  ['благодарю', 'Пожалуйста.'],
  ['пока', 'До встречи.'],
  ['до встречи', 'До встречи.'],
  ['привет как дела', 'Привет. Всё нормально.'],
]);

const VOICE_MODE_RULES: VoiceModeRule[] = [
  {
    actionId: 'math.calculate',
    risk: 'read',
    lane: 'scripted',
    patterns: [
      /^-?\d+(?:\.\d+)?\s+(?:плюс|минус|умножить на|помножить на|разделить на)\s+-?\d+(?:\.\d+)?$/i,
      /^-?\d+(?:\.\d+)?\s*(?:\+|-|\*|\/|x)\s*-?\d+(?:\.\d+)?$/i,
    ],
    reason: 'Simple arithmetic is deterministic and must not depend on a tiny language model.',
    slot: extractMathSlots,
  },
  {
    actionId: 'weather.query',
    risk: 'read',
    lane: 'scripted',
    patterns: [
      /(^|\s)(погода|погоду|погоде|погоды|прогноз)(\s|$)/i,
      /\b(weather|forecast)\b/i,
    ],
    reason: 'Scripted weather lookup can run without a heavy model.',
    slot: extractWeatherSlots,
  },
  {
    actionId: 'web.search',
    risk: 'read',
    lane: 'scripted',
    patterns: [
      /(^|\s)(найди|поищи|поиск|загугли|найти в интернете|веб поиск)(\s|$)/i,
      /\b(search|web search|google)\b/i,
    ],
    reason: 'Scripted web search intent.',
    slot: extractSearchSlots,
  },
  {
    actionId: 'workspace.create',
    risk: 'write',
    lane: 'scripted',
    requiresConfirmation: true,
    patterns: [
      /(^|\s)(создай|создать|сделай|заведи)(?=\s|$).*(^|\s)(файл|папку|папка|папки|заметку|заметка|заметки|документ|документа)(?=\s|$)/i,
      /\b(create|make)\b.*\b(file|folder|note)\b/i,
    ],
    reason: 'Workspace write action needs deterministic parsing and confirmation.',
    slot: extractWorkspaceObjectSlots,
  },
  {
    actionId: 'workspace.delete',
    risk: 'write',
    lane: 'scripted',
    requiresConfirmation: true,
    patterns: [
      /(^|\s)(удали|удалить|сотри|стереть)(?=\s|$).*(^|\s)(файл|папку|папка|папки|заметку|заметка|заметки|документ|документа)(?=\s|$)/i,
      /\b(delete|remove)\b.*\b(file|folder|note)\b/i,
    ],
    reason: 'Destructive workspace action always requires confirmation.',
    slot: extractWorkspaceObjectSlots,
  },
  {
    actionId: 'device.control.unsupported',
    risk: 'write',
    lane: 'scripted',
    requiresConfirmation: true,
    patterns: [
      /(^|\s)(сделай|поставь|установи|измени|увеличь|уменьши|включи|выключи|подключи|отключи)(?=\s|$).*(^|\s)(яркост\p{L}*|экран\p{L}*|wifi|wi-fi|вайфай|bluetooth|блютуз|сеть\p{L}*|устройств\p{L}*)(?=\s|$)/iu,
    ],
    reason: 'Unimplemented device controls must be intercepted before every language-model lane.',
  },
  {
    actionId: 'device.browser.open',
    risk: 'write',
    lane: 'scripted',
    requiresConfirmation: true,
    patterns: [
      /(^|\s)(открой|открыть|покажи|перейди|зайди|open|browse)(?=\s|$).*(^|\s)(сайт|страниц\p{L}*|ссылк\p{L}*|браузер\p{L}*|интернет\p{L}*|https?|www)(?=\s|$|[.:/])/iu,
      /(^|\s)(открой|открыть|покажи|перейди|зайди|open|browse)(?=\s|$).*(?:\.(?:com|org|net|io|ru|ua|dev|app))(?=\s|$|\/)/iu,
    ],
    reason: 'Browser navigation belongs to a permission-gated device capability.',
    slot: extractBrowserSlots,
  },
  {
    actionId: 'device.app.open',
    risk: 'write',
    lane: 'scripted',
    requiresConfirmation: true,
    patterns: [
      /(^|\s)(открой|открыть|запусти|запустить|open|launch)\s+(?:.*\s)?(браузер|chrome|хром|edge|firefox|калькулятор|блокнот|notepad|терминал|terminal|проводник|explorer|discord|telegram|телеграм|steam|стим|vscode|приложение|программу|browser|app)(\s|$)/i,
      /(^|\s)(открой|открыть|запусти|запустить|open|launch)(?=\s|$)\s+(?:приложение|программу|app)\s+[\p{L}\p{N} ._-]{1,80}$/iu,
    ],
    reason: 'Application launch belongs to a permission-gated device capability.',
    slot: extractApplicationSlots,
  },
  {
    actionId: 'device.media.open',
    risk: 'write',
    lane: 'scripted',
    requiresConfirmation: true,
    patterns: [
      /(^|\s)(открой|включи|вруби|воспроизведи|поставь|найди|open|play)\s+(?:.*\s)?(youtube|ютуб|видео|ролик|музык|трек|песн|video|music|track|song)(\s|$)/i,
    ],
    reason: 'Media open/play requests belong to an explicit browser/media capability.',
    slot: extractMediaSlots,
  },
];

const LITE_LANE_PATTERNS = [
  /^(?:перефразируй|скажи иначе|сформулируй короче)\s*:?\s+.{1,96}$/iu,
  /^(?:иначе|сократи|укороти|исправь фразу)(?:\s+.{1,120})$/iu,
  /^объясни(?:\s+это)?\s+(?:коротко|кратко)(?:\s+.{1,120})?$/iu,
];
const BLOCKED_LENGTH = 620;

export function normalizeVoiceCommandText(value: string): string {
  return parseVoiceCommandText(value).normalizedText;
}

function parseVoiceCommandText(value: string): { normalizedText: string; wakeWordDetected: boolean } {
  const text = String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}._:+*/\\-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = text.split(' ').filter(Boolean);
  let prefixLength = 0;
  while (prefixLength < tokens.length && FILLER_WORDS.includes(tokens[prefixLength]!)) {
    prefixLength += 1;
  }
  const wakeWordDetected = Boolean(tokens[prefixLength] && WAKE_WORDS.includes(tokens[prefixLength]!));
  if (wakeWordDetected) {
    tokens.splice(0, prefixLength + 1);
  } else if (prefixLength > 0) {
    tokens.splice(0, prefixLength);
  }
  return {
    normalizedText: tokens
      .filter((token) => !FILLER_WORDS.includes(token))
      .join(' ')
      .trim(),
    wakeWordDetected,
  };
}

export function classifyVoiceModeCommand(value: string): VoiceModeCommandCandidate {
  const { normalizedText, wakeWordDetected } = parseVoiceCommandText(value);
  const acknowledgement = wakeWordDetected
    ? VOICE_ACKNOWLEDGEMENTS.get(normalizedText)
    : undefined;
  const localReply = VOICE_LOCAL_REPLIES.get(normalizedText)
    || (!wakeWordDetected ? VOICE_ACKNOWLEDGEMENTS.get(normalizedText) : undefined);
  if (!normalizedText || acknowledgement || localReply) {
    const reply = acknowledgement || localReply;
    return {
      actionId: 'listen.continue',
      normalizedText,
      score: reply ? 0.98 : 0.9,
      risk: 'read',
      lane: 'scripted',
      modelRoute: 'none',
      maxNewTokens: 0,
      requiresConfirmation: false,
      usesLlm: false,
      requiresRealtime: false,
      reason: reply
        ? 'Exact bounded social acknowledgement; answer locally and continue hands-free listening.'
        : 'Silence or filler only; keep listening for the actual command.',
      slots: reply ? { acknowledgement: reply } : {},
    };
  }

  const clockSlots = extractClockQuerySlots(normalizedText, value);
  if (clockSlots) {
    return {
      actionId: 'time.query',
      normalizedText,
      score: 0.97,
      risk: 'read',
      lane: 'scripted',
      modelRoute: 'none',
      maxNewTokens: 0,
      requiresConfirmation: false,
      usesLlm: false,
      requiresRealtime: false,
      reason: 'Order-independent clock intent with duration phrases excluded.',
      slots: clockSlots,
    };
  }

  const volumeIntent = classifyVoiceVolumeIntent(value);
  if (volumeIntent.kind !== 'none') {
    const actionId = volumeIntent.kind === 'action'
      ? 'device.volume'
      : volumeIntent.kind === 'status'
        ? 'device.volume.status'
        : 'device.volume.clarification';
    const mutating = volumeIntent.kind === 'action';
    return {
      actionId,
      normalizedText: volumeIntent.normalizedText || normalizedText,
      score: mutating ? 0.97 : 0.95,
      risk: mutating ? 'write' : 'read',
      lane: 'scripted',
      modelRoute: 'none',
      maxNewTokens: 0,
      requiresConfirmation: mutating,
      usesLlm: false,
      requiresRealtime: false,
      reason: mutating
        ? 'Complete volume intent and slots; execute only through the verified Windows capability.'
        : volumeIntent.kind === 'status'
          ? 'Read and report the verified Windows endpoint volume without a model.'
          : 'Incomplete volume-domain command must be clarified without a model or device mutation.',
      slots: volumeIntent.slots,
    };
  }

  const brightnessIntent = classifyVoiceBrightnessIntent(value);
  if (brightnessIntent.kind !== 'none') {
    const mutating = brightnessIntent.kind === 'action';
    const actionId = mutating
      ? 'device.brightness'
      : brightnessIntent.kind === 'status'
        ? 'device.brightness.status'
        : 'device.brightness.clarification';
    return {
      actionId,
      normalizedText: brightnessIntent.normalizedText || normalizedText,
      score: mutating ? 0.97 : brightnessIntent.kind === 'status' ? 0.95 : 0.91,
      risk: mutating ? 'write' : 'read',
      lane: 'scripted',
      modelRoute: 'none',
      maxNewTokens: 0,
      requiresConfirmation: mutating,
      usesLlm: false,
      requiresRealtime: false,
      reason: mutating
        ? 'Complete brightness intent and slots; execute only through the verified Windows Device capability.'
        : brightnessIntent.kind === 'status'
          ? 'Read the active Windows display brightness without a model.'
          : 'Incomplete brightness command must be clarified without a model or device mutation.',
      slots: brightnessIntent.slots,
    };
  }

  for (const rule of VOICE_MODE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalizedText))) {
      const slots = rule.slot?.(normalizedText) || {};
      const requiresRealtime = (rule.actionId === 'weather.query' && Boolean(slots.location))
        || (rule.actionId === 'web.search' && Boolean(slots.query));
      const usesRealtimeLlm = requiresRealtime && rule.actionId === 'web.search';
      return {
        actionId: rule.actionId,
        normalizedText,
        score: scoreRuleMatch(rule, normalizedText),
        risk: rule.risk,
        lane: requiresRealtime ? 'voice-realtime' : rule.lane,
        modelRoute: usesRealtimeLlm ? 'gemma4-fast' : 'none',
        maxNewTokens: usesRealtimeLlm ? 128 : 0,
        requiresConfirmation: Boolean(rule.requiresConfirmation),
        usesLlm: usesRealtimeLlm,
        requiresRealtime,
        reason: rule.reason,
        slots,
      };
    }
  }

  if (isCurrentKnowledgeQuery(normalizedText)) {
    const realtimeQuery = normalizeRealtimeKnowledgeQuery(normalizedText);
    return {
      actionId: 'web.search',
      normalizedText,
      score: 0.94,
      risk: 'read',
      lane: 'voice-realtime',
      modelRoute: 'gemma4-fast',
      maxNewTokens: 128,
      requiresConfirmation: false,
      usesLlm: true,
      requiresRealtime: true,
      reason: 'Volatile factual knowledge requires a current source-grounded lookup, never a tiny local model.',
      slots: { query: realtimeQuery, freshness: 'current' },
    };
  }

  const blocked = normalizedText.length > BLOCKED_LENGTH;
  const lite = !blocked
    && normalizedText.length <= 160
    && LITE_LANE_PATTERNS.some((pattern) => pattern.test(normalizedText));

  return {
    actionId: 'assistant.fallback',
    normalizedText,
    score: blocked ? 0.2 : lite ? 0.78 : 0.72,
    risk: 'read',
    lane: blocked ? 'blocked' : lite ? 'voice-lite' : 'fast-llm',
    modelRoute: blocked ? 'none' : lite ? 'qwen3-1.7b' : 'gemma4-fast',
    maxNewTokens: blocked ? 0 : lite ? 96 : 192,
    requiresConfirmation: false,
    usesLlm: !blocked,
    requiresRealtime: false,
    reason: blocked
      ? 'The request is too large for a latency-bounded voice turn.'
      : lite
        ? 'A bounded non-factual transformation can use the local Lite voice model.'
        : 'Unrecognized or factual content is routed to Fast so tiny voice models cannot invent knowledge.',
    slots: {},
  };
}

export function shouldUseVoiceModeLlm(candidate: VoiceModeCommandCandidate): boolean {
  return candidate.actionId === 'assistant.fallback'
    && (candidate.lane === 'voice-micro' || candidate.lane === 'voice-lite' || candidate.lane === 'fast-llm')
    && candidate.usesLlm
    && candidate.normalizedText.length <= BLOCKED_LENGTH;
}

export function voiceModeLocalProfile(candidate: VoiceModeCommandCandidate): VoiceModeLocalProfile | null {
  if (candidate.lane === 'voice-micro' && candidate.modelRoute === 'qwen2.5-0.5b') return 'micro';
  if (candidate.lane === 'voice-lite' && candidate.modelRoute === 'qwen3-1.7b') return 'lite';
  return null;
}

export function shouldUseVoiceModeFastLlm(candidate: VoiceModeCommandCandidate): boolean {
  return shouldUseVoiceModeLlm(candidate)
    && candidate.lane === 'fast-llm'
    && candidate.modelRoute === 'gemma4-fast';
}

function scoreRuleMatch(rule: VoiceModeRule, text: string): number {
  const base = rule.requiresConfirmation ? 0.86 : 0.9;
  const shortCommandBonus = text.length <= 80 ? 0.05 : 0;
  return Math.min(0.98, base + shortCommandBonus);
}

function extractClockQuerySlots(text: string, source: string): Record<string, string> | null {
  const normalizedSource = String(source || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}?]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const duration = /(?:^|\s)(?:через|за|на)\s+(?:сколько|какое|которое)?\s*врем\p{L}*(?=\s|$)/u.test(text)
    || /(?:^|\s)сколько\s+врем\p{L}*\s+(?:займет|занимает|заняло|длится|длилось|прошло|осталось|потребуется|нужно|требуется)(?=\s|$)/u.test(text)
    || /(?:^|\s)врем\p{L}*\s+(?:займет|занимает|заняло|длится|длилось|прошло|осталось|потребуется|нужно|требуется|выполнения|ожидания)(?=\s|$)/u.test(text)
    || /(?:^|\s)(?:длительность|таймер|секунд\p{L}*|минут\p{L}*|часов|срок)(?=\s|$)/u.test(text);
  if (duration) return null;

  const canonical = /(?:^|\s)котор(?:ый|ого)\s+час(?=\s|$)/u.test(text)
    || /(?:^|\s)сколько(?:\s+сейчас)?\s+врем\p{L}*(?=\s|$)/u.test(text)
    || /(?:^|\s)what\s+time(?=\s|$)/u.test(text);
  const hasClockNoun = /(?:^|\s)(?:время|времени|час|часах|time)(?=\s|$)/u.test(text);
  const clockQualifier = /(?:^|\s)(?:сейчас|текущее|точное|местное|который|какое|сколько|часах|now|current)(?=\s|$)/u.test(text);
  const rawRequest = /(?:^|\s)(?:скажи|подскажи|покажи|назови|сообщи|tell|show)(?=\s|$)/u.test(normalizedSource);
  const bareClock = /^(?:время|времени|который\s+час|time)$/u.test(text);
  if (!canonical && !(hasClockNoun && (clockQualifier || rawRequest || bareClock))) return null;
  return { query: 'local-clock', timeZone: 'system' };
}

function normalizeRealtimeKnowledgeQuery(text: string): string {
  const stripped = text
    .replace(/^(?:кто|какой|какая|каков|как\s+зовут)\s+(?:(?:сейчас|теперь)\s+)?/u, '')
    .replace(/^(?:сейчас|теперь)\s+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || text;
}

function isCurrentKnowledgeQuery(text: string): boolean {
  const explicitHistoricalYear = text.match(/(?:^|\s)((?:18|19|20)\d{2})(?=\s|$)/u);
  const currentMarker = /(?:^|\s)(?:сейчас|сегодня|теперь|нынешн\p{L}*|текущ\p{L}*|актуальн\p{L}*|последн\p{L}*|свеж\p{L}*|current|latest|today|now)(?=\s|$)/u.test(text);
  if (explicitHistoricalYear && Number(explicitHistoricalYear[1]) < new Date().getFullYear() && !currentMarker) {
    return false;
  }
  const officeholder = /(?:^|\s)(?:премьер\p{L}*(?:[-\s]+министр\p{L}*)?|президент\p{L}*|глава\s+(?:государства|правительства)|министр\p{L}*|губернатор\p{L}*|мэр\p{L}*|канцлер\p{L}*|корол\p{L}*|ceo|генеральн\p{L}*\s+директор\p{L}*|руководител\p{L}*\s+компани\p{L}*)(?=\s|$)/u.test(text);
  const volatile = /(?:^|\s)(?:новост\p{L}*|курс\p{L}*|цен\p{L}*|стоимост\p{L}*|котиров\p{L}*|акци\p{L}*|криптовалют\p{L}*|биткоин\p{L}*)(?=\s|$)/u.test(text);
  const politics = /(?:^|\s)(?:правительств\p{L}*|парламент\p{L}*|выбор\p{L}*|политик\p{L}*|госдум\p{L}*|верховн\p{L}*\s+рад\p{L}*)(?=\s|$)/u.test(text);
  const whoNow = /(?:^|\s)кто(?:\s+\p{L}+){0,3}\s+(?:сейчас|теперь)(?=\s|$)/u.test(text)
    || /(?:^|\s)(?:сейчас|теперь)(?:\s+\p{L}+){0,3}\s+кто(?=\s|$)/u.test(text);
  return officeholder || volatile || politics || whoNow;
}

function extractSearchSlots(text: string): Record<string, string> {
  const query = stripTerms(text, ['найти в интернете', 'веб поиск', 'web search', 'найди', 'поищи', 'поиск', 'загугли', 'search', 'google']);
  return query ? { query } : {};
}

function extractMathSlots(text: string): Record<string, string> {
  const normalized = text
    .replace(/умножить на|помножить на/gi, '*')
    .replace(/разделить на/gi, '/')
    .replace(/плюс/gi, '+')
    .replace(/минус/gi, '-')
    .replace(/\bx\b/gi, '*')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return {};
  const left = Number(match[1]);
  const right = Number(match[3]);
  const operator = match[2];
  if (!Number.isFinite(left) || !Number.isFinite(right) || (operator === '/' && right === 0)) return {};
  const value = operator === '+'
    ? left + right
    : operator === '-'
      ? left - right
      : operator === '*'
        ? left * right
        : left / right;
  return Number.isFinite(value)
    ? { expression: normalized, result: String(Number(value.toFixed(8))) }
    : {};
}

function extractWeatherSlots(text: string): Record<string, string> {
  const location = stripTerms(text, [
    'погода', 'погоду', 'погоде', 'погоды', 'прогноз', 'weather', 'forecast',
    'подскажи', 'скажи', 'расскажи', 'покажи', 'какая', 'какой', 'какую', 'будет',
    'мне', 'пожалуйста', 'прямо', 'сейчас', 'сегодня', 'завтра', 'там', 'тут',
    'в', 'во', 'на', 'для', 'по', 'in', 'for', 'now', 'today', 'tomorrow',
  ]);
  return location ? { location } : {};
}

function extractWorkspaceObjectSlots(text: string): Record<string, string> {
  const lower = text.toLowerCase();
  const kind = /(?:^|\s)(?:папк\p{L}*|каталог\p{L}*|директор\p{L}*|folder|directory)(?=\s|$)/iu.test(lower)
    ? 'directory'
    : 'file';
  const contentMatch = text.match(/(?:\s+(?:с\s+текстом|содержимое|текст)\s+)(.+)$/iu);
  const withoutContent = contentMatch ? text.slice(0, contentMatch.index).trim() : text;
  const object = stripTerms(withoutContent, [
    'создай', 'создать', 'сделай', 'заведи', 'удали', 'удалить', 'сотри', 'стереть',
    'create', 'make', 'delete', 'remove', 'файл', 'файла', 'папку', 'папка', 'папки',
    'каталог', 'директорию', 'заметку', 'заметка', 'документ', 'документа', 'file', 'folder', 'note',
  ]);
  return object ? {
    object,
    path: object,
    kind,
    ...(contentMatch?.[1] ? { content: contentMatch[1].trim().slice(0, 1_000) } : {}),
  } : {};
}

function extractApplicationSlots(text: string): Record<string, string> {
  const raw = stripTerms(text, [
    'открой', 'открыть', 'запусти', 'запустить', 'open', 'launch',
    'приложение', 'программу', 'программа', 'app',
  ]);
  if (!raw) return {};
  const aliases: Array<[RegExp, string]> = [
    [/(?:^|\s)(?:калькулятор|calculator|calc)(?=\s|$)/iu, 'calculator'],
    [/(?:^|\s)(?:блокнот|notepad)(?=\s|$)/iu, 'notepad'],
    [/(?:^|\s)(?:терминал|terminal|windows terminal)(?=\s|$)/iu, 'terminal'],
    [/(?:^|\s)(?:проводник|explorer)(?=\s|$)/iu, 'explorer'],
    [/(?:^|\s)(?:chrome|хром|google chrome)(?=\s|$)/iu, 'chrome'],
    [/(?:^|\s)(?:edge|microsoft edge)(?=\s|$)/iu, 'edge'],
    [/(?:^|\s)firefox(?=\s|$)/iu, 'firefox'],
    [/(?:^|\s)discord(?=\s|$)/iu, 'discord'],
    [/(?:^|\s)(?:telegram|телеграм)(?=\s|$)/iu, 'telegram'],
    [/(?:^|\s)(?:steam|стим)(?=\s|$)/iu, 'steam'],
    [/(?:^|\s)(?:vscode|visual studio code|код)(?=\s|$)/iu, 'vscode'],
    [/(?:^|\s)(?:браузер|browser)(?=\s|$)/iu, 'browser'],
  ];
  const known = aliases.find(([pattern]) => pattern.test(raw));
  return { app: known?.[1] || raw.slice(0, 120) };
}

function extractBrowserSlots(text: string): Record<string, string> {
  const browser = /(?:^|\s)(?:chrome|хром)(?=\s|$)/iu.test(text)
    ? 'chrome'
    : /(?:^|\s)edge(?=\s|$)/iu.test(text)
      ? 'edge'
      : /(?:^|\s)firefox(?=\s|$)/iu.test(text)
        ? 'firefox'
        : 'default';
  const urlMatch = text.match(/(?:https?:\/\/|www\.)[^\s]+|[\p{L}\p{N}.-]+\.(?:com|org|net|io|ru|ua|dev|app)(?:\/[^\s]*)?/iu);
  const query = stripTerms(text, [
    'открой', 'открыть', 'покажи', 'перейди', 'зайди', 'open', 'browse',
    'сайт', 'страницу', 'страница', 'ссылку', 'ссылка', 'браузер', 'интернет',
    'chrome', 'хром', 'edge', 'firefox', 'в', 'во', 'на',
  ]);
  return {
    browser,
    ...(urlMatch?.[0] ? { url: urlMatch[0] } : query ? { query } : {}),
  };
}

function extractMediaSlots(text: string): Record<string, string> {
  const provider = /(?:youtube|ютуб)/iu.test(text) ? 'youtube' : 'default';
  const query = stripTerms(text, [
    'открой', 'включи', 'вруби', 'воспроизведи', 'поставь', 'найди', 'open', 'play',
    'youtube', 'ютуб', 'ютубе', 'видео', 'ролик', 'музыку', 'музыка', 'трек', 'песню', 'песня',
    'video', 'music', 'track', 'song', 'на', 'в',
  ]);
  return { provider, ...(query ? { query } : {}) };
}

function stripTerms(text: string, terms: string[]): string {
  let result = ` ${text} `;
  for (const term of [...terms].sort((left, right) => right.length - left.length)) {
    result = result.replace(new RegExp(`\\s${escapeRegExp(term)}(?=\\s)`, 'gi'), ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
