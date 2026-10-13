"""Bounded JSON transport for owned, reusable sensor processes.

This is lifetime/resource containment, not a privilege sandbox. The executable
and environment are supplied by trusted controller code, never by wire data.
Each child must wait for its first request before starting any descendants.
"""
from __future__ import annotations

from concurrent.futures import Future
import io
import json
import math
import os
import signal
import subprocess
import threading
import time
from typing import Mapping, Sequence

MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


from .worker_errors import WorkerError

def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise WorkerError("worker-json-duplicate")
        result[key] = value
    return result


def _constant(_value):
    raise WorkerError("worker-json-nonfinite")


def _float(value):
    result = float(value)
    if not math.isfinite(result):
        raise WorkerError("worker-json-nonfinite")
    return result


def decode_frame(raw: bytes, limit: int) -> dict:
    if not raw.endswith(b"\n") or len(raw) > limit:
        raise WorkerError("worker-frame-invalid")
    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                            parse_constant=_constant, parse_float=_float)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise WorkerError("worker-json-invalid") from exc
    if not isinstance(result, dict):
        raise WorkerError("worker-object-required")
    return result


def encode_frame(value: dict, limit: int) -> bytes:
    if not isinstance(value, dict):
        raise WorkerError("worker-object-required")
    # Incremental encoding stops before an unbounded collection becomes a frame.
    output = bytearray()
    try:
        for chunk in json.JSONEncoder(ensure_ascii=True, allow_nan=False,
                                      separators=(",", ":")).iterencode(value):
            if len(output) + len(chunk) + 1 > limit:
                raise WorkerError("worker-frame-too-large")
            output.extend(chunk.encode("ascii"))
    except (TypeError, ValueError, RecursionError) as exc:
        raise WorkerError("worker-json-invalid") from exc
    return bytes(output) + b"\n"


from .owned_process import WindowsJob as _WindowsJob

