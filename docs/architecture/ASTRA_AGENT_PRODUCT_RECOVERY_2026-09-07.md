# Astra: practical agent product recovery

2026-09-07 Codex. Owner requests a reliably working agent, including structural
changes if needed. Preserve standard Oscar chat/Stop/history and Kernel authority.
This is the active product objective, not completion of another synthetic seam.

## Verified starting evidence

HEAD before pass: 8329660e34e3d5734bb5b0157037960fb7e61b48.
User reports broadly broken basic agent tasks and suspects model/runtime wiring.
Read-only classifier probe reproduced these requests becoming ordinary chat:
- `Создай папку report и сохрани в ней результат`
- `Сравни два выбранных файла и объясни различия`
- `Посмотри на экран и объясни ошибку`

Source route trace: coordinator.agentRuntimeForTurn returns no general runtime
when request.astra exists; otherwise uses configured MonarchAgentRuntime. Application
constructs that runtime with LocalAgentDecisionProvider. Native Astra selection
module separately supplies typed goals for selected material. Thus there IS model
integration, but limited typed Astra execution is not the general task route.
No evidence yet that the actual model is the primary cause of the user's failures.

## Work order and acceptance

### Owner scope extension: all comparable integration breaks

2026-09-07: owner explicitly requests finding and fully repairing analogous
disconnects through modernization, not only the reported model/Astra link.
The following is an investigation/acceptance map, NOT a list of proven defects.

| Boundary | Required evidence and repair criterion |
| --- | --- |
| Ordinary composer -> Turn -> agent | Operational intent reaches execution or explicit clarification; attachments and selected model remain bound to the request. |
| Turn -> task owner | General requests and selected-material goals retain one authoritative lifecycle, history and Stop; no parallel executor or silent downgrade. |
| Task -> model | Record actual selected model, prompt, response, finish reason and failure; a configured provider alone is not evidence of inference. |
| Model -> capabilities | Available tools, schemas and observations reach the planner; valid decisions become admitted actions without invented paths or permissions. |
| Action -> Kernel -> effect | Real dispatch and independently observed effect agree; rejection and partial effects remain visible and recoverable. |
| Observation -> next decision | Multi-step tasks consume actual results, retain goal/context and stop boundedly rather than repeating or claiming completion early. |
| Cancellation/restart -> ownership | Stop reaches inference and execution; late results, retries and restart cannot duplicate effects or resurrect cancelled tasks. |
| Source -> installed UI/transports | Verify actual packaged configuration and ordinary UI results; source-only success is not installed acceptance. Check other transports when shared repairs affect them. |

For every confirmed defect retain the reproducing task, first broken boundary,
root cause, owning component, structural fix and focused regression, followed by
the same end-to-end task. Related boundaries are rechecked after shared changes.
Do not remove safety/consent barriers merely to make a task pass. Do not classify
all route differences as defects before checking their contracts.

Read-only follow-up confirms `src/main.ts` enables the general agent runtime and
`src/modules/models/runtime-client.ts::completeAgentInferenceThroughOscar` sends
decision messages and JSON schema through `OscarClient.completeRaw` on the agent
inference lane. Therefore a completely absent model connection is not established;
actual inference and the ordinary/typed-goal split still require the live trace.

1. Repair confirmed intake losses. Local object/observation requests need execution
   or clarification, not an unsupported answer. Never infer target permissions
   or construct tool arguments in the classifier. Keep discussion/negation safe.
2. Capture one ordinary-chat task end-to-end on the actual local model with a
   unique synthetic workspace and conversation: incoming request, selected route,
   outgoing decision prompt, actual model reply, admitted action, Kernel result,
   final UI outcome. No user conversation/history/Safe reads. Compare basic read,
   create and two-step read/summarize/write; include Stop and failure recovery.
3. Use that evidence to unify task ownership/model decision routing in the existing
   application. Do not add a second executor or merely relabel the old route V3.
   Route status or a task card is not successful agent execution.
4. Repair planning/tool selection/recovery where the captured chain fails. Change
   the model contract or architecture if needed; do not accumulate special-case
   command grammars as a substitute for general task execution.
5. Repeat a bounded representative task corpus with independent final-state
   checks. Track completed user outcomes, interventions, latency, false completion,
   unintended effects and recovery, not just JSON validity or unit-test totals.
6. Only after source acceptance update the protected `<installed-app-root>` installation
   by supported means and repeat native-chat acceptance. No new installer requested.

## This pass

Implemented intake fix plus positive/negative disposition regressions. 170 tests
PASS across disposition, operational goal binding and Turn coordinator. English
negation may ask clarification, but must never execute. No real-model/native UI
acceptance this pass; no general planner readiness claim. Existing benchmark
scripts cannot be run blindly: one auto-starts/shuts down the backend, another
changes security policy and opens Telegram. Build a bounded scoped invocation
around existing runtime instead of changing the user's live policy.

## Real-model recovery pass: 2026-09-07

Three confirmed boundaries repaired in source:

1. **Phase vs selected model:** explicit Fast (and non-Qwen explicit roles using
   the compact tier) received the execution prompt while the loop required a
   model-authored plan. Actual Fast returned `act/workspace.files.read` in the
   planning phase. Prompt, output budget and schema now follow phase first;
   exact user model choice/fallback policy is unchanged.
2. **Generated schema vs parser:** flat optional planning fields admitted a
   `revise-plan` with `code: plan_123` and no `reason`; real inference reproduced
   this after the prompt repair. Planning now uses discriminated exact shapes
   with required fields, not post-hoc deletion of malformed fields. Native
   inference then produced a parser-valid read/summarize/write plan.
