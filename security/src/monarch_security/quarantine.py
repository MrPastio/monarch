from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Iterable, Literal
import hashlib
import json
import os
import shutil
import stat
import uuid

from .events import utc_now
from .filesystem_policy import (
    FileIdentity,
    FilesystemMutationPolicy,
    PathPolicyDecision,
    same_file_identity,
)
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

    def __init__(
        self,
        root: Path,
        manifest_path: Path,
        integrity_key_path: Path,
        *,
        application_root: Path | None = None,
        workspace_root: Path | None = None,
        state_root: Path | None = None,
        additional_protected_roots: Iterable[Path] = (),
    ) -> None:
        self.root = root.expanduser().resolve(strict=False)
        self.manifest_path = manifest_path.expanduser().resolve(strict=False)
        self.integrity_key_path = integrity_key_path.expanduser().resolve(strict=False)
        inferred_state_root = state_root or _common_parent(
            self.root,
            self.manifest_path.parent,
            self.integrity_key_path.parent,
        )
        self._path_policy = FilesystemMutationPolicy(
            application_root=application_root,
            workspace_root=workspace_root,
            state_root=inferred_state_root,
            additional_protected_roots=additional_protected_roots,
        )
        for candidate in (self.root, self.manifest_path, self.integrity_key_path):
            decision = self._path_policy.evaluate_vault_storage(candidate)
            if not decision.allowed:
                raise QuarantineError(
                    f"Quarantine storage is blocked by protected path policy ({decision.reason})"
                )
        if _is_within(self.manifest_path, self.root) or _is_within(self.integrity_key_path, self.root):
            raise QuarantineError("Quarantine manifest and integrity key must stay outside the object vault")
        if _same_path(self.manifest_path, self.integrity_key_path):
            raise QuarantineError("Quarantine manifest and integrity key must use distinct paths")
        self.root.mkdir(parents=True, exist_ok=True)
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        self.integrity_key_path.parent.mkdir(parents=True, exist_ok=True)
        self._root_identity = _directory_identity(self.root)
        self._key = get_or_create_key(self.integrity_key_path)
        self._latest, self._last_hash = self._read_all()

    def list(self, *, include_restored: bool = False) -> list[QuarantineRecord]:
        records = self._latest.values()
        if not include_restored:
            records = (record for record in records if record.status == "isolated")
        return sorted(records, key=lambda record: record.isolated_at, reverse=True)

    def get(self, quarantine_id: str) -> QuarantineRecord | None:
        return self._latest.get(str(quarantine_id))

    def isolate(self, source: Path, *, incident_id: str | None = None) -> QuarantineRecord:
        self._validate_vault_root()
        initial = self._path_policy.evaluate_source(source)
        source_path = _require_allowed_path(initial, "Isolation source")

        digest, size = _hash_file(source_path)
        final = self._path_policy.evaluate_source(source_path)
        final_path = _require_allowed_path(final, "Isolation source")
        if not _same_path(source_path, final_path) or not same_file_identity(initial.identity, final.identity):
            raise QuarantineError("Isolation source identity changed before the move")
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
            moved_digest, moved_size = _hash_file(vault_path)
            if moved_digest != digest or moved_size != size:
                raise QuarantineIntegrityError("Isolated object changed during the move")
            os.chmod(vault_path, 0o600)
            self._append(record)
        except Exception:
            if vault_path.exists() and not source_path.exists():
                _move_file(vault_path, source_path)
            raise
        return record

    def restore(self, quarantine_id: str, *, destination: Path | None = None) -> QuarantineRecord:
        self._validate_vault_root()
        record = self.get(quarantine_id)
        if record is None:
            raise QuarantineError("Unknown quarantine record")
        if record.status != "isolated":
            raise QuarantineError("Quarantine record is not active")
        vault_path = _validated_vault_object(Path(record.vault_path), self.root)
        digest, size = _hash_file(vault_path)
        if digest != record.sha256 or size != record.size:
            raise QuarantineIntegrityError("Vault object hash or size mismatch")

        initial_target = self._path_policy.evaluate_restore_target(destination or Path(record.original_path))
        target = _require_allowed_path(initial_target, "Restore destination")
        final_target = self._path_policy.evaluate_restore_target(target)
        final_target_path = _require_allowed_path(final_target, "Restore destination")
        if not _same_path(target, final_target_path) or not same_file_identity(
            initial_target.parent_identity,
            final_target.parent_identity,
        ):
            raise QuarantineError("Restore destination parent identity changed before the move")

        restored = replace(
            record,
            status="restored",
            restored_at=utc_now(),
            restored_path=str(target),
        )
        _move_file(vault_path, target)
        try:
            restored_digest, restored_size = _hash_file(target)
            if restored_digest != record.sha256 or restored_size != record.size:
                raise QuarantineIntegrityError("Restored object changed during the move")
            self._append(restored)
        except Exception:
            if target.exists() and not vault_path.exists():
                _move_file(target, vault_path)
            raise
        return restored

    def verify_objects(self) -> dict[str, Any]:
        self._validate_vault_root()
        failures: list[dict[str, str]] = []
        checked = 0
        for record in self.list():
            checked += 1
            try:
                path = _validated_vault_object(Path(record.vault_path), self.root)
                digest, size = _hash_file(path)
                if digest != record.sha256 or size != record.size:
                    raise QuarantineIntegrityError("hash or size mismatch")
            except (OSError, QuarantineError) as exc:
                failures.append({"quarantine_id": record.quarantine_id, "error": str(exc)})
        return {"ok": not failures, "checked": checked, "failures": failures}

    def _validate_vault_root(self) -> None:
        current = self.root.resolve(strict=True)
        if not _same_path(current, self.root):
            raise QuarantineIntegrityError("Quarantine vault root changed identity")
        if not same_file_identity(_directory_identity(current), self._root_identity):
            raise QuarantineIntegrityError("Quarantine vault root changed identity")

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
                if (
                    integrity.get("previous_hash") != previous
                    or integrity.get("record_hash") != expected["record_hash"]
                ):
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


