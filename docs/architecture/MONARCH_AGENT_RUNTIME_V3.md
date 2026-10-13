# Monarch Astra V3 — целевая архитектура Agent Runtime

Статус: **CONVERGENCE ARCHITECTURE DRAFT — IMPLEMENTATION AUTHORIZED; FIRST V3 COMPONENTS IN ISOLATED VALIDATION; NOT PRODUCT-INTEGRATED OR RELEASE READY**.  
Исходный draft: 2026-08-24. Последняя архитектурная ревизия: 2026-08-26.  
**Текущий owner override, 2026-08-30:** разрешена реализация самой Astra V3 и напрямую
связанных компонентов, включая ранее отложенные из-за лимита. `src/agent-v3/` содержит
исполняемые journal/read/TaskGraph/context/decision компоненты; текущие доказательства
и ограничения — `MONARCH_ASTRA_V3_IMPLEMENTATION_STATUS.md`. Прежний запрет на саму
реализацию ниже является историческим. Default activation, native terminal authority,
production data migration, provider egress и release из этого не следуют.
Целевой общий релиз зафиксирован owner decision от 2026-08-26: **Monarch `0.3.0`**. Это номер release train, а не утверждение о готовности, составе enabled profiles, RC/Stable-статусе или разрешение реализации.  
Последний, третий frozen-source prose PASS 3 завершился `FAIL (P0=0, P1=5, P2=1)`. Текущий source содержит post-PASS3 corrections, но они не считаются independently closed; следующий review проверяет generated artifact/fixtures, а не запускает четвёртый prose pass.  
Связанные спецификации:

- `MONARCH_AGENT_PROTOCOL_V1.md` — нейтральные команды, события и state machines;
- `MONARCH_AGENT_RUNTIME_V3_MIGRATION.md` — совместимая поэтапная миграция;
- `MONARCH_AGENT_RUNTIME_V3_ADVERSARIAL_REVIEW.md` и `MONARCH_AGENT_RUNTIME_V3_EXTERNAL_AUDIT_DISPOSITION.md` — review/evidence ledger, не ABI;
- `MONARCH_ASTRA_V3_OPEN_SOURCE_REFERENCE.md` — pinned external pattern/provenance ledger, не authority и не dependency approval;
- `OSCAR_TURN_COORDINATOR_V1.md` — действующий interaction boundary;
- `OSCAR_AGENT_RUNTIME_V2.md` и `OSCAR_AGENT_RUNTIME_V2_IMPLEMENTATION.md` — действующий execution baseline;
- `OSCAR_ACTION_GUARD_V1.md` — действующая authority/approval модель;
- `OSCAR_COMPUTER_USE_V1.md` — действующий bounded observe/act/readback workflow;
- Cherry Studio comparative audit snapshot SHA-256 `24b630c84253e065461ba4a627e80552c7f0586ef159fac05325cc8869fd74ae` — local review source, но не implementation dependency; machine-specific path не является normative reference.

> Официальное продуктовое имя следующего Agent Runtime — **Astra V3**. `V3` обозначает поколение runtime-архитектуры и не является версией текущей persisted-схемы `monarch.agent-task.v3`, Protocol V1, будущего Execution Store V4 либо существующего модуля Astra Skills `0.1.0`.

Контракт именования:

| Имя | Точное значение | Не означает |
|---|---|---|
| **Monarch `0.3.0`** | целевой общий product release train | готовность релиза или включение всех Astra V3 profiles |
| **Astra V3** | официальное имя целевой Agent Runtime architecture family | что runtime уже реализован или что schema lab можно импортировать в product |
| **Astra Skills** / `src/modules/astra` | действующий `0.1.0` слой Agent Skills, карточек и slot preview | execution authority, новый runtime или доказательство реализации Astra V3 |
| Agent Protocol V1 | независимая версия wire/persisted ABI | product version либо persisted AgentTask generation |
| `monarch.agent-task.v3` | действующая persisted AgentTask schema | Astra V3 |
| Execution Store V4 / `monarch.agent-task.v4` | будущая storage generation, если её отдельно разрешат | автоматический cutover из-за имени Astra V3 |

Нынешний Astra Skills не переименовывается и не получает новых полномочий. В целевой семье он эволюционно становится одним из capability/skill discovery adapters: карточки и skill refs могут питать будущий `agent-catalog`/context profile, но Goal admission, authority, Kernel dispatch, evidence и completion остаются у владельцев Astra V3. Стабильные имена файлов `MONARCH_AGENT_RUNTIME_V3*` временно сохраняются как document IDs и исторические review anchors; заголовки и нормативная терминология используют Astra V3.

---

## 0. Нормативный статус и иерархия документов

1. `MONARCH_AGENT_PROTOCOL_V1.md` — единственный владелец wire/persisted ABI, canonicalization profile, command/event payloads и state enums.
2. Этот документ владеет invariants, trust/ownership boundaries и целевой dependency graph. TypeScript/JSON fragments здесь являются **неисполняемыми review snapshots**, не ABI. Schema closure не может копировать их вручную: они удаляются либо заменяются generated includes из Protocol package. При любом расхождении feature считается unavailable; ни один fragment не «побеждает» Protocol.
3. `MONARCH_ASTRA_V3_AGENT_CORE.md` владеет фундаментальной product closure: проблемной картой V2, обязательными agent services/capability packs, full-task quality и efficiency gates. Он не может ослабить Protocol, Kernel, Safe или invariants этого документа.
4. `MONARCH_AGENT_RUNTIME_V3_MIGRATION.md` владеет только cohort/cutover/rollback порядком и acceptance gates; он не может ослабить Runtime, Agent Core или Protocol.
5. `MONARCH_AGENT_RUNTIME_V3_ADVERSARIAL_REVIEW.md` и `MONARCH_AGENT_RUNTIME_V3_EXTERNAL_AUDIT_DISPOSITION.md` — доказательный review ledger, не нормативная спецификация.
6. `MONARCH_ASTRA_V3_OPEN_SOURCE_REFERENCE.md` фиксирует внешние patterns, pinned commits, license boundary и запреты переноса. Он не может дать стороннему runtime authority или заменить первые пять владельцев.
7. `MONARCH_AGENT_RUNTIME_V3_COPY_CANVAS.md` — генерируемый verbatim export. Его запрещено редактировать как source of truth.
8. После появления `protocol-definition.agent-core-read.v1.json` он является единственным machine-codegen input по Protocol §0.2; generated JSON Schema/TypeScript/rule tables являются только digest-pinned outputs. Generated output не может восстановить, заменить или исправить definition. Любое расхождение prose/definition/codegen/schema блокирует RFC; правило «более новый файл побеждает» запрещено.

Слова **MUST/обязан**, **MUST NOT/запрещено**, **SHOULD/следует** и **MAY/может** имеют RFC 2119-смысл. Описательный пример не создаёт обязательность, если не ссылается на normative rule/ABI.

Текущий status fence:

| Разрешено | Запрещено до отдельного gate |
|---|---|
| closed core-read schema package, canonical fixtures, isolated store/latency spike | считать read substrate продуктовым Agent Runtime или достаточным closure `0.3.0` |
| pure Goal Compiler/Evidence Projector/Certifier prototype без user-visible authority | V3 `verified`/terminal projection в product UI |
| agent-core problem map, acceptance corpus и artifact-only review | любой product/shadow runtime import до отдельного go/no-go |
| focused независимый regression review изменённых ABI/fixtures | объявление `known P1=0`, `Architecture Complete` или `Monarch 0.3.0 / Astra V3 ready` без executable evidence |

### 0.1. Convergence decision после второго внешнего audit batch

Astra V3 больше не закрывается как один гигантский protocol. Работа делится на физически независимые profiles:

| Profile | Текущий статус | Что входит |
|---|---|---|
| `astra-core-experience.v1` | **product closure target; architecture only / unavailable** | Product Facade + one Admission/Goal + Engine/Decision Gateway + Catalog + Context + Scheduler/Recovery + Workflow/Task Graph + Completion over representative capability packs |
| `agent-core-read.v1` | schema/durability substrate candidate; **not product closure** | canonical envelopes, persisted admission, one deterministic read Goal, read Invocation, Kernel read receipt, Evidence projection, pure assessment, deterministic structured presentation |
| `agent-admission.v1` / `agent-goal.v1` | normative design in Agent Core / unavailable | one typed interaction admission and capability-owned requirements |
| `agent-context.v1` / `agent-scheduler.v1` / `agent-workflow.v1` / `agent-completion.v1` | normative design in Agent Core / unavailable | context plan, recovery/resource scheduling, task graphs/workflows, broad claim-true completion |
| `agent-catalog.v1` | design notes only / unavailable | capability snapshot/search/inspect and dynamic discovery; core binds one static contract directly |
| `agent-effects.v1` | design notes only / unavailable | write/device/process, Approval/Arm, Action Ledger V2, compensation/recovery |
| `agent-provider.v1` | design notes only / unavailable | cloud driver, grant/permit/attempt/ingress, protected provider data |
| `agent-engine.v1` | design notes only / unavailable | transport-only model/agent driver negotiation and structured decision |
| `agent-steering.v1` | mandatory for `astra-core-experience.v1` / unavailable | durable follow-up, typed cancel acknowledgement, fresh-bound resume |
| `agent-model-host.v1` | mandatory for `astra-core-experience.v1` / unavailable | separate model residency and inference-turn leases, one local GPU queue owner |
| `agent-incognito.v1` | design notes only / unavailable | all-port memory-only operational profile |
| `agent-encrypted.v1` | design notes only / unavailable | encrypted journal/context/evidence lifecycle |
| `agent-plugins.v1` | undecided / unavailable | third-party trust, schema admission, authority and legal boundary |
| `agent-product-facade.v1` + product-read foundations | mandatory before any product read / currently unavailable | durable Interaction/continuation/recovery, product commands, messages/query/cancel, bounded queue, UI projection, compatibility API and delivery saga |
| `agent-children.v1` | design notes only / unavailable | delegation/mailbox/child reduce |
| `agent-jobs.v1` | design notes only / unavailable | schedules/runs/DST/missed fire |
| `agent-compaction.v1` | mandatory for `astra-core-experience.v1` / unavailable | coherent context-view compaction with raw Goal/authority/evidence retention |

Наличие имени/event/prose в полном architecture pack не включает extension. Machine manifest остаётся exact allowlist, однако release composition — отдельный вопрос: `agent-core-read.v1` может закрываться и тестироваться независимо, но не даёт права рекламировать или включать default Astra V3 без `astra-core-experience.v1` из Agent Core document.

Этот проход завершает широкие text-only audit cycles. Следующий independent review считается gate только если reviewer не создавал проверяемый artifact и проверяет exact generated schemas, fixtures, hashes, benchmark/test output и source diff. Ещё один LLM-review той же прозы может быть input, но не является самостоятельным production gate.

`exact`, digest chain и certificate в core означают deterministic consistency/crash evidence при trusted Monarch writer, а не защиту от скомпрометированного Windows user/OS. Effect/provider profile обязан отдельно выбрать и доказать attacker scope, authenticated store anchor/OS-protected key и rollback/supply-chain policy; иначе он остаётся unavailable.

---

## 1. Решение в одном абзаце

Monarch не должен заменять сильные существующие Turn, AgentTask, Kernel, approval, receipt и verifier механизмы чужим agent framework. Следующее поколение должно превратить их в единый, versioned и runtime-neutral execution spine: один admission компилирует typed Requirements; Strategy Selector выбирает deterministic recipe, registered workflow или bounded model planning; Decision Gateway даёт локальной модели branch-specific constrained schema и применяет permissive-syntax/strict-semantics admission; resource-aware Host планирует один реальный GPU slot; Kernel остаётся единственным владельцем эффекта; Recovery Supervisor сохраняет partial truth; Completion Certifier доказывает каждый requirement. `agent-loop.ts` разлагается на services/workflows без big-bang rewrite. Полная продуктовая формулировка и измеримые gates принадлежат `MONARCH_ASTRA_V3_AGENT_CORE.md`; один read-schema slice не считается новым агентом.

---

## 2. Область и запреты этого проекта

### 2.1. Входит в архитектуру

1. Единый application ingress для всех Oscar surfaces.
2. Durable Interaction и Execution aggregates с точным разделением владельцев истины.
3. Runtime-neutral client protocol и engine-driver protocol.
4. Типизированный Goal Contract и exact evidence binding.
5. Capability Catalog с search → inspect → propose invocation.
6. Kernel-only invocation, approval, receipt, reconciliation и completion certification.
7. Safe-boundary steering, pause/resume/cancel и crash recovery.
8. First-party workflow contracts вместо domain-specific веток в core loop.
9. Будущие child tasks/subagents, jobs и compaction с сужением authority.
10. Compatibility и migration path от Turn V1 + AgentTask V3.

Items 1–10 являются обязательными частями eventual architecture family. `agent-core-read.v1` содержит только exact Protocol §0.1 manifest и может закрываться как независимый substrate, но Catalog, Admission/Goal, Context, Scheduler, Plan/Decision, Engine, workflow interpreter, product facade и completion across real capability packs обязательны для product closure `astra-core-experience.v1`.

### 2.2. Не входит

1. Переписывание runtime-кода в рамках текущего прохода.
2. Замена Kernel или передача authority модели/SDK/plugin/runtime.
3. Копирование кода Cherry Studio; его AGPL implementation не является зависимостью Monarch.
4. Автономная запись `SOUL.md`, `USER.md`, долговременной памяти или персональных данных моделью.
5. Объявление worker thread, child process или prompt sandbox настоящей security boundary.
6. Автоматический доступ к Monarch Safe, даже read-only.
7. Обязательное внедрение стороннего runtime в Monarch `0.3.0`.
8. Безусловная гарантия exactly-once для внешних non-idempotent эффектов.

---

## 3. Текущая архитектура: подтверждённая карта, а не greenfield-допущение

### 3.1. Реальный production-route

Текущий обычный путь уже выглядит так:

```text
Desktop / Voice / Telegram / API / Coder
  -> src/app/application.ts
  -> src/app/oscar-turn-http.ts или surface adapter
  -> OscarTurnCoordinator.submit()
  -> durable OscarTurn + events + outbox
  -> disposition: answer | agent | clarify | memory
  -> operational lane: durable AgentTask V3
  -> AgentRuntime / AgentLoop
  -> KernelExecutionAdapter
  -> Application / Kernel capability
  -> observation + verifier records
  -> coordinator reconciliation
  -> durable terminal Turn + persisted message
```

Это означает:

- surface migration в основном уже выполнена;
- Turn Coordinator остаётся правильным application ingress;
- новый фундамент должен развиваться **ниже и вокруг** существующего route, а не создавать параллельный `/agent-v3` путь для UI;
- legacy `/api/agent/proposals` уже помечен deprecated и направляет effectful запрос в `/api/oscar/turns`.

### 3.2. Сильные существующие части, которые сохраняются

| Существующий механизм | Фактическая роль | Решение V3 |
|---|---|---|
| `OscarTurnCoordinator` | persistence-first interaction, surface ownership, outbox, answer/agent lanes | Сохранить как Interaction Service; убрать из него execution-domain эвристики |
| `OscarTurnStore` | durable Turn/checkpoint/events/client idempotency/outbox | Сохранить и version-evolve; не делать silent destructive migration |
| `AgentTaskStore` | Task V3, events V2, observations, approvals, CAS, fenced lock, runner claims, recovery | Сохранить как migration base; выбрать additive V3, sidecar journal или V4 только по измеренному ADR и no-dual-truth gate |
| `AgentRuntime` | task lifecycle/control/recovery | Разложить на Application + Scheduler + Execution services |
| `KernelExecutionAdapter` | единственный корректный путь из Agent в Application/Kernel | Сохранить как authority seam; добавить neutral invocation envelope |
| Kernel + Action Ledger V1 | policy/exact proposal authority seam; coarse `executing/completed/failed` effect record | Сохранить внешний authority seam; Ledger V1 не считать V3 effect truth, заменить внутренний lifecycle через versioned Ledger V2 |
| exact-bound approval | task + capability + canonical proposal hash | Неприкосновенный контракт; расширить runtime generation/expiry |
| observations + `ResultVerifier` | structured evidence и deterministic checks | Сохранить; заменить upstream heuristic binding на typed claims |
| strict JSON decision parser | legacy V2 compatibility only | V3 driver transport-only; Decision Gateway owns branch parser/canonicalizer/semantic admission; retire old parser from V3 after negative parity |
| Claim Integrity Gate | блокирует ложные action/inspection claims в answer-only | Сохранить как последний presentation firewall |
| Computer Use V1 | observation → one atom → fresh readback | Перенести ownership последовательности в Workflow Contract, не ослабляя guard |

### 3.3. Persisted baseline

На момент проектирования:

- Turn store: `monarch.oscar-turn-store.v1`;
- Turn entity/event: `monarch.oscar-turn.v1` / `monarch.oscar-turn-event.v1`;
- Agent store/task/checkpoint: `monarch.agent-task-store.v3` / `monarch.agent-task.v3` / `monarch.agent-checkpoint.v3`;
- Agent event: `monarch.agent-task-event.v2`;
- approval/observation уже versioned;
- legacy Agent V2 мигрируется в V3 при чтении;
- Local JSON stores используют atomic replace, в Agent store есть cross-process fenced lock и runner claim.

Любой V3 implementation обязан читать эти данные либо явно сохранить их read-only через legacy adapter. Нельзя переименовать schema version и считать миграцию завершённой.

---

## 4. Подтверждённые архитектурные разрывы

### 4.1. Core loop стал владельцем доменной логики

`src/agent/agent-loop.ts` содержит 6721 строк и десятки `trusted*` веток для:

- application discovery/open recovery;
- workspace known-folder и batch flows;
- storage/synthesis paths;
- direct operational sequences;
- Computer Use resolution, recovery и completion;
- duplicate inspection repair;
- capability-specific completion matching.

