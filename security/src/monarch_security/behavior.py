from __future__ import annotations

from collections import deque
from pathlib import Path
import os
import time

from .events import SecurityEvent


class FileBurstDetector:
    """Detects a deterministic burst of distinct file changes without reading content."""

    def __init__(
        self,
        *,
        window_seconds: float = 20.0,
        file_threshold: int = 20,
        cooldown_seconds: float = 60.0,
    ) -> None:
        self.window_seconds = max(2.0, float(window_seconds))
        self.file_threshold = max(5, int(file_threshold))
        self.cooldown_seconds = max(self.window_seconds, float(cooldown_seconds))
        self._events: deque[tuple[float, str, str]] = deque()
        self._last_alert = 0.0

    def observe(self, event: SecurityEvent, *, now: float | None = None) -> SecurityEvent | None:
        if (
            event.kind != "file.observed"
            or event.source == "ransomware_burst_detector"
            or event.facts.get("ransomware_behavior") is True
        ):
            return None
        current = time.monotonic() if now is None else float(now)
        path = str(event.facts.get("path") or event.subject).strip()
        if not path:
            return None
        extension = str(event.facts.get("extension") or Path(path).suffix).lower()
        self._events.append((current, os.path.normcase(path), extension))
        cutoff = current - self.window_seconds
        while self._events and self._events[0][0] < cutoff:
            self._events.popleft()

        unique_paths = {item[1] for item in self._events}
        if len(unique_paths) < self.file_threshold:
            return None
        if current - self._last_alert < self.cooldown_seconds:
            return None
        self._last_alert = current
        extensions = sorted({item[2] for item in self._events if item[2]})
        sample_paths = sorted(unique_paths)[:12]
        common_root = _safe_common_root(sample_paths)
        return SecurityEvent(
            kind="file.observed",
            source="ransomware_burst_detector",
            subject=f"file-burst:{common_root}",
            facts={
                "ransomware_behavior": True,
                "harmful_behavior": True,
                "burst_count": len(unique_paths),
                "window_seconds": self.window_seconds,
                "extension_count": len(extensions),
                "extensions": extensions[:20],
                "sample_paths": sample_paths,
                "common_root": common_root,
            },
        )


def _safe_common_root(paths: list[str]) -> str:
    if not paths:
        return "unknown"
    try:
        return os.path.commonpath(paths)
    except ValueError:
        return "multiple-volumes"
