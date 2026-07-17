# Monarch: Current Project State

## Architecture

Monarch — local-first AI platform with four main runtime lanes:

- TypeScript kernel and control plane in `src/core`, `src/app`, and `src/modules`;
- local HTTP UI plus Electron shell in `src/ui/public` and `desktop/electron`;
- Oscar FastAPI/model runtime in `oscar/backend` with a React preview shell in `oscar/frontend`;
- standalone fail-closed Security protector in `security` and isolated Safe storage/window logic in `desktop/safe`.

The source of truth for built-in packages is `src/modules/catalog.ts`. Capability execution stays module-owned and passes through schema validation, permission policy, Security checks, and the execution engine.

## Active Product Surfaces

- Assistant and Oscar chat/model routing
- Workspace and artifact operations
- Coder projects and sandboxed execution
- Voice input, local STT/TTS, device volume/brightness
- Sharing and Telegram remote ingress
- Models/runtime management
- Security Center and background protector
- Safe encrypted local storage
- Diagnostics, memory, knowledge, profile, plugins, Astra skills, custom tools

## Release Contract

The canonical release gate is:

```powershell
npm run verify:full
```

It includes TypeScript typecheck/tests/smoke, Electron and Safe checks, Oscar frontend build, Oscar backend pytest, Security pytest, upload-boundary validation, and npm audits for the root and Oscar frontend.

Local runtime state, models, caches, secrets, generated output, nested scratch repositories, and browser/agent traces are excluded by `.gitignore` and `PROJECT_MANIFEST.md`.

## Current Engineering Priorities

1. Keep `verify:full` green on every integration branch.
2. Preserve one Desktop runtime owner for HTTP, Oscar, Telegram, and shutdown lifecycle.
3. Continue splitting large orchestration/UI files only through narrow tested extractions.
4. Keep Safe and Security state isolated from normal workspace/model context.
5. Treat `AI_HANDOFF.md` as operational history; current code and live health remain authoritative.
