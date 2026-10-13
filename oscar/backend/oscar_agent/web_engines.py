"""Keyless web search across several engines, routed around the ones that fail.

Free search engines refuse scrapers without warning: on one machine Google,
DuckDuckGo, Brave, Mojeek and Startpage all answered "No results found" in
0.2 s while Yandex and Yahoo kept working. Asking one engine at random, as the
ddgs "auto" backend does, made every search a lottery. The router asks two or
three engines that have been working, fuses their results (agreement between
engines ranks a page higher), rests an engine that fails with a growing pause,
and keeps recent answers for a few minutes. Nothing here needs a key, so it
works the same for every person.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Callable

logger = logging.getLogger(__name__)

# Order measured on 2026-10-05: engines that answered most often come first.
# Grokipedia is left out: a generated encyclopedia is not a source.
TEXT_ENGINES_CYRILLIC = ("yandex", "yahoo", "duckduckgo", "google", "brave", "startpage", "mojeek", "wikipedia")
TEXT_ENGINES_LATIN = ("duckduckgo", "google", "yahoo", "brave", "startpage", "yandex", "mojeek", "wikipedia")
NEWS_ENGINES = ("bing", "yahoo", "duckduckgo")
FIRST_WAVE = 3
SECOND_WAVE = 2
ENOUGH_RESULTS = 3
CACHE_SECONDS = 300.0
CACHE_ENTRIES = 256
REST_BASE_SECONDS = 30.0
REST_MAX_SECONDS = 1800.0
RRF_K = 60

Runner = Callable[[str, str, str, str, "str | None", int], list[dict]]


class NoResults(Exception):
    """The engine answered, but with nothing."""


def default_runner(timeout: float) -> Runner:
    def run(category: str, engine: str, query: str, region: str, timelimit: str | None, max_results: int) -> list[dict]:
        from ddgs import DDGS
        from ddgs.exceptions import DDGSException

        try:
            with DDGS(timeout=timeout) as ddgs:
                search = ddgs.news if category == "news" else ddgs.text
                return list(search(query, max_results=max_results, safesearch="moderate", region=region,
                                   backend=engine, **({"timelimit": timelimit} if timelimit else {})))
        except DDGSException as exc:
            if "no results" in str(exc).casefold():
                raise NoResults() from None
            raise
    return run


@dataclass
class EngineHealth:
    failures: int = 0
    resting_until: float = 0.0


class EngineRouter:
    def __init__(self, timeout: float = 5.0, runner: Runner | None = None, clock: Callable[[], float] = time.monotonic):
        self.timeout = timeout
        self.runner = runner or default_runner(timeout)
        self.clock = clock
        self.health: dict[str, EngineHealth] = {}
        self.cache: OrderedDict[tuple, tuple[float, list[dict]]] = OrderedDict()
        # Engines that answered "nothing" in a wave where nobody answered:
        # an empty query, or all of them refusing at once. Wikipedia finding
        # results for the same query tells which (confirm_refusals).
        self.unconfirmed_empty: dict[str, float] = {}
        self.lock = threading.Lock()

    def search(self, category: str, query: str, *, max_results: int = 10, timelimit: str | None = None) -> list[dict]:
        cyrillic = bool(re.search(r"[А-Яа-яЁё]", query))
        region = "ru-ru" if cyrillic else "us-en"
        key = (category, query.casefold(), region, timelimit, max_results)
        with self.lock:
            cached = self.cache.get(key)
            if cached and self.clock() - cached[0] < CACHE_SECONDS:
                self.cache.move_to_end(key)
                return list(cached[1])
        order = NEWS_ENGINES if category == "news" else TEXT_ENGINES_CYRILLIC if cyrillic else TEXT_ENGINES_LATIN
        candidates = self._ready(order)
        rankings: list[list[dict]] = []
        asked: set[str] = set()
        first = candidates if category == "news" else candidates[:FIRST_WAVE]
        rankings += self._wave(category, first, query, region, timelimit, max_results)
        asked.update(first)
        if len(fuse(rankings)) < ENOUGH_RESULTS:
            more = [engine for engine in candidates if engine not in asked][:SECOND_WAVE]
            if more:
                rankings += self._wave(category, more, query, region, timelimit, max_results)
        results = fuse(rankings)[:max_results]
        if results:
            with self.lock:
                self.cache[key] = (self.clock(), results)
                self.cache.move_to_end(key)
                while len(self.cache) > CACHE_ENTRIES:
                    self.cache.popitem(last=False)
        return results

    def confirm_refusals(self, within: float = 60.0) -> None:
        """An independent source found results where the engines found none: they refused."""
        now = self.clock()
        with self.lock:
            engines = [engine for engine, at in self.unconfirmed_empty.items() if now - at <= within]
            self.unconfirmed_empty.clear()
        for engine in engines:
            self._failed(engine, "empty while Wikipedia answered")

    def all_resting(self) -> bool:
        """True when every web engine is resting after refusing: search is down, not empty."""
        now = self.clock()
        with self.lock:
            return all(self.health.get(engine, EngineHealth()).resting_until > now
                       for engine in set(TEXT_ENGINES_LATIN) | set(TEXT_ENGINES_CYRILLIC))

    def _ready(self, order: tuple[str, ...]) -> list[str]:
        now = self.clock()
        with self.lock:
            ready = [engine for engine in order if self.health.get(engine, EngineHealth()).resting_until <= now]
            if ready:
                return ready
            # Every engine is resting: ask the one whose rest ends first rather than nothing.
            return [min(order, key=lambda engine: self.health.get(engine, EngineHealth()).resting_until)]

    def _wave(self, category: str, engines: list[str], query: str, region: str,
              timelimit: str | None, max_results: int) -> list[list[dict]]:
        outcomes: dict[str, list[dict] | Exception] = {}
        pool = ThreadPoolExecutor(max_workers=len(engines), thread_name_prefix="web-engine")
        try:
            futures = {pool.submit(self.runner, category, engine, query, region, timelimit, max_results): engine
                       for engine in engines}
            done, _pending = wait(futures, timeout=self.timeout + 1.0)
            for future, engine in futures.items():
                if future not in done:
                    outcomes[engine] = TimeoutError("engine-timeout")
                    continue
                try:
                    outcomes[engine] = future.result() or []
                except Exception as exc:  # noqa: BLE001 - any engine failure only rests that engine
                    outcomes[engine] = exc
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

        someone_found = any(isinstance(rows, list) and rows for rows in outcomes.values())
        rankings: list[list[dict]] = []
        for engine, outcome in outcomes.items():
            if isinstance(outcome, list) and outcome:
                self._succeeded(engine)
                rankings.append(outcome)
            elif isinstance(outcome, NoResults) or (isinstance(outcome, list) and not outcome):
                # "Nothing" while another engine found plenty is a refusal; when
                # every engine found nothing, the query is simply empty.
                if someone_found:
                    self._failed(engine, "empty while others answered")
                else:
                    with self.lock:
                        self.unconfirmed_empty[engine] = self.clock()
            else:
                self._failed(engine, type(outcome).__name__)
        return rankings

    def _succeeded(self, engine: str) -> None:
        with self.lock:
            self.health[engine] = EngineHealth()

    def _failed(self, engine: str, reason: str) -> None:
        with self.lock:
            health = self.health.setdefault(engine, EngineHealth())
            health.failures += 1
            rest = min(REST_MAX_SECONDS, REST_BASE_SECONDS * 4 ** (health.failures - 1))
            health.resting_until = self.clock() + rest
        logger.info("Search engine %s rests %.0f s: %s", engine, rest, reason)


def fuse(rankings: list[list[dict]]) -> list[dict]:
    """Reciprocal rank fusion: a page several engines rank high comes first."""
    scores: dict[str, float] = {}
    best: dict[str, dict] = {}
    for ranking in rankings:
        for rank, row in enumerate(ranking):
            url = str(row.get("href") or row.get("url") or "").strip()
            if not url:
                continue
            key = url.rstrip("/").casefold()
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + rank + 1)
            kept = best.get(key)
            if kept is None or len(str(row.get("body") or "")) > len(str(kept.get("body") or "")):
                best[key] = row
    return [best[key] for key in sorted(scores, key=lambda item: -scores[item])]
