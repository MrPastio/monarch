"""Monarch Security stage 3e for Oscar's data folder.

A harmless unique marker goes through the ordinary memory paths — a chat
message, a memory item, a saved page — and is then searched for in every file
of the data folder (the database, its WAL and shared-memory files) and in the
log records. With sealed storage it must be found nowhere; with storage
encryption off the same scan has to find it, which proves the scan works.
"""

import importlib
import logging
import os
import secrets
from pathlib import Path

import pytest

from oscar_agent import secure_db
from oscar_agent.config import Settings
from oscar_agent.memory import MemoryStore


@pytest.fixture(autouse=True)
def restore_plain_mode():
    yield
    for name in ("OSCAR_STORE_PROTECTION", "OSCAR_DB_KEY"):
        os.environ.pop(name, None)
    importlib.reload(secure_db)


def run_profile(monkeypatch, tmp_path: Path, caplog, *, sealed: bool):
    for name in ("OSCAR_STORE_PROTECTION", "OSCAR_DB_KEY"):
        monkeypatch.delenv(name, raising=False)
    if sealed:
        monkeypatch.setenv("OSCAR_STORE_PROTECTION", "sealed")
        monkeypatch.setenv("OSCAR_DB_KEY", secrets.token_hex(32))
    importlib.reload(secure_db)
    marker = "MARKER" + secrets.token_hex(8)
    settings = Settings(
        data_dir=tmp_path / "data",
        db_path=tmp_path / "data" / "memory.sqlite3",
        offload_dir=tmp_path / "offload",
        workspace_root=tmp_path / "workspace",
        workspace_generated_dir=tmp_path / "workspace" / "artifacts" / "generated",
        gemma_models_dir=tmp_path / "models",
        qwen_models_dir=tmp_path / "qwen-models",
        coder_models_dir=tmp_path / "coder-models",
        mock_model=True,
    )
    settings.db_path = secure_db.prepare(settings.db_path)
    caplog.set_level(logging.DEBUG)
    store = MemoryStore(settings)
    conversation = store.create_conversation("Проверка")
    store.append_conversation_message(conversation["id"], "user", f"Что значит слово {marker}?")
    store.append_conversation_message(conversation["id"], "assistant", f"Ответ про {marker}.")
    store.create_memory_item(f"Любимое слово {marker}")
    store.upsert_document(url=None, title="Заметка", text=f"Заметка про {marker} и ещё немного текста.", source="note")
    assert marker in str(store.get_conversation(conversation["id"]))
    assert store.search(marker)

    hits = []
    for file in tmp_path.rglob("*"):
        if file.is_file():
            data = file.read_bytes()
            if marker.encode() in data or marker.encode("utf-16-le") in data:
                hits.append(file.relative_to(tmp_path).as_posix())
    return marker, hits, caplog.text


def test_sealed_profile_keeps_the_marker_out_of_every_file_and_log(monkeypatch, tmp_path, caplog):
    marker, hits, log_text = run_profile(monkeypatch, tmp_path, caplog, sealed=True)
    assert hits == []
    assert marker not in log_text


def test_scan_finds_the_marker_when_storage_encryption_is_off(monkeypatch, tmp_path, caplog):
    _, hits, _ = run_profile(monkeypatch, tmp_path, caplog, sealed=False)
    assert any(hit.startswith("data/memory.sqlite3") for hit in hits)


def test_access_log_keeps_the_path_and_drops_search_text():
    from oscar_agent.main import AccessLogWithoutQuery

    marker = "MARKER" + secrets.token_hex(8)
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:5000", "GET", f"/api/memory/search?q={marker}&limit=6", "1.1", 200), None)
    assert AccessLogWithoutQuery().filter(record)
    assert record.getMessage() == '127.0.0.1:5000 - "GET /api/memory/search HTTP/1.1" 200'


def test_search_fetch_logs_name_the_site_not_the_page(monkeypatch, tmp_path, caplog):
    import asyncio

    import httpx

    from oscar_agent.schemas import SearchResult
    from oscar_agent.search import WebSearchService

    marker = "MARKER" + secrets.token_hex(8)
    service = WebSearchService.__new__(WebSearchService)
    service.semaphore = asyncio.Semaphore(1)
    service.memory = None

    async def failing_get(client, url):
        raise httpx.ConnectError(f"cannot reach {url}")

    service._safe_get = failing_get
    service._ingest_snippet = lambda result, reason: None
    caplog.set_level(logging.DEBUG)
    result = SearchResult(title="t", url=f"https://example.org/{marker}?q={marker}", snippet="s")
    asyncio.run(service._fetch_and_ingest(None, result))
    assert "example.org" in caplog.text
    assert marker not in caplog.text