3. **Kernel result vs user answer:** ordinary Turn + real Fast + Application
   gateway + real workspace read succeeded, but the final chat message was only
   `Read file ...`; the observed content was discarded by presentation. A bounded
   verified-read projector now uses retained content from the exact completed
   Kernel evidence and matching action target, not a fresh read or model claim.
   It excludes mutations/ambiguous multiple reads, fences literal content and
   labels truncation/redaction. Source ordinary Turn now delivers the content
   into both the outcome and persisted-message callback after exactly one read.

### Reproduction and evidence

Opt-in scripts:

```
.tools/node-v22.23.1-win-x64/node.exe --import tsx scripts/agent-recovery-model-probe.ts --real-local-model --planning-only
.tools/node-v22.23.1-win-x64/node.exe --import tsx scripts/agent-recovery-model-probe.ts --real-local-model --ordinary-turn
.tools/node-v22.23.1-win-x64/node.exe node_modules/typescript/bin/tsc -p scripts/tsconfig.agent-recovery.json
```

Each run creates an exact marked child under the verified `.test-tmp` D: junction.
The worker uses production LocalModelRuntime/stream_raw_chat with the exact
existing Gemma E2B Q5 model, no product main/profile/history, no mock/fallback,
no downloads, and no network. The ordinary-turn fixture starts one external
MonarchAgentRuntime with actual Application gateway/Kernel/workspace module;
the extra test fence admits only its synthetic file read. No Security policy
mutation, native desktop control, or user installation update.

Artifact parent: `<qa-artifact-root>`.

- `agent-recovery-model-Tul7vI`: baseline real-model read/write selection and
  wrong planning action. No filesystem effects in this decision-only probe.
- `agent-recovery-model-g2vryM`: intermediate prompt-only repair still produces
  invalid hybrid plan; preserved as failure evidence.
- `agent-recovery-model-jfmXbW`: corrected native planning schema; valid plan.
- `agent-recovery-model-6HcpWm`: actual one-read source route, succeeded Turn but
  missing content in final response. Its old harness oracle incorrectly compared
  Turn status with `completed` (actual status is `succeeded`), causing a needless
  wait; raw Turn is authoritative. Missing-content result was real, not that
  harness status mistake.
- `agent-recovery-model-ISxMqN`: repaired one-read route: `succeeded`, exact
  content in outcome and persisted message, one dispatch, unchanged fixture.

Exploratory harness errors are not product failures: first decision probe omitted
parser candidate context; first ordinary probe fenced `input` instead of canonical
`args`. Both failed before unwanted effects and were corrected; artifacts retained.

Validation: 338 focused tests across decision provider, runtime, loop, verified
read presentation and Turn coordinator PASS. Source and probe TypeScript checks
PASS; diff check PASS. All probe model workers closed.

### Still open (do not claim product readiness)

The model bridge is isolated stdin -> production loader, NOT the production HTTP
transport/catalog or installed native UI. Single-file read acceptance does not
prove summarization, multi-step completion, arbitrary tool discovery, memory,
Stop/restart, Computer Use, or MAX. Next: bounded create and read/process/write
through the ordinary route; then production transport and native UI. Investigate
generic execution JSON's remaining flat shape based on actual failures. Do not
solve compound tasks by expanding command regexes or calling tool status success
the user's requested outcome.

## Ordinary creation and continuation: 2026-09-07

The isolated source fixture now admits exact new `result.txt` creation as well
as reads. It rejects existing destinations/overwrite, other paths/capabilities,
large content and excess dispatches; production permission/Kernel checks remain.
`--create` and `--summarize` select explicit synthetic requests. The fixture's
catalog is intentionally restricted to workspace read/write; this is NOT an
all-capabilities, production model-transport, or installed acceptance run.

- `agent-recovery-model-Ohx4WF`: ordinary create **PASS**: real Fast, one write,
  exact Russian text read back independently, Kernel existence/equality checks,
  source fixture unchanged.
- `agent-recovery-model-rYG1UC`: read/process/write fails after one read. Fast
  score-window projection hides the eligible write tool despite its presence in
  the resolver result. The model proposes a relevant write, then repair input
  overflows 3600 characters because the full execution journal is duplicated.
- Fixed: continuation preserves up to three ranked eligible tools independently
  of the original first-clause score gap. Existing readiness/policy filtering and
  exact repair exclusions remain. Fast observations retain facts, uncertainty,
  mutation state, source IDs and evidence references, not timing/hash/receipt
  bulk. Full checkpoints are unchanged and remain verification authority.
- `agent-recovery-model-Pq5TEM`: after those repairs, real read + write happen;
  file contains a Russian ORBIT summary with correct 7/2 counts. Task still fails
  at the next decision due repeated goal descriptions in the compact context.
- Fixed: Fast output obligations reuse the existing goal-description compactor;
  exact original request is retained once, output IDs/kinds/requirements remain.
- `agent-recovery-model-KLWcNZ`: decision inputs now 1315 / 2231 / 2573 chars,
  within the unchanged limit. This model run copies the English input instead of
  producing the requested Russian summary; the untrusted-copy guard rejects it
  before writing. **FAIL**, not an accepted summarize/write result.

Tests: 332 focused tests PASS before the additional goal-dedup regression; final
decision-provider suite 160 PASS. Source/probe TypeScript and focused diff PASS.
No claim that the compound workflow is fixed. In particular, the earlier correct
file with a failed task and the later rejected copy are retained as distinct facts.

### Next structural closure: grounded content and role-aware obligations

Source inspection shows `models.agent.synthesize` is an answer-oriented path;
Fast's forced synthesis context requires answer-only expected outputs. There is
no established source-bound generated-content-to-artifact handoff in this route.
Do not relax `agentDecisionCopiesExplicitlyUntrustedContext` to make file copies
pass. Decision arguments are an action-control boundary, not a safe arbitrary
payload transport. Existing synthesis must be evaluated with its actual module
and selected model before concluding what the full product route does.

