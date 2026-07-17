# Системное Ядро

Ядро Monarch должно оставаться маленьким. Оно координирует экосистему, но не содержит доменную логику.

## Ответственность Kernel

- Загружать module manifests.
- Проверять permissions и dependencies модулей.
- Запускать и останавливать модули.
- Давать общий event bus.
- Давать capability registry.
- Давать permission gate.
- Отправлять intents в router mesh.
- Создавать execution plans.
- Вести audit logs решений и выполнений.

## Чего Kernel Не Делает

- Не знает внутреннюю модель файлов, security scans или внешних adapters.
- Не редактирует файлы напрямую без file-модуля.
- Не владеет UI-состоянием глубже shell-level статуса.
- Не хранит секреты в обычных settings.
- Не выполняет произвольный сгенерированный код как основной путь.

## Core Services

### Module Registry

Отслеживает установленные модули, manifests, lifecycle, health, dependencies и exposed capabilities.

Текущий source: `src/core/module-registry.ts`.

### Capability Registry

Хранит типизированные действия, которые раскрывают модули:

- `workspace.files.read`
- `security.scan.system`
- `files.read_text`
- `browser.open_url`
- `memory.remember`

Текущий source: `src/core/capability-registry.ts`.

### Router Mesh

Набор роутеров, а не один “магический роутер”:

- Intent Router: что хочет пользователь?
- Capability Router: какой модуль может это выполнить?
- Model Router: какая модель или runtime должны рассуждать?
- Safety Router: действие разрешено, рискованно или требует confirmation?
- Execution Router: как именно запустить финальное действие?

Текущий source: `src/core/router-mesh.ts`.

### Permission Gate

Любое действие с реальным эффектом проходит через permission gate:

- read
- write
- delete
- execute
- network
- device-control
- money
- identity
- security-sensitive

Текущий source: `src/core/permission-gate.ts`.

### Event Bus

Модули общаются событиями, а не скрытыми прямыми импортами.

Примеры:

- `module.started`
- `intent.received`
- `capability.executed`
- `permission.requested`
- `security.scan.completed`
- `memory.record.created`

Текущий source: `src/core/event-bus.ts`.

### Memory Gateway

Память - core service, но модули могут владеть доменными индексами памяти.

Core memory gateway должен разделять:

- conversation memory
- user profile memory
- system memory
- module memory
- audit history

## Текущий Execution Layer

`src/core/execution-engine.ts` - слой, который исполняет capabilities только после проверки module registry, capability registry и permission gate.

Если permission возвращает `confirm`, действие не исполняется без отдельного confirmation-флага в execution request.

## Текущий Planning Layer

`src/core/planner.ts` создает `MonarchPlan`.

Сейчас план обычно содержит один step, но это намеренный слой для будущих сложных сценариев.
