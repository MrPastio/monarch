from __future__ import annotations

from dataclasses import dataclass
from concurrent.futures import Future
from pathlib import Path
import json
import os
import secrets
import time

from .analysis import RuleEngine
from .actions import read_service_heartbeat, request_emergency_containment, request_emergency_resolution
from .adversary import emergency_test_events
from .audit import AuditLog
from .behavior import FileBurstDetector
from .config import AppConfig
from .signature_metadata import SIGNATURE_EXTENSIONS as AUTHENTICODE_EXTENSIONS
from .events import RuleAssessment, SecurityEvent, utc_now
from .emergency import EmergencyError, EmergencyManager, EmergencyStore
from .integrity import hmac_sha256, get_or_create_key
from .runtime_health import POLL_GRACE_SECONDS, protection_state
from .telemetry import RUNTIME_PURPOSE, signed_telemetry
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
    InstallSensor,
    NetworkSensor,
    PersistenceSensor,
    PostureSensor,
    ProcessSensor,
    TamperSensor,
)
from .state import StateStore
from .runtime_lock import RuntimeLock, RuntimeBusyError
from .worker_transport import ProcessWorkerPool, WorkerError
from .sensor_worker import request_for, snapshot, restore, validate_result, worker_launch
from .observation import ObservationUnavailable
from .inspection_queue import FileInspectionQueue
from . import inspection_recovery as recovery
from .process_identity import probe_process


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
        progress=None,
    ) -> None:
        self.config = config
        self.resources = resources
        self.rules = rules
        self.router = router
        self.policy = policy
        self.audit = audit
        self.state = state
        from .background import _require_valid_state
        _require_valid_state(state)
        self.no_llm = no_llm
        self._progress = progress
        self._process_started = probe_process(os.getpid()).started
        guardian = probe_process(os.getppid()) if progress is not None else None
        if progress is not None and (guardian.state != 'alive' or not guardian.started):
            raise WorkerError('guardian-owner-identity-unavailable')
        self._guardian_identity = ({'pid': os.getppid(), 'process_started': guardian.started,
                                   'lease_seconds': 45, 'mechanism': 'owned-job' if os.name == 'nt' else 'owned-process-group'}
                                  if guardian and guardian.state == 'alive' else None)
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
        self._polls: dict[str, tuple[_ScheduledSensor, Future, dict, float]] = {}
        self._sensor_health: dict[str, dict] = {}
        self._stopping = False
        self._workers: ProcessWorkerPool | None = None
        self._inspections = FileInspectionQueue(state, config.files, PENDING_SENSOR_BATCHES_KEY)
        self._last_settings_check = 0.0
        self._started_at = time.monotonic()
        self._telemetry_key = get_or_create_key(config.runtime.integrity_key_path)
        self._launch_id = os.environ.get("MONARCH_SECURITY_LAUNCH_ID")
        if self._launch_id is not None and (len(self._launch_id) != 32 or any(char not in "0123456789abcdef" for char in self._launch_id)):
            raise ValueError("security-launch-identity-invalid")

    def run(self, duration: float) -> int:
        try:
            with RuntimeLock(self.config.runtime.pid_path.with_suffix(".owner")):
                return self._run_owned(duration)
        except RuntimeBusyError:
            return 0

    def _run_owned(self, duration: float) -> int:
        start = time.monotonic()
        self._workers = self._new_workers()
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
            while True:
                self._stopping = self._stopping or self._should_stop() or (
                    duration > 0 and time.monotonic() - start >= duration
                )
                if not self._stopping and time.monotonic() - self._last_settings_check >= 1.0:
                    self._stopping = not self._refresh_runtime_settings()
                    self._last_settings_check = time.monotonic()
                now = time.monotonic()
                if self._stopping:
                    self._cancel_polls()
                self._collect_polls()
                if self._stopping and not self._polls:
                    break
                if not self._stopping:
                    self._check_emergency_test_request()
                    self._apply_inspection_recovery()
                    self._dispatch_polls(now)
                    self._drain_sensor_backlog(max(1, self.config.runtime.max_events_per_tick))
                    self.router.maintenance()
                    self.state.save_if_dirty()
                self._write_heartbeat_if_due(now)
                if self._progress is not None:
                    self._progress.emit('tick')
                time.sleep(0.25)
        except KeyboardInterrupt:
            return 130
        except Exception as exc:
            self.audit.status({"status": "supervisor_failed", "error": type(exc).__name__})
            raise
        finally:
            self._stopping = True
            self._write_heartbeat("stopping")
            self._cancel_polls()
            self._cleanup_runtime_markers()
        self.audit.status({"status": "supervisor_finished"})
        return 0

    @staticmethod
    def _new_workers() -> ProcessWorkerPool:
        command, environment, cwd = worker_launch()
        return ProcessWorkerPool(command, environment=environment, cwd=cwd)

    def _cancel_polls(self) -> None:
        try:
            self._inspections.close()
        finally:
            if self._workers is not None:
                self._workers.close()
            self._polls.clear()

    def _dispatch_polls(self, now: float) -> None:
        assert self._workers is not None
        # Oldest due first; no executor queue where frequent sensors can starve others.
        for scheduled in sorted(self.sensors, key=lambda item: item.next_run):
            if not self._workers.available:
                break
            if scheduled.name in self._polls or now < scheduled.next_run or self._has_pending_sensor_batch(scheduled.name):
                continue
            checkpoint = snapshot(scheduled.sensor)
            self._sensor_health.setdefault(scheduled.name, {})["poll_started_at"] = time.time()
            try:
                future = self._workers.submit(request_for(scheduled.name, scheduled.sensor))
            except (WorkerError, OSError) as exc:
                self._record_sensor_failure(scheduled, type(exc).__name__)
                continue
            self._polls[scheduled.name] = (
                scheduled, future, checkpoint, now,
            )

    def _collect_polls(self) -> None:
        if self._workers is not None and not self._stopping:
            self._workers.tick()
        for name, (scheduled, future, checkpoint, started) in list(self._polls.items()):
            if not future.done():
                continue
            del self._polls[name]
            live = next((item for item in self.sensors if item.name == name and item.sensor is scheduled.sensor), None)
            if self._stopping or live is None:
                continue
            scheduled = live
            observation = None
            try:
                reply = future.result()
                events = validate_result(name, scheduled.sensor, reply)
                observation = reply['observation']
                if observation['status'] == 'unavailable':
                    raise WorkerError('sensor-observation-unavailable')
            except Exception as exc:
                self._record_sensor_failure(scheduled, str(exc) if isinstance(exc, WorkerError) else type(exc).__name__, observation=observation)
                continue
            # Only the controller touches signed state, correlation, and checkpoints.
            restore(scheduled.sensor, reply["state"])
            self._stage_sensor_events(scheduled, events, observation=observation)
            completed_at = getattr(future, 'completed_at', started)
            now = time.monotonic()
            # A delayed controller still stages historical evidence, but cannot
            # stamp an old observation as freshly verified coverage.
            self._sensor_health[name] = {"last_success_at": time.time() - max(0.0, now - completed_at),
                                         "duration_ms": round(max(0.0, completed_at - started) * 1000), "failures": 0}
            self._sensor_health[name]['observation'] = observation
            if reply["backend"]:
                self._sensor_health[name]["backend"] = reply["backend"]
            scheduled.next_run = completed_at + self._interval(scheduled)

    def _record_sensor_failure(self, scheduled: _ScheduledSensor, error: str, *, observation: dict | None = None) -> None:
        health = self._sensor_health.setdefault(scheduled.name, {})
        failures = int(health.get("failures", 0)) + 1
        health.update(error=error, failures=failures, failed_at=time.time())
        from .observation import valid_observation
        if observation is None or not valid_observation(observation) or observation['status'] != 'unavailable':
            observation = {'status': 'unavailable', 'reasons': ['sensor-poll-failed']}
        health['observation'] = observation
        scheduled.next_run = time.monotonic() + min(300.0, max(3.0, self._interval(scheduled)) * min(8, 2 ** min(failures - 1, 3)))
        if failures == 1:
            self.audit.status({"status": "sensor_poll_failed", "sensor": scheduled.name, "error": error})
        if scheduled.name == 'file_watch_sensor':
            with self.state.lock():
                if recovery.fail_inventory_locked(self.state, self._inspections):
                    scheduled.sensor._verify_inventory = False
                    self._write_sensor_checkpoint_locked(scheduled.name,
                        self._capture_sensor_checkpoint(scheduled.name, scheduled.sensor))

    def sensor_health(self) -> dict[str, dict]:
        result = {}
        now, wall_now = time.monotonic(), time.time()
        for scheduled in self.sensors:
            health = dict(self._sensor_health.get(scheduled.name, {}))
            poll = self._polls.get(scheduled.name)
            elapsed = now - poll[3] if poll else 0
            due = max(self._started_at, scheduled.next_run)
            overdue = now - due > POLL_GRACE_SECONDS
            last_success = health.get("last_success_at")
            expired = last_success is not None and wall_now - last_success > self._interval(scheduled) + POLL_GRACE_SECONDS
            backend = health.get("backend", getattr(scheduled.sensor, "backend_name", None))
            limited = (scheduled.name == "process_sensor" and backend == "tasklist") or health.get('observation', {}).get('status') == 'partial'
            health["state"] = ("stalled" if elapsed > POLL_GRACE_SECONDS else "failed" if health.get("failures")
                               else "overdue" if overdue or expired else "limited" if last_success and limited
                               else "healthy" if last_success else "starting")
            if backend:
                health["backend"] = backend
            if scheduled.name == "process_sensor" and backend == "tasklist":
                health["limitation"] = "process-command-line-and-lineage-unavailable"
            elif limited:
                health['limitation'] = 'observation-incomplete'
            health["polling"] = poll is not None
            health["interval_seconds"] = self._interval(scheduled)
            health["next_check_at"] = wall_now + max(0, scheduled.next_run - now)
            result[scheduled.name] = health
        return result

    def _refresh_runtime_settings(self) -> bool:
        """Apply user profile/policy changes without restarting the protector."""
        from .background import _require_valid_state
        fresh_state = StateStore(self.config.runtime.state_path, self.config.runtime.integrity_key_path)
        _require_valid_state(fresh_state)
        from .background import PREFERENCE_KEY
        preference = fresh_state.get_json(PREFERENCE_KEY, {})
        if type(preference) is dict and preference.get('requested') is False:
            return False
        profile = read_security_profile(self.config)
        model_policy = read_model_command_policy(self.config)
        if profile.level != self.profile.level:
            # Results from the old profile are never accepted by the next generation.
            self._cancel_polls()
            self._workers = self._new_workers()
            previous_level = self.profile.level
            self.profile = profile
            previous = {item.name: item for item in self.sensors}
            next_sensors = self._build_sensors()
            for item in next_sensors:
                if item.name in previous:
                    item.sensor = previous[item.name].sensor
            self.sensors = next_sensors
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
                    next_run=now + min(4.0, self.config.runtime.device_poll_seconds),
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
                    next_run=now + min(6.0, self.config.runtime.install_poll_seconds),
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
                    next_run=now + min(8.0, self.config.persistence.poll_seconds),
                )
            )
        if self.config.posture.enabled:
            sensors.append(
                _ScheduledSensor(
                    name="posture_sensor",
                    sensor=PostureSensor(
                        self.config.posture,
                        include_existing=True,
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
            if scheduled.name == 'file_watch_sensor' and not recovery.active_id(self.state):
                scheduled.sensor._verify_inventory = False
        return sensors

    def _stage_sensor_poll(self, scheduled: _ScheduledSensor) -> int:
        if self._has_pending_sensor_batch(scheduled.name):
            return 0
        poll = getattr(scheduled.sensor, "poll")
        before = self._capture_sensor_checkpoint(scheduled.name, scheduled.sensor)
        try:
            events = list(poll())
        except ObservationUnavailable:
            self._restore_sensor_checkpoint(scheduled.sensor, before)
            self._record_sensor_failure(scheduled, 'sensor-observation-unavailable')
            return 0
        if getattr(scheduled.sensor, "last_error", None):
            self._restore_sensor_checkpoint(scheduled.sensor, before)
            self._record_sensor_failure(scheduled, "sensor-query-failed")
            return 0
        return self._stage_sensor_events(scheduled, events)

    def _apply_inspection_recovery(self) -> bool:
        # Read fresh signed request state. A queue request never starts protection.
        scope_changed = False
        with self.state.lock():
            value = recovery.read(self.state)
            if not value or value['status'] not in recovery.ACTIVE:
                return False
            if value['scope'] != recovery.scope_for(self.config) or not self.config.file_watch.enabled:
                value.update(status='incomplete', reason='inspection-watch-scope-changed', finished_at=utc_now())
                self.state.set_json(recovery.KEY, value)
                scheduled = next((item for item in self.sensors if item.name == 'file_watch_sensor'), None)
                if scheduled is not None:
                    scheduled.sensor._verify_inventory = False
                    self._write_sensor_checkpoint_locked(scheduled.name,
                        self._capture_sensor_checkpoint(scheduled.name, scheduled.sensor))
                scope_changed = True
            elif value['status'] != 'queued' or str(self.state.data.get('security_level', '')).strip().lower() == 'off':
                return False
            elif self._has_pending_sensor_batch('file_watch_sensor'):
                return False
            request_id = value['id']
        if scope_changed:
            self._cancel_polls()
            self._workers = self._new_workers()
            return False
        scheduled = next((item for item in self.sensors if item.name == 'file_watch_sensor'), None)
        if scheduled is None:
            return False
        # No stale poll may restore the old signature baseline after reset.
        self._cancel_polls()
        self._workers = self._new_workers()
        sensor = FileChangeSensor(self.config.file_watch.paths, self.config.file_watch.recursive,
                                  self.config.file_watch.max_entries_per_tick, include_existing=True)
        sensor._first_poll = False
        checkpoint = self._capture_sensor_checkpoint('file_watch_sensor', sensor)
        with self.state.lock():
            value = recovery.read(self.state)
            if (not value or value['id'] != request_id or value['status'] != 'queued'
                    or str(self.state.data.get('security_level', '')).strip().lower() == 'off'
                    or self._has_pending_sensor_batch('file_watch_sensor')):
                return False
            self._write_sensor_checkpoint_locked('file_watch_sensor', checkpoint)
            value['status'] = 'running'
            self.state.set_json(recovery.KEY, value)
        scheduled.sensor, scheduled.next_run = sensor, 0.0
        self.audit.status({'status': 'file_inspection_recovery_started', 'request_id': request_id})
        return True

    def _stage_sensor_events(self, scheduled: _ScheduledSensor, events: list[SecurityEvent],
                             *, observation: dict | None = None) -> int:
        checkpoint = self._capture_sensor_checkpoint(scheduled.name, scheduled.sensor)
        # Refresh trust/profile state after a potentially slow sensor poll. This
        # preserves cross-process CLI changes without holding the state lock
        # while the sensor performs operating-system queries.
        with self.state.lock():
            if self._has_pending_sensor_batch(scheduled.name):
                raise RuntimeError(
                    f"sensor backlog appeared during poll for {scheduled.name}"
                )
            recovery_id = recovery.active_id(self.state) if scheduled.name == 'file_watch_sensor' else None
            if recovery_id:
                recovery.reset_inventory_failures_locked(self.state)
        observation = observation or getattr(scheduled.sensor, 'observation', None)
        assessments: list[RuleAssessment] = []
        for event in events:
            # This marker belongs to the controller, never a sensor reply.
            if 'inspection_recovery_id' in event.facts or (recovery_id and event.kind == 'file.observed'):
                facts = {key: value for key, value in event.facts.items() if key != 'inspection_recovery_id'}
                if recovery_id and event.kind == 'file.observed':
                    facts['inspection_recovery_id'] = recovery_id
                event = SecurityEvent(kind=event.kind, source=event.source, subject=event.subject,
                                      event_id=event.event_id, timestamp=event.timestamp,
                                      facts=facts)
            assessments.extend(self._prepare_assessments(event))
        paged = bool(getattr(scheduled.sensor, "overflow", False))

        if not assessments:
            if paged:
                self._audit_sensor_overflow(scheduled.name, scheduled.sensor)
            with self.state.lock():
                if recovery_id:
                    recovery.finish_inventory_locked(self.state, self._inspections, self.config,
                                                     checkpoint, recovery_id, observation)
                self._write_sensor_checkpoint_locked(scheduled.name, checkpoint)
            self._restore_sensor_checkpoint(scheduled.sensor, checkpoint)
            if recovery_id:
                scheduled.next_run = 0.0
            return 0

        batch = {
            "schema": 1,
            "sensor": scheduled.name,
            "queued_at": utc_now(),
            "next_index": 0,
            "assessments": [assessment.to_dict() for assessment in assessments],
            "checkpoint": checkpoint,
            "inspection_recovery_id": recovery_id,
            "observation": observation,
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
        # Look ahead only two items per batch; the owned pool has no hidden queue.
        # Results are durably materialized before handler/audit acknowledgement.
        for name, batch in batches.items():
            index = int(batch.get('next_index', 0))
            items = batch.get('assessments', [])
            for position in range(index, min(index + 2, len(items))):
                self._materialize_pending_assessment(
                    name, batch, position, RuleAssessment.from_dict(items[position]),
                    accept_result=position == index)
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
                if assessment is None:
                    continue
                self._handle_assessment(assessment)
                if self._workers is not None:
                    self._write_heartbeat_if_due()
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
                    if batch.get('inspection_recovery_id'):
                        recovery.finish_inventory_locked(
                            self.state, self._inspections, self.config, checkpoint,
                            batch['inspection_recovery_id'], batch.get('observation'))
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
                if recovery.active_id(self.state) and sensor_name == 'file_watch_sensor':
                    scheduled.next_run = 0.0

    def _prepare_assessments(self, event: SecurityEvent) -> list[RuleAssessment]:
        event = _with_device_trust(event, set(self.state.get_list("trusted_device_ids")))
        event = with_network_profile_trust(
            event,
            set(self.state.get_list("trusted_network_profiles")),
        )
        # A requested inventory of unchanged files is not a burst of mutations.
        recovery_id = recovery.active_id(self.state)
        recovering = recovery_id is not None and event.facts.get('inspection_recovery_id') == recovery_id
        burst_event = None if recovering else self.file_burst_detector.observe(event)
        assessment = self.rules.assess(event)
        assessments = [assessment]
        if burst_event is not None:
            assessments.extend(self._prepare_assessments(burst_event))
        return assessments

    def _handle_event(self, event: SecurityEvent) -> None:
        for assessment in self._prepare_assessments(event):
            if event.kind == 'file.observed' and _should_deep_inspect_file_event(event, assessment.score):
                raise RuntimeError('file observations require the durable inspection queue')
            self._handle_assessment(assessment)

    def _materialize_pending_assessment(
        self,
        sensor_name: str,
        batch: dict[str, object],
        index: int,
        assessment: RuleAssessment,
        *,
        accept_result: bool = True,
    ) -> RuleAssessment | None:
        event = assessment.event
        if event.kind != 'file.observed' or not (event.facts.get('inspection_recovery_id')
                or _should_deep_inspect_file_event(event, assessment.score)):
            return assessment
        recovery_id = event.facts.get('inspection_recovery_id')
        force_code = None
        if recovery_id:
            value = recovery.read(self.state)
            if (not value or value['id'] != recovery_id or value['status'] != 'running'
                    or value['scope'] != recovery.scope_for(self.config)):
                force_code = 'inspection-watch-scope-changed'
        return self._inspections.materialize(sensor_name, batch, index, assessment, self.rules.assess,
                                            accept_result=accept_result, force_code=force_code)

    def _handle_assessment(self, assessment: RuleAssessment) -> None:
        event = assessment.event
        # Durable controller-tagged recovery remains diagnostic even if its
        # request ended or changed before this queued result was handled.
        recovering = bool(event.facts.get('inspection_recovery_id'))
        if self.network_history is not None and event.kind.startswith("network."):
            self.network_history.append(NetworkObservation.from_assessment(assessment))
        decision = (
            self.policy.local_decision(assessment) if self.no_llm or recovering else self.router.decide(assessment)
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
                and not recovering
                and incident.risk_score >= 700
                and incident.emergency_eligible
            ):
                before = self.emergency.store.latest_active()
                try:
                    emergency = self.emergency.activate(
                        incident.incident_id,
                        test_mode=bool(incident.evidence) and all(item.source == "emergency_test" for item in incident.evidence),
                    )
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
        incomplete_files = self._inspections.gap_count()
        recovery_pending = recovery.projection(self.state)['status'] in recovery.ACTIVE
        oldest = min(
            (str(batch.get("queued_at") or "") for batch in batches.values()),
            default=None,
        )
        return {
            "queued": queued + incomplete_files + int(recovery_pending),
            "queued_events": queued,
            "incomplete_files": incomplete_files,
            "recovery_pending": recovery_pending,
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
        if self._progress is not None:
            self._progress.emit('started')

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

    def _check_emergency_test_request(self) -> None:
        request_path = self.config.runtime.control_path.with_name("emergency-test.request.json")
        if not request_path.exists():
            return
        result_path = self.config.runtime.control_path.with_name("emergency-test.result.json")
        nonce = ""
        try:
            payload = json.loads(request_path.read_text(encoding="utf-8"))
            request_path.unlink(missing_ok=True)
            if not isinstance(payload, dict):
                raise EmergencyError("Emergency test request is invalid")
            nonce = str(payload.get("nonce") or "")
            requested_at = float(payload.get("requested_at") or 0)
            if not nonce or len(nonce) != 32 or payload.get("pid") != os.getpid() or not 0 <= time.time() - requested_at <= 30:
                raise EmergencyError("Emergency test request is stale or targets another protector")
            token = self.config.runtime.control_token_path.read_bytes().strip()
            message = f"emergency-test|{requested_at}|{os.getpid()}|{nonce}"
            expected = hmac_sha256(token, message)
            if not secrets.compare_digest(str(payload.get("token_hmac") or ""), expected):
                raise EmergencyError("Emergency test request authentication failed")
            if not self.config.runtime.emergency_auto_lock_enabled:
                raise EmergencyError("Emergency auto lock is disabled")
            if not self.emergency.pin.status().get("configured"):
                raise EmergencyError("Configure Security PIN before the emergency test")
            active = self.emergency.status()
            if active is not None and active.state in {"activating", "awaiting_user", "contained"}:
                raise EmergencyError("An emergency response is already active")
            service = read_service_heartbeat(
                self.config.runtime.response_service_heartbeat_path,
                self.config.runtime.integrity_key_path,
            )
            if service.get("running") is not True or service.get("integrity_ok") is not True:
                raise EmergencyError("Elevated response executor is unavailable; network isolation cannot be tested")
            for event in emergency_test_events():
                self._handle_event(event)
            record = self.emergency.store.latest_active()
            if record is None or not record.test_mode:
                last = self.emergency.store.list_latest(1)
                reason = last[0].reason if last and last[0].test_mode else "Security did not activate the test response"
                raise EmergencyError(reason)
            if not record.native_lock_succeeded:
                raise EmergencyError("Network isolation was applied, but Windows did not lock; enter Security PIN to release isolation")
            result = {"ok": True, "emergency": record.to_dict()}
        except Exception as exc:
            result = {"ok": False, "error": str(exc)[:500]}
            self.audit.status({"status": "emergency_test_failed", "reason": type(exc).__name__})
        result["nonce"] = nonce
        temporary = result_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=True, sort_keys=True), encoding="utf-8")
        temporary.replace(result_path)

    def _report_invalid_stop_request(self, reason: str) -> None:
        if self._invalid_stop_reported:
            return
        self._invalid_stop_reported = True
        self.audit.status({"status": "invalid_stop_request_ignored", "reason": reason})

    def _write_heartbeat(self, status: str) -> None:
        health = self.sensor_health()
        backlog = self._sensor_backlog_health()
        payload = {
            "status": status,
            "protection_state": protection_state(status, health, backlog),
            "pid": os.getpid(),
            "launch_id": self._launch_id,
            "process_started": self._process_started,
            "guardian": self._guardian_identity,
            "updated_at": time.time(),
            "sensors": [sensor.name for sensor in self.sensors],
            "sensor_count": len(self.sensors),
            "sensor_health": health,
            "no_llm": self.no_llm,
            "profile": self.profile.to_dict(),
            "model_policy": self.model_policy.to_dict(),
            "incidents": self.incident_store.summary(),
            "network_history": self.network_history.summary() if self.network_history else None,
            "emergency": self.emergency.summary(),
            "sensor_backlog": backlog,
            "inspection_recovery": recovery.projection(self.state),
        }
        payload = signed_telemetry(payload, self._telemetry_key, RUNTIME_PURPOSE)
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
        self._write_heartbeat("stopping" if self._stopping else "running")
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


def self_protection_paths(config: AppConfig) -> tuple[Path, ...]:
    package_root = Path(__file__).resolve().parent
    return (
        config.root / "config" / "monarch_security.toml",
        package_root / "audit.py",
        package_root / "actions.py",
        package_root / "background.py",
        package_root / "control.py",
        package_root / "cli.py",
        package_root / "emergency.py",
        package_root / "incidents.py",
        package_root / "integrity.py",
        package_root / "pin.py",
        package_root / "quarantine.py",
        package_root / "responses.py",
        package_root / "runtime_lock.py",
        package_root / "state.py",
        package_root / "supervisor.py",
        package_root / "analysis" / "rules.py",
    )
