from __future__ import annotations

from pathlib import Path
import sys

import httpx
import pytest


backend_dir = Path(__file__).resolve().parents[1]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from oscar_agent.voice_weather import (
    FORECAST_URL,
    GEOCODING_URL,
    MAX_GEOCODING_BYTES,
    OpenMeteoVoiceWeatherService,
    VoiceWeatherProviderError,
)


def _forecast_payload(**current_overrides):
    return {
        "current": {
            "temperature_2m": 21.4,
            "relative_humidity_2m": 58,
            "apparent_temperature": 20.2,
            "precipitation": 0,
            "weather_code": 2,
            "wind_speed_10m": 3.4,
            **current_overrides,
        },
        "daily": {
            "temperature_2m_max": [25.1],
            "temperature_2m_min": [14.3],
            "precipitation_probability_max": [20],
        },
    }


@pytest.mark.asyncio
async def test_open_meteo_voice_weather_uses_only_fixed_bounded_api_requests():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if str(request.url).startswith(GEOCODING_URL):
            assert dict(request.url.params) == {"name": "Киев", "count": "1", "language": "ru"}
            return httpx.Response(
                200,
                json={
                    "results": [{
                        "name": "Киев",
                        "admin1": "Киев",
                        "country": "Украина",
                        "latitude": 50.45,
                        "longitude": 30.52,
                    }],
                },
                headers={"content-type": "application/json"},
            )
        assert str(request.url).startswith(FORECAST_URL)
        assert request.url.params["latitude"] == "50.45"
        assert request.url.params["longitude"] == "30.52"
        assert request.url.params["current"] == (
            "temperature_2m,relative_humidity_2m,apparent_temperature,"
            "precipitation,weather_code,wind_speed_10m"
        )
        assert request.url.params["daily"] == (
            "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
        )
        assert request.url.params["timezone"] == "auto"
        assert request.url.params["forecast_days"] == "1"
        assert request.url.params["wind_speed_unit"] == "ms"
        return httpx.Response(
            200,
            json=_forecast_payload(),
            headers={"content-type": "application/json"},
        )

    service = OpenMeteoVoiceWeatherService(transport=httpx.MockTransport(handler))
    report = await service.current("  Киев  ")

    assert [request.url.host for request in requests] == [
        "geocoding-api.open-meteo.com",
        "api.open-meteo.com",
    ]
    assert report.location == "Киев, Украина"
    assert report.weather_code == 2
    assert report.render_ru() == (
        "Киев, Украина: сейчас +21,4 °C, ощущается как +20,2 °C. "
        "Переменная облачность. Влажность 58%, ветер 3,4 м/с, "
        "осадки 0 мм. Сегодня от +14,3 до +25,1 °C, вероятность осадков до 20%."
    )


@pytest.mark.parametrize(
    ("spoken_location", "geocoding_rows", "expected_queries", "expected_location"),
    [
        (
            "киеве",
            {
                "киеве": [{"name": "Киёвец", "country": "Беларусь", "latitude": 54.4, "longitude": 30.1}],
                "киев": [{"name": "Киев", "country": "Украина", "latitude": 50.45, "longitude": 30.52}],
            },
            ["киеве", "киев"],
            "Киев, Украина",
        ),
        (
            "москве",
            {
                "москва": [{"name": "Москва", "country": "Россия", "latitude": 55.75, "longitude": 37.62}],
            },
            ["москве", "москв", "москва"],
            "Москва, Россия",
        ),
        (
            "лондоне",
            {
                "лондон": [{"name": "Лондон", "country": "Великобритания", "latitude": 51.51, "longitude": -0.13}],
            },
            ["лондоне", "лондон"],
            "Лондон, Великобритания",
        ),
    ],
)
@pytest.mark.asyncio
async def test_open_meteo_voice_weather_recovers_ru_locative_without_accepting_wrong_first_hit(
    spoken_location,
    geocoding_rows,
    expected_queries,
    expected_location,
):
    queries: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).startswith(GEOCODING_URL):
            query = request.url.params["name"]
            queries.append(query)
            payload = {"results": geocoding_rows.get(query, [])}
        else:
            payload = _forecast_payload()
        return httpx.Response(200, json=payload, headers={"content-type": "application/json"})

    service = OpenMeteoVoiceWeatherService(transport=httpx.MockTransport(handler))
    report = await service.current(spoken_location)

    assert queries == expected_queries
    assert report.location == expected_location


def test_voice_weather_uses_unit_tokens_for_one_two_and_five():
    from oscar_agent.voice_weather import VoiceWeatherReport

    text = VoiceWeatherReport(
        location="Тест",
        temperature=1,
        apparent_temperature=2,
        relative_humidity=1,
        precipitation=5,
        weather_code=0,
        wind_speed=2,
        daily_max=5,
        daily_min=1,
        precipitation_probability_max=5,
    ).render_ru()

    assert "+1 °C" in text
    assert "ощущается как +2 °C" in text
    assert "Влажность 1%" in text
    assert "ветер 2 м/с" in text
    assert "осадки 5 мм" in text
    assert "до 5%" in text


@pytest.mark.asyncio
async def test_open_meteo_voice_weather_rejects_empty_location_before_network():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    service = OpenMeteoVoiceWeatherService(transport=httpx.MockTransport(handler))

    with pytest.raises(ValueError, match="1..120"):
        await service.current("   ")
    assert calls == 0


@pytest.mark.asyncio
async def test_open_meteo_voice_weather_rejects_redirects_and_oversized_responses():
    redirect = OpenMeteoVoiceWeatherService(
        transport=httpx.MockTransport(lambda _request: httpx.Response(
            302,
            headers={"location": "https://example.invalid/steal", "content-type": "application/json"},
        )),
    )
    with pytest.raises(VoiceWeatherProviderError, match="redirect"):
        await redirect.current("Киев")

    oversized = OpenMeteoVoiceWeatherService(
        transport=httpx.MockTransport(lambda _request: httpx.Response(
            200,
            content=b"{" + (b"x" * MAX_GEOCODING_BYTES) + b"}",
            headers={"content-type": "application/json"},
        )),
    )
    with pytest.raises(VoiceWeatherProviderError, match="too large"):
        await oversized.current("Киев")


@pytest.mark.asyncio
async def test_open_meteo_voice_weather_rejects_non_numeric_forecast_values():
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).startswith(GEOCODING_URL):
            payload = {"results": [{
                "name": "Киев",
                "country": "Украина",
                "latitude": 50.45,
                "longitude": 30.52,
            }]}
        else:
            payload = _forecast_payload(temperature_2m="twenty")
        return httpx.Response(200, json=payload, headers={"content-type": "application/json"})

    service = OpenMeteoVoiceWeatherService(transport=httpx.MockTransport(handler))
    with pytest.raises(VoiceWeatherProviderError, match="temperature_2m"):
        await service.current("Киев")
