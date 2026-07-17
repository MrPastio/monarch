import type {
  MonarchCapability,
  MonarchIntent,
  MonarchModule,
  MonarchRouteCandidate,
  MonarchRouteCandidateSource,
  MonarchRouteDecision,
} from './contracts';
import { findMissingRequiredInput, permissionModeForRisk } from './router-policy';
import { clampConfidence, normalizeText } from './utils';

const FALLBACK_CONFIDENCE_CAP = 0.64;
const MIN_REASONABLE_FALLBACK_CONFIDENCE = 0.24;

export interface MonarchCapabilityRoutingScore {
  confidence: number;
  reason: string;
  source: MonarchRouteCandidateSource;
  scoreParts: Record<string, number>;
}

export function decisionToRouteCandidate(
  intent: MonarchIntent,
  decision: MonarchRouteDecision,
  modules: MonarchModule[]
): MonarchRouteCandidate {
  const normalizedDecision = normalizeDecision(decision);
  const capability = findCapability(
    modules,
    normalizedDecision.targetModuleId,
    normalizedDecision.capabilityId || ''
  );
  const support = capability
    ? scoreCapabilityForIntent(intent.text, findModule(modules, capability.moduleId), capability)
    : undefined;
  const manifestSupport = support?.confidence || 0;
  const confidence = normalizedDecision.confidence;
  const missingInput = findMissingRequiredInput(capability, normalizedDecision.input);
  const candidate: MonarchRouteCandidate = {
    intentId: normalizedDecision.intentId,
    targetModuleId: normalizedDecision.targetModuleId,
    capabilityId: normalizedDecision.capabilityId || '',
    confidence: clampConfidence(confidence),
    reason: normalizedDecision.reason,
    source: 'module',
    permissionMode: normalizedDecision.permissionMode,
    scoreParts: {
      moduleConfidence: normalizedDecision.confidence,
      manifestSupport,
    },
  };

  if (normalizedDecision.input !== undefined) {
    candidate.input = normalizedDecision.input;
  }
  if (missingInput.length > 0) {
    candidate.missingInput = missingInput;
  }

  return candidate;
}

export function createFallbackCandidates(
  intent: MonarchIntent,
  modules: MonarchModule[]
): MonarchRouteCandidate[] {
  const candidates: MonarchRouteCandidate[] = [];

  for (const module of modules) {
    for (const capability of module.manifest.capabilities) {
      const score = scoreCapabilityForIntent(intent.text, module, capability);
      if (score.confidence < MIN_REASONABLE_FALLBACK_CONFIDENCE) {
        continue;
      }

      const input = createDefaultInput(capability);
      const missingInput = findMissingRequiredInput(capability, input);
      const candidate: MonarchRouteCandidate = {
        intentId: intent.id,
        targetModuleId: module.manifest.id,
        capabilityId: capability.id,
        confidence: score.confidence,
        reason: score.reason,
        source: score.source,
        permissionMode: permissionModeForRisk(capability.risk),
        scoreParts: score.scoreParts,
      };

      if (input !== undefined) {
        candidate.input = input;
      }
      if (missingInput.length > 0) {
        candidate.missingInput = missingInput;
      }

      candidates.push(candidate);
    }
  }

  return candidates;
}

export function mergeRouteCandidates(
  candidates: MonarchRouteCandidate[]
): MonarchRouteCandidate[] {
  const merged = new Map<string, MonarchRouteCandidate>();

  for (const candidate of candidates) {
    const key = routeCandidateKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, cloneCandidate(candidate));
      continue;
    }
    merged.set(key, mergeCandidatePair(existing, candidate));
  }

  return Array.from(merged.values());
}

export function scoreCapabilityForIntent(
  text: string,
  module: MonarchModule | undefined,
  capability: MonarchCapability
): MonarchCapabilityRoutingScore {
  const normalizedText = normalizeText(text).toLowerCase();
  const intentTerms = new Set(tokenize(normalizedText));
  if (!normalizedText) {
    return emptyScore();
  }

  const routing = capability.routing || {};
  const alias = exactPhraseScore(routing.aliases || [], normalizedText, 0.42);
  const keyword = weightedTermScore(routing.keywords || [], normalizedText, intentTerms, 0.32, 0.14);
  const examples = weightedTermScore(routing.examples || [], normalizedText, intentTerms, 0.2, 0.1);
  const intentKind = weightedTermScore(routing.intentKinds || [], normalizedText, intentTerms, 0.14, 0.1);
  const capabilityMatch = weightedTermScore(
    [capability.id, capability.title],
    normalizedText,
    intentTerms,
    0.24,
    0.12
  );
  const moduleDomain = module
    ? weightedTermScore(
      [module.manifest.id, module.manifest.name, ...module.manifest.owns],
      normalizedText,
      intentTerms,
      0.18,
      0.1
    )
    : 0;
  const description = weightedTermScore(
    [capability.description || ''],
    normalizedText,
    intentTerms,
    0.1,
    0.04
  );
  const rawConfidence = alias
    + keyword
    + examples
    + intentKind
    + capabilityMatch
    + moduleDomain
    + description;
  const confidence = clampConfidence(Math.min(FALLBACK_CONFIDENCE_CAP, rawConfidence));
  const scoreParts = {
    alias,
    keyword,
    examples,
    intentKind,
    capability: capabilityMatch,
    moduleDomain,
    description,
  };

  return {
    confidence,
    reason: describeScore(scoreParts),
    source: classifyScoreSource(scoreParts),
    scoreParts,
  };
}