class _Slot:
    def __init__(self, command, environment, cwd, memory_bytes, request_bytes, response_bytes, progress_phases):
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=environment, cwd=cwd, bufsize=0, close_fds=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            start_new_session=os.name != "nt",
        )
        self.job = None
        self._lock = threading.RLock()
        self._stop_lock = threading.Lock()
        self._wake = threading.Event()
        self._closed = self._stop_complete = False
        self._delivering = self._terminal_claimed = False
        self.cleanup_error: WorkerError | None = None
        self.future: Future | None = None
        self.io_future: Future | None = None
        self.thread: threading.Thread | None = None
        self.reader = io.BufferedReader(self.process.stdout)
        self.finished_at = 0.0
        self.deadline = 0.0
        self.sequence = 0
        self.request_bytes, self.response_bytes = request_bytes, response_bytes
        self.progress_phases = progress_phases
        try:
            if os.name == "nt":
                self.job = _WindowsJob(self.process, memory_bytes)
        except BaseException:
            # No request has been sent. The trusted child is still at its gate.
            self.process.kill()
            self.process.wait(timeout=2)
            self._close_pipes()
            raise
        self.watchdog = threading.Thread(target=self._watch, name='security-worker-deadline', daemon=True)

    def activate(self):
        self.watchdog.start()

    @property
    def ready(self):
        with self._lock:
            return not self._closed and not self._delivering and (self.future is None or self.future.done())

    @property
    def retired(self):
        with self._lock:
            return self._closed and self._stop_complete

    def start(self, payload: dict, timeout: float) -> Future:
        with self._lock:
            if not self.ready:
                raise WorkerError('worker-slot-unavailable')
            return self._start_locked(payload, timeout)

    def _start_locked(self, payload: dict, timeout: float) -> Future:
        self.sequence += 1
        frame = encode_frame({"schema": 1, "id": self.sequence, "payload": payload}, self.request_bytes)
        self.future = Future()
        self._terminal_claimed = False
        self.future.set_running_or_notify_cancel()
        self.future.progress = 'request-sent'
        self.io_future = future = Future()
        public = self.future
        self.finished_at = 0.0
        self.deadline = time.monotonic() + timeout
        sequence = self.sequence

        def exchange():
            try:
                view = memoryview(frame)
                while view:
                    written = self.process.stdin.write(view)
                    if not written:
                        raise WorkerError("worker-write-failed")
                    view = view[written:]
                phase_index = 0
                while True:
                    raw = self.reader.readline(self.response_bytes + 1)
                    reply = decode_frame(raw, self.response_bytes)
                    if set(reply) != {'schema', 'id', 'phase'}:
                        break
                    if (type(reply['schema']) is not int or reply['schema'] != 1
                            or type(reply['id']) is not int or reply['id'] != sequence
                            or phase_index >= len(self.progress_phases)
                            or reply['phase'] != self.progress_phases[phase_index]):
                        raise WorkerError('worker-progress-invalid')
                    public.progress = reply['phase']
                    phase_index += 1
                if (set(reply) != {"schema", "id", "payload"} or type(reply["schema"]) is not int
                        or reply["schema"] != 1 or type(reply["id"]) is not int
                        or reply["id"] != sequence or not isinstance(reply["payload"], dict)):
                    raise WorkerError("worker-envelope-invalid")
                self.finished_at = time.monotonic()
                future.set_result(reply["payload"])
            except BaseException as exc:
                self.finished_at = time.monotonic()
                future.set_exception(exc if isinstance(exc, WorkerError) else WorkerError("worker-transport-failed"))
            finally:
                self._wake.set()

        self.thread = threading.Thread(target=exchange, name="security-worker-transport", daemon=True)
        self.thread.start()
        self._wake.set()
        return self.future

    def _watch(self):
        # Own only transport/deadlines. Signed state and action authority stay
        # on the controller thread. A stalled controller cannot renew this timer.
        while True:
            self._wake.clear()
            error = None
            resolution = None
            wait = 0.25
            with self._lock:
                if self._closed:
                    return
                future = self.future
                if future is None or future.done():
                    if self.process.poll() is not None:
                        error = WorkerError('worker-exited')
                elif self.io_future.done():
                    if self.thread.is_alive():
                        wait = 0.001
                    else:
                        error = (WorkerError('worker-timeout') if self.finished_at >= self.deadline
                                 else self.io_future.exception())
                        if error is None and self.process.poll() is not None:
                            error = WorkerError('worker-exited')
                        if error is None:
                            future.completed_at = self.finished_at
                            resolution = self._claim(self.io_future.result())
                else:
                    remaining = self.deadline - time.monotonic()
                    if remaining <= 0:
                        error = WorkerError('worker-timeout')
                    else:
                        wait = min(wait, remaining)
            self._deliver(resolution)
            if error is not None:
                try:
                    self.stop(error)
                except BaseException:
                    # Retain ownership and refuse replacement on reap failure.
                    with self._lock:
                        self.cleanup_error = WorkerError('worker-cleanup-incomplete')
                        resolution = self._claim(error=self.cleanup_error)
                    self._deliver(resolution)
                return
            self._wake.wait(wait)

    def _claim(self, result=None, error=None):
        # Called under the slot lock. Completion callbacks run outside all
        # lifecycle locks; close() may be invoked from a callback.
        if self.future is None or self.future.done() or self._terminal_claimed:
            return None
        self._terminal_claimed = self._delivering = True
        return self.future, result, error

    def _deliver(self, resolution):
        if resolution is None:
            return
        future, result, error = resolution
        try:
            if error is None:
                future.set_result(result)
            else:
                future.set_exception(error)
        except BaseException:
            with self._lock:
                self._closed = True
                self.cleanup_error = WorkerError('worker-completion-failed')
            self.stop()
        finally:
            with self._lock:
                self._delivering = False
            self._wake.set()

    def _close_pipes(self):
        self.process.stdin.close()
        self.reader.close()

    def stop(self, error: WorkerError | None = None):
        with self._lock:
            self._closed = True
            self._wake.set()
        resolution = None
        try:
            with self._stop_lock:
                if not self._stop_complete:
                    # Idempotent: never kill a reused process-group ID on a
                    # second controller close after the monitor already reaped.
                    if self.job:
                        self.job.terminate()
                        self.job.close()
                    elif os.name != 'nt':
                        try:
                            os.killpg(self.process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    self.process.wait(timeout=2)
                    if self.thread and self.thread.ident is not None:
                        self.thread.join(timeout=2)
                        if self.thread.is_alive():
                            raise WorkerError('worker-transport-not-reaped')
                    self._close_pipes()
                    with self._lock:
                        self._stop_complete = True
                        resolution = self._claim(error=error or WorkerError('worker-cancelled'))
        except BaseException:
            with self._lock:
                self.cleanup_error = WorkerError('worker-cleanup-incomplete')
                resolution = self._claim(error=self.cleanup_error)
            self._deliver(resolution)
            raise
        self._deliver(resolution)
        if self.watchdog.ident is not None and threading.current_thread() is not self.watchdog:
            self.watchdog.join(timeout=2)
            if self.watchdog.is_alive():
                self.cleanup_error = WorkerError('worker-monitor-not-reaped')
                raise self.cleanup_error


class ProcessWorkerPool:
    """Controller-thread API, independent per-slot deadline monitors, no queue.

    tick() only retires stopped slots; query expiry does not depend on its cadence.

    A failed reaping operation poisons the pool: replacing it would silently
    accumulate unmanaged processes/threads. close() can retry cleanup.
    """
    def __init__(self, command: Sequence[str], *, environment: Mapping[str, str], cwd: str,
                 capacity: int = 3, memory_bytes: int = 512 * 1024 * 1024,
                 request_bytes: int = MAX_REQUEST_BYTES, response_bytes: int = MAX_RESPONSE_BYTES,
                 progress_phases: tuple[str, ...] = ()):
        if not 1 <= capacity <= 8 or memory_bytes < 32 * 1024 * 1024:
            raise ValueError("invalid-worker-limits")
        self.command, self.environment, self.cwd = list(command), dict(environment), cwd
        self.capacity, self.memory_bytes = capacity, memory_bytes
        if (type(request_bytes) is not int or not 128 <= request_bytes <= MAX_REQUEST_BYTES
                or type(response_bytes) is not int or not 128 <= response_bytes <= MAX_RESPONSE_BYTES
                or type(progress_phases) is not tuple or len(progress_phases) > 8
                or any(type(phase) is not str or not phase.isascii() or not phase
                       or len(phase) > 64 for phase in progress_phases)
                or len(set(progress_phases)) != len(progress_phases)):
            raise ValueError('invalid-worker-protocol-limits')
        self.request_bytes, self.response_bytes = request_bytes, response_bytes
        self.progress_phases = progress_phases
        self._slots: list[_Slot] = []
        self._controller_lock = threading.RLock()
        self._closed = False
        self._poisoned = False

    def _retire(self, slot):
        try:
            slot.stop()
        except BaseException:
            with self._controller_lock:
                self._poisoned = True
            raise
        with self._controller_lock:
            if slot in self._slots:
                self._slots.remove(slot)

    def tick(self):
        with self._controller_lock:
            slots = list(self._slots)
        for slot in slots:
            if slot.cleanup_error is not None:
                with self._controller_lock:
                    self._poisoned = True
                raise slot.cleanup_error
            if slot.retired:
                self._retire(slot)
            else:
                slot._wake.set()

    @property
    def available(self) -> bool:
        with self._controller_lock:
            if any(slot.cleanup_error is not None for slot in self._slots):
                self._poisoned = True
            return not self._closed and not self._poisoned and (
                len(self._slots) < self.capacity or any(slot.ready for slot in self._slots))

    def submit(self, payload: dict, *, timeout: float = 70.0) -> Future:
        with self._controller_lock:
            return self._submit_locked(payload, timeout)

    def _submit_locked(self, payload: dict, timeout: float) -> Future:
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("invalid-worker-timeout")
        if not self.available:
            raise WorkerError("worker-capacity-unavailable")
        # Validate before spawning a process or claiming a slot.
        encode_frame({"schema": 1, "id": 1, "payload": payload}, self.request_bytes)
        slot = next((item for item in self._slots if item.ready), None)
        if slot is None:
            slot = _Slot(self.command, self.environment, self.cwd, self.memory_bytes,
                         self.request_bytes, self.response_bytes, self.progress_phases)
            self._slots.append(slot)
            try:
                slot.activate()
            except BaseException as exc:
                self._retire(slot)
                if not isinstance(exc, Exception):
                    raise
                raise WorkerError('worker-monitor-start-failed') from exc
        try:
            return slot.start(payload, timeout)
        except BaseException as exc:
            self._retire(slot)
            if not isinstance(exc, Exception):
                raise
            raise WorkerError('worker-transport-start-failed') from exc

    def close(self):
        with self._controller_lock:
            self._closed = True
            slots = list(self._slots)
        failures = []
        for slot in slots:
            try:
                self._retire(slot)
            except Exception as exc:
                failures.append(exc)
        if failures:
            raise WorkerError("worker-cleanup-incomplete") from failures[0]
