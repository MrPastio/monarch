# Models Runtime

This is the clean-room Monarch model runtime surface.

## Runtime Roles

Monarch keeps the same useful tier split:

- `router`
- `weak`
- `medium`
- `powerful`
- `vision`

The model catalog reads `LLM models` and maps those folders to runtime roles.

## Self-Hosted Runtime Policy

Monarch must not depend on a user-started external model program.

The product path is:

- model files live inside the Monarch workspace;
- a runner command is owned by this project;
- `models.runtime.start` starts that command after confirmation;
- a local readiness endpoint is used only to probe the managed process;
- `models.chat.complete` talks to that self-hosted local runtime and normalizes the output.

Relevant env vars:

- `MONARCH_SYSTEM_ROUTER_COMMAND`
- `MONARCH_WEAK_MODEL_COMMAND`
- `MONARCH_MEDIUM_MODEL_COMMAND`
- `MONARCH_POWERFUL_MODEL_COMMAND`
- `MONARCH_GEMMA_COMMAND`
- matching local readiness endpoints such as `MONARCH_WEAK_MODEL_ENDPOINT`

A bare HTTP endpoint is ignored by default. `MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS=1` exists only for smoke tests and temporary dev harnesses.

## Managed Process Start

`models.runtime.start` can start a configured local runner command and waits for the matching local readiness endpoint.

Starting/stopping runtimes is risk `execute` and requires confirmation.

## Safety Boundary

Monarch does not import MARK-ALFA's monolithic llama-server orchestration. It uses a narrow interface:

- explicit role;
- project-owned command;
- local readiness endpoint;
- permission-gated start/stop;
- timeout-controlled calls;
- normalized model output.
