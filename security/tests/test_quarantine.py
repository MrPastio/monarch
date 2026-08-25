from __future__ import annotations

from dataclasses import replace
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import monarch_security.quarantine as quarantine_module
from monarch_security.quarantine import (
    QuarantineError,
    QuarantineIntegrityError,
    QuarantineVault,
)


class QuarantineVaultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state_root = self.root / "state"
        self.files_root = self.root / "files"
        self.application_root = self.root / "application"
        self.workspace_root = self.root / "workspace"
        self.protected_root = self.root / "synthetic-protected"
        for directory in (
            self.files_root,
            self.application_root,
            self.workspace_root,
            self.protected_root,
        ):
            directory.mkdir(parents=True)
        self.vault = QuarantineVault(
            self.state_root / "vault",
            self.state_root / "manifest.jsonl",
            self.state_root / "integrity.key",
            application_root=self.application_root,
            workspace_root=self.workspace_root,
            state_root=self.state_root,
            additional_protected_roots=(self.protected_root,),
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_isolate_and_restore_preserve_bytes_and_history(self) -> None:
        source = self.files_root / "sample.exe"
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
        source = self.files_root / "sample.bin"
        source.write_bytes(b"one")
        record = self.vault.isolate(source)
        source.write_bytes(b"replacement")

        with self.assertRaisesRegex(QuarantineError, "already exists"):
            self.vault.restore(record.quarantine_id)

        self.assertEqual(source.read_bytes(), b"replacement")
        self.assertTrue(Path(record.vault_path).exists())

    def test_restore_detects_tampered_vault_object(self) -> None:
        source = self.files_root / "sample.bin"
        source.write_bytes(b"safe-test")
        record = self.vault.isolate(source)
        Path(record.vault_path).write_bytes(b"tampered")

        with self.assertRaisesRegex(QuarantineIntegrityError, "hash or size mismatch"):
            self.vault.restore(record.quarantine_id)

        result = self.vault.verify_objects()
        self.assertFalse(result["ok"])
        self.assertEqual(result["checked"], 1)

    def test_manifest_tamper_is_rejected_on_reload(self) -> None:
        source = self.files_root / "sample.bin"
        source.write_bytes(b"safe-test")
        self.vault.isolate(source)
        manifest = self.state_root / "manifest.jsonl"
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["record"]["original_path"] = "C:\\tampered.exe"
        manifest.write_text(json.dumps(payload) + "\n", encoding="utf-8")

        with self.assertRaisesRegex(QuarantineIntegrityError, "integrity mismatch"):
            QuarantineVault(
                self.state_root / "vault",
                manifest,
                self.state_root / "integrity.key",
                application_root=self.application_root,
                workspace_root=self.workspace_root,
                state_root=self.state_root,
                additional_protected_roots=(self.protected_root,),
            )

    def test_refuses_to_isolate_a_symlink(self) -> None:
        target = self.files_root / "target.bin"
        target.write_bytes(b"target")
        link = self.files_root / "link.bin"
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest("Symlinks are unavailable in this Windows environment")

        with self.assertRaisesRegex(QuarantineError, "non-symlink"):
            self.vault.isolate(link)

    def test_protected_source_is_denied_before_content_is_read(self) -> None:
        source = self.protected_root / "synthetic-key.bin"
        source.write_bytes(b"protected-synthetic-content")

        with mock.patch.object(
            quarantine_module,
            "_hash_file",
            side_effect=AssertionError("protected content must not be opened"),
        ):
            with self.assertRaisesRegex(QuarantineError, "configured-protected-root"):
                self.vault.isolate(source)

        self.assertEqual(source.read_bytes(), b"protected-synthetic-content")
        self.assertEqual(self.vault.list(), [])

    def test_restore_into_protected_root_is_denied_without_consuming_object(self) -> None:
        source = self.files_root / "sample.bin"
        source.write_bytes(b"restore-boundary")
        record = self.vault.isolate(source)
        destination = self.protected_root / "restored.bin"

        with self.assertRaisesRegex(QuarantineError, "configured-protected-root"):
            self.vault.restore(record.quarantine_id, destination=destination)

        self.assertFalse(destination.exists())
        self.assertTrue(Path(record.vault_path).exists())
        self.assertEqual(self.vault.get(record.quarantine_id).status, "isolated")

    def test_legacy_record_cannot_restore_to_newly_protected_original_path(self) -> None:
        source = self.files_root / "legacy.bin"
        source.write_bytes(b"legacy-record")
        record = self.vault.isolate(source)
        protected_original = self.protected_root / "legacy.bin"
        self.vault._latest[record.quarantine_id] = replace(  # noqa: SLF001 - controlled legacy fixture
            record,
            original_path=str(protected_original),
        )

        with self.assertRaisesRegex(QuarantineError, "configured-protected-root"):
            self.vault.restore(record.quarantine_id)

        self.assertFalse(protected_original.exists())
        self.assertTrue(Path(record.vault_path).exists())

    def test_security_state_and_application_roots_are_non_mutable(self) -> None:
        state_file = self.state_root / "state-observation.bin"
        state_file.write_bytes(b"state")
        application_file = self.application_root / "module.py"
        application_file.write_bytes(b"application")

        with self.assertRaisesRegex(QuarantineError, "security-state-root"):
            self.vault.isolate(state_file)
        with self.assertRaisesRegex(QuarantineError, "security-application-root"):
            self.vault.isolate(application_file)

        self.assertTrue(state_file.exists())
        self.assertTrue(application_file.exists())

    def test_workspace_sensitive_path_is_denied_but_same_basename_elsewhere_is_allowed(self) -> None:
        workspace_secret = self.workspace_root / ".env"
        workspace_secret.write_bytes(b"synthetic-secret")
        unrelated = self.files_root / ".env"
        unrelated.write_bytes(b"ordinary-test-file")

        with self.assertRaisesRegex(QuarantineError, "monarch-sensitive-root"):
            self.vault.isolate(workspace_secret)

        record = self.vault.isolate(unrelated)
        self.vault.restore(record.quarantine_id)
        self.assertEqual(unrelated.read_bytes(), b"ordinary-test-file")

    def test_hardlinked_source_is_denied_without_removing_either_name(self) -> None:
        original = self.files_root / "original.bin"
        alias = self.files_root / "alias.bin"
        original.write_bytes(b"linked-content")
        try:
            os.link(original, alias)
        except OSError:
            self.skipTest("Hard links are unavailable in this environment")

        with self.assertRaisesRegex(QuarantineError, "hardlinked-source"):
            self.vault.isolate(alias)

        self.assertTrue(original.exists())
        self.assertTrue(alias.exists())

    @unittest.skipUnless(os.name == "nt", "Alternate data streams are Windows-specific")
    def test_alternate_stream_path_is_denied_before_lookup(self) -> None:
        source = self.files_root / "carrier.bin"
        source.write_bytes(b"carrier")
        stream = Path(f"{source}:metadata")

        with self.assertRaisesRegex(QuarantineError, "alternate-stream-path"):
            self.vault.isolate(stream)

        self.assertEqual(source.read_bytes(), b"carrier")

    @unittest.skipUnless(os.name == "nt", "Device paths are Windows-specific")
    def test_device_namespace_is_denied_before_lookup(self) -> None:
        with self.assertRaisesRegex(QuarantineError, "network-or-device-path"):
            self.vault.isolate(Path(r"\\?\C:\synthetic-never-open.bin"))

    def test_direct_filesystem_root_placement_is_denied_before_lookup(self) -> None:
        anchor = Path(self.root.anchor)
        with self.assertRaisesRegex(QuarantineError, "broad-root-target"):
            self.vault.isolate(anchor / "synthetic-never-open.bin")

    def test_vault_configuration_inside_protected_root_fails_before_creation(self) -> None:
        protected_state = self.root / "future-protected-state"

        with self.assertRaisesRegex(QuarantineError, "configured-protected-root"):
            QuarantineVault(
                protected_state / "vault",
                protected_state / "manifest.jsonl",
                protected_state / "integrity.key",
                state_root=protected_state,
                additional_protected_roots=(protected_state,),
            )

        self.assertFalse(protected_state.exists())

    def test_resolved_parent_alias_into_protected_root_is_denied(self) -> None:
        nested = self.protected_root / "nested"
        nested.mkdir()
        source = nested / "source.bin"
        source.write_bytes(b"alias-boundary")
        alias = self.files_root / "linked-parent"
        try:
            alias.symlink_to(nested, target_is_directory=True)
        except OSError:
            self.skipTest("Directory symlinks are unavailable in this Windows environment")

        with self.assertRaisesRegex(QuarantineError, "configured-protected-root"):
            self.vault.isolate(alias / "source.bin")

        self.assertTrue(source.exists())

    def test_source_identity_change_during_hash_is_denied_without_move(self) -> None:
        source = self.files_root / "changing.bin"
        source.write_bytes(b"initial")
        real_hash = quarantine_module._hash_file

        def hash_then_change(path: Path) -> tuple[str, int]:
            result = real_hash(path)
            path.write_bytes(b"changed-after-hash")
            return result

        with mock.patch.object(quarantine_module, "_hash_file", side_effect=hash_then_change):
            with self.assertRaisesRegex(QuarantineError, "identity changed"):
                self.vault.isolate(source)

        self.assertEqual(source.read_bytes(), b"changed-after-hash")
        self.assertEqual(self.vault.list(), [])

    def test_replaced_vault_directory_is_detected_before_source_move(self) -> None:
        original_vault = self.state_root / "vault"
        displaced = self.state_root / "vault-displaced"
        original_vault.rename(displaced)
        original_vault.mkdir()
        source = self.files_root / "sample.bin"
        source.write_bytes(b"vault-identity")

        with self.assertRaisesRegex(QuarantineIntegrityError, "root changed identity"):
            self.vault.isolate(source)

        self.assertTrue(source.exists())

    @unittest.skipUnless(os.name == "nt", "Windows protected roots are platform-specific")
    def test_default_safe_system_and_credential_roots_fail_before_lookup(self) -> None:
        candidates = (
            (
                Path("E:" + r"\MonarchData\Safe\safe-v1\synthetic-never-open.bin"),
                "monarch-safe-root",
            ),
            (Path(os.environ.get("SystemRoot", r"C:\Windows")) / "synthetic-never-open.bin", "system-root"),
            (Path.home() / ".ssh" / "synthetic-never-open.bin", "credential-root"),
        )

        for candidate, reason in candidates:
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(QuarantineError, reason):
                    self.vault.isolate(candidate)

    def test_configured_product_data_root_allows_vault_state_but_denies_sources(self) -> None:
        product_root = self.root / "product-data"
        state_root = product_root / "security"
        product_file = product_root / "oscar-memory.db"
        product_root.mkdir()
        product_file.write_bytes(b"synthetic-product-state")

        with mock.patch.dict(os.environ, {"MONARCH_DATA_ROOT": str(product_root)}):
            vault = QuarantineVault(
                state_root / "quarantine",
                state_root / "quarantine.jsonl",
                state_root / "integrity.key",
                state_root=state_root,
                application_root=self.application_root,
                workspace_root=self.workspace_root,
            )
            with self.assertRaisesRegex(QuarantineError, "monarch-product-root"):
                vault.isolate(product_file)

        self.assertTrue(product_file.exists())

    def test_hardlinked_vault_object_is_rejected_for_restore_and_verification(self) -> None:
        source = self.files_root / "sample.bin"
        source.write_bytes(b"vault-link-check")
        record = self.vault.isolate(source)
        alias = self.files_root / "vault-alias.bin"
        try:
            os.link(Path(record.vault_path), alias)
        except OSError:
            self.skipTest("Hard links are unavailable in this environment")

        with self.assertRaisesRegex(QuarantineIntegrityError, "escaped"):
            self.vault.restore(record.quarantine_id)
        verification = self.vault.verify_objects()
        self.assertFalse(verification["ok"])
        self.assertEqual(verification["checked"], 1)
        self.assertTrue(alias.exists())

    def test_restore_parent_identity_change_is_denied_without_consuming_object(self) -> None:
        source = self.files_root / "sample.bin"
        source.write_bytes(b"parent-identity")
        record = self.vault.isolate(source)
        restore_parent = self.root / "restore-parent"
        restore_parent.mkdir()
        displaced = self.root / "restore-parent-displaced"
        destination = restore_parent / "sample.bin"
        real_evaluate = self.vault._path_policy.evaluate_restore_target  # noqa: SLF001
        calls = 0

        def evaluate_then_replace_parent(path: Path):
            nonlocal calls
            result = real_evaluate(path)
            calls += 1
            if calls == 1:
                restore_parent.rename(displaced)
                restore_parent.mkdir()
            return result

        with mock.patch.object(
            self.vault._path_policy,  # noqa: SLF001
            "evaluate_restore_target",
            side_effect=evaluate_then_replace_parent,
        ):
            with self.assertRaisesRegex(QuarantineError, "parent identity changed"):
                self.vault.restore(record.quarantine_id, destination=destination)

        self.assertFalse(destination.exists())
        self.assertTrue(Path(record.vault_path).exists())

    def test_manifest_failure_rolls_isolation_back_to_original_path(self) -> None:
        source = self.files_root / "sample.bin"
        source.write_bytes(b"rollback-isolation")

        with mock.patch.object(self.vault, "_append", side_effect=OSError("synthetic append failure")):
            with self.assertRaisesRegex(OSError, "synthetic append failure"):
                self.vault.isolate(source)

        self.assertEqual(source.read_bytes(), b"rollback-isolation")
        self.assertEqual(list((self.state_root / "vault").glob("*.bin")), [])

    def test_manifest_failure_rolls_restore_back_into_vault(self) -> None:
        source = self.files_root / "sample.bin"
        source.write_bytes(b"rollback-restore")
        record = self.vault.isolate(source)

        with mock.patch.object(self.vault, "_append", side_effect=OSError("synthetic append failure")):
            with self.assertRaisesRegex(OSError, "synthetic append failure"):
                self.vault.restore(record.quarantine_id)

        self.assertFalse(source.exists())
        self.assertEqual(Path(record.vault_path).read_bytes(), b"rollback-restore")
        self.assertEqual(self.vault.get(record.quarantine_id).status, "isolated")


if __name__ == "__main__":
    unittest.main()
