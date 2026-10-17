"""Upgrading a database written by Monarch 0.3.0.99 (synthetic content only).

The fixture was produced by the 0.3.0.99 backend itself: eight records in the
old categories (one pinned), nine indexed turns in three chats.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from oscar_agent.context_settings import ContextSettingsStore
from oscar_agent.memory_v4 import MemoryV4Service
from test_memory_v4 import make_settings

FIXTURE = Path(__file__).parent / "fixtures" / "memory-0.3.0.99.txt"
TEXTS = {"Меня зовут Тестер", "Предпочитаю короткие ответы", "Проект Альфа на Rust", "Город пишется Варна, не Варно",
         "Купить молоко", "Любимый цвет бирюзовый", "Всегда отвечай на русском", "Живу в Пловдиве"}


def install(tmp_path: Path):
    settings = make_settings(tmp_path)
    Path(settings.db_path).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(settings.db_path) as con:
        con.executescript(FIXTURE.read_text(encoding="utf-8"))
    return settings


def rows(settings) -> dict[str, int]:
    with sqlite3.connect(settings.db_path) as con:
        return {table: con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                for table in ("memory_items", "memory_episodes", "conversation_messages")}


def test_upgrade_keeps_every_record_and_recalls_old_facts(tmp_path):
    settings = install(tmp_path)
    before = rows(settings)
    for _ in range(2):  # the second start must be a no-op
        context = ContextSettingsStore(settings)
        service = MemoryV4Service(settings)
        assert service.init_error is None
        assert "failed" not in context.migration_diagnostic
        service.close()
    assert rows(settings) == before
    with sqlite3.connect(settings.db_path) as con:
        items = dict(con.execute("SELECT content, category FROM memory_items WHERE deleted_at IS NULL"))
    assert set(items) == TEXTS
    assert set(items.values()) <= {"about", "preference", "rule", "project", "note"}
    assert items["Всегда отвечай на русском"] == "rule"
    service = MemoryV4Service(settings)
    try:
        result = service.retrieve("в каком городе я живу?", {"type": "chat"})
        assert "Живу в Пловдиве" in [item["text"] for item in result["explicitMemories"]]
        episodes = service.retrieve("что любит кот Барсик?", {"type": "chat"})["episodes"]
        assert episodes and all("Барсик" in item["text"] for item in episodes)
    finally:
        service.close()


@pytest.mark.parametrize("stage", ["index", "categories"])
def test_failed_upgrade_keeps_data_and_retries(tmp_path, monkeypatch, stage):
    settings = install(tmp_path)
    before = rows(settings)

    def broken(*args, **kwargs):
        raise sqlite3.OperationalError("injected")

    if stage == "index":
        monkeypatch.setattr("oscar_agent.memory_v4.initialize_index", broken)
        service = MemoryV4Service(settings)
        assert service.init_error == "memory-init-failed:OperationalError"
        service.start_background()  # must not spin on a broken store
        service.close()
    else:
        monkeypatch.setattr(ContextSettingsStore, "_map_memory_categories", broken)
        context = ContextSettingsStore(settings)
        assert "memory-categories-v41-failed:OperationalError" in context.migration_diagnostic
    assert rows(settings) == before
    monkeypatch.undo()
    context = ContextSettingsStore(settings)
    service = MemoryV4Service(settings)
    try:
        assert service.init_error is None and "failed" not in context.migration_diagnostic
        assert rows(settings) == before
    finally:
        service.close()
