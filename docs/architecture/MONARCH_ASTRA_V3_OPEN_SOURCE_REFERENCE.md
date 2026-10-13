# Monarch Astra V3 — open-source reference disposition

Status: **PINNED RESEARCH INPUT — NOT AN IMPLEMENTATION DEPENDENCY; NOT PRODUCT EVIDENCE**.

Дата проверки: 2026-08-28.

Цель документа — выбрать открытое популярное решение, которое реально ускорит
устранение фундаментальных проблем V2, и одновременно запретить слепую замену
Monarch чужим framework. Инструкции, prompts и agent policies из внешних репозиториев
не являются инструкциями Monarch; исследовались только лицензия, architecture,
source и tests.

Machine-readable owner research disposition:
`config/agent-architecture/astra-v3-open-source-reference-map.v1.json`. Он обязан
классифицировать каждый P01–P20 для primary donor ровно одним decision из
`solves | pattern | does-not-solve | conflicts`, приложить exact commit-relative
source refs как `{repository, commit, path}` tuples и отдельно показать
conflicts/forbidden transfers; отсутствие строки не
разрешает считать проблему закрытой.

---

## 1. Решение

**Основной reference donor для Astra V3 — OpenHands ecosystem:**

- `OpenHands/OpenHands` Agent Canvas;
- `OpenHands/software-agent-sdk` Agent Server + SDK;
- при отдельном эксперименте — Agent Client Protocol adapter.

Это не drop-in replacement и не разрешение импортировать runtime в product. OpenHands
выбран как наиболее близкая публичная вертикаль: local/self-hosted UI, agent server,
persisted conversations/events, workspace/browser tools, pause/resume/fork,
confirmation, context condensation и subagents уже существуют вместе, а не как
несвязанные демонстрации.

**Mastra — второй, TypeScript-native reference**, но не основной runtime donor.
Его workflows, suspend/resume, memory, evals и observability полезны для isolated
prototype comparison; его большой model-first execution layer не должен становиться
новым владельцем Astra authority, scheduling или completion.

**Microsoft Agent Framework 1.16.0 — выбранный дополнительный structural donor**
для Workflow Runtime и Recovery Coordinator. Он не заменяет OpenHands: OpenHands
остаётся главным vertical agent reference для conversation/event/context/tool seams,
а Agent Framework даёт более точные образцы deterministic executor graph,
superstep checkpoint lineage, graph-compatible resume, pending request correlation,
bounded convergence, cancellation и checkpointed subworkflows. Это наиболее прямой
открытый ответ на P03/P09/P10/P13/P14/P17, которого не хватало одному OpenHands.
Прямое включение Python/.NET runtime в Electron запрещено; переносим только проверенные
инварианты и fault cases.

**Temporal и LangGraph — semantic benchmarks**, а не зависимости первого release:
Temporal для durable workflow/activity/child/schedule semantics, LangGraph для
checkpoint/interrupt/task replay discipline.

Ни один из четырёх проектов не решает одновременно Intent Admission, локальный
RAM/VRAM scheduler, Kernel-only effects и requirement/evidence Completion. Эти owners
остаются собственными компонентами Astra.

---

## 2. Проверенный snapshot

Снимки получены из публичных GitHub repositories на `E:` и не входят в Monarch:

| Project | Popularity snapshot | License boundary | Pinned source |
|---|---:|---|---|
| OpenHands Agent Canvas | 85,383 stars | MIT | `b50c60c6728e2ce123ccb6e125bee3eb88ac87d1` |
| OpenHands Software Agent SDK | 1,039 stars; часть OpenHands ecosystem | MIT | `9a24f6c8866f353042a57df0514ccc900e3a0691` |
| Microsoft Agent Framework | 13,169 stars | MIT | `6d532cf77e26988fe2d822f13ddea021faa9d735` (`agent-framework-core` 1.16.0) |
| LangGraph | 40,606 stars | MIT | `d5f4b2aa960940effc8430165ab3604038e817af` |
| Mastra | 27,542 stars | Apache-2.0 outside any `ee/` directory; `ee/` has separate terms | `d4961b001dd5674888aa3cc2061a2ff4adc53079` |
| Temporal server | 22,579 stars | MIT | `b0e1e4dbdf924573ff16e643d87a5f56393f75dd` |