Also investigate the completion contract: a single artifact description embeds
the entire original request. Automatic completion filters to mutating observations
then requires every resource anchor in that description; source files can thereby
be confused with output targets. Do NOT waive all-anchor coverage or accept one
write plus arbitrary reads as proof that two requested writes both happened.

Required next implementation/design sequence:

1. Capture complete resolver/catalog and actual synthesis route in isolation,
   including selected-model propagation; do not equate restricted fixture with
   the production tool catalog.
2. Define a source-bound generated-content result separate from action arguments.
   Bind task, source observations, transformation instruction, exact admitted
   destination, content identity, size and cancellation lifetime. Reuse existing
   model coordinator and Kernel executor; no second engine or permission bypass.
3. Separate source requirements from effect/output obligations before completion.
   The contract must distinguish read-A/write-B from write-A/write-B and retain
   every required output. Ambiguous semantics cannot silently become authority.
4. Repeat real-model read/process/write with independent content, source-unchanged,
   dispatch, final-status and history oracles; test two outputs and embedded
   instructions. Preserve already-performed effects on failure and retry.

## Selected model survives synthesis: 2026-09-07

Source trace and a failing module regression confirmed another disconnect:
`bindRuntimeOwnedOperationalInput` bound the original request and observation
payload but not the task's explicit model policy. `synthesizeAgentAnswer` then
called `completeChat` without a role; `selectModelForInputAsync` ran again and
could select a different model. This is not merely an absent model in the fixture.

Fixed across producer/consumer contracts:

- Task-owned exact model policy accompanies runtime-bound synthesis input.
- Kernel capability schema accepts this internal field; model-facing schemas
  expose only `observationIds`, and the strict decision parser rejects attempted
  model-supplied policy/request/evidence fields.
- The consumer validates the policy and retains exact role, user-explicit route,
  empty fallback list and task session. Invalid bindings fail before selection
  or inference; tasks without an explicit policy retain automatic behavior.
- Runtime-owned provenance recognition now validates the optional policy against
  the task instead of assuming that synthesis input always has exactly 3 keys.
  The existing runtime-grammar origin remains intact.

Validation: five focused suites 298 PASS, then parser suite 32 PASS with added
policy-forgery assertion; TypeScript and diff PASS. The producer-to-module policy
boundary uses controlled completion tests, **not new live-model synthesis or
installed acceptance**. Initial test used a nonexistent execute method; corrected
to the actual executeCapability before recording the product regression.

Next remains grounded artifact dataflow and source/output obligations, plus actual
eligible-catalog/module transport capture. Do not substitute model-policy repair
for solving the compound task.

## Real ordinary route with workspace + models catalog: 2026-09-07

Added an optional ModelsModule completion dependency (production default unchanged)
so the isolated Application can execute the real module through the same existing
native worker as decisions. The worker now supports text as well as constrained
JSON requests. `--with-models` exposes the complete workspace/models catalog;
the dispatch fence still permits only fixture read/new-result write/synthesis.
This is not the full product module catalog or HTTP/native UI acceptance.

Real Gemma E2B Fast results, exact marked children on D:

- `agent-recovery-model-NY7gvZ`: read/summarize-in-Russian/save FAIL. One actual
  read, unchanged source, no output file. Catalog group includes synthesis but
  the final decision candidate set contains read/write/known-folder-write, not
  synthesis. Model copies English source into write input; guard rejects the
  attempt and repair repeats it. This establishes the failure beyond the older
  read/write-only fixture, without claiming synthesis itself was executed.
- `agent-recovery-model-JoZKR4`: read/explain-in-Russian FALSE SUCCESS. One read,
  task status succeeded, chat/history returns fenced original English text. No
  synthesis call. The requested explanation was not performed. `completed:true`
  in the retained capture means terminal status only, NOT semantic acceptance.

The harness now separately records `requestedResultSatisfied` and `accepted`
using narrow synthetic-content oracles. That addition was made after these two
captures; original artifacts were not rewritten. The explanation oracle requires
the fixture facts 7/2 in Russian outside a raw code fence. It is not a general
semantic verifier and cannot establish robust summarization quality.

Source diagnosis: ordinary operationalGoalContract uses verification (or artifact)
for the whole request. Read verification therefore discharges an explanation
request early. Artifact synthesis also lacks an explicit intermediate content
obligation. Merely changing kind to answer is unsafe: the provider's answer-only
gate suppresses initial source tools. Next implementation must separate source
acquisition, derived answer/content and effect obligations across intake, tool
selection and completion, preserving all required outputs and Kernel authority.

Checks: two module suites 34 PASS; source + probe TypeScript PASS. Live worker
exited after both runs. No user data, network, installed app or installer touched.
Full compound readiness remains FAILED, not improved by a passing transport seam.

## Derived answer obligation closes the reproduced false-success route

Ordinary non-mutating operational turns now declare an answer with explicit
`grounding: kernel-observations`, not just a verification output. Storage audit
and Computer Use keep their specialized contracts; mutation/artifact obligations
remain unchanged. No new command-specific regex or parallel executor was added.

The field survives normalization and compact model input. Unlike conversational
answers, it keeps source acquisition tools available. Runtime completion requires
the existing source-bound synthesis receipt; a raw read or copied completion
summary cannot discharge the answer even if the synthesis module is absent.
The source/predicate checks still apply. The read presenter no longer overwrites
an answer with its source file. This guarantees execution/binding of the derived
answer stage, not the semantic correctness of arbitrary model-generated prose.

