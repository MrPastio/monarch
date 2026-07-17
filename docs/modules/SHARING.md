# Monarch Sharing

## Назначение

Monarch Sharing превращает уже работающий локальный runtime Oscar в подключаемый API для сторонних приложений. Это аналог локального model service: приложение говорит по OpenAI-compatible протоколу, а генерация выполняется внутри Monarch на установленных GGUF-моделях без облачного inference.

Основные Gemma-профили используют общий `LocalModelRuntime`, общую inference-очередь, отмену и выгрузку модели. Малые Qwen GGUF из **Super Fast** загружаются тем же backend-процессом по одному и выгружаются после ответа, поэтому не остаются рядом с Gemma в RAM. Qwen3-TTS запускается как короткий local worker из изолированного `runtime/voice/.venv`: это не второй HTTP server, а ровно один WAV-запрос с освобождением VRAM после завершения.

## Граница приватности

- Генерация полностью локальная; Sharing не вызывает Hugging Face, OpenAI, Ollama или другой облачный inference.
- Внешний запрос передаётся модели без Oscar memory, web-search, workspace tools, Agent Skills и системного prompt Oscar.
- Managed backend по умолчанию слушает только `127.0.0.1:7861`.
- Все `/v1/*` endpoints требуют тот же Bearer token, что и Oscar API. Token хранится в `secrets/oscar_token.txt` и не возвращается capability/status-ответами.
- Настройка control-plane отклоняет не-loopback `MONARCH_SHARING_BASE_URL`. Публикация сервиса в LAN не входит в MVP и требует отдельной threat-model работы.

## Интерфейс в Monarch

В live UI есть отдельный раздел **Sharing**. Он собирает подключение в один короткий flow:

1. Показывает реальный статус API, chat model IDs и отдельно доступные Qwen3-TTS модели.
2. Если backend остановлен, запускает managed Oscar runtime кнопкой **Запустить API**.
3. Даёт отдельно скопировать Base URL и API key, выбрать model ID и проверить endpoint.
4. Генерирует готовую конфигурацию для обычных полей приложения, Python OpenAI SDK, Node.js и PowerShell.
5. Кнопка настройки окружения копирует `OPENAI_BASE_URL` и чтение `OPENAI_API_KEY` из локального token-файла.

API key не вставляется в DOM и не возвращается capability-ответом. В Monarch Desktop отдельный bounded IPC handler читает `secrets/oscar_token.txt` только после нажатия пользователя и сразу пишет значение в системный clipboard. Browser preview вместо раскрытия секрета просит открыть Monarch Desktop.

## API MVP

Base URL:

```text
http://127.0.0.1:7861/v1
```

Endpoints:

- `GET /v1/models`
- `GET /v1/models/{model}`
- `POST /v1/chat/completions`
- OpenAI-style SSE при `"stream": true`
- `GET /v1/audio/models`
- `POST /v1/audio/speech` (`audio/wav`)

Публичные model IDs:

| ID | Локальный tier |
|---|---|
| `monarch-auto` | детерминированный Monarch router + доступный локальный fallback |
| `monarch-fast` | `gemma4-fast` |
| `monarch-balanced` | `gemma4-balanced` |
| `monarch-deep` | `gemma4-deepthinking` |
| `monarch-extra` | `gemma4-31b` |
| `qwen2.5-0.5b-instruct` | Super Fast: `qwen2.5-0.5b-instruct-q4_k_m.gguf` |
| `qwen3-1.7b-instruct` | Super Fast: `qwen3-1.7b-q4_k_m.gguf`, native no-think template |

`GET /v1/models` показывает только реально доступные локальные tiers. `monarch-auto` показывается, если доступна хотя бы одна модель.

### TTS Models

TTS отделены от `/v1/chat/completions`: их нельзя выбрать как chat model и они не подмешиваются в auto-router. `GET /v1/audio/models` показывает только checkpoint'ы с валидной локальной структурой:

| ID | Режим | `voice` |
|---|---|---|
| `qwen3-tts-0.6b-base` | voice clone | Только встроенные `oscar`, `oscar-clear`, `aurora` |
| `qwen3-tts-0.6b-custom` | CustomVoice | Один из встроенных Qwen speakers (`Ryan`, `Vivian`, …) |
| `qwen3-tts-1.7b-voice-design` | Voice Design | Описание голоса в `instructions` |

