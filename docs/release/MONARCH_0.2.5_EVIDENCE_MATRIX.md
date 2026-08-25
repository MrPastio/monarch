# Monarch 0.2.5 — evidence matrix

Актуальность: 24 августа 2026. Документ фиксирует границу между реализованным
контрактом, реально пройденной проверкой и допустимым публичным утверждением.

## Clean Windows 11 checkpoint — 24 августа

- exact-source HEAD: `03c5edd46a5b3fe0ae918d3a8dbc14b979c963bb`;
- exact installer: `727156512` bytes, SHA-256
  `7223392E9F106FB71F0B768F94A247536AAB746A27AC098E075366885D8A1CC0`,
  version `0.2.5.0`, Authenticode `NotSigned`;
- локальная preview-страница и exact installer отвечают HTTP 200, installer
  поддерживает byte ranges и отдаёт точный `Content-Length`;
- чистая Windows 11 25H2 в VM скачала installer через Edge; прерванный transfer
  возобновился после reboot, штатная проверка Edge/Defender завершилась, файл
  сохранён без отключения SmartScreen;
- исходный candidate `ff41dc2` остаётся отклонён: встроенная загрузка Basic 2B
  остановилась на 1 MiB при здоровом CDN;
- candidate `03c5edd` содержит body-stall detector и проверяемый Windows curl
  resume fallback; typecheck и focused model/publication regression
  `34/34` прошли;
- после fresh confirmation exact installer штатно установился per-user и запустил
  Monarch на чистой Windows; SmartScreen/Defender не отключались;
- first-run корректно рекомендовал и единственным показал Basic 2B на 8 ГБ RAM,
  остальные варианты остались за явным `Показать все модели`;
- installed Basic 2B дошёл до видимых 16 МиБ, после чего progress не менялся
  минимум 14 минут. Однако после штатного restart Settings показал модель
  `Gemma 4 Fast` как `готова`: activation, selector и persistence прошли, а
  first-run progress оказался stale/не сообщил background completion;
- два installed direct-answer запроса на стабильном 1-vCPU профиле дошли до
  `Ответ · Локально`, но завершились Stop/`Не завершено` примерно через 215/180
  секунд. Backend endpoints отвечали 200 без видимой fatal-ошибки; live answer и
  action acceptance остаются BETA;
- VM штатно выключена, preview server остановлен. Статус — Preview/Beta, stable
  publication запрещена.

Доказательства и точный текущий boundary сохранены во внешнем disposable QA
status, который намеренно не входит в public source snapshot.

## Release-candidate checkpoint — 16 августа

- version metadata синхронизирована на `0.2.5.0` в package, installer и stable spec;
- чистый public snapshot и offline installer собираются из pinned Git object, а не из dirty worktree;
- offline runtime checks, полный relative-import graph и installer layout прошли;
- на disposable synthetic root выполнены два живых сценария: answer fast path
  завершился технически, но нарушил точный one-word constraint; `Открой Telegram`
  прошёл полностью;
- Telegram fast path дал одно model decision, один `device.app.open`, danger score
  `24% / low`, без approval, с Kernel verification реального окна;
- обычный ответ дал одно model decision, один `models.agent.respond` и terminal
  `completed`, но вместо требуемого одного слова модель вернула дополнительную
  фразу: transport/runtime PASS, semantic instruction-following FAIL/Beta;
- первый собранный 0.2.5-артефакт был `NotSigned` и заменён после двух
  найденных installed-дефектов; он не является release artifact;
- Production Safe не читался, не перечислялся и не мутировался.

Публикация stable пока заблокирована: финальный exact-source installer должен быть
собран, Authenticode-подписан и повторно пройти точную installed-приёмку.

## Статус цикла

- опубликованная stable-версия: `0.2.4.0`;
- `0.2.5`: Release Candidate, не опубликован; tag/signing ещё не выпущены;
- publication baseline: `3bcda381`;
- evidence snapshot 12 августа до последующих правок: `ca3b02a`;
- диапазон цикла: 195 коммитов, 290 файлов, `+57 385 / -5 813`.

Масштаб позволяет называть 0.2.5 крупнейшим накопительным циклом Monarch, но не
позволяет называть его опубликованным или полностью принятым релизом.

## Матрица потребительских утверждений

