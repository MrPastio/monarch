from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal
import hashlib
import json
import os
import shutil
import uuid

from .events import utc_now
from .integrity import GENESIS_HASH, INTEGRITY_FIELD, audit_record_integrity, get_or_create_key
from .state import FileLock


QuarantineStatus = Literal["isolated", "restored"]


class QuarantineError(RuntimeError):
    pass


class QuarantineIntegrityError(QuarantineError):
    pass


@dataclass(frozen=True)
class QuarantineRecord:
    quarantine_id: str
    original_path: str
    vault_path: str
    sha256: str
    size: int
    isolated_at: str
    status: QuarantineStatus = "isolated"
    restored_at: str | None = None
    restored_path: str | None = None
    incident_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "quarantine_id": self.quarantine_id,
            "original_path": self.original_path,
            "vault_path": self.vault_path,
            "sha256": self.sha256,
            "size": self.size,
            "isolated_at": self.isolated_at,
            "status": self.status,
            "restored_at": self.restored_at,
            "restored_path": self.restored_path,
            "incident_id": self.incident_id,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "QuarantineRecord":
        status = str(payload.get("status") or "isolated")
        if status not in {"isolated", "restored"}:
            raise QuarantineIntegrityError(f"Unsupported quarantine status: {status}")
        return cls(
            quarantine_id=str(payload.get("quarantine_id") or ""),
            original_path=str(payload.get("original_path") or ""),
            vault_path=str(payload.get("vault_path") or ""),
            sha256=str(payload.get("sha256") or ""),
            size=max(0, int(payload.get("size") or 0)),
            isolated_at=str(payload.get("isolated_at") or ""),
            status=status,  # type: ignore[arg-type]
            restored_at=(str(payload["restored_at"]) if payload.get("restored_at") else None),
            restored_path=(str(payload["restored_path"]) if payload.get("restored_path") else None),
            incident_id=(str(payload["incident_id"]) if payload.get("incident_id") else None),
        )


