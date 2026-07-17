from __future__ import annotations

from collections import Counter
from typing import Any
from pathlib import Path
import hashlib
import math
import os
import re
import struct
import zipfile

from monarch_security.config import FileConfig
from monarch_security.events import SecurityEvent


HEADER_SAMPLE_BYTES = 8192
SCRIPT_SAMPLE_BYTES = 65536
HASH_SAMPLE_BYTES = 1024 * 1024

SCRIPT_EXTENSIONS = {
    ".bat",
    ".cmd",
    ".hta",
    ".js",
    ".ps1",
    ".url",
    ".vbs",
    ".wsf",
}

PE_EXTENSIONS = {
    ".com",
    ".cpl",
    ".dll",
    ".drv",
    ".exe",
    ".lnk",
    ".msi",
    ".ocx",
    ".scr",
    ".sys",
    ".url",
}

SCRIPT_MARKERS = {
    "-encodedcommand": "PowerShell encoded command",
    "-enc ": "PowerShell short encoded command",
    "-nop": "PowerShell no-profile option",
    "-windowstyle hidden": "hidden PowerShell window",
    "-w hidden": "hidden PowerShell window",
    "add-mppreference": "Microsoft Defender exclusion change",
    "bitsadmin": "BITS transfer utility",
    "certutil": "certutil download/decode utility",
    "curl ": "curl download utility",
    "downloadfile": "script downloads a file",
    "downloadstring": "script downloads and executes text",
    "frombase64string": "base64 decoding",
    "iex": "PowerShell Invoke-Expression shorthand",
    "invoke-expression": "PowerShell Invoke-Expression",
    "invoke-restmethod": "PowerShell web request",
    "invoke-webrequest": "PowerShell web request",
    "irm ": "PowerShell Invoke-RestMethod shorthand",
    "iwr ": "PowerShell Invoke-WebRequest shorthand",
    "mshta": "HTML application launcher",
    "new-object net.webclient": "WebClient download primitive",
    "reg add": "registry modification",
    "rundll32": "DLL execution launcher",
    "schtasks": "scheduled task modification",
    "set-mppreference": "Microsoft Defender preference change",
    "start-bitstransfer": "BITS transfer cmdlet",
    "url=": "internet shortcut target",
    "wget ": "wget download utility",
}

ARCHIVE_SCAN_MAX_ENTRIES = 200
ARCHIVE_EXECUTABLE_EXTENSIONS = {
    ".bat",
    ".cmd",
    ".com",
    ".cpl",
    ".dll",
    ".exe",
    ".hta",
    ".jar",
    ".js",
    ".lnk",
    ".msi",
    ".ps1",
    ".scr",
    ".url",
    ".vbs",
    ".wsf",
}

ARCHIVE_MACRO_MARKERS = {
    "vbaproject.bin",
    "macros/",
    "activecontent",
    "word/vba",
    "xl/vba",
}

PE_MACHINE_NAMES = {
    0x014C: "x86",
    0x8664: "x64",
    0x01C0: "arm",
    0x01C4: "armv7",
    0xAA64: "arm64",
}

PE_SUBSYSTEM_NAMES = {
    1: "native",
    2: "windows_gui",
    3: "windows_console",
    5: "os2_console",
    7: "posix_console",
    9: "windows_ce_gui",
    10: "efi_application",
    11: "efi_boot_service_driver",
    12: "efi_runtime_driver",
    14: "xbox",
    16: "windows_boot_application",
}

BASE64_BLOB_RE = re.compile(r"[A-Za-z0-9+/]{96,}={0,2}")
URL_RE = re.compile(r"https?://", re.IGNORECASE)


