import { createHash } from 'node:crypto';
import { astraJournalJson, type AstraJson } from './journal';
import { astraReadValueDigest, type AstraReadTaskGoal, type AstraReadRequirementResult,
  type AstraReadEvidenceRef, type AstraReadSelection, type AstraReadSourceKey } from './read-task-certifier';
import { AstraReadWorkflow, type AstraReadWorkflowRequest } from './read-workflow';
import { astraReadWorkRequestId } from './read-work-adapter';
import { astraWorkJobId, type AstraWorkState } from './work-scheduler';
import type { AstraModelWorkInput } from './model-work-adapter';
import type { AstraContextLimits } from './context-engine';
import type { AstraReadCandidate } from './read-decision-gateway';
import type { AstraModelFailureCategory } from './model-failure-presentation';
import type { AstraMemoryRecallSnapshot } from './memory-recall';

export interface AstraModelReadSelection extends AstraReadSelection {
  userText: string;
  /** Prepared by the local source owner, never model/HTTP task input. */
  memoryRecall?: AstraMemoryRecallSnapshot;
  /** Explicit source-selected semantic output. Absence preserves the historical
   * evidence-only read pack and never spends another model call. */
  answerMode?: 'grounded-model';
}
export interface AstraModelReadAdmissionPort {
  resolve(source: AstraReadSourceKey): AstraModelReadSelection;
  isCurrent(source: AstraReadTaskGoal['source']): boolean;
}
export interface AstraModelReadPolicy {
  expectedModelDigest: string; maxOutputTokens: number; modelTimeoutMs: number;
  maxModelAttempts: number; contextLimits: Partial<AstraContextLimits>;
}
export interface AstraModelReadRound {
  index: number; modelJobId?: string; modelEvidence?: AstraReadEvidenceRef;
  selectedRequirementId?: string; readJobId?: string;
  purpose?: 'deterministic-read' | 'grounded-answer'; responseText?: string;
}
export interface AstraModelReadTaskRecord {
  schemaVersion: 'monarch.astra-v3-model-read-task.internal.v1';
  taskId: string; requestDigest: string; goal: AstraReadTaskGoal; goalDigest: string;
  userText: string; policy: AstraModelReadPolicy; policyDigest: string;
  memoryRecall?: AstraMemoryRecallSnapshot;
  createdAt: number; startBy: number; deadline: number; reservationId: string;
  phase: 'model' | 'read' | 'settled' | 'certified'; desired: 'run' | 'pause' | 'cancel';
  controlCount: number; rounds: AstraModelReadRound[];
  answerMode?: 'grounded-model';
  stopReason?: string; terminalStatus?: 'completed' | 'partial' | 'failed' | 'cancelled' | 'blocked';
  certificateDigest?: string;
}
export interface AstraModelReadTaskCertificate {
  schemaVersion: 'monarch.astra-v3-model-read-certificate.internal.v1';
  taskId: string; goalDigest: string; policyDigest: string;
  status: NonNullable<AstraModelReadTaskRecord['terminalStatus']>; reason?: string;
  nativeCompletionCertified: false; temporalSemantics: 'snapshot-at-execution';
  requirements: AstraReadRequirementResult[];
  rounds: Array<{ index: number; modelJobId?: string; modelEvidence?: AstraReadEvidenceRef | null;
    purpose?: 'deterministic-read' | 'grounded-answer'; readJobId?: string; workflowEvidence?: AstraReadEvidenceRef }>;
  /** Model-authored narrative bound to certified read frontiers. It remains a
   * model answer, not a native truth or execution certificate. */
  modelAnswer?: { text: string; modelEvidence: AstraReadEvidenceRef };
  failure?: AstraModelFailureCategory;
}
export interface AstraModelReadTaskMessage {
  id: string; taskId: string; interactionId: string; predecessorMessageId: string;
  certificateDigest: string; content: string; delivery: 'pending' | 'acknowledged';
}
export interface AstraModelReadTaskView {
  taskId: string; status: AstraWorkState | 'awaiting-progression' | 'completed';
  phase: AstraModelReadTaskRecord['phase']; desired: AstraModelReadTaskRecord['desired'];
  activeJobId: string; modelJobs: number; readJobs: number; nativeCompletionCertified: false;
  certificate?: AstraModelReadTaskCertificate; message?: AstraModelReadTaskMessage;
}
export const modelReadJson = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
export const modelReadDigest = (value: unknown): string => astraReadValueDigest(modelReadJson(value));
export function modelReadCheck(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-model-read-task:' + code); }
export const modelReadIdentity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
export const modelReadSettled = (state: AstraWorkState): boolean => ['observed', 'partial', 'failed', 'cancelled', 'blocked'].includes(state);
const shortHash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);
export const modelReadTaskId = (scope: string, requestId: string): string => 'model_task_' + shortHash(scope + '/' + requestId);
export const modelReadChildRequestId = (taskId: string, round: number, kind: 'model' | 'read'): string =>
  'goal_' + kind + '_' + shortHash(taskId + '/' + round);
