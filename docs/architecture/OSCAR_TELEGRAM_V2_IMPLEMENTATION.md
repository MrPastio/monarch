# Oscar Telegram V2 — implementation ledger

Owner-approved scope, 2026-09-08, Codex. This is an implementation record, not a readiness claim.

## Accepted product boundaries

- Native Telegram topics, navigation, shared Oscar conversations and exact task controls.
- Authenticated owner control is distinct from untrusted secretary messages and model output.
- Local, revocable grants scope computer operations; Safe and credentials are never remotely exposed.
- Optional personal Cloudflare Worker + SQLite Durable Object, selected MAX connection and selected conversation sync.
- A separate local secretary bot keeps the personal-message feed off the cloud webhook.
- Durable offline PC requests support local batch approval or explicitly scoped automatic execution.
- No automatic model/provider fallback, paid hosting upgrade, credential export, or permission expansion.

## Implementation and evidence

Baseline: branch `codex/site_monarch`, HEAD `2808469`; existing shared dirty changes preserved. Planning cohort: 91 Telegram tests passed using fixtures, not real credentials.

- [ ] V2 identity, durable state, local grants and dispatch enforcement
- [ ] Native topics/menu/history and exact task/approval/artifact binding
- [ ] Local secret broker and desktop setup
- [ ] Local secretary ingress, drafts, ownership and sending policy
- [ ] Personal cloud Worker, durable queue, MAX and device connection
- [ ] Desktop controls and selected conversation synchronization
- [ ] Expanded attachment extraction and actual route acceptance
- [ ] Focused, integration, security and rendered UI verification
- [ ] Installed developer-build verification
- [ ] Real account and published Cloudflare acceptance

## Rules for subsequent agents

Do not call an unmounted service, a mock-only test, or a configured flag a finished feature. Record pending account acceptance separately. Preserve shared changes, retained installations, Safe, user history and credentials. Telegram/cloud input never becomes local authority by trusting an input field, a model decision or a serialized command prefix. Migrations must not silently upgrade existing pairings.

## 2026-09-08 Codex implementation checkpoint

Source now connects opaque owner/topic identity, canonical history, native menus and task Stop, one-use approval-card handles, revocable path grants and the existing Kernel dispatch. Telegram V2 tasks are linked to the durable Turn before the runner starts; restart releases the same linked task. Legacy serialized command input and general API commands are blocked in V2.

The main-process broker stores bot/device/webhook secrets with OS encryption. Its exact-host transport performs verified polling/webhook switching without dropping updates. Secretary uses a different local bot, selected per-epoch chats, revision-bound drafts, manual editing/sending, owner takeover, and explicit expiring template rules (hourly cooldown, three replies/day). Unknown sends are never blindly repeated.

Personal Cloudflare source includes SQLite DO queue, alarms, hibernating WebSocket presence, exact MAX provider/model with input/output screening, durable multipart outbox, cloud pause, local list approval/scoped auto admission, exact Turn Stop, and versioned cloud-history revocation. Revocation stays pending locally until acknowledged; stale snapshots cannot reopen it. The PC remains the only executor of local actions. Cloud setup/configuration instructions are in cloud/oscar-bot/README.md.

PDF/DOCX decode in a disposable Python process with Windows Job Object memory/process limits (512 MiB, one process), parent timeout (10 s), bounded pipes/input/output, no inherited credentials, no extracted files, and an audit fence for filesystem/network/subprocess access after trusted decoder imports. DOCX XML entities, oversized archives and path traversal are rejected. Scanned/encrypted/unsupported documents return a failure, not invented text. pypdf 6.18.0 installed only into the development venv on E:; installed runtimes still require packaging/acceptance.

Evidence observed at this checkpoint:

- Focused Telegram/Oscar/MAX: 190/190; additional native Stop/approval/credential-switch suite: 5/5 (two broker checks overlap with the earlier run).
- Python migration/provenance 2/2; separate-process document checks 3/3 after fixing eager CP437 loading needed by ZIP before closing file access.
- TypeScript typecheck passes. Production Worker browser bundle passes local workerd/SQLite acceptance: 13 scenarios, synthetic Telegram/provider only. Latest recorded evidence: `<qa-artifact-root>/oscar-cloud-acceptance/proof.json`.
- Actual Edge fixture using source markup/modules/CSS: 1120px/360px without horizontal overflow, no console errors, password cleared after submission, reduced-motion running animations 0. `<qa-output-root>/playwright/telegram-v2/.playwright-cli`.

Still required: immutable-patch security review and fixes; deeper actual application/Kernel integration and attachment route checks; richer secretary waiting/agreements summaries and full model/capability settings; real Telegram mobile/Desktop acceptance; packaged/installed runtime validation; personal Cloudflare login, deployment and real free-quota/provider checks. No real credentials/correspondence were read, no deployment or installed update was performed. This checkpoint is not a completed V2 release.

## 2026-09-08 Codex — source review and revocation repairs

