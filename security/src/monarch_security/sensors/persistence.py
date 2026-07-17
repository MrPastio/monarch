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

    @property
    def signatures(self) -> dict[str, str]:
        return dict(self._signatures)

    def snapshot_signatures(self) -> dict[str, str]:
        return {item["key"]: item["signature"] for item in self.snapshot()}

    def snapshot(self) -> list[dict[str, Any]]:
        self.last_error = None
        items: list[dict[str, Any]] = []
        items.extend(self._startup_folder_items())
        items.extend(self._run_key_items())
        items.extend(self._scheduled_task_items())
        return [_with_signature(item) for item in items[: self.config.max_entries]]

    def poll(self) -> list[SecurityEvent]:
        snapshot = self.snapshot()
        changed = [
            item
            for item in snapshot
            if self._signatures.get(str(item["key"])) != str(item["signature"])
        ]
        self._signatures = {str(item["key"]): str(item["signature"]) for item in snapshot}

        if self._first_poll and not self.include_existing:
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

    def _scheduled_task_items(self) -> list[dict[str, Any]]:
        command = rf"""
Get-ScheduledTask -ErrorAction SilentlyContinue |
Where-Object {{ $_.TaskPath -notlike '\Microsoft\*' }} |
Select-Object -First {max(1, self.config.max_entries)} |
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
            return []
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list):
            return []
        return [item for item in parsed if isinstance(item, dict)]

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
