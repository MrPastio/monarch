import { randomInt, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchIntentResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import { permissionModeForRisk } from '../../core';
import {
  assertTelegramBotApiMethodAllowed,
  assertTelegramBotApiMethodName,
  findTelegramApiChatReferenceViolation,
  parseTelegramApiCommandParameters,
  readTelegramApiCapabilityInput,
  telegramApiInputHelp,
} from './api-guard';
import { telegramManifest } from './manifest';
import {
  PAIRING_ATTEMPT_LIMIT,
  PAIRING_ATTEMPT_WINDOW_MS,
  TRANSIENT_LOCK_STALE_MS,
  TRANSIENT_LOCK_TIMEOUT_MS,
  acquireFileLock,
  defaultTelegramState,
  isNotFoundError,
  pairingAttemptKey,
  readPairingAttempts,
  readPairingSnapshot,
  releaseFileLock,
  validPairing,
  validReminder,
  writeAtomicJson,
  type TelegramPairing,
  type TelegramReminder,
  type TelegramState,
} from './state-store';

const DEFAULT_API_BASE = 'https://api.telegram.org';
const PAIRING_TTL_MS = 15 * 60 * 1000;
const MAX_MESSAGE_CHARS = 3800;
const MAX_COMMAND_CHARS = 16_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const PAIRING_COOLDOWN_MS = 30 * 60 * 1000;
const PENDING_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CONFIRMATIONS_PER_CHAT_USER = 8;
const MAX_PENDING_CONFIRMATIONS_TOTAL = 256;
const OFFICIAL_TELEGRAM_API_HOST = 'api.telegram.org';
const MAX_TABLE_COLUMNS = 8;
const MAX_TABLE_ROWS = 24;
const MAX_TABLE_CELL_CHARS = 120;
const MAX_TABLE_TITLE_CHARS = 160;
const MAX_TABLE_MARKDOWN_CHARS = 3_600;
const MIN_POLL_OPTIONS = 1;
const MAX_POLL_OPTIONS = 12;
const MAX_POLL_QUESTION_CHARS = 300;
const MAX_POLL_OPTION_CHARS = 100;
const MAX_REMINDER_TEXT_CHARS = 2_000;
const REMINDER_WATCH_DEBOUNCE_MS = 50;
const REMINDER_WATCH_FALLBACK_MS = 60_000;
const REMINDER_POLL_FALLBACK_MS = 1_000;
const MAX_TRACKED_RATE_LIMIT_USERS = 2_048;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface PendingIntentConfirmation {
  kind: 'intent';
  id: string;
  chatId: number;
  userId: number;
  text: string;
  token: string;
  expiresAt: number;
}

interface PendingApiConfirmation {
  kind: 'api';
  id: string;
  chatId: number;
  userId: number;
  method: string;
  parameters: Record<string, unknown>;
  expiresAt: number;
}

type PendingConfirmation = PendingIntentConfirmation | PendingApiConfirmation;

export interface TelegramIntentDispatchRequest {
  text: string;
  confirmed?: boolean;
  confirmationToken?: string;
  context: Record<string, unknown>;
}

export type TelegramIntentDispatcher = (
  request: TelegramIntentDispatchRequest
) => Promise<MonarchIntentResult>;

export interface TelegramModuleOptions {
  projectRoot?: string;
  apiBase?: string;
  token?: string;
  autoStart?: boolean;
}

export class TelegramModule implements MonarchModule {
  readonly manifest = telegramManifest;
  private readonly projectRoot: string;
  private readonly statePath: string;
  private readonly stateLockPath: string;
  private readonly pairingPath: string;
  private readonly pairingLockPath: string;
  private readonly pollingLockPath: string;
  private readonly tokenPath: string;
  private readonly apiBase: string;
  private readonly autoStart: boolean;
  private token = '';
  private state: TelegramState = defaultTelegramState(false);
  private dispatcher: TelegramIntentDispatcher | null = null;
  private context: MonarchKernelContext | null = null;
  private running = false;
  private standby = false;
  private pollingLockToken = '';
  private pollingAbort: AbortController | null = null;
  private pollingTask: Promise<void> | null = null;
  private reminderTimer: ReturnType<typeof setTimeout> | null = null;
  private reminderWatcher: FSWatcher | null = null;
  private reminderRefreshMs = REMINDER_WATCH_FALLBACK_MS;
  private reminderDeliveryActive = false;
  private reminderDeliveryTask: Promise<void> | null = null;
  private pairingCode = '';
  private pairingExpiresAt = 0;
  private botIdentity: Record<string, unknown> | null = null;
  private lastError = '';
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  private readonly rateWindows = new Map<number, number[]>();
  private readonly rateLimitNotices = new Map<number, number>();
  private lastStateReadError = '';

  constructor(options: TelegramModuleOptions = {}) {
    this.projectRoot = path.resolve(options.projectRoot || process.cwd());
    this.statePath = path.join(this.projectRoot, 'data', 'local', 'telegram-state.json');
    this.stateLockPath = path.join(this.projectRoot, 'data', 'local', 'telegram-state.lock');
    this.pairingPath = path.join(this.projectRoot, 'data', 'local', 'telegram-pairing.json');
    this.pairingLockPath = path.join(this.projectRoot, 'data', 'local', 'telegram-pairing.lock');
    this.pollingLockPath = path.join(this.projectRoot, 'data', 'local', 'telegram-polling.lock');
    this.tokenPath = path.join(this.projectRoot, 'secrets', 'telegram_bot_token.txt');
    this.apiBase = normalizeApiBase(options.apiBase || process.env.MONARCH_TELEGRAM_API_BASE || DEFAULT_API_BASE);
    this.token = String(options.token || '').trim();
    this.autoStart = options.autoStart ?? process.env.MONARCH_TELEGRAM_AUTO_START !== '0';
  }

  setIntentDispatcher(dispatcher: TelegramIntentDispatcher): void {
    this.dispatcher = dispatcher;
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    this.context = context;
    await this.loadState();
    if (!this.token) {
      this.token = String(process.env.MONARCH_TELEGRAM_BOT_TOKEN || '').trim() || await readSecret(this.tokenPath);
    }
    await this.ensureFreshPairingCode();
    await context.emit('telegram.activated', this.manifest.id, this.statusPayload(true));
    if (this.token && this.autoStart) {
      await this.start(context).catch((error) => {
        this.lastError = safeError(error);
      });
    }
  }

  async deactivate(context: MonarchKernelContext): Promise<void> {
    await this.stop(context);
    this.context = null;
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: this.token
        ? this.running
          ? 'Telegram bot is polling in this Monarch runtime.'
          : this.standby
            ? 'Telegram bot is active through another local Monarch runtime.'
            : 'Telegram bot is configured but stopped.'
        : 'Telegram bot token is not configured.',
      output: this.statusPayload(false),
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text
      .replace(/"[^"]*"|'[^']*'/g, ' ')
      .replace(/(?:[a-z]:\\|\\\\|\.{0,2}[/\\])\S+/gi, ' ')
      .toLowerCase();
    if (!mentionsTelegramSurface(text)) return null;
    if (isTelegramPluginQuestion(text)) {
      return route(intent, 'telegram.capabilities.describe', 'read', { topic: 'plugins' });
    }
    if (isTelegramSecurityQuestion(text)) {
      return route(intent, 'telegram.capabilities.describe', 'read', { topic: 'security' });
    }
    if (isTelegramCapabilityQuestion(text)) {
      return route(intent, 'telegram.capabilities.describe', 'read', { topic: 'capabilities' });
    }
    if (isTelegramStatusQuestion(text)) {
      return route(intent, 'telegram.status', 'read', {});
    }
    if (/(start|launch|запусти|включи)/i.test(text)) {
      return route(intent, 'telegram.bot.start', 'network', {});
    }
    if (/(stop|останови|выключи)/i.test(text)) {
      return route(intent, 'telegram.bot.stop', 'execute', {});
    }
    return route(intent, 'telegram.status', 'read', {});
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    await this.refreshState();
    switch (request.capabilityId) {
    case 'telegram.status':
      await this.ensureFreshPairingCode();
      return { ok: true, summary: 'Telegram integration status loaded.', output: this.statusPayload(true) };
    case 'telegram.capabilities.describe':
      return this.describeCapabilitiesCapability(request.input);
    case 'telegram.pairing.rotate':
      await this.rotatePairingCode();
      return { ok: true, summary: 'Fresh Telegram pairing code created.', output: this.statusPayload(true) };
    case 'telegram.pairing.revoke':
      return this.revokePairingCapability(request.input);
    case 'telegram.remote.pause':
      return this.setRemotePaused(true);
    case 'telegram.remote.resume':
      return this.setRemotePaused(false);
    case 'telegram.bot.start':
      return this.start(context);
    case 'telegram.bot.stop':
      return this.stop(context);
    case 'telegram.message.send':
      return this.sendCapability(request.input);
    case 'telegram.poll.send':
      return this.pollCapability(request.input);
    case 'telegram.reminder.create':
      return this.createReminderCapability(request.input);
    case 'telegram.reminder.list':
      return this.listRemindersCapability(request.input);
    case 'telegram.reminder.cancel':
      return this.cancelReminderCapability(request.input);
    case 'telegram.api.call':
      return this.genericApiCapability(request.input);
    default:
      return { ok: false, summary: `Unsupported Telegram capability: ${request.capabilityId}`, error: 'unsupported-capability' };
    }
  }

  private async start(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    if (this.running) {
      return { ok: true, summary: 'Telegram bot is already running.', output: this.statusPayload(false) };
    }
    if (this.standby) {
      return { ok: true, summary: 'Telegram bot is already owned by another local Monarch runtime.', output: this.statusPayload(false) };
    }
    if (!this.token) {
      return {
        ok: false,
        summary: `Telegram token is missing. Set MONARCH_TELEGRAM_BOT_TOKEN or write it to ${this.tokenPath}.`,
        error: 'telegram-token-missing',
        output: this.statusPayload(true),
      };
    }
    const me = await this.callApi<Record<string, unknown>>('getMe', {});
    this.botIdentity = me;
    const ownsPolling = await this.acquirePollingLock();
    if (!ownsPolling) {
      this.standby = true;
      this.lastError = '';
      await context.emit('telegram.started', this.manifest.id, this.statusPayload(false));
      return {
        ok: true,
        summary: 'Telegram bot is shared with another local Monarch runtime; duplicate polling was suppressed.',
        output: this.statusPayload(true),
      };
    }
    await this.callApi('setMyCommands', { commands: telegramBotCommands() }).catch(async (error) => {
      await context.audit('telegram', 'Telegram command menu registration failed.', {
        error: safeError(error),
      }, 'warn');
    });
    this.running = true;
    this.standby = false;
    this.lastError = '';
    this.pollingAbort = new AbortController();
    this.pollingTask = this.pollLoop(this.pollingAbort.signal);
    await this.startReminderScheduler();
    await context.emit('telegram.started', this.manifest.id, this.statusPayload(false));
    return { ok: true, summary: 'Telegram bot started with local long polling.', output: this.statusPayload(true) };
  }

  private async stop(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const wasRunning = this.running;
    const wasStandby = this.standby;
    this.running = false;
    this.standby = false;
    this.pollingAbort?.abort();
    this.pollingAbort = null;
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
    this.reminderWatcher?.close();
    this.reminderWatcher = null;
    await this.reminderDeliveryTask?.catch(() => undefined);
    this.reminderDeliveryTask = null;
    await this.pollingTask?.catch(() => undefined);
    this.pollingTask = null;
    await this.releasePollingLock();
    if (wasRunning || wasStandby) await context.emit('telegram.stopped', this.manifest.id, this.statusPayload(false));
    return {
      ok: true,
      summary: wasRunning ? 'Telegram bot stopped.' : wasStandby ? 'Telegram standby connection stopped.' : 'Telegram bot was already stopped.',
      output: this.statusPayload(false),
    };
  }

  private async setRemotePaused(paused: boolean): Promise<MonarchExecutionResult> {
    await this.mutateState((state) => {
      state.remotePaused = paused;
    });
    if (paused) this.pendingConfirmations.clear();
    await this.context?.emit(paused ? 'telegram.remote.paused' : 'telegram.remote.resumed', this.manifest.id, {
      pairedChats: this.state.pairings.length,
    });
    await this.context?.audit('telegram', paused ? 'Telegram remote tasks paused.' : 'Telegram remote tasks resumed.', {
      pairedChats: this.state.pairings.length,
    }, paused ? 'warn' : 'info');
    return {
      ok: true,
      summary: paused ? 'Telegram remote task intake paused.' : 'Telegram remote task intake resumed.',
      output: this.statusPayload(false),
    };
  }

  private async revokePairingCapability(input: unknown): Promise<MonarchExecutionResult> {
    const requestedChatId = readNumber(input, 'chatId');
    const before = this.state.pairings.length;
    await this.mutateState((state) => {
      state.pairings = requestedChatId === undefined
        ? []
        : state.pairings.filter((entry) => entry.chatId !== requestedChatId);
      const pairedChats = new Set(state.pairings.map((entry) => entry.chatId));
      state.reminders = state.reminders.filter((entry) => pairedChats.has(entry.chatId));
    });
    this.scheduleReminderDelivery();
    for (const [id, pending] of this.pendingConfirmations) {
      if (requestedChatId === undefined || pending.chatId === requestedChatId) this.pendingConfirmations.delete(id);
    }
    const revoked = before - this.state.pairings.length;
    if (revoked > 0) {
      await this.context?.emit('telegram.pairing.revoked', this.manifest.id, {
        chatId: requestedChatId ?? null,
        revoked,
      });
    }
    return {
      ok: revoked > 0,
      summary: revoked > 0 ? `Revoked ${revoked} Telegram pairing(s).` : 'No matching Telegram pairing was found.',
      ...(revoked > 0 ? {} : { error: 'telegram-pairing-not-found' }),
      output: this.statusPayload(false),
    };
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.callApi<TelegramUpdate[]>('getUpdates', {
          offset: this.state.offset,
          timeout: 25,
          limit: 50,
          allowed_updates: ['message', 'callback_query'],
        }, signal);
        for (const update of updates) {
          await this.refreshState();
          if (update.update_id < this.state.offset) continue;
          const nextOffset = update.update_id + 1;
          // Persist before side effects: after a crash, an agent task must not be
          // executed twice just because Telegram redelivered the same update.
          await this.advanceOffset(nextOffset);
          await this.context?.emit('telegram.update.received', this.manifest.id, { updateId: update.update_id });
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (signal.aborted || !this.running) break;
        this.lastError = safeError(error);
        await this.context?.audit('telegram', 'Telegram polling failed.', { error: this.lastError }, 'warn');
        if (/409|terminated by other getUpdates/i.test(this.lastError)) {
          this.running = false;
          await this.releasePollingLock();
          this.standby = true;
          await this.context?.audit('telegram', 'Duplicate Telegram polling detected; this runtime switched to standby.', {}, 'warn');
          break;
        }
        await delay(1_500);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.from || message.from.is_bot) return;
    const text = String(message.text || message.caption || '').trim();
    if (!text || text.length > MAX_COMMAND_CHARS) return;
    if (!this.consumeRateLimit(message.from.id)) {
      if (this.shouldSendRateLimitNotice(message.from.id)) {
        await this.sendText(message.chat.id, 'Слишком много запросов. Telegram-вход временно приторможен.');
      }
      return;
    }

    if (/^\/pair(?:@\w+)?(?:\s+\d{6})?\s*$/i.test(text)) {
      await this.handlePair(message, text);
      return;
    }
    if (/^\d{6}$/.test(text) && !this.isPaired(message.chat.id, message.from.id)) {
      await this.handlePair(message, `/pair ${text}`);
      return;
    }
    if (/^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text) && !this.isPaired(message.chat.id, message.from.id)) {
      await this.ensureFreshPairingCode();
      await this.sendText(message.chat.id, this.state.remotePaused
        ? 'Новые привязки временно отключены локальным режимом защиты Monarch.'
        : telegramPairingHelp());
      return;
    }
    if (!this.isPaired(message.chat.id, message.from.id)) {
      await this.sendText(message.chat.id, this.state.remotePaused
        ? 'Новые привязки временно отключены локальным режимом защиты Monarch.'
        : telegramPairingHelp());
      return;
    }
    try {
      await this.handlePairedMessage(message, text);
    } catch (error) {
      await this.sendText(message.chat.id, `Команда Telegram не выполнена: ${safeError(error)}`).catch(() => undefined);
    }
  }

  private async handlePair(message: TelegramMessage, text: string): Promise<void> {
    const code = text.replace(/^\/pair(?:@\w+)?(?:\s+|$)/i, '').trim();
    await this.ensureFreshPairingCode();
    if (this.state.remotePaused) {
      await this.sendText(message.chat.id, 'Новые привязки временно отключены локальным режимом защиты Monarch.');
      return;
    }
    if (message.chat.type !== 'private' && process.env.MONARCH_TELEGRAM_ALLOW_GROUPS !== '1') {
      await this.sendText(message.chat.id, 'Для первой привязки используй личный чат с ботом.');
      return;
    }
    if (!code) {
      await this.sendText(message.chat.id, 'Открой Monarch Control → Telegram, создай код и пришли сюда шесть цифр одним сообщением.');
      return;
    }
    if (!message.from || !(await this.canAttemptPairing(message.chat.id, message.from.id))) {
      await this.sendText(message.chat.id, 'Слишком много неверных попыток. Новая проверка будет доступна позже.');
      return;
    }
    if (code !== this.pairingCode || Date.now() > this.pairingExpiresAt) {
      await this.recordPairingFailure(message.chat.id, message.from.id);
      await this.sendText(message.chat.id, 'Этот код не подошёл или уже истёк. Создай новый в Monarch Control → Telegram и пришли шесть цифр ещё раз.');
      return;
    }
    await this.clearPairingFailures(message.chat.id, message.from.id);
    const pairing: TelegramPairing = {
      chatId: message.chat.id,
      userId: message.from.id,
      pairedAt: new Date().toISOString(),
    };
    if (message.from.username) pairing.username = message.from.username;
    await this.mutateState((state) => {
      state.pairings = state.pairings.filter((entry) => entry.chatId !== pairing.chatId && entry.userId !== pairing.userId);
      state.pairings.push(pairing);
    });
    await this.rotatePairingCode();
    await this.context?.emit('telegram.paired', this.manifest.id, { chatId: pairing.chatId, userId: pairing.userId });
    await this.callApi('sendMessage', {
      chat_id: message.chat.id,
      text: 'Готово — связал этот чат с Monarch. Теперь просто напиши задачу обычным сообщением.',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Проверить связь', callback_data: 'quick:status' },
          { text: 'Что умеет бот', callback_data: 'quick:help' },
        ]],
      },
    });
  }

  private async handlePairedMessage(message: TelegramMessage, text: string): Promise<void> {
    const command = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    const name = command?.[1]?.toLowerCase() || '';
    const args = command?.[2]?.trim() || '';
    const pendingCount = this.countPendingConfirmations(message.chat.id, message.from!.id);
    const pausedControlCommands = new Set(['start', 'help', 'status', 'whoami', 'unlink', 'lockdown', 'pending', 'plugins']);
    const plainControlQuestion = !name && (
      isTelegramStatusQuestion(text)
      || isTelegramCapabilityQuestion(text)
      || isTelegramPluginQuestion(text)
      || isTelegramSecurityQuestion(text)
    );
    if (this.state.remotePaused && !pausedControlCommands.has(name) && !plainControlQuestion) {
      await this.sendText(message.chat.id, 'Удалённые задачи приостановлены. Возобновить их можно только локально в Monarch Control.');
      return;
    }
    if (name === 'start' || name === 'help') {
      await this.sendText(message.chat.id, telegramHelp());
      return;
    }
    if (name === 'status') {
      await this.sendText(message.chat.id, telegramStatusMessage(this.statusPayload(false), pendingCount));
      return;
    }
    if (name === 'whoami') {
      await this.sendText(message.chat.id, [
        'Текущая локальная привязка:',
        `chat_id: ${message.chat.id}`,
        `user_id: ${message.from!.id}`,
        `тип: ${message.chat.type}`,
      ].join('\n'));
      return;
    }
    if (name === 'unlink') {
      await this.sendText(message.chat.id, 'Привязка этого чата удалена. Для повторного доступа понадобится новый локальный код.');
      await this.revokePairingCapability({ chatId: message.chat.id });
      return;
    }
    if (name === 'lockdown') {
      await this.setRemotePaused(true);
      await this.sendText(message.chat.id, 'Удалённые задачи и новые привязки остановлены. Возобновление доступно только локально в Monarch Control.');
      return;
    }
    if (name === 'pending') {
      const pending = this.activePendingConfirmations(message.chat.id, message.from!.id);
      await this.sendText(message.chat.id, pending.length
        ? `Ожидают решения: ${pending.length}. Используй кнопки под исходными сообщениями.`
        : 'Ожидающих подтверждений нет.');
      return;
    }
    if (name === 'security') {
      await this.dispatchTask(message.chat.id, message.from!.id, 'покажи краткий статус Monarch Security и только реальные активные предупреждения');
      return;
    }
    if (name === 'skills') {
      await this.dispatchTask(message.chat.id, message.from!.id, 'покажи кратко локальные Agent Skills Monarch, подходящие для Telegram');
      return;
    }
    if (name === 'plugins') {
      const result = this.describeCapabilitiesCapability({ topic: 'plugins' });
      await this.sendText(message.chat.id, String((result.output as Record<string, unknown>).reply || result.summary));
      return;
    }
    if (name === 'remind') {
      await this.createReminderFromCommand(message.chat.id, args);
      return;
    }
    if (name === 'reminders') {
      await this.sendText(message.chat.id, formatReminders(this.state.reminders.filter((item) => item.chatId === message.chat.id)));
      return;
    }
    if (name === 'cancel') {
      await this.cancelReminderFromCommand(message.chat.id, args);
      return;
    }
    if (name === 'poll') {
      await this.sendPollFromCommand(message.chat.id, args);
      return;
    }
    if (name === 'table') {
      await this.sendTableFromCommand(message.chat.id, args);
      return;
    }
    if (name === 'api') {
      await this.callApiFromCommand(message.chat.id, message.from!.id, args);
      return;
    }
    if (name && name !== 'task') {
      await this.sendText(message.chat.id, `Команды /${name} нет. Используй /help или просто напиши задачу обычным текстом.`);
      return;
    }
    const naturalReminder = parseNaturalReminder(text);
    if (naturalReminder) {
      const reminderInput = parseReminderPayload(naturalReminder.text, naturalReminder.dueAt);
      if (!reminderInput.ok) {
        await this.sendText(message.chat.id, reminderCommandErrorMessage(reminderInput.summary));
        return;
      }
      const reminder = await this.createReminder(message.chat.id, reminderInput.text, reminderInput.dueAt);
      await this.sendText(message.chat.id, `Хорошо, напомню ${formatDate(reminder.dueAt)}.`);
      return;
    }
    await this.dispatchTask(message.chat.id, message.from!.id, name === 'task' ? args : text);
  }

  private async dispatchTask(chatId: number, userId: number, text: string): Promise<void> {
    if (!text || !this.dispatcher) {
      await this.sendText(chatId, this.dispatcher ? 'Напиши задачу после /task.' : 'Monarch ещё не подключил внутренний dispatcher.');
      return;
    }
    const progress = await this.callApi<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text: 'Принял. Выполняю…',
    });
    const sendTyping = () => this.callApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
    await sendTyping();
    const typingTimer = setInterval(() => void sendTyping(), 4_000);
    try {
      const result = await this.dispatcher({
        text,
        context: telegramIntentContext(chatId, userId),
      });
      const confirmation = result.confirmation;
      if (result.execution?.error === 'confirmation-required' && confirmation?.token) {
        const id = randomUUID().replace(/-/g, '').slice(0, 16);
        const pending: PendingIntentConfirmation = {
          kind: 'intent',
          id,
          chatId,
          userId,
          text,
          token: confirmation.token,
          expiresAt: Date.now() + PENDING_CONFIRMATION_TTL_MS,
        };
        if (!this.registerPendingConfirmation(pending)) {
          await this.completeTaskMessage(chatId, progress.message_id, pendingConfirmationLimitMessage());
          return;
        }
        await this.callApi('editMessageText', {
          chat_id: chatId,
          message_id: progress.message_id,
          text: `${result.execution.summary}\n\nРазрешить это действие один раз?`,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Разрешить один раз', callback_data: `confirm:${id}` },
              { text: 'Отмена', callback_data: `deny:${id}` },
            ]],
          },
        });
        return;
      }
      await this.completeTaskMessage(chatId, progress.message_id, formatIntentResult(result));
    } catch (error) {
      await this.completeTaskMessage(chatId, progress.message_id, `Не получилось завершить задачу: ${safeError(error)}`);
    } finally {
      clearInterval(typingTimer);
    }
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const chatId = callback.message?.chat.id;
    if (!chatId || !this.isPaired(chatId, callback.from.id)) return;
    const [action, id] = String(callback.data || '').split(':', 2);
    if (action === 'quick') {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => undefined);
      await this.sendText(chatId, id === 'status'
        ? 'Связь работает. Этот чат подключён к локальному Monarch.'
        : telegramHelp());
      return;
    }
    if (this.state.remotePaused) {
      if (id) this.pendingConfirmations.delete(id);
      await this.callApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Удалённые задачи остановлены локальным защитным режимом.',
      }).catch(() => undefined);
      if (callback.message?.message_id) {
        await this.callApi('editMessageText', {
          chat_id: chatId,
          message_id: callback.message.message_id,
          text: 'Удалённые задачи остановлены локальным защитным режимом. Повтори действие после локального возобновления доступа.',
        }).catch(() => undefined);
      }
      return;
    }
    this.purgeExpiredPendingConfirmations();
    const pending = id ? this.pendingConfirmations.get(id) : undefined;
    if (!pending || pending.chatId !== chatId || pending.userId !== callback.from.id || pending.expiresAt < Date.now()) {
      if (id) this.pendingConfirmations.delete(id);
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Подтверждение истекло.' }).catch(() => undefined);
      return;
    }
    if (action !== 'confirm' && action !== 'deny') {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Неизвестное действие.' }).catch(() => undefined);
      return;
    }
    this.pendingConfirmations.delete(pending.id);
    if (action === 'deny') {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Действие отменено.' });
      await this.callApi('editMessageText', {
        chat_id: chatId,
        message_id: callback.message?.message_id,
        text: 'Действие отменено.',
      }).catch(() => undefined);
      return;
    }
    await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Разрешение принято.' });
    if (callback.message?.message_id) {
      await this.callApi('editMessageText', {
        chat_id: chatId,
        message_id: callback.message.message_id,
        text: 'Разрешение принято. Выполняю…',
      }).catch(() => undefined);
    }
    if (pending.kind === 'api') {
      try {
        const result = await this.callApi(pending.method, pending.parameters);
        const text = `Bot API ${pending.method}: ${safeJson(result, 2800)}`;
        if (callback.message?.message_id) {
          await this.completeTaskMessage(chatId, callback.message.message_id, text);
        } else {
          await this.sendText(chatId, text);
        }
      } catch (error) {
        await this.sendText(chatId, `Bot API ${pending.method} не выполнен: ${safeError(error)}`);
      }
      return;
    }
    if (!this.dispatcher) return;
    try {
      const result = await this.dispatcher({
        text: pending.text,
        confirmed: true,
        confirmationToken: pending.token,
        context: telegramIntentContext(chatId, callback.from.id),
      });
      if (callback.message?.message_id) {
        await this.completeTaskMessage(chatId, callback.message.message_id, formatIntentResult(result));
      } else {
        await this.sendText(chatId, formatIntentResult(result));
      }
    } catch (error) {
      await this.sendText(chatId, `Подтверждённое действие не завершилось: ${safeError(error)}`);
    }
  }

  private async createReminderFromCommand(chatId: number, args: string): Promise<void> {
    const parsed = parseReminderCommand(args);
    if (!parsed) {
      await this.sendText(chatId, 'Формат: /remind 10m текст или /remind 2026-06-30T18:00:00+03:00 текст');
      return;
    }
    const reminderInput = parseReminderPayload(parsed.text, parsed.dueAt);
    if (!reminderInput.ok) {
      await this.sendText(chatId, reminderCommandErrorMessage(reminderInput.summary));
      return;
    }
    const reminder = await this.createReminder(chatId, reminderInput.text, reminderInput.dueAt);
    await this.sendText(chatId, `Напоминание ${reminder.id} поставлено на ${formatDate(reminder.dueAt)}.`);
  }

  private async createReminder(chatId: number, text: string, dueAt: string): Promise<TelegramReminder> {
    const reminderInput = parseReminderPayload(text, dueAt);
    if (!reminderInput.ok) throw new Error(reminderInput.summary);
    const reminder: TelegramReminder = {
      id: randomUUID().slice(0, 8),
      chatId,
      text: reminderInput.text,
      dueAt: reminderInput.dueAt,
      createdAt: new Date().toISOString(),
    };
    await this.mutateState((state) => {
      state.reminders.push(reminder);
    });
    this.scheduleReminderDelivery();
    return reminder;
  }

  private async cancelReminderFromCommand(chatId: number, id: string): Promise<void> {
    const result = await this.cancelReminder(id, chatId);
    await this.sendText(chatId, result.status === 'cancelled'
      ? `Напоминание ${id} отменено.`
      : result.status === 'ambiguous'
        ? `Найдено несколько напоминаний ${id}. Уточни список через /reminders.`
        : `Напоминание ${id} не найдено.`);
  }

  private async deliverDueReminders(): Promise<void> {
    if (!this.running) return;
    await this.refreshState();
    const now = Date.now();
    const due = this.state.reminders.filter((item) => Date.parse(item.dueAt) <= now);
    if (!due.length) return;
    for (const reminder of due) {
      try {
        await this.sendText(reminder.chatId, `⏰ ${reminder.text}`);
        await this.mutateState((state) => {
          state.reminders = state.reminders.filter((item) => !isSameReminder(item, reminder));
        });
        await this.context?.emit('telegram.reminder.sent', this.manifest.id, { id: reminder.id, chatId: reminder.chatId });
      } catch (error) {
        this.lastError = safeError(error);
      }
    }
  }

  private async startReminderScheduler(): Promise<void> {
    this.reminderWatcher?.close();
    this.reminderWatcher = null;
    this.reminderRefreshMs = REMINDER_WATCH_FALLBACK_MS;
    try {
      const stateDirectory = path.dirname(this.statePath);
      await mkdir(stateDirectory, { recursive: true });
      this.reminderWatcher = watch(stateDirectory, { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== path.basename(this.statePath)) return;
        this.scheduleReminderDelivery(REMINDER_WATCH_DEBOUNCE_MS);
      });
      this.reminderWatcher.on('error', () => {
        this.reminderWatcher?.close();
        this.reminderWatcher = null;
        this.reminderRefreshMs = REMINDER_POLL_FALLBACK_MS;
        this.scheduleReminderDelivery();
      });
    } catch {
      this.reminderRefreshMs = REMINDER_POLL_FALLBACK_MS;
    }
    this.scheduleReminderDelivery(0);
  }

  private scheduleReminderDelivery(overrideDelayMs?: number): void {
    if (!this.running) return;
    if (this.reminderDeliveryActive) {
      return;
    }
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    const now = Date.now();
    const nextDueAt = this.state.reminders.reduce((earliest, reminder) => {
      const dueAt = Date.parse(reminder.dueAt);
      return Number.isFinite(dueAt) && dueAt < earliest ? dueAt : earliest;
    }, Number.POSITIVE_INFINITY);
    const delay = overrideDelayMs ?? Math.min(
      this.reminderRefreshMs,
      Number.isFinite(nextDueAt) ? Math.max(0, nextDueAt - now) : this.reminderRefreshMs,
    );
    this.reminderTimer = setTimeout(() => {
      this.reminderTimer = null;
      this.reminderDeliveryActive = true;
      const deliveryTask = this.deliverDueReminders()
        .catch((error) => { this.lastError = safeError(error); })
        .finally(() => {
          this.reminderDeliveryActive = false;
          if (this.reminderDeliveryTask === deliveryTask) {
            this.reminderDeliveryTask = null;
          }
          this.scheduleReminderDelivery();
        });
      this.reminderDeliveryTask = deliveryTask;
    }, delay);
  }

  private async sendPollFromCommand(chatId: number, args: string): Promise<void> {
    const parsed = parsePollCommand(args);
    if (!parsed.ok) {
      await this.sendText(chatId, parsed.message);
      return;
    }
    await this.callApi('sendPoll', {
      chat_id: chatId,
      question: parsed.question,
      options: parsed.options,
      is_anonymous: false,
      allows_revoting: true,
    });
  }

  private async sendTableFromCommand(chatId: number, args: string): Promise<void> {
    const parsed = parseTableCommand(args);
    if (!parsed.ok) {
      await this.sendText(chatId, parsed.message);
      return;
    }
    try {
      await this.callApi('sendRichMessage', { chat_id: chatId, rich_message: { markdown: parsed.markdown } });
    } catch {
      await this.sendText(chatId, parsed.markdown);
    }
  }

  private async callApiFromCommand(chatId: number, userId: number, args: string): Promise<void> {
    const match = args.match(/^(\w+)(?:\s+([\s\S]+))?$/);
    if (!match) {
      await this.sendText(chatId, 'Формат: /api METHOD {"parameter":"value"}');
      return;
    }
    const method = match[1]!;
    let parameters: Record<string, unknown>;
    try {
      assertTelegramBotApiMethodAllowed(method);
      parameters = parseTelegramApiCommandParameters(match[2]);
    } catch (error) {
      await this.sendText(chatId, telegramApiInputHelp(safeError(error)));
      return;
    }
    const targetViolation = findTelegramApiChatReferenceViolation(parameters, (targetChatId) => targetChatId === chatId);
    if (targetViolation?.key === 'chat_id') {
      throw new Error('Из Telegram-чата можно вызывать Bot API только для текущего chat_id.');
    }
    if (targetViolation?.key === 'from_chat_id') {
      throw new Error('Из Telegram-чата нельзя читать или копировать данные другого chat_id.');
    }
    if (telegramApiMethodDefaultsToChatId(method) && !('chat_id' in parameters)) {
      parameters.chat_id = chatId;
    }
    if (!/^get/i.test(method)) {
      const id = randomUUID().replace(/-/g, '').slice(0, 16);
      const pending: PendingApiConfirmation = {
        kind: 'api',
        id,
        chatId,
        userId,
        method,
        parameters,
        expiresAt: Date.now() + PENDING_CONFIRMATION_TTL_MS,
      };
      if (!this.registerPendingConfirmation(pending)) {
        await this.sendText(chatId, pendingConfirmationLimitMessage());
        return;
      }
      await this.callApi('sendMessage', {
        chat_id: chatId,
        text: `Bot API ${method} изменит состояние Telegram. Разрешить этот вызов один раз?`,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Разрешить один раз', callback_data: `confirm:${id}` },
            { text: 'Отмена', callback_data: `deny:${id}` },
          ]],
        },
      });
      return;
    }
    const result = await this.callApi(method, parameters);
    await this.sendText(chatId, `Bot API ${method}: ${safeJson(result, 2800)}`);
  }

  private async sendCapability(input: unknown): Promise<MonarchExecutionResult> {
    const text = readString(input, 'text');
    const chatId = this.resolvePairedChat(readNumber(input, 'chatId'));
    if (!text || chatId === null) return { ok: false, summary: 'A paired chat and message text are required.', error: 'telegram-send-input-invalid' };
    await this.sendText(chatId, text);
    return { ok: true, summary: 'Telegram message sent.', output: { chatId, chars: text.length } };
  }

  private async pollCapability(input: unknown): Promise<MonarchExecutionResult> {
    const chatId = this.resolvePairedChat(readNumber(input, 'chatId'));
    const question = readString(input, 'question');
    const options = readStringArray(input, 'options');
    const parsed = parsePollPayload(question, options);
    if (chatId === null) {
      return { ok: false, summary: 'A paired chat is required.', error: 'telegram-poll-input-invalid' };
    }
    if (!parsed.ok) {
      return { ok: false, summary: parsed.summary, error: 'telegram-poll-input-invalid' };
    }
    const result = await this.callApi('sendPoll', {
      chat_id: chatId,
      question: parsed.question,
      options: parsed.options,
      allows_multiple_answers: readBoolean(input, 'multiple'),
    });
    return { ok: true, summary: 'Telegram poll sent.', output: sanitizeTelegramResult(result) };
  }

  private async createReminderCapability(input: unknown): Promise<MonarchExecutionResult> {
    const chatId = this.resolvePairedChat(readNumber(input, 'chatId'));
    const text = readString(input, 'text');
    const dueAt = readString(input, 'dueAt');
    const reminderInput = parseReminderPayload(text, dueAt);
    if (chatId === null) {
      return { ok: false, summary: 'A paired chat is required.', error: 'telegram-reminder-input-invalid' };
    }
    if (!reminderInput.ok) {
      return { ok: false, summary: reminderInput.summary, error: 'telegram-reminder-input-invalid' };
    }
    const reminder = await this.createReminder(chatId, reminderInput.text, reminderInput.dueAt);
    return { ok: true, summary: `Telegram reminder ${reminder.id} created.`, output: reminder };
  }

  private listRemindersCapability(input: unknown): MonarchExecutionResult {
    const requested = readNumber(input, 'chatId');
    const reminders = this.state.reminders.filter((item) => requested === undefined || item.chatId === requested);
    return { ok: true, summary: `Listed ${reminders.length} Telegram reminders.`, output: { reminders } };
  }

  private async cancelReminderCapability(input: unknown): Promise<MonarchExecutionResult> {
    const id = readString(input, 'id');
    const chatId = readNumber(input, 'chatId');
    const result = await this.cancelReminder(id, chatId);
    if (result.status === 'invalid') {
      return { ok: false, summary: 'A reminder id is required.', error: 'telegram-reminder-input-invalid' };
    }
    if (result.status === 'ambiguous') {
      return {
        ok: false,
        summary: `Telegram reminder ${id} matches multiple pending reminders; provide chatId to cancel exactly one.`,
        error: 'telegram-reminder-ambiguous',
      };
    }
    return {
      ok: result.status === 'cancelled',
      summary: result.status === 'cancelled'
        ? `Telegram reminder ${id} cancelled.`
        : `Telegram reminder ${id} not found.`,
      ...(result.status === 'cancelled' ? { output: { id, chatId: result.chatId } } : { error: 'telegram-reminder-not-found' }),
    };
  }

  private async cancelReminder(id: string, chatId?: number): Promise<{ status: 'invalid' | 'not-found' | 'ambiguous' | 'cancelled'; chatId?: number }> {
    if (!id) return { status: 'invalid' };
    const result = await this.mutateState<{ status: 'not-found' | 'ambiguous' | 'cancelled'; chatId?: number }>((state) => {
      const matches = state.reminders.filter((item) => item.id === id && (chatId === undefined || item.chatId === chatId));
      if (!matches.length) return { status: 'not-found' };
      if (matches.length > 1) return { status: 'ambiguous' };
      const target = matches[0]!;
      state.reminders = state.reminders.filter((item) => !isSameReminder(item, target));
      return { status: 'cancelled', chatId: target.chatId };
    });
    this.scheduleReminderDelivery();
    return result;
  }

  private async genericApiCapability(input: unknown): Promise<MonarchExecutionResult> {
    const apiInput = readTelegramApiCapabilityInput(input);
    if (!apiInput.ok) return { ok: false, summary: apiInput.summary, error: apiInput.error };
    const { method } = apiInput;
    const parameters = { ...apiInput.parameters };
    const targetViolation = findTelegramApiChatReferenceViolation(parameters, (chatId) => this.state.pairings.some((entry) => entry.chatId === chatId));
    if (targetViolation) {
      return {
        ok: false,
        summary: `Telegram Bot API ${targetViolation.path} must reference a paired chat.`,
        error: 'telegram-api-unpaired-chat',
      };
    }
    if (!('chat_id' in parameters) && telegramApiMethodDefaultsToChatId(method)) {
      const chatId = this.resolvePairedChat();
      if (chatId === null) {
        return {
          ok: false,
          summary: 'Telegram Bot API chat_id must reference one paired chat.',
          error: 'telegram-api-chat-required',
        };
      }
      parameters.chat_id = chatId;
    }
    const result = await this.callApi(method, parameters);
    return { ok: true, summary: `Telegram Bot API method ${method} completed.`, output: sanitizeTelegramResult(result) };
  }

  private describeCapabilitiesCapability(input: unknown): MonarchExecutionResult {
    const topic = readString(input, 'topic');
    const pending = this.activePendingConfirmations().length;
    const status = this.statusPayload(false);
    const reply = topic === 'plugins'
      ? telegramPluginHelp()
      : topic === 'security'
        ? telegramSecurityHelp(status, pending)
        : telegramCapabilityHelp(status, pending);
    return {
      ok: true,
      summary: 'Telegram bot capabilities described.',
      output: {
        topic: topic || 'capabilities',
        reply,
        status,
      },
    };
  }

  private async sendText(chatId: number, text: string): Promise<void> {
    for (const part of splitMessage(text || 'Готово.')) {
      await this.callApi('sendMessage', { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } });
    }
  }

  private async completeTaskMessage(chatId: number, messageId: number, text: string): Promise<void> {
    const parts = splitMessage(text || 'Готово.');
    if (parts.length === 1) {
      await this.callApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: parts[0],
        link_preview_options: { is_disabled: true },
      }).catch(() => this.sendText(chatId, parts[0]!));
      return;
    }
    await this.callApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: 'Готово. Ответ ниже.',
    }).catch(() => undefined);
    await this.sendText(chatId, text);
  }

  private async callApi<T = unknown>(method: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!this.token) throw new Error('Telegram bot token is not configured.');
    assertTelegramBotApiMethodName(method);
    const response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parameters),
      ...(signal ? { signal } : {}),
    });
    const payload = await response.json() as TelegramApiResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram Bot API ${method} failed (${payload.error_code || response.status}): ${payload.description || 'unknown error'}`);
    }
    return payload.result as T;
  }

  private isPaired(chatId: number, userId: number): boolean {
    return this.state.pairings.some((entry) => entry.chatId === chatId && entry.userId === userId);
  }

  private resolvePairedChat(requested?: number): number | null {
    if (requested !== undefined && this.state.pairings.some((entry) => entry.chatId === requested)) return requested;
    return this.state.pairings.length === 1 ? this.state.pairings[0]!.chatId : null;
  }

  private consumeRateLimit(userId: number): boolean {
    const now = Date.now();
    this.pruneRateLimitState(now);
    const window = (this.rateWindows.get(userId) || []).filter((time) => now - time < RATE_WINDOW_MS);
    if (window.length >= RATE_LIMIT) return false;
    window.push(now);
    this.rateWindows.delete(userId);
    this.rateWindows.set(userId, window);
    trimOldestMapEntries(this.rateWindows, MAX_TRACKED_RATE_LIMIT_USERS);
    return true;
  }

  private shouldSendRateLimitNotice(userId: number): boolean {
    const now = Date.now();
    const previous = this.rateLimitNotices.get(userId) || 0;
    if (now - previous < RATE_WINDOW_MS) return false;
    this.rateLimitNotices.delete(userId);
    this.rateLimitNotices.set(userId, now);
    trimOldestMapEntries(this.rateLimitNotices, MAX_TRACKED_RATE_LIMIT_USERS);
    return true;
  }

  private pruneRateLimitState(now: number): void {
    if (this.rateWindows.size < MAX_TRACKED_RATE_LIMIT_USERS && this.rateLimitNotices.size < MAX_TRACKED_RATE_LIMIT_USERS) return;
    for (const [userId, timestamps] of this.rateWindows) {
      const active = timestamps.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
      if (!active.length) this.rateWindows.delete(userId);
      else if (active.length !== timestamps.length) this.rateWindows.set(userId, active);
    }
    for (const [userId, timestamp] of this.rateLimitNotices) {
      if (now - timestamp >= RATE_WINDOW_MS) this.rateLimitNotices.delete(userId);
    }
  }

  private registerPendingConfirmation(pending: PendingConfirmation): boolean {
    this.purgeExpiredPendingConfirmations();
    if (this.activePendingConfirmations(pending.chatId, pending.userId).length >= MAX_PENDING_CONFIRMATIONS_PER_CHAT_USER) {
      return false;
    }
    if (this.pendingConfirmations.size >= MAX_PENDING_CONFIRMATIONS_TOTAL) {
      return false;
    }
    this.pendingConfirmations.set(pending.id, pending);
    return true;
  }

  private activePendingConfirmations(chatId?: number, userId?: number): PendingConfirmation[] {
    this.purgeExpiredPendingConfirmations();
    return Array.from(this.pendingConfirmations.values())
      .filter((item) => (chatId === undefined || item.chatId === chatId)
        && (userId === undefined || item.userId === userId));
  }

  private purgeExpiredPendingConfirmations(now = Date.now()): void {
    for (const [id, pending] of this.pendingConfirmations) {
      if (pending.expiresAt <= now) this.pendingConfirmations.delete(id);
    }
  }

  private countPendingConfirmations(chatId: number, userId: number): number {
    return this.activePendingConfirmations(chatId, userId).length;
  }

  private async canAttemptPairing(chatId: number, userId: number): Promise<boolean> {
    const key = pairingAttemptKey(chatId, userId);
    let allowed = true;
    await this.mutateState((state) => {
      const current = state.pairingAttempts[key];
      if (!current) return;
      const now = Date.now();
      if (current.blockedUntil > now) {
        allowed = false;
        return;
      }
      const attempts = current.attempts.filter((attempt) => now - attempt < PAIRING_ATTEMPT_WINDOW_MS);
      if (attempts.length) state.pairingAttempts[key] = { attempts, blockedUntil: 0 };
      else delete state.pairingAttempts[key];
    });
    return allowed;
  }

  private async recordPairingFailure(chatId: number, userId: number): Promise<void> {
    const key = pairingAttemptKey(chatId, userId);
    const now = Date.now();
    let blocked = false;
    await this.mutateState((state) => {
      const current = state.pairingAttempts[key] || { attempts: [], blockedUntil: 0 };
      current.attempts = current.attempts.filter((attempt) => now - attempt < PAIRING_ATTEMPT_WINDOW_MS);
      current.attempts.push(now);
      if (current.attempts.length >= PAIRING_ATTEMPT_LIMIT) {
        current.blockedUntil = now + PAIRING_COOLDOWN_MS;
        current.attempts = [];
        blocked = true;
      }
      state.pairingAttempts[key] = current;
    });
    if (blocked) {
      await this.context?.audit('telegram', 'Telegram pairing temporarily blocked after repeated failures.', {
        chatId,
        userId,
      }, 'warn');
    }
  }

  private async clearPairingFailures(chatId: number, userId: number): Promise<void> {
    await this.mutateState((state) => {
      delete state.pairingAttempts[pairingAttemptKey(chatId, userId)];
    });
  }

  private async rotatePairingCode(): Promise<void> {
    await this.syncPairingCode(true);
  }

  private async ensureFreshPairingCode(): Promise<void> {
    await this.syncPairingCode(false);
  }

  private statusPayload(includePairingCode: boolean): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      configured: Boolean(this.token),
      running: this.running || this.standby,
      pollingMode: this.running ? 'owner' : this.standby ? 'standby' : 'stopped',
      pollingOwnedByThisProcess: this.running,
      apiBase: redactApiBase(this.apiBase),
      bot: this.botIdentity,
      pairedChats: this.state.pairings.map(({ chatId, userId, username, pairedAt }) => ({ chatId, userId, username, pairedAt })),
      reminders: this.state.reminders.length,
      remotePaused: this.state.remotePaused,
      pendingConfirmations: this.activePendingConfirmations().length,
      dispatcherReady: Boolean(this.dispatcher),
      remoteMode: this.state.remotePaused ? 'lockdown' : this.running || this.standby ? 'agent' : 'stopped',
      securityMode: 'paired-chat + confirmation-gated',
      lastError: this.lastError || null,
      botApiCompatibility: '10.1+ generic method adapter',
    };
    if (includePairingCode) {
      payload.pairingCode = this.state.remotePaused ? '' : this.pairingCode;
      payload.pairingExpiresAt = this.state.remotePaused ? null : new Date(this.pairingExpiresAt).toISOString();
      payload.tokenPath = this.tokenPath;
    }
    return payload;
  }

  private async loadState(): Promise<void> {
    await this.refreshState();
  }

  private async refreshState(): Promise<void> {
    this.state = await this.readStateFile();
  }

  private async readStateFile(): Promise<TelegramState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<TelegramState>;
      if (this.lastStateReadError && this.lastError.startsWith('Telegram state unavailable')) {
        this.lastError = '';
      }
      this.lastStateReadError = '';
      const pairings = Array.isArray(parsed.pairings) ? parsed.pairings.filter(validPairing) : [];
      const pairedChatIds = new Set(pairings.map((pairing) => pairing.chatId));
      return {
        offset: Number.isSafeInteger(parsed.offset) ? Number(parsed.offset) : 0,
        pairings,
        reminders: Array.isArray(parsed.reminders)
          ? parsed.reminders
            .filter(validReminder)
            .filter((reminder) => pairedChatIds.has(reminder.chatId))
          : [],
        remotePaused: parsed.remotePaused === true,
        pairingAttempts: readPairingAttempts(parsed.pairingAttempts),
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        this.lastStateReadError = '';
        return defaultTelegramState(false);
      }
      const message = safeError(error);
      if (message !== this.lastStateReadError) {
        this.lastStateReadError = message;
        this.lastError = `Telegram state unavailable; remote access paused: ${message}`;
        void this.context?.audit('telegram', 'Telegram state could not be read; remote access failed closed.', {
          error: message,
        }, 'warn');
      }
      return defaultTelegramState(true);
    }
  }

  private async mutateState<T>(mutator: (state: TelegramState) => T | Promise<T>): Promise<T> {
    const token = await acquireFileLock(this.stateLockPath, TRANSIENT_LOCK_TIMEOUT_MS, TRANSIENT_LOCK_STALE_MS);
    if (!token) throw new Error('Telegram state is busy in another local Monarch runtime.');
    try {
      const state = await this.readStateFile();
      const result = await mutator(state);
      await this.writeStateFile(state);
      this.state = state;
      return result;
    } finally {
      await releaseFileLock(this.stateLockPath, token);
    }
  }

  private async advanceOffset(offset: number): Promise<void> {
    await this.mutateState((state) => {
      state.offset = Math.max(state.offset, offset);
    });
  }

  private async writeStateFile(state: TelegramState): Promise<void> {
    await writeAtomicJson(this.statePath, state);
  }

  private async syncPairingCode(force: boolean): Promise<void> {
    const token = await acquireFileLock(this.pairingLockPath, TRANSIENT_LOCK_TIMEOUT_MS, TRANSIENT_LOCK_STALE_MS);
    if (!token) throw new Error('Telegram pairing code is busy in another local Monarch runtime.');
    try {
      let snapshot = await readPairingSnapshot(this.pairingPath);
      const expiresAt = snapshot ? Date.parse(snapshot.expiresAt) : 0;
      if (force || !snapshot || !/^\d{6}$/.test(snapshot.code) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        let nextCode = '';
        do {
          nextCode = String(randomInt(100_000, 1_000_000));
        } while (nextCode === snapshot?.code);
        snapshot = { code: nextCode, expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString() };
        await writeAtomicJson(this.pairingPath, snapshot);
      }
      this.pairingCode = snapshot.code;
      this.pairingExpiresAt = Date.parse(snapshot.expiresAt);
    } finally {
      await releaseFileLock(this.pairingLockPath, token);
    }
  }

  private async acquirePollingLock(): Promise<boolean> {
    const token = await acquireFileLock(this.pollingLockPath, 0, Number.POSITIVE_INFINITY);
    if (!token) return false;
    this.pollingLockToken = token;
    return true;
  }

  private async releasePollingLock(): Promise<void> {
    if (!this.pollingLockToken) return;
    const token = this.pollingLockToken;
    this.pollingLockToken = '';
    await releaseFileLock(this.pollingLockPath, token);
  }
}

function route(intent: MonarchIntent, capabilityId: string, risk: 'read' | 'network' | 'execute', input: Record<string, unknown>): MonarchRouteDecision {
  return {
    intentId: intent.id,
    targetModuleId: 'telegram',
    capabilityId,
    confidence: 0.98,
    reason: 'Telegram integration request detected.',
    permissionMode: permissionModeForRisk(risk),
    input,
  };
}

function normalizeApiBase(value: string): string {
  const url = new URL(value);
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  const isOfficialTelegram = url.protocol === 'https:' && url.hostname === OFFICIAL_TELEGRAM_API_HOST;
  const remoteOverrideAllowed = process.env.MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE === '1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Telegram API base must use HTTPS or a loopback HTTP local Bot API server.');
  }
  if (!isLoopback && !isOfficialTelegram && !remoteOverrideAllowed) {
    throw new Error('Telegram API base must be the official Telegram endpoint or a loopback local Bot API server. Set MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE=1 only for a trusted custom endpoint.');
  }
  return url.toString().replace(/\/$/, '');
}

type ReminderPayloadResult = { ok: true; text: string; dueAt: string } | { ok: false; summary: string };

function parseReminderPayload(text: string, dueAt: string): ReminderPayloadResult {
  const normalizedText = text.trim();
  const timestamp = Date.parse(dueAt);
  if (!normalizedText || !Number.isFinite(timestamp)) {
    return { ok: false, summary: 'A reminder text and valid dueAt are required.' };
  }
  if (normalizedText.length > MAX_REMINDER_TEXT_CHARS) {
    return { ok: false, summary: `Reminder text is too long; maximum ${MAX_REMINDER_TEXT_CHARS} characters.` };
  }
  return { ok: true, text: normalizedText, dueAt: new Date(timestamp).toISOString() };
}

function reminderCommandErrorMessage(summary: string): string {
  if (summary.includes(`maximum ${MAX_REMINDER_TEXT_CHARS}`)) {
    return `Напоминание слишком длинное: максимум ${MAX_REMINDER_TEXT_CHARS} символов.`;
  }
  return 'Формат: /remind 10m текст или /remind 2026-06-30T18:00:00+03:00 текст';
}

function parseReminderCommand(value: string): { dueAt: string; text: string } | null {
  const match = value.match(/^(\d+)\s*(s|m|h|d|сек(?:унд[ыа]?)?|мин(?:ут[ыа]?)?|ч(?:ас(?:а|ов)?)?|дн(?:я|ей)?)\s+([\s\S]+)$/i);
  if (match) {
    const unit = match[2]!.toLowerCase();
    const multiplier = unit.startsWith('s') || unit.startsWith('сек') ? 1_000
      : unit.startsWith('m') || unit.startsWith('мин') ? 60_000
        : unit.startsWith('h') || unit.startsWith('ч') ? 3_600_000
          : 86_400_000;
    const dueAt = isoFromTimestamp(Date.now() + Number(match[1]) * multiplier);
    return dueAt ? { dueAt, text: match[3]!.trim() } : null;
  }
  const absolute = value.match(/^(\S+)\s+([\s\S]+)$/);
  if (absolute && Number.isFinite(Date.parse(absolute[1]!))) {
    return { dueAt: new Date(absolute[1]!).toISOString(), text: absolute[2]!.trim() };
  }
  return null;
}

function parseNaturalReminder(value: string): { dueAt: string; text: string } | null {
  const match = value.match(/^напомни(?:\s+мне)?\s+через\s+(\d+)\s*(секунд[уы]?|минут[уы]?|час(?:а|ов)?|дн(?:я|ей)?)\s+(.+)$/i);
  if (!match) return null;
  const unit = match[2]!.toLowerCase();
  const multiplier = unit.startsWith('сек') ? 1_000
    : unit.startsWith('мин') ? 60_000
      : unit.startsWith('час') ? 3_600_000
        : 86_400_000;
  const dueAt = isoFromTimestamp(Date.now() + Number(match[1]) * multiplier);
  return dueAt ? { dueAt, text: match[3]!.trim() } : null;
}

function isoFromTimestamp(timestamp: number): string | null {
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatIntentResult(result: MonarchIntentResult): string {
  const execution = result.execution;
  if (!execution) return result.summary || 'Monarch не нашёл исполняемый маршрут.';
  const output = execution.output as Record<string, unknown> | undefined;
  const response = output?.response as Record<string, unknown> | undefined;
  const direct = [
    output?.reply,
    output?.content,
    output?.message,
    output?.result,
    response?.answer,
    response?.content,
    response?.reply,
  ].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  if (direct) return direct;
  const capabilities = Array.isArray(output?.capabilities) ? output.capabilities as Array<Record<string, unknown>> : [];
  if (capabilities.length) return formatTelegramCapabilities(capabilities);
  const modules = Array.isArray(output?.modules) ? output.modules as Array<Record<string, unknown>> : [];
  if (modules.length) return formatTelegramModules(modules);
  const entries = Array.isArray(output?.entries) ? output.entries as Array<Record<string, unknown>> : [];
  if (entries.length) {
    return `${result.summary}\n\n${entries.slice(0, 50).map((entry) => `- ${String(entry.name || entry.path || 'item')}${entry.type === 'directory' ? '/' : ''}`).join('\n')}`;
  }
  if (!execution.ok) return `Не получилось: ${execution.summary || result.summary}`;
  return execution.summary || result.summary || 'Готово.';
}

function telegramHelp(): string {
  return [
    'Здесь можно общаться с Monarch почти так же, как в приложении.',
    '',
    'Просто напиши:',
    '• «проверь свободное место на диске»',
    '• «напомни через 20 минут выключить духовку»',
    '• «создай файл notes.md»',
    '',
    'Команды: /status, /security, /skills, /reminders, /poll, /table.',
    'Интеграции: /plugins.',
    'Контроль: /pending, /whoami, /unlink, /lockdown.',
    'Для опасных действий бот отдельно попросит подтверждение.',
  ].join('\n');
}

function pendingConfirmationLimitMessage(): string {
  return 'Слишком много ожидающих подтверждений для этого чата. Заверши или отмени старые кнопки и повтори.';
}

function telegramStatusMessage(status: Record<string, unknown>, pending: number): string {
  const mode = String(status.remoteMode || status.pollingMode || 'stopped');
  if (status.remotePaused) {
    return `Monarch на связи, но Telegram-задачи приостановлены локальным защитным режимом. Режим: ${mode}. Ожидающих подтверждений: ${pending}.`;
  }
  if (status.running) {
    return `Monarch на связи. Telegram runtime активен. Режим: ${mode}. Ожидающих подтверждений: ${pending}.`;
  }
  return 'Telegram-бот настроен, но polling сейчас не активен в этом runtime.';
}

function telegramCapabilityHelp(status: Record<string, unknown>, pending: number): string {
  return [
    'Через Telegram я могу:',
    '• отвечать через локальный Oscar, когда backend и модель доступны;',
    '• запускать реальные Monarch capabilities: файлы workspace, память, поиск, модели, диагностика и безопасность;',
    '• ставить напоминания, создавать опросы, отправлять таблицы и вызывать совместимые Bot API методы;',
    '• работать с plugin-направлениями Codex Security, Creative Production, GitHub и Hugging Face, если они подключены в текущей среде;',
    '',
    `Режим сейчас: ${status.remotePaused ? 'защитный lockdown' : status.running ? 'agent' : 'stopped'}. Подтверждений ждёт: ${pending}.`,
    'Опасные действия не выполняются молча: write/network/execute/delete проходят через одноразовое подтверждение.',
  ].join('\n');
}

function telegramSecurityHelp(status: Record<string, unknown>, pending: number): string {
  return [
    'Безопасность Telegram-бота:',
    `• режим: ${status.remotePaused ? 'lockdown, новые задачи остановлены' : 'agent, задачи разрешены после привязки'};`,
    '• доступ только для привязанных chat_id/user_id;',
    '• новые привязки по короткому локальному коду;',
    '• опасные действия требуют inline-подтверждения;',
    '• /lockdown сразу останавливает новые задачи и старые pending-кнопки;',
    `• ожидающих подтверждений: ${pending}.`,
  ].join('\n');
}

function telegramPluginHelp(): string {
  return [
    'Plugin-направления для Telegram:',
    '• Codex Security: проверки, guardrails и безопасные решения для рискованных действий.',
    '• Creative Production: briefs, сцены, визуальные идеи и production-задачи через агентный workflow.',
    '• GitHub: репозитории, issues, PR и CI-контекст, когда GitHub connector доступен.',
    '• Hugging Face: модели, datasets, Spaces и ML-задачи, когда Hugging Face connector доступен.',
    '',
    'Telegram не выдаёт этим интеграциям лишние права: всё идёт через Monarch router, permission gate и audit.',
  ].join('\n');
}

function formatTelegramCapabilities(capabilities: Array<Record<string, unknown>>): string {
  const rows = capabilities.slice(0, 18).map((capability) => {
    const id = String(capability.id || capability.title || 'capability');
    const risk = String(capability.risk || 'read');
    return `• ${id} · ${formatRisk(risk)}`;
  });
  const tail = capabilities.length > rows.length ? `\n…и ещё ${capabilities.length - rows.length}.` : '';
  return `Доступные capabilities Monarch:\n${rows.join('\n')}${tail}`;
}

function formatTelegramModules(modules: Array<Record<string, unknown>>): string {
  const rows = modules.slice(0, 14).map((module) => {
    const capabilities = Array.isArray(module.capabilities) ? module.capabilities.length : Number(module.capabilities || 0);
    return `• ${String(module.id || module.moduleId || module.name || 'module')} · ${capabilities} capabilities · ${String(module.status || 'unknown')}`;
  });
  const tail = modules.length > rows.length ? `\n…и ещё ${modules.length - rows.length}.` : '';
  return `Активные extension surfaces:\n${rows.join('\n')}${tail}`;
}

function formatRisk(value: string): string {
  return value === 'read' ? 'чтение'
    : value === 'write' ? 'запись'
      : value === 'network' ? 'сеть'
        : value === 'execute' ? 'execute'
          : value === 'delete' ? 'delete'
            : value;
}

function isTelegramStatusQuestion(value: string): boolean {
  const text = value.toLowerCase();
  return /(статус|состояни|работа|связь|status|health).*(бот|telegram|телеграм|тг|monarch|runtime|рантайм)/i.test(text)
    || /^(статус|status)$/i.test(text.trim());
}

function mentionsTelegramSurface(value: string): boolean {
  return /\b(?:telegram|tg)\b/i.test(value)
    || /телеграм(?:-бот)?/i.test(value)
    || /(?:^|[\s.,!?;:])тг(?:[\s.,!?;:]|$)/i.test(value)
    || /(?:^|[\s.,!?;:])бот(?:а|ом|у|е)?(?:[\s.,!?;:]|$)/i.test(value);
}

function isTelegramCapabilityQuestion(value: string): boolean {
  const text = value.toLowerCase();
  return /(что|чем|какие|какой|как).{0,80}(умеешь|можешь|возможност|команд|инструмент|capabilit|tool|action)/i.test(text)
    || /(умеешь|можешь).{0,80}(через|внутри|из).{0,40}(telegram|телеграм|тг|бот)/i.test(text)
    || /(available actions|what can you do|commands|capabilities)/i.test(text);
}

function isTelegramPluginQuestion(value: string): boolean {
  const text = value.toLowerCase();
  return /(плагин|плагины|plugin|plugins|интеграц).{0,120}(telegram|телеграм|тг|бот|github|hugging|creative|security|codex)/i.test(text)
    || /(codex-security|creative production|github|hugging face|huggingface).{0,120}(telegram|телеграм|тг|бот|интеграц|плагин)/i.test(text);
}

function isTelegramSecurityQuestion(value: string): boolean {
  const text = value.toLowerCase();
  return /(безопас|security|защит|lockdown|подтвержден).{0,120}(telegram|телеграм|тг|бот|режим)/i.test(text)
    || /(режим|mode).{0,80}(telegram|телеграм|тг|бот)/i.test(text);
}

function telegramPairingHelp(): string {
  return [
    'Этот чат пока не связан с Monarch.',
    '',
    '1. Открой Monarch Control → Telegram.',
    '2. Нажми «Создать новый код».',
    '3. Пришли сюда шесть цифр одним сообщением.',
    '',
    'Команду /pair вводить больше не обязательно.',
  ].join('\n');
}

function telegramBotCommands(): Array<{ command: string; description: string }> {
  return [
    { command: 'start', description: 'Открыть Monarch Telegram' },
    { command: 'help', description: 'Показать возможности и форматы команд' },
    { command: 'status', description: 'Проверить связь с локальным Monarch' },
    { command: 'security', description: 'Показать краткий статус защиты' },
    { command: 'skills', description: 'Показать подходящие локальные навыки' },
    { command: 'plugins', description: 'Показать plugin-направления' },
    { command: 'pending', description: 'Показать ожидающие подтверждения' },
    { command: 'whoami', description: 'Показать текущую привязку' },
    { command: 'task', description: 'Поставить обычную задачу Monarch' },
    { command: 'remind', description: 'Создать локальное напоминание' },
    { command: 'reminders', description: 'Показать активные напоминания' },
    { command: 'cancel', description: 'Отменить напоминание по ID' },
    { command: 'poll', description: 'Создать нативный опрос' },
    { command: 'table', description: 'Отправить таблицу' },
    { command: 'api', description: 'Вызвать совместимый Bot API метод' },
    { command: 'unlink', description: 'Удалить привязку этого чата' },
    { command: 'lockdown', description: 'Остановить удалённые задачи' },
    { command: 'pair', description: 'Привязать этот чат по временному коду' },
  ];
}

function telegramApiMethodDefaultsToChatId(method: string): boolean {
  return /^(?:send|copyMessages?|forwardMessages?|editMessage|deleteMessages?|deleteChat(?:Photo|StickerSet)|pinChatMessage|unpinChatMessage|unpinAllChatMessages|banChat|unbanChat|restrictChatMember|promoteChatMember|setChat|setMessageReaction|stopPoll|leaveChat|approveChatJoinRequest|declineChatJoinRequest|exportChatInviteLink|createChatInviteLink|editChatInviteLink|revokeChatInviteLink|createForumTopic|editForumTopic|closeForumTopic|reopenForumTopic|deleteForumTopic|unpinAllForumTopicMessages|editGeneralForumTopic|closeGeneralForumTopic|reopenGeneralForumTopic|hideGeneralForumTopic|unhideGeneralForumTopic|getChat(?:Administrators|Member(?:Count)?|Boosts)?|getUserChatBoosts)/i.test(method.trim());
}

function telegramIntentContext(chatId: number, userId: number): Record<string, unknown> {
  return {
    telegramChatId: chatId,
    telegramUserId: userId,
    clientConversationId: `telegram:${chatId}`,
    clientSessionId: `telegram:${chatId}:${userId}`,
  };
}

function formatReminders(reminders: TelegramReminder[]): string {
  if (!reminders.length) return 'Активных напоминаний нет.';
  return reminders.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .map((item) => `• ${item.id} · ${formatDate(item.dueAt)} · ${item.text}`)
    .join('\n');
}

type PollOptionPayload = { text: string };
type PollPayloadResult = { ok: true; question: string; options: PollOptionPayload[] } | { ok: false; summary: string };

function parsePollCommand(value: string): { ok: true; question: string; options: PollOptionPayload[] } | { ok: false; message: string } {
  const parts = value.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 1 + MIN_POLL_OPTIONS) {
    return { ok: false, message: 'Формат: /poll Вопрос | Вариант 1' };
  }
  const parsed = parsePollPayload(parts[0] || '', parts.slice(1));
  if (!parsed.ok) {
    return { ok: false, message: pollCommandErrorMessage(parsed.summary) };
  }
  return parsed;
}

function parsePollPayload(question: string, options: string[]): PollPayloadResult {
  const normalizedQuestion = question.trim();
  const normalizedOptions = options.map((option) => option.trim()).filter(Boolean);
  if (!normalizedQuestion || normalizedOptions.length < MIN_POLL_OPTIONS) {
    return { ok: false, summary: 'A poll question and at least one option are required.' };
  }
  if (normalizedQuestion.length > MAX_POLL_QUESTION_CHARS) {
    return { ok: false, summary: `Poll question is too long; maximum ${MAX_POLL_QUESTION_CHARS} characters.` };
  }
  if (normalizedOptions.length > MAX_POLL_OPTIONS) {
    return { ok: false, summary: `Poll has too many options; maximum ${MAX_POLL_OPTIONS}.` };
  }
  if (normalizedOptions.some((option) => option.length > MAX_POLL_OPTION_CHARS)) {
    return { ok: false, summary: `Poll option is too long; maximum ${MAX_POLL_OPTION_CHARS} characters.` };
  }
  return { ok: true, question: normalizedQuestion, options: normalizedOptions.map((text) => ({ text })) };
}

function pollCommandErrorMessage(summary: string): string {
  if (summary.includes(`maximum ${MAX_POLL_QUESTION_CHARS}`)) {
    return `Вопрос опроса слишком длинный: максимум ${MAX_POLL_QUESTION_CHARS} символов.`;
  }
  if (summary.includes(`maximum ${MAX_POLL_OPTIONS}`)) {
    return `Опрос слишком большой: максимум ${MAX_POLL_OPTIONS} вариантов.`;
  }
  if (summary.includes(`maximum ${MAX_POLL_OPTION_CHARS}`)) {
    return `Вариант опроса слишком длинный: максимум ${MAX_POLL_OPTION_CHARS} символов.`;
  }
  return 'Формат: /poll Вопрос | Вариант 1';
}

function parseTableCommand(value: string): { ok: true; markdown: string } | { ok: false; message: string } {
  const parts = value.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) {
    return { ok: false, message: 'Формат: /table Заголовок | Колонка 1, Колонка 2 | Значение 1, Значение 2' };
  }
  const rowInputs = parts.slice(1);
  if (rowInputs.length > MAX_TABLE_ROWS) {
    return { ok: false, message: `Таблица слишком длинная: максимум ${MAX_TABLE_ROWS - 1} строк данных.` };
  }
  const rows = rowInputs.map((row) => row.split(',').map((cell) => escapeMarkdownCell(cell.trim().slice(0, MAX_TABLE_CELL_CHARS))));
  const width = Math.max(...rows.map((row) => row.length));
  if (width > MAX_TABLE_COLUMNS) {
    return { ok: false, message: `Таблица слишком широкая: максимум ${MAX_TABLE_COLUMNS} колонок.` };
  }
  const header = rows[0]!;
  const markdown = [
    `## ${escapeMarkdownCell(parts[0]!.slice(0, MAX_TABLE_TITLE_CHARS))}`,
    `| ${padRow(header, width).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${padRow(row, width).join(' | ')} |`),
  ].join('\n');
  if (markdown.length > MAX_TABLE_MARKDOWN_CHARS) {
    return { ok: false, message: `Таблица слишком большая: максимум ${MAX_TABLE_MARKDOWN_CHARS} символов.` };
  }
  return { ok: true, markdown };
}

