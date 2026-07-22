import type {
  MonarchFileIntentMode,
  MonarchFileOperation,
  MonarchIntent,
  MonarchIntentClassification,
  MonarchIntentKind,
  MonarchModelRouteRole,
  MonarchParentRouteAction,
  MonarchParentRouteDecision,
  MonarchParentRouteDelegate,
  MonarchResponseFormatHint,
  MonarchRisk,
  MonarchRoutingPreference,
  MonarchSearchScope,
} from './contracts';
import { matchesTierKeyword, readTierScoringConfig } from './tier-config';
import { clampConfidence, normalizeText } from './utils';
import { hasCompleteWorkspaceFileArguments } from './argument-builder';

type ScoreMap = Record<MonarchIntentKind, number>;

const INTENT_KINDS: MonarchIntentKind[] = [
  'assistant_identity',
  'project_identity',
  'capabilities_question',
  'model_status_question',
  'text_generation',
  'explanation',
  'chat',
  'code',
  'file_generation',
  'file_operation',
  'system_action',
  'tool_use',
  'search',
  'multimodal',
  'unknown',
];

const META_INTENT_KINDS = new Set<MonarchIntentKind>([
  'assistant_identity',
  'project_identity',
  'capabilities_question',
  'model_status_question',
]);

export function classifyIntent(intent: MonarchIntent): MonarchIntentClassification {
  return classifyIntentText(intent.text);
}

export function classifyIntentText(text: string): MonarchIntentClassification {
  const normalized = normalizeText(text).toLowerCase();
  const responseFormat = detectResponseFormat(normalized);
  const ordered = classifyOrderedIntent(normalized, responseFormat);
  if (ordered) {
    return ordered;
  }

  const scores = createEmptyScores();
  const signals: string[] = [];

  scores.chat = normalized ? 0.22 : 0;

  addIf(scores, signals, normalized, 'multimodal', 0.86, 'multimodal input', /(image|vision|picture|photo|screenshot|screen shot|audio|voice|изображ|картин|фото|скрин|визуал|аудио|голос)/i);
  addIf(scores, signals, normalized, 'search', 0.78, 'explicit web knowledge', /(?:web|internet|online|search web|find online|интернет|в сети|найди в интернете|поищи в интернете)/i);
  addIf(scores, signals, normalized, 'file_operation', 0.74, 'file operation', /(read|open|delete|remove|rename|move|copy|list files|scan files|find file|find in project|search project|search code|прочитай|прочитать|открой|открыть|удали|переименуй|перемести|скопируй|список файлов|найди файл|найди.+(?:в проекте|по проекту|в коде|в репозитории)|поиск.+(?:в проекте|по проекту|в коде|в репозитории))/i);
  addIf(scores, signals, normalized, 'file_generation', 0.76, 'file authoring', /(create|write|generate|draft|compose).{0,32}(file|doc|document|report|html|json|markdown|md)|(?:создай|сгенерируй|составь|напиши).{0,32}(файл|документ|отчет|html|json|md)/i);
  addIf(scores, signals, normalized, 'system_action', 0.78, 'system action', /(?:\b(?:run|execute|start|stop|restart|install|launch)\b.{0,32}\b(?:command|script|process|service|terminal|shell|runtime|backend)\b|(?:запусти|выполни|останови|перезапусти|установи).{0,32}(?:команду|скрипт|процесс|сервис|терминал|рантайм|бэкенд))/i);
  addIf(scores, signals, normalized, 'tool_use', 0.66, 'tool request', /(tool|tools|grep|rg|script|automation|use tool|run script|what can you do|available actions|инструмент|инструменты|тул|скрипт|автоматизац|что ты умеешь|что можешь|какими инструментами|доступные действия)/i);
  addIf(scores, signals, normalized, 'code', 0.74, 'code work', /(code|debug|fix|refactor|implement|test|typescript|javascript|python|api|router|planner|executor|код|исправь|рефактор|реализуй|отлад|тест|роутер|маршрутизатор)/i);
  if (hasFreshnessSignal(normalized)) {
    scores.search += 0.78;
    signals.push('time-sensitive external fact');
  }

  if (responseFormat === 'json' || responseFormat === 'code') {
    scores.code += 0.12;
    signals.push(`${responseFormat} response`);
  }

  if (normalized.length > 260) {
    scores.code += 0.1;
    signals.push('long request');
  }

  const rankedKinds = INTENT_KINDS
    .map((kind) => ({ kind, score: clampConfidence(scores[kind]) }))
    .sort((left, right) => right.score - left.score);
  const top = rankedKinds[0] || { kind: 'unknown' as const, score: 0 };
  const kind = top.score >= 0.25 ? top.kind : 'unknown';
  const confidence = signals.length > 0
    ? clampConfidence(Math.max(0.5, Math.min(0.96, top.score)))
    : normalized
      ? 0.42
      : 0;
  const fileOperation = detectFileOperation(normalized, kind);
  const fileIntentMode = detectFileIntentMode(kind);
  const searchScope = detectSearchScope(normalized, kind);
  const routingPreference = detectRoutingPreference(kind);
  const riskHint = detectRiskHint(kind, fileOperation, searchScope);
  const modelRolePreference = detectModelRolePreference(kind, normalized, responseFormat);

  return {
    kind,
    confidence,
    reason: describeClassification(kind, signals),
    routingPreference,
    searchScope,
    responseFormat,
    fileIntentMode,
    fileOperation,
    toolRoutingAllowed: routingPreference === 'tools',
    riskHint,
    modelRolePreference,
    modelTierBoost: modelTierBoostFor(kind, responseFormat, normalized),
    signals: uniqueSignals(signals),
    rankedKinds,
  };
}

