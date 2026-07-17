from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .config import Settings
from .schemas import WorkspaceEntry, WorkspaceMatch, WorkspaceToolResult

try:  # pragma: no cover - only available on Windows.
    import winreg
except ImportError:  # pragma: no cover - exercised on non-Windows runners.
    winreg = None  # type: ignore[assignment]


BLOCKED_DIR_NAMES = {
    ".git",
    ".hg",
    ".svn",
    ".oscar-trash",
    ".venv",
    "venv",
    "__pycache__",
    "node_modules",
    "LLM models",
    "model",
    "model-small",
    "offload",
    "secrets",
}

BLOCKED_RELATIVE_FILES = {
    (".env",),
    (".env.local",),
    (".npmrc",),
    ("oscar", ".env"),
}

BLOCKED_RELATIVE_DIRS = {
    ("runtime", "secrets"),
    ("runtime", "tokens"),
    ("runtime", "credentials"),
    ("security", "secrets"),
    ("security", "keys"),
    ("security", "data"),
    ("oscar", "data", "tokens"),
    ("oscar", "data", "credentials"),
}

BINARY_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".zip",
    ".7z",
    ".rar",
    ".exe",
    ".dll",
    ".bin",
    ".gguf",
    ".safetensors",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".pyc",
}

TEXT_BATCH_EXTENSIONS = {
    ".css",
    ".csv",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".ps1",
    ".py",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
MAX_DETECTED_BATCH_COMMANDS = 12
WORKSPACE_ACTIONS = {"read", "write", "append", "replace", "mkdir", "list", "search", "copy", "move", "trash", "restore"}
LOCAL_USER_ROOT_ACTIONS = {"read", "list", "search", "mkdir"}
NATURAL_COMMAND_START_RE = re.compile(
    r"^(?:"
    r"read|open|show|list|mkdir|create|write|save|append|add|replace|copy|duplicate|move|rename|trash|remove|delete|restore|search|find|grep|"
    r"file|folder|directory|"
    r"прочитай|открой|покажи|выведи|список|создай|сделай|запиши|сохрани|перезапиши|допиши|добавь|замени|заменить|"
    r"файл|папку|директорию|скопируй|дублируй|перемести|переименуй|удали|убери|восстанови|верни|найди|ищи|поиск"
    r")\b",
    flags=re.IGNORECASE,
)


@dataclass(slots=True)
class WorkspaceCommand:
    action: str
    path: str = ""
    target_path: str = ""
    content: str = ""
    old_text: str = ""
    new_text: str = ""
    query: str = ""
    overwrite: bool = False
    entry_type: str = ""
    extension: str = ""
    ensure_unique: bool = False


class WorkspaceService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = Path(settings.workspace_root).resolve()
        self.generated_dir = Path(settings.workspace_generated_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.generated_dir.mkdir(parents=True, exist_ok=True)

    def execute(self, command: WorkspaceCommand) -> WorkspaceToolResult:
        if command.action == "root":
            return self.root_info()
        if command.action == "write":
            return self.write(command.path, command.content, overwrite=command.overwrite)
        if command.action == "append":
            return self.append(command.path, command.content)
        if command.action == "replace":
            return self.replace(command.path, command.old_text, command.new_text)
        if command.action == "mkdir":
            return self.mkdir(command.path, ensure_unique=command.ensure_unique)
        if command.action == "copy":
            return self.copy(command.path, command.target_path)
        if command.action == "move":
            return self.move(command.path, command.target_path)
        if command.action == "trash":
            return self.trash(command.path)
        if command.action == "restore":
            return self.restore(command.path, command.target_path)
        if command.action == "read":
            return self.read(command.path)
        if command.action == "list":
            return self.list(
                command.path or ".",
                recursive=False,
                entry_type=command.entry_type,
                extension=command.extension,
            )
        if command.action == "search":
            return self.search(command.query, command.path or ".")
        return WorkspaceToolResult(
            ok=False,
            action="search",
            summary="Неизвестное workspace-действие.",
            error="unsupported-workspace-action",
        )

    def root_info(self) -> WorkspaceToolResult:
        return WorkspaceToolResult(
            ok=True,
            action="root",
            path=str(self.root),
            summary=f"Точный путь рабочего пространства Monarch: {self.root}",
        )

    def copy(self, raw_source_path: str, raw_target_path: str) -> WorkspaceToolResult:
        source = self._resolve(raw_source_path, "read", result_action="copy")
        if isinstance(source, WorkspaceToolResult):
            return source
        target = self._resolve(raw_target_path, "write", result_action="copy")
        if isinstance(target, WorkspaceToolResult):
            return target

        if not source.exists():
            return WorkspaceToolResult(
                ok=False,
                action="copy",
                path=str(source),
                summary="Исходный файл или папка не существует.",
                error="not-found",
            )
        if same_path(source, target):
            return WorkspaceToolResult(
                ok=False,
                action="copy",
                path=str(source),
                summary="Новый путь совпадает с текущим.",
                error="same-path",
            )
        if target.exists():
            return WorkspaceToolResult(
                ok=False,
                action="copy",
                path=str(target),
                summary="По новому пути уже есть файл или папка.",
                error="target-exists",
            )
        if source.is_dir() and is_within(target, source):
            return WorkspaceToolResult(
                ok=False,
                action="copy",
                path=str(source),
                summary="Нельзя скопировать папку внутрь самой себя.",
                error="target-inside-source",
            )

        source_policy_root = self.root if is_within(source, self.root) else matching_local_read_root(source)
        size = copy_size_bytes(source, source_policy_root or self.root)
        if size is None:
            return WorkspaceToolResult(
                ok=False,
                action="copy",
                path=str(source),
                summary="Внутри папки есть защищенный путь, копирование остановлено.",
                error="protected-child-path",
            )
        if size > self.settings.workspace_max_write_bytes:
            return WorkspaceToolResult(
                ok=False,
                action="copy",
                path=str(source),
                summary=f"Копия слишком большая для безопасной операции: {size} байт.",
                error="copy-too-large",
                bytes=size,
            )

        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target, copy_function=shutil.copy2)
        else:
            shutil.copy2(source, target)
        return WorkspaceToolResult(
            ok=True,
            action="copy",
            path=str(target),
            summary=f"Скопировал {self._display_path(source)} -> {self._display_path(target)}.",
            bytes=size,
        )

    def move(self, raw_source_path: str, raw_target_path: str) -> WorkspaceToolResult:
        source = self._resolve(raw_source_path, "move")
        if isinstance(source, WorkspaceToolResult):
            return source
        target = self._resolve(raw_target_path, "write", result_action="move")
        if isinstance(target, WorkspaceToolResult):
            return target

        if not source.exists():
            return WorkspaceToolResult(
                ok=False,
                action="move",
                path=str(source),
                summary="Исходный файл или папка не существует.",
                error="not-found",
            )
        if same_path(source, target):
            return WorkspaceToolResult(
                ok=False,
                action="move",
                path=str(source),
                summary="Новый путь совпадает с текущим.",
                error="same-path",
            )
        if target.exists():
            return WorkspaceToolResult(
                ok=False,
                action="move",
                path=str(target),
                summary="По новому пути уже есть файл или папка.",
                error="target-exists",
            )
        if source.is_dir() and is_within(target, source):
            return WorkspaceToolResult(
                ok=False,
                action="move",
                path=str(source),
                summary="Нельзя переместить папку внутрь самой себя.",
                error="target-inside-source",
            )

        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)
        return WorkspaceToolResult(
            ok=True,
            action="move",
            path=str(target),
            summary=f"Переместил {self._display_path(source)} -> {self._display_path(target)}.",
        )

    def trash(self, raw_path: str) -> WorkspaceToolResult:
        source = self._resolve(raw_path, "trash")
        if isinstance(source, WorkspaceToolResult):
            return source
        if not source.exists():
            return WorkspaceToolResult(
                ok=False,
                action="trash",
                path=str(source),
                summary="Файл или папка не существует.",
                error="not-found",
            )

        try:
            relative = source.relative_to(self.root)
        except ValueError:
            return WorkspaceToolResult(
                ok=False,
                action="trash",
                path=str(source),
                summary="Путь выходит за пределы workspace.",
                error="outside-workspace",
            )

        trash_root = self.root / ".oscar-trash" / timestamp_slug()
        target = unique_trash_path(trash_root / relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)
        return WorkspaceToolResult(
            ok=True,
            action="trash",
            path=str(target),
            summary=f"Переместил {self._display_path(source)} в корзину Oscar.",
        )

    def restore(self, raw_trash_path: str, raw_target_path: str = "") -> WorkspaceToolResult:
        source = self._resolve_trash_source(raw_trash_path)
        if isinstance(source, WorkspaceToolResult):
            return source

        target = self._resolve_restore_target(source, raw_target_path)
        if isinstance(target, WorkspaceToolResult):
            return target

        if target.exists():
            return WorkspaceToolResult(
                ok=False,
                action="restore",
                path=str(target),
                summary="По пути восстановления уже есть файл или папка.",
                error="target-exists",
            )

        target.parent.mkdir(parents=True, exist_ok=True)
        source_parent = source.parent
        source.rename(target)
        cleanup_empty_trash_parents(source_parent, self.root / ".oscar-trash")
        return WorkspaceToolResult(
            ok=True,
            action="restore",
            path=str(target),
            summary=f"Восстановил {self._display_path(target)} из корзины Oscar.",
        )

    def write(self, raw_path: str, content: str, *, overwrite: bool = False) -> WorkspaceToolResult:
        resolved = self._resolve(raw_path, "write")
        if isinstance(resolved, WorkspaceToolResult):
            return resolved

        encoded = content.encode("utf-8")
        if len(encoded) > self.settings.workspace_max_write_bytes:
            return WorkspaceToolResult(
                ok=False,
                action="write",
                path=str(resolved),
                summary=f"Файл слишком большой для безопасной записи: {len(encoded)} байт.",
                error="file-too-large",
            )

        if resolved.exists() and resolved.is_dir():
            return WorkspaceToolResult(
                ok=False,
                action="write",
                path=str(resolved),
                summary="Цель является папкой, а не файлом.",
                error="target-is-directory",
            )

        if resolved.exists() and not overwrite:
            return WorkspaceToolResult(
                ok=False,
                action="write",
                path=str(resolved),
                summary="Файл уже существует. Скажи явно 'перезапиши', если нужно заменить его.",
                error="file-exists",
            )

        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content, encoding="utf-8")
        return WorkspaceToolResult(
            ok=True,
            action="write",
            path=str(resolved),
            bytes=len(encoded),
            summary=f"Создал файл {self._display_path(resolved)} ({len(encoded)} байт).",
        )

    def append(self, raw_path: str, content: str) -> WorkspaceToolResult:
        resolved = self._resolve(raw_path, "append")
        if isinstance(resolved, WorkspaceToolResult):
            return resolved

        if resolved.exists() and resolved.is_dir():
            return WorkspaceToolResult(
                ok=False,
                action="append",
                path=str(resolved),
                summary="Цель является папкой, а не файлом.",
                error="target-is-directory",
            )

        existing_size = resolved.stat().st_size if resolved.exists() else 0
        encoded = content.encode("utf-8")
        if existing_size + len(encoded) > self.settings.workspace_max_write_bytes:
            return WorkspaceToolResult(
                ok=False,
                action="append",
                path=str(resolved),
                summary=f"После дописывания файл превысит безопасный лимит {self.settings.workspace_max_write_bytes} байт.",
                error="file-too-large",
            )
        if resolved.exists() and is_likely_binary(resolved):
            return WorkspaceToolResult(
                ok=False,
                action="append",
                path=str(resolved),
                summary="Бинарные файлы через чат не изменяю.",
                error="binary-file",
            )

        resolved.parent.mkdir(parents=True, exist_ok=True)
        prefix = "\n" if existing_size > 0 and content and not content.startswith(("\n", "\r")) else ""
        with resolved.open("a", encoding="utf-8") as handle:
            handle.write(prefix + content)

        return WorkspaceToolResult(
            ok=True,
            action="append",
            path=str(resolved),
            bytes=len((prefix + content).encode("utf-8")),
            summary=f"Дописал файл {self._display_path(resolved)} (+{len((prefix + content).encode('utf-8'))} байт).",
        )

    def replace(self, raw_path: str, old_text: str, new_text: str) -> WorkspaceToolResult:
        resolved = self._resolve(raw_path, "replace")
        if isinstance(resolved, WorkspaceToolResult):
            return resolved

        if not old_text:
            return WorkspaceToolResult(
                ok=False,
                action="replace",
                path=str(resolved),
                summary="Нужно указать точный текст, который заменить.",
                error="empty-old-text",
            )
        if not resolved.is_file():
            return WorkspaceToolResult(
                ok=False,
                action="replace",
                path=str(resolved),
                summary="Это не редактируемый файл.",
                error="not-a-file",
            )

        size = resolved.stat().st_size
        if size > self.settings.workspace_max_read_bytes:
            return WorkspaceToolResult(
                ok=False,
                action="replace",
                path=str(resolved),
                summary=f"Файл слишком большой для безопасного редактирования: {size} байт.",
                error="file-too-large",
            )
        if is_likely_binary(resolved):
            return WorkspaceToolResult(
                ok=False,
                action="replace",
                path=str(resolved),
                summary="Бинарные файлы через чат не изменяю.",
                error="binary-file",
            )

        content = resolved.read_text(encoding="utf-8", errors="replace")
        occurrences = content.count(old_text)
        if occurrences == 0:
            return WorkspaceToolResult(
                ok=False,
                action="replace",
                path=str(resolved),
                summary="Не нашел точный фрагмент для замены.",
                error="old-text-not-found",
            )
        if occurrences > 1:
            return WorkspaceToolResult(
                ok=False,
                action="replace",
                path=str(resolved),
                summary=f"Фрагмент найден {occurrences} раза. Укажи более уникальный кусок текста.",
                error="ambiguous-old-text",
            )

        updated = content.replace(old_text, new_text, 1)
        encoded = updated.encode("utf-8")
        if len(encoded) > self.settings.workspace_max_write_bytes:
            return WorkspaceToolResult(
                ok=False,
                action="replace",
                path=str(resolved),
                summary=f"После замены файл превысит безопасный лимит {self.settings.workspace_max_write_bytes} байт.",
                error="file-too-large",
            )

        resolved.write_text(updated, encoding="utf-8")
        return WorkspaceToolResult(
            ok=True,
            action="replace",
            path=str(resolved),
            bytes=len(encoded),
            summary=f"Заменил фрагмент в {self._display_path(resolved)}.",
        )

    def mkdir(self, raw_path: str, *, ensure_unique: bool = False) -> WorkspaceToolResult:
        resolved = self._resolve(raw_path, "mkdir")
        if isinstance(resolved, WorkspaceToolResult):
            return resolved
        if ensure_unique:
            resolved = next_available_directory_path(resolved)

        if resolved.exists() and not resolved.is_dir():
            return WorkspaceToolResult(
                ok=False,
                action="mkdir",
                path=str(resolved),
                summary="По этому пути уже есть файл.",
                error="file-exists",
            )
        if resolved.exists() and resolved.is_dir():
            return WorkspaceToolResult(
                ok=True,
                action="mkdir",
                path=str(resolved),
                summary=f"Папка уже существует: {self._display_path(resolved)}.",
            )

        resolved.mkdir(parents=True, exist_ok=True)
        return WorkspaceToolResult(
            ok=True,
            action="mkdir",
            path=str(resolved),
            summary=f"Создал папку {self._display_path(resolved)}.",
        )

    def read(self, raw_path: str) -> WorkspaceToolResult:
        resolved = self._resolve(raw_path, "read")
        if isinstance(resolved, WorkspaceToolResult):
            return resolved

        if not resolved.is_file():
            return WorkspaceToolResult(
                ok=False,
                action="read",
                path=str(resolved),
                summary="Это не читаемый файл.",
                error="not-a-file",
            )

        size = resolved.stat().st_size
        if size > self.settings.workspace_max_read_bytes:
            return WorkspaceToolResult(
                ok=False,
                action="read",
                path=str(resolved),
                summary=f"Файл слишком большой для безопасного чтения: {size} байт.",
                error="file-too-large",
            )
        if is_likely_binary(resolved):
            return WorkspaceToolResult(
                ok=False,
                action="read",
                path=str(resolved),
                summary="Бинарные файлы через чат не читаю.",
                error="binary-file",
            )

        content = resolved.read_text(encoding="utf-8", errors="replace")
        return WorkspaceToolResult(
            ok=True,
            action="read",
            path=str(resolved),
            content=content,
            bytes=size,
            summary=f"Прочитал файл {self._display_path(resolved)}.",
        )

    def list(
        self,
        raw_path: str,
        *,
        recursive: bool = False,
        limit: int = 120,
        entry_type: str = "",
        extension: str = "",
    ) -> WorkspaceToolResult:
        resolved = self._resolve(raw_path or ".", "list", allow_root=True)
        if isinstance(resolved, WorkspaceToolResult):
            return resolved

        if not resolved.exists():
            return WorkspaceToolResult(
                ok=False,
                action="list",
                path=str(resolved),
                summary="Папка или файл не существует.",
                error="not-found",
            )

        normalized_entry_type = entry_type if entry_type in {"file", "directory"} else ""
        normalized_extension = normalize_file_extension(extension)
        policy_root = self.root if is_within(resolved, self.root) else matching_local_read_root(resolved)
        entries: list[WorkspaceEntry] = []
        paths = [resolved]
        while paths and len(entries) < limit:
            current = paths.pop(0)
            if policy_root is not None and should_skip_path(current, policy_root):
                continue
            if current.is_file():
                if workspace_entry_matches(current, normalized_entry_type, normalized_extension):
                    entries.append(to_entry(current, self.root))
                continue
            if not current.is_dir():
                continue
            for child in sorted(current.iterdir(), key=lambda item: (item.is_file(), item.name.lower())):
                if len(entries) >= limit:
                    break
                if policy_root is not None and should_skip_path(child, policy_root):
                    continue
                if workspace_entry_matches(child, normalized_entry_type, normalized_extension):
                    entries.append(to_entry(child, self.root))
                if recursive and child.is_dir():
                    paths.append(child)

        return WorkspaceToolResult(
            ok=True,
            action="list",
            path=str(resolved),
            entries=entries,
            summary=f"Показал {len(entries)} элементов в {self._display_path(resolved)}.",
        )

    def search(self, query: str, raw_path: str = ".", *, limit: int = 40) -> WorkspaceToolResult:
        query = normalize_space(query)
        if not query:
            return WorkspaceToolResult(
                ok=False,
                action="search",
                query=query,
                summary="Запрос для поиска пустой.",
                error="empty-query",
            )

        resolved = self._resolve(raw_path or ".", "search", allow_root=True)
        if isinstance(resolved, WorkspaceToolResult):
            return resolved

        if not resolved.exists():
            return WorkspaceToolResult(
                ok=False,
                action="search",
                path=str(resolved),
                query=query,
                summary="Папка или файл не существует.",
                error="not-found",
            )

        policy_root = self.root if is_within(resolved, self.root) else matching_local_read_root(resolved)
        roots = [resolved]
        matches: list[WorkspaceMatch] = []
        needle = query.lower()
        while roots and len(matches) < limit:
            current = roots.pop(0)
            if should_skip_path(current, policy_root):
                continue
            if current.is_dir():
                roots.extend(sorted(current.iterdir(), key=lambda item: item.name.lower()))
                continue
            if not current.is_file() or is_likely_binary(current):
                continue
            if current.stat().st_size > self.settings.workspace_search_file_bytes:
                continue

            text = current.read_text(encoding="utf-8", errors="ignore")
            for line_no, line in enumerate(text.splitlines(), start=1):
                if len(matches) >= limit:
                    break
                if needle in line.lower():
                    matches.append(
                        WorkspaceMatch(
                            path=str(current),
                            line=line_no,
                            preview=line.strip()[:240],
                        )
                    )

        return WorkspaceToolResult(
            ok=True,
            action="search",
            path=str(resolved),
            query=query,
            matches=matches,
            summary=f"Нашел {len(matches)} совпадений по '{query}'.",
        )

    def _resolve(
        self,
        raw_path: str,
        action: str,
        *,
        allow_root: bool = False,
        result_action: str | None = None,
    ) -> Path | WorkspaceToolResult:
        response_action = result_action or (action if action in WORKSPACE_ACTIONS else "search")
        original = normalize_space(raw_path)
        if not original and action == "write":
            original = str(self.generated_dir / f"oscar-note-{timestamp_slug()}.md")
        if not original:
            return WorkspaceToolResult(
                ok=False,
                action=response_action,
                summary="Не вижу путь к файлу или папке.",
                error="empty-path",
            )
        if "\0" in original:
            return WorkspaceToolResult(
                ok=False,
                action=response_action,
                summary="Путь содержит недопустимый символ.",
                error="invalid-path",
            )

        candidate = Path(expand_user_path(original))
        resolved = (candidate if candidate.is_absolute() else self.root / candidate).resolve()
        in_workspace = is_within(resolved, self.root)
        external_read_root = matching_local_read_root(resolved)
        if not in_workspace and external_read_root is not None and action not in LOCAL_USER_ROOT_ACTIONS:
            return WorkspaceToolResult(
                ok=False,
                action=response_action,
                path=str(resolved),
                summary="Этот локальный путь доступен только для просмотра и создания папок; другие изменения вне workspace заблокированы.",
                error="read-only-local-root",
            )
        if not in_workspace and external_read_root is None:
            return WorkspaceToolResult(
                ok=False,
                action=response_action,
                path=str(resolved),
                summary="Путь выходит за пределы workspace.",
                error="outside-workspace",
            )
        if in_workspace and not allow_root and same_path(resolved, self.root):
            return WorkspaceToolResult(
                ok=False,
                action=response_action,
                path=str(resolved),
                summary="Нужно указать файл или вложенную папку, а не корень workspace.",
                error="workspace-root-blocked",
            )
        policy_root = self.root if in_workspace else external_read_root
        if policy_root is not None and has_blocked_part(resolved, policy_root):
            return WorkspaceToolResult(
                ok=False,
                action=response_action,
                path=str(resolved),
                summary="Этот путь находится в защищенной зоне workspace.",
                error="protected-path",
            )
        return resolved

    def _resolve_trash_source(self, raw_path: str) -> Path | WorkspaceToolResult:
        original = normalize_space(raw_path)
        if not original:
            return WorkspaceToolResult(
                ok=False,
                action="restore",
                summary="Не вижу путь к файлу или папке в корзине Oscar.",
                error="empty-path",
            )
        if "\0" in original:
            return WorkspaceToolResult(
                ok=False,
                action="restore",
                summary="Путь содержит недопустимый символ.",
                error="invalid-path",
            )

        trash_root = self.root / ".oscar-trash"
        candidate = Path(original)
        if candidate.is_absolute():
            resolved = candidate.resolve()
        elif candidate.parts and candidate.parts[0] == ".oscar-trash":
            resolved = (self.root / candidate).resolve()
        else:
            resolved = (trash_root / candidate).resolve()

        if not is_within(resolved, trash_root) or same_path(resolved, trash_root):
            return WorkspaceToolResult(
                ok=False,
                action="restore",
                path=str(resolved),
                summary="Восстанавливать можно только из корзины Oscar.",
                error="outside-trash",
            )
        if not resolved.exists():
            return WorkspaceToolResult(
                ok=False,
                action="restore",
                path=str(resolved),
                summary="Файл или папка в корзине Oscar не найдены.",
                error="not-found",
            )
        return resolved

    def _resolve_restore_target(self, source: Path, raw_target_path: str) -> Path | WorkspaceToolResult:
        target_text = normalize_space(raw_target_path)
        if target_text:
            return self._resolve(target_text, "restore")

        trash_root = self.root / ".oscar-trash"
        try:
            relative = source.relative_to(trash_root)
        except ValueError:
            relative = Path()

        if len(relative.parts) < 2:
            return WorkspaceToolResult(
                ok=False,
                action="restore",
                path=str(source),
                summary="Не могу определить исходный путь. Укажи target_path для восстановления.",
                error="missing-target-path",
            )
        return self._resolve(str(Path(*relative.parts[1:])), "restore")

    def _display_path(self, resolved: Path) -> str:
        try:
            return str(resolved.relative_to(self.root))
        except ValueError:
            return str(resolved)


