# Legacy Astra Architecture Postmortem

> **Статус:** evidence-backed architecture postmortem; не product implementation и не release proof.  
> **Исторический источник:** `Astra promt.txt`, 2026-05-17, переданный owner-ом 2026-08-30.  
> **Текущий checkout:** Monarch `0.3.0` development cycle; Astra V3 остаётся architecture candidate.  
> **Privacy boundary:** исследованы только переданный текст и tracked source. Monarch Safe, пользовательские conversation/memory stores и runtime payloads не читались.

## 1. Итоговый вердикт

Старый документ правильно сформулировал **skill/capability registry**, но ошибочно принял его
за архитектуру полноценного агента. Его центральная цепочка:

```text
intent -> rank one capability -> activate slot -> permission -> execute -> answer
```

годится для одношагового command router. Она принципиально недостаточна для durable агента,
который обязан планировать составную цель, переживать сбои, различать proposal/attempt/effect,
проверять результат, восстанавливаться без повторного non-idempotent effect и честно завершать
задачу.

Главный исторический дефект — не «плохой router», а **ошибка категории**:

```text
discovery metadata + tool selection != agent runtime
```

Эта ошибка всё ещё видна в текущем checkout. Она не означает, что V2 ничего не исправил:
durable AgentTask, bounded loop, Kernel gateway, approvals, observations и verifier уже существуют.
Но исправления были добавлены вокруг старого capability-first центра, поэтому архитектура стала
сложной и хрупкой, а не цельной.

## 2. Что в исходной идее было правильным

Эти положения сохраняются, но только как ограниченные компоненты Astra V3:

1. Stable capability IDs и typed input schemas.
2. Local-first execution без обязательного облака.
3. Progressive disclosure вместо загрузки всего plugin/skill body.
4. Deterministic discovery/ranking до optional model reranking.
5. Skill/plugin text не должен исполняться напрямую.
6. Kernel/policy должен оставаться ниже agent/model layer.
7. Risk, permission и audit metadata нужны каждому действию.

Проблема была не в этих принципах, а в том, что ими попытались заменить Goal, workflow,
durability, evidence, recovery, context и resource orchestration.

## 3. Подтверждённые следы в текущем checkout

### L01 — Astra Skills остаётся почти буквальной реализацией старой схемы

**Severity:** high. **Статус:** confirmed-current.

- `src/modules/astra/index.ts` всё ещё публикует `AgentCard`, `SlotPreview`,
  `astra.skills.index`, `astra.skill.explain` и `astra.slot.preview`.
- `AstraModule.activate()` и health report называют слой `monolithic`.
- `createAgentCard()` строит карточку из статического manifest/routing/risk;
  `createSlotPreview()` создаёт только read-only projection со `status='preview'`.

Это полезный catalog UX, но не activation, task state, authority lease или execution context.
Название `slot` создаёт ложную семантику: объект выглядит как runtime primitive, хотя не владеет
ни durable state, ни readiness, ни exact contract digest, ни observation/evidence, ни recovery.

**Astra V3 correction:** `astra.slot.preview` остаётся compatibility/read-only UI projection и
никогда не импортируется как Execution/Activation ABI. Реальный runtime использует
`Execution`, `Activation`, `ContextPlan`, `CapabilityContractRef` и leases.

### L02 — Skill-контур и V2 Agent Runtime фактически разъединены

**Severity:** critical. **Статус:** confirmed-current.

- `AgentSkillRegistry.activateForPrompt()` подключён в `src/app/oscar-turn-runtime.ts` и
  `src/modules/oscar/index.ts` к answer-only Python/Oscar request.
- `src/agent/agent-loop.ts` передаёт в `compileAgentContext()` goal, plan, observations,
  messages, artifacts и capability cards, но не active skill refs/bodies.
- `requiredCapabilities` из skill metadata не является входом V2 AgentLoop; required tool IDs
  выводятся отдельно из `resolveAgentOperationalRequirements(originalRequest)`.

В результате подсистема, названная skills for agent, реально помогает answer context, а common
durable agent выбирает tools другим механизмом. Это прямой функциональный разрыв, а не вопрос
наименования.

