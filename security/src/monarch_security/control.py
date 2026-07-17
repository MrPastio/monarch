from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import os
import subprocess
import sys
import time

from .config import AppConfig, load_config
from .events import utc_now
from .integrity import hmac_sha256
from .incidents import read_incident_summary


def start_protector(config_path: Path | None = None, no_llm: bool = False) -> dict[str, Any]:
    config = load_config(config_path)
    current = protector_status(config)
    if current.get("running"):
        return {"started": False, "reason": "already_running", **current}

    config.runtime.control_path.parent.mkdir(parents=True, exist_ok=True)
    if config.runtime.control_path.exists():
        config.runtime.control_path.unlink()
    if config.runtime.control_token_path.exists():
        config.runtime.control_token_path.unlink()

    log_path = config.root / "logs" / "protector.out.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    args = [_python_executable(), "-m", "monarch_security"]
    if config_path is not None:
        args.extend(["--config", str(config_path)])
    args.extend(["protect", "--duration", "0"])
    if no_llm:
        args.append("--no-llm")

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW

    with log_path.open("a", encoding="utf-8") as log:
        process = subprocess.Popen(
            args,
            cwd=str(config.root),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            close_fds=True,
            creationflags=creationflags,
        )

    status = _wait_for_running_status(config, timeout=6.0)
    if not status.get("running"):
        returncode = _process_returncode(process)
        orphan_cleaned = False
        if returncode is None:
            orphan_cleaned = _terminate_failed_start(process)
        markers_cleaned = _cleanup_stale_runtime_markers(config)
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
        "pid": status.get("pid") or process.pid,
        "launch_pid": process.pid,
        "log_path": str(log_path),
        "pid_path": str(config.runtime.pid_path),
        "heartbeat_path": str(config.runtime.heartbeat_path),
    }


def stop_protector(config_path: Path | None = None, wait_seconds: float = 10.0) -> dict[str, Any]:
    config = load_config(config_path)
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
    heartbeat = _read_json(config.runtime.heartbeat_path)
    running = bool(pid and _pid_running(pid))
    stale = bool(heartbeat) and _heartbeat_stale(heartbeat)
    cleaned = False
    if cleanup_stale and not running and _has_stale_runtime_markers(config, pid, heartbeat, stale):
        cleaned = _cleanup_stale_runtime_markers(config)
        pid = _read_pid(config.runtime.pid_path)
        heartbeat = _read_json(config.runtime.heartbeat_path)
        stale = bool(heartbeat) and _heartbeat_stale(heartbeat)

    incidents = read_incident_summary(
        config.runtime.incident_log_path,
        config.runtime.integrity_key_path,
        max_bytes=config.runtime.max_incident_log_bytes,
        max_archives=config.runtime.max_incident_archives,
        max_live_incidents=config.runtime.max_live_incidents,
    )
    protection_state = "stopped"
    if running and stale:
        protection_state = "degraded"
    elif running:
        protection_state = str((heartbeat or {}).get("protection_state") or "protected")
    elif incidents.get("integrity_ok") is False:
        protection_state = "attention_required"

    return {
        "running": running,
        "protection_state": protection_state,
        "pid": pid,
        "heartbeat_stale": stale,
        "heartbeat": heartbeat,
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


def _wait_for_running_status(config: AppConfig, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last = protector_status(config)
    while time.monotonic() < deadline:
        last = protector_status(config)
        if last.get("running"):
            return last
        time.sleep(0.2)
    return last


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
        if os.name == "nt":
            completed = subprocess.run(
                ["taskkill", "/pid", str(process.pid), "/t", "/f"],
                check=False,
                capture_output=True,
                text=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return completed.returncode == 0
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
    try:
        import psutil  # type: ignore

        return psutil.pid_exists(pid) and psutil.Process(pid).is_running()
    except Exception:
        pass
    if os.name == "nt":
        completed = subprocess.run(
            ["tasklist", "/fi", f"PID eq {pid}", "/fo", "csv", "/nh"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return str(pid) in completed.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _heartbeat_stale(heartbeat: dict[str, Any] | None) -> bool:
    if not heartbeat:
        return True
    updated_at = heartbeat.get("updated_at")
    if not isinstance(updated_at, (float, int)):
        return True
    return time.time() - float(updated_at) > 120
