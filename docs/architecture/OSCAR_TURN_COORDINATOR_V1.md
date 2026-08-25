# Oscar Turn Coordinator V1

Статус: production-default architecture, 2026-08-01.

## Зачем он существует

`OscarTurnCoordinator` — единственный владелец маршрута пользовательского запроса между answer-only моделью и Agent Runtime. Он устраняет класс дефектов, где текст модели, смена модели, follow-up «подтверждаю» или legacy endpoint могли обойти AgentTask/Kernel и затем выдать вымышленное действие за выполненное.

Неподвижная цепочка для реального действия:

```text
surface -> durable Turn -> AgentTask -> exact approval (если нужен)
        -> Kernel capability -> observation/receipt -> verifier -> Turn outcome
```

Модель не является участником authority-цепочки. Она может выбрать bounded capability или сформировать answer, но не может создать approval, receipt или `verified`.

## Инварианты

- Каждый persistent запрос сначала атомарно становится `monarch.oscar-turn.v1`.
- Operational запрос либо получает связанный AgentTask, либо терминальный `blocked`; fallback в обычный chat запрещён.
- `execution_authority=none` удаляет capability-каталог, agent skills и action contract из prompt.
- Текст `подтверждаю`, голосовая фраза, history, model output и legacy token не создают полномочий.
- Approval действует только как structured event с текущими `taskId + approvalId + capabilityId + canonicalProposalHash` и правильным surface/actor.
- `answered`, `answered:source-grounded`, `verified` и `partial` — разные исходы. UI не использует `completed` как доказательство действия.
- `verified` невозможен без успешной Kernel observation и отдельного `verification.completed(status=verified)`.
- Мутация дополнительно требует receipt/journal identity и capability-owned verification predicate; слабое доказательство становится `partial`.
- `models.agent.respond` и vision interpretation всегда имеют `model-generated` evidence и дают только `answered`/unverified provenance.
- Incognito и encrypted chat answer-only; operational requests блокируются до отдельной private-agent архитектуры.
- Production Monarch Safe не является QA/root для Turn, attachment или storage-audit сценариев.

## Состояние Turn

Контракт находится в `src/oscar-turn/types.ts`.

Основные статусы:

```text
accepted -> routing -> answering|running
                    -> waiting-for-user|waiting-for-approval
                    -> succeeded|blocked|failed|cancelled
```

Терминальные outcomes:

| Outcome | Источник истины |
|---|---|
| `answered` | обычная модель, unverified |
| `answered:source-grounded` | перечисленные внешние источники |
| `verified` | Kernel observation/receipt + verifier |
| `partial` | неполный scan/effect или недостаточное доказательство |
| `blocked` | policy/runtime/trust boundary |
| `failed` | ошибка исполнения или reconciliation |
| `cancelled` | точная отмена Turn/AgentTask |

`MessageProvenanceV1` связывает сообщение с `turnId`, опциональным `taskId` и evidence refs. Только `verification=kernel-verified` получает verified marker; `kernel-partial` отображается отдельно.

## API

Renderer и surface adapters используют:

- `POST /api/oscar/attachments` — bounded immutable PNG/JPEG/WebP ref с digest и binding к conversation/privacy/surface;
- `POST /api/oscar/turns` — idempotent приём запроса по `clientRequestId`;
- `GET /api/oscar/turns/:id` — checkpoint;
- `GET /api/oscar/turns/:id/events` — replayable SSE/JSON;
- `POST /api/oscar/turns/:id/messages` — только точное продолжение `waiting-for-user`;
- `POST /api/oscar/turns/:id/cancel` — отмена Turn и связанного AgentTask.

SSE события: `turn.accepted`, `turn.routed`, `answer.delta`, `task.linked`, `approval.required`, `user.input.required`, `non-authoritative-confirmation`, `turn.outcome`, `turn.failed`.

Клиент не передаёт authoritative `source`, task status, provenance или verified outcome. Source выводится из transport/session.

## Маршрутизация

Порядок решения фиксирован:

1. Только явный `replyToTurnId` продолжает указанный `waiting-for-user` Turn.
2. Текстовое подтверждение при active approval создаёт audit event и повторно показывает ту же карточку, но ничего не выполняет.
3. Operational private Turn блокируется до model call.
4. Явный action идёт в AgentTask; явный information request — в answer lane.
5. Ambiguous запрос получает bounded structured `answer | agent | clarify` disposition.
6. Ошибка classifier при imperative/local target fail-safe выбирает AgentTask; отсутствие runtime даёт `blocked`.
7. Attachments, Web и Deep Research являются modifiers, а не переключателями authority.