function normalizeDecision(decision: MonarchRouteDecision): MonarchRouteDecision {
  const normalized: MonarchRouteDecision = {
    intentId: decision.intentId,
    targetModuleId: decision.targetModuleId,
    confidence: clampConfidence(decision.confidence),
    reason: String(decision.reason || 'Module route decision.').trim(),
    permissionMode: decision.permissionMode,
  };

  if (decision.capabilityId) {
    normalized.capabilityId = decision.capabilityId;
  }
  if (decision.input !== undefined) {
    normalized.input = decision.input;
  }

  return normalized;
}

function findModule(
  modules: MonarchModule[],
  moduleId: string
): MonarchModule | undefined {
  return modules.find((module) => module.manifest.id === moduleId);
}

function findCapability(
  modules: MonarchModule[],
  moduleId: string,
  capabilityId: string
): MonarchCapability | undefined {
  const module = findModule(modules, moduleId);
  return module?.manifest.capabilities.find((capability) => capability.id === capabilityId);
}

function createDefaultInput(capability: MonarchCapability): unknown {
  if (
    capability.inputSchema?.type === 'object'
    || capability.inputSchema?.properties
    || capability.inputSchema?.required
  ) {
    return {};
  }
  return undefined;
}

function exactPhraseScore(
  phrases: string[],
  normalizedText: string,
  weight: number
): number {
  return phrases.some((phrase) => {
    const normalizedPhrase = normalizeText(phrase).toLowerCase();
    return normalizedPhrase.length >= 3 && normalizedText.includes(normalizedPhrase);
  })
    ? weight
    : 0;
}

function weightedTermScore(
  values: string[],
  normalizedText: string,
  intentTerms: Set<string>,
  maxWeight: number,
  perMatch: number
): number {
  const matches = new Set<string>();

  for (const value of values) {
    const normalizedValue = normalizeText(value).toLowerCase();
    if (normalizedValue.length < 3) {
      continue;
    }
    if (normalizedText.includes(normalizedValue)) {
      matches.add(normalizedValue);
      continue;
    }

    for (const term of tokenize(normalizedValue)) {
      if (term.length >= 3 && intentTerms.has(term)) {
        matches.add(term);
      }
    }
  }

  return Math.min(maxWeight, matches.size * perMatch);
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .toLowerCase()
    .split(/[\s.,:;!?()[\]{}"'`~|/\\_-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function describeScore(scoreParts: Record<string, number>): string {
  const reasons = Object.entries(scoreParts)
    .filter(([, value]) => value > 0)
    .map(([key]) => key);

  return reasons.length > 0
    ? `Fallback routing metadata match: ${reasons.join(', ')}.`
    : 'Fallback routing metadata match.';
}

function classifyScoreSource(
  scoreParts: Record<string, number>
): MonarchRouteCandidateSource {
  if ((scoreParts.alias || 0) > 0) {
    return 'alias';
  }
  if ((scoreParts.keyword || 0) > 0 || (scoreParts.intentKind || 0) > 0) {
    return 'keyword';
  }
  if ((scoreParts.examples || 0) > 0) {
    return 'semantic';
  }
  return 'fallback';
}

function emptyScore(): MonarchCapabilityRoutingScore {
  return {
    confidence: 0,
    reason: 'No routing metadata matched.',
    source: 'fallback',
    scoreParts: {},
  };
}

function routeCandidateKey(candidate: MonarchRouteCandidate): string {
  return `${candidate.targetModuleId}\u0000${candidate.capabilityId}`;
}

function mergeCandidatePair(
  left: MonarchRouteCandidate,
  right: MonarchRouteCandidate
): MonarchRouteCandidate {
  const preferred = sourcePriority(right.source) > sourcePriority(left.source) ? right : left;
  const other = preferred === right ? left : right;
  const candidate: MonarchRouteCandidate = {
    intentId: preferred.intentId,
    targetModuleId: preferred.targetModuleId,
    capabilityId: preferred.capabilityId,
    confidence: Math.max(left.confidence, right.confidence),
    reason: mergeReasons(preferred.reason, other.reason),
    source: preferred.source,
    permissionMode: preferred.permissionMode,
    scoreParts: {
      ...(left.scoreParts || {}),
      ...(right.scoreParts || {}),
      [`${left.source}Confidence`]: left.confidence,
      [`${right.source}Confidence`]: right.confidence,
    },
  };
  const argumentCandidate = selectArgumentCandidate(preferred, other);
  const input = argumentCandidate.input;
  const missingInput = argumentCandidate.missingInput || [];

  if (input !== undefined) {
    candidate.input = input;
  }
  if (missingInput.length > 0) {
    candidate.missingInput = uniqueStrings(missingInput);
  }

  return candidate;
}

function selectArgumentCandidate(
  preferred: MonarchRouteCandidate,
  other: MonarchRouteCandidate
): MonarchRouteCandidate {
  const preferredMissing = preferred.missingInput?.length || 0;
  const otherMissing = other.missingInput?.length || 0;
  if (preferredMissing !== otherMissing) {
    return preferredMissing < otherMissing ? preferred : other;
  }
  if (preferred.input === undefined && other.input !== undefined) {
    return other;
  }
  return preferred;
}

function cloneCandidate(candidate: MonarchRouteCandidate): MonarchRouteCandidate {
  const clone: MonarchRouteCandidate = {
    ...candidate,
  };

  if (candidate.missingInput) {
    clone.missingInput = [...candidate.missingInput];
  }
  if (candidate.scoreParts) {
    clone.scoreParts = { ...candidate.scoreParts };
  }

  return clone;
}

function mergeReasons(primary: string, secondary: string): string {
  if (primary === secondary) {
    return primary;
  }
  return `${primary} Additional routing evidence: ${secondary}`;
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
