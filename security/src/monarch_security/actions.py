from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
import ctypes
import base64
import json
import os
import re
import secrets
import subprocess
import sys
import time
from multiprocessing.connection import Client, Listener

from .events import utc_now
from .incidents import Incident, IncidentStore, ResponseProposal
from .integrity import (
    GENESIS_HASH,
    INTEGRITY_FIELD,
    audit_record_integrity,
    get_or_create_key,
    sign_payload,
    verify_payload,
)
from .pin import SecurityPinManager
from .responses import (
    ResponseBrokerError,
    ResponseProposalStore,
    StoredProposal,
    _is_expired,
    _validate_network_scope,
)
from .state import FileLock, StateStore


ACTION_STATES = {"pending", "active", "rolled_back", "failed"}
RESPONSE_EXECUTOR_TASK = "MonarchSecurityResponseExecutor"
RESPONSE_EXECUTOR_PIPE = r"\\.\pipe\MonarchSecurityResponseExecutor"
RESPONSE_EXECUTOR_AUTH = b"monarch-security-response-v1"
RESPONSE_RUNTIME_DIGEST_PATTERN = re.compile(r"^[a-f0-9]{64}$")
RESPONSE_EXECUTOR_ENVIRONMENT = (
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "MONARCH_DATA_ROOT",
    "MONARCH_LOGS_ROOT",
    "MONARCH_MODELS_ROOT",
    "MONARCH_PAYLOAD_ROOT",
    "MONARCH_SAFE_ROOT",
    "MONARCH_SECURITY_DATA_ROOT",
    "MONARCH_SECURITY_LOGS_ROOT",
    "MONARCH_SECURITY_PROTECTED_ROOTS",
    "MONARCH_WORKSPACE_ROOT",
)


class ResponseActionError(RuntimeError):
    pass


class ResponseGrantError(ResponseActionError):
    pass


@dataclass(frozen=True)
class ResponseRuntimeLayout:
    attested_roots: tuple[Path, ...]
    import_roots: tuple[Path, ...]


@dataclass(frozen=True)
class ResponseGrant:
    grant_id: str
    proposal_id: str
    incident_id: str
    action: str
    scope: dict[str, Any]
    issued_at: str
    consume_by: str
    action_expires_at: str

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ResponseGrant":
        return cls(
            grant_id=str(payload.get("grant_id") or ""),
            proposal_id=str(payload.get("proposal_id") or ""),
            incident_id=str(payload.get("incident_id") or ""),
            action=str(payload.get("action") or ""),
            scope=dict(payload.get("scope") or {}),
            issued_at=str(payload.get("issued_at") or ""),
            consume_by=str(payload.get("consume_by") or ""),
            action_expires_at=str(payload.get("action_expires_at") or ""),
        )


@dataclass(frozen=True)
class ResponseActionRecord:
    action_id: str
    grant_id: str
    proposal_id: str
    incident_id: str
    action: str
    scope: dict[str, Any]
    status: str
    rule_name: str
    expires_at: str
    updated_at: str
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ResponseActionRecord":
        status = str(payload.get("status") or "failed")
        if status not in ACTION_STATES:
            raise ResponseActionError(f"Unsupported response action status: {status}")
        return cls(
            action_id=str(payload.get("action_id") or ""),
            grant_id=str(payload.get("grant_id") or ""),
            proposal_id=str(payload.get("proposal_id") or ""),
            incident_id=str(payload.get("incident_id") or ""),
            action=str(payload.get("action") or ""),
            scope=dict(payload.get("scope") or {}),
            status=status,
            rule_name=str(payload.get("rule_name") or ""),
            expires_at=str(payload.get("expires_at") or ""),
            updated_at=str(payload.get("updated_at") or utc_now()),
            reason=str(payload.get("reason") or ""),
        )


