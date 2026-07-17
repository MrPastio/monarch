# Modules

Интеграция Telegram описана в [`docs/modules/TELEGRAM.md`](../../docs/modules/TELEGRAM.md): локальный long polling, pairing/allowlist и маршрутизация задач через Monarch Kernel.

Здесь будут жить будущие блоки Monarch.

Каждый серьезный модуль должен включать:

- `manifest`
- `MonarchModulePackage`
- source code
- tests
- mock adapters
- документацию
- safety policy

Текущие встроенные модули:

- `memory` - первая системная память с локальным JSON-хранилищем.
- `diagnostics` - read-only introspection ядра.
- `plugins` - read-only реестр расширений, capabilities и module contract.
- `models` - каталог локальных моделей и статус рантаймов.
- `workspace` - безопасные операции чтения/поиска/записи файлов в workspace.
- `device` - узкие Windows-действия с обязательным одноразовым подтверждением.
- `security` - локальный Security Center, scans, audit и baseline actions.
- `sharing` - offline OpenAI-compatible API для установленных локальных GGUF-моделей через общий Oscar runtime.
- `custom-tools` - пользовательские sandboxed tools с сетевыми ограничениями.

Каталог встроенных packages находится в `src/modules/catalog.ts`.

## Минимальный Экспорт

Новый модуль должен экспортировать factory и package:

```ts
export function createExampleModule(): MonarchModule {
  return new ExampleModule();
}

export const exampleModulePackage: MonarchModulePackage = {
  id: exampleManifest.id,
  moduleId: exampleManifest.id,
  version: exampleManifest.version,
  core: {
    minVersion: '0.1.0',
  },
  factory: createExampleModule,
};
```

После этого package подключается в `src/bootstrap.ts` через `MonarchModuleLoader.registerPackage(...)`.

Для встроенного модуля добавь его package в `builtInModulePackages`.
