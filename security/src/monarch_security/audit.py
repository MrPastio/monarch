from __future__ import annotations

from pathlib import Path
from typing import Any

from .events import ActionDecision, RuleAssessment, json_line, utc_now
from .integrity import GENESIS_HASH, audit_record_integrity, get_or_create_key
from .state import FileLock


class AuditLog:
    def __init__(
        self,
        path: Path,
        max_bytes: int,
        stdout: bool = True,
        integrity_key_path: Path | None = None,
    ) -> None:
        self.path = path
        self.max_bytes = max_bytes
        self.stdout = stdout
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._integrity_key_path = integrity_key_path
        self._integrity_key = (
            get_or_create_key(integrity_key_path) if integrity_key_path is not None else None
        )
        self._last_hash = self._read_last_hash()

    def write(self, kind: str, payload: dict[str, Any]) -> None:
        with FileLock(self.path):
            self._last_hash = self._read_last_hash()
            record = {
                "kind": kind,
                "timestamp": utc_now(),
                **payload,
            }
            line = self._sealed_line(record)
            if self._rotate_if_needed(len(line) + 1):
                self._last_hash = GENESIS_HASH
                record["rotation_started"] = True
                line = self._sealed_line(record)
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
                handle.flush()
            if self._integrity_key is not None:
                integrity = record.get("_integrity")
                if isinstance(integrity, dict):
                    self._last_hash = str(integrity.get("record_hash") or GENESIS_HASH)
        if self.stdout:
            print(line)

    def _sealed_line(self, record: dict[str, Any]) -> str:
        record.pop("_integrity", None)
        if self._integrity_key is not None:
            record["_integrity"] = audit_record_integrity(
                record,
                self._integrity_key,
                self._last_hash,
            )
        return json_line(record)

    def decision(self, assessment: RuleAssessment, decision: ActionDecision) -> None:
        self.write(
            "decision",
            {
                "assessment": assessment.to_dict(),
                "decision": decision.to_dict(),
            },
        )

    def status(self, payload: dict[str, Any]) -> None:
        self.write("status", payload)

    def _rotate_if_needed(self, incoming_bytes: int) -> bool:
        if self.max_bytes <= 0 or not self.path.exists():
            return False
        if self.path.stat().st_size + incoming_bytes <= self.max_bytes:
            return False
        rotated = self.path.with_suffix(self.path.suffix + ".1")
        if rotated.exists():
            rotated.unlink()
        self.path.replace(rotated)
        return True

    def _read_last_hash(self) -> str:
        if not self.path.exists():
            return GENESIS_HASH
        last_hash = GENESIS_HASH
        try:
            with self.path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        import json

                        parsed = json.loads(stripped)
                    except json.JSONDecodeError:
                        continue
                    integrity = parsed.get("_integrity") if isinstance(parsed, dict) else None
                    if isinstance(integrity, dict) and integrity.get("record_hash"):
                        last_hash = str(integrity["record_hash"])
        except OSError:
            return GENESIS_HASH
        return last_hash