function isSameReminder(left: TelegramReminder, right: TelegramReminder): boolean {
  return left.id === right.id
    && left.chatId === right.chatId
    && left.dueAt === right.dueAt
    && left.createdAt === right.createdAt;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function splitMessage(value: string): string[] {
  const parts: string[] = [];
  let rest = value.trim();
  while (rest.length > MAX_MESSAGE_CHARS) {
    let at = rest.lastIndexOf('\n', MAX_MESSAGE_CHARS);
    if (at < MAX_MESSAGE_CHARS / 2) at = rest.lastIndexOf(' ', MAX_MESSAGE_CHARS);
    if (at < MAX_MESSAGE_CHARS / 2) at = MAX_MESSAGE_CHARS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : ['Готово.'];
}

function padRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] || '');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function readString(input: unknown, key: string): string {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(input: unknown, key: string): number | undefined {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function readBoolean(input: unknown, key: string): boolean {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return value === true;
}

function readStringArray(input: unknown, key: string): string[] {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function sanitizeTelegramResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function safeJson(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value, null, 2) || '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function redactApiBase(value: string): string {
  return value.replace(/\/bot[^/]+/i, '/bot***');
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***') : String(error);
}

async function readSecret(filePath: string): Promise<string> {
  try {
    return (await readFile(filePath, 'utf8')).trim().replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimOldestMapEntries<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export function createTelegramModule(): MonarchModule {
  return new TelegramModule();
}

export const telegramModulePackage: MonarchModulePackage = {
  id: telegramManifest.id,
  moduleId: telegramManifest.id,
  version: telegramManifest.version,
  description: telegramManifest.description,
  core: { minVersion: '0.1.0' },
  factory: createTelegramModule,
};
