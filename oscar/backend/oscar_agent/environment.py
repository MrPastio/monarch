from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Settings
from .schemas import WorkspaceToolResult


MAX_SCAN_DEPTH = 3
MAX_MODEL_FILES = 24
MAX_VERSION_CHARS = 160

ROOT_MARKERS = (
    "AI_HANDOFF.md",
    "package.json",
    "src",
    "oscar",
)

TOOL_VERSION_COMMANDS: dict[str, list[str]] = {
    "python": [sys.executable, "--version"],
    "node": ["node", "--version"],
    "npm": ["npm", "--version"],
    "git": ["git", "--version"],
    "pwsh": ["pwsh", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    "powershell": ["powershell", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    "nvidia-smi": ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
}

_TOOL_CACHE_LOCK = threading.Lock()
_TOOL_CACHE_SIGNATURE: tuple[tuple[str, str | None, int | None, int | None], ...] | None = None
_TOOL_CACHE_VALUE: dict[str, dict[str, str | bool | None]] | None = None


@dataclass(slots=True)
class RootCandidate:
    path: Path
    reason: str
    score: int


class EnvironmentScanner:
    """Build a bounded, local-only snapshot Oscar can trust instead of guessing."""

    def __init__(self, settings: Settings):
        self.settings = settings

    def tool_result(self) -> WorkspaceToolResult:
        snapshot = self.snapshot()
        return WorkspaceToolResult(
            ok=True,
            kind="environment",
            action="environment",
            path=snapshot["paths"]["workspace_root"],
            summary=render_environment_answer(snapshot),
            details=snapshot,
        )

    def snapshot(self) -> dict[str, Any]:
        workspace_root = self.resolve_workspace_root()
        hardware = cheap_hardware_info()
        paths = {
            "workspace_root": str(workspace_root),
            "configured_workspace_root": str(Path(self.settings.workspace_root).resolve()),
            "current_working_directory": str(Path.cwd().resolve()),
            "oscar_root": str(Path(__file__).resolve().parents[1]),
            "backend_package": str(Path(__file__).resolve().parent),
            "generated_dir": str(Path(self.settings.workspace_generated_dir).resolve()),
            "data_dir": str(Path(self.settings.data_dir).resolve()),
            "models_dir": str(Path(self.settings.gemma_models_dir).resolve()),
        }
        return {
            "paths": paths,
            "root_markers": self.root_markers(workspace_root),
            "system": {
                "os": platform.system(),
                "release": platform.release(),
                "version": platform.version(),
                "machine": platform.machine(),
                "python": platform.python_version(),
                "python_executable": sys.executable,
            },
            "installed": self.installed_tools(),
            "models": self.scan_model_files(Path(self.settings.gemma_models_dir)),
            "hardware": hardware,
        }

    def resolve_workspace_root(self) -> Path:
        candidates = self.root_candidates()
        return max(candidates, key=lambda candidate: candidate.score).path.resolve()

    def root_candidates(self) -> list[RootCandidate]:
        raw_candidates: list[tuple[Path, str, int]] = []
        for key in ("OSCAR_WORKSPACE_ROOT", "MONARCH_WORKSPACE_ROOT", "CODEX_WORKSPACE_ROOT"):
            value = os.environ.get(key)
            if value:
                raw_candidates.append((Path(value), key, 320))

        raw_candidates.extend([
            (Path(self.settings.workspace_root), "settings.workspace_root", 260),
            (Path.cwd(), "cwd", 40),
            (Path(__file__).resolve().parents[3], "backend-relative", 70),
        ])

        scored: dict[Path, RootCandidate] = {}
        for raw_path, reason, base_score in raw_candidates:
            explicit_root = reason.startswith(("settings.", "OSCAR_", "MONARCH_", "CODEX_"))
            paths = [raw_path.expanduser().resolve()] if explicit_root else candidate_with_parents(raw_path)
            for path in paths:
                marker_score = root_marker_score(path)
                score = base_score + marker_score
                if path.exists() and path.is_dir():
                    score += 10
                elif reason == "settings.workspace_root" and marker_score == 0:
                    score -= 200
                resolved = path.resolve()
                current = scored.get(resolved)
                if current is None or score > current.score:
                    scored[resolved] = RootCandidate(resolved, reason, score)

        return list(scored.values()) or [RootCandidate(Path.cwd().resolve(), "cwd", 0)]

    def root_markers(self, root: Path) -> dict[str, bool]:
        return {marker: (root / marker).exists() for marker in ROOT_MARKERS}

    def installed_tools(self) -> dict[str, dict[str, str | bool | None]]:
        resolved: dict[str, tuple[list[str], str | None]] = {}
        for name, command in TOOL_VERSION_COMMANDS.items():
            executable = command[0]
            path = sys.executable if executable == sys.executable else shutil.which(executable)
            resolved[name] = (command, str(path) if path else None)

        signature = tuple(
            (name, executable_path, *executable_fingerprint(executable_path))
            for name, (_command, executable_path) in resolved.items()
        )
        global _TOOL_CACHE_SIGNATURE, _TOOL_CACHE_VALUE
        with _TOOL_CACHE_LOCK:
            if signature == _TOOL_CACHE_SIGNATURE and _TOOL_CACHE_VALUE is not None:
                return {name: dict(info) for name, info in _TOOL_CACHE_VALUE.items()}

            tools: dict[str, dict[str, str | bool | None]] = {}
            for name, (command, executable_path) in resolved.items():
                installed = bool(executable_path)
                tools[name] = {
                    "installed": installed,
                    "path": executable_path,
                    "version": tool_version(command) if installed else None,
                }
            _TOOL_CACHE_SIGNATURE = signature
            _TOOL_CACHE_VALUE = tools
            return {name: dict(info) for name, info in tools.items()}

    def scan_model_files(self, root: Path) -> list[str]:
        if not root.exists() or not root.is_dir():
            return []
        results: list[str] = []
        walk_model_files(root, root, results, depth=0)
        return sorted(results)


def candidate_with_parents(path: Path) -> list[Path]:
    resolved = path.expanduser().resolve()
    candidates = [resolved]
    candidates.extend(parent for parent in resolved.parents[:4])
    return candidates


def root_marker_score(path: Path) -> int:
    score = 0
    for marker in ROOT_MARKERS:
        if (path / marker).exists():
            score += 20
    if (path / "oscar" / "backend" / "oscar_agent").exists():
        score += 35
    if (path / ".git").exists():
        score += 8
    return score


def tool_version(command: list[str]) -> str | None:
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=1, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    output = (completed.stdout or completed.stderr).strip().splitlines()
    if not output:
        return None
    return output[0][:MAX_VERSION_CHARS]


def executable_fingerprint(executable_path: str | None) -> tuple[int | None, int | None]:
    if not executable_path:
        return None, None
    try:
        stat = Path(executable_path).stat()
        return stat.st_mtime_ns, stat.st_size
    except OSError:
        return None, None


def cheap_hardware_info() -> dict[str, float | str | bool | None]:
    ram_total_gb = None
    ram_available_gb = None
    try:
        import psutil

        vm = psutil.virtual_memory()
        ram_total_gb = round(vm.total / (1024**3), 2)
        ram_available_gb = round(vm.available / (1024**3), 2)
    except Exception:
        pass
    return {
        "gpu_probe": shutil.which("nvidia-smi"),
        "ram_total_gb": ram_total_gb,
        "ram_available_gb": ram_available_gb,
    }


def walk_model_files(root: Path, current: Path, results: list[str], *, depth: int) -> None:
    if depth > MAX_SCAN_DEPTH or len(results) >= MAX_MODEL_FILES:
        return
    try:
        children = sorted(current.iterdir(), key=lambda item: (item.is_file(), item.name.lower()))
    except OSError:
        return
    for child in children:
        if len(results) >= MAX_MODEL_FILES:
            return
        if child.is_dir():
            walk_model_files(root, child, results, depth=depth + 1)
            continue
        if child.suffix.lower() == ".gguf":
            results.append(child.relative_to(root).as_posix())


def render_environment_answer(snapshot: dict[str, Any]) -> str:
    paths = snapshot["paths"]
    system = snapshot["system"]
    installed = snapshot["installed"]
    hardware = snapshot["hardware"]
    installed_names = [
        name for name, info in installed.items()
        if info.get("installed")
    ]
    model_files = snapshot["models"]
    lines = [
        "Окружение Monarch/Oscar:",
        f"- Workspace: `{paths['workspace_root']}`",
        f"- Backend: `{paths['oscar_root']}`",
        f"- CWD процесса: `{paths['current_working_directory']}`",
        f"- ОС: {system['os']} {system['release']} ({system['machine']})",
        f"- Python: {system['python']} (`{system['python_executable']}`)",
        f"- CLI найдены: {', '.join(installed_names) if installed_names else 'не найдено'}",
    ]
    if hardware.get("gpu_probe"):
        lines.append("- GPU probe: nvidia-smi доступен")
    if hardware.get("ram_total_gb"):
        lines.append(f"- RAM: {hardware['ram_available_gb']} / {hardware['ram_total_gb']} GB доступно")
    lines.append(f"- GGUF-модели: {len(model_files)} найдено")
    if model_files:
        preview = ", ".join(model_files[:5])
        lines.append(f"- Пример моделей: {preview}")
    return "\n".join(lines)


def render_environment_prompt_context(snapshot: dict[str, Any]) -> str:
    paths = snapshot["paths"]
    system = snapshot["system"]
    installed = snapshot["installed"]
    hardware = snapshot["hardware"]
    installed_tools = [
        {"name": name, "version": info.get("version")}
        for name, info in installed.items()
        if info.get("installed")
    ]
    payload = {
        "environment": {
            "workspaceRoot": paths["workspace_root"],
            "configuredWorkspaceRoot": paths["configured_workspace_root"],
            "backendRoot": paths["oscar_root"],
            "currentWorkingDirectory": paths["current_working_directory"],
            "generatedDir": paths["generated_dir"],
            "modelsDir": paths["models_dir"],
            "os": f"{system['os']} {system['release']} ({system['machine']})",
            "python": system["python"],
            "pythonExecutable": system["python_executable"],
            "installedTools": installed_tools[:12],
            "ramAvailableGb": hardware.get("ram_available_gb"),
            "ramTotalGb": hardware.get("ram_total_gb"),
            "ggufModelCount": len(snapshot["models"]),
            "ggufModelExamples": snapshot["models"][:6],
        }
    }
    return json_dumps_compact(payload)


def json_dumps_compact(payload: dict[str, Any]) -> str:
    import json

    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))[:6000]
