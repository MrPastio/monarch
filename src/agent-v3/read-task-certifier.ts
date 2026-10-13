import { createHash } from 'node:crypto';
import path from 'node:path';
import { astraJournalJson, type AstraJson, type AstraJournalSnapshot } from './journal';
import { astraReadRunId, type AstraReadCheckpoint } from './read-runtime';
import { AstraReadWorkflow, type AstraReadStep, type AstraReadWorkflowCheckpoint } from './read-workflow';
import { astraReadWorkRequestId } from './read-work-adapter';
import { astraWorkJobId, type AstraWorkJob } from './work-scheduler';

// Executable read-pack semantics, NOT the native wire Certifier/authority profile.
// Pure: no Kernel, model, filesystem read, store write or execution side effects.
export interface AstraReadSourceKey { interactionId: string; messageId: string }
export interface AstraReadSelection {
  authority: 'observe'; revision: number; digest: string; requirements: AstraReadStep[];
}
export interface AstraReadTaskGoal {
  schemaVersion: 'monarch.astra-v3-read-task-goal.internal.v1';
  taskId: string; requestDigest: string; schedulerScopeId: string; scopeDigest: string; capabilityDigest: string;
  source: AstraReadSourceKey & { revision: number; digest: string };
  completionPolicy: 'all-required'; temporalSemantics: 'snapshot-at-execution';
  requirements: Array<{ id: string; relativePath: string; maxBytes: number; timeoutMs: number; dependsOn: string[]; targetDigest: string }>;
  adapterVersion?: 'v2';
  adapterId?: 'goal-create-reference-read';
}
export interface AstraReadEvidenceRef { streamId: string; revision: number; commitHash: string }
export interface AstraReadRequirementResult {
  id: string; state: 'satisfied' | 'failed' | 'blocked' | 'cancelled'; reason?: string;
  evidence?: AstraReadEvidenceRef;
  observation?: { sizeBytes: number; contentDigest: string; targetDigest: string; proposalHash: string };
}
export interface AstraReadTaskCertificate {
  schemaVersion: 'monarch.astra-v3-read-task-certificate.internal.v1';
  taskId: string; jobId: string; goalDigest: string;
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'blocked';
  temporalSemantics: 'snapshot-at-execution'; nativeCompletionCertified: false;
  workflowEvidence: AstraReadEvidenceRef | null;
  requirements: AstraReadRequirementResult[];
}
export interface AstraReadCertificationInput {
  goal: AstraReadTaskGoal; goalDigest: string; job: AstraWorkJob;
  workflow: AstraJournalSnapshot | null; children: AstraJournalSnapshot[];
}
export const astraReadValueDigest = (value: AstraJson): string =>
  'sha256:' + createHash('sha256').update(astraJournalJson(value)).digest('hex');
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const hash = (value: string): boolean => /^sha256:[a-f0-9]{64}$/u.test(value);
const identity = (value: string): boolean => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(value);
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-read-certifier:' + code); }

