import type { AgentEvidenceReference, AgentTaskExecutionProfile } from '../agent';
import type { MonarchPersonalityContextV2 } from '../settings';
import type {
  ImageContentRatingV1,
  ImageGenerationCapabilitySnapshotV1,
  ImageGenerationIntentDispositionV1,
} from '../image-generation';
import type { ComputerUseCapabilitySnapshotV1 } from '../modules/computer/control-plane';

export const OSCAR_TURN_SCHEMA_VERSION = 'monarch.oscar-turn.v1' as const;
export const OSCAR_TURN_EVENT_SCHEMA_VERSION = 'monarch.oscar-turn-event.v1' as const;
export const MESSAGE_PROVENANCE_SCHEMA_VERSION = 'monarch.message-provenance.v1' as const;

export type OscarTurnSource = 'desktop' | 'voice' | 'telegram' | 'api' | 'coder' | 'system';
export type OscarPrivacyMode = 'persistent' | 'incognito' | 'encrypted';
export type OscarTurnMode = 'answer' | 'agent';
export type OscarTurnStatus =
  | 'accepted'
  | 'routing'
  | 'answering'
  | 'running'
  | 'waiting-for-user'
  | 'waiting-for-approval'
  | 'succeeded'
  | 'blocked'
  | 'failed'
  | 'cancelled';
export type OscarTurnOutcomeKind =
  | 'answered'
  | 'answered:source-grounded'
  | 'verified'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface OscarTurnFailureDiagnostic {
  code: string;
  detail: string;
  fingerprint: `sha256:${string}`;
}

export interface OscarTurnOutcome {
  kind: OscarTurnOutcomeKind;
  summary: string;
  evidenceRefs: AgentEvidenceReference[];
  warning?: string;
  diagnostic?: OscarTurnFailureDiagnostic;
  completedAt: string;
}

export interface OscarTurnModifiers {
  requestedModel?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  webSearch?: boolean;
  researchMode?: 'auto' | 'off' | 'deep';
  dataEgressConsentId?: string;
  imageGenerationCapability?: ImageGenerationCapabilitySnapshotV1;
  computerUseCapability?: ComputerUseCapabilitySnapshotV1;
  imageGeneration?: {
    schemaVersion: 1;
    contentRating: ImageContentRatingV1;
    disposition: Exclude<ImageGenerationIntentDispositionV1, 'not-image-generation'>;
    providerId: 'perchance-interactive';
  };
}

export interface OscarTurnRequestSnapshot {
  text: string;
  attachmentIds: string[];
  modifiers: OscarTurnModifiers;
  personality?: MonarchPersonalityContextV2;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  continuations?: Array<{ messageId: string; content: string; createdAt: string }>;
  /** Trusted local surface binding; never accepted from the public Turn HTTP body. */
  executionProfile?: AgentTaskExecutionProfile;
}

