import type {
  MonarchCapability,
  MonarchIntent,
  MonarchMemoryEntryType,
  MonarchPlan,
  MonarchPlanStep,
  MonarchPlanningMemoryReference,
  MonarchPlanningRiskLevel,
  MonarchRouteDecision,
} from './contracts';
import { createMonarchId, nowIso } from './utils';

const COMPLEX_TASK_PATTERN = /\b(architecture|architectural|refactor|migration|pipeline|router|routing|capabilit(?:y|ies)|memory|diagnostic|diagnostics|security|filesystem|workspace|model loading|model runtime|telegram|backend|frontend|ui|integration|tests?|validation|release|audit|tools?|planner|planning)\b|(?:архитектур|рефактор|миграц|роутер|маршрутиз|памят|диагност|безопас|файлов|workspace|модел|загруз|телеграм|бэкенд|фронтенд|интерфейс|интеграц|тест|валидац|аудит|инструмент|планирован)/i;

export class MonarchPlanner {
  requiresPlanning(
    intent: MonarchIntent,
    route: MonarchRouteDecision,
    capability: MonarchCapability | undefined,
  ): boolean {
    const affectedModules = inferAffectedModules(intent.text, route, capability);
    const riskLevel = inferPlanRiskLevel(intent.text, route, capability, affectedModules);
    return shouldCreateStructuredPlanningSummary(intent, route, capability, affectedModules, riskLevel);
  }

  createPlan(
    intent: MonarchIntent,
    route: MonarchRouteDecision,
    capability: MonarchCapability | undefined,
    memoryEntries: MonarchPlanningMemoryReference[] = readPlanningMemory(intent.context)
  ): MonarchPlan {
    const steps: MonarchPlanStep[] = [];
    const affectedModules = inferAffectedModules(intent.text, route, capability);
    const requiredCapabilities = route.capabilityId ? [route.capabilityId] : [];
    const riskLevel = inferPlanRiskLevel(intent.text, route, capability, affectedModules);
    const requiresPlanning = shouldCreateStructuredPlanningSummary(intent, route, capability, affectedModules, riskLevel);

    if (route.capabilityId) {
      steps.push({
        id: createMonarchId('step'),
        moduleId: route.targetModuleId,
        capabilityId: route.capabilityId,
        input: route.input ?? {
          text: intent.text,
          context: intent.context || {},
        },
        reason: route.reason,
        expectedRisk: capability?.risk || 'security-sensitive',
      });
    }

    const taskSummary = summarizeTask(intent.text, route);
    const executionSteps = requiresPlanning
      ? inferExecutionSteps(route, capability, affectedModules)
      : [];
    const validationPlan = requiresPlanning
      ? inferValidationPlan(affectedModules, capability)
      : [];
    const possibleSideEffects = requiresPlanning
      ? inferPossibleSideEffects(affectedModules, capability)
      : [];
    const notes = requiresPlanning
      ? inferPlanningNotes(memoryEntries, riskLevel)
      : [];

    return {
      id: createMonarchId('plan'),
      intentId: intent.id,
      createdAt: nowIso(),
      status: 'planned',
      summary: steps.length > 0
        ? `Plan for ${route.targetModuleId}.${route.capabilityId || 'no-capability'}`
        : `Route to ${route.targetModuleId} has no executable capability.`,
      requiresPlanning,
      taskSummary,
      affectedModules,
      dependencies: inferDependencies(affectedModules),
      riskLevel,
      possibleSideEffects,
      requiredCapabilities,
      executionSteps,
      validationPlan,
      notes,
      relevantMemory: memoryEntries,
      steps,
    };
  }
}

function shouldCreateStructuredPlanningSummary(
  intent: MonarchIntent,
  route: MonarchRouteDecision,
  capability: MonarchCapability | undefined,
  affectedModules: string[],
  riskLevel: MonarchPlanningRiskLevel
): boolean {
  const text = intent.text.trim();
  if (!text) {
    return false;
  }
  if (intent.context?.forcePlanning === true) {
    return true;
  }
  if (riskLevel === 'high' || riskLevel === 'critical') {
    return true;
  }
  if (affectedModules.length >= 3) {
    return true;
  }
  if (COMPLEX_TASK_PATTERN.test(text)) {
    return true;
  }
  const risk = capability?.risk;
  if (risk && risk !== 'none' && risk !== 'read' && text.length > 80) {
    return true;
  }
  return route.permissionMode === 'confirm' && text.length > 120;
}