Popularity — только signal зрелости/community, не correctness proof. Внешние stars,
issues и `main` меняются; архитектурные решения ниже привязаны к commit snapshots.

Primary links:

- <https://github.com/OpenHands/OpenHands>
- <https://github.com/OpenHands/software-agent-sdk>
- <https://github.com/microsoft/agent-framework>
- <https://github.com/mastra-ai/mastra>
- <https://github.com/langchain-ai/langgraph>
- <https://github.com/temporalio/temporal>

---

## 3. Что перенимаем из OpenHands как pattern

Pinned SDK source anchors для Track A (commit
`9a24f6c8866f353042a57df0514ccc900e3a0691`):

- `openhands-agent-server/openhands/agent_server/conversation_lease.py`;
- `openhands-agent-server/openhands/agent_server/conversation_service.py`;
- `openhands-agent-server/openhands/agent_server/event_service.py`;
- `openhands-sdk/openhands/sdk/context/view/view.py` и `context/view/properties/`;
- `openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py`;
- `openhands-sdk/openhands/sdk/critic/impl/agent_finished.py`;
- `openhands-agent-server/openhands/agent_server/sub_agents_router.py`;
- tests `test_conversation_service.py`, `test_event_service.py`,
  `test_conversation_restore_behavior.py`, `test_agent_loading.py` и
  `test_workspace_pause_resume.py`.

Это provenance anchors, не разрешение копировать код. Любой перенос должен повторно
проверить exact license/header/dependency closure и записать copied-byte count.

| OpenHands mechanism | Что закрывает в Astra | Решение |
|---|---|---|
| Agent Canvas → Agent Server → SDK → workspace/tool split | Product Facade и удаление UI/runtime dual truth | **ADAPT**: сохранить один Astra Product Facade и тонкие adapters |
| typed Action/Observation events с `tool_call_id` | P02/P05, causal model view | **ADAPT**: Invocation/Receipt остаются Protocol-authoritative |
| event tree, active leaf, forked conversation | steering, alternate branch, child isolation | **ADAPT** после authority/budget intersection |
| conversation lease generation, takeover, pause/resume and disk rehydration | P03/P10 recovery | **REFERENCE**, но не копировать file lease как authority |
| context `View` properties: batch atomicity, action/observation matching, tool-loop atomicity | P11/P16 coherent compaction | **ADOPT AS INVARIANTS** в ContextPlan/Compaction profile |
| condensation as an event while raw history remains | bounded context without destroying source truth | **ADAPT**: Goal/authority/receipt/evidence never summary-owned |
| tool registry, workspace, browser, MCP/client tools | P06 and real vertical packs | **ADAPT** behind Catalog + Kernel, no direct authority |
| confirmation policies and persisted waiting state | approval UX and resume | **REFERENCE ONLY**; Astra Approval/Arm remains stricter |
| subagent registry, parent/fork links, stress tests | P17 child lifecycle and evaluation | **ADAPT** only with narrowing authority and shared GPU budgets |
| local/Docker/remote agent backends and ACP-compatible agents | optional external-agent interoperability | **LAB** behind non-authoritative Engine Driver |

Особенно ценен OpenHands context-view approach: удаление или compaction tool history
обязано сохранять целостный action/observation pair и весь batch одной model response.
Это становится обязательным инвариантом Astra, а не необязательной эвристикой.

---

## 4. Что запрещено переносить из OpenHands

1. **Agent-first admission.** Agent Canvas начинается уже внутри agent conversation;
   он не решает ошибочный `answer | execution` lane Monarch.
2. **FinishAction как truth.** `AgentFinishedCritic` доказывает лишь terminal action
   и non-empty git patch. Это не requirement/evidence certification и не заменяет
   Completion Certifier.
3. **Model step как universal planner.** Простые deterministic tasks Astra обязана
   выполнять без planning model call.
