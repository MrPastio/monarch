from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import tomllib


@dataclass(frozen=True)
class ModelConfig:
    path: Path
    n_ctx: int = 2048
    n_threads: int = 4
    max_tokens: int = 220
    temperature: float = 0.1
    unload_after_seconds: int = 120


@dataclass(frozen=True)
class RouterConfig:
    llm_threshold: int = 65
    critical_threshold: int = 85
    allow_llm_under_load: bool = False


@dataclass(frozen=True)
class ResourceConfig:
    high_cpu_percent: float = 65.0
    high_memory_percent: float = 82.0
    min_process_poll_seconds: float = 3.0
    heavy_process_poll_seconds: float = 12.0


@dataclass(frozen=True)
class FileConfig:
    max_full_hash_bytes: int = 268_435_456
    entropy_sample_bytes: int = 1_048_576


@dataclass(frozen=True)
class FileWatchConfig:
    enabled: bool = True
    paths: tuple[Path, ...] = ()
    recursive: bool = False
    poll_seconds: float = 20.0
    max_entries_per_tick: int = 500


@dataclass(frozen=True)
class NetworkConfig:
    enabled: bool = True
    poll_seconds: float = 45.0
    max_neighbors: int = 256
    max_connections: int = 300
    max_listeners: int = 120
    active_probe_enabled: bool = False


@dataclass(frozen=True)
class PersistenceConfig:
    enabled: bool = True
    poll_seconds: float = 180.0
    max_entries: int = 300


@dataclass(frozen=True)
class PostureConfig:
    enabled: bool = True
    poll_seconds: float = 300.0


@dataclass(frozen=True)
class TuiConfig:
    tail_lines: int = 12


@dataclass(frozen=True)
class NotificationConfig:
    enabled: bool = True
    min_score: int = 35
    cooldown_seconds: float = 60.0
    windows_toast: bool = True
    console_bell: bool = False
    balloon_seconds: float = 7.0


@dataclass(frozen=True)
class PolicyConfig:
    default_action: str = "allow"
    destructive_actions_require_user: bool = True
    virustotal_api_key: str = ""


@dataclass(frozen=True)
class RuntimeConfig:
    state_path: Path
    audit_log_path: Path
    incident_log_path: Path
    quarantine_path: Path
    quarantine_manifest_path: Path
    response_log_path: Path
    response_action_log_path: Path
    response_service_heartbeat_path: Path
    emergency_log_path: Path
    security_pin_path: Path
    network_history_path: Path
    pid_path: Path
    control_path: Path
    control_token_path: Path
    heartbeat_path: Path
    integrity_key_path: Path
    max_audit_log_bytes: int = 10_485_760
    max_incident_log_bytes: int = 4_194_304
    max_incident_archives: int = 4
    max_live_incidents: int = 256
    stdout_events: bool = False
    process_monitor_enabled: bool = True
    device_monitor_enabled: bool = True
    install_monitor_enabled: bool = True
    self_protection_enabled: bool = True
    device_poll_seconds: float = 60.0
    install_poll_seconds: float = 180.0
    self_protection_poll_seconds: float = 60.0
    emergency_auto_lock_enabled: bool = True
    emergency_recovery_seconds: int = 600
    max_events_per_tick: int = 25


@dataclass(frozen=True)
class AppConfig:
    root: Path
    model: ModelConfig
    router: RouterConfig
    resources: ResourceConfig
    files: FileConfig
    file_watch: FileWatchConfig
    network: NetworkConfig
    persistence: PersistenceConfig
    posture: PostureConfig
    tui: TuiConfig
    notifications: NotificationConfig
    policy: PolicyConfig
    runtime: RuntimeConfig


