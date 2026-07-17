# Diagnostics Module

`diagnostics` - системный read-only модуль для introspection ядра.

Он нужен будущему агенту, desktop UI и API-слою, чтобы смотреть состояние Monarch через тот же capability-путь, что и остальные действия.

## Capabilities

- `diagnostics.modules.list` - список модулей и lifecycle status.
- `diagnostics.capabilities.list` - список доступных capabilities.
- `diagnostics.events.list` - последние события ядра и модулей.
- `diagnostics.audit.list` - последние redacted audit entries.

## Safety

Все capabilities имеют risk `read`.

Модуль не получает прямой доступ к private Map-ам ядра. Он использует только методы `MonarchKernelContext`:

- `listModules()`
- `listCapabilities()`
- `listEvents()`
- `listAudit()`

Так diagnostics остается обычным модулем, а не скрытым обходным путем.
