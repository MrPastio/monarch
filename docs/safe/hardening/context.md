# Monarch Safe Hardening Evidence Context

## Source identity

- Analysis ID: `hardening_20260711_monarch_safe`
- Working branch: `codex/monarch_safe`
- Base revision: `e4f7005754671207bce8b8d17b784929221a586e`
- Source drift: `present`. The Safe implementation and its evidence are current working-tree files not represented by the base revision, so the file hashes below—not the base commit alone—identify what was reviewed.
- Collection SHA-256: `d1d935816722d9217c777a5b9139f5184371e1fc66ffd1e197c9f7075e3946c7`
- Digest method: SHA-256 over newline-separated `repository-relative-path:file-sha256` entries in the order shown below.

## Inventoried artifacts

| Evidence | Reader-facing title | Path | SHA-256 |
| --- | --- | --- | --- |
| `SRC-01` | Desktop process and native capability owner | `desktop/electron/main.mjs` | `62259e68ec67c8e6a44279c7384b2dd7ec3c8b83a2fb5b6d3769d4651d5c0b75` |
| `SRC-02` | Dedicated Safe utility runtime and serialized request queue | `desktop/safe/runtime.mjs` | `68b66334f81f518f440115912748e0f66aab03bfc33c441cbdb4ad00998c99d8` |
| `SRC-03` | Encrypted vault, immutable generations, archive and commit logic | `desktop/safe/vault.mjs` | `60ebc875ef4d844a4e5d6befa80ba52e91852f276ac5ea7a7171c7241cbd021a` |
| `SRC-04` | Safe renderer, bounded editor and internal preview policy | `desktop/safe/safe.js` | `3579dcbccf918489204c344067ae6cf3894c4975c89dedf40e36571276ba5b2c` |
| `SRC-05` | Minimal Safe preload bridge | `desktop/safe/preload.cjs` | `e07c027b849950858d766ebf8a9466e123c63146cc17e8e88c7f3803223b25a3` |
| `SRC-06` | Safe window resource allowlist | `desktop/electron/safe-window-policy.mjs` | `8753b3e2acff68623e0f4d67f1ee6ce5f747ee9ef2e33b6b71944d0169283ce6` |
| `TEST-01` | Vault security and commit regression suite | `tests/desktop/safe-vault.test.ts` | `1b87df40f2e3cf0991d98cfb47b015c80d091616e5bbf7c6e6e56f470d28bd81` |
| `TEST-02` | Destructive capability token suite | `tests/desktop/safe-capability-token.test.ts` | `2af0af54d76509f42636e8161240f7a034d0a5af7d83dd7b114df0a27d12792f` |
| `QA-01` | Real Electron Safe QA report | `output/safe-qa/qa-report.json` | `ad407da8e55d439e5dcf92ac7c33883c0f0d83e49f0c1808aeb440596b20e808` |

## Supplemental experiment

`EXP-01` — Electron utility permission-model availability. During this pass, a temporary local probe observed Electron 42's utility process running Node 24.17.0 without `process.permission`. The temporary probe was reverted and is not part of the hashed collection. We therefore use this only as a design constraint with low-to-medium confidence; it must be rerun and retained before implementation review.

## Evidence limits

- This is a source-and-QA-backed architectural review, not a sealed Codex Security scan.
- `QA-01` demonstrates application controls inside the tested Electron session. It does not establish a Windows restricted token, AppContainer, kernel boundary, or resistance to an already privileged same-user process.
- No measured large-file latency, peak-RSS, decoder-containment, Windows-version compatibility, or packaging data was supplied.
- The recovery one-attempt lifetime policy remains a product decision and is kept outside the two proposals below.
