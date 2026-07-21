# Контракт Модуля

Каждый серьезный блок Monarch должен иметь одинаковый минимальный контракт.

## Module Package

Точка подключения будущего модуля - `MonarchModulePackage`.

Пакет описывает не доменную логику, а способ безопасно загрузить модуль в ядро:

- `id` - id пакета.
- `moduleId` - ожидаемый id manifest, если пакет должен создать конкретный модуль.
- `version` - версия пакета.
- `core.minVersion` / `core.maxVersion` - совместимость с API ядра.
- `enabled` - быстрый способ отключить модуль без удаления кода.
- `factory` - функция, создающая `MonarchModule`.

Минимальный пример:

```ts
export const filesModulePackage: MonarchModulePackage = {
  id: filesManifest.id,
  moduleId: filesManifest.id,
  version: filesManifest.version,
  core: {
    minVersion: '0.1.0',
  },
  factory: createFilesModule,
};
```

## Обязательный Manifest

Каждый модуль объявляет:

- `id`
- `name`
- `version`
- `kind`
- `description`
- `owns`
- `capabilities`
- `permissions`
- `dependencies`
- `events`

## Suite-модули

`kind: 'suite'` обозначает продуктовый модуль верхнего уровня: он получает отдельную
навигационную поверхность и группирует связанные модули. Suite не получает повышенных
разрешений и не обходит router, permission gate, audit или Security.

Дочерний модуль указывает `parentSuiteId` и обязательно добавляет этот suite в
`dependencies`. Это гарантирует, что suite активируется раньше дочернего модуля и
останавливается после него.

```ts
export const studioManifest: MonarchModuleManifest = {
  id: 'studio',
  name: 'Monarch Studio',
  version: '0.1.0',
  kind: 'domain',
  parentSuiteId: 'monarch-modules',
  dependencies: ['monarch-modules'],
  // ...
};
```

## Lifecycle

Минимально каждый модуль должен поддерживать:

- `activate(context)`

Production-модуль должен также поддерживать:

- `deactivate(context)`
- `health(context)`

Доменные модули также могут поддерживать:

- `handleIntent(intent, context)`
- `listCapabilities(context)`
- `explainCapability(capabilityId)`

## Форма Capability

Capability - типизированное действие, которое раскрывает модуль.

Пример:

```json
{
  "id": "security.scan.system",
  "title": "Scan system security posture",
  "moduleId": "security",
  "risk": "read",
  "inputSchema": {
    "summaryOnly": "boolean",
    "includeFiles": "boolean",
    "noLlm": "boolean"
  }
}
```

Каждый `capability.risk` должен быть объявлен в `manifest.permissions`. Если модуль раскрывает `write`, `device-control` или другой риск, manifest обязан явно это признать.

## Правило Границы Модуля

Агент может попросить модуль выполнить capability. Агент не должен обходить модуль и напрямую менять его данные или adapters.

## Правило Версионирования

Capabilities - это контракты. Если input или output shape меняется несовместимо, нужно создать новую версию capability, а не тихо менять поведение.

## Правило Зависимостей

Если модуль зависит от другого модуля, он указывает его id в `manifest.dependencies`.

Ядро запускает модули в dependency-order, а останавливает в обратном порядке. Если dependency отсутствует или образуется цикл, старт ядра должен упасть раньше, чем модуль получит доступ к runtime.

## Router v0.2 Metadata

Capabilities may include optional `routing` metadata. It is a deterministic hint layer for the router, not a replacement for module-owned parsing.

```ts
routing: {
  aliases?: string[];
  keywords?: string[];
  examples?: string[];
  intentKinds?: string[];
}
```

Use `aliases` for short phrases users are likely to type exactly, `keywords` for domain words, `examples` for representative requests, and `intentKinds` for stable internal labels such as `memory.search` or `device-control`.

`handleIntent(intent, context)` remains supported. Router v0.2 converts module decisions into route candidates and combines them with manifest-derived fallback candidates. Modules should keep returning concrete `input` when they can infer required fields; otherwise the router may reject the candidate until a future clarification flow exists.