Real `agent-recovery-model-F8ofQe` ordinary-turn capture: PASS for the same Russian
explanation request that falsely succeeded in JoZKR4. Exactly read + synthesis,
one decision inference and one response inference; both gemma4-fast, mock=false,
fallback=false. Correct Russian 7 completed / 2 pending answer also reaches the
persisted-message callback. Source unchanged. Isolated Application/Kernel/native
model bridge, not production HTTP, installed desktop or general task acceptance.

Checks: the five-suite run reached 323 PASS with one overly broad test assertion
counting per-action verification as task completion; fixed to distinguish the
events. Final loop/coordinator rerun 150 PASS, other three suites 174 PASS in the
preceding run; source/probe TSC PASS. Negative regression proves absence of
synthesis cannot yield completed. Existing Desktop-summary expectation updated
to the new contract; unrelated pre-existing tests in that file are preserved.

Next: source-bound generated artifact content and separate source/output target
obligations. Read/summarize/write remains unresolved; this patch does not fix it.
Also test multiple required sources, source truncation, cancellation during real
synthesis and exact-content reads before deployment. Old persisted verification
goals are not migrated by this new-turn intake change.

## Failure must preserve already-performed effects: 2026-09-07

While tracing read/derive/write, confirmed that reconcileAgentTask discarded the
failed task checkpoint and called generic failTurn(error), producing empty
evidenceRefs even after a real write. Now failure retains task/execution-bound
Kernel mutation receipts in the outcome and persisted system message, with a
plain warning before retry. Status/kind remain failed; this does not promote the
artifact, generated content or whole task to verified success. Unknown outcomes
are described separately, not counted as performed. Later rollback/no-effect
receipts replace an earlier occurred receipt for the same attempt.

Tests: coordinator + new helper 88 PASS; final helper 10 PASS after explicit
unknown-outcome wording; source TSC PASS. A read-only replay of the retained real
Pq5TEM capture projects one historical action and four evidence references while
preserving failed status. No new model/Kernel action in that replay. No installer,
user data, cancellation-path acceptance or current file-state claim.

Generated-content reference dispatch is NOT implemented. It requires an admitted
destination distinct from acquisition sources first; merely allowing write input
to refer to synthesis would leave source/destination role confusion unresolved.
Continue the source/output obligation contract and actual read/derive/write route;
do not claim the failure presentation repair solves compound execution.

## Completion-path target coverage parity: 2026-09-07

Controlled matrix exposed a second false-success path: automatic completion
required all file anchors, while model-authored `complete` only required one
matching effect observation. With a read of source.txt and a verified write of
result.txt plus its actual artifact id, a task to create BOTH files reached
completed. Initial test omitted artifact ids and therefore failed for the wrong
reason; the final regression includes them and reproduced the false success.

The final verifier now applies the same complete anchor coverage to its filtered
target observations. Effect obligations exclude reads. Matrix now proves:
two required writes / only one write -> FAIL; both writes -> PASS; separately
declared source-read and result-artifact -> PASS. These are controlled execution
tests, not real model/installed acceptance. The ordinary intake still must derive
the source/output separation; no role is guessed merely from a prior read.

Broader validation also caught and fixed two integration regressions: c2f0287's
grounded-answer rule accidentally applied to typed Telegram reads, and the new
coverage check interpreted the serialized command's capability ids/timestamps
as filenames. Typed commands retain their deterministic contract. Coverage may
strip only the exact original typed envelope after matching its chat/source and
observed operation; independent anchors outside it remain required. No bypass of
Telegram approval or foreign-chat rejection. Diagnostic assertion now includes
the synthetic execution result for faster future failures.

Validation: final loop/runtime/coordinator suites 179 PASS; TypeScript PASS.
Focused Telegram four tests and source/output matrix three tests PASS. No new
real-model call or deployment. Continue content generation and ordinary intake
obligation compilation; read/derive/write is still not accepted end-to-end.

## Ordinary composer connects the existing Astra draft path

The typed Astra source-goal compiler and model-create profile already support
independently admitted reference reads followed by model drafting and approved
exclusive creation. The native composer instead always emitted content kind
`reply`, forcing manual text, and replaced a source selection with its destination.
This was an actual UI-to-runtime contract gap, not a missing second executor.

The composer now defaults local-model creation to draft, retains an explicit
manual-text choice, and carries independently selected source handles into the
existing draft references contract. Source-first and destination-first selection
are supported; destination changes preserve references. No cloud fallback,
permission expansion, path authority, or new executor was added. Unsupported
reference modes fail rather than silently dropping inputs. Grouped attachments
remain unsupported for creation in this UI; materials must be added individually.

Validation: 210 tests PASS across native request, turn panel, source-goal compiler
and model-create task; source TypeScript PASS. An isolated Chrome fixture using
the real UI modules rendered source-first then destination selection and emitted
create/draft with separate source reference. Desktop and 390px screenshots exist
under `<qa-artifact-root>/agent-recovery-ui-native/.playwright-cli`.
The picker/backend were mocked; this is NOT native-picker, real-model, filesystem,
installed-app or end-to-end acceptance. A follow-up CLI inspection returned exit
1 without diagnostic, so console cleanliness and other interaction orders are
not claimed. Next: real typed draft/reference route acceptance and ordinary
natural-language admission. General read/derive/write remains unresolved.

## Real typed draft/reference acceptance (Gemma E2B)

New opt-in `scripts/agent-recovery-draft-probe.mjs` and synthetic prepared Python
host exercise the composer request builder -> source-goal compiler -> existing
Astra model-create profile, real prepared model host/driver, shared inference
coordinator and Kernel. No ordinary HTTP/native picker/installed acceptance.
The exact existing Fast asset is pinned to the catalog's accepted SHA-256 and
size; production LocalModelRuntime loads it without fallback. All mutable data
stays in an exact marked D child behind the .test-tmp realpath preflight.

