from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import os
import time
import contextlib

from .events import utc_now
from .integrity import INTEGRITY_FIELD, get_or_create_key, sign_payload, verify_payload


class FileLock:
    def __init__(self, path: Path, timeout: float = 5.0, stale_after: float = 30.0):
        self.lock_dir = path.with_suffix(path.suffix + ".lock")
        self.owner_path = self.lock_dir / "owner.json"
        self.timeout = timeout
        self.stale_after = max(2.0, stale_after)

    def __enter__(self):
        start = time.time()
        while True:
            try:
                self.lock_dir.mkdir()
                self.owner_path.write_text(
                    json.dumps({"pid": os.getpid(), "created_at": time.time()}),
                    encoding="utf-8",
                )
                return self
            except FileExistsError:
                if self._recover_orphaned_lock():
                    continue
                if time.time() - start > self.timeout:
                    raise TimeoutError(f"Could not acquire lock {self.lock_dir} within {self.timeout}s")
                time.sleep(0.05)
                
    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            self.owner_path.unlink(missing_ok=True)
            self.lock_dir.rmdir()
        except OSError:
            pass

    def _recover_orphaned_lock(self) -> bool:
        """Remove only locks whose owner is gone, including legacy empty lock dirs."""
        try:
            age = max(0.0, time.time() - self.lock_dir.stat().st_mtime)
        except OSError:
            return False
        if age < 1.0:
            return False

        owner_pid: int | None = None
        try:
            owner = json.loads(self.owner_path.read_text(encoding="utf-8"))
            value = owner.get("pid") if isinstance(owner, dict) else None
            owner_pid = int(value) if value is not None else None
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            owner_pid = None

        if owner_pid is not None and _pid_is_running(owner_pid):
            return False
        if owner_pid is None and age < self.stale_after:
            return False

        try:
            self.owner_path.unlink(missing_ok=True)
            self.lock_dir.rmdir()
            return True
        except OSError:
            return False


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes

            process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if not process:
                return False
            try:
                exit_code = ctypes.c_ulong()
                return bool(ctypes.windll.kernel32.GetExitCodeProcess(process, ctypes.byref(exit_code))) \
                    and exit_code.value == 259
            finally:
                ctypes.windll.kernel32.CloseHandle(process)
        except (AttributeError, OSError):
            return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


class StateStore:
    def __init__(self, path: Path, integrity_key_path: Path | None = None) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._integrity_key = (
            get_or_create_key(integrity_key_path) if integrity_key_path is not None else None
        )
        existed = self.path.exists()
        self.data = self._load()
        self._dirty = not existed or "load_error" in self.data or "integrity_error" in self.data

    @contextlib.contextmanager
    def lock(self):
        """Acquires a cross-process lock, reloads fresh state, and auto-saves on exit."""
        with FileLock(self.path):
            existed = self.path.exists()
            self.data = self._load()
            self._dirty = not existed or "load_error" in self.data or "integrity_error" in self.data
            yield
            self.save()


    def get_list(self, key: str) -> list[str]:
        value = self.data.get(key, [])
        if not isinstance(value, list):
            return []
        return [str(item) for item in value]

    def set_list(self, key: str, values: list[str] | set[str]) -> None:
        normalized = sorted(str(value) for value in values)
        if self.data.get(key) == normalized:
            return
        self.data[key] = normalized
        self.data["updated_at"] = utc_now()
        self._dirty = True

    def get_dict(self, key: str) -> dict[str, str]:
        value = self.data.get(key, {})
        if not isinstance(value, dict):
            return {}
        return {str(item_key): str(item_value) for item_key, item_value in value.items()}

    def set_dict(self, key: str, values: dict[str, str]) -> None:
        normalized = {str(item_key): str(item_value) for item_key, item_value in values.items()}
        if self.data.get(key) == normalized:
            return
        self.data[key] = normalized
        self.data["updated_at"] = utc_now()
        self._dirty = True

    @property
    def dirty(self) -> bool:
        return self._dirty

    def save_if_dirty(self) -> bool:
        if not self._dirty:
            return False
        self.save()
        return True

    def save(self) -> None:
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        data = dict(self.data)
        data.pop("integrity_error", None)
        if self._integrity_key is not None:
            data[INTEGRITY_FIELD] = sign_payload(data, self._integrity_key, "state-store")
        payload = json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True)
        temporary.write_text(payload + "\n", encoding="utf-8")
        temporary.replace(self.path)
        self.data = data
        self._dirty = False

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._fresh_state()
        try:
            parsed = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return self._fresh_state(load_error=True)
        if not isinstance(parsed, dict):
            return self._fresh_state()
        if self._integrity_key is not None and INTEGRITY_FIELD in parsed:
            ok, reason = verify_payload(parsed, self._integrity_key, "state-store")
            if not ok:
                return self._fresh_state(integrity_error=reason)
        elif self._integrity_key is not None and self.path.exists():
            return self._fresh_state(integrity_error="missing integrity metadata")
        return parsed

    def _fresh_state(self, **extra: Any) -> dict[str, Any]:
        return {"created_at": utc_now(), "schema": 1, **extra}
