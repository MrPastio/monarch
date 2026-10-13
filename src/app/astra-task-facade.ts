import { createHash, createHmac } from 'node:crypto';
import { validateAstraMemoryQuery, type AstraMemoryRecallSnapshot } from '../agent-v3/memory-recall';
import { AstraJournal, type AstraJson } from '../agent-v3/journal';
import { AstraModelReadTaskProfile, type AstraModelReadTaskOptions } from '../agent-v3/model-read-task-profile';
import { modelReadDigest, modelReadIdentity, modelReadJson, modelReadTaskId } from '../agent-v3/model-read-task-state';
import type { AstraReadSelection, AstraReadSourceKey } from '../agent-v3/read-task-certifier';
import { AstraCreateTaskProfile, astraCreateTaskId } from '../agent-v3/create-task-profile';
import { createApprovalDigest, validateCreateApprovalDecision, type AstraCreateApprovalCard, type AstraCreateApprovalDecision } from '../agent-v3/create-approval';
import { AstraReadTaskProfile, astraReadTaskId } from '../agent-v3/read-task-runtime';
import { AstraSourceGoalCompiler, validateAstraSourceGoal, type AstraLocalAgentModelChoice, type AstraMaxModelChoice,
  type AstraSourceGoalInput } from './astra-source-goal-compiler';
import type { AstraCreateSelection } from '../agent-v3/create-task-certifier';
import { AstraModelCreateTaskProfile } from '../agent-v3/model-create-task-profile';
import { draftTaskId, validateDraftReply, type AstraDraftReply, type AstraModelCreateSelection } from '../agent-v3/model-create-task-state';
import type { AstraWorkAdapter, AstraWorkScheduler } from '../agent-v3/work-scheduler';
import type { OscarPrivacyMode, OscarTurnSource } from '../oscar-turn/types';
import { AstraApplicationTaskHost, type AstraTaskHostFailure, type AstraTaskHostIssue,
  type AstraTaskRecoveryCandidate } from './astra-task-host';
import { AstraComputerObserveTaskProfile, astraComputerTaskId, type AstraComputerTaskSelection } from '../agent-v3/computer-observe-task-profile';
import type { AstraComputerObservation } from '../agent-v3/computer-observe-work-adapter';
import { AstraComputerActionTaskProfile, astraComputerActionTaskId,
  type AstraComputerActionTaskSelection } from '../agent-v3/computer-action-task-profile';
import type { AstraComputerAction, AstraComputerActionApprovalCard } from '../agent-v3/computer-action-work-adapter';
import { AstraAgentTaskProfile, astraAgentTaskId, isAstraAgentExecutionProfile, isAstraAgentHistory,
  isAstraAgentTaskSpecification,
  isAstraAgentInitialEvidence, type AstraAgentHistoryItem, type AstraAgentInitialEvidenceItem,
  type AstraAgentTaskPolicy, type AstraAgentTaskSpecification } from '../agent-v3/agent-task-profile';
import type { AstraAgentCapabilityCandidate } from '../agent-v3/agent-decision-gateway';
import { AstraTaskFaultContainment } from '../agent-v3/task-fault';
import type { AstraCapabilityApprovalCard, AstraCapabilityWorkSource } from '../agent-v3/capability-work-adapter';
import type { AgentTaskExecutionProfile, AgentTaskSource } from '../agent-protocol';

/** Authenticated source actor. HTTP currently derives only desktop/api; the
 * Telegram variant is admitted solely by the paired in-process remote gate. */
export interface AstraAuthenticatedHttpActor {
  id: string;
  source: Extract<OscarTurnSource, 'desktop' | 'voice' | 'api' | 'telegram' | 'coder' | 'system'>;
}
export interface AstraTaskHttpRequest {
  version: 1; clientRequestId: string; conversationId: string; inputMessageId: string;
  text: string; selectionId: string; privacyMode: Extract<OscarPrivacyMode, 'persistent' | 'incognito'>;
  goal?: AstraSourceGoalInput;
  history?: AstraAgentHistoryItem[];
  attachmentIds?: string[];
  executionProfile?: AgentTaskExecutionProfile;
  /** In-process explicit Agent Task contract. Public Oscar Turn JSON cannot
   * manufacture this marker. */
  specification?: AstraAgentTaskSpecification;
  /** In-process authenticated Telegram envelope. It is accepted only for the
   * generic agent family and is never part of the public Astra HTTP body. */
  telegramActor?: NonNullable<AgentTaskSource['telegram']> & { requestId: string };
}
export interface AstraTaskSourceContext { actor: AstraAuthenticatedHttpActor; conversationId: string; inputMessageId: string; text: string; goal?: AstraSourceGoalInput }
export interface AstraReadSelectionCatalog { resolve(selectionId: string, context: AstraTaskSourceContext): AstraReadSelection }
export type AstraCreateCatalogSelection = { kind: 'literal' } & Omit<AstraCreateSelection, 'userText'>
  | { kind: 'draft' } & Omit<AstraModelCreateSelection, 'userText'>
  | { kind: 'literal-input' } & Omit<AstraModelCreateSelection, 'userText' | 'requiredInput'>
    & { requiredInput: NonNullable<AstraModelCreateSelection['requiredInput']> & { kind: 'literal-content' } };
export interface AstraCreateSelectionCatalog { resolve(selectionId: string, context: AstraTaskSourceContext): AstraCreateCatalogSelection }
/** Explicit host-selected window snapshot, never an HWND supplied by a model or HTTP caller. */
export interface AstraComputerSelectionSnapshot {
  selectionId: string; actor: AstraAuthenticatedHttpActor; conversationId: string; revision: number;
  windowRef: string; processId: number; processInstanceId: string; title: string; expiresAt: number; timeoutMs: number;
}
export interface AstraComputerSelectionCatalog { resolve(selectionId: string, context: AstraTaskSourceContext): AstraComputerSelectionSnapshot }
export interface AstraComputerActionPlanSnapshot {
  selectionId: string; actor: AstraAuthenticatedHttpActor; conversationId: string; revision: number;
  windowRef: string; processId: number; processInstanceId: string; title: string; expiresAt: number; timeoutMs: number;
  observation: AstraComputerObservation; action: AstraComputerAction;
}
export interface AstraComputerActionPlanSeed { source: AstraComputerSelectionSnapshot; observation: AstraComputerObservation }
export interface AstraComputerActionPlanCatalog { resolve(selectionId: string, context: AstraTaskSourceContext): AstraComputerActionPlanSnapshot }
type Operation = 'read' | 'create' | 'computer-observe' | 'computer-action' | 'agent';
type CreateFamily = 'literal-create' | 'model-create' | 'input-create';
type SourceFamily = CreateFamily | 'direct-read' | 'model-read' | 'computer-observe' | 'computer-action' | 'generic-agent';
type SourceContext = { conversationId: string; inputMessageId: string };
interface TelegramV2AgentGate {
  request(id: string): { grantId: string | null } | null;
  activeGrant(): { id: string; capabilities: string[] } | null;
  permits(requestId: string, conversationId: string, capability: string, input: unknown): boolean;
}
interface SourceRecord {
  schemaVersion: 'monarch.astra-v3-http-source.internal.v1'; sourceId: string; taskId: string;
  scopeId: string; actor: AstraAuthenticatedHttpActor; request: AstraTaskHttpRequest; requestDigest: string;
  /** Absent on the existing read format. Never supplied by an HTTP caller. */
  family?: SourceFamily;
  /** Host decision retained per source; existing tasks keep exact source review. */
  createConfirmationPolicy?: 'kernel';
  memoryRecall?: AstraMemoryRecallSnapshot;
  memoryPolicyRevision?: string;
}
export interface AstraTaskHttpTask {
  id: string; conversationId: string; inputMessageId: string; source: AstraAuthenticatedHttpActor['source'];
  privacyMode: 'persistent'; status: string; nativeCompletionCertified: boolean;
  modelJobs: number; readJobs: number; createJobs?: number; inputJobs?: number; capabilityJobs?: number; runtimeIssue?: AstraTaskHostIssue;
  /** Bounded internal terminal code. It is diagnostic only and never grants
   * authority or exposes model/provider payloads. */
  failureReason?: string;
  /** What the Kernel receipts cited by a certified completion actually say:
   * every cited action succeeded, none was cited, some failed, or all failed.
   * A certificate proves the model completed after those receipts; only this
   * says whether the effects it describes happened. */
  completionEvidence?: 'succeeded' | 'none' | 'mixed' | 'failed';
  computerJobs?: number; observation?: AstraComputerObservation;
  activities?: Array<{ round: number; capabilityId: string; reason: string; thought?: string; state: 'proposed' | 'observed' | 'failed';
    summary?: string; ok?: boolean; output?: AstraJson; target?: string }>;
  artifacts?: Array<{ id: string; label: string; kind: 'file'; reference: string; checksum: string }>;
  approval?: (AstraCreateApprovalCard | AstraComputerActionApprovalCard | AstraCapabilityApprovalCard)
    & { conversationId: string; predecessorMessageId: string };
  question?: { id: string; digest: string; text: string; conversationId: string; predecessorMessageId: string;
    expiresAt: number; authority: 'none'; nativeCompletionCertified: false; origin?: 'host-required-input';
    inputKind?: 'literal-content'; maxUtf8Bytes?: number };
  message?: { id: string; taskId: string; conversationId: string; predecessorMessageId: string;
    content: string; certificateDigest: string; delivery: 'pending' | 'acknowledged';
    verification: 'internal-read-certificate' | 'internal-create-certificate' | 'internal-model-create-certificate' | 'internal-input-create-certificate' | 'internal-computer-observation-proof' | 'internal-computer-action-proof' | 'internal-agent-receipt' | 'native-agent-completion-certificate'; nativeCompletionCertified: boolean };
}
export interface AstraTaskHttpSurface {
  submit(actor: AstraAuthenticatedHttpActor, request: AstraTaskHttpRequest): AstraTaskHttpTask;
  read(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext): AstraTaskHttpTask;
  list(actor: AstraAuthenticatedHttpActor, conversationId: string): AstraTaskHttpTask[];
  command(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, command: 'pause' | 'resume' | 'cancel'): AstraTaskHttpTask;
  reconcile(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext): Promise<AstraTaskHttpTask>;
  acknowledge(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, certificateDigest: string): AstraTaskHttpTask;
  reply?(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, reply: AstraDraftReply): AstraTaskHttpTask;
  decide?(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, decision: AstraCreateApprovalDecision): AstraTaskHttpTask;
}
/** How long a chat-initiated agent task may run before it expires.
 *
 * Long enough for a multi-step local task, short enough that a person who
 * is waiting at the screen is not waiting until tomorrow. */
export const ASTRA_INTERACTIVE_AGENT_DEADLINE_MS = 30 * 60_000;

