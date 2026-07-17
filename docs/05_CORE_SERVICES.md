# Core Services

Этот документ фиксирует текущую крупную разметку ядра Monarch.

## Kernel

`MonarchKernel` - координатор, а не место для всей логики.

Он делает:

- регистрирует модули
- запускает и останавливает lifecycle
- принимает `intent`
- просит router mesh выбрать путь
- создает execution request
- передает execution engine
- отдает snapshot для диагностики
- собирает health snapshot

Он не делает:

- не знает внутреннюю модель workspace, security scans или внешних adapters
- не принимает самостоятельных решений о bypass permissions
- не исполняет capability напрямую, если это должен делать модуль

## Contracts

`contracts.ts` - язык всей системы.

Ключевые сущности:

- `MonarchModuleManifest`
- `MonarchCapability`
- `MonarchIntent`
- `MonarchRouteDecision`
- `MonarchExecutionRequest`
- `MonarchExecutionResult`
- `MonarchEvent`
- `MonarchPermissionDecision`
- `MonarchModulePackage`
- `MonarchModuleLoadRecord`

Если будущий блок не может выразить себя через эти сущности, сначала расширяется контракт, а не пишется обходной путь.

## Module Registry

Хранит модули и статусы:

- `registered`
- `active`
- `inactive`
- `failed`

Проверяет manifest и dependencies.

## Capability Registry

Индексирует capabilities из module manifests.

В будущем сюда добавятся:

- versioning capabilities
- tags
- search weights
- schema validation
- compatibility checks

## Event Bus

Единая событийная шина.

Сейчас хранит in-memory history. Позже события можно будет писать в local audit log, показывать в diagnostics UI и использовать для automations.

## Router Mesh

Router mesh не должен быть одним большим if/else.

Текущий слой:

- спрашивает модули через `handleIntent`
- выбирает самый уверенный route
- имеет слабый fallback по tokens

Будущие слои:

- intent router
- model router
- capability router
- safety router
- execution router
- domain routers внутри модулей

## Permission Gate

Permission gate решает allow / confirm / deny на основе risk.

Default policy:

- `none`, `read` - allow
- `write`, `delete`, `execute`, `network`, `device-control`, `identity` - confirm
- `money`, `security-sensitive` - deny

Важное правило: route decision не является пользовательским подтверждением. Confirmation приходит отдельно через execution request context.

## Execution Engine

Execution engine:

- проверяет module
- проверяет capability
- валидирует input по schema
- вызывает permission gate
- блокирует deny и confirm без подтверждения
- исполняет только через `module.executeCapability`
- пишет events о начале и завершении

Это защищает ядро от сценария, где агент сам “догадался” выполнить действие вне модуля.

## Planner

Planner создает `MonarchPlan` из `MonarchRouteDecision`.

Сейчас это один step, но контракт уже готов под многошаговые сценарии.

## Audit Log

Audit log хранит redacted события исполнения:

- schema validation problems
- permission decisions
- execution start/finish

Секретные ключи в audit data редактируются по имени поля.

## Health Monitor

Health monitor вызывает `module.health()` и возвращает общий status по modules.

Это будущая основа для diagnostics UI и self-check режима.

## Module Loader

`MonarchModuleLoader` подключает module packages к kernel.

Сейчас он уже умеет:

- принимать `MonarchModulePackage`;
- сохранять совместимость со старым `registerFactory`;
- пропускать disabled packages;
- проверять совместимость с `MONARCH_CORE_API_VERSION`;
- фиксировать load report через `getLoadRecords()`;
- проверять, что factory создала ожидаемый `moduleId`.

Позже этот слой может стать discovery layer:

- manifest scan
- version checks
- dependency graph
- lazy loading
- disabled modules
- safe mode

Dependency graph уже частично живет в `MonarchModuleRegistry`: kernel активирует модули в порядке зависимостей и деактивирует в обратном порядке.

## Bootstrap Runtime

`src/bootstrap.ts` собирает runtime через каталог модулей.

Главные entrypoints:

- `createMonarchKernel(options)` - быстрый путь, возвращает только kernel.
- `createMonarchRuntime(options)` - возвращает kernel, загруженные modules, выбранные packages и loadRecords.

`enabledModules` и `disabledModules` работают по package id и module id. Это нужно, чтобы будущий desktop/API слой мог запускать Monarch в разных профилях:

- safe mode
- только memory + diagnostics
- полный локальный runtime
- тестовый runtime с custom packages

## Diagnostics Module

`diagnostics` - системный read-only модуль.

Он раскрывает capabilities:

- `diagnostics.modules.list`
- `diagnostics.capabilities.list`
- `diagnostics.events.list`
- `diagnostics.audit.list`

Модуль получает данные через `MonarchKernelContext`, а не через прямой доступ к приватным структурам ядра. Это оставляет границу модулей чистой и одновременно дает будущему агенту способ спросить: "что ты умеешь?".