4. **File lease/persistence как готовую durability authority.** Snapshot использует
   wall-clock TTL, best-effort PID и temp-file replace; malformed lease трактуется
   stale, а Windows atomicity имеет ограничения. Astra сохраняет fenced CAS journal,
   Invocation/Receipt и measured SQLite/store gate.
5. **Dynamic tool import как permission.** Tool registration не даёт authority,
   claim templates, trusted provenance или Kernel admission.
6. **LLM summary как источник обязательных фактов.** Condenser может summary/truncate
   forgotten events; Astra хранит Goal, authority, approvals, receipts и evidence
   вне compact surface.
7. **Large service classes как target decomposition.** В inspected snapshot
   `conversation_service.py` ≈2838 lines, `event_service.py` ≈1945,
   `agent.py` ≈1496 и ACP adapter существенно больше. Astra не должна заменить
   один God-loop другим.

Machine disposition поэтому помечает P13 как `conflicts`, а не `pattern`: отдельные
event/lease/context seams полезны, но inspected `conversation_service.py` и
`event_service.py` одновременно воспроизводят риск крупного service owner.

---

## 5. Microsoft Agent Framework: дополнительный фундамент Workflow/Recovery

### 5.1. Почему выбран именно он

Fresh GitHub triage на 2026-08-28 сравнил живые открытые проекты по exact repository
metadata. Stars использовались только как popularity signal:

| Candidate | Stars snapshot | License | Итог для Astra |
|---|---:|---|---|
| Open Interpreter | 68,173 | Apache-2.0 | сильный computer-use reference, но direct machine execution конфликтует с Kernel-only authority и не даёт durable verified completion |
| Agno | 41,951 | Apache-2.0 | широкие agents/teams/workflows, но model-first leader loop сохраняет P02/P04/P13 |
| Letta | 24,473 | Apache-2.0 | сильный memory/context specialist; полезен для будущего отдельного Memory lab, но не закрывает workflow/effect/recovery core |
| Google ADK Python | 21,313 | Apache-2.0 | широкие session/event/eval patterns, но не даёт наиболее точный local crash/resume contract для Astra |
| PydanticAI | 19,549 | MIT | сильные types/evals и durable integrations, но основной durability owner вынесен во внешние engines |
| **Microsoft Agent Framework** | **13,169** | **MIT** | **выбран**: наиболее точное дополнение OpenHands по deterministic workflows, checkpoint lineage, HITL resume, cancellation и nested recovery |

Выбор не основан на максимальном числе stars. Самый популярный Open Interpreter хуже
совпадает с корневой задачей и создаёт опасный соблазн обойти Monarch Kernel. Agent
Framework выбран по покрытию незакрытых проблем и качеству inspectable recovery tests.
AutoGen отдельно отклонён: его официальный repository переведён в maintenance mode и
рекомендует новым проектам Microsoft Agent Framework.

Pinned snapshot:

```text
repository = microsoft/agent-framework
commit = 6d532cf77e26988fe2d822f13ddea021faa9d735
release = agent-framework-core 1.16.0
license = MIT
copied bytes = 0
```

На Windows/CPython 3.14.3 выполнен focused upstream slice: **19 passed, 0 failed**.
Он включает graph mismatch rejection, ровно один checkpoint на completed superstep,
cancellation active executor, rehydration pending request, сохранение child state и
отсутствие duplicate request после subworkflow resume. Это подтверждает механики
закреплённого snapshot, но не реализацию Astra.

### 5.2. Что перенимаем как clean-room invariants

