"""A separate lifetime owner. No signed store, policy or response authority."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

from .owned_process import WindowsJob
from .process_identity import probe_process
from .worker_transport import WorkerError, decode_frame, encode_frame

FRAME_BYTES = 512
REQUEST_BYTES = 64 * 1024
PROGRESS_SECONDS = 45.0


def valid_launch_id(value):
    return type(value) is str and len(value) == 32 and all(c in '0123456789abcdef' for c in value)


def validate_request(value):
    if (type(value) is not dict or set(value) != {'schema', 'launch_id', 'config_path', 'no_llm'}
            or type(value['schema']) is not int or value['schema'] != 1
            or not valid_launch_id(value['launch_id']) or type(value['no_llm']) is not bool
            or (value['config_path'] is not None and (type(value['config_path']) is not str
                or not Path(value['config_path']).is_absolute()))):
        raise WorkerError('guardian-request-invalid')
    return value


def launch_environment():
    # Runtime paths are explicit owner context, not ambient credentials/settings.
    from .background import RUNTIME_PATH_KEYS
    import site
    allowed = {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'USERPROFILE', 'APPDATA',
               'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'SYSTEMDRIVE', 'PUBLIC',
               'MONARCH_SECURITY_SITE_PACKAGES', *RUNTIME_PATH_KEYS}
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    paths = [str(Path(__file__).resolve().parent.parent)]
    paths.extend(path for path in site.getsitepackages() if path not in paths)
    dependency = environment.get('MONARCH_SECURITY_SITE_PACKAGES')
    if not dependency:
        dependency = os.pathsep.join(site.getsitepackages())
        environment['MONARCH_SECURITY_SITE_PACKAGES'] = dependency
    if dependency and dependency not in paths:
        paths.append(dependency)
    environment.update(PYTHONPATH=os.pathsep.join(paths), PYTHONDONTWRITEBYTECODE='1',
                       PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    return environment


class ProgressReporter:
    """Called exclusively by the controller after actual work, never a timer."""
    def __init__(self, request, stream):
        self.launch_id, self.stream = request['launch_id'], stream
        identity = probe_process(os.getpid())
        if identity.state != 'alive' or not identity.started:
            raise WorkerError('guardian-child-identity-unavailable')
        self.started = identity.started
        self.sequence, self.last_tick = 0, 0.0

    def emit(self, phase):
        now = time.monotonic()
        if phase == 'tick' and now - self.last_tick < 1.0:
            return
        self.sequence += 1
        self.stream.write(encode_frame({'schema': 1, 'launch_id': self.launch_id,
            'sequence': self.sequence, 'phase': phase, 'process_started': self.started}, FRAME_BYTES))
        self.stream.flush()
        self.last_tick = now


class ControllerGuardian:
    def __init__(self, request, *, command=None, environment=None, startup_seconds=PROGRESS_SECONDS,
                 progress_seconds=PROGRESS_SECONDS):
        self.request = validate_request(request)
        self.startup_seconds, self.progress_seconds = startup_seconds, progress_seconds
        self.process = subprocess.Popen(command or [sys._base_executable, '-S', '-u', '-m',
                    'monarch_security.guarded_protector'],
            env=environment if environment is not None else launch_environment(),
            cwd=str(Path(__file__).resolve().parent.parent), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=None, bufsize=0, close_fds=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            start_new_session=os.name != 'nt')
        self.job = None
        self.reader = io.BufferedReader(self.process.stdout)
        self._lock, self.wake, self.cancel = threading.Lock(), threading.Event(), threading.Event()
        self.sequence, self.phase, self.error = 0, None, None
        self.deadline = time.monotonic() + startup_seconds
        self.closed = False
        self.thread = None
        try:
            if os.name == 'nt':
                # Lifetime only: local model memory is not a sensor's budget.
                self.job = WindowsJob(self.process, None)
            identity = probe_process(self.process.pid)
            if identity.state != 'alive' or not identity.started:
                raise WorkerError('guardian-child-identity-unavailable')
            self.started = identity.started
            # Child has not loaded configuration or started descendants yet.
            view = memoryview(encode_frame(self.request, REQUEST_BYTES))
            while view:
                written = self.process.stdin.write(view)
                if not written:
                    raise WorkerError('guardian-gate-write-failed')
                view = view[written:]
            self.process.stdin.close()
            self.thread = threading.Thread(target=self._read_progress, name='security-controller-progress', daemon=True)
            self.thread.start()
        except BaseException:
            self.close()
            raise

    def _read_progress(self):
        try:
            while True:
                raw = self.reader.readline(FRAME_BYTES + 1)
                if not raw:
                    with self._lock:
                        if self.phase != 'finished':
                            self.error = 'controller-progress-eof'
                    return
                value = decode_frame(raw, FRAME_BYTES)
                with self._lock:
                    now = time.monotonic()
                    expected = {'started'} if self.sequence == 0 else {'tick', 'finished'}
                    if (set(value) != {'schema', 'launch_id', 'sequence', 'phase', 'process_started'}
                            or type(value['schema']) is not int or value['schema'] != 1
                            or value['launch_id'] != self.request['launch_id']
                            or type(value['sequence']) is not int or value['sequence'] != self.sequence + 1
                            or type(value['phase']) is not str or value['phase'] not in expected
                            or self.phase == 'finished' or value['process_started'] != self.started
                            or now >= self.deadline):
                        raise WorkerError('controller-progress-invalid')
                    self.sequence, self.phase = value['sequence'], value['phase']
                    self.deadline = now + (3.0 if self.phase == 'finished' else self.progress_seconds)
                self.wake.set()
        except BaseException:
            with self._lock:
                self.error = 'controller-progress-invalid'
        finally:
            self.wake.set()

    def run(self):
        try:
            while True:
                self.wake.clear()
                if self.cancel.is_set():
                    raise WorkerError('controller-guardian-cancelled')
                code = self.process.poll()
                with self._lock:
                    error, phase, deadline = self.error, self.phase, self.deadline
                if error:
                    raise WorkerError(error)
                if code is not None:
                    if code != 0 or phase != 'finished':
                        raise WorkerError('controller-exited-without-completion')
                    return 0
                if time.monotonic() >= deadline:
                    raise WorkerError('controller-startup-stalled' if phase is None else 'controller-loop-stalled')
                self.wake.wait(min(0.25, max(0.0, deadline - time.monotonic())))
        except WorkerError as exc:
            self.error = str(exc)
            raise
        finally:
            self.close()

    def close(self):
        if self.closed:
            return
        # Failed cleanup retains ownership and must not be treated as completed.
        if self.job:
            self.job.terminate()
            self.job.wait_empty(3.0)
            self.job.close()
        elif os.name != 'nt':
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif self.process.poll() is None:
            self.process.kill()  # Gate-assignment failure; no descendants exist.
        self.process.wait(timeout=3)
        if self.thread:
            self.thread.join(timeout=3)
            if self.thread.is_alive():
                raise WorkerError('controller-progress-not-reaped')
        if not self.process.stdin.closed:
            self.process.stdin.close()
        self.reader.close()
        self.closed = True


def main():
    guardian = None
    try:
        request = validate_request(decode_frame(sys.stdin.buffer.readline(REQUEST_BYTES + 1), REQUEST_BYTES))
        if sys.stdin.buffer.read(1):
            raise WorkerError('guardian-request-extra-frame')
        from .config import load_config
        from .runtime_lock import RuntimeLock, RuntimeBusyError
        config = load_config(Path(request['config_path']) if request['config_path'] else None)
        try:
            with RuntimeLock(config.runtime.pid_path.with_suffix('.guardian')):
                guardian = ControllerGuardian(request)
                def cancelled(*_):
                    guardian.cancel.set()
                    guardian.wake.set()
                signal.signal(signal.SIGTERM, cancelled)
                signal.signal(signal.SIGINT, cancelled)
                try:
                    return guardian.run()
                finally:
                    if not guardian.closed:
                        # Keep lifetime ownership locked on cleanup failure.
                        # A fresh guardian cannot replace this poisoned owner.
                        print(json.dumps({'status': 'controller_cleanup_incomplete'}), flush=True)
                        while not guardian.cancel.wait(1.0):
                            pass
                        guardian.close()
        except RuntimeBusyError:
            return 2
    except (WorkerError, OSError, subprocess.SubprocessError):
        # No raw child output/paths/key metadata in a guardian diagnostic.
        print(json.dumps({'status': 'controller_guardian_stopped', 'reason':
            guardian.error if guardian and guardian.error else 'controller-unavailable'}), flush=True)
        return 2
    finally:
        if guardian and not guardian.closed:
            guardian.close()


if __name__ == '__main__':
    raise SystemExit(main())
