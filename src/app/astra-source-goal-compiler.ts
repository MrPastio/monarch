import path from 'node:path';
import { modelReadDigest as digest, modelReadIdentity as id } from '../agent-v3/model-read-task-state';
import type { AstraReadSelection } from '../agent-v3/read-task-certifier';
import type { AstraModelReadSelection } from '../agent-v3/model-read-task-state';
import type { AstraTaskSourceContext, AstraCreateCatalogSelection, AstraAuthenticatedHttpActor } from './astra-task-facade';
import { AstraSourceGoalError, validateAstraSourceGoal } from '../agent-v3/source-goal-contract';
export { AstraSourceGoalError, validateAstraSourceGoal, type AstraMaxModelChoice,
  type AstraLocalAgentModelChoice, type AstraSourceGoalInput } from '../agent-v3/source-goal-contract';

/** Explicit user/source form, not a model tool call or inferred natural-language
 * authority. Handles refer only to targets selected through the trusted host port. */
export interface AstraSelectedTarget {
  id: string; relativePath: string; access: 'observe' | 'exclusive-create'; maxBytes: number; timeoutMs: number;
}
export interface AstraSelectedTargetSnapshot {
  selectionId: string; actor: AstraAuthenticatedHttpActor; conversationId: string;
  revision: number; targets: AstraSelectedTarget[];
}
/** Host owns target selection and revocation. No fallback to caller paths, cwd,
 * model text, filesystem discovery or another actor's selection. Synchronous and bounded. */
