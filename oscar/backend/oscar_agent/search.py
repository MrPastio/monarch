from __future__ import annotations

import asyncio
import html
import logging
import math
import re
import socket
import ipaddress
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import parse_qs, parse_qsl, quote, quote_plus, urlencode, urljoin, urlparse

import httpx

from .config import Settings
from .memory import MemoryStore, normalize_text
from .research import has_freshness_signal, has_live_weather_signal, resolve_research_decision, fallback_research_queries
from .schemas import SearchResult
from .network_policy import is_public_address, public_async_transport
from .search_privacy import engine_query
from .web_engines import EngineRouter

MAX_SEARCH_QUERY_CHARS = 2048
MAX_SEARCH_URL_CHARS = 4096


def is_safe_ip(ip_str: str) -> bool:
    return is_public_address(ip_str)

def is_safe_url(url: str) -> bool:
    try:
        if not isinstance(url, str) or not url or len(url) > MAX_SEARCH_URL_CHARS:
            return False
        if any(ord(char) < 32 or ord(char) == 127 for char in url):
            return False
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            return False
        if parsed.username is not None or parsed.password is not None:
            return False
        
        host = parsed.hostname
        if not host:
            return False
            
        try:
            ipaddress.ip_address(host)
            return is_safe_ip(host)
        except ValueError:
            pass
            
        addr_info = socket.getaddrinfo(
            host,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
        if not addr_info:
            return False
        for info in addr_info:
            ip = info[4][0]
            if not is_safe_ip(ip):
                return False
        return True
    except Exception:
        return False


async def is_safe_url_async(url: str) -> bool:
    return await asyncio.to_thread(is_safe_url, url)


logger = logging.getLogger(__name__)

MAX_PROVIDER_RESULTS = 10
FETCH_CONCURRENCY = 5
# Characters of relevant page passages one source contributes to an answer.
STANDARD_SOURCE_CHARS = 4000
DEEP_SOURCE_CHARS = 2400
ZERO_RETENTION_SOURCE_CHARS = 1800
MAX_DEEP_CONTEXT_SOURCES = 14
PASSAGE_CHARS = 420
EVIDENCE_PAGE_DEADLINE_SECONDS = 8.0
# Wikimedia refuses clients without a contact link (403, robot policy).
WIKIPEDIA_USER_AGENT = "Monarch/0.3 (https://github.com/MrPastio/monarch-releases) Oscar search fallback"
TRANSIENT_HTTP_ERRORS = (
    httpx.ReadTimeout,
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.RemoteProtocolError,
)
TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "gbraid",
    "wbraid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "msclkid",
}

EXPLICIT_WEB_PATTERN = re.compile(
    r"(?:^\s*(?:найди|поищи)\b|"
    r"\b(?:search|find|look\s*up|browse|google)\b|"
    r"\b(?:web|online|internet)\b|"
    r"(?:найди|поищи|проверь|посмотри).{0,36}(?:в\s+сети|в\s+интернете|на\s+сайте|сайт|онлайн)|"
    r"(?:в\s+сети|в\s+интернете|на\s+сайте|веб[- ]?поиск|поищи|загугли))",
    re.IGNORECASE,
)
WEB_LOCATION_PATTERN = re.compile(
    r"(?:\b(?:web|online|internet|website|site)\b|"
    r"в\s+сети|в\s+интернете|на\s+сайте|веб[- ]?поиск|онлайн)",
    re.IGNORECASE,
)
LOCAL_SEARCH_TARGET_PATTERN = re.compile(
    r"(?:\b(?:file|folder|project|repo(?:sitory)?|code|workspace|memory|conversation|"
    r"chat\s+history|branch|process|installed)\b|"
    r"файл|папк|проект|репозитор|код|workspace|памят|переписк|истори\w*\s+чат|"
    r"ветк\w*\s+git|процесс|установлен|баг|ошибк|тест)",
    re.IGNORECASE,
)
PUBLIC_PRODUCT_PATTERN = re.compile(
    r"(?:\b(?:gpt|chatgpt|openai|gemini|claude|windows|android|ios|macos|cuda|python|node(?:\.js)?|"
    r"react|electron)\b.{0,32}\b\d+(?:\.\d+){0,2}\b)",
    re.IGNORECASE,
)


class UnsafeFetchError(ValueError):
    pass


class FetchSizeLimitError(ValueError):
    pass


@dataclass(slots=True)
class RawSearchResult:
    title: str
    url: str
    snippet: str = ""
    # Data from a service (a forecast), complete as it is. Its link is for the
    # reader; fetching it would replace the data with that page.
    service_data: bool = False
    published: str = ""
    origin: str = "engine"


class SearchProvider(Protocol):
    async def search(self, query: str, max_results: int) -> list[RawSearchResult]:
        ...


# One router for the process: which engines are resting is learnt across requests.
WEB_ENGINES = EngineRouter(timeout=5.0)


