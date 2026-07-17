from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from monarch_security.analysis import RuleEngine
from monarch_security.config import RouterConfig
from monarch_security.events import RuleAssessment, SecurityEvent
from monarch_security.network_history import (
    NetworkHistoryIntegrityError,
    NetworkHistoryStore,
    NetworkObservation,
    network_profile_id,
    with_network_profile_trust,
)


class NetworkHistoryTests(unittest.TestCase):
    def test_history_is_hmac_chained_and_queryable(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = NetworkHistoryStore(root / "network.jsonl", root / "integrity.key")
            assessment = RuleAssessment(
                event=SecurityEvent(
                    kind="network.connection_seen",
                    source="network_sensor",
                    subject="8.8.8.8:443",
                    facts={
                        "remote_address": "8.8.8.8",
                        "remote_port": 443,
                        "remote_scope": "public",
                        "remote_is_public": True,
                        "owning_process": 42,
                        "process_name": "browser.exe",
                    },
                ),
                score=8,
                severity="low",
                reasons=["public connection"],
                route="local",
            )
            store.append(NetworkObservation.from_assessment(assessment))

            reloaded = NetworkHistoryStore(store.path, root / "integrity.key")
            self.assertEqual(len(reloaded.list_recent()), 1)
            self.assertEqual(reloaded.summary()["connections"], 1)
            self.assertEqual(reloaded.list_recent()[0].facts["remote_address"], "8.8.8.8")

    def test_history_tampering_is_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = NetworkHistoryStore(root / "network.jsonl", root / "integrity.key")
            store.append(NetworkObservation.from_assessment(_config_assessment()))
            payload = json.loads(store.path.read_text(encoding="utf-8"))
            payload["observation"]["risk_score"] = 100
            store.path.write_text(json.dumps(payload) + "\n", encoding="utf-8")

            with self.assertRaisesRegex(NetworkHistoryIntegrityError, "integrity mismatch"):
                NetworkHistoryStore(store.path, root / "integrity.key")

    def test_network_profile_fingerprint_is_stable_and_trust_changes_risk(self) -> None:
        first = _config_assessment().event
        reordered = SecurityEvent(
            kind=first.kind,
            source=first.source,
            subject=first.subject,
            facts={**first.facts, "dns": ["1.1.1.1", "8.8.8.8"]},
        )
        self.assertEqual(network_profile_id(first.facts), network_profile_id(reordered.facts))
        profile_id = network_profile_id(first.facts)
        rules = RuleEngine(RouterConfig())
        untrusted = rules.assess(with_network_profile_trust(first, set()))
        trusted = rules.assess(with_network_profile_trust(first, {profile_id}))

        self.assertFalse(untrusted.event.facts["network_profile_trusted"])
        self.assertTrue(trusted.event.facts["network_profile_trusted"])
        self.assertGreater(untrusted.score, trusted.score)

    def test_multiple_writers_preserve_one_integrity_chain(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = NetworkHistoryStore(root / "network.jsonl", root / "integrity.key")
            second = NetworkHistoryStore(root / "network.jsonl", root / "integrity.key")
            first.append(NetworkObservation.from_assessment(_config_assessment()))
            second.append(NetworkObservation.from_assessment(_config_assessment()))
            reopened = NetworkHistoryStore(root / "network.jsonl", root / "integrity.key")
            self.assertEqual(len(reopened.list_recent()), 2)


def _config_assessment() -> RuleAssessment:
    event = SecurityEvent(
        kind="network.config_changed",
        source="network_sensor",
        subject="Wi-Fi",
        facts={
            "interface_alias": "Wi-Fi",
            "ipv4": ["192.168.1.20/24"],
            "dns": ["8.8.8.8", "1.1.1.1"],
            "gateway": ["192.168.1.1"],
        },
    )
    event = with_network_profile_trust(event, set())
    return RuleAssessment(
        event=event,
        score=45,
        severity="medium",
        reasons=["untrusted profile"],
        route="deep_scan",
    )


if __name__ == "__main__":
    unittest.main()
