from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from oscar_agent.config import Settings
from oscar_agent.context_settings import ContextSettingsStore
from oscar_agent.memory import MemoryStore
from oscar_agent.memory_v4 import MemoryV4Service, RetrievalCandidate
from oscar_agent.semantic_memory import SemanticMemoryReranker, SemanticRerankResult


POLICY_HASH = "b" * 64
LOCAL_E5 = Path("E:/") / "MonarchData" / "models" / "memory" / "multilingual-e5-small"


def make_settings(tmp_path: Path, *, budget: int = 2400) -> Settings:
    return Settings(
        data_dir=tmp_path / "data" / "oscar",
        db_path=tmp_path / "data" / "oscar" / "memory" / "oscar_memory.sqlite3",
        offload_dir=tmp_path / "offload",
        workspace_root=tmp_path / "workspace",
        workspace_generated_dir=tmp_path / "workspace" / "artifacts" / "generated",
        gemma_models_dir=tmp_path / "models",
        coder_models_dir=tmp_path / "coder-models",
        memory_embedding_model_dir=tmp_path / "missing-e5",
        memory_prompt_budget_chars=budget,
        mock_model=True,
    )


def make_services(tmp_path: Path, *, budget: int = 2400) -> tuple[MemoryStore, ContextSettingsStore, MemoryV4Service]:
    settings = make_settings(tmp_path, budget=budget)
    memory = MemoryStore(settings)
    context = ContextSettingsStore(settings)
    return memory, context, MemoryV4Service(settings)


def create_explicit(
    context: ContextSettingsStore,
    *,
    request_id: str,
    text: str,
    scope: dict[str, str] | None = None,
    expected_revision: int = 0,
    pinned: bool = False,
) -> dict:
    return context.execute(
        client_request_id=request_id,
        command="memory.create",
        scope=scope or {"type": "chat"},
        expected_revision=expected_revision,
        payload={"text": text, "category": "fact", "pinned": pinned},
        policy_decision_hash=POLICY_HASH,
    )


def append_turn(
    memory: MemoryStore,
    *,
    conversation_id: str,
    turn_id: str,
    user_text: str,
    assistant_text: str,
    outcome: str = "answered",
    task_id: str | None = None,
) -> None:
    memory.append_conversation_message(
        conversation_id,
        "user",
        user_text,
        client_message_id=f"user_{turn_id}",
        turn_id=turn_id,
    )
    memory.append_conversation_message(
        conversation_id,
        "assistant",
        assistant_text,
        client_message_id=f"assistant_{turn_id}",
        turn_id=turn_id,
        task_id=task_id,
        outcome=outcome,
    )


def test_explicit_memory_is_strictly_isolated_between_chat_and_coder_scopes(tmp_path: Path) -> None:
    _memory, context, service = make_services(tmp_path)
    try:
        create_explicit(context, request_id="chat-memory", text="Любимый цвет пользователя ультрамариновый")
        create_explicit(
            context,
            request_id="coder-memory",
            text="Проект использует уникальный пакет ProjectNeedle",
            scope={"type": "coder-project", "projectId": "project-alpha"},
        )

        chat = service.retrieve("ультрамариновый", {"type": "chat"})
        coder = service.retrieve("ProjectNeedle", {"type": "coder-project", "projectId": "project-alpha"})
        other = service.retrieve("ProjectNeedle", {"type": "coder-project", "projectId": "project-beta"})

        assert [item["text"] for item in chat["explicitMemories"]] == [
            "Любимый цвет пользователя ультрамариновый"
        ]
        assert [item["text"] for item in coder["explicitMemories"]] == [
            "Проект использует уникальный пакет ProjectNeedle"
        ]
        assert other["explicitMemories"] == []
        assert "ProjectNeedle" not in json.dumps(chat, ensure_ascii=False)
        assert "ультрамариновый" not in json.dumps(coder, ensure_ascii=False)
    finally:
        service.close()


