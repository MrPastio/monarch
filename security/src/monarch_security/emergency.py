from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Literal
import ctypes
import json
import os

from .events import utc_now
from .incidents import Incident, IncidentStore
from .integrity import GENESIS_HASH, INTEGRITY_FIELD, audit_record_integrity, get_or_create_key
from .pin import SecurityPinManager
from .state import FileLock


EmergencyState = Literal[
    "activating", "awaiting_user", "contained", "released", "expired", "failed"
]
ACTIVE_EMERGENCY_STATES = {"activating", "awaiting_user", "contained"}


class EmergencyError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmergencyRecord:
    emergency_id: str
    incident_id: str
    state: EmergencyState
    risk_score: int
    activated_at: str
    expires_at: str
    updated_at: str
    native_lock_requested: bool
    native_lock_succeeded: bool
    containment: dict[str, Any]
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "EmergencyRecord":
        state = str(payload.get("state") or "failed")
        if state not in {"activating", "awaiting_user", "contained", "released", "expired", "failed"}:
            raise EmergencyError(f"Unsupported emergency state: {state}")
        return cls(
            emergency_id=str(payload.get("emergency_id") or ""),
            incident_id=str(payload.get("incident_id") or ""),
            state=state,  # type: ignore[arg-type]
            risk_score=max(0, min(800, int(payload.get("risk_score") or 0))),
            activated_at=str(payload.get("activated_at") or utc_now()),
            expires_at=str(payload.get("expires_at") or utc_now()),
            updated_at=str(payload.get("updated_at") or utc_now()),
            native_lock_requested=bool(payload.get("native_lock_requested", False)),
            native_lock_succeeded=bool(payload.get("native_lock_succeeded", False)),
            containment=dict(payload.get("containment") or {}),
            reason=str(payload.get("reason") or ""),
        )