class DuckDuckGoProvider:
    def __init__(self, timeout_seconds: float):
        self.timeout_seconds = timeout_seconds
        self.headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        }

    async def search(self, query: str, max_results: int) -> list[RawSearchResult]:
        # Every engine query leaves through here: shortened and without identifiers
        # unless the person turned cleaning off in Monarch Security.
        query = engine_query(query)
        if not query:
            return []
        # "Latest news" asked of a general web index returned encyclopedia pages
        # instead of news. Recency questions go to the dated news index first,
        # then to web results limited to the last month.
        if has_recency_signal(query):
            try:
                # The Russian news index answered "новости SpaceX" with Kia and
                # Latvia: a story that names nothing from the request is dropped.
                results = [item for item in await asyncio.to_thread(self._news_sync, query, max_results)
                           if mentions_subject(item, query)]
                if len(results) >= 2:
                    return results
            except Exception as exc:
                logger.warning("DDGS news search failed; using recent web results: %s", type(exc).__name__)
            try:
                results = await asyncio.to_thread(self._search_sync, query, max_results, "auto", "m")
                if results:
                    return results
            except Exception as exc:
                logger.warning("DDGS recent web search failed: %s", type(exc).__name__)
        try:
            results = await asyncio.to_thread(self._search_sync, query, max_results)
            if results:
                return results
        except Exception as exc:
            logger.warning("DDGS search failed; falling back to DuckDuckGo HTML: %s", type(exc).__name__)

        results = await asyncio.to_thread(self._duckduckgo_html, query, max_results)
        if results:
            return results
        # Every engine refused. Wikipedia's own search is open to everyone and
        # rarely refuses; the answer then says it rests on Wikipedia alone.
        results = await asyncio.to_thread(self._wikipedia_sync, query, max_results)
        if results:
            WEB_ENGINES.confirm_refusals()
        return results

    def _wikipedia_sync(self, query: str, max_results: int) -> list[RawSearchResult]:
        language = "ru" if re.search(r"[А-Яа-яЁё]", query) else "en"
        try:
            with httpx.Client(timeout=self.timeout_seconds, follow_redirects=False, trust_env=False) as client:
                response = client.get(
                    f"https://{language}.wikipedia.org/w/api.php",
                    params={"action": "query", "list": "search", "srsearch": query, "srlimit": max(1, min(max_results, 5)),
                            "format": "json", "utf8": 1},
                    headers={"User-Agent": WIKIPEDIA_USER_AGENT, "Accept": "application/json"},
                )
                response.raise_for_status()
                rows = response.json().get("query", {}).get("search", [])
        except Exception as exc:
            logger.warning("Wikipedia search failed: %s", type(exc).__name__)
            return []
        results: list[RawSearchResult] = []
        for row in rows:
            title = str(row.get("title") or "").strip()
            if not title:
                continue
            snippet = normalize_text(_soup(str(row.get("snippet") or ""), "html.parser").get_text(" "))
            results.append(RawSearchResult(
                title=clean_title(title),
                url=f"https://{language}.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}",
                snippet=snippet,
                origin="wikipedia",
            ))
        return results[:max_results]

    async def search_voice_officeholder(self, query: str, max_results: int) -> list[RawSearchResult]:
        """Use DDGS' focused Wikipedia backend for a bounded current-role fact."""
        query = engine_query(query)
        if not query:
            return []
        return await asyncio.to_thread(
            self._search_sync,
            query,
            max_results,
            "wikipedia",
        )

    def _news_sync(self, query: str, max_results: int) -> list[RawSearchResult]:
        # A week is often too short outside English; the month is a second window.
        rows: list[dict] = []
        for timelimit in ("w", "m"):
            rows.extend(WEB_ENGINES.search("news", query, max_results=max_results, timelimit=timelimit))
            if len(rows) >= 3:
                break
        results: list[RawSearchResult] = []
        for row in sorted(rows, key=lambda item: iso_date(item.get("date")), reverse=True):
            url = normalize_result_url(row.get("url") or row.get("href") or "")
            if not url:
                continue
            date = iso_date(row.get("date"))
            source = normalize_text(str(row.get("source") or ""))
            prefix = " · ".join(part for part in (date, source) if part)
            snippet = normalize_text(row.get("body") or "")
            results.append(RawSearchResult(
                title=clean_title(row.get("title") or readable_domain(url)),
                url=url,
                snippet=f"[{prefix}] {snippet}" if prefix else snippet,
                published=date,
            ))
        return unique_results(results)[:max_results]

    def _search_sync(
        self,
        query: str,
        max_results: int,
        backend: str = "auto",
        timelimit: str | None = None,
    ) -> list[RawSearchResult]:
        if backend == "auto":
            rows = WEB_ENGINES.search("text", query, max_results=max_results, timelimit=timelimit)
        else:
            from ddgs import DDGS

            timeout = max(2, min(5, int(self.timeout_seconds)))
            region = "ru-ru" if re.search(r"[А-Яа-яЁё]", query) else "us-en"
            with DDGS(timeout=timeout) as ddgs:
                rows = list(ddgs.text(query, max_results=max_results, safesearch="moderate", region=region,
                                      backend=backend, **({"timelimit": timelimit} if timelimit else {})))

        results: list[RawSearchResult] = []
        for row in rows:
            url = normalize_result_url(row.get("href") or row.get("url") or "")
            if not url:
                continue
            results.append(
                RawSearchResult(
                    title=clean_title(row.get("title") or row.get("body") or readable_domain(url)),
                    url=url,
                    snippet=normalize_text(row.get("body") or ""),
                )
            )

        return unique_results(results)[:max_results]

    def _duckduckgo_html(self, query: str, max_results: int) -> list[RawSearchResult]:
        url = f"https://duckduckgo.com/html/?q={quote_plus(query)}"
        try:
            with httpx.Client(timeout=self.timeout_seconds, follow_redirects=True, trust_env=False) as client:
                response = client.get(url, headers=self.headers)
                response.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("DuckDuckGo HTML search failed: %s", type(exc).__name__)
            return []

        soup = _soup(response.text, "html.parser")
        results: list[RawSearchResult] = []

        for result in soup.select(".result, .web-result"):
            link = result.select_one(".result__a") or result.select_one("a[href]")
            if not link:
                continue

            result_url = normalize_result_url(link.get("href") or "")
            if not result_url:
                continue

            snippet_node = result.select_one(".result__snippet") or result.select_one(".result__body")
            results.append(
                RawSearchResult(
                    title=clean_title(link.get_text(" ", strip=True) or readable_domain(result_url)),
                    url=result_url,
                    snippet=normalize_text(snippet_node.get_text(" ", strip=True) if snippet_node else ""),
                )
            )

            if len(results) >= max_results:
                break

        return unique_results(results)[:max_results]


