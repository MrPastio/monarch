import { traceMonarchStartup } from '../core/startup-timing';
import { createHash, randomUUID } from 'node:crypto';
import { isMaxNativeRole, maxNativeErrorText } from '../agent-v3/max-native-contract';
import type {
  AgentEvidenceReference,
  AgentTaskExecutionProfile,
  AgentTaskSource,
} from '../agent-protocol';
import { redactAgentContextValue } from '../agent-protocol';
import { ClaimIntegrityGate, isCreativeWritingRequest } from './claim-integrity';
import { isOscarTextAttachmentMimeType, readOscarTextAttachment } from './attachment-store';
import type { AstraAgentInitialEvidenceItem } from '../agent-v3/agent-task-profile';
import { isAstraAgentTaskSpecification, type AstraAgentTaskSpecification } from '../agent-v3/agent-task-contract';
import { validateAstraAuthenticatedActor, type OscarAstraPort, type OscarAstraSelection, type OscarAstraInput } from './astra-contract';
import type { AstraTaskHttpTask } from '../app/astra-task-facade';
import type { AstraAuthenticatedHttpActor } from '../app/astra-task-facade';
import { hasRecoverableLegacyTerminalOutput } from './turn-store';
import { classifyOscarRequestDisposition, isOscarCapabilitiesOrIdentityRequest, isOscarDirectAccessAnswerOnlyRequest, isOscarSmallTalk } from '../core/intent-classifier';
import { policyReasonKind, type MonarchPolicyReasonKind } from '../core/policy-reason';
import type { MonarchPolicyEvidence } from '../core/contracts';
import { oscarDirectToolAccessActive } from './direct-tool-access';
import { isCustomModelRole } from '../modules/models/custom-model-contract';
import { describeReminderTime, parseReminderCommand, type ParsedReminderCommand } from '../modules/reminders/reminder-time';
import type { MonarchReminderV1 } from '../modules/reminders/reminder-store';
import {
  classifyOscarServerDisposition,
  extractExplicitMemoryText,
  isNonAuthoritativeConfirmationText,
  researchThenActDisposition,
  type OscarStructuredDispositionProvider,
  type OscarServerDisposition,
} from './disposition';
import {
  MESSAGE_PROVENANCE_SCHEMA_VERSION,
  OSCAR_TURN_SCHEMA_VERSION,
  type MessageProvenanceV1,
  type OscarPrivacyMode,
  type OscarTurnCheckpoint,
  type OscarTurnEventDraft,
  type OscarTurnFailureDiagnostic,
  type OscarTurnModifiers,
  type OscarTurnOutcomeKind,
  type OscarTurnOutboxItem,
  type OscarTurnRequestSnapshot,
  type OscarTurnSource,
  type OscarTurnStatus,
  type OscarTurnStore,
  type OscarTurnV1,
} from './types';

export interface OscarTurnAttachmentPayload {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  digest: string;
  dataBase64: string;
}

export type OscarAnswerExecutorEvent =
  | { type: 'token'; token: string }
  | { type: 'replace'; content: string }
  | { type: 'sources'; sources: unknown[] }
  /** The queries the answer model wrote for the search; shown instead of the raw request. */
  | { type: 'search'; queries: string[] }
  /** A research step (planning, reading sources, checking for gaps) shown while it runs. */
  | { type: 'progress'; stage: OscarResearchStage; detail: string }
  | { type: 'done'; usage?: Record<string, unknown>; cancelled?: boolean; ok?: boolean; failure?: string }
  | { type: 'error'; message: string };

export type OscarResearchStage = 'plan' | 'search' | 'read' | 'verify' | 'write';

const RESEARCH_STAGE_ACTIVITY: Readonly<Record<OscarResearchStage, { operation: string; label: string }>> = {
  plan: { operation: 'think', label: 'Исследование · план' },
  search: { operation: 'search', label: 'Поиск · Интернет' },
  read: { operation: 'read', label: 'Исследование · чтение' },
  verify: { operation: 'verify', label: 'Исследование · проверка' },
  write: { operation: 'answer', label: 'Исследование · вывод' },
};

export interface OscarAnswerExecutionInput {
  turn: OscarTurnV1;
  attachments: OscarTurnAttachmentPayload[];
  signal: AbortSignal;
}

export interface OscarAnswerFallbackResult {
  answer: string;
  sources?: unknown[];
  usage?: Record<string, unknown>;
}

export interface OscarMemoryWriteResult {
  receiptId: string;
  revision: number;
  contentHash: string;
}

export interface OscarPersistedMessage {
  /** Internal delivery receipt only, never native completion authority. */
  astraCertificateDigest?: string;
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  /** Exact source/literal bytes for Astra history; not execution authority. */
  contentMode?: 'exact';
  /** A late Astra reply belongs to its exact user message, not the latest chat row. */
  historyLinkMode?: 'same-turn-user';
  turnId: string;
  taskId?: string;
  provenance: MessageProvenanceV1;
  outcome?: OscarTurnOutcomeKind;
  integrityWarning?: string;
  sources?: unknown[];
  /** How the web research behind this answer went, for the chat after a reload. */
  researchSteps?: OscarResearchTraceStep[];
  attachments?: Array<{ id: string; digest: string; name: string; mimeType: string; sizeBytes: number }>;
  usage?: Record<string, unknown>;
  source?: OscarTurnSource;
  privacyMode?: OscarPrivacyMode;
  createConversationIfMissing?: boolean;
  requiredPreviousMessageId?: string;
}

export interface OscarMessagePersistenceReceipt {
  disposition: 'created' | 'duplicate' | 'superseded';
}

export interface SubmitOscarTurnInput {
  /** Explicit trusted local host selection; not accepted by public Turn HTTP. */
  astra?: OscarAstraSelection;
  /** Trusted transport metadata, never copied from the public JSON body. */
  astraActor?: AstraAuthenticatedHttpActor;
  /** Trusted principal retained so Direct Access or semantic routing can bind
   * an ordinary persistent Agent Turn to the same V3 owner. */
  authenticatedAgentActor?: AstraAuthenticatedHttpActor;
  clientRequestId: string;
  conversationId: string;
  text: string;
  privacyMode: OscarPrivacyMode;
  source: OscarTurnSource;
  inputMessageId?: string;
  attachmentIds?: string[];
  modifiers?: OscarTurnModifiers;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  telegramActor?: AgentTaskSource['telegram'];
  replyToTurnId?: string;
  supersedesTurnId?: string;
  retryOf?: string;
  /** Internal-only trusted profile supplied by the local Coder surface. */
  executionProfile?: AgentTaskExecutionProfile;
  /** Internal-only typed admission supplied by /api/agent/tasks. This is an
   * endpoint decision, never a phrase/keyword activator. */
  explicitAgentTask?: AstraAgentTaskSpecification;
}

export interface OscarTurnCoordinatorOptions {
  astra?: OscarAstraPort | undefined;
  persistentStore: OscarTurnStore;
  volatileStore: OscarTurnStore;
  answerExecutor: (input: OscarAnswerExecutionInput) => Promise<AsyncIterable<OscarAnswerExecutorEvent>>;
  answerFallback?: (input: OscarAnswerExecutionInput) => Promise<OscarAnswerFallbackResult>;
  /** Local answer for a MAX chat turn whose cloud answer failed. Returns null
   * when the owner switched this off or no local model can answer. */
  maxLocalFallback?: (input: OscarAnswerExecutionInput) => Promise<AsyncIterable<OscarAnswerExecutorEvent> | null>;
  /** Whether the owner's "answer locally when MAX is silent" switch applies now. */
  maxLocalFallbackAllowed?: () => boolean;
  persistMessage: (message: OscarPersistedMessage) => Promise<void | OscarMessagePersistenceReceipt>;
  resolveAttachments?: (
    ids: string[],
    privacyMode: OscarPrivacyMode,
    source: OscarTurnSource,
    conversationId: string,
  ) => Promise<OscarTurnAttachmentPayload[]>;
  consumeDataEgressConsent?: (consentId: string, turn: OscarTurnV1) => Promise<void>;
  /** Public search for a task that must act on what it finds ("найди новости
   * и отправь их мне"). The agent has no internet of its own; the host
   * searches under the Turn's consent and hands the result to the task as
   * untrusted evidence. */
  researchEvidence?: (input: { query: string; deep: boolean; signal: AbortSignal }) => Promise<string>;
  rememberMemory?: (input: { turn: OscarTurnV1; text: string }) => Promise<OscarMemoryWriteResult>;
  /** Reminders asked for in the chat («напомни …»): a local store, delivered by the Desktop host. */
  reminders?: {
    create: (input: { text: string; dueAt: Date; recurrence: 'none' | 'daily' | 'weekly'; conversationId: string }) => Promise<MonarchReminderV1>;
    list: () => Promise<MonarchReminderV1[]>;
  };
  resolvePersonality?: (input: {
    conversationId: string;
    source: OscarTurnSource;
    privacyMode: OscarPrivacyMode;
  }) => Promise<OscarTurnV1['request']['personality'] | null>;
  dispositionProvider?: OscarStructuredDispositionProvider;
  getOwnerUnrestrictedOverride?: () => import('../core/contracts').MonarchOwnerUnrestrictedOverride;
  /** @deprecated Turns are now routed adaptively; kept for persisted callers. */
  agentFirst?: boolean;
  claimIntegrityGate?: ClaimIntegrityGate;
  now?: () => Date;
}

const TERMINAL_TURN_STATUSES = new Set<OscarTurnStatus>([
  'succeeded', 'blocked', 'failed', 'cancelled',
]);
const CLIENT_CANCELLATION_TTL_MS = 5 * 60_000;
/**
 * A persistent message ordered after a user message the backend has not stored
 * yet is normally retried and lands in the same drain pass, within seconds.
 * This conflict is reported by a *reachable* backend that looked and did not
 * find the prerequisite, so it never stands for an outage — and once the
 * conversation has been deleted it can never be satisfied, leaving an unbounded
 * retry running one request per minute against the backend forever.
 *
 * `outboxWillDeliverPrerequisite` normally settles that case on the first
 * failure. This cap is only the backstop for a prerequisite that is genuinely
 * queued yet never lands: with the retry backoff capped at a minute, this many
 * consecutive failures means the backend has been reporting the missing
 * prerequisite for hours.
 */
const OUTBOX_PREREQUISITE_ABANDON_ATTEMPTS = 240;
const OUTBOX_PREREQUISITE_PENDING_CODE = 'conversation-message-prerequisite-pending';
const OUTBOX_PREREQUISITE_SCAN_HORIZON_MS = 365 * 24 * 60 * 60_000;
export const OSCAR_TURN_CANCELLED_SUMMARY = 'Задача остановлена. Новые действия и повторные шаги не будут запущены.';

function outboxDispatchPriority(kind: OscarTurnOutboxItem['kind']): number {
  const storedKind: string = kind;
  if (kind === 'astra-control') return -1;
  if (kind === 'astra-input' || kind === 'astra-wake') return 1;
  // Agent creation is local and must not wait for the compatibility backend
  // to persist a chat message. Message ordering remains protected by the
  // assistant item's requiredPreviousMessageId receipt.
  if (kind === 'create-agent-task') return 0;
  if (storedKind === 'send-agent-message' || storedKind === 'reconcile-turn') return 1;
  return 2;
}

export interface OscarClientRequestCancellation {
  clientRequestId: string;
  reserved: boolean;
  checkpoint: OscarTurnCheckpoint | null;
}

export class OscarTurnCoordinator {
  readonly persistentStore: OscarTurnStore;
  readonly volatileStore: OscarTurnStore;
  private readonly options: OscarTurnCoordinatorOptions;
  private readonly gate: ClaimIntegrityGate;
  private readonly answerControllers = new Map<string, AbortController>();
  private readonly routeFlights = new Map<string, Promise<OscarTurnCheckpoint>>();
  private readonly cancelFlights = new Map<string, Promise<OscarTurnCheckpoint>>();
  private readonly executionCancellations = new Set<string>();
  private readonly clientCancellationIntents = new Map<string, number>();
  /** Projection index only; durable Turn Store is authoritative. Never a work queue. */
  private readonly astraTurns = new Set<string>();
  private readonly turnPrivacy = new Map<string, OscarPrivacyMode>();
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private outboxDrain: Promise<void> | null = null;
  private started = false;
  private astraRestoreHeld = false;

  constructor(options: OscarTurnCoordinatorOptions) {
    this.options = options;
    this.persistentStore = options.persistentStore;
    this.volatileStore = options.volatileStore;
    this.gate = options.claimIntegrityGate || new ClaimIntegrityGate();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    let unreconciled: unknown;
    try {
      unreconciled = await this.reconcileStartup(); traceMonarchStartup('oscar-reconcile-ready');
      await this.drainOutbox(); traceMonarchStartup('oscar-outbox-ready');
    }
    catch (error) {
      this.started = false;
      if (this.outboxTimer) clearTimeout(this.outboxTimer); this.outboxTimer = null;
      throw error;
    }
    if (unreconciled !== undefined) {
      // One Astra Turn that cannot be restored must keep the host's restore
      // barrier closed, so this still fails the restore. It used to fail the
      // whole application start instead: the runtime exited, desktop recovery
      // hit the same Turn twice and Monarch closed, unusable until the data was
      // fixed by hand. Chat keeps working; new agent work is refused plainly.
      this.astraRestoreHeld = true;
      throw new OscarAstraRestoreHeldError(unreconciled);
    }
  }

