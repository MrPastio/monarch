from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import os
import secrets
import subprocess
import sys
import time

from .config import AppConfig, load_config
from .events import utc_now
from .integrity import hmac_sha256
from .incidents import read_incident_summary
from .runtime_lock import RuntimeLock, RuntimeBusyError, lock_is_held
from .runtime_health import finite_number, protection_state as derive_protection_state, validate_runtime_health
from .telemetry import read_telemetry, RUNTIME_PURPOSE
from .process_identity import probe_process


def start_protector(config_path: Path | None = None, no_llm: bool = False, *, background_recovery: bool = False) -> dict[str, Any]:
    config = load_config(config_path)
    try:
        with RuntimeLock(config.runtime.pid_path.with_suffix(".lifecycle")):
            from .background import read_background, write_background
            if background_recovery:
                preference = read_background(config)
                if preference.get("enabled") is not True or preference.get("requested") is not True:
                    return {"started": False, "reason": "background-paused", "running": False}
            else:
                write_background(config, requested=True)
            return _start_protector_owned(config, config_path, no_llm)
    except RuntimeBusyError:
        return {"started": False, "reason": "lifecycle-busy", **protector_status(config, cleanup_stale=False)}


def _start_protector_owned(config: AppConfig, config_path: Path | None, no_llm: bool) -> dict[str, Any]:
    current = protector_status(config)
    if current.get("running"):
        return {"started": False, "reason": "already_running", **current}

    config.runtime.control_path.parent.mkdir(parents=True, exist_ok=True)
    if config.runtime.control_path.exists():
        config.runtime.control_path.unlink()
    if config.runtime.control_token_path.exists():
        config.runtime.control_token_path.unlink()

    log_path = config.runtime.audit_log_path.parent / "protector.out.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    from .runtime_guard import REQUEST_BYTES, launch_environment
    from .worker_transport import WorkerError, encode_frame
    args = [sys._base_executable, '-S', '-u', '-m', 'monarch_security.runtime_guard']

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    launch_id = secrets.token_hex(16)

    with log_path.open("a", encoding="utf-8") as log:
        process = subprocess.Popen(
            args,
            cwd=str(config.root),
            env=launch_environment(),
            stdin=subprocess.PIPE,
            stdout=log,
            stderr=log,
            close_fds=True,
            creationflags=creationflags,
            start_new_session=os.name != 'nt',
        )
    try:
        process.stdin.write(encode_frame({'schema': 1, 'launch_id': launch_id,
            'config_path': str(config_path.resolve()) if config_path is not None else None,
            'no_llm': no_llm}, REQUEST_BYTES))
        process.stdin.close()
    except (OSError, WorkerError):
        _terminate_failed_start(process)
        return {'started': False, 'running': False, 'reason': 'guardian-start-gate-failed'}

    status = _wait_for_running_status(config, timeout=6.0, expected_launch_id=launch_id,
                                      expected_guardian_pid=process.pid)
    if (not status.get("running") or (status.get("heartbeat") or {}).get("launch_id") != launch_id
            or _guardian_pid(status.get('heartbeat')) != process.pid
            or status.get("telemetry_verified") is not True or status.get("heartbeat_stale")):
        returncode = _process_returncode(process)
        orphan_cleaned = False
        if returncode is None:
            orphan_cleaned = _terminate_failed_start(process)
        # Do not erase another live owner's markers while cleaning our failed child.
        current = protector_status(config, cleanup_stale=False)
        another_owner = current.get("running") is True
        markers_cleaned = False if another_owner else _cleanup_stale_runtime_markers(config)
        payload: dict[str, Any] = {
            "started": False,
            "reason": "startup_failed" if returncode is not None else "startup_timeout",
            "running": False,
            "pid": status.get("pid"),
            "launch_pid": process.pid,
            "log_path": str(log_path),
            "pid_path": str(config.runtime.pid_path),
            "heartbeat_path": str(config.runtime.heartbeat_path),
            "orphan_cleaned": orphan_cleaned,
            "stale_markers_cleaned": markers_cleaned,
        }
        if returncode is not None:
            payload["exit_code"] = returncode
        return payload

    return {
        "started": True,
        "running": True,
        "pid": status.get("pid") or process.pid,
        "launch_pid": process.pid,
        "log_path": str(log_path),
        "pid_path": str(config.runtime.pid_path),
        "heartbeat_path": str(config.runtime.heartbeat_path),
    }


def stop_protector(config_path: Path | None = None, wait_seconds: float = 10.0) -> dict[str, Any]:
    config = load_config(config_path)
    from .background import write_background
    # Caller has completed existing lifecycle authorization. Persist its stop
    # even if a startup/recovery still owns the short-lived lifecycle lock.
    write_background(config, requested=False)
    try:
        with RuntimeLock(config.runtime.pid_path.with_suffix(".lifecycle")):
            return {**_stop_protector_owned(config, wait_seconds), 'durable_pause_requested': True}
    except RuntimeBusyError:
        return {"stop_requested": False, "reason": "lifecycle-busy", 'durable_pause_requested': True,
                **protector_status(config, cleanup_stale=False)}


