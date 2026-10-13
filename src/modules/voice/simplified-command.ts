import { resolveDeviceIntentAction, type DeviceIntentAction } from '../device';

export type SimplifiedVoiceCardKind = 'none' | 'status' | 'choice' | 'warning' | 'weather' | 'exchange-rate';

export type SimplifiedVoiceInformationCommandV1 =
  | {
      schemaVersion: 1;
      kind: 'information';
      text: string;
      feature: 'weather';
      period: 'today' | 'tomorrow' | 'day-after-tomorrow';
      locationHint?: string;
      card: 'weather';
    }
  | {
      schemaVersion: 1;
      kind: 'information';
      text: string;
      feature: 'exchange-rate';
      currency: 'USD' | 'EUR' | 'PLN' | 'GBP' | 'CHF' | 'CZK' | 'major';
      amount: number;
      card: 'exchange-rate';
    };

export type SimplifiedVoiceCommandV1 =
  | { schemaVersion: 1; kind: 'wake'; text: string; spokenText: string; card: SimplifiedVoiceCardKind }
  | {
      schemaVersion: 1;
      kind: 'capability';
      text: string;
      moduleId: 'device';
      capabilityId: string;
      input: Record<string, unknown>;
      risk: DeviceIntentAction['risk'];
      card: SimplifiedVoiceCardKind;
    }
  | SimplifiedVoiceInformationCommandV1
  | { schemaVersion: 1; kind: 'handoff'; text: string; reason: string; card: 'warning' };

const WAKE_PREFIX = /^(?:(?:эй|hey)[\s,.:;!?-]+)?(?:о+с+к+[аa]+р+|os+c*[aа]+r+)(?=$|[\s,.:;!?-])[\s,.:;!?-]*/iu;
const WAKE_ONLY = /^(?:(?:эй|hey)[\s,.:;!?-]+)?(?:о+с+к+[аa]+р+|os+c*[aа]+r+)[\s,.:;!?-]*$/iu;

/**
 * Small deterministic grammar for latency-sensitive local commands. Unknown,
 * destructive, or information-provider requests never fall through into an
 * implicit Agent turn.
 */
export function compileSimplifiedVoiceCommand(value: unknown): SimplifiedVoiceCommandV1 {
  const original = boundedVoiceText(value);
  if (!original) return { schemaVersion: 1, kind: 'handoff', text: '', reason: 'empty-command', card: 'warning' };
  if (WAKE_ONLY.test(original)) {
    return { schemaVersion: 1, kind: 'wake', text: '', spokenText: 'Слушаю.', card: 'none' };
  }
  const text = original.replace(WAKE_PREFIX, '').trim();
  if (!text) return { schemaVersion: 1, kind: 'wake', text: '', spokenText: 'Слушаю.', card: 'none' };
  const information = compileInformationCommand(text);
  if (information) return information;
  if (isUnsupportedProviderBackedInformationRequest(text)) {
    return { schemaVersion: 1, kind: 'handoff', text, reason: 'information-provider-not-configured', card: 'warning' };
  }
  const action = resolveDeviceIntentAction(text);
  if (!action) return { schemaVersion: 1, kind: 'handoff', text, reason: 'unsupported-command', card: 'warning' };
  if (action.risk === 'delete') {
    return { schemaVersion: 1, kind: 'handoff', text, reason: 'destructive-command-not-simplified', card: 'warning' };
  }
  return {
    schemaVersion: 1,
    kind: 'capability',
    text,
    moduleId: 'device',
    capabilityId: action.capabilityId,
    input: action.input,
    risk: action.risk,
    card: action.risk === 'read' ? 'status' : 'none',
  };
}

export function isSimplifiedWakeText(value: unknown): boolean {
  return WAKE_ONLY.test(boundedVoiceText(value));
}

function compileInformationCommand(text: string): SimplifiedVoiceInformationCommandV1 | null {
  if (/(?:погод|прогноз|weather|forecast)/iu.test(text)) {
    const period = /(?:послезавтра|day\s+after\s+tomorrow)/iu.test(text)
      ? 'day-after-tomorrow'
      : /(?:завтра|tomorrow)/iu.test(text)
        ? 'tomorrow'
        : 'today';
    const locationHint = extractWeatherLocation(text);
    return {
      schemaVersion: 1,
      kind: 'information',
      text,
      feature: 'weather',
      period,
      ...(locationHint ? { locationHint } : {}),
      card: 'weather',
    };
  }
  if (/(?:курс|сколько|конверт|exchange\s+rate|convert)/iu.test(text)
    && /(?:валют|доллар|евро|злот|фунт|франк|крон|usd|eur|pln|gbp|chf|czk|грив|uah)/iu.test(text)) {
    const amountMatch = text.match(/(?:^|\s)(\d{1,7}(?:[.,]\d{1,2})?)(?=\s|$)/u);
    const amount = amountMatch ? Math.min(10_000_000, Number(amountMatch[1]?.replace(',', '.'))) : 1;
    return {
      schemaVersion: 1,
      kind: 'information',
      text,
      feature: 'exchange-rate',
      currency: resolveCurrency(text),
      amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
      card: 'exchange-rate',
    };
  }
  return null;
}

function extractWeatherLocation(text: string): string | undefined {
  const match = text.match(/(?:^|\s)(?:в|для|по|in|for)\s+([\p{L}][\p{L}\s.'-]{1,79})/iu);
  if (!match?.[1]) return undefined;
  const value = match[1]
    .replace(/\b(?:сегодня|завтра|послезавтра|today|tomorrow)\b.*$/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return value || undefined;
}

function resolveCurrency(text: string): 'USD' | 'EUR' | 'PLN' | 'GBP' | 'CHF' | 'CZK' | 'major' {
  if (/(?:евро|\beur\b)/iu.test(text)) return 'EUR';
  if (/(?:злот|\bpln\b)/iu.test(text)) return 'PLN';
  if (/(?:фунт|\bgbp\b)/iu.test(text)) return 'GBP';
  if (/(?:франк|\bchf\b)/iu.test(text)) return 'CHF';
  if (/(?:чешск|крон|\bczk\b)/iu.test(text)) return 'CZK';
  if (/(?:доллар|\busd\b)/iu.test(text)) return 'USD';
  return 'major';
}

function isUnsupportedProviderBackedInformationRequest(text: string): boolean {
  return /(?:новост|news|пробк|traffic)/iu.test(text);
}

function boundedVoiceText(value: unknown): string {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}
