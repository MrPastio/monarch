from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import json
import os
import zipfile

import pytest

from monarch_security.analysis import RuleEngine
from monarch_security.audit import AuditLog
from monarch_security.config import load_config
from monarch_security.events import RuleAssessment, SecurityEvent
from monarch_security.llm import LLMRouter
from monarch_security.policy import PolicyEngine
from monarch_security.resources import ResourceGuard
from monarch_security.sensors import FileScanner
from monarch_security.state import StateStore
from monarch_security.supervisor import SecuritySupervisor, _ScheduledSensor
from monarch_security.supervisor import PENDING_SENSOR_BATCHES_KEY, SENSOR_CHECKPOINTS_KEY


def test_capped_backlog_survives_restart_before_checkpoint_ack(tmp_path: Path) -> None:
    config = _config(tmp_path, max_events_per_tick=2)
    first = _supervisor(config)
    scheduled = _signature_sensor("file_watch_sensor", count=3)

    assert first._stage_sensor_poll(scheduled) == 3
    assert first._drain_sensor_backlog(2) == 2
    assert first.state.get_dict("known_file_signatures") == {}
    assert first._sensor_backlog_health()["queued"] == 1

    restarted = _supervisor(config)
    assert restarted._drain_sensor_backlog(2) == 1
    assert restarted.state.get_dict("known_file_signatures") == {
        "file_watch_sensor-item-0": "0",
        "file_watch_sensor-item-1": "1",
        "file_watch_sensor-item-2": "2",
    }
    assert restarted._sensor_backlog_health()["queued"] == 0
    assert _audit_kind_count(config.runtime.audit_log_path, "decision") == 3


def test_failed_handler_keeps_assessment_and_checkpoint_unacknowledged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path, max_events_per_tick=1)
    supervisor = _supervisor(config)
    supervisor._stage_sensor_poll(_signature_sensor("network_sensor", count=1))

    def fail_handler(_assessment):
        raise OSError("incident persistence unavailable")

    monkeypatch.setattr(supervisor, "_handle_assessment", fail_handler)
    with pytest.raises(OSError, match="persistence unavailable"):
        supervisor._drain_sensor_backlog(1)

    assert supervisor._sensor_backlog_health()["queued"] == 1
    assert supervisor.state.get_dict("known_network_signatures") == {}


def test_backlog_drain_is_fair_across_sensors(tmp_path: Path) -> None:
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    supervisor._stage_sensor_poll(_signature_sensor("file_watch_sensor", count=3))
    supervisor._stage_sensor_poll(_signature_sensor("network_sensor", count=3))

    assert supervisor._drain_sensor_backlog(2) == 2
    health = supervisor._sensor_backlog_health()
    assert health["queued"] == 4
    assert health["by_sensor"] == {
        "file_watch_sensor": 2,
        "network_sensor": 2,
    }


def test_backlog_fairness_rotates_when_limit_is_smaller_than_sensor_count(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    for name in ("alpha_sensor", "beta_sensor", "gamma_sensor"):
        supervisor._stage_sensor_poll(_signature_sensor(name, count=2))

    assert supervisor._drain_sensor_backlog(2) == 2
    assert supervisor._drain_sensor_backlog(2) == 2

    health = supervisor._sensor_backlog_health()
    assert health["by_sensor"] == {
        "beta_sensor": 1,
        "gamma_sensor": 1,
    }


def test_staging_reloads_external_trust_state_before_assessment(tmp_path: Path) -> None:
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    instance_id = r"USB\VID_1234&PID_5678\A"
    event = SecurityEvent(
        kind="device.connected",
        source="device_sensor",
        subject="USB storage",
        facts={"instance_id": instance_id, "class": "DiskDrive"},
    )
    sensor = SimpleNamespace(
        poll=lambda: [event],
        _seen={instance_id},
        _first_poll=False,
    )
    external_state = StateStore(
        config.runtime.state_path,
        config.runtime.integrity_key_path,
    )
    with external_state.lock():
        external_state.set_list("trusted_device_ids", [instance_id.lower()])

    assert supervisor._stage_sensor_poll(
        _ScheduledSensor("device_sensor", sensor, 1.0)
    ) == 1
    batch = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY, {})["device_sensor"]
    facts = batch["assessments"][0]["event"]["facts"]
    assert facts["trusted_device"] is True
    assert facts["device_trust_state"] == "trusted"


