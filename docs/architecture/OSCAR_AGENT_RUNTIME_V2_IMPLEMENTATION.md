# Oscar Agent Runtime V2 — Phase D implementation record

> Updated: 2026-07-24
>
> Branch: `codex/site_monarch`
>
> Scope: shared backend foundation plus the primary local Oscar Desktop composer path.

```text
foundation implemented
model-driven action loop operational
Oscar Desktop primary path migrated
remaining surfaces pending
```

## Delivered boundary

`MonarchApplication` owns one `OscarAgentRuntime`. An explicit `enableAgentRuntimeV2` option is authoritative when supplied; otherwise `MONARCH_AGENT_RUNTIME_V2` may enable it. The source server, UI server and Electron runtime now enable V2; the primary local Oscar composer creates and streams durable Agent Tasks instead of phrase-routing actions. Attachments, encrypted chat, explicit web mode and Deep Research still use their specialized legacy paths.

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
- Agent decisions use the authenticated raw Oscar Sharing completion boundary rather than conversational `/api/chat`; decision context is deduplicated, redacted and bounded to 12,000 characters before inference.
- Required read-after-write predicates are derived by the trusted capability contract from schema-valid action input. Model formatting cannot weaken or redirect the file postcondition.
- A verified single-action task is grounded and completed directly from Kernel evidence. A second model turn is not required merely to narrate an already proven result.

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

HTTP preserves a validated supported surface source supplied by a trusted local client; source is routing context, never an authorization grant. Events are durable, typed, ordered and replayable through JSON or SSE using `Last-Event-ID`/`after`. The server subscribes before replay, deduplicates buffered/live events and waits for `runner.released` before closing after a terminal event.

## Operational vertical slice

The replay-backed integration scenario creates a real temporary workspace, reads two files, records a recoverable failed read, replans to an allowed alternative, requests durable approval, writes `runtime/report.md` through the Kernel gateway, verifies existence and both content predicates, emits an artifact and completes only after evidence binding succeeds. The fixture is `tests/fixtures/agent/workspace-report-replay.json`; it is not a phrase-specific route or runtime shortcut.

Additional integration coverage proves invalid model output repair without raw-output leakage, active/cooperative and non-cooperative cancellation, cross-runtime dispatch races, exact approval races, pause/cancel settlement, task lease reuse, runner/store-lock renewal conflicts, SSE reconnect/terminal release, strict target grounding and successful same-target recovery after a no-side-effect mutation failure.

The 2026-07-24 Desktop slice adds two production-shaped end-to-end scenarios with no phrase-trigger route:

- the model selects `device.app.open`, Kernel launches the resolved Windows Start application and completion requires `opened=true`;
- the model selects `workspace.files.write`, writes an exact file path/content, verifies existence and content, emits an artifact and completes only after binding that artifact and observation to the goal.

In Full Local mode an explicit path outside the selected workspace receives an exact parent scope. The mutation journal can snapshot and hash-guard only that canonical scope; filesystem red zones are checked before snapshot capture. Guided and Workspace modes retain their narrower boundaries, and Monarch Safe remains blocked in every mode.

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

## Verification on 2026-07-25

```text
npm test -- --maxWorkers=1 --no-file-parallelism
  PASS — 146 files / 1105 tests

focused Agent/App/Core/Device/Workspace/UI suite
  PASS — 12 files / 118 tests

npm run typecheck
npm run smoke (isolated writable roots)
npm run build:runtime
npm run desktop:smoke
  PASS

npm run status (isolated writable roots)
  PASS — 21/21 modules, 204 capabilities, 6/6 model groups
```

The app-launch integration uses an injected Windows runner so it proves model decision, capability resolution, Kernel execution and receipt verification without opening a real user window during the automated suite. The file integration performs a real exact-content write outside its temporary workspace in Full Local mode, verifies it by reading the result and removes the temporary tree. Production Safe was not used.

## Live acceptance on 2026-07-25

The raw local-model path was exercised through the same loopback Agent Task API used by the Desktop composer after a production failure had displayed `no-model-runtime-available`. The failure was not missing runtime availability: the decision payload was 35,525 characters against Oscar's 20,000-character message limit, and the conversational bridge hid the upstream validation error. The dedicated raw completion lane and bounded 12,000-character decision payload remove that ambiguity.

```text
typecheck
  PASS

focused Agent/Models/UI
  PASS — 22 files / 196 tests

complete Vitest suite
  PASS — 146 files / 1109 tests

Telegram task agent_task_95e8088acc791fea21d0a9f891a9b978
  completed — 1 model turn / 1 device.app.open / 1 verified observation
  live Telegram window responding

File task agent_task_4d6028ffc47c81d0c87343dbca6e266c
  completed — 1 model turn / 1 workspace.files.write / 1 verified observation / 1 artifact
  exact 75-character content
  SHA-256 99F6ECAFB36616D8E93ACFFB8427D416C35960E3F927C2952CCA6A75ED0ADEC5
```

The disposable live file was removed after byte-for-byte and hash verification. Production Safe was not read, listed, scanned or mutated.

## Explicitly pending

- Oscar attachments, encrypted chat, explicit web mode and Deep Research remain specialized non-Agent lanes.
- Voice, Telegram and API preserve the shared Agent Task/source contract only for capabilities declared in their `supportedSources`; destructive local capabilities remain unavailable remotely. Coder intentionally keeps its specialized loop while reusing queue/checkpoint/cancellation/receipt foundations.
- Local model sharing still uses the existing Oscar model adapter. A cross-consumer Model Runtime Manager with lanes, queueing, preemption and VRAM leases remains future work.
- Existing Monarch/Profile/Oscar/Coder memory stores are not unified or destructively migrated.
- Capability metadata is explicit for the initial Workspace set and conservative for legacy capabilities; remaining high-risk capabilities need deliberate annotation during their adapter phase.
- Actual worker termination is only as strong as each module's `AbortSignal` handling; bounded detach settles Agent ownership while retaining an unresolved dispatched action truthfully.
- Direct ledger/environment reconciliation for interrupted idempotent actions and durable store retention/compaction remain pending; non-idempotent dispatched actions already stop in user recovery review.
- Browser/computer providers and a broader connector registry remain future capability families; none were bypassed in this slice.
- Adaptive Fast/Balanced is the Agent-First release default: clear atomic tasks
  use one bounded Fast decision, while ambiguity, recovery, untrusted output,
  or sensitive effects escalate explicitly to Balanced. Operators can force the
  all-Balanced profile with `MONARCH_AGENT_DECISION_PROFILE=balanced`.

The next phase is to migrate Telegram and Voice onto the same task/approval/event contract, then deliberately annotate and expose additional cancellable device/browser capabilities. Legacy phrase dispatch can be removed only after specialized lanes and remote-source parity are proven.
