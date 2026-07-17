from __future__ import annotations

from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from monarch_security.analysis import RuleEngine
from monarch_security.cli import _set_device_trust
from monarch_security.config import RouterConfig, load_config
from monarch_security.events import SecurityEvent
from monarch_security.state import StateStore
from monarch_security.supervisor import _with_device_trust


class DeviceTrustTests(unittest.TestCase):
    def test_unknown_usb_storage_requires_review_but_trusted_device_is_clean(self) -> None:
        event = SecurityEvent(
            kind="device.connected",
            source="device_sensor",
            subject="USB storage",
            facts={
                "instance_id": r"USB\VID_1234&PID_5678\A",
                "class": "DiskDrive",
                "friendly_name": "USB Mass Storage",
                "status": "OK",
            },
        )
        rules = RuleEngine(RouterConfig())
        untrusted = _with_device_trust(event, set())
        untrusted_assessment = rules.assess(untrusted)
        self.assertGreaterEqual(untrusted_assessment.score, 65)
        self.assertEqual(untrusted.facts["device_trust_state"], "untrusted")

        trusted = _with_device_trust(event, {r"usb\vid_1234&pid_5678\a"})
        trusted_assessment = rules.assess(trusted)
        self.assertEqual(trusted_assessment.score, 0)
        self.assertEqual(trusted.facts["device_trust_state"], "trusted")

    def test_trust_registry_requires_explicit_confirmation_and_persists(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config_dir = root / "config"
            config_dir.mkdir()
            config_path = config_dir / "monarch_security.toml"
            config_path.write_text(
                "[runtime]\nstate_path='data/state.json'\naudit_log_path='logs/audit.jsonl'\nintegrity_key_path='data/integrity.key'\n",
                encoding="utf-8",
            )
            config = load_config(config_path)
            denied = SimpleNamespace(
                confirm_trust=False,
                confirm_untrust=False,
                instance_id=r"USB\VID_TEST",
            )
            with redirect_stdout(StringIO()):
                self.assertEqual(_set_device_trust(denied, config, trusted=True), 2)
            self.assertFalse(config.runtime.state_path.exists())

            approved = SimpleNamespace(
                confirm_trust=True,
                confirm_untrust=False,
                instance_id=r"USB\VID_TEST",
            )
            with redirect_stdout(StringIO()):
                self.assertEqual(_set_device_trust(approved, config, trusted=True), 0)
            state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
            self.assertEqual(state.get_list("trusted_device_ids"), [r"usb\vid_test"])


if __name__ == "__main__":
    unittest.main()
