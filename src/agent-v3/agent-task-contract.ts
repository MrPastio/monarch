import type {
  AgentBudgetLimits,
  AgentExpectedOutput,
  AgentGoalConstraint,
  AgentSuccessCriterion,
} from '../agent-protocol';

export const ASTRA_AGENT_MAX_MODEL_TURNS = 64;
export const ASTRA_AGENT_MAX_CAPABILITY_CALLS = 48;
export const ASTRA_AGENT_MAX_TASK_DURATION_MS = 12 * 60 * 60 * 1000;

/** Public typed task goal accepted at transport/Turn Store boundaries. This
 * module deliberately has no Journal, scheduler, Kernel or model dependency. */
export interface AstraAgentTaskSpecification {
  schemaVersion: 'monarch.astra-v3-agent-task-specification.v1';
  expectedOutputs?: Array<Partial<AgentExpectedOutput> & { description: string }>;
  constraints?: Array<Partial<AgentGoalConstraint> & { description: string }>;
  successCriteria?: Array<Partial<AgentSuccessCriterion> & { description: string }>;
  userPreferences?: string[];
  startPaused?: true;
  budgets?: Pick<Partial<AgentBudgetLimits>, 'maxModelTurns' | 'maxToolCalls' | 'maxWallTimeMs'>;
}

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
function scalar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function isAstraAgentTaskSpecification(value: unknown): value is AstraAgentTaskSpecification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const spec = value as AstraAgentTaskSpecification;
  if (spec.schemaVersion !== 'monarch.astra-v3-agent-task-specification.v1'
    || Object.keys(spec).some(key => !['schemaVersion', 'expectedOutputs', 'constraints', 'successCriteria', 'userPreferences', 'startPaused', 'budgets'].includes(key))) return false;
  const records = (items: unknown, fields: string[]): items is Array<Record<string, unknown>> => items === undefined
    || Array.isArray(items) && items.length <= 32 && items.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).every(key => fields.includes(key))
      && ((item as { id?: unknown }).id === undefined || id((item as { id: string }).id))
      && typeof (item as { description?: unknown }).description === 'string'
      && (item as { description: string }).description.trim().length > 0
      && (item as { description: string }).description.length <= 2_000
      && scalar((item as { description: string }).description));
  if (!records(spec.expectedOutputs, ['id', 'description', 'kind', 'required'])
    || !records(spec.constraints, ['id', 'description', 'kind'])
    || !records(spec.successCriteria, ['id', 'description', 'verificationHint'])) return false;
  if (spec.expectedOutputs?.some(item => item.kind !== undefined && !['answer', 'artifact', 'state-change', 'verification', 'other'].includes(item.kind)
    || item.required !== undefined && typeof item.required !== 'boolean')) return false;
  if (spec.constraints?.some(item => item.kind !== undefined && !['safety', 'permission', 'scope', 'format', 'resource', 'other'].includes(item.kind))) return false;
  if (spec.successCriteria?.some(item => item.verificationHint !== undefined
    && (typeof item.verificationHint !== 'string' || !item.verificationHint.trim() || item.verificationHint.length > 2_000
      || !scalar(item.verificationHint)))) return false;
  if (spec.userPreferences !== undefined && (!Array.isArray(spec.userPreferences) || spec.userPreferences.length > 32
    || spec.userPreferences.some(item => typeof item !== 'string' || !item.trim() || item.length > 1_000 || !scalar(item)))) return false;
  if (spec.startPaused !== undefined && spec.startPaused !== true) return false;
  if (spec.budgets !== undefined && (!spec.budgets || typeof spec.budgets !== 'object' || Array.isArray(spec.budgets)
    || Object.keys(spec.budgets).some(key => !['maxModelTurns', 'maxToolCalls', 'maxWallTimeMs'].includes(key))
    || spec.budgets.maxModelTurns !== undefined && (!Number.isSafeInteger(spec.budgets.maxModelTurns)
      || spec.budgets.maxModelTurns < 2 || spec.budgets.maxModelTurns > ASTRA_AGENT_MAX_MODEL_TURNS)
    || spec.budgets.maxToolCalls !== undefined && (!Number.isSafeInteger(spec.budgets.maxToolCalls)
      || spec.budgets.maxToolCalls < 1 || spec.budgets.maxToolCalls > ASTRA_AGENT_MAX_CAPABILITY_CALLS)
    || spec.budgets.maxWallTimeMs !== undefined && (!Number.isSafeInteger(spec.budgets.maxWallTimeMs)
      || spec.budgets.maxWallTimeMs < 1_000 || spec.budgets.maxWallTimeMs > ASTRA_AGENT_MAX_TASK_DURATION_MS))) return false;
  try { return Buffer.byteLength(JSON.stringify(spec)) <= 12 * 1024; } catch { return false; }
}