def request_emergency_test(config: AppConfig, timeout_seconds: float = 75.0) -> dict[str, Any]:
    status = protector_status(config, cleanup_stale=False)
    if not status.get("running") or status.get("heartbeat_stale"):
        return {"ok": False, "error": "Background Security protector is not running"}
    pid = status.get("pid")
    token = _read_control_token(config.runtime.control_token_path)
    if not pid or not token:
        return {"ok": False, "error": "Protector control channel is unavailable"}
    request_path = config.runtime.control_path.with_name("emergency-test.request.json")
    result_path = config.runtime.control_path.with_name("emergency-test.result.json")
    nonce = secrets.token_hex(16)
    requested_at = time.time()
    payload = {"pid": pid, "nonce": nonce, "requested_at": requested_at}
    payload["token_hmac"] = hmac_sha256(token, f"emergency-test|{requested_at}|{pid}|{nonce}")
    _write_control_request(request_path, payload)
    deadline = time.monotonic() + max(1.0, timeout_seconds)
    while time.monotonic() < deadline:
        result = _read_json(result_path)
        if result and result.get("nonce") == nonce:
            return result
        time.sleep(0.1)
    return {"ok": False, "error": "Protector did not acknowledge the emergency test"}


def _stop_protector_owned(config: AppConfig, wait_seconds: float) -> dict[str, Any]:
    status = protector_status(config)
    if not status.get("running"):
        return {
            "stop_requested": False,
            "reason": "not_running",
            "running": False,
            "pid": status.get("pid"),
            "control_path": str(config.runtime.control_path),
            "authenticated": False,
        }

    config.runtime.control_path.parent.mkdir(parents=True, exist_ok=True)
    requested_at = utc_now()
    token = _read_control_token(config.runtime.control_token_path)
    payload: dict[str, Any] = {"requested_at": requested_at, "pid": status.get("pid")}
    if token:
        payload["token_hmac"] = hmac_sha256(token, _control_message(payload))
    else:
        payload["token_missing"] = True
    _write_control_request(config.runtime.control_path, payload)

    deadline = time.monotonic() + max(0.0, wait_seconds)
    while time.monotonic() < deadline:
        status = protector_status(config)
        if not status.get("running"):
            break
        time.sleep(0.25)

    return {
        "stop_requested": True,
        "running": bool(status.get("running")),
        "pid": status.get("pid"),
        "control_path": str(config.runtime.control_path),
        "authenticated": bool(token),
    }


def protector_status(config: AppConfig, cleanup_stale: bool = True) -> dict[str, Any]:
    pid = _read_pid(config.runtime.pid_path)
    heartbeat, telemetry_error = read_telemetry(config.runtime.heartbeat_path, config.runtime.integrity_key_path,
                                              RUNTIME_PURPOSE, expected_pid=pid)
    if heartbeat is not None and not validate_runtime_health(heartbeat):
        heartbeat, telemetry_error = None, "telemetry-health-invalid"
    owner = lock_is_held(config.runtime.pid_path.with_suffix('.owner'))
    running = owner is True or bool(owner is None and pid and _pid_running(pid))
    process_identity_verified = bool(running and owner is True and heartbeat
        and type(heartbeat.get('process_started')) is str
        and probe_process(pid).started == heartbeat['process_started'])
    guardian = (heartbeat or {}).get('guardian')
    if guardian is not None:
        process_identity_verified = process_identity_verified and (
            type(guardian) is dict and set(guardian) == {'pid', 'process_started', 'lease_seconds', 'mechanism'}
            and type(guardian['pid']) is int and type(guardian['process_started']) is str
            and type(guardian['lease_seconds']) is int and guardian['lease_seconds'] == 45
            and guardian['mechanism'] == ('owned-job' if os.name == 'nt' else 'owned-process-group')
            and probe_process(guardian['pid']).started == guardian['process_started'])
    stale = bool(running) and (not process_identity_verified or _heartbeat_stale(heartbeat) or (heartbeat or {}).get("pid") != pid)
    cleaned = False
    if cleanup_stale and not running and _has_stale_runtime_markers(config, pid, heartbeat, stale):
        cleaned = _cleanup_stale_runtime_markers(config)
        pid = _read_pid(config.runtime.pid_path)
        heartbeat, telemetry_error = read_telemetry(config.runtime.heartbeat_path, config.runtime.integrity_key_path,
                                                  RUNTIME_PURPOSE, expected_pid=pid)
        if heartbeat is not None and not validate_runtime_health(heartbeat):
            heartbeat, telemetry_error = None, "telemetry-health-invalid"
        stale = bool(heartbeat) and _heartbeat_stale(heartbeat)

    incidents = read_incident_summary(
        config.runtime.incident_log_path,
        config.runtime.integrity_key_path,
        max_bytes=config.runtime.max_incident_log_bytes,
        max_archives=config.runtime.max_incident_archives,
        max_live_incidents=config.runtime.max_live_incidents,
    )
    protection_state = "stopped"
    if incidents.get("integrity_ok") is False:
        protection_state = "attention_required"
    elif running and stale:
        protection_state = "degraded"
    elif running:
        protection_state = derive_protection_state(heartbeat["status"], heartbeat["sensor_health"], heartbeat["sensor_backlog"])
    elif incidents.get("integrity_ok") is False:
        protection_state = "attention_required"

    return {
        "running": running,
        "protection_state": protection_state,
        "pid": pid,
        "heartbeat_stale": stale,
        "heartbeat": heartbeat,
        "telemetry_verified": heartbeat is not None and telemetry_error is None,
        "telemetry_error": telemetry_error,
        "process_identity_verified": bool(process_identity_verified),
        "runtime_owner_verified": owner is True,
        "stale_markers_cleaned": cleaned,
        "pid_path": str(config.runtime.pid_path),
        "control_path": str(config.runtime.control_path),
        "heartbeat_path": str(config.runtime.heartbeat_path),
        "audit_log_path": str(config.runtime.audit_log_path),
        "incident_log_path": str(config.runtime.incident_log_path),
        "incidents": incidents,
    }


