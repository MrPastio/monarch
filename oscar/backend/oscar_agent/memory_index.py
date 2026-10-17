"""Transactional, versioned search projection for Memory 4.1.

The existing Oscar database remains the authority. FTS is derived state; all
writers (including ContextSettingsStore) maintain it with SQLite triggers in
the same transaction. Ordinary startup never copies the corpus again.

Version 2 adds a `stems` column (Snowball stems written by Python into the
source row's `search_stems`) so inflected words match, and fts5vocab tables
whose document counts give real inverse document frequencies.
"""
from __future__ import annotations

import re
import sqlite3


INDEX_VERSION = 2

# Columns every memory table gets, idempotently, whichever store opens first.
ROW_COLUMNS = {
    "memory_items": {
        "search_stems": "TEXT NOT NULL DEFAULT ''",
        "stems_version": "INTEGER NOT NULL DEFAULT 0",
        # owner: said by the person; learned: picked up from what they said;
        # suggested: waiting for the person's yes (never used in answers).
        "origin": "TEXT NOT NULL DEFAULT 'owner'",
        # superseded: replaced by a newer record about the same subject.
        "status": "TEXT NOT NULL DEFAULT 'active'",
        "subject_key": "TEXT",
        "supersedes_id": "TEXT",
        "norm_key": "TEXT NOT NULL DEFAULT ''",
    },
    "memory_episodes": {
        "search_stems": "TEXT NOT NULL DEFAULT ''",
        "stems_version": "INTEGER NOT NULL DEFAULT 0",
    },
    "memory_capsules": {
        "search_stems": "TEXT NOT NULL DEFAULT ''",
        "stems_version": "INTEGER NOT NULL DEFAULT 0",
    },
}

# table, FTS id column, source columns, FTS columns, eligibility, eligibility columns
PROJECTIONS = (
    ("memory_items", "item_id", ("title", "content", "tags_json", "search_stems"), ("title", "text", "tags", "stems"),
     "deleted_at IS NULL AND enabled = 1 AND status = 'active'", ("deleted_at", "enabled", "status")),
    ("memory_episodes", "episode_id", ("title", "search_text", "search_stems"), ("title", "text", "stems"),
     "state IN ('hot', 'compacted')", ("state",)),
    ("memory_capsules", "capsule_id", ("topic", "summary", "search_stems"), ("topic", "text", "stems"), "1", ()),
)


def ensure_row_columns(con: sqlite3.Connection) -> None:
    tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    for table, additions in ROW_COLUMNS.items():
        if table not in tables:
            continue
        present = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
        for column, definition in additions.items():
            if column not in present:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _qualified(expression: str, fields: tuple[str, ...]) -> str:
    # Eligibility expressions are internal constants, never user SQL.
    for field in fields:
        expression = re.sub(rf"\b{field}\b", "new." + field, expression)
    return expression


