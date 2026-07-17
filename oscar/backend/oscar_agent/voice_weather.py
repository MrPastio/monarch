from __future__ import annotations

import asyncio
import json
import math
import re
from dataclasses import dataclass
from typing import Any

import httpx


GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
MAX_LOCATION_CHARS = 120
MAX_GEOCODING_BYTES = 64 * 1024
MAX_FORECAST_BYTES = 128 * 1024

_WMO_RU = {
    0: "ясно",
    1: "преимущественно ясно",
    2: "переменная облачность",
    3: "пасмурно",
    45: "туман",
    48: "изморозь и туман",
    51: "слабая морось",
    53: "морось",
    55: "сильная морось",
    56: "слабая ледяная морось",
    57: "сильная ледяная морось",
    61: "слабый дождь",
    63: "дождь",
    65: "сильный дождь",
    66: "слабый ледяной дождь",
    67: "сильный ледяной дождь",
    71: "слабый снег",
    73: "снег",
    75: "сильный снег",
    77: "снежная крупа",
    80: "слабый ливень",
    81: "ливень",
    82: "сильный ливень",
    85: "слабый снегопад",
    86: "сильный снегопад",
    95: "гроза",
    96: "гроза с небольшим градом",
    99: "гроза с сильным градом",
}


class VoiceWeatherError(RuntimeError):
    """Base error for the isolated deterministic weather provider."""


class VoiceWeatherLocationNotFound(VoiceWeatherError):
    pass


class VoiceWeatherProviderError(VoiceWeatherError):
    pass


@dataclass(frozen=True, slots=True)
class VoiceWeatherReport:
    location: str
    temperature: float
    apparent_temperature: float
    relative_humidity: float
    precipitation: float
    weather_code: int
    wind_speed: float
    daily_max: float
    daily_min: float
    precipitation_probability_max: float

    def render_ru(self) -> str:
        condition = _WMO_RU[self.weather_code]
        return (
            f"{self.location}: сейчас {_format_signed(self.temperature)} °C, "
            f"ощущается как {_format_signed(self.apparent_temperature)} °C. "
            f"{condition.capitalize()}. Влажность {_format_number(self.relative_humidity)}%, "
            f"ветер {_format_number(self.wind_speed)} м/с, "
            f"осадки {_format_number(self.precipitation)} мм. "
            f"Сегодня от {_format_signed(self.daily_min)} до {_format_signed(self.daily_max)} °C, "
            f"вероятность осадков до {_format_number(self.precipitation_probability_max)}%."
        )