/** Selection comes from the host's admission port, never from model decisions. */
export function compileAstraReadTaskGoal(input: {
  taskId: string; requestDigest: string; schedulerScopeId: string; canonicalRoot: string;
  capabilityDigest: string; source: AstraReadSourceKey; selection: AstraReadSelection;
  adapterVersion?: 'v2';
  adapterId?: 'goal-create-reference-read';
}): AstraReadTaskGoal {
  check(identity(input.taskId) && identity(input.schedulerScopeId) && identity(input.source.interactionId)
    && identity(input.source.messageId) && hash(input.requestDigest) && hash(input.capabilityDigest), 'goal-identity');
  check(input.selection.authority === 'observe' && Number.isSafeInteger(input.selection.revision) && input.selection.revision > 0
    && hash(input.selection.digest) && path.isAbsolute(input.canonicalRoot), 'admission-selection');
  const scopeDigest = sha(path.resolve(input.canonicalRoot).toLowerCase());
  const graph = AstraReadWorkflow.compile({ requestId: input.taskId, steps: input.selection.requirements }, scopeDigest);
  return { schemaVersion: 'monarch.astra-v3-read-task-goal.internal.v1', taskId: input.taskId,
    requestDigest: input.requestDigest, schedulerScopeId: input.schedulerScopeId, scopeDigest,
    capabilityDigest: input.capabilityDigest, source: { ...input.source, revision: input.selection.revision, digest: input.selection.digest },
    completionPolicy: 'all-required', temporalSemantics: 'snapshot-at-execution', ...(input.adapterVersion ? { adapterVersion: input.adapterVersion } : {}),
    ...(input.adapterId ? { adapterId: input.adapterId } : {}), requirements: graph.steps.map(step => ({
      id: step.id, relativePath: step.relativePath, maxBytes: step.maxBytes, timeoutMs: step.timeoutMs, dependsOn: step.dependsOn,
      targetDigest: sha(path.resolve(input.canonicalRoot, step.relativePath).toLowerCase()),
    })) };
}

export function astraReadGoalSteps(goal: AstraReadTaskGoal): AstraReadStep[] {
  return goal.requirements.map(({ id, relativePath, maxBytes, timeoutMs, dependsOn }) => ({ id, relativePath, maxBytes, timeoutMs, dependsOn }));
}
export function validateAstraReadTaskGoal(goal: AstraReadTaskGoal, goalDigest: string): void {
  check(goal.schemaVersion === 'monarch.astra-v3-read-task-goal.internal.v1'
    && goalDigest === astraReadValueDigest(json(goal)) && goal.completionPolicy === 'all-required'
    && goal.temporalSemantics === 'snapshot-at-execution' && identity(goal.taskId) && identity(goal.schedulerScopeId)
    && hash(goal.scopeDigest) && hash(goal.capabilityDigest) && hash(goal.requestDigest)
    && identity(goal.source.messageId) && identity(goal.source.interactionId)
    && Number.isSafeInteger(goal.source.revision) && goal.source.revision > 0 && hash(goal.source.digest)
    && (goal.adapterVersion === undefined || goal.adapterVersion === 'v2')
    && (goal.adapterId === undefined || goal.adapterId === 'goal-create-reference-read'), 'goal-binding');
  AstraReadWorkflow.compile({ requestId: goal.taskId, steps: astraReadGoalSteps(goal) }, goal.scopeDigest);
  check(goal.requirements.every(requirement => hash(requirement.targetDigest)), 'goal-target');
}
function evidence(snapshot: AstraJournalSnapshot): AstraReadEvidenceRef {
  check(Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0 && hash(snapshot.commitHash), 'evidence-ref');
  return { streamId: snapshot.streamId, revision: snapshot.revision, commitHash: snapshot.commitHash };
}

/** Shared pure observation proof. A caller must separately bind this exact request
 * to its admitted Goal, scheduler job and workflow frontier; this function grants
 * no authority and does not accept model claims in place of Kernel observations. */