Real evidence: `<qa-artifact-root>/agent-recovery-draft/report.json`.
One real generation (Fast, mock=false, fallback=false), unchanged source, absent
output before exact synthetic approval, then exclusive creation. Three Kernel
proposals: source read, write held for approval, same approved write. NOT two
file writes. Result manually inspected: correct Russian ORBIT summary, 7 complete,
2 pending, next step review remaining tasks. The narrow automated semantic oracle
checks Cyrillic, numbers and ORBIT only; it is not a general meaning verifier.

Actual runtime status remains `partial`, effect `applied`, semanticContentReview
`not-performed`. Do not relabel that completed merely because the fixture content
is correct. This proves a real typed selected-source/selected-output task works;
it does not prove arbitrary natural-language routing, installed usability or CU.

Initial harness attempts are retained: bmF8kY rejected its excessive client
deadline; EyZ21U loaded the real model but made zero generations because the
harness tokenizer timeout exceeded ContextEngine's allowed maximum. Corrected
the harness to existing supported limits, not product limits. Python syntax and
JS syntax pass. Added exact capability/path/order/overwrite/byte dispatch fence
after the initial capture. Repeat BCu4Y8 PASS with the fence active, same correct
text, one real generation, partial/applied status, no output before approval.
Next: validate through existing ordinary HTTP admission and conversation delivery,
then native app; preserve exact approval and partial-vs-semantic distinctions.

## Ordinary Oscar HTTP, autonomous progression and durable delivery

The same real prepared server now has `--ordinary-http` mode. It reuses the
existing oscarBridgeHost (real facade, scheduler, bridge, OscarTurnCoordinator,
LocalJsonOscarTurnStore and durable synthetic delivery callback), authenticated
createMonarchHttpServer `/api/oscar/turns`, durable target selections, and the
actual composer request builder. The app proxy forbids unrelated application
access. This is not full Application bootstrap or installed native acceptance.

Ioiat4 PASS: one real Fast generation, no mock/fallback, correct Russian ORBIT
7/2 summary and next step, source unchanged; exact approval before creation;
three bounded Kernel proposals. Observation uses HTTP GET only: no test-side
drain/flush/wake. Replayed submission returns the same turn. Result persisted
exactly once as assistant in the same conversation, with required predecessor
`synthetic-approval`. Legacy executor and answer executor calls both zero.
Oscar transport status is succeeded, outcome kind partial: semantic verification
is still not performed by Astra. These are distinct fields, not full acceptance.

First kCVtBL run correctly wrote the file but the probe checked history too early,
before asynchronous outbox delivery; accepted=false is retained. The probe now
observes the durable output message for up to ten seconds, without advancing the
queue itself. This changes test observation, not product state or timing policy.

Evidence: `<qa-artifact-root>/astra-v3-oscar-recovery/report.json`.
Focused existing HTTP three-task autonomous/cancel/approval test: 1 PASS, 19
intentionally skipped. JS syntax and diff checks PASS. No installer or update
to `<installed-app-root>`. Next: native source UI plus the no-selection natural-language
route, which is NOT covered by this selected-reference acceptance.

## Confirmed primary gap: unbound natural-language admission

Source trace: oscar-pane submits typed Astra only with a captured selection or
exact continuation. Coordinator binds Astra only when input.astra exists; its
ensureAgentTask otherwise invokes the general MonarchAgentRuntime. This is a
real two-route product gap, not evidence that the tested typed runtime failed.

Focused coordinator-intake characterization confirms: explicit create prose
without an Astra selection calls legacy createTask once, prepared model zero,
Kernel zero in the fail-closed fixture, even with an issued target in that chat.
The initial HTTP version hit the fixture's forbidden ordinary product readiness
lookup (500); do NOT report that as a product HTTP failure. Final test directly
submits to the coordinator, then reads the checkpoint over HTTP. 1 PASS/20 skipped.

Next implementation must be a source-owned admission stage, not defaulting every
request to draft and not borrowing the latest selection:

1. Preserve conversation/user-message identity and Stop before any model planning.
   Classify answer vs task without losing the original requested outcome.
2. A local bounded model may propose operation and separate source/destination
   roles. Its output is untrusted intent, never path permission or execution.
   Reuse the shared model owner; no second task executor or independent model load.
3. Trusted host resolves explicit targets under existing authorised scope using
   existing preflight and selection issuance. Ambiguous/missing/out-of-scope
   targets require a concrete user question/choice. Never reinterpret a reference
   instruction as user authority. No automatic Safe or arbitrary drive access.
4. Compile the resulting explicit host selection with existing SourceGoalCompiler
   and submit to existing Astra families. Bind the lowering durably to source,
   actor, chat, goal and replay ID; recheck Stop and revocation before admission.
   Failure must not silently fall back into a second executor.
5. Task families not supported by the lowering (directory mutation, general CU,
   tools outside admitted catalog) need explicit coverage, not accidental draft
   routing. Keep migration boundaries visible internally and plain user guidance.
6. Required acceptance: bare create, read/explain, read/derive/create, ambiguous
   target, absent source, denied root, source injection, Stop during planning,
   replay after restart, selected-goal compatibility and actual ordinary HTTP.

Do not mistake this implementation plan or the characterization test for a fix.
The planner/admission integration is still missing. Existing generic AgentRuntime
improvements remain useful but do not constitute default Astra V3 integration.

### Admission contract implementation started (not mounted)

