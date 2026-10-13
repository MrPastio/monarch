from dataclasses import replace
from pathlib import Path
import json
import os
import zipfile

import pytest

from monarch_security import inspection_recovery as recovery, inspection_worker as worker
from monarch_security.events import SecurityEvent
from monarch_security.inspection_queue import GAPS_KEY
from monarch_security.worker_transport import WorkerError
from test_supervisor_backlog import _config, _supervisor, _observed_facts
from test_inspection_queue import ControlledPool, complete


@pytest.fixture
def fixture(tmp_path):
    root = tmp_path / 'watched'
    root.mkdir()
    paths = [root / f'inert-{index}.zip' for index in range(3)]
    for path in paths:
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('readme.txt', b'Read-only test fixture')
    config = _config(tmp_path, max_events_per_tick=2)
    config = replace(config, file_watch=replace(config.file_watch, enabled=True, paths=(root,),
                     recursive=False, max_entries_per_tick=1, poll_seconds=0.1),
                     runtime=replace(config.runtime, emergency_auto_lock_enabled=False))
    supervisor = _supervisor(config)
    supervisor.sensors = [s for s in supervisor.sensors if s.name == 'file_watch_sensor']
    source = SecurityEvent(kind='file.observed', source='file_watch_sensor', subject=str(paths[0]),
                           timestamp='2099-01-01T00:00:00+00:00', facts=_observed_facts(paths[0]))
    with supervisor.state.lock():
        supervisor._inspections._update_gap_locked(worker.failure_event(source, 'content-unavailable'))
    yield supervisor, paths
    supervisor._cancel_polls()


def start(supervisor):
    result = recovery.request_retry(supervisor.config)
    assert result['status'] == 'queued' and result['accepted']
    assert supervisor._apply_inspection_recovery()
    return supervisor.sensors[0]


def test_signed_request_is_idempotent_and_does_not_start_or_change_protection(fixture):
    supervisor, paths = fixture
    first = recovery.request_retry(supervisor.config)
    second = recovery.request_retry(supervisor.config)
    assert first['id'] == second['id'] and not second['accepted']
    assert supervisor._workers is None
    assert supervisor.state.get_json('security_level') is None
    assert supervisor.state.get_json(GAPS_KEY)['entries']
    assert 'scope' not in first and 'path' not in first


@pytest.mark.parametrize('case', ['paused', 'disabled', 'empty-scope'])
def test_request_respects_current_monitoring_scope(fixture, case):
    supervisor, _ = fixture
    config = supervisor.config
    if case == 'paused':
        with supervisor.state.lock():
            supervisor.state.data['security_level'] = 'off'
    else:
        config = replace(config, file_watch=replace(config.file_watch,
                    enabled=case != 'disabled', paths=() if case == 'empty-scope' else config.file_watch.paths))
    with pytest.raises(WorkerError):
        recovery.request_retry(config)
    assert recovery.read(supervisor.state) is None


def test_missing_enrollment_never_creates_key_or_state(tmp_path):
    config = _config(tmp_path, max_events_per_tick=2)
    with pytest.raises(WorkerError, match='not-enrolled'):
        recovery.request_retry(config)
    assert not config.runtime.integrity_key_path.exists() and not config.runtime.state_path.exists()


def test_full_paged_content_acknowledgement_required_to_clear_overflow(fixture, monkeypatch):
    supervisor, paths = fixture
    with supervisor.state.lock():
        gaps = supervisor._inspections.gaps()
        gaps['overflow'] = True
        supervisor.state.set_json(GAPS_KEY, gaps)
    scheduled = start(supervisor)
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    for index in range(3):
        assert supervisor._stage_sensor_poll(scheduled) == 1
        assert supervisor._drain_sensor_backlog(2) == 0
        assert recovery.read(supervisor.state)['status'] == 'running'
        assert supervisor._inspections.gaps()['overflow'] is True
        complete(pool, index)
        assert supervisor._drain_sensor_backlog(2) == 1
        result = recovery.read(supervisor.state)
        assert result['checked_files'] == index + 1
        assert result['status'] == 'running'
    assert supervisor._stage_sensor_poll(scheduled) == 0
    assert recovery.read(supervisor.state)['status'] == 'complete'
    assert supervisor._inspections.gap_count() == 0
    assert len(supervisor.state.get_dict('known_file_signatures')) == 3
    assert 'scope' not in recovery.projection(supervisor.state)


