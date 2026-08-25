import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMonarchRuntime } from '../src/bootstrap';
import {
  calibrateAgentAdaptiveProfile,
  agentAdaptiveDecisionLatencyMs,
  compileAgentContext,
  LocalAgentDecisionProvider,
  parseAgentDecision,
  resolveAgentCapabilities,
  selectAgentDecisionTier,
  type AgentBenchmarkMetrics,
  type AgentCapabilityCard,
  type AgentDecision,
  type AgentModelDecisionRequest,
} from '../src/agent';
import {
  classifyOscarRequestDisposition,
  type MonarchCapability,
} from '../src/core';
import { readModelCatalog } from '../src/modules/models/model-catalog';
import {
  completeWithModelRole,
  type MonarchModelCompletionResult,
} from '../src/modules/models/runtime-client';
import { OscarClient } from '../src/modules/oscar/client';
import {
  adaptiveAgentBenchmarkCorpus,
  ADAPTIVE_AGENT_BENCHMARK_CORPUS_VERSION,
  benchmarkDecisionPhase,
  benchmarkDecisionHasForbiddenActionInput,
  benchmarkPlanningDecisionIsSuccessful,
  type AgentBenchmarkCase,
} from '../tests/fixtures/agent/adaptive-benchmark-corpus';

interface DecisionJudgment {
  valid: boolean;
  successful: boolean;
  needsBalanced: boolean;
  falseSuccess: boolean;
  wrongEffect: boolean;
  permissionBypass: boolean;
  kind?: string;
  capabilityId?: string;
  error?: string;
}

interface BenchmarkCaseRun {
  id: string;
  split: AgentBenchmarkCase['split'];
  disposition: ReturnType<typeof classifyOscarRequestDisposition>['mode'];
  expectedDisposition: AgentBenchmarkCase['expectedDisposition'];
  topScore: number;
  scoreMargin: number;
  balancedLatencyMs: number;
  balancedOutputChars: number;
  balancedInputChars?: number;
  balancedQueueLatencyMs?: number;
  balancedLoadLatencyMs?: number;
  balancedGenerationLatencyMs?: number;
  balancedCandidateCapabilityIds?: string[];
  fastLatencyMs?: number;
  fastOutputChars?: number;
  fastInputChars?: number;
  fastQueueLatencyMs?: number;
  fastLoadLatencyMs?: number;
  fastGenerationLatencyMs?: number;
  fastCandidateCapabilityIds?: string[];
  balanced: DecisionJudgment;
  fast?: DecisionJudgment;
  balancedRuntimeStatus: TierRuntimeStatus;
  balancedRuntimeError?: string;
  balancedResolvedRole?: string;
  balancedResolvedModel?: string;
  balancedRawText?: string;
  fastRuntimeStatus: TierRuntimeStatus;
  fastRuntimeError?: string;
  fastResolvedRole?: string;
  fastResolvedModel?: string;
  fastRawText?: string;
  structurallyFastEligible: boolean;
  balancedAttempted: boolean;
  fastAttempted: boolean;
  coldFast: boolean;
}

type TierRuntimeStatus = 'not-run' | 'not-required' | 'exact' | 'degraded' | 'failed';

interface TierRuntimeSnapshot {
  status: TierRuntimeStatus;
  expectedRole: 'gemma4-fast' | 'gemma4-balanced';
  resolvedRole?: string;
  resolvedModel?: string;
  error?: string;
  latencyMs: number;
}

const BENCHMARK_RUNNER_VERSION = 'production-phase-candidate-telemetry-exact-tiers-v19';
const THRESHOLDS = [
  { minScore: 4, minMargin: 1 },
  { minScore: 6, minMargin: 2 },
  { minScore: 6, minMargin: 3 },
  { minScore: 8, minMargin: 3 },
  { minScore: 10, minMargin: 4 },
  { minScore: 12, minMargin: 6 },
] as const;

const args = new Set(process.argv.slice(2));
const limitArg = process.argv.find((entry) => entry.startsWith('--limit='));
const caseIdArgs = process.argv
  .filter((entry) => entry.startsWith('--case-id='))
  .map((entry) => entry.slice('--case-id='.length).trim())
  .filter(Boolean);
