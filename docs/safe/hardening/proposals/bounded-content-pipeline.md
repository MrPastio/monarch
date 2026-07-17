# Security Hardening Proposal: Bound Plaintext Content And Decoder Authority

## Decision

Monarch Safe needs a content pipeline that can inspect and display useful parts of a file without making the complete plaintext file the default unit of transfer, allocation, and decoding. The design review has two choices:

- Option 1 retains the current strict size caps and whole-buffer pipeline as the bounded baseline.
- Option 2 introduces chunked authenticated storage, range-based IPC with backpressure, content sniffing, and a read-only decoder worker or process. This is the recommended direction for the product's maximum-isolation goal.

This proposal does not select or implement either option. In particular, arbitrary third-party formats are not supported by the current product, and this review does not claim universal format support.

## Executive Recommendation

**Option 1: Retain strict caps and the whole-buffer baseline** preserves the current implementation and its low migration cost. Its caps, bounded editor modes, structural PDF summary, and denied browser capabilities are useful tactical controls. It remains an appropriate fallback while a stronger pipeline is being designed, but it does not change the fact that a file is decrypted and transferred as one plaintext value or that image and media bytes are decoded inside the Safe renderer.

**Option 2: Stream authenticated ranges into read-only decoder workers** changes the ownership boundary. The vault runtime would store independently authenticated chunks, expose a cancellable range protocol with backpressure, classify bytes from a bounded header sample, and grant a decoder only a short-lived read capability for one immutable file generation. The decoder would have no mutation bridge and would return bounded display products rather than handing the renderer the entire source file.

I recommend Option 2 under Monarch Safe's stated isolation priority, while retaining Option 1 as the rollout and rollback floor. The recommendation is source-derived rather than benchmark-derived: the current source establishes whole-buffer flow and synchronous archive work, but no representative latency or memory budget has yet been measured. We should not select implementation work until those budgets, the first supported decoder set, and the compatibility policy for existing blobs and Safe archives are agreed.

## Evidence

I inspected the current vault, renderer, focused tests, and QA report in the working tree. The two source files most influenced the diagnosis: they show that the product already has meaningful caps and authenticated immutable generations, but plaintext allocation and decoder authority are still coupled to the complete file.

| Evidence | Finding or document | What it establishes |
| --- | --- | --- |
| `SRC-03` | Vault content and archive path (`desktop/safe/vault.mjs`) | **Observed:** `MAX_FILE_BYTES` limits a single file to 256 MiB; reads and writes operate on complete buffers; archive creation and extraction use synchronous `gzipSync` and `gunzipSync`; updates publish a new encrypted blob generation before retiring the previous generation. |
| `SRC-04` | Safe renderer preview path (`desktop/safe/safe.js`) | **Observed:** `readFile` returns the complete plaintext file to the renderer; editable text is limited to 4 MiB and editable HEX to 64 KiB; image and media previews use Chromium object-URL decoders; PDF handling is a bounded structural summary rather than page rendering. |
| `QA-01` | Safe desktop QA report (`output/safe-qa/qa-report.json`) | **Observed:** the QA pass exercises image, audio, video, PDF-summary, and HEX previews, while reporting network, popup, clipboard, unauthorised write, and unauthorised delete controls as denied. It does not measure streaming because the current path is not streaming. |
| `TEST-01` | Focused Safe tests (`tests/desktop/safe-vault.test.ts` and related Safe tests) | **Observed:** focused coverage exercises ciphertext integrity, generation commit recovery, archive bounds, capability authorization, and auto-lock interaction. **Inferred limitation:** those tests cannot establish backpressure, bounded range reads, or decoder-process containment because those mechanisms do not exist yet. |

From these observations, we can infer a structural condition rather than a single defective line: the authenticated storage boundary is stronger than the plaintext consumption boundary. Encryption and immutable generations protect persisted bytes, but once a file is opened, the complete plaintext becomes the unit passed across the runtime/renderer boundary. The 256 MiB cap makes that finite; it does not make the working set small, prevent duplicate buffers, isolate a decoder failure, or keep synchronous archive work from occupying the runtime event loop.

## Current Design And Failure Mode

