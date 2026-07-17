# Astra: подсистема навыков для Monarch

Astra - локальная подсистема Monarch, которая отвечает за подключение, описание, маршрутизацию и безопасное применение навыков для AI-агента Oscar.

Если сказать коротко: Monarch - это локальная операционная среда, Oscar - агент, а Astra - слой, который превращает плагины и модули в понятные, проверяемые и вызываемые способности агента.

## Главная идея

Astra нужна не как "папка с плагинами", а как единый механизм, который позволяет Oscar:

- понимать, какие навыки доступны;
- выбирать нужный навык по намерению пользователя;
- получать только нужное описание способности, без загрузки всего архива в контекст;
- вызывать навык через типизированный контракт;
- работать локально, без обязательной зависимости от облака;
- не обходить permissions, safety rules и audit log Monarch.

Главная ценность Astra - управляемая адаптация. Агент не должен сам угадывать, как работает каждый плагин. Плагин обязан описать себя так, чтобы Astra могла безопасно включить его в систему.

## Роли систем

`Oscar` - пользовательский AI-агент. Он общается с пользователем, понимает запрос, ведет состояние диалога и просит Monarch выполнить действия.

`Monarch` - локальная экосистема и системное ядро. Оно хранит модули, capabilities, permissions, события, память, логи и execution pipeline.

`Astra` - подсистема навыков внутри Monarch. Она индексирует плагины, готовит agent-facing описания навыков, выбирает подходящий слот выполнения и помогает роутеру найти правильную capability.

## Базовые принципы

1. Все по умолчанию локально.
2. Плагин не является произвольным куском магии. Он обязан иметь manifest, capabilities, permissions и версию.
3. Oscar не вызывает сырые скрипты напрямую. Он обращается к capability через Monarch.
4. Router сначала использует детерминированные признаки: ID, aliases, keywords, intentKinds, schemas, ownership.
5. Маленькая локальная LLM может быть дополнительным ранжировщиком, но не единственным источником истины.
6. Каждый вызов проходит через permission gate и audit log.
7. В контекст агента попадает не весь плагин, а компактная карточка способности.

## Термины

`Plugin` - устанавливаемый пакет. Он может содержать один или несколько модулей, документацию, локальные assets и adapters.

`Module` - активная часть системы, которая владеет конкретной доменной логикой: память, workspace, security, браузер, модели, автоматизации.

`Capability` - атомарное типизированное действие модуля. Например: `memory.search`, `workspace.files.read`, `security.scan.system`.

`Skill ID` - стабильный идентификатор навыка или capability, который использует ядро.

`Agent Card` - краткое описание навыка для Oscar: что умеет, какие входные данные нужны, какой риск, какие ограничения, когда применять.

`Slot` - runtime-контекст выбранного навыка. В слот попадает не весь архив плагина, а конкретная capability с нужным manifest, schema, permission profile и минимальной инструкцией для агента.

## Как должен работать поток

```text
User
  -> Oscar
  -> Monarch Router Mesh
  -> Astra Capability Index
  -> selected Capability
  -> Slot activation
  -> Permission Gate
  -> Module execution
  -> Result
  -> Oscar response
```

1. Пользователь дает задачу Oscar.
2. Oscar формирует intent.
3. Router Mesh получает intent и просит Astra найти кандидатов.
4. Astra ищет совпадения по manifest, capability metadata, aliases, keywords, examples, intentKinds и истории успешных маршрутов.
5. Если кандидатов несколько, детерминированный scorer ранжирует их. Маленькая локальная LLM может быть включена только как reranker или clarification helper.
6. Выбранная capability активируется в slot.
7. Permission Gate решает: allow, confirm или deny.
8. Execution Engine вызывает модуль через typed capability.
9. События, ошибки и результат пишутся в audit/event log.
10. Oscar получает чистый результат и объясняет его пользователю.

## ID-модель

Не стоит делать "другую форму ID" размытой. Лучше разделить внутренние и агентские представления:

```text
pluginId:      astra.plugin.security
moduleId:      security
capabilityId:  security.scan.system
slotId:        slot.security.scan.system.active
agentCardId:   astra.card.security.scan-system.v1
```

Внутренние ID нужны ядру для стабильности и версионирования. Agent Card ID нужен Oscar, чтобы быстро понять, какую способность он получил и как ее применять в текущей задаче.

## Manifest плагина

Минимально каждый plugin/module должен объявлять:

```ts
{
  id: 'security',
  name: 'Monarch Security',
  version: '0.1.0',
  kind: 'runtime',
  description: 'Local security scans, integrity checks and audit previews through typed capabilities.',
  owns: ['security', 'audit', 'integrity'],
  permissions: ['read', 'write', 'security-sensitive'],
  dependencies: [],
  capabilities: [
    {
      id: 'security.scan.system',
      title: 'Scan system security posture',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          summaryOnly: { type: 'boolean' },
          includeFiles: { type: 'boolean' },
          noLlm: { type: 'boolean' }
        },
        additionalProperties: false
      },
      routing: {
        aliases: ['security scan', 'проверь безопасность'],
        keywords: ['security', 'audit', 'integrity', 'безопасность', 'аудит'],
        intentKinds: ['security.scan']
      }
    }
  ]
}
```

