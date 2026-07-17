from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
import hashlib
import json
import os

from .events import RuleAssessment, SecurityEvent, utc_now
from .integrity import GENESIS_HASH, INTEGRITY_FIELD, audit_record_integrity, get_or_create_key
from .state import FileLock


class NetworkHistoryIntegrityError(RuntimeError):
    pass


@dataclass(frozen=True)
class NetworkObservation:
    observation_id: str
    fingerprint: str
    kind: str
    subject: str
    observed_at: str
    risk_score: int
    severity: str
    facts: dict[str, Any]

    @classmethod
    def from_assessment(cls, assessment: RuleAssessment) -> "NetworkObservation":
        event = assessment.event
        facts = _bounded_network_facts(event.facts)
        fingerprint = _observation_fingerprint(event.kind, facts)
        return cls(
            observation_id=hashlib.sha256(
                f"{event.event_id}|{fingerprint}".encode("utf-8")
            ).hexdigest()[:32],
            fingerprint=fingerprint,
            kind=event.kind,
            subject=event.subject[:1024],
            observed_at=event.timestamp,
            risk_score=max(0, min(100, int(assessment.score))),
            severity=str(assessment.severity),
            facts=facts,
        )

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "NetworkObservation":
        return cls(
            observation_id=str(payload.get("observation_id") or ""),
            fingerprint=str(payload.get("fingerprint") or ""),
            kind=str(payload.get("kind") or "network.observed"),
            subject=str(payload.get("subject") or ""),
            observed_at=str(payload.get("observed_at") or utc_now()),
            risk_score=max(0, min(100, int(payload.get("risk_score") or 0))),
            severity=str(payload.get("severity") or "clean"),
            facts=_bounded_network_facts(dict(payload.get("facts") or {})),
        )


class NetworkHistoryStore:
    """Append-only local history for network changes observed by the supervisor."""

    def __init__(self, path: Path, integrity_key_path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._key = get_or_create_key(integrity_key_path)
        self._items, self._last_hash = self._read_all()
        self._file_signature = self._signature()

    def append(self, observation: NetworkObservation) -> None:
        with FileLock(self.path):
            if self._signature() != self._file_signature:
                self._items, self._last_hash = self._read_all()
            items, last_hash = self._items, self._last_hash
            record: dict[str, Any] = {
                "kind": "network.observation",
                "timestamp": utc_now(),
                "observation": observation.to_dict(),
            }
            integrity = audit_record_integrity(record, self._key, last_hash)
            record[INTEGRITY_FIELD] = integrity
            line = json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
            items.append(observation)
            self._items = items[-20_000:]
            self._last_hash = integrity["record_hash"]
            self._file_signature = self._signature()

    def list_recent(self, limit: int = 200) -> list[NetworkObservation]:
        return list(reversed(self._items[-max(1, min(2000, int(limit))):]))

    def profiles(self, trusted_fingerprints: set[str]) -> list[dict[str, Any]]:
        latest: dict[str, NetworkObservation] = {}
        for item in self._items:
            if item.kind == "network.config_changed":
                profile_id = str(item.facts.get("network_profile_id") or "")
                if profile_id:
                    latest[profile_id] = item
        return [
            {
                "profile_id": profile_id,
                "trusted": profile_id in trusted_fingerprints,
                "interface_alias": item.facts.get("interface_alias"),
                "ipv4": item.facts.get("ipv4", []),
                "dns": item.facts.get("dns", []),
                "gateway": item.facts.get("gateway", []),
                "last_seen_at": item.observed_at,
            }
            for profile_id, item in sorted(
                latest.items(), key=lambda entry: entry[1].observed_at, reverse=True
            )
        ]

    def summary(self) -> dict[str, Any]:
        recent = self.list_recent(500)
        return {
            "records": len(self._items),
            "connections": sum(item.kind == "network.connection_seen" for item in recent),
            "listeners": sum(item.kind == "network.listener_seen" for item in recent),
            "high_attention": sum(item.risk_score >= 65 for item in recent),
            "last_observed_at": recent[0].observed_at if recent else None,
        }

    def _read_all(self) -> tuple[list[NetworkObservation], str]:
        if not self.path.exists():
            return [], GENESIS_HASH
        items: list[NetworkObservation] = []
        previous = GENESIS_HASH
        with self.path.open("r", encoding="utf-8", errors="strict") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise NetworkHistoryIntegrityError(
                        f"Network history line {line_number} is invalid JSON"
                    ) from exc
                if not isinstance(record, dict) or not isinstance(record.get(INTEGRITY_FIELD), dict):
                    raise NetworkHistoryIntegrityError(
                        f"Network history line {line_number} has no integrity metadata"
                    )
                expected = audit_record_integrity(record, self._key, previous)
                integrity = record[INTEGRITY_FIELD]
                if integrity.get("previous_hash") != previous or integrity.get("record_hash") != expected["record_hash"]:
                    raise NetworkHistoryIntegrityError(
                        f"Network history line {line_number} integrity mismatch"
                    )
                payload = record.get("observation")
                if isinstance(payload, dict):
                    items.append(NetworkObservation.from_dict(payload))
                previous = expected["record_hash"]
        return items[-20_000:], previous

    def _signature(self) -> tuple[int, int]:
        try:
            stat = self.path.stat()
            return stat.st_size, stat.st_mtime_ns
        except FileNotFoundError:
            return 0, 0


def network_profile_id(facts: dict[str, Any]) -> str:
    normalized = {
        "interface_alias": str(facts.get("interface_alias") or "").casefold(),
        "ipv4": sorted(str(item) for item in facts.get("ipv4") or []),
        "dns": sorted(str(item) for item in facts.get("dns") or []),
        "gateway": sorted(str(item) for item in facts.get("gateway") or []),
    }
    return hashlib.sha256(
        json.dumps(normalized, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:24]


def with_network_profile_trust(event: SecurityEvent, trusted_fingerprints: set[str]) -> SecurityEvent:
    if event.kind != "network.config_changed":
        return event
    facts = dict(event.facts)
    profile_id = network_profile_id(facts)
    trusted = profile_id in trusted_fingerprints
    facts["network_profile_id"] = profile_id
    facts["network_profile_trusted"] = trusted
    facts["network_profile_state"] = "trusted" if trusted else "untrusted"
    return SecurityEvent(
        kind=event.kind,
        source=event.source,
        subject=event.subject,
        facts=facts,
        event_id=event.event_id,
        timestamp=event.timestamp,
    )


def _observation_fingerprint(kind: str, facts: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps({"kind": kind, "facts": facts}, ensure_ascii=True, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()


def _bounded_network_facts(facts: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "kind", "interface_alias", "ipv4", "ipv6", "dns", "gateway",
        "dns_scopes", "gateway_scopes", "dns_public_count", "network_profile_id",
        "network_profile_trusted", "network_profile_state", "protocol", "local_address",
        "local_port", "local_scope", "remote_address", "remote_port", "remote_scope",
        "remote_is_public", "remote_domain", "owning_process", "process_name", "process_exe",
        "process_start_time",
        "exposed_on_all_interfaces", "ip_address", "ip_scope",
        "link_layer_address", "state",
    }
    bounded: dict[str, Any] = {}
    for key in allowed:
        value = facts.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            bounded[key] = value[:2048]
        elif isinstance(value, (int, float, bool)):
            bounded[key] = value
        elif isinstance(value, list):
            bounded[key] = [str(item)[:512] for item in value[:50]]
    return bounded
