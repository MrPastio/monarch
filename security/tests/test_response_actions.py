from __future__ import annotations

from datetime import datetime, timedelta, timezone
from dataclasses import replace
import json
import os
import threading
import time
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from monarch_security.actions import (
    FirewallContainmentService,
    PrivilegedResponseBroker,
    ResponseActionError,
    ResponseActionRecord,
    ResponseActionStore,
    ResponseApprovalBroker,
    ResponseGrantError,
    read_service_heartbeat,
    write_service_heartbeat,
    _run_powershell,
    install_response_executor_task,
    request_response_execution,
    serve_response_pipe,
    uninstall_response_executor_task,
)
from monarch_security.events import ActionDecision, RuleAssessment, SecurityEvent
from monarch_security.incidents import IncidentCorrelator, IncidentStore
from monarch_security.pin import SecurityPinManager
from monarch_security.responses import ResponseBrokerError, ResponseProposalStore, ShadowResponseBroker
from monarch_security.state import StateStore


class ResponseActionTests(unittest.TestCase):
    def test_pin_approval_creates_short_lived_internal_nonce(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            proposal, proposals, pin = _proposal(root)
            broker = ResponseApprovalBroker(
                proposals,
                pin,
            )
            grant = broker.authorize(proposal.proposal.proposal_id, "483920")

            self.assertEqual(grant.action, "block_network")
            self.assertTrue(proposal.proposal.requires_security_pin)
            self.assertLessEqual(
                datetime.fromisoformat(grant.consume_by),
                datetime.now(timezone.utc) + timedelta(seconds=91),
            )
            self.assertEqual(len(grant.grant_id), 48)
            self.assertNotIn("483920", json.dumps(grant.to_dict()))

    def test_approval_rejects_invalid_pin_and_applies_rate_limit_state(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            proposal, proposals, pin = _proposal(root)
            broker = ResponseApprovalBroker(proposals, pin)
            with self.assertRaisesRegex(ResponseBrokerError, "invalid"):
                broker.authorize(proposal.proposal.proposal_id, "000000")
            self.assertEqual(pin.status()["failed_attempts"], 1)

    def test_firewall_service_applies_once_and_rejects_replay(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            proposal, proposals, pin = _proposal(root)
            grant = ResponseApprovalBroker(proposals, pin).authorize(
                proposal.proposal.proposal_id, "483920"
            )
            calls: list[list[str]] = []
            service = _service(root, calls)
            active = service.apply_verified_grant(grant)

            self.assertEqual(active.status, "active")
            self.assertEqual(calls[0][0], "add")
            self.assertEqual(calls[0][4:6], ["203.0.113.10", "443"])
            self.assertTrue(calls[0][6].endswith("+00:00"))
            with self.assertRaisesRegex(ResponseGrantError, "replay"):
                service.apply_verified_grant(grant)

            with self.assertRaisesRegex(ResponseBrokerError, "active proposed"):
                ResponseApprovalBroker(
                    proposals, pin
                ).authorize(proposal.proposal.proposal_id, "483920")

    def test_privileged_broker_revalidates_pin_and_proposal_inside_executor(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            proposal, proposals, pin = _proposal(root)
            calls: list[list[str]] = []
            broker = PrivilegedResponseBroker(
                ResponseApprovalBroker(proposals, pin),
                _service(root, calls),
                IncidentStore(root / "incidents.jsonl", root / "integrity.key"),
            )
            result = broker.execute({
                "operation": "approve_apply",
                "proposal_id": proposal.proposal.proposal_id,
                "pin": "483920",
            })
            self.assertTrue(result["executed"])
            self.assertEqual(calls[0][0], "add")
            with self.assertRaisesRegex(ResponseActionError, "fields"):
                broker.execute({
                    "operation": "approve_apply",
                    "proposal_id": proposal.proposal.proposal_id,
                    "pin": "483920",
                    "command": "whoami",
                })

    @unittest.skipUnless(os.name == "nt", "Windows named pipe")
    def test_named_pipe_transfers_bounded_json_without_pickle(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            proposal, proposals, pin = _proposal(root)
            calls: list[list[str]] = []
            broker = PrivilegedResponseBroker(
                ResponseApprovalBroker(proposals, pin),
                _service(root, calls),
                IncidentStore(root / "incidents.jsonl", root / "integrity.key"),
            )
            thread = threading.Thread(
                target=lambda: serve_response_pipe(broker, max_requests=1),
                daemon=True,
            )
            thread.start()
            time.sleep(0.1)
            result = request_response_execution(proposal.proposal.proposal_id, "483920")
            thread.join(timeout=2)
            self.assertTrue(result["executed"])
            self.assertFalse(thread.is_alive())
            self.assertEqual(calls[0][0], "add")

    def test_invalid_internal_grant_is_rejected_before_command(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            proposal, proposals, pin = _proposal(root)
            grant = ResponseApprovalBroker(proposals, pin).authorize(
                proposal.proposal.proposal_id, "483920"
            )
            grant = replace(grant, scope={**grant.scope, "remote_address": "0.0.0.0"})
            calls: list[list[str]] = []
            with self.assertRaises(ResponseBrokerError):
                _service(root, calls).apply_verified_grant(grant)
            self.assertEqual(calls, [])

    def test_reconcile_rolls_back_expired_and_interrupted_rules(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            calls: list[list[str]] = []
            now = datetime.now(timezone.utc)
            actions = ResponseActionStore(root / "actions.jsonl", root / "integrity.key")
            for status, suffix in (("active", "expired"), ("pending", "interrupted")):
                actions.append(ResponseActionRecord(
                    action_id=suffix,
                    grant_id=f"grant-{suffix}",
                    proposal_id="proposal",
                    incident_id="incident",
                    action="block_network",
                    scope={"remote_address": "203.0.113.10", "remote_port": 443, "protocol": "tcp", "direction": "outbound"},
                    status=status,
                    rule_name=f"MonarchSecurity-{suffix}",
                    expires_at=(now - timedelta(seconds=1)).isoformat(),
                    updated_at=now.isoformat(),
                ))
            service = FirewallContainmentService(
                actions,
                StateStore(root / "state.json", root / "integrity.key"),
                root / "integrity.key",
                command_runner=calls.append,
                require_elevated=False,
                now_fn=lambda: now,
            )
            rolled = service.reconcile()
            self.assertEqual(len(rolled), 2)
            self.assertTrue(all(item.status == "rolled_back" for item in rolled))
            self.assertTrue(all(call[0] == "remove" for call in calls))

    def test_action_ledger_rejects_tampering(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = ResponseActionStore(root / "actions.jsonl", root / "integrity.key")
            store.append(ResponseActionRecord(
                action_id="action-1", grant_id="grant-1", proposal_id="proposal-1",
                incident_id="incident-1", action="block_network",
                scope={"remote_address": "203.0.113.10", "remote_port": 443},
                status="active", rule_name="MonarchSecurity-action-1",
                expires_at=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
                updated_at=datetime.now(timezone.utc).isoformat(),
            ))
            payload = json.loads(store.path.read_text(encoding="utf-8"))
            payload["action"]["status"] = "rolled_back"
            store.path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ResponseActionError, "integrity mismatch"):
                ResponseActionStore(store.path, root / "integrity.key")

    def test_executor_requires_elevation_by_default(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            service = FirewallContainmentService(
                ResponseActionStore(root / "actions.jsonl", root / "integrity.key"),
                StateStore(root / "state.json", root / "integrity.key"),
                root / "integrity.key",
                command_runner=lambda _: None,
            )
            with self.assertRaisesRegex(ResponseActionError, "elevated"):
                service.reconcile()

    def test_firewall_command_registers_independent_system_rollback(self) -> None:
        completed = mock.Mock(returncode=0, stderr="", stdout="")
        with mock.patch("monarch_security.actions.subprocess.run", return_value=completed) as run:
            _run_powershell([
                "add", "MonarchSecurity-abc123", "outbound", "tcp",
                "203.0.113.10", "443", (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
            ])
        command = run.call_args.args[0][-1]
        self.assertIn("Register-ScheduledTask", command)
        self.assertIn("-User 'SYSTEM'", command)
        self.assertIn("MonarchSecurityRollback-abc123", command)
        self.assertIn("Remove-NetFirewallRule", command)

    def test_signed_service_heartbeat_detects_tampering(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "heartbeat.json"
            write_service_heartbeat(path, root / "integrity.key", {"status": "running", "active_actions": 2})
            status = read_service_heartbeat(path, root / "integrity.key")
            self.assertTrue(status["running"])
            self.assertEqual(status["active_actions"], 2)

            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["active_actions"] = 99
            path.write_text(json.dumps(payload), encoding="utf-8")
            tampered = read_service_heartbeat(path, root / "integrity.key")
            self.assertFalse(tampered["integrity_ok"])
            self.assertFalse(tampered["running"])

    def test_executor_task_install_is_bounded_and_restartable(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            python = root / "python.exe"
            launcher = root / "run_monarch_security.py"
            config = root / "monarch_security.toml"
            for path in (python, launcher, config):
                path.write_text("test", encoding="utf-8")
            commands: list[str] = []
            install_response_executor_task(python, launcher, config, runner=commands.append)
            uninstall_response_executor_task(runner=commands.append)
            self.assertIn("Register-ScheduledTask", commands[0])
            self.assertIn("-RestartCount 999", commands[0])
            self.assertIn("-RunLevel Highest", commands[0])
            self.assertIn("response-service-run --confirm-service-action", commands[0])
            self.assertIn("Unregister-ScheduledTask", commands[1])


def _proposal(root: Path):
    incidents = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
    incident = IncidentCorrelator(incidents).observe(
        RuleAssessment(
            event=SecurityEvent(
                kind="network.connection_seen",
                source="test",
                subject="203.0.113.10:443",
                facts={"remote_address": "203.0.113.10", "remote_port": 443},
            ),
            score=100,
            severity="critical",
            reasons=["correlated network evidence"],
            route="local",
        ),
        ActionDecision(action="ask_user", confidence=1.0, source="rules", reasons=["test"]),
    )
    assert incident is not None
    proposals = ResponseProposalStore(root / "proposals.jsonl", root / "integrity.key")
    stored = ShadowResponseBroker(incidents, proposals).propose(
        incident_id=incident.incident_id,
        action="block_network",
        scope={
            "remote_address": "203.0.113.10",
            "remote_port": 443,
            "protocol": "tcp",
            "direction": "outbound",
        },
        rationale=["test"],
        proposed_by="rules",
        ttl_seconds=300,
    )
    pin = SecurityPinManager(root / "pin.json", root / "integrity.key")
    pin.set_pin("483920")
    return stored, proposals, pin


def _service(root: Path, calls: list[list[str]]) -> FirewallContainmentService:
    return FirewallContainmentService(
        ResponseActionStore(root / "actions.jsonl", root / "integrity.key"),
        StateStore(root / "state.json", root / "integrity.key"),
        root / "integrity.key",
        command_runner=calls.append,
        require_elevated=False,
    )


if __name__ == "__main__":
    unittest.main()
