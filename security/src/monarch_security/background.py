"""Per-user Windows startup and a bounded, local protector watchdog.

No elevation, credential transport, policy relaxation, or automatic remediation.
Only an explicitly enabled, signed background preference permits recovery.
"""
from __future__ import annotations

from pathlib import Path
import base64
import hashlib
import json
import os
import subprocess
import sys
import time

from .config import AppConfig, load_config
from .profile import read_security_profile
from .runtime_lock import RuntimeLock, RuntimeBusyError, lock_is_held
from .process_identity import probe_process
from .state import StateStore
from .integrity import get_or_create_key
from .telemetry import BACKGROUND_PURPOSE, read_telemetry, signed_telemetry


PREFERENCE_KEY = "background_protection_v1"
RUNTIME_PATH_KEYS = (
    "MONARCH_SAFE_ROOT", "MONARCH_INSTALL_ROOT", "MONARCH_PAYLOAD_ROOT", "MONARCH_CONFIG_ROOT",
    "MONARCH_DATA_ROOT", "MONARCH_LOGS_ROOT", "MONARCH_MODELS_ROOT", "MONARCH_WORKSPACE_ROOT",
    "MONARCH_SECURITY_PROTECTED_ROOTS",
)


def apply_runtime_context(encoded: str) -> None:
    if not encoded or len(encoded) > 32768:
        raise ValueError("security-runtime-context-invalid")
    value = json.loads(base64.b64decode(encoded, validate=True))
    if not isinstance(value, dict) or any(key not in RUNTIME_PATH_KEYS or not isinstance(item, str) for key, item in value.items()):
        raise ValueError("security-runtime-context-invalid")
    os.environ.update(value)


def read_background(config: AppConfig) -> dict:
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    _require_valid_state(state)
    value = state.get_json(PREFERENCE_KEY, {})
    return dict(value) if isinstance(value, dict) else {}


def write_background(config: AppConfig, **changes) -> dict:
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    _require_valid_state(state)
    with state.lock():
        _require_valid_state(state)
        value = state.get_json(PREFERENCE_KEY, {})
        value = dict(value) if isinstance(value, dict) else {}
        value.update(changes)
        state.set_json(PREFERENCE_KEY, value)
    return value


def _require_valid_state(state: StateStore) -> None:
    if state.data.get("integrity_error") or state.data.get("load_error"):
        raise RuntimeError("security-state-integrity-unavailable")


def background_status(config: AppConfig) -> dict:
    state_store = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    recovery_required = bool(state_store.data.get("integrity_error") or state_store.data.get("load_error"))
    value = state_store.get_json(PREFERENCE_KEY, {}) if not recovery_required else {}
    if not isinstance(value, dict):
        value = {}
    verified, telemetry_error = read_telemetry(_heartbeat_path(config), config.runtime.integrity_key_path,
                                             BACKGROUND_PURPOSE, max_age=45)
    if verified is not None and (not isinstance(verified.get("state"), str)
            or verified["state"] not in {"watching", "paused", "recovering"}
            or type(verified.get("restart_count")) is not int or verified["restart_count"] < 0
            or (verified.get("last_error") is not None and not isinstance(verified["last_error"], str))):
        verified, telemetry_error = None, "telemetry-health-invalid"
    heartbeat = verified or {}
    from .control import _pid_running
    pid = heartbeat.get("pid")
    updated = heartbeat.get("updated_at")
    alive = (type(pid) is int and isinstance(updated, (int, float)) and 0 <= time.time() - updated < 45
             and type(heartbeat.get('process_started')) is str and _pid_running(pid)
             and probe_process(pid).started == heartbeat['process_started']
             and lock_is_held(config.runtime.pid_path.with_name('background.owner')) is True)
    return {
        "enabled": None if recovery_required else value.get("enabled") is True,
        "requested": None if recovery_required else value.get("requested") is True,
        "startup_registered": None if recovery_required else value.get("startup_registered") is True,
        "recovery_required": recovery_required,
        "startup_verified_at": value.get("startup_verified_at"),
        "task_name": value.get("task_name"),
        "host_running": bool(alive),
        "telemetry_verified": verified is not None,
        "telemetry_error": telemetry_error,
        "host_pid": pid if alive else None,
        "state": "recovery_required" if recovery_required else heartbeat.get("state") if alive else "stopped",
        "restart_count": heartbeat.get("restart_count", 0),
        "last_error": "security-state-recovery-required" if recovery_required else heartbeat.get("last_error") if alive else None,
    }