const limit = Math.max(
  0,
  Math.min(
    adaptiveAgentBenchmarkCorpus.length,
    Number.parseInt(limitArg?.slice('--limit='.length) || '0', 10) || adaptiveAgentBenchmarkCorpus.length,
  ),
);
const outputArg = process.argv.find((entry) => entry.startsWith('--output='));
const outputPath = path.resolve(
  outputArg?.slice('--output='.length)
    || path.join('artifacts', 'qa', 'agent-adaptive-benchmark.json'),
);
const quiet = args.has('--quiet');
const resume = args.has('--resume');
const stopAfterFast = args.has('--stop-after-fast');
const includeRawOutput = args.has('--include-raw-output');
const benchmarkOscarApiBase = String(
  process.env.MONARCH_AGENT_BENCHMARK_OSCAR_API_BASE
  || 'http://127.0.0.1:17861',
).trim();
process.env.OSCAR_API_BASE = benchmarkOscarApiBase;
process.env.OSCAR_AUTO_START = 'true';

const selectedCases = selectBenchmarkCases(caseIdArgs, limit);

const runtime = createMonarchRuntime({
  workspaceRoot: process.cwd(),
  enableLocalSystemRouter: false,
});
const capabilities = runtime.kernel.listCapabilities();
const permissionProfile = runtime.kernel.getPermissionProfile();
const catalog = await readModelCatalog(process.cwd());
const selectionDigest = createHash('sha256')
  .update(`${BENCHMARK_RUNNER_VERSION}\nraw=${includeRawOutput}\n${selectedCases.map((entry) => entry.id).join('\n')}`)
  .digest('hex');
const checkpoint = resume
  ? await readBenchmarkCheckpoint(outputPath, selectionDigest)
  : undefined;
const runs: BenchmarkCaseRun[] = checkpoint?.cases
  || selectedCases.map(createPendingCaseRun);
const runsById = new Map(runs.map((entry) => [entry.id, entry]));
assertCheckpointCoverage(runs, selectedCases);

if (!stopAfterFast) {
  const preflightCase = selectedCases.find((entry) => entry.expectedDisposition === 'agent');
  if (preflightCase) {
    await resetManagedBenchmarkBackend();
    const preflightInput = evaluateBenchmarkCase(preflightCase);
    const attempt = await runBalancedAttempt(preflightInput.request);
    const preflight = tierRuntimeSnapshot(
      attempt.completion,
      'gemma4-balanced',
      attempt.response?.latencyMs || attempt.completion?.totalLatencyMs || 0,
    );
    await resetManagedBenchmarkBackend();
    if (preflight.status !== 'exact') {
      await atomicWriteJson(outputPath, {
        schemaVersion: 2,
        runnerVersion: BENCHMARK_RUNNER_VERSION,
        status: 'invalid-environment',
        phase: 'balanced-preflight',
        corpusVersion: ADAPTIVE_AGENT_BENCHMARK_CORPUS_VERSION,
        generatedAt: new Date().toISOString(),
        casesRequested: selectedCases.length,
        casesCompleted: runs.filter((entry) => entry.fastAttempted && entry.balancedAttempted).length,
        fastCasesCompleted: countAttempted(runs, 'fast'),
        balancedCasesCompleted: countAttempted(runs, 'balanced'),
        completeCorpus: false,
        selectionDigest,
        benchmarkOscarApiBase,
        rawOutputIncluded: includeRawOutput,
        preflight,
        cases: runs,
      });
      process.stderr.write(
        `Balanced preflight failed closed (${preflight.error || preflight.status}). `
        + `Benchmark results would not be comparable.\n`,
      );
      process.exit(2);
    }
  }
}

