# Дополнительные условия внешних сетевых и облачных сервисов Monarch

Версия: `2026-08-09.5`
Дата вступления в силу: `2026-08-09`
Издатель продукта: `MrPastio, издатель Monarch`

> Это release-ready исходник раскрытия, а не обещание абсолютной юридической неуязвимости. До публичного релиза владелец обязан добавить проверяемые юридические реквизиты и получить review лицензированного юриста для выбранных рынков.

> **TEST BETA:** интеграция Perchance и вся cloud-image поверхность Monarch являются исключительно тестовыми функциями, а не готовым production-сервисом. Возможны ошибки, временная недоступность, изменение или удаление функции и несохранённые результаты; SLA и гарантия бессрочной поддержки отсутствуют.

## Краткое существенное раскрытие

1. Основной генератор — независимый сайт **Perchance**, встроенный в Monarch только как тестовая **BETA-функция** без production-гарантий. Разработчик Monarch не владеет им, не управляет им и не является его партнёром, представителем или сотрудником.
2. Monarch не автоматизирует Perchance: не вводит prompt, не нажимает Generate, не читает DOM и не обходит рекламу, модерацию либо ограничения. Пользователь действует внутри внешней страницы самостоятельно; только его нажатие Download передаёт выбранный файл локальному мосту сохранения Monarch.
3. Perchance по опубликованным Terms доступен только пользователям от 18 лет. До первого открытия требуется отдельное явное подтверждение совершеннолетия даже для обычного prompt.
4. AI Horde доступен только как явно обозначенный **аварийный сервис** после ошибки Perchance либо ручного сообщения пользователя о недоступности. Скрытого или автоматического переключения нет.
5. Только после отдельного нажатия «Создать через AI Horde» Monarch передаёт введённые prompt, negative prompt и технические параметры независимой сети и volunteer worker. Anonymous request может считаться shared с LAION.
6. Anonymous доступ не требует регистрации и на момент документа описывается provider как бесплатный, однако имеет самый низкий приоритет, зависит от workers и не получает SLA, гарантированного времени или бессрочной гарантии бесплатности.
7. NSFW по умолчанию выключен. Mature mode требует отдельного подтверждения 18+, а каждый точный NSFW prompt — одноразового подтверждения. CSAM и сексуализация несовершеннолетних запрещены всегда.
8. Встроенный Perchance использует sandboxed WebContentsView с временной непостоянной сессией. Страница обменивается сетевыми данными напрямую с Perchance; Monarch может по явному действию скопировать prompt и принять только скачанный пользователем файл для локальной проверки и Галереи.
9. Новый provider, новая категория получателей или существенное изменение передаваемых данных повышает version и требует re-consent. Текущее принятие не является бессрочным или blanket-разрешением на любые будущие сетевые функции.

## 1. Предмет и принятие

1.1. Документ регулирует функции Monarch, которые по явному действию пользователя обращаются к внешним сетевым, облачным или распределённым сервисам.

1.2. Текущий основной image provider — тестовая BETA-интеграция интерактивного Perchance. Она не является production-сервисом и не имеет SLA. AI Horde — только аварийный provider, который никогда не запускается автоматически. Иные облачные модели и providers не получают разрешение автоматически.

1.3. До первой сетевой генерации пользователь получает полный текст, две независимые unchecked галочки и disabled confirm. Пользователь отдельно подтверждает:

- разрешение на раскрытый cloud processing;
- принятие условий независимых providers, sharing и границы ответственности.

1.4. Без обеих отметок Monarch fail-closed: встроенный Perchance не открывается, prompt не отправляется, generation job не создаётся ни из вкладки «Изображения», ни через Oscar.

1.5. Согласие связано с точной version. Legacy timestamp, прежний toggle или визуально включённый UI-state не считаются принятием текущего Perchance/AI Horde data flow.

## 2. Независимые стороны

2.1. Perchance — независимый интернет-сайт. AI Horde — независимая распределённая сеть, где аварийный generation request может обрабатываться компьютером стороннего volunteer worker.

