# Oscar Agent Gap Analysis

> Evidence date: 2026-07-22. Baseline branch `codex/oscar-agent-runtime-v2`, starting HEAD `365f0d0`. Matrix labels preserve the pre-implementation baseline; the Phase D delta below records what is implemented now.

## Legend

- **supported**: one authoritative implementation satisfies the requirement;
- **partial**: useful primitives exist, but no common agent semantics;
- **missing**: no implementation owns the requirement;
- **conflict**: multiple incompatible owners or a bypass contradict the target.

## Requirement matrix

| Requirement | Current support | Conflict / evidence | Proposed owner | Migration impact | Required tests |
|---|---|---|---|---|---|
| First-class durable AgentTask | missing | Intent jobs are an in-memory `Map` in `application.ts`; Coder has a separate run journal | Agent Runtime + AgentTaskStore | add V2 entity/store; keep old jobs | create/list/get, CAS, corruption, restart |
| Structured goal | missing | current intent stores only text/context | Agent Runtime | deterministic goal normalization plus structured API input | normalization bounds, expected outputs, immutable original request |
| Incremental plan | conflict | V1 Planner creates one route step; renderer and Coder have separate loops | PlanManager | new AgentPlan, leave `MonarchPlan` compatibility path | revision/dependency/failed replacement step |
| Persistent task status | missing | jobs and confirmation state disappear on restart | AgentTaskStore | strict local persistence behind flag | terminal preservation, interrupted recovery |
| Cross-process single runner | missing | Desktop may select another port while sharing workspace | AgentTaskStore | file lock + CAS + expiring runner claim | two-store contention, stale claim takeover |
| Bounded agent loop | partial | only Coder feeds receipts back to a model | AgentLoop | extract common model/decision/action/observation cycle | max turns/tools/wall/no-progress |
| Dynamic tool selection | partial | Router selects one capability; Oscar proposals are precomputed | CapabilityResolver + model | retrieve 5-12 cards each turn | relevant include, unavailable/source forbidden exclude |
| Strict structured decision | missing | core schema validator does not implement enum/oneOf/items; Python/UI parse their own payloads | Decision parser | strict full-response JSON and discriminated union | Markdown/embedded JSON/unknown keys rejected |
| Invalid-output repair | partial | individual Python flows have parsers/fallbacks | AgentLoop | one repair attempt, deterministic failure | repair succeeds once; no infinite loop |
| Model output never directly executes | partial | typed proposal paths are safe; renderer/Python still have special dispatch | Decision parser + action gateway | V2 accepts only candidate capability + schema-valid input | shell fragment and prompt injection never dispatch |
| Kernel-owned execution | supported | Execution Engine owns schema/policy/security/executor | Kernel | reuse without bypass | action gateway reaches existing gates |
| Action-bound approval | supported/partial | Application proposal tokens bind canonical hash, but are in-memory | Application gateway + durable Agent approval | store exact proposal/hash; mint fresh token after restart | target change, expiry, one-shot, deny |
| Plan/session lease | partial | capability task lease exists for proposals | Kernel lease store + Agent Runtime | expose bounded choice; never skip action preflight | capability/root/budget/expiry/revocation |
| Permission profiles | supported | guided/workspace-autonomous/full-local in Permission Gate | Kernel | Agent Runtime renders result/wait state | profile matrix, sensitive actions never auto-allow |
| Security controller | supported with exceptions | generic Kernel path works; Coder/Voice have trusted special lanes | Kernel / later compatibility adapters | V2 uses proposal gateway; audit special lanes before migration | policy evidence and override exact target |
| Observation layer | partial | execution receipts and predicate observations exist, no common agent DTO | ObservationNormalizer | redacted factual records with provenance | success/partial/failure/cancel, no secret leakage |
| Output schema validation | missing | Execution Engine validates input only | ObservationNormalizer / ResultVerifier | validate declared output schema before progress | invalid output cannot satisfy step |
| Expected-effect verification | partial | Action predicates support exists/not-exists/equals/contains/status/result.* | ResultVerifier + Kernel predicates | require verification for mutating/external decisions | `ok:true` without required check cannot complete |
| Goal completion verification | missing | jobs often mark any returned result completed | ResultVerifier | terminal complete requires verified evidence and expected outputs | false-success prevention, missing evidence replan |
| Replanning after tool failure | partial/conflict | Coder loops; all other paths stop | RecoveryPolicy + AgentLoop | normalized failure becomes next observation | failed primary tool -> allowed alternative |
| Partial result truth | partial | modules can return errors; no task-level partial semantics | ObservationNormalizer | explicit partial observation, no success copy | verification failure/side effect partial |
| Read-before-ask | partial | routers may clarify early; modules can inspect | Resolver + AgentLoop policy | permit safe read-only exploration before ask-user | missing file discovery before clarification |
| User clarification | partial | Router returns clarification, but no durable waiting task | Agent Runtime | `waiting-for-user` + durable message resume | one blocking question, idempotent message |
| Pause/resume | missing | only module-specific stops/pauses | Agent Runtime | safe-checkpoint pause and explicit resume | pause during model, waiting state preservation |
| End-to-end cancellation | partial | execution control now propagates through Application, Kernel and Execution Engine; actual stop still depends on cooperative module workers | Agent Runtime + Application/Kernel/Execution Engine | require explicit cancellation metadata for effectful capabilities and retain unresolved dispatch truth when stop is not attested | pre-dispatch, mid-model, mid-tool settlement |
| Checkpoint before sensitive action | missing at task level | ledger is durable after proposal dispatch, task state is not | CheckpointManager | strict atomic checkpoint must succeed before gateway call | persistence failure prevents execution |
| Restart recovery | partial | ledger/journal survive; task does not; Coder turns running into failed | Agent Runtime + ledger | interrupted state, environment/ledger reconciliation | completed preserved, non-idempotent not replayed |
| Idempotency | supported at action level | direct execute may be non-durable; no task/message request key | Ledger + AgentTaskStore | task `clientRequestId`, message IDs, proposal canonical identity | duplicate POST and duplicate message |
| Rollback | partial | workspace mutation journal supports selected operations | Kernel / RecoveryPolicy | surface availability; never imply universal rollback | snapshot failure blocks action, rollback status truth |
| Budgets | partial | capability leases have action/file/network budgets; no model/task limits | BudgetManager + Kernel leases | add model/tool/step/wall/failure/no-progress budgets | exact terminal reason for each exhausted budget |
| Runtime-aware availability | missing/partial | module active is often treated as available; health exists separately | RuntimeAvailability + Resolver | normalized state, readiness separate from health | stopped excluded; ready+degraded included with warning |
| Model runtime coordination | conflict | Oscar, Voice, Coder and Sharing manage local resources separately | future Model Runtime Manager | initial provider uses existing adapter; later lanes/leases | cancellation, queue, truthful unavailable/degraded |
| Capability metadata | missing/partial | legacy risk/routing/schema only | core optional input + resolver defaults | backward-compatible defaults and priority workspace annotation | validator, defaults, inventory/manual-review list |
| Effect profile | partial | RiskVector is created per proposal, legacy risk remains coarse | Kernel contract + metadata resolver | retrieval diagnostics first; no policy weakening | explicit metadata cannot understate legacy risk |
| Capability diagnostics | partial | Router trace exists for intent routing | CapabilityResolver | included/excluded/availability/policy reasons per turn | bounded diagnostics, no secret data |
| Skill workflows | partial | Astra discovers/matches cards and `requiredCapabilities`; no common workflow executor | Skill Registry future; ContextCompiler now | treat skill text as untrusted hints, not authority | required capability does not bypass resolver/policy |
| Tool Forge boundary | conflict | custom tool auto-create exists and execute-time dynamic risk is separate | future Tool Forge | exclude auto-create -> immediate execute from V2 resolver | created tool cannot run in same unreviewed loop |
| Unified memory scopes | conflict | Monarch Memory, Profile, Oscar SQLite and Coder context coexist | future Memory Service | adapters; no destructive migration | project isolation, provenance, no guessed facts |
| Shared file primitives | conflict | Workspace, Coder, Python Oscar and Studio have separate operations | future scoped file service | keep roots/scopes isolated while extracting primitives | junction/symlink/root/atomic write/hash/rollback |
| One Oscar identity | conflict | assistant, Oscar Python/UI and Coder controller act as separate agents | Agent Runtime | migrate surfaces gradually; Python becomes inference/ML provider | one task visible across source adapters |
| Desktop integration | missing for V2 | main chat and Oscar pane use legacy job/UI loops | Desktop adapter later | first expose V2 API/events/state; viewer next | render progress/approval/artifact/failure |
| Telegram integration | missing for V2 | dispatcher submits one intent; native commands bypass shared task | Telegram adapter later | create/continue task and return verified result | remote restrictions, Desktop approval, response routing |
| Voice integration | missing for V2 | hardcoded UI classifier and direct execute | Voice adapter later | action requests create task; fast conversation stays isolated | spoken ack + only verified completion |
| Coder integration | conflict | strongest loop but own policy/status/terminal heuristics | Coder adapter later | preserve UI/project/sandbox; use common task owner | unrelated project context never leaks |
| Direct capability API task semantics | missing | `/api/execute` intentionally has no goal/task/plan | compatibility route + V2 task API | keep route; do not claim it is agent execution | policy still applies; V2 action always has task |
| Versioned task API | missing | existing `/api/agent/*` covers proposals/jobs/ledger | Agent HTTP adapter | add `/api/agent/tasks`; version payload, not path | route bodies, guards, not-found/conflict |
| Durable typed SSE | missing | current intent SSE subscribes late, polls, no replay, disallows dots | AgentTaskStore + Agent HTTP adapter | sequence, replay, `Last-Event-ID`, heartbeat | race-free replay/live dedupe, terminal close |
| Observability/trace | partial | Kernel events/audit exist; no task trace/decision metadata | Agent Runtime | task/trace IDs, model/candidate/policy/verification durations | redacted event envelope, structured rationale only |
| Connector contract | partial | Coder has GitHub/HF capabilities; others are domain-specific | future Connector Registry | typed credential refs, read/write/effect/preview/revoke | secret absent from context/log/observation |
| Computer/browser foundation | partial | Device has narrow actions; external UI automation is not a common capability family | future Computer capability providers | semantic UIA/DOM first, visual fallback and mandatory post-check | domain restriction, prompt injection, state verification |
| Safe isolation | supported boundary | only `safe.status` is shared; vault outside repo | Safe remains independent | no Safe content capability; disposable QA only | resolver never exposes content; production vault untouched |
| Ready vs health | supported contract | audit confirms distinct endpoints; module consumers may conflate | Application/runtime availability | preserve `/api/ready` vs `/api/health` | ready with degraded health remains truthful |

