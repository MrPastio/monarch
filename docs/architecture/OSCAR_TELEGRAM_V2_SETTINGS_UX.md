# 2026-09-08 Codex — Telegram settings redesign

Goal: replace the overloaded V2 settings sheet with a short connection wizard and focused everyday controls. This is an incremental development build; the full V2 real-account acceptance remains pending.

## Changed behavior

- Settings → Telegram starts with a compact glass surface: connect, then an overview with conversations, files, secretary and cloud. Legacy controls stay in a collapsed disclosure.
- Main bot setup verifies and encrypts the token through the existing desktop broker, restarts its transport, creates a five-minute link, waits for the candidate while the view is visible, and requires explicit local account confirmation. A new link clears the old candidate transactionally. Returning to setup resumes an unexpired link.
- Each section has one focused screen, parent navigation, heading focus, interruptible directional motion and reduced-motion cancellation. Passwords clear on submit, leaving the section and page hiding. Model/cloud processing consent remains explicit; permissions and exact queue proposal digests are preserved.
- The folder chooser uses the existing trusted desktop picker with a Telegram-specific title. Secretary pause preserves selected recipients; cloud activation requires verified transport readback. Model dropdown labels are outside their popover container to avoid reopening on option clicks.
- Prior pending secretary work is included: shorter/friendlier/formal draft rewrites, stale draft invalidation, bounded complete JSON context and a native contact link. These never send a reply by themselves.

## Validation

Focused Telegram V2, secretary, desktop control and Electron policy tests; TypeScript; runtime bundle build. Edge synthetic bridge fixture exercises pairing, explicit MAX consent/save, folder grant, parent navigation, password cleanup, cloud activation sequencing and all ten secondary views at 1120/360px. No horizontal overflow. Motion enabled: one view animation; reduced motion: zero. Screenshot and fixture evidence: `<qa-output-root>/playwright/telegram-v2/`.

These fixtures use synthetic identities and credentials, not a real Telegram account. The initial dropdown click failure was repaired in markup and the exact click/save flow passed. The initial new pairing assertion expected undefined rather than the store's documented null; corrected, then rechecked.

## Delivery and remaining scope

Prepare immutable development version 0.3.0.18 from retained 0.3.0.17 with owned source/bundle overlays and verified hashes. Do not interrupt an active user session; the new version applies on restart. Keep the existing Telegram Python environment and all previous versions.

Cloudflare Worker is already deployed at `https://oscar-personal-bot.oscar-personal-bot.workers.dev`; HTTPS health reported version 2, configured false. No Telegram/device/MAX secrets were uploaded and no real webhook switched. User pairing and cloud credentials are still needed through product settings. Cloud deployment parameters and secretary chat IDs remain advanced setup limitations; do not describe them as a finished one-click setup.

The existing Security scan is sealed. Seven prior candidates remain deferred after two automatic-review rejections; this UX work does not validate those cases or reopen that scan. Preserve Safe, user data/keys, retained installations, exact model binding and Kernel permission checks. Do not stage shared unrelated edits.
