from __future__ import annotations

from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import json
import os
import time
import contextlib

import pytest

from monarch_security import background, control
from monarch_security.integrity import get_or_create_key, read_existing_key
from monarch_security.runtime_health import finite_number
from monarch_security.supervisor import _ScheduledSensor
from monarch_security.telemetry import BACKGROUND_PURPOSE, MAX_TELEMETRY_BYTES, RUNTIME_PURPOSE, read_telemetry, signed_telemetry
from monarch_security.runtime_lock import RuntimeLock
from monarch_security.process_identity import probe_process
from test_supervisor_backlog import _config, _supervisor, _signature_sensor


@pytest.fixture(autouse=True)
def runtime_owners(monkeypatch):
    original = _fixture
    with contextlib.ExitStack() as owners:
        def owned_fixture(tmp_path):
            config, supervisor = original(tmp_path)
            owners.enter_context(RuntimeLock(config.runtime.pid_path.with_suffix('.owner')))
            return config, supervisor
        monkeypatch.setattr(__import__(__name__, fromlist=['_fixture']), '_fixture', owned_fixture)
        yield


def _fixture(tmp_path: Path):
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    scheduled = _ScheduledSensor("process_sensor", SimpleNamespace(backend_name="psutil"), 3, time.monotonic() + 3)
    supervisor.sensors = [scheduled]
    supervisor._sensor_health[scheduled.name] = {"last_success_at": time.time(), "failures": 0,
                                               'observation': {'status': 'complete', 'reasons': []}}
    config.runtime.pid_path.write_text(str(os.getpid()), encoding="utf-8")
    supervisor._write_heartbeat("running")
    return config, supervisor


def _rewrite(config, change, *, purpose=RUNTIME_PURPOSE):
    payload = json.loads(config.runtime.heartbeat_path.read_text(encoding="utf-8"))
    change(payload)
    payload.pop("_integrity", None)
    signed = signed_telemetry(payload, read_existing_key(config.runtime.integrity_key_path), purpose)
    config.runtime.heartbeat_path.write_text(json.dumps(signed), encoding="utf-8")


def test_real_supervisor_publication_reaches_verified_protected_status(tmp_path):
    config, _ = _fixture(tmp_path)
    status = control.protector_status(config, cleanup_stale=False)
    assert status["running"] is True
    assert status["telemetry_verified"] is True
    assert status["telemetry_error"] is None
    assert status["protection_state"] == "protected"


def test_modified_unsigned_runtime_is_not_returned_as_trusted_health(tmp_path):
    config, _ = _fixture(tmp_path)
    payload = json.loads(config.runtime.heartbeat_path.read_text())
    payload["sensor_health"]["process_sensor"]["state"] = "failed"
    config.runtime.heartbeat_path.write_text(json.dumps(payload))
    status = control.protector_status(config, cleanup_stale=False)
    assert status["running"] is True
    assert status["protection_state"] == "degraded"
    assert status["heartbeat"] is None
    assert status["telemetry_error"] == "telemetry-integrity-failed"


@pytest.mark.parametrize("change,error", [
    (lambda p: p.update(pid=os.getpid() + 1), "telemetry-pid-mismatch"),
    (lambda p: p.update(updated_at=time.time() - 36), "telemetry-stale"),
    (lambda p: p.update(updated_at=time.time() + 6), "telemetry-stale"),
    (lambda p: p.update(pid=True), "telemetry-pid-mismatch"),
    (lambda p: p.update(updated_at=True), "telemetry-time-invalid"),
    (lambda p: p.update(sensor_health={}), "telemetry-health-invalid"),
    (lambda p: p.update(sensor_count=True), "telemetry-health-invalid"),
    (lambda p: p.update(sensors=["process_sensor", "process_sensor"]), "telemetry-health-invalid"),
    (lambda p: p.update(status=[]), "telemetry-health-invalid"),
    (lambda p: p.pop('process_started'), 'telemetry-health-invalid'),
    (lambda p: p.update(process_started=True), 'telemetry-health-invalid'),
    (lambda p: p.update(guardian=[]), 'telemetry-health-invalid'),
    (lambda p: p.update(guardian={'pid': True}), 'telemetry-health-invalid'),
    (lambda p: p["sensor_health"]["process_sensor"].update(state=[]), "telemetry-health-invalid"),
    (lambda p: p["sensor_health"]["process_sensor"].update(state="unknown"), "telemetry-health-invalid"),
    (lambda p: p["sensor_health"]["process_sensor"].update(last_success_at=time.time() - 1000), "telemetry-health-invalid"),
    (lambda p: p['sensor_health']['process_sensor'].pop('observation'), 'telemetry-health-invalid'),
    (lambda p: p['sensor_health']['process_sensor'].update(backend='tasklist'), 'telemetry-health-invalid'),
])
def test_signed_but_invalid_evidence_never_establishes_protection(tmp_path, change, error):
    config, _ = _fixture(tmp_path)
    _rewrite(config, change)
    result = control.protector_status(config, cleanup_stale=False)
    assert result["protection_state"] == "degraded"
    assert result["telemetry_error"] == error
    assert result["heartbeat"] is None