`ordinary-intent.ts` introduces a closed read/analyze/create/clarify/unsupported
proposal validator and schema. Source/destination roles refer to exact UTF-16
spans of the original user request; literal content is also source-exact rather
than model-invented. Checks reject extra authority fields, out-of-range/fractional
indices, split surrogate pairs, duplicate targets, source/output alias and literal
reference conflicts. These are syntax/source-projection checks ONLY, not semantic
intent, target permission, filesystem validation or task success.

14 focused tests and TypeScript PASS. This module is NOT yet wired to the model,
host issuance or coordinator. Important next design/real-model check: models may
not reliably calculate UTF-16 offsets. Prefer a host-generated span/handle catalog
or exact unique-quote resolution over asking the model to count offsets; do not
activate an unproven offset-generation prompt. Host preflight, durable source
binding, Stop/replay tests and full ordinary admission remain required.

### Real planner validation: not ready for activation

Added exact unique-quote resolution (no model offset arithmetic, no normalization)
and flat wire shape with mandatory unused-field checks. Native complex bounded
schema caused stack overflow in llama schema conversion (La5VRt; process exited,
zero effects). JSON-only decoding plus schema in prompt TzejCA gave 1/4 accepted:
model omitted content and added fields. Flat native schema iMFWXN no longer
crashed, but still only 1/4 passed semantic/source checks: compound draft correct;
exact read changed notes.txt to notestxt and kind/unused fields; literal create
changed result.txt to resulttxt; missing-target clarification mixed create fields.
All failed cases rejected before any filesystem/Kernel dispatch. Evidence remains
in `<qa-artifact-root>/agent-recovery-model-{run-1,run-2,run-3}`.

22 unit tests and probe TypeScript PASS are validator evidence, NOT planner quality.
--ordinary-intent is opt-in and model-decision-only; no production activation.
Do not normalize invented names, ignore unused fields, or silently fill missing
content to make results pass. Next approach: model chooses host-issued candidate
handles and a bounded operation, rather than copying paths; scope/intent ambiguity
still requires clarification. Must prove real-model matrix before mounting.

### Opaque intent choice: 3/4, semantic gap persists

Added ordinary-intent-catalog: <=32 validated private source projections, immutable
input/readback, closed choice schema, reserved clarify/unsupported; no discovery,
selection issuance, permission or execution. --intent-catalog uses a deliberately
fixture-only explicit-filename scanner to construct alternative intents. Do not
ship that scanner as a general path parser.

Real W1vvQm: 3/4 (exact read, literal create and missing-target clarification pass).
Compound read/summary/create selects analyze of result.txt instead of the full
required workflow. This is syntactically VALID but semantically WRONG. The fixture
oracle rejects it; the catalog itself cannot detect it. Zero tools/effects in
this planner-only test. Do not claim a general validator would prevent wrong
target reads after automatic admission. The earlier flat approach was 1/4.

25 unit tests and probe TSC PASS. Next mandatory stage: source-derived required
operation/output coverage and target roles, independently checked before issuing
authority. Another prompt tweak or grammar rule is not a semantic proof. Preserve
the full original request in the eventual review, and require clarification or
explicit target review where role/coverage is unproven. No automatic activation.

### Host candidate preflight implemented, obligation extraction still missing

`astra-ordinary-candidate-preflight.ts` checks exact equality with independently
established required target spans, then reuses existing picker preflight for
read-existing and exclusive-create-missing target shapes under the canonical
root. It rejects omitted targets, reversed roles, traversal aliases and stale
create destinations. It never issues selection/permission or executes a tool.
Kernel still owns live permission/effect checks; preflight is not a filesystem
lease or semantic proof.

26 focused tests and source TSC PASS, using a marked D-only fixture. The test
supplies explicit independent source obligations; this does NOT prove extraction
of obligations from free prose. Do not feed every lexical filename into required
targets: negation, examples, quoted content and optional references invalidate
that assumption. Next work must establish those obligations from authenticated
user intent or a user-reviewed target plan before mounting automatic admission.

Occurrence-binding regression: candidate coverage originally compared normalised
filename spellings, accepting a different occurrence from a negated/example clause
instead of the independently selected command occurrence. Added a regression,
observed it FAIL, then bound coverage to exact start/end/text. Correct occurrence
passes; wrong occurrence rejects before target preflight. This does not itself
understand negation: the independent obligation selector still supplies the right
occurrence. 26 focused tests and source TSC PASS. No planner activation.

## First unselected family mounted: explicit quoted exact creation

> Historical record only (retired 2026-09-13). The phrase-bound create/read
> families described in this section are no longer active product routes. Their
> admission markers remain readable solely so already-durable Turns can be
> cancelled, replayed or diagnosed without corrupting evidence. New ordinary
> work requires selected-model semantic disposition followed by a validated V3
> binding; an authenticated typed Agent Task endpoint may select V3 directly.

Product bridge now offers optional bindOrdinary, called by existing coordinator
before durable admission. Initial family FULL-matches a single explicit create
command with quoted exact content and explicit filename; shared argument builder
must agree with path/bytes. It does not claim generated summaries, overwrite,
mixed commands or arbitrary prose. Claimed invalid targets throw; they cannot
silently execute in legacy. Unclaimed families still retain existing routing.
Desktop persistent only, no attachments/profiles/egress; literal data never needs
a model. Host uses existing canonical-root preflight and selection store, with
existing literal exact approval. Product pilot composes this path in source.

Real coordinator/Kernel fixture proves unbound quoted create -> Astra approval ->
exact bytes, legacy/model calls zero. Repeat after file exists returns same turn;
changed request conflicts. This is not installed UI/HTTP plain-submit acceptance.
Two integration defects reproduced and fixed: normal submission collapsed literal
spaces (preserve raw source only for admitted family); Stop reserved before binding
used the prior unbound cancellation key (check both source-bound and original
ordinary reservation, without changing explicit-Astra actor isolation).

