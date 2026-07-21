from __future__ import annotations

import base64
from pathlib import Path
import re

from monarch_security.config import RouterConfig
from monarch_security.events import RuleAssessment, SecurityEvent


SUSPICIOUS_PROCESS_NAMES = {
    "powershell.exe",
    "pwsh.exe",
    "cmd.exe",
    "wscript.exe",
    "cscript.exe",
    "mshta.exe",
    "rundll32.exe",
    "regsvr32.exe",
    "certutil.exe",
    "bitsadmin.exe",
}

SUSPICIOUS_CMD_MARKERS = {
    "-enc",
    "-encodedcommand",
    "-nop",
    "-windowstyle hidden",
    "-w hidden",
    "add-mppreference",
    "bitsadmin",
    "certutil",
    "curl ",
    "downloadfile",
    "downloadstring",
    "executionpolicy bypass",
    "frombase64string",
    "invoke-command",
    "invoke-expression",
    "invoke-restmethod",
    "invoke-webrequest",
    "irm ",
    "iwr ",
    "iex",
    "mshta",
    "new-object net.webclient",
    "reg add",
    "rundll32",
    "schtasks",
    "set-mppreference",
    "start-bitstransfer",
    "wget ",
}

EXECUTABLE_EXTENSIONS = {
    ".exe",
    ".dll",
    ".scr",
    ".msi",
    ".lnk",
    ".ps1",
    ".bat",
    ".cmd",
    ".vbs",
    ".js",
    ".hta",
    ".url",
}

PE_ONLY_EXTENSIONS = {
    ".com",
    ".cpl",
    ".dll",
    ".drv",
    ".exe",
    ".ocx",
    ".scr",
    ".sys",
}

ARCHIVE_EXTENSIONS = {
    ".7z",
    ".cab",
    ".gz",
    ".iso",
    ".jar",
    ".rar",
    ".tar",
    ".zip",
}

DOCUMENT_EXTENSIONS = {
    ".doc",
    ".docm",
    ".docx",
    ".hta",
    ".pdf",
    ".rtf",
    ".xls",
    ".xlsm",
    ".xlsx",
}

TEMP_PATH_MARKERS = {
    "\\appdata\\local\\temp\\",
    "\\windows\\temp\\",
    "\\downloads\\",
}

RISKY_LISTENING_PORTS = {
    21: "FTP listener",
    22: "SSH listener",
    23: "Telnet listener",
    135: "RPC endpoint listener",
    139: "NetBIOS listener",
    445: "SMB listener",
    3389: "Remote Desktop listener",
    5900: "VNC listener",
    5985: "WinRM HTTP listener",
    5986: "WinRM HTTPS listener",
}

RISKY_REMOTE_PORTS = {
    21: "FTP remote service",
    22: "SSH remote service",
    23: "Telnet remote service",
    445: "SMB remote service",
    1337: "common backdoor-style remote port",
    3389: "Remote Desktop remote service",
    4444: "common reverse-shell remote port",
    5555: "ADB or common remote-control port",
    5900: "VNC remote service",
    5985: "WinRM HTTP remote service",
    5986: "WinRM HTTPS remote service",
    6666: "IRC/backdoor-style remote port",
    6667: "IRC/backdoor-style remote port",
}

PUBLIC_CLEAR_TEXT_PORTS = {
    20,
    21,
    23,
    25,
    80,
    110,
    143,
    389,
    8080,
}

PERSISTENCE_EXTENSIONS = {
    ".exe",
    ".bat",
    ".cmd",
    ".ps1",
    ".vbs",
    ".js",
    ".hta",
    ".lnk",
    ".url",
}

HID_DEVICE_CLASSES = {
    "bluetooth",
    "hidclass",
    "keyboard",
    "mouse",
}