def test_bounded_drain_acknowledges_with_one_signed_state_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path, max_events_per_tick=5)
    supervisor = _supervisor(config)
    supervisor._stage_sensor_poll(_signature_sensor("file_watch_sensor", count=5))
    original_save = supervisor.state.save
    save_calls = 0

    def counted_save():
        nonlocal save_calls
        save_calls += 1
        return original_save()

    monkeypatch.setattr(supervisor.state, "save", counted_save)

    assert supervisor._drain_sensor_backlog(5) == 5
    assert save_calls == 1
    assert supervisor._sensor_backlog_health()["queued"] == 0


def test_pending_process_assessment_does_not_persist_raw_command_line(tmp_path: Path) -> None:
    config = _config(tmp_path, max_events_per_tick=1)
    supervisor = _supervisor(config)
    secret = "never-persist-this-secret"
    event = SecurityEvent(
        kind="process.started",
        source="process_sensor",
        subject="powershell.exe",
        facts={
            "pid": 42,
            "name": "powershell.exe",
            "cmdline": ["powershell.exe", "-EncodedCommand", secret],
            "username": "example-user",
            "parent_name": "WINWORD.EXE",
        },
    )
    sensor = SimpleNamespace(
        poll=lambda: [event],
        _seen={42},
        _first_poll=False,
    )

    supervisor._stage_sensor_poll(_ScheduledSensor("process_sensor", sensor, 1.0))
    serialized = config.runtime.state_path.read_text(encoding="utf-8")

    assert secret not in serialized
    assert "example-user" not in serialized
    assert "encoded" in serialized
    assert supervisor._sensor_backlog_health()["queued"] == 1
    assert supervisor._drain_sensor_backlog(1) == 1
    assert "process_sensor" not in supervisor.state.get_json(SENSOR_CHECKPOINTS_KEY, {})


def test_heartbeat_exposes_bounded_overflow_health(tmp_path: Path) -> None:
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    supervisor._stage_sensor_poll(_signature_sensor("file_watch_sensor", count=5))

    supervisor._write_heartbeat("running")
    heartbeat = json.loads(config.runtime.heartbeat_path.read_text(encoding="utf-8"))

    assert heartbeat["sensor_backlog"] == {
        "batches": 1,
        "by_sensor": {"file_watch_sensor": 5},
        "oldest_queued_at": heartbeat["sensor_backlog"]["oldest_queued_at"],
        "overflow": True,
        "queued": 5,
    }
    assert heartbeat["sensor_backlog"]["oldest_queued_at"]


def test_run_stages_entire_poll_before_enforcing_per_tick_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    supervisor.sensors = [_signature_sensor("file_watch_sensor", count=3)]

    def stop_after_first_tick(*_args):
        raise KeyboardInterrupt

    monkeypatch.setattr(supervisor, "_sleep_until_next_sensor", stop_after_first_tick)

    assert supervisor.run(duration=0) == 130
    assert _audit_kind_count(config.runtime.audit_log_path, "decision") == 2
    assert supervisor._sensor_backlog_health()["queued"] == 1
    assert supervisor.state.get_dict("known_file_signatures") == {}


def test_file_inspection_runs_during_drain_and_is_persisted_before_handler(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    path = tmp_path / "sample.exe"
    path.write_bytes(b"MZ")
    source = SecurityEvent(
        kind="file.observed",
        source="file_watch_sensor",
        subject=str(path),
        facts={"path": str(path), "extension": ".exe"},
    )
    sensor = SimpleNamespace(
        poll=lambda: [source],
        signatures={str(path).lower(): "2:1"},
        _first_poll=False,
    )
    scanner_calls = 0

    def inspect(_scanner, inspected_path: Path) -> SecurityEvent:
        nonlocal scanner_calls
        scanner_calls += 1
        return SecurityEvent(
            kind="file.scanned",
            source="file_scanner",
            subject=str(inspected_path),
            facts={
                "path": str(inspected_path),
                "extension": ".exe",
                "magic_type": "pe",
                "pe_valid": True,
                "content_parser_status": "ok",
            },
        )

    monkeypatch.setattr(FileScanner, "inspect", inspect)
    monkeypatch.setattr(
        "monarch_security.supervisor._with_authenticode_facts_if_needed",
        lambda event: event,
    )
    handled: list[RuleAssessment] = []

    def handle(assessment: RuleAssessment) -> None:
        persisted = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY, {})
        stored = persisted["file_watch_sensor"]["assessments"][0]
        assert stored["event"]["kind"] == "file.scanned"
        assert stored["event"]["event_id"] == source.event_id
        handled.append(assessment)

    monkeypatch.setattr(supervisor, "_handle_assessment", handle)

    assert supervisor._stage_sensor_poll(
        _ScheduledSensor("file_watch_sensor", sensor, 1.0)
    ) == 1
    assert scanner_calls == 0
    assert supervisor._drain_sensor_backlog(1) == 1
    assert scanner_calls == 1
    assert handled[0].event.kind == "file.scanned"
    assert handled[0].event.event_id == source.event_id


