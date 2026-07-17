from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
import json
import os
import secrets
import time

from .analysis import RuleEngine
from .actions import request_emergency_containment, request_emergency_resolution
from .audit import AuditLog
from .behavior import FileBurstDetector
from .config import AppConfig
from .deep_scan import AUTHENTICODE_EXTENSIONS, authenticode_facts
from .events import SecurityEvent
from .emergency import EmergencyError, EmergencyManager, EmergencyStore
from .integrity import hmac_sha256
from .incidents import IncidentCorrelator, IncidentStore
from .llm import LLMRouter
from .notifications import NotificationManager
from .network_history import NetworkHistoryStore, NetworkObservation, with_network_profile_trust
from .policy import PolicyEngine
from .profile import read_model_command_policy, read_security_profile
from .pin import SecurityPinManager
from .resources import ResourceGuard
from .sensors import (
    DeviceSensor,
    FileChangeSensor,
    FileScanner,
    InstallSensor,
    NetworkSensor,
    PersistenceSensor,
    PostureSensor,
    ProcessSensor,
    TamperSensor,
)
from .state import StateStore


HEARTBEAT_INTERVAL_SECONDS = 10.0

WATCH_DEEP_EXTENSIONS = AUTHENTICODE_EXTENSIONS | {
    ".7z",
    ".cab",
    ".doc",
    ".docm",
    ".docx",
    ".gz",
    ".iso",
    ".jar",
    ".pdf",
    ".rar",
    ".rtf",
    ".tar",
    ".xls",
    ".xlsm",
    ".xlsx",
    ".zip",
}


@dataclass
class _ScheduledSensor:
    name: str
    sensor: object
    interval: float
    next_run: float = 0.0