def test_terminal_failure_keeps_overflow_and_gap_visible(fixture, monkeypatch):
    supervisor, paths = fixture
    with supervisor.state.lock():
        gaps = supervisor._inspections.gaps()
        gaps['overflow'] = True
        supervisor.state.set_json(GAPS_KEY, gaps)
    scheduled = start(supervisor)
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    for index in range(3):
        supervisor._stage_sensor_poll(scheduled)
        supervisor._drain_sensor_backlog(2)
        if index == 0:
            pool.futures[index].set_result(worker._incomplete(pool.requests[index], 'observed-version-changed'))
        else:
            complete(pool, index)
        supervisor._drain_sensor_backlog(2)
    result = recovery.read(supervisor.state)
    assert supervisor._stage_sensor_poll(scheduled) == 0
    result = recovery.read(supervisor.state)
    assert result['status'] == 'incomplete' and result['failed_files'] == 1
    assert supervisor._inspections.gaps()['overflow'] is True
    assert supervisor._inspections.gap_count() == 2


def test_unavailable_root_does_not_complete_empty_inventory(fixture):
    from monarch_security.observation import ObservationUnavailable
    supervisor, paths = fixture
    scheduled = start(supervisor)
    scheduled.sensor.paths = (paths[0].parent / 'missing-directory',)
    assert supervisor._stage_sensor_poll(scheduled) == 0
    assert recovery.read(supervisor.state)['status'] == 'running'
    assert supervisor._inspections.gap_count() == 1


def test_scope_change_is_incomplete_without_resetting_baseline(fixture):
    supervisor, paths = fixture
    recovery.request_retry(supervisor.config)
    supervisor.config = replace(supervisor.config, file_watch=replace(supervisor.config.file_watch, paths=(paths[0].parent.parent,)))
    assert not supervisor._apply_inspection_recovery()
    assert recovery.read(supervisor.state)['status'] == 'incomplete'
    assert not supervisor._polls
    assert supervisor._inspections.gap_count() == 1


def test_running_scope_change_cannot_dispatch_old_root_content(fixture, monkeypatch):
    supervisor, paths = fixture
    scheduled = start(supervisor)
    supervisor._stage_sensor_poll(scheduled)
    supervisor.config = replace(supervisor.config, file_watch=replace(supervisor.config.file_watch, paths=()))
    assert not supervisor._apply_inspection_recovery()
    assert recovery.read(supervisor.state)['status'] == 'incomplete'
    monkeypatch.setattr(worker, 'new_pool', lambda: pytest.fail('old scope content dispatch'))
    handled = []
    monkeypatch.setattr(supervisor, '_handle_assessment', handled.append)
    assert supervisor._drain_sensor_backlog(2) == 1
    assert handled[0].event.facts['inspection_error'] == 'inspection-watch-scope-changed'


def test_missing_named_file_is_not_silently_removed_by_other_successes(fixture, monkeypatch):
    supervisor, paths = fixture
    absent = paths[0].parent / 'no-longer-present.zip'
    source = SecurityEvent(kind='file.observed', source='file_watch_sensor', subject=str(absent), facts={'path': str(absent)})
    with supervisor.state.lock():
        supervisor._inspections._update_gap_locked(worker.failure_event(source, 'content-unavailable'))
    scheduled = start(supervisor)
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    for index in range(3):
        supervisor._stage_sensor_poll(scheduled)
        supervisor._drain_sensor_backlog(2)
        complete(pool, index)
        supervisor._drain_sensor_backlog(2)
    assert supervisor._stage_sensor_poll(scheduled) == 0
    assert recovery.read(supervisor.state)['status'] == 'incomplete'
    gaps = supervisor._inspections.gaps()['entries']
    assert len(gaps) == 1 and next(iter(gaps.values()))['path'] == str(absent)


