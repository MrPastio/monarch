"""Process-lifetime ownership. OS releases the lock on crash; never steal by age."""
from __future__ import annotations

from pathlib import Path
import os
import errno


def lock_is_held(path: Path) -> bool | None:
    """Probe an existing lock without creating markers or stealing by age."""
    try:
        handle = path.open('r+b')
    except FileNotFoundError:
        return False
    except OSError:
        return None
    try:
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            return False
        except OSError as exc:
            return True if exc.errno in {errno.EACCES, errno.EAGAIN} else None
    finally:
        handle.close()


class RuntimeBusyError(RuntimeError):
    pass


class RuntimeLock:
    def __init__(self, path: Path):
        self.path = path
        self.handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            if self.path.stat().st_size == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise RuntimeBusyError("Security runtime already has an owner") from exc
        self.handle = handle
        return self

    def __exit__(self, *_):
        if self.handle is not None:
            self.handle.close()
            self.handle = None
