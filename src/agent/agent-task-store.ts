import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_CHECKPOINT_SCHEMA_VERSION,
  AGENT_APPROVAL_SCHEMA_VERSION,
  AGENT_OBSERVATION_SCHEMA_VERSION,
  AGENT_RUNNER_CLAIM_SCHEMA_VERSION,
  AGENT_TASK_EVENT_SCHEMA_VERSION,
  AGENT_TASK_SCHEMA_VERSION,
  type AgentClientRequestReceipt,
  type AgentApproval,
  type AgentJsonObject,
  type AgentObservation,
  type AgentRunnerClaim,
  type AgentTask,
  type AgentTaskCheckpoint,
  type AgentTaskEvent,
  type AgentTaskEventDraft,
  type AgentTaskEventType,
  type AgentTaskMutationOptions,
  type AgentTaskSaveOptions,
  type AgentTaskStatus,
  type AgentTaskStore,
  type AgentTaskStoreCommit,
  type AgentTaskStoreListener,
} from './types';

export const AGENT_TASK_STORE_SCHEMA_VERSION = 'monarch.agent-task-store.v2' as const;
const AGENT_TASK_LOCK_SCHEMA_VERSION = 'monarch.agent-task-lock.v1' as const;

const ACTIVE_RECOVERY_STATUSES = new Set<AgentTaskStatus>([
  'preparing',
  'running',
  'cancelling',
]);
const TERMINAL_STATUSES = new Set<AgentTaskStatus>(['completed', 'failed', 'cancelled']);
const TASK_STATUSES = new Set<AgentTaskStatus>([
  'created',
  'preparing',
  'running',
  'waiting-for-user',
  'waiting-for-approval',
  'waiting-for-runtime',
  'paused',
  'cancelling',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);
const TASK_SURFACES = new Set(['desktop', 'telegram', 'voice', 'api', 'coder', 'system', 'smoke']);
const EVENT_TYPES = new Set<AgentTaskEventType>([
  'task.created',
  'task.status.changed',
  'plan.created',
  'plan.revised',
  'resolver.completed',
  'model.started',
  'model.completed',
  'step.started',
  'approval.required',
  'approval.resolved',
  'tool.started',
  'tool.completed',
  'observation.created',
  'verification.completed',
  'artifact.created',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.interrupted',
  'runner.claimed',
  'runner.renewed',
  'runner.released',
]);
const FORBIDDEN_PERSISTED_KEYS = new Set([
  'chainofthought',
  'hiddenreasoning',
  'reasoningtrace',
  'rawprompt',
  'systemprompt',
  'developerprompt',
]);

type StoredClientRequest = AgentClientRequestReceipt;

interface AgentTaskStoreDocument {
  schemaVersion: typeof AGENT_TASK_STORE_SCHEMA_VERSION;
  tasks: Record<string, AgentTaskCheckpoint>;
  clientRequests: Record<string, StoredClientRequest>;
  updatedAt: string;
}

interface StoreMutation<T> {
  changed: boolean;
  value: T;
  commits: AgentTaskStoreCommit[];
}

interface NormalizedMutationOptions {
  clientRequestId?: string;
  events: AgentTaskEventDraft[];
  observations?: AgentObservation[];
  approvals?: AgentApproval[];
}

interface AgentTaskLockDocument {
  schemaVersion: typeof AGENT_TASK_LOCK_SCHEMA_VERSION;
  ownerId: string;
  pid: number;
  state: 'choosing' | 'waiting' | 'held';
  ticket: number;
  createdAt: string;
  expiresAt: string;
}

interface AgentTaskLockContender {
  filePath: string;
  lock: AgentTaskLockDocument;
}

interface AgentTaskStoreLockLease {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export interface LocalJsonAgentTaskStoreOptions {
  lockTimeoutMs?: number;
  lockTtlMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export class AgentTaskStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentTaskStoreError';
  }
}

export class AgentTaskStoreValidationError extends AgentTaskStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentTaskStoreValidationError';
  }
}

export class AgentTaskStoreIdempotencyConflictError extends AgentTaskStoreValidationError {
  readonly clientRequestId: string;

  constructor(clientRequestId: string, message: string) {
    super(message);
    this.name = 'AgentTaskStoreIdempotencyConflictError';
    this.clientRequestId = clientRequestId;
  }
}

export class AgentTaskStoreCorruptionError extends AgentTaskStoreError {
  readonly filePath?: string;

  constructor(message: string, filePath?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentTaskStoreCorruptionError';
    if (filePath !== undefined) this.filePath = filePath;
  }
}

export class AgentTaskStoreConflictError extends AgentTaskStoreError {
  readonly taskId: string;
  readonly expectedCheckpointVersion: number;
  readonly actualCheckpointVersion: number;

  constructor(taskId: string, expectedCheckpointVersion: number, actualCheckpointVersion: number) {
    super(
      `Agent task ${taskId} checkpoint conflict: expected ${expectedCheckpointVersion}, `
      + `found ${actualCheckpointVersion}.`,
    );
    this.name = 'AgentTaskStoreConflictError';
    this.taskId = taskId;
    this.expectedCheckpointVersion = expectedCheckpointVersion;
    this.actualCheckpointVersion = actualCheckpointVersion;
  }
}

export class AgentTaskStoreNotFoundError extends AgentTaskStoreError {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Agent task ${taskId} does not exist.`);
    this.name = 'AgentTaskStoreNotFoundError';
    this.taskId = taskId;
  }
}

export class AgentTaskRunnerClaimError extends AgentTaskStoreError {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(message);
    this.name = 'AgentTaskRunnerClaimError';
    this.taskId = taskId;
  }
}

export class AgentTaskStoreLockTimeoutError extends AgentTaskStoreError {
  readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for agent task store lock ${lockPath}.`);
    this.name = 'AgentTaskStoreLockTimeoutError';
    this.lockPath = lockPath;
  }
}

class AgentTaskStoreLockLostError extends AgentTaskStoreError {
  constructor(lockPath: string, options?: ErrorOptions) {
    super(`Agent task store lock ownership was lost before commit: ${lockPath}.`, options);
    this.name = 'AgentTaskStoreLockLostError';
  }
}

abstract class BaseAgentTaskStore implements AgentTaskStore {
  private readonly listeners = new Map<string, Set<AgentTaskStoreListener>>();
  protected readonly now: () => Date;

  protected constructor(now: () => Date) {
    this.now = now;
  }

  protected abstract readDocument(): Promise<AgentTaskStoreDocument>;
  protected abstract mutateDocument<T>(
    mutator: (document: AgentTaskStoreDocument) => StoreMutation<T>,
  ): Promise<StoreMutation<T>>;

  async createTask(
    taskInput: AgentTask,
    options: AgentTaskMutationOptions = {},
  ): Promise<AgentTaskStoreCommit> {
    const task = cloneInput(taskInput, 'agent task');
    assertTask(task, 'agent task');
    assertInitialTask(task);
    const normalizedOptions = normalizeMutationOptions(options);
    const requestFingerprint = fingerprintRequest({
      operation: 'create-task',
      task,
      options: normalizedOptions,
    });
    const result = await this.mutateDocument((document) => {
      const replay = replayClientRequest(
        document,
        normalizedOptions.clientRequestId,
        requestFingerprint,
        task.id,
      );
      if (replay) return unchanged(replay);
      if (document.tasks[task.id]) {
        throw new AgentTaskStoreValidationError(`Agent task ${task.id} already exists.`);
      }

      const savedAt = this.nowIso();
      const storedTask: AgentTask = {
        ...task,
        checkpointVersion: 1,
        eventSequence: 0,
        updatedAt: savedAt,
      };
      const drafts = ensureCreatedEvent(normalizedOptions.events);
      const appendedEvents = appendEvents(storedTask, [], drafts, savedAt);
      const checkpoint = createCheckpoint(
        storedTask,
        appendedEvents,
        normalizedOptions.observations ?? [],
        normalizedOptions.approvals ?? [],
        savedAt,
      );
      const commit = createCommit(checkpoint, appendedEvents, false);
      document.tasks[task.id] = checkpoint;
      rememberClientRequest(
        document,
        normalizedOptions.clientRequestId,
        requestFingerprint,
        commit,
        savedAt,
      );
      document.updatedAt = savedAt;
      return changed(commit, [commit]);
    });
    this.publish(result.commits);
    return cloneStored(result.value);
  }

  async getTask(taskIdInput: string): Promise<AgentTaskCheckpoint | null> {
    const taskId = normalizeIdentifier(taskIdInput, 'task id');
    const document = await this.readDocument();
    const checkpoint = document.tasks[taskId];
    return checkpoint ? cloneStored(checkpoint) : null;
  }

  async getTaskState(taskId: string): Promise<AgentTask | null> {
    const checkpoint = await this.getTask(taskId);
    return checkpoint ? cloneStored(checkpoint.task) : null;
  }

