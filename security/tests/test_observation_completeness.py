from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
import time

import pytest

from monarch_security.config import PersistenceConfig, PostureConfig
from monarch_security.observation import ObservationUnavailable, valid_observation, parse_query_json
from monarch_security.runtime_health import protection_state, validate_runtime_health
from monarch_security.sensor_worker import request_for, snapshot, validate_result, worker_launch
from monarch_security.sensors import DeviceSensor, FileChangeSensor, InstallSensor, PersistenceSensor, PostureSensor, ProcessSensor, TamperSensor
from monarch_security.supervisor import _ScheduledSensor
from monarch_security.worker_transport import ProcessWorkerPool, WorkerError
from test_worker_transport import complete
from test_supervisor_backlog import _config, _supervisor


def test_real_file_worker_preserves_baseline_when_root_missing_then_recovers(tmp_path):
    watched = tmp_path / 'watched'
    previous = str(watched / 'fixture.txt').lower()
    sensor = FileChangeSensor([watched], False, 10, initial_signatures={previous: 'old'})
    before = snapshot(sensor)
    command, environment, cwd = worker_launch()
    pool = ProcessWorkerPool(command, environment=environment, cwd=cwd, capacity=1)
    try:
        failed = complete(pool, pool.submit(request_for('file_watch_sensor', sensor)))
        assert validate_result('file_watch_sensor', sensor, failed) == []
        assert failed['observation'] == {'status': 'unavailable', 'reasons': ['watched-root-unavailable']}
        assert failed['state'] == before
        watched.mkdir()
        (watched / 'fixture.txt').write_text('new synthetic content')
        recovered = complete(pool, pool.submit(request_for('file_watch_sensor', sensor)))
        assert recovered['observation']['status'] == 'complete'
        assert len(validate_result('file_watch_sensor', sensor, recovered)) == 1
    finally:
        pool.close()


def test_failed_directory_read_does_not_prune_existing_signatures(tmp_path, monkeypatch):
    sensor = FileChangeSensor([tmp_path], True, 10, initial_signatures={'existing': 'old'})
    before = snapshot(sensor)
    def failed_walk(root, *, onerror):
        onerror(PermissionError('synthetic permission failure'))
        return iter(())
    monkeypatch.setattr('monarch_security.sensors.file_watch.os.walk', failed_walk)
    with pytest.raises(ObservationUnavailable):
        sensor.poll()
    assert snapshot(sensor) == before


def test_file_pagination_is_partial_until_end_of_cycle(tmp_path):
    for i in range(3):
        (tmp_path / f'fixture-{i}.txt').write_text('synthetic')
    sensor = FileChangeSensor([tmp_path], False, 2)
    assert sensor.poll() == []
    assert sensor.observation == {'status': 'partial', 'reasons': ['inventory-page-pending']}
    assert sensor.poll() == []
    assert sensor.observation == {'status': 'complete', 'reasons': []}


def test_tamper_permission_failure_cannot_become_missing_event(tmp_path, monkeypatch):
    target = tmp_path / 'self-file.py'
    target.write_text('synthetic')
    sensor = TamperSensor([target], initial_signatures={str(target): 'old'})
    before = snapshot(sensor)
    def deny(path):
        raise PermissionError('synthetic')
    monkeypatch.setattr('monarch_security.sensors.tamper._sha256', deny)
    with pytest.raises(ObservationUnavailable):
        sensor.poll()
    assert snapshot(sensor) == before


@pytest.mark.parametrize('sensor_type,module_name', [
    (InstallSensor, 'installs'), (PersistenceSensor, 'persistence'),
])
def test_registry_access_denied_is_not_an_empty_inventory(sensor_type, module_name, monkeypatch):
    def deny(*args):
        raise PermissionError('synthetic')
    fake = SimpleNamespace(HKEY_LOCAL_MACHINE=1, HKEY_CURRENT_USER=2, OpenKey=deny)
    monkeypatch.setattr(f'monarch_security.sensors.{module_name}.winreg', fake)
    sensor = sensor_type() if sensor_type is InstallSensor else sensor_type(PersistenceConfig())
    read = sensor.snapshot if sensor_type is InstallSensor else sensor._run_key_items
    with pytest.raises(ObservationUnavailable):
        read()


def test_absent_optional_registry_root_is_valid_empty_inventory(monkeypatch):
    def absent(*args):
        raise FileNotFoundError('synthetic')
    fake = SimpleNamespace(HKEY_LOCAL_MACHINE=1, HKEY_CURRENT_USER=2, OpenKey=absent)
    monkeypatch.setattr('monarch_security.sensors.installs.winreg', fake)
    sensor = InstallSensor()
    assert sensor.snapshot() == []
    assert sensor.observation['status'] == 'complete'