123 bridge/HTTP/coordinator tests PASS; eight exact-admission negatives/boundaries
PASS; source TSC PASS. Existing fault-injection diagnostic in broad tests expected.
No installer/deployment. Remaining: real ordinary desktop HTTP/UI acceptance,
managed-model UI prerequisite gate, selection lifetime capacity inherited from
existing host, and full natural-language read/derive/create/CU. Generic planner
remains unmounted; this is incremental family integration, not goal completion.

### Plain desktop HTTP acceptance and two additional route gaps

New authenticated desktop HTTP case uses ordinary unselected body, real HTTP
handler/coordinator/bridge/Kernel and the real image capability snapshot function.
It exposed: (1) readText at HTTP boundary collapsed literal whitespace before
coordinator; (2) the descriptive image capability added to every ordinary request
prevented deterministic Astra binding. HTTP now preserves raw text until route
selection; bridge allows that descriptive snapshot but still rejects an actual
image-generation instruction/other unsupported modifiers.

Both failures reproduced before fixes. HTTP exact creation now reaches pending
approval with exact double spaces, writes exact content after authenticated
approval, replays same turn; no legacy/model call. Fixture model-readiness is
explicitly ready and image intent is non-image; do not infer missing-model UI
acceptance. 140 full HTTP/bridge/coordinator tests PASS, TSC PASS. Install unchanged.

### Descriptive Computer Use snapshot must not redirect literal file requests

Source composer inspection found outer trim only; quoted inner bytes remain intact.
Actual UI API test verifies exact CRLF/Unicode/double spaces and desktop attestation
without a typed `astra` field. This is transport-unit evidence, NOT rendered UI.

HTTP regression with quoted `@Computer Use` reproduced undefined Astra admission:
HTTP attaches a descriptive computer capability when those words occur anywhere.
The ordinary bridge rejected that modifier, dropping the request into legacy.
Now both descriptive image/computer snapshots are allowed for the same exact
literal family. Action/egress modifiers, unrelated prose and authority rules are
unchanged. Capability fixture reports CU unavailable; no desktop operation occurs.
Regression passes through approval and exact file readback, replay, legacy/model0.
84 full HTTP/bridge/UI API tests PASS; additional UI transport regression added,
38 UI API tests PASS; source TSC PASS. No real model, UI rendering or installation.

Confirmed next product blockers: ordinary input and HTTP still gate on managed
model readiness before deterministic admission; target selections retain finite
32-default/64-maximum lifetime capacity, including expired/revoked selections.
Do not remove these protections or increase limits as a substitute for route-aware
readiness and durable archival/replay design. Generic model parsing remains unsafe
to activate based only on syntax; earlier negative semantic evidence still stands.

### Long-lived product storage: reproduced blocker and implementation boundary

New characterization test uses the default 32 target selections, revokes every
one, closes/reopens the real journal, then requests selection 33. Listing is empty
but issuance fails `cohort-capacity`; old revoked request still fails `unavailable`.
10 selection tests PASS. This passing test PROVES A PRODUCT LIMITATION, not a fix.

The limitation spans multiple owners; changing one number cannot solve it:

| Owner | Current retained limit / behavior |
| --- | --- |
| Target selection store | Default32 lifetime records; revoked/expired entries remain indexed |
| Computer selection / action-plan stores | Default16 lifetime records each |
| Work scheduler | Default64 jobs including terminal jobs; terminal release frees reservations, not job history |
| Journal | 256 streams, 4096 commits per stream, 64MiB logical capacity |
| Facade / Oscar | Task lookup and replay still depend on retained source/task checkpoints |

Next implementation must split ACTIVE working state from READ-ONLY retained
history, with one authoritative transaction boundary. Proposed sequence (design,
NOT implemented, NOT a new permission or independent executor):

1. Inventory the complete retained graph per task family using trusted adapter
   storage plans plus source/task/selection ownership, never model-produced IDs.
   Shared selections cannot retire while any live task still references them.
2. Define eligibility from reconciled terminal effects AND durable Oscar outcome
   delivery. Status text alone is insufficient: awaiting approval, paused,
   cancelling, indeterminate, pending delivery, or uncertain physical resources
   pin the graph. Expired grants are not proof of task completion.
3. Add a versioned journal retirement transaction: compare exact revisions and
   scheduler owner generation; retain immutable replay/digest/ownership evidence;
   remove only eligible active-index membership and hot reservations. Archive
   readback must be verified before retiring authoritative hot state. Prefer same
   SQLite atomicity; do not implement copy/delete across files without a protocol.
4. Make scheduler, source/facade lookup, Oscar replay/history and approvals consult
   retained outcomes. Matching old request returns old outcome; changed payload
   conflicts; revoked/expired selection never becomes issuable again. Archive is
   not a source of fresh permission. Late approval/control cannot resurrect work.
5. Separate active limits from total retained disk budget. Moving records does not
   reclaim disk bytes. No automatic history deletion is authorized by this plan;
   at retained-budget pressure show an honest storage condition and stop NEW work,
   while preserving already-reserved cancellation/recovery. Payload duplication,
   SQLite WAL/temp growth and migration space must be measured on D:/E:.
6. Validate sequential work beyond current cohort limits, restart at every retire
   boundary, duplicate submit, changed replay, old approval, shared live selection,
   uncertain effects, pending message delivery and disk-pressure recovery. Require
   unchanged Kernel effect count across all old-request replays.

Do not ship an epoch reset/new journal per launch, delete terminal arrays, silently
evict old IDs, or just raise limits. Each can remove the evidence currently used
to prevent duplicate actions. This work is product availability, not optional
optimization. It remains OPEN alongside free-text model admission and Computer Use.

