"""Disposable signed-state tests; every native response command is inert/mocked."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import site
import subprocess
import sys
import threading
from types import SimpleNamespace
from unittest import mock

import pytest

from monarch_security.actions import (
    ResponseApprovalBroker, ResponseActionError, ResponseGrantError,
    PrivilegedResponseBroker,
)
from monarch_security.responses import ResponseProposalStore, ResponseBrokerError
from monarch_security.state import StateStore, _pid_is_running
from monarch_security import cli
from monarch_security.process_identity import ProcessProbe
from monarch_security.incidents import IncidentStore
from test_response_actions import _proposal, _service
from test_emergency import _emergency_incident


def grant_for(root):
    proposal, proposals, pin = _proposal(root)
    return ResponseApprovalBroker(proposals, pin).authorize(proposal.proposal.proposal_id, "483920")


def test_fresh_instances_cannot_replay_reserved_grant(tmp_path):
    grant = grant_for(tmp_path)
    calls = []
    stale = _service(tmp_path, calls)
    current = _service(tmp_path, calls)
    current.apply_verified_grant(grant)
    for service in (stale, _service(tmp_path, calls)):
        with pytest.raises(ResponseGrantError, match="replay"):
            service.apply_verified_grant(grant)
    current.rollback_all()
    with pytest.raises(ResponseGrantError, match="replay"):
        _service(tmp_path, calls).apply_verified_grant(grant)
    assert [c[0] for c in calls] == ["add", "remove"]


def test_fresh_legacy_consumption_and_corrupt_state_reject_before_effect(tmp_path):
    grant = grant_for(tmp_path)
    calls = []
    stale = _service(tmp_path, calls)
    state = StateStore(tmp_path / "state.json", tmp_path / "integrity.key")
    with state.lock():
        state.set_dict("consumed_response_grants", {grant.grant_id: datetime.now(timezone.utc).isoformat()})
        state.set_json("unrelated_controller_queue", {"cursor": 4})
    original = state.path.read_bytes()
    with pytest.raises(ResponseGrantError, match="replay"):
        stale.apply_verified_grant(grant)
    assert state.path.read_bytes() == original
    state.path.write_text("broken", encoding="utf-8")
    with pytest.raises(ResponseGrantError, match="recovery"):
        stale.apply_verified_grant(grant)
    assert calls == []


def test_action_flush_failure_never_dispatches_and_reservation_stays_used(tmp_path):
    grant = grant_for(tmp_path)
    calls = []
    service = _service(tmp_path, calls)
    with mock.patch("monarch_security.actions.os.fsync", side_effect=OSError("synthetic disk fault")):
        with pytest.raises(OSError):
            service.apply_verified_grant(grant)
    assert calls == []
    with pytest.raises(ResponseGrantError, match="replay"):
        _service(tmp_path, calls).apply_verified_grant(grant)
    assert _service(tmp_path, calls).reconcile()[0].status == "rolled_back"


def test_stale_approval_instances_and_failed_flush_cannot_issue_another_grant(tmp_path):
    proposal, proposals, pin = _proposal(tmp_path)
    stale = ResponseApprovalBroker(ResponseProposalStore(proposals.path, tmp_path / "integrity.key"), pin)
    with mock.patch("monarch_security.responses.os.fsync", side_effect=OSError("flush fault")):
        with pytest.raises(OSError):
            ResponseApprovalBroker(proposals, pin).authorize(proposal.proposal.proposal_id, "483920")
    with pytest.raises(ResponseBrokerError, match="active proposed"):
        stale.authorize(proposal.proposal.proposal_id, "483920")


def test_concurrent_pin_verification_can_reserve_only_one_proposal(tmp_path):
    proposal, proposals, pin = _proposal(tmp_path)
    barrier = threading.Barrier(2)
    def verify(_):
        barrier.wait(timeout=3)
        return SimpleNamespace(ok=True, reason="synthetic")
    pin.verify = verify
    outcomes = []
    def approve():
        try:
            broker = ResponseApprovalBroker(ResponseProposalStore(proposals.path, tmp_path / "integrity.key"), pin)
            outcomes.append(broker.authorize(proposal.proposal.proposal_id, "483920"))
        except Exception as exc:
            outcomes.append(exc)
    threads = [threading.Thread(target=approve) for _ in range(2)]
    for thread in threads: thread.start()
    for thread in threads: thread.join(5)
    assert all(not t.is_alive() for t in threads)
    assert len(outcomes) == 2
    assert sum(isinstance(x, ResponseBrokerError) for x in outcomes) == 1
    assert sum(hasattr(x, "grant_id") for x in outcomes) == 1


@pytest.mark.parametrize("method", ["reconcile", "rollback_all", "rollback_incident"])
def test_failed_removal_remains_retryable_and_redacts_exception(tmp_path, method):
    grant = grant_for(tmp_path)
    service = _service(tmp_path, [])
    active = service.apply_verified_grant(grant)
    service.actions.append(replace(active, status="pending"))
    service.command_runner = mock.Mock(side_effect=TimeoutError("PIN=483920 secret-path"))
    operation = getattr(service, method)
    records = operation(grant.incident_id) if method == "rollback_incident" else operation()
    assert records[0].status == "pending"
    assert "483920" not in records[0].reason and "secret-path" not in records[0].reason
    fresh = _service(tmp_path, [])
    assert fresh.reconcile()[0].status == "rolled_back"


def test_legacy_failed_cleanup_is_revisited(tmp_path):
    service = _service(tmp_path, [])
    active = service.apply_verified_grant(grant_for(tmp_path))
    service.actions.append(replace(active, status="failed", reason="Legacy rollback failed"))
    assert _service(tmp_path, []).reconcile()[0].status == "rolled_back"


@pytest.mark.parametrize("decision", ["release", "continue"])
def test_emergency_cannot_claim_release_or_continue_after_cleanup_error(tmp_path, decision):
    incidents, incident = _emergency_incident(tmp_path)
    _, proposals, pin = _proposal(tmp_path)
    service = _service(tmp_path, [])
    broker = PrivilegedResponseBroker(ResponseApprovalBroker(proposals, pin), service, incidents)
    broker.execute({"operation": "emergency_contain", "incident_id": incident.incident_id})
    calls = []
    def fail_remove(args):
        calls.append(args)
        raise TimeoutError("synthetic")
    service.command_runner = fail_remove
    with pytest.raises(ResponseActionError, match="cleanup remains pending"):
        broker.execute({"operation": "emergency_resolve", "incident_id": incident.incident_id,
                        "pin": "483920", "decision": decision})
    assert len(calls) == 1 and calls[0][0] == "remove"
    assert service.actions.list_latest()[0].status == "pending"


def child(root, code, payload=None):
    env = {k: v for k, v in os.environ.items() if k in {"SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "APPDATA", "LOCALAPPDATA", "USERPROFILE"}}
    env["PYTHONPATH"] = os.pathsep.join([str(Path(__file__).parents[1] / "src"), *site.getsitepackages()])
    return subprocess.run([getattr(sys, "_base_executable", sys.executable), "-u", "-c", code, str(root)],
                          input=json.dumps(payload) if payload else None, text=True, capture_output=True,
                          timeout=12, env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


CHILD_SETUP = """
import json, os, sys
from pathlib import Path
from monarch_security.actions import FirewallContainmentService, ResponseActionStore, ResponseGrant
from monarch_security.state import StateStore
root=Path(sys.argv[1])
service=FirewallContainmentService(ResponseActionStore(root/'actions.jsonl',root/'integrity.key'),
    StateStore(root/'state.json',root/'integrity.key'),root/'integrity.key',require_elevated=False,
    command_runner=lambda args: os._exit(73))
