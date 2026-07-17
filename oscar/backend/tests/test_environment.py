from __future__ import annotations

from types import SimpleNamespace

from oscar_agent import environment as environment_module


def test_installed_tool_versions_are_cached_by_executable_fingerprint(monkeypatch, tmp_path):
    node = tmp_path / "node.exe"
    git = tmp_path / "git.exe"
    node.write_bytes(b"node")
    git.write_bytes(b"git")
    monkeypatch.setattr(environment_module, "TOOL_VERSION_COMMANDS", {
        "node": ["node", "--version"],
        "git": ["git", "--version"],
    })
    monkeypatch.setattr(
        environment_module.shutil,
        "which",
        lambda executable: str(node if executable == "node" else git),
    )
    calls: list[tuple[str, ...]] = []

    def fake_run(command, **_kwargs):
        calls.append(tuple(command))
        return SimpleNamespace(stdout=f"{command[0]} 1.0\n", stderr="")

    monkeypatch.setattr(environment_module.subprocess, "run", fake_run)
    monkeypatch.setattr(environment_module, "_TOOL_CACHE_SIGNATURE", None)
    monkeypatch.setattr(environment_module, "_TOOL_CACHE_VALUE", None)
    scanner = environment_module.EnvironmentScanner.__new__(environment_module.EnvironmentScanner)

    first = scanner.installed_tools()
    second = scanner.installed_tools()

    assert first == second
    assert len(calls) == 2

    node.write_bytes(b"node-updated")
    scanner.installed_tools()
    assert len(calls) == 4
