from pathlib import Path
import json
import os
import subprocess
import sys
import time

import pytest

from monarch_security import control
from monarch_security.process_identity import ProcessProbe, probe_process
from monarch_security.runtime_guard import (ControllerGuardian, ProgressReporter,
    WorkerError, launch_environment, validate_request)
from monarch_security.runtime_lock import RuntimeLock, lock_is_held
from test_supervisor_backlog import _config


def request(config_path=None):
    return {'schema': 1, 'launch_id': '1' * 32, 'config_path': str(config_path) if config_path else None, 'no_llm': True}


def wait_for(predicate, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.025)
    raise AssertionError('owned fixture did not reach expected state')


def native_config(tmp_path, monkeypatch):
    from monarch_security.background import RUNTIME_PATH_KEYS
    from monarch_security.config import load_config
    for key in RUNTIME_PATH_KEYS:
        monkeypatch.delenv(key, raising=False)
    _config(tmp_path, max_events_per_tick=2)
    path = tmp_path / 'monarch_security.toml'
    path.write_text(path.read_text() + '\nself_protection_enabled = false\nemergency_auto_lock_enabled = false\n'
                    '\n[notifications]\nenabled = false\n')
    config = load_config(path)
    assert config.runtime.state_path.is_relative_to(tmp_path)
    return config, path


def fixture_script(tmp_path):
    script = tmp_path / 'inert-controller.py'
    script.write_text('''import json, os, subprocess, sys, time
from monarch_security.runtime_guard import ProgressReporter
req = json.loads(sys.stdin.buffer.readline())
descendant = subprocess.Popen([sys._base_executable, '-c', 'import time; time.sleep(300)'])
with open(sys.argv[1], 'w') as stream:
    json.dump({'controller': os.getpid(), 'descendant': descendant.pid}, stream)
reporter = ProgressReporter(req, sys.stdout.buffer)
reporter.emit('started')
if sys.argv[2] == 'replay':
    reporter.sequence = 0
    reporter.emit('started')
elif sys.argv[2] == 'oversize':
    sys.stdout.buffer.write(b'x' * 513)
    sys.stdout.buffer.flush()
elif sys.argv[2] == 'duplicate':
    print('{"schema":1,"schema":1}', flush=True)
elif sys.argv[2] == 'wrong-owner':
    reporter.launch_id = '0' * 32
    reporter.last_tick = 0
    reporter.emit('tick')
elif sys.argv[2] == 'valid':
    for _ in range(12):
        time.sleep(.2)
        reporter.emit('tick')
    reporter.emit('finished')
    raise SystemExit(0)
time.sleep(300)
''', encoding='utf-8')
    return script


@pytest.mark.parametrize('mutation', ['extra', 'boolean-schema', 'relative-path', 'bad-nonce', 'bad-no-llm'])
def test_guardian_request_rejects_authority_and_unbounded_routes(mutation):
    value = request()
    if mutation == 'extra': value['startup_seconds'] = 99999
    if mutation == 'boolean-schema': value['schema'] = True
    if mutation == 'relative-path': value['config_path'] = 'outside.toml'
    if mutation == 'bad-nonce': value['launch_id'] = 'bad'
    if mutation == 'bad-no-llm': value['no_llm'] = 'false'
    with pytest.raises(WorkerError, match='request-invalid'):
        validate_request(value)


def test_guardian_environment_strips_credentials_and_ambient_python_path(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'synthetic-secret')
    monkeypatch.setenv('PYTHONPATH', 'untrusted-directory')
    monkeypatch.setenv('MONARCH_SECURITY_LAUNCH_ID', 'ambient-not-owner')
    value = launch_environment()
    assert 'OPENAI_API_KEY' not in value and 'MONARCH_SECURITY_LAUNCH_ID' not in value
    assert 'untrusted-directory' not in value['PYTHONPATH']
    assert value['MONARCH_SECURITY_SITE_PACKAGES']


def test_incarnation_and_existing_lock_probe_are_native_and_read_only(tmp_path):
    current = probe_process(os.getpid())
    assert current.state == 'alive' and current.started
    assert probe_process(os.getpid()) == current
    assert probe_process(99999999).state == 'dead'
    marker = tmp_path / 'runtime.owner'
    assert lock_is_held(marker) is False and not marker.exists()
    with RuntimeLock(marker):
        assert lock_is_held(marker) is True
    assert lock_is_held(marker) is False


