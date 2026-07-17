import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
  MonarchSearchScope,
} from '../../core';
import { classifyIntentText, permissionModeForRisk } from '../../core';
import { knowledgeManifest } from './manifest';

export type MonarchKnowledgePolicy = 'local_only' | 'web_optional' | 'web_required';
export type MonarchSearchDepth = 'quick' | 'multi' | 'deep';

export interface MonarchKnowledgePolicyDecision {
  policy: MonarchKnowledgePolicy;
  depth: MonarchSearchDepth;
  reason: string;
  confidence: number;
  searchScope: MonarchSearchScope;
}

export class KnowledgeModule implements MonarchModule {
  readonly manifest = knowledgeManifest;

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('knowledge.activated', this.manifest.id, {
      policy: 'local-first',
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: 'Knowledge policy module ready.',
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.trim();
    if (!/(knowledge policy|web policy|need web|should search|use web|latest|current|today|news)/i.test(text)) {
      return null;
    }

    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'knowledge.policy.evaluate',
      confidence: 0.74,
      reason: 'Knowledge/web policy evaluation request detected.',
      permissionMode: permissionModeForRisk('read'),
      input: { text },
    };
  }

  async executeCapability(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
    if (request.capabilityId !== 'knowledge.policy.evaluate') {
      return {
        ok: false,
        summary: `Unsupported knowledge capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }

    const text = readStringInput(request.input, 'text');
    const decision = evaluateKnowledgePolicy(text, {
      webEnabled: readBooleanInput(request.input, 'webEnabled', true),
      internetAvailable: readBooleanInput(request.input, 'internetAvailable', true),
    });

    return {
      ok: true,
      summary: `Knowledge policy: ${decision.policy} (${decision.reason}).`,
      output: { decision },
    };
  }
}

export function evaluateKnowledgePolicy(
  text: string,
  options: { webEnabled?: boolean; internetAvailable?: boolean } = {}
): MonarchKnowledgePolicyDecision {
  const normalized = text.trim();
  const classification = classifyIntentText(normalized);

  if (options.webEnabled === false) {
    return decision('local_only', 'quick', 'web-disabled', 1, classification.searchScope);
  }
  if (options.internetAvailable === false) {
    return decision('local_only', 'quick', 'internet-unavailable', 1, classification.searchScope);
  }
  if (!normalized) {
    return decision('local_only', 'quick', 'empty-input', 1, classification.searchScope);
  }
  if (classification.searchScope === 'web_required' || explicitWebRequest(normalized)) {
    return decision('web_required', estimateSearchDepth(normalized), 'explicit-or-fresh-web-request', 0.92, classification.searchScope);
  }
  if (freshnessSensitive(normalized)) {
    return decision('web_required', estimateSearchDepth(normalized), 'freshness-sensitive', 0.86, classification.searchScope);
  }
  if (localOnly(normalized, classification.kind)) {
    return decision('local_only', 'quick', 'local-task', 0.9, classification.searchScope);
  }
  if (comparative(normalized) || rareKnowledge(normalized) || classification.kind === 'search') {
    return decision('web_optional', estimateSearchDepth(normalized), 'knowledge-may-benefit-from-web', 0.64, classification.searchScope);
  }

  return decision('local_only', 'quick', 'default-local-first', 0.72, classification.searchScope);
}

function explicitWebRequest(text: string): boolean {
  return /(search|find|look up).{0,24}(web|internet|online|google)|\b(web|internet|online)\b/i.test(text);
}

function freshnessSensitive(text: string): boolean {
  return /(latest|current|today|right now|news|weather|price|stock|release|version|schedule|score|breaking)/i.test(text);
}

function localOnly(text: string, kind: string): boolean {
  return kind === 'code'
    || kind === 'file_generation'
    || kind === 'file_operation'
    || kind === 'system_action'
    || /^(hello|hi|hey|thanks)\b/i.test(text)
    || /(write code|debug|refactor|create file|delete file|read file)/i.test(text);
}

function comparative(text: string): boolean {
  return /(compare|comparison|versus|\bvs\b|which is better|pros and cons)/i.test(text);
}

function rareKnowledge(text: string): boolean {
  return /(who is|what is|where is|when did|when was|how much|how many)\s+\S/i.test(text);
}

function estimateSearchDepth(text: string): MonarchSearchDepth {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (/(deep|comprehensive|in depth|analyz|review|compare)/i.test(text)) {
    return 'deep';
  }
  if (words > 14 || /(and also|as well as|additionally)/i.test(text)) {
    return 'multi';
  }
  return 'quick';
}

function decision(
  policy: MonarchKnowledgePolicy,
  depth: MonarchSearchDepth,
  reason: string,
  confidence: number,
  searchScope: MonarchSearchScope
): MonarchKnowledgePolicyDecision {
  return { policy, depth, reason, confidence, searchScope };
}

function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readBooleanInput(input: unknown, key: string, fallback: boolean): boolean {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function createKnowledgeModule(): MonarchModule {
  return new KnowledgeModule();
}

export const knowledgeModulePackage: MonarchModulePackage = {
  id: knowledgeManifest.id,
  moduleId: knowledgeManifest.id,
  version: knowledgeManifest.version,
  description: knowledgeManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createKnowledgeModule,
};