class SecuritySupervisor:
    def __init__(
        self,
        config: AppConfig,
        resources: ResourceGuard,
        rules: RuleEngine,
        router: LLMRouter,
        policy: PolicyEngine,
        audit: AuditLog,
        state: StateStore,
        no_llm: bool = False,
    ) -> None:
        self.config = config
        self.resources = resources
        self.rules = rules
        self.router = router
        self.policy = policy
        self.audit = audit
        self.state = state
        self.no_llm = no_llm
        self.profile = read_security_profile(config)
        self.model_policy = read_model_command_policy(config)
        self.incident_store = IncidentStore(
            config.runtime.incident_log_path,
            config.runtime.integrity_key_path,
            max_bytes=config.runtime.max_incident_log_bytes,
            max_archives=config.runtime.max_incident_archives,
            max_live_incidents=config.runtime.max_live_incidents,
            compact_on_open=True,
        )
        self.incidents = IncidentCorrelator(self.incident_store)
        self.emergency = EmergencyManager(
            self.incident_store,
            EmergencyStore(config.runtime.emergency_log_path, config.runtime.integrity_key_path),
            SecurityPinManager(config.runtime.security_pin_path, config.runtime.integrity_key_path),
            contain_fn=request_emergency_containment,
            resolve_fn=request_emergency_resolution,
            recovery_seconds=config.runtime.emergency_recovery_seconds,
        )
        self.file_burst_detector = FileBurstDetector()
        self.network_history = (
            NetworkHistoryStore(
                config.runtime.network_history_path,
                config.runtime.integrity_key_path,
            )
            if config.network.enabled
            else None
        )
        self.sensors = self._build_sensors()
        self.notifications = NotificationManager(config.notifications)
        self._invalid_stop_reported = False
        self._heartbeat_write_error_reported = False
        self._last_heartbeat_at = 0.0

    def run(self, duration: float) -> int:
        start = time.monotonic()
        self._prepare_runtime_markers()
        self.audit.status(
            {
                "status": "supervisor_started",
                "duration": duration,
                "lazy_llm": not self.no_llm,
                "security_level": self.profile.level,
                "sensors": [sensor.name for sensor in self.sensors],
            }
        )

        try:
            while duration <= 0 or time.monotonic() - start < duration:
                if self._should_stop():
                    self.audit.status({"status": "supervisor_stopped", "reason": "stop_requested"})
                    self._cleanup_runtime_markers()
                    return 0
                if not self._refresh_runtime_settings():
                    self.audit.status({"status": "supervisor_stopped", "reason": "security_profile_off"})
                    self._cleanup_runtime_markers()
                    return 0

                emitted = 0
                now = time.monotonic()
                for scheduled in self.sensors:
                    if now < scheduled.next_run:
                        continue
                    for event in self._poll(scheduled):
                        self._handle_event(event)
                        emitted += 1
                        if emitted >= self.config.runtime.max_events_per_tick:
                            break
                    scheduled.next_run = time.monotonic() + self._interval(scheduled)
                    if emitted >= self.config.runtime.max_events_per_tick:
                        break

                self.router.maintenance()
                self.state.save_if_dirty()
                self._write_heartbeat_if_due(now)
                self._sleep_until_next_sensor(start, duration)
        except KeyboardInterrupt:
            self.audit.status({"status": "supervisor_stopped", "reason": "keyboard_interrupt"})
            self._cleanup_runtime_markers()
            return 130

        self.audit.status({"status": "supervisor_finished"})
        self._cleanup_runtime_markers()
        return 0

    def _refresh_runtime_settings(self) -> bool:
        """Apply user profile/policy changes without restarting the protector."""
        profile = read_security_profile(self.config)
        model_policy = read_model_command_policy(self.config)
        if profile.level != self.profile.level:
            previous_level = self.profile.level
            self.profile = profile
            self.sensors = self._build_sensors()
            self.audit.status({
                "status": "security_profile_applied",
                "previous_level": previous_level,
                "level": profile.level,
                "sensor_count": len(self.sensors),
            })
        if model_policy != self.model_policy:
            self.model_policy = model_policy
            self.audit.status({
                "status": "model_command_policy_applied",
                **model_policy.to_dict(),
            })
        return self.profile.monitoring_enabled

    def _build_sensors(self) -> list[_ScheduledSensor]:
        sensors: list[_ScheduledSensor] = []
        if not self.profile.monitoring_enabled:
            return sensors
        now = time.monotonic()
        if self.config.runtime.process_monitor_enabled:
            sensors.append(
                _ScheduledSensor(
                    name="process_sensor",
                    sensor=ProcessSensor(include_existing=False),
                    interval=self.config.resources.min_process_poll_seconds,
                )
            )
        if self.config.runtime.device_monitor_enabled:
            sensors.append(
                _ScheduledSensor(
                    name="device_sensor",
                    sensor=DeviceSensor(
                        include_existing=False,
                        initial_seen=set(self.state.get_list("known_devices")),
                    ),
                    interval=self.config.runtime.device_poll_seconds,
                    next_run=now + self.config.runtime.device_poll_seconds,
                )
            )
        if self.config.file_watch.enabled:
            sensors.append(
                _ScheduledSensor(
                    name="file_watch_sensor",
                    sensor=FileChangeSensor(
                        paths=self.config.file_watch.paths,
                        recursive=self.config.file_watch.recursive,
                        max_entries_per_tick=self.config.file_watch.max_entries_per_tick,
                        include_existing=False,
                        initial_signatures=self.state.get_dict("known_file_signatures"),
                    ),
                    interval=self.config.file_watch.poll_seconds,
                    next_run=now + min(3.0, self.config.file_watch.poll_seconds),
                )
            )
        if self.config.runtime.install_monitor_enabled:
            sensors.append(
                _ScheduledSensor(
                    name="install_sensor",
                    sensor=InstallSensor(
                        include_existing=False,
                        initial_seen=set(self.state.get_list("known_installs")),
                    ),
                    interval=self.config.runtime.install_poll_seconds,
                    next_run=now + self.config.runtime.install_poll_seconds,
                )
            )
        if self.config.runtime.self_protection_enabled:
            sensors.append(
                _ScheduledSensor(
                    name="tamper_sensor",
                    sensor=TamperSensor(
                        paths=self_protection_paths(self.config),
                        include_existing=False,
                        initial_signatures=self.state.get_dict("known_self_protection_signatures"),
                    ),
                    interval=self.config.runtime.self_protection_poll_seconds,
                    next_run=now + min(15.0, self.config.runtime.self_protection_poll_seconds),
                )
            )
        if self.config.network.enabled:
            sensors.append(
                _ScheduledSensor(
                    name="network_sensor",
                    sensor=NetworkSensor(
                        self.config.network,
                        include_existing=False,
                        initial_signatures=self.state.get_dict("known_network_signatures"),
                    ),
                    interval=self.config.network.poll_seconds,
                    next_run=now + min(5.0, self.config.network.poll_seconds),
                )
            )
        if self.config.persistence.enabled:
            sensors.append(
                _ScheduledSensor(
                    name="persistence_sensor",
                    sensor=PersistenceSensor(
                        self.config.persistence,
                        include_existing=False,
                        initial_signatures=self.state.get_dict("known_persistence_signatures"),
                        approved_signatures=self.state.get_dict("approved_persistence_signatures"),
                    ),
                    interval=self.config.persistence.poll_seconds,
                    next_run=now + self.config.persistence.poll_seconds,
                )
            )
        if self.config.posture.enabled:
            sensors.append(
                _ScheduledSensor(
                    name="posture_sensor",
                    sensor=PostureSensor(
                        self.config.posture,
                        include_existing=False,
                        initial_signatures=self.state.get_dict("known_posture_signatures"),
                    ),
                    interval=self.config.posture.poll_seconds,
                    next_run=now + min(10.0, self.config.posture.poll_seconds),
                )
            )
        for scheduled in sensors:
            scheduled.interval = max(1.0, scheduled.interval * self.profile.interval_multiplier)
            if scheduled.next_run > now:
                scheduled.next_run = now + max(1.0, (scheduled.next_run - now) * self.profile.interval_multiplier)
        return sensors

    def _poll(self, scheduled: _ScheduledSensor) -> Iterable[SecurityEvent]:
        poll = getattr(scheduled.sensor, "poll")
        events = list(poll())
        # Reload under the cross-process lock before persisting sensor state.
        # Otherwise a long-lived protector can overwrite CLI trust/profile
        # changes with the snapshot it loaded at startup.
        with self.state.lock():
            if scheduled.name == "device_sensor":
                self.state.set_list("known_devices", scheduled.sensor.seen_ids)
            elif scheduled.name == "install_sensor":
                self.state.set_list("known_installs", scheduled.sensor.seen_ids)
            elif scheduled.name == "file_watch_sensor":
                self.state.set_dict("known_file_signatures", scheduled.sensor.signatures)
            elif scheduled.name == "network_sensor":
                self.state.set_dict("known_network_signatures", scheduled.sensor.signatures)
            elif scheduled.name == "persistence_sensor":
                self.state.set_dict("known_persistence_signatures", scheduled.sensor.signatures)
            elif scheduled.name == "posture_sensor":
                self.state.set_dict("known_posture_signatures", scheduled.sensor.signatures)
            elif scheduled.name == "tamper_sensor":
                self.state.set_dict("known_self_protection_signatures", scheduled.sensor.signatures)
        return events

    def _handle_event(self, event: SecurityEvent) -> None:
        event = _with_device_trust(event, set(self.state.get_list("trusted_device_ids")))
        event = with_network_profile_trust(
            event,
            set(self.state.get_list("trusted_network_profiles")),
        )
        burst_event = self.file_burst_detector.observe(event)
        assessment = self.rules.assess(event)
        if event.kind == "file.observed" and _should_deep_inspect_file_event(event, assessment.score):
            path = event.facts.get("path")
            if isinstance(path, str):
                try:
                    event = FileScanner(self.config.files).inspect(Path(path))
                    event = _with_authenticode_facts_if_needed(event)
                    assessment = self.rules.assess(event)
                except OSError:
                    pass
        if self.network_history is not None and event.kind.startswith("network."):
            self.network_history.append(NetworkObservation.from_assessment(assessment))
        decision = (
            self.policy.local_decision(assessment) if self.no_llm else self.router.decide(assessment)
        )
        incident = self.incidents.observe(assessment, decision)
        self.audit.decision(assessment, decision)
        if incident is not None:
            self.audit.write(
                "incident",
                {
                    "incident_id": incident.incident_id,
                    "risk_score": incident.risk_score,
                    "risk_level": incident.risk_level,
                    "evidence_families": list(incident.evidence_families),
                    "decision_required": incident.decision_required,
                    "emergency_eligible": incident.emergency_eligible,
                },
            )
            if (
                self.config.runtime.emergency_auto_lock_enabled
                and incident.risk_score >= 700
                and incident.emergency_eligible
            ):
                before = self.emergency.store.latest_active()
                try:
                    emergency = self.emergency.activate(incident.incident_id)
                    if before is None and emergency.state in {"activating", "awaiting_user"}:
                        self.audit.write("emergency_activated", emergency.to_dict())
                except EmergencyError as exc:
                    self.audit.status({
                        "status": "emergency_activation_rejected",
                        "incident_id": incident.incident_id,
                        "reason": str(exc),
                    })
        notification = self.notifications.notify(assessment, decision, incident=incident)
        if notification.sent:
            self.audit.status(
                {
                    "status": "notification_sent",
                    "reason": notification.reason,
                    "event_id": assessment.event.event_id,
                    "score": assessment.score,
                    "severity": assessment.severity,
                }
            )
        if burst_event is not None:
            self._handle_event(burst_event)

    def _interval(self, scheduled: _ScheduledSensor) -> float:
        if scheduled.name == "process_sensor":
            return self.resources.process_poll_seconds()
        return scheduled.interval

    def _sleep_until_next_sensor(self, start: float, duration: float) -> None:
        now = time.monotonic()
        next_run = min((sensor.next_run for sensor in self.sensors), default=now + 1.0)
        interval = max(0.25, min(1.0, next_run - now))
        if duration > 0:
            remaining = duration - (now - start)
            if remaining <= 0:
                return
            interval = min(interval, remaining)
        time.sleep(interval)

    def _prepare_runtime_markers(self) -> None:
        self.config.runtime.pid_path.parent.mkdir(parents=True, exist_ok=True)
        self.config.runtime.pid_path.write_text(str(os.getpid()), encoding="utf-8")
        self.config.runtime.control_token_path.write_text(
            secrets.token_hex(32) + "\n",
            encoding="utf-8",
        )
        try:
            os.chmod(self.config.runtime.control_token_path, 0o600)
        except OSError:
            pass
        if self.config.runtime.control_path.exists():
            self.config.runtime.control_path.unlink()
        self._write_heartbeat("starting")

    def _cleanup_runtime_markers(self) -> None:
        self._write_heartbeat("stopped")
        try:
            if self.config.runtime.pid_path.exists():
                self.config.runtime.pid_path.unlink()
            if self.config.runtime.control_token_path.exists():
                self.config.runtime.control_token_path.unlink()
        except OSError:
            pass

    def _should_stop(self) -> bool:
        if not self.config.runtime.control_path.exists():
            return False
        try:
            payload = json.loads(self.config.runtime.control_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._report_invalid_stop_request("invalid control JSON")
            return False
        if not isinstance(payload, dict):
            self._report_invalid_stop_request("control payload is not an object")
            return False
        if _int_or_none(payload.get("pid")) != os.getpid():
            self._report_invalid_stop_request("control pid mismatch")
            return False
        try:
            token = self.config.runtime.control_token_path.read_bytes().strip()
        except OSError:
            self._report_invalid_stop_request("control token missing")
            return False
        message = f"{payload.get('requested_at')}|{payload.get('pid')}"
        expected = hmac_sha256(token, message)
        supplied = str(payload.get("token_hmac") or "")
        if not supplied or not secrets.compare_digest(supplied, expected):
            self._report_invalid_stop_request("control token mismatch")
            return False
        return True

    def _report_invalid_stop_request(self, reason: str) -> None:
        if self._invalid_stop_reported:
            return
        self._invalid_stop_reported = True
        self.audit.status({"status": "invalid_stop_request_ignored", "reason": reason})

    def _write_heartbeat(self, status: str) -> None:
        payload = {
            "status": status,
            "protection_state": "protected" if status == "running" else status,
            "pid": os.getpid(),
            "updated_at": time.time(),
            "sensors": [sensor.name for sensor in self.sensors],
            "sensor_count": len(self.sensors),
            "no_llm": self.no_llm,
            "profile": self.profile.to_dict(),
            "model_policy": self.model_policy.to_dict(),
            "incidents": self.incident_store.summary(),
            "network_history": self.network_history.summary() if self.network_history else None,
            "emergency": self.emergency.summary(),
        }
        heartbeat_path = self.config.runtime.heartbeat_path
        temporary = heartbeat_path.with_name(
            f"{heartbeat_path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
        )
        self.config.runtime.heartbeat_path.parent.mkdir(parents=True, exist_ok=True)
        serialized = json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n"
        try:
            temporary.write_text(serialized, encoding="utf-8")
            for attempt in range(20):
                try:
                    os.replace(temporary, heartbeat_path)
                    self._heartbeat_write_error_reported = False
                    return
                except PermissionError:
                    if attempt == 19:
                        raise
                    time.sleep(0.05)
        except OSError as exc:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            if not self._heartbeat_write_error_reported:
                self._heartbeat_write_error_reported = True
                self.audit.status({
                    "status": "heartbeat_write_failed",
                    "error": f"{type(exc).__name__}: {exc}",
                })

    def _write_heartbeat_if_due(self, now: float | None = None) -> bool:
        current = time.monotonic() if now is None else now
        if current - self._last_heartbeat_at < HEARTBEAT_INTERVAL_SECONDS:
            return False
        self._write_heartbeat("running")
        self._last_heartbeat_at = current
        return True


def _int_or_none(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _with_device_trust(event: SecurityEvent, trusted_ids: set[str]) -> SecurityEvent:
    if event.kind != "device.connected":
        return event
    facts = dict(event.facts)
    instance_id = str(facts.get("instance_id") or "")
    trusted = instance_id.casefold() in {item.casefold() for item in trusted_ids}
    facts["trusted_device"] = trusted
    facts["device_trust_state"] = "trusted" if trusted else "untrusted"
    return SecurityEvent(
        kind=event.kind,
        source=event.source,
        subject=event.subject,
        facts=facts,
        event_id=event.event_id,
        timestamp=event.timestamp,
    )


def _should_deep_inspect_file_event(event: SecurityEvent, score: int) -> bool:
    if score >= 35:
        return True
    extension = str(event.facts.get("extension") or Path(event.subject).suffix).lower()
    return extension in WATCH_DEEP_EXTENSIONS


def _with_authenticode_facts_if_needed(event: SecurityEvent) -> SecurityEvent:
    path = Path(str(event.facts.get("path") or event.subject))
    extension = path.suffix.lower()
    magic_type = str(event.facts.get("magic_type") or "")
    if extension not in AUTHENTICODE_EXTENSIONS and magic_type != "pe":
        return event
    facts = dict(event.facts)
    facts.update(authenticode_facts(path))
    return SecurityEvent(
        kind=event.kind,
        source="deep_file_scanner",
        subject=event.subject,
        facts=facts,
    )


def self_protection_paths(config: AppConfig) -> tuple[Path, ...]:
    package_root = Path(__file__).resolve().parent
    return (
        config.root / "config" / "monarch_security.toml",
        package_root / "audit.py",
        package_root / "actions.py",
        package_root / "emergency.py",
        package_root / "incidents.py",
        package_root / "integrity.py",
        package_root / "pin.py",
        package_root / "quarantine.py",
        package_root / "responses.py",
        package_root / "state.py",
        package_root / "supervisor.py",
        package_root / "analysis" / "rules.py",
    )
