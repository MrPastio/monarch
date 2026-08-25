from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import uuid
from collections import OrderedDict, Counter
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import Settings
from .memory import make_fts_query
from .semantic_memory import SemanticMemoryReranker


@dataclass(slots=True)
class RetrievalCandidate:
    kind: str
    id: str
    text: str
    title: str
    created_at: str
    lexical_score: float
    pinned: bool = False
    conversation_id: str | None = None
    turn_id: str | None = None
    capsule_id: str | None = None
    semantic_score: float | None = None
    final_score: float = 0.0
    reason: str = "fts"


class MemoryV4Service:
    CANDIDATE_LIMIT = 32
    EXPLICIT_LIMIT = 4
    EPISODE_LIMIT = 4
    CACHE_LIMIT = 128
    COMPACT_AFTER = 240
    COMPACT_BATCH = 40

    def __init__(self, settings: Settings):
        self.db_path = Path(settings.db_path)
        self.prompt_budget_chars = int(settings.memory_prompt_budget_chars)
        self.reranker = SemanticMemoryReranker(
            Path(settings.memory_embedding_model_dir),
            int(settings.memory_retrieval_deadline_ms),
        )
        self._cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._background = ThreadPoolExecutor(max_workers=1, thread_name_prefix="monarch-memory-backfill")
        self._background_started = False
        self._init_db()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        con = sqlite3.connect(self.db_path, timeout=10.0)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        con.execute("PRAGMA secure_delete=ON")
        con.execute("PRAGMA synchronous=NORMAL")
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def _init_db(self) -> None:
        with self._connection() as con:
            con.execute("PRAGMA journal_mode=WAL")
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS memory_episodes (
                    id TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    title TEXT NOT NULL,
                    user_text TEXT NOT NULL,
                    assistant_text TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    search_text TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'hot',
                    capsule_id TEXT,
                    provenance_json TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(source, turn_id)
                );

                CREATE INDEX IF NOT EXISTS memory_episodes_scope_state_idx
                    ON memory_episodes(scope_type, scope_id, state, created_at DESC);

                CREATE TABLE IF NOT EXISTS memory_capsules (
                    id TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    children_json TEXT NOT NULL,
                    provenance_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS memory_capsules_scope_idx
                    ON memory_capsules(scope_type, scope_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS memory_v4_scope_revisions (
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(scope_type, scope_id)
                );

                CREATE TABLE IF NOT EXISTS memory_v4_backfill_state (
                    source TEXT PRIMARY KEY,
                    cursor INTEGER NOT NULL,
                    completed INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
                    item_id UNINDEXED,
                    scope_type UNINDEXED,
                    scope_id UNINDEXED,
                    title,
                    text,
                    tags,
                    tokenize='unicode61'
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS memory_episodes_fts USING fts5(
                    episode_id UNINDEXED,
                    scope_type UNINDEXED,
                    scope_id UNINDEXED,
                    title,
                    text,
                    tokenize='unicode61'
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS memory_capsules_fts USING fts5(
                    capsule_id UNINDEXED,
                    scope_type UNINDEXED,
                    scope_id UNINDEXED,
                    topic,
                    text,
                    tokenize='unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS memory_items_v4_insert AFTER INSERT ON memory_items BEGIN
                    INSERT INTO memory_items_fts(item_id, scope_type, scope_id, title, text, tags)
                    VALUES(new.id, new.scope_type, new.scope_id, new.title, new.content, new.tags_json);
                END;

                CREATE TRIGGER IF NOT EXISTS memory_items_v4_update AFTER UPDATE ON memory_items BEGIN
                    DELETE FROM memory_items_fts WHERE item_id = old.id;
                    INSERT INTO memory_items_fts(item_id, scope_type, scope_id, title, text, tags)
                    SELECT new.id, new.scope_type, new.scope_id, new.title, new.content, new.tags_json
                    WHERE new.deleted_at IS NULL AND new.enabled = 1;
                END;

                CREATE TRIGGER IF NOT EXISTS memory_items_v4_delete AFTER DELETE ON memory_items BEGIN
                    DELETE FROM memory_items_fts WHERE item_id = old.id;
                END;
                """
            )
            # Rebuild contentful FTS tables deterministically. This is bounded to
            # local context rows and repairs indexes after interrupted upgrades.
            con.execute("DELETE FROM memory_items_fts")
            con.execute(
                "INSERT INTO memory_items_fts(item_id, scope_type, scope_id, title, text, tags) "
                "SELECT id, scope_type, scope_id, title, content, tags_json FROM memory_items "
                "WHERE deleted_at IS NULL AND enabled = 1"
            )
            con.execute("DELETE FROM memory_episodes_fts")
            con.execute(
                "INSERT INTO memory_episodes_fts(episode_id, scope_type, scope_id, title, text) "
                "SELECT id, scope_type, scope_id, title, search_text FROM memory_episodes WHERE state = 'hot'"
            )
            con.execute("DELETE FROM memory_capsules_fts")
            con.execute(
                "INSERT INTO memory_capsules_fts(capsule_id, scope_type, scope_id, topic, text) "
                "SELECT id, scope_type, scope_id, topic, summary FROM memory_capsules"
            )

    def start_background(self) -> None:
        if self._background_started:
            return
        self._background_started = True
        self.reranker.warmup()
        self._background.submit(self._backfill_conversations)

    def close(self) -> None:
        self.reranker.close()
        self._background.shutdown(wait=False, cancel_futures=True)

    def index_turn(self, *, conversation_id: str, turn_id: str, source: str) -> dict[str, Any]:
        if source != "desktop":
            return {"ok": False, "indexed": False, "reason": "source-excluded"}
        with self._connection() as con:
            messages = con.execute(
                "SELECT role, content, outcome, task_id, created_at FROM conversation_messages "
                "WHERE conversation_id = ? AND turn_id = ? ORDER BY rowid",
                (conversation_id, turn_id),
            ).fetchall()
            user_text = next((row["content"] for row in messages if row["role"] == "user"), "")
            assistant = next((row for row in reversed(messages) if row["role"] == "assistant"), None)
            if not user_text or not assistant:
                return {"ok": False, "indexed": False, "reason": "turn-messages-incomplete"}
            if assistant["outcome"] not in {"answered", "answered:source-grounded"} or assistant["task_id"]:
                return {"ok": False, "indexed": False, "reason": "turn-outcome-excluded"}
            conversation = con.execute(
                "SELECT title FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
            title = str(conversation["title"] if conversation else "Чат")[:160]
            return self._index_episode_in_connection(
                con,
                scope_type="chat",
                scope_id="default",
                conversation_id=conversation_id,
                turn_id=turn_id,
                source="desktop",
                title=title,
                user_text=user_text,
                assistant_text=assistant["content"],
                summary=episode_summary(user_text, assistant["content"]),
                created_at=assistant["created_at"] or utc_now(),
            )

    def index_coder_summary(
        self,
        *,
        project_id: str,
        run_id: str,
        project_name: str,
        user_text: str,
        assistant_text: str,
        structured_summary: dict[str, Any],
    ) -> dict[str, Any]:
        project_id = bounded_id(project_id, 160)
        run_id = bounded_id(run_id, 256)
        summary = canonical_json(structured_summary)[:6000]
        with self._connection() as con:
            return self._index_episode_in_connection(
                con,
                scope_type="coder-project",
                scope_id=project_id,
                conversation_id=f"coder:{run_id}",
                turn_id=run_id,
                source="coder",
                title=str(project_name or project_id)[:160],
                user_text=str(user_text or "")[:8000],
                assistant_text=str(assistant_text or "")[:8000],
                summary=summary,
                created_at=utc_now(),
            )

    def retrieve(self, query: str, scope: dict[str, str | None]) -> dict[str, Any]:
        query = normalize_query(query)
        scope_type, scope_id = normalize_scope(scope)
        cross_chat_enabled = self._cross_chat_enabled(scope_type, scope_id)
        if not query:
            return empty_context(
                scope_type,
                scope_id,
                "empty-query",
                self.prompt_budget_chars,
                cross_chat_enabled,
            )
        revision = self._index_revision(scope_type, scope_id)
        cache_key = hashlib.sha256(
            f"{scope_type}\0{scope_id}\0{revision}\0{query.casefold()}".encode("utf-8")
        ).hexdigest()
        cached = self._cache_get(cache_key)
        if cached is not None:
            return {**cached, "cache": "hit"}

        candidates = self._candidates(query, scope_type, scope_id, cross_chat_enabled)
        reranked = self.reranker.rerank(query, [candidate.text for candidate in candidates])
        if reranked.scores is not None and len(reranked.scores) == len(candidates):
            best_semantic = max(reranked.scores, default=0.0)
            semantic_floor = max(0.82, best_semantic - 0.06)
            for candidate, semantic in zip(candidates, reranked.scores, strict=True):
                candidate.semantic_score = semantic
                candidate.final_score = max(0.0, min(1.0, semantic * 0.82 + candidate.lexical_score * 0.18))
                candidate.reason = "semantic+fts" if candidate.lexical_score > 0 else "semantic-recent"
            relevant = [
                candidate for candidate in candidates
                if (candidate.semantic_score or 0.0) >= semantic_floor
                or candidate.pinned
                or candidate.lexical_score >= 0.45
            ]
        else:
            for candidate in candidates:
                candidate.final_score = candidate.lexical_score
                candidate.reason = "pinned" if candidate.pinned and candidate.lexical_score < 0.45 else "fts"
            relevant = [candidate for candidate in candidates if candidate.lexical_score > 0.0]
        relevant.sort(key=lambda item: (item.final_score, item.created_at), reverse=True)
        context = self._bounded_context(
            relevant,
            scope_type,
            scope_id,
            revision,
            reranked.engine,
            reranked.timed_out,
            cross_chat_enabled,
        )
        self._cache_put(cache_key, context)
        return context

    def _index_episode_in_connection(
        self,
        con: sqlite3.Connection,
        *,
        scope_type: str,
        scope_id: str,
        conversation_id: str,
        turn_id: str,
        source: str,
        title: str,
        user_text: str,
        assistant_text: str,
        summary: str,
        created_at: str,
    ) -> dict[str, Any]:
        if re.match(r"^(?:запомни|сохрани\s+в\s+память|remember\b)", user_text.strip(), re.I):
            return {"ok": True, "indexed": False, "reason": "explicit-memory-command"}
        existing = con.execute(
            "SELECT id FROM memory_episodes WHERE source = ? AND turn_id = ?",
            (source, turn_id),
        ).fetchone()
        if existing:
            return {"ok": True, "indexed": True, "episodeId": existing["id"], "replayed": True}
        episode_id = uuid.uuid4().hex
        search_text = f"{user_text.strip()}\n{assistant_text.strip()}\n{summary.strip()}"[:16000]
        provenance = {
            "schemaVersion": 1,
            "source": source,
            "conversationId": conversation_id,
            "turnId": turn_id,
            "scope": render_scope(scope_type, scope_id),
        }
        content_hash = hashlib.sha256(search_text.encode("utf-8")).hexdigest()
        now = utc_now()
        con.execute(
            "INSERT INTO memory_episodes(id, scope_type, scope_id, conversation_id, turn_id, source, title, "
            "user_text, assistant_text, summary, search_text, state, capsule_id, provenance_json, content_hash, "
            "created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hot', NULL, ?, ?, ?, ?)",
            (
                episode_id, scope_type, scope_id, conversation_id, turn_id, source, title,
                user_text[:8000], assistant_text[:8000], summary[:6000], search_text,
                canonical_json(provenance), content_hash, created_at, now,
            ),
        )
        con.execute(
            "INSERT INTO memory_episodes_fts(episode_id, scope_type, scope_id, title, text) VALUES(?, ?, ?, ?, ?)",
            (episode_id, scope_type, scope_id, title, search_text),
        )
        self._bump_revision(con, scope_type, scope_id)
        self._compact_scope(con, scope_type, scope_id)
        self._clear_cache()
        return {"ok": True, "indexed": True, "episodeId": episode_id, "replayed": False}

    def _candidates(
        self,
        query: str,
        scope_type: str,
        scope_id: str,
        cross_chat_enabled: bool,
    ) -> list[RetrievalCandidate]:
        fts_query = make_fts_query(query)
        candidates: dict[tuple[str, str], RetrievalCandidate] = {}
        with self._connection() as con:
            if fts_query:
                self._append_explicit_fts(con, candidates, fts_query, scope_type, scope_id)
                if cross_chat_enabled:
                    self._append_episode_fts(con, candidates, fts_query, scope_type, scope_id)
                    self._append_capsule_fts(con, candidates, fts_query, scope_type, scope_id)
            recent_items = con.execute(
                "SELECT * FROM memory_items WHERE scope_type = ? AND scope_id = ? AND deleted_at IS NULL "
                "AND enabled = 1 AND closed_at IS NULL AND (expires_at IS NULL OR expires_at > ?) "
                "ORDER BY pinned DESC, updated_at DESC LIMIT ?",
                (scope_type, scope_id, utc_now(), self.CANDIDATE_LIMIT),
            ).fetchall()
            for row in recent_items:
                key = ("explicit", row["id"])
                if key not in candidates:
                    candidates[key] = explicit_candidate(row, 0.28 if row["pinned"] else 0.0)
            if cross_chat_enabled:
                recent_episodes = con.execute(
                    "SELECT * FROM memory_episodes WHERE scope_type = ? AND scope_id = ? AND state = 'hot' "
                    "ORDER BY created_at DESC LIMIT ?",
                    (scope_type, scope_id, self.CANDIDATE_LIMIT),
                ).fetchall()
                for row in recent_episodes:
                    key = ("episode", row["id"])
                    if key not in candidates:
                        candidates[key] = episode_candidate(row, 0.0)
                recent_capsules = con.execute(
                    "SELECT * FROM memory_capsules WHERE scope_type = ? AND scope_id = ? "
                    "ORDER BY updated_at DESC LIMIT 8",
                    (scope_type, scope_id),
                ).fetchall()
                for row in recent_capsules:
                    key = ("capsule", row["id"])
                    if key not in candidates:
                        candidates[key] = capsule_candidate(row, 0.0)
        ordered = sorted(
            candidates.values(),
            key=lambda item: (item.lexical_score, item.pinned, item.created_at),
            reverse=True,
        )
        return ordered[:self.CANDIDATE_LIMIT]

    def _append_explicit_fts(
        self, con: sqlite3.Connection, candidates: dict[tuple[str, str], RetrievalCandidate],
        query: str, scope_type: str, scope_id: str,
    ) -> None:
        rows = con.execute(
            "SELECT m.*, bm25(memory_items_fts) AS rank FROM memory_items_fts f "
            "JOIN memory_items m ON m.id = f.item_id WHERE memory_items_fts MATCH ? "
            "AND m.scope_type = ? AND m.scope_id = ? AND m.deleted_at IS NULL AND m.enabled = 1 "
            "ORDER BY rank LIMIT ?",
            (query, scope_type, scope_id, self.CANDIDATE_LIMIT),
        ).fetchall()
        for index, row in enumerate(rows):
            candidates[("explicit", row["id"])] = explicit_candidate(row, rank_score(index))

    def _append_episode_fts(
        self, con: sqlite3.Connection, candidates: dict[tuple[str, str], RetrievalCandidate],
        query: str, scope_type: str, scope_id: str,
    ) -> None:
        rows = con.execute(
            "SELECT e.*, bm25(memory_episodes_fts) AS rank FROM memory_episodes_fts f "
            "JOIN memory_episodes e ON e.id = f.episode_id WHERE memory_episodes_fts MATCH ? "
            "AND e.scope_type = ? AND e.scope_id = ? AND e.state = 'hot' ORDER BY rank LIMIT ?",
            (query, scope_type, scope_id, self.CANDIDATE_LIMIT),
        ).fetchall()
        for index, row in enumerate(rows):
            candidates[("episode", row["id"])] = episode_candidate(row, rank_score(index))

    def _append_capsule_fts(
        self, con: sqlite3.Connection, candidates: dict[tuple[str, str], RetrievalCandidate],
        query: str, scope_type: str, scope_id: str,
    ) -> None:
        rows = con.execute(
            "SELECT c.*, bm25(memory_capsules_fts) AS rank FROM memory_capsules_fts f "
            "JOIN memory_capsules c ON c.id = f.capsule_id WHERE memory_capsules_fts MATCH ? "
            "AND c.scope_type = ? AND c.scope_id = ? ORDER BY rank LIMIT 8",
            (query, scope_type, scope_id),
        ).fetchall()
        for index, row in enumerate(rows):
            candidates[("capsule", row["id"])] = capsule_candidate(row, rank_score(index))

    def _bounded_context(
        self,
        candidates: list[RetrievalCandidate],
        scope_type: str,
        scope_id: str,
        revision: str,
        engine: str,
        timed_out: bool,
        cross_chat_enabled: bool,
    ) -> dict[str, Any]:
        explicit: list[dict[str, Any]] = []
        episodes: list[dict[str, Any]] = []
        used = 0
        for candidate in candidates:
            target = explicit if candidate.kind == "explicit" else episodes
            limit = self.EXPLICIT_LIMIT if candidate.kind == "explicit" else self.EPISODE_LIMIT
            if len(target) >= limit:
                continue
            remaining = self.prompt_budget_chars - used
            if remaining < 80:
                break
            text = compact_text(candidate.text, min(600, remaining))
            if not text:
                continue
            item = {
                "kind": candidate.kind,
                "id": candidate.id,
                "text": text,
                "title": candidate.title,
                "createdAt": candidate.created_at,
                "score": round(candidate.final_score, 4),
                "reason": candidate.reason,
                "origin": {
                    **({"conversationId": candidate.conversation_id} if candidate.conversation_id else {}),
                    **({"turnId": candidate.turn_id} if candidate.turn_id else {}),
                    **({"capsuleId": candidate.capsule_id} if candidate.capsule_id else {}),
                },
            }
            target.append(item)
            used += len(text)
        return {
            "schemaVersion": 1,
            "scope": render_scope(scope_type, scope_id),
            "revision": revision,
            "explicitMemories": explicit,
            "episodes": episodes,
            "budgetChars": self.prompt_budget_chars,
            "usedChars": used,
            "engine": engine,
            "semanticTimedOut": timed_out,
            "crossChatEnabled": cross_chat_enabled,
            "cache": "miss",
        }

    def _cross_chat_enabled(self, scope_type: str, scope_id: str) -> bool:
        with self._connection() as con:
            row = con.execute(
                "SELECT cross_chat_enabled FROM memory_scope_preferences WHERE scope_type = ? AND scope_id = ?",
                (scope_type, scope_id),
            ).fetchone()
        return bool(row["cross_chat_enabled"]) if row else True

    def _compact_scope(self, con: sqlite3.Connection, scope_type: str, scope_id: str) -> None:
        hot = int(con.execute(
            "SELECT COUNT(*) AS n FROM memory_episodes WHERE scope_type = ? AND scope_id = ? AND state = 'hot'",
            (scope_type, scope_id),
        ).fetchone()["n"])
        if hot <= self.COMPACT_AFTER:
            return
        rows = con.execute(
            "SELECT * FROM memory_episodes WHERE scope_type = ? AND scope_id = ? AND state = 'hot' "
            "ORDER BY created_at LIMIT ?",
            (scope_type, scope_id, self.COMPACT_BATCH),
        ).fetchall()
        if not rows:
            return
        capsule_id = uuid.uuid4().hex
        children = [row["id"] for row in rows]
        topic = capsule_topic([row["user_text"] for row in rows])
        summary = "\n".join(
            f"- {compact_text(row['summary'] or row['search_text'], 220)}" for row in rows
        )[:5000]
        now = utc_now()
        provenance = {
            "schemaVersion": 1,
            "compaction": "topic-capsule",
            "children": children,
            "scope": render_scope(scope_type, scope_id),
        }
        con.execute(
            "INSERT INTO memory_capsules(id, scope_type, scope_id, topic, summary, children_json, provenance_json, "
            "created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (capsule_id, scope_type, scope_id, topic, summary, canonical_json(children), canonical_json(provenance), now, now),
        )
        con.execute(
            "INSERT INTO memory_capsules_fts(capsule_id, scope_type, scope_id, topic, text) VALUES(?, ?, ?, ?, ?)",
            (capsule_id, scope_type, scope_id, topic, summary),
        )
        placeholders = ",".join("?" for _ in children)
        con.execute(
            f"UPDATE memory_episodes SET state = 'compacted', capsule_id = ?, updated_at = ? WHERE id IN ({placeholders})",
            [capsule_id, now, *children],
        )
        con.execute(
            f"DELETE FROM memory_episodes_fts WHERE episode_id IN ({placeholders})",
            children,
        )

    def _backfill_conversations(self) -> None:
        source = "persistent-chat-v1"
        while True:
            with self._connection() as con:
                state = con.execute(
                    "SELECT cursor, completed FROM memory_v4_backfill_state WHERE source = ?",
                    (source,),
                ).fetchone()
                cursor = int(state["cursor"]) if state else 0
                if state and state["completed"]:
                    return
                rows = con.execute(
                    "SELECT m.rowid AS message_rowid, m.conversation_id, m.turn_id, m.created_at "
                    "FROM conversation_messages m WHERE m.rowid > ? AND m.role = 'assistant' "
                    "AND m.turn_id IS NOT NULL AND m.task_id IS NULL "
                    "AND m.outcome IN ('answered', 'answered:source-grounded') "
                    "AND COALESCE(json_extract(m.provenance_json, '$.surface'), 'desktop') = 'desktop' "
                    "AND COALESCE(json_extract(m.provenance_json, '$.privacyMode'), 'persistent') = 'persistent' "
                    "AND m.conversation_id NOT LIKE 'legacy:%' AND m.conversation_id NOT LIKE 'safe:%' "
                    "AND m.conversation_id NOT LIKE 'voice:%' AND m.conversation_id NOT LIKE 'telegram:%' "
                    "ORDER BY m.rowid LIMIT 50",
                    (cursor,),
                ).fetchall()
                if not rows:
                    con.execute(
                        "INSERT INTO memory_v4_backfill_state(source, cursor, completed, updated_at) VALUES(?, ?, 1, ?) "
                        "ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, completed = 1, updated_at = excluded.updated_at",
                        (source, cursor, utc_now()),
                    )
                    return
                for row in rows:
                    messages = con.execute(
                        "SELECT role, content, outcome, task_id, created_at FROM conversation_messages "
                        "WHERE conversation_id = ? AND turn_id = ? ORDER BY rowid",
                        (row["conversation_id"], row["turn_id"]),
                    ).fetchall()
                    user_text = next((item["content"] for item in messages if item["role"] == "user"), "")
                    assistant = next((item for item in reversed(messages) if item["role"] == "assistant"), None)
                    if user_text and assistant:
                        conversation = con.execute(
                            "SELECT title FROM conversations WHERE id = ?", (row["conversation_id"],)
                        ).fetchone()
                        self._index_episode_in_connection(
                            con,
                            scope_type="chat",
                            scope_id="default",
                            conversation_id=row["conversation_id"],
                            turn_id=row["turn_id"],
                            source="desktop",
                            title=str(conversation["title"] if conversation else "Чат")[:160],
                            user_text=user_text,
                            assistant_text=assistant["content"],
                            summary=episode_summary(user_text, assistant["content"]),
                            created_at=assistant["created_at"] or row["created_at"] or utc_now(),
                        )
                    cursor = int(row["message_rowid"])
                con.execute(
                    "INSERT INTO memory_v4_backfill_state(source, cursor, completed, updated_at) VALUES(?, ?, 0, ?) "
                    "ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, completed = 0, updated_at = excluded.updated_at",
                    (source, cursor, utc_now()),
                )

    def _index_revision(self, scope_type: str, scope_id: str) -> str:
        with self._connection() as con:
            episode = con.execute(
                "SELECT revision FROM memory_v4_scope_revisions WHERE scope_type = ? AND scope_id = ?",
                (scope_type, scope_id),
            ).fetchone()
            explicit = con.execute(
                "SELECT revision FROM settings_scope_revisions WHERE kind = 'memory' AND scope_type = ? AND scope_id = ?",
                (scope_type, scope_id),
            ).fetchone()
        return f"{int(explicit['revision']) if explicit else 0}:{int(episode['revision']) if episode else 0}"

    def _bump_revision(self, con: sqlite3.Connection, scope_type: str, scope_id: str) -> None:
        now = utc_now()
        con.execute(
            "INSERT INTO memory_v4_scope_revisions(scope_type, scope_id, revision, updated_at) VALUES(?, ?, 1, ?) "
            "ON CONFLICT(scope_type, scope_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at",
            (scope_type, scope_id, now),
        )

    def _cache_get(self, key: str) -> dict[str, Any] | None:
        with self._cache_lock:
            value = self._cache.pop(key, None)
            if value is None:
                return None
            self._cache[key] = value
            return json.loads(json.dumps(value, ensure_ascii=False))

    def _cache_put(self, key: str, value: dict[str, Any]) -> None:
        with self._cache_lock:
            self._cache[key] = json.loads(json.dumps(value, ensure_ascii=False))
            self._cache.move_to_end(key)
            while len(self._cache) > self.CACHE_LIMIT:
                self._cache.popitem(last=False)

    def _clear_cache(self) -> None:
        with self._cache_lock:
            self._cache.clear()


def explicit_candidate(row: sqlite3.Row, lexical: float) -> RetrievalCandidate:
    return RetrievalCandidate(
        kind="explicit",
        id=row["id"],
        text=row["content"],
        title=row["title"] or "Постоянная память",
        created_at=row["updated_at"],
        lexical_score=lexical,
        pinned=bool(row["pinned"]),
    )


def episode_candidate(row: sqlite3.Row, lexical: float) -> RetrievalCandidate:
    return RetrievalCandidate(
        kind="episode",
        id=row["id"],
        text=episode_context_text(row["user_text"], row["assistant_text"]),
        title=row["title"] or "Прошлый чат",
        created_at=row["created_at"],
        lexical_score=lexical,
        conversation_id=row["conversation_id"],
        turn_id=row["turn_id"],
    )


def capsule_candidate(row: sqlite3.Row, lexical: float) -> RetrievalCandidate:
    return RetrievalCandidate(
        kind="capsule",
        id=row["id"],
        text=row["summary"],
        title=f"Тема · {row['topic']}",
        created_at=row["updated_at"],
        lexical_score=lexical,
        capsule_id=row["id"],
    )


def rank_score(index: int) -> float:
    return max(0.35, 1.0 - index * 0.035)


def episode_summary(user_text: str, assistant_text: str) -> str:
    return f"Запрос: {compact_text(user_text, 700)}\nИтог: {compact_text(assistant_text, 1200)}"


def episode_context_text(user_text: str, assistant_text: str) -> str:
    return f"Пользователь: {compact_text(user_text, 480)}\nOscar: {compact_text(assistant_text, 900)}"


def capsule_topic(texts: list[str]) -> str:
    words = Counter(
        word.casefold()
        for text in texts
        for word in re.findall(r"[\wа-яё]{4,}", text, re.I)
        if word.casefold() not in {"который", "потом", "сделать", "monarch", "oscar", "этого", "через"}
    )
    return " · ".join(word for word, _count in words.most_common(3)) or "история"


def normalize_scope(scope: dict[str, str | None]) -> tuple[str, str]:
    scope_type = str(scope.get("type") or "").strip()
    project_id = str(scope.get("projectId") or scope.get("project_id") or "").strip()
    if scope_type == "chat" and not project_id:
        return "chat", "default"
    if scope_type == "coder-project" and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}", project_id):
        return scope_type, project_id
    raise ValueError("Invalid memory scope.")


def render_scope(scope_type: str, scope_id: str) -> dict[str, str]:
    return {"type": "chat"} if scope_type == "chat" else {"type": scope_type, "projectId": scope_id}


def empty_context(
    scope_type: str,
    scope_id: str,
    engine: str,
    budget_chars: int = 2400,
    cross_chat_enabled: bool = True,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "scope": render_scope(scope_type, scope_id),
        "revision": "0:0",
        "explicitMemories": [],
        "episodes": [],
        "budgetChars": budget_chars,
        "usedChars": 0,
        "engine": engine,
        "semanticTimedOut": False,
        "crossChatEnabled": cross_chat_enabled,
        "cache": "miss",
    }


def normalize_query(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:2048]


def compact_text(value: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def bounded_id(value: str, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) > limit or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", text):
        raise ValueError("Memory binding id is invalid.")
    return text


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
