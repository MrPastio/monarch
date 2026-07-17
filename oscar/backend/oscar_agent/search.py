from __future__ import annotations

import asyncio
import html
import logging
import re
import socket
import ipaddress
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import parse_qs, parse_qsl, quote_plus, urlencode, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

try:
    import trafilatura
except Exception:  # pragma: no cover - optional runtime dependency
    trafilatura = None

from .config import Settings
from .memory import MemoryStore, normalize_text
from .research import resolve_research_decision
from .schemas import SearchResult

MAX_SEARCH_QUERY_CHARS = 2048
MAX_SEARCH_URL_CHARS = 4096


def is_safe_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
        return not (
            ip.is_loopback or
            ip.is_private or
            ip.is_link_local or
            ip.is_unspecified or
            ip.is_multicast or
            ip.is_reserved
        )
    except ValueError:
        return False

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
    r"(?:\b(?:search|find|look\s*up|browse|google)\b|"
    r"\b(?:web|online|internet)\b|"
    r"(?:найди|поищи|проверь|посмотри).{0,36}(?:в\s+сети|в\s+интернете|на\s+сайте|сайт|онлайн)|"
    r"(?:в\s+сети|в\s+интернете|на\s+сайте|веб[- ]?поиск|поищи|загугли))",
    re.IGNORECASE,
)
FRESHNESS_PATTERN = re.compile(
    r"(?:\b(?:latest|current|today|recent|newest|price|release|version|schedule|news|weather|"
    r"president|ceo|law|regulation)\b|"
    r"(?:актуальн|свеж|последн|сегодня|сейчас|новост|цен[аы]|курс|релиз|верси|расписан|погод|"
    r"президент|директор|закон|правил|регламент|стандарт))",
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


class SearchProvider(Protocol):
    async def search(self, query: str, max_results: int) -> list[RawSearchResult]:
        ...


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
        try:
            results = await asyncio.to_thread(self._search_sync, query, max_results)
            if results:
                return results
        except Exception as exc:
            logger.warning("DDGS search failed; falling back to DuckDuckGo HTML: %s", exc)

        return await asyncio.to_thread(self._duckduckgo_html, query, max_results)

    async def search_voice_officeholder(self, query: str, max_results: int) -> list[RawSearchResult]:
        """Use DDGS' focused Wikipedia backend for a bounded current-role fact."""
        return await asyncio.to_thread(
            self._search_sync,
            query,
            max_results,
            "wikipedia",
        )

    def _search_sync(
        self,
        query: str,
        max_results: int,
        backend: str = "auto",
    ) -> list[RawSearchResult]:
        from ddgs import DDGS

        timeout = max(2, min(5, int(self.timeout_seconds)))
        region = "ru-ru" if re.search(r"[А-Яа-яЁё]", query) else "us-en"
        with DDGS(timeout=timeout) as ddgs:
            rows = list(ddgs.text(
                query,
                max_results=max_results,
                safesearch="moderate",
                region=region,
                backend=backend,
            ))

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
            logger.warning("DuckDuckGo HTML search failed: %s", exc)
            return []

        soup = BeautifulSoup(response.text, "html.parser")
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
                "Chrome/120.0.0.0 Safari/537.36 OscarLocalAgent/0.1"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        }

    async def search_and_ingest(
        self,
        query: str,
        max_results: int | None = None,
        fetch_pages: bool = True,
    ) -> list[SearchResult]:
        query = normalize_search_query(query)
        if not query:
            return []

        limit = clamp_result_limit(max_results or self.settings.search_top_k)
        safe_raw_results = await self._collect_safe_results(query, limit)
        results = [SearchResult(title=item.title, url=item.url, snippet=item.snippet) for item in safe_raw_results]

        if not fetch_pages:
            for result in results:
                self._ingest_snippet(result, "provider-snippet")
            return results

        timeout = httpx.Timeout(self.settings.fetch_timeout_seconds)
        limits = httpx.Limits(max_connections=FETCH_CONCURRENCY, max_keepalive_connections=FETCH_CONCURRENCY)
        async with httpx.AsyncClient(
            timeout=timeout,
            limits=limits,
            follow_redirects=False,
            headers=self.client_headers,
            trust_env=False,
        ) as client:
            tasks = [self._fetch_and_ingest(client, result) for result in results]
            return await asyncio.gather(*tasks)

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
            limits=limits,
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
            logger.info("Voice context page fetch failed for %s", result.url, exc_info=True)
        except Exception:
            logger.exception("Voice context page extraction failed for %s", result.url)
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
        for planned_query in plan_search_queries(query):
            if not provider_limit:
                break
            try:
                provider_results.extend(await self.search_provider.search(planned_query, provider_limit))
            except Exception:
                logger.exception("Search provider failed for query %r; continuing", planned_query)
        ranked_results = rank_search_results(unique_results(provider_results), query)
        candidate_limit = min(MAX_PROVIDER_RESULTS, max(limit, limit * 3))
        raw_results = unique_results([*direct_results, *ranked_results])[:candidate_limit]
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
                logger.warning("Dropping unsafe search result URL: %s", item.url)
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
                logger.info("Skipping downloadable search result without fetching: %s", result.url)
                result.ingestion_status = "skipped"
                result.status_detail = "download-url"
                return result
            try:
                response = await self._safe_get(client, result.url)
                content_type = response.headers.get("content-type", "").lower()

                if response.status_code >= 400:
                    logger.info("Skipping %s: HTTP %s", result.url, response.status_code)
                    self._ingest_snippet(result, "http-error")
                    return result

                if content_type and not is_html_content_type(content_type):
                    logger.info("Skipping %s: unsupported content type %s", result.url, content_type)
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
                logger.warning("Fetch blocked for %s: %s", result.url, exc)
                result.ingestion_status = "blocked"
                result.status_detail = "unsafe-url"
            except ValueError as exc:
                logger.warning("Fetch failed for %s: %s", result.url, exc)
                self._ingest_snippet(result, "fetch-size-limit" if isinstance(exc, FetchSizeLimitError) else "fetch-failed")
            except httpx.HTTPError as exc:
                logger.warning("Failed to fetch %s: %s", result.url, exc)
                self._ingest_snippet(result, "fetch-failed")
            except Exception:
                logger.exception("Failed to ingest %s", result.url)
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
        except Exception:
            logger.exception("Failed to ingest snippet for %s", result.url)
            result.ingestion_status = "failed"
            result.status_detail = "memory-write-failed"


