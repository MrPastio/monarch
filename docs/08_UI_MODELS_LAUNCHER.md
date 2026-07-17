# UI, Models, Launcher

## UI

Monarch UI is a local web surface over the real `MonarchKernel`.

Run it from the workspace:

```powershell
npm run ui
```

Default URL:

```text
http://127.0.0.1:4317
```

The UI currently shows:

- active modules and capabilities
- command routing, plan status, permission state, and execution result
- Security Center status, triage, integrity and audit tail
- local model catalog from `LLM models`
- model runner readiness
- router pipeline status
- integrated Oscar chat/status through the Monarch module bridge
- integrated Monarch Security status, scans, integrity and audit tail

## Launcher

Build the Windows launcher:

```powershell
npm run build:launcher
```

Output:

```text
Monarch.exe
```

The launcher starts `src/ui/server.ts` through local `node_modules/tsx`, opens the browser, and keeps a small control window with Open, Restart, and Stop actions.

## Model Runner Environment

Model files are detected automatically, but inference must be owned by Monarch. The default product path is a self-hosted runner command started by the project, with a local readiness endpoint used only for health/probing.

Router model:

```powershell
$env:MONARCH_SYSTEM_ROUTER_COMMAND = "powershell -ExecutionPolicy Bypass -File scripts/start-router-model.ps1"
$env:MONARCH_SYSTEM_ROUTER_ENDPOINT = "http://127.0.0.1:5051"
```

Chat model runner:

```powershell
$env:MONARCH_WEAK_MODEL_COMMAND = "powershell -ExecutionPolicy Bypass -File scripts/start-weak-model.ps1"
$env:MONARCH_WEAK_MODEL_ENDPOINT = "http://127.0.0.1:5052"
```

Per-level chat runners:

```powershell
$env:MONARCH_MEDIUM_MODEL_COMMAND = "powershell -ExecutionPolicy Bypass -File scripts/start-medium-model.ps1"
$env:MONARCH_MEDIUM_MODEL_ENDPOINT = "http://127.0.0.1:5053"
$env:MONARCH_POWERFUL_MODEL_COMMAND = "powershell -ExecutionPolicy Bypass -File scripts/start-powerful-model.ps1"
$env:MONARCH_POWERFUL_MODEL_ENDPOINT = "http://127.0.0.1:5054"
```

Gemma vision runner:

```powershell
$env:MONARCH_GEMMA_COMMAND = "powershell -ExecutionPolicy Bypass -File scripts/start-gemma-model.ps1"
$env:MONARCH_GEMMA_ENDPOINT = "http://127.0.0.1:5055"
```

Until these project-owned runners exist, Monarch marks model files as available but runners as pending. A bare external endpoint is ignored by default; `MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS=1` exists only for dev smoke tests and must not be treated as product architecture.

## Whole Project Check

Use one command before handing the workspace to a user:

```powershell
npm run verify
```

It runs:

- `npm run typecheck`
- `npm test`
- `npm run smoke`
- `npm run desktop:smoke`
- `npm run oscar:frontend:build`

This keeps the kernel, Electron shell and Oscar frontend aligned instead of validating them as separate islands.