Проблема не в размере как таковом. Проблема в ownership: универсальный loop одновременно является scheduler, workflow engine, goal interpreter, recovery policy, capability router, presentation policy и completion binder. Каждая новая механика усиливает взаимное влияние веток и делает conformance доказательство почти невозможным.

### 4.2. Цель остаётся prose-centric

Текущий `AgentGoal` хранит description, expected outputs, constraints и текстовые acceptance criteria. Часть operational requirements затем заново извлекается из исходного текста центральным `operational-goal-binding.ts`.

Следствия:

- capability contract не владеет тем, какие его output fields доказывают конкретное требование;
- одинаковый prose парсится в coordinator, resolver, loop и matcher с разными правилами;
- добавление capability требует изменения центральных switch/regex;
- модель может выбрать правильный tool, но неверно связать его результат с requested claim.

### 4.3. `logicalBytes` — минимальный воспроизводимый пример класса ошибок

Историческая неоднозначная формулировка, которая выявила false-completion gap:

```text
Проверь использование хранилища E: и сообщи точное logicalBytes.
```

Она звучит как current/physical disk usage и **не является** legal interval Goal Astra V3: admission обязан уточнить смысл либо заблокировать, а не молча выполнить более слабый scan. Нормативный schema-lab запрос формулируется так:

```text
Одним проходом просканируй disposable root <repo-root>\.test-tmp\agent-core-read\case-logical-bytes
и сообщи logical-namespace-entry-bytes.v2 — сумму логических EOF-размеров обнаруженных
file namespace entries за интервал этого прохода. Не трактуй результат как текущий,
стабильный или физически занятый объём диска.
```

Текущий runtime умеет:

- вывести requirement `workspace.storage.audit` с root `E:\`;
- выполнить bounded audit;
- получить `output.observationVerified = true`;
- получить `output.audit.logicalBytes`.

Но текущий operational matcher доказывает лишь:

```text
capabilityId == workspace.storage.audit
AND observationVerified == true
AND audit.root == expected root
```

Он не делает `audit.logicalBytes` обязательным typed claim. Поэтому правильная capability и правильный receipt ещё не доказывают, что terminal answer содержит именно requested scalar. Повторный synthesis/inspection не исправляет отсутствующий контракт и может закончиться `duplicate-inspection-without-state-change`.

### 4.4. Completion truth распределена между несколькими владельцами

Сегодня completion участвуют:

- модель (`complete` decision и выбранные evidence IDs);
- `AgentLoop` и его semantic helpers;
- `ResultVerifier`;
- `OscarTurnCoordinator.reconcileAgentTask()` с дополнительными terminal guards и synthesis;
- Claim Integrity на answer path.

Наличие нескольких защит полезно, но у них нет одного versioned Completion Contract. В результате защита может быть одновременно слишком строгой в одном месте и недостаточно точной в другом.

### 4.5. Capability discovery не является protocol primitive

Resolver уже держит bounded 8–24 capability window и не скрывает tools только из-за approval — это правильная основа. Но:

- relevance в основном lexical и содержит hard-coded domain hints/exclusions;
- inspect ledger и schema digest отсутствуют;
- model-visible schema snapshot не является durable fact;
- missing required capability может смешиваться с поиском похожих возможностей;
- capability-owned claim/verifier/workflow contracts отсутствуют в `MonarchCapability`.

### 4.6. Persisted events пока являются частью checkpoint, а не полным journal protocol

Turn и Agent events versioned и sequenced, но не покрывают единообразно:

- command admission/causation/correlation;
- runtime generation;
- catalog snapshot/inspect;
- invocation prepared/authorized/dispatched/reconciled;
- completion requested/certified;
- steering boundaries;
- child task delivery;
- compaction brackets;
- job notices.

Это ограничивает replay, multi-runtime и fault-injection доказательства.

### 4.7. Goal и Activation недостаточно разведены

Durable task status и runner claim уже существуют, но «задача существует», «задача разрешена к продолжению» и «конкретный процесс сейчас имеет lease» должны стать тремя разными фактами. После crash нельзя выводить permission to resume только из `status=running`.

### 4.8. Interaction routing пока является вторым semantic parser

`src/oscar-turn/disposition.ts` решает `answer | agent | clarify | memory` до создания Execution, а `operational-goal-binding.ts` затем независимо парсит тот же текст. Если первая эвристика ошибочно выбрала `answer`, Goal Compiler и Certifier вообще не получают запрос. Claim Integrity может заблокировать ложную фразу, но не превращает её в выполненную задачу.

Target architecture вводит один `InteractionIntentAdmission` на тех же versioned capability matchers, которые затем компилируют GoalContract. Disposition становится projection результата admission, а не вторым владельцем смысла. Неизвестный imperative/operational candidate ведёт к Execution или clarify/block; answer-only допускается только для bounded informational class без operational candidate.

### 4.9. Exact integer и durable recovery нельзя строить на текущем JSON `number`

Текущий storage audit суммирует `logicalBytes` как JavaScript `number`. Значение выше `Number.MAX_SAFE_INTEGER` может быть округлено ещё до digest/certificate, после чего все selectors формально докажут уже неверное число. Кроме того, текущий Action Ledger после interrupted execution не содержит всей frozen idempotency/reconciliation семантики, нужной V3. Поэтому lossless typed values и immutable effect semantics являются не оптимизацией, а blocker contracts.

### 4.10. Kernel seam правильный, но его внутренний контур ещё не V3 Kernel

Текущий `ExecutionEngine` в одном path объединяет schema/source/risk admission,
Permission/Policy/Security, approval, ledger, rollback capture, module dispatch,
postcondition verification, events и audit. `MonarchKernel` одновременно composition root,
RouterMesh/Planner facade и execution owner. Переписывать module executors или composition root с
нуля не нужно, но raw intent routing/prose planning не входят в будущий authority kernel.

`MonarchActionLedger.begin()` сразу создаёт `executing`; после restart незавершённое durable
действие становится `failed/interrupted-before-completion`, не различая dispatch-before-receipt и
effect-not-attempted. `MonarchEventBus` и `MonarchAuditLog` хранят in-memory history/entries и
являются telemetry, не recovery journal или evidence.

Target сохраняет один внешний Kernel Invocation port, но разделяет внутренние owners:
Invocation Coordinator, Policy/Authorization, Effect Broker/driver, Receipt Admission и Evidence
Projection. Durable Journal/Evidence Graph отделены от lossy telemetry. Это extraction внутри
одного authority seam, а не создание `Kernel 2` или bypass.

---

## 5. Неприкосновенные инварианты V3

Эти правила выше любых runtime/plugin/workflow удобств.

### I-01. Kernel authority

Ни model, driver, workflow, child task, UI, plugin, job, summary, memory, skill или adapter не выполняет effect напрямую. Единственный effect path:

```text
typed proposal -> Application admission -> exact policy/approval -> Kernel -> receipt
```

### I-02. Model output is proposal, never truth

Текст или JSON модели может предложить plan, invocation, question, steering acknowledgement или completion request. Он не меняет authoritative state без deterministic admission.

### I-03. Completion requires a certificate

Terminal `verified` возможен только после `CompletionCertificate` от независимого Certifier. `complete` от runtime означает только `completion.requested`.

### I-04. Exact goal binding

Каждый обязательный operational claim связывается с:

- точным capability ID + contract version/schema digest;
- нормализованным input binding;
- конкретным invocation/receipt;
- typed output selector;
- predicate/comparator;
- freshness/completeness policy.

### I-05. No substitution

Если required capability отсутствует или ineligible, runtime обязан discover/request install/block. Похожая capability не считается эквивалентом без объявленного compatibility mapping.

### I-06. Approval is exact, crash-stable and non-transitive

Approval связан минимум с execution, stable invocation ID/authorization revision, GoalContract revision, capability/contract digest, canonical proposal hash, policy/authority scope snapshot, approver attestation и expiry. Process `activation generation` является runner fence и **не** инвалидирует неизменившийся approval после crash. Approval не передаётся child task и не расширяется workflow.

### I-07. Authority only narrows downward

```text
Owner/profile scope
  ∩ surface/privacy scope
  ∩ task scope
  ∩ workflow scope
  ∩ child scope
  ∩ invocation scope
```

Нижний слой не может восстановить право, убранное верхним.

### I-08. Persist before run

User command и его idempotency receipt фиксируются до model/runtime/tool работы. Для incognito используется тот же логический порядок в memory-only store.

### I-09. Safe is opt-in and non-discoverable by default

Monarch Safe никогда не входит в общий catalog search, generic filesystem scope, background job или child scope. Отдельный будущий Safe provider требует точной пользовательской команды и отдельного security contract.

### I-10. Raw evidence survives compaction

Receipt, observation, approval, invocation и certificate refs не заменяются summary. Summary — только model/presentation surface.

### I-11. No hidden reasoning persistence

Journal хранит commands, decisions, public rationales, state transitions и evidence; не chain-of-thought, system prompts или raw hidden reasoning.

### I-12. No blind replay of non-idempotent effects

После indeterminate dispatch non-idempotent action блокируется до reconciliation или точного решения пользователя.

### I-13. One authoritative owner per fact

Никакой projection/service не должен независимо пересчитывать факт, принадлежащий другому aggregate. Он может только проецировать его versioned event.

### I-14. Lossless values before digests

Exact integer/decimal/time/byte values сначала приводятся к canonical lossless representation, и только затем хешируются, сохраняются и сертифицируются. JSON/JavaScript `number` допустим только после доказанного safe-range check.

### I-15. Operational evidence is admitted, not self-labelled

Engine/provider/worker event не становится доказательством от поля `verified=true`. Для operational `verified` evidence должен происходить из Application/Kernel-admitted receipt либо из certified child chain, которая в конечном счёте ссылается на такие receipts. Внешний provider проходит отдельный evidence-admission и egress grant.

### I-16. One physical append owner per stream

Только authoritative aggregate store append-ит events и назначает sequence/revision. Kernel, driver, projector и другие компоненты передают facts/commands через ports/outbox; значение `producer` описывает происхождение факта, но не даёт прямой write authority.

### I-17. Incognito foundation has no durable effects

Это invariant будущего `agent-incognito.v1`, а не разрешение current core. `agent-core-read.v1` принимает только persistent Interaction и возвращает `feature-unavailable` для operational Incognito. Если отдельный Incognito manifest когда-либо будет закрыт, его максимальный ceiling — answer-only/bounded local read с `mutation=none`, `communication=none`, без external egress; до exhaustive all-port residue/crash proof даже это unavailable.

---

## 6. Архитектурные решения

### ADR-V3-01. Сохранить два доменных aggregate, но дать им единый application ingress

- **Interaction** (эволюция Oscar Turn) владеет порядком user/assistant rows, surface/privacy binding, answer lifecycle и user-visible outcome.
- **Execution** (эволюция AgentTask) eventually owns GoalContract, activation, plan, decisions, invocations, evidence dependencies and completion certificate. In the core schema lab it owns only the fixed Goal/Invocation/Evidence/assessment trace; Activation/Plan/Decision and product persistence are unavailable.
- **Agent Application Service** принимает команды, создаёт durable links и ведёт cross-aggregate saga/outbox.
- `AgentRunView` для UI — projection, а не третий источник истины.

Почему не объединять сразу: Turn и Task уже имеют разные durability/privacy semantics, а big-bang merge создаст риск для history, incognito, approval и recovery. Почему не оставлять текущую связь без изменений: coordinator сейчас повторно интерпретирует execution truth.

### ADR-V3-02. Ввести Agent Client Protocol V1 и Engine Driver Protocol V1

Первый стабилизирует surface/UI/client boundary. Второй изолирует конкретные local/cloud runtimes. SDK types не попадают в persisted DB ABI, Kernel contracts или renderer.

### ADR-V3-03. Capability-owned Goal Contract

Core не содержит switch по capability ID. First-party capability/module публикует versioned `AgentCapabilityContract`, способный:

- распознать bounded requirement candidate;
- нормализовать input;
- объявить claim templates и selectors;
- объявить verifier/reconciliation recipes;
- при необходимости сослаться на статический workflow definition.

Model-assisted goal interpretation разрешён только как candidate generator. При конфликте deterministic contract побеждает; при неоднозначности задаётся вопрос.

### ADR-V3-04. Product persistence выбирается сравнением трёх вариантов, V4 не предполагается

До product import benchmark/ADR сравнивает: **A)** additive `AgentTaskStore V3` с минимальными новыми event/projection полями; **B)** sidecar evidence/certificate journal, где Task V3 остаётся lifecycle owner, а sidecar владеет только новой доказательной осью; **C)** полный append-only Execution Store V4 с legacy adapter. Выбирается наименее сложный вариант, который одинаково доказывает atomic command receipt, one-owner-per-fact, crash recovery, historical package retention, backup/restore и rollback. Snapshot всегда rebuildable projection. Dual-write двух независимых authoritative owners запрещён. Если A или B проходит те же invariants с меньшим migration/risk budget, V4 отклоняется.

### ADR-V3-05. Completion Certifier — отдельный pure domain service

Certifier не вызывает модель и tools. Он принимает GoalContract + immutable evidence graph + policy snapshot и выдаёт deterministic certificate или typed denial.

### ADR-V3-06. Presentation после certification

Synthesis перестаёт быть способом доказать completion. Exact values рендерятся deterministic template; свободный текст модели получает только certified EvidenceView и проверяется Claim Integrity.

### ADR-V3-07. First-party workflows — data/state machines, не скриптовый plugin authority

Workspace pagination, application resolution и Computer Use становятся versioned static workflows с guards и allowed capability sets. Первоначально никакой произвольный runtime-loaded код не получает orchestration authority.

### ADR-V3-08. Goal и Activation разделены

Goal durable. Activation — ограниченный lease с generation, budgets, runtime binding и recovery policy. Task может существовать без активного исполнения.

### ADR-V3-09. Child work — durable child Execution, не скрытый model call

Subagent создаёт обычный суженный Execution с lineage, mailbox и собственным certificate. Parent получает evidence refs/report, но не принимает текст ребёнка за истину.

### ADR-V3-10. Local-first и provider boundary

Первый V3 driver адаптирует текущий local decision provider. Добавление materially different cloud provider требует отдельного provider/data/terms consent contract и не является частью архитектурного разрешения.

### ADR-V3-11. Один semantic admission для answer/agent split и GoalContract

`InteractionIntentAdmission` использует exact allowlisted matcher descriptor/body ref + raw implementation hash из статически bound capability contract и выдаёт immutable candidate set/digest. Operational Execution создаётся из этого же set; Goal Compiler не парсит исходный текст заново независимым switch. Current `disposition.ts` остаётся compatibility adapter только до parity gate. Ambient/latest matcher registry snapshot не является core authority.

### ADR-V3-12. Frozen execution semantics

Eventual effect profiles require a dedicated content-addressed semantics snapshot: input/output/claim schema, effect/risk/idempotency/reversibility/cancellation, reconciliation body, timeout and policy/authority state. That object is **not** in core. `agent-core-read.v1` freezes only the allowlisted capability/input/output/Goal/AuthorityScope/policy/recipe/presentation refs+digests and exact raw implementation hashes repeated by Protocol §16. Missing/incompatible bytes block instead of substituting latest code. An implementation hash proves provenance but does not retain a safe executable.

### ADR-V3-13. Deterministic assessment отделён от certificate envelope

Pure Certifier создаёт deterministic `CompletionAssessmentBody` и digest. Application в atomic terminal commit создаёт random certificate ID ровно один раз под dedicated certification key, а certificate повторяет frozen assessment time/clock attestation из retained assessment input; terminal event `occurredAt` — только observability и не переоценивает freshness. Повтор commit command возвращает тот же byte-identical retained envelope; новая administrative envelope для того же key запрещена.

### ADR-V3-14. Официальное имя — Astra V3; целевой release train — Monarch `0.3.0`

Имя и версия являются разными осями. Astra V3 — runtime architecture family; Monarch `0.3.0` — назначенный owner-ом общий релиз. Protocol V1, persisted AgentTask V3, future Store V4 и module Astra Skills `0.1.0` сохраняют собственные версии/ID. Номер `0.3.0` не включает profile и не доказывает readiness без его exact release gates.

### ADR-V3-15. Product-read foundation обязательна перед первым пользовательским cohort

Core schema lab не является маленьким скрытым product runtime. До любого product write/ordinary Oscar route отдельно generated product-read profiles обязаны дать durable accepted-work continuation, retained historical package bytes, current revocation ceiling, receiptless dispatch recovery, Interaction/message/delivery facade, query/cancel/attach, bounded installation-wide read queue, generation rollover, private-store ACL/backup/admin и process-generation fence. Эти механизмы могут переиспользовать core contracts, но не выдумывать authority variants.

### ADR-V3-16. Astra Skills — компонент, не новый authority owner

Существующий `src/modules/astra` сохраняется как Astra Skills: discovery, Agent Cards, progressive disclosure и versioned skill refs. Он не исполняет capabilities и не сертифицирует результат. Миграция использует его через bounded catalog/context adapter; Goal admission, policy, Kernel dispatch, evidence и terminal truth остаются у соответствующих владельцев Astra V3.

### ADR-V3-17. Единственный machine source и малый bootstrap trust root

Protocol prose владеет человеческим смыслом, но codegen читает только canonical `ProtocolDefinitionV1`. Малый отдельно hash-pinned bootstrap schema/compiler не генерирует сам себя; definition содержит closed AST schemas, IDs, primitive relations, state/commit tables and fixtures. TypeScript fragments, generated schemas и audit prose не являются альтернативными inputs. Closure требует структурного и targeted semantic review с counterexamples, а не только byte parity.

### ADR-V3-18. Product trust/revocation/correction — отдельная authority family

Локальный certificate доказывает deterministic consistency under trusted Monarch writer, не hostile-writer/notarial truth. Product Package Store, Revocation Service, Clock Authority и Delivery Service обязаны отдельно владеть package admission, current revocation ceiling, deadlines, certificate invalidation/correction and user notice. Runtime/presentation не могут объявить historical package/current authorization по одному digest.

### ADR-V3-19. Storage walk наблюдает отдельный Kernel broker

Pinned low-privilege filesystem broker владеет handle-based Win32 observations, iterator exhaustion, I/O/resource counters and protected-identity denial. Walker владеет только deterministic frontier orchestration; Projector проверяет broker proof; Certifier не переобходит filesystem. Каждый dispatch получает одноразовый supervised job/process: graceful exit доказывает explicit handle closure, timeout/forced exit — armed kill-on-job-close + Kernel-observed process exit + zero post-exit broker handles; session не переиспользуется. Первый профиль поддерживает только локальный fixed NTFS non-reparse directory на закрытом `{ATA,SATA,NVMe,SAS,RAID}` bus allowlist по Protocol §29.

### ADR-V3-20. Complexity budget и kill criteria обязательны до product planning

Первый slice не расширяет текущие ceilings: 66 runtime schemas, 40 structural event variants, 8 guard relation labels expanded to primitive programs, 28 claim templates и 16 data-bearing presentation keys. Любой рост до первого compiled artifact требует убрать/заменить эквивалентную сложность либо отдельный no-go ADR. После Phase 0 hardware measurements фиксируются latency/RAM/CPU/disk/RPO/RTO budgets. Slice или выбранный store отклоняется, если не проходит их без второго truth spine, unbounded recovery или user-visible semantic regression.

### ADR-V3-21. Capability-first product closure

`agent-core-read.v1` демонтирует рискованный Protocol/store класс на малом примере,
но не закрывает agent product. Release composition `astra-core-experience.v1`
обязана одновременно включить Product Facade, one Admission/Goal, Decision
Gateway/Engine, Catalog, Context/core Compaction, Resource Host/Scheduler/Recovery,
durable local steering/cancel/resume, Workflow/Task Graph и Completion, а также пройти
минимум четыре representative capability packs: workspace read, workspace effect,
desktop control и browser navigation. Disabled advanced profiles остаются честно
unavailable.

### ADR-V3-22. Permissive syntax, strict semantics

Local-model decision больше не проверяется одним хрупким exact-key parser после общего optional-field schema. Driver получает branch-specific discriminated schema; versioned Decision Gateway может canonicalize только inert/wrapper/default drift, после чего capability/input/Goal/secret/untrusted/authority validation остаётся fail-closed. Canonicalization никогда не изобретает target, value, scope, evidence или capability.

### ADR-V3-23. Strategy before model

Answer fast path, deterministic recipe и registered workflow проверяются до planning model call. Простая exact task не обязана тратить отдельный model turn на prose plan. Model planning остаётся для действительно открытой семантики, выдаёт только bounded Task Graph patch и не владеет IDs, authority или completion.

### ADR-V3-24. Resource-aware local execution

Engine Driver объявляет context/grammar/cancellation/session-cache/residency/memory features. Scheduler исходит из реального single-slot local inference, не обещает параллельные LLM turns на 8 GB GPU, отделяет безопасный parallel tool I/O и оптимизирует model affinity, deltas, escalation и deadlines по измеренным SLO.

### ADR-V3-25. Full-task evidence precedes agent readiness

Schema, mock и unit tests доказывают только свой слой. Astra readiness требует current-model ordinary-route full-task holdout, fault injection, efficiency metrics, packaged installed acceptance и нулевые false-verified/wrong-effect/authority-bypass/zombie/duplicate-non-idempotent outcomes. Machine-readable problem/acceptance map принадлежит Agent Core document.

### ADR-V3-26. Open-ended discovery precedes final authority

Для неизвестной задачи допускается non-authoritative `PreliminaryNeedsV1` и bounded
Catalog discovery до final Admission/Goal. Model-assisted ranking может выбирать
только exact returned handles. Capability ID, inputs, targets, authority и final Goal
компилируются/валидируются runtime монотонно; preliminary artifact не создаёт
Execution и не является permission.

### ADR-V3-27. Readiness и local resources являются leased state

Boolean preflight запрещён как product guarantee. `ExecutionReadinessReceiptV1`
связывает capability/Kernel/store/catalog/policy generations и явно говорит
`modelRequirement=none|immediate|deferred`; deterministic path не зависит от модели.
Отдельный `InferenceTurnAdmissionReceiptV1` связывает Host/model/context только перед
реальным model turn с reservation или bounded durable queue admission.
`ModelResidencyRecordV1` отдельно формализует load/resident/
evict/unload, а `InferenceTurnLeaseV1` — queue/reserve/generate/release/fail/expire.
Вместе они закрывают OOM, cancellation, cache eviction, Host crash и один общий GPU
queue owner без удержания turn lease тёплой моделью. Fast→Balanced — отдельные
scheduled turns с новой readiness/context binding, не скрытый retry.

### ADR-V3-28. Open-source donor не становится владельцем Astra

OpenHands является primary reference donor для event/context/lease/pause/resume/
subagent/workspace patterns; Microsoft Agent Framework 1.16.0 — выбранный secondary
donor для deterministic executor graph, checkpoint lineage, typed HITL, cancellation
и checkpointed subworkflow recovery; Mastra — bounded TypeScript workflow/eval
comparison; Temporal/LangGraph — semantic durability benchmarks. Прямой runtime
replacement и product dependency не одобрены. Любой adapter остаётся untrusted Engine boundary:
Intent Admission, Kernel authority, Resource Host и Completion truth принадлежат
Monarch. Exact snapshots/provenance/forbidden transfers зафиксированы в
`MONARCH_ASTRA_V3_OPEN_SOURCE_REFERENCE.md`.

### ADR-V3-29. Legacy Slot semantics retired; Skill guidance enters through one bounded adapter

Историческая Astra architecture смешивала capability discovery с agent runtime и обозначала
read-only card/schema projection как `slot`. В Astra V3 `astra.slot.preview` остаётся только
legacy/catalog UI projection: он не является Execution, Activation, ContextPlan, readiness,
authority, workflow state или completion evidence и не импортируется в новый runtime ABI.
Действующая Astra Skills подключена к answer-only context, но не к common V2 AgentLoop; этот
разрыв закрывается одним `SkillContextAdapter`, а не выдачей skills нового authority.
Adapter возвращает exact digest-bound `SkillRef` и untrusted guidance projection. Skill text и
`requiredCapabilities` могут сузить context или запустить bounded Catalog discovery, но не меняют
admitted Goal/AuthorityScope, не pin-ят executable tool, не создают approval/evidence/certificate
и не hot-swap уже admitted Execution. Полный evidence-backed разбор наследия и deletion gates:
`MONARCH_ASTRA_LEGACY_ARCHITECTURE_POSTMORTEM.md`.

---

## 7. Целевая схема компонентов

```text
┌──────────────────────────────── Surfaces ────────────────────────────────┐
│ Desktop │ Voice │ Telegram │ API │ Coder │ future scheduler/delivery    │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ Agent Client Protocol V1
                                v
