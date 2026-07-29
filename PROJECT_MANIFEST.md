# Monarch Project Manifest

This file defines the source boundary for GitHub and cloud uploads.

## Source Repository

Allowed in the normal source repo:

- `src/`
- `desktop/electron/`, `desktop/safe/`
- `tools/launcher/`
- other reviewed source tools in `tools/`
- `scripts/`
- `docs/`
- `assets/voice/`
- `security/src/`, `security/tests/`, `security/config/`, `security/scripts/`
- `oscar/backend/`, `oscar/frontend/src/`, `oscar/frontend/*.json`, `oscar/frontend/*.html`
- root project files such as `package.json`, `package-lock.json`, `tsconfig.json`, `README.md`, `.gitignore`

## Local-Only Runtime Data

Never upload these as normal source:

- `LLM models/`
- `node_modules/`
- Python virtualenvs: `security/.venv/`, `oscar/.venv/`
- generated/runtime state: `runtime/`, `logs/`, `data/local/`, `secrets/`, `artifacts/generated/`
- internal media-production workspace: `showcase/`
- local QA and automation output: `output/`, `tmp/`, `test_files/`, `.playwright-cli/`, `.oscar-trash/`, `Workspace Coder/`
- agent run workspaces under `.agents/*/` except the durable orchestrator/sentinel records already tracked by the repository
- nested scratch repositories: `monarch/`, `monarch-1/`, `marketing-site/`
- Oscar runtime artifacts: `oscar/model/`, `oscar/model-small/`, `oscar/data/`, `oscar/backend/data/`, `oscar/runtime/`, `oscar/Oscar.exe.WebView2/`
- WebView2 package/cache and binary payloads: `oscar/desktop/webview2_pkg/`, `*.exe`, `*.dll`, `*.zip`
- security runtime state and keys: `security/data/`, `security/logs/`, `security/*.gguf`

## Model Handling

Models must be handled as local install artifacts, not regular source files. Keep model names, expected paths, checksums and install commands in documentation or scripts. Do not commit `.gguf`, `.safetensors`, `.bin`, local Hugging Face snapshots, or offload caches.

## Upload Gate

Never upload the private working tree or reuse an older public directory. Build
from one exact committed revision into a **new, non-existent** destination:

```powershell
$revision = (git rev-parse HEAD).Trim()
$snapshot = Join-Path ([IO.Path]::GetPathRoot((Get-Location).Path)) "Monarch-public-<version>-$revision"
npm run export:public -- -Destination $snapshot -SourceRevision $revision
npm run upload:dry-run -- -Snapshot $snapshot -SourceRevision $revision
```

The exporter reads regular blobs from Git's object database, not from the
working tree. It refuses dirty boundary scripts, symlink/reparse entries,
hardlinks, alternate data streams, non-UTF-8/NUL text, changed reviewed
binaries, a destination that already exists, or a source revision that is not
`HEAD`/an exact full commit. It writes a manifest containing the full
`sourceRevision`, `policyDigest`, and every exported file's path, Git mode,
size, and SHA-256.

Operational nested zones (`docs/`, `scripts/`, `tools/`, workflows, installer,
release metadata and similar configuration roots) are structure-locked by
`scripts/public-source-structure.json`. A new path cannot silently inherit a
broad directory allowlist: it must be listed as a reviewed addition or the
zone's compact count/SHA-256 baseline must be deliberately updated.

The dry-run validates that exact snapshot against the pinned commit and rejects
missing files, extra files/directories, changed bytes, secrets, local paths, or
manifest drift. Only this verified fresh snapshot may be initialized as a new
public repository/history or supplied to installer/release tooling. Existing
snapshots stay untouched until the new snapshot and release are independently
verified.