class WebSearchService:
    def __init__(self, settings: Settings, memory: MemoryStore, search_provider: SearchProvider | None = None):
        self.settings = settings
        self.memory = memory
        self.search_provider = search_provider or DuckDuckGoProvider(settings.fetch_timeout_seconds)
        self.semaphore = asyncio.Semaphore(FETCH_CONCURRENCY)
        self.client_headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36 OscarLocalAgent/0.1 "
                # Wikimedia answers 403 to clients without a contact link.
                "(+https://github.com/MrPastio/monarch-releases)"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        }

    async def search_and_ingest(
        self,
        query: str,
        max_results: int | None = None,
        fetch_pages: bool = True,
        persist: bool = True,
        subject: str = "",
    ) -> list[SearchResult]:
        """``subject``: the question a research branch serves; results that name
        none of its subjects are dropped before anything is fetched or kept."""
        query = normalize_search_query(query)
        if not query:
            return []

        limit = clamp_result_limit(max_results or self.settings.search_top_k)
        safe_raw_results = await self._collect_safe_results(query, limit)
        if subject:
            safe_raw_results = on_subject(safe_raw_results, subject)
        results = [SearchResult(title=item.title, url=item.url, snippet=item.snippet, published=item.published,
                                origin=item.origin) for item in safe_raw_results]
        service_urls = {item.url for item in safe_raw_results if item.service_data}

        if not persist:
            for result in results:
                result.ingestion_status = "skipped"
                result.status_detail = "zero-retention"
            if not fetch_pages:
                return results
            timeout = httpx.Timeout(self.settings.fetch_timeout_seconds)
            limits = httpx.Limits(max_connections=FETCH_CONCURRENCY, max_keepalive_connections=FETCH_CONCURRENCY)
            async with httpx.AsyncClient(
                timeout=timeout,
                transport=public_async_transport(limits=limits),
                follow_redirects=False,
                headers=self.client_headers,
                trust_env=False,
            ) as client:
                return await asyncio.gather(*(
                    self._service_result(result) if result.url in service_urls
                    else self._fetch_evidence(client, result, query, ZERO_RETENTION_SOURCE_CHARS)
                    for result in results
                ))

        if not fetch_pages:
            for result in results:
                self._ingest_snippet(result, "provider-snippet")
            return results

        timeout = httpx.Timeout(self.settings.fetch_timeout_seconds)
        limits = httpx.Limits(max_connections=FETCH_CONCURRENCY, max_keepalive_connections=FETCH_CONCURRENCY)
        async with httpx.AsyncClient(
            timeout=timeout,
            transport=public_async_transport(limits=limits),
            follow_redirects=False,
            headers=self.client_headers,
            trust_env=False,
        ) as client:
            tasks = [
                self._service_result(result) if result.url in service_urls
                else self._fetch_and_ingest(client, result)
                for result in results
            ]
            return await asyncio.gather(*tasks)

    async def _service_result(self, result: SearchResult) -> SearchResult:
        result.status_detail = "service-data"
        return result

    async def search_context(
        self,
        query: str,
        deep: bool = False,
        planned: list[str] | None = None,
    ) -> list[SearchResult]:
        """Bounded public evidence for an external answer model; never write memory.

        Each page contributes the passages that match the question, not its
        first lines: a 900-character page head left the model answering from
        menus, cookie notices and search snippets.
        """
        planned = [item for item in (planned or []) if normalize_text(item)][:3]
        decision = resolve_research_decision(query, "deep" if deep else "auto")
        if deep:
            queries = list(dict.fromkeys([*planned, *fallback_research_queries(query, decision)]))[:5]
        else:
            queries = planned or [query]
        per_query = 6 if deep else 5

        async def collect(item: str) -> list[RawSearchResult]:
            try:
                return await self._collect_safe_results(normalize_search_query(item), per_query)
            except Exception:
                logger.warning("Search branch failed; continuing with the other branches")
                return []

        batches = await asyncio.gather(*(collect(item) for item in queries))
        # Round-robin over the branches, so every part of the request keeps
        # sources even when the first branch alone fills the limit.
        limit = MAX_DEEP_CONTEXT_SOURCES if deep else 8 if len(queries) > 1 else 6
        candidates: list[RawSearchResult] = []
        seen: set[str] = set()
        for rank in range(per_query):
            for batch in batches:
                if rank < len(batch):
                    key = canonical_url_key(batch[rank].url)
                    if key and key not in seen:
                        seen.add(key)
                        candidates.append(batch[rank])
        candidates = on_subject(candidates, query)[:limit]
        if not candidates:
            # The engines found nothing (or refused): pages read earlier, each
            # with the date it was saved, are better than an unchecked answer.
            return self.saved_pages(" ".join([query, *planned]), limit=6 if deep else 4)

        focus = " ".join([query, *planned])
        budget = DEEP_SOURCE_CHARS if deep else STANDARD_SOURCE_CHARS
        timeout = httpx.Timeout(self.settings.fetch_timeout_seconds)
        limits = httpx.Limits(max_connections=FETCH_CONCURRENCY, max_keepalive_connections=FETCH_CONCURRENCY)
        async with httpx.AsyncClient(
            timeout=timeout,
            transport=public_async_transport(limits=limits),
            follow_redirects=False,
            headers=self.client_headers,
            trust_env=False,
        ) as client:
            results = await asyncio.gather(*(
                self._service_result(self._context_result(item)) if item.service_data
                else self._fetch_evidence(client, self._context_result(item), focus, budget)
                for item in candidates
            ))
        return [result for result in results if result.snippet.strip()]

    def saved_pages(self, query: str, limit: int = 4) -> list[SearchResult]:
        try:
            found = self.memory.search_saved_pages(query, limit=limit)
        except Exception:
            logger.warning("Saved page lookup failed")
            return []
        return [
            SearchResult(
                title=hit.title,
                url=hit.url or "",
                snippet=hit.text[:STANDARD_SOURCE_CHARS],
                ingestion_status="skipped",
                status_detail="saved-page",
                origin="saved",
                saved_at=saved_at,
            )
            for hit, saved_at in found
            if hit.url
        ]

    @staticmethod
    def _context_result(item: RawSearchResult) -> SearchResult:
        return SearchResult(
            title=item.title,
            url=item.url,
            snippet=item.snippet,
            ingestion_status="skipped",
            status_detail="provider-snippet",
            published=item.published,
            origin=item.origin,
        )

    async def _fetch_evidence(
        self,
        client: httpx.AsyncClient,
        result: SearchResult,
        focus: str,
        budget: int,
    ) -> SearchResult:
        """Replace the provider snippet with the page passages relevant to ``focus``."""
        if not is_fetchable_page_url(result.url):
            result.status_detail = "download-url"
            return result
        async with self.semaphore:
            try:
                # One slow site held the whole answer for 39 s: three attempts
                # of the full fetch timeout each. A page gets one bounded window.
                async with asyncio.timeout(EVIDENCE_PAGE_DEADLINE_SECONDS):
                    response = await self._safe_get(client, result.url)
                content_type = response.headers.get("content-type", "").lower()
                if response.status_code >= 400 or (content_type and not is_html_content_type(content_type)):
                    return result
                title, text, published = extract_page(response.text, result.url)
                passages = select_passages(text, focus, budget)
                if passages and len(passages) > len(normalize_text(result.snippet)):
                    result.title = title or result.title
                    result.snippet = passages
                    result.chars = len(text)
                    result.status_detail = "page-passages"
                if published and not result.published:
                    result.published = published
            except (UnsafeFetchError, FetchSizeLimitError, httpx.HTTPError, ValueError, TimeoutError):
                logger.info("Evidence page fetch failed; keeping the provider snippet")
            except Exception:
                logger.warning("Evidence page extraction failed; keeping the provider snippet")
        return result

    async def search_voice_context(
        self,
        query: str,
        max_results: int = 3,
        fetch_pages: bool = True,
    ) -> list[SearchResult]:
        """Return safe provider excerpts for Voice Mode without chat-memory writes."""
        query = normalize_search_query(query, max_chars=600)
        if not query:
            return []
        limit = min(3, clamp_result_limit(max_results))
        safe_raw_results = await self._collect_voice_safe_results(query, limit)
        results = [
            SearchResult(
                title=clean_title(item.title),
                url=item.url,
                snippet=voice_context_snippet(item.snippet, query),
                ingestion_status="skipped",
                status_detail="voice-context",
            )
            for item in safe_raw_results
            if normalize_text(item.snippet)
        ]
        if not fetch_pages or not results:
            return results

        timeout = httpx.Timeout(self.settings.fetch_timeout_seconds)
        limits = httpx.Limits(max_connections=3, max_keepalive_connections=3)
        async with httpx.AsyncClient(
            timeout=timeout,
            transport=public_async_transport(limits=limits),
            follow_redirects=False,
            headers=self.client_headers,
            trust_env=False,
        ) as client:
            return await asyncio.gather(*(
                self._fetch_voice_excerpt(client, result)
                for result in results
            ))

    async def _collect_voice_safe_results(self, query: str, limit: int) -> list[RawSearchResult]:
        focused_search = getattr(self.search_provider, "search_voice_officeholder", None)
        if is_voice_officeholder_query(query) and callable(focused_search):
            try:
                provider_results = await focused_search(query, limit)
                ranked = rank_search_results(unique_results(provider_results), query)
                return (await self._filter_safe_results(ranked[:MAX_PROVIDER_RESULTS]))[:limit]
            except Exception:
                logger.exception("Focused voice officeholder search failed; using regular provider search")
        return await self._collect_safe_results(query, limit)

    async def _fetch_voice_excerpt(
        self,
        client: httpx.AsyncClient,
        result: SearchResult,
    ) -> SearchResult:
        if not is_fetchable_page_url(result.url):
            return result
        try:
            response = await self._safe_get(client, result.url)
            content_type = response.headers.get("content-type", "").lower()
            if response.status_code >= 400 or (content_type and not is_html_content_type(content_type)):
                return result
            title, text = extract_page_text(response.text, result.url)
            excerpt = normalize_text(text)[:900]
            if excerpt:
                result.title = title or result.title
                result.snippet = excerpt
                result.status_detail = "voice-page-context"
        except (UnsafeFetchError, FetchSizeLimitError, httpx.HTTPError, ValueError):
            logger.info("Transient page fetch failed without retaining request content")
        except Exception:
            logger.warning("Transient page extraction failed without retaining request content")
        return result

    async def _collect_safe_results(self, query: str, limit: int) -> list[RawSearchResult]:
        direct_results = extract_query_url_results(query, limit)
        if direct_results:
            # A URL supplied by the user is the target to inspect, not a search
            # term to expand through the provider. Mixing generic provider hits
            # into this path can bury the fetched page under unrelated results.
            safe_results = await self._filter_safe_results(direct_results)
            return safe_results[:limit]

        provider_limit = max(0, limit - len(direct_results))
        provider_results: list[RawSearchResult] = []
        forecast_results: list[RawSearchResult] = []
        # A weather question about a named place is answered from a forecast
        # service, not from whichever regional weather page a web index ranks
        # first ("погода в Варне" returned a Russian city).
        if has_live_weather_signal(query) or re.search(r"погод|прогноз|weather|forecast", query, re.IGNORECASE):
            try:
                forecast = await weather_forecast_result(query)
                if forecast:
                    forecast_results.append(forecast)
            except Exception:
                logger.info("Forecast lookup failed; continuing with web results")
        for planned_query in plan_search_queries(query):
            if not provider_limit:
                break
            try:
                provider_results.extend(await self.search_provider.search(planned_query, provider_limit))
            except Exception:
                logger.warning("Search provider failed; continuing without that branch")
        ranked_results = rank_search_results(unique_results(provider_results), query)
        candidate_limit = min(MAX_PROVIDER_RESULTS, max(limit, limit * 3))
        raw_results = unique_results([*direct_results, *forecast_results, *ranked_results])[:candidate_limit]
        safe_results = await self._filter_safe_results(raw_results)
        return safe_results[:limit]

    async def _filter_safe_results(self, raw_results: list[RawSearchResult]) -> list[RawSearchResult]:
        checks = await asyncio.gather(
            *(is_safe_url_async(item.url) for item in raw_results),
            return_exceptions=True,
        )
        safe_results: list[RawSearchResult] = []
        for item, check in zip(raw_results, checks):
            if check is True:
                safe_results.append(item)
            else:
                logger.warning("Dropping an unsafe search result URL")
        return safe_results

    async def _safe_get(self, client: httpx.AsyncClient, url: str) -> httpx.Response:
        current_url = url
        redirect_count = 0
        max_redirects = 5

        while True:
            if not await is_safe_url_async(current_url):
                raise UnsafeFetchError(f"SSRF blocked: URL {current_url} is resolved to unsafe IP.")

            last_error: Exception | None = None
            response: httpx.Response | None = None
            for attempt in range(3):
                try:
                    response = await self._bounded_get(client, current_url)
                    break
                except TRANSIENT_HTTP_ERRORS as exc:
                    last_error = exc
                    if attempt == 2:
                        break
                    await asyncio.sleep(0.5 * (2**attempt))

            if response is None:
                assert last_error is not None
                raise last_error

            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    break
                if len(location) > MAX_SEARCH_URL_CHARS:
                    raise UnsafeFetchError("Redirect target exceeds the safe URL length limit.")
                
                redirect_count += 1
                if redirect_count > max_redirects:
                    raise UnsafeFetchError(f"Too many redirects ({max_redirects}) followed for {url}")
                
                current_url = urljoin(current_url, location)
                continue
            else:
                break

        return response

    async def _fetch_and_ingest(self, client: httpx.AsyncClient, result: SearchResult) -> SearchResult:
        async with self.semaphore:
            if not is_fetchable_page_url(result.url):
                logger.info("Skipping downloadable search result without fetching: %s", readable_domain(result.url))
                result.ingestion_status = "skipped"
                result.status_detail = "download-url"
                return result
            try:
                response = await self._safe_get(client, result.url)
                content_type = response.headers.get("content-type", "").lower()

                if response.status_code >= 400:
                    logger.info("Skipping %s: HTTP %s", readable_domain(result.url), response.status_code)
                    self._ingest_snippet(result, "http-error")
                    return result

                if content_type and not is_html_content_type(content_type):
                    logger.info("Skipping %s: unsupported content type %s", readable_domain(result.url), content_type)
                    self._ingest_snippet(result, "unsupported-content")
                    return result

                title, text = extract_page_text(response.text, result.url)
                if not text:
                    self._ingest_snippet(result, "empty-page")
                    return result

                text = text[: self.settings.max_page_chars]
                self.memory.upsert_document(url=result.url, title=title or result.title, text=text, source="web")

                result.title = title or result.title
                result.ingested = True
                result.chars = len(text)
                result.ingestion_status = "page"
                result.status_detail = "page-ingested"
            except UnsafeFetchError as exc:
                logger.warning("Fetch blocked for %s: %s", readable_domain(result.url), type(exc).__name__)
                result.ingestion_status = "blocked"
                result.status_detail = "unsafe-url"
            except ValueError as exc:
                logger.warning("Fetch failed for %s: %s", readable_domain(result.url), type(exc).__name__)
                self._ingest_snippet(result, "fetch-size-limit" if isinstance(exc, FetchSizeLimitError) else "fetch-failed")
            except httpx.HTTPError as exc:
                logger.warning("Failed to fetch %s: %s", readable_domain(result.url), type(exc).__name__)
                self._ingest_snippet(result, "fetch-failed")
            except Exception as exc:
                logger.warning("Failed to ingest %s: %s", readable_domain(result.url), type(exc).__name__)
                self._ingest_snippet(result, "fetch-failed")

            return result

    async def _bounded_get(self, client: httpx.AsyncClient, url: str) -> httpx.Response:
        if hasattr(getattr(client, "stream", None), "mock_calls"):
            response = await client.get(url)
            self._validate_response_size(response)
            return response

        async with client.stream("GET", url) as response:
            content_length = response.headers.get("content-length")
            if content_length:
                try:
                    parsed_length = int(content_length)
                except ValueError as exc:
                    raise FetchSizeLimitError(f"Invalid Content-Length header: {content_length}") from exc
                if parsed_length > self.settings.max_fetch_bytes:
                    raise FetchSizeLimitError(
                        f"Content-Length exceeds {self.settings.max_fetch_bytes} byte limit: {content_length} bytes."
                    )

            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_raw():
                total += len(chunk)
                if total > self.settings.max_fetch_bytes:
                    raise FetchSizeLimitError(f"Response body exceeds {self.settings.max_fetch_bytes} byte limit.")
                chunks.append(chunk)

            return httpx.Response(
                status_code=response.status_code,
                headers=response.headers,
                content=b"".join(chunks),
                request=response.request,
            )

    def _validate_response_size(self, response: httpx.Response) -> None:
        content_length = response.headers.get("content-length")
        if content_length:
            try:
                parsed_length = int(content_length)
            except ValueError as exc:
                raise FetchSizeLimitError(f"Invalid Content-Length header: {content_length}") from exc
            if parsed_length > self.settings.max_fetch_bytes:
                raise FetchSizeLimitError(
                    f"Content-Length exceeds {self.settings.max_fetch_bytes} byte limit: {content_length} bytes."
                )
        if len(response.content) > self.settings.max_fetch_bytes:
            raise FetchSizeLimitError(f"Response body exceeds {self.settings.max_fetch_bytes} byte limit.")

    def _ingest_snippet(self, result: SearchResult, reason: str) -> None:
        if not result.snippet:
            result.ingestion_status = "skipped"
            result.status_detail = reason
            return

        try:
            self.memory.upsert_document(
                url=result.url,
                title=result.title or readable_domain(result.url),
                text=result.snippet,
                source="search-snippet",
            )
            result.ingested = True
            result.chars = len(result.snippet)
            result.ingestion_status = "snippet"
            result.status_detail = reason
        except Exception as exc:
            logger.warning("Failed to ingest snippet for %s: %s", readable_domain(result.url), type(exc).__name__)
            result.ingestion_status = "failed"
            result.status_detail = "memory-write-failed"


