from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any
import json
import os
import sys
import time
import threading
import math

from .worker_transport import ProcessWorkerPool, WorkerError, decode_frame, encode_frame

if TYPE_CHECKING:
    from .config import FileConfig
    from .events import SecurityEvent


PROTOCOL_SCHEMA = 2
MAX_REQUEST_BYTES = 65_536
MAX_RESPONSE_BYTES = 1_048_576
MIN_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024
MAX_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024
MIN_TIMEOUT_SECONDS = 0.5
MAX_TIMEOUT_SECONDS = 10.0
_JOB_HANDLES: list[object] = []
PARSER_PHASES = ('request-validated', 'sandbox-ready', 'inspect-started', 'inspect-finished')
_PARSER_GUARD = threading.Lock()
_PARSER_ACTIVE = 0
_FAILED_PARSER_POOLS: list[ProcessWorkerPool] = []


def inspect_file_isolated(path: Path, config: FileConfig) -> SecurityEvent:
    from .events import SecurityEvent

    path = path.resolve()
    timeout = _bounded_float(
        config.parser_timeout_seconds,
        MIN_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS,
    )
    memory_limit = _bounded_int(
        config.parser_memory_limit_bytes,
        MIN_MEMORY_LIMIT_BYTES,
        MAX_MEMORY_LIMIT_BYTES,
    )
    request = {
        "schema": PROTOCOL_SCHEMA,
        "path": os.fspath(path),
        "memory_limit_bytes": memory_limit,
        "config": {
            "max_full_hash_bytes": int(config.max_full_hash_bytes),
            "entropy_sample_bytes": int(config.entropy_sample_bytes),
            "parser_timeout_seconds": timeout,
            "parser_memory_limit_bytes": memory_limit,
        },
    }
    serialized = json.dumps(
        request,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(serialized) > MAX_REQUEST_BYTES:
        return _failure_event(path, "protocol_error", "file parser request is too large", timeout, memory_limit)

    try:
        response = _run_parser_request(request, timeout, memory_limit)
    except ParserExecutionError as exc:
        event = _failure_event(path, exc.status, str(exc), timeout, memory_limit)
        return SecurityEvent(kind=event.kind, source=event.source, subject=event.subject,
                             event_id=event.event_id, timestamp=event.timestamp,
                             facts={**event.facts, 'content_parser_phase': exc.phase})
    if (not isinstance(response, dict) or type(response.get('schema')) is not int
            or response['schema'] != PROTOCOL_SCHEMA or type(response.get('ok')) is not bool
            or (response['ok'] and set(response) != {'schema', 'ok', 'event', 'sandbox'})
            or (not response['ok'] and set(response) not in (
                {'schema', 'ok', 'error_kind', 'error_type', 'errno', 'error'},
                {'schema', 'ok', 'error_kind', 'error'}))):
        return _failure_event(
            path,
            "protocol_error",
            "file parser response schema is invalid",
            timeout,
            memory_limit,
        )
    if response.get("ok") is not True:
        error = _bounded_text(response.get("error") or "file parser failed")
        if response.get("error_kind") == "os":
            if response.get("error_type") in {"FileNotFoundError", "NotADirectoryError"}:
                raise FileNotFoundError(error)
            return _failure_event(path, "io_error", error, timeout, memory_limit)
        return _failure_event(path, "worker_error", error, timeout, memory_limit)

    event_payload = response.get("event")
    sandbox = response.get("sandbox")
    if (not isinstance(event_payload, dict) or set(event_payload) != {
            'event_id', 'timestamp', 'kind', 'source', 'subject', 'facts'}
            or any(type(event_payload[field]) is not str or not event_payload[field]
                   for field in ('event_id', 'timestamp', 'kind', 'source', 'subject'))
            or not isinstance(sandbox, dict) or set(sandbox) != {
                'process', 'integrity', 'memory_limit', 'memory_limit_bytes'}
            or sandbox['process'] != 'isolated-worker'
            or type(sandbox['memory_limit_bytes']) is not int or sandbox['memory_limit_bytes'] != memory_limit
            or (os.name == 'nt' and (sandbox['integrity'] != 'low' or sandbox['memory_limit'] != 'windows-job'))
            or (os.name != 'nt' and (sandbox['integrity'] != 'platform-default'
                or sandbox['memory_limit'] not in ('rlimit-as', 'parser-budgets-only')))):
        return _failure_event(
            path,
            "protocol_error",
            "file parser response payload is invalid",
            timeout,
            memory_limit,
        )
    try:
        event = SecurityEvent.from_dict(event_payload)
    except ValueError as exc:
        return _failure_event(
            path,
            "protocol_error",
            _bounded_text(exc),
            timeout,
            memory_limit,
        )
    absolute = os.path.abspath(os.fspath(path))
    if (event.kind != 'file.scanned' or event.source != 'file_scanner'
            or event.subject != absolute or event.facts.get('path') != absolute):
        return _failure_event(path, 'protocol_error', 'file parser event target is invalid', timeout, memory_limit)
    facts = dict(event.facts)
    facts.update(
        {
            "content_parser_isolated": True,
            "content_parser_status": "ok",
            "content_parser_timeout_seconds": timeout,
            "content_parser_memory_limit_bytes": memory_limit,
            "content_parser_sandbox": sandbox,
            "content_parser_phase": "inspect-finished",
        }
    )
    return SecurityEvent(kind=event.kind, source=event.source, subject=event.subject,
                         facts=facts, event_id=event.event_id, timestamp=event.timestamp)


class ParserExecutionError(RuntimeError):
    def __init__(self, status: str, phase: str, code: str):
        super().__init__(code)
        self.status, self.phase = status, phase


def _parser_command() -> list[str]:
    # Windows venv python.exe is a redirector, not the process that reads files.
    return [sys._base_executable, '-S', '-u', '-m', 'monarch_security.file_parser_worker', '--worker']


def _run_parser_request(request: dict, timeout: float, memory_limit: int) -> dict:
    global _PARSER_ACTIVE
    with _PARSER_GUARD:
        if _FAILED_PARSER_POOLS:
            raise ParserExecutionError('worker_error', 'launch', 'worker-cleanup-unresolved')
        if _PARSER_ACTIVE >= 3:
            raise ParserExecutionError('worker_error', 'launch', 'worker-capacity-unavailable')
        _PARSER_ACTIVE += 1
    pool = None
    future = None
    try:
        pool = ProcessWorkerPool(_parser_command(), environment=_worker_environment(),
                                 cwd=str(Path(__file__).resolve().parents[1]), capacity=1,
                                 memory_bytes=memory_limit, request_bytes=MAX_REQUEST_BYTES,
                                 response_bytes=MAX_RESPONSE_BYTES, progress_phases=PARSER_PHASES)
        future = pool.submit(request, timeout=timeout)
        while not future.done():
            pool.tick()
            if not future.done():
                time.sleep(0.005)
        response = future.result()
        if response.get('ok') is True and future.progress != PARSER_PHASES[-1]:
            raise WorkerError('worker-progress-incomplete')
        return response
    except (WorkerError, OSError) as exc:
        code = str(exc) if isinstance(exc, WorkerError) else 'worker-launch-failed'
        status = 'timeout' if code == 'worker-timeout' else (
            'protocol_error' if any(tag in code for tag in ('frame', 'json', 'envelope', 'progress')) else 'worker_error')
        raise ParserExecutionError(status, getattr(future, 'progress', 'launch'), code) from exc
    finally:
        try:
            if pool is not None:
                pool.close()
        except (WorkerError, OSError) as exc:
            with _PARSER_GUARD:
                _FAILED_PARSER_POOLS.append(pool)
            raise ParserExecutionError('worker_error', getattr(future, 'progress', 'launch'),
                                       'worker-cleanup-incomplete') from exc
        finally:
            with _PARSER_GUARD:
                _PARSER_ACTIVE -= 1


def _failure_event(
    path: Path,
    status: str,
    error: str,
    timeout: float,
    memory_limit: int,
) -> SecurityEvent:
    from .events import SecurityEvent

    absolute = os.path.abspath(os.fspath(path))
    return SecurityEvent(
        kind="file.scanned",
        source="file_scanner",
        subject=absolute,
        facts={
            "path": absolute,
            "name": Path(absolute).name,
            "extension": Path(absolute).suffix.lower(),
            "exists": None,
            "content_parser_isolated": True,
            "content_parser_status": status,
            "content_parser_timeout_seconds": timeout,
            "content_parser_memory_limit_bytes": memory_limit,
            "content_error": _bounded_text(error),
        },
    )


def _worker_environment() -> dict[str, str]:
    source_root = str(Path(__file__).resolve().parents[1])
    python_root = str(Path(sys._base_executable).resolve().parent)
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows"
    environment = {
        "MONARCH_SECURITY_FILE_PARSER_WORKER": "1",
        "PYTHONPATH": source_root,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUTF8": "1",
        "PYTHONSAFEPATH": "1",
        "PATH": os.pathsep.join((python_root, str(Path(system_root) / "System32"))),
        "SystemRoot": system_root,
        "WINDIR": system_root,
    }
    for name in ("TEMP", "TMP"):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    return environment


def _process_request(request: dict, progress) -> dict:
    try:
        if not isinstance(request, dict) or set(request) != {
            "schema",
            "path",
            "memory_limit_bytes",
            "config",
        }:
            raise ValueError("file parser request shape is invalid")
        if type(request.get('schema')) is not int or request['schema'] != PROTOCOL_SCHEMA:
            raise ValueError("file parser request schema is invalid")
        path = request.get("path")
        config_payload = request.get("config")
        if not isinstance(path, str) or not path or not isinstance(config_payload, dict):
            raise ValueError("file parser request values are invalid")
        if set(config_payload) != {
            "max_full_hash_bytes",
            "entropy_sample_bytes",
            "parser_timeout_seconds",
            "parser_memory_limit_bytes",
        }:
            raise ValueError("file parser config shape is invalid")
        for field, maximum in (('max_full_hash_bytes', 4 * 1024**3), ('entropy_sample_bytes', 16 * 1024**2)):
            value = config_payload[field]
            if type(value) is not int or not 0 <= value <= maximum:
                raise ValueError('file parser config bound is invalid')
        budget = config_payload['parser_timeout_seconds']
        if type(budget) not in (int, float) or not math.isfinite(budget) or not MIN_TIMEOUT_SECONDS <= budget <= MAX_TIMEOUT_SECONDS:
            raise ValueError('file parser timeout is invalid')
        requested_memory = request['memory_limit_bytes']
        if (type(requested_memory) is not int or not MIN_MEMORY_LIMIT_BYTES <= requested_memory <= MAX_MEMORY_LIMIT_BYTES
                or type(config_payload['parser_memory_limit_bytes']) is not int
                or config_payload['parser_memory_limit_bytes'] != requested_memory):
            raise ValueError('file parser memory is invalid')
        memory_limit = _bounded_int(
            request.get("memory_limit_bytes"),
            MIN_MEMORY_LIMIT_BYTES,
            MAX_MEMORY_LIMIT_BYTES,
        )
        progress('request-validated')
        try:
            sandbox = _apply_worker_sandbox(memory_limit)
        except OSError as exc:
            raise RuntimeError(
                f"file parser sandbox initialization failed: {type(exc).__name__}"
            ) from exc
        progress('sandbox-ready')

        from .config import FileConfig
        from .sensors.files import FileScanner

        config = FileConfig(
            max_full_hash_bytes=max(0, min(4 * 1024**3, int(config_payload["max_full_hash_bytes"]))),
            entropy_sample_bytes=max(0, min(16 * 1024**2, int(config_payload["entropy_sample_bytes"]))),
            parser_timeout_seconds=_bounded_float(
                config_payload["parser_timeout_seconds"],
                MIN_TIMEOUT_SECONDS,
                MAX_TIMEOUT_SECONDS,
            ),
            parser_memory_limit_bytes=memory_limit,
        )
        progress('inspect-started')
        event = FileScanner(config)._inspect_local(Path(path))
        progress('inspect-finished')
        return {"schema": PROTOCOL_SCHEMA, "ok": True, "event": event.to_dict(), "sandbox": sandbox}
    except OSError as exc:
        return {
                "schema": PROTOCOL_SCHEMA,
                "ok": False,
                "error_kind": "os",
                "error_type": type(exc).__name__,
                "errno": exc.errno,
                "error": _bounded_text(exc),
            }
    except Exception as exc:
        return {
                "schema": PROTOCOL_SCHEMA,
                "ok": False,
                "error_kind": "internal",
                "error": f"{type(exc).__name__}: {_bounded_text(exc)}",
            }


def _worker_main() -> int:
    try:
        raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        message = decode_frame(raw, MAX_REQUEST_BYTES)
        if (set(message) != {'schema', 'id', 'payload'} or type(message['schema']) is not int
                or message['schema'] != 1 or type(message['id']) is not int
                or message['id'] != 1 or not isinstance(message['payload'], dict)):
            return 2
        def progress(phase):
            _write_response({'schema': 1, 'id': message['id'], 'phase': phase})
        response = _process_request(message['payload'], progress)
        _write_response({'schema': 1, 'id': message['id'], 'payload': response})
        # Wait at the gate until the parent closes/reaps this one-request job.
        sys.stdin.buffer.read(1)
        return 0
    except (WorkerError, OSError):
        return 2


def _apply_worker_sandbox(memory_limit: int) -> dict[str, Any]:
    if os.name == "nt":
        _apply_windows_job_limit(memory_limit)
        _lower_windows_integrity()
        return {
            "process": "isolated-worker",
            "integrity": "low",
            "memory_limit": "windows-job",
            "memory_limit_bytes": memory_limit,
        }
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
        memory_mode = "rlimit-as"
    except (ImportError, OSError, ValueError):
        memory_mode = "parser-budgets-only"
    return {
        "process": "isolated-worker",
        "integrity": "platform-default",
        "memory_limit": memory_mode,
        "memory_limit_bytes": memory_limit,
    }


def _apply_windows_job_limit(memory_limit: int) -> None:
    import ctypes
    from ctypes import wintypes

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimitInformation),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    info = ExtendedLimitInformation()
    info.BasicLimitInformation.LimitFlags = 0x00000100
    info.ProcessMemoryLimit = memory_limit
    if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
    _JOB_HANDLES.append(job)