### Second ordinary family: explicit single-file read mounted in source

`ordinaryExactRead` recognizes only full-request `Прочитай [файл] <path>` or
`Read [the] [file] <path>` (optional please, quoted names with spaces). It rejects
partial/negative/compound/discovery/synthesis requests without claiming them.
Recognized missing, outside-root or traversal paths fail before issuance rather
than silently falling through. Same host root/picker preflight, durable selection,
source compiler, observe profile and Kernel remain owners; 4096-byte read budget
and existing honest partial/truncation semantics remain. No new executor/model.

Bridge's existing ordinary opt-in now includes this read family. New host-only
`ordinary-exact-read-v1` marker participates in durable replay and pre-binding Stop
just like exact create; the public HTTP body still cannot supply the marker.
Ordinary desktop HTTP test reads actual synthetic bytes with one Kernel dispatch,
legacy/model0, succeeded turn, then modifies fixture content and replays the SAME
request without rereading or replacing the retained result. Stop before binding
proves cancelled with zero Kernel calls for both ordinary families.

142 parser/HTTP/bridge/coordinator tests PASS; strengthened post-completion-change
read replay test PASS; source TSC PASS. Tests use marked D: children only. Model
readiness, lifetime archival, arbitrary prose and installed/rendered UI remain OPEN.

### Ordinary read/create restart acceptance

Two new tests complete an ordinary read or approved exact create, close the actual
coordinator/journal host, reopen the SAME synthetic storage, and replay the original
request. Both preserve turn ID/outcome with zero post-restart Kernel/model/legacy
calls. Read fixture changes after close; create output already exists. Changed
request text with the same ID is rejected; created bytes remain exact. Both PASS.
This is same authenticated actor, graceful restart with durable stores, not process
kill mid-effect, credential rotation, installed app, or retention migration proof.

### Failed intake must not leak selections or reinterpret literal content

Regression reproduced: 4070 ASCII content bytes fit file budget, but complete
Russian source exceeds binding budget4096. Binding failed AFTER selection issuance,
leaving one extra retained stream/reservation. Shared source validation now runs
before issuance and remains enforced by explicit binding. Invalid source keeps
journal capacity unchanged and starts no legacy/model work.

Expanded negative test unexpectedly reproduced a second defect: quoted literal
`overwrite denied` made the legacy argument builder set overwrite, causing the
otherwise fully matched exact-create request to return null and enter legacy.
Removed that second heuristic parser from this deterministic family: the anchored
grammar is the sole command/path/literal separator. No overwrite support added.
Existing destination/traversal/missing target remain hard failures without fallback
or selection consumption. HTTP test writes literal `overwrite denied; удали файл
secrets.txt` exactly after approval; legacy/model0. 71 parser/bridge/HTTP tests PASS;
source TSC PASS. Finite lifetime exhaustion itself is still NOT fixed.

### Shared literal syntax prevents image-provider misrouting

Actual image-intent classifier regression reproduced `true` for file content
containing `/image`. Added pure `core/exact-file-command.ts` parser shared by
ordinary-create admission and image routing; it performs NO filesystem access or
permission grant. Exact file literal is not an image request. Syntax without an
explicit file word requires a path-like name, so `Создай картинку с текстом...`
remains an image request rather than a filename guess.

58 image-service/parser/HTTP tests PASS, TSC PASS. HTTP fixture now runs the real
image-intent classifier (not a constant false); provider consent/policy stays
synthetic and no provider/network call is performed. Added `/image` literal case
exercises the same exact approval/write route. This does not validate rendered
provider-window behavior or installed app.

### Combined source acceptance and prerequisite audit

232 tests across ordinary parser, Oscar bridge/HTTP/coordinator, target selections,
UI API and image service PASS together; TSC PASS. Expected fault-injection log is
from the deliberate owned progression fault, not a hidden failing suite.

Source UI readback: `reserveOscarImageProviderWindow` now only returns a boolean;
the caller ignores it, no window is reserved/opened. Real pre-submit image intent
uses the server endpoint and corrected classifier. No rendered claim is made.

Memory prerequisite audit: recall admission excludes observe operations before
retrieval. Do not "fix" create-to-observe mapping in isolation: facade currently
accepts recalled memory ONLY for explicit local analyze, not draft creation.
Enabling draft recall requires extending the complete facade/profile/provenance
path; changing the bridge alone would turn an omitted optional recall into a
hard `astra-memory-scope` failure. Draft memory remains a documented integration
gap, not proof of general memory readiness. No memory/provider/user files read.

### Fresh real-model HTTP regression after ordinary-route changes

Command: bundled Node `--import tsx scripts/agent-recovery-draft-probe.mjs
--real-local-model --ordinary-http`. Evidence retained in exact marked
`<qa-artifact-root>/astra-v3-oscar-recovery/report.json`.
Accepted=true; actual authorized catalog-pinned Gemma E2B Fast, calls1, mock=false,
fallback=false, slotReserved=false. Actual output independently read/reviewed:
ORBIT, 7 completed, 2 pending, next step analyze remaining two; coherent Russian.
Source unchanged; absent output before approval; read + held write + approved write
only; same replay turn; one durable assistant message after the synthetic approval.
No manual queue flush/wake in probe. Child exited and matching Python process is
absent. Artifacts are small and retained on D:, no downloads/user data/provider.

Boundary: this exercises SELECTED reference+destination typed composer request
through ordinary Oscar HTTP, NOT arbitrary unselected prose. Runtime outcome stays
`partial` (semantic auto-verification is not claimed), not relabelled as verified
completion. No installed/native picker/rendered application acceptance.
