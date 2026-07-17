from contextlib import redirect_stdout
from dataclasses import replace
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest

from monarch_security.cli import _baseline
from monarch_security.config import load_config
from monarch_security.persistence_baseline import (
    build_persistence_baseline_preview,
    persistence_baseline_digest,
)
from monarch_security.state import StateStore


class PersistenceBaselineTests(unittest.TestCase):
    def test_preview_is_bounded_and_digest_is_stable(self):
        current = {
            "run_key:added": "new",
            "run_key:changed": "after",
            "run_key:same": "same",
        }
        approved = {
            "run_key:changed": "before",
            "run_key:removed": "old",
            "run_key:same": "same",
        }
        preview = build_persistence_baseline_preview(current, approved, max_entries=2)

        self.assertEqual(preview["digest"], persistence_baseline_digest(dict(reversed(list(current.items())))))
        self.assertEqual(preview["counts"], {"added": 1, "changed": 1, "removed": 1, "unchanged": 1})
        self.assertEqual(len(preview["changes"]), 2)
        self.assertEqual(preview["changes_truncated"], 1)

    def test_explicit_baseline_separates_approved_from_rolling_last_seen(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            loaded = load_config()
            runtime = replace(
                loaded.runtime,
                state_path=root / "state.json",
                integrity_key_path=root / "integrity.key",
            )
            config = replace(loaded, root=root, runtime=runtime)
            args = SimpleNamespace(
                devices_only=False,
                installs_only=False,
                files_only=False,
                network_only=False,
                persistence_only=True,
                posture_only=False,
                self_protection_only=False,
            )
            signatures = {"run_key:vendor": '{"value":"vendor.exe"}'}
            args.expected_digest = persistence_baseline_digest(signatures)
            sensor = SimpleNamespace(snapshot_signatures=lambda: signatures, last_error=None)

            with patch("monarch_security.cli.PersistenceSensor", return_value=sensor), redirect_stdout(StringIO()):
                self.assertEqual(_baseline(args, config), 0)

            state = StateStore(runtime.state_path, runtime.integrity_key_path)
            self.assertEqual(state.get_dict("known_persistence_signatures"), signatures)
            self.assertEqual(state.get_dict("approved_persistence_signatures"), signatures)
            self.assertNotIn("integrity_error", state.data)

    def test_baseline_write_rejects_snapshot_changed_after_preview(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            loaded = load_config()
            runtime = replace(loaded.runtime, state_path=root / "state.json", integrity_key_path=root / "integrity.key")
            config = replace(loaded, root=root, runtime=runtime)
            state = StateStore(runtime.state_path, runtime.integrity_key_path)
            state.set_dict("approved_persistence_signatures", {"run_key:old": "old"})
            state.save()
            args = SimpleNamespace(
                devices_only=False, installs_only=False, files_only=False, network_only=False,
                persistence_only=True, posture_only=False, self_protection_only=False,
                expected_digest="0" * 64,
            )
            signatures = {"run_key:new": "new"}
            sensor = SimpleNamespace(snapshot_signatures=lambda: signatures, last_error=None)

            with patch("monarch_security.cli.PersistenceSensor", return_value=sensor), redirect_stdout(StringIO()):
                self.assertEqual(_baseline(args, config), 1)

            reloaded = StateStore(runtime.state_path, runtime.integrity_key_path)
            self.assertEqual(reloaded.get_dict("approved_persistence_signatures"), {"run_key:old": "old"})
            self.assertEqual(reloaded.get_dict("known_persistence_signatures"), {})


if __name__ == "__main__":
    unittest.main()
