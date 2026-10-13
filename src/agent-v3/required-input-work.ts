import { type AstraJson, type AstraJournalAccess, type AstraJournalSnapshot } from './journal';
import { modelReadCheck as check, modelReadDigest as digest, modelReadIdentity as id, modelReadJson as json, modelReadSame as same } from './model-read-task-state';
import type { AstraReadEvidenceRef } from './read-task-certifier';
import type { AstraWorkAdapter, AstraWorkControl, AstraWorkResult, AstraWorkJob } from './work-scheduler';

/** Typed missing data selected by the host Goal compiler. Literal bytes skip the
 * model entirely; neither kind can grant approval, change a target or infer intent. */
export interface AstraRequiredInput { kind: 'draft-guidance' | 'literal-content'; id: string; question: string; maxUtf8Bytes: number }
export interface AstraRequiredInputWork { taskId: string; goalDigest: string; requirement: AstraRequiredInput;
  predecessorMessageId: string; deadline: number; workId?: string }
interface Checkpoint { schemaVersion: 'monarch.astra-v3-required-input-work.internal.v1'; workId: string;
  inputDigest: string; status: 'issued' | 'paused' | 'cancelled' | 'blocked'; quiescent: true }
export interface AstraRequiredInputQuestion { id: string; digest: string; text: string; predecessorMessageId: string;
  expiresAt: number; origin: 'host-required-input'; inputEvidence: AstraReadEvidenceRef;
  inputKind?: 'literal-content'; maxUtf8Bytes?: number }
export interface AstraRequiredInputProof { job: AstraWorkJob; checkpoint: AstraJournalSnapshot | null }
export function validateAstraRequiredInput(value: AstraRequiredInput): void {
  check(value && Object.keys(value).every(key => ['kind', 'id', 'question', 'maxUtf8Bytes'].includes(key))
    && ['draft-guidance', 'literal-content'].includes(value.kind) && id(value.id) && typeof value.question === 'string'
    && value.question.trim().length > 0 && Buffer.byteLength(value.question) <= 4096
    && Number.isSafeInteger(value.maxUtf8Bytes) && value.maxUtf8Bytes >= (value.kind === 'literal-content' ? 0 : 1)
    && value.maxUtf8Bytes <= 4096, 'required-input-spec');
  digest(value);
}
export const requiredInputWorkId = (scope: string, job: string): string => 'input_work_' + digest({ scope, job }).slice(7,39);
export function inspectAstraRequiredInput(proof: AstraRequiredInputProof, expected: AstraRequiredInputWork): AstraRequiredInputQuestion | null {
  const job = proof.job, input = job.input as unknown as AstraRequiredInputWork;
  check(job.adapterId === 'goal-required-input' && job.adapterVersion === 'v1' && same(input, expected), 'required-input-job');
  if (!proof.checkpoint) { check(job.state === 'blocked' && job.activationGeneration === 0 && !job.result, 'required-input-proof-missing'); return null; }
  const snapshot = proof.checkpoint, cp = snapshot.checkpoint as unknown as Checkpoint;
  check(snapshot.streamId === input.workId && cp.schemaVersion === 'monarch.astra-v3-required-input-work.internal.v1'
    && cp.workId === input.workId && cp.inputDigest === digest(input) && cp.quiescent && job.result?.checkpointRef === snapshot.streamId
    && job.result.checkpointRevision === snapshot.revision && ['issued', 'paused', 'cancelled', 'blocked'].includes(cp.status), 'required-input-frontier');
  check(job.state === ({ issued: 'observed', paused: 'paused', cancelled: 'cancelled', blocked: 'blocked' } as const)[cp.status], 'required-input-state');
  if (cp.status !== 'issued') return null;
  const question = { id: 'required_question_' + digest({ taskId: input.taskId, goalDigest: input.goalDigest }).slice(7,39),
    text: input.requirement.question, predecessorMessageId: input.predecessorMessageId, expiresAt: input.deadline,
    ...(input.requirement.kind === 'literal-content' ? { inputKind: 'literal-content' as const, maxUtf8Bytes: input.requirement.maxUtf8Bytes } : {}),
    origin: 'host-required-input' as const, inputEvidence: { streamId: snapshot.streamId, revision: snapshot.revision, commitHash: snapshot.commitHash } };
  return { ...question, digest: digest({ goalDigest: input.goalDigest, requirement: input.requirement, ...question }) };
}

