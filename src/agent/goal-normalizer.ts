import { createMonarchId } from '../core/utils';
import type {
  AgentExpectedOutput,
  AgentGoal,
  AgentGoalConstraint,
  AgentSuccessCriterion,
} from './types';

export interface NormalizeAgentGoalInput {
  request: string;
  normalizedObjective?: string;
  expectedOutputs?: Array<Partial<AgentExpectedOutput> & { description: string }>;
  constraints?: Array<Partial<AgentGoalConstraint> & { description: string }>;
  successCriteria?: Array<Partial<AgentSuccessCriterion> & { description: string }>;
  userPreferences?: string[];
}

export function normalizeAgentGoal(input: NormalizeAgentGoalInput): AgentGoal {
  const originalRequest = boundedRequiredText(input.request, 'request', 16_000);
  const normalizedObjective = boundedRequiredText(
    input.normalizedObjective || normalizeWhitespace(originalRequest),
    'normalized objective',
    8_000,
  );
  const expectedOutputs = normalizeExpectedOutputs(input.expectedOutputs, normalizedObjective);
  const constraints = normalizeConstraints(input.constraints);
  const successCriteria = normalizeCriteria(input.successCriteria, expectedOutputs);
  const userPreferences = uniqueStrings(input.userPreferences, 32, 1_000);

  return {
    originalRequest,
    normalizedObjective,
    expectedOutputs,
    constraints,
    successCriteria,
    ...(userPreferences.length > 0 ? { userPreferences } : {}),
  };
}

function normalizeExpectedOutputs(
  values: NormalizeAgentGoalInput['expectedOutputs'],
  normalizedObjective: string,
): AgentExpectedOutput[] {
  const normalized = (values || []).slice(0, 32).map((value, index) => ({
    id: normalizeId(value.id, `output_${index + 1}`),
    description: boundedRequiredText(value.description, `expected output ${index + 1}`, 2_000),
    kind: normalizeOutputKind(value.kind),
    required: value.required !== false,
  }));
  return normalized.length > 0 ? normalized : [{
    id: 'verified_outcome',
    description: boundedRequiredText(
      `Produce a verified outcome for: ${normalizedObjective}`,
      'default expected output',
      2_000,
    ),
    kind: 'answer',
    required: true,
  }];
}

function normalizeConstraints(values: NormalizeAgentGoalInput['constraints']): AgentGoalConstraint[] {
  return (values || []).slice(0, 32).map((value, index) => ({
    id: normalizeId(value.id, `constraint_${index + 1}`),
    description: boundedRequiredText(value.description, `constraint ${index + 1}`, 2_000),
    kind: normalizeConstraintKind(value.kind),
  }));
}

function normalizeCriteria(
  values: NormalizeAgentGoalInput['successCriteria'],
  outputs: AgentExpectedOutput[],
): AgentSuccessCriterion[] {
  const normalized = (values || []).slice(0, 32).map((value, index) => ({
    id: normalizeId(value.id, `criterion_${index + 1}`),
    description: boundedRequiredText(value.description, `success criterion ${index + 1}`, 2_000),
    ...(value.verificationHint
      ? { verificationHint: boundedRequiredText(value.verificationHint, 'verification hint', 2_000) }
      : {}),
  }));
  return normalized.length > 0 ? normalized : [{
    id: 'required_outputs_verified',
    description: `All ${outputs.filter((entry) => entry.required !== false).length} required outputs have durable evidence.`,
    verificationHint: 'Use deterministic tool receipts, predicates, schemas, or external receipts.',
  }];
}

function normalizeOutputKind(value: AgentExpectedOutput['kind'] | undefined): NonNullable<AgentExpectedOutput['kind']> {
  return value === 'artifact' || value === 'state-change' || value === 'verification' || value === 'other'
    ? value
    : 'answer';
}

function normalizeConstraintKind(value: AgentGoalConstraint['kind'] | undefined): NonNullable<AgentGoalConstraint['kind']> {
  return value === 'safety' || value === 'permission' || value === 'scope' || value === 'format' || value === 'resource'
    ? value
    : 'other';
}

function normalizeId(value: string | undefined, fallback: string): string {
  const normalized = String(value || fallback).trim().replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 200);
  return normalized || createMonarchId(fallback);
}

function uniqueStrings(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  return [...new Set((values || [])
    .map((value) => normalizeWhitespace(String(value || '')).slice(0, maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

function boundedRequiredText(value: string, label: string, maxChars: number): string {
  const normalized = normalizeWhitespace(String(value || '')).slice(0, maxChars);
  if (!normalized) throw new Error(`Agent goal ${label} is required.`);
  return normalized;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
