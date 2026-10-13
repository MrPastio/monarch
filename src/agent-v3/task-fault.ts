/** Per-task fault isolation for the application progression pass.
 *
 * One task's synchronize() used to throw straight out of the pass: every later
 * task and family was skipped, the host recorded `progression-failed`, and the
 * next wake hit the same task first again. The agent lane stopped with no
 * outcome for anyone, measured live on 2026-09-18 ('evidence-shape').
 *
 * Isolation is fail-closed: only an error that provably belongs to one task's
 * own record or model output is contained. Journal, scheduler, ownership and
 * anything unrecognised still stop the host, which is the only safe response
 * to shared state that may be damaged.
 */

export interface AstraTaskFaultPolicy {
  /** Tasks already contained in this host lifetime; they are not re-driven. */
  skip(taskId: string): boolean;
  /** Contain a fault from one task, or rethrow it as host-level. */
  fault(taskId: string, error: unknown): void;
}

export function synchronizeEach<T>(taskIds: readonly string[], synchronize: (taskId: string) => T,
  policy?: AstraTaskFaultPolicy): T[] {
  if (!policy) return taskIds.map(synchronize);
  const views: T[] = [];
  for (const taskId of taskIds) {
    if (policy.skip(taskId)) continue;
    try { views.push(synchronize(taskId)); }
    catch (error) { policy.fault(taskId, error); }
  }
  return views;
}

/** Families whose `<prefix>:<code>` errors describe one task's own record,
 * decision or model output. `astra-journal`, `astra-scheduler` and every
 * prefix not listed here are host-level by omission. */
const TASK_FAULT_PREFIXES = new Set([
  'astra-agent-task', 'astra-agent-decision', 'astra-agent-certifier',
  'astra-model-work', 'astra-model-read-task', 'astra-context', 'astra-capability-work', 'astra-decision',
  'astra-read', 'astra-read-task', 'astra-read-certifier', 'astra-read-adapter', 'astra-workflow',
  'astra-create', 'astra-create-task', 'astra-create-certifier', 'astra-create-approval', 'astra-draft',
  'astra-computer-task', 'astra-computer-observe', 'astra-computer-action-task', 'astra-computer-action',
  'astra-computer-action-plan', 'astra-memory-recall',
]);
/** Codes inside those families that are about the host, not the task:
 * ownership, scheduler attachment, the shared index and pass budgets. */
const HOST_FAULT_CODES = new Set([
  'owner-required', 'draft-owner', 'scheduler-not-attached', 'scheduler-binding', 'progression-budget',
  'index', 'index-budget', 'work-envelope',
]);
const FAULT_MESSAGE = /^(astra-[a-z0-9-]+):([a-z0-9-]+)$/;

/** `prefix:code` of a task-level fault, or undefined when it must stay host-level. */
export function astraTaskFaultCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name === 'AstraJournalError') return undefined;
  const match = FAULT_MESSAGE.exec(error.message);
  if (!match || !TASK_FAULT_PREFIXES.has(match[1]!) || HOST_FAULT_CODES.has(match[2]!)) return undefined;
  return match[1] + ':' + match[2];
}

export interface AstraTaskFaultNotice { family: string; taskId: string; code: string; outcome: 'settled' | 'quarantined' }

/** Host-lifetime record of contained task faults.
 *
 * Anything not provably task-level is rethrown and stops the host as before:
 * journal, scheduler and ownership faults, unknown errors, a lost lease, and
 * the same code from three tasks in one pass (a shared cause, not a task).
 * A task is settled at most once; a second fault quarantines it, so a fault in
 * the settle path itself cannot loop. */
export class AstraTaskFaultContainment {
  private readonly faults = new Map<string, { code: string; quarantined: boolean }>();
  constructor(private readonly ownerIsCurrent: () => boolean,
    private readonly notify: (notice: AstraTaskFaultNotice) => void, private readonly capacity = 128) {}

  /** One policy per family for one progression call; `pass` is shared by the
   * families of that call so the same-code breaker sees all of them. */
  policy(family: string, pass: Map<string, Set<string>>,
    settle?: (taskId: string, reason: string) => unknown): AstraTaskFaultPolicy {
    return { skip: taskId => this.faults.get(taskId)?.quarantined === true,
      fault: (taskId, error) => this.contain(family, taskId, error, pass, settle) };
  }

  private contain(family: string, taskId: string, error: unknown, pass: Map<string, Set<string>>,
    settle?: (taskId: string, reason: string) => unknown): void {
    const code = astraTaskFaultCode(error);
    if (!code || !this.ownerIsCurrent()) throw error;
    const sameCode = pass.get(code) ?? new Set<string>(); sameCode.add(taskId); pass.set(code, sameCode);
    if (sameCode.size >= 3) throw error;
    const previous = this.faults.get(taskId);
    if (!previous && this.faults.size >= this.capacity) throw error;
    let outcome: AstraTaskFaultNotice['outcome'] = 'quarantined';
    if (!previous && settle) {
      this.faults.set(taskId, { code, quarantined: false });
      try { settle(taskId, astraTaskFaultReason(code)); outcome = 'settled'; }
      catch (settleError) { if (!astraTaskFaultCode(settleError) || !this.ownerIsCurrent()) throw settleError; }
    }
    if (outcome === 'quarantined') this.faults.set(taskId, { code, quarantined: true });
    try { this.notify({ family, taskId, code, outcome }); } catch { /* Reporting must not undo containment. */ }
  }
}

/** Durable stop reason for a contained fault; fits the task reason grammar. */
export function astraTaskFaultReason(code: string): string {
  return ('task-fault:' + code).slice(0, 96);
}
