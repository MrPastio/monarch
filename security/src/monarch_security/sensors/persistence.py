from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import os
import stat as stat_module
import subprocess
import sys

from monarch_security.config import PersistenceConfig
from monarch_security.events import SecurityEvent

if sys.platform == "win32":
    import winreg
else:
    winreg = None  # type: ignore


RUN_KEYS = [
    ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Run"),
    ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\RunOnce"),
    ("HKLM", r"Software\Microsoft\Windows\CurrentVersion\Run"),
    ("HKLM", r"Software\Microsoft\Windows\CurrentVersion\RunOnce"),
    ("HKLM", r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"),
    ("HKLM", r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce"),
]


class PersistenceSensor:
    def __init__(
        self,
        config: PersistenceConfig,
        include_existing: bool = False,
        initial_signatures: dict[str, str] | None = None,
        approved_signatures: dict[str, str] | None = None,
    ) -> None:
        self.config = config
        self.include_existing = include_existing
        self._signatures: dict[str, str] = dict(initial_signatures or {})
        self._approved_signatures: dict[str, str] = dict(approved_signatures or {})
        self._first_poll = not bool(initial_signatures)
        self.last_error: str | None = None
        self._cursor = 0
        self._overflow = False
        self._cycle_seen: set[str] = set()

    @property
    def signatures(self) -> dict[str, str]:
        return dict(self._signatures)

    def snapshot_signatures(self) -> dict[str, str]:
        return {item["key"]: item["signature"] for item in self.snapshot()}

    @property
    def checkpoint_cursor(self) -> int:
        return self._cursor

    @property
    def overflow(self) -> bool:
        return self._overflow

    def restore_checkpoint_cursor(self, value: object) -> None:
        try:
            cursor = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("persistence cursor is invalid") from exc
        if cursor < 0:
            raise ValueError("persistence cursor is negative")
        self._cursor = cursor

    @property
    def checkpoint_metadata(self) -> dict[str, list[str]]:
        return {"cycle_seen": sorted(self._cycle_seen)}

    def restore_checkpoint_metadata(self, value: object) -> None:
        if not isinstance(value, dict) or not isinstance(value.get("cycle_seen"), list):
            raise ValueError("persistence checkpoint metadata is invalid")
        self._cycle_seen = {str(item) for item in value["cycle_seen"]}

    def snapshot(self) -> list[dict[str, Any]]:
        self.last_error = None
        items: list[dict[str, Any]] = []
        items.extend(self._startup_folder_items())
        items.extend(self._run_key_items())
        scheduled, _ = self._scheduled_task_items(skip=0, limit=None)
        items.extend(scheduled)
        return [_with_signature(item) for item in items]

    def poll(self) -> list[SecurityEvent]:
        previous_cursor = self._cursor
        snapshot = self._snapshot_page()
        if self.last_error:
            self._cursor = previous_cursor
            self._overflow = False
            return []
        changed = [
            item
            for item in snapshot
            if self._signatures.get(str(item["key"])) != str(item["signature"])
        ]
        self._signatures.update({
            str(item["key"]): str(item["signature"])
            for item in snapshot
        })
        self._cycle_seen.update(str(item["key"]) for item in snapshot)
        if self._cursor == 0:
            self._signatures = {
                key: value
                for key, value in self._signatures.items()
                if key in self._cycle_seen
            }
            self._cycle_seen.clear()

        if self._first_poll and not self.include_existing:
            if self._cursor == 0:
                self._first_poll = False
            return []

        self._first_poll = False
        enriched: list[dict[str, Any]] = []
        for item in changed:
            current = dict(item)
            key = str(current.get("key") or "")
            approved = self._approved_signatures.get(key)
            signature = str(current.get("signature") or "")
            current["approved_baseline_exact_match"] = bool(approved and approved == signature)
            current["approved_baseline_entry_changed"] = bool(approved and approved != signature)
            enriched.append(current)
        return [self._event_from_item(item) for item in enriched]

    def _snapshot_page(self) -> list[dict[str, Any]]:
        self.last_error = None
        items: list[dict[str, Any]] = []
        items.extend(self._startup_folder_items())
        items.extend(self._run_key_items())
        page_size = max(1, int(self.config.max_entries))
        scheduled, has_more = self._scheduled_task_items(
            skip=self._cursor,
            limit=page_size,
        )
        if self.last_error:
            return []
        items.extend(scheduled)
        self._overflow = has_more
        self._cursor = self._cursor + len(scheduled) if has_more else 0
        return [_with_signature(item) for item in items]

    def _startup_folder_items(self) -> list[dict[str, Any]]:
        roots = [
            Path(os.path.expandvars(r"%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup")),
            Path(os.path.expandvars(r"%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup")),
        ]
        items: list[dict[str, Any]] = []
        for root in roots:
            if not root.exists():
                continue
            try:
                entries = list(root.iterdir())
            except OSError:
                continue
            for path in entries:
                if path.name.lower() == "desktop.ini":
                    continue
                try:
                    file_stat = path.stat()
                except OSError:
                    continue
                if not stat_module.S_ISREG(file_stat.st_mode):
                    continue
                items.append(
                    {
                        "kind": "startup_file",
                        "subject": str(path),
                        "path": str(path),
                        "name": path.name,
                        "extension": path.suffix.lower(),
                        "size": file_stat.st_size,
                        "mtime_ns": file_stat.st_mtime_ns,
                    }
                )
        return items

    def _run_key_items(self) -> list[dict[str, Any]]:
        if winreg is None:
            return []
        items: list[dict[str, Any]] = []
        for hive_name, key_path in RUN_KEYS:
            hive = winreg.HKEY_CURRENT_USER if hive_name == "HKCU" else winreg.HKEY_LOCAL_MACHINE
            try:
                with winreg.OpenKey(hive, key_path) as key:
                    value_count = winreg.QueryInfoKey(key)[1]
                    for index in range(value_count):
                        try:
                            name, value, value_type = winreg.EnumValue(key, index)
                        except OSError:
                            continue
                        items.append(
                            {
                                "kind": "run_key",
                                "subject": f"{hive_name}\\{key_path}\\{name}",
                                "hive": hive_name,
                                "registry_path": key_path,
                                "name": name,
                                "value": str(value),
                                "value_type": int(value_type),
                            }
                        )
            except OSError:
                continue
        return items

    def _scheduled_task_items(
        self,
        *,
        skip: int,
        limit: int | None,
    ) -> tuple[list[dict[str, Any]], bool]:
        selection = ""
        if limit is not None:
            selection = (
                f"Select-Object -Skip {max(0, int(skip))} "
                f"-First {max(1, int(limit)) + 1} |"
            )
        command = rf"""
Get-ScheduledTask -ErrorAction SilentlyContinue |
Where-Object {{ $_.TaskPath -notlike '\Microsoft\*' }} |
Sort-Object TaskPath,TaskName |
{selection}
ForEach-Object {{
  [pscustomobject]@{{
    kind = 'scheduled_task'
    subject = "$($_.TaskPath)$($_.TaskName)"
    task_name = $_.TaskName
    task_path = $_.TaskPath
    state = [string]$_.State
    author = $_.Author
    actions = @($_.Actions | ForEach-Object {{ "$($_.Execute) $($_.Arguments)" }})
  }}
}} | ConvertTo-Json -Depth 5 -Compress
"""
        parsed, error = _run_powershell_json(command, timeout=45)
        if error:
            self.last_error = error if self.last_error is None else f"{self.last_error}; {error}"
            return [], False
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list):
            return [], False
        items = [item for item in parsed if isinstance(item, dict)]
        if limit is None:
            return items, False
        page_size = max(1, int(limit))
        return items[:page_size], len(items) > page_size

    @staticmethod
    def _event_from_item(item: dict[str, Any]) -> SecurityEvent:
        facts = {key: value for key, value in item.items() if key not in {"signature"}}
        return SecurityEvent(
            kind="persistence.entry_added",
            source="persistence_sensor",
            subject=str(item.get("subject") or item.get("key")),
            facts=facts,
        )


def _run_powershell_json(command: str, timeout: int = 30) -> tuple[Any, str | None]:
    try:
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return None, "persistence PowerShell command timed out"
    if completed.returncode != 0:
        return None, completed.stderr.strip() or "persistence PowerShell command failed"
    output = completed.stdout.strip()
    if not output:
        return [], None
    try:
        return json.loads(output), None
    except json.JSONDecodeError as exc:
        return None, f"persistence PowerShell returned invalid JSON: {exc}"


def _with_signature(item: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(item)
    kind = str(normalized.get("kind") or "unknown")
    subject = str(normalized.get("subject") or normalized.get("path") or normalized.get("name"))
    normalized["key"] = f"{kind}:{subject}".lower()
    normalized["signature"] = json.dumps(
        {
            "kind": kind,
            "subject": subject,
            "path": normalized.get("path"),
            "value": normalized.get("value"),
            "actions": normalized.get("actions"),
            "size": normalized.get("size"),
            "mtime_ns": normalized.get("mtime_ns"),
            "state": normalized.get("state"),
        },
        ensure_ascii=True,
        sort_keys=True,
    )
    return normalized
