from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from monarch_security.config import load_config
from monarch_security.profile import (
    read_model_command_policy,
    read_security_profile,
    write_model_command_policy,
    write_security_profile,
)


class SecurityProfileTests(unittest.TestCase):
    def test_defaults_to_calm_balanced_profile_and_persists_changes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config = load_config()
            config = replace(
                config,
                runtime=replace(
                    config.runtime,
                    state_path=root / "state.json",
                    integrity_key_path=root / "integrity.key",
                ),
            )

            balanced = read_security_profile(config)
            self.assertEqual(balanced.level, "balanced")
            self.assertEqual(balanced.interval_multiplier, 1.0)
            self.assertTrue(balanced.monitoring_enabled)

            maximum = write_security_profile(config, "maximum")
            self.assertEqual(maximum.level, "maximum")
            self.assertLess(maximum.interval_multiplier, 1.0)
            self.assertEqual(read_security_profile(config).level, "maximum")

            off = write_security_profile(config, "off")
            self.assertFalse(off.monitoring_enabled)

            default_policy = read_model_command_policy(config)
            self.assertTrue(default_policy.enabled)
            self.assertEqual(default_policy.confirmation_mode, "adaptive")
            saved_policy = write_model_command_policy(
                config,
                enabled=False,
                confirmation_mode="always",
            )
            self.assertFalse(saved_policy.enabled)
            self.assertEqual(read_model_command_policy(config).confirmation_mode, "always")

    def test_rejects_unknown_profile(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config = load_config()
            config = replace(
                config,
                runtime=replace(
                    config.runtime,
                    state_path=root / "state.json",
                    integrity_key_path=root / "integrity.key",
                ),
            )
            with self.assertRaisesRegex(ValueError, "unsupported"):
                write_security_profile(config, "paranoid-plus")
            with self.assertRaisesRegex(ValueError, "unsupported"):
                write_model_command_policy(config, enabled=True, confirmation_mode="sometimes")


if __name__ == "__main__":
    unittest.main()
