# Правила Роста

Эти правила нужны, чтобы Monarch не развалился, когда проект станет большим.

## 1. Доменная Логика Живет В Модулях

Логика файлов принадлежит workspace-модулю. Логика security scans - security-модулю. Логика памяти - memory service.

## 2. Core Остается Скучным

Kernel должен быть стабильным, скучным и маленьким. Интересное поведение должно появляться в modules, routers, adapters и policies.

## 3. Все Рискованное Типизировано И Permissioned

Сырые execution paths не должны становиться default-путем. Device control, file writes, deletion, shell commands, network calls и secrets требуют typed capabilities и permission checks.

## 4. Local Data Не Является Source Code

Runtime data, logs, generated artifacts, prompt traces, models и secrets остаются вне git.

## 5. Routers Заменяемы

Intent routing, model routing и safety routing должны быть заменяемыми сервисами. Так Monarch сможет развиваться без переписывания каждого модуля.

## 6. Модули Тестируются Независимо

Каждый модуль должен иметь свои tests, fixtures, mock adapters и health checks.

## 7. UI - Поверхность, Не Архитектура

Desktop app - один интерфейс к Monarch. Voice и local API должны иметь возможность использовать то же ядро.

## 8. Агент Командует, Модули Выполняют

Агент рассуждает и планирует. Модули валидируют и исполняют.
