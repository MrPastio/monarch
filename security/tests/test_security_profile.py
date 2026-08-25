from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from monarch_security.config import load_config
from monarch_security.profile import (
    MODEL_COMMAND_POLICY_SCHEMA_VERSION,
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
            self.assertEqual(default_policy.action_guard_reaction, "guard")
            self.assertIsNone(default_policy.agent_security_mode)
            self.assertEqual(default_policy.schema_version, MODEL_COMMAND_POLICY_SCHEMA_VERSION)
            self.assertEqual(default_policy.to_dict()["schema_version"], MODEL_COMMAND_POLICY_SCHEMA_VERSION)
            saved_policy = write_model_command_policy(
                config,
                enabled=False,
                confirmation_mode="always",
            )
            self.assertFalse(saved_policy.enabled)
            self.assertEqual(read_model_command_policy(config).confirmation_mode, "always")
            self.assertEqual(read_model_command_policy(config).action_guard_reaction, "confirm-all")

            observed_policy = write_model_command_policy(
                config,
                enabled=True,
                action_guard_reaction="observe",
            )
            self.assertTrue(observed_policy.enabled)
            self.assertEqual(observed_policy.action_guard_reaction, "observe")
            self.assertEqual(observed_policy.confirmation_mode, "adaptive")

            strict_policy = write_model_command_policy(
                config,
                enabled=True,
                action_guard_reaction="confirm-all",
                agent_security_mode="strict",
            )
            self.assertEqual(strict_policy.agent_security_mode, "strict")
            self.assertEqual(read_model_command_policy(config).agent_security_mode, "strict")
            self.assertEqual(read_model_command_policy(config).schema_version, MODEL_COMMAND_POLICY_SCHEMA_VERSION)

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
            with self.assertRaisesRegex(ValueError, "unsupported"):
                write_model_command_policy(config, enabled=True, action_guard_reaction="ignore-everything")
            with self.assertRaisesRegex(ValueError, "unsupported"):
                write_model_command_policy(config, enabled=True, action_guard_reaction="guard", agent_security_mode="reckless")


if __name__ == "__main__":
    unittest.main()
