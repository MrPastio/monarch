from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
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
from .events import RuleAssessment, SecurityEvent, utc_now
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
PENDING_SENSOR_BATCHES_KEY = "pending_sensor_batches_v1"
SENSOR_CHECKPOINTS_KEY = "sensor_checkpoints_v1"

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
        backlog = self._sensor_backlog_health()
        if backlog["queued"]:
            self.audit.status({"status": "sensor_backlog_resumed", **backlog})

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

                now = time.monotonic()
                for scheduled in self.sensors:
                    if now < scheduled.next_run:
                        continue
                    if not self._has_pending_sensor_batch(scheduled.name):
                        self._stage_sensor_poll(scheduled)
                    scheduled.next_run = time.monotonic() + self._interval(scheduled)

                self._drain_sensor_backlog(
                    max(1, self.config.runtime.max_events_per_tick)
                )

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
        checkpoints = self._sensor_checkpoints()
        for scheduled in sensors:
            checkpoint = checkpoints.get(scheduled.name)
            if isinstance(checkpoint, dict):
                self._restore_sensor_checkpoint(scheduled.sensor, checkpoint)
        return sensors

    def _stage_sensor_poll(self, scheduled: _ScheduledSensor) -> int:
        if self._has_pending_sensor_batch(scheduled.name):
            return 0
        poll = getattr(scheduled.sensor, "poll")
        events = list(poll())
        checkpoint = self._capture_sensor_checkpoint(scheduled.name, scheduled.sensor)
        # Refresh trust/profile state after a potentially slow sensor poll. This
        # preserves cross-process CLI changes without holding the state lock
        # while the sensor performs operating-system queries.
        with self.state.lock():
            if self._has_pending_sensor_batch(scheduled.name):
                raise RuntimeError(
                    f"sensor backlog appeared during poll for {scheduled.name}"
                )
        assessments: list[RuleAssessment] = []
        for event in events:
            assessments.extend(self._prepare_assessments(event))
        paged = bool(getattr(scheduled.sensor, "overflow", False))

        if not assessments:
            if paged:
                self._audit_sensor_overflow(scheduled.name, scheduled.sensor)
            with self.state.lock():
                self._write_sensor_checkpoint_locked(scheduled.name, checkpoint)
            return 0

        batch = {
            "schema": 1,
            "sensor": scheduled.name,
            "queued_at": utc_now(),
            "next_index": 0,
            "assessments": [assessment.to_dict() for assessment in assessments],
            "checkpoint": checkpoint,
        }
        with self.state.lock():
            batches = self._pending_sensor_batches()
            if scheduled.name in batches:
                raise RuntimeError(
                    f"sensor backlog already exists for {scheduled.name}"
                )
            batches[scheduled.name] = batch
            self.state.set_json(PENDING_SENSOR_BATCHES_KEY, batches)

        if paged:
            self._audit_sensor_overflow(scheduled.name, scheduled.sensor)
        if len(assessments) > max(1, self.config.runtime.max_events_per_tick):
            self.audit.status(
                {
                    "status": "sensor_backlog_queued",
                    "sensor": scheduled.name,
                    "queued": len(assessments),
                    "per_tick_limit": max(1, self.config.runtime.max_events_per_tick),
                    "overflow": True,
                }
            )
        return len(assessments)

    def _audit_sensor_overflow(self, sensor_name: str, sensor: object) -> None:
        cursor = getattr(sensor, "checkpoint_cursor", None)
        self.audit.status(
            {
                "status": (
                    "sensor_snapshot_paged"
                    if cursor is not None
                    else "sensor_snapshot_overflow"
                ),
                "sensor": sensor_name,
                "cursor": cursor,
                "page_size": getattr(sensor, "max_entries_per_tick", None)
                or getattr(getattr(sensor, "config", None), "max_entries", None),
                "detail": getattr(sensor, "overflow_detail", None),
                "overflow": True,
            }
        )

    def _drain_sensor_backlog(self, limit: int) -> int:
        processed = 0
        batches = self._pending_sensor_batches()
        progress: dict[str, dict[str, object]] = {}
        processing_budget = max(
            1.0,
            float(self.config.runtime.max_sensor_processing_seconds_per_tick),
        )
        deadline = time.monotonic() + processing_budget
        budget_exhausted = False
        while processed < max(1, limit):
            if processed > 0 and time.monotonic() >= deadline:
                budget_exhausted = True
                break
            active = [
                (name, batch)
                for name, batch in batches.items()
                if self._remaining_batch_items(batch) > 0
            ]
            if not active:
                break
            active.sort(
                key=lambda item: (
                    int(item[1].get("next_index", 0)),
                    str(item[1].get("queued_at") or ""),
                    item[0],
                )
            )
            made_progress = False
            for name, batch in active:
                if processed >= max(1, limit):
                    break
                if processed > 0 and time.monotonic() >= deadline:
                    budget_exhausted = True
                    break
                assessment_payload, event_id = self._next_batch_assessment(name, batch)
                current_index = int(batch.get("next_index", 0))
                assessment = RuleAssessment.from_dict(assessment_payload)
                assessment = self._materialize_pending_assessment(
                    name,
                    batch,
                    current_index,
                    assessment,
                )
                self._handle_assessment(assessment)
                sensor_progress = progress.setdefault(
                    name,
                    {"start_index": current_index, "event_ids": []},
                )
                event_ids = sensor_progress["event_ids"]
                assert isinstance(event_ids, list)
                event_ids.append(event_id)
                batch["next_index"] = current_index + 1
                processed += 1
                made_progress = True
            if budget_exhausted:
                break
            if not made_progress:
                break
        if progress:
            self._acknowledge_sensor_progress(progress)
        if budget_exhausted:
            self.audit.status(
                {
                    "status": "sensor_processing_budget_exhausted",
                    "processed": processed,
                    "processing_budget_seconds": processing_budget,
                    **self._sensor_backlog_health(),
                }
            )
        return processed

    def _acknowledge_sensor_progress(
        self,
        progress: dict[str, dict[str, object]],
    ) -> None:
        completed_checkpoints: dict[str, dict[str, object]] = {}
        with self.state.lock():
            batches = self._pending_sensor_batches()
            for sensor_name, sensor_progress in progress.items():
                batch = batches.get(sensor_name)
                if not isinstance(batch, dict):
                    raise RuntimeError(f"sensor backlog disappeared for {sensor_name}")
                try:
                    start_index = int(sensor_progress.get("start_index"))
                except (TypeError, ValueError) as exc:
                    raise RuntimeError(
                        f"sensor backlog acknowledgement cursor is invalid for {sensor_name}"
                    ) from exc
                event_ids = sensor_progress.get("event_ids")
                if not isinstance(event_ids, list) or not event_ids:
                    raise RuntimeError(
                        f"sensor backlog acknowledgement is empty for {sensor_name}"
                    )
                if int(batch.get("next_index", 0)) != start_index:
                    raise RuntimeError(
                        f"sensor backlog acknowledgement moved for {sensor_name}"
                    )
                assessments = batch.get("assessments")
                if not isinstance(assessments, list):
                    raise RuntimeError(f"sensor backlog is malformed for {sensor_name}")
                if start_index + len(event_ids) > len(assessments):
                    raise RuntimeError(
                        f"sensor backlog acknowledgement is out of range for {sensor_name}"
                    )
                for offset, expected_event_id in enumerate(event_ids):
                    probe = dict(batch)
                    probe["next_index"] = start_index + offset
                    _, current_event_id = self._next_batch_assessment(sensor_name, probe)
                    if current_event_id != expected_event_id:
                        raise RuntimeError(
                            f"sensor backlog acknowledgement mismatch for {sensor_name}"
                        )
                next_index = start_index + len(event_ids)
                if next_index >= len(assessments):
                    checkpoint = batch.get("checkpoint")
                    if not isinstance(checkpoint, dict):
                        raise RuntimeError(f"sensor checkpoint is malformed for {sensor_name}")
                    completed_checkpoints[sensor_name] = checkpoint
                    self._write_sensor_checkpoint_locked(sensor_name, checkpoint)
                    del batches[sensor_name]
                else:
                    batch["next_index"] = next_index
                    batches[sensor_name] = batch
            if batches:
                self.state.set_json(PENDING_SENSOR_BATCHES_KEY, batches)
            else:
                self.state.delete(PENDING_SENSOR_BATCHES_KEY)

        for sensor_name, checkpoint in completed_checkpoints.items():
            scheduled = next(
                (item for item in self.sensors if item.name == sensor_name),
                None,
            )
            if scheduled is not None:
                self._restore_sensor_checkpoint(scheduled.sensor, checkpoint)

    def _prepare_assessments(self, event: SecurityEvent) -> list[RuleAssessment]:
        event = _with_device_trust(event, set(self.state.get_list("trusted_device_ids")))
        event = with_network_profile_trust(
            event,
            set(self.state.get_list("trusted_network_profiles")),
        )
        burst_event = self.file_burst_detector.observe(event)
        assessment = self.rules.assess(event)
        assessments = [assessment]
        if burst_event is not None:
            assessments.extend(self._prepare_assessments(burst_event))
        return assessments

    def _handle_event(self, event: SecurityEvent) -> None:
        for assessment in self._prepare_assessments(event):
            self._handle_assessment(self._materialize_file_assessment(assessment))

    def _materialize_pending_assessment(
        self,
        sensor_name: str,
        batch: dict[str, object],
        index: int,
        assessment: RuleAssessment,
    ) -> RuleAssessment:
        materialized = self._materialize_file_assessment(assessment)
        if materialized is assessment:
            return assessment
        replacement = materialized.to_dict()
        with self.state.lock():
            batches = self._pending_sensor_batches()
            persisted = batches.get(sensor_name)
            if not isinstance(persisted, dict):
                raise RuntimeError(
                    f"sensor backlog disappeared while materializing {sensor_name}"
                )
            persisted_index = int(persisted.get("next_index", 0))
            if persisted_index > index:
                raise RuntimeError(
                    f"sensor backlog moved while materializing {sensor_name}"
                )
            persisted_assessments = persisted.get("assessments")
            if not isinstance(persisted_assessments, list) or index >= len(persisted_assessments):
                raise RuntimeError(
                    f"sensor assessment disappeared while materializing {sensor_name}"
                )
            current = persisted_assessments[index]
            if not isinstance(current, dict):
                raise RuntimeError(
                    f"sensor assessment is malformed while materializing {sensor_name}"
                )
            current_event = current.get("event")
            if (
                not isinstance(current_event, dict)
                or str(current_event.get("event_id") or "")
                != assessment.event.event_id
            ):
                raise RuntimeError(
                    f"sensor assessment changed while materializing {sensor_name}"
                )
            persisted_assessments[index] = replacement
            persisted["assessments"] = persisted_assessments
            batches[sensor_name] = persisted
            self.state.set_json(PENDING_SENSOR_BATCHES_KEY, batches)

        assessments = batch.get("assessments")
        if not isinstance(assessments, list) or index >= len(assessments):
            raise RuntimeError(f"local sensor assessment is malformed for {sensor_name}")
        assessments[index] = replacement
        return materialized

    def _materialize_file_assessment(
        self,
        assessment: RuleAssessment,
    ) -> RuleAssessment:
        event = assessment.event
        if (
            event.kind != "file.observed"
            or not _should_deep_inspect_file_event(event, assessment.score)
        ):
            return assessment
        raw_path = event.facts.get("path")
        if not isinstance(raw_path, str) or not raw_path:
            return assessment
        try:
            scanned = FileScanner(self.config.files).inspect(Path(raw_path))
            facts = dict(scanned.facts)
            scanned = SecurityEvent(
                kind=scanned.kind,
                source=scanned.source,
                subject=scanned.subject,
                facts=facts,
                event_id=event.event_id,
                timestamp=event.timestamp,
            )
        except OSError as exc:
            facts = dict(event.facts)
            facts.update(
                {
                    "content_parser_isolated": True,
                    "content_parser_status": "io_error",
                    "content_error": f"{type(exc).__name__}: file unavailable during inspection",
                }
            )
            scanned = SecurityEvent(
                kind="file.scanned",
                source="file_scanner",
                subject=event.subject,
                facts=facts,
                event_id=event.event_id,
                timestamp=event.timestamp,
            )
        if scanned.facts.get("content_parser_status") in {None, "ok"}:
            scanned = _with_authenticode_facts_if_needed(scanned)
        return self.rules.assess(scanned)

    def _handle_assessment(self, assessment: RuleAssessment) -> None:
        event = assessment.event
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

    def _pending_sensor_batches(self) -> dict[str, dict[str, object]]:
        payload = self.state.get_json(PENDING_SENSOR_BATCHES_KEY, {})
        if not isinstance(payload, dict):
            raise RuntimeError("sensor backlog state is not an object")
        batches: dict[str, dict[str, object]] = {}
        for name, batch in payload.items():
            if not isinstance(name, str) or not isinstance(batch, dict):
                raise RuntimeError("sensor backlog entry is malformed")
            if batch.get("schema") != 1 or batch.get("sensor") != name:
                raise RuntimeError(f"sensor backlog identity is invalid for {name}")
            batches[name] = batch
        return batches

    def _sensor_checkpoints(self) -> dict[str, dict[str, object]]:
        payload = self.state.get_json(SENSOR_CHECKPOINTS_KEY, {})
        if not isinstance(payload, dict):
            raise RuntimeError("sensor checkpoint state is not an object")
        checkpoints: dict[str, dict[str, object]] = {}
        for name, checkpoint in payload.items():
            if not isinstance(name, str) or not isinstance(checkpoint, dict):
                raise RuntimeError("sensor checkpoint entry is malformed")
            if checkpoint.get("schema") != 1 or checkpoint.get("sensor") != name:
                raise RuntimeError(f"sensor checkpoint identity is invalid for {name}")
            checkpoints[name] = checkpoint
        return checkpoints

    def _has_pending_sensor_batch(self, sensor_name: str) -> bool:
        return sensor_name in self._pending_sensor_batches()

    @staticmethod
    def _remaining_batch_items(batch: dict[str, object]) -> int:
        assessments = batch.get("assessments")
        if not isinstance(assessments, list):
            raise RuntimeError("sensor backlog assessments are malformed")
        try:
            next_index = int(batch.get("next_index", 0))
        except (TypeError, ValueError) as exc:
            raise RuntimeError("sensor backlog cursor is malformed") from exc
        if not 0 <= next_index <= len(assessments):
            raise RuntimeError("sensor backlog cursor is out of range")
        return len(assessments) - next_index

    @classmethod
    def _next_batch_assessment(
        cls,
        sensor_name: str,
        batch: dict[str, object],
    ) -> tuple[dict[str, object], str]:
        if cls._remaining_batch_items(batch) <= 0:
            raise RuntimeError(f"sensor backlog is empty for {sensor_name}")
        assessments = batch["assessments"]
        assert isinstance(assessments, list)
        next_index = int(batch.get("next_index", 0))
        payload = assessments[next_index]
        if not isinstance(payload, dict):
            raise RuntimeError(f"sensor assessment is malformed for {sensor_name}")
        event = payload.get("event")
        if not isinstance(event, dict):
            raise RuntimeError(f"sensor assessment event is malformed for {sensor_name}")
        event_id = str(event.get("event_id") or "")
        if not event_id:
            raise RuntimeError(f"sensor assessment event id is missing for {sensor_name}")
        return payload, event_id

    def _sensor_backlog_health(self) -> dict[str, object]:
        batches = self._pending_sensor_batches()
        by_sensor = {
            name: self._remaining_batch_items(batch)
            for name, batch in sorted(batches.items())
        }
        queued = sum(by_sensor.values())
        oldest = min(
            (str(batch.get("queued_at") or "") for batch in batches.values()),
            default=None,
        )
        return {
            "queued": queued,
            "batches": len(batches),
            "by_sensor": by_sensor,
            "oldest_queued_at": oldest,
            "overflow": queued > max(1, self.config.runtime.max_events_per_tick),
        }

    def _capture_sensor_checkpoint(self, sensor_name: str, sensor: object) -> dict[str, object]:
        initialized = not bool(getattr(sensor, "_first_poll", False))
        checkpoint: dict[str, object] = {
            "schema": 1,
            "sensor": sensor_name,
            "initialized": initialized,
        }
        if sensor_name == "process_sensor":
            checkpoint.update({"kind": "ephemeral", "values": []})
        elif sensor_name in {"device_sensor", "install_sensor"}:
            checkpoint.update({"kind": "seen-str", "values": sorted(getattr(sensor, "_seen", set()))})
        else:
            signatures = getattr(sensor, "signatures", None)
            if not isinstance(signatures, dict):
                raise RuntimeError(f"sensor {sensor_name} has no checkpoint contract")
            checkpoint.update({"kind": "signatures", "values": signatures})
        cursor = getattr(sensor, "checkpoint_cursor", None)
        if cursor is not None:
            checkpoint["cursor"] = cursor
        metadata = getattr(sensor, "checkpoint_metadata", None)
        if metadata is not None:
            checkpoint["metadata"] = metadata
        return checkpoint

    @staticmethod
    def _restore_sensor_checkpoint(sensor: object, checkpoint: dict[str, object]) -> None:
        kind = checkpoint.get("kind")
        values = checkpoint.get("values")
        if kind == "ephemeral" and isinstance(values, list):
            return
        if kind == "seen-str" and isinstance(values, list):
            setattr(sensor, "_seen", {str(value) for value in values})
        elif kind == "signatures" and isinstance(values, dict):
            setattr(sensor, "_signatures", {str(key): str(value) for key, value in values.items()})
        else:
            raise RuntimeError("sensor checkpoint is malformed")
        if hasattr(sensor, "_first_poll"):
            setattr(sensor, "_first_poll", not bool(checkpoint.get("initialized", False)))
        if "cursor" in checkpoint and hasattr(sensor, "restore_checkpoint_cursor"):
            getattr(sensor, "restore_checkpoint_cursor")(checkpoint["cursor"])
        if "metadata" in checkpoint and hasattr(sensor, "restore_checkpoint_metadata"):
            getattr(sensor, "restore_checkpoint_metadata")(checkpoint["metadata"])

    def _write_sensor_checkpoint_locked(
        self,
        sensor_name: str,
        checkpoint: dict[str, object],
    ) -> None:
        if checkpoint.get("kind") == "ephemeral":
            return
        checkpoints = self._sensor_checkpoints()
        checkpoints[sensor_name] = checkpoint
        self.state.set_json(SENSOR_CHECKPOINTS_KEY, checkpoints)
        kind = checkpoint.get("kind")
        values = checkpoint.get("values")
        legacy_key = {
            "device_sensor": "known_devices",
            "install_sensor": "known_installs",
            "file_watch_sensor": "known_file_signatures",
            "network_sensor": "known_network_signatures",
            "persistence_sensor": "known_persistence_signatures",
            "posture_sensor": "known_posture_signatures",
            "tamper_sensor": "known_self_protection_signatures",
        }.get(sensor_name)
        if legacy_key is None:
            return
        if kind == "seen-str" and isinstance(values, list):
            self.state.set_list(legacy_key, {str(value) for value in values})
        elif kind == "signatures" and isinstance(values, dict):
            self.state.set_dict(
                legacy_key,
                {str(key): str(value) for key, value in values.items()},
            )
        else:
            raise RuntimeError(f"sensor checkpoint cannot update {legacy_key}")

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
            "sensor_backlog": self._sensor_backlog_health(),
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
