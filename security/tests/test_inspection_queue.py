from concurrent.futures import Future
from dataclasses import replace
from pathlib import Path
import time

import pytest

from monarch_security import inspection_worker as worker
from monarch_security.inspection_queue import GAPS_KEY, MAX_GAPS, FileInspectionQueue
from monarch_security.events import SecurityEvent
from monarch_security.sensors import FileScanner, FileChangeSensor
from monarch_security.supervisor import _ScheduledSensor, PENDING_SENSOR_BATCHES_KEY
from monarch_security.worker_transport import WorkerError
from test_supervisor_backlog import _config, _supervisor, _signature_sensor, _observed_facts


class ControlledPool:
    available = True
    def __init__(self):
        self.requests, self.futures = [], []
        self.closed = False
    def tick(self):
        pass
    def submit(self, request, *, timeout):
        future = Future()
        self.requests.append(request)
        self.futures.append(future)
        return future
    def close(self):
        self.closed = True
        for future in self.futures:
            if not future.done():
                future.set_exception(WorkerError('worker-cancelled'))


@pytest.fixture
def pending(tmp_path, monkeypatch):
    config = _config(tmp_path, max_events_per_tick=2)
    supervisor = _supervisor(config)
    path = tmp_path / 'read-only.zip'
    path.write_bytes(b'PK\x05\x06')
    event = SecurityEvent(kind='file.observed', source='file_watch_sensor', subject=str(path),
                          facts=_observed_facts(path))
    sensor = FileChangeSensor((tmp_path,), recursive=False, max_entries_per_tick=20, include_existing=True)
    monkeypatch.setattr(sensor, 'poll', lambda: [event])
    supervisor._stage_sensor_poll(_ScheduledSensor('file_watch_sensor', sensor, 1))
    pool = ControlledPool()
    monkeypatch.setattr(worker, 'new_pool', lambda: pool)
    yield supervisor, event, pool
    supervisor._inspections.close()


def complete(pool, index=0):
    request = pool.requests[index]
    facts = {'path': request['path'], 'extension': '.zip', 'magic_type': 'zip',
             'inspection_complete': True, 'content_parser_status': 'ok',
             'content_parser_isolated': True,
             'content_parser_sandbox': {'process': 'isolated-worker', 'integrity': 'low',
                                        'memory_limit': 'windows-job'}}
    pool.futures[index].set_result(worker._response(request, 'complete', facts))


def test_pending_job_never_invokes_inline_file_io_and_other_sensors_continue(pending, monkeypatch):
    supervisor, event, pool = pending
    monkeypatch.setattr(FileScanner, 'inspect', lambda *_: pytest.fail('inline content parsing'))
    monkeypatch.setattr(Path, 'resolve', lambda *_: pytest.fail('inline path resolution'))
    supervisor._stage_sensor_poll(_signature_sensor('network_sensor', count=2))
    handled = []
    monkeypatch.setattr(supervisor, '_handle_assessment', handled.append)
    assert supervisor._drain_sensor_backlog(2) == 2
    assert all(item.event.kind == 'network.connection_seen' for item in handled)
    assert len(pool.requests) == 1
    batch = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)['file_watch_sensor']
    assert batch['next_index'] == 0
    assert batch['assessments'][0]['event']['event_id'] == event.event_id
    assert batch['inspections']['0']['attempts'] == 1


def test_attempt_is_signed_before_submit_and_result_before_handler(pending, monkeypatch):
    supervisor, event, pool = pending
    submit = pool.submit
    def checked(request, *, timeout):
        state = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)['file_watch_sensor']
        assert state['inspections']['0']['nonce'] == request['nonce']
        assert state['assessments'][0]['event']['kind'] == 'file.observed'
        return submit(request, timeout=timeout)
    monkeypatch.setattr(pool, 'submit', checked)
    assert supervisor._drain_sensor_backlog(2) == 0
    complete(pool)
    def handler(assessment):
        state = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)['file_watch_sensor']
        assert state['assessments'][0] == assessment.to_dict()
        assert assessment.event.event_id == event.event_id
        assert assessment.event.timestamp == event.timestamp
    monkeypatch.setattr(supervisor, '_handle_assessment', handler)
    assert supervisor._drain_sensor_backlog(2) == 1
    assert supervisor._sensor_backlog_health()['queued'] == 0


def test_stop_delivered_while_content_pending_preserves_queue(pending, monkeypatch):
    supervisor, event, pool = pending
    started = time.monotonic()
    assert supervisor.run(duration=0.5) == 0
    assert time.monotonic() - started < 3
    assert pool.closed
    assert supervisor._inspections._jobs == {}
    batch = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)['file_watch_sensor']
    assert batch['assessments'][0]['event']['event_id'] == event.event_id
    assert batch['next_index'] == 0


