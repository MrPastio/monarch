from __future__ import annotations

import os
from pathlib import Path
import sys
import time
import threading

import pytest

from monarch_security.worker_transport import (
    MAX_REQUEST_BYTES, ProcessWorkerPool, WorkerError, decode_frame, encode_frame,
)


CHILD = r'''
import json, os, subprocess, sys, time
for line in sys.stdin.buffer:
    message = json.loads(line)
    payload = message['payload']
    mode = payload.get('mode')
    if payload.get('delay'):
        time.sleep(payload['delay'])
    if mode == 'hang':
        if payload.get('pid_file'):
            child = subprocess.Popen([sys.executable, '-S', '-c', 'import time; time.sleep(300)'])
            with open(payload['pid_file'], 'w') as stream:
                stream.write(str(child.pid))
        time.sleep(300)
    if mode == 'oversize':
        sys.stdout.buffer.write(b'x' * (8 * 1024 * 1024 + 1))
        sys.stdout.buffer.flush()
        time.sleep(300)
    if mode == 'partial':
        sys.stdout.buffer.write(b'{')
        sys.stdout.buffer.flush()
        time.sleep(300)
    if mode == 'duplicate':
        print('{"schema":1,"schema":1,"id":1,"payload":{}}', flush=True)
        continue
    if mode == 'wrong_id':
        message['id'] += 1
    if mode == 'memory':
        try:
            allocation = bytearray(128 * 1024 * 1024)
            payload['value'] = 'not-limited'
        except MemoryError:
            payload['value'] = 'memory-limited'
    message['payload'] = {'pid': os.getpid(), 'echo': payload.get('value')}
    print(json.dumps(message), flush=True)
'''


@pytest.fixture
def pool(tmp_path):
    script = tmp_path / 'worker.py'
    script.write_text(CHILD, encoding='utf-8')
    # The base executable is essential on Windows: venv python.exe is a launcher.
    instance = ProcessWorkerPool(
        [sys._base_executable, '-S', '-u', str(script)],
        environment={key: value for key, value in os.environ.items()
                     if key.upper() in {'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'}},
        cwd=str(tmp_path), capacity=2,
    )
    yield instance
    instance.close()


def complete(pool, future, timeout=8):
    deadline = time.monotonic() + timeout
    while not future.done() and time.monotonic() < deadline:
        pool.tick()
        time.sleep(0.01)
    assert future.done(), 'controller did not resolve request'
    return future.result()