  async listTasks(): Promise<AgentTask[]> {
    const document = await this.readDocument();
    return Object.values(document.tasks)
      .map((checkpoint) => cloneStored(checkpoint.task))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async saveTask(taskInput: AgentTask, optionsInput: AgentTaskSaveOptions): Promise<AgentTaskStoreCommit> {
    const task = cloneInput(taskInput, 'agent task');
    assertTask(task, 'agent task');
    const options = normalizeSaveOptions(optionsInput);
    const requestFingerprint = fingerprintRequest(options.idempotencyPayload === undefined
      ? { operation: 'save-task', task, options }
      : { operation: 'save-task', taskId: task.id, payload: options.idempotencyPayload });
    const result = await this.mutateDocument((document) => {
      const replay = replayClientRequest(document, options.clientRequestId, requestFingerprint, task.id);
      if (replay) return unchanged(replay);
      const current = requireCheckpoint(document, task.id);
      if (options.expectedRunnerClaimId) {
        const claim = current.task.runnerClaim;
        if (!claim || claim.claimId !== options.expectedRunnerClaimId) {
          throw new AgentTaskRunnerClaimError(
            task.id,
            `Agent task ${task.id} is not owned by runner claim ${options.expectedRunnerClaimId}.`,
          );
        }
        if (Date.parse(claim.expiresAt) <= this.nowDate().getTime()) {
          throw new AgentTaskRunnerClaimError(
            task.id,
            `Runner claim ${options.expectedRunnerClaimId} has expired.`,
          );
        }
      }
      assertCheckpointVersion(task.id, options.expectedCheckpointVersion, current.task.checkpointVersion);
      if (task.checkpointVersion !== options.expectedCheckpointVersion) {
        throw new AgentTaskStoreValidationError(
          `Agent task ${task.id} carries checkpoint ${task.checkpointVersion}; `
          + `expected ${options.expectedCheckpointVersion}.`,
        );
      }
      if (task.eventSequence !== current.task.eventSequence) {
        throw new AgentTaskStoreValidationError(
          `Agent task ${task.id} carries event sequence ${task.eventSequence}; `
          + `expected ${current.task.eventSequence}.`,
        );
      }
      if (task.traceId !== current.task.traceId) {
        throw new AgentTaskStoreValidationError(`Agent task ${task.id} trace id is immutable.`);
      }
      if (task.createdAt !== current.task.createdAt) {
        throw new AgentTaskStoreValidationError(`Agent task ${task.id} createdAt is immutable.`);
      }
      if (stableJson(task.runnerClaim ?? null) !== stableJson(current.task.runnerClaim ?? null)) {
        throw new AgentTaskStoreValidationError(
          `Agent task ${task.id} runner claim can only change through claimRunner, renewRunner, or releaseRunner.`,
        );
      }
      if (TERMINAL_STATUSES.has(current.task.status) && task.status !== current.task.status) {
        throw new AgentTaskStoreValidationError(`Terminal agent task ${task.id} status is immutable.`);
      }

      const savedAt = this.nowIso();
      const storedTask: AgentTask = {
        ...task,
        checkpointVersion: current.task.checkpointVersion + 1,
        eventSequence: current.task.eventSequence,
        updatedAt: savedAt,
      };
      const appendedEvents = appendEvents(storedTask, current.events, options.events, savedAt);
      const checkpoint = createCheckpoint(
        storedTask,
        [...current.events, ...appendedEvents],
        options.observations ?? current.observations,
        options.approvals ?? current.approvals,
        savedAt,
      );
      const commit = createCommit(checkpoint, appendedEvents, false);
      document.tasks[task.id] = checkpoint;
      rememberClientRequest(document, options.clientRequestId, requestFingerprint, commit, savedAt);
      document.updatedAt = savedAt;
      return changed(commit, [commit]);
    });
    this.publish(result.commits);
    return cloneStored(result.value);
  }

  async claimRunner(
    taskIdInput: string,
    runnerIdInput: string,
    ttlMsInput: number,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ): Promise<AgentTaskStoreCommit> {
    const taskId = normalizeIdentifier(taskIdInput, 'task id');
    const runnerId = normalizeIdentifier(runnerIdInput, 'runner id');
    const ttlMs = normalizeTtl(ttlMsInput);
    const requestId = normalizeOptionalIdentifier(clientRequestId, 'client request id');
    const requestFingerprint = fingerprintRequest({
      operation: 'claim-runner',
      taskId,
      runnerId,
      ttlMs,
      expectedCheckpointVersion,
    });
    const result = await this.mutateDocument((document) => {
      const replay = replayClientRequest(document, requestId, requestFingerprint, taskId);
      if (replay) return unchanged(replay);
      const current = requireCheckpoint(document, taskId);
      assertCheckpointVersion(taskId, expectedCheckpointVersion, current.task.checkpointVersion);
      if (TERMINAL_STATUSES.has(current.task.status)) {
        throw new AgentTaskRunnerClaimError(taskId, `Terminal agent task ${taskId} cannot be claimed.`);
      }

      const now = this.nowDate();
      const existing = current.task.runnerClaim;
      if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
        throw new AgentTaskRunnerClaimError(
          taskId,
          `Agent task ${taskId} is already claimed by runner ${existing.runnerId}.`,
        );
      }

      const drafts: AgentTaskEventDraft[] = [];
      const task = cloneStored(current.task);
      if (existing) {
        delete task.runnerClaim;
        drafts.push({
          type: 'runner.released',
          payload: {
            claimId: existing.claimId,
            runnerId: existing.runnerId,
            reason: 'expired',
          },
        });
        if (ACTIVE_RECOVERY_STATUSES.has(task.status)) {
          const previousStatus = task.status;
          task.status = 'interrupted';
          task.recovery = {
            reason: 'runner-claim-expired',
            previousStatus,
            interruptedAt: now.toISOString(),
          };
          drafts.push({
            type: 'task.interrupted',
            payload: { previousStatus, reason: 'runner-claim-expired' },
          });
        }
      }

      const claim: AgentRunnerClaim = {
        schemaVersion: AGENT_RUNNER_CLAIM_SCHEMA_VERSION,
        claimId: `agent_claim_${randomUUID()}`,
        runnerId,
        claimedAt: now.toISOString(),
        renewedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      task.runnerClaim = claim;
      const payload: AgentJsonObject = {
        claimId: claim.claimId,
        runnerId: claim.runnerId,
        expiresAt: claim.expiresAt,
      };
      drafts.push({ type: 'runner.claimed', payload });
      return mutateCheckpoint(
        document,
        current,
        task,
        drafts,
        requestId,
        requestFingerprint,
        now.toISOString(),
      );
    });
    this.publish(result.commits);
    return cloneStored(result.value);
  }

  async renewRunner(
    taskIdInput: string,
    claimIdInput: string,
    ttlMsInput: number,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ): Promise<AgentTaskStoreCommit> {
    const taskId = normalizeIdentifier(taskIdInput, 'task id');
    const claimId = normalizeIdentifier(claimIdInput, 'runner claim id');
    const ttlMs = normalizeTtl(ttlMsInput);
    const requestId = normalizeOptionalIdentifier(clientRequestId, 'client request id');
    const requestFingerprint = fingerprintRequest({
      operation: 'renew-runner',
      taskId,
      claimId,
      ttlMs,
      expectedCheckpointVersion,
    });
    const result = await this.mutateDocument((document) => {
      const replay = replayClientRequest(document, requestId, requestFingerprint, taskId);
      if (replay) return unchanged(replay);
      const current = requireCheckpoint(document, taskId);
      assertCheckpointVersion(taskId, expectedCheckpointVersion, current.task.checkpointVersion);
      const claim = requireRunnerClaim(current.task, claimId);
      const now = this.nowDate();
      if (Date.parse(claim.expiresAt) <= now.getTime()) {
        throw new AgentTaskRunnerClaimError(taskId, `Runner claim ${claimId} has expired.`);
      }

      const renewed: AgentRunnerClaim = {
        ...claim,
        renewedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      const task: AgentTask = { ...current.task, runnerClaim: renewed };
      const payload: AgentJsonObject = {
        claimId: renewed.claimId,
        runnerId: renewed.runnerId,
        expiresAt: renewed.expiresAt,
      };
      return mutateCheckpoint(
        document,
        current,
        task,
        [{ type: 'runner.renewed', payload }],
        requestId,
        requestFingerprint,
        now.toISOString(),
      );
    });
    this.publish(result.commits);
    return cloneStored(result.value);
  }

  async releaseRunner(
    taskIdInput: string,
    claimIdInput: string,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ): Promise<AgentTaskStoreCommit> {
    const taskId = normalizeIdentifier(taskIdInput, 'task id');
    const claimId = normalizeIdentifier(claimIdInput, 'runner claim id');
    const requestId = normalizeOptionalIdentifier(clientRequestId, 'client request id');
    const requestFingerprint = fingerprintRequest({
      operation: 'release-runner',
      taskId,
      claimId,
      expectedCheckpointVersion,
    });
    const result = await this.mutateDocument((document) => {
      const replay = replayClientRequest(document, requestId, requestFingerprint, taskId);
      if (replay) return unchanged(replay);
      const current = requireCheckpoint(document, taskId);
      assertCheckpointVersion(taskId, expectedCheckpointVersion, current.task.checkpointVersion);
      const claim = requireRunnerClaim(current.task, claimId);
      const now = this.nowIso();
      const task = cloneStored(current.task);
      delete task.runnerClaim;
      const payload: AgentJsonObject = {
        claimId: claim.claimId,
        runnerId: claim.runnerId,
        reason: 'released',
      };
      return mutateCheckpoint(
        document,
        current,
        task,
        [{ type: 'runner.released', payload }],
        requestId,
        requestFingerprint,
        now,
      );
    });
    this.publish(result.commits);
    return cloneStored(result.value);
  }

  async recoverExpiredClaims(nowInput?: Date | string | number): Promise<AgentTaskStoreCommit[]> {
    const recoveryDate = normalizeDate(nowInput ?? this.now());
    const recoveryTime = recoveryDate.getTime();
    const savedAt = recoveryDate.toISOString();
    const result = await this.mutateDocument((document) => {
      const commits: AgentTaskStoreCommit[] = [];
      for (const taskId of Object.keys(document.tasks).sort()) {
        const current = document.tasks[taskId];
        if (!current) continue;
        const claim = current.task.runnerClaim;
        if (!claim || Date.parse(claim.expiresAt) > recoveryTime) continue;

        const task = cloneStored(current.task);
        delete task.runnerClaim;
        const events: AgentTaskEventDraft[] = [{
          type: 'runner.released',
          payload: {
            claimId: claim.claimId,
            runnerId: claim.runnerId,
            reason: 'expired',
          },
        }];
        if (ACTIVE_RECOVERY_STATUSES.has(task.status)) {
          const previousStatus = task.status;
          task.status = 'interrupted';
          task.recovery = {
            reason: 'runner-claim-expired',
            previousStatus,
            interruptedAt: savedAt,
          };
          events.push({
            type: 'task.interrupted',
            payload: {
              previousStatus,
              reason: 'runner-claim-expired',
            },
          });
        }
        const mutation = mutateCheckpoint(document, current, task, events, undefined, undefined, savedAt);
        commits.push(mutation.value);
      }
      return commits.length > 0
        ? { changed: true, value: commits, commits }
        : unchanged<AgentTaskStoreCommit[]>([]);
    });
    this.publish(result.commits);
    return cloneStored(result.value);
  }

  subscribe(taskIdInput: string | '*', listener: AgentTaskStoreListener): () => void {
    if (typeof listener !== 'function') {
      throw new AgentTaskStoreValidationError('Agent task store listener must be a function.');
    }
    const taskId = taskIdInput === '*' ? '*' : normalizeIdentifier(taskIdInput, 'task id');
    const listeners = this.listeners.get(taskId) ?? new Set<AgentTaskStoreListener>();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.listeners.get(taskId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(taskId);
    };
  }

  private publish(commits: AgentTaskStoreCommit[]): void {
    for (const commit of commits) {
      const listeners = [
        ...(this.listeners.get(commit.task.id) ?? []),
        ...(this.listeners.get('*') ?? []),
      ];
      for (const listener of listeners) {
        try {
          listener(cloneStored(commit));
        } catch {
          // Subscribers are observers; a faulty observer must not roll back durable state.
        }
      }
    }
  }

  private nowDate(): Date {
    return normalizeDate(this.now());
  }

  private nowIso(): string {
    return this.nowDate().toISOString();
  }
}

export class InMemoryAgentTaskStore extends BaseAgentTaskStore {
  private document: AgentTaskStoreDocument;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: Pick<LocalJsonAgentTaskStoreOptions, 'now'> = {}) {
    const now = options.now ?? (() => new Date());
    super(now);
    this.document = createEmptyDocument(normalizeDate(now()).toISOString());
  }

  protected readDocument(): Promise<AgentTaskStoreDocument> {
    return this.enqueue(() => cloneStored(this.document));
  }

  protected mutateDocument<T>(
    mutator: (document: AgentTaskStoreDocument) => StoreMutation<T>,
  ): Promise<StoreMutation<T>> {
    return this.enqueue(() => {
      const working = cloneStored(this.document);
      const result = mutator(working);
      if (result.changed) {
        assertStoredDocument(working);
        this.document = working;
      }
      return cloneStored(result);
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const running = this.queue.then(operation, operation);
    this.queue = running.then(() => undefined, () => undefined);
    return running;
  }
}

export class LocalJsonAgentTaskStore extends BaseAgentTaskStore {
  readonly filePath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockTtlMs: number;
  private readonly retryDelayMs: number;
  private readonly processId: number;
  private readonly processAlive: (pid: number) => boolean;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePathInput: string, options: LocalJsonAgentTaskStoreOptions = {}) {
    const now = options.now ?? (() => new Date());
    super(now);
    if (typeof filePathInput !== 'string' || !filePathInput.trim()) {
      throw new AgentTaskStoreValidationError('Agent task store file path is required.');
    }
    this.filePath = path.resolve(filePathInput);
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = normalizeDuration(options.lockTimeoutMs, 5_000, 'lock timeout');
    this.lockTtlMs = normalizeDuration(options.lockTtlMs, 30_000, 'lock ttl');
    this.retryDelayMs = normalizeDuration(options.retryDelayMs, 25, 'lock retry delay');
    this.processId = normalizeProcessId(options.pid ?? process.pid);
    this.processAlive = options.isProcessAlive ?? isProcessAlive;
  }

  protected readDocument(): Promise<AgentTaskStoreDocument> {
    return this.enqueue(() => this.loadDocument());
  }

  protected mutateDocument<T>(
    mutator: (document: AgentTaskStoreDocument) => StoreMutation<T>,
  ): Promise<StoreMutation<T>> {
    return this.enqueue(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const lease = await this.acquireLock();
        try {
          const document = await this.loadDocument();
          const result = mutator(document);
          if (result.changed) {
            assertStoredDocument(document);
            await this.writeDocumentAtomically(document, lease);
          }
          return cloneStored(result);
        } catch (error) {
          if (!(error instanceof AgentTaskStoreLockLostError) || attempt === 7) throw error;
        } finally {
          await lease.release();
        }
      }
      throw new AgentTaskStoreLockLostError(this.lockPath);
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const running = this.queue.then(operation, operation);
    this.queue = running.then(() => undefined, () => undefined);
    return running;
  }

  private async loadDocument(): Promise<AgentTaskStoreDocument> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return createEmptyDocument(normalizeDate(this.now()).toISOString());
      }
      throw new AgentTaskStoreError(`Unable to read agent task store ${this.filePath}.`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new AgentTaskStoreCorruptionError(
        `Agent task store ${this.filePath} contains invalid JSON and was not modified.`,
        this.filePath,
        { cause: error },
      );
    }
    try {
      assertStoredDocument(parsed);
      return cloneStored(parsed);
    } catch (error) {
      if (error instanceof AgentTaskStoreCorruptionError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentTaskStoreCorruptionError(
        `Agent task store ${this.filePath} is invalid (${detail}) and was not modified.`,
        this.filePath,
        { cause: error },
      );
    }
  }

  private async writeDocumentAtomically(
    document: AgentTaskStoreDocument,
    lease: AgentTaskStoreLockLease,
  ): Promise<void> {
    const temporaryPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${this.processId}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await lease.assertOwned();
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof AgentTaskStoreLockLostError) throw error;
      throw new AgentTaskStoreError(`Unable to atomically persist agent task store ${this.filePath}.`, {
        cause: error,
      });
    }
  }

  private async acquireLock(): Promise<AgentTaskStoreLockLease> {
    const ownerId = `agent_store_lock_${randomUUID()}`;
    const claimPath = `${this.lockPath}.${ownerId}.json`;
    const deadline = Date.now() + this.lockTimeoutMs;
    const createdAt = normalizeDate(this.now());
    let ownsClaim = false;
    try {
      await this.createLockClaim(claimPath, {
        schemaVersion: AGENT_TASK_LOCK_SCHEMA_VERSION,
        ownerId,
        pid: this.processId,
        state: 'choosing',
        ticket: 0,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + this.lockTtlMs).toISOString(),
      });
      ownsClaim = true;

      const initial = await this.readLockContenders(ownerId);
      const maximumTicket = initial.contenders.reduce(
        (maximum, contender) => Math.max(maximum, contender.lock.ticket),
        0,
      );
      if (!Number.isSafeInteger(maximumTicket + 1)) {
        throw new AgentTaskStoreError('Agent task store lock ticket space is exhausted.');
      }
      const waiting: AgentTaskLockDocument = {
        schemaVersion: AGENT_TASK_LOCK_SCHEMA_VERSION,
        ownerId,
        pid: this.processId,
        state: 'waiting',
        ticket: maximumTicket + 1,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + this.lockTtlMs).toISOString(),
      };
      await this.replaceLockClaim(claimPath, waiting);

      while (true) {
        const snapshot = await this.readLockContenders(ownerId);
        const own = snapshot.contenders.find((contender) => contender.lock.ownerId === ownerId);
        if (!own) {
          throw new AgentTaskStoreError(`Agent task store lock claim ${claimPath} disappeared.`);
        }
        const anotherChoosing = snapshot.contenders.some((contender) => (
          contender.lock.ownerId !== ownerId && contender.lock.state === 'choosing'
        ));
        const aLowerTicketExists = snapshot.contenders.some((contender) => {
          if (contender.lock.ownerId === ownerId || contender.lock.state === 'choosing') return false;
          return contender.lock.ticket < waiting.ticket
            || (contender.lock.ticket === waiting.ticket && contender.lock.ownerId < ownerId);
        });
        if (!snapshot.hasYoungMalformedClaim && !anotherChoosing && !aLowerTicketExists) {
          const held: AgentTaskLockDocument = {
            ...waiting,
            state: 'held',
            expiresAt: new Date(normalizeDate(this.now()).getTime() + this.lockTtlMs).toISOString(),
          };
          await this.replaceLockClaim(claimPath, held);
          return this.createHeldLockLease(claimPath, held);
        }
        if (Date.now() >= deadline) {
          throw new AgentTaskStoreLockTimeoutError(this.lockPath, this.lockTimeoutMs);
        }
        await delay(Math.min(this.retryDelayMs, Math.max(1, deadline - Date.now())));
      }
    } catch (error) {
      if (ownsClaim) await unlink(claimPath).catch(() => undefined);
      throw error;
    }
  }

  private createHeldLockLease(
    claimPath: string,
    initial: AgentTaskLockDocument,
  ): AgentTaskStoreLockLease {
    const heartbeatIntervalMs = Math.max(1, Math.floor(this.lockTtlMs / 3));
    let active = true;
    let current = initial;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let lost: AgentTaskStoreLockLostError | undefined;
    let renewalTail: Promise<void> = Promise.resolve();

    const renew = (): Promise<void> => {
      const operation = renewalTail.then(async () => {
        if (!active) return;
        current = await this.renewOwnedLockClaim(claimPath, current);
      });
      renewalTail = operation.catch((error: unknown) => {
        lost = error instanceof AgentTaskStoreLockLostError
          ? error
          : new AgentTaskStoreLockLostError(claimPath, { cause: error });
      });
      return operation;
    };
    const schedule = () => {
      if (!active || lost) return;
      heartbeat = setTimeout(() => {
        void renew().catch(() => undefined).finally(schedule);
      }, heartbeatIntervalMs);
      heartbeat.unref?.();
    };
    schedule();

    return {
      assertOwned: async () => {
        if (lost) throw lost;
        try {
          await renew();
        } catch (error) {
          throw lost || new AgentTaskStoreLockLostError(claimPath, { cause: error });
        }
        if (lost) throw lost;
      },
      release: async () => {
        active = false;
        if (heartbeat) clearTimeout(heartbeat);
        await renewalTail;
        await this.releaseLockClaim(claimPath, initial.ownerId);
      },
    };
  }

  private async renewOwnedLockClaim(
    claimPath: string,
    expected: AgentTaskLockDocument,
  ): Promise<AgentTaskLockDocument> {
    let raw: string;
    try {
      raw = await readFile(claimPath, 'utf8');
    } catch (error) {
      throw new AgentTaskStoreLockLostError(claimPath, { cause: error });
    }
    const current = parseLock(raw);
    const now = normalizeDate(this.now());
    if (
      !current
      || current.ownerId !== expected.ownerId
      || current.state !== 'held'
      || current.ticket !== expected.ticket
      || Date.parse(current.expiresAt) <= now.getTime()
    ) {
      throw new AgentTaskStoreLockLostError(claimPath);
    }
    const renewed: AgentTaskLockDocument = {
      ...current,
      expiresAt: new Date(now.getTime() + this.lockTtlMs).toISOString(),
    };
    try {
      await this.replaceLockClaim(claimPath, renewed);
    } catch (error) {
      throw new AgentTaskStoreLockLostError(claimPath, { cause: error });
    }
    return renewed;
  }

  private async createLockClaim(claimPath: string, lock: AgentTaskLockDocument): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(claimPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(claimPath).catch(() => undefined);
      throw new AgentTaskStoreError(`Unable to create agent task store lock claim ${claimPath}.`, {
        cause: error,
      });
    }
  }

  private async replaceLockClaim(claimPath: string, lock: AgentTaskLockDocument): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(claimPath, 'r+');
      await handle.truncate(0);
      await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      throw new AgentTaskStoreError(`Unable to update agent task store lock claim ${claimPath}.`, {
        cause: error,
      });
    }
  }

  private async readLockContenders(ownerId: string): Promise<{
    contenders: AgentTaskLockContender[];
    hasYoungMalformedClaim: boolean;
  }> {
    const directory = path.dirname(this.lockPath);
    const prefix = `${path.basename(this.lockPath)}.`;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      throw new AgentTaskStoreError(`Unable to enumerate agent task store lock claims in ${directory}.`, {
        cause: error,
      });
    }

    const contenders: AgentTaskLockContender[] = [];
    let hasYoungMalformedClaim = false;
    for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json')).sort()) {
      const contenderPath = path.join(directory, name);
      let raw: string;
      try {
        raw = await readFile(contenderPath, 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw new AgentTaskStoreError(`Unable to read agent task store lock claim ${contenderPath}.`, {
          cause: error,
        });
      }
      const lock = parseLock(raw);
      if (!lock) {
        try {
          const metadata = await stat(contenderPath);
          if (Date.now() - metadata.mtimeMs >= this.lockTtlMs) {
            await unlinkLockClaim(contenderPath);
          } else {
            hasYoungMalformedClaim = true;
          }
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            throw new AgentTaskStoreError(`Unable to inspect malformed lock claim ${contenderPath}.`, {
              cause: error,
            });
          }
        }
        continue;
      }
      const expired = Date.parse(lock.expiresAt) <= normalizeDate(this.now()).getTime();
      if (lock.ownerId !== ownerId && (expired || !this.processAlive(lock.pid))) {
        await unlinkLockClaim(contenderPath);
        continue;
      }
      contenders.push({ filePath: contenderPath, lock });
    }
    return { contenders, hasYoungMalformedClaim };
  }

  private async releaseLockClaim(claimPath: string, ownerId: string): Promise<void> {
    try {
      const raw = await readFile(claimPath, 'utf8');
      const lock = parseLock(raw);
      if (!lock || lock.ownerId !== ownerId) {
        throw new AgentTaskStoreError(`Agent task store lock claim ${claimPath} changed ownership.`);
      }
      await unlinkLockClaim(claimPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        if (error instanceof AgentTaskStoreError) throw error;
        throw new AgentTaskStoreError(`Unable to release agent task store lock claim ${claimPath}.`, {
          cause: error,
        });
      }
    }
  }
}

