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
- `showcase/monarch-video/` source and media (excluding its local build/dependencies)
- `security/src/`, `security/tests/`, `security/config/`, `security/scripts/`
- `oscar/backend/`, `oscar/frontend/src/`, `oscar/frontend/*.json`, `oscar/frontend/*.html`
- root project files such as `package.json`, `package-lock.json`, `tsconfig.json`, `README.md`, `.gitignore`

## Local-Only Runtime Data

Never upload these as normal source:

- `LLM models/`
- `node_modules/`
- Python virtualenvs: `security/.venv/`, `oscar/.venv/`
- generated/runtime state: `runtime/`, `logs/`, `data/local/`, `secrets/`, `artifacts/generated/`
- local QA and automation output: `output/`, `tmp/`, `test_files/`, `.playwright-cli/`, `.oscar-trash/`, `Workspace Coder/`
- agent run workspaces under `.agents/*/` except the durable orchestrator/sentinel records already tracked by the repository
- nested scratch repositories: `monarch/`, `monarch-1/`, `marketing-site/`
- Oscar runtime artifacts: `oscar/model/`, `oscar/model-small/`, `oscar/data/`, `oscar/backend/data/`, `oscar/runtime/`, `oscar/Oscar.exe.WebView2/`
- WebView2 package/cache and binary payloads: `oscar/desktop/webview2_pkg/`, `*.exe`, `*.dll`, `*.zip`
- security runtime state and keys: `security/data/`, `security/logs/`, `security/*.gguf`

## Model Handling

Models must be handled as local install artifacts, not regular source files. Keep model names, expected paths, checksums and install commands in documentation or scripts. Do not commit `.gguf`, `.safetensors`, `.bin`, local Hugging Face snapshots, or offload caches.

## Upload Gate

Before GitHub or cloud upload, run:

```powershell
npm run upload:dry-run
```

The dry-run must show no included source violations. Blocked local files may exist in the workspace; they are expected while developing locally.
