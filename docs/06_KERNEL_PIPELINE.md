# Kernel Pipeline

Это текущий рабочий путь обработки запроса в Monarch.

```text
submitIntent()
  -> intent.received event
  -> router mesh
  -> route decision
  -> planner
  -> plan
  -> execution engine
  -> schema validation
  -> permission gate
  -> module.executeCapability()
  -> events + audit
  -> intent result
```

## Intent

`MonarchIntent` - входная единица системы.

Он содержит:

- `id`
- `source`
- `text`
- `createdAt`
- `context`

`context.confirmed` сейчас используется smoke-пайплайном как признак пользовательского подтверждения. Позже это должно стать отдельным confirmation flow в UI/API.

## Route

`MonarchRouteDecision` выбирает:

- target module
- capability
- confidence
- reason
- первичный input
- ожидаемый permission mode

Важно: route не исполняет действие. Route только предлагает путь.

### Router v0.3

The router now resolves through route candidates:

```text
intent text
  -> deterministic intent classifier
  -> parent-router metadata
  -> model-route decision
  -> module handleIntent() candidates
  -> manifest fallback candidates
  -> optional local systemrouter candidates
  -> deterministic scoring
  -> risk threshold check
  -> ambiguity check
  -> missing-input check
  -> MonarchRouteDecision | null
```

Module `handleIntent()` results are still compatibility signals. Router v0.3 converts them into `MonarchRouteCandidate` records with `source: 'module'`, then combines them with candidates produced from capability `routing` metadata and the optional local systemrouter endpoint.

Fallback scoring inspects `routing.aliases`, `routing.keywords`, `routing.examples`, `routing.intentKinds`, capability id/title/description, module id/name, and `manifest.owns`. Exact alias phrase matches score strongest; keyword, capability, module-domain, and examples provide deterministic supporting evidence. Pure fallback confidence is capped so metadata cannot accidentally outrank a strong module self-evaluation.

The deterministic classifier adds MARK-ALFA-inspired routing context before candidate resolution:

- `MonarchIntentClassification`: chat, code, file generation, file operation, system action, tool use, search, or multimodal.
- `MonarchParentRouteDecision`: high-level action/delegate/risk/web/files decision for the execution lane.
- `MonarchModelRouteDecision`: weak, medium, powerful, or vision model tier preference plus fallback roles.

The local systemrouter is optional. It receives sanitized module/capability metadata plus the deterministic routing analysis, returns candidates only, and cannot bypass risk thresholds, ambiguity checks, schema validation, or permission policy.

Resolution is conservative:

- no candidates -> `null`
- top confidence below the capability risk threshold -> `null`
- close second candidate -> `null` for now, with a TODO for clarification
- missing required input -> `null` for now, with a TODO for clarification

Read-only routes use lower thresholds than write, execute, delete, device-control, money, or security-sensitive routes. Ambiguous requests such as `show status` should not randomly pick diagnostics or security scans if the scores are close.

Each routing pass emits a sanitized `router.route_trace` event and a `routing` audit entry containing the router version, classifier output, parent-router metadata, model-router metadata, candidates, score parts, selected route, rejected routes, unresolved reason, and resolver reason.

## Plan

`MonarchPlan` - слой между routing и execution.

Сейчас план обычно состоит из одного шага. Но этот слой нужен, чтобы позже поддержать сценарии вроде:

- проверить security status
- выбрать подходящий scan или audit preview
- запросить confirmation
- выполнить несколько write/security-sensitive actions
- записать результат в memory

## Schema Validation

Перед permission и execution input проверяется по `capability.inputSchema`.

Сейчас поддержан минимальный subset:

- object
- string
- number
- boolean
- required
- additionalProperties: false

Это сделано специально: лучше иметь простой валидатор сразу, чем позволить capabilities принимать произвольную кашу.

## Permission Gate

После schema validation действие проходит через permission gate.

Default risk policy:

- `none`, `read` -> allow
- `write`, `delete`, `execute`, `network`, `device-control`, `identity` -> confirm
- `money`, `security-sensitive` -> deny

## Execution

Execution engine исполняет только через:

```text
module.executeCapability(request, context)
```

Ядро не делает доменную работу само.

## Observability

Каждый важный этап дает:

- event
- audit entry
- result metadata при ошибках permission/schema

Это будет основой будущих diagnostics UI, логов, replay, debugging и автономных проверок.
