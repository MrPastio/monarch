from __future__ import annotations

import os
from pathlib import Path
import sys
import time

import pytest

from monarch_security.config import FileConfig
from monarch_security.events import SecurityEvent
from monarch_security import file_parser_worker as parser
from test_worker_transport import alive


SYNTHETIC = r'''
import json, os, subprocess, sys, time
message = json.loads(sys.stdin.buffer.readline())
payload = message['payload']
def phase(name):
    print(json.dumps({'schema': 1, 'id': message['id'], 'phase': name}), flush=True)
MODE
'''


def use_fixture(tmp_path, monkeypatch, body):
    script = tmp_path / 'parser-fixture.py'
    script.write_text(SYNTHETIC.replace('MODE', body), encoding='utf-8')
    monkeypatch.setattr(parser, '_parser_command', lambda: [sys._base_executable, '-S', '-u', str(script)])


def test_hanging_parser_and_descendant_are_reaped_before_failure_returns(tmp_path, monkeypatch):
    pid_file = tmp_path / 'owned-processes.pid'
    use_fixture(tmp_path, monkeypatch, r'''
phase('request-validated')
phase('sandbox-ready')
child = subprocess.Popen([sys.executable, '-S', '-c', 'import time; time.sleep(300)'])
with open(payload['path'], 'w') as stream:
    stream.write(str(os.getpid()) + ',' + str(child.pid))
phase('inspect-started')
time.sleep(300)
''')
    started = time.monotonic()
    event = parser.inspect_file_isolated(pid_file, FileConfig(parser_timeout_seconds=2))
    assert time.monotonic() - started < 6
    assert event.facts['content_parser_status'] == 'timeout'
    assert event.facts['content_parser_phase'] == 'inspect-started'
    assert pid_file.exists(), 'No descendant was started; lifecycle was not exercised'
    assert all(not alive(int(pid)) for pid in pid_file.read_text().split(','))


@pytest.mark.parametrize('output', [
    "sys.stdout.buffer.write(b'x' * (1024 * 1024 + 1)); sys.stdout.buffer.flush()",
    "print('{\"schema\":1,\"schema\":1,\"id\":1,\"payload\":{}}', flush=True)",
    "print('{\"schema\":1,\"id\":2,\"payload\":{}}', flush=True)",
    "phase('sandbox-ready')",
    "phase('request-validated'); phase('request-validated')",
    "print(json.dumps({'schema': 1, 'id': message['id'], 'payload': {'schema': 2, 'ok': True}}), flush=True)",
])
def test_bad_parser_output_is_bounded_and_reaped(tmp_path, monkeypatch, output):
    pid_file = tmp_path / 'owned-parser.pid'
    use_fixture(tmp_path, monkeypatch, "with open(payload['path'], 'w') as stream: stream.write(str(os.getpid()))\n"
                + output + '\ntime.sleep(300)')
    started = time.monotonic()
    event = parser.inspect_file_isolated(pid_file, FileConfig(parser_timeout_seconds=2))
    assert time.monotonic() - started < 6
    assert event.facts['content_parser_status'] == 'protocol_error'
    assert not alive(int(pid_file.read_text()))


def test_progress_does_not_extend_the_parser_deadline(tmp_path, monkeypatch):
    use_fixture(tmp_path, monkeypatch, r'''
for name in ('request-validated', 'sandbox-ready', 'inspect-started', 'inspect-finished'):
    phase(name)
    time.sleep(0.4)
time.sleep(300)
''')
    started = time.monotonic()
    event = parser.inspect_file_isolated(tmp_path / 'fixture.zip', FileConfig(parser_timeout_seconds=0.9))
    assert event.facts['content_parser_status'] == 'timeout'
    assert event.facts['content_parser_phase'] in {'request-validated', 'sandbox-ready', 'inspect-started'}
    assert time.monotonic() - started < 2.5


def test_parser_memory_limit_is_enforced_by_parent_owned_job(tmp_path, monkeypatch):
    if os.name != 'nt':
        pytest.skip('Native Windows job memory contract')
    use_fixture(tmp_path, monkeypatch, r'''
try:
    allocation = bytearray(256 * 1024 * 1024)
    limited = False
except MemoryError:
    limited = True
print(json.dumps({'schema': 1, 'id': message['id'], 'payload': {'limited': limited}}), flush=True)
sys.stdin.buffer.read(1)
''')
    response = parser._run_parser_request({'path': str(tmp_path / 'fixture')}, 3, 128 * 1024 * 1024)
    assert response == {'limited': True}


