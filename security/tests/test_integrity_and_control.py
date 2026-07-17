from pathlib import Path
from tempfile import TemporaryDirectory
import contextlib
import hashlib
from io import StringIO
import json
import os
import time
import unittest
from unittest.mock import patch

from monarch_security.analysis import RuleEngine
from monarch_security.audit import AuditLog
from monarch_security.cli import main as cli_main
from monarch_security.config import load_config
from monarch_security.control import protector_status, start_protector, stop_protector
from monarch_security.events import utc_now
from monarch_security.integrity import (
    _read_key_file,
    get_or_create_key,
    hmac_sha256,
    verify_audit_log,
    verify_payload,
)
from monarch_security.llm import LLMRouter
from monarch_security.policy import PolicyEngine
from monarch_security.profile import write_model_command_policy, write_security_profile
from monarch_security.resources import ResourceGuard
from monarch_security.state import FileLock, StateStore
from monarch_security.supervisor import SecuritySupervisor


class IntegrityAndControlTests(unittest.TestCase):
    def test_binary_dpapi_key_preserves_trailing_newline_bytes(self):
        with TemporaryDirectory() as directory:
            key_path = Path(directory) / "integrity.key"
            encrypted = b"\x01\x02ciphertext\r\n"
            key_path.write_bytes(encrypted)

            self.assertEqual(_read_key_file(key_path), encrypted)

    def test_legacy_text_key_trims_trailing_newline(self):
        with TemporaryDirectory() as directory:
            key_path = Path(directory) / "integrity.key"
            key = b"a" * 64
            key_path.write_bytes(key + b"\n")

            self.assertEqual(_read_key_file(key_path), key)

    def test_file_lock_recovers_legacy_orphan_directory(self):
        with TemporaryDirectory() as directory:
            target = Path(directory) / "audit.jsonl"
            lock_dir = target.with_suffix(".jsonl.lock")
            lock_dir.mkdir()
            old = time.time() - 120
            os.utime(lock_dir, (old, old))

            with FileLock(target, timeout=0.2):
                self.assertTrue((lock_dir / "owner.json").exists())

            self.assertFalse(lock_dir.exists())

    def test_file_lock_never_recovers_a_live_owner(self):
        with TemporaryDirectory() as directory:
            target = Path(directory) / "audit.jsonl"
            lock_dir = target.with_suffix(".jsonl.lock")
            lock_dir.mkdir()
            (lock_dir / "owner.json").write_text(
                json.dumps({"pid": os.getpid(), "created_at": time.time() - 120}),
                encoding="utf-8",
            )
            old = time.time() - 120
            os.utime(lock_dir, (old, old))

            with self.assertRaises(TimeoutError):
                with FileLock(target, timeout=0.05):
                    pass

            self.assertTrue(lock_dir.exists())

    def test_audit_refreshes_chain_between_multiple_writers(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            key_path = root / "integrity.key"
            audit_path = root / "audit.jsonl"
            first = AuditLog(audit_path, max_bytes=0, stdout=False, integrity_key_path=key_path)
            second = AuditLog(audit_path, max_bytes=0, stdout=False, integrity_key_path=key_path)

            first.status({"writer": "first"})
            second.status({"writer": "second"})
            first.status({"writer": "first-again"})

            result = verify_audit_log(audit_path, key_path)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["records"], 3)

    def test_audit_rotation_starts_a_new_verifiable_chain(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            key_path = root / "integrity.key"
            audit_path = root / "audit.jsonl"
            audit = AuditLog(audit_path, max_bytes=500, stdout=False, integrity_key_path=key_path)

            for index in range(8):
                audit.status({"index": index, "payload": "x" * 120})

            self.assertTrue(audit_path.with_suffix(".jsonl.1").exists())
            result = verify_audit_log(audit_path, key_path)
            self.assertTrue(result["ok"], result)
            self.assertGreaterEqual(result["records"], 1)

    def test_audit_and_state_tampering_is_detected(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            key_path = root / "data" / "integrity.key"
            audit_path = root / "logs" / "audit.jsonl"
            state_path = root / "data" / "state.json"

            audit_path.parent.mkdir(parents=True, exist_ok=True)
            audit_path.write_text('{"kind":"legacy","status":"unsigned"}\n', encoding="utf-8")
            audit = AuditLog(
                audit_path,
                max_bytes=0,
                stdout=False,
                integrity_key_path=key_path,
            )
            audit.status({"status": "sealed"})

            audit_result = verify_audit_log(audit_path, key_path)
            self.assertTrue(audit_result["ok"], audit_result)
            self.assertEqual(audit_result["legacy_unsigned_records"], 1)
            self.assertEqual(audit_result["records"], 1)

            lines = audit_path.read_text(encoding="utf-8").splitlines()
            sealed = json.loads(lines[-1])
            sealed["status"] = "tampered"
            audit_path.write_text(lines[0] + "\n" + json.dumps(sealed) + "\n", encoding="utf-8")
            self.assertFalse(verify_audit_log(audit_path, key_path)["ok"])

            state = StateStore(state_path, key_path)
            state.set_list("known_devices", {"USB\\VID_1234"})
            state.save()
            key = get_or_create_key(key_path)
            parsed = json.loads(state_path.read_text(encoding="utf-8"))
            ok, reason = verify_payload(parsed, key, "state-store")
            self.assertTrue(ok, reason)

            parsed["known_devices"].append("USB\\VID_EVIL")
            state_path.write_text(json.dumps(parsed), encoding="utf-8")
            ok, reason = verify_payload(
                json.loads(state_path.read_text(encoding="utf-8")),
                key,
                "state-store",
            )
            self.assertFalse(ok)
            self.assertEqual(reason, "integrity digest mismatch")
            reloaded = StateStore(state_path, key_path)
            self.assertEqual(reloaded.data.get("integrity_error"), "integrity digest mismatch")
            self.assertEqual(reloaded.get_list("known_devices"), [])

            state_path.write_text(
                json.dumps({"known_devices": ["USB\\VID_UNSIGNED"]}),
                encoding="utf-8",
            )
            unsigned = StateStore(state_path, key_path)
            self.assertEqual(unsigned.data.get("integrity_error"), "missing integrity metadata")
            self.assertEqual(unsigned.get_list("known_devices"), [])

    def test_tail_audit_redacts_legacy_passkeys_without_mutating_log(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = _temporary_config_path(root)
            config = load_config(config_path)
            audit = AuditLog(
                config.runtime.audit_log_path,
                max_bytes=0,
                stdout=False,
                integrity_key_path=config.runtime.integrity_key_path,
            )
            legacy_passkey = "0123456789abcdef"
            audit.write(
                "controller_decision",
                {
                    "status": "approval_required",
                    "passkey": legacy_passkey,
                    "report": (
                        "Если ты подтверждаешь это действие, скопируй этот "
                        f"ОДНОРАЗОВЫЙ КЛЮЧ: {legacy_passkey}"
                    ),
                },
            )

            raw_audit = config.runtime.audit_log_path.read_text(encoding="utf-8")
            self.assertIn(legacy_passkey, raw_audit)

            output = _run_cli_stdout(config_path, ["tail-audit", "--lines", "5"])

            self.assertNotIn(legacy_passkey, output)
            self.assertIn("[redacted-passkey]", output)
            self.assertEqual(raw_audit, config.runtime.audit_log_path.read_text(encoding="utf-8"))
            self.assertTrue(
                verify_audit_log(config.runtime.audit_log_path, config.runtime.integrity_key_path)["ok"]
            )

    def test_verify_integrity_does_not_create_missing_key(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = _temporary_config_path(root)
            config = load_config(config_path)
            config.runtime.state_path.parent.mkdir(parents=True, exist_ok=True)
            config.runtime.state_path.write_text(json.dumps({"known_devices": []}), encoding="utf-8")
            self.assertFalse(config.runtime.integrity_key_path.exists())

            stream = StringIO()
            with contextlib.redirect_stdout(stream):
                code = cli_main(["--config", str(config_path), "verify-integrity"])

            lines = [line for line in stream.getvalue().splitlines() if line.strip()]
            payload = json.loads(lines[-1])
            self.assertEqual(code, 1)
            self.assertFalse(config.runtime.integrity_key_path.exists())
            self.assertFalse(payload["state"]["ok"])
            self.assertEqual(payload["state"]["error"], "integrity key missing")

    def test_supervisor_ignores_unauthenticated_stop_file(self):
        with TemporaryDirectory() as directory:
            config = _temporary_config(Path(directory))
            policy = PolicyEngine(config.policy)
            audit = AuditLog(
                config.runtime.audit_log_path,
                max_bytes=0,
                stdout=False,
                integrity_key_path=config.runtime.integrity_key_path,
            )
            supervisor = SecuritySupervisor(
                config=config,
                resources=ResourceGuard(config.resources),
                rules=RuleEngine(config.router),
                router=LLMRouter(config, ResourceGuard(config.resources), policy),
                policy=policy,
                audit=audit,
                state=StateStore(config.runtime.state_path, config.runtime.integrity_key_path),
                no_llm=True,
            )

            try:
                supervisor._prepare_runtime_markers()
                config.runtime.control_path.write_text(
                    json.dumps(
                        {
                            "requested_at": utc_now(),
                            "pid": os.getpid(),
                            "token_hmac": "bad",
                        }
                    ),
                    encoding="utf-8",
                )
                self.assertFalse(supervisor._should_stop())

                token = config.runtime.control_token_path.read_bytes().strip()
                requested_at = utc_now()
                payload = {"requested_at": requested_at, "pid": os.getpid()}
                payload["token_hmac"] = hmac_sha256(
                    token,
                    f"{requested_at}|{os.getpid()}",
                )
                config.runtime.control_path.write_text(json.dumps(payload), encoding="utf-8")
                self.assertTrue(supervisor._should_stop())
            finally:
                supervisor._cleanup_runtime_markers()

    def test_state_store_skips_unchanged_persistence(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            state = StateStore(root / "state.json", root / "integrity.key")

            state.set_list("known_devices", ["device-b", "device-a"])
            self.assertTrue(state.dirty)
            self.assertTrue(state.save_if_dirty())
            first_payload = state.path.read_bytes()

            state.set_list("known_devices", ["device-a", "device-b"])
            self.assertFalse(state.dirty)
            self.assertFalse(state.save_if_dirty())
            self.assertEqual(state.path.read_bytes(), first_payload)

    def test_supervisor_throttles_idle_heartbeat_writes(self):
        with TemporaryDirectory() as directory:
            config = _temporary_config(Path(directory))
            policy = PolicyEngine(config.policy)
            supervisor = SecuritySupervisor(
                config=config,
                resources=ResourceGuard(config.resources),
                rules=RuleEngine(config.router),
                router=LLMRouter(config, ResourceGuard(config.resources), policy),
                policy=policy,
                audit=AuditLog(config.runtime.audit_log_path, max_bytes=0, stdout=False),
                state=StateStore(config.runtime.state_path, config.runtime.integrity_key_path),
                no_llm=True,
            )

            with patch.object(supervisor, "_write_heartbeat") as write_heartbeat:
                self.assertTrue(supervisor._write_heartbeat_if_due(100.0))
                self.assertFalse(supervisor._write_heartbeat_if_due(109.9))
                self.assertTrue(supervisor._write_heartbeat_if_due(110.0))
                self.assertEqual(write_heartbeat.call_count, 2)

    def test_supervisor_applies_profile_and_model_policy_without_restart(self):
        with TemporaryDirectory() as directory:
            config = _temporary_config(Path(directory))
            policy = PolicyEngine(config.policy)
            supervisor = SecuritySupervisor(
                config=config,
                resources=ResourceGuard(config.resources),
                rules=RuleEngine(config.router),
                router=LLMRouter(config, ResourceGuard(config.resources), policy),
                policy=policy,
                audit=AuditLog(config.runtime.audit_log_path, max_bytes=0, stdout=False),
                state=StateStore(config.runtime.state_path, config.runtime.integrity_key_path),
                no_llm=True,
            )

            write_security_profile(config, "minimal")
            write_model_command_policy(config, enabled=False, confirmation_mode="always")
            self.assertTrue(supervisor._refresh_runtime_settings())
            self.assertEqual(supervisor.profile.level, "minimal")
            self.assertFalse(supervisor.model_policy.enabled)
            self.assertEqual(supervisor.model_policy.confirmation_mode, "always")

            write_security_profile(config, "off")
            self.assertFalse(supervisor._refresh_runtime_settings())
            self.assertEqual(supervisor.profile.level, "off")

    def test_status_cleans_stale_runtime_markers(self):
        with TemporaryDirectory() as directory:
            config = _temporary_config(Path(directory))
            config.runtime.pid_path.parent.mkdir(parents=True, exist_ok=True)
            config.runtime.pid_path.write_text("99999999\n", encoding="utf-8")
            config.runtime.heartbeat_path.write_text(
                json.dumps(
                    {
                        "pid": 99999999,
                        "status": "running",
                        "updated_at": time.time() - 600,
                    }
                ),
                encoding="utf-8",
            )
            config.runtime.control_path.write_text("{}", encoding="utf-8")
            config.runtime.control_token_path.write_text("stale-token", encoding="utf-8")

            status = protector_status(config)

            self.assertFalse(status["running"])
            self.assertTrue(status["stale_markers_cleaned"])
            self.assertIsNone(status["pid"])
            self.assertIsNone(status["heartbeat"])
            self.assertFalse(status["heartbeat_stale"])
            self.assertFalse(config.runtime.pid_path.exists())
            self.assertFalse(config.runtime.heartbeat_path.exists())
            self.assertFalse(config.runtime.control_path.exists())
            self.assertFalse(config.runtime.control_token_path.exists())

    def test_status_cleans_orphan_pid_without_heartbeat(self):
        with TemporaryDirectory() as directory:
            config = _temporary_config(Path(directory))
            config.runtime.pid_path.parent.mkdir(parents=True, exist_ok=True)
            config.runtime.pid_path.write_text("99999999\n", encoding="utf-8")

            status = protector_status(config)

            self.assertFalse(status["running"])
            self.assertTrue(status["stale_markers_cleaned"])
            self.assertIsNone(status["pid"])
            self.assertIsNone(status["heartbeat"])
            self.assertFalse(config.runtime.pid_path.exists())

    def test_start_protector_reports_timeout_without_running_status(self):
        with TemporaryDirectory() as directory:
            config_path = _temporary_config_path(Path(directory))

            class FakeProcess:
                pid = 4242

                def poll(self):
                    return None

            with patch("monarch_security.control.subprocess.Popen", return_value=FakeProcess()), patch(
                "monarch_security.control._wait_for_running_status",
                return_value={"running": False, "pid": None},
            ), patch("monarch_security.control._terminate_failed_start", return_value=True) as cleanup:
                result = start_protector(config_path, no_llm=True)

            self.assertFalse(result["started"])
            self.assertFalse(result["running"])
            self.assertEqual(result["reason"], "startup_timeout")
            self.assertEqual(result["launch_pid"], 4242)
            self.assertIsNone(result["pid"])
            self.assertTrue(result["orphan_cleaned"])
            cleanup.assert_called_once()

    def test_start_command_exits_nonzero_when_startup_times_out(self):
        with TemporaryDirectory() as directory:
            config_path = _temporary_config_path(Path(directory))

            stream = StringIO()
            with patch(
                "monarch_security.cli.start_protector",
                return_value={
                    "started": False,
                    "reason": "startup_timeout",
                    "running": False,
                    "launch_pid": 4242,
                },
            ), contextlib.redirect_stdout(stream):
                code = cli_main(["--config", str(config_path), "start", "--no-llm"])

            lines = [line for line in stream.getvalue().splitlines() if line.strip()]
            self.assertEqual(code, 1)
            payload = json.loads(lines[-1])
            self.assertFalse(payload["started"])
            self.assertEqual(payload["reason"], "startup_timeout")

    def test_model_policy_change_never_restarts_running_protection(self):
        with TemporaryDirectory() as directory:
            config_path = _temporary_config_path(Path(directory))
            stream = StringIO()
            with patch("monarch_security.cli.protector_status", return_value={"running": True}), patch(
                "monarch_security.cli.stop_protector"
            ) as stop_mock, patch("monarch_security.cli.start_protector") as start_mock, contextlib.redirect_stdout(stream):
                code = cli_main([
                    "--config", str(config_path), "model-policy-set",
                    "--enabled", "false", "--confirmation", "always", "--confirm",
                ])

            self.assertEqual(code, 0)
            stop_mock.assert_not_called()
            start_mock.assert_not_called()
            payload = json.loads([line for line in stream.getvalue().splitlines() if line.strip()][-1])
            self.assertTrue(payload["running"])
            self.assertTrue(payload["applied_live"])
            self.assertFalse(payload["restarted"])

    def test_profile_off_rolls_back_if_running_protector_cannot_stop(self):
        with TemporaryDirectory() as directory:
            config_path = _temporary_config_path(Path(directory))
            stream = StringIO()
            with patch("monarch_security.cli.protector_status", return_value={"running": True}), patch(
                "monarch_security.cli.stop_protector", return_value={"running": True}
            ), contextlib.redirect_stdout(stream):
                code = cli_main(["--config", str(config_path), "profile-set", "--level", "off", "--confirm"])

            self.assertEqual(code, 1)
            payload = json.loads([line for line in stream.getvalue().splitlines() if line.strip()][-1])
            self.assertEqual(payload["error"], "protection-stop-failed")
            self.assertTrue(payload["rolled_back"])
            self.assertEqual(payload["profile"]["level"], "balanced")

    def test_stop_protector_does_not_create_stop_file_when_not_running(self):
        with TemporaryDirectory() as directory:
            config_path = _temporary_config_path(Path(directory))
            config = load_config(config_path)

            result = stop_protector(config_path, wait_seconds=0)

            self.assertFalse(result["stop_requested"])
            self.assertEqual(result["reason"], "not_running")
            self.assertFalse(result["running"])
            self.assertFalse(config.runtime.control_path.exists())
            self.assertFalse(config.runtime.control_token_path.exists())

    def test_check_action_passkey_is_bound_to_exact_action(self):
        with TemporaryDirectory() as directory:
            config_path = _temporary_config_path(Path(directory))

            first = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "удали файл",
                    "--action-module",
                    "workspace",
                    "--action-capability",
                    "workspace.files.delete",
                    "--action-input",
                    '{"path":"runtime/a.txt"}',
                    "--no-llm",
                ],
            )
            self.assertFalse(first["ok"])
            self.assertEqual(first["status"], "approval_required")
            self.assertEqual(first["risk"], "elevated")
            self.assertEqual(first["decision"]["action"], "require_passkey")
            self.assertTrue(first["decision"]["requires_passkey"])
            passkey = first["passkey"]
            state_path = Path(directory) / "data" / "state.json"
            state_text = state_path.read_text(encoding="utf-8")
            self.assertNotIn(passkey, state_text)
            self.assertIn("sha256:", state_text)

            mismatch = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "покажи список",
                    "--action-module",
                    "custom-tools",
                    "--action-capability",
                    "custom-tools.execute",
                    "--action-input",
                    '{"toolId":"probe","input":{}}',
                    "--passkey",
                    passkey,
                    "--no-llm",
                ],
            )
            self.assertFalse(mismatch["ok"])
            self.assertEqual(mismatch["status"], "invalid_passkey")
            self.assertEqual(mismatch["decision"]["action"], "block")

            second = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "удали файл",
                    "--action-module",
                    "workspace",
                    "--action-capability",
                    "workspace.files.delete",
                    "--action-input",
                    '{"path":"runtime/a.txt"}',
                    "--no-llm",
                ],
            )
            exact = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "удали файл",
                    "--action-module",
                    "workspace",
                    "--action-capability",
                    "workspace.files.delete",
                    "--action-input",
                    '{"path":"runtime/a.txt"}',
                    "--passkey",
                    second["passkey"],
                    "--no-llm",
                ],
            )
            self.assertTrue(exact["ok"], exact)
            self.assertEqual(exact["status"], "allowed_by_passkey")
            self.assertEqual(exact["decision"]["action"], "allow")

            equivalent = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "удали файл",
                    "--action-module",
                    "workspace",
                    "--action-capability",
                    "workspace.files.delete",
                    "--action-input",
                    '{"path":"runtime/b.txt","options":{"secure":true,"depth":2}}',
                    "--no-llm",
                ],
            )
            canonical = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "удали файл",
                    "--action-module",
                    "workspace",
                    "--action-capability",
                    "workspace.files.delete",
                    "--action-input",
                    '{ "options" : { "depth" : 2, "secure" : true }, "path" : "runtime/b.txt" }',
                    "--passkey",
                    equivalent["passkey"],
                    "--no-llm",
                ],
            )
            self.assertTrue(canonical["ok"], canonical)
            self.assertEqual(canonical["status"], "allowed_by_passkey")

            monarch_confirmed = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "удали файл",
                    "--action-module",
                    "workspace",
                    "--action-capability",
                    "workspace.files.delete",
                    "--action-input",
                    '{"path":"runtime/confirmed.txt"}',
                    "--monarch-confirmed",
                    "--no-llm",
                ],
            )
            self.assertFalse(monarch_confirmed["ok"], monarch_confirmed)
            self.assertEqual(monarch_confirmed["status"], "approval_required")
            self.assertEqual(monarch_confirmed["decision"]["action"], "require_passkey")
            self.assertIn("passkey", monarch_confirmed)

            audit_path = Path(directory) / "logs" / "audit.jsonl"
            key_path = Path(directory) / "data" / "integrity.key"
            audit_text = audit_path.read_text(encoding="utf-8")
            audit_records = [
                json.loads(line)
                for line in audit_text.splitlines()
                if line.strip()
            ]
            self.assertTrue(any(record.get("kind") == "controller_decision" for record in audit_records))
            issued_passkeys = [
                passkey,
                second["passkey"],
                equivalent["passkey"],
                monarch_confirmed["passkey"],
            ]
            for issued_passkey in issued_passkeys:
                self.assertNotIn(issued_passkey, audit_text)
                self.assertNotIn(issued_passkey, state_path.read_text(encoding="utf-8"))
            self.assertTrue(
                any(
                    record.get("passkey_issued") is True
                    and "[redacted-passkey]" in str(record.get("report", ""))
                    for record in audit_records
                )
            )
            self.assertTrue(verify_audit_log(audit_path, key_path)["ok"])

    def test_check_action_accepts_legacy_raw_pending_nonce_and_migrates_state(self):
        with TemporaryDirectory() as directory:
            config_path = _temporary_config_path(Path(directory))
            config = load_config(config_path)

            first = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "удали файл",
                    "--action-module",
                    "workspace",
                    "--action-capability",
                    "workspace.files.delete",
                    "--action-input",
                    '{"path":"runtime/legacy.txt"}',
                    "--no-llm",
                ],
            )
            passkey = first["passkey"]
            state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
            pending = state.get_dict("pending_nonces")
            self.assertEqual(len(pending), 1)
            raw_record = next(iter(pending.values()))
            state.set_dict("pending_nonces", {passkey: raw_record})
            state.save()
            self.assertIn(passkey, config.runtime.state_path.read_text(encoding="utf-8"))

            allowed = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "удали файл",
                    "--action-module",
                    "workspace",
                    "--action-capability",
                    "workspace.files.delete",
                    "--action-input",
                    '{"path":"runtime/legacy.txt"}',
                    "--passkey",
                    passkey,
                    "--no-llm",
                ],
            )

            self.assertTrue(allowed["ok"], allowed)
            self.assertEqual(allowed["status"], "allowed_by_passkey")
            state_text = config.runtime.state_path.read_text(encoding="utf-8")
            self.assertNotIn(passkey, state_text)
            self.assertEqual(StateStore(config.runtime.state_path).get_dict("pending_nonces"), {})

    def test_check_action_rejects_pending_nonce_from_tampered_state(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = _temporary_config_path(root)
            config = load_config(config_path)
            action_input = '{"path":"runtime/forged.txt"}'
            forged_passkey = "forged-passkey"
            state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
            state.set_dict("pending_nonces", {})
            state.save()

            tampered = json.loads(config.runtime.state_path.read_text(encoding="utf-8"))
            tampered["pending_nonces"] = {
                f"sha256:{_sha256_text(forged_passkey)}": json.dumps(
                    {
                        "schema": 1,
                        "issued_at": time.time(),
                        "intent_hash": _sha256_text("удали файл"),
                        "action_module": "workspace",
                        "action_capability": "workspace.files.delete",
                        "action_input_hash": _sha256_text(_canonical_json(action_input)),
                    },
                    ensure_ascii=True,
                    sort_keys=True,
                    separators=(",", ":"),
                )
            }
            config.runtime.state_path.write_text(json.dumps(tampered), encoding="utf-8")

            loaded = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
            self.assertIn("integrity_error", loaded.data)
            self.assertEqual(loaded.get_dict("pending_nonces"), {})

            rejected = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "удали файл",
                    "--action-module",
                    "workspace",
                    "--action-capability",
                    "workspace.files.delete",
                    "--action-input",
                    action_input,
                    "--passkey",
                    forged_passkey,
                    "--no-llm",
                ],
            )

            self.assertFalse(rejected["ok"], rejected)
            self.assertEqual(rejected["status"], "invalid_passkey")

    def test_check_action_reads_only_bounded_local_request_files(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = _temporary_config_path(root)
            request_dir = root / "data" / "action-requests"
            request_dir.mkdir(parents=True)
            request_path = request_dir / "request.json"
            request_path.write_text(
                json.dumps({
                    "intent_text": "удали файл",
                    "action_module": "workspace",
                    "action_capability": "workspace.files.delete",
                    "action_input": '{"path":"runtime/a.txt"}',
                    "passkey": "",
                    "no_llm": True,
                }),
                encoding="utf-8",
            )
            result = _run_cli_json(config_path, [
                "check-action",
                "--request-file",
                str(request_path),
            ])
            self.assertEqual(result["status"], "approval_required")
            self.assertNotIn("runtime/a.txt", json.dumps(result))

            request_path.write_text(
                json.dumps({
                    "intent_text": "удали файл",
                    "action_module": "workspace",
                    "action_capability": "workspace.files.delete",
                    "action_input": {"path": "runtime/object-input.txt"},
                    "passkey": "",
                    "no_llm": True,
                }),
                encoding="utf-8",
            )
            object_input = _run_cli_json(config_path, [
                "check-action",
                "--request-file",
                str(request_path),
            ])
            self.assertEqual(object_input["status"], "approval_required")
            self.assertNotIn("runtime/object-input.txt", json.dumps(object_input))

            request_path.write_text(
                json.dumps({
                    "intent_text": "удали файл",
                    "action_module": "workspace",
                    "action_capability": "workspace.files.delete",
                    "action_input": '{"path":"runtime/confirmed-from-file.txt"}',
                    "passkey": "",
                    "no_llm": True,
                    "monarch_confirmed": True,
                }),
                encoding="utf-8",
            )
            confirmed_payload = _run_cli_json(config_path, [
                "check-action",
                "--request-file",
                str(request_path),
            ])
            self.assertFalse(confirmed_payload["ok"], confirmed_payload)
            self.assertEqual(confirmed_payload["status"], "approval_required")
            self.assertEqual(confirmed_payload["decision"]["action"], "require_passkey")

            outside = root / "outside.json"
            outside.write_text(request_path.read_text(encoding="utf-8"), encoding="utf-8")
            rejected = _run_cli_json(config_path, [
                "check-action",
                "--request-file",
                str(outside),
            ])
            self.assertEqual(rejected["status"], "invalid_request")
            self.assertEqual(rejected["decision"]["action"], "block")

    def test_check_action_respects_permanent_blocklist(self):
        with TemporaryDirectory() as directory:
            config_path = _temporary_config_path(Path(directory))

            blocked_capability = _run_cli_json(
                config_path,
                [
                    "block-action",
                    "--capability",
                    "custom-tools.execute",
                ],
            )
            self.assertTrue(blocked_capability["ok"], blocked_capability)
            self.assertEqual(blocked_capability["decision"]["action"], "permanently_block")

            blocked = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "покажи список файлов",
                    "--action-module",
                    "custom-tools",
                    "--action-capability",
                    "custom-tools.execute",
                    "--action-input",
                    '{"toolId":"probe","input":{}}',
                    "--no-llm",
                ],
            )
            self.assertFalse(blocked["ok"])
            self.assertEqual(blocked["status"], "permanently_blocked")
            self.assertEqual(blocked["risk"], "blocked")
            self.assertEqual(blocked["decision"]["action"], "block")
            self.assertNotIn("passkey", blocked)

    def test_block_action_rejects_empty_capability(self):
        with TemporaryDirectory() as directory:
            config_path = _temporary_config_path(Path(directory))
            config = load_config(config_path)

            stream = StringIO()
            with contextlib.redirect_stdout(stream):
                code = cli_main([
                    "--config",
                    str(config_path),
                    "block-action",
                    "--capability",
                    "   ",
                ])

            lines = [line for line in stream.getvalue().splitlines() if line.strip()]
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(lines[-1])["error"], "missing-capability")
            self.assertFalse(config.runtime.state_path.exists())

    def test_check_action_uses_registered_custom_tool_risk(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            security_root = root / "security"
            security_root.mkdir(parents=True, exist_ok=True)
            config_path = _temporary_config_path(security_root)
            registry = root / "data" / "local" / "custom-tools.json"
            registry.parent.mkdir(parents=True, exist_ok=True)
            registry.write_text(
                json.dumps(
                    [
                        {"id": "clock-now", "risk": "none"},
                        {"id": "web-fetch-text", "risk": "network"},
                    ]
                ),
                encoding="utf-8",
            )

            safe = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "запусти инструмент clock-now",
                    "--action-module",
                    "custom-tools",
                    "--action-capability",
                    "custom-tools.execute",
                    "--action-input",
                    '{"toolId":"clock-now","declaredRisk":"execute"}',
                    "--no-llm",
                ],
            )
            self.assertTrue(safe["ok"], safe)
            self.assertEqual(safe["status"], "allowed")

            safe_snake_case = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "запусти инструмент clock-now",
                    "--action-module",
                    "custom-tools",
                    "--action-capability",
                    "custom-tools.execute",
                    "--action-input",
                    '{"tool_id":"clock-now","declaredRisk":"execute"}',
                    "--no-llm",
                ],
            )
            self.assertTrue(safe_snake_case["ok"], safe_snake_case)
            self.assertEqual(safe_snake_case["status"], "allowed")

            network = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "запусти инструмент web-fetch-text",
                    "--action-module",
                    "custom-tools",
                    "--action-capability",
                    "custom-tools.execute",
                    "--action-input",
                    '{"toolId":"web-fetch-text","declaredRisk":"none"}',
                    "--no-llm",
                ],
            )
            self.assertFalse(network["ok"])
            self.assertEqual(network["status"], "approval_required")

    def test_custom_tools_blocklist_keeps_safe_registered_tools_available(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            security_root = root / "security"
            security_root.mkdir(parents=True, exist_ok=True)
            config_path = _temporary_config_path(security_root)
            registry = root / "data" / "local" / "custom-tools.json"
            registry.parent.mkdir(parents=True, exist_ok=True)
            registry.write_text(
                json.dumps(
                    [
                        {"id": "clock-now", "risk": "none"},
                        {"id": "web-fetch-text", "risk": "network"},
                    ]
                ),
                encoding="utf-8",
            )

            blocked_capability = _run_cli_json(
                config_path,
                [
                    "block-action",
                    "--capability",
                    "custom-tools.execute",
                ],
            )
            self.assertTrue(blocked_capability["ok"], blocked_capability)

            safe = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "покажи время",
                    "--action-module",
                    "custom-tools",
                    "--action-capability",
                    "custom-tools.execute",
                    "--action-input",
                    '{"toolId":"clock-now","declaredRisk":"execute"}',
                    "--no-llm",
                ],
            )
            self.assertTrue(safe["ok"], safe)
            self.assertEqual(safe["status"], "allowed")

            network = _run_cli_json(
                config_path,
                [
                    "check-action",
                    "--intent-text",
                    "скачай страницу",
                    "--action-module",
                    "custom-tools",
                    "--action-capability",
                    "custom-tools.execute",
                    "--action-input",
                    '{"toolId":"web-fetch-text","declaredRisk":"none"}',
                    "--no-llm",
                ],
            )
            self.assertFalse(network["ok"])
            self.assertEqual(network["status"], "permanently_blocked")

    def test_security_report_json_includes_artifact_index(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = _temporary_config_path(root)
            output_dir = root / "reports" / "manual"

            payload = _run_cli_json(
                config_path,
                [
                    "report",
                    "--summary-only",
                    "--no-llm",
                    "--output-dir",
                    str(output_dir),
                ],
            )

            artifacts = payload.get("artifacts")
            self.assertIsInstance(artifacts, dict, payload)
            report_json_path = Path(artifacts["json"])
            saved_payload = json.loads(report_json_path.read_text(encoding="utf-8"))
            self.assertEqual(saved_payload.get("artifacts"), artifacts)

            markdown = Path(artifacts["markdown"]).read_text(encoding="utf-8")
            self.assertIn("## Artifacts", markdown)
            self.assertIn(str(report_json_path), markdown)

    def test_security_report_rejects_output_dir_outside_reports_root(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = _temporary_config_path(root)
            outside_dir = root / "outside-report"

            stream = StringIO()
            with contextlib.redirect_stdout(stream):
                code = cli_main([
                    "--config",
                    str(config_path),
                    "report",
                    "--summary-only",
                    "--no-llm",
                    "--output-dir",
                    str(outside_dir),
                ])

            lines = [line for line in stream.getvalue().splitlines() if line.strip()]
            self.assertEqual(code, 1)
            self.assertFalse((outside_dir / "report.json").exists())
            self.assertEqual(json.loads(lines[-1])["status"], "invalid_request")

    def test_cli_rejects_unbounded_numeric_limits(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = _temporary_config_path(root)

            cases = [
                ["stop", "--wait", "-1"],
                ["report", "--file-limit", "1000001", "--summary-only", "--no-llm"],
                ["tail-audit", "--lines", "1000001"],
                ["scan-path", str(root), "--limit", "1000001", "--no-llm"],
                ["scan-system", "--file-limit", "1000001", "--summary-only", "--no-llm"],
                ["monitor-processes", "--duration", "-1", "--no-llm"],
                ["monitor-devices", "--duration", "1", "--interval", "0", "--no-llm"],
            ]

            for argv in cases:
                stream = StringIO()
                errors = StringIO()
                with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(errors):
                    with self.assertRaises(SystemExit, msg=argv) as raised:
                        cli_main(["--config", str(config_path), *argv])
                self.assertEqual(raised.exception.code, 2, argv)


def _temporary_config(root: Path):
    return load_config(_temporary_config_path(root))


def _temporary_config_path(root: Path) -> Path:
    config_path = root / "monarch_security.toml"
    config_path.write_text(
        """
[file_watch]
enabled = false

[network]
enabled = false

[persistence]
enabled = false

[posture]
enabled = false

[runtime]
state_path = "data/state.json"
audit_log_path = "logs/audit.jsonl"
pid_path = "data/protector.pid"
control_path = "data/protector.stop"
control_token_path = "data/protector.control.key"
heartbeat_path = "data/protector_heartbeat.json"
integrity_key_path = "data/integrity.key"
stdout_events = false
process_monitor_enabled = false
device_monitor_enabled = false
install_monitor_enabled = false
""".strip()
        + "\n",
        encoding="utf-8",
    )
    return config_path


def _run_cli_json(config_path: Path, argv: list[str]) -> dict:
    output = _run_cli_stdout(config_path, argv)
    lines = [line for line in output.splitlines() if line.strip()]
    if not lines:
        raise AssertionError("CLI did not print JSON")
    return json.loads(lines[-1])


def _run_cli_stdout(config_path: Path, argv: list[str]) -> str:
    stream = StringIO()
    with contextlib.redirect_stdout(stream):
        code = cli_main(["--config", str(config_path), *argv])
    if code != 0:
        raise AssertionError(f"CLI returned {code}: {stream.getvalue()}")
    return stream.getvalue()


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_json(value: str) -> str:
    return json.dumps(json.loads(value), ensure_ascii=True, sort_keys=True, separators=(",", ":"))