/** The deadline a chat-initiated agent task starts with, if it needs one.
 *
 * A task submitted without one inherits the contract's twelve hour ceiling.
 * That ceiling is for work someone budgeted for; a request typed in chat has a
 * person waiting at the screen, and a stuck task that only expires the next day
 * never reaches them. A budget stated in the request still wins, so this
 * returns nothing when the caller has already said how long the work may take.
 *
 * An execution profile is Coder's own signal that nobody is waiting at a
 * screen for this exact answer: `submitOwned` requires one if and only if the
 * actor is `coder`, the surface for host-selected project work the pilot runs
 * on its own schedule. Clamping that to thirty minutes broke real multi-hour
 * project tasks; measured on `tests/agent-v3/prepared-model.test.ts`'s Coder
 * V3 binding test, which expects the full twelve hour ceiling. */
export function interactiveAgentDeadlineMs(
  specification?: { budgets?: { maxWallTimeMs?: number } },
  hasExecutionProfile = false,
): number | undefined {
  if (hasExecutionProfile) return undefined;
  return specification?.budgets?.maxWallTimeMs === undefined
    ? ASTRA_INTERACTIVE_AGENT_DEADLINE_MS : undefined;
}

/** Marks a recovery candidate that is a scheduler job with no owning task. */
const ORPHAN_JOB_TASK_PREFIX = 'astra_orphan_job:';

export function astraCompletionEvidence(certificate: { evidenceRefs: readonly string[];
  receipts: ReadonlyArray<{ ref: string; ok: boolean }> }): 'succeeded' | 'none' | 'mixed' | 'failed' {
  const cited = certificate.receipts.filter(receipt => certificate.evidenceRefs.includes(receipt.ref));
  if (!cited.length) return 'none';
  const ok = cited.filter(receipt => receipt.ok).length;
  return ok === cited.length ? 'succeeded' : ok === 0 ? 'failed' : 'mixed';
}

export class AstraTaskHttpError extends Error { constructor(readonly statusCode: number, readonly code: string) { super(code); } }
function check(value: unknown, status: number, code: string): asserts value { if (!value) throw new AstraTaskHttpError(status, code); }
const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);
const json = modelReadJson;
const ASTRA_CERTIFIED_READ_PRESENTATION_BYTES = 65_536;

export function astraAgentLocalModelChoiceAllowed(source: AstraAuthenticatedHttpActor['source'],
  choice: AstraLocalAgentModelChoice | undefined, configured: ReadonlyArray<AstraLocalAgentModelChoice>): boolean {
  // Coder uses the same admitted agent policies as Oscar. A project profile
  // narrows capabilities; it must not force a second, uninstalled model.
  return choice === undefined ? source !== 'coder' : configured.includes(choice);
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; bytes: number; truncated: boolean } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maximumBytes) return { value, bytes: encoded.length, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString('utf8'), bytes: end, truncated: true };
}

/** Presentation only. Every value must first be recovered through
 * AstraReadTaskProfile.readContent(), which rechecks the immutable evidence
 * frontier and its certificate digest. This renderer grants no read authority. */
export function renderAstraCertifiedReadPresentation(summary: string,
  observations: Array<{ content: string; sizeBytes: number }>): string {
  if (!observations.length) return summary;
  const totalBytes = observations.reduce((sum, item) => sum + item.sizeBytes, 0);
  let remaining = ASTRA_CERTIFIED_READ_PRESENTATION_BYTES, shownBytes = 0;
  const sections: string[] = [];
  for (let index = 0; index < observations.length && remaining > 0; index++) {
    const observation = observations[index]!, projected = truncateUtf8(observation.content, remaining);
    shownBytes += projected.bytes; remaining -= projected.bytes;
    const label = observations.length === 1 ? 'Сертифицированное содержимое'
      : `Сертифицированное содержимое ${index + 1}/${observations.length}`;
    sections.push(`${label} (UTF-8, снимок на момент выполнения):\n${projected.value || '[пустой файл]'}`);
    if (projected.truncated) break;
  }
  const truncation = shownBytes < totalBytes
    ? `\n\n[Вывод усечён: показано ${shownBytes} из ${totalBytes} UTF-8 байт.]`
    : '';
  return `${summary}\n\n${sections.join('\n\n')}${truncation}`;
}

/** Default-off Application seam: one actor/message namespace, one externally
 * assembled scheduler and one lifecycle controller for read/literal/draft work.
 * Catalogs select family/target/content; HTTP/model never supply effect authority.
 * Existing read source/checkpoint/view shapes are preserved, not migrated. */