function classifyOrderedIntent(
  text: string,
  responseFormat: MonarchResponseFormatHint
): MonarchIntentClassification | null {
  if (!text) {
    return null;
  }

  const metaKind = detectMetaIntentKind(text);
  if (metaKind && !isClearlyImperativeActionWithTarget(text)) {
    return buildDeterministicClassification(metaKind, text, responseFormat, 0.94, 'meta question');
  }

  if (isExplicitFileMutationAction(text)) {
    return buildDeterministicClassification('file_operation', text, responseFormat, 0.9, 'explicit file action');
  }

  if (isExplicitSystemAction(text)) {
    return buildDeterministicClassification('system_action', text, responseFormat, 0.9, 'explicit system action');
  }

  if (isExternalComparativeResearch(text)) {
    return buildDeterministicClassification('search', text, responseFormat, 0.9, 'external comparative research');
  }

  if (isExplicitWebSearch(text)) {
    return buildDeterministicClassification('search', text, responseFormat, 0.88, 'explicit web search');
  }

  if (isOpenEndedBuildRequest(text)) {
    return buildDeterministicClassification('code', text, responseFormat, 0.84, 'open-ended app build');
  }

  if (isConcreteFileSearch(text)) {
    return buildDeterministicClassification('file_operation', text, responseFormat, 0.86, 'workspace file search');
  }

  if (isConcreteFileWrite(text)) {
    return buildDeterministicClassification(
      hasCompleteWorkspaceFileArguments(text) ? 'file_operation' : 'file_generation',
      text,
      responseFormat,
      0.88,
      'concrete file authoring',
    );
  }

  if (isBriefSocialExchange(text)) {
    return buildDeterministicClassification('chat', text, responseFormat, 0.74, 'lightweight chat');
  }

  if (isExplanationQuestion(text)) {
    return buildDeterministicClassification('explanation', text, responseFormat, 0.78, 'explanation question');
  }

  if (isGeneralTextGeneration(text)) {
    return buildDeterministicClassification('text_generation', text, responseFormat, 0.78, 'text generation');
  }

  if (metaKind) {
    return buildDeterministicClassification(metaKind, text, responseFormat, 0.72, 'ambiguous meta question');
  }

  return null;
}

function buildDeterministicClassification(
  kind: MonarchIntentKind,
  text: string,
  responseFormat: MonarchResponseFormatHint,
  confidence: number,
  signal: string
): MonarchIntentClassification {
  const fileOperation = detectFileOperation(text, kind);
  const fileIntentMode = detectFileIntentMode(kind);
  const searchScope = detectSearchScope(text, kind);
  const routingPreference = detectRoutingPreference(kind);
  const riskHint = detectRiskHint(kind, fileOperation, searchScope);
  const modelRolePreference = detectModelRolePreference(kind, text, responseFormat);

  return {
    kind,
    confidence: clampConfidence(confidence),
    reason: describeClassification(kind, [signal]),
    routingPreference,
    searchScope,
    responseFormat,
    fileIntentMode,
    fileOperation,
    toolRoutingAllowed: routingPreference === 'tools',
    riskHint,
    modelRolePreference,
    modelTierBoost: modelTierBoostFor(kind, responseFormat, text),
    signals: [signal],
    rankedKinds: INTENT_KINDS.map((entry) => ({
      kind: entry,
      score: entry === kind ? clampConfidence(confidence) : 0,
    })),
  };
}

