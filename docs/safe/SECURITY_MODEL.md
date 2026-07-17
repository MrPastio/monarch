# Monarch Safe — Security Model

## Current boundary

Monarch Safe is a desktop-only encrypted vault. The shared Monarch HTTP API, Oscar, and the module kernel receive no vault keys, ordinary file content, names, or manifest data. The vault runs in a dedicated Electron utility process. The sandboxed, network-denied Safe renderer owns setup and unlock. The trusted main Monarch renderer receives only a separate chat-scoped service (`status/list/read/upsert/delete/lock`): it cannot request ordinary Safe files, keys, PIN/recovery operations, or an arbitrary vault command. While Safe is unlocked, the main renderer necessarily receives the selected chat plaintext for display and editing; this narrower boundary is described under limitations. The Safe session permits only its bundled `file:` resources plus generated `blob:`/`data:` resources, denies downloads, navigation, popups, permissions, and external launches, and is destroyed on Windows lock/suspend.

Production vault data is stored outside the source workspace, on the same volume as Monarch, under `MonarchData/Safe/safe-v1` (for example, `<DataDrive>:\MonarchData\Safe\safe-v1`). Entry QA continues to use a disposable temporary Electron profile. The production directory contains only the protected device key, authenticated encrypted configuration/manifest, and encrypted blobs; it must never be added to the repository or exposed through the shared workspace API.

## Protected assets and controls

- File bodies and the manifest are encrypted with authenticated AES-256-GCM envelopes.
- Every stored file version receives a random 256-bit data-encryption key and an immutable random blob generation. The wrapped key and active generation live only inside the encrypted manifest. A write commits the new generation before removing the previous one; deleting a file commits a manifest without its key before best-effort ciphertext cleanup.
- The authenticated manifest has a monotonic sequence inside the encrypted envelope. Startup can select the newest valid current/previous/next manifest candidate after an interrupted local replace, then removes unreferenced Safe blob generations.
- The PIN uses a memory-hard scrypt derivation and a 32-byte device secret protected by Electron `safeStorage` on Windows. A copied vault cannot validate its PIN without that protected device binding.
- PIN configuration is authenticated by a device-key HMAC. A damaged or foreign-device seal blocks PIN attempts without decrementing the counter; a recovery key remains the portable path.
- Three high-entropy recovery keys wrap the vault key independently, so a recovery key can still be used if the device binding is unavailable. A successfully used recovery key is removed from the active configuration.
- Three incorrect PIN attempts replace the active key envelopes with a terminal destroyed record before payload cleanup begins.
- Setup stays in a pending state until the user acknowledges that all three recovery keys were saved; interrupted empty provisioning can be reset without silently activating an unrecoverable vault.
- The Safe renderer has Node integration disabled, context isolation and Chromium sandbox enabled, no network permissions, no popups or navigation, no external program launch, no system clipboard operations, and an ephemeral Electron session partition.
- Locking clears rendered metadata, credential/editor values, object URLs, and in-process key buffers that Monarch directly controls. Auto-lock is serialized with active vault operations, so it cannot invalidate the manifest halfway through a commit. In production, successful manual/automatic lock, window hiding/minimizing, OS lock, and suspend destroy the Safe window and utility process; the next open starts a clean authentication session.
- Overwriting and deleting an existing file require a short-lived, action/resource-bound, single-use capability minted by the main process after native confirmation. The generic renderer bridge cannot perform either operation without it.
- File deletion and three-attempt vault destruction perform active-key erasure first and best-effort overwrite/truncate/remove of ciphertext files second. Recovered historical manifests or backups remain part of the physical-storage limitation below.
- Encrypted Oscar chats and Coder runs are hidden authenticated Safe records, not ordinary vault files. Each generation gets a fresh random data key and encrypted blob; chat metadata is inside the encrypted manifest and records do not appear in the normal Safe file list.
- Chat migration is commit-before-delete: Monarch writes and decrypts/verifies the Safe generation before deleting the ordinary source. Oscar deletion uses SQLite `secure_delete=ON` and a truncating WAL checkpoint; Coder deletes the terminal JSON journal. If source deletion fails, the new Safe record is rolled back and the plaintext source remains authoritative.
- Encrypted Oscar continuations use incognito/no-memory requests, so new turns are not written back to Oscar conversation history or long-term memory. Safe lock clears active encrypted Oscar/Coder state from the UI and stops further encrypted-chat rendering.

