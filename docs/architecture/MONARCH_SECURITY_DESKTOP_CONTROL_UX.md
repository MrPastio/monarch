# Security desktop controls and UX — 2026-09-08 Codex

Owner reported that protection still could not be enabled and supplied the paused-screen screenshot. This pass fixes the actual UI transport and reorganizes the overview around protection and manual checks.

## Confirmed cause

The Security UI called `executeConfirmedCapability`, which entered legacy `/api/execute`. Mutations in that route now require an Oscar/Agent action card. A product button therefore received `confirmation-required` with no usable continuation. Testing an internal Security command alone missed this failure. PIN-bearing controls must also never be converted to agent prompts.

`POST /api/security/control` now requires the authenticated, locally attested Desktop principal and matching origin. It accepts a versioned, bounded envelope and an explicit Security control allowlist. The application executes the exact user action through Kernel with Desktop provenance and confirmation. Kernel schemas, permission profile, Security policies, PIN requirements and Safe boundaries remain active. Agent and arbitrary API commands do not gain this route. Unknown capabilities, extra envelope keys, malformed shapes and invalid inputs fail closed.

## User experience

- One primary enable action starts persistent protection, including Windows sign-in startup. An explicitly disabled profile is first restored to balanced protection.
- One compact status surface; no second overview enable card or repeated paused status beside the heading. Loading and unavailable states cannot masquerade as paused or protected.
- File and system checks appear immediately below protection. Events use a compact row; sensor detail is collapsed initially. Settings own the separate autostart control and detailed Oscar check history.
- Disclosure transitions are interruptible and obey reduced motion. Native summary keyboard activation is retained.
- Cancelled scans use neutral feedback. Cancellation preserves background settings. Missing PIN setup opens the actual setup fields instead of asking for a nonexistent code.

## Validation

- Final focused suites: **118/118 passed**, 6 files: app/security-desktop-control, app/http-server, ui/api, ui/security-pane, ui/shared-controls, core/execution-security-confirmation. TypeScript `--noEmit` passed.
- Transport regression uses the actual UI API helper, HTTP server, Kernel and Security module with the background executor substituted. It verifies the exact new route and rejects missing attestation, foreign origin, unlisted actions, forged envelope fields and invalid input. Other tests cover profile-off activation order and absent-PIN setup.
- CUA independently exercised production UI assets, actual HTTP/Application control method, Kernel, SecurityClient and Python against an isolated root on E:. Clicking enable registered and started a real limited Windows background task; UI reached protected state. A harmless file scan completed, a system scan was cancelled, background protection remained running, and the cancelled job reattached after page reload. Sensor disclosure worked with mouse and Enter. The absent-PIN action focused setup. Overview and settings screenshots were visually inspected in CUA.
- This fixture selected only its own harmless file and watched only its own directory. It used test-only bridge credentials, no Oscar/model, no user's PIN, Safe or credential store. Its automatic cleanup exited 0, removed only its task and stopped its worker. Readback records `/api/security/control` and zero Oscar/agent routes. Ordinary read capabilities still use `/api/execute`.
- Final committed snapshot bundled successfully and passed its executable help smoke. Immutable local development **0.3.0.24** was prepared from retained .23. Nine source/bundle overlays passed SHA256 readback. Pointer activation retained .23 as previous; launcher `--verify-install` exited 0.
- Actual installed .24 Python status readback sees existing protector PID3992 as `protected`, background host PID36872 running, startup registered and no background error. The user's existing scheduled task remains running after fixture cleanup.

## Evidence and limits

`<qa-artifact-root>/security-control/` contains committed-source/build, source.zip, prepare-install.ps1, installed-overlays.json, install-readback.json, installed-background-readback.json and live-ui/readback.json. CUA screenshots were rendered in the task, not exported as image files.

The full user's native Electron session was **not restarted**: source main PID41244/backend PID44276 still retain the previous loaded code. Fully exit Monarch from its tray menu and launch `<installed-app-root>/Monarch.exe` for the updated installed UI/backend. Source Security and installed Security have distinct existing data roots; they were not merged or repointed. Fixture UI acceptance does not claim that the user's still-open native window received the update. No real reboot/sign-out, new long-run soak or new reduced-motion emulation was performed in this pass; reduced-motion handling is preserved in source. No public/signed release was created.

## Handoff boundaries

Code commit: `6dfcabe392d764da7042e54b9f631cf459b076e4`, branch `codex/site_monarch`. Changed files: application.ts, http-server.ts, new security/desktop-controls.ts, UI index.html/api.js/security-pane.js/security-center.css, new app transport test and existing Security UI test.

DO NOT remove/recreate the real task `Monarch Security 16a852b047bf517e` during test cleanup. Its arguments still pin .23, whose Python code is unchanged in .24. Retain .23, .24 and their runtime/environment. Do not bypass PIN/Kernel, restore Oscar prompt routing for direct product controls, expose PINs in prompts/logs, or merge source/installed Security state. Leave unrelated dirty architecture/agent/Telegram work and Safe/keys/data untouched. Antigravity remains denied under the existing admission policy.

Next: verify the owner's normal restarted installed window, then integrate scheduled-task version rebinding with update transactions before any old-version cleanup. At documentation time the owned code is committed and index empty; unrelated tracked/untracked work and shared AI_HANDOFF.md remain dirty.