┌──────────────────── Agent Application Service ──────────────────────────┐
│ command admission │ idempotency │ revision fence │ saga/outbox          │
└───────────────┬────────────────────────────────────┬─────────────────────┘
                │                                    │
                v                                    v
┌──── Interaction Service ────┐        ┌──────── Execution Service ───────┐
│ Turn/order/privacy/messages │        │ GoalContract │ plan │ activation │
│ answer lifecycle/outcome    │        │ journal │ invocation graph       │
└───────────────┬─────────────┘        └───────┬──────────────────────────┘
                │                               │
                │                               ├── Goal Compiler
                │                               ├── Capability Catalog
                │                               ├── Workflow Engine
                │                               ├── Runtime Host
                │                               ├── Invocation Coordinator
                │                               └── Completion Certifier
                │                                             │
                │                                             v
                │                     ┌──────── Application / Kernel ──────┐
                │                     │ policy │ approval │ action ledger   │
                │                     │ capability execution │ receipt      │
                │                     │ protected identity │ fs broker      │
                │                     └────────────────┬────────────────────┘
                │                                      │
                │                                      v
                │                     Evidence Store / Receipt Projection
                │                                      │
                └──────────────────────┬───────────────┘
                                       v
                           Presentation / Delivery Service
                          deterministic facts + bounded LLM prose

Cross-cutting pinned authorities (never ambient registries):
Content Store │ Protocol Package Store │ Clock Authority
Revocation Service │ Protected Identity Registry │ Workspace Grant Service
```

### 7.1. Dependency direction

```text
domain contracts
  <- application services
     <- infrastructure adapters (JSON/SQLite, local model, HTTP, Electron)