/** Pure local work pack on the existing scheduler. Observed means the host's
 * question was durably issued, NEVER that an answer, permission or effect exists.
 * No Kernel, model, provider, filesystem, timer, private queue or process handles. */
export class AstraRequiredInputWorkAdapter implements AstraWorkAdapter {
  readonly id = 'goal-required-input'; readonly version = 'v1';
  constructor(private readonly options: { journal: AstraJournalAccess; isCurrent(input: AstraRequiredInputWork): boolean }) {}
  compile(raw: AstraJson, context: { scopeId: string; jobId: string; controlBudget: number }): ReturnType<AstraWorkAdapter['compile']> {
    const input = this.input(raw), workId = requiredInputWorkId(context.scopeId, context.jobId);
    check(!input.workId || input.workId === workId, 'required-input-identity'); check(this.options.isCurrent({ ...input, workId }), 'required-input-source-stale');
    const normalized = { ...input, workId }, commits = 8 + 2 * context.controlBudget;
    return { input: json(normalized), bindingDigest: digest(normalized), resources: { kernelSlots: 0, modelSlots: 0,
      declaredBytes: 32768, exclusiveKeys: [] }, storage: { maxActivations: 4 + context.controlBudget,
      streams: [{ streamId: workId, commits, eventBytes: commits * 4096, checkpointBytes: 4096 }] } };
  }
  async execute(raw: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult> {
    check(control.isCurrent(), 'required-input-fenced'); const input = this.input(raw);
    return this.set(input, this.options.isCurrent(input) ? 'issued' : 'blocked', control.journal, control.ownerIsCurrent);
  }
  control(raw: AstraJson, command: 'pause' | 'resume' | 'cancel', owner: () => boolean, journal: AstraJournalAccess): AstraWorkResult {
    const input = this.input(raw);
    if (command === 'resume') check(this.options.isCurrent(input), 'required-input-source-stale');
    return this.set(input, command === 'cancel' ? 'cancelled' : command === 'pause' ? 'paused' : 'issued', journal, owner);
  }
  reconcile(raw: AstraJson, owner: () => boolean, journal: AstraJournalAccess): AstraWorkResult {
    const input = this.input(raw), existing = journal.read(input.workId!);
    return this.set(input, existing ? (existing.checkpoint as unknown as Checkpoint).status : this.options.isCurrent(input) ? 'issued' : 'blocked', journal, owner);
  }
  private input(raw: AstraJson): AstraRequiredInputWork {
    check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every(key =>
      ['taskId', 'goalDigest', 'requirement', 'predecessorMessageId', 'deadline', 'workId'].includes(key)), 'required-input-shape');
    const input = raw as unknown as AstraRequiredInputWork; validateAstraRequiredInput(input.requirement);
    check(id(input.taskId) && /^sha256:[a-f0-9]{64}$/u.test(input.goalDigest) && id(input.predecessorMessageId)
      && Number.isSafeInteger(input.deadline) && input.deadline > 0 && (!input.workId || id(input.workId)), 'required-input-binding'); return input;
  }
  private set(input: AstraRequiredInputWork, status: Checkpoint['status'], journal: AstraJournalAccess, owner: () => boolean): AstraWorkResult {
    check(input.workId && owner(), 'required-input-owner'); let snapshot = journal.read(input.workId);
    const checkpoint: Checkpoint = { schemaVersion: 'monarch.astra-v3-required-input-work.internal.v1', workId: input.workId,
      inputDigest: digest(input), status, quiescent: true };
    if (snapshot) check((snapshot.checkpoint as unknown as Checkpoint).inputDigest === checkpoint.inputDigest, 'required-input-substitution');
    if (!snapshot || !same(snapshot.checkpoint, checkpoint)) {
      check(owner(), 'required-input-owner'); journal.append({ streamId: input.workId, expectedRevision: snapshot?.revision ?? 0,
        requestId: 'input_' + input.workId + '_' + ((snapshot?.revision ?? 0) + 1), checkpoint: json(checkpoint), events: [{ type: 'required-input.' + status }] });
      snapshot = journal.read(input.workId)!;
    }
    return { state: ({ issued: 'observed', paused: 'paused', cancelled: 'cancelled', blocked: 'blocked' } as const)[status],
      progressDigest: digest(checkpoint), checkpointRef: input.workId, checkpointRevision: snapshot.revision };
  }
}