function summarizeTask(text: string, route: MonarchRouteDecision): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const summary = cleaned.length > 220 ? `${cleaned.slice(0, 217).trim()}...` : cleaned;
  return summary || `Route ${route.targetModuleId}.${route.capabilityId || 'no-capability'}`;
}

function inferAffectedModules(
  text: string,
  route: MonarchRouteDecision,
  capability: MonarchCapability | undefined
): string[] {
  const modules = new Set<string>([route.targetModuleId]);
  if (capability?.moduleId) {
    modules.add(capability.moduleId);
  }
  const checks: Array<[string, RegExp]> = [
    ['router', /\b(router|routing|route|intent|classifier)\b|(?:роутер|маршрутиз|классифик)/i],
    ['memory', /\b(memory|remember|recall)\b|(?:памят|запомн|вспомн)/i],
    ['diagnostics', /\b(diagnostic|diagnostics|audit|health|logs?)\b|(?:диагност|аудит|здоров|логи?)/i],
    ['security', /\b(security|permission|sandbox|guard|risk)\b|(?:безопас|разрешен|песоч|риск)/i],
    ['workspace', /\b(workspace|filesystem|file|folder|path)\b|(?:файл|папк|путь|рабоч|файлов)/i],
    ['models', /\b(model|runtime|gemma|llm|inference|loading)\b|(?:модел|рантайм|инференс|загруз)/i],
    ['oscar', /\b(oscar|chat|backend|fastapi)\b|(?:оскар|бэкенд|чат)/i],
    ['telegram', /\b(telegram|bot)\b|(?:телеграм|бот)/i],
    ['ui', /\b(ui|frontend|interface|react|vite)\b|(?:интерфейс|фронтенд|визуал|экран)/i],
    ['tests', /\b(test|tests|pytest|vitest|smoke|validation)\b|(?:тест|провер|валидац)/i],
  ];
  for (const [moduleId, pattern] of checks) {
    if (pattern.test(text)) {
      modules.add(moduleId);
    }
  }
  return Array.from(modules);
}

function inferPlanRiskLevel(
  text: string,
  route: MonarchRouteDecision,
  capability: MonarchCapability | undefined,
  affectedModules: string[]
): MonarchPlanningRiskLevel {
  const risk = capability?.risk;
  if (risk === 'delete' || risk === 'execute' || risk === 'device-control' || risk === 'money' || risk === 'identity') {
    return 'critical';
  }
  if (risk === 'security-sensitive') {
    return 'high';
  }
  if (risk === 'write' || risk === 'network' || route.permissionMode === 'confirm') {
    return affectedModules.length >= 3 || COMPLEX_TASK_PATTERN.test(text) ? 'high' : 'medium';
  }
  if (affectedModules.includes('security') || affectedModules.includes('models')) {
    return 'medium';
  }
  if (COMPLEX_TASK_PATTERN.test(text) || affectedModules.length >= 3) {
    return 'medium';
  }
  return 'low';
}

function inferDependencies(affectedModules: string[]): string[] {
  const dependencies = new Set<string>();
  if (affectedModules.includes('oscar')) {
    dependencies.add('Oscar backend API contract');
  }
  if (affectedModules.includes('memory')) {
    dependencies.add('local memory schema and migration compatibility');
  }
  if (affectedModules.includes('diagnostics')) {
    dependencies.add('kernel events, audit log, and module registry');
  }
  if (affectedModules.includes('workspace')) {
    dependencies.add('filesystem policy and permission gate');
  }
  if (affectedModules.includes('models')) {
    dependencies.add('model routing and runtime status semantics');
  }
  if (affectedModules.includes('ui')) {
    dependencies.add('public shell rendering contracts');
  }
  if (affectedModules.includes('tests')) {
    dependencies.add('focused regression tests');
  }
  return Array.from(dependencies);
}

function inferExecutionSteps(
  route: MonarchRouteDecision,
  capability: MonarchCapability | undefined,
  affectedModules: string[]
): string[] {
  const steps = [
    'Map the existing entrypoints and contracts before editing.',
    `Route through ${route.targetModuleId}.${route.capabilityId || 'no-capability'} using the existing module boundary.`,
  ];
  if (affectedModules.includes('memory')) {
    steps.push('Keep old memory records readable while adding classified metadata.');
  }
  if (affectedModules.includes('diagnostics')) {
    steps.push('Collect diagnostics read-only and return a structured report.');
  }
  if (capability?.risk && capability.risk !== 'none' && capability.risk !== 'read') {
    steps.push('Respect permission gating before any write, delete, execute, or security-sensitive step.');
  }
  steps.push('Run focused tests for changed contracts and document remaining risks.');
  return steps;
}

