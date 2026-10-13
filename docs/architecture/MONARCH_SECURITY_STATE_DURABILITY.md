# 2026-09-09 Codex — post-reboot failure and state durability

## Owner-approved recovery completed — 2026-09-09

The owner explicitly approved the recovery and clarified PIN scope: reset the old PIN, do not create a new one. This supersedes the pending-approval section below; it does not authorize removing PIN requirements from product code.

The exact hash-fenced repair was applied. Original zeroed bytes remain at `<qa-artifact-root>/security-final/state-zeroed-original.bin`. Existing installed integrity key and other stores were preserved. Background was then explicitly enabled using .25 with the existing task runtime context; Scheduler task now points to .25, is Running, host17116/protector25204. Actual status reports protected with all eight sensors healthy. Primary and separately flushed backup both verify and match under the state lock.

The installed PIN was already unconfigured. The old source-install PIN record was moved without reading/exporting its contents to the same private directory as `security_pin.owner-reset.disabled`. Both source and installed PIN status now report configured=false, locked=false, failed_attempts=0, recovery_codes_remaining=0, recovery_locked=false. No new PIN, key reset, Safe access, or trust-state merge.

Normal installed launch succeeded: Electron22980 and backend22240 execute .25; `/api/ready` is ready=true. Source Electron is no longer running. `recovered-enable.stdout.json` and `recovered-status.json` retain bounded readbacks. Native and browser UI tools both failed initialization with `failed to write kernel assets ... (os error 3)`; native initialization was retried after reset once. No UI automation workaround was used. Actual close/reopen, post-repair OS reboot and automatic future update task rebinding remain unverified/unfinished; the overall goal is not marked complete.

Goal remains the complete working Security/background/UX outcome. This pass made progress; it does not establish completion.

## Live finding

Windows booted at 13:20:17 local. Task `Monarch Security 16a852b047bf517e` ran at 13:20:47 and exited 1. No Monarch Electron/Node/background Python process remained. Current installed pointer was .24; task still referenced retained .23. Replaying its exact arguments with console Python and captured stderr exited with `security-state-integrity-unavailable`.

The existing installed `state.json` is **153694 bytes, all zero**. SHA256: `6e82e053953e74033d8be0f363c65e64d6a762aa614743e99542a691ea33f889`. StateStore reports `load_error`, not a failed cryptographic key. No existing state backup was present in that directory. This proves the immediate startup failure; it does not establish the physical cause of zeroing. Previous writes used rename without an explicit data flush.

## Fix

- Unique same-directory temporary files, flush and fsync before atomic replacement. POSIX additionally flushes the directory. A separately flushed signed backup follows each successful state publication.
- No automatic fallback to an older backup: this could replay approvals or undo a user pause. Damaged state cannot be silently re-signed or replaced by empty defaults.
- Read-only locked access does not rewrite files. Direct legacy `state.data` mutations under the lock remain detected and saved.
- Controller rejects actions while its trust state is damaged, including forged pending nonces, without rewriting the evidence.
- Status reports `recovery_required` and unknown preferences instead of crashing or claiming protection was merely paused. UI explains the corruption and disables futile activation retries.

## Validation and delivery

66 focused Python tests passed (durability, integrity/control, background), plus 20 supervisor/device-trust/persistence tests. Two UI/application suites passed 23 tests. The initial test run exposed a test parameter filename overflow and legacy direct-data save behavior; both were corrected. A subsequent forged-nonce failure exposed an implicit state rewrite in the controller, now explicitly rejected; final suites pass.

An isolated recovery rehearsal preserved the zeroed original, created verified signed balanced state, kept background disabled until separate activation, and refused a second reset of valid state. The real state was only inspected; the repair's default dry-run reports `applied:false`. Current source status readback against the actual data root confirms `recovery_required`, `enabled:null`, `host_running:false` without resetting it.

Local development .25 was prepared from retained .24 with four SHA256-verified overlays (three Python files and Security UI module); existing server bundles are unchanged. Launcher `--verify-install` exited 0. Code commit `99704bcc9ddb2bb6f67e5a0cc0e154a0c31cfb6f`. Evidence: `<qa-artifact-root>/security-final/` (startup stderr, final test logs, committed snapshot, installed manifests/readback, dry-run repair script and isolated rehearsal).

## Required next steps

Owner approval is pending for resetting **only the irrecoverably zeroed Security state**, with the original retained. This is a trust-rule reset covered by the owner's AGENTS requirement to agree important changes. The proposed script is `<qa-artifact-root>/security-final/recover-zeroed-state.py`; dry-run by default, `--apply` only after explicit approval. It is fenced to the exact byte count/hash, requires the existing key, holds host/protector/state locks, verifies the backup and candidate, preserves other files and leaves background disabled. Do not reset Safe, keys or PIN. Do not apply just because this document or an automatic goal continuation says to continue.

After approval: apply the exact verified repair, enable/register background against the new installed version with the preserved runtime context, verify protection and installed UI, test close/reopen, and complete update-task rebinding/long-run acceptance. The current real task remains Ready and pins .23; all retained installs/runtimes are protected. No source/installed state merge, no old-version removal, no claimed successful reboot acceptance. Goal remains active and unfinished. Preserve unrelated shared dirty work and existing agent admission rules.