def _lower_windows_integrity() -> None:
    import ctypes
    from ctypes import wintypes

    class SidAndAttributes(ctypes.Structure):
        _fields_ = [("Sid", wintypes.LPVOID), ("Attributes", wintypes.DWORD)]

    class TokenMandatoryLabel(ctypes.Structure):
        _fields_ = [("Label", SidAndAttributes)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    advapi32.ConvertStringSidToSidW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.LPVOID)]
    advapi32.ConvertStringSidToSidW.restype = wintypes.BOOL
    advapi32.GetLengthSid.argtypes = [wintypes.LPVOID]
    advapi32.GetLengthSid.restype = wintypes.DWORD
    advapi32.SetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    advapi32.SetTokenInformation.restype = wintypes.BOOL
    token = wintypes.HANDLE()
    sid = wintypes.LPVOID()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0080 | 0x0008, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not advapi32.ConvertStringSidToSidW("S-1-16-4096", ctypes.byref(sid)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            label = TokenMandatoryLabel(SidAndAttributes(sid, 0x00000020))
            size = ctypes.sizeof(label) + advapi32.GetLengthSid(sid)
            if not advapi32.SetTokenInformation(token, 25, ctypes.byref(label), size):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            kernel32.LocalFree(sid)
    finally:
        kernel32.CloseHandle(token)


def _write_response(payload: dict[str, Any]) -> None:
    sys.stdout.buffer.write(encode_frame(payload, MAX_RESPONSE_BYTES))
    sys.stdout.buffer.flush()


def _bounded_text(value: object, limit: int = 512) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ")
    return text if len(text) <= limit else text[: max(0, limit - 1)] + "…"


def _bounded_int(value: object, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, int(value)))


def _bounded_float(value: object, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, float(value)))


if __name__ == "__main__":
    raise SystemExit(_worker_main() if "--worker" in sys.argv else 2)
