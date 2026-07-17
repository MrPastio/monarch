from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import os
import platform
import subprocess
import time

from .config import NotificationConfig
from .events import ActionDecision, RuleAssessment
from .incidents import Incident


@dataclass(frozen=True)
class NotificationResult:
    sent: bool
    reason: str
    title: str | None = None
    body: str | None = None


class NotificationManager:
    def __init__(self, config: NotificationConfig) -> None:
        self.config = config
        self._last_sent_by_key: dict[str, float] = {}

    def notify(
        self,
        assessment: RuleAssessment,
        decision: ActionDecision,
        incident: Incident | None = None,
    ) -> NotificationResult:
        if not self.config.enabled:
            return NotificationResult(False, "notifications disabled")
        if assessment.score < self.config.min_score:
            return NotificationResult(False, "below notification threshold")

        key = self._dedupe_key(assessment)
        now = time.monotonic()
        last = self._last_sent_by_key.get(key)
        if last is not None and now - last < self.config.cooldown_seconds:
            return NotificationResult(False, "notification cooldown active")

        title, body = format_notification(assessment, decision, incident=incident)
        sent = False
        reason = "no channel enabled"
        if self.config.console_bell:
            print("\a", end="")
            sent = True
            reason = "console bell"
        if self.config.windows_toast and platform.system().lower() == "windows":
            if _show_windows_balloon(title, body, self.config.balloon_seconds):
                sent = True
                reason = "windows balloon"
            elif not sent:
                reason = "windows notification failed"

        if sent:
            self._last_sent_by_key[key] = now
        return NotificationResult(sent, reason, title, body)

    @staticmethod
    def _dedupe_key(assessment: RuleAssessment) -> str:
        subject = assessment.event.subject.lower()
        bucket = assessment.score // 10
        return f"{assessment.event.kind}:{subject}:{bucket}"


def format_notification(
    assessment: RuleAssessment,
    decision: ActionDecision,
    incident: Incident | None = None,
) -> tuple[str, str]:
    event = assessment.event
    severity = incident.risk_level if incident is not None else assessment.severity
    title = f"Monarch Security: {severity.upper()} detected"
    reason = assessment.reasons[0] if assessment.reasons else "Suspicious activity detected"
    subject = _shorten(event.subject, 140)
    risk_line = (
        f"Incident risk {incident.risk_score}/800, action: {decision.action}"
        if incident is not None
        else f"Score {assessment.score}/100, action: {decision.action}"
    )
    body = (
        f"{event.kind}\n"
        f"{subject}\n"
        f"{risk_line}\n"
        f"{reason}"
    )
    return _shorten(title, 96), _shorten(body, 360)


def _show_windows_balloon(title: str, body: str, seconds: float) -> bool:
    env = os.environ.copy()
    env["MONARCH_NOTIFY_TITLE"] = title
    env["MONARCH_NOTIFY_BODY"] = body
    env["MONARCH_NOTIFY_MS"] = str(max(1000, int(seconds * 1000)))
    script = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Warning
$n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
$n.BalloonTipTitle = $env:MONARCH_NOTIFY_TITLE
$n.BalloonTipText = $env:MONARCH_NOTIFY_BODY
$n.Visible = $true
$n.ShowBalloonTip([int]$env:MONARCH_NOTIFY_MS)
Start-Sleep -Milliseconds ([int]$env:MONARCH_NOTIFY_MS + 500)
$n.Dispose()
"""
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            creationflags=creationflags,
        )
    except OSError:
        return False
    return True


def _shorten(value: Any, limit: int) -> str:
    text = str(value).replace("\r", " ").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."