function createEmptyDocument(now: string): AgentTaskStoreDocument {
  return {
    schemaVersion: AGENT_TASK_STORE_SCHEMA_VERSION,
    tasks: {},
    clientRequests: {},
    updatedAt: now,
  };
}

function createCheckpoint(
  task: AgentTask,
  events: AgentTaskEvent[],
  observations: AgentObservation[],
  approvals: AgentApproval[],
  savedAt: string,
): AgentTaskCheckpoint {
  return {
    schemaVersion: AGENT_CHECKPOINT_SCHEMA_VERSION,
    task: cloneStored(task),
    events: cloneStored(events),
    observations: cloneStored(observations),
    approvals: cloneStored(approvals),
    savedAt,
  };
}

function createCommit(
  checkpoint: AgentTaskCheckpoint,
  appendedEvents: AgentTaskEvent[],
  replayed: boolean,
): AgentTaskStoreCommit {
  return {
    task: cloneStored(checkpoint.task),
    appendedEvents: cloneStored(appendedEvents),
    checkpoint: cloneStored(checkpoint),
    replayed,
  };
}

function mutateCheckpoint(
  document: AgentTaskStoreDocument,
  current: AgentTaskCheckpoint,
  taskInput: AgentTask,
  drafts: AgentTaskEventDraft[],
  clientRequestId: string | undefined,
  requestFingerprint: string | undefined,
  savedAt: string,
): StoreMutation<AgentTaskStoreCommit> {
  const task: AgentTask = {
    ...cloneStored(taskInput),
    checkpointVersion: current.task.checkpointVersion + 1,
    eventSequence: current.task.eventSequence,
    updatedAt: savedAt,
  };
  const appendedEvents = appendEvents(task, current.events, drafts, savedAt);
  const checkpoint = createCheckpoint(
    task,
    [...current.events, ...appendedEvents],
    current.observations,
    current.approvals,
    savedAt,
  );
  const commit = createCommit(checkpoint, appendedEvents, false);
  document.tasks[task.id] = checkpoint;
  rememberClientRequest(document, clientRequestId, requestFingerprint, commit, savedAt);
  document.updatedAt = savedAt;
  return changed(commit, [commit]);
}

