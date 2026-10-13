# Security notification repair and reboot acceptance

2026-09-09 Codex

Owner reboot confirmed: Windows boot 14:34:40, Security task started .26 at 14:34:56, watchdog9504/protector20552, no Monarch Electron/backend open. This proves post-repair startup without the app window. Owner then supplied a tray full of yellow warning icons.

Confirmed mechanism in notifications.py: every alert spawned a detached PowerShell creating its own Windows Forms warning NotifyIcon. Cooldown was per subject, so distinct startup events could fan out into many icons. Shell invocations also contain process-rule attention markers; no blanket process trust exception was added.

Replaced delivery with windows_notifications.py: one native Windows icon owner thread in the protector, bounded latest-event slot and burst count, summary for concurrent alerts, message pumping, explicit NIM_DELETE/DestroyWindow cleanup and interpreter-exit cleanup. Notification presentation launches no subprocess. Delivery reason now says queued rather than claiming synchronous display. All underlying incidents remain; no trust baseline auto-acceptance.

Validation: 17 notification/background tests passed. A 1000-event synthetic burst used one presenter and two presentations (initial plus summary), bounded pending state; delivery failure closed resources. Actual Windows native show/cleanup returned success with zero shell children. Installed development .27 copied retained .26, two SHA256-verified overlays from a15b84b831b627acc599aa9ce0b894c5f21fab55; launcher verification exit0. Artifacts: `<qa-artifact-root>/security-notifications`.

Actual task rebound .27; maintenance stopped old host and requested authenticated protector shutdown, then started existing task. Signed background preferences compared identical. New host11604/protector13988 execute .27. Fresh status: protected, 8/8 healthy, no background error; no old notification shell processes. Safe, keys and PIN unchanged. Current=.27/previous=.26; retain all existing versions and payloads.

Native UI acceptance .27: real app/backend launched, Security shows protection working and 8/8 healthy. Closed the native window with its X; it disappeared from window inventory while the same background PIDs remained live and task Running. Reopened the same window; protection status remained healthy. System check started by real button and completed with 640 events, 62 attention signals; these are observations requiring review, not confirmed malware. No incident was approved or remediated.

File chooser opens, but Computer Use reported stale child element and incorrect focus; cancelled it without selecting user data. Native file-scan acceptance was not completed here (earlier isolated route acceptance remains separate). Owner subsequently confirmed no warning icons now: many appeared only at startup and gradually diminished. This supports a burst of temporary per-alert icons; persistent Explorer ghost icons were not established. Tray readback is no longer pending. No second reboot of .27 required for the unchanged startup path; .26 reboot proof and .27 scheduled restart proof are distinct.

## Final native file acceptance — supersedes picker limitation above

At 14:58 the visible caret confirmed focus in the native filename field despite incorrect accessibility focus reporting. Using supported Computer Use typing and Return selected only the pre-created harmless-check.txt in the artifact directory. Actual installed UI showed local checking, then completed with no dangerous indicators, risk0/800, and one recent check for that exact file. Protection remained working,8/8 healthy. No source change was necessary for this instrumentation issue.

## Completion audit

| Requested behavior | Evidence |
| --- | --- |
| Enable protection without dead-end confirmation | Dedicated authenticated Desktop route through Kernel; prior real route fixture enable; production background enabled and running |
| Start with Windows independently of open app | Actual owner reboot: .26 task/watchdog/protector started before Electron/backend |
| Work after closing window | .27 native X-close removed window; same background processes/task stayed live; reopen healthy |
| Reliable state persistence | Durable signed writes/recovery tests; owner-approved zero-state recovery; state survived actual reboot |
| Clear usable overview and working checks | .27 native overview,8/8 truthful sensor state; real system check and real native-file check completed |
| Update/rollback support | Pointer-fenced action migration tests and real isolated Scheduler commit/rollback; actual .27 task target and live runtime; retention reference guard installed |
| Reset old PIN without new PIN | Source record archived in its private directory; installed PIN absent/unlocked, zero attempts; no new PIN |
| Fix startup notification fan-out | Native in-process single presenter, bounded1000-event burst test, actual native show/cleanup, .27 running, owner confirms icons absent |

No required acceptance remains open. This is a local development installation, not a signed/public release or a malware-free-system guarantee. Existing attention signals require owner's review and were not auto-approved. Multi-day soak is not claimed. Preserve Safe/keys, retained installations and unrelated dirty work.