def test_registry_value_access_error_is_not_a_missing_optional_value(monkeypatch):
    def deny(*args):
        raise PermissionError('synthetic')
    monkeypatch.setattr('monarch_security.sensors.installs.winreg', SimpleNamespace(QueryValueEx=deny))
    with pytest.raises(PermissionError):
        InstallSensor._query_string(object(), 'DisplayName')


@pytest.mark.parametrize('data', [None, 42, [None], [{'InstanceId': False}], [{'InstanceId': ''}]])
def test_malformed_device_snapshot_never_updates_seen(data, monkeypatch):
    monkeypatch.setattr('monarch_security.sensors.devices.subprocess.run', lambda *a, **k: SimpleNamespace(
        returncode=0, stdout=json.dumps(data), stderr=''))
    sensor = DeviceSensor(initial_seen={'previous'})
    with pytest.raises(ObservationUnavailable):
        sensor.poll()
    assert sensor.seen_ids == {'previous'}


def firewall_profiles():
    return [{'kind': 'firewall_profile', 'subject': name, 'enabled': True} for name in ('Domain', 'Private', 'Public')]


def test_missing_defender_is_partial_and_keeps_previous_signature(monkeypatch):
    monkeypatch.setattr('monarch_security.sensors.posture._run_powershell_json', lambda *a, **k: (firewall_profiles(), None))
    sensor = PostureSensor(PostureConfig(), initial_signatures={'defender_status:microsoft defender': 'previous'})
    sensor.poll()
    assert sensor.observation == {'status': 'partial', 'reasons': ['defender-query-unavailable']}
    assert sensor.signatures['defender_status:microsoft defender'] == 'previous'


def test_invalid_posture_boolean_is_not_a_disabled_control(monkeypatch):
    profiles = firewall_profiles()
    profiles[0]['enabled'] = None
    monkeypatch.setattr('monarch_security.sensors.posture._run_powershell_json', lambda *a, **k: (profiles, None))
    sensor = PostureSensor(PostureConfig(), initial_signatures={'previous': 'old'})
    with pytest.raises(ObservationUnavailable):
        sensor.poll()
    assert sensor.signatures == {'previous': 'old'}


def test_worker_unavailable_response_cannot_ack_changed_state():
    sensor = PostureSensor(PostureConfig(), initial_signatures={'previous': 'old'})
    reply = {'schema': 2, 'sensor': 'posture_sensor', 'state': snapshot(sensor), 'events': [], 'backend': None,
             'observation': {'status': 'unavailable', 'reasons': ['query-unavailable']}}
    reply['state']['_signatures'] = {'changed': 'new'}
    with pytest.raises(WorkerError):
        validate_result('posture_sensor', sensor, reply)


def test_partial_observation_cannot_claim_protected_with_healthy_label():
    now = time.time()
    health = {'sensor': {'state': 'healthy', 'last_success_at': now, 'interval_seconds': 10,
                        'observation': {'status': 'partial', 'reasons': ['query-partial']}}}
    assert protection_state('running', health, {'queued': 0}) == 'degraded'
    assert not validate_runtime_health({'sensors': ['sensor'], 'sensor_count': 1, 'sensor_health': health,
                                       'status': 'running', 'updated_at': now, 'sensor_backlog': {'queued': 0}})


def test_controller_records_partial_poll_without_healthy_promotion(tmp_path):
    from test_background_runtime import _ControlledWorkers
    supervisor = _supervisor(_config(tmp_path, max_events_per_tick=2))
    sensor = PostureSensor(PostureConfig())
    supervisor.sensors = [_ScheduledSensor('posture_sensor', sensor, 1)]
    workers = _ControlledWorkers(pending='posture_sensor')
    supervisor._workers = workers
    supervisor._dispatch_polls(time.monotonic())
    reply = {'schema': 2, 'sensor': 'posture_sensor', 'state': snapshot(sensor), 'events': [], 'backend': None,
             'observation': {'status': 'partial', 'reasons': ['defender-query-unavailable']}}
    workers.futures[0].set_result(reply)
    supervisor._collect_polls()
    assert supervisor.sensor_health()['posture_sensor']['state'] == 'limited'
    supervisor._write_heartbeat('running')
    assert json.loads(supervisor.config.runtime.heartbeat_path.read_text())['protection_state'] == 'degraded'


