import { validateAstraSourceGoal, type AstraSourceGoalInput } from '../agent-v3/source-goal-contract';
import type { AstraAuthenticatedHttpActor, AstraTaskHttpTask } from '../app/astra-task-facade';
import type { AstraDraftReply } from '../agent-v3/model-create-task-state';
import type { AstraCreateApprovalDecision } from '../agent-v3/create-approval';
import type { OscarTurnV1 } from './types';

/** Explicit isolated HTTP/host selection. Opaque handles never grant path access. */
export type OscarAstraComputerGoal = { kind: 'computer-observe' } | { kind: 'computer-action' };
export interface OscarAstraSelection { selectionId: string; goal: AstraSourceGoalInput | OscarAstraComputerGoal }
/** Separate closed actions: observing a window never becomes input authority and
 * an action request names only a pre-issued host plan, never native parameters. */
export function validateOscarAstraGoal(goal: OscarAstraSelection['goal']): void {
  if (goal?.kind === 'computer-observe' || goal?.kind === 'computer-action') {
    if (Object.keys(goal).length !== 1) throw Error('astra-oscar-invalid-computer-goal');
  } else validateAstraSourceGoal(goal, goal?.kind === 'agent' ? 'agent'
    : goal?.kind === 'observe' || goal?.kind === 'analyze' ? 'read' : 'create');
}
export interface OscarAstraBinding extends OscarAstraSelection {
  version: 'astra-oscar-isolated-v1'; actor: AstraAuthenticatedHttpActor;
  /** Read-only compatibility for turns admitted before phrase activation was
   * retired. New ordinary product turns may bind only ordinary-agent-v1. */
  admission?: 'ordinary-exact-create-v1' | 'ordinary-exact-read-v1' | 'ordinary-agent-v1';
}
export function validateAstraAuthenticatedActor(value: unknown): asserts value is AstraAuthenticatedHttpActor {
  const actor = value as AstraAuthenticatedHttpActor | null | undefined;
  if (!actor || Object.keys(actor).some(key => !['id', 'source'].includes(key))
    || !/^sha256:[a-f0-9]{64}$/u.test(actor.id)
    || !['desktop', 'voice', 'api', 'telegram', 'coder', 'system'].includes(actor.source)) {
    throw Error('astra-oscar-invalid-actor');
  }
}
export type OscarAstraInput = { kind: 'reply'; reply: AstraDraftReply }
  | { kind: 'decide'; decision: AstraCreateApprovalDecision };
/** Transport adapter, never an executor, scheduler or lifecycle owner. */
export interface OscarAstraPort {
  /** Post-disposition semantic agent binding. It selects the V3 task owner,
   * never a capability, and is durably committed before task admission. */
  bindAgent?(turn: OscarTurnV1): OscarAstraBinding | null;
  /** Refresh model availability that bindAgent reads synchronously (whether a
   * connected MAX provider is ready). Called right before binding. */
  refreshAgentAvailability?(): Promise<void>;
  bind(turn: OscarTurnV1, selection: OscarAstraSelection, authenticatedActor?: AstraAuthenticatedHttpActor): OscarAstraBinding;
  find(turn: OscarTurnV1): AstraTaskHttpTask | null;
  prepare?(turn: OscarTurnV1): Promise<unknown>;
  submit(turn: OscarTurnV1, prepared?: unknown): AstraTaskHttpTask;
  input(turn: OscarTurnV1, input: OscarAstraInput): AstraTaskHttpTask;
  command(turn: OscarTurnV1, command: 'pause' | 'resume' | 'cancel'): AstraTaskHttpTask;
  /** Wake the same admitted task/host; never create a replacement or reset controls. */
  wake?(turn: OscarTurnV1): void;
  acknowledge(turn: OscarTurnV1, digest: string): void;
}
export function validateOscarAstraBinding(value: OscarAstraBinding): void {
  if (!value || value.version !== 'astra-oscar-isolated-v1'
    || Object.keys(value).some(key => !['version', 'actor', 'selectionId', 'goal', 'admission'].includes(key))
    || value.admission !== undefined && !['ordinary-exact-create-v1', 'ordinary-exact-read-v1', 'ordinary-agent-v1'].includes(value.admission)
    || typeof value.selectionId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value.selectionId)
    || !value.actor)
    throw Error('astra-oscar-invalid-binding');
  try { validateAstraAuthenticatedActor(value.actor); } catch { throw Error('astra-oscar-invalid-binding'); }
  validateOscarAstraGoal(value.goal);
}
