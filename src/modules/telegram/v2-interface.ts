import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TelegramV2Store, type ConversationBinding } from './v2-store';

export interface TelegramConversationSummary { id: string; title: string; archived?: boolean; localOnly?: boolean }
export interface TelegramConversationBridge {
  list(): Promise<TelegramConversationSummary[]>;
  create(title: string): Promise<TelegramConversationSummary>;
  update(id: string, patch: { title?: string; archived?: boolean }): Promise<void>;
  messages(id: string, before?: number): Promise<{ messages: { role: string; content: string }[]; before?: number }>;
  tasks(conversationId?: string): Promise<{ id: string; conversationId: string; status: string; title?: string }[]>;
  cancel(turnId: string, conversationId: string): Promise<void>;
}
type Message = { message_id: number; message_thread_id?: number; chat: { id: number; type: string }; from?: { id: number }; text?: string };
type Callback = { id: string; from: { id: number }; message?: Message; data?: string };
type Action = { kind: string; id?: string; page?: number; before?: number; offset?: number; text?: string };
type Button = { text: string; action: Action; url?: string };
interface StoredButton { action: Action; epoch: string; threadId: number; messageId: number; expiresAt: number }
interface PendingInput { kind: 'rename' | 'search' | 'reminder' | 'secretary-edit' | 'secretary-agreement'; id?: string; dueAt?: string; epoch: string; expiresAt: number }
type Call = <T = any>(method: string, parameters: Record<string, unknown>) => Promise<T>;

/** Native presentation only. Buttons contain random handles, never capabilities,
 * paths, serialized commands or authorization supplied by the model. */
export class TelegramV2Interface {
  private readonly access = new AsyncLocalStorage<{ epoch: string; ownerId: number; chatId: number; cancellationOnly?: boolean }>();
  bridge: TelegramConversationBridge | undefined;
  stopAll: (() => Promise<string>) | undefined;
  reminders: { list(threadId: number): Promise<{ id: string; text: string; dueAt: string; uncertain?: boolean }[]>;
    create(threadId: number, text: string, dueAt: string): Promise<void>; cancel(threadId: number, id: string): Promise<void> } | undefined;
  secretary: ((action: Action, message: Message, render: (text: string, rows: Button[][]) => Promise<void>) => Promise<void>) | undefined;
  constructor(readonly store: TelegramV2Store, private readonly call: Call) {}
  async bindTaskCard(message: Message, turnId: string): Promise<void> {
    const s = this.store.settings();
    const id = randomBytes(12).toString('hex');
    await this.call('editMessageReplyMarkup', { chat_id: message.chat.id, message_id: message.message_id,
      reply_markup: { inline_keyboard: [[{ text: 'Остановить', callback_data: `v2:${id}` }]] } });
    this.store.put('ui-button', id, { action: { kind: 'cancel', id: turnId }, epoch: s.pairingEpoch,
      threadId: message.message_thread_id ?? 0, messageId: message.message_id, expiresAt: Date.now() + 10 * 60_000 });
    this.store.pruneUi();
  }

