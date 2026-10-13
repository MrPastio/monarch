from __future__ import annotations

from datetime import datetime, timedelta, timezone
from dataclasses import replace
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import os
import secrets
import time

from monarch_security.actions import (
    FirewallContainmentService,
    PrivilegedResponseBroker,
    ResponseActionStore,
    ResponseApprovalBroker,
)
from monarch_security.analysis import RuleEngine
from monarch_security.audit import AuditLog
from monarch_security.integrity import hmac_sha256
from monarch_security.config import load_config
from monarch_security.emergency import EmergencyError, EmergencyManager, EmergencyStore
from monarch_security.events import ActionDecision, RuleAssessment, SecurityEvent, utc_now
from monarch_security.incidents import IncidentCorrelator, IncidentStore
from monarch_security.pin import SecurityPinManager
from monarch_security.llm import LLMRouter
from monarch_security.policy import PolicyEngine
from monarch_security.resources import ResourceGuard
from monarch_security.responses import ResponseProposalStore
from monarch_security.state import StateStore
from monarch_security.supervisor import SecuritySupervisor


class EmergencyManagerTests(unittest.TestCase):
    def test_protector_observes_activation_and_release_from_another_manager(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            observer = _manager(root, incidents)
            resolver = _manager(root, incidents)
            active = _manager(root, incidents).activate(incident.incident_id)
            self.assertEqual(observer.status().emergency_id, active.emergency_id)
            released = resolver.resolve("483920", "release")
            self.assertIsNone(observer.status())
            self.assertEqual(observer.summary()["state"], "released")
            self.assertEqual(observer.activate(incident.incident_id), released)

    def test_stale_expiry_cannot_overwrite_a_release_from_another_process(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            manager = _manager(root, incidents)
            active = manager.activate(incident.incident_id)
            resolver = _manager(root, incidents)
            resolver.resolve("483920", "release")
            stale_expiry = replace(active, state="expired", updated_at=utc_now())
            self.assertFalse(manager.store.append(stale_expiry, expected=active))
            self.assertEqual(manager.summary()["state"], "released")

    def test_existing_reader_detects_external_emergency_journal_tampering(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            manager = _manager(root, incidents)
            manager.activate(incident.incident_id)
            reader = EmergencyStore(manager.store.path, root / "integrity.key")
            records = manager.store.path.read_text(encoding="utf-8")
            manager.store.path.write_text(records.replace('"state":"awaiting_user"', '"state":"released"'), encoding="utf-8")
            with self.assertRaisesRegex(EmergencyError, "integrity mismatch"):
                reader.latest_active()

    def test_activation_requires_corroborated_700_to_800_incident(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
            incident = IncidentCorrelator(incidents).observe(
                _assessment("process.started", 100, {"pid": 42}), _decision()
            )
            assert incident is not None
            manager = _manager(root, incidents)
            with self.assertRaisesRegex(EmergencyError, "700-800"):
                manager.activate(incident.incident_id)

    def test_activation_locks_with_windows_native_hook_and_is_idempotent(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            calls: list[str] = []
            manager = _manager(
                root,
                incidents,
                lock_fn=lambda: calls.append("lock") is None or True,
                contain_fn=lambda incident_id: {"ok": True, "executed": True, "action_id": "a1", "expires_at": "2099-01-01T00:00:00+00:00"},
            )
            active = manager.activate(incident.incident_id)
            duplicate = manager.activate(incident.incident_id)
            self.assertEqual(active.state, "awaiting_user")
            self.assertTrue(active.native_lock_requested)
            self.assertTrue(active.native_lock_succeeded)
            self.assertTrue(active.containment["executed"])
            self.assertEqual(active.emergency_id, duplicate.emergency_id)
            self.assertEqual(calls, ["lock"])

    def test_recovery_ttl_fails_open_without_relocking_user(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            now = datetime.now(timezone.utc)
            clock = [now]
            locks: list[str] = []
            manager = _manager(
                root, incidents, now_fn=lambda: clock[0],
                lock_fn=lambda: locks.append("lock") is None or True,
            )
            manager.activate(incident.incident_id)
            clock[0] = now + timedelta(minutes=11)
            expired = manager.status()
            assert expired is not None
            self.assertEqual(expired.state, "expired")
            self.assertIn("fail-open", expired.reason)
            self.assertIsNone(manager.status())
            same = manager.activate(incident.incident_id)
            self.assertEqual(same.state, "expired")
            self.assertEqual(locks, ["lock"])

    def test_pin_can_release_or_continue_containment(self) -> None:
        for decision, expected in (("release", "released"), ("continue", "contained")):
            with self.subTest(decision=decision), TemporaryDirectory() as directory:
                root = Path(directory)
                incidents, incident = _emergency_incident(root)
                calls: list[tuple[str, str, str]] = []
                manager = _manager(
                    root,
                    incidents,
                    resolve_fn=lambda incident_id, pin, choice: (
                        calls.append((incident_id, pin, choice))
                        or {"ok": True, "released": choice == "release", "expires_at": "2099-01-01T00:00:00+00:00"}
                    ),
                )
                manager.activate(incident.incident_id)
                result = manager.resolve("483920", decision)  # type: ignore[arg-type]
                self.assertEqual(result.state, expected)
                self.assertEqual(calls[0][2], decision)

    def test_invalid_pin_is_rate_limited_and_never_reaches_executor(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            calls: list[str] = []
            manager = _manager(
                root, incidents,
                resolve_fn=lambda *_: calls.append("executor") or {"ok": True},
            )
            manager.activate(incident.incident_id)
            with self.assertRaisesRegex(EmergencyError, "invalid"):
                manager.resolve("000000", "release")
            self.assertEqual(calls, [])

    def test_manual_emergency_uses_real_containment_and_pin_release_path(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root, source="emergency_test")
            locks: list[str] = []
            actions: list[str] = []
            manager = _manager(
                root, incidents,
                lock_fn=lambda: locks.append("lock") is None or True,
                contain_fn=lambda _: actions.append("contain") or {"ok": True, "executed": True},
                resolve_fn=lambda *_: actions.append("resolve") or {"ok": True},
            )
            active = manager.activate(incident.incident_id, test_mode=True)
            self.assertTrue(active.test_mode)
            self.assertTrue(active.native_lock_succeeded)
            self.assertEqual(active.state, "awaiting_user")
            self.assertEqual(locks, ["lock"])
            self.assertEqual(actions, ["contain"])
            with self.assertRaisesRegex(EmergencyError, "invalid"):
                manager.resolve("000000", "release")
            self.assertEqual(manager.status().state, "awaiting_user")
            self.assertEqual(actions, ["contain"])
            released = manager.resolve("483920", "release")
            self.assertEqual(released.state, "released")
            self.assertTrue(released.test_mode)
            self.assertEqual(actions, ["contain", "resolve"])
            self.assertEqual(locks, ["lock"])

    def test_manual_emergency_does_not_lock_when_isolation_fails(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root, source="emergency_test")
            locks: list[str] = []
            manager = _manager(
                root, incidents,
                lock_fn=lambda: locks.append("lock") is None or True,
                contain_fn=lambda _: {"ok": False, "executed": False, "reason": "executor unavailable"},
            )
            failed = manager.activate(incident.incident_id, test_mode=True)
            self.assertEqual(failed.state, "failed")
            self.assertFalse(failed.native_lock_requested)
            self.assertEqual(locks, [])

    def test_native_lock_is_suppressed_when_recovery_pin_is_not_configured(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            locks: list[str] = []
            manager = EmergencyManager(
                incidents,
                EmergencyStore(root / "emergency.jsonl", root / "integrity.key"),
                SecurityPinManager(root / "pin.json", root / "integrity.key"),
                lock_fn=lambda: locks.append("lock") is None or True,
                contain_fn=lambda _: {"ok": True, "executed": False},
            )
            active = manager.activate(incident.incident_id)
            self.assertFalse(active.native_lock_requested)
            self.assertFalse(active.native_lock_succeeded)
            self.assertEqual(locks, [])
            self.assertIn("PIN is not configured", active.reason)

    def test_release_fails_open_after_valid_pin_when_executor_is_unavailable(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            manager = _manager(
                root,
                incidents,
                resolve_fn=lambda *_: (_ for _ in ()).throw(OSError("pipe unavailable")),
            )
            manager.activate(incident.incident_id)
            released = manager.resolve("483920", "release")
            self.assertEqual(released.state, "released")
            self.assertIn("Fail-open", released.containment["reason"])

    def test_emergency_log_detects_tampering(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            manager = _manager(root, incidents)
            manager.activate(incident.incident_id)
            payloads = [json.loads(line) for line in manager.store.path.read_text(encoding="utf-8").splitlines()]
            payloads[-1]["emergency"]["state"] = "released"
            manager.store.path.write_text("\n".join(json.dumps(item) for item in payloads) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(EmergencyError, "integrity mismatch"):
                EmergencyStore(manager.store.path, root / "integrity.key")

    def test_supervisor_activates_only_after_second_high_evidence_family(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config" / "monarch_security.toml"
            config_path.parent.mkdir(parents=True)
            config_path.write_text("[notifications]\nenabled = false\n", encoding="utf-8")
            config = load_config(config_path)
            resources = ResourceGuard(config.resources)
            policy = PolicyEngine(config.policy)
            class EmergencyRules:
                @staticmethod
                def assess(event):
                    return RuleAssessment(
                        event=event,
                        score=100 if event.kind.startswith("process.") else 90,
                        severity="critical",
                        reasons=["test emergency evidence"],
                        route="local",
                    )
            supervisor = SecuritySupervisor(
                config,
                resources,
                EmergencyRules(),  # type: ignore[arg-type]
                LLMRouter(config, resources, policy),
                policy,
                AuditLog(config.runtime.audit_log_path, 0, False, config.runtime.integrity_key_path),
                StateStore(config.runtime.state_path, config.runtime.integrity_key_path),
                no_llm=True,
            )
            pin = SecurityPinManager(config.runtime.security_pin_path, config.runtime.integrity_key_path)
            pin.set_pin("483920")
            locks: list[str] = []
            supervisor.emergency = EmergencyManager(
                supervisor.incident_store,
                EmergencyStore(config.runtime.emergency_log_path, config.runtime.integrity_key_path),
                pin,
                lock_fn=lambda: locks.append("lock") is None or True,
                contain_fn=lambda _: {"ok": True, "executed": False},
            )
            supervisor._handle_event(SecurityEvent(
                kind="process.started", source="test", subject="42", facts={"pid": 42, "encoded_command": True},
            ))
            self.assertEqual(locks, [])
            supervisor._handle_event(SecurityEvent(
                kind="network.connection_seen", source="test", subject="203.0.113.10:4444",
                facts={"owning_process": 42, "remote_address": "203.0.113.10", "remote_port": 4444, "remote_is_public": True},
            ))
            self.assertEqual(locks, ["lock"])

    def test_live_protector_consumes_authenticated_test_request_and_runs_full_response(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config" / "monarch_security.toml"
            config_path.parent.mkdir(parents=True)
            config_path.write_text("[notifications]\nenabled = false\n", encoding="utf-8")
            config = load_config(config_path)
            resources = ResourceGuard(config.resources)
            policy = PolicyEngine(config.policy)
            supervisor = SecuritySupervisor(
                config, resources, RuleEngine(config.router),
                LLMRouter(config, resources, policy), policy,
                AuditLog(config.runtime.audit_log_path, 0, False, config.runtime.integrity_key_path),
                StateStore(config.runtime.state_path, config.runtime.integrity_key_path),
                no_llm=True,
            )
            pin = SecurityPinManager(config.runtime.security_pin_path, config.runtime.integrity_key_path)
            pin.set_pin("483920")
            locks: list[str] = []
            actions: list[str] = []
            supervisor.emergency = EmergencyManager(
                supervisor.incident_store,
                EmergencyStore(config.runtime.emergency_log_path, config.runtime.integrity_key_path),
                pin,
                lock_fn=lambda: locks.append("lock") is None or True,
                contain_fn=lambda _: actions.append("contain") or {"ok": True, "executed": True},
                resolve_fn=lambda *_: actions.append("release") or {"ok": True, "released": True},
            )
            request_path = config.runtime.control_path.with_name("emergency-test.request.json")
            result_path = config.runtime.control_path.with_name("emergency-test.result.json")
            request_path.parent.mkdir(parents=True, exist_ok=True)
            token = secrets.token_hex(32).encode()
            config.runtime.control_token_path.write_bytes(token)
            nonce = secrets.token_hex(16)
            requested_at = time.time()
            payload = {"pid": os.getpid(), "nonce": nonce, "requested_at": requested_at}
            payload["token_hmac"] = hmac_sha256(token, f"emergency-test|{requested_at}|{os.getpid()}|{nonce}")
            request_path.write_text(json.dumps(payload), encoding="utf-8")
            with patch("monarch_security.supervisor.read_service_heartbeat", return_value={"running": True, "integrity_ok": True}):
                supervisor._check_emergency_test_request()
            result = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertTrue(result["ok"], {"result": result, "incidents": [
                (item.risk_score, item.emergency_eligible, [e.source for e in item.evidence])
                for item in supervisor.incident_store.list_latest(5)
            ]})
            self.assertTrue(result["emergency"]["test_mode"])
            self.assertTrue(result["emergency"]["native_lock_succeeded"])
            self.assertEqual(locks, ["lock"])
            self.assertEqual(actions, ["contain"])
            incident = supervisor.incident_store.get(result["emergency"]["incident_id"])
            self.assertIsNotNone(incident)
            self.assertGreaterEqual(incident.risk_score, 700)
            self.assertTrue(all(item.source == "emergency_test" for item in incident.evidence))
            self.assertTrue(any(item.response_scope.get("remote_address") == "198.51.100.77"
                                and item.response_scope.get("remote_port") == 4444 for item in incident.evidence))
            supervisor.emergency.resolve("483920", "release")
            self.assertEqual(actions, ["contain", "release"])
            rejected_nonce = secrets.token_hex(16)
            request_path.write_text(json.dumps({
                "pid": os.getpid(), "nonce": rejected_nonce, "requested_at": time.time(),
                "token_hmac": "0" * 64,
            }), encoding="utf-8")
            with patch("monarch_security.supervisor.read_service_heartbeat", return_value={"running": True, "integrity_ok": True}):
                supervisor._check_emergency_test_request()
            rejected = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertFalse(rejected["ok"])
            self.assertEqual(rejected["nonce"], rejected_nonce)
            self.assertEqual(actions, ["contain", "release"])
            self.assertEqual(locks, ["lock"])


class PrivilegedEmergencyBrokerTests(unittest.TestCase):
    def test_executor_derives_exact_endpoint_and_applies_short_emergency_ttl(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            calls: list[list[str]] = []
            broker = _privileged_broker(root, incidents, calls)
            result = broker.execute({"operation": "emergency_contain", "incident_id": incident.incident_id})
            self.assertTrue(result["executed"])
            self.assertEqual(calls[0][4:6], ["203.0.113.10", "443"])
            expiry = datetime.fromisoformat(result["expires_at"])
            self.assertLessEqual(expiry, datetime.now(timezone.utc) + timedelta(seconds=121))

    def test_executor_rechecks_pin_and_can_release_emergency_rules(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            incidents, incident = _emergency_incident(root)
            calls: list[list[str]] = []
            broker = _privileged_broker(root, incidents, calls)
            broker.execute({"operation": "emergency_contain", "incident_id": incident.incident_id})
            released = broker.execute({
                "operation": "emergency_resolve",
                "incident_id": incident.incident_id,
                "pin": "483920",
                "decision": "release",
            })
            self.assertTrue(released["released"])
            self.assertEqual(calls[-1][0], "remove")


def _assessment(kind: str, score: int, facts: dict, source: str = "test") -> RuleAssessment:
    return RuleAssessment(
        event=SecurityEvent(kind=kind, source=source, subject=str(facts.get("remote_address") or facts.get("pid")), facts=facts),
        score=score,
        severity="critical",
        reasons=["test"],
        route="local",
    )


def _decision() -> ActionDecision:
    return ActionDecision(action="ask_user", confidence=1.0, source="rules", reasons=["test"])


def _emergency_incident(root: Path, source: str = "test"):
    incidents = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
    correlator = IncidentCorrelator(incidents)
    first = correlator.observe(_assessment("process.started", 100, {"pid": 42}, source), _decision())
    assert first is not None
    second = correlator.observe(_assessment(
        "network.connection_seen", 90,
        {"owning_process": 42, "remote_address": "203.0.113.10", "remote_port": 443, "protocol": "tcp", "direction": "outbound"},
        source,
    ), _decision())
    assert second is not None and second.risk_score >= 700
    return incidents, second


def _manager(root: Path, incidents: IncidentStore, **kwargs) -> EmergencyManager:
    pin = SecurityPinManager(root / "pin.json", root / "integrity.key")
    if not pin.status().get("configured"):
        pin.set_pin("483920")
    return EmergencyManager(
        incidents,
        EmergencyStore(root / "emergency.jsonl", root / "integrity.key"),
        pin,
        lock_fn=kwargs.pop("lock_fn", lambda: True),
        contain_fn=kwargs.pop("contain_fn", lambda _: {"ok": True, "executed": False}),
        resolve_fn=kwargs.pop("resolve_fn", lambda _, __, decision: {"ok": True, "released": decision == "release"}),
        **kwargs,
    )


def _privileged_broker(root: Path, incidents: IncidentStore, calls: list[list[str]]) -> PrivilegedResponseBroker:
    pin = SecurityPinManager(root / "pin.json", root / "integrity.key")
    pin.set_pin("483920")
    proposals = ResponseProposalStore(root / "proposals.jsonl", root / "integrity.key")
    firewall = FirewallContainmentService(
        ResponseActionStore(root / "actions.jsonl", root / "integrity.key"),
        StateStore(root / "state.json", root / "integrity.key"),
        root / "integrity.key",
        command_runner=calls.append,
        require_elevated=False,
    )
    return PrivilegedResponseBroker(ResponseApprovalBroker(proposals, pin), firewall, incidents)


if __name__ == "__main__":
    unittest.main()
