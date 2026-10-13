import { DatabaseSync } from 'node:sqlite';
import { decodeStoreLine, encodeStoreLine, storeProtection } from '../../core/store-protection';
import { mkdirSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createFilesystemPolicy, evaluateFilesystemAccess } from '../../core/filesystem-policy';
import { isExecutableMaxRole } from '../../agent-v3/max-native-contract';

export interface TelegramEnvelopeV2 {
  version: 2;
  ownerUserId: number;
  controlChatId: number;
  botId: number;
  pairingEpoch: string;
  threadId: number;
  conversationId: string;
  requestId: string;
}
export interface ConversationBinding {
  id: string;
  threadId: number;
  conversationId: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  cloudEnabled: boolean;
  cloudRevision: number;
  localOnly: boolean;
}
export interface TelegramV2Settings {
  version: 2;
  enabled: boolean;
  ownerUserId: number;
  controlChatId: number;
  botId: number;
  pairingEpoch: string;
  historyEnabled: boolean;
  paused: boolean;
  queueMode: 'confirm' | 'scoped-auto';
}
export interface RemoteGrant {
  id: string;
  root: string;
  capabilities: string[];
  expiresAt: number;
  epoch: string;
}
interface RequestBinding { actor: TelegramEnvelopeV2; textDigest: string; grantId: string | null; modelRole?: string }
const liveContexts = new WeakMap<object, TelegramEnvelopeV2>();
export const authenticatedTelegramContext = (context: object) => liveContexts.get(context);
export const telegramDigest = (text: string) => createHash('sha256').update(text).digest('hex');
const defaultSettings = (): TelegramV2Settings => ({ version: 2, enabled: false, ownerUserId: 0,
  controlChatId: 0, botId: 0, pairingEpoch: '', historyEnabled: false, paused: true, queueMode: 'confirm' });
export const TELEGRAM_REMOTE_FILE_CAPABILITIES = ['workspace.files.read', 'workspace.files.list',
  'workspace.files.search', 'workspace.files.write', 'workspace.files.mkdir'] as const;
const CONTROL_CAPABILITIES = new Set(['telegram.capabilities.describe', 'telegram.reminder.create',
  'telegram.reminder.list', 'telegram.reminder.cancel', 'telegram.poll.send']);

/** The desktop alone changes settings/grants. Transport contexts are branded in
 * memory, and request bindings are persisted before an AgentTask can start. */
const TELEGRAM_STORE_ID = 'telegram-v2-records';