export class MonarchAstraTaskFacade implements AstraTaskHttpSurface {
  readonly adapters: AstraWorkAdapter[];
  readonly legacyAdapters: AstraWorkAdapter[];
  readonly createTasks: AstraTaskHttpSurface | undefined;
  readonly computerTasks: AstraTaskHttpSurface | undefined;
  readonly computerActionTasks: AstraTaskHttpSurface | undefined;
  readonly agentTasks: AstraTaskHttpSurface | undefined;
  private readonly reads: AstraModelReadTaskProfile;
  private readonly directReads: AstraReadTaskProfile | undefined;
  private readonly literals: AstraCreateTaskProfile | undefined;
  private readonly drafts: AstraModelCreateTaskProfile | undefined;
  private readonly computer: AstraComputerObserveTaskProfile | undefined;
  private readonly computerActions: AstraComputerActionTaskProfile | undefined;
  private readonly agent: AstraAgentTaskProfile | undefined;
  private readonly agentCatalogKey: Buffer | undefined;
  private readonly pending = new Map<string, SourceRecord>();
  /** Tasks whose own progression faulted in this host lifetime. */
  private readonly taskFaults = new AstraTaskFaultContainment(() => this.scheduler?.ownerIsCurrent() === true,
    ({ outcome, ...notice }) => console.error(JSON.stringify({ diagnostic: 'astra-task-fault-' + outcome, ...notice })));
  private stopping: Promise<{ unresolvedWork: number }> | undefined;
  private host: AstraApplicationTaskHost | undefined;
  /** Consecutive progression passes that ended with work still changing. */
  private unsettledProgressions = 0;
  private scheduler: AstraWorkScheduler | undefined;
  private readonly journal: AstraJournal;
  get referenceInputsEnabled(): boolean { return this.options.referenceInputs === true && this.options.compositeApprovals === true && !!this.drafts; }
  matchesComputerHost(catalog: AstraComputerSelectionCatalog, journal: AstraJournal, kernel: AstraModelReadTaskOptions['kernel']): boolean {
    return !!this.computer && this.options.computerCatalog === catalog && this.journal === journal && this.options.kernel === kernel;
  }
  matchesComputerActionHost(catalog: AstraComputerActionPlanCatalog, journal: AstraJournal, kernel: AstraModelReadTaskOptions['kernel']): boolean {
    return !!this.computerActions && this.options.computerActionCatalog === catalog && this.journal === journal && this.options.kernel === kernel;
  }
  constructor(private readonly options: Omit<AstraModelReadTaskOptions, 'admission'> & {
    catalog?: AstraReadSelectionCatalog; createCatalog?: AstraCreateSelectionCatalog;
    computerCatalog?: AstraComputerSelectionCatalog; computerActionCatalog?: AstraComputerActionPlanCatalog;
    sourceCompiler?: AstraSourceGoalCompiler;
    createPolicy?: AstraModelReadTaskOptions['policy'];
    requiredInputs?: boolean;
    /** Explicit new literal-create cohort. Composite/model children remain v1. */
    literalApprovals?: boolean;
    compositeApprovals?: boolean;
    desktopCreateConfirmation?: 'kernel';
    referenceInputs?: boolean;
    /** Product-only explicit cloud choice. A configured host alone never opts a task in. */
    requiredModelMode?: 'max';
    optionalMax?: boolean;
    localAnalysis?: boolean;
    privacyMode?: 'persistent' | 'incognito';
    memoryPolicyCurrent?: (revision: string) => boolean;
    genericAgent?: { catalogKey: Uint8Array;
      policy: Partial<AstraAgentTaskPolicy> & Pick<AstraAgentTaskPolicy, 'modelId' | 'expectedModelDigest'>;
      dynamicMaxClient?: import('../agent-v3/prepared-model-client').AstraPreparedModelClient;
      dynamicMaxPolicy?: (choice: AstraMaxModelChoice) => (Partial<AstraAgentTaskPolicy>
        & Pick<AstraAgentTaskPolicy, 'modelId' | 'expectedModelDigest'>) | undefined;
      localPolicies?: Readonly<Partial<Record<AstraLocalAgentModelChoice,
        Partial<AstraAgentTaskPolicy> & Pick<AstraAgentTaskPolicy, 'modelId' | 'expectedModelDigest'>>>>;
      maxPolicies?: Readonly<Partial<Record<AstraMaxModelChoice,
        Partial<AstraAgentTaskPolicy> & Pick<AstraAgentTaskPolicy, 'modelId' | 'expectedModelDigest'>>>> };
    /** Host-authored digests only. Source chooses a closed public profile name,
     * never a provider ID or digest. */
    maxModelPolicies?: Readonly<Record<AstraMaxModelChoice, AstraModelReadTaskOptions['policy']>>;
  }) {
    check(options.deployment === 'isolated-validation', 403, 'astra-isolated-host-required');
    check(options.privacyMode === undefined || options.privacyMode === 'persistent' || options.privacyMode === 'incognito',
      409, 'astra-privacy-mode-policy');
    check(options.requiredModelMode === undefined || options.requiredModelMode === 'max', 409, 'astra-model-mode-policy');
    check(!options.maxModelPolicies || (options.requiredModelMode === 'max' || options.optionalMax === true)
      && Object.keys(options.maxModelPolicies).length === 2
      && ['gpt-oss-120b', 'qwen-3.8-27b'].every(key => Object.hasOwn(options.maxModelPolicies!, key)),
    409, 'astra-max-model-policy');
    check(!options.genericAgent?.localPolicies || Object.keys(options.genericAgent.localPolicies).length >= 1
      && Object.keys(options.genericAgent.localPolicies).every(key =>
        ['gemma4-balanced', 'qwen3-coder-30b-a3b-instruct', 'deepseek-coder-v2-lite-instruct'].includes(key)),
    409, 'astra-local-agent-model-policy');
    check(!options.genericAgent?.maxPolicies || Object.keys(options.genericAgent.maxPolicies).length >= 1
      && Object.keys(options.genericAgent.maxPolicies).every(modelChoice => {
        try { validateAstraSourceGoal({ kind: 'agent', modelMode: 'max', modelChoice: modelChoice as AstraMaxModelChoice,
          ...(modelChoice === 'qwen-3.8-27b' ? { previewAcknowledged: true as const } : {}) }, 'agent'); return true; }
        catch { return false; }
      }), 409, 'astra-max-agent-model-policy');
    check(!options.genericAgent || Boolean(options.genericAgent.dynamicMaxClient)
      === Boolean(options.genericAgent.dynamicMaxPolicy), 409, 'astra-dynamic-max-agent-policy');
    check(options.sourceCompiler ? !options.catalog && !options.createCatalog : !!options.catalog, 409, 'astra-source-mode-conflict');
    this.journal = options.journal;
    this.reads = new AstraModelReadTaskProfile({ ...options,
      ...(options.maxModelPolicies ? { policyForSource: source => this.readModelPolicy(source) } : {}), admission: { resolve: source => this.readSelection(source),
      isCurrent: source => { try { const selected = this.readSelection(source); return selected.revision === source.revision && selected.digest === source.digest; } catch { return false; } } } });
    if (options.sourceCompiler) this.directReads = new AstraReadTaskProfile({ ...options, restartSafeAdmission: true, admission: {
      resolve: source => this.readSelection(source), isCurrent: source => { try { const selected = this.readSelection(source);
        return selected.revision === source.revision && selected.digest === source.digest; } catch { return false; } },
    } });
    if (options.createCatalog || options.sourceCompiler) {
      this.literals = new AstraCreateTaskProfile({ ...options, exactApprovals: options.literalApprovals === true, admission: {
        resolve: source => this.createSelection(source, 'literal-create') as AstraCreateSelection,
        isCurrent: source => { try { const selected = this.createSelection(source, 'literal-create'); return selected.revision === source.revision && selected.digest === source.digest; } catch { return false; } },
      } });
      this.drafts = new AstraModelCreateTaskProfile({ ...options, exactApprovals: options.compositeApprovals === true,
        policy: options.createPolicy ?? options.policy,
        ...(options.maxModelPolicies ? { policyForSource: source => this.createModelPolicy(source) } : {}), admission: {
        resolve: source => this.composedCreateSelection(source),
        isCurrent: source => { try { this.composedCreateSelection(source); return true; } catch { return false; } },
      } });
      this.createTasks = { submit: (actor, request) => this.submit(actor, request, 'create'),
        read: (actor, taskId, context) => this.read(actor, taskId, context, 'create'),
        list: (actor, conversationId) => this.list(actor, conversationId, 'create'),
        command: (actor, taskId, context, command) => this.command(actor, taskId, context, command, 'create'),
        reconcile: (actor, taskId, context) => this.reconcile(actor, taskId, context, 'create'),
        acknowledge: (actor, taskId, context, digest) => this.acknowledge(actor, taskId, context, digest, 'create'),
        reply: (actor, taskId, context, reply) => this.reply(actor, taskId, context, reply),
        ...(options.literalApprovals || options.compositeApprovals ? { decide: (actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, decision: AstraCreateApprovalDecision) => this.decide(actor, taskId, context, decision) } : {}) };
    }
    if (options.computerCatalog) {
      this.computer = new AstraComputerObserveTaskProfile({ ...options, admission: { resolve: source => this.computerSelection(source),
        isCurrent: (source, selected) => { try { return modelReadDigest(this.computerSelection(source)) === modelReadDigest(selected); } catch { return false; } } } });
      this.computerTasks = { submit: (actor, request) => this.submit(actor, request, 'computer-observe'),
        read: (actor, taskId, context) => this.read(actor, taskId, context, 'computer-observe'),
        list: (actor, conversationId) => this.list(actor, conversationId, 'computer-observe'),
        command: (actor, taskId, context, command) => this.command(actor, taskId, context, command, 'computer-observe'),
        reconcile: (actor, taskId, context) => this.reconcile(actor, taskId, context, 'computer-observe'),
        acknowledge: (actor, taskId, context, digest) => this.acknowledge(actor, taskId, context, digest, 'computer-observe') };
    }
    if (options.computerActionCatalog) {
      this.computerActions = new AstraComputerActionTaskProfile({ ...options, admission: { resolve: source => this.computerActionSelection(source),
        isCurrent: (source, selected) => { try { return modelReadDigest(this.computerActionSelection(source)) === modelReadDigest(selected); } catch { return false; } } } });
      this.computerActionTasks = { submit: (actor, request) => this.submit(actor, request, 'computer-action'),
        read: (actor, taskId, context) => this.read(actor, taskId, context, 'computer-action'),
        list: (actor, conversationId) => this.list(actor, conversationId, 'computer-action'),
        command: (actor, taskId, context, command) => this.command(actor, taskId, context, command, 'computer-action'),
        reconcile: (actor, taskId, context) => this.reconcile(actor, taskId, context, 'computer-action'),
        acknowledge: (actor, taskId, context, value) => this.acknowledge(actor, taskId, context, value, 'computer-action'),
        decide: (actor, taskId, context, decision) => this.decideComputer(actor, taskId, context, decision) };
    }
    if (options.genericAgent) {
      check(options.genericAgent.catalogKey.byteLength === 32, 409, 'astra-agent-catalog-key');
      this.agentCatalogKey = Buffer.from(options.genericAgent.catalogKey);
      this.agent = new AstraAgentTaskProfile({ deployment: 'isolated-validation', scopeId: options.scopeId,
        journal: options.journal, kernel: options.kernel, client: options.client,
        ...(options.modelClients ? { modelClients: options.modelClients } : {}),
        ...(options.genericAgent.dynamicMaxClient ? { dynamicMaxClient: options.genericAgent.dynamicMaxClient } : {}),
        policy: options.genericAgent.policy,
        policyForSource: source => this.agentPolicy(source), resolveCandidates: source => this.agentCandidates(source),
        isSourceCurrent: source => this.agentSourceCurrent(source),
        isCapabilityAllowed: (capability, source) => this.agentCandidates(source)
          .some(candidate => candidate.capabilityId === capability.id && candidate.moduleId === capability.moduleId),
        permissionProfile: source => this.agentPermissionProfile(source),
        bindCapabilityArgs: (capabilityId, args, source) => this.agentCapabilityArgs(capabilityId, args, source) });
      this.agentTasks = { submit: (actor, request) => this.submit(actor, request, 'agent'),
        read: (actor, taskId, context) => this.read(actor, taskId, context, 'agent'),
        list: (actor, conversationId) => this.list(actor, conversationId, 'agent'),
        command: (actor, taskId, context, command) => this.command(actor, taskId, context, command, 'agent'),
        reconcile: (actor, taskId, context) => this.reconcile(actor, taskId, context, 'agent'),
        acknowledge: (actor, taskId, context, digest) => this.acknowledge(actor, taskId, context, digest, 'agent'),
        reply: (actor, taskId, context, reply) => this.replyAgent(actor, taskId, context, reply),
        decide: (actor, taskId, context, decision) => this.decideAgent(actor, taskId, context, decision) };
    }
    this.legacyAdapters = [...this.reads.adapters, ...(this.literals ? [this.literals.adapter] : []), ...(this.drafts?.adapters ?? []),
      ...(this.directReads ? [this.directReads.adapter] : []), ...(this.computer ? [this.computer.adapter] : []),
      ...(this.computerActions ? [this.computerActions.adapter] : [])];
    this.adapters = [...this.legacyAdapters, ...(this.agent?.adapters ?? [])];
  }
  attach(scheduler: AstraWorkScheduler): this {
    this.reads.attach(scheduler); this.literals?.attach(scheduler); this.drafts?.attach(scheduler); this.directReads?.attach(scheduler);
    this.computer?.attach(scheduler); this.computerActions?.attach(scheduler); this.agent?.attach(scheduler); this.scheduler = scheduler;
    this.host ??= new AstraApplicationTaskHost(scheduler, { drain: () => this.progress(),
      recoveryCandidates: () => this.recoveryCandidates(), reconcile: taskId => this.reconcileTask(taskId),
      retire: (candidate, failure) => this.retireStrandedJob(candidate, failure),
      nextWakeAt: () => this.nextTaskDeadline(),
      stalled: (issue, failure) => this.reportStalledHost(issue, failure) }); return this;
  }
  start(): void { this.taskHost.start(); }
  startWithSourceRestore(restore: () => Promise<void>): Promise<void> { return this.taskHost.startWithSourceRestore(restore); }
  stop(): Promise<{ unresolvedWork: number }> {
    if (this.stopping) return this.stopping;
    this.stopping = this.taskHost.stop().finally(() => { this.agentCatalogKey?.fill(0); });
    return this.stopping;
  }
  hostStatus(): ReturnType<AstraApplicationTaskHost['status']> { return this.taskHost.status(); }
  /** The earliest deadline among tasks that have not settled.
   *
   * A task whose job is left `indeterminate` keeps its declared resources on
   * purpose — nobody can say whether the native worker stopped — and its way
   * out is this deadline, which the host has to be awake to notice. */
  private nextTaskDeadline(): number | undefined {
    const deadlines = (this.agent?.list() ?? [])
      .filter(task => !['completed', 'failed', 'cancelled', 'blocked', 'partial'].includes(task.status))
      .map(task => task.deadline)
      .filter((deadline): deadline is number => Number.isFinite(deadline));
    return deadlines.length ? Math.min(...deadlines) : undefined;
  }

  /** A job the host has given up reconciling has to end, not just leave the
   * host's candidate set. Until it settles, the task above it has no outcome:
   * the person sees a turn that never finishes and a Stop that does nothing,
   * which is exactly what was reported. The job settles as blocked — the host
   * giving up says nothing about what the native worker did — and the ordinary
   * projection carries that into the task and the Turn.
   *
   * The host calls this inside its own pass and drains afterwards, so this must
   * not drive the scheduler itself. */
  private async retireStrandedJob(candidate: AstraTaskRecoveryCandidate,
    failure: AstraTaskHostFailure): Promise<void> {
    if (!this.scheduler) return;
    this.scheduler.abandon(candidate.jobId, 'agent-runtime-host-retired');
    console.error(JSON.stringify({ diagnostic: 'astra-task-host-retired-job',
      taskId: candidate.taskId, jobId: candidate.jobId,
      code: failure.code, message: failure.message }));
  }

  /** A stalled executor strands every task it had admitted. Nothing downstream
   * can tell that apart from slow work, so say it once, out loud, with the
   * cause and the tasks it affects. */
  private reportStalledHost(issue: AstraTaskHostIssue, failure: AstraTaskHostFailure | undefined): void {
    // Matches nextTaskDeadline's terminal set. `blocked`/`partial` are
    // outcomes, not stalls - omitting them here left every already-settled
    // task from earlier in the process lifetime in every later diagnostic,
    // overstating how much was actually stuck.
    const stranded = (this.agent?.list() ?? [])
      .filter(task => !['completed', 'failed', 'cancelled', 'blocked', 'partial'].includes(task.status))
      .map(task => task.taskId);
    console.error(JSON.stringify({ diagnostic: 'astra-task-host-stalled', issue,
      ...(failure ? { code: failure.code, message: failure.message } : {}),
      strandedTaskIds: stranded.slice(0, 16), holding: this.holdingJobs() }));
  }

  /** What is actually occupying the executor when it stalls.
   *
   * Naming the stranded tasks said who was waiting but never who was holding
   * the resources they waited for, and with a single model slot one unsettled
   * job of any kind keeps every later task queued. The deadline is included
   * because that is what eventually releases it. */
  private holdingJobs(): { id: string; state: string; modelSlots: number; deadline: string }[] {
    try {
      return (this.scheduler?.list() ?? [])
        .filter(job => !['observed', 'partial', 'failed', 'cancelled', 'blocked'].includes(job.state))
        .slice(0, 16)
        .map(job => ({ id: job.id, state: job.state, modelSlots: job.resources.modelSlots,
          deadline: new Date(job.deadline).toISOString() }));
    } catch { return []; }
  }
  private get taskHost(): AstraApplicationTaskHost { check(this.host, 503, 'astra-host-not-attached'); return this.host; }
  async drain(): Promise<void> { await this.taskHost.drain(); }