  async message(message: Message): Promise<boolean> {
    const s = this.store.settings();
    return this.access.run({ epoch: s.pairingEpoch, ownerId: s.ownerUserId, chatId: s.controlChatId }, () => this.handleMessage(message));
  }
  private async handleMessage(message: Message): Promise<boolean> {
    if (!message.from || !this.store.settings().enabled) return false;
    this.store.assertOwner(message.chat.id, message.from.id);
    const thread = message.message_thread_id ?? 0;
    const text = message.text?.trim() ?? '';
    const pending = this.store.read<PendingInput>('ui-input', String(thread));
    if (text.startsWith('/')) this.store.remove('ui-input', String(thread));
    if (pending && !text.startsWith('/')) {
      this.store.remove('ui-input', String(thread));
      if (pending.expiresAt < Date.now() || pending.epoch !== this.store.settings().pairingEpoch) return true;
      if (pending.kind === 'secretary-edit' || pending.kind === 'secretary-agreement') {
        await this.show({ kind: `${pending.kind}-submit`, ...(pending.id ? { id: pending.id } : {}), text }, message); return true;
      }
      if (pending.kind === 'reminder' && pending.dueAt) {
        if (!this.reminders || !text || text.length > 3000) throw Error('Напоминание должно содержать от 1 до 3000 символов.');
        await this.reminders.create(thread, text, pending.dueAt);
        await this.show({ kind: 'reminders' }, message); return true;
      }
      if (pending.kind === 'rename' && pending.id) {
        const b = this.store.read<ConversationBinding>('binding', pending.id);
        if (b) { const title = text.slice(0, 128); await this.bridge?.update(b.conversationId, { title });
          if (b.threadId) await this.call('editForumTopic', { chat_id: message.chat.id, message_thread_id: b.threadId, name: title });
          this.store.updateBinding(b.id, { title }); }
        await this.show({ kind: 'chats' }, message); return true;
      }
      await this.chats(message, 0, text); return true;
    }
    const command = text.match(/^\/(start|menu|settings|new|chats|tasks|reminders|secretary)(?:@\w+)?(?:\s|$)/iu)?.[1]?.toLowerCase();
    if (!command) {
      if (!text.startsWith('/') && !this.store.binding(thread)) {
        if (!this.bridge || !this.store.settings().historyEnabled) throw Error('Общая история сейчас недоступна.');
        const legacyId = `telegram:${message.chat.id}:${message.from.id}`;
        const legacy = thread === 0 ? (await this.bridge.list()).find(c => c.id === legacyId && !c.localOnly) : undefined;
        const conversation = legacy ?? await this.bridge.create('Новый чат из Telegram');
        this.store.bind(thread, conversation.id, conversation.title);
      }
      return false;
    }
    await this.show({ kind: command === 'start' || command === 'menu' ? 'home' : command }, message);
    return true;
  }
  async callback(callback: Callback): Promise<boolean> {
    const s = this.store.settings();
    return this.access.run({ epoch: s.pairingEpoch, ownerId: s.ownerUserId, chatId: s.controlChatId }, () => this.handleCallback(callback));
  }
  private async handleCallback(callback: Callback): Promise<boolean> {
    if (!callback.data?.startsWith('v2:')) return false;
    const m = callback.message; const s = this.store.settings();
    const button = this.store.read<StoredButton>('ui-button', callback.data.slice(3));
    const valid = Boolean(m && button && s.enabled && (!s.paused || ['cancel', 'stop-all'].includes(button.action.kind)) && callback.from.id === s.ownerUserId
      && m.chat.id === s.controlChatId && button.epoch === s.pairingEpoch
      && button.messageId === m.message_id && button.threadId === (m.message_thread_id ?? 0) && button.expiresAt > Date.now());
    await this.call('answerCallbackQuery', { callback_query_id: callback.id, ...(valid ? {} : { text: 'Кнопка устарела. Открой /menu.' }) });
    if (!valid || !m || !button) return true;
    if (['cancel', 'stop-all'].includes(button.action.kind)) this.access.getStore()!.cancellationOnly = true;
    this.assertCurrentAccess();
    if (['new', 'cancel', 'stop-all', 'archive', 'pin', 'cloud', 'secretary-send', 'secretary-return', 'reminder-cancel', 'secretary-agreement-done'].includes(button.action.kind)) this.store.remove('ui-button', callback.data.slice(3));
    await this.show(button.action, { ...m, from: callback.from }); return true;
  }
  private async card(message: Message, text: string, rows: Button[][]): Promise<void> {
    this.assertCurrentAccess();
    const s = this.store.settings();
    if (s.controlChatId !== message.chat.id || s.ownerUserId !== message.from?.id) throw Error('telegram-v2:owner-required');
    const handles: { id: string; button: Button }[] = [];
    const keyboard = rows.map(row => row.map(button => {
      if (button.url && /^tg:\/\/user\?id=[1-9][0-9]{0,15}$/u.test(button.url)) return { text: button.text, url: button.url };
      const id = randomBytes(12).toString('hex'); handles.push({ id, button });
      return { text: button.text, callback_data: `v2:${id}` };
    }));
    // User messages are never edited. Only callbacks referencing this bot's cards
    // carry an id already present in our button ledger.
    const editable = this.store.list<StoredButton>('ui-button').some(b => b.messageId === message.message_id
      && b.threadId === (message.message_thread_id ?? 0) && b.epoch === s.pairingEpoch);
    const result = await this.call<Message>(editable ? 'editMessageText' : 'sendMessage', {
      chat_id: message.chat.id, ...(editable ? { message_id: message.message_id } : {}),
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: text.slice(0, 3800), reply_markup: { inline_keyboard: keyboard },
    });
    const messageId = editable ? message.message_id : result.message_id;
    this.store.transaction(() => {
      for (const { id, button } of handles) this.store.put('ui-button', id, { action: button.action,
        epoch: s.pairingEpoch, threadId: message.message_thread_id ?? 0, messageId, expiresAt: Date.now() + 10 * 60_000 });
      // Bound metadata growth without retaining message contents.
      this.store.pruneUi();
    });
  }
  private async show(action: Action, message: Message): Promise<void> {
    const home: Button = { text: '‹ Меню', action: { kind: 'home' } };
    if (action.kind === 'stop-all') {
      await this.card(message, this.stopAll ? await this.stopAll() : 'Остановка компонентов сейчас недоступна.', []); return;
    }
    if (action.kind === 'secretary-edit' || action.kind === 'secretary-agreement') {
      this.store.put('ui-input', String(message.message_thread_id ?? 0), { kind: action.kind, id: action.id,
        epoch: this.store.settings().pairingEpoch, expiresAt: Date.now() + 5 * 60_000 });
      await this.card(message, action.kind === 'secretary-edit' ? 'Отправь полный исправленный ответ следующим сообщением. Затем покажу его для подтверждения. /menu отменяет ввод.'
        : 'Напиши подтверждённую договорённость и срок, если он есть. Сохраню твою формулировку только в этой переписке. Это запись, а не отправка или запуск задачи. /menu отменяет ввод.', [[home]]); return;
    }
    if (action.kind.startsWith('secretary') && this.secretary) {
      await this.secretary(action, message, (text, rows) => this.card(message, text, rows)); return;
    }
    if (action.kind === 'chats') { await this.chats(message, action.page ?? 0, action.text ?? ''); return; }
    if (action.kind === 'new' || action.kind === 'open') {
      if (!this.store.settings().historyEnabled) { await this.card(message, 'Разреши общую историю в Monarch → Telegram.', [[home]]); return; }
      if (!this.bridge) { await this.card(message, 'История Оскара сейчас недоступна.', [[home]]); return; }
      const conversation = action.kind === 'new' ? await this.bridge.create('Новый чат')
        : (await this.bridge.list()).find(c => c.id === action.id && !c.localOnly && !c.archived);
      if (!conversation || !this.store.settings().historyEnabled) { await this.card(message, 'Доступ к этому диалогу не разрешён.', [[home]]); return; }
      let b = this.store.bindings().find(b => b.conversationId === conversation.id);
      if (!b) {
        try {
          const topic = await this.call<{ message_thread_id: number }>('createForumTopic', { chat_id: message.chat.id, name: conversation.title.slice(0, 128) });
          b = this.store.bind(topic.message_thread_id, conversation.id, conversation.title);
        } catch { await this.card(message, 'Для отдельных диалогов включи темы в BotFather → настройки бота. Диалог сохранён в Monarch.', [[home]]); return; }
      }
      if (b.localOnly || b.archived) { await this.card(message, 'Диалог доступен только в Monarch или находится в архиве.', [[home]]); return; }
      await this.card({ ...message, message_id: 0, message_thread_id: b.threadId }, `${b.title}\nЭтот диалог общий с Оскаром в Monarch. Напиши сообщение в этой теме.`, [
        [{ text: 'Последние сообщения', action: { kind: 'history', id: b.id } }],
        [{ text: 'Переименовать', action: { kind: 'rename', id: b.id } }, { text: b.pinned ? 'Открепить' : 'Закрепить', action: { kind: 'pin', id: b.id } }],
        [{ text: 'В архив', action: { kind: 'archive', id: b.id } }, home],
      ]); return;
    }
    if (['history', 'rename', 'pin', 'archive', 'cloud'].includes(action.kind)) {
      const b = action.id ? this.store.read<ConversationBinding>('binding', action.id) : null;
      if (!b || b.localOnly || b.archived || !this.store.settings().historyEnabled) { await this.card(message, 'Диалог недоступен.', [[home]]); return; }
      if (action.kind === 'history') {
        const page = await this.bridge?.messages(b.conversationId, action.before);
        const text = page?.messages.map(m => `${m.role === 'user' ? 'Ты' : 'Оскар'}: ${m.content}`).join('\n\n') || 'В этом диалоге пока нет сообщений.';
        const offset = Math.max(0, action.offset ?? 0);
        await this.card(message, text.slice(offset, offset + 3500), [
          ...(offset + 3500 < text.length ? [[{ text: 'Продолжение сообщения', action: { ...action, offset: offset + 3500 } }]] : []),
          ...(page?.before ? [[{ text: 'Раньше', action: { kind: 'history', id: b.id, before: page.before } }]] : []), [home]]); return;
      }
      if (action.kind === 'rename') {
        this.store.put('ui-input', String(message.message_thread_id ?? 0), { kind: 'rename', id: b.id,
          epoch: this.store.settings().pairingEpoch, expiresAt: Date.now() + 5 * 60_000 });
        await this.card(message, 'Отправь новое название следующим сообщением. /menu отменяет ввод.', [[home]]); return;
      }
      if (action.kind === 'archive') await this.bridge?.update(b.conversationId, { archived: true });
      this.store.updateBinding(b.id, action.kind === 'pin' ? { pinned: !b.pinned } : action.kind === 'cloud' ? { cloudEnabled: !b.cloudEnabled } : { archived: true });
      await this.chats(message); return;
    }
    if (action.kind === 'search') {
      this.store.put('ui-input', String(message.message_thread_id ?? 0), { kind: 'search', epoch: this.store.settings().pairingEpoch, expiresAt: Date.now() + 5 * 60_000 });
      await this.card(message, 'Что найти в названиях диалогов?', [[home]]); return;
    }
    if (action.kind === 'cancel' && action.id) {
      const tasks = await this.bridge?.tasks(); const task = tasks?.find(t => t.id === action.id);
      if (!task) { await this.card(message, 'Эта задача уже завершена или недоступна.', []); return; }
      await this.bridge?.cancel(task.id, task.conversationId);
      await this.card(message, 'Остановка запрошена. Уже выполненные действия сохраняются в результате задачи.', this.store.settings().paused ? [] : [[home]]); return;
    }
    if (action.kind === 'tasks') {
      const tasks = await this.bridge?.tasks() ?? [];
      await this.card(message, tasks.length ? tasks.slice(0, 8).map((t, i) => `${i + 1}. ${t.title?.slice(0, 160) || 'Задача Оскара'}\n${statusText(t.status)} · на компьютере`).join('\n\n') : 'Активных задач нет.',
        [...tasks.slice(0, 8).map((t, i) => [{ text: `Остановить ${i + 1}: ${t.title?.slice(0, 30) || 'задачу'}`, action: { kind: 'cancel', id: t.id } }]), [home]]); return;
    }
    if (['settings', 'model-local', 'model-max'].includes(action.kind)) {
      const thread = message.message_thread_id ?? 0;
      if (action.kind !== 'settings') this.store.selectModel(thread, action.kind === 'model-max');
      const g = this.store.activeGrant();
      let role: string | undefined;
      try { role = this.store.modelForThread(thread); } catch { role = 'недоступен — проверь Настройки → MAX'; }
      const operations = g?.capabilities.map(c => ({ 'workspace.files.read': 'чтение', 'workspace.files.list': 'список файлов', 'workspace.files.search': 'поиск', 'workspace.files.write': 'новые файлы', 'workspace.files.mkdir': 'новые папки' } as Record<string, string>)[c] ?? c).join(', ');
      await this.card(message, `Настройки этой темы\nМодель: ${role ? `MAX · ${role}` : 'локальная модель Оскара'}\nДоступность модели проверяется при запуске; скрытой замены MAX нет.\nИстория: ${this.store.settings().historyEnabled ? 'подключена' : 'доступ не разрешён'}\nФайлы: ${g ? `${operations}, до ${new Date(g.expiresAt).toLocaleTimeString('ru-RU')}` : 'нужно разрешение на ПК'}\nТерминал и управление экраном: удалённый доступ ещё не открыт в V2.\nPDF/DOCX: текст, до 8 МБ, без OCR. Голос и изображения требуют доступного обработчика.\nКлючи и разрешения: Monarch → Telegram.`, [
        [{ text: 'Локальная модель', action: { kind: 'model-local' } }, ...(this.store.allowedModel() ? [{ text: 'Разрешённый MAX', action: { kind: 'model-max' } }] : [])], [home]]); return;
    }
    if (action.kind.startsWith('reminder')) {
      if (!this.reminders) { await this.card(message, 'Напоминания сейчас недоступны.', [[home]]); return; }
      const thread = message.message_thread_id ?? 0;
      if (action.kind === 'reminder-new') {
        const dueAt = new Date(Date.now() + (action.page === 60 ? 60 : action.page === 1440 ? 1440 : 15) * 60_000).toISOString();
        this.store.put('ui-input', String(thread), { kind: 'reminder', dueAt, epoch: this.store.settings().pairingEpoch, expiresAt: Date.now() + 5 * 60_000 });
        await this.card(message, `О чём напомнить?\nВремя: ${new Date(dueAt).toLocaleString('ru-RU')} (часовой пояс компьютера).\nЛокальное напоминание требует включённого Monarch. /menu отменяет ввод.`, [[home]]); return;
      }
      if (action.kind === 'reminder-cancel' && action.id) await this.reminders.cancel(thread, action.id);
      const reminders = await this.reminders.list(thread);
      await this.card(message, `Напоминания в этой теме · на компьютере\n${reminders.length ? reminders.slice(0, 8).map(r => `${new Date(r.dueAt).toLocaleString('ru-RU')}: ${r.text.slice(0, 180)}${r.uncertain ? ' · доставка не подтверждена, автоповтор отключён' : ''}`).join('\n\n') : 'Пока нет напоминаний.'}`, [
        [{ text: 'Через 15 минут', action: { kind: 'reminder-new', page: 15 } }, { text: 'Через час', action: { kind: 'reminder-new', page: 60 } }],
        [{ text: 'Через сутки', action: { kind: 'reminder-new', page: 1440 } }],
        ...reminders.slice(0, 8).map(r => [{ text: `Отменить: ${r.text.slice(0, 35)}`, action: { kind: 'reminder-cancel', id: r.id } }]), [home]]); return;
    }
    if (action.kind === 'secretary') { await this.card(message, 'Подключи отдельного бота секретаря в Monarch → Telegram.', [[home]]); return; }
    this.store.remove('ui-input', String(message.message_thread_id ?? 0));
    await this.card(message, 'Оскар\nКомпьютер подключён\nВыбери диалог или оставь поручение в его теме.', [
      [{ text: '＋ Новый чат', action: { kind: 'new' } }, { text: 'Диалоги', action: { kind: 'chats' } }],
      [{ text: 'Задачи', action: { kind: 'tasks' } }, { text: 'Секретарь', action: { kind: 'secretary' } }],
      [{ text: 'Напоминания', action: { kind: 'reminders' } }, { text: 'Настройки', action: { kind: 'settings' } }],
      [{ text: 'Остановить всё', action: { kind: 'stop-all' } }],
    ]);
  }
  private async chats(message: Message, page = 0, search = ''): Promise<void> {
    const home = { text: '‹ Меню', action: { kind: 'home' } };
    if (!this.store.settings().historyEnabled) { await this.card(message, 'Разреши общую историю в Monarch → Telegram.', [[home]]); return; }
    const available = await this.bridge?.list() ?? [];
    this.assertCurrentAccess();
    const bindings = this.store.bindings();
    const conversations = available.filter(c => !c.archived && !c.localOnly
      && !bindings.some(b => b.conversationId === c.id && b.localOnly)
      && c.title.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')))
      .sort((a, b) => Number(bindings.some(x => x.conversationId === b.id && x.pinned)) - Number(bindings.some(x => x.conversationId === a.id && x.pinned)));
    const offset = Math.max(0, page) * 8;
    await this.card(message, search ? `Поиск: ${search.slice(0, 100)}` : 'Общая история Оскара', [
      ...conversations.slice(offset, offset + 8).map(c => [{ text: c.title.slice(0, 50), action: { kind: 'open', id: c.id } }]),
      [{ text: '＋ Новый', action: { kind: 'new' } }, { text: 'Поиск', action: { kind: 'search' } }],
      ...(page > 0 ? [[{ text: '‹ Назад', action: { kind: 'chats', page: page - 1, text: search } }]] : []),
      ...(offset + 8 < conversations.length ? [[{ text: 'Дальше ›', action: { kind: 'chats', page: page + 1, text: search } }]] : []), [home],
    ]);
  }
  private assertCurrentAccess(): void {
    const s = this.store.settings(); const captured = this.access.getStore();
    if (!s.enabled || s.paused && !captured?.cancellationOnly || captured && (captured.epoch !== s.pairingEpoch
      || captured.ownerId !== s.ownerUserId || captured.chatId !== s.controlChatId)) throw Error('telegram-v2:access-revoked');
  }
}
function statusText(status: string): string {
  return ({ accepted: 'Принято', routing: 'Подготовка', answering: 'Готовлю ответ', running: 'Выполняется',
    'waiting-for-user': 'Нужен твой ответ', 'waiting-for-approval': 'Нужно разрешение',
    'waiting-for-runtime': 'Нужно восстановить модель или инструмент' } as Record<string, string>)[status] ?? status;
}
