from __future__ import annotations

from dataclasses import asdict, replace
import json
import time

import pytest

from monarch_security.config import NetworkConfig, PersistenceConfig, PostureConfig
from monarch_security.events import SecurityEvent
from monarch_security.sensor_worker import construct, request_for, restore, snapshot, validate_result, worker_launch
from monarch_security.sensors import (ProcessSensor, DeviceSensor, InstallSensor, FileChangeSensor,
                                      TamperSensor, NetworkSensor, PersistenceSensor, PostureSensor)
from monarch_security.supervisor import _ScheduledSensor
from monarch_security.worker_transport import ProcessWorkerPool, WorkerError
from test_supervisor_backlog import _config, _supervisor
from test_worker_transport import complete


def test_all_sensor_contracts_roundtrip_without_os_polling(tmp_path):
    sensors = {
        'process_sensor': ProcessSensor(), 'device_sensor': DeviceSensor(initial_seen={'synthetic'}),
        'install_sensor': InstallSensor(initial_seen={'synthetic'}),
        'file_watch_sensor': FileChangeSensor([tmp_path], recursive=True, max_entries_per_tick=3),
        'tamper_sensor': TamperSensor([tmp_path / 'synthetic.txt']),
        'network_sensor': NetworkSensor(NetworkConfig()),
        'persistence_sensor': PersistenceSensor(PersistenceConfig(), approved_signatures={'fixture': 'hash'}),
        'posture_sensor': PostureSensor(PostureConfig()),
    }
    sensors['process_sensor']._seen = {12, 34}
    sensors['network_sensor']._overflow_detail = {'connection': {'observed': 400, 'configured_threshold': 300}}
    for name, sensor in sensors.items():
        request = json.loads(json.dumps(request_for(name, sensor)))
        rebuilt = construct(request)
        assert request_for(name, rebuilt) == request
    assert sensors['process_sensor']._seen == {12, 34}


def test_real_file_worker_checkpoint_continuity_and_no_lost_event(tmp_path):
    watched = tmp_path / 'watched'
    watched.mkdir()
    path = watched / 'fixture.txt'
    path.write_text('initial')
    sensor = FileChangeSensor([watched], recursive=False, max_entries_per_tick=10)
    command, environment, cwd = worker_launch()
    pool = ProcessWorkerPool(command, environment=environment, cwd=cwd, capacity=1)
    try:
        initial = complete(pool, pool.submit(request_for('file_watch_sensor', sensor)))
        assert validate_result('file_watch_sensor', sensor, initial) == []
        restore(sensor, initial['state'])
        path.write_text('changed synthetic fixture')
        request = request_for('file_watch_sensor', sensor)
        changed = complete(pool, pool.submit(request))
        events = validate_result('file_watch_sensor', sensor, changed)
        assert len(events) == 1 and events[0].subject == str(path)
        # Controller has not acknowledged this response: retry old state replays it.
        replay = complete(pool, pool.submit(request))
        assert len(validate_result('file_watch_sensor', sensor, replay)) == 1
        restore(sensor, changed['state'])
        final = complete(pool, pool.submit(request_for('file_watch_sensor', sensor)))
        assert validate_result('file_watch_sensor', sensor, final) == []
    finally:
        pool.close()


def test_raw_process_facts_only_in_transit():
    sensor = ProcessSensor()
    event = SecurityEvent(kind='process.started', source='process_sensor', subject='synthetic.exe',
                          facts={'cmdline': ['synthetic.exe', '--token', 'synthetic-secret']})
    reply = {'schema': 2, 'sensor': 'process_sensor', 'state': snapshot(sensor), 'events': [asdict(event)], 'backend': 'psutil',
             'observation': {'status': 'complete', 'reasons': []}}
    received = validate_result('process_sensor', sensor, reply)[0]
    assert received.facts['cmdline'][-1] == 'synthetic-secret'
    assert 'synthetic-secret' not in json.dumps(received.to_dict())


@pytest.mark.parametrize('mutation', ['name', 'extra', 'checkpoint', 'backend', 'source'])
def test_invalid_result_never_mutates_checkpoint(mutation):
    sensor = PostureSensor(PostureConfig(), initial_signatures={'fixture': 'original'})
    before = snapshot(sensor)
    reply = {'schema': 2, 'sensor': 'posture_sensor', 'state': snapshot(sensor), 'events': [], 'backend': None,
             'observation': {'status': 'complete', 'reasons': []}}
    if mutation == 'name': reply['sensor'] = 'process_sensor'
    if mutation == 'extra': reply['authority'] = 'allow'
    if mutation == 'checkpoint': reply['state']['_signatures'] = {'fixture': 42}
    if mutation == 'backend': reply['backend'] = 'psutil'
    if mutation == 'source':
        reply['events'] = [asdict(SecurityEvent(kind='process.started', source='process_sensor', subject='fixture'))]
    with pytest.raises(WorkerError):
        validate_result('posture_sensor', sensor, reply)
    assert snapshot(sensor) == before