  /** Host-only bridge from an acknowledged observation task to a proposed
   * action. It returns exact native evidence to the main process, never HTTP or
   * renderer code, and does not create a plan or grant input by itself. */
  computerActionSeed(actor: AstraAuthenticatedHttpActor, conversationId: string, taskId: string): AstraComputerActionPlanSeed {
    this.actor(actor); check(modelReadIdentity(conversationId) && modelReadIdentity(taskId) && this.computerTasks, 404, 'astra-computer-observation-not-found');
    const view = this.computerTasks.list(actor, conversationId).find(item => item.id === taskId);
    check(view?.status === 'observed' && view.observation && view.message?.delivery === 'acknowledged', 409, 'astra-computer-observation-not-ready');
    const source = this.owned(actor, taskId, { conversationId, inputMessageId: view.inputMessageId }, 'computer-observe');
    const snapshot = structuredClone(this.options.computerCatalog!.resolve(source.request.selectionId, this.context(actor, source.request)));
    check(snapshot.actor.source === 'desktop' && snapshot.conversationId === conversationId
      && snapshot.windowRef === view.observation.windowRef && snapshot.processId === view.observation.processId
      && snapshot.processInstanceId === view.observation.processInstanceId && snapshot.title === view.observation.title, 409, 'astra-computer-observation-binding');
    return { source: snapshot, observation: structuredClone(view.observation) };
  }

