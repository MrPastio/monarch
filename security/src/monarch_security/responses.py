from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
import json
import os
import ipaddress

from .events import utc_now
from .incidents import Incident, IncidentStore, ResponseProposal
from .integrity import GENESIS_HASH, INTEGRITY_FIELD, audit_record_integrity, get_or_create_key
from .state import FileLock


ProposalStatus = Literal["proposed", "approved", "rejected", "expired"]


class ResponseBrokerError(RuntimeError):
    pass


class ResponseStoreIntegrityError(ResponseBrokerError):
    pass


@dataclass(frozen=True)
class StoredProposal:
    proposal: ResponseProposal
    status: ProposalStatus
    status_reason: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "proposal": self.proposal.to_dict(),
            "status": self.status,
            "status_reason": self.status_reason,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "StoredProposal":
        status = str(payload.get("status") or "proposed")
        if status not in {"proposed", "approved", "rejected", "expired"}:
            raise ResponseStoreIntegrityError(f"Unsupported response proposal status: {status}")
        proposal_payload = payload.get("proposal")
        if not isinstance(proposal_payload, dict):
            raise ResponseStoreIntegrityError("Response proposal payload is missing")
        return cls(
            proposal=ResponseProposal.from_dict(proposal_payload),
            status=status,  # type: ignore[arg-type]
            status_reason=str(payload.get("status_reason") or ""),
            updated_at=str(payload.get("updated_at") or utc_now()),
        )


