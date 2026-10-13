import { parseCloudRole, type MaxCloudRole } from './max-cloud-catalog';

/** Leaf source contract: no runtime, Journal, SQLite, model or Kernel imports.
 * It can be validated by the existing Turn Store while Astra is disabled. */
export type AstraMaxModelChoice = 'gpt-oss-120b' | 'qwen-3.8-27b' | MaxCloudRole;
export type AstraLocalAgentModelChoice = 'gemma4-balanced' | 'qwen3-coder-30b-a3b-instruct' | 'deepseek-coder-v2-lite-instruct';
export const ASTRA_LOCAL_AGENT_MODEL_CHOICES = Object.freeze([
  'gemma4-balanced',
  'qwen3-coder-30b-a3b-instruct',
  'deepseek-coder-v2-lite-instruct',
] as const satisfies readonly AstraLocalAgentModelChoice[]);
export function isAstraLocalAgentModelChoice(value: unknown): value is AstraLocalAgentModelChoice {
  return typeof value === 'string' && (ASTRA_LOCAL_AGENT_MODEL_CHOICES as readonly string[]).includes(value);
}
export type AstraSourceGoalInput = { kind: 'observe'; targets: string[] }
  | { kind: 'analyze'; targets: string[]; modelMode: 'max' | 'local'; modelChoice?: AstraMaxModelChoice;
    previewAcknowledged?: true }
  | { kind: 'create'; target: string; content: { kind: 'literal'; text: string } | { kind: 'reply' }
    | { kind: 'draft'; modelMode?: 'max'; modelChoice?: AstraMaxModelChoice;
      previewAcknowledged?: true; references?: Array<{ selectionId: string; target: string }> } }
  | { kind: 'agent'; modelMode: 'max' | 'local'; modelChoice?: AstraMaxModelChoice | AstraLocalAgentModelChoice;
    previewAcknowledged?: true };
export class AstraSourceGoalError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
function check(value: unknown, code: string): asserts value { if (!value) throw new AstraSourceGoalError(400, 'astra-source-' + code); }
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), 'goal-shape');
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
export function isAstraMaxModelChoice(value: unknown): value is AstraMaxModelChoice {
  return value === 'gpt-oss-120b' || value === 'qwen-3.8-27b' || Boolean(parseCloudRole(value));
}
const maxModel = isAstraMaxModelChoice;
export function validateAstraSourceGoal(value: AstraSourceGoalInput, operation: 'read' | 'create' | 'agent'): void {
  if (operation === 'agent') {
    fields(value, ['kind', 'modelMode', 'modelChoice', 'previewAcknowledged']);
    check(value.kind === 'agent' && (value.modelMode === 'local' || value.modelMode === 'max'), 'agent-goal');
    check(value.modelMode === 'local'
      ? (value.modelChoice === undefined || isAstraLocalAgentModelChoice(value.modelChoice))
        && value.previewAcknowledged === undefined
      : value.modelChoice === undefined || maxModel(value.modelChoice), 'model-choice');
    check(value.modelChoice === 'qwen-3.8-27b' ? value.previewAcknowledged === true
      : value.previewAcknowledged === undefined, 'model-preview');
    return;
  }
  if (operation === 'read') {
    fields(value, value?.kind === 'analyze'
      ? ['kind', 'targets', 'modelMode', 'modelChoice', 'previewAcknowledged'] : ['kind', 'targets']);
    check((value.kind === 'observe' || value.kind === 'analyze')
      && Array.isArray(value.targets) && value.targets.length > 0 && value.targets.length <= 8
      && value.targets.every(id) && new Set(value.targets).size === value.targets.length, 'read-goal');
    if (value.kind === 'analyze') {
      check(value.modelMode === 'local' ? value.modelChoice === undefined && value.previewAcknowledged === undefined
        : value.modelMode === 'max' && (value.modelChoice === undefined || ['gpt-oss-120b', 'qwen-3.8-27b'].includes(value.modelChoice)), 'model-choice');
      check(value.modelChoice === 'qwen-3.8-27b'
        ? value.previewAcknowledged === true : value.previewAcknowledged === undefined, 'model-preview');
    }
  } else {
    fields(value, ['kind', 'target', 'content']);
    check(value.kind === 'create' && id(value.target), 'create-goal');
    fields(value.content, ['kind', 'text', 'references', 'modelMode', 'modelChoice', 'previewAcknowledged']);
    check(['literal', 'reply', 'draft'].includes(value.content.kind as string), 'content-kind');
    check(value.content.kind === 'literal' ? typeof value.content.text === 'string' && Buffer.byteLength(value.content.text) <= 16384
      && !('references' in value.content) && !('modelMode' in value.content)
      && !('modelChoice' in value.content) && !('previewAcknowledged' in value.content)
      : value.content.kind === 'draft' ? !('text' in value.content)
        && (value.content.modelMode === undefined || value.content.modelMode === 'max')
      : Object.keys(value.content).length === 1, 'content-shape');
    if (value.content.kind === 'literal') check(Buffer.from(value.content.text, 'utf8').toString('utf8') === value.content.text, 'invalid-unicode');
    if (value.content.kind === 'draft' && value.content.references !== undefined) {
      const references = value.content.references;
      check(Array.isArray(references) && references.length > 0 && references.length <= 8, 'reference-count');
      for (const reference of references) { fields(reference, ['selectionId', 'target']); check(id(reference.selectionId) && id(reference.target), 'reference-identity'); }
      check(new Set(references.map(reference => reference.selectionId + '/' + reference.target)).size === references.length, 'reference-duplicate');
    }
    if (value.content.kind === 'draft') {
      const maxSelected = value.content.modelMode === 'max';
      check(maxSelected
        ? value.content.modelChoice === undefined || ['gpt-oss-120b', 'qwen-3.8-27b'].includes(value.content.modelChoice)
        : value.content.modelChoice === undefined && value.content.previewAcknowledged === undefined,
      'model-choice');
      check(value.content.modelChoice === 'qwen-3.8-27b'
        ? value.content.previewAcknowledged === true : value.content.previewAcknowledged === undefined,
      'model-preview');
    }
  }
}
