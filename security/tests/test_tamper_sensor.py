from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from monarch_security.analysis import RuleEngine
from monarch_security.config import RouterConfig
from monarch_security.sensors import TamperSensor


class TamperSensorTests(unittest.TestCase):
    def test_change_and_removal_emit_critical_self_protection_event(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "protected.toml"
            path.write_text("enabled=true\n", encoding="utf-8")
            sensor = TamperSensor([path])
            self.assertEqual(sensor.poll(), [])
            baseline = sensor.signatures

            path.write_text("enabled=false\n", encoding="utf-8")
            events = sensor.poll()
            self.assertEqual(len(events), 1)
            self.assertTrue(events[0].facts["self_protection_violation"])
            assessment = RuleEngine(RouterConfig()).assess(events[0])
            self.assertEqual(assessment.score, 100)

            path.unlink()
            removed = sensor.poll()
            self.assertEqual(len(removed), 1)
            self.assertTrue(removed[0].facts["missing"])
            self.assertNotEqual(baseline, sensor.signatures)

    def test_persisted_signature_detects_change_on_first_poll(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "protected.py"
            path.write_text("value = 1\n", encoding="utf-8")
            first = TamperSensor([path])
            first.poll()
            baseline = first.signatures
            path.write_text("value = 2\n", encoding="utf-8")

            restarted = TamperSensor([path], initial_signatures=baseline)
            self.assertEqual(len(restarted.poll()), 1)


if __name__ == "__main__":
    unittest.main()