def test_worker_environment_does_not_inherit_credentials(monkeypatch):
    monkeypatch.setenv('MONARCH_SECURITY_LAUNCH_ID', 'synthetic')
    monkeypatch.setenv('OPENAI_API_KEY', 'synthetic-secret')
    monkeypatch.setenv('PYTHONPATH', 'untrusted-ambient-path')
    command, environment, cwd = worker_launch()
    assert 'OPENAI_API_KEY' not in environment
    assert 'MONARCH_SECURITY_LAUNCH_ID' not in environment
    assert 'untrusted-ambient-path' not in environment['PYTHONPATH']
    assert '-S' in command


def test_profile_change_discards_completed_old_generation(tmp_path, monkeypatch):
    from test_background_runtime import _ControlledWorkers
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    sensor = PostureSensor(supervisor.config.posture, initial_signatures={'fixture': 'original'})
    supervisor.sensors = [_ScheduledSensor('posture_sensor', sensor, 1)]
    old = _ControlledWorkers()
    supervisor._workers = old
    supervisor._dispatch_polls(time.monotonic())
    assert old.futures[0].done()
    monkeypatch.setattr('monarch_security.supervisor.read_security_profile',
                        lambda config: replace(supervisor.profile, level='off'))
    monkeypatch.setattr(supervisor, '_new_workers', lambda: _ControlledWorkers())
    monkeypatch.setattr(supervisor, '_build_sensors', lambda: [_ScheduledSensor('posture_sensor', sensor, 1)])
    supervisor._refresh_runtime_settings()
    supervisor._collect_polls()
    assert not old.available
    assert not supervisor._polls
    assert supervisor.state.get_dict('known_posture_signatures') == {}
    assert 'last_success_at' not in supervisor._sensor_health['posture_sensor']


def test_failed_worker_leaves_controller_snapshot_unchanged(tmp_path):
    from test_background_runtime import _ControlledWorkers
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    sensor = PostureSensor(supervisor.config.posture, initial_signatures={'fixture': 'original'})
    supervisor.sensors = [_ScheduledSensor('posture_sensor', sensor, 1)]
    workers = _ControlledWorkers(pending='posture_sensor')
    supervisor._workers = workers
    supervisor._dispatch_polls(time.monotonic())
    workers.futures[0].set_exception(WorkerError('worker-timeout'))
    supervisor._collect_polls()
    assert sensor.signatures == {'fixture': 'original'}
    assert supervisor.state.get_dict('known_posture_signatures') == {}
    assert supervisor.sensor_health()['posture_sensor']['state'] == 'failed'


def test_real_supervisor_stop_cancels_hung_sensor_without_blocking_heartbeat(tmp_path, monkeypatch):
    import sys
    from test_worker_transport import alive
    script = tmp_path / 'synthetic-sensors.py'
    pid_file = tmp_path / 'hung.pid'
    script.write_text('''import json, os, sys, time
for line in sys.stdin:
    message = json.loads(line)
    request = message['payload']
    if request['sensor'] == 'tamper_sensor':
        with open(sys.argv[1], 'w') as stream: stream.write(str(os.getpid()))
        time.sleep(300)
    message['payload'] = {'schema': 2, 'sensor': request['sensor'], 'state': request['state'], 'events': [], 'backend': None, 'observation': {'status': 'complete', 'reasons': []}}
    print(json.dumps(message), flush=True)
''', encoding='utf-8')
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    supervisor.sensors = [
        _ScheduledSensor('tamper_sensor', TamperSensor([]), 10),
        _ScheduledSensor('file_watch_sensor', FileChangeSensor([], recursive=False, max_entries_per_tick=10), 10),
    ]
    _, environment, _ = worker_launch()
    pool = ProcessWorkerPool([sys._base_executable, '-S', '-u', str(script), str(pid_file)],
                             environment=environment, cwd=str(tmp_path), capacity=2)
    monkeypatch.setattr(supervisor, '_new_workers', lambda: pool)
    started = time.monotonic()
    assert supervisor.run(duration=1.5) == 0
    assert time.monotonic() - started < 6
    assert pid_file.exists()
    assert not alive(int(pid_file.read_text()))
    assert supervisor.sensor_health()['file_watch_sensor']['state'] == 'healthy'
    assert 'last_success_at' not in supervisor.sensor_health()['tamper_sensor']
    assert not supervisor._polls
    assert json.loads(supervisor.config.runtime.heartbeat_path.read_text())['status'] == 'stopped'


def test_dispatch_prioritizes_oldest_due_sensor(tmp_path):
    from test_background_runtime import _ControlledWorkers
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    supervisor.sensors = [
        _ScheduledSensor('posture_sensor', PostureSensor(PostureConfig()), 1, 10),
        _ScheduledSensor('network_sensor', NetworkSensor(NetworkConfig()), 1, 0),
    ]
    workers = _ControlledWorkers()
    original_submit = workers.submit
    def submit(request):
        workers.available = False
        return original_submit(request)
    workers.submit = submit
    supervisor._workers = workers
    supervisor._dispatch_polls(time.monotonic())
    assert list(supervisor._polls) == ['network_sensor']
