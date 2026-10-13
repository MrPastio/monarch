import type { OscarTurnV1 } from '../oscar-turn';

export type OscarHistoryMessage = { role: 'user' | 'assistant'; content: string };

/** One Kernel-observed action of an agent task, as the Astra task view reports it. */
export interface OscarDurableAgentAction {
  capabilityId: string;
  state: 'proposed' | 'observed' | 'failed';
  ok?: boolean;
  target?: string;
}

export interface OscarDurableHistoryPorts {
  /** Delivers answers that finished but are not yet in the conversation store. */
  flushOutbox(): Promise<void>;
  readConversation(conversationId: string, messageLimit: number): Promise<unknown>;
  readTurn(turnId: string): Promise<OscarTurnV1 | null>;
  agentActions(turn: OscarTurnV1): OscarDurableAgentAction[];
}

export const OSCAR_DURABLE_HISTORY_LIMIT = 24;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_ACTION_LINES = 8;
const HIDDEN_ASSISTANT_OUTCOMES = new Set(['failed', 'cancelled', 'blocked']);

/** Opens the note Monarch appends to an agent reply in model context. */
export const OSCAR_AGENT_ACTION_NOTE_MARKER = '[Записано Monarch: для этого ответа Оскар выполнил действия, подтверждённые Kernel]';

/** The reply as it was saved. The local backend matches history against the
 * store by text, so it must receive the saved wording, not the annotated one. */
export function withoutOscarAgentActionNote(content: string): string {
  const index = content.indexOf(OSCAR_AGENT_ACTION_NOTE_MARKER);
  return index < 0 ? content : content.slice(0, index).trimEnd();
}

/**
 * The conversation as the model should see it: what was actually saved, not
 * what one window happened to be showing. A reply that vanished from the
 * screen, an answer finished a moment ago, or a turn from Telegram are all
 * here; an error notice is not, so the model never mistakes it for its answer.
 *
 * Returns null only when the store cannot be read at all; a conversation the
 * store has never seen is a new one and has no history.
 */
export async function readOscarDurableHistory(
  conversationId: string,
  ports: OscarDurableHistoryPorts,
  options: { excludeTurnIds?: readonly string[]; limit?: number; timeoutMs?: number } = {},
): Promise<OscarHistoryMessage[] | null> {
  // A slow or restarting store must not hold the person's message hostage;
  // the caller then falls back to the copy it was sent.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), options.timeoutMs ?? 4_000); });
  try {
    return await Promise.race([readHistory(conversationId, ports, options), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readHistory(
  conversationId: string,
  ports: OscarDurableHistoryPorts,
  options: { excludeTurnIds?: readonly string[]; limit?: number },
): Promise<OscarHistoryMessage[] | null> {
  // Undelivered answers stay queued and are retried by the coordinator; a
  // flush failure only means the newest reply may be missing, not that the
  // saved conversation is unreadable.
  await ports.flushOutbox().catch(() => undefined);
  let payload: unknown;
  try {
    payload = await ports.readConversation(conversationId, options.limit ?? OSCAR_DURABLE_HISTORY_LIMIT);
  } catch (error) {
    if ((error as { statusCode?: unknown })?.statusCode === 404) return [];
    return null;
  }
  const messages = (payload as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return null;
  const excluded = new Set(options.excludeTurnIds ?? []);
  const history: OscarHistoryMessage[] = [];
  for (const entry of messages) {
    const message = entry as Record<string, unknown>;
    const role = message.role;
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if ((role !== 'user' && role !== 'assistant') || !content) continue;
    const turnId = typeof message.turn_id === 'string' ? message.turn_id : '';
    if (turnId && excluded.has(turnId)) continue;
    if (role === 'assistant' && HIDDEN_ASSISTANT_OUTCOMES.has(String(message.outcome || ''))) continue;
    const actions = role === 'assistant' && turnId ? await describeAgentActions(turnId, ports) : '';
    // The note counts against the same per-message limit the Turn enforces.
    history.push({ role, content: `${content.slice(0, MAX_MESSAGE_CHARS - actions.length)}${actions}` });
  }
  return history;
}

/** A compact, factual note of what the agent really did for this answer, so a
 * later plain chat turn cannot deny actions it has no other way to see. */
async function describeAgentActions(turnId: string, ports: OscarDurableHistoryPorts): Promise<string> {
  let turn: OscarTurnV1 | null;
  try { turn = await ports.readTurn(turnId); } catch { return ''; }
  if (!turn || turn.mode !== 'agent') return '';
  let actions: OscarDurableAgentAction[];
  try { actions = ports.agentActions(turn); } catch { return ''; }
  const counts = new Map<string, number>();
  for (const action of actions) {
    if (action.state === 'proposed') continue;
    const result = action.state === 'failed' || action.ok === false ? 'ошибка' : 'успешно';
    const target = action.target ? ` ${action.target.slice(0, 160)}` : '';
    const key = `${action.capabilityId}${target} — ${result}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  const lines = [...counts].slice(0, MAX_ACTION_LINES)
    .map(([key, count]) => `- ${key}${count > 1 ? ` ×${count}` : ''}`);
  const more = counts.size > MAX_ACTION_LINES ? `\n- и ещё ${counts.size - MAX_ACTION_LINES}` : '';
  return `\n\n${OSCAR_AGENT_ACTION_NOTE_MARKER}\n${lines.join('\n')}${more}`;
}
