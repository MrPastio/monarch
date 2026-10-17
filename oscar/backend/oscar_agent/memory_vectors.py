"""Stored E5 vectors for memory records.

A vector is computed once, in the background, when a record is written or
its text changes; a query then costs one embedding (~5 ms on CPU) plus a dot
product over the scope's matrix. Earlier builds embedded up to 32 candidates
on every question inside a 120 ms deadline, so on an ordinary machine the
semantic stage usually timed out and recall fell back to "any shared word".

Vectors are derived state like FTS: no foreign keys, orphans are ignored at
lookup (candidates are joined back to live rows) and removed in background.
"""
from __future__ import annotations

import hashlib
import sqlite3
import threading
from dataclasses import dataclass
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_vectors (
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    vec BLOB NOT NULL,
    PRIMARY KEY(owner_kind, owner_id)
);
CREATE INDEX IF NOT EXISTS memory_vectors_scope_idx ON memory_vectors(scope_type, scope_id);
"""

# What each kind embeds, and how to tell that its text changed.
PENDING_QUERIES = {
    "explicit": (
        "SELECT m.id, m.scope_type, m.scope_id, m.title, m.content AS body, m.content_hash AS digest "
        "FROM memory_items m LEFT JOIN memory_vectors v ON v.owner_kind = 'explicit' AND v.owner_id = m.id "
        "WHERE m.deleted_at IS NULL AND m.status = 'active' "
        "AND (v.owner_id IS NULL OR v.model_id != ? OR v.content_hash != m.content_hash) LIMIT ?"
    ),
    "episode": (
        "SELECT e.id, e.scope_type, e.scope_id, e.title, e.user_text || char(10) || e.assistant_text AS body, "
        "e.content_hash AS digest FROM memory_episodes e "
        "LEFT JOIN memory_vectors v ON v.owner_kind = 'episode' AND v.owner_id = e.id "
        "WHERE v.owner_id IS NULL OR v.model_id != ? OR v.content_hash != e.content_hash LIMIT ?"
    ),
    "capsule": (
        "SELECT c.id, c.scope_type, c.scope_id, c.topic AS title, c.summary AS body, c.updated_at AS digest "
        "FROM memory_capsules c LEFT JOIN memory_vectors v ON v.owner_kind = 'capsule' AND v.owner_id = c.id "
        "WHERE v.owner_id IS NULL OR v.model_id != ? OR v.content_hash != c.updated_at LIMIT ?"
    ),
}

ORPHANS = (
    "DELETE FROM memory_vectors WHERE "
    "(owner_kind = 'explicit' AND owner_id NOT IN (SELECT id FROM memory_items WHERE deleted_at IS NULL AND status = 'active')) "
    "OR (owner_kind = 'episode' AND owner_id NOT IN (SELECT id FROM memory_episodes)) "
    "OR (owner_kind = 'capsule' AND owner_id NOT IN (SELECT id FROM memory_capsules))"
)


def passage_text(kind: str, title: str, body: str) -> str:
    # E5 reads 256 tokens; the request and the start of the answer carry the
    # meaning of an episode, the title names the chat it came from.
    if kind == "episode":
        return f"{title}. {str(body or '')[:900]}"
    return f"{title}. {body}" if title and title not in body else str(body or "")


@dataclass(slots=True)
class ScopeMatrix:
    kinds: list[str]
    ids: list[str]
    matrix: Any  # float32 (n, dim), rows unit-normalised

    def scores(self, query: Any) -> Any:
        return self.matrix @ query


class VectorIndex:
    """Process-local cache of per-scope matrices, keyed by a generation that
    every vector write in this process bumps. Deletions elsewhere only leave
    orphans, which lookups ignore, so they need no invalidation."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._generation = 0
        self._cache: dict[tuple[str, str], tuple[int, str, ScopeMatrix]] = {}

    @property
    def generation(self) -> int:
        return self._generation

    def invalidate(self) -> None:
        with self._lock:
            self._generation += 1
            self._cache.clear()

    def matrix(self, con: sqlite3.Connection, scope_type: str, scope_id: str, model_id: str) -> ScopeMatrix | None:
        import numpy as np

        key = (scope_type, scope_id)
        with self._lock:
            cached = self._cache.get(key)
            if cached and cached[0] == self._generation and cached[1] == model_id:
                return cached[2]
            generation = self._generation
        rows = con.execute(
            "SELECT owner_kind, owner_id, vec FROM memory_vectors WHERE scope_type = ? AND scope_id = ? AND model_id = ?",
            (scope_type, scope_id, model_id),
        ).fetchall()
        if not rows:
            return None
        matrix = np.vstack([np.frombuffer(row["vec"], dtype=np.float16) for row in rows]).astype(np.float32)
        result = ScopeMatrix([row["owner_kind"] for row in rows], [row["owner_id"] for row in rows], matrix)
        with self._lock:
            if generation == self._generation:
                self._cache[key] = (generation, model_id, result)
        return result


def store_vectors(con: sqlite3.Connection, model_id: str, kind: str, rows: list, vectors: Any) -> None:
    import numpy as np

    for row, vector in zip(rows, vectors, strict=True):
        con.execute(
            "INSERT INTO memory_vectors(owner_kind, owner_id, scope_type, scope_id, model_id, content_hash, vec) "
            "VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_kind, owner_id) DO UPDATE SET "
            "scope_type = excluded.scope_type, scope_id = excluded.scope_id, model_id = excluded.model_id, "
            "content_hash = excluded.content_hash, vec = excluded.vec",
            (kind, row["id"], row["scope_type"], row["scope_id"], model_id, str(row["digest"] or ""),
             np.asarray(vector, dtype=np.float16).tobytes()),
        )


def text_digest(text: str) -> str:
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()