for (const split of ['training', 'holdout'] as const) {
  const pending = selectedCases.filter((benchmarkCase) => {
    const run = runsById.get(benchmarkCase.id)!;
    return benchmarkCase.split === split && !run.fastAttempted;
  });
  if (pending.length === 0) continue;
  await resetManagedBenchmarkBackend();
  let firstFastAttemptInPhase = true;
  for (const benchmarkCase of pending) {
    const run = runsById.get(benchmarkCase.id)!;
    const evaluated = evaluateBenchmarkCase(benchmarkCase);
    let fastCompletion: MonarchModelCompletionResult | undefined;
    let fastResponse: Awaited<ReturnType<LocalAgentDecisionProvider['decide']>> | undefined;
    if (
      run.disposition === 'agent'
      && benchmarkCase.expectedDisposition === 'agent'
      && run.structurallyFastEligible
    ) {
      const fast = await runFastAttempt(evaluated.request);
      fastCompletion = fast.completion;
      fastResponse = fast.response;
      run.coldFast = firstFastAttemptInPhase;
      firstFastAttemptInPhase = false;
    }
    if (fastCompletion) {
      run.fastLatencyMs = fastCompletion.totalLatencyMs || fastResponse?.latencyMs || 0;
      run.fastOutputChars = fastCompletion.rawText?.length || fastResponse?.rawText?.length || 0;
      assignFiniteMetric(run, 'fastInputChars', fastResponse?.inputChars);
      assignFiniteMetric(run, 'fastQueueLatencyMs', fastResponse?.queueLatencyMs ?? fastCompletion.queueLatencyMs);
      assignFiniteMetric(run, 'fastLoadLatencyMs', fastResponse?.loadLatencyMs ?? fastCompletion.loadLatencyMs);
      assignFiniteMetric(run, 'fastGenerationLatencyMs', fastResponse?.generationLatencyMs ?? fastCompletion.generationLatencyMs);
      run.fastCandidateCapabilityIds = [...(fastResponse?.candidateCapabilityIds || [])];
      run.fast = judgeDecision(
        fastCompletion.rawText || '',
        evaluated.resolver.cards,
        benchmarkCase,
        'fast',
      );
      if (includeRawOutput && fastCompletion.rawText) {
        run.fastRawText = boundedBenchmarkRawOutput(fastCompletion.rawText);
      }
    }
    if (run.disposition === 'agent' && run.structurallyFastEligible) {
      assignTierRuntime(run, 'fast', fastCompletion, 'gemma4-fast');
    } else {
      run.fastRuntimeStatus = 'not-required';
    }
    run.fastAttempted = true;
    await writeRunningCheckpoint('fast', outputPath, selectionDigest, selectedCases.length, runs);
    if (!quiet) {
      process.stdout.write(
        `[fast ${countAttempted(runs, 'fast')}/${selectedCases.length}] ${benchmarkCase.id} `
        + `result=${run.fast ? (run.fast.successful ? 'ok' : 'fail') : 'n/a'} `
        + `latency=${run.fastLatencyMs || 0}ms${run.coldFast ? ' cold' : ''}\n`,
      );
    }
  }
}

await resetManagedBenchmarkBackend();

if (stopAfterFast) {
  process.stdout.write(`${JSON.stringify({
    outputPath,
    status: 'fast-phase-complete',
    cases: runs.length,
    fastCasesCompleted: countAttempted(runs, 'fast'),
  })}\n`);
  process.exit(0);
}

for (const split of ['training', 'holdout'] as const) {
  const pending = selectedCases.filter((benchmarkCase) => {
    const run = runsById.get(benchmarkCase.id)!;
    return benchmarkCase.split === split && !run.balancedAttempted;
  });
  if (pending.length === 0) continue;
  await resetManagedBenchmarkBackend();
  for (const benchmarkCase of pending) {
    const run = runsById.get(benchmarkCase.id)!;
    const evaluated = evaluateBenchmarkCase(benchmarkCase);
    if (run.disposition === 'agent') {
      const balanced = await runBalancedAttempt(evaluated.request);
      run.balancedLatencyMs = balanced.completion?.totalLatencyMs || balanced.response?.latencyMs || 0;
      run.balancedOutputChars = balanced.completion?.rawText?.length || balanced.response?.rawText?.length || 0;
      assignFiniteMetric(run, 'balancedInputChars', balanced.response?.inputChars);
      assignFiniteMetric(run, 'balancedQueueLatencyMs', balanced.response?.queueLatencyMs ?? balanced.completion?.queueLatencyMs);
      assignFiniteMetric(run, 'balancedLoadLatencyMs', balanced.response?.loadLatencyMs ?? balanced.completion?.loadLatencyMs);
      assignFiniteMetric(run, 'balancedGenerationLatencyMs', balanced.response?.generationLatencyMs ?? balanced.completion?.generationLatencyMs);
      run.balancedCandidateCapabilityIds = [...(balanced.response?.candidateCapabilityIds || [])];
      run.balanced = judgeDecision(
        balanced.response?.rawText || '',
        evaluated.resolver.cards,
        benchmarkCase,
        'balanced',
      );
      if (includeRawOutput && balanced.completion?.rawText) {
        run.balancedRawText = boundedBenchmarkRawOutput(balanced.completion.rawText);
      }
      assignTierRuntime(run, 'balanced', balanced.completion, 'gemma4-balanced');
    }
    run.balancedAttempted = true;
    await writeRunningCheckpoint('balanced', outputPath, selectionDigest, selectedCases.length, runs);
    if (!quiet) {
      process.stdout.write(
        `[balanced ${countAttempted(runs, 'balanced')}/${selectedCases.length}] ${benchmarkCase.id} `
        + `result=${run.balanced.successful ? 'ok' : 'fail'} `
        + `latency=${run.balancedLatencyMs}ms\n`,
      );
    }
  }
}

