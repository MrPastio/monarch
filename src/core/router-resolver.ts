import type {
  MonarchCapability,
  MonarchIntent,
  MonarchModule,
  MonarchRouteCandidate,
  MonarchRouteCandidateSource,
  MonarchRouteDecision,
  MonarchRouteTrace,
} from './contracts';
import { confidenceThresholdForRisk } from './router-policy';
import { normalizeText } from './utils';

const AMBIGUITY_CONFIDENCE_GAP = 0.15;

export function resolveRouteCandidates(
  intent: MonarchIntent,
  candidates: MonarchRouteCandidate[],
  modules: MonarchModule[]
): MonarchRouteTrace {
  const sortedCandidates = sortCandidates(candidates);

  if (sortedCandidates.length === 0) {
    return {
      version: '0.3',
      intentId: intent.id,
      originalText: normalizeText(intent.text),
      candidates: [],
      rejected: [],
      unresolvedReason: 'no-candidates',
      resolverReason: 'No route candidates were produced.',
    };
  }

  const top = sortedCandidates[0];
  if (!top) {
    return {
      version: '0.3',
      intentId: intent.id,
      originalText: normalizeText(intent.text),
      candidates: [],
      rejected: [],
      unresolvedReason: 'no-candidates',
      resolverReason: 'No route candidates were produced.',
    };
  }

  const capability = findCapability(modules, top.targetModuleId, top.capabilityId);
  const threshold = capability
    ? confidenceThresholdForRisk(capability.risk)
    : top.capabilityId
      ? confidenceThresholdForRisk('security-sensitive')
      : 0.5;
  if (top.confidence < threshold) {
    return traceWithoutSelection(
      intent,
      sortedCandidates,
      `Top candidate confidence ${formatConfidence(top.confidence)} is below ${formatConfidence(threshold)} for risk ${capability?.risk || 'unknown'}.`,
      'risk-threshold',
      (candidate) => routeCandidateKey(candidate) === routeCandidateKey(top)
        ? 'below risk threshold'
        : 'lower-scoring candidate'
    );
  }

  const second = sortedCandidates.find((candidate) => routeCandidateKey(candidate) !== routeCandidateKey(top));
  if (second && top.confidence - second.confidence < AMBIGUITY_CONFIDENCE_GAP) {
    const topSourcePriority = sourcePriority(top.source);
    const secondSourcePriority = sourcePriority(second.source);
    if (topSourcePriority <= secondSourcePriority || top.confidence < 0.65) {
      return traceWithoutSelection(
        intent,
        sortedCandidates,
        `Ambiguous route: top candidate is within ${formatConfidence(AMBIGUITY_CONFIDENCE_GAP)} of another candidate.`,
        'ambiguous',
        (candidate) => routeCandidateKey(candidate) === routeCandidateKey(top)
          || routeCandidateKey(candidate) === routeCandidateKey(second)
          ? 'ambiguous with another candidate'
          : 'lower-scoring candidate'
      );
    }
  }

  if (top.missingInput && top.missingInput.length > 0) {
    return traceWithoutSelection(
      intent,
      sortedCandidates,
      `Top candidate is missing required input: ${top.missingInput.join(', ')}.`,
      'missing-input',
      (candidate) => routeCandidateKey(candidate) === routeCandidateKey(top)
        ? `missing required input: ${candidate.missingInput?.join(', ') || 'unknown'}`
        : 'lower-scoring candidate'
    );
  }

  const selected = candidateToDecision(top);
  return {
    version: '0.3',
    intentId: intent.id,
    originalText: normalizeText(intent.text),
    candidates: sortedCandidates,
    selected,
    rejected: sortedCandidates
      .filter((candidate) => routeCandidateKey(candidate) !== routeCandidateKey(top))
      .map((candidate) => ({
        targetModuleId: candidate.targetModuleId,
        capabilityId: candidate.capabilityId,
        reason: 'lower-scoring candidate',
      })),
    resolverReason: 'Selected highest-confidence candidate that passed risk, ambiguity, and input checks.',
  };
}

function traceWithoutSelection(
  intent: MonarchIntent,
  candidates: MonarchRouteCandidate[],
  resolverReason: string,
  unresolvedReason: NonNullable<MonarchRouteTrace['unresolvedReason']>,
  rejectReason: (candidate: MonarchRouteCandidate) => string
): MonarchRouteTrace {
  return {
    version: '0.3',
    intentId: intent.id,
    originalText: normalizeText(intent.text),
    candidates,
    rejected: candidates.map((candidate) => ({
      targetModuleId: candidate.targetModuleId,
      capabilityId: candidate.capabilityId,
      reason: rejectReason(candidate),
    })),
    unresolvedReason,
    resolverReason,
  };
}

function candidateToDecision(candidate: MonarchRouteCandidate): MonarchRouteDecision {
  const decision: MonarchRouteDecision = {
    intentId: candidate.intentId,
    targetModuleId: candidate.targetModuleId,
    confidence: candidate.confidence,
    reason: candidate.reason,
    permissionMode: candidate.permissionMode,
  };

  if (candidate.capabilityId) {
    decision.capabilityId = candidate.capabilityId;
  }
  if (candidate.input !== undefined) {
    decision.input = candidate.input;
  }

  return decision;
}

function sortCandidates(candidates: MonarchRouteCandidate[]): MonarchRouteCandidate[] {
  return [...candidates].sort((left, right) => {
    const confidence = right.confidence - left.confidence;
    if (confidence !== 0) {
      return confidence;
    }

    const source = sourcePriority(right.source) - sourcePriority(left.source);
    if (source !== 0) {
      return source;
    }

    const moduleOrder = left.targetModuleId.localeCompare(right.targetModuleId);
    if (moduleOrder !== 0) {
      return moduleOrder;
    }

    return left.capabilityId.localeCompare(right.capabilityId);
  });
}

function findCapability(
  modules: MonarchModule[],
  moduleId: string,
  capabilityId: string
): MonarchCapability | undefined {
  const module = modules.find((entry) => entry.manifest.id === moduleId);
  return module?.manifest.capabilities.find((capability) => capability.id === capabilityId);
}

function routeCandidateKey(candidate: MonarchRouteCandidate): string {
  return `${candidate.targetModuleId}\u0000${candidate.capabilityId}`;
}

function sourcePriority(source: MonarchRouteCandidateSource): number {
  switch (source) {
  case 'module':
    return 6;
  case 'alias':
    return 5;
  case 'semantic':
    return 4;
  case 'keyword':
    return 3;
  case 'fallback':
    return 2;
  case 'llm':
    return 1;
  }
}

function formatConfidence(value: number): string {
  return value.toFixed(2);
}
