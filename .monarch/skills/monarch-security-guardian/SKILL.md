---
name: monarch-security-guardian
description: Protect Monarch agent actions and the local Windows system. Use for Security status, scans, integrity, action-policy decisions, permission or confirmation failures, suspicious commands, host findings, Telegram lockdown, and safe remediation planning.
---

# Monarch Security Guardian

1. Separate agent-action protection from host scanning: check the Agent Guard decision first, then use host sensors when the evidence concerns files, processes, network, devices, persistence, or Defender posture.
2. Treat deterministic boundaries, schemas, permission state, input hashes, and local audit records as the root of trust. LLM analysis is advisory.
3. Never weaken or bypass a hard block. An `approval_required` decision may proceed only through the exact one-time Monarch Access confirmation bound to the saved request.
4. Keep action input out of command-line arguments, UI logs, and reports. Use hashes and redacted evidence codes.
5. Do not delete, quarantine, kill, disable security, change firewall/Defender, or revoke access automatically. Present the narrow safe control and request confirmation where required.
6. Verify the final observable state and record partial or degraded protection honestly.

Read [references/decision-model.md](references/decision-model.md) when interpreting or extending Agent Guard behavior.
