from __future__ import annotations

from typing import Any
import json
import subprocess

from monarch_security.config import PostureConfig
from monarch_security.events import SecurityEvent


class PostureSensor:
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
        self.last_error = None
        parsed, error = _run_powershell_json(_posture_snapshot_command(), timeout=60)
        if error:
            self.last_error = error
            return []
        if isinstance(parsed, dict):
            parsed = [parsed]
        items = [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []
        return [_with_signature(item) for item in items]

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
Get-NetFirewallProfile -ErrorAction SilentlyContinue |
ForEach-Object {
  [pscustomobject]@{
    kind = 'firewall_profile'
    subject = $_.Name
    name = $_.Name
    enabled = [bool]$_.Enabled
    default_inbound_action = [string]$_.DefaultInboundAction
    default_outbound_action = [string]$_.DefaultOutboundAction
  }
}
"""


def _defender_command() -> str:
    return r"""
if (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue) {
  $s = Get-MpComputerStatus
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
        "& {\n"
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
        return json.loads(output), None
    except json.JSONDecodeError as exc:
        return None, f"posture PowerShell returned invalid JSON: {exc}"


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