export function certifyAstraReadObservation(input: { goal: AstraReadTaskGoal;
  requirement: AstraReadTaskGoal['requirements'][number]; requestId: string;
  child: AstraJournalSnapshot }): AstraReadRequirementResult {
  const { goal, requirement, requestId, child } = input;
  const checkpoint = child.checkpoint as unknown as AstraReadCheckpoint;
  check(child.streamId === astraReadRunId(requestId) && checkpoint.runId === child.streamId
    && checkpoint.schemaVersion === 'monarch.astra-v3-read-checkpoint.internal.v1'
    && checkpoint.goal?.requirementId === 'read-result' && checkpoint.goal.capabilityId === 'workspace.files.read'
    && checkpoint.goal.rootDigest === goal.scopeDigest && checkpoint.goal.contractDigest === goal.capabilityDigest
    && checkpoint.goal.relativePath === requirement.relativePath && checkpoint.goal.maxBytes === requirement.maxBytes
    && checkpoint.goal.timeoutMs === requirement.timeoutMs, 'observation-goal-binding');
  const observed = checkpoint.observation;
  check(checkpoint.phase === 'observed' && observed && typeof observed.content === 'string'
    && Number.isSafeInteger(observed.sizeBytes) && observed.sizeBytes >= 0 && observed.sizeBytes <= requirement.maxBytes
    && Buffer.byteLength(observed.content, 'utf8') === observed.sizeBytes && sha(observed.content) === observed.contentDigest
    && observed.targetDigest === requirement.targetDigest
    && observed.proposalHash === checkpoint.invocation?.proposalHash && /^[a-f0-9]{64}$/u.test(observed.proposalHash)
    && /^action:[a-f0-9]{64}$/u.test(checkpoint.invocation.idempotencyKey), 'observation-value-binding');
  return { id: requirement.id, state: 'satisfied', evidence: evidence(child), observation: {
    sizeBytes: observed.sizeBytes, contentDigest: observed.contentDigest, targetDigest: observed.targetDigest, proposalHash: observed.proposalHash,
  } };
}

