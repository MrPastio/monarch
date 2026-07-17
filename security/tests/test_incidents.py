import json
import unittest
import contextlib
from unittest import mock
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory

from monarch_security.analysis import RuleEngine
from monarch_security.audit import AuditLog
from monarch_security.cli import main as cli_main
from monarch_security.config import NotificationConfig, load_config
from monarch_security.control import protector_status
from monarch_security.events import ActionDecision, RuleAssessment, SecurityEvent
from monarch_security.incidents import (
    IncidentCorrelator,
    IncidentEvidence,
    IncidentStore,
    IncidentStoreIntegrityError,
    ResponseProposal,
    build_attack_chain,
    calculate_incident_risk,
    correlation_key,
    read_incident_summary,
    risk_level,
)
from monarch_security.llm import LLMRouter
from monarch_security.notifications import NotificationManager
from monarch_security.policy import PolicyEngine
from monarch_security.resources import ResourceGuard
from monarch_security.state import StateStore
from monarch_security.supervisor import SecuritySupervisor


def _assessment(kind: str, score: int, facts: dict, source: str = "test_sensor") -> RuleAssessment:
    event = SecurityEvent(
        kind=kind,
        source=source,
        subject=str(facts.get("path") or facts.get("remote_address") or facts.get("pid") or kind),
        facts=facts,
    )
    return RuleAssessment(
        event=event,
        score=score,
        severity="critical" if score >= 85 else "high" if score >= 65 else "medium",
        reasons=[f"test score {score}"],
        route="local",
    )


def _decision() -> ActionDecision:
    return ActionDecision(
        action="ask_user",
        confidence=0.8,
        source="rules",
        reasons=["test"],
    )


class IncidentRiskTests(unittest.TestCase):
    def test_process_correlation_includes_creation_time_to_survive_pid_reuse(self):
        first = _assessment(
            "process.started",
            68,
            {"pid": 42, "create_time": 1_700_000_000.125},
        )
        reused = _assessment(
            "process.started",
            68,
            {"pid": 42, "create_time": 1_700_000_120.625},
        )
        network = _assessment(
            "network.connection_seen",
            68,
            {"owning_process": 42, "process_start_time": 1_700_000_000.125},
        )

        self.assertEqual(correlation_key(first), correlation_key(network))
        self.assertNotEqual(correlation_key(first), correlation_key(reused))

    def test_single_deterministic_signal_cannot_reach_emergency(self):
        evidence = [IncidentEvidence.from_assessment(_assessment("process.started", 100, {"pid": 10}))]

        score, eligible = calculate_incident_risk(evidence)

        self.assertEqual(score, 400)
        self.assertFalse(eligible)
        self.assertEqual(risk_level(score), "high")

    def test_llm_only_evidence_contributes_no_risk(self):
        evidence = [
            IncidentEvidence.from_assessment(
                _assessment("process.started", 100, {"pid": 10}, source="llm_router")
            )
        ]

        score, eligible = calculate_incident_risk(evidence)

        self.assertEqual(score, 0)
        self.assertFalse(eligible)

    def test_two_independent_critical_families_can_reach_emergency(self):
        evidence = [
            IncidentEvidence.from_assessment(_assessment("process.started", 100, {"pid": 10})),
            IncidentEvidence.from_assessment(
                _assessment("network.connection_seen", 100, {"owning_process": 10, "remote_address": "8.8.8.8"})
            ),
        ]

        score, eligible = calculate_incident_risk(evidence)

        self.assertEqual(score, 700)
        self.assertTrue(eligible)
        self.assertEqual(risk_level(score), "emergency")

    def test_trusted_verdict_needs_harmful_behavior_for_emergency(self):
        verdict_only = IncidentEvidence.from_assessment(
            _assessment(
                "file.scanned",
                100,
                {"path": "sample.exe", "virustotal_malicious": True},
                source="deep_file_scanner",
            )
        )
        verdict_and_behavior = IncidentEvidence.from_assessment(
            _assessment(
                "file.scanned",
                100,
                {
                    "path": "sample.exe",
                    "virustotal_malicious": True,
                    "remote_control_behavior": True,
                },
                source="deep_file_scanner",
            )
        )

        score_only, eligible_only = calculate_incident_risk([verdict_only])
        score_chain, eligible_chain = calculate_incident_risk([verdict_and_behavior])

        self.assertEqual(score_only, 400)
        self.assertFalse(eligible_only)
        self.assertEqual(score_chain, 720)
        self.assertTrue(eligible_chain)

    def test_attack_chain_links_only_deterministic_shared_entities(self):
        process = IncidentEvidence.from_assessment(
            _assessment("process.started", 90, {"pid": 42, "path": r"C:\sample.exe"})
        )
        network = IncidentEvidence.from_assessment(
            _assessment(
                "network.connection_seen",
                85,
                {"owning_process": 42, "remote_address": "203.0.113.7", "remote_port": 4444},
            )
        )
        advisory = IncidentEvidence.from_assessment(
            _assessment("process.advisory", 100, {"pid": 42}, source="llm_router")
        )

        graph = build_attack_chain([process, network, advisory])

        self.assertEqual(len(graph["nodes"]), 3)
        self.assertEqual(len(graph["edges"]), 1)
        self.assertEqual(graph["edges"][0]["relation"], "shared_process")
        self.assertEqual(graph["connected_families"], ["network", "process"])
        self.assertTrue(graph["corroborated"])
        self.assertFalse(graph["affects_risk_score"])
        self.assertNotIn("42", graph["edges"][0]["entity_sha256"])