@pytest.mark.parametrize('observation', [
    {'status': 'complete', 'reasons': ['failure']}, {'status': 'partial', 'reasons': []},
    {'status': 'unavailable', 'reasons': ['raw path C:\\private']}, {'status': True, 'reasons': []},
    {'status': 'partial', 'reasons': ['same', 'same']},
])
def test_observation_schema_rejects_ambiguous_or_raw_error_values(observation):
    assert not valid_observation(observation)


def baseline_args(**flags):
    values = dict(devices_only=False, installs_only=False, files_only=False, network_only=False,
                  persistence_only=False, posture_only=False, self_protection_only=False, expected_digest='')
    values.update(flags)
    return SimpleNamespace(**values)


def test_multi_sensor_baseline_failure_is_atomic(tmp_path, monkeypatch, capsys):
    from monarch_security.cli import _baseline
    from monarch_security.state import StateStore
    config = _config(tmp_path, max_events_per_tick=2)
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    state.set_list('known_devices', ['previous-device'])
    state.set_dict('known_file_signatures', {'previous-file': 'old'})
    state.save()
    before = config.runtime.state_path.read_bytes()
    valid_device = DeviceSensor()
    valid_device.snapshot = lambda: [{'instance_id': 'new-device'}]
    monkeypatch.setattr('monarch_security.cli.DeviceSensor', lambda **kwargs: valid_device)
    def failed_snapshot(self):
        raise ObservationUnavailable('registry-read-unavailable')
    monkeypatch.setattr(InstallSensor, 'snapshot', failed_snapshot)
    assert _baseline(baseline_args(), config) == 1
    assert json.loads(capsys.readouterr().out)['code'] == 'baseline-observation-incomplete'
    assert config.runtime.state_path.read_bytes() == before


def test_incomplete_persistence_cannot_be_approved_even_with_matching_digest(tmp_path, monkeypatch, capsys):
    from monarch_security.cli import _baseline, _persistence_baseline_preview
    from monarch_security.persistence_baseline import persistence_baseline_digest
    from monarch_security.state import StateStore
    config = _config(tmp_path, max_events_per_tick=2)
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    state.set_dict('approved_persistence_signatures', {'approved': 'previous'})
    state.save()
    before = config.runtime.state_path.read_bytes()
    sensor = PersistenceSensor(config.persistence)
    sensor.last_error = 'synthetic query timeout'
    sensor.snapshot_signatures = lambda: {}
    monkeypatch.setattr('monarch_security.cli.PersistenceSensor', lambda *args, **kwargs: sensor)
    assert _baseline(baseline_args(persistence_only=True, expected_digest=persistence_baseline_digest({})), config) == 1
    assert _persistence_baseline_preview(config) == 1
    assert config.runtime.state_path.read_bytes() == before
    output = capsys.readouterr().out
    assert 'synthetic query timeout' not in output
    assert 'baseline-observation-incomplete' in output


def test_partial_posture_baseline_preserves_previous_state(tmp_path, monkeypatch, capsys):
    from monarch_security.cli import _baseline
    from monarch_security.state import StateStore
    config = _config(tmp_path, max_events_per_tick=2)
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    state.set_dict('known_posture_signatures', {'previous': 'old'})
    state.save()
    before = config.runtime.state_path.read_bytes()
    sensor = PostureSensor(config.posture)
    sensor.limit_observation('defender-query-unavailable')
    sensor.snapshot_signatures = lambda: {'new': 'unverified'}
    monkeypatch.setattr('monarch_security.cli.PostureSensor', lambda *args, **kwargs: sensor)
    assert _baseline(baseline_args(posture_only=True), config) == 1
    assert config.runtime.state_path.read_bytes() == before


def test_process_detail_retries_do_not_repeat_incomplete_events():
    class Missing(Exception): pass
    class Denied(Exception): pass
    process = SimpleNamespace(
        as_dict=lambda **kwargs: dict(pid=42, name='fixture.exe', exe='E:\\fixture.exe', ppid=1, create_time=123),
        parent=lambda: None,
    )
    denied = [True]
    def command():
        if denied[0]: raise Denied()
        return ['fixture.exe', '--synthetic']
    process.cmdline = command
    sensor = ProcessSensor(include_existing=True)
    sensor._psutil = SimpleNamespace(NoSuchProcess=Missing, AccessDenied=Denied,
                                    process_iter=lambda attrs: [SimpleNamespace(info={'pid': 42, 'name': 'fixture.exe'})],
                                    Process=lambda pid: process)
    assert len(sensor.poll()) == 1
    assert sensor.observation['status'] == 'partial'
    assert sensor._pending_details == {42}
    assert sensor.poll() == []
    assert sensor.observation['status'] == 'partial'
    denied[0] = False
    events = sensor.poll()
    assert len(events) == 1 and events[0].facts['cmdline'] == ['fixture.exe', '--synthetic']
    assert sensor.observation['status'] == 'complete'
    assert sensor._pending_details == set()
    assert sensor.poll() == []