function appendEvents(
  task: AgentTask,
  existingEvents: AgentTaskEvent[],
  drafts: AgentTaskEventDraft[],
  fallbackTimestamp: string,
): AgentTaskEvent[] {
  const lastSequence = existingEvents.at(-1)?.sequence ?? 0;
  if (task.eventSequence !== lastSequence) {
    throw new AgentTaskStoreValidationError(
      `Agent task ${task.id} event sequence ${task.eventSequence} does not match stored sequence ${lastSequence}.`,
    );
  }
  const appended = drafts.map((draft, index): AgentTaskEvent => {
    assertEventDraft(draft);
    const event: AgentTaskEvent = {
      schemaVersion: AGENT_TASK_EVENT_SCHEMA_VERSION,
      id: `agent_event_${randomUUID()}`,
      taskId: task.id,
      traceId: task.traceId,
      sequence: lastSequence + index + 1,
      type: draft.type,
      createdAt: normalizeIso(draft.createdAt ?? fallbackTimestamp, 'event timestamp'),
      ...(draft.payload ? { payload: cloneStored(draft.payload) } : {}),
    };
    return event;
  });
  task.eventSequence = lastSequence + appended.length;
  return appended;
}

function ensureCreatedEvent(events: AgentTaskEventDraft[]): AgentTaskEventDraft[] {
  if (events.some((event) => event.type === 'task.created')) return events;
  return [{ type: 'task.created' }, ...events];
}

