from __future__ import annotations

from pathlib import Path

from monarch_security.config import load_config


def test_installed_runtime_paths_bypass_version_junctions(monkeypatch, tmp_path: Path) -> None:
    project_root = tmp_path / "version" / "security"
    config_path = project_root / "config" / "monarch_security.toml"
    config_path.parent.mkdir(parents=True)
    config_path.write_text("[runtime]\n", encoding="utf-8")
    data_root = tmp_path / "data"
    logs_root = tmp_path / "logs"
    models_root = tmp_path / "models"

    monkeypatch.setenv("MONARCH_DATA_ROOT", str(data_root))
    monkeypatch.setenv("MONARCH_LOGS_ROOT", str(logs_root))
    monkeypatch.setenv("MONARCH_MODELS_ROOT", str(models_root))

    config = load_config(config_path)

    assert config.data_root == data_root / "security"
    assert config.runtime.state_path == data_root / "security" / "state.json"
    assert config.runtime.audit_log_path == logs_root / "security" / "audit.jsonl"
    assert config.runtime.integrity_key_path == data_root / "security" / "integrity.key"
    assert config.model.path == models_root / "gemma_models" / "Gemma_12B" / "gemma-4-12B-it-Q4_K_M.gguf"
