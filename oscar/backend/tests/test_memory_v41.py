"""Memory 4.1 regression checks: disposable databases and synthetic content only."""
from __future__ import annotations

import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from oscar_agent.memory_v4 import MemoryV4Service
from oscar_agent.semantic_memory import QueryEmbedding, SemanticMemoryReranker
from test_memory_v4 import DeterministicReranker, append_turn, create_explicit, make_services, make_settings


def test_forget_survives_replay_backfill_and_restart(tmp_path):
    memory, _, service = make_services(tmp_path)
    append_turn(memory, conversation_id="chat", turn_id="turn", user_text="forgottenneedle context", assistant_text="Synthetic answer")
    indexed = service.index_turn(conversation_id="chat", turn_id="turn", source="desktop")
    assert service.forget_episode(indexed["episodeId"], {"type": "chat"})
    service.close()
    service = MemoryV4Service(make_settings(tmp_path))
    try:
        replay = service.index_turn(conversation_id="chat", turn_id="turn", source="desktop")
        service._backfill_conversations()
        assert replay["indexed"] is False
        assert service.retrieve("forgottenneedle", {"type": "chat"})["episodes"] == []
    finally:
        service.close()


def test_completed_backfill_catches_a_later_missed_turn(tmp_path):
    memory, _, service = make_services(tmp_path)
    try:
        service._backfill_conversations()
        append_turn(memory, conversation_id="chat", turn_id="later", user_text="missedneedle context", assistant_text="Synthetic answer")
        service._backfill_conversations()
        assert service.retrieve("missedneedle", {"type": "chat"})["episodes"]
    finally:
        service.close()


def test_current_chat_does_not_crowd_other_chats_out_of_candidates(tmp_path):
    memory, _, service = make_services(tmp_path)
    service.CANDIDATE_LIMIT = 3
    try:
        for i in range(7):
            conversation = "other" if i == 6 else "current"
            append_turn(memory, conversation_id=conversation, turn_id=f"turn-{i}", user_text="sharedneedle", assistant_text="answer")
            service.index_turn(conversation_id=conversation, turn_id=f"turn-{i}", source="desktop")
        result = service.retrieve("sharedneedle", {"type": "chat"}, exclude_conversation_id="current")
        assert [item["origin"]["conversationId"] for item in result["episodes"]] == ["other"]
    finally:
        service.close()


def test_current_chat_is_excluded_through_compacted_capsule(tmp_path):
    memory, _, service = make_services(tmp_path)
    service.COMPACT_AFTER = 2
    service.COMPACT_BATCH = 2
    try:
        for i in range(3):
            append_turn(memory, conversation_id="current", turn_id=f"turn-{i}", user_text="capsuleneedle context", assistant_text="answer")
            service.index_turn(conversation_id="current", turn_id=f"turn-{i}", source="desktop")
        assert service.list_derived_memory({"type": "chat"})["capsules"]
        assert service.retrieve("capsuleneedle", {"type": "chat"}, exclude_conversation_id="current")["episodes"] == []
    finally:
        service.close()


@pytest.mark.parametrize("provenance", [{"surface": "api"}, {"surface": "desktop", "privacyMode": "incognito"}])
def test_live_indexing_checks_stored_provenance(tmp_path, provenance):
    memory, _, service = make_services(tmp_path)
    try:
        for role in ("user", "assistant"):
            memory.append_conversation_message("chat", role, "provenanceneedle", client_message_id=role, turn_id="turn", outcome="answered" if role == "assistant" else None, provenance=provenance)
        assert service.index_turn(conversation_id="chat", turn_id="turn", source="desktop")["indexed"] is False
    finally:
        service.close()


def test_slow_semantic_worker_has_no_request_backlog(tmp_path, monkeypatch):
    reranker = SemanticMemoryReranker(tmp_path, 20)
    monkeypatch.setattr(type(reranker), "files_present", property(lambda _: True))
    entered, release = threading.Event(), threading.Event()
    calls = []

    def score(query, passages):
        calls.append(query)
        entered.set()
        assert release.wait(5)
        return [0.9] * len(passages)

    monkeypatch.setattr(reranker, "_score", score)
    try:
        assert reranker.rerank("first", ["text"]).timed_out
        assert entered.is_set()
        for i in range(12):
            assert reranker.rerank(str(i), ["text"]).scores is None
        release.set()
        reranker._executor.shutdown(wait=True)
        assert calls == ["first"]
    finally:
        release.set()
        reranker.close()


def test_concurrent_duplicate_indexing_is_idempotent(tmp_path):
    memory, _, service = make_services(tmp_path)
    append_turn(memory, conversation_id="chat", turn_id="turn", user_text="concurrentneedle context", assistant_text="answer")
    try:
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: service.index_turn(conversation_id="chat", turn_id="turn", source="desktop"), range(16)))
        assert len({r["episodeId"] for r in results}) == 1
        assert sum(not r["replayed"] for r in results) == 1
    finally:
        service.close()