Imported bytes enter through the Safe renderer and are sent to the runtime as one value. The runtime encrypts them into an immutable blob generation and binds that generation to authenticated manifest metadata. On open, the runtime authenticates and decrypts the complete blob, then returns the complete plaintext to the renderer. The renderer applies useful secondary limits: it only exposes bounded text and HEX editing, samples at most 1 MiB for the structural PDF summary, and sends image or media bytes to Chromium decoders through an object URL.

That arrangement is understandable for an initial isolated vault. It keeps the implementation compact, avoids an incremental protocol, and lets authenticated generation replacement provide clear commit semantics. The failure mode appears when file size and parser complexity increase. Several complete representations may coexist during read, IPC conversion, object-URL construction, decode, archive concatenation, or recompression. A malformed but authenticated file is still untrusted content after decryption, and its decoder executes in the same renderer that owns the visible Safe workspace. Synchronous archive compression and decompression also make cancellation and auto-lock responsiveness depend on completion of a potentially expensive operation.

We should be precise about the current protection. The limits prevent an unbounded single-file operation and the browser policy removes important ambient capabilities. QA-01 confirms those controls in the exercised UI flow. The design concern is narrower: the complete plaintext and the decoder are not separately bounded capabilities, so resource containment and parser failure containment depend on convention and global file-size caps.

## Desired Invariants

The selected design should make the following behavior testable:

- Opening a large file does not require the Safe renderer to receive or retain the complete plaintext file.
- Every plaintext queue has an explicit byte limit, supports cancellation, and applies backpressure before accepting another chunk.
- Every stored content chunk is independently authenticated, and no manifest points to a generation until all required chunks and metadata are durable.
- A read capability identifies exactly one vault, file, immutable generation, allowed operation, and expiry; it cannot authorize write, delete, recovery, clipboard, network, or arbitrary filesystem access.
- Decoder selection uses a bounded signature sample and a declared-format comparison; a filename extension or caller-provided MIME type alone never selects a privileged decoder.
- A decoder receives only bounded ranges for one file and returns bounded display products or metadata. It never receives the mutation bridge.
- Decoder cancellation or failure releases its ranges and does not mutate the manifest, extend the unlock lifetime, or expose a partially decoded artifact as trusted output.
- Archive validation enforces entry count, per-entry size, aggregate output, descriptor size, and exact input consumption before publishing extracted files.
- Unsupported formats remain inside Safe and fall back to bounded metadata or HEX inspection; the system never delegates them to a Windows or other external viewer.
- Existing network, popup, clipboard, write, and delete authorization controls remain mandatory regardless of the selected content option.

## Constraints And Non-Goals

The pipeline must remain local-first and preserve the rule that Safe content is not handed to an external operating-system viewer, archiver, or shell. It must coexist with auto-lock, authenticated manifests, per-file keys, immutable generations, resource-request denial, and capability-guarded mutations. Migration must not make an existing encrypted generation unreadable merely because the new viewer is disabled or rolled back.

No measured memory, preview-latency, archive-throughput, or process-start budget was supplied. We therefore use a balanced engineering profile inside a security-first product constraint and label performance expectations as proposed validation thresholds, not measurements.

Universal rendering is a non-goal for this decision. Arbitrary third-party formats are not yet supported; the current useful set is text, bounded HEX, browser-supported image and media types, a structural PDF summary, and Monarch Safe's internal archive. Option 2 should expand formats only through an explicit allowlist and a reviewed decoder adapter. Mounting the vault as a system filesystem or invoking installed applications is also out of scope because it would contradict the isolation boundary.

Finally, this is a design artifact. No implementation option has been selected, and no implementation plan or source change is authorized by this proposal alone.

## Before Architecture

The current diagram keeps the renderer, runtime, and encrypted-storage boundaries distinct. The security-relevant edge is the return path from `Vault content API` to `Safe renderer`: it carries one complete plaintext value, after which renderer-owned routing chooses a bounded editor, structural PDF summary, or Chromium decoder. The runtime archive codec is also a synchronous whole-buffer path.

[Current architecture Mermaid source](../diagrams/bounded-content-pipeline-before.mmd)

The encrypted-storage boundary is authenticated and generation-oriented, which is worth preserving. The opportunity is to avoid treating that strong storage primitive as a reason to expose complete plaintext to every content consumer.

