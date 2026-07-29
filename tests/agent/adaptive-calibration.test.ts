import { describe, expect, it } from 'vitest';
import {
  agentAdaptiveDecisionLatencyMs,
  calibrateAgentAdaptiveProfile,
  passesQualityGate,
  summarizeAgentBenchmark,
  type AgentBenchmarkMetrics,
} from '../../src/agent/adaptive-calibration';

describe('Adaptive Agent calibration release gate', () => {
  it('charges a Fast failure and its Balanced recheck to end-to-end adaptive latency', () => {
    expect(agentAdaptiveDecisionLatencyMs({
      fastSelected: true,
      acceptedFast: false,
      fastLatencyMs: 9_000,
      balancedLatencyMs: 31_000,
    })).toBe(40_000);
    expect(agentAdaptiveDecisionLatencyMs({
      fastSelected: true,
      acceptedFast: true,
      fastLatencyMs: 7_500,
      balancedLatencyMs: 31_000,
    })).toBe(7_500);
    expect(agentAdaptiveDecisionLatencyMs({
      fastSelected: false,
      acceptedFast: false,
      fastLatencyMs: 9_000,
      balancedLatencyMs: 31_000,
    })).toBeUndefined();
  });

  it('selects on training only and approves the same threshold only after blind holdout parity', () => {
    const safe = metrics('training', { minScore: 6, minMargin: 3 }, 160, {
      balancedSuccesses: 154,
      adaptiveSuccesses: 153,
      fastDecisions: 112,
    });
    const slower = metrics('training', { minScore: 8, minMargin: 4 }, 160, {
      balancedSuccesses: 154,
      adaptiveSuccesses: 154,
      fastDecisions: 70,
    });
    const holdout = metrics('holdout', safe.threshold, 60, {
      balancedSuccesses: 58,
      adaptiveSuccesses: 58,
      fastDecisions: 39,
    });

    const calibrated = calibrateAgentAdaptiveProfile([slower, safe], [holdout]);

    expect(calibrated).toMatchObject({
      approved: true,
      threshold: { minScore: 6, minMargin: 3 },
    });
    expect(calibrated.training?.successDeltaPercentagePoints).toBeCloseTo(-0.625);
  });

  it('fails closed for one wrong effect, permission bypass, false success, or quality loss over one point', () => {
    for (const regression of [
      { wrongEffects: 1 },
      { permissionBypasses: 1 },
      { falseSuccesses: 1 },
      { adaptiveSuccesses: 151 },
    ]) {
      const candidate = metrics('training', { minScore: 6, minMargin: 3 }, 160, {
        balancedSuccesses: 154,
        adaptiveSuccesses: 154,
        fastDecisions: 120,
        ...regression,
      });
      const result = calibrateAgentAdaptiveProfile([candidate], []);
      expect(result.approved).toBe(false);
    }
  });

  it('enforces the warm and cold latency targets', () => {
    const summary = summarizeAgentBenchmark(metrics('holdout', { minScore: 6, minMargin: 3 }, 60, {
      balancedSuccesses: 58,
      adaptiveSuccesses: 58,
      fastDecisions: 40,
      warmLatenciesMs: [...Array(57).fill(7_500), ...Array(3).fill(14_500)],
      coldLatenciesMs: Array(10).fill(24_000),
    }));
    expect(passesQualityGate(summary)).toBe(true);
    expect(passesQualityGate({ ...summary, warmP95Ms: 15_001 })).toBe(false);
    expect(passesQualityGate({ ...summary, coldP95Ms: 25_001 })).toBe(false);
  });
});

function metrics(
  split: AgentBenchmarkMetrics['split'],
  threshold: AgentBenchmarkMetrics['threshold'],
  cases: number,
  overrides: Partial<AgentBenchmarkMetrics>,
): AgentBenchmarkMetrics {
  return {
    corpusVersion: 'agent-adaptive-2026-07-27.v1',
    threshold,
    split,
    cases,
    balancedSuccesses: cases,
    adaptiveSuccesses: cases,
    falseSuccesses: 0,
    wrongEffects: 0,
    permissionBypasses: 0,
    fastDecisions: 0,
    warmLatenciesMs: Array(Math.max(1, cases)).fill(7_000),
    coldLatenciesMs: Array(Math.max(1, Math.ceil(cases / 10))).fill(20_000),
    ...overrides,
  };
}
