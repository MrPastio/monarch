# Oscar Agent Runtime V2 — Phase D implementation record

> Date: 2026-07-22
>
> Branch: `codex/oscar-agent-runtime-v2`
>
> Scope: shared backend foundation and one operational workspace-report slice; no legacy surface migration.

```text
foundation implemented
vertical slice operational
surface migration pending
```

## Delivered boundary

`MonarchApplication` owns one optional `OscarAgentRuntime`. An explicit `enableAgentRuntimeV2` option is authoritative when supplied; otherwise `MONARCH_AGENT_RUNTIME_V2` may enable it. The default is off, so existing Desktop Chat, Oscar pane, Telegram, Voice, Coder, `/api/intent-jobs`, `/api/agent/jobs` and `/api/execute` paths are unchanged.

The runtime is deliberately not a Monarch module or capability. It selects bounded candidates from the live capability registry, accepts one strict model decision and sends every action through the existing Application proposal gateway and Kernel. Policy, Security, schema checks, leases, confirmation challenges, ledger, mutation journal and deterministic action predicates remain authoritative.

## Runtime components

- `types.ts`, `goal-normalizer.ts`, `plan-manager.ts`: versioned JSON-only task, goal, plan, message, approval, observation, artifact and event contracts.
- `agent-task-store.ts`: versioned local/in-memory stores, atomic replacement, heartbeat-backed cross-process lock with pre-replace fencing, compare-and-swap checkpoints, idempotent request/message IDs, monotonic events, task claims and claim renewal.
- `budget-manager.ts`, `checkpoint-manager.ts`: hard step/model/tool/wall/failure/no-progress limits and checkpoint policy.
- `capability-resolver.ts`, `runtime-availability.ts`: deterministic 5-12 candidate retrieval with source, module, runtime, credential and policy diagnostics.
- `strict-json-schema.ts`, `decision-schema.ts`: full-response JSON parsing, exact discriminated unions, current-candidate enforcement, capability input validation and one bounded repair turn.
- `context-compiler.ts`: bounded/redacted context that labels tool data as untrusted; compiled system/developer prompts, raw model responses and hidden reasoning are never persisted.
- `kernel-execution-adapter.ts`: exact action preparation, durable approval binding, fresh ephemeral confirmation challenge and Kernel-only execution.
- `observation-normalizer.ts`, `result-verifier.ts`, `recovery-policy.ts`: factual receipts, deterministic evidence, false-success prevention and bounded retry/replan/wait/fail decisions.
- `agent-loop.ts`, `agent-runtime.ts`: lifecycle ownership, heartbeat-backed single runner, pause/resume/message/cancel/approval handling and terminal settlement.
- `evaluation.ts`: deterministic run metrics for completion, clarification, tool calls, looping, false success, permissions and recovery.

The default durable file is `runtime/agent/tasks.v2.json`. Corrupt or version-incompatible state fails closed and is not overwritten.

## Completion and recovery invariants

- A model can select only a capability returned by the current resolver window.
- A mutating decision must declare the capability-required deterministic predicates against its actual target before dispatch.
- `complete` must bind every required expected-output and success-criterion ID to successful observations and, where applicable, artifacts.
- A side-effect receipt alone is not deterministic completion evidence; verifier predicate evidence is required.
- An earlier failed mutation with no side effect cannot poison a later verified same-target mutation. Conversely, a failed or superseded observation cannot self-certify completion.
- An idempotent, non-mutating observation/read retry is bounded to one repeat. Repeated no progress and exhausted budgets fail truthfully.
- An approval references the exact durable proposal and canonical hash. Cancellation revokes pending approvals. A task-scoped lease is reused only within its capability/root/time/budget constraints.
- Runner claims are renewed while model and tool stages are active. A runner that loses its claim cannot write over its successor's checkpoint.
- Store-lock ownership is renewed and fenced immediately before atomic replacement, so an expired stale writer retries from the newest durable document instead of overwriting a concurrent commit.
- Concurrent task/message/approval requests preserve idempotency, including the original `autoStart` semantics.
- If durable Agent startup fails after Kernel startup, Application startup rolls the Kernel back, resets ownership and preserves the original store error.
- Cancellation/pause from another runtime is reloaded before dispatch and polled during active stages. Pure read/model stages bounded-detach after abort; effectful capabilities require `cancellation: supported`, and only a cooperative worker attests an actual stop.
- Answer completion is bound to exact action-target provenance and complete observed values; the durable final answer is derived from the canonical observation rather than untrusted model wording.

