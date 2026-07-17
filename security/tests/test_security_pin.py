from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from contextlib import redirect_stdout
from io import StringIO

from monarch_security.pin import (
    SecurityPinError,
    SecurityPinIntegrityError,
    SecurityPinManager,
    read_pin_status,
)
from monarch_security.cli import main as cli_main


class SecurityPinTests(unittest.TestCase):
    def test_status_is_read_only_before_pin_setup(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            status = read_pin_status(root / "pin.json", root / "integrity.key")
            self.assertFalse(status["configured"])
            self.assertFalse((root / "integrity.key").exists())

    def test_pin_is_scrypt_hashed_and_verifies(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "pin.json"
            manager = SecurityPinManager(path, root / "integrity.key")
            manager.set_pin("483920")

            raw = path.read_text(encoding="utf-8")
            self.assertNotIn("483920", raw)
            payload = json.loads(raw)
            self.assertEqual(payload["algorithm"], "scrypt")
            self.assertTrue(manager.verify("483920").ok)
            self.assertFalse(manager.verify("111111").ok)

    def test_setup_returns_one_time_recovery_codes_but_stores_only_hashes(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "pin.json"
            result = SecurityPinManager(path, root / "integrity.key").set_pin("483920")
            codes = result["recovery_codes"]
            self.assertEqual(len(codes), 8)
            self.assertEqual(len(set(codes)), 8)
            self.assertTrue(all(len(code) == 24 and code.count("-") == 4 for code in codes))
            raw = path.read_text(encoding="utf-8")
            self.assertTrue(all(code not in raw for code in codes))
            payload = json.loads(raw)
            self.assertEqual(payload["schema"], 2)
            self.assertEqual(len(payload["recovery_digests"]), 8)
            self.assertNotIn("recovery_codes", payload)

    def test_one_time_recovery_rotates_pin_and_invalidates_all_old_codes(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manager = SecurityPinManager(root / "pin.json", root / "integrity.key")
            setup = manager.set_pin("483920")
            old_codes = setup["recovery_codes"]
            recovered = manager.recover(old_codes[0], "739105")
            self.assertTrue(recovered["recovered"])
            self.assertTrue(manager.verify("739105").ok)
            self.assertFalse(manager.verify("483920").ok)
            self.assertEqual(len(recovered["recovery_codes"]), 8)
            self.assertTrue(set(old_codes).isdisjoint(recovered["recovery_codes"]))
            with self.assertRaisesRegex(SecurityPinError, "invalid"):
                manager.recover(old_codes[1], "111222")

    def test_recovery_has_independent_exponential_rate_limit(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            now = [1000.0]
            manager = SecurityPinManager(
                root / "pin.json", root / "integrity.key", time_fn=lambda: now[0]
            )
            setup = manager.set_pin("483920")
            for _ in range(5):
                with self.assertRaises(SecurityPinError):
                    manager.recover("AAAA-AAAA-AAAA-AAAA-AAAA", "739105")
            status = manager.status()
            self.assertTrue(status["recovery_locked"])
            self.assertGreaterEqual(status["recovery_retry_after_seconds"], 60)
            with self.assertRaisesRegex(SecurityPinError, "temporarily locked"):
                manager.recover(setup["recovery_codes"][0], "739105")
            now[0] += 61
            self.assertTrue(manager.recover(setup["recovery_codes"][0], "739105")["recovered"])

    def test_pin_requires_exactly_six_digits(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manager = SecurityPinManager(root / "pin.json", root / "integrity.key")
            for invalid in ("12345", "1234567", "abcdef", "12 456"):
                with self.assertRaisesRegex(SecurityPinError, "exactly 6 digits"):
                    manager.set_pin(invalid)

    def test_repeated_failures_lock_verification_and_success_resets_counter(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            now = [1000.0]
            manager = SecurityPinManager(
                root / "pin.json",
                root / "integrity.key",
                time_fn=lambda: now[0],
            )
            manager.set_pin("483920")
            result = None
            for _ in range(5):
                result = manager.verify("000000")
            self.assertIsNotNone(result)
            self.assertTrue(result.locked)
            self.assertGreaterEqual(result.retry_after_seconds, 30)
            self.assertFalse(manager.verify("483920").ok)

            now[0] += 31
            self.assertTrue(manager.verify("483920").ok)
            self.assertEqual(manager.status()["failed_attempts"], 0)

    def test_pin_record_tampering_is_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "pin.json"
            manager = SecurityPinManager(path, root / "integrity.key")
            manager.set_pin("483920")
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["failed_attempts"] = 0
            payload["digest"] = payload["digest"][::-1]
            path.write_text(json.dumps(payload) + "\n", encoding="utf-8")

            with self.assertRaises(SecurityPinIntegrityError):
                manager.verify("483920")

    def test_cli_uses_bounded_ephemeral_request_file_and_deletes_it(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_dir = root / "config"
            config_dir.mkdir()
            config_path = config_dir / "monarch_security.toml"
            config_path.write_text(
                "[runtime]\nsecurity_pin_path='data/security_pin.json'\nintegrity_key_path='data/integrity.key'\naudit_log_path='logs/audit.jsonl'\n",
                encoding="utf-8",
            )
            request_dir = root / "data" / "pin-requests"
            request_dir.mkdir(parents=True)
            request_path = request_dir / "set.json"
            request_path.write_text(
                json.dumps({"new_pin": "483920", "confirmation": "483920"}),
                encoding="utf-8",
            )
            output = StringIO()
            with redirect_stdout(output):
                code = cli_main([
                    "--config", str(config_path), "pin-set", "--request-file", str(request_path)
                ])
            result = json.loads(output.getvalue().splitlines()[-1])

            self.assertEqual(code, 0)
            self.assertTrue(result["ok"])
            self.assertFalse(request_path.exists())
            self.assertNotIn("483920", output.getvalue())

    def test_cli_recovery_consumes_request_without_echoing_secrets(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_dir = root / "config"
            config_dir.mkdir()
            config_path = config_dir / "monarch_security.toml"
            config_path.write_text(
                "[runtime]\nsecurity_pin_path='data/security_pin.json'\nintegrity_key_path='data/integrity.key'\naudit_log_path='logs/audit.jsonl'\n",
                encoding="utf-8",
            )
            manager = SecurityPinManager(root / "data" / "security_pin.json", root / "data" / "integrity.key")
            recovery_code = manager.set_pin("483920")["recovery_codes"][0]
            request_dir = root / "data" / "pin-requests"
            request_dir.mkdir(parents=True)
            request_path = request_dir / "recover.json"
            request_path.write_text(
                json.dumps({
                    "recovery_code": recovery_code,
                    "new_pin": "739105",
                    "confirmation": "739105",
                }),
                encoding="utf-8",
            )
            output = StringIO()
            with redirect_stdout(output):
                code = cli_main([
                    "--config", str(config_path), "pin-recover", "--request-file", str(request_path)
                ])
            result = json.loads(output.getvalue().splitlines()[-1])

            self.assertEqual(code, 0)
            self.assertTrue(result["ok"])
            self.assertFalse(request_path.exists())
            self.assertTrue(manager.verify("739105").ok)
            self.assertFalse(manager.verify("483920").ok)
            self.assertNotIn(recovery_code, output.getvalue())
            self.assertNotIn("739105", output.getvalue())
            self.assertEqual(len(result["status"]["recovery_codes"]), 8)


if __name__ == "__main__":
    unittest.main()