def test_bounded_retry_and_signed_gap_survive_ack_and_restart(pending, monkeypatch):
    supervisor, event, pool = pending
    now = [time.time()]
    monkeypatch.setattr('monarch_security.inspection_queue.time.time', lambda: now[0])
    for attempt in range(3):
        assert supervisor._drain_sensor_backlog(2) == 0
        assert len(pool.requests) == attempt + 1
        pool.futures[attempt].set_result(worker._incomplete(pool.requests[attempt], 'content-unavailable'))
        if attempt < 2:
            assert supervisor._drain_sensor_backlog(2) == 0
            assert supervisor._drain_sensor_backlog(2) == 0
            assert len(pool.requests) == attempt + 1
            now[0] += 4**attempt + 0.1
    assert supervisor._drain_sensor_backlog(2) == 1
    health = supervisor._sensor_backlog_health()
    assert health['queued_events'] == 0 and health['incomplete_files'] == 1
    supervisor.sensors = [_ScheduledSensor('file_watch_sensor', object(), 20)]
    supervisor._sensor_health['file_watch_sensor'] = {
        'last_success_at': now[0], 'failures': 0,
        'observation': {'status': 'complete', 'reasons': []}}
    supervisor._write_heartbeat('running')
    import json
    heartbeat = json.loads(supervisor.config.runtime.heartbeat_path.read_text())
    from monarch_security.runtime_health import protection_state, validate_runtime_health
    assert heartbeat['sensor_health']['file_watch_sensor']['state'] == 'healthy'
    assert validate_runtime_health(heartbeat)
    assert protection_state('running', heartbeat['sensor_health'], {'queued': 0}) == 'protected'
    assert heartbeat['protection_state'] == 'degraded'
    restarted = _supervisor(supervisor.config)
    try:
        assert restarted._sensor_backlog_health()['incomplete_files'] == 1
        assert restarted.state.get_json(GAPS_KEY) == supervisor.state.get_json(GAPS_KEY)
        assert restarted._drain_sensor_backlog(2) == 0
        assert len(pool.requests) == 3
    finally:
        restarted._inspections.close()


def test_cancelled_generation_cannot_accept_late_success(pending, monkeypatch):
    supervisor, event, pool = pending
    supervisor._drain_sensor_backlog(2)
    # Simulate a completed reply awaiting controller collection when profile changed.
    complete(pool)
    supervisor._cancel_polls()
    handled = []
    monkeypatch.setattr(supervisor, '_handle_assessment', handled.append)
    assert supervisor._drain_sensor_backlog(2) == 0
    assert not handled
    assert supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)['file_watch_sensor']['assessments'][0]['event']['kind'] == 'file.observed'


def test_restart_after_recorded_third_launch_marks_incomplete_without_fourth_job(pending, monkeypatch):
    supervisor, event, pool = pending
    supervisor._drain_sensor_backlog(2)
    with supervisor.state.lock():
        batches = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)
        batches['file_watch_sensor']['inspections']['0']['attempts'] = 3
        supervisor.state.set_json(PENDING_SENSOR_BATCHES_KEY, batches)
    supervisor._cancel_polls()
    restarted = _supervisor(supervisor.config)
    try:
        assert restarted._drain_sensor_backlog(2) == 1
        assert len(pool.requests) == 1
        assert restarted._sensor_backlog_health()['incomplete_files'] == 1
    finally:
        restarted._inspections.close()


def test_changed_observed_version_is_terminal_and_carries_no_new_digest(pending, monkeypatch):
    supervisor, event, pool = pending
    supervisor._drain_sensor_backlog(2)
    pool.futures[0].set_result(worker._incomplete(pool.requests[0], 'observed-version-changed'))
    handled = []
    monkeypatch.setattr(supervisor, '_handle_assessment', handled.append)
    assert supervisor._drain_sensor_backlog(2) == 1
    assert len(pool.requests) == 1
    assert handled[0].event.facts['inspection_complete'] is False
    assert 'sha256' not in handled[0].event.facts
    assert supervisor._sensor_backlog_health()['incomplete_files'] == 1


def test_two_jobs_only_and_out_of_order_result_does_not_ack_checkpoint(pending, monkeypatch):
    supervisor, event, pool = pending
    with supervisor.state.lock():
        batches = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)
        source = batches['file_watch_sensor']['assessments'][0]
        items = []
        for index in range(5):
            clone = {**source, 'event': {**source['event'], 'event_id': f'event-{index}'}}
            items.append(clone)
        batches['file_watch_sensor']['assessments'] = items
        supervisor.state.set_json(PENDING_SENSOR_BATCHES_KEY, batches)
    assert supervisor._drain_sensor_backlog(5) == 0
    assert len(pool.requests) == 2
    complete(pool, 1)
    assert supervisor._drain_sensor_backlog(5) == 0
    assert supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)['file_watch_sensor']['next_index'] == 0
    complete(pool, 0)
    handled = []
    monkeypatch.setattr(supervisor, '_handle_assessment', handled.append)
    assert supervisor._drain_sensor_backlog(5) == 2
    assert [item.event.event_id for item in handled] == ['event-0', 'event-1']


