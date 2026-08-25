from __future__ import annotations

from dataclasses import dataclass

from .config import AppConfig
from .state import StateStore

SECURITY_LEVELS = ("off", "minimal", "balanced", "strict", "maximum")
DEFAULT_SECURITY_LEVEL = "balanced"
MODEL_CONFIRMATION_MODES = ("adaptive", "always")
ACTION_GUARD_REACTIONS = ("observe", "guard", "confirm-all")
AGENT_SECURITY_MODES = ("off", "observe", "guard", "strict")
MODEL_COMMAND_POLICY_SCHEMA_VERSION = "monarch.agent-security-policy.v1"


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
    schema_version: str = MODEL_COMMAND_POLICY_SCHEMA_VERSION
    enabled: bool = True
    confirmation_mode: str = "adaptive"
    action_guard_reaction: str = "guard"
    agent_security_mode: str | None = None

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema_version": self.schema_version,
            "enabled": self.enabled,
            "confirmation_mode": self.confirmation_mode,
            "action_guard_reaction": self.action_guard_reaction,
        }
        if self.agent_security_mode is not None:
            payload["agent_security_mode"] = self.agent_security_mode
        return payload


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
    action_guard_reaction = str(state.data.get("action_guard_reaction") or "").strip().lower()
    if action_guard_reaction not in ACTION_GUARD_REACTIONS:
        action_guard_reaction = "confirm-all" if confirmation_mode == "always" else "guard"
    confirmation_mode = "always" if action_guard_reaction == "confirm-all" else "adaptive"
    agent_security_mode = str(state.data.get("agent_security_mode") or "").strip().lower()
    if agent_security_mode not in AGENT_SECURITY_MODES:
        agent_security_mode = None
    return ModelCommandPolicy(
        schema_version=MODEL_COMMAND_POLICY_SCHEMA_VERSION,
        enabled=enabled,
        confirmation_mode=confirmation_mode,
        action_guard_reaction=action_guard_reaction,
        agent_security_mode=agent_security_mode,
    )


def write_model_command_policy(
    config: AppConfig,
    *,
    enabled: bool,
    confirmation_mode: str | None = None,
    action_guard_reaction: str | None = None,
    agent_security_mode: str | None = None,
) -> ModelCommandPolicy:
    normalized_agent_mode = str(agent_security_mode or "").strip().lower()
    if normalized_agent_mode and normalized_agent_mode not in AGENT_SECURITY_MODES:
        raise ValueError("unsupported agent security mode")
    normalized_reaction = str(action_guard_reaction or "").strip().lower()
    normalized_mode = str(confirmation_mode or "").strip().lower()
    if normalized_reaction:
        if normalized_reaction not in ACTION_GUARD_REACTIONS:
            raise ValueError("unsupported action guard reaction")
    elif normalized_mode in MODEL_CONFIRMATION_MODES:
        normalized_reaction = "confirm-all" if normalized_mode == "always" else "guard"
    else:
        raise ValueError("unsupported action guard reaction")
    normalized_mode = "always" if normalized_reaction == "confirm-all" else "adaptive"
    state = StateStore(config.runtime.state_path, config.runtime.integrity_key_path)
    with state.lock():
        state.data["model_commands_enabled"] = bool(enabled)
        state.data["model_command_confirmation"] = normalized_mode
        state.data["action_guard_reaction"] = normalized_reaction
        state.data["agent_security_policy_schema"] = MODEL_COMMAND_POLICY_SCHEMA_VERSION
        if normalized_agent_mode:
            state.data["agent_security_mode"] = normalized_agent_mode
    return ModelCommandPolicy(
        schema_version=MODEL_COMMAND_POLICY_SCHEMA_VERSION,
        enabled=bool(enabled),
        confirmation_mode=normalized_mode,
        action_guard_reaction=normalized_reaction,
        agent_security_mode=normalized_agent_mode or None,
    )