await resetManagedBenchmarkBackend();

const trainingCandidates = THRESHOLDS.map((threshold) => buildMetrics(
  runs.filter((entry) => entry.split === 'training'),
  threshold,
  'training',
));
const holdoutCandidates = THRESHOLDS.map((threshold) => buildMetrics(
  runs.filter((entry) => entry.split === 'holdout'),
  threshold,
  'holdout',
));
const calibration = calibrateAgentAdaptiveProfile(trainingCandidates, holdoutCandidates);
const payload = {
  schemaVersion: 2,
  runnerVersion: BENCHMARK_RUNNER_VERSION,
  status: 'complete',
  corpusVersion: ADAPTIVE_AGENT_BENCHMARK_CORPUS_VERSION,
  generatedAt: new Date().toISOString(),
  casesRequested: selectedCases.length,
  casesCompleted: runs.length,
  fastCasesCompleted: countAttempted(runs, 'fast'),
  balancedCasesCompleted: countAttempted(runs, 'balanced'),
  completeCorpus: selectedCases.length === adaptiveAgentBenchmarkCorpus.length,
  selectionDigest,
  benchmarkOscarApiBase,
  rawOutputIncluded: includeRawOutput,
  calibration,
  thresholds: THRESHOLDS.map((threshold, index) => ({
    threshold,
    training: trainingCandidates[index],
    holdout: holdoutCandidates[index],
  })),
  cases: runs,
};

await atomicWriteJson(outputPath, payload);
process.stdout.write(`${JSON.stringify({
  outputPath,
  cases: runs.length,
  completeCorpus: payload.completeCorpus,
  calibration,
})}\n`);

if (!payload.completeCorpus || !calibration.approved) {
  process.exitCode = 2;
}

function createPendingCaseRun(benchmarkCase: AgentBenchmarkCase): BenchmarkCaseRun {
  const evaluated = evaluateBenchmarkCase(benchmarkCase);
  if (
    benchmarkCase.expectedDisposition === 'agent'
    && benchmarkCase.balancedRequired
    && evaluated.structuralSelection.tier !== 'balanced'
  ) {
    throw new Error(
      `Benchmark case ${benchmarkCase.id} requires Balanced but structural routing selected Fast.`,
    );
  }
  return {
    id: benchmarkCase.id,
    split: benchmarkCase.split,
    disposition: evaluated.disposition.mode,
    expectedDisposition: benchmarkCase.expectedDisposition,
    topScore: evaluated.topScore,
    scoreMargin: evaluated.scoreMargin,
    balancedLatencyMs: 0,
    balancedOutputChars: 0,
    balanced: evaluated.disposition.mode === 'chat'
      ? dispositionJudgment(benchmarkCase, evaluated.disposition.mode)
      : {
          valid: false,
          successful: false,
          needsBalanced: false,
          falseSuccess: false,
          wrongEffect: false,
          permissionBypass: false,
          error: 'balanced-phase-not-run',
        },
    balancedRuntimeStatus: evaluated.disposition.mode === 'chat' ? 'not-required' : 'not-run',
    fastRuntimeStatus: evaluated.disposition.mode === 'chat' ? 'not-required' : 'not-run',
    structurallyFastEligible: evaluated.structuralSelection.tier === 'fast',
    balancedAttempted: evaluated.disposition.mode === 'chat',
    fastAttempted: false,
    coldFast: false,
  };
}

function selectBenchmarkCases(caseIds: readonly string[], selectedLimit: number): AgentBenchmarkCase[] {
  if (caseIds.length === 0) return adaptiveAgentBenchmarkCorpus.slice(0, selectedLimit);
  const unique = new Set(caseIds);
  if (unique.size !== caseIds.length) {
    throw new Error('Benchmark --case-id values must be unique.');
  }
  return caseIds.map((id) => {
    const benchmarkCase = adaptiveAgentBenchmarkCorpus.find((entry) => entry.id === id);
    if (!benchmarkCase) throw new Error(`Unknown benchmark case id: ${id}`);
    return benchmarkCase;
  });
}

function boundedBenchmarkRawOutput(value: string): string {
  // Raw output is opt-in and intended only for the synthetic benchmark corpus.
  return String(value || '').trim().slice(0, 4_000);
}