class EmergencyStore:
    def __init__(self, path: Path, integrity_key_path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._key = get_or_create_key(integrity_key_path)
        self._latest, self._last_hash = self._read_all()

    def append(self, item: EmergencyRecord) -> None:
        with FileLock(self.path):
            latest, previous = self._read_all()
            record: dict[str, Any] = {
                "kind": "security.emergency",
                "timestamp": utc_now(),
                "emergency": item.to_dict(),
            }
            record[INTEGRITY_FIELD] = audit_record_integrity(record, self._key, previous)
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n")
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
            latest[item.emergency_id] = item
            self._latest = latest
            self._last_hash = record[INTEGRITY_FIELD]["record_hash"]

    def latest_active(self) -> EmergencyRecord | None:
        active = [item for item in self._latest.values() if item.state in ACTIVE_EMERGENCY_STATES]
        return max(active, key=lambda item: item.updated_at) if active else None

    def list_latest(self, limit: int = 50) -> list[EmergencyRecord]:
        return sorted(self._latest.values(), key=lambda item: item.updated_at, reverse=True)[:max(1, min(500, limit))]

    def latest_for_incident(self, incident_id: str) -> EmergencyRecord | None:
        items = [item for item in self._latest.values() if item.incident_id == incident_id]
        return max(items, key=lambda item: item.updated_at) if items else None

    def _read_all(self) -> tuple[dict[str, EmergencyRecord], str]:
        if not self.path.exists():
            return {}, GENESIS_HASH
        latest: dict[str, EmergencyRecord] = {}
        previous = GENESIS_HASH
        with self.path.open("r", encoding="utf-8", errors="strict") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise EmergencyError(f"Emergency line {line_number} is invalid JSON") from exc
                if not isinstance(record, dict) or not isinstance(record.get(INTEGRITY_FIELD), dict):
                    raise EmergencyError(f"Emergency line {line_number} has no integrity metadata")
                expected = audit_record_integrity(record, self._key, previous)
                integrity = record[INTEGRITY_FIELD]
                if integrity.get("previous_hash") != previous or integrity.get("record_hash") != expected["record_hash"]:
                    raise EmergencyError(f"Emergency line {line_number} integrity mismatch")
                payload = record.get("emergency")
                if isinstance(payload, dict):
                    item = EmergencyRecord.from_dict(payload)
                    latest[item.emergency_id] = item
                previous = expected["record_hash"]
        return latest, previous


class EmergencyManager:
    def __init__(
        self,
        incidents: IncidentStore,
        store: EmergencyStore,
        pin: SecurityPinManager,
        *,
        lock_fn: Callable[[], bool] | None = None,
        contain_fn: Callable[[str], dict[str, Any]] | None = None,
        resolve_fn: Callable[[str, str, str], dict[str, Any]] | None = None,
        now_fn: Callable[[], datetime] | None = None,
        recovery_seconds: int = 600,
    ) -> None:
        self.incidents = incidents
        self.store = store
        self.pin = pin
        self.lock_fn = lock_fn or lock_workstation
        self.contain_fn = contain_fn or (lambda incident_id: {"ok": False, "reason": "executor unavailable"})
        self.resolve_fn = resolve_fn or (lambda incident_id, pin, decision: {"ok": False, "reason": "executor unavailable"})
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        self.recovery_seconds = max(120, min(1800, int(recovery_seconds)))

    def activate(self, incident_id: str) -> EmergencyRecord:
        incident = self._eligible_incident(incident_id)
        existing = self.status()
        if existing and existing.state in ACTIVE_EMERGENCY_STATES:
            if existing.incident_id == incident_id:
                return existing
            raise EmergencyError("Another emergency response is already active")
        previous = self.store.latest_for_incident(incident_id)
        if previous is not None and previous.state in {"released", "expired", "failed"}:
            incident_updated = _parse_datetime(incident.updated_at)
            previous_updated = _parse_datetime(previous.updated_at)
            if incident_updated is None or previous_updated is None or incident_updated <= previous_updated:
                return previous
        now = self.now_fn()
        pin_configured = bool(self.pin.status().get("configured"))
        emergency_id = os.urandom(16).hex()
        expires_at = (now + timedelta(seconds=self.recovery_seconds)).isoformat()
        activating = EmergencyRecord(
            emergency_id=emergency_id,
            incident_id=incident.incident_id,
            state="activating",
            risk_score=incident.risk_score,
            activated_at=now.isoformat(),
            expires_at=expires_at,
            updated_at=now.isoformat(),
            native_lock_requested=pin_configured,
            native_lock_succeeded=False,
            containment={},
            reason="Corroborated emergency incident entered response state",
        )
        self.store.append(activating)
        try:
            containment = self.contain_fn(incident.incident_id)
        except Exception as exc:
            containment = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        if pin_configured:
            try:
                lock_succeeded = bool(self.lock_fn())
            except Exception:
                lock_succeeded = False
        else:
            lock_succeeded = False
        awaiting = EmergencyRecord(
            **{
                **activating.__dict__,
                "state": "awaiting_user",
                "updated_at": utc_now(),
                "native_lock_succeeded": lock_succeeded,
                "containment": _bounded_result(containment),
                "reason": (
                    "Native Windows lock requested; awaiting Windows sign-in and Security PIN decision"
                    if lock_succeeded
                    else (
                        "Security PIN is not configured; native lock suppressed to preserve fail-open recovery"
                        if not pin_configured
                        else "Native lock failed; containment remains time-bounded and user decision is required"
                    )
                ),
            }
        )
        self.store.append(awaiting)
        return awaiting

    def status(self) -> EmergencyRecord | None:
        active = self.store.latest_active()
        if active is None:
            return None
        expiry = _parse_datetime(active.expires_at)
        if expiry is not None and expiry <= self.now_fn():
            expired = EmergencyRecord(**{
                **active.__dict__,
                "state": "expired",
                "updated_at": utc_now(),
                "reason": "Emergency recovery TTL expired; fail-open release applied",
            })
            self.store.append(expired)
            return expired
        return active

    def resolve(self, pin_value: str, decision: Literal["release", "continue"]) -> EmergencyRecord:
        current = self.status()
        if current is None or current.state not in ACTIVE_EMERGENCY_STATES:
            raise EmergencyError("No active emergency response")
        verification = self.pin.verify(pin_value)
        if not verification.ok:
            raise EmergencyError(verification.reason)
        try:
            result = self.resolve_fn(current.incident_id, pin_value, decision)
        except Exception as exc:
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        if result.get("ok") is not True:
            if decision != "release":
                raise EmergencyError(str(result.get("error") or result.get("reason") or "Emergency executor rejected decision"))
            result = {
                "ok": True,
                "released": True,
                "executed": False,
                "reason": "Fail-open local release; external rollback remains governed by rule TTL",
                "error": str(result.get("error") or result.get("reason") or "executor unavailable"),
            }
        now = self.now_fn()
        next_state: EmergencyState = "released" if decision == "release" else "contained"
        expires_at = str(result.get("expires_at") or current.expires_at)
        updated = EmergencyRecord(**{
            **current.__dict__,
            "state": next_state,
            "expires_at": expires_at,
            "updated_at": now.isoformat(),
            "containment": _bounded_result(result),
            "reason": (
                "User took control; emergency containment released"
                if decision == "release"
                else "User confirmed continued time-bounded Security containment"
            ),
        })
        self.store.append(updated)
        return updated

    def summary(self) -> dict[str, Any]:
        current = self.status()
        if current is None:
            history = self.store.list_latest(1)
            current = history[0] if history else None
        if current is None:
            return {"active": False, "state": "idle", "incident_id": None, "risk_score": 0}
        return {
            "active": current.state in ACTIVE_EMERGENCY_STATES,
            "state": current.state,
            "emergency_id": current.emergency_id,
            "incident_id": current.incident_id,
            "risk_score": current.risk_score,
            "expires_at": current.expires_at,
            "native_lock_succeeded": current.native_lock_succeeded,
            "containment": current.containment,
            "reason": current.reason,
        }

    def _eligible_incident(self, incident_id: str) -> Incident:
        incident = self.incidents.get(incident_id)
        if incident is None or incident.status not in {"open", "acknowledged", "contained"}:
            raise EmergencyError("Emergency activation requires an active incident")
        if incident.risk_score < 700 or not incident.emergency_eligible:
            raise EmergencyError("Emergency activation requires corroborated risk 700-800")
        high_families = {
            item.family for item in incident.evidence if item.deterministic and item.event_score >= 65
        }
        trusted_chain = any(item.trusted_malicious for item in incident.evidence) and any(
            item.harmful_behavior for item in incident.evidence
        )
        if len(high_families) < 2 and not trusted_chain:
            raise EmergencyError("Emergency evidence corroboration is insufficient")
        return incident


def lock_workstation() -> bool:
    if os.name != "nt":
        return False
    try:
        return bool(ctypes.windll.user32.LockWorkStation())
    except Exception:
        return False


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _bounded_result(value: dict[str, Any]) -> dict[str, Any]:
    allowed = {"ok", "executed", "released", "action_id", "grant_id", "expires_at", "reason", "error"}
    result: dict[str, Any] = {}
    for key in allowed:
        item = value.get(key)
        if isinstance(item, (str, int, float, bool)):
            result[key] = item if not isinstance(item, str) else item[:1000]
    return result
