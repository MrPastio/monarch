import { createHash } from 'node:crypto';
import type { MonarchActionLedgerRecord } from '../core/contracts';
import { astraCapabilityResultDigest, astraCapabilityResultProjection, type AstraCapabilityObservation } from './capability-work-adapter';
import type { AstraAgentTaskRecord } from './agent-task-profile';
import { astraJournalJson, type AstraJson, type AstraJournalSnapshot } from './journal';
import { astraModelWorkProgressDigest, type AstraModelWorkCheckpoint, type AstraModelWorkInput } from './model-work-adapter';
import type { AstraWorkJob } from './work-scheduler';

export interface AstraAgentTaskCertificate {
  schemaVersion: 'monarch.astra-v3-agent-task-certificate.internal.v1';
  taskId: string;
  scopeId: string;
  requestDigest: string;
  sourceDigest: string;
  status: 'completed';
  responseDigest: string;
  modelTurns: number;
  capabilityCalls: number;
  proposalDigest: string;
  modelProgressDigest: string;
  evidenceRefs: string[];
  modelEvidence: { jobId: string; streams: Array<{ streamId: string; revision: number; commitHash: string }> };
  receipts: Array<{ ref: string; round: number; capabilityId: string; ledgerId: string; idempotencyKey: string;
    proposalHash: string; resultDigest: string; ok: boolean }>;
  authority: 'none';
  temporalSemantics: 'model-completion-after-kernel-receipts';
  businessCompletionCertified: false;
  nativeCompletionCertified: true;
}

export interface AstraAgentTaskCertificationInput {
  scopeId: string;
  record: AstraAgentTaskRecord;
  finalJob: AstraWorkJob;
  finalStreams: AstraJournalSnapshot[];
  ledgerRecords: MonarchActionLedgerRecord[];
}

const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown): boolean => astraJournalJson(json(left)) === astraJournalJson(json(right));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const capabilityId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-agent-certifier:' + code); }

export function astraAgentCertificateDigest(certificate: AstraAgentTaskCertificate): string {
  return sha(astraJournalJson(json(certificate)));
}

export function validateAstraAgentTaskCertificate(value: AstraAgentTaskCertificate): void {
  check(value?.schemaVersion === 'monarch.astra-v3-agent-task-certificate.internal.v1'
    && id(value.taskId) && id(value.scopeId) && hash(value.requestDigest) && hash(value.sourceDigest)
    && value.status === 'completed' && hash(value.responseDigest)
    && Number.isSafeInteger(value.modelTurns) && value.modelTurns >= 1 && value.modelTurns <= 64
    && Number.isSafeInteger(value.capabilityCalls) && value.capabilityCalls >= 0 && value.capabilityCalls <= 48
    && hash(value.proposalDigest) && hash(value.modelProgressDigest)
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.length <= 32
    && new Set(value.evidenceRefs).size === value.evidenceRefs.length && value.evidenceRefs.every(id)
    && value.modelEvidence && id(value.modelEvidence.jobId) && Array.isArray(value.modelEvidence.streams)
    && value.modelEvidence.streams.length >= 1 && value.modelEvidence.streams.length <= 8
    && new Set(value.modelEvidence.streams.map(item => item.streamId)).size === value.modelEvidence.streams.length
    && value.modelEvidence.streams.every(item => id(item.streamId) && Number.isSafeInteger(item.revision)
      && item.revision > 0 && hash(item.commitHash))
    && Array.isArray(value.receipts) && value.receipts.length <= 48
    && new Set(value.receipts.map(item => item.ref)).size === value.receipts.length
    // One ledger record may back two rounds: a repeated effectful action is
    // answered by Kernel with the receipt of the single effect that happened.
    && value.receipts.every(item => id(item.ref) && Number.isSafeInteger(item.round) && item.round >= 0 && item.round < 64
      && capabilityId(item.capabilityId) && id(item.ledgerId) && /^action:[a-f0-9]{64}$/u.test(item.idempotencyKey)
      && /^[a-f0-9]{64}$/u.test(item.proposalHash) && hash(item.resultDigest) && typeof item.ok === 'boolean')
    && value.evidenceRefs.every(ref => value.receipts.some(receipt => receipt.ref === ref))
    && value.authority === 'none' && value.temporalSemantics === 'model-completion-after-kernel-receipts'
    && value.businessCompletionCertified === false && value.nativeCompletionCertified === true,
  'certificate-shape');
}

/** Pure terminal certifier over the exact final model frontier and live Kernel
 * receipts. It never executes a capability, calls a model or claims that the
 * user's real-world business goal is true. */
