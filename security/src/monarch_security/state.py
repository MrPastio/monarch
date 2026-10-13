from __future__ import annotations

from pathlib import Path
from typing import Any
import copy
import json
import os
import time
import contextlib
import tempfile

from .events import utc_now
from .integrity import INTEGRITY_FIELD, get_or_create_key, read_existing_key, sign_payload, verify_payload


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
    # Unknown/access-denied is not proof of an orphaned signed-store writer.
    from .process_identity import probe_process
    return probe_process(pid).state != "dead"


class StateStore:
    def __init__(self, path: Path, integrity_key_path: Path | None = None, *, require_existing_key: bool = False) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._integrity_key = (
            (read_existing_key(integrity_key_path) if require_existing_key else get_or_create_key(integrity_key_path))
            if integrity_key_path is not None else None
        )
        existed = self.path.exists()
        self.data = self._load()
        self._dirty = not existed

    @contextlib.contextmanager
    def lock(self):
        """Acquires a cross-process lock, reloads fresh state, and auto-saves on exit."""
        with FileLock(self.path):
            existed = self.path.exists()
            self.data = self._load()
            self._dirty = not existed
            before = copy.deepcopy(self.data)
            yield
            if self.data != before:
                self._dirty = True
            self.save_if_dirty()


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

    def get_json(self, key: str, default: Any = None) -> Any:
        """Return an isolated JSON-compatible value from the signed state."""
        if key not in self.data:
            return copy.deepcopy(default)
        return copy.deepcopy(self.data[key])

    def set_json(self, key: str, value: Any) -> None:
        """Persist only strict JSON data; reject NaN and non-serializable objects."""
        serialized = json.dumps(
            value,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        normalized = json.loads(serialized)
        if self.data.get(key) == normalized:
            return
        self.data[key] = normalized
        self.data["updated_at"] = utc_now()
        self._dirty = True

    def delete(self, key: str) -> None:
        if key not in self.data:
            return
        del self.data[key]
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
        # Never turn an unreadable/untrusted store into a freshly signed reset.
        # Recovery must be explicit; this store contains trust and approvals.
        if self.data.get("load_error") or self.data.get("integrity_error"):
            raise RuntimeError("security-state-recovery-required")
        data = dict(self.data)
        data.pop("integrity_error", None)
        if self._integrity_key is not None:
            data[INTEGRITY_FIELD] = sign_payload(data, self._integrity_key, "state-store")
        payload = json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True)
        durable_replace(self.path, (payload + "\n").encode("utf-8"))
        # A separately flushed copy permits checked recovery after storage loss.
        # Never load it automatically: an older copy could restore a consumed
        # approval or undo a later pause. Both copies carry the same HMAC.
        durable_replace(self.path.with_suffix(self.path.suffix + ".backup"), (payload + "\n").encode("utf-8"))
        self.data = data
        self._dirty = False

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._fresh_state()
        try:
            parsed = json.loads(read_shared_text(self.path))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return self._fresh_state(load_error=True)
        if not isinstance(parsed, dict):
            return self._fresh_state(load_error=True)
        if self._integrity_key is not None and INTEGRITY_FIELD in parsed:
            ok, reason = verify_payload(parsed, self._integrity_key, "state-store")
            if not ok:
                return self._fresh_state(integrity_error=reason)
        elif self._integrity_key is not None and self.path.exists():
            return self._fresh_state(integrity_error="missing integrity metadata")
        return parsed

    def _fresh_state(self, **extra: Any) -> dict[str, Any]:
        return {"created_at": utc_now(), "schema": 1, **extra}


# os.replace (MoveFileEx) cannot replace a file another process has open, so a
# status poll could silently discard a pause or disable. On Windows the store
# is replaced with POSIX rename semantics, which succeed while readers hold the
# file with FILE_SHARE_DELETE; every signed-state reader opens it that way. A
# process outside Monarch (Defender, indexer) may still hold it briefly.
_REPLACE_RETRY_SECONDS = 2.0


def _kernel32():
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                     wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel32.SetFileInformationByHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    return kernel32


def _open_handle(kernel32, path: Path, access: int):
    import ctypes
    from ctypes import wintypes

    share_all, open_existing, normal = 0x7, 3, 0x80
    handle = kernel32.CreateFileW(str(path), access, share_all, None, open_existing, normal, None)
    if handle == wintypes.HANDLE(-1).value:
        error = ctypes.get_last_error()
        raise ctypes.WinError(error)
    return handle


def read_shared_text(path: Path) -> str:
    """Read UTF-8 text without blocking a concurrent atomic replace of ``path``."""
    if os.name != "nt":
        return path.read_text(encoding="utf-8")
    import msvcrt

    kernel32 = _kernel32()
    handle = _open_handle(kernel32, path, 0x80000000)
    try:
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY)
    except OSError:
        kernel32.CloseHandle(handle)
        raise
    with os.fdopen(descriptor, "rb") as stream:
        return stream.read().decode("utf-8")


def _posix_replace(temporary: Path, path: Path) -> bool:
    """Replace via FileRenameInfoEx; False when the volume does not support it."""
    import ctypes
    from ctypes import wintypes

    class RenameInfo(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("RootDirectory", wintypes.HANDLE),
                    ("FileNameLength", wintypes.DWORD), ("FileName", wintypes.WCHAR * 1)]

    target = os.path.abspath(path)
    size = ctypes.sizeof(RenameInfo) + len(target) * ctypes.sizeof(wintypes.WCHAR)
    buffer = ctypes.create_string_buffer(size)
    info = RenameInfo.from_buffer(buffer)
    info.Flags = 0x1 | 0x2  # REPLACE_IF_EXISTS | POSIX_SEMANTICS
    info.FileNameLength = len(target) * ctypes.sizeof(wintypes.WCHAR)
    ctypes.memmove(ctypes.addressof(info) + RenameInfo.FileName.offset, target,
                   info.FileNameLength)
    kernel32 = _kernel32()
    handle = _open_handle(kernel32, temporary, 0x00010000)  # DELETE
    try:
        if kernel32.SetFileInformationByHandle(handle, 22, buffer, size):  # FileRenameInfoEx
            return True
        error = ctypes.get_last_error()
    finally:
        kernel32.CloseHandle(handle)
    if error in {1, 87, 50}:  # invalid function/parameter, not supported: FAT, old Windows
        return False
    raise ctypes.WinError(error)


def _replace(temporary: Path, path: Path) -> None:
    deadline = time.monotonic() + _REPLACE_RETRY_SECONDS
    delay = 0.01
    while True:
        try:
            if os.name != "nt" or not _posix_replace(temporary, path):
                os.replace(temporary, path)
            return
        except PermissionError:
            if os.name != "nt" or time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.1)


def durable_replace(path: Path, payload: bytes) -> None:
    """Flush file data before publishing a new name; preserve target on failure."""
    descriptor, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        _replace(temporary, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