**Astra V3 correction:** один bounded `SkillContextAdapter` может выдавать только digest-bound
guidance refs после admission. Context Engine решает, включать ли их в конкретный model turn.
Skill `requiredCapabilities` — hint для catalog discovery; он не pin-ит tool, не расширяет Goal и
не выдаёт authority. Для выполнения guidance должна компилироваться в проверенный Workflow/Task
Graph либо оставаться untrusted model context.

### L03 — «выбрать capability» всё ещё частично заменяет понимание цели

**Severity:** critical. **Статус:** confirmed-current/partially-mitigated.

V2 resolver уже возвращает bounded окно нескольких tools и сохраняет required capability.
Однако `requiredCapabilitiesForTask()` снова парсит исходный request через
`resolveAgentOperationalRequirements()`, а затем pin-ит найденные IDs. Disposition, goal binding
и resolver используют разные semantic passes.

Следствие: морфология, negation, mixed clauses, composite targets и новое capability family могут
быть поняты по-разному ingress, Goal и AgentLoop. Ошибка одного regex превращается не только в
плохой ranking, но и в неверный набор обязательных действий.

**Astra V3 correction:** один immutable `InteractionIntentAdmission` создаёт typed clauses и
requirements. Goal Compiler и Catalog читают тот же artifact; ни AgentLoop, ни UI, ни resolver
не перепарсивают raw user text независимо.

### L04 — Одношаговый slot вырос в Agent god-loop

**Severity:** critical. **Статус:** confirmed-current.

Старый prompt сознательно исключил большой planner и не определил workflow runtime. При развитии
продукта недостающая семантика была добавлена в `src/agent/agent-loop.ts`: runtime-owned branches
для application discovery, workspace batches, synthesis, mutation reconciliation и Computer Use.
Файл содержит большой набор `trusted*Decision`, parsing, binding, retry, recovery и completion
исключений.

Это объясняет, почему новые агентские функции часто требуют правок общего цикла и почему локальное
исправление легко ломает другую capability family.

**Astra V3 correction:** общий Scheduler владеет только scheduling/lifecycle. Domain behavior
переезжает в versioned Workflow Contracts/Graphs; каждое извлечение имеет parity и deletion gate.
Ни один новый vertical не добавляет domain regex/branch в общий driver loop.

### L05 — Старый flow не имел Goal Contract и Task Graph

**Severity:** critical. **Статус:** mitigated-in-V2, not-closed-product-wide.

Исходный `intent -> capability -> result` не представляет несколько outputs, success criteria,
dependencies, alternative paths, partial completion или запрет substitution. V2 добавил durable
goal/plan, но часть requirements и plan semantics остаётся runtime-owned эвристикой, а current
full-task ordinary-route baseline ещё не является eligible.

**Astra V3 correction:** Goal Compiler создаёт typed Requirements; Strategy Selector выбирает
deterministic recipe, registered workflow или bounded planner; Task Graph хранит зависимости и
terminal obligations. Tool success не закрывает Goal автоматически.

### L06 — Permission Gate ошибочно был главным safety механизмом

**Severity:** critical. **Статус:** substantially-mitigated, legacy-risk-remains.

Permission `allow|confirm|deny` отвечает только «можно ли попытаться выполнить exact proposal».
Он не доказывает правильность target, успешность эффекта, отсутствие partial outcome,
идемпотентность, reconciliation или соответствие Goal.

V2 уже усилил это exact-bound approvals, Kernel receipts и verifier. Но старые/неполные capability
contracts получают conservative `legacy-default` metadata, а `MonarchModuleManifest` сам по себе
всё ещё не является frozen execution semantics package.

**Astra V3 correction:** approval — один guard внутри Invocation lifecycle. Отдельно обязательны
Goal binding, frozen CapabilityContract, AuthorityScope, dispatch identity, receipt/evidence,
reconciliation и Completion Certificate.

### L07 — Static Agent Card смешивает discoverability, eligibility и readiness

**Severity:** high. **Статус:** confirmed-current.

Текущая Astra card содержит ID, schema, risk, routing hints и permission mode. Она не связывает
конкретные catalog revision, contract digest, runtime/credential generation, current policy,
model requirement или readiness lease. Поэтому «карточка доступна» нельзя трактовать как
«действие сейчас выполнимо».

**Astra V3 correction:** search result — только bounded summary. `catalog.inspect()` возвращает
exact contract+digest; перед Execution и перед model turn создаются отдельные readiness/admission
receipts. Card никогда не является authority или readiness proof.