def _validated_vault_object(candidate: Path, root: Path) -> Path:
    supplied = candidate.expanduser()
    value = os.lstat(supplied)
    attributes = int(getattr(value, "st_file_attributes", 0))
    if stat.S_ISLNK(value.st_mode) or bool(
        attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    ):
        raise QuarantineIntegrityError("Vault object escaped the configured quarantine root")
    resolved = supplied.resolve(strict=True)
    resolved_value = os.stat(resolved, follow_symlinks=False)
    if (
        not _is_within(resolved, root)
        or not stat.S_ISREG(resolved_value.st_mode)
        or int(getattr(resolved_value, "st_nlink", 1)) != 1
    ):
        raise QuarantineIntegrityError("Vault object escaped the configured quarantine root")
    return resolved


def _is_within(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath((_path_key(path), _path_key(root))) == _path_key(root)
    except (OSError, ValueError):
        return False


def _same_path(left: Path, right: Path) -> bool:
    return _path_key(left) == _path_key(right)


def _path_key(path: Path) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _common_parent(*paths: Path) -> Path:
    try:
        return Path(os.path.commonpath(tuple(os.fspath(path) for path in paths))).resolve(strict=False)
    except ValueError as exc:
        raise QuarantineError("Quarantine storage paths must share one state root") from exc


def _directory_identity(path: Path) -> FileIdentity:
    value = os.lstat(path)
    attributes = int(getattr(value, "st_file_attributes", 0))
    if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode) or bool(
        attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    ):
        raise QuarantineIntegrityError("Quarantine vault root must be a real directory")
    return FileIdentity(
        device=int(value.st_dev),
        inode=int(value.st_ino),
        mode=int(value.st_mode),
        links=int(getattr(value, "st_nlink", 1)),
        size=0,
        modified_ns=0,
        changed_ns=0,
    )


def _require_allowed_path(decision: PathPolicyDecision, label: str) -> Path:
    if not decision.allowed or decision.resolved_path is None:
        messages = {
            "restore-target-exists": "Restore destination already exists",
            "restore-parent-unavailable": "Restore destination parent does not exist",
            "restore-parent-not-directory": "Restore destination parent is not a directory",
            "linked-or-reparse-source": "Only a regular, non-symlink, non-reparse file can be isolated",
            "source-not-regular-file": "Only a regular, non-symlink, non-reparse file can be isolated",
            "source-unavailable": "Isolation source is unavailable",
        }
        message = messages.get(decision.reason)
        if message is not None:
            raise QuarantineError(message)
        raise QuarantineError(f"{label} is blocked by protected path policy ({decision.reason})")
    return decision.resolved_path
