"""Memory 4.1 engine: storage, indexing and recall for Oscar and Coder.

One engine, two profiles: the person's memory (scope chat/default) and a
project's memory (scope coder-project/<id>, never searched across projects).
The Oscar database is the authority; FTS projections and E5 vectors are
derived state kept in step by triggers (memory_index) and by the background
worker below.

Recall answers one question: what is worth a place in this prompt?
* the profile core (rules, pinned and "about me" records) is small and always
  comes along, so Oscar knows who it talks to;
* everything else must be relevant: IDF-weighted stem coverage plus the E5
  similarity margin over the scope background (memory_retrieval);
* episodes of the chat being answered are excluded (they are in the history),
  at most two come from any one conversation, and a direct match beats the
  capsule that summarises it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3

from . import secure_db
import threading
import time
import uuid
from collections import OrderedDict, Counter
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .config import Settings
from .memory import purge_orphan_derived_memory
from .memory_index import initialize_index, remember_forgetting
from .memory_retrieval import Candidate, idf, lexical_coverage, noise_floor, relevant, score
from .memory_text import STEMMER_VERSION, STOPWORDS, fts_query, query_terms, stem_text, words
from .memory_vectors import ORPHANS, PENDING_QUERIES, SCHEMA as VECTOR_SCHEMA, VectorIndex, passage_text, store_vectors
from .semantic_memory import SemanticMemoryReranker

LOGGER = logging.getLogger(__name__)

PROFILE_CATEGORIES = ("about", "rule", "profile", "instruction")
ACTIVE_ITEM = (
    "{p}deleted_at IS NULL AND {p}enabled = 1 AND {p}closed_at IS NULL AND {p}status = 'active' "
    "AND {p}origin IN ('owner', 'learned') AND ({p}expires_at IS NULL OR julianday({p}expires_at) > julianday(?))"
)


@dataclass(slots=True)
class RetrievalCandidate:
    """Kept for callers that build a candidate by hand (tests, diagnostics)."""
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

    def to_candidate(self) -> Candidate:
        return Candidate(kind=self.kind, id=self.id, text=self.text, title=self.title, created_at=self.created_at,
                         stems=frozenset(), pinned=self.pinned, conversation_id=self.conversation_id,
                         turn_id=self.turn_id, capsule_id=self.capsule_id, lexical=self.lexical_score)


class MemoryV4Service:
    EXPLICIT_LIMIT = 6
    EPISODE_LIMIT = 4
    PROFILE_LIMIT = 4
    PROFILE_BUDGET_CHARS = 600
    FTS_LIMIT = 24
    VECTOR_LIMIT = 24
    PER_CONVERSATION_LIMIT = 2
    CANDIDATE_LIMIT = 32
    CACHE_LIMIT = 128
    CACHE_TTL_SECONDS = 30.0
    FALLBACK_CACHE_TTL_SECONDS = 1.0
    COMPACT_AFTER = 240
    COMPACT_BATCH = 40
    EMBED_BATCH = 16
    EMBED_BATCHES_PER_TICK = 64
    STEM_BATCH = 200
    PURGE_DELETED_AFTER_DAYS = 30
    HYGIENE_INTERVAL_SECONDS = 600.0

    def __init__(self, settings: Settings):
        self.db_path = Path(settings.db_path)
        self.prompt_budget_chars = int(settings.memory_prompt_budget_chars)
        self.reranker = SemanticMemoryReranker(
            Path(settings.memory_embedding_model_dir),
            int(settings.memory_retrieval_deadline_ms),
        )
        self._vectors = VectorIndex()
        self._cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._touch_lock = threading.Lock()
        self._touched: set[str] = set()
        self._background = ThreadPoolExecutor(max_workers=1, thread_name_prefix="monarch-memory-backfill")
        self._background_started = False
        self._lifecycle_lock = threading.Lock()
        self._stopping = threading.Event()
        self._wake = threading.Event()
        self._last_hygiene = 0.0
        # An upgrade that cannot open or migrate memory leaves chat working
        # without it; the transaction rolled back, so the next start retries.
        self.init_error: str | None = None
        try:
            self._init_db()
        except Exception as exc:
            LOGGER.exception("Memory could not be opened")
            self.init_error = f"memory-init-failed:{type(exc).__name__}"

    @contextmanager
    def _connection(self, *, timeout: float = 10.0, write: bool = False) -> Iterator[sqlite3.Connection]:
        con = secure_db.connect(self.db_path, timeout=timeout)
        try:
            con.execute("PRAGMA foreign_keys=ON")
            con.execute("PRAGMA secure_delete=ON")
            con.execute("PRAGMA synchronous=FULL" if write else "PRAGMA synchronous=NORMAL")
            if write:
                con.execute("BEGIN IMMEDIATE")
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
            con.execute("PRAGMA synchronous=FULL")
            existing_tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            con.execute("CREATE TABLE IF NOT EXISTS memory_v4_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), corpus_id TEXT NOT NULL)")
            con.execute("INSERT OR IGNORE INTO memory_v4_identity(singleton, corpus_id) VALUES (1, ?)", (uuid.uuid4().hex,))
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
                """
            )
            con.executescript(VECTOR_SCHEMA)
            # Projection upgrade and its marker commit in one transaction.
            con.commit()
            con.execute("BEGIN IMMEDIATE")
            initialize_index(con, rebuild=not {"memory_items_fts", "memory_episodes_fts", "memory_capsules_fts", "memory_index_jobs"} <= existing_tables)
            # Builds before this one kept episodes of deleted chats forever.
            # Startup is the migration point: retention now follows the chat.
            purged = purge_orphan_derived_memory(con)
        if purged["episodes"] or purged["capsules"]:
            LOGGER.info(
                "Removed derived memory left by deleted conversations: %d episodes, %d capsules",
                purged["episodes"], purged["capsules"],
            )

    # ------------------------------------------------------------------ worker

    def start_background(self) -> None:
        with self._lifecycle_lock:
            if self._background_started or self._stopping.is_set() or self.init_error:
                return
            self._background_started = True
            self.reranker.warmup()
            self._background.submit(self._run_background)

    def notify_changed(self) -> None:
        """Something was written (an answer, a record): index it soon."""
        self._clear_cache()
        self._wake.set()

    def _run_background(self) -> None:
        while not self._stopping.is_set():
            for step in (self._backfill_conversations, self._repair_stems, self._flush_touches,
                         self._embed_pending, self._hygiene_if_due):
                if self._stopping.is_set():
                    break
                try:
                    step()
                except Exception as exc:
                    # Every step works in bounded transactions; a failed batch
                    # rolls back including its jobs, so a later retry is safe.
                    LOGGER.warning("Memory maintenance deferred (%s): %s", step.__name__, type(exc).__name__)
            self._wake.wait(30)
            self._wake.clear()

    def close(self) -> None:
        with self._lifecycle_lock:
            self._stopping.set()
            self._wake.set()
        # Drain the current bounded transaction; no backfill writes after close.
        self._background.shutdown(wait=True, cancel_futures=True)
        self.reranker.close()
        self._clear_cache()

    def _repair_stems(self) -> None:
        """Rows written before 4.1, or by a writer that does not stem, get
        their stems here; until then the raw text column still matches."""
        plans = (
            ("memory_items", "title || ' ' || content || ' ' || tags_json"),
            ("memory_episodes", "search_text"),
            ("memory_capsules", "topic || ' ' || summary"),
        )
        for table, expression in plans:
            while not self._stopping.is_set():
                with self._connection(write=True) as con:
                    rows = con.execute(
                        f"SELECT id, {expression} AS body FROM {table} WHERE stems_version < ? LIMIT ?",
                        (STEMMER_VERSION, self.STEM_BATCH),
                    ).fetchall()
                    for row in rows:
                        con.execute(f"UPDATE {table} SET search_stems = ?, stems_version = ? WHERE id = ?",
                                    (stem_text(row["body"] or ""), STEMMER_VERSION, row["id"]))
                if len(rows) < self.STEM_BATCH:
                    break

    def _embed_pending(self) -> None:
        if not self.reranker.files_present:
            return
        model_id = self.reranker.model_id
        if not model_id:
            return
        for _ in range(self.EMBED_BATCHES_PER_TICK):
            wrote = False
            for kind, query in PENDING_QUERIES.items():
                if self._stopping.is_set():
                    return
                with self._connection() as con:
                    rows = con.execute(query, (model_id, self.EMBED_BATCH)).fetchall()
                if not rows:
                    continue
                vectors = self.reranker.embed_passages([passage_text(kind, row["title"], row["body"]) for row in rows])
                with self._connection(write=True) as con:
                    store_vectors(con, model_id, kind, rows, vectors)
                self._vectors.invalidate()
                self._clear_cache()
                wrote = True
                # Leave the CPU to an answer being generated right now.
                self._stopping.wait(0.02)
            if not wrote:
                return

    def _flush_touches(self) -> None:
        with self._touch_lock:
            touched, self._touched = sorted(self._touched), set()
        if not touched:
            return
        placeholders = ",".join("?" for _ in touched)
        with self._connection(write=True) as con:
            # Not an indexed column: FTS triggers do not fire, revisions stay.
            con.execute(
                f"UPDATE memory_items SET access_count = access_count + 1, last_used_at = ? WHERE id IN ({placeholders})",
                [utc_now(), *touched],
            )

    def _hygiene_if_due(self) -> None:
        if time.monotonic() - self._last_hygiene < self.HYGIENE_INTERVAL_SECONDS:
            return
        self._last_hygiene = time.monotonic()
        self.run_hygiene()

    def run_hygiene(self) -> dict[str, int]:
        """Deleted records leave for good after a grace period that keeps
        "Вернуть" possible; derived vectors and receipts do not outlive their
        sources."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=self.PURGE_DELETED_AFTER_DAYS)).isoformat()
        with self._connection(write=True) as con:
            purged = con.execute(
                "DELETE FROM memory_items WHERE deleted_at IS NOT NULL AND julianday(deleted_at) < julianday(?)",
                (cutoff,),
            ).rowcount
            vectors = con.execute(ORPHANS).rowcount
            receipts = con.execute(
                "DELETE FROM memory_forget_receipts WHERE source = 'desktop' "
                "AND turn_id NOT IN (SELECT turn_id FROM conversation_messages WHERE turn_id IS NOT NULL)"
            ).rowcount
        if vectors:
            self._vectors.invalidate()
        return {"items": purged, "vectors": vectors, "receipts": receipts}

    # ------------------------------------------------------------ derived CRUD

    def list_derived_memory(self, scope: dict[str, str | None]) -> dict[str, Any]:
        """Everything Memory V4 remembered about a scope without being asked.

        Explicit memories are managed through the memory.* settings commands;
        this is the missing counterpart for the automatic side (episodes and
        the capsules they compact into), so an owner can see and remove what
        was captured from their conversations instead of only being told
        "Из памяти" with no way to look at or delete the source.
        """
        scope_type, scope_id = normalize_scope(scope)
        with self._connection() as con:
            episode_rows = con.execute(
                "SELECT id, conversation_id, turn_id, source, title, summary, created_at "
                "FROM memory_episodes WHERE scope_type = ? AND scope_id = ? AND state = 'hot' "
                "ORDER BY created_at DESC",
                (scope_type, scope_id),
            ).fetchall()
            capsule_rows = con.execute(
                "SELECT id, topic, summary, children_json, updated_at "
                "FROM memory_capsules WHERE scope_type = ? AND scope_id = ? "
                "ORDER BY updated_at DESC",
                (scope_type, scope_id),
            ).fetchall()
        episodes = [
            {
                "id": row["id"],
                "conversationId": row["conversation_id"],
                "turnId": row["turn_id"],
                "source": row["source"],
                "title": row["title"],
                "summary": row["summary"],
                "createdAt": row["created_at"],
            }
            for row in episode_rows
        ]
        capsules = [
            {
                "id": row["id"],
                "topic": row["topic"],
                "summary": row["summary"],
                "childCount": len(json.loads(row["children_json"])),
                "updatedAt": row["updated_at"],
            }
            for row in capsule_rows
        ]
        return {"scope": render_scope(scope_type, scope_id), "episodes": episodes, "capsules": capsules}

    def forget_episode(self, episode_id: str, scope: dict[str, str | None]) -> bool:
        """Remove a single automatically captured episode.

        Any capsule quoting this episode is dropped too. A content-free receipt
        prevents replay and backfill from restoring the forgotten source.
        """
        scope_type, scope_id = normalize_scope(scope)
        with self._connection(write=True) as con:
            remember_forgetting(con, "id = ? AND scope_type = ? AND scope_id = ?", (episode_id, scope_type, scope_id))
            cursor = con.execute(
                "DELETE FROM memory_episodes WHERE id = ? AND scope_type = ? AND scope_id = ?",
                (episode_id, scope_type, scope_id),
            )
            removed = cursor.rowcount > 0
            if removed:
                con.execute("DELETE FROM memory_vectors WHERE owner_kind = 'episode' AND owner_id = ?", (episode_id,))
                self._drop_empty_capsules(con, scope_type, scope_id)
                self._bump_revision(con, scope_type, scope_id)
        if removed:
            self._vectors.invalidate()
            self._clear_cache()
        return removed

    def forget_capsule(self, capsule_id: str, scope: dict[str, str | None]) -> bool:
        scope_type, scope_id = normalize_scope(scope)
        with self._connection(write=True) as con:
            remember_forgetting(con, "capsule_id = ? AND scope_type = ? AND scope_id = ?", (capsule_id, scope_type, scope_id))
            con.execute("DELETE FROM memory_episodes WHERE capsule_id = ? AND scope_type = ? AND scope_id = ?", (capsule_id, scope_type, scope_id))
            cursor = con.execute(
                "DELETE FROM memory_capsules WHERE id = ? AND scope_type = ? AND scope_id = ?",
                (capsule_id, scope_type, scope_id),
            )
            removed = cursor.rowcount > 0
            if removed:
                con.execute(ORPHANS)
                self._bump_revision(con, scope_type, scope_id)
        if removed:
            self._vectors.invalidate()
            self._clear_cache()
        return removed

    def forget_all_derived_memory(self, scope: dict[str, str | None]) -> dict[str, int]:
        """"Забыть всё автоматическое" for one scope: every episode and capsule."""
        scope_type, scope_id = normalize_scope(scope)
        with self._connection(write=True) as con:
            episodes = int(con.execute("SELECT COUNT(*) FROM memory_episodes WHERE scope_type = ? AND scope_id = ?", (scope_type, scope_id)).fetchone()[0])
            capsules = int(con.execute("SELECT COUNT(*) FROM memory_capsules WHERE scope_type = ? AND scope_id = ?", (scope_type, scope_id)).fetchone()[0])
            remember_forgetting(con, "scope_type = ? AND scope_id = ?", (scope_type, scope_id))
            if scope_type == "chat":
                # Include not-yet-indexed messages: backfill cannot undo Forget all.
                con.execute(
                    "INSERT OR IGNORE INTO memory_forget_receipts(scope_type, scope_id, source, turn_id) "
                    "SELECT 'chat', 'default', 'desktop', turn_id FROM conversation_messages WHERE turn_id IS NOT NULL"
                )
            con.execute("DELETE FROM memory_episodes WHERE scope_type = ? AND scope_id = ?", (scope_type, scope_id))
            con.execute("DELETE FROM memory_capsules WHERE scope_type = ? AND scope_id = ?", (scope_type, scope_id))
            con.execute("DELETE FROM memory_vectors WHERE owner_kind IN ('episode', 'capsule') AND scope_type = ? AND scope_id = ?",
                        (scope_type, scope_id))
            if episodes or capsules:
                self._bump_revision(con, scope_type, scope_id)
        self._vectors.invalidate()
        self._clear_cache()
        return {"episodes": episodes, "capsules": capsules}

    def _drop_empty_capsules(self, con: sqlite3.Connection, scope_type: str, scope_id: str) -> None:
        con.execute(
            "DELETE FROM memory_capsules WHERE scope_type = ? AND scope_id = ? "
            "AND EXISTS (SELECT 1 FROM json_each(memory_capsules.children_json) child "
            "WHERE NOT EXISTS (SELECT 1 FROM memory_episodes e WHERE e.id = child.value))",
            (scope_type, scope_id),
        )
        con.execute(
            "UPDATE memory_episodes SET state = 'hot', capsule_id = NULL "
            "WHERE scope_type = ? AND scope_id = ? AND state = 'compacted' "
            "AND capsule_id NOT IN (SELECT id FROM memory_capsules)",
            (scope_type, scope_id),
        )

    def invalidate_cache(self) -> None:
        """Drop retrieved snapshots held in memory after a deletion.

        A bumped scope revision already makes stale entries unreachable; this
        also stops the deleted text from sitting in this process' cache.
        """
        self._vectors.invalidate()
        self._clear_cache()

    # ---------------------------------------------------------------- indexing

    def index_turn(self, *, conversation_id: str, turn_id: str, source: str) -> dict[str, Any]:
        if source != "desktop":
            return {"ok": False, "indexed": False, "reason": "source-excluded"}
        with self._connection(write=True) as con:
            result = self._index_conversation_turn(con, conversation_id, turn_id)
            if result.get("reason") != "turn-messages-incomplete":
                con.execute(
                    "DELETE FROM memory_index_jobs WHERE message_id IN "
                    "(SELECT id FROM conversation_messages WHERE conversation_id = ? AND turn_id = ?)",
                    (conversation_id, turn_id),
                )
        if result.get("indexed") and not result.get("replayed"):
            self._wake.set()
        return result

    def _index_conversation_turn(self, con: sqlite3.Connection, conversation_id: str, turn_id: str) -> dict[str, Any]:
        messages = con.execute(
            "SELECT role, content, outcome, task_id, created_at, provenance_json FROM conversation_messages "
            "WHERE conversation_id = ? AND turn_id = ? ORDER BY rowid",
            (conversation_id, turn_id),
        ).fetchall()
        user_text = next((row["content"] for row in messages if row["role"] == "user"), "")
        assistant = next((row for row in reversed(messages) if row["role"] == "assistant"), None)
        if not user_text or not assistant:
            return {"ok": False, "indexed": False, "reason": "turn-messages-incomplete"}
        if not episode_source_indexable(conversation_id, messages):
            return {"ok": False, "indexed": False, "reason": "provenance-excluded"}
        if not episode_outcome_indexable(assistant["outcome"], assistant["task_id"]):
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

    def turn_user_text(self, conversation_id: str, turn_id: str) -> str:
        with self._connection() as con:
            row = con.execute(
                "SELECT content FROM conversation_messages WHERE conversation_id = ? AND turn_id = ? AND role = 'user' "
                "ORDER BY rowid LIMIT 1",
                (conversation_id, turn_id),
            ).fetchone()
        return str(row["content"]) if row else ""

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
        with self._connection(write=True) as con:
            result = self._index_episode_in_connection(
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
        self._wake.set()
        return result

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
        if not episode_has_content(user_text):
            return {"ok": True, "indexed": False, "reason": "request-without-content"}
        forgotten = con.execute(
            "SELECT 1 FROM memory_forget_receipts WHERE scope_type = ? AND scope_id = ? AND source = ? AND turn_id = ?",
            (scope_type, scope_id, source, turn_id),
        ).fetchone()
        if forgotten:
            return {"ok": True, "indexed": False, "reason": "owner-forgotten"}
        existing = con.execute(
            "SELECT id, scope_type, scope_id, conversation_id FROM memory_episodes WHERE source = ? AND turn_id = ?",
            (source, turn_id),
        ).fetchone()
        if existing:
            if (existing["scope_type"], existing["scope_id"], existing["conversation_id"]) != (scope_type, scope_id, conversation_id):
                return {"ok": False, "indexed": False, "reason": "source-binding-conflict"}
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
            "created_at, updated_at, search_stems, stems_version) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hot', NULL, ?, ?, ?, ?, ?, ?)",
            (
                episode_id, scope_type, scope_id, conversation_id, turn_id, source, title,
                user_text[:8000], assistant_text[:8000], summary[:6000], search_text,
                canonical_json(provenance), content_hash, created_at, now,
                stem_text(search_text), STEMMER_VERSION,
            ),
        )

        self._bump_revision(con, scope_type, scope_id)
        self._compact_scope(con, scope_type, scope_id)
        self._clear_cache()
        return {"ok": True, "indexed": True, "episodeId": episode_id, "replayed": False}

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
        # A digest of what was asked; the children stay searchable for detail.
        summary = "\n".join(f"- {compact_text(row['user_text'], 160)}" for row in rows)[:5000]
        now = utc_now()
        provenance = {
            "schemaVersion": 1,
            "compaction": "topic-capsule",
            "children": children,
            "scope": render_scope(scope_type, scope_id),
        }
        con.execute(
            "INSERT INTO memory_capsules(id, scope_type, scope_id, topic, summary, children_json, provenance_json, "
            "created_at, updated_at, search_stems, stems_version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (capsule_id, scope_type, scope_id, topic, summary, canonical_json(children), canonical_json(provenance),
             now, now, stem_text(topic, summary), STEMMER_VERSION),
        )

        placeholders = ",".join("?" for _ in children)
        con.execute(
            f"UPDATE memory_episodes SET state = 'compacted', capsule_id = ?, updated_at = ? WHERE id IN ({placeholders})",
            [capsule_id, now, *children],
        )

    def _backfill_conversations(self) -> None:
        # Consume durable work in bounded transactions. The legacy cursor is
        # diagnostic only; SQLite rowids can be reused after history deletion.
        source = "persistent-chat-v1"
        while not self._stopping.is_set():
            with self._connection(write=True) as con:
                rows = con.execute(
                    "SELECT m.id, m.rowid AS message_rowid, m.conversation_id, m.turn_id "
                    "FROM memory_index_jobs j JOIN conversation_messages m ON m.id = j.message_id "
                    "ORDER BY j.rowid LIMIT 50"
                ).fetchall()
                for row in rows:
                    if self._stopping.is_set():
                        break
                    self._index_conversation_turn(con, row["conversation_id"], row["turn_id"])
                    con.execute("DELETE FROM memory_index_jobs WHERE message_id = ?", (row["id"],))
                con.execute(
                    "INSERT INTO memory_v4_backfill_state(source, cursor, completed, updated_at) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, completed = excluded.completed, updated_at = excluded.updated_at",
                    (source, int(rows[-1]["message_rowid"]) if rows else 0, int(not rows), utc_now()),
                )
            if not rows:
                return

    # ------------------------------------------------------------------ recall

    def retrieve(
        self,
        query: str,
        scope: dict[str, str | None],
        *,
        exclude_conversation_id: str | None = None,
    ) -> dict[str, Any]:
        """`exclude_conversation_id` names the chat being answered: its turns are
        already in the prompt as history, so recalling them again only repeats
        Oscar's own earlier replies back to it as "a past chat" — a refusal
        recalled that way was answered with the same refusal, turn after turn."""
        query = normalize_query(query)
        scope_type, scope_id = normalize_scope(scope)
        stamp = self._retrieval_stamp(scope_type, scope_id)
        revision, cross_chat_enabled, _next_expiry, _identity = stamp
        if not query:
            result = empty_context(scope_type, scope_id, "empty-query", self.prompt_budget_chars, cross_chat_enabled)
            return {**result, **self._validity(scope_type, scope_id, stamp)}
        cache_key = hashlib.sha256(
            f"{scope_type}\0{scope_id}\0{canonical_json(stamp)}\0{self._vectors.generation}\0"
            f"{exclude_conversation_id or ''}\0{query.casefold()}".encode("utf-8")
        ).hexdigest()
        cached = self._cache_get(cache_key)
        if cached is not None:
            if self._retrieval_stamp(scope_type, scope_id) == stamp:
                return {**cached, "cache": "hit"}
            return self._changed_context(scope_type, scope_id)

        embedding = self.reranker.embed_query(query)
        candidates, semantic_ready = self._candidates(
            query, scope_type, scope_id, cross_chat_enabled,
            exclude_conversation_id=exclude_conversation_id, query_vector=embedding.vector,
        )
        reranker_status = "reranker-ready" if semantic_ready \
            else "reranker-timeout" if embedding.timed_out else "reranker-unavailable"
        context = self._bounded_context(
            candidates, scope_type, scope_id, revision, embedding.engine, embedding.timed_out,
            cross_chat_enabled, "reranker-ready" if semantic_ready else "lexical-floor-fallback", reranker_status,
        )
        # Embedding may run concurrently with deletion, a consent change, or an
        # item's expiry. Never publish a result prepared under a stale scope.
        if self._retrieval_stamp(scope_type, scope_id) != stamp:
            return self._changed_context(scope_type, scope_id)
        context.update(self._validity(scope_type, scope_id, stamp))
        with self._touch_lock:
            self._touched.update(item["id"] for item in context["explicitMemories"])
        self._cache_put(cache_key, context)
        return context

    def read_context_validity(self, scope: dict[str, str | None], *, lock_timeout: float = 10.0) -> dict[str, Any]:
        """Content-free live check. No search, reranking or background model work."""
        scope_type, scope_id = normalize_scope(scope)
        if not 0 < lock_timeout <= 10.0:
            raise ValueError("memory-validity-lock-timeout")
        return self._validity(scope_type, scope_id, self._retrieval_stamp(scope_type, scope_id, lock_timeout=lock_timeout))

    @staticmethod
    def _validity(scope_type: str, scope_id: str, stamp: tuple[str, bool, float | None, str]) -> dict[str, Any]:
        token = hashlib.sha256(canonical_json([scope_type, scope_id, *stamp]).encode("utf-8")).hexdigest()
        return {"schemaVersion": 1, "scope": render_scope(scope_type, scope_id), "revision": stamp[0],
                "crossChatEnabled": stamp[1], "validityToken": "sha256:" + token}

    def _retrieval_stamp(self, scope_type: str, scope_id: str, *, lock_timeout: float = 10.0) -> tuple[str, bool, float | None, str]:
        # One SQLite statement gives one read snapshot for revision, consent and
        # the next expiry. Time passing invalidates cache keys without a write.
        with self._connection(timeout=lock_timeout) as con:
            row = con.execute(
                "SELECT (SELECT corpus_id FROM memory_v4_identity WHERE singleton = 1) AS corpus_identity, "
                "COALESCE((SELECT revision FROM settings_scope_revisions WHERE kind = 'memory' AND scope_type = ? AND scope_id = ?), 0) AS explicit_revision, "
                "COALESCE((SELECT revision FROM memory_v4_scope_revisions WHERE scope_type = ? AND scope_id = ?), 0) AS episode_revision, "
                "COALESCE((SELECT cross_chat_enabled FROM memory_scope_preferences WHERE scope_type = ? AND scope_id = ?), 1) AS cross_chat_enabled, "
                "(SELECT MIN(julianday(expires_at)) FROM memory_items WHERE scope_type = ? AND scope_id = ? "
                "AND deleted_at IS NULL AND enabled = 1 AND closed_at IS NULL AND julianday(expires_at) > julianday(?)) AS next_expiry",
                (scope_type, scope_id) * 4 + (utc_now(),),
            ).fetchone()
        if not row["corpus_identity"]:
            raise ValueError("memory-corpus-identity-missing")
        return (f"{row['explicit_revision']}:{row['episode_revision']}", bool(row["cross_chat_enabled"]), row["next_expiry"], row["corpus_identity"])

    def _changed_context(self, scope_type: str, scope_id: str) -> dict[str, Any]:
        stamp = self._retrieval_stamp(scope_type, scope_id)
        result = empty_context(scope_type, scope_id, "scope-changed", self.prompt_budget_chars, stamp[1])
        result.update(self._validity(scope_type, scope_id, stamp))
        return result

    def _candidates(
        self,
        query: str,
        scope_type: str,
        scope_id: str,
        cross_chat_enabled: bool,
        *,
        exclude_conversation_id: str | None = None,
        query_vector: Any = None,
    ) -> tuple[list[Candidate], bool]:
        """Scored candidates, profile core first, then by relevance."""
        terms = query_terms(query)
        raw = [word for word in words(query) if word not in STOPWORDS and len(word) >= 3]
        match = fts_query(list(dict.fromkeys([*terms, *raw]))[:16])
        now = utc_now()
        found: dict[tuple[str, str], Candidate] = {}
        semantic_ready = False
        floor: float | None = None
        with self._connection() as con:
            weights = self._term_weights(con, terms)
            for row in con.execute(
                "SELECT * FROM memory_items WHERE scope_type = ? AND scope_id = ? AND " + ACTIVE_ITEM.format(p="")
                + " AND (pinned = 1 OR category IN ('about', 'rule', 'profile', 'instruction')) "
                "ORDER BY pinned DESC, CASE WHEN category IN ('rule', 'instruction') THEN 0 ELSE 1 END, "
                "access_count DESC, updated_at DESC LIMIT ?",
                (scope_type, scope_id, now, self.PROFILE_LIMIT * 3),
            ):
                candidate = explicit_candidate(row)
                candidate.profile = True
                found[("explicit", candidate.id)] = candidate
            if match:
                for row in con.execute(
                    "SELECT m.* FROM memory_items_fts f JOIN memory_items m ON m.rowid = f.rowid "
                    "WHERE memory_items_fts MATCH ? AND m.scope_type = ? AND m.scope_id = ? AND "
                    + ACTIVE_ITEM.format(p="m.") + " ORDER BY bm25(memory_items_fts) LIMIT ?",
                    (match, scope_type, scope_id, now, self.FTS_LIMIT),
                ):
                    found.setdefault(("explicit", row["id"]), explicit_candidate(row))
                if cross_chat_enabled:
                    for row in con.execute(
                        "SELECT e.* FROM memory_episodes_fts f JOIN memory_episodes e ON e.rowid = f.rowid "
                        "WHERE memory_episodes_fts MATCH ? AND e.scope_type = ? AND e.scope_id = ? "
                        "AND e.state IN ('hot', 'compacted') AND (? IS NULL OR e.conversation_id != ?) "
                        "ORDER BY bm25(memory_episodes_fts) LIMIT ?",
                        (match, scope_type, scope_id, exclude_conversation_id, exclude_conversation_id, self.FTS_LIMIT),
                    ):
                        found.setdefault(("episode", row["id"]), episode_candidate(row))
                    for row in con.execute(
                        "SELECT c.* FROM memory_capsules_fts f JOIN memory_capsules c ON c.rowid = f.rowid "
                        "WHERE memory_capsules_fts MATCH ? AND c.scope_type = ? AND c.scope_id = ? "
                        "AND NOT EXISTS (SELECT 1 FROM memory_episodes e, json_each(c.children_json) child "
                        "WHERE e.id = child.value AND e.conversation_id = ?) ORDER BY bm25(memory_capsules_fts) LIMIT 8",
                        (match, scope_type, scope_id, exclude_conversation_id),
                    ):
                        found.setdefault(("capsule", row["id"]), capsule_candidate(row))
            similarities: dict[tuple[str, str], float] = {}
            if query_vector is not None:
                matrix = self._vectors.matrix(con, scope_type, scope_id, self.reranker.model_id)
                if matrix is not None:
                    import numpy as np

                    vector = np.asarray(query_vector, dtype=np.float32)
                    shaped = (vector.shape == (matrix.matrix.shape[1],) and bool(np.all(np.isfinite(vector)))
                              and abs(float(np.linalg.norm(vector)) - 1.0) < 0.02)
                    sims = matrix.scores(vector) if shaped else None
                    # A malformed vector (wrong size, NaN, not normalised)
                    # means no semantics this time, never a broken answer.
                    if sims is not None and np.all(np.isfinite(sims)) and float(np.max(np.abs(sims))) <= 1.01:
                        semantic_ready = True
                        floor = noise_floor(sims)
                        similarities = {(kind, owner): float(value)
                                        for kind, owner, value in zip(matrix.kinds, matrix.ids, sims.tolist())}
                        order = np.argsort(-sims)[: self.VECTOR_LIMIT]
                        wanted: dict[str, list[str]] = {}
                        for index in order:
                            if float(sims[index]) <= floor:
                                break
                            key = (matrix.kinds[index], matrix.ids[index])
                            if key not in found:
                                wanted.setdefault(key[0], []).append(key[1])
                        self._fetch_by_ids(con, found, wanted, scope_type, scope_id, cross_chat_enabled,
                                           exclude_conversation_id, now)
                elif self.reranker.files_present:
                    # The model is ready but nothing in this scope has a vector
                    # yet (a fresh install, or the first minutes after 4.1).
                    semantic_ready = False
        for key, candidate in found.items():
            if not candidate.stems:
                candidate.stems = frozenset(stem_text(candidate.title, candidate.text).split())
            candidate.lexical, candidate.matched = lexical_coverage(terms, weights, candidate.stems)
            candidate.semantic = similarities.get(key)
            score(candidate, floor if semantic_ready else None)
        ordered = sorted(
            found.values(),
            # Profile core first; on a tie the episode that matched beats the
            # capsule summarising it: the capsule is a digest, the episode
            # carries the detail asked for.
            key=lambda item: (item.profile, round(item.score, 3), item.kind == "episode", item.created_at),
            reverse=True,
        )
        best = max((item.semantic for item in found.values() if item.semantic is not None), default=None)
        kept = [item for item in ordered
                if item.profile or relevant(item, len(terms), best)]
        return kept[: self.CANDIDATE_LIMIT], semantic_ready

    def _fetch_by_ids(self, con: sqlite3.Connection, found: dict[tuple[str, str], Candidate], wanted: dict[str, list[str]],
                      scope_type: str, scope_id: str, cross_chat_enabled: bool,
                      exclude_conversation_id: str | None, now: str) -> None:
        for kind, ids in wanted.items():
            placeholders = ",".join("?" for _ in ids)
            if kind == "explicit":
                rows = con.execute(
                    f"SELECT * FROM memory_items WHERE id IN ({placeholders}) AND scope_type = ? AND scope_id = ? AND "
                    + ACTIVE_ITEM.format(p=""), (*ids, scope_type, scope_id, now)).fetchall()
                builder = explicit_candidate
            elif not cross_chat_enabled:
                continue
            elif kind == "episode":
                rows = con.execute(
                    f"SELECT * FROM memory_episodes WHERE id IN ({placeholders}) AND scope_type = ? AND scope_id = ? "
                    "AND (? IS NULL OR conversation_id != ?)",
                    (*ids, scope_type, scope_id, exclude_conversation_id, exclude_conversation_id)).fetchall()
                builder = episode_candidate
            else:
                rows = con.execute(
                    f"SELECT c.* FROM memory_capsules c WHERE id IN ({placeholders}) AND scope_type = ? AND scope_id = ? "
                    "AND NOT EXISTS (SELECT 1 FROM memory_episodes e, json_each(c.children_json) child "
                    "WHERE e.id = child.value AND e.conversation_id = ?)",
                    (*ids, scope_type, scope_id, exclude_conversation_id)).fetchall()
                builder = capsule_candidate
            for row in rows:
                found.setdefault((kind, row["id"]), builder(row))

    @staticmethod
    def _term_weights(con: sqlite3.Connection, terms: list[str]) -> dict[str, float]:
        if not terms:
            return {}
        documents = 0
        frequency: Counter[str] = Counter()
        placeholders = ",".join("?" for _ in terms)
        for table in ("memory_items_fts", "memory_episodes_fts", "memory_capsules_fts"):
            documents += int(con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for row in con.execute(f"SELECT term, doc FROM {table}_vocab WHERE term IN ({placeholders})", terms):
                frequency[row["term"]] += int(row["doc"])
        return {term: idf(frequency.get(term, 0), documents) for term in terms}

    def _bounded_context(
        self,
        candidates: list[Candidate],
        scope_type: str,
        scope_id: str,
        revision: str,
        engine: str,
        timed_out: bool,
        cross_chat_enabled: bool,
        retrieval_reason: str,
        reranker_status: str,
    ) -> dict[str, Any]:
        explicit: list[dict[str, Any]] = []
        episodes: list[dict[str, Any]] = []
        covered_capsules: set[str] = set()
        selected_capsules: set[str] = set()
        per_conversation: Counter[str] = Counter()
        seen_texts: set[str] = set()
        profile_used = profile_count = 0
        used = 0
        for candidate in candidates:
            if candidate.kind == "capsule" and candidate.id in covered_capsules:
                continue
            if candidate.kind == "episode" and candidate.capsule_id in selected_capsules:
                continue
            if candidate.kind == "episode" and candidate.conversation_id \
                    and per_conversation[candidate.conversation_id] >= self.PER_CONVERSATION_LIMIT:
                continue
            target = explicit if candidate.kind == "explicit" else episodes
            limit = self.EXPLICIT_LIMIT if candidate.kind == "explicit" else self.EPISODE_LIMIT
            if len(target) >= limit:
                continue
            remaining = self.prompt_budget_chars - used
            if remaining < 80:
                break
            ceiling = 600
            if candidate.profile:
                if profile_count >= self.PROFILE_LIMIT or profile_used >= self.PROFILE_BUDGET_CHARS:
                    continue
                ceiling = min(ceiling, self.PROFILE_BUDGET_CHARS - profile_used)
            text = compact_text(candidate.text, min(ceiling, remaining))
            fingerprint = " ".join(words(text))[:240]
            if not text or fingerprint in seen_texts:
                continue
            seen_texts.add(fingerprint)
            item = {
                "kind": candidate.kind,
                "id": candidate.id,
                "text": text,
                "title": candidate.title,
                "createdAt": candidate.created_at,
                "score": round(1.0 if candidate.profile else candidate.score, 4),
                "reason": ("profile:rule" if candidate.meta.get("category") in ("rule", "instruction") else "profile:about")
                if candidate.profile else candidate.reason,
                "origin": {
                    **({"conversationId": candidate.conversation_id} if candidate.conversation_id else {}),
                    **({"turnId": candidate.turn_id} if candidate.turn_id else {}),
                    **({"capsuleId": candidate.capsule_id} if candidate.capsule_id else {}),
                },
            }
            target.append(item)
            if candidate.profile:
                profile_count += 1
                profile_used += len(text)
            if candidate.kind == "capsule":
                selected_capsules.add(candidate.id)
            elif candidate.kind == "episode":
                if candidate.capsule_id:
                    covered_capsules.add(candidate.capsule_id)
                if candidate.conversation_id:
                    per_conversation[candidate.conversation_id] += 1
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
            "retrievalReason": retrieval_reason,
            "rerankerStatus": reranker_status,
            "crossChatEnabled": cross_chat_enabled,
            "cache": "miss",
        }

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
            if value is None or value[0] <= time.monotonic():
                return None
            self._cache[key] = value
            return json.loads(json.dumps(value[1], ensure_ascii=False))

    def _cache_put(self, key: str, value: dict[str, Any]) -> None:
        with self._cache_lock:
            lifetime = self.CACHE_TTL_SECONDS if value.get("rerankerStatus") == "reranker-ready" else self.FALLBACK_CACHE_TTL_SECONDS
            self._cache[key] = (time.monotonic() + lifetime, json.loads(json.dumps(value, ensure_ascii=False)))
            self._cache.move_to_end(key)
            while len(self._cache) > self.CACHE_LIMIT:
                self._cache.popitem(last=False)

    def _clear_cache(self) -> None:
        with self._cache_lock:
            self._cache.clear()


def _stems(row: sqlite3.Row) -> frozenset[str]:
    try:
        value = row["search_stems"]
    except (IndexError, KeyError):
        value = ""
    return frozenset(str(value or "").split())


def explicit_candidate(row: sqlite3.Row) -> Candidate:
    return Candidate(
        kind="explicit",
        id=row["id"],
        text=row["content"],
        title=row["title"] or "Постоянная память",
        created_at=row["updated_at"],
        stems=_stems(row),
        pinned=bool(row["pinned"]),
        meta={"category": row["category"]},
    )


def episode_candidate(row: sqlite3.Row) -> Candidate:
    return Candidate(
        kind="episode",
        id=row["id"],
        text=episode_context_text(row["user_text"], row["assistant_text"]),
        title=row["title"] or "Прошлый чат",
        created_at=row["created_at"],
        stems=_stems(row),
        conversation_id=row["conversation_id"],
        turn_id=row["turn_id"],
        capsule_id=row["capsule_id"],
    )


def capsule_candidate(row: sqlite3.Row) -> Candidate:
    return Candidate(
        kind="capsule",
        id=row["id"],
        text=row["summary"],
        title=f"Тема · {row['topic']}",
        created_at=row["updated_at"],
        stems=_stems(row),
        capsule_id=row["id"],
    )


MIN_EPISODE_REQUEST_CHARS = 4


def episode_source_indexable(conversation_id: str, messages: list) -> bool:
    if conversation_id.startswith(("legacy:", "safe:", "voice:", "telegram:")):
        return False
    for message in messages:
        try:
            provenance = json.loads(message["provenance_json"] or "{}")
        except (TypeError, ValueError):
            return False
        if not isinstance(provenance, dict) or provenance.get("surface", "desktop") != "desktop" or provenance.get("privacyMode", "persistent") != "persistent":
            return False
    return True


def episode_outcome_indexable(outcome: Any, task_id: Any) -> bool:
    """Only plain answers become episodes: agent tasks, failures and blocked
    turns are not something the owner said or learned. The live path and the
    backfill of older chats apply the same rule."""
    return outcome in {"answered", "answered:source-grounded"} and not task_id


def episode_has_content(user_text: str) -> bool:
    """A request like "1" or "ок" carries nothing to recall later: it would only
    crowd real episodes out of retrieval. Counts letters and digits, so the
    rule does not depend on any language or phrase list."""
    return sum(1 for char in user_text if char.isalnum()) >= MIN_EPISODE_REQUEST_CHARS


def episode_summary(user_text: str, assistant_text: str) -> str:
    return f"Запрос: {compact_text(user_text, 700)}\nИтог: {compact_text(assistant_text, 1200)}"


def episode_context_text(user_text: str, assistant_text: str) -> str:
    return f"Пользователь: {compact_text(user_text, 480)}\nOscar: {compact_text(assistant_text, 900)}"


def capsule_topic(texts: list[str]) -> str:
    counts = Counter(word for text in texts for word in set(words(text))
                     if len(word) >= 4 and word not in STOPWORDS and word not in {"monarch", "oscar", "оскар"})
    return " · ".join(word for word, _count in counts.most_common(3)) or "история"


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