### L08 — Manifest был слишком беден для агентского эффекта

**Severity:** high. **Статус:** partially-mitigated.

Исторический manifest имел ID, risk, schema и routing. Текущий `MonarchCapability.agent` уже может
описать effects, idempotency, reversibility, runtime, cancellation, verification и
reconciliation. Но compatibility path допускает `source='legacy-default'`, то есть отсутствие
явного contract превращается в консервативную догадку.

Это безопаснее optimistic execution, но приводит к недееспособности: effectful legacy capability
может быть исключена как cancellation-unsupported или не иметь достаточного verifier contract.

**Astra V3 correction:** capability pack не входит в product cohort до explicit contract,
fixtures, current runtime availability и completion claims. Defaults допустимы только как
typed unavailable/migration inventory, не как executable semantics.

### L09 — `audit log` был принят за доказательство результата

**Severity:** critical. **Статус:** mitigated-in-V2, acceptance-pending.

Исходный критерий успеха требовал записать route, permission и execution result в audit. Audit
показывает, что компонент что-то сообщил; он не доказывает effect, current state или Goal.

V2 имеет observations/result verifier, но Astra V3 всё ещё не имеет current ordinary-route
full-task acceptance, поэтому нельзя считать проблему закрытой только по unit/simulator green.

**Astra V3 correction:** Kernel receipt -> Evidence Projector -> pure Completion Assessment ->
Certificate -> truthful presentation. Model prose, module `ok:true`, audit event и UI progress
никогда не являются completion truth.

### L10 — Не существовало состояния неопределённого эффекта

**Severity:** critical. **Статус:** partially-mitigated.

Старый flow имел только Result/Error. Он не описывал crash после dispatch до receipt,
late response, timeout, duplicate request, partial external effect и unknown device state.
Особенно опасны click/type/key/send/delete.

**Astra V3 correction:** one dispatch identity, `prepared/attempted/receipt/linearization`, durable
`indeterminate`/RecoveryCase и запрет blind retry non-idempotent effect. Cancel не переписывает
уже возможный effect в `cancelled-successfully`.

### L11 — Computer Use вообще не помещается в capability-slot модель

**Severity:** critical. **Статус:** confirmed-current-debt.

Computer Use — цикл observation -> target resolution -> focus/geometry validation -> one atom ->
fresh readback -> recovery. В V2 эта семантика появилась как explicit invocation parser и большой
набор special branches в AgentLoop. Это рабочие страховки, но не масштабируемая архитектура.

**Astra V3 correction:** отдельный Computer Use Reliability Pack и registered workflow; opaque
observation/target handles, immutable geometry/effect binding, native broker, stop fence,
indeterminate reconciliation и postcondition certificate. Общий loop не знает window-specific
domain rules.

### L12 — Контекст считался компактной карточкой, а не управляемым ресурсом

**Severity:** high. **Статус:** confirmed-current-debt.

Lazy Agent Card решает только одну разновидность context bloat. Он не решает длинную историю,
observations, artifacts, plan revisions, memory retrieval, compaction crash, stale summary,
model-specific capacity и untrusted-data provenance. Текущий Context Compiler использует bounded
`slice()`/truncation; это полезная защита, но не product-grade compaction/rehydration.

**Astra V3 correction:** explicit `ContextPlan`, authority-preserving required facts, delta
snapshots, bracketed compaction, omitted-range provenance, model capacity negotiation и durable
rehydration. Summary является derived memory, не source truth.

### L13 — Память ошибочно была просто ещё одной capability

**Severity:** high. **Статус:** confirmed-current-debt.

Старый MVP перечислял `memory` рядом с plugins/smart-home, но не определял global context,
cross-chat memory, provenance, scopes, retention, dedupe, summary lineage, privacy или byte budget.
В текущем Monarch сосуществуют несколько memory/context owners.

**Astra V3 correction:** Memory Foundation остаётся отдельным bounded service/profile: global,
project, conversation и task-working scopes; provenance/digest; explicit retrieval budget;
summary lineage; no durable Incognito memory; Safe/encrypted separation; soft/hard byte ceilings.
Memory не выдаёт execution authority.

### L14 — Local-first не равен resource-aware

**Severity:** high. **Статус:** confirmed-current-debt.