## Options

### Option 1: Retain Strict Caps And The Whole-Buffer Baseline

Option 1 keeps the existing data path. `MAX_FILE_BYTES` remains the primary per-operation ceiling; archive count and output limits remain enforced; the renderer continues to cap editable text, editable HEX, and PDF inspection; and browser-level resource, network, popup, clipboard, and mutation controls remain in place. We would make those limits explicit as the supported operating envelope and add resource measurements around them, but we would not introduce a new blob format, range protocol, or decoder boundary.

The strongest case for this option is reliability through simplicity. There is one authenticated blob per generation, one read response, and no chunk index or retry state. Small files avoid extra IPC round trips, and rollback is simply a source rollback because no data migration occurs. It is also the only option whose behavior is substantially represented by the current QA and focused tests.

Its security effect is containment, not isolation. The cap limits the maximum size of an individual request, but it does not constrain transient copies to one cap-sized allocation. A file can still be present in the runtime, transport representation, renderer, object URL, and decoder at overlapping times. The image and media parser surface remains in the renderer process, and synchronous archive work still has no natural backpressure or cancellation point. Tightening the global cap would reduce worst-case resource use, but it would also reduce compatibility without changing those ownership properties.

Operationally, this option asks us to publish an honest format and size matrix, record peak working set and event-loop delay, and reject files before expensive preview work wherever possible. We can roll it out immediately because it is the present baseline. We can also retain it as the safe fallback for Option 2, provided fallback never silently expands decoder authority.