@pytest.mark.parametrize('mode', ['hang', 'replay', 'oversize', 'duplicate', 'wrong-owner', 'valid'])
def test_native_guardian_owns_and_reaps_controller_and_descendant(tmp_path, monkeypatch, mode):
    pid_path = tmp_path / 'pids.json'
    guardian = ControllerGuardian(request(), command=[sys._base_executable, '-S', '-u',
        str(fixture_script(tmp_path)), str(pid_path), mode], startup_seconds=4,
        progress_seconds=1 if mode != 'valid' else 2)
    monkeypatch.setattr('monarch_security.runtime_guard.time.time', lambda: -10**9)
    try:
        if mode == 'valid':
            assert guardian.run() == 0
        else:
            with pytest.raises(WorkerError, match='loop-stalled|progress-invalid'):
                guardian.run()
        assert guardian.closed
        pids = json.loads(pid_path.read_text())
        wait_for(lambda: all(probe_process(pid).state == 'dead' for pid in pids.values()))
        # Repeated close must never signal a potentially reused group/PID.
        guardian.close()
    finally:
        guardian.close()


@pytest.mark.skipif(os.name != 'nt', reason='Windows Job kill-on-close acceptance')
def test_abrupt_guardian_death_reaps_owned_native_tree(tmp_path):
    child = fixture_script(tmp_path)
    pids = tmp_path / 'pids.json'
    script = tmp_path / 'inert-guardian.py'
    script.write_text('''import json, sys
from monarch_security.runtime_guard import ControllerGuardian
request = json.loads(sys.stdin.buffer.readline())
ControllerGuardian(request, command=[sys._base_executable, '-S', '-u', sys.argv[1], sys.argv[2], 'hang']).run()
''', encoding='utf-8')
    guardian = subprocess.Popen([sys._base_executable, '-S', '-u', str(script), str(child), str(pids)],
        env=launch_environment(), stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        guardian.stdin.write((json.dumps(request()) + '\n').encode())
        guardian.stdin.close()
        wait_for(pids.exists)
        owned = json.loads(pids.read_text())
        assert all(probe_process(pid).state == 'alive' for pid in owned.values())
        guardian.kill()  # Exact held Popen handle; never taskkill/PID search.
        guardian.wait(timeout=4)
        wait_for(lambda: all(probe_process(pid).state == 'dead' for pid in owned.values()))
    finally:
        if guardian.poll() is None:
            guardian.kill()
            guardian.wait(timeout=4)


def test_actual_cli_start_has_guardian_and_authenticated_stop_leaves_no_tree(tmp_path, monkeypatch):
    from monarch_security.pin import SecurityPinManager
    import uuid
    config, config_path = native_config(tmp_path, monkeypatch)
    synthetic_pin = '582731'
    SecurityPinManager(config.runtime.security_pin_path, config.runtime.integrity_key_path).set_pin(synthetic_pin)
    result = subprocess.run([sys._base_executable, '-S', '-u', '-m', 'monarch_security',
        '--config', str(config_path), 'start', '--no-llm'], env=launch_environment(),
        capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    assert result.returncode == 0, result.stderr.decode('utf-8', errors='replace')
    started = json.loads(result.stdout.splitlines()[-1])
    try:
        assert started['started'], started
        status = control.protector_status(config, cleanup_stale=False)
        assert status['running'] and status['process_identity_verified']
        assert status['heartbeat']['guardian']['pid'] == started['launch_pid']
        assert status['pid'] != started['launch_pid']
        stop = subprocess.run([sys._base_executable, '-S', '-u', '-m', 'monarch_security',
            '--config', str(config_path), 'stop', '--confirm', '--wait', '8', '--request-stdin'],
            input=(json.dumps({'pin': synthetic_pin, 'purpose': 'security.protection.stop',
                              'request_id': str(uuid.uuid4())}) + '\n').encode(),
            env=launch_environment(), capture_output=True, timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        assert stop.returncode == 0, stop.stderr.decode('utf-8', errors='replace')
        stopped = json.loads(stop.stdout.splitlines()[-1])
        assert stopped['authenticated'] and not stopped['running']
        wait_for(lambda: probe_process(started['launch_pid']).state == 'dead')
        assert probe_process(started['pid']).state == 'dead'
        assert lock_is_held(config.runtime.pid_path.with_suffix('.guardian')) is False
    finally:
        control.stop_protector(config_path, wait_seconds=8)


def test_reused_pid_without_runtime_owner_cannot_block_restart_or_report_protected(tmp_path):
    config = _config(tmp_path, max_events_per_tick=2)
    config.runtime.pid_path.parent.mkdir(parents=True, exist_ok=True)
    config.runtime.pid_path.write_text(str(os.getpid()))
    status = control.protector_status(config)
    assert not status['running'] and status['stale_markers_cleaned']
    assert probe_process(os.getpid()).state == 'alive'


def test_cleanup_never_removes_markers_under_live_runtime_owner(tmp_path):
    config = _config(tmp_path, max_events_per_tick=2)
    config.runtime.pid_path.parent.mkdir(parents=True, exist_ok=True)
    config.runtime.pid_path.write_text('99999999')
    with RuntimeLock(config.runtime.pid_path.with_suffix('.owner')):
        assert control._cleanup_stale_runtime_markers(config) is False
        assert config.runtime.pid_path.read_text() == '99999999'


@pytest.mark.parametrize('paused', [False, True])
def test_actual_background_default_deadline_recovers_queue_and_respects_pause(tmp_path, monkeypatch, paused):
    import psutil
    import zipfile
    from monarch_security import background
    from monarch_security.config import load_config
    from monarch_security.events import SecurityEvent, utc_now
    from monarch_security.inspection_worker import file_version
    from monarch_security.analysis import RuleEngine
    from monarch_security.state import StateStore
    from monarch_security.supervisor import PENDING_SENSOR_BATCHES_KEY
    from test_supervisor_backlog import _supervisor
    config, path = native_config(tmp_path, monkeypatch)
    watched = tmp_path / 'watched'
    watched.mkdir()
    target = watched / 'inert.zip'
    with zipfile.ZipFile(target, 'w') as archive:
        archive.writestr('readme.txt', b'Inert durable guardian recovery fixture')
    path.write_text(path.read_text().replace('[file_watch]\nenabled = false',
        "[file_watch]\nenabled = true\npaths = ['" + watched.as_posix() + "']"))
    config = load_config(path)
    preparer = _supervisor(config)
    background.write_background(config, enabled=True, requested=True, startup_registered=False)
    host = subprocess.Popen([sys._base_executable, '-S', '-u', '-m', 'monarch_security',
        '--config', str(path), 'background-host'], env=launch_environment(),
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    source = SecurityEvent(kind='file.observed', source='file_watch_sensor', subject=str(target),
        facts={'path': str(target), 'extension': '.zip', **file_version(target)})
    old = None
    try:
        wait_for(lambda: control.protector_status(config, cleanup_stale=False)['process_identity_verified'], timeout=10)
        old = control.protector_status(config, cleanup_stale=False)
        old_guardian = old['heartbeat']['guardian']['pid']
        child_started = old['heartbeat']['process_started']
        guardian_started = old['heartbeat']['guardian']['process_started']
        store = StateStore(config.runtime.state_path, config.runtime.integrity_key_path, require_existing_key=True)
        with store.lock():
            # Owning the writer lock guarantees suspension cannot freeze its
            # current owner mid-write. This changes only synthetic fixture state.
            process = psutil.Process(old['pid'])
            assert probe_process(old['pid']).started == child_started
            process.suspend()
            sensor = next(s for s in preparer.sensors if s.name == 'file_watch_sensor')
            checkpoint = preparer._capture_sensor_checkpoint(sensor.name, sensor.sensor)
            store.set_json(PENDING_SENSOR_BATCHES_KEY, {'file_watch_sensor': {
                'schema': 1, 'sensor': 'file_watch_sensor', 'queued_at': utc_now(), 'next_index': 0,
                'assessments': [RuleEngine(config.router).assess(source).to_dict()], 'checkpoint': checkpoint}})
        if paused:
            result = control.stop_protector(path, wait_seconds=0)
            assert result['durable_pause_requested'] and result['running']
        wait_for(lambda: probe_process(old['pid']).started != child_started, timeout=52)
        wait_for(lambda: probe_process(old_guardian).started != guardian_started)
        if paused:
            time.sleep(6)
            assert not control.protector_status(config, cleanup_stale=False)['running']
            assert background.read_background(config)['requested'] is False
            fresh = StateStore(config.runtime.state_path, config.runtime.integrity_key_path, require_existing_key=True)
            assert fresh.get_json(PENDING_SENSOR_BATCHES_KEY)['file_watch_sensor']['next_index'] == 0
        else:
            def processed():
                fresh = StateStore(config.runtime.state_path, config.runtime.integrity_key_path, require_existing_key=True)
                return not fresh.get_json(PENDING_SENSOR_BATCHES_KEY, {})
            wait_for(processed, timeout=16)
            status = control.protector_status(config, cleanup_stale=False)
            assert status['running'] and status['process_identity_verified']
            assert status['heartbeat']['launch_id'] != old['heartbeat']['launch_id']
            decisions = [json.loads(line) for line in config.runtime.audit_log_path.read_text().splitlines()
                         if json.loads(line).get('kind') == 'decision']
            matching = [row for row in decisions if row['assessment']['event']['event_id'] == source.event_id]
            assert len(matching) == 1
            assert matching[0]['assessment']['event']['facts']['inspection_complete'] is True
            wait_for(lambda: background.background_status(config)['restart_count'] >= 2)
    finally:
        preparer._cancel_polls()
        background.write_background(config, enabled=False, requested=False)
        status = control.protector_status(config, cleanup_stale=False)
        if status['running'] and old and probe_process(old['pid']).started == old['heartbeat']['process_started']:
            psutil.Process(old['pid']).resume()
        control.stop_protector(path, wait_seconds=8)
        if host.poll() is None:
            host.kill()
            host.wait(timeout=4)


def test_native_authorized_stop_intent_survives_busy_start_lifecycle(tmp_path, monkeypatch):
    from monarch_security import background
    config, path = native_config(tmp_path, monkeypatch)
    started = control.start_protector(path, no_llm=True)
    try:
        assert started['started'], started
        with RuntimeLock(config.runtime.pid_path.with_suffix('.lifecycle')):
            stopped = control.stop_protector(path, wait_seconds=0)
            assert stopped['reason'] == 'lifecycle-busy' and stopped['durable_pause_requested']
            assert stopped['stop_requested'] is False
            assert background.read_background(config)['requested'] is False
            wait_for(lambda: probe_process(started['pid']).state == 'dead', timeout=5)
        wait_for(lambda: probe_process(started['launch_pid']).state == 'dead')
    finally:
        control.stop_protector(path, wait_seconds=8)


@pytest.mark.skipif(os.name != 'nt', reason='Windows poisoned held-job ownership acceptance')
def test_native_cleanup_failure_keeps_guardian_lock_and_blocks_replacement(tmp_path, monkeypatch):
    config, path = native_config(tmp_path, monkeypatch)
    script = tmp_path / 'inert-cleanup-failure.py'
    script.write_text('''from monarch_security import runtime_guard
from monarch_security.owned_process import WindowsJob
from monarch_security.worker_errors import WorkerError
def fail_cleanup(self, timeout):
    raise WorkerError('worker-job-cleanup-incomplete')
WindowsJob.wait_empty = fail_cleanup
raise SystemExit(runtime_guard.main())
''', encoding='utf-8')
    guardian = subprocess.Popen([sys._base_executable, '-S', '-u', str(script)],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=launch_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        guardian.stdin.write((json.dumps(request(path)) + '\n').encode())
        guardian.stdin.close()
        wait_for(lambda: control.protector_status(config, cleanup_stale=False)['process_identity_verified'])
        stopped = control.stop_protector(path, wait_seconds=8)
        assert not stopped['running']
        assert guardian.poll() is None
        assert lock_is_held(config.runtime.pid_path.with_suffix('.guardian')) is True
        replacement = control.start_protector(path, no_llm=True)
        assert replacement['started'] is False and not replacement['running']
        assert guardian.poll() is None
        assert lock_is_held(config.runtime.pid_path.with_suffix('.guardian')) is True
    finally:
        control.stop_protector(path, wait_seconds=0)
        if guardian.poll() is None:
            guardian.kill()
            guardian.wait(timeout=4)