  /** True while an unrestorable Astra Turn keeps agent work paused. */
  isAstraRestoreHeld(): boolean { return this.astraRestoreHeld; }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    await this.outboxDrain?.catch(() => undefined);
    for (const controller of this.answerControllers.values()) controller.abort('shutdown');
    this.answerControllers.clear();
    for (const turn of await this.volatileStore.listTurns()) {
      this.turnPrivacy.delete(turn.id);
      await this.volatileStore.deleteTurn(turn.id);
    }
  }

  /** Host synchronization point for an interaction that depends on a durable
   * Oscar delivery receipt. The second pass covers an item appended while an
   * already-running drain was finishing; failures remain pending and visible. */
  async flushOutbox(): Promise<void> {
    if (!this.started) throw Error('Oscar Turn Coordinator is not started.');
    await this.drainOutbox();
    await this.drainOutbox();
  }

  private requireAstra(): OscarAstraPort {
    if (!this.options.astra) throw new OscarTurnCoordinatorError(503, 'astra-source-unavailable', 'Bound Astra host is unavailable; no legacy fallback.');
    return this.options.astra;
  }

  /** Exact local source control; public/native action-card wiring is separate. */
  async commandAstra(turnId: string, source: OscarTurnSource, desired: 'pause' | 'resume' | 'cancel'): Promise<OscarTurnCheckpoint> {
    const checkpoint = await this.requireTurn(turnId);
    if (!checkpoint.turn.request.astra || checkpoint.turn.source !== source || !['pause', 'resume', 'cancel'].includes(desired))
      throw new OscarTurnCoordinatorError(403, 'astra-source-mismatch', 'Astra control source mismatch.');
    if (TERMINAL_TURN_STATUSES.has(checkpoint.turn.status)) return checkpoint;
    const result = await this.updateTurn(this.storeForTurn(checkpoint.turn), turnId, turn => {
      if (TERMINAL_TURN_STATUSES.has(turn.status) || turn.astraControl?.desired === desired) return { turn, events: [] };
      if (turn.astraControl?.desired === 'cancel') throw new OscarTurnCoordinatorError(409, 'astra-cancelled', 'Cancellation cannot be undone.');
      const sequence = (turn.astraControl?.sequence ?? 0) + 1;
      if (sequence > 32) throw new OscarTurnCoordinatorError(409, 'astra-control-budget', 'Astra control budget exceeded.');
      return { turn: { ...turn, astraControl: { sequence, desired } },
        events: [{ type: 'agent.progress', payload: { runtime: 'astra-v3', control: desired, sequence, settled: false } }],
        outbox: [{ id: `outbox_astra_control_${turn.id}_${sequence}`, turnId, kind: 'astra-control', payload: { sequence, desired } }] };
    });
    this.kickOutbox(); return result;
  }

  async recoverAstra(turnId: string, source: OscarTurnSource, requestId: string): Promise<OscarTurnCheckpoint> {
    const checkpoint = await this.requireTurn(turnId);
    if (!checkpoint.turn.request.astra || checkpoint.turn.source !== source)
      throw new OscarTurnCoordinatorError(403, 'astra-source-mismatch', 'Astra recovery source mismatch.');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(requestId))
      throw new OscarTurnCoordinatorError(400, 'astra-recovery-request', 'Exact recovery request ID required.');
    if (TERMINAL_TURN_STATUSES.has(checkpoint.turn.status)) return checkpoint;
    if (!this.requireAstra().wake) throw new OscarTurnCoordinatorError(503, 'astra-recovery-unavailable', 'Bound host cannot recover.');
    const result = await this.updateTurn(this.storeForTurn(checkpoint.turn), turnId, turn => {
      const requests = turn.astraRecoveryRequests ?? [];
      if (TERMINAL_TURN_STATUSES.has(turn.status) || requests.includes(requestId)) return { turn, events: [] };
      if (requests.length >= 8) throw new OscarTurnCoordinatorError(409, 'astra-recovery-budget', 'Explicit recovery budget exceeded.');
      return { turn: { ...turn, astraRecoveryRequests: [...requests, requestId] },
        events: [{ type: 'agent.progress', payload: { runtime: 'astra-v3', recoveryRequestId: requestId, settled: false } }],
        outbox: [{ id: `outbox_astra_wake_${turn.id}_${requestId}`, turnId, kind: 'astra-wake', payload: { requestId } }] };
    });
    this.kickOutbox(); return result;
  }

  async submitAstraInput(turnId: string, source: OscarTurnSource, input: OscarAstraInput): Promise<OscarTurnCheckpoint> {
    const checkpoint = await this.requireTurn(turnId), turn = checkpoint.turn;
    if (!turn.request.astra || turn.source !== source) throw new OscarTurnCoordinatorError(403, 'astra-source-mismatch', 'Astra input source mismatch.');
    if (!input || !['reply', 'decide'].includes(input.kind)
      || Object.keys(input).some(key => !['kind', input.kind === 'reply' ? 'reply' : 'decision'].includes(key)))
      throw new OscarTurnCoordinatorError(400, 'astra-invalid-input', 'Exact input required.');
    if (input.kind === 'reply') {
      if (!['create', 'agent'].includes(turn.request.astra.goal.kind))
        throw new OscarTurnCoordinatorError(409, 'astra-input-unsupported', 'This Astra goal accepts approval decisions only.');
      const { validateDraftReply } = await import('../agent-v3/model-create-task-state');
      validateDraftReply(input.reply, turn.request.astra.goal.kind === 'create'
        && turn.request.astra.goal.content.kind === 'reply' ? 'literal-content' : 'draft-guidance');
    } else {
      const { validateCreateApprovalDecision } = await import('../agent-v3/create-approval');
      validateCreateApprovalDecision(input.decision);
    }
    const messageId = input.kind === 'reply' ? input.reply.messageId : input.decision.messageId;
    const ordered = input.kind === 'reply' ? ['reply', input.reply.requestId, input.reply.questionId, input.reply.questionDigest, messageId, input.reply.text]
      : ['decide', input.decision.approvalId, input.decision.approvalDigest, messageId, input.decision.decision];
    const digest = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
    const previous = checkpoint.events.find(event => event.payload.astraInputId === messageId);
    if (previous) {
      if (previous.payload.digest !== digest) throw new OscarTurnCoordinatorError(409, 'astra-input-conflict', 'Input message is already bound.');
      return checkpoint;
    }
    if (messageId === turn.inputMessageId || TERMINAL_TURN_STATUSES.has(turn.status) || turn.astraControl?.desired === 'cancel')
      throw new OscarTurnCoordinatorError(409, 'astra-input-conflict', 'Input cannot be bound to this task.');
    const view = this.requireAstra().find(turn);
    if (!view || (input.kind === 'reply' ? view.question?.id !== input.reply.questionId || view.question?.digest !== input.reply.questionDigest
      : view.approval?.id !== input.decision.approvalId || view.approval?.digest !== input.decision.approvalDigest))
      throw new OscarTurnCoordinatorError(409, 'astra-input-binding', 'The exact pending question or approval is required.');
    const content = input.kind === 'reply' ? input.reply.text : input.decision.decision === 'approve' ? 'Подтверждено точное действие Astra.' : 'Действие Astra отклонено.';
    const result = await this.updateTurn(this.storeForTurn(turn), turnId, current => {
      if (TERMINAL_TURN_STATUSES.has(current.status) || current.astraControl?.desired === 'cancel')
        throw new OscarTurnCoordinatorError(409, 'astra-input-conflict', 'Task changed before input commit.');
      return { turn: current,
        events: [{ type: 'agent.progress', payload: { runtime: 'astra-v3', astraInputId: messageId, digest, inputKind: input.kind,
          ...(input.kind === 'decide' ? { approvalId: input.decision.approvalId, decision: input.decision.decision } : {}) } }],
        outbox: [messageOutbox(current, continuationUserMessage(current, messageId, content)),
          { id: `outbox_astra_input_${current.id}_${messageId}`, turnId, kind: 'astra-input', payload: { input: structuredClone(input) } }] };
    });
    this.kickOutbox(); return result;
  }

  /** Projection only: never runs work, infers success, or retries an effect. */
  async reconcileAstraTurn(turnId: string): Promise<void> {
    const checkpoint = await this.requireTurn(turnId), turn = checkpoint.turn;
    if (!turn.request.astra || TERMINAL_TURN_STATUSES.has(turn.status)) { this.astraTurns.delete(turnId); return; }
    const view = this.requireAstra().find(turn); if (!view) return;
    if (turn.taskId !== view.id) return; // Admission outbox must durably link first.
    // The host reports `source-restore-required` only while a launch restores
    // its sources (a failed restore becomes `progression-failed`): it is the
    // startup phase, not a transition. Recording it, and the return a moment
    // later, appended events and re-sent the open question on every launch;
    // live, a waiting Turn had grown to 585 events.
    if (view.runtimeIssue === 'source-restore-required') return;
    const store = this.storeForTurn(turn);
    const fingerprint = createHash('sha256').update(JSON.stringify(view)).digest('hex');
    // A -> issue/B -> A is a REAL transition, not a replay of historical A.
    // Otherwise recovery leaves stale runtime warnings/status in every client.
    const lastProjection = [...checkpoint.events].reverse().find(event => event.payload.runtime === 'astra-v3'
      && (event.payload.astraProjection || event.payload.runtimeIssue));
    if (lastProjection?.payload.astraProjection === fingerprint) return;
    const progress: OscarTurnEventDraft = { type: 'agent.progress', payload: { runtime: 'astra-v3', astraProjection: fingerprint,
      status: view.status, nativeCompletionCertified: view.nativeCompletionCertified,
      ...(view.runtimeIssue ? { runtimeIssue: view.runtimeIssue } : {}), ...astraLiveStep(view) } };
    if (view.message || ['blocked', 'partial', 'cancelled', 'failed'].includes(view.status)) {
      const report = astraTaskReport(view, checkpoint.events);
      if (report.length) progress.payload.taskReport = report;
    }
    if (view.message) {
      const message = view.message;
      const kind: OscarTurnOutcomeKind = view.status === 'cancelled' ? 'cancelled' : view.status === 'failed' ? 'failed'
        : view.status === 'blocked' || view.status === 'expired' ? 'blocked'
          // "Выполнение подтверждено" only when the cited Kernel receipts show
          // the effect happened. A certified completion citing failed receipts
          // was shown as confirmed success (live: two failed writes, "file
          // created"); a reply citing no action is an answer, not an execution.
          : !view.nativeCompletionCertified ? 'partial'
            : view.completionEvidence === 'failed' ? 'blocked'
              : view.completionEvidence === 'mixed' ? 'partial'
                : view.completionEvidence === 'none' ? 'answered' : 'verified';
      const status = kind === 'cancelled' || kind === 'failed' || kind === 'blocked' ? kind : 'succeeded';
      await this.finishTurn(store, turnId, { status, kind,
        summary: message.content,
        ...(message.nativeCompletionCertified ? {} : { warning: 'astra-internal-certificate-not-native-completion' }),
        outputMessageId: message.id,
        events: [progress], outbox: [messageOutbox(turn, { conversationId: turn.conversationId, messageId: message.id,
          turnId, taskId: view.id, role: 'assistant', content: message.content,
          requiredPreviousMessageId: message.predecessorMessageId, astraCertificateDigest: message.certificateDigest,
          provenance: { schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION, origin: 'system', verification: 'system-state', turnId, taskId: view.id }, outcome: kind })] });
      this.astraTurns.delete(turnId);
      return;
    }
    if (['blocked', 'partial', 'cancelled', 'failed'].includes(view.status)) {
      const reason = view.failureReason || `astra-agent-task-${view.status}`;
      const error = Object.assign(new Error(reason), { code: reason });
      const kind: OscarTurnOutcomeKind = view.status === 'cancelled' ? 'cancelled'
        : view.status === 'partial' ? 'partial' : view.status === 'failed' ? 'failed' : 'blocked';
      const status = kind === 'partial' ? 'succeeded' : kind;
      const base = userFacingTurnFailure(error);
      const summary = kind === 'partial'
        ? `${base} Ранее подтверждённые результаты сохранены.`
        : base;
      await this.finishTurn(store, turnId, { status, kind, summary,
        diagnostic: turnFailureDiagnostic(error), events: [progress], taskId: view.id });
      this.astraTurns.delete(turnId);
      this.kickOutbox();
      return;
    }
    if (view.question) {
      const question = view.question;
      await this.updateTurn(store, turnId, current => ({ turn: { ...current, status: 'waiting-for-user', outputMessageId: question.id },
        events: [progress, { type: 'user.input.required', payload: { runtime: 'astra-v3', taskId: view.id, ...question } }],
        outbox: [messageOutbox(current, { conversationId: current.conversationId, messageId: question.id, turnId, taskId: view.id,
          role: 'assistant', content: question.text, requiredPreviousMessageId: question.predecessorMessageId,
          provenance: { schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION, origin: question.origin === 'host-required-input' ? 'system' : 'model',
            verification: question.origin === 'host-required-input' ? 'system-state' : 'unverified-model', turnId, taskId: view.id } })] }));
    } else if (view.approval) {
      const approval = structuredClone(view.approval) as unknown as Record<string, unknown>;
      // Oscar events/UI need the exact reviewed semantic action, not a reusable
      // native handle or the source record. The task retains the full binding.
      if ('action' in approval) {
        const actionWindow = approval.window as { title?: unknown } | undefined;
        delete approval.source; delete approval.window;
        approval.approvalKind = 'computer-action';
        if (typeof actionWindow?.title === 'string') approval.windowTitle = actionWindow.title;
      } else if ('capability' in approval) {
        Object.assign(approval, astraApprovalSecurityPresentation(approval.policySnapshotJson));
        delete approval.source; delete approval.policySnapshotJson;
        approval.approvalKind = 'capability-action';
      }
      await this.updateTurn(store, turnId, current => ({ turn: { ...current, status: 'waiting-for-approval', activeApprovalId: view.approval!.id },
        events: [progress, { type: 'approval.required', payload: { runtime: 'astra-v3', taskId: view.id, ...approval } }] }));
    } else {
      // Unknown effect without a certificate remains pending, including cancel.
      await this.updateTurn(store, turnId, current => {
        const { activeApprovalId: _approval, ...rest } = current;
        return { turn: { ...rest, status: 'running' }, events: [progress] };
      });
    }
  }

  async submit(input: SubmitOscarTurnInput): Promise<OscarTurnCheckpoint> {
    const normalized = normalizeSubmission(input);
    if (input.astraActor && !input.astra) throw new OscarTurnCoordinatorError(400, 'astra-binding-required', 'Actor requires an explicit Astra selection.');
    if (input.authenticatedAgentActor) {
      try { validateAstraAuthenticatedActor(input.authenticatedAgentActor); }
      catch { throw new OscarTurnCoordinatorError(400, 'astra-agent-actor-invalid', 'Authenticated Agent actor is invalid.'); }
      if (input.astra || input.privacyMode !== 'persistent' || input.authenticatedAgentActor.source !== input.source) {
        throw new OscarTurnCoordinatorError(400, 'astra-agent-actor-mismatch', 'Authenticated Agent actor does not match the ordinary Turn source.');
      }
    }
    if (input.explicitAgentTask) {
      if (!isAstraAgentTaskSpecification(input.explicitAgentTask)
        || !input.authenticatedAgentActor || input.astra || input.privacyMode !== 'persistent'
        || !['desktop', 'voice', 'api'].includes(input.source)) {
        throw new OscarTurnCoordinatorError(400, 'explicit-agent-task-binding', 'Explicit Agent Task requires a trusted persistent HTTP actor.');
      }
    }
    if (input.astra && (!this.options.astra || input.replyToTurnId || input.attachmentIds?.length
      || Object.keys(input.modifiers ?? {}).length || input.executionProfile))
      throw new OscarTurnCoordinatorError(409, 'astra-source-unavailable', 'Explicit Astra source is unavailable or unsupported.');
    if (normalized.replyToTurnId) {
      const target = await this.requireTurn(normalized.replyToTurnId);
      if (target.turn.request.astra) throw new OscarTurnCoordinatorError(409, 'astra-exact-input-required', 'Use the exact Astra question binding.');
      const directAccess = oscarDirectToolAccessActive(
        this.options.getOwnerUnrestrictedOverride?.(),
        normalized.source,
      );
      const independentOperation = target.turn.status === 'waiting-for-user'
        && target.turn.source === normalized.source
        && target.turn.conversationId === normalized.conversationId
        && target.turn.privacyMode === normalized.privacyMode
        && (directAccess || (await classifyOscarServerDisposition(
            normalized.text,
            this.options.dispositionProvider,
            { history: normalized.history, requestedModel: normalized.modifiers?.requestedModel },
          )).lane === 'agent');
      if (independentOperation) {
        await this.cancel(target.turn.id, normalized.source);
        const { replyToTurnId: _ignoredReply, ...freshInput } = input;
        return this.submit({
          ...freshInput,
          supersedesTurnId: input.supersedesTurnId || target.turn.id,
        });
      }
      return this.sendMessage(normalized.replyToTurnId, {
        content: normalized.text,
        messageId: normalized.inputMessageId,
        source: normalized.source,
      });
    }
    const store = this.storeForPrivacy(normalized.privacyMode);
    const attachmentPayloads = normalized.attachmentIds.length > 0
      ? await this.options.resolveAttachments?.(
        normalized.attachmentIds,
        normalized.privacyMode,
        normalized.source,
        normalized.conversationId,
      ) || []
      : [];
    let personality: OscarTurnV1['request']['personality'] | null = null;
    if (!input.astra && normalized.privacyMode === 'persistent' && normalized.source === 'desktop') {
      try {
        personality = await this.options.resolvePersonality?.({
          conversationId: normalized.conversationId,
          source: normalized.source,
          privacyMode: normalized.privacyMode,
        }) || null;
      } catch {
        // Personality is an optional style enrichment. A corrupt or unavailable
        // settings document must leave the accepted Turn on Oscar's baseline.
        personality = null;
      }
    }
    const now = this.nowIso();
    const turn: OscarTurnV1 = {
      schemaVersion: OSCAR_TURN_SCHEMA_VERSION,
      id: `oscar_turn_${randomUUID().replace(/-/g, '')}`,
      clientRequestId: normalized.clientRequestId,
      conversationId: normalized.conversationId,
      source: normalized.source,
      privacyMode: normalized.privacyMode,
      mode: 'answer',
      status: 'accepted',
      request: {
        text: normalized.text,
        attachmentIds: normalized.attachmentIds,
        modifiers: normalized.modifiers,
        ...(personality ? { personality } : {}),
        ...(normalized.history.length ? { history: normalized.history } : {}),
        ...(normalized.telegramActor ? { telegramActor: normalized.telegramActor } : {}),
        ...(normalized.authenticatedAgentActor ? { authenticatedAgentActor: normalized.authenticatedAgentActor } : {}),
        ...(normalized.executionProfile ? { executionProfile: normalized.executionProfile } : {}),
        ...(normalized.explicitAgentTask ? { explicitAgentTask: normalized.explicitAgentTask } : {}),
      },
      inputMessageId: normalized.inputMessageId,
      ...(normalized.supersedesTurnId ? { supersedesTurnId: normalized.supersedesTurnId } : {}),
      ...(normalized.retryOf ? { retryOf: normalized.retryOf } : {}),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (input.astra) {
      turn.request.astra = this.options.astra!.bind(turn, input.astra, input.astraActor);
      if (input.astraActor && (turn.request.astra.actor.id !== input.astraActor.id || turn.request.astra.actor.source !== input.astraActor.source))
        throw new OscarTurnCoordinatorError(403, 'astra-oscar-authenticated-actor-mismatch', 'Host binding does not match the authenticated source.');
    }
    const persistent = normalized.privacyMode === 'persistent';
    const created = await store.createTurn(turn, {
      events: [{
        type: 'turn.accepted',
        payload: {
          source: normalized.source,
          privacyMode: normalized.privacyMode,
          ...(personality ? {
            profileId: personality.profileId,
            profileRevision: personality.profileRevision,
            profileHash: personality.profileHash,
          } : {}),
        },
      }],
      ...(persistent ? {
        outbox: [messageOutbox(turn, userMessage(turn, attachmentPayloads))],
      } : {}),
    });
    this.turnPrivacy.set(created.turn.id, created.turn.privacyMode);
    if (created.turn.request.astra && !TERMINAL_TURN_STATUSES.has(created.turn.status)) this.astraTurns.add(created.turn.id);
    const cancellationKey = this.clientCancellationKey(
      created.turn.clientRequestId,
      created.turn.source,
      created.turn.privacyMode,
      created.turn.request.astra?.actor.id,
    );
    const requestedCancellation = await this.cancelForClientIntent(created.turn, cancellationKey);
    if (requestedCancellation) return requestedCancellation;
    if (created.replayed && !['accepted', 'routing'].includes(created.turn.status)) return created;
    return this.routeAcceptedTurn(created.turn.id);
  }

  /** Direct Access grants the agent its permissions; it does not decide that
   * every message is work. "сколько будет 17×23" went to the agent and took
   * 20 s. The selected model still tells an answer from work; its doubt or its
   * failure keeps the Direct Access default, the agent. */
  private async directAccessDisposition(text: string, history: OscarTurnRequestSnapshot['history'],
    requestedModel: string | undefined, externalResearch: boolean, signal: AbortSignal): Promise<OscarServerDisposition> {
    const agent: OscarServerDisposition = { lane: 'agent', kind: 'direct_access', confidence: 1,
      reason: 'Persistent local Direct Access: the selected model found work, or could not decide.', requiresExternalResearch: false };
    const provider = this.options.dispositionProvider;
    if (!provider) return agent;
    if (externalResearch && !classifyOscarRequestDisposition(text).hasLocalEffectTarget) {
      // Needing sources says nothing about whether something must also be
      // done with them. The model decides; only its clear "agent" turns a
      // search into a task, and its doubt keeps the sourced answer.
      const research: OscarServerDisposition = { lane: 'answer', kind: 'external_research', confidence: 0.9,
        reason: 'Consented web research with no local target is answered with sources.', requiresExternalResearch: false };
      try {
        const classified = await this.classifyWithLocalRoute(provider, { text, history, requestedModel, signal });
        return classified.lane === 'agent' ? researchThenActDisposition(classified) : research;
      } catch (error) {
        if (signal.aborted) throw error;
        return research;
      }
    }
    try {
      const classified = await this.classifyWithLocalRoute(provider, { text, history, requestedModel, signal });
      return classified.lane === 'answer' ? { ...classified, requiresExternalResearch: false } : agent;
    } catch (error) {
      if (signal.aborted) throw error;
      return agent;
    }
  }

  /** Direct Access asks the selected model too; a failed MAX there used to
   * send even "сколько будет 17×23" to the agent, which then failed on the
   * same MAX. The owner's local switch routes it locally, as for any Turn. */
  private async classifyWithLocalRoute(provider: OscarStructuredDispositionProvider,
    input: Parameters<OscarStructuredDispositionProvider['classify']>[0]) {
    try {
      return await provider.classify(input);
    } catch (error) {
      if (input.signal?.aborted || !isMaxNativeRole(input.requestedModel) || !isMaxNativeFailure(error)
        || this.options.maxLocalFallbackAllowed?.() !== true) throw error;
      const { requestedModel: _max, ...local } = input;
      return provider.classify(local);
    }
  }

  /** The selected model routes the Turn. When that model is MAX and MAX itself
   * fails (live chaos run: a rate limit), the Turn used to end at routing with
   * the MAX error although the owner's "answer locally when MAX is silent"
   * switch was on: the local answer is reached only after routing. With that
   * switch on, the local model routes instead; with it off the MAX failure
   * stands. Nothing has run yet, and the MAX request is not repeated. */
  private async routeTurn(text: string, options: NonNullable<Parameters<typeof classifyOscarServerDisposition>[2]>
    & { signal: AbortSignal }): Promise<OscarServerDisposition> {
    try {
      return await classifyOscarServerDisposition(text, this.options.dispositionProvider, options);
    } catch (error) {
      if (isAbort(error) || options.signal.aborted || !isMaxNativeRole(options.requestedModel)
        || !isMaxNativeFailure(error) || this.options.maxLocalFallbackAllowed?.() !== true) throw error;
      const { requestedModel: _max, ...local } = options;
      return classifyOscarServerDisposition(text, this.options.dispositionProvider, local);
    }
  }

  /** With Internet switched on, whether this request is worth a search. An
   * unavailable judge keeps the person's switch meaningful and says yes. */
  async requestNeedsWeb(text: string, history: OscarTurnRequestSnapshot['history'], requestedModel?: string, signal?: AbortSignal): Promise<boolean> {
    // Greetings and thanks never need a search; no model call for them.
    if (isOscarSmallTalk(text)) return false;
    const judge = this.options.dispositionProvider?.needsWeb;
    // An owner-added model is not asked to judge; the Internet switch decides.
    if (!judge || isCustomModelRole(requestedModel)) return true;
    try { return await judge.call(this.options.dispositionProvider, { text, history, requestedModel, signal }); }
    catch (error) { if (signal?.aborted) throw error; return true; }
  }

  async getTurn(turnId: string): Promise<OscarTurnCheckpoint | null> {
    return (await this.persistentStore.getTurn(turnId)) || this.volatileStore.getTurn(turnId);
  }

  async discardIncognitoConversation(conversationIdInput: string, source: OscarTurnSource): Promise<number> {
    const conversationId = normalizeId(conversationIdInput, 'conversation');
    const turns = (await this.volatileStore.listTurns()).filter((turn) => (
      turn.privacyMode === 'incognito'
      && turn.conversationId === conversationId
      && turn.source === source
    ));
    for (const turn of turns) {
      this.answerControllers.get(turn.id)?.abort('incognito-session-discarded');
      this.answerControllers.delete(turn.id);
      if (turn.taskId && turn.request.astra) {
        try { this.requireAstra().command(turn, 'cancel'); } catch { /* Volatile host may already be settled/stopped. */ }
        this.astraTurns.delete(turn.id);
      }
      this.turnPrivacy.delete(turn.id);
      await this.volatileStore.deleteTurn(turn.id);
    }
    return turns.length;
  }

  async findLatestTurn(input: {
    conversationId: string;
    source: OscarTurnSource;
    statuses: OscarTurnStatus[];
    activeApprovalId?: string;
    privacyMode?: OscarPrivacyMode;
  }): Promise<OscarTurnCheckpoint | null> {
    const conversationId = normalizeId(input.conversationId, 'conversation');
    const statuses = new Set(input.statuses);
    const turns = [
      ...await this.persistentStore.listTurns(),
      ...await this.volatileStore.listTurns(),
    ]
      .filter((turn) => turn.conversationId === conversationId)
      .filter((turn) => turn.source === input.source && statuses.has(turn.status))
      .filter((turn) => !input.privacyMode || turn.privacyMode === input.privacyMode)
      .filter((turn) => !input.activeApprovalId || turn.activeApprovalId === input.activeApprovalId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return turns[0] ? this.getTurn(turns[0].id) : null;
  }

  async findTurnByClientRequestId(input: {
    clientRequestId: string;
    source: OscarTurnSource;
    privacyMode: OscarPrivacyMode;
  }): Promise<OscarTurnCheckpoint | null> {
    const clientRequestId = normalizeId(input.clientRequestId, 'client request');
    const store = this.storeForPrivacy(input.privacyMode);
    const checkpoint = await store.getTurnByClientRequestId(clientRequestId);
    if (!checkpoint
      || checkpoint.turn.source !== input.source
      || checkpoint.turn.privacyMode !== input.privacyMode) return null;
    return checkpoint;
  }

  async findTurnByTaskId(taskIdInput: string): Promise<OscarTurnCheckpoint | null> {
    const taskId = normalizeId(taskIdInput, 'task');
    const matches = [...await this.persistentStore.listTurns(), ...await this.volatileStore.listTurns()]
      .filter(turn => turn.taskId === taskId).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return matches[0] ? this.getTurn(matches[0].id) : null;
  }

  async cancelByClientRequestId(input: {
    clientRequestId: string;
    source: OscarTurnSource;
    privacyMode: OscarPrivacyMode;
    astraActorId?: string;
    /** Untrusted transports must never infer another Turn's actor as authority. */
    allowImplicitAstraActor?: boolean;
  }): Promise<OscarClientRequestCancellation> {
    const clientRequestId = normalizeId(input.clientRequestId, 'client request');
    const existing = await this.findTurnByClientRequestId(input);
    if (existing?.turn.request.astra && !input.astraActorId && input.allowImplicitAstraActor === false)
      throw new OscarTurnCoordinatorError(403, 'astra-cancellation-source-mismatch', 'Explicit transport actor required.');
    const astraActorId = input.astraActorId ?? existing?.turn.request.astra?.actor.id;
    if (astraActorId !== undefined && (!/^sha256:[a-f0-9]{64}$/u.test(astraActorId)
      || existing && existing.turn.request.astra?.actor.id !== astraActorId))
      throw new OscarTurnCoordinatorError(403, 'astra-cancellation-source-mismatch', 'Astra cancellation actor mismatch.');
    const cancellationKey = this.clientCancellationKey(clientRequestId, input.source, input.privacyMode, astraActorId);
    const expiresAt = Date.now() + CLIENT_CANCELLATION_TTL_MS;
    await this.storeForPrivacy(input.privacyMode).reserveClientCancellation({
      clientRequestId,
      source: input.source,
      privacyMode: input.privacyMode,
      ...(astraActorId ? { astraActorId } : {}),
      expiresAt: new Date(expiresAt).toISOString(),
    });
    this.purgeExpiredClientCancellationIntents();
    this.clientCancellationIntents.set(cancellationKey, expiresAt);
    const checkpoint = await this.findTurnByClientRequestId({
      clientRequestId,
      source: input.source,
      privacyMode: input.privacyMode,
    });
    if (!checkpoint) return { clientRequestId, reserved: true, checkpoint: null };
    if (checkpoint.turn.request.astra?.actor.id !== astraActorId)
      throw new OscarTurnCoordinatorError(403, 'astra-cancellation-source-mismatch', 'Task actor changed before cancellation.');
    const cancelled = await this.cancel(checkpoint.turn.id, input.source);
    if (TERMINAL_TURN_STATUSES.has(cancelled.turn.status)) {
      await this.clearClientCancellationIntent(cancelled.turn, cancellationKey);
    }
    return { clientRequestId, reserved: false, checkpoint: cancelled };
  }

  async sendMessage(
    turnId: string,
    input: { content: string; messageId?: string; source: OscarTurnSource },
  ): Promise<OscarTurnCheckpoint> {
    const checkpoint = await this.requireTurn(turnId);
    const store = this.storeForTurn(checkpoint.turn);
    if (checkpoint.turn.source !== input.source) {
      throw new OscarTurnCoordinatorError(403, 'turn-source-mismatch', 'Turn continuation belongs to another surface.');
    }
    if (checkpoint.turn.request.astra && checkpoint.turn.status !== 'waiting-for-approval') {
      // Exact question/digest is required; generic prose must not be rebound to a
      // newer question on retry. Literal replies can intentionally be empty.
      throw new OscarTurnCoordinatorError(409, 'astra-exact-input-required', 'Use the exact Astra question and reply binding.');
    }
    const content = normalizeText(input.content, 16_000, 'message');
    const messageId = input.messageId
      ? normalizeId(input.messageId, 'message')
      : `oscar_message_${randomUUID().replace(/-/g, '')}`;
    const persisted = continuationUserMessage(checkpoint.turn, messageId, content);
    if (checkpoint.turn.status === 'waiting-for-approval') {
      const refocused = await this.updateTurn(store, turnId, (current) => ({
        turn: current,
        events: [
          { type: 'non-authoritative-confirmation', payload: { contentClass: 'text', messageId } },
          ...checkpoint.events.filter((event) => event.type === 'approval.required').slice(-1).map((event) => ({
            type: 'approval.required' as const,
            payload: event.payload,
          })),
        ],
        outbox: current.privacyMode === 'persistent' ? [messageOutbox(current, persisted)] : [],
      }));
      this.kickOutbox();
      return refocused;
    }
    if (checkpoint.turn.status !== 'waiting-for-user') {
      throw new OscarTurnCoordinatorError(409, 'turn-not-waiting-for-user', 'Only an exact waiting-for-user Turn can accept a message.');
    }
    const clarified = await this.updateTurn(store, turnId, (current) => ({
      turn: appendTurnContinuation(current, messageId, content, this.nowIso(), 'routing'),
      events: [{ type: 'turn.routed', payload: { disposition: 'clarification-received', messageId } }],
      outbox: current.privacyMode === 'persistent' ? [messageOutbox(current, persisted)] : [],
    }));
    this.kickOutbox();
    return this.routeAcceptedTurn(clarified.turn.id);
  }

  async cancel(turnId: string, source: OscarTurnSource): Promise<OscarTurnCheckpoint> {
    const checkpoint = await this.requireTurn(turnId);
    if (checkpoint.turn.source !== source) {
      throw new OscarTurnCoordinatorError(403, 'turn-source-mismatch', 'Turn cancellation belongs to another surface.');
    }
    if (TERMINAL_TURN_STATUSES.has(checkpoint.turn.status)) return checkpoint;
    const active = this.cancelFlights.get(turnId);
    if (active) return active;
    const flight = this.cancelTurnOnce(checkpoint);
    this.cancelFlights.set(turnId, flight);
    void flight.then(
      () => this.clearCancelFlight(turnId, flight),
      () => this.clearCancelFlight(turnId, flight),
    );
    return flight;
  }

  /** Synchronous revocation fence for a dispatch already awaiting policy work. */
  isExecutionCancelled(turnId: string): boolean { return this.executionCancellations.has(turnId); }

  private async cancelTurnOnce(checkpoint: OscarTurnCheckpoint): Promise<OscarTurnCheckpoint> {
    const turnId = checkpoint.turn.id;
    this.executionCancellations.add(turnId);
    if (checkpoint.turn.request.astra) return this.commandAstra(turnId, checkpoint.turn.source, 'cancel');
    this.answerControllers.get(turnId)?.abort('user-cancelled');
    return this.finishTurn(this.storeForTurn(checkpoint.turn), turnId, {
      status: 'cancelled',
      kind: 'cancelled',
      summary: OSCAR_TURN_CANCELLED_SUMMARY,
      events: [],
    });
  }

  subscribe(turnId: string, listener: Parameters<OscarTurnStore['subscribe']>[1]): () => void {
    const privacy = this.turnPrivacy.get(turnId);
    if (privacy) return this.storeForPrivacy(privacy).subscribe(turnId, listener);
    const unsubscribers = [
      this.persistentStore.subscribe(turnId, listener),
      this.volatileStore.subscribe(turnId, listener),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }

  private routeAcceptedTurn(turnId: string): Promise<OscarTurnCheckpoint> {
    const active = this.routeFlights.get(turnId);
    if (active) return active;
    const flight = this.routeAcceptedTurnOnce(turnId);
    this.routeFlights.set(turnId, flight);
    void flight.then(
      () => this.clearRouteFlight(turnId, flight),
      () => this.clearRouteFlight(turnId, flight),
    );
    return flight;
  }

  private clearRouteFlight(turnId: string, flight: Promise<OscarTurnCheckpoint>): void {
    if (this.routeFlights.get(turnId) === flight) this.routeFlights.delete(turnId);
  }

  private clearCancelFlight(turnId: string, flight: Promise<OscarTurnCheckpoint>): void {
    if (this.cancelFlights.get(turnId) === flight) this.cancelFlights.delete(turnId);
  }

  private clientCancellationKey(
    clientRequestId: string,
    source: OscarTurnSource,
    privacyMode: OscarPrivacyMode,
    astraActorId?: string,
  ): string {
    return `${privacyMode}:${source}:${clientRequestId}${astraActorId ? ':' + astraActorId : ''}`;
  }

  private hasClientCancellationIntent(key: string): boolean {
    this.purgeExpiredClientCancellationIntents();
    return this.clientCancellationIntents.has(key);
  }

  private async cancelForClientIntent(
    turn: OscarTurnV1,
    key = this.clientCancellationKey(turn.clientRequestId, turn.source, turn.privacyMode, turn.request.astra?.actor.id),
    includeDurable = true,
  ): Promise<OscarTurnCheckpoint | null> {
    const reservation = {
      ...(turn.request.astra ? { astraActorId: turn.request.astra.actor.id } : {}),
      clientRequestId: turn.clientRequestId,
      source: turn.source,
      privacyMode: turn.privacyMode,
    };
    const ordinaryReservation = ['ordinary-exact-create-v1', 'ordinary-exact-read-v1'].includes(turn.request.astra?.admission ?? '')
      ? { clientRequestId: turn.clientRequestId, source: turn.source, privacyMode: turn.privacyMode } : null;
    const ordinaryKey = ordinaryReservation ? this.clientCancellationKey(turn.clientRequestId, turn.source, turn.privacyMode) : null;
    const requested = this.hasClientCancellationIntent(key)
      || (includeDurable && await this.storeForTurn(turn).hasClientCancellation(reservation))
      || (ordinaryKey !== null && this.hasClientCancellationIntent(ordinaryKey))
      || (includeDurable && ordinaryReservation !== null && await this.storeForTurn(turn).hasClientCancellation(ordinaryReservation));
    if (!requested) return null;
    const cancelled = await this.cancel(turn.id, turn.source);
    if (TERMINAL_TURN_STATUSES.has(cancelled.turn.status)) {
      await this.clearClientCancellationIntent(cancelled.turn, key);
      if (ordinaryReservation && ordinaryKey) {
        this.clientCancellationIntents.delete(ordinaryKey);
        await this.storeForTurn(turn).clearClientCancellation(ordinaryReservation);
      }
    }
    return cancelled;
  }

  private async clearClientCancellationIntent(turn: OscarTurnV1, key: string): Promise<void> {
    this.clientCancellationIntents.delete(key);
    await this.storeForTurn(turn).clearClientCancellation({
      ...(turn.request.astra ? { astraActorId: turn.request.astra.actor.id } : {}),
      clientRequestId: turn.clientRequestId,
      source: turn.source,
      privacyMode: turn.privacyMode,
    });
  }

  private purgeExpiredClientCancellationIntents(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.clientCancellationIntents) {
      if (expiresAt <= now) this.clientCancellationIntents.delete(key);
    }
  }

  private async routeAcceptedTurnOnce(turnId: string): Promise<OscarTurnCheckpoint> {
    let checkpoint = await this.requireTurn(turnId);
    if (checkpoint.turn.status === 'accepted') {
      checkpoint = await this.updateTurn(this.storeForTurn(checkpoint.turn), turnId, (current) => ({
        turn: { ...current, status: 'routing' },
        events: [],
      }));
    }
    if (checkpoint.turn.status !== 'routing') return checkpoint;
    const store = this.storeForTurn(checkpoint.turn);
    const requestText = effectiveTurnRequest(checkpoint.turn);

    if (checkpoint.turn.request.astra) {
      // The durable binding selects one executor even if the bridge disappears.
      // No classifier, answer fallback or legacy runtime may claim this Turn.
      const routed = await this.updateTurn(store, turnId, current => ({
        turn: { ...current, mode: 'agent', status: 'running' },
        events: [{ type: 'turn.routed', payload: { disposition: 'agent', runtime: 'astra-v3', isolated: true } }],
        outbox: [{ id: `outbox_create_task_${current.id}`, turnId: current.id, kind: 'create-agent-task', payload: { runtime: 'astra-v3' } }],
      }));
      this.kickOutbox(); return routed;
    }

    if (isNonAuthoritativeConfirmationText(requestText)) {
      const activeApproval = await this.findActiveApprovalTurn(checkpoint.turn.conversationId);
      const replaysApproval = Boolean(activeApproval && activeApproval.turn.id !== turnId);
      const blocked = await this.finishTurn(store, turnId, {
        status: 'blocked',
        kind: 'blocked',
        summary: replaysApproval
          ? 'Текстовое подтверждение не имеет полномочий. Используй текущую action-card.'
          : 'Текстовое подтверждение не запускает действия: активной action-card нет, поэтому ничего не было запущено. Повтори операционную задачу.',
        events: [
          {
            type: 'non-authoritative-confirmation',
            payload: {
              approvalId: activeApproval?.turn.activeApprovalId || '',
              taskId: activeApproval?.turn.taskId || '',
              activeApproval: replaysApproval,
            },
          },
          ...(replaysApproval ? await this.approvalPresentationEvent(activeApproval!.turn) : []),
        ],
      });
      this.kickOutbox();
      return blocked;
    }

    const modifiers = checkpoint.turn.request.modifiers;
    const egressRequested = modifiers.webSearch === true || modifiers.researchMode === 'deep';
    const explicitMemoryText = extractExplicitMemoryText(requestText);
    const reminderCommand = this.options.reminders && !checkpoint.turn.request.explicitAgentTask
      ? parseReminderCommand(requestText, new Date(this.nowIso()))
      : null;
    const trustedCoderTask = checkpoint.turn.source === 'coder'
      && checkpoint.turn.request.executionProfile?.schemaVersion === 'monarch.agent-execution-profile.v1'
      && checkpoint.turn.request.executionProfile.kind === 'coder-project';
    const explicitAgentTask = checkpoint.turn.request.explicitAgentTask;
    const directAccess = oscarDirectToolAccessActive(
      this.options.getOwnerUnrestrictedOverride?.(),
      checkpoint.turn.source,
    );
    const routingController = new AbortController();
    this.answerControllers.set(turnId, routingController);
    let disposition: OscarServerDisposition;
    try {
      disposition = explicitAgentTask
        ? {
            lane: 'agent' as const,
            kind: 'explicit_agent_task',
            confidence: 1,
            reason: 'The authenticated Agent Task endpoint selected the Agent lane.',
            requiresExternalResearch: false,
          }
        : trustedCoderTask
        ? {
            lane: 'agent' as const,
            kind: 'coder_task',
            confidence: 1,
            reason: 'A validated Coder project Turn always uses the common Agent Runtime.',
            requiresExternalResearch: false,
          }
        : reminderCommand
        ? {
            lane: 'reminder' as const,
            kind: 'reminder_command',
            confidence: 1,
            reason: 'An explicit reminder command is a typed local data write, not an Agent action.',
            requiresExternalResearch: false,
          }
        : isCustomModelRole(modifiers.requestedModel) && !explicitMemoryText
          ? {
            // An owner-added model is not admitted to agent work, and its JSON
            // routing is not trusted to pick one; it answers in the chat.
            lane: 'answer' as const,
            kind: 'custom_model_chat',
            confidence: 1,
            reason: 'Owner-added local models answer in the ordinary chat only.',
            requiresExternalResearch: false,
          }
        : directAccess && !isOscarDirectAccessAnswerOnlyRequest(requestText)
          && !isOscarCapabilitiesOrIdentityRequest(requestText)
          ? await this.directAccessDisposition(requestText, checkpoint.turn.request.history,
            modifiers.requestedModel, egressRequested, routingController.signal)
        : explicitMemoryText
          ? {
            lane: 'memory' as const,
            kind: 'memory_remember',
            confidence: 1,
            reason: 'Exact typed Desktop memory command stays runtime-owned.',
            requiresExternalResearch: false,
            }
          : await this.routeTurn(requestText, {
            externalResearch: egressRequested,
            history: checkpoint.turn.request.history,
            requestedModel: modifiers.requestedModel,
            signal: routingController.signal,
          });
    } catch (error) {
      if (isAbort(error) || routingController.signal.aborted) throw error;
      // Routing runs a model. Its exact failure (a MAX credential/quota error,
      // an unreachable local runtime) must settle this Turn with a visible
      // outcome; otherwise the Turn stays in `routing` forever and the surface
      // shows nothing at all. No executor was selected, so nothing was executed.
      await this.failTurn(turnId, error);
      return this.requireTurn(turnId);
    } finally {
      if (this.answerControllers.get(turnId) === routingController) this.answerControllers.delete(turnId);
    }
    checkpoint = await this.requireTurn(turnId);
    if (checkpoint.turn.status !== 'routing') return checkpoint;
    const requestedCancellation = await this.cancelForClientIntent(checkpoint.turn, undefined, false);
    if (requestedCancellation) return requestedCancellation;
    if (disposition.lane === 'memory') {
      return this.runMemoryWrite(checkpoint, explicitMemoryText);
    }
    if (disposition.lane === 'reminder' && reminderCommand) {
      return this.runReminderCommand(checkpoint, reminderCommand);
    }
    if (disposition.requiresExternalResearch === true && !egressRequested) {
      const blocked = await this.finishTurn(store, turnId, {
        status: 'blocked',
        kind: 'blocked',
        summary: 'Здесь нужны свежие данные из интернета. Включи «Интернет» (глобус рядом с моделью) — тогда я сам поищу, когда это нужно.',
        events: [{ type: 'turn.routed', payload: { disposition: 'answer', blockedBy: 'external-research-consent-required' } }],
      });
      this.kickOutbox();
      return blocked;
    }
    if (egressRequested) {
      if (!modifiers.dataEgressConsentId || !this.options.consumeDataEgressConsent) {
        const blocked = await this.finishTurn(store, turnId, {
          status: 'blocked',
          kind: 'blocked',
          summary: 'Web/Deep Research не запущен: нужен отдельный data-egress consent через кнопку.',
          events: [{ type: 'turn.routed', payload: { disposition: 'answer', blockedBy: 'data-egress-consent-required' } }],
        });
        this.kickOutbox();
        return blocked;
      }
      try {
        await this.options.consumeDataEgressConsent(modifiers.dataEgressConsentId, checkpoint.turn);
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'invalid-data-egress-consent';
        const blocked = await this.finishTurn(store, turnId, {
          status: 'blocked',
          kind: 'blocked',
          summary: 'Web/Deep Research не запущен: data-egress consent недействителен или не соответствует этому Turn.',
          warning: code,
          events: [{ type: 'turn.routed', payload: { disposition: 'answer', blockedBy: code } }],
        });
        this.kickOutbox();
        return blocked;
      }
    } else if (modifiers.dataEgressConsentId) {
      const blocked = await this.finishTurn(store, turnId, {
        status: 'blocked',
        kind: 'blocked',
        summary: 'Data-egress consent нельзя переносить на Turn без web/research запроса.',
        events: [{ type: 'turn.routed', payload: { disposition: 'answer', blockedBy: 'unexpected-data-egress-consent' } }],
      });
      this.kickOutbox();
      return blocked;
    }

    if (disposition.lane === 'agent' && checkpoint.turn.privacyMode === 'encrypted') {
      const blocked = await this.finishTurn(store, turnId, {
        status: 'blocked',
        kind: 'blocked',
        summary: 'Зашифрованный Safe-чат работает только в answer-only режиме. Операционная задача не создавалась.',
        events: [{ type: 'turn.routed', payload: { disposition: 'agent', blockedBy: 'private-mode' } }],
      });
      this.kickOutbox();
      return blocked;
    }
    if (disposition.lane === 'clarify') {
      const question = 'Укажи точную цель операции, чтобы Monarch мог проверить её policy.';
      const messageId = systemMessageId('clarification', turnId);
      const waiting = await this.updateTurn(store, turnId, (current) => ({
        turn: { ...current, status: 'waiting-for-user', outputMessageId: messageId },
        events: [
          { type: 'turn.routed', payload: { disposition: 'clarify', reason: disposition.reason } },
          { type: 'user.input.required', payload: { question } },
        ],
        outbox: current.privacyMode === 'persistent' ? [messageOutbox(current, {
          conversationId: current.conversationId,
          messageId,
          role: 'assistant',
          content: question,
          turnId: current.id,
          provenance: {
            schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
            origin: 'system',
            verification: 'system-state',
            turnId: current.id,
          },
        })] : [],
      }));
      this.kickOutbox();
      return waiting;
    }
    // The V3 agent has no internet of its own and refuses web-search Turns, so
    // sending one there blocked every internet request as "Agent Runtime
    // unavailable". A consented search that must also lead to an action is
    // searched by the host first and given to the task as evidence; one that
    // only needs an answer stays in the sourced answer lane.
    const hostResearch = disposition.lane === 'agent' && egressRequested && Boolean(this.options.researchEvidence);
    if (disposition.lane === 'agent' && (!egressRequested || hostResearch)) {
      const astraBound = await this.bindOrdinaryAgentTurn(store, turnId, hostResearch);
      if (astraBound?.turn.request.astra) {
        if (astraBound.turn.status !== 'routing') return astraBound;
        const routed = await this.updateTurn(store, turnId, current => ({
          turn: { ...current, mode: 'agent', status: 'running' },
          events: [{ type: 'turn.routed', payload: { disposition: 'agent', kind: disposition.kind,
            reason: disposition.reason, runtime: 'astra-v3', isolated: true } }],
          outbox: [{ id: `outbox_create_task_${current.id}`, turnId: current.id,
            kind: 'create-agent-task' as const, payload: { kind: disposition.kind, runtime: 'astra-v3' } }],
        }));
        this.astraTurns.add(turnId); this.kickOutbox(); return routed;
      }
      const blocked = await this.finishTurn(store, turnId, {
        status: 'blocked',
        kind: 'blocked',
        summary: trustedCoderTask
          ? 'Astra V3 Agent Runtime недоступен. Coder не переключается на устаревший runtime.'
          : 'Astra V3 Agent Runtime недоступен для этой задачи. Запрос не был отправлен в обычный чат или другой исполнитель.',
        events: [{ type: 'turn.routed', payload: { disposition: 'agent', kind: disposition.kind,
          blockedBy: 'astra-v3-agent-runtime-unavailable' } }],
      });
      this.kickOutbox(); return blocked;
    }

    const routed = await this.updateTurn(store, turnId, (current) => ({
      turn: { ...current, mode: 'answer', status: 'answering' },
      events: [{ type: 'turn.routed', payload: { disposition: 'answer', kind: disposition.kind, reason: disposition.reason } }],
    }));
    this.launchAnswer(turnId);
    this.kickOutbox();
    return routed;
  }

  private async runReminderCommand(
    checkpoint: OscarTurnCheckpoint,
    command: ParsedReminderCommand,
  ): Promise<OscarTurnCheckpoint> {
    const store = this.storeForTurn(checkpoint.turn);
    const turnId = checkpoint.turn.id;
    const reminders = this.options.reminders;
    if (!reminders) {
      return this.finishTurn(store, turnId, {
        status: 'failed',
        kind: 'failed',
        summary: 'Напоминания сейчас недоступны.',
        events: [{ type: 'turn.routed', payload: { disposition: 'reminder', blockedBy: 'reminder-service-unavailable' } }],
      });
    }
    if (checkpoint.turn.source !== 'desktop' || checkpoint.turn.privacyMode !== 'persistent') {
      return this.finishTurn(store, turnId, {
        status: 'blocked',
        kind: 'blocked',
        summary: checkpoint.turn.privacyMode === 'persistent'
          ? 'Напоминания ставятся в обычном чате Monarch на компьютере.'
          : 'В этом режиме чата напоминания не сохраняются. Попроси в обычном чате.',
        events: [{ type: 'turn.routed', payload: { disposition: 'reminder', blockedBy: 'persistent-desktop-required' } }],
      });
    }
    await this.updateTurn(store, turnId, (current) => ({
      turn: { ...current, mode: 'answer', status: 'running' },
      events: [{ type: 'turn.routed', payload: { disposition: 'reminder', reason: 'typed-reminder-command', command: command.kind } }],
    }));
    try {
      const now = new Date(this.nowIso());
      let summary: string;
      let evidenceRefs: AgentEvidenceReference[] = [];
      if (command.kind === 'list') {
        const upcoming = (await reminders.list()).filter((entry) => entry.status === 'scheduled');
        summary = upcoming.length
          ? ['Твои напоминания:', ...upcoming.slice(0, 20).map((entry) =>
            `- ${describeReminderTime(new Date(entry.dueAt), now)} — ${entry.text}${entry.recurrence === 'daily' ? ' (каждый день)' : entry.recurrence === 'weekly' ? ' (каждую неделю)' : ''}`)].join('\n')
          : 'Сейчас напоминаний нет. Скажи, например: «напомни через 20 минут проверить духовку».';
      } else if (command.kind === 'needs-time') {
        summary = command.text
          ? `Когда напомнить «${command.text}»? Скажи, например: «через 20 минут», «завтра в 9:00» или «в пятницу в 18:00».`
          : 'Что и когда напомнить? Например: «напомни через 20 минут проверить духовку».';
      } else {
        const reminder = await reminders.create({
          text: command.text,
          dueAt: command.dueAt,
          recurrence: command.recurrence,
          conversationId: checkpoint.turn.conversationId,
        });
        const repeat = reminder.recurrence === 'daily' ? ' И дальше каждый день.' : reminder.recurrence === 'weekly' ? ' И дальше каждую неделю.' : '';
        summary = `Хорошо, напомню ${describeReminderTime(new Date(reminder.dueAt), now)}: ${reminder.text}.${repeat}`;
        evidenceRefs = [{
          kind: 'api',
          evidenceClass: 'kernel-verification',
          reference: `reminder:${reminder.id}`,
          summary: `Reminder stored for ${reminder.dueAt}.`,
        }];
      }
      const messageId = `oscar_message_${randomUUID().replace(/-/g, '')}`;
      const current = await this.requireTurn(turnId);
      return this.finishTurn(store, turnId, {
        status: 'succeeded',
        kind: evidenceRefs.length ? 'verified' : 'answered',
        summary,
        evidenceRefs,
        outputMessageId: messageId,
        events: [{ type: 'answer.delta', payload: { content: summary } }],
        outbox: [messageOutbox(current.turn, {
          conversationId: current.turn.conversationId,
          messageId,
          role: 'assistant',
          content: summary,
          turnId,
          provenance: {
            schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
            origin: 'kernel',
            verification: evidenceRefs.length ? 'kernel-verified' : 'system-state',
            turnId,
            evidenceRefs,
          },
          outcome: evidenceRefs.length ? 'verified' : 'answered',
        })],
      });
    } catch (error) {
      await this.failTurn(turnId, error);
      return this.requireTurn(turnId);
    }
  }

  private async runMemoryWrite(
    checkpoint: OscarTurnCheckpoint,
    memoryText: string | null,
  ): Promise<OscarTurnCheckpoint> {
    const store = this.storeForTurn(checkpoint.turn);
    if (!memoryText) {
      return this.finishTurn(store, checkpoint.turn.id, {
        status: 'failed',
        kind: 'failed',
        summary: 'Не удалось выделить точный текст для памяти.',
        events: [{ type: 'turn.routed', payload: { disposition: 'memory', blockedBy: 'memory-text-empty' } }],
      });
    }
    if (checkpoint.turn.source !== 'desktop' || checkpoint.turn.privacyMode !== 'persistent') {
      return this.finishTurn(store, checkpoint.turn.id, {
        status: 'blocked',
        kind: 'blocked',
        summary: checkpoint.turn.privacyMode === 'incognito'
          ? 'Incognito не читает и не сохраняет постоянную память.'
          : 'Постоянную память можно изменить только из локального Desktop-чата.',
        events: [{ type: 'turn.routed', payload: { disposition: 'memory', blockedBy: 'persistent-desktop-required' } }],
      });
    }
    if (!this.options.rememberMemory) {
      return this.finishTurn(store, checkpoint.turn.id, {
        status: 'failed',
        kind: 'failed',
        summary: 'Локальный сервис памяти сейчас недоступен.',
        events: [{ type: 'turn.routed', payload: { disposition: 'memory', blockedBy: 'memory-service-unavailable' } }],
      });
    }
    await this.updateTurn(store, checkpoint.turn.id, (current) => ({
      turn: { ...current, mode: 'answer', status: 'running' },
      events: [{ type: 'turn.routed', payload: { disposition: 'memory', reason: 'typed-settings-command' } }],
    }));
    try {
      const receipt = await this.options.rememberMemory({ turn: checkpoint.turn, text: memoryText });
      const evidenceRefs: AgentEvidenceReference[] = [{
        kind: 'api',
        evidenceClass: 'kernel-verification',
        reference: `settings-receipt:${receipt.receiptId}`,
        summary: `Memory V4 committed revision ${receipt.revision} and verified its durable read-back.`,
        checksum: receipt.contentHash,
      }];
      const summary = 'Запомнил. Запись сохранена в постоянной памяти.';
      const messageId = `oscar_message_${randomUUID().replace(/-/g, '')}`;
      const current = await this.requireTurn(checkpoint.turn.id);
      return this.finishTurn(store, checkpoint.turn.id, {
        status: 'succeeded',
        kind: 'verified',
        summary,
        evidenceRefs,
        outputMessageId: messageId,
        events: [{ type: 'answer.delta', payload: { content: summary } }],
        outbox: [messageOutbox(current.turn, {
          conversationId: current.turn.conversationId,
          messageId,
          role: 'assistant',
          content: summary,
          turnId: current.turn.id,
          provenance: {
            schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
            origin: 'kernel',
            verification: 'kernel-verified',
            turnId: current.turn.id,
            evidenceRefs,
          },
          outcome: 'verified',
        })],
      });
    } catch (error) {
      await this.failTurn(checkpoint.turn.id, error);
      return this.requireTurn(checkpoint.turn.id);
    }
  }

  private async runAnswer(turnId: string): Promise<void> {
    if (this.answerControllers.has(turnId)) return;
    const checkpoint = await this.requireTurn(turnId);
    const controller = new AbortController();
    this.answerControllers.set(turnId, controller);
    let rawAnswer = '';
    let replacement = '';
    let sources: unknown[] = [];
    let usage: Record<string, unknown> | undefined;
    let terminalSeen = false;
    const integrityContext = { executionAuthority: 'none' as const, evidence: [],
      creativeRequest: isCreativeWritingRequest(effectiveTurnRequest(checkpoint.turn)) };
    const integritySession = this.gate.createSession(integrityContext);
    const dataEgressAuthorized = turnHasDataEgressAuthorization(checkpoint.turn);
    try {
      const attachments = await this.options.resolveAttachments?.(
        checkpoint.turn.request.attachmentIds,
        checkpoint.turn.privacyMode,
        checkpoint.turn.source,
        checkpoint.turn.conversationId,
      ) || [];
      if (checkpoint.turn.request.modifiers.webSearch === true
        || checkpoint.turn.request.modifiers.researchMode === 'deep') {
        // The request is not what gets searched: the answer model writes the
        // queries first, and a `search` event replaces this line with them.
        const query = 'Подбираю, что искать';
        await this.appendAnswerEvents(turnId, [{
          type: 'agent.progress',
          payload: {
            // Planning, not a search yet: the research trace files it under "План".
            phase: 'search-plan',
            label: 'Поиск · Интернет',
            detail: query,
            activity: {
              operation: 'search',
              domain: 'internet',
              subject: query,
              motion: 'breathing',
              label: 'Поиск · Интернет',
              detail: query,
            },
          },
        }]);
      }
      let streamFailure: unknown;
      // One reader for the primary answer and the owner-enabled local
      // fallback. `collect` keeps a second answer out of text that was
      // already shown; it replaces the draft as a whole instead.
      const consume = async (stream: AsyncIterable<OscarAnswerExecutorEvent>, collect: boolean): Promise<void> => {
        let collected = '';
        for await (const event of stream) {
          if (controller.signal.aborted) throw abortError();
          if (event.type === 'token') {
            if (collect) { collected += event.token; continue; }
            rawAnswer += event.token;
            const deltas = await integritySession.append(event.token);
            await this.appendAnswerEvents(turnId, deltas.map((content) => ({
              type: 'answer.delta' as const,
              payload: { content },
            })));
          }
          else if (event.type === 'replace') replacement = event.content;
          else if (event.type === 'search') {
            const detail = boundedProgressText(event.queries.filter(query => typeof query === 'string').join(' · '), 160);
            if (detail) await this.appendAnswerEvents(turnId, [{ type: 'agent.progress', payload: {
              phase: 'search', label: 'Поиск · Интернет', detail,
              activity: { operation: 'search', domain: 'internet', subject: detail, motion: 'breathing',
                label: 'Поиск · Интернет', detail },
            } }]);
          }
          else if (event.type === 'progress') {
            const step = RESEARCH_STAGE_ACTIVITY[event.stage];
            const detail = boundedProgressText(event.detail, 160);
            if (step && detail) await this.appendAnswerEvents(turnId, [{ type: 'agent.progress', payload: {
              phase: `research-${event.stage}`, label: step.label, detail,
              activity: { operation: step.operation, domain: 'internet', subject: detail, motion: 'breathing',
                label: step.label, detail },
            } }]);
          }
          else if (event.type === 'sources') {
            const receivedSources = [...event.sources];
            assertAnswerSourcesAllowed(receivedSources, dataEgressAuthorized);
            sources = receivedSources;
          }
          else if (event.type === 'error') throw new Error(event.message);
          else if (event.type === 'done') {
            usage = event.usage;
            if (event.cancelled) throw abortError();
            if (event.ok === false) {
              throw rejectedAnswerTerminalError(event.failure);
            }
            terminalSeen = true;
            break;
          }
        }
        if (collect && terminalSeen) replacement = replacement || collected;
      };
      try {
        const stream = await this.options.answerExecutor({
          turn: checkpoint.turn,
          attachments,
          signal: controller.signal,
        });
        await consume(stream, false);
      } catch (error) {
        if (isAbort(error) || controller.signal.aborted) throw error;
        streamFailure = error;
      }
      if (!terminalSeen) {
        // MAX must neither retry a possibly charged request nor lose its original failure.
        // With the owner's "answer locally when MAX is silent" switch on, the
        // installed local model answers instead; the MAX request is not repeated
        // and the answer is labelled as local (owner decision 2026-09-26).
        if (isMaxNativeRole(checkpoint.turn.request.modifiers.requestedModel)) {
          const maxFailure = streamFailure || Object.assign(new Error('astra-max-native:empty-output'), { code: 'astra-max-native:empty-output' });
          const localStream = await this.options.maxLocalFallback?.({
            turn: checkpoint.turn,
            attachments,
            signal: controller.signal,
          }).catch((error: unknown) => {
            if (isAbort(error) || controller.signal.aborted) throw error;
            // The person then sees only the MAX failure; the reason the local
            // answer did not start must not disappear with it.
            console.error(JSON.stringify({ diagnostic: 'max-local-fallback-failed',
              code: error instanceof Error ? error.message.slice(0, 160) : 'unknown' }));
            return null;
          });
          if (!localStream) throw maxFailure;
          const shownMaxText = rawAnswer.length > 0;
          replacement = '';
          sources = [];
          usage = undefined;
          await this.appendAnswerEvents(turnId, [{
            type: 'agent.progress',
            payload: {
              phase: 'max-local-answer',
              label: 'MAX не ответил · отвечает локальная модель',
              detail: maxNativeErrorText(maxFailureCode(maxFailure)),
            },
          }]);
          try {
            await consume(localStream, shownMaxText);
          } catch (error) {
            if (isAbort(error) || controller.signal.aborted) throw error;
            throw maxFailure;
          }
          if (!terminalSeen) throw maxFailure;
          usage = { ...(usage || {}), max_fallback: 'local', max_failure_code: maxFailureCode(maxFailure) };
        }
        else if (isCustomModelRole(checkpoint.turn.request.modifiers.requestedModel)
          && streamFailure instanceof Error
          && /^custom-model-(?:draft-only|auxiliary|format|split|missing)$/u.test(streamFailure.message)) {
          // Keep the original failure; loading a rejected custom file twice cannot repair it.
          throw streamFailure;
        }
        else if (streamFailure && typeof streamFailure === 'object'
          && 'code' in streamFailure && streamFailure.code === 'vision-unavailable') {
          throw streamFailure;
        }
        else if (!this.options.answerFallback) {
          throw streamFailure || new Error('Oscar answer runtime ended before a terminal event.');
        }
        else {
          const recovered = await this.options.answerFallback({
            turn: checkpoint.turn,
            attachments,
            signal: controller.signal,
          });
          rawAnswer = recovered.answer;
          replacement = '';
          const recoveredSources = recovered.sources || [];
          assertAnswerSourcesAllowed(recoveredSources, dataEgressAuthorized);
          sources = recoveredSources;
          usage = recovered.usage;
          terminalSeen = true;
        }
      }
      const answer = replacement || rawAnswer;
      if (!answer.trim()) throw new Error('Oscar answer runtime returned no visible answer.');
      const integrity = await this.gate.inspectCompleteAnswer(answer, {
        ...integrityContext,
      });
      if (!integrity.allowed) {
        await this.finishAnswerIntegrityBlock(turnId, integrity.replacement, integrity.reasons);
        return;
      }
      const eventDrafts = replacement || !integrity.visibleText.startsWith(integritySession.visibleText)
        ? [{ type: 'answer.replace' as const, payload: { content: integrity.visibleText } }]
        : integrity.visibleText.length > integritySession.visibleText.length
          ? [{
            type: 'answer.delta' as const,
            payload: { content: integrity.visibleText.slice(integritySession.visibleText.length) },
          }]
          : [];
      const messageId = `oscar_message_${randomUUID().replace(/-/g, '')}`;
      const kind: OscarTurnOutcomeKind = sources.length > 0 ? 'answered:source-grounded' : 'answered';
      const current = await this.requireTurn(turnId);
      const store = this.storeForTurn(current.turn);
      const researchSteps = researchTraceSteps(current.events);
      const evidenceRefs = sources.slice(0, 32).map((source, index): AgentEvidenceReference => ({
        kind: 'other',
        evidenceClass: 'external-source',
        reference: sourceReference(source, index),
        summary: sourceSummary(source),
      }));
      const provenance: MessageProvenanceV1 = {
        schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
        origin: sources.length > 0 ? 'external-source' : 'model',
        verification: sources.length > 0 ? 'source-grounded' : 'unverified-model',
        turnId,
        evidenceRefs,
      };
      // `elapsed_ms` is the model's own generation time. It is not what the
      // person waited: routing, a model swap and recovery all happen outside
      // it, so a surface that reports it as the duration of the work
      // understates it, sometimes by an order of magnitude.
      const reportedUsage: Record<string, unknown> = {
        ...(usage || {}),
        turn_elapsed_ms: Math.max(0, Date.parse(this.nowIso()) - Date.parse(current.turn.createdAt)),
      };
      await this.finishTurn(store, turnId, {
        status: 'succeeded',
        kind,
        summary: integrity.visibleText,
        evidenceRefs,
        sources: displaySources(sources),
        usage: reportedUsage,
        outputMessageId: messageId,
        events: eventDrafts,
        outbox: current.turn.privacyMode === 'persistent' ? [messageOutbox(current.turn, {
          conversationId: current.turn.conversationId,
          messageId,
          role: 'assistant',
          content: integrity.visibleText,
          turnId,
          provenance,
          outcome: kind,
          sources,
          ...(researchSteps.length ? { researchSteps } : {}),
          usage: reportedUsage,
        })] : [],
      });
      this.kickOutbox();
    } catch (error) {
      // Why an answer ended early, by code and time only: a provider timeout
      // and a person's Stop both used to surface as "cancelled" with no trace.
      console.error(JSON.stringify({ diagnostic: 'oscar-answer-ended', turnId,
        code: String(error instanceof Error ? error.message : error).slice(0, 80),
        signalReason: controller.signal.aborted ? String(controller.signal.reason ?? 'aborted').slice(0, 60) : null,
        elapsedMs: Date.now() - Date.parse(checkpoint.turn.createdAt) }));
      if (isAbort(error) || controller.signal.aborted) {
        const current = await this.getTurn(turnId);
        if (current && !TERMINAL_TURN_STATUSES.has(current.turn.status)) {
          await this.finishTurn(this.storeForTurn(current.turn), turnId, {
            status: 'cancelled',
            kind: 'cancelled',
            summary: OSCAR_TURN_CANCELLED_SUMMARY,
            events: [],
          });
        }
      } else {
        await this.failTurn(turnId, error);
      }
    } finally {
      this.answerControllers.delete(turnId);
    }
  }

  private async appendAnswerEvents(turnId: string, events: OscarTurnEventDraft[]): Promise<void> {
    if (events.length === 0) return;
    const current = await this.getTurn(turnId);
    if (!current || current.turn.status !== 'answering') return;
    await this.updateTurn(this.storeForTurn(current.turn), turnId, (turn) => ({ turn, events }));
  }

  private async finishAnswerIntegrityBlock(turnId: string, replacement: string, reasons: string[]): Promise<void> {
    const current = await this.requireTurn(turnId);
    const messageId = `oscar_message_${randomUUID().replace(/-/g, '')}`;
    const provenance: MessageProvenanceV1 = {
      schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
      origin: 'system',
      verification: 'system-state',
      turnId,
    };
    await this.finishTurn(this.storeForTurn(current.turn), turnId, {
      status: 'blocked',
      kind: 'blocked',
      summary: replacement,
      warning: reasons.join(', '),
      outputMessageId: messageId,
      events: [{ type: 'answer.replace', payload: { content: replacement } }],
      outbox: current.turn.privacyMode === 'persistent' ? [messageOutbox(current.turn, {
        conversationId: current.turn.conversationId,
        messageId,
        role: 'assistant',
        content: replacement,
        turnId,
        provenance,
        outcome: 'blocked',
        integrityWarning: reasons.join(', '),
      })] : [],
    });
    this.kickOutbox();
  }

  private async ensureAgentTask(turnId: string, _routedKindInput?: string): Promise<void> {
    let current = await this.requireTurn(turnId);
    if (current.turn.request.astra) {
      const port = this.requireAstra(), existing = port.find(current.turn);
      if (!existing && this.astraRestoreHeld && !TERMINAL_TURN_STATUSES.has(current.turn.status)) {
        throw new OscarTurnCoordinatorError(503, 'astra-restore-held', 'astra-restore-held');
      }
      if (!existing && (TERMINAL_TURN_STATUSES.has(current.turn.status) || current.turn.astraControl?.desired === 'cancel')) {
        if (!TERMINAL_TURN_STATUSES.has(current.turn.status)) await this.finishTurn(this.storeForTurn(current.turn), turnId,
          { status: 'cancelled', kind: 'cancelled', summary: 'Задача отменена до передачи в Astra. Действия не запускались.', events: [] });
        this.astraTurns.delete(turnId);
        return;
      }
      if (!existing && current.turn.astraControl?.desired === 'pause') return;
      let prepared: unknown;
      if (!existing) {
        const hostResearch = turnNeedsHostResearch(current.turn);
        if (current.turn.request.astra?.admission === 'ordinary-agent-v1'
          && (current.turn.request.attachmentIds.length > 0 || hostResearch)) {
          let stage: 'attachments' | 'research' = 'attachments';
          try {
            const initialEvidence = current.turn.request.attachmentIds.length > 0
              ? await this.prepareAstraAgentAttachmentEvidence(current.turn) : [];
            if (hostResearch) {
              stage = 'research';
              if (initialEvidence.length >= 3) throw Object.assign(Error('research-evidence-budget'), { code: 'research-evidence-budget' });
              initialEvidence.push(await this.prepareAstraAgentResearchEvidence(current.turn));
            }
            prepared = { kind: 'agent-attachments-v1', initialEvidence };
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
            await this.finishTurn(this.storeForTurn(current.turn), turnId, {
              status: 'blocked', kind: 'blocked',
              summary: stage === 'attachments'
                ? 'Операционная задача с вложением не запущена: вложение не удалось безопасно преобразовать в недоверенный V3-контекст.'
                : code === 'research-evidence-budget'
                  ? 'Задача не запущена: вместе с поиском можно передать не больше двух вложений. Убери лишние и повтори.'
                  : 'Задача не запущена: поиск в интернете не дал данных, а действовать без них нельзя. Действия не выполнялись; попробуй ещё раз.',
              warning: code || (stage === 'attachments' ? 'attachment-observation-unavailable' : 'research-unavailable'),
              events: [{ type: 'turn.routed', payload: { disposition: 'agent',
                blockedBy: stage === 'attachments' ? 'attachment-observation-unavailable' : 'research-unavailable' } }],
            });
            return;
          }
        } else if (port.prepare) prepared = await port.prepare(current.turn);
        current = await this.requireTurn(turnId);
        // Preparation has no execution authority. Recheck durable control before
        // the synchronous task/source admission, including Stop during recall.
        if (TERMINAL_TURN_STATUSES.has(current.turn.status) || current.turn.astraControl?.desired === 'cancel') {
          if (!TERMINAL_TURN_STATUSES.has(current.turn.status)) await this.finishTurn(this.storeForTurn(current.turn), turnId,
            { status: 'cancelled', kind: 'cancelled', summary: 'Задача отменена до передачи в Astra. Действия не запускались.', events: [] });
          this.astraTurns.delete(turnId); return;
        }
        if (current.turn.astraControl?.desired === 'pause') return;
      }
      const task = existing ?? port.submit(current.turn, prepared);
      if (current.turn.astraControl && !task.message) port.command(current.turn, current.turn.astraControl.desired);
      if (current.turn.taskId && current.turn.taskId !== task.id) throw Error('astra-oscar-task-link-conflict');
      if (!current.turn.taskId) await this.updateTurn(this.storeForTurn(current.turn), turnId, turn => ({
        turn: { ...turn, taskId: task.id }, events: [{ type: 'task.linked', payload: { taskId: task.id, runtime: 'astra-v3' } }],
      }));
      const latest = await this.requireTurn(turnId);
      if (latest.turn.astraControl?.sequence !== current.turn.astraControl?.sequence && latest.turn.astraControl)
        port.command(latest.turn, latest.turn.astraControl.desired);
      await this.reconcileAstraTurn(turnId); return;
    }
    throw new Error('astra-oscar-binding-required');
  }

  /** The host's search for a task that acts on public data, under the consent
   * the routing step already consumed. The result is untrusted evidence. */
  private async prepareAstraAgentResearchEvidence(turn: OscarTurnV1): Promise<AstraAgentInitialEvidenceItem> {
    if (!this.options.researchEvidence) throw Object.assign(Error('research-unavailable'), { code: 'research-unavailable' });
    const text = await this.options.researchEvidence({
      query: effectiveTurnRequest(turn).slice(0, 2048),
      deep: turn.request.modifiers.researchMode === 'deep',
      signal: AbortSignal.timeout(120_000),
    });
    if (!text.trim()) throw Object.assign(Error('research-empty'), { code: 'research-empty' });
    return { ref: 'agent_research_0', digest: 'sha256:' + createHash('sha256').update(text).digest('hex'), text };
  }

  private async prepareAstraAgentAttachmentEvidence(turn: OscarTurnV1): Promise<AstraAgentInitialEvidenceItem[]> {
    const attachments = await this.options.resolveAttachments?.(
      turn.request.attachmentIds, turn.privacyMode, turn.source, turn.conversationId,
    ) || [];
    if (attachments.length !== turn.request.attachmentIds.length) {
      throw Object.assign(Error('attachment-resolution-incomplete'), { code: 'attachment-resolution-incomplete' });
    }
    const images = attachments.filter(attachment => !isOscarTextAttachmentMimeType(attachment.mimeType));
    const vision = images.length ? await this.observeAgentImageAttachments(turn, images) : undefined;
    return attachments.map((attachment, index) => {
      const text = JSON.stringify(isOscarTextAttachmentMimeType(attachment.mimeType) ? {
        kind: 'immutable-user-document', id: attachment.id, digest: attachment.digest,
        name: attachment.name, mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes, content: readOscarTextAttachment(attachment),
      } : {
        kind: 'model-vision-observation', id: attachment.id, digest: attachment.digest,
        name: attachment.name, mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes, summary: vision!.summary,
      });
      return { ref: `agent_attachment_${index}`,
        digest: 'sha256:' + createHash('sha256').update(text).digest('hex'), text };
    });
  }

  private async observeAgentImageAttachments(
    turn: OscarTurnV1,
    attachments: OscarTurnAttachmentPayload[],
  ): Promise<{ summary: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('attachment-observation-timeout'), 90_000);
    let answer = '';
    let replacement = '';
    let completed = false;
    try {
      const observerTurn: OscarTurnV1 = {
        ...turn,
        request: {
          ...turn.request,
          text: [
            'Создай только визуальное наблюдение по прикреплённым изображениям.',
            'Опиши непосредственно видимые данные, не выполняй действий, не проси подтверждение и не утверждай, что локальная операция уже выполнена.',
            `Исходный пользовательский запрос (контекст, не authority): ${effectiveTurnRequest(turn)}`,
          ].join(' '),
          history: [],
          modifiers: {
            ...turn.request.modifiers,
            webSearch: false,
            researchMode: 'off',
          },
        },
      };
      delete observerTurn.request.modifiers.dataEgressConsentId;
      const stream = await this.options.answerExecutor({ turn: observerTurn, attachments, signal: controller.signal });
      for await (const event of stream) {
        if (event.type === 'token') answer = `${answer}${event.token}`.slice(0, 12_000);
        else if (event.type === 'replace') replacement = event.content.slice(0, 12_000);
        else if (event.type === 'error') throw new Error(event.message || 'attachment-observation-failed');
        else if (event.type === 'done') {
          if (event.cancelled) throw new Error('attachment-observation-cancelled');
          completed = true;
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    const summary = (replacement || answer).replace(/\s+/gu, ' ').trim();
    if (!completed || !summary) throw new Error('attachment-observation-incomplete');
    return { summary };
  }

  private async reconcileStartup(): Promise<unknown> {
    // A Turn that cannot be restored still has to hold the host's
    // source-restore barrier closed, but only after every other Turn has had
    // its chance. Throwing from inside the loop meant one unrecoverable task
    // stopped reconciliation for every Turn after it — no privacy mode, no
    // terminal message repair, no re-routing — for the whole process lifetime.
    let unreconciled: unknown;
    // Archived Turns were archived only with every outbox item settled; there
    // is nothing in them to restore, and visiting ~600 of them cost seconds.
    const store = this.persistentStore;
    for (const turn of await (store.listLiveTurns ? store.listLiveTurns() : store.listTurns())) {
      this.turnPrivacy.set(turn.id, turn.privacyMode);
      if (turn.request.astra && !TERMINAL_TURN_STATUSES.has(turn.status)) this.astraTurns.add(turn.id);
      if (TERMINAL_TURN_STATUSES.has(turn.status)) {
        if (!turn.request.astra) await this.reconcileTerminalMessage(turn).catch(() => undefined);
      } else if (turn.request.astra) {
        try {
          if (turn.status === 'accepted' || turn.status === 'routing') {
          const cancelled = await this.cancelForClientIntent(turn);
          if (!cancelled) await this.routeAcceptedTurn(turn.id);
          await this.ensureAgentTask(turn.id);
          } else {
            // Restore durable desired control even when its outbox retry time is
            // in the future. Failure must hold the host's source-restore barrier closed.
            await this.ensureAgentTask(turn.id);
          }
        } catch (error) {
          if (!isAstraActorMigrationMismatch(error)) { unreconciled ??= error; continue; }
          // Builds before the persistent actor root existed cannot reconstruct
          // the process-random identity that admitted this Turn. Preserve the
          // strict actor comparison, settle only that unrecoverable Turn, and
          // allow the rest of the application to start.
          await this.finishTurn(this.persistentStore, turn.id, {
            status: 'blocked', kind: 'blocked',
            summary: 'Задача создана прежней версией идентификации Astra и не может быть безопасно продолжена после перезапуска. Повтори её — новая задача сохранит личность между запусками.',
            warning: 'astra-persistent-actor-migration-required',
            events: [{ type: 'turn.routed', payload: { disposition: 'agent', blockedBy: 'astra-persistent-actor-migration-required' } }],
          });
          this.astraTurns.delete(turn.id);
        }
      } else if (turn.status === 'accepted' || turn.status === 'routing') {
          const cancelled = await this.cancelForClientIntent(turn).catch(() => null);
          // Swallowing a re-routing failure left the Turn in `routing` across
          // every later restart: no outcome, no message, nothing to retry from.
          if (!cancelled) {
            await this.routeAcceptedTurn(turn.id)
              .catch((error) => this.failTurn(turn.id, error).catch(() => undefined));
          }
      } else if (turn.mode === 'agent' || turn.taskId) {
        await this.finishTurn(this.persistentStore, turn.id, {
          status: 'blocked', kind: 'blocked',
          summary: 'Незавершённая задача прежнего runtime остановлена. Повтори её — новый Turn будет выполняться только через Astra V3.',
          warning: 'legacy-agent-runtime-retired', events: [],
        }).catch(() => undefined);
      } else if (turn.mode === 'answer' && turn.status === 'answering') {
        this.launchAnswer(turn.id);
      }
    }
    return unreconciled;
  }

  private async reconcileTerminalMessage(turn: OscarTurnV1): Promise<void> {
    const messageId = terminalMessageId(turn.id);
    if (
      turn.privacyMode !== 'persistent'
      || !turn.outcome
      || turn.conversationId.startsWith('legacy:')
      || (
        turn.outputMessageId
        && turn.outputMessageId !== messageId
        && !hasRecoverableLegacyTerminalOutput(turn)
      )
    ) return;
    const linkedTaskId = turn.taskId;
    await this.persistentStore.ensureTerminalMessage(turn.id, {
      messageId,
      outbox: messageOutbox(turn, {
        conversationId: turn.conversationId,
        messageId,
        role: 'assistant',
        content: turn.outcome.summary,
        turnId: turn.id,
        ...(linkedTaskId ? { taskId: linkedTaskId } : {}),
        provenance: {
          schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
          origin: 'system',
          verification: 'system-state',
          turnId: turn.id,
          ...(linkedTaskId ? { taskId: linkedTaskId } : {}),
        },
        outcome: turn.outcome.kind,
        createConversationIfMissing: false,
        requiredPreviousMessageId: turn.inputMessageId,
      }),
    });
  }

  /** Background wake of the outbox. A store write can fail here (live: Windows
   * refused the rename of turns.v1.json while another reader held it) and the
   * failed item stays pending for the next wake; a `void` promise that rejects
   * instead ended the whole server process with an unhandled rejection. */
  private kickOutbox(): void {
    this.drainOutbox().catch(error => reportBackgroundFailure('outbox', error));
  }

  /** runAnswer settles its own turn; only a failure while recording that
   * outcome reaches here, and startup reconciliation owns such a turn. */
  private launchAnswer(turnId: string): void {
    this.runAnswer(turnId).catch(error => reportBackgroundFailure('answer', error));
  }

  private drainOutbox(): Promise<void> {
    if (!this.started) return Promise.resolve();
    if (this.outboxDrain) return this.outboxDrain;
    const drain = this.runOutboxDrain().finally(() => {
      if (this.outboxDrain === drain) this.outboxDrain = null;
      this.scheduleOutbox();
    });
    this.outboxDrain = drain;
    return drain;
  }

  private async runOutboxDrain(): Promise<void> {
    for (const store of [this.persistentStore, this.volatileStore]) {
      const items = (await store.listPendingOutbox()).sort((left, right) => (
        outboxDispatchPriority(left.kind) - outboxDispatchPriority(right.kind)
        || left.createdAt.localeCompare(right.createdAt)
      ));
      for (const item of items) {
        const storedKind: string = item.kind;
        try {
          if (item.kind === 'persist-message') {
            let message = item.payload as unknown as OscarPersistedMessage;
            // Retained pre-exact-mode Astra outboxes must not silently return to
            // legacy trimming. Derive this only from their durable Turn owner;
            // do not rewrite an immutable outbox or already-normalized history.
            if (this.options.astra && (message.contentMode !== 'exact'
              || message.role === 'assistant' && message.historyLinkMode !== 'same-turn-user')) {
              const owner = await store.getTurn(item.turnId);
              if (owner?.turn.request.astra) message = { ...message, contentMode: 'exact',
                ...(message.role === 'assistant' ? { historyLinkMode: 'same-turn-user' } : {}) };
            }
            const receipt = await this.options.persistMessage(message);
            if (message.astraCertificateDigest && receipt?.disposition !== 'created' && receipt?.disposition !== 'duplicate') {
              throw new Error(receipt?.disposition === 'superseded'
                ? 'astra-message-superseded-before-delivery' : 'astra-message-persistence-receipt-required');
            }
            if (message.astraCertificateDigest) {
              const turn = await this.requireTurn(item.turnId);
              this.requireAstra().acknowledge(turn.turn, message.astraCertificateDigest);
            }
            if (receipt?.disposition === 'superseded') {
              if (message.role !== 'assistant' || !message.requiredPreviousMessageId) {
                throw new Error('Only a prerequisite-bound assistant message may be superseded.');
              }
              await store.markOutboxSuperseded(item.id);
              continue;
            }
          } else if (item.kind === 'astra-control') {
            const { turn } = await this.requireTurn(item.turnId);
            if (!turn.request.astra) throw Error('astra-oscar-binding-required');
            if (turn.astraControl?.sequence === item.payload.sequence) await this.ensureAgentTask(turn.id);
          } else if (item.kind === 'astra-wake') {
            const { turn } = await this.requireTurn(item.turnId);
            if (!turn.request.astra || !turn.astraRecoveryRequests?.includes(String(item.payload.requestId))) throw Error('astra-recovery-binding');
            if (!TERMINAL_TURN_STATUSES.has(turn.status)) {
              const port = this.requireAstra(); if (!port.wake) throw Error('astra-recovery-unavailable');
              port.wake(turn); this.astraTurns.add(turn.id); await this.reconcileAstraTurn(turn.id);
            }
          } else if (item.kind === 'astra-input') {
            const { turn } = await this.requireTurn(item.turnId);
            if (!turn.request.astra) throw Error('astra-oscar-binding-required');
            if (turn.astraControl?.desired !== 'cancel') this.requireAstra().input(turn, item.payload.input as unknown as OscarAstraInput);
            await this.reconcileAstraTurn(turn.id);
          } else if (item.kind === 'create-agent-task') {
            await this.ensureAgentTask(
              item.turnId,
              typeof item.payload.kind === 'string' ? item.payload.kind : undefined,
            );
          } else if (storedKind === 'send-agent-message' || storedKind === 'reconcile-turn') {
            // Retained V2 outboxes are migration debris, never executable work.
            await store.markOutboxSuperseded(item.id);
            continue;
          }
          await store.markOutboxSucceeded(item.id);
        } catch (error) {
          const attempts = item.attempts + 1;
          const detail = error instanceof Error ? error.message : String(error);
          if (item.kind === 'persist-message' && isOutboxPrerequisitePending(error)
            && (attempts >= OUTBOX_PREREQUISITE_ABANDON_ATTEMPTS
              || !await this.outboxWillDeliverPrerequisite(store, item))) {
            await store.markOutboxSuperseded(item.id, detail);
            continue;
          }
          const delayMs = Math.min(60_000, 250 * (2 ** Math.min(attempts, 8)));
          await store.markOutboxFailed(
            item.id,
            detail,
            new Date(Date.now() + delayMs).toISOString(),
          );
        }
      }
    }
    // Reuse the existing outbox wake. This is projection, not an Astra work loop.
    for (const turnId of this.astraTurns) {
      const found = await this.getTurn(turnId);
      if (!found || TERMINAL_TURN_STATUSES.has(found.turn.status)) { this.astraTurns.delete(turnId); continue; }
      const turn = found.turn;
      if (turn.request.astra && turn.taskId && !TERMINAL_TURN_STATUSES.has(turn.status)) {
        try { await this.reconcileAstraTurn(turn.id); }
        catch {
          // Keep uncertainty visible without inventing a terminal result or
          // switching executors. Store failures still propagate to the caller.
          const current = await this.requireTurn(turn.id);
          const last = [...current.events].reverse().find(event => event.payload.runtime === 'astra-v3');
          if (!TERMINAL_TURN_STATUSES.has(current.turn.status) && last?.payload.runtimeIssue !== 'source-projection-failed')
            await this.updateTurn(this.persistentStore, turn.id, value => ({ turn: value, events: [{ type: 'agent.progress',
              payload: { runtime: 'astra-v3', runtimeIssue: 'source-projection-failed', nativeCompletionCertified: false } }] }));
        }
      }
    }
  }

  private scheduleOutbox(): void {
    if (!this.started || this.outboxTimer) return;
    this.outboxTimer = setTimeout(() => {
      this.outboxTimer = null;
      this.kickOutbox();
    }, 1_000);
    this.outboxTimer.unref?.();
  }

  private async findActiveApprovalTurn(conversationId: string): Promise<OscarTurnCheckpoint | null> {
    const turns = [
      ...await this.persistentStore.listTurns(),
      ...await this.volatileStore.listTurns(),
    ].filter((turn) => turn.conversationId === conversationId && turn.status === 'waiting-for-approval')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return turns[0] ? this.getTurn(turns[0].id) : null;
  }

  private async approvalPresentationEvent(turn: OscarTurnV1): Promise<OscarTurnEventDraft[]> {
    const checkpoint = await this.getTurn(turn.id);
    const event = checkpoint?.events.filter(candidate => candidate.type === 'approval.required').at(-1);
    return event ? [{ type: 'approval.required', payload: structuredClone(event.payload) }] : [];
  }

  private async finishTurn(
    store: OscarTurnStore,
    turnId: string,
    input: {
      status: Extract<OscarTurnStatus, 'succeeded' | 'blocked' | 'failed' | 'cancelled'>;
      kind: OscarTurnOutcomeKind;
      summary: string;
      warning?: string;
      diagnostic?: OscarTurnFailureDiagnostic;
      usage?: Record<string, unknown>;
      evidenceRefs?: AgentEvidenceReference[];
      /** What the chat shows for each source; never part of provenance. */
      sources?: OscarDisplaySource[];
      taskId?: string;
      outputMessageId?: string;
      events: OscarTurnEventDraft[];
      outbox?: OscarTurnOutboxItem[] | Array<ReturnType<typeof messageOutbox>>;
    },
  ): Promise<OscarTurnCheckpoint> {
    return this.updateTurn(store, turnId, (turn) => {
      if (TERMINAL_TURN_STATUSES.has(turn.status)) return { turn, events: [] };
      const completedAt = this.nowIso();
      const implicitMessageId = terminalMessageId(turn.id);
      const linkedTaskId = input.taskId || turn.taskId;
      const implicitOutbox = turn.privacyMode === 'persistent' && input.outbox === undefined
        ? [messageOutbox(turn, {
            conversationId: turn.conversationId,
            messageId: implicitMessageId,
            role: 'assistant',
            content: input.summary,
            turnId: turn.id,
            ...(linkedTaskId ? { taskId: linkedTaskId } : {}),
            provenance: {
              schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
              origin: 'system',
              verification: 'system-state',
              turnId: turn.id,
              ...(input.evidenceRefs?.length ? { evidenceRefs: input.evidenceRefs } : {}),
              ...(linkedTaskId ? { taskId: linkedTaskId } : {}),
            },
            outcome: input.kind,
          })]
        : [];
      const outputMessageId = input.outputMessageId
        || (implicitOutbox.length > 0 ? implicitMessageId : undefined);
      return {
        turn: {
          ...turn,
          status: input.status,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(outputMessageId ? { outputMessageId } : {}),
          outcome: {
            kind: input.kind,
            summary: input.summary,
            evidenceRefs: input.evidenceRefs || [],
            ...(input.warning ? { warning: input.warning } : {}),
            ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
            completedAt,
          },
        },
        events: [
          ...input.events,
          {
            type: input.status === 'failed' ? 'turn.failed' : 'turn.outcome',
            payload: {
              outcome: input.kind,
              summary: input.summary,
              taskId: input.taskId || turn.taskId || '',
              ...(input.usage ? { usage: input.usage } : {}),
              ...(input.sources?.length ? { sources: input.sources } : {}),
            },
          },
        ],
        outbox: input.outbox || implicitOutbox,
      };
    });
  }

  /** The backend reports a missing prerequisite in two very different
   * situations: while the user message is still queued here — a real race that
   * resolves within the same drain pass — and forever after its conversation
   * was deleted, which no amount of retrying can repair. Only this host can
   * tell them apart, because only it knows what is still queued: if nothing in
   * its own outbox will ever deliver that prerequisite, it cannot arrive. */
  private async outboxWillDeliverPrerequisite(
    store: OscarTurnStore,
    item: OscarTurnOutboxItem,
  ): Promise<boolean> {
    const payload = item.payload as unknown as OscarPersistedMessage;
    const required = payload?.requiredPreviousMessageId;
    if (!required) return false;
    // A far horizon returns every unsettled entry, including one whose retry is
    // scheduled well beyond this drain pass.
    const queued = await store.listPendingOutbox(new Date(Date.now() + OUTBOX_PREREQUISITE_SCAN_HORIZON_MS));
    return queued.some((entry) => {
      if (entry.id === item.id || entry.kind !== 'persist-message') return false;
      const candidate = entry.payload as unknown as OscarPersistedMessage;
      return candidate?.messageId === required && candidate?.conversationId === payload.conversationId;
    });
  }

  private async failTurn(turnId: string, error: unknown): Promise<void> {
    const checkpoint = await this.getTurn(turnId);
    if (!checkpoint || TERMINAL_TURN_STATUSES.has(checkpoint.turn.status)) return;
    const diagnostic = turnFailureDiagnostic(error);
    await this.finishTurn(this.storeForTurn(checkpoint.turn), turnId, {
      status: 'failed',
      kind: 'failed',
      summary: userFacingTurnFailure(error),
      diagnostic,
      events: [],
    });
    this.kickOutbox();
  }

  private async bindOrdinaryAgentTurn(
    store: OscarTurnStore,
    turnId: string,
    hostResearch = false,
  ): Promise<OscarTurnCheckpoint | null> {
    if (!this.options.astra?.bindAgent) return null;
    await this.options.astra.refreshAgentAvailability?.();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await store.getTurn(turnId);
      if (!current) throw new OscarTurnCoordinatorError(404, 'turn-not-found', 'Oscar Turn was not found.');
      if (current.turn.request.astra) {
        if (current.turn.request.astra.admission !== 'ordinary-agent-v1') {
          throw new OscarTurnCoordinatorError(409, 'astra-binding-conflict', 'Oscar Turn already has another executor binding.');
        }
        return current;
      }
      if (current.turn.status !== 'routing') return current;
      // With host research the search is Monarch's step under the consent
      // already consumed; the task itself never gets internet modifiers.
      const binding = this.options.astra.bindAgent(hostResearch ? withoutResearchModifiers(current.turn) : current.turn);
      if (!binding) return null;
      try {
        return await store.bindOrdinaryAgent(turnId, binding, { expectedRevision: current.turn.revision });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'turn-revision-conflict')
          || attempt === 11) throw error;
      }
    }
    throw new OscarTurnCoordinatorError(409, 'turn-revision-conflict', 'Oscar Turn could not bind its V3 agent after repeated CAS conflicts.');
  }

  private async updateTurn(
    store: OscarTurnStore,
    turnId: string,
    mutator: (turn: OscarTurnV1) => {
      turn: OscarTurnV1;
      events: OscarTurnEventDraft[];
      outbox?: Array<{
        id: string;
        turnId: string;
        kind: OscarTurnOutboxItem['kind'];
        payload: Record<string, unknown>;
      }>;
    },
  ): Promise<OscarTurnCheckpoint> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await store.getTurn(turnId);
      if (!current) throw new OscarTurnCoordinatorError(404, 'turn-not-found', 'Oscar Turn was not found.');
      const mutation = mutator(current.turn);
      try {
        return await store.saveTurn(mutation.turn, {
          expectedRevision: current.turn.revision,
          events: mutation.events,
          ...(mutation.outbox?.length ? { outbox: mutation.outbox } : {}),
        });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'turn-revision-conflict') || attempt === 11) {
          throw error;
        }
      }
    }
    throw new OscarTurnCoordinatorError(409, 'turn-revision-conflict', 'Oscar Turn could not be updated after repeated CAS conflicts.');
  }

  private async requireTurn(turnId: string): Promise<OscarTurnCheckpoint> {
    const checkpoint = await this.getTurn(normalizeId(turnId, 'turn'));
    if (!checkpoint) throw new OscarTurnCoordinatorError(404, 'turn-not-found', 'Oscar Turn was not found.');
    this.turnPrivacy.set(checkpoint.turn.id, checkpoint.turn.privacyMode);
    return checkpoint;
  }

  private storeForTurn(turn: OscarTurnV1): OscarTurnStore {
    return this.storeForPrivacy(turn.privacyMode);
  }

  private storeForPrivacy(privacy: OscarPrivacyMode): OscarTurnStore {
    return privacy === 'persistent' ? this.persistentStore : this.volatileStore;
  }

  private nowIso(): string {
    return (this.options.now?.() || new Date()).toISOString();
  }
}