function evaluateBenchmarkCase(benchmarkCase: AgentBenchmarkCase) {
  const disposition = classifyOscarRequestDisposition(benchmarkCase.request);
  const resolver = resolveAgentCapabilities({
    goal: benchmarkCase.request,
    currentStep: 'Choose the next evidence-producing action.',
    recentObservationSummaries: benchmarkCase.untrustedObservation
      ? [`Untrusted observation preview: ${benchmarkCase.untrustedObservation}`]
      : [],
    source: 'desktop',
    capabilities,
    permissionProfile,
  });
  const request = createDecisionRequest(benchmarkCase, resolver.cards);
  const ranked = [...resolver.cards].sort((left, right) => right.score - left.score);
  const topScore = ranked[0]?.score ?? Number.NEGATIVE_INFINITY;
  const scoreMargin = ranked[0] && ranked[1]
    ? ranked[0].score - ranked[1].score
    : Number.POSITIVE_INFINITY;
  const structuralSelection = selectAgentDecisionTier(request, 'adaptive', {
    MONARCH_AGENT_FAST_MIN_SCORE: '-1000000',
    MONARCH_AGENT_FAST_MIN_MARGIN: '-1000000',
  });
  return {
    disposition,
    resolver,
    request,
    topScore,
    scoreMargin,
    structuralSelection,
  };
}

function assertCheckpointCoverage(
  runs: readonly BenchmarkCaseRun[],
  selected: readonly AgentBenchmarkCase[],
): void {
  const expectedIds = selected.map((entry) => entry.id);
  const actualIds = runs.map((entry) => entry.id);
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((id, index) => id !== expectedIds[index])
    || runs.some((entry) => (
      typeof entry.fastAttempted !== 'boolean'
      || typeof entry.balancedAttempted !== 'boolean'
      || typeof entry.coldFast !== 'boolean'
      || !isTierRuntimeStatus(entry.fastRuntimeStatus)
      || !isTierRuntimeStatus(entry.balancedRuntimeStatus)
    ))
  ) {
    throw new Error('Benchmark checkpoint does not match the selected corpus and runner schema.');
  }
}

async function writeRunningCheckpoint(
  phase: 'fast' | 'balanced',
  target: string,
  digest: string,
  casesRequested: number,
  cases: readonly BenchmarkCaseRun[],
): Promise<void> {
  await atomicWriteJson(target, {
    schemaVersion: 2,
    runnerVersion: BENCHMARK_RUNNER_VERSION,
    status: 'running',
    phase,
    corpusVersion: ADAPTIVE_AGENT_BENCHMARK_CORPUS_VERSION,
    generatedAt: new Date().toISOString(),
    casesRequested,
    casesCompleted: cases.filter((entry) => entry.fastAttempted && entry.balancedAttempted).length,
    fastCasesCompleted: countAttempted(cases, 'fast'),
    balancedCasesCompleted: countAttempted(cases, 'balanced'),
    completeCorpus: false,
    selectionDigest: digest,
    benchmarkOscarApiBase,
    rawOutputIncluded: includeRawOutput,
    cases,
  });
}

function countAttempted(
  runsToCount: readonly BenchmarkCaseRun[],
  tier: 'fast' | 'balanced',
): number {
  return runsToCount.filter((entry) => (
    tier === 'fast' ? entry.fastAttempted : entry.balancedAttempted
  )).length;
}

function assignFiniteMetric(
  run: BenchmarkCaseRun,
  key:
    | 'fastInputChars'
    | 'fastQueueLatencyMs'
    | 'fastLoadLatencyMs'
    | 'fastGenerationLatencyMs'
    | 'balancedInputChars'
    | 'balancedQueueLatencyMs'
    | 'balancedLoadLatencyMs'
    | 'balancedGenerationLatencyMs',
  value: number | undefined,
): void {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    Object.assign(run, { [key]: value });
  }
}

function assignTierRuntime(
  run: BenchmarkCaseRun,
  tier: 'fast' | 'balanced',
  completion: MonarchModelCompletionResult | undefined,
  expectedRole: 'gemma4-fast' | 'gemma4-balanced',
): void {
  const prefix = tier === 'fast' ? 'fast' : 'balanced';
  const snapshot = tierRuntimeSnapshot(completion, expectedRole, completion?.totalLatencyMs || 0);
  Object.assign(run, {
    [`${prefix}RuntimeStatus`]: snapshot.status,
    ...(!snapshot.error ? {} : { [`${prefix}RuntimeError`]: snapshot.error }),
    ...(!snapshot.resolvedRole ? {} : { [`${prefix}ResolvedRole`]: snapshot.resolvedRole }),
    ...(!snapshot.resolvedModel ? {} : { [`${prefix}ResolvedModel`]: snapshot.resolvedModel }),
  });
}

