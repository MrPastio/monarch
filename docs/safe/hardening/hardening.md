# Security Hardening Review: Monarch Safe

## Evidence Basis

We reviewed the current working-tree storage/runtime implementation, the narrow preload and window policy, focused regression coverage, and the latest real Electron QA. The evidence is bound by the file-level digest in [context.md](context.md). Because the Safe files are not represented by the base commit, source drift is explicitly `present`.

## Constraints

The target remains local-first, offline, Windows-focused, and unwilling to hand vault content to the shared Monarch kernel or external programs. No measured performance budget was supplied. We therefore use the user's maximum-isolation priority while preserving a usable desktop workflow and honest recovery behavior.

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| Remove ambient OS authority from the key-owning runtime | Dedicated but same-user Electron utility (`SRC-01`, `SRC-02`), session QA (`QA-01`), permission-model probe (`EXP-01`) | 1. Dedicated utility + local controls; 2. Windows AppContainer/restricted helper | Option 2 when Windows packaging and IPC compatibility are accepted | [Runtime privilege boundary](proposals/runtime-privilege-boundary.md) |
| Bound plaintext lifetime and decoder authority | Whole-buffer storage/archive path (`SRC-03`), renderer decoder path (`SRC-04`), current QA/tests (`QA-01`, `TEST-01`) | 1. Keep strict caps; 2. Chunked AEAD + range IPC + decoder workers | Option 2, introduced format-by-format behind compatibility gates | [Bounded content pipeline](proposals/bounded-content-pipeline.md) |

## Recommendation Summary

The current controls are useful and tested, but they remain application-level controls inside one Windows user context. I recommend that we treat a restricted Windows helper as the destination for the key-owning runtime and pair it with a chunked, backpressured content pipeline whose decoders never receive mutation authority. The first change narrows OS authority; the second bounds plaintext and contains parser failures. Neither proposal is claimed as implemented by this review.

The order should be evidence-driven: first prototype the versioned helper IPC and Windows packaging boundary, while independently benchmarking chunk sizes and range playback. If AppContainer compatibility blocks the Electron shell, a restricted-token native helper is still preferable to calling the existing utility process an OS sandbox.

## Next Decisions

- Confirm whether Windows AppContainer/MSIX packaging is acceptable or whether a restricted-token helper must work from the current unpackaged desktop build.
- Set peak-RSS, unlock latency, range-read latency, and lock-latency acceptance thresholds for 1 MiB, 64 MiB, and 256 MiB files.
- Choose the recovery failure policy separately: one attempt per runtime, per launch, or one lifetime attempt with terminal destruction.
- Decide which additional formats merit a bundled offline parser after the streaming boundary exists; do not equate arbitrary storage with safe arbitrary rendering.
