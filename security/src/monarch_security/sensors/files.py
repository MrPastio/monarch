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

ARCHIVE_METADATA_MAX_ENTRIES = 4096
ARCHIVE_CENTRAL_DIRECTORY_MAX_BYTES = 4 * 1024 * 1024
ARCHIVE_EOCD_MAX_BYTES = 22 + 65_535
ARCHIVE_NAME_MAX_CHARS = 512
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

PE_MAX_SECTIONS = 96
PE_MAX_OPTIONAL_HEADER_BYTES = 4096
PE_SECTION_HEADER_BYTES = 40
PE_SECTION_SAMPLE_MAX_BYTES = HASH_SAMPLE_BYTES
PE_SECTION_SAMPLE_TOTAL_BYTES = 8 * 1024 * 1024

BASE64_BLOB_RE = re.compile(r"[A-Za-z0-9+/]{96,}={0,2}")
URL_RE = re.compile(r"https?://", re.IGNORECASE)


class FileScanner:
    def __init__(self, config: FileConfig) -> None:
        self.config = config

    def inspect(self, path: Path) -> SecurityEvent:
        from monarch_security.file_parser_worker import inspect_file_isolated

        return inspect_file_isolated(path, self.config)

    def _inspect_local(self, path: Path) -> SecurityEvent:
        if os.environ.get("MONARCH_SECURITY_FILE_PARSER_WORKER") != "1":
            raise RuntimeError("local file inspection is reserved for the isolated parser worker")
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
            "archive_entries_scanned": 0,
            "archive_entries_truncated": False,
            "archive_executable_entries": [],
            "archive_double_extension_entries": [],
            "archive_macro_indicators": [],
        }
        metadata = _zip_directory_metadata(path)
        facts.update(metadata)
        if metadata.get("archive_metadata_budget_exceeded"):
            return facts
        if metadata.get("archive_error"):
            return facts
        try:
            with zipfile.ZipFile(path) as archive:
                infos = archive.infolist()
        except (OSError, RuntimeError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
            facts["archive_error"] = _bounded_text(str(exc))
            return facts

        if len(infos) > ARCHIVE_METADATA_MAX_ENTRIES:
            facts.update(
                {
                    "archive_entry_count": len(infos),
                    "archive_entries_truncated": True,
                    "archive_metadata_budget_exceeded": True,
                    "archive_error": "ZIP entry count exceeds parser budget",
                }
            )
            return facts

        executable_entries: list[str] = []
        double_extension_entries: list[str] = []
        macro_indicators: list[str] = []
        for info in infos:
            full_name = info.filename.replace("\\", "/")
            name = _bounded_archive_name(full_name)
            lower_name = full_name.lower()
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
                "archive_entries_scanned": len(infos),
                "archive_entries_truncated": False,
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

                facts.update(
                    {
                        "pe_machine": PE_MACHINE_NAMES.get(machine, hex(machine)),
                        "pe_section_count": section_count,
                        "pe_timestamp": timestamp,
                        "pe_characteristics": characteristics,
                        "pe_section_limit": PE_MAX_SECTIONS,
                        "pe_section_sample_limit_bytes": PE_SECTION_SAMPLE_TOTAL_BYTES,
                    }
                )
                if section_count > PE_MAX_SECTIONS:
                    facts.update(
                        {
                            "pe_metadata_budget_exceeded": True,
                            "pe_error": "PE section count exceeds parser budget",
                        }
                    )
                    return facts
                if optional_header_size > PE_MAX_OPTIONAL_HEADER_BYTES:
                    facts.update(
                        {
                            "pe_metadata_budget_exceeded": True,
                            "pe_error": "PE optional header exceeds parser budget",
                        }
                    )
                    return facts

                optional = handle.read(optional_header_size)
                if len(optional) != optional_header_size:
                    facts["pe_error"] = "truncated PE optional header"
                    return facts
                subsystem = None
                optional_magic = None
                if len(optional) >= 70:
                    optional_magic = struct.unpack_from("<H", optional, 0)[0]
                    subsystem = struct.unpack_from("<H", optional, 68)[0]

                sections: list[dict[str, Any]] = []
                max_section_entropy = None
                expected_table_bytes = section_count * PE_SECTION_HEADER_BYTES
                section_table = handle.read(expected_table_bytes)
                if len(section_table) != expected_table_bytes:
                    facts["pe_error"] = "truncated PE section table"
                    return facts
                sampled_section_bytes = 0
                entropy_truncated = False
                for index in range(section_count):
                    offset = index * PE_SECTION_HEADER_BYTES
                    entry = section_table[offset : offset + PE_SECTION_HEADER_BYTES]
                    name = entry[:8].rstrip(b"\x00").decode("ascii", errors="replace")
                    raw_size = struct.unpack_from("<I", entry, 16)[0]
                    raw_pointer = struct.unpack_from("<I", entry, 20)[0]
                    remaining_budget = max(
                        0,
                        PE_SECTION_SAMPLE_TOTAL_BYTES - sampled_section_bytes,
                    )
                    entropy, sampled_bytes = _section_entropy(
                        handle,
                        raw_pointer,
                        raw_size,
                        remaining_budget,
                    )
                    sampled_section_bytes += sampled_bytes
                    requested_sample = min(raw_size, PE_SECTION_SAMPLE_MAX_BYTES)
                    if requested_sample > sampled_bytes:
                        entropy_truncated = True
                    if entropy is not None:
                        max_section_entropy = (
                            entropy
                            if max_section_entropy is None
                            else max(max_section_entropy, entropy)
                        )
                    if len(sections) < 12:
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
                "pe_optional_magic": hex(optional_magic) if optional_magic is not None else None,
                "pe_subsystem": PE_SUBSYSTEM_NAMES.get(subsystem, subsystem),
                "pe_sections": sections,
                "pe_section_max_entropy": max_section_entropy,
                "pe_section_sampled_bytes": sampled_section_bytes,
                "pe_section_entropy_truncated": entropy_truncated,
            }
        )
        return facts


