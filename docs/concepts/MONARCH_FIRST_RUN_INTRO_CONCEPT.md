# Monarch First-Run Introduction — concept only

Status: **CONCEPT / DISABLED**
Runtime integration: **none**
Release scope: **not included in 0.2.5 unless the user explicitly reactivates it**

This document preserves the product idea only. Do not import it into the UI, add an automatic marker, expose a replay control, package implementation assets, or restore the prototype without a new explicit decision.

## Product intent

A cinematic introduction shown only once on the first launch of Monarch on a device profile. Its purpose is to explain the product through motion and synthetic demonstrations without delaying later launches.

## Proposed flow

### Opening

- Maximum duration: 30 seconds.
- Standard Monarch crown/shield logo appears first.
- Product module marks then move outward around the main logo: Oscar, Models, Voice, Memory, Coder, Computer Use, Security, Safe, Sharing, Telegram, Images, Modules/Studio.
- Click, `Enter`, or `Space` skips only the opening and starts the tour.
- No sound.

### Guided tour

Target duration: 90–120 seconds with autoplay, pause/resume, previous, next, and skip.

Proposed scenes:

1. Oscar and local model routing.
2. Memory and Incognito boundaries.
3. Coder and Computer Use with explicit permissions and verification.
4. Monarch Security.
5. Monarch Safe and its isolated boundary.
6. Sharing and Telegram.
7. Images `TEST BETA` and Studio `ALPHA`.
8. Autonomy, permissions, Stop/revoke, and action history.

## If reactivated later

- Claim the one-time state before displaying the intro so a crash cannot cause repeated automatic playback.
- Keep manual replay separate from normal startup-animation preferences.
- Use only synthetic content and bundled assets. No API calls, user files, chat history, secrets, or Safe access.
- Preserve keyboard control, focus trapping/restoration, `prefers-reduced-motion`, visibility pause, WebGL fallback, and complete timer/RAF/listener cleanup.
- Keep motion restrained, coordinated, and purposeful: glass surfaces, black/orange/white/yellow palette, transform/opacity transitions, no flashing or arbitrary rapid loops.
- Re-run source tests plus packaged Electron acceptance on a clean Windows profile before release inclusion.

## Archived prototype record

An uncommitted prototype was built and QA-tested on 2026-08-14, then deliberately removed from all runtime surfaces at the user's request. The implementation files, imports, settings control, automatic marker, and dedicated tests are not retained in the active source tree. This document is the only supported continuation point.