## Honest limitations

- No desktop application can promise physically irreversible overwrite on every SSD, filesystem snapshot, backup, pagefile, crash dump, or previously copied source. Monarch therefore treats key destruction as the primary erasure guarantee and physical overwrite as best effort.
- Import currently copies data into Safe. The original source file outside Safe remains the user's responsibility and may also exist in backups or sync history.
- A 4-digit PIN is still weak by itself. Device binding prevents ordinary offline PIN checking from a copied vault, but 12 digits or a recovery key is the recommended policy.
- An administrator, kernel-level compromise, malicious firmware, or malware already executing as the same Windows user while Safe is unlocked is outside the boundary of this version.
- A compromise of the trusted main renderer while Safe is unlocked can read chats opened through the chat-scoped bridge and data currently present in renderer/process memory. Locking removes the application-controlled references, but cannot prove physical erasure from pagefiles, crash dumps, GPU surfaces, backups, or freed SSD blocks.
- Migrating an existing chat removes the live Oscar database row or Coder journal only after verification. SQLite cells and WAL are actively scrubbed/truncated, but storage snapshots, backups, previous copies, filesystem journals, and SSD remanence remain outside the guarantee.
- The utility process is a same-user Electron/Node process with ambient OS authority. The current Electron utility runtime did not expose Node's permission model during a local probe, so a true Windows AppContainer/restricted-token helper remains a separate architectural step; the dedicated process is failure separation, not an OS privilege boundary.
- Reads/imports still use whole-file buffers with a 256 MiB per-operation limit. Text editing is capped at 4 MiB and HEX editing at 64 KiB, but large-file streaming/range IPC is not implemented yet.
- Images, audio, and video are rendered inside the isolated Electron window using bundled Chromium decoders. PDF currently receives a bounded structural summary rather than page rendering. Unknown formats are stored and shown as bounded hexadecimal data; arbitrary third-party archive formats are not executed.
- The only archive format is authenticated Monarch Safe Archive (`.msa`) with strict descriptor and total-size bounds. Its gzip/gunzip implementation is still synchronous, and extraction is not yet one all-or-nothing manifest transaction.
- The device seal detects configuration modification but is not a hardware monotonic counter. Restoring an older, otherwise valid sealed configuration from a storage snapshot is not yet detected.
- Recovery unlock consumes a key but does not yet run a mandatory new-PIN/device-rebind ceremony.
- Screen capture protection is enabled, but operating-system or physical-camera capture cannot be guaranteed away.

## Destructive recovery policy requiring product confirmation

The current implementation allows one recovery-key attempt per Safe runtime session; restarting Safe grants one new attempt. Changing this to one lifetime attempt with immediate vault destruction after a typo is intentionally not done silently because it materially increases accidental-loss risk. The final product policy must be chosen explicitly and then covered by destructive-state tests.

## Verification gates

- The focused Safe/chat regression suite currently passes 57 tests across six files. It covers plaintext-at-rest absence, hidden authenticated chat records, tamper failure, lock denial, bridge allowlisting/trust checks, generation rotation, rollback semantics, auto-lock/write serialization, Coder terminal-run deletion, and Oscar/Coder UI migration invariants.
- `desktop/safe/qa.mjs` exercises the real Electron renderer/runtime boundary with Windows `safeStorage`: 4/6/12-cell UI switching, setup and recovery display, section customization, file/archive flows, encrypted-chat upsert/list/read/delete through the utility-process service, image/audio/video/PDF/HEX policies, network/popup/clipboard denial, denied generic destruction, signed write/delete gates, one auto-lock event, and plaintext/credential cleanup after lock.
- The latest durable report is `output/safe-qa/qa-report.json`; it reports `ok: true`. This does not prove AppContainer isolation, large-file streaming, arbitrary-format viewers, lifetime recovery semantics, or snapshot rollback resistance.
