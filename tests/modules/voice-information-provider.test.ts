import { describe, expect, it, vi } from 'vitest';
import { VoiceInformationProviderService } from '../../src/modules/voice';

describe('VoiceInformationProviderService', () => {
  it('resolves a city and returns a bounded attributed weather card', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
        return new Response(JSON.stringify({ results: [{
          name: 'Киев', admin1: 'Киев', country: 'Украина', latitude: 50.45, longitude: 30.52,
        }] }));
      }
      return new Response(JSON.stringify({ daily: {
        time: ['2026-08-29', '2026-08-30', '2026-08-31'],
        weather_code: [1, 61, 3],
        temperature_2m_max: [25.1, 19.6, 18],
        temperature_2m_min: [15, 12.2, 11],
        apparent_temperature_max: [25, 18.8, 17],
        precipitation_probability_max: [10, 70, 20],
        wind_speed_10m_max: [12, 24.2, 10],
      } }));
    });
    const service = new VoiceInformationProviderService(fetcher as typeof fetch);

    await expect(service.execute({
      schemaVersion: 1,
      kind: 'information',
      feature: 'weather',
      text: 'погода завтра',
      period: 'tomorrow',
      card: 'weather',
    }, { manualLocation: 'Киев' })).resolves.toMatchObject({
      ok: true,
      text: expect.stringContaining('вероятность осадков 70 процентов'),
      card: {
        kind: 'weather',
        title: 'Завтра · Киев, Украина',
        primary: '20° / 12°',
        summary: 'Дождь',
        provider: { name: 'Open-Meteo', attribution: expect.stringContaining('CC BY 4.0') },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses the official NBU table and calculates conversion locally', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([
      { cc: 'USD', rate: 41.25, exchangedate: '29.08.2026' },
      { cc: 'EUR', rate: 48.5, exchangedate: '29.08.2026' },
    ])));
    const service = new VoiceInformationProviderService(fetcher as typeof fetch);

    const result = await service.execute({
      schemaVersion: 1,
      kind: 'information',
      feature: 'exchange-rate',
      text: 'сколько 100 долларов в гривнах',
      currency: 'USD',
      amount: 100,
      card: 'exchange-rate',
    }, { manualLocation: '' });
    expect(result).toMatchObject({
      ok: true,
      text: expect.stringContaining('4 125 ₴'),
      card: {
        kind: 'exchange-rate',
        primary: '4 125 ₴',
        provider: { name: 'НБУ' },
      },
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json');
  });

  it('does not guess weather without either configured city or device coordinates', async () => {
    const fetcher = vi.fn();
    const service = new VoiceInformationProviderService(fetcher as typeof fetch);
    await expect(service.execute({
      schemaVersion: 1,
      kind: 'information',
      feature: 'weather',
      text: 'покажи погоду',
      period: 'today',
      card: 'weather',
    }, { manualLocation: '' })).resolves.toEqual({
      ok: false,
      text: '',
      reason: 'weather-location-required',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a fuzzy wrong city and retries a canonical Russian case form', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === 'geocoding-api.open-meteo.com') {
        const requested = url.searchParams.get('name');
        return new Response(JSON.stringify({ results: requested === 'Киеве'
          ? [{ name: 'Киёвец', admin1: 'Минская Область', latitude: 53.4, longitude: 27.2 }]
          : [{ name: 'Киев', country: 'Украина', latitude: 50.45, longitude: 30.52 }] }));
      }
      return new Response(JSON.stringify({ daily: {
        time: ['2026-08-29'], weather_code: [0], temperature_2m_max: [22], temperature_2m_min: [13],
      } }));
    });
    const service = new VoiceInformationProviderService(fetcher as typeof fetch);
    const result = await service.execute({
      schemaVersion: 1,
      kind: 'information',
      feature: 'weather',
      text: 'погода в Киеве',
      period: 'today',
      locationHint: 'Киеве',
      card: 'weather',
    }, { manualLocation: '' });
    expect(result.card?.title).toBe('Сегодня · Киев, Украина');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