2.2. AI Horde, workers, LAION, Perchance, модели, datasets, хостинг, CDN, DNS, TLS-инфраструктура и интернет-провайдеры не являются частью Monarch и не находятся под фактическим контролем Разработчика.

2.3. Интеграция, ссылка, кнопка, совместимый API или упоминание названия не означают одобрение, партнёрство, представительство, совместное предприятие, гарантию или обязанность Разработчика отвечать за эти стороны вместо них.

2.4. Разработчик отвечает за собственный продукт, собственный код и точность раскрытого локального поведения. Он не принимает на себя управление чужими servers, workers, models, moderation, storage или content, пришедшим из сети.

## 3. Основной интерактивный data flow Perchance

3.1. После обязательного согласия и отдельного подтверждения 18+ Electron загружает официальный сайт Perchance в sandboxed `WebContentsView` с `nodeIntegration: false`, `contextIsolation: true`, отключёнными permissions и временным непостоянным session partition.

3.2. Monarch не использует недокументированный API и не выполняет DOM injection, scraping, ad hiding, автоматический ввод, клик Generate или чтение результата. Без действия пользователя внутри страницы generation не начинается.

3.3. Monarch может по отдельной кнопке скопировать подготовленный prompt в системный буфер обмена. Пользователь сам вставляет его в Perchance. Сетевой exchange после этого происходит между внешней страницей и инфраструктурой Perchance согласно их Terms/Privacy.

3.4. Perchance может самостоятельно получать IP address, cookies, prompt, usage/advertising data и иные сведения, предусмотренные его фактической страницей и документами. Эти данные не поступают в собственную облачную базу Разработчика, но Разработчик не контролирует их сбор, хранение или удаление независимой стороной.

3.5. Результат Perchance не извлекается из DOM и не сохраняется до явного действия пользователя. Нажатие Download у конкретного результата считается запросом на локальное сохранение: Electron принимает файл только от текущего доверенного окна Perchance во временную session-папку, ограничивает его размер 24 МБ, проверяет сигнатуру PNG/JPEG/WebP, удаляет временный файл и передаёт проверенные bytes в локальный UI через IPC.

3.6. После проверки Monarch добавляет файл в локальную Gallery с выбранной пользователем категорией контента и правилом persistent/Инкогнито. Этот путь не загружает изображение в собственный облачный сервер Разработчика. Неподдерживаемый, повреждённый или слишком большой файл отклоняется; ручной импорт локального файла остаётся доступен.

## 4. Точный аварийный data flow AI Horde

4.1. AI Horde скрыт по умолчанию. Его вкладка появляется только после ошибки загрузки Perchance либо явного нажатия «Perchance не работает». Даже после этого никакого request нет, пока пользователь отдельно не нажмёт «Создать через AI Horde».

4.2. При таком явном нажатии Monarch формирует HTTPS request к официальному AI Horde API.

4.3. В request входят только:

- prompt;
- negative prompt;
- выбранный style;
- width/height, вычисленные из aspect ratio;
- number of images, максимум четыре;
- seed, если пользователь его задал;
- признак NSFW;
- технические generation parameters и queue flags;
- публичный anonymous API key `0000000000` и client-agent Monarch.

4.4. Monarch не должен добавлять к API request:

- другие сообщения или полную историю чата;
- память Oscar и personality profile;
- содержимое Monarch Safe;
- локальные файлы и вложения;
- contacts, passwords, tokens, recovery codes или payment data;
- персональный account identifier пользователя;
- скрытую product telemetry.

4.5. Если будущая функция потребует source image, identity, attachment, memory, precise location или иной новый вид данных, это существенное изменение: version должна быть повышена до первого такого request.

## 5. Технические и сетевые данные

5.1. Интернет-запрос неизбежно создаёт технический exchange. AI Horde, workers, hosting, DNS, proxy, ISP и TLS infrastructure могут получить IP address, timestamps, traffic volume, client metadata и другие стандартные network/usage data.