@pytest.mark.parametrize('output', ['{"value":1,"value":2}', '[NaN]', '[1e999]', '{invalid}', '[' * 1100])
def test_query_json_cannot_enter_baseline_with_ambiguous_fields(output):
    with pytest.raises(ObservationUnavailable):
        parse_query_json(output)


def test_old_worker_contract_is_rejected():
    from monarch_security.sensor_worker import construct
    sensor = PostureSensor(PostureConfig())
    request = request_for('posture_sensor', sensor)
    del request['schema']
    with pytest.raises(WorkerError):
        construct(request)
    old_reply = {'sensor': 'posture_sensor', 'state': snapshot(sensor), 'events': [], 'backend': None}
    with pytest.raises(WorkerError):
        validate_result('posture_sensor', sensor, old_reply)


@pytest.mark.skipif(os.name != 'nt', reason='Native Windows PowerShell adapter')
@pytest.mark.parametrize('fail_defender', [False, True])
@pytest.mark.parametrize('firewall_enabled', ['$true', '$false', "'NotConfigured'", '$null'])
def test_native_powershell_provider_error_is_not_silent_empty_success(fail_defender, firewall_enabled):
    from monarch_security.sensors.posture import _posture_snapshot_command, _run_powershell_json
    synthetic = r'''
function Get-NetFirewallProfile {
  [CmdletBinding()] param([string]$PolicyStore)
  if ($PolicyStore -ne 'ActiveStore') { throw 'synthetic-wrong-policy-store' }
  foreach ($name in @('Domain','Private','Public')) {
    [pscustomobject]@{ Name=$name; Enabled=FIREWALL_ENABLED; DefaultInboundAction='Block'; DefaultOutboundAction='Allow' }
  }
}
function Get-MpComputerStatus {
  [CmdletBinding()] param()
  DEFENDER_BODY
}
'''
    success_body = r'''[pscustomobject]@{
      AntivirusEnabled=$true; RealTimeProtectionEnabled=$true; BehaviorMonitorEnabled=$true;
      IoavProtectionEnabled=$true; AntispywareEnabled=$true; FullScanAge=0; QuickScanAge=0
    }'''
    body = "Write-Error 'synthetic-provider-unavailable'" if fail_defender else success_body
    command = synthetic.replace('DEFENDER_BODY', body).replace('FIREWALL_ENABLED', firewall_enabled)
    parsed, error = _run_powershell_json(command + _posture_snapshot_command(), timeout=15)
    if fail_defender or firewall_enabled not in ('$true', '$false'):
        assert error is not None
        assert parsed is None
    else:
        assert error is None
        assert len(parsed) == 4
        assert {item['kind'] for item in parsed} == {'firewall_profile', 'defender_status'}
        assert all(item['enabled'] is (firewall_enabled == '$true')
                   for item in parsed if item['kind'] == 'firewall_profile')


def test_network_signature_reassesses_when_process_identity_becomes_available():
    from monarch_security.sensors.network import _with_signature
    endpoint = dict(kind='connection', local_address='127.0.0.1', local_port=50000,
                    remote_address='192.0.2.1', remote_port=443, owning_process=42)
    missing = _with_signature(endpoint)
    enriched = _with_signature({**endpoint, 'process_name': 'fixture.exe', 'process_start_time': 123})
    assert missing['key'] == enriched['key']
    assert missing['signature'] != enriched['signature']


@pytest.mark.parametrize('health', [None, [], {'sensor': None}, {'sensor': {'state': []}},
                                  {'sensor': {'state': True}}, {'sensor': {'state': 'healthy'}}])
def test_invalid_or_unproven_coverage_is_always_degraded(health):
    assert protection_state('running', health, {'queued': 0}) == 'degraded'


def test_limited_tasklist_details_do_not_keep_exited_pids_forever():
    sensor = ProcessSensor(include_existing=True)
    sensor._psutil = None
    current = [dict(pid=42, name='fixture.exe')]
    sensor._snapshot_tasklist = lambda: iter(current)
    assert len(sensor.poll()) == 1
    assert sensor.observation['status'] == 'partial'
    current.clear()
    assert sensor.poll() == []
    assert sensor._seen == set()
    current.append(dict(pid=42, name='new-fixture.exe'))
    events = sensor.poll()
    assert len(events) == 1 and events[0].subject == 'new-fixture.exe'
