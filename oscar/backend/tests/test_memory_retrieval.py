"""Memory 4.1 recall: morphology, profile core, stored vectors, gates.

Disposable databases and synthetic content only; the real E5 model is used
only when it is installed on this machine.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from oscar_agent.main import memory_context_sources
from oscar_agent.memory_text import query_terms, stem, stem_text
from oscar_agent.memory_v4 import MemoryV4Service
from oscar_agent.model_runtime import render_memory_for_prompt
from oscar_agent.schemas import ChatSource
from test_memory_v4 import (LOCAL_E5, POLICY_HASH, DeterministicReranker, append_turn, make_services,
                            make_settings)


def remember(context, request_id: str, text: str, category: str, revision: int, **extra) -> int:
    return context.execute(
        client_request_id=request_id, command="memory.create", scope={"type": "chat"},
        expected_revision=revision, payload={"text": text, "category": category, **extra},
        policy_decision_hash=POLICY_HASH,
    )["revision"]


def test_russian_inflections_share_a_stem():
    assert stem("Варна") == stem("Варне") == stem("Варной")
    assert stem("погода") == stem("погоду") == stem("погоды")
    assert stem("книги") == stem("книгах")
    assert stem("cities") == "city"
    assert query_terms("Какая погода будет завтра в Варне?") == ["погод", "завтр", "варн"]


def test_an_inflected_question_finds_the_record(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        remember(context, "city", "Квартира в Варне на третьем этаже", "note", 0)
        result = service.retrieve("какой этаж квартиры в Варна", {"type": "chat"})
        assert [item["text"] for item in result["explicitMemories"]] == ["Квартира в Варне на третьем этаже"]
    finally:
        service.close()


def test_profile_core_comes_along_but_unrelated_notes_do_not(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        revision = remember(context, "about", "Живу в Варне", "about", 0)
        revision = remember(context, "rule", "Отвечай кратко", "rule", revision)
        remember(context, "note", "Ключ от гаража у соседа", "note", revision)
        result = service.retrieve("какая завтра погода?", {"type": "chat"})
        texts = [item["text"] for item in result["explicitMemories"]]
        assert texts[0] == "Отвечай кратко"  # rules lead the profile core
        assert set(texts) == {"Живу в Варне", "Отвечай кратко"}
        assert {item["reason"] for item in result["explicitMemories"]} == {"profile:rule", "profile:about"}
    finally:
        service.close()


def test_profile_core_is_bounded(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    service.PROFILE_LIMIT = 2
    try:
        revision = 0
        for index in range(5):
            revision = remember(context, f"about-{index}", f"Факт обо мне номер {index}", "about", revision)
        result = service.retrieve("привет", {"type": "chat"})
        assert len([item for item in result["explicitMemories"] if item["reason"].startswith("profile")]) == 2
    finally:
        service.close()


def test_legacy_categories_map_to_the_five_plain_ones(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        revision = remember(context, "legacy-profile", "Меня зовут Тест", "profile", 0)
        revision = remember(context, "legacy-instruction", "Пиши без смайликов", "instruction", revision)
        remember(context, "legacy-fact", "Проект на SQLite", "fact", revision)
        records = context.read("memory", {"type": "chat"})["value"]["records"]
        assert sorted(record["category"] for record in records) == ["about", "note", "rule"]
    finally:
        service.close()


def test_category_migration_maps_existing_rows_once(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    remember(context, "row", "Старая запись", "note", 0)
    service.close()
    with sqlite3.connect(service.db_path) as con:
        con.execute("UPDATE memory_items SET category = 'instruction'")
        con.execute("DELETE FROM settings_migrations WHERE migration_id = 'memory-categories-v41'")
    _memory, context, service = make_services(tmp_path)
    try:
        assert context.read("memory", {"type": "chat"})["value"]["records"][0]["category"] == "rule"
    finally:
        service.close()


def test_vectors_are_written_in_background_and_used_for_paraphrases(tmp_path: Path):
    memory, _context, service = make_services(tmp_path)
    service.reranker.close()
    service.reranker = DeterministicReranker()  # type: ignore[assignment]
    try:
        append_turn(memory, conversation_id="old", turn_id="peach", user_text="Какую палитру выбрать?",
                    assistant_text="Выбрали мягкую персиковую палитру.")
        append_turn(memory, conversation_id="old", turn_id="db", user_text="Обнови базу данных",
                    assistant_text="Миграция SQLite завершена.")
        for turn in ("peach", "db"):
            service.index_turn(conversation_id="old", turn_id=turn, source="desktop")
        before = service.retrieve("какой цвет интерфейса?", {"type": "chat"})
        assert before["episodes"] == [] and before["rerankerStatus"] == "reranker-unavailable"
        service._embed_pending()
        after = service.retrieve("какой цвет интерфейса?", {"type": "chat"})
        assert [item["origin"]["turnId"] for item in after["episodes"]] == ["peach"]
        assert after["rerankerStatus"] == "reranker-ready"
        with sqlite3.connect(service.db_path) as con:
            assert con.execute("SELECT COUNT(*) FROM memory_vectors").fetchone()[0] == 2
    finally:
        service.close()


def test_changed_model_or_text_recomputes_the_vector(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    service.reranker.close()
    service.reranker = DeterministicReranker()  # type: ignore[assignment]
    try:
        receipt = context.execute(client_request_id="v", command="memory.create", scope={"type": "chat"},
                                  expected_revision=0, payload={"text": "Синий", "category": "note"},
                                  policy_decision_hash=POLICY_HASH)
        service._embed_pending()
        item_id = receipt["result"]["record"]["id"]
        context.execute(client_request_id="v2", command="memory.update", scope={"type": "chat"},
                        expected_revision=1, payload={"id": item_id, "text": "Персиковый"},
                        policy_decision_hash=POLICY_HASH)
        service._embed_pending()
        service.reranker.model_id = "other-model"
        service._embed_pending()
        with sqlite3.connect(service.db_path) as con:
            row = con.execute("SELECT model_id, content_hash FROM memory_vectors WHERE owner_id = ?", (item_id,)).fetchone()
            current = con.execute("SELECT content_hash FROM memory_items WHERE id = ?", (item_id,)).fetchone()[0]
        assert row == ("other-model", current)
    finally:
        service.close()


def test_two_episodes_at_most_from_one_conversation(tmp_path: Path):
    memory, _context, service = make_services(tmp_path)
    try:
        for index in range(4):
            append_turn(memory, conversation_id="long", turn_id=f"t{index}", user_text=f"ремонт кухни этап {index}",
                        assistant_text=f"Про ремонт кухни, шаг {index}.")
            service.index_turn(conversation_id="long", turn_id=f"t{index}", source="desktop")
        result = service.retrieve("ремонт кухни", {"type": "chat"})
        assert len(result["episodes"]) == 2
    finally:
        service.close()


def test_superseded_and_suggested_records_stay_out_of_answers(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    try:
        revision = remember(context, "a", "Живу в Варне", "about", 0)
        remember(context, "b", "Люблю горький шоколад", "preference", revision)
        with sqlite3.connect(service.db_path) as con:
            con.execute("UPDATE memory_items SET status = 'superseded' WHERE content = 'Живу в Варне'")
            con.execute("UPDATE memory_items SET origin = 'suggested' WHERE content = 'Люблю горький шоколад'")
        service.invalidate_cache()
        assert service.retrieve("Варна шоколад", {"type": "chat"})["explicitMemories"] == []
    finally:
        service.close()


def test_hygiene_purges_long_deleted_records_and_orphan_vectors(tmp_path: Path):
    _memory, context, service = make_services(tmp_path)
    service.reranker.close()
    service.reranker = DeterministicReranker()  # type: ignore[assignment]
    try:
        receipt = context.execute(client_request_id="old", command="memory.create", scope={"type": "chat"},
                                  expected_revision=0, payload={"text": "Удалённая запись", "category": "note"},
                                  policy_decision_hash=POLICY_HASH)
        service._embed_pending()
        item_id = receipt["result"]["record"]["id"]
        context.execute(client_request_id="del", command="memory.delete", scope={"type": "chat"},
                        expected_revision=1, payload={"id": item_id}, policy_decision_hash=POLICY_HASH)
        # Still restorable, but its vector is derived state and goes at once.
        assert service.run_hygiene() == {"items": 0, "vectors": 1, "receipts": 0}
        with sqlite3.connect(service.db_path) as con:
            con.execute("UPDATE memory_items SET deleted_at = '2020-01-01T00:00:00+00:00'")
        assert service.run_hygiene()["items"] == 1
    finally:
        service.close()


def test_stems_of_older_rows_are_repaired(tmp_path: Path):
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(memory, conversation_id="c", turn_id="t", user_text="Поездка в Варну летом",
                    assistant_text="Отличный план.")
        service.index_turn(conversation_id="c", turn_id="t", source="desktop")
        with sqlite3.connect(service.db_path) as con:
            con.execute("UPDATE memory_episodes SET search_stems = '', stems_version = 0")
        service._repair_stems()
        with sqlite3.connect(service.db_path) as con:
            stems, version = con.execute("SELECT search_stems, stems_version FROM memory_episodes").fetchone()
        assert "варн" in stems.split() and version >= 1
    finally:
        service.close()


def test_memory_is_rendered_as_its_own_typed_block():
    context = {
        "explicitMemories": [
            {"kind": "explicit", "id": "r1", "text": "Отвечай кратко", "title": "", "createdAt": "2026-01-01",
             "score": 1.0, "reason": "profile:rule", "origin": {}},
            {"kind": "explicit", "id": "a1", "text": "Живу в Варне", "title": "", "createdAt": "2026-01-01",
             "score": 1.0, "reason": "profile:about", "origin": {}},
        ],
        "episodes": [{"kind": "episode", "id": "e1", "text": "Пользователь: борщ <b>", "title": "Кухня",
                      "createdAt": "2026-02-03T10:00:00+00:00", "score": 0.8, "reason": "semantic",
                      "origin": {"conversationId": "c1", "turnId": "t1"}}],
    }
    sources = memory_context_sources(context)
    assert [source.url for source in sources] == ["memory://profile/r1?rule", "memory://profile/a1",
                                                  "memory://chat/c1?item=e1"]
    block = render_memory_for_prompt(sources, 4000)
    assert block.splitlines() == [
        "<memory>", "<rule>Отвечай кратко</rule>", "<about>Живу в Варне</about>",
        '<past_chat date="2026-02-03">Пользователь: борщ &lt;b&gt;</past_chat>', "</memory>",
    ]


def test_web_results_no_longer_push_memory_out():
    web = [ChatSource(id=i, title=f"page {i}", url=f"https://example.com/{i}", excerpt="x") for i in range(14)]
    memory = memory_context_sources({"explicitMemories": [
        {"kind": "explicit", "id": "m", "text": "Живу в Варне", "title": "", "createdAt": "2026-01-01",
         "score": 1.0, "reason": "profile:about", "origin": {}}], "episodes": []})
    merged = [*web[:12], *memory]
    assert merged[-1].url == "memory://profile/m"


@pytest.mark.skipif(
    not (LOCAL_E5 / "onnx" / "model_quantized.onnx").is_file(),
    reason="optional local multilingual E5 fixture is not installed",
)
def test_installed_e5_recalls_a_paraphrase_and_ignores_small_talk(tmp_path: Path):
    settings = make_settings(tmp_path).model_copy(update={"memory_embedding_model_dir": LOCAL_E5})
    from oscar_agent.context_settings import ContextSettingsStore
    from oscar_agent.memory import MemoryStore
    memory = MemoryStore(settings)
    ContextSettingsStore(settings)
    service = MemoryV4Service(settings)
    try:
        for index, (user, answer) in enumerate((
            ("Как приготовить борщ?", "Нужна свёкла, капуста, картофель и мясо."),
            ("Курс доллара к леву?", "Примерно 1.8 лева за доллар."),
            ("Посоветуй книгу по истории", "Попробуй «Sapiens»."),
            ("Как настроить роутер?", "Зайдите на 192.168.0.1."),
        )):
            append_turn(memory, conversation_id=f"c{index}", turn_id=f"t{index}", user_text=user, assistant_text=answer)
            service.index_turn(conversation_id=f"c{index}", turn_id=f"t{index}", source="desktop")
        service._embed_pending()
        soup = service.retrieve("что приготовить на обед из свёклы?", {"type": "chat"})
        assert [item["origin"]["turnId"] for item in soup["episodes"]] == ["t0"]
        assert service.retrieve("привет, как дела?", {"type": "chat"})["episodes"] == []
    finally:
        service.close()


def test_stem_text_is_deterministic():
    assert stem_text("Живу в Варне", "летом") == stem_text("Живу в Варне", "летом") == "жив в варн лет"