function detectMetaIntentKind(text: string): MonarchIntentKind | null {
  if (/(кто ты|кто такой\s+(?:oscar|оскар)|расскажи о себе|представься|who are you|what are you)/i.test(text)) {
    return 'assistant_identity';
  }
  if (/(что такое\s+monarch|расскажи (?:про|о)\s+monarch|что за проект\s+monarch|what is monarch)/i.test(text)) {
    return 'project_identity';
  }
  if (
    /(что ты умеешь|какие у тебя возможност|какие capabilities доступны|какие инструменты доступны|какими инструментами.+можешь|what can you do|available capabilities|available actions)/i.test(text)
    || isCapabilityQuestion(text)
  ) {
    return 'capabilities_question';
  }
  if (/(какие модели доступны|какие модели используешь|какой runtime активен|покажи статус моделей|model status|available models|which models)/i.test(text)) {
    return 'model_status_question';
  }
  return null;
}

function isCapabilityQuestion(text: string): boolean {
  return /(?:ты\s+)?(?:можешь|умеешь)\s+.*(?:удал|запуск|команд|файл|инструмент|модел|диагност|delete|run|execute|command|file|tool|model)/i.test(text)
    || /(?:можешь|умеешь)\?/i.test(text);
}

function isClearlyImperativeActionWithTarget(text: string): boolean {
  return /^(удали|сотри|стереть|delete|remove)\s+\S+/i.test(text)
    || /^(запусти|выполни|установи|run|execute|install)\s+\S+/i.test(text);
}

function isExplicitFileMutationAction(text: string): boolean {
  return /^(удали|сотри|стереть|delete|remove|переименуй|перемести|rename|move)\s+\S+/i.test(text);
}

function isExplicitSystemAction(text: string): boolean {
  return /^(запусти|выполни|установи|перезапусти|останови|run|execute|install|restart|stop)\s+\S+/i.test(text);
}

function isExplicitWebSearch(text: string): boolean {
  return /(найди|поищи|search|find).{0,32}(?:в интернете|в сети|online|web|internet)/i.test(text)
    || isBareExternalLookup(text)
    || hasFreshnessSignal(text);
}

function isBareExternalLookup(text: string): boolean {
  if (!/^\s*(?:найди|поищи)(?:\s|$)/i.test(text)) return false;
  const webLocation = /(?:\b(?:web|online|internet|website|site)\b|в\s+сети|в\s+интернете|на\s+сайте|веб[- ]?поиск|онлайн)/i;
  const localTarget = /\b(?:file|folder|project|repo(?:sitory)?|code|workspace|memory|conversation|chat\s+history|branch|process|installed)\b|файл|папк|проект|репозитор|код|workspace|памят|переписк|истори\w*\s+чат|ветк\w*\s+git|процесс|установлен|баг|ошибк|тест/i;
  return webLocation.test(text) || !localTarget.test(text);
}

function isExternalComparativeResearch(text: string): boolean {
  const ranking = /\b(?:top\s*[- ]?\d+|best|smartest|fastest|most\s+(?:accurate|capable|efficient)|ranking|leaderboard|benchmark|compare)\b|топ\s*[- ]?\d+|лучш\w*|сам\w*\s+(?:умн|быстр|точн|мощн|эффективн)\w*|рейтинг|лидерборд|бенчмарк|сравни\w*/i;
  const externalSubject = /\b(?:llm|slm|language\s+models?|ai\s+models?|models?|software|libraries?|frameworks?|products?|services?|devices?|laptops?|phones?|gpus?|cpus?)\b|(?:llm|slm|ai|ии|языков\w*)\s+модел|модел\w*\s+(?:llm|slm)|программ|библиотек|фреймворк|продукт|сервис|устройств|ноутбук|смартфон|видеокарт|процессор/i;
  return ranking.test(text) && externalSubject.test(text);
}

