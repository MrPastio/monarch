import importlib
import os
import secrets
import sqlite3

import pytest

from oscar_agent import secure_db

CANARY = b"CANARY-OSCAR-DB-9b2e"


def reload_with(monkeypatch, mode=None, key=None):
    for name in ("OSCAR_STORE_PROTECTION", "OSCAR_DB_KEY"):
        monkeypatch.delenv(name, raising=False)
    if mode:
        monkeypatch.setenv("OSCAR_STORE_PROTECTION", mode)
    if key:
        monkeypatch.setenv("OSCAR_DB_KEY", key)
    return importlib.reload(secure_db)


@pytest.fixture(autouse=True)
def restore_plain_mode(monkeypatch):
    yield
    for name in ("OSCAR_STORE_PROTECTION", "OSCAR_DB_KEY"):
        os.environ.pop(name, None)
    importlib.reload(secure_db)


def plain_database(path):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)")
    con.execute("CREATE VIRTUAL TABLE notes_fts USING fts5(body)")
    con.execute("INSERT INTO notes(body) VALUES (?)", (CANARY.decode() + " привет мир",))
    con.execute("INSERT INTO notes_fts(body) VALUES (?)", (CANARY.decode() + " привет мир",))
    con.commit()
    con.close()


def test_sealed_mode_encrypts_a_plain_database_and_keeps_fts(monkeypatch, tmp_path):
    db = tmp_path / "oscar_memory.sqlite3"
    plain_database(db)
    module = reload_with(monkeypatch, "sealed", secrets.token_hex(32))
    assert "OSCAR_DB_KEY" not in os.environ
    assert module.prepare(db) == db
    raw = db.read_bytes()
    assert not raw.startswith(module.SQLITE_HEADER) and CANARY not in raw
    assert not (tmp_path / "oscar_memory.sqlite3.protecting").exists()
    con = module.connect(db)
    try:
        assert con.execute("SELECT count(*) FROM notes").fetchone()[0] == 1
        assert con.execute("SELECT body FROM notes_fts WHERE notes_fts MATCH 'мир'").fetchone()["body"].startswith(CANARY.decode())
    finally:
        con.close()
    with pytest.raises(sqlite3.DatabaseError):
        sqlite3.connect(db).execute("SELECT count(*) FROM notes").fetchall()


def test_session_mode_leaves_the_ordinary_database_untouched_and_unreadable_later(monkeypatch, tmp_path):
    db = tmp_path / "oscar_memory.sqlite3"
    plain_database(db)
    before = db.read_bytes()
    module = reload_with(monkeypatch, "sealed")  # no key: session only
    assert module.protection_mode() == "session"
    session = module.prepare(db)
    assert session != db and db.read_bytes() == before
    con = module.connect(session)
    con.execute("CREATE TABLE t(body TEXT)")
    con.execute("INSERT INTO t VALUES ('session secret')")
    con.commit()
    con.close()
    assert b"session secret" not in session.read_bytes()
    # A new process gets a new key: the old session database is removed.
    module = reload_with(monkeypatch, "session")
    assert not module.prepare(db).exists()


def test_plain_level_exports_an_encrypted_database_back_while_the_key_exists(monkeypatch, tmp_path):
    db = tmp_path / "oscar_memory.sqlite3"
    plain_database(db)
    key = secrets.token_hex(32)
    reload_with(monkeypatch, "sealed", key).prepare(db)
    module = reload_with(monkeypatch, "plain", key)
    module.prepare(db)
    assert db.read_bytes().startswith(module.SQLITE_HEADER)
    assert sqlite3.connect(db).execute("SELECT count(*) FROM notes").fetchone()[0] == 1


def test_an_encrypted_database_without_its_key_stops_instead_of_starting_empty(monkeypatch, tmp_path):
    db = tmp_path / "oscar_memory.sqlite3"
    plain_database(db)
    reload_with(monkeypatch, "sealed", secrets.token_hex(32)).prepare(db)
    module = reload_with(monkeypatch, "plain")
    with pytest.raises(module.SecureDatabaseError):
        module.prepare(db)
    assert db.exists()