export function certifyAstraReadTask(input: AstraReadCertificationInput): AstraReadTaskCertificate {
  const { goal, goalDigest, job, workflow, children } = input;
  validateAstraReadTaskGoal(goal, goalDigest);
  check(job.id === astraWorkJobId(goal.taskId) && job.adapterId === (goal.adapterId ?? 'admitted-workspace-read') && job.adapterVersion === (goal.adapterVersion ?? 'v1'), 'job-binding');
  check(['observed', 'partial', 'failed', 'cancelled', 'blocked'].includes(job.state), 'execution-not-settled');
  const jobInput = job.input as { taskId?: string; read?: { requestId: string; steps: AstraReadStep[] } };
  check(jobInput.taskId === goal.taskId && jobInput.read?.requestId === astraReadWorkRequestId(goal.schedulerScopeId, job.id)
    && astraJournalJson(json(jobInput.read.steps)) === astraJournalJson(json(astraReadGoalSteps(goal))), 'execution-goal-substitution');
  const compiled = AstraReadWorkflow.compile(jobInput.read, goal.scopeDigest);
  const graph = workflow?.checkpoint as unknown as AstraReadWorkflowCheckpoint | undefined;
  check(children.length <= goal.requirements.length && new Set(children.map(child => child.streamId)).size === children.length, 'evidence-set');
  if (graph) {
    check(workflow!.streamId === compiled.runId && graph.runId === compiled.runId
      && graph.schemaVersion === compiled.schemaVersion && graph.goalDigest === compiled.goalDigest && graph.scopeDigest === goal.scopeDigest
      && graph.steps.length === compiled.steps.length, 'workflow-binding');
    // A retained result names an exact immutable frontier, not whichever snapshot
    // happens to be newest when someone asks for a completion claim.
    if (job.result) check(job.result.checkpointRef === workflow!.streamId && job.result.checkpointRevision === workflow!.revision, 'workflow-frontier');
    check(graph.steps.every(step => !['pending', 'indeterminate'].includes(step.state)), 'unresolved-observation');
  } else check(job.state === 'blocked' && children.length === 0, 'missing-workflow');

  const used = new Set<string>();
  const requirements = goal.requirements.map((requirement, index): AstraReadRequirementResult => {
    const expected = compiled.steps[index]!, step = graph?.steps[index];
    if (!step) return { id: requirement.id, state: 'blocked', reason: 'not-executed' };
    check(step.id === expected.id && step.relativePath === expected.relativePath && step.maxBytes === expected.maxBytes
      && step.timeoutMs === expected.timeoutMs && step.readRequestId === expected.readRequestId
      && astraJournalJson(step.dependsOn) === astraJournalJson(expected.dependsOn), 'requirement-substitution');
    const child = step.readRunId ? children.find(snapshot => snapshot.streamId === step.readRunId) : undefined;
    if (!child) {
      check(!step.readRunId && step.state !== 'observed' && step.state !== 'failed', 'missing-observation');
      return { id: requirement.id, state: step.state === 'cancelled' ? 'cancelled' : 'blocked',
        reason: step.state === 'blocked' ? 'dependency-unsatisfied' : 'not-executed' };
    }
    used.add(child.streamId);
    const checkpoint = child.checkpoint as unknown as AstraReadCheckpoint;
    check(child.streamId === astraReadRunId(expected.readRequestId) && checkpoint.runId === child.streamId
      && checkpoint.schemaVersion === 'monarch.astra-v3-read-checkpoint.internal.v1'
      && checkpoint.goal?.requirementId === 'read-result' && checkpoint.goal.capabilityId === 'workspace.files.read'
      && checkpoint.goal.rootDigest === goal.scopeDigest && checkpoint.goal.contractDigest === goal.capabilityDigest
      && checkpoint.goal.relativePath === requirement.relativePath && checkpoint.goal.maxBytes === requirement.maxBytes
      && checkpoint.goal.timeoutMs === requirement.timeoutMs && step.readRevision === child.revision, 'observation-goal-binding');
    if (step.state !== 'observed') {
      if (step.state === 'waiting' && ['ready', 'paused'].includes(checkpoint.phase) && !checkpoint.invocation && !checkpoint.observation) {
        return { id: requirement.id, state: 'blocked', evidence: evidence(child), reason: 'not-executed' };
      }
      check((step.state === 'failed' && checkpoint.phase === 'failed') || (step.state === 'cancelled' && checkpoint.phase === 'cancelled'), 'observation-state');
      return { id: requirement.id, state: step.state, evidence: evidence(child), reason: step.state === 'failed' ? 'read-failed' : 'cancelled' };
    }
    const result = certifyAstraReadObservation({ goal, requirement, requestId: expected.readRequestId, child });
    check(result.observation!.contentDigest === step.contentDigest, 'observation-value-binding');
    return result;
  });
  check(used.size === children.length, 'unexpected-evidence');
  const count = requirements.filter(requirement => requirement.state === 'satisfied').length;
  check(job.state !== 'observed' || count === requirements.length, 'completion-state');
  check(job.state !== 'partial' || (count > 0 && count < requirements.length), 'completion-state');
  check(job.state !== 'failed' || count === 0, 'completion-state');
  const status = job.state === 'cancelled' ? 'cancelled' : job.state === 'blocked' ? 'blocked'
    : count === requirements.length ? 'completed' : count > 0 ? 'partial' : 'failed';
  return { schemaVersion: 'monarch.astra-v3-read-task-certificate.internal.v1', taskId: goal.taskId, jobId: job.id,
    goalDigest, status, temporalSemantics: 'snapshot-at-execution', nativeCompletionCertified: false,
    workflowEvidence: workflow ? evidence(workflow) : null, requirements };
}

/** Only admitted numeric/hash facts enter the deterministic completion message. */
export function renderAstraReadTaskCertificate(certificate: AstraReadTaskCertificate): string {
  const observed = certificate.requirements.filter(requirement => requirement.state === 'satisfied');
  const bytes = observed.reduce((total, requirement) => total + requirement.observation!.sizeBytes, 0);
  const labels = { completed: 'Готово.', partial: 'Выполнено частично.', failed: 'Задача не выполнена.',
    cancelled: 'Задача отменена.', blocked: 'Задача заблокирована.' };
  return `${labels[certificate.status]} Прочитано файлов: ${observed.length}/${certificate.requirements.length}. `
    + `Получено UTF-8 байт: ${bytes}. Данные относятся к моменту выполнения.`;
}