`POST /v1/audio/speech` принимает OpenAI-style `model`, `voice`, `input`, `response_format: "wav"`, а также bounded `language` и `instructions`. В MVP намеренно поддерживается только WAV: сервис не обещает MP3/Opus, если не создал их честно. Base profile не принимает загружаемые reference audio — только три проверенных локальных голоса Monarch.

## Подключение

Python OpenAI client:

```python
from openai import OpenAI

token = open(r"secrets\oscar_token.txt", encoding="utf-8").read().strip()
client = OpenAI(
    base_url="http://127.0.0.1:7861/v1",
    api_key=token,
)

response = client.chat.completions.create(
    model="monarch-auto",
    messages=[{"role": "user", "content": "Объясни local-first архитектуру."}],
)
print(response.choices[0].message.content)
```

JavaScript:

```js
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';

const apiKey = readFileSync('secrets/oscar_token.txt', 'utf8').trim();
const client = new OpenAI({
  baseURL: 'http://127.0.0.1:7861/v1',
  apiKey,
});

const response = await client.chat.completions.create({
  model: 'monarch-balanced',
  messages: [{ role: 'user', content: 'Напиши короткий пример TypeScript.' }],
});
console.log(response.choices[0].message.content);
```

PowerShell:

```powershell
$token = (Get-Content -Raw .\secrets\oscar_token.txt).Trim()
$headers = @{ Authorization = "Bearer $token" }
$body = @{
  model = 'monarch-fast'
  messages = @(@{ role = 'user'; content = 'Привет!' })
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:7861/v1/chat/completions' `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $body
```

## Поддерживаемые поля chat completion

- `model`
- `messages` с ролями `system`, `developer`, `user`, `assistant`
- `temperature`
- `top_p`
- `max_tokens` и `max_completion_tokens`
- `reasoning_effort` (`low`, `medium`, `high`) для `monarch-auto`
- `stream`
- `stream_options.include_usage`

Сейчас `n` поддерживает только значение `1`. Tools/function calling, embeddings, vision-content parts, logprobs, JSON schema mode, `/v1/responses` и нативные Ollama `/api/*` endpoints в MVP не заявлены.

Для TTS не заявлены streaming audio, произвольные voice-clone uploads, MP3/Opus/AAC transcode и облачный fallback.

## Внутренние точки

- `src/modules/sharing/` — manifest, capabilities и loopback control-plane client.
- `src/ui/public/modules/sharing-pane.js` и `src/ui/public/sharing.css` — live UI, connection presets, status/start flow и responsive glassmorphism.
- `desktop/electron/preload.mjs` + `monarch:copy-sharing-token` — безопасное копирование API key без возврата значения в renderer.
- `oscar/backend/oscar_agent/sharing.py` — OpenAI request/response adapter.
- `oscar/backend/oscar_agent/sharing_qwen.py` — Super Fast Qwen GGUF registry и CPU llama.cpp adapter.
- `oscar/backend/oscar_agent/sharing_tts.py` + `tools/sharing-tts-worker.py` — bounded local Qwen3-TTS -> WAV adapter.
- `LocalModelRuntime.stream_raw_chat()` — чистый внешний prompt path без контекста Oscar.
- `oscar/backend/oscar_agent/main.py` — только регистрация `/v1/*` endpoints.

## Инварианты для следующих агентов

- **Antigravity/Claude Code:** не превращать Qwen TTS worker в постоянный HTTP server и не держать Qwen/Gemma загруженными одновременно в Sharing. Не переносить Qwen voice-profile system prompt в внешний chat API.
- Не перенаправлять Sharing в Hugging Face Inference, OpenAI API, Ollama или другой сетевой fallback.
- Не подмешивать память, web-search, workspace capabilities или Oscar system prompt в `stream_raw_chat()`.
- Не отключать token authentication и не расширять bind с loopback на LAN без отдельного opt-in, threat model и rate limits.
- Не выводить API key текстом, не сохранять его в `localStorage` и не добавлять в capability/status payload; копирование остаётся user-triggered Desktop IPC действием.
- Не заявлять unsupported endpoints как совместимые до contract tests.
- Не добавлять TTS checkpoint в `/v1/chat/completions`, не принимать arbitrary model/reference-audio paths и не добавлять неподтверждённый MP3/Opus output.