Исходный документ предполагал маленькую local LLM как необязательный reranker, но не моделировал
один GPU slot, model residency, cold swaps, queue fairness, cancellation, context capacity,
escalation и OOM recovery. На практике именно эти ограничения делают agent workflow медленным и
нестабильным.

**Astra V3 correction:** Resource-aware Model Host, explicit driver features, one owner of GPU
queue, readiness/admission leases, residency records, deadline/fairness policies и measured SLO.
Deterministic recipe выполняется без обязательного planning call.

### L15 — Не было единого product facade и migration ownership

**Severity:** critical. **Статус:** confirmed-current-debt.

Старая формула предполагала один чистый flow, но реальный продукт развил несколько routers,
answer/agent paths и surface-specific adapters. V2 primitives могут существовать, пока обычный
route или отдельная функция живёт по другим правилам.

**Astra V3 correction:** ordinary `/api/oscar/turns` остаётся единственным Product Facade ingress;
один Interaction имеет одного execution truth owner. Cohort выбирается до Execution. Mid-task
fallback V3 -> V2 запрещён. Каждый legacy owner удаляется только после route-level parity corpus.

### L16 — Критерии успеха проверяли демонстрацию, а не надёжность

**Severity:** critical. **Статус:** confirmed-current-gap.

«Показать три модуля и записать trace» не измеряет false verified, wrong effect, duplicate action,
zombie task, lost steering, recovery after receipt, context overflow, latency или installed
ordinary-route behavior. Это позволило считать локальные механики готовыми раньше product path.

**Astra V3 correction:** acceptance A01-A41, V2 golden trace baseline, current-model untouched
holdout, persisted-boundary fault injection, efficiency gates и packaged/installed Windows
acceptance. Simulator/schema green остаётся architecture evidence only.

### L17 — Action Ledger V1 не представляет жизненный цикл реального эффекта

**Severity:** critical for effects. **Статус:** confirmed-current.

`src/core/action-ledger.ts` хранит `authorized|executing|completed|failed`, причём `begin()` сразу
создаёт `executing`. При восстановлении durable `authorized/executing` превращаются в
`failed/interrupted-before-completion`. Это предотвращает автоматический повтор по тому же key,
но не отвечает, дошёл ли dispatch до OS/provider и произошёл ли effect.

**Astra V3 correction:** effect foundation требует отдельные immutable prepared/authorized/
dispatch-attempt/receipt/linearization records, `indeterminate` и bounded reconciliation. Action
Ledger V2 нужен до effect cohort; read-only foundation может развиваться отдельно только со своим
точным receiptless-dispatch/recovery contract.

### L18 — Execution Engine является ещё одним god object

**Severity:** high. **Статус:** confirmed-current.

`src/core/execution-engine.ts` в одном orchestration path объединяет input/schema validation,
source/risk checks, Permission/Policy/Security, approval, ledger, rollback capture, module
dispatch, postcondition verification, events и audit. Это сохраняет один authority seam, но
затрудняет отдельное доказательство dispatch, receipt admission и evidence semantics.

**Astra V3 correction:** внешний Kernel Invocation port сохраняется, а внутренние владельцы
разделяются на Invocation Coordinator, Policy/Authorization, Effect Broker/driver, Receipt
Admission и Evidence Projection. Разделение не должно создать второй bypass или два ledger.

### L19 — Kernel смешивает composition root с legacy routing/planning

**Severity:** high. **Статус:** confirmed-current/acceptable-as-legacy-facade.

`src/core/kernel.ts` одновременно держит Module/Capability registries, RouterMesh, Planner и
ExecutionEngine. Удалять класс с нуля не нужно: это полезный composition root. Но V3 Kernel port
должен получать exact typed Invocation; raw text/intent routing и prose planning не принадлежат
authority kernel.

**Astra V3 correction:** сохранить facade и module executors, постепенно вывести routing/planning
в Admission/Goal/Strategy owners. Compatibility `executeIntent` не становится V3 ABI.

### L20 — EventBus и AuditLog являются telemetry, не journal/evidence

**Severity:** high. **Статус:** confirmed-current.

`MonarchEventBus.history` и `MonarchAuditLog.entries` — in-memory arrays. Они полезны для live
telemetry/diagnostics и redacted audit UI, но теряются при restart и не имеют CAS, ordering,
receipt identity или recovery ownership.

