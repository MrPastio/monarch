from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from oscar_agent.config import Settings
from oscar_agent.context_settings import ContextSettingsStore
from oscar_agent.memory import MemoryStore
from oscar_agent.memory_v4 import MemoryV4Service
from oscar_agent.semantic_memory import SemanticMemoryReranker, SemanticRerankResult


POLICY_HASH = "b" * 64
LOCAL_E5 = Path("E:/") / "MonarchData" / "models" / "memory" / "multilingual-e5-small"


def make_services(tmp_path: Path, *, budget: int = 2400) -> tuple[MemoryStore, ContextSettingsStore, MemoryV4Service]:
    settings = Settings(
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
