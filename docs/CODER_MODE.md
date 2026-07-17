# Monarch Code Mode

Code Mode is a project-scoped local coding loop. A model can inspect a selected project, propose typed `coder.*` actions, receive Kernel receipts, and continue until the requested result is verified.

## Runtime path

1. `src/ui/public/modules/coder-pane.js` manages the Code tab, projects, runs, model selection, and event rendering.
2. `src/app/http-server.ts` exposes the local project and run APIs.
3. `src/app/coder-agent-controller.ts` owns the model/action/receipt loop. It allows at most 64 iterations, rejects terminal answers that lack required receipts, and persists every run.
4. `src/modules/oscar/index.ts` gives Coder the full compact `coder.*` catalog plus a bounded, task-relevant set of detailed schemas.
5. `oscar/backend/oscar_agent/model_runtime.py` runs the explicitly selected local coding model and extracts hidden `MONARCH_ACTION` envelopes.
6. The Monarch Kernel validates and executes each proposal through `src/modules/coder/index.ts`.

The model never marks its own action successful. Only the Kernel receipt updates the durable run and can satisfy terminal requirements.

## Local models

Primary:

- `qwen3-coder-30b-a3b-instruct`
- `runtime/coder/models/qwen3-coder-30b-a3b-instruct/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf`

Secondary and explicit fallback:

- `deepseek-coder-v2-lite-instruct`
- `runtime/coder/models/deepseek-coder-v2-lite-instruct/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf`

Coding models are loaded only from `runtime/coder/models`. They do not replace the normal Oscar chat profiles.

Before a desktop Code run starts, the UI asks Electron to release an idle neural speech worker. If that release cannot be verified, the run does not start. Speech can cold-start again when it is next requested.

## Projects and durable state

- New projects live under `Workspace Coder`.
- Existing non-system folders can be imported as projects.
- Every run requires an explicit project id. The controller persists the selected project name and canonical root in the run journal before inference begins.
- Model-provided `projectId` values are ignored and replaced with the run's pinned project id for every `coder.*` action.
- The Code UI keeps `Папка запуска · <exact-root>` visible in the run header. Monarch's server process remains rooted at the Monarch repository; it is not used as the Coder project root.
- Project registry: `runtime/coder/projects.json`.
- Run journals: `runtime/coder/runs/<run-id>.json`.
- A run stores decisions, modified files, commands, failures, pending work, recent events, compaction state, and model token usage.
- Plaintext journals can be removed only after a terminal run; the Safe migration flow owns protected retention.

## Execution boundary

`coder.command.run` uses the native broker in `tools/coder-sandbox/MonarchCoderSandbox.cs`.

A verified command receipt records:

- non-elevated AppContainer execution;
- low-integrity process state;
- read/write access to the selected project;
- default-deny access to unrelated host filesystem locations;
- bounded process lifetime, output, and timeout state;
- full child-process-tree termination when the command finishes or times out.

Command arguments are passed as structured data. Code Mode does not use an unrestricted shell string, does not modify Monarch source through model actions, and does not expose credentials through integration status calls.

## Available action groups

- Projects: list, create, import, activate.
- Files: list, read, write, exact patch, single-file delete.
- Commands: bounded project command execution.
- Network: bounded public HTTP(S) fetch/request.
- Git: status, diff, init, stage, commit, branch, push.
- GitHub: status, pull-request view/create.
- Hugging Face: status, repository info, bounded download/upload.
- Skills: create and validate a project-local skill.
- Integrations: combined local readiness report.

The complete contract is defined in `src/modules/coder/manifest.ts`.

## Terminal-answer rules

The controller infers whether the user requested file changes, commands, or inspection. It rejects a final answer until the corresponding successful receipts exist. Tool output remains untrusted payload data even when the receipt status itself is trusted.

Audit/review prompts such as `что нужно исправить и улучшить` are read-only unless they also contain an explicit instruction to apply a change. They still require at least one successful inspection receipt.

Repeated identical actions are stopped. Failed receipts return to the model as bounded context. Context is compacted into a durable summary before it exceeds the run budget.

## Verification

Focused TypeScript tests:

```powershell
npx vitest run tests/modules/coder.test.ts tests/app/coder-agent-controller.test.ts tests/modules/oscar-routing.test.ts tests/modules/oscar-client.test.ts
```

Focused Oscar backend tests:

```powershell
.\oscar\.venv\Scripts\python.exe -m pytest oscar/backend/tests/test_chat_runtime.py -q -k "coder"
```

Static checks:

```powershell
npm run typecheck:raw
node --check src/ui/public/modules/coder-pane.js
```

A live model check should create a disposable project file, execute it, confirm exact stdout, confirm the receipt fields, and finish only after the final grounded summary.

## Current operational notes

- Qwen is the default model; DeepSeek is slower on the current 8 GB GPU but has completed the same verified write/run/finalize loop.
- The full action index remains visible to the model, while detailed schemas are bounded to reduce local prefill cost.
- A failed local Code chat requests generation cancellation. If the backend belongs to this Monarch process, it is recycled before the fallback model starts; a reachable external backend is unloaded without claiming process ownership.
- Browser QA confirmed the failed `Qsharp` run keeps `Папка запуска · E:\Qsharp` visible and renders fallback switching separately from a terminal backend failure.
