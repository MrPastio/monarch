import { classifyIntentText, classifyOscarRequestDisposition } from '../core/intent-classifier';
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

export type AgentOperationalGoalKind = 'artifact' | 'state-change' | 'verification';

export interface AgentBlockingInput {
  kind: 'exact-content';
  question: string;
  reason: string;
}

export function inferAgentBlockingInput(requestText: string): AgentBlockingInput | null {
  const request = String(requestText || '').replace(/\s+/gu, ' ').trim();
  if (!request || !hasExplicitMutationVerb(request)) return null;
  const explicitlyMissingContent = [
    /(?:текст|содержан\p{L}*|данн\p{L}*).{0,96}не\s+(?:указан\p{L}*|указал\p{L}*|предоставлен\p{L}*|предоставил\p{L}*|задан\p{L}*|задал\p{L}*|известен\p{L}*)/iu,
    /не\s+(?:указан\p{L}*|указал\p{L}*|предоставлен\p{L}*|предоставил\p{L}*|задан\p{L}*|задал\p{L}*).{0,96}(?:текст|содержан\p{L}*|данн\p{L}*)/iu,
    /\b(?:text|content|body|payload)\b.{0,96}\b(?:was\s+|is\s+|were\s+|are\s+)?not\s+(?:specified|provided|given|included)\b/iu,
    /\b(?:without|haven't|have\s+not|didn't|did\s+not)\b.{0,96}\b(?:specify|provide|give|include|text|content|body|payload)\b/iu,
  ].some((pattern) => pattern.test(request));
  if (!explicitlyMissingContent) return null;
  return {
    kind: 'exact-content',
    question: 'Какой точный текст или содержимое нужно записать?',
    reason: 'The request explicitly says the mutation content is missing, so it cannot be recovered by observation or invented by the model.',
  };
}

export function inferOperationalGoalKind(requestText: string): AgentOperationalGoalKind {
  const classification = classifyIntentText(requestText);
  const disposition = classifyOscarRequestDisposition(requestText);
  const executableMutation = hasExplicitMutationVerb(requestText);
  if ((classification.kind === 'file_generation' || disposition.kind === 'file_generation') && executableMutation) {
    return 'artifact';
  }
  const mutationRequested = executableMutation && (classification.kind === 'system_action'
    || ['create', 'write', 'edit', 'delete', 'move', 'rename'].includes(classification.fileOperation)
    || (classification.kind === 'tool_use'
      && classification.riskHint !== 'none'
      && classification.riskHint !== 'read')
    || (disposition.mode === 'agent' && disposition.kind === 'system_action')
    || (disposition.mode === 'agent' && disposition.kind === 'tool_use')
    || (disposition.mode === 'agent' && disposition.kind === 'file_operation')
    || hasExplicitOperationalTarget(requestText));
  return mutationRequested ? 'state-change' : 'verification';
}

function hasExplicitOperationalTarget(value: string): boolean {
  return /\b(?:file|folder|directory|document|path|screenshot|screen|window|application|app|browser|volume|brightness|telegram)\b|(?:файл|папк|каталог|документ|путь|скриншот|экран|окно|приложен|браузер|громкост|яркост|телеграм)/iu.test(value)
    || /(?:^|[\s"'`])(?:[a-z]:[\\/]|\.{0,2}[\\/]|[^\s"'`\\/]+\.[\p{L}\p{N}]{1,12})(?=$|[\s,;:!?])/iu.test(value);
}

function hasExplicitMutationVerb(value: string): boolean {
  const mutationVerb = mutationVerbPattern();
  for (const match of value.matchAll(mutationVerb)) {
    const clauseStart = mutationClauseStart(value, match.index);
    const prefix = value.slice(clauseStart, match.index).trim();
    if (/\b(?:do\s+not|don't|never|without|avoid)\b|(?:^|[\s,:;.!?])(?:не|никогда|нельзя)(?=$|[\s,:;.!?])|не\s+надо/iu.test(prefix)) {
      continue;
    }
    if (/\b(?:explain|describe|discuss|show\s+how|tell\s+me\s+how|how\s+to|what\s+if)\b|(?:^|[\s,:;.!?])(?:объясни|опиши|расскажи|покажи\s+как|как)(?=$|[\s,:;.!?])/iu.test(prefix)) {
      continue;
    }
    return true;
  }
  return false;
}

function mutationClauseStart(value: string, end: number): number {
  let clauseStart = 0;
  const sentenceBoundary = /[;!?\n]|\.(?=\s|$)/gu;
  for (const match of value.slice(0, end).matchAll(sentenceBoundary)) {
    clauseStart = (match.index || 0) + match[0].length;
  }
  return clauseStart;
}

export function isNonExecutingMutationDiscussion(value: string): boolean {
  return mutationVerbPattern().test(value) && !hasExplicitMutationVerb(value);
}

function mutationVerbPattern(): RegExp {
  return /(?:^|[^\p{L}])(?:create|write|append|replace|save|delete|remove|move|rename|open|launch|start|stop|close|set|install|run|execute|update|edit|change|take|make|создай|создать|создавай|запиши|записать|записывай|допиши|дописать|дописывай|замени|заменить|заменяй|сохрани|сохранить|сохраняй|удали|удалить|удаляй|убери|убрать|убирай|перемести|переместить|перемещай|переименуй|переименовать|переименовывай|открой|открыть|открывай|запусти|запустить|запускай|останови|остановить|останавливай|закрой|закрыть|закрывай|поставь|поставить|установи|установить|устанавливай|выполни|выполнить|выполняй|обнови|обновить|обновляй|измени|изменить|изменяй|редактируй|отредактируй|сделай|сделать)(?=[^\p{L}]|$)/giu;
}

export function normalizeAgentGoal(input: NormalizeAgentGoalInput): AgentGoal {
  const originalRequest = boundedRequiredText(input.request, 'request', 16_000);
  const normalizedObjective = boundedRequiredText(
    input.normalizedObjective || normalizeWhitespace(originalRequest),
    'normalized objective',
    8_000,
  );
  const operationalKind = inferOperationalGoalKind(originalRequest);
  const expectedOutputs = ensureOperationalEffectOutput(
    normalizeExpectedOutputs(input.expectedOutputs, normalizedObjective, operationalKind),
    originalRequest,
    operationalKind,
  );
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

function ensureOperationalEffectOutput(
  outputs: AgentExpectedOutput[],
  originalRequest: string,
  effectKind: AgentOperationalGoalKind,
): AgentExpectedOutput[] {
  if (effectKind === 'verification') return outputs;
  if (outputs.some((output) => (
    output.required !== false && (output.kind === 'artifact' || output.kind === 'state-change')
  ))) return outputs;
  return [...outputs, {
    id: effectKind === 'artifact' ? 'requested_artifact_effect' : 'requested_state_change_effect',
    description: effectKind === 'artifact'
      ? `Create the exact requested artifact and verify its target: ${originalRequest}`
      : `Complete and verify the exact requested local state change: ${originalRequest}`,
    kind: effectKind,
    required: true,
  }];
}

function normalizeExpectedOutputs(
  values: NormalizeAgentGoalInput['expectedOutputs'],
  normalizedObjective: string,
  operationalKind: AgentOperationalGoalKind,
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
    kind: operationalKind === 'verification' ? 'answer' : operationalKind,
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
