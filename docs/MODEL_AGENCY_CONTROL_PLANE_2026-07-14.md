# Monarch Model Agency and Control Plane

Дата: 2026-07-14

Статус: реализовано в live runtime и проверено полным TypeScript/Python gate

## 0. Implementation status

Архитектура ниже больше не является только предложением. В текущем runtime реализованы:

- `ActionProposalV1` с canonical hash, отдельным idempotency key, provenance, scope, predicates и conservative risk derivation;
- typed `/api/agent/proposals` и `action_proposal` SSE без повторного Router Mesh для exact capability;
- единый `PolicyKernel`: Permission/Security/filesystem дают evidence, но итоговый `allow | confirm | deny` принадлежит одному узлу;
- режимы Guided / Workspace autonomous / Full local, точное разовое подтверждение и revocable task leases с expiry/budgets/root/origin/effect binding;
- durable action ledger, fail-closed replay после restart, repeat/conflict guard, precondition и post-action verification;
- mutation journal для model-proposed `write/append/replace/mkdir/copy`: before-state или content/tree hash, rollback только если target не менялся после действия;
- compact full capability index, search/describe endpoints, multi-skill activation и declarative `required-capabilities`/`requires_toolsets` без выдачи authority;
- единый Autonomy UI в `Control > System`: mode, model proposals, confirmation policy, active leases, emergency revoke, ledger и доступный rollback;
- legacy `MONARCH_COMMAND`/marker path отключён по умолчанию и остаётся только за explicit compatibility flag.

Ограничение оставлено намеренно: локальный `llama_cpp` backend пока использует constrained runtime grammar adapter `[[MONARCH_ACTION:...]]`, потому что не все локальные GGUF checkpoints стабильно поддерживают native tool calls. Управляющий frame извлекается backend-ом в typed channel и не исполняется из UI-visible text. Native tool-call transport можно добавить как второй adapter без изменения policy/executor contracts.

### Проверка реализации

- `npm run typecheck:raw` — passed.
- `npm run test:raw` — passed, 87 files / 688 tests после финального rollback/skill slice.
- `npm run smoke:raw` — passed.
- `oscar/.venv/Scripts/python.exe -m pytest oscar/backend/tests/test_chat_runtime.py -q` — 149 passed.
- Browser QA `1280x720`, `Control > System` — coherent dark glass UI, все controls доступны, console 0 errors / 0 warnings.

### Что взято как идея из Odysseus, а не перенесено