def test_successful_newer_same_path_clears_gap_but_old_success_does_not(pending):
    supervisor, event, pool = pending
    queue = supervisor._inspections
    with supervisor.state.lock():
        queue._update_gap_locked(worker.failure_event(event, 'content-unavailable'))
        queue._update_gap_locked(replace(event, timestamp='2000-01-01T00:00:00+00:00',
                                        facts={**event.facts, 'inspection_complete': True}))
    assert queue.gap_count() == 1
    with supervisor.state.lock():
        queue._update_gap_locked(replace(event, timestamp='2099-01-01T00:00:00+00:00',
                                        facts={**event.facts, 'inspection_complete': True}))
    assert queue.gap_count() == 0


def test_lookahead_success_is_committed_after_older_same_path_failure(pending, monkeypatch):
    supervisor, event, pool = pending
    with supervisor.state.lock():
        batches = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)
        original = batches['file_watch_sensor']['assessments'][0]
        later = {**original, 'event': {**original['event'], 'event_id': 'later-file-version',
                                       'timestamp': '2099-01-01T00:00:00+00:00'}}
        batches['file_watch_sensor']['assessments'].append(later)
        supervisor.state.set_json(PENDING_SENSOR_BATCHES_KEY, batches)
    assert supervisor._drain_sensor_backlog(2) == 0
    complete(pool, 1)
    assert supervisor._drain_sensor_backlog(2) == 0
    # The newer lookahead may finish first, but must not be committed first.
    stored = supervisor.state.get_json(PENDING_SENSOR_BATCHES_KEY)['file_watch_sensor']['assessments']
    assert stored[1]['event']['kind'] == 'file.observed'
    pool.futures[0].set_result(worker._incomplete(pool.requests[0], 'observed-version-changed'))
    monkeypatch.setattr(supervisor, '_handle_assessment', lambda _: None)
    assert supervisor._drain_sensor_backlog(2) == 2
    assert supervisor._inspections.gap_count() == 0


def test_gap_saturation_keeps_sticky_incomplete_signal(pending):
    supervisor, event, pool = pending
    queue = supervisor._inspections
    with supervisor.state.lock():
        for index in range(MAX_GAPS + 1):
            changed = replace(event, subject=f'path-{index}', facts={'path': f'path-{index}'})
            queue._update_gap_locked(worker.failure_event(changed, 'content-unavailable'))
    value = queue.gaps()
    assert len(value['entries']) == MAX_GAPS and value['overflow'] is True
    with supervisor.state.lock():
        for entry in list(value['entries'].values()):
            queue._update_gap_locked(replace(event, subject=entry['path'],
                                            facts={'path': entry['path'], 'inspection_complete': True}))
    assert queue.gap_count() == 1


@pytest.mark.parametrize('alter', [
    lambda value: value.update(nonce='0'*32),
    lambda value: value.update(path='different.zip'),
    lambda value: value.update(status=[]),
    lambda value: value['facts'].update(content_parser_isolated=False),
    lambda value: value['facts']['content_parser_sandbox'].update(integrity='medium'),
])
def test_invalid_reply_is_never_accepted_as_complete(pending, alter):
    supervisor, event, pool = pending
    supervisor._drain_sensor_backlog(2)
    complete(pool)
    response = pool.futures[0].result()
    alter(response)
    with pytest.raises(WorkerError):
        worker.validate_result(pool.requests[0], response, event)


def test_native_worker_checks_version_before_content_read(pending, monkeypatch):
    supervisor, event, pool = pending
    request = worker.request_for(event, supervisor.config.files, '1'*32)
    Path(request['path']).write_bytes(b'changed content')
    monkeypatch.setattr(FileScanner, 'inspect', lambda *_: pytest.fail('changed file read'))
    result = worker.process_request(request)
    assert result['status'] == 'incomplete'
    assert result['facts']['inspection_error'] == 'observed-version-changed'


def test_native_worker_rejects_change_after_parser(pending, monkeypatch):
    supervisor, event, pool = pending
    request = worker.request_for(event, supervisor.config.files, '1'*32)
    def parser(_scanner, path):
        path.write_bytes(b'replaced while inspection ran')
        return SecurityEvent(kind='file.scanned', source='file_scanner', subject=str(path),
                             facts={'path': str(path), 'content_parser_status': 'ok', 'sha256': 'untrusted'})
    monkeypatch.setattr(FileScanner, 'inspect', parser)
    result = worker.process_request(request)
    assert result['facts'] == {'inspection_complete': False, 'inspection_error': 'inspection-version-changed'}


def test_worker_receives_no_action_store_or_ambient_secret(pending, monkeypatch):
    supervisor, event, pool = pending
    monkeypatch.setenv('MONARCH_API_KEY', 'fixture-secret')
    monkeypatch.setenv('PYTHONPATH', 'fixture-untrusted')
    from monarch_security.file_parser_worker import _worker_environment
    environment = _worker_environment()
    assert 'MONARCH_API_KEY' not in environment and 'fixture-untrusted' not in environment['PYTHONPATH']
    request = worker.request_for(event, supervisor.config.files, '1'*32)
    assert set(request) == {'schema', 'nonce', 'event_id', 'path', 'version', 'config'}
    assert 'state_path' not in request['config']
