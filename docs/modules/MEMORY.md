# Memory Module

`memory` - первый system module Monarch.

Сейчас это локальная JSON-backed реализация в `data/local/memory.json`. Она нужна, чтобы закрепить контракт системных capabilities и дать агенту память, которая переживает перезапуск.

## Capabilities

- `memory.remember` - сохранить запись памяти, risk `write`, требует confirmation.
- `memory.search` - найти записи памяти, risk `read`, allow.
- `memory.list` - показать последние записи, risk `read`, allow.

## Почему Это Module, А Не Просто Core Helper

Память в Monarch должна быть расширяемой:

- conversation memory
- profile memory
- module memory
- audit memory
- semantic memory
- future vector indexes

Если сразу встроить память как скрытый helper в kernel, потом будет тяжело разделить политики, индексы, источники и права доступа.

Поэтому даже system memory идет через manifest, capabilities, permission gate и execution engine.

## Storage

- По умолчанию записи лежат в `data/local/memory.json`; папка игнорируется git.
- Для тестов или специальных рантаймов `MemoryModule` принимает свой `storePath`.
- Для процесса можно задать `MONARCH_MEMORY_STORE_PATH` / `MONARCH_MEMORY_PATH`; значения `off`, `none` или `memory` отключают file-backed режим.
- `memory.remember` сохраняет атомарно через временный файл и rename.

## Current Limits

- Нет encryption.
- Нет semantic retrieval.
- Нет профилей.
- Нет retention policy.

Эти вещи должны появляться отдельными слоями, не ломая capability contract.

## Memory v2

The store now persists `version: 2` records. Old `version: 1` snapshots are read and migrated automatically.

Each record keeps the original contract fields plus:

- `category`: `fact`, `preference`, `project`, `correction`, or `note`
- `tier`: `working`, `long`, or `permanent`
- `importance`
- `pinned`
- `decayRate`
- `accessCount`
- `updatedAt`
- `lastAccessedAt`

Search uses text matches plus importance, tier, pinned state, and access count. Matching records are touched and persisted with incremented `accessCount`.
