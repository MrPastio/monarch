import type { AstraJournalSnapshot } from './journal';
import type { AstraModelWorkCheckpoint } from './model-work-adapter';
import { AstraReadDecisionGateway } from './read-decision-gateway';
import { astraReadRunId, type AstraReadCheckpoint } from './read-runtime';
import { AstraReadWorkflow, type AstraReadWorkflowCheckpoint } from './read-workflow';
import { certifyAstraReadObservation, validateAstraReadTaskGoal, type AstraReadEvidenceRef,
  type AstraReadRequirementResult } from './read-task-certifier';
import type { AstraWorkJob } from './work-scheduler';
import type { AstraContextPlan } from './context-engine';
import { classifyAstraModelWorkFailure } from './model-failure-presentation';
import { astraModelDecisionProfile } from './model-decision-profile';
import { projectAstraMemoryRecall, validateAstraMemoryQuery } from './memory-recall';
import { modelReadCandidates, modelReadCheck as check, modelReadChildJobId, modelReadDigest as digest, modelReadSame as same,
  modelReadSettled, modelReadUnpack, modelReadWorkflow, type AstraModelReadTaskRecord,
  type AstraModelReadRound, type AstraModelReadTaskCertificate } from './model-read-task-state';

export interface AstraModelReadProofInput { record: AstraModelReadTaskRecord; jobs: AstraWorkJob[]; snapshots: AstraJournalSnapshot[] }
export function modelReadEvidence(snapshot: AstraJournalSnapshot): AstraReadEvidenceRef {
  check(snapshot.revision > 0 && Number.isSafeInteger(snapshot.revision) && /^sha256:[0-9a-f]{64}$/u.test(snapshot.commitHash), 'evidence-ref');
  return { streamId: snapshot.streamId, revision: snapshot.revision, commitHash: snapshot.commitHash };
}

/** Pure retained-fact inspection used BOTH before dependency progression and at
 * certification. Models choose only a ready admitted requirement. They cannot
 * supply evidence, satisfy dependencies or certify their own output. */
