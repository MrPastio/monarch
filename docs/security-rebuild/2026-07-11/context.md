# Monarch Security rebuild — evidence context

This is a derived design artifact. The reviewed source remains the evidence.

- Target: current `<MonarchRoot>` working tree
- Git base: `e4f7005754671207bce8b8d17b784929221a586e`
- Source drift: present; the working tree already contains unrelated and overlapping changes
- Evidence collection SHA-256: `382d9429807092fca0726938e82257f07fa750a23040bde77219d23b3532c354`

## Evidence inventory

| ID | Source | What was inspected |
| --- | --- | --- |
| E01 | `security/src/monarch_security/supervisor.py` | Sensor scheduling, event handling, policy routing and notifications |
| E02 | `security/src/monarch_security/events.py`, `analysis/rules.py` | Current event/assessment model and 0–100 score |
| E03 | `security/src/monarch_security/policy/engine.py` | LLM action clamping and advisory controls |
| E04 | `security/src/monarch_security/sensors/network.py` | Passive PowerShell snapshots of adapters, DNS, neighbors, TCP listeners and established TCP connections |
| E05 | `security/src/monarch_security/sensors/file_watch.py`, `processes.py` | Polling-based file/process observations without cross-event correlation |
| E06 | `security/src/monarch_security/notifications.py` | One-way desktop notification with cooldown |
| E07 | `security/src/monarch_security/deep_scan.py`, `security/README.md` | Authenticode, optional Defender and explicit opt-in VirusTotal behavior |
| E08 | `src/modules/security/manifest.ts`, `index.ts`, `src/ui/public/modules/security-pane.js` | Monarch capabilities and current UI integration |
| E09 | `audit/01-security-stopped.png`, `audit/02-security-running.png` | Live stopped-to-running Security UX at 1280×720 |

## Evidence limitation

This is a source-backed architecture review, not a completed vulnerability scan. No kernel driver, WFP callout, ETW consumer, Windows service installer, quarantine vault or emergency desktop-control mechanism exists in the reviewed evidence. Performance and false-positive rates have not been measured.