function tierRuntimeSnapshot(
  completion: MonarchModelCompletionResult | undefined,
  expectedRole: TierRuntimeSnapshot['expectedRole'],
  latencyMs: number,
): TierRuntimeSnapshot {
  const status: TierRuntimeStatus = !completion?.ok || !completion.rawText
    ? 'failed'
    : completion.role === expectedRole
      ? completion.degraded ? 'degraded' : 'exact'
      : 'degraded';
  return {
    status,
    expectedRole,
    ...(!completion?.role ? {} : { resolvedRole: completion.role }),
    ...(!completion?.model ? {} : { resolvedModel: completion.model.slice(0, 160) }),
    ...(!completion?.error ? {} : { error: completion.error.slice(0, 160) }),
    latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
  };
}

function isTierRuntimeStatus(value: unknown): value is TierRuntimeStatus {
  return value === 'not-run'
    || value === 'not-required'
    || value === 'exact'
    || value === 'degraded'
    || value === 'failed';
}

async function resetManagedBenchmarkBackend(): Promise<void> {
  await new OscarClient({
    apiBase: benchmarkOscarApiBase,
    autoStart: false,
    timeoutMs: 30_000,
    chatTimeoutMs: 90_000,
  }).shutdownManagedBackend();
}

function createDecisionRequest(
  benchmarkCase: AgentBenchmarkCase,
  cards: AgentCapabilityCard[],
): AgentModelDecisionRequest {
  const expectedOutputId = `expected_${benchmarkCase.id}`;
  const successCriterionId = `success_${benchmarkCase.id}`;
  const executionPhase = benchmarkDecisionPhase(benchmarkCase);
  const initialStep = {
    id: `benchmark_initial_step_${benchmarkCase.id}`,
    title: 'Choose the next evidence-producing action.',
    status: executionPhase === 'planning' ? 'ready' as const : 'skipped' as const,
    dependsOn: [] as string[],
    expectedEffects: [{ kind: 'other' as const, description: 'Make verified progress toward the task goal.' }],
    verification: [{ kind: 'other' as const, description: 'Record a factual observation with provenance.' }],
    attemptCount: 0,
    ...(executionPhase === 'execution' ? { completedAt: '2026-07-27T00:00:01.000Z' } : {}),
  };
  const executionStep = {
    id: `benchmark_step_${benchmarkCase.id}`,
    title: `Execute the exact requested operation: ${benchmarkCase.request}`,
    status: 'ready' as const,
    dependsOn: [] as string[],
    expectedEffects: [{ kind: 'other' as const, description: 'Produce the exact observable effect requested by the user.' }],
    verification: [{ kind: 'other' as const, description: 'Require capability-owned factual evidence for the exact effect.' }],
    attemptCount: 0,
  };
  return {
    taskId: `benchmark_${benchmarkCase.id}`,
    traceId: `benchmark_trace_${benchmarkCase.id}`,
    capabilities: cards,
    compiledContext: compileAgentContext({
      taskId: `benchmark_${benchmarkCase.id}`,
      taskRevision: 1,
      goal: {
        originalRequest: benchmarkCase.request,
        normalizedObjective: benchmarkCase.request,
        expectedOutputs: [{
          id: expectedOutputId,
          description: 'The requested observable effect exists.',
          required: true,
        }],
        constraints: [],
        successCriteria: [{
          id: successCriterionId,
          description: 'The result is verified through capability-owned evidence.',
          required: true,
        }],
      },
      plan: {
        id: `benchmark_plan_${benchmarkCase.id}`,
        revision: executionPhase === 'planning' ? 1 : 2,
        goalSummary: benchmarkCase.request,
        createdAt: '2026-07-27T00:00:00.000Z',
        steps: executionPhase === 'planning' ? [initialStep] : [initialStep, executionStep],
        ...(executionPhase === 'execution' ? { revisedAt: '2026-07-27T00:00:01.000Z' } : {}),
      },
      observations: benchmarkCase.untrustedObservation ? [{
        id: `untrusted_${benchmarkCase.id}`,
        actionAttemptId: `untrusted_action_${benchmarkCase.id}`,
        capabilityId: 'benchmark.untrusted.preview',
        status: 'success',
        summary: benchmarkCase.untrustedObservation,
        output: { preview: benchmarkCase.untrustedObservation },
        provenance: {
          source: 'tool-output',
          traceId: `benchmark_trace_${benchmarkCase.id}`,
        },
        observedAt: '2026-07-27T00:00:00.000Z',
      }] : [],
      messages: [{
        id: `benchmark_message_${benchmarkCase.id}`,
        role: 'user',
        kind: 'request',
        createdAt: '2026-07-27T00:00:00.000Z',
        content: benchmarkCase.request,
      }],
      artifacts: [],
      capabilities: cards,
      surface: { surface: 'desktop' },
      executionPhase,
    }),
  };
}