def test_only_successful_persistent_desktop_answer_turns_become_episodes(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(
            memory,
            conversation_id="chat-ok",
            turn_id="turn-ok",
            user_text="Как мы исправили сборку Rust?",
            assistant_text="Починили feature-флаг cargo и lockfile.",
        )
        append_turn(
            memory,
            conversation_id="chat-failed",
            turn_id="turn-failed",
            user_text="Секретный неуспешный запрос",
            assistant_text="Ошибка",
            outcome="failed",
        )
        append_turn(
            memory,
            conversation_id="chat-agent",
            turn_id="turn-agent",
            user_text="Agent task",
            assistant_text="Verified elsewhere",
            outcome="answered",
            task_id="agent-task-1",
        )

        indexed = service.index_turn(conversation_id="chat-ok", turn_id="turn-ok", source="desktop")
        replay = service.index_turn(conversation_id="chat-ok", turn_id="turn-ok", source="desktop")
        failed = service.index_turn(conversation_id="chat-failed", turn_id="turn-failed", source="desktop")
        agent = service.index_turn(conversation_id="chat-agent", turn_id="turn-agent", source="desktop")
        remote = service.index_turn(conversation_id="chat-ok", turn_id="turn-ok", source="api")
        result = service.retrieve("cargo lockfile", {"type": "chat"})

        assert indexed["indexed"] is True
        assert replay == {**indexed, "replayed": True}
        assert failed["reason"] == agent["reason"] == "turn-outcome-excluded"
        assert remote == {"ok": False, "indexed": False, "reason": "source-excluded"}
        assert [item["origin"]["turnId"] for item in result["episodes"]] == ["turn-ok"]
    finally:
        service.close()


class DeterministicReranker:
    diagnostic = "test"

    def rerank(self, _query: str, passages: list[str]) -> SemanticRerankResult:
        return SemanticRerankResult(
            [0.94 if "персиков" in passage.casefold() else 0.71 for passage in passages],
            "test-semantic",
        )

    def warmup(self) -> None:
        return None

    def close(self) -> None:
        return None


class DeadlineReranker(DeterministicReranker):
    def rerank(self, _query: str, _passages: list[str]) -> SemanticRerankResult:
        return SemanticRerankResult(None, "fts:semantic-deadline", timed_out=True)


class UnavailableReranker(DeterministicReranker):
    def rerank(self, _query: str, _passages: list[str]) -> SemanticRerankResult:
        return SemanticRerankResult(None, "fts:semantic-unavailable", timed_out=False)


def test_request_without_content_does_not_become_an_episode(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(memory, conversation_id="chat-short", turn_id="turn-short", user_text=" 1 ",
                    assistant_text="К сожалению, я не понял запрос.")
        append_turn(memory, conversation_id="chat-real", turn_id="turn-real", user_text="Погода в Варне",
                    assistant_text="Уточни, какая Варна.")
        short = service.index_turn(conversation_id="chat-short", turn_id="turn-short", source="desktop")
        real = service.index_turn(conversation_id="chat-real", turn_id="turn-real", source="desktop")
        assert short == {"ok": True, "indexed": False, "reason": "request-without-content"}
        assert real["indexed"] is True
    finally:
        service.close()


def test_unavailable_reranker_does_not_inject_a_weak_episode(tmp_path: Path, monkeypatch) -> None:
    _memory, _context, service = make_services(tmp_path)
    service.reranker.close()
    service.reranker = UnavailableReranker()  # type: ignore[assignment]
    weak = RetrievalCandidate(kind="episode", id="old-refusal", text="Слабосвязанная старая ошибка",
                              title="Старый чат", created_at="2026-01-01T00:00:00+00:00", lexical_score=0.35)
    monkeypatch.setattr(service, "_candidates", lambda *_args: [weak])
    try:
        result = service.retrieve("ошибка сейчас", {"type": "chat"})
        assert result["episodes"] == []
        assert result["retrievalReason"] == "lexical-floor-fallback"
        assert result["rerankerStatus"] == "reranker-unavailable"
    finally:
        service.close()


def test_semantic_paraphrase_is_selected_without_injecting_unrelated_recent_context(tmp_path: Path) -> None:
    _memory, _context, service = make_services(tmp_path)
    service.reranker.close()
    service.reranker = DeterministicReranker()  # type: ignore[assignment]
    try:
        service.index_coder_summary(
            project_id="project-alpha",
            run_id="run-relevant",
            project_name="Alpha",
            user_text="Выбери оформление",
            assistant_text="Пользователь выбрал мягкую персиковую палитру интерфейса.",
            structured_summary={"decision": "peach palette"},
        )
        service.index_coder_summary(
            project_id="project-alpha",
            run_id="run-noise",
            project_name="Alpha",
            user_text="Обнови базу",
            assistant_text="SQLite migration completed.",
            structured_summary={"database": "sqlite"},
        )

        result = service.retrieve(
            "какую цветовую гамму мы выбрали?",
            {"type": "coder-project", "projectId": "project-alpha"},
        )

        assert result["engine"] == "test-semantic"
        assert [item["origin"]["turnId"] for item in result["episodes"]] == ["run-relevant"]
        assert "SQLite" not in json.dumps(result, ensure_ascii=False)
    finally:
        service.close()


def test_semantic_deadline_falls_back_to_fts_and_context_budget_is_hard(tmp_path: Path) -> None:
    _memory, context, service = make_services(tmp_path, budget=800)
    service.reranker.close()
    service.reranker = DeadlineReranker()  # type: ignore[assignment]
    try:
        revision = 0
        for index in range(6):
            receipt = create_explicit(
                context,
                request_id=f"budget-{index}",
                text=f"needlebudget запись {index} " + "длинный текст " * 80,
                expected_revision=revision,
            )
            revision = receipt["revision"]
        result = service.retrieve("needlebudget", {"type": "chat"})

        assert result["engine"] == "fts:semantic-deadline"
        assert result["semanticTimedOut"] is True
        assert result["usedChars"] <= result["budgetChars"] == 800
        assert len(result["explicitMemories"]) <= 4
        assert len(result["episodes"]) <= 4
    finally:
        service.close()


def test_cache_key_tracks_explicit_and_episode_revisions(tmp_path: Path) -> None:
    memory, context, service = make_services(tmp_path)
    try:
        create_explicit(context, request_id="cache-1", text="cachetoken первая запись")
        first = service.retrieve("cachetoken", {"type": "chat"})
        second = service.retrieve("cachetoken", {"type": "chat"})
        create_explicit(
            context,
            request_id="cache-2",
            text="cachetoken вторая запись",
            expected_revision=1,
        )
        after_explicit = service.retrieve("cachetoken", {"type": "chat"})
        append_turn(
            memory,
            conversation_id="cache-chat",
            turn_id="cache-turn",
            user_text="cachetoken вопрос",
            assistant_text="cachetoken ответ",
        )
        service.index_turn(conversation_id="cache-chat", turn_id="cache-turn", source="desktop")
        after_episode = service.retrieve("cachetoken", {"type": "chat"})

        assert first["cache"] == "miss"
        assert second["cache"] == "hit"
        assert after_explicit["cache"] == after_episode["cache"] == "miss"
        assert first["revision"] != after_explicit["revision"] != after_episode["revision"]
    finally:
        service.close()


def test_cross_chat_toggle_hides_episodes_but_keeps_explicit_memory_available(tmp_path: Path) -> None:
    memory, context, service = make_services(tmp_path)
    try:
        create_explicit(context, request_id="toggle-explicit", text="toggletoken явная запись")
        append_turn(
            memory,
            conversation_id="toggle-chat",
            turn_id="toggle-turn",
            user_text="toggletoken прошлый вопрос",
            assistant_text="toggletoken прошлый ответ",
        )
        service.index_turn(conversation_id="toggle-chat", turn_id="toggle-turn", source="desktop")
        enabled = service.retrieve("toggletoken", {"type": "chat"})
        receipt = context.execute(
            client_request_id="toggle-off",
            command="memory.cross-chat.set",
            scope={"type": "chat"},
            expected_revision=1,
            payload={"enabled": False},
            policy_decision_hash=POLICY_HASH,
        )
        disabled = service.retrieve("toggletoken", {"type": "chat"})

        assert enabled["crossChatEnabled"] is True
        assert len(enabled["episodes"]) == 1
        assert receipt["result"] == {"crossChatEnabled": False}
        assert disabled["crossChatEnabled"] is False
        assert disabled["episodes"] == []
        assert len(disabled["explicitMemories"]) == 1
    finally:
        service.close()


def test_fts_and_cache_do_not_resurrect_closed_or_expired_memory(tmp_path: Path, monkeypatch) -> None:
    _memory, context, service = make_services(tmp_path)
    clock = ["2030-01-01T00:00:00+00:00"]
    monkeypatch.setattr("oscar_agent.memory_v4.utc_now", lambda: clock[0])
    try:
        for index in range(3):
            create_explicit(context, request_id=f"expiry-{index}", text=f"expiryneedle item {index}", expected_revision=index)
        with sqlite3.connect(service.db_path) as con:
            con.execute("UPDATE memory_items SET closed_at = '2029-01-01T00:00:00Z' WHERE content = 'expiryneedle item 0'")
            con.execute("UPDATE memory_items SET expires_at = '2029-01-01T00:00:00Z' WHERE content = 'expiryneedle item 1'")
            con.execute("UPDATE memory_items SET expires_at = '2030-01-01T01:00:00Z' WHERE content = 'expiryneedle item 2'")
        first = service.retrieve("expiryneedle", {"type": "chat"})
        assert [item["text"] for item in first["explicitMemories"]] == ["expiryneedle item 2"]
        assert service.retrieve("expiryneedle", {"type": "chat"})["cache"] == "hit"
        clock[0] = "2030-01-01T02:00:00+00:00"
        after = service.retrieve("expiryneedle", {"type": "chat"})
        assert after["cache"] == "miss"
        assert after["explicitMemories"] == []
    finally:
        service.close()


@pytest.mark.parametrize("change", ["delete", "cross-chat-off", "expiry"])
def test_retrieval_rechecks_scope_after_reranking(tmp_path: Path, monkeypatch, change: str) -> None:
    memory, context, service = make_services(tmp_path)
    clock = ["2030-01-01T00:00:00+00:00"]
    monkeypatch.setattr("oscar_agent.memory_v4.utc_now", lambda: clock[0])
    receipt = create_explicit(context, request_id="race-explicit", text="raceneedle remembered fact")
    item_id = receipt["result"]["record"]["id"]
    append_turn(memory, conversation_id="race-chat", turn_id="race-turn", user_text="raceneedle question", assistant_text="raceneedle answer")
    service.index_turn(conversation_id="race-chat", turn_id="race-turn", source="desktop")
    if change == "expiry":
        with sqlite3.connect(service.db_path) as con:
            con.execute("UPDATE memory_items SET expires_at = '2030-01-01T01:00:00Z' WHERE id = ?", (item_id,))
    class ChangingReranker(DeterministicReranker):
        def rerank(self, query: str, passages: list[str]) -> SemanticRerankResult:
            if change == "expiry":
                clock[0] = "2030-01-01T02:00:00+00:00"
            else:
                context.execute(client_request_id="race-change", command="memory.delete" if change == "delete" else "memory.cross-chat.set",
                    scope={"type": "chat"}, expected_revision=1,
                    payload={"id": item_id} if change == "delete" else {"enabled": False}, policy_decision_hash=POLICY_HASH)
            return super().rerank(query, passages)
    service.reranker.close()
    service.reranker = ChangingReranker()  # type: ignore[assignment]
    try:
        result = service.retrieve("raceneedle", {"type": "chat"})
        assert result["engine"] == "scope-changed"
        assert result["explicitMemories"] == result["episodes"] == []
        assert result["crossChatEnabled"] is (change != "cross-chat-off")
    finally:
        service.close()


def test_context_validity_is_content_free_persistent_and_corpus_bound(tmp_path: Path, monkeypatch) -> None:
    _memory, context, service = make_services(tmp_path / "first")
    _other_memory, _other_context, other = make_services(tmp_path / "other")
    scope = {"type": "chat"}
    try:
        initial = service.read_context_validity(scope)
        assert set(initial) == {"schemaVersion", "scope", "revision", "crossChatEnabled", "validityToken"}
        assert initial["validityToken"] != other.read_context_validity(scope)["validityToken"]
        service._init_db()
        assert service.read_context_validity(scope) == initial
        receipt = create_explicit(context, request_id="validity-create", text="validityneedle private fixture")
        snapshot = service.retrieve("validityneedle", scope)
        live = service.read_context_validity(scope)
        assert snapshot["validityToken"] == live["validityToken"] != initial["validityToken"]
        assert "private fixture" not in json.dumps(live)
        monkeypatch.setattr(service, "retrieve", lambda *_: pytest.fail("validity must not retrieve"))
        assert service.read_context_validity(scope) == live
        context.execute(client_request_id="validity-delete", command="memory.delete", scope=scope,
                        expected_revision=1, payload={"id": receipt["result"]["record"]["id"]}, policy_decision_hash=POLICY_HASH)
        assert service.read_context_validity(scope)["validityToken"] != live["validityToken"]
        deleted = service.read_context_validity(scope)
        context.execute(client_request_id="validity-toggle", command="memory.cross-chat.set", scope=scope,
                        expected_revision=2, payload={"enabled": False}, policy_decision_hash=POLICY_HASH)
        disabled = service.read_context_validity(scope)
        assert disabled["crossChatEnabled"] is False
        assert disabled["validityToken"] != deleted["validityToken"]
        service.close()
        _reopened_memory, _reopened_context, service = make_services(tmp_path / "first")
        assert service.read_context_validity(scope) == disabled
    finally:
        service.close()
        other.close()


def test_context_validity_changes_at_expiry_without_revision_write(tmp_path: Path, monkeypatch) -> None:
    _memory, context, service = make_services(tmp_path)
    clock = ["2030-01-01T00:00:00Z"]
    monkeypatch.setattr("oscar_agent.memory_v4.utc_now", lambda: clock[0])
    try:
        create_explicit(context, request_id="validity-expiry", text="expiry fixture")
        with sqlite3.connect(service.db_path) as con:
            con.execute("UPDATE memory_items SET expires_at = '2030-01-01T00:01:00Z'")
        before = service.read_context_validity({"type": "chat"})
        clock[0] = "2030-01-01T00:01:00Z"
        after = service.read_context_validity({"type": "chat"})
        assert before["revision"] == after["revision"]
        assert before["validityToken"] != after["validityToken"]
    finally:
        service.close()


def test_topic_compaction_keeps_children_and_provenance(tmp_path: Path) -> None:
    _memory, _context, service = make_services(tmp_path)
    service.COMPACT_AFTER = 2
    service.COMPACT_BATCH = 2
    try:
        for index in range(3):
            service.index_coder_summary(
                project_id="project-compact",
                run_id=f"compact-run-{index}",
                project_name="Compact",
                user_text=f"архитектура индекса памяти {index}",
                assistant_text=f"решение по архитектуре {index}",
                structured_summary={"index": index},
            )
        with sqlite3.connect(service.db_path) as con:
            capsule = con.execute("SELECT children_json, provenance_json FROM memory_capsules").fetchone()
            children = con.execute(
                "SELECT id, state, capsule_id FROM memory_episodes ORDER BY created_at"
            ).fetchall()

        assert capsule is not None
        child_ids = json.loads(capsule[0])
        assert len(child_ids) == 2
        assert json.loads(capsule[1])["children"] == child_ids
        assert len(children) == 3
        assert sum(1 for _id, state, capsule_id in children if state == "compacted" and capsule_id) == 2
    finally:
        service.close()


def test_backfill_is_resumable_and_excludes_non_desktop_provenance(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(
            memory,
            conversation_id="backfill-desktop",
            turn_id="backfill-turn-desktop",
            user_text="backfillneedle desktop",
            assistant_text="Индексировать этот эпизод.",
        )
        memory.append_conversation_message(
            "backfill-api",
            "user",
            "backfillneedle api",
            client_message_id="backfill_api_user",
            turn_id="backfill-turn-api",
            provenance={"surface": "api", "privacyMode": "persistent"},
        )
        memory.append_conversation_message(
            "backfill-api",
            "assistant",
            "Не индексировать внешний API.",
            client_message_id="backfill_api_assistant",
            turn_id="backfill-turn-api",
            outcome="answered",
            provenance={"surface": "api", "privacyMode": "persistent"},
        )

        service._backfill_conversations()
        service._backfill_conversations()
        with sqlite3.connect(service.db_path) as con:
            rows = con.execute("SELECT turn_id FROM memory_episodes ORDER BY turn_id").fetchall()
            state = con.execute(
                "SELECT completed FROM memory_v4_backfill_state WHERE source = 'persistent-chat-v1'"
            ).fetchone()

        assert rows == [("backfill-turn-desktop",)]
        assert state == (1,)
    finally:
        service.close()


def test_backfill_applies_the_same_outcome_rule_as_live_indexing(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(memory, conversation_id="backfill-outcomes", turn_id="turn-answered",
                    user_text="outcomeneedle обычный вопрос", assistant_text="Обычный ответ.")
        append_turn(memory, conversation_id="backfill-outcomes", turn_id="turn-failed",
                    user_text="outcomeneedle неудачный ход", assistant_text="Ошибка модели.", outcome="failed")
        append_turn(memory, conversation_id="backfill-outcomes", turn_id="turn-task",
                    user_text="outcomeneedle задача агента", assistant_text="Файл создан.", outcome="verified", task_id="task_1")

        service._backfill_conversations()
        with sqlite3.connect(service.db_path) as con:
            rows = con.execute("SELECT turn_id FROM memory_episodes ORDER BY turn_id").fetchall()

        assert rows == [("turn-answered",)]
    finally:
        service.close()


@pytest.mark.skipif(
    not (LOCAL_E5 / "onnx" / "model_quantized.onnx").is_file()
    or not (LOCAL_E5 / "sentencepiece.bpe.model").is_file(),
    reason="optional local multilingual E5 fixture is not installed",
)
def test_installed_multilingual_e5_ranks_a_semantic_paraphrase_above_noise() -> None:
    reranker = SemanticMemoryReranker(LOCAL_E5, 1000)
    try:
        reranker.warmup()
        deadline = time.monotonic() + 5
        while not reranker.diagnostic.startswith("ready:") and time.monotonic() < deadline:
            time.sleep(0.05)
        result = reranker.rerank(
            "какую базу данных использует проект?",
            [
                "Проект хранит постоянный контекст в SQLite.",
                "Пользователь выбрал оранжевую цветовую палитру.",
                "В рецепте нужны яйца и мука.",
            ],
        )
        assert result.scores is not None
        assert result.scores[0] > max(result.scores[1:]) + 0.04
    finally:
        reranker.close()


def test_deleting_a_conversation_removes_its_episodes_from_recall(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(
            memory,
            conversation_id="doomed-chat",
            turn_id="doomed-turn",
            user_text="Расскажи про обновление Монарх",
            assistant_text="Обновление Монарх приносит новый ультрамариновый режим.",
        )
        append_turn(
            memory,
            conversation_id="kept-chat",
            turn_id="kept-turn",
            user_text="Расскажи про погоду",
            assistant_text="Сегодня в Киеве облачно.",
        )
        service.index_turn(conversation_id="doomed-chat", turn_id="doomed-turn", source="desktop")
        service.index_turn(conversation_id="kept-chat", turn_id="kept-turn", source="desktop")
        before = service.retrieve("ультрамариновый режим", {"type": "chat"})
        assert [item["origin"]["conversationId"] for item in before["episodes"]] == ["doomed-chat"]

        assert memory.delete_conversation("doomed-chat") is True
        service.invalidate_cache()

        after = service.retrieve("ультрамариновый режим", {"type": "chat"})
        assert after["episodes"] == []
        assert "ультрамариновый" not in json.dumps(after, ensure_ascii=False)
        with sqlite3.connect(service.db_path) as con:
            rows = con.execute(
                "SELECT conversation_id FROM memory_episodes ORDER BY conversation_id"
            ).fetchall()
            indexed = con.execute("SELECT COUNT(*) FROM memory_episodes_fts").fetchone()
        assert rows == [("kept-chat",)]
        assert indexed == (1,)
        # The surviving chat is still recalled; deletion is not a corpus wipe.
        kept = service.retrieve("облачно", {"type": "chat"})
        assert [item["origin"]["conversationId"] for item in kept["episodes"]] == ["kept-chat"]
    finally:
        service.close()


def test_clearing_history_removes_chat_episodes_and_keeps_coder_memory(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(
            memory,
            conversation_id="history-chat",
            turn_id="history-turn",
            user_text="Запомни про ультрамариновый режим",
            assistant_text="Записал про ультрамариновый режим.",
        )
        service.index_turn(conversation_id="history-chat", turn_id="history-turn", source="desktop")
        service.index_coder_summary(
            project_id="project-alpha",
            run_id="run-1",
            project_name="Alpha",
            user_text="Собери ProjectNeedle",
            assistant_text="ProjectNeedle собран.",
            structured_summary={"status": "ok"},
        )

        memory.clear_conversations()
        service.invalidate_cache()

        chat = service.retrieve("ультрамариновый режим", {"type": "chat"})
        coder = service.retrieve("ProjectNeedle", {"type": "coder-project", "projectId": "project-alpha"})
        assert chat["episodes"] == []
        # Coder episodes are keyed by a run id, not a conversation, and survive.
        assert [item["origin"]["conversationId"] for item in coder["episodes"]] == ["coder:run-1"]
    finally:
        service.close()


def test_startup_removes_derived_memory_left_by_earlier_builds(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(
            memory,
            conversation_id="legacy-chat",
            turn_id="legacy-turn",
            user_text="Расскажи про ультрамариновый режим",
            assistant_text="Ультрамариновый режим включается в настройках.",
        )
        service.index_turn(conversation_id="legacy-chat", turn_id="legacy-turn", source="desktop")
        # Reproduce the pre-fix state: the chat is gone, its episode is not.
        with sqlite3.connect(service.db_path) as con:
            con.execute("DELETE FROM conversations WHERE id = ?", ("legacy-chat",))
            con.commit()
        with sqlite3.connect(service.db_path) as con:
            assert con.execute("SELECT COUNT(*) FROM memory_episodes").fetchone() == (1,)
    finally:
        service.close()

    restarted = MemoryV4Service(make_settings(tmp_path))
    try:
        assert restarted.retrieve("ультрамариновый режим", {"type": "chat"})["episodes"] == []
        with sqlite3.connect(restarted.db_path) as con:
            assert con.execute("SELECT COUNT(*) FROM memory_episodes").fetchone() == (0,)
            assert con.execute("SELECT COUNT(*) FROM memory_episodes_fts").fetchone() == (0,)
    finally:
        restarted.close()


def test_capsule_quoting_a_deleted_conversation_is_dropped_whole(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(
            memory,
            conversation_id="capsule-chat",
            turn_id="capsule-turn",
            user_text="Расскажи про ультрамариновый режим",
            assistant_text="Ультрамариновый режим включается в настройках.",
        )
        append_turn(
            memory,
            conversation_id="other-chat",
            turn_id="other-turn",
            user_text="Расскажи про облака",
            assistant_text="Облака бывают кучевые.",
        )
        service.index_turn(conversation_id="capsule-chat", turn_id="capsule-turn", source="desktop")
        service.index_turn(conversation_id="other-chat", turn_id="other-turn", source="desktop")
        with sqlite3.connect(service.db_path) as con:
            con.row_factory = sqlite3.Row
            children = [row["id"] for row in con.execute("SELECT id FROM memory_episodes").fetchall()]
            con.execute(
                "INSERT INTO memory_capsules(id, scope_type, scope_id, topic, summary, children_json, "
                "provenance_json, created_at, updated_at) VALUES('capsule-1', 'chat', 'default', 'Режимы', "
                "'- ультрамариновый режим', ?, '{}', '2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00')",
                (json.dumps(children),),
            )
            con.execute(
                "INSERT INTO memory_capsules_fts(capsule_id, scope_type, scope_id, topic, text) "
                "VALUES('capsule-1', 'chat', 'default', 'Режимы', '- ультрамариновый режим')"
            )
            con.commit()

        assert memory.delete_conversation("capsule-chat") is True
        service.invalidate_cache()

        result = service.retrieve("ультрамариновый режим", {"type": "chat"})
        assert "ультрамариновый" not in json.dumps(result, ensure_ascii=False)
        with sqlite3.connect(service.db_path) as con:
            assert con.execute("SELECT COUNT(*) FROM memory_capsules").fetchone() == (0,)
            assert con.execute("SELECT COUNT(*) FROM memory_capsules_fts").fetchone() == (0,)
    finally:
        service.close()


def test_list_derived_memory_returns_episodes_and_capsules_for_scope(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(
            memory,
            conversation_id="listed-chat",
            turn_id="listed-turn",
            user_text="Расскажи про ультрамариновый режим",
            assistant_text="Ультрамариновый режим включается в настройках.",
        )
        service.index_turn(conversation_id="listed-chat", turn_id="listed-turn", source="desktop")
        service.index_coder_summary(
            project_id="project-alpha",
            run_id="run-1",
            project_name="Alpha",
            user_text="Собери ProjectNeedle",
            assistant_text="ProjectNeedle собран.",
            structured_summary={"status": "ok"},
        )

        chat_listing = service.list_derived_memory({"type": "chat"})
        coder_listing = service.list_derived_memory({"type": "coder-project", "projectId": "project-alpha"})

        assert [item["conversationId"] for item in chat_listing["episodes"]] == ["listed-chat"]
        assert chat_listing["capsules"] == []
        assert [item["conversationId"] for item in coder_listing["episodes"]] == ["coder:run-1"]
    finally:
        service.close()


def test_forget_episode_removes_it_from_recall_and_drops_its_capsule(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(
            memory,
            conversation_id="forget-chat",
            turn_id="forget-turn",
            user_text="Расскажи про ультрамариновый режим",
            assistant_text="Ультрамариновый режим включается в настройках.",
        )
        service.index_turn(conversation_id="forget-chat", turn_id="forget-turn", source="desktop")
        episode_id = service.list_derived_memory({"type": "chat"})["episodes"][0]["id"]
        with sqlite3.connect(service.db_path) as con:
            con.execute(
                "INSERT INTO memory_capsules(id, scope_type, scope_id, topic, summary, children_json, "
                "provenance_json, created_at, updated_at) VALUES('capsule-1', 'chat', 'default', 'Режимы', "
                "'- ультрамариновый режим', ?, '{}', '2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00')",
                (json.dumps([episode_id]),),
            )
            con.commit()

        assert service.forget_episode(episode_id, {"type": "chat"}) is True
        assert service.forget_episode(episode_id, {"type": "chat"}) is False

        listing = service.list_derived_memory({"type": "chat"})
        assert listing["episodes"] == []
        assert listing["capsules"] == []
        result = service.retrieve("ультрамариновый режим", {"type": "chat"})
        assert "ультрамариновый" not in json.dumps(result, ensure_ascii=False)
    finally:
        service.close()


def test_forget_capsule_by_id(tmp_path: Path) -> None:
    _memory, _context, service = make_services(tmp_path)
    try:
        with sqlite3.connect(service.db_path) as con:
            con.execute(
                "INSERT INTO memory_capsules(id, scope_type, scope_id, topic, summary, children_json, "
                "provenance_json, created_at, updated_at) VALUES('capsule-1', 'chat', 'default', 'Режимы', "
                "'сводка', '[]', '{}', '2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00')"
            )
            con.commit()

        assert service.forget_capsule("capsule-1", {"type": "chat"}) is True
        assert service.forget_capsule("capsule-1", {"type": "chat"}) is False
        assert service.list_derived_memory({"type": "chat"})["capsules"] == []
    finally:
        service.close()


def test_forget_all_derived_memory_clears_one_scope_only(tmp_path: Path) -> None:
    memory, _context, service = make_services(tmp_path)
    try:
        append_turn(
            memory,
            conversation_id="wipe-chat",
            turn_id="wipe-turn",
            user_text="Расскажи про ультрамариновый режим",
            assistant_text="Ультрамариновый режим включается в настройках.",
        )
        service.index_turn(conversation_id="wipe-chat", turn_id="wipe-turn", source="desktop")
        service.index_coder_summary(
            project_id="project-alpha",
            run_id="run-1",
            project_name="Alpha",
            user_text="Собери ProjectNeedle",
            assistant_text="ProjectNeedle собран.",
            structured_summary={"status": "ok"},
        )

        result = service.forget_all_derived_memory({"type": "chat"})
        assert result == {"episodes": 1, "capsules": 0}

        assert service.list_derived_memory({"type": "chat"})["episodes"] == []
        coder = service.list_derived_memory({"type": "coder-project", "projectId": "project-alpha"})
        assert [item["conversationId"] for item in coder["episodes"]] == ["coder:run-1"]
    finally:
        service.close()


def test_the_chat_being_answered_is_not_recalled_as_a_past_chat(tmp_path: Path) -> None:
    # Live 2026-09-18: "просто расскажи шутку" recalled this same chat's earlier
    # refusal as "Из памяти · прошлый чат", and the model repeated it verbatim.
    memory, _context, service = make_services(tmp_path)
    try:
        for conversation_id, turn_id in (("chat-now", "turn-now"), ("chat-before", "turn-before")):
            append_turn(
                memory,
                conversation_id=conversation_id,
                turn_id=turn_id,
                user_text="jokeneedle расскажи шутку",
                assistant_text="jokeneedle ответ",
            )
            service.index_turn(conversation_id=conversation_id, turn_id=turn_id, source="desktop")

        excluded = service.retrieve("jokeneedle", {"type": "chat"}, exclude_conversation_id="chat-now")
        unscoped = service.retrieve("jokeneedle", {"type": "chat"})

        assert [item["origin"]["conversationId"] for item in excluded["episodes"]] == ["chat-before"]
        assert excluded["cache"] == "miss" and unscoped["cache"] == "miss"
        assert sorted(item["origin"]["conversationId"] for item in unscoped["episodes"]) == ["chat-before", "chat-now"]
    finally:
        service.close()
