from __future__ import annotations

from concurrent.futures import Future
from pathlib import Path
import json
import time

import pytest

from monarch_security import background, control
from monarch_security.runtime_lock import RuntimeLock, RuntimeBusyError
from monarch_security.sensors.posture import PostureSensor
from monarch_security.supervisor import _ScheduledSensor
from test_supervisor_backlog import _config, _supervisor


def test_runtime_ownership_is_exclusive_and_released(tmp_path):
    marker = tmp_path / "owner"
    with RuntimeLock(marker):
        with pytest.raises(RuntimeBusyError):
            with RuntimeLock(marker):
                pass
    with RuntimeLock(marker):
        pass


def test_missing_mismatched_and_old_heartbeat_never_report_protected(tmp_path, monkeypatch):
    config = _config(tmp_path, max_events_per_tick=2)
    config.runtime.pid_path.parent.mkdir(parents=True, exist_ok=True)
    config.runtime.pid_path.write_text("321")
    monkeypatch.setattr(control, "_pid_running", lambda _: True)
    with RuntimeLock(config.runtime.pid_path.with_suffix('.owner')):
        for heartbeat in (None, {"pid": 654, "updated_at": time.time()}, {"pid": 321, "updated_at": time.time() - 40}):
            if heartbeat is not None:
                config.runtime.heartbeat_path.write_text(json.dumps(heartbeat))
            status = control.protector_status(config, cleanup_stale=False)
            assert status["running"] is True
            assert status["protection_state"] == "degraded"


class _ControlledWorkers:
    def __init__(self, pending=None):
        self.pending = pending
        self.futures = []
        self.available = True

    def submit(self, request):
        future = Future()
        self.futures.append(future)
        if request['sensor'] != self.pending:
            future.set_result({'schema': 2, 'sensor': request['sensor'], 'state': request['state'], 'events': [], 'backend': None,
                               'observation': {'status': 'complete', 'reasons': []}})
        return future

    def tick(self):
        pass

    def close(self):
        self.available = False


def test_slow_sensor_does_not_block_other_sensor_or_heartbeat(tmp_path):
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    slow = PostureSensor(supervisor.config.posture)
    from monarch_security.sensors import NetworkSensor
    fast = NetworkSensor(supervisor.config.network)
    supervisor.sensors = [_ScheduledSensor("posture_sensor", slow, 3), _ScheduledSensor("network_sensor", fast, 3)]
    supervisor._workers = _ControlledWorkers(pending='posture_sensor')
    supervisor._dispatch_polls(time.monotonic())
    supervisor._collect_polls()
    assert supervisor.sensor_health()["network_sensor"]["state"] == "healthy"
    assert supervisor.sensor_health()["posture_sensor"]["state"] == "starting"
    supervisor._write_heartbeat("running")
    heartbeat = json.loads(supervisor.config.runtime.heartbeat_path.read_text())
    assert heartbeat["protection_state"] == "starting"
    assert heartbeat["sensor_health"]["network_sensor"]["state"] == "healthy"
    supervisor._dispatch_polls(time.monotonic())
    assert len(supervisor._polls) == 1


def test_sensor_failure_preserves_checkpoint_and_recovers(tmp_path, monkeypatch):
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    sensor = PostureSensor(supervisor.config.posture, initial_signatures={"firewall": "enabled"})
    scheduled = _ScheduledSensor("posture_sensor", sensor, 1)
    supervisor.sensors = [scheduled]
    monkeypatch.setattr("monarch_security.sensors.posture._run_powershell_json", lambda *_args, **_kw: (None, "timeout"))
    assert supervisor._stage_sensor_poll(scheduled) == 0
    assert sensor.signatures == {"firewall": "enabled"}
    assert supervisor.state.get_dict("known_posture_signatures") == {}
    assert supervisor.sensor_health()["posture_sensor"]["state"] == "failed"
    sensor.poll = lambda: []
    sensor.last_error = None
    scheduled.next_run = 0
    supervisor._workers = _ControlledWorkers()
    supervisor._dispatch_polls(time.monotonic())
    supervisor._collect_polls()
    assert supervisor.sensor_health()["posture_sensor"]["state"] == "healthy"


def test_no_sensors_cannot_report_protected(tmp_path):
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    supervisor.sensors = []
    supervisor._write_heartbeat("running")
    assert json.loads(supervisor.config.runtime.heartbeat_path.read_text())["protection_state"] == "degraded"


