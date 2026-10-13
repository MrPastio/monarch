import type { OscarTurnCoordinator } from '../oscar-turn/coordinator';
import type { OscarTurnV1 } from '../oscar-turn/types';
import { validateOscarAstraGoal, type OscarAstraInput, type OscarAstraSelection } from '../oscar-turn/astra-contract';
import type { AstraAuthenticatedHttpActor } from './astra-task-facade';
import type { AstraTargetSelectionSurface } from './astra-target-selection-store';

/** HTTP metadata supplied by the server, never request body/header assertions. */
export interface AstraOscarHttpContext {
  enabled: boolean; loopback: boolean;
  authenticatedActor(source?: Extract<OscarTurnV1['source'], 'desktop' | 'voice' | 'api'>): AstraAuthenticatedHttpActor;
  selections?: AstraTargetSelectionSurface;
}
function check(value: unknown, statusCode: number, code: string): asserts value {
  if (!value) throw Object.assign(Error(code), { statusCode, code });
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), 400, 'astra-invalid-request');
}
function actor(context: AstraOscarHttpContext | undefined): AstraAuthenticatedHttpActor {
  check(context?.loopback, 403, 'astra-loopback-required'); return context.authenticatedActor();
}
export function ownsOscarAstraTurn(turn: OscarTurnV1, context: AstraOscarHttpContext | undefined): boolean {
  if (!turn.request.astra) return true;
  try { const current = actor(context); return current.id === turn.request.astra.actor.id && current.source === turn.request.astra.actor.source; }
  catch { return false; }
}
export function assertOscarAstraOwner(turn: OscarTurnV1, context: AstraOscarHttpContext | undefined): void {
  check(ownsOscarAstraTurn(turn, context), 404, 'turn-not-found');
}
export async function submitOscarAstraHttp(coordinator: OscarTurnCoordinator, body: Record<string, unknown>, context: AstraOscarHttpContext | undefined, zeroRetention: boolean) {
  check(context?.enabled, 404, 'astra-runtime-disabled'); const current = actor(context);
  fields(body, ['version', 'clientRequestId', 'conversationId', 'inputMessageId', 'text', 'privacyMode', 'surface', 'astra']);
  check(body.version === 1 && !zeroRetention && body.privacyMode === 'persistent', 409, 'astra-persistent-source-required');
  check(body.surface === undefined || body.surface === current.source, 403, 'untrusted-oscar-source');
  check(id(body.clientRequestId) && id(body.conversationId) && id(body.inputMessageId) && typeof body.text === 'string', 400, 'astra-invalid-source');
  fields(body.astra, ['selectionId', 'goal']); check(id(body.astra.selectionId), 400, 'astra-invalid-selection');
  const selection = body.astra as unknown as OscarAstraSelection;
  try { validateOscarAstraGoal(selection.goal); } catch { throw Object.assign(Error('astra-invalid-goal'), { statusCode: 400, code: 'astra-invalid-goal' }); }
  check(!['computer-observe', 'computer-action'].includes(selection.goal.kind) || current.source === 'desktop', 403, 'astra-desktop-source-required');
  return coordinator.submit({ clientRequestId: body.clientRequestId, conversationId: body.conversationId, inputMessageId: body.inputMessageId,
    text: body.text, source: current.source, privacyMode: 'persistent', astra: structuredClone(selection), astraActor: current });
}
export async function submitOscarAstraInputHttp(coordinator: OscarTurnCoordinator, turn: OscarTurnV1, body: Record<string, unknown>, context: AstraOscarHttpContext | undefined) {
  check(context?.enabled && turn.request.astra, 404, 'astra-runtime-disabled'); assertOscarAstraOwner(turn, context);
  check(['create', 'computer-action', 'agent'].includes(turn.request.astra.goal.kind), 409, 'astra-input-unsupported');
  fields(body, ['version', 'conversationId', 'inputMessageId', 'input']);
  check(body.version === 1 && body.conversationId === turn.conversationId && body.inputMessageId === turn.inputMessageId, 409, 'astra-input-source-mismatch');
  fields(body.input, ['kind', 'reply', 'decision']);
  const input = body.input as unknown as OscarAstraInput;
  if (input.kind === 'reply') check(['create', 'agent'].includes(turn.request.astra.goal.kind), 409, 'astra-input-unsupported');
  try {
    if (input.kind === 'reply') {
      fields(input, ['kind', 'reply']); const { validateDraftReply } = await import('../agent-v3/model-create-task-state');
      validateDraftReply(input.reply, turn.request.astra.goal.kind === 'create' && turn.request.astra.goal.content.kind === 'reply' ? 'literal-content' : 'draft-guidance');
    } else {
      check(input.kind === 'decide', 400, 'astra-invalid-input'); fields(input, ['kind', 'decision']);
      const { validateCreateApprovalDecision } = await import('../agent-v3/create-approval'); validateCreateApprovalDecision(input.decision);
    }
  } catch { throw Object.assign(Error('astra-invalid-input'), { statusCode: 400, code: 'astra-invalid-input' }); }
  return coordinator.submitAstraInput(turn.id, turn.source, input);
}