**Astra V3 correction:** не превращать эти классы молча в authority store. Durable Execution/
Interaction journal и Evidence Graph являются отдельными owners; telemetry получает projections
и может теряться без изменения execution truth.

## 4. Причинная цепочка нынешней хрупкости

```text
capability registry принят за agent architecture
  -> один intent должен выбрать один tool/slot
  -> composite goals не имеют собственного state machine
  -> исключения добавляются в общий planner/loop
  -> domain parsers повторно читают raw user text
  -> context/tool/readiness truth расходятся между слоями
  -> каждое новое действие увеличивает special-case surface
  -> сбой модели/runtime/receipt требует ещё одной ветки
  -> локальные тесты проходят, ordinary full-task остаётся нестабильным
```

Это лучше объясняет проблемы V2, чем гипотеза «модель недостаточно умная». Более сильная модель
может реже ошибаться в выборе, но не создаёт отсутствующие ownership, durability, evidence и
recovery semantics.

## 5. Что Astra V3 обязана сохранить, заменить и удалить

| Legacy concept | Disposition | Target owner |
|---|---|---|
| Plugin/module manifest discovery | keep, version and digest | Capability Catalog |
| Agent Card | keep as non-authoritative search summary | Catalog/Context adapter |
| `astra.slot.preview` | compatibility-only; never runtime ABI | legacy Astra Skills UI |
| Slot as execution context | retire | Execution + Activation + ContextPlan |
| keyword/alias scorer | keep as one search backend | Capability Catalog |
| one selected capability | retire for composite goals | Strategy + Task Graph |
| skill body | keep as untrusted digest-bound guidance | SkillContextAdapter |
| skill `requiredCapabilities` | downgrade to discovery hint | Catalog discovery |
| Permission Gate | keep as dispatch guard | Kernel/Policy |
| audit event as success | retire | Evidence + Certifier |
| domain branches in AgentLoop | extract then delete | registered Workflows |
| reparse raw request per layer | delete after parity | one Intent Admission |

## 6. Обязательный Skill/Runtime integration contract

До реализации связи Astra Skills с Astra V3 должен быть закрыт machine-readable contract со
следующими инвариантами:

1. `SkillRef = {id, version, bodyDigest, sourceTier, trustClass}`; raw path не является authority.
2. Skill discovery происходит без body load; activation body bound к exact digest.
3. Implicit activation разрешена только policy-eligible trusted source и никогда не меняет
   admitted Goal/AuthorityScope.
4. Skill text маркируется untrusted guidance и отделяется от user-authority/system-policy blocks.
5. `requiredCapabilities` запускает bounded discovery, но exact capability pin создаёт только
   Goal/Workflow contract.
6. Skill instruction не может сформировать approval, target, credential ref, provider consent,
   evidence claim или completion certificate.
7. Skill update после admission создаёт новую context revision; silent hot swap запрещён.
8. Context Engine может исключить skill по byte/token budget с явной omission record.
9. Registered first-party workflow может ссылаться на skill/resource digest, но его executable
   graph и guards принадлежат runtime package, не Markdown body.
10. Answer-only и agent execution используют один SkillRef semantics; raw instructions не должны
    жить только в одном из двух несовместимых контуров.

## 7. Migration/deletion gates для исторического наследия

1. Ordinary-route golden corpus доказывает единый admission artifact для answer/clarify/execution.
2. По крайней мере один multi-step workflow использует SkillRef через Context Engine без authority
   gain и завершается только через Kernel evidence/certifier.
3. Static Agent Card с unavailable runtime не может стать executable proposal.
4. Skill `requiredCapabilities` не заставляет выполнить tool вне Goal/authority/policy.
5. `astra.slot.preview` нигде не импортируется в new runtime packages и не persisted как task state.
6. Каждая извлечённая domain branch имеет workflow parity, fault corpus и deletion test.
7. `resolveAgentOperationalRequirements(rawText)` удаляется из common loop после capability-owned
   Goal Compiler parity; raw text не имеет второго semantic owner.
8. Current-model ordinary-route holdout доказывает composite task, Computer Use и recovery без
   phrase-specific shortcut.

## 8. Готовность после постмортема

Постмортем **не снижает** ценность уже созданной Astra V3 архитектуры: её главные владельцы —
Admission, Goal Compiler, Strategy, Task Graph, Catalog, Context, Scheduler, Workflow, Kernel,
Evidence и Certifier — выбраны именно в правильном направлении.