function hasFreshnessSignal(text: string): boolean {
  const temporal = /\b(?:latest|current|today|recent|newest|now|this\s+(?:week|month|year))\b|актуальн|свеж|последн|сегодня|сейчас|на\s+данный\s+момент|в\s+этом\s+(?:году|месяце|неделе)/i;
  const definitional = /^\s*(?:что\s+такое|что\s+означает|что\s+значит|объясни|поясни|what\s+is|what\s+does|explain)\b/i;
  if (definitional.test(text) && !temporal.test(text)) return false;
  const directSubject = /\b(?:news|weather|forecast|exchange rate|standings|sports?\s+score)\b|новост|погод|прогноз\s+погод|курс\s+(?:валют|доллар|евро|гривн|рубл)|турнирн\w*\s+таблиц|сч[её]т\s+матч|результат\w*\s+матч/i;
  const liveValue = /\b(?:price|quote)\b.{0,32}\b(?:btc|bitcoin|eth|ethereum|stock|share|product|gas|oil|gold)\b|\b(?:btc|bitcoin|eth|ethereum|stock|share|product|gas|oil|gold)\b.{0,32}\b(?:price|quote)\b|цен[аы].{0,32}(?:btc|bitcoin|биткоин|ethereum|эфир|акци|товар|бензин|нефт|золот)|(?:btc|bitcoin|биткоин|ethereum|эфир|акци|товар|бензин|нефт|золот).{0,32}цен[аы]/i;
  const liveSchedule = /\b(?:schedule|timetable)\b.{0,40}\b(?:flight|train|bus|match|game|event|concert|cinema)\b|\b(?:flight|train|bus|match|game|event|concert|cinema)\b.{0,40}\b(?:schedule|timetable)\b|расписан.{0,40}(?:рейс|поезд|автобус|матч|игр|турнир|концерт|кино)|(?:рейс|поезд|автобус|матч|игр|турнир|концерт|кино).{0,40}расписан/i;
  const officeholder = /\b(?:who|current|name)\b.{0,32}\b(?:president|prime\s+minister|ceo)\b|\b(?:president|prime\s+minister|ceo)\b.{0,32}\b(?:who|current|name)\b|(?:кто|как\s+зовут|сейчас|нынешн|текущ).{0,32}(?:президент|премьер[- ]?министр|генеральн\w*\s+директор)|(?:президент|премьер[- ]?министр|генеральн\w*\s+директор).{0,32}(?:кто|как\s+зовут|сейчас|нынешн|текущ)/i;
  if (directSubject.test(text) || liveValue.test(text) || liveSchedule.test(text) || officeholder.test(text)) return true;
  const changingSubject = /\b(?:company|corporation|government|market|stock|product|software|library|framework|release|version|update|election|regulation|standard|api|openai|anthropic|google|microsoft|apple|nvidia|windows|android|ios|macos|python|node(?:\.js)?|react)\b|компан|корпорац|правительств|рынок|акци[ия]|продукт|программ|библиотек|фреймворк|релиз|верси|обновлен|выбор|регулирован|регламент|стандарт|openai|anthropic|google|microsoft|apple|nvidia|windows|android|ios|macos|python|react|(?:ai|llm|языков\w*)\s+модел/i;
  return temporal.test(text) && changingSubject.test(text);
}

function isConcreteFileSearch(text: string): boolean {
  return /(?:найди|поиск|ищи|find|search).{0,32}(?:файл|в проекте|по проекту|в коде|files?|project|repo)/i.test(text);
}

function isConcreteFileWrite(text: string): boolean {
  return /(?:создай|запиши|сохрани|перезапиши|create|write|save|напиши).{0,48}(?:файл|file|[\\/][\w.-]+|\.\w{1,12})/i.test(text);
}

function isOpenEndedBuildRequest(text: string): boolean {
  const asksToBuild = /(?:создай|создать|сделай|сделать|собери|собрать|реализуй|реализовать|напиши|build|create|make|implement|generate)/i.test(text);
  if (!asksToBuild) return false;
  const buildSubject = /(?:калькулятор|calculator|приложен\w*|app\b|application|сайт|website|страниц\w*|game|игр\w*|dashboard|дашборд|интерфейс|ui\b)/i.test(text);
  const buildQualifier = /(?:рабоч\w*|работающ\w*|графическ\w*|визуальн\w*|интерактивн\w*|functional|working|graphical|interactive|with\s+ui|gui\b)/i.test(text);
  return buildSubject && buildQualifier && !isExplicitWorkspaceBatch(text);
}