class RuleEngine:
    def __init__(self, router_config: RouterConfig) -> None:
        self.router_config = router_config

    def assess(self, event: SecurityEvent) -> RuleAssessment:
        score = 0
        reasons: list[str] = []

        if event.kind == "process.started":
            delta, found = self._score_process(event)
            score += delta
            reasons.extend(found)
        elif event.kind in {"file.scanned", "file.observed"}:
            delta, found = self._score_file(event)
            score += delta
            reasons.extend(found)
        elif event.kind == "device.connected":
            delta, found = self._score_device(event)
            score += delta
            reasons.extend(found)
        elif event.kind == "software.installed":
            delta, found = self._score_software(event)
            score += delta
            reasons.extend(found)
        elif event.kind.startswith("network."):
            delta, found = self._score_network(event)
            score += delta
            reasons.extend(found)
        elif event.kind == "persistence.entry_added":
            delta, found = self._score_persistence(event)
            score += delta
            reasons.extend(found)
        elif event.kind == "security.tamper_detected":
            score = 100
            reasons.append("Monarch Security protected file changed or disappeared")
        elif event.kind == "security.posture_changed":
            delta, found = self._score_posture(event)
            score += delta
            reasons.extend(found)
        else:
            reasons.append("No specialized rule set matched this event")

        score = max(0, min(100, score))
        severity = self._severity(score)
        if score >= self.router_config.llm_threshold:
            route = "llm"
        elif score >= 35:
            route = "deep_scan"
        else:
            route = "local"

        if not reasons:
            reasons.append("No suspicious local indicators found")

        return RuleAssessment(
            event=event,
            score=score,
            severity=severity,
            reasons=reasons,
            route=route,
        )

    def _score_process(self, event: SecurityEvent) -> tuple[int, list[str]]:
        facts = event.facts
        name = str(facts.get("name", "")).lower()
        exe = str(facts.get("exe", "")).lower()
        cmdline = _normalized_command_line(facts.get("cmdline", []))
        codex_managed_shell = _is_codex_managed_powershell(facts)
        decoded = _decode_powershell_encoded_command(facts.get("cmdline", []))
        if decoded is not None:
            if codex_managed_shell:
                cmdline = _normalized_command_line(decoded)
            else:
                cmdline = f"{cmdline} {_normalized_command_line(decoded)}"
        score = 0
        reasons: list[str] = []

        if name in SUSPICIOUS_PROCESS_NAMES and not codex_managed_shell:
            score += 22
            reasons.append(f"Process name is high-attention: {name}")
        elif codex_managed_shell:
            reasons.append("System PowerShell is managed by the installed Codex package")

        if any(marker in exe for marker in TEMP_PATH_MARKERS):
            score += 25
            reasons.append("Executable path is in a user/temp download location")

        matched = _matched_command_markers(cmdline)
        if codex_managed_shell:
            matched = [
                marker
                for marker in matched
                if marker not in {
                    "-enc",
                    "-encodedcommand",
                    "-nop",
                    "executionpolicy bypass",
                }
            ]
        if matched:
            score += 21 + min(35, 7 * len(matched))
            reasons.append("Command line contains suspicious markers: " + ", ".join(matched))

        parent_name = str(facts.get("parent_name", "")).lower()
        if parent_name in {"winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe"}:
            score += 25
            reasons.append(f"Office parent process spawned {name or 'a child process'}")

        return score, reasons

    def _score_network(self, event: SecurityEvent) -> tuple[int, list[str]]:
        facts = event.facts
        score = 0
        reasons: list[str] = []

        if event.kind == "network.listener_seen":
            score += 12
            reasons.append("New listening TCP endpoint observed")
            port = _int_or_none(facts.get("local_port"))
            if port in RISKY_LISTENING_PORTS:
                score += 28
                reasons.append(RISKY_LISTENING_PORTS[port])
            if str(facts.get("local_address") or "") in {"0.0.0.0", "::", "[::]"}:
                score += 12
                reasons.append("Listener is bound on all interfaces")
            if facts.get("local_scope") == "public":
                score += 15
                reasons.append("Listener is bound directly on a public address")
            process_name = str(facts.get("process_name") or "").lower()
            if process_name in SUSPICIOUS_PROCESS_NAMES:
                score += 18
                reasons.append(f"Suspicious process owns listener: {process_name}")

        elif event.kind == "network.connection_seen":
            remote_scope = str(facts.get("remote_scope") or "")
            remote_public = facts.get("remote_is_public") is True or remote_scope == "public"
            if remote_public:
                score += 8
                reasons.append("Connection targets a public internet address")
            process_name = str(facts.get("process_name") or "").lower()
            codex_managed_shell = _is_codex_managed_powershell(
                facts,
                process_prefix="process_",
            )
            if process_name in SUSPICIOUS_PROCESS_NAMES and not codex_managed_shell:
                if remote_public:
                    score += 45
                    reasons.append(
                        f"Suspicious process has an external connection: {process_name}"
                    )
                else:
                    score += 22
                    reasons.append(
                        f"Suspicious process has an established connection: {process_name}"
                    )
            elif codex_managed_shell:
                reasons.append("Network owner is a Codex-managed system PowerShell process")
            process_exe = str(facts.get("process_exe") or "").lower()
            if remote_public and any(marker in process_exe for marker in TEMP_PATH_MARKERS):
                score += 20
                reasons.append("Public internet connection is owned by a temp/download executable")
            process_cmdline = _normalized_command_line(facts.get("process_cmdline", []))
            matched_cmd_markers = _matched_command_markers(process_cmdline)
            if remote_public and matched_cmd_markers:
                score += 25
                reasons.append(
                    "Network-owning process command line contains suspicious markers: "
                    + ", ".join(matched_cmd_markers[:6])
                )
            remote_port = _int_or_none(facts.get("remote_port"))
            if remote_public and remote_port in RISKY_REMOTE_PORTS:
                score += 25
                reasons.append(RISKY_REMOTE_PORTS[remote_port])
            elif remote_port in {4444, 5555, 6666, 6667, 1337}:
                score += 20
                reasons.append(f"Connection uses a high-attention remote port: {remote_port}")
            if remote_public and remote_port in PUBLIC_CLEAR_TEXT_PORTS:
                score += 10
                reasons.append(f"Public internet connection uses cleartext port: {remote_port}")

        elif event.kind == "network.config_changed":
            score += 10
            reasons.append("Network configuration changed")
            if facts.get("network_profile_trusted") is True:
                reasons.append("Network profile is user-trusted")
            else:
                score += 25
                reasons.append("Network profile has not been trusted by the user")
            dns = facts.get("dns")
            gateway = facts.get("gateway")
            if dns:
                score += 5
                reasons.append("DNS server set changed or appeared")
                if facts.get("dns_public_count"):
                    score += 5
                    reasons.append("Network adapter uses public DNS resolvers")
            if gateway:
                score += 5
                reasons.append("Gateway set changed or appeared")

        elif event.kind == "network.neighbor_seen":
            score += 6
            reasons.append("New network neighbor observed passively")

        return score, reasons

    def _score_persistence(self, event: SecurityEvent) -> tuple[int, list[str]]:
        facts = event.facts
        kind = str(facts.get("kind") or "")
        value = f"{facts.get('value') or ''} {facts.get('path') or ''} {facts.get('actions') or ''}".lower()
        extension = str(facts.get("extension") or "").lower()
        if facts.get("approved_baseline_exact_match") is True:
            return 5, ["Persistence entry exactly matches the user-approved baseline"]
        score = 20
        reasons = ["New persistence-capable entry observed"]

        if facts.get("approved_baseline_entry_changed") is True:
            score += 25
            reasons.append("A user-approved persistence entry changed since baseline approval")

        if kind == "run_key":
            score += 15
            reasons.append("Registry Run/RunOnce entry can start at logon")
        elif kind == "startup_file":
            score += 15
            reasons.append("Startup folder entry can run at logon")
        elif kind == "scheduled_task":
            score += 12
            reasons.append("Scheduled task can execute automatically")

        if extension in PERSISTENCE_EXTENSIONS:
            score += 10
            reasons.append(f"Persistence entry points to executable/script type: {extension}")
        if any(marker in value for marker in TEMP_PATH_MARKERS):
            score += 20
            reasons.append("Persistence command references temp/download location")
        if _matched_command_markers(value):
            score += 20
            reasons.append("Persistence command contains suspicious command markers")

        return score, reasons

    def _score_posture(self, event: SecurityEvent) -> tuple[int, list[str]]:
        facts = event.facts
        score = 0
        reasons: list[str] = []
        kind = str(facts.get("kind") or "")

        if kind == "firewall_profile":
            enabled = facts.get("enabled")
            inbound = str(facts.get("default_inbound_action") or "").lower()
            if enabled is False:
                score += 40
                reasons.append(f"Firewall profile disabled: {facts.get('name')}")
            if inbound in {"allow", "0"}:
                score += 25
                reasons.append("Firewall default inbound action allows connections")
        elif kind == "defender_status":
            checks = {
                "antivirus_enabled": "Defender antivirus is disabled",
                "real_time_protection_enabled": "Defender real-time protection is disabled",
                "behavior_monitor_enabled": "Defender behavior monitor is disabled",
                "ioav_protection_enabled": "Defender downloaded-file scanning is disabled",
                "antispyware_enabled": "Defender antispyware is disabled",
            }
            for key, message in checks.items():
                if facts.get(key) is False:
                    score += 18
                    reasons.append(message)

        return score, reasons

    def _score_file(self, event: SecurityEvent) -> tuple[int, list[str]]:
        facts = event.facts
        path = Path(str(facts.get("path", event.subject)))
        suffixes = [suffix.lower() for suffix in path.suffixes]
        lower_path = str(path).lower()
        extension = path.suffix.lower()
        magic_type = str(facts.get("magic_type") or "")
        score = 0
        reasons: list[str] = []

        if facts.get("ransomware_behavior") is True:
            score += 100
            reasons.append(
                f"Rapid multi-file change burst resembles ransomware behavior: {facts.get('burst_count', 'many')} files"
            )

        if extension in EXECUTABLE_EXTENSIONS:
            score += 20
            reasons.append(f"Executable or script extension: {extension}")

        if len(suffixes) >= 2 and suffixes[-1] in EXECUTABLE_EXTENSIONS:
            score += 20
            reasons.append("File uses a double-extension executable pattern")

        if any(marker in lower_path for marker in TEMP_PATH_MARKERS):
            score += 15
            reasons.append("File is located in a temp/download path")

        high_attention_content = (
            extension in EXECUTABLE_EXTENSIONS
            or extension in ARCHIVE_EXTENSIONS
            or extension in DOCUMENT_EXTENSIONS
            or magic_type in {"pe", "zip", "ole_compound"}
        )

        if facts.get("mark_of_the_web") and high_attention_content:
            score += 15
            zone_id = facts.get("zone_id")
            reasons.append(
                f"File has Mark-of-the-Web internet zone metadata: ZoneId={zone_id}"
            )

        if magic_type == "pe" and extension not in PE_ONLY_EXTENSIONS:
            score += 30
            reasons.append("PE executable content is hidden behind a non-PE extension")

        if extension in PE_ONLY_EXTENSIONS and magic_type not in {"pe", ""}:
            score += 15
            reasons.append(f"PE-style extension does not match file content: {magic_type}")

        if facts.get("pe_valid") is False and magic_type == "pe":
            score += 15
            reasons.append("File starts with MZ but has an invalid PE structure")

        pe_section_entropy = facts.get("pe_section_max_entropy")
        if isinstance(pe_section_entropy, (float, int)) and float(pe_section_entropy) >= 7.2:
            score += 20
            reasons.append(
                f"High PE section entropy: {float(pe_section_entropy):.2f}"
            )

        script_markers = facts.get("script_suspicious_markers")
        if isinstance(script_markers, list) and script_markers:
            score += min(40, 12 + 8 * len(script_markers))
            reasons.append(
                "Script contains suspicious primitives: "
                + ", ".join(str(marker) for marker in script_markers[:6])
            )

        if facts.get("script_contains_base64_blob"):
            score += 15
            reasons.append("Script contains a long base64-like blob")

        if facts.get("script_contains_url") and extension in {".ps1", ".bat", ".cmd", ".vbs", ".js", ".hta", ".url"}:
            score += 10
            reasons.append("Script contains a URL")

        archive_executables = facts.get("archive_executable_entries")
        if isinstance(archive_executables, list) and archive_executables:
            score += min(35, 15 + 5 * len(archive_executables))
            reasons.append(
                "Archive contains executable-capable entries: "
                + ", ".join(str(item) for item in archive_executables[:5])
            )

        archive_double_extensions = facts.get("archive_double_extension_entries")
        if isinstance(archive_double_extensions, list) and archive_double_extensions:
            score += 20
            reasons.append(
                "Archive contains double-extension executable entries: "
                + ", ".join(str(item) for item in archive_double_extensions[:5])
            )

        archive_macros = facts.get("archive_macro_indicators")
        if isinstance(archive_macros, list) and archive_macros:
            score += 25
            reasons.append(
                "Archive contains Office macro indicators: "
                + ", ".join(str(item) for item in archive_macros[:5])
            )

        entropy = facts.get("entropy")
        if (
            isinstance(entropy, (float, int))
            and float(entropy) >= 7.2
            and high_attention_content
        ):
            score += 25
            reasons.append(f"High sample entropy: {float(entropy):.2f}")

        if facts.get("hash_skipped"):
            score += 5
            reasons.append("Full hash skipped because file is above configured size budget")

        authenticode_status = str(facts.get("authenticode_status") or "")
        if authenticode_status and authenticode_status != "Unavailable":
            normalized_status = authenticode_status.lower()
            if normalized_status == "valid":
                reasons.append("Authenticode signature is valid")
            elif normalized_status == "notsigned" and high_attention_content:
                score += 15
                reasons.append("High-attention file is not Authenticode signed")
            elif normalized_status in {"hashmismatch", "nottrusted", "nottimevalid"}:
                score += 35
                reasons.append(f"Authenticode signature is not trusted: {authenticode_status}")
            elif normalized_status not in {"unknownerror"} and high_attention_content:
                score += 15
                reasons.append(f"Authenticode status requires review: {authenticode_status}")
            elif normalized_status == "unknownerror" and high_attention_content:
                score += 10
                reasons.append("Authenticode signature check returned an unknown error")

        return score, reasons

    def _score_device(self, event: SecurityEvent) -> tuple[int, list[str]]:
        facts = event.facts
        device_class = str(facts.get("class", "")).lower()
        name = str(facts.get("friendly_name", event.subject)).lower()
        instance_id = str(facts.get("instance_id", "")).lower()
        score = 0
        reasons: list[str] = []

        if facts.get("trusted_device") is True:
            return 0, ["Device is present in the user-approved trust registry"]

        score += 25
        reasons.append("Device is not present in the user-approved trust registry")

        if "usb" in instance_id:
            score += 20
            reasons.append("New USB device appeared")
        if device_class in {"diskdrive", "volume", "wdpdBusEnumRoot".lower()}:
            score += 25
            reasons.append(f"Device class can expose storage: {device_class}")
        if any(marker in name for marker in {"mass storage", "mtp", "phone"}):
            score += 15
            reasons.append("Device name suggests external storage or phone access")
        if "usb" in instance_id and device_class in HID_DEVICE_CLASSES:
            score += 30
            reasons.append(f"New USB human-interface device appeared: {device_class}")
        if str(facts.get("status", "")).lower() not in {"ok", "unknown"}:
            score += 5
            reasons.append(f"Device status is not OK: {facts.get('status')}")

        return score, reasons

    def _score_software(self, event: SecurityEvent) -> tuple[int, list[str]]:
        facts = event.facts
        publisher = str(facts.get("publisher") or "").strip()
        install_location = str(facts.get("install_location") or "").lower()
        score = 10
        reasons = ["New installed software detected"]

        if not publisher:
            score += 25
            reasons.append("Installed software has no publisher metadata")
        if any(marker in install_location for marker in TEMP_PATH_MARKERS):
            score += 25
            reasons.append("Install location is in a temp/download path")
        if not facts.get("uninstall_string_present"):
            score += 10
            reasons.append("Uninstall metadata is missing")

        return score, reasons

    @staticmethod
    def _severity(score: int) -> str:
        if score >= 85:
            return "critical"
        if score >= 65:
            return "high"
        if score >= 35:
            return "medium"
        if score > 0:
            return "low"
        return "clean"


