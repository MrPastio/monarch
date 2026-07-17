# Monarch Security Module

`security` - встроенный runtime-модуль Monarch, который подключает перенесенный проект `Monarch Security` из `security/` к ядру через manifest, capabilities, permission gate, events и audit.

Это не отдельная утилита сбоку: TypeScript-модуль вызывает Python runtime через `python -m monarch_security --config security/config/monarch_security.toml`, а все действия проходят через обычный Monarch execution path.

## Agent Guard

Monarch Security снова защищает не только Windows-хост, но и сам агентный execution pipeline.

- `AgentActionGuard` детерминированно проверяет intent, capability, risk, source, пути и опасные команды до исполнения.
- Решения: `allowed`, `approval_required`, `blocked`. Одноразовое Monarch Access подтверждение может удовлетворить только `approval_required`; hard block не обходится подтверждением.
- Workspace escape, несанкционированное удаление и катастрофические disk/system команды блокируются.
- Telegram и другие удалённые изменяющие действия получают отдельную provenance-метку и требуют точного подтверждения.
- В audit пишутся evidence codes и canonical input hash, но не raw action input.
- Между TypeScript и Python action payload передаётся через короткоживущий локальный файл с ограничением размера, а не через видимую командную строку.
- При отсутствии Python runtime локальная deterministic-защита остаётся активной; host sensors честно помечаются как degraded.

## Runtime

- корень: `security/`
- Python: `security/.venv/Scripts/python.exe`
- config: `security/config/monarch_security.toml`
- state/logs: `security/data/`, `security/logs/`
- wrapper: `security/monarch_sec.ps1`

Root npm-команды:

```powershell
npm run security:status
npm run security:scan-system
npm run security:verify-integrity
npm run security:start
npm run security:stop
```

## Capabilities

- `security.status` - статус фонового protector.
- `security.diagnose` - runtime/config diagnostics.
- `security.audit.tail` - последние записи audit log.
- `security.integrity.verify` - HMAC/integrity check audit/state.
- `security.scan.system` - read-only system scan.
- `security.scan.network` - passive network scan.
- `security.scan.devices` - USB/HID/storage device scan.
- `security.scan.persistence` - autorun/startup/scheduled tasks scan.
- `security.scan.posture` - Defender/firewall posture.
- `security.scan.path` - scan file/folder path.
- `security.deep_scan.file` - deep file inspection.
- `security.protection.start` - запуск фоновой защиты.
- `security.protection.stop` - остановка фоновой защиты.
- `security.baseline.write` - запись baseline.
- `security.verify.protection` - inert protection verification lab.
- `security.attack.simulation` - inert adversarial simulation.
- `security.notification.test` - synthetic alert notification.
- `security.controller.check` - локальная проверка действия агента + Python policy/blocklist.
- `security.controller.block` - постоянный запрет capability или рискованного custom tool.

## Permission Model

Read-only checks идут без подтверждения:

- status
- diagnose
- audit tail
- integrity verify
- scans

Изменяющие и исполняющие действия требуют confirmation:

- start/stop protection
- baseline write
- protection verification lab
- attack simulation
- notification test

## UI

Локальная консоль `npm start` показывает блок `Security`:

- статус protector/runtime;
- быстрый system scan без LLM;
- integrity check;
- audit tail;
- кнопки start/stop с явным confirmed execution.

## Safety

Модуль сохраняет принцип исходного `Monarch Security`: проверки детерминированные, LLM может быть только advisory, автоматических destructive-действий нет. Тяжелые runtime-файлы, модель, venv, logs и state исключены из git.