/** Codes only: a store error message names paths, never turn content. */
function reportBackgroundFailure(work: 'outbox' | 'answer', error: unknown): void {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : error instanceof Error ? error.name : 'unknown';
  console.error(JSON.stringify({ diagnostic: 'oscar-turn-background-failure', work, code: code.slice(0, 60) }));
}

export function userFacingTurnFailure(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'vision-unavailable') {
    return 'Изображение прикреплено, но локальная модель не смогла его обработать. Проверь доступность адаптера Vision и повтори запрос.';
  }
  const message = error instanceof Error ? error.message : String(error || '');
  if (message === 'custom-model-draft-only') return 'Это MTP draft — вспомогательная часть модели. Она не отвечает самостоятельно. Добавь основной GGUF этой модели без draft/mtp в Настройки → Модели.';
  if (message === 'custom-model-auxiliary') return 'Этот GGUF — адаптер или проектор. Для чата нужен основной GGUF модели. Добавь его в Настройки → Модели.';
  if (message === 'custom-model-format') return 'Структура выбранного GGUF повреждена или не поддерживается. Выбери другой цельный файл модели в Настройки → Модели.';
  if (message === 'custom-model-split') return 'Выбранный GGUF — часть разделённой модели. Для кастомного чата нужен цельный файл .gguf.';
  if (message === 'custom-model-missing') return 'Файл кастомной модели не найден. Проверь его расположение и добавь модель заново в Настройки → Модели.';
  if (/^astra-max-native:[a-z0-9-]{1,80}$/u.test(message)) return maxNativeErrorText(message);
  if (/(?:^|\s)task-fault:[a-z0-9:-]{1,90}$/u.test(message)) {
    return 'Oscar не смог продолжить эту задачу из-за внутренней ошибки проверки и остановил её. Другие задачи это не затронуло. '
      + 'Подтверждённые результаты сохранены; незавершённые действия не считаются выполненными. Повтори запрос.';
  }
  const applicationFailure = message.match(/computer-application-sequence:\s*(.{1,600})/u);
  if (applicationFailure) return applicationFailure[1]!;
  if (/capability-not-in-candidate-set|Capability .+ is not in the current resolver result/iu.test(message)) {
    return 'Oscar не смог выбрать доступное действие. Выполнение остановлено; неподтверждённые действия не считаются выполненными.';
  }
  if (/(?:agent-decision-time-budget|decision cycle.*time budget)/i.test(message)) {
    return 'Oscar остановил слишком долгий выбор следующего действия по лимиту времени. Ранее подтверждённые результаты сохранены; новых действий не было.';
  }
  if (/context-capacity-insufficient/i.test(message)) {
    return 'Контекст агентской модели не вместил цель и доступные действия. Oscar остановился до выполнения новых действий.';
  }
  if (/(?:unexpected fields?|invalid-plan|plan-step|revise-plan|decision(?:-json)? schema|decision-json-invalid|schema validation)/i.test(message)) {
    return 'План задачи не прошёл проверку. Oscar остановился до новых действий; выполнение не подтверждено.';
  }
  if (/(?:model runtime|model unavailable|runtime unavailable|connection refused|econnrefused)/i.test(message)) {
    return 'Локальная модель сейчас недоступна. Никакие новые действия не подтверждены.';
  }
  if (/agent-runtime-host-retired|control-budget-exhausted/i.test(message)) {
    return 'Исполнитель Oscar перестал вести эту задачу, и она остановлена. Подтверждённые результаты сохранены; '
      + 'незавершённые действия не считаются выполненными. Повтори запрос.';
  }
  if (/(?:cancelled|canceled|abort)/i.test(message)) {
    return 'Задача остановлена. Выполненными считаются только уже подтверждённые результаты.';
  }
  if (/Bound Astra host is unavailable/u.test(message)) {
    return 'Агентные задачи сейчас недоступны: исполнитель задач не запустился. Обычный чат работает. Перезапусти Monarch; если не поможет — открой Диагностику.';
  }
  if (message === 'astra-restore-held') {
    return 'Агентные задачи сейчас приостановлены: после перезапуска Monarch не смог восстановить одну из прошлых задач. Обычный чат работает. Перезапусти Monarch; если не поможет — открой Диагностику.';
  }
  // Agent stop reasons used to reach the person as the generic line below.
  if (message === 'task-deadline') {
    return 'Задача не уложилась в отведённое время, и Oscar остановил её. Подтверждённые результаты сохранены; продолжи следующим сообщением или раздели задачу на части.';
  }
  if (/recovery finished without a trustworthy final answer/iu.test(message)) {
    return 'После перезапуска Oscar восстановил задачу, но не смог получить надёжный итоговый ответ. Подтверждённые результаты сохранены; повтори запрос, если нужен итог.';
  }
  if (message === 'question-budget') {
    return 'Агент задал несколько вопросов подряд, но так и не перешёл к делу, поэтому Oscar остановил задачу. Подтверждённые результаты сохранены. Попробуй сформулировать задачу целиком или выбери другую модель.';
  }
  if (message === 'model-turn-budget') {
    return 'Задача заняла больше шагов, чем отведено на одну задачу, и Oscar остановил её. Подтверждённые результаты сохранены; продолжи следующим сообщением или раздели задачу на части.';
  }
  if (message === 'capability-call-budget') {
    return 'Задача потребовала больше действий, чем разрешено на одну задачу, и Oscar остановил её. Подтверждённые результаты сохранены; продолжи следующим сообщением.';
  }
  if (message === 'failed-action-repeated') {
    return 'Одно и то же действие снова не удалось, и Oscar не стал повторять его бесконечно. Подтверждённые результаты сохранены; посмотри ошибку шага выше.';
  }
  if (message === 'rejected-action-repeated') {
    return 'Модель снова предложила действие, которое ты уже отклонил, поэтому Oscar остановил задачу. Подтверждённые результаты сохранены.';
  }
  if (message === 'model-output-limit') {
    return 'Следующий шаг модели оборвался на лимите длины ответа, и Oscar не принял его. Увеличь «Длину ответа» в Настройки → MAX, сузь задачу или попроси делать её частями.';
  }
  if (message === 'transport-deadline') {
    return 'Модель на компьютере не успела ответить вовремя: компьютер был занят другой тяжёлой работой. Подтверждённые результаты сохранены; повтори запрос позже или выбери MAX.';
  }
  if (message === 'proposal-json' || message === 'proposal-schema') {
    return 'Модель дважды вернула следующий шаг в неправильном формате, и Oscar остановился, не выполнив его. Повтори запрос.';
  }
  if (MAX_PROVIDER_FAILURE.test(message)) return maxNativeErrorText(message);
  // Every code reaching this line is a failure the person could not act on.
  // Name it once in the runtime log so it can be given real words.
  console.error(JSON.stringify({ diagnostic: 'oscar-turn-unmapped-failure', code: message.slice(0, 160) }));
  return 'Не удалось завершить задачу. Технические детали сохранены локально; неподтверждённые действия не считаются выполненными.';
}

