from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal
import ctypes
import os
import stat
import string


PathPolicyOperation = Literal["isolate-source", "restore-target", "vault-storage"]


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int
    mode: int
    links: int
    size: int
    modified_ns: int
    changed_ns: int


@dataclass(frozen=True)
class PathPolicyDecision:
    allowed: bool
    operation: PathPolicyOperation
    reason: str
    resolved_path: Path | None = None
    matched_root: Path | None = None
    identity: FileIdentity | None = None
    parent_identity: FileIdentity | None = None


@dataclass(frozen=True)
class _ProtectedRoot:
    path: Path
    reason: str
    storage_allowed: bool = False


class FilesystemMutationPolicy:
    """Non-overridable path boundary for Security-owned file mutation."""

    def __init__(
        self,
        *,
        application_root: Path | None = None,
        workspace_root: Path | None = None,
        state_root: Path | None = None,
        additional_protected_roots: Iterable[Path] = (),
    ) -> None:
        package_root = Path(__file__).resolve().parents[2]
        self.application_root = _canonical_root(application_root or package_root)
        self.workspace_root = _canonical_root(workspace_root) if workspace_root else None
        self.state_root = _canonical_root(state_root) if state_root else None
        roots: list[_ProtectedRoot] = []

        for root in additional_protected_roots:
            _add_root(roots, root, "configured-protected-root")
        for root in _environment_roots("MONARCH_SECURITY_PROTECTED_ROOTS"):
            _add_root(roots, root, "configured-protected-root")
        for root in _safe_roots():
            _add_root(roots, root, "monarch-safe-root")
        for root in _system_roots():
            _add_root(roots, root, "system-root")
        for root in _credential_roots():
            _add_root(roots, root, "credential-root")
        for name in (
            "MONARCH_INSTALL_ROOT",
            "MONARCH_PAYLOAD_ROOT",
            "MONARCH_CONFIG_ROOT",
            "MONARCH_DATA_ROOT",
            "MONARCH_LOGS_ROOT",
            "MONARCH_MODELS_ROOT",
        ):
            value = _absolute_environment_path(name)
            if value is not None:
                _add_root(
                    roots,
                    value,
                    "monarch-product-root",
                    storage_allowed=name in {"MONARCH_DATA_ROOT", "MONARCH_LOGS_ROOT"},
                )

        workspace_candidates = [self.workspace_root]
        configured_workspace = _absolute_environment_path("MONARCH_WORKSPACE_ROOT")
        if configured_workspace is not None:
            workspace_candidates.append(configured_workspace)
        for root in workspace_candidates:
            if root is None:
                continue
            for relative in (
                ".env",
                ".env.local",
                ".npmrc",
                ".git",
                ".agents",
                ".codex",
                ".claude",
                ".monarch",
                "secrets",
                "runtime/secrets",
                "runtime/tokens",
                "runtime/credentials",
                "runtime/agent",
                "security/secrets",
                "security/keys",
                "security/data",
                "oscar/.env",
                "oscar/data/tokens",
                "oscar/data/credentials",
                "LLM models",
            ):
                _add_root(
                    roots,
                    root / Path(relative),
                    "monarch-sensitive-root",
                    storage_allowed=relative == "security/data",
                )

        _add_root(roots, self.application_root, "security-application-root", storage_allowed=True)
        if self.state_root is not None:
            _add_root(roots, self.state_root, "security-state-root", storage_allowed=True)
        self._protected_roots = tuple(roots)

    @property
    def protected_roots(self) -> tuple[Path, ...]:
        return tuple(entry.path for entry in self._protected_roots)

    def evaluate_source(self, source: Path) -> PathPolicyDecision:
        lexical = self._lexical_path(source, "isolate-source")
        if isinstance(lexical, PathPolicyDecision):
            return lexical
        blocked = self._blocked_path(lexical, "isolate-source")
        if blocked is not None:
            return blocked
        try:
            source_stat = os.lstat(lexical)
            if _is_reparse(source_stat):
                return _deny("isolate-source", "linked-or-reparse-source", lexical)
            resolved = lexical.resolve(strict=True)
            blocked = self._blocked_path(resolved, "isolate-source")
            if blocked is not None:
                return blocked
            resolved_stat = os.stat(resolved, follow_symlinks=False)
        except (OSError, RuntimeError):
            return _deny("isolate-source", "source-unavailable", lexical)
        if not stat.S_ISREG(resolved_stat.st_mode):
            return _deny("isolate-source", "source-not-regular-file", resolved)
        if int(getattr(resolved_stat, "st_nlink", 1)) != 1:
            return _deny("isolate-source", "hardlinked-source", resolved)
        return PathPolicyDecision(
            allowed=True,
            operation="isolate-source",
            reason="allowed",
            resolved_path=resolved,
            identity=_file_identity(resolved_stat),
        )

    def evaluate_restore_target(self, destination: Path) -> PathPolicyDecision:
        lexical = self._lexical_path(destination, "restore-target")
        if isinstance(lexical, PathPolicyDecision):
            return lexical
        blocked = self._blocked_path(lexical, "restore-target")
        if blocked is not None:
            return blocked
        try:
            if os.path.lexists(lexical):
                return _deny("restore-target", "restore-target-exists", lexical)
            parent = lexical.parent.resolve(strict=True)
            parent_stat = os.stat(parent, follow_symlinks=False)
        except (OSError, RuntimeError):
            return _deny("restore-target", "restore-parent-unavailable", lexical)
        if not stat.S_ISDIR(parent_stat.st_mode):
            return _deny("restore-target", "restore-parent-not-directory", parent)
        resolved = parent / lexical.name
        blocked = self._blocked_path(resolved, "restore-target")
        if blocked is not None:
            return blocked
        return PathPolicyDecision(
            allowed=True,
            operation="restore-target",
            reason="allowed",
            resolved_path=resolved,
            parent_identity=_file_identity(parent_stat),
        )

    def evaluate_vault_storage(self, candidate: Path) -> PathPolicyDecision:
        lexical = self._lexical_path(candidate, "vault-storage")
        if isinstance(lexical, PathPolicyDecision):
            return lexical
        if self.state_root is None or not _is_within(lexical, self.state_root):
            return _deny("vault-storage", "outside-security-state-root", lexical)
        for entry in self._protected_roots:
            if entry.storage_allowed:
                continue
            if _is_within(lexical, entry.path):
                return _deny("vault-storage", entry.reason, lexical, entry.path)
        return PathPolicyDecision(True, "vault-storage", "allowed", lexical)

    def _lexical_path(
        self,
        raw_path: Path,
        operation: PathPolicyOperation,
    ) -> Path | PathPolicyDecision:
        raw = os.fspath(raw_path)
        if not raw or "\x00" in raw:
            return _deny(operation, "invalid-path")
        normalized = raw.replace("/", "\\") if os.name == "nt" else raw
        if os.name == "nt" and normalized.startswith("\\\\"):
            return _deny(operation, "network-or-device-path")
        try:
            expanded = Path(raw).expanduser()
            lexical = Path(os.path.abspath(os.fspath(expanded)))
        except (OSError, RuntimeError, ValueError):
            return _deny(operation, "invalid-path")
        if os.name == "nt":
            relative_text = str(lexical)[len(lexical.anchor):]
            if ":" in relative_text:
                return _deny(operation, "alternate-stream-path", lexical)
        if _is_broad_root_placement(lexical):
            return _deny(operation, "broad-root-target", lexical)
        return lexical

    def _blocked_path(
        self,
        candidate: Path,
        operation: PathPolicyOperation,
    ) -> PathPolicyDecision | None:
        for entry in self._protected_roots:
            if _is_within(candidate, entry.path):
                return _deny(operation, entry.reason, candidate, entry.path)
        return None