```

Domain services не импортируют Electron, Python transport, AI SDK types или concrete store classes.

---

## 8. Владельцы истины

Таблица покрывает eventual architecture family. Для core lab применимы только command/admission, immutable Goal, one Invocation/Kernel receipt, single-node Evidence, assessment/certificate и deterministic presentation rows; lease/Plan/approval/effect/child/provider/product wording owners остаются unavailable profiles и не создают hidden dependencies.

| Факт | Единственный authoritative owner | Остальные слои |
|---|---|---|
| User command accepted | Agent Application Service command receipt | проецируют |
| Порядок сообщений и surface visibility | Interaction Service | UI читает projection |
| Raw user goal/message bytes | Interaction + accepted-command store | Execution/Goal содержит только immutable accepted-command/admission refs+digests; второго prose-owner нет |
| Нормализованные requirements/claims | Execution aggregate stores admitted GoalContract; pure Compiler + versioned capability contracts produce candidate body | runtime только читает persisted body |
| Доступная capability schema | core: exact static allowlisted capability ref; future: Capability Catalog snapshot | Catalog/driver projection отсутствует в core |
| Plan/proposal | Runtime/Planner proposal после admission | не authority действия |
| Policy/permission | Application/Kernel | runtime не переопределяет |
| Human approval | Approval Service/Kernel boundary | UI только отправляет exact decision |
| Effect | Kernel/Action Ledger | receipt является доказательством |
| Наблюдение | Evidence Store из Application/Kernel-admitted receipt | runtime/provider output только untrusted source до evidence admission |
| Completion | Execution aggregate stores atomic Certificate + terminal commit; pure Completion Certifier produces assessment | model только запрашивает |
| User-facing wording | Presentation Service | не меняет certificate |
| Runtime lease | Activation Scheduler | Goal не подразумевает lease |
| Child authority | Parent scope ∩ policy ∩ child descriptor | ребёнок не расширяет |
| Answer/agent/clarify semantic admission | InteractionIntentAdmission | disposition/Goal Compiler потребляют один candidate set |
| Event sequence/revision | соответствующий aggregate store | producer не append-ит напрямую |
| Provider egress | Egress Gate + ProviderExecutionGrant | driver не решает consent |
| Immutable protocol/evidence bytes and object generation | Content Store | ref consumer revalidates identity/length/classification; object ID не bearer token |
| Historical protocol/package bytes, publisher admission and quarantine | Protocol Package Store | RuntimeFeatureSet ссылается на exact retained generation; current registry не подменяет history |
| Assessment/deadline/revocation time | Clock Authority | appender timestamp остаётся observability, model/UI clock не authority |
| Current package/capability/implementation revocation ceiling | Revocation Service | Scheduler/Kernel/Certifier/Delivery только проверяют retained decision/epoch |
| Protected object/ancestor identities and generic denial | Protected Identity Registry inside Kernel | walker/UI не получает protected label/path/count |
| Principal-to-workspace root grant and expiry | Workspace Grant Service | accepted context freezes exact grant ref; matcher не расширяет membership |
| Certificate invalidation/correction and user notice | Product Correction Service + Delivery Service | certificate immutable; projection показывает latest authorized correction state |

---

### 8.1. Обязательный product-read lifecycle до ordinary route

Эти owners не входят в core manifest, но product profile обязан материализовать их закрытыми schemas/events до первого cohort:

1. Protocol Package Store импортирует только vendor-admitted exact package generation, сохраняет historical bytes/manifest/compiler provenance и никогда не удаляет known-bad package молча. Revoked bytes переводятся в quarantine/read-only evidence; запуск/новая certification запрещены typed outcome `implementation-revoked`.
2. Revocation проверяется при accepted-work continuation, непосредственно перед dispatch, до и после каждого potentially blocking broker I/O, перед Evidence admission, перед assessment/certification и перед каждой delivery/re-delivery. Long scan получает cancel/revoke token; поздняя проверка не делает ранее прочитанные байты разрешёнными evidence.
3. Work carries both `startBy` and hard `deadline` from Clock Authority. Missed start never dispatches; deadline during I/O aborts, invalidates the incomplete candidate and produces a typed non-success outcome. Deadline cannot silently renew; extension is a new admitted decision.
4. A certificate is immutable but not irrevocable. Package/implementation compromise or projector defect appends a separately owned invalidation/correction record, suppresses future delivery of the old verdict, rebuilds authorized projections and creates an idempotent user notification. Historical certificate bytes remain quarantined audit evidence, not current truth.
5. Delivery rechecks current principal/session/surface authorization and certificate correction/revocation epoch. An old outbox row is not a bearer right. Receiver inbox remains idempotent and cannot resurrect a revoked result.
6. Product stores publish retention/erasure/export, backup encryption, restore ordering, RPO/RTO and orphan/quarantine quotas before enablement. User erasure removes/crypto-erases eligible personal payload while retaining only the minimum legally/security-required tombstone; no silent backup resurrection is allowed.
7. Presentation has deterministic plain-text and accessibility fallback for renderer/template failure, reduced-motion/screen-reader labels, copyable exact value and truthful “result unavailable/revoked” states. Fallback never fabricates a certificate or hides partial/invalidation state.

Numeric durations, quotas and RPO/RTO values are ratified from Phase 0 measurements before product planning; “TBD/unbounded/default OS timeout” fails the gate.

---

## 9. Interaction и Execution

### 9.1. Interaction

Interaction сохраняет лучшие свойства Turn V1:

- persist-first admission;
- `clientRequestId` idempotency;
- conversation/source/privacy binding;
- input/output message IDs;
- durable outbox;
- retry/supersede/reply linkage;
- answer-only Claim Integrity;
- incognito memory-only store;
- encrypted lane fail-closed.

Этот список описывает сохраняемый product baseline/eventual facade, а не schemas core lab. В `agent-core-read.v1` Interaction имеет только Protocol closed submit/follow-up admission events; outbox links, output rows, Incognito/encrypted storage and execution progress projection require the unavailable `agent-product-facade.v1`/privacy profiles.

Core authoritative command receipt существует только для атомарно принятой команды и всегда имеет `disposition='accepted'`. В schema-lab это atomic retained-state fact in memory, не обещание process/power-loss durability; product surface не может импортировать его как durable acceptance до backend fault gate. Accepted-command body, full dedupe record, receipt и ровно один первый Interaction event появляются all-or-none; event payload удерживает dedupe/receipt refs, а Protocol projection связывает command/fingerprint/interaction/revision/event/time поля. Strict parse/auth/feature/manifest/capacity failure или same-client-ID/different-body conflict возвращает закрытый `AgentProtocolErrorV1` до command/Interaction creation; Runtime не выдумывает `acceptedAt`, fingerprint или aggregate IDs для непринятой команды. Core error не содержит server-authored message/path/cause: клиент может показать только локальный текст по закрытому code tuple, а `path-ineligible` не различает protected и ordinary denial.

Перед disposition работает server-owned `InteractionIntentAdmission`:

1. transport adapter уже вывел trusted principal/surface/persistent privacy scope, server-granted exact workspace roots и validated RuntimeFeatureSet, который pin-ит sole core capability contract плюс Completion Certifier/terminal policy; prose target он не парсит;
2. bounded first-party matcher, pinned by allowlisted descriptor/body ref and recomputed `raw-sha256` implementation hash, строит только informational/operational candidates core-профиля и обязан пройти закрытую Protocol candidate-legality matrix до target resolution;
3. negation, prohibition, unknown modality, multi-clause boundaries, source-message bytes, target/temporal ambiguity и exact singleton unknown code входят в admission body; ни одна такая unsafe/ambiguous clause не может быть спрятана в unselected informational row рядом с execution candidate;
4. eligible operational cohort создаёт одну V3 Execution; unknown/missing target/temporal meaning создаёт clarify/blocked;
5. core не вызывает model classifier, memory/image/provider/engine route и не допускает V2/split variant;
6. Goal Compiler получает retained admission ref/body/digest и не выполняет независимый повторный NLP parse.

Unknown imperative считается `operational-unknown`, а не безопасным answer-only. Это не означает, что любой вопрос создаёт Task: bounded informational questions с отсутствием imperative/target/effect candidates остаются быстрым answer path.

Persisted admission ABI существует только как generated schema `InteractionIntentAdmissionV1` из Protocol §9.1. Runtime не поддерживает ручное зеркало этого типа. Source — discriminated submit/follow-up binding to one retained accepted-command ref/digest whose payload owns the message bytes; accepted context уже pin-ит RuntimeFeatureSet и его sole capability/matcher/Certifier/terminal-policy chain before the atomic accepted receipt, candidate is a closed union; clause and aggregate routes are separate; cohort может только повторить тот frozen chain и пересечь matcher target с заранее server-granted scope. Execution требует ровно один selected positive operational candidate с `ambiguityCodes=[]`, complete target и explicit interval; matrix violation отбрасывается до Goal/Execution и не может быть «починена» Application. Missing/corrupt historical body/implementation → fail-closed `admission-history-unavailable`, not latest-registry reinterpretation.

Каждый follow-up проходит тот же persisted admission. Core не имеет `steer` и не изменяет Goal revision in-place: любой semantic operational follow-up создаёт новую linked Execution с новым immutable Goal; informational follow-up создаёт отдельную answer row, ambiguity clarifies, rejection remains typed. Client hint не выбирает outcome. Один Interaction может иметь несколько explicit `executionLinks[]`; singular link запрещён. Поэтому Interaction не имеет одного execution-like `running/completed` state. **Core-read fixture lifecycle** заканчивается на `accepted→routing→open`; закрывающего core event нет. **Eventual product-facade lifecycle** может добавить `open→closed-by-user|retention-closed` только через отдельно generated manifest. Answer/execution/recovery-correction rows имеют независимые statuses и ordered outcome refs; mixed row не превращает весь Interaction в verified.

Будущий product-facade target state не должен содержать capability-specific verification. После отдельного manifest/go-no-go он сможет принимать только typed execution facts вроде:

- `execution.linked`;
- `execution.progressed` как projection;
- `completion.certified`;
- `execution.blocked/failed/cancelled`.

### 9.2. Execution

В `agent-core-read.v1` Execution не хранит raw `UserGoal`: единственный prose-owner — Interaction/accepted-command store. Core Execution удерживает accepted-command/admission refs+digests, exact `GoalAdmissionBinding`, immutable Goal/minimum/semantic body, RuntimeFeatureSet/static capability/AuthorityScope/budget refs, one Invocation, Kernel receipt/result, Evidence refs, assessment input/body, certificate and deterministic presentation refs. Catalog, Plan, Activation, Decision, workflow, approval, artifact authority, children and recovery decisions отсутствуют.

Будущий product/runtime Execution может расширить этот список только через отдельный manifest/schema version; широкая eventual aggregate model не является core mirror.

Execution не хранит full chat history как authority. Context Compiler получает bounded Interaction projection.

### 9.3. Cross-aggregate saga

> **Future `agent-product-facade.v1` design; unavailable in the core schema lab.** No Interaction link/row/message store mutation is authorized by this section.

Operational Interaction создаёт `create-execution` outbox command. После idempotent execution admission Execution публикует `execution.created`, а saga записывает link в Interaction. Terminal outcome приходит только из execution event. Если crash происходит между шагами, outbox повторяется по idempotency key; никакой новый Task не создаётся.

Formal delivery state set: `pending | applied | acknowledged | rejected`. Нормальный успешный путь — `pending -> applied -> acknowledged`; permanent typed incompatibility/corruption даёт `rejected` и никогда не считается доставкой. Receiver хранит inbox receipt с delivery ID, source stream/sequence и payload fingerprint в том же commit, что и Interaction event/row. Повтор после crash возвращает уже применённый receipt; revision conflict не теряет delivery, а повторно читает inbox.

---

## 10. Goal Contract

### 10.1. Три слоя цели

1. `UserGoal source` — immutable accepted-command/admission/message byte bindings; это provenance, не mutable prose field.
2. `DeterministicGoalMinimumV1` — retained compiler output с exact allowlisted matcher ref/body/implementation hash и единым semantic body.
3. `GoalContractV1` — admitted authoritative contract, byte-semantically equal minimum в core и связанный с exact RuntimeFeatureSet/capability/Completion-Certifier refs+digests, не ambient snapshots.

Runtime не владеет ручным TypeScript-зеркалом Goal ABI. Единственный schema owner — Protocol §9.2–§9.4 и generated package. Обязательные свойства core:

- exact `GoalAdmissionBinding` exists only after the complete candidate-legality matrix passes and ties accepted command/context/locale/admission/the sole positive unambiguous candidate — including explicit interval meaning, admitted partial policy and the capability's fixed required claim suite — to RuntimeFeatureSet, matcher, capability, Completion Certifier/terminal policy and target, then proves the Goal AuthorityScope is the canonical narrowed intersection of the accepted scope; inclusion/exclusion/budget policies, normalized Invocation input and semantic body are exact;
- one retained pure matcher result and machine-checked result→Admission sealing relation, then one retained minimum ref/body digest — не «hash неизвестно чего» и не matcher, который тайно владеет store IDs/handle resolution;
- local deterministic compiler only; model/provider/egress отсутствуют;
- exact capability/input/target/temporal/authority/presentation constraints;
- exactly one requirement; no ordering DAG or prior-evidence import in core.

### 10.2. Requirement

Core requirement ссылается на единственный pinned `workspace.storage.audit.v2` contract, exact canonical input и canonical claim set по claim ID, равный фиксированным 28 template rows Protocol §9.4. `matchPolicy='exact'`; generic subset/mapping interpreter отсутствует. Required/partial semantics берутся только из admitted candidate + generated `GoalRequirementV1`; partial completeness/freshness denial coalesces once per requirement/evidence, а не дублируется на каждый claim. Для partial evidence admitted `allow-disclosed` выбирает единственный no-detail denial и verdict `partial`; forbidden policy выбирает только `partial-not-admitted` и `blocked`, обе строки одновременно запрещены. Safe observed TypedValues могут сохраняться в partial assessment, но `requireCompleteObservation=true` не считает их satisfied для `verified`; status + unresolved denial проходят losslessly в view/result и renderer обязан маркировать их partial.

### 10.3. Claim

Claim использует frozen `SelectorDescriptorV1` (ID/body + exact `capability-output|evidence-node` source/schema digest + RFC 6901 pointer + expected type/encoding) и typed predicate literal. Free-form JSON Pointer, untyped `JsonValue expected`, worker label `verified` и ambient renderer reads запрещены. Raw output и projector-derived walk verdict cannot share an implicit selector namespace. Exact integer начинается как decimal/BigInt внутри producer и остаётся canonical string до `TypedValueV1` projection.

### 10.4. Compilation rules

1. Один bounded first-party deterministic matcher компилирует exact persisted admission и проходит закрытую clause/candidate legality matrix до target resolution.
2. Negation, prohibition, unknown modality, clause/message ranges, target, temporal meaning and partial intent фиксируются до Goal; positive execution требует complete target, exact explicit interval, empty ambiguity set и ровно один selected candidate, а unsafe clause нигде в том же admission не может быть скрыта как informational.
3. Missing/ambiguous target, requested field или temporal class → `clarify|blocked`, не догадка/answer fallback.
4. Compiler не имеет model/network/provider доступа.
5. Goal source exact-связывает admission/body/candidate/message/command; raw reparse запрещён.
6. Core creates exactly one requirement and no dependency/order graph.
7. Final Goal, retained minimum and GoalAdmissionBinding repeat the same semantic body and authority refs; any difference blocks admission.
8. Semantic follow-up/retry creates a new linked Execution; core does not import prior evidence or revise a Goal in place.

### 10.5. `logicalBytes` в Astra V3

Flagship contract — exact generated `workspace.storage.audit.v2` из Protocol §29. Runtime не дублирует его JSON/TypeScript. Архитектурный смысл:

- metric `logical-namespace-entry-bytes.v2` считает logical EOF length каждого включённого regular-file namespace entry; hard-link names считаются отдельно, sparse/compressed — logical, directories/allocated blocks/ADS исключены exact policy;
- walker принимает lengths как decimal/BigInt с первого операнда, никогда не через JavaScript `number`;
- capability output содержит canonical decimal `/audit/logicalBytes`, raw `walkerDisposition` и exact accounting-proof/root/volume/policy/attested-temporal bindings;
- output всегда несёт `abortReason='none'|<exact code>`; proof omits abort/witness only for completed and requires the same non-`none` code plus closed limit witness for a budget abort, включая отдельный `path-limit`, поэтому Presentation не читает diagnostic bytes;
- capability не объявляет authoritative coverage. Evidence Projector выводит `walk-completed-without-local-error` только в immutable EvidenceNode после cross-check Kernel-admitted proof, all counters/digests/accumulator, target/policies, start-finish identities, monotonic clock attestations и exact dynamic budget proof: positive finite file/directory/path/time/I/O/cancellation limits, zero-or-greater depth, observed maxima, entry/I/O/return/terminal check equations, nonzero cadence, bounded cancellation gap and within-limits/not-cancelled terminal markers;
- core допускает только `interval-observation + mutationDetection='not-supported'`; detector, stable-window и point-in-time schemas отсутствуют и должны быть отвергнуты, а не оставлены optional branches;
- interval walk никогда не подменяет current snapshot/stable-set claim. Current/stable intent clarifies/blocks before Execution; `partial` разрешён только explicit Goal policy и не является verified success;
- protected boundary проверяется Kernel до выдачи root/child handle. Capability не видит имя/путь/счётчики Safe; fixed public disclosure всегда содержит generic `policy-restricted` with withheld count, а exact non-protected exclusion counter никогда не включает protected boundary;
- legacy output остаётся diagnostic: current `logicalBytes:number`, JS accumulation и `mutationsObserved=0` не могут быть compatibility-upgraded или получить V3 certificate.

Первый допустимый artifact — schema/fixture package на newly created disposable root вроде `<repo-root>\.test-tmp\agent-core-read\case-logical-bytes`. Drive roots, production/user roots и Monarch Safe запрещены. Только после successful artifact review может появиться отдельный shadow go/no-go.

Normative decision table:

| Goal temporal class | Required evidence | Возможный verdict |
|---|---|---|
| `interval-observation` | exact value + derived walk verdict + interval disclosure + `mutationDetection='not-supported'` | `verified` only for observed interval fact |
| point-in-time/current intent | unavailable future snapshot profile | clarify/block before core Execution; no certificate |
| stable-window intent | unavailable future detector profile | clarify/block before core Execution; no certificate |
| admitted interval Goal + incomplete/error/skip/abort/identity mismatch | proof insufficient | `partial` only under exact Goal gates, otherwise certified `blocked`; never verified |

## 11. Agent Capability Contract

Существующий `MonarchCapability` остаётся Kernel-facing contract. Agent core не превращает его в giant optional manifest: generated `AgentCapabilityContractV1` — closed schema и единственный admitted instance `workspace.storage.audit.v2`.

Он pin-ит input/output schemas; matcher descriptor body + raw implementation hash; claim-template refs; verification recipe + projector hash; target-resolver/walker/adapter hashes; exact interval-only class; inclusion/exclusion/budget policies; read-only execution constants; Presentation/transport refs. Capability transport ref обязан быть byte-equal manifest transport ref, его digest — identity того же retained profile; per-object/total/root-depth/ref-occurrence/schema-closure counters не могут различаться между parser, manifest, capability и fixture oracle. Accounting proof walker hash обязан совпасть с contract, а не выбирается worker-ом. Отдельных predicate/selector registries, workflow/reconciliation/compatibility/plugin bags нет. Generic legacy mapping запрещён; missing semantic proof blocks.

### 11.1. Contract restrictions

- first-party static registration only;
- `runtimeProfile='agent-core-read.v1'`, local read, no mutation/network/approval/provider;
- exact contract/body refs survive assessment retention; implementation digest is provenance, not promise an old binary remains executable;
- output schema/selector/fixture/receipt/projector/certificate/renderer share one digest chain;
- a legacy `verification.kind='schema'` label without an actual admitted output schema is not
  schema proof. The isolated real V2 G2 workspace-read capture observed exactly this combination
  (`outputSchema.declared=false`, `valid=null`) alongside V2 `verified`. Astra must reject its
  promotion to typed/schema-validated evidence; the capture's exact-content fixture check is
  test evidence only, not a replacement capability contract;
- third-party/MCP/plugin authority is a separate undecided `agent-plugins.v1` profile;
- effects require their own versioned capability schema, Action Ledger ownership ADR, threat model and recovery fixtures.

---

## 12. Capability Catalog и progressive discovery

> **Future `agent-catalog.v1` design; unavailable in `agent-core-read.v1`.** Core binds the one `workspace.storage.audit.v2` contract directly by allowlisted ref/digest from Admission through Goal, Invocation and Assessment. No catalog snapshot/search/inspect object, event, activation or synthetic inspect receipt may appear in a core trace.

### 12.1. Три операции

```text
catalog.search(query, scope) -> bounded summaries
catalog.inspect(capabilityId, expectedCatalogRevision) -> exact contract + digest
invocation.propose(capabilityId, schemaDigest, input) -> admission result
```

Это protocol operations Runtime Host, а не прямые Kernel tools.

### 12.2. Search

Search ранжирует только eligible-by-surface/provider catalog, но permission/approval не скрывает capability. Результат содержит:

- ID/title/summary;
- effect/risk profile;
- required runtime/credential state;
- availability reason;
- contract version/digest;
- `inspectRequired=true`.

Index может сочетать deterministic tokens, aliases, examples и local embeddings. Hard-coded domain hints из core resolver должны стать catalog-owned routing data.

### 12.3. Inspect-before-propose

Invocation admission требует, чтобы activation уже инспектировал exact schema digest. Первая blind proposal не исполняется; host возвращает bounded schema and records `catalog.inspected`. Это устраняет tool-schema drift и скрытую подмену capability.

### 12.4. Required capability

Capability, указанная GoalContract, pinned в context независимо от lexical score. Если она отсутствует:

1. catalog refresh;
2. bounded search по exact ID/declared compatibility;
3. optional install/discovery proposal;
4. user-visible block.

Переход к `models.agent.synthesize` или другому read tool не удовлетворяет missing operational requirement.

---

## 13. Runtime Host и Engine Driver Protocol

> **Future `agent-engine.v1` design; unavailable in `agent-core-read.v1`.** Schema lab calls the deterministic fixture directly. Nothing in this section is a base-manifest dependency.

### 13.1. Runtime Host

Host владеет:

- driver registration/health/capability descriptor;
- one activation ↔ one driver generation binding;
- context projection;
- normalized runtime events;
- safe-boundary steering;
- cancellation/timeout;
- SDK resume token encryption/storage, если он существует;
- crash normalization.

Перед каждым cloud/hybrid `open/submit/steer` Host вызывает отдельный Egress Gate. Driver не получает context, пока Gate не создал exact `EgressAdmissionPermit`, связанный с `ProviderExecutionGrant`, execution/goal revision, activation, driver/provider/terms identity и frozen egress manifest/context digest. Permit доказывает только authorization-to-attempt, не transmission. Transport lifecycle отдельно пишет `EgressAttempt`/outcome.

In-process driver с ambient `fetch/socket` не является security boundary. Provider V3 требует broker process с OS/firewall/AppContainer-equivalent outbound confinement и authenticated bounded IPC; только broker consume-ит permit, пишет attempt/ingress transitions и видит network handle. Если supported Windows build не доказывает confinement, cloud/hybrid cohort disabled. Response имеет отдельный `ProviderIngressReceipt`: contiguous chunks, bytes/data classes, protected raw ref, schema/redaction admission and unknown/rejected outcomes. Provider content не evidence до projector.

Host не владеет Kernel policy, GoalContract, approval или completion.

### 13.2. Driver

Минимальный driver contract:

```ts
interface AgentEngineDriverV1 {
  descriptor(): EngineDescriptorV1;
  open(input: EngineOpenV1): Promise<EngineHandleV1>;
  submit(handle: EngineHandleV1, input: EngineTurnInputV1): AsyncIterable<EngineEventV1>;
  resolveDecision(handle: EngineHandleV1, input: EngineDecisionResolutionV1): AsyncIterable<EngineEventV1>;
  steer?(handle: EngineHandleV1, input: EngineSteerV1): Promise<EngineSteerReceiptV1>;
  cancel(handle: EngineHandleV1, input: EngineCancelV1): Promise<EngineCancelReceiptV1>;
  close(handle: EngineHandleV1): Promise<void>;
}
```

Persisted layer хранит только neutral events и opaque encrypted resume token metadata. Concrete SDK message union не сериализуется как Monarch schema.

Каждый normalized decision имеет server-created envelope:

- engine session ID и submit ID;
- driver event sequence;
- activation ID/generation;
- exact context, GoalContract, plan и catalog digests;
- last safe-boundary ID;
- steering/compaction epoch;
- driver descriptor digest.

Admission делает CAS всех этих refs. Buffered decision из pre-steer/pre-compaction context получает `stale-context` даже внутри той же activation generation.

### 13.3. Первый driver

Первый V3 driver использует текущий local inference backend только как
**transport-only adapter**. Он может отправить exact prompt/schema/grammar и вернуть
raw bytes/stream/usage/health/cancellation telemetry, но не может сохранить внутри:

- общий optional-field decision schema или legacy strict union parser;
- Fast→Balanced escalation/retry policy;
- capability resolution, Goal interpretation или context trimming;
- Task/verified state mutation.

Tier/model/lease scheduling принадлежит Resource-aware Host/Scheduler; branch schema,
canonicalization и parsing принадлежат Decision Gateway. До включения driver legacy
`ModelDecisionProvider` разделяется по этим ownership seams. Wrapper вокруг его
нынешнего `decide()` целиком запрещён: он сохранил бы brittle ABI и скрытые model
turns под новым интерфейсом.

### 13.4. Driver capabilities

Descriptor объявляет, а conformance tests доказывают:

- streaming;
- safe-boundary steering;
- resume token;
- native tool proposal;
- structured decision;
- usage metrics;
- compaction notification;
- cancellation acknowledgement.

Descriptor содержит exact provider ID, runtime/model identity class и terms/data-flow profile ref, а не только `local | cloud | hybrid`. `cancel()` возвращает typed acknowledgement receipt; `Promise<void>` не является доказательством остановки runtime.

Если feature не поддержан, descriptor возвращает `false`; host не имитирует его prompt-ом.

---

## 14. Разложение текущего AgentLoop

Цель — не «разнести 6721 строк по файлам», а установить ownership seams.

| Target service | Владеет | Не владеет |
|---|---|---|
| `ExecutionScheduler` | activation leases, wake, fairness, budgets | goal semantics, Kernel effect |
| `GoalCompiler` | typed requirements/claims/revisions | model execution |
| `PlannerService` | plan proposals/admission/revisions | completion |
| `CapabilityCatalog` | search/inspect/snapshots | permission decision |
| `DecisionService` | driver request/normalized proposal | direct state mutation |
| `WorkflowEngine` | static state transition/allowed next actions | Kernel authority |
| `InvocationCoordinator` | prepare/approval/dispatch/reconcile lifecycle | effect implementation |
| `EvidenceProjector` | receipts → typed evidence graph | semantic goal creation |
| `CompletionCertifier` | deterministic terminal verdict | synthesis/tool calls |
| `PresentationService` | user wording from certified view | proof |
| `RecoveryService` | crash classification/resume policy | blind replay |

### 14.1. Что происходит с `trusted*` branches

- Workspace batch/pagination → `workspace.audit.workflow.v1` / `workspace.batch.workflow.v1`.
- Application discovery/open → `device.application-resolution.workflow.v1`.
- Computer Use sequence → `computer-use.exact-window.workflow.v2`.
- Direct operational sequence → generic ordered GoalRequirements, без capability-specific core switch.
- Grounded synthesis → Presentation Service.
- Required capability discovery → Capability Catalog policy.
- Duplicate inspection repair → generic progress/fingerprint guard in Workflow/Planner admission.
- Completion helpers → GoalClaim templates + Certifier.

До удаления каждой старой ветки обязателен behavior parity test; физическое перемещение без contract замены не считается прогрессом.

---

## 15. Workflow Contract

> **Future workflow/effect design; unavailable in `agent-core-read.v1`.** Core has no workflow interpreter or free-form transition mapping.

### 15.1. Назначение

Workflow нужен, когда capability sequence имеет deterministic domain constraints, которые нельзя безопасно доверить свободному model planning: Computer Use, paginated audit, exact application resolution, reconcile-before-retry.

```ts
interface WorkflowDefinitionV1 {
  schemaVersion: 'monarch.workflow-definition.v1';
  id: string;
  version: string;
  bodyRef: string;
  bodyDigest: string;
  stateSchemaDigest: string;
  interpreterVersion: string;
  interpreterImplementationDigest: string;
  predicateRegistryDigest: string;
  initialState: string;
  terminalStates: string[];
  allowedCapabilityIds: string[];
  states: Record<string, {
    allowedCommands: string[];
    transitions: WorkflowTransitionV1[];
    retryPolicy: RetryPolicyV1;
  }>;
  budgets: WorkflowBudgetV1;
}
```

### 15.2. Ограничения

- Workflow definition не содержит произвольный JS/Python код на первом этапе.
- Guards выбираются из bounded built-in predicate registry.
- Каждый transition пишет journal event.
- Workflow не создаёт approval; он только запрашивает invocation.
- Allowed capability set пересекается с task scope.
- Model может выбрать только разрешённый transition proposal.
- Workflow output становится evidence только через receipts/selectors.

### 15.3. Computer Use

Сохраняется текущий принцип:

```text
fresh exact-window observation
  -> deterministic target resolution
  -> one admitted effect atom
  -> Kernel action
  -> fresh readback
  -> postcondition claim
