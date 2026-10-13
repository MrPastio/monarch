"""Oscar's SQLite database under Monarch Security storage protection.

The runtime starts Oscar with OSCAR_STORE_PROTECTION and, when Desktop holds a
profile data key, OSCAR_DB_KEY (a key derived for this database only). Both are
read once at import; the key is removed from the environment so nothing Oscar
starts inherits it.

  sealed   SQLCipher 4 encrypts every page; FTS5 keeps working. A plain
           database from an earlier version is exported into an encrypted one,
           checked, and swapped in; the plain file is gone afterwards.
  session  no OS encryption (owner decision 2026-10-12): history lives in a
           separate database encrypted with a key that exists only in this
           process, so nothing written is readable after Oscar stops. The
           ordinary database is left untouched.
  plain    the person turned encryption off (an encrypted database is exported
           back to plain while the key exists), or Oscar runs without Monarch.
"""
from __future__ import annotations

import os
import secrets
import sqlite3
from pathlib import Path
from typing import Any

try:  # Packaged with Oscar; plain mode keeps working without it.
    from sqlcipher3 import dbapi2 as _cipher
except ImportError:  # pragma: no cover - exercised only on a broken install
    _cipher = None

SQLITE_HEADER = b"SQLite format 3\x00"


def _read_environment() -> tuple[str, str | None]:
    mode = os.environ.get("OSCAR_STORE_PROTECTION", "").strip()
    raw = os.environ.pop("OSCAR_DB_KEY", "").strip().lower()
    key = raw if len(raw) == 64 and all(char in "0123456789abcdef" for char in raw) else None
    if mode == "sealed" and key:
        return "sealed", key
    if mode in ("sealed", "session"):
        return "session", secrets.token_hex(32)
    return "plain", key


MODE, _KEY = _read_environment()


class SecureDatabaseError(RuntimeError):
    """The database could not be opened or moved under the requested protection."""


def protection_mode() -> str:
    return MODE


def _active_key() -> str | None:
    return _KEY if MODE in ("sealed", "session") else None


def _keyed_connect(path: Path | str, key: str, timeout: float) -> Any:
    if _cipher is None:
        raise SecureDatabaseError("sqlcipher-unavailable")
    con = _cipher.connect(str(path), timeout=timeout)
    con.execute(f"PRAGMA key = \"x'{key}'\"")
    return con


def connect(path: Path | str, *, timeout: float = 5.0) -> Any:
    """A connection with rows as mappings, under the current protection."""
    key = _active_key()
    if key:
        con = _keyed_connect(path, key, timeout)
        con.row_factory = _cipher.Row
    else:
        con = sqlite3.connect(str(path), timeout=timeout)
        con.row_factory = sqlite3.Row
    return con


def _is_plain_sqlite(path: Path) -> bool:
    try:
        with open(path, "rb") as handle:
            return handle.read(len(SQLITE_HEADER)) == SQLITE_HEADER
    except OSError:
        return False


def _remove_sidecars(path: Path) -> None:
    for suffix in ("-wal", "-shm", "-journal"):
        try:
            os.remove(str(path) + suffix)
        except FileNotFoundError:
            pass


def _table_counts(con: Any) -> dict[str, int]:
    names = [row[0] for row in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return {name: con.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] for name in names}


def _export(source: Path, source_key: str | None, target_key: str | None) -> None:
    """Copies `source` into a sibling with the target protection, verifies it
    and replaces `source` with it. The source stays untouched on any failure."""
    if _cipher is None:
        raise SecureDatabaseError("sqlcipher-unavailable")
    temporary = source.with_name(source.name + ".protecting")
    for leftover in (temporary, Path(str(temporary) + "-journal")):
        leftover.unlink(missing_ok=True)
    con = _cipher.connect(str(source))
    try:
        if source_key:  # a plain database is opened without any key pragma
            con.execute(f"PRAGMA key = \"x'{source_key}'\"")
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        expected = _table_counts(con)
        target_clause = f"KEY \"x'{target_key}'\"" if target_key else "KEY ''"
        con.execute(f"ATTACH DATABASE ? AS protected {target_clause}", (str(temporary),))
        con.execute("SELECT sqlcipher_export('protected')")
        con.execute("DETACH DATABASE protected")
    finally:
        con.close()
    check = _cipher.connect(str(temporary))
    try:
        if target_key:
            check.execute(f"PRAGMA key = \"x'{target_key}'\"")
        if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or _table_counts(check) != expected:
            raise SecureDatabaseError("export-verification-failed")
    finally:
        check.close()
    _remove_sidecars(source)
    os.replace(temporary, source)


def prepare(db_path: Path) -> Path:
    """Run before any store opens the database. Returns the path to use."""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if MODE == "session":
        session_path = db_path.with_name(db_path.stem + ".session" + db_path.suffix)
        for leftover in (session_path, *(Path(str(session_path) + s) for s in ("-wal", "-shm", "-journal"))):
            leftover.unlink(missing_ok=True)
        return session_path
    if not db_path.exists() or db_path.stat().st_size == 0:
        return db_path
    plain = _is_plain_sqlite(db_path)
    if MODE == "sealed" and plain:
        _export(db_path, None, _KEY)
    elif MODE == "plain" and not plain and _KEY:
        # The person turned encryption off: back to plain while the key exists.
        _export(db_path, _KEY, None)
    elif MODE == "plain" and not plain:
        raise SecureDatabaseError("database-sealed-without-key")
    return db_path
