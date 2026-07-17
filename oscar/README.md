# Oscar Local Agent

Обычный Oscar chat использует локальные профили Gemma 4 из `<MonarchRoot>\gemma_models`. Два малых Qwen GGUF доступны только как явные `Super Fast` модели Monarch Sharing; они не участвуют в Oscar auto-router, memory или agent flow. Qwen3-TTS — отдельный локальный audio runtime Sharing/Voice, а не chat-модель Oscar.

## Быстрый старт

```powershell
.\scripts\install.ps1
.\scripts\backend.ps1
.\scripts\frontend.ps1
```

UI откроется на `http://127.0.0.1:5173`, backend внутри Monarch работает на `http://127.0.0.1:7861`.

Для быстрой проверки интерфейса без загрузки модели:

```powershell
.\scripts\backend-mock.ps1
.\scripts\frontend.ps1
```

## Gemma Mode

Gemma Mode использует файлы из корневой папки `<MonarchRoot>\gemma_models`:

- `Gemma_E2B\gemma-4-E2B-it-Q5_K_M.gguf` - быстрый профиль.
- `Gemma_12B\gemma-4-12B-it-Q4_K_M.gguf` - сбалансированный профиль и основной vision runtime.
- `Gemma_26B\gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` - глубокий профиль с hybrid offload.
- `Gemma_31B\gemma-4-31B-it-Q4_K_S.gguf` или `Gemma_31B\gemma-4-31B-it-Q4_K_M.gguf` - максимальный локальный профиль.
- `vision_other\mmproj-BF16_E2B.gguf`, `vision_other\mmproj-BF16_12B.gguf`, `vision_other\mmproj-BF16_26B.gguf`, `vision_other\mmproj-BF16_31B.gguf` - vision adapters.
- `mtp_model\mtp-gemma-4-E2B-it.gguf`, `mtp_model\mtp-gemma-4-12b-it.gguf`, `mtp_model\mtp-gemma-4-26B-A4B-it.gguf`, `mtp_model\mtp-gemma-4-31B-it.gguf` - draft/MTP models для speculative decoding.

В интерфейсе выбери `Gemma Mode`; для изображения используй кнопку `Зрение`. Текстовый Gemma-запрос загружает основную модель и, если доступен совместимый MTP-файл, draft model для speculative decoding. Vision-запросы не используют draft model, чтобы не смешивать два хрупких runtime-режима.

Vision-запросы идут через `Gemma4ChatHandler`. Если локальный `llama.cpp` runtime отвергает adapter, статус модели покажет `gemma_vision_runtime_status=unsupported`, stream завершится `done.ok=false`, а текстовый Gemma Mode можно повторить без перезапуска backend.

Полезные параметры `.env`:

```env
OSCAR_GEMMA_MODELS_DIR=D:\MonarchModels
OSCAR_GEMMA_CONTEXT_TOKENS=4096
OSCAR_GEMMA_SPECULATIVE_DECODING=1
OSCAR_GEMMA_DRAFT_MODE=mtp
OSCAR_GEMMA_DRAFT_NUM_PRED_TOKENS=4
OSCAR_DEFAULT_MAX_NEW_TOKENS=8192
```

## Оптимизация под твоё железо

Проверенный профиль RTX 4060 Laptop использует окно 4096 токенов и hybrid CUDA offload. Oscar заранее сокращает старую историю, веб-контекст и workflow-инструкции до доступного бюджета. Fallback означает реальную ошибку runtime и не считается нормальным ответом модели.

## Как работает память

Когда включён `Web`, backend ищет в интернете, скачивает найденные страницы, чистит HTML, режет текст на фрагменты и сохраняет в SQLite FTS5 базу `data\memory\oscar_memory.sqlite3`.

Когда включён `Memory`, перед ответом агент ищет релевантные фрагменты в этой базе и добавляет их в контекст модели с цитированием `[1]`, `[2]`.

## Настройки

Основные параметры лежат в `.env`:

```env
OSCAR_GPU_MEMORY_GB=6
OSCAR_CPU_MEMORY_GB=24
OSCAR_CPU_THREADS=10
OSCAR_ATTENTION_IMPLEMENTATION=eager
OSCAR_PORT=7861
OSCAR_MOCK_MODEL=0
OSCAR_MOCK_FALLBACK=1
OSCAR_SEARCH_TOP_K=5
OSCAR_RETRIEVAL_K=6
```

После изменения профиля или файлов Gemma перезапусти backend.
