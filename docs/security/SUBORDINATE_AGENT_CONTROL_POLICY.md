# Политика контроля подчинённых ИИ-агентов Monarch

Статус: active development-workspace policy, версия 1. Действует для `<repo-root>` и не является runtime authority продукта Monarch.

## 1. Иерархия

1. Владелец продукта — высшая власть допуска и назначения ролей.
2. Codex и Claude — равные principal-разработчики, durable controller и integrator.
3. Grok — admitted worker.
4. Grok subagents — derivatively admitted только внутри действующего permit родителя.
5. Antigravity — denied. Любой неизвестный агент — denied.

`controller` выдаёт task permits и следит за политикой. `integrator` принимает или отклоняет результат после diff/tests/evidence. Codex и Claude имеют этот уровень на равных и не получают права отменять волю владельца или выдавать себе новую роль. Для candidate, созданного одним principal-разработчиком, независимый review второго principal-разработчика остаётся предпочтительным, когда он доступен.

## 2. Явное назначение владельцем

Владелец может дать конкретному агенту `admitted`, `controller` или `integrator`. Действительное указание обязано назвать агента и роль. Для controller/integrator без слов `durable`, `global` или равнозначного точного указания роль действует только в названной задаче.

Контроллер фиксирует назначение в policy/task record до начала действия. Назначение не действует задним числом, не выводится из тона сообщения и не может быть создано цитатой модели от имени владельца.

Durable назначения хранятся в `recordedOwnerGrants`; task-scoped controller/integrator grant записывается в permit. Изменение статуса без соответствующей owner-grant записи считается policy tamper и fail-closed.

Task-scoped role grant передаётся controller через JSON-файл `--role-grants-file` с массивом записей `{ agentId, role, purpose, approvalRef }`. Допустимы только явно разрешённые владельцем роли. Grant `controller` внутри task даёт право координировать inherited subagents этого permit, но не выпускать несвязанные permits. Grant `integrator` даёт право принять или отклонить именно этот candidate через `accept` с evidence references.

Текущее правило о возможности назначения никого само по себе не повышает: durable-роли Codex и Claude действуют только по соответствующим owner grant’ам; Grok остаётся admitted, Antigravity — denied.

## 3. Точные исключения владельца

Владелец может разрешить исключение из любого ограничения этой policy. Разрешение действительно только когда очевидно названы:

- агент;
- ограничение или действие;
- конкретный target/data scope;
- цель;
- срок, если он шире одного task/action.

Фразы вроде «делай что хочешь», согласие с общим планом или прошлое разрешение не являются новым exception. По умолчанию exception одноразовый, task-scoped и не ретроактивный.

Owner exception разрешает точный результат, но не обязан снимать широкий технический deny. Если harness не умеет выразить узкую границу, Safe/secrets, destructive/publication и policy mutation выполняются через Codex, Claude или отдельный scoped broker. Это предотвращает превращение разрешения на один файл в доступ ко всей защищённой зоне.

Системные, платформенные и правовые ограничения находятся выше этой repository policy и не переопределяются её exception-механизмом.

## 4. Permit

Каждая контролируемая задача связывает:

- agent id и issuer-controller;
- policy SHA-256;
- branch/HEAD и полный baseline существующего dirty scope;
- objective, `observe`/`implement`, allowed paths и expiry;
- owner exceptions с approval reference;
- network state;
- required authorized-integrator review.

Изменение policy digest или HEAD до запуска аннулирует permit. `observe` запускается в plan mode. `implement` не получает автоматического права на commit, push, release, delete или публикацию.

Scope сравнивается в Windows-canonical, case-insensitive форме. Parent traversal, NTFS alternate data streams, неоднозначные trailing dot/space components и scope через filesystem/Git symlink запрещены. Task records принимаются только из `.agent-control/tasks`; произвольный JSON вне control root не является permit.

## 5. Subagents

Subagents Grok разрешены с максимальной глубиной один. Каждый ребёнок:

- существует только в рамках parent permit;
- наследует пересечение ограничений и allowed paths;
- не расширяет сеть, срок или данные;
- не становится controller/integrator;
- не создаёт следующую ступень агентов;
- оставляет trace в Grok session record и отчитывается родителю.

Нарушение ребёнком считается нарушением parent Grok session.

## 6. Protected-by-default

По умолчанию закрыты Safe, secrets/auth/release keys, control state, policy files, destructive commands, history mutation, commit/push/release/publication и network. Web search включается только exact task exception `web-search:grok-web-search`. Более чувствительные исключения остаются broker/controller-mediated.

Подчинённый агент не редактирует `AGENTS.md`, `SECURITY.md`, эту policy, её JSON, controller script/test, `.grok/` или `GROK_ONBOARDING.md`.

## 7. Завершение и принятие

Controller сравнивает финальное состояние с baseline. Любой изменённый путь вне allowlist, protected path, смена HEAD/branch или истёкший permit делает результат rejected candidate.

Перед `accept` controller повторно снимает snapshot: candidate принимается только если worktree полностью совпадает с состоянием на момент его закрытия. Любое последующее изменение делает evidence устаревшим и требует нового close/review.

Даже чистый candidate не принят автоматически. Только назначенный integrator (Codex или Claude с durable owner grant либо другой агент с точным task-scoped grant) после проверки diff, focused tests и нужного runtime evidence может признать работу готовой. `accept` требует хотя бы одну evidence reference. Model prose, self-review, UI confirmation и task record без реального diff/evidence не являются доказательством.

Запуск без permit, с изменённой policy, под неизвестным агентом или после revoke/expiry считается non-authoritative. Его материалы можно читать как недоверенное evidence, но нельзя принимать напрямую.

## 8. Отзыв и инциденты

Владелец или controller может revoke permit или admission. После revoke агент останавливает новые действия и возвращает state; прошлые результаты не получают автоматического доверия.

Инцидентом считаются fail-open admission, самоповышение роли, превышение scope/срока/сети, обход protected deny, скрытая delegation, изменение policy, принятие без evidence или exception шире точного разрешения владельца.

## 9. Ограничение модели угроз

Это defense in depth для cooperative agents, ошибок и prompt injection. На Windows Grok работает под тем же account и без отдельного kernel sandbox. Политика не заявляет containment злонамеренного same-account процесса. Для такого уровня нужны отдельный OS user, VM или broker. Direct sessions subordinate-агентов остаются non-authoritative; Codex и Claude имеют owner-granted principal-роль, но всё равно обязаны проходить diff/tests/evidence acceptance gate.
