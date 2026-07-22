import type {
  MonarchAuditEntry,
  MonarchCapability,
  MonarchEvent,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchModuleRecord,
  MonarchRouteDecision,
  MonarchRoutingAnalysis,
} from '../../core';
import { diagnosticsManifest } from './manifest';

export class DiagnosticsModule implements MonarchModule {
  readonly manifest = diagnosticsManifest;

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('diagnostics.activated', this.manifest.id, {
      surface: 'kernel-context',
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: 'Diagnostics module ready.',
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.toLowerCase();
    const analysis = intent.context?.routingAnalysis as MonarchRoutingAnalysis | undefined;
    if (analysis?.classification.kind === 'capabilities_question') {
      return null;
    }
    if (mentionsForeignModuleScope(text) && !mentionsExplicitDiagnosticsScope(text)) {
      return null;
    }
    if (!mentionsDiagnostics(text)) {
      return null;
    }

    if (mentionsWholeSystemInspection(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'diagnostics.system.inspect',
        confidence: 0.94,
        reason: 'User asks for an adaptive live inspection of the Monarch system.',
        permissionMode: 'allow',
        input: { query: intent.text },
      };
    }

    if (mentionsProjectDiagnostics(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'diagnostics.project.report',
        confidence: 0.87,
        reason: 'User asks for a structured project diagnostic report.',
        permissionMode: 'allow',
        input: {
          limit: 50,
        },
      };
    }

    if (mentionsCapabilityRequest(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'diagnostics.capabilities.list',
        confidence: 0.84,
        reason: 'User asks to inspect available capabilities.',
        permissionMode: 'allow',
        input: {},
      };
    }

    if (/(event|событи|history|истори)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'diagnostics.events.list',
        confidence: 0.82,
        reason: 'User asks to inspect kernel events.',
        permissionMode: 'allow',
        input: {
          limit: 25,
        },
      };
    }

    if (/(audit|аудит|лог|logs?)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'diagnostics.audit.list',
        confidence: 0.82,
        reason: 'User asks to inspect redacted audit history.',
        permissionMode: 'allow',
        input: {
          limit: 25,
        },
      };
    }

    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'diagnostics.modules.list',
      confidence: 0.8,
      reason: 'User asks to inspect kernel/module status.',
      permissionMode: 'allow',
      input: {},
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'diagnostics.system.inspect':
      return this.inspectSystem(request.input, context);
    case 'diagnostics.project.report':
      return this.projectReport(request.input, context);
    case 'diagnostics.modules.list':
      return this.listModules(request.input, context);
    case 'diagnostics.capabilities.list':
      return this.listCapabilities(request.input, context);
    case 'diagnostics.events.list':
      return this.listEvents(request.input, context);
    case 'diagnostics.audit.list':
      return this.listAudit(request.input, context);
    default:
      return {
        ok: false,
        summary: `Unsupported diagnostics capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private async inspectSystem(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const query = readStringInput(input, 'query');
    const requestedModuleIds = new Set(readStringArrayInput(input, 'moduleIds'));
    const allModules = context.listModules();
    const wholeSystem = requestedModuleIds.size === 0 && (!query || mentionsWholeSystemInspection(query));
    let modules = allModules.filter((record) => requestedModuleIds.size === 0 || requestedModuleIds.has(record.manifest.id));
    if (!wholeSystem && requestedModuleIds.size === 0 && query) {
      const relevant = modules.filter((record) => moduleMatchesQuery(record, query));
      if (relevant.length > 0) modules = relevant;
    }
    modules = modules.slice(0, 32);

    const inspections: Array<Record<string, unknown>> = [];
    for (const [index, record] of modules.entries()) {
      const capability = selectStatusCapability(record.manifest.id, context.listCapabilities(record.manifest.id));
      if (!capability || record.status !== 'active') {
        inspections.push({
          ...summarizeModuleRecord(record),
          probe: capability ? 'skipped-module-not-active' : 'lifecycle-only',
        });
        continue;
      }
      const result = await context.execute({
        id: `exec_diagnostics_system_${record.manifest.id}_${Date.now()}_${index}`,
        intentId: '',
        moduleId: record.manifest.id,
        capabilityId: capability.id,
        input: {},
        createdAt: new Date().toISOString(),
        requestedBy: 'system',
      });
      inspections.push({
        ...summarizeModuleRecord(record),
        probe: capability.id,
        probeOk: result.ok,
        probeSummary: result.summary,
        ...(result.error ? { probeError: result.error } : {}),
        ...(result.output === undefined ? {} : { probeOutput: boundDiagnosticValue(result.output) }),
      });
    }

    const failed = inspections.filter((entry) => entry.status === 'failed' || entry.probeOk === false).length;
    const probed = inspections.filter((entry) => typeof entry.probe === 'string' && entry.probe !== 'lifecycle-only').length;
    const status = failed > 0 ? 'degraded' : 'ok';
    await context.emit('diagnostics.system.inspected', this.manifest.id, {
      status,
      modules: inspections.length,
      probed,
      failed,
    });
    return {
      ok: true,
      summary: `Live Monarch inspection completed: ${inspections.length} modules, ${probed} status probes, ${failed} failures.`,
      output: {
        status,
        scope: wholeSystem ? 'all' : 'relevant',
        generatedAt: new Date().toISOString(),
        modules: inspections,
        totals: { modules: inspections.length, probed, failed },
      },
    };
  }

  private projectReport(
    input: unknown,
    context: MonarchKernelContext
  ): MonarchExecutionResult {
    const limit = readNumberInput(input, 'limit', 50);
    const modules = context.listModules();
    const capabilities = context.listCapabilities();
    const events = takeRecent(context.listEvents(), limit);
    const audit = takeRecent(context.listAudit(), limit);
    const permission = context.getPermissionProfile();
    const sourceSummaries = readSourceSummaries(input);
    const anomalies: DiagnosticAnomaly[] = [];
    const affectedModules = new Set<string>();
    const suspectedCauses = new Set<string>();
    const recommendedActions = new Set<string>();
    const suggestedTests = new Set<string>();
    const notes = new Set<string>();

    for (const record of modules) {
      if (record.status === 'failed') {
        anomalies.push({
          status: 'critical',
          source: 'kernel.modules',
          message: `Module ${record.manifest.id} is failed${record.lastError ? `: ${record.lastError}` : '.'}`,
        });
        affectedModules.add(record.manifest.id);
        suspectedCauses.add('module activation failure');
        recommendedActions.add(`Inspect ${record.manifest.id} activation logs and dependencies.`);
      }
    }

    for (const entry of audit) {
      if (entry.severity === 'error' || entry.severity === 'warn') {
        anomalies.push({
          status: entry.severity === 'error' ? 'critical' : 'warning',
          source: `audit.${entry.category}`,
          message: entry.message,
        });
        suspectedCauses.add(`${entry.category} warning/error in audit log`);
      }
    }

    for (const event of events) {
      if (/(failed|error|blocked|denied|timeout)/i.test(event.type)) {
        anomalies.push({
          status: /failed|error|timeout/i.test(event.type) ? 'critical' : 'warning',
          source: `event.${event.type}`,
          message: `Recent event ${event.type} from ${event.source}.`,
        });
        affectedModules.add(event.source);
      }
    }

    if (permission.sandboxMode === 'danger-full-access') {
      anomalies.push({
        status: 'warning',
        source: 'permission.profile',
        message: 'Kernel is running with danger-full-access; diagnostics stays read-only but actions may be high blast-radius.',
      });
      recommendedActions.add('Confirm destructive or execute actions explicitly before running them.');
    }

    for (const source of sourceSummaries) {
      const detected = detectSourceAnomalies(source);
      anomalies.push(...detected);
      if (detected.length > 0) {
        if (/test|pytest|vitest|smoke/i.test(source.id)) {
          suspectedCauses.add('recent test output contains failures or warnings');
          suggestedTests.add(source.id);
        }
        if (/diff|changed|git/i.test(source.id)) {
          suspectedCauses.add('current diff may contain debug/TODO leakage or risky edits');
        }
      }
    }

    if (capabilities.length === 0) {
      anomalies.push({
        status: 'critical',
        source: 'kernel.capabilities',
        message: 'No capabilities are registered.',
      });
      suspectedCauses.add('module registration did not complete');
    }

    if (modules.length > 0 && modules.every((record) => record.status === 'active')) {
      notes.add('All registered modules are active.');
    }
    if (capabilities.length > 0) {
      notes.add(`${capabilities.length} capabilities are registered.`);
    }

    if (anomalies.length === 0) {
      recommendedActions.add('No immediate action required; keep using focused tests for changed modules.');
    } else {
      recommendedActions.add('Start with the highest severity anomaly and verify with the narrowest focused test.');
      suggestedTests.add('npm test -- tests/core/router.test.ts tests/modules/memory.test.ts');
    }

    const status = reportStatus(anomalies);
    const output = {
      status,
      checked_sources: [
        'kernel.modules',
        'kernel.capabilities',
        'kernel.events',
        'kernel.audit',
        'permission.profile',
        ...sourceSummaries.map((source) => source.id),
      ],
      detected_anomalies: anomalies,
      suspected_causes: Array.from(suspectedCauses),
      affected_modules: Array.from(affectedModules).filter(Boolean),
      recommended_actions: Array.from(recommendedActions),
      suggested_tests: Array.from(suggestedTests),
      notes: Array.from(notes),
      memory_entry_suggestions: anomalies.slice(0, 8).map((anomaly) => ({
        type: anomaly.status === 'critical' ? 'active_bug' : 'diagnostic_note',
        title: anomaly.message.slice(0, 120),
        content: `${anomaly.source}: ${anomaly.message}`,
        tags: ['diagnostics', anomaly.status],
        source: 'diagnostics.project.report',
      })),
    };

    return {
      ok: true,
      summary: `Project diagnostics completed with status ${status}.`,
      output,
    };
  }

  private listModules(
    input: unknown,
    context: MonarchKernelContext
  ): MonarchExecutionResult {
    const status = readStringInput(input, 'status');
    const modules = context.listModules()
      .filter((record) => !status || record.status === status)
      .map(summarizeModuleRecord);

    return {
      ok: true,
      summary: `Diagnostics listed ${modules.length} modules.`,
      output: { modules },
    };
  }

  private listCapabilities(
    input: unknown,
    context: MonarchKernelContext
  ): MonarchExecutionResult {
    const moduleId = readStringInput(input, 'moduleId');
    const capabilities = context.listCapabilities(moduleId || undefined);

    return {
      ok: true,
      summary: `Diagnostics listed ${capabilities.length} capabilities.`,
      output: { capabilities },
    };
  }

  private listEvents(
    input: unknown,
    context: MonarchKernelContext
  ): MonarchExecutionResult {
    const type = readStringInput(input, 'type');
    const limit = readNumberInput(input, 'limit', 25);
    const events = takeRecent(
      context.listEvents().filter((event) => !type || event.type === type),
      limit
    );

    return {
      ok: true,
      summary: `Diagnostics listed ${events.length} events.`,
      output: { events },
    };
  }

  private listAudit(
    input: unknown,
    context: MonarchKernelContext
  ): MonarchExecutionResult {
    const category = readStringInput(input, 'category');
    const limit = readNumberInput(input, 'limit', 25);
    const entries = takeRecent(
      context.listAudit().filter((entry) => !category || entry.category === category),
      limit
    );

    return {
      ok: true,
      summary: `Diagnostics listed ${entries.length} audit entries.`,
      output: { entries },
    };
  }
}

function mentionsDiagnostics(text: string): boolean {
  return /^(?:diagnostics?|диагностика|kernel|ядро)[.!? ]*$/i.test(text)
    || /(?:\b(?:diagnostic|diagnostics|kernel)\b|диагност|ядр).{0,40}(?:\b(?:monarch|system|modules?|project|repo|workspace|runtime|backend|computer|host|code|tests?)\b|монарх|систем|модул|проект|репозитор|workspace|рантайм|бэкенд|компьютер|хост|код|тест)/i.test(text)
    || /(?:\b(?:monarch|system|modules?|project|repo|workspace|runtime|backend|computer|host|code|tests?)\b|монарх|систем|модул|проект|репозитор|workspace|рантайм|бэкенд|компьютер|хост|код|тест).{0,40}(?:\b(?:diagnostic|diagnostics|kernel)\b|диагност|ядр)/i.test(text)
    || mentionsWholeSystemInspection(text)
    || mentionsProjectDiagnostics(text)
    || mentionsCapabilityRequest(text)
    || /^(?:status|health|статус|состояние)(?:\s+(?:monarch|монарх))?[.!? ]*$/i.test(text)
    || /^(?:(?:show|check|покажи|проверь)\s+)?(?:system\s+(?:status|health)|(?:status|health)\s+(?:of\s+the\s+)?system|(?:статус|состояние|здоровье)\s+системы)[.!? ]*$/i.test(text)
    || /(?:\b(?:show|list|check|inspect|status|health)\b|покажи|проверь|список|статус|состояние).{0,40}(?:\b(?:monarch|kernel|modules?|runtime|backend|workspace|project)\b|монарх|ядр|модул|рантайм|бэкенд|проект|workspace)/i.test(text)
    || /(?:\b(?:audit|events?|logs?)\b|аудит|событи|логи)(?=.{0,40}(?:\b(?:monarch|kernel|modules?)\b|монарх|ядр|модул))/i.test(text);
}

function mentionsWholeSystemInspection(text: string): boolean {
  return /(?:monarch|монарх).{0,48}(?:system|modules?|check|inspect|health|status|систем|модул|провер|статус|здоров)|(?:system|modules?|check|inspect|health|status|систем|модул|провер|статус|здоров).{0,48}(?:monarch|монарх)/i.test(text)
    || /^(?:check|inspect|diagnose)\s+(?:the\s+)?(?:whole\s+|entire\s+|full\s+)?system[.!? ]*$/i.test(text)
    || /^(?:проверь|диагностируй)\s+(?:всю\s+|полностью\s+)?систему[.!? ]*$/i.test(text);
}

function mentionsForeignModuleScope(text: string): boolean {
  return /\b(security|protector|oscar|memory|models?|telegram|voice|workspace|astra)\b/i.test(text)
    || /(защит|безопасност|памят|модел|телеграм|голос|рабоч(?:ее|его|ем)\s+пространств|астра)/i.test(text);
}

function mentionsExplicitDiagnosticsScope(text: string): boolean {
  return /\b(diagnostic|diagnostics|kernel|modules?)\b/i.test(text)
    || /(диагност|ядр|модул)/i.test(text);
}

function mentionsProjectDiagnostics(text: string): boolean {
  return (
    /\b(project|repo|workspace|runtime|diff|tests?|logs?|anomal(?:y|ies)|problem|proactive|self[- ]?check)\b/i.test(text)
    || /(проект|репозитор|рабоч\w*\s+пространств|рантайм|дифф|тест|лог|аномал|проблем|самопровер)/i.test(text)
  ) && (
    /\b(diagnostic|diagnostics|diagnose|health|audit|check)\b/i.test(text)
    || /(диагност|провер|аудит|здоров)/i.test(text)
  );
}

function mentionsCapabilityRequest(text: string): boolean {
  return /\b(?:what can you do|available (?:capabilities|tools|actions|commands)|(?:show|list) (?:capabilities|tools|actions|commands))\b/i.test(text)
    || /(?:покажи|перечисли|какие|какими|доступн\w*|что\s+ты\s+умеешь).{0,36}(?:инструмент|возможност|способност|команд|действи)/i.test(text)
    || /(?:что|какими|какие|какой|чем)\s+(?:ты\s+)?(?:можешь|умеешь)(?:\s+делать|\s+пользоваться)?/i.test(text)
    || /(?:можешь|умеешь)\s+(?:делать|использовать|пользоваться|управлять)/i.test(text);
}

type DiagnosticStatus = 'ok' | 'warning' | 'critical';

interface DiagnosticAnomaly {
  status: Exclude<DiagnosticStatus, 'ok'>;
  source: string;
  message: string;
}

interface DiagnosticSourceSummary {
  id: string;
  text: string;
}

function readSourceSummaries(input: unknown): DiagnosticSourceSummary[] {
  if (!input || typeof input !== 'object') {
    return [];
  }
  const rawSources = (input as Record<string, unknown>).sources;
  if (!rawSources || typeof rawSources !== 'object' || Array.isArray(rawSources)) {
    return [];
  }
  return Object.entries(rawSources as Record<string, unknown>)
    .map(([id, value]) => ({
      id,
      text: typeof value === 'string' ? value : JSON.stringify(value),
    }))
    .filter((source) => source.id.trim() && source.text.trim())
    .slice(0, 20);
}

function detectSourceAnomalies(source: DiagnosticSourceSummary): DiagnosticAnomaly[] {
  const text = source.text.slice(0, 12000);
  const anomalies: DiagnosticAnomaly[] = [];
  if (/(error|failed|traceback|exception|fatal|panic|ошибка|упал|падает)/i.test(text)) {
    anomalies.push({
      status: 'critical',
      source: source.id,
      message: `${source.id} contains failure/error signals.`,
    });
  }
  if (/(TODO|FIXME|console\.log|debugger|raw tool|secret|token|password|ключ|парол)/i.test(text)) {
    anomalies.push({
      status: 'warning',
      source: source.id,
      message: `${source.id} contains TODO/debug or sensitive-looking leakage signals.`,
    });
  }
  return anomalies;
}

function reportStatus(anomalies: DiagnosticAnomaly[]): DiagnosticStatus {
  if (anomalies.some((anomaly) => anomaly.status === 'critical')) {
    return 'critical';
  }
  if (anomalies.some((anomaly) => anomaly.status === 'warning')) {
    return 'warning';
  }
  return 'ok';
}

function summarizeModuleRecord(record: MonarchModuleRecord): Record<string, unknown> {
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    version: record.manifest.version,
    kind: record.manifest.kind,
    status: record.status,
    capabilities: record.manifest.capabilities.length,
    dependencies: record.manifest.dependencies || [],
    owns: record.manifest.owns,
    registeredAt: record.registeredAt,
    activatedAt: record.activatedAt,
    failedAt: record.failedAt,
    lastError: record.lastError,
  };
}

function takeRecent<T extends MonarchEvent | MonarchAuditEntry>(items: T[], limit: number): T[] {
  return items.slice(-normalizeLimit(limit)).reverse();
}

function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArrayInput(input: unknown, key: string): string[] {
  if (!input || typeof input !== 'object') return [];
  const value = (input as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .slice(0, 32)
    : [];
}

function moduleMatchesQuery(record: MonarchModuleRecord, query: string): boolean {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3);
  const haystack = [
    record.manifest.id,
    record.manifest.name,
    record.manifest.description,
    ...record.manifest.owns,
  ].join(' ').toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function selectStatusCapability(moduleId: string, capabilities: MonarchCapability[]): MonarchCapability | undefined {
  const safe = capabilities.filter((capability) => {
    const schema = capability.inputSchema as { required?: unknown } | undefined;
    return (capability.risk === 'none' || capability.risk === 'read')
      && (!Array.isArray(schema?.required) || schema.required.length === 0);
  });
  return safe.find((capability) => capability.id === `${moduleId}.status`)
    || safe.find((capability) => capability.id === `${moduleId}.runtime.status`)
    || safe.find((capability) => /(?:^|\.)(?:status|health)$/.test(capability.id));
}

function boundDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]';
  if (typeof value === 'string') return value.slice(0, 800);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => boundDiagnosticValue(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    output[key] = /token|secret|passkey|password|recovery|authorization/i.test(key)
      ? '[redacted]'
      : boundDiagnosticValue(entry, depth + 1);
  }
  return output;
}

function readNumberInput(input: unknown, key: string, fallback: number): number {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(Math.floor(Number(limit) || 25), 200));
}

export function createDiagnosticsModule(): MonarchModule {
  return new DiagnosticsModule();
}

export const diagnosticsModulePackage: MonarchModulePackage = {
  id: diagnosticsManifest.id,
  moduleId: diagnosticsManifest.id,
  version: diagnosticsManifest.version,
  description: diagnosticsManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createDiagnosticsModule,
};