def detect_explicit_workspace_capability(text: str) -> WorkspaceCommand | None:
    candidate = text.strip()
    if candidate.startswith("```") and candidate.endswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*|\s*```$", "", candidate, flags=re.IGNORECASE)
    if not candidate.startswith("{"):
        return None
    try:
        payload = json.loads(candidate)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None

    capability = payload.get("capability") or payload.get("capabilityId") or payload.get("name")
    parameters = payload.get("parameters") or payload.get("arguments") or payload.get("input") or {}
    if not isinstance(capability, str) or not isinstance(parameters, dict):
        return None

    action_by_capability = {
        "workspace.files.read": "read",
        "workspace.files.list": "list",
        "workspace.files.search": "search",
        "workspace.files.write": "write",
        "workspace.files.append": "append",
        "workspace.files.replace": "replace",
        "workspace.files.mkdir": "mkdir",
        "workspace.files.copy": "copy",
        "workspace.files.move": "move",
        "workspace.files.delete": "trash",
    }
    action = action_by_capability.get(capability.strip())
    if action is None:
        return None

    def string_value(*keys: str) -> str:
        value = next((parameters.get(key) for key in keys if key in parameters), "")
        return value.strip() if isinstance(value, str) else ""

    return WorkspaceCommand(
        action=action,
        path=string_value("path") or ("." if action == "list" else ""),
        target_path=string_value("targetPath", "target_path"),
        content=string_value("content"),
        old_text=string_value("oldText", "old_text"),
        new_text=string_value("newText", "new_text"),
        query=string_value("query"),
        overwrite=parameters.get("overwrite") is True,
        entry_type=string_value("entryType", "entry_type"),
        extension=string_value("extension"),
    )


def is_workspace_list_request(lower: str) -> bool:
    action = r"(?:list|show|view|inspect|browse|покажи|выведи|перечисли|посмотри|просмотри|показать|посмотреть|просмотреть)"
    target = r"(?:files?|folders?|director(?:y|ies)|файлы?|папк\w*|директор\w*|содержим\w*|названи\w*)"
    return bool(
        re.search(rf"\b{action}\b.{{0,80}}\b{target}\b", lower, flags=re.IGNORECASE)
        or re.search(rf"\b{target}\b.{{0,48}}\b{action}\b", lower, flags=re.IGNORECASE)
        or re.search(r"\b(?:folder|directory)\s+contents\b|\b(?:содержим|содержание)\s+(?:папк|директор)", lower)
    )


def detect_requested_entry_type(lower: str) -> str:
    has_file = bool(re.search(r"\bfiles?\b|\bфайл\w*\b", lower))
    has_directory = bool(re.search(r"\bfolders?\b|\bdirector(?:y|ies)\b|\bпапк\w*\b|\bдиректор\w*\b", lower))
    if has_directory and not has_file:
        return "directory"
    if has_file and not has_directory:
        return "file"
    return ""


def detect_requested_extension(lower: str) -> str:
    dotted = re.search(r"(?<![\w.])\.(?P<extension>[a-z0-9]{1,12})\b", lower, flags=re.IGNORECASE)
    if dotted:
        return f".{dotted.group('extension').lower()}"
    language_file = re.search(r"\b(?P<extension>java|py|js|jsx|ts|tsx|md|txt|json|yaml|yml|toml|css|html)\s+файл", lower)
    return f".{language_file.group('extension').lower()}" if language_file else ""


def detect_workspace_command(text: str) -> WorkspaceCommand | None:
    normalized = normalize_space(text)
    lower = normalized.lower()
    if not normalized:
        return None
    explicit_command = detect_explicit_workspace_capability(normalized)
    if explicit_command is not None:
        return explicit_command
    if re.search(r"^(how|what|why|как|что|почему)\b", lower):
        if not re.search(r"^(?:что\s+(?:лежит|находится)|что\s+внутри)\b", lower):
            return None

    standalone_path = strip_quotes(normalized)
    if is_standalone_workspace_path(standalone_path):
        action = "read" if looks_like_text_file_path(standalone_path) else "list"
        return WorkspaceCommand(action=action, path=standalone_path)

    described_path = next((value for value in extract_quoted(normalized) if looks_like_workspace_path(value)), "")
    if described_path and re.search(
        r"(?:содержим|содержание|что\s+(?:лежит|находится)|покажи\s+(?:папку|директорию)|folder\s+contents|directory\s+contents|what(?:'s|\s+is)\s+in)",
        lower,
    ):
        action = "read" if looks_like_text_file_path(described_path) else "list"
        return WorkspaceCommand(action=action, path=described_path)

    bare_read_path = extract_path_after_bare_action(
        normalized,
        r"(?:read|open|прочитай|открой)",
    )
    if looks_like_workspace_path(bare_read_path):
        return WorkspaceCommand(action="read", path=bare_read_path)

    bare_show_path = extract_path_after_bare_action(
        normalized,
        r"(?:show|list|покажи|выведи|список)",
    )
    if looks_like_workspace_path(bare_show_path):
        action = "read" if looks_like_text_file_path(bare_show_path) else "list"
        return WorkspaceCommand(action=action, path=bare_show_path)

    if re.search(r"\b(read|open|show)\s+file\b|(?:прочитай|открой|покажи)\s+файл", lower):
        return WorkspaceCommand(action="read", path=extract_path_after_file(normalized))

    if is_workspace_list_request(lower):
        return WorkspaceCommand(
            action="list",
            path=extract_path_after_location(normalized) or extract_known_location(normalized) or ".",
            entry_type=detect_requested_entry_type(lower),
            extension=detect_requested_extension(lower),
        )

    if re.search(r"\b(?:mkdir|create)\s+(?:[\w-]+\s+){0,3}(?:folder|directory)\b|(?:создай|создать|сделай|сделать)\s+(?:[\wа-яё-]+\s+){0,3}(?:папку|директорию)", lower):
        path_text, ensure_unique = extract_directory_target(normalized)
        return WorkspaceCommand(action="mkdir", path=path_text, ensure_unique=ensure_unique)

    if re.search(r"\b(copy|duplicate)\b.*\b(file|folder|directory)\b|(?:скопируй|дублируй)\s+(?:файл|папку|директорию)", lower):
        return WorkspaceCommand(
            action="copy",
            path=extract_path_after_file_or_folder(normalized),
            target_path=extract_target_path(normalized),
        )

    if re.search(r"\b(move|rename)\b.*\b(file|folder|directory)\b|(?:перемести|переименуй)\s+(?:файл|папку|директорию)", lower):
        return WorkspaceCommand(
            action="move",
            path=extract_path_after_file_or_folder(normalized),
            target_path=extract_target_path(normalized),
        )

    if re.search(r"\b(trash|remove|delete)\b.*\b(file|folder|directory)\b|(?:удали|убери|перемести\s+в\s+корзину)\s+(?:файл|папку|директорию)", lower):
        return WorkspaceCommand(action="trash", path=extract_path_after_file_or_folder(normalized))

    if re.search(r"\brestore\b.*\b(file|folder|directory)\b|(?:восстанови|верни)\s+(?:файл|папку|директорию)", lower):
        return WorkspaceCommand(
            action="restore",
            path=extract_path_after_file_or_folder(normalized),
            target_path=extract_target_path(normalized),
        )

    if re.search(r"\b(search|find|grep)\b.*\bfiles?\b|(?:найди|ищи|поиск)\s+в\s+файлах", lower):
        return WorkspaceCommand(
            action="search",
            query=extract_search_query(normalized),
            path=extract_path_after_location(normalized) or extract_known_location(normalized) or ".",
        )

    if re.search(r"^(?:search|find|grep|найди|ищи|поиск)\b", lower):
        location = extract_path_after_location(normalized) or extract_known_location(normalized)
        has_workspace_scope = bool(re.search(r"\b(workspace|project|repo|проекте|проект|репозитории|репозиторий|файлах)\b", lower))
        if looks_like_workspace_path(location) or has_workspace_scope:
            return WorkspaceCommand(
                action="search",
                query=extract_search_query(normalized),
                path=location if looks_like_workspace_path(location) else ".",
            )

    if re.search(r"\b(append|add)\b.*\bfile\b|(?:допиши|добавь)\s+(?:в\s+)?файл", lower):
        quoted = extract_quoted(normalized)
        path_text = extract_path_after_file(normalized)
        content = extract_content(normalized)
        if not path_text and quoted:
            path_text = quoted[0]
            if len(quoted) > 1 and not content:
                content = quoted[1]
        if not looks_like_workspace_path(path_text):
            return None
        return WorkspaceCommand(action="append", path=path_text, content=content)

    if re.search(r"\breplace\b.*\bfile\b|(?:замени|заменить)\s+(?:текст\s+)?(?:в\s+)?файл(?:е|а)?", lower):
        quoted = extract_quoted(normalized)
        path_text = extract_path_after_file(normalized)
        old_text, new_text = extract_replace_texts(normalized, quoted, path_text)
        if not path_text and len(quoted) >= 3:
            path_text = quoted[0]
        if not looks_like_workspace_path(path_text):
            return None
        return WorkspaceCommand(action="replace", path=path_text, old_text=old_text, new_text=new_text)

    if re.search(r"\b(write|create|save)\b.*\bfile\b|(?:создай|запиши|сохрани|перезапиши)\s+файл", lower):
        quoted = extract_quoted(normalized)
        path_text = extract_path_after_file(normalized)
        content = extract_content(normalized)
        if not path_text and quoted:
            path_text = quoted[0]
            if len(quoted) > 1 and not content:
                content = quoted[1]
        if not looks_like_workspace_path(path_text):
            return None
        return WorkspaceCommand(
            action="write",
            path=path_text,
            content=content,
            overwrite=bool(re.search(r"\b(overwrite|replace)\b|перезапиши|замени", lower)),
        )

    if re.search(r"^(?:write|create|save|создай|запиши|сохрани|перезапиши)\b", lower):
        path_text = extract_bare_write_path(normalized) or extract_target_path(normalized)
        if looks_like_text_file_path(path_text):
            content = extract_bare_write_content(normalized, path_text) or extract_content(normalized)
            return WorkspaceCommand(
                action="write",
                path=path_text,
                content=content,
                overwrite=bool(re.search(r"\b(overwrite|replace)\b|перезапиши|замени", lower)),
            )

    return None


def detect_incomplete_workspace_command(text: str) -> WorkspaceToolResult | None:
    normalized = normalize_space(text)
    lower = normalized.lower()
    if not normalized:
        return None
    if re.search(r"^(how|what|why|как|что|почему)\b", lower):
        return None

    action = incomplete_workspace_action(lower)
    if action is None:
        return None

    return WorkspaceToolResult(
        ok=False,
        action=action,
        summary=(
            "Не выполнил workspace-действие: не удалось однозначно определить путь. "
            "Укажи точный путь внутри workspace, например artifacts/generated/note.md, "
            "и текст файла, если его нужно записать."
        ),
        error="workspace-command-incomplete",
    )


def incomplete_workspace_action(lower: str) -> str | None:
    if re.search(r"\b(write|create|save)\b.*\bfile\b|(?:создай|создать|запиши|записать|сохрани|сохранить|перезапиши).{0,80}(?:файл|документ)", lower):
        return "write"
    if re.search(r"\b(append|add)\b.*\bfile\b|(?:допиши|добавь)\s+(?:в\s+)?файл", lower):
        return "append"
    if re.search(r"\breplace\b.*\bfile\b|(?:замени|заменить)\s+(?:текст\s+)?(?:в\s+)?файл(?:е|а)?", lower):
        return "replace"
    if re.search(r"\b(?:mkdir|create)\s+(?:[\w-]+\s+){0,3}(?:folder|directory)\b|(?:создай|создать|сделай|сделать)\s+(?:[\wа-яё-]+\s+){0,3}(?:папку|директорию)", lower):
        return "mkdir"
    if re.search(r"\b(copy|duplicate)\b.*\b(file|folder|directory)\b|(?:скопируй|дублируй)\s+(?:файл|папку|директорию)", lower):
        return "copy"
    if re.search(r"\b(move|rename)\b.*\b(file|folder|directory)\b|(?:перемести|переименуй)\s+(?:файл|папку|директорию)", lower):
        return "move"
    if re.search(r"\b(trash|remove|delete)\b.*\b(file|folder|directory)\b|(?:удали|убери|перемести\s+в\s+корзину)\s+(?:файл|папку|директорию)", lower):
        return "trash"
    if is_workspace_list_request(lower):
        return "list"
    return None


def detect_workspace_commands(text: str) -> list[WorkspaceCommand]:
    batch = detect_workspace_batch_commands(text)
    if batch:
        return batch

    multi = detect_workspace_multi_commands(text)
    if len(multi) > 1:
        return multi[:MAX_DETECTED_BATCH_COMMANDS]

    command = detect_workspace_command(text)
    return [command] if command is not None else []


def detect_workspace_multi_commands(text: str) -> list[WorkspaceCommand]:
    normalized = text.strip()
    if not normalized:
        return []
    if re.search(r"^(how|what|why|как|что|почему)\b", normalize_space(normalized.lower())):
        return []

    segments = split_workspace_instruction_segments(normalized)
    if len(segments) < 2:
        return []

    commands: list[WorkspaceCommand] = []
    for segment in segments:
        command = detect_workspace_command(segment)
        if command is None and commands:
            command = detect_implicit_workspace_segment(segment)
        if command is not None:
            commands.append(command)
        if len(commands) >= MAX_DETECTED_BATCH_COMMANDS:
            break

    return commands if len(commands) > 1 else []


def detect_implicit_workspace_segment(text: str) -> WorkspaceCommand | None:
    normalized = normalize_space(text)
    lower = normalized.lower()
    if re.search(r"^(?:file|файл)\b", lower):
        return WorkspaceCommand(
            action="write",
            path=extract_path_after_file(normalized),
            content=extract_content(normalized),
        )
    if re.search(r"^(?:folder|directory|папку|директорию)\b", lower):
        path_text, ensure_unique = extract_directory_target(normalized)
        return WorkspaceCommand(action="mkdir", path=path_text, ensure_unique=ensure_unique)
    return None


def split_workspace_instruction_segments(text: str) -> list[str]:
    segments: list[str] = []
    current: list[str] = []
    quote_char = ""
    index = 0

    while index < len(text):
        char = text[index]

        if quote_char:
            current.append(char)
            if char == quote_char:
                quote_char = ""
            index += 1
            continue

        if char in {"\"", "'", "`"}:
            quote_char = char
            current.append(char)
            index += 1
            continue

        if char in {";", "\n"}:
            append_instruction_segment(segments, current)
            index += 1
            continue

        connector_length = workspace_connector_length(text, index)
        if connector_length:
            append_instruction_segment(segments, current)
            index += connector_length
            continue

        current.append(char)
        index += 1

    append_instruction_segment(segments, current)
    return segments