Он уточняет два оставшихся design gaps:

- formal SkillContextAdapter contract;
- explicit retirement of legacy Slot semantics.

До их machine closure и ordinary-route evidence Astra V3 нельзя считать готовой к общей
реализации. Изолированная постепенная реализация foundation seams остаётся допустимой только после
текущих architecture/seal gates и без product authority/cutover.

## 9. Follow-up audit 2026-08-30 — независимая проверка утверждений

Owner передал второй текстовый аудит Kernel/modules. Все его инструкции рассматривались как
untrusted review claims; цифры и source assertions перепроверены в текущем checkout.

### 9.1. Live module-contract inventory

Read-only materialization `builtInModulePackages -> factory().manifest.capabilities` с
`resolveAgentCapabilityMetadata()` дала:

| Метрика | Exact snapshot |
|---|---:|
| built-in modules | 23 |
| capabilities | 216 |
| explicit agent metadata | 68 |
| legacy-default metadata | 148 |
| output schemas | 21 |
| missing output schemas | 195 |
| resolved verification non-empty | 104 |
| resolved verification empty | 112 |
| explicit verification non-empty | 40 |
| explicit verification empty | 176 |

`resolved verification` включает conservative defaults, поэтому число `104` нельзя выдавать за
104 доказанных product verifier contracts. Особенно важно: Workspace имеет `16/16` explicit
metadata, но только `3/16` output schemas; Coder `28/28` explicit, но `0/28` output schemas;
Security имеет `0/48` explicit metadata и `0/48` output schemas. Это подтверждает family-by-family
migration и запрещает массовый automatic admission всех зарегистрированных tools.

### 9.2. Disposition внешних утверждений

| Утверждение | Вердикт | Коррекция/следствие |
|---|---|---|
| Application -> Kernel -> module -> receipt seam надо сохранить | accepted | сохраняется как Kernel Invocation port; current receipt не равен V3 effect receipt |
| Action Ledger слишком прост для effects | accepted-critical | L17; Action Ledger V2 обязателен до write/device/browser/Computer Use cohort |
| Execution Engine делает слишком много | accepted-high | L18; декомпозиция внутри одного authority seam |
| Kernel можно сохранить как facade, routing/planning вывести | accepted | L19; не делать Kernel rewrite с нуля |
| EventBus/AuditLog не authoritative | accepted | L20; durable journal отдельный owner |
| 23/216/68/21/195/112 | verified-exact | snapshot выше; semantics `112` — empty resolved verification |
| AgentLoop 6721 строк и 35 trusted entities | accepted-with-correction | строк `6721`, unique declared `trusted*/isTrusted*` helpers `36` |
| Current V2 стабилен, потому что 96/96 PASS | rejected-as-proof | `49 files/96 tests` — Astra architecture aggregate; это не ordinary-route V2 product stability или installed evidence |
| Coordinator verification удалить после Certificate | accepted-with-boundary | duplicate completion ownership удалить, но certificate projection, Claim Integrity и message-order firewall сохранить |
| Split `contracts.ts` обязателен до cohort | advisory-only | generated Agent/Protocol ABI уже отделяется; физический split — maintainability work, не самостоятельный safety proof |
| Storage audit должен идти сразу после workspace read | not-mandatory-order | storage audit существенно сложнее generic read; порядок определяют closed pack contracts/risks, не номер в списке |
| Module Loader trust/quarantine нужен plugins | accepted-deferred | advanced plugin profile; не блокирует первый fixed built-in read cohort |
| Safe не включать в generic catalog/filesystem | accepted-non-negotiable | отдельный future opt-in provider/ADR; production Safe не перечислять |
| Phase 0F/product migration не готовы | verified-current | `executableAcceptanceScenarios=0`, `phase1Eligible=false`, `shadowImplementationAuthorized=false` |

### 9.3. Практический вывод

Второй аудит усиливает, а не меняет основное решение:

- не переписывать все module implementations;
- не называть current Kernel готовым Astra V3 Kernel;
- мигрировать только admitted capability families с explicit contracts;
- сначала единый Product Facade/admission + read foundation + ordinary-route evidence;
- effects только после Ledger V2/indeterminate/reconciliation;
- AgentLoop разбирать workflow-by-workflow с deletion gates;
- не использовать architecture `96/96` как доказательство надёжности текущего продукта.
