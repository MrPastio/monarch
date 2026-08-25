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
        self._cursor = 0
        self._overflow = False
        self._cycle_seen: set[str] = set()

    @property
    def signatures(self) -> dict[str, str]:
        return dict(self._signatures)

    def snapshot_signatures(self) -> dict[str, str]:
        return {
            key: item["signature"]
            for key, item in self._snapshot_all().items()
        }

    @property
    def checkpoint_cursor(self) -> int:
        return self._cursor

    @property
    def overflow(self) -> bool:
        return self._overflow

    def restore_checkpoint_cursor(self, value: object) -> None:
        try:
            cursor = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("file watch cursor is invalid") from exc
        if cursor < 0:
            raise ValueError("file watch cursor is negative")
        self._cursor = cursor

    @property
    def checkpoint_metadata(self) -> dict[str, list[str]]:
        return {"cycle_seen": sorted(self._cycle_seen)}

    def restore_checkpoint_metadata(self, value: object) -> None:
        if not isinstance(value, dict) or not isinstance(value.get("cycle_seen"), list):
            raise ValueError("file watch checkpoint metadata is invalid")
        self._cycle_seen = {str(item) for item in value["cycle_seen"]}

    def poll(self) -> list[SecurityEvent]:
        snapshot = self._snapshot_page()
        changed = [
            item
            for item in snapshot.values()
            if self._signatures.get(item["key"]) != item["signature"]
        ]
        self._signatures.update({
            key: item["signature"]
            for key, item in snapshot.items()
        })
        self._cycle_seen.update(snapshot)
        if self._cursor == 0:
            self._signatures = {
                key: value
                for key, value in self._signatures.items()
                if key in self._cycle_seen
            }
            self._cycle_seen.clear()

        if self._first_poll and not self.include_existing:
            if self._cursor == 0:
                self._first_poll = False
            return []

        self._first_poll = False
        return [self._event_from_item(item) for item in changed]

    def _snapshot_page(self) -> dict[str, dict[str, str]]:
        snapshot: dict[str, dict[str, str]] = {}
        budget = self.max_entries_per_tick
        skipped = 0
        consumed = 0
        has_more = False
        for root in self.paths:
            if has_more:
                break
            if not root.exists():
                continue
            for path in self._walk(root):
                if skipped < self._cursor:
                    skipped += 1
                    continue
                if consumed >= budget:
                    has_more = True
                    break
                consumed += 1
                item = self._snapshot_item(path)
                if item is not None:
                    snapshot[item["key"]] = item
        self._overflow = has_more
        self._cursor = self._cursor + consumed if has_more else 0
        return snapshot

    def _snapshot_all(self) -> dict[str, dict[str, str]]:
        snapshot: dict[str, dict[str, str]] = {}
        for root in self.paths:
            if not root.exists():
                continue
            for path in self._walk(root):
                item = self._snapshot_item(path)
                if item is not None:
                    snapshot[item["key"]] = item
        return snapshot

    @staticmethod
    def _snapshot_item(path: Path) -> dict[str, str] | None:
        try:
            file_stat = path.stat()
        except OSError:
            return None
        if not stat_module.S_ISREG(file_stat.st_mode):
            return None
        resolved_path = str(path.resolve())
        key = resolved_path.lower()
        signature = f"{file_stat.st_size}:{file_stat.st_mtime_ns}"
        return {
            "key": key,
            "path": resolved_path,
            "name": path.name,
            "size": str(file_stat.st_size),
            "mtime_ns": str(file_stat.st_mtime_ns),
            "extension": path.suffix.lower(),
            "signature": signature,
        }

    def _walk(self, root: Path):
        if not self.recursive:
            try:
                with os.scandir(root) as entries:
                    for entry in sorted(entries, key=lambda item: item.path.casefold()):
                        yield Path(entry.path)
            except OSError:
                return
            return

        for current_root, dirs, files in os.walk(root):
            dirs[:] = sorted(
                (directory for directory in dirs if not directory.startswith(".")),
                key=str.casefold,
            )
            for file_name in sorted(files, key=str.casefold):
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