  submit(actor: AstraAuthenticatedHttpActor, request: AstraTaskHttpRequest, operation: Operation = 'read',
    initialEvidence?: AstraAgentInitialEvidenceItem[]): AstraTaskHttpTask {
    check((request.attachmentIds?.length ?? 0) === (initialEvidence?.length ?? 0)
      && (initialEvidence === undefined || operation === 'agent' && isAstraAgentInitialEvidence(initialEvidence)),
    400, 'astra-agent-attachment-evidence-mismatch');
    return this.submitOwned(actor, request, operation, undefined, undefined, initialEvidence);
  }
  /** In-process only. HTTP request fields cannot supply recalled content. */
  submitWithLocalRecall(actor: AstraAuthenticatedHttpActor, request: AstraTaskHttpRequest, snapshot: AstraMemoryRecallSnapshot,
    policyRevision: string): AstraTaskHttpTask {
    check(actor.source === 'desktop' && request.goal?.kind === 'analyze' && request.goal.modelMode === 'local'
      && !this.options.requiredModelMode && this.options.memory?.destination === 'local-desktop'
      && !!this.options.memory.readValidity && !!snapshot.validityToken, 403, 'astra-memory-scope');
    validateAstraMemoryQuery(snapshot, request.text);
    check(this.options.memoryPolicyCurrent?.(policyRevision) === true, 409, 'astra-memory-policy-stale');
    return this.submitOwned(actor, request, 'read', snapshot, policyRevision);
  }
  private submitOwned(actor: AstraAuthenticatedHttpActor, request: AstraTaskHttpRequest, operation: Operation,
    memoryRecall?: AstraMemoryRecallSnapshot, memoryPolicyRevision?: string,
    initialEvidence?: AstraAgentInitialEvidenceItem[]): AstraTaskHttpTask {
    if (memoryRecall) check(typeof memoryPolicyRevision === 'string', 409, 'astra-memory-policy-stale');
    this.actor(actor); this.request(request, operation); this.enabled(operation); this.taskHost.requireOwner();
    if (operation === 'agent') {
      check((actor.source === 'coder') === Boolean(request.executionProfile), 400, 'astra-agent-execution-profile');
      check((actor.source === 'telegram') === Boolean(request.telegramActor), 400, 'astra-agent-telegram-actor');
      const localChoice: AstraLocalAgentModelChoice | undefined = request.goal?.kind === 'agent'
        && request.goal.modelMode === 'local' ? request.goal.modelChoice as AstraLocalAgentModelChoice | undefined : undefined;
      const exactCoderMax = request.goal?.kind === 'agent' && request.goal.modelMode === 'max'
        && request.goal.modelChoice !== undefined;
      const configuredLocalChoices = Object.keys(this.options.genericAgent?.localPolicies ?? {}) as AstraLocalAgentModelChoice[];
      check(actor.source === 'coder'
        ? exactCoderMax || astraAgentLocalModelChoiceAllowed(actor.source, localChoice, configuredLocalChoices)
        : astraAgentLocalModelChoiceAllowed(actor.source, localChoice, configuredLocalChoices),
      400, 'astra-agent-local-model-choice');
    }
    const sourceId = 'app_source_' + short(actor.id + '/' + request.clientRequestId), requestDigest = this.requestDigest(actor, request, operation);
    const previous = this.journal.read(sourceId);
    if (previous) {
      const stored = previous.checkpoint as unknown as SourceRecord;
      const source = this.source({ interactionId: sourceId, messageId: stored.request.inputMessageId });
      check(source.requestDigest === requestDigest && this.operation(source) === operation, 409, 'astra-request-conflict');
      const view = this.read(actor, source.taskId, request, operation); this.taskHost.signal(); return view;
    }
    const messageRef = 'app_message_' + short(actor.id + '/' + request.conversationId + '/' + request.inputMessageId);
    check(!this.journal.read(messageRef), 409, 'astra-message-already-bound');
    const family = operation === 'agent' ? 'generic-agent' : operation === 'computer-observe' ? 'computer-observe' : operation === 'computer-action' ? 'computer-action'
      : operation === 'create' ? this.createFamily(request, actor)
        : this.directReads ? this.readFamily(request) : undefined;
    const record: SourceRecord = { schemaVersion: 'monarch.astra-v3-http-source.internal.v1', sourceId,
      taskId: this.taskId(sourceId, family), scopeId: this.options.scopeId, actor: structuredClone(actor),
      request: structuredClone(request), requestDigest, ...(family ? { family } : {}),
      ...(operation === 'create' && actor.source === 'desktop' && this.options.desktopCreateConfirmation === 'kernel'
        ? { createConfirmationPolicy: 'kernel' as const } : {}),
      ...(memoryRecall ? { memoryRecall: structuredClone(memoryRecall), memoryPolicyRevision: memoryPolicyRevision! } : {}) };
    this.pending.set(sourceId, record);
    try {
      const command = { requestId: sourceId, source: { interactionId: sourceId, messageId: request.inputMessageId } };
      const admission = { records: [
        { streamId: sourceId, checkpoint: json(record), events: [{ type: 'application.source-admitted', requestDigest }] },
        { streamId: messageRef, checkpoint: { sourceId, taskId: record.taskId, requestDigest }, events: [{ type: 'application.message-bound' }] },
      ] };
      const interactiveDeadlineMs = interactiveAgentDeadlineMs(request.specification, Boolean(request.executionProfile));
      if (family === 'generic-agent') this.agent!.submit({ requestId: sourceId,
        ...(interactiveDeadlineMs !== undefined ? { finishWithinMs: interactiveDeadlineMs } : {}),
        source: {
        interactionId: sourceId, messageId: request.inputMessageId, revision: 1,
        userText: request.text, surface: actor.source, ...(request.history?.length ? { history: request.history } : {}),
        ...(initialEvidence?.length ? { initialEvidence } : {}),
        ...(request.executionProfile ? { executionProfile: request.executionProfile } : {}),
        ...(request.specification ? { specification: request.specification } : {}),
      } }, admission);
      else if (family === 'computer-observe') this.computer!.submit(command, admission);
      else if (family === 'computer-action') this.computerActions!.submit(command, admission);
      else if (family === 'literal-create') this.literals!.submit(command, [], admission);
      else if (family === 'direct-read') this.directReads!.submit(command, admission);
      else if (family === 'model-read') this.reads.submit(command, admission);
      else if (family) this.drafts!.submit(command, admission);
      else this.reads.submit(command, admission);
    } finally { this.pending.delete(sourceId); }
    const view = this.read(actor, record.taskId, request, operation); this.taskHost.signal(); return view;
  }
  /** Exact read-only source lookup, including the admission-before-Turn-link gap.
   * Does not select targets, acquire an owner, signal work or create a task. */
  findRequest(actor: AstraAuthenticatedHttpActor, request: AstraTaskHttpRequest, operation: Operation = 'read'): AstraTaskHttpTask | null {
    this.actor(actor); this.enabled(operation); this.request(request, operation);
    const sourceId = 'app_source_' + short(actor.id + '/' + request.clientRequestId), previous = this.journal.read(sourceId);
    if (!previous) return null;
    const stored = previous.checkpoint as unknown as SourceRecord;
    const source = this.source({ interactionId: sourceId, messageId: stored.request.inputMessageId });
    check(source.requestDigest === this.requestDigest(actor, request, operation) && this.operation(source) === operation, 409, 'astra-request-conflict');
    return this.read(actor, source.taskId, request, operation);
  }
  read(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, operation: Operation = 'read'): AstraTaskHttpTask {
    const source = this.owned(actor, taskId, context, operation), host = this.taskHost.status();
    if (source.family === 'generic-agent') return this.agentHttpTask(source,
      host.phase !== 'running' ? 'host-unavailable' : host.issue);
    const view = this.taskView(source);
    const issue = host.phase !== 'running' ? 'host-unavailable' : host.issue;
    const result: AstraTaskHttpTask = { id: taskId, conversationId: source.request.conversationId,
      inputMessageId: source.request.inputMessageId, source: source.actor.source, privacyMode: 'persistent', status: view.status,
      nativeCompletionCertified: false, modelJobs: 'modelJobs' in view ? view.modelJobs : 0, readJobs: 'readJobs' in view ? view.readJobs : source.family === 'direct-read' ? 1 : 0,
      ...(this.operation(source) === 'create' ? { createJobs: 'createJobs' in view ? view.createJobs : 1 } : {}), ...(issue && !view.message ? { runtimeIssue: issue } : {}) };
    if ('inputJobs' in view && view.inputJobs) result.inputJobs = view.inputJobs;
    if ('computerJobs' in view) { result.computerJobs = view.computerJobs; if ('observation' in view && view.observation) result.observation = view.observation; }
    if ('approval' in view && view.approval) result.approval = { ...view.approval, conversationId: source.request.conversationId,
      predecessorMessageId: 'predecessorMessageId' in view.approval ? view.approval.predecessorMessageId : source.request.inputMessageId };
    if (view.message) result.message = { id: view.message.id, taskId, conversationId: source.request.conversationId,
      predecessorMessageId: source.family ? view.message.predecessorMessageId : source.request.inputMessageId,
      content: this.presentMessage(source, view.message.content), certificateDigest: view.message.certificateDigest,
      delivery: view.message.delivery, nativeCompletionCertified: false,
      verification: source.family === 'computer-observe' ? 'internal-computer-observation-proof' : source.family === 'computer-action' ? 'internal-computer-action-proof' : source.family === 'literal-create' ? 'internal-create-certificate' : source.family === 'input-create' ? 'internal-input-create-certificate'
        : source.family === 'model-create' ? 'internal-model-create-certificate' : 'internal-read-certificate' };
    if ('question' in view && view.question) result.question = { id: view.question.id, digest: view.question.digest, text: view.question.text,
      conversationId: source.request.conversationId, predecessorMessageId: view.question.predecessorMessageId,
      expiresAt: view.question.expiresAt, authority: 'none', nativeCompletionCertified: false,
      ...('origin' in view.question ? { origin: view.question.origin } : {}),
      ...('inputKind' in view.question && view.question.inputKind ? { inputKind: view.question.inputKind, maxUtf8Bytes: view.question.maxUtf8Bytes } : {}) };
    return result;
  }
  reply(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, reply: AstraDraftReply): AstraTaskHttpTask {
    const source = this.owned(actor, taskId, context, 'create'); this.taskHost.requireOwner();
    check(source.family === 'model-create' || source.family === 'input-create', 409, 'astra-task-not-awaiting-reply');
    try { validateDraftReply(reply, source.family === 'input-create' ? 'literal-content' : 'draft-guidance'); }
    catch { throw new AstraTaskHttpError(400, 'astra-invalid-reply'); }
    const messageRef = 'app_message_' + short(actor.id + '/' + source.request.conversationId + '/' + reply.messageId);
    const fact = { taskId, replyDigest: modelReadDigest(reply) }, previous = this.journal.read(messageRef);
    check(!previous || modelReadDigest(previous.checkpoint) === modelReadDigest(fact), 409, 'astra-message-already-bound');
    try { this.drafts!.reply(taskId, reply, { records: [{ streamId: messageRef, checkpoint: fact, events: [{ type: 'application.reply-bound' }] }] }); }
    catch (error) {
      if (error instanceof Error && /:draft-(?:not-awaiting-reply|reply-binding|reply-conflict|clarification-budget)$/u.test(error.message))
        throw new AstraTaskHttpError(409, 'astra-reply-conflict');
      throw error;
    }
    const view = this.read(actor, taskId, context, 'create'); this.taskHost.signal(); return view;
  }
  decide(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, decision: AstraCreateApprovalDecision): AstraTaskHttpTask {
    const source = this.owned(actor, taskId, context, 'create'); this.taskHost.requireOwner();
    check(source.family === 'literal-create' ? this.options.literalApprovals
      : (source.family === 'model-create' || source.family === 'input-create') && this.options.compositeApprovals, 409, 'astra-approval-unsupported');
    try { validateCreateApprovalDecision(decision); } catch { throw new AstraTaskHttpError(400, 'astra-invalid-approval-decision'); }
    const messageRef = 'app_message_' + short(actor.id + '/' + source.request.conversationId + '/' + decision.messageId);
    const fact = { taskId, approvalDecisionDigest: createApprovalDigest(decision) }, previous = this.journal.read(messageRef);
    check(!previous || modelReadDigest(previous.checkpoint) === modelReadDigest(fact), 409, 'astra-message-already-bound');
    try { (source.family === 'literal-create' ? this.literals! : this.drafts!).decide(taskId, decision,
      { records: [{ streamId: messageRef, checkpoint: fact, events: [{ type: 'application.approval-bound' }] }] }); }
    catch (error) {
      if (error instanceof Error && /^(?:astra-create-(?:task:approval-|approval:)|astra-model-read-task:draft-approval-)/u.test(error.message))
        throw new AstraTaskHttpError(409, 'astra-approval-conflict');
      throw error;
    }
    const view = this.read(actor, taskId, context, 'create'); this.taskHost.signal(); return view;
  }
  private decideComputer(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, decision: AstraCreateApprovalDecision): AstraTaskHttpTask {
    const source = this.owned(actor, taskId, context, 'computer-action'); this.taskHost.requireOwner();
    try { validateCreateApprovalDecision(decision); } catch { throw new AstraTaskHttpError(400, 'astra-invalid-approval-decision'); }
    const messageRef = 'app_message_' + short(actor.id + '/' + source.request.conversationId + '/' + decision.messageId);
    const fact = { taskId, approvalDecisionDigest: createApprovalDigest(decision) }, previous = this.journal.read(messageRef);
    check(!previous || modelReadDigest(previous.checkpoint) === modelReadDigest(fact), 409, 'astra-message-already-bound');
    try { this.computerActions!.decide(taskId, decision, { records: [{ streamId: messageRef, checkpoint: fact,
      events: [{ type: 'application.computer-action-approval-bound' }] }] }); }
    catch (error) { if (error instanceof Error && /^astra-computer-action(?:-task)?:/u.test(error.message))
      throw new AstraTaskHttpError(409, 'astra-approval-conflict'); throw error; }
    const view = this.read(actor, taskId, context, 'computer-action'); this.taskHost.signal(); return view;
  }
  private decideAgent(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext,
    decision: AstraCreateApprovalDecision): AstraTaskHttpTask {
    this.owned(actor, taskId, context, 'agent'); this.taskHost.requireOwner();
    try { validateCreateApprovalDecision(decision); this.agent!.decide(taskId, decision); }
    catch (error) {
      if (error instanceof Error && /^(?:astra-agent-task|astra-capability-work|astra-create-approval):/u.test(error.message))
        throw new AstraTaskHttpError(409, 'astra-approval-conflict');
      throw error;
    }
    const view = this.read(actor, taskId, context, 'agent'); this.taskHost.signal(); return view;
  }
  private replyAgent(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext,
    reply: AstraDraftReply): AstraTaskHttpTask {
    this.owned(actor, taskId, context, 'agent'); this.taskHost.requireOwner();
    try { validateDraftReply(reply, 'draft-guidance'); this.agent!.reply(taskId, reply); }
    catch (error) {
      if (error instanceof Error && /^(?:astra-agent-task|astra-model-create):/u.test(error.message))
        throw new AstraTaskHttpError(409, 'astra-reply-conflict');
      throw error;
    }
    const view = this.read(actor, taskId, context, 'agent'); this.taskHost.signal(); return view;
  }
  list(actor: AstraAuthenticatedHttpActor, conversationId: string, operation: Operation = 'read'): AstraTaskHttpTask[] {
    this.actor(actor); this.enabled(operation); check(modelReadIdentity(conversationId), 400, 'astra-invalid-source-context');
    const views = operation === 'agent' ? this.agent!.list() : operation === 'computer-observe' ? this.computer!.list() : operation === 'computer-action' ? this.computerActions!.list()
      : operation === 'read' ? [...this.reads.list(), ...(this.directReads?.list() ?? [])] : [...this.literals!.list(), ...this.drafts!.list()];
    const result: AstraTaskHttpTask[] = [];
    for (const task of views) {
      const source = this.taskSource(task.taskId);
      if (source.actor.id === actor.id && source.actor.source === actor.source && source.request.conversationId === conversationId)
        result.push(this.read(actor, task.taskId, source.request, operation));
    }
    return result;
  }
  command(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, command: 'pause' | 'resume' | 'cancel', operation: Operation = 'read'): AstraTaskHttpTask {
    const source = this.owned(actor, taskId, context, operation); this.taskHost.requireOwner();
    if (source.family === 'generic-agent') this.agent!.command(taskId, command);
    else this.profile(source).command(taskId, command);
    const view = this.read(actor, taskId, context, operation); this.taskHost.signal(); return view;
  }
  async reconcile(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, operation: Operation = 'read'): Promise<AstraTaskHttpTask> {
    this.owned(actor, taskId, context, operation); this.taskHost.requireOwner(); await this.reconcileTask(taskId);
    const view = this.read(actor, taskId, context, operation); this.taskHost.signal(); return view;
  }
  wake(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, operation: Operation = 'read'): void {
    this.owned(actor, taskId, context, operation); this.taskHost.requireOwner(); this.taskHost.signal();
  }
  acknowledge(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, certificateDigest: string, operation: Operation = 'read'): AstraTaskHttpTask {
    const source = this.owned(actor, taskId, context, operation); check(/^sha256:[a-f0-9]{64}$/u.test(certificateDigest), 400, 'astra-invalid-certificate-digest');
    if (source.family === 'generic-agent') {
      const view = this.agentHttpTask(source); check(view.message?.certificateDigest === certificateDigest, 409, 'astra-message-ack-conflict');
      const agentView = this.agent!.read(taskId);
      if (!agentView.message) return view; // Retained v1 archives were already projected as delivered.
      this.taskHost.requireOwner(); this.agent!.acknowledgeMessage(taskId, certificateDigest);
      return this.read(actor, taskId, context, operation);
    }
    check(this.taskView(source).message?.certificateDigest === certificateDigest, 409, 'astra-message-ack-conflict');
    this.taskHost.requireOwner(); this.profile(source).acknowledgeMessage(taskId, certificateDigest); return this.read(actor, taskId, context, operation);
  }
  /** Host-owned source revocation wakes the SAME bounded progression owner.
   * It grants no work and cannot bypass the cross-Store startup barrier. */
  notifySourceChange(): void { this.taskHost.signal(); }
  private profile(source: SourceRecord) { check(source.family !== 'generic-agent', 404, 'astra-selection-family');
    return source.family === 'computer-observe' ? this.computer! : source.family === 'computer-action' ? this.computerActions!
    : source.family === 'direct-read' ? this.directReads! : source.family === 'model-read' ? this.reads
      : source.family === 'literal-create' ? this.literals! : source.family ? this.drafts! : this.reads; }
  private taskView(source: SourceRecord) { return this.profile(source).read(source.taskId); }
  private agentHttpTask(source: SourceRecord, issue?: AstraTaskHostIssue): AstraTaskHttpTask {
    const view = this.agent!.read(source.taskId), artifacts = projectAstraAgentFileArtifacts(view.activities), result: AstraTaskHttpTask = { id: source.taskId,
      conversationId: source.request.conversationId, inputMessageId: source.request.inputMessageId,
      source: source.actor.source, privacyMode: 'persistent', status: view.status,
      nativeCompletionCertified: view.nativeCompletionCertified,
      ...(view.certificate ? { completionEvidence: astraCompletionEvidence(view.certificate) } : {}),
      modelJobs: view.modelTurns, readJobs: 0, capabilityJobs: view.capabilityCalls,
      ...(view.activities.length ? { activities: structuredClone(view.activities) } : {}),
      ...(artifacts.length ? { artifacts } : {}),
      ...(view.stopReason && /^[a-z0-9:-]{1,96}$/u.test(view.stopReason) ? { failureReason: view.stopReason } : {}),
      ...(issue && !view.responseText ? { runtimeIssue: issue } : {}) };
    if (view.message) {
      result.message = { id: view.message.id, taskId: source.taskId,
        conversationId: source.request.conversationId, predecessorMessageId: view.message.predecessorMessageId,
        content: view.message.content, certificateDigest: view.message.certificateDigest, delivery: view.message.delivery,
        verification: view.nativeCompletionCertified ? 'native-agent-completion-certificate' : 'internal-agent-receipt',
        nativeCompletionCertified: view.nativeCompletionCertified };
    } else if (view.responseText) {
      // Compatibility projection for terminal v1 archives created before the
      // durable generic message stream existed.
      const certificateDigest = modelReadDigest({ taskId: source.taskId, responseText: view.responseText,
        modelTurns: view.modelTurns, capabilityCalls: view.capabilityCalls, status: view.status });
      result.message = { id: 'agent_message_' + short(source.taskId), taskId: source.taskId,
        conversationId: source.request.conversationId, predecessorMessageId: source.request.inputMessageId,
        content: view.responseText, certificateDigest, delivery: 'acknowledged',
        verification: 'internal-agent-receipt', nativeCompletionCertified: false };
    }
    if (view.question) {
      result.question = { id: view.questionId!, digest: view.questionDigest!, text: view.question,
        conversationId: source.request.conversationId, predecessorMessageId: view.predecessorMessageId,
        expiresAt: view.deadline, authority: 'none', nativeCompletionCertified: false };
    }
    if (view.approval) result.approval = { ...view.approval, conversationId: source.request.conversationId,
      predecessorMessageId: source.request.inputMessageId } as NonNullable<AstraTaskHttpTask['approval']>;
    return result;
  }
  private presentMessage(source: SourceRecord, summary: string): string {
    if (source.family !== 'direct-read') return summary;
    const view = this.directReads!.read(source.taskId);
    const observations = (view.certificate?.requirements ?? [])
      .filter(requirement => requirement.state === 'satisfied')
      .map(requirement => this.directReads!.readContent(source.taskId, requirement.id));
    return renderAstraCertifiedReadPresentation(summary, observations);
  }
  private async progress(): Promise<void> {
    const pass = new Map<string, Set<string>>();
    const policy = (family: string, settle?: (taskId: string, reason: string) => unknown) =>
      this.taskFaults.policy(family, pass, settle);
    const familyTrace = process.env.MONARCH_AGENT_TIMING === '1';
    const family = (label: string, run: () => unknown) => {
      if (!familyTrace) { run(); return; }
      const started = Date.now(); run(); const ms = Date.now() - started;
      if (ms >= 100) console.error(JSON.stringify({ diagnostic: 'astra-progress-timing', label: 'family:' + label, ms, at: started }));
    };
    const synchronize = () => { family('model-read', () => this.reads.synchronizeAll(policy('model-read')));
      family('model-create', () => this.drafts?.synchronizeAll(policy('model-create')));
      family('create', () => this.literals?.synchronizeAll(policy('create')));
      family('read', () => this.directReads?.synchronizeAll(policy('read')));
      family('computer-observe', () => this.computer?.synchronizeAll(policy('computer-observe')));
      family('computer-action', () => this.computerActions?.synchronizeAll(policy('computer-action')));
      family('agent', () => this.agent?.synchronizeAll(policy('agent', (taskId, reason) => this.agent!.settleFault(taskId, reason)))); };
    const fingerprint = () => modelReadDigest(this.scheduler!.list().map(job => ({ id: job.id, state: job.state, epoch: job.controlEpoch,
      activation: job.activationGeneration, revision: job.result?.checkpointRevision ?? 0 })));
    // Opt-in latency trace (MONARCH_AGENT_TIMING=1): where a progression pass spends its time.
    const trace = process.env.MONARCH_AGENT_TIMING === '1';
    const timed = <T>(label: string, run: () => T): T => {
      if (!trace) return run();
      const started = Date.now(), value = run(), ms = Date.now() - started;
      if (ms >= 200) console.error(JSON.stringify({ diagnostic: 'astra-progress-timing', label, ms, at: started }));
      return value;
    };
    for (let pass = 0; pass < 32; pass++) {
      await this.scheduler!.yieldOwnedLease();
      timed('synchronize-before-drain', synchronize); const before = fingerprint();
      const drainStarted = Date.now(); await this.scheduler!.drain();
      if (trace && Date.now() - drainStarted >= 200) console.error(JSON.stringify({ diagnostic: 'astra-progress-timing',
        label: 'scheduler-drain', ms: Date.now() - drainStarted, at: drainStarted }));
      await this.scheduler!.yieldOwnedLease();
      timed('synchronize-after-drain', synchronize); if (fingerprint() === before) { this.unsettledProgressions = 0; return; }
    }
    // 32 changing passes is ~16 agent rounds of real work: a fast MAX agent
    // reached it in five minutes. Throwing here set the host issue, the host
    // then waited for an explicit wake nobody sent, and the live task froze.
    // Yield and continue in a fresh pass; only a run that never settles over
    // many consecutive passes is a livelock worth stopping for.
    if (++this.unsettledProgressions > 16) throw Error('astra-application-progression-budget');
    this.host?.signal();
  }
  private recoveryCandidates(): AstraTaskRecoveryCandidate[] {
    const claimed = this.claimedRecoveryCandidates();
    return [...claimed, ...this.orphanJobCandidates(claimed)];
  }
  private claimedRecoveryCandidates(): AstraTaskRecoveryCandidate[] {
    // Enumerate each durable family by scheduler-owned task id, not through a
    // view projection. A malformed view of one task may be quarantined by its
    // task policy; it must not keep unrelated family recovery from running.
    const pass = new Map<string, Set<string>>();
    const policy = (family: string, settle?: (taskId: string, reason: string) => unknown) =>
      this.taskFaults.policy(family, pass, settle);
    return [...this.reads.recoveryCandidates(policy('model-read')), ...(this.drafts?.recoveryCandidates(policy('model-create')) ?? []),
      ...(this.literals?.recoveryCandidates(policy('create')) ?? []), ...(this.directReads?.recoveryCandidates(policy('read')) ?? []),
      ...(this.computer?.recoveryCandidates(policy('computer-observe')) ?? []),
      ...(this.computerActions?.recoveryCandidates(policy('computer-action')) ?? []),
      ...(this.agent?.recoveryCandidates(policy('agent', (taskId, reason) => this.agent!.settleFault(taskId, reason))) ?? [])];
  }