function rememberClientRequest(
  document: AgentTaskStoreDocument,
  clientRequestId: string | undefined,
  requestFingerprint: string | undefined,
  commit: AgentTaskStoreCommit,
  createdAt: string,
): void {
  if (!clientRequestId) return;
  if (!requestFingerprint) {
    throw new AgentTaskStoreValidationError('Idempotent client requests require a request fingerprint.');
  }
  document.clientRequests[clientRequestId] = {
    clientRequestId,
    requestFingerprint,
    taskId: commit.task.id,
    checkpointVersion: commit.task.checkpointVersion,
    eventSequenceStart: commit.appendedEvents[0]?.sequence ?? commit.task.eventSequence + 1,
    eventSequence: commit.task.eventSequence,
    createdAt,
  };
}

function replayClientRequest(
  document: AgentTaskStoreDocument,
  clientRequestId: string | undefined,
  requestFingerprint: string,
  taskId: string,
): AgentTaskStoreCommit | null {
  if (!clientRequestId) return null;
  const existing = document.clientRequests[clientRequestId];
  if (!existing) return null;
  if (existing.taskId !== taskId) {
    throw new AgentTaskStoreIdempotencyConflictError(
      clientRequestId,
      `Client request id ${clientRequestId} is already bound to agent task ${existing.taskId}.`,
    );
  }
  if (existing.requestFingerprint !== requestFingerprint) {
    throw new AgentTaskStoreIdempotencyConflictError(
      clientRequestId,
      `Client request id ${clientRequestId} was reused with a different mutation payload.`,
    );
  }
  const checkpoint = requireCheckpoint(document, taskId);
  const appendedEvents = checkpoint.events.filter((event) => (
    event.sequence >= existing.eventSequenceStart && event.sequence <= existing.eventSequence
  ));
  return createCommit(checkpoint, appendedEvents, true);
}

function fingerprintRequest(value: unknown): string {
  assertJsonValue(value, 'client request fingerprint input');
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) {
    throw new AgentTaskStoreValidationError('Client request fingerprint input is not JSON serializable.');
  }
  return serialized;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function requireCheckpoint(document: AgentTaskStoreDocument, taskId: string): AgentTaskCheckpoint {
  const checkpoint = document.tasks[taskId];
  if (!checkpoint) throw new AgentTaskStoreNotFoundError(taskId);
  return checkpoint;
}

function requireRunnerClaim(task: AgentTask, claimId: string): AgentRunnerClaim {
  const claim = task.runnerClaim;
  if (!claim || claim.claimId !== claimId) {
    throw new AgentTaskRunnerClaimError(task.id, `Runner claim ${claimId} does not own agent task ${task.id}.`);
  }
  return claim;
}

function assertCheckpointVersion(taskId: string, expected: number, actual: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new AgentTaskStoreValidationError('Expected checkpoint version must be a non-negative integer.');
  }
  if (expected !== actual) throw new AgentTaskStoreConflictError(taskId, expected, actual);
}

function assertInitialTask(task: AgentTask): void {
  if (task.status !== 'created' && task.status !== 'preparing') {
    throw new AgentTaskStoreValidationError('A new agent task must start in created or preparing status.');
  }
  if (task.checkpointVersion !== 0) {
    throw new AgentTaskStoreValidationError('A new agent task must start at checkpoint version 0.');
  }
  if (task.eventSequence !== 0) {
    throw new AgentTaskStoreValidationError('A new agent task must start at event sequence 0.');
  }
  if (task.runnerClaim) {
    throw new AgentTaskStoreValidationError('A new agent task cannot carry a runner claim.');
  }
}

function normalizeMutationOptions(options: AgentTaskMutationOptions): NormalizedMutationOptions {
  assertJsonValue(options, 'mutation options');
  return {
    events: cloneStored(options.events ?? []),
    ...(options.clientRequestId
      ? { clientRequestId: normalizeIdentifier(options.clientRequestId, 'client request id') }
      : {}),
    ...(options.observations ? { observations: cloneStored(options.observations) } : {}),
    ...(options.approvals ? { approvals: cloneStored(options.approvals) } : {}),
  };
}

function normalizeSaveOptions(options: AgentTaskSaveOptions): AgentTaskSaveOptions & { events: AgentTaskEventDraft[] } {
  const mutation = normalizeMutationOptions(options);
  if (!Number.isSafeInteger(options.expectedCheckpointVersion) || options.expectedCheckpointVersion < 0) {
    throw new AgentTaskStoreValidationError('Expected checkpoint version must be a non-negative integer.');
  }
  return {
    expectedCheckpointVersion: options.expectedCheckpointVersion,
    events: mutation.events,
    ...(options.expectedRunnerClaimId !== undefined
      ? { expectedRunnerClaimId: normalizeIdentifier(options.expectedRunnerClaimId, 'expected runner claim id') }
      : {}),
    ...(options.idempotencyPayload !== undefined
      ? { idempotencyPayload: cloneStored(options.idempotencyPayload) }
      : {}),
    ...(mutation.clientRequestId ? { clientRequestId: mutation.clientRequestId } : {}),
    ...(mutation.observations ? { observations: mutation.observations } : {}),
    ...(mutation.approvals ? { approvals: mutation.approvals } : {}),
  };
}

function normalizeOptionalIdentifier(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : normalizeIdentifier(value, label);
}

function normalizeIdentifier(value: string, label: string): string {
  if (typeof value !== 'string') throw new AgentTaskStoreValidationError(`Agent ${label} must be a string.`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) {
    throw new AgentTaskStoreValidationError(`Agent ${label} contains unsupported characters or length.`);
  }
  return normalized;
}

function normalizeTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentTaskStoreValidationError('Runner claim ttl must be a positive integer in milliseconds.');
  }
  return value;
}

function normalizeDuration(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentTaskStoreValidationError(`Agent task store ${label} must be a positive integer.`);
  }
  return value;
}

function normalizeProcessId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentTaskStoreValidationError('Agent task store process id must be a positive integer.');
  }
  return value;
}

function normalizeDate(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AgentTaskStoreValidationError('Agent task store timestamp is invalid.');
  }
  return date;
}