def test_outbox_survives_failure_restart_and_rowid_reuse(tmp_path, monkeypatch):
    memory, _, service = make_services(tmp_path)
    append_turn(memory, conversation_id="old", turn_id="old", user_text="oldneedle", assistant_text="answer")
    service._backfill_conversations()
    memory.clear_conversations()
    append_turn(memory, conversation_id="new", turn_id="new", user_text="newneedle", assistant_text="answer")

    def fail(*args):
        raise RuntimeError("synthetic interruption")

    monkeypatch.setattr(service, "_index_conversation_turn", fail)
    with pytest.raises(RuntimeError, match="synthetic interruption"):
        service._backfill_conversations()
    with sqlite3.connect(service.db_path) as con:
        assert con.execute("SELECT COUNT(*) FROM memory_index_jobs").fetchone()[0] == 1
    service.close()
    service = MemoryV4Service(make_settings(tmp_path))
    try:
        service._backfill_conversations()
        assert [item["origin"]["turnId"] for item in service.retrieve("newneedle", {"type": "chat"})["episodes"]] == ["new"]
        with sqlite3.connect(service.db_path) as con:
            assert con.execute("SELECT COUNT(*) FROM memory_index_jobs").fetchone()[0] == 0
    finally:
        service.close()


def test_forget_all_covers_pending_history_but_allows_future_turns(tmp_path):
    memory, _, service = make_services(tmp_path)
    try:
        append_turn(memory, conversation_id="chat", turn_id="old", user_text="oldneedle", assistant_text="answer")
        service.forget_all_derived_memory({"type": "chat"})
        append_turn(memory, conversation_id="chat", turn_id="new", user_text="newneedle", assistant_text="answer")
        service._backfill_conversations()
        assert [item["turnId"] for item in service.list_derived_memory({"type": "chat"})["episodes"]] == ["new"]
    finally:
        service.close()


def test_forgetting_capsule_forgets_its_sources_on_replay(tmp_path):
    memory, _, service = make_services(tmp_path)
    service.COMPACT_AFTER = 2
    service.COMPACT_BATCH = 2
    try:
        for i in range(3):
            append_turn(memory, conversation_id="chat", turn_id=f"t{i}", user_text=f"contextneedle {i}", assistant_text="answer")
            service.index_turn(conversation_id="chat", turn_id=f"t{i}", source="desktop")
        capsule = service.list_derived_memory({"type": "chat"})["capsules"][0]
        assert service.forget_capsule(capsule["id"], {"type": "chat"})
        for i in range(2):
            assert service.index_turn(conversation_id="chat", turn_id=f"t{i}", source="desktop")["indexed"] is False
        assert [item["turnId"] for item in service.list_derived_memory({"type": "chat"})["episodes"]] == ["t2"]
    finally:
        service.close()


def test_compaction_preserves_detail_beyond_capsule_summary(tmp_path):
    memory, _, service = make_services(tmp_path)
    service.COMPACT_AFTER = 2
    service.COMPACT_BATCH = 2
    try:
        for i in range(3):
            append_turn(memory, conversation_id="chat", turn_id=f"t{i}", user_text="context " * 40 + f"detailneedle{i}", assistant_text="answer")
            service.index_turn(conversation_id="chat", turn_id=f"t{i}", source="desktop")
        capsule = service.list_derived_memory({"type": "chat"})["capsules"][0]
        assert "detailneedle0" not in capsule["summary"]
        result = service.retrieve("detailneedle0", {"type": "chat"})
        assert any(item["origin"].get("turnId") == "t0" for item in result["episodes"])
    finally:
        service.close()


def test_restart_does_not_rebuild_explicit_index(tmp_path, monkeypatch):
    from oscar_agent import secure_db
    _, context, service = make_services(tmp_path)
    create_explicit(context, request_id="explicit", text="restartneedle")
    service.close()
    statements = []
    connect = secure_db.connect

    def traced(*args, **kwargs):
        con = connect(*args, **kwargs)
        con.set_trace_callback(statements.append)
        return con

    monkeypatch.setattr(secure_db, "connect", traced)
    service = MemoryV4Service(make_settings(tmp_path))
    try:
        assert service.retrieve("restartneedle", {"type": "chat"})["explicitMemories"]
        assert not any("DELETE FROM memory_items_fts" in statement or "INSERT INTO memory_items_fts" in statement for statement in statements)
    finally:
        service.close()


