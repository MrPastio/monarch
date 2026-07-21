from __future__ import annotations

import json
import subprocess
from typing import Any

from monarch_security.events import SecurityEvent


class DeviceSensor:
    def __init__(
        self,
        include_existing: bool = False,
        initial_seen: set[str] | None = None,
    ) -> None:
        self.include_existing = include_existing
        self._seen: set[str] = set(initial_seen or set())
        self._first_poll = not bool(initial_seen)
        self.last_error: str | None = None

    @property
    def seen_ids(self) -> set[str]:
        return set(self._seen)

    def snapshot(self) -> list[dict[str, Any]]:
        self.last_error = None
        command = (
            "$OutputEncoding = [Console]::OutputEncoding = "
            "[System.Text.UTF8Encoding]::new($false);\n"
            "Get-PnpDevice -PresentOnly | "
            "Select-Object Class,FriendlyName,InstanceId,Status | "
            "ConvertTo-Json -Compress"
        )
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
                timeout=45,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired:
            self.last_error = "Get-PnpDevice timed out"
            return []
        if completed.returncode != 0 or not completed.stdout.strip():
            self.last_error = completed.stderr.strip() or "Get-PnpDevice returned no data"
            return []

        try:
            parsed = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            self.last_error = f"Get-PnpDevice returned invalid JSON: {exc}"
            return []
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list):
            return []

        devices: list[dict[str, Any]] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            instance_id = str(item.get("InstanceId") or "")
            if not instance_id:
                continue
            devices.append(
                {
                    "class": item.get("Class"),
                    "friendly_name": item.get("FriendlyName"),
                    "instance_id": instance_id,
                    "status": item.get("Status"),
                }
            )
        return devices

    def poll(self) -> list[SecurityEvent]:
        snapshot = self.snapshot()
        current = {str(item["instance_id"]) for item in snapshot}
        new_items = [item for item in snapshot if str(item["instance_id"]) not in self._seen]
        self._seen = current

        if self._first_poll and not self.include_existing:
            self._first_poll = False
            return []

        self._first_poll = False
        return [self._event_from_device(item) for item in new_items]

    @staticmethod
    def _event_from_device(item: dict[str, Any]) -> SecurityEvent:
        subject = str(item.get("friendly_name") or item.get("instance_id"))
        return SecurityEvent(
            kind="device.connected",
            source="device_sensor",
            subject=subject,
            facts=item,
        )