def test_recovery_inventory_does_not_generate_false_mutation_bursts(fixture, monkeypatch):
    supervisor, paths = fixture
    scheduled = start(supervisor)
    calls = []
    monkeypatch.setattr(supervisor.file_burst_detector, 'observe', lambda event: calls.append(event))
    supervisor._stage_sensor_poll(scheduled)
    assert not calls
    plain = SecurityEvent(kind='file.observed', source='file_watch_sensor', subject=str(paths[0]), facts=_observed_facts(paths[0]))
    supervisor._prepare_assessments(plain)
    assert calls == [plain]


def test_signed_restart_continues_cursor_without_suppressing_existing_files(fixture, monkeypatch):
    supervisor, paths = fixture
    scheduled = start(supervisor)
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    supervisor._stage_sensor_poll(scheduled)
    supervisor._drain_sensor_backlog(2)
    complete(pool)
    supervisor._drain_sensor_backlog(2)
    supervisor._cancel_polls()
    restarted = _supervisor(supervisor.config)
    try:
        assert recovery.read(restarted.state)['checked_files'] == 1
        scheduled = next(s for s in restarted.sensors if s.name == 'file_watch_sensor')
        assert scheduled.sensor.checkpoint_cursor == 1 and scheduled.sensor._first_poll is False
        assert restarted._stage_sensor_poll(scheduled) == 1
    finally:
        restarted._cancel_polls()


def test_native_recovery_rechecks_unchanged_files_with_low_parser(fixture, monkeypatch):
    supervisor, paths = fixture
    recovery.request_retry(supervisor.config)
    monkeypatch.setattr(supervisor, '_should_stop', lambda: (recovery.read(supervisor.state) or {'status': 'queued'})['status'] not in recovery.ACTIVE)
    assert supervisor.run(duration=25) == 0
    result = recovery.read(supervisor.state)
    assert result['status'] == 'complete' and result['checked_files'] == 3
    assert supervisor._inspections.gap_count() == 0
    decisions = [json.loads(line) for line in supervisor.config.runtime.audit_log_path.read_text().splitlines()
                 if json.loads(line).get('kind') == 'decision']
    assert len(decisions) == 3
    expected_integrity = 'low' if os.name == 'nt' else 'platform-default'
    assert all(item['assessment']['event']['facts']['content_parser_sandbox']['integrity'] == expected_integrity
               for item in decisions)


def test_actual_cli_enqueues_signed_recovery_without_paths_in_output(fixture, capsys):
    from monarch_security.cli import main
    supervisor, paths = fixture
    config_path = supervisor.config.root / 'monarch_security.toml'
    config_path.write_text(config_path.read_text().replace('[file_watch]\nenabled = false',
        "[file_watch]\nenabled = true\npaths = ['" + paths[0].parent.as_posix() + "']"))
    assert main(['--config', str(config_path), 'inspection-retry']) == 0
    result = json.loads(capsys.readouterr().out)
    assert result['ok'] and result['accepted'] and result['status'] == 'queued'
    assert paths[0].parent.as_posix() not in json.dumps(result)
    from monarch_security.state import StateStore
    fresh = StateStore(supervisor.config.runtime.state_path, supervisor.config.runtime.integrity_key_path)
    assert recovery.read(fresh)['id'] == result['id']


def accept_page(supervisor, scheduled, pool):
    count = supervisor._stage_sensor_poll(scheduled)
    supervisor._drain_sensor_backlog(max(1, count))
    for index, future in enumerate(pool.futures):
        if not future.done():
            complete(pool, index)
    assert supervisor._drain_sensor_backlog(max(1, count)) == count
    return count


def test_full_verification_catches_file_inserted_before_paged_cursor(fixture, monkeypatch):
    supervisor, paths = fixture
    scheduled = start(supervisor)
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    assert accept_page(supervisor, scheduled, pool) == 1
    inserted = paths[0].parent / 'earlier.zip'
    with zipfile.ZipFile(inserted, 'w') as archive:
        archive.writestr('readme.txt', b'Inert late inventory insertion')
    for _ in range(3):
        accept_page(supervisor, scheduled, pool)
    assert scheduled.sensor._verify_inventory
    assert str(inserted).lower() not in scheduled.sensor.signatures
    assert accept_page(supervisor, scheduled, pool) == 1
    assert recovery.read(supervisor.state)['status'] == 'running'
    assert supervisor._stage_sensor_poll(scheduled) == 0
    assert recovery.read(supervisor.state)['status'] == 'complete'
    assert recovery.read(supervisor.state)['checked_files'] == 4