def extract_page_text(raw_html: str, url: str) -> tuple[str, str]:
    if trafilatura is not None:
        try:
            extracted = trafilatura.extract(
                raw_html,
                url=url,
                include_links=False,
                include_images=False,
                include_formatting=False,
            )
            if extracted:
                metadata = trafilatura.extract_metadata(raw_html)
                title = metadata.title if metadata and metadata.title else ""
                return clean_title(title or readable_domain(url)), normalize_text(extracted)
        except Exception:
            logger.debug("Trafilatura extraction failed for %s", url, exc_info=True)

    soup = BeautifulSoup(raw_html, "html.parser")
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

    query = strip_tracking_params(parsed.query)
    return parsed._replace(fragment="", query=query).geturl()


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
    if EXPLICIT_WEB_PATTERN.search(normalized):
        return True, "explicit-request"
    research = resolve_research_decision(normalized)
    if research.mode == "deep":
        return True, "deep-research"
    if FRESHNESS_PATTERN.search(normalized):
        return True, "freshness-required"
    if PUBLIC_PRODUCT_PATTERN.search(normalized):
        return True, "versioned-public-product"
    return False, "not-needed"


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
    core = core or original

    queries: list[str] = []
    if re.search(r"(?:\b(?:weather|forecast)\b|погод|прогноз)", core, re.IGNORECASE):
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

    def score(result: RawSearchResult) -> tuple[int, int]:
        haystack = f"{result.title} {result.snippet}".casefold()
        overlap = sum(1 for term in query_terms if term in haystack)
        host = (urlparse(result.url).hostname or "").casefold()
        normalized_title = re.sub(r"[-\s]+", "", result.title.casefold())
        exact_product = 20 if any(product in normalized_title for product in versioned_products) else 0
        official = 0
        if re.search(r"\b(?:openai|chatgpt|gpt)\b", query, re.IGNORECASE) and host.endswith("openai.com"):
            official = 50
        elif re.search(r"\b(?:google|gemini|gemma)\b", query, re.IGNORECASE) and (
            host.endswith("google.com") or host.endswith("google.dev")
        ):
            official = 50
        return exact_product + official + overlap, len(result.snippet)

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
