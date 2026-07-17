from __future__ import annotations

from dataclasses import dataclass

from .config import AppConfig
from .state import StateStore

SECURITY_LEVELS = ("off", "minimal", "balanced", "strict", "maximum")
DEFAULT_SECURITY_LEVEL = "balanced"
MODEL_CONFIRMATION_MODES = ("adaptive", "always")


@dataclass(frozen=True)
class SecurityProfile:
    level: str
    label: str
    monitoring_enabled: bool
    interval_multiplier: float
    controller_mode: str

    def to_dict(self) -> dict[str, object]:
        return {
            "level": self.level,
            "label": self.label,
            "monitoring_enabled": self.monitoring_enabled,
            "interval_multiplier": self.interval_multiplier,
            "controller_mode": self.controller_mode,
            "default": self.level == DEFAULT_SECURITY_LEVEL,
        }


@dataclass(frozen=True)
class ModelCommandPolicy:
    enabled: bool = True
    confirmation_mode: str = "adaptive"

    def to_dict(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "confirmation_mode": self.confirmation_mode,
        }


_PROFILES = {
    "off": SecurityProfile("off", "Отключён", False, 0.0, "observe_only"),
    "minimal": SecurityProfile("minimal", "Минимальный", True, 2.0, "permissive"),
    "balanced": SecurityProfile("balanced", "Средний", True, 1.0, "balanced"),
    "strict": SecurityProfile("strict", "Строгий", True, 0.6, "cautious"),
    "maximum": SecurityProfile("maximum", "Максимальный", True, 0.35, "lockdown"),
}


def read_security_profile(config: AppConfig) -> SecurityProfile:
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    level = str(state.data.get("security_level") or DEFAULT_SECURITY_LEVEL).strip().lower()
    return _PROFILES.get(level, _PROFILES[DEFAULT_SECURITY_LEVEL])


def write_security_profile(config: AppConfig, level: str) -> SecurityProfile:
    normalized = str(level or "").strip().lower()
    if normalized not in SECURITY_LEVELS:
        raise ValueError("unsupported security level")
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    with state.lock():
        state.data["security_level"] = normalized
    return _PROFILES[normalized]


def read_model_command_policy(config: AppConfig) -> ModelCommandPolicy:
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    enabled = state.data.get("model_commands_enabled", True) is not False
    confirmation_mode = str(state.data.get("model_command_confirmation") or "adaptive").strip().lower()
    if confirmation_mode not in MODEL_CONFIRMATION_MODES:
        confirmation_mode = "adaptive"
    return ModelCommandPolicy(enabled=enabled, confirmation_mode=confirmation_mode)


def write_model_command_policy(
    config: AppConfig,
    *,
    enabled: bool,
    confirmation_mode: str,
) -> ModelCommandPolicy:
    normalized_mode = str(confirmation_mode or "").strip().lower()
    if normalized_mode not in MODEL_CONFIRMATION_MODES:
        raise ValueError("unsupported model command confirmation mode")
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    with state.lock():
        state.data["model_commands_enabled"] = bool(enabled)
        state.data["model_command_confirmation"] = normalized_mode
    return ModelCommandPolicy(enabled=bool(enabled), confirmation_mode=normalized_mode)