def workspace_connector_length(text: str, index: int) -> int:
    lowered = text.lower()
    for connector in (" и ", " затем ", " потом ", " and ", " then "):
        if not lowered.startswith(connector, index):
            continue
        after = text[index + len(connector):].lstrip()
        if NATURAL_COMMAND_START_RE.match(after):
            return len(connector)
    return 0


def append_instruction_segment(segments: list[str], current: list[str]) -> None:
    segment = normalize_space("".join(current))
    current.clear()
    if segment:
        segments.append(segment)


def detect_workspace_batch_commands(text: str) -> list[WorkspaceCommand]:
    normalized = text.strip()
    lower = normalized.lower()
    if not normalized:
        return []
    if re.search(r"^(how|what|why|как|что|почему)\b", normalize_space(lower)):
        return []
    if not looks_like_batch_request(lower):
        return []

    json_commands = parse_workspace_batch_json(normalized)
    if json_commands:
        return json_commands[:MAX_DETECTED_BATCH_COMMANDS]

    overwrite = bool(re.search(r"\b(overwrite|replace)\b|перезапиши|замени", lower))
    structure_commands = parse_workspace_structure_lines(normalized, overwrite=overwrite)
    if structure_commands:
        return structure_commands[:MAX_DETECTED_BATCH_COMMANDS]

    commands: list[WorkspaceCommand] = []
    for line in normalized.splitlines():
        command = parse_batch_file_line(line, overwrite=overwrite)
        if command is not None:
            commands.append(command)
        if len(commands) >= MAX_DETECTED_BATCH_COMMANDS:
            break

    return commands