```

Screenshot/UIA/model text сами по себе не доказывают effect. Если window identity меняется между observation и action, invocation invalidates и возвращается к observation state.

### 15.4. Workflow ownership и Strategy architecture proof

Отдельный P13/A22 contract строит exact inventory всех `36` `trusted*/isTrusted*` domain helpers
в текущем `agent-loop.ts`. Каждый helper обязан иметь ровно одного будущего owner; четыре
migration families имеют `SourceDiffManifestV1`, а deletion gate допускает в projected core только
generic workflow/task/scheduler/invocation/certification operations. Любая capability/application
строка, неизвестная ветка, duplicate owner или arbitrary-code workflow definition отклоняется.

P14/A23 contract исполняет Strategy Selector до модели. Runtime-owned Task Graph получает IDs,
Requirement bindings и acyclic dependencies. Exact read `Прочитай E:/fixture/value.txt` выбирает
`deterministic-recipe`, два nodes и текущий exact capability ID `workspace.files.read` с
`0` planning/total model calls;
registered workflow также имеет `0` planning calls, а open-ended path ограничен одним planning
call. Disabled/untrusted/ambiguous вход не сваливается в свободную модель.

Node/Python совпали на `16/16` scenarios: `36/36` ownership, projected core violations `0`,
exact-read calls `0/0`; отклонены `37/40` resealed source/artifact attacks. Evidence:
`sha256:8a928ea5e8aac626986e4bb2bf95f739e10eb74472018c914157d0e42ae209ea` /
`sha256:8190f6146ced678f79e57566956f709676615402b0570c980095d3e852cbb6d0` /
`sha256:865d57ea79a75d6ae39cb8305a2b148a4d4e07573cf2520668f5819e9bce9a60`.
Это isolated architecture projection: V2 source физически не decomposed, ProductFacade/A22/A23
не исполнялись и product readiness не повышается автоматически.

### 15.5. Product Facade / Runtime Readiness composition proof

P07/A07–A08/A15/A35 объединены в одну architecture-only state machine. Persisted Interaction
не создаёт runnable Execution само по себе. Exact `ExecutionReadinessReceiptV1` связывает
authority root, Catalog, policy, composition manifest, Store, Kernel и Scheduler generations,
остаётся authority-neutral и повторно проверяется в Scheduler activation. Stale generation,
expiry или unavailable component дают typed waiting/blocked без dispatch.

`modelRequirement=none` не имеет Model Host/inference dependency; `immediate` требует fresh
Host/model/engine/context-bound inference receipt на каждый model turn; `deferred` означает
только durable queued. После Kernel effect receipt recovery сохраняет receipt/evidence,
выпускает новые readiness + synthesis inference receipts и не повторяет effect. Runtime lane
`astra-v3` принимает effect только с `astra-core-experience.v1`; `agent-core-read.v1` и
link/manifest mismatch отклоняются до dispatch.

Node/Python прошли `18/18` scenarios (`A07=5`, `A08=3`, `A15=7`, `A35=3`): `6` blocks до
Execution, zombies `0`, model-free inference admissions `0`, duplicate effects `0`, reference
oracles `6/6`; отклонены `20/31` resealed source/artifact attacks. Evidence:
`sha256:8ca2b566cc6cd5d0da3ab0ea855d79e5c6fd5cc885ba715b4b77016efd4ac06b` /
`sha256:c6f0a7c376c13604ea409df6c7cb9fc5f6fc19fc5125e4e53ed2109b9ab6cbd0` /
`sha256:54ba405bad7aaed26229a260fd044b32c2de8e5d050a462621540ca263eeca99`.
Это не product execution evidence: V2 route, model, persistence и installed runtime не запускались.

### 15.6. Первый shadow migration slice остаётся V2-authoritative

Machine plan использует точный live ID `workspace.files.read`. Shadow evaluator не получает
Kernel/Application gateway, не делает второй filesystem read и не создаёт Astra Execution,
certificate, product persistence или user outcome. Единственный V2 Kernel receipt подаётся в два
assessment path; comparison сохраняет только bounded digest/code parity без raw path/content.

План имеет шесть отдельных gate `S0..S5`; сейчас разрешён только plan-only `S0`.
Fixture shadow, local canary, selected-lane cutover и physical deletion требуют разные owner
go/no-go. Любой semantic/authority/privacy/crash fault монотонно выключает только shadow generation;
V2 продолжает исходный outcome. Automatic cohort ramp и automatic re-enable запрещены.

Node/Python прошли `24/24` plan scenarios: shadow dispatch `0`, V2 outcome changes `0`, raw
comparison payloads `0`; caught semantic/authority/privacy `5/3/2`, отклонены `28` policy и
`22/30` resealed source/artifact weakenings. Evidence:
`sha256:7360beede20c164706c67bcc92deb2a7d8553b37e630aa2f351d6f23843e9005` /
`sha256:2d8d4884fff2fdfac8f3deaf49121cd62ad0edf9d9c37fee28f1e75f589ad3c4` /
`sha256:af0f5813636def3dfaf8cde625bd07136f076f335b7adeaa4e2f251e09de3498`.
`shadowImplementationAuthorized=false`, `physicalDeletionAuthorized=false`.

### 15.7. Closed `astra-core-experience.v1` manifest package

Composition теперь не остаётся prose-only названием. Machine source сводит `14` foundation
profiles, `5` mandatory packs и `16` release components, сверяя release matrix, A01–A41 manifest,
problem closure, Product Facade, Workflow, Scheduler, Resource Host, Context, Memory, Computer Use
и `agent-core-read.v1`. Generated schema/instance — closed-world и не может добавить неизвестный
profile/component, дублировать binding, заменить `workspace.files.read` invented ID или провести
effect через read substrate.

Текущий instance намеренно non-retained: `candidateDefinitionDigest=null`, missing retained
components `16`, authority/grant/permit/token/path scope отсутствуют, product route/installed/
real-model/fault acceptance и owner go/no-go не записаны. Даже полностью самоподписанный JSON не
может выставить readiness: Node/Python отвергли `27/25` resealed source/artifact attacks, а
`18/18` scenarios оставили composition blocked. Digest chain ацикличен: source → candidate seal →
generated manifest → Execution link; Facade source не имеет права embed-ить будущий retained
manifest digest обратно в собственный source graph.

Source/artifact/manifest/schema/independent evidence:
`sha256:7caec2b71a5d516db9cce1c4d5d014828ac673892988188e77b1a2bafcf37500` /
`sha256:4a90a82c7d8444a9967baadd1a128a7c35ee7ddee6af6ab7fa2bb713b60b4933` /
`sha256:4f41e10ac9f143137177b00070b319bb1a0f28cac6b78c10942866a73d76afce` /
`sha256:f6886f460328c262d8c913a04b09b8609895b58be763beb21ee6f0bf8af24da0` /
`sha256:dc14245376712cb54e2bd1da1b8d1243cf69e7d10631d25cd34e81d12d82afb0`.

---

## 16. Invocation и Kernel boundary

Core uses only the pinned local read Invocation from Protocol §16 and one Execution-store-owned read dispatch record. Approval/Action Ledger/effect semantics below are future `agent-effects.v1` design and confer no current authority.

### 16.1. Lifecycle

```text
prepared
  -> authorized
  -> dispatched
  -> observed
  -> output-checked -> settled
  \-> output-rejected