def test_continually_changed_inventory_stops_after_three_verification_passes(fixture, monkeypatch):
    supervisor, paths = fixture
    scheduled = start(supervisor)
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    for _ in paths:
        accept_page(supervisor, scheduled, pool)
    for index in range(3):
        with zipfile.ZipFile(paths[0], 'w') as archive:
            archive.writestr('readme.txt', b'Changed inert fixture' + bytes(index + 1))
        assert accept_page(supervisor, scheduled, pool) == 1
    value = recovery.read(supervisor.state)
    assert value['status'] == 'incomplete' and value['reason'] == 'inspection-inventory-unstable'
    assert supervisor._inspections.gaps()['overflow']
    assert not scheduled.sensor._verify_inventory


def test_unavailable_inventory_is_bounded_and_survives_restart(fixture):
    supervisor, paths = fixture
    scheduled = start(supervisor)
    scheduled.sensor.paths = (paths[0].parent / 'missing-directory',)
    for _ in range(3):
        assert supervisor._stage_sensor_poll(scheduled) == 0
    assert recovery.read(supervisor.state)['status'] == 'incomplete'
    assert recovery.read(supervisor.state)['reason'] == 'inspection-inventory-unavailable'
    assert supervisor._inspections.gaps()['overflow']
    supervisor._cancel_polls()
    restarted = _supervisor(supervisor.config)
    try:
        sensor = next(s.sensor for s in restarted.sensors if s.name == 'file_watch_sensor')
        assert not sensor._verify_inventory
        assert recovery.read(restarted.state)['status'] == 'incomplete'
    finally:
        restarted._cancel_polls()


def test_restart_keeps_full_inventory_verification_required(fixture, monkeypatch):
    supervisor, paths = fixture
    scheduled = start(supervisor)
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    for _ in paths:
        accept_page(supervisor, scheduled, pool)
    supervisor._cancel_polls()
    restarted = _supervisor(supervisor.config)
    try:
        scheduled = next(s for s in restarted.sensors if s.name == 'file_watch_sensor')
        assert scheduled.sensor._verify_inventory
        assert recovery.read(restarted.state)['status'] == 'running'
        assert restarted._stage_sensor_poll(scheduled) == 0
        assert recovery.read(restarted.state)['status'] == 'complete'
    finally:
        restarted._cancel_polls()


def test_recovery_is_local_diagnostic_even_with_critical_incident_after_cancellation(fixture, monkeypatch):
    from types import SimpleNamespace
    supervisor, paths = fixture
    scheduled = start(supervisor)
    supervisor._stage_sensor_poll(scheduled)
    event = SecurityEvent.from_dict(supervisor._pending_sensor_batches()['file_watch_sensor']['assessments'][0]['event'])
    with supervisor.state.lock():
        value = recovery.read(supervisor.state)
        value['status'] = 'incomplete'
        supervisor.state.set_json(recovery.KEY, value)
    supervisor.no_llm = False
    supervisor.config = replace(supervisor.config, runtime=replace(supervisor.config.runtime, emergency_auto_lock_enabled=True))
    monkeypatch.setattr(supervisor.router, 'decide', lambda _: pytest.fail('recovery model dispatch'))
    monkeypatch.setattr(supervisor.emergency, 'activate', lambda *a, **k: pytest.fail('recovery emergency action'))
    monkeypatch.setattr(supervisor.incidents, 'observe', lambda *a: SimpleNamespace(
        incident_id='synthetic', risk_score=900, risk_level='critical', evidence_families=(),
        decision_required=True, emergency_eligible=True))
    monkeypatch.setattr(supervisor.notifications, 'notify', lambda *a, **k: SimpleNamespace(sent=False))
    supervisor._handle_assessment(supervisor.rules.assess(event))


