# Добавление Нового Модуля

Этот файл - короткий маршрут для будущих модулей Monarch.

## 1. Создать папку

```text
src/modules/<module-id>/
  index.ts
  manifest.ts
  README.md
```

Для сложного модуля рядом добавляются `adapters/`, `fixtures/`, `tests/`, `policy/`.

## 2. Описать manifest

```ts
export const filesManifest: MonarchModuleManifest = {
  id: 'files',
  name: 'Files',
  version: '0.1.0',
  kind: 'domain',
  description: 'Workspace file operations through typed capabilities.',
  owns: ['files', 'workspace'],
  permissions: ['read', 'write', 'delete'],
  dependencies: ['memory'],
  events: ['files.changed'],
  capabilities: [
    {
      id: 'files.read',
      moduleId: 'files',
      title: 'Read file',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ],
};
```

## 3. Реализовать модуль

```ts
export class FilesModule implements MonarchModule {
  readonly manifest = filesManifest;

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('files.activated', this.manifest.id);
  }

  async executeCapability(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
    if (request.capabilityId !== 'files.read') {
      return {
        ok: false,
        summary: `Unsupported files capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }

    return {
      ok: true,
      summary: 'File read placeholder.',
      output: {},
    };
  }
}
```

## 4. Экспортировать package

```ts
export function createFilesModule(): MonarchModule {
  return new FilesModule();
}

export const filesModulePackage: MonarchModulePackage = {
  id: filesManifest.id,
  moduleId: filesManifest.id,
  version: filesManifest.version,
  description: filesManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createFilesModule,
};
```

## 5. Подключить в bootstrap

Для встроенного модуля сначала добавь package в каталог:

```ts
// src/modules/catalog.ts
export const builtInModulePackages: readonly MonarchModulePackage[] = [
  memoryModulePackage,
  diagnosticsModulePackage,
  filesModulePackage,
];
```

После этого обычная runtime-сборка подхватит модуль сама:

```ts
const loader = new MonarchModuleLoader();
loader.registerPackage(memoryModulePackage);
loader.registerPackage(filesModulePackage);
loader.loadInto(kernel);
```

Порядок регистрации не обязан совпадать с порядком запуска. Ядро само активирует dependencies раньше зависимых модулей.

Для тестового или внешнего набора modules можно обойти встроенный catalog:

```ts
const runtime = createMonarchRuntime({
  packages: [filesModulePackage],
});
```

Чтобы запустить профиль только с частью модулей:

```ts
const runtime = createMonarchRuntime({
  enabledModules: ['memory', 'diagnostics'],
});
```

## Правило

Новый модуль не должен менять чужое состояние напрямую. Он раскрывает typed capabilities, события и health-check, а ядро уже решает routing, permissions и execution.
