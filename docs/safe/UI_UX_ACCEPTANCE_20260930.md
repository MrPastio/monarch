# Safe UI/UX acceptance — 2026-09-30 Codex

## Summary

The isolated Safe source now has a task-oriented workspace, a full-width list until a file opens, explicit editor return, visible named navigation at narrow widths, contextual selection actions and accurate folder search. This is not an installed-product acceptance.

## Environment

- Worktree: separate Codex worktree `safe-pp-rebuild`.
- Branch: `codex/safe-pp-rebuild`; foundation `c821105`; UX `832392ebe0126b7e6bebd51f378203d519e99806`; final compact-width CSS `f4b3ed989a3f1f4dc2e36bd27cb6b05ebe6858f1`.
- Node 24.19.0; real repository Electron; disposable vault/profile and TEMP on D:.
- Browser plugin not available: existing Edge with repository Playwright, desktop 1440×900, compact 1040×700 and narrow 390×844.
- Browser fixture runs the actual Safe HTML, CSS and module against a synthetic in-memory bridge. No production Safe paths, credentials, keys or data were read.

## Changes verified

| Check | Result |
| --- | --- |
| Named sections, section creation/customization and keyboard-operable file controls | PASS |
| Folder creation stays visible at compact desktop width 1040×700 | PASS |
| Full-width list; close editor returns to list | PASS |
| Unsaved draft survives canceled close; opening same file preserves it | PASS |
| Selection count includes files hidden by a filter; explicit clear selection | PASS |
| Search filters folders and files; filters reset | PASS |
| Image preview opens by default; mobile return control | PASS |
| Delayed read cannot repopulate plaintext after lock | PASS, synthetic delayed bridge |
| Native create/import/drop/save and image/media/PDF/HEX preview | PASS |
| Native security settings, capability scope/replay rejection and auto-lock cleanup | PASS |
| Browser title/content, no page errors or console errors, no page horizontal overflow | PASS |
| Node syntax and diff whitespace | PASS |
| Installed product / native export destination dialog | NOT RUN |

## Interaction loop

Unlock → list five demo files → select a file → filter it out and observe disclosed hidden selection → clear selection/reset filter → edit a file → cancel close and keep draft → reopen same file and keep draft → confirm close → search a section containing a folder → switch to narrow viewport → open image preview → return → force lock during a delayed read and observe cleared editor.

The native QA additionally creates a fresh encrypted vault, exercises actual runtime mutations and authorizations, then verifies auto-lock removes plaintext, metadata and credentials. Expected CSP errors in native QA come from its deliberate forbidden-network probe.

## Evidence and commands

Artifact root: `D:\MonarchArtifacts\safe-ux-20260930`.

- `ui-report.json`: six browser scenarios, empty error list.
- `native-final\safe-qa\qa-report.json`: `ok: true`, native acceptance details.
- `desktop-list.png`, `desktop-editor.png`, `selection-filter.png`, `mobile-list.png`, `mobile-preview.png`: inspected screenshots.
- External harness: `preview.mjs --verify`, using bundled Node 24.
- Native command: Node 24 → `node_modules/electron/cli.js desktop/safe/qa.mjs`; `MONARCH_NODE_PATH` set to Node 24, `MONARCH_SAFE_QA_OUTPUT_ROOT` set to the D: artifact root, `TEMP`/`TMP` set to its `tmp` folder.
- `node --check desktop/safe/safe.js`, `node --check desktop/safe/qa.mjs`, `git diff --check`.

## Reviewable preview

Run the external `preview.mjs` without `--verify`. It binds `127.0.0.1:18767`, serves only an explicit list of Safe UI assets and never imports the real vault/runtime. Open `http://127.0.0.1:18767/desktop/safe/index.html?demo=1`. The demo automatically unlocks synthetic state; its PIN 1234 is fictional. Mutations remain in memory and reset on reload. The preview is excluded from the repository and product.

## Risks and next steps

- Source is committed on the isolated branch; main checkout and user installation are unchanged.
- Get owner feedback on the concrete preview, inspect integration dependencies against the newer shared branch, then do packaged/native acceptance with disposable state.
- PDF remains a safe structural summary, not a rendered document viewer.
- This UI pass does not close sealed snapshot rollback/recovery replay or same-user directory replacement risks documented by the prior security pass.
- Preserve Production Safe and unrelated shared changes. Never package the synthetic bridge or change the product CSP to enable browser QA.