function isExplicitWorkspaceBatch(text: string): boolean {
  return /(?:с\s+текстом|с\s+содержимым|with\s+(?:text|content)|content\s*:)/i.test(text)
    || /(?:структур\w*|дерево|скелет|structure|scaffold).{0,80}(?:[\\/]|├|└|\.\w{1,12})/i.test(text)
    || /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+[^:\n]+\.\w{1,12}\s*:/i.test(text);
}

function isExplanationQuestion(text: string): boolean {
  return /^(?:объясни|поясни|расскажи как|как\s+|почему\s+|что такое\s+|что означает\s+|что значит\s+|explain|how\s+|why\s+|what is\s+|what does\s+.+\s+mean)/i.test(text);
}

function isGeneralTextGeneration(text: string): boolean {
  return /^(?:напиши|составь|сгенерируй|придумай|write|draft|compose|generate)\s+/i.test(text)
    && !isConcreteFileWrite(text);
}

function isBriefSocialExchange(text: string): boolean {
  const compact = text.trim().toLowerCase();
  if (!compact || compact.length > 80) {
    return false;
  }
  return /^(?:ping|pong|hi|hello|hey|yo|привет|здравствуй|здравствуйте|как дела|как ты|how are you|how's it going)\??$/i.test(compact);
}

export function createParentRouteDecision(
  classification: MonarchIntentClassification
): MonarchParentRouteDecision {
  const action = actionForKind(classification.kind);
  const delegate = delegateForKind(classification.kind, classification.fileIntentMode);

  return {
    action,
    delegate,
    route: classification.routingPreference,
    risk: classification.riskHint,
    confidence: classification.confidence,
    preferredModelRole: classification.modelRolePreference,
    responseFormat: classification.responseFormat,
    toolRoutingAllowed: classification.toolRoutingAllowed,
    needsApproval: requiresApproval(classification.riskHint),
    needsInternet: classification.searchScope === 'web_required',
    needsFiles: classification.fileIntentMode !== 'none',
    reason: classification.reason,
  };
}

function createEmptyScores(): ScoreMap {
  return Object.fromEntries(INTENT_KINDS.map((kind) => [kind, 0])) as ScoreMap;
}

function addIf(
  scores: ScoreMap,
  signals: string[],
  text: string,
  kind: MonarchIntentKind,
  weight: number,
  signal: string,
  pattern: RegExp
): void {
  if (!text || !pattern.test(text)) {
    return;
  }

  scores[kind] += weight;
  signals.push(signal);
}

function detectResponseFormat(text: string): MonarchResponseFormatHint {
  if (/(json|schema|structured|strict object|структур|схем|джсон)/i.test(text)) {
    return 'json';
  }
  if (/(code block|snippet|typescript|javascript|python|код|сниппет)/i.test(text)) {
    return 'code';
  }
  if (/(html|markdown|md file|artifact|document|report|документ|отчет|артефакт)/i.test(text)) {
    return 'artifact';
  }
  return 'plain';
}

function detectFileOperation(
  text: string,
  kind: MonarchIntentKind
): MonarchFileOperation {
  if (kind === 'file_generation') {
    return /(edit|update|rewrite|patch|измени|обнови|перепиши)/i.test(text) ? 'edit' : 'write';
  }
  if (kind !== 'file_operation') {
    return 'none';
  }
  if (/(delete|remove|удали)/i.test(text)) {
    return 'delete';
  }
  if (/(rename|переименуй)/i.test(text)) {
    return 'rename';
  }
  if (/(move|перемести)/i.test(text)) {
    return 'move';
  }
  if (/(list|scan|список|просканируй)/i.test(text)) {
    return 'list';
  }
  if (/(edit|update|patch|измени|обнови)/i.test(text)) {
    return 'edit';
  }
  return 'read';
}

function detectFileIntentMode(kind: MonarchIntentKind): MonarchFileIntentMode {
  if (kind === 'file_generation') {
    return 'authoring';
  }
  if (kind === 'file_operation') {
    return 'operation';
  }
  return 'none';
}

function detectSearchScope(
  text: string,
  kind: MonarchIntentKind
): MonarchSearchScope {
  if (kind !== 'search') {
    return 'none';
  }
  if (/(latest|current|today|news|актуаль|свеж|новост|сегодня)/i.test(text)) {
    return 'web_required';
  }
  if (isExternalComparativeResearch(text)) {
    return 'web_required';
  }
  if (isBareExternalLookup(text)) {
    return 'web_required';
  }
  if (/(web|internet|online|интернет|в сети)/i.test(text)) {
    return 'web_optional';
  }
  return 'local';
}

function detectRoutingPreference(kind: MonarchIntentKind): MonarchRoutingPreference {
  switch (kind) {
  case 'file_operation':
  case 'system_action':
  case 'tool_use':
    return 'tools';
  case 'search':
    return 'search';
  case 'multimodal':
    return 'multimodal';
  case 'code':
  case 'file_generation':
    return 'model';
  case 'chat':
  case 'unknown':
  default:
    return 'chat';
  }
}

function detectRiskHint(
  kind: MonarchIntentKind,
  fileOperation: MonarchFileOperation,
  searchScope: MonarchSearchScope
): MonarchRisk {
  if (kind === 'system_action') {
    return 'execute';
  }
  if (kind === 'search' && searchScope.startsWith('web')) {
    return 'network';
  }
  if (fileOperation === 'delete') {
    return 'delete';
  }
  if (['write', 'edit', 'move', 'rename', 'create'].includes(fileOperation)) {
    return 'write';
  }
  if (kind === 'file_operation' || kind === 'tool_use' || kind === 'search') {
    return 'read';
  }
  return 'none';
}

function detectModelRolePreference(
  kind: MonarchIntentKind,
  text: string,
  responseFormat: MonarchResponseFormatHint
): MonarchModelRouteRole {
  if (kind === 'multimodal') {
    return 'vision';
  }
  if (matchesTierKeyword(text, 'reasoning')) {
    return 'powerful';
  }
  const adaptiveScore = scoreAdaptiveModelRoute(kind, text, responseFormat);
  const { thresholds } = readTierScoringConfig();
  if (adaptiveScore >= thresholds.powerful) {
    return 'powerful';
  }
  if (adaptiveScore >= thresholds.medium) {
    return 'medium';
  }
  return 'weak';
}

function scoreAdaptiveModelRoute(
  kind: MonarchIntentKind,
  text: string,
  responseFormat: MonarchResponseFormatHint
): number {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return 0;
  }
  const isMeta = META_INTENT_KINDS.has(kind);
  const hasDepth = hasDepthSignal(normalized);
  const hasAction = hasActionSignal(normalized);
  const hasDomain = hasDomainSignal(normalized) || matchesTierKeyword(normalized, 'powerful');
  const hasKnowledge = hasMediumKnowledgeSignal(normalized) || matchesTierKeyword(normalized, 'medium');
  const hasFreshness = hasFreshnessSignal(normalized);
  const hasContext = /\b(this|that|previous|continue)\b|(?:это|этот|как выше|продолжи|сделай так|исправь это)/i.test(normalized);
  const multipart = (normalized.match(/[?;\n]|\bи\b|\band\b/g) || []).length >= 2;
  const structuredOutput = responseFormat !== 'plain' || /(json|schema|структур|таблиц|markdown|html|код|code block)/i.test(normalized);
  const { weights } = readTierScoringConfig();
  const highImpact = /(?:архитектур|безопасност|security|threat model|модель угроз)/i.test(normalized);
  let score = Math.min(normalized.length / weights.lengthDivisor, weights.lengthCap)
    + intentComplexityBonus(kind)
    + (multipart ? weights.multipart : 0)
    + (hasContext ? weights.context : 0)
    + (hasFreshness ? weights.freshness : 0)
    + (structuredOutput ? weights.structuredOutput : 0);

  if (isMeta) {
    score += weights.metaBase
      + (hasDepth ? weights.metaDepth : 0)
      + (hasAction && hasDepth ? weights.metaActionDepth : 0)
      + (hasDomain && hasDepth ? weights.metaDomainDepth : 0)
      + (hasKnowledge && hasDepth ? weights.metaKnowledgeDepth : 0);
  } else {
    score += (hasAction ? weights.action : 0)
      + (hasDomain ? weights.domain : 0)
      + (hasKnowledge ? weights.knowledge : 0)
      + (hasDepth ? weights.depth : 0)
      + (highImpact && (hasAction || hasDepth) ? weights.highImpact : 0);
  }

  if (isBriefSocialExchange(normalized)) {
    score += weights.socialDamping;
  }
  return Math.max(0, Math.min(score, 1));
}