def _zip_directory_metadata(path: Path) -> dict[str, Any]:
    try:
        file_size = path.stat().st_size
        if file_size < 22:
            return {"archive_error": "ZIP end record is missing"}
        with path.open("rb") as handle:
            tail_size = min(file_size, ARCHIVE_EOCD_MAX_BYTES)
            handle.seek(file_size - tail_size)
            tail = handle.read(tail_size)
            relative_offset = tail.rfind(b"PK\x05\x06")
            if relative_offset < 0 or relative_offset + 22 > len(tail):
                return {"archive_error": "ZIP end record is missing"}
            (
                _signature,
                disk_number,
                directory_disk,
                entries_on_disk,
                total_entries,
                directory_bytes,
                directory_offset,
                comment_bytes,
            ) = struct.unpack_from("<4s4H2LH", tail, relative_offset)
            absolute_offset = file_size - tail_size + relative_offset
            if relative_offset + 22 + comment_bytes > len(tail):
                return {"archive_error": "ZIP end record is truncated"}
            if (
                total_entries == 0xFFFF
                or entries_on_disk == 0xFFFF
                or directory_bytes == 0xFFFFFFFF
                or directory_offset == 0xFFFFFFFF
            ):
                zip64 = _zip64_directory_metadata(handle, absolute_offset, file_size)
                if "archive_error" in zip64:
                    return zip64
                disk_number = int(zip64["disk_number"])
                directory_disk = int(zip64["directory_disk"])
                entries_on_disk = int(zip64["entries_on_disk"])
                total_entries = int(zip64["total_entries"])
                directory_bytes = int(zip64["directory_bytes"])
                directory_offset = int(zip64["directory_offset"])
    except (OSError, struct.error, ValueError) as exc:
        return {"archive_error": _bounded_text(str(exc))}

    facts: dict[str, Any] = {
        "archive_declared_entry_count": total_entries,
        "archive_entry_count": total_entries,
        "archive_central_directory_bytes": directory_bytes,
        "archive_entry_limit": ARCHIVE_METADATA_MAX_ENTRIES,
        "archive_central_directory_limit_bytes": ARCHIVE_CENTRAL_DIRECTORY_MAX_BYTES,
    }
    if disk_number != 0 or directory_disk != 0 or entries_on_disk != total_entries:
        facts["archive_error"] = "Multi-disk ZIP metadata is unsupported"
        return facts
    if (
        total_entries > ARCHIVE_METADATA_MAX_ENTRIES
        or directory_bytes > ARCHIVE_CENTRAL_DIRECTORY_MAX_BYTES
    ):
        facts.update(
            {
                "archive_entries_truncated": True,
                "archive_metadata_budget_exceeded": True,
                "archive_error": "ZIP metadata exceeds parser budget",
            }
        )
        return facts
    if directory_offset > file_size or directory_bytes > file_size:
        facts["archive_error"] = "ZIP central directory range is invalid"
        return facts
    return facts


