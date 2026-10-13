import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramV2Store } from './v2-store';
import type { TelegramSecretTransport } from './host-transport';

interface Connection { id: string; user: { id: number }; is_enabled: boolean; rights?: { can_reply?: boolean; can_read_messages?: boolean } }
interface BusinessMessage { message_id: number; business_connection_id: string; chat: { id: number; type: string; first_name?: string; username?: string }; from?: { id: number }; text?: string; caption?: string; date: number; sender_business_bot?: { id: number } }
interface BusinessUpdate { update_id: number; business_connection?: Connection; business_message?: BusinessMessage; edited_business_message?: BusinessMessage;
  deleted_business_messages?: { business_connection_id: string; chat: { id: number }; message_ids: number[] } }
export interface SecretaryChat { id: string; chatId: number; connectionId: string; epoch: string; title: string; revision: number; incomingAt: number; ownerActive: boolean;
  messages: { id: number; content: string; role: 'owner' | 'correspondent'; date: number }[] }
export interface SecretaryDraft { id: string; chat: string; revision: number; epoch: string; content: string; expiresAt: number;
  state: 'draft' | 'stale' | 'attempting' | 'sent' | 'uncertain'; sentMessageId?: number }
interface Configuration { enabled: boolean; chats: number[]; epoch: string }
interface ReplyRule { id: string; chatId: number; template: string; epoch: string; expiresAt: number; intervalMs: number; maxDaily: number }
interface Agreement { id: string; chat: string; epoch: string; text: string; sourceMessageIds: number[]; createdAt: number; done: boolean }
type Button = { text: string; action: { kind: string; id?: string }; url?: string };
export type SecretaryRewrite = { style: 'shorter' | 'friendlier' | 'formal'; text: string };