5.2. AI Horde указывает IP addresses и prompts в своей Privacy Policy как usage data. Сроки, цели, security, disclosure и deletion на стороне provider регулируются им и применимым законом, а не локальной policy Monarch.

5.3. Разработчик не получает эти данные в собственную cloud-базу через данную integration и не добавляет свою cloud telemetry. Это не означает, что внешняя сеть «ничего не получает».

5.4. Пользователь не должен помещать в prompt реальные names, addresses, phone numbers, documents, credentials, medical data, intimate data, commercial secrets или данные детей.

## 6. Volunteer workers

6.1. AI Horde передаёт prompt и parameters выбранному volunteer worker, который создаёт image и возвращает result в сеть.

6.2. Даже при параметре trusted workers удалённая машина остаётся независимой стороной, а не инфраструктурой Разработчика.

6.3. Worker технически может увидеть, записать или сохранить prompt и result. Monarch не может провести аудит каждой машины, заставить удалить внешнюю копию или гарантировать отсутствие misuse.

6.4. Поэтому AI Horde нельзя использовать для confidential, secret, privileged, private intimate или идентифицирующих данных.

## 7. Anonymous sharing с LAION

7.1. Опубликованные Terms AI Horde указывают, что anonymous text-to-image generations всегда shared with LAION.

7.2. Monarch отображает эту границу до согласия и после generation. Даже если отдельное поле status response возвращает `shared: false`, продукт применяет более строгое опубликованное правило и не обещает private generation.

7.3. Локальное удаление image или job не удаляет возможную copy у AI Horde, worker, LAION, CDN, backup или другого получателя.

## 8. Provider documents

8.1. Использование AI Horde одновременно регулируется актуальными документами provider:

- [AI Horde Terms](https://aihorde.net/terms/)
- [AI Horde Privacy](https://aihorde.net/privacy/)
- [AI Horde FAQ](https://aihorde.net/faq/)

8.2. Ручное использование Perchance регулируется отдельно:

- [Perchance Terms of Service](https://perchance.org/terms-of-service)
- [Perchance Privacy Policy](https://perchance.org/privacy-policy)

8.3. Разработчик не может изменять, толковать от имени provider или гарантировать соблюдение provider его собственных документов.

8.4. Provider может изменить rules, API, age limits, moderation или data practices. Перед релизом и при обнаружении изменения документы нужно пересмотреть.

## 9. Бесплатность, registration и очередь

9.1. Monarch использует опубликованный anonymous API key AI Horde и не создаёт пользовательский аккаунт. Registration для текущего пути не требуется.

9.2. На дату version AI Horde описывает сервис как free. Разработчик не обещает, что независимая сторона сохранит это условие навсегда.

9.3. Anonymous requests имеют lowest priority. Queue position и estimated wait time могут резко меняться. Worker availability, model, latency и output не гарантируются.

9.4. Отсутствие опубликованного fixed daily quota не является обещанием unlimited capacity. Provider может ограничивать нагрузку, отклонять request или менять policy.

9.5. Monarch ограничивает одновременно активные локальные jobs до трёх для устойчивости, но не вводит lifetime quota. После завершения или отмены можно создавать новые jobs.

## 10. Возраст

10.1. Perchance по опубликованным Terms разрешён только лицам от 18 лет. Основной встроенный provider не открывается без отдельной явной 18+ attestation. AI Horde публикует собственный minimum age старше 13 лет, но это не отменяет применимое право.

10.2. Любая NSFW-функция Monarch доступна только совершеннолетнему пользователю 18+.

10.3. Mature mode скрыт в расширенной части Настроек, по умолчанию off и может быть включён на один час или persistent после отдельной 18+ attestation.

10.4. Возрастное подтверждение не разрешает незаконный content и не отменяет более строгие правила provider или закона.

## 11. NSFW policy и запрещённый content

11.1. Перед каждым точным NSFW prompt Monarch выдаёт short-lived single-use challenge. Изменённый prompt требует нового подтверждения.

11.2. Запрещены:

- CSAM и любое сексуальное изображение несовершеннолетних;
- sexualized schoolgirl/schoolboy, loli, shota и лица с неясным возрастом;
- попытки обойти classifier или изменить возраст после описания ребёнка;
- non-consensual intimate imagery и sexual violence;
- exploitation, trafficking и иной незаконный content.

11.3. Monarch отбрасывает result, если AI Horde пометил его как `csam`, censored или как NSFW при safe request. Такой result не сохраняется и не отображается.

11.4. Автоматическая классификация может ошибаться. Она является дополнительным барьером, а не гарантией обнаружения всего риска.

## 12. Пользовательская ответственность

12.1. Пользователь отвечает за законность prompt, negative prompt, references, output, local save, publication, distribution и commercial use.

12.2. Техническая доступность generation не означает законность или отсутствие прав третьих лиц.

12.3. Запрещено использовать output для threats, harassment, blackmail, fraud, impersonation, defamation, discrimination, privacy invasion или обхода закона.

12.4. Пользователь обязан соблюдать copyright, trademarks, likeness rights, personal-data law и licenses фактически использованной model.

## 13. Реальные люди и deepfakes

13.1. Для узнаваемого real person пользователь обязан иметь необходимое consent или иное lawful basis.

13.2. Особенно запрещены intimate deepfakes без согласия, content для blackmail, deceptive political manipulation, fraud или reputational harm.

13.3. Synthetic image нельзя выдавать за authentic evidence. Там, где требует закон или предотвращение deception, output нужно ясно маркировать как AI-generated/edited.

## 14. Intellectual property

14.1. Пользователь отвечает за права на input. Разработчик не передаёт права на AI Horde, Perchance, worker, model, dataset или third-party materials.

14.2. Разработчик не гарантирует uniqueness, copyrightability, non-infringement, registrability или commercial fitness output.

14.3. Model name в job metadata информационен и не является legal opinion. Пользователь самостоятельно проверяет model license перед publication или sale.

## 15. Локальные jobs, Gallery и Incognito

15.1. Monarch не извлекает result из DOM Perchance. Только явное нажатие Download запускает локальную проверку и сохранение выбранного файла в Gallery; пользователь также может отдельно импортировать локальный файл вручную. Persistent аварийная AI Horde generation сохраняет job metadata, prompt и accepted images локально.

15.2. Incognito settings:

- `never` — job и result не пишутся на диск Monarch, result живёт только в memory процесса;
- `ask` — result временно в memory до explicit Save;
- `always` — accepted result сохраняется после completion.

15.3. Закрытие Monarch уничтожает unsaved incognito result, но не отменяет автоматически уже завершённую external processing и не удаляет external copies.

15.4. NSFW Gallery records hidden by default in each session. Они показываются только при active mature mode и отдельном session toggle. UI hiding не является encryption.

15.5. Удаление Gallery record удаляет локальный asset Monarch, но не внешний dataset/share.

## 16. Security boundaries

16.1. Monarch принимает bounded JSON и inline PNG/JPEG/WebP, проверяет size и file signature и не следует произвольному result URL. Это снижает SSRF и content-type risks.

16.2. Эти меры не гарантируют смысловую безопасность изображения. Пользователь не должен выполнять instruction, вводить secret или переходить по link только потому, что это написано на generated image.

16.3. Perchance открывается как основной независимый website внутри sandboxed WebContentsView. Monarch не выполняет DOM injection, scraping, ad bypass или undocumented submit automation. Download-мост реагирует только на пользовательское скачивание, сверяет источник WebContents, размер и magic bytes, после чего удаляет временный файл.

## 17. Availability и отсутствие warranties

17.1. External generation предоставляется «как есть» и «по доступности» в максимально разрешённой законом степени.

17.2. Разработчик не гарантирует uptime, latency, specific model, quality, accuracy, safety, legality, absence of bias/censorship, uniqueness или сохранение external output.

17.3. Queue status отражает последнее подтверждённое API state и не является promise completion.

17.4. Обязательные consumer warranties и remedies, которые закон запрещает исключать, сохраняются.

## 18. Граница ответственности

18.1. Разработчик отвечает за собственный code, собственный умысел, честность disclosure и defects Monarch в пределах применимого закона.

18.2. Разработчик не отвечает вместо независимых providers за их servers, workers, models, datasets, logs, sharing, moderation, breach, blocking, ads, policy changes или content, пришедший из сети.

18.3. В максимально разрешённой законом степени Разработчик не отвечает за indirect, incidental, special или consequential loss, lost profit, reputation, data или opportunity, вызванные independent provider либо незаконным использованием пользователя.

18.4. Ограничение не применяется там, где закон запрещает его применять, включая собственный умысел, сознательно ложное disclosure, обязательную ответственность за вред жизни/здоровью и неотчуждаемые consumer rights.

18.5. Ничто не лишает пользователя права обратиться в компетентный court, consumer protection body или data protection authority.

## 19. Отзыв, re-consent и прекращение

19.1. Пользователь может отозвать provider consent в Settings. Новые jobs блокируются сразу. Сохранённые local images остаются до удаления пользователем.

19.2. Уже отправленный request отменяется только в пределах AI Horde API. Отзыв не удаляет processing, уже выполненный provider, и не удаляет внешние copies.

19.3. Разработчик может отключить integration при изменении API, terms, law или security risk.

19.4. Любая новая существенная integration, provider или data flow повышает agreement version и требует обе галочки снова. Continued use или старый одиночный timestamp не заменяют explicit re-consent.

19.5. Если положение недействительно, остальные применяются в допустимой степени. Документ дополняет основные условия Monarch и не заменяет provider documents.

## 20. Требования и расходы из-за действий пользователя

20.1. В пределах закона пользователь отвечает за claims, penalties и costs, возникшие из его незаконного prompt, отсутствия rights/consents, publication, distribution или обхода protections.

20.2. Это не переносит на пользователя ответственность за собственный defect или unlawful act Разработчика и не создаёт disproportionate consumer penalty.

## Release checklist владельца Monarch

До публичного релиза необходимо:

1. Указать юридическое имя/наименование оператора, физический или юридический address и действующий support/legal contact.
2. Определить markets distribution и проверить consumer, privacy, AI, copyright, deepfake и age-gating requirements.
3. Сверить AI Horde Terms, Privacy, FAQ/API и Perchance Terms/Privacy на дату release.
5. Проверить реальный network trace: request содержит только раскрытые prompt/parameters и не содержит history, memory, Safe, files или hidden telemetry.
6. Проверить, что new provider/data flow повышает version и сбрасывает current consent.
7. Проверить installed Electron flow: unchecked boxes, disabled confirm, accept, repeated generation без повторного modal, revoke и fail-closed.
8. Проверить safe и NSFW queue, exact challenge, cancel, result filtering, incognito never/ask/always и Gallery visibility на disposable profile.
9. Получить review лицензированного юриста. Абсолютная фраза «Разработчик ни за что и никогда не отвечает» не должна использоваться: она может быть несправедливой и недействительной.

## Implementation binding

- Agreement version: `2026-08-09.3`.
- Primary provider id: `perchance-interactive`; интерактивная sandboxed WebContentsView, без DOM automation.
- Emergency provider id: `aihorde-anonymous`; скрыт до provider error или явного действия пользователя, никогда не включается автоматически.
- Anonymous API key: provider-published `0000000000`.
- Consent: two explicit booleans plus exact version; Perchance дополнительно требует отдельную 18+ attestation даже для safe generation.
- Mature mode: separate 18+ attestation and single-use challenge.
- Result transport: inline base64 only; arbitrary remote result URL rejected.
- Active jobs: maximum three concurrently, no lifetime quota.
- Significant provider/data change: version bump and re-consent required.