def looks_like_batch_request(lower: str) -> bool:
    return bool(
        re.search(r"\bworkspace\s+batch\b|\bbatch\s+workspace\b|\bcreate\s+files\b|\bwrite\s+files\b", lower)
        or re.search(r"\b(?:project|workspace|folder|file)\s+structure\b|\bscaffold\b", lower)
        or re.search(r"(?:создай|запиши|сохрани|перезапиши)\s+файлы", lower)
        or re.search(r"(?:создай|сделай|сгенерируй|собери)\s+(?:структуру|дерево|скелет)", lower)
        or re.search(r"\bпакет\s+(?:файлов|действий|workspace)", lower)
    )


def parse_workspace_batch_json(text: str) -> list[WorkspaceCommand]:
    candidates: list[str] = []
    for match in re.finditer(r"```(?:json)?\s*(?P<body>[\s\S]*?)```", text, flags=re.IGNORECASE):
        body = match.group("body").strip()
        if body.startswith(("[", "{")):
            candidates.append(body)

    stripped = text.strip()
    if stripped.startswith(("[", "{")):
        candidates.append(stripped)

    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue

        items = payload.get("actions") if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            continue

        commands: list[WorkspaceCommand] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            action = normalize_space(str(item.get("action") or "write")).lower()
            if action not in WORKSPACE_ACTIONS:
                continue
            commands.append(
                WorkspaceCommand(
                    action=action,
                    path=normalize_space(str(item.get("path") or "")),
                    target_path=normalize_space(str(item.get("target_path") or item.get("targetPath") or "")),
                    content=str(item.get("content") or ""),
                    old_text=str(item.get("old_text") or item.get("oldText") or ""),
                    new_text=str(item.get("new_text") or item.get("newText") or ""),
                    query=normalize_space(str(item.get("query") or "")),
                    overwrite=bool(item.get("overwrite")),
                )
            )
            if len(commands) >= MAX_DETECTED_BATCH_COMMANDS:
                break
        if commands:
            return commands

    return []