"""


def test_native_child_exit_after_durable_reservation_rejects_replay_and_reconciles(tmp_path):
    grant = grant_for(tmp_path)
    result = child(tmp_path, CHILD_SETUP + "service.apply_verified_grant(ResponseGrant.from_dict(json.load(sys.stdin)))", grant.to_dict())
    assert result.returncode == 73, result.stderr
    calls = []
    restarted = _service(tmp_path, calls)
    assert restarted.actions.list_latest()[0].status == "pending"
    with pytest.raises(ResponseGrantError, match="replay"):
        restarted.apply_verified_grant(grant)
    assert calls == []
    assert restarted.reconcile()[0].status == "rolled_back"
    assert [c[0] for c in calls] == ["remove"]


def test_native_cross_process_reconcile_cannot_interrupt_held_operation(tmp_path):
    service = _service(tmp_path, [])
    with service.operation():
        result = child(tmp_path, CHILD_SETUP + """
from monarch_security.actions import ResponseActionError
try: service.reconcile()
except ResponseActionError as exc:
    print(str(exc))
    sys.exit(0)
sys.exit(2)
""")
    assert result.returncode == 0, result.stderr
    assert "busy" in result.stdout


def test_unknown_writer_identity_is_not_an_orphan():
    with mock.patch("monarch_security.process_identity.probe_process", return_value=ProcessProbe("unavailable")):
        assert _pid_is_running(22222)


def test_repeated_emergency_containment_reuses_active_expiry(tmp_path):
    incidents, incident = _emergency_incident(tmp_path)
    _, proposals, pin = _proposal(tmp_path)
    calls = []
    service = _service(tmp_path, calls)
    broker = PrivilegedResponseBroker(ResponseApprovalBroker(proposals, pin), service, incidents)
    request = {"operation": "emergency_contain", "incident_id": incident.incident_id}
    first = broker.execute(request)
    second = broker.execute(request)
    assert first["executed"] and not second["executed"]
    assert (first["action_id"], first["expires_at"]) == (second["action_id"], second["expires_at"])
    assert len(calls) == 1


def test_uninstall_retains_service_until_cleanup_confirmed(tmp_path, capsys):
    service = _service(tmp_path, [])
    service.apply_verified_grant(grant_for(tmp_path))
    service.command_runner = mock.Mock(side_effect=OSError("synthetic cleanup failure"))
    args = SimpleNamespace(confirm_service_install=True)
    config = SimpleNamespace(runtime=SimpleNamespace(response_service_heartbeat_path=tmp_path / "heartbeat.json"))
    with mock.patch.object(cli, "_response_service", return_value=service), \
            mock.patch.object(cli, "uninstall_response_executor_task") as uninstall:
        assert cli._uninstall_response_service(args, config) == 1
        uninstall.assert_not_called()
    assert json.loads(capsys.readouterr().out)["ok"] is False


def test_cli_reconcile_returns_failure_while_cleanup_pending(tmp_path, capsys):
    service = _service(tmp_path, [])
    active = service.apply_verified_grant(grant_for(tmp_path))
    service.actions.append(replace(active, status="pending"))
    service.command_runner = mock.Mock(side_effect=OSError("synthetic"))
    with mock.patch.object(cli, "_response_service", return_value=service):
        assert cli._reconcile_response_actions(SimpleNamespace(confirm_service_action=True), None) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["cleanup_complete"] is False and result["ok"] is False


def test_running_service_retries_cleanup_without_restart(tmp_path):
    service = _service(tmp_path, [])
    active = service.apply_verified_grant(grant_for(tmp_path))
    service.actions.append(replace(active, status="pending"))
    removed = threading.Event()
    attempts = []
    def remove(args):
        attempts.append(args)
        if len(attempts) == 1: raise OSError("first startup cleanup")
        removed.set()
    service.command_runner = remove
    config = SimpleNamespace(runtime=SimpleNamespace(
        response_service_heartbeat_path=tmp_path / "heartbeat.json", integrity_key_path=tmp_path / "integrity.key",
        response_log_path=tmp_path / "proposals.jsonl", security_pin_path=tmp_path / "pin.json",
        incident_log_path=tmp_path / "incidents.jsonl"))
    def inert_pipe(_):
        assert removed.wait(3)
    with mock.patch.object(cli, "_response_service", return_value=service), \
            mock.patch.object(cli, "serve_response_pipe", side_effect=inert_pipe):
        assert cli._run_response_service(SimpleNamespace(confirm_service_action=True, once=False, poll_seconds=0.02), config) == 0
    assert len(attempts) == 2
    assert service.actions.list_latest()[0].status == "rolled_back"


def test_executor_rechecks_current_incident_after_approval(tmp_path):
    proposal, proposals, pin = _proposal(tmp_path)
    incidents = IncidentStore(tmp_path / "incidents.jsonl", tmp_path / "integrity.key")
    calls = []
    broker = PrivilegedResponseBroker(ResponseApprovalBroker(proposals, pin), _service(tmp_path, calls), incidents)
    incidents.update_status(proposal.proposal.incident_id, "resolved", reason="synthetic owner resolution")
    with pytest.raises(ResponseActionError, match="active incident"):
        broker.execute({"operation": "approve_apply", "proposal_id": proposal.proposal.proposal_id, "pin": "483920"})
    assert calls == []