def alive(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        api = ctypes.WinDLL('kernel32', use_last_error=True)
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        api.WaitForSingleObject.restype = wintypes.DWORD
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = api.OpenProcess(0x100000, False, pid)
        if not handle:
            return False
        try:
            return api.WaitForSingleObject(handle, 0) == 258
        finally:
            api.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def test_reuses_worker_and_preserves_transient_payload(pool):
    first = complete(pool, pool.submit({'value': 'synthetic --command data'}))
    second = complete(pool, pool.submit({'value': [1, 'тест', False]}))
    assert first['pid'] == second['pid']
    assert first['echo'] == 'synthetic --command data'
    assert second['echo'] == [1, 'тест', False]
    pool.close()
    assert not alive(first['pid'])


def test_hung_request_does_not_block_other_slot_and_recovers(pool, tmp_path):
    pid_file = tmp_path / 'descendant.pid'
    hung = pool.submit({'mode': 'hang', 'pid_file': str(pid_file)}, timeout=2)
    healthy = pool.submit({'value': 'healthy'})
    assert not pool.available
    with pytest.raises(WorkerError, match='capacity'):
        pool.submit({})
    assert complete(pool, healthy)['echo'] == 'healthy'
    with pytest.raises(WorkerError, match='timeout'):
        complete(pool, hung)
    assert pid_file.exists(), 'descendant was never created; test did not exercise tree cleanup'
    descendant = int(pid_file.read_text())
    deadline = time.monotonic() + 2
    while alive(descendant) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not alive(descendant)
    assert complete(pool, pool.submit({'value': 'recovered'}))['echo'] == 'recovered'


@pytest.mark.parametrize('mode,error', [
    ('oversize', 'frame-invalid'), ('duplicate', 'json-duplicate'),
    ('wrong_id', 'envelope-invalid'), ('partial', 'timeout'),
])
def test_bad_worker_retired_and_capacity_restored(pool, mode, error):
    future = pool.submit({'mode': mode}, timeout=2)
    with pytest.raises(WorkerError, match=error):
        complete(pool, future)
    assert complete(pool, pool.submit({'value': 42}))['echo'] == 42


def test_stop_is_bounded_while_reader_waits(pool):
    future = pool.submit({'mode': 'partial'}, timeout=300)
    started = time.monotonic()
    pool.close()
    assert time.monotonic() - started < 5
    assert not pool.available
    with pytest.raises(WorkerError, match='cancelled'):
        future.result()


def test_oversized_request_does_not_spawn(pool):
    with pytest.raises(WorkerError, match='too-large'):
        pool.submit({'value': 'x' * MAX_REQUEST_BYTES})
    assert pool._slots == []


@pytest.mark.parametrize('raw', [b'[]\n', b'{"x":NaN}\n', b'{"x":1e999}\n',
                                b'{"x":1,"x":2}\n', b'{}', b'\xff\n'])
def test_strict_frame_decoder(raw):
    with pytest.raises(WorkerError):
        decode_frame(raw, 100)


def test_frame_roundtrip_and_limits():
    frame = encode_frame({'value': 'Пример'}, 100)
    assert decode_frame(frame, 100) == {'value': 'Пример'}
    with pytest.raises(WorkerError):
        decode_frame(frame, len(frame) - 1)


def test_failed_reap_prevents_replacement(pool, monkeypatch):
    complete(pool, pool.submit({}))
    slot = pool._slots[0]
    real_stop = slot.stop
    def failed_stop():
        raise WorkerError('synthetic-reap-failure')
    monkeypatch.setattr(slot, 'stop', failed_stop)
    with pytest.raises(WorkerError, match='cleanup-incomplete'):
        pool.close()
    assert not pool.available
    assert pool._slots == [slot]
    monkeypatch.setattr(slot, 'stop', real_stop)
    pool.close()


@pytest.mark.skipif(os.name != 'nt', reason='Windows job ownership contract')
def test_assignment_failure_sends_no_request_and_reaps_launcher(pool, monkeypatch):
    import monarch_security.worker_transport as transport
    captured = []
    def deny(process, memory_bytes):
        captured.append(process)
        raise WorkerError('worker-job-assignment-failed')
    monkeypatch.setattr(transport, '_WindowsJob', deny)
    with pytest.raises(WorkerError, match='assignment-failed'):
        pool.submit({})
    assert len(captured) == 1
    assert captured[0].poll() is not None
    assert not pool._slots


@pytest.mark.skipif(os.name != 'nt', reason='Windows aggregate job memory limit')
def test_native_job_memory_limit(pool):
    pool.memory_bytes = 64 * 1024 * 1024
    assert complete(pool, pool.submit({'mode': 'memory'}))['echo'] == 'memory-limited'
    assert complete(pool, pool.submit({'value': 'still-responsive'}))['echo'] == 'still-responsive'


def test_completed_after_deadline_is_rejected_even_when_tick_is_late(pool):
    request = pool.submit({'value': 'late'}, timeout=0.00001)
    time.sleep(0.2)
    with pytest.raises(WorkerError, match='timeout'):
        complete(pool, request)


def test_success_resolves_without_any_controller_tick(pool):
    future = pool.submit({'value': 'without-tick'}, timeout=3)
    assert future.result(timeout=5)['echo'] == 'without-tick'


def test_timeout_reaps_descendants_without_controller_tick(pool, tmp_path):
    pid_file = tmp_path / 'no-tick-descendant.pid'
    future = pool.submit({'mode': 'hang', 'pid_file': str(pid_file)}, timeout=1)
    with pytest.raises(WorkerError, match='timeout'):
        future.result(timeout=5)
    assert pid_file.exists()
    assert not alive(int(pid_file.read_text()))
    pool.tick()
    assert pool.submit({'value': 'recovered'}).result(timeout=5)['echo'] == 'recovered'


def test_completed_success_does_not_expire_when_controller_is_late(pool):
    first = pool.submit({'value': 'warm'}).result(timeout=5)
    future = pool.submit({'value': 'completed'}, timeout=0.2)
    result = future.result(timeout=5)
    time.sleep(0.3)
    pool.tick()
    assert future.result() == result
    assert result['pid'] == first['pid']


def test_completion_callback_can_close_the_owned_pool(pool):
    callback_finished = threading.Event()
    errors = []
    future = pool.submit({'value': 'callback-close'})
    def close(_future):
        try:
            pool.close()
        except Exception as exc:
            errors.append(exc)
        finally:
            callback_finished.set()
    future.add_done_callback(close)
    assert future.result(timeout=5)['echo'] == 'callback-close'
    assert callback_finished.wait(3), 'Lifecycle lock blocked the completion callback'
    assert errors == []
    assert pool._slots == []


def test_cancel_callback_can_reenter_close_without_duplicate_reap(pool):
    future = pool.submit({'mode': 'partial'}, timeout=30)
    future.add_done_callback(lambda _future: pool.close())
    pool.close()
    with pytest.raises(WorkerError, match='cancelled'):
        future.result(timeout=1)
    assert pool._slots == []


def test_monitor_cleanup_failure_blocks_replacement(pool, monkeypatch):
    pool.submit({'value': 'warm'}).result(timeout=5)
    slot = pool._slots[0]
    real_stop = slot.stop
    monkeypatch.setattr(slot, 'stop', lambda *args, **kwargs: (_ for _ in ()).throw(WorkerError('synthetic-reap-failure')))
    future = pool.submit({'mode': 'partial'}, timeout=0.05)
    try:
        with pytest.raises(WorkerError, match='cleanup-incomplete'):
            future.result(timeout=5)
        assert not pool.available
        with pytest.raises(WorkerError, match='capacity'):
            pool.submit({})
        assert pool._slots == [slot]
    finally:
        monkeypatch.setattr(slot, 'stop', real_stop)
        pool.close()


def test_reuse_does_not_accumulate_monitors_or_transport_threads(pool):
    monitors = set()
    slots = []
    for index in range(30):
        assert pool.submit({'value': index}).result(timeout=5)['echo'] == index
        slots = list(pool._slots)
        monitors.update(slot.watchdog.ident for slot in slots)
        assert all(slot.thread is None or not slot.thread.is_alive() for slot in slots)
    assert len(monitors) == 1
    pool.close()
    assert all(not slot.watchdog.is_alive() for slot in slots)


def test_close_cannot_miss_a_worker_being_created(pool, monkeypatch):
    import monarch_security.worker_transport as transport
    real_slot = transport._Slot
    created, release = threading.Event(), threading.Event()
    slots, futures, errors = [], [], []
    def delayed_slot(*args):
        slot = real_slot(*args)
        slots.append(slot)
        created.set()
        assert release.wait(3)
        return slot
    def submit():
        try:
            futures.append(pool.submit({'value': 'creation-race'}))
        except BaseException as exc:
            errors.append(exc)
    monkeypatch.setattr(transport, '_Slot', delayed_slot)
    sender = threading.Thread(target=submit)
    closer = threading.Thread(target=pool.close)
    sender.start()
    try:
        assert created.wait(3)
        closer.start()
    finally:
        release.set()
        sender.join(5)
        if closer.ident is not None:
            closer.join(5)
    assert not sender.is_alive() and not closer.is_alive()
    assert errors == []
    assert futures and futures[0].done()
    assert pool._slots == []
    assert all(not alive(slot.process.pid) and not slot.watchdog.is_alive() for slot in slots)


def test_completion_callback_failure_cannot_leave_a_reusable_unmonitored_slot(pool):
    class SyntheticCallbackFailure(BaseException): pass
    future = pool.submit({'value': 'callback-failure', 'delay': 0.1})
    def fail(_future): raise SyntheticCallbackFailure()
    future.add_done_callback(fail)
    assert future.result(timeout=5)['echo'] == 'callback-failure'
    slot = pool._slots[0]
    deadline = time.monotonic() + 3
    while slot.cleanup_error is None and time.monotonic() < deadline:
        time.sleep(0.005)
    assert slot.cleanup_error is not None
    assert not pool.available
    pool.close()
    assert not alive(slot.process.pid)


@pytest.mark.parametrize('failed_thread,code', [('security-worker-deadline', 'monitor-start-failed'),
                                              ('security-worker-transport', 'transport-start-failed')])
def test_thread_start_failure_reaps_registered_job_before_retry(pool, monkeypatch, failed_thread, code):
    import monarch_security.worker_transport as transport
    real_slot, real_start = transport._Slot, threading.Thread.start
    captured = []
    def capture(*args):
        slot = real_slot(*args)
        captured.append(slot)
        return slot
    def deny(thread):
        if thread.name == failed_thread:
            raise RuntimeError('synthetic-thread-capacity')
        return real_start(thread)
    monkeypatch.setattr(transport, '_Slot', capture)
    monkeypatch.setattr(threading.Thread, 'start', deny)
    with pytest.raises(WorkerError, match=code):
        pool.submit({'value': 'not-dispatched'})
    assert pool._slots == []
    assert captured and all(not alive(slot.process.pid) for slot in captured)
    monkeypatch.setattr(threading.Thread, 'start', real_start)
    assert pool.submit({'value': 'recovered'}).result(timeout=5)['echo'] == 'recovered'