def test_status_recomputes_health_instead_of_trusting_signed_positive_label(tmp_path):
    config, _ = _fixture(tmp_path)
    _rewrite(config, lambda p: p["sensor_health"]["process_sensor"].update(state="failed"))
    result = control.protector_status(config, cleanup_stale=False)
    assert result["telemetry_verified"] is True
    assert result["heartbeat"]["protection_state"] == "protected"
    assert result["protection_state"] == "degraded"


def test_native_creation_mismatch_keeps_healthy_signed_frame_degraded(tmp_path):
    config, _ = _fixture(tmp_path)
    _rewrite(config, lambda p: p.update(process_started='windows:0000000000000000'))
    result = control.protector_status(config, cleanup_stale=False)
    assert result['running'] and result['telemetry_verified']
    assert result['process_identity_verified'] is False and result['heartbeat_stale']
    assert result['protection_state'] == 'degraded'


def test_runtime_and_watchdog_signatures_are_not_interchangeable(tmp_path):
    config, _ = _fixture(tmp_path)
    _rewrite(config, lambda p: None, purpose=BACKGROUND_PURPOSE)
    result = control.protector_status(config, cleanup_stale=False)
    assert result["telemetry_error"] == "telemetry-unverified"
    assert result["protection_state"] == "degraded"


@pytest.mark.parametrize("raw,error", [
    (b'x' * (MAX_TELEMETRY_BYTES + 1), "telemetry-too-large"),
    (b'{"updated_at":NaN}', "telemetry-invalid"),
    (b'{"updated_at":Infinity}', "telemetry-invalid"),
    (b'{"pid":1,"pid":2}', "telemetry-invalid"),
    (b'\xff', "telemetry-invalid"),
    (b'[]', "telemetry-invalid"),
    (b'{', "telemetry-invalid"),
    (b'{"pid":1}', "telemetry-unverified"),
], ids=["oversized", "nan", "infinity", "duplicate", "encoding", "array", "broken", "unsigned"])
def test_malformed_inputs_are_bounded_and_fail_closed_without_key_enrollment(tmp_path, raw, error):
    path, key_path = tmp_path / "heartbeat", tmp_path / "missing-key"
    path.write_bytes(raw)
    value, reason = read_telemetry(path, key_path, RUNTIME_PURPOSE)
    assert value is None
    assert reason == error
    assert not key_path.exists()
    assert path.read_bytes() == raw


def test_missing_key_is_not_created_by_a_valid_signed_telemetry_read(tmp_path):
    path, key_path = tmp_path / "heartbeat", tmp_path / "missing-key"
    payload = signed_telemetry({"pid":os.getpid(), "updated_at":time.time()}, b"a" * 64, RUNTIME_PURPOSE)
    path.write_text(json.dumps(payload))
    assert read_telemetry(path, key_path, RUNTIME_PURPOSE) == (None, "telemetry-key-unavailable")
    assert not key_path.exists()


def test_existing_plaintext_key_read_does_not_migrate_bytes(tmp_path):
    key_path = tmp_path / "key"
    key = b"a" * 64
    key_path.write_bytes(key + b'\n')
    assert read_existing_key(key_path) == key
    assert key_path.read_bytes() == key + b'\n'


def test_thread_slot_starvation_is_overdue_even_without_a_poll(tmp_path):
    config, supervisor = _fixture(tmp_path)
    supervisor._started_at = time.monotonic() - 100
    supervisor.sensors[0].next_run = time.monotonic() - 80
    supervisor._write_heartbeat("running")
    result = control.protector_status(config, cleanup_stale=False)
    assert result["protection_state"] == "degraded"
    assert result["heartbeat"]["sensor_health"]["process_sensor"]["state"] == "overdue"


def test_stalled_thread_and_limited_backend_are_partial_then_recover(tmp_path):
    config, supervisor = _fixture(tmp_path)
    scheduled = supervisor.sensors[0]
    supervisor._polls[scheduled.name] = (scheduled, Future(), {}, time.monotonic() - 80)
    assert supervisor.sensor_health()[scheduled.name]["state"] == "stalled"
    supervisor._polls.clear()
    scheduled.sensor.backend_name = "tasklist"
    supervisor._write_heartbeat("running")
    status = control.protector_status(config, cleanup_stale=False)
    assert status["protection_state"] == "degraded"
    assert status["heartbeat"]["sensor_health"][scheduled.name]["state"] == "limited"
    scheduled.sensor.backend_name = "psutil"
    supervisor._write_heartbeat("running")
    assert control.protector_status(config, cleanup_stale=False)["protection_state"] == "protected"


