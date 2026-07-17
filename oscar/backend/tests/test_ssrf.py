import os
import sys
import socket
import ipaddress
import gzip
import pytest
import httpx
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path

# Add oscar/backend to sys.path to ensure oscar_agent can be imported
backend_dir = Path(__file__).resolve().parents[1]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from oscar_agent.config import Settings
from oscar_agent import main as main_module
from oscar_agent.search import (
    RawSearchResult,
    WebSearchService,
    canonical_url_key,
    extract_query_url_results,
    is_safe_ip,
    is_safe_url,
    normalize_result_url,
    normalize_search_query,
    plan_search_queries,
    rank_search_results,
    should_auto_search,
    unique_results,
)
from oscar_agent.schemas import SearchResult


def mock_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    """
    Mock resolver to simulate DNS resolution for safe/unsafe hosts without real network queries.
    """
    if host == "localhost":
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
    elif host == "safe-public.com":
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]
    elif host == "private-host.local":
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", port))]
    elif host == "link-local.local":
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.1.1", port))]
    elif host == "ipv6-link-local.local":
        return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("fe80::1", port, 0, 0))]
    else:
        # Fallback to an allowed public IP representation
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.4.4", port))]


def test_is_safe_ip_loopback():
    assert not is_safe_ip("127.0.0.1")
    assert not is_safe_ip("127.0.0.2")
    assert not is_safe_ip("::1")


def test_search_planner_prefers_official_source_for_openai_product():
    queries = plan_search_queries("Найди и расскажи информацию про GPT 5.6")

    assert queries[0].startswith("site:openai.com")
    assert any("GPT 5.6" in query for query in queries)
    assert should_auto_search("Что нового в GPT 5.6?")[0] is True
    assert should_auto_search(
        "Предположи самый худший сценарий для OpenAI, продуктов и политики после IPO"
    ) == (True, "deep-research")
    assert should_auto_search("Объясни сортировку вставками") == (False, "not-needed")

    ranked = rank_search_results([
        RawSearchResult(title="Introducing GPT-5", url="https://openai.com/index/introducing-gpt-5/"),
        RawSearchResult(title="Previewing GPT-5.6 Sol", url="https://openai.com/index/previewing-gpt-5-6-sol/"),
    ], "GPT 5.6 OpenAI")
    assert ranked[0].title == "Previewing GPT-5.6 Sol"

    ranked = rank_search_results([
        RawSearchResult(title="GPT-5.6 release date and specs", url="https://seo.example/gpt-5-6"),
        RawSearchResult(title="GPT-5.6 preview", url="https://openai.com/index/gpt-5-6"),
    ], "GPT 5.6 OpenAI")
    assert ranked[0].url.startswith("https://openai.com/")

    weather_queries = plan_search_queries("погода в Киеве сейчас")
    assert weather_queries[0].endswith("weather now temperature")


def test_search_results_deduplicate_same_title_on_same_host():
    results = unique_results([
        RawSearchResult(title="GPT-5.6 Preview System Card", url="https://safety.example/gpt-5-6"),
        RawSearchResult(title="GPT-5.6 Preview System Card", url="https://safety.example/gpt-5-6/introduction"),
        RawSearchResult(title="GPT-5.6 Preview System Card", url="https://other.example/gpt-5-6"),
    ])

    assert [result.url for result in results] == [
        "https://safety.example/gpt-5-6",
        "https://other.example/gpt-5-6",
    ]


def test_is_safe_ip_private():
    # 10.0.0.0/8
    assert not is_safe_ip("10.0.0.1")
    assert not is_safe_ip("10.255.255.255")
    
    # 172.16.0.0/12
    assert not is_safe_ip("172.16.0.1")
    assert not is_safe_ip("172.31.255.255")
    
    # 192.168.0.0/16
    assert not is_safe_ip("192.168.0.1")
    assert not is_safe_ip("192.168.1.100")


def test_is_safe_ip_link_local():
    # IPv4 link-local (169.254.0.0/16)
    assert not is_safe_ip("169.254.0.1")
    assert not is_safe_ip("169.254.169.254")
    
    # IPv6 link-local (fe80::/10)
    assert not is_safe_ip("fe80::1")
    assert not is_safe_ip("fe80::5054:ff:fe12:3456")


