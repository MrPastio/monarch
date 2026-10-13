import type { SimplifiedVoiceInformationCommandV1 } from './simplified-command';

export const VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION = '2026-08-29.1';

export interface VoiceLocationV1 {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}

export interface VoiceInformationMetricV1 {
  label: string;
  value: string;
}

export interface VoiceInformationCardV1 {
  schemaVersion: 1;
  kind: 'weather' | 'exchange-rate';
  title: string;
  primary: string;
  summary: string;
  metrics: VoiceInformationMetricV1[];
  provider: {
    name: 'Open-Meteo' | 'НБУ';
    attribution: string;
    url: string;
  };
  observedAt: string;
}

export interface VoiceInformationResultV1 {
  ok: boolean;
  text: string;
  card?: VoiceInformationCardV1;
  reason?: string;
}

export interface VoiceInformationExecutionContextV1 {
  manualLocation: string;
  deviceLocation?: VoiceLocationV1;
  signal?: AbortSignal;
}

type FetchLike = typeof fetch;

export interface VoiceInformationProviderOptions {
  openMeteoApiKey?: string | undefined;
  openMeteoWeatherBaseUrl?: string | undefined;
  openMeteoGeocodingBaseUrl?: string | undefined;
}

export class VoiceInformationProviderService {
  private readonly openMeteoApiKey: string;
  private readonly weatherBaseUrl: string;
  private readonly geocodingBaseUrl: string;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 5_000,
    options: VoiceInformationProviderOptions = {},
  ) {
    this.openMeteoApiKey = cleanText(options.openMeteoApiKey, 256);
    this.weatherBaseUrl = normalizeProviderBaseUrl(
      options.openMeteoWeatherBaseUrl,
      this.openMeteoApiKey ? 'https://customer-api.open-meteo.com' : 'https://api.open-meteo.com',
      ['https://api.open-meteo.com', 'https://customer-api.open-meteo.com'],
    );
    this.geocodingBaseUrl = normalizeProviderBaseUrl(
      options.openMeteoGeocodingBaseUrl,
      this.openMeteoApiKey ? 'https://customer-geocoding-api.open-meteo.com' : 'https://geocoding-api.open-meteo.com',
      ['https://geocoding-api.open-meteo.com', 'https://customer-geocoding-api.open-meteo.com'],
    );
  }

  async execute(
    command: SimplifiedVoiceInformationCommandV1,
    context: VoiceInformationExecutionContextV1,
  ): Promise<VoiceInformationResultV1> {
    if (command.feature === 'weather') return this.weather(command, context);
    return this.exchangeRate(command, context.signal);
  }

  private async weather(
    command: Extract<SimplifiedVoiceInformationCommandV1, { feature: 'weather' }>,
    context: VoiceInformationExecutionContextV1,
  ): Promise<VoiceInformationResultV1> {
    const location = command.locationHint
      ? await this.geocode(command.locationHint, context.signal)
      : context.deviceLocation
        ? { ...context.deviceLocation, label: 'Текущее местоположение' }
        : await this.geocode(context.manualLocation, context.signal);
    if (!location) {
      return {
        ok: false,
        text: '',
        reason: command.locationHint || context.manualLocation ? 'weather-location-not-found' : 'weather-location-required',
      };
    }

    const query = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      daily: [
        'weather_code',
        'temperature_2m_max',
        'temperature_2m_min',
        'apparent_temperature_max',
        'precipitation_probability_max',
        'wind_speed_10m_max',
      ].join(','),
      timezone: 'auto',
      forecast_days: '3',
      ...(this.openMeteoApiKey ? { apikey: this.openMeteoApiKey } : {}),
    });
    const payload = await this.readJson(`${this.weatherBaseUrl}/v1/forecast?${query}`, context.signal);
    const daily = readObject(readObject(payload).daily);
    const index = command.period === 'day-after-tomorrow' ? 2 : command.period === 'tomorrow' ? 1 : 0;
    const date = readArrayValue(daily.time, index);
    const maximum = readFiniteArrayValue(daily.temperature_2m_max, index);
    const minimum = readFiniteArrayValue(daily.temperature_2m_min, index);
    const apparent = readFiniteArrayValue(daily.apparent_temperature_max, index);
    const precipitation = readFiniteArrayValue(daily.precipitation_probability_max, index);
    const wind = readFiniteArrayValue(daily.wind_speed_10m_max, index);
    const code = readFiniteArrayValue(daily.weather_code, index);
    if (!date || maximum === null || minimum === null || code === null) {
      return { ok: false, text: '', reason: 'weather-provider-invalid-response' };
    }

    const condition = weatherCondition(code);
    const dayLabel = command.period === 'day-after-tomorrow'
      ? 'Послезавтра'
      : command.period === 'tomorrow'
        ? 'Завтра'
        : 'Сегодня';
    const primary = `${roundTemperature(maximum)}° / ${roundTemperature(minimum)}°`;
    const text = `${dayLabel}, ${location.label}: ${condition.toLowerCase()}, от ${roundTemperature(minimum)} до ${roundTemperature(maximum)} градусов${precipitation === null ? '' : `, вероятность осадков ${Math.round(precipitation)} процентов`}.`;
    return {
      ok: true,
      text,
      card: {
        schemaVersion: 1,
        kind: 'weather',
        title: `${dayLabel} · ${location.label}`,
        primary,
        summary: condition,
        metrics: [
          ...(apparent === null ? [] : [{ label: 'Ощущается', value: `${roundTemperature(apparent)}°` }]),
          ...(precipitation === null ? [] : [{ label: 'Осадки', value: `${Math.round(precipitation)}%` }]),
          ...(wind === null ? [] : [{ label: 'Ветер', value: `${Math.round(wind)} км/ч` }]),
        ].slice(0, 3),
        provider: {
          name: 'Open-Meteo',
          attribution: 'Данные Open-Meteo · CC BY 4.0',
          url: 'https://open-meteo.com/',
        },
        observedAt: new Date().toISOString(),
      },
    };
  }

  private async geocode(value: string, signal?: AbortSignal): Promise<{
    latitude: number;
    longitude: number;
    label: string;
  } | null> {
    const queryText = cleanText(value, 100);
    if (queryText.length < 2) return null;
    for (const plannedQuery of locationQueryCandidates(queryText)) {
      const language = /[а-яёіїєґ]/iu.test(plannedQuery) ? 'ru' : 'en';
      const query = new URLSearchParams({
        name: plannedQuery,
        count: '5',
        language,
        format: 'json',
        ...(this.openMeteoApiKey ? { apikey: this.openMeteoApiKey } : {}),
      });
      const payload = await this.readJson(`${this.geocodingBaseUrl}/v1/search?${query}`, signal);
      const geocoding = readObject(payload);
      const results: unknown[] = Array.isArray(geocoding.results) ? geocoding.results : [];
      const candidate = results.find((entry) => {
        const item = readObject(entry);
        return Number.isFinite(Number(item.latitude))
          && Number.isFinite(Number(item.longitude))
          && canonicalLocationName(item.name) === canonicalLocationName(plannedQuery);
      });
      if (!candidate) continue;
      const item = readObject(candidate);
      const name = cleanText(item.name, 100);
      const admin = cleanText(item.admin1, 100);
      const country = cleanText(item.country, 100);
      return {
        latitude: Number(item.latitude),
        longitude: Number(item.longitude),
        label: [name, admin && admin !== name ? admin : '', country].filter(Boolean).slice(0, 2).join(', '),
      };
    }
    return null;
  }

  private async exchangeRate(
    command: Extract<SimplifiedVoiceInformationCommandV1, { feature: 'exchange-rate' }>,
    signal?: AbortSignal,
  ): Promise<VoiceInformationResultV1> {
    const payload = await this.readJson('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', signal);
    if (!Array.isArray(payload)) return { ok: false, text: '', reason: 'exchange-provider-invalid-response' };
    const rates = new Map<string, { rate: number; date: string }>();
    payload.forEach((entry) => {
      const item = readObject(entry);
      const code = cleanText(item.cc, 3).toUpperCase();
      const rate = Number(item.rate);
      if (/^[A-Z]{3}$/u.test(code) && Number.isFinite(rate) && rate > 0) {
        rates.set(code, { rate, date: cleanText(item.exchangedate, 20) });
      }
    });
    const selected = command.currency === 'major' ? ['USD', 'EUR', 'PLN'] : [command.currency];
    const found = selected.flatMap((code) => {
      const entry = rates.get(code);
      return entry ? [{ code, ...entry }] : [];
    });
    if (!found.length) return { ok: false, text: '', reason: 'exchange-rate-unavailable' };
    const amount = command.currency === 'major' ? 1 : command.amount;
    const metrics = found.map((entry) => ({
      label: entry.code,
      value: `${formatNumber(entry.rate * amount)} ₴`,
    }));
    const date = found[0]?.date || '';
    const primary = found.length === 1 ? metrics[0]!.value : `${metrics[0]!.label} ${metrics[0]!.value}`;
    const summary = found.length === 1
      ? `${formatNumber(amount)} ${found[0]!.code}`
      : metrics.slice(1).map((metric) => `${metric.label} ${metric.value}`).join(' · ');
    const text = found.length === 1
      ? `${formatNumber(amount)} ${found[0]!.code} по официальному курсу НБУ — ${metrics[0]!.value}.`
      : `Официальный курс НБУ: доллар ${metrics[0]!.value}, евро ${metrics[1]?.value || 'нет данных'}, злотый ${metrics[2]?.value || 'нет данных'}.`;
    return {
      ok: true,
      text,
      card: {
        schemaVersion: 1,
        kind: 'exchange-rate',
        title: date ? `Курс НБУ · ${date}` : 'Курс НБУ',
        primary,
        summary,
        metrics: found.length === 1 ? [{ label: 'За 1 единицу', value: `${formatNumber(found[0]!.rate)} ₴` }] : metrics,
        provider: {
          name: 'НБУ',
          attribution: 'Официальные открытые данные НБУ',
          url: 'https://bank.gov.ua/ua/open-data/api-dev',
        },
        observedAt: new Date().toISOString(),
      },
    };
  }

  private async readJson(urlValue: string, outerSignal?: AbortSignal): Promise<Record<string, unknown> | unknown[]> {
    const url = new URL(urlValue);
    if (![
      'https://api.open-meteo.com',
      'https://geocoding-api.open-meteo.com',
      'https://customer-api.open-meteo.com',
      'https://customer-geocoding-api.open-meteo.com',
      'https://bank.gov.ua',
    ].includes(url.origin)) throw new Error('voice-information-provider-origin-denied');
    const controller = new AbortController();
    const abort = () => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('voice-information-provider-timeout')), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`voice-information-provider-http-${response.status}`);
      const text = await response.text();
      if (text.length > 512 * 1024) throw new Error('voice-information-provider-response-too-large');
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object') throw new Error('voice-information-provider-invalid-json');
      return parsed as Record<string, unknown> | unknown[];
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', abort);
    }
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArrayValue(value: unknown, index: number): string {
  return Array.isArray(value) ? cleanText(value[index], 40) : '';
}