def load_config(config_path: Path | None = None) -> AppConfig:
    root = _resolve_root(config_path)
    path = config_path.resolve() if config_path else root / "config" / "monarch_security.toml"
    data: dict = {}
    if path.exists():
        with path.open("rb") as handle:
            data = tomllib.load(handle)

    model_data = data.get("model", {})
    model_path = Path(
        model_data.get(
            "path",
            "../gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf",
        )
    )
    if not model_path.is_absolute():
        model_path = root / model_path
    runtime_data = data.get("runtime", {})
    file_watch_data = data.get("file_watch", {})
    network_data = data.get("network", {})
    persistence_data = data.get("persistence", {})
    posture_data = data.get("posture", {})
    tui_data = data.get("tui", {})
    notification_data = data.get("notifications", {})
    file_watch_paths = tuple(
        _resolve_path(root, _expand_path(str(path)))
        for path in file_watch_data.get(
            "paths", [r"%USERPROFILE%\Downloads", r"%USERPROFILE%\Desktop"]
        )
    )
    state_path = _resolve_path(root, runtime_data.get("state_path", "data/state.json"))
    audit_log_path = _resolve_path(
        root, runtime_data.get("audit_log_path", "logs/audit.jsonl")
    )
    incident_log_path = _resolve_path(
        root, runtime_data.get("incident_log_path", "data/incidents.jsonl")
    )
    quarantine_path = _resolve_path(
        root, runtime_data.get("quarantine_path", "data/quarantine")
    )
    quarantine_manifest_path = _resolve_path(
        root, runtime_data.get("quarantine_manifest_path", "data/quarantine.jsonl")
    )
    response_log_path = _resolve_path(
        root, runtime_data.get("response_log_path", "data/response_proposals.jsonl")
    )
    response_action_log_path = _resolve_path(
        root, runtime_data.get("response_action_log_path", "data/response_actions.jsonl")
    )
    response_service_heartbeat_path = _resolve_path(
        root, runtime_data.get("response_service_heartbeat_path", "data/response_service_heartbeat.json")
    )
    emergency_log_path = _resolve_path(
        root, runtime_data.get("emergency_log_path", "data/emergency.jsonl")
    )
    security_pin_path = _resolve_path(
        root, runtime_data.get("security_pin_path", "data/security_pin.json")
    )
    network_history_path = _resolve_path(
        root, runtime_data.get("network_history_path", "data/network_history.jsonl")
    )
    pid_path = _resolve_path(root, runtime_data.get("pid_path", "data/protector.pid"))
    control_path = _resolve_path(
        root, runtime_data.get("control_path", "data/protector.stop")
    )
    control_token_path = _resolve_path(
        root, runtime_data.get("control_token_path", "data/protector.control.key")
    )
    heartbeat_path = _resolve_path(
        root, runtime_data.get("heartbeat_path", "data/protector_heartbeat.json")
    )
    integrity_key_path = _resolve_path(
        root, runtime_data.get("integrity_key_path", "data/integrity.key")
    )

    return AppConfig(
        root=root,
        model=ModelConfig(
            path=model_path,
            n_ctx=int(model_data.get("n_ctx", 2048)),
            n_threads=int(model_data.get("n_threads", 4)),
            max_tokens=int(model_data.get("max_tokens", 220)),
            temperature=float(model_data.get("temperature", 0.1)),
            unload_after_seconds=int(model_data.get("unload_after_seconds", 120)),
        ),
        router=RouterConfig(**{**RouterConfig().__dict__, **data.get("router", {})}),
        resources=ResourceConfig(
            **{**ResourceConfig().__dict__, **data.get("resources", {})}
        ),
        files=FileConfig(**{**FileConfig().__dict__, **data.get("files", {})}),
        file_watch=FileWatchConfig(
            enabled=bool(file_watch_data.get("enabled", True)),
            paths=file_watch_paths,
            recursive=bool(file_watch_data.get("recursive", False)),
            poll_seconds=float(file_watch_data.get("poll_seconds", 20.0)),
            max_entries_per_tick=int(file_watch_data.get("max_entries_per_tick", 500)),
        ),
        network=NetworkConfig(
            enabled=bool(network_data.get("enabled", True)),
            poll_seconds=float(network_data.get("poll_seconds", 45.0)),
            max_neighbors=int(network_data.get("max_neighbors", 256)),
            max_connections=int(network_data.get("max_connections", 300)),
            max_listeners=int(network_data.get("max_listeners", 120)),
            active_probe_enabled=bool(network_data.get("active_probe_enabled", False)),
        ),
        persistence=PersistenceConfig(
            enabled=bool(persistence_data.get("enabled", True)),
            poll_seconds=float(persistence_data.get("poll_seconds", 180.0)),
            max_entries=int(persistence_data.get("max_entries", 300)),
        ),
        posture=PostureConfig(
            enabled=bool(posture_data.get("enabled", True)),
            poll_seconds=float(posture_data.get("poll_seconds", 300.0)),
        ),
        tui=TuiConfig(tail_lines=int(tui_data.get("tail_lines", 12))),
        notifications=NotificationConfig(
            enabled=bool(notification_data.get("enabled", True)),
            min_score=int(notification_data.get("min_score", 35)),
            cooldown_seconds=float(notification_data.get("cooldown_seconds", 60.0)),
            windows_toast=bool(notification_data.get("windows_toast", True)),
            console_bell=bool(notification_data.get("console_bell", False)),
            balloon_seconds=float(notification_data.get("balloon_seconds", 7.0)),
        ),
        policy=PolicyConfig(**{**PolicyConfig().__dict__, **data.get("policy", {})}),
        runtime=RuntimeConfig(
            state_path=state_path,
            audit_log_path=audit_log_path,
            incident_log_path=incident_log_path,
            quarantine_path=quarantine_path,
            quarantine_manifest_path=quarantine_manifest_path,
            response_log_path=response_log_path,
            response_action_log_path=response_action_log_path,
            response_service_heartbeat_path=response_service_heartbeat_path,
            emergency_log_path=emergency_log_path,
            security_pin_path=security_pin_path,
            network_history_path=network_history_path,
            pid_path=pid_path,
            control_path=control_path,
            control_token_path=control_token_path,
            heartbeat_path=heartbeat_path,
            integrity_key_path=integrity_key_path,
            max_audit_log_bytes=int(runtime_data.get("max_audit_log_bytes", 10_485_760)),
            max_incident_log_bytes=max(262_144, int(runtime_data.get("max_incident_log_bytes", 4_194_304))),
            max_incident_archives=max(1, min(32, int(runtime_data.get("max_incident_archives", 4)))),
            max_live_incidents=max(32, min(4096, int(runtime_data.get("max_live_incidents", 256)))),
            stdout_events=bool(runtime_data.get("stdout_events", False)),
            process_monitor_enabled=bool(runtime_data.get("process_monitor_enabled", True)),
            device_monitor_enabled=bool(runtime_data.get("device_monitor_enabled", True)),
            install_monitor_enabled=bool(runtime_data.get("install_monitor_enabled", True)),
            self_protection_enabled=bool(runtime_data.get("self_protection_enabled", True)),
            device_poll_seconds=float(runtime_data.get("device_poll_seconds", 60.0)),
            install_poll_seconds=float(runtime_data.get("install_poll_seconds", 180.0)),
            self_protection_poll_seconds=float(runtime_data.get("self_protection_poll_seconds", 60.0)),
            emergency_auto_lock_enabled=bool(runtime_data.get("emergency_auto_lock_enabled", True)),
            emergency_recovery_seconds=max(120, min(1800, int(runtime_data.get("emergency_recovery_seconds", 600)))),
            max_events_per_tick=int(runtime_data.get("max_events_per_tick", 25)),
        ),
    )


def _resolve_path(root: Path, value: str | Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return root / path


def _expand_path(value: str) -> str:
    from os import path as os_path

    return os_path.expanduser(os_path.expandvars(value))


def _resolve_root(config_path: Path | None) -> Path:
    if config_path is not None:
        resolved = config_path.resolve()
        if resolved.parent.name.lower() == "config":
            return resolved.parent.parent
        return resolved.parent

    cwd = Path.cwd().resolve()
    if (cwd / "config" / "monarch_security.toml").exists():
        return cwd

    project_root = Path(__file__).resolve().parents[2]
    if (project_root / "config" / "monarch_security.toml").exists():
        return project_root
    return cwd