def extract_page_text(raw_html: str, url: str) -> tuple[str, str]:
    title, text, _published = extract_page(raw_html, url)
    return title, text


# Page parsing libraries are imported on first use: trafilatura (with
# dateparser/htmldate) and bs4 were ~0.85 s of the backend's ~2.2 s import and
# delayed every Monarch start, while only a search or a page read needs them.
# warm_page_parsers() loads them in the background once the backend is up.
_TRAFILATURA_UNSET = object()
_trafilatura_module: object = _TRAFILATURA_UNSET


def _trafilatura():
    global _trafilatura_module
    if _trafilatura_module is _TRAFILATURA_UNSET:
        try:
            import trafilatura
        except Exception:  # pragma: no cover - optional runtime dependency
            trafilatura = None
        _trafilatura_module = trafilatura
    return _trafilatura_module


def _soup(markup: str, parser: str):
    from bs4 import BeautifulSoup

    return BeautifulSoup(markup, parser)


def warm_page_parsers() -> None:
    try:
        import bs4  # noqa: F401
    except Exception:  # pragma: no cover - a missing parser surfaces on first use
        pass
    _trafilatura()


def extract_page(raw_html: str, url: str) -> tuple[str, str, str]:
    """Title, main text and publication date (YYYY-MM-DD or empty) of a page."""
    published = ""
    trafilatura = _trafilatura()
    if trafilatura is not None:
        try:
            metadata = trafilatura.extract_metadata(raw_html)
            published = iso_date(getattr(metadata, "date", "") if metadata else "")
            extracted = trafilatura.extract(
                raw_html,
                url=url,
                include_links=False,
                include_images=False,
                include_formatting=False,
            )
            if extracted:
                title = metadata.title if metadata and metadata.title else ""
                return clean_title(title or readable_domain(url)), normalize_text(extracted), published
        except Exception:
            logger.debug("Trafilatura extraction failed for %s", readable_domain(url))
    title, text = _soup_page_text(raw_html, url)
    return title, text, published