def parse_workspace_structure_lines(text: str, *, overwrite: bool) -> list[WorkspaceCommand]:
    commands: list[WorkspaceCommand] = []
    directory_by_depth: dict[int, str] = {}

    for raw_line in text.splitlines():
        parsed = parse_structure_line(raw_line)
        if parsed is None:
            continue
        depth, entry_text = parsed
        if is_structure_intro_line(entry_text):
            continue

        entry_path, content = split_structure_entry(entry_text)
        entry_path = strip_quotes(entry_path).strip()
        if not entry_path or "\0" in entry_path:
            continue

        is_directory = entry_path.endswith(("/", "\\"))
        normalized_entry = entry_path.rstrip("/\\") if is_directory else entry_path
        if not normalized_entry:
            continue

        path = resolve_structure_entry_path(normalized_entry, depth, directory_by_depth)
        if is_directory:
            commands.append(WorkspaceCommand(action="mkdir", path=path))
            directory_by_depth = {level: value for level, value in directory_by_depth.items() if level < depth}
            directory_by_depth[depth] = path
        elif looks_like_structure_file_path(path):
            commands.append(
                WorkspaceCommand(
                    action="write",
                    path=path,
                    content=content or "",
                    overwrite=overwrite,
                )
            )
        else:
            continue

        if len(commands) >= MAX_DETECTED_BATCH_COMMANDS:
            break

    return commands