/** A MAX provider failure reaches a Turn as its bare closed-vocabulary code, optionally
 * behind a stage or transport prefix. Without this it falls to the generic line, which
 * names unconfirmed actions for a request that never had any and hides the one thing the
 * person can act on: the key, the quota or the size of the request. */
// Grammar mirrors the provider exactly: an optional stage (`primary-`,
// `safety-input-`, `safety-output-`), then an optional `provider-`, then one
// code of the closed vocabulary. The former list stopped at `rate-limit`, so the
// real `provider-rate-limited`, and every timeout, outage or rejected key, fell
// to the generic line about unconfirmed actions.
const MAX_PROVIDER_FAILURE = /^(?:astra-max-provider:)?(?:safety-(?:input|output)-|primary-)?(?:provider-)?(?:json-validation-failed|context-too-large|output-truncated|safety-blocked(?:-(?:input|output|model))?|empty-output|response-rejected|unexpected-tool-call|finish|response|connection-changed|credential-(?:unavailable|invalid|rejected)|model-not-(?:available|allowed)|model-unavailable|safety-model-unavailable|image-model-unavailable|consent-required|rate-limit(?:ed)?|quota-exceeded|timeout|unavailable|rejected|request-rejected)$/u;

export function turnFailureDiagnostic(error: unknown): OscarTurnFailureDiagnostic {
  const rawMessage = error instanceof Error ? error.message : String(error || 'unknown-turn-failure');
  const detail = String(redactAgentContextValue(rawMessage, { maxStringChars: 2_000 }).value)
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 2_000) || 'unknown-turn-failure';
  const code = failureDiagnosticCode(error, detail);
  return {
    code,
    detail,
    fingerprint: `sha256:${createHash('sha256').update(`${code}\n${detail}`, 'utf8').digest('hex')}`,
  };
}