## Current call-path ownership summary

| Surface | Task owner now | Next-tool owner | Plan persistence | Observation back to model | Replan | Restart |
|---|---|---|---|---|---|---|
| Desktop Chat | Application RAM job | Router once | none | no | no | lost |
| Oscar pane | renderer + Python conversation | Python model + renderer | conversation only, pending plan lost | final wording only | no | partial conversation only |
| Telegram | call stack + bot progress | Router once / native command | none | no | no | task lost |
| Voice | renderer + VoiceSessionStore | regex/hard map | none | no | clarification only | lost |
| Coder | durable CoderRun journal | model/controller | journal | yes | yes | running -> failed |
| Direct API | HTTP caller | caller | none | n/a | no | lost |

## First vertical slice coverage

The Phase D workspace report scenario must prove all rows below without a phrase-specific route:

1. create structured AgentTask and initial plan;
2. Resolver selects a bounded workspace capability set from the live registry;
3. replay model fixture chooses multiple real read capabilities;
4. every receipt becomes a redacted observation;
5. model chooses a typed Markdown write with verification declared before dispatch;
6. guided profile produces a durable exact approval; approval replay uses a fresh Application challenge;
7. Execution Engine performs the write and deterministic file existence/content predicates;
8. completion references verified evidence and the expected artifact;
9. typed events replay through SSE;
10. cancel, budget and restart states are truthful;
11. a missing/failed primary read returns to the model, which selects a fixture-defined alternative;
12. feature flag off leaves existing routes and product behavior unchanged.