def same_file_identity(left: FileIdentity | None, right: FileIdentity | None) -> bool:
    return left is not None and right is not None and left == right


def _deny(
    operation: PathPolicyOperation,
    reason: str,
    path: Path | None = None,
    matched_root: Path | None = None,
) -> PathPolicyDecision:
    return PathPolicyDecision(False, operation, reason, path, matched_root)


def _file_identity(value: os.stat_result) -> FileIdentity:
    return FileIdentity(
        device=int(value.st_dev),
        inode=int(value.st_ino),
        mode=int(value.st_mode),
        links=int(getattr(value, "st_nlink", 1)),
        size=int(value.st_size),
        modified_ns=int(value.st_mtime_ns),
        changed_ns=int(value.st_ctime_ns),
    )


def _is_reparse(value: os.stat_result) -> bool:
    attributes = int(getattr(value, "st_file_attributes", 0))
    return stat.S_ISLNK(value.st_mode) or bool(
        attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def _add_root(
    roots: list[_ProtectedRoot],
    candidate: Path,
    reason: str,
    *,
    storage_allowed: bool = False,
) -> None:
    try:
        resolved = _canonical_root(candidate)
    except (OSError, RuntimeError, ValueError):
        return
    key = _path_key(resolved)
    if any(_path_key(entry.path) == key for entry in roots):
        return
    roots.append(_ProtectedRoot(resolved, reason, storage_allowed))


def _canonical_root(value: Path) -> Path:
    return Path(os.path.abspath(os.fspath(Path(value).expanduser()))).resolve(strict=False)


def _is_within(path: Path, root: Path) -> bool:
    candidate_key = _path_key(path)
    root_key = _path_key(root)
    try:
        common = os.path.commonpath((candidate_key, root_key))
    except ValueError:
        return False
    return common == root_key


def _path_key(path: Path) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _is_broad_root_placement(path: Path) -> bool:
    anchor = Path(path.anchor) if path.anchor else None
    if anchor is None:
        return False
    return _path_key(path) == _path_key(anchor) or _path_key(path.parent) == _path_key(anchor)


def _absolute_environment_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    if not value:
        return None
    candidate = Path(value).expanduser()
    return candidate if candidate.is_absolute() else None


def _environment_roots(name: str) -> tuple[Path, ...]:
    value = os.environ.get(name, "")
    roots: list[Path] = []
    for part in value.split(os.pathsep):
        candidate = Path(part.strip()).expanduser() if part.strip() else None
        if candidate is not None and candidate.is_absolute():
            roots.append(candidate)
    return tuple(roots)


def _safe_roots() -> tuple[Path, ...]:
    roots: list[Path] = []
    configured = _absolute_environment_path("MONARCH_SAFE_ROOT")
    if configured is not None:
        roots.append(configured)
    if os.name == "nt":
        roots.extend(Path(f"{letter}:\\MonarchData\\Safe") for letter in string.ascii_uppercase)
    else:
        roots.append(Path("/MonarchData/Safe"))
    return tuple(roots)


def _system_roots() -> tuple[Path, ...]:
    if os.name != "nt":
        return (Path("/boot"), Path("/etc"), Path("/proc"), Path("/root"), Path("/sys"), Path("/usr"))
    windows = _windows_directory()
    system_drive = Path(windows.anchor if windows is not None else "C:\\")
    roots = [
        windows or system_drive / "Windows",
        system_drive / "Program Files",
        system_drive / "Program Files (x86)",
        system_drive / "ProgramData",
        system_drive / "Boot",
        system_drive / "Recovery",
        system_drive / "EFI",
        system_drive / "$Recycle.Bin",
        system_drive / "System Volume Information",
    ]
    for name in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"):
        configured = _absolute_environment_path(name)
        if configured is not None:
            roots.append(configured)
    return tuple(roots)


def _windows_directory() -> Path | None:
    try:
        buffer = ctypes.create_unicode_buffer(32_768)
        length = ctypes.windll.kernel32.GetWindowsDirectoryW(buffer, len(buffer))
        if 0 < int(length) < len(buffer):
            return Path(buffer.value)
    except (AttributeError, OSError, ValueError):
        return None
    return None


def _credential_roots() -> tuple[Path, ...]:
    roots: list[Path] = []
    home = Path.home()
    for relative in (".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"):
        roots.append(home / relative)
    app_data = _absolute_environment_path("APPDATA")
    if app_data is not None:
        roots.extend(
            (
                app_data / "Microsoft/Credentials",
                app_data / "Microsoft/Protect",
                app_data / "Microsoft/Crypto",
            )
        )
    local_app_data = _absolute_environment_path("LOCALAPPDATA")
    if local_app_data is not None:
        roots.append(local_app_data / "Microsoft/Credentials")
    program_data = _absolute_environment_path("ProgramData")
    if program_data is not None:
        roots.append(program_data / "Microsoft/Crypto")
    return tuple(roots)
