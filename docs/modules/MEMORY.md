# Память Оскара

С Memory 4.1 у Monarch одна система памяти. Старый Kernel-модуль `memory` (JSON в `data/local/memory.json`, capabilities `memory.remember/search/list`) и старые эндпоинты `/api/memory/items*`, `/api/memory/search`, `/api/memory/stats` удалены 2026-10-17.

## Где что живёт

- **Явные записи и факты о человеке** — таблица `memory_items` в SQLite Oscar. Читаются и меняются только settings-командами `memory.*` (`memory.create/update/delete/restore`, `memory.remember/forget`, `memory.suggestion.accept/dismiss`, `memory.learning.set`, `memory.cross-chat.set`) через `ContextSettingsStore` (`oscar/backend/oscar_agent/context_settings.py`) и `SettingsCommandBus` на стороне Monarch.
- **Эпизоды, капсулы и векторы** — `MemoryV4Service` (`oscar/backend/oscar_agent/memory_v4.py`); просмотр и забывание — `oscar.memory.derived.manage` и `/api/memory/episodes`, `/api/memory/capsules/*`.
- **Recall в ответе** — бэкенд Oscar: relevance-gated поиск по stems и E5-векторам плюс маленькое ядро профиля (правила, закреплённое, «Обо мне»).
- **Coder Memory** — карта и заметки проекта в state/Memory Monarch, только внутри своего проекта (`coder.memory.search`).

Счётчики памяти для статуса приходят в `/api/health` → `memory`.