export interface AstraSelectedTargetPort {
  resolve(selectionId: string, context: AstraTaskSourceContext): AstraSelectedTargetSnapshot;
}
function check(value: unknown, status: number, code: string): asserts value { if (!value) throw new AstraSourceGoalError(status, 'astra-source-' + code); }
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), 400, 'goal-shape');
}
function validRelativePath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !path.isAbsolute(value)
    && !path.win32.isAbsolute(value) && !/[:\x00-\x1f\x7f]/u.test(value)
    && value.split(/[\\/]/u).every(part => part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/u.test(part)
      && !/[*?"<>|]/u.test(part) && !/^(con(?:in\$|out\$)?|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part));
}

/** Shared validation for trusted issuance and compiler resolution. Storage is not
 * an authority shortcut: every compiled source rechecks the same closed snapshot. */
export function validateAstraSelectedTargetSnapshot(snapshot: AstraSelectedTargetSnapshot,
  expected: { selectionId: string; actor: AstraAuthenticatedHttpActor; conversationId: string }): void {
  fields(snapshot, ['selectionId', 'actor', 'conversationId', 'revision', 'targets']);
  check(snapshot.selectionId === expected.selectionId && digest(snapshot.actor) === digest(expected.actor)
    && snapshot.conversationId === expected.conversationId, 404, 'selection-not-found');
  check(id(snapshot.selectionId) && id(snapshot.conversationId) && snapshot.actor
    && /^sha256:[a-f0-9]{64}$/u.test(snapshot.actor.id) && ['api', 'desktop', 'telegram'].includes(snapshot.actor.source)
    && Object.keys(snapshot.actor).every(key => ['id', 'source'].includes(key)), 409, 'selection-principal');
  check(Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0 && Array.isArray(snapshot.targets)
    && snapshot.targets.length > 0 && snapshot.targets.length <= 32, 409, 'selection-budget');
  const handles = new Set<string>(), paths = new Set<string>();
  for (const target of snapshot.targets) {
    fields(target, ['id', 'relativePath', 'access', 'maxBytes', 'timeoutMs']);
    check(id(target.id) && !handles.has(target.id) && validRelativePath(target.relativePath)
      && !paths.has(target.relativePath.replace(/\\/gu, '/').toLowerCase())
      && ['observe', 'exclusive-create'].includes(target.access) && Number.isSafeInteger(target.maxBytes)
      && target.maxBytes >= (target.access === 'observe' ? 1 : 0) && target.maxBytes <= (target.access === 'observe' ? 65536 : 16384)
      && Number.isSafeInteger(target.timeoutMs) && target.timeoutMs >= 50 && target.timeoutMs <= 10000, 409, 'target-contract');
    handles.add(target.id); paths.add(target.relativePath.replace(/\\/gu, '/').toLowerCase());
  }
  digest(snapshot);
}

/** Compiles many requests against actual host-selected targets, not a table of
 * canned task texts/outputs. Pure apart from the explicit target port. Existing
 * family profiles still own source checks, queue, Kernel invocation and evidence.
 * Observe means snapshot/byte evidence only, NOT a semantic answer to arbitrary prose. */
export class AstraSourceGoalCompiler {
  constructor(private readonly targets: AstraSelectedTargetPort) {}
  read(selectionId: string, context: AstraTaskSourceContext): AstraReadSelection | AstraModelReadSelection {
    const goal = context.goal; check(goal, 400, 'goal-required'); validateAstraSourceGoal(goal, 'read');
    check(goal.kind === 'observe' || goal.kind === 'analyze', 400, 'read-goal');
    const snapshot = this.snapshot(selectionId, context), targets = goal.targets.map(handle => this.target(snapshot, handle, 'observe'));
    const answerBudget = goal.kind === 'analyze' ? Math.floor(12 * 1024 / targets.length) : undefined;
    return { authority: 'observe', revision: snapshot.revision, digest: this.binding(snapshot, context),
      requirements: targets.map((target, index) => ({ id: 'selected_' + index, relativePath: target.relativePath,
        maxBytes: Math.min(target.maxBytes, answerBudget ?? target.maxBytes), timeoutMs: target.timeoutMs, dependsOn: [] })),
      ...(goal.kind === 'analyze' ? { answerMode: 'grounded-model' as const, userText: context.text } : {}) };
  }
  create(selectionId: string, context: AstraTaskSourceContext): AstraCreateCatalogSelection {
    const goal = context.goal; check(goal, 400, 'goal-required'); validateAstraSourceGoal(goal, 'create');
    check(goal.kind === 'create', 400, 'create-goal');
    const snapshot = this.snapshot(selectionId, context), target = this.target(snapshot, goal.target, 'exclusive-create');
    check(!/[\\/]/u.test(target.relativePath) && target.relativePath.length <= 255, 409, 'create-leaf-required');
    const base = { authority: 'exclusive-create' as const, revision: snapshot.revision, digest: this.binding(snapshot, context),
      basename: target.relativePath, timeoutMs: target.timeoutMs };
    if (goal.content.kind === 'literal') {
      check(Buffer.byteLength(goal.content.text) <= target.maxBytes, 400, 'content-budget');
      return { ...base, kind: 'literal', content: goal.content.text };
    }
    if (goal.content.kind === 'reply') return { ...base, kind: 'literal-input', maxBytes: target.maxBytes,
      requiredInput: { kind: 'literal-content', id: 'file_content', question: 'Введи точное содержимое нового файла. Пустой ответ создаст пустой файл.',
        maxUtf8Bytes: Math.min(4096, target.maxBytes) } };
    if (!goal.content.references) return { ...base, kind: 'draft', maxBytes: target.maxBytes };
    const references = goal.content.references.map(reference => {
      const selected = this.snapshot(reference.selectionId, context);
      return { selected, target: this.target(selected, reference.target, 'observe') };
    });
    check(new Set(references.map(item => item.target.relativePath.replace(/\\/gu, '/').toLowerCase())).size === references.length
      && references.every(item => item.target.relativePath.toLowerCase() !== target.relativePath.toLowerCase()), 400, 'reference-alias');
    return { ...base, kind: 'draft', maxBytes: target.maxBytes,
      digest: digest({ compiler: 'source-goal-references-v1', snapshot, context, references: references.map(item => item.selected) }),
      references: references.map((item, index) => ({ id: 'reference_' + index, relativePath: item.target.relativePath,
        maxBytes: Math.min(item.target.maxBytes, Math.floor(65536 / references.length)), timeoutMs: item.target.timeoutMs, dependsOn: [] })) };
  }
  private snapshot(selectionId: string, context: AstraTaskSourceContext): AstraSelectedTargetSnapshot {
    check(id(selectionId), 400, 'selection-identity');
    const snapshot = structuredClone(this.targets.resolve(selectionId, structuredClone(context)));
    validateAstraSelectedTargetSnapshot(snapshot, { selectionId, actor: context.actor, conversationId: context.conversationId });
    return snapshot;
  }
  private target(snapshot: AstraSelectedTargetSnapshot, handle: string, access: AstraSelectedTarget['access']): AstraSelectedTarget {
    const target = snapshot.targets.find(item => item.id === handle);
    check(target && target.access === access, 403, 'target-not-admitted'); return target;
  }
  private binding(snapshot: AstraSelectedTargetSnapshot, context: AstraTaskSourceContext): string {
    return digest({ compiler: 'source-goal-v1', snapshot, context });
  }
}