def initialize_index(con: sqlite3.Connection, *, rebuild: bool = False) -> None:
    """Caller holds BEGIN IMMEDIATE; migration and marker commit together."""
    ensure_row_columns(con)
    con.execute("CREATE TABLE IF NOT EXISTS memory_search_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)")
    con.execute("CREATE TABLE IF NOT EXISTS memory_forget_receipts (scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, source TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(scope_type, scope_id, source, turn_id))")
    con.execute("CREATE INDEX IF NOT EXISTS memory_episodes_conversation_idx ON memory_episodes(conversation_id)")
    con.execute("CREATE INDEX IF NOT EXISTS memory_episodes_capsule_idx ON memory_episodes(capsule_id)")
    con.execute("CREATE INDEX IF NOT EXISTS memory_items_stems_idx ON memory_items(stems_version)")
    row = con.execute("SELECT version FROM memory_search_schema WHERE singleton = 1").fetchone()
    if row is not None and row[0] > INDEX_VERSION:
        raise ValueError("memory-search-schema-newer-than-runtime")
    if row is not None and row[0] == INDEX_VERSION and not rebuild:
        expected_triggers = {f"{table}_v4_{operation}" for table, *_ in PROJECTIONS for operation in ("insert", "update", "delete")}
        expected_triggers.update(("memory_index_enqueue", "memory_index_dequeue"))
        present = {entry[0] for entry in con.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")}
        if expected_triggers <= present:
            return
    # Transactional outbox: a crash between saving an answer and indexing it
    # cannot lose the work. Message IDs survive rowid reuse after history clear.
    con.execute("CREATE TABLE IF NOT EXISTS memory_index_jobs (message_id TEXT PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE)")
    con.execute("CREATE TRIGGER IF NOT EXISTS memory_index_enqueue AFTER INSERT ON conversation_messages "
                "WHEN new.role = 'assistant' AND new.turn_id IS NOT NULL BEGIN "
                "INSERT OR IGNORE INTO memory_index_jobs(message_id) VALUES(new.id); END")
    con.execute("CREATE TRIGGER IF NOT EXISTS memory_index_dequeue AFTER DELETE ON conversation_messages BEGIN "
                "DELETE FROM memory_index_jobs WHERE message_id = old.id; END")
    con.execute("INSERT OR IGNORE INTO memory_index_jobs(message_id) SELECT id FROM conversation_messages WHERE role = 'assistant' AND turn_id IS NOT NULL")
    for table, fts_id, fields, fts_fields, eligibility, eligibility_fields in PROJECTIONS:
        fts = table + "_fts"
        for operation in ("insert", "update", "delete"):
            con.execute(f"DROP TRIGGER IF EXISTS {table}_v4_{operation}")
        # The column set changed between versions; a projection is derived
        # state, so it is recreated rather than altered.
        con.execute(f"DROP TABLE IF EXISTS {fts}_vocab")
        con.execute(f"DROP TABLE IF EXISTS {fts}")
        indexed = ", ".join((f"{fts_id} UNINDEXED", "scope_type UNINDEXED", "scope_id UNINDEXED", *fts_fields))
        con.execute(f"CREATE VIRTUAL TABLE {fts} USING fts5({indexed}, tokenize='unicode61')")
        con.execute(f"CREATE VIRTUAL TABLE {fts}_vocab USING fts5vocab({fts}, 'row')")
        columns = ", ".join(("rowid", fts_id, "scope_type", "scope_id", *fts_fields))
        source = ", ".join(("rowid", "id", "scope_type", "scope_id", *fields))
        values = ", ".join("new." + field for field in ("rowid", "id", "scope_type", "scope_id", *fields))
        new_eligibility = _qualified(eligibility, eligibility_fields)
        indexed_fields = ("id", "scope_type", "scope_id", *fields, *eligibility_fields)
        changed = " OR ".join(f"new.{field} IS NOT old.{field}" for field in indexed_fields)
        con.execute(f"CREATE TRIGGER {table}_v4_insert AFTER INSERT ON {table} BEGIN "
                    f"INSERT INTO {fts}({columns}) SELECT {values} WHERE {new_eligibility}; END")
        con.execute(f"CREATE TRIGGER {table}_v4_update AFTER UPDATE ON {table} WHEN {changed} BEGIN "
                    f"DELETE FROM {fts} WHERE rowid = old.rowid; "
                    f"INSERT INTO {fts}({columns}) SELECT {values} WHERE {new_eligibility}; END")
        con.execute(f"CREATE TRIGGER {table}_v4_delete AFTER DELETE ON {table} BEGIN "
                    f"DELETE FROM {fts} WHERE rowid = old.rowid; END")
        con.execute(f"INSERT INTO {fts}({columns}) SELECT {source} FROM {table} WHERE {eligibility}")
    con.execute("INSERT INTO memory_search_schema(singleton, version) VALUES(1, ?) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version", (INDEX_VERSION,))


def remember_forgetting(con: sqlite3.Connection, selector: str, parameters: tuple) -> None:
    """Persist content-free source identities before removing derived records."""
    con.execute(
        "INSERT OR IGNORE INTO memory_forget_receipts(scope_type, scope_id, source, turn_id) "
        f"SELECT scope_type, scope_id, source, turn_id FROM memory_episodes WHERE {selector}",
        parameters,
    )