def _zip64_directory_metadata(handle, eocd_offset: int, file_size: int) -> dict[str, Any]:
    locator_offset = eocd_offset - 20
    if locator_offset < 0:
        return {"archive_error": "ZIP64 locator is missing"}
    handle.seek(locator_offset)
    locator = handle.read(20)
    if len(locator) != 20 or locator[:4] != b"PK\x06\x07":
        return {"archive_error": "ZIP64 locator is missing"}
    _signature, locator_disk, record_offset, total_disks = struct.unpack("<4sLQL", locator)
    if locator_disk != 0 or total_disks != 1 or record_offset > file_size - 56:
        return {"archive_error": "ZIP64 locator range is invalid"}
    handle.seek(record_offset)
    record = handle.read(56)
    if len(record) != 56 or record[:4] != b"PK\x06\x06":
        return {"archive_error": "ZIP64 end record is missing"}
    (
        _signature,
        record_size,
        _created_version,
        _required_version,
        disk_number,
        directory_disk,
        entries_on_disk,
        total_entries,
        directory_bytes,
        directory_offset,
    ) = struct.unpack("<4sQ2H2L4Q", record)
    if record_size < 44:
        return {"archive_error": "ZIP64 end record is truncated"}
    return {
        "disk_number": disk_number,
        "directory_disk": directory_disk,
        "entries_on_disk": entries_on_disk,
        "total_entries": total_entries,
        "directory_bytes": directory_bytes,
        "directory_offset": directory_offset,
    }


def _bounded_text(value: object, limit: int = 512) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ")
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def _bounded_archive_name(value: str) -> str:
    text = value.replace("\r", " ").replace("\n", " ")
    if len(text) <= ARCHIVE_NAME_MAX_CHARS:
        return text
    prefix = (ARCHIVE_NAME_MAX_CHARS - 1) // 2
    suffix = ARCHIVE_NAME_MAX_CHARS - prefix - 1
    return text[:prefix] + "…" + text[-suffix:]


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


def _section_entropy(
    handle,
    raw_pointer: int,
    raw_size: int,
    remaining_budget: int,
) -> tuple[float | None, int]:
    if raw_pointer <= 0 or raw_size <= 0 or remaining_budget <= 0:
        return None, 0

    try:
        current = handle.tell()
        handle.seek(raw_pointer)
        data = handle.read(
            min(raw_size, PE_SECTION_SAMPLE_MAX_BYTES, remaining_budget)
        )
        handle.seek(current)
    except OSError:
        return None, 0

    if not data:
        return None, 0
    counts = Counter(data)
    length = len(data)
    entropy = -sum((count / length) * math.log2(count / length) for count in counts.values())
    return round(float(entropy), 4), length


def is_probably_same_volume(path: Path) -> bool:
    try:
        return path.drive.lower() == Path.cwd().drive.lower()
    except OSError:
        return os.path.exists(path)
