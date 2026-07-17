import type {
  MonarchIntent,
  MonarchKernelContext,
  MonarchLlmRouter,
  MonarchLlmRouterStageResult,
  MonarchModule,
  MonarchModuleRecord,
  MonarchRouteCandidate,
  MonarchRouteDecision,
  MonarchRouteTrace,
  MonarchRoutingAnalysis,
} from './contracts';
import { classifyIntent, createParentRouteDecision } from './intent-classifier';
import { selectModelRoute } from './model-router';
import { resolveRouteCandidates } from './router-resolver';
import {
  createFallbackCandidates,
  decisionToRouteCandidate,
  mergeRouteCandidates,
} from './router-scoring';
import { normalizeText } from './utils';

export class MonarchRouterMesh {
  constructor(private readonly llmRouter?: MonarchLlmRouter) {}

  async route(
    intent: MonarchIntent,
    modules: MonarchModule[],
    context: MonarchKernelContext
  ): Promise<MonarchRouteDecision | null> {
    const routableModules = selectRoutableModules(modules, context.listModules());
    const analysis = createRoutingAnalysis(intent);
    const classifiedIntent = attachRoutingAnalysis(intent, analysis);
    const moduleCandidates = await collectModuleCandidates(classifiedIntent, routableModules, context);
    const fallbackCandidates = createFallbackCandidates(classifiedIntent, routableModules);
    const llmRouterResult = await collectLlmRouterCandidates(
      this.llmRouter,
      classifiedIntent,
      routableModules,
      context,
      analysis
    );
    const candidates = mergeRouteCandidates([
      ...moduleCandidates,
      ...fallbackCandidates,
      ...llmRouterResult.candidates,
    ]);
    const trace = resolveRouteCandidates(classifiedIntent, candidates, routableModules);
    trace.version = '0.3';
    trace.classification = analysis.classification;
    trace.parentRouter = analysis.parentRouter;
    trace.modelRouter = analysis.modelRouter;
    trace.llmRouter = llmRouterResult.summary;

    await publishRouteTrace(context, trace);
    return trace.selected || null;
  }
}

async function collectModuleCandidates(
  intent: MonarchIntent,
  modules: MonarchModule[],
  context: MonarchKernelContext
): Promise<MonarchRouteCandidate[]> {
  const candidates: MonarchRouteCandidate[] = [];

  for (const module of modules) {
    if (!module.handleIntent) {
      continue;
    }

    let decision: MonarchRouteDecision | null = null;
    try {
      decision = await module.handleIntent(intent, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await context.audit('routing', 'Module route handler failed.', {
        intentId: intent.id,
        moduleId: module.manifest.id,
        error: message,
      }, 'warn');
      await context.emit('module.route_failed', 'router-mesh', {
        intentId: intent.id,
        moduleId: module.manifest.id,
        error: message,
      });
    }

    if (decision) {
      candidates.push(decisionToRouteCandidate(intent, decision, modules));
    }
  }

  return candidates;
}

async function collectLlmRouterCandidates(
  llmRouter: MonarchLlmRouter | undefined,
  intent: MonarchIntent,
  modules: MonarchModule[],
  context: MonarchKernelContext,
  analysis: MonarchRoutingAnalysis
): Promise<MonarchLlmRouterStageResult> {
  if (!llmRouter) {
    return {
      summary: {
        status: 'skipped',
        reason: 'No LLM router adapter is configured.',
        candidates: 0,
      },
      candidates: [],
    };
  }

  try {
    return await llmRouter.route(intent, modules, context, analysis);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.audit('routing', 'LLM router stage failed.', {
      intentId: intent.id,
      error: message,
    }, 'warn');
    await context.emit('router.llm.failed', 'router-mesh', {
      intentId: intent.id,
      error: message,
    });
    return {
      summary: {
        status: 'failed',
        reason: message,
        candidates: 0,
      },
      candidates: [],
    };
  }
}

function createRoutingAnalysis(intent: MonarchIntent): MonarchRoutingAnalysis {
  const classification = classifyIntent(intent);
  const parentRouter = createParentRouteDecision(classification);
  const modelRouter = selectModelRoute(intent, classification);

  return {
    classification,
    parentRouter,
    modelRouter,
  };
}

function attachRoutingAnalysis(
  intent: MonarchIntent,
  analysis: MonarchRoutingAnalysis
): MonarchIntent {
  return {
    ...intent,
    context: {
      ...(intent.context || {}),
      routingAnalysis: analysis,
    },
  };
}

async function publishRouteTrace(
  context: MonarchKernelContext,
  trace: MonarchRouteTrace
): Promise<void> {
  const sanitizedTrace = sanitizeRouteTrace(trace);
  await context.emit('router.route_trace', 'router-mesh', sanitizedTrace);
  await context.audit(
    'routing',
    'Router v0.3 route trace.',
    sanitizedTrace,
    trace.selected ? 'debug' : 'info'
  );
}

function selectRoutableModules(
  modules: MonarchModule[],
  records: MonarchModuleRecord[]
): MonarchModule[] {
  const activeModuleIds = new Set(
    records
      .filter((record) => record.status === 'active')
      .map((record) => record.manifest.id)
  );

  return activeModuleIds.size > 0
    ? modules.filter((module) => activeModuleIds.has(module.manifest.id))
    : modules;
}

function sanitizeRouteTrace(trace: MonarchRouteTrace): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    version: trace.version,
    intentId: trace.intentId,
    originalText: redactSensitiveText(trace.originalText),
    classification: trace.classification,
    parentRouter: trace.parentRouter,
    modelRouter: trace.modelRouter,
    candidates: trace.candidates.map(sanitizeCandidate),
    llmRouter: trace.llmRouter,
    rejected: trace.rejected,
    unresolvedReason: trace.unresolvedReason,
    resolverReason: trace.resolverReason,
  };

  if (trace.selected) {
    sanitized.selected = sanitizeDecision(trace.selected);
  }

  return sanitized;
}

function sanitizeCandidate(candidate: MonarchRouteCandidate): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    intentId: candidate.intentId,
    targetModuleId: candidate.targetModuleId,
    capabilityId: candidate.capabilityId,
    confidence: candidate.confidence,
    reason: candidate.reason,
    source: candidate.source,
    permissionMode: candidate.permissionMode,
  };

  if (candidate.input !== undefined) {
    sanitized.input = summarizePayload(candidate.input);
  }
  if (candidate.missingInput) {
    sanitized.missingInput = candidate.missingInput;
  }
  if (candidate.scoreParts) {
    sanitized.scoreParts = candidate.scoreParts;
  }

  return sanitized;
}

function sanitizeDecision(decision: MonarchRouteDecision): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    intentId: decision.intentId,
    targetModuleId: decision.targetModuleId,
    confidence: decision.confidence,
    reason: decision.reason,
    permissionMode: decision.permissionMode,
  };

  if (decision.capabilityId) {
    sanitized.capabilityId = decision.capabilityId;
  }
  if (decision.input !== undefined) {
    sanitized.input = summarizePayload(decision.input);
  }

  return sanitized;
}

function summarizePayload(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
    };
  }

  if (value && typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value),
    };
  }

  return {
    type: typeof value,
  };
}

function redactSensitiveText(text: string): string {
  const redacted = normalizeText(text)
    .replace(/\b(api[_-]?key|token|secret|password|credential)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
}