def _heartbeat_path(config: AppConfig) -> Path:
    return config.runtime.pid_path.with_name("background_heartbeat.json")


def _task_name(config: AppConfig) -> str:
    identity = str(config.runtime.state_path.resolve()).casefold().encode("utf-8")
    return "Monarch Security " + hashlib.sha256(identity).hexdigest()[:16]


def task_spec(config: AppConfig, config_path: Path) -> dict:
    runner = Path(__file__).resolve().parents[2] / "run_monarch_security.py"
    # Carry the exact data root independently of the immutable code/config root.
    data_root = str(config.data_root)
    context = {key: os.environ[key] for key in RUNTIME_PATH_KEYS if os.environ.get(key)}
    runtime_args = ["--logs-root", str(config.runtime.audit_log_path.parent)]
    if context:
        runtime_args += ["--runtime-context", base64.b64encode(json.dumps(context).encode("utf-8")).decode("ascii")]
    site_packages = os.environ.get("MONARCH_SECURITY_SITE_PACKAGES", "").strip()
    if site_packages:
        runtime_args += ["--site-packages", site_packages]
    executable = Path(sys.executable).resolve()
    windowless = executable.with_name("pythonw.exe")
    if os.name == "nt" and windowless.is_file():
        executable = windowless
    return {
        "name": _task_name(config),
        "executable": str(executable),
        "arguments": subprocess.list2cmdline([
            str(runner), "--config", str(config_path.resolve()), "--data-root", data_root, *runtime_args, "background-host",
        ]),
        "workingDirectory": str(runner.parent),
    }


