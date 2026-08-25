import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentApproval,
  AgentDecisionModelPolicy,
  AgentEvidenceReference,
  AgentObservation,
  AgentTaskCheckpoint,
  AgentTaskExecutionProfile,
  AgentTaskEvent,
  MonarchAgentRuntime,
} from '../agent';
import { redactAgentContextValue } from '../agent/context-compiler';
import { inferOperationalGoalKind } from '../agent/goal-normalizer';
import {
  operationalRequirementMatches,
  resolveAgentOperationalRequirements,
} from '../agent/operational-goal-binding';
import {
  knownFolderWriteOutputMatchesRequest,
  resolveKnownFolderRequestTarget,
  sameCanonicalFilesystemPath,
} from '../core/known-folder-target';
import { classifyOscarRequestDisposition } from '../core/intent-classifier';
import { ClaimIntegrityGate } from './claim-integrity';
import { hasRecoverableLegacyTerminalOutput } from './turn-store';
import { stripLeadingOscarSkillInvocation } from './skill-invocation';
import {
  classifyOscarServerDisposition,
  extractExplicitMemoryText,
  isNonAuthoritativeConfirmationText,
  type OscarStructuredDispositionProvider,
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
  | { type: 'done'; usage?: Record<string, unknown>; cancelled?: boolean; ok?: boolean; failure?: string }
  | { type: 'error'; message: string };

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
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  turnId: string;
  taskId?: string;
  provenance: MessageProvenanceV1;
  outcome?: OscarTurnOutcomeKind;
  integrityWarning?: string;
  sources?: unknown[];
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
  clientRequestId: string;
  conversationId: string;
  text: string;
  privacyMode: OscarPrivacyMode;
  source: OscarTurnSource;
  inputMessageId?: string;
  attachmentIds?: string[];
  modifiers?: OscarTurnModifiers;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  replyToTurnId?: string;
  supersedesTurnId?: string;
  retryOf?: string;
  /** Internal-only trusted profile supplied by the local Coder surface. */
  executionProfile?: AgentTaskExecutionProfile;
}

export interface OscarTurnCoordinatorOptions {
  persistentStore: OscarTurnStore;
  volatileStore: OscarTurnStore;
  agentRuntime: MonarchAgentRuntime | null;
  /** Dedicated session-only Agent runtime backed by an in-memory task store. */
  incognitoAgentRuntime?: MonarchAgentRuntime | null;
  answerExecutor: (input: OscarAnswerExecutionInput) => Promise<AsyncIterable<OscarAnswerExecutorEvent>>;
  answerFallback?: (input: OscarAnswerExecutionInput) => Promise<OscarAnswerFallbackResult>;
  persistMessage: (message: OscarPersistedMessage) => Promise<void | OscarMessagePersistenceReceipt>;
  resolveAttachments?: (
    ids: string[],
    privacyMode: OscarPrivacyMode,
    source: OscarTurnSource,
    conversationId: string,
  ) => Promise<OscarTurnAttachmentPayload[]>;
  consumeDataEgressConsent?: (consentId: string, turn: OscarTurnV1) => Promise<void>;
  rememberMemory?: (input: { turn: OscarTurnV1; text: string }) => Promise<OscarMemoryWriteResult>;
  resolvePersonality?: (input: {
    conversationId: string;
    source: OscarTurnSource;
    privacyMode: OscarPrivacyMode;
  }) => Promise<OscarTurnV1['request']['personality'] | null>;
  dispositionProvider?: OscarStructuredDispositionProvider;
  /** @deprecated Turns are now routed adaptively; kept for persisted callers. */
  agentFirst?: boolean;
  claimIntegrityGate?: ClaimIntegrityGate;
  now?: () => Date;
}

const TERMINAL_TURN_STATUSES = new Set<OscarTurnStatus>([
  'succeeded', 'blocked', 'failed', 'cancelled',
]);
const CLIENT_CANCELLATION_TTL_MS = 5 * 60_000;
export const OSCAR_TURN_CANCELLED_SUMMARY = 'Задача остановлена. Новые действия и повторные шаги не будут запущены.';

