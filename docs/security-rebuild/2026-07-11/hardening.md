# Security Hardening Review: Monarch Security rebuild

## Evidence Basis

I inspected the current Python supervisor, sensors, scoring/policy path, notification path, deep file scan, TypeScript bridge and Security UI. The existing module is a useful local-first scanner and agent guard, but it is not yet a system protection control plane: detections are independent events, notifications are one-way, and there is no incident lifecycle or privileged response boundary.

## Constraints

- Windows-first and local-first; cloud reputation remains explicit opt-in.
- Deterministic evidence is the root of trust; an LLM cannot independently authorize containment.
- Destructive actions always require the user. Emergency automation must be reversible, time-bounded and fail open to the legitimate local user.
- Existing scans, Agent Guard, audit integrity and current UI continue working during migration.
- UX is part of the security control: the UI must distinguish protected, starting, degraded, attention-needed and stopped states without exposing raw runtime details as the primary explanation.
- Current working tree is dirty, so implementation must be delivered in narrow packages without overwriting existing Security/UI work.

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| Build an incident-centered protection control plane and comprehensible Security UX | Independent sensor decisions, 0–100 score, one-way notifications, snapshot-only network monitoring and an unclear stopped-to-running UI (E01–E09) | 1. Harden monolith; 2. Local broker and privileged service; 3. Driver-assisted endpoint stack | Option 2 now; selectively add Option 3 collectors only after measured need | [Proposal](proposals/security-control-plane.md) |

## Recommendation Summary

I recommend Option 2: preserve the current scanners as collectors, add an incident/correlation core and place every system-changing action behind a narrow local response broker. The privileged executor becomes a Windows service with an allowlist, expiry, rollback and audit; the UI and LLM stay unprivileged. This gives us credible containment without handing ambient administrator authority to model output.

The 0–800 risk scale belongs to the incident, not to a single event. A score of 700–800 must require corroboration from at least two deterministic evidence families or one high-confidence trusted-engine verdict plus harmful behavior. The LLM may explain, prioritize and propose a response, but it cannot create an emergency score or bypass the PIN/user gate.

The live [UX audit](audit/security-ux-audit.md) confirms that starting protection currently exposes a PID and raw CLI command rather than protection coverage or progress. The redesign must make incidents, manual file scanning and network state primary; baseline, integrity, audit and Agent Guard become secondary detail surfaces.

## Next Decisions

- Approve Option 2 as the target architecture.
- Approve the safe emergency rule: use the native Windows workstation lock and a separate Security PIN for resuming Monarch containment; never implement a custom full-screen lock shell.
- Choose whether network enforcement in the first release is per-process Windows Firewall rules only, or whether WFP/ETW research starts in parallel.
- Then implement Milestone 1: incident schema/store, 0–800 scoring, protection state model, alert inbox and manual deep-file lab, with no destructive actions.