function inferValidationPlan(
  affectedModules: string[],
  capability: MonarchCapability | undefined
): string[] {
  const validation = new Set<string>(['Run focused unit tests for the touched module.']);
  if (affectedModules.includes('router') || affectedModules.includes('diagnostics')) {
    validation.add('Run router/diagnostics routing regression tests.');
  }
  if (affectedModules.includes('memory')) {
    validation.add('Run memory schema, migration, filter, and relevance tests.');
  }
  if (affectedModules.includes('oscar')) {
    validation.add('Run Oscar backend contract tests for changed endpoints.');
  }
  if (affectedModules.includes('ui')) {
    validation.add('Run UI syntax/tests and inspect the rendered plan/report surface.');
  }
  if (capability?.risk && capability.risk !== 'none' && capability.risk !== 'read') {
    validation.add('Verify confirmation-required behavior for unconfirmed risky actions.');
  }
  return Array.from(validation);
}

function inferPossibleSideEffects(
  affectedModules: string[],
  capability: MonarchCapability | undefined
): string[] {
  const effects = new Set<string>();
  if (affectedModules.includes('router')) {
    effects.add('Routing confidence may shift for nearby intents.');
  }
  if (affectedModules.includes('memory')) {
    effects.add('Memory retrieval ranking and persistence format may change.');
  }
  if (affectedModules.includes('diagnostics')) {
    effects.add('Diagnostics output can expose noisy local state if not bounded.');
  }
  if (affectedModules.includes('workspace')) {
    effects.add('Filesystem boundary handling can affect file read/write capabilities.');
  }
  if (affectedModules.includes('models')) {
    effects.add('Model tier choice or runtime status copy can change user-visible behavior.');
  }
  if (affectedModules.includes('ui')) {
    effects.add('Rendered metadata can add visual noise if shown for simple tasks.');
  }
  if (capability?.risk && capability.risk !== 'none' && capability.risk !== 'read') {
    effects.add('Risky operations may pause at confirmation instead of executing immediately.');
  }
  return Array.from(effects);
}

function inferPlanningNotes(
  memoryEntries: MonarchPlanningMemoryReference[],
  riskLevel: MonarchPlanningRiskLevel
): string[] {
  const notes: string[] = [];
  if (memoryEntries.length > 0) {
    notes.push(`Using ${memoryEntries.length} relevant classified memory ${memoryEntries.length === 1 ? 'entry' : 'entries'}.`);
  }
  if (riskLevel === 'high' || riskLevel === 'critical') {
    notes.push('Review side effects before execution and keep validation explicit.');
  }
  return notes;
}

function readPlanningMemory(context: Record<string, unknown> | undefined): MonarchPlanningMemoryReference[] {
  const raw = context?.planningMemory ?? context?.relevantMemory ?? context?.memoryEntries;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map(readPlanningMemoryReference)
    .filter((entry): entry is MonarchPlanningMemoryReference => Boolean(entry))
    .slice(0, 8);
}

function readPlanningMemoryReference(value: unknown): MonarchPlanningMemoryReference | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  const text = readString(record.excerpt) || readString(record.content) || readString(record.text);
  if (!id || !text) {
    return null;
  }
  const title = readString(record.title) || text.slice(0, 80);
  const reference: MonarchPlanningMemoryReference = {
    id,
    type: (readString(record.type) || readString(record.category) || 'planning_note') as MonarchMemoryEntryType | string,
    title,
    excerpt: text.length > 420 ? `${text.slice(0, 417).trim()}...` : text,
  };
  const source = readString(record.source);
  if (source) reference.source = source;
  const relevance = readNumber(record.relevance) ?? readNumber(record.priority) ?? readNumber(record.importance);
  if (relevance !== undefined) reference.relevance = relevance;
  const relatedFiles = readStringArray(record.relatedFiles) || readStringArray(record.related_files);
  if (relatedFiles.length > 0) reference.relatedFiles = relatedFiles;
  const relatedModules = readStringArray(record.relatedModules) || readStringArray(record.related_modules);
  if (relatedModules.length > 0) reference.relatedModules = relatedModules;
  return reference;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 12);
}
