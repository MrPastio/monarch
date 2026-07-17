from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal
import hashlib
import json
import os
import shutil
import time
import uuid

from .audit import AuditLog
from .events import ActionDecision, RuleAssessment, utc_now
from .integrity import (
    GENESIS_HASH,
    INTEGRITY_FIELD,
    audit_record_integrity,
    get_or_create_key,
    verify_audit_log,
)
from .state import FileLock


IncidentStatus = Literal["open", "acknowledged", "contained", "resolved", "dismissed"]
RiskLevel = Literal[
    "clean",
    "informational",
    "guarded",
    "suspicious",
    "high",
    "critical",
    "emergency",
]
ProposalAction = Literal[
    "preserve",
    "deep_scan",
    "isolate",
    "block_network",
    "suspend_process",
    "terminate_process",
    "delete",
]


ALLOWED_PROPOSAL_ACTIONS = {
    "preserve",
    "deep_scan",
    "isolate",
    "block_network",
    "suspend_process",
    "terminate_process",
    "delete",
}
PIN_REQUIRED_ACTIONS = {"block_network", "terminate_process", "delete"}
CONFIRMATION_REQUIRED_ACTIONS = {
    "isolate",
    "block_network",
    "suspend_process",
    "terminate_process",
    "delete",
}
MIN_DURABLE_INCIDENT_SCORE = 250


class IncidentStoreIntegrityError(RuntimeError):
    pass