def parse_structure_line(raw_line: str) -> tuple[int, str] | None:
    line = raw_line.rstrip()
    if not line.strip():
        return None

    stripped = line.strip()
    if stripped.startswith(("```", "#", "//")):
        return None

    leading_spaces = len(line.expandtabs(4)) - len(line.expandtabs(4).lstrip(" "))
    has_tree_connector = bool(re.match(r"^(?:[│|]\s{2,4}|\s{4})*(?:[├└][─-]{2,}|\+--|`--)\s*", stripped))
    depth = max(leading_spaces // 2, count_tree_depth(stripped)) + (1 if has_tree_connector else 0)
    entry = strip_tree_prefix(stripped)
    entry = re.sub(r"^(?:[-*+]\s+)", "", entry).strip()
    if not entry:
        return None
    return depth, entry


def count_tree_depth(stripped: str) -> int:
    depth = 0
    cursor = stripped
    while True:
        match = re.match(r"^(?:[│|]\s{2,4}|\s{4})", cursor)
        if not match:
            break
        depth += 1
        cursor = cursor[match.end():]
    return depth


def strip_tree_prefix(stripped: str) -> str:
    cleaned = stripped
    while True:
        updated = re.sub(r"^(?:[│|]\s{2,4}|\s{4})", "", cleaned)
        if updated == cleaned:
            break
        cleaned = updated
    return re.sub(r"^(?:[├└][─-]{2,}|\+--|`--)\s*", "", cleaned).strip()


def is_structure_intro_line(entry: str) -> bool:
    lowered = entry.lower().rstrip(":")
    return bool(
        re.search(r"^(?:workspace\s+batch|batch\s+workspace)$", lowered)
        or re.search(r"^(?:создай|сделай|сгенерируй|собери).*(?:структуру|дерево|скелет|проект)", lowered)
        or re.search(r"^(?:project|workspace|folder|file)\s+structure$", lowered)
        or lowered in {"structure", "структура", "дерево", "scaffold"}
    )


def split_structure_entry(entry: str) -> tuple[str, str]:
    match = re.match(r"(?P<path>`[^`]+`|\"[^\"]+\"|'[^']+'|[^:=]+?)\s*(?:=>|=|:)\s*(?P<content>.*)$", entry, flags=re.DOTALL)
    if not match:
        return entry, ""
    return match.group("path"), strip_quotes(match.group("content").strip())


def resolve_structure_entry_path(entry: str, depth: int, directory_by_depth: dict[int, str]) -> str:
    parent = nearest_structure_parent(depth, directory_by_depth)
    if parent and should_join_structure_parent(entry, parent):
        return join_workspace_path(parent, entry)
    return entry


def nearest_structure_parent(depth: int, directory_by_depth: dict[int, str]) -> str:
    for level in range(depth - 1, -1, -1):
        parent = directory_by_depth.get(level)
        if parent:
            return parent
    return ""


def should_join_structure_parent(entry: str, parent: str) -> bool:
    entry_path = Path(entry)
    if entry_path.is_absolute() or re.match(r"^[A-Za-z]:[\\/]", entry):
        return False
    normalized_entry = entry.replace("\\", "/").lstrip("./")
    normalized_parent = parent.replace("\\", "/").rstrip("/")
    if normalized_entry.startswith(normalized_parent + "/"):
        return False
    if normalized_entry.startswith(("artifacts/", ".oscar-trash/")):
        return False
    return True


def join_workspace_path(parent: str, child: str) -> str:
    clean_parent = parent.rstrip("/\\")
    clean_child = child.lstrip("/\\")
    return f"{clean_parent}/{clean_child}"


def parse_batch_file_line(line: str, *, overwrite: bool) -> WorkspaceCommand | None:
    stripped = line.strip()
    if not stripped:
        return None

    match = re.match(
        r"^(?:[-*]\s*)?(?:file|файл)?\s*(?P<path>`[^`]+`|\"[^\"]+\"|'[^']+'|[^\s:=]+)\s*(?:=>|=|:)\s*(?P<content>.+)$",
        stripped,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None

    path = strip_quotes(match.group("path"))
    if not looks_like_text_file_path(path):
        return None

    content = strip_quotes(match.group("content").strip())
    return WorkspaceCommand(action="write", path=path, content=content, overwrite=overwrite)


def looks_like_text_file_path(path: str) -> bool:
    if not path or "\0" in path:
        return False
    suffix = Path(path).suffix.lower()
    if suffix not in TEXT_BATCH_EXTENSIONS:
        return False
    return "/" in path or "\\" in path


def looks_like_structure_file_path(path: str) -> bool:
    return bool(path and "\0" not in path and Path(path).suffix.lower() in TEXT_BATCH_EXTENSIONS)


def render_workspace_answer(result: WorkspaceToolResult) -> str:
    if result.error == "kernel-execution-required" and result.details and result.details.get("commands"):
        count = len(result.details.get("commands") or [])
        return (
            f"Подготовлено типизированных действий: {count}. "
            "Monarch Kernel проверяет область, разрешения и фактический результат."
        )

    if not result.ok:
        return f"Не получилось выполнить действие: {result.summary}"

    if result.action == "root":
        return result.summary

    if result.action == "read":
        excerpt = (result.content or "").strip()
        if len(excerpt) > 1800:
            excerpt = excerpt[:1800].rstrip() + "\n..."
        return f"{result.summary}\n\n```text\n{excerpt}\n```"

    if result.action == "list":
        lines = [f"- {entry.name}{'/' if entry.type == 'directory' else ''}" for entry in result.entries[:40]]
        return result.summary + ("\n\n" + "\n".join(lines) if lines else "")

    if result.action == "search":
        lines = [
            f"- {match.path}:{match.line} - {match.preview}"
            for match in result.matches[:20]
        ]
        return result.summary + ("\n\n" + "\n".join(lines) if lines else "")

    if result.action in {"replace", "copy", "move", "trash", "restore"}:
        return result.summary

    return result.summary


def render_workspace_batch_answer(results: list[WorkspaceToolResult]) -> str:
    if not results:
        return "Не нашел workspace-действий для выполнения."

    ok_count = sum(1 for result in results if result.ok)
    lines = [
        f"- {'OK' if result.ok else 'ERR'} {format_workspace_action_label(result.action)}: {result.summary}"
        for result in results
    ]
    return f"Выполнил workspace-пакет: {ok_count}/{len(results)} успешно.\n\n" + "\n".join(lines)


def format_workspace_action_label(action: str) -> str:
    labels = {
        "root": "рабочее пространство",
        "write": "создание",
        "append": "дописывание",
        "replace": "замена",
        "mkdir": "папка",
        "read": "чтение",
        "list": "список",
        "search": "поиск",
        "copy": "копирование",
        "move": "перемещение",
        "trash": "корзина",
        "restore": "восстановление",
    }
    return labels.get(action, action)


def extract_path_after_file(text: str) -> str:
    match = re.search(
        r"(?:file|файл(?:е|а)?)\s+(?:path\s+|путь\s+|named\s+|called\s+|с\s+именем\s+)?(?P<path>\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s,;]+)",
        text,
        flags=re.IGNORECASE,
    )
    return strip_quotes(match.group("path")) if match else ""


def extract_path_after_folder(text: str) -> str:
    match = re.search(
        r"(?:folder|directory|папку|директорию)\s+(?P<path>\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s,;]+)",
        text,
        flags=re.IGNORECASE,
    )
    candidate = strip_quotes(match.group("path")) if match else ""
    return "" if is_generic_location_token(candidate) or is_generated_name_placeholder(candidate) else candidate


def extract_directory_target(text: str) -> tuple[str, bool]:
    known_location = extract_known_location(text)
    folder_text = (
        extract_assigned_workspace_object_name(text)
        or extract_path_after_folder(text)
        or extract_described_directory_name(text)
    )
    wants_unique_default = wants_unnamed_new_directory(text) and not folder_text

    if known_location:
        relative_name = folder_text if folder_text and not looks_like_workspace_path(folder_text) else ""
        target_name = relative_name or default_new_directory_name(text)
        target_path = Path(target_name)
        if not target_path.is_absolute():
            target_path = Path(known_location) / target_path
        return str(target_path), wants_unique_default

    return (
        folder_text or (default_new_directory_name(text) if wants_unique_default else ""),
        wants_unique_default,
    )


def extract_assigned_workspace_object_name(text: str) -> str:
    quoted = re.search(
        r"(?:назови|назвать|именуй|назов[её]м|name|call)\s+"
        r"(?:(?:е[её]|его|их|it|them|(?:эту|этот|the)\s+(?:папку|директорию|файл|документ|folder|directory|file|document))\s+)?"
        r"(?:как\s+|as\s+)?(?P<quote>[\"'`])(?P<name>[^\r\n]+?)(?P=quote)",
        text,
        flags=re.IGNORECASE,
    )
    candidate = quoted.group("name") if quoted else ""
    if not candidate:
        bare = re.search(
            r"(?:назови|назвать|именуй|назов[её]м|name|call)\s+"
            r"(?:(?:е[её]|его|их|it|them|(?:эту|этот|the)\s+(?:папку|директорию|файл|документ|folder|directory|file|document))\s+)?"
            r"(?:как\s+|as\s+)?(?P<name>[\wа-яё.-]+(?:\s+[\wа-яё.-]+){0,4}?)"
            r"(?=\s*(?:$|[.,;!?]|(?:и|а|затем|потом|and|then)\s+(?:укажи|покажи|создай|сделай|запиши|открой|show|give|create|make|write|open)\b))",
            text,
            flags=re.IGNORECASE,
        )
        candidate = bare.group("name") if bare else ""

    normalized = candidate.strip().rstrip(".,;:!?")
    if not normalized or len(normalized) > 120 or re.search(r'[\x00\r\n\\/:*?"<>|]', normalized):
        return ""
    if re.fullmatch(
        r"(?:it|them|name|title|folder|directory|file|document|е[её]|его|их|имя|название|папка|директория|файл|документ)",
        normalized,
        flags=re.IGNORECASE,
    ):
        return ""
    return normalized


def extract_described_directory_name(text: str) -> str:
    english = re.search(
        r"\b(?:create|make|mkdir)\s+(?P<name>(?:(?!new\s+)[a-z][a-z0-9_-]*\s+){1,3})(?:folder|directory)\b",
        text,
        flags=re.IGNORECASE,
    )
    if english:
        normalized = normalize_folder_name_words(english.group("name"), language="en")
        if normalized:
            return normalized

    russian = re.search(
        r"(?:^|\s)(?:создай|создать|сделай|сделать)\s+(?P<name>(?:(?!нов\w+\s+)[а-яё-]+\s+){1,3})(?:папку|директорию)\b",
        text,
        flags=re.IGNORECASE,
    )
    if russian:
        normalized = normalize_folder_name_words(russian.group("name"), language="ru")
        if normalized:
            return normalized

    return ""


def normalize_folder_name_words(value: str, *, language: str) -> str:
    words = [
        word.strip()
        for word in strip_trailing_punctuation(value.strip()).split()
        if word.strip() and not is_generic_directory_descriptor(word)
    ]
    if not words:
        return ""
    if language == "ru":
        normalized = [normalize_russian_folder_descriptor(word) for word in words] + ["папка"]
        return " ".join(word.capitalize() if index == 0 else word for index, word in enumerate(normalized))
    normalized = [word.lower() for word in words] + ["folder"]
    return " ".join(word.capitalize() for word in normalized)


def normalize_russian_folder_descriptor(word: str) -> str:
    lowered = word.lower()
    if lowered.endswith("ую"):
        return f"{lowered[:-2]}ая"
    if lowered.endswith("юю"):
        return f"{lowered[:-2]}яя"
    return lowered


def is_generic_directory_descriptor(word: str) -> bool:
    return bool(re.fullmatch(r"(?:new|empty|blank|name|title|названи[ея]?|имя|нов\w*|пуст\w*|обычн\w*)", word, flags=re.IGNORECASE))


def is_generated_name_placeholder(value: str) -> bool:
    normalized = normalize_space(strip_trailing_punctuation(value)).lower()
    return bool(re.fullmatch(r"(?:name|title|названи[ея]?|имя)", normalized, flags=re.IGNORECASE))


def extract_path_after_file_or_folder(text: str) -> str:
    path = extract_path_after_file(text)
    if path:
        return path
    return extract_path_after_folder(text)


def extract_bare_write_path(text: str) -> str:
    action_pattern = r"(?:write|create|save|создай|запиши|сохрани|перезапиши)"
    match = re.search(
        rf"^\s*{action_pattern}\s+(?P<path>\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s,;]+)",
        text,
        flags=re.IGNORECASE,
    )
    if match:
        candidate = strip_trailing_punctuation(strip_quotes(match.group("path")))
        if looks_like_text_file_path(candidate):
            return candidate

    path_token = workspace_path_token_pattern()
    location_match = re.search(
        rf"(?:\s|^)(?:to|into|in|в|на)\s+(?P<path>{path_token})(?:\s|$)",
        text,
        flags=re.IGNORECASE,
    )
    if location_match:
        candidate = strip_trailing_punctuation(strip_quotes(location_match.group("path")))
        if looks_like_text_file_path(candidate):
            return candidate

    return ""


def extract_bare_write_content(text: str, path: str) -> str:
    path_pattern = re.escape(path)
    action_pattern = r"(?:write|create|save|создай|запиши|сохрани|перезапиши)"

    after_path_match = re.search(
        rf"^\s*{action_pattern}\s+{path_pattern}\s+(?:with\s+(?:text|content)|content|text|с\s+(?:текстом|содержимым)|текстом|текст)\s*[:\-]?\s*(?P<content>.+)$",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if after_path_match:
        return strip_quotes(after_path_match.group("content").strip())

    before_path_match = re.search(
        rf"^\s*{action_pattern}\s+(?P<content>.+?)\s+(?:to|into|in|в|на)\s+{path_pattern}\s*$",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if before_path_match:
        return strip_quotes(before_path_match.group("content").strip())

    location_first_match = re.search(
        rf"^\s*{action_pattern}\s+(?:to|into|in|в|на)\s+{path_pattern}\s+(?:with\s+(?:text|content)|content|text|с\s+(?:текстом|содержимым)|текстом|текст)\s*[:\-]?\s*(?P<content>.+)$",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if location_first_match:
        return strip_quotes(location_first_match.group("content").strip())

    return ""


def extract_path_after_bare_action(text: str, action_pattern: str) -> str:
    match = re.search(
        rf"^\s*{action_pattern}\s+(?P<path>\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s,;]+)",
        text,
        flags=re.IGNORECASE,
    )
    return strip_quotes(match.group("path")) if match else ""


def looks_like_workspace_path(path: str) -> bool:
    if not path or "\0" in path:
        return False
    if path.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", path):
        return True
    suffix = Path(path).suffix.lower()
    return suffix in TEXT_BATCH_EXTENSIONS or "/" in path or "\\" in path or path.startswith(".")


def is_generic_location_token(value: str) -> bool:
    return bool(
        re.fullmatch(
            r"(?:project|workspace|desktop|downloads?|on|at|to|from|inside|in|"
            r"проект|проекте|пространств\w*|рабоч\w*|стол\w*|загрузк\w*|"
            r"files?|файлы?|файлах?|with|content|text|с|со|в|во|на|из|по|текстом|содержимым)",
            normalize_space(value).lower(),
        )
    )


def wants_unnamed_new_directory(text: str) -> bool:
    return bool(re.search(
        r"\bnew\s+folder\b|(?:invent|choose|generate)\s+(?:a\s+)?name|нов\w*\s+папк|(?:названи[ея]?|имя).{0,32}придум|придумай\s+сам",
        text,
        flags=re.IGNORECASE,
    ))


def default_new_directory_name(text: str) -> str:
    return "Новая папка" if re.search(r"[а-яё]", text, flags=re.IGNORECASE) else "New Folder"


def is_standalone_workspace_path(path: str) -> bool:
    value = path.strip()
    if not value or any(char in value for char in ("\n", "\r", "\0")):
        return False
    return bool(
        re.fullmatch(r"[A-Za-z]:[\\/].+", value)
        or re.fullmatch(r"(?:\.{1,2}[\\/]|[\\/]).+", value)
        or re.fullmatch(r"[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_. -]+)+", value)
    )


def workspace_path_token_pattern() -> str:
    return r"`[^`]+`|\"[^\"]+\"|'[^']+'|[^\s,;]+"


def strip_trailing_punctuation(value: str) -> str:
    return value.rstrip(".,;:")


def extract_target_path(text: str) -> str:
    match = re.search(
        r"(?:\s|^)(?:to|into|as|в|на|как)\s+(?P<path>\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s,;]+)\s*$",
        text,
        flags=re.IGNORECASE,
    )
    return strip_quotes(match.group("path")) if match else ""


def extract_path_after_location(text: str) -> str:
    match = re.search(
        r"(?:\s|^)(?:in|from|inside|в|из|по)\s+(?P<path>\"[^\"]+\"|'[^']+'|`[^`]+`|[^\s,;]+)\s*$",
        text,
        flags=re.IGNORECASE,
    )
    return strip_quotes(match.group("path")) if match else ""


def extract_known_location(text: str) -> str:
    lowered = text.lower()
    if re.search(r"\bdesktop\b|рабоч[^\s]*\s+стол|(?:^|\s)на\s+стол(?:е)?\b", lowered):
        return str(resolve_known_user_folder("desktop"))
    if re.search(r"\bdownloads?\b|загрузк", lowered):
        return str(resolve_known_user_folder("downloads"))
    return ""


def extract_search_query(text: str) -> str:
    quoted = extract_quoted(text)
    if quoted:
        return quoted[0]

    cleaned = re.sub(
        r"^(?:search|find|grep|найди|ищи|поиск)\s+(?:in\s+files?\s+|в\s+файлах\s+)?",
        "",
        text,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\s+(?:in|from|inside|в|из|по)\s+\S+\s*$", "", cleaned, flags=re.IGNORECASE)
    return normalize_space(cleaned)


def extract_content(text: str) -> str:
    match = re.search(
        r"(?:with\s+text|with\s+content|content|с\s+текстом|с\s+содержимым|текстом)\s*[:\-]?\s*(?P<content>.+)$",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return ""
    return strip_quotes(match.group("content").strip())


def extract_replace_texts(text: str, quoted: list[str], path_text: str) -> tuple[str, str]:
    if len(quoted) >= 3 and path_text == quoted[0]:
        return quoted[1], quoted[2]
    if len(quoted) >= 2:
        return quoted[-2], quoted[-1]

    match = re.search(
        r"(?:replace|замени|заменить)\s+(?P<old>.+?)\s+(?:with|на)\s+(?P<new>.+)$",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return "", ""
    return strip_quotes(match.group("old").strip()), strip_quotes(match.group("new").strip())


def extract_quoted(text: str) -> list[str]:
    return [strip_quotes(match.group(0)) for match in re.finditer(r"\"[^\"]+\"|'[^']+'|`[^`]+`", text)]


def strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"\"", "'", "`"}:
        return value[1:-1].strip()
    return value


def to_entry(path: Path, root: Path) -> WorkspaceEntry:
    try:
        name = str(path.relative_to(root))
    except ValueError:
        name = path.name
    return WorkspaceEntry(
        path=str(path),
        name=name or path.name,
        type="directory" if path.is_dir() else "file",
        size_bytes=path.stat().st_size if path.is_file() else None,
    )


def should_skip_path(path: Path, root: Path | None = None) -> bool:
    if root is not None and has_blocked_part(path, root):
        return True
    return path.name in BLOCKED_DIR_NAMES or is_likely_binary(path)


def copy_size_bytes(path: Path, root: Path) -> int | None:
    if has_blocked_part(path, root):
        return None
    if path.is_file():
        return path.stat().st_size

    total = 0
    for child in path.rglob("*"):
        if has_blocked_part(child, root):
            return None
        if child.is_file():
            total += child.stat().st_size
    return total


def is_likely_binary(path: Path) -> bool:
    return path.suffix.lower() in BINARY_EXTENSIONS


def normalize_file_extension(extension: str) -> str:
    normalized = normalize_space(extension).lower()
    if not normalized:
        return ""
    return normalized if normalized.startswith(".") else f".{normalized}"


def workspace_entry_matches(path: Path, entry_type: str, extension: str) -> bool:
    if entry_type == "file" and not path.is_file():
        return False
    if entry_type == "directory" and not path.is_dir():
        return False
    if extension and (not path.is_file() or path.suffix.lower() != extension):
        return False
    return True


def has_blocked_part(path: Path, root: Path) -> bool:
    try:
        lexical_parts = path.relative_to(root).parts
    except ValueError:
        return True
    if relative_parts_blocked(lexical_parts):
        return True
    try:
        resolved_path = path.resolve()
        resolved_root = root.resolve()
    except OSError:
        resolved_path = path.absolute()
        resolved_root = root.absolute()
    try:
        resolved_parts = resolved_path.relative_to(resolved_root).parts
    except ValueError:
        return True
    return relative_parts_blocked(resolved_parts)


def relative_parts_blocked(parts: tuple[str, ...]) -> bool:
    lowered = tuple(part.lower() for part in parts)
    blocked_names = {name.lower() for name in BLOCKED_DIR_NAMES}
    if any(part in blocked_names for part in lowered):
        return True
    if lowered in BLOCKED_RELATIVE_FILES:
        return True
    return any(
        len(lowered) >= len(blocked_dir) and lowered[:len(blocked_dir)] == blocked_dir
        for blocked_dir in BLOCKED_RELATIVE_DIRS
    )


def expand_user_path(raw_path: str) -> str:
    return os.path.expanduser(os.path.expandvars(raw_path))


def local_read_roots() -> list[Path]:
    roots = [
        *known_user_folder_candidates("desktop"),
        *known_user_folder_candidates("downloads"),
    ]
    configured = os.environ.get("MONARCH_LOCAL_READ_ROOTS", "")
    for entry in configured.split(os.pathsep):
        normalized = normalize_space(entry)
        if normalized:
            roots.append(Path(expand_user_path(normalized)))
    resolved_roots: list[Path] = []
    for root in roots:
        try:
            resolved = root.resolve()
        except OSError:
            resolved = root.absolute()
        if not any(same_path(resolved, existing) for existing in resolved_roots):
            resolved_roots.append(resolved)
    return resolved_roots


def resolve_known_user_folder(kind: str) -> Path:
    candidates = known_user_folder_candidates(kind)
    existing = next((candidate for candidate in candidates if candidate.exists()), None)
    return existing or (candidates[0] if candidates else Path.home() / ("Desktop" if kind == "desktop" else "Downloads"))


def known_user_folder_candidates(kind: str) -> list[Path]:
    folder_name = "Desktop" if kind == "desktop" else "Downloads"
    override_env = "MONARCH_DESKTOP_DIR" if kind == "desktop" else "MONARCH_DOWNLOADS_DIR"
    xdg_env = "XDG_DESKTOP_DIR" if kind == "desktop" else "XDG_DOWNLOAD_DIR"
    raw_roots: list[str] = []
    raw_roots.extend(
        normalize_space(value)
        for value in (
            os.environ.get(override_env, ""),
            *windows_known_user_folder_candidates(kind),
            os.environ.get(xdg_env, ""),
        )
        if normalize_space(value)
    )

    cloud_roots = [
        os.environ.get("OneDrive", ""),
        os.environ.get("OneDriveConsumer", ""),
        os.environ.get("OneDriveCommercial", ""),
    ]
    user_profile = os.environ.get("USERPROFILE") or ""
    if user_profile:
        cloud_roots.append(str(Path(expand_user_path(user_profile)) / "OneDrive"))
    raw_roots.extend(
        str(Path(expand_user_path(root)) / folder_name)
        for root in cloud_roots
        if normalize_space(root)
    )
    raw_roots.extend(
        str(Path(expand_user_path(root)) / folder_name)
        for root in (os.environ.get("USERPROFILE", ""), os.environ.get("HOME", ""))
        if normalize_space(root)
    )

    candidates: list[Path] = []
    for raw_root in raw_roots:
        candidate = Path(expand_user_path(raw_root))
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate.absolute()
        if not any(same_path(resolved, existing) for existing in candidates):
            candidates.append(resolved)
    return candidates


def windows_known_user_folder_candidates(kind: str) -> list[str]:
    if winreg is None:
        return []
    value_names = (
        ("Desktop", "{754AC886-DF64-4CBA-86B5-F7FBF4FBCEF5}")
        if kind == "desktop"
        else ("Downloads", "{374DE290-123F-4565-9164-39C4925E467B}")
    )
    keys = (
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders",
    )
    values: list[str] = []
    for key_name in keys:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_name) as key:
                for value_name in value_names:
                    try:
                        raw_value, _value_type = winreg.QueryValueEx(key, value_name)
                    except OSError:
                        continue
                    if isinstance(raw_value, str) and normalize_space(raw_value):
                        values.append(expand_user_path(raw_value))
        except OSError:
            continue
    return values


def matching_local_read_root(path: Path) -> Path | None:
    return next((root for root in local_read_roots() if is_within(path, root)), None)


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def same_path(left: Path, right: Path) -> bool:
    return str(left).lower() == str(right).lower()


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def timestamp_slug() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def next_available_directory_path(base_path: Path) -> Path:
    if not base_path.exists():
        return base_path
    for index in range(2, 1000):
        candidate = base_path.with_name(f"{base_path.name} ({index})")
        if not candidate.exists():
            return candidate
    return base_path.with_name(f"{base_path.name}-{timestamp_slug()}")


def unique_trash_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    for index in range(2, 1000):
        candidate = parent / f"{stem}-{index}{suffix}"
        if not candidate.exists():
            return candidate
    return parent / f"{stem}-{datetime.now(timezone.utc).strftime('%f')}{suffix}"


def cleanup_empty_trash_parents(start: Path, trash_root: Path) -> None:
    current = start.resolve()
    root = trash_root.resolve()
    while is_within(current, root) and not same_path(current, root):
        try:
            next(current.iterdir())
            return
        except StopIteration:
            current.rmdir()
            current = current.parent