export function inspectAstraModelReadProof(input: AstraModelReadProofInput): {
  requirements: AstraReadRequirementResult[]; rounds: AstraModelReadTaskCertificate['rounds'];
  modelAnswer?: NonNullable<AstraModelReadTaskCertificate['modelAnswer']>;
} {
  const { record, jobs, snapshots } = input, goal = record.goal;
  if (record.memoryRecall !== undefined) validateAstraMemoryQuery(record.memoryRecall, record.userText);
  validateAstraReadTaskGoal(goal, record.goalDigest);
  check(goal.taskId === record.taskId && (record.answerMode === undefined || record.answerMode === 'grounded-model')
    && record.rounds.length > 0 && record.rounds.length <= goal.requirements.length + (record.answerMode ? 1 : 0)
    && new Set(jobs.map(job => job.id)).size === jobs.length
    && new Set(snapshots.map(item => item.streamId)).size === snapshots.length, 'proof-input');
  const observed = new Map<string, AstraReadRequirementResult>();
  const rounds: AstraModelReadTaskCertificate['rounds'] = [];
  let modelAnswer: AstraModelReadTaskCertificate['modelAnswer'];
  const get = (id: string) => snapshots.find(item => item.streamId === id);
  const inspectRead = (index: number, round: AstraModelReadRound,
    item: AstraModelReadTaskCertificate['rounds'][number], decisionRequest?: unknown): void => {
    const requirement = goal.requirements.find(value => value.id === round.selectedRequirementId);
    check(requirement && !observed.has(requirement.id)
      && requirement.dependsOn.every(id => observed.get(id)?.state === 'satisfied'), 'dependency-not-proven');
    const candidates = modelReadCandidates(record, index), selected = candidates.find(value => value.requirementId === requirement.id);
    check(selected && (round.purpose !== 'deterministic-read' || candidates[0]?.requirementId === requirement.id), 'read-not-admitted');
    check(round.readJobId === modelReadChildJobId(record.taskId, index, 'read'), 'read-job-identity');
    const readJob = jobs.find(job => job.id === round.readJobId);
    check(readJob && readJob.adapterId === 'goal-model-workspace-read' && readJob.adapterVersion === 'v1', 'read-job-binding');
    const readEnvelope = modelReadUnpack(readJob.input), request = modelReadWorkflow(record, index, requirement.id);
    check(readEnvelope.taskId === record.taskId && readEnvelope.round === index && same(readEnvelope.read, request), 'read-goal-binding');
    const compiled = AstraReadWorkflow.compile(request, goal.scopeDigest), expected = compiled.steps[0]!;
    const expectedRequest = { requestId: expected.readRequestId, relativePath: requirement.relativePath,
      maxBytes: requirement.maxBytes, timeoutMs: requirement.timeoutMs };
    check(same(selected.request, expectedRequest) && (decisionRequest === undefined || same(decisionRequest, expectedRequest)),
      'decision-execution-binding');
    item.readJobId = readJob.id;
    if (!modelReadSettled(readJob.state)) {
      check(index === record.rounds.length - 1 && !['settled', 'certified'].includes(record.phase), 'unsettled-read');
      return;
    }
    const workflow = get(compiled.runId), graph = workflow?.checkpoint as unknown as AstraReadWorkflowCheckpoint | undefined;
    const child = get(astraReadRunId(expected.readRequestId));
    if (!graph) {
      check(readJob.state === 'blocked' && !child, 'missing-read-workflow');
      observed.set(requirement.id, { id: requirement.id, state: 'blocked', reason: 'not-executed' });
    } else {
      const step = graph.steps[0];
      check(workflow!.streamId === compiled.runId && graph.runId === compiled.runId && graph.schemaVersion === compiled.schemaVersion
        && graph.scopeDigest === goal.scopeDigest && graph.goalDigest === compiled.goalDigest && graph.steps.length === 1
        && step?.id === expected.id && step.readRequestId === expected.readRequestId && step.relativePath === expected.relativePath
        && step.maxBytes === expected.maxBytes && step.timeoutMs === expected.timeoutMs && same(step.dependsOn, [])
        && (!readJob.result || (readJob.result.checkpointRef === workflow!.streamId && readJob.result.checkpointRevision === workflow!.revision))
        && !['pending', 'indeterminate'].includes(step.state), 'read-workflow-proof');
      item.workflowEvidence = modelReadEvidence(workflow!);
      if (step.state === 'observed') {
        check(child && child.streamId === step.readRunId && child.revision === step.readRevision, 'read-frontier');
        const result = certifyAstraReadObservation({ goal, requirement, requestId: expected.readRequestId, child });
        check(result.observation!.contentDigest === step.contentDigest, 'read-content-frontier'); observed.set(requirement.id, result);
      } else {
        check(readJob.state !== 'observed', 'read-status');
        if (child) {
          const value = child.checkpoint as unknown as AstraReadCheckpoint;
          check(child.streamId === step.readRunId && child.revision === step.readRevision && value.runId === child.streamId
            && value.goal.rootDigest === goal.scopeDigest && value.goal.relativePath === requirement.relativePath
            && value.goal.contractDigest === goal.capabilityDigest && !value.observation
            && ['ready', 'paused', 'failed', 'cancelled'].includes(value.phase), 'failed-read-proof');
        } else check(!step.readRunId && !['failed', 'observed'].includes(step.state), 'missing-read-observation');
        observed.set(requirement.id, { id: requirement.id, state: step.state === 'failed' ? 'failed'
          : step.state === 'cancelled' ? 'cancelled' : 'blocked', reason: 'read-not-satisfied',
          ...(child ? { evidence: modelReadEvidence(child) } : {}) });
      }
    }
    if (index < record.rounds.length - 1) check(observed.get(requirement.id)?.state === 'satisfied', 'unsatisfied-predecessor');
  };
  for (const [index, round] of record.rounds.entries()) {
    check(round.index === index, 'round-identity');
    const deterministic = round.purpose === 'deterministic-read';
    const answering = round.purpose === 'grounded-answer';
    check(round.purpose === undefined
      || (deterministic && record.answerMode === 'grounded-model' && !round.modelJobId
        && !!round.selectedRequirementId && !!round.readJobId && !round.modelEvidence && !round.responseText)
      || (answering && record.answerMode === 'grounded-model' && index === record.rounds.length - 1
        && !!round.modelJobId && !round.selectedRequirementId && !round.readJobId), 'round-purpose');
    const item: AstraModelReadTaskCertificate['rounds'][number] = { index,
      ...(round.purpose ? { purpose: round.purpose } : {}) };
    rounds.push(item);
    if (deterministic) { inspectRead(index, round, item); continue; }
    check(round.modelJobId === modelReadChildJobId(record.taskId, index, 'model'), 'round-identity');
    const modelJob = jobs.find(job => job.id === round.modelJobId);
    check(modelJob && modelJob.adapterId === 'goal-read-model' && modelJob.adapterVersion === 'v1', 'model-job-binding');
    const envelope = modelReadUnpack(modelJob.input), model = envelope.model;
    check(envelope.taskId === record.taskId && envelope.round === index && model?.workId && model.contextExecutionId
      && model.expectedModelDigest === record.policy.expectedModelDigest
      && model.maxOutputTokens === record.policy.maxOutputTokens && model.timeoutMs === record.policy.modelTimeoutMs
      && model.maxAttempts === record.policy.maxModelAttempts && same(model.contextLimits, record.policy.contextLimits)
      && same(model.candidates, modelReadCandidates(record, index)), 'model-goal-binding');
    check(model.source.mandatory.some(item => item.ref === 'parent_goal' && item.kind === 'goal'
      && same(JSON.parse(item.text), { goalDigest: record.goalDigest, userText: record.userText,
        ...(record.memoryRecall ? { memoryDigest: record.memoryRecall.sourceDigest } : {}) })), 'model-goal-context');
    check(same(model.source.optional.filter(item => item.kind === 'recalled-memory'),
      record.memoryRecall ? projectAstraMemoryRecall(record.memoryRecall) : []), 'model-memory-context');
    const modelSnapshot = get(model.workId), checkpoint = modelSnapshot?.checkpoint as unknown as AstraModelWorkCheckpoint | undefined;
    Object.assign(item, { modelJobId: modelJob.id, modelEvidence: modelSnapshot ? modelReadEvidence(modelSnapshot) : null });
    if (!modelReadSettled(modelJob.state)) {
      check(index === record.rounds.length - 1 && !round.readJobId && !['settled', 'certified'].includes(record.phase), 'unsettled-model');
      continue;
    }
    if (checkpoint) {
      check(checkpoint.workId === model.workId && checkpoint.schemaVersion === 'monarch.astra-v3-model-work.internal.v1'
        && checkpoint.quiescent && (!modelJob.result || (modelJob.result.checkpointRef === modelSnapshot!.streamId
          && modelJob.result.checkpointRevision === modelSnapshot!.revision)), 'model-frontier');
    } else check(modelJob.state === 'blocked' && !round.readJobId, 'missing-model-proof');
    if (round.modelEvidence) check(same(round.modelEvidence, item.modelEvidence), 'retained-model-frontier');
    if (index < record.rounds.length - 1 || round.readJobId || answering && modelJob.state === 'observed') {
      check(modelJob.state === 'observed' && checkpoint?.phase === 'settled' && checkpoint.desired === 'run'
        && checkpoint.output && checkpoint.seal && checkpoint.contextFrontier && checkpoint.decision?.status === 'accepted', 'model-not-accepted');
      const output = checkpoint.output, seal = checkpoint.seal, context = get(checkpoint.contextFrontier.streamId);
      check(context && same(modelReadEvidence(context), checkpoint.contextFrontier)
        && output.finishReason === 'stop' && output.authority === 'none'
        && output.preparedId === seal.preparedId && output.turnId === seal.turnId
        && output.surfaceDigest === seal.surfaceDigest && output.promptDigest === seal.promptDigest
        && output.schemaDigest === seal.schemaDigest && output.inputTokens === seal.tokenCount
        && same(output.binding, seal.binding), 'model-output-proof');
      const plan = (context.checkpoint as unknown as { active: AstraContextPlan }).active;
      const surface = JSON.parse(plan.surface) as { mandatory?: unknown };
      const expectedSource = { ...model.source, executionId: model.contextExecutionId,
        mandatory: [...model.source.mandatory, ...astraModelDecisionProfile(model.candidates).mandatory] };
      check(plan.surfaceDigest === seal.surfaceDigest && plan.tokenCount === seal.tokenCount, 'model-context-seal');
      check(plan.sourceDigest === digest(expectedSource), 'model-context-source');
      check(same(surface.mandatory, expectedSource.mandatory), 'model-context-mandatory');
      const gateway = new AstraReadDecisionGateway({ isCurrent: () => true });
      const offer = gateway.offer({ executionId: model.contextExecutionId, controlEpoch: modelJob.controlEpoch,
        catalogRevision: model.catalogRevision, context: plan, candidates: model.candidates });
      const accepted = gateway.accept(offer.offerId, output.text);
      check(accepted.status === 'accepted' && same(accepted.proposal, checkpoint.decision.proposal), 'model-decision-proof');
      if (answering) {
        check(observed.size === goal.requirements.length && !modelAnswer, 'grounded-answer-evidence');
        if (accepted.proposal.kind === 'respond') {
          if (round.responseText === undefined) check(!['settled', 'certified'].includes(record.phase), 'grounded-answer-proof');
          else {
            check(round.responseText === accepted.proposal.text && item.modelEvidence, 'grounded-answer-proof');
            modelAnswer = { text: accepted.proposal.text, modelEvidence: item.modelEvidence };
          }
        } else check(round.responseText === undefined, 'grounded-answer-proof');
        continue;
      }
      check(accepted.proposal.kind === 'read' && accepted.proposal.requirementId === round.selectedRequirementId,
        'model-decision-proof');
      inspectRead(index, round, item, accepted.proposal.request);
    }
    if (answering) check(round.responseText === undefined && observed.size === goal.requirements.length,
      'grounded-answer-evidence');
  }
  return { requirements: goal.requirements.map(requirement => observed.get(requirement.id) ?? {
    id: requirement.id, state: record.desired === 'cancel' && record.stopReason === 'user-cancelled' ? 'cancelled' : 'blocked', reason: 'not-executed',
  }), rounds, ...(modelAnswer ? { modelAnswer } : {}) };
}

