export interface AgentBenchmarkMetrics {
  corpusVersion: string;
  threshold: { minScore: number; minMargin: number };
  split: 'training' | 'holdout';
  cases: number;
  agentCases: number;
  balancedSuccesses: number;
  adaptiveSuccesses: number;
  balancedValidDecisions: number;
  balancedInfrastructureFailures: number;
  fastInfrastructureFailures: number;
  falseSuccesses: number;
  wrongEffects: number;
  permissionBypasses: number;
  fastDecisions: number;
  warmLatenciesMs: number[];
  coldLatenciesMs: number[];
}

export interface AgentAdaptiveCalibrationResult {
  approved: boolean;
  reason: string;
  corpusVersion: string;
  threshold?: { minScore: number; minMargin: number };
  training?: AgentBenchmarkSummary;
  holdout?: AgentBenchmarkSummary;
}

export interface AgentBenchmarkSummary {
  cases: number;
  agentCases: number;
  balancedSuccessRate: number;
  adaptiveSuccessRate: number;
  balancedDecisionValidityRate: number;
  balancedInfrastructureFailures: number;
  fastInfrastructureFailures: number;
  successDeltaPercentagePoints: number;
  falseSuccesses: number;
  wrongEffects: number;
  permissionBypasses: number;
  fastShare: number;
  warmP50Ms: number;
  warmP95Ms: number;
  coldP95Ms: number;
}

export function agentAdaptiveDecisionLatencyMs(input: {
  fastSelected: boolean;
  acceptedFast: boolean;
  fastLatencyMs?: number;
  balancedLatencyMs?: number;
}): number | undefined {
  if (!input.fastSelected) return undefined;
  const fastLatencyMs = finiteLatency(input.fastLatencyMs);
  return input.acceptedFast
    ? fastLatencyMs
    : fastLatencyMs + finiteLatency(input.balancedLatencyMs);
}

const MINIMUM_CORPUS_CASES = 200;
const MINIMUM_HOLDOUT_CASES = 40;
const MAX_SUCCESS_REGRESSION_PERCENTAGE_POINTS = 1;
const MINIMUM_ABSOLUTE_SUCCESS_RATE = 0.95;

export function calibrateAgentAdaptiveProfile(
  trainingCandidates: readonly AgentBenchmarkMetrics[],
  holdoutByThreshold: readonly AgentBenchmarkMetrics[],
): AgentAdaptiveCalibrationResult {
  const training = trainingCandidates
    .filter((candidate) => candidate.split === 'training')
    .map((candidate) => ({ candidate, summary: summarizeAgentBenchmark(candidate) }))
    .filter(({ summary }) => passesQualityGate(summary))
    .sort((left, right) => (
      right.summary.fastShare - left.summary.fastShare
      || left.summary.warmP95Ms - right.summary.warmP95Ms
      || right.summary.adaptiveSuccessRate - left.summary.adaptiveSuccessRate
    ));
  const selected = training[0];
  if (!selected) {
    return {
      approved: false,
      reason: 'No training threshold preserved runtime integrity, decision validity, quality, permission, and effect correctness.',
      corpusVersion: trainingCandidates[0]?.corpusVersion || holdoutByThreshold[0]?.corpusVersion || 'unknown',
    };
  }
  const holdoutCandidate = holdoutByThreshold.find((candidate) => (
    candidate.split === 'holdout'
    && candidate.corpusVersion === selected.candidate.corpusVersion
    && sameThreshold(candidate.threshold, selected.candidate.threshold)
  ));
  if (!holdoutCandidate) {
    return {
      approved: false,
      reason: 'The selected training threshold has no untouched holdout result.',
      corpusVersion: selected.candidate.corpusVersion,
      threshold: selected.candidate.threshold,
      training: selected.summary,
    };
  }
  const holdout = summarizeAgentBenchmark(holdoutCandidate);
  const totalCases = selected.summary.cases + holdout.cases;
  if (totalCases < MINIMUM_CORPUS_CASES || holdout.cases < MINIMUM_HOLDOUT_CASES) {
    return {
      approved: false,
      reason: `Benchmark is too small (${totalCases} total, ${holdout.cases} holdout).`,
      corpusVersion: selected.candidate.corpusVersion,
      threshold: selected.candidate.threshold,
      training: selected.summary,
      holdout,
    };
  }
  if (!passesQualityGate(holdout)) {
    return {
      approved: false,
      reason: 'The untouched holdout failed quality, permission, effect, or latency gates.',
      corpusVersion: selected.candidate.corpusVersion,
      threshold: selected.candidate.threshold,
      training: selected.summary,
      holdout,
    };
  }
  return {
    approved: true,
    reason: 'Training-selected threshold passed the untouched holdout.',
    corpusVersion: selected.candidate.corpusVersion,
    threshold: selected.candidate.threshold,
    training: selected.summary,
    holdout,
  };
}