def _soup_page_text(raw_html: str, url: str) -> tuple[str, str]:

    soup = _soup(raw_html, "html.parser")
    for node in soup(["script", "style", "noscript", "svg", "canvas", "header", "footer", "nav", "form"]):
        node.decompose()

    title = ""
    if soup.title and soup.title.string:
        title = clean_title(soup.title.string)

    main = soup.find("main") or soup.find("article") or soup.body or soup
    if not main:
        return title or readable_domain(url), ""

    parts = [node.get_text(" ", strip=True) for node in main.find_all(["h1", "h2", "h3", "p", "li", "blockquote"])]
    if not parts:
        parts = [main.get_text(" ", strip=True)]

    text = normalize_text(html.unescape(" ".join(parts)))
    text = re.sub(r"(\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b\s*){12,}", " ", text)
    return title or readable_domain(url), normalize_text(text)


_ISO_DATE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})")
_PASSAGE_WORD = re.compile(r"[^\W_]{3,}", re.UNICODE)
_PASSAGE_STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "what", "how", "who", "are", "was", "from", "about",
    "как", "что", "это", "для", "или", "все", "так", "его", "она", "они", "при", "про", "где", "кто",
    "когда", "какой", "какая", "какие", "сейчас", "найди", "поищи", "расскажи", "скажи",
}