def test_failed_index_upgrade_rolls_back_and_retry_repairs_projection(tmp_path, monkeypatch):
    from oscar_agent import memory_index
    _, context, service = make_services(tmp_path)
    create_explicit(context, request_id="explicit", text="migrationneedle")
    service.close()
    with sqlite3.connect(service.db_path) as con:
        con.execute("DELETE FROM memory_search_schema")
        # Simulate an old/stale projection needing the one-time upgrade.
        con.execute("DELETE FROM memory_items_fts")
    projections = memory_index.PROJECTIONS
    monkeypatch.setattr(memory_index, "PROJECTIONS", (*projections, ("missing_table", "id", ("text",), ("text",), "1", ())))
    broken = MemoryV4Service(make_settings(tmp_path))  # chat keeps working without memory
    assert broken.init_error == "memory-init-failed:OperationalError"
    broken.close()
    with sqlite3.connect(service.db_path) as con:
        assert con.execute("SELECT COUNT(*) FROM memory_search_schema").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM memory_items_fts").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM memory_items").fetchone()[0] == 1
    monkeypatch.setattr(memory_index, "PROJECTIONS", projections)
    service = MemoryV4Service(make_settings(tmp_path))
    try:
        assert service.retrieve("migrationneedle", {"type": "chat"})["explicitMemories"]
        with sqlite3.connect(service.db_path) as con:
            assert con.execute("SELECT COUNT(*) FROM memory_items_fts").fetchone()[0] == 1
    finally:
        service.close()


def test_index_update_and_source_rollback_together(tmp_path):
    _, context, service = make_services(tmp_path)
    create_explicit(context, request_id="explicit", text="originalneedle")
    try:
        with pytest.raises(RuntimeError):
            with service._connection(write=True) as con:
                con.execute("UPDATE memory_items SET content = 'replacementneedle'")
                assert con.execute("SELECT COUNT(*) FROM memory_items_fts WHERE memory_items_fts MATCH 'replacementneedle'").fetchone()[0] == 1
                raise RuntimeError("rollback")
        with service._connection() as con:
            assert con.execute("SELECT COUNT(*) FROM memory_items_fts WHERE memory_items_fts MATCH 'originalneedle'").fetchone()[0] == 1
            assert con.execute("SELECT COUNT(*) FROM memory_items_fts WHERE memory_items_fts MATCH 'replacementneedle'").fetchone()[0] == 0
    finally:
        service.close()


def test_temporary_fallback_cache_does_not_hide_recovered_reranker(tmp_path):
    _, context, service = make_services(tmp_path)
    create_explicit(context, request_id="explicit", text="cacheneedle")
    service.FALLBACK_CACHE_TTL_SECONDS = 0
    try:
        first = service.retrieve("cacheneedle", {"type": "chat"})
        assert first["rerankerStatus"] == "reranker-unavailable"
        service.reranker.close()
        service.reranker = DeterministicReranker()
        service._embed_pending()
        second = service.retrieve("cacheneedle", {"type": "chat"})
        assert second["cache"] == "miss"
        assert second["rerankerStatus"] == "reranker-ready"
    finally:
        service.close()


@pytest.mark.parametrize("vector", [[float("nan"), 0.0], [float("inf"), 0.0], [1.5, 0.0], [1.0], []])
def test_invalid_query_vectors_use_finite_lexical_fallback(tmp_path, vector):
    import numpy as np
    _, context, service = make_services(tmp_path)
    create_explicit(context, request_id="explicit", text="scoreneedle")
    service.reranker.close()
    service.reranker = DeterministicReranker()
    service._embed_pending()
    service.reranker.embed_query = lambda query: QueryEmbedding(np.array(vector, dtype=np.float32), "synthetic")
    try:
        result = service.retrieve("scoreneedle", {"type": "chat"})
        assert result["rerankerStatus"] == "reranker-unavailable"
        assert result["explicitMemories"][0]["text"] == "scoreneedle"
        json.dumps(result, allow_nan=False)
    finally:
        service.close()


def test_semantic_close_does_not_admit_more_work(tmp_path, monkeypatch):
    reranker = SemanticMemoryReranker(tmp_path)
    monkeypatch.setattr(type(reranker), "files_present", property(lambda _: True))
    reranker.close()
    reranker.warmup()
    assert reranker.rerank("query", ["passage"]).engine == "fts:semantic-closed"


def test_shutdown_drains_active_transaction_and_stops_background(tmp_path, monkeypatch):
    memory, _, service = make_services(tmp_path)
    append_turn(memory, conversation_id="chat", turn_id="turn", user_text="shutdownneedle", assistant_text="answer")
    entered, release, closed = threading.Event(), threading.Event(), threading.Event()
    original = service._index_conversation_turn

    def held(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)

    monkeypatch.setattr(service, "_index_conversation_turn", held)
    service.start_background()
    assert entered.wait(5)
    thread = threading.Thread(target=lambda: (service.close(), closed.set()))
    thread.start()
    try:
        assert not closed.wait(0.05)
        release.set()
        assert closed.wait(5)
        thread.join()
        assert all(not worker.is_alive() for worker in service._background._threads)
    finally:
        release.set()
        thread.join(timeout=5)
        service.close()
