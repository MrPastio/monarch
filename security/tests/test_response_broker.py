from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from monarch_security.events import ActionDecision, RuleAssessment, SecurityEvent
from monarch_security.incidents import IncidentCorrelator, IncidentStore
from monarch_security.responses import (
    ResponseBrokerError,
    ResponseProposalStore,
    ResponseStoreIntegrityError,
    ShadowResponseBroker,
    StoredProposal,
)


class ShadowResponseBrokerTests(unittest.TestCase):
    def test_llm_can_propose_isolation_but_cannot_authorize_or_execute(self) -> None:
        with TemporaryDirectory() as directory:
            broker, incident, proposals = _broker(Path(directory), kind="file.scanned", score=80)
            stored = broker.propose(
                incident_id=incident.incident_id,
                action="isolate",
                scope={"path": r"C:\Users\test\Downloads\sample.exe"},
                rationale=["Unsigned executable with suspicious behavior"],
                proposed_by="llm",
            )

            decision = broker.evaluate(stored.proposal.proposal_id)
            self.assertEqual(decision["mode"], "shadow")
            self.assertFalse(decision["authorized"])
            self.assertFalse(decision["executed"])
            self.assertTrue(decision["requires_user_confirmation"])
            self.assertEqual(len(proposals.list_latest()), 1)

    def test_network_and_process_actions_require_matching_evidence_and_score(self) -> None:
        with TemporaryDirectory() as directory:
            broker, incident, _ = _broker(Path(directory), kind="file.scanned", score=80)
            with self.assertRaisesRegex(ResponseBrokerError, "Network containment"):
                broker.propose(
                    incident_id=incident.incident_id,
                    action="block_network",
                    scope={"remote_address": "8.8.8.8", "remote_port": 443},
                    rationale=[],
                    proposed_by="rules",
                )

    def test_network_proposal_is_expiring_bounded_and_never_executed(self) -> None:
        with TemporaryDirectory() as directory:
            broker, incident, _ = _broker(Path(directory), kind="network.connection_seen", score=100)
            stored = broker.propose(
                incident_id=incident.incident_id,
                action="block_network",
                    scope={"remote_address": "203.0.113.10", "remote_port": 443, "protocol": "tcp", "direction": "outbound"},
                rationale=["Correlated high-risk network evidence"],
                proposed_by="rules",
                ttl_seconds=99_999,
            )
            decision = broker.evaluate(stored.proposal.proposal_id)
            expiry = datetime.fromisoformat(stored.proposal.expires_at or "")
            self.assertLessEqual(expiry, datetime.now(timezone.utc) + timedelta(seconds=3601))
            self.assertFalse(decision["authorized"])
            self.assertFalse(decision["executed"])

    def test_network_proposal_rejects_unbounded_or_invalid_scope(self) -> None:
        with TemporaryDirectory() as directory:
            broker, incident, _ = _broker(Path(directory), kind="network.connection_seen", score=100)
            for scope in (
                {"remote_address": "not-an-ip", "remote_port": 443},
                {"remote_address": "203.0.113.10", "remote_port": 0},
                {"remote_address": "203.0.113.10", "remote_port": 443, "all_hosts": True},
            ):
                with self.assertRaises(ResponseBrokerError):
                    broker.propose(
                        incident_id=incident.incident_id,
                        action="block_network",
                        scope=scope,
                        rationale=[],
                        proposed_by="rules",
                    )

    def test_network_proposal_cannot_target_endpoint_outside_incident_evidence(self) -> None:
        with TemporaryDirectory() as directory:
            broker, incident, _ = _broker(Path(directory), kind="network.connection_seen", score=100)
            with self.assertRaisesRegex(ResponseBrokerError, "does not match incident evidence"):
                broker.propose(
                    incident_id=incident.incident_id,
                    action="block_network",
                    scope={"remote_address": "198.51.100.50", "remote_port": 443, "protocol": "tcp", "direction": "outbound"},
                    rationale=[],
                    proposed_by="rules",
                )

    def test_destructive_action_requires_emergency_eligible_incident(self) -> None:
        with TemporaryDirectory() as directory:
            broker, incident, _ = _broker(Path(directory), kind="file.scanned", score=100)
            with self.assertRaisesRegex(ResponseBrokerError, "emergency-eligible"):
                broker.propose(
                    incident_id=incident.incident_id,
                    action="delete",
                    scope={"path": r"C:\Users\test\Downloads\sample.exe"},
                    rationale=[],
                    proposed_by="user",
                )

    def test_expired_proposal_is_never_authorized(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            broker, incident, proposals = _broker(root, kind="file.scanned", score=80)
            stored = broker.propose(
                incident_id=incident.incident_id,
                action="isolate",
                scope={"path": r"C:\Users\test\Downloads\sample.exe"},
                rationale=[],
                proposed_by="rules",
            )
            past = datetime.now(timezone.utc) - timedelta(minutes=1)
            expired_proposal = stored.proposal.__class__(
                **{**stored.proposal.__dict__, "expires_at": past.isoformat()}
            )
            proposals.append(StoredProposal(expired_proposal, "proposed", "test", past.isoformat()))

            decision = broker.evaluate(stored.proposal.proposal_id)
            self.assertEqual(decision["status"], "expired")
            self.assertFalse(decision["authorized"])

    def test_proposal_store_detects_tampering(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            broker, incident, proposals = _broker(root, kind="file.scanned", score=80)
            broker.propose(
                incident_id=incident.incident_id,
                action="isolate",
                scope={"path": r"C:\Users\test\Downloads\sample.exe"},
                rationale=[],
                proposed_by="rules",
            )
            payload = json.loads(proposals.path.read_text(encoding="utf-8"))
            payload["stored_proposal"]["status"] = "rejected"
            proposals.path.write_text(json.dumps(payload) + "\n", encoding="utf-8")

            with self.assertRaisesRegex(ResponseStoreIntegrityError, "integrity mismatch"):
                ResponseProposalStore(proposals.path, root / "integrity.key")


def _broker(root: Path, *, kind: str, score: int):
    facts = {"path": r"C:\Users\test\Downloads\sample.exe", "pid": 42}
    subject = r"C:\Users\test\Downloads\sample.exe"
    if kind.startswith("network."):
        facts = {"remote_address": "203.0.113.10", "remote_port": 443, "protocol": "tcp", "direction": "outbound"}
        subject = "203.0.113.10:443"
    incidents = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
    incident = IncidentCorrelator(incidents).observe(
        RuleAssessment(
            event=SecurityEvent(
                kind=kind,
                source="test",
                subject=subject,
                facts=facts,
            ),
            score=score,
            severity="critical",
            reasons=["test evidence"],
            route="local",
        ),
        ActionDecision(
            action="ask_user",
            confidence=1.0,
            source="rules",
            reasons=["test"],
        ),
    )
    assert incident is not None
    proposals = ResponseProposalStore(root / "responses.jsonl", root / "integrity.key")
    return ShadowResponseBroker(incidents, proposals), incident, proposals


if __name__ == "__main__":
    unittest.main()