## Versioned HTTP/SSE contract

All JSON mutations require `version: 1`, enforce the existing loopback/origin/session mutation guard and reject unknown or wrongly typed fields recursively. Agent bodies are capped at 256 KiB; malformed IDs fail as versioned `400 invalid-id` responses.

```text
POST   /api/agent/tasks
GET    /api/agent/tasks
GET    /api/agent/tasks/:id
POST   /api/agent/tasks/:id/messages
POST   /api/agent/tasks/:id/pause
POST   /api/agent/tasks/:id/resume
POST   /api/agent/tasks/:id/cancel
POST   /api/agent/tasks/:id/approvals/:approvalId
GET    /api/agent/tasks/:id/events
```

HTTP always assigns source `api`; a client cannot impersonate Telegram, Voice, Coder or system sources. Events are durable, typed, ordered and replayable through JSON or SSE using `Last-Event-ID`/`after`. The server subscribes before replay, deduplicates buffered/live events and waits for `runner.released` before closing after a terminal event.

## Operational vertical slice

The replay-backed integration scenario creates a real temporary workspace, reads two files, records a recoverable failed read, replans to an allowed alternative, requests durable approval, writes `runtime/report.md` through the Kernel gateway, verifies existence and both content predicates, emits an artifact and completes only after evidence binding succeeds. The fixture is `tests/fixtures/agent/workspace-report-replay.json`; it is not a phrase-specific route or runtime shortcut.

Additional integration coverage proves invalid model output repair without raw-output leakage, active/cooperative and non-cooperative cancellation, cross-runtime dispatch races, exact approval races, pause/cancel settlement, task lease reuse, runner/store-lock renewal conflicts, SSE reconnect/terminal release, strict target grounding and successful same-target recovery after a no-side-effect mutation failure.

## Verification on 2026-07-22

```text
npm run typecheck
  PASS

focused Agent/API/Core suite
  26 test files / 148 tests PASS

npm test -- --maxWorkers=1
  126 test files / 1010 tests PASS

npm run smoke
  PASS

npm run status
  PASS — 21/21 modules, 202 capabilities, 6/6 model groups

npm run desktop:smoke
  PASS

npm run build:runtime
  PASS — dist/monarch-server.mjs, 1,913,052 bytes

npm run upload:dry-run
  PASS — 959 included, 137,407 excluded, 0 violations
```

The default parallel Vitest runner also exposed load-sensitive timeouts in different pre-existing Telegram polling mocks. The complete `tests/modules/telegram.test.ts` file passes 28/28 in isolation, while the deterministic single-worker complete suite above passes 1010/1010.

The generic Workspace policy always treats `<workspace-drive>:\MonarchData\Safe` as a red zone, including under `danger-full-access`. Its regression uses only a synthetic `never-read` path. Production Monarch Safe was not read, listed, scanned, mutated or used for QA.

## Explicitly pending

- Desktop, Oscar pane, Telegram, Voice and Coder adapters are not migrated; legacy paths remain the current product surfaces.
- Local model sharing still uses the existing Oscar model adapter. A cross-consumer Model Runtime Manager with lanes, queueing, preemption and VRAM leases remains future work.
- Existing Monarch/Profile/Oscar/Coder memory stores are not unified or destructively migrated.
- Capability metadata is explicit for the initial Workspace set and conservative for legacy capabilities; remaining high-risk capabilities need deliberate annotation during their adapter phase.
- Actual worker termination is only as strong as each module's `AbortSignal` handling; bounded detach settles Agent ownership while retaining an unresolved dispatched action truthfully.
- Direct ledger/environment reconciliation for interrupted idempotent actions and durable store retention/compaction remain pending; non-idempotent dispatched actions already stop in user recovery review.
- Tool Forge, browser/computer providers and connector registry are future capability families; none were invented or bypassed in this slice.

The next safe phase is a read-only Desktop task viewer plus exact approval UI behind the same feature flag, followed by one compatibility adapter at a time with parity and rollback gates.