class FileScanner:
    def __init__(self, config: FileConfig) -> None:
        self.config = config

    def inspect(self, path: Path) -> SecurityEvent:
        resolved = path.resolve()
        stat = resolved.stat()
        facts = {
            "path": str(resolved),
            "name": resolved.name,
            "size": stat.st_size,
            "extension": resolved.suffix.lower(),
            "exists": True,
        }
        facts.update(self._hash_facts(resolved, stat.st_size))
        facts.update(self._content_facts(resolved))
        facts["entropy"] = self._entropy(resolved)
        return SecurityEvent(
            kind="file.scanned",
            source="file_scanner",
            subject=str(resolved),
            facts=facts,
        )

    def _hash_facts(self, path: Path, size: int) -> dict:
        if size > self.config.max_full_hash_bytes:
            return {
                "sha256": None,
                "hash_skipped": True,
                "hash_reason": "above max_full_hash_bytes",
                **self._partial_hash_facts(path, size),
            }

        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return {
            "sha256": digest.hexdigest(),
            "hash_skipped": False,
        }

    def _partial_hash_facts(self, path: Path, size: int) -> dict[str, Any]:
        try:
            first = hashlib.sha256()
            last = hashlib.sha256()
            with path.open("rb") as handle:
                first.update(handle.read(HASH_SAMPLE_BYTES))
                if size > HASH_SAMPLE_BYTES:
                    handle.seek(max(0, size - HASH_SAMPLE_BYTES))
                    last.update(handle.read(HASH_SAMPLE_BYTES))
        except OSError as exc:
            return {"partial_hash_error": str(exc)}

        return {
            "sha256_first_mb": first.hexdigest(),
            "sha256_last_mb": last.hexdigest() if size > HASH_SAMPLE_BYTES else None,
        }

    def _content_facts(self, path: Path) -> dict[str, Any]:
        facts: dict[str, Any] = {}
        try:
            with path.open("rb") as handle:
                header = handle.read(HEADER_SAMPLE_BYTES)
        except OSError as exc:
            return {"content_error": str(exc)}

        facts["magic_type"] = _magic_type(header)
        facts.update(self._zone_identifier_facts(path))

        if facts["magic_type"] == "pe":
            facts.update(self._pe_facts(path))

        if facts["magic_type"] == "zip":
            facts.update(self._archive_facts(path))

        if path.suffix.lower() in SCRIPT_EXTENSIONS:
            facts.update(self._script_facts(path))

        return facts

    def _archive_facts(self, path: Path) -> dict[str, Any]:
        facts: dict[str, Any] = {
            "archive_entry_count": 0,
            "archive_executable_entries": [],
            "archive_double_extension_entries": [],
            "archive_macro_indicators": [],
        }
        try:
            with zipfile.ZipFile(path) as archive:
                infos = archive.infolist()[:ARCHIVE_SCAN_MAX_ENTRIES]
        except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
            facts["archive_error"] = str(exc)
            return facts

        executable_entries: list[str] = []
        double_extension_entries: list[str] = []
        macro_indicators: list[str] = []
        for info in infos:
            name = info.filename.replace("\\", "/")
            lower_name = name.lower()
            entry_path = Path(lower_name)
            suffixes = [suffix.lower() for suffix in entry_path.suffixes]
            if suffixes and suffixes[-1] in ARCHIVE_EXECUTABLE_EXTENSIONS:
                executable_entries.append(name)
            if len(suffixes) >= 2 and suffixes[-1] in ARCHIVE_EXECUTABLE_EXTENSIONS:
                double_extension_entries.append(name)
            if any(marker in lower_name for marker in ARCHIVE_MACRO_MARKERS):
                macro_indicators.append(name)

        facts.update(
            {
                "archive_entry_count": len(infos),
                "archive_entries_truncated": len(infos) >= ARCHIVE_SCAN_MAX_ENTRIES,
                "archive_executable_entries": executable_entries[:20],
                "archive_double_extension_entries": double_extension_entries[:20],
                "archive_macro_indicators": macro_indicators[:20],
            }
        )
        return facts

    def _entropy(self, path: Path) -> float | None:
        budget = self.config.entropy_sample_bytes
        if budget <= 0:
            return None
        with path.open("rb") as handle:
            data = handle.read(budget)
        if not data:
            return 0.0
        counts = Counter(data)
        length = len(data)
        entropy = -sum((count / length) * math.log2(count / length) for count in counts.values())
        return round(float(entropy), 4)

    def _zone_identifier_facts(self, path: Path) -> dict[str, Any]:
        if os.name != "nt":
            return {"mark_of_the_web": False, "zone_id": None}

        stream_path = f"{path}:Zone.Identifier"
        try:
            with open(stream_path, "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read(4096)
        except OSError:
            return {"mark_of_the_web": False, "zone_id": None}

        zone_id = None
        for line in text.splitlines():
            name, separator, value = line.partition("=")
            if separator and name.strip().lower() == "zoneid":
                try:
                    zone_id = int(value.strip())
                except ValueError:
                    zone_id = None
                break

        return {
            "mark_of_the_web": zone_id in {3, 4},
            "zone_id": zone_id,
        }

    def _script_facts(self, path: Path) -> dict[str, Any]:
        try:
            with path.open("rb") as handle:
                data = handle.read(SCRIPT_SAMPLE_BYTES)
        except OSError as exc:
            return {"script_error": str(exc)}

        if b"\x00" in data[:2048]:
            return {"script_binary_like": True}

        text = data.decode("utf-8", errors="replace")
        lowered = text.lower()
        markers = [
            label
            for marker, label in SCRIPT_MARKERS.items()
            if marker in lowered
        ]

        return {
            "script_binary_like": False,
            "script_suspicious_markers": sorted(set(markers)),
            "script_contains_url": URL_RE.search(text) is not None,
            "script_contains_base64_blob": BASE64_BLOB_RE.search(text) is not None,
            "script_sample_bytes": len(data),
        }

    def _pe_facts(self, path: Path) -> dict[str, Any]:
        facts: dict[str, Any] = {"pe_valid": False}
        try:
            with path.open("rb") as handle:
                dos_header = handle.read(64)
                if len(dos_header) < 64 or dos_header[:2] != b"MZ":
                    return facts

                pe_offset = struct.unpack_from("<I", dos_header, 0x3C)[0]
                if pe_offset < 64 or pe_offset > 16 * 1024 * 1024:
                    facts["pe_error"] = "invalid PE header offset"
                    return facts

                handle.seek(pe_offset)
                pe_header = handle.read(24)
                if len(pe_header) < 24 or pe_header[:4] != b"PE\x00\x00":
                    facts["pe_error"] = "missing PE signature"
                    return facts

                (
                    machine,
                    section_count,
                    timestamp,
                    _symbol_table,
                    _symbol_count,
                    optional_header_size,
                    characteristics,
                ) = struct.unpack_from("<HHIIIHH", pe_header, 4)

                optional = handle.read(optional_header_size)
                subsystem = None
                optional_magic = None
                if len(optional) >= 70:
                    optional_magic = struct.unpack_from("<H", optional, 0)[0]
                    subsystem = struct.unpack_from("<H", optional, 68)[0]

                sections = []
                max_section_entropy = None
                section_table = handle.read(max(0, section_count) * 40)
                for index in range(section_count):
                    offset = index * 40
                    if offset + 40 > len(section_table):
                        break
                    entry = section_table[offset : offset + 40]
                    name = entry[:8].rstrip(b"\x00").decode("ascii", errors="replace")
                    raw_size = struct.unpack_from("<I", entry, 16)[0]
                    raw_pointer = struct.unpack_from("<I", entry, 20)[0]
                    entropy = _section_entropy(handle, raw_pointer, raw_size)
                    if entropy is not None:
                        max_section_entropy = (
                            entropy
                            if max_section_entropy is None
                            else max(max_section_entropy, entropy)
                        )
                    sections.append(
                        {
                            "name": name,
                            "raw_size": raw_size,
                            "entropy": entropy,
                        }
                    )

        except (OSError, struct.error) as exc:
            facts["pe_error"] = str(exc)
            return facts

        facts.update(
            {
                "pe_valid": True,
                "pe_machine": PE_MACHINE_NAMES.get(machine, hex(machine)),
                "pe_section_count": section_count,
                "pe_timestamp": timestamp,
                "pe_characteristics": characteristics,
                "pe_optional_magic": hex(optional_magic) if optional_magic is not None else None,
                "pe_subsystem": PE_SUBSYSTEM_NAMES.get(subsystem, subsystem),
                "pe_sections": sections[:12],
                "pe_section_max_entropy": max_section_entropy,
            }
        )
        return facts


def _magic_type(header: bytes) -> str:
    if not header:
        return "empty"
    if header.startswith(b"MZ"):
        return "pe"
    if header.startswith(b"PK\x03\x04") or header.startswith(b"PK\x05\x06"):
        return "zip"
    if header.startswith(b"\x7fELF"):
        return "elf"
    if header.startswith(b"\xCF\xD0\xE0\x11"):
        return "ole_compound"
    if header.startswith(b"%PDF"):
        return "pdf"
    if b"\x00" not in header[:2048]:
        return "text"
    return "binary"


def _section_entropy(handle, raw_pointer: int, raw_size: int) -> float | None:
    if raw_pointer <= 0 or raw_size <= 0:
        return None

    try:
        current = handle.tell()
        handle.seek(raw_pointer)
        data = handle.read(min(raw_size, HASH_SAMPLE_BYTES))
        handle.seek(current)
    except OSError:
        return None

    if not data:
        return None
    counts = Counter(data)
    length = len(data)
    entropy = -sum((count / length) * math.log2(count / length) for count in counts.values())
    return round(float(entropy), 4)


def is_probably_same_volume(path: Path) -> bool:
    try:
        return path.drive.lower() == Path.cwd().drive.lower()
    except OSError:
        return os.path.exists(path)