**Diagram pair:** [before](../diagrams/bounded-content-pipeline-before.mmd) → [Option 1 after](../diagrams/bounded-content-pipeline-bounded-current-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Operating envelope | Caps exist in source and UI behavior | Caps become an explicit compatibility contract with resource telemetry | Finite worst-case inputs remain enforceable and observable | Documentation, metrics, and rejection UX |
| Plaintext transfer | Complete file returned to renderer | Complete file still returned to renderer | No reduction in plaintext authority or copy count | No protocol migration |
| Decoder boundary | Chromium image/media decoding in renderer | Same renderer decoder boundary with an explicit allowlist | Existing network and mutation denials remain useful; parser failure is not process-contained | Low implementation cost; residual decoder risk |
| Archive execution | Synchronous whole-buffer gzip/gunzip | Same bounded synchronous codec | Existing exact-consumption and size checks remain; cancellation and responsiveness do not improve | No archive-format migration |

The after view intentionally has the same topology. That is not diagram theatre: it makes clear that Option 1 formalizes and measures existing controls without claiming a new isolation boundary.

### Option 2: Stream Authenticated Ranges Into Read-Only Decoder Workers

Option 2 changes the unit of storage and authority. A new encrypted blob generation would contain independently authenticated chunks plus authenticated chunk metadata. Each chunk would use a unique nonce and bind the vault, file, blob generation, chunk index, declared plaintext length, and format version as associated data. The manifest would refer to the generation only after every required chunk and its index are durable, preserving the current immutable-generation commit model rather than replacing it with in-place mutation.

Import would become a sequence-controlled stream. The producer may have only a small number of chunks in flight; the runtime acknowledges durable progress and stops accepting data when its queue budget is reached. Read IPC would expose ranges or logical pages instead of `readFile` returning the complete file. Cancellation, auto-lock, renderer closure, and decoder exit would revoke the read handle and clear queued plaintext. This makes memory proportional to agreed chunk and decoder-frame budgets rather than to file size, provided every adapter honors the same boundary.

Before choosing a decoder, the runtime or a minimal classifier would inspect a bounded header sample and compare the result with declared MIME and extension metadata. A mismatch would produce a warning or bounded binary fallback, not a more privileged parser choice. The chosen decoder would receive a short-lived, read-only capability for one immutable generation. The production target should be a process-isolated worker with no mutation bridge, network route, clipboard API, or arbitrary file path. A same-process Web Worker could be an incremental scheduling step, but it would not satisfy the same crash- or memory-isolation claim and should not be described as equivalent.

The decoder asks for bounded ranges and returns a bounded product: sanitized text spans, metadata, a raster tile, an audio frame queue, or another format-specific view object. The renderer becomes a display and interaction surface rather than the owner of all raw source bytes. For internal archives, the same principle implies a streaming codec and transactional extraction. Because ordinary gzip is not random-access, a future Safe archive writer may need independently compressed entries or frames; the old bounded archive reader would remain for compatibility until existing archives are migrated or aged out.

The security improvement comes from removing ambient plaintext and mutation authority from parser components. A malformed file can still exercise decoder code, and plaintext still exists inside the runtime and worker while needed. The smaller capability limits what a compromised or failed decoder can request and prevents it from turning a parser failure into a vault mutation. A dedicated process also contains crashes and allocator growth more effectively than renderer-only routing. This does not defend against an actor already able to inspect every same-user process or the operating-system kernel, and it does not make an unreviewed third-party decoder safe by declaration.

The cost is real. Range reads add IPC, sequencing, authentication, and possible read amplification when a format seeks frequently. Chunk metadata consumes storage, and small files may become slower if the protocol cannot coalesce. Worker startup and decoded frame queues add a bounded fixed working set. Reliability improves when a decoder crash is isolated, but the protocol introduces cancellation races, retry behavior, partial-ingest cleanup, and version compatibility that must be tested. Operability also grows: we need per-format crash telemetry without filenames or content, queue-depth and timeout metrics, and a clear fallback when a decoder is unavailable.

We can introduce the option without a flag-day migration. First add protocol negotiation and a dual reader while continuing to write the current blob format. Then validate chunked ingestion and storage behind a development flag, enable read-only text/binary range consumers, and move one decoder family at a time. The existing bounded path remains the fallback only for formats and file sizes explicitly allowed by policy. New chunked writes should not become the default until the previous release can be kept available with a compatible reader; rollback should disable the new consumer path, not require decrypting and rewriting user data.

**Diagram pair:** [before](../diagrams/bounded-content-pipeline-before.mmd) → [Option 2 after](../diagrams/bounded-content-pipeline-streaming-workers-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Storage unit | One authenticated ciphertext body per file generation | Independently authenticated chunks inside one immutable generation | Corruption is detected per requested range; complete plaintext is not required for partial use | New blob version, chunk index, nonce discipline, dual reader |
| IPC authority | `readFile` returns complete plaintext | Expiring read-only generation handle plus bounded range requests and backpressure | Renderer and decoder no longer receive ambient whole-file authority | More messages, cancellation state, request coalescing |
| Format selection | Declared MIME routes renderer preview | Bounded signature sniff plus MIME/extension comparison and allowlist | Reduces decoder confusion and gives unsupported content a safe fallback | Classifier maintenance and compatibility warnings |
| Decoder boundary | Chromium image/media decoder shares renderer process | Read-only decoder worker/process returns bounded display products and has no mutation bridge | Parser failure has a smaller authority and, with a process, a crash boundary | Worker lifecycle, sandbox verification, decoded-frame protocol |
| Archive execution | Whole-buffer synchronous gzip/gunzip | Streaming framed or per-entry codec with transactional publication | Bounded memory and cancellation become enforceable; partial extraction stays unpublished | New archive version and legacy reader lifetime |

The important delta is not merely “streaming.” It is that storage ranges, decoder reads, and display outputs become separate bounded capabilities. If we stream bytes into a worker that still owns the mutation bridge or allows an unbounded queue, we have moved complexity without obtaining the intended isolation.

## Comparison

The table records direction and evidentiary basis rather than a composite score. Option 1 assessments are mostly source-derived because they describe the current topology. Option 2 resource and latency effects remain hypothetical until a prototype is benchmarked.

| Dimension | Option 1: bounded whole-buffer baseline | Option 2: authenticated ranges and read-only workers | Basis and validation focus |
| --- | --- | --- | --- |
| Security | **Improves modestly / high confidence** when caps and allowlists are treated as enforced policy, but whole-file plaintext and renderer parser authority remain | **Improves materially / medium confidence** by narrowing plaintext, format, and mutation authority; decoder and same-user process risk remain | Source-derived boundary analysis; validate capability scope, range authentication, denied bridges, and malformed-format containment |
| Performance | **Neutral / medium confidence** for current small files; whole-buffer reads avoid IPC chatter, while sync archive work can stall responsiveness | **Unknown / low confidence**; first useful preview can improve for large files, but ranges, seeks, worker startup, and authentication add overhead | Benchmark identical small, medium, and cap-sized workloads; record p50/p95 first-preview time, throughput, and event-loop delay |
| Memory | **Neutral / high confidence** relative to current code; peak use can scale with file size and overlapping copies | **Improves / medium confidence** if queue and frame budgets are enforced; fixed worker overhead and chunk metadata are added | Measure peak RSS by process and maximum in-flight plaintext; fail acceptance if working set grows with full file size for partial preview |
| Reliability | **Neutral / medium confidence**; fewer moving parts, but renderer decoder failure and synchronous runtime work share critical components | **Improves with tradeoffs / medium confidence**; worker crashes are containable and operations cancellable, while protocol races and retries are new failure modes | Kill workers, cancel ranges, trigger auto-lock mid-read, and inject partial storage writes; verify no manifest mutation or leaked handles |
| Operability | **Neutral / high confidence**; current QA remains applicable, with limited content-pipeline diagnostics | **Regresses initially / high confidence** because worker health, queue pressure, decoder versions, and fallback reasons need privacy-safe telemetry | Define metrics without content or filenames; rehearse decoder disablement and fallback diagnosis |
| Migration | **Neutral / high confidence**; no data or protocol migration | **Regresses initially / high confidence**; requires dual blob/archive readers, protocol negotiation, and staged format enablement | Test old/new reader matrix and rollback before changing the default writer |
| Developer ergonomics | **Simple / high confidence**, but future viewers can bypass conventions because the whole buffer is readily available | **Improves after investment / medium confidence** if one typed range and decoder-adapter API owns the control; initial learning cost is higher | Review whether a new decoder can be added without receiving raw IPC or mutation APIs |
| Reversibility | **High / high confidence** because there is no schema change | **Medium / medium confidence**; consumer rollback is straightforward, writer rollback requires retained compatibility readers | Keep new writing disabled until the previous supported release can read or safely preserve new generations |

Option 1 wins if near-term delivery risk and compatibility dominate, or if measurements show all supported files are small enough that the isolation gain does not justify a new process and data format. Option 2 wins when maximum isolation is a product requirement, larger media must be handled responsively, or new parser families would otherwise expand the renderer's authority. The current brief points to the latter, but measurement and format scope still decide how aggressively we stage it.

## Recommendation

I recommend selecting Option 2 as the target architecture after a bounded prototype, with Option 1 retained as an explicit and tested compatibility floor. SRC-03 shows that immutable generations already provide the right publication model; we can extend that model to chunks instead of replacing it. SRC-04 shows where the largest boundary gain lies: stop returning complete plaintext to the renderer and stop treating the renderer's decoder surface as the default home for new formats.

I would be comfortable approving implementation only after the prototype proves three things: partial preview memory stays bounded independently of file size, decoder loss cannot mutate or unlock the vault, and a release rollback can still read every generation written during the trial. If process isolation cannot be enforced in the packaged Electron runtime, or if the first format requires effectively complete random reads, we should narrow the initial decoder set rather than quietly weakening the capability contract.

Option 1 remains preferable for a short stabilization release or if the supported-format matrix stays limited to small text and metadata inspection. It should not be described as the final maximum-isolation content architecture.

## Evidence Coverage And Residual Risk

| Evidence | Option 1 effect | Option 2 effect | Tactical protection still required |
| --- | --- | --- | --- |
| `SRC-03` — Vault whole-buffer and synchronous archive path | **Mitigates:** strict caps and immutable commits bound and authenticate current operations, but complete buffers and synchronous codecs remain | **Addresses structurally:** chunked AEAD, range IPC, and streaming archives remove complete-file processing as the default; actual implementation must be verified | Keep current file, descriptor, entry, aggregate-output, exact-consumption, and generation-integrity checks throughout migration |
| `SRC-04` — Renderer full-read and preview path | **Mitigates:** bounded text/HEX/PDF views and browser denials reduce exposure, while image/media decoders still receive complete bytes | **Addresses structurally:** renderer receives bounded display products and decoder gets only scoped ranges with no mutation bridge | Preserve safe fallback, object-URL cleanup until retired, capability denial, and unsupported-format handling |
| `QA-01` — Desktop preview and denied-capability QA | **Unaffected:** current evidence remains valid but does not cover resource scaling | **Mitigates:** the same QA controls remain necessary and become regression gates; it cannot prove the new boundary without added probes | Continue network, popup, clipboard, write, delete, cleanup, and auto-lock QA in both legacy and new paths |
| `TEST-01` — Focused integrity, commit, and lock tests | **Unaffected:** current tests cover the existing generation model, not streaming | **Unknown until implemented:** test architecture can be extended, but no current result proves range or worker behavior | Preserve existing integrity and commit tests; add chunk corruption, backpressure, cancellation, worker-loss, and compatibility matrices |

Neither option makes arbitrary third-party formats supported. Option 1 remains limited to the current browser and bounded-inspection set. Option 2 creates a safer extension mechanism, but each decoder still becomes trusted for the bounded display product it emits and requires independent review, update policy, and malformed-input coverage.

Residual risks also remain outside this proposal: plaintext can be inspected by sufficiently privileged same-user or operating-system actors while in use; decoded frames remain sensitive; resource exhaustion is still possible within configured budgets; a logic flaw in the runtime capability verifier could defeat the intended scope; and best-effort memory clearing cannot guarantee physical erasure of every allocator or device copy.

## Migration And Rollout

No rollout begins until an option is explicitly selected. If Option 1 is selected, the rollout is limited to documenting the supported envelope, adding resource telemetry and benchmarks, and keeping the current focused QA as release gates. Rollback is a normal source rollback with no on-disk transformation.

If Option 2 is selected, we should stage it by compatibility boundary rather than by a large UI switch:

| Stage | Scope | Entry gate | Rollback posture |
| --- | --- | --- | --- |
| Protocol shadow | Define versioned ingest/range messages and collect development-only timing without changing storage | Schema tests, cancellation tests, no plaintext logging | Disable shadow calls |
| Dual reader | Add chunked-generation reader behind a development flag; continue writing the legacy format | Golden vectors, per-chunk tamper tests, interrupted-generation recovery | Disable new reader; no user data written in new format |
| Chunked writer trial | Write new generations only in disposable QA vaults | Durability matrix, old/new release compatibility decision, peak-memory gate | Delete QA vaults or retain compatible reader; do not downgrade ciphertext in place |
| First decoder | Move one allowlisted format to a read-only isolated worker/process | Capability denial, malformed corpus, worker-kill, auto-lock, range-budget gates | Disable adapter and use bounded legacy fallback where policy permits |
| Streaming archive | Introduce a versioned framed/per-entry archive while retaining bounded legacy reads | Exact-consumption, entry/aggregate caps, transaction rollback, compatibility fixtures | Stop new archive writes; retain both readers |
| Default enablement | Enable only validated formats and file classes | Release soak with privacy-safe crash and queue metrics | Per-format kill switch; keep encrypted data readable |

The tactical controls evidenced by QA-01 and TEST-01 stay active in every stage. A partial migration must never route an unsupported or failed new decoder to an external application.

## Validation Plan

The current evidence contains functional results, not streaming measurements. The following gates are proposed and should be calibrated on supported hardware before becoming release criteria.

| Validation | Workload and method | Metric | Proposed decision threshold |
| --- | --- | --- | --- |
| Partial-preview memory | Open 4 MiB, 64 MiB, and 256 MiB synthetic image/media/binary fixtures; request only the first useful view | Peak RSS by renderer, runtime, and worker; maximum queued plaintext | For Option 2, incremental plaintext working set must remain within two configured chunks plus one bounded decoder output; it must not scale to the complete file for partial preview |
| Small-file latency | Repeat open/preview for representative files at or below 4 MiB | p50/p95 time to first useful preview | Provisional gate: Option 2 p95 no more than 15% slower than Option 1 on the agreed reference machine |
| Large-file responsiveness | Preview and cancel cap-sized content; create/extract the largest supported Safe archive | Longest renderer/runtime event-loop delay and cancellation latency | Provisional gate: no task over 100 ms on the UI event loop; cancellation releases range handles within 1 second |
| Backpressure | Slow the consumer while producing ranges at maximum rate | In-flight chunk count, bytes retained, rejected/paused writes | Queue never exceeds its configured byte and chunk limits; producer pauses before another plaintext allocation is accepted |
| Integrity | Corrupt, reorder, duplicate, omit, and replay encrypted chunks and range responses | Authentication outcome and visible output | Every altered sequence fails closed before a display product is marked complete; no manifest change |
| Worker containment | Terminate or hang decoder during sniff, range read, and output production | Runtime availability, vault state, handles, mutation attempts | Vault remains unlocked only according to normal timer policy, manifest is unchanged, handles are revoked, mutation/network/clipboard requests stay denied |
| Auto-lock interaction | Trigger auto-lock during import, preview, archive extraction, and decoder restart | Plaintext queues, worker lifetime, visible state | New reads stop, queued plaintext is cleared best-effort, worker capability is revoked, UI returns to locked state |
| Compatibility | Exercise legacy and chunked blobs/archives across the supported release matrix | Read success, writer policy, rollback result | Every committed generation remains readable by the documented rollback release or the new writer remains disabled |
| Format classification | Feed MIME/extension/signature matches and mismatches plus a malformed corpus | Decoder selected, fallback reason, external navigation | Only allowlisted signature outcomes reach a decoder; mismatches use a bounded internal fallback; no external handler opens |

Acceptance also requires the existing focused tests and desktop QA to pass unchanged where their contract remains relevant. New tests must cover range authorization, expiry and replay, chunk AAD fields, nonce uniqueness, partial-generation cleanup, decompression limits, worker crash loops, and privacy-safe telemetry.

## Implementation Work Packages

These are design-sized packages for estimation, not an implementation plan and not authorization to begin work. No option has been selected.

| Work package | Scope | Review output |
| --- | --- | --- |
| `WP-A` | Define plaintext budgets, format matrix, versioned ingest/range protocol, cancellation, and backpressure state machine | Protocol specification with invalid transitions and resource limits |
| `WP-B` | Design chunked AEAD generation format, nonce derivation/allocation, authenticated index, atomic publication, and dual reader | Format specification, golden vectors, recovery model |
| `WP-C` | Build a prototype range broker and one bounded text/binary consumer | Memory and latency benchmark report against Option 1 |
| `WP-D` | Define and prove the decoder worker/process boundary, read capability, denied bridges, output schema, and lifecycle | Boundary test report and packaged-runtime verification |
| `WP-E` | Design sniffing policy and the first allowlisted image or media adapter | Format threat review, malformed corpus, fallback contract |
| `WP-F` | Design streaming/framed Safe archive vNext and transactional extraction | Compatibility fixtures, exact-consumption and rollback tests |
| `WP-G` | Add privacy-safe metrics, per-format kill switches, staged enablement, and rollback support | Operational runbook and release gates |

If Option 1 is selected instead, only the resource-budget, telemetry, benchmark, and compatibility-documentation portions of `WP-A`, `WP-C`, and `WP-G` apply.

## Open Questions

- What are the target per-process plaintext, decoded-frame, and IPC queue budgets on the lowest supported Windows hardware?
- Which exact formats form the first supported matrix, and which decoder implementations can run without filesystem, network, clipboard, or mutation authority?
- Must the first isolated decoder be a dedicated process, or is a same-process worker acceptable only as a temporary scheduling prototype? What packaged-runtime evidence will prove the boundary?
- What chunk size and authenticated-index layout best balance sequential media, image seeks, small text files, and metadata overhead?
- Should chunk compression occur independently per frame, per archive entry, or not at all for already compressed media?
- How long must legacy blob and `.msa` archive readers remain supported, and which prior release must be able to read trial writes for rollback?
- What should happen to an incomplete imported generation after crash, power loss, or auto-lock: immediate cleanup, authenticated resume, or quarantine until the next unlock?
- Which decoded products may be cached, for how long, and must thumbnail caches be encrypted as separate file generations?
- What latency regression is acceptable for files below 4 MiB, and which reference hardware defines the release threshold?
- Who explicitly selects Option 1 or Option 2 after the prototype evidence is available? Until that decision, no implementation is selected.