def test_delayed_collection_cannot_retimestamp_old_observation_as_protected(tmp_path):
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    sensor = PostureSensor(supervisor.config.posture)
    scheduled = _ScheduledSensor('posture_sensor', sensor, 1)
    supervisor.sensors = [scheduled]
    supervisor._workers = _ControlledWorkers()
    supervisor._dispatch_polls(time.monotonic())
    item, future, checkpoint, started = supervisor._polls['posture_sensor']
    observed = time.monotonic() - 120
    future.completed_at = observed
    supervisor._polls['posture_sensor'] = item, future, checkpoint, observed - 0.25
    supervisor._collect_polls()
    health = supervisor.sensor_health()['posture_sensor']
    assert health['state'] == 'overdue'
    assert health['last_success_at'] < time.time() - 110
    assert health['duration_ms'] == 250
    assert scheduled.next_run < time.monotonic()
    supervisor._write_heartbeat('running')
    assert json.loads(supervisor.config.runtime.heartbeat_path.read_text())['protection_state'] == 'degraded'


def test_delayed_collection_retains_historical_events_in_signed_backlog(tmp_path):
    from monarch_security.events import SecurityEvent
    from monarch_security.supervisor import PENDING_SENSOR_BATCHES_KEY
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    sensor = PostureSensor(supervisor.config.posture)
    scheduled = _ScheduledSensor('posture_sensor', sensor, 1)
    supervisor.sensors = [scheduled]
    supervisor._workers = _ControlledWorkers()
    supervisor._dispatch_polls(time.monotonic())
    item, future, checkpoint, started = supervisor._polls['posture_sensor']
    event = SecurityEvent(kind='security.posture_changed', source='posture_sensor', subject='Public',
                          facts={'kind': 'firewall_profile', 'enabled': False})
    future.result()['events'] = [event.to_dict()]
    observed = time.monotonic() - 120
    future.completed_at = observed
    supervisor._polls['posture_sensor'] = item, future, checkpoint, observed - 0.25
    supervisor._collect_polls()
    batches = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)
    assert batches['posture_sensor']['assessments'][0]['event']['event_id'] == event.event_id
    assert supervisor.sensor_health()['posture_sensor']['state'] == 'overdue'
    assert supervisor._sensor_backlog_health()['queued'] == 1


def test_background_registration_failure_does_not_enable_preference(tmp_path, monkeypatch):
    config = _config(tmp_path, max_events_per_tick=2)
    monkeypatch.setattr(background, "_task_command", lambda *_: {"registered": True, "exact": False})
    result = background.enable_background(config, tmp_path / "monarch_security.toml")
    assert result["ok"] is False
    assert background.read_background(config).get("enabled") is not True


def test_watchdog_respects_durable_user_pause_under_lifecycle_lock(tmp_path, monkeypatch):
    config = _config(tmp_path, max_events_per_tick=2)
    background.write_background(config, enabled=True, requested=False)
    monkeypatch.setattr(control, "_start_protector_owned", lambda *_: pytest.fail("paused protection must not launch"))
    result = control.start_protector(tmp_path / "monarch_security.toml", no_llm=True, background_recovery=True)
    assert result["reason"] == "background-paused"
    assert background.read_background(config)["requested"] is False


def test_task_preserves_exact_roots_without_unrelated_environment(tmp_path, monkeypatch):
    config = _config(tmp_path, max_events_per_tick=2)
    monkeypatch.setenv("MONARCH_SAFE_ROOT", "E:/synthetic-protected-root")
    monkeypatch.setenv("SYNTHETIC_SECRET", "do-not-copy")
    spec = background.task_spec(config, tmp_path / "monarch_security.toml")
    assert "--data-root" in spec["arguments"] and "--logs-root" in spec["arguments"]
    assert "background-host" in spec["arguments"]
    assert "do-not-copy" not in json.dumps(spec)
    assert spec["name"] == background._task_name(config)


def test_runtime_context_cannot_set_unlisted_environment(monkeypatch):
    import base64
    encoded = base64.b64encode(b'{"UNLISTED_SETTING":"value"}').decode()
    with pytest.raises(ValueError, match="context-invalid"):
        background.apply_runtime_context(encoded)


def test_status_explains_corrupted_state_without_enabling_or_rewriting_it(tmp_path):
    config = _config(tmp_path, max_events_per_tick=2)
    config.runtime.state_path.parent.mkdir(parents=True, exist_ok=True)
    damaged = bytes(153694)
    config.runtime.state_path.write_bytes(damaged)
    result = background.background_status(config)
    assert result["state"] == "recovery_required"
    assert result["recovery_required"] is True
    assert result["enabled"] is None
    assert result["startup_registered"] is None
    assert config.runtime.state_path.read_bytes() == damaged


@pytest.mark.parametrize("contents", ['{broken', '[]', '{"background_protection_v1":{"enabled":true}}'])
def test_invalid_persisted_state_is_preserved_and_never_authorizes_recovery(tmp_path, contents):
    config = _config(tmp_path, max_events_per_tick=2)
    config.runtime.state_path.parent.mkdir(parents=True, exist_ok=True)
    config.runtime.state_path.write_text(contents)
    with pytest.raises(RuntimeError, match="state-integrity"):
        background.read_background(config)
    with pytest.raises(RuntimeError, match="state-integrity"):
        background.write_background(config, enabled=True)
    assert config.runtime.state_path.read_text() == contents