function readFiniteArrayValue(value: unknown, index: number): number | null {
  if (!Array.isArray(value)) return null;
  const number = Number(value[index]);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value: unknown, maximum: number): string {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function roundTemperature(value: number): string {
  return String(Math.round(value));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}

function weatherCondition(code: number): string {
  if (code === 0) return 'Ясно';
  if ([1, 2].includes(code)) return 'Переменная облачность';
  if (code === 3) return 'Пасмурно';
  if ([45, 48].includes(code)) return 'Туман';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Морось';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Дождь';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Снег';
  if ([95, 96, 99].includes(code)) return 'Гроза';
  return 'Погода без уточнения';
}

function normalizeProviderBaseUrl(value: unknown, fallback: string, allowed: string[]): string {
  const candidate = cleanText(value, 200) || fallback;
  try {
    const url = new URL(candidate);
    if (url.pathname !== '/' || url.search || url.hash || !allowed.includes(url.origin)) return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

function locationQueryCandidates(value: string): string[] {
  const clean = cleanText(value, 100);
  const canonical = canonicalLocationName(clean);
  const aliases: Record<string, string> = {
    'київ': 'Киев',
    kyiv: 'Kiev',
    kiev: 'Kiev',
    'одесі': 'Одесса',
    'львові': 'Львов',
    'харкові': 'Харьков',
  };
  const candidates = [clean, aliases[canonical] || ''];
  const words = clean.split(/\s+/u);
  const last = words.at(-1) || '';
  const replacements = new Set<string>();
  if (/ии$/iu.test(last)) replacements.add(last.replace(/ии$/iu, 'ия'));
  if (/ссе$/iu.test(last)) replacements.add(last.replace(/е$/iu, 'а'));
  if (/ве$/iu.test(last)) replacements.add(last.replace(/е$/iu, ''));
  if (/же$/iu.test(last)) replacements.add(last.replace(/е$/iu, ''));
  if (/не$/iu.test(last)) replacements.add(last.replace(/е$/iu, ''));
  if (/ске$/iu.test(last)) replacements.add(last.replace(/е$/iu, ''));
  if (/ву$/iu.test(last)) replacements.add(last.replace(/у$/iu, 'а'));
  if (/вы$/iu.test(last)) replacements.add(last.replace(/ы$/iu, 'а'));
  if (/на$/iu.test(last)) replacements.add(last.replace(/а$/iu, ''));
  replacements.forEach((replacement) => candidates.push([...words.slice(0, -1), replacement].join(' ')));
  return [...new Set(candidates.map((entry) => cleanText(entry, 100)).filter((entry) => entry.length >= 2))].slice(0, 4);
}

function canonicalLocationName(value: unknown): string {
  return cleanText(value, 100)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
