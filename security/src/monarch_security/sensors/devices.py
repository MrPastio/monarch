from __future__ import annotations

import subprocess
from typing import Any

from monarch_security.events import SecurityEvent
from monarch_security.observation import ObservedSensor, ObservationUnavailable, parse_query_json


class DeviceSensor(ObservedSensor):
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
        self.begin_observation()
        self.last_error = None
        command = (
            "$OutputEncoding = [Console]::OutputEncoding = "
            "[System.Text.UTF8Encoding]::new($false);\n"
            "$ErrorActionPreference = 'Stop'; Get-PnpDevice -PresentOnly -ErrorAction Stop | "
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
            parsed = parse_query_json(completed.stdout)
        except ObservationUnavailable:
            self.last_error = 'device-query-invalid'
            raise
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list):
            raise ObservationUnavailable('device-query-invalid')

        devices: list[dict[str, Any]] = []
        for item in parsed:
            if not isinstance(item, dict):
                raise ObservationUnavailable('device-query-invalid')
            instance_id = item.get('InstanceId')
            if not isinstance(instance_id, str) or not instance_id.strip():
                raise ObservationUnavailable('device-query-invalid')
            if any(not isinstance(item.get(field), str) or not item[field] for field in ('Class', 'Status')):
                self.limit_observation('device-details-unavailable')
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
        if self.last_error:
            raise ObservationUnavailable('device-query-unavailable')
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
