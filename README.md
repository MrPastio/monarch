# Monarch

Monarch задуман как локальная AI-экосистема, а не просто приложение-ассистент.

**Стадия продукта:** `Beta`. Suite `Monarch Modules` и дочерний модуль
`Monarch Studio` находятся в стадии `Alpha`: основные пути уже работают, но их
контракты и расширенный функционал ещё могут меняться до стабилизации.

Направление проекта: расширяемая архитектура из маленького системного ядра, роутеров, инструментов, локальных модельных рантаймов, памяти, интерфейсов и независимых доменных блоков. Каждый блок может вырасти в полноценную подсистему, но при этом говорить с остальным Monarch через единый контракт.

Текущий статус: публичная `Beta` с TypeScript control plane, Electron shell, Oscar FastAPI/model runtime, Monarch Security, Safe, Coder, Voice, Sharing, Telegram, promoted suite `Monarch Modules`, alpha-версией `Monarch Studio` и единым capability execution pipeline.

## Установка На Windows

Самый простой путь после клонирования или распаковки проекта:

```powershell
.\Install-Monarch.cmd
```

Установщик автоматически:

- подготавливает изолированный Node.js внутри проекта;
- устанавливает Python 3.11 через `winget`, только если он отсутствует;
- создаёт отдельные Python runtime для Oscar и Monarch Security;
- ставит npm/Python-зависимости и собирает frontend;
- собирает `Monarch.exe`, не перезаписывая локальные настройки и данные.

Большие модели не хранятся в Git и устанавливаются только явно. Дистрибутив
`Monarch-Setup.exe` собирается командой `npm run installer:build`; по умолчанию
он предлагает `E:\Programs\Monarch`, затем `D:\Programs\Monarch`.

Публичный snapshot создаётся через `npm run export:public`. В него не входят
локальные чаты, память, секреты, runtime, модели, логи, agent-handoff и история
рабочих запросов.

## Главная Идея

Monarch не должен быть “одним агентом со множеством функций”. Агент - это интеллектуальный слой приказов. Реальная сила живет в модулях:

- файлы и workspace
- браузер и web-знания
- локальные модели
- память
- голос
- безопасность
- автоматизации
- developer tools
- будущие приватные сервисы

Каждый модуль владеет своей доменной логикой. Ядро маршрутизирует намерение, проверяет безопасность, координирует выполнение, хранит память и раскрывает capabilities.

## Первое Правило

Не строить Monarch как один огромный файл или один огромный assistant loop. Любая серьезная функция должна становиться модулем с manifest, capabilities, permissions, events и тестами.

## Начальная Структура

- `docs/` - архитектурные заметки и правила роста.
- `src/core/` - системное ядро: contracts, event bus, registries, permission gate, router mesh, execution engine.
- `src/app/` - единый слой программы: `MonarchApplication`, HTTP API, system-профиль агента.
- `src/modules/` - 19 доменных и системных пакетов: `assistant`, `workspace`, `artifacts`, `knowledge`, `profile`, `memory`, `astra`, `diagnostics`, `plugins`, `models`, `oscar`, `security`, `safe`, `sharing`, `voice`, `telegram`, `device`, `custom-tools`, `coder`.
- `src/modules/catalog.ts` - каталог встроенных module packages.
- `src/bootstrap.ts` - сборка kernel/runtime с выбранными модулями.
- `src/main.ts` - главный entrypoint: `serve`, `status`, `intent`, `system`.
- `src/ui/` - локальная консоль, которая работает поверх общего application/runtime слоя.
- `data/local/` - приватное локальное состояние, игнорируется git.
- `runtime/` - временное runtime-состояние, игнорируется git.
- `secrets/` - локальные секреты, игнорируются git.
- `docs/modules/TELEGRAM.md` - локальная привязка Telegram, pairing, задачи, напоминания, опросы и Bot API 10.1+.
- `logs/` - runtime-логи, игнорируются git.
- `artifacts/generated/` - сгенерированные пользовательские артефакты, игнорируются git.

