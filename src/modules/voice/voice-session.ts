import { randomBytes } from 'node:crypto';

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 8;
const MAX_MESSAGES = 16;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARACTERS = 3_200;
const MAX_PENDING_TURNS = 2;

export interface VoiceSessionContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface VoiceSessionTurnContext {
  sessionId: string;
  turnId: string;
  history: VoiceSessionContextMessage[];
  contextualText: string;
  contextDependent: boolean;
}

interface VoiceSessionMessage extends VoiceSessionContextMessage {
  actionId?: string;
}

interface PendingVoiceTurn {
  id: string;
  text: string;
  createdAt: number;
}

interface VoiceSessionRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  messages: VoiceSessionMessage[];
  pending: Map<string, PendingVoiceTurn>;
}

export class VoiceSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'VoiceSessionError';
  }
}

/** Ephemeral, bounded conversation memory owned by the Voice module. */
export class VoiceSessionStore {
  private readonly sessions = new Map<string, VoiceSessionRecord>();

  constructor(
    private readonly ttlMs = DEFAULT_SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  start(): { sessionId: string; expiresAt: string } {
    this.cleanupExpired();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = Array.from(this.sessions.values())
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!oldest) break;
      this.sessions.delete(oldest.id);
    }

    const createdAt = this.now();
    const record: VoiceSessionRecord = {
      id: randomBytes(24).toString('base64url'),
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + this.ttlMs,
      messages: [],
      pending: new Map(),
    };
    this.sessions.set(record.id, record);
    return { sessionId: record.id, expiresAt: new Date(record.expiresAt).toISOString() };
  }

  beginTurn(sessionId: string, text: string): VoiceSessionTurnContext {
    const session = this.requireSession(sessionId);
    const cleanText = cleanVoiceText(text, 1_200);
    if (!cleanText) {
      throw new VoiceSessionError('voice-session-text-empty', 'Voice session turn needs a non-empty transcript.');
    }

    while (session.pending.size >= MAX_PENDING_TURNS) {
      const oldest = Array.from(session.pending.values())
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!oldest) break;
      session.pending.delete(oldest.id);
    }

    const turn: PendingVoiceTurn = {
      id: randomBytes(16).toString('base64url'),
      text: cleanText,
      createdAt: this.now(),
    };
    session.pending.set(turn.id, turn);
    this.touch(session);

    const history = boundedContext(session.messages);
    const contextDependent = isContextDependentVoiceTurn(cleanText);
    return {
      sessionId: session.id,
      turnId: turn.id,
      history,
      contextualText: contextDependent ? buildContextualText(history, cleanText) : cleanText,
      contextDependent,
    };
  }

  completeTurn(
    sessionId: string,
    turnId: string,
    response: string,
    actionId?: string,
  ): { sessionId: string; messageCount: number; expiresAt: string } {
    const session = this.requireSession(sessionId);
    const pending = session.pending.get(turnId);
    if (!pending) {
      throw new VoiceSessionError('voice-session-turn-not-found', 'Voice session turn is missing or already completed.');
    }
    const cleanResponse = cleanVoiceText(response, 2_000);
    if (!cleanResponse) {
      throw new VoiceSessionError('voice-session-response-empty', 'Voice session response must not be empty.');
    }

    session.pending.delete(turnId);
    session.messages.push({ role: 'user', content: pending.text });
    session.messages.push({
      role: 'assistant',
      content: cleanResponse,
      ...(actionId ? { actionId: cleanVoiceText(actionId, 120) } : {}),
    });
    if (session.messages.length > MAX_MESSAGES) {
      session.messages.splice(0, session.messages.length - MAX_MESSAGES);
    }
    this.touch(session);
    return {
      sessionId: session.id,
      messageCount: session.messages.length,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  close(sessionId: string): boolean {
    return this.sessions.delete(String(sessionId || '').trim());
  }

  clear(): void {
    this.sessions.clear();
  }

  snapshot(): { activeSessions: number; pendingTurns: number; ttlMs: number } {
    this.cleanupExpired();
    return {
      activeSessions: this.sessions.size,
      pendingTurns: Array.from(this.sessions.values())
        .reduce((total, session) => total + session.pending.size, 0),
      ttlMs: this.ttlMs,
    };
  }

  private requireSession(sessionId: string): VoiceSessionRecord {
    this.cleanupExpired();
    const id = String(sessionId || '').trim();
    const session = this.sessions.get(id);
    if (!session) {
      throw new VoiceSessionError('voice-session-not-found', 'Voice session is missing or expired.');
    }
    return session;
  }

  private touch(session: VoiceSessionRecord): void {
    session.updatedAt = this.now();
    session.expiresAt = session.updatedAt + this.ttlMs;
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

function boundedContext(messages: VoiceSessionMessage[]): VoiceSessionContextMessage[] {
  const selected: VoiceSessionContextMessage[] = [];
  let characters = 0;
  for (const message of messages.slice(-MAX_CONTEXT_MESSAGES).reverse()) {
    const remaining = MAX_CONTEXT_CHARACTERS - characters;
    if (remaining <= 0) break;
    const content = message.content.slice(0, Math.min(800, remaining));
    selected.push({ role: message.role, content });
    characters += content.length;
  }
  return selected.reverse();
}

function isContextDependentVoiceTurn(text: string): boolean {
  const normalized = text.toLowerCase().replace(/ё/g, 'е').trim();
  if (normalized.length > 260) return false;
  return /^(?:а|и|ну а|тогда|еще|ещё|теперь)(?=\s|$)/u.test(normalized)
    || /^(?:найди|поищи|расскажи|покажи)\s+(?:подробнее|еще|ещё|больше)(?=\s|$)/u.test(normalized)
    || /(?:^|\s)(?:он|она|оно|они|ему|ей|его|ее|её|их|там|туда|это|этот|эта|эти|тот|та|такой|с ним|с ней)(?=\s|$|[?.!,])/u.test(normalized)
    || /^(?:подробнее|продолжай|а дальше|что насчет|что насчёт|почему|когда|где|сколько|какой именно)\??$/u.test(normalized);
}

function buildContextualText(history: VoiceSessionContextMessage[], text: string): string {
  const recent = history.slice(-4).map((message) => (
    `${message.role === 'user' ? 'Пользователь' : 'Oscar'}: ${message.content}`
  ));
  return [...recent, `Текущий запрос: ${text}`].join('\n').slice(-560);
}

function cleanVoiceText(value: unknown, maxLength: number): string {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