def test_sensor_cannot_supply_recovery_marker(fixture, monkeypatch):
    supervisor, paths = fixture
    observed = SecurityEvent(kind='file.observed', source='file_watch_sensor', subject=str(paths[0]),
        facts={**_observed_facts(paths[0]), 'inspection_recovery_id': '0' * 32})
    handled = []
    original = supervisor._prepare_assessments
    monkeypatch.setattr(supervisor, '_prepare_assessments', lambda event: (handled.append(event) or original(event)))
    supervisor._stage_sensor_events(supervisor.sensors[0], [observed])
    assert 'inspection_recovery_id' not in handled[0].facts


def test_recovery_inspects_plain_file_outside_ordinary_deep_extension_set(fixture, monkeypatch):
    supervisor, paths = fixture
    plain = paths[0].parent / 'ordinary.txt'
    plain.write_text('Read-only inert fixture')
    scheduled = start(supervisor)
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    for _ in range(4):
        assert accept_page(supervisor, scheduled, pool) == 1
    assert any(request['path'] == str(plain) for request in pool.requests)
    assert recovery.read(supervisor.state)['checked_files'] == 4
    assert supervisor._stage_sensor_poll(scheduled) == 0
    assert recovery.read(supervisor.state)['status'] == 'complete'


def test_inventory_failure_limit_cannot_be_reset_by_process_restart(fixture):
    supervisor, paths = fixture
    scheduled = start(supervisor)
    scheduled.sensor.paths = (paths[0].parent / 'missing-directory',)
    for _ in range(2):
        assert supervisor._stage_sensor_poll(scheduled) == 0
    assert recovery.read(supervisor.state)['inventory_failures'] == 2
    supervisor._cancel_polls()
    restarted = _supervisor(supervisor.config)
    try:
        scheduled = next(s for s in restarted.sensors if s.name == 'file_watch_sensor')
        scheduled.sensor.paths = (paths[0].parent / 'missing-directory',)
        assert restarted._stage_sensor_poll(scheduled) == 0
        value = recovery.read(restarted.state)
        assert value['inventory_failures'] == 3 and value['status'] == 'incomplete'
        assert restarted._inspections.gaps()['overflow']
    finally:
        restarted._cancel_polls()


def test_cancelled_batch_cannot_restore_full_verification_mode(fixture, monkeypatch):
    supervisor, paths = fixture
    scheduled = start(supervisor)
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    for _ in paths:
        accept_page(supervisor, scheduled, pool)
    with zipfile.ZipFile(paths[0], 'w') as archive:
        archive.writestr('readme.txt', b'Changed inert fixture before cancellation')
    assert supervisor._stage_sensor_poll(scheduled) == 1
    supervisor.config = replace(supervisor.config, file_watch=replace(supervisor.config.file_watch, paths=()))
    assert not supervisor._apply_inspection_recovery()
    assert supervisor._drain_sensor_backlog(2) == 1
    assert not scheduled.sensor._verify_inventory
    assert not supervisor._sensor_checkpoints()['file_watch_sensor']['metadata']['verify_inventory']


def test_retry_never_calls_key_enrollment_or_migration(fixture, monkeypatch):
    supervisor, _ = fixture
    monkeypatch.setattr('monarch_security.state.get_or_create_key',
                        lambda _: pytest.fail('retry called key enrollment/migration'))
    assert recovery.request_retry(supervisor.config)['accepted']


def test_state_disappearing_before_locked_request_cannot_be_reenrolled(fixture, monkeypatch):
    supervisor, _ = fixture
    original = Path.is_file
    checks = 0
    def missing_during_lock(path):
        nonlocal checks
        if path == supervisor.config.runtime.state_path:
            checks += 1
            return checks == 1
        return original(path)
    original_bytes = supervisor.config.runtime.state_path.read_bytes()
    monkeypatch.setattr(Path, 'is_file', missing_during_lock)
    with pytest.raises(WorkerError, match='not-enrolled'):
        recovery.request_retry(supervisor.config)
    assert supervisor.config.runtime.state_path.read_bytes() == original_bytes
