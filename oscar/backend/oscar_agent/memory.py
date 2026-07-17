from __future__ import annotations

import json
import logging
import re
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .config import Settings
from .schemas import ChatSource, MemoryStats, WorkspaceToolResult


LOGGER = logging.getLogger(__name__)


STOPWORDS = {
    "что", "как", "это", "или", "для", "про", "при", "the", "and", "you", "are", "with",
    "что-то", "почему", "зачем", "привет", "hello", "thanks", "спасибо",
    "помнишь", "вспомни", "память", "запомнил", "называл", "обсуждали", "говорили",
    "remember", "recall", "memory", "previous", "earlier",
}
GENERIC_MEMORY_PATTERNS = (
    r"^\s*(привет|hello|hi|hey)\s*$",
    r"^\s*(что ты умеешь|кто ты|help|помоги)\s*\??\s*$",
)


@dataclass(slots=True)
class MemoryHit:
    chunk_id: int
    doc_id: int
    title: str
    url: str | None
    text: str
    score: float
    overlap: int = 0


class MemoryStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.db_path = Path(settings.db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        # Conversation deletion is also used when a chat is migrated into
        # Monarch Safe. SQLite must overwrite deleted cells instead of leaving
        # readable payloads in freelist pages.
        con.execute("PRAGMA secure_delete=ON")
        con.execute("PRAGMA synchronous=NORMAL")
        return con

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        con = self._connect()
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
            # WAL is persistent database metadata; setting it on every short-lived
            # read connection needlessly acquires locks and touches the journal.
            con.execute("PRAGMA journal_mode=WAL")
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    url TEXT UNIQUE,
                    title TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'web',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                    chunk_index INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                    chunk_id UNINDEXED,
                    doc_id UNINDEXED,
                    title,
                    url,
                    text,
                    tokenize='unicode61'
                );

                CREATE TABLE IF NOT EXISTS memory_items (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT 'other',
                    type TEXT NOT NULL DEFAULT 'planning_note',
                    title TEXT NOT NULL DEFAULT '',
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    source TEXT NOT NULL DEFAULT 'user',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_used_at TEXT,
                    use_count INTEGER NOT NULL DEFAULT 0,
                    priority REAL NOT NULL DEFAULT 0.55,
                    expires_at TEXT,
                    related_files_json TEXT NOT NULL DEFAULT '[]',
                    related_modules_json TEXT NOT NULL DEFAULT '[]',
                    closed_at TEXT
                );

                CREATE INDEX IF NOT EXISTS memory_items_enabled_updated_idx
                    ON memory_items(enabled, updated_at DESC);

                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS conversation_messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    token_count INTEGER,
                    elapsed_ms INTEGER,
                    model_tier TEXT,
                    attachments_json TEXT,
                    sources_json TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS conversation_messages_conversation_idx
                    ON conversation_messages(conversation_id, created_at);
                """
            )
            message_columns = {row["name"] for row in con.execute("PRAGMA table_info(conversation_messages)").fetchall()}
            if "token_count" not in message_columns:
                con.execute("ALTER TABLE conversation_messages ADD COLUMN token_count INTEGER")
            if "elapsed_ms" not in message_columns:
                con.execute("ALTER TABLE conversation_messages ADD COLUMN elapsed_ms INTEGER")
            if "model_tier" not in message_columns:
                con.execute("ALTER TABLE conversation_messages ADD COLUMN model_tier TEXT")
            if "attachments_json" not in message_columns:
                con.execute("ALTER TABLE conversation_messages ADD COLUMN attachments_json TEXT")
            if "sources_json" not in message_columns:
                con.execute("ALTER TABLE conversation_messages ADD COLUMN sources_json TEXT")
            memory_columns = {row["name"] for row in con.execute("PRAGMA table_info(memory_items)").fetchall()}
            memory_column_defs = {
                "type": "TEXT NOT NULL DEFAULT 'planning_note'",
                "title": "TEXT NOT NULL DEFAULT ''",
                "tags_json": "TEXT NOT NULL DEFAULT '[]'",
                "priority": "REAL NOT NULL DEFAULT 0.55",
                "expires_at": "TEXT",
                "related_files_json": "TEXT NOT NULL DEFAULT '[]'",
                "related_modules_json": "TEXT NOT NULL DEFAULT '[]'",
                "closed_at": "TEXT",
            }
            for column, definition in memory_column_defs.items():
                if column not in memory_columns:
                    con.execute(f"ALTER TABLE memory_items ADD COLUMN {column} {definition}")
            con.execute(
                "UPDATE memory_items SET type = CASE "
                "WHEN category = 'preference' THEN 'user_preference' "
                "WHEN category = 'project' THEN 'architecture_note' "
                "WHEN category = 'instruction' THEN 'project_decision' "
                "WHEN category = 'profile' THEN 'user_preference' "
                "ELSE type END "
                "WHERE type IS NULL OR type = '' OR type = 'planning_note'"
            )
            con.execute(
                "UPDATE memory_items SET title = substr(content, 1, 160) WHERE title IS NULL OR title = ''"
            )

    def upsert_document(self, *, url: str | None, title: str, text: str, source: str = "web") -> int:
        cleaned = normalize_text(text)
        if not cleaned:
            raise ValueError("Document text is empty")

        now = utc_now()
        chunks = chunk_text(cleaned, self.settings.chunk_chars, self.settings.chunk_overlap)

        with self._connection() as con:
            if url:
                existing = con.execute("SELECT id FROM documents WHERE url = ?", (url,)).fetchone()
            else:
                existing = None

            if existing:
                doc_id = int(existing["id"])
                con.execute(
                    "UPDATE documents SET title = ?, source = ?, updated_at = ? WHERE id = ?",
                    (title[:500], source, now, doc_id),
                )
                old_chunk_ids = [row["id"] for row in con.execute("SELECT id FROM chunks WHERE doc_id = ?", (doc_id,))]
                if old_chunk_ids:
                    con.executemany("DELETE FROM chunks_fts WHERE chunk_id = ?", [(chunk_id,) for chunk_id in old_chunk_ids])
                con.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
            else:
                cur = con.execute(
                    "INSERT INTO documents(url, title, source, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
                    (url, title[:500], source, now, now),
                )
                doc_id = int(cur.lastrowid)

            for index, chunk in enumerate(chunks):
                cur = con.execute(
                    "INSERT INTO chunks(doc_id, chunk_index, text, created_at) VALUES(?, ?, ?, ?)",
                    (doc_id, index, chunk, now),
                )
                chunk_id = int(cur.lastrowid)
                con.execute(
                    "INSERT INTO chunks_fts(chunk_id, doc_id, title, url, text) VALUES(?, ?, ?, ?, ?)",
                    (chunk_id, doc_id, title[:500], url or "", chunk),
                )

        return doc_id

    def search(self, query: str, limit: int = 6, exclude_sources: list[str] | None = None) -> list[MemoryHit]:
        fts_query = make_fts_query(query)
        if not fts_query:
            return []

        query_terms = extract_query_terms(query)
        min_overlap = min(self.settings.memory_min_overlap, len(query_terms))
        memory_hits: list[MemoryHit] = []

        with self._connection() as con:
            if not exclude_sources or "user-note" not in exclude_sources:
                memory_rows = con.execute(
                    "SELECT id, content, category, type FROM memory_items "
                    "WHERE enabled = 1 AND closed_at IS NULL AND (expires_at IS NULL OR expires_at > ?) "
                    "ORDER BY updated_at DESC",
                    (utc_now(),),
                ).fetchall()
                ranked_memories = sorted(
                    (
                        (lexical_overlap(query_terms, row["content"]), row)
                        for row in memory_rows
                    ),
                    key=lambda item: item[0],
                    reverse=True,
                )
                used_ids: list[str] = []
                for overlap, row in ranked_memories:
                    if not memory_item_matches(query_terms, row["content"], overlap, min_overlap):
                        continue
                    used_ids.append(row["id"])
                    memory_hits.append(MemoryHit(
                        chunk_id=-len(memory_hits) - 1,
                        doc_id=-len(memory_hits) - 1,
                        title=f"Память · {row['type'] or row['category']}",
                        url=f"memory://{row['id']}",
                        text=row["content"],
                        score=float(-overlap),
                        overlap=overlap,
                    ))
                    if len(memory_hits) >= limit:
                        break
                if used_ids:
                    now = utc_now()
                    con.executemany(
                        "UPDATE memory_items SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?",
                        [(now, item_id) for item_id in used_ids],
                    )

            if exclude_sources:
                placeholders = ",".join("?" * len(exclude_sources))
                query_sql = f"""
                    SELECT f.chunk_id, f.doc_id, f.title, f.url, f.text, bm25(chunks_fts) AS score
                    FROM chunks_fts f
                    JOIN documents d ON f.doc_id = d.id
                    WHERE chunks_fts MATCH ? AND d.source NOT IN ({placeholders})
                    ORDER BY score
                    LIMIT ?
                """
                params = [fts_query] + exclude_sources + [limit]
            else:
                query_sql = """
                    SELECT chunk_id, doc_id, title, url, text, bm25(chunks_fts) AS score
                    FROM chunks_fts
                    WHERE chunks_fts MATCH ?
                    ORDER BY score
                    LIMIT ?
                """
                params = [fts_query, limit]
                
            rows = con.execute(query_sql, params).fetchall()

        hits = [
            MemoryHit(
                chunk_id=int(row["chunk_id"]),
                doc_id=int(row["doc_id"]),
                title=row["title"] or "Untitled",
                url=row["url"] or None,
                text=row["text"],
                score=float(row["score"]),
                overlap=lexical_overlap(query_terms, row["text"]),
            )
            for row in rows
        ]
        document_hits = [hit for hit in hits if hit.overlap >= min_overlap]
        return (memory_hits + document_hits)[:limit]

    def search_urls(self, query: str, urls: list[str], limit: int = 6) -> list[MemoryHit]:
        ordered_urls = list(dict.fromkeys(url for url in urls if url))
        if not ordered_urls or limit <= 0:
            return []
        placeholders = ",".join("?" * len(ordered_urls))
        with self._connection() as con:
            rows = con.execute(
                f"""
                SELECT c.id AS chunk_id, c.doc_id, c.chunk_index, c.text, d.title, d.url
                FROM chunks c
                JOIN documents d ON d.id = c.doc_id
                WHERE d.url IN ({placeholders})
                """,
                ordered_urls,
            ).fetchall()

        query_terms = extract_query_terms(query)
        url_order = {url: index for index, url in enumerate(ordered_urls)}
        ranked = sorted(
            rows,
            key=lambda row: (
                url_order.get(row["url"], len(url_order)),
                -lexical_overlap(query_terms, row["text"]),
                int(row["chunk_index"]),
            ),
        )
        selected: list[sqlite3.Row] = []
        per_url: dict[str, int] = {}
        for row in ranked:
            url = row["url"] or ""
            # One best matching excerpt per result keeps citations diverse and
            # prevents duplicate source chips for multi-chunk pages.
            if per_url.get(url, 0) >= 1:
                continue
            selected.append(row)
            per_url[url] = per_url.get(url, 0) + 1
            if len(selected) >= limit:
                break

        return [
            MemoryHit(
                chunk_id=int(row["chunk_id"]),
                doc_id=int(row["doc_id"]),
                title=row["title"] or "Untitled",
                url=row["url"] or None,
                text=row["text"],
                score=float(-lexical_overlap(query_terms, row["text"])),
                overlap=lexical_overlap(query_terms, row["text"]),
            )
            for row in selected
        ]

    def stats(self) -> MemoryStats:
        with self._connection() as con:
            documents = int(con.execute("SELECT COUNT(*) AS n FROM documents").fetchone()["n"])
            chunks = int(con.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"])
            memories = int(con.execute("SELECT COUNT(*) AS n FROM memory_items").fetchone()["n"])
            active_memories = int(con.execute("SELECT COUNT(*) AS n FROM memory_items WHERE enabled = 1").fetchone()["n"])
            conversations = int(con.execute("SELECT COUNT(*) AS n FROM conversations WHERE archived = 0").fetchone()["n"])
            updated = con.execute(
                "SELECT MAX(ts) AS ts FROM (SELECT MAX(updated_at) AS ts FROM documents UNION ALL SELECT MAX(updated_at) FROM memory_items UNION ALL SELECT MAX(updated_at) FROM conversations)"
            ).fetchone()["ts"]

        return MemoryStats(
            documents=documents,
            chunks=chunks,
            memories=memories,
            active_memories=active_memories,
            conversations=conversations,
            updated_at=datetime.fromisoformat(updated) if updated else None,
        )

    def hits_to_sources(self, hits: list[MemoryHit]) -> list[ChatSource]:
        return [
            ChatSource(
                id=index + 1,
                title=hit.title,
                url=hit.url,
                excerpt=hit.text[:900] if hit.url else hit.text[:420],
                score=hit.score,
            )
            for index, hit in enumerate(hits)
        ]

    def remember_note(self, text: str) -> WorkspaceToolResult:
        cleaned = normalize_text(text)
        if not cleaned:
            return WorkspaceToolResult(
                ok=False,
                kind="memory",
                action="remember",
                summary="Не вижу текст, который нужно запомнить.",
                error="empty-memory-note",
            )

        self.create_memory_item(cleaned, category=infer_memory_category(cleaned))
        return WorkspaceToolResult(
            ok=True,
            kind="memory",
            action="remember",
            summary="Запомнил заметку в локальной памяти.",
            bytes=len(cleaned.encode("utf-8")),
        )

    def create_memory_item(
        self,
        content: str,
        *,
        category: str = "other",
        source: str = "user",
        type: str | None = None,
        title: str | None = None,
        tags: list[str] | None = None,
        priority: float | None = None,
        expires_at: str | None = None,
        related_files: list[str] | None = None,
        related_modules: list[str] | None = None,
    ) -> dict:
        cleaned = normalize_text(content)
        if not cleaned:
            raise ValueError("Memory content is empty")
        now = utc_now()
        entry_type = normalize_memory_type(type or category, cleaned)
        legacy_category = normalize_memory_category(category, entry_type)
        title = normalize_memory_title(title or cleaned)
        tags_json = encode_json_string_list(tags)
        priority_value = normalize_priority(priority, entry_type)
        expires_at = normalize_optional_timestamp(expires_at)
        related_files_json = encode_json_string_list(related_files)
        related_modules_json = encode_json_string_list(related_modules)
        with self._connection() as con:
            existing = con.execute(
                "SELECT id FROM memory_items WHERE lower(content) = lower(?) LIMIT 1",
                (cleaned,),
            ).fetchone()
            if existing:
                item_id = existing["id"]
                con.execute(
                    "UPDATE memory_items SET category = ?, type = ?, title = ?, tags_json = ?, enabled = 1, source = ?, "
                    "updated_at = ?, priority = ?, expires_at = ?, related_files_json = ?, related_modules_json = ?, closed_at = NULL WHERE id = ?",
                    (
                        legacy_category,
                        entry_type,
                        title,
                        tags_json,
                        source,
                        now,
                        priority_value,
                        expires_at,
                        related_files_json,
                        related_modules_json,
                        item_id,
                    ),
                )
            else:
                item_id = uuid.uuid4().hex
                con.execute(
                    """
                    INSERT INTO memory_items(
                        id, content, category, type, title, tags_json, enabled, source,
                        created_at, updated_at, priority, expires_at, related_files_json, related_modules_json
                    ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item_id,
                        cleaned,
                        legacy_category,
                        entry_type,
                        title,
                        tags_json,
                        source,
                        now,
                        now,
                        priority_value,
                        expires_at,
                        related_files_json,
                        related_modules_json,
                    ),
                )
        return self.get_memory_item(item_id)

    def list_memory_items(self, *, include_inactive: bool = True) -> list[dict]:
        where = "" if include_inactive else "WHERE enabled = 1"
        with self._connection() as con:
            rows = con.execute(
                f"SELECT * FROM memory_items {where} ORDER BY enabled DESC, updated_at DESC"
            ).fetchall()
        return [memory_item_row(row) for row in rows]

    def get_memory_item(self, item_id: str) -> dict:
        with self._connection() as con:
            row = con.execute("SELECT * FROM memory_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise KeyError(item_id)
        return memory_item_row(row)

    def update_memory_item(
        self,
        item_id: str,
        *,
        content: str | None = None,
        category: str | None = None,
        type: str | None = None,
        title: str | None = None,
        tags: list[str] | None = None,
        priority: float | None = None,
        expires_at: str | None = None,
        related_files: list[str] | None = None,
        related_modules: list[str] | None = None,
        closed: bool | None = None,
        enabled: bool | None = None,
    ) -> dict:
        updates: list[str] = []
        values: list[object] = []
        if content is not None:
            cleaned = normalize_text(content)
            if not cleaned:
                raise ValueError("Memory content is empty")
            updates.append("content = ?")
            values.append(cleaned)
        if category is not None:
            entry_type = normalize_memory_type(type or category, content or "")
            updates.append("category = ?")
            values.append(normalize_memory_category(category, entry_type))
            updates.append("type = ?")
            values.append(entry_type)
        elif type is not None:
            entry_type = normalize_memory_type(type, content or "")
            updates.append("type = ?")
            values.append(entry_type)
            updates.append("category = ?")
            values.append(normalize_memory_category("", entry_type))
        if title is not None:
            updates.append("title = ?")
            values.append(normalize_memory_title(title or content or ""))
        if tags is not None:
            updates.append("tags_json = ?")
            values.append(encode_json_string_list(tags))
        if priority is not None:
            updates.append("priority = ?")
            values.append(normalize_priority(priority, type or category))
        if expires_at is not None:
            updates.append("expires_at = ?")
            values.append(normalize_optional_timestamp(expires_at))
        if related_files is not None:
            updates.append("related_files_json = ?")
            values.append(encode_json_string_list(related_files))
        if related_modules is not None:
            updates.append("related_modules_json = ?")
            values.append(encode_json_string_list(related_modules))
        if closed is not None:
            updates.append("closed_at = ?")
            values.append(utc_now() if closed else None)
        if enabled is not None:
            updates.append("enabled = ?")
            values.append(1 if enabled else 0)
        if updates:
            updates.append("updated_at = ?")
            values.append(utc_now())
            values.append(item_id)
            with self._connection() as con:
                cursor = con.execute(
                    f"UPDATE memory_items SET {', '.join(updates)} WHERE id = ?",
                    values,
                )
                if cursor.rowcount == 0:
                    raise KeyError(item_id)
        return self.get_memory_item(item_id)

    def delete_memory_item(self, item_id: str) -> bool:
        with self._connection() as con:
            cursor = con.execute("DELETE FROM memory_items WHERE id = ?", (item_id,))
        return cursor.rowcount > 0

    def create_conversation(self, title: str = "Новый чат", *, conversation_id: str | None = None) -> dict:
        conversation_id = conversation_id or uuid.uuid4().hex
        now = utc_now()
        cleaned_title = normalize_text(title)[:160] or "Новый чат"
        with self._connection() as con:
            con.execute(
                "INSERT OR IGNORE INTO conversations(id, title, archived, created_at, updated_at) VALUES(?, ?, 0, ?, ?)",
                (conversation_id, cleaned_title, now, now),
            )
        return self.get_conversation(conversation_id, include_messages=False)

    def list_conversations(self, *, limit: int = 60, include_archived: bool = False) -> list[dict]:
        archived_filter = "" if include_archived else "WHERE c.archived = 0"
        with self._connection() as con:
            rows = con.execute(
                f"""
                SELECT c.*,
                       COUNT(m.id) AS message_count,
                       COALESCE((SELECT content FROM conversation_messages lm WHERE lm.conversation_id = c.id ORDER BY lm.created_at DESC, lm.rowid DESC LIMIT 1), '') AS preview
                FROM conversations c
                LEFT JOIN conversation_messages m ON m.conversation_id = c.id
                {archived_filter}
                GROUP BY c.id
                ORDER BY c.updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [conversation_row(row) for row in rows]

    def get_conversation(
        self,
        conversation_id: str,
        *,
        include_messages: bool = True,
        message_limit: int | None = None,
        before_rowid: int | None = None,
    ) -> dict:
        with self._connection() as con:
            row = con.execute(
                """
                SELECT c.*, COUNT(m.id) AS message_count,
                       COALESCE((SELECT content FROM conversation_messages lm WHERE lm.conversation_id = c.id ORDER BY lm.created_at DESC, lm.rowid DESC LIMIT 1), '') AS preview
                FROM conversations c
                LEFT JOIN conversation_messages m ON m.conversation_id = c.id
                WHERE c.id = ?
                GROUP BY c.id
                """,
                (conversation_id,),
            ).fetchone()
            if not row:
                raise KeyError(conversation_id)
            result = conversation_row(row)
            if include_messages:
                if message_limit is None:
                    messages = con.execute(
                        "SELECT id, role, content, token_count, elapsed_ms, model_tier, attachments_json, sources_json, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
                        (conversation_id,),
                    ).fetchall()
                    result["messages"] = [conversation_message_row(message) for message in messages]
                else:
                    page_limit = max(1, min(int(message_limit), 200))
                    cursor = max(1, int(before_rowid)) if before_rowid is not None else None
                    cursor_filter = "AND rowid < ?" if cursor is not None else ""
                    parameters: tuple = (
                        (conversation_id, cursor, page_limit + 1)
                        if cursor is not None
                        else (conversation_id, page_limit + 1)
                    )
                    descending_rows = con.execute(
                        f"""
                        SELECT rowid AS _message_cursor, id, role, content, token_count, elapsed_ms,
                               model_tier, attachments_json, sources_json, created_at
                        FROM conversation_messages
                        WHERE conversation_id = ? {cursor_filter}
                        ORDER BY created_at DESC, rowid DESC
                        LIMIT ?
                        """,
                        parameters,
                    ).fetchall()
                    has_more = len(descending_rows) > page_limit
                    page_rows = descending_rows[:page_limit]
                    messages = []
                    for message in reversed(page_rows):
                        payload = conversation_message_row(message)
                        payload.pop("_message_cursor", None)
                        messages.append(payload)
                    result["messages"] = messages
                    result["message_page"] = {
                        "limit": page_limit,
                        "returned": len(messages),
                        "has_more": has_more,
                        "next_before": int(page_rows[-1]["_message_cursor"]) if has_more and page_rows else None,
                    }
        return result

    def get_conversation_context_window(
        self,
        conversation_id: str,
        *,
        head_limit: int,
        tail_limit: int,
    ) -> dict:
        head_limit = max(1, min(int(head_limit), 32))
        tail_limit = max(1, min(int(tail_limit), 256))
        message_filter = "conversation_id = ? AND role IN ('user', 'assistant') AND length(trim(content)) > 0"
        with self._connection() as con:
            row = con.execute(
                f"""
                SELECT c.id,
                       (SELECT COUNT(*) FROM conversation_messages WHERE {message_filter}) AS message_count
                FROM conversations c
                WHERE c.id = ?
                """,
                (conversation_id, conversation_id),
            ).fetchone()
            if not row:
                raise KeyError(conversation_id)
            head_rows = con.execute(
                f"""
                SELECT role, content
                FROM conversation_messages
                WHERE {message_filter}
                ORDER BY created_at, rowid
                LIMIT ?
                """,
                (conversation_id, head_limit),
            ).fetchall()
            tail_rows = con.execute(
                f"""
                SELECT role, content
                FROM conversation_messages
                WHERE {message_filter}
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
                """,
                (conversation_id, tail_limit),
            ).fetchall()
        return {
            "message_count": int(row["message_count"] or 0),
            "head_messages": [conversation_context_message_row(message) for message in head_rows],
            "tail_messages": [conversation_context_message_row(message) for message in reversed(tail_rows)],
        }

    def update_conversation(
        self,
        conversation_id: str,
        *,
        title: str | None = None,
        archived: bool | None = None,
    ) -> dict:
        updates: list[str] = []
        values: list[object] = []
        if title is not None:
            updates.append("title = ?")
            values.append(normalize_text(title)[:160] or "Новый чат")
        if archived is not None:
            updates.append("archived = ?")
            values.append(1 if archived else 0)
        if updates:
            updates.append("updated_at = ?")
            values.append(utc_now())
            values.append(conversation_id)
            with self._connection() as con:
                cursor = con.execute(
                    f"UPDATE conversations SET {', '.join(updates)} WHERE id = ?",
                    values,
                )
                if cursor.rowcount == 0:
                    raise KeyError(conversation_id)
        return self.get_conversation(conversation_id, include_messages=False)

    def delete_conversation(self, conversation_id: str) -> bool:
        # Refuse the migration before deleting anything if an existing reader
        # prevents us from clearing older plaintext WAL frames.
        self._checkpoint_conversation_wal(require_idle=True)
        with self._connection() as con:
            cursor = con.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
            deleted = cursor.rowcount > 0
        if deleted:
            # Flush the secure-delete frames and truncate the WAL so the old
            # plaintext generation is not left in a readable sidecar. Once the
            # delete is committed, never report it as failed: the caller has an
            # already verified Safe copy and must not roll that copy back.
            try:
                if not self._checkpoint_conversation_wal(require_idle=False):
                    LOGGER.warning("SQLite WAL remained busy after secure conversation deletion")
            except Exception:
                LOGGER.exception("SQLite WAL truncation failed after secure conversation deletion")
        return deleted

    def _checkpoint_conversation_wal(self, *, require_idle: bool) -> bool:
        checkpoint = self._connect()
        try:
            busy, _, _ = checkpoint.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        finally:
            checkpoint.close()
        if busy and require_idle:
            raise RuntimeError("SQLite WAL is busy; conversation was not deleted")
        return not bool(busy)

    def append_conversation_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        *,
        token_count: int | None = None,
        elapsed_ms: int | None = None,
        model_tier: str | None = None,
        attachments: list | None = None,
        sources: list | None = None,
    ) -> dict | None:
        cleaned = str(content or "").strip()
        if not cleaned:
            return None
        self.create_conversation(conversation_id=conversation_id)
        now = utc_now()
        attachments_json = serialize_conversation_attachments(attachments or [])
        sources_json = serialize_conversation_sources(sources or [])
        with self._connection() as con:
            last = con.execute(
                "SELECT role, content, attachments_json FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (conversation_id,),
            ).fetchone()
            if (
                last
                and last["role"] == role
                and last["content"] == cleaned
                and (last["attachments_json"] or "") == (attachments_json or "")
            ):
                return None
            message_id = uuid.uuid4().hex
            con.execute(
                "INSERT INTO conversation_messages(id, conversation_id, role, content, token_count, elapsed_ms, model_tier, attachments_json, sources_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (message_id, conversation_id, role, cleaned, token_count, elapsed_ms, model_tier, attachments_json, sources_json, now),
            )
            if role == "user":
                title_row = con.execute("SELECT title FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
                if title_row and title_row["title"] == "Новый чат":
                    title = re.sub(r"\s+", " ", cleaned).strip()[:56]
                    con.execute("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", (title, now, conversation_id))
                else:
                    con.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
            else:
                con.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": cleaned,
            "token_count": token_count,
            "elapsed_ms": elapsed_ms,
            "model_tier": model_tier,
            "attachments": deserialize_conversation_attachments(attachments_json),
            "sources": deserialize_conversation_sources(sources_json),
            "created_at": now,
        }

    def edit_user_message(self, conversation_id: str, message_id: str, content: str) -> dict:
        cleaned = str(content or "").strip()
        if not cleaned:
            raise ValueError("Message content is empty")
        now = utc_now()
        with self._connection() as con:
            message = con.execute(
                "SELECT rowid, role, content FROM conversation_messages WHERE id = ? AND conversation_id = ?",
                (message_id, conversation_id),
            ).fetchone()
            if not message or message["role"] != "user":
                raise KeyError(message_id)
            con.execute(
                "UPDATE conversation_messages SET content = ? WHERE id = ? AND conversation_id = ?",
                (cleaned, message_id, conversation_id),
            )
            con.execute(
                "DELETE FROM conversation_messages WHERE conversation_id = ? AND rowid > ?",
                (conversation_id, message["rowid"]),
            )
            conversation = con.execute("SELECT title FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            auto_title = re.sub(r"\s+", " ", message["content"]).strip()[:56]
            if conversation and conversation["title"] == auto_title:
                new_title = re.sub(r"\s+", " ", cleaned).strip()[:56] or "Новый чат"
                con.execute("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", (new_title, now, conversation_id))
            else:
                con.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
        return self.get_conversation(conversation_id)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "")
    return text.strip()


def chunk_text(text: str, chunk_chars: int, overlap: int) -> list[str]:
    if len(text) <= chunk_chars:
        return [text]

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + chunk_chars, len(text))
        window = text[start:end]
        if end < len(text):
            split_at = max(window.rfind(". "), window.rfind("! "), window.rfind("? "), window.rfind("; "))
            if split_at > chunk_chars * 0.55:
                end = start + split_at + 1
                window = text[start:end]
        chunks.append(window.strip())
        if end >= len(text):
            break
        next_start = max(0, end - overlap)
        if next_start <= start:
            next_start = end
        start = next_start
    return [chunk for chunk in chunks if chunk]


def make_fts_query(query: str) -> str:
    terms = extract_query_terms(query)
    seen: list[str] = []
    for term in terms:
        if term not in seen:
            seen.append(term)
    return " OR ".join(f'"{term.replace(chr(34), chr(34) + chr(34))}"' for term in seen[:12])


def detect_memory_note(text: str) -> str | None:
    match = re.search(
        r"^\s*(?:запомни|remember|save\s+to\s+memory)\s*[:\-]?\s*(?P<note>.+)$",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None
    note = normalize_text(match.group("note"))
    return note or None


def infer_memory_category(text: str) -> str:
    lowered = normalize_text(text).lower()
    if re.search(r"(?:предпочитаю|люблю|не люблю|prefer|preference)", lowered):
        return "preference"
    if re.search(r"(?:меня зовут|я живу|я работаю|my name|i am)", lowered):
        return "profile"
    if re.search(r"(?:проект|репозитор|workspace|project)", lowered):
        return "project"
    if re.search(r"(?:всегда|никогда|отвечай|обращайся|always|never)", lowered):
        return "instruction"
    return "other"


MEMORY_ENTRY_TYPES = {
    "user_preference",
    "project_decision",
    "architecture_note",
    "active_bug",
    "fixed_bug",
    "technical_debt",
    "temporary_task",
    "module_state",
    "handoff_note",
    "diagnostic_note",
    "planning_note",
}


def normalize_memory_type(value: str | None, content: str = "") -> str:
    cleaned = normalize_text(value or "").lower()
    if cleaned in MEMORY_ENTRY_TYPES:
        return cleaned
    legacy_map = {
        "preference": "user_preference",
        "profile": "user_preference",
        "project": "architecture_note",
        "instruction": "project_decision",
        "other": "",
    }
    if cleaned in legacy_map and legacy_map[cleaned]:
        return legacy_map[cleaned]
    lowered = normalize_text(content).lower()
    if re.search(r"(?:prefer|preference|предпоч|люблю|стиль)", lowered):
        return "user_preference"
    if re.search(r"(?:decision|решени|договор)", lowered):
        return "project_decision"
    if re.search(r"(?:architecture|архитектур|contract|контракт)", lowered):
        return "architecture_note"
    if re.search(r"(?:bug|regression|ошибка|баг|регресс)", lowered):
        return "active_bug"
    if re.search(r"(?:debt|todo|техдолг|долг)", lowered):
        return "technical_debt"
    if re.search(r"(?:temporary|task|времен|задача)", lowered):
        return "temporary_task"
    if re.search(r"(?:diagnostic|диагност|health|провер)", lowered):
        return "diagnostic_note"
    return "planning_note"


def normalize_memory_category(category: str | None, entry_type: str) -> str:
    cleaned = normalize_text(category or "").lower()
    if cleaned in {"preference", "profile", "project", "instruction", "other"}:
        return cleaned
    if entry_type == "user_preference":
        return "preference"
    if entry_type in {"project_decision", "architecture_note", "module_state", "handoff_note"}:
        return "project"
    if entry_type in {"active_bug", "fixed_bug"}:
        return "other"
    if entry_type in {"technical_debt", "temporary_task", "diagnostic_note", "planning_note"}:
        return "other"
    return "other"


def normalize_memory_title(value: str) -> str:
    cleaned = normalize_text(value)
    if not cleaned:
        return "Memory entry"
    return cleaned[:160]


def normalize_priority(value: float | None, entry_type: str | None) -> float:
    if isinstance(value, (int, float)):
        return max(0.0, min(float(value), 1.0))
    defaults = {
        "user_preference": 0.75,
        "project_decision": 0.75,
        "architecture_note": 0.75,
        "active_bug": 0.7,
        "technical_debt": 0.7,
        "diagnostic_note": 0.7,
        "temporary_task": 0.45,
    }
    return defaults.get(normalize_memory_type(entry_type), 0.55)


def normalize_optional_timestamp(value: str | None) -> str | None:
    cleaned = normalize_text(value or "")
    return cleaned or None


def encode_json_string_list(values: list[str] | None) -> str:
    cleaned = []
    seen = set()
    for value in values or []:
        item = normalize_text(value)
        if not item or item in seen:
            continue
        seen.add(item)
        cleaned.append(item)
    return json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))


def decode_json_string_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def memory_item_row(row: sqlite3.Row) -> dict:
    result = dict(row)
    result["enabled"] = bool(result["enabled"])
    result["type"] = normalize_memory_type(result.get("type"), result.get("content") or "")
    result["category"] = normalize_memory_category(result.get("category"), result["type"])
    result["title"] = normalize_memory_title(result.get("title") or result.get("content") or "")
    result["tags"] = decode_json_string_list(result.pop("tags_json", None))
    result["priority"] = normalize_priority(result.get("priority"), result["type"])
    result["related_files"] = decode_json_string_list(result.pop("related_files_json", None))
    result["related_modules"] = decode_json_string_list(result.pop("related_modules_json", None))
    result["status"] = "closed" if result.get("closed_at") else "active"
    if result.get("expires_at"):
        try:
            if datetime.fromisoformat(str(result["expires_at"])) <= datetime.now(timezone.utc):
                result["status"] = "expired"
        except (TypeError, ValueError):
            pass
    return result


def serialize_conversation_attachments(attachments: list) -> str | None:
    compact: list[dict] = []
    for attachment in attachments[:3]:
        if hasattr(attachment, "model_dump"):
            value = attachment.model_dump(mode="json")
        elif isinstance(attachment, dict):
            value = attachment
        else:
            continue
        compact.append({
            "mime_type": str(value.get("mime_type") or ""),
            "data_base64": str(value.get("data_base64") or ""),
            "name": str(value.get("name") or "image")[:120],
            "size_bytes": int(value.get("size_bytes") or 0),
        })
    return json.dumps(compact, ensure_ascii=False, separators=(",", ":")) if compact else None


def deserialize_conversation_attachments(raw: str | None) -> list[dict]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def serialize_conversation_sources(sources: list) -> str | None:
    compact: list[dict] = []
    for source in sources[:12]:
        if hasattr(source, "model_dump"):
            value = source.model_dump(mode="json")
        elif isinstance(source, dict):
            value = source
        else:
            continue
        compact.append({
            "id": int(value.get("id") or len(compact) + 1),
            "title": str(value.get("title") or "Source")[:500],
            "url": str(value.get("url") or "") or None,
            "excerpt": str(value.get("excerpt") or "")[:1200],
            "score": value.get("score"),
        })
    return json.dumps(compact, ensure_ascii=False, separators=(",", ":")) if compact else None


def deserialize_conversation_sources(raw: str | None) -> list[dict]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def conversation_context_message_row(row: sqlite3.Row) -> dict:
    return {
        "role": row["role"],
        "content": row["content"],
    }


def conversation_message_row(row: sqlite3.Row) -> dict:
    result = dict(row)
    result["attachments"] = deserialize_conversation_attachments(result.pop("attachments_json", None))
    result["sources"] = deserialize_conversation_sources(result.pop("sources_json", None))
    return result


def conversation_row(row: sqlite3.Row) -> dict:
    preview = re.sub(r"\s+", " ", row["preview"] or "").strip()[:160]
    return {
        "id": row["id"],
        "title": row["title"],
        "archived": bool(row["archived"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "message_count": int(row["message_count"] or 0),
        "preview": preview,
    }


def should_use_memory(query: str) -> bool:
    lowered = normalize_text(query).lower()
    if not lowered:
        return False
    if any(re.match(pattern, lowered, flags=re.IGNORECASE) for pattern in GENERIC_MEMORY_PATTERNS):
        return False
    return len(extract_query_terms(lowered)) >= 2


def extract_query_terms(query: str) -> list[str]:
    terms = re.findall(r"[\w\d\-]{3,}", query.lower(), flags=re.UNICODE)
    return [term for term in terms if term not in STOPWORDS]


def lexical_overlap(query_terms: list[str], text: str) -> int:
    if not query_terms:
        return 0
    text_terms = set(extract_query_terms(text))
    return sum(1 for term in set(query_terms) if term in text_terms)


def memory_item_matches(query_terms: list[str], text: str, overlap: int, min_overlap: int) -> bool:
    if overlap >= min_overlap:
        return True
    if overlap != 1:
        return False
    text_terms = set(extract_query_terms(text))
    shared = set(query_terms).intersection(text_terms)
    return any(len(term) >= 6 or any(ch.isdigit() for ch in term) for term in shared)
