import type {
  MonarchCapability,
  MonarchIntent,
  MonarchKernelContext,
  MonarchLlmRouter,
  MonarchLlmRouterStageResult,
  MonarchModule,
  MonarchRouteCandidate,
  MonarchRoutingAnalysis,
} from '../../core';
import {
  clampConfidence,
  findMissingRequiredInput,
  permissionModeForRisk,
} from '../../core';
import { readModelCatalog } from './model-catalog';
import {
  createModelRuntimeReport,
  runtimeEntryForRole,
} from './runtime-adapters';

export interface LocalSystemRouterOptions {
  workspaceRoot: string;
  endpoint?: string;
  timeoutMs?: number;
}

interface EndpointRouteCandidate {
  targetModuleId?: unknown;
  moduleId?: unknown;
  capabilityId?: unknown;
  confidence?: unknown;
  reason?: unknown;
  input?: unknown;
}

interface EndpointRouteResponse {
  candidates?: unknown;
  selected?: unknown;
}

export function createLocalSystemRouter(options: LocalSystemRouterOptions): MonarchLlmRouter {
  return new LocalSystemRouter(options);
}

class LocalSystemRouter implements MonarchLlmRouter {
  constructor(private readonly options: LocalSystemRouterOptions) {}

  async route(
    intent: MonarchIntent,
    modules: MonarchModule[],
    context: MonarchKernelContext,
    analysis?: MonarchRoutingAnalysis
  ): Promise<MonarchLlmRouterStageResult> {
    const catalog = await readModelCatalog(this.options.workspaceRoot);
    const runtimeReport = createModelRuntimeReport(catalog);
    const fastRuntime = runtimeEntryForRole(runtimeReport, 'gemma4-fast');
    const balancedRuntime = runtimeEntryForRole(runtimeReport, 'gemma4-balanced');
    const runtime = fastRuntime?.canInfer
      ? fastRuntime
      : balancedRuntime?.canInfer
        ? balancedRuntime
        : fastRuntime || balancedRuntime;
    const endpoint = this.options.endpoint || runtime?.endpoint || '';
    const modelAsset = runtime?.modelAsset || 'gemma4-fast';

    if (!runtime || runtime.runnerStatus === 'model-missing') {
      const summary = {
        status: 'blocked' as const,
        reason: 'Gemma 4 Fast router model is missing.',
        model: modelAsset,
        candidates: 0,
      };
      if (runtime?.adapter) {
        return {
          summary: {
            ...summary,
            adapter: runtime.adapter,
          },
          candidates: [],
        };
      }
      return {
        summary,
        candidates: [],
      };
    }

    if (!runtime.canInfer || !endpoint) {
      const reason = !endpoint
        ? 'No dedicated Gemma router endpoint is configured; deterministic routing remains active.'
        : runtime.detail;
      await context.emit('router.llm.skipped', 'gemma4-fast', {
        intentId: intent.id,
        model: modelAsset,
        reason,
      });
      await context.audit('routing', 'LLM router skipped until runner endpoint is configured.', {
        intentId: intent.id,
        model: modelAsset,
        reason,
      }, 'debug');
      return {
        summary: {
          status: 'skipped',
          reason,
          model: modelAsset,
          adapter: runtime.adapter,
          candidates: 0,
        },
        candidates: [],
      };
    }

    const response = await callRouterEndpoint(endpoint, intent, modules, analysis, this.options.timeoutMs || 2500);
    const candidates = normalizeEndpointCandidates(intent, response, modules);
    await context.emit('router.llm.completed', 'gemma4-fast', {
      intentId: intent.id,
      endpoint,
      candidates: candidates.length,
    });

    return {
      summary: {
        status: 'ready',
        reason: `Gemma router endpoint returned ${candidates.length} candidates.`,
        model: modelAsset,
        adapter: runtime.adapter,
        endpoint,
        candidates: candidates.length,
      },
      candidates,
    };
  }
}

async function callRouterEndpoint(
  endpoint: string,
  intent: MonarchIntent,
  modules: MonarchModule[],
  analysis: MonarchRoutingAnalysis | undefined,
  timeoutMs: number
): Promise<EndpointRouteResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: intent.text,
        source: intent.source,
        routing: analysis,
        modules: modules.map((module) => ({
          id: module.manifest.id,
          name: module.manifest.name,
          kind: module.manifest.kind,
          owns: module.manifest.owns,
          capabilities: module.manifest.capabilities.map((capability) => ({
            id: capability.id,
            title: capability.title,
            description: capability.description,
            risk: capability.risk,
            routing: capability.routing,
            inputSchema: capability.inputSchema,
          })),
        })),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemma router endpoint returned HTTP ${response.status}.`);
    }

    return await response.json() as EndpointRouteResponse;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeEndpointCandidates(
  intent: MonarchIntent,
  response: EndpointRouteResponse,
  modules: MonarchModule[]
): MonarchRouteCandidate[] {
  const rawCandidates = Array.isArray(response.candidates)
    ? response.candidates
    : response.selected
      ? [response.selected]
      : [];

  return rawCandidates
    .map((raw) => normalizeEndpointCandidate(intent, raw, modules))
    .filter((candidate): candidate is MonarchRouteCandidate => Boolean(candidate));
}

function normalizeEndpointCandidate(
  intent: MonarchIntent,
  raw: unknown,
  modules: MonarchModule[]
): MonarchRouteCandidate | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as EndpointRouteCandidate;
  const moduleId = readString(record.targetModuleId) || readString(record.moduleId);
  const capabilityId = readString(record.capabilityId);
  const capability = findCapability(modules, moduleId, capabilityId);
  if (!moduleId || !capabilityId || !capability) {
    return null;
  }

  const input = record.input === undefined ? {} : record.input;
  const missingInput = findMissingRequiredInput(capability, input);
  const candidate: MonarchRouteCandidate = {
    intentId: intent.id,
    targetModuleId: moduleId,
    capabilityId,
    confidence: clampConfidence(readNumber(record.confidence, 0.72)),
    reason: readString(record.reason) || 'Gemma router endpoint route candidate.',
    source: 'llm',
    permissionMode: permissionModeForRisk(capability.risk),
    input,
    scoreParts: {
      llm: readNumber(record.confidence, 0.72),
    },
  };

  if (missingInput.length > 0) {
    candidate.missingInput = missingInput;
  }

  return candidate;
}

function findCapability(
  modules: MonarchModule[],
  moduleId: string,
  capabilityId: string
): MonarchCapability | undefined {
  return modules
    .find((module) => module.manifest.id === moduleId)
    ?.manifest.capabilities.find((capability) => capability.id === capabilityId);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