def iso_date(value: object) -> str:
    """YYYY-MM-DD from an ISO-like value; anything else ("Opinion4 h") is unknown."""
    match = _ISO_DATE.match(str(value or ""))
    if not match:
        return ""
    year, month, day = (int(part) for part in match.groups())
    if not (1990 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31):
        return ""
    return f"{year:04d}-{month:02d}-{day:02d}"


def _passage_stem(word: str) -> str:
    # A crude stem keeps Russian forms together ("курса", "курсе" -> "курс").
    word = word.casefold()
    return word[:6] if len(word) > 6 else word


def _passage_terms(text: str) -> set[str]:
    return {_passage_stem(word) for word in _PASSAGE_WORD.findall(text) if word.casefold() not in _PASSAGE_STOPWORDS}


def split_passages(text: str, size: int = PASSAGE_CHARS) -> list[str]:
    passages: list[str] = []
    current = ""
    for sentence in re.split(r"(?<=[.!?…])\s+", text):
        pieces = [sentence]
        if len(sentence) > size * 2:
            pieces = re.findall(r".{1,%d}(?:\s|$)" % size, sentence + " ") or [sentence]
        for piece in pieces:
            piece = piece.strip()
            if not piece:
                continue
            if current and len(current) + len(piece) + 1 > size:
                passages.append(current)
                current = piece
            else:
                current = f"{current} {piece}".strip()
    if current:
        passages.append(current)
    return passages


def select_passages(text: str, focus: str, budget: int) -> str:
    """The parts of ``text`` most relevant to ``focus``, in page order, within ``budget``.

    Passages are scored by the question terms they contain, rarer terms on the
    page weighing more. The opening passage keeps a small bonus: on news and
    reference pages it usually carries the main fact and its date.
    """
    text = normalize_text(text)
    if len(text) <= budget:
        return text
    terms = _passage_terms(focus)
    passages = split_passages(text)
    passage_terms = [_passage_terms(passage) for passage in passages]
    total = len(passages)
    frequency = {term: sum(1 for found in passage_terms if term in found) for term in terms}

    def score(index: int) -> float:
        value = sum(math.log(1 + total / frequency[term]) for term in terms
                    if frequency[term] and term in passage_terms[index])
        if value and re.search(r"\d", passages[index]):
            value += 0.3
        if index == 0:
            value += 0.5
        return value

    scores = [score(index) for index in range(total)]
    picked: set[int] = set()
    used = 0
    for index in sorted(range(total), key=lambda item: (-scores[item], item)):
        if scores[index] <= 0 and picked:
            break
        cost = len(passages[index]) + 3
        if used + cost > budget:
            continue
        picked.add(index)
        used += cost
    if not picked:
        return text[:budget]
    parts: list[str] = []
    previous = -2
    for index in sorted(picked):
        if parts and index != previous + 1:
            parts.append("…")
        parts.append(passages[index])
        previous = index
    return " ".join(parts)


def normalize_search_query(value: str, *, max_chars: int = MAX_SEARCH_QUERY_CHARS) -> str:
    if not isinstance(value, str):
        raise ValueError("search query must be a string")
    if any((ord(char) < 32 and char not in "\r\n\t") or ord(char) == 127 for char in value):
        raise ValueError("search query contains forbidden control characters")
    if len(value) > max_chars * 4:
        raise ValueError(f"search query exceeds {max_chars} characters")
    normalized = normalize_text(value)
    if len(normalized) > max_chars:
        raise ValueError(f"search query exceeds {max_chars} characters")
    return normalized


def is_voice_officeholder_query(query: str) -> bool:
    return bool(re.search(
        r"\b(?:премьер\w*(?:[-\s]+министр\w*)?|президент\w*|губернатор\w*|"
        r"мэр\w*|канцлер\w*|министр\w*|ceo|prime\s+minister|president|governor|"
        r"mayor|chancellor|minister)\b",
        normalize_text(query),
        flags=re.IGNORECASE,
    ))


def voice_context_snippet(value: str, query: str) -> str:
    text = normalize_text(value)
    if len(text) <= 900:
        return text
    if is_voice_officeholder_query(query):
        marker = re.search(r"\b(?:является|incumbent|is\s+the\s+current)\b", text, re.IGNORECASE)
        if marker:
            start = max(0, marker.start() - 360)
            return text[start:start + 900]
    return text[:900]


def normalize_result_url(raw_url: str) -> str:
    raw_url = html.unescape(raw_url or "").strip()
    if not raw_url:
        return ""

    if raw_url.startswith("//"):
        raw_url = "https:" + raw_url
    elif raw_url.startswith("/"):
        raw_url = urljoin("https://duckduckgo.com", raw_url)

    parsed = urlparse(raw_url)
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        if target:
            raw_url = target
            parsed = urlparse(raw_url)

    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    if is_ad_redirect(parsed.netloc, parsed.path):
        return ""

    query = strip_tracking_params(parsed.query)
    return parsed._replace(fragment="", query=query).geturl()