/** Bounded MAX failure code for the local-fallback label, never provider text. */
/** An error that carries an exact MAX failure code (not just any failure). */
function isMaxNativeFailure(error: unknown): boolean {
  return [error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '',
    error instanceof Error ? error.message : ''].some((value) => /^astra-max-native:[a-z0-9-]{1,80}$/u.test(value));
}

function maxFailureCode(error: unknown): string {
  const candidates = [
    error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '',
    error instanceof Error ? error.message : '',
  ];
  return candidates.find((value) => /^astra-max-native:[a-z0-9-]{1,80}$/u.test(value)) || 'astra-max-native:unavailable';
}

function rejectedAnswerTerminalError(failure?: string): Error & { code: string } {
  const detail = String(failure || '').trim() || 'oscar-answer-runtime-failed';
  const code = /^[a-z][a-z0-9-]{0,63}$/u.test(detail)
    ? detail
    : 'oscar-answer-runtime-failed';
  return Object.assign(new Error(code), { code });
}

function failureDiagnosticCode(error: unknown, detail: string): string {
  const explicit = error && typeof error === 'object' && 'code' in error
    ? String(error.code || '').trim()
    : '';
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(explicit)) return explicit;
  if (/^astra-max-native:[a-z0-9-]{1,80}$/u.test(detail)) return detail;
  if (/(?:agent-decision-time-budget|decision cycle.*time budget)/iu.test(detail)) return 'agent-decision-time-budget';
  if (/(?:unexpected fields?|invalid-plan|plan-step|revise-plan|decision schema|schema validation)/iu.test(detail)) {
    return 'agent-plan-validation';
  }
  if (/(?:model runtime|model unavailable|runtime unavailable|connection refused|econnrefused)/iu.test(detail)) {
    return 'model-runtime-unavailable';
  }
  if (/external-sources-without-data-egress-consent/iu.test(detail)) return 'data-egress-boundary';
  if (/(?:cancelled|canceled|abort)/iu.test(detail)) return 'turn-cancelled';
  const name = error instanceof Error ? String(error.name || '').trim() : '';
  return /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(name) && name !== 'Error' ? name : 'turn-failure';
}

