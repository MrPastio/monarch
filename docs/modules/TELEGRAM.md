# Monarch Telegram

Локальный Telegram-бот — ещё один вход в тот же Monarch Kernel, а не отдельный ассистент. Сообщения проходят обычный capability router, permission gate и одноразовые подтверждения.

## Подключение

1. Создай бота через BotFather.
2. Сохрани токен в `secrets/telegram_bot_token.txt` или переменной `MONARCH_TELEGRAM_BOT_TOKEN`.
3. Запусти Monarch. Модуль автоматически проверит `getMe` и включит long polling.
4. Открой локальный статус capability `telegram.status`, возьми временный `pairingCode` и отправь боту `/pair КОД` в личном чате.

При запуске модуль также регистрирует актуальное меню команд через `setMyCommands`.

Токен не попадает в UI, логи, chat history или persistent state. Привязки, offset и напоминания лежат в игнорируемом `data/local/telegram-state.json`.

## Возможности

- обычный текст и `/task` отправляют задачу в Monarch Kernel;
- опасные действия подтверждаются одноразовой inline-кнопкой, привязанной к пользователю, чату и исходной задаче;
- `/remind`, `/reminders`, `/cancel` управляют локальными напоминаниями;
- `/security` и `/skills` запрашивают краткий статус защиты и подходящие локальные Agent Skills через обычный Monarch router;
- обычные вопросы вида “что ты умеешь через тг бот”, `/help`, `/status`, `/plugins` и вопросы о защитном режиме маршрутизируются в read-only Telegram capabilities (`telegram.capabilities.describe` / `telegram.status`) без Oscar/LLM fallback;
- `/pending` показывает ожидающие одноразовые подтверждения, `/whoami` — текущую привязку, `/unlink` удаляет доступ этого чата;
- `/lockdown` включает односторонний защитный режим: новые привязки, задачи и изменяющие команды блокируются, pending-подтверждения очищаются; возобновление возможно только локально через `telegram.remote.resume`;
- `/poll` создаёт нативные опросы;
- `/table` использует Rich Messages Bot API 10.1 с fallback на обычный текст;
- `/api METHOD {json}` и capability `telegram.api.call` дают совместимость с новыми Bot API-методами без обновления модуля; плохой JSON получает короткую подсказку по формату, а неизвестные изменяющие вызовы из Telegram требуют отдельного inline-подтверждения;
- длинные ответы безопасно делятся на сообщения Telegram.

Пример `очисти корзину и закрой активный браузер` идёт в `device.desktop.actions`: Monarch объединяет две поддержанные Windows-операции в один план и до выполнения показывает одноразовое подтверждение. Браузер закрывается через graceful `CloseMainWindow`, без принудительного убийства всех процессов.

По умолчанию первая привязка разрешена только в private chat. Группы можно включить через `MONARCH_TELEGRAM_ALLOW_GROUPS=1`. Для локального Bot API server задай `MONARCH_TELEGRAM_API_BASE`; HTTP разрешён только для loopback. Remote HTTPS endpoint кроме `api.telegram.org` заблокирован по умолчанию, чтобы случайно не отправить bot token на чужой сервер; для доверенного кастомного endpoint нужен явный `MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE=1`.

## Защитные границы

- На все сообщения действует rate limit без ответного spam amplification.
- После пяти неверных pairing-кодов одна пара `chat_id + user_id` блокируется на 30 минут; cooldown сохраняется в локальном state и переживает рестарт runtime.
- Callback подтверждения принимают только `confirm` или `deny`, имеют TTL и привязаны к исходным chat/user.
- Если локальный защитный режим уже включён, старые inline-подтверждения больше не исполняются даже при наличии pending-кнопки в Telegram.
- Generic Bot API не может использовать `chat_id` или `from_chat_id`, которых нет среди локальных привязок, включая вложенные параметры и массивы; методы управления polling/webhook/token зарезервированы модулем.
- `telegram.pairing.revoke` удаляет привязку, её напоминания и pending-подтверждения.
- Токен никогда не возвращается в status/UI; ошибки редактируются до вывода пользователю.
- Если `data/local/telegram-state.json` повреждён или не читается, модуль fail-closed: удалённый доступ считается приостановленным, код привязки скрывается до локального восстановления/возобновления.
- В UI у Monarch Control есть отдельная вкладка Telegram: привязки, pairing code, режим polling/lockdown, pending confirmations и защитные действия не смешиваются с общими настройками.