## Что нужно усилить в текущей идее

Сейчас концепция сильная по направлению, но базовая по формализации. Главные места, которые нужно довести:

- определить Astra как отдельный слой, а не смешивать ее с Monarch целиком;
- заменить абстрактный "архив плагинов" на registry + package loader + capability index;
- четко описать slot как runtime-контекст capability;
- разделить Plugin ID, Module ID, Capability ID, Slot ID и Agent Card ID;
- зафиксировать, что LLM-router не должен быть единственным механизмом маршрутизации;
- добавить permissions, audit, health checks и версионирование;
- ввести минимальный MVP, чтобы проект не расползся.

## MVP Astra v0.1

Первая рабочая версия должна быть узкой:

1. Plugin registry читает локальные manifests.
2. Capability index строит карту всех доступных capabilities.
3. Router выбирает capability по deterministic scoring.
4. Slot manager создает runtime-контекст выбранной capability.
5. Agent Card generator отдает Oscar краткое описание выбранного навыка.
6. Permission Gate блокирует рискованные действия без подтверждения.
7. Audit Log пишет route, selected capability, permission result и execution result.

Для демонстрации достаточно трех модулей:

- `memory` - read/write локальной памяти;
- `plugins` - read-only карта доступных навыков;
- `security` - локальные scans, audit tail и baseline actions.

## Что не нужно делать в v0.1

- marketplace плагинов;
- автоматическую установку чужого кода;
- сложный sandbox;
- fine-tune роутера;
- большой автономный planner;
- облачные провайдеры по умолчанию;
- загрузку всей документации плагина в контекст агента.

## Риски

`Слишком умный router` - если все завязать на LLM, система начнет быть непредсказуемой. Решение: deterministic routing first, LLM only as optional reranker.

`Сырые плагины` - если разрешить любому плагину выполнять что угодно, local-first превратится в local-risk. Решение: manifest, permissions, schemas, audit.

`Размытый slot` - если slot не определить строго, он станет просто новым словом для "вызова плагина". Решение: slot = выбранная capability + schema + permission profile + execution context + agent card.

`Перегруз контекста Oscar` - если отдавать агенту всю документацию, система станет тяжелой. Решение: компактные Agent Cards и lazy explainCapability.

## Критерии успеха

Astra v0.1 можно считать успешной, если Oscar может:

- спросить Monarch, какие навыки доступны;
- получить компактную карту capabilities;
- выбрать нужный навык по пользовательскому intent;
- увидеть, почему выбран именно этот навык;
- выполнить capability через Monarch;
- получить отказ или запрос подтверждения для рискованных действий;
- сохранить trace выполнения в локальном audit log.

## Чистая формулировка проекта

Astra - local-first подсистема навыков Monarch для AI-агента Oscar. Она превращает локальные плагины в безопасные, типизированные и маршрутизируемые capabilities. Astra хранит карту навыков, строит agent-facing карточки, активирует нужный slot выполнения и помогает Router Mesh выбрать правильный путь без загрузки всего плагина в контекст агента.

Главное правило: Oscar думает и командует, Monarch контролирует и исполняет, Astra делает навыки понятными и вызываемыми.

## Agent Skills 2026: локальный контракт

Monarch поддерживает совместимый файловый слой Agent Skills без зависимости от облачного Gemini API. Из Gemini CLI переняты только локальные механики, полезные для автономного агента: `SKILL.md`, progressive disclosure, явная активация, иерархия источников и инвентаризация ресурсов.

Порядок источников фиксирован и детерминирован: bundled/extension < user < workspace; внутри workspace `.agents/skills` имеет наивысший приоритет совместимости. Также поддерживаются `.monarch/skills`, `.gemini/skills`, `.claude/skills` и `.codex/skills`. Дубликаты разрешаются по приоритету, а не по порядку обхода диска.

Безопасность строится вокруг четырех инвариантов:

1. До активации в контекст попадают только краткие метаданные.
2. `SKILL.md` имеет SHA-256 fingerprint; изменение между discovery и activation блокируется.
3. Символические ссылки за пределы корня помечаются как `linked` и не активируются неявно.
4. Skill — это недоверенный operational context, а не инструкция обходить Permission Gate, Agent Guard или workspace policy.

Встроенные навыки Monarch находятся в `.monarch/skills/`: безопасная работа с файлами, создание skills, Security Guardian и Telegram Operator. Они не устанавливают код и не отправляют данные в облако.