def test_materialized_file_assessment_survives_handler_failure_without_rescan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path, max_events_per_tick=1)
    supervisor = _supervisor(config)
    path = tmp_path / "sample.exe"
    path.write_bytes(b"MZ")
    source = SecurityEvent(
        kind="file.observed",
        source="file_watch_sensor",
        subject=str(path),
        facts={"path": str(path), "extension": ".exe"},
    )
    sensor = SimpleNamespace(
        poll=lambda: [source],
        signatures={str(path).lower(): "2:1"},
        _first_poll=False,
    )
    scanner_calls = 0

    def inspect(_scanner, inspected_path: Path) -> SecurityEvent:
        nonlocal scanner_calls
        scanner_calls += 1
        return SecurityEvent(
            kind="file.scanned",
            source="file_scanner",
            subject=str(inspected_path),
            facts={
                "path": str(inspected_path),
                "extension": ".exe",
                "magic_type": "pe",
                "pe_valid": True,
                "content_parser_status": "ok",
            },
        )

    monkeypatch.setattr(FileScanner, "inspect", inspect)
    monkeypatch.setattr(
        "monarch_security.supervisor._with_authenticode_facts_if_needed",
        lambda event: event,
    )
    supervisor._stage_sensor_poll(_ScheduledSensor("file_watch_sensor", sensor, 1.0))
    monkeypatch.setattr(
        supervisor,
        "_handle_assessment",
        lambda _assessment: (_ for _ in ()).throw(OSError("audit unavailable")),
    )

    with pytest.raises(OSError, match="audit unavailable"):
        supervisor._drain_sensor_backlog(1)
    persisted = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY, {})
    assert persisted["file_watch_sensor"]["assessments"][0]["event"]["kind"] == "file.scanned"
    assert scanner_calls == 1

    restarted = _supervisor(config)

    def unexpected_scan(_scanner, _path):
        raise AssertionError("materialized assessment was scanned again")

    monkeypatch.setattr(FileScanner, "inspect", unexpected_scan)
    handled: list[RuleAssessment] = []
    monkeypatch.setattr(restarted, "_handle_assessment", handled.append)
    assert restarted._drain_sensor_backlog(1) == 1
    assert handled[0].event.kind == "file.scanned"
    assert handled[0].event.event_id == source.event_id


def test_multiple_file_assessments_materialize_before_one_batched_acknowledgement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path, max_events_per_tick=3)
    supervisor = _supervisor(config)
    paths = [tmp_path / f"sample-{index}.zip" for index in range(3)]
    for path in paths:
        path.write_bytes(b"PK\x05\x06")
    events = [
        SecurityEvent(
            kind="file.observed",
            source="file_watch_sensor",
            subject=str(path),
            facts={"path": str(path), "extension": ".zip"},
        )
        for path in paths
    ]
    sensor = SimpleNamespace(
        poll=lambda: events,
        signatures={str(path).lower(): f"signature-{index}" for index, path in enumerate(paths)},
        _first_poll=False,
    )

    def inspect(_scanner, inspected_path: Path) -> SecurityEvent:
        return SecurityEvent(
            kind="file.scanned",
            source="file_scanner",
            subject=str(inspected_path),
            facts={
                "path": str(inspected_path),
                "extension": ".zip",
                "magic_type": "zip",
                "content_parser_status": "ok",
            },
        )

    monkeypatch.setattr(FileScanner, "inspect", inspect)
    handled: list[RuleAssessment] = []
    monkeypatch.setattr(supervisor, "_handle_assessment", handled.append)
    supervisor._stage_sensor_poll(_ScheduledSensor("file_watch_sensor", sensor, 1.0))

    assert supervisor._drain_sensor_backlog(3) == 3
    assert [item.event.event_id for item in handled] == [item.event_id for item in events]
    assert all(item.event.kind == "file.scanned" for item in handled)
    assert supervisor._sensor_backlog_health()["queued"] == 0


def test_backlog_drain_stops_at_aggregate_processing_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path, max_events_per_tick=3)
    supervisor = _supervisor(config)
    supervisor._stage_sensor_poll(_signature_sensor("network_sensor", count=3))
    monkeypatch.setattr(supervisor, "_handle_assessment", lambda _assessment: None)
    moments = iter((100.0, 111.0))
    monkeypatch.setattr(
        "monarch_security.supervisor.time.monotonic",
        lambda: next(moments),
    )

    assert supervisor._drain_sensor_backlog(3) == 1
    assert supervisor._sensor_backlog_health()["queued"] == 2
    statuses = [
        json.loads(line)
        for line in config.runtime.audit_log_path.read_text(encoding="utf-8").splitlines()
    ]
    exhausted = [
        item
        for item in statuses
        if item.get("status") == "sensor_processing_budget_exhausted"
    ]
    assert len(exhausted) == 1
    assert exhausted[0]["processed"] == 1
    assert exhausted[0]["queued"] == 2