function normalizeIso(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentTaskStoreValidationError(`Agent ${label} is required.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new AgentTaskStoreValidationError(`Agent ${label} is invalid.`);
  }
  return new Date(timestamp).toISOString();
}

function changed<T>(value: T, commits: AgentTaskStoreCommit[]): StoreMutation<T> {
  return { changed: true, value, commits };
}

function unchanged<T>(value: T): StoreMutation<T> {
  return { changed: false, value, commits: [] };
}

function cloneInput<T>(value: T, label: string): T {
  assertJsonValue(value, label);
  return cloneStored(value);
}

function cloneStored<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertJsonValue(value: unknown, pathLabel: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AgentTaskStoreValidationError(`${pathLabel} contains a non-finite number.`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new AgentTaskStoreValidationError(`${pathLabel} is not strictly JSON serializable.`);
  }
  if (seen.has(value)) {
    throw new AgentTaskStoreValidationError(`${pathLabel} contains a circular reference.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${pathLabel}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentTaskStoreValidationError(`${pathLabel} contains a non-plain object.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replace(/[\s_-]/gu, '').toLowerCase();
    if (FORBIDDEN_PERSISTED_KEYS.has(normalizedKey)) {
      throw new AgentTaskStoreValidationError(`${pathLabel}.${key} would persist hidden reasoning or a raw prompt.`);
    }
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new AgentTaskStoreValidationError(`${pathLabel}.${key} is not allowed in persisted JSON.`);
    }
    assertJsonValue(entry, `${pathLabel}.${key}`, seen);
  }
  seen.delete(value);
}

function assertTask(value: unknown, label: string): asserts value is AgentTask {
  assertJsonValue(value, label);
  const task = asRecord(value, label);
  assertEqual(task.schemaVersion, AGENT_TASK_SCHEMA_VERSION, `${label}.schemaVersion`);
  normalizeIdentifier(readString(task.id, `${label}.id`), 'task id');
  normalizeIdentifier(readString(task.traceId, `${label}.traceId`), 'trace id');
  if (task.clientRequestId !== undefined) {
    normalizeIdentifier(readString(task.clientRequestId, `${label}.clientRequestId`), 'client request id');
  }
  const source = asRecord(task.source, `${label}.source`);
  const surface = readString(source.surface, `${label}.source.surface`);
  if (!TASK_SURFACES.has(surface)) {
    throw new AgentTaskStoreValidationError(`${label}.source.surface is unsupported.`);
  }
  if (source.requestId !== undefined) readString(source.requestId, `${label}.source.requestId`);
  if (source.conversationId !== undefined) readString(source.conversationId, `${label}.source.conversationId`);
  if (source.remote !== undefined && typeof source.remote !== 'boolean') {
    throw new AgentTaskStoreValidationError(`${label}.source.remote must be boolean.`);
  }
  if (task.conversationId !== undefined) readString(task.conversationId, `${label}.conversationId`);
  if (task.parentTaskId !== undefined) {
    normalizeIdentifier(readString(task.parentTaskId, `${label}.parentTaskId`), 'parent task id');
  }
  const goal = asRecord(task.goal, `${label}.goal`);
  readString(goal.originalRequest, `${label}.goal.originalRequest`);
  readString(goal.normalizedObjective, `${label}.goal.normalizedObjective`);
  const expectedOutputs = readArray(goal.expectedOutputs, `${label}.goal.expectedOutputs`);
  expectedOutputs.forEach((entry, index) => assertGoalEntry(
    entry,
    `${label}.goal.expectedOutputs[${index}]`,
  ));
  const constraints = readArray(goal.constraints, `${label}.goal.constraints`);
  constraints.forEach((entry, index) => assertGoalEntry(entry, `${label}.goal.constraints[${index}]`));
  const successCriteria = readArray(goal.successCriteria, `${label}.goal.successCriteria`);
  successCriteria.forEach((entry, index) => assertGoalEntry(
    entry,
    `${label}.goal.successCriteria[${index}]`,
  ));
  if (goal.userPreferences !== undefined) {
    readArray(goal.userPreferences, `${label}.goal.userPreferences`).forEach((entry, index) => {
      readString(entry, `${label}.goal.userPreferences[${index}]`);
    });
  }
  if (!TASK_STATUSES.has(task.status as AgentTaskStatus)) {
    throw new AgentTaskStoreValidationError(`${label}.status is unsupported.`);
  }
  if (task.currentStepId !== undefined) {
    normalizeIdentifier(readString(task.currentStepId, `${label}.currentStepId`), 'step id');
  }
  if (task.plan !== undefined) assertPlan(task.plan, `${label}.plan`);
  readArray(task.observations, `${label}.observations`).forEach((entry, index) => {
    assertObservationReference(entry, task.id as string, `${label}.observations[${index}]`);
  });
  readArray(task.artifacts, `${label}.artifacts`).forEach((entry, index) => {
    assertArtifactReference(entry, `${label}.artifacts[${index}]`);
  });
  readArray(task.approvals, `${label}.approvals`).forEach((entry, index) => {
    assertApprovalReference(entry, task.id as string, `${label}.approvals[${index}]`);
  });
  const messages = readArray(task.messages, `${label}.messages`);
  if (messages.length > 200) {
    throw new AgentTaskStoreValidationError(`${label}.messages exceeds the durable limit of 200 entries.`);
  }
  messages.forEach((message, index) => assertTaskMessage(message, `${label}.messages[${index}]`));
  if (task.activeApprovalId !== undefined) {
    normalizeIdentifier(readString(task.activeApprovalId, `${label}.activeApprovalId`), 'approval id');
  }
  if (task.activeLeaseId !== undefined) {
    normalizeIdentifier(readString(task.activeLeaseId, `${label}.activeLeaseId`), 'lease id');
  }
  if (task.pendingAction !== undefined) {
    const pending = asRecord(task.pendingAction, `${label}.pendingAction`);
    normalizeIdentifier(
      readString(pending.actionAttemptId, `${label}.pendingAction.actionAttemptId`),
      'action attempt id',
    );
    if (pending.stepId !== undefined) {
      normalizeIdentifier(readString(pending.stepId, `${label}.pendingAction.stepId`), 'step id');
    }
    asRecord(pending.proposal, `${label}.pendingAction.proposal`);
    readString(pending.canonicalProposalHash, `${label}.pendingAction.canonicalProposalHash`);
    if (
      pending.status !== 'prepared'
      && pending.status !== 'dispatched'
      && pending.status !== 'waiting-approval'
      && pending.status !== 'settled'
    ) {
      throw new AgentTaskStoreValidationError(`${label}.pendingAction.status is unsupported.`);
    }
    normalizeIso(
      readString(pending.createdAt, `${label}.pendingAction.createdAt`),
      `${label}.pendingAction.createdAt`,
    );
    if (pending.dispatchedAt !== undefined) {
      normalizeIso(
        readString(pending.dispatchedAt, `${label}.pendingAction.dispatchedAt`),
        `${label}.pendingAction.dispatchedAt`,
      );
    }
  }
  if (task.pauseRequested !== undefined && typeof task.pauseRequested !== 'boolean') {
    throw new AgentTaskStoreValidationError(`${label}.pauseRequested must be boolean.`);
  }
  if (task.cancellationRequested !== undefined && typeof task.cancellationRequested !== 'boolean') {
    throw new AgentTaskStoreValidationError(`${label}.cancellationRequested must be boolean.`);
  }
  assertBudgets(task.budgets, `${label}.budgets`);
  assertUsage(task.usage, `${label}.usage`);
  if (task.contextSnapshot !== undefined) {
    const context = asRecord(task.contextSnapshot, `${label}.contextSnapshot`);
    normalizeIdentifier(readString(context.id, `${label}.contextSnapshot.id`), 'context snapshot id');
    readNonNegativeInteger(context.version, `${label}.contextSnapshot.version`);
    readString(context.checksum, `${label}.contextSnapshot.checksum`);
    normalizeIso(
      readString(context.createdAt, `${label}.contextSnapshot.createdAt`),
      `${label}.contextSnapshot.createdAt`,
    );
  }
  readNonNegativeInteger(task.checkpointVersion, `${label}.checkpointVersion`);
  readNonNegativeInteger(task.eventSequence, `${label}.eventSequence`);
  normalizeIso(readString(task.createdAt, `${label}.createdAt`), `${label}.createdAt`);
  normalizeIso(readString(task.updatedAt, `${label}.updatedAt`), `${label}.updatedAt`);
  if (task.completedAt !== undefined) {
    normalizeIso(readString(task.completedAt, `${label}.completedAt`), `${label}.completedAt`);
  }
  if (task.recovery !== undefined) {
    const recovery = asRecord(task.recovery, `${label}.recovery`);
    if (
      recovery.reason !== 'runner-claim-expired'
      && recovery.reason !== 'process-restart'
      && recovery.reason !== 'manual-recovery'
    ) {
      throw new AgentTaskStoreValidationError(`${label}.recovery.reason is unsupported.`);
    }
    if (!TASK_STATUSES.has(recovery.previousStatus as AgentTaskStatus)) {
      throw new AgentTaskStoreValidationError(`${label}.recovery.previousStatus is unsupported.`);
    }
    normalizeIso(
      readString(recovery.interruptedAt, `${label}.recovery.interruptedAt`),
      `${label}.recovery.interruptedAt`,
    );
  }
  if (task.runnerClaim !== undefined) assertRunnerClaim(task.runnerClaim, `${label}.runnerClaim`);
}

function assertGoalEntry(value: unknown, label: string): void {
  const entry = asRecord(value, label);
  normalizeIdentifier(readString(entry.id, `${label}.id`), 'goal entry id');
  readString(entry.description, `${label}.description`);
}

function assertPlan(value: unknown, label: string): void {
  const plan = asRecord(value, label);
  normalizeIdentifier(readString(plan.id, `${label}.id`), 'plan id');
  readPositiveInteger(plan.revision, `${label}.revision`);
  readString(plan.goalSummary, `${label}.goalSummary`);
  normalizeIso(readString(plan.createdAt, `${label}.createdAt`), `${label}.createdAt`);
  if (plan.revisedAt !== undefined) {
    normalizeIso(readString(plan.revisedAt, `${label}.revisedAt`), `${label}.revisedAt`);
  }
  const steps = readArray(plan.steps, `${label}.steps`);
  const stepIds = new Set<string>();
  steps.forEach((value, index) => {
    const stepLabel = `${label}.steps[${index}]`;
    const step = asRecord(value, stepLabel);
    const stepId = normalizeIdentifier(readString(step.id, `${stepLabel}.id`), 'step id');
    if (stepIds.has(stepId)) throw new AgentTaskStoreValidationError(`${label} contains duplicate step ${stepId}.`);
    stepIds.add(stepId);
    readString(step.title, `${stepLabel}.title`);
    if (
      step.status !== 'proposed'
      && step.status !== 'ready'
      && step.status !== 'blocked'
      && step.status !== 'waiting-approval'
      && step.status !== 'running'
      && step.status !== 'completed'
      && step.status !== 'failed'
      && step.status !== 'skipped'
    ) {
      throw new AgentTaskStoreValidationError(`${stepLabel}.status is unsupported.`);
    }
    readArray(step.dependsOn, `${stepLabel}.dependsOn`).forEach((dependency, dependencyIndex) => {
      normalizeIdentifier(
        readString(dependency, `${stepLabel}.dependsOn[${dependencyIndex}]`),
        'step dependency id',
      );
    });
    readArray(step.expectedEffects, `${stepLabel}.expectedEffects`);
    readArray(step.verification, `${stepLabel}.verification`);
  });
}

function assertObservationReference(value: unknown, taskId: string, label: string): void {
  const reference = asRecord(value, label);
  normalizeIdentifier(readString(reference.id, `${label}.id`), 'observation id');
  assertEqual(reference.taskId, taskId, `${label}.taskId`);
  if (
    reference.status !== 'success'
    && reference.status !== 'partial'
    && reference.status !== 'failed'
    && reference.status !== 'cancelled'
  ) {
    throw new AgentTaskStoreValidationError(`${label}.status is unsupported.`);
  }
  readString(reference.summary, `${label}.summary`);
  normalizeIso(readString(reference.occurredAt, `${label}.occurredAt`), `${label}.occurredAt`);
}

function assertApprovalReference(value: unknown, taskId: string, label: string): void {
  const reference = asRecord(value, label);
  normalizeIdentifier(readString(reference.id, `${label}.id`), 'approval id');
  assertEqual(reference.taskId, taskId, `${label}.taskId`);
  if (
    reference.status !== 'pending'
    && reference.status !== 'approved'
    && reference.status !== 'denied'
    && reference.status !== 'expired'
    && reference.status !== 'revoked'
  ) {
    throw new AgentTaskStoreValidationError(`${label}.status is unsupported.`);
  }
  readString(reference.capabilityId, `${label}.capabilityId`);
  readString(reference.canonicalProposalHash, `${label}.canonicalProposalHash`);
}

function assertArtifactReference(value: unknown, label: string): void {
  const artifact = asRecord(value, label);
  normalizeIdentifier(readString(artifact.id, `${label}.id`), 'artifact id');
  readString(artifact.kind, `${label}.kind`);
  readString(artifact.label, `${label}.label`);
  readString(artifact.reference, `${label}.reference`);
}

function assertBudgets(value: unknown, label: string): void {
  const budgets = asRecord(value, label);
  readPositiveInteger(budgets.maxSteps, `${label}.maxSteps`);
  readPositiveInteger(budgets.maxModelTurns, `${label}.maxModelTurns`);
  readPositiveInteger(budgets.maxToolCalls, `${label}.maxToolCalls`);
  readPositiveInteger(budgets.maxWallTimeMs, `${label}.maxWallTimeMs`);
  readPositiveInteger(budgets.maxFailures, `${label}.maxFailures`);
  readPositiveInteger(budgets.maxConsecutiveNoProgress, `${label}.maxConsecutiveNoProgress`);
  if (
    budgets.maxComputeClass !== undefined
    && budgets.maxComputeClass !== 'light'
    && budgets.maxComputeClass !== 'medium'
    && budgets.maxComputeClass !== 'heavy'
  ) {
    throw new AgentTaskStoreValidationError(`${label}.maxComputeClass is unsupported.`);
  }
}

function assertUsage(value: unknown, label: string): void {
  const usage = asRecord(value, label);
  readNonNegativeInteger(usage.steps, `${label}.steps`);
  readNonNegativeInteger(usage.modelTurns, `${label}.modelTurns`);
  readNonNegativeInteger(usage.toolCalls, `${label}.toolCalls`);
  readNonNegativeInteger(usage.failures, `${label}.failures`);
  readNonNegativeInteger(usage.consecutiveNoProgress, `${label}.consecutiveNoProgress`);
  normalizeIso(readString(usage.startedAt, `${label}.startedAt`), `${label}.startedAt`);
  normalizeIso(readString(usage.updatedAt, `${label}.updatedAt`), `${label}.updatedAt`);
}

function assertTaskMessage(value: unknown, label: string): void {
  const message = asRecord(value, label);
  normalizeIdentifier(readString(message.id, `${label}.id`), 'message id');
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') {
    throw new AgentTaskStoreValidationError(`${label}.role is unsupported.`);
  }
  const kinds = new Set(['request', 'clarification', 'progress', 'result', 'status', 'reference']);
  if (typeof message.kind !== 'string' || !kinds.has(message.kind)) {
    throw new AgentTaskStoreValidationError(`${label}.kind is unsupported.`);
  }
  normalizeIso(readString(message.createdAt, `${label}.createdAt`), `${label}.createdAt`);
  if (message.content !== undefined) {
    const content = readString(message.content, `${label}.content`);
    if (content.length > 16_384) {
      throw new AgentTaskStoreValidationError(`${label}.content exceeds 16384 characters.`);
    }
    if (message.role === 'system') {
      throw new AgentTaskStoreValidationError(`${label} cannot persist raw system content.`);
    }
  }
  if (message.referenceId !== undefined) {
    normalizeIdentifier(readString(message.referenceId, `${label}.referenceId`), 'message reference id');
  }
  if (message.content === undefined && message.referenceId === undefined) {
    throw new AgentTaskStoreValidationError(`${label} needs content or a reference id.`);
  }
}

function assertRunnerClaim(value: unknown, label: string): asserts value is AgentRunnerClaim {
  const claim = asRecord(value, label);
  assertEqual(claim.schemaVersion, AGENT_RUNNER_CLAIM_SCHEMA_VERSION, `${label}.schemaVersion`);
  normalizeIdentifier(readString(claim.claimId, `${label}.claimId`), 'runner claim id');
  normalizeIdentifier(readString(claim.runnerId, `${label}.runnerId`), 'runner id');
  normalizeIso(readString(claim.claimedAt, `${label}.claimedAt`), `${label}.claimedAt`);
  normalizeIso(readString(claim.renewedAt, `${label}.renewedAt`), `${label}.renewedAt`);
  normalizeIso(readString(claim.expiresAt, `${label}.expiresAt`), `${label}.expiresAt`);
}

function assertObservation(value: unknown, taskId: string, label: string): asserts value is AgentObservation {
  const observation = asRecord(value, label);
  assertEqual(observation.schemaVersion, AGENT_OBSERVATION_SCHEMA_VERSION, `${label}.schemaVersion`);
  normalizeIdentifier(readString(observation.id, `${label}.id`), 'observation id');
  assertEqual(observation.taskId, taskId, `${label}.taskId`);
  if (observation.stepId !== undefined) {
    normalizeIdentifier(readString(observation.stepId, `${label}.stepId`), 'step id');
  }
  readString(observation.capabilityId, `${label}.capabilityId`);
  if (
    observation.status !== 'success'
    && observation.status !== 'partial'
    && observation.status !== 'failed'
    && observation.status !== 'cancelled'
  ) {
    throw new AgentTaskStoreValidationError(`${label}.status is unsupported.`);
  }
  readString(observation.summary, `${label}.summary`);
  readArray(observation.evidence, `${label}.evidence`).forEach((entry, index) => {
    const evidenceLabel = `${label}.evidence[${index}]`;
    const evidence = asRecord(entry, evidenceLabel);
    readString(evidence.kind, `${evidenceLabel}.kind`);
    readString(evidence.reference, `${evidenceLabel}.reference`);
    if (evidence.summary !== undefined) readString(evidence.summary, `${evidenceLabel}.summary`);
    if (evidence.checksum !== undefined) readString(evidence.checksum, `${evidenceLabel}.checksum`);
  });
  readArray(observation.artifacts, `${label}.artifacts`).forEach((entry, index) => {
    assertArtifactReference(entry, `${label}.artifacts[${index}]`);
  });
  readArray(observation.warnings, `${label}.warnings`).forEach((warning, index) => {
    readString(warning, `${label}.warnings[${index}]`);
  });
  if (typeof observation.retryable !== 'boolean') {
    throw new AgentTaskStoreValidationError(`${label}.retryable must be boolean.`);
  }
  normalizeIso(readString(observation.occurredAt, `${label}.occurredAt`), `${label}.occurredAt`);
}

function assertApproval(value: unknown, taskId: string, label: string): asserts value is AgentApproval {
  const approval = asRecord(value, label);
  assertEqual(approval.schemaVersion, AGENT_APPROVAL_SCHEMA_VERSION, `${label}.schemaVersion`);
  normalizeIdentifier(readString(approval.id, `${label}.id`), 'approval id');
  assertEqual(approval.taskId, taskId, `${label}.taskId`);
  if (approval.stepId !== undefined) {
    normalizeIdentifier(readString(approval.stepId, `${label}.stepId`), 'step id');
  }
  readString(approval.capabilityId, `${label}.capabilityId`);
  readString(approval.canonicalProposalHash, `${label}.canonicalProposalHash`);
  asRecord(approval.proposal, `${label}.proposal`);
  if (
    approval.status !== 'pending'
    && approval.status !== 'approved'
    && approval.status !== 'denied'
    && approval.status !== 'expired'
    && approval.status !== 'revoked'
  ) {
    throw new AgentTaskStoreValidationError(`${label}.status is unsupported.`);
  }
  normalizeIso(readString(approval.requestedAt, `${label}.requestedAt`), `${label}.requestedAt`);
  if (approval.resolvedAt !== undefined) {
    normalizeIso(readString(approval.resolvedAt, `${label}.resolvedAt`), `${label}.resolvedAt`);
  }
  if (approval.expiresAt !== undefined) {
    normalizeIso(readString(approval.expiresAt, `${label}.expiresAt`), `${label}.expiresAt`);
  }
  if (approval.grantScope !== undefined && approval.grantScope !== 'once' && approval.grantScope !== 'task') {
    throw new AgentTaskStoreValidationError(`${label}.grantScope is unsupported.`);
  }
  if (approval.decision !== undefined) {
    const decision = asRecord(approval.decision, `${label}.decision`);
    if (
      decision.outcome !== 'approved'
      && decision.outcome !== 'denied'
      && decision.outcome !== 'expired'
      && decision.outcome !== 'revoked'
    ) {
      throw new AgentTaskStoreValidationError(`${label}.decision.outcome is unsupported.`);
    }
    if (decision.decidedBy !== 'user' && decision.decidedBy !== 'policy' && decision.decidedBy !== 'system') {
      throw new AgentTaskStoreValidationError(`${label}.decision.decidedBy is unsupported.`);
    }
    normalizeIso(readString(decision.decidedAt, `${label}.decision.decidedAt`), `${label}.decision.decidedAt`);
  }
}

function assertEventDraft(value: unknown): asserts value is AgentTaskEventDraft {
  assertJsonValue(value, 'agent task event draft');
  const draft = asRecord(value, 'agent task event draft');
  if (!EVENT_TYPES.has(draft.type as AgentTaskEventType)) {
    throw new AgentTaskStoreValidationError('Agent task event draft type is unsupported.');
  }
  if (draft.createdAt !== undefined) normalizeIso(readString(draft.createdAt, 'event timestamp'), 'event timestamp');
  if (draft.payload !== undefined) asRecord(draft.payload, 'event payload');
}

function assertEvent(
  value: unknown,
  taskId: string,
  traceId: string,
  expectedSequence: number,
): asserts value is AgentTaskEvent {
  assertJsonValue(value, `agent task ${taskId} event`);
  const event = asRecord(value, `agent task ${taskId} event`);
  assertEqual(event.schemaVersion, AGENT_TASK_EVENT_SCHEMA_VERSION, 'agent task event schemaVersion');
  normalizeIdentifier(readString(event.id, 'agent task event id'), 'event id');
  assertEqual(event.taskId, taskId, 'agent task event taskId');
  assertEqual(event.traceId, traceId, 'agent task event traceId');
  assertEqual(event.sequence, expectedSequence, 'agent task event sequence');
  if (!EVENT_TYPES.has(event.type as AgentTaskEventType)) {
    throw new AgentTaskStoreValidationError('Agent task event type is unsupported.');
  }
  normalizeIso(readString(event.createdAt, 'agent task event timestamp'), 'agent task event timestamp');
  if (event.payload !== undefined) asRecord(event.payload, 'agent task event payload');
}

function assertStoredDocument(value: unknown): asserts value is AgentTaskStoreDocument {
  assertJsonValue(value, 'agent task store');
  const document = asRecord(value, 'agent task store');
  assertEqual(document.schemaVersion, AGENT_TASK_STORE_SCHEMA_VERSION, 'agent task store schemaVersion');
  const tasks = asRecord(document.tasks, 'agent task store tasks');
  const requests = asRecord(document.clientRequests, 'agent task store client requests');
  normalizeIso(readString(document.updatedAt, 'agent task store updatedAt'), 'agent task store updatedAt');
  for (const [taskId, checkpointValue] of Object.entries(tasks)) {
    normalizeIdentifier(taskId, 'task id');
    const checkpoint = asRecord(checkpointValue, `agent task ${taskId} checkpoint`);
    assertEqual(
      checkpoint.schemaVersion,
      AGENT_CHECKPOINT_SCHEMA_VERSION,
      `agent task ${taskId} checkpoint schemaVersion`,
    );
    assertTask(checkpoint.task, `agent task ${taskId}`);
    const task = checkpoint.task;
    assertEqual(task.id, taskId, `agent task ${taskId} key`);
    if (task.checkpointVersion < 1) {
      throw new AgentTaskStoreValidationError(`Stored agent task ${taskId} checkpoint version must be positive.`);
    }
    const events = readArray(checkpoint.events, `agent task ${taskId} events`);
    const eventIds = new Set<string>();
    events.forEach((event, index) => {
      assertEvent(event, taskId, task.traceId, index + 1);
      if (eventIds.has(event.id)) {
        throw new AgentTaskStoreValidationError(`Agent task ${taskId} contains duplicate event ${event.id}.`);
      }
      eventIds.add(event.id);
    });
    assertEqual(task.eventSequence, events.length, `agent task ${taskId} eventSequence`);
    const observations = readArray(checkpoint.observations, `agent task ${taskId} observations`);
    const observationIds = new Set<string>();
    observations.forEach((observation, index) => {
      assertObservation(observation, taskId, `agent task ${taskId} observations[${index}]`);
      if (observationIds.has(observation.id)) {
        throw new AgentTaskStoreValidationError(
          `Agent task ${taskId} contains duplicate observation ${observation.id}.`,
        );
      }
      observationIds.add(observation.id);
    });
    const approvals = readArray(checkpoint.approvals, `agent task ${taskId} approvals`);
    const approvalIds = new Set<string>();
    approvals.forEach((approval, index) => {
      assertApproval(approval, taskId, `agent task ${taskId} approvals[${index}]`);
      if (approvalIds.has(approval.id)) {
        throw new AgentTaskStoreValidationError(`Agent task ${taskId} contains duplicate approval ${approval.id}.`);
      }
      approvalIds.add(approval.id);
    });
    normalizeIso(readString(checkpoint.savedAt, `agent task ${taskId} savedAt`), `agent task ${taskId} savedAt`);
  }
  for (const [requestId, receiptValue] of Object.entries(requests)) {
    normalizeIdentifier(requestId, 'client request id');
    const receipt = asRecord(receiptValue, `client request ${requestId}`);
    assertEqual(receipt.clientRequestId, requestId, `client request ${requestId} key`);
    const requestFingerprint = readString(
      receipt.requestFingerprint,
      `client request ${requestId} requestFingerprint`,
    );
    if (!/^[a-f0-9]{64}$/u.test(requestFingerprint)) {
      throw new AgentTaskStoreValidationError(`Client request ${requestId} fingerprint is invalid.`);
    }
    const taskId = normalizeIdentifier(readString(receipt.taskId, `client request ${requestId} taskId`), 'task id');
    if (!tasks[taskId]) {
      throw new AgentTaskStoreValidationError(`Client request ${requestId} references a missing task.`);
    }
    readNonNegativeInteger(receipt.checkpointVersion, `client request ${requestId} checkpointVersion`);
    const eventSequenceStart = readPositiveInteger(
      receipt.eventSequenceStart,
      `client request ${requestId} eventSequenceStart`,
    );
    readNonNegativeInteger(receipt.eventSequence, `client request ${requestId} eventSequence`);
    normalizeIso(readString(receipt.createdAt, `client request ${requestId} createdAt`), `client request ${requestId} createdAt`);
    const currentTask = (tasks[taskId] as AgentTaskCheckpoint).task;
    if ((receipt.checkpointVersion as number) > currentTask.checkpointVersion) {
      throw new AgentTaskStoreValidationError(`Client request ${requestId} points beyond the current checkpoint.`);
    }
    if ((receipt.eventSequence as number) > currentTask.eventSequence) {
      throw new AgentTaskStoreValidationError(`Client request ${requestId} points beyond the current event sequence.`);
    }
    if (eventSequenceStart > (receipt.eventSequence as number) + 1) {
      throw new AgentTaskStoreValidationError(`Client request ${requestId} has an invalid event range.`);
    }
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentTaskStoreValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new AgentTaskStoreValidationError(`${label} must be an array.`);
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentTaskStoreValidationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentTaskStoreValidationError(`${label} must be a non-negative integer.`);
  }
  return value as number;
}

function readPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new AgentTaskStoreValidationError(`${label} must be a positive integer.`);
  }
  return value as number;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new AgentTaskStoreValidationError(`${label} must equal ${String(expected)}.`);
  }
}

function parseLock(raw: string): AgentTaskLockDocument | null {
  try {
    const value = JSON.parse(raw) as unknown;
    const lock = asRecord(value, 'agent task lock');
    if (lock.schemaVersion !== AGENT_TASK_LOCK_SCHEMA_VERSION) return null;
    if (typeof lock.ownerId !== 'string' || !lock.ownerId) return null;
    if (!Number.isSafeInteger(lock.pid) || (lock.pid as number) <= 0) return null;
    if (lock.state !== 'choosing' && lock.state !== 'waiting' && lock.state !== 'held') return null;
    if (!Number.isSafeInteger(lock.ticket) || (lock.ticket as number) < 0) return null;
    if (typeof lock.createdAt !== 'string' || !Number.isFinite(Date.parse(lock.createdAt))) return null;
    if (typeof lock.expiresAt !== 'string' || !Number.isFinite(Date.parse(lock.expiresAt))) return null;
    return lock as unknown as AgentTaskLockDocument;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

async function unlinkLockClaim(filePath: string): Promise<void> {
  const retryableCodes = new Set(['EACCES', 'EBUSY', 'EPERM']);
  const maximumAttempts = process.platform === 'win32' ? 5 : 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await unlink(filePath);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      if (!retryableCodes.has(code ?? '') || attempt === maximumAttempts) throw error;
      await delay(5 * attempt);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