export const modelReadChildJobId = (taskId: string, round: number, kind: 'model' | 'read'): string =>
  astraWorkJobId(modelReadChildRequestId(taskId, round, kind));
export const modelReadReservationId = (taskId: string): string => 'model_task_budget_' + shortHash(taskId);
export const modelReadActiveJob = (record: AstraModelReadTaskRecord): string => {
  const round = record.rounds.at(-1)!, jobId = round.readJobId ?? round.modelJobId;
  modelReadCheck(jobId, 'active-job'); return jobId;
};
export function modelReadWorkflow(record: AstraModelReadTaskRecord, index: number, requirementId: string): AstraReadWorkflowRequest {
  const requirement = record.goal.requirements.find(item => item.id === requirementId);
  modelReadCheck(requirement, 'unknown-requirement');
  const { id, relativePath, maxBytes, timeoutMs } = requirement;
  return { requestId: astraReadWorkRequestId(record.goal.schedulerScopeId, modelReadChildJobId(record.taskId, index, 'read')),
    steps: [{ id, relativePath, maxBytes, timeoutMs, dependsOn: [] }] };
}
export function modelReadCandidates(record: AstraModelReadTaskRecord, index: number): AstraReadCandidate[] {
  // A previous round enters this set only AFTER its exact read proof was checked
  // and the next round was committed. Models never introduce targets/dependencies.
  const satisfied = new Set(record.rounds.slice(0, index).map(round => round.selectedRequirementId));
  return record.goal.requirements.filter(item => !satisfied.has(item.id) && item.dependsOn.every(id => satisfied.has(id)))
    .map(item => {
      const compiled = AstraReadWorkflow.compile(modelReadWorkflow(record, index, item.id), record.goal.scopeDigest);
      const step = compiled.steps[0]!;
      return { handle: 'read_' + item.id, requirementId: item.id, targetHandle: 'target_' + item.id,
        request: { requestId: step.readRequestId, relativePath: item.relativePath, maxBytes: item.maxBytes, timeoutMs: item.timeoutMs } };
    });
}
export interface AstraModelReadWorkEnvelope { taskId: string; round: number; model?: AstraModelWorkInput; read?: AstraReadWorkflowRequest }
export function modelReadUnpack(value: AstraJson): AstraModelReadWorkEnvelope {
  modelReadCheck(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['taskId', 'round', 'model', 'read'].includes(key)), 'work-envelope');
  const input = value as unknown as AstraModelReadWorkEnvelope;
  modelReadCheck(modelReadIdentity(input.taskId) && Number.isSafeInteger(input.round) && input.round >= 0 && input.round < 9
    && !(input.model && input.read), 'work-envelope'); return input;
}
export function renderAstraModelReadCertificate(certificate: AstraModelReadTaskCertificate): string {
  if (certificate.status === 'completed' && certificate.modelAnswer) return certificate.modelAnswer.text;
  if (certificate.rounds.some(round => round.purpose === 'deterministic-read' || round.purpose === 'grounded-answer')) {
    if (certificate.status === 'cancelled') return 'Задача отменена.';
    if (certificate.failure === 'model-connection-unavailable')
      return 'Модель не ответила. Проверь подключение MAX и отправь задачу снова.';
    if (certificate.failure === 'model-safety-blocked')
      return 'Проверка безопасности остановила задачу. Измени запрос или выбранные файлы и попробуй снова.';
    if (certificate.failure === 'model-response-invalid')
      return 'Модель вернула ответ, который Оскар не смог безопасно использовать. Сформулируй задачу точнее и отправь её снова.';
    return 'Оскар не смог прочитать все выбранные файлы. Проверь, что они существуют и доступны, затем выбери их заново и отправь задачу снова.';
  }
  const passed = certificate.requirements.filter(item => item.state === 'satisfied');
  const labels = { completed: 'Готово.', partial: 'Выполнено частично.', failed: 'Задача не выполнена.',
    cancelled: 'Задача отменена.', blocked: 'Задача заблокирована.' };
  return `${labels[certificate.status]} Прочитано файлов: ${passed.length}/${certificate.requirements.length}. `
    + `Получено UTF-8 байт: ${passed.reduce((sum, item) => sum + item.observation!.sizeBytes, 0)}. Данные относятся к моменту выполнения.`;
}
export const modelReadSame = (left: unknown, right: unknown): boolean =>
  astraJournalJson(modelReadJson(left)) === astraJournalJson(modelReadJson(right));