export function certifyAstraModelReadTask(input: AstraModelReadProofInput): AstraModelReadTaskCertificate {
  const record = input.record;
  check(['settled', 'certified'].includes(record.phase) && record.terminalStatus, 'task-not-settled');
  const proof = inspectAstraModelReadProof(input), count = proof.requirements.filter(item => item.state === 'satisfied').length;
  const last = record.rounds.at(-1)!;
  const activeJobId = last.readJobId ?? last.modelJobId;
  check(activeJobId && input.jobs.some(job => job.id === activeJobId && modelReadSettled(job.state)), 'child-not-settled');
  check(record.terminalStatus !== 'completed' || (count === record.goal.requirements.length && record.desired === 'run' && !record.stopReason
    && (record.answerMode ? !!proof.modelAnswer : !proof.modelAnswer)), 'false-completion');
  check(record.terminalStatus !== 'partial' || (count > 0 && count < record.goal.requirements.length), 'false-partial');
  check(record.terminalStatus !== 'failed' || count === 0, 'false-failure');
  check(record.terminalStatus !== 'cancelled' || (record.desired === 'cancel' && record.stopReason === 'user-cancelled'), 'false-cancellation');
  check(record.answerMode || !proof.modelAnswer, 'unexpected-model-answer');
  const finalModel = last.purpose === 'grounded-answer' && last.modelJobId
    ? input.jobs.find(job => job.id === last.modelJobId) : undefined;
  const finalInput = finalModel ? modelReadUnpack(finalModel.input).model : undefined;
  const finalSnapshot = finalInput?.workId ? input.snapshots.find(snapshot => snapshot.streamId === finalInput.workId) ?? null : null;
  const classified = record.terminalStatus !== 'cancelled' && !proof.modelAnswer && last.purpose === 'grounded-answer'
    ? classifyAstraModelWorkFailure(finalSnapshot) ?? 'model-response-invalid' : undefined;
  return { schemaVersion: 'monarch.astra-v3-model-read-certificate.internal.v1', taskId: record.taskId,
    goalDigest: record.goalDigest, policyDigest: record.policyDigest, status: record.terminalStatus,
    ...(record.stopReason ? { reason: record.stopReason } : {}), nativeCompletionCertified: false,
    temporalSemantics: 'snapshot-at-execution', ...proof, ...(classified ? { failure: classified } : {}) };
}