```

Отдельные terminal состояния:

```text
rejected | output-rejected | cancelled-before-dispatch | cancelled | failed | indeterminate
```

Это exact core read state enum из Protocol §16; creation transition — `none→prepared`. `verified` не является Invocation state: доказательная верификация принадлежит Evidence admission/Completion Certificate. Core допускает ровно одну Invocation; retry/semantic change создаёт новую linked Execution, а не `superseded` attempt. Receiptless post-dispatch state остаётся `indeterminate` и не terminalizes Execution; `assessment-input-invalid` ссылается только на exact settled Invocation, а generic `internal-error` разрешён лишь из `certifying` без Invocation/receipt/certificate branch. Noncertified block существует только как atomic suffix exact `goal.blocked` или pre-dispatch `invocation.rejected`; standalone/queued block и post-dispatch `budget-exceeded` запрещены. Approval/effect states принадлежат future extension schema, а не optional core variants.

### 16.2. Invocation envelope

Минимальные поля:

- invocation ID;
- execution/task ID;
- interaction/trace/correlation IDs;
- exact Goal + semantic-body + GoalAdmissionBinding-transitive authority refs;
- RuntimeFeatureSet, static capability and input/output contract refs/digests;
- canonical input + digest;
- exact read-only effect constants;
- exact domain-separated dispatch key body/idempotency digest repeated by the Kernel receipt;
- AuthorityScope + traversal budget refs/digests;
- cooperative cancellation literal; core has no independently mutable authorization revision;
- exact verification recipe ref/digest and lifecycle snapshot.

В момент `prepared` core pin-ит только перечисленные в Protocol §16 allowlisted refs/digests и raw implementation hashes: Goal/semantic/admission binding, RuntimeFeatureSet, capability/input/output, AuthorityScope, inclusion/exclusion/budget, verification recipe/adapter/projector and Presentation contract. Unlisted Kernel/effect/timeout/retention snapshot отсутствует. Missing historical body/hash blocks trace; raw implementation hash доказывает provenance bytes, но не обещает сохранить/запустить старый executable.

### 16.3. Effect guarantees

Весь subsection ниже относится только к будущему `agent-effects.v1`. В core schema lab один in-memory appender fixture атомарно создаёт transition + stable attempt и вызывает ровно один disposable read port step; product store/outbox/durability этим не заявлены, а Action Ledger не является вторым participant. До выбора co-located/ledger-owned/formal-outbox design и crash benchmark никакого product/cross-store atomic promise нет.

- Idempotent capability + stable provider-supported idempotency key: повторный Kernel dispatch допускается только если frozen contract и reconciliation прямо разрешают его.
- Non-idempotent до dispatch: safe cancel.
- Non-idempotent после dispatch без receipt: `indeterminate`, никаких auto retries.
- Receipt received but projection failed: replay projection from receipt/outbox, effect не повторять.
- Process crash after Kernel completed: Action Ledger reconciliation first.
- В будущем effect profile новая Goal/Execution до dispatch может только отменить старую prepared/authorized Invocation через её typed cancellation; core Goal вообще не меняет revision in-place. После dispatch semantic change не отменяет truth и не импортирует старое evidence в новую Execution.

Monarch гарантирует не «exactly-once во внешнем мире», а проверяемое: один admitted dispatch transition/attempt для non-idempotent invocation; после ambiguous outcome Monarch не создаёт второй dispatch. Provider retry разрешён только с его доказанным idempotency protocol. Текущий Action Ledger, который превращает interrupted `executing` в generic failure, недостаточен для V3: нужен V2/bridge с `prepared/dispatched/receipt/indeterminate` и frozen semantics refs.

### 16.4. Approval

Future `agent-effects.v1` design only; unavailable in core and not dispatch authority until its threat/arm/transaction profiles close.

Approval request фиксирует `ApprovalAuthorizationSnapshot`: stable invocation ID и authorization revision, GoalContract revision, capability/contract/effect-semantics digests, canonical proposal hash, policy/authority/privacy/provider snapshot, server-attested principal/surface eligibility, human-readable deterministic preview **и фактически показанные template ID/version/digest + preview digest**, expiry и arm policy. Preview строится из того же canonical input; approve другой render stale.

Process activation generation хранится для audit, но его смена после crash сама по себе approval не инвалидирует. Новая activation может использовать уже approved invocation только после Recovery Service заново сверит неизменность authorization snapshot, expiry/revocation и dispatch state. Goal/schema/proposal/policy/scope/provider change создаёт новую authorization revision и новую карточку.

Approval lifecycle:

```text
approval: pending -> approved | denied | expired | revoked
approval: approved -> revoked | expired only while invocation dispatchState=not-dispatched
arm attestation: issued -> consumed | expired | revoked
```

Approve из `pending` разрешён напрямую при `requiredArm=false`; при `requiredArm=true` он требует valid unconsumed ArmAttestation, но Approval state остаётся pending до atomic approve+arm-consume commit. Deny из pending никогда не требует arm. `arm-issued` — отдельная короткоживущая, one-use, principal/surface/approval-bound server attestation; raw UI boolean не arm. Durable `ArmAttestationV1` хранит exact approval/invocation authorization revisions, server-attested principal/surface/auth epoch, issued/expires timestamps, `issued|consumed|expired|revoked` и собственную entity revision. Он является child entity того же Execution aggregate: `approval.resolve` CAS-ит текущую Execution revision, Approval entity revision и, если arm обязателен, ArmAttestation revision; approve + arm consume записываются одним aggregate commit. Crash не создаёт промежуточное «armed approval» state. Arm expiry оставляет Approval pending и позволяет новую arm request, пока сам Approval не expired/revoked. Approval expiry/revoke — durable timer/policy events, которые будят workflow и не оставляют вечный `waiting-approval`. Background job без live approver может deny/cancel, но approve не обходит arm; execution переходит blocked + bounded notice. Persistent auto-approve не распространяется на Safe, external communication, financial, identity/security impact или child task без отдельной policy.

Binding fields не доказывают trusted human interaction сами. До effect RFC обязателен отдельный reviewed surface × capability × arm mechanism contract с main-process/OS/hardware proof, spoof/replay/accessibility fixtures и explicit ineligible surfaces. Пока его нет, required-arm capabilities unavailable. Dispatch дополнительно обязан атомарно revalidate current policy/revocation + Approval/Arm + invocation authorization in Action Ledger V2; approval commit alone не является permission to dispatch later.

---

## 17. Evidence Graph и Completion Certifier

### 17.1. Evidence node

Runtime не поддерживает ручное зеркало `EvidenceNodeV1`. Generated core schema в Protocol §18 допускает только Application/Kernel read receipt/admitted observation, immutable source/payload refs и собственный body digest. Model/engine/worker self-label, provider, artifact и child variants отсутствуют в core manifest. Для `logicalBytes` принимается только exact `application-kernel` read receipt.

Core Evidence snapshot имеет ровно один node и **не имеет edges/retry graph**. Node повторяет exact Kernel accounting-proof ref/digest и projector-derived `walkVerdict`; selectors явно выбирают `capability-output` либо allowlisted `evidence-node` field. `RequirementAttemptSelectionV1` фиксирует единственные Invocation revision + node ref/digest, поэтому Certifier после crash не использует ambient ID→store lookup. Zero/two nodes, missing/mismatched ref или конфликт дают denial. Retry creates a new linked Execution; supersession/derived/corroboration/child DAG belongs to future profiles.

### 17.2. Certificate algorithm

Для каждого required GoalRequirement Certifier:

1. Читает immutable `CompletionAssessmentInputV1`: exact Goal + semantic-body refs, Evidence graph snapshot, explicit attempt-selection and Invocation refs, AuthorityScope, capability contract, verification recipe, terminal policy, RuntimeFeatureSet, Certifier contract, canonicalization profile, Presentation contract and attested assessment time. Its exact immutable ref+digest survive request event → assessment body → terminal command → certificate, so recovery never performs digest-only/current-stream lookup. Certifier ref/digest must equal the one frozen by that accepted RuntimeFeatureSet and GoalAdmissionBinding, and terminal policy must equal that contract; selectors/predicates come only from Goal/claim templates, projector — from the recipe; ambient registries/dependency sets отсутствуют.
2. Разрешает exact selected settled Invocation точной capability/contract revision.
3. Проверяет canonical input binding.
4. Проверяет core authority `application-kernel`; effect/provider/child authorities отсутствуют.
5. Проверяет freshness и completeness.
6. Извлекает каждый claim по trusted selector.
7. Валидирует type + predicate.
8. Проверяет stream ordering, exact single Invocation revision/node selection and settled Invocation; retry/supersession/dependency DAG в core отсутствуют.
9. Проверяет отсутствие unresolved selected Invocation/required claim.
10. Создаёт immutable claim bindings с `TypedValueV1`.
11. Выдаёт deterministic assessment либо typed denial list.

### 17.3. Certificate

Runtime не дублирует certificate ABI. Protocol §18.3–§18.5 владеет discriminated global/requirement denials, assessment bindings с evidence/selector body digests, `CertificationKeyBodyV1`, commit command и certificate envelope.

`CompletionAssessmentBody` canonical/deterministic для exact fenced inputs. `certificationKey` использует отдельный domain над structured key body, не string concatenation и не assessment domain. Freeze-команда `completion.requested` имеет собственный stable appender command ID и резервирует другой `completionCommitCommandId`; assessment command и атомарные `completion.certified + execution.<terminal>` events повторяют только второй ID. Certificate ID/time/clock attestation создаются ровно один раз в atomic terminal commit; любой retry возвращает byte-identical stored envelope. Application revalidates input revisions и одним Execution commit пишет certification + terminal suffix; stale fence не оставляет certificate. Каждый core claim binding содержит воспроизводимый inline `TypedValueV1`; digest-only value и artifact/protected-ref branches отсутствуют.

### 17.4. Model completion

> **Future `agent-engine.v1` behavior; unavailable in core.** Core Application creates `CompletionRequestV1` deterministically after the one direct Invocation settles; no Driver proposal or next Activation exists.

Если Certifier отказывает в будущей Engine profile:

- recoverable missing observation → a separately admitted retry/new Execution under that future profile, never an implicit core Activation;
- missing capability/input ambiguity → waiting/block;
- budget exhausted → partial/failed;
- repeated proposal без state change → fail/ask, не бесконечный synthesis.

Модель не выбирает authoritative evidence IDs свободно: она может предложить refs, но Certifier строит binding из GoalContract и evidence graph самостоятельно.

Child-produced claims отсутствуют в core. Их future `agent-children.v1` binding обязан иметь parent requirement/claim IDs, admitted lineage/descriptor digest, child certificate/claim binding, consumed delivery/inbox receipt и aggregation policy; произвольный cross-execution EvidenceNode никогда не принимается.

---

## 18. Presentation и synthesis

### 18.1. EvidenceView

Generated `EvidenceViewV1`/`StructuredResultV1` из Protocol §18.6 — единственные presentation inputs/outputs. Presentation получает:

- certificate verdict;
- только разрешённые claim values;
- bounded warnings/partial reasons;
- exact empty artifact tuple in core;
- `ru|en` locale frozen in AcceptedCommandContext → GoalAdmissionBinding → assessment/certificate;
- exact unresolved-denial tuples, которые обязаны losslessly сохраниться в StructuredResult;
- никаких raw secrets или лишних tool outputs.

### 18.2. Два renderer path

1. **Deterministic renderer** для exact certified scalar/status/scope/window/exclusion/denial fields.
2. **Bounded language renderer** — future product/Engine profile only; unavailable in `agent-core-read.v1`.

`models.agent.synthesize` в target architecture не является Capability Catalog entry, model-selectable tool или operational requirement и не может закрыть GoalContract. Это Application-invoked post-certificate presentation adapter без tools/effect/raw-evidence authority.

### 18.3. Presentation validation

- Final verified/partial payload содержит exact 16 required data keys; final blocked имеет `requiredPresentationKeys=[]`, at least one exact unresolved denial и не выдумывает отсутствующие values.
- Prose проходит Claim Integrity и value consistency check.
- Operational `engine.text-delta` до certificate остаётся private. Только Host-owned finite status code может показать bounded non-factual progress; driver text не выбирает public status. Count/path/digest/effect success/terminal wording до certification запрещены.
- Application строит `EvidenceView` только из retained certificate ref/envelope; embedded assessment supplies Goal/admission/context/presentation refs and frozen locale, so no current UI/OS locale or digest registry is read. Deterministic renderer получает exact EvidenceView ref/digest, не raw receipts. Contract имеет ровно шесть `(locale,verdict)` plain-text templates: verified uses 16 data tokens/no unresolved, partial uses 16 + one unresolved token, blocked uses only unresolved and has no claim fields. Exact two-locale denial table covers all 27 legal denial rows (54 messages); raw detail/diagnostics не рендерятся. Template tokenization одноразовая, denial messages brace-free, подставленные bytes inert и итог никогда не передаётся повторно в Markdown/HTML/template interpreter. Любой scalar, path, digest, status, locale, exclusion, unresolved item, template row or artifact вне certified bindings — либо потеря существующего unresolved item — отклоняет render целиком; artifact arrays in core are exact empty tuples.
- Mandatory window/temporal/mutation/exclusion disclosures являются Goal claims + `requiredPresentationKeys`, а не полями, которые renderer дочитал из raw output.
- Future product-facade persisted message хранит deterministic template ID/version/digest и exact structured-result digest; core lab заканчивается retained StructuredResult fixture и не пишет user message. Повтор после crash в будущем использует тот же template set из assessment fence.
- Renderer failure не отменяет certificate; Interaction получает recoverable presentation error и может повторить renderer без повторного effect/inspection.
- UI может отобразить structured facts даже при LLM synthesis failure.

---

## 19. Steering, follow-up и message ordering

> **Future `agent-engine.v1` / `agent-product-facade.v1` design; unavailable in core.** Core follow-up semantics are the immutable new-Execution/answer/clarify/reject rules in §9.1; no steer/safe-boundary/message-persistence event exists in the core manifest.

### 19.1. Persist-first steering

Follow-up сначала записывается как Interaction command/event. Затем Application Service выбирает:

- `queue-next`, если driver не поддерживает steering;
- `steer-pending`, если safe boundary возможна;
- `new-execution`, если follow-up меняет цель после irreversible boundary;
- `reject/clarify`, если scope/approval конфликтует.

### 19.2. Safe boundary

Steering delivery разрешена только когда:

- нет незавершённого Kernel dispatch;
- workflow transition атом завершён;
- current journal/projection committed;
- driver generation совпадает;
- steering command не расширяет authority без новой goal revision/admission.

При каждом submit/continuation Host создаёт новый `engineSubmitId` и context/boundary epoch. После accepted steering предыдущий epoch закрывается. Любой поздний `decision.proposed` обязан нести исходные submit/context/goal/plan/catalog/boundary refs и будет отвергнут до `invocation.prepared`, если хоть один ref stale. Совпадения activation generation недостаточно.

### 19.3. Row ordering

Pre-steer assistant output закрывается как отдельная partial row, user follow-up получает собственную row, post-steer continuation создаётся после неё:

```text
U1 -> A1(pre-steer partial) -> U2(steer) -> A2(continuation)
```

Abort потока не используется как подмена steering. Если delivery receipt не получен, follow-up остаётся durable queued command.

Каждая assistant delivery дополнительно несёт exact predecessor/causation binding на уже
committed user/follow-up row. Outbox не имеет права считать порядок `listTurns`/создания объектов
доказательством и не доставляет assistant row до predecessor receipt; retry после crash сохраняет
тот же binding и message identity. Missing, stale, superseded или cross-conversation predecessor
делает delivery blocked/recovery-required, а не best-effort append.

Это требование подтверждено не только моделью угроз. Изолированный G1 прогон текущего V2
`POST /api/oscar/turns` обнаружил, что normal answer outbox создаёт assistant message без
`requiredPreviousMessageId`, тогда как startup terminal-repair такую привязку добавляет.
Наблюдаемый в fixture порядок `user -> assistant` совпал, но durable ordering не доказан;
поэтому G1 имеет status `ordering-gap-observed-not-baseline-not-shadow`. Astra не должна
переносить эту V2 асимметрию в Product Facade или считать её закрытой одним успешным прогоном.

---

## 20. Agent Journal и projections

### 20.1. Execution journal

Этот subsection описывает target requirements, не выбранный product backend. Core schema lab использует in-memory fixture events; additive V3, sidecar или V4 ABI/cutover нельзя выбирать до isolated durability/latency/backup benchmark. Если выбран journal lane, он append-only и содержит нейтральные domain events из Protocol V1. Обязательные envelope fields:

- event ID;
- stream/aggregate ID;
- monotonic sequence;
- event type + payload version;
- timestamp;
- command/causation/correlation IDs;
- expected/committed revision;
- activation generation;
- producer class;
- payload digest.

Один aggregate store является единственным physical appender/sequence allocator. External компоненты возвращают authenticated typed facts либо кладут их в durable outbox; Execution Application Service валидирует и атомарно append-ит domain events. Event `producer=kernel|runtime-host|...` — provenance, не write permission. Cryptographic signing is threat-profile dependent and не подразумевается словом typed.

`sequence` увеличивается на каждое event. `revision` увеличивается один раз на accepted command/atomic commit; все events одного commit имеют одинаковый `revision`, contiguous sequences и `commitIndex/commitSize`. `expectedRevision` сравнивается с aggregate revision. Это устраняет неоднозначность multi-event command replay.

Каждый commit имеет `commitId` и `commitDigest`, вычисленный по ordered canonical event bodies без самого digest. Replay сначала буферизует **всю** group `commitIndex=0..commitSize-1`, проверяет общий command/revision/size, contiguous sequence и group digest, и только затем применяет её к projection. Incomplete/corrupt tail не применяется частично: replay останавливается на предыдущем verified commit и переводит stream в corruption/repair-required; raw tail сохраняется/quarantined для диагностики, а не silently reset. SQLite backend обязан давать ту же logical group guarantee транзакцией.

### 20.2. Snapshot

Snapshot ускоряет load, но не является отдельной истиной:

- содержит last applied sequence и journal digest;
- полностью rebuildable;
- атомарно связан с appended events в одном store commit;
- corruption не приводит к silent reset; старый journal остаётся read-only evidence.

Outbox/inbox record для cross-aggregate delivery входит в atomic commit своего aggregate. Receiver inbox хранит `deliveryId + sourceStream + sourceSequence + fingerprint + appliedRevision`; sender ack не требуется для idempotent correctness и может безопасно повторяться.

### 20.3. Storage choice

Phase 0E измеряет три persistence topology, а внутри каждой допустимой topology — durable JSON/SQLite mechanics:

| Candidate | Authoritative ownership | Главный риск |
|---|---|---|
| additive AgentTaskStore V3 | Task V3 остаётся lifecycle/event owner и атомарно получает новые refs/projections | старый schema shape может стать перегруженным |
| sidecar evidence/certificate journal | Task V3 владеет lifecycle; sidecar владеет только immutable evidence/certificate axis, связанной exact atomic/outbox rule | cross-store recovery/backup ordering |
| full Execution Store V4 | новый journal владеет new-cohort Execution; V3 только read-only legacy adapter | migration/cutover/rollback complexity |

Выбирается наименьшая topology, проходящая одинаковый invariant suite. Format/topology decision принимается **после** real hardware fault/latency/backup benchmark; требования ниже — acceptance hypotheses, не разрешение заранее создавать V4:

- atomic append + idempotent command receipt;
- per-stream ordering;
- bounded recovery;
- crash-safe projection checkpoint;
- export/redaction support;
- E:/configured data root, не скрытый C: cache.

Benchmark использует disposable `E:` roots и как минимум Windows 10/11 на low/median supported hardware; измеряет p50/p95/p99 accept→commit, restart replay, corruption isolation, peak RAM/CPU, disk amplification, backup/restore order, migration/rollback duration and source complexity. До measurement exact ceilings ratified separately; placeholder/unbounded threshold is a no-go. Если candidate не может доказать atomicity without dual truth, bounded recovery or RPO/RTO, он удаляется из выбора, а не “допиливается” скрытым reconciliation owner.

### 20.4. Interaction journal

Turn V1 может продолжить использовать текущий Durable JSON aggregate в первых фазах. Объединять interaction/execution physical stores необязательно. Cross-aggregate связь строится через transactional outbox/idempotent inbox, а не через недоказуемый simultaneous file write.

---

## 21. Goal, Activation и Scheduler

> **Eventual `agent-engine/agent-effects/product-store` design note — unavailable in `agent-core-read.v1`.** Core has one immutable admitted Goal, direct deterministic host and no Activation, Scheduler, lease, wait/recovery command or model stream. Nothing in §21 may be imported into the first manifest or simulator.

### 21.1. Goal phases

```text
derived projection only:
draft | admitted | active
paused | waiting-user | waiting-approval
waiting-runtime | reconciling | certifying
blocked-indeterminate
completed | partial | blocked | failed | cancelled
presentation is not a Goal phase
```

`completed` требует verified Completion Certificate; `partial` требует завершённый assessment/certificate с разрешённой partial policy. `blocked/failed/cancelled` следуют Protocol §12 projection table и не обязаны выдумывать certificate. Goal phase не является process state и не имеет отдельного writer.

### 21.2. Activation

Activation содержит:

- ID/generation;
- runner lease owner + expiry;
- runtime driver/version;
- context/catalog/goal revisions;
- budget slice;
- recovery reason;
- cancellation token state;
- safe-boundary marker.

Только Scheduler создаёт activation. Resume command не продолжает старый process handle; он создаёт новую generation после recovery evaluation.

Pending/approved authorization принадлежит stable Invocation, не Activation. После новой generation Scheduler либо продолжает ждать ту же карточку, либо использует уже approved authorization после exact frozen-snapshot revalidation. Новая model proposal для этого не требуется.

### 21.3. Scheduling

- one active lease per Execution;
- interactive work выше background, но без starvation;
- current InferenceCoordinator lane policy сохраняется как infrastructure constraint;
- busy runtime → waiting-runtime, не parallel model corruption;
- wake reasons explicit and revision-bound: user command, approval, runtime available, timer, catalog/capability availability, credential state, policy state, provider grant, child delivery, recovery evidence. `request-wait` always cites one condition + finite expiry/max-wait policy; unchanged fingerprint is not progress.

### 21.4. Scheduler/Recovery architecture candidate

Отдельный P10/A19/A33–A34 machine contract теперь закрепляет точный минимум будущего профиля:

- `ActivationLeaseV1` связывает execution, scheduler/activation generations, readiness digest,
  durable cancellation generation, owner, heartbeat/start-by/deadline/expiry и CAS revision;
- takeover разрешён только после expiry; competing schedulers используют один expected revision,
  поэтому live activation получает ровно одного нового owner;
- `InvocationAttemptV1` получает durable reservation непосредственно перед driver call. Dispatch
  повторно сверяет owner, activation и cancellation generations; stale owner и accepted cancel
  fence-ят вызов;
- `AcceptedCancelV1` — durable linearization point, а `EngineCancelReceiptV1` — отдельное
  доказательство доставки отмены до exact Host/driver/turn generation. Unknown dispatched outcome
  остаётся `indeterminate`, не маскируется как `cancelled`;
- `RecoveryCaseV1` хранит fault point, старую lease/invocation identity, классификацию и bounded
  horizon. Non-idempotent unknown не retry-ится; late receipt создаёт append-only
  `LateCorrectionV1`;
- resume после Host crash всегда создаёт новую activation/readiness, full context rehydrate и
  fresh inference admission/lease только когда следующему шагу действительно нужна модель.

Изолированный deterministic simulator прошёл `20/20` A19/A33/A34 cases: `0` post-cancel
dispatches, `0` duplicate effects, `0` zombies after horizon, `1` concurrent CAS winner. Node
отверг `33/33` resealed source attacks, независимый Python — `38/38` resealed result attacks;
artifact replay byte-identical. Evidence:
`sha256:9e6b5e8cb536977c2b14ef2fdf52ca36b0efe27e0c3e3199157c14a9f653cbe4` /
`sha256:c791dabeb63cae4ba889949e99d294fb2141dbb8b80e567bd6f80a82f0dc9d2e` /
`sha256:a56a4534fb7bd64291c153475da3fb21808c1c9b3bfc2a10b1186c8892f6a7ec`.
Это profile-level architecture proof, не product Scheduler implementation и не исполнение
acceptance fixtures на установленном Monarch.

---

## 22. Recovery matrix

> **Eventual product/effect recovery matrix — unavailable in `agent-core-read.v1`.** For the core fixture, pre-dispatch failure blocks before a port call, known read receipts terminate through the closed Protocol events, and `invocation.indeterminate` yields an unresolved nonterminal trace that forbids certificate/presentation/product import. Scheduler, Approval, Action Ledger, provider, child, compaction and `RecoveryCaseV1` rows below require their separately generated profiles.

| Crash point | Authoritative fact | Recovery |
|---|---|---|
| До command commit | команды нет | client повторяет idempotently |
| После command commit, до activation | queued command | Scheduler создаёт activation |
| Во время model stream | нет admitted proposal | discard partial runtime stream, новая generation |
| Proposal записан, invocation не prepared | journal proposal | admission повторяется idempotently |
| Prepared, approval pending | exact approval request | ждать пользователя, не re-prompt model |
| Approval approved, до dispatch | stable invocation authorization snapshot | новая activation revalidates и делает максимум один dispatch; generation change не требует approval сама по себе |
| Authorized, до dispatch | Action Ledger state | dispatch по idempotency policy |
| Dispatch неизвестен | `indeterminate` | reconcile; non-idempotent не повторять |
| Kernel completed, receipt projection не записана | Kernel/Action Ledger receipt | replay projection/outbox |
| Evidence есть, certificate нет | evidence graph | Certifier повторяется как pure operation |
| Certificate есть, message не persisted | certificate + Interaction outbox | повторить только presentation/delivery |
| Steering persisted, driver receipt отсутствует | queued steer command | redeliver при compatible generation или queue-next |
| Child completed, parent delivery не consumed | child certificate + mailbox | CAS delivery retry |
| Compaction start без end | raw journal + bracket | discard incomplete compact surface |

Если cancellation застала dispatched invocation с неизвестным outcome, Execution переходит `cancellation-pending -> reconciling -> blocked-indeterminate`, а не terminal `cancelled`. Для каждой такой invocation атомарно создаётся `RecoveryCaseV1`:

```text
opened -> reconciling -> resolved
                     -> blocked
blocked -> reconciling
blocked -> permanently-unknown
permanently-unknown -> resolved (resolutionKind=late-receipt)