@dataclass(frozen=True)
class IncidentEvidence:
    evidence_id: str
    event_id: str
    family: str
    kind: str
    source: str
    subject: str
    observed_at: str
    event_score: int
    severity: str
    reasons: tuple[str, ...]
    facts_sha256: str
    response_scope: dict[str, Any]
    deterministic: bool = True
    trusted_malicious: bool = False
    harmful_behavior: bool = False

    @classmethod
    def from_assessment(cls, assessment: RuleAssessment) -> "IncidentEvidence":
        event = assessment.event
        facts_json = json.dumps(
            event.facts,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return cls(
            evidence_id=str(uuid.uuid4()),
            event_id=event.event_id,
            family=event_family(event.kind),
            kind=event.kind,
            source=event.source,
            subject=event.subject,
            observed_at=event.timestamp,
            event_score=max(0, min(100, int(assessment.score))),
            severity=assessment.severity,
            reasons=tuple(str(reason)[:240] for reason in assessment.reasons[:12]),
            facts_sha256=hashlib.sha256(facts_json.encode("utf-8")).hexdigest(),
            response_scope=_response_scope(event.facts),
            deterministic=not event.source.lower().startswith("llm"),
            trusted_malicious=_trusted_malicious(event.source, event.facts),
            harmful_behavior=_harmful_behavior(event.facts),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "evidence_id": self.evidence_id,
            "event_id": self.event_id,
            "family": self.family,
            "kind": self.kind,
            "source": self.source,
            "subject": self.subject,
            "observed_at": self.observed_at,
            "event_score": self.event_score,
            "severity": self.severity,
            "reasons": list(self.reasons),
            "facts_sha256": self.facts_sha256,
            "response_scope": self.response_scope,
            "deterministic": self.deterministic,
            "trusted_malicious": self.trusted_malicious,
            "harmful_behavior": self.harmful_behavior,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "IncidentEvidence":
        return cls(
            evidence_id=str(payload.get("evidence_id") or uuid.uuid4()),
            event_id=str(payload.get("event_id") or ""),
            family=str(payload.get("family") or "other"),
            kind=str(payload.get("kind") or "unknown"),
            source=str(payload.get("source") or "unknown"),
            subject=str(payload.get("subject") or "unknown"),
            observed_at=str(payload.get("observed_at") or utc_now()),
            event_score=max(0, min(100, int(payload.get("event_score") or 0))),
            severity=str(payload.get("severity") or "unknown"),
            reasons=tuple(str(item) for item in payload.get("reasons") or []),
            facts_sha256=str(payload.get("facts_sha256") or ""),
            response_scope=_bounded_scope(dict(payload.get("response_scope") or {}), allow_empty=True),
            deterministic=bool(payload.get("deterministic", True)),
            trusted_malicious=bool(payload.get("trusted_malicious", False)),
            harmful_behavior=bool(payload.get("harmful_behavior", False)),
        )


@dataclass(frozen=True)
class Incident:
    incident_id: str
    correlation_key: str
    status: IncidentStatus
    title: str
    primary_subject: str
    created_at: str
    updated_at: str
    risk_score: int
    risk_level: RiskLevel
    evidence: tuple[IncidentEvidence, ...]
    evidence_families: tuple[str, ...]
    decision_required: bool
    emergency_eligible: bool
    recommended_actions: tuple[str, ...]
    current_decision: dict[str, Any] | None = None
    resolution: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "incident_id": self.incident_id,
            "correlation_key": self.correlation_key,
            "status": self.status,
            "title": self.title,
            "primary_subject": self.primary_subject,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "risk_score": self.risk_score,
            "risk_level": self.risk_level,
            "evidence": [item.to_dict() for item in self.evidence],
            "evidence_families": list(self.evidence_families),
            "decision_required": self.decision_required,
            "emergency_eligible": self.emergency_eligible,
            "recommended_actions": list(self.recommended_actions),
            "current_decision": self.current_decision,
            "resolution": self.resolution,
            "attack_chain": build_attack_chain(self.evidence),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Incident":
        evidence = tuple(
            IncidentEvidence.from_dict(item)
            for item in payload.get("evidence") or []
            if isinstance(item, dict)
        )
        score = max(0, min(800, int(payload.get("risk_score") or 0)))
        return cls(
            incident_id=str(payload.get("incident_id") or uuid.uuid4()),
            correlation_key=str(payload.get("correlation_key") or "unknown"),
            status=_incident_status(payload.get("status")),
            title=str(payload.get("title") or "Security incident"),
            primary_subject=str(payload.get("primary_subject") or "unknown"),
            created_at=str(payload.get("created_at") or utc_now()),
            updated_at=str(payload.get("updated_at") or utc_now()),
            risk_score=score,
            risk_level=risk_level(score),
            evidence=evidence,
            evidence_families=tuple(sorted({item.family for item in evidence})),
            decision_required=bool(payload.get("decision_required", score >= 250)),
            emergency_eligible=bool(payload.get("emergency_eligible", False)),
            recommended_actions=tuple(str(item) for item in payload.get("recommended_actions") or []),
            current_decision=(
                dict(payload["current_decision"])
                if isinstance(payload.get("current_decision"), dict)
                else None
            ),
            resolution=(
                dict(payload["resolution"])
                if isinstance(payload.get("resolution"), dict)
                else None
            ),
        )


@dataclass(frozen=True)
class ResponseProposal:
    proposal_id: str
    incident_id: str
    action: ProposalAction
    scope: dict[str, Any]
    rationale: tuple[str, ...]
    proposed_by: Literal["rules", "llm", "user"]
    created_at: str = field(default_factory=utc_now)
    expires_at: str | None = None
    requires_user_confirmation: bool = True
    requires_security_pin: bool = False
    approved: bool = False

    @classmethod
    def create(
        cls,
        incident_id: str,
        action: str,
        scope: dict[str, Any],
        rationale: list[str] | tuple[str, ...],
        proposed_by: Literal["rules", "llm", "user"],
        expires_at: str | None = None,
    ) -> "ResponseProposal":
        normalized = action.strip().lower()
        if normalized not in ALLOWED_PROPOSAL_ACTIONS:
            raise ValueError(f"Unsupported response proposal action: {action}")
        return cls(
            proposal_id=str(uuid.uuid4()),
            incident_id=incident_id,
            action=normalized,  # type: ignore[arg-type]
            scope=_bounded_scope(scope),
            rationale=tuple(str(item)[:240] for item in rationale[:8]),
            proposed_by=proposed_by,
            expires_at=expires_at,
            requires_user_confirmation=normalized in CONFIRMATION_REQUIRED_ACTIONS,
            requires_security_pin=normalized in PIN_REQUIRED_ACTIONS,
            approved=False,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "proposal_id": self.proposal_id,
            "incident_id": self.incident_id,
            "action": self.action,
            "scope": self.scope,
            "rationale": list(self.rationale),
            "proposed_by": self.proposed_by,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "requires_user_confirmation": self.requires_user_confirmation,
            "requires_security_pin": self.requires_security_pin,
            "approved": self.approved,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ResponseProposal":
        action = str(payload.get("action") or "")
        if action not in ALLOWED_PROPOSAL_ACTIONS:
            raise ValueError(f"Unsupported response proposal action: {action}")
        proposed_by = str(payload.get("proposed_by") or "rules")
        if proposed_by not in {"rules", "llm", "user"}:
            raise ValueError(f"Unsupported response proposal source: {proposed_by}")
        return cls(
            proposal_id=str(payload.get("proposal_id") or uuid.uuid4()),
            incident_id=str(payload.get("incident_id") or ""),
            action=action,  # type: ignore[arg-type]
            scope=_bounded_scope(dict(payload.get("scope") or {})),
            rationale=tuple(str(item) for item in payload.get("rationale") or []),
            proposed_by=proposed_by,  # type: ignore[arg-type]
            created_at=str(payload.get("created_at") or utc_now()),
            expires_at=(str(payload["expires_at"]) if payload.get("expires_at") else None),
            requires_user_confirmation=bool(payload.get("requires_user_confirmation", True)),
            requires_security_pin=bool(payload.get("requires_security_pin", False)),
            approved=bool(payload.get("approved", False)),
        )


class IncidentStore:
    """Append-only, HMAC-chained incident snapshots."""

    def __init__(
        self,
        path: Path,
        integrity_key_path: Path,
        *,
        max_bytes: int = 0,
        max_archives: int = 8,
        max_live_incidents: int = 0,
        compact_on_open: bool = False,
    ) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.integrity_key_path = integrity_key_path
        self._key = get_or_create_key(integrity_key_path)
        self.max_bytes = max(0, int(max_bytes))
        self.max_archives = max(1, min(64, int(max_archives)))
        self.max_live_incidents = max(0, int(max_live_incidents))
        self.archive_dir = path.with_name(f"{path.name}.archives")
        self.retention_log_path = path.with_name(f"{path.name}.retention.jsonl")
        self._latest, self._last_hash = self._read_all()
        self._file_signature = self._signature()
        if compact_on_open:
            self._compact_if_needed()

    def append(self, incident: Incident) -> None:
        with FileLock(self.path):
            if self._signature() != self._file_signature:
                self._latest, self._last_hash = self._read_all()
            latest, last_hash = self._latest, self._last_hash
            record = {
                "kind": "incident.snapshot",
                "timestamp": utc_now(),
                "incident": incident.to_dict(),
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
            latest[incident.incident_id] = incident
            self._latest = latest
            self._last_hash = integrity["record_hash"]
            self._file_signature = self._signature()
        self._compact_if_needed()

    def list_latest(self, limit: int = 100) -> list[Incident]:
        self._refresh_from_disk()
        items = sorted(
            (item for item in self._latest.values() if item.risk_score >= MIN_DURABLE_INCIDENT_SCORE),
            key=lambda item: item.updated_at,
            reverse=True,
        )
        return items[: max(1, min(1000, int(limit)))]

    def get(self, incident_id: str) -> Incident | None:
        self._refresh_from_disk()
        return self._latest.get(str(incident_id))

    def update_status(self, incident_id: str, status: str, *, reason: str) -> Incident:
        incident = self.get(incident_id)
        if incident is None:
            raise ValueError("Unknown incident")
        normalized = _incident_status(status)
        if normalized not in {"acknowledged", "resolved", "dismissed"}:
            raise ValueError("Incident status transition is not user-settable")
        updated = replace(
            incident,
            status=normalized,
            updated_at=utc_now(),
            decision_required=(
                False if normalized in {"resolved", "dismissed"}
                else incident.decision_required
            ),
            resolution={
                "status": normalized,
                "reason": str(reason or "User updated incident status")[:500],
                "source": "explicit_user_confirmation",
                "updated_at": utc_now(),
            },
        )
        self.append(updated)
        return updated

    def open_by_correlation(self, correlation_key: str) -> Incident | None:
        self._refresh_from_disk()
        candidates = [
            item
            for item in self._latest.values()
            if item.correlation_key == correlation_key and item.status in {"open", "acknowledged", "contained"}
        ]
        return max(candidates, key=lambda item: item.updated_at) if candidates else None

    def summary(self) -> dict[str, Any]:
        self._refresh_from_disk()
        items = [
            item for item in self._latest.values()
            if item.risk_score >= MIN_DURABLE_INCIDENT_SCORE
        ]
        open_items = [item for item in items if item.status in {"open", "acknowledged", "contained"}]
        return {
            "path": str(self.path),
            "total": len(items),
            "open": len(open_items),
            "decision_required": sum(1 for item in open_items if item.decision_required),
            "emergency": sum(1 for item in open_items if item.risk_level == "emergency"),
            "highest_risk": max((item.risk_score for item in open_items), default=0),
            "last_updated_at": max((item.updated_at for item in items), default=None),
            "journal_bytes": self.path.stat().st_size if self.path.exists() else 0,
            "archive_count": len(self._archive_paths()),
            "retention_max_bytes": self.max_bytes,
            "retention_max_archives": self.max_archives,
        }

    def _refresh_from_disk(self) -> None:
        signature = self._signature()
        if signature == self._file_signature:
            return
        if signature == (0, 0):
            self._latest = {}
            self._last_hash = GENESIS_HASH
            self._file_signature = signature
            return
        with FileLock(self.path):
            latest, last_hash = self._read_all()
            signature = self._signature()
        self._latest = latest
        self._last_hash = last_hash
        self._file_signature = signature

    def _signature(self) -> tuple[int, int]:
        try:
            file_stat = self.path.stat()
            return file_stat.st_size, file_stat.st_mtime_ns
        except FileNotFoundError:
            return 0, 0

    def retention_integrity(self) -> dict[str, Any]:
        archives = []
        for archive in self._archive_paths():
            result = verify_audit_log(archive, self.integrity_key_path)
            archives.append({"path": str(archive), **result})
        ledger = verify_audit_log(self.retention_log_path, self.integrity_key_path)
        return {
            "ok": ledger.get("ok") is True and all(item.get("ok") is True for item in archives),
            "archives": archives,
            "retention_ledger": ledger,
        }

    def _compact_if_needed(self) -> None:
        if not self.path.exists() or not self._retention_limit_exceeded(self._latest):
            return
        with FileLock(self.path):
            latest, last_hash = self._read_all()
            if not self._retention_limit_exceeded(latest):
                return
            retained = {
                incident_id: incident
                for incident_id, incident in latest.items()
                if incident.risk_score >= MIN_DURABLE_INCIDENT_SCORE
            }
            if self._is_minimal_compacted(len(retained)):
                return
            source_bytes = self.path.read_bytes()
            source_sha256 = hashlib.sha256(source_bytes).hexdigest()
            self.archive_dir.mkdir(parents=True, exist_ok=True)
            archive = self.archive_dir / f"incidents-{time.time_ns()}-{uuid.uuid4().hex[:8]}.jsonl"
            shutil.copy2(self.path, archive)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != source_sha256:
                archive.unlink(missing_ok=True)
                raise IncidentStoreIntegrityError("Incident archive copy verification failed")
            temporary = self.path.with_name(f"{self.path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
            previous = GENESIS_HASH
            records: list[dict[str, Any]] = [{
                "kind": "incident.compaction",
                "timestamp": utc_now(),
                "archive_name": archive.name,
                "archive_sha256": source_sha256,
                "archive_last_hash": last_hash,
                "latest_incidents": len(retained),
                "pruned_low_score_snapshots": len(latest) - len(retained),
            }]
            records.extend({
                "kind": "incident.snapshot",
                "timestamp": utc_now(),
                "incident": incident.to_dict(),
                "compacted": True,
            } for incident in sorted(retained.values(), key=lambda item: item.incident_id))
            try:
                with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                    for record in records:
                        integrity = audit_record_integrity(record, self._key, previous)
                        record[INTEGRITY_FIELD] = integrity
                        handle.write(json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n")
                        previous = integrity["record_hash"]
                    handle.flush()
                    os.fsync(handle.fileno())
                for attempt in range(100):
                    try:
                        os.replace(temporary, self.path)
                        break
                    except PermissionError:
                        if attempt == 99:
                            raise
                        time.sleep(0.05)
            finally:
                temporary.unlink(missing_ok=True)
            self._latest, self._last_hash = self._read_all()
            self._file_signature = self._signature()
            self._prune_archives()

    def _archive_paths(self) -> list[Path]:
        if not self.archive_dir.exists():
            return []
        return sorted(self.archive_dir.glob("incidents-*.jsonl"), key=lambda item: item.name)

    def _retention_limit_exceeded(self, latest: dict[str, Incident]) -> bool:
        over_bytes = self.max_bytes > 0 and self.path.stat().st_size > self.max_bytes
        over_incidents = self.max_live_incidents > 0 and len(latest) > self.max_live_incidents
        return over_bytes or over_incidents

    def _is_minimal_compacted(self, latest_count: int) -> bool:
        try:
            records = [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines() if line.strip()]
        except (OSError, json.JSONDecodeError):
            return False
        return bool(
            records
            and records[0].get("kind") == "incident.compaction"
            and len(records) <= latest_count + 1
        )

    def _prune_archives(self) -> None:
        archives = self._archive_paths()
        for archive in archives[: max(0, len(archives) - self.max_archives)]:
            raw = archive.read_bytes()
            AuditLog(
                self.retention_log_path,
                max_bytes=0,
                stdout=False,
                integrity_key_path=self.integrity_key_path,
            ).write("incident.archive_pruned", {
                "archive_name": archive.name,
                "archive_sha256": hashlib.sha256(raw).hexdigest(),
                "archive_bytes": len(raw),
                "reason": "bounded_retention",
            })
            archive.unlink()

    def _read_all(self) -> tuple[dict[str, Incident], str]:
        if not self.path.exists():
            return {}, GENESIS_HASH
        latest: dict[str, Incident] = {}
        previous = GENESIS_HASH
        with self.path.open("r", encoding="utf-8", errors="strict") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise IncidentStoreIntegrityError(
                        f"Incident store line {line_number} is invalid JSON: {exc}"
                    ) from exc
                if not isinstance(record, dict):
                    raise IncidentStoreIntegrityError(
                        f"Incident store line {line_number} is not an object"
                    )
                integrity = record.get(INTEGRITY_FIELD)
                if not isinstance(integrity, dict):
                    raise IncidentStoreIntegrityError(
                        f"Incident store line {line_number} has no integrity metadata"
                    )
                expected = audit_record_integrity(record, self._key, previous)
                if integrity.get("previous_hash") != previous:
                    raise IncidentStoreIntegrityError(
                        f"Incident store line {line_number} previous hash mismatch"
                    )
                if integrity.get("record_hash") != expected["record_hash"]:
                    raise IncidentStoreIntegrityError(
                        f"Incident store line {line_number} record hash mismatch"
                    )
                payload = record.get("incident")
                if isinstance(payload, dict):
                    incident = Incident.from_dict(payload)
                    latest[incident.incident_id] = incident
                previous = expected["record_hash"]
        return latest, previous


def read_incident_summary(
    path: Path,
    integrity_key_path: Path,
    *,
    max_bytes: int = 0,
    max_archives: int = 8,
    max_live_incidents: int = 0,
) -> dict[str, Any]:
    if not path.exists():
        return {
            "path": str(path),
            "total": 0,
            "open": 0,
            "decision_required": 0,
            "emergency": 0,
            "highest_risk": 0,
            "last_updated_at": None,
            "integrity_ok": True,
            "integrity_error": None,
        }
    if not integrity_key_path.exists():
        return {
            "path": str(path),
            "total": 0,
            "open": 0,
            "decision_required": 0,
            "emergency": 0,
            "highest_risk": 0,
            "last_updated_at": None,
            "integrity_ok": False,
            "integrity_error": "integrity key missing",
        }
    try:
        summary = IncidentStore(
            path,
            integrity_key_path,
            max_bytes=max_bytes,
            max_archives=max_archives,
            max_live_incidents=max_live_incidents,
        ).summary()
        return {**summary, "integrity_ok": True, "integrity_error": None}
    except (IncidentStoreIntegrityError, OSError, UnicodeError) as exc:
        return {
            "path": str(path),
            "total": 0,
            "open": 0,
            "decision_required": 0,
            "emergency": 0,
            "highest_risk": 0,
            "last_updated_at": None,
            "integrity_ok": False,
            "integrity_error": str(exc),
        }


class IncidentCorrelator:
    def __init__(self, store: IncidentStore, max_evidence: int = 64) -> None:
        self.store = store
        self.max_evidence = max(4, min(256, int(max_evidence)))
        self._pending: dict[str, list[IncidentEvidence]] = {}

    def observe(self, assessment: RuleAssessment, decision: ActionDecision) -> Incident | None:
        new_evidence = IncidentEvidence.from_assessment(assessment)
        key = correlation_key(assessment)
        existing = self.store.open_by_correlation(key)
        evidence = list(existing.evidence if existing else self._pending.get(key, ()))
        if not any(item.event_id == new_evidence.event_id for item in evidence):
            evidence.append(new_evidence)
        evidence = evidence[-self.max_evidence :]
        score, emergency_eligible = calculate_incident_risk(evidence)
        if existing is None and score < MIN_DURABLE_INCIDENT_SCORE:
            self._pending[key] = evidence
            while len(self._pending) > 512:
                self._pending.pop(next(iter(self._pending)))
            return None
        self._pending.pop(key, None)
        now = utc_now()
        incident = Incident(
            incident_id=(existing.incident_id if existing else str(uuid.uuid4())),
            correlation_key=key,
            status=(existing.status if existing else "open"),
            title=incident_title(evidence),
            primary_subject=assessment.event.subject,
            created_at=(existing.created_at if existing else now),
            updated_at=now,
            risk_score=score,
            risk_level=risk_level(score),
            evidence=tuple(evidence),
            evidence_families=tuple(sorted({item.family for item in evidence})),
            decision_required=score >= 250,
            emergency_eligible=emergency_eligible,
            recommended_actions=recommended_actions(evidence, score),
            current_decision=decision.to_dict(),
        )
        self.store.append(incident)
        return incident


def calculate_incident_risk(evidence: list[IncidentEvidence]) -> tuple[int, bool]:
    deterministic = [item for item in evidence if item.deterministic]
    if not deterministic:
        return 0, False
    family_scores: dict[str, int] = {}
    for item in deterministic:
        family_scores[item.family] = max(family_scores.get(item.family, 0), item.event_score)
    ordered = sorted(family_scores.values(), reverse=True)
    primary = min(400, ordered[0] * 4)
    corroboration = sum(min(140, score * 2) for score in ordered[1:3] if score >= 35)
    high_families = sum(1 for score in family_scores.values() if score >= 65)
    multi_high_bonus = 160 if high_families >= 2 else 0
    trusted_malicious = any(item.trusted_malicious for item in deterministic)
    harmful_behavior = any(item.harmful_behavior for item in deterministic)
    trusted_chain_bonus = 320 if trusted_malicious and harmful_behavior else 0
    score = min(800, primary + corroboration + multi_high_bonus + trusted_chain_bonus)
    emergency_eligible = high_families >= 2 or (trusted_malicious and harmful_behavior)
    if not emergency_eligible:
        score = min(score, 699)
    return score, emergency_eligible


def risk_level(score: int) -> RiskLevel:
    bounded = max(0, min(800, int(score)))
    if bounded >= 700:
        return "emergency"
    if bounded >= 550:
        return "critical"
    if bounded >= 400:
        return "high"
    if bounded >= 250:
        return "suspicious"
    if bounded >= 100:
        return "guarded"
    if bounded > 0:
        return "informational"
    return "clean"


def event_family(kind: str) -> str:
    prefix = kind.split(".", 1)[0].strip().lower()
    return {
        "file": "file",
        "process": "process",
        "network": "network",
        "persistence": "persistence",
        "security": "posture",
        "device": "device",
        "software": "software",
    }.get(prefix, "other")


def correlation_key(assessment: RuleAssessment) -> str:
    event = assessment.event
    facts = event.facts
    for key in ("owning_process", "pid", "process_id"):
        value = facts.get(key)
        if str(value or "").isdigit() and int(value) > 0:
            process_start = facts.get("process_start_time")
            if process_start is None:
                process_start = facts.get("create_time")
            try:
                normalized_start = f"{float(process_start):.3f}"
            except (TypeError, ValueError):
                normalized_start = ""
            if normalized_start:
                return f"process:{int(value)}:{normalized_start}"
            return f"process:{int(value)}"
    path_value = facts.get("path") or facts.get("exe")
    if isinstance(path_value, str) and path_value.strip():
        return "path:" + os.path.normcase(os.path.abspath(path_value.strip()))
    return f"{event_family(event.kind)}:{event.subject.strip().lower()}"


def incident_title(evidence: list[IncidentEvidence]) -> str:
    families = {item.family for item in evidence}
    if {"process", "network"}.issubset(families):
        return "Suspicious process with network activity"
    if {"file", "persistence"}.issubset(families):
        return "Suspicious file established persistence"
    latest = evidence[-1]
    return {
        "file": "Suspicious file detected",
        "process": "Suspicious process detected",
        "network": "Suspicious network activity",
        "persistence": "Unexpected persistence change",
        "posture": "Security protection changed",
        "device": "Untrusted device connected",
        "software": "New software requires review",
    }.get(latest.family, "Security activity requires review")


def recommended_actions(evidence: list[IncidentEvidence], score: int) -> tuple[str, ...]:
    families = {item.family for item in evidence}
    actions = ["preserve"]
    if "file" in families:
        actions.append("deep_scan")
        if score >= 250:
            actions.append("isolate")
    if "network" in families and score >= 400:
        actions.append("block_network")
    if "process" in families and score >= 550:
        actions.append("suspend_process")
    return tuple(dict.fromkeys(actions))


def build_attack_chain(evidence: tuple[IncidentEvidence, ...] | list[IncidentEvidence]) -> dict[str, Any]:
    """Derive a bounded, non-causal graph from deterministic shared entities."""
    ordered = sorted(list(evidence)[-12:], key=lambda item: (item.observed_at, item.evidence_id))
    nodes = [
        {
            "id": item.evidence_id,
            "family": item.family,
            "kind": item.kind,
            "label": item.subject[:240],
            "observed_at": item.observed_at,
            "score": item.event_score,
            "deterministic": item.deterministic,
            "trusted_malicious": item.trusted_malicious,
            "harmful_behavior": item.harmful_behavior,
        }
        for item in ordered
    ]
    edges: list[dict[str, str]] = []
    for target_index, target in enumerate(ordered):
        if not target.deterministic:
            continue
        target_entities = _evidence_entities(target)
        for source in ordered[:target_index]:
            if not source.deterministic:
                continue
            shared = sorted(_evidence_entities(source) & target_entities)
            if not shared:
                continue
            token = shared[0]
            relation = {
                "pid": "shared_process",
                "path": "shared_file",
                "endpoint": "shared_endpoint",
            }.get(token.split(":", 1)[0], "shared_entity")
            edges.append({
                "from": source.evidence_id,
                "to": target.evidence_id,
                "relation": relation,
                "entity_sha256": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            })
            if len(edges) >= 24:
                break
        if len(edges) >= 24:
            break
    connected_ids = {edge[key] for edge in edges for key in ("from", "to")}
    connected_families = sorted({item.family for item in ordered if item.evidence_id in connected_ids})
    return {
        "derived": True,
        "affects_risk_score": False,
        "nodes": nodes,
        "edges": edges,
        "connected_families": connected_families,
        "corroborated": len(connected_families) >= 2,
        "source_evidence_count": len(evidence),
    }


def _evidence_entities(evidence: IncidentEvidence) -> set[str]:
    scope = evidence.response_scope
    entities: set[str] = set()
    path = scope.get("path")
    if isinstance(path, str) and path.strip():
        entities.add("path:" + os.path.normcase(os.path.abspath(path.strip())))
    for key in ("pid", "owning_process"):
        value = scope.get(key)
        if str(value or "").isdigit() and int(value) > 0:
            entities.add(f"pid:{int(value)}")
    address = scope.get("remote_address")
    port = scope.get("remote_port")
    if isinstance(address, str) and address.strip():
        entities.add(f"endpoint:{address.strip().lower()}:{port or '*'}")
    return entities


def _trusted_malicious(source: str, facts: dict[str, Any]) -> bool:
    if source != "deep_file_scanner":
        return False
    if facts.get("virustotal_malicious") is True:
        return True
    defender = facts.get("defender_scan")
    return isinstance(defender, dict) and str(defender.get("status") or "").lower() in {
        "detected",
        "threat_found",
        "malicious",
    }


def _harmful_behavior(facts: dict[str, Any]) -> bool:
    return any(
        facts.get(key) is True
        for key in (
            "ransomware_behavior",
            "remote_control_behavior",
            "credential_theft_behavior",
            "destructive_behavior",
        )
    )


def _incident_status(value: Any) -> IncidentStatus:
    normalized = str(value or "open").strip().lower()
    if normalized in {"open", "acknowledged", "contained", "resolved", "dismissed"}:
        return normalized  # type: ignore[return-value]
    return "open"


def _bounded_scope(scope: dict[str, Any], *, allow_empty: bool = False) -> dict[str, Any]:
    allowed = {
        "path", "pid", "owning_process", "process_start_time", "remote_address", "remote_port",
        "protocol", "direction", "rule_id",
    }
    bounded: dict[str, Any] = {}
    for key, value in scope.items():
        if key not in allowed or value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            bounded[key] = value if not isinstance(value, str) else value[:1024]
    if not bounded and not allow_empty:
        raise ValueError("Response proposal scope has no supported target")
    return bounded


def _response_scope(facts: dict[str, Any]) -> dict[str, Any]:
    process_start_time = facts.get("process_start_time")
    if process_start_time is None:
        process_start_time = facts.get("create_time")
    candidate = {
        key: facts.get(key)
        for key in (
            "path", "pid", "owning_process", "remote_address", "remote_port",
            "protocol", "direction",
        )
        if facts.get(key) is not None
    }
    if process_start_time is not None:
        candidate["process_start_time"] = process_start_time
    return _bounded_scope(candidate, allow_empty=True)