def _task_command(spec: dict, operation: str) -> dict:
    if os.name != "nt":
        raise RuntimeError("windows-startup-unavailable")
    scripts = {
        "register": r"""
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $s.executable -Argument $s.arguments -WorkingDirectory $s.workingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $s.name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local Monarch Security background protection' -Force | Out-Null
""",
        "start": "Start-ScheduledTask -TaskName $s.name\n",
        "remove": "Unregister-ScheduledTask -TaskName $s.name -Confirm:$false -ErrorAction SilentlyContinue\n",
        "inspect": "",
        "rebind": r"""
$existing = Get-ScheduledTask -TaskName $s.name
if (!$existing.Settings.Enabled -or [string]$existing.Principal.RunLevel -ne 'Limited') { throw 'Existing startup task is not eligible for migration' }
$action = New-ScheduledTaskAction -Execute $s.executable -Argument $s.arguments -WorkingDirectory $s.workingDirectory
Set-ScheduledTask -TaskName $s.name -Action $action | Out-Null
""",
    }
    body = "$ErrorActionPreference='Stop'\n$s = [Console]::In.ReadToEnd() | ConvertFrom-Json\n" + scripts[operation]
    if operation != "remove":
        body += r"""
$t = Get-ScheduledTask -TaskName $s.name
$a = @($t.Actions)[0]
[pscustomobject]@{ registered = $true; enabled = [bool]$t.Settings.Enabled; exact = ($a.Execute -eq $s.executable -and $a.Arguments -eq $s.arguments -and $a.WorkingDirectory -eq $s.workingDirectory -and [string]$t.Principal.RunLevel -eq 'Limited' -and $t.Settings.Enabled -and $t.Triggers.Count -eq 1 -and $t.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'); state = [string]$t.State; run_level = [string]$t.Principal.RunLevel; execution_time_limit = $t.Settings.ExecutionTimeLimit; restart_count = $t.Settings.RestartCount; starts_on_battery = !$t.Settings.DisallowStartIfOnBatteries } | ConvertTo-Json -Compress
"""
    else:
        body += "'{\"registered\":false}'"
    encoded = base64.b64encode(body.encode("utf-16-le")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        input=json.dumps(spec), capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        raise RuntimeError("windows-startup-" + operation + "-failed")
    try:
        return json.loads(result.stdout.strip())
    except ValueError as exc:
        raise RuntimeError("windows-startup-readback-invalid") from exc


def reconcile_background(config: AppConfig, config_path: Path) -> dict:
    """Move an existing task to the active installed code, never enable or resume it.

    The immutable runner must be the exact current pointer target. Candidate trials
    cannot change startup before launcher commit; an old backend cannot undo it.
    Existing processes keep running and remain protected by retention inventory.
    """
    install = os.environ.get("MONARCH_INSTALL_ROOT", "")
    if not install:
        return {"ok": True, "state": "not-installed"}
    runner_root = Path(__file__).resolve().parents[2]
    pointer_path = Path(install).resolve() / "current.json"

    def is_current() -> bool:
        pointer = json.loads(pointer_path.read_text(encoding="utf-8-sig"))
        version = pointer.get("currentVersion") if isinstance(pointer, dict) else None
        if not isinstance(pointer, dict) or pointer.get("schemaVersion") != 1 or not isinstance(version, str) or not version or Path(version).name != version or version in {".", ".."}:
            return False
        return (Path(install).resolve() / "versions" / version / "security").resolve() == runner_root

    if not is_current():
        return {"ok": True, "state": "awaiting-current-version"}
    preference = read_background(config)
    if preference.get("enabled") is not True or preference.get("startup_registered") is not True:
        return {"ok": True, "state": "not-enabled"}
    spec = task_spec(config, config_path)
    status = _task_command(spec, "inspect")
    if status.get("exact") is True:
        return {"ok": True, "state": "current"}
    if status.get("enabled") is not True or status.get("run_level") != "Limited":
        return {"ok": True, "state": "task-not-eligible"}
    if not is_current() or read_background(config).get("enabled") is not True:
        return {"ok": True, "state": "superseded"}
    # Set only the action of a task that still exists. Never register/start it:
    # a concurrent disable removes it, and a manual pause stays signed and intact.
    result = _task_command(spec, "rebind")
    return {"ok": result.get("exact") is True, "state": "rebound" if result.get("exact") is True else "readback-mismatch"}


def enable_background(config: AppConfig, config_path: Path) -> dict:
    if not read_security_profile(config).monitoring_enabled:
        return {"ok": False, "error": "security-profile-off"}
    spec = task_spec(config, config_path)
    registered = _task_command(spec, "register")
    if registered.get("exact") is not True:
        return {"ok": False, "error": "windows-startup-readback-mismatch"}
    write_background(config, enabled=True, requested=True, startup_registered=True,
                     startup_verified_at=time.time(), task_name=spec["name"])
    _task_command(spec, "start")
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        status = background_status(config)
        if status["host_running"]:
            return {"ok": True, **status}
        time.sleep(0.2)
    return {"ok": False, "error": "background-host-start-timeout", **background_status(config)}


def disable_background(config: AppConfig, config_path: Path) -> dict:
    # Caller must complete the same PIN authorization as stopping protection.
    write_background(config, enabled=False, requested=False)
    _task_command(task_spec(config, config_path), "remove")
    write_background(config, startup_registered=False)
    return {"ok": True, **background_status(config)}


def run_background(config: AppConfig, config_path: Path) -> int:
    try:
        with RuntimeLock(config.runtime.pid_path.with_name("background.owner")):
            return _run_owned(config, config_path)
    except RuntimeBusyError:
        return 0


def _run_owned(config: AppConfig, config_path: Path) -> int:
    from .control import protector_status, start_protector
    telemetry_key = get_or_create_key(config.runtime.integrity_key_path)
    restart_count, failures, next_attempt, last_start = 0, 0, 0.0, 0.0
    error = None
    while True:
        preference = read_background(config)
        if preference.get("enabled") is not True:
            return 0
        status = protector_status(config, cleanup_stale=False)
        desired = preference.get("requested") is True and read_security_profile(config).monitoring_enabled
        if status["running"] and time.monotonic() - last_start > 60:
            failures, error = 0, None
        if desired and not status["running"] and time.monotonic() >= next_attempt:
            try:
                result = start_protector(config_path, no_llm=True, background_recovery=True)
                if result.get("started"):
                    restart_count += 1
                    last_start = time.monotonic()
                failures += 1
                error = None if result.get("started") or result.get("running") else result.get("reason", "protector-start-failed")
            except Exception as exc:
                failures += 1
                error = type(exc).__name__
            next_attempt = time.monotonic() + min(300, 5 * 2 ** min(failures, 6))
        heartbeat = {
            "pid": os.getpid(), "updated_at": time.time(), "restart_count": restart_count,
            "process_started": probe_process(os.getpid()).started,
            "state": "paused" if not desired else "recovering" if error or not status['running'] or status.get('heartbeat_stale') else "watching",
            "last_error": error,
        }
        heartbeat = signed_telemetry(heartbeat, telemetry_key, BACKGROUND_PURPOSE)
        target = _heartbeat_path(config)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(heartbeat), encoding="utf-8")
        os.replace(temporary, target)
        time.sleep(5)
