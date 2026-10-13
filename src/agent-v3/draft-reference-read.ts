import { compileAstraReadTaskGoal, certifyAstraReadTask, astraReadGoalSteps,
  type AstraReadTaskGoal, type AstraReadTaskCertificate, type AstraReadCertificationInput, type AstraReadEvidenceRef } from './read-task-certifier';
import { AstraReadWorkflow, type AstraReadWorkflowRequest } from './read-workflow';
import type { AstraReadCheckpoint } from './read-runtime';
import { astraReadWorkRequestId } from './read-work-adapter';
import { astraWorkJobId } from './work-scheduler';
import { modelReadCheck as check, modelReadDigest as digest, modelReadSame as same } from './model-read-task-state';
import { modelReadEvidence } from './model-read-task-certifier';
import type { AstraModelCreateGoal, AstraModelCreateRecord } from './model-create-task-state';

export const draftReferenceTaskId = (parentId: string): string => 'draft_refs_' + digest(parentId).slice(7, 39);
export const draftReferenceJobId = (parentId: string): string => astraWorkJobId(draftReferenceTaskId(parentId));
export type AstraDraftReferenceProof = Pick<AstraReadCertificationInput, 'job' | 'workflow' | 'children'>;
export interface AstraDraftReferenceBinding { certificateDigest: string; workflow: AstraReadEvidenceRef; children: AstraReadEvidenceRef[] }
export interface AstraDraftReferenceContext { certificate: AstraReadTaskCertificate; binding: AstraDraftReferenceBinding;
  data: Array<{ requirementId: string; content: string; contentDigest: string; evidence: AstraReadEvidenceRef }> }

/** Pure read Goal derived from the parent source, never from model text. */
export function compileDraftReferenceGoal(goal: AstraModelCreateGoal, capabilityDigest: string): AstraReadTaskGoal {
  check(goal.selection.references?.length, 'draft-references-required');
  const taskId = draftReferenceTaskId(goal.taskId);
  return compileAstraReadTaskGoal({ taskId, requestDigest: digest({ parent: goal.taskId, source: goal.source, selection: goal.selection }),
    schedulerScopeId: goal.scopeId, canonicalRoot: goal.canonicalRoot, capabilityDigest, source: goal.source,
    selection: { authority: 'observe', revision: goal.selection.revision, digest: goal.selection.digest, requirements: goal.selection.references },
    adapterVersion: 'v2', adapterId: 'goal-create-reference-read' });
}
export function draftReferenceRequest(goal: AstraModelCreateGoal): AstraReadWorkflowRequest {
  check(goal.referenceReadGoal, 'draft-reference-goal');
  return { requestId: astraReadWorkRequestId(goal.scopeId, draftReferenceJobId(goal.taskId)), steps: astraReadGoalSteps(goal.referenceReadGoal) };
}
export function validateDraftReferenceGoal(goal: AstraModelCreateGoal): void {
  const references = goal.selection.references;
  if (!references) { check(!goal.referenceReadGoal, 'draft-unexpected-reference-goal'); return; }
  check(Array.isArray(references) && references.length > 0 && references.length <= 8
    && goal.createAdapterVersion === 'v2'
    && goal.selection.requiredInput?.kind !== 'literal-content'
    && references.every(item => item.maxBytes <= 65536 && item.dependsOn.length === 0
      && Object.keys(item).every(key => ['id', 'relativePath', 'maxBytes', 'timeoutMs', 'dependsOn'].includes(key)))
    && references.reduce((sum, item) => sum + item.maxBytes, 0) <= 65536
    && new Set(references.map(item => item.relativePath.replace(/\\/gu, '/').toLowerCase())).size === references.length
    && references.every(item => item.relativePath.toLowerCase() !== goal.selection.basename.toLowerCase()), 'draft-reference-budget');
  check(goal.referenceReadGoal && same(goal.referenceReadGoal, compileDraftReferenceGoal(goal, goal.referenceReadGoal.capabilityDigest)), 'draft-reference-goal-binding');
}

/** Reuse the real read-family proof, including exact workflow/child frontiers.
 * Raw file bytes appear only in the Context projection; the parent stores refs.
 * Snapshot-at-execution, NOT a fresh-file assertion or semantic correctness. */
export function inspectDraftReferences(record: AstraModelCreateRecord, proof?: AstraDraftReferenceProof): {
  certificate?: AstraReadTaskCertificate; context?: AstraDraftReferenceContext;
} {
  validateDraftReferenceGoal(record.goal);
  const goal = record.goal.referenceReadGoal;
  if (!goal) { check(!proof && !record.referenceJobId && !record.referenceEvidence, 'draft-unexpected-reference-proof'); return {}; }
  if (!record.referenceJobId) {
    check(!proof && !record.referenceEvidence && record.goal.selection.requiredInput && !record.requiredInputAnswer, 'draft-reference-job-missing'); return {};
  }
  check(proof && record.referenceJobId === draftReferenceJobId(record.taskId), 'draft-reference-job-missing');
  check(same(proof.job.input, { taskId: goal.taskId, parentTaskId: record.taskId, read: draftReferenceRequest(record.goal) }), 'draft-reference-input');
  const certificate = certifyAstraReadTask({ ...proof, goal, goalDigest: digest(goal) });
  if (certificate.status !== 'completed') { check(!record.referenceEvidence, 'draft-reference-not-complete'); return { certificate }; }
  check(proof.workflow && certificate.workflowEvidence, 'draft-reference-workflow');
  const compiled = AstraReadWorkflow.compile(draftReferenceRequest(record.goal), goal.scopeDigest);
  const data = certificate.requirements.map((requirement, index) => {
    const child = proof.children.find(item => same(modelReadEvidence(item), requirement.evidence));
    check(child && compiled.steps[index]!.id === requirement.id, 'draft-reference-content');
    const observation = (child.checkpoint as unknown as AstraReadCheckpoint).observation!;
    return { requirementId: requirement.id, content: observation.content, contentDigest: observation.contentDigest, evidence: modelReadEvidence(child) };
  });
  const binding = { certificateDigest: digest(certificate), workflow: certificate.workflowEvidence, children: data.map(item => item.evidence) };
  if (record.referenceEvidence) check(same(record.referenceEvidence, binding), 'draft-reference-frontier');
  return { certificate, context: { certificate, binding, data } };
}