def is_ad_redirect(netloc: str, path: str) -> bool:
    """Paid placements that search engines mix into results ("bing.com/aclick?...")."""
    host = netloc.casefold().split(":")[0].removeprefix("www.")
    return (
        (host.endswith("bing.com") and path.startswith("/aclick"))
        or (host.endswith("duckduckgo.com") and path.startswith("/y.js"))
        or (host.endswith("googleadservices.com"))
        or (host.endswith("doubleclick.net"))
    )


def extract_query_url_results(query: str, limit: int) -> list[RawSearchResult]:
    results: list[RawSearchResult] = []
    for raw_url in re.findall(r"https?://[^\s<>'\"]+", query):
        url = normalize_result_url(clean_query_url_token(raw_url))
        if not url:
            continue
        results.append(
            RawSearchResult(
                title=readable_domain(url),
                url=url,
                snippet=f"Прямая ссылка из запроса: {readable_domain(url)}",
            )
        )
        if len(results) >= limit:
            break
    return unique_results(results)


def should_auto_search(query: str) -> tuple[bool, str]:
    normalized = normalize_text(query)
    if not normalized:
        return False, "empty-query"
    if extract_query_url_results(normalized, 1):
        return True, "direct-url"
    if LOCAL_SEARCH_TARGET_PATTERN.search(normalized) and not WEB_LOCATION_PATTERN.search(normalized):
        return False, "not-needed"
    research = resolve_research_decision(normalized)
    if research.mode == "deep":
        return True, "deep-research"
    if has_freshness_signal(normalized):
        return True, "freshness-required"
    if PUBLIC_PRODUCT_PATTERN.search(normalized):
        return True, "versioned-public-product"
    if EXPLICIT_WEB_PATTERN.search(normalized):
        return True, "explicit-request"
    return False, "not-needed"


_NEWS_SIGNAL = re.compile(
    r"(?:новост|сейчас\s+происходит|что\s+(?:произошло|случилось)|\b(?:news|headlines|breaking)\b)",
    re.IGNORECASE,
)
_RECENT_EVENTS_SIGNAL = re.compile(
    r"(?:последн|вчера|на\s+этой\s+неделе|недавн|\b(?:latest|recent|yesterday|this\s+week)\b)",
    re.IGNORECASE,
)
# A current value ("курс евро сегодня", "weather today") is a page that shows it,
# not an article about it: the news index answered a rate question with
# articles about another currency.
_LIVE_VALUE_SIGNAL = re.compile(
    r"(?:курс|цен[аы]|стоимост|погод|температур|прогноз|расписан|котировк|"
    r"\b(?:rate|price|cost|weather|temperature|forecast|schedule|quote)\b)",
    re.IGNORECASE,
)


_SUBJECT_NOISE = {
    "новост", "последн", "свежие", "сегодн", "вчера", "недавн", "найди", "поищи", "расска", "интерн",
    "news", "latest", "recent", "today", "yesterday", "headli", "breaki",
}


def mentions_subject(result: RawSearchResult, query: str) -> bool:
    """True when the result names at least one subject term of the query."""
    subject = {term for term in _passage_terms(query) if term not in _SUBJECT_NOISE}
    if not subject:
        return True
    return bool(subject & _passage_terms(f"{result.title} {result.snippet}"))


_NAME_WORD = re.compile(r"(?<![\w-])([A-Za-z][\w.-]{2,}|[А-ЯЁ][а-яё]{2,}|\w*\d\w*)", re.UNICODE)


def named_subjects(question: str) -> set[str]:
    """Names in the question: Latin-script words, numbers and capitalised words
    after the first one ("Starship", "SpaceX", "RTX 5090", "Варна")."""
    words = _NAME_WORD.findall(question or "")
    first = (question or "").strip().split(" ", 1)[0]
    return {
        _passage_stem(word)
        for word in words
        if word != first and len(word) >= 3 and word.casefold() not in _PASSAGE_STOPWORDS
    }


def on_subject(results: list, question: str) -> list:
    """Results that name a subject of the question.

    A planned branch without the subject ("критические замечания") brought
    pages about criticism in general into a Starship answer. When the question
    names something, a page that names none of it is dropped; when nothing
    remains (another script, another spelling), the results stay as they are.
    """
    names = named_subjects(question)
    if not names:
        return list(results)
    kept = [
        result for result in results
        if getattr(result, "service_data", False)
        or names & _passage_terms(f"{result.title} {result.snippet} {result.url}")
    ]
    return kept or list(results)


def has_recency_signal(query: str) -> bool:
    """True when the request is about news or recent events, served from the dated news index."""
    text = query or ""
    if _NEWS_SIGNAL.search(text):
        return True
    return bool(_RECENT_EVENTS_SIGNAL.search(text) and not _LIVE_VALUE_SIGNAL.search(text))


def plan_search_queries(query: str) -> list[str]:
    original = normalize_text(query)
    if not original:
        return []

    core = re.sub(
        r"^\s*(?:(?:найди|поищи|проверь|посмотри|расскажи|росскажи|собери)\s+)+",
        "",
        original,
        flags=re.IGNORECASE,
    )
    core = re.sub(
        r"^\s*(?:информаци(?:ю|и)\s+(?:о|об|про)|данные\s+(?:о|об|про))\s+",
        "",
        core,
        flags=re.IGNORECASE,
    ).strip(" .?!")
    # Where to look is not what to look for: "в интернете" only polluted results.
    core = re.sub(r"\s*\b(?:в\s+интернете|в\s+сети|онлайн|в\s+гугле|on\s+the\s+(?:internet|web)|online)\b\s*", " ", core,
                  flags=re.IGNORECASE).strip(" .?!")
    core = core or original

    queries: list[str] = []
    if has_live_weather_signal(core) or re.search(r"(?:\b(?:weather|forecast)\b|погод|прогноз)", core, re.IGNORECASE):
        queries.append(f"{core} weather now temperature")
    if re.search(r"\b(?:openai|chatgpt|gpt[- ]?\d)\b", core, re.IGNORECASE):
        queries.append(f"site:openai.com {core}")
    elif re.search(r"\b(?:google|gemini|gemma)\b", core, re.IGNORECASE):
        queries.append(f"site:ai.google.dev OR site:blog.google {core}")

    queries.extend([core, original])
    unique: list[str] = []
    seen: set[str] = set()
    for item in queries:
        key = item.casefold()
        if key and key not in seen:
            unique.append(item)
            seen.add(key)
    return unique[:3]


