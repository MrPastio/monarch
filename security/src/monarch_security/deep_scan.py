from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import os
import subprocess
import urllib.request
import urllib.error

from .analysis import RuleEngine
from .config import AppConfig
from .events import RuleAssessment, SecurityEvent
from .llm import LLMRouter
from .policy import PolicyEngine
from .sensors import FileScanner


AUTHENTICODE_EXTENSIONS = {
    ".bat",
    ".cmd",
    ".com",
    ".cpl",
    ".dll",
    ".exe",
    ".hta",
    ".js",
    ".lnk",
    ".msi",
    ".ps1",
    ".scr",
    ".sys",
    ".url",
    ".vbs",
    ".wsf",
}


def deep_scan_file(
    path: Path,
    config: AppConfig,
    rules: RuleEngine,
    router: LLMRouter,
    policy: PolicyEngine,
    no_llm: bool = False,
    defender: bool = False,
    virustotal: bool = False,
) -> dict[str, Any]:
    event = FileScanner(config.files).inspect(path)
    facts = dict(event.facts)
    if path.suffix.lower() in AUTHENTICODE_EXTENSIONS or facts.get("magic_type") == "pe":
        facts.update(authenticode_facts(path))
    if defender:
        facts["defender_scan"] = defender_scan(path)

    api_key = getattr(config.policy, "virustotal_api_key", "")
    if virustotal and api_key and facts.get("sha256"):
        vt_result = virustotal_scan(facts["sha256"], api_key)
        facts["virustotal"] = vt_result
        if vt_result.get("malicious", 0) > 0:
            facts["virustotal_malicious"] = True

    event = SecurityEvent(
        kind=event.kind,
        source="deep_file_scanner",
        subject=event.subject,
        facts=facts,
    )
    assessment = rules.assess(event)

    if facts.get("virustotal_malicious"):
        assessment = _with_reputation_escalation(
            assessment,
            score=max(assessment.score, 90),
            reason=(
                "VirusTotal reports file as malicious "
                f"({facts['virustotal'].get('malicious')} engines)"
            ),
            llm_threshold=config.router.llm_threshold,
        )

    decision = policy.local_decision(assessment) if no_llm else router.decide(assessment)
    return {
        "assessment": assessment.to_dict(),
        "decision": decision.to_dict(),
        "deep_scan": {
            "authenticode_checked": "authenticode_status" in facts,
            "defender_checked": defender,
            "virustotal_checked": bool(virustotal and api_key and facts.get("sha256")),
            "virustotal_requested": virustotal,
        },
    }

def virustotal_scan(file_hash: str, api_key: str) -> dict[str, Any]:
    if not api_key or not file_hash:
        return {"available": False, "reason": "No API key or hash provided"}
    
    url = f"https://www.virustotal.com/api/v3/files/{file_hash}"
    req = urllib.request.Request(url, headers={"x-apikey": api_key})
    
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
            stats = data.get("data", {}).get("attributes", {}).get("last_analysis_stats", {})
            return {
                "available": True,
                "malicious": stats.get("malicious", 0),
                "suspicious": stats.get("suspicious", 0),
                "undetected": stats.get("undetected", 0),
                "harmless": stats.get("harmless", 0),
            }
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"available": True, "reason": "Not found in VirusTotal"}
        return {"available": False, "reason": f"HTTP Error {e.code}"}
    except Exception as e:
        return {"available": False, "reason": str(e)}


def _with_reputation_escalation(
    assessment: RuleAssessment,
    score: int,
    reason: str,
    llm_threshold: int,
) -> RuleAssessment:
    score = max(0, min(100, score))
    reasons = [*assessment.reasons, reason]
    return RuleAssessment(
        event=assessment.event,
        score=score,
        severity=_severity(score),
        reasons=reasons,
        route=_route(score, llm_threshold),
    )


def _route(score: int, llm_threshold: int) -> str:
    if score >= llm_threshold:
        return "llm"
    if score >= 35:
        return "deep_scan"
    return "local"


def _severity(score: int) -> str:
    if score >= 85:
        return "critical"
    if score >= 65:
        return "high"
    if score >= 35:
        return "medium"
    if score > 0:
        return "low"
    return "clean"


def authenticode_facts(path: Path) -> dict[str, Any]:
    command = r"""
$p = $env:MONARCH_SCAN_PATH
$sig = Get-AuthenticodeSignature -LiteralPath $p
$cert = $sig.SignerCertificate
[pscustomobject]@{
  authenticode_status = [string]$sig.Status
  authenticode_status_message = [string]$sig.StatusMessage
  authenticode_signed = $null -ne $cert
  authenticode_subject = if ($cert) { [string]$cert.Subject } else { $null }
  authenticode_issuer = if ($cert) { [string]$cert.Issuer } else { $null }
  authenticode_thumbprint = if ($cert) { [string]$cert.Thumbprint } else { $null }
  authenticode_not_after = if ($cert) { $cert.NotAfter.ToString('o') } else { $null }
} | ConvertTo-Json -Depth 4 -Compress
"""
    result = _run_powershell_json(command, path, timeout=30)
    if isinstance(result, dict):
        return result
    return {
        "authenticode_status": "Unavailable",
        "authenticode_error": str(result),
    }


def defender_scan(path: Path) -> dict[str, Any]:
    command = r"""
$p = $env:MONARCH_SCAN_PATH
if (-not (Get-Command Start-MpScan -ErrorAction SilentlyContinue)) {
  [pscustomobject]@{ available = $false; status = 'unavailable'; reason = 'Start-MpScan missing' } |
    ConvertTo-Json -Compress
  exit 0
}
Start-MpScan -ScanType CustomScan -ScanPath $p -ErrorAction Stop | Out-Null
[pscustomobject]@{ available = $true; status = 'completed'; path = $p } |
  ConvertTo-Json -Compress
"""
    result = _run_powershell_json(command, path, timeout=180)
    if isinstance(result, dict):
        return result
    return {"available": False, "status": "error", "reason": str(result)}


def _run_powershell_json(command: str, path: Path, timeout: int) -> Any:
    env = {"MONARCH_SCAN_PATH": str(path)}
    try:
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-NonInteractive",
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
            env={**dict(os.environ), **env},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return "PowerShell command timed out"
    if completed.returncode != 0:
        return completed.stderr.strip() or "PowerShell command failed"
    output = completed.stdout.strip()
    if not output:
        return {}
    try:
        return json.loads(output)
    except json.JSONDecodeError as exc:
        return f"invalid JSON from PowerShell: {exc}"