def test_queued_evidence_is_partial_until_durable_processing(tmp_path, monkeypatch):
    config, supervisor = _fixture(tmp_path)
    supervisor._stage_sensor_poll(_signature_sensor("network_sensor", count=3))
    supervisor._write_heartbeat("running")
    assert control.protector_status(config, cleanup_stale=False)["protection_state"] == "degraded"
    monkeypatch.setattr(supervisor, "_handle_assessment", lambda _: None)
    assert supervisor._drain_sensor_backlog(3) == 3
    supervisor._write_heartbeat("running")
    assert control.protector_status(config, cleanup_stale=False)["protection_state"] == "protected"


def test_unsigned_background_host_is_not_verified_even_when_pid_is_alive(tmp_path, monkeypatch):
    config, _ = _fixture(tmp_path)
    monkeypatch.setattr(control, "_pid_running", lambda _: True)
    path = background._heartbeat_path(config)
    payload = {"pid":os.getpid(), "process_started":probe_process(os.getpid()).started,
               "updated_at":time.time(), "state":"watching", "restart_count":0, "last_error":None}
    path.write_text(json.dumps(payload))
    result = background.background_status(config)
    assert result["host_running"] is False
    assert result["telemetry_verified"] is False
    path.write_text(json.dumps(signed_telemetry(payload, get_or_create_key(config.runtime.integrity_key_path), BACKGROUND_PURPOSE)))
    with RuntimeLock(config.runtime.pid_path.with_name('background.owner')):
        result = background.background_status(config)
        assert result["host_running"] is True
        assert result["telemetry_verified"] is True


@pytest.mark.parametrize("status", [
    {"running": True, "pid": 4242, "heartbeat_stale": False, "telemetry_verified": False},
    {"running": True, "pid": 4242, "heartbeat_stale": True, "telemetry_verified": True},
    {"running": True, "pid": 4545, "heartbeat_stale": False, "telemetry_verified": True},
])
def test_startup_does_not_succeed_from_unverified_stale_or_other_child_status(tmp_path, status):
    config = _config(tmp_path, max_events_per_tick=2)
    child = SimpleNamespace(pid=4242, poll=lambda: None, stdin=SimpleNamespace(write=lambda _: None, close=lambda: None))
    remaining = {"running": True, "pid": status["pid"]} if status["pid"] != child.pid else {"running": False}
    with patch.object(control, "protector_status", side_effect=[{"running": False}, remaining]), \
            patch.object(control.subprocess, "Popen", return_value=child), \
            patch.object(control, "_wait_for_running_status", return_value=status) as waiter, \
            patch.object(control, "_terminate_failed_start", return_value=True), \
            patch.object(control, "_cleanup_stale_runtime_markers", return_value=True) as cleanup:
        result = control._start_protector_owned(config, tmp_path / "monarch_security.toml", True)
    assert result["started"] is False
    assert result["reason"] == "startup_timeout"
    waiter.assert_called_once()
    assert waiter.call_args.args == (config,)
    assert waiter.call_args.kwargs["timeout"] == 6.0
    assert len(waiter.call_args.kwargs["expected_launch_id"]) == 32
    assert cleanup.call_count == (0 if status["pid"] != child.pid else 1)


def test_signed_launch_identity_binds_distinct_guardian_and_controller_pids(tmp_path):
    config = _config(tmp_path, max_events_per_tick=2)
    gate = []
    child = SimpleNamespace(pid=4242, poll=lambda: None, stdin=SimpleNamespace(write=gate.append, close=lambda: None))
    def ready(_config, **options):
        return {"running": True, "pid": 4545, "heartbeat_stale": False, "telemetry_verified": True,
                "heartbeat": {"launch_id": options["expected_launch_id"], 'guardian': {'pid': 4242}}}
    with patch.object(control, "protector_status", return_value={"running": False}), \
            patch.object(control.subprocess, "Popen", return_value=child) as spawn, \
            patch.object(control, "_wait_for_running_status", side_effect=ready):
        result = control._start_protector_owned(config, tmp_path / "monarch_security.toml", True)
    assert result["started"] is True
    assert result["pid"] == 4545
    assert result["launch_pid"] == 4242
    request = json.loads(gate[0])
    assert len(request['launch_id']) == 32 and request['no_llm'] is True
    assert 'MONARCH_SECURITY_LAUNCH_ID' not in spawn.call_args.kwargs['env']
    assert spawn.call_args.args[0][-1] == 'monarch_security.runtime_guard'


@pytest.mark.parametrize("value", [True, float('nan'), float('inf'), 10 ** 1000], ids=["boolean", "nan", "infinity", "huge-integer"])
def test_non_finite_or_boolean_time_never_passes_freshness(value):
    assert finite_number(value) is False
    assert control._heartbeat_stale({"updated_at": value}) is True