class ResponseActionStore:
    def __init__(self, path: Path, integrity_key_path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._key = get_or_create_key(integrity_key_path)
        self._latest, self._last_hash = self._read_all()

    def append(self, action: ResponseActionRecord) -> None:
        with FileLock(self.path):
            latest, previous = self._read_all()
            record: dict[str, Any] = {
                "kind": "response.action",
                "timestamp": utc_now(),
                "action": action.to_dict(),
            }
            record[INTEGRITY_FIELD] = audit_record_integrity(record, self._key, previous)
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n")
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
            latest[action.action_id] = action
            self._latest = latest
            self._last_hash = record[INTEGRITY_FIELD]["record_hash"]

    def get(self, action_id: str) -> ResponseActionRecord | None:
        return self._latest.get(action_id)

    def list_latest(self) -> list[ResponseActionRecord]:
        return sorted(self._latest.values(), key=lambda item: item.updated_at, reverse=True)

    def _read_all(self) -> tuple[dict[str, ResponseActionRecord], str]:
        if not self.path.exists():
            return {}, GENESIS_HASH
        latest: dict[str, ResponseActionRecord] = {}
        previous = GENESIS_HASH
        with self.path.open("r", encoding="utf-8", errors="strict") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ResponseActionError(f"Response action line {line_number} is invalid JSON") from exc
                if not isinstance(record, dict) or not isinstance(record.get(INTEGRITY_FIELD), dict):
                    raise ResponseActionError(f"Response action line {line_number} has no integrity metadata")
                expected = audit_record_integrity(record, self._key, previous)
                integrity = record[INTEGRITY_FIELD]
                if integrity.get("previous_hash") != previous or integrity.get("record_hash") != expected["record_hash"]:
                    raise ResponseActionError(f"Response action line {line_number} integrity mismatch")
                payload = record.get("action")
                if isinstance(payload, dict):
                    item = ResponseActionRecord.from_dict(payload)
                    latest[item.action_id] = item
                previous = expected["record_hash"]
        return latest, previous


class ResponseApprovalBroker:
    def __init__(
        self,
        proposals: ResponseProposalStore,
        pin: SecurityPinManager,
        *,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self.proposals = proposals
        self.pin = pin
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    def authorize(self, proposal_id: str, pin_value: str) -> ResponseGrant:
        stored = self.proposals.get(proposal_id)
        if stored is None or stored.status != "proposed":
            raise ResponseBrokerError("Approval requires one active proposed response")
        proposal = stored.proposal
        if _is_expired(proposal.expires_at):
            raise ResponseBrokerError("Response proposal expired before approval")
        if proposal.action != "block_network":
            raise ResponseBrokerError("This executor currently allows only block_network")
        _validate_network_scope(proposal.scope)
        verification = self.pin.verify(pin_value)
        if not verification.ok:
            raise ResponseBrokerError(verification.reason)
        now = self.now_fn()
        proposal_expiry = _parse_datetime(proposal.expires_at)
        if proposal_expiry is None:
            raise ResponseBrokerError("Executable response proposal requires an expiry")
        scope = dict(proposal.scope)
        scope.setdefault("protocol", "tcp")
        scope.setdefault("direction", "outbound")
        grant = ResponseGrant(
            grant_id=secrets.token_hex(24),
            proposal_id=proposal.proposal_id,
            incident_id=proposal.incident_id,
            action=proposal.action,
            scope=scope,
            issued_at=now.isoformat(),
            consume_by=(now + timedelta(seconds=90)).isoformat(),
            action_expires_at=proposal_expiry.isoformat(),
        )
        try:
            self.proposals.append(StoredProposal(
                proposal=proposal,
                status="approved",
                status_reason=f"One-time grant {grant.grant_id} issued after Security PIN verification",
                updated_at=utc_now(),
            ))
        except Exception:
            raise
        return grant


class FirewallContainmentService:
    def __init__(
        self,
        actions: ResponseActionStore,
        state: StateStore,
        integrity_key_path: Path,
        *,
        command_runner: Callable[[list[str]], None] | None = None,
        require_elevated: bool = True,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self.actions = actions
        self.state = state
        self._key = get_or_create_key(integrity_key_path)
        self.command_runner = command_runner or _run_powershell
        self.require_elevated = require_elevated
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    def apply_verified_grant(self, grant: ResponseGrant) -> ResponseActionRecord:
        if self.require_elevated and not _is_elevated():
            raise ResponseActionError("Firewall response executor requires an elevated Windows service context")
        now = self.now_fn()
        consume_by = _parse_datetime(grant.consume_by)
        action_expiry = _parse_datetime(grant.action_expires_at)
        if consume_by is None or consume_by <= now:
            raise ResponseGrantError("Response grant expired before consumption")
        if action_expiry is None or action_expiry <= now:
            raise ResponseGrantError("Response action already expired")
        if grant.action != "block_network":
            raise ResponseGrantError("Response grant action is not allowlisted")
        _validate_network_scope(grant.scope)
        consumed = self.state.get_dict("consumed_response_grants")
        if grant.grant_id in consumed:
            raise ResponseGrantError("Response grant replay rejected")
        consumed[grant.grant_id] = now.isoformat()
        self.state.set_dict("consumed_response_grants", _prune_consumed(consumed, now))

        action_id = secrets.token_hex(16)
        rule_name = f"MonarchSecurity-{action_id}"
        pending = ResponseActionRecord(
            action_id=action_id,
            grant_id=grant.grant_id,
            proposal_id=grant.proposal_id,
            incident_id=grant.incident_id,
            action=grant.action,
            scope=dict(grant.scope),
            status="pending",
            rule_name=rule_name,
            expires_at=grant.action_expires_at,
            updated_at=utc_now(),
        )
        self.actions.append(pending)
        try:
            self.command_runner(_firewall_add_args(rule_name, grant.scope, grant.action_expires_at))
        except Exception as exc:
            failed = ResponseActionRecord(**{
                **pending.__dict__,
                "status": "failed",
                "updated_at": utc_now(),
                "reason": f"{type(exc).__name__}: {exc}",
            })
            self.actions.append(failed)
            raise ResponseActionError("Firewall containment failed") from exc
        active = ResponseActionRecord(**{
            **pending.__dict__,
            "status": "active",
            "updated_at": utc_now(),
            "reason": "Expiring firewall containment active",
        })
        self.actions.append(active)
        return active

    def reconcile(self) -> list[ResponseActionRecord]:
        if self.require_elevated and not _is_elevated():
            raise ResponseActionError("Firewall response executor requires an elevated Windows service context")
        now = self.now_fn()
        rolled_back: list[ResponseActionRecord] = []
        for current in self.actions.list_latest():
            expiry = _parse_datetime(current.expires_at)
            should_remove = current.status == "pending" or (
                current.status == "active" and (expiry is None or expiry <= now)
            )
            if not should_remove:
                continue
            try:
                self.command_runner(_firewall_remove_args(current.rule_name))
                rolled = ResponseActionRecord(**{
                    **current.__dict__,
                    "status": "rolled_back",
                    "updated_at": utc_now(),
                    "reason": "Expired or interrupted containment rolled back",
                })
            except Exception as exc:
                rolled = ResponseActionRecord(**{
                    **current.__dict__,
                    "status": "failed",
                    "updated_at": utc_now(),
                    "reason": f"Rollback failed: {type(exc).__name__}: {exc}",
                })
            self.actions.append(rolled)
            rolled_back.append(rolled)
        return rolled_back

    def rollback_all(self) -> list[ResponseActionRecord]:
        if self.require_elevated and not _is_elevated():
            raise ResponseActionError("Firewall response executor requires an elevated Windows service context")
        rolled_back: list[ResponseActionRecord] = []
        for current in self.actions.list_latest():
            if current.status not in {"pending", "active"}:
                continue
            try:
                self.command_runner(_firewall_remove_args(current.rule_name))
                rolled = ResponseActionRecord(**{
                    **current.__dict__,
                    "status": "rolled_back",
                    "updated_at": utc_now(),
                    "reason": "Containment rolled back during executor shutdown",
                })
            except Exception as exc:
                rolled = ResponseActionRecord(**{
                    **current.__dict__,
                    "status": "failed",
                    "updated_at": utc_now(),
                    "reason": f"Shutdown rollback failed: {type(exc).__name__}: {exc}",
                })
            self.actions.append(rolled)
            rolled_back.append(rolled)
        return rolled_back

    def rollback_incident(self, incident_id: str, reason: str = "Incident containment released") -> list[ResponseActionRecord]:
        if self.require_elevated and not _is_elevated():
            raise ResponseActionError("Firewall response executor requires an elevated Windows service context")
        rolled_back: list[ResponseActionRecord] = []
        for current in self.actions.list_latest():
            if current.incident_id != incident_id or current.status not in {"pending", "active"}:
                continue
            try:
                self.command_runner(_firewall_remove_args(current.rule_name))
                rolled = ResponseActionRecord(**{
                    **current.__dict__, "status": "rolled_back", "updated_at": utc_now(), "reason": reason,
                })
            except Exception as exc:
                rolled = ResponseActionRecord(**{
                    **current.__dict__, "status": "failed", "updated_at": utc_now(),
                    "reason": f"Incident rollback failed: {type(exc).__name__}: {exc}",
                })
            self.actions.append(rolled)
            rolled_back.append(rolled)
        return rolled_back

def write_service_heartbeat(path: Path, integrity_key_path: Path, payload: dict[str, Any]) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    sealed = {
        "status": str(payload.get("status") or "running"),
        "pid": os.getpid(),
        "updated_at": time.time(),
        "active_actions": max(0, int(payload.get("active_actions") or 0)),
        "last_applied": max(0, int(payload.get("last_applied") or 0)),
        "last_rejected": max(0, int(payload.get("last_rejected") or 0)),
    }
    sealed[INTEGRITY_FIELD] = sign_payload(
        sealed, get_or_create_key(integrity_key_path), "security-response-service-heartbeat"
    )
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(sealed, ensure_ascii=True, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def read_service_heartbeat(path: Path, integrity_key_path: Path, *, stale_after: float = 20.0) -> dict[str, Any]:
    if not path.exists():
        return {"running": False, "status": "not_installed_or_stopped", "integrity_ok": True}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("heartbeat is not an object")
        ok, reason = verify_payload(
            payload,
            get_or_create_key(integrity_key_path),
            "security-response-service-heartbeat",
        )
        if not ok:
            return {"running": False, "status": "invalid", "integrity_ok": False, "error": reason}
        age = max(0.0, time.time() - float(payload.get("updated_at") or 0))
        return {
            **{key: value for key, value in payload.items() if key != INTEGRITY_FIELD},
            "running": age <= stale_after and payload.get("status") == "running",
            "stale": age > stale_after,
            "age_seconds": round(age, 3),
            "integrity_ok": True,
        }
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"running": False, "status": "invalid", "integrity_ok": False, "error": str(exc)}


class PrivilegedResponseBroker:
    """Revalidates proposal, evidence, expiry, and PIN inside the elevated process."""

    def __init__(
        self,
        approval: ResponseApprovalBroker,
        firewall: FirewallContainmentService,
        incidents: IncidentStore,
    ) -> None:
        self.approval = approval
        self.firewall = firewall
        self.incidents = incidents

    def execute(self, request: dict[str, Any]) -> dict[str, Any]:
        operation = str(request.get("operation") or "")
        if operation == "approve_apply":
            if set(request) != {"operation", "proposal_id", "pin"}:
                raise ResponseActionError("Response executor request fields are invalid")
            proposal_id = str(request.get("proposal_id") or "")
            pin = str(request.get("pin") or "")
            if not proposal_id or len(proposal_id) > 128 or len(pin) != 6 or not pin.isdigit():
                raise ResponseActionError("Response executor request is invalid")
            grant = self.approval.authorize(proposal_id, pin)
            action = self.firewall.apply_verified_grant(grant)
            return {"ok": True, "executed": True, "grant_id": grant.grant_id, "action": action.to_dict()}
        if operation == "emergency_contain":
            if set(request) != {"operation", "incident_id"}:
                raise ResponseActionError("Emergency containment request fields are invalid")
            incident = self._emergency_incident(str(request.get("incident_id") or ""))
            scope = _network_scope_from_incident(incident)
            if scope is None:
                return {"ok": True, "executed": False, "reason": "Emergency incident has no exact network endpoint"}
            grant = _emergency_grant(incident, scope, ttl_seconds=120)
            action = self.firewall.apply_verified_grant(grant)
            return {
                "ok": True, "executed": True, "grant_id": grant.grant_id,
                "action_id": action.action_id, "expires_at": action.expires_at,
            }
        if operation == "emergency_resolve":
            if set(request) != {"operation", "incident_id", "pin", "decision"}:
                raise ResponseActionError("Emergency resolution request fields are invalid")
            incident = self._emergency_incident(str(request.get("incident_id") or ""))
            pin = str(request.get("pin") or "")
            decision = str(request.get("decision") or "")
            if decision not in {"release", "continue"} or len(pin) != 6 or not pin.isdigit():
                raise ResponseActionError("Emergency resolution request is invalid")
            verification = self.approval.pin.verify(pin)
            if not verification.ok:
                raise ResponseActionError(verification.reason)
            rolled = self.firewall.rollback_incident(incident.incident_id)
            if decision == "release":
                return {"ok": True, "released": True, "executed": bool(rolled), "reason": "Emergency containment released"}
            scope = _network_scope_from_incident(incident)
            if scope is None:
                raise ResponseActionError("Emergency incident has no exact network endpoint to continue")
            grant = _emergency_grant(incident, scope, ttl_seconds=900)
            action = self.firewall.apply_verified_grant(grant)
            return {
                "ok": True, "released": False, "executed": True, "grant_id": grant.grant_id,
                "action_id": action.action_id, "expires_at": action.expires_at,
            }
        raise ResponseActionError("Response executor operation is not allowlisted")

    def _emergency_incident(self, incident_id: str) -> Incident:
        incident = self.incidents.get(incident_id)
        if incident is None or incident.status not in {"open", "acknowledged", "contained"}:
            raise ResponseActionError("Emergency executor requires an active incident")
        if incident.risk_score < 700 or not incident.emergency_eligible:
            raise ResponseActionError("Emergency executor requires corroborated risk 700-800")
        high_families = {
            item.family for item in incident.evidence if item.deterministic and item.event_score >= 65
        }
        trusted_chain = any(item.trusted_malicious for item in incident.evidence) and any(
            item.harmful_behavior for item in incident.evidence
        )
        if len(high_families) < 2 and not trusted_chain:
            raise ResponseActionError("Emergency executor evidence corroboration is insufficient")
        return incident


def serve_response_pipe(broker: PrivilegedResponseBroker, *, max_requests: int = 0) -> None:
    if os.name != "nt":
        raise ResponseActionError("Response executor named pipe is Windows-only")
    handled = 0
    with Listener(RESPONSE_EXECUTOR_PIPE, family="AF_PIPE", authkey=RESPONSE_EXECUTOR_AUTH) as listener:
        while max_requests <= 0 or handled < max_requests:
            connection = listener.accept()
            try:
                raw = connection.recv_bytes(16_385)
                if len(raw) > 16_384:
                    raise ResponseActionError("Response executor request is too large")
                payload = json.loads(raw.decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ResponseActionError("Response executor request is not an object")
                result = broker.execute(payload)
            except Exception as exc:
                result = {"ok": False, "executed": False, "error": str(exc)[:1000]}
            connection.send_bytes(json.dumps(result, ensure_ascii=True, sort_keys=True).encode("utf-8"))
            connection.close()
            handled += 1


def request_response_execution(proposal_id: str, pin: str) -> dict[str, Any]:
    return _request_pipe({"operation": "approve_apply", "proposal_id": proposal_id, "pin": pin})


def request_emergency_containment(incident_id: str) -> dict[str, Any]:
    return _request_pipe({"operation": "emergency_contain", "incident_id": incident_id})


def request_emergency_resolution(incident_id: str, pin: str, decision: str) -> dict[str, Any]:
    return _request_pipe({
        "operation": "emergency_resolve",
        "incident_id": incident_id,
        "pin": pin,
        "decision": decision,
    })


def _request_pipe(payload: dict[str, Any]) -> dict[str, Any]:
    if os.name != "nt":
        raise ResponseActionError("Response executor named pipe is Windows-only")
    request = json.dumps(payload, ensure_ascii=True, sort_keys=True).encode("utf-8")
    try:
        connection = Client(RESPONSE_EXECUTOR_PIPE, family="AF_PIPE", authkey=RESPONSE_EXECUTOR_AUTH)
        connection.send_bytes(request)
        raw = connection.recv_bytes(65_537)
        connection.close()
    except (OSError, EOFError) as exc:
        raise ResponseActionError("Elevated response executor is unavailable") from exc
    if len(raw) > 65_536:
        raise ResponseActionError("Response executor reply is too large")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ResponseActionError("Response executor returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ResponseActionError("Response executor returned an invalid reply")
    return payload


def _network_scope_from_incident(incident: Incident) -> dict[str, Any] | None:
    for evidence in reversed(incident.evidence):
        scope = evidence.response_scope
        if scope.get("remote_address") and scope.get("remote_port"):
            candidate = {
                "remote_address": scope["remote_address"],
                "remote_port": scope["remote_port"],
                "protocol": scope.get("protocol") or "tcp",
                "direction": scope.get("direction") or "outbound",
            }
            _validate_network_scope(candidate)
            return candidate
    return None


def _emergency_grant(
    incident: Incident,
    scope: dict[str, Any],
    *,
    ttl_seconds: int,
) -> ResponseGrant:
    now = datetime.now(timezone.utc)
    ttl = max(30, min(900, int(ttl_seconds)))
    return ResponseGrant(
        grant_id=secrets.token_hex(24),
        proposal_id=f"emergency:{incident.incident_id}",
        incident_id=incident.incident_id,
        action="block_network",
        scope=dict(scope),
        issued_at=now.isoformat(),
        consume_by=(now + timedelta(seconds=30)).isoformat(),
        action_expires_at=(now + timedelta(seconds=ttl)).isoformat(),
    )


def install_response_executor_task(
    python_path: Path,
    launcher_path: Path,
    config_path: Path,
    *,
    runner: Callable[[str], None] | None = None,
) -> None:
    if runner is None and not _is_elevated():
        raise ResponseActionError("Response executor installation requires elevation")
    python_path = python_path.resolve(strict=True)
    launcher_path = launcher_path.resolve(strict=True)
    config_path = config_path.resolve(strict=True)
    layout = _resolve_response_runtime_layout(python_path, config_path)
    digest = _attest_response_runtime(layout.attested_roots)
    if not RESPONSE_RUNTIME_DIGEST_PATTERN.fullmatch(digest):
        raise ResponseActionError("Response runtime attestation returned an invalid digest")
    launch_script = _response_runtime_preflight_script(
        layout.attested_roots,
        expected_digest=digest,
        python_path=python_path,
        config_path=config_path,
        import_roots=layout.import_roots,
        environment=_response_executor_environment(),
    )
    encoded_launch = base64.b64encode(launch_script.encode("utf-16le")).decode("ascii")
    arguments = f"-NoProfile -NonInteractive -EncodedCommand {encoded_launch}"
    powershell_path = _windows_powershell_path()
    command = (
        "$ErrorActionPreference='Stop';"
        f"$a=New-ScheduledTaskAction -Execute '{_powershell_quote(str(powershell_path))}' "
        f"-Argument '{arguments}';"
        "$t=New-ScheduledTaskTrigger -AtLogOn;"
        "$s=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) "
        "-ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable;"
        f"Register-ScheduledTask -TaskName '{RESPONSE_EXECUTOR_TASK}' -Action $a -Trigger $t "
        "-Settings $s -RunLevel Highest -Force | Out-Null;"
        f"Start-ScheduledTask -TaskName '{RESPONSE_EXECUTOR_TASK}'"
    )
    (runner or _run_admin_powershell)(command)


def _resolve_response_runtime_layout(
    python_path: Path,
    config_path: Path,
) -> ResponseRuntimeLayout:
    current_python = Path(sys.executable).resolve(strict=True)
    if not _same_path(python_path, current_python):
        raise ResponseActionError("Response executor must attest the active Python runtime")

    runtime_root = Path(sys.prefix).resolve(strict=True)
    base_runtime_root = Path(sys.base_prefix).resolve(strict=True)
    source_root = Path(__file__).resolve(strict=True).parents[1]
    import_roots = [source_root]
    configured_site_packages = os.getenv("MONARCH_SECURITY_SITE_PACKAGES", "").strip()
    if configured_site_packages:
        import_roots.append(Path(configured_site_packages).resolve(strict=True))

    roots = [
        runtime_root,
        base_runtime_root,
        *import_roots,
        config_path,
        _windows_powershell_path(),
    ]
    return ResponseRuntimeLayout(
        attested_roots=_minimal_attestation_roots(roots),
        import_roots=tuple(_unique_paths(import_roots)),
    )


def _attest_response_runtime(roots: tuple[Path, ...]) -> str:
    script = _response_runtime_preflight_script(roots)
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    completed = subprocess.run(
        [
            str(_windows_powershell_path()),
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encoded,
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    output = "\n".join((completed.stdout or "", completed.stderr or ""))
    marker = "MONARCH_RESPONSE_RUNTIME_SHA256="
    error_marker = "MONARCH_RESPONSE_RUNTIME_ERROR="
    digest = ""
    reported_error = ""
    for line in output.splitlines():
        if line.strip().startswith(marker):
            digest = line.strip()[len(marker):].lower()
        if line.strip().startswith(error_marker):
            reported_error = line.strip()[len(error_marker):]
    if completed.returncode != 0 or not RESPONSE_RUNTIME_DIGEST_PATTERN.fullmatch(digest):
        detail = reported_error or (
            completed.stderr or completed.stdout or "runtime attestation failed"
        ).strip()
        raise ResponseActionError(f"Response runtime attestation failed: {detail[:1000]}")
    return digest


def _response_runtime_preflight_script(
    roots: tuple[Path, ...],
    *,
    expected_digest: str = "",
    python_path: Path | None = None,
    config_path: Path | None = None,
    import_roots: tuple[Path, ...] = (),
    environment: dict[str, str] | None = None,
) -> str:
    if expected_digest and not RESPONSE_RUNTIME_DIGEST_PATTERN.fullmatch(expected_digest):
        raise ResponseActionError("Response runtime expected digest is invalid")
    launch_requested = python_path is not None or config_path is not None
    if launch_requested and (python_path is None or config_path is None):
        raise ResponseActionError("Response runtime launch paths are incomplete")

    roots_payload = _base64_json([str(path) for path in roots])
    launch_payload = _base64_json({
        "python": str(python_path or ""),
        "config": str(config_path or ""),
        "import_roots": [str(path) for path in import_roots],
        "environment": environment or {},
    })
    expected = expected_digest.lower()
    launch = "$true" if launch_requested else "$false"
    return f"""$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {{
$roots=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{roots_payload}'))|ConvertFrom-Json)
$launchPayload=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{launch_payload}'))|ConvertFrom-Json)
$trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$writeMask=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
$checked=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
function Assert-MonarchRuntimePath([IO.FileSystemInfo]$item) {{
  if (-not $checked.Add($item.FullName)) {{ return }}
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {{ throw "Runtime path is a reparse point: $($item.FullName)" }}
  $sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
  try {{ $acl=$item.GetAccessControl($sections); $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value }} catch {{ throw "Runtime ACL cannot be read: $($item.FullName)" }}
  if ($trusted -notcontains $owner) {{ throw "Runtime owner is not trusted: $($item.FullName)" }}
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {{
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rule.FileSystemRights -band $writeMask) -eq 0)) {{ continue }}
    $sid=$rule.IdentityReference.Value
    if ($trusted -notcontains $sid) {{ throw "Runtime path grants write-like access outside trusted principals: $($item.FullName)" }}
  }}
}}
function Get-MonarchRuntimeSha256([string]$path) {{
  $fileSha=[Security.Cryptography.SHA256]::Create()
  $stream=[IO.File]::OpenRead($path)
  try {{ return ([BitConverter]::ToString($fileSha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }} finally {{ $stream.Dispose(); $fileSha.Dispose() }}
}}
$records=New-Object 'System.Collections.Generic.List[string]'
$rootIndex=0
foreach ($rootValue in $roots) {{
  $root=[IO.Path]::GetFullPath([string]$rootValue)
  $rootItem=Get-Item -LiteralPath $root -Force
  $cursor=$rootItem
  while ($null -ne $cursor) {{ Assert-MonarchRuntimePath $cursor; $cursor=$cursor.Parent }}
  $items=@($rootItem)
  if ($rootItem.PSIsContainer) {{ $items+=@(Get-ChildItem -LiteralPath $root -Recurse -Force) }}
  foreach ($item in $items) {{
    Assert-MonarchRuntimePath $item
    if (-not $item.PSIsContainer) {{
      $relative=if ($rootItem.PSIsContainer) {{ $item.FullName.Substring($root.TrimEnd('\\').Length).TrimStart('\\').Replace('\\','/') }} else {{ $item.Name }}
      $hash=Get-MonarchRuntimeSha256 $item.FullName
      $records.Add("$rootIndex/$relative`0$($item.Length)`0$hash`n")
    }}
  }}
  $rootIndex++
}}
$sorted=$records.ToArray()
[Array]::Sort($sorted,[StringComparer]::Ordinal)
$bytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($sorted -join ''))
$sha=[Security.Cryptography.SHA256]::Create()
try {{ $digest=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }} finally {{ $sha.Dispose() }}
$expected='{expected}'
if ($expected -and $digest -ne $expected) {{ throw 'Response runtime digest mismatch' }}
Write-Output "MONARCH_RESPONSE_RUNTIME_SHA256=$digest"
if ({launch}) {{
  Get-ChildItem Env: | Where-Object {{ $_.Name -like 'MONARCH_*' -or $_.Name -like 'PYTHON*' }} | Remove-Item
  foreach ($property in $launchPayload.environment.PSObject.Properties) {{ Set-Item -LiteralPath "Env:$($property.Name)" -Value ([string]$property.Value) }}
  $env:PYTHONDONTWRITEBYTECODE='1'
  $pythonDirectory=[IO.Path]::GetDirectoryName([string]$launchPayload.python)
  $env:PATH="$pythonDirectory;$env:SystemRoot\\System32;$env:SystemRoot;$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0"
  Set-Location -LiteralPath "$env:SystemRoot\\System32"
  $env:MONARCH_RESPONSE_IMPORT_ROOTS=($launchPayload.import_roots|ConvertTo-Json -Compress)
  $bootstrap="import json,os,sys;roots=json.loads(os.environ.pop('MONARCH_RESPONSE_IMPORT_ROOTS'));sys.path[:0]=roots;from monarch_security.cli import main;raise SystemExit(main())"
  & ([string]$launchPayload.python) '-I' '-P' '-B' '-c' $bootstrap '--config' ([string]$launchPayload.config) 'response-service-run' '--confirm-service-action' '--poll-seconds' '5'
  if ($LASTEXITCODE -ne 0) {{ throw "Response executor exited with code $LASTEXITCODE" }}
}}
}} catch {{
  Write-Output "MONARCH_RESPONSE_RUNTIME_ERROR=$($_.Exception.Message)"
  exit 1
}}
"""


def _base64_json(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(encoded).decode("ascii")


def _response_executor_environment() -> dict[str, str]:
    values = {
        name: os.environ[name]
        for name in RESPONSE_EXECUTOR_ENVIRONMENT
        if os.environ.get(name)
    }
    windows_root = str(_windows_powershell_path().parents[3])
    values["SystemRoot"] = windows_root
    values["WINDIR"] = windows_root
    return values


def _windows_powershell_path() -> Path:
    if sys.platform != "win32":
        raise ResponseActionError("Windows PowerShell is unavailable")
    buffer = ctypes.create_unicode_buffer(32_768)
    length = ctypes.windll.kernel32.GetWindowsDirectoryW(buffer, len(buffer))
    if length <= 0 or length >= len(buffer):
        raise ResponseActionError("Windows directory cannot be resolved")
    candidate = (
        Path(buffer.value)
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    try:
        return candidate.resolve(strict=True)
    except OSError as exc:
        raise ResponseActionError("Windows PowerShell executable is unavailable") from exc


def _powershell_quote(value: str) -> str:
    return value.replace("'", "''")


def _minimal_attestation_roots(paths: list[Path]) -> tuple[Path, ...]:
    unique = _unique_paths(paths)
    selected: list[Path] = []
    for candidate in sorted(unique, key=lambda item: len(item.parts)):
        if any(_is_relative_to(candidate, parent) for parent in selected if parent.is_dir()):
            continue
        selected.append(candidate)
    return tuple(selected)


def _unique_paths(paths: list[Path]) -> list[Path]:
    values: list[Path] = []
    for candidate in paths:
        resolved = candidate.resolve(strict=True)
        if not any(_same_path(resolved, current) for current in values):
            values.append(resolved)
    return values


def _same_path(first: Path, second: Path) -> bool:
    return os.path.normcase(str(first)) == os.path.normcase(str(second))


def _is_relative_to(candidate: Path, parent: Path) -> bool:
    try:
        candidate.relative_to(parent)
        return True
    except ValueError:
        return False


def uninstall_response_executor_task(*, runner: Callable[[str], None] | None = None) -> None:
    if runner is None and not _is_elevated():
        raise ResponseActionError("Response executor removal requires elevation")
    command = (
        "$ErrorActionPreference='Stop';"
        f"Stop-ScheduledTask -TaskName '{RESPONSE_EXECUTOR_TASK}' -ErrorAction SilentlyContinue;"
        f"Unregister-ScheduledTask -TaskName '{RESPONSE_EXECUTOR_TASK}' -Confirm:$false -ErrorAction SilentlyContinue"
    )
    (runner or _run_admin_powershell)(command)


def _run_admin_powershell(command: str) -> None:
    completed = subprocess.run(
        [
            str(_windows_powershell_path()),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=45,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise ResponseActionError((completed.stderr or completed.stdout or "Scheduled task command failed").strip()[:1000])


def _firewall_add_args(rule_name: str, scope: dict[str, Any], expires_at: str) -> list[str]:
    _validate_network_scope(scope)
    if _parse_datetime(expires_at) is None:
        raise ResponseActionError("Firewall rule expiry is invalid")
    return [
        "add",
        rule_name,
        str(scope.get("direction") or "outbound").lower(),
        str(scope.get("protocol") or "tcp").lower(),
        str(scope["remote_address"]),
        str(int(scope["remote_port"])),
        expires_at,
    ]


def _firewall_remove_args(rule_name: str) -> list[str]:
    if not rule_name.startswith("MonarchSecurity-") or len(rule_name) > 80:
        raise ResponseActionError("Firewall rule name is invalid")
    return ["remove", rule_name]


def _run_powershell(arguments: list[str]) -> None:
    if not arguments or arguments[0] not in {"add", "remove"}:
        raise ResponseActionError("Unsupported firewall service command")
    if arguments[0] == "add" and len(arguments) == 7:
        _, name, direction, protocol, address, port, expires_at = arguments
        task_name = f"MonarchSecurityRollback-{name.removeprefix('MonarchSecurity-')}"
        powershell_path = _powershell_quote(str(_windows_powershell_path()))
        rollback_script = (
            "$ErrorActionPreference='SilentlyContinue';"
            f"Get-NetFirewallRule -Name '{name}' | Remove-NetFirewallRule;"
            f"Unregister-ScheduledTask -TaskName '{task_name}' -Confirm:$false"
        )
        encoded_rollback = base64.b64encode(rollback_script.encode("utf-16le")).decode("ascii")
        command = (
            "$ErrorActionPreference='Stop';"
            f"$ruleName='{name}';$taskName='{task_name}';"
            "try {"
            "New-NetFirewallRule "
            f"-Name $ruleName -DisplayName $ruleName -Group 'Monarch Security' "
            f"-Direction '{direction}' -Action Block -Protocol '{protocol}' "
            f"-RemoteAddress '{address}' -RemotePort {int(port)} -Profile Any | Out-Null;"
            f"$at=[DateTimeOffset]::Parse('{expires_at}').LocalDateTime;"
            f"$a=New-ScheduledTaskAction -Execute '{powershell_path}' -Argument '-NoProfile -NonInteractive -EncodedCommand {encoded_rollback}';"
            "$t=New-ScheduledTaskTrigger -Once -At $at;"
            "Register-ScheduledTask -TaskName $taskName -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest -Force | Out-Null"
            "} catch {"
            "Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule;"
            "Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue;"
            "throw"
            "}"
        )
    elif arguments[0] == "remove" and len(arguments) == 2:
        name = arguments[1]
        task_name = f"MonarchSecurityRollback-{name.removeprefix('MonarchSecurity-')}"
        command = (
            "$ErrorActionPreference='Stop';"
            f"Get-NetFirewallRule -Name '{name}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule;"
            f"Unregister-ScheduledTask -TaskName '{task_name}' -Confirm:$false -ErrorAction SilentlyContinue"
        )
    else:
        raise ResponseActionError("Invalid firewall service arguments")
    completed = subprocess.run(
        [
            str(_windows_powershell_path()),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise ResponseActionError((completed.stderr or completed.stdout or "Firewall command failed").strip()[:1000])


def _is_elevated() -> bool:
    if os.name != "nt":
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
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


def _prune_consumed(values: dict[str, str], now: datetime) -> dict[str, str]:
    cutoff = now - timedelta(days=7)
    pruned: dict[str, str] = {}
    for key, value in values.items():
        parsed = _parse_datetime(value)
        if parsed is not None and parsed >= cutoff:
            pruned[str(key)[:128]] = parsed.isoformat()
    return pruned