/** The restore barrier stays closed after startup; the application keeps running. */
export class OscarAstraRestoreHeldError extends Error {
  readonly code = 'astra-restore-held';
  constructor(readonly cause: unknown) {
    super('astra-restore-held: ' + (cause instanceof Error ? cause.message : String(cause)));
    this.name = 'OscarAstraRestoreHeldError';
  }
}

export class OscarTurnCoordinatorError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'OscarTurnCoordinatorError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeSubmission(input: SubmitOscarTurnInput) {
  const history = Array.isArray(input.history) ? input.history.slice(-24).map((entry) => ({
    role: entry.role === 'assistant' ? 'assistant' as const : 'user' as const,
    content: normalizeMultilineText(entry.content, 20_000, 'history message'),
  })) : [];
  return {
    clientRequestId: normalizeId(input.clientRequestId, 'client request'),
    conversationId: normalizeId(input.conversationId, 'conversation'),
    text: input.astra ? exactAstraRequestText(input.text) : normalizeMultilineText(input.text, 20_000, 'request'),
    privacyMode: input.privacyMode,
    source: input.source,
    inputMessageId: input.inputMessageId
      ? normalizeId(input.inputMessageId, 'input message')
      : `oscar_message_${randomUUID().replace(/-/g, '')}`,
    attachmentIds: [...new Set((input.attachmentIds || []).map((id) => normalizeId(id, 'attachment')))].slice(0, 3),
    modifiers: normalizeModifiers(input.modifiers || {}),
    history,
    ...(input.source === 'telegram' && input.telegramActor ? { telegramActor: structuredClone(input.telegramActor) } : {}),
    ...(input.authenticatedAgentActor ? { authenticatedAgentActor: structuredClone(input.authenticatedAgentActor) } : {}),
    ...(input.executionProfile
      ? { executionProfile: normalizeTurnExecutionProfile(input.executionProfile, input.source) }
      : {}),
    ...(input.explicitAgentTask ? { explicitAgentTask: structuredClone(input.explicitAgentTask) } : {}),
    ...(input.replyToTurnId ? { replyToTurnId: normalizeId(input.replyToTurnId, 'reply Turn') } : {}),
    ...(input.supersedesTurnId ? { supersedesTurnId: normalizeId(input.supersedesTurnId, 'superseded Turn') } : {}),
    ...(input.retryOf ? { retryOf: normalizeId(input.retryOf, 'retry Turn') } : {}),
  };
}