presentation flag (orthogonal): visible | acknowledged | archived
```

Protocol commands/facts:

- `recovery.request-reconciliation` — explicit user/system wake, выполняет только frozen read-only reconciliation recipe и никогда не повторяет source effect;
- `recovery.receipt-observed` — internal exact late Kernel/provider receipt;
- `recovery.acknowledge` — пользователь подтвердил, что увидел uncertainty; truth state не меняется;
- `recovery.archive-view` — убирает case из active UI, но не переименовывает outcome и не удаляет tombstone;
- `recovery.mark-permanently-unknown` — system transition только когда frozen recipe unsupported/exhausted; late receipt всё ещё может resolve.

Resolution возвращает Execution из `blocked-indeterminate` в `certifying`, `partial`, `failed` или known `cancelled` согласно exact receipt/Goal state. Interaction может закрыть исходную row как `blocked: runtime stopped, effect outcome unknown`; late resolution создаёт idempotent `interaction.append-recovery-correction` delivery, а не переписывает старую row молча.

Retention двухуровневый и записан в case:

- full sensitive evidence/ref pin имеет bounded `fullEvidenceRetainUntil`, выбранный frozen capability/policy и показанный пользователю;
- после него full payload может быть crypto-erased/compacted только если дальнейшая automated reconciliation невозможна, но минимальный immutable tombstone удерживается без auto-GC до resolution: execution/invocation/action-ledger/provider correlation IDs, canonical input digest, effect semantics/reconciliation digests, state и timestamps — без raw payload;
- обычный UI archive/retention cleanup tombstone не удаляет;
- unresolved case count/bytes имеют quota; превышение блокирует новые non-idempotent effects или требует user cleanup, но не silently удаляет старую truth.

V1 намеренно не объявляет `recovery.erase-data`: удаление unresolved correlation tombstone сделало бы поздний receipt непривязываемым и могло бы превратить неизвестность в ложный outcome. Будущая общая data-erasure policy требует отдельного ADR и не может masquerade как RecoveryCase resolution; до него V1 сохраняет минимальный non-payload tombstone.

Scheduler не spin-ит: wake возможен только по late receipt, explicit reconciliation command или bounded policy timer. Repeated wake с тем же evidence fingerprint idempotent.

---

## 23. Child tasks / subagents

> **Future `agent-children.v1` design; unavailable in core.**

Subagents не нужны для первого `logicalBytes` slice, но protocol должен не блокировать их безопасное добавление.

### 23.1. Child descriptor

- child execution ID и parent ID;
- immutable lineage/depth/fanout;
- exact delegated GoalContract subset;
- capability scope = intersection parent/policy/descriptor;
- budget slice;
- privacy/provider constraint;
- approval policy, default deny when live human unavailable;
- expected deliverables/claim IDs;
- exact delegated parent requirement/claim IDs и aggregation policy;
- delivery mailbox ID;
- cancellation/orphan policy.

### 23.2. Invariants

1. Child — полноценный durable Execution с отдельной activation и certificate.
2. Parent text не даёт child больше authority, чем descriptor.
3. Approval parent не наследуется.
4. Child final text — untrusted report; parent consumes certificate/evidence refs.
5. Parent completion ждёт required child claim deliveries.
6. Accepted child delivery не теряется молча: states `accepted -> available -> consumed | rejected | expired`.
7. Parent cancel propagates according to explicit policy; detached background child запрещён по умолчанию.
8. Depth/fanout/concurrency/budget bounded system policy.
9. Parent Certifier принимает child proof только через `DelegatedClaimBinding`: admitted lineage/descriptor, child certificate/body digest, exact child claim, delivery ID и parent inbox apply receipt.
10. Consume CAS использует current parent revision в command, но durable dedupe принадлежит delivery ID/inbox fingerprint; два children, созданные на одной старой revision, могут быть применены последовательно после re-read, а не становятся навсегда stale.

### 23.3. Delegation strategy

Первый release поддерживает tree, не arbitrary cyclic graph. Один claim имеет одного authoritative producer; несколько children могут дать candidates только по frozen `all|any-one|ordered` selection policy, которая выбирает существующие child claim bindings и не вычисляет новое значение. `typed reduce` запрещён до отдельного child-derivation RFC: он обязан стать versioned pure VerificationRecipe, создать новый `admitted-observation` EvidenceNode с `derived-from` edges, type/overflow/determinism rules and transitive retention. Aggregator без такого recipe не создаёт fact/evidence и не принимает unrelated child execution.

---

## 24. Durable jobs и background work

> **Future `agent-jobs.v1` design; unavailable in core.**

Job не является вечной «активной сессией». Schedule fire создаёт новую idempotent command/Execution либо explicit sticky continuation с revision fence.

Обязательные поля:

- job/schedule/run IDs;
- owner/surface/privacy/provider scope;
- goal contract template revision;
- next fire + timezone;
- idempotency key per fire;
- concurrency policy: skip/queue/replace, default skip for busy sticky execution;
- side-effect retry policy;
- notification/delivery policy;
- max notices/wake budget;
- cancellation and retention.

Background run не может ждать невидимый human approval бесконечно. Он блокируется и отправляет bounded notice; effect не auto-approves.

---

## 25. Compaction

> **Future `agent-compaction.v1` design; unavailable in core.**

Compaction уменьшает только model-visible surface.

### 25.1. Protocol

```text
compaction.requested
compaction.started(baseSequence, targetBudget)
compaction.completed(summaryRef, coveredRange, sourceDigest)
```

или `compaction.failed`.

### 25.2. Rules

- raw journal immutable;
- receipts/approvals/invocations/certificates остаются отдельными refs;
- summary не меняет GoalContract, authority, policy, workflow state или certificate;
- incomplete bracket игнорируется после crash;
- context projection явно отмечает omitted ranges;
- summary content untrusted для completion;
- user может инспектировать event/evidence provenance без раскрытия hidden reasoning.

Compaction использует strict CAS fence: `started` фиксирует surface revision/base sequence/source digest. Любой accepted steering, Goal/plan/workflow revision либо context-authority change после start делает result `superseded`; `completed` допускается только при неизменившемся fence. Никакого implementation choice «fence или supersede» не остаётся.

### 25.3. Automatic pressure controller

Core profile обязан включать автоматический `ContextBudgetAccountant`. Триггер выводится
из exact driver-tokenizer accounting полного model-visible surface, а не из пожелания модели:

- soft watermark запускает single-flight background compaction до следующего turn;
- hard pre-submit watermark запускает synchronous compaction до driver call;
- rearm watermark ниже soft создаёт hysteresis; одна surface revision имеет не более одной
  bounded попытки;
- target обязан вернуть минимум экономии, закрытый covered range/source digest и projection
  не выше rearm watermark;
- failure, race, stale revision или mandatory-minimum overflow блокируют submit typed outcome;
  `slice(-N)`, retry с ещё более коротким prompt и silent field removal запрещены;
- foundation использует deterministic extractive range summary и bounded recent raw tail.
  Model-generated semantic summary выключен до отдельного profile/benchmark;
- compaction меняет только model-visible projection: весь raw journal и authority/evidence refs
  сохраняются вне summary.

Isolated A20/A21 proof теперь исполняет `17/17` scenarios, включая четыре automatic triggers,
below-rearm no-op, hard-failure-before-driver и single-flight coalescing. Успешный synthetic
surface уменьшается `1020→25` facts и `1224→240` units, while raw journal remains `1020` facts;
это архитектурное доказательство, не product implementation и не real tokenizer benchmark.

---

## 26. Context, memory, skills и attachments

### 26.1. Context Compiler V2

Context строится как projection exact revisions:

- GoalContract + current workflow state;
- bounded plan;
- relevant journal surface;
- certified/eligible evidence summaries;
- inspected capability schemas;
- Interaction history slice;
- skill refs;
- memory refs, разрешённые privacy policy;
- budgets/control state;
- untrusted-data labels.

Каждый context snapshot имеет digest и event. Runtime ответ связан с этим digest.

Context budget has a non-droppable minimum: exact Goal/constraints, active workflow state, current Invocation/Approval/Recovery facts, required inspected schemas, authority/privacy/provider summary, last denial and EvidenceView needed for the next allowed decision. History, rationale and optional examples may be omitted only with explicit ranges/digests. If the non-droppable set exceeds a driver's declared capacity and no already-reviewed compaction artifact can reduce only optional surface, Runtime returns `context-capacity-insufficient` and blocks/asks to narrow or selects an already-authorized compatible driver. It never silently drops schema/evidence/authority, repeats an inspection as a substitute or lets the model guess. Mandatory core compaction must prove this path; advanced summary/memory compaction may remain disabled without weakening the fail-closed minimum.

### 26.2. Memory

- Один `MemoryAuthority` обслуживает working, conversation, cross-chat, explicit,
  user-global и project scopes; второй параллельный Astra-store запрещён.
- Runtime не пишет long-term/global memory напрямую. Memory proposal проходит отдельный
  typed command/preview, versioned consent и receipt; model inference не auto-promotes.
- Cross-chat default-off для Astra. Legacy default-true не считается новым consent.
- `MemorySummaryV1` derived/rebuildable: exact child refs, statements/support,
  contradictions, source/consent revisions и CAS activation. Summary/child report не
  становится authority или durable user fact.
- `MemoryContextReceiptV1` связывает exact selected/omitted refs, scope/consent revision,
  UTF-8 byte budget и `ContextPlanV1`; recalled content всегда untrusted data.
- Storage управляется `MemoryByteLedgerV1`: content-addressed body dedup, source refs
  вместо копий, contentless/rebuildable FTS, optional semantic cache default-off,
  byte-pressure GC вместо row-count compaction.
- Foundation profile: `32 MiB` soft / `64 MiB` hard, model projection до `4096 B`;
  explicit/pinned facts не auto-delete.
- Incognito не создаёт durable memory. Encrypted conversation и Monarch Safe не попадают
  в обычные body/index/WAL/backup surfaces.
- Нормативные machine-readable границы и staged V4 migration находятся в
  `astra-v3-memory-foundation.v1.json`; это не разрешение product schema migration.

### 26.3. Skills

Skill — versioned guidance/resource bundle, не authority.

- skill digest фиксируется в context;
- skill может сузить workflow/tool usage, но не расширить scope;
- skill output untrusted;
- skill update не меняет уже admitted GoalContract silent образом.

Действующий `src/modules/astra` здесь называется **Astra Skills**. Он сохраняет текущие `astra.*` capability IDs, progressive disclosure, agent cards и fingerprinted activation, но не становится Astra V3 Runtime Host/Goal Compiler/Kernel/Certifier. Целевая интеграция — bounded adapter: Astra Skills выдаёт versioned skill/card refs будущему catalog/context profile, а Astra V3 повторно применяет admission, authority narrowing и capability contract checks. Никакое совпадение бренда не даёт skill-тексту или модулю права исполнять capability напрямую.

Нормативный integration boundary:

- `SkillRef` фиксирует ID/version/body digest/source tier/trust class; raw path не authority;
- body загружается только после discovery и exact digest recheck;
- implicit activation не меняет Goal, target, provider consent или AuthorityScope;
- skill `requiredCapabilities` является discovery hint, а не required-tool authority;
- SkillRef и omission record входят в `ContextPlan`; update создаёт новую context revision;
- registered workflow исполняет versioned graph/guards runtime package, не Markdown instructions;
- answer-only и execution lanes используют одну semantics refs/provenance, а не два независимых
  skill-контура;
- legacy `astra.slot.preview` никогда не становится persisted runtime state.

### 26.4. Attachments

Существующий immutable digest-bound attachment store сохраняется. Driver получает только authorized projection. Attachment content считается untrusted input; никакие embedded instructions не меняют policy/goal без user command admission.

---

## 27. Safe, privacy, secrets и provider boundaries

### 27.1. Monarch Safe

До отдельного Safe Agent ADR действуют правила:

- encrypted Interaction остаётся answer-only;
- Safe paths не индексируются catalog, storage audit, workspace discovery или telemetry;
- generic filesystem capability не получает Safe exception;
- Kernel target/child-handle gate проверяет protected identity до передачи handle/entry capability; generic walker не видит имя, путь, identity, count или bytes и публично получает только `policy-restricted`;
- child/job/compaction service не читает Safe;
- никакой migration/benchmark не перечисляет production Safe contents;
- будущий Safe provider требует exact vault/object scope, unlock/session binding, fresh consent и dedicated receipt/redaction contract.

### 27.2. Incognito

Future `agent-incognito.v1` only; `agent-core-read.v1` rejects operational Incognito. The port list below is a threat-model checklist, not a complete manifest. Operational enablement requires a generated exhaustive port inventory (including snapshots, dedupe/receipts, timers/leases, approvals, delivery, metrics, crash/diagnostic paths) and residue/crash fixtures; one missing port keeps the profile unavailable.

- memory-only Interaction/Execution journal;
- no durable task, delivery, job, memory, resume token или Action Ledger effect record;
- только answer-only и bounded local Kernel reads с `mutation=none`, `communication=none`, без external provider/egress;
- effectful/external goal получает explicit block и предложение создать новый persistent Interaction; silent privacy-mode switch запрещён;
- same logical read certification/Kernel rules;
- shutdown теряет session by design, UI сообщает это честно.

Все эти правила реализуются одним `IncognitoStorageProfileV1`, который инъецируется во **все** infrastructure ports, а не только TaskStore:

- Interaction/Execution journal, command receipts, outbox/inbox — memory-only;
- Kernel read receipt projection, Evidence Store, observation payloads, certificates/TypedValues/protected refs — scope-bound memory-only;
- attachments/artifacts/context/driver resume/cache — memory-only, released and best-effort zeroized при close;
- no Action Ledger durable record для allowed read;
- no durable debug trace, path, content, content-linkable digest, correlation ID или provider payload;
- optional durable aggregate metrics допускаются только без task/content/path/ref identifiers и не позволяют связать read с пользователем;
- cross-scope/durable dereference Incognito ref fail-closed.

Если конкретный Kernel/read adapter не может гарантировать no-persist receipt/log path, capability считается Incognito-ineligible. Renderer failure/cancel не меняют storage profile и не переводят evidence в persistent cache. Crash означает честную потерю результата, а не hidden recovery record.

Гарантия ограничена Monarch-managed ports. Immutable JS strings, allocator copies, pagefile/hibernation/crash dumps, GPU/model memory, antivirus/ETW и OS diagnostics не объявляются физически zeroized. Secret paths обязаны использовать mutable secure buffers where available; unsupported residual channels disclosed и могут блокировать Incognito capability/platform. Product wording: Monarch не сохраняет session в поддерживаемые хранилища после close, а не абсолютное «на устройстве не останется байтов».

### 27.2.1. Encrypted lane

Future `agent-encrypted.v1` is separate from Incognito and unavailable. It must bind one Windows OS principal/profile generation, vault/key generation, encrypted journal/messages/attachments/evidence/receipts/context/cache/resume data, decrypted-buffer lifetime, log/crash redaction, rotation, backup/restore and close behavior. Cross-user refs/keys are rejected. Existing encrypted answer behavior remains outside V3 adapter until that manifest and restore/residue fixtures pass.

### 27.3. Secrets

Future protected-object/effect/provider profiles only; core fixture contains no secrets.

- secret redaction до driver/context/log;
- raw tokens не сохраняются в journal;
- credentials referenced by opaque credential ID;
- runtime resume token encrypted at rest и provider-bound;
- child scope не получает credential автоматически.

### 27.4. External providers

Future `agent-provider.v1` only; unavailable in core.

Materially different provider/data flow требует:

- provider identity;
- exact transmitted data classes;
- retention/terms/version;
- agreement version bump;
- fresh explicit consent;
- provider-bound execution and journal metadata;
- revoke semantics.

Архитектура не даёт blanket consent на cloud runtimes.

`ProviderExecutionGrant` server-owned и содержит provider/driver identity, terms/agreement version, execution + Goal revision, разрешённые data classes/immutable refs, expiry и revoke epoch. На каждый `open/submit/steer` Egress Gate строит exact `EgressManifest` (context digest + передаваемые refs/classes), проверяет intersection privacy/grant и атомарно выдаёт short-lived one-use `EgressAdmissionPermit` с checked revoke epoch. Новая activation может использовать ещё действующий grant только для того же provider/terms/goal scope и exact subset; driver swap, terms bump, новая data class/ref или revoke требует нового consent. Resume token также grant/provider/terms-bound.

Непосредственно перед передачей первого байта Host повторно CAS-проверяет grant/revoke epoch и переводит permit в `EgressAttempt.started`; это linearization point. Revoke, committed до него, запрещает send; revoke после него останавливает только будущие attempts и best-effort cancel текущего stream, но UI честно сообщает, что in-flight bytes могли уйти. Attempt outcomes: `not-started | started | completed | failed | unknown`, плюс optional attempted byte/manifest digest. `completed` означает transport completion; `provider-acknowledged` допустим только при отдельном provider receipt. Crash/partial stream после `started` → `unknown`, а pre-send permit никогда не называется transmission receipt.

---

## 28. Observability и truthful UX

### 28.1. Correlation

Один trace связывает:

```text
interaction -> execution -> activation -> decision -> workflow transition
-> invocation -> approval -> Kernel action -> receipt -> claim -> certificate
-> presentation -> delivery
```

### 28.2. UX stages

UI показывает только runtime-sourced stages:

- accepted;
- understanding goal;
- planning;
- discovering/inspecting capability;
- waiting approval/user/runtime;
- executing exact action;
- reconciling;
- verifying claims;
- preparing response;
- completed/partial/blocked/failed.

Нельзя показывать «выполняю действие», если есть только model stream, или «проверено», если certificate отсутствует.

### 28.3. Logs

- bounded, structured, redacted;
- без hidden prompts/reasoning;
- payloads по ref/digest, а не безусловный full dump;
- local-first retention;
- export содержит version/schema info и corruption warnings.

---

## 29. Performance и budgets

Новая корректность не должна превращать каждый answer в agent workflow.

### 29.1. Fast paths

- Informational request остаётся answer-only Interaction с `execution_authority=none`.
- Core matcher is a bounded compiled rule table/pure matcher with no model call; latency/allocation limits are frozen by fixture benchmark, ambiguity blocks instead of escalating silently.
- Один exact read claim может выполнить: compile → invoke → certify → deterministic render без model synthesis round.
- Required capability pinned без широкого search.
- Catalog summaries cached по revision/digest.
- Certifier pure и не вызывает LLM.

### 29.2. Budget hierarchy

```text
system/surface budget
  -> execution budget
     -> activation slice
        -> workflow/child/job slice
           -> model/tool/invocation limits