function hasDepthSignal(text: string): boolean {
  return /(подроб|деталь|пошаг|глубок|проанализ|сравни|аудит|исслед|докажи|обоснуй|план|стратег|trade-?off|thorough|deep|detailed|analy[sz]e|compare|audit|prove|strategy)/i.test(text);
}

function intentComplexityBonus(kind: MonarchIntentKind): number {
  switch (kind) {
  case 'code':
  case 'file_generation':
  case 'system_action':
    return 0.16;
  case 'search':
    return 0.08;
  default:
    return 0;
  }
}

function hasActionSignal(text: string): boolean {
  return /\b(write|draft|compose|generate|fix|review|analyze|find|search|implement|refactor|debug|design|build)\b|(?:напиши|составь|исправь|проверь|проанализируй|найди|поищи|реализуй|отрефактор|отлад|спроектируй|собери)/i.test(text);
}

function hasDomainSignal(text: string): boolean {
  return /(typescript|javascript|python|api|json schema|router|runtime|security|architecture|workspace|repository|repo|llm|model|архитектур|безопасност|роутер|маршрутизатор|рантайм|код|отлад|рефактор|модель|проект|репозитор)/i.test(text);
}

function hasMediumKnowledgeSignal(text: string): boolean {
  return /\b(what is|why|explain|how|tell me)\b|(?:объясни|почему|как|расскажи|опиши|что такое|поясни)/i.test(text);
}