def test_is_safe_ip_others():
    assert not is_safe_ip("0.0.0.0")  # unspecified
    assert not is_safe_ip("224.0.0.1")  # multicast
    assert not is_safe_ip("240.0.0.1")  # reserved


def test_is_safe_ip_public():
    assert is_safe_ip("8.8.8.8")
    assert is_safe_ip("1.1.1.1")
    assert is_safe_ip("142.250.190.46")


def test_is_safe_ip_invalid():
    assert not is_safe_ip("invalid-ip-string")
    assert not is_safe_ip("999.999.999.999")


def test_is_safe_url_schemes():
    # Only http and https are allowed
    assert not is_safe_url("file:///etc/passwd")
    assert not is_safe_url("ftp://8.8.8.8")
    assert not is_safe_url("gopher://8.8.8.8")
    assert not is_safe_url("javascript:alert(1)")


def test_is_safe_url_direct_ips():
    # Unsafe direct IPs
    assert not is_safe_url("http://127.0.0.1")
    assert not is_safe_url("http://[::1]")
    assert not is_safe_url("http://10.0.0.5")
    assert not is_safe_url("http://172.16.2.3")
    assert not is_safe_url("http://192.168.1.1")
    assert not is_safe_url("http://169.254.169.254")
    assert not is_safe_url("http://[fe80::1]")
    
    # Safe direct IP
    assert is_safe_url("https://8.8.8.8")
    assert is_safe_url("http://8.8.4.4")


def test_is_safe_url_hostnames():
    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        # Unsafe hostname resolutions
        assert not is_safe_url("http://localhost")
        assert not is_safe_url("https://private-host.local")
        assert not is_safe_url("http://link-local.local")
        assert not is_safe_url("https://ipv6-link-local.local")
        
        # Safe hostname resolutions
        assert is_safe_url("https://safe-public.com")


def test_safe_url_rejects_credentials_controls_and_empty_dns_answers():
    assert not is_safe_url("https://user:secret@8.8.8.8/private")
    assert not is_safe_url("https://8.8.8.8/line\nfeed")
    with patch("socket.getaddrinfo", return_value=[]):
        assert not is_safe_url("https://no-answer.example")


def test_search_query_validation_rejects_controls_and_oversized_input():
    assert normalize_search_query("  погода   в Киеве  ") == "погода в Киеве"
    with pytest.raises(ValueError):
        normalize_search_query("погода\x00секрет")
    with pytest.raises(ValueError):
        normalize_search_query("x" * 2049)


class FakeStreamContext:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc, tb):
        return False


