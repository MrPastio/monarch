from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
import os
import stat as stat_module

from monarch_security.events import SecurityEvent


class FileChangeSensor:
    def __init__(
        self,
        paths: Iterable[Path],
        recursive: bool,
        max_entries_per_tick: int,
        include_existing: bool = False,
        initial_signatures: dict[str, str] | None = None,
    ) -> None:
        self.paths = tuple(paths)
        self.recursive = recursive
        self.max_entries_per_tick = max(1, max_entries_per_tick)
        self.include_existing = include_existing
        self._signatures: dict[str, str] = dict(initial_signatures or {})
        self._first_poll = not bool(initial_signatures)

    @property
    def signatures(self) -> dict[str, str]:
        return dict(self._signatures)

    def snapshot_signatures(self) -> dict[str, str]:
        return {
            key: item["signature"]
            for key, item in self._snapshot().items()
        }

    def poll(self) -> list[SecurityEvent]:
        snapshot = self._snapshot()
        changed = [
            item
            for item in snapshot.values()
            if self._signatures.get(item["key"]) != item["signature"]
        ]
        self._signatures = {
            key: item["signature"]
            for key, item in snapshot.items()
        }

        if self._first_poll and not self.include_existing:
            self._first_poll = False
            return []

        self._first_poll = False
        return [self._event_from_item(item) for item in changed]

    def _snapshot(self) -> dict[str, dict[str, str]]:
        snapshot: dict[str, dict[str, str]] = {}
        budget = self.max_entries_per_tick
        for root in self.paths:
            if budget <= 0:
                break
            if not root.exists():
                continue
            for path in self._walk(root):
                if budget <= 0:
                    break
                budget -= 1
                try:
                    file_stat = path.stat()
                except OSError:
                    continue
                if not stat_module.S_ISREG(file_stat.st_mode):
                    continue
                resolved_path = str(path.resolve())
                key = resolved_path.lower()
                signature = f"{file_stat.st_size}:{file_stat.st_mtime_ns}"
                snapshot[key] = {
                    "key": key,
                    "path": resolved_path,
                    "name": path.name,
                    "size": str(file_stat.st_size),
                    "mtime_ns": str(file_stat.st_mtime_ns),
                    "extension": path.suffix.lower(),
                    "signature": signature,
                }
        return snapshot

    def _walk(self, root: Path):
        if not self.recursive:
            try:
                with os.scandir(root) as entries:
                    for entry in entries:
                        yield Path(entry.path)
            except OSError:
                return
            return

        for current_root, dirs, files in os.walk(root):
            dirs[:] = [directory for directory in dirs if not directory.startswith(".")]
            for file_name in files:
                yield Path(current_root) / file_name

    @staticmethod
    def _event_from_item(item: dict[str, str]) -> SecurityEvent:
        return SecurityEvent(
            kind="file.observed",
            source="file_watch_sensor",
            subject=item["path"],
            facts={
                "path": item["path"],
                "name": item["name"],
                "size": int(item["size"]),
                "extension": item["extension"],
                "mtime_ns": int(item["mtime_ns"]),
            },
        )
