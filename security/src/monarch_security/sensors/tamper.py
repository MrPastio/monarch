from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
import hashlib
import stat

from monarch_security.events import SecurityEvent
from monarch_security.observation import ObservedSensor, ObservationUnavailable


class TamperSensor(ObservedSensor):
    def __init__(
        self,
        paths: Iterable[Path],
        *,
        include_existing: bool = False,
        initial_signatures: dict[str, str] | None = None,
    ) -> None:
        self.paths = tuple(Path(path).resolve() for path in paths)
        self.include_existing = include_existing
        self._signatures = dict(initial_signatures or {})
        self._first_poll = not bool(initial_signatures)

    @property
    def signatures(self) -> dict[str, str]:
        return dict(self._signatures)

    def poll(self) -> list[SecurityEvent]:
        snapshot = self.snapshot_signatures()
        changed: list[SecurityEvent] = []
        for key in sorted(set(self._signatures) | set(snapshot)):
            before = self._signatures.get(key)
            after = snapshot.get(key)
            if before == after:
                continue
            changed.append(
                SecurityEvent(
                    kind="security.tamper_detected",
                    source="tamper_sensor",
                    subject=key,
                    facts={
                        "path": key,
                        "expected_sha256": before,
                        "actual_sha256": after,
                        "missing": after is None,
                        "self_protection_violation": True,
                    },
                )
            )
        self._signatures = snapshot
        if self._first_poll and not self.include_existing:
            self._first_poll = False
            return []
        self._first_poll = False
        return changed

    def snapshot_signatures(self) -> dict[str, str]:
        self.begin_observation()
        signatures: dict[str, str] = {}
        for path in self.paths:
            key = str(path)
            try:
                metadata = path.lstat()
                if not stat.S_ISREG(metadata.st_mode) or getattr(metadata, 'st_file_attributes', 0) & 0x400:
                    continue
                signatures[key] = _sha256(path)
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise ObservationUnavailable('self-file-read-unavailable') from exc
        return signatures


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