```

Child и retry budget вычитаются из parent; они не создают бесплатный новый лимит. Progress fingerprint включает Goal revision, plan state, evidence IDs, inspected schemas и workflow state; повтор без изменения ведёт к bounded repair/block.

---

## 30. Versioning и compatibility

### 30.1. Независимые версии

Ниже перечислены target namespaces; только §0.1 core IDs входят в current manifest. Provider/effect/recovery/privacy names are reserved design labels, not available schemas.

- Product architecture family: **Astra V3**.
- Target Monarch release train: `0.3.0`.
- Agent Client Protocol: `monarch.agent-client-protocol.v1`.
- Engine Driver Protocol: `monarch.agent-engine-protocol.v1`.
- Goal Contract: `monarch.goal-contract.v1`.
- Interaction Intent Admission: `monarch.interaction-intent-admission.v1`.
- Capability Agent Contract: `monarch.agent-capability-contract.v1`.
- Execution journal event: `monarch.agent-event.v1`.
- Completion Certificate: `monarch.completion-certificate.v1`.
- Canonical typed value: `monarch.typed-value.v1` (`semanticType=integer`, `encoding=base10-integer` for unbounded integer claims; `integer-decimal` is the GoalClaim value type, not a TypedValue semantic type).
- Provider grant/egress lifecycle: `monarch.provider-execution-grant.v1` / `monarch.egress-admission-permit.v1` / `monarch.egress-attempt.v1`.
- Effect semantics snapshot: `monarch.effect-semantics-snapshot.v1`.
- Recovery Case: `monarch.recovery-case.v1`.
- Incognito storage profile: `monarch.incognito-storage-profile.v1`.
- Persisted target execution projection: предложенная `monarch.agent-task.v4`.

### 30.2. Compatibility rules

- Unknown field in core authority schema → reject/upgrade-required; only an explicitly declared non-authority extension bag may preserve/ignore values.
- Unknown event type → старый reader не продолжает authoritative replay; он переходит read-only/upgrade-required.
- Payload version меняется отдельно от event type.
- Semantic capability change требует contract version/digest change.
- Driver protocol negotiation выбирает общую версию/features.
- Legacy Task V3 не auto-upgrade in place во время чтения без backup/atomic migration gate.
- Active legacy execution завершается старым engine либо явно pauses; mid-flight semantic migration запрещена.

---

## 31. Release boundary

### 31.1. Monarch `0.3.0` назначен как release train, но не объявлен готовым

Owner decision от 2026-08-26 назначает этой работе общий product release train **Monarch `0.3.0`** и имя runtime **Astra V3**. Schema-lab success сам по себе не является release candidate. Точный состав `0.3.0` определяется только по фактически enabled и прошедшим acceptance profiles; всё не прошедшее gate остаётся unavailable и не может скрываться за номером версии.

`agent-core-read.v1` остаётся самостоятельным release-grade **engineering substrate** со своими gates:

1. Generated manifest/schemas/types/fixtures проходят §30 без ручных mirrors.
2. Product store/backend выбран после durability/latency/backup benchmark и имеет один owner per stream/commit.
3. Mandatory product-read foundation даёт durable accepted-work continuation, historical package retention/quarantine, revocation checks before dispatch/around I/O/before evidence/certification/delivery, start-by/deadline, certificate invalidation/correction/user notice, current delivery authorization, receiptless dispatch recovery, query/cancel/attach, bounded queue, generation/process fences, explicit retention/erasure/RPO/RTO, private-store/backup/admin и accessibility fallback owners.
4. Ordinary Oscar route создаёт exact admission → deterministic Goal → local read Invocation → Kernel receipt → Evidence → certificate → structured result.
5. `logicalBytes` сохраняется arbitrary-precision end-to-end; temporal/proof/policy/volume mismatches fail closed.
6. Completion Certificate является единственным источником Astra V3 `verified`; answer/legacy outcomes остаются отдельно.
7. Current Turn/Task data, rollback and no-false-V2-fallback proven on migration fixtures.
8. Kernel protected-boundary deny-before-enumeration, object-alias denial and generic disclosure pass; production Safe is never a test target.
9. Crash/idempotency/certificate/delivery matrix, exact installed ordinary route and clean Windows 10/11 upgrade pass without losing chats/config/models/Safe.
10. Performance budget, supported Windows/filesystem matrix and truthful/accessibility UI pass on supported hardware.

Этот список разрешает отдельно выпускать/изучать substrate, но не называть его
закрытым Astra V3 Agent Runtime. Product closure `astra-core-experience.v1`
дополнительно требует Agent Core §4–18: Engine/Decision Gateway, one Admission/Goal,
Catalog, Context, Scheduler/Recovery, Workflow/Task Graph, split residency/turn
resource protocol, mandatory compaction, durable local steering/cancel/resume, broad
Completion, four mandatory capability packs, real-model full-task holdout и installed
acceptance. Exact scope берётся только из
`astra-v3-release-profile-matrix.v1.json`. Provider, plugins, encrypted execution,
children и jobs могут оставаться `optional-disabled`, но соответствующие P/A нельзя
объявлять решёнными, а UI обязан сообщать unavailable.

### 31.2. Любая версия после `0.3.0` — отдельное owner/release решение

Эта архитектура не резервирует `0.5.0` или `1.0.0`. Будущая Stable-версия требует отдельного решения после sustained soak/recovery evidence для каждого enabled profile, отсутствия известных release-blocking truth/security/data-loss defects, устойчивых upgrade/rollback/export/repair правил, clean-machine installed acceptance, Windows/user-profile isolation и точных privacy/provider/plugin решений. Children/jobs/cloud могут отсутствовать, если release matrix помечает их `optional-disabled`; compaction входит в core и отсутствовать не может.

---

## 32. Главные риски и сознательные компромиссы

| Риск | Почему реален | Архитектурный ответ |
|---|---|---|
| V3 станет ещё одним слоем поверх God-loop | слишком лёгкий migration shortcut | deletion/parity gates для каждой старой branch; один owner per fact |
| Goal Compiler превратится в новый regex monolith | перенос текущей проблемы | capability-owned contracts + bounded shared predicates + contract tests |
| Event journal создаст dual truth | Turn/Task уже persisted | benchmark before product ABI; per-aggregate cutover, one store owner, outbox between aggregates |
| Dynamic plugin подделает claims | untrusted manifest | plugins absent in core; separate trust/legal/sandbox decision before any authority |
| Renderer исказит значение | LLM prose | structured facts + deterministic renderer + consistency gate |
| Exact integer уже округлён до certification | JS/JSON number | canonical decimal typed value + safe-number adapter denial |
| Lossless traversal sum выдаётся за current snapshot | concurrent filesystem mutation | projector-derived walk verdict + separate temporal proof; snapshot/stable proof required |
| Approval потерян после process crash | generation-bound authorization | stable invocation authorization revision; generation только runner fence |
| Upgrade меняет recovery semantics | latest manifest lookup | frozen content-addressed EffectSemanticsSnapshot |
| Cloud driver получает лишний context | generic consent ID | ProviderExecutionGrant + exact manifest/permit/attempt |
| Pre-send permit выдаётся за факт передачи | crash/revoke/partial stream | permit/attempt/outcome split + send-start CAS |
| Client spoof-ит source/privacy | смешанный wire/accepted envelope | server-attested AcceptedCommandContext |
| Runtime observation сам называет себя verified | authority не формализована | Kernel/evidence admission policy per claim |
| Buffered pre-steer decision приходит поздно | generation всё ещё совпадает | submit/context/boundary envelope CAS |
| Unknown effect pins data навсегда или исчезает | no recovery lifecycle | RecoveryCase + two-tier retention/tombstone/quota |
| Incognito read течёт через общий Evidence Store | memory-only только TaskStore | all-port IncognitoStorageProfile |
| Steering гонка с effect dispatch | async runtime | persisted safe-boundary + generation fence |
| Child расширит authority | prompt delegation | scope intersection, no approval inheritance, Kernel re-evaluation |
| Crash продублирует effect | external ambiguity | idempotency/reconciliation; indeterminate non-idempotent blocks |
| Compaction потеряет proof | summary replacing history | immutable evidence graph outside compact surface |
| Migration сломает user data | schema evolution | read-only legacy adapter, backup/atomicity, no mid-flight conversion |
| Catalog search скроет нужную capability | relevance/limit | Goal-required pinning, exact ID search, inspect ledger |
| Слишком высокая latency | extra services/events | fast paths, pure certifier, deterministic render, cached catalog |

---

## 32.1. Hard gate перед любым effect RFC

Ни один write/device/process/external vertical не может перейти даже к production implementation planning, пока каждый пункт не имеет отдельного reviewed ABI, implementation identity, fixtures и owner:

| Blocker | Обязательный closure artifact | До closure |
|---|---|---|
| Effect dispatch ownership | choose one physical owner/co-location or formally specified outbox/claim protocol for Invocation + ledger; prepared/attempt/receipt/indeterminate/reconciliation ABI; crash matrix | effects unavailable |
| Frozen executable semantics | digests/versions реальных canonicalizer, path resolver, predicate registry, projector/verifier, reconciliation interpreter, Kernel adapter | no prepared effect invocation |
| Authorization dispatch transaction | executable design under the chosen single-owner/co-located protocol for current policy/revocation + Goal/Invocation + Approval/Arm + provider grant | approval is not dispatch permission |
| Trusted human arm | reviewed surface × capability mechanism, main-process/OS/hardware attestation, spoof/replay/accessibility fixtures | required-arm capability unavailable |
| Egress/ingress boundary | OS-confined broker, authenticated IPC, grant/permit/attempt/ingress lifecycle, revoke/partial/unknown fixtures | cloud/hybrid disabled |
| Protected objects | envelope encryption/key hierarchy/ACL/rotation/backup/crypto-erasure ABI and tests | no persistent sensitive provider/effect evidence |
| Recovery/privacy | retention tiers, tombstone quota, storage-pressure behavior, correction delivery and separate data-erasure ADR | non-idempotent effects disabled |
| Authority algebra | generated `AuthorityScopeV1` schema/intersection corpus including handle identities and `safeAuthority=none` | child/workflow/provider widening denied |
| Threat/supply-chain model | assets, trusted writer vs same-user/admin/OS attackers, authenticated append/key anchor, package admission/rollback, mitigations and incident/repair/export runbook | no effect release |
| Operational storage | disk-full reserve/degraded mode, consistent backup/restore, privileged repair/export audit | no effect dispatch when truth cannot be durably recorded |

Эти пункты не считаются «open P2, можно додумать в коде». Они являются explicit accepted blockers. Shadow read RFC не реализует их и не создаёт обходной effect path.

---

## 33. Открытые решения, которые нельзя угадывать при реализации

1. Physical journal storage: segmented JSON или SQLite после measured crash/concurrency benchmark.
2. Будет ли вообще `agent-plugins.v1`; если да — package/schema signing, sandbox/IPC, legal/provenance, revocation и право third-party/MCP claim templates.
3. Нужен ли после bounded `PreliminaryNeedsV1` discovery полноценный model-assisted Goal Compiler. Первый product closure разрешает модели только ранжировать exact catalog handles; final Goal остаётся deterministic/capability-owned и monotonic.
4. Какие дополнительные workflows сверх обязательных workspace read/effect, desktop control и browser navigation войдут в первый cohort.
5. Какой второй Engine driver нужен после обязательного current-local adapter; сам production Engine/Decision Gateway уже не optional для Astra product closure.
6. Retention/export policy journal для persistent non-Safe data.
7. Где физически живёт cross-process Scheduler lease при будущих нескольких app processes.
8. Допустим ли auto-resume read-only jobs после OS restart по умолчанию.
9. Exact product durations/quotas для full RecoveryCase evidence и protected certified values; state machine, tombstone и no-silent-GC semantics уже фиксированы и не зависят от выбранных чисел.
10. Effect/provider attacker profile: trusted writer vs same-user compromise vs admin/kernel/OS, authenticated append anchor/key custody и supply-chain rollback.

Каждый пункт требует отдельного ADR/evidence, но не блокирует этот logical design.

---

## 34. Architecture closure gates

Текущая архитектура **не complete** и не готова к general product implementation. Узкая реализация schema substrate и acceptance tooling разрешена; product status может измениться только когда:

- все authoritative owners перечислены без циклов;
- для каждой current subsystem есть preserve/evolve/retire решение;
- core GoalContract доказывает exact read scalar/temporal/scope semantics;
- protocol описывает ordering/idempotency/recovery;
- Kernel protected-boundary/Safe инварианты формально неизменны; Approval отсутствует в core;
- no-dual-truth migration описана по фазам и rollback;
- extension names/types отсутствуют в core manifest и не требуют authority exceptions;
- product release train остаётся ровно `0.3.0`, readiness выводится только из profile-based gates и не подменяется номером версии;
- `MONARCH_ASTRA_V3_AGENT_CORE.md` P01–P20 имеют owners, exact acceptance contracts и release dispositions; до product status все mandatory contracts materialized и executable на ordinary route, а optional-disabled/deferred не называются решёнными;
- schema/type package компилируется, generated JSON Schemas/fixtures совпадают с Protocol и все cross-document mirrors проверены;
- machine definition остаётся sole codegen input, generated output не становится source, а ceilings 66 schemas / 40 event variants / 8 guard labels / 28 claims / 16 data keys не растут без explicit substitution/no-go ADR;
- Phase 0 real-hardware benchmark сравнил additive V3, sidecar и V4, зафиксировал exact performance/resource/RPO/RTO budgets и выбрал наименее сложный passing candidate;
- final changed ABI/fixtures прошли focused independent structural **и targeted semantic** regression review с negative counterexamples; текущая prose-correction series ограничена тремя независимыми проходами, а после неё следующий meaningful gate проверяет уже generated schemas/fixtures/hashes, не запускает бесконечный четвёртый prose audit;
- принятые/частично принятые/отклонённые внешние findings имеют evidence-backed disposition, а не только число замечаний.

Audit priority определяется воспроизводимым counterexample, точной schema/event/path ссылкой и impact, а не брендом модели или количеством пунктов. Model identity может задавать очередь ручной проверки, но не меняет verdict. Никакой текущий prose pass не называется PASS 4 и не закрывает frozen PASS 3.

Текущий разрешённый шаг — schema-closure package/fixtures, machine problem/acceptance map, V2 ordinary-route replay harness и isolated store/latency/full-task benchmark на disposable `E:` root. Shadow/product import, V4 truth, UI verdict, effects/provider/operational Incognito и production Safe access запрещены. После artifacts требуется focused independent review exact schemas, fixtures, hashes, benchmark/test output and source diff; только затем отдельный go/no-go решает, какой foundation seam можно реализовывать и shadow-ить.

---

## Приложение A. Current → target ownership map

| Current artifact | Target owner | Migration disposition |
|---|---|---|
| `src/oscar-turn/coordinator.ts` routing/admission | Interaction + Agent Application Service | сохранить ingress; execution reconciliation убрать по parity |
| `src/oscar-turn/disposition.ts` | compatibility adapter к `InteractionIntentAdmission` | независимый answer/agent parser retired после ordinary-route corpus parity |
| `src/oscar-turn/turn-store.ts` | Interaction Store | version-evolve, outbox сохранить |
| `src/agent/agent-runtime.ts` | Execution Application + Scheduler | разложить, public API адаптировать |
| `src/agent/agent-loop.ts` | Decision/Workflow/Invocation/Certifier services | ветки выводить по одной после conformance |
| `src/agent/operational-goal-binding.ts` | capability-owned Goal Contracts | central switch retired после coverage |
| `src/agent/capability-resolver.ts` | Capability Catalog | lexical scorer оставить как один search backend |
| `src/agent/decision-schema.ts` | Decision Gateway migration oracle + legacy V2 only | replace for V3 with branch-local parser/canonicalizer; never hide old exact parser inside driver |
| `src/agent/context-compiler.ts` | Context Projection Service | добавить revision/digest/journal surfaces |
| `src/agent/kernel-execution-adapter.ts` | Invocation Coordinator Kernel port | сохранить authority seam |
| `src/agent/result-verifier.ts` | Completion Certifier predicate layer | расширить typed claim bindings |
| `src/agent/agent-task-store.ts` | legacy V3 adapter + candidate additive product lane; sidecar/V4 remain measured alternatives | no in-place big-bang migration; selected lane owns each fact exactly once |
| `src/modules/*/manifest.ts` agent metadata | Agent Capability Contract registry | добавить output/goal/claim/workflow contracts отдельно |
| `models.agent.synthesize` operational usage | Presentation Service adapter | убрать из proof chain |
| Computer Use trusted branches | static Computer Use Workflow | exact observation/atom/readback сохранить |
| `src/core/action-ledger.ts` | Action Ledger V2/compatibility bridge | frozen semantics + indeterminate/reconciliation нужны до effect cutover |

## Приложение B. Clean-room boundary

Из Cherry Studio/DSH допускается перенять идеи и state-machine patterns:

- persistence-first admission;
- neutral runtime drivers;
- attach/replay и safe-boundary steering;
- durable delivery/mailbox;
- Goal/Activation split;
- event-bracketed compaction;
- bounded jobs/notices;
- narrowing child descriptors;
- progressive tool discovery.

Прямое копирование Cherry AGPL implementation без отдельного legal decision запрещено. Любой будущий заимствованный MIT-фрагмент требует provenance и third-party notice. Monarch-specific Kernel/receipt/certificate truth layer проектируется самостоятельно.