/** Personal correspondence is data. This component has no Agent/Kernel port. */
export class TelegramSecretary {
  generateDraft: ((messages: SecretaryChat['messages'], rewrite?: SecretaryRewrite) => Promise<string>) | undefined;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private healthy = false;
  constructor(readonly store: TelegramV2Store, private readonly transport: TelegramSecretTransport,
    private readonly now: () => number = Date.now) {}
  config(): Configuration { return this.store.read<Configuration>('secretary-config', 'local') ?? { enabled: false, chats: [], epoch: '' }; }
  configure(chats: number[], enabled: boolean): void {
    const s = this.store.settings();
    if (!s.enabled || chats.length > 100 || chats.some(id => !Number.isSafeInteger(id) || id <= 0 || id === s.ownerUserId)) throw Error('Выбери допустимые личные переписки.');
    this.store.transaction(() => {
      for (const chat of this.chats()) if (!chats.includes(chat.chatId)) {
        this.store.put('secretary-chat', chat.id, { ...chat, revision: chat.revision + 1 });
        this.removeRule(chat.chatId);
      }
      this.store.put('secretary-config', 'local', { enabled, chats: [...new Set(chats)], epoch: s.pairingEpoch });
    });
  }
  status() { return { ...this.config(), connected: this.healthy, chatsAvailable: this.chats().map(c => ({ id: c.id, chatId: c.chatId, title: c.title, ownerActive: c.ownerActive })),
    drafts: this.store.list<SecretaryDraft>('secretary-draft').map(d => ({ id: d.id, state: d.state, expiresAt: d.expiresAt })) }; }
  private enabled(): boolean { const s = this.store.settings(); const c = this.config(); return s.enabled && !s.paused && c.enabled && c.epoch === s.pairingEpoch; }
  chats(): SecretaryChat[] { const c = this.config(); return this.store.list<SecretaryChat>('secretary-chat').filter(t => t.epoch === c.epoch && c.chats.includes(t.chatId)); }
  rules(): ReplyRule[] { return this.store.list<ReplyRule>('secretary-rule').filter(r => r.epoch === this.store.settings().pairingEpoch && r.expiresAt > this.now()); }
  async pause(): Promise<void> { this.store.put('secretary-config', 'local', { ...this.config(), enabled: false }); await this.stop(); }
  setRule(input: { chatId: number; template: string; ttlMs: number }): void {
    if (!this.enabled() || !this.config().chats.includes(input.chatId) || !input.template.trim() || input.template.length > 1000
      || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 60_000 || input.ttlMs > 24 * 60 * 60_000) throw Error('Выбери переписку, текст и срок правила до суток.');
    const rule: ReplyRule = { id: randomUUID(), chatId: input.chatId, template: input.template, epoch: this.store.settings().pairingEpoch,
      expiresAt: this.now() + input.ttlMs, intervalMs: 60 * 60_000, maxDaily: 3 };
    // One explicit template per recipient; replacement never resets the cooldown.
    this.store.put('secretary-rule', String(input.chatId), rule);
  }
  removeRule(chatId: number): void { this.store.remove('secretary-rule', String(chatId)); }
  private async automaticReply(chat: SecretaryChat): Promise<void> {
    const rule = this.rules().find(r => r.chatId === chat.chatId);
    if (!rule || chat.ownerActive || !this.enabled()) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const prior = this.store.read<{ at: number; day: string; count: number }>('secretary-rule-use', chat.id);
    if (prior && (prior.at + rule.intervalMs > this.now() || prior.day === day && prior.count >= rule.maxDaily)) return;
    const draft = await this.draft(chat.id, rule.template);
    // Reserve before external sending; a crash/unknown receipt cannot send twice.
    this.store.put('secretary-rule-use', chat.id, { at: this.now(), day, count: prior?.day === day ? prior.count + 1 : 1 });
    if (this.rules().find(r => r.chatId === chat.chatId)?.id !== rule.id) return;
    await this.send(draft.id, rule.id);
  }
  async start(): Promise<void> {
    if (this.running || !this.enabled()) return;
    const status = await this.transport.request<{ configured: boolean }>({ role: 'secretary', kind: 'status' });
    if (!status.configured) throw Error('Сначала сохрани ключ отдельного бота секретаря.');
    const me = await this.call<{ id: number }>('getMe', {});
    if (me.id === this.store.settings().botId) throw Error('Для локального секретаря нужен другой бот.');
    const webhook = await this.call<{ url: string }>('getWebhookInfo', {});
    if (webhook.url) throw Error('У бота секретаря уже настроен webhook. Сначала отключи его в прежней установке.');
    for (const d of this.store.list<SecretaryDraft>('secretary-draft')) if (d.state === 'attempting') this.store.put('secretary-draft', d.id, { ...d, state: 'uncertain' });
    this.controller = new AbortController();
    this.running = this.poll(this.controller.signal).finally(() => { this.running = undefined; this.healthy = false; });
  }
  async stop(): Promise<void> { this.controller?.abort(); await this.running; }
  private call<T>(method: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.transport.request<T>({ kind: 'api', role: 'secretary', method, parameters }, signal);
  }
  private async poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (!this.enabled()) { await delay(1000, undefined, { signal }); continue; }
        const offset = this.store.read<number>('secretary-offset', 'current') ?? 0;
        const updates = await this.call<BusinessUpdate[]>('getUpdates', { offset, timeout: 25, limit: 30,
          allowed_updates: ['business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'] }, signal);
        for (const update of updates) { if (signal.aborted) break; await this.ingest(update);
          this.store.put('secretary-offset', 'current', update.update_id + 1); }
        this.healthy = true;
      } catch { this.healthy = false; if (!signal.aborted) await delay(3000, undefined, { signal }).catch(() => undefined); }
    }
  }
  async ingest(update: BusinessUpdate): Promise<void> {
    if (!this.enabled() || !Number.isSafeInteger(update.update_id)) return;
    const s = this.store.settings();
    if (update.business_connection) {
      const c = update.business_connection;
      if (c.user.id === s.ownerUserId) this.store.put('secretary-connection', c.id, c);
      return;
    }
    const m = update.business_message ?? update.edited_business_message;
    const deleted = update.deleted_business_messages;
    const connectionId = m?.business_connection_id ?? deleted?.business_connection_id;
    const chatId = m?.chat.id ?? deleted?.chat.id;
    if (!connectionId || !chatId || !this.config().chats.includes(chatId) || m && m.chat.type !== 'private') return;
    let connection = this.store.read<Connection>('secretary-connection', connectionId);
    if (!connection) { connection = await this.call<Connection>('getBusinessConnection', { business_connection_id: connectionId });
      if (connection.user.id !== s.ownerUserId) return; this.store.put('secretary-connection', connectionId, connection); }
    if (!connection.is_enabled || connection.user.id !== s.ownerUserId || !this.enabled()) return;
    const key = `${connectionId}:${chatId}`;
    let changed = false;
    this.store.transaction(() => {
      const seen = this.store.read<number>('secretary-seen', key) ?? -1;
      if (update.update_id <= seen) return;
      changed = true;
      const existing = this.store.read<SecretaryChat>('secretary-chat', key);
      const chat = existing?.epoch === s.pairingEpoch ? existing : { id: key, chatId, connectionId, epoch: s.pairingEpoch,
        title: m?.chat.first_name?.slice(0, 100) || String(chatId), revision: 0, incomingAt: 0, ownerActive: false, messages: [] };
      if (m) {
        const owner = m.from?.id === s.ownerUserId || Boolean(m.sender_business_bot);
        chat.messages = chat.messages.filter(x => x.id !== m.message_id);
        chat.messages.push({ id: m.message_id, content: (m.text ?? m.caption ?? '[Нет текстового содержимого]').slice(0, 8000), role: owner ? 'owner' : 'correspondent', date: m.date });
        chat.messages = chat.messages.sort((a, b) => a.date - b.date || a.id - b.id).slice(-30);
        if (!owner) chat.incomingAt = Math.max(chat.incomingAt, m.date * 1000);
        if (owner && !m.sender_business_bot) chat.ownerActive = true;
      }
      if (deleted) chat.messages = chat.messages.filter(x => !deleted.message_ids.includes(x.id));
      chat.revision++;
      this.store.put('secretary-chat', key, chat); this.store.put('secretary-seen', key, update.update_id);
      for (const d of this.store.list<SecretaryDraft>('secretary-draft')) if (d.chat === key && d.state === 'draft') this.store.put('secretary-draft', d.id, { ...d, state: 'stale' });
    });
    const latest = this.chats().find(c => c.id === key);
    if (changed && update.business_message && m?.from?.id !== s.ownerUserId && !m?.sender_business_bot && latest) await this.automaticReply(latest).catch(() => undefined);
  }
  async draft(chatId: string, manual?: string): Promise<SecretaryDraft> {
    const chat = this.chats().find(c => c.id === chatId);
    if (!chat || !this.enabled()) throw Error('Переписка недоступна.');
    const content = manual ?? await this.generateDraft?.(chat.messages);
    if (!content?.trim() || content.length > 3500) throw Error('Черновик не получен или слишком длинный.');
    const current = this.store.read<SecretaryChat>('secretary-chat', chat.id);
    if (!this.enabled() || current?.revision !== chat.revision) throw Error('Переписка изменилась. Подготовь новый черновик.');
    const d: SecretaryDraft = { id: randomUUID(), chat: chat.id, revision: chat.revision, epoch: this.store.settings().pairingEpoch,
      content, expiresAt: this.now() + 30 * 60_000, state: 'draft' };
    this.store.put('secretary-draft', d.id, d); return d;
  }
  async send(draftId: string, ruleId?: string): Promise<void> {
    const d = this.store.read<SecretaryDraft>('secretary-draft', draftId);
    const chat = d && this.chats().find(c => c.id === d.chat);
    if (!d || !chat) throw Error('Черновик недоступен.');
    const connection = await this.call<Connection>('getBusinessConnection', { business_connection_id: chat.connectionId });
    this.store.transaction(() => {
      const current = this.store.read<SecretaryDraft>('secretary-draft', d.id);
      const latest = this.store.read<SecretaryChat>('secretary-chat', chat.id);
      if (ruleId && this.rules().find(r => r.chatId === chat.chatId)?.id !== ruleId) throw Error('Правило автоответа отозвано.');
      if (!this.enabled() || !this.chats().some(c => c.id === chat.id && c.chatId === chat.chatId && c.connectionId === chat.connectionId)
        || d.epoch !== this.store.settings().pairingEpoch || current?.state !== 'draft' || d.expiresAt <= this.now()
        || latest?.revision !== d.revision || latest.ownerActive || latest.incomingAt < this.now() - 24 * 60 * 60_000
        || !connection.is_enabled || connection.user.id !== this.store.settings().ownerUserId || !connection.rights?.can_reply) throw Error('Отправка недоступна: проверь свежую переписку, перехват и разрешение Telegram. Черновик сохранён.');
      this.store.put('secretary-draft', d.id, { ...d, state: 'attempting' });
    });
    try {
      const receipt = await this.call<{ message_id: number }>('sendMessage', { business_connection_id: chat.connectionId, chat_id: chat.chatId, text: d.content });
      if (!Number.isSafeInteger(receipt.message_id) || receipt.message_id <= 0) throw Error('Отправка не подтверждена.');
      this.store.put('secretary-draft', d.id, { ...d, state: 'sent', sentMessageId: receipt.message_id });
      const current = this.chats().find(c => c.id === chat.id);
      if (current && current.epoch === d.epoch) this.store.put('secretary-chat', current.id, { ...current, revision: current.revision + 1,
        messages: [...current.messages.filter(m => m.id !== receipt.message_id), { id: receipt.message_id, content: d.content, role: 'owner', date: Math.floor(this.now() / 1000) }]
          .sort((a, b) => a.date - b.date || a.id - b.id).slice(-30) });
    } catch { this.store.put('secretary-draft', d.id, { ...d, state: 'uncertain' }); throw Error('Результат отправки неизвестен. Проверь переписку; автоматического повтора не будет.'); }
  }
  async present(action: { kind: string; id?: string; text?: string }, render: (text: string, rows: Button[][]) => Promise<void>): Promise<void> {
    const back: Button = { text: '‹ Секретарь', action: { kind: 'secretary' } };
    if (!this.enabled()) { await render('Секретарь приостановлен или не настроен. Подключи отдельного бота и выбери переписки в Monarch.', [[{ text: '‹ Меню', action: { kind: 'home' } }]]); return; }
    const selectedChats = this.chats();
    if (action.kind === 'secretary-agreement-submit' && action.id) {
      const c = selectedChats.find(c => c.id === action.id);
      if (!c || !action.text?.trim() || action.text.length > 1500) throw Error('Выбери переписку и введи договорённость до 1500 символов.');
      if (this.store.list<Agreement>('secretary-agreement').filter(a => a.epoch === c.epoch && !a.done).length >= 100) throw Error('Сначала закрой часть из 100 активных договорённостей.');
      const a: Agreement = { id: randomUUID(), chat: c.id, epoch: c.epoch, text: action.text.trim(), sourceMessageIds: c.messages.slice(-3).map(m => m.id), createdAt: this.now(), done: false };
      this.store.put('secretary-agreement', a.id, a);
      await render('Твоя договорённость сохранена в выбранной переписке.', [[{ text: 'Договорённости', action: { kind: 'secretary-agreements' } }], [back]]); return;
    }
    if (action.kind === 'secretary-agreement-done' && action.id) {
      const a = this.store.read<Agreement>('secretary-agreement', action.id);
      if (a && a.epoch === this.store.settings().pairingEpoch && selectedChats.some(c => c.id === a.chat)) this.store.put('secretary-agreement', a.id, { ...a, done: true });
      action = { kind: 'secretary-agreements' };
    }
    if (action.kind === 'secretary-agreements') {
      const entries = this.store.list<Agreement>('secretary-agreement').filter(a => !a.done && a.epoch === this.store.settings().pairingEpoch && selectedChats.some(c => c.id === a.chat));
      await render(entries.length ? entries.slice(0, 8).map((a, i) => `${i + 1}. ${selectedChats.find(c => c.id === a.chat)!.title}\n${a.text.slice(0, 300)}`).join('\n\n') : 'Подтверждённых договорённостей нет. Открой переписку и сохрани свою формулировку.', [
        ...entries.slice(0, 8).map((a, i) => [{ text: `Выполнено: ${i + 1}`, action: { kind: 'secretary-agreement-done', id: a.id } }]), [back]]); return;
    }
    if (['secretary-inbox', 'secretary-waiting', 'secretary-overview'].includes(action.kind)) {
      const incoming = selectedChats.filter(c => c.messages.at(-1)?.role === 'correspondent');
      const waiting = selectedChats.filter(c => c.messages.at(-1)?.role === 'owner');
      const shown = (action.kind === 'secretary-inbox' ? incoming : action.kind === 'secretary-waiting' ? waiting : [...incoming, ...waiting]).slice(0, 10);
      await render(`Обзор выбранных переписок\nПоследнее сообщение собеседника: ${incoming.length}\nПоследнее сообщение от тебя: ${waiting.length}\nЭто очередь по фактическим сообщениям; она не определяет, требуется ли ответ.\n\n${shown.map(c => `${c.title}${c.ownerActive ? ' · управление у тебя' : ''}\n${c.messages.at(-1)?.content.slice(0, 160) ?? ''}`).join('\n\n')}`, [
        ...shown.map(c => [{ text: c.title.slice(0, 50), action: { kind: 'secretary-chat', id: c.id } }]), [back]]); return;
    }
    if (action.kind === 'secretary-send' && action.id) { await this.send(action.id); await render('Telegram подтвердил отправку.', [[back]]); return; }
    if (action.kind === 'secretary-rules') {
      await render(this.rules().length ? this.rules().map(r => `Получатель ${r.chatId}\n${r.template}\nДо ${new Date(r.expiresAt).toLocaleString('ru-RU')} · не чаще раза в час, до 3 ответов в сутки`).join('\n\n') : 'Автоответов нет. Точный текст, получатель и срок задаются в Monarch → Telegram → Секретарь.', [[back]]); return;
    }
    if (action.kind === 'secretary-return' && action.id) {
      const c = this.chats().find(c => c.id === action.id); if (c) this.store.put('secretary-chat', c.id, { ...c, ownerActive: false, revision: c.revision + 1 });
    }
    if (['secretary-draft', 'secretary-edit-submit', 'secretary-view-draft', 'secretary-shorter', 'secretary-friendlier', 'secretary-formal'].includes(action.kind) && action.id) {
      let d: SecretaryDraft;
      if (action.kind === 'secretary-draft') d = await this.draft(action.id);
      else {
        const old = this.store.read<SecretaryDraft>('secretary-draft', action.id);
        const chat = old && this.chats().find(c => c.id === old.chat);
        if (!old || !chat || old.state !== 'draft' || old.epoch !== this.store.settings().pairingEpoch
          || old.revision !== chat.revision || old.expiresAt <= this.now()) throw Error('Черновик устарел. Подготовь ответ по свежей переписке.');
        const style = action.kind.slice('secretary-'.length);
        if (['shorter', 'friendlier', 'formal'].includes(style)) {
          const content = await this.generateDraft?.(chat.messages, { style: style as SecretaryRewrite['style'], text: old.content });
          if (!content || !this.enabled() || this.chats().find(c => c.id === chat.id)?.revision !== chat.revision) throw Error('Переписка изменилась или модель недоступна. Подготовь свежий черновик.');
          d = await this.draft(chat.id, content);
        } else d = action.kind === 'secretary-edit-submit' ? await this.draft(chat.id, action.text) : old;
        if (d.id !== old.id) this.store.put('secretary-draft', old.id, { ...old, state: 'stale' });
      }
      const c = this.chats().find(c => c.id === d.chat)!;
      // 3500 body + bounded title/header stays below the native card budget;
      // the confirmation always displays the entire text that will be sent.
      await render(`${c.title.slice(0, 80)} · ${c.chatId}\n\n${d.content}\n\nЧерновик: 30 минут, до изменения переписки.`, [
        [{ text: 'Отправить', action: { kind: 'secretary-send', id: d.id } }, { text: 'Изменить', action: { kind: 'secretary-edit', id: d.id } }],
        [{ text: 'Короче', action: { kind: 'secretary-shorter', id: d.id } }, { text: 'Дружелюбнее', action: { kind: 'secretary-friendlier', id: d.id } }, { text: 'Официальнее', action: { kind: 'secretary-formal', id: d.id } }], [back]]); return;
    }
    if (action.kind === 'secretary-drafts') {
      const drafts = this.store.list<SecretaryDraft>('secretary-draft').filter(d => d.state === 'draft' && d.expiresAt > this.now()
        && d.epoch === this.store.settings().pairingEpoch && this.chats().some(c => c.id === d.chat && c.revision === d.revision));
      await render(drafts.length ? 'Сохранённые черновики' : 'Актуальных черновиков пока нет.', [
        ...drafts.slice(0, 10).map(d => [{ text: d.content.slice(0, 50), action: { kind: 'secretary-view-draft', id: d.id } }]), [back]]); return;
    }
    const chats = this.chats();
    if (action.kind === 'secretary-chat' && action.id) {
      const c = chats.find(c => c.id === action.id); if (!c) throw Error('Переписка недоступна.');
      await render(`${c.title}\n${c.ownerActive ? 'Ты вступил в разговор. Оскар приостановлен.' : 'Ожидает ответа'}\n\n${c.messages.slice(-3).map(m => `${m.role === 'owner' ? 'Ты' : c.title}: ${m.content}`).join('\n\n').slice(0, 2800)}`,
        [[{ text: c.ownerActive ? 'Вернуть Оскару' : 'Подготовить ответ', action: { kind: c.ownerActive ? 'secretary-return' : 'secretary-draft', id: c.id } }],
          [{ text: 'Сохранить договорённость', action: { kind: 'secretary-agreement', id: c.id } }],
          [{ text: 'Открыть собеседника', action: { kind: 'secretary-chat', id: c.id }, url: `tg://user?id=${c.chatId}` }], [back]]); return;
    }
    await render(`Секретарь · ${this.healthy ? 'подключён' : 'ожидает подключения'}\nВыбранные переписки. Просмотр здесь передаёт показанный фрагмент в основной бот. Сообщения не отмечаются прочитанными.`,
      [[{ text: 'Входящие', action: { kind: 'secretary-inbox' } }, { text: 'Ожидаем', action: { kind: 'secretary-waiting' } }],
        [{ text: 'Черновики', action: { kind: 'secretary-drafts' } }, { text: 'Договорённости', action: { kind: 'secretary-agreements' } }],
        [{ text: 'Что нового?', action: { kind: 'secretary-overview' } }, { text: 'Правила', action: { kind: 'secretary-rules' } }], ...chats.slice(0, 12).map(c => [{ text: c.title, action: { kind: 'secretary-chat', id: c.id } }]), [{ text: '‹ Меню', action: { kind: 'home' } }]]);
  }
}