async function runBalancedAttempt(request: AgentModelDecisionRequest) {
  let completion: MonarchModelCompletionResult | undefined;
  const provider = new LocalAgentDecisionProvider({
    workspaceRoot: process.cwd(),
    profile: 'balanced',
    // A Balanced baseline must never contain a transparent Fast fallback.
    // Calibration compares tiers; allowing fallback here invalidates both the
    // quality delta and the latency measurements.
    fallbackRoles: [],
    catalogProvider: async () => catalog,
    completionProvider: async (activeCatalog, completionRequest, env) => {
      completion = await completeWithModelRole(activeCatalog, completionRequest, env);
      return completion;
    },
  });
  const response = await provider.decide(request);
  return { response, completion };
}

async function runFastAttempt(request: AgentModelDecisionRequest) {
  let completion: MonarchModelCompletionResult | undefined;
  const provider = new LocalAgentDecisionProvider({
    workspaceRoot: process.cwd(),
    profile: 'adaptive',
    env: {
      ...process.env,
      MONARCH_AGENT_FAST_MIN_SCORE: '-1000000',
      MONARCH_AGENT_FAST_MIN_MARGIN: '-1000000',
    },
    catalogProvider: async () => catalog,
    completionProvider: async (activeCatalog, completionRequest, env) => {
      if (completionRequest.role === 'gemma4-fast') {
        completion = await completeWithModelRole(activeCatalog, completionRequest, env);
        return completion;
      }
      return {
        ok: false,
        role: completionRequest.role,
        attemptedRoles: [completionRequest.role],
        adapter: 'benchmark-no-balanced-replay',
        error: 'benchmark-fast-attempt-ended',
        degraded: true,
        totalLatencyMs: 0,
      };
    },
  });
  const response = await provider.decide(request);
  return { response, completion };
}

function judgeDecision(
  rawText: string,
  cards: AgentCapabilityCard[],
  benchmarkCase: AgentBenchmarkCase,
  tier: 'fast' | 'balanced',
): DecisionJudgment {
  let decision: AgentDecision;
  try {
    decision = parseAgentDecision(rawText, {
      candidates: cards.map(capabilityCardToContract),
    });
  } catch (error) {
    return {
      valid: false,
      successful: false,
      needsBalanced: tier === 'fast',
      falseSuccess: false,
      wrongEffect: false,
      permissionBypass: false,
      error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
    };
  }

  const capabilityId = 'capabilityId' in decision ? decision.capabilityId : undefined;
  const forbiddenActionInput = benchmarkDecisionHasForbiddenActionInput(decision, benchmarkCase);
  const expected = capabilityId
    ? benchmarkCase.expectedCapabilityIds.includes(capabilityId)
    : false;
  const correctDeliberation = benchmarkPlanningDecisionIsSuccessful(
    benchmarkCase,
    decision.kind,
  );
  const successful = (expected && !forbiddenActionInput) || correctDeliberation;
  const selectedCard = capabilityId
    ? cards.find((entry) => entry.id === capabilityId)
    : undefined;
  const permissionBypass = tier === 'fast' && Boolean(
    selectedCard?.risk === 'delete'
    || selectedCard?.metadata.effectProfile.reversibility === 'irreversible'
    || selectedCard?.metadata.effectProfile.privilege === 'security-critical',
  );
  const requiresBalanced = tier === 'fast' && (
    ['ask-user', 'wait-runtime', 'revise-plan', 'fail'].includes(decision.kind)
    || permissionBypass
  );

  return {
    valid: true,
    successful,
    needsBalanced: requiresBalanced,
    falseSuccess: decision.kind === 'complete' && benchmarkCase.expectedCapabilityIds.length > 0,
    wrongEffect: Boolean(capabilityId && (!expected || forbiddenActionInput)),
    permissionBypass,
    kind: decision.kind,
    ...(capabilityId ? { capabilityId } : {}),
  };
}

function dispositionJudgment(
  benchmarkCase: AgentBenchmarkCase,
  actual: 'chat' | 'agent',
): DecisionJudgment {
  const successful = actual === benchmarkCase.expectedDisposition;
  return {
    valid: true,
    successful,
    needsBalanced: false,
    falseSuccess: false,
    wrongEffect: false,
    permissionBypass: false,
    kind: actual,
  };
}

