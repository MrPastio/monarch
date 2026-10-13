from __future__ import annotations

from typing import Any
import json
import subprocess

from monarch_security.config import PostureConfig
from monarch_security.events import SecurityEvent
from monarch_security.observation import ObservedSensor, ObservationUnavailable, parse_query_json


class PostureSensor(ObservedSensor):
    def __init__(
        self,
        config: PostureConfig,
        include_existing: bool = False,
        initial_signatures: dict[str, str] | None = None,
    ) -> None:
        self.config = config
        self.include_existing = include_existing
        self._signatures: dict[str, str] = dict(initial_signatures or {})
        self._first_poll = not bool(initial_signatures)
        self.last_error: str | None = None

    @property
    def signatures(self) -> dict[str, str]:
        return dict(self._signatures)

    def snapshot_signatures(self) -> dict[str, str]:
        return {item["key"]: item["signature"] for item in self.snapshot()}

    def snapshot(self) -> list[dict[str, Any]]:
        self.begin_observation()
        self.last_error = None
        parsed, error = _run_powershell_json(_posture_snapshot_command(), timeout=60)
        if error:
            self.last_error = error
            return []
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list) or any(not isinstance(item, dict) or item.get('kind') not in {'firewall_profile', 'defender_status'} for item in parsed):
            raise ObservationUnavailable('posture-query-invalid')
        items = parsed
        if not any(item.get('kind') == 'firewall_profile' for item in items):
            raise ObservationUnavailable('firewall-query-unavailable')
        if not any(item.get('kind') == 'defender_status' for item in items):
            self.limit_observation('defender-query-unavailable')
        profile_names = {str(item.get('subject') or item.get('name') or '').lower()
                         for item in items if item['kind'] == 'firewall_profile'}
        if profile_names != {'domain', 'private', 'public'}:
            self.limit_observation('firewall-profiles-incomplete')
        for item in items:
            required = ('enabled',) if item['kind'] == 'firewall_profile' else (
                'antivirus_enabled', 'real_time_protection_enabled', 'behavior_monitor_enabled',
                'ioav_protection_enabled', 'antispyware_enabled')
            for field in required:
                if field not in item:
                    self.limit_observation('posture-fields-unavailable')
                elif type(item[field]) is not bool:
                    raise ObservationUnavailable('posture-query-invalid')
        return [_with_signature(item) for item in items]

    def poll(self) -> list[SecurityEvent]:
        snapshot = self.snapshot()
        if self.last_error:
            raise ObservationUnavailable('posture-query-unavailable')
        changed = [
            item
            for item in snapshot
            if self._signatures.get(str(item["key"])) != str(item["signature"])
        ]
        current = {str(item["key"]): str(item["signature"]) for item in snapshot}
        self._signatures = current if self.observation['status'] == 'complete' else {**self._signatures, **current}

        if self._first_poll and not self.include_existing:
            self._first_poll = False
            return []

        self._first_poll = False
        return [self._event_from_item(item) for item in changed]

    @staticmethod
    def _event_from_item(item: dict[str, Any]) -> SecurityEvent:
        facts = {key: value for key, value in item.items() if key not in {"signature"}}
        return SecurityEvent(
            kind="security.posture_changed",
            source="posture_sensor",
            subject=str(item.get("subject") or item.get("key")),
            facts=facts,
        )


def _firewall_command() -> str:
    return r"""
Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop |
ForEach-Object {
  $enabled = [string]$_.Enabled
  if ($enabled -notin @('True', 'False')) { throw 'firewall-status-unavailable' }
  [pscustomobject]@{
    kind = 'firewall_profile'
    subject = $_.Name
    name = $_.Name
    enabled = $enabled -eq 'True'
    default_inbound_action = [string]$_.DefaultInboundAction
    default_outbound_action = [string]$_.DefaultOutboundAction
  }
}
"""


def _defender_command() -> str:
    return r"""
if (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue) {
  $s = Get-MpComputerStatus -ErrorAction Stop
  foreach ($field in @('AntivirusEnabled','RealTimeProtectionEnabled','BehaviorMonitorEnabled','IoavProtectionEnabled','AntispywareEnabled')) {
    if ($null -eq $s.$field) { throw 'defender-status-unavailable' }
  }
  [pscustomobject]@{
    kind = 'defender_status'
    subject = 'Microsoft Defender'
    antivirus_enabled = [bool]$s.AntivirusEnabled
    real_time_protection_enabled = [bool]$s.RealTimeProtectionEnabled
    behavior_monitor_enabled = [bool]$s.BehaviorMonitorEnabled
    ioav_protection_enabled = [bool]$s.IoavProtectionEnabled
    antispyware_enabled = [bool]$s.AntispywareEnabled
    full_scan_age = $s.FullScanAge
    quick_scan_age = $s.QuickScanAge
  }
}
"""


def _posture_snapshot_command() -> str:
    return (
        "$ErrorActionPreference = 'Stop'; & {\n"
        + _firewall_command()
        + "\n"
        + _defender_command()
        + "\n} | ConvertTo-Json -Depth 4 -Compress"
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
        return None, "posture PowerShell command timed out"
    if completed.returncode != 0:
        return None, completed.stderr.strip() or "posture PowerShell command failed"
    output = completed.stdout.strip()
    if not output:
        return [], None
    try:
        return parse_query_json(output), None
    except ObservationUnavailable:
        return None, 'posture-query-json-invalid'


def _with_signature(item: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(item)
    kind = str(normalized.get("kind") or "unknown")
    subject = str(normalized.get("subject") or normalized.get("name") or kind)
    normalized["key"] = f"{kind}:{subject}".lower()
    normalized["signature"] = json.dumps(
        {
            key: normalized.get(key)
            for key in (
                "enabled",
                "default_inbound_action",
                "default_outbound_action",
                "antivirus_enabled",
                "real_time_protection_enabled",
                "behavior_monitor_enabled",
                "ioav_protection_enabled",
                "antispyware_enabled",
                "full_scan_age",
                "quick_scan_age",
            )
        },
        ensure_ascii=True,
        sort_keys=True,
    )
    return normalized