export interface OscarTurnV1 {
  schemaVersion: typeof OSCAR_TURN_SCHEMA_VERSION;
  id: string;
  clientRequestId: string;
  conversationId: string;
  source: OscarTurnSource;
  privacyMode: OscarPrivacyMode;
  mode: OscarTurnMode;
  status: OscarTurnStatus;
  request: OscarTurnRequestSnapshot;
  inputMessageId: string;
  outputMessageId?: string;
  taskId?: string;
  activeApprovalId?: string;
  outcome?: OscarTurnOutcome;
  supersedesTurnId?: string;
  retryOf?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type OscarTurnEventType =
  | 'turn.accepted'
  | 'turn.routed'
  | 'agent.progress'
  | 'answer.delta'
  | 'answer.replace'
  | 'task.linked'
  | 'approval.required'
  | 'user.input.required'
  | 'non-authoritative-confirmation'
  | 'turn.outcome'
  | 'turn.failed';

export interface OscarTurnEventDraft {
  type: OscarTurnEventType;
  createdAt?: string;
  payload: Record<string, unknown>;
}

export interface OscarTurnEventV1 {
  schemaVersion: typeof OSCAR_TURN_EVENT_SCHEMA_VERSION;
  id: string;
  turnId: string;
  sequence: number;
  type: OscarTurnEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}

export type MessageProvenanceOrigin =
  | 'user'
  | 'model'
  | 'external-source'
  | 'kernel'
  | 'system'
  | 'legacy';
export type MessageProvenanceVerification =
  | 'user-assertion'
  | 'unverified-model'
  | 'source-grounded'
  | 'kernel-verified'
  | 'kernel-partial'
  | 'system-state'
  | 'legacy-unknown';

export interface MessageProvenanceV1 {
  schemaVersion: typeof MESSAGE_PROVENANCE_SCHEMA_VERSION;
  origin: MessageProvenanceOrigin;
  verification: MessageProvenanceVerification;
  turnId: string;
  taskId?: string;
  evidenceRefs?: AgentEvidenceReference[];
  surface?: OscarTurnSource;
  privacyMode?: OscarPrivacyMode;
  legacy?: boolean;
}

export type OscarTurnOutboxKind =
  | 'persist-message'
  | 'create-agent-task'
  | 'send-agent-message'
  | 'reconcile-turn';
export interface OscarTurnOutboxDraft {
  id: string;
  turnId: string;
  kind: OscarTurnOutboxKind;
  payload: Record<string, unknown>;
}

export interface OscarTurnOutboxItem extends OscarTurnOutboxDraft {
  status: 'pending' | 'retrying' | 'succeeded' | 'superseded';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lastError?: string;
  supersededBy?: string;
}

export interface OscarTurnCheckpoint {
  turn: OscarTurnV1;
  events: OscarTurnEventV1[];
}

export interface OscarTurnStoreCommit extends OscarTurnCheckpoint {
  appendedEvents: OscarTurnEventV1[];
  replayed: boolean;
}

export interface OscarTurnCreateOptions {
  events?: OscarTurnEventDraft[];
  outbox?: OscarTurnOutboxDraft[];
}

export interface OscarTurnCancellationReservation {
  clientRequestId: string;
  source: OscarTurnSource;
  privacyMode: OscarPrivacyMode;
  expiresAt: string;
}

export interface OscarTurnSaveOptions extends OscarTurnCreateOptions {
  expectedRevision: number;
}

export interface OscarTerminalMessageRepair {
  messageId: string;
  outbox: OscarTurnOutboxDraft;
}

export type OscarTurnStoreListener = (commit: OscarTurnStoreCommit) => void;

export interface OscarTurnStore {
  createTurn(turn: OscarTurnV1, options?: OscarTurnCreateOptions): Promise<OscarTurnStoreCommit>;
  getTurn(turnId: string): Promise<OscarTurnCheckpoint | null>;
  getTurnByClientRequestId(clientRequestId: string): Promise<OscarTurnCheckpoint | null>;
  reserveClientCancellation(reservation: OscarTurnCancellationReservation): Promise<void>;
  hasClientCancellation(reservation: Omit<OscarTurnCancellationReservation, 'expiresAt'>, now?: Date): Promise<boolean>;
  clearClientCancellation(reservation: Omit<OscarTurnCancellationReservation, 'expiresAt'>): Promise<void>;
  listTurns(): Promise<OscarTurnV1[]>;
  deleteTurn(turnId: string): Promise<boolean>;
  saveTurn(turn: OscarTurnV1, options: OscarTurnSaveOptions): Promise<OscarTurnStoreCommit>;
  ensureTerminalMessage(turnId: string, repair: OscarTerminalMessageRepair): Promise<OscarTurnStoreCommit>;
  listPendingOutbox(now?: Date): Promise<OscarTurnOutboxItem[]>;
  markOutboxSucceeded(outboxId: string): Promise<void>;
  markOutboxSuperseded(outboxId: string): Promise<void>;
  markOutboxFailed(outboxId: string, error: string, nextAttemptAt: string): Promise<void>;
  subscribe(turnId: string | '*', listener: OscarTurnStoreListener): () => void;
}
