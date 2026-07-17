from __future__ import annotations

import unittest

from monarch_security.analysis import RuleEngine
from monarch_security.behavior import FileBurstDetector
from monarch_security.config import RouterConfig
from monarch_security.events import SecurityEvent


class FileBurstDetectorTests(unittest.TestCase):
    def test_distinct_file_burst_emits_high_risk_ransomware_signal(self) -> None:
        detector = FileBurstDetector(window_seconds=10, file_threshold=5, cooldown_seconds=30)
        emitted = None
        for index in range(5):
            emitted = detector.observe(
                SecurityEvent(
                    kind="file.observed",
                    source="file_watch_sensor",
                    subject=f"C:\\Users\\test\\Documents\\file-{index}.docx",
                    facts={
                        "path": f"C:\\Users\\test\\Documents\\file-{index}.docx",
                        "extension": ".docx",
                    },
                ),
                now=100 + index,
            )

        self.assertIsNotNone(emitted)
        self.assertEqual(emitted.source, "ransomware_burst_detector")
        self.assertTrue(emitted.facts["ransomware_behavior"])
        assessment = RuleEngine(RouterConfig()).assess(emitted)
        self.assertEqual(assessment.score, 100)
        self.assertEqual(assessment.severity, "critical")

    def test_repeated_change_to_one_file_does_not_trigger(self) -> None:
        detector = FileBurstDetector(window_seconds=10, file_threshold=5)
        for index in range(20):
            emitted = detector.observe(
                SecurityEvent(
                    kind="file.observed",
                    source="file_watch_sensor",
                    subject="C:\\tmp\\same.txt",
                    facts={"path": "C:\\tmp\\same.txt", "extension": ".txt"},
                ),
                now=100 + index * 0.2,
            )
            self.assertIsNone(emitted)

    def test_alert_has_cooldown(self) -> None:
        detector = FileBurstDetector(window_seconds=10, file_threshold=5, cooldown_seconds=30)
        first = None
        for index in range(5):
            first = detector.observe(_event(index), now=100 + index)
        self.assertIsNotNone(first)
        for index in range(5, 10):
            self.assertIsNone(detector.observe(_event(index), now=106 + index * 0.1))


def _event(index: int) -> SecurityEvent:
    path = f"C:\\tmp\\file-{index}.txt"
    return SecurityEvent(
        kind="file.observed",
        source="file_watch_sensor",
        subject=path,
        facts={"path": path, "extension": ".txt"},
    )


if __name__ == "__main__":
    unittest.main()