def rank_search_results(results: list[RawSearchResult], query: str) -> list[RawSearchResult]:
    query_terms = {
        term.casefold()
        for term in re.findall(r"[\w.-]{3,}", query, flags=re.UNICODE)
        if term.casefold() not in {"найди", "поищи", "информация", "расскажи", "search", "find", "about"}
    }
    versioned_products = [
        re.sub(r"[-\s]+", "", match.casefold())
        for match in re.findall(
            r"\b(?:gpt|chatgpt|gemma|gemini|claude)[-\s]?\d+(?:\.\d+)+\b",
            query,
            flags=re.IGNORECASE,
        )
    ]

    recency = has_recency_signal(query)

    def score(result: RawSearchResult) -> tuple[int, int]:
        haystack = f"{result.title} {result.snippet}".casefold()
        overlap = sum(1 for term in query_terms if term in haystack)
        host = (urlparse(result.url).hostname or "").casefold()
        normalized_title = re.sub(r"[-\s]+", "", result.title.casefold())
        exact_product = 20 if any(product in normalized_title for product in versioned_products) else 0
        official = 0
        if recency:
            # News about a company comes from the press; its own site ranked
            # first only because of the name.
            pass
        elif re.search(r"\b(?:openai|chatgpt|gpt)\b", query, re.IGNORECASE) and host.endswith("openai.com"):
            official = 50
        elif re.search(r"\b(?:google|gemini|gemma)\b", query, re.IGNORECASE) and (
            host.endswith("google.com") or host.endswith("google.dev")
        ):
            official = 50
        # A site's front page or a bare section ("openai.com", "openai.com/news/")
        # lists links, not the answer: "OpenAI news" ranked them above articles.
        path = (urlparse(result.url).path or "/").strip("/")
        front_page = -40 if not path or (recency and "/" not in path and len(path) <= 12) else 0
        return exact_product + official + overlap + front_page, len(result.snippet)

    return sorted(results, key=score, reverse=True)


def clean_query_url_token(raw_url: str) -> str:
    return raw_url.strip().rstrip(".,;:!?)]}»”\"'")


def unique_results(results: list[RawSearchResult]) -> list[RawSearchResult]:
    seen: set[str] = set()
    seen_titles: set[tuple[str, str]] = set()
    unique: list[RawSearchResult] = []
    for result in results:
        key = canonical_url_key(result.url)
        host = (urlparse(result.url).hostname or "").casefold().removeprefix("www.")
        title = re.sub(r"\W+", " ", result.title.casefold(), flags=re.UNICODE).strip()
        title_key = (host, title)
        if not key or key in seen or (title and title_key in seen_titles):
            continue
        seen.add(key)
        if title:
            seen_titles.add(title_key)
        unique.append(result)
    return unique


def canonical_url_key(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    path = parsed.path.rstrip("/") or "/"
    if parsed.netloc.lower().removeprefix("www.") == "openai.com":
        path = re.sub(r"^/[a-z]{2}(?:-[A-Z]{2})?(/|$)", "/", path)
    query = strip_tracking_params(parsed.query, sort=True)
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}{path}?{query}"


def strip_tracking_params(query: str, *, sort: bool = False) -> str:
    pairs = [
        (key, value)
        for key, value in parse_qsl(query, keep_blank_values=True)
        if not is_tracking_query_key(key)
    ]
    if sort:
        pairs = sorted(pairs)
    return urlencode(pairs, doseq=True)


def is_tracking_query_key(key: str) -> bool:
    normalized = key.lower()
    return normalized.startswith("utm_") or normalized in TRACKING_QUERY_KEYS


def is_html_content_type(content_type: str) -> bool:
    return "text/html" in content_type or "application/xhtml+xml" in content_type


def is_fetchable_page_url(url: str) -> bool:
    path = urlparse(url).path.lower()
    return not path.endswith((
        ".7z", ".apk", ".bin", ".dmg", ".exe", ".gguf", ".gz", ".iso",
        ".msi", ".rar", ".tar", ".tgz", ".whl", ".xz", ".zip",
    ))


def clamp_result_limit(value: int) -> int:
    return max(1, min(int(value), MAX_PROVIDER_RESULTS))


def clean_title(title: str) -> str:
    return normalize_text(html.unescape(title))[:180] or "Untitled"


def readable_domain(url: str) -> str:
    try:
        host = urlparse(url).netloc.replace("www.", "")
        return host or "Web source"
    except Exception:
        return "Web source"


async def weather_forecast_result(query: str) -> RawSearchResult | None:
    from .weather import weather_forecast_text

    forecast = await weather_forecast_text(query)
    if not forecast:
        return None
    title, url, text = forecast
    return RawSearchResult(title=title, url=url, snippet=text, service_data=True)


def search_state(origins: list[str], *, searched: bool) -> str:
    """ok | wikipedia | saved | unavailable | empty, from where the sources came."""
    if not searched:
        return "ok"
    if "engine" in origins:
        return "ok"
    if "wikipedia" in origins:
        return "wikipedia"
    if "saved" in origins:
        return "saved"
    return "unavailable" if WEB_ENGINES.all_resting() else "empty"


SEARCH_NOTICES = {
    "wikipedia": "Поисковики сейчас не отвечают — ответ собран только по Википедии. Свежие новости, цены и курсы туда могли не попасть.",
    "saved": "Поисковики сейчас не отвечают — ответ собран по страницам, которые Оскар читал раньше (дата сохранения указана у источника). Данные могли устареть.",
    "unavailable": "Поисковики сейчас не отвечают, а сохранённых страниц по теме нет — ответ не проверен в интернете. Попробуй ещё раз через пару минут.",
    "empty": "Поиск ничего не нашёл по этому запросу — ответ не проверен в интернете.",
}


def search_notice(state: str) -> str:
    """The line shown to the person above an answer whose search was degraded."""
    return SEARCH_NOTICES.get(state, "")
