from __future__ import annotations

from typing import Any

from monarch_security.config import PolicyConfig
from monarch_security.events import ActionDecision, RuleAssessment


SAFE_ACTIONS = {
    "allow",
    "warn",
    "ask_user",
    "deep_scan",
    "quarantine_suggest",
    "block_suggest",
    "defer_expensive_analysis",
}

DESTRUCTIVE_ACTIONS = {
    "delete",
    "kill_process",
    "block",
    "quarantine",
}


class PolicyEngine:
    def __init__(self, config: PolicyConfig) -> None:
        self.config = config

    def local_decision(self, assessment: RuleAssessment) -> ActionDecision:
        if assessment.score >= 65:
            action = "ask_user"
            confidence = 0.72
        elif assessment.score >= 35:
            action = "deep_scan"
            confidence = 0.68
        elif assessment.score > 0:
            action = "warn"
            confidence = 0.62
        else:
            action = self.config.default_action
            confidence = 0.85

        return ActionDecision(
            action=action,
            confidence=confidence,
            source="rules",
            reasons=assessment.reasons,
            controls=self._controls_for_assessment(assessment, action),
        )

    def llm_unavailable_decision(
        self, assessment: RuleAssessment, reason: str
    ) -> ActionDecision:
        local = self.local_decision(assessment)
        return ActionDecision(
            action=local.action if local.action != "allow" else "ask_user",
            confidence=min(local.confidence, 0.64),
            source="rules_llm_unavailable",
            reasons=[*assessment.reasons, f"LLM unavailable: {reason}"],
            llm_notes=None,
            controls=self._controls_for_assessment(assessment, local.action),
        )

    def merge_llm_decision(
        self, assessment: RuleAssessment, llm_payload: dict[str, Any]
    ) -> ActionDecision:
        raw_action = str(llm_payload.get("action", "ask_user")).strip().lower()
        action = self._clamp_action(raw_action)

        try:
            confidence = float(llm_payload.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        if 1.0 < confidence <= 100.0:
            confidence = confidence / 100.0
        confidence = max(0.0, min(1.0, confidence))

        llm_reasons = llm_payload.get("reasons", [])
        if not isinstance(llm_reasons, list):
            llm_reasons = [str(llm_reasons)]

        notes = llm_payload.get("notes")
        if notes is not None:
            notes = str(notes)[:800]

        reasons = _unique_reasons([
            *assessment.reasons,
            *[str(reason)[:240] for reason in llm_reasons],
        ])

        if assessment.score >= 85 and action in {"allow", "warn"}:
            action = "ask_user"
            reasons.append("Policy raised weak LLM action for critical local score")

        return ActionDecision(
            action=action,
            confidence=confidence,
            source="llm_router",
            reasons=reasons,
            llm_notes=notes,
            controls=self._controls_for_assessment(assessment, action),
        )

    def _clamp_action(self, action: str) -> str:
        if action in SAFE_ACTIONS:
            return action
        if action in DESTRUCTIVE_ACTIONS and self.config.destructive_actions_require_user:
            if action == "quarantine":
                return "quarantine_suggest"
            if action in {"block", "kill_process"}:
                return "block_suggest"
            return "ask_user"
        return "ask_user"

    def _controls_for_assessment(self, assessment: RuleAssessment, action: str) -> list[str]:
        event = assessment.event
        controls: list[str] = []

        if action in {"ask_user", "deep_scan", "quarantine_suggest", "block_suggest"}:
            controls.append("Preserve the item and audit record before changing system state")

        if event.kind in {"file.scanned", "file.observed"}:
            controls.extend(_file_controls(event.facts, assessment.score))
        elif event.kind == "process.started":
            controls.extend(_process_controls(event.facts, assessment.score))
        elif event.kind.startswith("network."):
            controls.extend(_network_controls(event.facts, assessment.score))
        elif event.kind == "persistence.entry_added":
            controls.extend(_persistence_controls(event.facts, assessment.score))
        elif event.kind == "security.posture_changed":
            controls.extend(_posture_controls(event.facts))
        elif event.kind == "device.connected":
            controls.extend(_device_controls(event.facts, assessment.score))
        elif event.kind == "software.installed":
            controls.extend(_software_controls(event.facts, assessment.score))

        if assessment.score >= 65:
            controls.append("Keep destructive remediation manual unless the user explicitly approves it")

        return _unique_reasons(controls)[:6]


def _unique_reasons(reasons: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for reason in reasons:
        normalized = reason.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(normalized)
    return unique


def _file_controls(facts: dict[str, Any], score: int) -> list[str]:
    path = str(facts.get("path") or "")
    controls = []
    if path:
        controls.append(f"Run Microsoft Defender or another trusted scanner on: {path}")
    if facts.get("mark_of_the_web") or score >= 35:
        controls.append("Do not execute the file until publisher, origin, and hash are trusted")
    if facts.get("magic_type") == "pe":
        controls.append("Verify Authenticode signature and publisher before allowing execution")
    authenticode_status = str(facts.get("authenticode_status") or "")
    if authenticode_status:
        normalized_status = authenticode_status.lower()
        if normalized_status == "valid":
            controls.append("Confirm the signer matches the expected vendor and file origin")
        elif normalized_status == "notsigned":
            controls.append("Treat unsigned executable or script content as untrusted until origin and hash are verified")
        elif normalized_status != "unavailable":
            controls.append("Do not execute the file until the Authenticode status is independently reviewed")
    if facts.get("script_suspicious_markers"):
        controls.append("Review the script offline for download, encoded-command, and persistence logic")
    if facts.get("archive_executable_entries") or facts.get("archive_macro_indicators"):
        controls.append("Inspect archive contents in isolation before extracting or opening entries")
    return controls


def _process_controls(facts: dict[str, Any], score: int) -> list[str]:
    controls = ["Review the process tree, command line, executable path, and parent process"]
    if score >= 65:
        controls.append("If the process is unexpected, isolate network access before terminating it")
    if facts.get("exe"):
        controls.append(f"Scan the executable backing the process: {facts.get('exe')}")
    return controls


def _network_controls(facts: dict[str, Any], score: int) -> list[str]:
    controls = []
    process_name = facts.get("process_name")
    if process_name:
        controls.append(f"Verify the owning process for the network endpoint: {process_name}")
    if facts.get("remote_is_public") or facts.get("remote_scope") == "public":
        remote = f"{facts.get('remote_address')}:{facts.get('remote_port')}"
        controls.append(f"Validate whether the public remote endpoint is expected: {remote}")
        controls.append("Check the endpoint reputation and owning application before allowing continued access")
    if facts.get("local_address") in {"0.0.0.0", "::", "[::]"}:
        controls.append("Confirm the listener needs exposure on all interfaces")
    if facts.get("dns_public_count"):
        controls.append("Confirm DNS servers were intentionally changed and match the trusted network profile")
    if score >= 35:
        controls.append("Restrict network access only after confirming the service owner and preserving evidence")
    return controls


def _persistence_controls(facts: dict[str, Any], score: int) -> list[str]:
    controls = ["Confirm the persistence entry owner before disabling or deleting it"]
    target = facts.get("value") or facts.get("path") or facts.get("actions")
    if target:
        controls.append(f"Scan the executable or script referenced by the persistence entry: {target}")
    if score >= 65:
        controls.append("Export the startup entry or scheduled task details before remediation")
    return controls


def _posture_controls(facts: dict[str, Any]) -> list[str]:
    kind = facts.get("kind")
    if kind == "firewall_profile":
        return ["Re-enable the firewall profile or restore inbound defaults if this change was unexpected"]
    if kind == "defender_status":
        return ["Re-enable Microsoft Defender protections if any protection flag is disabled"]
    return []


def _device_controls(facts: dict[str, Any], score: int) -> list[str]:
    controls = ["Confirm the connected device is recognized and expected"]
    if score >= 35:
        controls.append("Disconnect the device if it is unknown, then preserve the audit entry")
    if facts.get("instance_id"):
        controls.append(f"Record the device instance id: {facts.get('instance_id')}")
    return controls


def _software_controls(facts: dict[str, Any], score: int) -> list[str]:
    controls = ["Verify publisher, install path, and uninstall metadata for the new software"]
    if score >= 35:
        controls.append("Run a file scan on the installation directory before launching the software")
    if facts.get("install_location"):
        controls.append(f"Review installation path: {facts.get('install_location')}")
    return controls
