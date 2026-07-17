# Workspace, Artifacts, Knowledge

This is the clean-room Monarch adaptation of useful MARK-ALFA mechanics around sandboxed files, generated artifacts, and knowledge freshness policy.

## Workspace Files

The `workspace` module exposes typed file capabilities:

- `workspace.files.read`
- `workspace.files.list`
- `workspace.files.search`
- `workspace.files.write`
- `workspace.files.delete`

All paths pass through `filesystem-policy` before execution. By default, access is constrained to the Monarch workspace root. Write/delete operations against drive roots, the workspace root, and protected red zones are blocked.

Protected red zones include Windows/system folders, common user-secret folders, `.git`, `node_modules`, and `LLM models`.

## Artifacts

The `artifacts` module writes generated outputs through the same filesystem policy:

- `html`
- `md`
- `txt`
- `json`

Default output root is `artifacts/generated`. Writes require confirmation through the normal permission gate.

## Knowledge Policy

The `knowledge` module does not search the web. It only decides whether a request should remain local or may need web augmentation:

- `local_only`
- `web_optional`
- `web_required`

Freshness-sensitive requests such as latest/current/today/news/weather/prices/releases become `web_required`. Code, local files, and system actions stay `local_only`.

## MARK-ALFA Boundary

Imported concepts:

- sandbox root and red-zone checks
- typed file tool surface
- artifact writer for simple file types
- local-first knowledge freshness policy

Rejected concepts:

- dynamic JavaScript tool loading
- self-generating tools
- broad shell/action bridge
- tracked runtime settings, memory, secrets, and generated artifacts