function modelTierBoostFor(
  kind: MonarchIntentKind,
  responseFormat: MonarchResponseFormatHint,
  text: string
): number {
  let boost = 0;
  if (kind === 'code' || kind === 'file_generation') {
    boost += 1;
  }
  if (kind === 'system_action' || responseFormat === 'json') {
    boost += 1;
  }
  if (text.length > 260) {
    boost += 1;
  }
  return boost;
}

function actionForKind(kind: MonarchIntentKind): MonarchParentRouteAction {
  switch (kind) {
  case 'assistant_identity':
  case 'project_identity':
  case 'capabilities_question':
  case 'model_status_question':
  case 'text_generation':
  case 'explanation':
  case 'chat':
    return 'direct_reply';
  case 'code':
  case 'file_generation':
    return 'model_generation';
  case 'file_operation':
  case 'tool_use':
    return 'tool_plan';
  case 'system_action':
    return 'action_plan';
  case 'search':
    return 'web_search';
  case 'multimodal':
    return 'multimodal';
  case 'unknown':
  default:
    return 'unknown';
  }
}

function delegateForKind(
  kind: MonarchIntentKind,
  fileIntentMode: MonarchFileIntentMode
): MonarchParentRouteDelegate {
  if (fileIntentMode === 'authoring') {
    return 'file_author';
  }
  if (fileIntentMode === 'operation') {
    return 'file_operator';
  }
  switch (kind) {
  case 'assistant_identity':
  case 'project_identity':
  case 'capabilities_question':
  case 'model_status_question':
  case 'text_generation':
  case 'explanation':
  case 'chat':
    return 'chat';
  case 'code':
    return 'coder';
  case 'system_action':
    return 'system_operator';
  case 'tool_use':
    return 'tool_operator';
  case 'search':
    return 'research';
  case 'multimodal':
    return 'multimodal_analyst';
  case 'unknown':
  default:
    return 'unknown';
  }
}

function requiresApproval(risk: MonarchRisk): boolean {
  return risk !== 'none' && risk !== 'read';
}

function describeClassification(kind: MonarchIntentKind, signals: string[]): string {
  if (kind === 'unknown') {
    return 'No strong deterministic intent signal was detected.';
  }
  if (signals.length === 0) {
    return 'Default conversational intent.';
  }
  return `Deterministic classifier matched ${uniqueSignals(signals).join(', ')}.`;
}

function uniqueSignals(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
