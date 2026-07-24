from __future__ import annotations

import importlib
from pathlib import Path

import oscar_agent.config as config_module


def test_installed_defaults_use_explicit_writable_roots(monkeypatch, tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    payload_root = tmp_path / "payload"
    generated_root = payload_root / "generated"
    workspace_root = payload_root / "workspaces" / "default"
    runtime_root = payload_root / "runtimes" / "runtime-test"
    runtime_python = runtime_root / "python" / "python.exe"
    secrets_root = tmp_path / "install" / "secrets"
    environment_root = payload_root / "environments" / "backend-test"

    monkeypatch.setenv("MONARCH_DATA_ROOT", str(data_root))
    monkeypatch.setenv("MONARCH_PAYLOAD_ROOT", str(payload_root))
    monkeypatch.setenv("MONARCH_GENERATED_ROOT", str(generated_root))
    monkeypatch.setenv("MONARCH_SECRETS_ROOT", str(secrets_root))
    monkeypatch.setenv("MONARCH_WORKSPACE_ROOT", str(workspace_root))
    monkeypatch.setenv("MONARCH_RUNTIME_ROOT", str(runtime_root))
    monkeypatch.setenv("OSCAR_PYTHON", str(runtime_python))
    monkeypatch.setenv("MONARCH_BACKEND_ENVIRONMENT_ROOT", str(environment_root))

    installed_config = importlib.reload(config_module)
    try:
        settings = installed_config.Settings(_env_file=None)
        assert settings.data_dir == data_root / "oscar"
        assert settings.db_path == data_root / "oscar" / "memory" / "oscar_memory.sqlite3"
        assert settings.offload_dir == data_root / "oscar" / "offload"
        assert settings.gemma_models_dir == payload_root / "models" / "gemma_models"
        assert settings.coder_models_dir == payload_root / "models" / "coder"
        assert settings.workspace_generated_dir == generated_root
        assert settings.workspace_root == workspace_root
        assert settings.sharing_tts_python == runtime_python
    finally:
        monkeypatch.delenv("MONARCH_DATA_ROOT")
        monkeypatch.delenv("MONARCH_PAYLOAD_ROOT")
        monkeypatch.delenv("MONARCH_GENERATED_ROOT")
        monkeypatch.delenv("MONARCH_SECRETS_ROOT")
        monkeypatch.delenv("MONARCH_WORKSPACE_ROOT")
        monkeypatch.delenv("MONARCH_RUNTIME_ROOT")
        monkeypatch.delenv("OSCAR_PYTHON")
        monkeypatch.delenv("MONARCH_BACKEND_ENVIRONMENT_ROOT")
        importlib.reload(config_module)
