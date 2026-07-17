from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from monarch_security.quarantine import (
    QuarantineError,
    QuarantineIntegrityError,
    QuarantineVault,
)


class QuarantineVaultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.vault = QuarantineVault(
            self.root / "vault",
            self.root / "manifest.jsonl",
            self.root / "integrity.key",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_isolate_and_restore_preserve_bytes_and_history(self) -> None:
        source = self.root / "sample.exe"
        content = b"inert-security-test\x00payload"
        source.write_bytes(content)

        isolated = self.vault.isolate(source, incident_id="inc-1")

        self.assertFalse(source.exists())
        self.assertTrue(Path(isolated.vault_path).exists())
        self.assertEqual(isolated.incident_id, "inc-1")
        self.assertEqual(self.vault.verify_objects()["ok"], True)
        restored = self.vault.restore(isolated.quarantine_id)
        self.assertEqual(source.read_bytes(), content)
        self.assertEqual(restored.status, "restored")
        self.assertEqual(self.vault.list(), [])
        self.assertEqual(len(self.vault.list(include_restored=True)), 1)

    def test_restore_refuses_to_overwrite_existing_file(self) -> None:
        source = self.root / "sample.bin"
        source.write_bytes(b"one")
        record = self.vault.isolate(source)
        source.write_bytes(b"replacement")

        with self.assertRaisesRegex(QuarantineError, "already exists"):
            self.vault.restore(record.quarantine_id)

        self.assertEqual(source.read_bytes(), b"replacement")
        self.assertTrue(Path(record.vault_path).exists())

    def test_restore_detects_tampered_vault_object(self) -> None:
        source = self.root / "sample.bin"
        source.write_bytes(b"safe-test")
        record = self.vault.isolate(source)
        Path(record.vault_path).write_bytes(b"tampered")

        with self.assertRaisesRegex(QuarantineIntegrityError, "hash or size mismatch"):
            self.vault.restore(record.quarantine_id)

        result = self.vault.verify_objects()
        self.assertFalse(result["ok"])
        self.assertEqual(result["checked"], 1)

    def test_manifest_tamper_is_rejected_on_reload(self) -> None:
        source = self.root / "sample.bin"
        source.write_bytes(b"safe-test")
        self.vault.isolate(source)
        manifest = self.root / "manifest.jsonl"
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["record"]["original_path"] = "C:\\tampered.exe"
        manifest.write_text(json.dumps(payload) + "\n", encoding="utf-8")

        with self.assertRaisesRegex(QuarantineIntegrityError, "integrity mismatch"):
            QuarantineVault(
                self.root / "vault",
                manifest,
                self.root / "integrity.key",
            )

    def test_refuses_to_isolate_a_symlink(self) -> None:
        target = self.root / "target.bin"
        target.write_bytes(b"target")
        link = self.root / "link.bin"
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest("Symlinks are unavailable in this Windows environment")

        with self.assertRaisesRegex(QuarantineError, "non-symlink"):
            self.vault.isolate(link)


if __name__ == "__main__":
    unittest.main()
