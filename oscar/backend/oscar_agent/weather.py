"""Exact weather for a named place, from Open-Meteo (no key, public data).

A weather question answered from web pages picks whichever regional weather
site ranks first: "погода в Варне на завтра" came back with a Russian city.
Here the place is geocoded and the forecast is taken from a forecast service,
so the answer carries the place, the dates and the numbers it is based on.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

import httpx

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# Words that end a place name in a question: time words, prepositions, fillers.
_STOP_WORDS = {
    "на", "в", "во", "для", "и", "а", "сегодня", "завтра", "послезавтра", "сейчас", "утром", "днём", "днем",
    "вечером", "ночью", "неделю", "неделе", "выходные", "будет", "какая", "какой", "какие", "погода", "погоду",
    "прогноз", "температура", "today", "tomorrow", "now", "this", "week", "weekend", "weather", "forecast", "in",
    "at", "for", "the",
}

WMO_TEXT = {
    0: "ясно", 1: "преимущественно ясно", 2: "переменная облачность", 3: "пасмурно",
    45: "туман", 48: "изморозь", 51: "слабая морось", 53: "морось", 55: "сильная морось",
    56: "ледяная морось", 57: "сильная ледяная морось", 61: "небольшой дождь", 63: "дождь", 65: "сильный дождь",
    66: "ледяной дождь", 67: "сильный ледяной дождь", 71: "небольшой снег", 73: "снег", 75: "сильный снег",
    77: "снежная крупа", 80: "ливни", 81: "сильные ливни", 82: "очень сильные ливни", 85: "снегопад",
    86: "сильный снегопад", 95: "гроза", 96: "гроза с градом", 99: "сильная гроза с градом",
}


def extract_place(query: str) -> str | None:
    """The place named after 'в/во/для/in/at' (or before 'weather'), as typed."""
    text = re.sub(r"[?!.,;:«»\"()]", " ", query or "")
    words = text.split()
    for index, word in enumerate(words):
        if word.lower() in {"в", "во", "для", "in", "at"} and index + 1 < len(words):
            place: list[str] = []
            for candidate in words[index + 1:index + 4]:
                if candidate.lower() in _STOP_WORDS:
                    break
                place.append(candidate)
            if place and place[0][:1].isupper():
                return " ".join(place)
    return None


def place_candidates(place: str) -> list[str]:
    """Russian questions put the city in the locative case: 'в Варне' is Варна.
    Try the word as typed, then the usual nominative forms."""
    candidates = [place]
    last = place.split()[-1]
    head = place[: len(place) - len(last)]
    lower = last.lower()
    if lower.endswith("е") and len(last) > 3:
        stem = last[:-1]
        candidates += [head + stem + "а", head + stem + "я", head + stem, head + stem + "о"]
    if lower.endswith("и") and len(last) > 3:
        stem = last[:-1]
        candidates += [head + stem + "я", head + stem + "а", head + stem + "ь"]
    if lower.endswith("у") and len(last) > 3:
        candidates += [head + last[:-1] + "а"]
    seen: set[str] = set()
    return [item for item in candidates if not (item.lower() in seen or seen.add(item.lower()))]


def requested_day(query: str) -> int:
    lowered = (query or "").lower()
    if "послезавтра" in lowered or "day after tomorrow" in lowered:
        return 2
    if "завтра" in lowered or "tomorrow" in lowered:
        return 1
    return 0


async def geocode(client: httpx.AsyncClient, place: str) -> dict[str, Any] | None:
    """Best match over every case form: an exact name beats a prefix match
    ('Варне' also finds Warnemünde), then the most populated place wins."""
    candidates = place_candidates(place)
    wanted = {item.lower() for item in candidates}
    found: list[dict[str, Any]] = []
    for candidate in candidates:
        language = "ru" if re.search("[Ѐ-ӿ]", candidate) else "en"
        response = await _get(client, GEOCODE_URL, {"name": candidate, "count": 10, "language": language, "format": "json"})
        if response.status_code < 400:
            found.extend((response.json() or {}).get("results") or [])
    if not found:
        return None
    return max(found, key=lambda item: (str(item.get("name") or "").lower() in wanted, int(item.get("population") or 0)))


async def _get(client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> httpx.Response:
    """One retry for a transient connect failure; public forecast hosts only."""
    try:
        return await client.get(url, params=params)
    except (httpx.ConnectTimeout, httpx.ConnectError, httpx.ReadTimeout):
        return await client.get(url, params=params)


def _day_label(offset: int, day: str) -> str:
    return {0: "сегодня", 1: "завтра", 2: "послезавтра"}.get(offset, day)


async def weather_forecast_text(query: str, *, timeout_seconds: float = 6.0) -> tuple[str, str, str] | None:
    """(title, url, text) for the named place, or None when no place is named."""
    place = extract_place(query)
    if not place:
        return None
    async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=False) as client:
        location = await geocode(client, place)
        if not location:
            return None
        params = {
            "latitude": location["latitude"], "longitude": location["longitude"], "timezone": "auto",
            "forecast_days": 4,
            "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
        }
        response = await _get(client, FORECAST_URL, params)
        response.raise_for_status()
        data = response.json()
    name = ", ".join(part for part in (location.get("name"), location.get("admin1"), location.get("country")) if part)
    daily = data.get("daily") or {}
    days = daily.get("time") or []
    lines = [f"Прогноз Open-Meteo для: {name} (широта {location['latitude']:.2f}, долгота {location['longitude']:.2f}; "
             f"часовой пояс {data.get('timezone', '')})."]
    current = data.get("current") or {}
    if current and requested_day(query) == 0:
        lines.append(f"Сейчас ({current.get('time', '')}): {current.get('temperature_2m')}°C, ощущается как "
                     f"{current.get('apparent_temperature')}°C, {WMO_TEXT.get(int(current.get('weather_code') or 0), 'без описания')}, "
                     f"ветер {current.get('wind_speed_10m')} км/ч.")
    for offset, day in enumerate(days[:4]):
        code = int((daily.get("weather_code") or [0])[offset] or 0)
        lines.append(
            f"{_day_label(offset, day)} ({day}): от {daily['temperature_2m_min'][offset]} до {daily['temperature_2m_max'][offset]}°C, "
            f"{WMO_TEXT.get(code, 'без описания')}, вероятность осадков до {daily['precipitation_probability_max'][offset]}%, "
            f"ветер до {daily['wind_speed_10m_max'][offset]} км/ч.")
    target = requested_day(query)
    if target < len(days):
        lines.append(f"Спрошенный день: {_day_label(target, days[target])} ({days[target]}).")
    url = f"https://open-meteo.com/en/docs#latitude={location['latitude']}&longitude={location['longitude']}"
    return f"Прогноз погоды: {name}", url, " ".join(lines)


def today_iso() -> str:
    return date.today().isoformat()


def tomorrow_iso() -> str:
    return (date.today() + timedelta(days=1)).isoformat()