def test_supervisor_materializes_real_isolated_zip_parser_before_audit(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    path = tmp_path / "sample.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("notes.txt", b"safe")
        archive.writestr("invoice.pdf.exe", b"MZ")
    source = SecurityEvent(
        kind="file.observed",
        source="file_watch_sensor",
        subject=str(path),
        facts={"path": str(path), "extension": ".zip"},
    )
    sensor = SimpleNamespace(
        poll=lambda: [source],
        signatures={str(path).lower(): "sample-signature"},
        _first_poll=False,
    )

    assert supervisor._stage_sensor_poll(
        _ScheduledSensor("file_watch_sensor", sensor, 1.0)
    ) == 1
    staged = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY, {})
    assert staged["file_watch_sensor"]["assessments"][0]["event"]["kind"] == "file.observed"
    assert supervisor._drain_sensor_backlog(2) == 1

    decisions = [
        json.loads(line)
        for line in config.runtime.audit_log_path.read_text(encoding="utf-8").splitlines()
        if json.loads(line).get("kind") == "decision"
    ]
    assert len(decisions) == 1
    event = decisions[0]["assessment"]["event"]
    assert event["event_id"] == source.event_id
    assert event["kind"] == "file.scanned"
    assert event["facts"]["content_parser_status"] == "ok"
    expected_integrity = "low" if os.name == "nt" else "platform-default"
    assert event["facts"]["content_parser_sandbox"]["integrity"] == expected_integrity
    assert event["facts"]["archive_executable_entries"] == ["invoice.pdf.exe"]
    assert supervisor._sensor_backlog_health()["queued"] == 0


def test_signed_backlog_with_mismatched_sensor_identity_fails_closed(tmp_path: Path) -> None:
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    with supervisor.state.lock():
        supervisor.state.set_json(
            PENDING_SENSOR_BATCHES_KEY,
            {
                "file_watch_sensor": {
                    "schema": 1,
                    "sensor": "network_sensor",
                    "queued_at": "2026-08-09T00:00:00+00:00",
                    "next_index": 0,
                    "assessments": [],
                    "checkpoint": {},
                }
            },
        )

    with pytest.raises(RuntimeError, match="identity is invalid"):
        supervisor._sensor_backlog_health()


def _signature_sensor(name: str, *, count: int) -> _ScheduledSensor:
    events = [
        SecurityEvent(
            kind="file.observed" if name == "file_watch_sensor" else "network.connection_seen",
            source=name,
            subject=f"{name}-item-{index}",
            facts={"path": f"{name}-item-{index}"},
        )
        for index in range(count)
    ]
    signatures = {f"{name}-item-{index}": str(index) for index in range(count)}
    sensor = SimpleNamespace(
        poll=lambda: events,
        signatures=signatures,
        _first_poll=False,
    )
    return _ScheduledSensor(name, sensor, 1.0)


def _supervisor(config) -> SecuritySupervisor:
    resources = ResourceGuard(config.resources)
    policy = PolicyEngine(config.policy)
    return SecuritySupervisor(
        config=config,
        resources=resources,
        rules=RuleEngine(config.router),
        router=LLMRouter(config, resources, policy),
        policy=policy,
        audit=AuditLog(
            config.runtime.audit_log_path,
            max_bytes=0,
            stdout=False,
            integrity_key_path=config.runtime.integrity_key_path,
        ),
        state=StateStore(config.runtime.state_path, config.runtime.integrity_key_path),
        no_llm=True,
    )


def _config(root: Path, *, max_events_per_tick: int):
    config_path = root / "monarch_security.toml"
    config_path.write_text(
        f"""
[file_watch]
enabled = false

[network]
enabled = false

[persistence]
enabled = false

[posture]
enabled = false

[runtime]
state_path = "data/state.json"
audit_log_path = "logs/audit.jsonl"
integrity_key_path = "data/integrity.key"
process_monitor_enabled = false
device_monitor_enabled = false
install_monitor_enabled = false
max_events_per_tick = {max_events_per_tick}
""".strip()
        + "\n",
        encoding="utf-8",
    )
    return load_config(config_path)


def _audit_kind_count(path: Path, kind: str) -> int:
    return sum(
        1
        for line in path.read_text(encoding="utf-8").splitlines()
        if json.loads(line).get("kind") == kind
    )