function capabilityCardToContract(card: AgentCapabilityCard): MonarchCapability {
  const { source: _source, ...agent } = card.metadata;
  return {
    id: card.id,
    moduleId: card.moduleId,
    title: card.title,
    description: card.description,
    risk: card.risk,
    ...(card.inputSchema ? { inputSchema: card.inputSchema } : {}),
    ...(card.outputSchema ? { outputSchema: card.outputSchema } : {}),
    agent,
  };
}

function buildMetrics(
  splitRuns: BenchmarkCaseRun[],
  threshold: { minScore: number; minMargin: number },
  split: 'training' | 'holdout',
): AgentBenchmarkMetrics {
  let balancedSuccesses = 0;
  let adaptiveSuccesses = 0;
  let balancedValidDecisions = 0;
  let balancedInfrastructureFailures = 0;
  let fastInfrastructureFailures = 0;
  let falseSuccesses = 0;
  let wrongEffects = 0;
  let permissionBypasses = 0;
  let fastDecisions = 0;
  const warmLatenciesMs: number[] = [];
  const coldLatenciesMs: number[] = [];

  for (const run of splitRuns) {
    if (run.balanced.successful) balancedSuccesses += 1;
    if (run.disposition === 'agent' && run.balanced.valid) balancedValidDecisions += 1;
    if (
      run.disposition === 'agent'
      && run.balancedRuntimeStatus !== 'exact'
    ) {
      balancedInfrastructureFailures += 1;
    }
    const fastSelected = run.structurallyFastEligible
      && run.topScore >= threshold.minScore
      && run.scoreMargin >= threshold.minMargin
      && run.fast !== undefined;
    if (
      fastSelected
      && run.fastRuntimeStatus !== 'exact'
      && run.fastRuntimeStatus !== 'degraded'
    ) {
      fastInfrastructureFailures += 1;
    }
    const acceptedFast = fastSelected && !run.fast!.needsBalanced && run.fast!.valid;
    const selected = acceptedFast ? run.fast! : run.balanced;
    if (selected.successful) adaptiveSuccesses += 1;
    if (selected.falseSuccess) falseSuccesses += 1;
    if (selected.wrongEffect || (acceptedFast && run.fast && run.expectedDisposition === 'agent' && !run.fast.successful)) {
      wrongEffects += 1;
    }
    if (selected.permissionBypass) permissionBypasses += 1;
    const latency = agentAdaptiveDecisionLatencyMs({
      fastSelected,
      acceptedFast,
      fastLatencyMs: run.fastLatencyMs,
      balancedLatencyMs: run.balancedLatencyMs,
    });
    if (latency !== undefined) {
      if (run.coldFast) coldLatenciesMs.push(latency);
      else warmLatenciesMs.push(latency);
    }
    if (acceptedFast) fastDecisions += 1;
  }

  return {
    corpusVersion: ADAPTIVE_AGENT_BENCHMARK_CORPUS_VERSION,
    threshold,
    split,
    cases: splitRuns.length,
    agentCases: splitRuns.filter((run) => run.disposition === 'agent').length,
    balancedSuccesses,
    adaptiveSuccesses,
    balancedValidDecisions,
    balancedInfrastructureFailures,
    fastInfrastructureFailures,
    falseSuccesses,
    wrongEffects,
    permissionBypasses,
    fastDecisions,
    warmLatenciesMs,
    coldLatenciesMs: coldLatenciesMs.length ? coldLatenciesMs : warmLatenciesMs.slice(0, 1),
  };
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const contender = `${target}.${process.pid}.tmp`;
  await writeFile(contender, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(contender, target);
}

async function readBenchmarkCheckpoint(
  target: string,
  expectedSelectionDigest: string,
): Promise<{ cases: BenchmarkCaseRun[] } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(target, 'utf8')) as {
      runnerVersion?: unknown;
      corpusVersion?: unknown;
      selectionDigest?: unknown;
      cases?: unknown;
    };
    if (
      parsed.runnerVersion !== BENCHMARK_RUNNER_VERSION
      || parsed.corpusVersion !== ADAPTIVE_AGENT_BENCHMARK_CORPUS_VERSION
      || parsed.selectionDigest !== expectedSelectionDigest
      || !Array.isArray(parsed.cases)
    ) {
      return undefined;
    }
    return {
      cases: parsed.cases as BenchmarkCaseRun[],
    };
  } catch {
    return undefined;
  }
}