function normalizeModifiers(value: OscarTurnModifiers): OscarTurnModifiers {
  const imageGenerationCapability = value.imageGenerationCapability;
  const computerUseCapability = value.computerUseCapability;
  const imageGeneration = value.imageGeneration;
  const validImageDisposition = [
    'ready',
    'provider-consent-required',
    'perchance-adult-attestation-required',
    'confirmation-required',
    'mature-mode-disabled',
    'prohibited-content',
  ].includes(String(imageGeneration?.disposition || ''));
  return {
    ...(typeof value.requestedModel === 'string' && value.requestedModel.trim()
      ? { requestedModel: value.requestedModel.trim().slice(0, 200) }
      : {}),
    ...(['low', 'medium', 'high'].includes(String(value.reasoningEffort))
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
    ...(typeof value.webSearch === 'boolean' ? { webSearch: value.webSearch } : {}),
    ...(['auto', 'off', 'deep'].includes(String(value.researchMode))
      ? { researchMode: value.researchMode }
      : {}),
    ...(typeof value.dataEgressConsentId === 'string' && value.dataEgressConsentId.trim()
      ? { dataEgressConsentId: normalizeId(value.dataEgressConsentId, 'egress consent') }
      : {}),
    ...(imageGenerationCapability?.schemaVersion === 1
      && imageGenerationCapability.available === true
      && imageGenerationCapability.surface === 'images'
      && imageGenerationCapability.primaryProvider?.id === 'perchance-interactive'
      && imageGenerationCapability.primaryProvider.label === 'Perchance'
      && imageGenerationCapability.primaryProvider.mode === 'interactive'
      && imageGenerationCapability.primaryProvider.url === 'https://perchance.org/ai-text-to-image-generator'
      && imageGenerationCapability.emergencyProvider?.id === 'aihorde-anonymous'
      && imageGenerationCapability.emergencyProvider.label === 'AI Horde'
      && imageGenerationCapability.emergencyProvider.mode === 'emergency'
      && imageGenerationCapability.emergencyProvider.activation === 'provider-error-or-explicit-user-action'
      ? {
          imageGenerationCapability: {
            ...imageGenerationCapability,
            primaryProvider: { ...imageGenerationCapability.primaryProvider },
            emergencyProvider: { ...imageGenerationCapability.emergencyProvider },
          },
        }
      : {}),
    ...(computerUseCapability?.schemaVersion === 1
      && typeof computerUseCapability.available === 'boolean'
      && typeof computerUseCapability.enabled === 'boolean'
      && computerUseCapability.surface === 'computer-use'
      && computerUseCapability.invocation === '@Computer Use'
      && computerUseCapability.ownCursor === true
      && computerUseCapability.observeAnalyzeAct === true
      && computerUseCapability.emergencyShortcut === 'Ctrl+Alt+Escape'
      ? { computerUseCapability: { ...computerUseCapability } }
      : {}),
    ...(imageGeneration?.schemaVersion === 1
      && (imageGeneration.contentRating === 'safe' || imageGeneration.contentRating === 'nsfw')
      && imageGeneration.providerId === 'perchance-interactive'
      && validImageDisposition
      ? { imageGeneration: { ...imageGeneration } }
      : {}),
  };
}

function normalizeTurnExecutionProfile(
  value: AgentTaskExecutionProfile,
  source: OscarTurnSource,
): AgentTaskExecutionProfile {
  if (source !== 'coder'
    || value?.schemaVersion !== 'monarch.agent-execution-profile.v1'
    || value.kind !== 'coder-project'
    || typeof value.projectId !== 'string'
    || !value.projectId.trim()
    || typeof value.projectRoot !== 'string'
    || !/^[A-Za-z]:[\\/]/u.test(value.projectRoot)
    || !value.permissionProfile
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(value.permissionProfile.sandboxMode)
    || !['on-request', 'never'].includes(value.permissionProfile.approvalPolicy)
    || (value.permissionProfile.autonomyMode !== undefined
      && !['guided', 'workspace-autonomous', 'full-local'].includes(value.permissionProfile.autonomyMode))) {
    throw new OscarTurnCoordinatorError(400, 'invalid-execution-profile', 'Trusted Coder execution profile is invalid.');
  }
  return structuredClone(value);
}

function userMessage(turn: OscarTurnV1, attachments: OscarTurnAttachmentPayload[]): OscarPersistedMessage {
  return {
    conversationId: turn.conversationId,
    messageId: turn.inputMessageId,
    role: 'user',
    content: turn.request.text,
    turnId: turn.id,
    provenance: {
      schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
      origin: 'user',
      verification: 'user-assertion',
      turnId: turn.id,
    },
    ...(attachments.length ? {
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        digest: attachment.digest,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      })),
    } : {}),
  };
}