Reference implementation: [Odysseus repository](https://github.com/pewdiepie-archdaemon/odysseus), [official product page](https://pewdiepie-archdaemon.github.io/odysseus/).

Полезные механизмы: typed/native tool calls, `tool_start/tool_progress/tool_output`, live plans, tool budgets, repeat-call breaker, detached server-side runs с replay buffer, persistent collapsible trace, per-turn tool policy и skill-declared toolsets. Monarch адаптирует их под capability contracts, leases и один Policy Kernel.

Не перенесено сознательно: broad shell authority и coarse admin restrictions. В Odysseus рабочая директория shell сама по себе не является sandbox; для Monarch это слишком широкий ambient authority. Здесь модель получает только typed capability, bound scope, budget, deterministic verification и hash-guarded rollback.

## 1. Решение

Проблема подтверждена. Monarch ограничивает модель не одним защитным boundary, а последовательностью независимых владельцев решения:

```text
model text
  -> UI regex parser
  -> natural-language agent job
  -> macro classifier
  -> every module handleIntent
  -> fallback capability scoring
  -> optional Gemma router
  -> resolver
  -> one-step planner
  -> schema
  -> PermissionGate
  -> AgentGuard
  -> Python Security controller
  -> optional Security LLM
  -> executor
```

В результате модель уже может предложить точный `capabilityId + input`, но Monarch превращает это предложение обратно в текст и повторно угадывает действие. Затем `PermissionGate` может разрешить действие, а `AgentGuard` снова потребовать подтверждение. Это одновременно:

- уменьшает фактические agent capabilities;
- добавляет latency и лишние model/runtime roundtrips;
- создаёт ложные отказы и повторные подтверждения;
- делает настройки доступа противоречивыми;
- ухудшает диагностируемость: непонятно, какой из нескольких decision owners остановил действие.

Рекомендуемая цель: **Monarch Agency Plane** из трёх частей:

1. **Action Protocol** — отдельный typed канал `action.proposal`, не команда внутри видимого текста.
2. **Single Policy Kernel** — ровно один итоговый `allow | confirm | deny`, основанный на детерминированных boundary facts.
3. **Capability Leases** — ограниченное по scope, времени и бюджету разрешение на задачу, а не подтверждение каждого файла.

Модель должна владеть выбором инструмента, аргументами, планом и проверкой результата. Kernel должен владеть схемой, canonicalization, hard boundaries, исполнением, rollback и audit. Security не должен быть вторым независимым permission gate.

## 2. Критика предложения «выполнять специальный текст модели»

Идея разделить внутренний командный канал и пользовательский ответ правильная. Более того, Monarch уже реализует её частично: Python prompt просит модель вернуть `[[MONARCH_COMMAND:{...}]]`, UI вырезает marker regex-ом и отправляет действие в `/api/agent/jobs`.

Но выполнять действие при совпадении с произвольным текстом нельзя:

- prompt injection или содержимое прочитанного файла может воспроизвести marker;
- streaming может разорвать JSON или смешать его с пользовательским текстом;
- UI становится security parser;
- модельное предложение теряет тип и повторно проходит natural-language routing;
- трудно доказать, что подтверждённые аргументы равны исполненным;
- текстовый protocol плохо версионируется и плохо поддерживает retry/idempotency.

Безопасная форма той же идеи — два transport-level события:

```text
assistant.delta   -> только пользовательский текст
action.proposal   -> только typed proposal, никогда не рендерится как ответ
```

Если конкретный model backend не поддерживает native tool calls, допустим отдельный constrained output stream/grammar. Но parser должен читать выделенный канал runtime, а не искать управляющую строку в обычном тексте.

## 3. Подтверждённые узкие места в live code

| Узел | Что происходит сейчас | Почему это зажимает модель | Что безопасно ослабить |
|---|---|---|---|
| Model proposal | `model_runtime.py` создаёт `MONARCH_COMMAND`, `utils.js` regex-ом извлекает JSON | Typed intent смешан с untrusted text | Ввести `ActionProposalV1` и отдельное SSE/HTTP событие |
| Agent dispatch | UI сериализует capability plan в строку и отправляет `/api/agent/jobs` | Точная capability снова угадывается router-ами | Typed proposals направлять сразу в schema/policy/executor |
| Router Mesh | Последовательно вызываются все `handleIntent`, fallback scorer и LLM router | Fan-out и конфликтующие candidates даже при точном действии | Router оставить только для human text; exact proposal bypass |
| System router | При готовом endpoint получает весь module/capability/schema inventory с timeout до 2.5 s | Дорогой второй inference на уже определённом действии | Вызывать только при реальной ambiguity |
| Permission profile | Только две оси: sandbox и `on-request | never` | Нет task scope, budget, reversibility, destination | Заменить approval axis на autonomy mode + leases |
| `never` | Любой `confirm` превращается в `deny` | «Никогда не спрашивать» означает «не выполнять» | UI должен различать `auto-allow within policy` и `deny escalation` |
| Full access | `PermissionGate` разрешает большинство write/execute/network | Ниже это разрешение отменяется | Single policy decision; Security отдаёт facts, не второй verdict |
| AgentGuard | Любой `risk != none/read`, оставшийся allowed, принудительно становится `approval_required` | Полностью обнуляет автономию для mutation | Убрать универсальный confirm; оставить mismatch/red-zone/catastrophic facts |
| Security controller | Почти каждое действие вне узкого chat/status allowlist делает controller roundtrip | Даже обычный workspace read проходит лишний review | Все deterministic read и scoped reversible write вести по fast path |
| Security LLM | Для write/execute/network `noLlm=false`; возможен ещё один LLM review | Latency, стоимость, nondeterminism | LLM только advisory для редких ambiguous high-risk cases, с cache по proposal hash |
| Confirmation | 5-минутный single-use token связан с одной pending operation | Многошаговый план снова спрашивает на следующем шаге | Scope-bound task lease с budget и expiry |
| Risk model | Одна строка `read/write/delete/...` | `write README` и broad overwrite имеют один класс | Ввести risk vector: effect/scope/reversibility/externality/privilege/data/novelty |
| Capability catalog | Oscar получает выборку capability cards без input schemas | Модель не знает точный контракт всех доступных действий | Compact full index + `capabilities.search/describe` on demand |
| Skills | Implicit activation выбирает максимум один skill; skills — текстовый контекст | Сложная задача теряет релевантные инструкции, но authority всё равно не ясна | Multi-skill dependency set; skill декларирует needed capabilities, но не выдаёт права |
| UI settings | Access/confirmations находятся в Control, model commands — отдельно в Security | Два экрана управляют одним решением и создают противоречия | Один экран Autonomy с одним понятным policy owner |

Ключевые доказательства:

- `src/core/router-mesh.ts`: module, fallback и LLM candidates собираются до resolver для каждого intent.
- `src/modules/models/system-router.ts`: router endpoint получает полный inventory и имеет отдельный inference timeout.
- `src/core/permission-gate.ts`: `never` превращает escalation в deny; Full Access разрешает обычные write/execute/network.
- `src/modules/security/agent-guard.ts`: разрешённое mutation всё равно становится `approval_required` через `risk.requires-confirmation`.
- `src/core/execution-engine.ts`: после PermissionGate вызывается Security controller; fast path покрывает только ограниченный список conversation/status действий.
- `src/modules/security/index.ts`: AgentGuard verdict затем может объединяться с Python controller verdict.
- `src/ui/public/modules/oscar-pane.js`: каждый следующий plan step отправляется отдельным unconfirmed agent job.
- `src/modules/oscar/index.ts`: capability context содержит id/title/description/risk, но не `inputSchema`.
- `src/modules/astra/agent-skills.ts`: implicit activation обрезается до одного skill.

## 4. Что нельзя ослаблять

Следующие boundaries полезны и должны остаться детерминированными:

- JSON schema validation до любого side effect;
- canonical path + `realpath`/symlink verification;
- allowed roots, read-only roots и red zones;
- запрет write/delete по drive root;
- запрет удаления workspace root;
- защита secrets, credentials, Safe и Security service areas;
- hard block catastrophic disk/system commands;
- отдельная политика для money, identity и credential operations;
- audit trail, proposal/input hash, provenance и emergency stop;
- post-action verification для device/system actions;
- fail-closed для необратимого high-risk действия при недоступности policy/runtime.

Ослаблять нужно не boundary, а повторную интерпретацию уже проверенного действия.

## 5. Action Protocol v1

### 5.1 Turn envelope

```ts
interface AssistantTurnV1 {
  turnId: string;
  visible: {
    text: string;
    status?: 'working' | 'waiting' | 'done' | 'failed';
  };
  proposals: ActionProposalV1[];
}

interface ActionProposalV1 {
  version: 1;
  proposalId: string;
  intentId: string;
  capabilityId: string;
  args: unknown;
  reason: string;
  expectedEffect: string;
  reversibility: 'read-only' | 'reversible' | 'compensatable' | 'irreversible';
  scope: ActionScope;
  idempotencyKey: string;
  preconditions?: PredicateV1[];
  verification?: PredicateV1[];
  provenance: {
    model: string;
    skillIds: string[];
    source: 'model-tool-call' | 'runtime-grammar' | 'deterministic-router';
  };
}
```

`visible.text` не является chain-of-thought и не должен содержать скрытые рассуждения. Пользователь видит краткое намерение, прогресс и результат. Внутренний channel содержит только декларативные action frames и machine-readable observations.

### 5.2 Policy decision

```ts
interface PolicyDecisionV1 {
  outcome: 'allow' | 'confirm' | 'deny';
  policyId: string;
  evidence: PolicyEvidence[];
  canonicalProposalHash: string;
  lease?: CapabilityLeaseV1;
  userMessage?: string;
}
```

Один proposal получает один финальный verdict. Permission, filesystem policy, source trust и Security analyzers возвращают facts в policy kernel, но не создают независимые approval ceremonies.

### 5.3 Risk vector

```ts
interface RiskVectorV1 {
  effect: 'none' | 'read' | 'write' | 'delete' | 'execute' | 'network' | 'device';
  scope: 'single-object' | 'bounded-set' | 'workspace' | 'system' | 'external';
  reversibility: 'read-only' | 'reversible' | 'compensatable' | 'irreversible';
  externality: 'local' | 'localhost' | 'trusted-origin' | 'new-origin' | 'public';
  privilege: 'user' | 'elevated' | 'security-control';
  data: 'public' | 'workspace' | 'personal' | 'secret';
  novelty: 'known-capability' | 'new-args' | 'arbitrary-code';
}
```

Существующий `MonarchRisk` можно временно сохранить как coarse compatibility field, а vector вычислять динамически из capability + canonical args.

## 6. Capability leases: подтверждать задачу, а не файл

Lease — revocable ограниченная authority, выданная policy kernel после user intent или одного подтверждения.

```ts
interface CapabilityLeaseV1 {
  leaseId: string;
  intentHash: string;
  capabilities: string[];
  roots?: string[];
  pathGlobs?: string[];
  origins?: string[];
  expiresAt: string;
  budgets: {
    maxActions: number;
    maxFiles?: number;
    maxBytesWritten?: number;
    maxDeletes?: number;
    maxNetworkRequests?: number;
  };
  allowEffects: string[];
  denyEffects: string[];
  modelId: string;
  skillIds: string[];
  revocable: true;
}
```

Пример lease для обычной задачи разработки:

```text
capabilities: workspace read/list/search/write/append/replace/mkdir
root: <MonarchRoot>
expires: 30 minutes or task completion
budget: 50 files, 5 MiB written, 0 permanent deletes, 0 network uploads
rollback: required for every mutation
```

Такой lease позволяет модели самостоятельно прочитать 30 файлов и изменить 8 связанных файлов без 38 permission checks. Попытка выйти за root, удалить файл навсегда, запустить неизвестный binary или отправить данные наружу создаёт новый verdict.

Lease должен быть связан с canonical user intent, model/skill provenance и policy version. Его нельзя получать из текста skill, prompt или model output.

## 7. Матрица безопасной автономии

| Действие | Default verdict | Условие auto-allow | Когда confirm | Hard deny |
|---|---|---|---|---|
| Local read/list/search | allow | canonical path в allowed/read-only roots | широкий personal scope, если не запросил пользователь | secrets/red-zone read |
| Workspace write/mkdir/append/replace | allow по task lease | reversible journal, allowed root, budget | protected project area, broad replacement, новый root | red zone, drive root, policy files security boundary |
| Move/rename | allow по task lease | same root, reversible | cross-root или большое множество | protected/root escape |
| Delete | soft-delete по lease | workspace trash, bounded targets, undo | permanent delete или broad set | drive/workspace root, catastrophic target |
| Command execution | confirm по умолчанию | declared capability, sandbox, fixed cwd/env/timeout, task lease | arbitrary shell, package install, elevated process | catastrophic/security bypass |
| Network read | allow по destination lease | localhost или user-requested trusted origin, no secrets | новый origin, auth, large download | credential exfiltration/private-data mismatch |
| Network write/upload | confirm | explicit destination + bounded payload + lease | новый recipient, public publish | secret exfiltration, money/identity without dedicated policy |
| App open/media/volume | allow по device lease | reversible, verified result, user session | persistent setting or broad automation | security control tampering |
| Money/identity/credentials | dedicated policy | только отдельный typed flow | почти всегда | отсутствие dedicated contract |

## 8. Целевой runtime flow

```text
User task
  -> Macro intent (conversation | action | multi-step)
  -> Model gets compact capability index + active leases
  -> assistant.delta -------------------------------> User UI
  -> action.proposal
       -> schema validation
       -> canonicalization (paths/origins/args)
       -> deterministic analyzers emit facts
       -> Single Policy Kernel
            allow   -> Action Ledger -> Executor -> Verification -> Observation
            confirm -> one scoped Grant Card -> resume same checkpoint
            deny    -> model receives bounded reason and may re-plan
  -> model continues until verified completion or bounded stop
```

Execution обязано быть stateful:

1. `proposed`
2. `validated`
3. `authorized`
4. `executing`
5. `observed`
6. `verified | rolled_back | failed`

Каждый side effect получает `idempotencyKey`. Confirmation/resume не повторяет уже выполненную часть. Для reversible writes ledger хранит before-state или transaction journal.

## 9. Router и capability discovery

### 9.1 Убрать router с typed path

- Human text без proposal: Router Mesh может определить domain/capability.
- Native model tool call: capability уже определена; Router Mesh не участвует.
- Deterministic UI/voice command: typed capability; Router Mesh не участвует.
- Ambiguous model request: модель вызывает `capabilities.search`, затем `capabilities.describe`.

### 9.2 Progressive capability disclosure

Вместо top-N lexical catalog модель всегда получает компактный index:

```text
workspace: root.get, files.read/list/search/write/append/mkdir/move/replace/delete
device: app.open, browser.open, volume.get/set, media.control
security: status, scan, policy.explain
models: catalog, status, runtime.load/unload
...
```

Точный schema, risk metadata, examples и constraints загружаются через `capabilities.describe(ids[])`. Это уменьшает prompt, но не скрывает существование нужного инструмента.

## 10. Skills

Skill должен быть **recipe, а не permission**.

Предлагаемый manifest extension:

```yaml
required_capabilities:
  - workspace.files.read
  - workspace.files.write
optional_capabilities:
  - network.http.get
trust:
  instructions: untrusted
  bundled_resources: declared
execution:
  direct_scripts: false
```

Правила:

- skill может подсказать план и запросить capability;
- skill не может расширить lease или обойти policy;
- linked/untrusted skills остаются explicit-only;
- script/resource запускается только через declared sandbox executor;
- authority вычисляется из user intent + policy, не из `SKILL.md`;
- для сложной задачи разрешён набор skills с dependency order и общим token budget, а не один implicit winner;
- в audit записываются skill ids и hashes, повлиявшие на proposal.

## 11. Роль Security

Security нужно перевести из второго gate в систему analyzers:

```text
FilesystemAnalyzer -> canonical path, red zone, root escape, symlink
IntentBindingAnalyzer -> requested effect vs proposed effect
CommandAnalyzer -> destructive primitives, elevation, persistence
DataFlowAnalyzer -> source sensitivity -> destination trust
ProvenanceAnalyzer -> model, skill, remote source, capability version
SecurityLLMAnalyzer -> advisory only for unresolved high-risk ambiguity
```

Analyzer возвращает evidence codes и severity. Только Policy Kernel объединяет их с user policy и active lease.

Security LLM:

- не вызывается для deterministic local read/write;
- не может самостоятельно выдать authority;
- может только добавить evidence/escalate;
- result кэшируется по canonical proposal hash + policy version;
- timeout не блокирует low-risk deterministic action;
- для high-risk unresolved action timeout остаётся fail-closed.

## 12. UX-аудит текущих настроек

Проверен живой интерфейс `Control -> System` и `Security -> Settings`.

### Первый контакт

Состояние `Full access + Never ask` визуально обещает максимальную автономию. Фактически `never` запрещает escalation, а AgentGuard повторно спрашивает для mutation. Это критическая semantic mismatch.

### Иерархия и управление

Системные permissions и Oscar command confirmation разделены между двумя разделами. Пользователь не может предсказать итоговый verdict без знания внутренней архитектуры.

### Что сохранить

- понятные названия уровней доступа;
- action trace в Oscar;
- точный one-operation confirmation token;
- отдельное включение model proposals;
- emergency/security status.

### Новый экран Autonomy

Три режима:

1. **Guided** — reads auto, writes/external effects confirm.
2. **Workspace autonomous (recommended)** — local reads и reversible workspace mutations auto; delete/unknown execute/external write confirm.
3. **Full local autonomy** — bounded local/device actions auto; irreversible, privileged и external effects confirm.

Один grant card должен показывать:

```text
Разрешить Oscar работать в <MonarchRoot> до завершения задачи
Capabilities: read/list/search/write/mkdir/replace
Budget: 50 files, 5 MiB, без permanent delete и upload
Expiry: task completion / 30 min
[Запретить] [Разрешить один раз] [Разрешить для задачи]
```

В activity rail показываются action, scope, result и rollback, но не chain-of-thought. Emergency stop и revoke current lease должны быть доступны постоянно.

Ограничение аудита: screenshots подтверждают видимое состояние и hierarchy; semantic labels дополнительно проверялись через DOM. Полный keyboard/screen-reader аудит в этот проход не выполнялся.

## 13. Threat model целевой схемы

| Атака/сбой | Защита |
|---|---|
| Прочитанный файл содержит `MONARCH_COMMAND` | visible content не является executable channel |
| Модель подменяет capability/args после confirm | canonical proposal hash + immutable pending proposal |
| Replay после resume/reconnect | nonce + idempotency key + action ledger |
| Skill просит опасный script | skill has no authority; sandbox executor + policy |
| Symlink выводит write за workspace | realpath/canonical target validation непосредственно перед side effect |
| Модель дробит опасное действие на малые шаги | cumulative lease budgets + data-flow/effect accounting |
| Широкий план расходится с intent | intent binding + scope limit + per-plan max actions |
| Policy/Security unavailable | low-risk deterministic rules continue; unresolved high-risk fails closed |
| Модель недоступна | deterministic UI/voice/read routes продолжают работать без model router |
| Executor падает после side effect | journal + observed state + resume-safe idempotency/rollback |

## 14. Идеи из открытых решений

Использовать как принципы, не переносить реализацию:

- **Model Context Protocol**: typed tool definitions, JSON schemas и structured results; tool annotations считаются untrusted. Для Monarch это прямое обоснование отдельного action channel и schema validation.
- **OpenHands**: разделение `Action -> sandboxed Runtime -> Observation`; backend не исполняет arbitrary action сам. Полезно для command/script executor.
- **LangGraph**: durable checkpoints, dynamic interrupts и resume; side effects до interrupt обязаны быть idempotent. Полезно для confirmation и multi-step plans.
- **Open Interpreter**: показывает ценность прямого local execution и простого autonomy switch, но бинарный `-y` слишком груб для Monarch. Нужны scoped leases, а не глобальное снятие подтверждений.
- **AgentDojo**: indirect prompt injection через untrusted data должна считаться базовым threat, поэтому text marker нельзя считать control channel.
- **ToolEmu**: эмулированный sandbox полезен как eval layer для опасных proposal до допуска новых capabilities.
- **SAFEFLOW**: transactional execution, provenance, write-ahead logging и rollback подходят для Action Ledger.

Ссылки:

- https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- https://docs.openhands.dev/openhands/usage/architecture/runtime
- https://docs.openhands.dev/sdk/arch/security
- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://github.com/openinterpreter/open-interpreter
- https://huggingface.co/papers/2406.13352
- https://huggingface.co/papers/2309.15817
- https://huggingface.co/papers/2506.07564

## 15. План миграции

### Phase 0 — shadow telemetry

Не менять verdict. Добавить correlation от proposal до executor и измерять:

- `proposal_to_execute_ms` p50/p95;
- router candidates/fan-out;
- количество policy/controller/LLM checks на action;
- confirmations per completed task;
- Security verdict disagreements;
- route misses после exact model proposal;
- action retries/double execution;
- lease simulation hit/miss;
- rollback success.

### Phase 1 — typed proposal lane

- Добавить `ActionProposalV1` и versioned validator.
- Добавить `action.proposal` SSE event или `/api/agent/proposals`.
- Поддержать native tool call и runtime grammar adapters.
- Старый `MONARCH_COMMAND` оставить только compatibility fallback behind flag.
- Typed proposal не отправлять в Router Mesh.

Scope первого slice: только `workspace.root.get`, read/list/search, write/append/mkdir/replace. Delete/execute/network/device semantics не менять.

### Phase 2 — one policy decision

- Добавить `PolicyEvidence` и `PolicyDecisionV1`.
- PermissionGate и Security analyzers переводить в fact providers.
- Убрать универсальное `risk.requires-confirmation` из AgentGuard.
- Оставить catastrophic/red-zone/intent mismatch/remote-source rules.
- Security LLM убрать из deterministic hot path.

### Phase 3 — task leases and ledger

- Добавить lease store, budgets, expiry, revoke.
- Добавить action ledger, idempotency и workspace mutation journal.
- Один grant возобновляет тот же persisted plan.
- Следующие steps используют lease без повторного router/confirmation.

### Phase 4 — capability discovery and skills

- Compact full capability index.
- `capabilities.search/describe`.
- Manifest capability requirements для skills.
- Multi-skill set с provenance и token budget.

### Phase 5 — autonomy UX and deprecation

- Объединить Control access и Security model confirmation в Autonomy.
- Мигрировать старые profiles в Guided/Workspace autonomous/Full local.
- Показать lease, budget, expiry, revoke и action ledger.
- Удалить text marker после telemetry периода без legacy usage.

## 16. Первый безопасный implementation slice

Первым кодовым изменением делать не «разрешить всё», а **typed workspace proposal fast path**.

Файлы/контракты:

- `src/core/contracts.ts`: `ActionProposalV1`, `ActionObservationV1`, `PolicyEvidence`.
- новый `src/core/action-protocol.ts`: version/schema/canonical hash/idempotency.
- `src/app/http-server.ts`: versioned proposal ingress.
- `src/app/application.ts`: immutable pending proposal и direct Kernel execution.
- `src/modules/oscar/index.ts` + Python client/runtime: structured proposal event.
- `src/ui/public/modules/oscar-pane.js`: render visible text и proposal trace отдельно.
- `src/modules/security/agent-guard.ts`: пока только telemetry comparison, без изменения hard rules на первом commit.

Acceptance:

1. Текст `[[MONARCH_COMMAND:...]]` в user/model/file content ничего не запускает.
2. Exact `workspace.files.write` proposal не вызывает Router Mesh или Gemma router.
3. Исполняется ровно тот canonical input, который прошёл schema/policy.
4. Existing filesystem red zones, drive/workspace-root guards и symlink checks проходят без изменений.
5. Retry/resume не выполняет write дважды.
6. Видимый ответ не содержит protocol JSON.
7. Legacy marker остаётся fail-closed fallback и отмечается telemetry.
8. Delete/execute/network/device/identity/money не получают новых разрешений.

После этого второй slice — shadow `CapabilityLeaseV1` для reversible workspace mutations. Только после собранной статистики следует удалять duplicate confirmation из AgentGuard/Security hot path.

## 17. Итоговая позиция

Полностью зажимать модель действительно неразумно: это снижает качество выполнения и не обязательно повышает безопасность, потому что сложная цепочка сама создаёт рассинхронизацию и обходные paths.

Но «доверять модели» не должно означать «выполнять shell из текста». Правильный баланс:

- **больше свободы модели в планировании и выборе typed capabilities;**
- **меньше повторных routers и LLM reviewers;**
- **один детерминированный policy verdict;**
- **узкие revocable leases вместо перманентной ambient authority;**
- **transactional executor, verification и rollback вместо постоянных диалогов подтверждения.**

Так Monarch станет одновременно более агентским и более доказуемо безопасным.
