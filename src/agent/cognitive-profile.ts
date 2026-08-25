import type { AgentDecisionModelPolicy, AgentCognitiveProfileV1 } from './types';
import { AGENT_COGNITIVE_PROFILE_SCHEMA_VERSION } from './types';

export function createAgentCognitiveProfile(
  policy: AgentDecisionModelPolicy | undefined,
  updatedAt: string,
): AgentCognitiveProfileV1 {
  if (policy?.requestedRole === 'qwen3.8-27b-pro') {
    return profile('full-local', 'balanced', 'full', 24, 48, 12, updatedAt);
  }
  if (policy) {
    return profile('small-local', 'fast', 'basic', 3, 10, 3, updatedAt);
  }
  return profile('adaptive-local', 'unknown', 'basic', 3, 10, 3, updatedAt);
}

export function updateAgentCognitiveProfile(
  current: AgentCognitiveProfileV1 | undefined,
  response: {
    decisionProfile?: 'balanced' | 'adaptive';
    finalTier?: 'fast' | 'balanced';
  },
  updatedAt: string,
): AgentCognitiveProfileV1 {
  const base = current || createAgentCognitiveProfile(undefined, updatedAt);
  const activeTier = response.finalTier || base.activeTier;
  const mode = response.decisionProfile === 'adaptive'
    ? activeTier === 'fast' ? 'small-local' : 'adaptive-local'
    : response.decisionProfile === 'balanced'
      ? 'full-local'
      : base.mode;
  return profile(
    mode,
    activeTier,
    activeTier === 'fast' ? 'basic' : 'full',
    activeTier === 'fast' ? 3 : 24,
    activeTier === 'fast' ? 10 : 48,
    activeTier === 'fast' ? 3 : 12,
    updatedAt,
  );
}

function profile(
  mode: AgentCognitiveProfileV1['mode'],
  activeTier: AgentCognitiveProfileV1['activeTier'],
  agentCapabilityClass: AgentCognitiveProfileV1['agentCapabilityClass'],
  maxDecisionSchemas: number,
  maxObservationFacts: number,
  maxPlanSteps: number,
  updatedAt: string,
): AgentCognitiveProfileV1 {
  return {
    schemaVersion: AGENT_COGNITIVE_PROFILE_SCHEMA_VERSION,
    mode,
    activeTier,
    maxDecisionSchemas,
    maxObservationFacts,
    agentCapabilityClass,
    planningAuthority: agentCapabilityClass === 'full' ? 'model-adaptive' : 'runtime-only',
    maxPlanSteps,
    runtimeDecomposition: true,
    runtimeRecovery: true,
    updatedAt,
  };
}