def _read_pid(path: Path) -> int | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _has_stale_runtime_markers(
    config: AppConfig,
    pid: int | None,
    heartbeat: dict[str, Any] | None,
    heartbeat_stale: bool,
) -> bool:
    if heartbeat_stale:
        return True
    if pid is not None or config.runtime.pid_path.exists():
        return True
    if heartbeat is None and config.runtime.heartbeat_path.exists():
        return True
    if heartbeat and str(heartbeat.get("status") or "") in {"running", "starting"}:
        return True
    return config.runtime.control_path.exists() or config.runtime.control_token_path.exists()


def _cleanup_stale_runtime_markers(config: AppConfig) -> bool:
    try:
        with RuntimeLock(config.runtime.pid_path.with_suffix('.owner')):
            return _remove_unowned_runtime_markers(config)
    except RuntimeBusyError:
        return False


def _remove_unowned_runtime_markers(config: AppConfig) -> bool:
    cleaned = False
    for marker in (
        config.runtime.pid_path,
        config.runtime.heartbeat_path,
        config.runtime.control_path,
        config.runtime.control_token_path,
    ):
        try:
            if marker.exists():
                marker.unlink()
                cleaned = True
        except OSError:
            pass
    return cleaned


def _python_executable() -> str:
    executable = Path(sys.executable)
    if executable.name.lower() in {"python.exe", "pythonw.exe", "python"}:
        return str(executable)
    candidate = executable.with_name("python.exe")
    if candidate.exists():
        return str(candidate)
    return sys.executable


def _wait_for_running_status(config: AppConfig, timeout: float, expected_pid: int | None = None,
                             expected_launch_id: str | None = None,
                             expected_guardian_pid: int | None = None) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last = protector_status(config)
    while time.monotonic() < deadline:
        last = protector_status(config)
        heartbeat = last.get("heartbeat") or {}
        if (last.get("running") and (expected_pid is None or last.get("pid") == expected_pid)
                and (expected_launch_id is None or heartbeat.get("launch_id") == expected_launch_id)
                and (expected_guardian_pid is None or _guardian_pid(heartbeat) == expected_guardian_pid)
                and last.get("telemetry_verified") is True and heartbeat.get("pid") == last.get("pid")
                and heartbeat.get("status") in {"starting", "running"} and not last.get("heartbeat_stale")):
            return last
        time.sleep(0.2)
    return last


def _guardian_pid(heartbeat) -> int | None:
    value = heartbeat.get('guardian') if type(heartbeat) is dict else None
    return value.get('pid') if type(value) is dict and type(value.get('pid')) is int else None


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _process_returncode(process: subprocess.Popen) -> int | None:
    try:
        return process.poll()
    except Exception:
        return None


def _terminate_failed_start(process: subprocess.Popen) -> bool:
    """Best-effort cleanup for a child that never published healthy runtime markers."""
    try:
        process.terminate()
        process.wait(timeout=3.0)
        return True
    except Exception:
        try:
            process.kill()
            process.wait(timeout=3.0)
            return True
        except Exception:
            return False


def _read_control_token(path: Path) -> bytes | None:
    try:
        token = path.read_bytes().strip()
    except OSError:
        return None
    return token or None


def _write_control_request(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _control_message(payload: dict[str, Any]) -> str:
    return f"{payload.get('requested_at')}|{payload.get('pid')}"


def _pid_running(pid: int) -> bool:
    # Unknown query access never authorizes stale-marker removal/replacement.
    return probe_process(pid).state != 'dead'


def _heartbeat_stale(heartbeat: dict[str, Any] | None) -> bool:
    if not heartbeat:
        return True
    updated_at = heartbeat.get("updated_at")
    if not finite_number(updated_at):
        return True
    age = time.time() - float(updated_at)
    return age < -5 or age > 35
