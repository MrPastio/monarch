# Monarch — официальная документация

> Актуальность: 16 августа 2026. Последняя подтверждённая stable-версия в
> pinned release spec — `0.2.4.0`. `0.2.5` подготовлен как Release Candidate,
> но ещё не опубликован и не Authenticode-подписан.

## Что такое Monarch

Monarch — модульная local-first AI-система для Windows. Основные модели,
контекст, проекты и история работают на устройстве. Внешние маршруты отделены:
метаданные обновлений проверяются автоматически, а Research, Images и другие
функции, передающие содержимое задачи стороннему provider, показывают эту
границу отдельно.

Слоган проекта: **«Твой интеллект — на твоём железе»**.

## Главный принцип выполнения

Текст модели не является доказательством действия. Для поддерживаемых операций
Monarch разделяет:

1. запрос пользователя;
2. выбор маршрута и typed capability;
3. решение policy/Permission Gate;
4. выполнение через Kernel;
5. проверку наблюдаемого эффекта;
6. receipt и итоговый статус.

Если эффект нельзя подтвердить, runtime не должен превращать ответ модели или
успешный код процесса в статус «готово». Полная installed-матрица действий для
0.2.5 ещё проходит приёмку, поэтому это описание архитектурного контракта, а не
обещание безошибочного выполнения любой задачи.

## Основные системы

| Система | Назначение | Текущая граница |
|---|---|---|
| **Oscar** | Локальный AI-агент, Chat, Turn Coordinator и Agent Runtime | BETA; Telegram live test пройден, answer fast path работает, но точное one-word instruction-following пока нестабильно |
| **Monarch Coder** | Работа с закреплёнными проектами, журналом и проверками | Beta; качество зависит от модели и тестов проекта |
| **Monarch Safe** | Отдельное зашифрованное хранилище файлов и чатов | Beta; Production Safe не используется в QA |
| **Memory V4** | Изолированная Chat/Coder память, FTS и semantic rerank | Preview; clean-install/restart E2E открыт |
| **Skills / Astra** | Поиск, выбор и создание навыков без отдельной authority lane | Picker проверен; полный create → restart → invoke остаётся Preview |
| **Voice Studio V2** | Диктовка, пресеты и локальные voice-контракты | Preview; mic → STT → answer → Qwen TTS не принят |
| **Images** | Интерактивный Perchance, импорт Download и локальная Gallery | TEST BETA; внешний сервис без SLA и гарантий доступности |
| **Monarch Security** | Локальные sensors, backlog, triage, Deep Scan и quarantine | Preview; polling-мониторинг, не антивирус или EDR |
| **Sharing** | Локальный OpenAI-compatible endpoint для выбранных моделей | Текстовый completion проверен; Sharing TTS сейчас не готов |
| **Studio** | Локальные media-проекты и guided workflow | Alpha |
| **Research** | Явно выбранный внешний поиск и работа с источниками | Preview; live consent → citations acceptance ещё открыт |

## Данные, сеть и разрешения

### Локально по умолчанию

Модели, рабочие файлы, история, настройки и основные хранилища отделены от
установщика и располагаются на устройстве. Это не означает, что внешняя функция
не может передать выбранный пользователем запрос своему provider.

### Сетевые маршруты

- проверка подписанных метаданных обновления выполняется отдельно и не отправляет
  текст чата, историю или содержимое проекта;
- Research получает отдельное согласие на передачу поискового запроса;
- Perchance и AI Horde являются независимыми внешними сервисами со своими
  правилами, сетевыми данными и условиями;
- Sharing-клиент самостоятельно определяет, куда он передаёт полученный от
  локального endpoint результат.

### Изменения компьютера

Режим `workspace-autonomous` может разрешать обратимые действия внутри выбранной
рабочей папки без отдельной карточки на каждый шаг. Чувствительные, необратимые
или выходящие за scope действия требуют отдельного точного подтверждения.

## Релизы и проверка загрузки

До скачивания Monarch проверяет подписанные метаданные stable-канала. После
загрузки он сверяет размер и SHA-256 фактического установщика до начала
установки. `0.2.5` пока остаётся Release Candidate: без подписи, tag и точной
повторной installed-приёмки он не должен предлагаться как published stable.

## Что входит в цикл 0.2.5

- единый Oscar Turn Coordinator и более строгая terminal truth;
- восстановление History/Stop/SSE и durable outbox;
- Auto / Fast / Medium / Pro / Extra как единый выбор модели;
- Memory V4 и Personality V2;
- доступный Skills picker и authoring pipeline;
- Incognito с volatile внутренними stores;
- новый интерфейс и понятные стадии выполнения;
- Images TEST BETA с отдельным provider consent;
- Security hardening: backlog, PE masquerading, bounded parser, quarantine,
  DPAPI и PIN lifecycle;
- атомарные и сериализованные записи Profile, Memory, Coder, Studio и Oscar;
- более точное разделение команды, вложенного материала и внешнего Research.

Между публикационной source-базой `0.2.4.0` (`3bcda381`) и проверенным snapshot
12 августа накоплено 195 коммитов, затронуто 290 файлов, добавлено 57 385 и
удалено 5 813 строк. Эти числа подтверждают масштаб цикла, но не заменяют
installed-приёмку.

## Проверка 16 августа 2026

- TypeScript/Electron: **207 test files passed / 1 skipped; 1989 tests passed / 4 skipped / 0 failed**;
- Oscar backend: **521 passed / 14 explicitly skipped / 0 failed**;
- Security source-gate: **233 passed / 3 skipped / 0 failed**;
- desktop smoke, Safe entry, полный Safe QA и Oscar frontend build — passed;
- реальный Windows-срез подтвердил чтение времени, громкости, яркости и запуск
  Калькулятора с проверкой окна;
- production-сайт проходит build, lint, server-rendered checks и desktop/mobile
  browser smoke без failed requests.

Дополнительно живьём проверены answer fast path и `Открой Telegram`. Telegram
дал danger score `24% / low`, не запросил approval и завершился после одного
model decision и одного verified tool call. Answer path тоже завершился за
`1×1`, но модель добавила фразу вопреки требованию ответить одним словом;
поэтому точное следование формату остаётся BETA.

Открыты: подпись и exact-installer repeat, crash/restart action matrix, Pro/Extra
quality, Memory clean install, Qwen audio path и Security service/PIN/reboot/kill matrix.

## История релизов

| Версия | Веха |
|---|---|
| `0.1.x` | Первые публичные сборки и модульное ядро |
| `0.2.0` | Beta, Modules и Studio |
| `0.2.1` | Agent Policy V3 |
| `0.2.2` | Расширение Monarch Safe |
| `0.2.3.x` | Clean-PC startup и hotfix-линия updater/runtime |
| `0.2.4.0` | Первый публичный этап локального Agent Runtime |
| `0.2.5` | Крупнейший накопительный цикл; Release Candidate, не published stable |

## Источники

- `AI_HANDOFF.md` — хронология реализации и приёмки;
- Git history и publication baseline `3bcda381`;
- `docs/architecture/OSCAR_TURN_COORDINATOR_V1.md`;
- `docs/architecture/OWNER_AUTHORITY_V1.md` — внутренний Owner-контур;
- `SECURITY.md` и source/tests соответствующих подсистем;
- официальный раздел `/ru/updates/0.2.5` — публичный статус текущего цикла.
