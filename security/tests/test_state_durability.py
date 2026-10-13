from pathlib import Path
import json

import pytest

from monarch_security import state
from monarch_security.integrity import verify_payload


@pytest.fixture
def signed_store(tmp_path, monkeypatch):
    key = b"isolated-state-durability-test-key"
    monkeypatch.setattr(state, "get_or_create_key", lambda _: key)
    return state.StateStore(tmp_path / "state.json", tmp_path / "unused.key"), key


def test_published_state_and_backup_are_flushed_and_signed(signed_store, monkeypatch):
    store, key = signed_store
    events = []
    fsync, replace = state.os.fsync, state._replace
    def flush(fd):
        events.append("flush")
        return fsync(fd)
    def publish(source, target):
        assert events[-1] == "flush"
        events.append(Path(target).name)
        return replace(source, target)
    monkeypatch.setattr(state.os, "fsync", flush)
    monkeypatch.setattr(state, "_replace", publish)
    with store.lock():
        store.set_json("background_protection_v1", {"enabled": True, "requested": False})
    primary = store.path.read_bytes()
    assert primary == store.path.with_suffix(".json.backup").read_bytes()
    assert verify_payload(json.loads(primary), key, "state-store")[0]
    assert "state.json" in events and "state.json.backup" in events


@pytest.mark.parametrize("damage", [bytes(153694), b"\xff\xfe\x00", b'{"schema":'], ids=["zeroed", "bad-unicode", "truncated-json"])
def test_corruption_is_preserved_and_cannot_be_silently_resigned(signed_store, damage):
    store, _ = signed_store
    store.set_json("pending_nonces", {"consumed-later": "must-not-replay"})
    store.save()
    backup = store.path.with_suffix(".json.backup").read_bytes()
    store.path.write_bytes(damage)
    broken = state.StateStore(store.path, Path("unused.key"))
    assert broken.data.get("load_error") is True
    # Even with a signed backup, read-only access must not roll back approvals.
    with broken.lock():
        assert broken.get_json("pending_nonces", {}) == {}
    assert store.path.read_bytes() == damage
    broken.set_json("background_protection_v1", {"enabled": True})
    with pytest.raises(RuntimeError, match="recovery-required"):
        broken.save()
    assert store.path.read_bytes() == damage
    assert store.path.with_suffix(".json.backup").read_bytes() == backup


def test_flush_failure_preserves_last_good_primary_and_backup(signed_store, monkeypatch):
    store, _ = signed_store
    store.set_json("counter", 1)
    store.save()
    previous = store.path.read_bytes()
    def unavailable(_):
        raise OSError("isolated storage flush failure")
    monkeypatch.setattr(state.os, "fsync", unavailable)
    store.set_json("counter", 2)
    with pytest.raises(OSError, match="flush failure"):
        store.save()
    assert store.path.read_bytes() == previous
    assert store.path.with_suffix(".json.backup").read_bytes() == previous
    assert not list(store.path.parent.glob("*.tmp"))


def test_direct_profile_edits_inside_lock_are_still_persisted(signed_store):
    store, _ = signed_store
    store.save()
    with store.lock():
        store.data["security_level"] = "strict"
    assert state.StateStore(store.path, Path("unused.key")).data["security_level"] == "strict"


@pytest.mark.skipif(state.os.name != "nt", reason="Windows sharing semantics")
def test_pause_is_published_while_a_reader_holds_the_state_open(signed_store):
    store, key = signed_store
    with store.lock():
        store.set_json("background_protection_v1", {"enabled": True, "requested": True})
    kernel32 = state._kernel32()
    handle = state._open_handle(kernel32, store.path, 0x80000000)
    try:
        with store.lock():
            store.set_json("background_protection_v1", {"enabled": True, "requested": False})
    finally:
        kernel32.CloseHandle(handle)
    published = json.loads(state.read_shared_text(store.path))
    assert published["background_protection_v1"]["requested"] is False
    assert verify_payload(published, key, "state-store")[0]


@pytest.mark.skipif(state.os.name != "nt", reason="Windows sharing semantics")
def test_replace_reports_a_persistent_foreign_hold(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "_REPLACE_RETRY_SECONDS", 0.05)
    monkeypatch.setattr(state, "_posix_replace", lambda *_: (_ for _ in ()).throw(PermissionError(5, "held")))
    source = tmp_path / "next"
    source.write_text("x", encoding="utf-8")
    with pytest.raises(PermissionError):
        state._replace(source, tmp_path / "state.json")
