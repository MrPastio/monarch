# Plugins Module

`plugins` - системный read-only модуль, который делает расширяемость Monarch видимой самому агенту.

Он не загружает пакеты напрямую. За загрузку отвечает `MonarchModuleLoader`. Задача `plugins` - дать агенту безопасную карту того, какие extension surfaces сейчас активны и какой контракт нужен для нового модуля.

## Capabilities

- `plugins.catalog.list` - список активных модулей как plugin surfaces: kind, status, owns, permissions, dependencies, events, capabilities.
- `plugins.capability.map` - capabilities, сгруппированные по модулям, чтобы роутер/агент мог понять покрытие системы.
- `plugins.contract.describe` - минимальный контракт для добавления нового module package.

## Почему Это Отдельный Module

Diagnostics отвечает на вопрос "что происходит в ядре".

Plugins отвечает на вопрос "как Monarch расширяется и какие расширения доступны агенту".

Это пригодится для будущего сервиса плагинов:

- установка внешних packages;
- проверка совместимости с core API;
- включение/отключение расширений;
- permission review перед активацией;
- генерация шаблона нового модуля.

## Safety

Текущая версия read-only. Она не пишет файлы, не устанавливает зависимости и не активирует новый код. Все capabilities имеют risk `read`.