Foundation committed as `04076738e572e2ec41f2b9eca69055368f43bbb2` against `2808469`. Codex Security diff scan `7728e4b4-9f89-4340-bca7-633d88ded8bf` is completed and sealed, with **partial validation coverage**: all 39 source inventory paths reviewed; two medium and one low confirmed post-revocation findings. The exact report stayed in a local temporary scan directory and is not part of the repository. Canonical findings are observations of the foundation commit, not of subsequent fixes.

Three confirmed paths were reproduced with actual classes/SQLite and recording-only transports: deselected secretary recipient still sent a draft, pending approval delivery survived local-only change, pending history menu survived pairing revoke. Source repairs recheck current scope after awaits and at outgoing transport, preserve captured owner/epoch, refresh history bindings, and invalidate removed-recipient rules/drafts. Four dedicated revocation regressions now pass. V2 Arm now seals its follow-up handles too; a full arm/approve/replay fixture passes.

Seven other cloud/runtime candidate validations were rejected in two delegated turns by automatic safety review with only a generic possible-cybersecurity-risk reason. No replacement reproduction was attempted. They remain deferred in the sealed report; do not describe them as dynamically reproduced or verified fixed. Defensive source changes preserve latest task state after card delivery; bind the entire approved task identity/deadline; recheck expiration after acceptance; fence every subsequent cloud model call against control/dialog revision; stop a created task when its Turn was cancelled before linking; retain a synchronous cancellation fence at Kernel dispatch; consume the broker bootstrap bearer before integration children inherit the environment, using a private field thereafter. Accepted-without-local-Turn tasks can be locally reapproved; unstarted cancellation reserves the original client identity before cloud acknowledgement.

Checks after repairs: TSC PASS; focused revocation/secretary/ingress 15/15; Telegram regression run 91/91; queue/broker/coordinator 87/87; MAX plus native callback 22/22 (overlap, do not sum). Existing production workerd acceptance 13/13 at `<qa-artifact-root>/oscar-cloud-acceptance`; these normal functional scenarios do not replace the blocked concurrent-event tests. Runtime/MAX bundles built with help smoke under `<qa-artifact-root>/oscar-v2-build` before the last small secretary/transport fence refinements; rebuild before packaging. No installed update, live secrets, real Telegram sends or cloud deployment.

Remaining source work includes richer secretary workflows, complete capability/model availability controls, queue edit/expiry UI and full application-route acceptance. Then prepare a reviewable installed build and personal Cloudflare setup. Do not claim full V2 completion or sealed security acceptance for the repaired tree. Preserve Safe, user data, installed versions, provider/Kernel boundaries and unrelated shared work. Do not resume the rejected reproductions by rephrasing or using another execution route.

## 2026-09-08 Codex — native controls and personal hosting

Added exact Stop while paused (native draft, card and cloud cancellation channel), component-by-component stop-all with honest unconfirmed cloud results, draft recipient waiting/incoming queues, explicit owner-entered agreements, task titles, persistent search pagination, cancelled text-entry on menu commands, per-topic selection of a locally authorized MAX connection with immutable model identity in the admitted Turn, and capability availability disclosures. Secretary bot echoes cannot trigger template loops; edits retain chronological ordering. A confirmed sent draft updates the local conversation view.

Cloud native menus now support reminder creation/list/cancellation and queued proposal detail/edit/seven-day extension; edits bump the full proposal revision and are only accepted before PC acceptance. No plaintext secrets enter settings status. Desktop MAX permission does not export provider keys to Cloudflare.

Checks: 187/187 focused Telegram/secretary/cloud-device/broker/application/Turn checks; actual Application plus actual coordinator accepted two canonical conversations with separate histories and exact model snapshot, preserved idempotent request identity and completed outcomes. Synthetic model/history ports, no real account calls. TSC/build pass. Workerd acceptance expanded to 24 ordinary functional checks, evidence `<qa-artifact-root>/oscar-cloud-acceptance/proof.json`; does not replace the seven deferred validations. Edge UI caught and fixed a null snapshot when loading provider choices before status; initial visibility now loads status automatically.

Owner explicitly completed Wrangler OAuth. Created a new personal Worker (existing-name check returned not found), SQLite DO binding and workers.dev address without activating a paid plan: https://oscar-personal-bot.oscar-personal-bot.workers.dev . Deployment version 195c807c-0fe2-454e-b7f5-2369c33b5fb9. Live HTTPS GET /health returns service=oscar-personal-bot, version=2, configured=false. This is a deployed, deliberately unconfigured service: no bot/device/MAX secrets uploaded and no Telegram webhook switched. Pairing and secret setup in product remain necessary. Initial TLS provisioning settled on normal subsequent check; verification never disabled TLS.

Remaining: real owner bot/provider setup, installed build/runtime document acceptance, fuller terminal/network permissions and attachment sets, richer secretary summaries/rewrite/import, and complete phone/Desktop/offline-task demonstration. V2 remains under development; the new Worker is not a functioning connected bot yet.