class IncidentStoreTests(unittest.TestCase):
    def test_clean_events_stay_out_of_durable_incident_inbox(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
            incident = IncidentCorrelator(store).observe(
                _assessment("process.started", 0, {"pid": 123}),
                _decision(),
            )

            self.assertIsNone(incident)
            self.assertEqual(store.summary()["open"], 0)
            self.assertEqual(store.list_latest(), [])

    def test_correlator_merges_process_and_network_evidence_by_pid(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
            correlator = IncidentCorrelator(store)

            first = correlator.observe(_assessment("process.started", 100, {"pid": 42}), _decision())
            second = correlator.observe(
                _assessment(
                    "network.connection_seen",
                    100,
                    {"owning_process": 42, "remote_address": "8.8.8.8", "remote_port": 4444},
                ),
                _decision(),
            )

            self.assertEqual(first.incident_id, second.incident_id)
            self.assertEqual(second.risk_score, 700)
            self.assertEqual(second.risk_level, "emergency")
            self.assertEqual(second.evidence_families, ("network", "process"))
            self.assertTrue(second.decision_required)
            self.assertTrue(second.emergency_eligible)
            self.assertIn("block_network", second.recommended_actions)
            self.assertIn("suspend_process", second.recommended_actions)
            self.assertEqual(store.summary()["open"], 1)

    def test_correlator_does_not_merge_reused_pid_with_new_creation_time(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
            correlator = IncidentCorrelator(store)

            first = correlator.observe(
                _assessment("process.started", 100, {"pid": 42, "create_time": 10.0}),
                _decision(),
            )
            reused = correlator.observe(
                _assessment("process.started", 100, {"pid": 42, "create_time": 20.0}),
                _decision(),
            )

            self.assertNotEqual(first.incident_id, reused.incident_id)
            self.assertEqual(store.summary()["open"], 2)

    def test_store_detects_tampering(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "incidents.jsonl"
            key_path = root / "integrity.key"
            store = IncidentStore(path, key_path)
            IncidentCorrelator(store).observe(
                _assessment("process.started", 70, {"pid": 99}),
                _decision(),
            )
            record = json.loads(path.read_text(encoding="utf-8").strip())
            record["incident"]["risk_score"] = 0
            path.write_text(json.dumps(record) + "\n", encoding="utf-8")

            with self.assertRaises(IncidentStoreIntegrityError):
                IncidentStore(path, key_path)

    def test_user_confirmed_dismissal_removes_incident_from_open_summary(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
            incident = IncidentCorrelator(store).observe(
                _assessment("file.scanned", 100, {"path": r"C:\sample.exe"}),
                _decision(),
            )
            self.assertIsNotNone(incident)

            dismissed = store.update_status(
                incident.incident_id,
                "dismissed",
                reason="Known developer change",
            )

            self.assertEqual(dismissed.status, "dismissed")
            self.assertFalse(dismissed.decision_required)
            self.assertEqual(dismissed.resolution["source"], "explicit_user_confirmation")
            self.assertEqual(store.summary()["open"], 0)

    def test_long_lived_store_refreshes_lifecycle_updates_from_another_writer(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "incidents.jsonl"
            key_path = root / "integrity.key"
            supervisor_store = IncidentStore(path, key_path)
            incident = IncidentCorrelator(supervisor_store).observe(
                _assessment("file.scanned", 100, {"path": r"C:\sample.exe"}),
                _decision(),
            )
            self.assertEqual(supervisor_store.summary()["open"], 1)

            with mock.patch.object(supervisor_store, "_read_all", wraps=supervisor_store._read_all) as read_all:
                self.assertEqual(supervisor_store.summary()["open"], 1)
                self.assertEqual(supervisor_store.summary()["open"], 1)
                read_all.assert_not_called()

                cli_store = IncidentStore(path, key_path)
                cli_store.update_status(incident.incident_id, "dismissed", reason="Known developer change")

                self.assertEqual(supervisor_store.summary()["open"], 0)
                self.assertEqual(read_all.call_count, 1)
                self.assertEqual(supervisor_store.get(incident.incident_id).status, "dismissed")
                self.assertEqual(read_all.call_count, 1)

    def test_missing_store_summary_does_not_create_integrity_key(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            key_path = root / "integrity.key"

            summary = read_incident_summary(root / "incidents.jsonl", key_path)

            self.assertTrue(summary["integrity_ok"])
            self.assertEqual(summary["total"], 0)
            self.assertFalse(key_path.exists())

    def test_bounded_journal_compacts_and_records_pruned_archive_hashes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "incidents.jsonl"
            key_path = root / "integrity.key"
            store = IncidentStore(path, key_path, max_bytes=3500, max_archives=1)
            correlator = IncidentCorrelator(store)

            for index in range(12):
                correlator.observe(
                    _assessment(
                        "process.started",
                        90,
                        {"pid": 42, "sequence": index, "detail": "x" * 300},
                    ),
                    _decision(),
                )

            self.assertLessEqual(len(store._archive_paths()), 1)
            self.assertEqual(store.summary()["total"], 1)
            self.assertTrue(store.retention_log_path.exists())
            integrity = store.retention_integrity()
            self.assertTrue(integrity["ok"])
            self.assertGreaterEqual(integrity["retention_ledger"]["records"], 1)
            self.assertLessEqual(len(path.read_text(encoding="utf-8").splitlines()), 2)

    def test_retention_integrity_detects_archive_tampering(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = IncidentStore(root / "incidents.jsonl", root / "integrity.key", max_bytes=2500)
            correlator = IncidentCorrelator(store)
            for index in range(5):
                correlator.observe(
                    _assessment("process.started", 90, {"pid": 7, "detail": f"{index}" * 500}),
                    _decision(),
                )
            archive = store._archive_paths()[0]
            archive.write_bytes(archive.read_bytes() + b"{}\n")

            self.assertFalse(store.retention_integrity()["ok"])


class ResponseProposalTests(unittest.TestCase):
    def test_destructive_proposal_always_requires_confirmation_and_pin(self):
        proposal = ResponseProposal.create(
            incident_id="incident-1",
            action="delete",
            scope={"path": r"C:\Users\Example\Downloads\bad.exe"},
            rationale=["User selected permanent deletion"],
            proposed_by="llm",
        )

        self.assertTrue(proposal.requires_user_confirmation)
        self.assertTrue(proposal.requires_security_pin)
        self.assertFalse(proposal.approved)

    def test_proposal_rejects_unknown_action_and_unbounded_scope(self):
        with self.assertRaises(ValueError):
            ResponseProposal.create("incident-1", "run_powershell", {"pid": 1}, [], "llm")
        with self.assertRaises(ValueError):
            ResponseProposal.create("incident-1", "isolate", {"command": "whoami"}, [], "llm")


class IncidentIntegrationTests(unittest.TestCase):
    def test_supervisor_records_incident_and_truthful_heartbeat(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = _config_path(root)
            config = load_config(config_path)
            policy = PolicyEngine(config.policy)
            resources = ResourceGuard(config.resources)
            supervisor = SecuritySupervisor(
                config=config,
                resources=resources,
                rules=RuleEngine(config.router),
                router=LLMRouter(config, resources, policy),
                policy=policy,
                audit=AuditLog(
                    config.runtime.audit_log_path,
                    max_bytes=0,
                    stdout=False,
                    integrity_key_path=config.runtime.integrity_key_path,
                ),
                state=StateStore(config.runtime.state_path, config.runtime.integrity_key_path),
                no_llm=True,
            )
            supervisor.notifications = NotificationManager(
                NotificationConfig(enabled=False, windows_toast=False, console_bell=False)
            )

            supervisor._handle_event(
                SecurityEvent(
                    kind="process.started",
                    source="test_sensor",
                    subject="powershell.exe",
                    facts={
                        "pid": 123,
                        "name": "powershell.exe",
                        "exe": r"C:\Users\Example\Downloads\update.exe",
                        "cmdline": ["powershell.exe", "-EncodedCommand", "downloadstring", "iex"],
                        "parent_name": "WINWORD.EXE",
                    },
                )
            )
            supervisor._write_heartbeat("running")

            heartbeat = json.loads(config.runtime.heartbeat_path.read_text(encoding="utf-8"))
            self.assertEqual(heartbeat["protection_state"], "protected")
            self.assertEqual(heartbeat["incidents"]["open"], 1)
            self.assertGreaterEqual(heartbeat["incidents"]["highest_risk"], 250)
            self.assertTrue(config.runtime.incident_log_path.exists())

            with (
                mock.patch("monarch_security.supervisor.os.replace", side_effect=PermissionError("locked")),
                mock.patch("monarch_security.supervisor.time.sleep"),
            ):
                supervisor._write_heartbeat("running")
            self.assertTrue(supervisor._heartbeat_write_error_reported)
            self.assertEqual(list(config.runtime.heartbeat_path.parent.glob("*.tmp")), [])

    def test_cli_lists_incidents_and_status_exposes_summary(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = _config_path(root)
            config = load_config(config_path)
            store = IncidentStore(
                config.runtime.incident_log_path,
                config.runtime.integrity_key_path,
            )
            IncidentCorrelator(store).observe(
                _assessment("process.started", 80, {"pid": 55}),
                _decision(),
            )
            output = StringIO()
            with contextlib.redirect_stdout(output):
                code = cli_main(["--config", str(config_path), "incidents", "--limit", "10"])
            payload = json.loads(output.getvalue().splitlines()[-1])
            status = protector_status(config)

            self.assertEqual(code, 0)
            self.assertTrue(payload["ok"])
            self.assertEqual(len(payload["incidents"]), 1)
            self.assertEqual(payload["summary"]["open"], 1)
            self.assertFalse(status["running"])
            self.assertEqual(status["protection_state"], "stopped")
            self.assertEqual(status["incidents"]["open"], 1)


def _config_path(root: Path) -> Path:
    path = root / "monarch_security.toml"
    path.write_text(
        """
[file_watch]
enabled = false

[network]
enabled = false

[persistence]
enabled = false

[posture]
enabled = false

[notifications]
enabled = false
windows_toast = false
console_bell = false

[runtime]
state_path = "data/state.json"
audit_log_path = "logs/audit.jsonl"
incident_log_path = "data/incidents.jsonl"
pid_path = "data/protector.pid"
control_path = "data/protector.stop"
control_token_path = "data/protector.control.key"
heartbeat_path = "data/protector_heartbeat.json"
integrity_key_path = "data/integrity.key"
stdout_events = false
process_monitor_enabled = false
device_monitor_enabled = false
install_monitor_enabled = false
""".strip()
        + "\n",
        encoding="utf-8",
    )
    return path


if __name__ == "__main__":
    unittest.main()