def test_parser_launch_uses_base_interpreter_and_excludes_ambient_secrets(monkeypatch):
    monkeypatch.setenv('MONARCH_TEST_SECRET', 'synthetic-secret')
    monkeypatch.setenv('PYTHONPATH', 'synthetic-ambient-path')
    assert parser._parser_command()[0] == sys._base_executable
    environment = parser._worker_environment()
    assert 'MONARCH_TEST_SECRET' not in environment
    assert environment['PYTHONPATH'] == str(Path(parser.__file__).resolve().parents[1])


@pytest.mark.parametrize('field,value', [('kind', 'process.started'), ('source', 'process_sensor'),
                                       ('subject', 'unrelated'), ('facts', {'path': 'unrelated'})])
def test_parser_event_is_bound_to_requested_file(tmp_path, monkeypatch, field, value):
    path = tmp_path / 'requested.zip'
    event = SecurityEvent(kind='file.scanned', source='file_scanner', subject=str(path), facts={'path': str(path)}).to_dict()
    event[field] = value
    monkeypatch.setattr(parser, '_run_parser_request', lambda *args: {
        'schema': parser.PROTOCOL_SCHEMA, 'ok': True, 'event': event, 'sandbox': {
            'process': 'isolated-worker', 'integrity': 'low' if os.name == 'nt' else 'platform-default',
            'memory_limit': 'windows-job' if os.name == 'nt' else 'rlimit-as',
            'memory_limit_bytes': FileConfig().parser_memory_limit_bytes}})
    result = parser.inspect_file_isolated(path, FileConfig())
    assert result.facts['content_parser_status'] == 'protocol_error'
    assert result.facts['content_error'] == 'file parser event target is invalid'


def test_cleanup_failure_cannot_be_reported_as_success(monkeypatch, tmp_path):
    from concurrent.futures import Future
    from monarch_security.worker_transport import WorkerError
    class Pool:
        starts = 0
        def __init__(self, *args, **kwargs): Pool.starts += 1
        def submit(self, *args, **kwargs):
            future = Future()
            future.progress = parser.PARSER_PHASES[-1]
            future.set_result({'schema': 1, 'ok': True})
            return future
        def close(self): raise WorkerError('synthetic-cleanup-failed')
    monkeypatch.setattr(parser, 'ProcessWorkerPool', Pool)
    monkeypatch.setattr(parser, '_FAILED_PARSER_POOLS', [])
    event = parser.inspect_file_isolated(tmp_path / 'fixture.zip', FileConfig())
    assert event.facts['content_parser_status'] == 'worker_error'
    assert event.facts['content_error'] == 'worker-cleanup-incomplete'
    repeated = parser.inspect_file_isolated(tmp_path / 'fixture.zip', FileConfig())
    assert repeated.facts['content_error'] == 'worker-cleanup-unresolved'
    assert Pool.starts == 1


def test_parser_capacity_refuses_to_queue_work(monkeypatch, tmp_path):
    monkeypatch.setattr(parser, '_PARSER_ACTIVE', 3)
    monkeypatch.setattr(parser, '_parser_command', lambda: pytest.fail('Should not launch'))
    event = parser.inspect_file_isolated(tmp_path / 'fixture.zip', FileConfig())
    assert event.facts['content_error'] == 'worker-capacity-unavailable'


def test_relative_file_request_uses_callers_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    path = tmp_path / 'relative.txt'
    path.write_text('inert lifecycle fixture', encoding='utf-8')
    event = parser.inspect_file_isolated(Path('relative.txt'), FileConfig())
    assert event.subject == str(path)
    assert event.facts['content_parser_status'] == 'ok'
    assert event.facts['content_parser_phase'] == 'inspect-finished'


@pytest.mark.parametrize('response', [{'schema': 1, 'ok': True}, {'schema': True, 'ok': True},
                                     {'schema': 2, 'ok': 1}, {'schema': 2, 'ok': False, 'error': 'untyped'}])
def test_old_or_untyped_parser_response_is_rejected(tmp_path, monkeypatch, response):
    monkeypatch.setattr(parser, '_run_parser_request', lambda *args: response)
    event = parser.inspect_file_isolated(tmp_path / 'fixture.zip', FileConfig())
    assert event.facts['content_parser_status'] == 'protocol_error'