function continuationUserMessage(turn: OscarTurnV1, messageId: string, content: string): OscarPersistedMessage {
  return {
    conversationId: turn.conversationId,
    messageId,
    role: 'user',
    content,
    turnId: turn.id,
    ...(turn.taskId ? { taskId: turn.taskId } : {}),
    provenance: {
      schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
      origin: 'user',
      verification: 'user-assertion',
      turnId: turn.id,
      ...(turn.taskId ? { taskId: turn.taskId } : {}),
    },
  };
}

function terminalMessageId(turnId: string): string {
  return systemMessageId('terminal', turnId);
}

function systemMessageId(namespace: 'clarification' | 'terminal', bindingId: string): string {
  const digest = createHash('sha256')
    .update(`${namespace}\0${bindingId}`)
    .digest('hex')
    .slice(0, 32);
  // Python conversation resources accept at most 64 characters. Keep the
  // idempotency binding deterministic without copying variable-length ids.
  return `oscar_message_${namespace}_${digest}`;
}

function appendTurnContinuation(
  turn: OscarTurnV1,
  messageId: string,
  content: string,
  createdAt: string,
  status: OscarTurnStatus,
): OscarTurnV1 {
  return {
    ...turn,
    status,
    request: {
      ...turn.request,
      continuations: [
        ...(turn.request.continuations || []),
        { messageId, content, createdAt },
      ],
    },
  };
}

export function effectiveTurnRequest(turn: OscarTurnV1): string {
  const continuations = turn.request.continuations || [];
  if (continuations.length === 0) return turn.request.text;
  return [
    turn.request.text,
    ...continuations.map((entry, index) => `Уточнение пользователя ${index + 1}: ${entry.content}`),
  ].join('\n\n');
}

function messageOutbox(turn: OscarTurnV1, message: OscarPersistedMessage) {
  return {
    id: `outbox_message_${message.messageId}`,
    turnId: turn.id,
    kind: 'persist-message' as const,
    payload: {
      ...message,
      ...(turn.request.astra ? { contentMode: 'exact' } : {}),
      ...(turn.request.astra && message.role === 'assistant' ? { historyLinkMode: 'same-turn-user' } : {}),
      ...(message.role === 'assistant' ? { requiredPreviousMessageId: message.requiredPreviousMessageId ?? turn.inputMessageId } : {}),
      provenance: {
        ...message.provenance,
        surface: turn.source,
        privacyMode: turn.privacyMode,
      },
      source: turn.source,
      privacyMode: turn.privacyMode,
    } as unknown as Record<string, unknown>,
  };
}

function astraApprovalSecurityPresentation(value: unknown): {
  warningReason?: string;
  warningCodes?: string[];
  critical?: true;
  decisionReason?: MonarchPolicyReasonKind;
} {
  if (typeof value !== 'string' || value.length > 16_384) return {};
  try {
    const policy = JSON.parse(value) as Record<string, unknown>;
    if (policy.outcome !== 'confirm') return {};
    const evidence = Array.isArray(policy.evidence) ? policy.evidence : [];
    const warningCodes = Array.from(new Set(evidence
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
      .filter(entry => entry.source === 'security' && typeof entry.code === 'string')
      .map(entry => String(entry.code).slice(0, 160))))
      .slice(0, 16);
    const riskVector = policy.riskVector && typeof policy.riskVector === 'object' && !Array.isArray(policy.riskVector)
      ? policy.riskVector as Record<string, unknown>
      : {};
    const criticalCodes = new Set(['command.catastrophic', 'command.security-tamper', 'delete.large-scope']);
    const critical = warningCodes.some(code => criticalCodes.has(code))
      || riskVector.effect === 'delete'
      || riskVector.reversibility === 'irreversible'
      || riskVector.privilege === 'security-control';
    const decisionReason = policyReasonKind(evidence as Partial<MonarchPolicyEvidence>[]);
    // Only Security writes its explanation for people; other Kernel reasons are
    // internal rule text and are named through `decisionReason` instead.
    const warningReason = decisionReason === 'security' && typeof policy.reason === 'string' && policy.reason.trim()
      ? policy.reason.trim().slice(0, 2_000)
      : undefined;
    return {
      decisionReason,
      ...(warningReason ? { warningReason } : {}),
      ...(warningCodes.length ? { warningCodes } : {}),
      ...(critical ? { critical: true as const } : {}),
    };
  } catch {
    return {};
  }
}

function boundedProgressText(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function sourceReference(source: unknown, index: number): string {
  if (typeof source === 'string' && source.trim()) return source.trim().slice(0, 2_000);
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    for (const key of ['url', 'href', 'source', 'id']) {
      if (typeof record[key] === 'string' && record[key]) return String(record[key]).slice(0, 2_000);
    }
  }
  return `external-source:${index + 1}`;
}

export interface OscarResearchTraceStep { kind: 'plan' | 'search' | 'read' | 'verify' | 'write'; detail: string }

const RESEARCH_TRACE_KINDS: Readonly<Record<string, OscarResearchTraceStep['kind']>> = {
  search: 'search', 'search-plan': 'plan', 'research-plan': 'plan', 'research-read': 'read',
  'research-verify': 'verify', 'research-write': 'write',
};

/** The research steps of an answer Turn, from its progress events, in order. */
export function researchTraceSteps(events: readonly { type: string; payload?: unknown }[]): OscarResearchTraceStep[] {
  const steps: OscarResearchTraceStep[] = [];
  for (const event of events) {
    if (event.type !== 'agent.progress' || !event.payload || typeof event.payload !== 'object') continue;
    const payload = event.payload as Record<string, unknown>;
    const kind = RESEARCH_TRACE_KINDS[String(payload.phase || '')];
    const detail = boundedProgressText(payload.detail, 240);
    const last = steps[steps.length - 1];
    if (!kind || !detail || (last && last.kind === kind && last.detail === detail)) continue;
    steps.push({ kind, detail });
  }
  return steps.slice(-40);
}

interface OscarDisplaySource {
  /** The number the answer cites as [n], when the runtime assigned one. */
  id?: number;
  title: string; url: string; published?: string; savedAt?: string; origin?: 'engine' | 'wikipedia' | 'saved';
}

/** Title, link, date and origin of each source, for the source cards. The
 * provenance keeps only references; page titles are untrusted text shown
 * escaped and never read as instructions. */
function displaySources(sources: readonly unknown[]): OscarDisplaySource[] {
  const day = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(value) ? value.slice(0, 10) : '');
  return sources.slice(0, 32).flatMap((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
    const record = source as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url.slice(0, 2_000) : '';
    if (!/^(?:https?|memory):\/\//iu.test(url)) return [];
    const title = typeof record.title === 'string' ? record.title.replace(/\s+/gu, ' ').trim().slice(0, 300) : '';
    const origin = (['engine', 'wikipedia', 'saved'] as const).find((value) => value === record.origin);
    const published = day(record.published);
    const savedAt = day(record.savedAt) || day(record.saved_at);
    const id = Number.isSafeInteger(record.id) && (record.id as number) > 0 && (record.id as number) <= 99 ? record.id as number : undefined;
    return [{ ...(id ? { id } : {}), title, url, ...(published ? { published } : {}), ...(savedAt ? { savedAt } : {}), ...(origin ? { origin } : {}) }];
  });
}

function sourceSummary(source: unknown): string {
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    const reference = typeof record.url === 'string' ? record.url : '';
    const title = typeof record.title === 'string' ? record.title.trim().slice(0, 500) : '';
    if (reference.startsWith('memory://')) {
      return title || 'Из памяти · локальный Memory V4 context.';
    }
  }
  return 'External source supplied to the answer Turn.';
}

function turnHasDataEgressAuthorization(turn: OscarTurnV1): boolean {
  const modifiers = turn.request.modifiers;
  return Boolean(modifiers.dataEgressConsentId)
    && (modifiers.webSearch === true || modifiers.researchMode === 'deep');
}

function assertAnswerSourcesAllowed(sources: readonly unknown[], dataEgressAuthorized: boolean): void {
  if (dataEgressAuthorized) return;
  const unexpected = sources.some((source, index) => (
    !sourceReference(source, index).toLowerCase().startsWith('memory://')
  ));
  if (unexpected) {
    throw new Error('answer-runtime-returned-external-sources-without-data-egress-consent');
  }
}

function normalizeId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) {
    throw new OscarTurnCoordinatorError(400, 'invalid-id', `Invalid ${label} id.`);
  }
  return normalized;
}

function exactAstraRequestText(value: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8192
    || Buffer.from(value, 'utf8').toString('utf8') !== value)
    throw new OscarTurnCoordinatorError(400, 'astra-invalid-text', 'Astra requires bounded exact UTF-8 source text.');
  return value;
}

function normalizeText(value: string, maximum: number, label: string): string {
  const normalized = String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) throw new OscarTurnCoordinatorError(400, `empty-${label.replace(/\s+/g, '-')}`, `${label} is required.`);
  if (normalized.length > maximum) throw new OscarTurnCoordinatorError(413, `${label.replace(/\s+/g, '-')}-too-long`, `${label} is too long.`);
  return normalized;
}

function withoutResearchModifiers(turn: OscarTurnV1): OscarTurnV1 {
  const { webSearch: _webSearch, researchMode: _researchMode, dataEgressConsentId: _consent, ...modifiers } = turn.request.modifiers;
  return { ...turn, request: { ...turn.request, modifiers } };
}

function turnNeedsHostResearch(turn: OscarTurnV1): boolean {
  return turn.request.astra?.admission === 'ordinary-agent-v1'
    && (turn.request.modifiers.webSearch === true || turn.request.modifiers.researchMode === 'deep');
}

/** Keeps the lines of a message. Flattening every newline to a space turned a
 * pasted code block, a list or an earlier answer into one line before the
 * model ever saw it. */
function normalizeMultilineText(value: string, maximum: number, label: string): string {
  const normalized = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) throw new OscarTurnCoordinatorError(400, `empty-${label.replace(/\s+/g, '-')}`, `${label} is required.`);
  if (normalized.length > maximum) throw new OscarTurnCoordinatorError(413, `${label.replace(/\s+/g, '-')}-too-long`, `${label} is too long.`);
  return normalized;
}

function abortError(): Error {
  const error = new Error('Oscar Turn aborted.');
  error.name = 'AbortError';
  return error;
}

function isAstraActorMigrationMismatch(error: unknown): boolean {
  return error instanceof Error && error.message === 'astra-oscar-actor-changed';
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message));
}

/** The backend's exact typed conflict for a message whose required previous
 * user message is not stored. It is retryable in principle, which is why it is
 * abandoned only after the bounded window above, never on a single failure. */
function isOutboxPrerequisitePending(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && String((error as { code?: unknown }).code) === OUTBOX_PREREQUISITE_PENDING_CODE);
}

/** What the person sees while an agent task runs: the step in progress, in the
 * renderer's live-stage vocabulary (operation + subject). Derived from the
 * task view only; carries no authority and never claims an outcome. */
function astraLiveStep(view: AstraTaskHttpTask): Record<string, unknown> {
  if (!['running', 'queued', 'awaiting-progression', 'indeterminate', 'pausing'].includes(String(view.status))) return {};
  const activities = view.activities ?? [];
  const current = activities.at(-1)?.state === 'proposed' ? activities.at(-1) : undefined;
  const done = activities.filter(activity => activity.state !== 'proposed').length;
  // No real action yet — most turns are a plain answer. A step list with
  // invented "understood / picking tools" steps is noise; the ordinary
  // thinking line is enough until the agent actually does something.
  if (!current && !done) return { phase: 'thinking', label: 'Думаю', activity: { operation: 'think' } };
  // The whole visible plan so far, in plain words: what is done, what failed,
  // what is running now. A person should not need tool names to follow along.
  // Each step carries what the model told the person about it (`note`), and a
  // MAX model's visible reasoning (`thought`) for the newest steps only: every
  // projection is stored as a turn event, so older reasoning is not repeated.
  const recent = activities.slice(-8);
  const steps: Array<{ title: string; state: string; note?: string; thought?: string }> = recent.map((activity, index) => {
    const note = boundedProgressText(activity.reason, 320);
    // Reasoning keeps its paragraphs; only runs of blank lines collapse.
    const thought = index >= recent.length - 3 && typeof activity.thought === 'string'
      ? activity.thought.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200) : '';
    return {
      title: astraStepTitle(activity.capabilityId, activity.target, activity.state === 'proposed' ? 'active'
        : activity.state === 'failed' || activity.ok === false ? 'failed' : 'done'),
      state: activity.state === 'proposed' ? 'active' : activity.state === 'failed' || activity.ok === false ? 'failed' : 'done',
      ...(note ? { note } : {}), ...(thought ? { thought } : {}),
    };
  });
  if (!current) steps.push({ title: 'Думаю, что делать дальше', state: 'active' });
  const headline = steps.at(-1)!.title;
  if (current) {
    return { phase: 'tool', label: headline,
      activity: { operation: astraOperation(current.capabilityId), subject: headline, steps, stepNumber: done + 1 } };
  }
  return { phase: 'thinking', label: headline, activity: { operation: 'think', subject: headline, steps, stepNumber: done + 1 } };
}

export interface AstraTaskReportEntry {
  title: string;
  state: 'done' | 'approved' | 'rejected' | 'denied' | 'failed';
}

/** What the finished task did, in plain words: each executed step, what the
 * person approved or rejected, and what the rules refused. Built from the
 * task's own activities and the recorded approval decisions only. */
export function astraTaskReport(view: AstraTaskHttpTask, events: readonly { type: string; payload: Record<string, unknown> }[]): AstraTaskReportEntry[] {
  const report: AstraTaskReportEntry[] = [];
  for (const activity of view.activities ?? []) {
    if (activity.state === 'proposed') continue;
    const error = activity.state === 'failed' ? String(activity.summary || '') : '';
    const state: AstraTaskReportEntry['state'] = error === 'approval-rejected' || error === 'rejected-action-repeated' ? 'rejected'
      : /denied|red-zone|forbidden|blocked/u.test(error) ? 'denied'
        : activity.state === 'failed' || activity.ok === false ? 'failed' : 'done';
    report.push({ title: astraStepTitle(activity.capabilityId, activity.target, state === 'done' ? 'done' : 'failed'), state });
  }
  const decisions = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'agent.progress' && event.payload.runtime === 'astra-v3' && typeof event.payload.approvalId === 'string')
      decisions.set(event.payload.approvalId, String(event.payload.decision || ''));
  }
  const seen = new Set<string>();
  for (const event of events) {
    const payload = event.payload;
    if (event.type !== 'approval.required' || payload.runtime !== 'astra-v3' || typeof payload.id !== 'string' || seen.has(payload.id)) continue;
    seen.add(payload.id);
    const decision = decisions.get(payload.id);
    if (decision !== 'approve') continue;
    const capability = payload.capability && typeof payload.capability === 'object' ? payload.capability as Record<string, unknown> : {};
    const title = payload.approvalKind === 'computer-action' ? 'Действие с окном'
      : typeof capability.title === 'string' && capability.title ? capability.title
        : typeof payload.basename === 'string' ? `Создание файла «${payload.basename}»` : 'Действие';
    report.push({ title: `Ты разрешил: ${title}`.slice(0, 200), state: 'approved' });
  }
  return report.slice(0, 24);
}

/** A tool step as a person would describe it, present tense while it runs. */
export function astraStepTitle(capabilityId: string, target: string | undefined, state: 'active' | 'done' | 'failed'): string {
  const id = capabilityId.toLowerCase();
  // Services first: "memory.list" or "gmail.messages.list" is not a folder.
  const verbs: Array<[RegExp, string, string]> = [
    [/memory.*(?:write|remember|save|create|update|add)/, 'Записываю в память', 'Записал в память'],
    [/memory.*(?:delete|forget|remove)/, 'Удаляю из памяти', 'Удалил из памяти'],
    [/memory|recall/, 'Смотрю в памяти', 'Посмотрел в памяти'],
    [/gmail|mail/, 'Работаю с почтой', 'Поработал с почтой'],
    [/calendar/, 'Смотрю календарь', 'Посмотрел календарь'],
    [/telegram/, 'Работаю с Telegram', 'Поработал с Telegram'],
    [/github/, 'Работаю с GitHub', 'Поработал с GitHub'],
    [/web|internet|browse/, 'Ищу в интернете', 'Поискал в интернете'],
    [/delete|trash|remove/, 'Удаляю', 'Удалил'],
    [/move|rename/, 'Переименовываю', 'Переименовал'],
    [/copy/, 'Копирую', 'Скопировал'],
    [/mkdir|folder\.create|directory/, 'Создаю папку', 'Создал папку'],
    [/append/, 'Дописываю в файл', 'Дописал в файл'],
    [/write|create|save/, 'Записываю файл', 'Записал файл'],
    [/search|find|grep|query/, 'Ищу', 'Поискал'],
    [/read|inspect|content/, 'Читаю файл', 'Прочитал файл'],
    [/list|known-folder|resolve|stat/, 'Смотрю, что в папке', 'Посмотрел папку'],
    [/shell|exec|command|run/, 'Выполняю команду', 'Выполнил команду'],
  ];
  const match = verbs.find(([pattern]) => pattern.test(id));
  const verb = match ? (state === 'active' ? match[1] : match[2]) : (state === 'active' ? 'Выполняю действие' : 'Выполнил действие');
  const object = target ? ' ' + (/search|find|grep|query|web|internet/.test(id) ? `«${shortStepTarget(target, 60)}»` : shortStepTarget(target, 70)) : '';
  return state === 'failed' ? `Не получилось: ${verb.charAt(0).toLowerCase() + verb.slice(1)}${object}` : verb + object;
}

/** Long paths read better by their tail: `…/agent-v3/journal.ts`. */
function shortStepTarget(target: string, max: number): string {
  if (target.length <= max) return target;
  const parts = target.split(/[\\/]/u).filter(Boolean);
  const tail = parts.slice(-2).join('/');
  return tail.length + 2 <= max ? '…/' + tail : target.slice(0, max - 1) + '…';
}

function astraOperation(capabilityId: string): string {
  const id = capabilityId.toLowerCase();
  if (/delete|trash|remove/.test(id)) return 'delete';
  if (/move|rename/.test(id)) return 'move';
  if (/copy/.test(id)) return 'copy';
  if (/search|find|web|grep|query/.test(id)) return 'search';
  if (/write|create|mkdir|append|save|draft|send|edit/.test(id)) return 'write';
  if (/read|list|stat|get|inspect|resolve|status/.test(id)) return 'read';
  if (/shell|exec|run|command/.test(id)) return 'execute';
  return 'act';
}