## Phase D implementation delta

The shared backend foundation now closes the following baseline gaps behind the default-off flag:

| Area | Phase D state | Evidence |
|---|---|---|
| durable AgentTask, goal, plan, messages, status, events | implemented | strict V2 contracts and local/in-memory `AgentTaskStore` |
| cross-process runner, CAS and restart semantics | implemented | lock/CAS tests, expiring claim takeover, heartbeat and lost-claim write protection |
| bounded loop and dynamic tool retrieval | implemented | 5-12 resolver, strict decisions, one repair, budgets and no-progress cutoff |
| Kernel-owned actions and exact approvals | implemented | Application proposal adapter, canonical hash binding, cancellation revocation and bounded task lease reuse |
| observations, deterministic verification and recovery | implemented | receipt normalization, evidence bindings, output/effect predicates, false-success and same-target recovery tests |
| end-to-end cancellation foundation | implemented/partial by module | signal crosses Application/Kernel/Execution Engine; `workspace.files.write` consumes it, pure read/model stages bounded-detach, and only cooperative workers attest an actual stop |
| versioned task API and typed durable SSE | implemented | route guards, bounded bodies, replay/live dedupe, `Last-Event-ID`, terminal runner-release close |
| workspace report scenario and evaluation | operational | real temp-workspace integration plus deterministic replay/metrics fixture |
| Desktop/Telegram/Voice/Coder ownership migration | pending | current product call paths remain unchanged |
| model runtime manager and unified memory/connector registries | pending | existing providers/stores remain adapters; no destructive migration |

This delta does not convert legacy surface rows to supported: no surface owns V2 task UX until the compatibility adapters land.

## Characterization baseline

Before V2 edits, the following focused gate passed:

```text
10 test files / 66 tests PASS
```

Coverage: action protocol, verifier, agency state, Policy Kernel, Application proposals, V1 planner/router, Workspace, Agent Skills and Custom Tools.

## Migration removals unlocked later

No legacy path is removed in Phase D. After surface parity and migration evidence, candidates are:

- renderer `handleTypedActionPlan()` and recursive command planning;
- Telegram generic one-shot task dispatcher state;
- Voice hardcoded action orchestration while retaining low-latency conversation;
- Coder's independent outer model loop, while retaining project UI and sandbox;
- Python direct workspace/memory orchestration after TypeScript adapters own task truth;
- duplicate intent-job progress semantics once old clients consume AgentTask events.

These are removal candidates, not permission to delete them before compatibility gates pass.