class QuarantineVault:
    """Local quarantine with an append-only HMAC manifest and safe restore."""

    def __init__(self, root: Path, manifest_path: Path, integrity_key_path: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.manifest_path = manifest_path.resolve()
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        self._key = get_or_create_key(integrity_key_path)
        self._latest, self._last_hash = self._read_all()

    def list(self, *, include_restored: bool = False) -> list[QuarantineRecord]:
        records = self._latest.values()
        if not include_restored:
            records = (record for record in records if record.status == "isolated")
        return sorted(records, key=lambda record: record.isolated_at, reverse=True)

    def get(self, quarantine_id: str) -> QuarantineRecord | None:
        return self._latest.get(str(quarantine_id))

    def isolate(self, source: Path, *, incident_id: str | None = None) -> QuarantineRecord:
        source_path = source.expanduser().resolve(strict=True)
        if source_path.is_symlink() or not source_path.is_file():
            raise QuarantineError("Only a regular, non-symlink file can be isolated")
        if _is_within(source_path, self.root):
            raise QuarantineError("File is already inside the quarantine vault")

        digest, size = _hash_file(source_path)
        quarantine_id = str(uuid.uuid4())
        vault_path = self.root / f"{quarantine_id}.bin"
        record = QuarantineRecord(
            quarantine_id=quarantine_id,
            original_path=str(source_path),
            vault_path=str(vault_path),
            sha256=digest,
            size=size,
            isolated_at=utc_now(),
            incident_id=(str(incident_id)[:128] if incident_id else None),
        )
        _move_file(source_path, vault_path)
        try:
            os.chmod(vault_path, 0o600)
            self._append(record)
        except Exception:
            if vault_path.exists() and not source_path.exists():
                _move_file(vault_path, source_path)
            raise
        return record

    def restore(self, quarantine_id: str, *, destination: Path | None = None) -> QuarantineRecord:
        record = self.get(quarantine_id)
        if record is None:
            raise QuarantineError("Unknown quarantine record")
        if record.status != "isolated":
            raise QuarantineError("Quarantine record is not active")
        vault_path = Path(record.vault_path).resolve(strict=True)
        if not _is_within(vault_path, self.root) or vault_path.is_symlink() or not vault_path.is_file():
            raise QuarantineIntegrityError("Vault object escaped the configured quarantine root")
        digest, size = _hash_file(vault_path)
        if digest != record.sha256 or size != record.size:
            raise QuarantineIntegrityError("Vault object hash or size mismatch")

        target = (destination or Path(record.original_path)).expanduser().resolve(strict=False)
        if _is_within(target, self.root):
            raise QuarantineError("Restore destination cannot be inside the quarantine vault")
        if target.exists():
            raise QuarantineError("Restore destination already exists")
        if not target.parent.exists() or not target.parent.is_dir():
            raise QuarantineError("Restore destination parent does not exist")

        restored = replace(
            record,
            status="restored",
            restored_at=utc_now(),
            restored_path=str(target),
        )
        _move_file(vault_path, target)
        try:
            self._append(restored)
        except Exception:
            if target.exists() and not vault_path.exists():
                _move_file(target, vault_path)
            raise
        return restored

    def verify_objects(self) -> dict[str, Any]:
        failures: list[dict[str, str]] = []
        checked = 0
        for record in self.list():
            checked += 1
            try:
                path = Path(record.vault_path).resolve(strict=True)
                if not _is_within(path, self.root) or path.is_symlink() or not path.is_file():
                    raise QuarantineIntegrityError("invalid vault path")
                digest, size = _hash_file(path)
                if digest != record.sha256 or size != record.size:
                    raise QuarantineIntegrityError("hash or size mismatch")
            except (OSError, QuarantineError) as exc:
                failures.append({"quarantine_id": record.quarantine_id, "error": str(exc)})
        return {"ok": not failures, "checked": checked, "failures": failures}

    def _append(self, record: QuarantineRecord) -> None:
        with FileLock(self.manifest_path):
            latest, last_hash = self._read_all()
            payload: dict[str, Any] = {
                "kind": "quarantine.snapshot",
                "timestamp": utc_now(),
                "record": record.to_dict(),
            }
            integrity = audit_record_integrity(payload, self._key, last_hash)
            payload[INTEGRITY_FIELD] = integrity
            line = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            with self.manifest_path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
            latest[record.quarantine_id] = record
            self._latest = latest
            self._last_hash = integrity["record_hash"]

    def _read_all(self) -> tuple[dict[str, QuarantineRecord], str]:
        if not self.manifest_path.exists():
            return {}, GENESIS_HASH
        latest: dict[str, QuarantineRecord] = {}
        previous = GENESIS_HASH
        with self.manifest_path.open("r", encoding="utf-8", errors="strict") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise QuarantineIntegrityError(
                        f"Quarantine manifest line {line_number} is invalid JSON"
                    ) from exc
                if not isinstance(payload, dict) or not isinstance(payload.get(INTEGRITY_FIELD), dict):
                    raise QuarantineIntegrityError(
                        f"Quarantine manifest line {line_number} has no integrity metadata"
                    )
                expected = audit_record_integrity(payload, self._key, previous)
                integrity = payload[INTEGRITY_FIELD]
                if integrity.get("previous_hash") != previous or integrity.get("record_hash") != expected["record_hash"]:
                    raise QuarantineIntegrityError(
                        f"Quarantine manifest line {line_number} integrity mismatch"
                    )
                record_payload = payload.get("record")
                if isinstance(record_payload, dict):
                    record = QuarantineRecord.from_dict(record_payload)
                    if not record.quarantine_id:
                        raise QuarantineIntegrityError(
                            f"Quarantine manifest line {line_number} has no record id"
                        )
                    latest[record.quarantine_id] = record
                previous = expected["record_hash"]
        return latest, previous


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _move_file(source: Path, destination: Path) -> None:
    if destination.exists():
        raise QuarantineError("Destination already exists")
    try:
        os.replace(source, destination)
    except OSError:
        shutil.move(str(source), str(destination))


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