class FakeRawStreamResponse:
    def __init__(self, url: str, raw_body: bytes, headers: dict[str, str]):
        self.status_code = 200
        self.headers = headers
        self.request = httpx.Request("GET", url)
        self._raw_body = raw_body

    async def aiter_raw(self):
        midpoint = max(1, len(self._raw_body) // 2)
        yield self._raw_body[:midpoint]
        yield self._raw_body[midpoint:]


class FakeRawStreamClient:
    def __init__(self, response):
        self.response = response

    def stream(self, method: str, url: str):
        assert method == "GET"
        assert url == str(self.response.request.url)
        return FakeStreamContext(self.response)


@pytest.mark.asyncio
async def test_bounded_get_preserves_raw_encoded_body_for_httpx_decoding():
    settings = Settings(max_fetch_bytes=1024 * 1024)
    memory = MagicMock()
    service = WebSearchService(settings, memory)
    raw_body = gzip.compress("Compressed page text".encode("utf-8"))
    response = FakeRawStreamResponse(
        "https://safe-public.com/compressed",
        raw_body,
        {
            "content-type": "text/html; charset=utf-8",
            "content-encoding": "gzip",
            "content-length": str(len(raw_body)),
        },
    )

    returned = await service._bounded_get(FakeRawStreamClient(response), str(response.request.url))

    assert returned.text == "Compressed page text"


@pytest.mark.asyncio
async def test_safe_get_redirect_to_private():
    settings = Settings()
    memory = MagicMock()
    service = WebSearchService(settings, memory)
    
    client = MagicMock(spec=httpx.AsyncClient)
    
    # 302 Redirect to a private address
    redirect_resp = httpx.Response(
        status_code=302,
        headers={"location": "http://127.0.0.1/private-data"},
        request=httpx.Request("GET", "https://safe-public.com/redirect-to-private")
    )
    
    client.get = AsyncMock(return_value=redirect_resp)
    
    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        with pytest.raises(ValueError) as exc_info:
            await service._safe_get(client, "https://safe-public.com/redirect-to-private")
        
        assert "SSRF blocked" in str(exc_info.value)
        # The GET call should only be made to the public URL, NOT the redirect target
        client.get.assert_called_once_with("https://safe-public.com/redirect-to-private")


@pytest.mark.asyncio
async def test_safe_get_allowed_public_url():
    settings = Settings()
    memory = MagicMock()
    service = WebSearchService(settings, memory)
    
    client = MagicMock(spec=httpx.AsyncClient)
    
    success_resp = httpx.Response(
        status_code=200,
        headers={"content-type": "text/html", "content-length": "100"},
        content=b"<html>Clean source page contents</html>",
        request=httpx.Request("GET", "https://safe-public.com/index.html")
    )
    
    client.get = AsyncMock(return_value=success_resp)
    
    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        resp = await service._safe_get(client, "https://safe-public.com/index.html")
        assert resp.status_code == 200
        assert resp.text == "<html>Clean source page contents</html>"
        client.get.assert_called_once_with("https://safe-public.com/index.html")


class StaticSearchProvider:
    def __init__(self, rows):
        self.rows = rows

    async def search(self, query: str, max_results: int):
        return self.rows[:max_results]


class FailingSearchProvider:
    async def search(self, query: str, max_results: int):
        raise RuntimeError("secret provider failure")


@pytest.mark.asyncio
async def test_search_and_ingest_drops_unsafe_provider_results():
    settings = Settings()
    memory = MagicMock()
    provider = StaticSearchProvider([
        RawSearchResult(title="Localhost", url="http://127.0.0.1/admin", snippet="private snippet"),
        RawSearchResult(title="Safe", url="https://safe-public.com/page", snippet="public snippet"),
    ])
    service = WebSearchService(settings, memory, search_provider=provider)

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        results = await service.search_and_ingest("needle", max_results=5, fetch_pages=False)

    assert [result.url for result in results] == ["https://safe-public.com/page"]
    assert results[0].ingestion_status == "snippet"
    assert results[0].status_detail == "provider-snippet"
    memory.upsert_document.assert_called_once()
    assert memory.upsert_document.call_args.kwargs["url"] == "https://safe-public.com/page"


@pytest.mark.asyncio
async def test_voice_search_context_is_safe_bounded_and_never_writes_chat_memory():
    settings = Settings()
    memory = MagicMock()
    provider = StaticSearchProvider([
        RawSearchResult(title="Unsafe", url="http://127.0.0.1/admin", snippet="private"),
        RawSearchResult(title="First", url="https://safe-public.com/one", snippet="a" * 1200),
        RawSearchResult(title="Second", url="https://safe-public.com/two", snippet="public two"),
        RawSearchResult(title="Third", url="https://safe-public.com/three", snippet="public three"),
        RawSearchResult(title="Fourth", url="https://safe-public.com/four", snippet="public four"),
    ])
    service = WebSearchService(settings, memory, search_provider=provider)

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        results = await service.search_voice_context("погода в Киеве", max_results=10, fetch_pages=False)

    assert len(results) <= 3
    assert all(result.url.startswith("https://safe-public.com/") for result in results)
    assert all(len(result.snippet) <= 900 for result in results)
    assert all(result.ingestion_status == "skipped" for result in results)
    assert all(result.status_detail == "voice-context" for result in results)
    memory.upsert_document.assert_not_called()


@pytest.mark.asyncio
async def test_voice_search_context_fetches_safe_page_excerpt_without_ingesting_it():
    settings = Settings()
    memory = MagicMock()
    provider = StaticSearchProvider([
        RawSearchResult(
            title="Kyiv weather",
            url="https://safe-public.com/weather",
            snippet="Current forecast",
        ),
    ])
    service = WebSearchService(settings, memory, search_provider=provider)
    service._safe_get = AsyncMock(return_value=httpx.Response(
        status_code=200,
        headers={"content-type": "text/html; charset=utf-8"},
        text="<html><title>Kyiv weather now</title><main><p>Сейчас в Киеве плюс двадцать градусов.</p></main></html>",
        request=httpx.Request("GET", "https://safe-public.com/weather"),
    ))

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        results = await service.search_voice_context("погода в Киеве", max_results=1)

    assert len(results) == 1
    assert results[0].snippet == "Сейчас в Киеве плюс двадцать градусов."
    assert results[0].status_detail == "voice-page-context"
    memory.upsert_document.assert_not_called()


@pytest.mark.asyncio
async def test_search_and_ingest_continues_when_provider_fails_with_direct_url():
    settings = Settings()
    memory = MagicMock()
    service = WebSearchService(settings, memory, search_provider=FailingSearchProvider())

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        results = await service.search_and_ingest("прочитай https://safe-public.com/page", max_results=5, fetch_pages=False)

    assert [result.url for result in results] == ["https://safe-public.com/page"]
    assert results[0].ingestion_status == "snippet"
    assert results[0].status_detail == "provider-snippet"
    memory.upsert_document.assert_called_once()


@pytest.mark.asyncio
async def test_search_and_ingest_direct_url_does_not_mix_provider_results():
    settings = Settings()
    memory = MagicMock()
    provider = StaticSearchProvider([
        RawSearchResult(
            title="Unrelated provider result",
            url="https://unrelated.example/page",
            snippet="This must not be mixed into a direct page inspection.",
        ),
    ])
    service = WebSearchService(settings, memory, search_provider=provider)

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        results = await service.search_and_ingest(
            "зацени сайт https://safe-public.com/page#contact",
            max_results=5,
            fetch_pages=False,
        )

    assert [result.url for result in results] == ["https://safe-public.com/page"]
    assert all(result.title != "Unrelated provider result" for result in results)


@pytest.mark.asyncio
async def test_search_and_ingest_returns_empty_when_provider_fails_without_direct_url():
    settings = Settings()
    memory = MagicMock()
    service = WebSearchService(settings, memory, search_provider=FailingSearchProvider())

    results = await service.search_and_ingest("обычный поисковый запрос", max_results=5, fetch_pages=False)

    assert results == []
    memory.upsert_document.assert_not_called()


def test_search_api_rejects_blank_or_oversized_query_before_provider(monkeypatch, tmp_path: Path):
    settings = Settings(
        api_token="test-token",
        disable_api_token=False,
        data_dir=tmp_path / "data",
        db_path=tmp_path / "data" / "memory.sqlite3",
    )
    calls = []

    class FailingSearchService:
        async def search_and_ingest(self, query: str, max_results: int, fetch_pages: bool):
            calls.append((query, max_results, fetch_pages))
            return []

    monkeypatch.setattr(main_module, "settings", settings)
    monkeypatch.setattr(main_module, "search_service", FailingSearchService())
    client = TestClient(main_module.app, raise_server_exceptions=False)
    headers = {"X-Oscar-Token": "test-token"}

    blank = client.post(
        "/api/search",
        headers=headers,
        json={"query": "   \n\t", "max_results": 5, "fetch_pages": False},
    )
    oversized = client.post(
        "/api/search",
        headers=headers,
        json={"query": "x" * 2049, "max_results": 5, "fetch_pages": False},
    )

    assert blank.status_code == 422
    assert oversized.status_code == 422
    assert calls == []


def test_extract_query_url_results_cleans_tracking_and_punctuation():
    results = extract_query_url_results(
        "Проверь https://example.com/page?utm_source=x&id=42). Потом https://example.com/page?id=42#frag",
        limit=5,
    )

    assert len(results) == 1
    assert results[0].url == "https://example.com/page?id=42"
    assert results[0].title == "example.com"


@pytest.mark.asyncio
async def test_download_links_are_not_fetched_as_web_pages():
    service = WebSearchService(Settings(api_token="test"), MagicMock())
    client = AsyncMock()
    result = SearchResult(
        title="Windows installer",
        url="https://download.example.com/jdk-17-windows-x64.exe",
        snippet="Direct installer link",
    )

    returned = await service._fetch_and_ingest(client, result)

    assert returned.ingestion_status == "skipped"
    assert returned.status_detail == "download-url"
    client.stream.assert_not_called()


@pytest.mark.asyncio
async def test_search_and_ingest_direct_url_without_provider_results():
    settings = Settings()
    memory = MagicMock()
    provider = StaticSearchProvider([])
    service = WebSearchService(settings, memory, search_provider=provider)

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        results = await service.search_and_ingest("прочитай https://safe-public.com/page", max_results=5, fetch_pages=False)

    assert [result.url for result in results] == ["https://safe-public.com/page"]
    assert results[0].ingestion_status == "snippet"
    memory.upsert_document.assert_called_once()
    assert memory.upsert_document.call_args.kwargs["url"] == "https://safe-public.com/page"
    assert memory.upsert_document.call_args.kwargs["source"] == "search-snippet"


@pytest.mark.asyncio
async def test_search_and_ingest_blocks_direct_unsafe_url():
    settings = Settings()
    memory = MagicMock()
    provider = StaticSearchProvider([])
    service = WebSearchService(settings, memory, search_provider=provider)

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        results = await service.search_and_ingest("прочитай http://localhost/admin", max_results=5, fetch_pages=False)

    assert results == []
    memory.upsert_document.assert_not_called()


@pytest.mark.asyncio
async def test_fetch_blocked_redirect_does_not_ingest_snippet():
    settings = Settings()
    memory = MagicMock()
    service = WebSearchService(settings, memory)
    result = RawSearchResult(
        title="Redirect",
        url="https://safe-public.com/redirect-to-private",
        snippet="do not ingest private redirect snippet",
    )
    service_result = SearchResult(
        title=result.title,
        url=result.url,
        snippet=result.snippet,
    )
    client = MagicMock(spec=httpx.AsyncClient)
    client.get = AsyncMock(return_value=httpx.Response(
        status_code=302,
        headers={"location": "http://127.0.0.1/private-data"},
        request=httpx.Request("GET", result.url),
    ))

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        returned = await service._fetch_and_ingest(client, service_result)

    assert returned.ingested is False
    assert returned.ingestion_status == "blocked"
    assert returned.status_detail == "unsafe-url"
    memory.upsert_document.assert_not_called()


@pytest.mark.asyncio
async def test_unsupported_content_ingests_only_snippet_with_status():
    settings = Settings()
    memory = MagicMock()
    service = WebSearchService(settings, memory)
    service_result = SearchResult(
        title="PDF",
        url="https://safe-public.com/report.pdf",
        snippet="public report summary",
    )
    client = MagicMock(spec=httpx.AsyncClient)
    client.get = AsyncMock(return_value=httpx.Response(
        status_code=200,
        headers={"content-type": "application/pdf", "content-length": "100"},
        content=b"%PDF",
        request=httpx.Request("GET", service_result.url),
    ))

    with patch("socket.getaddrinfo", side_effect=mock_getaddrinfo):
        returned = await service._fetch_and_ingest(client, service_result)

    assert returned.ingested is True
    assert returned.ingestion_status == "snippet"
    assert returned.status_detail == "unsupported-content"
    memory.upsert_document.assert_called_once()
    assert memory.upsert_document.call_args.kwargs["source"] == "search-snippet"


def test_tracking_params_are_removed_for_normalization_and_dedupe():
    cleaned = normalize_result_url("https://example.com/page?utm_source=x&id=42&fbclid=abc#section")
    assert cleaned == "https://example.com/page?id=42"
    assert canonical_url_key("https://example.com/page?id=42&utm_campaign=x") == canonical_url_key("https://example.com/page?utm_medium=y&id=42")