| Область | Что подтверждено | Допустимая формулировка | Что остаётся открытым |
|---|---|---|---|
| Oscar / Agent Runtime | typed capability, danger score, effect/evidence/receipt и честные terminal-state покрыты tests; прежний installed Telegram open прошёл, но clean-VM Basic 2B direct answers на 1 vCPU не завершились до runtime timeout | «Oscar Agent доступен как BETA и отделяет ответ от проверяемого действия» | приемлемая installed latency, exact final-installer answer/action repeat, restart/crash и широкая action matrix |
| Turn, History, Stop, SSE | durable lifecycle, поздние события, stale history, Stop до Turn ID и reconnect покрыты тестами | «Ход задачи и ошибки восстанавливаются устойчивее» | установленный restart/outage E2E |
| Intent routing | команды отделены от логов, changelog, кода и вложенного материала | «Материал меньше рискует быть принят за команду» | широкий installed corpus реальных запросов |
| Research | отдельное data-egress consent и отзыв неиспользованного разрешения | «Перед внешним Research показывается граница передачи» | live consent → search → grounded citations |
| Model selector | Installed first-run на чистой Windows рекомендовал один Basic 2B; после restart Settings показал `Gemma 4 Fast` как `готова`, поэтому activation/selector/persistence подтверждены | «При первом запуске Monarch предлагает подходящую локальную модель» | first-run progress stale на 16 МиБ; later Settings install, multi-model plan и Pro остаются BETA |
| Settings | receipt и read-back подтверждают сохранение | «Настройка считается сохранённой после контрольного чтения» | installed Desktop-attestation matrix |
| Long answers / attachments | continuation сохраняет исходный запрос; вложения bound к истории | «Длинный ответ можно продолжить без потери исходной задачи» | installed reload/viewer с крупными файлами |
| Memory V4 | scope isolation, FTS, bounded retrieval, transactional storage | «Memory V4 доступна как Preview» | clean install, payload availability, restart E2E |
| Personality V2 | профиль и immutable request snapshot проходят source tests | «Профиль общения закрепляется за запросом» | доказанное влияние на ответы реальной модели |
| Skills | picker, `$`-поиск, validation и publish-контракт | «Установленный Skill проще найти и выбрать» | create → restart → discover → invoke |
| Incognito | Turn и AgentTask используют volatile stores и очищаются штатно | «Новые внутренние записи сессии не попадают в основные persistent stores» | forensic audit pagefile/crash dump и installed restart |
| Voice Studio V2 | presets/settings и exactly-once autosend покрыты source/UI tests | «Voice Studio V2 проходит Preview-приёмку» | mic → STT → answer → Qwen TTS; Sharing TTS сейчас 503 |
| Images | ручной Perchance flow, consent/18+ и проверка импортируемого файла | «Images доступна как внешняя TEST BETA» | SLA, availability, mobile и installed 18+ acceptance |
| Security | 233 passed / 3 skipped; backlog, PE masquerading, bounded parser, quarantine, DPAPI и PIN lifecycle | «Security Preview объясняет локальные сигналы риска» | installed service, junction privilege, reboot/kill/update; это не EDR |
| Durable data | atomic replace, serialized writes и fail-closed corrupt-state для ключевых stores | «Снижена вероятность потери состояния при конкурентной записи» | нельзя обещать абсолютную сохранность данных |
| Windows device slice | прочитаны время/громкость/яркость; Калькулятор открыт и окно проверено | «Поддерживаемые Windows-действия проверяются по наблюдаемому эффекту» | полная installed device matrix |
| Computer Use | native provider и exact-window receipts включены; `device.app.open` в 0.2.5 живьём открыл и проверил Telegram | «Управление компьютером — BETA; поддерживаемые действия подтверждаются readback» | сложные UI-цепочки и exact final-installer matrix |
| Public browser authority | unattested browser получает public projection без Owner/DEV state | «Внутренний Owner-контур не показывается обычному browser-клиенту» | installed wrong-device/attestation matrix |
| Marketing site | production build, rendered routes и desktop/mobile browser smoke | «Страница 0.2.5 открыта как Development Preview» | production publication после финального commit |

## Пройденные гейты

- TypeScript/Electron: финальный serial-прогон — `207 files passed / 1 skipped`,
  `1989 tests passed / 4 skipped / 0 failed`;
- `release:test` — `16/16`; Agent/Turn regression suites — `112/112`;
- `npm run typecheck` — PASS;
- Oscar backend: `521 passed / 14 skipped / 0 failed`;
- Security source-gate: `233 passed / 3 skipped / 0 failed`;
- desktop smoke, Safe entry QA, полный Safe QA и Oscar frontend build: passed;
- production browser smoke сайта: desktop `1440px` и mobile `390px`, без failed
  requests, console/page errors и horizontal overflow.

Пропуски Security относятся к Windows symlink/reparse fixtures без необходимой
привилегии. Они не считаются падениями, но оставляют junction acceptance открытым.

## Запрещённые абсолюты

До installed acceptance нельзя утверждать:

- «0.2.5 уже доступна для скачивания»;
- «Oscar всегда выполняет задачу» или «никогда не ошибается»;
- «любая задача гарантированно переживает сбой»;
- «все данные всегда остаются на устройстве»;
- «сеть используется только после разрешения» без оговорки update metadata;
- «Monarch спрашивает перед каждым изменением»;
- «Voice/TTS полностью готов»;
- «Images автоматически и стабильно генерирует бесплатно»;
- «Security является антивирусом, EDR или гарантирует защиту»;
- «данные невозможно потерять».

## Следующий release boundary

1. Исправить stale first-run progress/completion и responsive composer на
   1024x768; activation и restart persistence уже подтверждены.
2. Диагностировать 180–215-second direct-answer timeout на 1 vCPU и проверить
   реальный поддерживаемый multi-vCPU профиль без маскировки runtime ошибок.
3. Собрать новый exact candidate и пройти direct answer, low-risk action,
   restart и later Settings install на чистой Windows.
4. Authenticode-подписать финальный pinned artifact и повторить exact
   hash/layout/installed gates уже на подписанном installer.
5. Только затем публиковать tag/channel/assets.