  /** Jobs still holding resources that no task claims any more.
   *
   * Acquiring the scheduler turns every job left `running` by a previous
   * process into `indeterminate`, which keeps its declared resources on
   * purpose. Recovery candidates, though, are read off the profiles' task
   * lists — so once a task was archived its job became invisible to recovery
   * while still holding a model slot. With a single model slot that is every
   * later agent task queued forever, which is exactly what was reported.
   *
   * Settling one of these claims nothing about any task, because no task owns
   * it. The host retires it on the first attempt: there is nothing left to
   * reconcile it against. */
  private orphanJobCandidates(claimed: AstraTaskRecoveryCandidate[]): AstraTaskRecoveryCandidate[] {
    if (!this.scheduler) return [];
    const known = new Set(claimed.map(candidate => candidate.jobId));
    return this.scheduler.list()
      .filter(job => ['indeterminate', 'pausing', 'cancelling'].includes(job.state) && !known.has(job.id))
      .map(job => ({ taskId: ORPHAN_JOB_TASK_PREFIX + job.id, jobId: job.id }));
  }
  private async reconcileTask(taskId: string): Promise<void> {
    if (taskId.startsWith(ORPHAN_JOB_TASK_PREFIX)) throw Error('astra-scheduler:orphan-job');
    const source = this.taskSource(taskId);
    if (source.family === 'generic-agent') await this.agent!.reconcile(taskId);
    else await this.profile(source).reconcile(taskId);
  }
  private owned(actor: AstraAuthenticatedHttpActor, taskId: string, context: SourceContext, operation: Operation): SourceRecord {
    this.actor(actor); this.enabled(operation); const source = this.taskSource(taskId);
    check(this.operation(source) === operation && source.actor.id === actor.id && source.actor.source === actor.source
      && source.request.conversationId === context.conversationId && source.request.inputMessageId === context.inputMessageId, 404, 'astra-task-not-found'); return source;
  }
  private taskSource(taskId: string): SourceRecord {
    check(modelReadIdentity(taskId), 404, 'astra-task-not-found');
    const parent = this.journal.read(taskId)?.checkpoint as unknown as { schemaVersion: string; taskId: string;
      goal?: { source: AstraReadSourceKey }; source?: AstraCapabilityWorkSource } | undefined;
    check(parent && ['monarch.astra-v3-model-read-task.internal.v1', 'monarch.astra-v3-read-task.internal.v1', 'monarch.astra-v3-model-create-task.internal.v1', 'monarch.astra-v3-create-task.internal.v1', 'monarch.astra-v3-computer-task.internal.v1', 'monarch.astra-v3-computer-action-task.internal.v1', 'monarch.astra-v3-agent-task.internal.v3', 'monarch.astra-v3-agent-task-archive.internal.v1', 'monarch.astra-v3-agent-task-archive.internal.v2']
      .includes(parent.schemaVersion) && parent.taskId === taskId, 404, 'astra-task-not-found');
    const key = ['monarch.astra-v3-agent-task.internal.v3', 'monarch.astra-v3-agent-task-archive.internal.v1', 'monarch.astra-v3-agent-task-archive.internal.v2'].includes(parent.schemaVersion)
      ? { interactionId: parent.source!.interactionId, messageId: parent.source!.messageId } : parent.goal!.source;
    const source = this.source(key); check(source.taskId === taskId, 404, 'astra-task-not-found'); return source;
  }
  private source(key: AstraReadSourceKey): SourceRecord {
    check(modelReadIdentity(key.interactionId) && key.interactionId.startsWith('app_source_'), 404, 'astra-task-not-found');
    const source = this.pending.get(key.interactionId) ?? this.journal.read(key.interactionId)?.checkpoint as unknown as SourceRecord;
    check(source?.schemaVersion === 'monarch.astra-v3-http-source.internal.v1' && source.sourceId === key.interactionId
      && source.scopeId === this.options.scopeId && source.request.inputMessageId === key.messageId
      && (source.family === undefined || ['literal-create', 'model-create', 'input-create', 'direct-read', 'model-read', 'computer-observe', 'computer-action', 'generic-agent'].includes(source.family))
      && (source.createConfirmationPolicy === undefined || source.createConfirmationPolicy === 'kernel'
        && source.actor.source === 'desktop' && this.operation(source) === 'create')
      && source.sourceId === 'app_source_' + short(source.actor.id + '/' + source.request.clientRequestId)
      && source.taskId === this.taskId(source.sourceId, source.family)
      && source.requestDigest === this.requestDigest(source.actor, source.request, this.operation(source)), 404, 'astra-task-not-found'); return source;
  }
  private maxPolicy(goal: AstraSourceGoalInput): AstraModelReadTaskOptions['policy'] {
    const choice = (goal.kind === 'analyze' ? goal.modelChoice ?? 'gpt-oss-120b'
      : goal.kind === 'create' && goal.content.kind === 'draft' ? goal.content.modelChoice ?? 'gpt-oss-120b'
        : goal.kind === 'agent' ? goal.modelChoice ?? 'gpt-oss-120b' : undefined) as AstraMaxModelChoice | undefined;
    check(choice && this.options.maxModelPolicies, 400, 'astra-max-model-choice');
    const preview = goal.kind === 'analyze' ? goal.previewAcknowledged
      : goal.kind === 'create' && goal.content.kind === 'draft' ? goal.content.previewAcknowledged
        : goal.kind === 'agent' ? goal.previewAcknowledged : undefined;
    check(choice !== 'qwen-3.8-27b' || preview === true, 400, 'astra-max-model-preview');
    const policy = this.options.maxModelPolicies[choice]; check(policy, 400, 'astra-max-model-choice');
    return structuredClone(policy);
  }
  private agentPolicy(source: AstraCapabilityWorkSource): AstraAgentTaskPolicy {
    const record = this.agentSource(source), goal = record.request.goal;
    check(goal?.kind === 'agent' && this.options.genericAgent, 404, 'astra-agent-source');
    const configured = goal.modelMode === 'max'
      ? this.options.genericAgent.maxPolicies?.[(goal.modelChoice ?? 'gpt-oss-120b') as AstraMaxModelChoice]
        ?? this.options.genericAgent.dynamicMaxPolicy?.((goal.modelChoice ?? 'gpt-oss-120b') as AstraMaxModelChoice)
      : goal.modelChoice
        ? this.options.genericAgent.localPolicies?.[goal.modelChoice as AstraLocalAgentModelChoice]
        : this.options.genericAgent.policy;
    check(configured, 400, 'astra-agent-model-unavailable');
    return { modelId: configured.modelId, expectedModelDigest: configured.expectedModelDigest,
      maxOutputTokens: configured.maxOutputTokens ?? 2048, modelTimeoutMs: configured.modelTimeoutMs ?? 120_000,
      maxModelAttempts: configured.maxModelAttempts ?? 2, maxModelTurns: configured.maxModelTurns ?? 24,
      maxCapabilityCalls: configured.maxCapabilityCalls ?? 16,
      ...(configured.contextLimits ? { contextLimits: structuredClone(configured.contextLimits) } : {}) };
  }
  private agentCandidates(source: AstraCapabilityWorkSource): AstraAgentCapabilityCandidate[] {
    const record = this.agentSource(source); check(this.agentCatalogKey, 404, 'astra-agent-source');
    return this.options.kernel.listCapabilities().flatMap(capability => {
      const readiness = this.options.kernel.getCapabilityReadiness(capability.id);
      const supported = capability.agent?.supportedSources;
      if (readiness?.status !== 'active' || readiness.moduleId !== capability.moduleId
        || (supported && !supported.includes(source.surface))
        || (source.surface === 'telegram' && !this.telegramCapabilityVisible(record, capability.id))
        || (source.surface === 'coder' && (!capability.id.startsWith('coder.')
          || capability.id.startsWith('coder.projects.')))) return [];
      const handle = 'cap_' + createHmac('sha256', this.agentCatalogKey!)
        .update(source.taskId + '/' + capability.moduleId + '/' + capability.id).digest('hex').slice(0, 48);
      return [{ handle, capabilityId: capability.id, moduleId: capability.moduleId, title: capability.title,
        description: capability.description ?? '', risk: capability.risk,
        inputSchema: source.surface === 'coder' ? this.projectBoundInputSchema(capability.inputSchema, 'projectId')
          : source.surface === 'telegram' ? this.projectBoundInputSchema(capability.inputSchema, 'chatId')
            : capability.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } }];
    });
  }
  private projectBoundInputSchema(schema: AstraAgentCapabilityCandidate['inputSchema'] | undefined,
    property: 'projectId' | 'chatId'): AstraAgentCapabilityCandidate['inputSchema'] {
    const value = structuredClone(schema ?? { type: 'object', properties: {}, additionalProperties: false });
    if (!value.properties || !Object.hasOwn(value.properties, property)) return value;
    delete value.properties[property];
    if (value.required) value.required = value.required.filter(key => key !== property);
    return value;
  }
  private agentCapabilityArgs(capabilityId: string, args: Record<string, AstraJson>, source: AstraCapabilityWorkSource): Record<string, AstraJson> {
    const record = this.agentSource(source), profile = record.request.executionProfile;
    if (source.surface === 'telegram') {
      const actor = record.request.telegramActor;
      check(actor && !Object.hasOwn(args, 'chatId'), 404, 'astra-agent-telegram-binding');
      const schema = this.options.kernel.getCapability(capabilityId)?.inputSchema;
      const bound = schema?.properties && Object.hasOwn(schema.properties, 'chatId')
        ? { ...args, chatId: actor.controlChatId }
        : args;
      const telegram = this.telegramV2();
      check(telegram?.permits(actor.requestId, record.request.conversationId, capabilityId, bound) === true,
        404, 'astra-agent-telegram-binding');
      return bound;
    }
    if (!profile) return args;
    check(source.surface === 'coder' && profile.kind === 'coder-project' && capabilityId.startsWith('coder.')
      && !capabilityId.startsWith('coder.projects.') && !Object.hasOwn(args, 'projectId'), 404, 'astra-agent-project-binding');
    const schema = this.options.kernel.getCapability(capabilityId)?.inputSchema;
    return schema?.properties && Object.hasOwn(schema.properties, 'projectId') ? { ...args, projectId: profile.projectId } : args;
  }
  private agentPermissionProfile(source: AstraCapabilityWorkSource) {
    const profile = this.agentSource(source).request.executionProfile;
    return profile ? structuredClone(profile.permissionProfile) : undefined;
  }
  private agentSource(source: AstraCapabilityWorkSource): SourceRecord {
    const record = this.source({ interactionId: source.interactionId, messageId: source.messageId });
    check(record.family === 'generic-agent' && record.taskId === source.taskId && source.revision === 1
      && source.userText === record.request.text && source.surface === record.actor.source, 404, 'astra-agent-source');
    return record;
  }
  private agentSourceCurrent(source: AstraCapabilityWorkSource): boolean {
    try {
      const record = this.agentSource(source);
      if (source.surface !== 'telegram') return true;
      const actor = record.request.telegramActor, telegram = this.telegramV2();
      return Boolean(actor && telegram?.permits(actor.requestId, record.request.conversationId,
        'telegram.capabilities.describe', {}) === true);
    } catch { return false; }
  }

  private telegramCapabilityVisible(record: SourceRecord, capabilityId: string): boolean {
    const actor = record.request.telegramActor, telegram = this.telegramV2();
    if (!actor || !telegram) return false;
    if (['telegram.capabilities.describe', 'telegram.reminder.create', 'telegram.reminder.list',
      'telegram.reminder.cancel', 'telegram.poll.send'].includes(capabilityId)) return true;
    const request = telegram.request(actor.requestId), grant = telegram.activeGrant();
    return Boolean(request && grant && request.grantId === grant.id && grant.capabilities.includes(capabilityId));
  }

  private telegramV2(): TelegramV2AgentGate | undefined {
    return (this.options.kernel.getModule('telegram') as { v2?: TelegramV2AgentGate } | undefined)?.v2;
  }
  private createModelPolicy(key: AstraReadSourceKey): AstraModelReadTaskOptions['policy'] {
    const source = this.source(key), goal = source.request.goal;
    if (goal?.kind !== 'create' || goal.content.kind !== 'draft') return structuredClone(this.options.createPolicy ?? this.options.policy);
    if (goal.content.modelMode === undefined && this.options.optionalMax) return structuredClone(this.options.createPolicy ?? this.options.policy);
    check(goal.content.modelMode === 'max', 400, 'astra-max-model-choice'); return this.maxPolicy(goal);
  }
  private readModelPolicy(key: AstraReadSourceKey): AstraModelReadTaskOptions['policy'] {
    const source = this.source(key), goal = source.request.goal;
    if (goal?.kind !== 'analyze') return structuredClone(this.options.policy);
    if (goal.modelMode === 'local' && this.options.optionalMax) return structuredClone(this.options.policy);
    check(goal.modelMode === 'max', 400, 'astra-max-model-choice'); return this.maxPolicy(goal);
  }
  private readSelection(key: AstraReadSourceKey) {
    const source = this.source(key); check(!source.family || source.family === 'direct-read' || source.family === 'model-read', 404, 'astra-selection-family');
    const context = this.context(source.actor, source.request);
    const selected = this.options.sourceCompiler ? this.options.sourceCompiler.read(source.request.selectionId, context)
      : this.options.catalog!.resolve(source.request.selectionId, context);
    if (source.memoryRecall) {
      check(source.actor.source === 'desktop' && source.family === 'model-read' && source.request.goal?.kind === 'analyze'
        && source.request.goal.modelMode === 'local' && !this.options.requiredModelMode, 403, 'astra-memory-scope');
      validateAstraMemoryQuery(source.memoryRecall, source.request.text);
      check(typeof source.memoryPolicyRevision === 'string'
        && this.options.memoryPolicyCurrent?.(source.memoryPolicyRevision) === true, 409, 'astra-memory-policy-stale');
    }
    return { ...structuredClone(selected), userText: source.request.text,
      ...(source.memoryRecall ? { memoryRecall: structuredClone(source.memoryRecall) } : {}),
      digest: modelReadDigest({ source: source.requestDigest, selection: selected,
        ...(source.memoryRecall ? { memoryDigest: source.memoryRecall.sourceDigest, memoryPolicyRevision: source.memoryPolicyRevision } : {}) }) };
  }
  private createSelection(key: AstraReadSourceKey, family: CreateFamily) {
    const source = this.source(key); check(source.family === family && (this.options.createCatalog || this.options.sourceCompiler), 404, 'astra-selection-family');
    const candidate = this.createCatalogSelection(source.request, source.actor);
    check(candidate?.kind === (family === 'literal-create' ? 'literal' : family === 'input-create' ? 'literal-input' : 'draft'), 409, 'astra-selection-family');
    check(candidate.kind === 'literal' || (candidate.kind === 'literal-input'
      ? candidate.requiredInput?.kind === 'literal-content' : candidate.requiredInput?.kind !== 'literal-content'), 409, 'astra-selection-input-kind');
    const { kind: _kind, ...selected } = candidate;
    return { ...structuredClone(selected),
      ...(family === 'literal-create' && this.options.literalApprovals && source.createConfirmationPolicy !== 'kernel'
        ? { requireExactConfirmation: true as const } : {}),
      ...(family !== 'literal-create' && source.createConfirmationPolicy === 'kernel' ? { confirmationPolicy: 'kernel' as const } : {}),
      userText: source.request.text, digest: modelReadDigest({ source: source.requestDigest, selection: candidate,
        ...(source.createConfirmationPolicy ? { confirmationPolicy: source.createConfirmationPolicy } : {}) }) };
  }
  private composedCreateSelection(key: AstraReadSourceKey): AstraModelCreateSelection {
    const family = this.source(key).family;
    check(family === 'model-create' || family === 'input-create', 404, 'astra-selection-family');
    return this.createSelection(key, family) as AstraModelCreateSelection;
  }
  private computerSelection(key: AstraReadSourceKey): AstraComputerTaskSelection {
    const source = this.source(key); check(source.family === 'computer-observe' && this.options.computerCatalog, 404, 'astra-selection-family');
    const context = this.context(source.actor, source.request), snapshot = structuredClone(this.options.computerCatalog.resolve(source.request.selectionId, context));
    check(snapshot && snapshot.selectionId === source.request.selectionId && modelReadDigest(snapshot.actor) === modelReadDigest(source.actor)
      && snapshot.conversationId === source.request.conversationId && Object.keys(snapshot).length === 10
      && Object.keys(snapshot).every(key => ['selectionId', 'actor', 'conversationId', 'revision', 'windowRef', 'processId', 'processInstanceId', 'title', 'expiresAt', 'timeoutMs'].includes(key)), 404, 'astra-window-selection-not-found');
    return { revision: snapshot.revision, digest: modelReadDigest({ source: source.requestDigest, snapshot }), timeoutMs: snapshot.timeoutMs,
      selection: { id: snapshot.selectionId, windowRef: snapshot.windowRef, processId: snapshot.processId,
        processInstanceId: snapshot.processInstanceId, title: snapshot.title, expiresAt: snapshot.expiresAt,
        source: { conversationId: source.request.conversationId, inputMessageId: source.request.inputMessageId, userText: source.request.text } } };
  }
  private computerActionSelection(key: AstraReadSourceKey): AstraComputerActionTaskSelection {
    const source = this.source(key); check(source.family === 'computer-action' && this.options.computerActionCatalog, 404, 'astra-selection-family');
    const context = this.context(source.actor, source.request), snapshot = structuredClone(this.options.computerActionCatalog.resolve(source.request.selectionId, context));
    check(snapshot && snapshot.selectionId === source.request.selectionId && modelReadDigest(snapshot.actor) === modelReadDigest(source.actor)
      && snapshot.conversationId === source.request.conversationId && Object.keys(snapshot).length === 12
      && Object.keys(snapshot).every(name => ['selectionId', 'actor', 'conversationId', 'revision', 'windowRef', 'processId', 'title', 'expiresAt',
        'processInstanceId', 'timeoutMs', 'observation', 'action'].includes(name)), 404, 'astra-computer-action-plan-not-found');
    const selection = { id: snapshot.selectionId, windowRef: snapshot.windowRef, processId: snapshot.processId,
      processInstanceId: snapshot.processInstanceId, title: snapshot.title,
      expiresAt: snapshot.expiresAt, source: { conversationId: source.request.conversationId, inputMessageId: source.request.inputMessageId,
        userText: source.request.text } };
    return { revision: snapshot.revision, digest: modelReadDigest({ source: source.requestDigest, snapshot }), timeoutMs: snapshot.timeoutMs,
      selection, observation: snapshot.observation, action: snapshot.action };
  }
  private createFamily(request: AstraTaskHttpRequest, actor: AstraAuthenticatedHttpActor): CreateFamily {
    const selection = this.createCatalogSelection(request, actor);
    check(selection && ['literal', 'draft', 'literal-input'].includes(selection.kind), 400, 'astra-invalid-create-selection');
    if (selection.kind === 'draft') {
      const modelMode = request.goal?.kind === 'create' && request.goal.content.kind === 'draft'
        ? request.goal.content.modelMode : undefined;
      check(this.options.requiredModelMode ? modelMode === this.options.requiredModelMode
        : modelMode === undefined || this.options.optionalMax === true && modelMode === 'max',
        400, this.options.requiredModelMode ? 'astra-model-mode-required' : 'astra-model-mode-unavailable');
    }
    return selection.kind === 'literal' ? 'literal-create' : selection.kind === 'literal-input' ? 'input-create' : 'model-create';
  }
  private readFamily(request: AstraTaskHttpRequest): 'direct-read' | 'model-read' {
    if (request.goal?.kind !== 'analyze') return 'direct-read';
    check(this.options.requiredModelMode ? request.goal.modelMode === this.options.requiredModelMode
      : this.options.localAnalysis === true && request.goal.modelMode === 'local'
        || this.options.optionalMax === true && request.goal.modelMode === 'max',
      400, this.options.requiredModelMode ? 'astra-model-mode-required' : 'astra-model-mode-unavailable');
    if (request.goal.modelMode === 'max') check(this.options.maxModelPolicies, 400, 'astra-max-model-choice');
    return 'model-read';
  }
  private createCatalogSelection(request: AstraTaskHttpRequest, actor: AstraAuthenticatedHttpActor): AstraCreateCatalogSelection {
    return this.options.sourceCompiler ? this.options.sourceCompiler.create(request.selectionId, this.context(actor, request))
      : this.options.createCatalog!.resolve(request.selectionId, this.context(actor, request));
  }
  private context(actor: AstraAuthenticatedHttpActor, request: AstraTaskHttpRequest): AstraTaskSourceContext {
    return { actor: structuredClone(actor), conversationId: request.conversationId, inputMessageId: request.inputMessageId, text: request.text,
      ...(request.goal ? { goal: structuredClone(request.goal) } : {}) };
  }
  private operation(source: SourceRecord): Operation { return source.family === 'generic-agent' ? 'agent' : source.family === 'computer-observe' ? 'computer-observe' : source.family === 'computer-action' ? 'computer-action'
    : source.family && !['direct-read', 'model-read'].includes(source.family) ? 'create' : 'read'; }
  private taskId(sourceId: string, family?: SourceFamily): string { return family === 'computer-observe' ? astraComputerTaskId(this.options.scopeId, sourceId)
    : family === 'generic-agent' ? astraAgentTaskId(this.options.scopeId, sourceId)
    : family === 'computer-action' ? astraComputerActionTaskId(this.options.scopeId, sourceId) : family === 'direct-read' ? astraReadTaskId(this.options.scopeId, sourceId)
      : family === 'model-read' ? modelReadTaskId(this.options.scopeId, sourceId)
    : family === 'literal-create' ? astraCreateTaskId(this.options.scopeId, sourceId)
    : family ? draftTaskId(this.options.scopeId, sourceId) : modelReadTaskId(this.options.scopeId, sourceId); }
  private requestDigest(actor: AstraAuthenticatedHttpActor, request: AstraTaskHttpRequest, operation: Operation): string {
    return modelReadDigest({ actor, request, ...(operation !== 'read' ? { operation } : {}) });
  }
  private enabled(operation: Operation): void { check(operation === 'read' || (operation === 'create' ? this.createTasks
    : operation === 'computer-observe' ? this.computerTasks : operation === 'computer-action' ? this.computerActionTasks
      : this.agentTasks), 404, 'astra-runtime-disabled'); }
  private actor(actor: AstraAuthenticatedHttpActor): void {
    check(/^sha256:[a-f0-9]{64}$/u.test(actor.id)
      && ['desktop', 'voice', 'api', 'telegram', 'coder', 'system'].includes(actor.source), 401, 'astra-authentication-required');
  }
  private request(request: AstraTaskHttpRequest, operation: Operation): void {
    check(request.version === 1 && request.privacyMode === (this.options.privacyMode ?? 'persistent')
      && Object.keys(request).every(key => ['version', 'clientRequestId', 'conversationId', 'inputMessageId', 'text', 'selectionId', 'privacyMode',
        ...(operation === 'agent' ? ['history', 'attachmentIds', 'executionProfile', 'telegramActor', 'specification'] : []), ...(this.options.sourceCompiler && !operation.startsWith('computer-') ? ['goal'] : [])].includes(key))
      && [request.clientRequestId, request.conversationId, request.inputMessageId, request.selectionId].every(modelReadIdentity)
      && typeof request.text === 'string' && request.text.trim().length > 0
      && Buffer.byteLength(request.text) <= (operation === 'agent' && request.executionProfile ? 20_000
        : operation === 'agent' ? 16_384 : operation === 'read' ? 8192 : 4096)
      && (request.history === undefined || operation === 'agent' && isAstraAgentHistory(request.history))
      && (request.attachmentIds === undefined || operation === 'agent' && Array.isArray(request.attachmentIds)
        && request.attachmentIds.length > 0 && request.attachmentIds.length <= 3
        && request.attachmentIds.every(modelReadIdentity) && new Set(request.attachmentIds).size === request.attachmentIds.length)
      && (request.executionProfile === undefined || operation === 'agent' && isAstraAgentExecutionProfile(request.executionProfile))
      && (request.specification === undefined || operation === 'agent' && isAstraAgentTaskSpecification(request.specification))
      && (request.telegramActor === undefined || operation === 'agent' && validTelegramAgentActor(request.telegramActor)), 400, 'astra-invalid-request');
    try { modelReadDigest(request); } catch { throw new AstraTaskHttpError(400, 'astra-invalid-request'); }
    if (this.options.sourceCompiler && !operation.startsWith('computer-')) { check(request.goal, 400, 'astra-source-goal-required');
      validateAstraSourceGoal(request.goal, operation as 'read' | 'create' | 'agent'); }
  }
}