function outboxDispatchPriority(kind: OscarTurnOutboxItem['kind']): number {
  // Agent creation is local and must not wait for the compatibility backend
  // to persist a chat message. Message ordering remains protected by the
  // assistant item's requiredPreviousMessageId receipt.
  if (kind === 'create-agent-task') return 0;
  if (kind === 'send-agent-message' || kind === 'reconcile-turn') return 1;
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
  private readonly clientCancellationIntents = new Map<string, number>();
  private readonly taskToTurn = new Map<string, string>();
  private readonly turnPrivacy = new Map<string, OscarPrivacyMode>();
  private readonly taskReconciliations = new Set<Promise<void>>();
  private taskUnsubscribes: Array<() => void> = [];
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private outboxDrain: Promise<void> | null = null;
  private started = false;

  constructor(options: OscarTurnCoordinatorOptions) {
    this.options = options;
    this.persistentStore = options.persistentStore;
    this.volatileStore = options.volatileStore;
    this.gate = options.claimIntegrityGate || new ClaimIntegrityGate();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const runtimes = [...new Set([
      this.options.agentRuntime,
      this.options.incognitoAgentRuntime || null,
    ].filter((runtime): runtime is MonarchAgentRuntime => Boolean(runtime)))];
    for (const runtime of runtimes) {
      this.taskUnsubscribes.push(runtime.subscribe('*', (commit) => {
        const turnId = this.taskToTurn.get(commit.task.id);
        if (turnId) this.trackTaskReconciliation(this.reconcileAgentTask(turnId, commit.checkpoint));
      }));
    }
    await this.reconcileStartup();
    await this.drainOutbox();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.taskUnsubscribes.forEach((unsubscribe) => unsubscribe());
    this.taskUnsubscribes = [];
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    await this.outboxDrain?.catch(() => undefined);
    await Promise.allSettled([...this.taskReconciliations]);
    for (const controller of this.answerControllers.values()) controller.abort('shutdown');
    this.answerControllers.clear();
    for (const turn of await this.volatileStore.listTurns()) {
      const runtime = this.agentRuntimeForTurn(turn);
      if (turn.taskId && runtime) {
        await runtime.discardTask(turn.taskId).catch(() => false);
        this.taskToTurn.delete(turn.taskId);
      }
      this.turnPrivacy.delete(turn.id);
      await this.volatileStore.deleteTurn(turn.id);
    }
  }

  private trackTaskReconciliation(task: Promise<void>): void {
    const settled = task.catch(() => undefined);
    this.taskReconciliations.add(settled);
    void settled.then(() => this.taskReconciliations.delete(settled));
  }

  async submit(input: SubmitOscarTurnInput): Promise<OscarTurnCheckpoint> {
    const normalized = normalizeSubmission(input);
    if (normalized.replyToTurnId) {
      const target = await this.requireTurn(normalized.replyToTurnId);
      const independentOperation = target.turn.status === 'waiting-for-user'
        && target.turn.source === normalized.source
        && target.turn.conversationId === normalized.conversationId
        && target.turn.privacyMode === normalized.privacyMode
        && (await classifyOscarServerDisposition(
          normalized.text,
          this.options.dispositionProvider,
          { history: normalized.history },
        )).lane === 'agent';
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
    if (normalized.privacyMode === 'persistent' && normalized.source === 'desktop') {
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
        ...(normalized.executionProfile ? { executionProfile: normalized.executionProfile } : {}),
      },
      inputMessageId: normalized.inputMessageId,
      ...(normalized.supersedesTurnId ? { supersedesTurnId: normalized.supersedesTurnId } : {}),
      ...(normalized.retryOf ? { retryOf: normalized.retryOf } : {}),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
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
    const cancellationKey = this.clientCancellationKey(
      created.turn.clientRequestId,
      created.turn.source,
      created.turn.privacyMode,
    );
    const requestedCancellation = await this.cancelForClientIntent(created.turn, cancellationKey);
    if (requestedCancellation) return requestedCancellation;
    if (created.replayed && !['accepted', 'routing'].includes(created.turn.status)) return created;
    return this.routeAcceptedTurn(created.turn.id);
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
      const runtime = this.agentRuntimeForTurn(turn);
      if (turn.taskId && runtime) {
        await runtime.discardTask(turn.taskId).catch(() => false);
        this.taskToTurn.delete(turn.taskId);
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

  async cancelByClientRequestId(input: {
    clientRequestId: string;
    source: OscarTurnSource;
    privacyMode: OscarPrivacyMode;
  }): Promise<OscarClientRequestCancellation> {
    const clientRequestId = normalizeId(input.clientRequestId, 'client request');
    const cancellationKey = this.clientCancellationKey(clientRequestId, input.source, input.privacyMode);
    const expiresAt = Date.now() + CLIENT_CANCELLATION_TTL_MS;
    await this.storeForPrivacy(input.privacyMode).reserveClientCancellation({
      clientRequestId,
      source: input.source,
      privacyMode: input.privacyMode,
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
      void this.drainOutbox();
      return refocused;
    }
    if (checkpoint.turn.status !== 'waiting-for-user') {
      throw new OscarTurnCoordinatorError(409, 'turn-not-waiting-for-user', 'Only an exact waiting-for-user Turn can accept a message.');
    }
    if (checkpoint.turn.taskId) {
      const runtime = this.agentRuntimeForTurn(checkpoint.turn);
      if (!runtime) {
        throw new OscarTurnCoordinatorError(503, 'agent-runtime-unavailable', 'Agent Runtime is unavailable.');
      }
      const updated = await this.updateTurn(store, turnId, (current) => ({
        turn: appendTurnContinuation(current, messageId, content, this.nowIso(), 'running'),
        events: [{ type: 'turn.routed', payload: { disposition: 'agent-continuation', messageId } }],
        outbox: [
          ...(current.privacyMode === 'persistent' ? [messageOutbox(current, persisted)] : []),
          {
            id: `outbox_agent_message_${messageId}`,
            turnId: current.id,
            kind: 'send-agent-message' as const,
            payload: { taskId: current.taskId, content, messageId },
          },
        ],
      }));
      void this.drainOutbox();
      return updated;
    }

    const clarified = await this.updateTurn(store, turnId, (current) => ({
      turn: appendTurnContinuation(current, messageId, content, this.nowIso(), 'routing'),
      events: [{ type: 'turn.routed', payload: { disposition: 'clarification-received', messageId } }],
      outbox: current.privacyMode === 'persistent' ? [messageOutbox(current, persisted)] : [],
    }));
    void this.drainOutbox();
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

  private async cancelTurnOnce(checkpoint: OscarTurnCheckpoint): Promise<OscarTurnCheckpoint> {
    const turnId = checkpoint.turn.id;
    this.answerControllers.get(turnId)?.abort('user-cancelled');
    const runtime = this.agentRuntimeForTurn(checkpoint.turn);
    if (checkpoint.turn.taskId && runtime) {
      await runtime.cancel(checkpoint.turn.taskId);
    }
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
  ): string {
    return `${privacyMode}:${source}:${clientRequestId}`;
  }

  private hasClientCancellationIntent(key: string): boolean {
    this.purgeExpiredClientCancellationIntents();
    return this.clientCancellationIntents.has(key);
  }

  private async cancelForClientIntent(
    turn: OscarTurnV1,
    key = this.clientCancellationKey(turn.clientRequestId, turn.source, turn.privacyMode),
    includeDurable = true,
  ): Promise<OscarTurnCheckpoint | null> {
    const reservation = {
      clientRequestId: turn.clientRequestId,
      source: turn.source,
      privacyMode: turn.privacyMode,
    };
    const requested = this.hasClientCancellationIntent(key)
      || (includeDurable && await this.storeForTurn(turn).hasClientCancellation(reservation));
    if (!requested) return null;
    const cancelled = await this.cancel(turn.id, turn.source);
    if (TERMINAL_TURN_STATUSES.has(cancelled.turn.status)) {
      await this.clearClientCancellationIntent(cancelled.turn, key);
    }
    return cancelled;
  }

  private async clearClientCancellationIntent(turn: OscarTurnV1, key: string): Promise<void> {
    this.clientCancellationIntents.delete(key);
    await this.storeForTurn(turn).clearClientCancellation({
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
      void this.drainOutbox();
      return blocked;
    }

    const modifiers = checkpoint.turn.request.modifiers;
    const egressRequested = modifiers.webSearch === true || modifiers.researchMode === 'deep';
    const explicitMemoryText = extractExplicitMemoryText(requestText);
    const trustedCoderTask = checkpoint.turn.source === 'coder'
      && checkpoint.turn.request.executionProfile?.schemaVersion === 'monarch.agent-execution-profile.v1'
      && checkpoint.turn.request.executionProfile.kind === 'coder-project';
    const disposition = trustedCoderTask
      ? {
          lane: 'agent' as const,
          kind: 'coder_task',
          confidence: 1,
          reason: 'A validated Coder project Turn always uses the common Agent Runtime.',
          requiresExternalResearch: false,
        }
      : explicitMemoryText
        ? {
          lane: 'memory' as const,
          kind: 'memory_remember',
          confidence: 1,
          reason: 'Exact typed Desktop memory command stays runtime-owned.',
          requiresExternalResearch: false,
          }
        : await classifyOscarServerDisposition(requestText, this.options.dispositionProvider, {
            externalResearch: egressRequested,
            history: checkpoint.turn.request.history,
          });
    checkpoint = await this.requireTurn(turnId);
    if (checkpoint.turn.status !== 'routing') return checkpoint;
    const requestedCancellation = await this.cancelForClientIntent(checkpoint.turn, undefined, false);
    if (requestedCancellation) return requestedCancellation;
    if (disposition.lane === 'memory') {
      return this.runMemoryWrite(checkpoint, explicitMemoryText);
    }
    if (disposition.requiresExternalResearch === true && !egressRequested) {
      const blocked = await this.finishTurn(store, turnId, {
        status: 'blocked',
        kind: 'blocked',
        summary: 'Для этого запроса нужны актуальные публичные источники. Разреши Web-поиск через data-egress action-card; локальная модель не будет имитировать доступ к интернету.',
        events: [{ type: 'turn.routed', payload: { disposition: 'answer', blockedBy: 'external-research-consent-required' } }],
      });
      void this.drainOutbox();
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
        void this.drainOutbox();
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
        void this.drainOutbox();
        return blocked;
      }
    } else if (modifiers.dataEgressConsentId) {
      const blocked = await this.finishTurn(store, turnId, {
        status: 'blocked',
        kind: 'blocked',
        summary: 'Data-egress consent нельзя переносить на Turn без web/research запроса.',
        events: [{ type: 'turn.routed', payload: { disposition: 'answer', blockedBy: 'unexpected-data-egress-consent' } }],
      });
      void this.drainOutbox();
      return blocked;
    }

    if (disposition.lane === 'agent' && checkpoint.turn.privacyMode === 'encrypted') {
      const blocked = await this.finishTurn(store, turnId, {
        status: 'blocked',
        kind: 'blocked',
        summary: 'Зашифрованный Safe-чат работает только в answer-only режиме. Операционная задача не создавалась.',
        events: [{ type: 'turn.routed', payload: { disposition: 'agent', blockedBy: 'private-mode' } }],
      });
      void this.drainOutbox();
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
      void this.drainOutbox();
      return waiting;
    }
    if (disposition.lane === 'agent') {
      if (!this.agentRuntimeForTurn(checkpoint.turn)) {
        const blocked = await this.finishTurn(store, turnId, {
          status: 'blocked',
          kind: 'blocked',
          summary: 'Agent Runtime недоступен. Операционный запрос не был отправлен в обычный чат.',
          events: [{ type: 'turn.routed', payload: { disposition: 'agent', blockedBy: 'agent-runtime-unavailable' } }],
        });
        void this.drainOutbox();
        return blocked;
      }
      const routed = await this.updateTurn(store, turnId, (current) => ({
        turn: { ...current, mode: 'agent', status: 'running' },
        events: [{ type: 'turn.routed', payload: { disposition: 'agent', kind: disposition.kind, reason: disposition.reason } }],
        outbox: [{
          id: `outbox_create_task_${current.id}`,
          turnId: current.id,
          kind: 'create-agent-task' as const,
          payload: { kind: disposition.kind },
        }],
      }));
      void this.drainOutbox();
      return routed;
    }

    const routed = await this.updateTurn(store, turnId, (current) => ({
      turn: { ...current, mode: 'answer', status: 'answering' },
      events: [{ type: 'turn.routed', payload: { disposition: 'answer', kind: disposition.kind, reason: disposition.reason } }],
    }));
    void this.runAnswer(turnId);
    void this.drainOutbox();
    return routed;
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
    const integrityContext = { executionAuthority: 'none' as const, evidence: [] };
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
        const query = boundedProgressText(effectiveTurnRequest(checkpoint.turn), 160);
        await this.appendAnswerEvents(turnId, [{
          type: 'agent.progress',
          payload: {
            phase: 'search',
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
      try {
        const stream = await this.options.answerExecutor({
          turn: checkpoint.turn,
          attachments,
          signal: controller.signal,
        });
        for await (const event of stream) {
          if (controller.signal.aborted) throw abortError();
          if (event.type === 'token') {
            rawAnswer += event.token;
            const deltas = await integritySession.append(event.token);
            await this.appendAnswerEvents(turnId, deltas.map((content) => ({
              type: 'answer.delta' as const,
              payload: { content },
            })));
          }
          else if (event.type === 'replace') replacement = event.content;
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
      } catch (error) {
        if (isAbort(error) || controller.signal.aborted) throw error;
        streamFailure = error;
      }
      if (!terminalSeen) {
        if (!this.options.answerFallback) {
          throw streamFailure || new Error('Oscar answer runtime ended before a terminal event.');
        }
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
      await this.finishTurn(store, turnId, {
        status: 'succeeded',
        kind,
        summary: integrity.visibleText,
        evidenceRefs,
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
          ...(usage ? { usage } : {}),
        })] : [],
      });
      void this.drainOutbox();
    } catch (error) {
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
    void this.drainOutbox();
  }

  private async ensureAgentTask(turnId: string, _routedKindInput?: string): Promise<void> {
    const current = await this.requireTurn(turnId);
    const runtime = this.agentRuntimeForTurn(current.turn);
    if (!runtime) throw new Error('Agent Runtime unavailable.');
    if (current.turn.taskId) {
      this.taskToTurn.set(current.turn.taskId, turnId);
      const checkpoint = await runtime.getTask(current.turn.taskId);
      if (checkpoint) await this.reconcileAgentTask(turnId, checkpoint);
      return;
    }
    const originalRequestText = effectiveTurnRequest(current.turn);
    const requestText = stripLeadingOscarSkillInvocation(originalRequestText);
    let initialObservations: NonNullable<Parameters<MonarchAgentRuntime['createTask']>[0]['initialObservations']> = [];
    if (current.turn.request.attachmentIds.length > 0) {
      const attachments = await this.options.resolveAttachments?.(
        current.turn.request.attachmentIds,
        current.turn.privacyMode,
        current.turn.source,
        current.turn.conversationId,
      ) || [];
      if (attachments.length !== current.turn.request.attachmentIds.length) {
        await this.finishTurn(this.storeForTurn(current.turn), turnId, {
          status: 'blocked',
          kind: 'blocked',
          summary: 'Операционная задача не запущена: immutable attachment refs не удалось полностью проверить.',
          warning: 'attachment-resolution-incomplete',
          events: [{ type: 'turn.routed', payload: { disposition: 'agent', blockedBy: 'attachment-resolution-incomplete' } }],
        });
        return;
      }
      try {
        const observation = await this.observeAgentAttachments(current.turn, attachments);
        initialObservations = [observation];
      } catch (error) {
        await this.finishTurn(this.storeForTurn(current.turn), turnId, {
          status: 'blocked',
          kind: 'blocked',
          summary: 'Операционная задача с вложением не запущена: answer-only vision runtime не вернул завершённое наблюдение.',
          warning: error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'attachment-observation-unavailable',
          events: [{ type: 'turn.routed', payload: { disposition: 'agent', blockedBy: 'attachment-observation-unavailable' } }],
        });
        return;
      }
    }
    const audit = /(?:аудит|скан).{0,48}(?:папк|каталог|директор|диск)|(?:audit|scan).{0,48}(?:folder|director|drive)/iu.test(requestText);
    const goalContract = agentTurnGoalContract(requestText, audit);
    const decisionModelPolicy = agentDecisionModelPolicy(current.turn.request.modifiers.requestedModel);
    const created = await runtime.createTask({
      request: requestText,
      source: {
        surface: current.turn.source,
        remote: current.turn.source === 'telegram' || current.turn.source === 'api',
        requestId: current.turn.clientRequestId,
        conversationId: current.turn.conversationId,
      },
      conversationId: current.turn.conversationId,
      clientRequestId: `oscar_turn_task_${turnId}`,
      planningMode: 'adaptive',
      ...(decisionModelPolicy ? { decisionModelPolicy } : {}),
      ...(current.turn.request.executionProfile
        ? { executionProfile: current.turn.request.executionProfile }
        : {}),
      ...(initialObservations.length ? {
        actionApprovalPolicy: 'all-effects' as const,
        initialObservations,
      } : {}),
      expectedOutputs: [goalContract.expectedOutput],
      successCriteria: [goalContract.successCriterion],
      budgets: {
        maxSteps: 160,
        maxModelTurns: 24,
        maxToolCalls: 128,
        maxWallTimeMs: 10 * 60 * 1000,
        maxFailures: 8,
        maxConsecutiveNoProgress: 4,
        maxComputeClass: 'heavy',
      },
    });
    this.taskToTurn.set(created.task.id, turnId);
    try {
      await this.updateTurn(this.storeForTurn(current.turn), turnId, (turn) => ({
        turn: { ...turn, taskId: created.task.id },
        events: [{ type: 'task.linked', payload: { taskId: created.task.id } }],
      }));
    } catch (error) {
      this.taskToTurn.delete(created.task.id);
      if (current.turn.privacyMode === 'incognito') {
        await runtime.discardTask(created.task.id).catch(() => false);
      }
      throw error;
    }
    // createTask may schedule and checkpoint the runner before taskToTurn is
    // installed. Re-read after linking so a fast waiting/terminal transition
    // cannot be lost between the Agent Store and Turn Store subscriptions.
    const latest = await runtime.getTask(created.task.id) || created;
    await this.reconcileAgentTask(turnId, latest);
  }

  private async observeAgentAttachments(
    turn: OscarTurnV1,
    attachments: OscarTurnAttachmentPayload[],
  ): Promise<NonNullable<Parameters<MonarchAgentRuntime['createTask']>[0]['initialObservations']>[number]> {
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
    const attachmentRefs = attachments.map((attachment) => ({
      id: attachment.id,
      digest: attachment.digest,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    }));
    return {
      capabilityId: 'models.vision.observe',
      summary,
      structuredData: {
        trust: 'untrusted-model-generated',
        instructionsAllowed: false,
        attachmentRefs,
      },
      evidence: attachments.map((attachment) => ({
        kind: 'file' as const,
        evidenceClass: 'model-generated' as const,
        reference: `oscar-attachment:${attachment.id}`,
        summary: `Vision interpretation of immutable ${attachment.mimeType} attachment; not Kernel evidence.`,
        checksum: attachment.digest,
      })),
      warnings: ['Attachment interpretation is model-generated and cannot prove a local fact or authorize an effect.'],
    };
  }

  private async reconcileAgentTask(turnId: string, checkpointInput?: AgentTaskCheckpoint): Promise<void> {
    const turnCheckpoint = await this.getTurn(turnId);
    if (!turnCheckpoint || TERMINAL_TURN_STATUSES.has(turnCheckpoint.turn.status)) return;
    const runtime = this.agentRuntimeForTurn(turnCheckpoint.turn);
    if (!runtime) return;
    const taskId = turnCheckpoint.turn.taskId;
    if (!taskId) return;
    const checkpoint = checkpointInput || await runtime.getTask(taskId);
    if (!checkpoint) return;
    await this.mirrorAgentProgress(turnId, checkpoint);
    const store = this.storeForTurn(turnCheckpoint.turn);
    if (checkpoint.task.status === 'waiting-for-approval') {
      const approval = activeApproval(checkpoint);
      if (!approval) return this.failTurn(turnId, new Error('Agent task is waiting for an approval that is not durably bound.'));
      await this.updateTurn(store, turnId, (turn) => ({
        turn: {
          ...turn,
          status: 'waiting-for-approval',
          activeApprovalId: approval.id,
        },
        events: approvalEvent(checkpoint, approval),
      }));
      return;
    }
    if (checkpoint.task.status === 'waiting-for-user') {
      const clarification = [...checkpoint.task.messages].reverse().find((message) => message.kind === 'clarification');
      const question = clarification?.content || 'Нужно уточнение для продолжения задачи.';
      const messageId = systemMessageId('clarification', clarification?.id || taskId);
      await this.updateTurn(store, turnId, (turn) => ({
        ...(turn.status === 'waiting-for-user' && turn.outputMessageId === messageId
          ? { turn, events: [] }
          : {
              turn: { ...turn, status: 'waiting-for-user' as const, outputMessageId: messageId },
              events: [{ type: 'user.input.required' as const, payload: { question, taskId } }],
              outbox: turn.privacyMode === 'persistent' ? [messageOutbox(turn, {
                conversationId: turn.conversationId,
                messageId,
                role: 'assistant',
                content: question,
                turnId,
                taskId,
                provenance: {
                  schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
                  origin: 'system',
                  verification: 'system-state',
                  turnId,
                  taskId,
                },
              })] : [],
            }),
      }));
      return;
    }
    if (checkpoint.task.status === 'failed') {
      await this.failTurn(turnId, new Error(checkpoint.task.terminalReason?.summary || 'Agent Task failed.'));
      return;
    }
    if (checkpoint.task.status === 'cancelled') {
      await this.finishTurn(store, turnId, {
        status: 'cancelled',
        kind: 'cancelled',
        summary: OSCAR_TURN_CANCELLED_SUMMARY,
        events: [],
      });
      return;
    }
    if (checkpoint.task.status !== 'completed') {
      if (turnCheckpoint.turn.status !== 'running') {
        await this.updateTurn(store, turnId, (turn) => ({ turn: { ...turn, status: 'running' }, events: [] }));
      }
      return;
    }
    if (completedTaskHasUnfinishedPlanWork(checkpoint)) {
      await this.failTurn(turnId, new Error('Agent Task completed while required plan steps remained unfinished.'));
      return;
    }
    if (!completedTaskHasRequiredEffectEvidence(checkpoint)) {
      await this.failTurn(turnId, new Error('Agent Task completed without the required verified operational effect.'));
      return;
    }
    const usableObservations = checkpoint.observations.filter((observation) => (
      observation.status === 'success' || observation.status === 'partial'
    ));
    const modelEvidence = usableObservations
      .filter((observation) => (
        observation.capabilityId === 'models.agent.respond'
        || observation.capabilityId === 'models.agent.synthesize'
      ))
      .flatMap((observation) => observation.evidence)
      .filter((entry) => entry.evidenceClass === 'model-generated');
    const kernelEvidence = usableObservations.flatMap((observation) => observation.evidence).filter((entry) => (
      (entry.evidenceClass === 'kernel-observation' || entry.evidenceClass === 'kernel-verification')
      && !/^Verification failed:/iu.test(String(entry.summary || ''))
    ));
    if (kernelEvidence.length === 0 && modelEvidence.length > 0) {
      await this.finishModelGeneratedAgentAnswer(turnCheckpoint, checkpoint, modelEvidence);
      return;
    }
    if (kernelEvidence.length === 0 || !hasVerifiedAgentCompletionRecord(checkpoint)) {
      await this.failTurn(turnId, new Error('Agent Task completed without a Kernel verifier record.'));
      return;
    }
    const partial = usableObservations.some((observation) => observation.status === 'partial')
      || usableObservations.some((observation) => mutationObservationIsNotFullyVerified(observation));
    const kind: OscarTurnOutcomeKind = partial ? 'partial' : 'verified';
    const synthesized = groundedAgentSynthesis(checkpoint);
    let summary = synthesized?.text || deterministicAgentSummary(checkpoint, kind);
    if (synthesized) {
      const integrity = await this.gate.inspectCompleteAnswer(summary, {
        executionAuthority: 'kernel',
        evidence: kernelEvidence,
      });
      if (!integrity.allowed) {
        await this.finishAnswerIntegrityBlock(turnId, integrity.replacement, integrity.reasons);
        return;
      }
      summary = integrity.visibleText;
    }
    const messageId = `oscar_message_${randomUUID().replace(/-/g, '')}`;
    const provenance: MessageProvenanceV1 = {
      schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
      origin: synthesized ? 'model' : 'kernel',
      verification: partial ? 'kernel-partial' : 'kernel-verified',
      turnId,
      taskId,
      evidenceRefs: kernelEvidence,
    };
    await this.finishTurn(store, turnId, {
      status: 'succeeded',
      kind,
      summary,
      evidenceRefs: kernelEvidence,
      taskId,
      outputMessageId: messageId,
      events: sentenceDeltas(summary),
      outbox: turnCheckpoint.turn.privacyMode === 'persistent' ? [messageOutbox(turnCheckpoint.turn, {
        conversationId: turnCheckpoint.turn.conversationId,
        messageId,
        role: 'assistant',
        content: summary,
        turnId,
        taskId,
        provenance,
        outcome: kind,
      })] : [],
    });
    void this.drainOutbox();
  }

  private async finishModelGeneratedAgentAnswer(
    turnCheckpoint: OscarTurnCheckpoint,
    checkpoint: AgentTaskCheckpoint,
    evidenceRefs: AgentEvidenceReference[],
  ): Promise<void> {
    const rawSummary = checkpoint.task.terminalReason?.summary
      || [...checkpoint.observations].reverse().find((entry) => entry.capabilityId === 'models.agent.respond')?.summary
      || [...checkpoint.observations].reverse().find((entry) => entry.capabilityId === 'models.agent.synthesize')?.summary
      || 'Модель сформировала ответ без Kernel-действия.';
    const integrity = await this.gate.inspectCompleteAnswer(rawSummary, {
      executionAuthority: 'none',
      evidence: evidenceRefs,
    });
    if (!integrity.allowed) {
      await this.finishAnswerIntegrityBlock(turnCheckpoint.turn.id, integrity.replacement, integrity.reasons);
      return;
    }
    const messageId = `oscar_message_${randomUUID().replace(/-/g, '')}`;
    const provenance: MessageProvenanceV1 = {
      schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
      origin: 'model',
      verification: 'unverified-model',
      turnId: turnCheckpoint.turn.id,
      taskId: checkpoint.task.id,
      evidenceRefs,
    };
    await this.finishTurn(this.storeForTurn(turnCheckpoint.turn), turnCheckpoint.turn.id, {
      status: 'succeeded',
      kind: 'answered',
      summary: integrity.visibleText,
      evidenceRefs,
      taskId: checkpoint.task.id,
      outputMessageId: messageId,
      events: sentenceDeltas(integrity.visibleText),
      outbox: turnCheckpoint.turn.privacyMode === 'persistent' ? [messageOutbox(turnCheckpoint.turn, {
        conversationId: turnCheckpoint.turn.conversationId,
        messageId,
        role: 'assistant',
        content: integrity.visibleText,
        turnId: turnCheckpoint.turn.id,
        taskId: checkpoint.task.id,
        provenance,
        outcome: 'answered',
      })] : [],
    });
    void this.drainOutbox();
  }

  private async reconcileStartup(): Promise<void> {
    for (const turn of await this.persistentStore.listTurns()) {
      this.turnPrivacy.set(turn.id, turn.privacyMode);
      if (TERMINAL_TURN_STATUSES.has(turn.status)) {
        await this.reconcileTerminalMessage(turn).catch(() => undefined);
      } else if (turn.status === 'accepted' || turn.status === 'routing') {
        const cancelled = await this.cancelForClientIntent(turn).catch(() => null);
        if (!cancelled) await this.routeAcceptedTurn(turn.id).catch(() => undefined);
      } else if (turn.taskId) {
        this.taskToTurn.set(turn.taskId, turn.id);
        await this.reconcileAgentTask(turn.id).catch(() => undefined);
      } else if (turn.mode === 'agent' && !TERMINAL_TURN_STATUSES.has(turn.status)) {
        await this.ensureAgentTask(turn.id).catch(() => undefined);
      } else if (turn.mode === 'answer' && turn.status === 'answering') {
        void this.runAnswer(turn.id);
      }
    }
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
        try {
          if (item.kind === 'persist-message') {
            const message = item.payload as unknown as OscarPersistedMessage;
            const receipt = await this.options.persistMessage(message);
            if (receipt?.disposition === 'superseded') {
              if (message.role !== 'assistant' || !message.requiredPreviousMessageId) {
                throw new Error('Only a prerequisite-bound assistant message may be superseded.');
              }
              await store.markOutboxSuperseded(item.id);
              continue;
            }
          } else if (item.kind === 'create-agent-task') {
            await this.ensureAgentTask(
              item.turnId,
              typeof item.payload.kind === 'string' ? item.payload.kind : undefined,
            );
          } else if (item.kind === 'send-agent-message') {
            const turnCheckpoint = await store.getTurn(item.turnId);
            const runtime = turnCheckpoint ? this.agentRuntimeForTurn(turnCheckpoint.turn) : null;
            if (!runtime) throw new Error('Agent Runtime unavailable for Turn continuation.');
            const taskId = normalizeId(String(item.payload.taskId || ''), 'task');
            const content = normalizeText(String(item.payload.content || ''), 16_000, 'message');
            const messageId = normalizeId(String(item.payload.messageId || ''), 'message');
            await runtime.sendMessage(taskId, { content, messageId });
          } else if (item.kind === 'reconcile-turn') {
            const checkpoint = await store.getTurn(item.turnId);
            if (checkpoint?.turn.taskId) await this.reconcileAgentTask(item.turnId);
          }
          await store.markOutboxSucceeded(item.id);
        } catch (error) {
          const attempts = item.attempts + 1;
          const delayMs = Math.min(60_000, 250 * (2 ** Math.min(attempts, 8)));
          await store.markOutboxFailed(
            item.id,
            error instanceof Error ? error.message : String(error),
            new Date(Date.now() + delayMs).toISOString(),
          );
        }
      }
    }
  }

  private scheduleOutbox(): void {
    if (!this.started || this.outboxTimer) return;
    this.outboxTimer = setTimeout(() => {
      this.outboxTimer = null;
      void this.drainOutbox();
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
    const runtime = this.agentRuntimeForTurn(turn);
    if (!turn.taskId || !runtime) return [];
    const checkpoint = await runtime.getTask(turn.taskId);
    const approval = checkpoint ? activeApproval(checkpoint) : null;
    return checkpoint && approval ? approvalEvent(checkpoint, approval) : [];
  }

  private async mirrorAgentProgress(turnId: string, checkpoint: AgentTaskCheckpoint): Promise<void> {
    const turnCheckpoint = await this.getTurn(turnId);
    if (!turnCheckpoint || TERMINAL_TURN_STATUSES.has(turnCheckpoint.turn.status)) return;
    const mirroredSequence = turnCheckpoint.events.reduce((latest, event) => {
      if (event.type !== 'agent.progress') return latest;
      const sequence = Number(event.payload.agentSequence || 0);
      return Number.isFinite(sequence) ? Math.max(latest, sequence) : latest;
    }, 0);
    const events = checkpoint.events
      .filter((event) => event.sequence > mirroredSequence)
      .map(agentProgressEvent)
      .filter((event): event is OscarTurnEventDraft => Boolean(event));
    if (events.length === 0) return;
    await this.updateTurn(this.storeForTurn(turnCheckpoint.turn), turnId, (turn) => ({ turn, events }));
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
      evidenceRefs?: AgentEvidenceReference[];
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
            },
          },
        ],
        outbox: input.outbox || implicitOutbox,
      };
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
    void this.drainOutbox();
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
        kind: 'persist-message' | 'create-agent-task' | 'send-agent-message' | 'reconcile-turn';
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

  private agentRuntimeForTurn(turn: OscarTurnV1): MonarchAgentRuntime | null {
    if (turn.privacyMode === 'incognito') return this.options.incognitoAgentRuntime || null;
    if (turn.privacyMode === 'persistent') return this.options.agentRuntime;
    return null;
  }

  private storeForPrivacy(privacy: OscarPrivacyMode): OscarTurnStore {
    return privacy === 'persistent' ? this.persistentStore : this.volatileStore;
  }

  private nowIso(): string {
    return (this.options.now?.() || new Date()).toISOString();
  }
}

export function userFacingTurnFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/(?:agent-decision-time-budget|decision cycle.*time budget)/i.test(message)) {
    return 'Oscar остановил слишком долгий выбор следующего действия по лимиту времени. Ранее подтверждённые результаты сохранены; новых действий не было.';
  }
  if (/(?:unexpected fields?|invalid-plan|plan-step|revise-plan|decision schema|schema validation)/i.test(message)) {
    return 'План задачи не прошёл проверку. Oscar остановился до новых действий; выполнение не подтверждено.';
  }
  if (/(?:model runtime|model unavailable|runtime unavailable|connection refused|econnrefused)/i.test(message)) {
    return 'Локальная модель сейчас недоступна. Никакие новые действия не подтверждены.';
  }
  if (/(?:cancelled|canceled|abort)/i.test(message)) {
    return 'Задача остановлена. Выполненными считаются только уже подтверждённые результаты.';
  }
  return 'Не удалось завершить задачу. Технические детали сохранены локально; неподтверждённые действия не считаются выполненными.';
}

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
    content: normalizeText(entry.content, 20_000, 'history message'),
  })) : [];
  return {
    clientRequestId: normalizeId(input.clientRequestId, 'client request'),
    conversationId: normalizeId(input.conversationId, 'conversation'),
    text: normalizeText(input.text, 20_000, 'request'),
    privacyMode: input.privacyMode,
    source: input.source,
    inputMessageId: input.inputMessageId
      ? normalizeId(input.inputMessageId, 'input message')
      : `oscar_message_${randomUUID().replace(/-/g, '')}`,
    attachmentIds: [...new Set((input.attachmentIds || []).map((id) => normalizeId(id, 'attachment')))].slice(0, 3),
    modifiers: normalizeModifiers(input.modifiers || {}),
    history,
    ...(input.executionProfile
      ? { executionProfile: normalizeTurnExecutionProfile(input.executionProfile, input.source) }
      : {}),
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
      ? { requestedModel: value.requestedModel.trim().slice(0, 120) }
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

function agentDecisionModelPolicy(requestedModel: string | undefined): AgentDecisionModelPolicy | undefined {
  switch (String(requestedModel || '').trim().toLowerCase()) {
  case 'gemma4-fast':
  case 'gemma4-balanced':
  case 'qwen3.8-27b-pro':
  case 'qwen3-coder-30b-a3b-instruct':
  case 'deepseek-coder-v2-lite-instruct':
    return {
      requestedRole: String(requestedModel).trim().toLowerCase() as AgentDecisionModelPolicy['requestedRole'],
      selectionSource: 'user-explicit',
      fallback: 'exact',
    };
  case 'gemma4-deepthinking':
  case 'gemma4-31b':
  case 'powerful':
  case 'reasoning':
  case 'pro':
  case 'extra':
    return {
      requestedRole: 'qwen3.8-27b-pro',
      selectionSource: 'user-explicit',
      fallback: 'exact',
    };
  default:
    return undefined;
  }
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

function sentenceDeltas(value: string): OscarTurnEventDraft[] {
  const content = String(value || '');
  return content ? [{ type: 'answer.delta', payload: { content } }] : [];
}

function agentProgressEvent(event: AgentTaskEvent): OscarTurnEventDraft | null {
  const payload = event.payload || {};
  const base = {
    agentSequence: event.sequence,
    taskId: event.taskId,
  };
  if (event.type === 'model.started') {
    const phase = payload.phase === 'planning' ? 'planning' : 'execution';
    const repair = payload.repair === true;
    return {
      type: 'agent.progress',
      payload: {
        ...base,
        phase,
        label: phase === 'planning' ? 'План · Задача' : 'Выбор · Действие',
        detail: phase === 'planning'
          ? (repair ? 'Уточняю проверяемые шаги' : 'Формирую проверяемые шаги')
          : 'Выбираю разрешённый инструмент',
        activity: {
          operation: phase === 'planning' ? 'plan' : 'select',
          domain: 'task',
          motion: 'breathing',
        },
      },
    };
  }
  if (event.type === 'plan.revised' && (typeof payload.summary === 'string' || Array.isArray(payload.steps))) {
    const titles = Array.isArray(payload.steps)
      ? payload.steps
        .map((step) => (step && typeof step === 'object' && !Array.isArray(step) ? String(step.title || '') : ''))
        .filter(Boolean)
        .slice(0, 4)
      : [];
    const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
    return {
      type: 'agent.progress',
      payload: {
        ...base,
        phase: 'plan',
        label: 'План · Готов',
        detail: [summary, titles.length ? titles.join(' → ') : ''].filter(Boolean).join(' · ').slice(0, 180),
        activity: {
          operation: 'plan',
          domain: 'task',
          subject: summary.slice(0, 140),
          motion: 'breathing',
        },
      },
    };
  }
  if (event.type === 'tool.started') {
    const capabilityId = typeof payload.capabilityId === 'string' ? payload.capabilityId : '';
    const activity = describeAgentActivity(payload.activity, capabilityId);
    return {
      type: 'agent.progress',
      payload: {
        ...base,
        phase: 'execution',
        label: activity.label,
        detail: activity.detail,
        activity,
      },
    };
  }
  if (event.type === 'verification.completed') {
    const status = typeof payload.status === 'string' ? payload.status : '';
    return {
      type: 'agent.progress',
      payload: {
        ...base,
        phase: 'verification',
        label: 'Проверка · Результат',
        detail: verificationStatusLabel(status),
        activity: {
          operation: 'verify',
          domain: 'result',
          subject: verificationStatusLabel(status),
          motion: 'heartbeat',
        },
      },
    };
  }
  return null;
}

function describeAgentActivity(value: unknown, capabilityId: string): Record<string, unknown> & {
  label: string;
  detail: string;
} {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const inferred = inferAgentActivity(capabilityId);
  const operation = boundedProgressText(source.operation, 32) || inferred.operation;
  const domain = boundedProgressText(source.domain, 32) || inferred.domain;
  const subject = boundedProgressText(source.subject, 160);
  const target = boundedProgressText(source.target, 160);
  const motion = source.motion === 'heartbeat' ? 'heartbeat' : 'breathing';
  const label = `${activityOperationLabel(operation)} · ${activityDomainLabel(domain)}`;
  const detail = operation === 'move' || operation === 'copy'
    ? [subject, target ? `→ ${target}` : ''].filter(Boolean).join(' ')
    : operation === 'search' && target
      ? [subject, `в ${target}`].filter(Boolean).join(' · ')
      : subject || target || 'Kernel выполняет разрешённый шаг';
  return {
    operation,
    domain,
    ...(subject ? { subject } : {}),
    ...(target ? { target } : {}),
    motion,
    label,
    detail,
  };
}

function inferAgentActivity(capabilityId: string): { operation: string; domain: string } {
  const lower = capabilityId.toLowerCase();
  const operation = lower.includes('search') || lower.includes('.network.fetch') || lower.includes('.chat.web')
    ? 'search'
    : lower.includes('.files.list') ? 'inspect'
      : lower.includes('.read') || lower.includes('.get') || lower.includes('.status') ? 'read'
        : lower.includes('.move') ? 'move'
          : lower.includes('.copy') ? 'copy'
            : lower.includes('.trash') ? 'trash'
              : lower.includes('.delete') ? 'delete'
                : lower.includes('.mkdir') || lower.includes('.create') ? 'create'
                  : lower.includes('.write') || lower.includes('.append') || lower.includes('.replace') ? 'write'
                    : lower.includes('.open') ? 'open' : 'execute';
  const domain = lower.includes('.network.') || lower.includes('.chat.web') || lower.includes('browser')
    ? 'internet'
    : lower.startsWith('workspace.files.') ? 'files'
      : lower.startsWith('memory.') || lower.includes('.memory.') ? 'memory'
        : lower.startsWith('astra.agent-skills.') ? 'skills'
          : lower.startsWith('device.apps.') ? 'apps' : 'system';
  return { operation, domain };
}

function activityOperationLabel(value: string): string {
  const labels: Record<string, string> = {
    search: 'Поиск',
    inspect: 'Просмотр',
    read: 'Чтение',
    move: 'Перемещение',
    copy: 'Копирование',
    trash: 'В корзину',
    delete: 'Удаление',
    create: 'Создание',
    write: 'Запись',
    open: 'Открытие',
    execute: 'Действие',
  };
  return labels[value] || 'Действие';
}

function activityDomainLabel(value: string): string {
  const labels: Record<string, string> = {
    internet: 'Интернет',
    files: 'Файлы',
    memory: 'Память',
    skills: 'Навыки',
    apps: 'Приложения',
    system: 'Система',
  };
  return labels[value] || 'Система';
}

function verificationStatusLabel(status: string): string {
  if (status === 'verified') return 'Факты подтверждены';
  if (status === 'failed') return 'Проверка не пройдена';
  if (status === 'partial') return 'Проверено частично';
  return 'Сверяю наблюдаемый результат';
}

function boundedProgressText(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function activeApproval(checkpoint: AgentTaskCheckpoint): AgentApproval | null {
  return checkpoint.approvals.find((entry) => (
    entry.id === checkpoint.task.activeApprovalId && entry.status === 'pending'
  )) || null;
}

function approvalEvent(checkpoint: AgentTaskCheckpoint, approval: AgentApproval): OscarTurnEventDraft[] {
  const proposal = approval.proposal;
  const risk = readProposalRisk(proposal);
  const requiresArm = ['delete', 'device-control', 'identity', 'irreversible', 'sensitive'].includes(risk)
    || /(?:delete|trash|recycle-bin\.empty|identity|credential)/i.test(approval.capabilityId);
  return [{
    type: 'approval.required',
    payload: {
      taskId: checkpoint.task.id,
      approvalId: approval.id,
      capabilityId: approval.capabilityId,
      canonicalProposalHash: approval.canonicalProposalHash,
      proposal,
      target: readProposalTarget(proposal),
      risk,
      expiresAt: approval.expiresAt || '',
      requiresArm,
    },
  }];
}

function readProposalRisk(proposal: Record<string, unknown>): string {
  const riskVector = proposal.riskVector;
  if (riskVector && typeof riskVector === 'object' && !Array.isArray(riskVector)) {
    const record = riskVector as Record<string, unknown>;
    return String(record.effect || record.risk || 'action');
  }
  return 'action';
}

function readProposalTarget(proposal: Record<string, unknown>): string {
  const args = proposal.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    for (const key of ['path', 'targetPath', 'target', 'app', 'url', 'device']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
  }
  const scope = proposal.scope;
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    const paths = (scope as Record<string, unknown>).paths;
    if (Array.isArray(paths) && typeof paths[0] === 'string') return paths[0];
  }
  return '';
}

function hasVerifiedAgentCompletionRecord(checkpoint: AgentTaskCheckpoint): boolean {
  const record = [...checkpoint.events].reverse().find((event) => event.type === 'verification.completed');
  return Boolean(record?.payload && typeof record.payload === 'object' && record.payload.status === 'verified');
}

function completedTaskHasUnfinishedPlanWork(checkpoint: AgentTaskCheckpoint): boolean {
  const plan = checkpoint.task.plan;
  if (!plan) return false;
  return plan.steps.some((step) => (
    step.status !== 'completed' && step.status !== 'failed' && step.status !== 'skipped'
  ));
}

function completedTaskHasRequiredEffectEvidence(checkpoint: AgentTaskCheckpoint): boolean {
  const requiredOutputs = checkpoint.task.goal.expectedOutputs.filter((output) => output.required !== false);
  const typedStateChangeRequired = requiredOutputs.some((output) => output.kind === 'state-change');
  const typedArtifactRequired = requiredOutputs.some((output) => output.kind === 'artifact');
  const inferredKind = typedStateChangeRequired || typedArtifactRequired
    ? 'verification'
    : inferOperationalGoalKind(checkpoint.task.goal.originalRequest);
  const stateChangeRequired = typedStateChangeRequired || inferredKind === 'state-change';
  const artifactRequired = typedArtifactRequired || inferredKind === 'artifact';
  const operationalRequirements = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest);
  if (!operationalRequirements.every((requirement) => checkpoint.observations.some((observation) => (
    observation.status === 'success'
    && !mutationObservationIsNotFullyVerified(observation)
    && operationalRequirementMatches(
      requirement,
      observation.capabilityId,
      observationOutput(observation),
    )
    && (!requirement.effectful || hasMutationOccurrence(observation))
  )))) return false;
  if (!stateChangeRequired && !artifactRequired) return true;
  const knownFolderTarget = resolveKnownFolderRequestTarget(checkpoint.task.goal.originalRequest);
  const verifiedMutation = checkpoint.observations.some((observation) => (
    observation.status === 'success'
    && hasMutationOccurrence(observation)
    && !mutationObservationIsNotFullyVerified(observation)
    && (!knownFolderTarget || (
      observation.capabilityId === 'workspace.known-folder.write'
      && knownFolderWriteOutputMatchesRequest(
        checkpoint.task.goal.originalRequest,
        observationOutput(observation),
      )
    ))
  ));
  if (!verifiedMutation) return false;
  return !artifactRequired || checkpoint.task.artifacts.some((artifact) => (
    !knownFolderTarget || sameCanonicalFilesystemPath(artifact.reference, knownFolderTarget.path)
  ));
}

function observationOutput(observation: AgentObservation): unknown {
  const structured = observation.structuredData;
  return structured && typeof structured === 'object' && !Array.isArray(structured)
    ? structured.output
    : undefined;
}

function hasMutationOccurrence(observation: AgentObservation): boolean {
  const structured = observation.structuredData;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return false;
  const truth = structured.mutationTruth;
  if (!truth || typeof truth !== 'object' || Array.isArray(truth)) return false;
  return String((truth as Record<string, unknown>).state || '') === 'occurred';
}

function operationalGoalContract(
  requestText: string,
  storageAudit: boolean,
): {
  expectedOutput: {
    id: string;
    description: string;
    kind: 'artifact' | 'state-change' | 'verification';
    required: true;
  };
  successCriterion: { id: string; description: string; verificationHint: string };
} {
  const inferredKind = inferOperationalGoalKind(requestText);
  const kind = storageAudit
    ? 'verification' as const
    : inferredKind;
  if (kind === 'artifact') {
    return {
      expectedOutput: {
        id: 'requested_artifact',
        description: `Create the exact requested local artifact and return its verified target: ${requestText}`,
        kind,
        required: true,
      },
      successCriterion: {
        id: 'requested_artifact_verified',
        description: 'A matching mutating capability created the requested artifact and a Kernel postcondition verified the exact effect.',
        verificationHint: 'Require mutation truth, a target-bound artifact, and capability-owned read-after-write evidence; unrelated reads and model text are insufficient.',
      },
    };
  }
  if (kind === 'state-change') {
    return {
      expectedOutput: {
        id: 'requested_state_change',
        description: `Complete and verify the exact requested local state change: ${requestText}`,
        kind,
        required: true,
      },
      successCriterion: {
        id: 'requested_effect_verified',
        description: 'A matching mutating capability completed the requested effect and a Kernel postcondition verified it.',
        verificationHint: 'Require mutation truth and capability-owned postcondition evidence; a preparatory inspection cannot satisfy this goal.',
      },
    };
  }
  return {
    expectedOutput: {
      id: storageAudit ? 'storage_audit_observation' : 'operational_observation',
      description: storageAudit
        ? `Return the bounded Kernel observation for the exact requested storage audit: ${requestText}`
        : `Return only the Kernel-observed result of this operational request: ${requestText}`,
      kind,
      required: true,
    },
    successCriterion: {
      id: 'kernel_result_verified',
      description: 'The result is bound to a successful target-matching Kernel observation; model text alone is insufficient.',
      verificationHint: 'Require a capability-owned factual observation for the requested target.',
    },
  };
}

function agentTurnGoalContract(
  requestText: string,
  storageAudit: boolean,
): {
  expectedOutput: {
    id: string;
    description: string;
    kind: 'answer' | 'artifact' | 'state-change' | 'verification';
    required: true;
  };
  successCriterion: { id: string; description: string; verificationHint: string };
} {
  const disposition = classifyOscarRequestDisposition(requestText);
  if (!storageAudit && disposition.mode === 'chat' && !disposition.hasLocalEffectTarget) {
    return {
      expectedOutput: {
        id: 'answer',
        description: `Return a local conversational answer without claiming an unobserved current computer state: ${requestText}`,
        kind: 'answer',
        required: true,
      },
      successCriterion: {
        id: 'answer_returned',
        description: 'A successful models.agent.respond observation returned non-empty answer text.',
        verificationHint: 'Model-generated text is sufficient only because the request requires no current local-state claim or real-world effect.',
      },
    };
  }
  return operationalGoalContract(requestText, storageAudit);
}

function mutationObservationIsNotFullyVerified(observation: AgentObservation): boolean {
  const structured = observation.structuredData;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return false;
  const truth = structured.mutationTruth;
  const sideEffects = Array.isArray(structured.sideEffects) ? structured.sideEffects : [];
  if ((!truth || typeof truth !== 'object' || Array.isArray(truth)) && sideEffects.length === 0) return false;
  const truthRecord = truth && typeof truth === 'object' && !Array.isArray(truth)
    ? truth as Record<string, unknown>
    : {};
  const state = String(truthRecord.state || 'unknown');
  if (state !== 'occurred' && state !== 'rolled-back') return true;
  const provenance = structured.provenance && typeof structured.provenance === 'object' && !Array.isArray(structured.provenance)
    ? structured.provenance as Record<string, unknown>
    : {};
  const receiptSource = String(truthRecord.source || '');
  const hasReceipt = typeof provenance.ledgerId === 'string' && provenance.ledgerId.length > 0
    || receiptSource === 'kernel-journal'
    || receiptSource === 'kernel-receipt';
  const hasPredicate = observation.evidence.some((entry) => (
    entry.evidenceClass === 'kernel-verification'
    && /:verification:/iu.test(entry.reference)
    && !/^Verification failed:/iu.test(String(entry.summary || ''))
  ));
  return !hasReceipt || !hasPredicate;
}

function deterministicAgentSummary(checkpoint: AgentTaskCheckpoint, outcome: OscarTurnOutcomeKind): string {
  const audit = [...checkpoint.observations].reverse().find((observation) => (
    observation.capabilityId === 'workspace.storage.audit'
  ));
  if (audit) return renderStorageAuditObservation(audit, outcome);
  const observation = [...checkpoint.observations].reverse().find((entry) => (
    entry.status === 'success' || entry.status === 'partial'
  ));
  const summary = observation?.summary || checkpoint.task.terminalReason?.summary || 'Kernel завершил задачу.';
  return outcome === 'partial' ? `Частичный Kernel-результат: ${summary}` : summary;
}

function groundedAgentSynthesis(checkpoint: AgentTaskCheckpoint): { text: string; sourceObservationIds: string[] } | null {
  const synthesis = [...checkpoint.observations].reverse().find((observation) => (
    observation.capabilityId === 'models.agent.synthesize'
    && (observation.status === 'success' || observation.status === 'partial')
  ));
  if (!synthesis?.structuredData || typeof synthesis.structuredData !== 'object' || Array.isArray(synthesis.structuredData)) {
    return null;
  }
  const structured = synthesis.structuredData as Record<string, unknown>;
  const output = structured.output && typeof structured.output === 'object' && !Array.isArray(structured.output)
    ? structured.output as Record<string, unknown>
    : {};
  const text = typeof output.rawText === 'string' ? output.rawText.trim() : '';
  const sourceObservationIds = Array.isArray(output.sourceObservationIds)
    ? output.sourceObservationIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  if (!text || sourceObservationIds.length === 0) return null;
  const valid = sourceObservationIds.every((id) => {
    const observation = checkpoint.observations.find((entry) => entry.id === id);
    return observation
      && observation.id !== synthesis.id
      && (observation.status === 'success' || observation.status === 'partial')
      && observation.evidence.some((entry) => (
        entry.evidenceClass === 'kernel-observation' || entry.evidenceClass === 'kernel-verification'
      ));
  });
  return valid ? { text, sourceObservationIds } : null;
}

function renderStorageAuditObservation(observation: AgentObservation, outcome: OscarTurnOutcomeKind): string {
  const data = observation.structuredData;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return observation.summary;
  const record = data as Record<string, unknown>;
  const result = record.result && typeof record.result === 'object' && !Array.isArray(record.result)
    ? record.result as Record<string, unknown>
    : record;
  const audit = result.audit && typeof result.audit === 'object' && !Array.isArray(result.audit)
    ? result.audit as Record<string, unknown>
    : result;
  const root = String(audit.root || audit.canonicalRoot || 'указанный корень');
  const files = Number(audit.files || audit.fileCount || 0);
  const directories = Number(audit.directories || audit.directoryCount || 0);
  const bytes = Number(audit.logicalBytes || 0);
  const top = Array.isArray(audit.topDirectories) ? audit.topDirectories.slice(0, 10) : [];
  const lines = [
    `${outcome === 'partial' ? 'Частичный' : 'Проверенный'} аудит ${root}: ${directories} каталогов, ${files} файлов, ${formatBytes(bytes)} logical bytes.`,
  ];
  for (const entry of top) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    lines.push(`- ${String(item.path || item.name || '')}: ${formatBytes(Number(item.logicalBytes || item.bytes || 0))}`);
  }
  const skips = audit.skipReasons && typeof audit.skipReasons === 'object' && !Array.isArray(audit.skipReasons)
    ? audit.skipReasons as Record<string, unknown>
    : {};
  if (Object.keys(skips).length > 0) lines.push(`Пропуски: ${JSON.stringify(skips)}.`);
  return lines.join('\n');
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
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

function normalizeText(value: string, maximum: number, label: string): string {
  const normalized = String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) throw new OscarTurnCoordinatorError(400, `empty-${label.replace(/\s+/g, '-')}`, `${label} is required.`);
  if (normalized.length > maximum) throw new OscarTurnCoordinatorError(413, `${label.replace(/\s+/g, '-')}-too-long`, `${label} is too long.`);
  return normalized;
}

function abortError(): Error {
  const error = new Error('Oscar Turn aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message));
}