def _int_or_none(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalized_command_line(value) -> str:
    if isinstance(value, str):
        text = value
    else:
        text = " ".join(str(item) for item in value or [])
    return (
        text.lower()
        .replace("`", "")
        .replace("^", "")
        .replace("\u2013", "-")
        .replace("\u2014", "-")
    )


_CODEX_PARENT_PATH = re.compile(
    r"^[a-z]:\\program files\\windowsapps\\openai\.codex_[^\\]+__2p2nqsd0c76g0"
    r"\\app\\chatgpt\.exe$",
    re.IGNORECASE,
)


def _is_codex_managed_powershell(
    facts: dict,
    *,
    process_prefix: str = "",
) -> bool:
    name = str(facts.get(f"{process_prefix}name") or "").casefold()
    executable = _normalized_windows_path(facts.get(f"{process_prefix}exe"))
    parent_names = [str(facts.get(f"{process_prefix}parent_name") or "")]
    parent_executables = [facts.get(f"{process_prefix}parent_exe")]
    ancestor_names = facts.get(f"{process_prefix}ancestor_names")
    ancestor_executables = facts.get(f"{process_prefix}ancestor_exes")
    if isinstance(ancestor_names, (list, tuple)):
        parent_names.extend(str(item) for item in ancestor_names)
    if isinstance(ancestor_executables, (list, tuple)):
        parent_executables.extend(ancestor_executables)
    trusted_lineage = any(
        str(parent_name).casefold() == "chatgpt.exe"
        and bool(_CODEX_PARENT_PATH.fullmatch(_normalized_windows_path(parent_executable)))
        for parent_name, parent_executable in zip(
            parent_names,
            parent_executables,
            strict=False,
        )
    )
    return bool(
        name == "powershell.exe"
        and executable.endswith(
            r"\windows\system32\windowspowershell\v1.0\powershell.exe"
        )
        and trusted_lineage
    )


def _decode_powershell_encoded_command(value, *, max_bytes: int = 131_072) -> str | None:
    if isinstance(value, str):
        arguments = value.split()
    else:
        arguments = [str(item) for item in value or []]
    encoded: str | None = None
    for index, argument in enumerate(arguments[:-1]):
        if argument.casefold() in {"-enc", "-encodedcommand"}:
            encoded = arguments[index + 1]
            break
    if not encoded or len(encoded) > max_bytes * 2:
        return None
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > max_bytes:
            return None
        return raw.decode("utf-16-le", errors="strict")
    except (ValueError, UnicodeError):
        return None


def _normalized_windows_path(value) -> str:
    return str(value or "").strip().replace("/", "\\").casefold()


def _matched_command_markers(command_line: str) -> list[str]:
    matched: list[str] = []
    for marker in SUSPICIOUS_CMD_MARKERS:
        if marker.startswith("-") and " " not in marker:
            pattern = rf"(?<![\w-]){re.escape(marker)}(?![\w-])"
            if re.search(pattern, command_line):
                matched.append(marker)
        elif marker in command_line:
            matched.append(marker)
    return sorted(matched)