class OpenMeteoVoiceWeatherService:
    """Two-request Open-Meteo client with no caller-controlled hosts or redirects."""

    def __init__(
        self,
        *,
        timeout_seconds: float = 4.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._timeout = httpx.Timeout(
            timeout_seconds,
            connect=min(timeout_seconds, 2.0),
            pool=min(timeout_seconds, 1.0),
        )
        self._overall_timeout_seconds = max(1.0, timeout_seconds + 1.0)
        self._transport = transport

    async def current(self, location: str) -> VoiceWeatherReport:
        clean_location = normalize_weather_location(location)
        try:
            return await asyncio.wait_for(
                self._current_bounded(clean_location),
                timeout=self._overall_timeout_seconds,
            )
        except TimeoutError as exc:
            raise VoiceWeatherProviderError("weather provider time limit exceeded") from exc

    async def _current_bounded(self, clean_location: str) -> VoiceWeatherReport:
        limits = httpx.Limits(max_connections=2, max_keepalive_connections=2)
        async with httpx.AsyncClient(
            timeout=self._timeout,
            limits=limits,
            follow_redirects=False,
            trust_env=False,
            transport=self._transport,
            headers={"Accept": "application/json", "Accept-Encoding": "identity"},
        ) as client:
            geocoded: tuple[float, float, str] | None = None
            for candidate in weather_location_candidates(clean_location):
                geocoding = await self._get_json(
                    client,
                    GEOCODING_URL,
                    {
                        "name": candidate,
                        "count": 1,
                        "language": "ru",
                    },
                    MAX_GEOCODING_BYTES,
                )
                geocoded = _parse_geocoding(geocoding, candidate)
                if geocoded is not None:
                    break
            if geocoded is None:
                raise VoiceWeatherLocationNotFound("weather location was not found")
            latitude, longitude, display_location = geocoded
            forecast = await self._get_json(
                client,
                FORECAST_URL,
                {
                    "latitude": latitude,
                    "longitude": longitude,
                    "current": (
                        "temperature_2m,relative_humidity_2m,apparent_temperature,"
                        "precipitation,weather_code,wind_speed_10m"
                    ),
                    "daily": (
                        "temperature_2m_max,temperature_2m_min,"
                        "precipitation_probability_max"
                    ),
                    "timezone": "auto",
                    "forecast_days": 1,
                    "wind_speed_unit": "ms",
                },
                MAX_FORECAST_BYTES,
            )
        return _parse_forecast(forecast, display_location)

    async def _get_json(
        self,
        client: httpx.AsyncClient,
        url: str,
        params: dict[str, Any],
        max_bytes: int,
    ) -> dict[str, Any]:
        if url not in {GEOCODING_URL, FORECAST_URL}:
            raise VoiceWeatherProviderError("weather host is not allowlisted")
        try:
            async with client.stream("GET", url, params=params) as response:
                if response.is_redirect:
                    raise VoiceWeatherProviderError("weather provider redirect rejected")
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").lower()
                if "application/json" not in content_type:
                    raise VoiceWeatherProviderError("weather provider returned non-JSON content")
                content_length = response.headers.get("content-length")
                if content_length:
                    try:
                        if int(content_length) > max_bytes:
                            raise VoiceWeatherProviderError("weather provider response is too large")
                    except ValueError as exc:
                        raise VoiceWeatherProviderError("invalid weather response length") from exc
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise VoiceWeatherProviderError("weather provider response is too large")
        except VoiceWeatherProviderError:
            raise
        except (httpx.HTTPError, TimeoutError) as exc:
            raise VoiceWeatherProviderError("weather provider request failed") from exc
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise VoiceWeatherProviderError("weather provider returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise VoiceWeatherProviderError("weather provider response must be an object")
        return payload


def normalize_weather_location(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("weather location must be a string")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("weather location contains control characters")
    cleaned = re.sub(r"\s+", " ", value).strip()
    if not cleaned or len(cleaned) > MAX_LOCATION_CHARS:
        raise ValueError("weather location must contain 1..120 characters")
    if not any(char.isalnum() for char in cleaned):
        raise ValueError("weather location must contain a letter or number")
    return cleaned


def weather_location_candidates(location: str) -> tuple[str, ...]:
    """Bounded RU locative recovery; every provider result still needs an exact name match."""
    candidates = [location]
    prefix, separator, last_word = location.rpartition(" ")
    stem_prefix = f"{prefix}{separator}" if separator else ""
    lowered = last_word.casefold().replace("ё", "е")
    variants: list[str] = []
    if len(last_word) > 3 and lowered.endswith("е"):
        variants.extend((last_word[:-1], f"{last_word[:-1]}а"))
    elif len(last_word) > 3 and lowered.endswith("и"):
        variants.extend((f"{last_word[:-1]}ь", f"{last_word[:-1]}я"))
    elif len(last_word) > 3 and lowered.endswith("у"):
        variants.append(f"{last_word[:-1]}а")
    for variant in variants:
        candidate = f"{stem_prefix}{variant}".strip()
        if candidate and _location_key(candidate) not in {_location_key(item) for item in candidates}:
            candidates.append(candidate)
        if len(candidates) == 3:
            break
    return tuple(candidates)


def _parse_geocoding(payload: dict[str, Any], candidate: str) -> tuple[float, float, str] | None:
    results = payload.get("results")
    if results is None:
        return None
    if not isinstance(results, list):
        raise VoiceWeatherProviderError("invalid geocoding results")
    if not results:
        return None
    row = results[0]
    if not isinstance(row, dict):
        raise VoiceWeatherProviderError("invalid geocoding result")
    name = _bounded_label(row.get("name"), "location name")
    if _location_key(name) != _location_key(candidate):
        return None
    latitude = _number(row.get("latitude"), "latitude", minimum=-90, maximum=90)
    longitude = _number(row.get("longitude"), "longitude", minimum=-180, maximum=180)
    admin = _optional_label(row.get("admin1"))
    country = _optional_label(row.get("country"))
    labels: list[str] = []
    for label in (name, admin, country):
        if label and label.casefold() not in {item.casefold() for item in labels}:
            labels.append(label)
    return latitude, longitude, ", ".join(labels[:3])


def _parse_forecast(payload: dict[str, Any], location: str) -> VoiceWeatherReport:
    current = payload.get("current")
    daily = payload.get("daily")
    if not isinstance(current, dict) or not isinstance(daily, dict):
        raise VoiceWeatherProviderError("weather response is missing current or daily data")
    weather_code_number = _number(current.get("weather_code"), "weather_code", minimum=0, maximum=99)
    weather_code = int(weather_code_number)
    if weather_code_number != weather_code or weather_code not in _WMO_RU:
        raise VoiceWeatherProviderError("weather response contains an unsupported WMO code")
    daily_max = _daily_number(daily, "temperature_2m_max", minimum=-100, maximum=70)
    daily_min = _daily_number(daily, "temperature_2m_min", minimum=-100, maximum=70)
    if daily_min > daily_max:
        raise VoiceWeatherProviderError("weather response contains an invalid daily temperature range")
    return VoiceWeatherReport(
        location=location,
        temperature=_number(current.get("temperature_2m"), "temperature_2m", minimum=-100, maximum=70),
        apparent_temperature=_number(
            current.get("apparent_temperature"),
            "apparent_temperature",
            minimum=-120,
            maximum=80,
        ),
        relative_humidity=_number(
            current.get("relative_humidity_2m"),
            "relative_humidity_2m",
            minimum=0,
            maximum=100,
        ),
        precipitation=_number(current.get("precipitation"), "precipitation", minimum=0, maximum=1000),
        weather_code=weather_code,
        wind_speed=_number(current.get("wind_speed_10m"), "wind_speed_10m", minimum=0, maximum=150),
        daily_max=daily_max,
        daily_min=daily_min,
        precipitation_probability_max=_daily_number(
            daily,
            "precipitation_probability_max",
            minimum=0,
            maximum=100,
        ),
    )


def _daily_number(payload: dict[str, Any], key: str, *, minimum: float, maximum: float) -> float:
    values = payload.get(key)
    if not isinstance(values, list) or len(values) != 1:
        raise VoiceWeatherProviderError(f"weather response contains invalid {key}")
    return _number(values[0], key, minimum=minimum, maximum=maximum)


def _number(value: Any, name: str, *, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise VoiceWeatherProviderError(f"weather response contains invalid {name}")
    number = float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise VoiceWeatherProviderError(f"weather response contains invalid {name}")
    return number


def _bounded_label(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise VoiceWeatherProviderError(f"weather response contains invalid {name}")
    cleaned = re.sub(r"\s+", " ", value).strip()
    if not cleaned or len(cleaned) > 120 or any(ord(char) < 32 or ord(char) == 127 for char in cleaned):
        raise VoiceWeatherProviderError(f"weather response contains invalid {name}")
    return cleaned


def _optional_label(value: Any) -> str:
    if value is None:
        return ""
    return _bounded_label(value, "location label")


def _location_key(value: str) -> str:
    return "".join(char for char in value.casefold().replace("ё", "е") if char.isalnum())


def _format_number(value: float) -> str:
    rounded = float(round(value, 1))
    if rounded.is_integer():
        return str(int(rounded))
    return f"{rounded:.1f}".replace(".", ",")


def _format_signed(value: float) -> str:
    if value > 0:
        return f"+{_format_number(value)}"
    return _format_number(value)