export function certifyAstraAgentTask(input: AstraAgentTaskCertificationInput): AstraAgentTaskCertificate {
  const { record, finalJob } = input;
  check(id(input.scopeId) && record.schemaVersion === 'monarch.astra-v3-agent-task.internal.v3'
    && id(record.taskId) && hash(record.requestDigest) && hash(record.sourceDigest)
    && record.phase === 'settled' && record.terminalStatus === 'completed' && record.desired === 'run'
    && typeof record.responseText === 'string' && record.responseText.length > 0 && record.responseText.length <= 4096
    && record.question === undefined && record.rounds.length >= 1, 'terminal-record');
  const finalRound = record.rounds.at(-1)!;
  check(finalRound.modelDecision?.kind === 'complete' && finalRound.modelDecision.text === record.responseText
    && hash(finalRound.modelEvidenceDigest) && record.settledJobId === finalRound.modelJobId, 'completion-proposal');
  const proposalDigest = sha(astraJournalJson(json(finalRound.modelDecision)));

  check(finalJob.id === record.settledJobId && finalJob.adapterId === 'goal-agent-model'
    && finalJob.adapterVersion === 'v1' && finalJob.state === 'observed' && finalJob.result?.state === 'observed'
    && finalJob.result.progressDigest === finalRound.modelEvidenceDigest, 'final-job');
  const envelope = finalJob.input as unknown as { taskId?: unknown; round?: unknown; model?: AstraModelWorkInput };
  check(envelope.taskId === record.taskId && envelope.round === finalRound.index && envelope.model
    && envelope.model.workId === finalJob.result.checkpointRef, 'final-job-input');

  const expectedStreamIds = finalJob.storage.streams.map(stream => stream.streamId);
  check(input.finalStreams.length === expectedStreamIds.length && new Set(expectedStreamIds).size === expectedStreamIds.length
    && new Set(input.finalStreams.map(stream => stream.streamId)).size === input.finalStreams.length
    && input.finalStreams.every(stream => expectedStreamIds.includes(stream.streamId)
      && Number.isSafeInteger(stream.revision) && stream.revision > 0 && hash(stream.commitHash)), 'model-stream-set');
  const effect = input.finalStreams.find(stream => stream.streamId === finalJob.result!.checkpointRef);
  const checkpoint = effect?.checkpoint as unknown as AstraModelWorkCheckpoint | undefined;
  check(effect && effect.revision === finalJob.result.checkpointRevision
    && checkpoint?.schemaVersion === 'monarch.astra-v3-model-work.internal.v1'
    && checkpoint.workId === envelope.model.workId && checkpoint.phase === 'settled'
    && checkpoint.desired === 'run' && checkpoint.quiescent === true && checkpoint.decision?.status === 'accepted'
    && same(checkpoint.decision.proposal, finalRound.modelDecision)
    && astraModelWorkProgressDigest(checkpoint) === finalJob.result.progressDigest, 'model-frontier');
  const context = checkpoint.contextFrontier && input.finalStreams.find(stream => stream.streamId === checkpoint.contextFrontier!.streamId);
  check(context && context.revision === checkpoint.contextFrontier!.revision
    && context.commitHash === checkpoint.contextFrontier!.commitHash, 'context-frontier');

  const observedRounds = record.rounds.filter(round => round.observation);
  check(input.ledgerRecords.length === observedRounds.length
    && observedRounds.every((round, index) => input.ledgerRecords[index]!.ledgerId === round.observation!.ledgerId), 'ledger-set');
  const receipts: AstraAgentTaskCertificate['receipts'] = observedRounds.map(round => {
    const observation = round.observation!, action = round.action;
    const ledger = input.ledgerRecords.find(item => item.ledgerId === observation.ledgerId);
    const candidate = action && record.candidates.find(item => item.capabilityId === action.capabilityId);
    check(action && candidate && ledger && id(ledger.ledgerId) && /^action:[a-f0-9]{64}$/u.test(ledger.idempotencyKey)
      && ledger.intentId === record.taskId && ledger.capabilityId === action.capabilityId && ledger.moduleId === candidate.moduleId
      && ledger.proposalHash === observation.proposalHash && /^[a-f0-9]{64}$/u.test(observation.proposalHash)
      && ledger.result && ['completed', 'failed'].includes(ledger.status)
      && (ledger.status === 'completed') === ledger.result.ok
      && ledger.result.ok === observation.result.ok
      && (ledgerResultMatches(ledger, observation)), 'kernel-receipt');
    return { ref: 'receipt_' + round.index, round: round.index, capabilityId: action.capabilityId,
      ledgerId: ledger.ledgerId, idempotencyKey: ledger.idempotencyKey, proposalHash: observation.proposalHash,
      resultDigest: observation.resultDigest, ok: observation.result.ok };
  });
  check(finalRound.modelDecision.evidenceRefs.every(ref => receipts.some(receipt => receipt.ref === ref)), 'completion-evidence');

  const certificate: AstraAgentTaskCertificate = { schemaVersion: 'monarch.astra-v3-agent-task-certificate.internal.v1', taskId: record.taskId,
    scopeId: input.scopeId, requestDigest: record.requestDigest, sourceDigest: record.sourceDigest, status: 'completed',
    responseDigest: sha(record.responseText), modelTurns: record.rounds.length,
    capabilityCalls: record.rounds.filter(round => round.capabilityJobId).length,
    proposalDigest, modelProgressDigest: finalRound.modelEvidenceDigest,
    evidenceRefs: [...finalRound.modelDecision.evidenceRefs], modelEvidence: { jobId: finalJob.id,
      streams: input.finalStreams.map(stream => ({ streamId: stream.streamId, revision: stream.revision, commitHash: stream.commitHash })) },
    receipts, authority: 'none', temporalSemantics: 'model-completion-after-kernel-receipts',
    businessCompletionCertified: false, nativeCompletionCertified: true };
  validateAstraAgentTaskCertificate(certificate); return certificate;
}

/** The live receipt carries the full result. After a restart Kernel keeps only
 * a bounded copy plus the digest it recorded when the action finished; that
 * digest, the observation's own projection and its digest must then agree. */
function ledgerResultMatches(ledger: MonarchActionLedgerRecord,
  observation: { resultDigest: string; result: AstraCapabilityObservation['result'] }): boolean {
  const result = ledger.result!;
  if (astraCapabilityResultDigest(result) === observation.resultDigest
    && same(astraCapabilityResultProjection(result), observation.result)) return true;
  return typeof ledger.resultDigest === 'string' && ledger.resultDigest === observation.resultDigest
    && astraCapabilityResultDigest(observation.result as unknown as Parameters<typeof astraCapabilityResultDigest>[0]) === observation.resultDigest;
}