## Что Уже Есть В Ядре

- `MonarchKernel` регистрирует модули, запускает lifecycle и принимает intents.
- `MonarchModuleLoader` подключает module packages к kernel, проверяет core compatibility и умеет отключать packages.
- `MonarchModuleRegistry` хранит модули, их статусы и dependency-order lifecycle.
- `MonarchCapabilityRegistry` индексирует capabilities из manifests.
- `MonarchEventBus` ведет события ядра и модулей.
- `MonarchAuditLog` ведет redacted audit history.
- `MonarchPermissionGate` отделяет allow / confirm / deny.
- `MonarchRouterMesh` выбирает module + capability.
- `MonarchPlanner` превращает route в план выполнения.
- `MonarchExecutionEngine` исполняет capability и планы только через модуль.
- `MonarchHealthMonitor` собирает health snapshot по модулям.
- `schema-validator` проверяет capability input по минимальному JSON-schema subset.
- `MemoryModule` дает первую system capability-группу: remember/search/list с локальным JSON-хранилищем в `data/local`.
- `DiagnosticsModule` дает read-only introspection: modules/capabilities/events/audit.
- `PluginsModule` дает read-only registry surface: plugin catalog, capability map и module contract.
- `WorkspaceModule`, `SecurityModule` и `CustomToolsModule` показывают рабочий формат модулей с permissions, аудитом и тестами.

## Как Добавлять Модули

Короткий путь описан в `docs/07_ADDING_MODULE.md`.

Новый модуль должен экспортировать:

- `manifest`
- class/function, создающую `MonarchModule`
- `MonarchModulePackage`

Bootstrap подключает package через `MonarchModuleLoader.registerPackage(...)`, а ядро уже проверяет совместимость, зависимости, permissions и execution path.

Для runtime-сборки есть `createMonarchRuntime`:

```ts
const runtime = createMonarchRuntime({
  enabledModules: ['memory', 'diagnostics'],
});

await runtime.kernel.start();
console.log(runtime.loadRecords);
```

`enabledModules` и `disabledModules` принимают package id или module id. Если `enabledModules` указан, все остальные packages будут skipped.

## Запуск Как Программа

Главный вход теперь один:

```powershell
npm start
```

Это запускает локальный HTTP/UI runtime на `http://127.0.0.1:4317`.
Если порт занят другим процессом, `serve` попробует следующие порты и напечатает фактический URL.

Для desktop-режима:

```powershell
npm run desktop
```

`Monarch.exe` теперь запускает Electron-shell с окном приложения. Electron-shell сам поднимает локальный Monarch runtime на свободном порту и закрывает его при выходе.

Дополнительные команды:

```powershell
npm run status
npm run desktop:smoke
npm run system
npm run intent -- "Покажи плагины"
npm run intent -- "Проверь Security"
npm run security:status
npm run security:scan-system
npm run security:verify-integrity
```

Основные API:

- `GET /api/state` - полный снимок приложения, runtime, моделей, модулей и последнего intent.
- `GET /api/health` - короткий health/load summary.
- `GET /api/system` - system-профиль Monarch для AI-агента.
- `GET /api/modules` - registry модулей.
- `GET /api/capabilities` - capability registry.
- `GET /api/events` - последние события event bus.
- `POST /api/intent` - route/plan/execute intent через kernel.
- `POST /api/execute` - прямое выполнение capability через permission gate.

## Проверка

После установки dev-зависимостей:

```powershell
npm run verify
npm run verify:full
npm run typecheck
npm test
npm run smoke
```

`npm run verify` проверяет TypeScript ядро, unit/integration tests, smoke, Electron/Safe и production-сборку `oscar/frontend`.

`npm run verify:full` — release gate: всё из `verify`, полный Oscar pytest, отдельный Security pytest, upload boundary и оба npm audit.

## Clean-Room

MARK-ALFA остается только исследовательским контекстом. Monarch не должен по умолчанию копировать файлы, промпты, UI, runtime-состояние или реализационные паттерны MARK-ALFA.
