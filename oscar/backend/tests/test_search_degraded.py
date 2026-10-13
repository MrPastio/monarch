"""When the search engines refuse, the answer rests on Wikipedia or on pages read
earlier, and the person is told so in plain words."""
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from oscar_agent import main as main_module
from oscar_agent import search as search_module
from oscar_agent.config import Settings
from oscar_agent.memory import MemoryStore
from oscar_agent.schemas import ChatMessage, ChatRequest, ChatSource, SearchResult
from oscar_agent.search import (
    DuckDuckGoProvider,
    RawSearchResult,
    WebSearchService,
    search_notice,
    search_state,
)
from oscar_agent.web_engines import EngineRouter, NoResults, TEXT_ENGINES_LATIN


def settings_for(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data", db_path=tmp_path / "data" / "memory.sqlite3",
                    offload_dir=tmp_path / "offload", workspace_root=tmp_path / "workspace")


@pytest.mark.asyncio
async def test_engines_refusing_fall_back_to_wikipedia_and_confirm_the_refusal(monkeypatch):
    def refuse(*_args):
        raise NoResults()

    router = EngineRouter(timeout=1.0, runner=refuse)
    monkeypatch.setattr(search_module, "WEB_ENGINES", router)
    provider = DuckDuckGoProvider(5.0)
    monkeypatch.setattr(provider, "_duckduckgo_html", lambda *_args: [])
    monkeypatch.setattr(provider, "_wikipedia_sync", lambda query, limit: [
        RawSearchResult(title="SpaceX Starship", url="https://ru.wikipedia.org/wiki/SpaceX_Starship",
                        snippet="Starship", origin="wikipedia"),
    ])
    results = await provider.search("python asyncio timeout", 5)
    assert [result.origin for result in results] == ["wikipedia"]
    # Nobody answered, Wikipedia did: the engines refused and now rest.
    assert any(health.failures for health in router.health.values())


def test_saved_pages_carry_the_date_they_were_saved(tmp_path):
    store = MemoryStore(settings_for(tmp_path))
    store.upsert_document(url="https://news.example/starship", title="Starship flight 14",
                          text="Starship flight 14 reached orbit and deployed Starlink satellites.", source="web")
    store.upsert_document(url=None, title="note", text="Starship flight in my private note", source="user-note")
    found = store.search_saved_pages("Starship flight orbit")
    assert [hit.url for hit, _saved in found] == ["https://news.example/starship"]
    assert len(found[0][1]) == 10


@pytest.mark.asyncio
async def test_context_without_engine_results_uses_saved_pages(tmp_path):
    store = MemoryStore(settings_for(tmp_path))
    store.upsert_document(url="https://news.example/starship", title="Starship flight 14",
                          text="Starship flight 14 reached orbit and deployed Starlink satellites.", source="web")
    service = WebSearchService(settings_for(tmp_path), store, search_provider=MagicMock())

    async def nothing(*_args):
        return []

    service._collect_safe_results = nothing
    results = await service.search_context("Starship flight orbit", False)
    assert [(result.origin, result.url) for result in results] == [("saved", "https://news.example/starship")]
    assert results[0].saved_at


def test_states_and_notices(monkeypatch):
    assert search_state(["engine", "saved"], searched=True) == "ok"
    assert search_state(["wikipedia", "saved"], searched=True) == "wikipedia"
    assert search_state(["saved"], searched=True) == "saved"
    assert search_state([], searched=False) == "ok"
    router = EngineRouter(timeout=1.0, runner=lambda *_args: [])
    monkeypatch.setattr(search_module, "WEB_ENGINES", router)
    assert search_state([], searched=True) == "empty"
    for engine in TEXT_ENGINES_LATIN + ("yandex",):
        router._failed(engine, "test")
    assert search_state([], searched=True) == "unavailable"
    assert "Википедии" in search_notice("wikipedia")
    assert "читал раньше" in search_notice("saved")
    assert "через пару минут" in search_notice("unavailable")
    assert search_notice("ok") == ""


@pytest.mark.asyncio
async def test_local_answer_opens_with_the_notice_when_only_saved_pages_were_found(monkeypatch):
    async def no_results(*_args, **_kwargs):
        return []

    monkeypatch.setattr(main_module.search_service, "search_and_ingest", no_results)
    monkeypatch.setattr(main_module.search_service, "saved_pages", lambda query, limit=4: [
        SearchResult(title="Starship flight 14", url="https://news.example/starship",
                                 snippet="Starship reached orbit", origin="saved", saved_at="2026-09-30"),
    ])
    request = ChatRequest(messages=[ChatMessage(role="user", content="что со Starship")], web_search=True,
                          research_mode="off", use_memory=False)
    sources = await main_module.prepare_sources(request, ["Starship"])
    assert [(source.origin, source.title, source.saved_at) for source in sources] == [("saved", "Starship flight 14", "2026-09-30")]
    assert "читал раньше" in main_module.web_search_notice(request, sources)
    engine_sources = [ChatSource(id=1, title="t", url="https://a.example", excerpt="e", origin="engine")]
    assert main_module.web_search_notice(request, engine_sources) == ""


def test_sources_keep_their_dates_from_search_through_history():
    from oscar_agent.memory import serialize_conversation_sources, deserialize_conversation_sources
    from oscar_agent.model_runtime import render_sources_for_prompt

    results = [SearchResult(title="Flight 14", url="https://news.example/f14", snippet="orbit",
                            published="2026-09-28T10:00:00Z", origin="engine")]
    hit = ChatSource(id=1, title="Flight 14", url="https://news.example/f14", excerpt="orbit")
    [source] = main_module.with_origins([hit], results)
    assert (source.origin, source.published) == ("engine", "2026-09-28")
    prompt = render_sources_for_prompt([source], 4000)
    assert 'published="2026-09-28"' in prompt and prompt.startswith('<source id="1" title="Flight 14"')

    # MAX sources arrive as snippet/savedAt; both survive a reload, junk dates do not.
    stored = deserialize_conversation_sources(serialize_conversation_sources([
        source,
        {"title": "Wiki", "url": "https://ru.wikipedia.org/wiki/X", "snippet": "text", "origin": "wikipedia"},
        {"title": "Old", "url": "https://old.example", "snippet": "s", "origin": "saved", "savedAt": "2026-09-30"},
        {"title": "Bad", "url": "https://bad.example", "snippet": "s", "origin": "evil", "published": "yesterday"},
    ]))
    assert [(item.get("origin"), item.get("published"), item.get("saved_at"), item["excerpt"]) for item in stored] == [
        ("engine", "2026-09-28", None, "orbit"),
        ("wikipedia", None, None, "text"),
        ("saved", None, "2026-09-30", "s"),
        (None, None, None, "s"),
    ]