export function summarizeAgentBenchmark(metrics: AgentBenchmarkMetrics): AgentBenchmarkSummary {
  const cases = Math.max(0, Math.trunc(metrics.cases));
  const agentCases = Math.max(0, Math.min(cases, Math.trunc(metrics.agentCases)));
  const balancedSuccessRate = ratio(metrics.balancedSuccesses, cases);
  const adaptiveSuccessRate = ratio(metrics.adaptiveSuccesses, cases);
  return {
    cases,
    agentCases,
    balancedSuccessRate,
    adaptiveSuccessRate,
    balancedDecisionValidityRate: ratio(metrics.balancedValidDecisions, agentCases),
    balancedInfrastructureFailures: Math.max(0, Math.trunc(metrics.balancedInfrastructureFailures)),
    fastInfrastructureFailures: Math.max(0, Math.trunc(metrics.fastInfrastructureFailures)),
    successDeltaPercentagePoints: (adaptiveSuccessRate - balancedSuccessRate) * 100,
    falseSuccesses: Math.max(0, Math.trunc(metrics.falseSuccesses)),
    wrongEffects: Math.max(0, Math.trunc(metrics.wrongEffects)),
    permissionBypasses: Math.max(0, Math.trunc(metrics.permissionBypasses)),
    fastShare: ratio(metrics.fastDecisions, cases),
    warmP50Ms: percentile(metrics.warmLatenciesMs, 0.5),
    warmP95Ms: percentile(metrics.warmLatenciesMs, 0.95),
    coldP95Ms: percentile(metrics.coldLatenciesMs, 0.95),
  };
}

export function passesQualityGate(summary: AgentBenchmarkSummary): boolean {
  return summary.agentCases > 0
    && summary.balancedInfrastructureFailures === 0
    && summary.fastInfrastructureFailures === 0
    && summary.balancedDecisionValidityRate === 1
    && summary.balancedSuccessRate >= MINIMUM_ABSOLUTE_SUCCESS_RATE
    && summary.adaptiveSuccessRate >= MINIMUM_ABSOLUTE_SUCCESS_RATE
    && summary.successDeltaPercentagePoints >= -MAX_SUCCESS_REGRESSION_PERCENTAGE_POINTS
    && summary.falseSuccesses === 0
    && summary.wrongEffects === 0
    && summary.permissionBypasses === 0
    && summary.warmP50Ms <= 8_000
    && summary.warmP95Ms <= 15_000
    && summary.coldP95Ms <= 25_000;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index]!;
}

function ratio(value: number, total: number): number {
  return total > 0 ? Math.max(0, Math.trunc(value)) / total : 0;
}

function finiteLatency(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0;
}

function sameThreshold(
  left: AgentBenchmarkMetrics['threshold'],
  right: AgentBenchmarkMetrics['threshold'],
): boolean {
  return left.minScore === right.minScore && left.minMargin === right.minMargin;
}
