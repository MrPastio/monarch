from pathlib import Path
import os
import time

import pytest

from monarch_security import inspection_worker as worker
from monarch_security.config import FileConfig
from monarch_security.events import SecurityEvent
from monarch_security.worker_transport import WorkerError


def source_event(path):
    return SecurityEvent(kind='file.observed', source='file_watch_sensor', subject=str(path),
                         facts={'path': str(path), **worker.file_version(path)})


def test_owned_wrapper_runs_real_low_parser_and_bounded_signature_query(tmp_path):
    path = tmp_path / 'signature-fixture.ps1'
    path.write_bytes(b'# Read-only fixture. No execution.\n')
    source = source_event(path)
    pool = worker.new_pool()
    try:
        assert 'MONARCH_SECURITY_FILE_PARSER_WORKER' not in pool.environment
        request = worker.request_for(source, FileConfig(), '1'*32)
        reply = pool.submit(request, timeout=worker.timeout_for(FileConfig())).result(timeout=20)
        event = worker.validate_result(request, reply, source)
        assert event.facts['content_parser_status'] == 'ok'
        if os.name == 'nt':
            assert event.facts['inspection_complete'] is True
            assert event.facts['authenticode_status'] == 'NotSigned'
            assert event.facts['content_parser_sandbox']['integrity'] == 'low'
        else:
            assert event.facts['inspection_complete'] is False
            assert event.facts['authenticode_status'] == 'Unavailable'
        assert event.event_id == source.event_id and event.timestamp == source.timestamp
        assert 'authenticode_subject' not in event.facts
    finally:
        pool.close()


def test_cancel_reaps_actual_nested_parser_job(tmp_path):
    psutil = pytest.importorskip('psutil')
    path = tmp_path / 'large-inert-fixture.zip'
    with path.open('wb') as stream:
        block = b'\0' * 1024**2
        for _ in range(128):
            stream.write(block)
    pool = worker.new_pool()
    descendants = []
    try:
        source = source_event(path)
        request = worker.request_for(source, FileConfig(), '2'*32)
        future = pool.submit(request, timeout=worker.timeout_for(FileConfig()))
        parent = psutil.Process(pool._slots[0].process.pid)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and not descendants:
            for process in parent.children(recursive=True):
                try:
                    if 'monarch_security.file_parser_worker' in process.cmdline():
                        descendants.append(process)
                except psutil.NoSuchProcess:
                    pass
            if not descendants:
                time.sleep(0.001)
        assert descendants, 'test never observed the real nested parser; cancellation was not exercised'
        started = time.monotonic()
        pool.close()
        assert time.monotonic() - started < 4
        assert not parent.is_running()
        assert all(not process.is_running() for process in descendants)
        if future.exception() is not None:
            assert isinstance(future.exception(), WorkerError)
    finally:
        pool.close()