Desktop, Telegram, Voice и Coder создают общий Turn/AgentTask. Voice владеет только STT/TTS-транспортом, Coder добавляет доверенный project execution profile, а планирование, discovery, evidence, approvals и terminal semantics принадлежат общему Agent Runtime.

## Approval

Canonical Agent endpoint остаётся единственной точкой решения approval. Обычная карточка предлагает approve once/deny; delete/device/identity/irreversible/sensitive action требует `arm` и отдельный approve в коротком окне. Изменение proposal/hash сбрасывает arm.

Typed/spoken confirmation только фокусирует карточку. Voice не может approve. Telegram callback содержит durable presentation identity и после restart разрешает только существующий approval того же chat/user. Replay, expiry, stale hash, wrong surface/actor и double-click fail closed.

Legacy `confirmed + confirmationToken` возвращает `410 legacy-text-confirmation-disabled`. Старые `/api/intent*`, `/api/execute` и Agent job routes существуют только как deprecated Turn adapters; effectful вызов не выполняется вне AgentTask.

## Attachments и недоверенные данные

Answer Turn передаёт image bytes только в answer-only runtime. Agent Turn сначала получает отдельное vision observation:

- immutable attachment refs повторно проверяются;
- observation сохраняется атомарно в AgentTask как `models.vision.observe`;
- evidence class — только `model-generated`;
- compiled context маркирует данные `untrusted-model-generated`, `instructionsAllowed=false`;
- task получает durable `actionApprovalPolicy=all-effects`;
- любой non-read/`act` proposal останавливается на exact action-card до `tool.started` и Kernel dispatch.

Если vision runtime не вернул terminal observation, Turn становится `blocked`; chat fallback отсутствует.

## Persistence и recovery

- `LocalJsonOscarTurnStore` использует CAS/lock-backed atomic JSON под `runtimePaths.stateRoot`, а не системный диск.
- Turn durable outbox повторяет message persistence, task creation/link и reconciliation.
- Startup reconciler закрывает разрывы `Turn -> task`, `task -> link`, `Kernel terminal -> message` и pending approval restart.
- SQLite conversation rows имеют `client_message_id`, `turn_id`, `task_id`, `provenance_json`, `outcome`, `integrity_warning`; idempotency больше не основана на одинаковом тексте.
- Legacy assistant rows получают `legacy-unknown`; action-like rows без task/receipt получают warning без изменения исходного текста.
- Conversation со связанным task/receipt нельзя удалить, только архивировать.
- Edit/regenerate создаёт новый immutable Turn с `supersedesTurnId`/`retryOf`; receipts старого Turn сохраняются.

## Claim Integrity Gate

Answer stream буферизуется до границы предложения. Structural action markers, просьба написать «подтверждаю» и неподкреплённые локальные action/inspection claims блокируются до UI и persistence. При блокировке сохраняется только системная замена о том, что Kernel ничего не выполнял.

Точный ложный storage-audit ответ инцидента закреплён как adversarial fixture `OSCAR_INCIDENT_FAKE_STORAGE_AUDIT`.

## Storage audit

`workspace.storage.audit` — cancellable read-only capability для desktop/system:

- bounded `root/topN/maxDepth/maxEntries/maxWallTimeMs`;
- каждый путь проходит filesystem policy;
- reparse/symlink/junction не follow;
- Safe и filesystem red zones исключаются;
- worker thread, cancellation, entry budget и deterministic observation;
- access denied, timeout, cancellation и budget exhaustion дают `partial` со skip reasons;
- logical bytes и counts формируются capability, а не моделью;
- cleanup/delete всегда новый task и новый approval.

Реальный `D:\` acceptance 2026-08-01: 14,862 directories, 377,564 files, 200,732,519,428 logical bytes, `partial` из-за 6 EPERM + 3 policy blocks + 2 reparse points, mutations `0`. Три крупнейших top-level каталога независимо совпали по bytes/file counts.

## Обязательные проверки перед изменением границы

```text
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
npm run smoke
npm run desktop:smoke
npm run oscar:test
npm run build:runtime
npm run upload:dry-run
npm run safe:entry:qa
npm run safe:qa
git diff --check
```

Safe QA запускается только с disposable `MONARCH_SAFE_ROOT`; production Safe нельзя читать или использовать как fixture.