class ResponseProposalStore:
    def __init__(self, path: Path, integrity_key_path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._key = get_or_create_key(integrity_key_path)
        self._latest, self._last_hash = self._read_all()

    def append(self, stored: StoredProposal) -> None:
        with FileLock(self.path):
            latest, last_hash = self._read_all()
            payload: dict[str, Any] = {
                "kind": "response.proposal",
                "timestamp": utc_now(),
                "stored_proposal": stored.to_dict(),
            }
            integrity = audit_record_integrity(payload, self._key, last_hash)
            payload[INTEGRITY_FIELD] = integrity
            line = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
            latest[stored.proposal.proposal_id] = stored
            self._latest = latest
            self._last_hash = integrity["record_hash"]

    def get(self, proposal_id: str) -> StoredProposal | None:
        return self._latest.get(str(proposal_id))

    def list_latest(self, limit: int = 100) -> list[StoredProposal]:
        items = sorted(self._latest.values(), key=lambda item: item.updated_at, reverse=True)
        return items[: max(1, min(1000, int(limit)))]

    def _read_all(self) -> tuple[dict[str, StoredProposal], str]:
        if not self.path.exists():
            return {}, GENESIS_HASH
        latest: dict[str, StoredProposal] = {}
        previous = GENESIS_HASH
        with self.path.open("r", encoding="utf-8", errors="strict") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ResponseStoreIntegrityError(
                        f"Response proposal line {line_number} is invalid JSON"
                    ) from exc
                if not isinstance(payload, dict) or not isinstance(payload.get(INTEGRITY_FIELD), dict):
                    raise ResponseStoreIntegrityError(
                        f"Response proposal line {line_number} has no integrity metadata"
                    )
                expected = audit_record_integrity(payload, self._key, previous)
                integrity = payload[INTEGRITY_FIELD]
                if integrity.get("previous_hash") != previous or integrity.get("record_hash") != expected["record_hash"]:
                    raise ResponseStoreIntegrityError(
                        f"Response proposal line {line_number} integrity mismatch"
                    )
                stored_payload = payload.get("stored_proposal")
                if isinstance(stored_payload, dict):
                    stored = StoredProposal.from_dict(stored_payload)
                    latest[stored.proposal.proposal_id] = stored
                previous = expected["record_hash"]
        return latest, previous


class ShadowResponseBroker:
    """Validates bounded response proposals but never executes system changes."""

    def __init__(self, incidents: IncidentStore, proposals: ResponseProposalStore) -> None:
        self.incidents = incidents
        self.proposals = proposals

    def propose(
        self,
        *,
        incident_id: str,
        action: str,
        scope: dict[str, Any],
        rationale: list[str] | tuple[str, ...],
        proposed_by: Literal["rules", "llm", "user"],
        ttl_seconds: int = 300,
    ) -> StoredProposal:
        incident = self.incidents.get(incident_id)
        if incident is None or incident.status not in {"open", "acknowledged", "contained"}:
            raise ResponseBrokerError("Response proposal requires an active incident")
        if action.strip().lower() == "block_network":
            _validate_network_scope(scope)
        expiry = datetime.now(timezone.utc) + timedelta(seconds=max(30, min(3600, int(ttl_seconds))))
        proposal = ResponseProposal.create(
            incident_id=incident.incident_id,
            action=action,
            scope=scope,
            rationale=rationale,
            proposed_by=proposed_by,
            expires_at=expiry.isoformat(),
        )
        _validate_against_incident(proposal, incident)
        stored = StoredProposal(
            proposal=proposal,
            status="proposed",
            status_reason="Validated in shadow mode; no system action executed",
            updated_at=utc_now(),
        )
        self.proposals.append(stored)
        return stored

    def evaluate(self, proposal_id: str) -> dict[str, Any]:
        stored = self.proposals.get(proposal_id)
        if stored is None:
            raise ResponseBrokerError("Unknown response proposal")
        if _is_expired(stored.proposal.expires_at):
            expired = StoredProposal(
                proposal=stored.proposal,
                status="expired",
                status_reason="Proposal TTL expired before approval",
                updated_at=utc_now(),
            )
            self.proposals.append(expired)
            stored = expired
        return {
            "proposal_id": stored.proposal.proposal_id,
            "status": stored.status,
            "authorized": False,
            "executed": False,
            "mode": "shadow",
            "reason": stored.status_reason,
            "requires_user_confirmation": stored.proposal.requires_user_confirmation,
            "requires_security_pin": stored.proposal.requires_security_pin,
        }


def _validate_against_incident(proposal: ResponseProposal, incident: Incident) -> None:
    action = proposal.action
    families = set(incident.evidence_families)
    if action in {"isolate", "delete"}:
        if "file" not in families or "path" not in proposal.scope:
            raise ResponseBrokerError("File response requires file evidence and a bounded path")
        if not _scope_matches_evidence(proposal.scope, incident, ("path",)):
            raise ResponseBrokerError("File response scope does not match incident evidence")
    if action == "block_network":
        if "network" not in families or incident.risk_score < 400:
            raise ResponseBrokerError("Network containment requires network evidence and risk >= 400")
        _validate_network_scope(proposal.scope)
        if not _scope_matches_evidence(proposal.scope, incident, ("remote_address", "remote_port")):
            raise ResponseBrokerError("Network containment scope does not match incident evidence")
    if action in {"suspend_process", "terminate_process"}:
        if "process" not in families or incident.risk_score < 550 or "pid" not in proposal.scope:
            raise ResponseBrokerError("Process containment requires process evidence, pid, and risk >= 550")
        if not _scope_matches_evidence(proposal.scope, incident, ("pid",)):
            raise ResponseBrokerError("Process containment scope does not match incident evidence")
    if action in {"delete", "terminate_process"} and not incident.emergency_eligible:
        raise ResponseBrokerError("Destructive response requires an emergency-eligible incident")
    if action not in incident.recommended_actions and action not in {"preserve", "delete", "terminate_process"}:
        raise ResponseBrokerError("Action is not supported by current incident evidence")


def _is_expired(value: str | None) -> bool:
    if not value:
        return False
    try:
        expiry = datetime.fromisoformat(value)
    except ValueError:
        return True
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    return expiry <= datetime.now(timezone.utc)


def _validate_network_scope(scope: dict[str, Any]) -> None:
    allowed = {"remote_address", "remote_port", "protocol", "direction"}
    if not scope or set(scope) - allowed:
        raise ResponseBrokerError("Network containment scope is not bounded")
    address = str(scope.get("remote_address") or "").strip()
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError as exc:
        raise ResponseBrokerError("Network containment requires one valid remote address") from exc
    if parsed.is_unspecified or parsed.is_multicast:
        raise ResponseBrokerError("Network containment target is not a valid remote host")
    port = scope.get("remote_port")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ResponseBrokerError("Network containment requires one valid remote port")
    protocol = str(scope.get("protocol") or "tcp").lower()
    if protocol not in {"tcp", "udp"}:
        raise ResponseBrokerError("Network containment protocol must be tcp or udp")
    direction = str(scope.get("direction") or "outbound").lower()
    if direction not in {"inbound", "outbound"}:
        raise ResponseBrokerError("Network containment direction must be inbound or outbound")


def _scope_matches_evidence(scope: dict[str, Any], incident: Incident, keys: tuple[str, ...]) -> bool:
    for evidence in incident.evidence:
        evidence_scope = evidence.response_scope
        if all(str(evidence_scope.get(key)) == str(scope.get(key)) for key in keys):
            return True
    return False