| Mechanism | V2 problems | Нормативное влияние на Astra |
|---|---|---|
| deterministic function/executor nodes рядом с agent nodes | P09/P13/P14 | Workflow Runtime обязан выполнять простые и domain-owned steps без model planning; model не владеет всем графом |
| checkpoint после завершённого superstep | P03/P10 | checkpoint boundary фиксирует committed state, in-flight messages, executor state и pending requests; partial step не masquerade как committed |
| `previous_checkpoint_id` lineage | P10 | resume выбирается по причинной цепочке, а не по wall clock или одному iteration number |
| graph signature rejection on restore | P03/P10/P17 | checkpoint несовместимой workflow composition fail-closed; Astra расширяет binding до contract/policy/capability/model generations |
| typed data-plane/control-plane split | P08 | output, intermediate, status, request и terminal failure не смешиваются в одну строку UI |
| request ID + response handler + checkpoint rehydration | P06/P08 | ожидание tool/user decision является durable typed state, но валидность Approval/Arm повторно проверяет Monarch |
| bounded `max_iterations` and cancellation propagation | P10/P14 | каждый graph имеет явный convergence ceiling; cancel обязан останавливать active child/driver и переходить в typed recovery при ambiguous effect |
| nested WorkflowExecutor with internal checkpoint | P17 | child state сохраняется отдельно, resume не дублирует request; authority/model/context budgets при этом только сужаются Astra |

Exact source anchors:

- `python/packages/core/agent_framework/_workflows/_checkpoint.py`;
- `python/packages/core/agent_framework/_workflows/_runner.py`;
- `python/packages/core/agent_framework/_workflows/_workflow.py`;
- `python/packages/core/agent_framework/_workflows/_workflow_builder.py`;
- `python/packages/core/agent_framework/_workflows/_workflow_executor.py`;
- `python/packages/core/agent_framework/_workflows/_request_info_mixin.py`;
- tests `test_runner.py`, `test_checkpoint_validation.py`,
  `test_request_info_event_rehydrate.py`, `test_sub_workflow.py`.

### 5.3. Что запрещено переносить

1. **Прямую Python/.NET dependency или sidecar как Product Facade owner.** Monarch
   остаётся TypeScript/Electron local-first product; сначала clean-room semantics.
2. **FileCheckpointStorage как Astra truth.** Snapshot атомарно делает temp + replace,
   но допускает restricted pickle и не даёт Astra CAS/fencing, durable flush proof,
   protocol digest closure или encrypted private-state policy.
3. **Graph hash как полную совместимость.** Он связывает topology, но не доказывает
   версии Goal/Requirements, capability contract, policy, model residency, authority
   или effect semantics. Astra checkpoint binding должен быть существенно шире.
4. **Checkpoint как exactly-once внешний effect.** Replay после ambiguous dispatch
   всё ещё требует Invocation/Receipt/Action Ledger V2 reconciliation; повтор activity
   или tool call автоматически запрещён.
5. **Rehydrated request как действующее разрешение.** После resume Approval/Arm,
   policy/revocation и capability availability проверяются заново.
6. **`max_iterations` как completion proof.** Остановка цикла не доказывает Goal;
   terminal `verified` выдаёт только requirement/evidence Completion Certifier.
7. **Agent output как terminal truth.** Framework agent остаётся untrusted planner;
   deterministic executor также не может сам расширить authority.

### 5.4. Обязательный MAF reference lab

На isolated `E:` workspace тем же EvaluationManifest проверяются:

- deterministic three-node composite task без model planning;
- crash/resume до и после committed superstep;
- pending tool/user request resume без duplicate request;
- child checkpoint restore с сохранением state и parent correlation;
- rejection после graph mutation;
- cancellation active executor без leaked continuation;
- negative ambiguous-effect case: MAF checkpoint сам по себе обязан быть признан
  недостаточным без Astra Invocation/Receipt/reconciliation evidence.

Результат сравнивается с current V2 и будущим Astra Workflow Runtime по duplicate
effects, zombie state, model calls, context growth, resume correctness и false
`verified`. Upstream PASS не повышает `0/35 executable`.

---

## 6. Mastra: где полезен, где опасен

Mastra совпадает с Monarch по TypeScript/Node и даёт готовые primitives:

- typed agents/tools and structured response surfaces;
- deterministic workflows;
- suspend/resume snapshots;
- memory/processors;
- traces, token/tool metrics, scorers/evals;
- subagents/background tasks.

Это делает Mastra хорошим **isolated comparison lab** для Workflow Runtime,
observability и EvaluationManifest. Но прямое включение `@mastra/core` в Astra V3
до proof запрещено:

- agent loop остаётся model-first;
- core execution surface очень велик: inspected `agent.ts` ≈9116 lines и
  `loop/workflows/agentic-execution` ≈14.5k TypeScript lines;
- публичные issues показывают structured-output/routing, provider message-shape и
  background-subagent regressions — то есть классы P02/P11/P17 не исчезают от
  dependency;
- framework не владеет Monarch Kernel, local-model residency или Completion truth;
- `ee/` code нельзя смешивать с Apache-2.0 core без отдельной legal review.

Решение: не делать Mastra runtime owner. Разрешён bounded lab на трёх read-only
workflows с тем же EvaluationManifest, после которого отдельный ADR выбирает
`reuse | adapter | clean-room pattern | reject`.

---

## 7. Почему не LangGraph или Temporal целиком

LangGraph хорошо решает checkpoints, interrupts и deterministic/idempotent task
replay, но не даёт Monarch capability packs, Kernel authority, локальный model host
или доказательный completion. Его persistence не делает внешний non-idempotent
effect exactly-once автоматически.

Temporal является сильнейшим durability reference для Workflows, Activities,
timeouts/retries/heartbeats, child workflows и schedules. Но отдельный Temporal
server/worker stack слишком велик как неоценённая обязательная зависимость local-first
Electron product. Activity retry также требует idempotency/reconciliation внешнего
effect. Поэтому Temporal semantics включаются в fault matrix, а dependency может
рассматриваться только для optional durable jobs после отдельного footprint/installer/
offline/upgrade benchmark.

---

## 8. Обязательный OpenHands reference lab

Lab не запускается на Safe, production runtime, реальных ключах или пользовательских
данных. Он использует isolated workspace на `E:` и pinned snapshots.

### Track A — architecture extraction

- построить exact seam map OpenHands Event/Conversation/Context/Tool/Workspace;
- выписать state/event invariants и corresponding tests;
- сопоставить с P01–P20 и отметить `solves | pattern | does-not-solve | conflicts`;
- создать provenance ledger: pattern, source commit/path, Astra owner, copied code
  bytes (`0`, пока отдельный legal/import ADR не принят).

### Track B — black-box comparison

Одинаковый corpus выполняется через isolated OpenHands, Microsoft Agent Framework,
Mastra lab и current V2:

- exact workspace observation;
- known deterministic two-node workflow;
- context pressure with action/observation atomicity;
- pause/resume and crash before/after observable tool completion;
- bounded subagent read task;
- false-completion trap: search cannot prove download.

Измеряются model calls, input tokens, first-action latency, total latency, context
growth, resume correctness, duplicate effects и false completion. Результат не
становится Monarch release evidence: он выбирает patterns и baseline.

### Track C — ACP interoperability spike

Optional ACP driver может позволить Monarch запускать OpenHands/Codex/другой ACP
agent через единый UI. Но driver считается **untrusted planner/worker boundary**:

- Product Facade и Intent Admission остаются до него;
- Astra выдаёт только bounded Goal/context/capability handles;
- host filesystem/Safe/provider authority не наследуется;
- authoritative effects идут только через Astra Kernel client tools или в disposable
  isolated sandbox;
- external `finished` проецируется в completion candidate, не `verified`;
- cancellation, receipt, model-call and context telemetry обязательны.

---

## 9. Go/no-go

OpenHands pattern считается полезным только если он уменьшает минимум один measured
V2 failure/latency class без роста false `verified`, wrong effect или authority
bypass. Microsoft Agent Framework pattern дополнительно обязан уменьшить duplicate
resume/zombie/composite-workflow failures, но его dependency/sidecar не рассматривается
до отдельного TypeScript seam/footprint ADR. Mastra/ACP dependency принимается только
после footprint, packaged Windows, offline, local-model, cancellation, update/rollback
и license-boundary acceptance.

До этого точный статус:

```text
primary reference = OpenHands ecosystem
selected workflow/recovery complement = Microsoft Agent Framework 1.16.0
direct runtime replacement = rejected
product dependency = not approved
copied external code bytes approved = 0
pattern extraction + isolated comparison = approved architecture work
```