export class TelegramV2Store {
  private db: DatabaseSync | undefined;
  constructor(private readonly stateRoot: string, private readonly workspaceRoot: string,
    private readonly now: () => number = Date.now) {}
  /** Record values follow Monarch Security storage protection: each value is
   * sealed on its own (kind and id stay readable for lookups), the database
   * lives in memory for a session without OS encryption, and plain values left
   * by an earlier version are sealed once when the database opens. */
  private database(): DatabaseSync {
    if (this.db) return this.db;
    const session = storeProtection().mode === 'session';
    if (session) {
      this.db = new DatabaseSync(':memory:');
    } else {
      const directory = path.join(this.stateRoot, 'telegram-v2');
      mkdirSync(directory, { recursive: true });
      this.db = new DatabaseSync(path.join(directory, 'control.sqlite'));
    }
    this.db.exec(`${session ? '' : 'PRAGMA journal_mode=WAL; '}PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(kind,id));`);
    if (!session) this.sealPlainValues(this.db);
    return this.db;
  }
  private sealPlainValues(db: DatabaseSync): void {
    if (storeProtection().mode !== 'sealed') return;
    const plain = db.prepare("SELECT rowid AS id, value FROM records WHERE value NOT LIKE 'MSF1:%'").all();
    if (!plain.length) return;
    const update = db.prepare('UPDATE records SET value=? WHERE rowid=?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of plain) update.run(encodeStoreLine(String(row.value), TELEGRAM_STORE_ID), Number(row.id));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // secure_delete clears freed cells; VACUUM and a checkpoint leave no old pages.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }
  private decode<T>(value: unknown): T {
    return JSON.parse(decodeStoreLine(String(value), TELEGRAM_STORE_ID).text) as T;
  }
  read<T>(kind: string, id: string): T | null {
    const row = this.database().prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? this.decode<T>(row.value) : null;
  }
  list<T>(kind: string): T[] {
    return this.database().prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid DESC LIMIT 1000')
      .all(kind).map(row => this.decode<T>(row.value));
  }
  put(kind: string, id: string, value: unknown): void {
    this.database().prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value')
      .run(kind, id, encodeStoreLine(JSON.stringify(value), TELEGRAM_STORE_ID));
  }
  remove(kind: string, id: string): void {
    this.database().prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  }
  /** Expired buttons and all but the newest 512 go. Values are sealed, so the
   * expiry is read here rather than by SQLite. */
  pruneUi(): void {
    const rows = this.database().prepare("SELECT rowid AS id, value FROM records WHERE kind='ui-button' ORDER BY rowid DESC").all();
    const now = this.now();
    const remove = this.database().prepare('DELETE FROM records WHERE rowid=?');
    rows.forEach((row, index) => {
      let expiresAt = Number.POSITIVE_INFINITY;
      try { expiresAt = Number(this.decode<{ expiresAt?: unknown }>(row.value)?.expiresAt ?? Number.POSITIVE_INFINITY); }
      catch { expiresAt = Number.NEGATIVE_INFINITY; }
      if (index >= 512 || expiresAt < now) remove.run(Number(row.id));
    });
  }
  transaction<T>(work: () => T): T {
    this.database().exec('BEGIN IMMEDIATE');
    try { const value = work(); this.database().exec('COMMIT'); return value; }
    catch (error) { this.database().exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db?.close(); this.db = undefined; }
  settings(): TelegramV2Settings { return this.read<TelegramV2Settings>('settings', 'local') ?? defaultSettings(); }
  configure(input: { ownerUserId: number; controlChatId: number; botId: number; pairingEpoch: string; historyEnabled: boolean }): TelegramV2Settings {
    if (![input.ownerUserId, input.controlChatId, input.botId].every(x => Number.isSafeInteger(x) && x > 0)
      || !input.pairingEpoch || input.pairingEpoch.length > 128) throw Error('telegram-v2:invalid-owner');
    const previous = this.settings();
    if (previous.enabled && (previous.ownerUserId !== input.ownerUserId || previous.botId !== input.botId
      || previous.controlChatId !== input.controlChatId)) throw Error('telegram-v2:revoke-before-rebinding');
    const result: TelegramV2Settings = { ...defaultSettings(), ...input, enabled: true, paused: false };
    this.put('settings', 'local', result);
    return result;
  }
  pause(): void { const s = this.settings(); this.put('settings', 'local', { ...s, paused: true }); }
  resume(): void { const s = this.settings(); if (!s.enabled) throw Error('telegram-v2:not-configured'); this.put('settings', 'local', { ...s, paused: false }); }
  setQueueMode(queueMode: TelegramV2Settings['queueMode']): void {
    const s = this.settings(); if (!s.enabled || !['confirm', 'scoped-auto'].includes(queueMode)) throw Error('telegram-v2:queue-mode');
    if (queueMode === 'scoped-auto' && !this.activeGrant()) throw Error('Сначала открой временный доступ к рабочей папке.');
    this.put('settings', 'local', { ...s, queueMode });
  }
  revoke(): void {
    this.transaction(() => { this.put('settings', 'local', { ...defaultSettings(), pairingEpoch: randomUUID() });
      this.database().prepare("DELETE FROM records WHERE kind IN ('grant','pair-challenge','pair-candidate','binding','request')").run(); });
  }
  pairingChallenge(): { token: string; expiresAt: number } {
    const challenge = { token: randomBytes(24).toString('base64url'), expiresAt: this.now() + 5 * 60_000 };
    this.transaction(() => {
      this.remove('pair-candidate', 'current');
      this.put('pair-challenge', 'current', { digest: telegramDigest(challenge.token), expiresAt: challenge.expiresAt });
    });
    return challenge;
  }
  proposePairing(token: string, candidate: { userId: number; chatId: number; botId: number }): void {
    this.transaction(() => {
      const challenge = this.read<{ digest: string; expiresAt: number }>('pair-challenge', 'current');
      if (!challenge || challenge.expiresAt <= this.now() || challenge.digest !== telegramDigest(token)
        || ![candidate.userId, candidate.chatId, candidate.botId].every(x => Number.isSafeInteger(x) && x > 0)) throw Error('telegram-v2:pairing-expired');
      this.remove('pair-challenge', 'current');
      this.put('pair-candidate', 'current', { ...candidate, expiresAt: challenge.expiresAt });
    });
  }
  assertOwner(chatId: number, userId: number, botId?: number): TelegramV2Settings {
    const s = this.settings();
    if (!s.enabled || s.paused || s.controlChatId !== chatId || s.ownerUserId !== userId
      || botId !== undefined && s.botId !== botId) throw Error('telegram-v2:owner-required');
    return s;
  }
  bindings(): ConversationBinding[] { return this.list<ConversationBinding>('binding'); }
  binding(threadId: number): ConversationBinding | null { return this.bindings().find(b => b.threadId === threadId) ?? null; }
  bind(threadId: number, conversationId: string, title: string): ConversationBinding {
    if (!Number.isSafeInteger(threadId) || threadId < 0 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(conversationId)) throw Error('telegram-v2:invalid-conversation');
    return this.transaction(() => {
      const previous = this.binding(threadId);
      if (previous && previous.conversationId !== conversationId) throw Error('telegram-v2:topic-already-bound');
      const result = previous ?? { id: randomBytes(12).toString('hex'), threadId, conversationId,
        title: title.trim().slice(0, 128) || 'Новый чат', pinned: false, archived: false, cloudEnabled: false, cloudRevision: 1, localOnly: false };
      this.put('binding', result.id, result); return result;
    });
  }
  updateBinding(id: string, patch: Partial<Pick<ConversationBinding, 'title' | 'pinned' | 'archived' | 'cloudEnabled' | 'localOnly'>>): ConversationBinding {
    const b = this.read<ConversationBinding>('binding', id); if (!b) throw Error('telegram-v2:conversation-not-found');
    const next = { ...b, ...patch, title: (patch.title ?? b.title).trim().slice(0, 128) || 'Новый чат' };
    if (next.localOnly || next.archived) next.cloudEnabled = false;
    if (next.cloudEnabled !== b.cloudEnabled || next.localOnly !== b.localOnly || next.archived !== b.archived) next.cloudRevision = (b.cloudRevision ?? 1) + 1;
    if (b.cloudEnabled && !next.cloudEnabled) this.put('cloud-revoke', String(b.threadId), { threadId: b.threadId, revision: next.cloudRevision });
    this.put('binding', id, next); return next;
  }
  context(chatId: number, userId: number, threadId: number, messageId: number | undefined,
    base: Record<string, unknown>, text?: string): Record<string, unknown> {
    const s = this.assertOwner(chatId, userId);
    let binding = this.binding(threadId);
    if (!binding) binding = this.bind(threadId, threadId === 0 ? `telegram:${chatId}:${userId}` : randomUUID().replaceAll('-', ''), 'Новый чат');
    if (binding.archived || binding.localOnly) throw Error('telegram-v2:conversation-unavailable');
    const actor: TelegramEnvelopeV2 = { version: 2, ownerUserId: userId, controlChatId: chatId, botId: s.botId,
      pairingEpoch: s.pairingEpoch, threadId, conversationId: binding.conversationId,
      requestId: `telegram:${s.botId}:${s.pairingEpoch}:${chatId}:${messageId ?? 'control'}` };
    const context = { ...base, clientConversationId: actor.conversationId, clientSessionId: actor.conversationId,
      clientRequestId: actor.requestId, telegramThreadId: threadId };
    liveContexts.set(context, actor);
    if (text !== undefined && messageId !== undefined) {
      this.transaction(() => {
        const prior = this.read<RequestBinding>('request', actor.requestId);
        if (prior && (prior.textDigest !== telegramDigest(text) || prior.actor.conversationId !== actor.conversationId)) throw Error('telegram-v2:request-conflict');
        if (!prior) this.put('request', actor.requestId, { actor, textDigest: telegramDigest(text), grantId: this.activeGrant()?.id ?? null,
          ...(this.modelForThread(threadId) ? { modelRole: this.modelForThread(threadId) } : {}) });
      });
    }
    return context;
  }
  request(id: string): RequestBinding | null { return this.read<RequestBinding>('request', id); }
  configureModel(role: string | null, consent: boolean): void {
    const s = this.settings();
    if (!s.enabled || role !== null && (!isExecutableMaxRole(role) || !consent)) throw Error('Разреши обработку выбранным MAX для Telegram в Monarch.');
    this.put('model-access', 'local', { epoch: s.pairingEpoch, role });
  }
  configureGlobalModel(enabled: boolean, role?: string): void {
    if (!this.settings().enabled || role !== undefined && !isExecutableMaxRole(role)) throw Error('Модель недоступна.');
    this.put('model-access', 'local', { epoch: this.settings().pairingEpoch, role: enabled ? role ?? null : null, followGlobal: enabled });
  }
  followsGlobalModel(): boolean {
    const a = this.read<{ epoch: string; followGlobal?: boolean }>('model-access', 'local');
    return a?.epoch === this.settings().pairingEpoch && a.followGlobal === true;
  }
  allowedModel(): string | undefined {
    const a = this.read<{ epoch: string; role: string | null }>('model-access', 'local');
    return a?.epoch === this.settings().pairingEpoch && a.role && isExecutableMaxRole(a.role) ? a.role : undefined;
  }
  selectModel(threadId: number, max: boolean): void {
    if (!this.settings().enabled || this.settings().paused || max && !this.allowedModel()) throw Error('Модель недоступна.');
    this.put('model-choice', String(threadId), { epoch: this.settings().pairingEpoch, max });
  }
  modelForThread(threadId: number): string | undefined {
    const choice = this.read<{ epoch: string; max: boolean }>('model-choice', String(threadId));
    if (choice?.epoch !== this.settings().pairingEpoch || !choice.max) return undefined;
    const role = this.allowedModel();
    if (!role) throw Error('MAX недоступен. Проверь выбранного провайдера в настройках MAX.');
    return role;
  }
  grant(root: string, capabilities: string[], ttlMs = 30 * 60_000): RemoteGrant {
    const s = this.settings(); if (!s.enabled || s.paused) throw Error('telegram-v2:owner-required');
    const canonical = realpathSync(path.resolve(root));
    const policy = createFilesystemPolicy({ workspaceRoot: this.workspaceRoot });
    if (canonical === path.parse(canonical).root || policy.redZoneRoots.some(r => within(canonical, r) || within(r, canonical))
      || !lstatSync(canonical).isDirectory()) throw Error('telegram-v2:protected-root');
    if (!capabilities.length || capabilities.some(c => !(TELEGRAM_REMOTE_FILE_CAPABILITIES as readonly string[]).includes(c))) throw Error('telegram-v2:invalid-capabilities');
    if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 2 * 60 * 60_000) throw Error('telegram-v2:invalid-expiry');
    const grant: RemoteGrant = { id: randomUUID(), root: canonical, capabilities: [...new Set(capabilities)], expiresAt: this.now() + ttlMs, epoch: s.pairingEpoch };
    this.put('grant', 'active', grant); return grant;
  }
  activeGrant(): RemoteGrant | null {
    const g = this.read<RemoteGrant>('grant', 'active'); const s = this.settings();
    return g && g.expiresAt > this.now() && g.epoch === s.pairingEpoch && !s.paused ? g : null;
  }
  revokeGrant(): void { this.remove('grant', 'active'); }
  /** Deny-only fence, called again by Kernel directly before effect dispatch. */
  permits(requestId: string, conversationId: string, capability: string, input: unknown): boolean {
    try {
      const r = this.request(requestId); const s = this.settings();
      if (!r || !s.enabled || s.paused || r.actor.pairingEpoch !== s.pairingEpoch
        || r.actor.ownerUserId !== s.ownerUserId || r.actor.botId !== s.botId || r.actor.conversationId !== conversationId) return false;
      const binding = this.binding(r.actor.threadId);
      if (!binding || binding.conversationId !== conversationId || binding.archived || binding.localOnly) return false;
      const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
      if (CONTROL_CAPABILITIES.has(capability)) return capability === 'telegram.capabilities.describe' || args.chatId === s.controlChatId;
      const g = this.activeGrant();
      if (!g || r.grantId !== g.id || !g.capabilities.includes(capability)) return false;
      const raw = args.path ?? args.root;
      if (typeof raw !== 'string' || !path.isAbsolute(raw)) return false;
      let existing = path.resolve(raw);
      while (!existsSync(existing)) { const parent = path.dirname(existing); if (parent === existing) return false; existing = parent; }
      if (!within(realpathSync(existing), g.root) || !within(path.resolve(raw), g.root)) return false;
      if (capability === 'workspace.files.write' && (args.overwrite === true || existsSync(raw))) return false;
      const op = capability.endsWith('.write') ? 'write' : capability.endsWith('.mkdir') ? 'mkdir' : 'read';
      const access = evaluateFilesystemAccess(raw, op, { workspaceRoot: this.workspaceRoot, sandboxRoot: g.root, allowedRoots: [g.root] });
      return access.allowed;
    } catch { return false; }
  }
}
function within(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || !rel.startsWith('..') && !path.isAbsolute(rel);
}
