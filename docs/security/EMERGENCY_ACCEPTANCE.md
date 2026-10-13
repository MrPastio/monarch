# Security emergency acceptance

The native acceptance scenario belongs in a disposable Windows VM. Use known test Windows credentials and a newly generated Security PIN. Preserve the source VM by snapshotting it and running a separate clone. Never attach a production Safe or Security data directory.

## Preparation

Run `scripts/security/install-response-executor.ps1` elevated inside the clone. Supply an explicit standalone `PythonPath`, an unused absolute local `TestRoot`, and `-ConfirmIsolatedWindowsVm`.

The helper rejects an existing test root, an existing response executor task, virtualenv launchers, and reparse points. It creates a protected runtime copy, including Python, owned by Administrators and writable only by Administrators/SYSTEM. The current test user can write only the separate data/log directories. Runtime attestation and the digest check remain mandatory. Preparation failure leaves its directory for inspection; choose a new root for another attempt.

`scripts/security/emergency-test.toml` disables real sensors and notifications. Its labelled synthetic events exercise the ordinary correlation, elevated containment, native lock, and PIN resolution paths without reading host files or credentials.

## Evidence required

1. From a normal, non-elevated guest desktop, verify the executor's signed heartbeat and configure a test PIN through stdin.
2. Start the protector with the isolated config and `--no-llm`.
3. Invoke `emergency-test --confirm-emergency-test`. Verify a signed active containment action for the synthetic endpoint and observe the Windows sign-in screen.
4. Sign back into the test Windows account. A wrong Security PIN must leave containment active.
5. A correct PIN with `continue` must execute the bounded containment extension. A subsequent `release` must execute elevated rollback, leaving no active test actions or firewall rules.
6. Verify that the already-running protector heartbeat sees `released`; checking a newly launched CLI alone does not establish synchronization.
7. Stop the test protector using the confirmed, purpose-bound PIN stdin request. Preserve evidence and shut down the test VM.

Mocked lock/firewall calls, successful source tests, or `LockWorkStation()` returning true do not establish native acceptance. Record installed-product acceptance separately. The diagnostic CLI is retained for VM acceptance; the temporary desktop button/capability has been removed after native acceptance.

## 2026-09-30 Codex result

Native source-runtime acceptance passed in `Monarch-Security-QA-20260930`, a linked clone of the preserved `Monarch-QA-d9a3d06` snapshot `security-base-20260930`. No shared folders, clipboard, or production data were attached. The accepted protected guest runtime is `C:\MonarchSecurityAcceptance20260930R2\runtime`; writable test state/logs are its separate siblings.

The normal, non-elevated guest test verified the signed executor heartbeat, configured its disposable PIN through stdin, started the protector, and invoked the labelled test. Elevated containment was active for only `198.51.100.77:4444/tcp`, and the Windows sign-in screen was observed. After Windows sign-in, the wrong Security PIN was rejected without releasing containment. Correct-PIN `continue` and `release` executed, all active actions were removed, and the already-running protector observed `released`. The confirmed stop command then succeeded. A separate native `Get-NetFirewallRule -Name 'MonarchSecurity-*'` query returned no rules, with exit code 0.

Evidence is preserved under `E:\MonarchArtifacts\security-20260930`: `vm-evidence.jsonl`, `vm-r2-signin.png`, isolated QA scripts, and ISO images. Do not copy disposable Windows credentials or PINs from these scripts/state into project documentation, logs, chat, or memory.

The earlier guest attempt exposed a real timeout boundary: CLI acknowledged for only 20 seconds while native Firewall execution could take 30. It also exposed partial-install cleanup risk. The diagnostic wait now covers installation plus cleanup; SYSTEM rollback is registered before Firewall mutation, and failed installation attempts remove any partial rule. Failed cleanup stays `pending` for reconciliation.

Source checks: 88 Python emergency/response/integrity-control tests ran (87 passed, 1 skipped symlink fixture); 68 focused application/UI tests passed; after removing the desktop hook, 27 relevant tests passed again. TypeScript, JS syntax, and diff checks passed. This does not establish packaged, installed-product, signed, or published acceptance.

VM completion note: VirtualBox save-state failed with `VERR_DISK_FULL` (about 1.7 GB remained on host E:). Guest shutdown entered Windows Update. The clone was paused to stop further disk growth; after owner-approved storage cleanup, resume only this clone and let its update/shutdown finish. No files or source VMs were deleted.

## Agent constraints

Codex/Claude must review each Security change before release. Antigravity is denied and must not operate this acceptance flow or these runtimes. Never bypass runtime attestation or widen the pipe DACL to Everyone/Anonymous. Do not delete or reuse existing test directories, including `E:\MonarchSecurityExecutor`, as part of preparation.
