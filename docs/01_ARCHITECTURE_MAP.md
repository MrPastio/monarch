# Карта Архитектуры

Это первая грубая карта. Она намеренно высокоуровневая.

```text
User
  -> Interfaces
     -> Desktop UI
     -> Voice
     -> Local API
  -> Agent Runtime
     -> Intent understanding
     -> Conversation state
     -> Planning
  -> Router Mesh
     -> Intent Router
     -> Capability Router
     -> Model Router
     -> Safety Router
     -> Execution Router
  -> Planner
     -> Single-step plans
     -> Future multi-step plans
  -> System Core
     -> Module Registry
     -> Tool Registry
     -> Event Bus
     -> Permission Gate
     -> Audit Log
     -> Health Monitor
     -> Memory Gateway
     -> Observability
  -> Domain Modules
     -> Files / Workspace
     -> Security Center
     -> Browser / Web
     -> Developer Tools
     -> Automations
     -> Future Blocks
  -> Adapters
     -> Local model runtimes
     -> Device protocols
     -> Apps
     -> Network APIs
```

## Control Plane

Control plane решает, что должно произойти:

- классифицировать намерение пользователя
- выбрать модуль
- выбрать модель или runtime
- проверить permissions
- создать план выполнения
- запросить подтверждение, если нужно

## Data Plane

Data plane переносит реальные доменные данные:

- файлы
- security/audit состояние
- сгенерированные артефакты
- записи памяти
- ответы моделей
- телеметрию
- логи

Control plane не должен свободно менять доменные данные. Он просит модули сделать это через типизированные capabilities.

## Категории Модулей

- `system`: базовые сервисы, например memory, permissions, models, events.
- `interface`: desktop UI, voice, API.
- `domain`: workspace, security, browser/web knowledge, automations.
- `runtime`: локальные model servers, voice bridges, process managers.
- `tooling`: developer и operational tools.