export function projectAstraAgentFileArtifacts(
  activities: AstraTaskHttpTask['activities'] = [],
): NonNullable<AstraTaskHttpTask['artifacts']> {
  const byReference = new Map<string, NonNullable<AstraTaskHttpTask['artifacts']>[number]>();
  for (const activity of activities) {
    if (activity.state !== 'observed' || activity.ok !== true || !activity.output
      || typeof activity.output !== 'object' || Array.isArray(activity.output)) continue;
    const output = activity.output as Record<string, AstraJson>;
    const reference = typeof output.path === 'string' ? output.path : '';
    const readbackSha256 = typeof output.readbackSha256 === 'string' ? output.readbackSha256 : '';
    if (output.verified !== true || !reference || !/^[a-f0-9]{64}$/u.test(readbackSha256)) continue;
    const label = reference.split(/[\\/]/u).at(-1)?.trim() || '';
    if (!label) continue;
    const id = 'agent_artifact_' + createHash('sha256')
      .update(JSON.stringify([activity.round, activity.capabilityId, reference, readbackSha256]))
      .digest('hex').slice(0, 48);
    byReference.set(reference, { id, label, kind: 'file', reference, checksum: `sha256:${readbackSha256}` });
  }
  return [...byReference.values()].slice(-3);
}

function validTelegramAgentActor(value: AstraTaskHttpRequest['telegramActor']): boolean {
  return Boolean(value
    && Number.isSafeInteger(value.ownerUserId) && value.ownerUserId > 0
    && Number.isSafeInteger(value.controlChatId) && value.controlChatId !== 0
    && Number.isSafeInteger(value.botId) && value.botId > 0
    && Number.isSafeInteger(value.threadId) && value.threadId >= 0
    && typeof value.pairingEpoch === 'string' && value.pairingEpoch.length >= 1 && value.pairingEpoch.length <= 200
    && typeof value.requestId === 'string' && value.requestId.length >= 1 && value.requestId.length <= 512);
}
